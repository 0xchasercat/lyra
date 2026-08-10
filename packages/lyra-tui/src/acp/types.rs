//! ACP wire types, written against the **canonical schema**:
//! `packages/lyra-acp/schema/protocol.json` (JSON Schema draft 2020-12).
//!
//! DESIGN.md §2: *"No hand-mirrored schema. The protocol is ACP itself. A single
//! canonical schema file defines every method and notification; Rust serde types
//! are generated/validated from it in CI. A drifted field is a build failure, not
//! a runtime surprise."* This file is the validated half of that contract — the
//! tripwire lives in `acp::conformance` (test-only), which loads the schema,
//! asserts the variant set here matches the declared `oneOf`, and round-trips a
//! sample of every variant through these types.
//!
//! # The shape
//!
//! One notification method, `session/update`, carrying one envelope
//! ([`UpdateNotification`]) of `{sessionId, update}`, where `update` is a
//! 25-variant union discriminated by `sessionUpdate` ([`Update`]).
//!
//! There is exactly one frame shape. The pre-rewrite `{event, stats, report}`
//! frame the daemon emitted alongside this one during the transition is gone
//! from the daemon and from the schema, so nothing here filters for it.
//!
//! # Forward compatibility
//!
//! Three rules, each with a test:
//!
//! 1. An **unknown variant** deserializes to [`Update::Unknown`] carrying its tag
//!    and fields verbatim, so it round-trips and can be rendered as an audit row.
//! 2. An **unknown field** on a known variant is ignored, never fatal.
//! 3. An **unknown enum value** (a new classification, stop reason, api type…)
//!    is preserved as `Other(String)` rather than rejected.
//!
//! A malformed *known* variant degrades to [`Update::Unknown`] with the decoder
//! error attached instead of failing the frame: DESIGN.md §3's "never render
//! nothing" is a rendering rule, but nothing in the client may take the process
//! down over a wire surprise.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use std::fmt;

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

/// A JSON-RPC id. `daemon.ts` accepts strings and finite numbers only.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(untagged)]
pub enum Id {
    /// Numeric id. This client only ever mints these.
    Number(i64),
    /// String id. The daemon mints `server-N` for its own requests.
    Text(String),
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Number(value) => write!(f, "{value}"),
            Self::Text(value) => f.write_str(value),
        }
    }
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match Value::deserialize(deserializer)? {
            Value::String(text) => Ok(Self::Text(text)),
            Value::Number(number) => number.as_i64().map(Self::Number).ok_or_else(|| {
                serde::de::Error::custom("JSON-RPC id must be an integer or a string")
            }),
            _ => Err(serde::de::Error::custom(
                "JSON-RPC id must be an integer or a string",
            )),
        }
    }
}

/// A JSON-RPC error object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RpcError {
    /// Error code. `daemon.ts` uses -32001 timeout, -32002 concurrency,
    /// -32003 oversized frame, -32800 cancelled, plus the standard codes.
    pub code: i64,
    /// Human-readable message.
    pub message: String,
    /// Structured detail; `daemon.ts` forwards `name`/`classification`/`code`/
    /// `status`/`retryAfterMs` when the thrown error carries them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (code {})", self.message, self.code)
    }
}

impl std::error::Error for RpcError {}

/// The raw shape every inbound line is parsed into before classification.
///
/// Classification mirrors `AcpDaemon.handleMessage`: no `method` ⇒ a response to
/// one of our requests; `method` with an `id` ⇒ a request we must answer;
/// `method` without an `id` ⇒ a notification.
#[derive(Debug, Clone, Deserialize)]
pub struct RawMessage {
    /// Protocol tag; the daemon rejects anything but `"2.0"`.
    #[serde(default)]
    pub jsonrpc: Option<String>,
    /// Correlation id, when present.
    #[serde(default)]
    pub id: Option<Id>,
    /// Method name, when this is a request or notification.
    #[serde(default)]
    pub method: Option<String>,
    /// Method parameters.
    #[serde(default)]
    pub params: Option<Value>,
    /// Success payload, when this is a response.
    #[serde(default)]
    pub result: Option<Value>,
    /// Failure payload, when this is a response.
    #[serde(default)]
    pub error: Option<RpcError>,
}

/// A classified inbound message.
#[derive(Debug, Clone)]
pub enum Inbound {
    /// A reply to a request this client sent.
    Response {
        /// Correlation id.
        id: Id,
        /// `Ok` carries `result`, `Err` carries `error`.
        outcome: Box<Result<Value, RpcError>>,
    },
    /// A request *from* the daemon. `daemon.ts` is `bidirectional: true` and uses
    /// `requestClient` for `session/request_permission`; it blocks on our reply
    /// until its timeout, so every one of these must be answered.
    Request {
        /// Correlation id to echo back.
        id: Id,
        /// Requested method.
        method: String,
        /// Method parameters.
        params: Option<Value>,
    },
    /// A notification from the daemon. Today: `session/update`.
    Notification {
        /// Notified method.
        method: String,
        /// Method parameters.
        params: Option<Value>,
    },
}

impl RawMessage {
    /// Classify this message, or report why it is unusable.
    ///
    /// # Errors
    ///
    /// Returns a description when the envelope is malformed.
    pub fn classify(self) -> Result<Inbound, String> {
        match (self.method, self.id) {
            (None, Some(id)) => {
                let outcome = match (self.result, self.error) {
                    (_, Some(error)) => Err(error),
                    (Some(result), None) => Ok(result),
                    // `daemon.ts` writes `result: result ?? null`, so a null-result
                    // reply is normal and must not be mistaken for a malformed one.
                    (None, None) => Ok(Value::Null),
                };
                Ok(Inbound::Response {
                    id,
                    outcome: Box::new(outcome),
                })
            }
            (None, None) => Err("message has neither method nor id".to_owned()),
            (Some(method), Some(id)) => Ok(Inbound::Request {
                id,
                method,
                params: self.params,
            }),
            (Some(method), None) => Ok(Inbound::Notification {
                method,
                params: self.params,
            }),
        }
    }
}

/// An outbound JSON-RPC frame.
#[derive(Debug, Clone, Serialize)]
pub struct Outbound {
    /// Always `"2.0"`.
    pub jsonrpc: &'static str,
    /// Present for requests and responses, absent for notifications.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    /// Present for requests and notifications.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<&'static str>,
    /// Request parameters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    /// Response payload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// Response failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl Outbound {
    /// A request.
    #[must_use]
    pub const fn request(id: Id, method: &'static str, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0",
            id: Some(id),
            method: Some(method),
            params,
            result: None,
            error: None,
        }
    }

    /// A notification.
    #[must_use]
    pub const fn notification(method: &'static str, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0",
            id: None,
            method: Some(method),
            params,
            result: None,
            error: None,
        }
    }

    /// A successful response to a daemon request.
    #[must_use]
    pub const fn result(id: Id, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id: Some(id),
            method: None,
            params: None,
            result: Some(result),
            error: None,
        }
    }

    /// A failed response to a daemon request.
    #[must_use]
    pub const fn failure(id: Id, error: RpcError) -> Self {
        Self {
            jsonrpc: "2.0",
            id: Some(id),
            method: None,
            params: None,
            result: None,
            error: Some(error),
        }
    }
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

/// Method names, transcribed from `#/$defs/requests` in the canonical schema.
pub mod method {
    /// Handshake. Answered by `daemon.ts` itself, not by a handler.
    pub const INITIALIZE: &str = "initialize";
    /// Create a session.
    pub const SESSION_NEW: &str = "session/new";
    /// Load a session by name.
    pub const SESSION_LOAD: &str = "session/load";
    /// List sessions on disk.
    pub const SESSION_LIST: &str = "session/list";
    /// Full hydration payload for the active session.
    pub const SESSION_SNAPSHOT: &str = "session/snapshot";
    /// Run a turn.
    pub const SESSION_PROMPT: &str = "session/prompt";
    /// Inject text into the running turn as a synthetic user turn.
    pub const SESSION_STEER: &str = "session/steer";
    /// Cancel the running turn.
    pub const SESSION_CANCEL: &str = "session/cancel";
    /// Fork the transcript at an entry.
    pub const SESSION_FORK: &str = "session/fork";
    /// Move this session's head back to an entry.
    ///
    /// The mechanism a fork uses, with the opposite intent: nothing is deleted
    /// (the transcript is a DAG on disk), the turns after the entry simply stop
    /// being ancestors of the head, and the daemon reports it as
    /// `session_changed` with reason `rewind` rather than `fork`. Rewinding the
    /// conversation and reverting the working directory are two calls —
    /// this one and [`CHECKPOINT_RESTORE`] — because they are two decisions.
    pub const SESSION_REWIND: &str = "session/rewind";
    /// Run a slash command server-side.
    pub const SESSION_COMMAND: &str = "session/command";
    /// Declare the slash commands this daemon routes, with their descriptions
    /// and the shape each one answers with. Fetched once per session; the client
    /// filters the list locally.
    pub const SESSION_COMMANDS: &str = "session/commands";
    /// Server-ranked completion candidates (`@` file mentions today).
    ///
    /// The order in the answer is final — see [`crate::input::completion`].
    pub const SESSION_COMPLETE: &str = "session/complete";
    /// List the active provider's models.
    pub const SESSION_MODELS: &str = "session/models";
    /// Switch model within the active provider.
    pub const SESSION_SELECT_MODEL: &str = "session/select_model";
    /// List configured providers.
    pub const SESSION_PROVIDERS: &str = "session/providers";
    /// Switch provider (and optionally model).
    pub const SESSION_SELECT_PROVIDER: &str = "session/select_provider";
    /// **Daemon→client only.** The streaming notification, `{sessionId, update}`.
    ///
    /// It is also a deprecated client→daemon alias of [`SESSION_STEER`]; this
    /// client never sends it, which is the whole point of the rename.
    pub const SESSION_UPDATE: &str = "session/update";
    /// The provider-setup wizard's catalog: presets, persistence choices this
    /// machine can honour, protocols, and what is configured already.
    ///
    /// Read-only and side-effect free, which is what makes it answerable
    /// *before* any provider exists — the only time it matters.
    pub const PROVIDER_SETUP_OPTIONS: &str = "provider/setup_options";
    /// One cheap liveness check against an endpoint that is not saved yet.
    ///
    /// **Carries a credential.** See [`super::Secret`].
    pub const PROVIDER_VERIFY: &str = "provider/verify";
    /// Ask an endpoint what it is: which protocols it speaks, what to call it,
    /// whether it wants a credential at all. The wizard's first question, and the
    /// reason it no longer asks the user to pick a preset.
    ///
    /// **May carry a credential.** See [`super::Secret`].
    pub const PROVIDER_DETECT: &str = "provider/detect";
    /// Persist a provider and reload the daemon's provider configuration.
    ///
    /// A request naming a provider that already exists is an **update**, which is
    /// what the edit form sends. See [`super::AddProviderParams`].
    ///
    /// **May carry a credential.** See [`super::Secret`].
    pub const PROVIDER_ADD: &str = "provider/add";
    /// What one configured provider is: endpoint, protocol, where its credential
    /// lives, what it offers, whether the session is on it.
    ///
    /// **Never carries a secret.** The auth *source* is named
    /// ([`super::ProviderInfo::auth_type`]) and, at most, the place it is kept
    /// ([`super::ProviderInfo::auth_detail`] — a keychain account, a variable
    /// name). There is no field on this result a credential could travel in,
    /// which is what lets the edit form pre-fill itself from it.
    pub const PROVIDER_GET: &str = "provider/get";
    /// Forget a provider, and optionally the credential backing it.
    ///
    /// The daemon **refuses** to remove the provider the live session is on: the
    /// client's move is to switch first (`/model`), which is what the refusal is
    /// rendered as. Roles that still name the removed provider come back in
    /// `danglingRoles` rather than being silently repointed.
    pub const PROVIDER_REMOVE: &str = "provider/remove";
    /// Declare a model against a configured provider, for an endpoint that lists
    /// none. The manual half of what `provider/add`'s discovery does
    /// automatically.
    pub const MODEL_ADD: &str = "model/add";
    /// Every checkpoint of this session's working directory, newest first.
    ///
    /// A checkpoint is taken before every state-changing tool call and at both
    /// turn boundaries, so this is what a rewind picker is built from: `label`
    /// names the moment, `entryId` ties it to a transcript entry, and
    /// `changedFiles` says how much moved.
    pub const CHECKPOINT_LIST: &str = "checkpoint/list";
    /// What changed between two checkpoints, or between one and the live tree.
    ///
    /// Asked with `patches: true` when a diff is going to be drawn: the patch is
    /// per file rather than one blob, which is exactly the shape a renderer with
    /// a summary row per path and expandable hunks wants.
    pub const CHECKPOINT_DIFF: &str = "checkpoint/diff";
    /// Rewind the working directory to a checkpoint. **The only checkpoint
    /// method that writes.**
    ///
    /// Files that changed since the target *without* being attributed to one of
    /// Lyra's own tool calls come back under `preserved` and are left alone;
    /// `force` reverts those too and belongs behind a confirmation. Either way
    /// the replaced state is checkpointed first and returned as `safety`, so the
    /// restore is itself undoable.
    pub const CHECKPOINT_RESTORE: &str = "checkpoint/restore";
    /// Measure the context payload.
    pub const CONTEXT_INSPECT: &str = "context/inspect";
    /// JSON-RPC cancellation of an in-flight request by id.
    pub const CANCEL_REQUEST: &str = "$/cancelRequest";
    /// Daemon→client: the only place the daemon blocks on a human.
    pub const SESSION_REQUEST_PERMISSION: &str = "session/request_permission";
}

