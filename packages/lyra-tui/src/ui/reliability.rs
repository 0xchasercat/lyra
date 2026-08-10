//! Reliability surfaces — DESIGN.md §3, "never render nothing".
//!
//! > `⟳ rate limited · retry 2/8 · 4s` with a live 1 Hz countdown in the
//! > footer, escalating to full detail at attempt ≥4; `─ compacted · −38k
//! > tokens ─` boundary line; context-repair marker linking `/context`;
//! > loop-detection inline note; queue always visible while pending.
//!
//! # The rule these all serve
//!
//! Every pause has a bracket, and every bracket is visible. A harness that
//! stalls silently teaches you not to trust long turns; one that says *why* it
//! stalled, *how long* it has been stalling and *what it will do next* costs
//! one row and buys the opposite.
//!
//! # Escalation, and why it is not a spinner
//!
//! Attempts 1–3 get a one-liner: transient failures are normal and do not
//! deserve the screen. From attempt 4 the situation has stopped being routine —
//! the provider is not coming back on its own schedule — and the note expands
//! to name the classification, the ceiling, and how long the wait has run in
//! total. Nothing animates: the countdown is a *number that changes once a
//! second*, which is information, not motion (DESIGN.md §3, "zero decorative
//! motion").
//!
//! # Division of labour with the input layer
//!
//! The **footer slot** belongs to the input layer. This module renders the
//! transcript-level forms: the escalated block, and the inline note committed
//! to scrollback so the session's history shows the stall after the fact.
//! [`retry_line`] is shared so the two cannot word the same event differently.

use std::time::Duration;

use unicode_width::UnicodeWidthStr;

use crate::theme::Theme;
use crate::ui::{Row, Span};
use crate::vendor::flywheel::Modifiers;

/// The retry glyph. Pure Unicode, and a state marker rather than an animation.
pub const RETRY_GLYPH: &str = "⟳";
/// Attempt at which the note escalates to full detail.
pub const ESCALATE_AT: u32 = 4;
/// The boundary rule character.
const RULE: char = '─';

/// The working spinner's frames. Pure Unicode braille — no Nerd Font, and the
/// cell width never changes between frames.
pub const SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/// One spinner frame per clock tick: `main`'s `CLOCK_TICK` is 100 ms, so the
/// spinner advances exactly once per repaint while a turn is live.
pub const SPINNER_FRAME_MS: u64 = 100;

/// Whether a turn is running, and whether the daemon has reported trouble with
/// it.
///
/// The working indicator is the one deliberate exception to DESIGN.md §3's
/// zero-motion rule (owner decision, 2026-08-10): while a turn is running the
/// glyph spins, because "work is happening" is state the motion itself carries.
/// The motion is **continuous for as long as the turn runs** — it carries one
/// bit, "this turn is still ours", and nothing finer.
///
/// # Why the client no longer infers a stall (superseded rationale)
///
/// This type used to say the exception "stays honest by *stopping*": three
/// seconds in which nothing arrived froze the spinner and painted it amber. The
/// reasoning was sound and the premise was not. A model thinking silently for
/// forty seconds is an ordinary turn, not a hang, and this client cannot tell
/// the two apart — it holds no provider connection, no request deadline, and no
/// idea what the far end promised. Guessing after three seconds front-ran the
/// only party that *can* know, and the guess was wrong far more often than it
/// was right; a warning that cries wolf on healthy turns teaches exactly the
/// distrust it was built to prevent.
///
/// So the division is now clean: **the daemon owns stall truth, the client
/// renders it.** Motion means the turn is running. Colour means the daemon has
/// said something is wrong with it — today a retry ([`Retry`]), tomorrow a
/// provider-reported stall, which arrives as an ordinary retry update with a
/// phase-named classification and therefore needs no new state here.
///
/// The activity strip and footer belong to the input layer; this is the shared
/// vocabulary, so the two surfaces cannot disagree about what a turn is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    /// Nothing is running.
    Idle,
    /// A turn is running.
    Streaming,
    /// A turn is running and the daemon has reported trouble with it.
    Troubled,
}

