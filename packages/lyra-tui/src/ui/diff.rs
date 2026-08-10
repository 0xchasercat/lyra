//! **The** diff renderer (DESIGN.md §3).
//!
//! > "Diffs: one renderer for every surface (inline edit results, expanded
//! > view, theme preview). Word-level intra-line highlight with a 40% bail-out;
//! > uniformly dimmed line-number gutter."
//!
//! One renderer, not one per surface. An inline edit result, a `Tab`-expanded
//! tool call and a future theme preview differ only in [`DiffOptions`] — the
//! layout, the gutter, the colours and the word-diff are shared code, so they
//! cannot drift apart. Every surface in this crate that shows a change goes
//! through [`render`].
//!
//! # Two decisions worth their comments
//!
//! **The 40% bail-out.** Word-level highlighting is a hint about *what* changed
//! within a line. When most of the line changed, highlighting most of the words
//! communicates nothing and costs legibility — every heavily-edited line
//! becomes a confetti of two colours. Past 40% changed tokens the word-diff is
//! dropped and the line is marked whole. (Measured on the token count of the
//! longer side, so a line that grew from three words to thirty does not read as
//! "10% changed".)
//!
//! **The gutter is uniformly dim.** Not "dim for context, coloured for
//! changes": the line numbers are navigation, not content. Colouring them
//! doubles the coloured mass of a diff for no information, and DESIGN.md §3
//! budgets ~6 tokens for >90% of coloured output.

use unicode_width::UnicodeWidthStr;

use crate::theme::Theme;
use crate::ui::{Row, Span};
use crate::vendor::flywheel::Modifiers;

/// Above this the word-diff is dropped and the whole line is marked.
pub const WORD_DIFF_BAILOUT: f32 = 0.40;
/// Cap on the line-diff dynamic program. Beyond it the diff degrades to
/// "everything replaced" rather than spending seconds on a generated file.
const LCS_CELL_CAP: usize = 2_000_000;

/// What a diff line is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    /// Unchanged.
    Context,
    /// Present only in the new text.
    Added,
    /// Present only in the old text.
    Removed,
}

/// One line of a hunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    /// What it is.
    pub kind: LineKind,
    /// 1-based line number in the old text.
    pub old_no: Option<usize>,
    /// 1-based line number in the new text.
    pub new_no: Option<usize>,
    /// The text, without its `+`/`-`/` ` marker.
    pub text: String,
}

/// A contiguous run of changed lines plus its context.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Hunk {
    /// 1-based start line in the old text.
    pub old_start: usize,
    /// 1-based start line in the new text.
    pub new_start: usize,
    /// Lines, in order.
    pub lines: Vec<DiffLine>,
}

/// A change to one file, ready to render.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileDiff {
    /// Display path.
    pub path: String,
    /// Hunks in file order.
    pub hunks: Vec<Hunk>,
}

impl FileDiff {
    /// Lines added.
    #[must_use]
    pub fn added(&self) -> usize {
        self.count(LineKind::Added)
    }

    /// Lines removed.
    #[must_use]
    pub fn removed(&self) -> usize {
        self.count(LineKind::Removed)
    }

    fn count(&self, kind: LineKind) -> usize {
        self.hunks
            .iter()
            .flat_map(|hunk| &hunk.lines)
            .filter(|line| line.kind == kind)
            .count()
    }

