//! Session store: the client-side model of a conversation (DESIGN.md §2, phase 3).
//!
//! The daemon sends **semantic deltas**, not UI state. This module is the only
//! place those deltas are folded into something renderable, and the only place
//! the canonical [`Update`](crate::acp::types::Update) union is interpreted —
//! the render loop never inspects a wire type directly.
//!
//! Four properties are load-bearing and each has tests below:
//!
//! 1. **Delta application is append-only per field.** `{messageId, partId,
//!    field, delta}` appends to exactly one string. No part is ever rewritten
//!    wholesale, so a committed scrollback row can never be invalidated by a
//!    later delta for the same part.
//! 2. **Ordered inserts, out-of-order tolerant.** Every message and part carries
//!    a monotone `seq`. An event for an unseen id materialises the entity in
//!    `seq` order via binary search rather than dropping it, so a reordered pipe
//!    degrades to correct-but-late rather than to a hole.
//! 3. **Live wins over hydration.** A snapshot fetched at connect can land
//!    *after* live events for the same parts have already been applied.
//!    [`SessionStore::hydrate`] fills only what the live stream has not touched.
//! 4. **No pause is left hanging.** Every pause bracket the store opens (retry,
//!    compaction, context repair, steer, transport fallback) is closed by an
//!    explicit `turn_resume`, and self-heals if content resumes without one.
//!
//! # Raw measurements only
//!
//! DESIGN.md §2: token counts cross the wire as numbers and percentages are
//! derived here. [`SessionStore::context_fraction`] returns `None` when no
//! verified context window is known, because rendering nothing beats rendering a
//! wrong number.

use std::collections::{HashMap, HashSet};

use crate::acp::types as wire;

/// Identifier of a message within a session.
pub type MessageId = String;
/// Identifier of a part within a message.
pub type PartId = String;

/// Who produced a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The human, or a synthetic steering turn (DESIGN.md §0.2).
    User,
    /// The model.
    Assistant,
}

/// Which append-only field a delta targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    /// Visible assistant text.
    Text,
    /// Reasoning text.
    Thinking,
    /// The signature sealing a completed thinking block.
    Signature,
    /// Serialized tool arguments, streamed as a JSON fragment.
    ToolArguments,
}

impl Field {
    /// Map the wire field onto the store's. An unrecognised field has no
    /// destination, so it is dropped rather than guessed at.
    #[must_use]
    pub fn from_wire(field: &wire::DeltaField) -> Option<Self> {
        match field {
            wire::DeltaField::Text => Some(Self::Text),
            wire::DeltaField::Thinking => Some(Self::Thinking),
            wire::DeltaField::Signature => Some(Self::Signature),
            wire::DeltaField::Arguments => Some(Self::ToolArguments),
            wire::DeltaField::Other(_) => None,
        }
    }
}

/// A semantic delta, in the shape DESIGN.md §2 specifies.
#[derive(Debug, Clone)]
pub struct Delta {
    /// Target message.
    pub message_id: MessageId,
    /// Target part.
    pub part_id: PartId,
    /// Target field.
    pub field: Field,
    /// Text to append.
    pub delta: String,
    /// Ordering hint. `None` means "at the end as currently known".
    pub seq: Option<u64>,
}

/// Lifecycle of a tool call.
///
/// DESIGN.md §3 maps these to the transcript grammar: dim while `Pending`,
/// accent on `Running`, plain on `Succeeded`, error on `Failed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolState {
    /// Arguments are still streaming.
    Pending,
    /// Executing.
    Running,
    /// Finished without error.
    Succeeded,
    /// Finished with an error.
    Failed,
    /// Refused by the permission layer.
    Denied,
}

impl ToolState {
    /// The terminal state a `tool_call_end` status names.
    #[must_use]
    pub fn from_wire(status: &wire::ToolStatus) -> Self {
        match status {
            wire::ToolStatus::Ok => Self::Succeeded,
            wire::ToolStatus::Denied => Self::Denied,
            // An unmodelled status is a failure the user must still see, which is
            // the safe side to err on for a row that may report a write.
            wire::ToolStatus::Error | wire::ToolStatus::Other(_) => Self::Failed,
        }
    }

    /// Whether the call has stopped moving.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Denied)
    }
}

/// A tool call attached to an assistant message.
#[derive(Debug, Clone)]
pub struct ToolCall {
    /// Provider-assigned call id, stable from start to end.
    pub id: String,
    /// Tool name. Empty until a frame carrying it arrives.
    pub name: String,
    /// Accumulated argument JSON fragment, as streamed.
    pub arguments: String,
    /// Parsed arguments, once the model finished streaming them.
    pub args: Option<serde_json::Value>,
    /// One-line argument summary — the collapsed row's subject.
    pub args_summary: Option<String>,
    /// Current lifecycle state.
    pub state: ToolState,
    /// First meaningful line of the result — the collapsed row's outcome.
    pub result_summary: Option<String>,
    /// Wall-clock instant execution began.
    pub started_at_ms: Option<i64>,
    /// How long it ran, once finished.
    pub duration_ms: Option<u64>,
    /// Whether a wait-class tool was cut short by steering (DESIGN.md §0.2).
    pub interrupted: bool,
    /// Paths the tool reported reading.
    pub files_read: Vec<String>,
    /// Paths the tool reported modifying.
    pub files_modified: Vec<String>,
    /// Exit code, for command tools.
    pub exit_code: Option<i64>,
}

impl ToolCall {
    fn new(id: &str) -> Self {
        Self {
            id: id.to_owned(),
            name: String::new(),
            arguments: String::new(),
            args: None,
            args_summary: None,
            state: ToolState::Pending,
            result_summary: None,
            started_at_ms: None,
            duration_ms: None,
            interrupted: false,
            files_read: Vec::new(),
            files_modified: Vec::new(),
            exit_code: None,
        }
    }
}

/// What a part holds.
#[derive(Debug, Clone)]
pub enum PartBody {
    /// Visible assistant or user text.
    Text(String),
    /// Reasoning text and the signature that seals it.
    Thinking {
        /// The reasoning text.
        text: String,
        /// Provider signature, appended by `field: "signature"` deltas.
        signature: String,
    },
    /// Opaque provider reasoning, carried raw and never reinterpreted.
    Reasoning {
        /// Which provider produced it.
        provider: String,
        /// The payload.
        item: serde_json::Value,
    },
    /// A tool call.
    Tool(Box<ToolCall>),
}

/// One addressable unit of a message.
#[derive(Debug, Clone)]
pub struct Part {
    /// Part id.
    pub id: PartId,
    /// Ordering key within the message.
    pub seq: u64,
    /// Payload.
    pub body: PartBody,
    /// Whether `part_end` has arrived. A finished part can never grow again,
    /// which is what makes its rows safe to commit to scrollback.
    pub complete: bool,
}

impl Part {
    /// The part's text, if it has any.
    #[must_use]
    pub fn text(&self) -> Option<&str> {
        match &self.body {
            PartBody::Text(text) | PartBody::Thinking { text, .. } => Some(text),
            PartBody::Reasoning { .. } | PartBody::Tool(_) => None,
        }
    }

    /// The tool call this part holds, if it holds one.
    #[must_use]
    pub fn tool(&self) -> Option<&ToolCall> {
        match &self.body {
            PartBody::Tool(call) => Some(call.as_ref()),
            _ => None,
        }
    }
}

/// A message and its parts.
#[derive(Debug, Clone)]
pub struct Message {
    /// Message id.
    pub id: MessageId,
    /// Ordering key within the session.
    pub seq: u64,
    /// Author.
    pub role: Role,
    /// The turn this message belongs to, when the daemon named one.
    pub turn_id: Option<String>,
    /// Ordered parts.
    pub parts: Vec<Part>,
    /// Whether the message is still being produced.
    pub complete: bool,
    /// Why it stopped, once it has.
    pub stop_reason: Option<wire::StopReason>,
    index: HashMap<PartId, usize>,
}

impl Message {
    fn new(id: MessageId, seq: u64, role: Role) -> Self {
        Self {
            id,
            seq,
            role,
            turn_id: None,
            parts: Vec::new(),
            complete: false,
            stop_reason: None,
            index: HashMap::new(),
        }
    }

    /// Look a part up by id.
    #[must_use]
    pub fn part(&self, id: &str) -> Option<&Part> {
        self.index.get(id).and_then(|slot| self.parts.get(*slot))
    }