// ---------------------------------------------------------------------------
// Scalar vocabulary
// ---------------------------------------------------------------------------

/// Declares a closed-in-schema string enum that still tolerates a value this
/// build has not heard of: unknown spellings land in `Other` and round-trip.
macro_rules! wire_enum {
    (
        $(#[$outer:meta])*
        $name:ident { $( $(#[$doc:meta])* $variant:ident = $wire:literal ),+ $(,)? }
    ) => {
        $(#[$outer])*
        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
        pub enum $name {
            $( $(#[$doc])* #[serde(rename = $wire)] $variant, )+
            /// A value added to the protocol after this build. Kept verbatim so
            /// it round-trips and can still be shown to the user.
            #[serde(untagged)]
            Other(String),
        }

        impl $name {
            /// The wire spelling.
            #[must_use]
            pub fn as_str(&self) -> &str {
                match self {
                    $( Self::$variant => $wire, )+
                    Self::Other(value) => value.as_str(),
                }
            }

            /// Whether this value came from outside the modelled set.
            #[must_use]
            pub const fn is_unknown(&self) -> bool {
                matches!(self, Self::Other(_))
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

wire_enum! {
    /// How the provider layer classified a failure.
    Classification {
        /// Retryable upstream hiccup.
        Transient = "transient",
        /// The request exceeded the model's context window.
        ContextOverflow = "context_overflow",
        /// The provider rejected the shape of the content.
        ContentShape = "content_shape",
        /// Credentials are missing, expired, or rejected.
        Auth = "auth",
        /// Rate or spend limit.
        Quota = "quota",
        /// The selected model is not available.
        ModelUnavailable = "model_unavailable",
        /// A request the provider considers invalid.
        BadRequest = "bad_request",
        /// The model declined.
        Refusal = "refusal",
    }
}

wire_enum! {
    /// Why generation stopped.
    StopReason {
        /// The model finished its answer.
        EndTurn = "end_turn",
        /// The model asked for tools.
        ToolUse = "tool_use",
        /// The output-token ceiling was hit.
        MaxTokens = "max_tokens",
        /// The model declined.
        Refusal = "refusal",
        /// The user cancelled.
        Cancelled = "cancelled",
    }
}

wire_enum! {
    /// Which provider API shape a turn is running on.
    ApiType {
        /// `OpenAI` chat completions.
        OpenAiCompletions = "openai_completions",
        /// `OpenAI` responses.
        OpenAiResponses = "openai_responses",
        /// `OpenAI` realtime/websocket.
        OpenAiWebsocket = "openai_websocket",
        /// Anthropic messages.
        AnthropicMessages = "anthropic_messages",
    }
}

wire_enum! {
    /// What a content part holds.
    PartKind {
        /// Visible assistant text.
        Text = "text",
        /// Reasoning text.
        Thinking = "thinking",
        /// An opaque provider reasoning item.
        Reasoning = "reasoning",
        /// A tool call.
        ToolCall = "tool_call",
    }
}

wire_enum! {
    /// Which append-only field of a part a [`Delta`] targets.
    DeltaField {
        /// Visible text.
        Text = "text",
        /// Reasoning text.
        Thinking = "thinking",
        /// The signature sealing a completed thinking block.
        Signature = "signature",
        /// Serialized tool arguments.
        Arguments = "arguments",
    }
}

wire_enum! {
    /// Terminal disposition of a tool call.
    ToolStatus {
        /// Finished successfully.
        Ok = "ok",
        /// Finished with an error.
        Error = "error",
        /// Refused by the permission layer.
        Denied = "denied",
    }
}

wire_enum! {
    /// A tool call before it finishes.
    ToolPhase {
        /// Arguments are still streaming.
        Pending = "pending",
        /// Executing.
        Running = "running",
    }
}

wire_enum! {
    /// Terminal disposition of a turn.
    TurnStatus {
        /// Ran to completion.
        Completed = "completed",
        /// The user cancelled; partial output is kept and marked.
        Cancelled = "cancelled",
        /// The provider hit its output-token limit; the partial answer was kept.
        Truncated = "truncated",
        /// The model declined.
        Refusal = "refusal",
        /// The turn failed.
        Error = "error",
    }
}

wire_enum! {
    /// What started a turn.
    TurnSource {
        /// A prompt the user submitted.
        User = "user",
        /// A steering message, delivered as its own synthetic user turn.
        Steer = "steer",
        /// The agent loop continuing itself.
        Loop = "loop",
        /// A slash command.
        Command = "command",
    }
}

wire_enum! {
    /// Which drain point delivered a steering message.
    SteerBoundary {
        /// Between tool rounds.
        ToolBoundary = "tool_boundary",
        /// Between turns.
        TurnBoundary = "turn_boundary",
    }
}

wire_enum! {
    /// Who a [`Steer`] came from.
    ///
    /// Absent on the wire means the user, so a daemon that predates the field is
    /// never mistaken for one that only ever relays other agents.
    SteerSource {
        /// The person at the keyboard.
        User = "user",
        /// Another agent on the bus, folded in at a tool boundary.
        Hub = "hub",
    }
}

wire_enum! {
    /// A spawned child's lifecycle, as `#/$defs/agentState` declares it.
    ///
    /// `timed_out` and `cancelled` are deliberately separate: a deadline and a
    /// decision ask a reader for different next moves.
    AgentState {
        /// Accepted, not scheduled yet.
        Queued = "queued",
        /// Scheduled; its workspace or provider is still coming up.
        Starting = "starting",
        /// The model is working.
        Running = "running",
        /// Inside a tool call.
        AwaitingTool = "awaiting_tool",
        /// Finished with a result.
        Completed = "completed",
        /// Finished with an error.
        Failed = "failed",
        /// Its own deadline expired.
        TimedOut = "timed_out",
        /// Somebody stopped it.
        Cancelled = "cancelled",
    }
}

wire_enum! {
    /// Which transition an `agent` update *is*, as distinct from the state it
    /// left the child in (`#/$defs/update` → `agent.event`).
    ///
    /// The field exists because the state is not enough to recover the
    /// transition. `started` and `revived` both leave a child
    /// [`AgentState::Running`], so a client reading only `status` cannot tell a
    /// child that resumed from one that never stopped — and reviving a parked
    /// child is the only resume primitive there is, so a revival that renders as
    /// silence followed by a *second* "finished" row is a session the user
    /// cannot account for.
    ///
    /// Absent from a daemon that predates the field, which is read as "infer it
    /// from the status diff" — see [`crate::app::App`]'s `agent_transition`.
    AgentTransition {
        /// Accepted. The first thing said about a child.
        Spawned = "spawned",
        /// It began running for the first time.
        Started = "started",
        /// It finished with a result.
        Completed = "completed",
        /// It finished with an error.
        Failed = "failed",
        /// Somebody stopped it.
        Cancelled = "cancelled",
        /// Its own deadline expired.
        TimedOut = "timed_out",
        /// A parked child was woken and is running again.
        Revived = "revived",
    }
}

wire_enum! {
    /// The pause bracket a [`TurnResume`] closes.
    ///
    /// The daemon emits `turn_resume` for *every* pause a client could have
    /// opened, so a paused indicator can never be left hanging (DESIGN.md §2).
    PauseKind {
        /// Between provider attempts.
        Retry = "retry",
        /// Writing a compaction boundary.
        Compaction = "compaction",
        /// Repairing the context before a request.
        ContextRepair = "context_repair",
        /// Draining a steering message.
        Steer = "steer",
        /// Switching transport mid-turn.
        TransportFallback = "transport_fallback",
    }
}

wire_enum! {
    /// Why the active transcript was replaced.
    SessionChangeReason {
        /// A fresh session.
        New = "new",
        /// An existing session was loaded.
        Load = "load",
        /// The transcript was forked.
        Fork = "fork",
        /// The transcript was rewound.
        Rewind = "rewind",
    }
}

wire_enum! {
    /// What a context repair fixed.
    RepairCode {
        /// A tool call had no result.
        MissingToolResult = "missing_tool_result",
        /// A tool result had no call.
        OrphanToolResult = "orphan_tool_result",
        /// Two same-role entries were merged.
        AdjacentRoleMerge = "adjacent_role_merge",
        /// An empty content block was dropped.
        EmptyContent = "empty_content",
        /// Thinking blocks were reordered to satisfy the provider.
        ThinkingReordered = "thinking_reordered",
        /// A thinking signature was dropped.
        ThinkingSignatureDropped = "thinking_signature_dropped",
        /// Provider reasoning was dropped.
        ProviderReasoningDropped = "provider_reasoning_dropped",
        /// An image was dropped.
        ImageDropped = "image_dropped",
        /// A compaction boundary was applied.
        BoundaryApplied = "boundary_applied",
    }
}

wire_enum! {
    /// What the loop detector saw.
    LoopWarningKind {
        /// The same tool call, repeated.
        IdenticalToolCall = "identical_tool_call",
        /// Turns without progress.
        NoProgress = "no_progress",
        /// A path being flipped back and forth.
        Oscillation = "oscillation",
    }
}

wire_enum! {
    /// How `session/steer` was delivered.
    SteerDelivery {
        /// Queued into the running turn.
        Steered = "steered",
        /// No turn was running, so it started one.
        Prompted = "prompted",
    }
}

wire_enum! {
    /// The protocols a provider can be *configured* to speak.
    ///
    /// Narrower than [`ApiType`] on purpose: `openai_websocket` is a transport
    /// Lyra negotiates for an `openai_responses` provider, never something a
    /// user declares, so it cannot be written into a provider definition.
    ConfigurableApiType {
        /// `OpenAI` chat completions.
        OpenAiCompletions = "openai_completions",
        /// `OpenAI` responses.
        OpenAiResponses = "openai_responses",
        /// Anthropic messages.
        AnthropicMessages = "anthropic_messages",
    }
}

impl ConfigurableApiType {
    /// Every protocol the schema declares, in the order a picker offers them.
    ///
    /// The closed set, so a client can build a row per protocol before any
    /// daemon has answered — which is what the setup form's per-protocol
    /// second-entry rows are. A value the schema grows later arrives as
    /// `Other` and simply has no row until this build learns it.
    pub const CONCRETE: [Self; 3] = [
        Self::OpenAiResponses,
        Self::OpenAiCompletions,
        Self::AnthropicMessages,
    ];

    /// The one-word name a second provider for this protocol is suffixed with:
    /// `local-anthropic` beside `local`.
    #[must_use]
    pub fn suffix(&self) -> String {
        match self {
            Self::OpenAiResponses => "responses".to_owned(),
            Self::OpenAiCompletions => "completions".to_owned(),
            Self::AnthropicMessages => "anthropic".to_owned(),
            Self::Other(value) => value
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                .collect(),
        }
    }
}

wire_enum! {
    /// Where the credential comes to rest once setup finishes.
    ///
    /// The user's *choice*, deliberately not the on-disk `auth.type`
    /// vocabulary: `plaintext` says what it costs where `static` does not.
    ProviderPersist {
        /// The OS keychain holds the token; the config keeps a reference.
        Keychain = "keychain",
        /// The token itself is written into `~/.lyra/providers.toml` (0600).
        Plaintext = "plaintext",
        /// No token is stored anywhere; a variable this process exports is named.
        Env = "env",
        /// A local endpoint that wants no credential at all.
        NoCredential = "none",
        /// **Edits only.** Leave the credential exactly as it is: reuse whatever
        /// already backs this provider, whichever of the four it is. Requires the
        /// provider to exist, and carries neither `apiKey` nor `authEnvVar` — it
        /// is the one persistence choice that *declines* to say anything about a
        /// credential, which is how an edit that changes an endpoint does not
        /// have to re-type a key to keep it.
        Keep = "keep",
    }
}

wire_enum! {
    /// The auth *source* now backing a provider, as `provider/add` reports it.
    ProviderAuthSource {
        /// The OS keychain.
        Keychain = "keychain",
        /// An environment variable, by name.
        Env = "env",
        /// A literal token in the config file.
        Static = "static",
        /// Nothing.
        NoCredential = "none",
        /// A credential helper named by a hand-written config. Nothing in the
        /// setup surface creates one; `provider/get` still has to describe one
        /// honestly rather than mislabel it as something this client can edit.
        Plugin = "plugin",
    }
}

wire_enum! {
    /// Whether a provider may be driven over a websocket transport.
    WebsocketMode {
        /// Negotiate it when the provider supports it.
        Auto = "auto",
        /// Always.
        On = "on",
        /// Never.
        Off = "off",
    }
}

wire_enum! {
    /// What a permission option does.
    PermissionKind {
        /// Allow this once.
        AllowOnce = "allow_once",
        /// Allow from now on.
        AllowAlways = "allow_always",
        /// Refuse.
        Reject = "reject",
    }
}

// ---------------------------------------------------------------------------
// Shared objects
// ---------------------------------------------------------------------------

/// A provider failure, in raw parts. The client composes its own sentence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderError {
    /// How the provider layer classified it.
    pub classification: Classification,
    /// The provider's own message.
    pub message: String,
    /// Provider error code, when it supplied one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// HTTP status, when there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u32>,
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.classification, self.message)
    }
}

/// One repair applied to the context before a request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextRepair {
    /// What was fixed.
    pub code: RepairCode,
    /// Human-readable explanation.
    pub detail: String,
    /// Transcript entry the repair applied to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    /// Tokens involved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_estimate: Option<u64>,
    /// Fields this build does not model (`additionalProperties: true`).
    #[serde(flatten, default, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

/// A loop-detector warning.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopWarning {
    /// What the detector saw.
    #[serde(rename = "type")]
    pub kind: LoopWarningKind,
    /// Tool name, for `identical_tool_call`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// Repetition count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    /// Turn count, for `no_progress`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turns: Option<u64>,
    /// Path, for `oscillation`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Call hash, when the detector keyed on one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    /// Fields this build does not model (`additionalProperties: true`).
    #[serde(flatten, default, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

/// A file a tool wrote, with before/after hashes when it had them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Path on disk.
    pub path: String,
    /// Content hash before the write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_hash: Option<String>,
    /// Content hash after the write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_hash: Option<String>,
    /// Fields this build does not model.
    #[serde(flatten, default, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

/// Filesystem and exec effects a tool reported.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProgress {
    /// Paths read.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files_read: Vec<String>,
    /// Paths written.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files_modified: Vec<FileChange>,
    /// Exit code, for command tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_exit_code: Option<i64>,
    /// Fields this build does not model.
    #[serde(flatten, default, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

/// A session as the daemon describes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDescriptor {
    /// Stable session identifier.
    pub session_id: String,
    /// Human-readable session name.
    pub name: String,
    /// Transcript path on disk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Current transcript head.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_id: Option<String>,
    /// ISO-8601 creation timestamp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Fields this build does not model.
    #[serde(flatten, default, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

/// One model offered by the active provider.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// Model identifier.
    pub id: String,
    /// Owning organisation, when the provider reports one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,
    /// Verified context window. Absent ⇒ render no percentage (DESIGN.md §2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// Input price per million tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_price_per_million: Option<f64>,
    /// Output price per million tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_price_per_million: Option<f64>,
    /// Fields this build does not model.
    #[serde(flatten, default, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

// ---------------------------------------------------------------------------
// The update union
// ---------------------------------------------------------------------------

/// `turn_start` — a turn began.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStart {
    /// The turn, including every model round, tool round and steering injection.
    pub turn_id: String,
    /// Transcript entry holding the prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_entry_id: Option<String>,
    /// What started it.
    pub source: TurnSource,
    /// Wall-clock start.
    pub started_at_ms: i64,
}

/// `turn_resume` — a pause bracket closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnResume {
    /// The turn that resumed.
    pub turn_id: String,
    /// Which pause ended.
    pub after: PauseKind,
    /// How long the pause lasted.
    pub paused_ms: u64,
}

/// `turn_end` — a turn reached a terminal state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEnd {
    /// The turn.
    pub turn_id: String,
    /// Terminal disposition.
    pub status: TurnStatus,
    /// Provider stop reason, when there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<StopReason>,
    /// Total turn duration.
    pub duration_ms: u64,
    /// Whether assistant output survived a cancel or truncation.
    pub partial_retained: bool,
    /// Whether a zero-output cancelled turn had its prompt trimmed because the
    /// client rewound it into the composer (DESIGN.md §0.2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_trimmed: Option<bool>,
    /// Whether the loop detector demanded a hard stop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hard_stop_requested: Option<bool>,
    /// The failure, for `status: error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ProviderError>,
}

/// `message_start` — an assistant message opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageStart {
    /// Owning turn.
    pub turn_id: String,
    /// The message.
    pub message_id: String,
    /// Author. Only `assistant` is declared.
    pub role: String,
}

/// `part_start` — a content part opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartStart {
    /// Owning message.
    pub message_id: String,
    /// The part.
    pub part_id: String,
    /// What it holds.
    pub kind: PartKind,
    /// The tool call, for `kind: tool_call`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// `delta` — the only shape streamed content ever takes.
///
/// An **append** to `(messageId, partId, field)`, never a resend of accumulated
/// content. This is what lets a committed scrollback row stay committed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    /// Owning message.
    pub message_id: String,
    /// Target part.
    pub part_id: String,
    /// Target field.
    pub field: DeltaField,
    /// The appended chunk.
    pub delta: String,
}

/// `part_end` — a content part closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartEnd {
    /// Owning message.
    pub message_id: String,
    /// The part.
    pub part_id: String,
}

/// `reasoning_item` — opaque provider reasoning, arriving whole.
///
/// Carried raw: a client renders it or ignores it, but never reinterprets it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningItem {
    /// Owning message.
    pub message_id: String,
    /// The part it occupies.
    pub part_id: String,
    /// Which provider produced it.
    pub provider: String,
    /// The payload, verbatim.
    pub item: Value,
}

/// `message_end` — an assistant message closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEnd {
    /// The message.
    pub message_id: String,
    /// Why it stopped.
    pub stop_reason: StopReason,
}