    /// Whether there is anything to show.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.hunks.iter().all(|hunk| hunk.lines.is_empty())
    }

    /// Diff two texts, keeping `context` unchanged lines around each change.
    ///
    /// This is the entry point for an edit tool that reports before/after
    /// content rather than a unified patch — the common case, and the reason
    /// the renderer owns a differ at all.
    #[must_use]
    pub fn between(path: impl Into<String>, old: &str, new: &str, context: usize) -> Self {
        let old_lines: Vec<&str> = split_lines(old);
        let new_lines: Vec<&str> = split_lines(new);
        let script = diff_lines(&old_lines, &new_lines);
        Self {
            path: path.into(),
            hunks: group(&script, context),
        }
    }

    /// Parse a unified diff body (`@@ -a,b +c,d @@` hunks).
    ///
    /// Tolerant: `diff --git`, `---`/`+++` and `\ No newline` lines are
    /// skipped, and content before the first `@@` is ignored. A malformed body
    /// yields an empty diff rather than an error — a tool result is not a
    /// contract, and rendering nothing beats rendering a panic.
    #[must_use]
    pub fn from_unified(path: impl Into<String>, patch: &str) -> Self {
        let mut hunks: Vec<Hunk> = Vec::new();
        let mut old_no = 0usize;
        let mut new_no = 0usize;
        for line in patch.lines() {
            if let Some(header) = line.strip_prefix("@@") {
                let Some((old_start, new_start)) = parse_hunk_header(header) else {
                    continue;
                };
                // `@@ -10,4 @@` means the *first* line of the hunk is 10, so
                // the running counter starts one before it.
                old_no = old_start.saturating_sub(1);
                new_no = new_start.saturating_sub(1);
                hunks.push(Hunk {
                    old_start,
                    new_start,
                    lines: Vec::new(),
                });
                continue;
            }
            let Some(hunk) = hunks.last_mut() else { continue };
            if line.starts_with("\\") {
                continue;
            }
            let (kind, text) = match line.chars().next() {
                Some('+') => (LineKind::Added, &line[1..]),
                Some('-') => (LineKind::Removed, &line[1..]),
                Some(' ') => (LineKind::Context, &line[1..]),
                None => (LineKind::Context, ""),
                Some(_) => continue,
            };
            let (old, new) = match kind {
                LineKind::Added => {
                    new_no += 1;
                    (None, Some(new_no))
                }
                LineKind::Removed => {
                    old_no += 1;
                    (Some(old_no), None)
                }
                LineKind::Context => {
                    old_no += 1;
                    new_no += 1;
                    (Some(old_no), Some(new_no))
                }
            };
            hunk.lines.push(DiffLine {
                kind,
                old_no: old,
                new_no: new,
                text: text.to_owned(),
            });
        }
        Self {
            path: path.into(),
            hunks,
        }
    }
}

fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = text.split('\n').collect();
    if text.ends_with('\n') {
        lines.pop();
    }
    lines
}

fn parse_hunk_header(header: &str) -> Option<(usize, usize)> {
    let body = header.split("@@").next()?;
    let mut old = None;
    let mut new = None;
    for field in body.split_whitespace() {
        let (sign, rest) = field.split_at(1);
        let start: usize = rest.split(',').next()?.parse().ok()?;
        match sign {
            "-" => old = Some(start),
            "+" => new = Some(start),
            _ => {}
        }
    }
    Some((old?, new?))
}

// ---------------------------------------------------------------------------
// Line diff
// ---------------------------------------------------------------------------

/// A diff script over whole lines.
fn diff_lines<'a>(old: &[&'a str], new: &[&'a str]) -> Vec<DiffLine> {
    // Trim the common prefix and suffix first. On a real edit this is almost
    // the entire file, which turns an O(n·m) table into an O(k²) one.
    let mut head = 0usize;
    while head < old.len() && head < new.len() && old[head] == new[head] {
        head += 1;
    }
    let mut tail = 0usize;
    while tail < old.len() - head && tail < new.len() - head
        && old[old.len() - 1 - tail] == new[new.len() - 1 - tail]
    {
        tail += 1;
    }
    let old_core = &old[head..old.len() - tail];
    let new_core = &new[head..new.len() - tail];

    let mut out: Vec<DiffLine> = Vec::with_capacity(old.len().max(new.len()));
    for (offset, text) in old[..head].iter().enumerate() {
        out.push(context(offset + 1, offset + 1, text));
    }
    out.extend(core_diff(old_core, new_core, head));
    for offset in 0..tail {
        let old_no = old.len() - tail + offset + 1;
        let new_no = new.len() - tail + offset + 1;
        out.push(context(old_no, new_no, old[old_no - 1]));
    }
    out
}

fn context(old_no: usize, new_no: usize, text: &str) -> DiffLine {
    DiffLine {
        kind: LineKind::Context,
        old_no: Some(old_no),
        new_no: Some(new_no),
        text: text.to_owned(),
    }
}