    /// Concatenated visible text across every text part.
    #[must_use]
    pub fn text(&self) -> String {
        self.parts
            .iter()
            .filter_map(|part| match &part.body {
                PartBody::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    /// Concatenated reasoning text.
    #[must_use]
    pub fn thinking(&self) -> String {
        self.parts
            .iter()
            .filter_map(|part| match &part.body {
                PartBody::Thinking { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn upsert(&mut self, id: &str, seq: u64, make: impl FnOnce() -> PartBody) -> usize {
        if let Some(slot) = self.index.get(id) {
            return *slot;
        }
        let part = Part {
            id: id.to_owned(),
            seq,
            body: make(),
            complete: false,
        };
        let at = self.parts.partition_point(|existing| existing.seq <= seq);
        self.parts.insert(at, part);
        self.reindex();
        at
    }

    fn reindex(&mut self) {
        self.index.clear();
        for (slot, part) in self.parts.iter().enumerate() {
            self.index.insert(part.id.clone(), slot);
        }
    }
}

/// A retry in flight, with everything the footer countdown needs.
///
/// DESIGN.md §3 renders this as `⟳ rate limited · retry 2/8 · 4s` with a live
/// 1 Hz countdown, escalating to full detail at attempt ≥ 4.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryState {
    /// 1-based attempt number.
    pub attempt: u32,
    /// Attempt ceiling.
    pub max_attempts: u32,
    /// How the provider layer classified the failure.
    pub classification: wire::Classification,
    /// The provider's own message.
    pub provider_message: String,
    /// Delay before the next attempt.
    pub delay_ms: u64,
    /// Wall-clock instant of the next attempt — the countdown's anchor.
    pub retry_at_ms: i64,
    /// Whether partial output the client already rendered was discarded.
    pub resets_partial_output: bool,
}

impl RetryState {
    /// Milliseconds left before the next attempt, floored at zero.
    #[must_use]
    pub const fn remaining_ms(&self, now_ms: i64) -> u64 {
        let remaining = self.retry_at_ms - now_ms;
        if remaining <= 0 {
            0
        } else {
            remaining.unsigned_abs()
        }
    }

    /// Whole seconds left, for the 1 Hz countdown.
    #[must_use]
    pub fn remaining_secs(&self, now_ms: i64) -> u64 {
        self.remaining_ms(now_ms).div_ceil(1_000)
    }

    /// Whether DESIGN.md §3's escalation threshold has been crossed.
    #[must_use]
    pub const fn is_escalated(&self) -> bool {
        self.attempt >= 4
    }
}

/// How a turn ended, with all five terminal statuses represented.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnOutcome {
    /// The turn.
    pub turn_id: String,
    /// Terminal disposition.
    pub status: wire::TurnStatus,
    /// Provider stop reason, when there was one.
    pub stop_reason: Option<wire::StopReason>,
    /// Total duration.
    pub duration_ms: u64,
    /// Whether assistant output survived a cancel or truncation.
    pub partial_retained: bool,
    /// Whether the prompt was trimmed from history because the client rewound it
    /// into the composer.
    pub prompt_trimmed: bool,
    /// Whether the loop detector demanded a hard stop.
    pub hard_stop_requested: bool,
    /// The failure, for `status: error`.
    pub error: Option<wire::ProviderError>,
}

/// The turn currently running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveTurn {
    /// The turn.
    pub id: String,
    /// What started it.
    pub source: wire::TurnSource,
    /// Wall-clock start.
    pub started_at_ms: i64,
}

/// Where the current turn stands.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum TurnPhase {
    /// No turn running.
    #[default]
    Idle,
    /// A turn is streaming.
    Streaming,
    /// Between provider attempts.
    Retrying(RetryState),
    /// Paused inside a bracket that is not a retry. Closed by `turn_resume`.
    Paused(wire::PauseKind),
    /// The turn ended.
    Ended(TurnOutcome),
}

impl TurnPhase {
    /// Whether the turn is between attempts or inside a pause bracket.
    #[must_use]
    pub const fn is_paused(&self) -> bool {
        matches!(self, Self::Retrying(_) | Self::Paused(_))
    }

    /// Whether the client should be showing activity.
    #[must_use]
    pub const fn is_active(&self) -> bool {
        matches!(self, Self::Streaming) || self.is_paused()
    }

    /// The retry in flight, when there is one.
    #[must_use]
    pub fn retry(&self) -> Option<&RetryState> {
        match self {
            Self::Retrying(retry) => Some(retry),
            _ => None,
        }
    }

    /// The outcome, once the turn has ended.
    #[must_use]
    pub fn outcome(&self) -> Option<&TurnOutcome> {
        match self {
            Self::Ended(outcome) => Some(outcome),
            _ => None,
        }
    }
}

/// A compaction boundary, as the transcript will draw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionBoundary {
    /// Boundary entry id.
    pub boundary_id: String,
    /// Context size before.
    pub tokens_before: u64,
    /// Context size after.
    pub tokens_after: u64,
    /// First transcript entry surviving the boundary; `None` means everything
    /// before it was cleared.
    pub first_kept_entry: Option<String>,
}

impl CompactionBoundary {
    /// Tokens reclaimed, for `─ compacted · −38k tokens ─`.
    #[must_use]
    pub const fn tokens_reclaimed(&self) -> u64 {
        self.tokens_before.saturating_sub(self.tokens_after)
    }
}

/// Cumulative token accounting, held as raw counts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UsageTotals {
    /// Prompt tokens for the most recent call.
    pub input_tokens: u64,
    /// Completion tokens for the most recent call.
    pub output_tokens: u64,
    /// Tokens served from cache on the most recent call.
    pub cache_read_tokens: Option<u64>,
    /// Tokens written to cache on the most recent call.
    pub cache_write_tokens: Option<u64>,
    /// Cumulative prompt tokens.
    pub session_input_tokens: u64,
    /// Cumulative completion tokens.
    pub session_output_tokens: u64,
    /// Cumulative cost. `None` when the active model has no known pricing —
    /// never estimated.
    pub cost_micro_usd: Option<u64>,
}

/// The client-side conversation model.
#[derive(Debug, Default)]
pub struct SessionStore {
    messages: Vec<Message>,
    index: HashMap<MessageId, usize>,
    /// `(message_id, part_id)` pairs the live stream has written to.
    live_parts: HashSet<(MessageId, PartId)>,
    /// `tool_call_id` → where its part lives.
    tool_index: HashMap<String, (MessageId, PartId)>,
    phase: TurnPhase,
    turn: Option<ActiveTurn>,
    /// Retry that has not yet been superseded, kept for the countdown.
    retry: Option<RetryState>,
    usage: Option<UsageTotals>,
    context: Option<wire::ContextMeasurement>,
    compactions: Vec<CompactionBoundary>,
    repairs: Vec<wire::ContextRepair>,
    transport_fallbacks: Vec<wire::TransportFallback>,
    loop_warnings: Vec<wire::LoopWarningUpdate>,
    steers: Vec<wire::Steer>,
    reports: Vec<String>,
    errors: Vec<wire::ProviderError>,
    unknown: Vec<wire::UnknownUpdate>,
    /// Live children, newest transition wins, in the order they were first seen.
    agents: Vec<wire::AgentUpdate>,
    /// Children the live stream has reported. Hydration fills only what is *not*
    /// in here — the same "live wins" rule parts obey, for the same reason: a
    /// snapshot fetched at attach can land after a transition that supersedes it.
    live_agents: HashSet<String>,
    pending_steer: u64,
    descriptor: Option<wire::SessionDescriptor>,
    provider: Option<String>,
    model: Option<String>,
    api_type: Option<wire::ApiType>,
    next_seq: u64,
    current_assistant: Option<MessageId>,
    hydrated: bool,
}

impl SessionStore {
    /// An empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    // -- reads -------------------------------------------------------------

    /// Messages in session order.
    #[must_use]
    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    /// Look a message up by id.
    #[must_use]
    pub fn message(&self, id: &str) -> Option<&Message> {
        self.index.get(id).and_then(|slot| self.messages.get(*slot))
    }

    /// Where the current turn stands.
    #[must_use]
    pub const fn phase(&self) -> &TurnPhase {
        &self.phase
    }

    /// The turn currently running, if any.
    #[must_use]
    pub const fn turn(&self) -> Option<&ActiveTurn> {
        self.turn.as_ref()
    }

    /// The retry in flight, for the footer countdown.
    #[must_use]
    pub const fn retry(&self) -> Option<&RetryState> {
        self.retry.as_ref()
    }

    /// Latest token accounting, if the daemon has sent any.
    #[must_use]
    pub const fn usage(&self) -> Option<&UsageTotals> {
        self.usage.as_ref()
    }

    /// Latest context measurement, if the daemon has sent one.
    #[must_use]
    pub const fn context(&self) -> Option<&wire::ContextMeasurement> {
        self.context.as_ref()
    }

    /// Fraction of the context window in use.
    ///
    /// `None` when no *verified* window is known: DESIGN.md §2 says render
    /// nothing rather than a wrong number.
    #[must_use]
    pub fn context_fraction(&self) -> Option<f64> {
        self.context
            .as_ref()
            .and_then(wire::ContextMeasurement::fraction_used)
    }

    /// Compaction boundaries, oldest first.
    #[must_use]
    pub fn compactions(&self) -> &[CompactionBoundary] {
        &self.compactions
    }

    /// Context repairs, oldest first. `/context` links back to these.
    #[must_use]
    pub fn repairs(&self) -> &[wire::ContextRepair] {
        &self.repairs
    }

    /// Transport fallbacks observed this session.
    #[must_use]
    pub fn transport_fallbacks(&self) -> &[wire::TransportFallback] {
        &self.transport_fallbacks
    }

    /// Loop-detector warnings, oldest first.
    #[must_use]
    pub fn loop_warnings(&self) -> &[wire::LoopWarningUpdate] {
        &self.loop_warnings
    }

    /// Steering messages the daemon has confirmed landing, oldest first.
    #[must_use]
    pub fn steers(&self) -> &[wire::Steer] {
        &self.steers
    }

    /// Steering messages sent but not yet acknowledged by a `steer` update.
    #[must_use]
    pub const fn pending_steer(&self) -> u64 {
        self.pending_steer
    }

    /// Audit lines from background subsystems, oldest first.
    #[must_use]
    pub fn reports(&self) -> &[String] {
        &self.reports
    }

    /// Provider failures reported outside a turn's terminal status.
    #[must_use]
    pub fn errors(&self) -> &[wire::ProviderError] {
        &self.errors
    }

    /// Updates this build does not model. Kept so they can be shown as dim audit
    /// rows instead of vanishing.
    #[must_use]
    pub fn unknown_updates(&self) -> &[wire::UnknownUpdate] {
        &self.unknown
    }

