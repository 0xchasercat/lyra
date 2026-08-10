//! The composer's frame — DESIGN.md §3's **signature**.
//!
//! > The composer border is the single ambient indicator — a color state change
//! > while streaming (agent-identity tinted), no pulse, no travel, no shimmer.
//!
//! So this module draws a box and changes exactly one thing about it: the colour
//! of its border. Three states, all of them *state* rather than animation:
//!
//! | state | border | meaning |
//! |---|---|---|
//! | [`BorderState::Idle`] | accent | waiting for you |
//! | [`BorderState::Streaming`] | agent tint | a turn is running |
//! | [`BorderState::Bash`] | warning | `!` mode: this is a shell command |
//!
//! There is no fourth state and no motion. A user glancing at the bottom of the
//! screen learns whether the model is working from a colour they are already
//! looking at, which is the entire budget DESIGN.md §3 allows for ambient
//! feedback.
//!
//! # Layout
//!
//! ```text
//! ╭──────────────────────────────────────╮
//! │ ▸ write the migration and run it     │
//! │   against the staging database       │
//! ╰────────────────────── esc to clear ──╯
//! ```
//!
//! The two-column marker (`▸` prompt, `!` bash) is drawn once on the first row
//! and blank on continuations, so wrapped text stays aligned under itself. The
//! armed-Esc hint rides in the bottom border rather than on a row of its own —
//! a transient hint that added a row would violate DESIGN.md §3's rule that
//! chrome never collapses 0↔1.

use unicode_width::UnicodeWidthStr;

use crate::input::composer::{Class, ComposerMode, Layout};
use crate::theme::Theme;
use crate::ui::{Row, Span, Style};

/// Columns the frame costs: two borders, two pads, a two-column marker.
pub const CHROME_COLUMNS: usize = 6;

/// What the border colour is saying.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BorderState {
    /// Waiting for input.
    #[default]
    Idle,
    /// A turn is running.
    Streaming,
    /// `!` bash mode.
    Bash,
}

impl BorderState {
    /// Pick the state from the composer mode and whether a turn is running.
    ///
    /// Bash wins over streaming: what the user is about to run matters more than
    /// what the model is already doing.
    #[must_use]
    pub const fn of(mode: ComposerMode, streaming: bool) -> Self {
        match (mode, streaming) {
            (ComposerMode::Bash, _) => Self::Bash,
            (ComposerMode::Prompt, true) => Self::Streaming,
            (ComposerMode::Prompt, false) => Self::Idle,
        }
    }

    fn style(self, theme: &Theme) -> Style {
        match self {
            Self::Idle => theme.accent(),
            Self::Streaming => theme.agent(),
            Self::Bash => theme.warning(),
        }
    }
}

/// Everything the frame needs to draw itself.
#[derive(Debug, Clone, Copy)]
pub struct View<'a> {
    /// The laid-out buffer, from [`crate::input::Composer::layout`].
    pub layout: &'a Layout,
    /// Editing mode, for the marker glyph.
    pub mode: ComposerMode,
    /// Border colour state.
    pub border: BorderState,
    /// Shown instead of the buffer when it is empty.
    pub placeholder: &'a str,
    /// Armed-Esc hint, drawn in the bottom border.
    pub hint: Option<&'a str>,
    /// Maximum content rows before the view scrolls to follow the caret.
    pub max_rows: usize,
}

/// The drawn frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// Rows, top border first.
    pub rows: Vec<Row>,
    /// Caret `(column, row)` within [`Rendered::rows`], ready for
    /// `engine::scrollback::Frame::cursor`.
    pub caret: (u16, u16),
}

/// Columns available to the text at a given terminal width.
#[must_use]
pub fn content_width(width: u16) -> usize {
    (width as usize).saturating_sub(CHROME_COLUMNS).max(1)
}

/// Draw the composer.
#[must_use]
pub fn render(theme: &Theme, view: &View<'_>, width: u16) -> Rendered {
    let width = width.max(8);
    let inner = content_width(width);
    let border = view.border.style(theme);

    let visible = view.max_rows.max(1);
    let total = view.layout.rows.len().max(1);
    // Scroll so the caret stays visible; the composer never gets a scrollbar
    // because it never gets a viewport the user has to think about.
    let first = view.layout.caret.0.saturating_sub(visible.saturating_sub(1));
    let first = first.min(total.saturating_sub(visible.min(total)));
    let last = (first + visible).min(total);

    let mut rows = Vec::with_capacity(last - first + 2);
    rows.push(rule(width, border, '╭', '╮', None, theme));

    let empty = view.layout.rows.iter().all(Vec::is_empty);
    for index in first..last {
        let marker = if index == 0 {
            match view.mode {
                ComposerMode::Prompt => "▸ ",
                ComposerMode::Bash => "! ",
            }
        } else {
            "  "
        };
        let mut spans = vec![
            Span::new("│ ", border),
            Span::new(
                marker,
                if view.mode == ComposerMode::Bash {
                    theme.warning()
                } else {
                    theme.faint()
                },
            ),
        ];
        let mut used = 0usize;
        if empty && index == 0 && !view.placeholder.is_empty() {
            let text = truncate(view.placeholder, inner);
            used = UnicodeWidthStr::width(text.as_str());
            spans.push(Span::new(text, theme.faint()));
        } else if let Some(segments) = view.layout.rows.get(index) {
            for segment in segments {
                if used >= inner {
                    break;
                }
                let text = truncate(&segment.text, inner - used);
                used += UnicodeWidthStr::width(text.as_str());
                spans.push(Span::new(text, class_style(theme, segment.class)));
            }
        }
        spans.push(Span::new(" ".repeat(inner - used.min(inner)), Style::default()));
        spans.push(Span::new(" │", border));
        rows.push(Row { spans });
    }

    rows.push(rule(width, border, '╰', '╯', view.hint, theme));

    let caret_row = u16::try_from(view.layout.caret.0.saturating_sub(first) + 1).unwrap_or(1);
    let caret_col = u16::try_from((view.layout.caret.1 + 4).min(width as usize - 2)).unwrap_or(4);
    Rendered {
        rows,
        caret: (caret_col, caret_row),
    }
}

