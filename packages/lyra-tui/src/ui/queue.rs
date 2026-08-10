//! The queue block (DESIGN.md §0.2, §3).
//!
//! > `Enter` while streaming → **queue**. Visible above the composer
//! > (`N queued · ctrl+s to steer now`, with previews). Auto-submits when the
//! > turn ends.
//!
//! Two properties matter more than how it looks:
//!
//! 1. **It is always visible while pending.** DESIGN.md §3 lists "queue always
//!    visible while pending" under *reliability, visible*. A queued message that
//!    the user cannot see is a message they will send twice.
//! 2. **It says how to change its mind.** The header carries the `ctrl+s` hint
//!    because that is the moment the user needs it — not in a help screen.
//!
//! The block has no fixed height and is absent when the queue is empty; that is
//! deliberate and does not conflict with DESIGN.md §3's anti-jitter rule, which
//! governs *chrome* rows (the activity strip, the footer). The queue is content.

use unicode_width::UnicodeWidthStr;

use crate::input::composer::{ComposerMode, Submission};
use crate::theme::Theme;
use crate::ui::{Row, Span};

/// How many previews are shown before the block elides.
pub const MAX_PREVIEWS: usize = 3;

/// Render the queue block. Empty when nothing is queued.
#[must_use]
pub fn render(theme: &Theme, entries: &[Submission], width: u16) -> Vec<Row> {
    if entries.is_empty() {
        return Vec::new();
    }
    let width = width.max(8) as usize;
    let mut rows = Vec::with_capacity(entries.len().min(MAX_PREVIEWS) + 2);

    let count = entries.len();
    rows.push(header(theme, count, width));

    for entry in entries.iter().take(MAX_PREVIEWS) {
        let marker = match entry.mode {
            ComposerMode::Prompt => "  · ",
            ComposerMode::Bash => "  ! ",
        };
        let budget = width.saturating_sub(UnicodeWidthStr::width(marker)).max(1);
        rows.push(Row {
            spans: vec![
                Span::new(marker, theme.faint()),
                Span::new(preview(&entry.text, budget), theme.faint()),
            ],
        });
    }

    if count > MAX_PREVIEWS {
        rows.push(Row {
            spans: vec![Span::new(
                format!("  · +{} more", count - MAX_PREVIEWS),
                theme.faint(),
            )],
        });
    }
    rows
}

/// The header, degrading by priority as the terminal narrows.
///
/// The depth is the load-bearing half — a user who cannot see *how many* is
/// queued will re-send — so the `ctrl+s` hint sheds first, and only then does
/// the count itself get clipped.
fn header(theme: &Theme, count: usize, width: usize) -> Row {
    let full = [
        Span::new("◆ ", theme.accent()),
        Span::new(format!("{count} queued"), theme.muted()),
        Span::new(" · ", theme.faint()),
        Span::new("ctrl+s", theme.accent()),
        Span::new(" to steer now", theme.muted()),
    ];
    for take in [5usize, 4, 2] {
        let spans: Vec<Span> = full.iter().take(take).cloned().collect();
        let used: usize = spans
            .iter()
            .map(|span| UnicodeWidthStr::width(span.text.as_str()))
            .sum();
        if used <= width {
            return Row { spans };
        }
    }
    Row {
        spans: vec![Span::new(preview(&format!("◆ {count} queued"), width), theme.muted())],
    }
}

/// One line of a queued prompt, collapsed and clipped.
///
/// A queued message is often multiline; showing its first line only, with an
/// explicit `⏎` where the breaks were, keeps the block's height a function of
/// the queue depth rather than of what was typed.
fn preview(text: &str, budget: usize) -> String {
    let mut flattened = String::new();
    for (index, line) in text.lines().enumerate() {
        if index > 0 {
            flattened.push_str(" ⏎ ");
        }
        flattened.push_str(line.trim());
        if UnicodeWidthStr::width(flattened.as_str()) > budget {
            break;
        }
    }
    if UnicodeWidthStr::width(flattened.as_str()) <= budget {
        return flattened;
    }
    let mut out = String::new();
    let mut used = 0usize;
    for grapheme in unicode_segmentation::UnicodeSegmentation::graphemes(flattened.as_str(), true) {
        let advance = UnicodeWidthStr::width(grapheme).max(1);
        if used + advance > budget.saturating_sub(1) {
            break;
        }
        out.push_str(grapheme);
        used += advance;
    }
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(text: &str) -> Submission {
        Submission {
            text: text.to_owned(),
            mode: ComposerMode::Prompt,
        }
    }

    fn text_of(rows: &[Row]) -> Vec<String> {
        rows.iter().map(Row::plain_text).collect()
    }

    #[test]
    fn an_empty_queue_draws_nothing() {
        assert!(render(&Theme::lyra(), &[], 80).is_empty());
    }

    #[test]
    fn the_header_states_the_depth_and_how_to_steer() {
        let rows = render(&Theme::lyra(), &[entry("a"), entry("b")], 80);
        assert_eq!(rows[0].plain_text(), "◆ 2 queued · ctrl+s to steer now");
    }

    #[test]
    fn every_queued_entry_up_to_the_cap_gets_a_preview() {
        let entries: Vec<_> = ["one", "two", "three"].iter().map(|t| entry(t)).collect();
        let rows = render(&Theme::lyra(), &entries, 80);
        assert_eq!(rows.len(), 4);
        assert_eq!(
            text_of(&rows[1..]),
            ["  · one", "  · two", "  · three"]
        );
    }

    #[test]
    fn a_deep_queue_elides_with_a_count() {
        let entries: Vec<_> = (0..7).map(|n| entry(&format!("item {n}"))).collect();
        let rows = render(&Theme::lyra(), &entries, 80);
        assert_eq!(rows.len(), 5, "header, three previews, the elision");
        assert_eq!(rows[4].plain_text(), "  · +4 more");
    }

    #[test]
    fn a_multiline_prompt_previews_on_one_line() {
        let rows = render(&Theme::lyra(), &[entry("first line\nsecond line")], 80);
        assert_eq!(rows[1].plain_text(), "  · first line ⏎ second line");
    }

    #[test]
    fn a_long_preview_is_clipped_with_a_visible_ellipsis() {
        let rows = render(&Theme::lyra(), &[entry(&"x".repeat(200))], 40);
        let preview = rows[1].plain_text();
        assert!(preview.ends_with('…'), "{preview:?}");
        assert!(rows[1].width() <= 40, "{preview:?}");
    }

    #[test]
    fn a_queued_bash_command_is_marked_as_one() {
        let bash = Submission {
            text: "rm -rf build".to_owned(),
            mode: ComposerMode::Bash,
        };
        let rows = render(&Theme::lyra(), &[bash], 80);
        assert_eq!(rows[1].plain_text(), "  ! rm -rf build");
    }

    #[test]
    fn no_row_ever_exceeds_the_terminal_width() {
        let entries: Vec<_> = (0..5)
            .map(|n| entry(&format!("{n} {}", "long ".repeat(30))))
            .collect();
        for width in [20u16, 40, 80] {
            for row in render(&Theme::lyra(), &entries, width) {
                assert!(row.width() <= width as usize, "{:?}", row.plain_text());
            }
        }
    }
}
