//! Streaming markdown (DESIGN.md §1 and §3).
//!
//! # Two independent requirements
//!
//! 1. **Line-boundary publish.** Render once per *completed line*, never per
//!    token. A 40-token sentence costs one render, not forty.
//! 2. **Monotone stable prefix.** A row committed to scrollback can never be
//!    taken back, so a block may only be declared stable when *no future input
//!    can change its rendering*.
//!
//! Requirement 2 is the hard one, and it is not obvious how much it forbids.
//! The canonical trap:
//!
//! ```text
//!     | name | kind |          ← looks like an ordinary paragraph…
//!     |------|------|          ← …until this line arrives, and it is a table
//! ```
//!
//! and the column widths of that table depend on *every* row that follows it.
//! So a line containing `|` is never stable until the next line proves it is
//! not a table header, and a table is never stable until it is closed.
//!
//! # What is stable when
//!
//! | construct | stable when |
//! |---|---|
//! | blank, ATX heading, rule, quote, list item | the line is complete |
//! | paragraph line without `\|` | the line is complete |
//! | paragraph line with `\|` | the *next* line is complete and is not a delimiter row |
//! | fenced code line | the line is complete — fences never retro-edit |
//! | table | a non-table line closes it, or the stream ends |
//!
//! Fenced code deserves the note: its content is literal by definition and
//! [`super::syntax`] carries state forwards only, so a code line can be
//! committed the moment it is complete. Holding a 400-line code block back
//! until its closing fence would defeat streaming entirely.
//!
//! # Two deliberate deviations from CommonMark
//!
//! Both exist to *delete* a retroactivity class rather than to simplify:
//!
//! - **No setext headings.** `text` followed by `===` is an h1 in CommonMark,
//!   which would make every paragraph line unstable until the following line
//!   arrives — and, for multi-line paragraphs, retro-restyle rows already
//!   committed. Here `===` is literal text and `---` is always a rule, which is
//!   what an author writing into a terminal meant anyway.
//! - **No link reference definitions.** `[a]: /url` at the bottom of a document
//!   would retro-link `[a]` at the top. Reference links render literally.
//!
//! Soft line breaks are also preserved rather than reflowed: a source line is a
//! rendered line (then wrapped). Model output is written that way regardless,
//! and it is what makes the per-line stability rule above tractable.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::engine::commit::{BlockCommitPolicy, CommitPolicy};
use crate::theme::Theme;
use crate::ui::syntax::{self, Language, ScanState};
use crate::ui::{Row, Span, Style};
use crate::vendor::flywheel::Modifiers;

/// Bullet glyphs by nesting depth. Pure Unicode, no PUA (DESIGN.md §3).
const BULLETS: [&str; 3] = ["•", "◦", "▪"];
/// The blockquote rail.
const QUOTE_RAIL: &str = "▎";
/// Unchecked / checked task-list boxes.
const TASK_BOXES: (&str, &str) = ("☐", "☑");
/// Indent applied to fenced and indented code.
const CODE_INDENT: &str = "  ";
/// Narrowest a table column may be squeezed before the table degrades to
/// key-value rows.
const MIN_COLUMN: usize = 5;

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/// Lexer state that survives the stable boundary.
///
/// Everything here flows *forwards*: knowing it at the boundary is enough to
/// resume rendering without re-lexing a single committed byte.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Carry {
    /// Open fence: `(marker char, marker length, language)`.
    fence: Option<(char, usize, Option<Language>)>,
    /// Syntax scanner state inside that fence.
    scan: ScanState,
    /// The previous source line was blank, or nothing has been rendered yet.
    /// Collapses runs of blank lines and suppresses leading ones.
    after_blank: bool,
}

impl Carry {
    fn start() -> Self {
        Self {
            fence: None,
            scan: ScanState::default(),
            after_blank: true,
        }
    }
}

/// A markdown block stream that emits provably-stable rows exactly once.
///
/// Feeds [`BlockCommitPolicy`], which is what the compositor is generic over —
/// the seam declared in build phase 2 with nothing behind it until now.
#[derive(Debug)]
pub struct MarkdownStream {
    theme: Theme,
    width: u16,
    /// Source *after* the stable boundary. Committed bytes are dropped, so a
    /// long turn costs the unstable tail, not the transcript.
    pending: String,
    carry: Carry,
    policy: BlockCommitPolicy,
    finished: bool,
    committed_rows: usize,
}

impl MarkdownStream {
    /// A stream rendering at `width` columns with `theme`.
    #[must_use]
    pub fn new(theme: Theme, width: u16) -> Self {
        Self {
            theme,
            width: width.max(1),
            pending: String::new(),
            carry: Carry::start(),
            policy: BlockCommitPolicy::default(),
            finished: false,
            committed_rows: 0,
        }
    }

    /// Total rows committed so far.
    #[must_use]
    pub const fn committed_rows(&self) -> usize {
        self.committed_rows
    }