    /// The children this session has spawned, each at its latest reported state,
    /// in the order they were first seen.
    ///
    /// This is what the presence strip (`ui::agent`) draws and what the
    /// lifecycle audit rows are diffed against. Spawn order is deliberate: a
    /// strip whose dots reshuffled as children changed state would be unreadable
    /// at exactly the moment it matters.
    #[must_use]
    pub fn agents(&self) -> &[wire::AgentUpdate] {
        &self.agents
    }

    /// One child by spawn id.
    ///
    /// The caller that matters is the transcript's: it reads the state a child
    /// was in *before* an update is applied, because "what changed" is what
    /// earns an audit row and the update itself only carries "what it is now".
    #[must_use]
    pub fn agent(&self, id: &str) -> Option<&wire::AgentUpdate> {
        self.agents.iter().find(|known| known.id == id)
    }

    /// The session the daemon says is active.
    #[must_use]
    pub const fn descriptor(&self) -> Option<&wire::SessionDescriptor> {
        self.descriptor.as_ref()
    }

    /// Active provider, once known.
    #[must_use]
    pub fn provider(&self) -> Option<&str> {
        self.provider.as_deref()
    }

    /// Active model, once known.
    #[must_use]
    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    /// Transport the active model runs on, once known.
    #[must_use]
    pub const fn api_type(&self) -> Option<&wire::ApiType> {
        self.api_type.as_ref()
    }

    /// Whether a hydration snapshot has been folded in.
    #[must_use]
    pub const fn hydrated(&self) -> bool {
        self.hydrated
    }

    /// Every tool call in the session, in message then part order.
    #[must_use]
    pub fn tool_calls(&self) -> Vec<&ToolCall> {
        self.messages
            .iter()
            .flat_map(|message| &message.parts)
            .filter_map(Part::tool)
            .collect()
    }

    /// One tool call by id, through the index rather than a scan.
    ///
    /// The render loop looks a call up every time one ends, so this must not be
    /// linear in the length of the session.
    #[must_use]
    pub fn tool_call(&self, tool_call_id: &str) -> Option<&ToolCall> {
        let (message_id, part_id) = self.tool_index.get(tool_call_id)?;
        self.message(message_id)?.part(part_id)?.tool()
    }

    /// The most recent tool call, which `Tab` expands (DESIGN.md §3).
    #[must_use]
    pub fn last_tool_call(&self) -> Option<&ToolCall> {
        self.messages
            .iter()
            .rev()
            .flat_map(|message| message.parts.iter().rev())
            .find_map(Part::tool)
    }

    /// The assistant message currently being produced.
    #[must_use]
    pub fn active_assistant(&self) -> Option<&Message> {
        self.current_assistant
            .as_deref()
            .and_then(|id| self.message(id))
    }

    // -- mutation ----------------------------------------------------------

    /// Insert (or return) a message, keeping `messages` ordered by `seq`.
    pub fn upsert_message(&mut self, id: &str, role: Role, seq: Option<u64>) -> &mut Message {
        if let Some(slot) = self.index.get(id) {
            let slot = *slot;
            return &mut self.messages[slot];
        }
        let seq = seq.unwrap_or_else(|| self.take_seq());
        self.next_seq = self.next_seq.max(seq + 1);
        let at = self.messages.partition_point(|existing| existing.seq <= seq);
        self.messages
            .insert(at, Message::new(id.to_owned(), seq, role));
        self.reindex();
        let slot = self.index[id];
        &mut self.messages[slot]
    }

    /// Apply one semantic delta.
    ///
    /// Creates the message and part if they have not been seen, so an event that
    /// overtakes its `*_start` still lands in the right place.
    pub fn apply_delta(&mut self, delta: &Delta) {
        let part_seq = delta.seq.unwrap_or_else(|| self.take_seq());
        let field = delta.field;
        let part_id = delta.part_id.clone();
        let text = delta.delta.clone();

        let message = self.upsert_message(&delta.message_id, Role::Assistant, None);
        let slot = message.upsert(&part_id, part_seq, || match field {
            Field::Text => PartBody::Text(String::new()),
            Field::Thinking | Field::Signature => PartBody::Thinking {
                text: String::new(),
                signature: String::new(),
            },
            Field::ToolArguments => PartBody::Tool(Box::new(ToolCall::new(&part_id))),
        });
        match (&mut message.parts[slot].body, field) {
            (PartBody::Text(buffer), Field::Text)
            | (PartBody::Thinking { text: buffer, .. }, Field::Thinking)
            | (PartBody::Thinking { signature: buffer, .. }, Field::Signature) => {
                buffer.push_str(&text);
            }
            (PartBody::Tool(call), Field::ToolArguments) => call.arguments.push_str(&text),
            // A field/part-kind mismatch means the daemon reused a part id across
            // kinds. Dropping the delta is the only non-destructive answer.
            _ => {}
        }
        self.live_parts
            .insert((delta.message_id.clone(), delta.part_id.clone()));
    }

    /// Fold one canonical update into the store.
    ///
    /// This is the single translation point from wire to model. Every variant is
    /// handled; an unmodelled one is recorded rather than dropped.
    pub fn apply(&mut self, update: &wire::Update) {
        match update {
            wire::Update::TurnStart(start) => self.on_turn_start(start),
            wire::Update::TurnResume(resume) => self.on_turn_resume(resume),
            wire::Update::TurnEnd(end) => self.on_turn_end(end),
            wire::Update::MessageStart(start) => self.on_message_start(start),
            wire::Update::PartStart(start) => self.on_part_start(start),
            wire::Update::Delta(delta) => self.on_delta(delta),
            wire::Update::PartEnd(end) => self.on_part_end(end),
            wire::Update::ReasoningItem(item) => self.on_reasoning_item(item),
            wire::Update::MessageEnd(end) => self.on_message_end(end),
            wire::Update::ToolCallStart(start) => self.on_tool_call_start(start),
            wire::Update::ToolCallUpdate(progress) => self.on_tool_call_update(progress),
            wire::Update::ToolCallEnd(end) => self.on_tool_call_end(end),
            wire::Update::Retry(retry) => self.on_retry(retry),
            wire::Update::Compaction(compaction) => self.on_compaction(compaction),
            wire::Update::ContextRepair(repairs) => self.on_context_repair(repairs),
            wire::Update::Context(context) => self.context = Some(context.clone()),
            wire::Update::Usage(usage) => self.on_usage(usage),
            wire::Update::Steer(steer) => self.on_steer(steer),
            // A loop warning is an inline note, not a pause: the schema has no
            // `loop_warning` pause kind, so nothing here may open a bracket that
            // no `turn_resume` will ever close.
            wire::Update::LoopWarning(warning) => self.loop_warnings.push(warning.clone()),
            wire::Update::TransportFallback(fallback) => self.on_transport_fallback(fallback),
            wire::Update::Error(error) => self.errors.push(error.error.clone()),
            wire::Update::Report(report) => self.reports.push(report.message.clone()),
            wire::Update::ModelChanged(changed) => {
                self.provider = Some(changed.provider.clone());
                self.model = Some(changed.model.clone());
                self.api_type.clone_from(&changed.api_type);
            }
            wire::Update::SessionChanged(changed) => self.on_session_changed(changed),
            // Upserted by spawn id, so a child appears once and its row moves
            // through the lifecycle rather than accumulating one entry per step.
            wire::Update::Agent(agent) => {
                self.live_agents.insert(agent.id.clone());
                self.upsert_agent(agent);
            }
            wire::Update::Unknown(unknown) => self.unknown.push(unknown.clone()),
        }
    }

    /// Record that a steering message has been sent but not yet drained.
    ///
    /// `pending` is the daemon's own count when it supplied one; the local
    /// increment is the fallback so the `N queued` display is never behind.
    pub fn note_steer_sent(&mut self, pending: Option<u64>) {
        self.pending_steer = pending.unwrap_or(self.pending_steer + 1);
    }

    /// Fold the well-defined half of a `session/snapshot` result in.
    ///
    /// Transcript entries are deliberately not touched here: the schema declares
    /// them as opaque objects, so they are hydrated through [`Self::hydrate`]
    /// with a shape this crate controls.
    pub fn apply_snapshot_meta(&mut self, snapshot: &wire::SessionSnapshot) {
        self.descriptor = Some(snapshot.descriptor.clone());
        // A client attaching mid-session gets its presence strip from hydration
        // rather than waiting for the next transition — but a transition that
        // has already arrived is newer than the snapshot that was in flight
        // beside it, and wins.
        for handle in &snapshot.agents {
            if !self.live_agents.contains(&handle.id) {
                self.upsert_agent(&handle.as_update());
            }
        }
        if !snapshot.provider.is_empty() {
            self.provider = Some(snapshot.provider.clone());
        }
        if !snapshot.model.is_empty() {
            self.model = Some(snapshot.model.clone());
        }
        if snapshot.api_type.is_some() {
            self.api_type.clone_from(&snapshot.api_type);
        }
        if let Some(pending) = snapshot.pending_steer {
            self.pending_steer = pending;
        }
        if snapshot.turn_active == Some(true) && self.phase == TurnPhase::Idle {
            self.phase = TurnPhase::Streaming;
        }
        if let Some(usage) = snapshot.usage {
            // Live usage wins: a snapshot taken before the last call must not
            // walk the counters backwards.
            let totals = self.usage.get_or_insert_with(UsageTotals::default);
            totals.session_input_tokens =
                totals.session_input_tokens.max(usage.session.input_tokens);
            totals.session_output_tokens =
                totals.session_output_tokens.max(usage.session.output_tokens);
            if totals.cost_micro_usd.is_none() {
                totals.cost_micro_usd = usage.session.cost_micro_usd;
            }
            if self.context.is_none()
                && let Some(tokens) = usage.context_tokens
            {
                self.context = Some(wire::ContextMeasurement {
                    token_estimate: tokens,
                    source_entry_count: 0,
                    context_window: usage.context_window,
                });
            }
        }
    }

