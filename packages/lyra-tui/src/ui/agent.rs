//! Spawned children, on screen — LYRA.md §19's presence dots, made concrete.
//!
//! Two surfaces, one vocabulary, and they are deliberately different things:
//!
//! 1. **The presence strip** ([`strip`]) — one chrome row above the composer,
//!    a dot per live child. It answers *what is running right now*, and it is
//!    the only place that answer lives: nothing about a child streams into the
//!    transcript while it works, because a swarm of six children each reporting
//!    every tool call would bury the conversation they were spawned to serve.
//!
//! 2. **Lifecycle rows** ([`event_row`], [`collapse`]) — dim one-line audit
//!    entries committed to scrollback for the transitions that are *history*:
//!    a child appeared, a child finished, a child failed. Not a row per state
//!    change; three moments per child, at most.
//!
//! # Which transitions earn a row
//!
//! Appearing, finishing and failing. `running` and `awaiting_tool` are the
//! strip's business — they are the present tense, and the present tense belongs
//! in the live region, not in an immutable log. This split is the same one the
//! tool grammar makes between the activity strip and the collapsed `▸` row.
//!
//! # Collapsing
//!
//! [`collapse`] is [`crate::ui::tool_row::collapse_run`]'s argument applied to
//! children: a fan-out of twelve agents produces twelve `◎ spawned …` rows, and
//! twelve rows about *setting up to do work* is scrollback spent on bookkeeping.
//! Consecutive transitions collapse to one line with honest counts, exactly as a
//! run of reads does.
//!
//! # Anti-jitter
//!
//! The strip is chrome, and DESIGN.md §3 forbids chrome that collapses 0↔1
//! mid-stream. The rule lives with the caller ([`crate::app::App`]) because it
//! is about *when* to draw, not what: the row grows the live region the moment a
//! child appears — that is information arriving — and only ever shrinks at a
//! turn boundary. A child that finishes mid-turn keeps its `✓` for
//! [`SETTLED_LINGER`] and then leaves the row, but the row itself stays.

use std::time::Duration;

use unicode_width::UnicodeWidthStr;

use crate::acp::types::AgentState;
use crate::theme::Theme;
use crate::ui::{Row, Span};

/// How long a finished child keeps its `✓` in the strip before it is dropped.
///
/// Long enough to read (DESIGN.md §3's ≥700ms floor for a transient), short
/// enough that a strip of ticks does not outlive the work it is reporting.
pub const SETTLED_LINGER: Duration = Duration::from_millis(2500);

/// How many named children the strip shows before it counts the rest.
///
/// A swarm is a real shape — twenty children is a fan-out, not a bug — and
/// twenty names do not fit on a row. Four names plus an honest `+16` says more
/// than sixteen truncated names would.
pub const MAX_NAMED: usize = 4;

/// Whether a child has stopped moving, and is therefore on its way out of the
/// strip and into history.
///
/// The single definition of "settled". It lives here rather than beside its
/// caller because two files that each decided for themselves which states are
/// terminal is how a child ends up ticked in the strip and unfinished in the
/// audit row.
#[must_use]
pub const fn is_settled(state: &AgentState) -> bool {
    matches!(
        state,
        AgentState::Completed
            | AgentState::Failed
            | AgentState::TimedOut
            | AgentState::Cancelled
    )
}

/// One child, as the strip draws it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Presence {
    /// The bus name it answers to — what a `/kill` or a hub message addresses.
    pub name: String,
    /// Where it is in its life.
    pub state: AgentState,
}

impl Presence {
    /// The dot. Filled while it is the model's, hollow while it waits.
    #[must_use]
    pub const fn glyph(&self) -> &'static str {
        match self.state {
            AgentState::Running => "◎",
            AgentState::AwaitingTool => "◍",
            AgentState::Completed => "✓",
            AgentState::Failed | AgentState::TimedOut | AgentState::Cancelled => "✗",
            // Queued, starting, and a state a newer daemon invents: accepted but
            // not yet the model's.
            _ => "○",
        }
    }

    /// Whether the child is waiting rather than working — the ones the strip
    /// counts instead of naming when the row runs out of room.
    #[must_use]
    pub const fn is_queued(&self) -> bool {
        matches!(self.state, AgentState::Queued | AgentState::Starting)
    }
}

