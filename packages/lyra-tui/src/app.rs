//! The application: everything phases 2–5 built, wired to a live daemon.
//!
//! Build phase 6. This module replaces the passive viewer `run_acp` used to be —
//! a loop that blocked on the ACP event channel and drained keystrokes into a
//! discarded `Vec` — with the real thing: a composer that echoes, an `Enter`
//! that becomes `session/prompt`, a queue that becomes `session/steer`, and an
//! `Esc` ladder that becomes `session/cancel`.
//!
//! # The one ordering rule
//!
//! [`tick`] does input **first**, in full, before it looks at the daemon at all.
//! That is not a preference: DESIGN.md §1's whole argument for a client that
//! owns its own state is local-echo latency, and a client that waits on a
//! daemon event before reading the keyboard has given that away. The event
//! drain is additionally bounded ([`MAX_EVENTS_PER_TICK`]) so one very loud
//! turn cannot starve the *next* tick's input either.
//!
//! # The seam with the transport
//!
//! [`Daemon`] is the only thing this module knows about ACP. It is
//! fire-and-forget — nothing here may block a frame on a round trip — with
//! answers collected later through [`Daemon::poll`]. `main.rs` implements it
//! over [`crate::acp::AcpClient`]; the tests implement it with a `Vec`, which
//! is what makes the whole loop testable without a daemon, a terminal or a
//! thread.
//!
//! # The interactive surfaces
//!
//! Everything a user reaches without typing prose lives here, and all of it is
//! one of two widgets from [`crate::ui::overlay`]:
//!
//! - **`Ctrl+P` palette** — the keybinding registry's own descriptions merged
//!   with the daemon's `session/commands`, so one declaration is reachable by
//!   key, by palette and by `/name` (DESIGN.md §4's "no drift").
//! - **`?` cheatsheet** — generated from the keymap, never hand-written.
//! - **Pickers** — `/model`, `/provider`, `/sessions`, `/theme` and `/rewind`
//!   open a select
//!   overlay instead of going to the daemon's router, because a list you can
//!   arrow through beats a list you have to retype an argument from. `/model` is
//!   the **switching** surface and spans every configured provider: its rows are
//!   `provider/model` references, so one list changes both halves.
//! - **The provider menu** — a provider row in `/provider` is three things you
//!   might mean, so it opens a menu of them: switch, edit, delete. The switch is
//!   first and is the identical `session/select_provider` accepting the row used
//!   to send, so `Enter Enter` is what one `Enter` was. Edit reopens the setup
//!   form over `provider/get`, and delete is a confirmation over
//!   `provider/remove`. `/provider edit|delete [<name>]` reaches the same two
//!   without the menu.
//! - **Completion popups** — `/` at offset 0 filters the command registry
//!   locally; `@` debounces a `session/complete` round trip and renders the
//!   answer **in the order the daemon gave it**.
//! - **The provider form** — one endpoint-first form over
//!   `provider/setup_options`, `provider/detect`, `provider/verify` and
//!   `provider/add`. It is the one surface that runs before there is a provider
//!   at all, and it opens itself when the snapshot says so. Adding never
//!   switches. See the `setup` submodule.
//! - **`/model add`** — the same form machinery, two fields, for an endpoint
//!   that cannot list its own models.
//! - **The rewind surface** — the `Esc Esc` rung, `/rewind`'s checkpoint picker,
//!   and the confirmation both of them open. Rewinding *what was said* and
//!   reverting *what was written* are two calls (`session/rewind` and
//!   `checkpoint/restore`) because they are two decisions, and the confirmation
//!   asks which. The never-clobber rule is the reason the flow has two steps:
//!   a restore reports the files it declined to touch, and only *then* does a
//!   `--force` row exist — this client never offers to override a rule that has
//!   not yet said no. [`EscWorld::can_rewind`] is answered from a cached
//!   `checkpoint/list` (refreshed at attach and at every turn end) so the `Esc`
//!   hint never waits on a round trip and never lies for one.
//!
//! # What is deliberately still stubbed
//!
//! - **`!` bash mode.** The composer's mode is real — the border flips and the
//!   band echoes `! cmd` — but the protocol has no exec surface, so the command
//!   goes out as an ordinary `session/prompt` and the agent's own `bash` tool
//!   runs it. A daemon-side `session/exec` is what would make it a one-shot.
//! - **Completion kinds other than files.** `session/complete` is asked only for
//!   `kind: "file"`, because `@` is the only trigger DESIGN.md §4 declares.

use std::time::{Duration, Instant, SystemTime};

use crossbeam_channel::Receiver;
use serde_json::Value;

use crate::acp::types::{self as wire, DeltaField, Update};
use crate::acp::AcpEvent;
use crate::engine::resize::ReplaySource;
use crate::input::actor::InputEvent;
use crate::input::completion::{CommandSource, CompletionItem, CompletionKind};
use crate::input::composer::{ComposerMode, ComposerOutcome, Submission};
use crate::input::esc::ARM_WINDOW;
use crate::input::{Composer, EscLadder, EscStep, EscWorld, KeyEvent, QueueEffect, QueueMachine};
use crate::keybind::{Action, Context, ContextStack, Keymap, Layer};
use crate::state::SessionStore;
use crate::theme::Theme;
use crate::ui::footer::{FooterData, RetryStatus};
use crate::ui::overlay::{Body, Choice, Panel, Ranking, Select};
use crate::ui::reliability::Activity;
use crate::ui::tool_row::ToolView;
use crate::ui::transcript::Transcript;
use crate::ui::{self, Row, Span};

/// How many ACP events one tick may absorb before it renders and reads the
/// keyboard again.
///
/// Coalescing (DESIGN.md §2) wants a burst drained into one frame; responsiveness
/// wants a ceiling on it. A saturated channel therefore costs several frames of
/// catching up rather than an unbounded stall with a dead keyboard.
pub const MAX_EVENTS_PER_TICK: usize = 512;

/// The smallest live region the chrome fits in: activity, composer (three rows),
/// hints, footer.
pub const MIN_REGION_HEIGHT: u16 = 6;

/// How many composer rows are visible before it scrolls to follow the caret.
const COMPOSER_ROWS: usize = 4;

/// How long a transient notice stays up (DESIGN.md §3: ≥700ms).
const NOTICE_LINGER: Duration = Duration::from_millis(1400);

/// The placeholder, which is also the only tutorial this TUI has.
const PLACEHOLDER: &str = "ask anything · ! for bash · / for commands · @ to mention a file";

/// How long `@` typing settles before a `session/complete` goes out.
///
/// Short enough to feel immediate, long enough that typing a path costs one
/// round trip rather than one per keystroke. The request is fire-and-forget
/// either way, so nothing here can block a frame — the debounce is about the
/// daemon's work, not this process's.
const COMPLETION_DEBOUNCE: Duration = Duration::from_millis(80);

/// Candidates asked of `session/complete`. More than fits the popup, so the
/// ranking has something to rank, and few enough that a large repository does
/// not serialise a directory listing per keystroke.
const COMPLETION_LIMIT: u32 = 40;

/// Rows the completion popup shows before it scrolls.
const POPUP_ROWS: usize = 6;

/// Content rows an overlay may claim.
const OVERLAY_ROWS: usize = 12;

/// How many checkpoints one `checkpoint/list` asks for.
///
/// The daemon caps the method at 500 and the parameter bounds the *scan* as well
/// as the answer, so this is a real cost and not just a display limit. A hundred
/// is several turns' worth of pre-tool checkpoints — far more than a picker can
/// show — and the picker's own filter is what finds one further back. A session
/// with thousands of them therefore costs a bounded listing, never an unbounded
/// one, and `/checkpoints` is the surface for the full history.
const CHECKPOINT_PAGE: u32 = 100;

/// How many preserved paths a restore names before it counts the rest.
///
/// Named, not counted, is the point: "3 files were left alone" is not
/// actionable and `src/auth.ts, README.md, build/out.js` is. The cap exists
/// because a `--force` over two hundred paths still has to fit on a screen.
const PRESERVED_NAMED: usize = 8;

/// Live-region rows the chrome always costs: activity, composer (three), hints,
/// footer. What an overlay asks for is this plus its own height.
const CHROME_ROWS: u16 = 6;

/// The ceiling DESIGN.md §1 puts on the live region: "bounded height (~last 24
/// rows)". An overlay may grow the region; it may not take the screen.
pub const MAX_REGION_HEIGHT: u16 = 24;

// ---------------------------------------------------------------------------
// The transport seam
// ---------------------------------------------------------------------------

/// One request the app makes of the daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Call {
    /// `session/prompt` — start a turn.
    Prompt(String),
    /// `session/steer` — inject into the running turn at the next tool boundary.
    Steer(String),
    /// `session/cancel`. The flag is DESIGN.md §0.2's assertion that the prompt
    /// really went back into the composer, and is the only thing that lets the
    /// daemon trim a zero-output turn.
    Cancel {
        /// Whether the client rewound the prompt into its composer.
        rewound_to_composer: bool,
    },
    /// `session/command` — a slash command, leading slash included, because that
    /// is what the daemon's router parses.
    Command(String),
    /// `session/commands` — the command registry. Fetched once per session.
    Commands,
    /// `session/complete` — candidates for a completion trigger.
    ///
    /// The answer is **server-ranked**; nothing on this side re-sorts it.
    Complete {
        /// The session the query is about, when this client knows it. Absent
        /// means "the session you have open", which is the only one there is.
        session_id: Option<String>,
        /// What is being completed. `file` is the only kind `@` produces.
        kind: &'static str,
        /// The text between the trigger and the caret.
        query: String,
        /// How many candidates are wanted.
        limit: u32,
    },
    /// `session/models` — for the model picker.
    ///
    /// The answer spans **every configured provider**, so this is the switching
    /// surface for both halves of a `provider/model` reference.
    Models,
    /// `session/select_model`, with a `provider/model` reference when the daemon
    /// gave one (a bare model id from a daemon that predates the reshape).
    SelectModel(String),
    /// `model/add` — declare a model against a provider that lists none.
    ModelAdd {
        /// Provider id.
        provider: String,
        /// Model id, verbatim.
        model: String,
    },
    /// `session/providers` — for the provider picker.
    Providers,
    /// `session/select_provider`. The model is the provider's default when
    /// absent; the setup wizard names one, because it has just been told which.
    SelectProvider {
        /// Provider id.
        provider: String,
        /// Model to select with it.
        model: Option<String>,
    },
    /// `provider/setup_options` — the setup form's catalog.
    ProviderSetupOptions,
    /// `provider/detect` — what does this endpoint speak? Boxed, and
    /// secret-carrying.
    ProviderDetect(Box<wire::DetectProviderParams>),
    /// `provider/verify` — one liveness check against an unsaved endpoint.
    ///
    /// Boxed because the params are much larger than every other variant, and
    /// **secret-carrying**: see [`wire::Secret`].
    ProviderVerify(Box<wire::VerifyProviderParams>),
    /// `provider/add` — persist a provider, or **update** one that exists.
    /// Boxed, and secret-carrying.
    ProviderAdd(Box<wire::AddProviderParams>),
    /// `provider/get` — what one configured provider is. Carries no secret in
    /// either direction.
    ///
    /// `purpose` never reaches the wire (the params are `{provider}` and nothing
    /// else): it is how the answer finds the surface that asked, so a menu and
    /// an edit form asking about the same provider cannot adopt each other's
    /// reply.
    ProviderGet {
        /// Provider id.
        provider: String,
        /// Which surface asked.
        purpose: Purpose,
    },
    /// `provider/remove` — forget a provider, and optionally its credential.
    ProviderRemove(Box<wire::RemoveProviderParams>),
    /// `session/list` — for the session picker.
    Sessions,
    /// `session/load` — switch to a session by name.
    LoadSession(String),
    /// `session/snapshot` — re-hydrate after the transcript underneath changed.
    ///
    /// `session/load` answers with a descriptor and nothing else, so the
    /// conversation a resume is *for* arrives here. See [`App::adopt_snapshot`].
    Snapshot,
    /// `checkpoint/list` — what the rewind surface is built from.
    ///
    /// Asked once at attach and again at every turn end, which is the cadence
    /// that keeps [`EscWorld::can_rewind`] honest: the `Esc Esc` rung and its
    /// hint must answer without a round trip, so the answer has to already be
    /// here. `why` is how the reply finds the surface that asked — a background
    /// refresh must not open a picker under the user.
    Checkpoints {
        /// How many to ask for, newest first.
        limit: u32,
        /// What the answer is for.
        why: Rewind,
    },
    /// `checkpoint/restore` — take the working directory back. **Writes.**
    ///
    /// `force` is only ever `true` when a confirmation the user answered said
    /// so, and that confirmation only ever appears once a restore has *reported*
    /// preserved files: nothing here asks about files that may not exist.
    Restore {
        /// Checkpoint id.
        checkpoint: String,
        /// Also revert what changed outside Lyra's own tool calls.
        force: bool,
    },
    /// `session/rewind` — move the head back to a transcript entry.
    Rewind {
        /// Where to land. Absent asks the daemon for the newest anchored entry.
        entry_id: Option<String>,
    },
}

/// Why a `checkpoint/list` went out.
///
/// Three surfaces want the same answer and two of them are modal, so the reply
/// has to name the one that asked — the same argument [`Purpose`] makes for
/// `provider/get`. A background refresh that opened a picker would be a panel
/// appearing under a user who did nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rewind {
    /// Keeping [`EscWorld::can_rewind`] answerable. Renders nothing.
    Refresh,
    /// `/rewind` — open the picker when it lands.
    Picker,
    /// `Esc Esc` — open the confirmation for the newest anchored checkpoint.
    Confirm,
}

/// Which surface a `provider/get` was asked for.
///
/// Three surfaces want the same answer about a provider — the action menu
/// (which shows it), the edit form (which is filled from it) and the delete
/// confirmation (which says what will be lost) — and each is opened
/// independently, so the reply has to name the one that asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// The per-provider action menu.
    Menu,
    /// The edit form's pre-fill.
    Edit,
    /// The delete confirmation.
    Delete,
}

impl Call {
    /// The ACP method this call becomes on the wire.
    #[must_use]
    pub const fn method(&self) -> &'static str {
        match self {
            Self::Prompt(_) => wire::method::SESSION_PROMPT,
            Self::Steer(_) => wire::method::SESSION_STEER,
            Self::Cancel { .. } => wire::method::SESSION_CANCEL,
            Self::Command(_) => wire::method::SESSION_COMMAND,
            Self::Commands => wire::method::SESSION_COMMANDS,
            Self::Complete { .. } => wire::method::SESSION_COMPLETE,
            Self::Models => wire::method::SESSION_MODELS,
            Self::SelectModel(_) => wire::method::SESSION_SELECT_MODEL,
            Self::ModelAdd { .. } => wire::method::MODEL_ADD,
            Self::Providers => wire::method::SESSION_PROVIDERS,
            Self::SelectProvider { .. } => wire::method::SESSION_SELECT_PROVIDER,
            Self::ProviderSetupOptions => wire::method::PROVIDER_SETUP_OPTIONS,
            Self::ProviderDetect(_) => wire::method::PROVIDER_DETECT,
            Self::ProviderVerify(_) => wire::method::PROVIDER_VERIFY,
            Self::ProviderAdd(_) => wire::method::PROVIDER_ADD,
            Self::ProviderGet { .. } => wire::method::PROVIDER_GET,
            Self::ProviderRemove(_) => wire::method::PROVIDER_REMOVE,
            Self::Sessions => wire::method::SESSION_LIST,
            Self::LoadSession(_) => wire::method::SESSION_LOAD,
            Self::Snapshot => wire::method::SESSION_SNAPSHOT,
            Self::Checkpoints { .. } => wire::method::CHECKPOINT_LIST,
            Self::Restore { .. } => wire::method::CHECKPOINT_RESTORE,
            Self::Rewind { .. } => wire::method::SESSION_REWIND,
        }
    }
}

/// A call the daemon has answered.
#[derive(Debug, Clone)]
pub struct Reply {
    /// What was asked.
    pub call: Call,
    /// The daemon's answer, or why there is none.
    pub outcome: Result<Value, String>,
}

/// Where calls go.
///
/// Every method is fire-and-forget: a frame may never block on a round trip.
/// Answers come back through [`Daemon::poll`], which the loop drains once per
/// tick after the event burst.
pub trait Daemon {
    /// Send a call. Failures surface through [`Daemon::poll`], not here.
    fn send(&mut self, call: Call);

    /// Collect whatever has been answered since the last poll.
    fn poll(&mut self) -> Vec<Reply> {
        Vec::new()
    }
}