fn core_diff(old: &[&str], new: &[&str], offset: usize) -> Vec<DiffLine> {
    if old.is_empty() && new.is_empty() {
        return Vec::new();
    }
    if old.len().saturating_mul(new.len()) > LCS_CELL_CAP {
        // A generated file or a whole-file rewrite. Spending seconds on an
        // exact minimal diff of something nobody will read line by line is the
        // wrong trade; show it as a replacement.
        let mut out = Vec::new();
        for (index, text) in old.iter().enumerate() {
            out.push(DiffLine {
                kind: LineKind::Removed,
                old_no: Some(offset + index + 1),
                new_no: None,
                text: (*text).to_owned(),
            });
        }
        for (index, text) in new.iter().enumerate() {
            out.push(DiffLine {
                kind: LineKind::Added,
                old_no: None,
                new_no: Some(offset + index + 1),
                text: (*text).to_owned(),
            });
        }
        return out;
    }

    // Classic LCS table, walked backwards into a diff script.
    let rows = old.len() + 1;
    let columns = new.len() + 1;
    let mut table = vec![0u32; rows * columns];
    for i in (0..old.len()).rev() {
        for j in (0..new.len()).rev() {
            table[i * columns + j] = if old[i] == new[j] {
                table[(i + 1) * columns + j + 1] + 1
            } else {
                table[(i + 1) * columns + j].max(table[i * columns + j + 1])
            };
        }
    }

    let mut out = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < old.len() && j < new.len() {
        if old[i] == new[j] {
            out.push(context(offset + i + 1, offset + j + 1, old[i]));
            i += 1;
            j += 1;
        } else if table[(i + 1) * columns + j] >= table[i * columns + j + 1] {
            out.push(DiffLine {
                kind: LineKind::Removed,
                old_no: Some(offset + i + 1),
                new_no: None,
                text: old[i].to_owned(),
            });
            i += 1;
        } else {
            out.push(DiffLine {
                kind: LineKind::Added,
                old_no: None,
                new_no: Some(offset + j + 1),
                text: new[j].to_owned(),
            });
            j += 1;
        }
    }
    while i < old.len() {
        out.push(DiffLine {
            kind: LineKind::Removed,
            old_no: Some(offset + i + 1),
            new_no: None,
            text: old[i].to_owned(),
        });
        i += 1;
    }
    while j < new.len() {
        out.push(DiffLine {
            kind: LineKind::Added,
            old_no: None,
            new_no: Some(offset + j + 1),
            text: new[j].to_owned(),
        });
        j += 1;
    }
    out
}

/// Split a flat script into hunks with `context` lines of padding.
fn group(script: &[DiffLine], context: usize) -> Vec<Hunk> {
    let changed: Vec<usize> = script
        .iter()
        .enumerate()
        .filter(|(_, line)| line.kind != LineKind::Context)
        .map(|(index, _)| index)
        .collect();
    if changed.is_empty() {
        return Vec::new();
    }
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut start = changed[0].saturating_sub(context);
    let mut end = (changed[0] + context + 1).min(script.len());
    for index in changed.iter().skip(1) {
        let low = index.saturating_sub(context);
        if low <= end {
            end = (index + context + 1).min(script.len());
        } else {
            hunks.push(hunk(&script[start..end]));
            start = low;
            end = (index + context + 1).min(script.len());
        }
    }
    hunks.push(hunk(&script[start..end]));
    hunks
}

fn hunk(lines: &[DiffLine]) -> Hunk {
    Hunk {
        old_start: lines
            .iter()
            .find_map(|line| line.old_no)
            .unwrap_or(1),
        new_start: lines
            .iter()
            .find_map(|line| line.new_no)
            .unwrap_or(1),
        lines: lines.to_vec(),
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// How to render a diff on a particular surface.
#[derive(Debug, Clone, Copy)]
pub struct DiffOptions {
    /// Terminal width.
    pub width: u16,
    /// Show the line-number gutter.
    pub gutter: bool,
    /// Show the `path +N −M` header.
    pub header: bool,
    /// Elide after this many body rows, with a counted marker. `None` for the
    /// full diff, which is what the expanded view uses.
    pub max_rows: Option<usize>,
    /// Indent applied to every row, for nesting under a tool row.
    pub indent: &'static str,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            width: 80,
            gutter: true,
            header: true,
            max_rows: None,
            indent: "",
        }
    }
}