impl Activity {
    /// Classify a turn.
    ///
    /// `streaming` is the only thing the spinner keys off: if a turn is running
    /// the glyph moves, full stop. `troubled` is the daemon's word rather than
    /// the client's guess — a retry in flight today. Nothing here consults a
    /// clock, which is the point: there is no elapsed time at which this client
    /// starts calling a running turn stuck.
    #[must_use]
    pub const fn of(streaming: bool, troubled: bool) -> Self {
        match (streaming, troubled) {
            (false, _) => Self::Idle,
            (true, false) => Self::Streaming,
            (true, true) => Self::Troubled,
        }
    }

    /// The state glyph. One character, never animated.
    #[must_use]
    pub const fn glyph(self) -> &'static str {
        match self {
            Self::Idle => "◆",
            Self::Streaming | Self::Troubled => "●",
        }
    }

    /// The state glyph at a moment in time: the spinner while a turn runs,
    /// the frozen [`Self::glyph`] when none does. `since_start` is any monotonic
    /// duration (the app's uptime); only its progression matters.
    ///
    /// A troubled turn spins too. A retry *is* the turn still running, and the
    /// countdown beside it is ticking; freezing the glyph next to a live
    /// countdown would have the surface contradicting the very pause it is
    /// explaining second by second.
    #[must_use]
    pub fn glyph_at(self, since_start: Duration) -> &'static str {
        match self {
            Self::Streaming | Self::Troubled => {
                let frame = (since_start.as_millis() / u128::from(SPINNER_FRAME_MS))
                    % SPINNER_FRAMES.len() as u128;
                SPINNER_FRAMES[frame as usize]
            }
            Self::Idle => self.glyph(),
        }
    }

    /// The style for that glyph.
    ///
    /// Colour is where trouble shows, and it is the one thing this state adds
    /// that the retry line does not: the line carries the detail (cause,
    /// attempt, countdown) and the strip carries the ambient state, at a cost of
    /// zero rows. Someone glancing at the composer learns "running, but not
    /// well" without reading anything.
    #[must_use]
    pub fn style(self, theme: &Theme) -> crate::ui::Style {
        match self {
            Self::Idle => theme.faint(),
            Self::Streaming => theme.accent(),
            // Towards error, not *at* it: the turn has not failed, it is in
            // trouble the daemon expects to come back from.
            Self::Troubled => theme.warning(),
        }
    }
}

/// Everything known about the current retry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Retry {
    /// 1-based attempt.
    pub attempt: u32,
    /// Attempt ceiling.
    pub max_attempts: u32,
    /// Provider classification (`rate_limit`, `overloaded`, …) when the daemon
    /// supplied one. Absent means "we do not know", and the surface says so
    /// rather than inventing a cause.
    pub classification: Option<String>,
    /// Seconds until the next attempt, when the daemon supplied a deadline.
    pub seconds_remaining: Option<u64>,
    /// Total seconds spent retrying this turn.
    pub elapsed_seconds: Option<u64>,
}

impl Retry {
    /// Whether the attempt count has crossed [`ESCALATE_AT`].
    #[must_use]
    pub const fn escalated(&self) -> bool {
        self.attempt >= ESCALATE_AT
    }

    /// Human classification, never empty.
    ///
    /// A provider classification is a wire enum (`rate_limit`); the transcript
    /// is prose. The table below covers the classifications the provider layer
    /// emits; anything else degrades to the identifier with its underscores
    /// removed, which reads badly but reads.
    #[must_use]
    pub fn reason(&self) -> String {
        let Some(raw) = &self.classification else {
            return "retrying".to_owned();
        };
        match raw.as_str() {
            "rate_limit" => "rate limited",
            "overloaded" => "provider overloaded",
            "timeout" => "timed out",
            "network" => "network error",
            "server_error" => "server error",
            "context_length" => "context too long",
            other => return other.replace('_', " "),
        }
        .to_owned()
    }
}