fn class_style(theme: &Theme, class: Class) -> Style {
    match class {
        Class::Text => theme.text(),
        // A chip is a placeholder, not content: it must read as chrome so the
        // eye skips it when scanning the prompt.
        Class::Chip => theme.muted(),
        Class::Command { recognised: true } => theme.accent(),
        // An unrecognised `/word` is ordinary text, not an error. It might just
        // be a path.
        Class::Command { recognised: false } => theme.text(),
        Class::Mention => theme.agent(),
    }
}

/// A horizontal border, optionally carrying a right-aligned hint.
fn rule(
    width: u16,
    border: Style,
    left: char,
    right: char,
    hint: Option<&str>,
    theme: &Theme,
) -> Row {
    let span = (width as usize).saturating_sub(2);
    let Some(hint) = hint.filter(|hint| !hint.is_empty()) else {
        return Row {
            spans: vec![Span::new(
                format!("{left}{}{right}", "─".repeat(span)),
                border,
            )],
        };
    };
    let label = format!(" {hint} ");
    let label_width = UnicodeWidthStr::width(label.as_str());
    if label_width + 4 > span {
        // Not enough room to say it without eating the whole border; the hint is
        // transient and the border is the signature, so the border wins.
        return Row {
            spans: vec![Span::new(
                format!("{left}{}{right}", "─".repeat(span)),
                border,
            )],
        };
    }
    let lead = span - label_width - 2;
    Row {
        spans: vec![
            Span::new(format!("{left}{}", "─".repeat(lead)), border),
            Span::new(label, theme.warning()),
            Span::new(format!("──{right}"), border),
        ],
    }
}