    /// Fold a transcript snapshot in without clobbering live output.
    ///
    /// A part already written to by the live stream keeps its live content; the
    /// snapshot supplies only what the live stream has not touched. This is the
    /// hydration race guard DESIGN.md build phase 3 calls for.
    pub fn hydrate(&mut self, snapshot: Vec<HydratedMessage>) {
        for hydrated in snapshot {
            let existing_role = self.message(&hydrated.id).map(|message| message.role);
            let role = existing_role.unwrap_or(hydrated.role);
            let message_id = hydrated.id.clone();
            self.upsert_message(&hydrated.id, role, Some(hydrated.seq));
            for (offset, part) in hydrated.parts.into_iter().enumerate() {
                if self
                    .live_parts
                    .contains(&(message_id.clone(), part.id.clone()))
                {
                    continue;
                }
                let message = self.index[&message_id];
                let message = &mut self.messages[message];
                let seq = part.seq.unwrap_or(offset as u64);
                let slot = message.upsert(&part.id, seq, || part.body.clone());
                // An untouched part that already exists came from an earlier
                // snapshot; the newer snapshot is authoritative for it.
                message.parts[slot].body = part.body;
            }
            if hydrated.complete {
                let slot = self.index[&message_id];
                self.messages[slot].complete = true;
            }
        }
        self.hydrated = true;
    }

    /// Drop every message and reset streaming state, keeping session identity.
    ///
    /// Used when `session_changed` says the transcript underneath us was
    /// replaced: the client re-hydrates from `session/snapshot` rather than
    /// trying to reconcile.
    pub fn reset_transcript(&mut self) {
        self.messages.clear();
        self.index.clear();
        self.live_parts.clear();
        self.tool_index.clear();
        self.current_assistant = None;
        self.phase = TurnPhase::Idle;
        self.turn = None;
        self.retry = None;
        self.pending_steer = 0;
        self.hydrated = false;
        self.next_seq = 0;
        // The children belong to the transcript that was replaced. Dropping them
        // rather than carrying them over is what makes the presence strip agree
        // with the session on screen: the snapshot that follows re-hydrates
        // whatever is genuinely still running.
        self.agents.clear();
        self.live_agents.clear();
    }

    // -- variant handlers --------------------------------------------------

    fn on_turn_start(&mut self, start: &wire::TurnStart) {
        self.turn = Some(ActiveTurn {
            id: start.turn_id.clone(),
            source: start.source.clone(),
            started_at_ms: start.started_at_ms,
        });
        self.retry = None;
        self.phase = TurnPhase::Streaming;
        self.current_assistant = None;
    }

    fn on_turn_resume(&mut self, resume: &wire::TurnResume) {
        if matches!(resume.after, wire::PauseKind::Retry) {
            self.retry = None;
        }
        self.close_pause();
    }

    fn on_turn_end(&mut self, end: &wire::TurnEnd) {
        if let Some(slot) = self
            .current_assistant
            .as_ref()
            .and_then(|id| self.index.get(id))
            .copied()
        {
            self.messages[slot].complete = true;
        }
        self.phase = TurnPhase::Ended(TurnOutcome {
            turn_id: end.turn_id.clone(),
            status: end.status.clone(),
            stop_reason: end.stop_reason.clone(),
            duration_ms: end.duration_ms,
            partial_retained: end.partial_retained,
            prompt_trimmed: end.prompt_trimmed.unwrap_or(false),
            hard_stop_requested: end.hard_stop_requested.unwrap_or(false),
            error: end.error.clone(),
        });
        self.turn = None;
        self.retry = None;
        self.current_assistant = None;
    }

    fn on_message_start(&mut self, start: &wire::MessageStart) {
        self.resume_streaming();
        let turn_id = start.turn_id.clone();
        let role = if start.role == "assistant" {
            Role::Assistant
        } else {
            Role::User
        };
        let message = self.upsert_message(&start.message_id, role, None);
        message.turn_id = Some(turn_id);
        if role == Role::Assistant {
            self.current_assistant = Some(start.message_id.clone());
        }
    }

    fn on_part_start(&mut self, start: &wire::PartStart) {
        self.resume_streaming();
        let seq = self.take_seq();
        let kind = start.kind.clone();
        let tool_call_id = start.tool_call_id.clone();
        let part_id = start.part_id.clone();
        let message = self.upsert_message(&start.message_id, Role::Assistant, None);
        message.upsert(&part_id, seq, || match kind {
            wire::PartKind::Text => PartBody::Text(String::new()),
            wire::PartKind::Thinking => PartBody::Thinking {
                text: String::new(),
                signature: String::new(),
            },
            wire::PartKind::Reasoning => PartBody::Reasoning {
                provider: String::new(),
                item: serde_json::Value::Null,
            },
            wire::PartKind::ToolCall => PartBody::Tool(Box::new(ToolCall::new(
                tool_call_id.as_deref().unwrap_or(part_id.as_str()),
            ))),
            // A part kind added after this build renders as text rather than as
            // a bogus tool row: showing the content plainly beats inventing a
            // grammar for it.
            wire::PartKind::Other(_) => PartBody::Text(String::new()),
        });
        if let Some(tool_call_id) = start.tool_call_id.clone() {
            self.tool_index
                .insert(tool_call_id, (start.message_id.clone(), part_id));
        }
    }

    fn on_delta(&mut self, delta: &wire::Delta) {
        self.resume_streaming();
        let Some(field) = Field::from_wire(&delta.field) else {
            return;
        };
        self.current_assistant = Some(delta.message_id.clone());
        self.apply_delta(&Delta {
            message_id: delta.message_id.clone(),
            part_id: delta.part_id.clone(),
            field,
            delta: delta.delta.clone(),
            seq: None,
        });
    }

    fn on_part_end(&mut self, end: &wire::PartEnd) {
        if let Some(slot) = self.index.get(&end.message_id).copied() {
            let message = &mut self.messages[slot];
            if let Some(part) = message.index.get(&end.part_id).copied() {
                message.parts[part].complete = true;
            }
        }
    }

    fn on_reasoning_item(&mut self, item: &wire::ReasoningItem) {
        self.resume_streaming();
        let seq = self.take_seq();
        let provider = item.provider.clone();
        let payload = item.item.clone();
        let part_id = item.part_id.clone();
        let message = self.upsert_message(&item.message_id, Role::Assistant, None);
        let slot = message.upsert(&part_id, seq, || PartBody::Reasoning {
            provider: provider.clone(),
            item: payload.clone(),
        });
        message.parts[slot].body = PartBody::Reasoning {
            provider,
            item: payload,
        };
        self.live_parts
            .insert((item.message_id.clone(), item.part_id.clone()));
    }

    fn on_message_end(&mut self, end: &wire::MessageEnd) {
        if let Some(slot) = self.index.get(&end.message_id).copied() {
            self.messages[slot].complete = true;
            self.messages[slot].stop_reason = Some(end.stop_reason.clone());
        }
        if self.current_assistant.as_deref() == Some(end.message_id.as_str()) {
            self.current_assistant = None;
        }
    }

    fn on_tool_call_start(&mut self, start: &wire::ToolCallStart) {
        self.resume_streaming();
        // `tool_call_start` always names its home: the daemon's encoder mints a part
        // for a call the provider never streamed, so there is nothing to synthesise
        // here and no way for a row to end up somewhere the transcript cannot find it.
        let home = (start.message_id.clone(), start.part_id.clone());
        self.tool_index
            .insert(start.tool_call_id.clone(), home.clone());
        let tool = start.tool.clone();
        let summary = start.args_summary.clone();
        self.with_tool(&home, &start.tool_call_id, |call| {
            call.name = tool;
            if summary.is_some() {
                call.args_summary = summary;
            }
        });
    }

    fn on_tool_call_update(&mut self, progress: &wire::ToolCallUpdate) {
        self.resume_streaming();
        let Some(home) = self.tool_home(&progress.tool_call_id) else {
            return;
        };
        let update = progress.clone();
        self.with_tool(&home, &progress.tool_call_id, |call| {
            if let Some(tool) = update.tool {
                call.name = tool;
            }
            if update.args_summary.is_some() {
                call.args_summary = update.args_summary;
            }
            if update.args.is_some() {
                call.args = update.args;
            }
            if update.started_at_ms.is_some() {
                call.started_at_ms = update.started_at_ms;
            }
            call.state = match update.status {
                wire::ToolPhase::Running => ToolState::Running,
                _ => ToolState::Pending,
            };
        });
    }

    fn on_tool_call_end(&mut self, end: &wire::ToolCallEnd) {
        let Some(home) = self.tool_home(&end.tool_call_id) else {
            return;
        };
        let end = end.clone();
        self.with_tool(&home, &end.tool_call_id, |call| {
            if let Some(tool) = end.tool {
                call.name = tool;
            }
            call.state = ToolState::from_wire(&end.status);
            call.result_summary = end.result_summary;
            call.duration_ms = Some(end.duration_ms);
            call.interrupted = end.interrupted.unwrap_or(false);
            if let Some(progress) = end.progress {
                call.files_read = progress.files_read;
                call.files_modified = progress
                    .files_modified
                    .into_iter()
                    .map(|change| change.path)
                    .collect();
                call.exit_code = progress.command_exit_code;
            }
        });
    }