/// `tool_call_start` — a tool call appeared.
///
/// The home is never optional: a provider that did not stream the call gets a
/// part minted for it by the daemon's encoder, so this client never has to
/// invent a message or part to hang the row on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallStart {
    /// Provider-assigned call id, stable through `tool_call_end`.
    pub tool_call_id: String,
    /// Owning message.
    pub message_id: String,
    /// Owning part.
    pub part_id: String,
    /// Tool name.
    pub tool: String,
    /// One-line summary of the arguments known at start. Absent while they stream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args_summary: Option<String>,
}

/// `tool_call_update` — a tool call advanced without finishing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallUpdate {
    /// The call.
    pub tool_call_id: String,
    /// Where it stands.
    pub status: ToolPhase,
    /// Tool name, repeated for a client that missed the start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// One-line argument summary — the collapsed tool row's subject.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args_summary: Option<String>,
    /// Full parsed arguments, once the model finished streaming them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
    /// When execution began.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<i64>,
}

/// `tool_call_end` — a tool call reached a terminal state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallEnd {
    /// The call.
    pub tool_call_id: String,
    /// Tool name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// Terminal disposition.
    pub status: ToolStatus,
    /// First meaningful line of the result — the collapsed row's outcome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<String>,
    /// How long it ran.
    pub duration_ms: u64,
    /// Whether a wait-class tool was cut short by steering (DESIGN.md §0.2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<bool>,
    /// Filesystem and exec effects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<ToolProgress>,
}

