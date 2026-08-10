//! The transcript: what has been said, in a form that can be re-said.
//!
//! # Why this holds entries and not rows
//!
//! The compositor's replay ring holds `Row`s — already wrapped, at the width
//! they were printed. That is the right thing for the ring and the wrong thing
//! for [`crate::engine::ResizeMode::Purge`], whose entire purpose is to fix
//! stale wrapping: replaying old-width rows reproduces exactly the staleness it
//! was invoked to remove.
//!
//! So the transcript keeps **semantic entries** — the markdown source, the tool
//! view, the retry — and can render the whole thing at any width on demand.
//! [`Transcript::replay_rows`] is what purge calls, and it is the same code
//! path that produced the rows in the first place, so a purged screen is
//! byte-identical to one that had been that width all along.
//!
//! # Run collapsing happens before the commit, not after
//!
//! DESIGN.md §3 wants a run of reads and searches to collapse to one prose line
//! with counts. A row already in scrollback cannot be taken back, so the
//! collapse cannot be retroactive: survey calls are held in the live region
//! ([`Transcript::live_rows`]) until something that is not a survey arrives, and
//! only then does the collapsed line commit. The user sees the run forming in
//! the live region and one settled line in scrollback.
//!
//! # `Tab` expansion is append-only
//!
//! Same reason. Expanding the last tool call cannot rewrite its collapsed row,
//! so [`Transcript::expand_last_tool`] *appends* the detail below it. Expanding
//! twice is a no-op rather than a duplicate. The keybinding lives with the input
//! layer; this is the operation it calls.

use std::collections::VecDeque;

use crate::theme::Theme;
use crate::ui::agent::{self, AgentEvent};
use crate::ui::diff::{self, DiffOptions, FileDiff};
use crate::ui::markdown::{self, MarkdownStream};
use crate::ui::reliability::{self, Retry, TurnEnd};
use crate::ui::thinking::{self, ThinkingMode};
use crate::ui::tool_row::{self, ToolView};
use crate::ui::Row;

/// Default cap on remembered entries. A long session's memory is bounded by
/// this and by the markdown source each entry holds.
pub const DEFAULT_ENTRY_CAP: usize = 4000;

/// One semantic unit of the transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    /// The one-line session header (DESIGN.md §3).
    Header(Vec<String>),
    /// A user message band.
    User(String),
    /// Assistant markdown, as source.
    Assistant(String),
    /// One tool call. `expanded` is sticky so replay reproduces it.
    Tool {
        /// The call.
        view: Box<ToolView>,
        /// Whether its detail has been appended.
        expanded: bool,
    },
    /// A collapsed run of reads and searches.
    ToolRun(Vec<ToolView>),
    /// One child-agent lifecycle transition.
    Agent(AgentEvent),
    /// A collapsed run of them, so a swarm costs one row rather than twelve.
    AgentRun(Vec<AgentEvent>),
    /// A message from another agent on the bus, folded into this turn. Rendered
    /// as what it is — never as a `>` user band.
    HubAside {
        /// The peer that sent it.
        from: String,
        /// What it said, with the daemon's envelope already peeled off.
        text: String,
    },
    /// A retry, at the attempt it had reached.
    Retry(Retry),
    /// A compaction boundary.
    Compaction {
        /// Token delta, negative.
        delta: i64,
        /// First kept message index, when the daemon reported one.
        first_kept: Option<usize>,
    },
    /// A context repair.
    ContextRepair(String),
    /// A loop-detection note.
    LoopWarning(String),
    /// A transport fallback.
    TransportFallback {
        /// Transport left.
        from: String,
        /// Transport adopted.
        to: String,
        /// Why, when reported.
        reason: Option<String>,
    },
    /// A non-ordinary turn end.
    TurnEnd(TurnEnd),
    /// A finished thinking part. Rendered as one dim line by default, or as the
    /// dim trace itself when `full` — decided at commit time by
    /// [`ThinkingMode`], so replay cannot disagree with what was printed.
    Thinking {
        /// The trace. Empty for a redacted part, and unrendered unless `full`.
        text: String,
        /// How long the part was open, when this client saw it open.
        seconds: Option<u64>,
        /// Whether the trace itself is on screen.
        full: bool,
    },
    /// A dim one-line audit row (DESIGN.md §3's "dim one-line audit rows").
    Audit(String),
    /// A dim `─── label ───` rule, for the brackets around replayed history.
    Rule(String),
    /// A spacer.
    Blank,
}