/// Truncate to `limit` display columns without splitting a wide grapheme.
fn truncate(text: &str, limit: usize) -> String {
    if UnicodeWidthStr::width(text) <= limit {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut used = 0usize;
    for grapheme in unicode_segmentation::UnicodeSegmentation::graphemes(text, true) {
        let advance = UnicodeWidthStr::width(grapheme).max(1);
        if used + advance > limit {
            break;
        }
        out.push_str(grapheme);
        used += advance;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::Composer;

    fn view<'a>(layout: &'a Layout, mode: ComposerMode, border: BorderState) -> View<'a> {
        View {
            layout,
            mode,
            border,
            placeholder: "ask anything",
            hint: None,
            max_rows: 6,
        }
    }

    fn text_of(row: &Row) -> String {
        row.plain_text()
    }

    #[test]
    fn an_empty_composer_shows_the_placeholder_inside_the_frame() {
        let theme = Theme::lyra();
        let composer = Composer::default();
        let layout = composer.layout_plain(content_width(40));
        let rendered = render(&theme, &view(&layout, ComposerMode::Prompt, BorderState::Idle), 40);
        assert_eq!(rendered.rows.len(), 3, "top border, one row, bottom border");
        assert!(text_of(&rendered.rows[1]).contains("ask anything"));
        assert!(text_of(&rendered.rows[0]).starts_with('╭'));
        assert!(text_of(&rendered.rows[2]).starts_with('╰'));
    }

    #[test]
    fn every_row_is_exactly_the_terminal_width() {
        let theme = Theme::lyra();
        let mut composer = Composer::default();
        composer.insert_text("a prompt that is long enough to wrap at this width");
        for width in [24u16, 40, 80] {
            let layout = composer.layout_plain(content_width(width));
            let rendered =
                render(&theme, &view(&layout, ComposerMode::Prompt, BorderState::Idle), width);
            for row in &rendered.rows {
                assert_eq!(
                    row.width(),
                    width as usize,
                    "width {width}: {:?}",
                    text_of(row)
                );
            }
        }
    }

    #[test]
    fn the_border_colour_is_the_only_thing_that_changes_between_states() {
        let theme = Theme::lyra();
        let composer = Composer::default();
        let layout = composer.layout_plain(content_width(40));
        let idle = render(&theme, &view(&layout, ComposerMode::Prompt, BorderState::Idle), 40);
        let streaming = render(
            &theme,
            &view(&layout, ComposerMode::Prompt, BorderState::Streaming),
            40,
        );
        assert_eq!(
            text_of(&idle.rows[0]),
            text_of(&streaming.rows[0]),
            "no glyph moves, no character is added"
        );
        assert_ne!(
            idle.rows[0].spans[0].style.fg, streaming.rows[0].spans[0].style.fg,
            "only the colour differs"
        );
        assert_eq!(idle.rows.len(), streaming.rows.len());
    }

    #[test]
    fn bash_mode_flips_both_the_border_and_the_marker() {
        let theme = Theme::lyra();
        let composer = Composer::default();
        let layout = composer.layout_plain(content_width(40));
        let bash = render(&theme, &view(&layout, ComposerMode::Bash, BorderState::Bash), 40);
        assert!(text_of(&bash.rows[1]).starts_with("│ ! "));
        assert_eq!(bash.rows[0].spans[0].style.fg, theme.warning().fg);
    }

    #[test]
    fn the_armed_hint_rides_in_the_bottom_border_and_costs_no_row() {
        let theme = Theme::lyra();
        let composer = Composer::default();
        let layout = composer.layout_plain(content_width(40));
        let mut with_hint = view(&layout, ComposerMode::Prompt, BorderState::Idle);
        with_hint.hint = Some("esc again to clear");
        let rendered = render(&theme, &with_hint, 40);
        assert_eq!(rendered.rows.len(), 3, "the hint adds no row");
        assert!(text_of(&rendered.rows[2]).contains("esc again to clear"));
        assert_eq!(rendered.rows[2].width(), 40);
    }

    #[test]
    fn a_hint_too_long_for_the_border_is_dropped_rather_than_wrapped() {
        let theme = Theme::lyra();
        let composer = Composer::default();
        let layout = composer.layout_plain(content_width(16));
        let mut narrow = view(&layout, ComposerMode::Prompt, BorderState::Idle);
        narrow.hint = Some("esc again to rewind");
        let rendered = render(&theme, &narrow, 16);
        assert_eq!(rendered.rows[2].width(), 16);
        assert!(!text_of(&rendered.rows[2]).contains("rewind"));
    }

    #[test]
    fn the_caret_lands_on_the_character_it_is_in_front_of() {
        let theme = Theme::lyra();
        let mut composer = Composer::default();
        composer.insert_text("abc");
        let layout = composer.layout_plain(content_width(40));
        let rendered = render(&theme, &view(&layout, ComposerMode::Prompt, BorderState::Idle), 40);
        // Column 4 is the first text column: `│`, space, then the two-column
        // marker.
        assert_eq!(rendered.caret, (7, 1));
        assert!(text_of(&rendered.rows[1]).starts_with("│ ▸ abc"));
    }

    #[test]
    fn a_tall_buffer_scrolls_to_keep_the_caret_visible() {
        let theme = Theme::lyra();
        let mut composer = Composer::default();
        for index in 0..12 {
            composer.insert_text(&format!("line {index}"));
            composer.insert_text("\n");
        }
        let layout = composer.layout_plain(content_width(40));
        let mut small = view(&layout, ComposerMode::Prompt, BorderState::Idle);
        small.max_rows = 4;
        let rendered = render(&theme, &small, 40);
        assert_eq!(rendered.rows.len(), 6, "4 content rows plus two borders");
        assert!(
            rendered.caret.1 <= 4,
            "the caret stays inside the frame: {:?}",
            rendered.caret
        );
        assert!(text_of(&rendered.rows[1]).contains("line 9"));
    }

    #[test]
    fn a_chip_reads_as_chrome_and_a_mention_as_the_agent_tint() {
        let theme = Theme::lyra();
        let mut composer = Composer::default();
        composer.insert_text("see @src/a.ts ");
        composer.paste(&(0..6).map(|n| format!("l{n}")).collect::<Vec<_>>().join("\n"));
        let layout = composer.layout_plain(content_width(60));
        let rendered = render(&theme, &view(&layout, ComposerMode::Prompt, BorderState::Idle), 60);
        let styles: Vec<_> = rendered.rows[1]
            .spans
            .iter()
            .map(|span| (span.text.clone(), span.style.fg))
            .collect();
        assert!(
            styles
                .iter()
                .any(|(text, fg)| text.contains("@src/a.ts") && *fg == theme.agent().fg),
            "{styles:?}"
        );
        assert!(
            styles
                .iter()
                .any(|(text, fg)| text.contains("[pasted") && *fg == theme.muted().fg),
            "{styles:?}"
        );
    }

    #[test]
    fn a_very_narrow_terminal_still_produces_a_well_formed_frame() {
        let theme = Theme::lyra();
        let mut composer = Composer::default();
        composer.insert_text("hello");
        let layout = composer.layout_plain(content_width(8));
        let rendered = render(&theme, &view(&layout, ComposerMode::Prompt, BorderState::Idle), 8);
        for row in &rendered.rows {
            assert_eq!(row.width(), 8, "{:?}", text_of(row));
        }
    }
}