/// `retry` — raw retry facts.
///
/// The client composes its own copy and runs its own 1 Hz countdown from
/// `retry_at_ms`; the daemon never ships a pre-rendered sentence as the contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Retry {
    /// 1-based attempt number.
    pub attempt: u32,
    /// Attempt ceiling.
    pub max_attempts: u32,
    /// How the failure was classified.
    pub classification: Classification,
    /// The provider's own message.
    pub provider_message: String,
    /// Delay before the next attempt.
    pub delay_ms: u64,
    /// Wall-clock instant of the next attempt — the countdown's anchor.
    pub retry_at_ms: i64,
    /// Whether the retry discarded partial output the client already rendered.
    pub resets_partial_output: bool,
}

/// `compaction` — a compaction boundary was written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Compaction {
    /// Boundary entry id.
    pub boundary_id: String,
    /// Context size before.
    pub tokens_before: u64,
    /// Context size after.
    pub tokens_after: u64,
    /// First transcript entry surviving the boundary; `null` when everything
    /// before it was cleared — a meaningful value, so it is always serialized.
    #[serde(default)]
    pub first_kept_entry: Option<String>,
}

impl Compaction {
    /// Tokens the boundary reclaimed, for `─ compacted · −38k tokens ─`.
    #[must_use]
    pub const fn tokens_reclaimed(&self) -> u64 {
        self.tokens_before.saturating_sub(self.tokens_after)
    }
}

/// `context_repair` — repairs applied before a request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextRepairs {
    /// The repairs, at least one.
    pub repairs: Vec<ContextRepair>,
}

/// `context` — measured size of the payload about to be sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMeasurement {
    /// Estimated tokens in the payload.
    pub token_estimate: u64,
    /// How many transcript entries fed it.
    pub source_entry_count: u64,
    /// Present only when a *verified* limit is known for the active model. Absent
    /// ⇒ render nothing rather than a wrong percentage (DESIGN.md §2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

impl ContextMeasurement {
    /// Fraction of the window in use, or `None` when no verified limit is known.
    #[must_use]
    pub fn fraction_used(&self) -> Option<f64> {
        self.context_window
            .filter(|window| *window > 0)
            .map(|window| {
                #[allow(clippy::cast_precision_loss)]
                {
                    self.token_estimate as f64 / window as f64
                }
            })
    }
}

/// `usage` — raw token counts for one provider call plus session totals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// The provider call that just finished.
    pub turn: TurnUsage,
    /// The running total for the whole session.
    pub session: SessionUsage,
}

/// Token counts for a single provider call.
///
/// Split from [`SessionUsage`] on the wire because `inputTokens` beside
/// `sessionInputTokens` is a footgun: two scopes, one naming convention, and a
/// client that confuses them renders a call's numbers as the session total.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsage {
    /// Prompt tokens for this call.
    pub input_tokens: u64,
    /// Completion tokens for this call.
    pub output_tokens: u64,
    /// Tokens served from cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    /// Tokens written to cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
}

/// Cumulative token counts for the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    /// Cumulative prompt tokens.
    pub input_tokens: u64,
    /// Cumulative completion tokens.
    pub output_tokens: u64,
    /// Cumulative cost, present only when the active model has known pricing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_micro_usd: Option<u64>,
}

/// `steer` — a steering message landed as its own synthetic user turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Steer {
    /// Transcript entry it was written as.
    pub entry_id: String,
    /// The text.
    pub text: String,
    /// Which drain point delivered it.
    pub at: SteerBoundary,
    /// Who spoke. Absent means the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SteerSource>,
    /// The peer that sent a `hub` aside.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// `loop_warning` — the loop detector fired.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopWarningUpdate {
    /// What it saw.
    pub warning: LoopWarning,
    /// Whether it demanded a hard stop.
    pub hard_stop_requested: bool,
}

/// `transport_fallback` — the turn switched provider API shape mid-flight.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportFallback {
    /// Transport that failed.
    pub from: ApiType,
    /// Transport it fell back to.
    pub to: ApiType,
    /// Why.
    pub reason: String,
    /// Whether partial output the client rendered was discarded.
    pub resets_partial_output: bool,
}

/// `error` — a provider failure, outside a turn's terminal status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorUpdate {
    /// The failure.
    pub error: ProviderError,
}

/// `report` — an audit line from a background subsystem.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The line, already human-readable.
    pub message: String,
}

/// `model_changed` — the active model or provider changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChanged {
    /// Active provider.
    pub provider: String,
    /// Active model.
    pub model: String,
    /// Transport the model runs on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_type: Option<ApiType>,
}

/// `session_changed` — the active transcript was replaced.
///
/// A client discards its store and re-hydrates via `session/snapshot`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionChanged {
    /// The new session.
    pub descriptor: SessionDescriptor,
    /// Why it changed.
    pub reason: SessionChangeReason,
}

/// An update this build does not model, kept whole.
///
/// Two ways to get here: a `sessionUpdate` tag that is not in the 25 (the daemon
/// grew a variant), or a known tag whose body failed to decode (a field changed
/// type). Either way the frame is preserved, not dropped, and the client keeps
/// running.
#[derive(Debug, Clone, PartialEq)]
pub struct UnknownUpdate {
    /// The `sessionUpdate` tag, whatever it was.
    pub tag: String,
    /// The rest of the object, verbatim.
    pub fields: Map<String, Value>,
    /// Decoder complaint, when this was a *known* tag that failed to decode.
    pub error: Option<String>,
}

impl UnknownUpdate {
    fn unrecognised(tag: &str, value: Value) -> Self {
        let mut fields = match value {
            Value::Object(map) => map,
            other => {
                let mut map = Map::new();
                map.insert("value".to_owned(), other);
                map
            }
        };
        fields.remove("sessionUpdate");
        Self {
            tag: tag.to_owned(),
            fields,
            error: None,
        }
    }

    fn malformed(tag: &str, error: &serde_json::Error) -> Self {
        Self {
            tag: tag.to_owned(),
            fields: Map::new(),
            error: Some(error.to_string()),
        }
    }

    fn to_json(&self) -> Value {
        let mut map = self.fields.clone();
        map.insert(
            "sessionUpdate".to_owned(),
            Value::String(self.tag.clone()),
        );
        Value::Object(map)
    }
}

/// `agent` — a spawned child changed state.
///
/// The observability half of the delegation surface: every lifecycle transition
/// crosses the wire, so a presence strip renders from a stream rather than from
/// polling. Counts, not paths — the paths belong to the child's own result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdate {
    /// The spawn id, `spawn-N`. Stable across a revival.
    pub id: String,
    /// The bus name the child answers to.
    pub peer: String,
    /// The short name its parent gave it, when it gave one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Where it is in its life.
    pub status: AgentState,
    /// Which transition this *is*, when the daemon says so.
    ///
    /// Authoritative when present, because [`AgentState`] cannot express it:
    /// `started` and `revived` are both [`AgentState::Running`]. Absent from an
    /// older daemon, and the client falls back to diffing the previous status.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<AgentTransition>,
    /// Omitted when the child inherited a model that was never named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 0 for a child of the main session, 1 for a grandchild.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
    /// The directory its tools operate in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// How many tool calls it has made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<u32>,
    /// How many distinct paths its tools reported changing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_modified: Option<u32>,
    /// Present on `failed` and `timed_out`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One semantic event: the 25-variant union `#/$defs/update` declares.
///
/// The `sessionUpdate` tag discriminates. Dispatch on [`Update::tag`] rather
/// than re-reading raw JSON — nothing outside `acp::` should name a wire key.
#[derive(Debug, Clone, PartialEq)]
pub enum Update {
    /// A turn began.
    TurnStart(TurnStart),
    /// A pause bracket closed.
    TurnResume(TurnResume),
    /// A turn reached a terminal state.
    TurnEnd(TurnEnd),
    /// An assistant message opened.
    MessageStart(MessageStart),
    /// A content part opened.
    PartStart(PartStart),
    /// An append to one `(message, part, field)`.
    Delta(Delta),
    /// A content part closed.
    PartEnd(PartEnd),
    /// Opaque provider reasoning, whole.
    ReasoningItem(ReasoningItem),
    /// An assistant message closed.
    MessageEnd(MessageEnd),
    /// A tool call appeared.
    ToolCallStart(ToolCallStart),
    /// A tool call advanced.
    ToolCallUpdate(ToolCallUpdate),
    /// A tool call finished.
    ToolCallEnd(ToolCallEnd),
    /// A retry is scheduled.
    Retry(Retry),
    /// A compaction boundary was written.
    Compaction(Compaction),
    /// The context was repaired.
    ContextRepair(ContextRepairs),
    /// The outgoing payload was measured.
    Context(ContextMeasurement),
    /// Token accounting.
    Usage(Usage),
    /// A steering message landed.
    Steer(Steer),
    /// The loop detector fired.
    LoopWarning(LoopWarningUpdate),
    /// The transport changed mid-turn.
    TransportFallback(TransportFallback),
    /// A provider failure.
    Error(ErrorUpdate),
    /// A background audit line.
    Report(Report),
    /// The active model or provider changed.
    ModelChanged(ModelChanged),
    /// The active transcript was replaced.
    SessionChanged(SessionChanged),
    /// A spawned child changed state.
    Agent(AgentUpdate),
    /// Something this build does not model. Never fatal.
    Unknown(UnknownUpdate),
}

/// Every `sessionUpdate` tag this build models, in schema order.
///
/// `acp::conformance` asserts this equals the schema's declared `oneOf`
/// titles, which is what makes a daemon-side addition a *test* failure here
/// rather than a silent shrug at runtime.
pub const UPDATE_TAGS: [&str; 25] = [
    "turn_start",
    "turn_resume",
    "turn_end",
    "message_start",
    "part_start",
    "delta",
    "part_end",
    "reasoning_item",
    "message_end",
    "tool_call_start",
    "tool_call_update",
    "tool_call_end",
    "retry",
    "compaction",
    "context_repair",
    "context",
    "usage",
    "steer",
    "loop_warning",
    "transport_fallback",
    "error",
    "report",
    "model_changed",
    "session_changed",
    "agent",
];