/// The transcript model.
#[derive(Debug)]
pub struct Transcript {
    theme: Theme,
    width: u16,
    entries: VecDeque<Entry>,
    entry_cap: usize,
    /// The in-flight assistant block, streaming into scrollback.
    stream: Option<MarkdownStream>,
    /// The in-flight thinking trace, live-region only. Deliberately *not* a
    /// [`MarkdownStream`]: thinking publishes nothing to scrollback while it
    /// streams, so it has no stable prefix to maintain and no commit path to
    /// share with the answer.
    thinking_live: Option<String>,
    /// What to do with thinking traces, from `[tui] thinking`.
    thinking_mode: ThinkingMode,
    /// Survey calls held back so the run can collapse before committing.
    pending_run: Vec<ToolView>,
    /// Child-agent transitions held back for the same reason. A separate buffer
    /// because the two kinds do not collapse together: each flushes the other,
    /// so at most one is ever non-empty and nothing is reordered.
    pending_agents: Vec<AgentEvent>,
}

impl Transcript {
    /// A transcript rendering at `width` with `theme`.
    #[must_use]
    pub fn new(theme: Theme, width: u16) -> Self {
        Self {
            theme,
            width: width.max(1),
            entries: VecDeque::new(),
            entry_cap: DEFAULT_ENTRY_CAP,
            stream: None,
            thinking_live: None,
            thinking_mode: ThinkingMode::default(),
            pending_run: Vec::new(),
            pending_agents: Vec::new(),
        }
    }

    /// Override the entry cap.
    #[must_use]
    pub const fn with_entry_cap(mut self, cap: usize) -> Self {
        self.entry_cap = cap;
        self
    }

    /// Set what happens to thinking traces.
    #[must_use]
    pub const fn with_thinking(mut self, mode: ThinkingMode) -> Self {
        self.thinking_mode = mode;
        self
    }

    /// Set what happens to thinking traces, after construction.
    pub const fn set_thinking(&mut self, mode: ThinkingMode) {
        self.thinking_mode = mode;
    }

    /// The thinking policy in force. Read by the history replay, so a resumed
    /// session shows reasoning exactly as a live one would have.
    #[must_use]
    pub const fn thinking_mode(&self) -> ThinkingMode {
        self.thinking_mode
    }

    /// Remembered entries, oldest first.
    #[must_use]
    pub fn entries(&self) -> impl DoubleEndedIterator<Item = &Entry> + ExactSizeIterator {
        self.entries.iter()
    }

    /// The most recent entry.
    #[must_use]
    pub fn last(&self) -> Option<&Entry> {
        self.entries.back()
    }

    /// The current theme.
    #[must_use]
    pub const fn theme(&self) -> &Theme {
        &self.theme
    }

    /// Re-wrap future output at a new width.
    ///
    /// Committed rows keep their old wrapping until a purge re-renders them;
    /// that is the conservative/purge trade of DESIGN.md §1, and this is the
    /// only place the transcript knows about it.
    pub fn set_width(&mut self, width: u16) {
        self.width = width.max(1);
        if let Some(stream) = &mut self.stream {
            stream.set_width(self.width);
        }
    }

    /// Swap the theme, e.g. after a DEC 2031 colour-scheme notification.
    ///
    /// Rows already in scrollback keep the colours they were printed with —
    /// there is no way to repaint them — so a live re-theme only takes full
    /// effect after a purge. [`crate::theme::adaptive::retheme`] builds the new
    /// theme; this applies it.
    pub fn set_theme(&mut self, theme: Theme) {
        if let Some(stream) = &mut self.stream {
            stream.set_theme(theme.clone());
        }
        self.theme = theme;
    }

    // -- appending ---------------------------------------------------------

    /// Print the session header. Call once, at session start.
    pub fn header(&mut self, fields: &[&str]) -> Vec<Row> {
        let owned: Vec<String> = fields.iter().map(|field| (*field).to_owned()).collect();
        let rows = render_entry(&Entry::Header(owned.clone()), &self.theme, self.width);
        self.remember(Entry::Header(owned));
        rows
    }

    /// A user (or synthetic steering) turn.
    pub fn user(&mut self, text: &str) -> Vec<Row> {
        let mut rows = self.flush_run();
        rows.extend(self.close_stream());
        let entry = Entry::User(text.to_owned());
        rows.extend(render_entry(&entry, &self.theme, self.width));
        self.remember(entry);
        rows
    }

    /// Append assistant markdown, returning the rows that just became stable.
    ///
    /// Line-boundary publish and the monotone stable prefix are
    /// [`MarkdownStream`]'s; this only keeps the source so a purge can
    /// re-render it.
    pub fn assistant_delta(&mut self, delta: &str) -> Vec<Row> {
        let mut rows = self.flush_run();
        if self.stream.is_none() {
            self.stream = Some(MarkdownStream::new(self.theme.clone(), self.width));
            self.remember(Entry::Assistant(String::new()));
        }
        if let Some(Entry::Assistant(source)) = self.entries.back_mut() {
            source.push_str(delta);
        }
        if let Some(stream) = &mut self.stream {
            rows.extend(stream.push(delta));
        }
        rows
    }