/// The slash commands to assume before `session/commands` answers.
///
/// Transcribed from `packages/lyra-app/src/commands.ts`'s `SLASH_COMMANDS`, and
/// **replaced** — not merged into — the moment the daemon declares its own. It
/// exists so `/` works on the first keystroke of a session and on a daemon that
/// never declares a registry at all. A stale copy costs a missing description
/// and an unhighlighted word: an unrecognised `/word` still submits, and the
/// daemon still answers with its own "unknown command" list.
pub const SLASH_COMMANDS: [&str; 24] = [
    "copy",
    "dump",
    "settings",
    "provider",
    "model",
    "loop",
    "context",
    "compact",
    "clear",
    "agents",
    "kill",
    "workspaces",
    "cleanup",
    "checkpoints",
    "review",
    "rollback",
    "apply",
    "skills",
    "mcp",
    "install",
    "fork",
    "resume",
    "sessions",
    "health",
];

/// Commands this **client** answers, which no daemon declares.
///
/// Two, and both are here for the same reason: they are properties of this
/// terminal rather than of the session. `/theme` is a colour choice, and
/// `/rewind` is the *picker* over `checkpoint/list` — the daemon has the three
/// checkpoint methods and no opinion about which of them a keystroke means, so
/// the surface that turns a list into a decision belongs on this side.
const CLIENT_COMMANDS: [(&str, &str); 2] = [
    ("theme", "Pick a colour theme, previewed as you move."),
    (
        "rewind",
        "Go back to a checkpoint: the conversation, and optionally the code with it.",
    ),
];

/// Commands whose bare form (no arguments) opens a picker here instead of going
/// to the daemon's router.
///
/// With arguments they still go to the daemon: `/model opus-5` is an
/// instruction, and only `/model` is a question. `/resume` is the exception in
/// both directions — bare it opens the *same* picker `/sessions` does, and with
/// an argument it is a `session/load` this client issues rather than a report it
/// asks the router for.
const PICKER_COMMANDS: [&str; 6] = ["model", "provider", "sessions", "theme", "resume", "rewind"];

/// One slash command, as `session/commands` declares it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    /// Name without its slash.
    pub name: String,
    /// One line of prose, for the popup and the palette.
    pub description: String,
    /// Argument syntax, when the command takes any.
    pub usage: Option<String>,
    /// Which renderer [`crate::ui::results`] should use for its answer.
    pub result_kind: Option<String>,
}

impl CommandSpec {
    /// A command known only by name — the pre-hydration fallback.
    fn bare(name: &str, description: &str) -> Self {
        Self {
            name: name.to_owned(),
            description: description.to_owned(),
            usage: None,
            result_kind: None,
        }
    }

    /// What the popup and the palette show to the right of the name.
    fn detail(&self) -> String {
        match (&self.usage, self.description.is_empty()) {
            (Some(usage), true) => usage.clone(),
            (Some(usage), false) => format!("{usage} · {}", self.description),
            (None, _) => self.description.clone(),
        }
    }
}

/// [`CommandSource`] over a hydrated registry.
struct Known<'a>(&'a [CommandSpec]);

impl CommandSource for Known<'_> {
    fn is_command(&self, name: &str) -> bool {
        self.0.iter().any(|spec| spec.name == name)
    }
}

/// What accepting a provider row of the provider picker means.
///
/// One list, three verbs. `/provider` opens it in [`Pick::Menu`], where a row
/// leads to the small per-provider menu; `/provider edit` and `/provider delete`
/// open the same list already committed to one verb, which is what makes the
/// bare argument forms useful rather than a second way to type a name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pick {
    /// Open the action menu for the chosen provider.
    Menu,
    /// Edit the chosen provider.
    Edit,
    /// Delete the chosen provider.
    Delete,
}

impl Pick {
    /// The panel title, which is also the only thing that says which mode the
    /// list is in.
    const fn title(self) -> &'static str {
        match self {
            Self::Menu => "provider",
            Self::Edit => "edit provider",
            Self::Delete => "delete provider",
        }
    }
}

/// A delete confirmation: what is about to go, and whether its credential goes
/// with it.
///
/// Outlives its panel by one round trip on purpose — the refusal the daemon
/// answers with when the session is *on* this provider is only actionable if
/// the client still remembers that it was.
#[derive(Debug, Clone)]
struct Confirm {
    /// The provider named in the panel.
    provider: String,
    /// What `provider/get` said about it, once it has answered.
    info: Option<wire::ProviderInfo>,
    /// The toggle's state. Off by default: deleting a credential cannot be
    /// undone by re-adding the provider.
    remove_credential: bool,
}

impl Confirm {
    fn new(provider: &str) -> Self {
        Self {
            provider: provider.to_owned(),
            info: None,
            remove_credential: false,
        }
    }

    /// Whether the toggle row exists at all. Unknown (no answer yet) reads as
    /// "no": a row that appears late is better than one that asks about a
    /// credential which turns out not to exist.
    fn toggleable(&self) -> bool {
        self.info
            .as_ref()
            .is_some_and(wire::ProviderInfo::removable_credential)
    }

    /// What goes on the wire. `None` where there is nothing stored: the daemon
    /// is not asked to have an opinion about a credential that does not exist.
    fn params(&self) -> wire::RemoveProviderParams {
        wire::RemoveProviderParams {
            provider: self.provider.clone(),
            remove_credential: self.toggleable().then_some(self.remove_credential),
        }
    }
}

/// The rewind confirmation's state, from the moment its panel opens until
/// `checkpoint/restore` has answered.
///
/// It outlives its panel by one round trip, for the same reason [`Confirm`]
/// does: the interesting half of a restore is the *refusal*, and "N files were
/// left alone" is only actionable if the client still remembers which
/// checkpoint that was about.
#[derive(Debug, Clone)]
struct RewindConfirm {
    /// The checkpoint the working directory would go back to.
    checkpoint: wire::Checkpoint,
    /// Files a first, non-forcing restore declined to touch because Lyra never
    /// wrote them. **Empty until a restore has actually reported some** — which
    /// is precisely why the `--force` row cannot appear before then: this client
    /// does not offer to override a rule that has not yet said no.
    preserved: Vec<String>,
    /// Whether the override row is ticked. Off by default; reverting a human's
    /// own edit is not something a default should do.
    force: bool,
}

impl RewindConfirm {
    fn new(checkpoint: wire::Checkpoint) -> Self {
        Self {
            checkpoint,
            preserved: Vec::new(),
            force: false,
        }
    }

    /// Whether the conversation can move with the code. A checkpoint that
    /// anchors no transcript entry can only take the files back.
    fn anchored(&self) -> Option<&str> {
        self.checkpoint.anchored()
    }
}

/// What accepting a row of an overlay means.
#[derive(Debug, Clone, PartialEq, Eq)]
enum OverlayKind {
    /// Actions and slash commands, merged.
    Palette,
    /// The generated cheatsheet. Nothing to accept.
    Cheatsheet,
    /// `session/select_model`.
    Model,
    /// The provider list, in one of its three modes.
    Provider(Pick),
    /// The per-provider action menu: switch, edit, delete.
    ProviderMenu(String),
    /// The delete confirmation. Its state is [`App::confirm`], because it has to
    /// survive the panel.
    ProviderDelete,
    /// The checkpoint picker: `/rewind`.
    RewindPick,
    /// The rewind confirmation. Its state is [`App::rewind`].
    RewindConfirm,
    /// `session/load`.
    Sessions,
    /// The theme registry, applied live. Dismissing puts `restore` back, which
    /// is what makes highlighting a theme a *preview* rather than a change.
    Theme {
        /// The theme in force when the picker opened.
        restore: Box<Theme>,
    },
    /// The provider form. See [`crate::app::setup`]. There is no step before
    /// it: the endpoint is the first question, and the answers to the rest come
    /// from `provider/detect`.
    ProviderForm,
    /// The `/model add` form: a provider choice and a model id.
    ModelForm,
}

impl OverlayKind {
    /// Whether this overlay's panel is a form, and therefore owns the editing
    /// keys rather than the composer behind it.
    const fn is_form(&self) -> bool {
        matches!(self, Self::ProviderForm | Self::ModelForm)
    }
}

/// An overlay, and what it is for.
///
/// Not `Clone`: a form holds editors, one of which holds a credential, and a
/// type that can be copied is a type whose copies have to be accounted for.
#[derive(Debug)]
struct Open {
    kind: OverlayKind,
    panel: Panel,
}

impl Open {
    /// The list, when this overlay has one.
    fn select_mut(&mut self) -> Option<&mut Select> {
        self.panel.as_select_mut()
    }

    /// Which keyboard layer this overlay claims.
    const fn layer(&self) -> Layer {
        match self.panel.body {
            Body::Select(_) => Layer::Select,
            Body::Rows(_) => Layer::Overlay,
            Body::Form(_) => Layer::Form,
        }
    }
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

/// The live region, ready for [`crate::engine::scrollback::Frame`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Live {
    /// Rows, top first.
    pub rows: Vec<Row>,
    /// Caret `(column, row)` within [`Live::rows`].
    pub cursor: (u16, u16),
}

/// Everything the TUI is, minus the terminal.
#[derive(Debug)]
pub struct App {
    theme: Theme,
    keymap: Keymap,
    composer: Composer,
    queue: QueueMachine,
    esc: EscLadder,
    store: SessionStore,
    transcript: Transcript,
    /// Rows the next frame will print into scrollback.
    commits: Vec<Row>,
    width: u16,
    /// The prompt of the turn in flight, kept so a cancel can rewind it.
    in_flight: Option<String>,
    /// Whether the turn in flight has produced assistant output. A turn that has
    /// said something is never rewound (DESIGN.md §0.2).
    turn_output: bool,
    /// When this app was constructed; the spinner's phase reference.
    started: Instant,
    /// When the running turn last proved itself alive — **any** `session/update`,
    /// not just a text delta. The stall colour keys off this, so it means "the
    /// wire has said nothing at all", not "the model is between tokens".
    /// `None` while a prompt is out and nothing has come back yet.
    last_activity: Option<Instant>,
    /// The tool the activity strip is naming, tracked from the lifecycle
    /// updates so the strip costs nothing to draw.
    running_tool: Option<String>,
    /// `Ctrl+C` armed at this instant; a second press within the window exits.
    exit_armed: Option<Instant>,
    /// A transient line above the composer.
    notice: Option<(String, Instant)>,
    /// The floated panel, when one is open. At most one: overlays do not stack,
    /// so "dismiss the topmost" and "dismiss" are the same operation.
    overlay: Option<Open>,
    /// The slash-command registry. Seeded from [`SLASH_COMMANDS`] so `/` works
    /// before — and without — `session/commands`.
    commands: Vec<CommandSpec>,
    /// Whether the registry has been asked for, so [`App::hydrate`] is idempotent.
    commands_asked: bool,
    /// A `@` query waiting out [`COMPLETION_DEBOUNCE`], and when it is due.
    mention_due: Option<(String, Instant)>,
    /// The `@` query the outstanding `session/complete` went out for.
    mention_sent: Option<String>,
    /// The provider-setup wizard's state, while it is running.
    setup: Option<setup::Wizard>,
    /// The delete confirmation's state, from the moment its panel opens until
    /// `provider/remove` has answered.
    confirm: Option<Confirm>,
    /// The rewind confirmation's state, likewise.
    rewind: Option<RewindConfirm>,
    /// The checkpoints this client knows about, newest first.
    ///
    /// Refreshed at attach and at every turn end, because [`EscWorld::can_rewind`]
    /// has to answer *without* a round trip — the `Esc` hint asks it every frame,
    /// and a hint that lied for one round trip is worse than no hint.
    checkpoints: Vec<wire::Checkpoint>,
    /// Terminal children and when they settled, so a `✓` lingers in the presence
    /// strip before the child leaves it.
    settled: Vec<(String, Instant)>,
    /// Whether the presence strip is on screen.
    ///
    /// **Grows on demand, shrinks only at a turn boundary.** A child appearing
    /// is information and gets its row immediately; a chrome row collapsing
    /// 0↔1 mid-stream is the jitter DESIGN.md §3 forbids, so the disappearance
    /// waits for the boundary.
    agents_shown: bool,
    /// Set by a snapshot that reported no provider, cleared once the wizard has
    /// been opened for it. See [`App::adopt_snapshot`].
    needs_provider: bool,
    /// `(sessionId, headId)` of the snapshot the transcript on screen was drawn
    /// from. The session id answers "is this conversation already up there?" —
    /// which is what gates the replay — and the head id answers "did it move?",
    /// which is what turns a same-session re-adoption into a rewind marker.
    rendered_history: Option<(String, String)>,
    exit: bool,
    closed: bool,
}

impl App {
    /// A fresh app at a given width.
    #[must_use]
    pub fn new(theme: Theme, keymap: Keymap, composer: Composer, width: u16) -> Self {
        let width = width.max(8);
        let mut composer = composer;
        composer.set_width(ui::composer::content_width(width));
        Self {
            transcript: Transcript::new(theme.clone(), width),
            theme,
            keymap,
            composer,
            queue: QueueMachine::new(),
            esc: EscLadder::new(),
            store: SessionStore::new(),
            commits: Vec::new(),
            width,
            in_flight: None,
            turn_output: false,
            started: Instant::now(),
            last_activity: None,
            running_tool: None,
            exit_armed: None,
            notice: None,
            overlay: None,
            commands: default_commands(),
            commands_asked: false,
            mention_due: None,
            mention_sent: None,
            setup: None,
            confirm: None,
            rewind: None,
            checkpoints: Vec::new(),
            settled: Vec::new(),
            agents_shown: false,
            needs_provider: false,
            rendered_history: None,
            exit: false,
            closed: false,
        }
    }

    /// Ask the daemon for the things the interactive surfaces need.
    ///
    /// Separate from [`App::new`] because it is the first thing that puts a
    /// frame on the wire, and `main.rs` runs it after the session is attached —
    /// a command list fetched before there is a session is a list for nothing.
    /// Idempotent, and a daemon that does not implement `session/commands`
    /// simply leaves [`SLASH_COMMANDS`] standing.
    pub fn hydrate(&mut self, daemon: &mut dyn Daemon) {
        if std::mem::replace(&mut self.commands_asked, true) {
            return;
        }
        daemon.send(Call::Commands);
        // What the rewind rung answers from. Asked here rather than lazily
        // because `can_rewind` is consulted every frame by the `Esc` hint.
        daemon.send(Call::Checkpoints {
            limit: CHECKPOINT_PAGE,
            why: Rewind::Refresh,
        });
        // First run. The daemon booted with nothing configured, so a composer
        // would only be a place to type something that will be refused: the
        // wizard opens instead, and the session proceeds normally once it
        // finishes (DESIGN.md build phase 6, "pickers/wizards as ACP flows").
        if self.needs_provider {
            self.needs_provider = false;
            self.open_provider_setup(daemon, true);
        }
    }

    /// Fold a `session/snapshot` in: the store's half, the one fact the store
    /// has no opinion about — whether there is a provider at all — and **the
    /// conversation**.
    ///
    /// The third is the point. `entries` has always been on the wire and was
    /// always discarded, so resuming a session showed an empty screen; a user
    /// could not tell a correctly loaded session from a wrong one, or from a
    /// broken client. [`history::replay`] turns those entries into scrollback
    /// through the same [`Transcript`] live output uses, so a purge resize
    /// re-renders resumed history at the new width like everything else.
    ///
    /// **History is replayed only when the screen is not already showing this
    /// session.** The question the guard asks is not "is this snapshot new?" but
    /// "would the user be reading this conversation twice?", and the answer turns
    /// on the session id alone:
    ///
    /// - *No session on screen* (startup) or *a different one* (a load, a fork,
    ///   a new session): replay. Loading away and back again replays both times,
    ///   which is right — it is two visits.
    /// - *This session already* — a rewind moved the head, a steer or a refresh
    ///   asked for a fresh snapshot, one load was answered twice: **no history
    ///   block at all**. Everything in it is already in scrollback, immediately
    ///   above; printing it again produced the defect this guard exists for, a
    ///   whole conversation duplicated under a `─ history ─` rule while the live
    ///   copy of it was still on screen. A head that moved leaves one dim marker
    ///   saying so, and nothing else.
    ///
    /// The store re-syncs either way: what is gated is scrollback, never state.
    pub fn adopt_snapshot(&mut self, snapshot: &wire::SessionSnapshot) {
        self.store.apply_snapshot_meta(snapshot);
        // A client attaching mid-session gets its presence strip from hydration
        // rather than waiting for the next transition — but only for children
        // that are still moving: one that had already finished never earned a
        // `✓` on this screen, so it is history, not presence.
        self.agents_shown = self
            .store
            .agents()
            .iter()
            .any(|agent| !ui::agent::is_settled(&agent.status));
        // Absent reads as configured, so a daemon that predates the field is
        // not dragged into a wizard it cannot answer.
        self.needs_provider = !snapshot.is_provider_configured();
        let identity = (
            snapshot.descriptor.session_id.clone(),
            snapshot.descriptor.head_id.clone().unwrap_or_default(),
        );
        let (session, head) = identity.clone();
        let shown = self.rendered_history.replace(identity);
        if let Some((shown_session, shown_head)) = shown
            && shown_session == session
        {
            // The head moved under a transcript that is already on screen: a
            // rewind. One dim line, in the reliability vocabulary, saying where
            // the conversation now ends.
            if shown_head != head {
                let messages = history::message_count(&snapshot.entries);
                let rows = self.transcript.audit(&format!(
                    "session rewind · back to {messages} {}",
                    if messages == 1 { "message" } else { "messages" }
                ));
                self.commits.extend(rows);
            }
            return;
        }
        let rows = history::replay(
            &mut self.transcript,
            &snapshot.entries,
            &snapshot.descriptor.name,
        );
        self.commits.extend(rows);
    }