/// The one-line form: `⟳ rate limited · retry 2/8 · 4s`.
///
/// Shared with the footer so the transcript and the chrome cannot disagree
/// about what is happening.
#[must_use]
pub fn retry_line(retry: &Retry, theme: &Theme) -> Row {
    let mut parts = vec![retry.reason(), format!("retry {}/{}", retry.attempt, retry.max_attempts)];
    if let Some(seconds) = retry.seconds_remaining {
        parts.push(format!("{seconds}s"));
    }
    let style = if retry.escalated() {
        theme.warning()
    } else {
        theme.muted()
    };
    Row {
        spans: vec![
            Span::new(format!("{RETRY_GLYPH} "), style),
            Span::new(parts.join(" · "), style),
        ],
    }
}

/// The transcript-level form.
///
/// One row below [`ESCALATE_AT`]; from there, the detail a user needs to decide
/// whether to wait or cancel.
#[must_use]
pub fn retry_rows(retry: &Retry, theme: &Theme) -> Vec<Row> {
    let mut rows = vec![retry_line(retry, theme)];
    if !retry.escalated() {
        return rows;
    }
    let mut detail = vec![format!(
        "attempt {} of {}",
        retry.attempt, retry.max_attempts
    )];
    if let Some(elapsed) = retry.elapsed_seconds {
        detail.push(format!("waiting {}", duration(elapsed)));
    }
    match &retry.classification {
        Some(classification) => detail.push(format!("provider says {classification}")),
        // "never render nothing", stated honestly: an unknown cause is
        // information, and pretending to one would be worse.
        None => detail.push("cause not reported".to_owned()),
    }
    rows.push(Row {
        spans: vec![
            Span::new("  ", theme.faint()),
            Span::new(detail.join(" · "), theme.muted()),
        ],
    });
    rows.push(Row {
        spans: vec![
            Span::new("  ", theme.faint()),
            Span::new("esc cancels · partial output is kept", theme.faint()),
        ],
    });
    rows
}

/// The compaction boundary: `─── compacted · −38k tokens ───`.
///
/// Committed to scrollback, so scrolling back through a long session shows
/// exactly where the model stopped being able to see.
#[must_use]
pub fn compaction_boundary(token_delta: i64, first_kept: Option<usize>, theme: &Theme, width: u16) -> Row {
    let mut label = format!("compacted · −{}", compact_tokens(token_delta.unsigned_abs()));
    label.push_str(" tokens");
    if let Some(first) = first_kept {
        label.push_str(&format!(" · kept from #{first}"));
    }
    rule_row(&label, theme, width)
}

/// A `─── label ───` rule filling the width.
///
/// A label wider than the terminal loses its rule and then its tail, with a
/// visible `…` — DESIGN.md §3's "width degradation leaves a visible `…`". The
/// row is exactly `width` columns whenever the label fits, so a boundary reads
/// as a boundary rather than as a fragment.
#[must_use]
pub fn rule_row(label: &str, theme: &Theme, width: u16) -> Row {
    let width = usize::from(width).max(1);
    let mut label = format!(" {label} ");
    if label.width() > width {
        let mut trimmed = String::new();
        let mut used = 0usize;
        for ch in label.chars() {
            let advance = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(1).max(1);
            if used + advance + 1 > width {
                break;
            }
            trimmed.push(ch);
            used += advance;
        }
        trimmed.push('…');
        return Row {
            spans: vec![Span::new(trimmed, theme.muted())],
        };
    }
    let slack = width - label.width();
    let left = slack / 2;
    let right = slack - left;
    label.shrink_to_fit();
    Row {
        spans: vec![
            Span::new(RULE.to_string().repeat(left), theme.faint()),
            Span::new(label, theme.muted()),
            Span::new(RULE.to_string().repeat(right), theme.faint()),
        ],
    }
}

/// The context-repair marker.
///
/// Names the repair and points at `/context`, because "something was repaired"
/// with no way to look is worse than silence.
#[must_use]
pub fn context_repair(detail: &str, theme: &Theme) -> Row {
    let detail = if detail.trim().is_empty() {
        "context repaired".to_owned()
    } else {
        format!("context repaired · {detail}")
    };
    Row {
        spans: vec![
            Span::new("◆ ", theme.warning()),
            Span::new(detail, theme.muted()),
            Span::new("  /context", theme.faint()),
        ],
    }
}