    /// End the assistant block, flushing its final rows.
    pub fn end_assistant(&mut self) -> Vec<Row> {
        self.close_stream()
    }

    /// Append a thinking delta.
    ///
    /// Returns nothing, always, and the signature says so: thinking publishes to
    /// the **live region only** while it streams. It shares no state with
    /// [`Self::assistant_delta`] — no [`MarkdownStream`], no stable prefix, no
    /// entry — because a trace that leaked into the answer's markdown stream
    /// would end up in the answer's scrollback, which is the one thing this
    /// design will not do.
    pub fn thinking_delta(&mut self, delta: &str) {
        if !self.thinking_mode.shows() {
            return;
        }
        let buffer = self.thinking_live.get_or_insert_with(String::new);
        buffer.push_str(delta);
        thinking::trim_live(buffer);
    }

    /// Whether a thinking part is streaming into the live region right now.
    #[must_use]
    pub const fn thinking_live(&self) -> bool {
        self.thinking_live.is_some()
    }

    /// A thinking part ended: collapse the live block to what the mode commits.
    ///
    /// `text` is the *complete* trace from the session store, not the bounded
    /// live buffer, so `full` commits the whole thing however long it ran.
    /// `seconds` is how long the part was open, when this client saw it open.
    pub fn end_thinking(&mut self, text: &str, seconds: Option<u64>) -> Vec<Row> {
        let was_live = self.thinking_live.take().is_some();
        if !self.thinking_mode.shows() {
            return Vec::new();
        }
        // A part that neither said anything nor was ever seen streaming is one
        // this client has nothing to report about — an attach mid-thought, or a
        // part_end for a part that never opened. Silence beats a bare marker.
        if !was_live && text.trim().is_empty() && seconds.is_none() {
            return Vec::new();
        }
        self.push(Entry::Thinking {
            text: text.to_owned(),
            seconds,
            full: self.thinking_mode.commits_text() && !text.trim().is_empty(),
        })
    }

    /// A thinking block recovered from a persisted transcript.
    ///
    /// The same policy as the live path, from the same field, so a resumed
    /// session looks like the session it resumes. Nothing at all under
    /// `collapsed` unless the entry carried a duration: see
    /// [`crate::app::history`] for why a one-liner with no figure is worse than
    /// no row.
    pub fn replayed_thinking(&mut self, text: &str, seconds: Option<u64>) -> Vec<Row> {
        if !self.thinking_mode.shows() {
            return Vec::new();
        }
        let full = self.thinking_mode.commits_text() && !text.trim().is_empty();
        if !full && seconds.is_none() {
            return Vec::new();
        }
        self.push(Entry::Thinking {
            text: text.to_owned(),
            seconds,
            full,
        })
    }

    /// A tool call reached a state worth showing.
    ///
    /// Survey calls (reads, searches) are held back so a run of them can
    /// collapse; everything else commits immediately.
    pub fn tool(&mut self, view: ToolView) -> Vec<Row> {
        if view.is_survey() {
            let rows = self.flush_agents();
            self.pending_run.push(view);
            return rows;
        }
        let mut rows = self.flush_run();
        rows.extend(self.close_stream());
        let entry = Entry::Tool {
            view: Box::new(view),
            expanded: false,
        };
        rows.extend(render_entry(&entry, &self.theme, self.width));
        self.remember(entry);
        rows
    }

    /// Expand the most recent tool call.
    ///
    /// Appends its full detail — the diff through [`crate::ui::diff`], the
    /// untruncated output — below the collapsed row. Returns nothing when there
    /// is no tool call to expand or it is already expanded, which is what makes
    /// a repeated `Tab` harmless.
    pub fn expand_last_tool(&mut self) -> Vec<Row> {
        let mut rows = self.flush_run();
        let slot = self
            .entries
            .iter()
            .rposition(|entry| matches!(entry, Entry::Tool { .. }));
        let Some(slot) = slot else { return rows };
        let Some(Entry::Tool { view, expanded }) = self.entries.get_mut(slot) else {
            return rows;
        };
        if *expanded {
            return rows;
        }
        *expanded = true;
        let view = view.clone();
        rows.extend(expansion_rows(&view, &self.theme, self.width));
        rows
    }

    /// Whether the last tool call has been expanded.
    #[must_use]
    pub fn last_tool_expanded(&self) -> Option<bool> {
        self.entries.iter().rev().find_map(|entry| match entry {
            Entry::Tool { expanded, .. } => Some(*expanded),
            _ => None,
        })
    }

    /// A retry, rendered at transcript level (the footer slot is the input
    /// layer's).
    pub fn retry(&mut self, retry: Retry) -> Vec<Row> {
        self.push(Entry::Retry(retry))
    }