    // -- accessors ---------------------------------------------------------

    /// The session store, for callers that hydrate it.
    #[must_use]
    pub const fn store(&self) -> &SessionStore {
        &self.store
    }

    /// The store, mutably, so bootstrap can fold a snapshot in.
    pub const fn store_mut(&mut self) -> &mut SessionStore {
        &mut self.store
    }

    /// The composer, for tests and for the pty harness's assertions.
    #[must_use]
    pub const fn composer(&self) -> &Composer {
        &self.composer
    }

    /// The theme in force, by name. The theme picker changes it live.
    #[must_use]
    pub fn theme_name(&self) -> &str {
        &self.theme.name
    }

    /// The slash commands this build will complete and offer in the palette.
    #[must_use]
    pub fn commands(&self) -> &[CommandSpec] {
        &self.commands
    }

    /// Queued submissions, oldest first.
    pub fn queued(&self) -> impl Iterator<Item = &Submission> {
        self.queue.entries()
    }

    /// The transcript. **This is the replay source**: registering it is what
    /// makes a purge resize re-render at the new width instead of reprinting
    /// stale rows (DESIGN.md §1).
    pub const fn transcript_mut(&mut self) -> &mut Transcript {
        &mut self.transcript
    }

    /// Whether the loop should stop: the user asked, or the pipe went away.
    #[must_use]
    pub const fn finished(&self) -> bool {
        self.exit || self.closed
    }

    /// Whether anything on screen is driven by the clock — a retry countdown, a
    /// stall colour, an armed gesture, a transient notice. The loop parks longer
    /// when nothing is.
    #[must_use]
    pub fn needs_clock(&self) -> bool {
        self.turn_running()
            || self.esc.is_armed()
            || self.exit_armed.is_some()
            // A debounced completion is a timer like any other: without this the
            // loop would park until the next keystroke and the popup would open
            // one character late.
            || self.mention_due.is_some()
            // Only while it is still on screen: an expired notice must not keep
            // an idle session repainting forever.
            || self
                .notice
                .as_ref()
                .is_some_and(|(_, at)| at.elapsed() < NOTICE_LINGER)
            // A `✓` in the presence strip has to be able to expire on its own,
            // which means one more repaint after the last thing that happened.
            || self.agents_lingering(Instant::now())
    }

    /// Whether a turn is running, client-side. The local view leads the daemon's
    /// by one round trip on purpose: `Enter` must queue the moment the previous
    /// `Enter` was sent, not when the daemon gets around to saying so.
    #[must_use]
    pub fn turn_running(&self) -> bool {
        self.queue.is_streaming() || self.store.phase().is_active()
    }

    /// Rows to print into scrollback, taken.
    pub fn take_commits(&mut self) -> Vec<Row> {
        std::mem::take(&mut self.commits)
    }

    /// Re-wrap at a new terminal width.
    pub fn set_width(&mut self, width: u16) {
        self.width = width.max(8);
        self.composer
            .set_width(ui::composer::content_width(self.width));
        self.transcript.set_width(self.width);
    }

    /// Adopt a new theme (DEC 2031 colour-scheme report).
    ///
    /// Rows already in scrollback keep the colours they were printed with; there
    /// is no way to repaint them and no attempt is made to.
    pub fn set_theme(&mut self, theme: Theme) {
        self.transcript.set_theme(theme.clone());
        self.theme = theme;
    }

    /// Print the session header, once, at start.
    pub fn header(&mut self, fields: &[&str]) {
        let rows = self.transcript.header(fields);
        self.commits.extend(rows);
        self.commits.push(Row::blank());
    }

    /// Commit a dim audit row. Used by bootstrap for things that happen before
    /// there is a transcript to attach them to.
    pub fn audit(&mut self, text: impl Into<String>) {
        let style = self.theme.faint();
        self.commits.push(Row::styled(format!("  {}", text.into()), style));
    }

    /// Commit an error row.
    pub fn error(&mut self, text: impl Into<String>) {
        let style = self.theme.error();
        self.commits.push(Row::styled(format!("  {}", text.into()), style));
    }

    // -- input -------------------------------------------------------------

    /// Route one input event.
    pub fn handle_input(&mut self, event: InputEvent, daemon: &mut dyn Daemon, now: Instant) {
        match event {
            InputEvent::Paste(text) => {
                self.disarm();
                // A pasted credential belongs to the field the caret is in, not
                // to the composer behind the form — and it is inserted whole
                // rather than collapsed into a paste chip, because a chip is a
                // thing you expand to read, which is the opposite of a secret.
                if let Some(form) = self.form_mut() {
                    form.insert(&text);
                    self.refresh_form();
                    return;
                }
                self.composer.paste(&text);
                self.service_completion(now);
            }
            InputEvent::Key(key) => self.key(key, daemon, now),
            // Resize is the debouncer's, in the loop: it must settle before the
            // compositor is told, and the app only learns the outcome.
            InputEvent::Resize { .. } => {}
            InputEvent::Closed => self.exit = true,
        }
    }

    fn key(&mut self, key: KeyEvent, daemon: &mut dyn Daemon, now: Instant) {
        let stack = self.context_stack();
        let Some(action) = self.keymap.lookup(key, &stack) else {
            // Not bound: if it is text, it is text. This is the path every
            // ordinary keystroke takes, and the one the phase-2 loop never had.
            if let Some(character) = key.text_char() {
                self.disarm();
                self.text(&character.to_string(), now);
            }
            return;
        };
        self.run(action, daemon, now);
    }

    /// One printable keystroke, routed to whichever surface owns the keyboard.
    fn text(&mut self, text: &str, now: Instant) {
        if self.overlay.is_some() {
            if let Some(form) = self.form_mut() {
                form.insert(text);
                // What a field holds changes what the form shows: a derived
                // second-entry name, a note about what an empty key means.
                self.refresh_form();
                return;
            }
            if let Some(select) = self.overlay.as_mut().and_then(Open::select_mut) {
                select.insert(text);
            }
            // Highlighting moved, so a theme preview follows it.
            self.preview();
            return;
        }
        self.composer.insert_text(text);
        self.service_completion(now);
    }

    /// Run an action. The palette calls this too — an entry that dispatches an
    /// action must do exactly what its key does, or the palette is a second,
    /// drifting implementation of the keymap.
    #[allow(clippy::too_many_lines)]
    fn run(&mut self, action: Action, daemon: &mut dyn Daemon, now: Instant) {
        if action != Action::Escape {
            self.esc.disarm();
        }
        if action != Action::Cancel {
            self.exit_armed = None;
        }
        match action {
            Action::Escape => {
                // The ladder mutates the world and lives in it; lift it out for
                // the call rather than splitting the struct.
                let mut ladder = std::mem::take(&mut self.esc);
                let mut world = EscView { app: self, daemon };
                ladder.press(&mut world, now);
                self.esc = ladder;
            }
            Action::Cancel => self.cancel_key(daemon, now),
            Action::Quit => self.exit = true,
            Action::Steer => self.steer(daemon),
            Action::ExpandLastTool => {
                let rows = self.transcript.expand_last_tool();
                if rows.is_empty() {
                    self.notify("nothing to expand", now);
                } else {
                    self.commits.extend(rows);
                }
            }
            Action::Palette => self.open_palette(),
            Action::Help => self.open_cheatsheet(),
            Action::OverlayAccept => self.accept_overlay(daemon, now),
            Action::OverlayDismiss => self.close_overlay(),
            Action::OverlayNext | Action::OverlayPrev => {
                if let Some(select) = self.overlay.as_mut().and_then(Open::select_mut) {
                    if action == Action::OverlayNext {
                        select.next();
                    } else {
                        select.prev();
                    }
                }
                self.preview();
            }
            Action::OverlayFilterDelete => {
                if let Some(select) = self.overlay.as_mut().and_then(Open::select_mut) {
                    select.backspace();
                }
                self.preview();
            }
            Action::OverlayScrollUp | Action::OverlayScrollDown => {
                let viewport = OVERLAY_ROWS;
                if let Some(open) = &mut self.overlay
                    && let Some(rows) = open.panel.as_rows_mut()
                {
                    if action == Action::OverlayScrollUp {
                        rows.scroll_up();
                    } else {
                        rows.scroll_down(viewport);
                    }
                }
            }
            Action::CompletionAccept => {
                self.composer.accept_completion();
                self.service_completion(now);
                // Accepting is a decision. The caret now sits inside the very
                // mention that was just chosen, so the trigger fires again —
                // and re-asking would reopen the popup on top of the answer.
                let settled = self
                    .composer
                    .pending_completion()
                    .filter(|request| request.kind == CompletionKind::Mention)
                    .map(|request| request.query.clone());
                if let Some(query) = settled {
                    self.mention_due = None;
                    self.mention_sent = Some(query);
                }
            }
            Action::CompletionNext => self.composer.completion_mut().select_next(),
            Action::CompletionPrev => self.composer.completion_mut().select_prev(),
            Action::ClearScreen => {}
            Action::FormSubmit => self.form_submit(daemon),
            Action::FormVerify => self.form_verify(daemon),
            // Every other action reachable with a form open is the form's — its
            // own navigation and the composer's editing set, which
            // `Context::Form` declares by the same action ids. It must not fall
            // through to the composer behind the panel: a `Backspace` a choice
            // field ignores would otherwise edit the prompt the user cannot see.
            action if self.form_mut().is_some() => {
                if let Some(form) = self.form_mut() {
                    form.apply(action);
                }
                self.after_form_edit(daemon);
            }
            _ => {
                match self.composer.apply(action) {
                    ComposerOutcome::Submit(submission) => self.dispatch(submission, daemon),
                    ComposerOutcome::Handled | ComposerOutcome::Ignored => {}
                }
                self.service_completion(now);
            }
        }
    }

    // -- overlays ----------------------------------------------------------

    /// `Ctrl+P`: every action the registry declares, merged with every command
    /// the daemon routes. One list, because DESIGN.md §4 says one declaration.
    fn open_palette(&mut self) {
        let mut items: Vec<Choice> = Vec::new();
        for entry in self.keymap.palette() {
            // Actions that only exist *inside* a surface the palette replaces
            // would be dead rows: choosing "next candidate" from a palette that
            // just closed the popup does nothing.
            if matches!(
                entry.context,
                Context::Overlay | Context::OverlaySelect | Context::Completion | Context::Form
            ) || entry.keys.is_empty()
            {
                continue;
            }
            items.push(
                Choice::valued(format!("action:{}", entry.action.id()), entry.description)
                    .with_detail(entry.keys),
            );
        }
        for spec in &self.commands {
            items.push(
                Choice::valued(format!("command:/{}", spec.name), format!("/{}", spec.name))
                    .with_detail(spec.detail()),
            );
        }
        // The wizard is neither an action (it has no key: nothing about adding a
        // provider deserves a global chord) nor a daemon command (`/provider` is
        // a *report* there), so the palette declares it once, here, and
        // `/provider add` reaches the same entry point.
        items.push(
            Choice::valued(setup::PALETTE_VALUE, "/provider add")
                .with_detail("Add a provider: endpoint, protocol and credential."),
        );
        // Its two siblings need no special value: they are slash commands this
        // client intercepts, so the palette's ordinary command path already
        // reaches them — one declaration, three ways in (DESIGN.md §4).
        for (line, detail) in [
            ("/provider edit", "Change a provider's endpoint, protocol or credential."),
            ("/provider delete", "Remove a provider, and optionally its credential."),
        ] {
            items.push(Choice::valued(format!("command:{line}"), line).with_detail(detail));
        }
        self.overlay = Some(Open {
            kind: OverlayKind::Palette,
            panel: Panel::select("commands", Select::local(items)),
        });
    }

    /// `?`: the cheatsheet, generated from the keymap and nowhere else.
    fn open_cheatsheet(&mut self) {
        let width = ui::overlay::inner_width(self.width);
        let rows = ui::hints::cheatsheet(
            &self.theme,
            &self.keymap,
            u16::try_from(width).unwrap_or(u16::MAX),
        );
        self.overlay = Some(Open {
            kind: OverlayKind::Cheatsheet,
            panel: Panel::rows("keys", rows),
        });
    }

    /// Open a picker whose rows are still in flight.
    fn open_picker(&mut self, kind: OverlayKind, title: &str, daemon: &mut dyn Daemon) {
        let call = match kind {
            OverlayKind::Model => Call::Models,
            OverlayKind::Provider(_) => Call::Providers,
            OverlayKind::Sessions => Call::Sessions,
            _ => return,
        };
        self.overlay = Some(Open {
            kind,
            panel: Panel::select(title.to_owned(), Select::new(Ranking::Local)),
        });
        daemon.send(call);
    }

    /// The per-provider menu: what accepting a provider row opens.
    ///
    /// Three verbs, and the switch is first so that `Enter Enter` on an
    /// untouched picker is what it always was — the picker opens on the current
    /// provider, and this opens on the switch. Nothing here is filled in from
    /// the list that got us here: `provider/get` is asked for, and the rows
    /// grow their endpoint and protocol when it answers.
    fn open_provider_menu(&mut self, provider: &str, daemon: &mut dyn Daemon) {
        self.overlay = Some(Open {
            kind: OverlayKind::ProviderMenu(provider.to_owned()),
            panel: Panel::select(provider.to_owned(), Select::local(menu_choices(provider, None))),
        });
        daemon.send(Call::ProviderGet {
            provider: provider.to_owned(),
            purpose: Purpose::Menu,
        });
    }

    /// The delete confirmation. Opens before `provider/get` answers, and grows
    /// the credential toggle when it does.
    pub(super) fn open_provider_delete(&mut self, provider: &str, daemon: &mut dyn Daemon) {
        self.confirm = Some(Confirm::new(provider));
        self.overlay = Some(Open {
            kind: OverlayKind::ProviderDelete,
            panel: Panel::select(
                format!("delete {provider}?"),
                Select::local(Vec::new()),
            ),
        });
        self.refresh_confirm();
        daemon.send(Call::ProviderGet {
            provider: provider.to_owned(),
            purpose: Purpose::Delete,
        });
    }

    /// Redraw the confirmation's rows from [`App::confirm`], keeping the
    /// highlight where it was — toggling a checkbox must not move the caret off
    /// the checkbox.
    fn refresh_confirm(&mut self) {
        let Some(confirm) = self.confirm.clone() else {
            return;
        };
        let Some(open) = &mut self.overlay else { return };
        if open.kind != OverlayKind::ProviderDelete {
            return;
        }
        let Some(select) = open.panel.as_select_mut() else {
            return;
        };
        let at = select.selected();
        select.set_items(confirm_choices(&confirm));
        for _ in 0..at {
            select.next();
        }
    }

    // -- rewind ------------------------------------------------------------

    /// `/rewind`: the checkpoint picker.
    ///
    /// Opens empty and fills when `checkpoint/list` answers, exactly as the
    /// model and session pickers do. The list is re-fetched rather than served
    /// from [`App::checkpoints`] because a picker is a decision surface: the
    /// cache exists to keep the `Esc` hint honest between frames, not to be what
    /// a user picks from.
    fn open_rewind_picker(&mut self, daemon: &mut dyn Daemon) {
        self.overlay = Some(Open {
            kind: OverlayKind::RewindPick,
            panel: Panel::select("rewind", Select::new(Ranking::Local)),
        });
        self.fill(OverlayKind::RewindPick, checkpoint_choices(&self.checkpoints));
        daemon.send(Call::Checkpoints {
            limit: CHECKPOINT_PAGE,
            why: Rewind::Picker,
        });
    }

    /// `Esc Esc`, and choosing a row of the picker: the confirmation.
    ///
    /// Two questions, in the order they are answerable: *how far back* is
    /// already settled by the time this opens, and *how much* — the conversation
    /// alone, or the working directory with it — is what it asks.
    fn open_rewind_confirm(&mut self, checkpoint: wire::Checkpoint) {
        self.rewind = Some(RewindConfirm::new(checkpoint));
        self.overlay = Some(Open {
            kind: OverlayKind::RewindConfirm,
            panel: Panel::select("rewind", Select::local(Vec::new())),
        });
        self.refresh_rewind();
    }

    /// Redraw the confirmation from [`App::rewind`], keeping the highlight where
    /// it was — ticking a box must not move the caret off the box.
    fn refresh_rewind(&mut self) {
        let Some(state) = self.rewind.clone() else {
            return;
        };
        let Some(open) = &mut self.overlay else { return };
        if open.kind != OverlayKind::RewindConfirm {
            return;
        }
        open.panel.title = rewind_title(&state);
        let Some(select) = open.panel.as_select_mut() else {
            return;
        };
        let at = select.selected();
        select.set_items(rewind_choices(&state));
        for _ in 0..at {
            select.next();
        }
    }