    fn on_retry(&mut self, retry: &wire::Retry) {
        let state = RetryState {
            attempt: retry.attempt,
            max_attempts: retry.max_attempts,
            classification: retry.classification.clone(),
            provider_message: retry.provider_message.clone(),
            delay_ms: retry.delay_ms,
            retry_at_ms: retry.retry_at_ms,
            resets_partial_output: retry.resets_partial_output,
        };
        // A retry that discards partial output ends the message being rendered;
        // the daemon restarts message identity, so the client must stop
        // appending to a part whose content no longer exists upstream.
        if retry.resets_partial_output {
            self.current_assistant = None;
        }
        self.retry = Some(state.clone());
        self.phase = TurnPhase::Retrying(state);
    }

    fn on_compaction(&mut self, compaction: &wire::Compaction) {
        self.compactions.push(CompactionBoundary {
            boundary_id: compaction.boundary_id.clone(),
            tokens_before: compaction.tokens_before,
            tokens_after: compaction.tokens_after,
            first_kept_entry: compaction.first_kept_entry.clone(),
        });
        self.open_pause(wire::PauseKind::Compaction);
    }

    fn on_context_repair(&mut self, repairs: &wire::ContextRepairs) {
        self.repairs.extend(repairs.repairs.iter().cloned());
        self.open_pause(wire::PauseKind::ContextRepair);
    }

    fn on_usage(&mut self, usage: &wire::Usage) {
        self.usage = Some(UsageTotals {
            input_tokens: usage.turn.input_tokens,
            output_tokens: usage.turn.output_tokens,
            cache_read_tokens: usage.turn.cache_read_tokens,
            cache_write_tokens: usage.turn.cache_write_tokens,
            session_input_tokens: usage.session.input_tokens,
            session_output_tokens: usage.session.output_tokens,
            cost_micro_usd: usage.session.cost_micro_usd,
        });
    }

    fn on_steer(&mut self, steer: &wire::Steer) {
        self.steers.push(steer.clone());
        self.pending_steer = self.pending_steer.saturating_sub(1);
        self.open_pause(wire::PauseKind::Steer);
    }

    fn on_transport_fallback(&mut self, fallback: &wire::TransportFallback) {
        self.transport_fallbacks.push(fallback.clone());
        self.api_type = Some(fallback.to.clone());
        if fallback.resets_partial_output {
            self.current_assistant = None;
        }
        self.open_pause(wire::PauseKind::TransportFallback);
    }

    fn on_session_changed(&mut self, changed: &wire::SessionChanged) {
        self.reset_transcript();
        self.descriptor = Some(changed.descriptor.clone());
    }

    // -- helpers -----------------------------------------------------------

    /// Open a pause bracket. A retry keeps its richer phase.
    fn open_pause(&mut self, kind: wire::PauseKind) {
        if !matches!(self.phase, TurnPhase::Retrying(_)) {
            self.phase = TurnPhase::Paused(kind);
        }
    }

    /// Close whatever pause is open. Called by `turn_resume`.
    fn close_pause(&mut self) {
        if self.phase.is_paused() {
            self.phase = TurnPhase::Streaming;
        }
    }

    /// Content arrived, so any pause is over whether or not `turn_resume` came.
    ///
    /// The daemon guarantees the resume, but a client that trusts it *only*
    /// leaves a hung indicator when the guarantee breaks. This is the self-heal.
    fn resume_streaming(&mut self) {
        if self.phase.is_paused() || self.phase == TurnPhase::Idle {
            self.phase = TurnPhase::Streaming;
            self.retry = None;
        }
    }

    /// Where a tool call's part lives, as registered by its `tool_call_start`.
    ///
    /// `None` means no start was ever seen for this id. An update or end without
    /// one is a protocol violation, not a shape the client papers over: inventing
    /// a home for it would put a row somewhere no later frame can address.
    fn tool_home(&self, tool_call_id: &str) -> Option<(MessageId, PartId)> {
        self.tool_index.get(tool_call_id).cloned()
    }

    fn with_tool(
        &mut self,
        home: &(MessageId, PartId),
        tool_call_id: &str,
        edit: impl FnOnce(&mut ToolCall),
    ) {
        let seq = self.take_seq();
        let (message_id, part_id) = home;
        let call_id = tool_call_id.to_owned();
        let message = self.upsert_message(message_id, Role::Assistant, None);
        let slot = message.upsert(part_id, seq, || {
            PartBody::Tool(Box::new(ToolCall::new(&call_id)))
        });
        if let PartBody::Tool(call) = &mut message.parts[slot].body {
            edit(call);
        }
        self.live_parts
            .insert((message_id.clone(), part_id.clone()));
    }

    /// Insert a child, or move the one already known to its new state.
    fn upsert_agent(&mut self, agent: &wire::AgentUpdate) {
        match self.agents.iter_mut().find(|known| known.id == agent.id) {
            Some(known) => known.clone_from(agent),
            None => self.agents.push(agent.clone()),
        }
    }

    fn take_seq(&mut self) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        seq
    }

    fn reindex(&mut self) {
        self.index.clear();
        for (slot, message) in self.messages.iter().enumerate() {
            self.index.insert(message.id.clone(), slot);
        }
    }
}

/// A message from a transcript snapshot.
#[derive(Debug, Clone)]
pub struct HydratedMessage {
    /// Message id.
    pub id: MessageId,
    /// Ordering key.
    pub seq: u64,
    /// Author.
    pub role: Role,
    /// Parts.
    pub parts: Vec<HydratedPart>,
    /// Whether the message finished.
    pub complete: bool,
}

/// A part from a transcript snapshot.
#[derive(Debug, Clone)]
pub struct HydratedPart {
    /// Part id.
    pub id: PartId,
    /// Ordering key; defaults to array position.
    pub seq: Option<u64>,
    /// Payload.
    pub body: PartBody,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn update(value: serde_json::Value) -> wire::Update {
        let decoded = wire::Update::from_json(value);
        assert!(!decoded.is_unknown(), "sample must be a modelled variant");
        decoded
    }

    fn apply(store: &mut SessionStore, value: serde_json::Value) {
        store.apply(&update(value));
    }

    fn delta(message: &str, part: &str, text: &str, seq: Option<u64>) -> Delta {
        Delta {
            message_id: message.to_owned(),
            part_id: part.to_owned(),
            field: Field::Text,
            delta: text.to_owned(),
            seq,
        }
    }

    fn begin(store: &mut SessionStore) {
        apply(
            store,
            json!({"sessionUpdate":"turn_start","turnId":"t1","source":"user","startedAtMs":0}),
        );
    }

    // -- delta mechanics (preserved from phase 3) --------------------------

    #[test]
    fn deltas_append_to_one_part() {
        let mut store = SessionStore::new();
        store.apply_delta(&delta("m1", "p1", "Hel", Some(0)));
        store.apply_delta(&delta("m1", "p1", "lo w", Some(0)));
        store.apply_delta(&delta("m1", "p1", "orld", Some(0)));
        assert_eq!(store.message("m1").unwrap().text(), "Hello world");
        assert_eq!(store.message("m1").unwrap().parts.len(), 1);
    }

    #[test]
    fn parts_are_ordered_by_seq_regardless_of_arrival_order() {
        let mut store = SessionStore::new();
        store.apply_delta(&delta("m1", "third", "C", Some(30)));
        store.apply_delta(&delta("m1", "first", "A", Some(10)));
        store.apply_delta(&delta("m1", "second", "B", Some(20)));
        assert_eq!(store.message("m1").unwrap().text(), "ABC");
    }

    #[test]
    fn messages_are_ordered_by_seq_regardless_of_arrival_order() {
        let mut store = SessionStore::new();
        store.upsert_message("late", Role::Assistant, Some(9));
        store.upsert_message("early", Role::User, Some(1));
        let ids: Vec<_> = store
            .messages()
            .iter()
            .map(|message| message.id.as_str())
            .collect();
        assert_eq!(ids, ["early", "late"]);
    }

    #[test]
    fn a_delta_for_an_unseen_part_materialises_it_instead_of_being_dropped() {
        let mut store = SessionStore::new();
        // The delta overtakes its part_start.
        apply(
            &mut store,
            json!({"sessionUpdate":"delta","messageId":"m1","partId":"p1","field":"text",
                   "delta":"early"}),
        );
        apply(
            &mut store,
            json!({"sessionUpdate":"part_start","messageId":"m1","partId":"p1","kind":"text"}),
        );
        apply(
            &mut store,
            json!({"sessionUpdate":"delta","messageId":"m1","partId":"p1","field":"text",
                   "delta":" bird"}),
        );
        assert_eq!(store.message("m1").unwrap().text(), "early bird");
        assert_eq!(store.message("m1").unwrap().parts.len(), 1);
    }