/// The presence strip. Empty when there are no children: the caller decides
/// *when* a row may vanish, this decides whether there is one to draw.
///
/// Degrades by dropping names, never by lying about the count: the trailing
/// `+N` grows as names are shed, so the total on the row is always the total in
/// the session.
#[must_use]
pub fn strip(theme: &Theme, agents: &[Presence], width: u16) -> Option<Row> {
    if agents.is_empty() {
        return None;
    }
    let budget = usize::from(width.max(8));
    // Named first, in the order they were spawned; the ones merely waiting are
    // the least interesting thing on the row, so they are what becomes a count.
    let (waiting, active): (Vec<&Presence>, Vec<&Presence>) =
        agents.iter().partition(|agent| agent.is_queued());

    for named in (0..=active.len().min(MAX_NAMED)).rev() {
        let mut spans = vec![Span::new("  ", theme.faint())];
        for agent in active.iter().take(named) {
            spans.push(Span::new(format!("{} ", agent.glyph()), state_style(agent, theme)));
            spans.push(Span::new(format!("{} ", agent.name), theme.muted()));
        }
        let hidden = active.len() - named;
        if hidden > 0 {
            spans.push(Span::new("◎ ", theme.accent()));
            spans.push(Span::new(format!("{hidden} more "), theme.muted()));
        }
        if !waiting.is_empty() {
            spans.push(Span::new("○ ", theme.faint()));
            spans.push(Span::new(format!("{} queued", waiting.len()), theme.faint()));
        }
        let row = Row { spans };
        if row.width() <= budget {
            return Some(trimmed(row));
        }
    }
    // Nothing fits, not even one name: say how many there are, which is the one
    // fact worth a row at any width.
    Some(clip_row(
        Row {
            spans: vec![
                Span::new("  ◎ ", theme.accent()),
                Span::new(format!("{} agents", agents.len()), theme.muted()),
            ],
        },
        budget,
    ))
}

/// Drop the trailing space the loop above leaves on every row it builds.
fn trimmed(mut row: Row) -> Row {
    if let Some(last) = row.spans.last_mut() {
        while last.text.ends_with(' ') {
            last.text.pop();
        }
    }
    row
}

fn clip_row(row: Row, budget: usize) -> Row {
    if row.width() <= budget {
        return row;
    }
    let mut used = 0usize;
    let mut spans = Vec::new();
    for span in row.spans {
        let mut text = String::new();
        for grapheme in unicode_segmentation::UnicodeSegmentation::graphemes(span.text.as_str(), true)
        {
            let advance = UnicodeWidthStr::width(grapheme).max(1);
            if used + advance > budget {
                break;
            }
            text.push_str(grapheme);
            used += advance;
        }
        if !text.is_empty() {
            spans.push(Span { text, ..span });
        }
        if used >= budget {
            break;
        }
    }
    Row { spans }
}

fn state_style(agent: &Presence, theme: &Theme) -> crate::ui::Style {
    match agent.state {
        AgentState::Running => theme.accent(),
        // Dim-accent: inside a tool call is still working, but it is the tool's
        // time rather than the model's, and the strip says so without shouting.
        AgentState::AwaitingTool => theme.agent(),
        AgentState::Completed => theme.text(),
        AgentState::Failed | AgentState::TimedOut | AgentState::Cancelled => theme.error(),
        _ => theme.faint(),
    }
}

// ---------------------------------------------------------------------------
// Lifecycle rows
// ---------------------------------------------------------------------------

/// The moments in a child's life that belong in scrollback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    /// It appeared.
    Spawned,
    /// A child that had stopped is running again.
    ///
    /// Its own moment rather than a second `Spawned`, because a revival is the
    /// only reason a child can produce two `Finished` rows in one session, and a
    /// reader who never saw *why* it ran twice has no way to account for the
    /// second one. It is also the only resume primitive the bus has.
    Revived,
    /// It finished with a result.
    Finished,
    /// It failed, timed out, or was cancelled.
    Failed,
}