    /// `Esc Esc` reached the rewind rung.
    ///
    /// The list is re-fetched rather than acted on from cache: a checkpoint id
    /// is about to be handed to the one method that writes, and a deliberate
    /// two-press gesture can afford the round trip that makes it current.
    fn begin_rewind(&mut self, daemon: &mut dyn Daemon) {
        daemon.send(Call::Checkpoints {
            limit: CHECKPOINT_PAGE,
            why: Rewind::Confirm,
        });
    }

    /// Fold in `checkpoint/list`, for whichever surface asked.
    fn adopt_checkpoints(&mut self, why: Rewind, outcome: Result<&Value, &String>) {
        let listed = match outcome {
            Ok(value) => serde_json::from_value::<wire::CheckpointListResult>(value.clone())
                .map_err(|error| error.to_string()),
            Err(detail) => Err((*detail).clone()),
        };
        let listed = match listed {
            Ok(listed) => listed,
            Err(detail) => {
                // A background refresh that failed is not the user's problem:
                // `can_rewind` simply keeps saying no, and the rung stays out of
                // the hint line. A surface that was *asked for* has to say why.
                if why != Rewind::Refresh {
                    self.error(format!("{}: {detail}", wire::method::CHECKPOINT_LIST));
                }
                return;
            }
        };
        // Unavailable means there is nothing to rewind to and never will be in
        // this directory. Keeping the list empty is what keeps `can_rewind`
        // false, so the rung and its hint disappear rather than misfiring.
        if !listed.available {
            self.checkpoints.clear();
            if why != Rewind::Refresh {
                let reason = listed
                    .unavailable
                    .unwrap_or_else(|| "this directory cannot hold checkpoints".to_owned());
                self.close_overlay();
                self.error(format!("no checkpoints here · {reason}"));
            }
            return;
        }
        self.checkpoints = listed.checkpoints;
        match why {
            Rewind::Refresh => {}
            Rewind::Picker => {
                self.fill(OverlayKind::RewindPick, checkpoint_choices(&self.checkpoints));
            }
            Rewind::Confirm => match self.newest_rewind_target() {
                Some(checkpoint) => self.open_rewind_confirm(checkpoint),
                None => self.error("nothing to rewind to yet"),
            },
        }
    }

    /// The checkpoint `Esc Esc` means: the newest one anchored to a transcript
    /// entry, falling back to the newest of any kind.
    ///
    /// Anchored first because the gesture is about the *conversation* — an
    /// unanchored checkpoint can only take the files back, which is a narrower
    /// thing than the user asked for and is offered as such.
    fn newest_rewind_target(&self) -> Option<wire::Checkpoint> {
        self.checkpoints
            .iter()
            .find(|checkpoint| checkpoint.anchored().is_some())
            .or_else(|| self.checkpoints.first())
            .cloned()
    }

    /// Fold in `checkpoint/restore` — the never-clobber rule, reported.
    ///
    /// The refusal is the interesting half. Files that changed outside Lyra's
    /// own tool calls come back untouched and **by name**, because "3 files were
    /// preserved" is not something anyone can act on, and the `--force` that
    /// would revert them is offered *here* — after the rule has actually said
    /// no — rather than as a checkbox on a question nobody had yet.
    fn adopt_restored(&mut self, forced: bool, outcome: Result<&Value, &String>) {
        let decoded = match outcome {
            Ok(value) => serde_json::from_value::<wire::CheckpointRestoreResult>(value.clone())
                .map_err(|error| error.to_string()),
            Err(detail) => Err((*detail).clone()),
        };
        let restored = match decoded {
            Ok(restored) => restored,
            Err(detail) => {
                self.rewind = None;
                self.error(format!("{}: {detail}", wire::method::CHECKPOINT_RESTORE));
                return;
            }
        };
        for line in restore_lines(&restored) {
            let style = self.theme.warning();
            self.commits.push(Row::styled(format!("  {line}"), style));
        }
        if restored.preserved.is_empty() || forced {
            self.rewind = None;
            return;
        }
        // The rule said no to something. Re-open the confirmation with the row
        // that overrides it — which is the first moment this client knows there
        // is anything to override.
        //
        // Unless the user has moved on. A restore is fire-and-forget and its
        // answer can land after a palette or a picker has been opened; a panel
        // that appeared over one of those would be a modal nobody asked for, so
        // the override is named as a command instead. The preserved files are
        // already in scrollback either way — the never-clobber rule is reported
        // whether or not there is a surface to report it on.
        if self.overlay.is_some() {
            self.rewind = None;
            self.audit(format!(
                "revert those too with /rollback {} --force",
                restored.target.id
            ));
            return;
        }
        let state = self
            .rewind
            .take()
            .unwrap_or_else(|| RewindConfirm::new(restored.target.clone()));
        self.rewind = Some(RewindConfirm {
            preserved: restored.preserved.clone(),
            force: false,
            ..state
        });
        self.overlay = Some(Open {
            kind: OverlayKind::RewindConfirm,
            panel: Panel::select("preserved", Select::local(Vec::new())),
        });
        self.refresh_rewind();
    }

    /// Fold in `session/rewind`.
    ///
    /// The transcript on screen is not touched here: the daemon answers a rewind
    /// with `session_changed`, and [`App::adopt_snapshot`] leaves the one dim
    /// marker a moved head deserves. This only says what was undone.
    fn adopt_rewound(&mut self, outcome: Result<&Value, &String>) {
        match outcome {
            Ok(value) => match serde_json::from_value::<wire::RewindResult>(value.clone()) {
                Ok(rewound) => {
                    let line = match rewound.removed_messages {
                        // Absent is "not counted", which is not zero — so it
                        // says nothing rather than claiming nothing moved.
                        None => "rewound".to_owned(),
                        Some(0) => "rewound · already there".to_owned(),
                        Some(count) => format!(
                            "rewound · {count} {} undone",
                            if count == 1 { "message" } else { "messages" }
                        ),
                    };
                    self.audit(line);
                }
                Err(error) => self.error(format!("{}: {error}", wire::method::SESSION_REWIND)),
            },
            Err(detail) => self.error(format!("{}: {detail}", wire::method::SESSION_REWIND)),
        }
    }

    /// The theme picker, which needs no daemon at all.
    fn open_theme_picker(&mut self) {
        let items: Vec<Choice> = Theme::BUNDLED
            .iter()
            .map(|name| Choice::new(*name).current(*name == self.theme.name))
            .collect();
        self.overlay = Some(Open {
            kind: OverlayKind::Theme {
                restore: Box::new(self.theme.clone()),
            },
            panel: Panel::select("theme", Select::local(items)),
        });
        self.preview();
    }

    /// Apply the highlighted theme immediately.
    ///
    /// Cheap because the theme system already supports a live re-theme (the DEC
    /// 2031 path), so a preview is the same operation the terminal triggers when
    /// the user flips light/dark — no second mechanism.
    fn preview(&mut self) {
        let Some(open) = &self.overlay else { return };
        if !matches!(open.kind, OverlayKind::Theme { .. }) {
            return;
        }
        let name = open
            .panel
            .as_select()
            .and_then(Select::selection)
            .map(|choice| choice.value.clone());
        let Some(name) = name else { return };
        if let Some(theme) = Theme::by_name(&name) {
            self.set_theme(theme);
        }
    }

    /// Close the overlay, undoing anything highlighting it changed.
    ///
    /// Dropping the panel is what drops a half-filled form — and with it the
    /// credential buffer, which therefore lives no longer than the panel that
    /// was collecting it.
    fn close_overlay(&mut self) {
        let Some(open) = self.overlay.take() else {
            return;
        };
        match open.kind {
            OverlayKind::Theme { restore } => self.set_theme(*restore),
            OverlayKind::ProviderForm => self.setup = None,
            // Dismissing a confirmation is the "no" answer, so nothing is left
            // waiting for a call that will never be made.
            OverlayKind::ProviderDelete => self.confirm = None,
            OverlayKind::RewindConfirm => self.rewind = None,
            _ => {}
        }
    }

    /// `Enter` on a select overlay.
    fn accept_overlay(&mut self, daemon: &mut dyn Daemon, now: Instant) {
        let Some(open) = self.overlay.take() else {
            return;
        };
        let Some(choice) = open.panel.as_select().and_then(Select::selection).cloned() else {
            // Nothing highlighted (an empty filter result): keep the panel up
            // rather than closing it out from under a user mid-search.
            self.overlay = Some(open);
            return;
        };
        // Destructured, because one path — flipping a checkbox — puts the very
        // same panel back up rather than closing it.
        let Open { kind, panel } = open;
        match kind {
            OverlayKind::Cheatsheet => {}
            OverlayKind::Palette => {
                if choice.value == setup::PALETTE_VALUE {
                    self.open_provider_setup(daemon, false);
                } else if let Some(id) = choice.value.strip_prefix("action:") {
                    if let Some(action) = Action::from_id(id) {
                        self.run(action, daemon, now);
                    }
                } else if let Some(line) = choice.value.strip_prefix("command:") {
                    let line = line.to_owned();
                    let rows = self.transcript.user(&line);
                    self.commits.extend(rows);
                    self.command(&line, daemon);
                }
            }
            OverlayKind::Model => daemon.send(Call::SelectModel(choice.value)),
            OverlayKind::Provider(pick) => {
                if choice.value == setup::PALETTE_VALUE {
                    self.open_provider_setup(daemon, false);
                } else {
                    match pick {
                        Pick::Menu => self.open_provider_menu(&choice.value, daemon),
                        Pick::Edit => self.open_provider_edit(&choice.value, daemon),
                        Pick::Delete => self.open_provider_delete(&choice.value, daemon),
                    }
                }
            }
            OverlayKind::ProviderMenu(provider) => match choice.value.as_str() {
                // Exactly what accepting a provider row used to do, unchanged:
                // one more keystroke than before, and the same call. `/model` is
                // still where a model is chosen, which is what the row says.
                menu::SWITCH => daemon.send(Call::SelectProvider {
                    provider,
                    model: None,
                }),
                menu::EDIT => self.open_provider_edit(&provider, daemon),
                menu::DELETE => self.open_provider_delete(&provider, daemon),
                _ => {}
            },
            OverlayKind::ProviderDelete => match choice.value.as_str() {
                confirm::REMOVE => {
                    if let Some(state) = &self.confirm {
                        daemon.send(Call::ProviderRemove(Box::new(state.params())));
                    }
                }
                // A checkbox is not a decision: flipping it puts the panel back
                // up, with the highlight still on the row that was flipped.
                confirm::TOGGLE => {
                    if let Some(state) = &mut self.confirm {
                        state.remove_credential = !state.remove_credential;
                    }
                    self.overlay = Some(Open {
                        kind: OverlayKind::ProviderDelete,
                        panel,
                    });
                    self.refresh_confirm();
                }
                // `cancel`, and anything a future row adds: the take above has
                // already closed the panel, so declining is doing nothing.
                _ => self.confirm = None,
            },
            OverlayKind::RewindPick => {
                if let Some(checkpoint) = self
                    .checkpoints
                    .iter()
                    .find(|checkpoint| checkpoint.id == choice.value)
                    .cloned()
                {
                    self.open_rewind_confirm(checkpoint);
                }
            }
            OverlayKind::RewindConfirm => match choice.value.as_str() {
                // Conversation only: the head moves, the working directory is
                // left exactly as it is. Two calls exist because they are two
                // decisions, and this is the one that changes nothing on disk.
                rewind_row::CONVERSATION => {
                    let entry = self
                        .rewind
                        .as_ref()
                        .and_then(|state| state.anchored())
                        .map(str::to_owned);
                    self.rewind = None;
                    daemon.send(Call::Rewind { entry_id: entry });
                }
                // Both, in that order: the conversation first, because a restore
                // that half-succeeds must not leave the transcript ahead of the
                // tree it is describing.
                rewind_row::BOTH | rewind_row::CODE => {
                    let Some(state) = self.rewind.clone() else { return };
                    if choice.value == rewind_row::BOTH {
                        daemon.send(Call::Rewind {
                            entry_id: state.anchored().map(str::to_owned),
                        });
                    }
                    daemon.send(Call::Restore {
                        checkpoint: state.checkpoint.id.clone(),
                        force: false,
                    });
                }
                // The override, which only exists once a restore has reported
                // files it refused to touch.
                rewind_row::FORCE => {
                    if let Some(state) = &self.rewind
                        && state.force
                    {
                        daemon.send(Call::Restore {
                            checkpoint: state.checkpoint.id.clone(),
                            force: true,
                        });
                        self.rewind = None;
                    } else {
                        // Unticked: say so rather than doing nothing silently.
                        self.rewind = None;
                        self.notify("nothing reverted · tick the box to override", now);
                    }
                }
                // A checkbox is not a decision: the panel goes back up with the
                // highlight where it was.
                rewind_row::TOGGLE => {
                    if let Some(state) = &mut self.rewind {
                        state.force = !state.force;
                    }
                    self.overlay = Some(Open {
                        kind: OverlayKind::RewindConfirm,
                        panel,
                    });
                    self.refresh_rewind();
                }
                _ => self.rewind = None,
            },
            OverlayKind::Sessions => daemon.send(Call::LoadSession(choice.value)),
            // A form's `Enter` is `Action::FormSubmit`, never this path.
            OverlayKind::ProviderForm | OverlayKind::ModelForm => {}
            OverlayKind::Theme { .. } => {
                // Already applied by the preview; accepting is simply not
                // restoring, which is what `take` above just guaranteed.
                self.notify(format!("theme · {}", choice.value), now);
            }
        }
    }

    /// `Ctrl+C`: cancel the running turn; twice in a row exits (DESIGN.md §0.2).
    fn cancel_key(&mut self, daemon: &mut dyn Daemon, now: Instant) {
        if self
            .exit_armed
            .is_some_and(|at| now.duration_since(at) <= ARM_WINDOW)
        {
            self.exit = true;
            return;
        }
        let running = self.turn_running();
        if running {
            self.cancel_turn(daemon);
        }
        self.exit_armed = Some(now);
        self.notify(
            if running {
                "cancelled · ctrl+c again to exit"
            } else {
                "ctrl+c again to exit"
            },
            now,
        );
    }

    /// `Ctrl+S`: flush the queue, plus whatever is in the composer, as steering.
    fn steer(&mut self, daemon: &mut dyn Daemon) {
        // Steering an idle session is a send. The binding only exists in the
        // streaming context so this is belt and braces, but the composer's text
        // must not be consumed by a call that then does nothing with it.
        if !self.queue.is_streaming() {
            if let ComposerOutcome::Submit(submission) = self.composer.submit() {
                self.dispatch(submission, daemon);
            }
            return;
        }
        let pending = match self.composer.submit() {
            ComposerOutcome::Submit(submission) => Some(submission),
            _ => None,
        };
        if let QueueEffect::Steer(batch) = self.queue.steer(pending) {
            for submission in batch {
                // No local echo: the daemon answers a steer with a `steer`
                // update carrying the entry it actually wrote, and echoing here
                // as well is how the same message ends up in the transcript
                // twice.
                daemon.send(Call::Steer(submission.text));
                self.store.note_steer_sent(None);
            }
        }
    }

    /// A composed submission, routed by DESIGN.md §0.2's queue-by-default rule.
    fn dispatch(&mut self, submission: Submission, daemon: &mut dyn Daemon) {
        match self.queue.submit(submission) {
            QueueEffect::Send(submission) => self.send(submission, daemon),
            QueueEffect::Queued { .. } | QueueEffect::Steer(_) | QueueEffect::Nothing => {}
        }
    }

    /// Actually put a submission on the wire, with the local echo that makes the
    /// user's own text appear at keystroke latency rather than round-trip
    /// latency. The daemon emits no user-message update; this band is ours.
    fn send(&mut self, submission: Submission, daemon: &mut dyn Daemon) {
        let text = submission.text.trim().to_owned();
        if text.is_empty() {
            self.queue.turn_cancelled();
            return;
        }
        let echo = match submission.mode {
            ComposerMode::Prompt => text.clone(),
            ComposerMode::Bash => format!("! {text}"),
        };
        let rows = self.transcript.user(&echo);
        self.commits.extend(rows);

        if submission.mode == ComposerMode::Prompt && text.starts_with('/') {
            // A slash command is not a turn: it never emits `turn_start`, so the
            // optimistic phase flip `submit` just did has to be undone or the
            // next `Enter` would queue behind a turn that will never end.
            self.queue.turn_cancelled();
            self.command(&text, daemon);
            return;
        }
        self.in_flight = Some(text.clone());
        self.turn_output = false;
        // Nothing has come back yet, and a turn cannot be silent since a moment
        // that never happened: the first update sets the reference point.
        self.last_activity = None;
        daemon.send(Call::Prompt(text));
    }

