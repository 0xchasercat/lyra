//! The footer: model · context · cost · retry (DESIGN.md §3).
//!
//! # Raw measurements, derived percentages, and nothing invented
//!
//! DESIGN.md §2 is categorical: "Raw measurements over the wire — token counts
//! as numbers, percentages derived client-side, **absent limit ⇒ render nothing
//! rather than a wrong number**." So [`FooterData::context_limit`] being `None`
//! does not mean "assume 200k"; it means the footer prints `24.1k tokens` and
//! stops. A percentage against a guessed denominator is worse than no
//! percentage, because the user believes it.
//!
//! # Fixed height, degrade by priority
//!
//! The footer is exactly one row, always. DESIGN.md §3's anti-jitter rule —
//! "fixed-height chrome rows that never collapse 0↔1" — means an empty footer is
//! a blank row, not an absent one, so nothing below the transcript ever shifts.
//!
//! When the row does not fit, fields are dropped **lowest priority first** and a
//! visible `…` is appended, per "width degradation leaves a visible `…`". The
//! priorities encode what a user needs when the terminal is 40 columns wide:
//!
//! | field | priority | why |
//! |---|---|---|
//! | retry | 100 | something is wrong *right now* and there is a countdown |
//! | model | 80 | which model is spending your money |
//! | context | 60 | how close the session is to compaction |
//! | cost | 40 | useful, but the least urgent |

use unicode_width::UnicodeWidthStr;

use crate::theme::Theme;
use crate::ui::{Row, Span, Style};

/// A retry in progress (DESIGN.md §3: `⟳ rate limited · retry 2/8 · 4s`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryStatus {
    /// Raw classification from the daemon, when there was one.
    pub reason: Option<String>,
    /// 1-based attempt.
    pub attempt: u32,
    /// Attempt ceiling.
    pub max_attempts: u32,
    /// Whole seconds until the next attempt, recomputed by the caller at 1 Hz.
    pub seconds_remaining: Option<u64>,
}

/// Everything the footer draws.
///
/// Every field is optional because every one of them is genuinely unknown at
/// some point in a session, and "unknown" must render as absence rather than as
/// a zero.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FooterData {
    /// Model identifier, as the daemon spells it.
    pub model: Option<String>,
    /// Tokens currently in context.
    pub context_used: Option<u64>,
    /// Context window size, when the provider reported one.
    pub context_limit: Option<u64>,
    /// Session cost in USD cents. Integer cents, not floats: money that is
    /// summed across a long session must not drift.
    pub cost_cents: Option<u64>,
    /// A retry in flight.
    pub retry: Option<RetryStatus>,
}

/// Where the footer's numbers come from.
///
/// The seam with the session store. Phase 3 owns the store; this trait is the
/// only thing the footer knows about it, so the two can be built in parallel and
/// the store can change shape without touching this file.
pub trait FooterSource {
    /// A snapshot for this frame.
    fn footer(&self) -> FooterData;
}

impl FooterSource for FooterData {
    fn footer(&self) -> Self {
        self.clone()
    }
}

/// Render the footer. Always exactly one row.
#[must_use]
pub fn render(theme: &Theme, data: &FooterData, width: u16) -> Row {
    let width = width as usize;
    let mut fields: Vec<(u8, Vec<Span>)> = Vec::new();

    if let Some(retry) = &data.retry {
        fields.push((100, retry_spans(theme, retry)));
    }
    if let Some(model) = &data.model {
        fields.push((80, vec![Span::new(model.clone(), theme.muted())]));
    }
    if let Some(context) = context_text(data) {
        fields.push((60, vec![Span::new(context, theme.muted())]));
    }
    if let Some(cents) = data.cost_cents {
        fields.push((40, vec![Span::new(money(cents), theme.muted())]));
    }

    if fields.is_empty() {
        // Fixed height: a blank row, never a missing one.
        return Row::blank();
    }

    let mut dropped = false;
    loop {
        let row = join(theme, &fields, dropped);
        if row.width() <= width || fields.len() == 1 {
            return clip(row, width);
        }
        // Drop the lowest-priority field and try again.
        let lowest = fields
            .iter()
            .enumerate()
            .min_by_key(|(_, (priority, _))| *priority)
            .map(|(index, _)| index);
        match lowest {
            Some(index) => {
                fields.remove(index);
                dropped = true;
            }
            None => return Row::blank(),
        }
    }
}