impl Update {
    /// The `sessionUpdate` tag.
    #[must_use]
    pub fn tag(&self) -> &str {
        match self {
            Self::TurnStart(_) => "turn_start",
            Self::TurnResume(_) => "turn_resume",
            Self::TurnEnd(_) => "turn_end",
            Self::MessageStart(_) => "message_start",
            Self::PartStart(_) => "part_start",
            Self::Delta(_) => "delta",
            Self::PartEnd(_) => "part_end",
            Self::ReasoningItem(_) => "reasoning_item",
            Self::MessageEnd(_) => "message_end",
            Self::ToolCallStart(_) => "tool_call_start",
            Self::ToolCallUpdate(_) => "tool_call_update",
            Self::ToolCallEnd(_) => "tool_call_end",
            Self::Retry(_) => "retry",
            Self::Compaction(_) => "compaction",
            Self::ContextRepair(_) => "context_repair",
            Self::Context(_) => "context",
            Self::Usage(_) => "usage",
            Self::Steer(_) => "steer",
            Self::LoopWarning(_) => "loop_warning",
            Self::TransportFallback(_) => "transport_fallback",
            Self::Error(_) => "error",
            Self::Report(_) => "report",
            Self::ModelChanged(_) => "model_changed",
            Self::SessionChanged(_) => "session_changed",
            Self::Agent(_) => "agent",
            Self::Unknown(unknown) => unknown.tag.as_str(),
        }
    }

    /// Whether this frame carried something this build does not model.
    #[must_use]
    pub const fn is_unknown(&self) -> bool {
        matches!(self, Self::Unknown(_))
    }

    /// Re-encode to the wire object, tag included.
    ///
    /// # Panics
    ///
    /// Never: every payload is a plain struct of JSON-representable fields.
    #[must_use]
    pub fn to_json(&self) -> Value {
        macro_rules! encode {
            ($tag:literal, $payload:expr) => {
                (
                    $tag,
                    serde_json::to_value($payload).unwrap_or(Value::Null),
                )
            };
        }
        let (tag, payload) = match self {
            Self::TurnStart(payload) => encode!("turn_start", payload),
            Self::TurnResume(payload) => encode!("turn_resume", payload),
            Self::TurnEnd(payload) => encode!("turn_end", payload),
            Self::MessageStart(payload) => encode!("message_start", payload),
            Self::PartStart(payload) => encode!("part_start", payload),
            Self::Delta(payload) => encode!("delta", payload),
            Self::PartEnd(payload) => encode!("part_end", payload),
            Self::ReasoningItem(payload) => encode!("reasoning_item", payload),
            Self::MessageEnd(payload) => encode!("message_end", payload),
            Self::ToolCallStart(payload) => encode!("tool_call_start", payload),
            Self::ToolCallUpdate(payload) => encode!("tool_call_update", payload),
            Self::ToolCallEnd(payload) => encode!("tool_call_end", payload),
            Self::Retry(payload) => encode!("retry", payload),
            Self::Compaction(payload) => encode!("compaction", payload),
            Self::ContextRepair(payload) => encode!("context_repair", payload),
            Self::Context(payload) => encode!("context", payload),
            Self::Usage(payload) => encode!("usage", payload),
            Self::Steer(payload) => encode!("steer", payload),
            Self::LoopWarning(payload) => encode!("loop_warning", payload),
            Self::TransportFallback(payload) => encode!("transport_fallback", payload),
            Self::Error(payload) => encode!("error", payload),
            Self::Report(payload) => encode!("report", payload),
            Self::ModelChanged(payload) => encode!("model_changed", payload),
            Self::SessionChanged(payload) => encode!("session_changed", payload),
            Self::Agent(payload) => encode!("agent", payload),
            Self::Unknown(unknown) => return unknown.to_json(),
        };
        let mut map = match payload {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        map.insert("sessionUpdate".to_owned(), Value::String(tag.to_owned()));
        Value::Object(map)
    }

    /// Decode from the wire object. Never fails: see [`UnknownUpdate`].
    #[must_use]
    pub fn from_json(value: Value) -> Self {
        let tag = value
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        macro_rules! decode {
            ($constructor:path) => {
                match serde_json::from_value(value) {
                    Ok(payload) => $constructor(payload),
                    Err(error) => Self::Unknown(UnknownUpdate::malformed(&tag, &error)),
                }
            };
        }
        match tag.as_str() {
            "turn_start" => decode!(Self::TurnStart),
            "turn_resume" => decode!(Self::TurnResume),
            "turn_end" => decode!(Self::TurnEnd),
            "message_start" => decode!(Self::MessageStart),
            "part_start" => decode!(Self::PartStart),
            "delta" => decode!(Self::Delta),
            "part_end" => decode!(Self::PartEnd),
            "reasoning_item" => decode!(Self::ReasoningItem),
            "message_end" => decode!(Self::MessageEnd),
            "tool_call_start" => decode!(Self::ToolCallStart),
            "tool_call_update" => decode!(Self::ToolCallUpdate),
            "tool_call_end" => decode!(Self::ToolCallEnd),
            "retry" => decode!(Self::Retry),
            "compaction" => decode!(Self::Compaction),
            "context_repair" => decode!(Self::ContextRepair),
            "context" => decode!(Self::Context),
            "usage" => decode!(Self::Usage),
            "steer" => decode!(Self::Steer),
            "loop_warning" => decode!(Self::LoopWarning),
            "transport_fallback" => decode!(Self::TransportFallback),
            "error" => decode!(Self::Error),
            "report" => decode!(Self::Report),
            "model_changed" => decode!(Self::ModelChanged),
            "session_changed" => decode!(Self::SessionChanged),
            "agent" => decode!(Self::Agent),
            other => Self::Unknown(UnknownUpdate::unrecognised(other, value)),
        }
    }
}

impl Serialize for Update {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Update {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self::from_json(Value::deserialize(deserializer)?))
    }
}

/// Params of the `session/update` **notification**: the canonical envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotification {
    /// Which transcript this belongs to.
    pub session_id: String,
    /// The one semantic update this frame carries.
    pub update: Update,
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// `initialize` result.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    /// Currently the literal `"1"`.
    #[serde(default)]
    pub protocol_version: Option<String>,
    /// Daemon identity.
    #[serde(default)]
    pub server_info: Option<ServerInfo>,
    /// Declared capabilities.
    #[serde(default)]
    pub capabilities: Option<Capabilities>,
}

/// Daemon name and version.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ServerInfo {
    /// Server name, default `"lyra"`.
    pub name: String,
    /// Server version.
    pub version: String,
}

/// Daemon capabilities.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct Capabilities {
    /// Methods the daemon routes.
    #[serde(default)]
    pub methods: Vec<String>,
    /// Whether the daemon may send us requests. Always `true` today.
    #[serde(default)]
    pub bidirectional: bool,
    /// Whether `$/cancelRequest` is honoured.
    #[serde(default)]
    pub cancellation: bool,
    /// Transport tag, `"stdio"`.
    #[serde(default)]
    pub transport: Option<String>,
}

impl Capabilities {
    /// Whether the daemon routes a method, so the client can degrade instead of
    /// firing a call that will come back `-32601`.
    #[must_use]
    pub fn has(&self, method: &str) -> bool {
        self.methods.iter().any(|declared| declared == method)
    }
}

/// `session/new` params.
#[derive(Debug, Clone, Default, Serialize)]
pub struct NewSessionParams {
    /// Session name; the daemon invents one when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// `session/load` params.
#[derive(Debug, Clone, Serialize)]
pub struct LoadSessionParams {
    /// Session name.
    pub name: String,
}

/// One row of `session/list`.
///
/// The three preview fields are optional and **independently** absent: an old daemon
/// sends none of them, a transcript with nothing said in it has no first prompt, and a
/// transcript too large for the daemon's scan budget has no message count. Absent means
/// "not measured", so the picker renders nothing for it rather than a zero.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    /// The id every `session/update` frame for this transcript is tagged with.
    /// `name` is only a filename; this is what correlates a row with live traffic.
    pub session_id: String,
    /// Session name.
    pub name: String,
    /// Transcript path.
    pub path: String,
    /// Whether this is the session the daemon has open.
    pub active: bool,
    /// The session's first user prompt, already collapsed and truncated daemon-side.
    #[serde(default)]
    pub first_prompt: Option<String>,
    /// The transcript file's mtime, in epoch milliseconds. Raw: the "2h ago" is this
    /// client's to derive (DESIGN.md §2).
    #[serde(default)]
    pub updated_at_ms: Option<i64>,
    /// How many message entries the transcript holds.
    #[serde(default)]
    pub messages: Option<u64>,
    /// Fields this build does not model.
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

/// `session/snapshot` result — the hydration payload.
///
/// Fetched once at attach; live updates apply on top, and a live update that
/// arrives *during* the fetch wins (DESIGN.md build phase 3).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    /// The session.
    pub descriptor: SessionDescriptor,
    /// Transcript entries, in the daemon's own JSONL shape.
    #[serde(default)]
    pub entries: Vec<Value>,
    /// Active provider.
    #[serde(default)]
    pub provider: String,
    /// Active model.
    #[serde(default)]
    pub model: String,
    /// Transport the model runs on.
    #[serde(default)]
    pub api_type: Option<ApiType>,
    /// The directory this session's tools operate in: the launch directory for a
    /// main session, its own workspace for an isolated agent.
    ///
    /// A **real path the user can `cd` into**, which is why the header prints it
    /// verbatim rather than abbreviating it to a workspace name (DESIGN.md §3).
    #[serde(default)]
    pub workspace: Option<String>,
    /// Whether a turn is running right now.
    #[serde(default)]
    pub turn_active: Option<bool>,
    /// Steering messages queued but not yet drained.
    #[serde(default)]
    pub pending_steer: Option<u64>,
    /// `false` when the daemon booted with **no provider configured**.
    ///
    /// The session is real and every non-provider method works, but a prompt
    /// will be refused until `provider/add` runs, so a client that sees `false`
    /// opens setup instead of a composer. **Absent is read as true**, so a
    /// daemon that predates the field is not mistaken for an unconfigured one —
    /// which is why this is an `Option<bool>` and never a `#[serde(default)]`
    /// `bool`.
    #[serde(default)]
    pub provider_configured: Option<bool>,
    /// Cumulative measurements.
    #[serde(default)]
    pub usage: Option<SnapshotUsage>,
    /// The children this session has spawned.
    ///
    /// Absent on a daemon that predates the field, which reads as "none known
    /// yet" rather than "none exist": the presence strip then fills in from the
    /// next `agent` transition instead of from hydration.
    #[serde(default)]
    pub agents: Vec<AgentHandle>,
}

impl SessionSnapshot {
    /// Whether the daemon has a provider to talk to.
    ///
    /// Absent ⇒ `true`: see [`SessionSnapshot::provider_configured`].
    #[must_use]
    pub const fn is_provider_configured(&self) -> bool {
        match self.provider_configured {
            Some(configured) => configured,
            None => true,
        }
    }
}

/// Cumulative measurements carried by a snapshot.
///
/// `session` is the same [`SessionUsage`] the `usage` update carries, so
/// hydrating and streaming speak one vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotUsage {
    /// Cumulative session totals.
    #[serde(default)]
    pub session: SessionUsage,
    /// Tokens currently in context.
    #[serde(default)]
    pub context_tokens: Option<u64>,
    /// Verified context window. Absent ⇒ no percentage.
    #[serde(default)]
    pub context_window: Option<u64>,
}