    /// Route a slash command: a picker here, or the daemon's router.
    ///
    /// Only the **bare** form opens a picker. `/model opus-5` is an instruction
    /// and goes to the daemon unchanged; `/model` is a question, and a list you
    /// can arrow through is the better answer.
    fn command(&mut self, line: &str, daemon: &mut dyn Daemon) {
        let mut words = line.trim_start_matches('/').split_whitespace();
        let name = words.next().unwrap_or_default().to_owned();
        let rest: Vec<&str> = words.collect();
        let bare = rest.is_empty();
        // `/provider` is a *report* in the daemon's catalog — it shows what is
        // configured and switches between them — so the three verbs that change
        // a provider have no router to go to and are intercepted here, exactly
        // as a bare `/model` is.
        //
        // The bare form of a verb opens the picker **already in that mode**, so
        // "I want to delete one but cannot spell it" is a list rather than a
        // usage error.
        if name == "provider" && matches!(rest.first(), Some(&"add" | &"edit" | &"delete")) {
            match rest.as_slice() {
                ["add"] => self.open_provider_setup(daemon, false),
                ["edit"] => self.open_picker(
                    OverlayKind::Provider(Pick::Edit),
                    Pick::Edit.title(),
                    daemon,
                ),
                ["delete"] => self.open_picker(
                    OverlayKind::Provider(Pick::Delete),
                    Pick::Delete.title(),
                    daemon,
                ),
                // The id rule is the daemon's own, restated where it can be
                // acted on: a name outside it cannot name a configured
                // provider, so asking about it is a typo, not a round trip.
                ["edit" | "delete", provider] if !setup::is_provider_id(provider) => {
                    self.error(format!(
                        "no provider is named {provider} · lowercase letters, digits and hyphens"
                    ));
                }
                ["edit", provider] => self.open_provider_edit(provider, daemon),
                ["delete", provider] => self.open_provider_delete(provider, daemon),
                [verb, ..] => self.error(format!("usage: /provider {verb} [<name>]")),
                [] => unreachable!("guarded by the first-word match"),
            }
            return;
        }
        // `/model add` likewise: the daemon's `/model` router switches models,
        // and declaring one is `model/add`, which no router reaches.
        if name == "model" && rest.first() == Some(&"add") {
            match rest.as_slice() {
                ["add"] => self.open_model_form(daemon),
                ["add", provider, model] => self.add_model(provider, model, daemon),
                _ => self.error("usage: /model add [<provider> <model>]"),
            }
            return;
        }
        // `/resume <name>` is the one argument form that is *this* client's
        // rather than the router's: the daemon's `/resume` answers with a report
        // line, and what a resume needs is the session adopted and its history on
        // screen — which is `session/load` plus the snapshot `session_changed`
        // triggers. Bare, it falls through to the picker below.
        if name == "resume"
            && let [target] = rest.as_slice()
        {
            daemon.send(Call::LoadSession((*target).to_owned()));
            return;
        }
        // `/rewind` has no router to go to at all: the daemon owns the three
        // checkpoint methods and has no opinion about which of them a gesture
        // means, so both forms are answered here. With an id it is the same
        // confirmation `Esc Esc` opens, aimed at a checkpoint the user named.
        if name == "rewind"
            && let [target] = rest.as_slice()
        {
            match self
                .checkpoints
                .iter()
                .find(|checkpoint| checkpoint.id == *target)
                .cloned()
            {
                Some(checkpoint) => self.open_rewind_confirm(checkpoint),
                None => self.error(format!(
                    "no checkpoint is called {target} · /rewind to see them"
                )),
            }
            return;
        }
        if bare && PICKER_COMMANDS.contains(&name.as_str()) {
            match name.as_str() {
                "model" => self.open_picker(OverlayKind::Model, "model", daemon),
                "provider" => self.open_picker(
                    OverlayKind::Provider(Pick::Menu),
                    Pick::Menu.title(),
                    daemon,
                ),
                // Two spellings, one picker. `/sessions` is the noun and
                // `/resume` is the verb, and a user who typed either wanted the
                // same list — the old `/resume` demanded a "session name" that
                // nothing on screen ever told them.
                "sessions" | "resume" => {
                    self.open_picker(OverlayKind::Sessions, "session", daemon);
                }
                "theme" => self.open_theme_picker(),
                "rewind" => self.open_rewind_picker(daemon),
                _ => unreachable!("PICKER_COMMANDS and this match are one list"),
            }
            return;
        }
        daemon.send(Call::Command(line.to_owned()));
    }

    // -- completion --------------------------------------------------------

    /// Answer, or arrange to answer, whatever trigger the caret is sitting in.
    ///
    /// Commands are answered here and now: the registry is already in memory, so
    /// a round trip would be latency for nothing. Mentions are the daemon's, and
    /// are debounced — see [`App::flush_completion`].
    fn service_completion(&mut self, now: Instant) {
        let Some(request) = self.composer.pending_completion().cloned() else {
            self.mention_due = None;
            self.mention_sent = None;
            return;
        };
        match request.kind {
            CompletionKind::Command => {
                self.mention_due = None;
                self.mention_sent = None;
                let items = self.command_items(&request.query);
                self.composer.completion_mut().set_items(items);
            }
            CompletionKind::Mention => {
                if self.mention_sent.as_deref() == Some(request.query.as_str()) {
                    return;
                }
                let restart = self
                    .mention_due
                    .as_ref()
                    .is_none_or(|(query, _)| *query != request.query);
                if restart {
                    self.mention_due = Some((request.query, now + COMPLETION_DEBOUNCE));
                }
            }
        }
    }

    /// Send a settled `@` query. Called once per tick, after input.
    fn flush_completion(&mut self, daemon: &mut dyn Daemon, now: Instant) {
        let Some((query, due)) = self.mention_due.clone() else {
            return;
        };
        if now < due {
            return;
        }
        self.mention_due = None;
        self.mention_sent = Some(query.clone());
        daemon.send(Call::Complete {
            session_id: self
                .store
                .descriptor()
                .map(|descriptor| descriptor.session_id.clone()),
            kind: "file",
            query,
            limit: COMPLETION_LIMIT,
        });
    }

    /// Command candidates for `/query`, ranked **locally** — the registry is a
    /// local list, so local fuzzy matching is the right ranker for it.
    ///
    /// A fully typed name suggests nothing, so the popup closes and `Enter`
    /// means "run it" rather than "accept the completion you already typed".
    fn command_items(&self, query: &str) -> Vec<CompletionItem> {
        if self.commands.iter().any(|spec| spec.name == query) {
            return Vec::new();
        }
        let mut scored: Vec<(i64, &CommandSpec)> = self
            .commands
            .iter()
            .filter_map(|spec| {
                ui::overlay::fuzzy_score(query, &spec.name).map(|score| (score, spec))
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.name.cmp(&b.1.name)));
        scored
            .into_iter()
            .map(|(_, spec)| {
                CompletionItem::new(format!("/{}", spec.name), format!("/{}", spec.name))
                    .with_detail(spec.detail())
            })
            .collect()
    }

    /// Adopt `session/commands`, keeping the client-only commands the daemon has
    /// never heard of.
    fn adopt_commands(&mut self, value: &Value) {
        let Some(declared) = value
            .get("commands")
            .or(Some(value))
            .and_then(Value::as_array)
        else {
            return;
        };
        let mut commands: Vec<CommandSpec> = declared
            .iter()
            .filter_map(|item| {
                let name = item.get("name")?.as_str()?.trim_start_matches('/').to_owned();
                (!name.is_empty()).then(|| CommandSpec {
                    name,
                    description: text_field(item, "description").unwrap_or_default(),
                    usage: text_field(item, "usage"),
                    result_kind: text_field(item, "resultKind"),
                })
            })
            .collect();
        if commands.is_empty() {
            return;
        }
        for (name, description) in CLIENT_COMMANDS {
            if !commands.iter().any(|spec| spec.name == name) {
                commands.push(CommandSpec::bare(name, description));
            }
        }
        self.commands = commands;
    }

    /// Adopt `session/complete`, **in the order given**.
    ///
    /// Guarded by the query: an answer to a request the caret has already moved
    /// past would otherwise fill the popup with candidates for text that is no
    /// longer there.
    fn adopt_completions(&mut self, query: &str, value: &Value) {
        let matches_caret = self
            .composer
            .pending_completion()
            .is_some_and(|request| request.kind == CompletionKind::Mention && request.query == query);
        if !matches_caret {
            return;
        }
        let Some(raw) = value.get("items").and_then(Value::as_array) else {
            return;
        };
        let items: Vec<CompletionItem> = raw
            .iter()
            .filter_map(|entry| {
                let path = text_field(entry, "value")?;
                let label = text_field(entry, "label").unwrap_or_else(|| path.clone());
                // The insertion is the workspace-relative path the daemon
                // returned, trigger character included, so accepting a
                // completion produces exactly the mention the daemon can resolve.
                let item = CompletionItem::new(label, format!("@{path}"));
                Some(match text_field(entry, "detail") {
                    Some(detail) => item.with_detail(detail),
                    None => item,
                })
            })
            .collect();
        self.composer.completion_mut().set_items(items);
    }

    /// Cancel the running turn, rewinding the prompt when that is honest.
    fn cancel_turn(&mut self, daemon: &mut dyn Daemon) {
        let rewound = self.rewind_prompt();
        daemon.send(Call::Cancel {
            rewound_to_composer: rewound,
        });
        self.queue.turn_cancelled();
    }

    /// Put the in-flight prompt back in the composer, if that is safe.
    ///
    /// Only when the composer is free and the turn has said nothing: claiming a
    /// rewind that did not happen is exactly how the send+cancel double-prompt
    /// bug comes back (DESIGN.md §0.2).
    fn rewind_prompt(&mut self) -> bool {
        let prompt = self.in_flight.take();
        if self.turn_output || !self.composer.is_empty() {
            return false;
        }
        let Some(prompt) = prompt else { return false };
        self.composer.set_text(&prompt);
        true
    }

    fn disarm(&mut self) {
        self.esc.disarm();
        self.exit_armed = None;
    }

    fn notify(&mut self, text: impl Into<String>, now: Instant) {
        self.notice = Some((text.into(), now));
    }

    fn context_stack(&self) -> ContextStack {
        let layer = self.overlay.as_ref().map_or(Layer::None, Open::layer);
        ContextStack::layered(
            layer,
            !layer.is_open() && self.composer.completion().is_open(),
            self.composer.is_empty(),
            self.turn_running(),
        )
    }

    // -- daemon events -----------------------------------------------------

    /// Fold one ACP event in.
    pub fn handle_event(&mut self, event: AcpEvent, daemon: &mut dyn Daemon, now: Instant) {
        match event {
            AcpEvent::Update(frame) => self.update(&frame.update, daemon, now),
            AcpEvent::Notification { method, .. } => self.audit(format!("· {method}")),
            AcpEvent::ServerRequest { method, .. } => {
                self.audit(format!("· declined {method} — no permission UI yet"));
            }
            AcpEvent::Malformed(detail) => self.error(format!("malformed frame: {detail}")),
            AcpEvent::Closed(reason) => {
                if let Some(reason) = reason {
                    self.error(format!("daemon disconnected: {reason}"));
                }
                self.closed = true;
            }
        }
    }

    #[allow(clippy::too_many_lines)]
    fn update(&mut self, update: &Update, daemon: &mut dyn Daemon, now: Instant) {
        // What a child *was*, read before the update overwrites it: the update
        // carries the new state and an audit row is earned by the change.
        let was = match update {
            Update::Agent(agent) => Some(
                self.store
                    .agent(&agent.id)
                    .map(|known| known.status.clone()),
            ),
            _ => None,
        };
        self.store.apply(update);
        // Every frame the daemon sends is proof the turn is moving, whatever it
        // carries — a thinking delta, a tool-call lifecycle event, a reasoning
        // item, usage, a retry, a steer ack, or something this build does not
        // model. Narrowing this to text deltas is what made a working turn look
        // stalled the moment the model picked up a tool.
        self.last_activity = Some(now);
        match update {
            Update::TurnStart(_) => {
                self.queue.turn_started();
                self.turn_output = false;
            }
            Update::Delta(delta) if delta.field == DeltaField::Text => {
                self.turn_output = true;
                let rows = self.transcript.assistant_delta(&delta.delta);
                self.commits.extend(rows);
            }
            // Thinking, signatures and streamed tool arguments are the store's;
            // they never reach scrollback as prose.
            Update::Delta(_) => {}
            // Two surfaces, and the split is deliberate. The presence strip
            // (drawn from the store, every frame) is the present tense; only the
            // three transitions that are *history* reach scrollback, collapsed,
            // so a swarm costs a line rather than a page.
            Update::Agent(agent) => self.agent_transition(agent, was.flatten().as_ref(), now),
            Update::ToolCallStart(start) => {
                self.running_tool = Some(tool_label(&start.tool, start.args_summary.as_deref()));
            }
            Update::ToolCallUpdate(progress) => {
                if let Some(tool) = &progress.tool {
                    self.running_tool = Some(tool_label(tool, progress.args_summary.as_deref()));
                }
            }
            Update::ToolCallEnd(end) => {
                self.running_tool = None;
                let view = self.store.tool_call(&end.tool_call_id).map(ToolView::from_call);
                if let Some(view) = view {
                    let rows = self.transcript.tool(view);
                    self.commits.extend(rows);
                }
            }
            Update::Retry(retry) => {
                let rows = self.transcript.retry(ui::reliability::Retry {
                    attempt: retry.attempt,
                    max_attempts: retry.max_attempts,
                    classification: Some(retry.classification.to_string()),
                    seconds_remaining: Some(retry.delay_ms.div_euclid(1000)),
                    elapsed_seconds: None,
                });
                self.commits.extend(rows);
            }
            Update::Compaction(compaction) => {
                let reclaimed = i64::try_from(compaction.tokens_reclaimed()).unwrap_or(i64::MAX);
                let rows = self.transcript.compacted(-reclaimed, None);
                self.commits.extend(rows);
            }
            Update::ContextRepair(repairs) => {
                for repair in &repairs.repairs {
                    let rows = self.transcript.context_repaired(&repair.detail);
                    self.commits.extend(rows);
                }
            }
            Update::LoopWarning(warning) => {
                let detail = loop_detail(&warning.warning);
                let rows = self.transcript.loop_warning(&detail);
                self.commits.extend(rows);
            }
            Update::TransportFallback(fallback) => {
                let rows = self.transcript.transport_fallback(
                    fallback.from.as_str(),
                    fallback.to.as_str(),
                    Some(fallback.reason.as_str()),
                );
                self.commits.extend(rows);
            }
            // Who spoke decides how it is drawn. A hub aside is another agent's
            // message folded into this turn at a tool boundary; rendering it in
            // the `>` user band would put words in the user's mouth, so it gets
            // its own dim `⇄ peer: …` row and the daemon's envelope — the
            // preamble and reply instruction written *for the model* — is peeled
            // off, because the row already says both things it says.
            Update::Steer(steer) => {
                let rows = match steer.source {
                    Some(wire::SteerSource::Hub) => {
                        let (from, text) = ui::agent::unwrap_aside(&steer.text);
                        let from = steer
                            .from
                            .clone()
                            .or(from)
                            .unwrap_or_else(|| "an agent".to_owned());
                        self.transcript.hub_aside(&from, &text)
                    }
                    _ => self.transcript.user(&steer.text),
                };
                self.commits.extend(rows);
            }
            Update::Error(error) => self.error(error.error.to_string()),
            Update::Report(report) => {
                let rows = {
                    let style = self.theme.faint();
                    vec![Row::styled(format!("  {}", report.message), style)]
                };
                self.commits.extend(rows);
            }
            Update::TurnEnd(end) => self.turn_ended(end, daemon),
            // The transcript underneath was replaced. The old one cannot be
            // reconciled with the new one, so it is dropped whole — and then
            // the new one is *fetched*, because a client that reset its
            // transcript and stopped there is exactly the bug this arm used to
            // be: the session loaded, and the screen stayed empty.
            //
            // Unless it is the *same* session. A rewind reports itself here too,
            // and it replaces nothing: the conversation on screen is still this
            // conversation, minus a turn at the end. Dropping the transcript and
            // reprinting the header for that would put a second header and a
            // second copy of the whole session into scrollback — so the snapshot
            // is fetched (the store must still re-sync) and [`App::adopt_snapshot`]
            // leaves the one marker the event deserves.
            Update::SessionChanged(changed) => {
                let same_session = self
                    .rendered_history
                    .as_ref()
                    .is_some_and(|(session, _)| *session == changed.descriptor.session_id);
                if same_session {
                    daemon.send(Call::Snapshot);
                    return;
                }
                let name = changed.descriptor.name.clone();
                let reason = changed.reason.to_string();
                self.transcript = Transcript::new(self.theme.clone(), self.width);
                self.store.reset_transcript();
                self.audit(format!("session {reason} · {name}"));
                let model = self.store.model().unwrap_or_default().to_owned();
                let rows = self.transcript.header(&[&name, &model]);
                self.commits.extend(rows);
                daemon.send(Call::Snapshot);
            }
            Update::Unknown(unknown) => {
                // "Never render nothing": an update this build does not model is
                // still a fact about the session, so it gets an audit row.
                self.audit(format!("· {} (not modelled by this build)", unknown.tag));
            }
            Update::TurnResume(_)
            | Update::MessageStart(_)
            | Update::PartStart(_)
            | Update::PartEnd(_)
            | Update::ReasoningItem(_)
            | Update::MessageEnd(_)
            | Update::Context(_)
            | Update::Usage(_)
            | Update::ModelChanged(_) => {}
        }
    }