    #[test]
    fn each_field_appends_to_its_own_buffer_of_its_own_part() {
        let mut store = SessionStore::new();
        for (part, field, text) in [
            ("p-think", "thinking", "weighing"),
            ("p-think", "signature", "sig-1"),
            ("p-text", "text", "answer"),
            ("p-tool", "arguments", r#"{"path":"a.ts"}"#),
        ] {
            apply(
                &mut store,
                json!({"sessionUpdate":"delta","messageId":"m1","partId":part,"field":field,
                       "delta":text}),
            );
        }
        let message = store.message("m1").unwrap();
        assert!(matches!(
            message.part("p-think").map(|part| &part.body),
            Some(PartBody::Thinking { text, signature })
                if text == "weighing" && signature == "sig-1"
        ));
        assert_eq!(message.text(), "answer");
        assert_eq!(
            message.part("p-tool").unwrap().tool().unwrap().arguments,
            r#"{"path":"a.ts"}"#
        );
    }

    // -- turn lifecycle ----------------------------------------------------

    #[test]
    fn every_terminal_turn_status_is_modelled() {
        for status in ["completed", "cancelled", "truncated", "refusal", "error"] {
            let mut store = SessionStore::new();
            begin(&mut store);
            apply(
                &mut store,
                json!({"sessionUpdate":"turn_end","turnId":"t1","status":status,
                       "durationMs":12,"partialRetained":true}),
            );
            let outcome = store.phase().outcome().expect("an ended turn");
            assert_eq!(outcome.status.as_str(), status);
            assert!(outcome.partial_retained);
            assert!(store.turn().is_none());
        }
    }

    #[test]
    fn a_cancelled_turn_keeps_partial_output_and_reports_the_rewind() {
        let mut store = SessionStore::new();
        begin(&mut store);
        apply(
            &mut store,
            json!({"sessionUpdate":"delta","messageId":"m1","partId":"p1","field":"text",
                   "delta":"half a th"}),
        );
        apply(
            &mut store,
            json!({"sessionUpdate":"turn_end","turnId":"t1","status":"cancelled","durationMs":3,
                   "partialRetained":false,"promptTrimmed":true}),
        );
        assert_eq!(store.message("m1").unwrap().text(), "half a th");
        let outcome = store.phase().outcome().unwrap();
        assert!(outcome.prompt_trimmed);
        assert_eq!(outcome.status, wire::TurnStatus::Cancelled);
    }

    #[test]
    fn an_errored_turn_carries_the_provider_failure() {
        let mut store = SessionStore::new();
        begin(&mut store);
        apply(
            &mut store,
            json!({"sessionUpdate":"turn_end","turnId":"t1","status":"error","durationMs":1,
                   "partialRetained":false,"hardStopRequested":true,
                   "error":{"classification":"bad_request","message":"no such model",
                            "code":"model_not_found","status":404}}),
        );
        let outcome = store.phase().outcome().unwrap();
        assert!(outcome.hard_stop_requested);
        let error = outcome.error.as_ref().unwrap();
        assert_eq!(error.classification, wire::Classification::BadRequest);
        assert_eq!(error.status, Some(404));
    }

    // -- pause brackets ----------------------------------------------------

    #[test]
    fn a_retry_holds_its_countdown_until_turn_resume_closes_the_bracket() {
        let mut store = SessionStore::new();
        begin(&mut store);
        apply(
            &mut store,
            json!({"sessionUpdate":"retry","attempt":3,"maxAttempts":8,"classification":"quota",
                   "providerMessage":"monthly limit reached","delayMs":2500,
                   "retryAtMs":10_000,"resetsPartialOutput":true}),
        );
        let retry = store.retry().expect("a retry in flight").clone();
        assert_eq!((retry.attempt, retry.max_attempts), (3, 8));
        assert_eq!(retry.classification, wire::Classification::Quota);
        assert_eq!(retry.provider_message, "monthly limit reached");
        assert_eq!(retry.remaining_ms(7_500), 2_500);
        assert_eq!(retry.remaining_secs(9_100), 1);
        assert_eq!(retry.remaining_ms(12_000), 0, "the countdown floors at zero");
        assert!(!retry.is_escalated());
        assert!(store.phase().is_paused());

        apply(
            &mut store,
            json!({"sessionUpdate":"turn_resume","turnId":"t1","after":"retry","pausedMs":2500}),
        );
        assert_eq!(*store.phase(), TurnPhase::Streaming);
        assert!(store.retry().is_none(), "no hanging retry indicator");
    }

    #[test]
    fn attempt_four_escalates_to_full_detail() {
        let mut store = SessionStore::new();
        begin(&mut store);
        apply(
            &mut store,
            json!({"sessionUpdate":"retry","attempt":4,"maxAttempts":8,
                   "classification":"transient","providerMessage":"upstream 503","delayMs":0,
                   "retryAtMs":0,"resetsPartialOutput":false}),
        );
        assert!(store.retry().unwrap().is_escalated());
    }

    #[test]
    fn every_pause_kind_is_opened_and_closed_by_its_resume() {
        let cases = [
            (
                json!({"sessionUpdate":"compaction","boundaryId":"b","tokensBefore":10,
                       "tokensAfter":4,"firstKeptEntry":null}),
                "compaction",
            ),
            (
                json!({"sessionUpdate":"context_repair",
                       "repairs":[{"code":"empty_content","detail":"dropped"}]}),
                "context_repair",
            ),
            (
                json!({"sessionUpdate":"steer","entryId":"e1","text":"also the tests",
                       "at":"tool_boundary"}),
                "steer",
            ),
            (
                json!({"sessionUpdate":"transport_fallback","from":"openai_websocket",
                       "to":"openai_completions","reason":"refused",
                       "resetsPartialOutput":false}),
                "transport_fallback",
            ),
        ];
        for (opening, kind) in cases {
            let mut store = SessionStore::new();
            begin(&mut store);
            apply(&mut store, opening);
            assert!(store.phase().is_paused(), "{kind} did not open a bracket");
            apply(
                &mut store,
                json!({"sessionUpdate":"turn_resume","turnId":"t1","after":kind,"pausedMs":5}),
            );
            assert_eq!(*store.phase(), TurnPhase::Streaming, "{kind} stayed paused");
        }
    }

    #[test]
    fn content_resuming_without_a_resume_frame_still_clears_the_indicator() {
        let mut store = SessionStore::new();
        begin(&mut store);
        apply(
            &mut store,
            json!({"sessionUpdate":"compaction","boundaryId":"b","tokensBefore":10,
                   "tokensAfter":4,"firstKeptEntry":null}),
        );
        assert!(store.phase().is_paused());
        apply(
            &mut store,
            json!({"sessionUpdate":"delta","messageId":"m1","partId":"p1","field":"text",
                   "delta":"resumed"}),
        );
        assert_eq!(*store.phase(), TurnPhase::Streaming);
    }

    // -- reliability surfaces ----------------------------------------------

    #[test]
    fn a_compaction_boundary_keeps_both_token_counts_and_the_first_kept_entry() {
        let mut store = SessionStore::new();
        apply(
            &mut store,
            json!({"sessionUpdate":"compaction","boundaryId":"e-77","tokensBefore":180_000,
                   "tokensAfter":42_000,"firstKeptEntry":"e-51"}),
        );
        apply(
            &mut store,
            json!({"sessionUpdate":"compaction","boundaryId":"e-90","tokensBefore":5,
                   "tokensAfter":0,"firstKeptEntry":null}),
        );
        let boundaries = store.compactions();
        assert_eq!(boundaries[0].tokens_reclaimed(), 138_000);
        assert_eq!(boundaries[0].first_kept_entry.as_deref(), Some("e-51"));
        // A cleared context keeps the null: nothing survived, which is not the
        // same as "we do not know".
        assert!(boundaries[1].first_kept_entry.is_none());
    }

    #[test]
    fn context_repairs_accumulate_with_their_codes_and_estimates() {
        let mut store = SessionStore::new();
        apply(
            &mut store,
            json!({"sessionUpdate":"context_repair",
                   "repairs":[{"code":"missing_tool_result","detail":"synthesised","entryId":"e-9",
                               "tokenEstimate":12},
                              {"code":"thinking_reordered","detail":"moved"}]}),
        );
        assert_eq!(store.repairs().len(), 2);
        assert_eq!(store.repairs()[0].code, wire::RepairCode::MissingToolResult);
        assert_eq!(store.repairs()[0].token_estimate, Some(12));
        assert_eq!(store.repairs()[1].token_estimate, None);
    }

    #[test]
    fn an_absent_context_window_yields_no_percentage() {
        let mut store = SessionStore::new();
        apply(
            &mut store,
            json!({"sessionUpdate":"context","tokenEstimate":5_000,"sourceEntryCount":9}),
        );
        assert_eq!(store.context().unwrap().token_estimate, 5_000);
        assert_eq!(
            store.context_fraction(),
            None,
            "an unverified limit must render nothing, not a wrong number"
        );
        apply(
            &mut store,
            json!({"sessionUpdate":"context","tokenEstimate":5_000,"sourceEntryCount":9,
                   "contextWindow":20_000}),
        );
        assert!((store.context_fraction().unwrap() - 0.25).abs() < f64::EPSILON);
    }

    #[test]
    fn usage_is_kept_as_raw_counts_and_cost_is_absent_when_pricing_is_unknown() {
        let mut store = SessionStore::new();
        apply(
            &mut store,
            json!({"sessionUpdate":"usage","turn":{"inputTokens":90,"outputTokens":30},
                   "session":{"inputTokens":120,"outputTokens":40}}),
        );
        let usage = *store.usage().unwrap();
        assert_eq!(usage.session_input_tokens, 120);
        assert_eq!(usage.cost_micro_usd, None);
        apply(
            &mut store,
            json!({"sessionUpdate":"usage",
                   "turn":{"inputTokens":1,"outputTokens":2,"cacheReadTokens":3,
                           "cacheWriteTokens":4},
                   "session":{"inputTokens":121,"outputTokens":42,"costMicroUsd":4_321}}),
        );
        let usage = *store.usage().unwrap();
        assert_eq!(usage.cache_read_tokens, Some(3));
        assert_eq!(usage.cost_micro_usd, Some(4_321));
    }

    #[test]
    fn a_transport_fallback_is_recorded_and_moves_the_active_api_type() {
        let mut store = SessionStore::new();
        begin(&mut store);
        apply(
            &mut store,
            json!({"sessionUpdate":"transport_fallback","from":"openai_websocket",
                   "to":"openai_completions","reason":"handshake refused",
                   "resetsPartialOutput":true}),
        );
        assert_eq!(store.transport_fallbacks().len(), 1);
        assert_eq!(store.api_type(), Some(&wire::ApiType::OpenAiCompletions));
    }

    #[test]
    fn a_loop_warning_is_an_inline_note_not_a_pause() {
        let mut store = SessionStore::new();
        begin(&mut store);
        apply(
            &mut store,
            json!({"sessionUpdate":"loop_warning",
                   "warning":{"type":"identical_tool_call","tool":"read","count":3},
                   "hardStopRequested":true}),
        );
        assert_eq!(store.loop_warnings().len(), 1);
        assert!(store.loop_warnings()[0].hard_stop_requested);
        assert_eq!(
            store.loop_warnings()[0].warning.kind,
            wire::LoopWarningKind::IdenticalToolCall
        );
        assert!(!store.phase().is_paused());
    }

    #[test]
    fn steering_is_acknowledged_and_the_queue_count_drains() {
        let mut store = SessionStore::new();
        begin(&mut store);
        store.note_steer_sent(None);
        store.note_steer_sent(None);
        assert_eq!(store.pending_steer(), 2);
        apply(
            &mut store,
            json!({"sessionUpdate":"steer","entryId":"e-42","text":"use the session helper",
                   "at":"tool_boundary"}),
        );
        assert_eq!(store.pending_steer(), 1);
        assert_eq!(store.steers()[0].at, wire::SteerBoundary::ToolBoundary);
        assert_eq!(store.steers()[0].text, "use the session helper");
    }

    #[test]
    fn reports_and_errors_are_kept_for_the_audit_rows() {
        let mut store = SessionStore::new();
        apply(
            &mut store,
            json!({"sessionUpdate":"report","message":"[git preview] assembled 2026-08-05-1246 from 3 workspace(s)"}),
        );
        apply(
            &mut store,
            json!({"sessionUpdate":"error",
                   "error":{"classification":"auth","message":"token expired"}}),
        );
        assert_eq!(store.reports(), ["[git preview] assembled 2026-08-05-1246 from 3 workspace(s)"]);
        assert_eq!(store.errors()[0].classification, wire::Classification::Auth);
    }

    // -- tool lifecycle ----------------------------------------------------

    #[test]
    fn tool_lifecycle_walks_pending_running_then_a_status_with_a_duration() {
        let mut store = SessionStore::new();
        begin(&mut store);
        apply(
            &mut store,
            json!({"sessionUpdate":"part_start","messageId":"m1","partId":"p3",
                   "kind":"tool_call","toolCallId":"call-1"}),
        );
        apply(
            &mut store,
            json!({"sessionUpdate":"tool_call_start","toolCallId":"call-1","messageId":"m1",
                   "partId":"p3","tool":"read"}),
        );
        assert_eq!(store.tool_calls()[0].state, ToolState::Pending);
        apply(
            &mut store,
            json!({"sessionUpdate":"delta","messageId":"m1","partId":"p3","field":"arguments",
                   "delta":"{\"path\":\"a.ts\"}"}),
        );
        apply(
            &mut store,
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"running",
                   "tool":"read","argsSummary":"a.ts","args":{"path":"a.ts"},
                   "startedAtMs":1_000}),
        );
        assert_eq!(store.tool_calls()[0].state, ToolState::Running);
        apply(
            &mut store,
            json!({"sessionUpdate":"tool_call_end","toolCallId":"call-1","tool":"read",
                   "status":"ok","resultSummary":"export function auth() {}","durationMs":37,
                   "progress":{"filesRead":["a.ts"],
                               "filesModified":[{"path":"a.ts"}],"commandExitCode":0}}),
        );
        let call = store.tool_calls()[0].clone();
        assert_eq!(store.tool_calls().len(), 1, "no duplicate row was created");
        assert_eq!(call.state, ToolState::Succeeded);
        assert!(call.state.is_terminal());
        assert_eq!(call.name, "read");
        assert_eq!(call.arguments, r#"{"path":"a.ts"}"#);
        assert_eq!(call.args_summary.as_deref(), Some("a.ts"));
        assert_eq!(call.args, Some(json!({"path":"a.ts"})));
        assert_eq!(call.started_at_ms, Some(1_000));
        assert_eq!(call.duration_ms, Some(37));
        assert_eq!(call.result_summary.as_deref(), Some("export function auth() {}"));
        assert_eq!(call.files_read, ["a.ts"]);
        assert_eq!(call.files_modified, ["a.ts"]);
        assert_eq!(call.exit_code, Some(0));
    }