    /// The commit policy, for inspection and for the compositor's generic seam.
    #[must_use]
    pub const fn policy(&self) -> &BlockCommitPolicy {
        &self.policy
    }

    /// Whether anything is buffered.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Re-wrap at a new width.
    ///
    /// Only the unstable tail moves; committed rows keep the wrapping they were
    /// printed with, which is exactly what
    /// [`crate::engine::ResizeMode::Conservative`] accepts and what
    /// [`crate::engine::ResizeMode::Purge`] re-renders away.
    pub fn set_width(&mut self, width: u16) {
        self.width = width.max(1);
    }

    /// Swap the theme. Affects the unstable tail and everything after it.
    pub fn set_theme(&mut self, theme: Theme) {
        self.theme = theme;
    }

    /// Append streamed markdown and return the rows that just became stable.
    ///
    /// **Line-boundary publish**: a delta with no `\n` in it cannot close a
    /// line, so it cannot make anything stable and does no rendering work at
    /// all. This is the difference between one render per line and one per
    /// token.
    pub fn push(&mut self, text: &str) -> Vec<Row> {
        self.pending.push_str(text);
        if !text.contains('\n') {
            return Vec::new();
        }
        self.harvest(false)
    }

    /// End the stream; everything remaining becomes stable.
    pub fn finish(&mut self) -> Vec<Row> {
        self.finished = true;
        self.harvest(true)
    }

    /// The rows the live region must display: the unstable tail, rendered as it
    /// currently reads. These are *provisional* and may change with the next
    /// delta — which is exactly why they have not been committed.
    #[must_use]
    pub fn live_rows(&self) -> Vec<Row> {
        // `pending` holds only uncommitted source, so *every* row it renders is
        // a live row. Rendering it as if finished is what makes an unclosed
        // table or fence visible while it is still arriving.
        render_region(
            &self.pending,
            self.carry.clone(),
            true,
            &self.theme,
            self.width,
        )
        .rows
    }

    fn harvest(&mut self, finished: bool) -> Vec<Row> {
        let render = render_region(
            &self.pending,
            self.carry.clone(),
            finished,
            &self.theme,
            self.width,
        );
        // The policy is the authority, not `render.stable_rows`: it clamps to
        // the rows that exist and is monotone by construction, so a renderer
        // bug can only ever commit *less*, never un-commit.
        self.policy.close(render.stable_rows);
        let texts: Vec<String> = render.rows.iter().map(Row::plain_text).collect();
        let stable = self.policy.stable_rows(&texts, finished);
        if stable == 0 {
            return Vec::new();
        }
        let remainder = self.pending.split_off(render.stable_bytes);
        self.pending = remainder;
        self.carry = render.boundary;
        self.policy.take(stable);
        self.committed_rows += stable;
        render.rows.into_iter().take(stable).collect()
    }
}

/// Render a complete document in one shot.
///
/// The reference implementation the streaming path is tested against: for every
/// document and every split point, streaming must produce exactly these rows.
#[must_use]
pub fn render_document(source: &str, theme: &Theme, width: u16) -> Vec<Row> {
    render_region(source, Carry::start(), true, theme, width.max(1)).rows
}

/// The outcome of rendering a region of source.
struct Render {
    /// Every row the region produces, stable prefix first.
    rows: Vec<Row>,
    /// How many leading rows can never change again.
    stable_rows: usize,
    /// Byte offset in the region just past the last stable line.
    stable_bytes: usize,
    /// Lexer state at that offset.
    boundary: Carry,
}

/// A complete source line: its text and the offset just past its newline.
struct SourceLine<'a> {
    text: &'a str,
    end: usize,
}

fn complete_lines(source: &str, finished: bool) -> Vec<SourceLine<'_>> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    while let Some(at) = source[start..].find('\n') {
        let end = start + at + 1;
        lines.push(SourceLine {
            text: &source[start..start + at],
            end,
        });
        start = end;
    }
    if finished && start < source.len() {
        lines.push(SourceLine {
            text: &source[start..],
            end: source.len(),
        });
    }
    lines
}