    /// A compaction boundary, committed to scrollback.
    pub fn compacted(&mut self, delta: i64, first_kept: Option<usize>) -> Vec<Row> {
        self.push(Entry::Compaction { delta, first_kept })
    }

    /// A context repair.
    pub fn context_repaired(&mut self, detail: &str) -> Vec<Row> {
        self.push(Entry::ContextRepair(detail.to_owned()))
    }

    /// A loop-detection note.
    pub fn loop_warning(&mut self, detail: &str) -> Vec<Row> {
        self.push(Entry::LoopWarning(detail.to_owned()))
    }

    /// A transport fallback, noted once.
    pub fn transport_fallback(&mut self, from: &str, to: &str, reason: Option<&str>) -> Vec<Row> {
        self.push(Entry::TransportFallback {
            from: from.to_owned(),
            to: to.to_owned(),
            reason: reason.map(str::to_owned),
        })
    }

    /// End of turn. An ordinary completion leaves no marker.
    pub fn turn_end(&mut self, stop_reason: &str) -> Vec<Row> {
        let mut rows = self.flush_run();
        rows.extend(self.close_stream());
        if let Some(end) = TurnEnd::from_stop_reason(stop_reason) {
            let entry = Entry::TurnEnd(end);
            rows.extend(render_entry(&entry, &self.theme, self.width));
            self.remember(entry);
        }
        rows
    }

    /// One child-agent lifecycle transition.
    ///
    /// Held back like a survey run: a fan-out of a dozen children arrives as a
    /// dozen transitions in one burst, and a dozen rows about *starting* work is
    /// scrollback spent on bookkeeping. The run settles into one collapsed line
    /// the moment anything that is not a transition arrives.
    pub fn agent(&mut self, event: AgentEvent) -> Vec<Row> {
        let rows = self.flush_tools();
        self.pending_agents.push(event);
        rows
    }

    /// A hub aside — another agent speaking into this turn.
    pub fn hub_aside(&mut self, from: &str, text: &str) -> Vec<Row> {
        self.push(Entry::HubAside {
            from: from.to_owned(),
            text: text.to_owned(),
        })
    }

    /// A dim audit line, remembered so a purge replays it with everything else.
    pub fn audit(&mut self, text: &str) -> Vec<Row> {
        self.push(Entry::Audit(text.to_owned()))
    }

    /// A dim `─── label ───` rule.
    pub fn rule(&mut self, label: &str) -> Vec<Row> {
        self.push(Entry::Rule(label.to_owned()))
    }

    /// A spacer row.
    pub fn blank(&mut self) -> Vec<Row> {
        self.push(Entry::Blank)
    }

    // -- reading -----------------------------------------------------------

    /// What the live region should show: the streaming markdown tail, the
    /// survey run that has not settled yet, and the thinking trace in flight.
    ///
    /// Thinking goes last because it is the newest thing happening: a turn
    /// thinks *after* the reads it ordered and *before* the prose it is working
    /// towards, so the nearest row to the composer is the one that answers
    /// "what now".
    #[must_use]
    pub fn live_rows(&self) -> Vec<Row> {
        let mut rows = self
            .stream
            .as_ref()
            .map(MarkdownStream::live_rows)
            .unwrap_or_default();
        rows.extend(self.run_rows());
        if let Some(text) = &self.thinking_live {
            rows.extend(thinking::live_rows(text, &self.theme, self.width));
        }
        rows
    }

    /// The whole transcript, rendered at `width`.
    ///
    /// This is what makes purge honest: the rows come out as if the terminal
    /// had always been this wide.
    #[must_use]
    pub fn render_all(&self, width: u16) -> Vec<Row> {
        let width = width.max(1);
        let mut rows = Vec::new();
        for entry in &self.entries {
            rows.extend(render_entry(entry, &self.theme, width));
            if let Entry::Tool {
                view,
                expanded: true,
            } = entry
            {
                rows.extend(expansion_rows(view, &self.theme, width));
            }
        }
        rows
    }

    /// The tail of the transcript at `width`, capped at `cap` rows.
    ///
    /// [`crate::engine::ResizeMode::Purge`]'s replay. The cap is DESIGN.md §1's
    /// ~2000 lines: a purge that reprinted a whole day's session would take
    /// longer than the resize it is reacting to.
    #[must_use]
    pub fn replay_rows(&self, width: u16, cap: usize) -> Vec<Row> {
        let mut rows = self.render_all(width);
        if rows.len() > cap {
            rows.drain(..rows.len() - cap);
        }
        rows
    }

    // -- internals ---------------------------------------------------------

    fn push(&mut self, entry: Entry) -> Vec<Row> {
        let mut rows = self.flush_run();
        rows.extend(self.close_stream());
        rows.extend(render_entry(&entry, &self.theme, self.width));
        self.remember(entry);
        rows
    }

