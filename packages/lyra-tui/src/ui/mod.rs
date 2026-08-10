//! Presentation primitives shared by the engine and (from build phase 5) the
//! widget layer.
//!
//! Phase 2 needs exactly one thing from this layer: a styled row that can be
//! rendered two ways — as standalone ANSI when it is committed to scrollback,
//! and into a [`Buffer`] cell grid when it is painted into the live region. Both
//! paths go through the same [`Row`], so a row cannot look different above and
//! below the fold.
//!
//! Phase 5 adds the content renderers on top of that primitive, all of them
//! producing plain `Vec<Row>` so that *every* surface — live region, scrollback
//! commit, resize replay — is the same bytes:
//!
//! | module | DESIGN.md §3 |
//! |---|---|
//! | [`markdown`] | line-boundary streaming publish, monotone stable prefix |
//! | [`syntax`] | fenced-code highlighting, no grammar downloads |
//! | [`diff`] | *the* diff renderer, for every surface |
//! | [`tool_row`] | `▸ edit src/auth.ts +12 −4` and its `└─` children |
//! | [`reliability`] | "never render nothing" |
//! | [`thinking`] | the model's reasoning: dim while live, one line after |
//! | [`transcript`] | user bands, session header, run collapsing, replay |
//!
//! Build phase 6 adds the two interactive ones, on the same primitive:
//!
//! | module | DESIGN.md |
//! |---|---|
//! | [`overlay`] | §4's palette, cheatsheet, pickers and completion popups |
//! | [`form`] | the overlay body that takes an answer: provider setup |
//! | [`results`] | §3's "never render nothing", applied to slash-command answers |
//!
//! Colour comes from [`crate::theme`]; nothing here hard-codes an [`Rgb`].

pub mod agent;
pub mod composer;
pub mod diff;
pub mod footer;
pub mod form;
pub mod hints;
pub mod markdown;
pub mod overlay;
pub mod queue;
pub mod reliability;
pub mod results;
pub mod syntax;
pub mod thinking;
pub mod tool_row;
pub mod transcript;

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::vendor::flywheel::{Buffer, Modifiers, Rgb};

/// A colour/attribute set.
///
/// `fg`/`bg` default to [`Rgb::DEFAULT_FG`]/[`Rgb::DEFAULT_BG`], which the
/// vendored diff emits as SGR 39/49 — i.e. *the terminal's own* colours. A row
/// that sets nothing therefore inherits the user's background, which is what
/// DESIGN.md §3's `system` theme requires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Style {
    /// Foreground colour.
    pub fg: Rgb,
    /// Background colour.
    pub bg: Rgb,
    /// Attribute bits.
    pub modifiers: Modifiers,
}

impl Default for Style {
    fn default() -> Self {
        Self {
            fg: Rgb::DEFAULT_FG,
            bg: Rgb::DEFAULT_BG,
            modifiers: Modifiers::empty(),
        }
    }
}

impl Style {
    /// A style with a foreground colour.
    #[must_use]
    pub fn fg(fg: Rgb) -> Self {
        Self {
            fg,
            ..Self::default()
        }
    }

    /// The dim-first neutral, DESIGN.md §3's most-used token.
    #[must_use]
    pub fn dim() -> Self {
        Self {
            modifiers: Modifiers::DIM,
            ..Self::default()
        }
    }

    /// Add attribute bits.
    #[must_use]
    pub const fn with(mut self, modifiers: Modifiers) -> Self {
        self.modifiers = self.modifiers.union(modifiers);
        self
    }

    /// Write the SGR sequence that establishes this style.
    fn write_sgr(self, out: &mut Vec<u8>) {
        out.extend_from_slice(b"\x1b[0m");
        if self.modifiers.contains(Modifiers::BOLD) {
            out.extend_from_slice(b"\x1b[1m");
        }
        if self.modifiers.contains(Modifiers::DIM) {
            out.extend_from_slice(b"\x1b[2m");
        }
        if self.modifiers.contains(Modifiers::ITALIC) {
            out.extend_from_slice(b"\x1b[3m");
        }
        if self.modifiers.contains(Modifiers::UNDERLINE) {
            out.extend_from_slice(b"\x1b[4m");
        }
        if self.modifiers.contains(Modifiers::STRIKETHROUGH) {
            out.extend_from_slice(b"\x1b[9m");
        }
        if self.fg != Rgb::DEFAULT_FG {
            let Rgb { r, g, b } = self.fg;
            out.extend_from_slice(format!("\x1b[38;2;{r};{g};{b}m").as_bytes());
        }
        if self.bg != Rgb::DEFAULT_BG {
            let Rgb { r, g, b } = self.bg;
            out.extend_from_slice(format!("\x1b[48;2;{r};{g};{b}m").as_bytes());
        }
    }
}

/// A run of text sharing one style.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Span {
    /// The text.
    pub text: String,
    /// Its style.
    pub style: Style,
    /// An OSC 8 hyperlink target.
    ///
    /// Honoured only on the scrollback path: a cell grid has nowhere to put a
    /// URL, so in the live region a linked span shows as underlined text and
    /// becomes clickable the moment it is committed. That asymmetry is fine
    /// because the live region holds at most the last few rows of a stream —
    /// but it is why link styling always carries `UNDERLINE` too, rather than
    /// relying on the terminal to decorate the link itself.
    pub link: Option<String>,
}