/// The loop-detection note. Inline, not a modal (DESIGN.md §3).
#[must_use]
pub fn loop_warning(detail: &str, theme: &Theme) -> Row {
    Row {
        spans: vec![
            Span::new("◆ ", theme.warning()),
            Span::new(
                if detail.trim().is_empty() {
                    "loop detected".to_owned()
                } else {
                    format!("loop detected · {detail}")
                },
                theme.warning(),
            ),
        ],
    }
}

/// The transport-fallback one-liner. Noted once, dim, and never again.
#[must_use]
pub fn transport_fallback(from: &str, to: &str, reason: Option<&str>, theme: &Theme) -> Row {
    let mut text = format!("transport · {from} → {to}");
    if let Some(reason) = reason.filter(|reason| !reason.trim().is_empty()) {
        text.push_str(&format!(" · {reason}"));
    }
    Row {
        spans: vec![
            Span::new("  ", theme.faint()),
            Span::new(text, theme.faint()),
        ],
    }
}

/// How a turn ended, for the marker committed under it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnEnd {
    /// The user cancelled; partial output is kept (DESIGN.md §0.2).
    Cancelled,
    /// The provider hit a length limit.
    Truncated,
    /// The model refused.
    Refusal,
    /// An error ended the turn.
    Failed,
}

impl TurnEnd {
    /// Classify a provider stop reason. `None` for an ordinary completion,
    /// which gets no marker at all — the transcript already shows it.
    #[must_use]
    pub fn from_stop_reason(reason: &str) -> Option<Self> {
        match reason {
            "cancelled" | "canceled" | "aborted" => Some(Self::Cancelled),
            "max_tokens" | "length" | "truncated" => Some(Self::Truncated),
            "refusal" | "content_filter" | "safety" => Some(Self::Refusal),
            "error" | "failed" => Some(Self::Failed),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled · partial output kept",
            Self::Truncated => "truncated · the reply hit the output limit",
            Self::Refusal => "refused · the model declined to answer",
            Self::Failed => "failed",
        }
    }
}

/// The dim marked line a non-ordinary turn end leaves behind.
#[must_use]
pub fn turn_end(end: TurnEnd, theme: &Theme) -> Row {
    let style = match end {
        TurnEnd::Failed => theme.error(),
        _ => theme.muted(),
    };
    Row {
        spans: vec![
            Span::new("· ", theme.faint()),
            Span::new(end.label().to_owned(), style),
        ],
    }
}

/// The session header, printed **once** into scrollback at session start.
///
/// DESIGN.md §3: "A one-line header prints once at session start into
/// scrollback (`lyra · project · branch · model · directory`) — no persistent
/// header row, no splash, no mascot, no tips."
///
/// The last field is `session/snapshot`'s `workspace`, which since the §10
/// redesign is the launch directory itself for a main session (and a workspace
/// path only for an isolated agent). It is a real path the user can `cd` into,
/// so it is printed **verbatim** — no `~` collapsing, no basename, no
/// abbreviation to a workspace name. Only the width degradation below touches
/// it, and that leaves the visible `…` DESIGN.md §3 requires.
#[must_use]
pub fn session_header(fields: &[&str], theme: &Theme, width: u16) -> Row {
    let mut spans = vec![Span::new(
        "lyra",
        theme.accent().with(Modifiers::BOLD),
    )];
    for field in fields.iter().filter(|field| !field.trim().is_empty()) {
        spans.push(Span::new(format!(" · {field}"), theme.muted()));
    }
    let mut row = Row { spans };
    // The header is one row by contract; a long workspace name truncates rather
    // than wrapping into a second row nobody asked for.
    let limit = usize::from(width).max(1);
    if row.width() > limit {
        let mut used = 0usize;
        let mut kept = Vec::new();
        for span in std::mem::take(&mut row.spans) {
            let mut text = String::new();
            for ch in span.text.chars() {
                if used + 2 > limit {
                    break;
                }
                text.push(ch);
                used += 1;
            }
            let complete = text.chars().count() == span.text.chars().count();
            if !text.is_empty() {
                kept.push(Span { text, ..span });
            }
            if !complete {
                break;
            }
        }
        kept.push(Span::new("…", theme.faint()));
        row.spans = kept;
    }
    row
}