#[allow(clippy::too_many_lines)]
fn render_region(
    source: &str,
    carry: Carry,
    finished: bool,
    theme: &Theme,
    width: u16,
) -> Render {
    let lines = complete_lines(source, finished);
    let mut rows: Vec<Row> = Vec::new();
    let mut state = carry;
    let mut stable_rows = 0usize;
    let mut stable_bytes = 0usize;
    let mut boundary = state.clone();
    let renderer = Renderer { theme, width };

    let mut index = 0usize;
    while index < lines.len() {
        let line = &lines[index];

        // -- inside a fenced code block ------------------------------------
        if let Some((marker, length, language)) = state.fence {
            if is_closing_fence(line.text, marker, length) {
                state.fence = None;
                state.scan = ScanState::default();
                state.after_blank = false;
            } else {
                let (spans, scan) =
                    syntax::highlight_line(line.text, language.as_ref(), state.scan, theme);
                state.scan = scan;
                rows.extend(renderer.wrap(spans, CODE_INDENT, CODE_INDENT));
                state.after_blank = false;
            }
            index += 1;
            stable_rows = rows.len();
            stable_bytes = line.end;
            boundary = state.clone();
            continue;
        }

        let kind = classify(line.text, state.after_blank);

        // -- a table needs the delimiter row and then the whole table -------
        if matches!(kind, LineKind::Paragraph { .. }) && line.text.contains('|') {
            let next = match lines.get(index + 1) {
                // The next line decides whether this is a paragraph or a table
                // header. Until it arrives nothing here is stable — unless the
                // stream has ended, in which case there is no next line ever
                // and the answer is settled: it is a paragraph.
                None if !finished => break,
                None => None,
                Some(next) => Some(next),
            };
            if next.is_some_and(|next| is_delimiter_row(next.text)) {
                let next = next.expect("checked above");
                let mut end = index + 2;
                while end < lines.len() && is_table_row(lines[end].text) {
                    end += 1;
                }
                let closed = end < lines.len() || finished;
                if !closed {
                    // Column widths depend on rows that have not arrived.
                    break;
                }
                let body: Vec<&str> = lines[index + 2..end].iter().map(|l| l.text).collect();
                rows.extend(renderer.table(line.text, next.text, &body));
                state.after_blank = false;
                index = end;
                stable_rows = rows.len();
                stable_bytes = lines[end - 1].end;
                boundary = state.clone();
                continue;
            }
        }

        match kind {
            LineKind::Blank => {
                if !state.after_blank {
                    rows.push(Row::blank());
                }
                state.after_blank = true;
            }
            LineKind::FenceOpen { marker, length, info } => {
                state.fence = Some((marker, length, Language::from_info(info)));
                state.scan = ScanState::default();
                state.after_blank = false;
            }
            LineKind::Rule => {
                rows.push(renderer.rule());
                state.after_blank = false;
            }
            LineKind::Heading { level, text } => {
                rows.extend(renderer.heading(level, text));
                state.after_blank = false;
            }
            LineKind::Quote { text } => {
                rows.extend(renderer.quote(text));
                state.after_blank = false;
            }
            LineKind::ListItem {
                depth,
                marker,
                text,
            } => {
                rows.extend(renderer.list_item(depth, &marker, text));
                state.after_blank = false;
            }
            LineKind::IndentedCode { text } => {
                rows.extend(renderer.indented_code(text));
                state.after_blank = false;
            }
            LineKind::Paragraph { text } => {
                rows.extend(renderer.paragraph(text));
                state.after_blank = false;
            }
        }

        index += 1;
        stable_rows = rows.len();
        stable_bytes = line.end;
        boundary = state.clone();
    }

    // Anything after the boundary is rendered provisionally so the live region
    // has something to show; it is deliberately *not* counted as stable. The
    // recursion terminates because it re-renders with `finished = true`, under
    // which every construct resolves and the whole tail is consumed.
    if !finished && stable_bytes < source.len() {
        let tail = &source[stable_bytes..];
        if !tail.is_empty() {
            let provisional = render_region(tail, state, true, theme, width);
            rows.truncate(stable_rows);
            rows.extend(provisional.rows);
        }
    }

    Render {
        rows,
        stable_rows,
        stable_bytes,
        boundary,
    }
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

enum LineKind<'a> {
    Blank,
    FenceOpen {
        marker: char,
        length: usize,
        info: &'a str,
    },
    Rule,
    Heading {
        level: u8,
        text: &'a str,
    },
    Quote {
        text: &'a str,
    },
    ListItem {
        depth: usize,
        marker: String,
        text: &'a str,
    },
    IndentedCode {
        text: &'a str,
    },
    Paragraph {
        text: &'a str,
    },
}

fn classify(line: &str, after_blank: bool) -> LineKind<'_> {
    if line.trim().is_empty() {
        return LineKind::Blank;
    }
    let indent = line.len() - line.trim_start().len();
    let body = line.trim_start();

    if let Some((marker, length, info)) = fence_open(body) {
        return LineKind::FenceOpen {
            marker,
            length,
            info,
        };
    }
    if is_rule(body) {
        return LineKind::Rule;
    }
    if let Some((level, text)) = atx_heading(body) {
        return LineKind::Heading { level, text };
    }
    if let Some(text) = body.strip_prefix('>') {
        return LineKind::Quote {
            text: text.strip_prefix(' ').unwrap_or(text),
        };
    }
    if let Some((marker, text)) = list_marker(body) {
        return LineKind::ListItem {
            depth: (indent / 2).min(BULLETS.len() - 1),
            marker,
            text,
        };
    }
    // An indented code block can only *start* after a blank line: otherwise the
    // indented line is a lazy paragraph continuation. That is decided by the
    // preceding line, so it is forward-flowing and safe to commit.
    if after_blank && indent >= 4 {
        return LineKind::IndentedCode { text: &line[4..] };
    }
    LineKind::Paragraph { text: body }
}