fn join(theme: &Theme, fields: &[(u8, Vec<Span>)], dropped: bool) -> Row {
    let mut spans = Vec::new();
    for (index, (_, field)) in fields.iter().enumerate() {
        if index > 0 {
            spans.push(Span::new(" · ", theme.faint()));
        }
        spans.extend(field.iter().cloned());
    }
    if dropped {
        spans.push(Span::new(" …", theme.faint()));
    }
    Row { spans }
}

fn clip(row: Row, width: usize) -> Row {
    if row.width() <= width {
        return row;
    }
    let mut spans: Vec<Span> = Vec::new();
    let mut used = 0usize;
    let budget = width.saturating_sub(1);
    for span in row.spans {
        if used >= budget {
            break;
        }
        let text = truncate(&span.text, budget - used);
        used += UnicodeWidthStr::width(text.as_str());
        spans.push(Span::new(text, span.style));
    }
    spans.push(Span::new("…", Style::dim()));
    Row { spans }
}

fn retry_spans(theme: &Theme, retry: &RetryStatus) -> Vec<Span> {
    let RetryStatus {
        reason,
        attempt,
        max_attempts,
        seconds_remaining,
    } = retry;
    // DESIGN.md §3: escalate to full detail at attempt ≥ 4. Below that the
    // classification is noise; above it, the user is deciding whether to wait.
    let label = reason.as_deref().unwrap_or("retrying");
    let mut text = if *attempt >= 4 {
        format!("⟳ {label} · retry {attempt}/{max_attempts}")
    } else {
        format!("⟳ retry {attempt}/{max_attempts}")
    };
    if let Some(seconds) = seconds_remaining {
        text.push_str(&format!(" · {seconds}s"));
    }
    let style = if *attempt >= 4 {
        theme.error()
    } else {
        theme.warning()
    };
    vec![Span::new(text, style)]
}

/// Context as raw numbers, with a percentage only when a real limit exists.
fn context_text(data: &FooterData) -> Option<String> {
    let used = data.context_used?;
    Some(match data.context_limit {
        Some(limit) if limit > 0 => {
            let percent = (used.saturating_mul(100) / limit).min(999);
            format!("{}/{} · {percent}%", tokens(used), tokens(limit))
        }
        // No limit reported: the raw number and nothing more.
        _ => format!("{} tokens", tokens(used)),
    })
}

/// Compact token counts: `812`, `24.1k`, `1.2M`.
fn tokens(count: u64) -> String {
    if count < 1000 {
        return count.to_string();
    }
    if count < 1_000_000 {
        let whole = count / 1000;
        let tenth = (count % 1000) / 100;
        return if whole >= 100 || tenth == 0 {
            format!("{whole}k")
        } else {
            format!("{whole}.{tenth}k")
        };
    }
    let whole = count / 1_000_000;
    let tenth = (count % 1_000_000) / 100_000;
    if tenth == 0 {
        format!("{whole}M")
    } else {
        format!("{whole}.{tenth}M")
    }
}