/// `session/prompt` params.
#[derive(Debug, Clone, Serialize)]
pub struct PromptParams {
    /// The user's text.
    pub prompt: String,
}

/// `session/prompt` result.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResult {
    /// Why the turn stopped.
    pub stop_reason: StopReason,
}

/// `session/steer` params.
#[derive(Debug, Clone, Serialize)]
pub struct SteerParams {
    /// The steering text. Lands as a standalone synthetic user turn.
    pub prompt: String,
}

/// `session/steer` result.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteerResult {
    /// Whether it was queued into a running turn or started one.
    pub delivery: SteerDelivery,
    /// Steering messages queued but not yet drained.
    #[serde(default)]
    pub pending: Option<u64>,
}

/// `session/cancel` params.
///
/// `rewound_to_composer` is the client asserting it has put the prompt text back
/// in the composer and taken ownership of it. Only then does the daemon trim a
/// zero-output turn's prompt from history — that is the whole fix for the
/// send+cancel double-prompt bug (DESIGN.md §0.2).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    /// Whether the client has restored the prompt into its composer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rewound_to_composer: Option<bool>,
}

/// `session/cancel` result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelResult {
    /// Whether a turn was actually running.
    pub cancelled: bool,
    /// Whether the prompt was trimmed from history.
    #[serde(default)]
    pub prompt_trimmed: Option<bool>,
}

/// `session/fork` params.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkParams {
    /// Entry to fork at; the head when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
}

/// `session/fork` result.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ForkResult {
    /// The forked session.
    pub descriptor: SessionDescriptor,
}

/// `session/command` params.
#[derive(Debug, Clone, Serialize)]
pub struct CommandParams {
    /// The command line, without the leading slash.
    pub command: String,
}

/// `session/models` params.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ModelsParams {
    /// Re-query the provider rather than serving the cached list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh: Option<bool>,
}

/// One configured provider and every model it offers.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ProviderModels {
    /// Provider id, the left half of every `provider/model` reference.
    pub provider: String,
    /// What its endpoint listed, unioned with what its config declares. Empty
    /// means "nothing we could learn", never "this provider is gone".
    #[serde(default)]
    pub models: Vec<ModelInfo>,
}

/// `session/models` result — **the model surface across every configured
/// provider**, which is what makes `/model` the one switching surface.
///
/// Both shapes decode. A daemon that predates the reshape answers with one
/// provider's flat list and takes a bare model id back; the reshaped one
/// answers grouped and takes a `provider/model` reference. Rendering is
/// whichever arrived — see `app::model_choices`.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct ModelsResult {
    /// The selection, as a `provider/model` reference — or a bare model id from
    /// a pre-reshape daemon. Absent exactly when nothing is configured.
    #[serde(default)]
    pub current: Option<String>,
    /// Every configured provider and its models.
    #[serde(default)]
    pub providers: Vec<ProviderModels>,
    /// The provider a pre-reshape daemon's flat list belongs to.
    #[serde(default)]
    pub provider: Option<String>,
    /// That flat list.
    #[serde(default)]
    pub models: Vec<ModelInfo>,
    /// Role→model assignments, when configured.
    #[serde(default)]
    pub roles: Option<Value>,
    /// Whether this answer came from a fresh query.
    #[serde(default)]
    pub refreshed: Option<bool>,
}

/// `session/select_model` params.
#[derive(Debug, Clone, Serialize)]
pub struct SelectModelParams {
    /// Model id.
    pub model: String,
}

/// Result of `session/select_model` and `session/select_provider`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ModelSelection {
    /// Provider now active.
    pub provider: String,
    /// Model now active.
    pub model: String,
}

/// `session/providers` result.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ProvidersResult {
    /// Provider now active.
    pub current: String,
    /// Providers that are configured and usable.
    #[serde(default)]
    pub available: Vec<String>,
}

/// `session/select_provider` params.
#[derive(Debug, Clone, Serialize)]
pub struct SelectProviderParams {
    /// Provider id.
    pub provider: String,
    /// Model to select with it; the provider's default when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// `context/inspect` result.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInspectResult {
    /// Estimated tokens in the payload that would be sent now.
    pub token_estimate: u64,
    /// Fields this build does not model.
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

/// `session/rewind` params. Absent `entryId` asks the daemon for the entry the
/// newest anchored checkpoint points at.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindParams {
    /// The transcript entry the head should land on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
}

/// `session/rewind` result.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindResult {
    /// The session, with its head moved.
    pub descriptor: SessionDescriptor,
    /// The entry the head now sits on — echoed, because a caller that sent none
    /// asked the daemon to choose.
    pub entry_id: String,
    /// How many message entries stopped being ancestors of the head. Absent
    /// means the daemon did not count, which is not the same as zero.
    #[serde(default)]
    pub removed_messages: Option<u64>,
}

// ---------------------------------------------------------------------------
// Checkpoints — the rewind surface
// ---------------------------------------------------------------------------

wire_enum! {
    /// Why a checkpoint was taken, as `#/$defs/checkpoint`'s `kind` declares it.
    CheckpointKind {
        /// At the start of a turn.
        TurnStart = "turn_start",
        /// In front of a state-changing tool call.
        PreTool = "pre_tool",
        /// At the end of a turn.
        TurnEnd = "turn_end",
        /// Immediately before a restore replaced the tree — the undo.
        PreRestore = "pre_restore",
        /// Asked for by name.
        Manual = "manual",
    }
}

/// One recorded state of the session's working directory.
///
/// `id` is the stable handle: `/cleanup` thins the history by rewriting it and
/// ids survive that. `entry_id` anchors the checkpoint to the transcript entry it
/// precedes, which is the one field that makes rewinding conversation and code
/// together possible at all.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    /// Stable id.
    pub id: String,
    /// Why it was taken.
    pub kind: CheckpointKind,
    /// Human label for the moment.
    #[serde(default)]
    pub label: String,
    /// ISO-8601 instant.
    #[serde(default)]
    pub created_at: String,
    /// Paths differing from the checkpoint before this one.
    #[serde(default)]
    pub changed_files: u64,
    /// The transcript entry this checkpoint precedes.
    #[serde(default)]
    pub entry_id: Option<String>,
    /// The tool it was taken in front of, for `pre_tool`.
    #[serde(default)]
    pub tool: Option<String>,
    /// That tool call's id.
    #[serde(default)]
    pub call_id: Option<String>,
    /// Paths that were outside the snapshot entirely, so a restore is never
    /// quietly partial.
    #[serde(default)]
    pub excluded: Vec<String>,
}

impl Checkpoint {
    /// What the picker's left column says: the label, falling back to the id.
    #[must_use]
    pub fn title(&self) -> &str {
        if self.label.trim().is_empty() {
            &self.id
        } else {
            &self.label
        }
    }

    /// Whether this checkpoint names a transcript entry, and can therefore take
    /// the conversation back with the code.
    #[must_use]
    pub fn anchored(&self) -> Option<&str> {
        self.entry_id.as_deref().filter(|id| !id.is_empty())
    }
}

/// One side of a diff: a checkpoint, the live working tree, or the empty tree.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointEndpoint {
    /// `checkpoint`, `worktree` or `empty`.
    pub kind: String,
    /// Checkpoint id, for `checkpoint`.
    #[serde(default)]
    pub id: Option<String>,
    /// Human label.
    #[serde(default)]
    pub label: Option<String>,
    /// When it was taken.
    #[serde(default)]
    pub created_at: Option<String>,
}

impl CheckpointEndpoint {
    /// How the endpoint reads in a header row.
    #[must_use]
    pub fn describe(&self) -> String {
        match self.kind.as_str() {
            "worktree" => "the working tree".to_owned(),
            "empty" => "the start of this session".to_owned(),
            _ => self
                .label
                .clone()
                .filter(|label| !label.trim().is_empty())
                .or_else(|| self.id.clone())
                .unwrap_or_else(|| "a checkpoint".to_owned()),
        }
    }
}

/// One changed path, with its own patch when patches were asked for.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFileChange {
    /// The path.
    pub path: String,
    /// `added`, `modified`, `deleted`, `renamed`, `copied` or `type_changed`.
    pub status: String,
    /// Where a rename or copy came from.
    #[serde(default)]
    pub old_path: Option<String>,
    /// Lines added. Absent for a binary file rather than zero.
    #[serde(default)]
    pub additions: Option<u64>,
    /// Lines removed. Absent for a binary file rather than zero.
    #[serde(default)]
    pub deletions: Option<u64>,
    /// Whether the file is binary, and therefore carries no patch.
    #[serde(default)]
    pub binary: bool,
    /// A unified diff for this file alone.
    #[serde(default)]
    pub patch: Option<String>,
    /// The patch was cut at a byte budget; what is here is a prefix.
    #[serde(default)]
    pub patch_truncated: bool,
}

/// `checkpoint/list` result — and `/checkpoints`'s `checkpointsResult`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointListResult {
    /// Newest first.
    #[serde(default)]
    pub checkpoints: Vec<Checkpoint>,
    /// Whether this directory can host a checkpoint repository at all.
    #[serde(default)]
    pub available: bool,
    /// Why not, when it cannot. Rendering the reason is what stops an empty list
    /// from reading as "nothing has happened yet".
    #[serde(default)]
    pub unavailable: Option<String>,
}

/// `checkpoint/diff` result.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffResult {
    /// The `from` side.
    pub from: CheckpointEndpoint,
    /// The `to` side.
    pub to: CheckpointEndpoint,
    /// Changed paths, first by path when truncated.
    #[serde(default)]
    pub files: Vec<CheckpointFileChange>,
    /// More files changed than the requested limit carried.
    #[serde(default)]
    pub truncated: bool,
    /// Whether checkpoints work here at all.
    #[serde(default)]
    pub available: bool,
    /// Why not, when they do not.
    #[serde(default)]
    pub unavailable: Option<String>,
}

/// `checkpoint/restore` result — the never-clobber rule, reported.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRestoreResult {
    /// The checkpoint the tree was taken back to.
    pub target: Checkpoint,
    /// A checkpoint of the state that was just replaced. Restoring it undoes the
    /// restore, so a client offers it as the undo.
    pub safety: Checkpoint,
    /// Paths put back.
    #[serde(default)]
    pub restored: Vec<String>,
    /// Paths that changed since the target *without* being attributed to one of
    /// Lyra's own tool calls, and were therefore left exactly as they were.
    #[serde(default)]
    pub preserved: Vec<String>,
    /// Whether `force` reverted the preserved set too.
    #[serde(default)]
    pub forced: bool,
    /// Paths outside the snapshot, untouched either way.
    #[serde(default)]
    pub excluded: Vec<String>,
}

/// `checkpoint/restore` params.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreParams {
    /// Checkpoint id, or `"latest"`.
    pub checkpoint: String,
    /// Also revert files changed outside Lyra's own tool calls. Off by default,
    /// and only ever set from a confirmation the user answered.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub force: bool,
}