impl EventKind {
    const fn glyph(self) -> &'static str {
        match self {
            Self::Spawned => "◎",
            Self::Revived => "↻",
            Self::Finished => "✓",
            Self::Failed => "✗",
        }
    }
}

/// One transition, ready to be a row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentEvent {
    /// Which moment.
    pub kind: EventKind,
    /// The bus name — authoritative, because it is what a message is addressed
    /// to.
    pub name: String,
    /// What is worth saying about it: the model it runs on, what it changed, why
    /// it stopped. Empty when the daemon measured nothing, which renders as
    /// absence rather than as a zero.
    pub detail: String,
}

/// One lifecycle row: `◎ spawned activity-module · gpt-5.6-terra`.
#[must_use]
pub fn event_row(event: &AgentEvent, theme: &Theme, width: u16) -> Row {
    let style = match event.kind {
        EventKind::Failed => theme.error(),
        _ => theme.faint(),
    };
    let mut text = match event.kind {
        EventKind::Spawned => format!("spawned {}", event.name),
        EventKind::Revived => format!("revived {}", event.name),
        _ => event.name.clone(),
    };
    if !event.detail.trim().is_empty() {
        text.push_str(" · ");
        text.push_str(event.detail.trim());
    }
    clip_row(
        Row {
            spans: vec![
                Span::new(format!("  {} ", event.kind.glyph()), style),
                Span::new(text, style),
            ],
        },
        usize::from(width.max(8)),
    )
}

/// A run of consecutive transitions, as one row.
///
/// `None` for fewer than two: one transition is its own row and says more.
#[must_use]
pub fn collapse(events: &[AgentEvent], theme: &Theme, width: u16) -> Option<Row> {
    if events.len() < 2 {
        return None;
    }
    let count = |kind: EventKind| events.iter().filter(|event| event.kind == kind).count();
    let spawned = count(EventKind::Spawned);
    let revived = count(EventKind::Revived);
    let finished = count(EventKind::Finished);
    let failed = count(EventKind::Failed);
    // Failures are never folded into a count of something else: a row that says
    // "6 agent updates" while one of them died is a row that hid the only part
    // the user had to act on. Below that, the glyph is whichever kind the run is
    // mostly made of, with ties broken in lifecycle order.
    let tallies = [
        (EventKind::Spawned, "spawned", spawned),
        (EventKind::Revived, "revived", revived),
        (EventKind::Finished, "done", finished),
        (EventKind::Failed, "failed", failed),
    ];
    let leading = if failed > 0 {
        EventKind::Failed
    } else {
        // `min_by_key` over the reversed tally, not `max_by_key`: the former
        // keeps the *first* of equal keys, which is what "ties break in
        // lifecycle order" means.
        tallies
            .iter()
            .filter(|(_, _, tally)| *tally > 0)
            .min_by_key(|(_, _, tally)| std::cmp::Reverse(*tally))
            .map_or(EventKind::Spawned, |(kind, _, _)| *kind)
    };
    let style = if failed > 0 { theme.error() } else { theme.faint() };

    let mut parts: Vec<String> = Vec::new();
    for (_, label, tally) in tallies {
        if tally > 0 {
            parts.push(format!("{tally} {label}"));
        }
    }
    // **Children, not transitions.** A child that spawned and finished inside
    // one run is one agent with two things to say about it, and a row reading
    // "2 agents · activity-module, activity-module" is a row that miscounted the
    // swarm and said the same name twice. The tallies below still count
    // transitions, because that is what they are counting.
    let mut distinct: Vec<&str> = Vec::new();
    for event in events {
        if !distinct.contains(&event.name.as_str()) {
            distinct.push(event.name.as_str());
        }
    }
    let named: Vec<&str> = distinct.iter().copied().take(MAX_NAMED).collect();
    let mut text = format!(
        "{} agent{} · {}",
        distinct.len(),
        if distinct.len() == 1 { "" } else { "s" },
        parts.join(" · ")
    );
    if !named.is_empty() {
        text.push_str(" · ");
        text.push_str(&named.join(", "));
        if distinct.len() > named.len() {
            text.push('…');
        }
    }
    Some(clip_row(
        Row {
            spans: vec![
                Span::new(format!("  {} ", leading.glyph()), style),
                Span::new(text, style),
            ],
        },
        usize::from(width.max(8)),
    ))
}