    // -- children ----------------------------------------------------------

    /// Fold one `agent` update into the two surfaces that show children.
    ///
    /// The strip needs nothing but the store, which already has it. This decides
    /// the other half: whether the transition is *history*. Appearing, finishing
    /// and failing are; `running` and `awaiting_tool` are the present tense, and
    /// the present tense lives in the live region — a row per state change would
    /// mean six children producing thirty rows about nothing having happened.
    fn agent_transition(
        &mut self,
        agent: &wire::AgentUpdate,
        was: Option<&wire::AgentState>,
        now: Instant,
    ) {
        use ui::agent::AgentEvent;
        // A child on screen is a child the strip has room for. Growing the
        // region here is the "appears on demand" half of the anti-jitter rule;
        // shrinking waits for a turn boundary.
        self.agents_shown = true;
        let settled = ui::agent::is_settled(&agent.status);
        if settled && !self.settled.iter().any(|(id, _)| *id == agent.id) {
            self.settled.push((agent.id.clone(), now));
            // Bounded without a clock: a session that spawns thousands of
            // children must not pay for all of them to draw one row, and an
            // entry old enough to be evicted is one whose `✓` expired long ago.
            if self.settled.len() > SETTLED_MEMORY {
                self.settled.remove(0);
            }
        }

        // A declared transition wins over an inferred one, always: `started` and
        // `revived` are both `running`, so a status diff *cannot* recover the
        // difference between them, and a revival read as "no transition" prints
        // nothing and then a second `✓` row with no account of why the child ran
        // twice. Absent — an older daemon — and the diff is all there is.
        let kind = match &agent.event {
            Some(declared) => declared_row(declared),
            None => inferred_row(&agent.status, was),
        };
        let Some(kind) = kind else { return };
        let rows = self.transcript.agent(AgentEvent {
            kind,
            name: agent_name(agent),
            detail: agent_detail(kind, agent),
        });
        self.commits.extend(rows);
    }

    /// The children the strip should draw right now.
    ///
    /// A finished child keeps its `✓` for [`ui::agent::SETTLED_LINGER`] and then
    /// leaves — the row itself does not, which is what keeps the strip from
    /// flickering out from under a turn that is still running.
    fn presence(&self, now: Instant) -> Vec<ui::agent::Presence> {
        self.store
            .agents()
            .iter()
            .filter(|agent| {
                if !ui::agent::is_settled(&agent.status) {
                    return true;
                }
                // A child that was already finished when this client attached
                // has no settle instant, and no `✓` it earned on screen: it is
                // history, not presence, so it never enters the strip at all.
                self.settled
                    .iter()
                    .find(|(id, _)| *id == agent.id)
                    .is_some_and(|(_, at)| {
                        now.saturating_duration_since(*at) < ui::agent::SETTLED_LINGER
                    })
            })
            .map(|agent| ui::agent::Presence {
                name: agent_name(agent),
                state: agent.status.clone(),
            })
            .collect()
    }

    /// Whether a settled child is still counting out its linger, so the loop
    /// keeps repainting until the strip has actually let go of it.
    fn agents_lingering(&self, now: Instant) -> bool {
        self.settled
            .iter()
            .any(|(_, at)| now.saturating_duration_since(*at) < ui::agent::SETTLED_LINGER)
    }

    fn turn_ended(&mut self, end: &wire::TurnEnd, daemon: &mut dyn Daemon) {
        let rows = self.transcript.turn_end(end.status.as_str());
        self.commits.extend(rows);
        self.commits.push(Row::blank());
        self.in_flight = None;
        self.last_activity = None;
        self.running_tool = None;
        // The turn boundary is the only place the presence strip is allowed to
        // shrink (DESIGN.md §3: chrome must not collapse 0↔1 mid-stream).
        self.agents_shown = self
            .store
            .agents()
            .iter()
            .any(|agent| !ui::agent::is_settled(&agent.status));
        // A turn is what puts checkpoints on disk, so this is when the rewind
        // rung's answer goes stale.
        daemon.send(Call::Checkpoints {
            limit: CHECKPOINT_PAGE,
            why: Rewind::Refresh,
        });
        // DESIGN.md §0.2: the queue auto-submits at turn end — one entry, so two
        // separate `Enter`s stay two separate turns.
        if end.status == wire::TurnStatus::Cancelled {
            self.queue.turn_cancelled();
            return;
        }
        if let QueueEffect::Send(submission) = self.queue.turn_ended() {
            self.send(submission, daemon);
        }
    }

    /// Fold in an answer to a call this app made.
    ///
    /// No answer here is a question: `provider/add` used to be followed by a
    /// `session/select_provider` this client issued on the user's behalf, and
    /// that is exactly what the provider/model split removed — adding is not
    /// switching, `/model` switches, and this method therefore needs no wire.
    pub fn handle_reply(&mut self, reply: &Reply) {
        match (&reply.call, &reply.outcome) {
            (Call::Command(line), Ok(value)) => {
                let declared = self.result_kind(line);
                // `/review` is the one command whose answer belongs *in* the
                // transcript rather than beside it: its rows are file rows, and
                // a file row is a thing `Tab` expands. Everything else is a
                // report and goes straight to scrollback.
                if self.render_review(value, declared.as_deref()) {
                    return;
                }
                let rows = ui::results::render(
                    &self.theme,
                    self.width,
                    line,
                    declared.as_deref(),
                    value,
                );
                self.commits.extend(rows);
            }
            (Call::Checkpoints { why, .. }, outcome) => {
                self.adopt_checkpoints(*why, outcome.as_ref());
            }
            (Call::Restore { force, .. }, outcome) => self.adopt_restored(*force, outcome.as_ref()),
            (Call::Rewind { .. }, outcome) => self.adopt_rewound(outcome.as_ref()),
            (Call::Commands, Ok(value)) => self.adopt_commands(value),
            // An optional capability. A daemon that does not declare its
            // commands leaves the built-in list standing, and an error row for
            // that would be noise about something the user cannot act on.
            (Call::Commands, Err(_)) => {}
            (Call::Complete { query, .. }, Ok(value)) => self.adopt_completions(query, value),
            // Likewise: a popup that cannot open is not worth a transcript row.
            (Call::Complete { .. }, Err(_)) => {}
            (Call::Models, Ok(value)) => self.fill(OverlayKind::Model, model_choices(value)),
            // One answer, two possible readers: the `/model add` form wants the
            // list as options, and the `/provider` picker wants it as rows.
            (Call::Providers, Ok(value)) => {
                if !self.adopt_model_providers(value) {
                    self.fill_providers(value);
                }
            }
            (Call::Sessions, Ok(value)) => {
                self.fill(OverlayKind::Sessions, session_choices(value, now_ms()));
            }
            // The form's four, each of which lands *inside* the panel rather
            // than in scrollback: a message about a form belongs on the form.
            (Call::ProviderSetupOptions, outcome) => self.adopt_setup_options(outcome.as_ref()),
            (Call::ProviderDetect(probed), outcome) => {
                self.adopt_detect(probed, outcome.as_ref());
            }
            (Call::ProviderVerify(probed), outcome) => {
                self.adopt_verify(probed, outcome.as_ref());
            }
            (Call::ProviderAdd(_), outcome) => self.adopt_added(outcome.as_ref()),
            (Call::ProviderGet { provider, purpose }, outcome) => {
                self.adopt_provider_info(provider, *purpose, outcome.as_ref());
            }
            (Call::ProviderRemove(params), outcome) => {
                self.adopt_removed(params, outcome.as_ref());
            }
            (Call::ModelAdd { .. }, outcome) => self.adopt_model_added(outcome.as_ref()),
            (Call::SelectModel(_) | Call::SelectProvider { .. }, Ok(value)) => {
                let provider = value.get("provider").and_then(Value::as_str).unwrap_or("");
                let model = value.get("model").and_then(Value::as_str).unwrap_or("");
                self.audit(format!("model · {provider} {model}").trim_end().to_owned());
            }
            // A load answers with a descriptor and nothing else. The conversation
            // arrives through the `session/snapshot` that `session_changed`
            // triggers, which is also the path a fork and a new session take.
            (Call::LoadSession(name), Ok(_)) => self.audit(format!("session · {name}")),
            (Call::Snapshot, Ok(value)) => {
                match serde_json::from_value::<wire::SessionSnapshot>(value.clone()) {
                    Ok(snapshot) => self.adopt_snapshot(&snapshot),
                    // "Never render nothing": a session that loaded but cannot be
                    // shown has to say so, or it is indistinguishable from an
                    // empty session.
                    Err(error) => self.error(format!(
                        "{}: {error}",
                        wire::method::SESSION_SNAPSHOT
                    )),
                }
            }
            (Call::Prompt(_), Err(detail)) => {
                // The turn will never emit `turn_end`, so nothing else would
                // ever put the queue back to idle.
                self.error(detail.clone());
                self.queue.turn_cancelled();
            }
            (call, Err(detail)) => self.error(format!("{}: {detail}", call.method())),
            (Call::Steer(_) | Call::Cancel { .. } | Call::Prompt(_), Ok(_)) => {}
        }
    }

    /// Render a `/review` answer **through the transcript**, so `Tab` expands
    /// its last file the way it expands the last tool call.
    ///
    /// Returns whether it handled the payload. A review's file rows are DESIGN.md
    /// §3's collapsed grammar — `▸ modified src/auth.ts +12 −4` with the patch
    /// underneath — and that grammar is a transcript entry, not a block of rows
    /// dropped into scrollback: an entry survives a purge resize at the new
    /// width, and only an entry can be expanded after the fact.
    fn render_review(&mut self, value: &Value, declared: Option<&str>) -> bool {
        let kind = value
            .get("resultKind")
            .and_then(Value::as_str)
            .or(declared)
            .map(|kind| kind.trim_end_matches("Result"));
        if kind != Some("review") || value.get("error").is_some() {
            return false;
        }
        let Some(payload) = value.get("output") else {
            return false;
        };
        let mut rows = ui::results::review_summary(&self.theme, self.width, payload);
        for view in ui::results::review_files(payload) {
            rows.extend(self.transcript.tool(view));
        }
        rows.extend(ui::results::review_agents(&self.theme, self.width, payload));
        rows.push(Row::blank());
        self.commits.extend(rows);
        true
    }

    /// The renderer the command registry declared for a command's answer.
    fn result_kind(&self, line: &str) -> Option<String> {
        let name = line.trim_start_matches('/').split_whitespace().next()?;
        self.commands
            .iter()
            .find(|spec| spec.name == name)?
            .result_kind
            .clone()
    }

    /// Fill the provider picker, in whichever mode it was opened in.
    ///
    /// One answer, three lists: only the menu mode offers "add a provider", and
    /// only it is the picker someone opens to look around rather than to act on
    /// a name they already have in mind.
    fn fill_providers(&mut self, value: &Value) {
        let Some(open) = &self.overlay else { return };
        let OverlayKind::Provider(pick) = open.kind else {
            return;
        };
        self.fill(OverlayKind::Provider(pick), provider_choices(value, pick));
    }

    /// Fold in `provider/get`, for whichever surface asked for it.
    ///
    /// A failure is reported where the surface is: the menu and the confirmation
    /// stay open with the rows they have (the actions still work — the answer was
    /// context, not a gate), and the edit form is closed by
    /// [`App::adopt_edit_info`], which cannot pre-fill anything without it.
    fn adopt_provider_info(
        &mut self,
        provider: &str,
        purpose: Purpose,
        outcome: Result<&Value, &String>,
    ) {
        let decoded = match outcome {
            Ok(value) => serde_json::from_value::<wire::ProviderInfo>(value.clone())
                .map_err(|error| error.to_string()),
            Err(detail) => Err((*detail).clone()),
        };
        let info = match decoded {
            Ok(info) => info,
            Err(detail) => {
                if purpose == Purpose::Edit {
                    self.close_setup();
                }
                self.error(format!("{}: {detail}", wire::method::PROVIDER_GET));
                return;
            }
        };
        match purpose {
            Purpose::Menu => {
                let Some(open) = &mut self.overlay else { return };
                if open.kind != OverlayKind::ProviderMenu(provider.to_owned()) {
                    return;
                }
                let items = menu_choices(provider, Some(&info));
                if let Some(select) = open.panel.as_select_mut() {
                    let at = select.selected();
                    select.set_items(items);
                    for _ in 0..at {
                        select.next();
                    }
                }
            }
            Purpose::Edit => self.adopt_edit_info(&info),
            Purpose::Delete => {
                if self
                    .confirm
                    .as_ref()
                    .is_none_or(|state| state.provider != provider)
                {
                    return;
                }
                if let Some(state) = &mut self.confirm {
                    state.info = Some(info);
                }
                self.refresh_confirm();
            }
        }
    }

    /// Fold in `provider/remove`.
    ///
    /// The refusal is the interesting half: the daemon will not remove the
    /// provider the live session is on, and "it is in use" is only actionable
    /// paired with what to do about it — which is why [`App::confirm`] outlives
    /// its panel long enough to know that this was that provider.
    fn adopt_removed(&mut self, params: &wire::RemoveProviderParams, outcome: Result<&Value, &String>) {
        let in_use = self
            .confirm
            .take()
            .and_then(|state| state.info)
            .is_some_and(|info| info.in_use);
        let decoded = match outcome {
            Ok(value) => serde_json::from_value::<wire::RemoveProviderResult>(value.clone())
                .map_err(|error| error.to_string()),
            Err(detail) => Err((*detail).clone()),
        };
        match decoded {
            Ok(removed) => {
                let style = self.theme.warning();
                self.commits
                    .push(Row::styled(format!("  {}", removed_line(&removed)), style));
            }
            Err(detail) => {
                self.error(format!("{}: {detail}", wire::method::PROVIDER_REMOVE));
                if in_use {
                    self.audit(format!(
                        "{} is the provider in use · /model to switch, then delete it",
                        params.provider
                    ));
                }
            }
        }
    }

    /// Fill a picker, if that picker is still the one on screen.
    ///
    /// A user who dismissed the overlay while the round trip was in flight must
    /// not have it reappear under them.
    fn fill(&mut self, kind: OverlayKind, items: Vec<Choice>) {
        let Some(open) = &mut self.overlay else { return };
        if open.kind != kind {
            return;
        }
        if let Some(select) = open.panel.as_select_mut() {
            select.set_items(items);
        }
        self.preview();
    }

    // -- rendering ---------------------------------------------------------

    /// Compose the live region: streaming tail, activity strip, queue, composer,
    /// hints, footer — in that order, bounded to `height` by dropping from the
    /// top, because the bottom is where the caret lives.
    #[must_use]
    pub fn live(&self, height: u16, now: Instant) -> Live {
        let height = usize::from(height.max(MIN_REGION_HEIGHT));
        let width = self.width;
        let mut rows: Vec<Row> = Vec::new();
        // Where the caret goes when a surface other than the composer owns it.
        let mut borrowed_caret: Option<(u16, u16)> = None;

        if let Some(open) = &self.overlay {
            // An overlay is modal: it replaces the streaming tail and the strip
            // rather than being squeezed in beside them. The transcript is not
            // lost — it is in scrollback, where it was printed.
            // The same cap [`App::desired_region_height`] asked the compositor
            // for. Drawing a taller panel than the region was grown to is how a
            // panel loses its own title off the top.
            let budget = height
                .saturating_sub(usize::from(CHROME_ROWS))
                .clamp(1, OVERLAY_ROWS);
            let rendered = ui::overlay::render(&self.theme, &open.panel, width, budget);
            borrowed_caret = rendered.caret;
            rows.extend(rendered.rows);
        } else {
            rows.extend(self.transcript.live_rows());
            rows.push(self.activity_row(now));
            // A transient hint lingers rather than blinking away (DESIGN.md §3).
            if let Some((text, _)) = self
                .notice
                .as_ref()
                .filter(|(_, at)| now.duration_since(*at) < NOTICE_LINGER)
            {
                let style = self.theme.warning();
                rows.push(Row::styled(format!("  {text}"), style));
            }

            let queued: Vec<Submission> = self.queue.entries().cloned().collect();
            rows.extend(ui::queue::render(&self.theme, &queued, width));

            // The presence strip: one chrome row, directly above the queue and
            // the composer, drawn only while `agents_shown` says the region has
            // been grown for it. Between "there are children" and "there is a
            // row" sits the anti-jitter latch — see [`App::agents_shown`].
            if self.agents_shown
                && let Some(strip) = ui::agent::strip(&self.theme, &self.presence(now), width)
            {
                rows.push(strip);
            }

            // The completion popup sits directly above the composer, which is
            // where the text it would insert is.
            let completion = self.composer.completion();
            if completion.is_open() {
                rows.extend(ui::overlay::popup(
                    &self.theme,
                    completion.items(),
                    completion.selected(),
                    width,
                    POPUP_ROWS,
                ));
            }
        }

        let layout = self
            .composer
            .layout(ui::composer::content_width(width), &Known(&self.commands));
        let view = ui::composer::View {
            layout: &layout,
            mode: self.composer.mode(),
            border: ui::composer::BorderState::of(self.composer.mode(), self.turn_running()),
            placeholder: PLACEHOLDER,
            hint: self.esc.hint(),
            max_rows: COMPOSER_ROWS,
        };
        let composer = ui::composer::render(&self.theme, &view, width);
        let composer_top = rows.len();
        rows.extend(composer.rows);

        let stack = self.context_stack();
        rows.push(ui::hints::render(
            &self.theme,
            &self.keymap,
            &stack,
            width,
            |action| self.relabel(action, now),
        ));
        rows.push(ui::footer::render(&self.theme, &self.footer(), width));

        let dropped = rows.len().saturating_sub(height);
        let rows: Vec<Row> = rows.into_iter().skip(dropped).collect();
        let (caret_column, caret_row) = borrowed_caret.map_or_else(
            || {
                (
                    composer.caret.0,
                    (composer_top + usize::from(composer.caret.1)).saturating_sub(dropped),
                )
            },
            |(column, row)| (column, usize::from(row).saturating_sub(dropped)),
        );
        Live {
            rows,
            cursor: (caret_column, u16::try_from(caret_row).unwrap_or(0)),
        }
    }

