//! Thinking traces: the model's reasoning, rendered where it belongs.
//!
//! # Why this is not just "print the deltas"
//!
//! Thinking is the highest-volume, lowest-density content a turn produces. A
//! minute of reasoning is thousands of words that answer a question nobody
//! asked, and DESIGN.md §19's density rule is the reason this client committed
//! none of it to scrollback for its first six phases: a transcript buried under
//! deliberation is a transcript nobody scrolls back through.
//!
//! But *hiding* it was never the goal — the plumbing has always been there (the
//! `thinking` delta field, [`crate::state::PartBody::Thinking`]) and the screen
//! simply dropped it, so a model that thought for forty seconds before speaking
//! looked like a client doing nothing. So the split is by **surface**, not by
//! secrecy:
//!
//! - **Live**, thinking streams into the live region, dim, under a `∴ thinking`
//!   marker. It is transient by construction — the live region is bounded and
//!   redrawn — so it costs nothing permanent and answers "what is it doing".
//! - **Committed**, the whole trace collapses to one dim line: `∴ thought for
//!   23s`. Scrollback stays dense (§19) and the fact that thinking happened, and
//!   for how long, survives.
//!
//! # The config, and why there is one
//!
//! ```toml
//! [tui]
//! thinking = "full"        # default: the trace streams dim and stays, dim
//! # thinking = "collapsed" # dim while it streams, one `∴ thought for 23s` line after
//! # thinking = "off"       # render none of it, live or committed
//! ```
//!
//! The default is `full`: thinking is where a model goes down the wrong path,
//! and a trace that vanishes into a one-liner the moment it ends cannot be
//! reviewed — transparency is the point (§13). `collapsed` serves whoever
//! prefers dense scrollback over reviewable reasoning, and is the reason this
//! is a setting rather than a rule.
//!
//! # What is never rendered
//!
//! The signature sealing a thinking block. It is provider-opaque bytes with no
//! meaning to a human, it is not reasoning, and printing it would be noise that
//! looks like data. A **redacted** thinking part — signature, no text — is
//! therefore a part with nothing to show, and it collapses to the same one-liner
//! its timing earns it (see [`collapsed_row`]) rather than to a hexdump.

use crate::theme::Theme;
use crate::ui::markdown::wrap_spans;
use crate::ui::reliability::duration;
use crate::ui::{Row, Span};

/// The thinking marker. Pure Unicode (U+2234 THEREFORE), one column, and — like
/// every other glyph in DESIGN.md §3's vocabulary — a state marker rather than
/// decoration.
pub const GLYPH: &str = "∴";

/// How many rows of live trace the region shows.
///
/// Two reasons for a small number. The live region is bounded (12 rows by
/// default, six of them chrome) and drops rows from the **top**, so a block
/// taller than what is left loses its own `∴ thinking` marker first — and a
/// paragraph of dim text with nothing saying what it is reads as a rendering
/// bug. Five rows plus the marker fits what a thinking-only stream has to work
/// with. The second reason is arithmetic: this is what keeps a ten-thousand-word
/// deliberation from being re-wrapped in full on every 100 ms repaint.
pub const LIVE_ROWS: usize = 5;

/// How much of the trace the live buffer keeps.
///
/// The tail is what is being written *now*, which is the only part of a live
/// trace anyone reads. The complete text is never lost — the session store
/// holds it (`PartBody::Thinking`), and that is where the committed `full` form
/// gets it from — so this bound costs nothing but the top of a transient block.
pub const LIVE_CHARS: usize = 4_000;

/// What the TUI does with thinking traces.
///
/// `Full` is the default (owner decision, 2026-08-11): thinking is where a
/// model goes down the wrong path, and §13's "everything is inspectable"
/// applies to it exactly as much as to the answer — a trace that collapses to
/// one line the moment it ends cannot be reviewed. The trace commits dim, so
/// scrollback density survives; `collapsed` remains for those who want the
/// one-liner, `off` for none at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThinkingMode {
    /// Dim in the live region while it streams; one dim line once it ends.
    Collapsed,
    /// As `collapsed`, and the trace itself commits to scrollback, dim.
    #[default]
    Full,
    /// Nothing, on any surface.
    Off,
}

impl ThinkingMode {
    /// Every accepted spelling, for the error a bad value would deserve if this
    /// were a strict parser. It is not one — see [`Self::from_document`].
    pub const NAMES: [&'static str; 3] = ["collapsed", "full", "off"];

    /// Parse the value of `thinking = "…"`.
    #[must_use]
    pub fn from_value(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "collapsed" => Some(Self::Collapsed),
            "full" => Some(Self::Full),
            "off" | "none" | "hidden" => Some(Self::Off),
            _ => None,
        }
    }