fn fence_open(body: &str) -> Option<(char, usize, &str)> {
    let marker = body.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let length = body.chars().take_while(|ch| *ch == marker).count();
    if length < 3 {
        return None;
    }
    let info = body[length..].trim();
    // A backtick fence's info string may not contain a backtick.
    if marker == '`' && info.contains('`') {
        return None;
    }
    Some((marker, length, info))
}

fn is_closing_fence(line: &str, marker: char, length: usize) -> bool {
    let body = line.trim();
    body.chars().all(|ch| ch == marker) && body.chars().count() >= length && !body.is_empty()
}

fn is_rule(body: &str) -> bool {
    let stripped: String = body.chars().filter(|ch| !ch.is_whitespace()).collect();
    if stripped.len() < 3 {
        return false;
    }
    ['-', '*', '_']
        .iter()
        .any(|marker| stripped.chars().all(|ch| ch == *marker))
}

fn atx_heading(body: &str) -> Option<(u8, &str)> {
    let level = body.chars().take_while(|ch| *ch == '#').count();
    if level == 0 || level > 6 {
        return None;
    }
    let rest = &body[level..];
    if !rest.is_empty() && !rest.starts_with(' ') {
        return None;
    }
    let text = rest.trim_start().trim_end_matches(['#', ' ']);
    Some((u8::try_from(level).unwrap_or(6), text))
}

fn list_marker(body: &str) -> Option<(String, &str)> {
    if let Some(rest) = body
        .strip_prefix("- ")
        .or_else(|| body.strip_prefix("* "))
        .or_else(|| body.strip_prefix("+ "))
    {
        return Some((String::new(), rest));
    }
    let digits = body.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 9 {
        return None;
    }
    let rest = &body[digits..];
    let rest = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))?;
    Some((format!("{}.", &body[..digits]), rest))
}

/// GFM delimiter row: `|---|:--:|`, at least one cell, only `-` and `:`.
#[must_use]
pub fn is_delimiter_row(line: &str) -> bool {
    let body = line.trim();
    if !body.contains('-') {
        return false;
    }
    let body = body.strip_prefix('|').unwrap_or(body);
    let body = body.strip_suffix('|').unwrap_or(body);
    let cells: Vec<&str> = body.split('|').collect();
    if cells.is_empty() {
        return false;
    }
    cells.iter().all(|cell| {
        let cell = cell.trim();
        !cell.is_empty()
            && cell.contains('-')
            && cell
                .chars()
                .all(|ch| ch == '-' || ch == ':')
    })
}

fn is_table_row(line: &str) -> bool {
    !line.trim().is_empty() && line.contains('|')
}

fn split_cells(line: &str) -> Vec<String> {
    let body = line.trim();
    let body = body.strip_prefix('|').unwrap_or(body);
    let body = body.strip_suffix('|').unwrap_or(body);
    body.split('|').map(|cell| cell.trim().to_owned()).collect()
}

/// Column alignment from a delimiter cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Align {
    Left,
    Center,
    Right,
}