impl Span {
    /// A styled span.
    #[must_use]
    pub fn new(text: impl Into<String>, style: Style) -> Self {
        Self {
            text: text.into(),
            style,
            link: None,
        }
    }

    /// An unstyled span.
    #[must_use]
    pub fn plain(text: impl Into<String>) -> Self {
        Self::new(text, Style::default())
    }

    /// A styled span carrying an OSC 8 hyperlink.
    #[must_use]
    pub fn linked(text: impl Into<String>, style: Style, url: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            style,
            link: Some(url.into()),
        }
    }
}

/// Write an OSC 8 hyperlink introducer. An empty `url` closes the link.
///
/// `ESC ] 8 ; params ; url ST`. The `ST` form (`ESC \`) is used rather than
/// `BEL` because tmux passes it through and mangles the other.
fn write_osc8(out: &mut Vec<u8>, url: &str) {
    out.extend_from_slice(b"\x1b]8;;");
    out.extend_from_slice(url.as_bytes());
    out.extend_from_slice(b"\x1b\\");
}

/// One display row. Never contains a newline.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Row {
    /// The spans, left to right.
    pub spans: Vec<Span>,
}

impl Row {
    /// An empty row.
    #[must_use]
    pub const fn blank() -> Self {
        Self { spans: Vec::new() }
    }

    /// A single-span row.
    #[must_use]
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            spans: vec![Span::plain(text)],
        }
    }

    /// A single-span styled row.
    #[must_use]
    pub fn styled(text: impl Into<String>, style: Style) -> Self {
        Self {
            spans: vec![Span::new(text, style)],
        }
    }

    /// The plain text of the row.
    #[must_use]
    pub fn plain_text(&self) -> String {
        self.spans.iter().map(|span| span.text.as_str()).collect()
    }

    /// Display width in columns.
    #[must_use]
    pub fn width(&self) -> usize {
        self.spans
            .iter()
            .map(|span| UnicodeWidthStr::width(span.text.as_str()))
            .sum()
    }

    /// Render as standalone ANSI, truncated to `width` columns.
    ///
    /// Used only on the scrollback path. The row is left at the terminal's
    /// default attributes so nothing bleeds into the next line, and no trailing
    /// blanks are emitted — a committed row must not paint a background band
    /// across the width of the terminal.
    pub fn write_ansi(&self, width: u16, out: &mut Vec<u8>) {
        let mut used = 0usize;
        let limit = width as usize;
        let mut wrote_style = false;
        for span in &self.spans {
            if used >= limit {
                break;
            }
            if span.text.is_empty() {
                continue;
            }
            span.style.write_sgr(out);
            wrote_style = true;
            // OSC 8 wraps the run rather than living in the SGR state, so a
            // truncated row still closes the link it opened.
            if let Some(url) = &span.link {
                write_osc8(out, url);
            }
            for grapheme in span.text.graphemes(true) {
                let advance = UnicodeWidthStr::width(grapheme).max(1);
                if used + advance > limit {
                    used = limit;
                    break;
                }
                out.extend_from_slice(grapheme.as_bytes());
                used += advance;
            }
            if span.link.is_some() {
                write_osc8(out, "");
            }
        }
        if wrote_style {
            out.extend_from_slice(b"\x1b[0m");
        }
    }

    /// Paint into `buffer` at row `y`, truncating at the buffer's width.
    pub fn paint(&self, buffer: &mut Buffer, y: u16) {
        let mut x = 0u16;
        for span in &self.spans {
            for grapheme in span.text.graphemes(true) {
                if x >= buffer.width() {
                    return;
                }
                let advance = buffer.set_grapheme(x, y, grapheme, span.style.fg, span.style.bg);
                if let Some(cell) = buffer.get_mut(x, y) {
                    cell.set_modifiers(span.style.modifiers);
                }
                x = x.saturating_add(u16::from(advance.max(1)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_style_emits_no_colour_sequences() {
        let mut out = Vec::new();
        Row::text("hi").write_ansi(80, &mut out);
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text, "\x1b[0mhi\x1b[0m");
        assert!(!text.contains("38;2"), "a default row must inherit the terminal palette");
    }

    #[test]
    fn ansi_truncates_at_the_terminal_width() {
        let mut out = Vec::new();
        Row::text("abcdefgh").write_ansi(4, &mut out);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("abcd"), "{text:?}");
        assert!(!text.contains('e'), "{text:?}");
    }

    #[test]
    fn ansi_never_pads_to_the_full_width() {
        let mut out = Vec::new();
        Row::text("ab").write_ansi(40, &mut out);
        assert!(!String::from_utf8(out).unwrap().contains("  "));
    }

    #[test]
    fn wide_graphemes_do_not_straddle_the_truncation_point() {
        let mut out = Vec::new();
        Row::text("あああ").write_ansi(5, &mut out);
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.matches('あ').count(), 2, "{text:?}");
    }

    #[test]
    fn width_counts_display_columns_not_bytes() {
        assert_eq!(Row::text("あい").width(), 4);
        assert_eq!(Row::text("ab").width(), 2);
    }

    #[test]
    fn painting_places_graphemes_at_display_columns() {
        let mut buffer = Buffer::new(8, 1);
        Row::text("あb").paint(&mut buffer, 0);
        assert_eq!(buffer.get_grapheme(0, 0), Some("あ"));
        assert_eq!(buffer.get_grapheme(2, 0), Some("b"));
    }
}