/// Integer cents as dollars, with sub-cent sessions rendered honestly.
fn money(cents: u64) -> String {
    format!("${}.{:02}", cents / 100, cents % 100)
}

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

    fn full() -> FooterData {
        FooterData {
            model: Some("claude-opus-5".to_owned()),
            context_used: Some(24_137),
            context_limit: Some(200_000),
            cost_cents: Some(342),
            retry: None,
        }
    }

    fn text(data: &FooterData, width: u16) -> String {
        render(&Theme::lyra(), data, width).plain_text()
    }

    #[test]
    fn a_full_footer_reads_left_to_right_by_priority() {
        assert_eq!(
            text(&full(), 80),
            "claude-opus-5 · 24.1k/200k · 12% · $3.42"
        );
    }

    #[test]
    fn an_unknown_limit_prints_the_raw_number_and_no_percentage() {
        let data = FooterData {
            context_limit: None,
            ..full()
        };
        let rendered = text(&data, 80);
        assert!(rendered.contains("24.1k tokens"), "{rendered}");
        assert!(
            !rendered.contains('%'),
            "a percentage against a guessed denominator is a lie: {rendered}"
        );
    }

    #[test]
    fn an_empty_footer_is_a_blank_row_not_a_missing_one() {
        let row = render(&Theme::lyra(), &FooterData::default(), 80);
        assert_eq!(row.plain_text(), "");
        assert_eq!(
            render(&Theme::lyra(), &FooterData::default(), 80),
            Row::blank()
        );
    }

    #[test]
    fn the_footer_is_always_exactly_one_row() {
        // Nothing in this module can return more than one `Row`; the type says
        // so. This test exists so a future refactor to `Vec<Row>` fails here.
        let row: Row = render(&Theme::lyra(), &full(), 80);
        assert!(!row.plain_text().contains('\n'));
    }

    #[test]
    fn a_retry_takes_the_highest_priority_slot() {
        let data = FooterData {
            retry: Some(RetryStatus {
                reason: Some("rate limited".to_owned()),
                attempt: 2,
                max_attempts: 8,
                seconds_remaining: Some(4),
            }),
            ..full()
        };
        let rendered = text(&data, 80);
        assert!(rendered.starts_with("⟳ retry 2/8 · 4s"), "{rendered}");
    }

    #[test]
    fn a_retry_escalates_to_full_detail_at_attempt_four() {
        let retry = |attempt| FooterData {
            retry: Some(RetryStatus {
                reason: Some("rate limited".to_owned()),
                attempt,
                max_attempts: 8,
                seconds_remaining: Some(4),
            }),
            ..FooterData::default()
        };
        assert_eq!(text(&retry(3), 80), "⟳ retry 3/8 · 4s");
        assert_eq!(text(&retry(4), 80), "⟳ rate limited · retry 4/8 · 4s");
    }

    #[test]
    fn the_countdown_slot_disappears_cleanly_when_there_is_no_deadline() {
        let data = FooterData {
            retry: Some(RetryStatus {
                reason: None,
                attempt: 1,
                max_attempts: 3,
                seconds_remaining: None,
            }),
            ..FooterData::default()
        };
        assert_eq!(text(&data, 80), "⟳ retry 1/3");
    }

    #[test]
    fn narrowing_drops_the_lowest_priority_field_and_says_so() {
        let data = full();
        let wide = text(&data, 80);
        assert!(!wide.contains('…'));

        let narrow = text(&data, 34);
        assert!(narrow.contains('…'), "{narrow}");
        assert!(!narrow.contains("$3.42"), "cost sheds first: {narrow}");
        assert!(narrow.contains("claude-opus-5"), "{narrow}");
    }

    #[test]
    fn a_retry_survives_a_narrowing_that_removes_everything_else() {
        let data = FooterData {
            retry: Some(RetryStatus {
                reason: Some("overloaded".to_owned()),
                attempt: 5,
                max_attempts: 8,
                seconds_remaining: Some(12),
            }),
            ..full()
        };
        let narrow = text(&data, 32);
        assert!(narrow.starts_with('⟳'), "{narrow}");
    }

    #[test]
    fn no_width_makes_the_footer_overflow() {
        let data = FooterData {
            retry: Some(RetryStatus {
                reason: Some("a very long classification indeed".to_owned()),
                attempt: 7,
                max_attempts: 8,
                seconds_remaining: Some(120),
            }),
            ..full()
        };
        for width in 4u16..=100 {
            let row = render(&Theme::lyra(), &data, width);
            assert!(
                row.width() <= width as usize,
                "width {width}: {:?}",
                row.plain_text()
            );
        }
    }

    #[test]
    fn token_counts_are_compact_and_never_rounded_up_into_a_lie() {
        assert_eq!(tokens(0), "0");
        assert_eq!(tokens(999), "999");
        assert_eq!(tokens(1000), "1k");
        assert_eq!(tokens(1449), "1.4k");
        assert_eq!(tokens(24_137), "24.1k");
        assert_eq!(tokens(200_000), "200k");
        assert_eq!(tokens(1_250_000), "1.2M");
    }

    #[test]
    fn money_is_integer_cents_so_a_long_session_cannot_drift() {
        assert_eq!(money(0), "$0.00");
        assert_eq!(money(5), "$0.05");
        assert_eq!(money(342), "$3.42");
        assert_eq!(money(100_000), "$1000.00");
    }
}