    #[test]
    fn every_terminal_tool_status_maps_to_a_state() {
        for (status, expected) in [
            ("ok", ToolState::Succeeded),
            ("error", ToolState::Failed),
            ("denied", ToolState::Denied),
        ] {
            let mut store = SessionStore::new();
            // The end addresses the home its start registered; there is no synthesised
            // home any more, so the start is not optional in this script.
            apply(
                &mut store,
                json!({"sessionUpdate":"tool_call_start","toolCallId":"c","messageId":"m",
                       "partId":"p","tool":"git"}),
            );
            apply(
                &mut store,
                json!({"sessionUpdate":"tool_call_end","toolCallId":"c","tool":"git",
                       "status":status,"durationMs":0}),
            );
            assert_eq!(store.tool_calls()[0].state, expected);
        }
    }

    #[test]
    fn a_tool_frame_with_no_start_is_ignored_rather_than_given_an_unaddressable_home() {
        let mut store = SessionStore::new();
        begin(&mut store);
        // `tool_call_start` always names a message and part, so an end without one is a
        // daemon bug. Inventing a home would put a row where no later frame can reach it.
        apply(
            &mut store,
            json!({"sessionUpdate":"tool_call_end","toolCallId":"orphan","status":"ok",
                   "durationMs":0}),
        );
        assert!(store.tool_calls().is_empty());
    }