/// One spawned child, as `/agents`, `agent/list` and the snapshot report it.
///
/// The hydration counterpart of [`AgentUpdate`]: same child, more detail,
/// fetched once at attach so a client that joins mid-session renders its
/// presence strip immediately instead of waiting for the next transition.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHandle {
    /// The spawn id.
    pub id: String,
    /// The bus name it answers to.
    pub peer: String,
    /// The short name its parent gave it.
    #[serde(default)]
    pub label: Option<String>,
    /// Where it is in its life.
    pub status: AgentState,
    /// The model it runs on, when one was named.
    #[serde(default)]
    pub model: Option<String>,
    /// 0 for a child of the main session.
    #[serde(default)]
    pub depth: Option<u32>,
    /// The directory its tools operate in.
    #[serde(default)]
    pub workspace: Option<String>,
    /// How many tool calls it has made.
    #[serde(default)]
    pub tool_calls: Option<u32>,
    /// The paths its tools reported changing.
    #[serde(default)]
    pub files_modified: Vec<String>,
    /// Present on `failed` and `timed_out`.
    #[serde(default)]
    pub error: Option<String>,
    /// Fields this build does not model.
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

impl AgentHandle {
    /// The same fact an `agent` update carries, so hydration and streaming fold
    /// into one map rather than two.
    ///
    /// `filesModified` is a **list** here and a **count** on the update: the
    /// handle knows the paths and the transition only counts them, so the
    /// conversion is a length. Nothing invents a number it was not given.
    #[must_use]
    pub fn as_update(&self) -> AgentUpdate {
        AgentUpdate {
            id: self.id.clone(),
            peer: self.peer.clone(),
            label: self.label.clone(),
            status: self.status.clone(),
            // A handle is a *state*, not a transition: hydration says what a
            // child is, never what just happened to it. Inventing a transition
            // here would put a lifecycle row in scrollback for something that
            // happened before this client was attached to see it.
            event: None,
            model: self.model.clone(),
            depth: self.depth,
            workspace: self.workspace.clone(),
            tool_calls: self.tool_calls,
            files_modified: u32::try_from(self.files_modified.len()).ok(),
            error: self.error.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Provider setup
// ---------------------------------------------------------------------------

/// A credential in flight.
///
/// The wrapper exists for exactly one reason: **`Debug`**. [`crate::app::Call`],
/// [`crate::app::Reply`] and [`crate::app::App`] all derive it, a panic message
/// prints it, and a future log line would too — so a bare `String` here is one
/// `{:?}` away from a key in a transcript. This type's `Debug` prints
/// `Secret(<redacted>)`, it has no `Display` at all, and the only way to the
/// bytes is [`Secret::expose`], which every call site has to name out loud.
///
/// It serializes transparently, because the one place the plaintext belongs is
/// the JSON-RPC params of `provider/verify` and `provider/add` — stdio, one
/// trust domain, no network hop (schema: *"SECRET TRANSPORT"*).
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    /// Take ownership of a credential.
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The plaintext. Named loudly on purpose.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Whether there is no credential here.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// One row of the setup wizard's catalog.
///
/// Everything past `id`/`label`/`custom`/`needs_key` is a **pre-fill** for the
/// same form a custom entry uses, so a client renders one form either way
/// instead of two. `auth_env_var` is a variable *name*; nothing in this catalog
/// ever carries a credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreset {
    /// Catalog row id, unique within the answer.
    pub id: String,
    /// What the picker shows.
    pub label: String,
    /// Right-hand column.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Suggested provider id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Suggested endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Suggested protocol.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_type: Option<ConfigurableApiType>,
    /// Suggested default model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Suggested `fast` role model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_model: Option<String>,
    /// Suggested `merge` role model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_model: Option<String>,
    /// Suggested websocket policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub websocket: Option<WebsocketMode>,
    /// The variable this provider is conventionally read from. A **name**.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_env_var: Option<String>,
    /// Whether this provider needs a credential at all.
    pub needs_key: bool,
    /// Whether `auth_env_var` is already exported in the daemon's process. Says
    /// only that the variable is non-empty, never what is in it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_var_set: Option<bool>,
    /// Whether a provider by this id already exists, so setup would replace it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configured: Option<bool>,
    /// Whether this row pre-fills nothing and expects the user to type it all.
    pub custom: bool,
}

/// One persistence choice, resolved against this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPersistOption {
    /// Which choice.
    pub id: ProviderPersist,
    /// What the picker shows.
    pub label: String,
    /// Why it is recommended, or why it is unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// `false` when this machine cannot offer it. Rendered **disabled with its
    /// detail** rather than hidden, so the absence is explained.
    pub available: bool,
}

/// One protocol a provider may be configured to speak.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderApiTypeOption {
    /// Which protocol.
    pub id: ConfigurableApiType,
    /// What the picker shows.
    pub label: String,
    /// One line of prose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// `provider/setup_options` result — everything the wizard's first screen needs
/// without inventing any of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSetupOptions {
    /// The catalog, at least one row.
    pub presets: Vec<ProviderPreset>,
    /// The persistence choices, at least one.
    pub persist: Vec<ProviderPersistOption>,
    /// The protocols, at least one.
    pub api_types: Vec<ProviderApiTypeOption>,
    /// The file the answer will be written to.
    pub path: String,
    /// Providers that already exist.
    #[serde(default)]
    pub configured: Vec<String>,
}

impl ProviderSetupOptions {
    /// A persistence choice by id.
    #[must_use]
    pub fn persist_option(&self, id: &ProviderPersist) -> Option<&ProviderPersistOption> {
        self.persist.iter().find(|option| option.id == *id)
    }
}

/// `provider/verify` params.
///
/// **SECRET TRANSPORT.** `api_key` is a credential in flight. It crosses this
/// pipe because the pipe is stdio between a client and the daemon it was
/// spawned by, and it goes no further: never persisted by this method, never
/// logged, never echoed in the result, never carried by a `session/update`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyProviderParams {
    /// The id this provider will be saved under, when one has been chosen.
    /// Used only to shape the request the way that provider expects.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// The endpoint to probe.
    pub base_url: String,
    /// The protocol to probe it with.
    pub api_type: ConfigurableApiType,
    /// The credential to authenticate the probe with.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<Secret>,
    /// The name of a variable to read the credential from instead. A name,
    /// never a value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_env_var: Option<String>,
    /// Deadline for the probe. The daemon clamps it to 250…30000.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
}

/// `provider/verify` result.
///
/// An unreachable provider answers `ok: false` **with the classification**
/// rather than failing the request: the wizard's next move is a typo fix or a
/// save-anyway, and a JSON-RPC error would make "unreachable" indistinguishable
/// from "the daemon is broken".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyProviderResult {
    /// Whether the endpoint answered.
    pub ok: bool,
    /// How many models it listed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<u64>,
    /// A few model ids, so the wizard can show it reached the *right* provider
    /// and not merely *a* server.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sample: Vec<String>,
    /// Why it did not answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ProviderError>,
}

/// `provider/detect` params.
///
/// **SECRET TRANSPORT**, under exactly the terms [`VerifyProviderParams`]
/// states. The credential is optional because the question — *what does this
/// endpoint speak?* — is usually answerable without one, and a local runtime
/// answers it with no credential in existence yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectProviderParams {
    /// The endpoint to interrogate.
    pub base_url: String,
    /// A credential to interrogate it with, when one has been typed already.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<Secret>,
}

/// `provider/detect` result.
///
/// Every field is optional-shaped on purpose: detection is a *convenience*, and
/// a daemon that learns nothing answers with an empty list rather than failing.
/// The wizard treats that exactly as it treats a transport failure — the
/// protocol field stays empty and the user picks (see [`crate::app::setup`]).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectProviderResult {
    /// Every protocol this endpoint answered to, most-preferred first. Two or
    /// more is the dual-type case: one saved provider per protocol.
    #[serde(default)]
    pub api_types: Vec<ConfigurableApiType>,
    /// What to call it, derived from the host. A suggestion, always editable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_name: Option<String>,
    /// Whether the endpoint refused an unauthenticated request. `Some(false)` is
    /// what makes "no key — local/unauthenticated" the opening credential
    /// choice for a local runtime.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_required: Option<bool>,
    /// The endpoint in the shape the daemon will persist it in — a trailing
    /// slash dropped, a missing `/v1` supplied, a scheme normalised.
    ///
    /// Adopted into the endpoint field when present, rather than applied
    /// invisibly at save time: the URL a provider is saved under is the one the
    /// user will read back out of `~/.lyra/providers.toml`, so the form shows
    /// the normalisation instead of hiding it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normalized_base_url: Option<String>,
}

/// `model/add` params — declare a model the provider does not list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddModelParams {
    /// The provider it belongs to.
    pub provider: String,
    /// The model id, verbatim as the provider expects it.
    pub model: String,
}

/// `model/add` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddModelResult {
    /// Whether it was written.
    pub ok: bool,
    /// The provider it was written against.
    pub provider: String,
    /// The model that now exists.
    pub model: String,
}

/// `provider/add` params.
///
/// A request naming a provider that already exists is an **update**: the same
/// method saves and edits, which is why the edit form is the add form.
///
/// **SECRET TRANSPORT**, under exactly the terms [`VerifyProviderParams`]
/// states. Where the credential comes to rest is `persist`'s decision, and the
/// pairing rules are the daemon's *and* this client's: `keychain`/`plaintext`
/// require `api_key`; `env` requires `auth_env_var` and **must not** carry an
/// `api_key`; `none` carries neither; [`ProviderPersist::Keep`] carries neither
/// and requires the provider to exist already.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddProviderParams {
    /// Lowercase id: letters, digits and hyphens. The left half of every
    /// `provider/model` reference.
    pub provider: String,
    /// The endpoint.
    pub base_url: String,
    /// The protocol.
    pub api_type: ConfigurableApiType,
    /// The default model, when the client has one to name.
    ///
    /// **Optional since the wizard stopped asking.** Discovery is the daemon's
    /// job now (`provider/add` answers with `modelsDiscovered`), so the client
    /// omits this rather than making a user type a model id before they have
    /// seen the list. A caller that *does* know one — a future import path —
    /// still sends it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The `fast` role's model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fast_model: Option<String>,
    /// The `merge` role's model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_model: Option<String>,
    /// The websocket policy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub websocket: Option<WebsocketMode>,
    /// Where the credential comes to rest.
    pub persist: ProviderPersist,
    /// The credential. Required by `keychain`/`plaintext`, rejected by
    /// `env`/`none`, which have nowhere to put it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<Secret>,
    /// The variable name, for `persist: env`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_env_var: Option<String>,
}