    fn remember(&mut self, entry: Entry) {
        if self.entries.len() == self.entry_cap {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }

    fn close_stream(&mut self) -> Vec<Row> {
        let Some(stream) = &mut self.stream else {
            return Vec::new();
        };
        let rows = stream.finish();
        self.stream = None;
        rows
    }

    /// Rows for whichever run is currently being held back.
    fn run_rows(&self) -> Vec<Row> {
        let refs: Vec<&ToolView> = self.pending_run.iter().collect();
        let mut rows = match refs.len() {
            0 => Vec::new(),
            1 => {
                let mut rows = vec![tool_row::collapsed(refs[0], &self.theme, self.width)];
                rows.extend(tool_row::children(refs[0], &self.theme, self.width));
                rows
            }
            _ => tool_row::collapse_run(&refs, &self.theme, self.width)
                .map(|row| vec![row])
                .unwrap_or_default(),
        };
        if !self.pending_agents.is_empty() {
            rows.extend(render_entry(
                &agent_entry(self.pending_agents.clone()),
                &self.theme,
                self.width,
            ));
        }
        rows
    }

    /// Settle both held-back runs. Called by every path that commits something
    /// which is neither a survey call nor an agent transition.
    fn flush_run(&mut self) -> Vec<Row> {
        let mut rows = self.flush_tools();
        rows.extend(self.flush_agents());
        rows
    }

    fn flush_tools(&mut self) -> Vec<Row> {
        if self.pending_run.is_empty() {
            return Vec::new();
        }
        let run = std::mem::take(&mut self.pending_run);
        let entry = if run.len() == 1 {
            Entry::Tool {
                view: Box::new(run.into_iter().next().expect("length checked")),
                expanded: false,
            }
        } else {
            Entry::ToolRun(run)
        };
        let rows = render_entry(&entry, &self.theme, self.width);
        self.remember(entry);
        rows
    }

    fn flush_agents(&mut self) -> Vec<Row> {
        if self.pending_agents.is_empty() {
            return Vec::new();
        }
        let entry = agent_entry(std::mem::take(&mut self.pending_agents));
        let rows = render_entry(&entry, &self.theme, self.width);
        self.remember(entry);
        rows
    }
}

/// One transition is its own row; more than one collapses.
fn agent_entry(mut events: Vec<AgentEvent>) -> Entry {
    if events.len() == 1 {
        return Entry::Agent(events.pop().expect("length checked"));
    }
    Entry::AgentRun(events)
}

fn expansion_rows(view: &ToolView, theme: &Theme, width: u16) -> Vec<Row> {
    // The collapsed row is already in scrollback; the expansion is only what
    // it did not show.
    tool_row::expanded(view, theme, width)
        .into_iter()
        .skip(1)
        .collect()
}

/// Render one entry. The single mapping from semantics to rows, so the live
/// path and the replay path cannot disagree.
#[must_use]
pub fn render_entry(entry: &Entry, theme: &Theme, width: u16) -> Vec<Row> {
    match entry {
        Entry::Header(fields) => {
            let borrowed: Vec<&str> = fields.iter().map(String::as_str).collect();
            vec![reliability::session_header(&borrowed, theme, width)]
        }
        Entry::User(text) => reliability::user_band(text, theme, width),
        Entry::Assistant(source) => markdown::render_document(source, theme, width),
        Entry::Tool { view, .. } => {
            let mut rows = vec![tool_row::collapsed(view, theme, width)];
            rows.extend(tool_row::children(view, theme, width));
            rows
        }
        Entry::ToolRun(views) => {
            let refs: Vec<&ToolView> = views.iter().collect();
            tool_row::collapse_run(&refs, theme, width)
                .map(|row| vec![row])
                .unwrap_or_else(|| {
                    refs.iter()
                        .map(|view| tool_row::collapsed(view, theme, width))
                        .collect()
                })
        }
        Entry::Agent(event) => vec![agent::event_row(event, theme, width)],
        Entry::AgentRun(events) => agent::collapse(events, theme, width)
            .map(|row| vec![row])
            .unwrap_or_else(|| {
                events
                    .iter()
                    .map(|event| agent::event_row(event, theme, width))
                    .collect()
            }),
        Entry::HubAside { from, text } => agent::hub_aside(from, text, theme, width),
        Entry::Retry(retry) => reliability::retry_rows(retry, theme),
        Entry::Compaction { delta, first_kept } => {
            vec![reliability::compaction_boundary(*delta, *first_kept, theme, width)]
        }
        Entry::ContextRepair(detail) => vec![reliability::context_repair(detail, theme)],
        Entry::LoopWarning(detail) => vec![reliability::loop_warning(detail, theme)],
        Entry::TransportFallback { from, to, reason } => vec![reliability::transport_fallback(
            from,
            to,
            reason.as_deref(),
            theme,
        )],
        Entry::TurnEnd(end) => vec![reliability::turn_end(*end, theme)],
        Entry::Thinking {
            text,
            seconds,
            full,
        } => {
            if *full {
                thinking::full_rows(text, *seconds, theme, width)
            } else {
                vec![thinking::collapsed_row(*seconds, theme)]
            }
        }
        Entry::Audit(text) => vec![Row::styled(format!("  {text}"), theme.faint())],
        Entry::Rule(label) => vec![reliability::rule_row(label, theme, width)],
        Entry::Blank => vec![Row::blank()],
    }
}

/// Render a standalone diff on any surface.
///
/// Exists so a caller that has a [`FileDiff`] but no tool call — a `/diff`
/// command, a future theme preview — reaches the same renderer rather than
/// growing a second one.
#[must_use]
pub fn diff_rows(file_diff: &FileDiff, theme: &Theme, width: u16) -> Vec<Row> {
    diff::render(file_diff, theme, &DiffOptions::expanded(width))
}

impl crate::engine::resize::ReplaySource for Transcript {
    fn replay_rows(&mut self, width: u16, cap: usize) -> Vec<Row> {
        Self::replay_rows(self, width, cap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{ToolCall, ToolState};

    fn theme() -> Theme {
        Theme::lyra()
    }

    fn transcript(width: u16) -> Transcript {
        Transcript::new(theme(), width)
    }

    fn texts(rows: &[Row]) -> Vec<String> {
        rows.iter().map(Row::plain_text).collect()
    }

    fn call(name: &str, arguments: &str, state: ToolState) -> ToolCall {
        ToolCall {
            id: format!("{name}-1"),
            name: name.to_owned(),
            arguments: arguments.to_owned(),
            args: serde_json::from_str(arguments).ok(),
            args_summary: None,
            state,
            result_summary: None,
            started_at_ms: None,
            duration_ms: None,
            interrupted: false,
            files_read: Vec::new(),
            files_modified: Vec::new(),
            exit_code: None,
        }
    }

    fn view(name: &str, arguments: &str) -> ToolView {
        ToolView::from_call(&call(name, arguments, ToolState::Succeeded))
    }

    #[test]
    fn the_header_prints_once_into_scrollback() {
        let mut transcript = transcript(80);
        let rows = transcript.header(&["lyra", "main", "opus-5", "purple-falcon"]);
        assert_eq!(
            texts(&rows),
            ["lyra · lyra · main · opus-5 · purple-falcon"]
        );
        assert_eq!(transcript.entries().count(), 1);
    }

    #[test]
    fn assistant_text_streams_by_line_and_lands_in_the_entry_log() {
        let mut transcript = transcript(40);
        assert!(transcript.assistant_delta("partial").is_empty());
        let rows = transcript.assistant_delta(" line\nsecond line\n");
        assert_eq!(texts(&rows), ["partial line", "second line"]);
        assert!(matches!(
            transcript.last(),
            Some(Entry::Assistant(source)) if source == "partial line\nsecond line\n"
        ));
    }

    #[test]
    fn a_user_turn_closes_the_assistant_block_first() {
        let mut transcript = transcript(40);
        let _ = transcript.assistant_delta("held back with no newline");
        let rows = texts(&transcript.user("next question"));
        assert_eq!(rows, ["held back with no newline", "> next question", ""]);
    }

    #[test]
    fn a_run_of_surveys_holds_in_the_live_region_then_commits_collapsed() {
        let mut transcript = transcript(60);
        assert!(transcript.tool(view("read", r#"{"path":"a"}"#)).is_empty());
        assert!(transcript.tool(view("read", r#"{"path":"b"}"#)).is_empty());
        assert!(transcript.tool(view("grep", r#"{"pattern":"x"}"#)).is_empty());
        assert_eq!(
            texts(&transcript.live_rows()),
            ["▸ read 2 files · searched 1 pattern"],
            "the run forms in the live region"
        );
        let rows = texts(&transcript.tool(view("edit", r#"{"path":"c"}"#)));
        assert_eq!(
            rows,
            ["▸ read 2 files · searched 1 pattern", "▸ edit c"],
            "the run settles as one committed line"
        );
        assert!(transcript.live_rows().is_empty());
    }

    #[test]
    fn a_lone_survey_commits_as_an_ordinary_tool_row() {
        let mut transcript = transcript(60);
        let _ = transcript.tool(view("read", r#"{"path":"a"}"#));
        assert_eq!(texts(&transcript.user("go")), ["▸ read a", "> go", ""]);
    }

    #[test]
    fn expanding_the_last_tool_appends_rather_than_rewriting() {
        let mut transcript = transcript(60);
        let collapsed = texts(&transcript.tool(view(
            "edit",
            r#"{"path":"a.ts","old_string":"const a = 1;","new_string":"const a = 2;"}"#,
        )));
        assert_eq!(collapsed, ["▸ edit a.ts +1 −1"]);

        let expansion = texts(&transcript.expand_last_tool());
        assert!(!expansion.is_empty());
        assert!(
            !expansion.iter().any(|row| row.starts_with("▸ edit")),
            "the collapsed row is not reprinted: {expansion:?}"
        );
        assert!(expansion.iter().any(|row| row.contains("− const a = 1;")), "{expansion:?}");
    }

    #[test]
    fn expanding_twice_is_a_no_op() {
        let mut transcript = transcript(60);
        let _ = transcript.tool(view("edit", r#"{"path":"a.ts","old_string":"x","new_string":"y"}"#));
        assert!(!transcript.expand_last_tool().is_empty());
        assert!(
            transcript.expand_last_tool().is_empty(),
            "a repeated Tab must not duplicate the detail"
        );
        assert_eq!(transcript.last_tool_expanded(), Some(true));
    }

    #[test]
    fn expanding_with_no_tool_call_is_harmless() {
        let mut transcript = transcript(60);
        let _ = transcript.user("hello");
        assert!(transcript.expand_last_tool().is_empty());
        assert_eq!(transcript.last_tool_expanded(), None);
    }

    #[test]
    fn thinking_lives_in_the_live_region_and_commits_as_one_line() {
        let mut transcript = transcript(60);
        transcript.thinking_delta("weighing it up");
        assert!(
            transcript.thinking_live(),
            "a trace in flight is a live block, not an entry"
        );
        assert_eq!(
            texts(&transcript.live_rows()),
            ["∴ thinking", "  weighing it up"]
        );
        let rows = texts(&transcript.end_thinking("weighing it up", Some(23)));
        assert_eq!(rows, ["∴ thought for 23s"]);
        assert!(transcript.live_rows().is_empty());
        // And it replays as what was printed, not as the trace behind it.
        assert_eq!(texts(&transcript.render_all(60)), ["∴ thought for 23s"]);
    }

    #[test]
    fn a_thinking_commit_closes_the_answer_above_it_first() {
        // Order is the whole point: a trace committed above unflushed prose
        // would put the reasoning before the sentence it came after.
        let mut transcript = transcript(60);
        let _ = transcript.assistant_delta("a line with no newline yet");
        transcript.thinking_delta("second thoughts");
        let rows = texts(&transcript.end_thinking("second thoughts", Some(2)));
        assert_eq!(rows, ["a line with no newline yet", "∴ thought for 2s"]);
    }

    #[test]
    fn the_thinking_mode_decides_what_a_finished_trace_leaves_behind() {
        for (mode, expected) in [
            (
                ThinkingMode::Full,
                vec!["∴ thought for 2s".to_owned(), "  weighing it up".to_owned()],
            ),
            (ThinkingMode::Collapsed, vec!["∴ thought for 2s".to_owned()]),
            (ThinkingMode::Off, Vec::new()),
        ] {
            let mut transcript = Transcript::new(theme(), 60).with_thinking(mode);
            transcript.thinking_delta("weighing it up");
            assert_eq!(
                transcript.thinking_live(),
                mode != ThinkingMode::Off,
                "{mode:?}: nothing is buffered when nothing will be shown"
            );
            assert_eq!(
                texts(&transcript.end_thinking("weighing it up", Some(2))),
                expected,
                "{mode:?}"
            );
        }
    }

    #[test]
    fn a_thinking_part_nobody_saw_leaves_nothing_behind() {
        // A `part_end` for a part this client attached after: no live block, no
        // text, no timing. There is nothing true to say about it.
        let mut transcript = transcript(60);
        assert!(transcript.end_thinking("", None).is_empty());
    }

    #[test]
    fn a_replayed_trace_needs_a_duration_or_the_mode_that_asked_for_it() {
        let mut collapsed = transcript(60);
        assert!(
            collapsed.replayed_thinking("a private musing", None).is_empty(),
            "no duration survives a persisted transcript, so there is no line to draw"
        );
        assert_eq!(
            texts(&collapsed.replayed_thinking("a private musing", Some(7))),
            ["∴ thought for 7s"]
        );
        let mut full = Transcript::new(theme(), 60).with_thinking(ThinkingMode::Full);
        assert_eq!(
            texts(&full.replayed_thinking("a private musing", None)),
            ["∴ thought", "  a private musing"]
        );
    }

    #[test]
    fn reliability_entries_reach_scrollback() {
        let mut transcript = transcript(40);
        assert!(texts(&transcript.compacted(-38_214, None))[0].contains("compacted"));
        assert!(texts(&transcript.context_repaired("dropped 2"))[0].contains("/context"));
        assert!(texts(&transcript.loop_warning("same edit"))[0].contains("loop detected"));
        assert!(texts(&transcript.transport_fallback("websocket", "http", None))[0]
            .contains("websocket → http"));
        assert!(texts(&transcript.turn_end("cancelled"))[0].contains("cancelled"));
        assert!(
            transcript.turn_end("end_turn").is_empty(),
            "an ordinary completion leaves no marker"
        );
    }

    #[test]
    fn replay_re_renders_at_the_new_width_rather_than_reusing_old_rows() {
        let mut transcript = transcript(40);
        let _ = transcript.assistant_delta("alpha beta gamma delta epsilon zeta\n");
        let at_40 = texts(&transcript.render_all(40));
        let at_16 = texts(&transcript.render_all(16));
        assert_eq!(at_40, ["alpha beta gamma delta epsilon zeta"]);
        assert_eq!(at_16, ["alpha beta gamma", "delta epsilon", "zeta"]);
        assert_ne!(at_40, at_16, "purge must not reproduce the stale wrapping");
    }

    #[test]
    fn replay_reproduces_exactly_what_a_terminal_of_that_width_would_have_printed() {
        let source = "# Title\n\nsome prose that will wrap at a narrow width\n\n- a list item\n";
        let mut streamed = transcript(24);
        let _ = streamed.assistant_delta(source);
        let _ = streamed.end_assistant();

        let mut native = transcript(24);
        let mut printed = native.assistant_delta(source);
        printed.extend(native.end_assistant());

        assert_eq!(texts(&streamed.replay_rows(24, 100)), texts(&printed));
    }

    #[test]
    fn replay_is_capped() {
        let mut transcript = transcript(40);
        for index in 0..500 {
            let _ = transcript.assistant_delta(&format!("line {index}\n"));
        }
        let _ = transcript.end_assistant();
        assert_eq!(transcript.replay_rows(40, 50).len(), 50);
        assert_eq!(
            texts(&transcript.replay_rows(40, 50)).last().unwrap(),
            "line 499"
        );
    }

    #[test]
    fn the_entry_log_is_bounded() {
        let mut transcript = Transcript::new(theme(), 40).with_entry_cap(10);
        for index in 0..100 {
            let _ = transcript.user(&format!("message {index}"));
        }
        assert_eq!(transcript.entries().count(), 10);
        assert!(matches!(
            transcript.entries().next(),
            Some(Entry::User(text)) if text == "message 90"
        ));
    }

    #[test]
    fn an_expanded_tool_stays_expanded_through_a_replay() {
        let mut transcript = transcript(60);
        let _ = transcript.tool(view(
            "edit",
            r#"{"path":"a.ts","old_string":"const a = 1;","new_string":"const a = 2;"}"#,
        ));
        let _ = transcript.expand_last_tool();
        let replayed = texts(&transcript.render_all(60));
        assert!(replayed[0].starts_with("▸ edit"));
        assert!(replayed.iter().any(|row| row.contains("− const a = 1;")), "{replayed:?}");
    }

    #[test]
    fn a_width_change_only_moves_the_unstable_tail() {
        let mut transcript = transcript(40);
        let committed = texts(&transcript.assistant_delta("alpha beta gamma\n"));
        assert_eq!(committed, ["alpha beta gamma"]);
        transcript.set_width(12);
        let later = texts(&transcript.assistant_delta("delta epsilon zeta\n"));
        assert_eq!(later, ["delta", "epsilon zeta"]);
    }

    #[test]
    fn a_retheme_applies_to_what_comes_next() {
        let mut transcript = transcript(40);
        transcript.set_theme(Theme::ember());
        assert_eq!(transcript.theme().name, "ember");
        let rows = transcript.header(&["p"]);
        assert_eq!(rows[0].spans[0].style.fg, Theme::ember().tokens.accent.as_fg());
    }

    #[test]
    fn every_replayed_row_fits_the_width_it_was_replayed_at() {
        let mut transcript = transcript(80);
        let _ = transcript.header(&["project", "main", "opus-5", "workspace"]);
        let _ = transcript.user("a question that is long enough to need wrapping somewhere");
        let _ = transcript.assistant_delta("| a | b |\n|---|---|\n| 1 | 2 |\n\nprose\n");
        let _ = transcript.end_assistant();
        let _ = transcript.tool(view("bash", r#"{"command":"cargo test --all-features"}"#));
        let _ = transcript.compacted(-12_000, Some(3));
        for width in [12u16, 20, 40, 100] {
            for row in transcript.render_all(width) {
                assert!(
                    row.width() <= usize::from(width),
                    "width {width}: {:?}",
                    row.plain_text()
                );
            }
        }
    }
}