    /// Read `[tui] thinking` (or a bare top-level `thinking`) out of a config
    /// document.
    ///
    /// Lenient in exactly the way [`crate::keybind::config`] is not, and for the
    /// opposite reason: an unknown *keybinding* silently ignored leaves a key
    /// dead, while an unreadable `thinking` value at worst leaves the default in
    /// force — which is a working TUI. A config file this client cannot even
    /// parse must never cost the user their session, so every failure here lands
    /// on [`Self::Collapsed`].
    #[must_use]
    pub fn from_document(source: &str) -> Self {
        let Ok(table) = source.parse::<toml::Table>() else {
            return Self::default();
        };
        table
            .get("tui")
            .and_then(toml::Value::as_table)
            .and_then(|tui| tui.get("thinking"))
            .or_else(|| table.get("thinking"))
            .and_then(toml::Value::as_str)
            .and_then(Self::from_value)
            .unwrap_or_default()
    }

    /// Whether anything at all is rendered.
    #[must_use]
    pub const fn shows(self) -> bool {
        !matches!(self, Self::Off)
    }

    /// Whether the trace itself reaches scrollback.
    #[must_use]
    pub const fn commits_text(self) -> bool {
        matches!(self, Self::Full)
    }
}

/// The live block: the marker, then the tail of the trace, dim.
///
/// Returns nothing for an empty trace, so a thinking part that has opened but
/// said nothing yet — or a redacted one, which will never say anything — does
/// not put a bare marker on screen with nothing under it.
#[must_use]
pub fn live_rows(text: &str, theme: &Theme, width: u16) -> Vec<Row> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let mut body = body_rows(text, theme, width);
    if body.len() > LIVE_ROWS {
        body.drain(..body.len() - LIVE_ROWS);
    }
    let mut rows = vec![Row {
        spans: vec![
            Span::new(format!("{GLYPH} "), theme.faint()),
            Span::new("thinking", theme.faint()),
        ],
    }];
    rows.extend(body);
    rows
}

/// The committed one-liner: `∴ thought for 23s`.
///
/// The duration is the *client's* observation — from the part opening to it
/// closing — because no wire field carries a provider-side one. It is omitted
/// rather than guessed at when the part was never seen opening, which is what a
/// mid-turn attach looks like.
#[must_use]
pub fn collapsed_row(seconds: Option<u64>, theme: &Theme) -> Row {
    let label = match seconds {
        Some(seconds) => format!("thought for {}", duration(seconds)),
        None => "thought".to_owned(),
    };
    Row {
        spans: vec![
            Span::new(format!("{GLYPH} "), theme.faint()),
            Span::new(label, theme.faint()),
        ],
    }
}

/// The committed full form: the one-liner, then the whole trace, dim.
#[must_use]
pub fn full_rows(text: &str, seconds: Option<u64>, theme: &Theme, width: u16) -> Vec<Row> {
    let mut rows = vec![collapsed_row(seconds, theme)];
    rows.extend(body_rows(text, theme, width));
    rows
}

/// The trace as indented dim rows, one paragraph break preserved as one blank.
fn body_rows(text: &str, theme: &Theme, width: u16) -> Vec<Row> {
    let style = theme.muted();
    let indent = [Span::new("  ", theme.faint())];
    let mut rows: Vec<Row> = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            // A run of blank lines is one breath, and a leading one is none:
            // the marker above already opened the block.
            if rows.last().is_some_and(|row| !row.spans.is_empty()) {
                rows.push(Row::blank());
            }
            continue;
        }
        rows.extend(wrap_spans(
            vec![Span::new(line.to_owned(), style)],
            usize::from(width).max(1),
            &indent,
            &indent,
        ));
    }
    while rows.last().is_some_and(|row| row.spans.is_empty()) {
        rows.pop();
    }
    rows
}