    #[test]
    fn a_tool_the_provider_never_streamed_still_gets_a_row() {
        let mut store = SessionStore::new();
        begin(&mut store);
        // The provider jumped straight to execution, so the daemon's encoder minted the
        // message and part itself. The row hangs off a real home like any other.
        apply(
            &mut store,
            json!({"sessionUpdate":"tool_call_start","toolCallId":"t1","messageId":"minted-m",
                   "partId":"minted-p","tool":"bash"}),
        );
        apply(
            &mut store,
            json!({"sessionUpdate":"tool_call_end","toolCallId":"t1","status":"ok",
                   "durationMs":4,"interrupted":true}),
        );
        let calls = store.tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "bash");
        assert!(calls[0].interrupted, "a steer-interrupted wait is marked");
    }

    #[test]
    fn a_tool_finishing_after_the_message_moved_on_still_updates_its_own_row() {
        let mut store = SessionStore::new();
        begin(&mut store);
        apply(
            &mut store,
            json!({"sessionUpdate":"tool_call_start","toolCallId":"c1","messageId":"m1",
                   "partId":"p1","tool":"grep"}),
        );
        apply(
            &mut store,
            json!({"sessionUpdate":"message_start","turnId":"t1","messageId":"m2",
                   "role":"assistant"}),
        );
        apply(
            &mut store,
            json!({"sessionUpdate":"tool_call_end","toolCallId":"c1","status":"ok",
                   "durationMs":9,"resultSummary":"1 hit"}),
        );
        assert_eq!(store.tool_calls().len(), 1, "no duplicate call was created");
        assert_eq!(store.tool_calls()[0].state, ToolState::Succeeded);
        assert_eq!(store.last_tool_call().unwrap().id, "c1");
    }

    // -- identity and hydration --------------------------------------------

    #[test]
    fn a_retry_that_resets_partial_output_stops_the_client_appending_to_a_dead_part() {
        let mut store = SessionStore::new();
        begin(&mut store);
        apply(
            &mut store,
            json!({"sessionUpdate":"delta","messageId":"m1","partId":"p1","field":"text",
                   "delta":"discarded"}),
        );
        assert!(store.active_assistant().is_some());
        apply(
            &mut store,
            json!({"sessionUpdate":"retry","attempt":2,"maxAttempts":3,
                   "classification":"transient","providerMessage":"boom","delayMs":0,
                   "retryAtMs":0,"resetsPartialOutput":true}),
        );
        assert!(store.active_assistant().is_none());
    }

    #[test]
    fn message_end_completes_the_message_and_records_its_stop_reason() {
        let mut store = SessionStore::new();
        begin(&mut store);
        apply(
            &mut store,
            json!({"sessionUpdate":"message_start","turnId":"t1","messageId":"m1",
                   "role":"assistant"}),
        );
        apply(
            &mut store,
            json!({"sessionUpdate":"message_end","messageId":"m1","stopReason":"tool_use"}),
        );
        let message = store.message("m1").unwrap();
        assert!(message.complete);
        assert_eq!(message.stop_reason, Some(wire::StopReason::ToolUse));
        assert_eq!(message.turn_id.as_deref(), Some("t1"));
    }

    #[test]
    fn part_end_freezes_a_part_so_its_rows_can_be_committed() {
        let mut store = SessionStore::new();
        apply(
            &mut store,
            json!({"sessionUpdate":"delta","messageId":"m1","partId":"p1","field":"text",
                   "delta":"done"}),
        );
        apply(
            &mut store,
            json!({"sessionUpdate":"part_end","messageId":"m1","partId":"p1"}),
        );
        assert!(store.message("m1").unwrap().part("p1").unwrap().complete);
    }

    #[test]
    fn a_reasoning_item_is_carried_raw_and_never_reinterpreted() {
        let mut store = SessionStore::new();
        apply(
            &mut store,
            json!({"sessionUpdate":"reasoning_item","messageId":"m1","partId":"p4",
                   "provider":"openai","item":{"id":"reasoning-1","encrypted":"opaque"}}),
        );
        let part = store.message("m1").unwrap().part("p4").unwrap();
        assert!(matches!(
            &part.body,
            PartBody::Reasoning { provider, item }
                if provider == "openai" && item["encrypted"] == json!("opaque")
        ));
    }

    #[test]
    fn hydration_never_overwrites_a_part_the_live_stream_already_wrote() {
        let mut store = SessionStore::new();
        // Live event lands first, while the snapshot request is still in flight.
        apply(
            &mut store,
            json!({"sessionUpdate":"delta","messageId":"m1","partId":"p1","field":"text",
                   "delta":"live text"}),
        );

        // The snapshot is stale: it was taken before the live delta.
        store.hydrate(vec![HydratedMessage {
            id: "m1".to_owned(),
            seq: 0,
            role: Role::Assistant,
            parts: vec![HydratedPart {
                id: "p1".to_owned(),
                seq: Some(0),
                body: PartBody::Text("stale snapshot text".to_owned()),
            }],
            complete: true,
        }]);

        assert_eq!(store.message("m1").unwrap().text(), "live text");
        assert!(store.hydrated());
    }

    #[test]
    fn hydration_fills_parts_the_live_stream_has_not_touched() {
        let mut store = SessionStore::new();
        apply(
            &mut store,
            json!({"sessionUpdate":"delta","messageId":"m2","partId":"m2:text","field":"text",
                   "delta":"live"}),
        );

        store.hydrate(vec![
            HydratedMessage {
                id: "m1".to_owned(),
                seq: 0,
                role: Role::User,
                parts: vec![HydratedPart {
                    id: "m1:text".to_owned(),
                    seq: Some(0),
                    body: PartBody::Text("earlier user turn".to_owned()),
                }],
                complete: true,
            },
            HydratedMessage {
                id: "m2".to_owned(),
                seq: 1,
                role: Role::Assistant,
                parts: vec![HydratedPart {
                    id: "m2:thinking".to_owned(),
                    seq: Some(5),
                    body: PartBody::Thinking {
                        text: "recovered reasoning".to_owned(),
                        signature: String::new(),
                    },
                }],
                complete: false,
            },
        ]);

        assert_eq!(store.message("m1").unwrap().text(), "earlier user turn");
        assert_eq!(store.message("m2").unwrap().text(), "live");
        assert_eq!(store.message("m2").unwrap().thinking(), "recovered reasoning");
    }

    #[test]
    fn hydration_is_idempotent() {
        let snapshot = || {
            vec![HydratedMessage {
                id: "m1".to_owned(),
                seq: 0,
                role: Role::User,
                parts: vec![HydratedPart {
                    id: "p".to_owned(),
                    seq: Some(0),
                    body: PartBody::Text("once".to_owned()),
                }],
                complete: true,
            }]
        };
        let mut store = SessionStore::new();
        store.hydrate(snapshot());
        store.hydrate(snapshot());
        assert_eq!(store.messages().len(), 1);
        assert_eq!(store.message("m1").unwrap().parts.len(), 1);
        assert_eq!(store.message("m1").unwrap().text(), "once");
    }

    #[test]
    fn snapshot_metadata_never_walks_the_counters_backwards() {
        let mut store = SessionStore::new();
        apply(
            &mut store,
            json!({"sessionUpdate":"usage","turn":{"inputTokens":1,"outputTokens":1},
                   "session":{"inputTokens":500,"outputTokens":200}}),
        );
        let snapshot: wire::SessionSnapshot = serde_json::from_value(json!({
            "descriptor":{"sessionId":"s-1","name":"purple-falcon"},
            "entries":[], "provider":"anthropic", "model":"opus-5",
            "turnActive": true, "pendingSteer": 2,
            "usage":{"session":{"inputTokens":120,"outputTokens":40},"contextTokens":4_200}
        }))
        .unwrap();
        store.apply_snapshot_meta(&snapshot);
        let usage = *store.usage().unwrap();
        assert_eq!(usage.session_input_tokens, 500, "live totals win");
        assert_eq!(store.provider(), Some("anthropic"));
        assert_eq!(store.pending_steer(), 2);
        assert_eq!(*store.phase(), TurnPhase::Streaming);
        // contextTokens without a window still yields no percentage.
        assert_eq!(store.context().unwrap().token_estimate, 4_200);
        assert_eq!(store.context_fraction(), None);
    }

    #[test]
    fn a_session_change_discards_the_transcript_and_asks_for_re_hydration() {
        let mut store = SessionStore::new();
        begin(&mut store);
        apply(
            &mut store,
            json!({"sessionUpdate":"delta","messageId":"m1","partId":"p1","field":"text",
                   "delta":"old session"}),
        );
        apply(
            &mut store,
            json!({"sessionUpdate":"session_changed","reason":"fork",
                   "descriptor":{"sessionId":"s-2","name":"purple-falcon"}}),
        );
        assert!(store.messages().is_empty());
        assert!(!store.hydrated());
        assert_eq!(store.descriptor().unwrap().session_id, "s-2");
        assert_eq!(*store.phase(), TurnPhase::Idle);
    }

    #[test]
    fn model_changes_are_tracked_for_the_header_line() {
        let mut store = SessionStore::new();
        apply(
            &mut store,
            json!({"sessionUpdate":"model_changed","provider":"anthropic","model":"opus-5",
                   "apiType":"anthropic_messages"}),
        );
        assert_eq!(store.model(), Some("opus-5"));
        assert_eq!(store.api_type(), Some(&wire::ApiType::AnthropicMessages));
    }

    #[test]
    fn an_unmodelled_update_is_recorded_rather_than_crashing_or_vanishing() {
        let mut store = SessionStore::new();
        begin(&mut store);
        store.apply(&wire::Update::from_json(
            json!({"sessionUpdate":"telemetry","frames":12}),
        ));
        assert_eq!(*store.phase(), TurnPhase::Streaming);
        assert_eq!(store.unknown_updates().len(), 1);
        assert_eq!(store.unknown_updates()[0].tag, "telemetry");
    }

    #[test]
    fn a_full_scripted_turn_folds_into_a_renderable_transcript() {
        let mut store = SessionStore::new();
        for update in [
            json!({"sessionUpdate":"turn_start","turnId":"t1","source":"user","startedAtMs":0}),
            json!({"sessionUpdate":"context","tokenEstimate":4_200,"sourceEntryCount":7}),
            json!({"sessionUpdate":"message_start","turnId":"t1","messageId":"m1",
                   "role":"assistant"}),
            json!({"sessionUpdate":"part_start","messageId":"m1","partId":"p1","kind":"thinking"}),
            json!({"sessionUpdate":"delta","messageId":"m1","partId":"p1","field":"thinking",
                   "delta":"weighing"}),
            json!({"sessionUpdate":"delta","messageId":"m1","partId":"p1","field":"signature",
                   "delta":"sig-1"}),
            json!({"sessionUpdate":"part_end","messageId":"m1","partId":"p1"}),
            json!({"sessionUpdate":"part_start","messageId":"m1","partId":"p2","kind":"text"}),
            json!({"sessionUpdate":"delta","messageId":"m1","partId":"p2","field":"text",
                   "delta":"Reading "}),
            json!({"sessionUpdate":"delta","messageId":"m1","partId":"p2","field":"text",
                   "delta":"the file."}),
            json!({"sessionUpdate":"part_end","messageId":"m1","partId":"p2"}),
            json!({"sessionUpdate":"part_start","messageId":"m1","partId":"p3","kind":"tool_call",
                   "toolCallId":"call-1"}),
            json!({"sessionUpdate":"tool_call_start","toolCallId":"call-1","messageId":"m1",
                   "partId":"p3","tool":"read"}),
            json!({"sessionUpdate":"delta","messageId":"m1","partId":"p3","field":"arguments",
                   "delta":"{\"path\":\"a.ts\"}"}),
            json!({"sessionUpdate":"part_end","messageId":"m1","partId":"p3"}),
            json!({"sessionUpdate":"usage","turn":{"inputTokens":90,"outputTokens":30},
                   "session":{"inputTokens":120,"outputTokens":40}}),
            json!({"sessionUpdate":"message_end","messageId":"m1","stopReason":"tool_use"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"running",
                   "tool":"read","startedAtMs":10}),
            json!({"sessionUpdate":"tool_call_end","toolCallId":"call-1","status":"ok",
                   "durationMs":12,"resultSummary":"ok"}),
            json!({"sessionUpdate":"turn_end","turnId":"t1","status":"completed",
                   "stopReason":"end_turn","durationMs":120,"partialRetained":false}),
        ] {
            apply(&mut store, update);
        }

        let message = store.message("m1").unwrap();
        assert_eq!(message.text(), "Reading the file.");
        assert_eq!(message.thinking(), "weighing");
        assert_eq!(message.parts.len(), 3);
        assert!(message.parts.iter().all(|part| part.complete));
        assert!(message.complete);
        assert_eq!(store.tool_calls().len(), 1);
        assert_eq!(store.tool_calls()[0].state, ToolState::Succeeded);
        assert_eq!(
            store.phase().outcome().unwrap().status,
            wire::TurnStatus::Completed
        );
        assert_eq!(store.usage().unwrap().session_input_tokens, 120);
    }
}