/// The dim `⇄ peer: text` row a hub aside gets.
///
/// **Not** a `>` user band. A message from another agent on the bus is folded
/// into this turn exactly as steering is, and the daemon says so
/// (`steer.source: "hub"`) — so rendering it as the user's own words would
/// attribute to the person at the keyboard something they did not say. One
/// glyph and one dim line is the whole difference, and it is the whole point.
#[must_use]
pub fn hub_aside(from: &str, text: &str, theme: &Theme, width: u16) -> Vec<Row> {
    let who = if from.trim().is_empty() { "an agent" } else { from };
    let marker = [
        Span::new("⇄ ", theme.agent()),
        Span::new(format!("{who}: "), theme.agent()),
    ];
    let continuation = [Span::new("  ", theme.faint())];
    let mut rows = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let spans = vec![Span::new(line.to_owned(), theme.faint())];
        let first: &[Span] = if index == 0 { &marker } else { &continuation };
        rows.extend(crate::ui::markdown::wrap_spans(
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
    rows.push(Row::default());
    rows
}

/// Strip the daemon's hub-aside envelope back down to what the peer said.
///
/// The daemon wraps a bus message in a preamble and a reply instruction before
/// handing it to the model — `[hub message from reviewer] …\n(Reply with hub
/// …)` — because the *model* needs to be told who is speaking and how to answer.
/// The user does not: the row already says both. So the envelope is peeled here
/// rather than printed, and a message that does not carry one is returned
/// unchanged.
#[must_use]
pub fn unwrap_aside(text: &str) -> (Option<String>, String) {
    let Some(rest) = text.strip_prefix("[hub message from ") else {
        return (None, text.to_owned());
    };
    let Some((from, body)) = rest.split_once("] ") else {
        return (None, text.to_owned());
    };
    let body = match body.rfind("\n(Reply with hub ") {
        Some(at) => &body[..at],
        None => body,
    };
    (Some(from.to_owned()), body.trim_end().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn presence(name: &str, state: AgentState) -> Presence {
        Presence {
            name: name.to_owned(),
            state,
        }
    }

    fn text(row: &Option<Row>) -> String {
        row.as_ref().map(Row::plain_text).unwrap_or_default()
    }

    #[test]
    fn no_children_means_no_row_at_all() {
        assert!(strip(&Theme::lyra(), &[], 80).is_none());
    }

    #[test]
    fn a_live_child_is_a_dot_and_its_peer_name() {
        let row = strip(
            &Theme::lyra(),
            &[
                presence("activity-module", AgentState::Running),
                presence("qa-checker", AgentState::AwaitingTool),
            ],
            80,
        );
        assert_eq!(text(&row), "  ◎ activity-module ◍ qa-checker");
    }

    #[test]
    fn waiting_children_are_counted_rather_than_named() {
        let row = strip(
            &Theme::lyra(),
            &[
                presence("activity-module", AgentState::Running),
                presence("a", AgentState::Queued),
                presence("b", AgentState::Starting),
            ],
            80,
        );
        assert_eq!(text(&row), "  ◎ activity-module ○ 2 queued");
    }

    #[test]
    fn a_finished_child_ticks_and_a_failed_one_crosses() {
        let row = strip(
            &Theme::lyra(),
            &[
                presence("done", AgentState::Completed),
                presence("gone", AgentState::TimedOut),
            ],
            80,
        );
        assert_eq!(text(&row), "  ✓ done ✗ gone");
    }

    /// A swarm is a real shape. The row must not lie about how big it is.
    #[test]
    fn twenty_children_truncate_with_an_honest_count() {
        let agents: Vec<Presence> = (0..20)
            .map(|n| presence(&format!("worker-{n}"), AgentState::Running))
            .collect();
        for width in [30u16, 60, 80, 120] {
            let row = strip(&Theme::lyra(), &agents, width).expect("a row");
            assert!(row.width() <= usize::from(width), "{:?}", row.plain_text());
            let drawn = row.plain_text();
            let named = agents
                .iter()
                .filter(|agent| drawn.contains(&agent.name))
                .count();
            let hidden = 20 - named;
            if hidden > 0 {
                assert!(
                    drawn.contains(&format!("{hidden} more")) || drawn.contains("20 agents"),
                    "the row must account for every child: {drawn:?}"
                );
            }
        }
    }

    #[test]
    fn the_narrowest_row_still_says_how_many_there_are() {
        let agents: Vec<Presence> = (0..7)
            .map(|n| presence(&format!("a-very-long-agent-name-{n}"), AgentState::Running))
            .collect();
        let row = strip(&Theme::lyra(), &agents, 12).expect("a row");
        assert!(row.width() <= 12, "{:?}", row.plain_text());
    }

    #[test]
    fn a_spawn_row_names_the_child_and_its_model() {
        let row = event_row(
            &AgentEvent {
                kind: EventKind::Spawned,
                name: "activity-module".to_owned(),
                detail: "gpt-5.6-terra".to_owned(),
            },
            &Theme::lyra(),
            80,
        );
        assert_eq!(row.plain_text(), "  ◎ spawned activity-module · gpt-5.6-terra");
    }

    #[test]
    fn a_finish_row_carries_what_it_did_and_a_failure_carries_why() {
        let done = event_row(
            &AgentEvent {
                kind: EventKind::Finished,
                name: "activity-module".to_owned(),
                detail: "4 files · 12 tool calls".to_owned(),
            },
            &Theme::lyra(),
            80,
        );
        assert_eq!(done.plain_text(), "  ✓ activity-module · 4 files · 12 tool calls");
        let failed = event_row(
            &AgentEvent {
                kind: EventKind::Failed,
                name: "qa-checker".to_owned(),
                detail: "timed out — /agents".to_owned(),
            },
            &Theme::lyra(),
            80,
        );
        assert_eq!(failed.plain_text(), "  ✗ qa-checker · timed out — /agents");
    }

    #[test]
    fn one_transition_is_never_collapsed() {
        let one = [AgentEvent {
            kind: EventKind::Spawned,
            name: "a".to_owned(),
            detail: String::new(),
        }];
        assert!(collapse(&one, &Theme::lyra(), 80).is_none());
    }

    #[test]
    fn a_swarm_of_spawns_collapses_to_one_row_with_counts() {
        let events: Vec<AgentEvent> = (0..6)
            .map(|n| AgentEvent {
                kind: EventKind::Spawned,
                name: format!("w{n}"),
                detail: "opus-5".to_owned(),
            })
            .collect();
        let row = collapse(&events, &Theme::lyra(), 100).expect("a collapsed row");
        let drawn = row.plain_text();
        assert!(drawn.contains("6 agents"), "{drawn}");
        assert!(drawn.contains("6 spawned"), "{drawn}");
        assert!(drawn.ends_with('…'), "the elision is visible: {drawn}");
    }

    /// The count is of children, not of things that happened to them.
    #[test]
    fn one_child_with_two_transitions_is_one_agent() {
        let events = [
            AgentEvent {
                kind: EventKind::Spawned,
                name: "activity-module".to_owned(),
                detail: "opus-5".to_owned(),
            },
            AgentEvent {
                kind: EventKind::Finished,
                name: "activity-module".to_owned(),
                detail: "4 files".to_owned(),
            },
        ];
        let drawn = collapse(&events, &Theme::lyra(), 100)
            .expect("a collapsed row")
            .plain_text();
        assert!(drawn.contains("1 agent ·"), "{drawn}");
        assert!(drawn.contains("1 spawned · 1 done"), "{drawn}");
        assert_eq!(
            drawn.matches("activity-module").count(),
            1,
            "the name is said once: {drawn}"
        );
    }

    /// A revival is a transition the *state* cannot express, so it gets a glyph
    /// and a verb of its own rather than reading as a second spawn.
    #[test]
    fn a_revived_child_is_not_a_second_spawn() {
        let row = event_row(
            &AgentEvent {
                kind: EventKind::Revived,
                name: "activity-module".to_owned(),
                detail: "opus-5".to_owned(),
            },
            &Theme::lyra(),
            80,
        );
        assert_eq!(row.plain_text(), "  ↻ revived activity-module · opus-5");
    }

    /// The tallies count what happened; a revival is its own line item, and the
    /// run's glyph is whichever kind it is mostly made of.
    #[test]
    fn a_run_of_revivals_is_counted_as_revivals() {
        let events: Vec<AgentEvent> = (0..3)
            .map(|n| AgentEvent {
                kind: if n == 0 {
                    EventKind::Finished
                } else {
                    EventKind::Revived
                },
                name: format!("w{n}"),
                detail: String::new(),
            })
            .collect();
        let drawn = collapse(&events, &Theme::lyra(), 100)
            .expect("a collapsed row")
            .plain_text();
        assert!(drawn.trim_start().starts_with('↻'), "{drawn}");
        assert!(drawn.contains("2 revived"), "{drawn}");
        assert!(drawn.contains("1 done"), "{drawn}");
    }

    /// Ties break in lifecycle order, which is what the previous
    /// `spawned >= finished` rule said and what the tally table now encodes.
    #[test]
    fn a_spawn_and_a_finish_still_lead_with_the_spawn() {
        let events = [
            AgentEvent {
                kind: EventKind::Finished,
                name: "a".to_owned(),
                detail: String::new(),
            },
            AgentEvent {
                kind: EventKind::Spawned,
                name: "b".to_owned(),
                detail: String::new(),
            },
        ];
        let drawn = collapse(&events, &Theme::lyra(), 100)
            .expect("a collapsed row")
            .plain_text();
        assert!(drawn.trim_start().starts_with('◎'), "{drawn}");
    }

    /// The one rule about collapsing that is not about space.
    #[test]
    fn a_failure_inside_a_run_is_never_folded_out_of_sight() {
        let mut events: Vec<AgentEvent> = (0..4)
            .map(|n| AgentEvent {
                kind: EventKind::Finished,
                name: format!("w{n}"),
                detail: String::new(),
            })
            .collect();
        events.push(AgentEvent {
            kind: EventKind::Failed,
            name: "bad".to_owned(),
            detail: "provider stopped answering".to_owned(),
        });
        let row = collapse(&events, &Theme::lyra(), 100).expect("a collapsed row");
        let drawn = row.plain_text();
        assert!(drawn.trim_start().starts_with('✗'), "{drawn}");
        assert!(drawn.contains("1 failed"), "{drawn}");
    }

    #[test]
    fn a_hub_aside_is_not_a_user_band() {
        let rows = hub_aside("activity-module", "the parser tests pass now", &Theme::lyra(), 80);
        let drawn = rows[0].plain_text();
        assert!(drawn.starts_with("⇄ activity-module: "), "{drawn}");
        assert!(!drawn.starts_with('>'), "{drawn}");
    }

    #[test]
    fn the_daemons_envelope_is_peeled_off_before_it_is_shown() {
        let wrapped = "[hub message from reviewer] the parser tests pass now\n(Reply with hub { op: \"send\", to: \"reviewer\", message: \"...\" }. This is another agent speaking, not the user.)";
        let (from, body) = unwrap_aside(wrapped);
        assert_eq!(from.as_deref(), Some("reviewer"));
        assert_eq!(body, "the parser tests pass now");

        // Ordinary text is returned untouched, so nothing the user typed can be
        // mistaken for another agent's aside.
        let (from, body) = unwrap_aside("just a prompt");
        assert_eq!(from, None);
        assert_eq!(body, "just a prompt");
    }

    #[test]
    fn no_row_ever_exceeds_the_terminal_width() {
        let theme = Theme::lyra();
        let event = AgentEvent {
            kind: EventKind::Failed,
            name: "a-child-with-a-very-long-peer-name".to_owned(),
            detail: "the provider stopped answering after eleven minutes".to_owned(),
        };
        for width in [16u16, 30, 50, 80] {
            assert!(event_row(&event, &theme, width).width() <= usize::from(width));
            let events = [event.clone(), event.clone(), event.clone()];
            if let Some(row) = collapse(&events, &theme, width) {
                assert!(row.width() <= usize::from(width), "{:?}", row.plain_text());
            }
            for row in hub_aside("peer", &"word ".repeat(40), &theme, width) {
                assert!(row.width() <= usize::from(width), "{:?}", row.plain_text());
            }
        }
    }
}