fn alignments(delimiter: &str) -> Vec<Align> {
    split_cells(delimiter)
        .into_iter()
        .map(|cell| {
            let left = cell.starts_with(':');
            let right = cell.ends_with(':');
            match (left, right) {
                (true, true) => Align::Center,
                (false, true) => Align::Right,
                _ => Align::Left,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

struct Renderer<'a> {
    theme: &'a Theme,
    width: u16,
}

impl Renderer<'_> {
    fn usable(&self) -> usize {
        usize::from(self.width).max(1)
    }

    fn rule(&self) -> Row {
        let width = self.usable().min(60);
        Row::styled("─".repeat(width), self.theme.faint())
    }

    fn heading(&self, level: u8, text: &str) -> Vec<Row> {
        // h1 strong, h2/h3 modest, h4+ merely bold muted (DESIGN.md §3).
        let style = match level {
            1 => self.theme.tokens.heading.style().with(Modifiers::BOLD),
            2 | 3 => self.theme.tokens.subheading.style().with(Modifiers::BOLD),
            _ => self.theme.muted().with(Modifiers::BOLD),
        };
        let spans = inline(text, style, self.theme);
        self.wrap(spans, "", "")
    }

    fn quote(&self, text: &str) -> Vec<Row> {
        let rail = Span::new(format!("{QUOTE_RAIL} "), self.theme.faint());
        let style = self.theme.tokens.quote.style().with(Modifiers::DIM);
        let spans = inline(text, style, self.theme);
        let prefix = [rail];
        self.wrap_with(spans, &prefix, &prefix)
    }

    fn list_item(&self, depth: usize, marker: &str, text: &str) -> Vec<Row> {
        let indent = "  ".repeat(depth);
        let bullet = if marker.is_empty() {
            BULLETS[depth.min(BULLETS.len() - 1)].to_owned()
        } else {
            marker.to_owned()
        };
        let (box_glyph, text) = task_box(text);
        let mut lead = vec![
            Span::new(indent.clone(), self.theme.text()),
            Span::new(format!("{bullet} "), self.theme.tokens.accent.style()),
        ];
        if let Some(glyph) = box_glyph {
            lead.push(Span::new(format!("{glyph} "), self.theme.muted()));
        }
        let continuation = [Span::new(
            " ".repeat(lead.iter().map(|span| span.text.width()).sum()),
            self.theme.text(),
        )];
        let spans = inline(text, self.theme.text(), self.theme);
        self.wrap_with(spans, &lead, &continuation)
    }

    fn indented_code(&self, text: &str) -> Vec<Row> {
        self.wrap(
            vec![Span::new(text.to_owned(), self.theme.muted())],
            CODE_INDENT,
            CODE_INDENT,
        )
    }

    fn paragraph(&self, text: &str) -> Vec<Row> {
        let spans = inline(text, self.theme.text(), self.theme);
        self.wrap(spans, "", "")
    }

    fn wrap(&self, spans: Vec<Span>, first: &str, cont: &str) -> Vec<Row> {
        let first = [Span::new(first.to_owned(), self.theme.text())];
        let cont = [Span::new(cont.to_owned(), self.theme.text())];
        self.wrap_with(spans, &first, &cont)
    }

    fn wrap_with(&self, spans: Vec<Span>, first: &[Span], cont: &[Span]) -> Vec<Row> {
        wrap_spans(spans, self.usable(), first, cont)
    }

    /// Render a GFM table, degrading to key-value rows when it cannot fit.
    fn table(&self, header: &str, delimiter: &str, body: &[&str]) -> Vec<Row> {
        let aligns = alignments(delimiter);
        let columns = aligns.len().max(1);
        let header_cells = fit(split_cells(header), columns);
        let rows: Vec<Vec<String>> = body
            .iter()
            .map(|line| fit(split_cells(line), columns))
            .collect();

        let natural: Vec<usize> = (0..columns)
            .map(|column| {
                let header_width = header_cells[column].width();
                rows.iter()
                    .map(|row| row[column].width())
                    .chain(std::iter::once(header_width))
                    .max()
                    .unwrap_or(1)
                    .max(1)
            })
            .collect();

        let gaps = 2 * columns.saturating_sub(1);
        let floor = MIN_COLUMN * columns + gaps;
        if floor > self.usable() {
            // DESIGN.md §3: tables degrade to key-value when narrow. Truncating
            // to three columns of two characters would be a lie, not a table.
            return self.key_value(&header_cells, &rows);
        }
        let solved = solve_widths(&natural, self.usable(), gaps);

        let mut out = Vec::new();
        out.push(self.table_row(
            &header_cells,
            &solved,
            &aligns,
            self.theme.tokens.subheading.style().with(Modifiers::BOLD),
        ));
        out.push(Row {
            spans: solved
                .iter()
                .enumerate()
                .flat_map(|(index, width)| {
                    let mut spans = Vec::new();
                    if index > 0 {
                        spans.push(Span::new("  ", self.theme.faint()));
                    }
                    spans.push(Span::new("─".repeat(*width), self.theme.faint()));
                    spans
                })
                .collect(),
        });
        for row in &rows {
            out.push(self.table_row(row, &solved, &aligns, self.theme.text()));
        }
        out
    }

    fn table_row(
        &self,
        cells: &[String],
        widths: &[usize],
        aligns: &[Align],
        style: Style,
    ) -> Row {
        let mut spans = Vec::new();
        for (index, (cell, width)) in cells.iter().zip(widths).enumerate() {
            if index > 0 {
                spans.push(Span::new("  ", self.theme.text()));
            }
            let text = pad(&truncate(cell, *width), *width, aligns[index]);
            spans.push(Span::new(text, style));
        }
        // Padding on the *last* cell would paint a band of styled blanks to the
        // right edge of a committed row. Drop it.
        if let Some(last) = spans.last_mut() {
            let trimmed = last.text.trim_end().len();
            last.text.truncate(trimmed);
        }
        Row { spans }
    }

    fn key_value(&self, header: &[String], rows: &[Vec<String>]) -> Vec<Row> {
        let mut out = Vec::new();
        for (index, row) in rows.iter().enumerate() {
            if index > 0 {
                out.push(Row::blank());
            }
            for (key, value) in header.iter().zip(row) {
                let spans = vec![
                    Span::new(format!("{key}: "), self.theme.muted()),
                    Span::new(value.clone(), self.theme.text()),
                ];
                out.extend(wrap_spans(
                    spans,
                    self.usable(),
                    &[],
                    &[Span::new("  ", self.theme.text())],
                ));
            }
        }
        if out.is_empty() {
            // A header with no body rows still deserves to be visible — and
            // still has to fit, so it goes through the same wrapper.
            for key in header {
                out.extend(wrap_spans(
                    vec![Span::new(key.clone(), self.theme.muted())],
                    self.usable(),
                    &[],
                    &[],
                ));
            }
        }
        out
    }
}

fn fit(mut cells: Vec<String>, columns: usize) -> Vec<String> {
    cells.resize(columns, String::new());
    cells
}

fn task_box(text: &str) -> (Option<&'static str>, &str) {
    if let Some(rest) = text.strip_prefix("[ ] ") {
        return (Some(TASK_BOXES.0), rest);
    }
    for prefix in ["[x] ", "[X] "] {
        if let Some(rest) = text.strip_prefix(prefix) {
            return (Some(TASK_BOXES.1), rest);
        }
    }
    (None, text)
}

/// Shrink the widest columns until the table fits, never below [`MIN_COLUMN`].
fn solve_widths(natural: &[usize], available: usize, gaps: usize) -> Vec<usize> {
    let mut widths = natural.to_vec();
    let budget = available.saturating_sub(gaps);
    loop {
        let total: usize = widths.iter().sum();
        if total <= budget {
            return widths;
        }
        let Some(widest) = widths
            .iter()
            .enumerate()
            .filter(|(_, width)| **width > MIN_COLUMN)
            .max_by_key(|(index, width)| (**width, std::cmp::Reverse(*index)))
            .map(|(index, _)| index)
        else {
            return widths;
        };
        widths[widest] -= 1;
    }
}

fn truncate(text: &str, width: usize) -> String {
    if text.width() <= width {
        return text.to_owned();
    }
    // DESIGN.md §3: "width degradation leaves a visible `…`".
    let mut out = String::new();
    let mut used = 0usize;
    for grapheme in text.graphemes(true) {
        let advance = grapheme.width().max(1);
        if used + advance > width.saturating_sub(1) {
            break;
        }
        out.push_str(grapheme);
        used += advance;
    }
    out.push('…');
    out
}

fn pad(text: &str, width: usize, align: Align) -> String {
    let slack = width.saturating_sub(text.width());
    match align {
        Align::Left => format!("{text}{}", " ".repeat(slack)),
        Align::Right => format!("{}{text}", " ".repeat(slack)),
        Align::Center => {
            let left = slack / 2;
            format!("{}{text}{}", " ".repeat(left), " ".repeat(slack - left))
        }
    }
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

/// Render inline markdown into spans over `base`.
///
/// Emphasis, code spans, strikethrough and links. Everything is line-local:
/// an unclosed `**` renders literally rather than reaching into the next line,
/// which is both what CommonMark says and what makes a line committable.
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn inline(text: &str, base: Style, theme: &Theme) -> Vec<Span> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<Span> = Vec::new();
    let mut literal = String::new();
    let mut index = 0usize;

    let flush = |out: &mut Vec<Span>, literal: &mut String| {
        if !literal.is_empty() {
            out.push(Span::new(std::mem::take(literal), base));
        }
    };

    while index < chars.len() {
        let ch = chars[index];

        // Backslash escapes: the escaped character is literal.
        if ch == '\\' {
            if let Some(next) = chars.get(index + 1).filter(|next| next.is_ascii_punctuation()) {
                literal.push(*next);
                index += 2;
                continue;
            }
            literal.push(ch);
            index += 1;
            continue;
        }

        // Code spans bind tightest and their content is literal.
        if ch == '`' {
            let ticks = chars[index..].iter().take_while(|c| **c == '`').count();
            if let Some(close) = find_run(&chars, index + ticks, '`', ticks) {
                flush(&mut out, &mut literal);
                let body: String = chars[index + ticks..close].iter().collect();
                out.push(Span::new(
                    body.trim_matches(' ').to_owned(),
                    Style {
                        fg: theme.tokens.accent.as_fg(),
                        ..base
                    },
                ));
                index = close + ticks;
                continue;
            }
        }

        // Links: [text](url).
        if ch == '[' && let Some((label, url, end)) = link_at(&chars, index) {
            flush(&mut out, &mut literal);
            out.push(link_span(&label, &url, base, theme));
            index = end;
            continue;
        }

        // Autolinks: <https://example.com>.
        if ch == '<' && let Some(end) = chars[index..].iter().position(|c| *c == '>') {
            let body: String = chars[index + 1..index + end].iter().collect();
            if is_url(&body) {
                flush(&mut out, &mut literal);
                out.push(link_span(&body, &body, base, theme));
                index += end + 1;
                continue;
            }
        }

        // Bare URLs.
        if (ch == 'h' || ch == 'w') && at_word_start(&chars, index) {
            let rest: String = chars[index..].iter().collect();
            if let Some(length) = bare_url_length(&rest) {
                let url: String = chars[index..index + length].iter().collect();
                flush(&mut out, &mut literal);
                let target = if url.starts_with("www.") {
                    format!("https://{url}")
                } else {
                    url.clone()
                };
                out.push(link_span(&url, &target, base, theme));
                index += length;
                continue;
            }
        }

        // Strikethrough.
        if ch == '~'
            && chars.get(index + 1) == Some(&'~')
            && let Some(close) = find_run(&chars, index + 2, '~', 2)
        {
            flush(&mut out, &mut literal);
            let body: String = chars[index + 2..close].iter().collect();
            out.extend(restyle(
                inline(&body, base, theme),
                Modifiers::STRIKETHROUGH,
            ));
            index = close + 2;
            continue;
        }

        // Strong and emphasis.
        if ch == '*' || ch == '_' {
            let run = chars[index..].iter().take_while(|c| **c == ch).count();
            let markers = run.min(3);
            if let Some(close) = find_run(&chars, index + markers, ch, markers) {
                let body: String = chars[index + markers..close].iter().collect();
                if !body.trim().is_empty() {
                    flush(&mut out, &mut literal);
                    let modifier = match markers {
                        3 => Modifiers::BOLD.union(Modifiers::ITALIC),
                        2 => Modifiers::BOLD,
                        _ => Modifiers::ITALIC,
                    };
                    out.extend(restyle(inline(&body, base, theme), modifier));
                    index = close + markers;
                    continue;
                }
            }
        }

        literal.push(ch);
        index += 1;
    }
    flush(&mut out, &mut literal);
    out
}

fn restyle(spans: Vec<Span>, modifiers: Modifiers) -> Vec<Span> {
    spans
        .into_iter()
        .map(|mut span| {
            span.style = span.style.with(modifiers);
            span
        })
        .collect()
}

fn link_span(label: &str, url: &str, base: Style, theme: &Theme) -> Span {
    let style = Style {
        fg: theme.tokens.accent.as_fg(),
        ..base
    }
    .with(Modifiers::UNDERLINE);
    if theme.hyperlinks {
        Span::linked(label.to_owned(), style, url.to_owned())
    } else {
        Span::new(label.to_owned(), style)
    }
}

/// Find a run of `count` copies of `marker` at or after `from`.
fn find_run(chars: &[char], from: usize, marker: char, count: usize) -> Option<usize> {
    let mut index = from;
    while index + count <= chars.len() {
        if chars[index] == marker && chars[index..index + count].iter().all(|c| *c == marker) {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn link_at(chars: &[char], start: usize) -> Option<(String, String, usize)> {
    let mut depth = 0usize;
    let mut close = None;
    for (offset, ch) in chars[start..].iter().enumerate() {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(start + offset);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close?;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let end = chars[close + 2..].iter().position(|ch| *ch == ')')? + close + 2;
    let label: String = chars[start + 1..close].iter().collect();
    let url: String = chars[close + 2..end].iter().collect();
    if label.is_empty() || url.is_empty() {
        return None;
    }
    Some((label, url.split_whitespace().next()?.to_owned(), end + 1))
}

fn at_word_start(chars: &[char], index: usize) -> bool {
    index == 0 || !chars[index - 1].is_alphanumeric()
}

fn is_url(text: &str) -> bool {
    text.starts_with("http://") || text.starts_with("https://")
}

fn bare_url_length(rest: &str) -> Option<usize> {
    if !is_url(rest) && !rest.starts_with("www.") {
        return None;
    }
    let length = rest
        .chars()
        .take_while(|ch| !ch.is_whitespace() && *ch != '<' && *ch != '>')
        .count();
    // Trailing sentence punctuation belongs to the sentence, not the URL.
    let trimmed: String = rest.chars().take(length).collect();
    let trimmed = trimmed.trim_end_matches(['.', ',', ';', ':', ')', '!', '?']);
    let length = trimmed.chars().count();
    if length < 8 {
        return None;
    }
    Some(length)
}

// ---------------------------------------------------------------------------
// Span wrapping
// ---------------------------------------------------------------------------

/// Wrap styled spans to `width`, with separate first-line and continuation
/// prefixes.
///
/// Breaks at whitespace where possible and hard-splits an over-long word at a
/// grapheme boundary, so no row can exceed the width and trigger a terminal
/// wrap the compositor did not predict — which would desynchronise its row
/// accounting and, with it, the scrollback invariant.
#[must_use]
pub fn wrap_spans(spans: Vec<Span>, width: usize, first: &[Span], cont: &[Span]) -> Vec<Row> {
    let width = width.max(1);
    // A prefix that leaves no room for content (a nested bullet in an
    // eight-column terminal) is dropped rather than allowed to push the row
    // past the width. Two columns of headroom, because one grapheme can be two
    // columns wide.
    let fits = |prefix: &[Span]| {
        let indent: usize = prefix.iter().map(|span| span.text.width()).sum();
        indent + 2 <= width
    };
    let first: &[Span] = if fits(first) { first } else { &[] };
    let cont: &[Span] = if fits(cont) { cont } else { &[] };
    let first_indent: usize = first.iter().map(|span| span.text.width()).sum();
    let cont_indent: usize = cont.iter().map(|span| span.text.width()).sum();

    // Flatten to graphemes tagged with their span, so a break can fall
    // anywhere without losing styling or link membership.
    let mut items: Vec<(usize, &str)> = Vec::new();
    for (index, span) in spans.iter().enumerate() {
        for grapheme in span.text.graphemes(true) {
            items.push((index, grapheme));
        }
    }
    if items.is_empty() {
        return vec![Row {
            spans: first.to_vec(),
        }];
    }

    let mut rows: Vec<Row> = Vec::new();
    let mut line: Vec<(usize, &str)> = Vec::new();
    // `used` is the *whole* row width, prefix included, so every comparison is
    // against `width` directly. Tracking it any other way is how off-by-one
    // wrap bugs get in.
    let mut used = first_indent;
    let mut index = 0usize;

    let flush = |line: &mut Vec<(usize, &str)>, rows: &mut Vec<Row>| {
        while line.last().is_some_and(|(_, grapheme)| {
            grapheme.chars().all(char::is_whitespace)
        }) {
            line.pop();
        }
        let prefix = if rows.is_empty() { first } else { cont };
        rows.push(Row {
            spans: prefix
                .iter()
                .cloned()
                .chain(group(line, &spans))
                .filter(|span| !span.text.is_empty())
                .collect(),
        });
        line.clear();
    };

    while index < items.len() {
        // Take the next run: either whitespace or a word.
        let is_space = items[index].1.chars().all(char::is_whitespace);
        let mut end = index;
        while end < items.len() && items[end].1.chars().all(char::is_whitespace) == is_space {
            end += 1;
        }
        let run = &items[index..end];
        let run_width: usize = run.iter().map(|(_, g)| g.width().max(1)).sum();
        index = end;

        if used + run_width <= width {
            line.extend_from_slice(run);
            used += run_width;
            continue;
        }
        if is_space {
            // Whitespace straddling the wrap point is consumed by the row that
            // ends at it, never carried onto the next. Leading whitespace on a
            // fresh row is simply dropped rather than producing a blank row.
            if !line.is_empty() {
                flush(&mut line, &mut rows);
                used = cont_indent;
            }
            continue;
        }
        if !line.is_empty() {
            flush(&mut line, &mut rows);
            used = cont_indent;
        }
        if used + run_width <= width {
            line.extend_from_slice(run);
            used += run_width;
            continue;
        }
        // A single word wider than the terminal: hard-split at grapheme bounds
        // so the row cannot overflow and be wrapped by the terminal instead.
        for item in run {
            let advance = item.1.width().max(1);
            if used + advance > width && !line.is_empty() {
                flush(&mut line, &mut rows);
                used = cont_indent;
            }
            line.push(*item);
            used += advance;
        }
    }
    if !line.is_empty() || rows.is_empty() {
        flush(&mut line, &mut rows);
    }
    // The invariant is absolute: no row may exceed the width, because a row
    // that does is wrapped by the *terminal*, and the compositor's row
    // accounting — and with it the scrollback invariant — desynchronises. The
    // clip above never fires for reasonable widths; it exists so the guarantee
    // does not depend on "reasonable".
    for row in &mut rows {
        clip(row, width);
    }
    rows
}

/// Truncate a row to `width` display columns in place.
fn clip(row: &mut Row, width: usize) {
    if row.width() <= width {
        return;
    }
    let mut used = 0usize;
    let mut kept: Vec<Span> = Vec::new();
    for span in std::mem::take(&mut row.spans) {
        if used >= width {
            break;
        }
        let mut text = String::new();
        for grapheme in span.text.graphemes(true) {
            let advance = grapheme.width().max(1);
            if used + advance > width {
                used = width;
                break;
            }
            text.push_str(grapheme);
            used += advance;
        }
        if !text.is_empty() {
            kept.push(Span { text, ..span });
        }
    }
    row.spans = kept;
}

fn group(items: &[(usize, &str)], spans: &[Span]) -> Vec<Span> {
    let mut out: Vec<Span> = Vec::new();
    for (index, grapheme) in items {
        match out.last_mut() {
            Some(last) if last.style == spans[*index].style && last.link == spans[*index].link => {
                last.text.push_str(grapheme);
            }
            _ => {
                let mut span = spans[*index].clone();
                span.text = (*grapheme).to_owned();
                out.push(span);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests;