    /// How tall the live region should be right now.
    ///
    /// `base` is the configured height, which is what an ordinary session uses.
    /// An overlay or a completion popup asks for more — the region is bounded
    /// (DESIGN.md §1), not fixed, and borrowing rows is how a panel is floated
    /// over it without a second rendering mode. Capped at
    /// [`MAX_REGION_HEIGHT`]: an overlay may grow the region, never take the
    /// screen.
    #[must_use]
    pub fn desired_region_height(&self, base: u16) -> u16 {
        // An overlay replaces the streaming tail *and* the presence strip, so it
        // does not pay for a row it is covering. Anything else does: the strip
        // is chrome, and chrome the region was not grown for would be drawn off
        // the top of it.
        let strip = u16::from(self.agents_shown && self.overlay.is_none());
        let panel = if let Some(open) = &self.overlay {
            open.panel.height(OVERLAY_ROWS)
        } else if self.composer.completion().is_open() {
            let listed = self.composer.completion().items().len().min(POPUP_ROWS);
            u16::try_from(listed + 2).unwrap_or(CHROME_ROWS)
        } else {
            0
        };
        base.max(CHROME_ROWS.saturating_add(panel).saturating_add(strip))
            .min(MAX_REGION_HEIGHT)
    }

    /// The one-line activity strip. The glyph spins while work is live and
    /// freezes on stall — the one deliberate motion (see `reliability::Activity`).
    fn activity_row(&self, now: Instant) -> Row {
        let running = self.turn_running();
        let since = self.last_activity.map(|at| now.duration_since(at));
        let activity = Activity::of(running, since, self.working_without_wire());
        let glyph = activity.glyph_at(now.duration_since(self.started));
        Row {
            spans: vec![
                Span::new(format!("{glyph} "), activity.style(&self.theme)),
                Span::new(self.activity_text(running), self.theme.muted()),
            ],
        }
    }

    /// Whether work is provably under way without the wire having to say so.
    ///
    /// Two cases, and both are things the *client* can see:
    ///
    /// - **A tool is running.** Execution is local; a `bash` that takes a minute
    ///   sends nothing until it finishes, and the turn is no less alive for it.
    /// - **A retry is counting down.** The footer is showing a live 1 Hz
    ///   countdown to the next attempt — the pause already has its bracket
    ///   (`ui::reliability`), and freezing the glyph into the warning state
    ///   beside it would say "stuck" about the one pause the surface is
    ///   explaining second by second.
    fn working_without_wire(&self) -> bool {
        self.running_tool.is_some() || matches!(self.store.phase(), crate::state::TurnPhase::Retrying(_))
    }

    fn activity_text(&self, running: bool) -> String {
        use crate::state::TurnPhase;
        // A running tool is the most specific true thing there is to say, and it
        // is tracked from the lifecycle updates rather than rescanned every
        // frame: a long session must not pay for its own length to draw a strip.
        if let Some(label) = &self.running_tool {
            return label.clone();
        }
        match self.store.phase() {
            TurnPhase::Idle => {
                if running {
                    "working".to_owned()
                } else {
                    "ready".to_owned()
                }
            }
            // The spinner already says "tokens are flowing"; a label naming the
            // mechanism said nothing the motion does not.
            TurnPhase::Streaming => String::new(),
            TurnPhase::Retrying(retry) => format!(
                "{} · retry {}/{}",
                retry.classification, retry.attempt, retry.max_attempts
            ),
            TurnPhase::Paused(kind) => format!("paused · {kind}"),
            TurnPhase::Ended(outcome) => match outcome.status {
                wire::TurnStatus::Cancelled => "cancelled · partial output kept".to_owned(),
                wire::TurnStatus::Completed => "ready".to_owned(),
                ref status => format!("done · {status}"),
            },
        }
    }

    /// The footer's numbers, all of them raw from the store, none of them
    /// invented: an absent limit renders as absence, never as a wrong percentage.
    fn footer(&self) -> FooterData {
        let context = self.store.context();
        FooterData {
            model: self.store.model().map(str::to_owned),
            context_used: context.map(|context| context.token_estimate),
            context_limit: context.and_then(|context| context.context_window),
            cost_cents: self
                .store
                .usage()
                .and_then(|usage| usage.cost_micro_usd)
                .map(|micros| micros.div_euclid(10_000)),
            retry: self.store.retry().map(|retry| RetryStatus {
                reason: Some(retry.classification.to_string()),
                attempt: retry.attempt,
                max_attempts: retry.max_attempts,
                seconds_remaining: Some(retry.remaining_secs(epoch_millis())),
            }),
        }
    }

    /// The `Esc` hint is contextual because the ladder is: the key never changes,
    /// only the verb. Asking the ladder itself is what keeps the hint and the
    /// keypress from ever disagreeing.
    fn relabel(&self, action: Action, now: Instant) -> Option<String> {
        if action != Action::Escape {
            return None;
        }
        let peek = EscPeek(self);
        Some(
            match self.esc.peek(&peek, now) {
                EscStep::DismissOverlay | EscStep::DismissCompletion => "dismiss",
                EscStep::ArmComposerClear | EscStep::ClearComposer => "clear",
                EscStep::PopQueue => "unqueue",
                EscStep::CancelTurn => "cancel",
                // Unreachable while `can_rewind` is false; if the daemon ever
                // grows a rewind method the hint appears with it.
                EscStep::ArmRewind | EscStep::Rewind => "rewind",
                // `peek` does not apply the mash grace, so `Swallowed` cannot
                // reach here; it reads as "nothing" for the same reason
                // `Ignored` does.
                EscStep::Ignored | EscStep::Swallowed => return Some(String::new()),
            }
            .to_owned(),
        )
    }

    // -- the Esc ladder's world -------------------------------------------

    fn pop_queue(&mut self) {
        if let Some(entry) = self.queue.pop_last() {
            self.composer.set_text(&entry.text);
        }
    }

    /// Whether the `Esc Esc` rung exists right now.
    ///
    /// A checkpoint list this client has already been given is the whole test.
    /// It is deliberately *not* "the daemon routes `session/rewind`": a daemon
    /// that routes it in a directory with no checkpoint history has nothing to
    /// take the user back to, and offering the gesture there would be the
    /// lying-hint case in a new costume.
    #[must_use]
    pub fn can_rewind(&self) -> bool {
        !self.checkpoints.is_empty()
    }
}

/// Milliseconds since the Unix epoch, for the retry countdown's anchor.
fn epoch_millis() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(0)
}

/// `▸ edit src/auth.ts` — the transcript grammar's collapsed form, for the
/// activity strip.
fn tool_label(tool: &str, summary: Option<&str>) -> String {
    match summary {
        Some(summary) if !summary.is_empty() => format!("▸ {tool} {summary}"),
        _ => format!("▸ {tool}"),
    }
}

/// How many settled children the strip remembers the settle instant of.
///
/// Only the ones inside [`ui::agent::SETTLED_LINGER`] are ever read, and the
/// linger is measured in seconds, so anything past a couple of dozen is already
/// expired. This is the memory bound, not a display limit.
const SETTLED_MEMORY: usize = 32;

/// What to call a child on screen.
///
/// The **peer** name, not the label: a message is addressed to the peer, `/kill`
/// takes the peer, and a strip that showed a friendlier name would be showing
/// one the user cannot then use.
fn agent_name(agent: &wire::AgentUpdate) -> String {
    if agent.peer.trim().is_empty() {
        agent.id.clone()
    } else {
        agent.peer.clone()
    }
}

/// Which row a *declared* transition earns, if any.
///
/// `started` is the one that earns none: a child moving from `queued` to
/// `running` is the present tense, and the present tense is the strip's — the
/// same split the tool grammar makes between the activity strip and the
/// collapsed `▸` row.
fn declared_row(declared: &wire::AgentTransition) -> Option<ui::agent::EventKind> {
    use ui::agent::EventKind;
    match declared {
        wire::AgentTransition::Spawned => Some(EventKind::Spawned),
        wire::AgentTransition::Revived => Some(EventKind::Revived),
        wire::AgentTransition::Completed => Some(EventKind::Finished),
        wire::AgentTransition::Failed
        | wire::AgentTransition::Cancelled
        | wire::AgentTransition::TimedOut => Some(EventKind::Failed),
        // `started`, and a transition a newer daemon invents: the strip already
        // says a child is running, so neither earns an immutable row.
        wire::AgentTransition::Started | wire::AgentTransition::Other(_) => None,
    }
}

/// The same answer for a daemon that predates `agent.event`, recovered from the
/// state the child was in before this update.
///
/// Strictly weaker, and knowably so: a revival is invisible here, because
/// `completed → running` is indistinguishable from a re-report of a child that
/// never stopped. That is the entire reason the declared field exists.
fn inferred_row(
    status: &wire::AgentState,
    was: Option<&wire::AgentState>,
) -> Option<ui::agent::EventKind> {
    use ui::agent::EventKind;
    match (status, was) {
        // Not the same state twice: a daemon that re-reports a child it has
        // already reported must not print a second row about it.
        (status, Some(previous)) if status == previous => None,
        (wire::AgentState::Completed, _) => Some(EventKind::Finished),
        (
            wire::AgentState::Failed | wire::AgentState::TimedOut | wire::AgentState::Cancelled,
            _,
        ) => Some(EventKind::Failed),
        // First sighting, whatever state it arrived in.
        (_, None) => Some(EventKind::Spawned),
        // Every other transition is the strip's, not the transcript's.
        _ => None,
    }
}

/// The right-hand half of a lifecycle row.
///
/// Every part is a measurement the daemon supplied; a field it could not measure
/// is absent rather than zero, so it contributes nothing rather than a `0 files`
/// that reads as a finding.
fn agent_detail(kind: ui::agent::EventKind, agent: &wire::AgentUpdate) -> String {
    use ui::agent::EventKind;
    let mut parts: Vec<String> = Vec::new();
    match kind {
        // A revival says the same things a spawn does: it is the same child
        // starting the same kind of work again, and the model is the fact a
        // reader wants beside either.
        EventKind::Spawned | EventKind::Revived => {
            if let Some(model) = agent.model.as_deref().filter(|model| !model.is_empty()) {
                parts.push(model.to_owned());
            }
            if agent.depth.is_some_and(|depth| depth > 0) {
                parts.push("grandchild".to_owned());
            }
        }
        EventKind::Finished => {
            if let Some(files) = agent.files_modified.filter(|files| *files > 0) {
                parts.push(format!("{files} {}", if files == 1 { "file" } else { "files" }));
            }
            if let Some(calls) = agent.tool_calls.filter(|calls| *calls > 0) {
                parts.push(format!(
                    "{calls} tool {}",
                    if calls == 1 { "call" } else { "calls" }
                ));
            }
        }
        EventKind::Failed => {
            parts.push(match agent.status {
                wire::AgentState::TimedOut => "timed out".to_owned(),
                wire::AgentState::Cancelled => "cancelled".to_owned(),
                _ => "failed".to_owned(),
            });
            if let Some(error) = agent.error.as_deref().filter(|error| !error.is_empty()) {
                parts.push(error.to_owned());
            }
            // The one row a user has to *do* something about carries where to go.
            parts.push("/agents".to_owned());
        }
    }
    parts.join(" · ")
}

/// A loop warning, in one line of prose.
fn loop_detail(warning: &wire::LoopWarning) -> String {
    match &warning.kind {
        wire::LoopWarningKind::IdenticalToolCall => format!(
            "{} repeated {} times",
            warning.tool.as_deref().unwrap_or("the same call"),
            warning.count.unwrap_or(0)
        ),
        wire::LoopWarningKind::NoProgress => {
            format!("{} turns without progress", warning.turns.unwrap_or(0))
        }
        wire::LoopWarningKind::Oscillation => format!(
            "{} flipped back and forth",
            warning.path.as_deref().unwrap_or("a path")
        ),
        other => other.to_string(),
    }
}

/// The slash commands this build knows before `session/commands` answers.
///
/// The registry is hydrated from the daemon, but `/` must work on the first
/// keystroke of a session and on a daemon that never declares one, so the list
/// starts here and is replaced, not merged into.
fn default_commands() -> Vec<CommandSpec> {
    SLASH_COMMANDS
        .iter()
        .map(|name| CommandSpec::bare(name, ""))
        .chain(
            CLIENT_COMMANDS
                .iter()
                .map(|(name, description)| CommandSpec::bare(name, description)),
        )
        .collect()
}

/// A non-empty string field.
fn text_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|text| !text.is_empty())
}

/// `session/models` as picker rows, in **either** shape it arrives in.
///
/// The daemon's answer now spans every configured provider
/// (`{current, providers: [{provider, models}]}`), which is what makes `/model`
/// the one switching surface: a model is a `provider/model` reference and
/// choosing one is a provider switch when it needs to be.
///
/// The rows are **provider-prefixed rather than grouped under headers**. A
/// header row would have to be a [`Choice`] that cannot be chosen — a second
/// kind of row in a widget whose entire contract is "every row is selectable" —
/// and it would filter and rank as a row too. The prefix carries the same
/// grouping (the daemon's order keeps a provider's models adjacent), survives
/// filtering, and *is* the reference that goes back on the wire.
///
/// The old flat shape (`{provider, current, models}`) still renders: bare ids,
/// exactly as before, because that is what such a daemon will accept back.
fn model_choices(value: &Value) -> Vec<Choice> {
    let current = value.get("current").and_then(Value::as_str).unwrap_or("");
    let one = |model: &Value, provider: Option<&str>| {
        let id = text_field(model, "id")?;
        let reference = match provider {
            Some(provider) => format!("{provider}/{id}"),
            None => id,
        };
        let mut detail = Vec::new();
        if let Some(owner) = text_field(model, "ownedBy") {
            detail.push(owner);
        }
        // Raw measurement, no invented percentage (DESIGN.md §2).
        if let Some(window) = model.get("contextWindow").and_then(Value::as_u64) {
            detail.push(format!("{}k ctx", window / 1000));
        }
        let current = reference == current;
        Some(
            Choice::new(reference)
                .with_detail(detail.join(" · "))
                .current(current),
        )
    };

    if let Some(providers) = value.get("providers").and_then(Value::as_array) {
        return providers
            .iter()
            .flat_map(|entry| {
                let provider = text_field(entry, "provider").unwrap_or_default();
                entry
                    .get("models")
                    .and_then(Value::as_array)
                    .map(|models| {
                        models
                            .iter()
                            .filter_map(|model| one(model, Some(&provider)))
                            .collect::<Vec<Choice>>()
                    })
                    .unwrap_or_default()
            })
            .collect();
    }
    value
        .get("models")
        .and_then(Value::as_array)
        .map(|models| models.iter().filter_map(|model| one(model, None)).collect())
        .unwrap_or_default()
}

/// The values of the per-provider menu's rows. Not labels: the label carries
/// the provider's name and the value is what the accept path matches on.
mod menu {
    /// `session/select_provider`, exactly as accepting a provider row used to.
    pub const SWITCH: &str = "provider:switch";
    /// Open the edit form.
    pub const EDIT: &str = "provider:edit";
    /// Open the delete confirmation.
    pub const DELETE: &str = "provider:delete";
}

/// The values of the rewind confirmation's rows.
mod rewind_row {
    /// `session/rewind` alone: the head moves, the files do not.
    pub const CONVERSATION: &str = "rewind:conversation";
    /// `session/rewind` then `checkpoint/restore`.
    pub const BOTH: &str = "rewind:both";
    /// `checkpoint/restore` alone, for a checkpoint that anchors no entry.
    pub const CODE: &str = "rewind:code";
    /// Re-run the restore with `force`, once preserved files exist.
    pub const FORCE: &str = "rewind:force";
    /// Flip `force` and stay open.
    pub const TOGGLE: &str = "rewind:toggle";
    /// Close, having done nothing.
    pub const CANCEL: &str = "rewind:cancel";
}