impl DiffOptions {
    /// The collapsed form used inline under a tool row: no gutter, capped.
    #[must_use]
    pub const fn inline(width: u16) -> Self {
        Self {
            width,
            gutter: false,
            header: false,
            max_rows: Some(6),
            indent: "   ",
        }
    }

    /// The `Tab`-expanded form: everything, with the gutter.
    #[must_use]
    pub const fn expanded(width: u16) -> Self {
        Self {
            width,
            gutter: true,
            header: true,
            max_rows: None,
            indent: "   ",
        }
    }
}

/// Render a diff. The single entry point for every surface.
#[must_use]
pub fn render(diff: &FileDiff, theme: &Theme, options: &DiffOptions) -> Vec<Row> {
    let mut rows = Vec::new();
    if options.header {
        rows.push(header_row(diff, theme, options));
    }
    if diff.is_empty() {
        return rows;
    }

    let number_width = if options.gutter { gutter_width(diff) } else { 0 };
    let mut body: Vec<Row> = Vec::new();
    for (index, hunk) in diff.hunks.iter().enumerate() {
        if index > 0 {
            // Hunk separation: a dim ellipsis carrying the count of lines the
            // reader is not being shown, so the gap is information rather than
            // a mystery.
            let skipped = gap_between(&diff.hunks[index - 1], hunk);
            body.push(elision_row(skipped, theme, options));
        }
        body.extend(render_hunk(hunk, theme, options, number_width));
    }

    match options.max_rows {
        Some(cap) if body.len() > cap => {
            let hidden = body.len() - cap;
            rows.extend(body.into_iter().take(cap));
            rows.push(elision_row(Some(hidden), theme, options));
        }
        _ => rows.extend(body),
    }
    rows
}

fn header_row(diff: &FileDiff, theme: &Theme, options: &DiffOptions) -> Row {
    let mut spans = indent_spans(options, theme);
    spans.push(Span::new(diff.path.clone(), theme.text()));
    let added = diff.added();
    let removed = diff.removed();
    if added > 0 {
        spans.push(Span::new(
            format!(" +{added}"),
            theme.tokens.diff_add.style(),
        ));
    }
    if removed > 0 {
        // U+2212 MINUS SIGN, not a hyphen: it pairs visually with `+` at the
        // same weight, which a hyphen does not.
        spans.push(Span::new(
            format!(" −{removed}"),
            theme.tokens.diff_del.style(),
        ));
    }
    Row { spans }
}

fn gutter_width(diff: &FileDiff) -> usize {
    let highest = diff
        .hunks
        .iter()
        .flat_map(|hunk| &hunk.lines)
        .filter_map(|line| line.new_no.or(line.old_no))
        .max()
        .unwrap_or(1);
    highest.to_string().len().max(2)
}

fn gap_between(previous: &Hunk, next: &Hunk) -> Option<usize> {
    let end = previous
        .lines
        .iter()
        .filter_map(|line| line.new_no)
        .max()?;
    let start = next.lines.iter().find_map(|line| line.new_no)?;
    start.checked_sub(end + 1).filter(|gap| *gap > 0)
}

fn elision_row(count: Option<usize>, theme: &Theme, options: &DiffOptions) -> Row {
    let text = count.map_or_else(|| "…".to_owned(), |count| format!("… {count} lines"));
    let mut spans = indent_spans(options, theme);
    spans.push(Span::new(text, theme.faint()));
    Row { spans }
}

/// The row's leading indent, or nothing when there is none. An empty span
/// would still count as a span, and callers index by position.
fn indent_spans(options: &DiffOptions, theme: &Theme) -> Vec<Span> {
    if options.indent.is_empty() {
        Vec::new()
    } else {
        vec![Span::new(options.indent, theme.text())]
    }
}