/// A user message band: `> what the user said`.
#[must_use]
pub fn user_band(text: &str, theme: &Theme, width: u16) -> Vec<Row> {
    let style = theme.text();
    let marker = [Span::new("> ", theme.tokens.agent.style())];
    let continuation = [Span::new("  ", style)];
    let mut rows = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let spans = vec![Span::new(line.to_owned(), style)];
        let first: &[Span] = if index == 0 { &marker } else { &continuation };
        rows.extend(super::markdown::wrap_spans(
            spans,
            usize::from(width).max(1),
            first,
            &continuation,
        ));
    }
    if rows.is_empty() {
        rows.push(Row {
            spans: marker.to_vec(),
        });
    }
    // One breath between the prompt and what answers it: the band is committed
    // scrollback, so the gap must be part of the band itself or a purge replay
    // would lose it.
    rows.push(Row::default());
    rows
}

/// `38214` → `38k`, `900` → `900`, `2_400_000` → `2.4M`.
#[must_use]
pub fn compact_tokens(count: u64) -> String {
    match count {
        0..=999 => count.to_string(),
        1_000..=999_999 => format!("{}k", count / 1_000),
        _ => {
            let millions = count / 1_000_000;
            let tenths = (count % 1_000_000) / 100_000;
            if tenths == 0 {
                format!("{millions}M")
            } else {
                format!("{millions}.{tenths}M")
            }
        }
    }
}