/// The panel title, which is the only thing saying which of the two questions
/// the confirmation is asking.
fn rewind_title(state: &RewindConfirm) -> String {
    if state.preserved.is_empty() {
        format!("rewind to {}?", state.checkpoint.title())
    } else {
        format!(
            "{} {} left untouched",
            state.preserved.len(),
            if state.preserved.len() == 1 {
                "file"
            } else {
                "files"
            }
        )
    }
}

/// `checkpoint/list` as picker rows.
///
/// The label names the moment and the detail carries the three facts that tell
/// one checkpoint from another: when, how much moved, and whether the
/// conversation can come back with it. A checkpoint that anchors no transcript
/// entry says so, because choosing it is a narrower operation.
fn checkpoint_choices(checkpoints: &[wire::Checkpoint]) -> Vec<Choice> {
    checkpoints
        .iter()
        .map(|checkpoint| {
            let mut detail: Vec<String> = Vec::new();
            if !checkpoint.created_at.is_empty() {
                detail.push(checkpoint.created_at.clone());
            }
            detail.push(checkpoint.kind.to_string().replace('_', " "));
            detail.push(format!(
                "{} {}",
                checkpoint.changed_files,
                if checkpoint.changed_files == 1 {
                    "file"
                } else {
                    "files"
                }
            ));
            if checkpoint.anchored().is_none() {
                detail.push("code only".to_owned());
            }
            Choice::valued(checkpoint.id.clone(), checkpoint.title().to_owned())
                .with_detail(detail.join(" · "))
        })
        .collect()
}

/// The rewind confirmation's rows, in whichever of its two states it is in.
///
/// **Before a restore** the question is how much to take back. **After one** the
/// question is whether to override the never-clobber rule, and that row exists
/// only because the rule has already reported refusing something — this client
/// never offers a `--force` for files it has no evidence exist.
fn rewind_choices(state: &RewindConfirm) -> Vec<Choice> {
    let changed = format!(
        "{} {} changed",
        state.checkpoint.changed_files,
        if state.checkpoint.changed_files == 1 {
            "file"
        } else {
            "files"
        }
    );
    if state.preserved.is_empty() {
        let mut choices = Vec::new();
        if state.anchored().is_some() {
            choices.push(
                Choice::valued(rewind_row::CONVERSATION, "conversation only")
                    .with_detail("the transcript head moves; nothing on disk is touched"),
            );
            choices.push(
                Choice::valued(rewind_row::BOTH, "conversation and code")
                    .with_detail(format!("{changed} · files you changed yourself are kept")),
            );
        } else {
            choices.push(
                Choice::valued(rewind_row::CODE, "code only")
                    .with_detail(format!(
                        "{changed} · this checkpoint anchors no transcript entry"
                    )),
            );
        }
        choices.push(Choice::valued(rewind_row::CANCEL, "cancel").with_detail("change nothing"));
        return choices;
    }

    let named: Vec<&str> = state
        .preserved
        .iter()
        .map(String::as_str)
        .take(PRESERVED_NAMED)
        .collect();
    let mut names = named.join(", ");
    if state.preserved.len() > named.len() {
        names.push_str(&format!(" +{} more", state.preserved.len() - named.len()));
    }
    vec![
        Choice::valued(rewind_row::CANCEL, "keep them")
            .with_detail(format!("Lyra never wrote these · {names}")),
        Choice::valued(
            rewind_row::TOGGLE,
            format!(
                "[{}] revert them too",
                if state.force { '×' } else { ' ' }
            ),
        )
        .with_detail("this discards edits Lyra did not make"),
        Choice::valued(rewind_row::FORCE, "restore again")
            .with_detail(if state.force {
                "with --force"
            } else {
                "without --force · nothing more will change"
            }),
    ]
}

/// What a restore commits to scrollback.
///
/// Counts first, then the safety checkpoint that undoes it, then the preserved
/// files **by name** — that last one is the never-clobber rule made legible, and
/// a count alone would not be.
fn restore_lines(restored: &wire::CheckpointRestoreResult) -> Vec<String> {
    let mut lines = vec![format!(
        "restored {} {} to {} · undo with /rollback {}",
        restored.restored.len(),
        if restored.restored.len() == 1 {
            "file"
        } else {
            "files"
        },
        restored.target.title(),
        restored.safety.id
    )];
    if !restored.preserved.is_empty() {
        let named: Vec<&str> = restored
            .preserved
            .iter()
            .map(String::as_str)
            .take(PRESERVED_NAMED)
            .collect();
        let mut line = format!(
            "kept {} {} Lyra did not write: {}",
            restored.preserved.len(),
            if restored.preserved.len() == 1 {
                "file"
            } else {
                "files"
            },
            named.join(", ")
        );
        if restored.preserved.len() > named.len() {
            line.push_str(&format!(" +{} more", restored.preserved.len() - named.len()));
        }
        lines.push(line);
    }
    if !restored.excluded.is_empty() {
        lines.push(format!(
            "outside the snapshot, untouched: {}",
            restored.excluded.join(", ")
        ));
    }
    lines
}

/// The values of the delete confirmation's rows.
mod confirm {
    /// Send `provider/remove`.
    pub const REMOVE: &str = "confirm:remove";
    /// Flip `removeCredential` and stay open.
    pub const TOGGLE: &str = "confirm:credential";
    /// Close, having done nothing.
    pub const CANCEL: &str = "confirm:cancel";
}

/// `session/providers` as picker rows.
///
/// In [`Pick::Menu`] the list ends with the row that opens the setup wizard —
/// the picker is where someone looks for a provider that is not configured yet,
/// so the way to add one lives in the list itself rather than only behind
/// `/provider add` and the palette. A list opened to *edit* or *delete* a
/// provider offers no such row: there is nothing to edit about a provider that
/// does not exist.
fn provider_choices(value: &Value, pick: Pick) -> Vec<Choice> {
    let current = value.get("current").and_then(Value::as_str).unwrap_or("");
    let mut choices: Vec<Choice> = value
        .get("available")
        .and_then(Value::as_array)
        .map(|available| {
            available
                .iter()
                .filter_map(Value::as_str)
                .map(|name| {
                    Choice::new(name)
                        .current(name == current)
                        // Said once, on the row that is already highlighted:
                        // this picker changes the provider, and the models of
                        // every provider are one list away.
                        .with_detail(match (name == current, pick) {
                            (true, Pick::Menu) => "current · /model switches models",
                            // The one row a removal will be refused for, said
                            // before the refusal rather than after it.
                            (true, Pick::Delete) => "in use · /model to switch first",
                            (true, Pick::Edit) => "current",
                            (false, _) => "",
                        })
                })
                .collect()
        })
        .unwrap_or_default();
    if pick == Pick::Menu {
        choices.push(
            Choice::valued(setup::PALETTE_VALUE, "+ add a provider…")
                .with_detail("endpoint, protocol and credential"),
        );
    }
    choices
}

/// The per-provider menu's rows: switch, edit, delete.
///
/// `info` is what `provider/get` said, which is absent for the frame or two
/// before it answers. The rows exist either way — the actions do not depend on
/// the answer — and grow their right-hand column when it lands. The endpoint and
/// protocol ride on the switch row because it is the row the menu opens on, so
/// what the menu is *about* is on the line already highlighted.
fn menu_choices(provider: &str, info: Option<&wire::ProviderInfo>) -> Vec<Choice> {
    let context = info.map(|info| format!("{} · {}", info.base_url, info.api_type));
    let credential = info.map(wire::ProviderInfo::auth_summary);
    vec![
        Choice::valued(menu::SWITCH, format!("switch to {provider}"))
            .with_detail(context.unwrap_or_else(|| "/model switches the model too".to_owned())),
        Choice::valued(menu::EDIT, format!("edit {provider}"))
            .with_detail("endpoint, protocol and credential"),
        Choice::valued(menu::DELETE, format!("delete {provider}"))
            .with_detail(credential.map_or_else(String::new, |source| format!("credential · {source}"))),
    ]
}

/// The delete confirmation's rows.
///
/// A checkbox as a row, because this widget has exactly one kind of row and a
/// second kind would have to be unselectable — see [`model_choices`] for the
/// same argument about headers. The toggle exists only where the daemon can
/// actually delete something ([`wire::ProviderInfo::removable_credential`]); a
/// token that lives *inside* the declaration being removed goes either way, and
/// the delete row says so instead of pretending there is a choice.
fn confirm_choices(state: &Confirm) -> Vec<Choice> {
    let endpoint = state.info.as_ref().map_or_else(String::new, |info| {
        if info.credential_goes_with_it() {
            format!("{} · its token goes with it", info.base_url)
        } else {
            format!("{} · {}", info.base_url, info.api_type)
        }
    });
    let mut choices = vec![Choice::valued(
        confirm::REMOVE,
        format!("delete {}", state.provider),
    )
    .with_detail(endpoint)];
    if state.toggleable() {
        let source = state
            .info
            .as_ref()
            .map_or_else(String::new, wire::ProviderInfo::auth_summary);
        choices.push(
            Choice::valued(
                confirm::TOGGLE,
                format!(
                    "[{}] also remove the stored credential",
                    if state.remove_credential { '×' } else { ' ' }
                ),
            )
            .with_detail(source),
        );
    }
    choices.push(Choice::valued(confirm::CANCEL, "cancel").with_detail("keep it"));
    choices
}

/// The one line a removal commits.
///
/// Three facts, in the order they matter: what is gone, whether its credential
/// went with it, and what still refers to it. A dangling role is the only one of
/// the three the user has to *do* something about, so it carries the way to.
fn removed_line(removed: &wire::RemoveProviderResult) -> String {
    let mut line = format!("provider removed · {}", removed.provider);
    match removed.credential_removed {
        Some(true) => line.push_str(" · credential removed"),
        // Present at all means it was asked for. `false` is therefore not "kept"
        // — it is "there was nothing under that keychain entry", which is the
        // end state that was asked for, reached without deleting anything.
        Some(false) => line.push_str(" · no credential was stored"),
        None => {}
    }
    if !removed.dangling_roles.is_empty() {
        line.push_str(&format!(
            " · roles still name it: {} — /model to repoint",
            removed.dangling_roles.join(", ")
        ));
    }
    line
}

/// `session/list` as picker rows.
///
/// The row a user is choosing between is a *session*, and `session-msmd172h` is
/// not a session — it is a filename. So the label is the name and the detail is
/// the three facts that tell one transcript from another: when it was last
/// touched, how big it is, and what it was about.
///
/// Every one of the three is optional on the wire, and an old daemon sends none
/// of them. A row with nothing to say falls back to its path, which is what the
/// picker showed before there was anything better.
fn session_choices(value: &Value, now_ms: i64) -> Vec<Choice> {
    value
        .as_array()
        .or_else(|| value.get("sessions")?.as_array())
        .map(|sessions| {
            sessions
                .iter()
                .filter_map(|session| {
                    let name = text_field(session, "name")?;
                    let active = session.get("active").and_then(Value::as_bool) == Some(true);
                    Some(
                        Choice::new(name)
                            .with_detail(session_detail(session, now_ms))
                            .current(active),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The right-hand column of a session row: `2h ago · 34 msgs · fix the retry ladder`.
fn session_detail(session: &Value, now_ms: i64) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(updated) = session.get("updatedAtMs").and_then(Value::as_i64) {
        parts.push(relative_time(now_ms, updated));
    }
    if let Some(messages) = session.get("messages").and_then(Value::as_u64) {
        parts.push(format!("{messages} msg{}", if messages == 1 { "" } else { "s" }));
    }
    if let Some(prompt) = text_field(session, "firstPrompt") {
        parts.push(prompt);
    }
    if parts.is_empty() {
        return text_field(session, "path").unwrap_or_default();
    }
    parts.join(" · ")
}

/// A coarse "how long ago", derived here because the wire carries the raw instant
/// (DESIGN.md §2). Coarse on purpose: a picker row wants "yesterday-ish", and a
/// second-accurate age would change under the user's cursor for no benefit.
#[must_use]
pub fn relative_time(now_ms: i64, then_ms: i64) -> String {
    let seconds = (now_ms - then_ms).div_euclid(1000);
    // A clock that disagrees with the daemon's — or a file written during this
    // very frame — must not produce "-1s ago".
    if seconds < 60 {
        return "just now".to_owned();
    }
    for (limit, divisor, unit) in [
        (3_600, 60, "m"),
        (86_400, 3_600, "h"),
        (604_800, 86_400, "d"),
        (2_592_000, 604_800, "w"),
    ] {
        if seconds < limit {
            return format!("{}{unit} ago", seconds / divisor);
        }
    }
    format!("{}mo ago", (seconds / 2_592_000).max(1))
}

/// Wall-clock milliseconds, or 0 if the clock predates the epoch.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| i64::try_from(since.as_millis()).unwrap_or(i64::MAX))
}

/// The ladder's read-only view, for [`EscLadder::peek`]. The mutators are
/// unreachable — `peek` resolves without acting — and say so rather than
/// pretending to work.
struct EscPeek<'a>(&'a App);

impl EscWorld for EscPeek<'_> {
    fn overlay_open(&self) -> bool {
        self.0.overlay.is_some()
    }
    fn dismiss_overlay(&mut self) {}
    fn completion_open(&self) -> bool {
        self.0.composer.completion().is_open()
    }
    fn dismiss_completion(&mut self) {}
    fn composer_is_empty(&self) -> bool {
        self.0.composer.is_empty()
    }
    fn clear_composer(&mut self) {}
    fn queue_depth(&self) -> usize {
        self.0.queue.depth()
    }
    fn pop_queue_into_composer(&mut self) {}
    fn turn_running(&self) -> bool {
        self.0.turn_running()
    }
    fn cancel_turn(&mut self) {}
    fn can_rewind(&self) -> bool {
        self.0.can_rewind()
    }
    fn rewind(&mut self) {}
}

/// The ladder's acting view: the app plus the wire it needs to cancel on.
struct EscView<'a> {
    app: &'a mut App,
    daemon: &'a mut dyn Daemon,
}

impl EscWorld for EscView<'_> {
    fn overlay_open(&self) -> bool {
        self.app.overlay.is_some()
    }
    fn dismiss_overlay(&mut self) {
        self.app.close_overlay();
    }
    fn completion_open(&self) -> bool {
        self.app.composer.completion().is_open()
    }
    fn dismiss_completion(&mut self) {
        self.app.composer.completion_mut().dismiss();
    }
    fn composer_is_empty(&self) -> bool {
        self.app.composer.is_empty()
    }
    fn clear_composer(&mut self) {
        self.app.composer.clear();
    }
    fn queue_depth(&self) -> usize {
        self.app.queue.depth()
    }
    fn pop_queue_into_composer(&mut self) {
        self.app.pop_queue();
    }
    fn turn_running(&self) -> bool {
        self.app.turn_running()
    }
    fn cancel_turn(&mut self) {
        self.app.cancel_turn(self.daemon);
    }
    /// Whether there is anything to go back *to*. Answered from the cached
    /// checkpoint list, without a round trip, because the `Esc` hint asks this
    /// every frame — and a hint that had to wait for the daemon would be a hint
    /// that lied for a round trip.
    fn can_rewind(&self) -> bool {
        self.app.can_rewind()
    }
    fn rewind(&mut self) {
        self.app.begin_rewind(self.daemon);
    }
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/// One frame's worth of work, in DESIGN.md's order.
///
/// 1. **Every** pending input event, routed. Nothing here waits on the daemon,
///    so a keystroke's latency is the frame budget and nothing else.
/// 2. The ACP event burst, coalesced into this frame and capped at
///    [`MAX_EVENTS_PER_TICK`] so the next tick's input cannot be starved.
/// 3. Answers to calls this app made.
///
/// Rendering is the caller's: it owns the compositor, and this function is what
/// the tests drive.
pub fn tick(
    app: &mut App,
    daemon: &mut dyn Daemon,
    input: impl IntoIterator<Item = InputEvent>,
    events: &Receiver<AcpEvent>,
    now: Instant,
) {
    for event in input {
        app.handle_input(event, daemon, now);
    }
    // After input, so a settled `@` query goes out in the same frame the last
    // keystroke of it did; before the drain, so it is not stuck behind a burst.
    app.flush_completion(daemon, now);
    for _ in 0..MAX_EVENTS_PER_TICK {
        match events.try_recv() {
            Ok(event) => app.handle_event(event, daemon, now),
            Err(_) => break,
        }
    }
    let replies = daemon.poll();
    for reply in &replies {
        app.handle_reply(reply);
    }
}

impl ReplaySource for App {
    fn replay_rows(&mut self, width: u16, cap: usize) -> Vec<Row> {
        self.transcript.replay_rows(width, cap)
    }
}

mod history;
mod setup;

#[cfg(test)]
mod tests;