/// Trim a live buffer to its last [`LIVE_CHARS`] characters, on a character
/// boundary. Exposed because the buffer belongs to the transcript and the bound
/// belongs here.
pub fn trim_live(text: &mut String) {
    let excess = text.chars().count().saturating_sub(LIVE_CHARS);
    if excess == 0 {
        return;
    }
    let cut = text
        .char_indices()
        .nth(excess)
        .map_or(text.len(), |(index, _)| index);
    text.drain(..cut);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vendor::flywheel::Modifiers;

    fn theme() -> Theme {
        Theme::lyra()
    }

    fn texts(rows: &[Row]) -> Vec<String> {
        rows.iter().map(Row::plain_text).collect()
    }

    #[test]
    fn the_default_is_full_and_the_names_all_parse() {
        // Owner decision 2026-08-11: reviewable reasoning beats dense scrollback.
        assert_eq!(ThinkingMode::default(), ThinkingMode::Full);
        for name in ThinkingMode::NAMES {
            assert!(ThinkingMode::from_value(name).is_some(), "{name}");
        }
        assert_eq!(ThinkingMode::from_value("FULL"), Some(ThinkingMode::Full));
        assert_eq!(ThinkingMode::from_value("nonsense"), None);
    }

    #[test]
    fn the_config_is_read_from_the_tui_table_and_never_costs_a_session() {
        assert_eq!(
            ThinkingMode::from_document("[tui]\nthinking = \"collapsed\"\n"),
            ThinkingMode::Collapsed
        );
        assert_eq!(
            ThinkingMode::from_document("thinking = \"off\"\n"),
            ThinkingMode::Off
        );
        // Absent, mistyped, wrongly typed, and not even TOML: all the default.
        for source in [
            "",
            "[tui]\nthinking = \"sideways\"\n",
            "[tui]\nthinking = 3\n",
            "[[[not toml",
        ] {
            assert_eq!(
                ThinkingMode::from_document(source),
                ThinkingMode::Full,
                "{source:?}"
            );
        }
    }

    #[test]
    fn the_live_block_is_a_marker_and_a_dim_tail() {
        let rows = live_rows("weighing the options", &theme(), 40);
        assert_eq!(texts(&rows), ["∴ thinking", "  weighing the options"]);
        // Dim on every row: thinking must never look like the answer.
        for row in &rows {
            for span in &row.spans {
                assert!(span.style.modifiers.contains(Modifiers::DIM), "{row:?}");
            }
        }
        assert_ne!(rows[1].spans[1].style, theme().text());
    }

    #[test]
    fn an_empty_or_redacted_trace_renders_no_bare_marker() {
        assert!(live_rows("", &theme(), 40).is_empty());
        assert!(live_rows("   \n\n", &theme(), 40).is_empty());
    }

    #[test]
    fn the_live_tail_is_bounded_so_a_long_trace_cannot_own_the_region() {
        let long = (0..200)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let rows = live_rows(&long, &theme(), 40);
        assert_eq!(rows.len(), LIVE_ROWS + 1, "the marker plus a bounded tail");
        assert!(
            rows.last().unwrap().plain_text().contains("line 199"),
            "the tail is the newest end"
        );
    }

    #[test]
    fn the_committed_line_carries_the_duration_and_omits_what_it_does_not_know() {
        assert_eq!(
            collapsed_row(Some(23), &theme()).plain_text(),
            "∴ thought for 23s"
        );
        assert_eq!(collapsed_row(Some(95), &theme()).plain_text(), "∴ thought for 1m 35s");
        assert_eq!(collapsed_row(None, &theme()).plain_text(), "∴ thought");
    }

    #[test]
    fn the_full_form_is_the_one_liner_plus_the_trace() {
        let rows = full_rows("first thought\n\nsecond thought", Some(4), &theme(), 40);
        assert_eq!(
            texts(&rows),
            ["∴ thought for 4s", "  first thought", "", "  second thought"]
        );
    }

    #[test]
    fn every_wrapped_row_fits_the_width_it_was_rendered_at() {
        let text = "a long deliberation that will certainly need wrapping somewhere along it";
        for width in [12u16, 20, 40] {
            for row in live_rows(text, &theme(), width) {
                assert!(row.width() <= usize::from(width), "width {width}: {row:?}");
            }
        }
    }

    #[test]
    fn the_live_buffer_keeps_its_newest_end() {
        let mut text: String = "0123456789".repeat(LIVE_CHARS);
        trim_live(&mut text);
        assert_eq!(text.chars().count(), LIVE_CHARS);
        assert!(text.ends_with('9'));
        let mut short = "short".to_owned();
        trim_live(&mut short);
        assert_eq!(short, "short");
    }

    #[test]
    fn the_marker_is_plain_unicode() {
        for ch in GLYPH.chars() {
            assert!(!('\u{E000}'..='\u{F8FF}').contains(&ch), "private-use glyph");
        }
    }
}