fn render_hunk(
    hunk: &Hunk,
    theme: &Theme,
    options: &DiffOptions,
    number_width: usize,
) -> Vec<Row> {
    // Pair each run of removed lines with the added run that follows it: that
    // is what makes intra-line word highlighting possible at all.
    let mut emphasis: Vec<Option<Vec<bool>>> = vec![None; hunk.lines.len()];
    let mut index = 0usize;
    while index < hunk.lines.len() {
        if hunk.lines[index].kind != LineKind::Removed {
            index += 1;
            continue;
        }
        let del_start = index;
        while index < hunk.lines.len() && hunk.lines[index].kind == LineKind::Removed {
            index += 1;
        }
        let add_start = index;
        while index < hunk.lines.len() && hunk.lines[index].kind == LineKind::Added {
            index += 1;
        }
        let dels = del_start..add_start;
        let adds = add_start..index;
        for (offset, (del, add)) in dels.clone().zip(adds.clone()).enumerate() {
            let _ = offset;
            if let Some((old_mask, new_mask)) =
                word_emphasis(&hunk.lines[del].text, &hunk.lines[add].text)
            {
                emphasis[del] = Some(old_mask);
                emphasis[add] = Some(new_mask);
            }
        }
    }

    hunk.lines
        .iter()
        .enumerate()
        .map(|(slot, line)| {
            render_line(line, emphasis[slot].as_deref(), theme, options, number_width)
        })
        .collect()
}

fn render_line(
    line: &DiffLine,
    emphasis: Option<&[bool]>,
    theme: &Theme,
    options: &DiffOptions,
    number_width: usize,
) -> Row {
    let (marker, base, emph) = match line.kind {
        LineKind::Added => (
            "+",
            theme.tokens.diff_add.style(),
            theme.tokens.diff_add_emph.style().with(Modifiers::BOLD),
        ),
        LineKind::Removed => (
            "−",
            theme.tokens.diff_del.style(),
            theme.tokens.diff_del_emph.style().with(Modifiers::BOLD),
        ),
        LineKind::Context => (" ", theme.muted(), theme.muted()),
    };

    let mut spans = indent_spans(options, theme);
    if options.gutter {
        let number = line
            .new_no
            .or(line.old_no)
            .map_or_else(String::new, |no| no.to_string());
        // Uniformly dim, whatever the line's kind: the gutter is navigation.
        spans.push(Span::new(
            format!("{number:>number_width$} "),
            theme.faint(),
        ));
    }
    spans.push(Span::new(format!("{marker} "), base));

    let used: usize = spans.iter().map(|span| span.text.width()).sum();
    let budget = usize::from(options.width).saturating_sub(used).max(1);
    match emphasis {
        Some(mask) => {
            for (token, changed) in tokenize(&line.text).into_iter().zip(mask) {
                spans.push(Span::new(token, if *changed { emph } else { base }));
            }
        }
        None => spans.push(Span::new(line.text.clone(), base)),
    }
    let mut row = Row { spans };
    truncate_row(&mut row, used + budget);
    row
}

fn truncate_row(row: &mut Row, width: usize) {
    if row.width() <= width {
        return;
    }
    // DESIGN.md §3: "wide content truncates, the page never scrolls
    // horizontally", and the degradation is visible.
    let mut used = 0usize;
    let mut kept: Vec<Span> = Vec::new();
    for span in std::mem::take(&mut row.spans) {
        if used + 1 >= width {
            break;
        }
        let mut text = String::new();
        for grapheme in span.text.chars() {
            let advance = grapheme.to_string().width().max(1);
            if used + advance + 1 > width {
                break;
            }
            text.push(grapheme);
            used += advance;
        }
        let full = text.width() == span.text.width();
        if !text.is_empty() {
            kept.push(Span { text, ..span.clone() });
        }
        if !full {
            break;
        }
    }
    kept.push(Span::plain("…"));
    row.spans = kept;
}

// ---------------------------------------------------------------------------
// Word diff
// ---------------------------------------------------------------------------