/// `provider/add` result — what was written, never what it was written with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddProviderResult {
    /// Always `true`; the schema declares it `const`.
    pub ok: bool,
    /// The provider that now exists.
    pub provider: String,
    /// Its default model, when the daemon settled on one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// How many models the daemon listed while saving.
    ///
    /// **Absent means discovery was unavailable or failed** — not zero. That
    /// distinction is the whole line the wizard commits: a provider with a model
    /// list is `/model` away from usable, and one without needs `/model add`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models_discovered: Option<u64>,
    /// The auth **source** now backing it. Never the credential.
    pub auth: ProviderAuthSource,
    /// The file it was written to.
    pub path: String,
    /// What the user should know about the choice they made — a token now
    /// sitting in a file, a variable that is not exported here.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// `provider/get` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetProviderParams {
    /// Which provider to describe.
    pub provider: String,
}

/// `provider/get` result — one configured provider, as configured.
///
/// **There is no field here a credential could be in.** `auth_type` names the
/// *source* and `auth_detail` names the *place* (a keychain account, a variable
/// name), and that is the whole of what this result knows about authentication.
/// It is what makes pre-filling the edit form safe: the form can show where the
/// credential lives without ever having held it, and its key field stays empty,
/// which is exactly what [`ProviderPersist::Keep`] means on the way back out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    /// The id it is configured under.
    pub provider: String,
    /// Its endpoint.
    pub base_url: String,
    /// The protocol it speaks.
    pub api_type: ConfigurableApiType,
    /// Its websocket policy, when it declares one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub websocket: Option<WebsocketMode>,
    /// Where its credential comes from.
    pub auth_type: ProviderAuthSource,
    /// Where that source keeps it — a keychain account, a variable name. Never
    /// the credential.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_detail: Option<String>,
    /// The models it offers.
    #[serde(default)]
    pub models: Vec<String>,
    /// Whether the live session is on it — and therefore whether
    /// `provider/remove` will refuse until something else is selected.
    #[serde(default)]
    pub in_use: bool,
}

impl ProviderInfo {
    /// `keychain · dev.lyra.provider.openai`, or just `keychain` when the source
    /// does not name a place. The one line the edit form and the delete
    /// confirmation both show for "where the credential is".
    #[must_use]
    pub fn auth_summary(&self) -> String {
        match &self.auth_detail {
            Some(detail) if !detail.is_empty() => format!("{} · {detail}", self.auth_type),
            _ => self.auth_type.to_string(),
        }
    }

    /// Whether a removal has a credential it could be asked to delete.
    ///
    /// **Keychain only**, which is narrower than "has a credential" on purpose
    /// and is the schema's own rule: `removeCredential` deletes an OS-keychain
    /// entry and is ignored for every other source, because there is nothing
    /// Lyra owns to delete. An environment variable is the user's; a `static`
    /// token *is* the declaration and goes when the declaration does; a plugin
    /// is a helper nothing here installed. Offering a checkbox for any of them
    /// would be offering a choice that does nothing.
    #[must_use]
    pub const fn removable_credential(&self) -> bool {
        matches!(self.auth_type, ProviderAuthSource::Keychain)
    }

    /// Whether deleting the provider also destroys its credential, with no
    /// choice in the matter: a token written into `providers.toml` lives *in*
    /// the declaration being removed.
    #[must_use]
    pub const fn credential_goes_with_it(&self) -> bool {
        matches!(self.auth_type, ProviderAuthSource::Static)
    }
}

/// `provider/remove` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveProviderParams {
    /// Which provider to forget.
    pub provider: String,
    /// Whether to take the stored credential with it. Omitted — rather than
    /// sent `false` — when there is no stored credential to have an opinion
    /// about.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remove_credential: Option<bool>,
}

/// `provider/remove` result — what was forgotten, and what still names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveProviderResult {
    /// Whether it was removed.
    pub ok: bool,
    /// The provider that is now gone.
    pub provider: String,
    /// The file it was removed from.
    pub path: String,
    /// Whether the credential went with it. **Absent means the question did not
    /// arise** — there was nothing stored — which is distinct from `false`,
    /// "there was, and it was kept".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_removed: Option<bool>,
    /// Roles (`default`, `fast`, `merge`) that still point at the removed
    /// provider. Reported rather than repointed: which model a role should name
    /// instead is a decision, and `/model` is where decisions about models are
    /// made.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dangling_roles: Vec<String>,
}

/// Params of the daemon→client `session/request_permission`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionParams {
    /// Which session is asking.
    pub session_id: String,
    /// What is being asked about. Open by contract: the schema names no kinds,
    /// so a client renders the title, detail, and options it is sent and only
    /// dispatches on a kind it recognises.
    pub kind: String,
    /// One-line question.
    pub title: String,
    /// Longer explanation.
    #[serde(default)]
    pub detail: Option<String>,
    /// The choices, at least one.
    pub options: Vec<PermissionOption>,
}

/// One answer the user may give to a permission request.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    /// Identifier to send back.
    pub option_id: String,
    /// Button text.
    pub label: String,
    /// What choosing it means.
    pub kind: PermissionKind,
}

/// Result of `session/request_permission`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResult {
    /// The chosen option.
    pub option_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Inbound {
        serde_json::from_str::<RawMessage>(line)
            .unwrap()
            .classify()
            .unwrap()
    }

    fn update(json: &str) -> Update {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn classifies_a_response() {
        let message = parse(r#"{"jsonrpc":"2.0","id":3,"result":{"cancelled":true}}"#);
        let Inbound::Response { id, outcome } = message else {
            panic!("expected a response");
        };
        assert_eq!(id, Id::Number(3));
        assert!(outcome.is_ok());
    }

    #[test]
    fn classifies_a_null_result_response() {
        // `daemon.ts` writes `result: result ?? null` for void handlers.
        let message = parse(r#"{"jsonrpc":"2.0","id":1,"result":null}"#);
        let Inbound::Response { outcome, .. } = message else {
            panic!("expected a response");
        };
        assert_eq!(*outcome, Ok(Value::Null));
    }

    #[test]
    fn classifies_a_server_request() {
        let message =
            parse(r#"{"jsonrpc":"2.0","id":"server-1","method":"session/request_permission"}"#);
        let Inbound::Request { id, method, .. } = message else {
            panic!("expected a request");
        };
        assert_eq!(id, Id::Text("server-1".to_owned()));
        assert_eq!(method, method::SESSION_REQUEST_PERMISSION);
    }

    #[test]
    fn classifies_a_notification() {
        let message = parse(r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#);
        assert!(matches!(message, Inbound::Notification { .. }));
    }

    #[test]
    fn reads_the_canonical_envelope() {
        let frame: UpdateNotification = serde_json::from_str(
            r#"{"sessionId":"s-1","update":{"sessionUpdate":"delta","messageId":"m",
                "partId":"p","field":"text","delta":"hi"}}"#,
        )
        .unwrap();
        assert_eq!(frame.session_id, "s-1");
        let Update::Delta(delta) = frame.update else {
            panic!("expected a delta");
        };
        assert_eq!((delta.field, delta.delta.as_str()), (DeltaField::Text, "hi"));
    }

    #[test]
    fn an_unknown_variant_is_kept_whole_rather_than_dropped() {
        let value = update(r#"{"sessionUpdate":"telemetry","frames":12,"note":"new"}"#);
        let Update::Unknown(ref unknown) = value else {
            panic!("expected unknown");
        };
        assert_eq!(unknown.tag, "telemetry");
        assert_eq!(unknown.fields.get("frames"), Some(&Value::from(12)));
        assert!(unknown.error.is_none());
        // And it round-trips, so a client can still print it as an audit row.
        assert_eq!(
            value.to_json(),
            serde_json::json!({"sessionUpdate":"telemetry","frames":12,"note":"new"})
        );
    }

    #[test]
    fn an_unknown_field_on_a_known_variant_is_ignored_not_fatal() {
        let value = update(
            r#"{"sessionUpdate":"part_end","messageId":"m","partId":"p","colour":"red"}"#,
        );
        assert!(matches!(value, Update::PartEnd(_)));
    }

    #[test]
    fn an_unknown_enum_value_survives_instead_of_failing_the_frame() {
        let value = update(
            r#"{"sessionUpdate":"retry","attempt":1,"maxAttempts":2,
                "classification":"solar_flare","providerMessage":"m","delayMs":0,
                "retryAtMs":1,"resetsPartialOutput":false}"#,
        );
        let Update::Retry(ref retry) = value else {
            panic!("expected retry");
        };
        assert_eq!(retry.classification.as_str(), "solar_flare");
        assert!(retry.classification.is_unknown());
        // Preserved verbatim on the way back out.
        assert_eq!(value.to_json()["classification"], Value::from("solar_flare"));
    }

    #[test]
    fn a_malformed_known_variant_degrades_instead_of_crashing() {
        let value = update(r#"{"sessionUpdate":"compaction","boundaryId":"b","tokensBefore":"lots"}"#);
        let Update::Unknown(unknown) = value else {
            panic!("expected unknown");
        };
        assert_eq!(unknown.tag, "compaction");
        assert!(unknown.error.is_some(), "the decoder complaint is kept");
    }

    #[test]
    fn a_null_first_kept_entry_is_meaningful_and_is_always_serialized() {
        let value = update(
            r#"{"sessionUpdate":"compaction","boundaryId":"b","tokensBefore":10,
                "tokensAfter":4,"firstKeptEntry":null}"#,
        );
        let Update::Compaction(ref compaction) = value else {
            panic!("expected compaction");
        };
        assert!(compaction.first_kept_entry.is_none());
        assert_eq!(compaction.tokens_reclaimed(), 6);
        assert_eq!(value.to_json()["firstKeptEntry"], Value::Null);
    }

    #[test]
    fn an_absent_context_window_yields_no_percentage() {
        let Update::Context(measured) = update(
            r#"{"sessionUpdate":"context","tokenEstimate":5000,"sourceEntryCount":9}"#,
        ) else {
            panic!("expected context");
        };
        assert_eq!(measured.fraction_used(), None);
        let Update::Context(measured) = update(
            r#"{"sessionUpdate":"context","tokenEstimate":5000,"sourceEntryCount":9,
                "contextWindow":10000}"#,
        ) else {
            panic!("expected context");
        };
        assert!((measured.fraction_used().unwrap() - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn outbound_notifications_carry_no_id_field() {
        let frame = serde_json::to_string(&Outbound::notification(
            method::CANCEL_REQUEST,
            Some(serde_json::json!({"id": 1})),
        ))
        .unwrap();
        assert!(!frame.contains("\"id\":1,"), "{frame}");
        assert!(frame.starts_with(r#"{"jsonrpc":"2.0","method""#), "{frame}");
    }

    #[test]
    fn cancel_params_omit_the_rewind_assertion_unless_it_was_made() {
        let bare = serde_json::to_string(&CancelParams::default()).unwrap();
        assert_eq!(bare, "{}");
        let rewound = serde_json::to_string(&CancelParams {
            rewound_to_composer: Some(true),
        })
        .unwrap();
        assert_eq!(rewound, r#"{"rewoundToComposer":true}"#);
    }
}