/// `95` → `1m 35s`, `12` → `12s`.
#[must_use]
pub fn duration(seconds: u64) -> String {
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    let rest = seconds % 60;
    if rest == 0 {
        format!("{minutes}m")
    } else {
        format!("{minutes}m {rest}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme() -> Theme {
        Theme::lyra()
    }

    fn retry(attempt: u32) -> Retry {
        Retry {
            attempt,
            max_attempts: 8,
            classification: Some("rate_limit".to_owned()),
            seconds_remaining: Some(4),
            elapsed_seconds: Some(95),
        }
    }

    #[test]
    fn only_the_daemon_can_say_a_running_turn_is_in_trouble() {
        // The classification takes no clock and no local heuristic: a turn is
        // running or it is not, and it is troubled only because the daemon said
        // so. This is the whole superseded stall inference, stated as a test.
        assert_eq!(Activity::of(true, false), Activity::Streaming);
        assert_eq!(Activity::of(true, true), Activity::Troubled);
        for troubled in [false, true] {
            assert_eq!(Activity::of(false, troubled), Activity::Idle);
        }
    }

    #[test]
    fn trouble_is_a_colour_and_never_a_different_glyph() {
        let theme = theme();
        // The glyph does not change when the state does; only the colour does.
        assert_eq!(Activity::Streaming.glyph(), Activity::Troubled.glyph());
        assert_ne!(
            Activity::Streaming.style(&theme),
            Activity::Troubled.style(&theme)
        );
        assert_ne!(
            Activity::Troubled.style(&theme),
            theme.error(),
            "a retry is trouble, not failure"
        );
    }

    #[test]
    fn the_spinner_runs_continuously_for_as_long_as_the_turn_does() {
        // Motion carries exactly one bit — "a turn is running" — so it advances
        // with time in *both* running states and is frozen only when idle.
        for state in [Activity::Streaming, Activity::Troubled] {
            let early = state.glyph_at(Duration::from_millis(0));
            let later = state.glyph_at(Duration::from_millis(SPINNER_FRAME_MS));
            assert_ne!(early, later, "{state:?}: consecutive ticks are distinct frames");
            assert!(SPINNER_FRAMES.contains(&early) && SPINNER_FRAMES.contains(&later));
            // A full cycle returns to the first frame: the animation is
            // periodic, not a random flicker.
            let wrapped =
                state.glyph_at(Duration::from_millis(SPINNER_FRAME_MS * SPINNER_FRAMES.len() as u64));
            assert_eq!(early, wrapped, "{state:?}");
            // And it never stops on its own, however long the turn has run.
            for after in [Duration::from_secs(3), Duration::from_secs(600)] {
                assert!(
                    SPINNER_FRAMES.contains(&state.glyph_at(after)),
                    "{state:?} froze after {after:?}"
                );
            }
        }

        // Idle does not move, no matter how much time passes.
        for at in [0u64, 250, 999_999] {
            let at = Duration::from_millis(at);
            assert_eq!(Activity::Idle.glyph_at(at), Activity::Idle.glyph());
        }
    }

    #[test]
    fn every_activity_glyph_is_plain_unicode() {
        for state in [Activity::Idle, Activity::Streaming, Activity::Troubled] {
            for ch in state.glyph().chars() {
                assert!(
                    !('\u{E000}'..='\u{F8FF}').contains(&ch),
                    "{state:?} used a private-use codepoint"
                );
            }
        }
    }

    #[test]
    fn the_retry_line_is_the_design_document_line() {
        assert_eq!(
            retry_line(&retry(2), &theme()).plain_text(),
            "⟳ rate limited · retry 2/8 · 4s"
        );
    }

    #[test]
    fn an_unclassified_retry_says_so_rather_than_inventing_a_cause() {
        let mut retry = retry(1);
        retry.classification = None;
        assert_eq!(retry_line(&retry, &theme()).plain_text(), "⟳ retrying · retry 1/8 · 4s");
    }

    #[test]
    fn a_retry_with_no_deadline_omits_the_countdown_instead_of_guessing() {
        let mut retry = retry(1);
        retry.seconds_remaining = None;
        assert_eq!(
            retry_line(&retry, &theme()).plain_text(),
            "⟳ rate limited · retry 1/8"
        );
    }

    #[test]
    fn the_first_three_attempts_stay_one_row() {
        for attempt in 1..ESCALATE_AT {
            assert_eq!(retry_rows(&retry(attempt), &theme()).len(), 1, "attempt {attempt}");
        }
    }

    #[test]
    fn the_fourth_attempt_escalates_to_full_detail() {
        let rows: Vec<String> = retry_rows(&retry(4), &theme())
            .iter()
            .map(Row::plain_text)
            .collect();
        assert_eq!(rows.len(), 3);
        assert!(rows[1].contains("attempt 4 of 8"), "{rows:?}");
        assert!(rows[1].contains("waiting 1m 35s"), "{rows:?}");
        assert!(rows[1].contains("rate_limit"), "{rows:?}");
        assert!(rows[2].contains("esc cancels"), "{rows:?}");
    }

    #[test]
    fn an_escalated_retry_with_no_classification_still_says_something() {
        let mut retry = retry(6);
        retry.classification = None;
        let rows: Vec<String> = retry_rows(&retry, &theme())
            .iter()
            .map(Row::plain_text)
            .collect();
        assert!(rows[1].contains("cause not reported"), "{rows:?}");
    }

    #[test]
    fn escalation_changes_colour_as_well_as_length() {
        let theme = theme();
        assert_eq!(retry_line(&retry(2), &theme).spans[0].style, theme.muted());
        assert_eq!(retry_line(&retry(4), &theme).spans[0].style, theme.warning());
    }

    #[test]
    fn the_compaction_boundary_fills_the_width_and_carries_the_delta() {
        let row = compaction_boundary(-38_214, None, &theme(), 40);
        let text = row.plain_text();
        assert_eq!(row.width(), 40);
        assert!(text.contains("compacted · −38k tokens"), "{text:?}");
        assert!(text.starts_with('─') && text.ends_with('─'), "{text:?}");
    }

    #[test]
    fn the_boundary_survives_a_narrow_terminal() {
        for width in [4u16, 10, 20, 60] {
            let row = compaction_boundary(-38_214, Some(12), &theme(), width);
            assert!(
                row.width() <= usize::from(width),
                "width {width}: {:?}",
                row.plain_text()
            );
        }
        assert!(compaction_boundary(-38_214, Some(12), &theme(), 20)
            .plain_text()
            .ends_with('…'));
    }

    #[test]
    fn token_counts_compact_without_lying_about_precision() {
        assert_eq!(compact_tokens(0), "0");
        assert_eq!(compact_tokens(999), "999");
        assert_eq!(compact_tokens(38_214), "38k");
        assert_eq!(compact_tokens(2_400_000), "2.4M");
        assert_eq!(compact_tokens(3_000_000), "3M");
    }

    #[test]
    fn durations_read_as_durations() {
        assert_eq!(duration(0), "0s");
        assert_eq!(duration(59), "59s");
        assert_eq!(duration(60), "1m");
        assert_eq!(duration(95), "1m 35s");
    }

    #[test]
    fn the_context_repair_marker_points_at_where_to_look() {
        let text = context_repair("dropped 2 orphaned tool results", &theme()).plain_text();
        assert!(text.contains("context repaired"), "{text:?}");
        assert!(text.contains("/context"), "{text:?}");
    }

    #[test]
    fn an_empty_repair_detail_still_renders_a_marker() {
        assert!(context_repair("", &theme()).plain_text().contains("context repaired"));
    }

    #[test]
    fn the_loop_warning_is_a_line_not_a_modal() {
        let rows = loop_warning("same edit 3 times", &theme());
        assert_eq!(rows.plain_text(), "◆ loop detected · same edit 3 times");
    }

    #[test]
    fn the_transport_fallback_is_one_faint_line() {
        let theme = theme();
        let row = transport_fallback("websocket", "http", Some("handshake failed"), &theme);
        assert_eq!(
            row.plain_text(),
            "  transport · websocket → http · handshake failed"
        );
        assert!(row.spans[1].style.modifiers.contains(Modifiers::DIM));
    }

    #[test]
    fn stop_reasons_map_to_markers_and_ordinary_completion_gets_none() {
        assert_eq!(TurnEnd::from_stop_reason("end_turn"), None);
        assert_eq!(TurnEnd::from_stop_reason("cancelled"), Some(TurnEnd::Cancelled));
        assert_eq!(TurnEnd::from_stop_reason("max_tokens"), Some(TurnEnd::Truncated));
        assert_eq!(TurnEnd::from_stop_reason("refusal"), Some(TurnEnd::Refusal));
    }

    #[test]
    fn a_cancelled_turn_says_partial_output_is_kept() {
        let text = turn_end(TurnEnd::Cancelled, &theme()).plain_text();
        assert!(text.contains("cancelled"), "{text:?}");
        assert!(text.contains("partial output kept"), "{text:?}");
    }

    #[test]
    fn only_a_failed_turn_end_uses_the_error_colour() {
        let theme = theme();
        assert_eq!(turn_end(TurnEnd::Failed, &theme).spans[1].style, theme.error());
        assert_eq!(turn_end(TurnEnd::Truncated, &theme).spans[1].style, theme.muted());
    }

    #[test]
    fn the_session_header_is_the_design_document_line() {
        let row = session_header(&["lyra", "main", "opus-5", "purple-falcon"], &theme(), 80);
        assert_eq!(row.plain_text(), "lyra · lyra · main · opus-5 · purple-falcon");
    }

    #[test]
    fn the_session_header_skips_fields_it_does_not_have() {
        let row = session_header(&["lyra", "", "opus-5", ""], &theme(), 80);
        assert_eq!(row.plain_text(), "lyra · lyra · opus-5");
    }

    #[test]
    fn the_session_header_truncates_rather_than_becoming_two_rows() {
        let row = session_header(&["a-very-long-project-name", "a-long-branch"], &theme(), 20);
        assert!(row.width() <= 20, "{:?}", row.plain_text());
        assert!(row.plain_text().ends_with('…'));
    }

    #[test]
    fn a_user_band_marks_only_its_first_row() {
        let rows: Vec<String> = user_band("alpha beta gamma delta", &theme(), 14)
            .iter()
            .map(Row::plain_text)
            .collect();
        // The trailing blank is the band's own breathing room before whatever
        // answers it — part of the band so a purge replay keeps the rhythm.
        assert_eq!(rows, ["> alpha beta", "  gamma delta", ""]);
    }

    #[test]
    fn a_multi_line_user_message_keeps_its_own_breaks() {
        let rows: Vec<String> = user_band("first\nsecond", &theme(), 40)
            .iter()
            .map(Row::plain_text)
            .collect();
        assert_eq!(rows, ["> first", "  second", ""]);
    }

    #[test]
    fn an_empty_user_message_still_renders_its_marker() {
        let rows = user_band("", &theme(), 40);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].plain_text(), "");
    }
}