/// Split into word, whitespace and single-punctuation tokens.
///
/// Three classes, not two. Lumping punctuation in with whitespace makes
/// `\u{20}(` a single token, so reindenting a line reads as changing its
/// parentheses — which is exactly the false 40% that would bail the word-diff
/// out on a pure reformat. Punctuation is emitted one character at a time so a
/// changed `,` never drags a `)` with it.
#[must_use]
pub fn tokenize(line: &str) -> Vec<String> {
    #[derive(PartialEq, Eq, Clone, Copy)]
    enum Class {
        Word,
        Space,
        Punct,
    }
    let class = |ch: char| {
        if ch.is_alphanumeric() || ch == '_' {
            Class::Word
        } else if ch.is_whitespace() {
            Class::Space
        } else {
            Class::Punct
        }
    };
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_class = Class::Word;
    for ch in line.chars() {
        let next = class(ch);
        if !current.is_empty() && (next != current_class || next == Class::Punct) {
            out.push(std::mem::take(&mut current));
        }
        current_class = next;
        current.push(ch);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Per-token "this changed" masks for a removed/added pair.
///
/// `None` means the word-diff was dropped: either the lines share nothing worth
/// pairing, or more than [`WORD_DIFF_BAILOUT`] of the tokens changed, at which
/// point the highlight is noise and the caller marks the whole line.
#[must_use]
pub fn word_emphasis(old: &str, new: &str) -> Option<(Vec<bool>, Vec<bool>)> {
    let old_tokens = tokenize(old);
    let new_tokens = tokenize(new);
    if old_tokens.is_empty() || new_tokens.is_empty() {
        return None;
    }
    if old_tokens.len().saturating_mul(new_tokens.len()) > LCS_CELL_CAP {
        return None;
    }

    let rows = old_tokens.len() + 1;
    let columns = new_tokens.len() + 1;
    let mut table = vec![0u32; rows * columns];
    for i in (0..old_tokens.len()).rev() {
        for j in (0..new_tokens.len()).rev() {
            table[i * columns + j] = if old_tokens[i] == new_tokens[j] {
                table[(i + 1) * columns + j + 1] + 1
            } else {
                table[(i + 1) * columns + j].max(table[i * columns + j + 1])
            };
        }
    }

    let mut old_mask = vec![true; old_tokens.len()];
    let mut new_mask = vec![true; new_tokens.len()];
    let (mut i, mut j) = (0usize, 0usize);
    while i < old_tokens.len() && j < new_tokens.len() {
        if old_tokens[i] == new_tokens[j] {
            old_mask[i] = false;
            new_mask[j] = false;
            i += 1;
            j += 1;
        } else if table[(i + 1) * columns + j] >= table[i * columns + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }

    // Count only significant tokens: whitespace churn is not a change a reader
    // needs highlighted, and counting it would trip the bail-out early.
    let significant = |tokens: &[String], mask: &[bool]| -> (usize, usize) {
        let mut total = 0usize;
        let mut changed = 0usize;
        for (token, flag) in tokens.iter().zip(mask) {
            if token.trim().is_empty() {
                continue;
            }
            total += 1;
            if *flag {
                changed += 1;
            }
        }
        (total, changed)
    };
    let (old_total, old_changed) = significant(&old_tokens, &old_mask);
    let (new_total, new_changed) = significant(&new_tokens, &new_mask);
    let total = old_total.max(new_total);
    if total == 0 {
        return None;
    }
    let changed = old_changed.max(new_changed);
    #[allow(clippy::cast_precision_loss)]
    let ratio = changed as f32 / total as f32;
    if ratio > WORD_DIFF_BAILOUT {
        return None;
    }
    Some((old_mask, new_mask))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme() -> Theme {
        Theme::lyra()
    }

    fn texts(rows: &[Row]) -> Vec<String> {
        rows.iter().map(Row::plain_text).collect()
    }

    fn options() -> DiffOptions {
        DiffOptions {
            width: 60,
            ..DiffOptions::default()
        }
    }

    #[test]
    fn a_single_line_edit_shows_one_hunk_with_context() {
        let old = "a\nb\nc\nd\ne\n";
        let new = "a\nb\nCHANGED\nd\ne\n";
        let diff = FileDiff::between("f.txt", old, new, 1);
        assert_eq!(diff.added(), 1);
        assert_eq!(diff.removed(), 1);
        assert_eq!(diff.hunks.len(), 1);
        assert_eq!(
            texts(&render(&diff, &theme(), &options())),
            ["f.txt +1 −1", " 2   b", " 3 − c", " 3 + CHANGED", " 4   d"]
        );
    }

    #[test]
    fn distant_changes_become_separate_hunks_with_a_counted_elision() {
        let old: String = (1..=40).map(|n| format!("line {n}\n")).collect();
        let new = old.replace("line 3\n", "line THREE\n").replace("line 37\n", "line THIRTY-SEVEN\n");
        let diff = FileDiff::between("f", &old, &new, 1);
        assert_eq!(diff.hunks.len(), 2);
        let rows = texts(&render(&diff, &theme(), &options()));
        let elision = rows.iter().find(|row| row.contains('…')).unwrap();
        assert!(elision.contains("31 lines"), "{elision:?}");
    }

    #[test]
    fn the_header_counts_with_a_real_minus_sign() {
        let diff = FileDiff::between("src/a.ts", "x\n", "y\nz\n", 0);
        let header = render(&diff, &theme(), &options())[0].plain_text();
        assert_eq!(header, "src/a.ts +2 −1");
        assert!(header.contains('−'), "U+2212, not a hyphen");
    }

    #[test]
    fn the_gutter_is_uniformly_dim_whatever_the_line_kind() {
        let theme = theme();
        let diff = FileDiff::between("f", "a\nb\n", "a\nB\n", 1);
        let rows = render(&diff, &theme, &options());
        let gutters: Vec<crate::ui::Style> = rows[1..]
            .iter()
            .map(|row| row.spans[0].style)
            .collect();
        assert!(gutters.iter().all(|style| *style == theme.faint()), "{gutters:?}");
    }

    #[test]
    fn the_gutter_can_be_turned_off_for_an_inline_surface() {
        let diff = FileDiff::between("f", "a\n", "b\n", 0);
        let rows = texts(&render(&diff, &theme(), &DiffOptions::inline(60)));
        assert_eq!(rows, ["   − a", "   + b"]);
    }

    #[test]
    fn word_level_emphasis_marks_only_what_changed() {
        let (old, new) = word_emphasis(
            "const timeout = 30;",
            "const timeout = 60;",
        )
        .expect("a one-token change is well under the bail-out");
        let changed_old: Vec<usize> = old.iter().enumerate().filter(|(_, f)| **f).map(|(i, _)| i).collect();
        assert_eq!(changed_old.len(), 1);
        assert_eq!(tokenize("const timeout = 30;")[changed_old[0]], "30");
        assert!(new.iter().filter(|flag| **flag).count() == 1);
    }

    #[test]
    fn a_heavily_changed_line_bails_out_of_the_word_diff() {
        assert!(
            word_emphasis(
                "let a = 1; let b = 2; let c = 3;",
                "return compute(everything, differently, now);"
            )
            .is_none(),
            "past 40% changed tokens the highlight is confetti"
        );
    }

    #[test]
    fn the_bailout_measures_the_longer_side() {
        // Three words became thirty; only 10% of the *new* line matched, but
        // 100% of the old line is gone. Measuring the longer side catches it.
        let new: String = std::iter::repeat_n("word", 30).collect::<Vec<_>>().join(" ");
        assert!(word_emphasis("a b c", &new).is_none());
    }

    #[test]
    fn whitespace_only_churn_does_not_trip_the_bailout() {
        let mask = word_emphasis("if (a) {", "if  (a)  {");
        assert!(mask.is_some(), "reindentation is not a 40% change");
    }

    #[test]
    fn emphasis_reaches_the_rendered_spans() {
        let theme = theme();
        let diff = FileDiff::between("f", "const timeout = 30;\n", "const timeout = 60;\n", 0);
        let rows = render(&diff, &theme, &options());
        let removed = &rows[1];
        assert!(
            removed
                .spans
                .iter()
                .any(|span| span.text == "30" && span.style.fg == theme.tokens.diff_del_emph.as_fg()),
            "{removed:?}"
        );
        let added = &rows[2];
        assert!(added
            .spans
            .iter()
            .any(|span| span.text == "60" && span.style.fg == theme.tokens.diff_add_emph.as_fg()));
    }

    #[test]
    fn a_bailed_out_pair_renders_the_whole_line_in_one_style() {
        let theme = theme();
        let diff = FileDiff::between(
            "f",
            "let a = 1; let b = 2; let c = 3;\n",
            "return compute(everything, differently, now);\n",
            0,
        );
        let rows = render(&diff, &theme, &options());
        let body: Vec<&Span> = rows[1].spans.iter().skip(2).collect();
        assert_eq!(body.len(), 1, "no intra-line runs when the word-diff bailed");
    }

    #[test]
    fn an_over_wide_line_truncates_visibly_and_never_scrolls() {
        let long = "x".repeat(400);
        let diff = FileDiff::between("f", "a\n", &format!("{long}\n"), 0);
        for row in render(&diff, &theme(), &DiffOptions { width: 30, ..options() }) {
            assert!(row.width() <= 30, "{:?}", row.plain_text());
        }
        let rows = texts(&render(&diff, &theme(), &DiffOptions { width: 30, ..options() }));
        assert!(rows.iter().any(|row| row.ends_with('…')));
    }

    #[test]
    fn the_row_cap_elides_with_a_count() {
        let old = String::new();
        let new: String = (1..=40).map(|n| format!("line {n}\n")).collect();
        let diff = FileDiff::between("f", &old, &new, 0);
        let rows = texts(&render(
            &diff,
            &theme(),
            &DiffOptions {
                max_rows: Some(3),
                ..options()
            },
        ));
        assert_eq!(rows.len(), 5, "header, three lines, one marker");
        assert!(rows.last().unwrap().contains("37 lines"), "{rows:?}");
    }

    #[test]
    fn a_unified_patch_parses_into_the_same_shape() {
        let patch = "\
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@ fn context
 keep one
-drop this
+add this
+and this
 keep two
";
        let diff = FileDiff::from_unified("src/a.ts", patch);
        assert_eq!(diff.hunks.len(), 1);
        assert_eq!(diff.added(), 2);
        assert_eq!(diff.removed(), 1);
        assert_eq!(diff.hunks[0].old_start, 10);
        assert_eq!(diff.hunks[0].new_start, 10);
        assert_eq!(
            texts(&render(&diff, &theme(), &options())),
            [
                "src/a.ts +2 −1",
                "10   keep one",
                "11 − drop this",
                "11 + add this",
                "12 + and this",
                "13   keep two",
            ]
        );
    }

    #[test]
    fn a_malformed_patch_renders_nothing_rather_than_panicking() {
        let diff = FileDiff::from_unified("f", "not a diff at all\n@@ garbage @@\n+orphan\n");
        assert!(diff.is_empty() || diff.added() == 0);
        let _ = render(&diff, &theme(), &options());
    }

    #[test]
    fn an_identical_pair_produces_no_hunks() {
        let diff = FileDiff::between("f", "same\n", "same\n", 3);
        assert!(diff.is_empty());
        assert_eq!(texts(&render(&diff, &theme(), &options())), ["f"]);
    }

    #[test]
    fn a_pure_append_keeps_the_original_line_numbers() {
        let diff = FileDiff::between("f", "a\nb\n", "a\nb\nc\n", 1);
        let rows = texts(&render(&diff, &theme(), &options()));
        assert_eq!(rows, ["f +1", " 2   b", " 3 + c"]);
    }

    #[test]
    fn a_huge_rewrite_degrades_instead_of_running_the_full_table() {
        let old: String = (0..3000).map(|n| format!("old {n}\n")).collect();
        let new: String = (0..3000).map(|n| format!("new {n}\n")).collect();
        let started = std::time::Instant::now();
        let diff = FileDiff::between("big", &old, &new, 0);
        assert!(started.elapsed().as_secs() < 5, "the cap did not engage");
        assert_eq!(diff.added(), 3000);
        assert_eq!(diff.removed(), 3000);
    }
}
