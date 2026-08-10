//! The provider form: the only flow in this client that runs **before there is
//! a provider**, and the only one that touches a credential. Plus its small
//! sibling, the `/model add` form.
//!
//! # Why it is a client flow at all
//!
//! `cli.ts` launches the TUI even when nothing is configured, and the daemon
//! boots unconfigured on purpose: `session/snapshot` says
//! `providerConfigured: false`, every non-provider method still works, and a
//! prompt is refused until `provider/add` runs. So the first screen a new user
//! sees is this, not a composer they would only be typing into a refusal.
//!
//! # The shape
//!
//! ```text
//!                 ┌─ provider/setup_options ─┐  (labels, persistence, path)
//! endpoint ──tab──┤                          ├──▶ one form ──enter──▶ provider/add ×N
//!                 └─ provider/detect ────────┘                              │
//!                       (protocol, name, auth)          "N models discovered" ◀┘
//! ```
//!
//! **There is no preset step.** A preset was a guess about which of a dozen
//! vendors a user meant, asked before the one question that answers it: what is
//! at this endpoint. So the endpoint is the first field, leaving it interrogates
//! the endpoint, and the protocol and the name come back filled in. Detection is
//! a convenience and never a gate — an endpoint that says nothing leaves the
//! protocol field empty with a note, and the user picks.
//!
//! Five properties are deliberate:
//!
//! - **Nothing blocks.** Detect, verify and add are ordinary fire-and-forget
//!   calls; the deadline on a probe is the daemon's, and the form stays editable
//!   while one is in flight. A wizard that froze the terminal waiting on an
//!   unreachable endpoint is the failure this replaces.
//! - **The protocol is concrete.** `openai_responses`, `openai_completions` or
//!   `anthropic_messages` — never a stored "auto". Detection *chooses* one; it
//!   does not defer the choice to every future request.
//! - **There is no model field.** Discovery is the daemon's job, and asking a
//!   user to type a model id before they have seen the list is asking them to
//!   guess. `provider/add` answers with how many models it found, and that
//!   answer is the one line this flow commits.
//! - **Adding never switches.** `provider/add` and `session/select_provider` are
//!   separate in the protocol and separate here: `/model` is the switching
//!   surface, across every configured provider.
//! - **A hidden field is an absent field.** `persist: env` hides the API-key
//!   field, and [`Form::secret_value`] answers `None` for a hidden field, so the
//!   request the daemon would reject cannot be built here. The pairing rules are
//!   enforced twice on purpose — once as a UI that does not ask, once as a
//!   validation that does not send.
//!
//! # One endpoint, two protocols
//!
//! A gateway that answers both `/v1/chat/completions` and `/v1/messages` is one
//! URL and two providers, because a provider *is* an (endpoint, protocol) pair
//! everywhere else in Lyra. When detection reports two or more, the form grows
//! one row per extra protocol, pre-filled with a suffixed name (`local` →
//! `local-anthropic`). The name is editable and clearing it skips that protocol,
//! so the default is "save what I found" and the escape hatch is one `Ctrl+U`.
//!
//! The mechanism was there before the words were, and a mechanism nobody reads
//! as one is not one: the protocol field still *looked* like an either/or, so
//! three lines say the outcome instead of implying it.
//!
//! - The state line counts what will happen — `2 protocols detected — 2
//!   providers will be saved` — and follows every keystroke that changes the
//!   count, so clearing a row says `1 provider will be saved` before the user
//!   has to wonder.
//! - The protocol field's detail says `both detected · this entry`, which is the
//!   sentence that stops the choice reading as a choice *between* them.
//! - Each extra row is labelled `+ provider` and says `second provider ·
//!   Anthropic messages · clear to skip` under itself: what it is, which
//!   protocol it is, and how to decline it.
//!
//! None of it offers "auto" as a protocol, here or anywhere else: detection
//! fills in a concrete value per entry, and the multiplicity lives in the number
//! of entries rather than in a value that defers the choice forever.
//!
//! # Editing is the same form
//!
//! `provider/add` naming a provider that already exists is an **update**, so
//! there is no second form and no second set of rules: [`App::open_provider_edit`]
//! opens *this* form, pre-filled from `provider/get`, and `Enter` sends the same
//! `provider/add`. Three things differ, and all three follow from what an edit
//! is:
//!
//! - **The name is fixed.** A form whose name field is editable would make
//!   renaming look like an edit when it is a create plus a delete — a new
//!   `providers.toml` entry, roles still pointing at the old id, and a keychain
//!   entry under the old account. So the id is shown and not editable, and
//!   renaming is `/provider add` under the new name followed by
//!   `/provider delete` of the old one, which is the two operations it always
//!   was. (The alternative — accept a rename and silently issue add+remove — was
//!   rejected: a one-keystroke `Enter` that deletes something is not what "save"
//!   means anywhere else in this client.)
//! - **An empty key means "keep".** The form cannot show a credential it has
//!   never had, and asking for one to change an endpoint would be a reason to
//!   never change an endpoint. Empty sends [`ProviderPersist::Keep`], which
//!   carries no credential at all; typing one rotates it into whichever
//!   persistence choice is selected.
//! - **There are no second-entry rows.** Detecting a second protocol while
//!   editing offers to *create* a provider, which is not what the user asked
//!   for. Those rows do not exist on an edit form, so nothing has to suppress
//!   them later.

use serde_json::Value;

use super::{App, Call, Daemon, Open, OverlayKind};
use crate::acp::types::{self as wire, ConfigurableApiType, ProviderPersist};
use crate::keybind::Action;
use crate::ui::form::{Field, Form, Notice, Opt};
use crate::ui::overlay::Panel;
use crate::ui::Row;

/// The palette row that opens the form. Not an [`Action`]: adding a provider
/// does not deserve a global chord, and not a slash command: `/provider` is a
/// report in the daemon's catalog.
pub const PALETTE_VALUE: &str = "setup:provider";

/// Field ids. The form is data, so these are the only names shared between the
/// screen and the request built from it.
mod id {
    use crate::acp::types::ConfigurableApiType;

    /// The provider id, left half of every `provider/model` reference.
    pub const PROVIDER: &str = "provider";
    /// The endpoint.
    pub const BASE_URL: &str = "baseUrl";
    /// The protocol.
    pub const API_TYPE: &str = "apiType";
    /// Where the credential comes to rest.
    pub const PERSIST: &str = "persist";
    /// The credential itself.
    pub const API_KEY: &str = "apiKey";
    /// The variable to read the credential from.
    pub const ENV_VAR: &str = "authEnvVar";
    /// The model id, in the `/model add` form.
    pub const MODEL: &str = "model";

    /// The row that names a *second* provider for one more detected protocol.
    #[must_use]
    pub fn also(api: &ConfigurableApiType) -> String {
        format!("also:{}", api.as_str())
    }
}

/// How long a probe may take. Comfortably inside the schema's 250…30000, and
/// long enough for a cold TLS handshake to a far-away endpoint.
const VERIFY_TIMEOUT_MS: u32 = 6_000;

/// The empty protocol option: what the field shows before detection has
/// answered, and what an endpoint that told us nothing leaves standing.
const UNCHOSEN: &str = "";

/// The label every extra-entry row carries.
///
/// Not the protocol's name: the row's own value already ends in it, and the one
/// thing the label has to say is that this row **adds a provider** rather than
/// choosing between them. It is also ten columns, which is what the label column
/// can show without truncating (see `MAX_LABEL_COLUMNS` in [`crate::ui::form`]);
/// the sentence that names the protocol goes in the note under it, where there
/// is room for it.
const EXTRA_LABEL: &str = "+ provider";

/// What an edit knows that an add does not.
///
/// All of it comes from `provider/get`, and none of it is a credential: the
/// summary it renders is a *source* (`keychain · dev.lyra.provider.openai`), and
/// the websocket policy it carries back out is preserved because an update that
/// silently dropped it would be an edit doing something nobody asked for.
///
/// The answer is **kept** rather than applied once and forgotten: the catalog
/// and `provider/get` are two independent round trips, and the choice fields
/// have nowhere to put a selection until the catalog has given them their
/// options. Whichever lands second re-applies this.
#[derive(Debug, Clone)]
pub struct Editing {
    /// The provider being updated. Fixed for the life of the form.
    provider: String,
    /// What `provider/get` said, once it has said it.
    info: Option<wire::ProviderInfo>,
}

impl Editing {
    /// Where the credential lives, in one line.
    fn auth(&self) -> Option<String> {
        self.info.as_ref().map(wire::ProviderInfo::auth_summary)
    }

    /// The websocket policy to carry back out.
    fn websocket(&self) -> Option<wire::WebsocketMode> {
        self.info
            .as_ref()
            .and_then(|info| info.websocket.clone())
    }
}

/// The state line a multi-protocol detection owns.
///
/// Kept rather than written once, because the number in it is a *fact about the
/// form* and the form keeps changing: clearing a row, refilling it, or making an
/// extra protocol the primary all change how many providers `Enter` writes, and
/// a count that was true when detection answered is exactly the kind of stale
/// sentence this line exists to replace.
#[derive(Debug, Clone)]
struct Count {
    /// What detection said — `2 protocols detected`, plus any normalisation.
    head: String,
    /// The whole line as last put on screen. A keystroke may replace the form's
    /// notice only while it is still exactly this: a verify result, a save
    /// failure or a fresh probe is a newer answer to a different question, and
    /// talking over one would be worse than losing the count.
    line: String,
}

/// The form's state, for as long as one is running.
#[derive(Debug, Default)]
pub struct Wizard {
    /// The catalog, once `provider/setup_options` has answered. It carries the
    /// labels, the persistence choices *this machine* can honour and the file
    /// the answer will be written to — none of which is guessed here.
    options: Option<wire::ProviderSetupOptions>,
    /// Whether this run started because the daemon booted with no provider.
    first_run: bool,
    /// The provider being edited, when this form is an edit rather than an add.
    editing: Option<Editing>,
    /// The endpoint the outstanding `provider/detect` went out for. Also the
    /// idempotence key: leaving the endpoint field twice without changing it is
    /// one round trip, not two.
    probed: Option<String>,
    /// What detection said, kept because it is applied twice — once when it
    /// arrives, once if the catalog lands after it and the choice fields only
    /// then have options to select.
    detected: Option<wire::DetectProviderResult>,
    /// The state line, while detection has found more than one protocol and
    /// this form is one that can act on that (an add, never an edit).
    count: Option<Count>,
    /// Values *this module* wrote, by field id.
    ///
    /// The difference between "the user has not touched this" and "the user
    /// typed exactly what we suggested" does not matter; the difference between
    /// either and "the user typed their own" does, and this is what tells them
    /// apart without a second flag per field.
    derived: Vec<(String, String)>,
    /// How many `provider/add` calls are still outstanding.
    pending: usize,
    /// How many of them have been written.
    saved: usize,
    /// Why the others were not.
    failures: Vec<String>,
}

impl Wizard {
    fn new(first_run: bool) -> Self {
        Self {
            first_run,
            ..Self::default()
        }
    }

    fn editing(provider: &str) -> Self {
        Self {
            editing: Some(Editing {
                provider: provider.to_owned(),
                info: None,
            }),
            ..Self::default()
        }
    }

    /// Whether `value` is still what this module last put in `field`.
    fn is_derived(&self, field: &str, value: &str) -> bool {
        match self.derived.iter().find(|(id, _)| id == field) {
            Some((_, written)) => written == value,
            None => value.is_empty(),
        }
    }

    /// Record what this module just wrote.
    fn remember(&mut self, field: &str, value: String) {
        match self.derived.iter_mut().find(|(id, _)| id == field) {
            Some(entry) => entry.1 = value,
            None => self.derived.push((field.to_owned(), value)),
        }
    }
}

impl App {
    // -- entry points -------------------------------------------------------

    /// Open the form: put it up empty, and ask for the catalog that labels it.
    ///
    /// The form is on screen before the catalog answers because the first field
    /// is the endpoint, which the daemon has no opinion about — a user can start
    /// typing immediately, and the choice fields fill themselves in behind the
    /// caret.
    ///
    /// `first_run` is the auto-open from an unconfigured snapshot; it changes
    /// only what is said, never what is done.
    pub fn open_provider_setup(&mut self, daemon: &mut dyn Daemon, first_run: bool) {
        self.setup = Some(Wizard::new(first_run));
        if first_run {
            self.audit("no provider configured · add one to start");
        }
        self.overlay = Some(Open {
            kind: OverlayKind::ProviderForm,
            panel: Panel::form("add a provider", build_form(None)),
        });
        daemon.send(Call::ProviderSetupOptions);
    }

    /// Open the same form on a provider that already exists.
    ///
    /// Two round trips, neither blocking: the catalog (which labels the choice
    /// fields, exactly as for an add) and `provider/get` (which fills them in).
    /// The panel is up before either answers, because a form that appears only
    /// once the network has agreed is a form that appears to hang.
    pub(super) fn open_provider_edit(&mut self, provider: &str, daemon: &mut dyn Daemon) {
        self.setup = Some(Wizard::editing(provider));
        self.overlay = Some(Open {
            kind: OverlayKind::ProviderForm,
            panel: Panel::form(format!("edit {provider}"), build_form(Some(provider))),
        });
        daemon.send(Call::ProviderSetupOptions);
        daemon.send(Call::ProviderGet {
            provider: provider.to_owned(),
            purpose: super::Purpose::Edit,
        });
    }

    /// Fold `provider/get` into the edit form.
    ///
    /// Everything written here is *derived* in [`Wizard::is_derived`]'s sense —
    /// a suggestion the user may overwrite and detection may replace — with one
    /// exception that is not a field at all: the credential's source, which is
    /// attached to the key field as a note. The key field itself stays **empty**,
    /// and that is the whole mechanism: empty is `persist: "keep"`, so the form
    /// pre-fills everything about a provider except the one thing it must never
    /// hold.
    pub(super) fn adopt_edit_info(&mut self, info: &wire::ProviderInfo) {
        // Guarded like every other answer: an edit form that has been dismissed,
        // or reopened on a different provider, must not adopt this one.
        let mine = self.setup.as_ref().is_some_and(|wizard| {
            wizard
                .editing
                .as_ref()
                .is_some_and(|editing| editing.provider == info.provider)
        });
        if !mine {
            return;
        }
        if let Some(editing) = self
            .setup
            .as_mut()
            .and_then(|wizard| wizard.editing.as_mut())
        {
            editing.info = Some(info.clone());
        }
        self.apply_editing();
        self.refresh_form();
    }

    /// Write what `provider/get` said into the fields.
    ///
    /// Idempotent, and run again whenever the *other* half of the pre-fill
    /// arrives: the choice fields cannot hold a selection before the catalog has
    /// given them options, so "select it again once there is something to
    /// select" is the whole mechanism rather than an ordering assumption.
    ///
    /// Everything written is *derived* in [`Wizard::is_derived`]'s sense — a
    /// value the user may overwrite and detection may replace — with one
    /// exception that is not a field: the key field, which is never written to
    /// at all. Empty is `persist: "keep"`, so the form pre-fills everything
    /// about a provider except the one thing it must never hold.
    fn apply_editing(&mut self) {
        let Some(info) = self
            .setup
            .as_ref()
            .and_then(|wizard| wizard.editing.as_ref())
            .and_then(|editing| editing.info.clone())
        else {
            return;
        };
        let persist = persist_for(&info.auth_type);
        let mut written: Vec<(&str, String)> = vec![
            (id::BASE_URL, info.base_url.clone()),
            (id::API_TYPE, info.api_type.as_str().to_owned()),
            (id::PERSIST, persist.as_str().to_owned()),
        ];
        if let Some(form) = self.provider_form_mut() {
            form.set_value(id::BASE_URL, &info.base_url);
            form.select(id::API_TYPE, info.api_type.as_str());
            form.select(id::PERSIST, persist.as_str());
            // A variable *name*, which is what `env` keeps instead of a token.
            // Nothing from `provider/get` goes anywhere near the key field.
            if info.auth_type == wire::ProviderAuthSource::Env
                && let Some(detail) = &info.auth_detail
            {
                form.set_value(id::ENV_VAR, detail);
                written.push((id::ENV_VAR, detail.clone()));
            }
        }
        if let Some(wizard) = self.setup.as_mut() {
            for (field, value) in written {
                wizard.remember(field, value);
            }
            // The endpoint is already probed, in the sense that matters: leaving
            // the field without changing it must not fire a detection for a URL
            // the daemon just told us about.
            wizard.probed = Some(info.base_url);
        }
    }

    /// `/model add`, with nothing after it: the two-field form.
    pub(super) fn open_model_form(&mut self, daemon: &mut dyn Daemon) {
        self.overlay = Some(Open {
            kind: OverlayKind::ModelForm,
            panel: Panel::form(
                "add a model",
                Form::new(vec![
                    Field::choice(id::PROVIDER, "provider", Vec::new(), None),
                    Field::text(id::MODEL, "model", ""),
                ]),
            ),
        });
        // The provider list is the same one the picker uses; the form needs it
        // to offer a choice rather than a second thing to spell correctly.
        daemon.send(Call::Providers);
    }

    /// `/model add <provider> <id>`: no form at all.
    pub(super) fn add_model(&mut self, provider: &str, model: &str, daemon: &mut dyn Daemon) {
        daemon.send(Call::ModelAdd {
            provider: provider.to_owned(),
            model: model.to_owned(),
        });
    }

    /// Whichever form is open. The single door to it, so every caller is
    /// automatically a no-op when the panel on screen is something else.
    pub(super) fn form_mut(&mut self) -> Option<&mut Form> {
        self.overlay
            .as_mut()
            .filter(|open| open.kind.is_form())
            .and_then(|open| open.panel.as_form_mut())
    }

    fn form_of(&self, kind: &OverlayKind) -> Option<&Form> {
        self.overlay
            .as_ref()
            .filter(|open| open.kind == *kind)
            .and_then(|open| open.panel.as_form())
    }

    fn form_of_mut(&mut self, kind: &OverlayKind) -> Option<&mut Form> {
        self.overlay
            .as_mut()
            .filter(|open| open.kind == *kind)
            .and_then(|open| open.panel.as_form_mut())
    }

    fn provider_form(&self) -> Option<&Form> {
        self.form_of(&OverlayKind::ProviderForm)
    }

    fn provider_form_mut(&mut self) -> Option<&mut Form> {
        self.form_of_mut(&OverlayKind::ProviderForm)
    }

    fn model_form_mut(&mut self) -> Option<&mut Form> {
        self.form_of_mut(&OverlayKind::ModelForm)
    }

    // -- the catalog --------------------------------------------------------

    /// Fold in `provider/setup_options`: the labels, the persistence choices
    /// this machine can honour, and nothing else the form asks about.
    pub(super) fn adopt_setup_options(&mut self, outcome: Result<&Value, &String>) {
        if self.setup.is_none() {
            return;
        }
        let decoded = match outcome {
            Ok(value) => serde_json::from_value::<wire::ProviderSetupOptions>(value.clone())
                .map_err(|error| error.to_string()),
            Err(detail) => Err((*detail).clone()),
        };
        let options = match decoded {
            Ok(options) => options,
            Err(detail) => {
                // Nothing to fill the choice fields with and no honest way to
                // invent it: close, and say why in the transcript rather than in
                // a panel about to go.
                self.close_setup();
                self.error(format!("{}: {detail}", Call::ProviderSetupOptions.method()));
                return;
            }
        };

        let persist = persist_options(&options);
        let default = default_persist(&options);

        if let Some(wizard) = self.setup.as_mut() {
            wizard.remember(id::PERSIST, default.as_str().to_owned());
            wizard.options = Some(options);
        }
        // The catalog labels the protocols; whether the field also says "both
        // detected" depends on an answer that may already be in hand.
        self.refresh_protocol_options();
        if let Some(form) = self.provider_form_mut() {
            form.set_options(id::PERSIST, persist);
            form.select(id::PERSIST, default.as_str());
        }
        // Detection, or `provider/get`, may have answered first; this is where
        // either one's choices finally have options to land in.
        self.apply_editing();
        self.apply_detection();
        self.refresh_form();
    }

    /// Fold in `session/providers` **when the `/model add` form wants it**.
    /// Answers whether it did, so the picker keeps the same reply otherwise.
    pub(super) fn adopt_model_providers(&mut self, value: &Value) -> bool {
        let current = value
            .get("current")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let options: Vec<Opt> = value
            .get("available")
            .and_then(Value::as_array)
            .map(|available| {
                available
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|name| Opt::new(name, name))
                    .collect()
            })
            .unwrap_or_default();
        let Some(form) = self.model_form_mut() else {
            return false;
        };
        form.set_options(id::PROVIDER, options);
        // Open on the active provider: the model being declared is nearly always
        // for the one in use.
        form.select(id::PROVIDER, &current);
        true
    }

    // -- keeping the form true ---------------------------------------------

    /// Recompute what the form shows after anything changed it, and interrogate
    /// the endpoint if the caret has just left it.
    pub(super) fn after_form_edit(&mut self, daemon: &mut dyn Daemon) {
        self.refresh_form();
        self.maybe_detect(daemon);
    }

    /// The rules that are purely about what is on screen.
    ///
    /// Runs on every keystroke as well as every field change, because two of
    /// them are about what a field *holds*: the derived second-entry names
    /// follow the primary name as it is typed, and the key field's note follows
    /// whether anything has been typed into it.
    pub(super) fn refresh_form(&mut self) {
        self.apply_credential_rules();
        self.apply_second_entries();
        self.follow_count_line();
    }

    /// The credential-shaped rule: the persistence choice decides which of the
    /// two credential fields exists at all.
    ///
    /// On an edit the key field additionally carries what an empty one means.
    /// Said on the field rather than in the form's notice line because it is the
    /// answer to a question asked *by that field* — "what happens if I leave
    /// this alone?" — and because the notice line is where transient things
    /// (detecting, checking, saving) go.
    fn apply_credential_rules(&mut self) {
        let keep = self.keep_note();
        let Some(form) = self.provider_form_mut() else {
            return;
        };
        let persist = persist_of(form);
        let wants_key = matches!(
            persist,
            ProviderPersist::Keychain | ProviderPersist::Plaintext
        );
        form.set_visible(id::API_KEY, wants_key);
        form.set_visible(id::ENV_VAR, persist == ProviderPersist::Env);
        if let Some(note) = keep
            && wants_key
        {
            form.set_note(id::API_KEY, Some(note));
        }
    }

    /// What the key field says on an edit form, or `None` on an add form or
    /// before `provider/get` has answered.
    fn keep_note(&self) -> Option<Notice> {
        let auth = self
            .setup
            .as_ref()?
            .editing
            .as_ref()?
            .auth()?;
        let typed = self
            .provider_form()
            .and_then(|form| form.field(id::API_KEY))
            .is_some_and(|field| !field.is_empty());
        // Short on purpose: the note is indented past the label column, and a
        // sentence that says the same thing in more words is a sentence whose
        // *end* — which is where the credential's actual location is — falls off
        // an eighty-column terminal.
        Some(Notice::info(if typed {
            format!("replaces {auth}")
        } else {
            format!("empty keeps {auth}")
        }))
    }

    /// Show a row per *extra* detected protocol, named after the primary, and
    /// say on each one that it is another provider rather than another choice.
    ///
    /// The suffixed name follows the primary name for as long as the user has
    /// not written their own, so typing the id once names both entries.
    fn apply_second_entries(&mut self) {
        let detected = self
            .setup
            .as_ref()
            .and_then(|wizard| wizard.detected.clone())
            .unwrap_or_default();
        let Some(form) = self.provider_form() else {
            return;
        };
        let primary = form.value(id::API_TYPE);
        let name = form.value(id::PROVIDER);
        // Planned first, applied second: the plan reads the wizard and the form,
        // and applying it writes to both.
        let plan: Vec<(ConfigurableApiType, bool, String, Option<String>)> =
            ConfigurableApiType::CONCRETE
                .iter()
                .map(|api| {
                    let field = id::also(api);
                    let show = detected.api_types.len() > 1
                        && detected.api_types.contains(api)
                        && api.as_str() != primary;
                    // Raw, not [`Form::value`]: a hidden field reads as absent
                    // there, and "hidden" must not be mistaken for "the user
                    // cleared it".
                    let held = form.field(&field).map(Field::value).unwrap_or_default();
                    let untouched = self
                        .setup
                        .as_ref()
                        .is_some_and(|wizard| wizard.is_derived(&field, &held));
                    let derived = if name.is_empty() {
                        String::new()
                    } else {
                        format!("{name}-{}", api.suffix())
                    };
                    let value = (show && untouched).then_some(derived);
                    // What the row will hold once this pass has written to it,
                    // which is what its note has to describe.
                    let holding = value.clone().unwrap_or(held);
                    (api.clone(), show, holding, value)
                })
                .collect();

        let mut extra = 0usize;
        for (api, show, holding, value) in plan {
            let field = id::also(&api);
            // Every shown row says what it is, not just the first: the label is
            // ten columns wide and the row a user did not read as a *second
            // provider* is the whole bug this line exists to close. The primary
            // is the first provider, so these start at the second.
            let note = show.then(|| {
                let protocol = self.protocol_label(&api);
                // An empty row is the skip, so it says the skip took — and how
                // to undo it — rather than repeating an instruction the user
                // has already followed. It also stops calling itself a provider
                // that is about to be saved, because it is not one.
                let line = if holding.is_empty() {
                    format!("{protocol} · skipped · name it to save it")
                } else {
                    // Counted over the rows that will actually be written, so
                    // the ordinals and the state line agree: a skipped row is
                    // not the second provider of anything.
                    let line = format!("{} provider · {protocol} · clear to skip", ordinal(extra));
                    extra += 1;
                    line
                };
                Notice::info(line)
            });
            if let Some(form) = self.provider_form_mut() {
                form.set_visible(&field, show);
                if let Some(value) = &value {
                    form.set_value(&field, value);
                }
                if let Some(note) = note {
                    form.set_note(&field, Some(note));
                }
            }
            if let (Some(wizard), Some(value)) = (self.setup.as_mut(), value) {
                wizard.remember(&field, value);
            }
        }
    }

    /// The state line for a multi-protocol detection: what was found, and how
    /// many providers `Enter` would write **right now**.
    ///
    /// `None` when detection found at most one protocol, or when this is an edit
    /// form: one provider is the only thing either can mean, and a count line
    /// about it would be noise on every ordinary setup.
    fn count_line(&self) -> Option<String> {
        let head = self.setup.as_ref()?.count.as_ref()?.head.clone();
        let entries = entry_count(self.provider_form()?);
        Some(format!(
            "{head} — {entries} provider{} will be saved",
            if entries == 1 { "" } else { "s" }
        ))
    }

    /// Keep the count true as rows are cleared, refilled, or made primary.
    ///
    /// Runs on every keystroke, and rewrites **only its own last line** — see
    /// [`Count::line`]. So a count that has been talked over by a verify result
    /// or a save failure stays gone rather than reappearing on top of it.
    fn follow_count_line(&mut self) {
        let Some(line) = self.count_line() else {
            return;
        };
        let last = self
            .setup
            .as_ref()
            .and_then(|wizard| wizard.count.as_ref())
            .map(|count| count.line.clone());
        let showing = self
            .provider_form()
            .and_then(|form| form.notice.as_ref())
            .map(|notice| notice.text.clone());
        if showing != last || showing.as_ref() == Some(&line) {
            return;
        }
        self.write_count_line(line);
    }

    /// Put the count line up, and remember it as the one this module owns.
    fn write_count_line(&mut self, line: String) {
        if let Some(count) = self
            .setup
            .as_mut()
            .and_then(|wizard| wizard.count.as_mut())
        {
            count.line.clone_from(&line);
        }
        self.set_form_notice(Notice::ok(line));
    }

    /// Rebuild the protocol field's options from the catalog and whatever
    /// detection has said, which is what makes the field's detail say `both
    /// detected · this entry` rather than leaving the choice reading as one.
    fn refresh_protocol_options(&mut self) {
        let Some(wizard) = self.setup.as_ref() else {
            return;
        };
        let Some(options) = wizard.options.as_ref() else {
            return;
        };
        let detected = wizard
            .detected
            .as_ref()
            .map(|result| result.api_types.clone())
            .unwrap_or_default();
        let built = protocol_options(options, &detected);
        if let Some(form) = self.provider_form_mut() {
            form.set_options(id::API_TYPE, built);
        }
    }

    /// Ask the endpoint what it is, once per endpoint, the moment the caret
    /// leaves the field it was typed into.
    fn maybe_detect(&mut self, daemon: &mut dyn Daemon) {
        let Some(form) = self.provider_form() else {
            return;
        };
        let base_url = form.value(id::BASE_URL);
        let focused = form.focused().map(|field| field.id.clone());
        if base_url.is_empty() || focused.as_deref() == Some(id::BASE_URL) {
            return;
        }
        if self
            .setup
            .as_ref()
            .is_some_and(|wizard| wizard.probed.as_deref() == Some(base_url.as_str()))
        {
            return;
        }
        let params = wire::DetectProviderParams {
            base_url: base_url.clone(),
            // Whatever has been typed already: some endpoints answer *what they
            // are* only to an authenticated caller, and asking twice is worse
            // than asking once with what is on screen.
            api_key: form.secret_value(id::API_KEY),
        };
        if let Some(wizard) = self.setup.as_mut() {
            wizard.probed = Some(base_url.clone());
        }
        self.set_form_notice(Notice::pending(format!("detecting {base_url}")));
        daemon.send(Call::ProviderDetect(Box::new(params)));
    }

    /// Fold in `provider/detect`.
    ///
    /// Guarded by the endpoint that was probed, exactly as [`App::adopt_verify`]
    /// is: an answer about a URL the user has since retyped would fill the
    /// protocol field with a fact about somewhere else.
    pub(super) fn adopt_detect(
        &mut self,
        probed: &wire::DetectProviderParams,
        outcome: Result<&Value, &String>,
    ) {
        if self
            .provider_form()
            .is_none_or(|form| form.value(id::BASE_URL) != probed.base_url)
        {
            return;
        }
        let decoded = match outcome {
            Ok(value) => serde_json::from_value::<wire::DetectProviderResult>(value.clone())
                .map_err(|error| error.to_string()),
            Err(detail) => Err((*detail).clone()),
        };
        match decoded {
            Ok(result) if !result.api_types.is_empty() => {
                let summary = self.detected_summary(&probed.base_url, &result);
                // More than one protocol is the case the form has to *say*, and
                // only an add form can act on it: an edit is about the one
                // provider it was opened on.
                let counted = result.api_types.len() > 1
                    && self
                        .setup
                        .as_ref()
                        .is_some_and(|wizard| wizard.editing.is_none());
                if let Some(wizard) = self.setup.as_mut() {
                    wizard.detected = Some(result);
                    wizard.count = counted.then(|| Count {
                        head: summary.clone(),
                        line: String::new(),
                    });
                }
                self.refresh_protocol_options();
                self.apply_detection();
                self.refresh_form();
                if let Some(form) = self.provider_form_mut() {
                    form.set_note(id::API_TYPE, None);
                }
                // The count line is the summary plus what it means, so it
                // replaces the summary rather than following it.
                match self.count_line() {
                    Some(line) => self.write_count_line(line),
                    None => self.set_form_notice(Notice::ok(summary)),
                }
            }
            Ok(_) => self.detection_failed("the endpoint named no protocol".to_owned()),
            Err(detail) => self.detection_failed(detail),
        }
    }

    /// Detection is a convenience. When it fails the form stays exactly as
    /// usable as it was, minus one filled-in field, and says so where the user
    /// is about to look.
    fn detection_failed(&mut self, detail: String) {
        if let Some(wizard) = self.setup.as_mut() {
            wizard.detected = None;
            wizard.count = None;
        }
        // Nothing was detected, so nothing claims to have been: the protocol
        // options go back to the catalog's own words.
        self.refresh_protocol_options();
        self.refresh_form();
        if let Some(form) = self.provider_form_mut() {
            form.set_note(
                id::API_TYPE,
                Some(Notice::info("not detected · choose one")),
            );
        }
        self.set_form_notice(Notice::info(detail));
    }

    /// One line for what was found, in the catalog's own words where it has any.
    ///
    /// A rewritten endpoint is named here rather than left to be noticed: the
    /// field changing under the caret is exactly the kind of thing a form should
    /// say out loud.
    ///
    /// With more than one protocol this is only the **head** of the state line:
    /// [`App::count_line`] adds what it means, and the protocols themselves are
    /// named by the fields — one in the protocol choice, one under each extra
    /// row — rather than by a sentence long enough to be truncated.
    fn detected_summary(&self, probed: &str, result: &wire::DetectProviderResult) -> String {
        let named: Vec<String> = result
            .api_types
            .iter()
            .map(|api| self.protocol_label(api))
            .collect();
        let mut line = match named.len() {
            0 | 1 => format!("detected · {}", named.join("")),
            count => format!("{count} protocols detected"),
        };
        if result
            .normalized_base_url
            .as_ref()
            .is_some_and(|normalized| !normalized.is_empty() && normalized != probed)
        {
            line.push_str(" · endpoint normalised");
        }
        line
    }

    /// What the catalog calls a protocol, or its wire spelling if the catalog
    /// has not arrived or has never heard of it.
    fn protocol_label(&self, api: &ConfigurableApiType) -> String {
        self.setup
            .as_ref()
            .and_then(|wizard| wizard.options.as_ref())
            .and_then(|options| {
                options
                    .api_types
                    .iter()
                    .find(|option| option.id == *api)
                    .map(|option| option.label.clone())
            })
            .unwrap_or_else(|| api.as_str().to_owned())
    }

    /// Put what detection learned into the fields, without ever overwriting
    /// something the user has decided.
    fn apply_detection(&mut self) {
        let Some(detected) = self
            .setup
            .as_ref()
            .and_then(|wizard| wizard.detected.clone())
        else {
            return;
        };
        let Some(form) = self.provider_form() else {
            return;
        };
        // Nothing the user has decided is overwritten: a field still holding
        // what *this module* last put in it is a suggestion, and a suggestion is
        // what a newer one replaces.
        let untouched = |field: &str, value: &str| {
            self.setup
                .as_ref()
                .is_some_and(|wizard| wizard.is_derived(field, value))
        };
        let protocol = form.value(id::API_TYPE);
        let wants_protocol = (untouched(id::API_TYPE, &protocol)
            && !detected
                .api_types
                .iter()
                .any(|api| api.as_str() == protocol))
        .then(|| detected.api_types.first().map(ConfigurableApiType::as_str))
        .flatten()
        .map(str::to_owned);
        // The endpoint in the shape it will be persisted in. Adopted whatever
        // the user typed, because it *is* what they typed — the daemon has
        // normalised it, not replaced it, and the alternative is a form showing
        // one URL while the file grows another.
        let base_url = form.value(id::BASE_URL);
        let wants_url = detected
            .normalized_base_url
            .clone()
            .filter(|normalized| !normalized.is_empty() && *normalized != base_url);
        // Nothing suggests a name for a provider that already has one: the id is
        // fixed on an edit form, and a suggestion that cannot be applied is a
        // suggestion that should not be made.
        let name = form.value(id::PROVIDER);
        let wants_name = detected
            .suggested_name
            .clone()
            .filter(|_| self.setup.as_ref().is_some_and(|wizard| wizard.editing.is_none()))
            .filter(|_| name.is_empty() || untouched(id::PROVIDER, &name));
        // An endpoint that answered unauthenticated wants "no key" as its
        // opening choice — the local-runtime case, which is most of them.
        let persist = form.value(id::PERSIST);
        let wants_persist = detected.auth_required == Some(false)
            && self
                .setup
                .as_ref()
                .is_some_and(|wizard| wizard.is_derived(id::PERSIST, &persist));

        let mut written: Vec<(&str, String)> = Vec::new();
        if let Some(form) = self.provider_form_mut() {
            if let Some(url) = wants_url {
                form.set_value(id::BASE_URL, &url);
                written.push((id::BASE_URL, url));
            }
            if let Some(protocol) = wants_protocol
                && form.select(id::API_TYPE, &protocol)
            {
                written.push((id::API_TYPE, protocol));
            }
            if let Some(name) = wants_name {
                form.set_value(id::PROVIDER, &name);
                written.push((id::PROVIDER, name));
            }
            if wants_persist {
                let none = ProviderPersist::NoCredential.as_str();
                if form.select(id::PERSIST, none) {
                    written.push((id::PERSIST, none.to_owned()));
                }
            }
        }
        if let Some(wizard) = self.setup.as_mut() {
            for (field, value) in written {
                // An adopted normalisation is also the endpoint that has now
                // been probed: leaving the field again must not re-ask about
                // the URL the answer just came from.
                if field == id::BASE_URL {
                    wizard.probed = Some(value.clone());
                }
                wizard.remember(field, value);
            }
        }
    }

    // -- verify -------------------------------------------------------------

    /// `Ctrl+T`: one liveness check against what is on screen.
    pub(super) fn form_verify(&mut self, daemon: &mut dyn Daemon) {
        let Some(form) = self.provider_form() else {
            return;
        };
        let base_url = form.value(id::BASE_URL);
        if base_url.is_empty() {
            self.set_form_notice(Notice::error("an endpoint is needed before it can be checked"));
            return;
        }
        let Some(api_type) = api_type_of(form) else {
            self.set_form_notice(Notice::error("a protocol is needed before it can be checked"));
            return;
        };
        let params = wire::VerifyProviderParams {
            provider: Some(form.value(id::PROVIDER)).filter(|value| !value.is_empty()),
            base_url: base_url.clone(),
            api_type,
            api_key: form.secret_value(id::API_KEY),
            auth_env_var: Some(form.value(id::ENV_VAR)).filter(|value| !value.is_empty()),
            timeout_ms: Some(VERIFY_TIMEOUT_MS),
        };
        self.set_form_notice(Notice::pending(format!("checking {base_url}")));
        daemon.send(Call::ProviderVerify(Box::new(params)));
    }

    /// Fold in `provider/verify`. Never fatal, by the schema's own design: an
    /// unreachable endpoint is an answer, and the next move is the user's.
    pub(super) fn adopt_verify(
        &mut self,
        probed: &wire::VerifyProviderParams,
        outcome: Result<&Value, &String>,
    ) {
        if self
            .provider_form()
            .is_none_or(|form| form.value(id::BASE_URL) != probed.base_url)
        {
            return;
        }
        let notice = match outcome {
            Ok(value) => match serde_json::from_value::<wire::VerifyProviderResult>(value.clone()) {
                Ok(result) if result.ok => Notice::ok(reached(&result)),
                Ok(result) => Notice::error(match result.error {
                    Some(error) => format!("{} · {}", error.classification, error.message),
                    None => "the endpoint did not answer".to_owned(),
                }),
                Err(error) => Notice::error(error.to_string()),
            },
            Err(detail) => Notice::error((*detail).clone()),
        };
        self.set_form_notice(notice);
    }

    // -- save ---------------------------------------------------------------

    /// `Enter`: advance, or save from the last field.
    pub(super) fn form_submit(&mut self, daemon: &mut dyn Daemon) {
        match self.overlay.as_ref().map(|open| open.kind.clone()) {
            Some(OverlayKind::ProviderForm) => self.provider_submit(daemon),
            Some(OverlayKind::ModelForm) => self.model_submit(daemon),
            _ => {}
        }
    }

    fn provider_submit(&mut self, daemon: &mut dyn Daemon) {
        let Some(on_last) = self.provider_form().map(Form::on_last) else {
            return;
        };
        if !on_last {
            if let Some(form) = self.provider_form_mut() {
                form.apply(Action::FormNextField);
            }
            // Leaving the endpoint by `Enter` interrogates it, exactly as
            // leaving it by `Tab` does.
            self.after_form_edit(daemon);
            return;
        }

        let editing = self
            .setup
            .as_ref()
            .and_then(|wizard| wizard.editing.clone());
        let problems = {
            let Some(form) = self.provider_form() else {
                return;
            };
            validate(form, editing.is_some())
        };
        if self.mark(&problems) {
            return;
        }

        let Some(requests) = self
            .provider_form()
            .map(|form| add_requests(form, editing.as_ref()))
        else {
            return;
        };
        if let Some(wizard) = self.setup.as_mut() {
            wizard.pending = requests.len();
            wizard.saved = 0;
            wizard.failures.clear();
        }
        self.set_form_notice(Notice::pending(match requests.len() {
            1 => format!("saving {}", requests[0].provider),
            count => format!("saving {count} providers"),
        }));
        for params in requests {
            daemon.send(Call::ProviderAdd(Box::new(params)));
        }
    }

    fn model_submit(&mut self, daemon: &mut dyn Daemon) {
        let Some(on_last) = self.form_of(&OverlayKind::ModelForm).map(Form::on_last) else {
            return;
        };
        if !on_last {
            if let Some(form) = self.model_form_mut() {
                form.apply(Action::FormNextField);
            }
            return;
        }
        let Some(form) = self.form_of(&OverlayKind::ModelForm) else {
            return;
        };
        let (provider, model) = (form.value(id::PROVIDER), form.value(id::MODEL));
        let mut problems: Vec<(String, String)> = Vec::new();
        if provider.is_empty() {
            problems.push((
                id::PROVIDER.to_owned(),
                "no provider to add a model to".to_owned(),
            ));
        }
        if model.is_empty() {
            problems.push((id::MODEL.to_owned(), "a model id is required".to_owned()));
        }
        if self.mark(&problems) {
            return;
        }
        self.set_form_notice(Notice::pending(format!("adding {provider}/{model}")));
        daemon.send(Call::ModelAdd { provider, model });
    }

    /// Attach validation messages and focus the first offender. Answers whether
    /// anything was wrong, which is also "whether to stop".
    fn mark(&mut self, problems: &[(String, String)]) -> bool {
        if let Some(form) = self.form_mut() {
            form.clear_notes();
            for (field, message) in problems {
                form.set_note(field, Some(Notice::error(message.clone())));
            }
            if let Some((first, _)) = problems.first() {
                form.focus(first);
            }
        }
        if problems.is_empty() {
            return false;
        }
        self.set_form_notice(Notice::error(format!(
            "{} field{} to fix",
            problems.len(),
            if problems.len() == 1 { "" } else { "s" }
        )));
        true
    }

    /// Fold in one `provider/add`.
    ///
    /// **No `session/select_provider` follows.** Adding is not switching:
    /// `/model` is the switching surface and it spans every configured provider,
    /// so a save that silently re-pointed the session would be a second, hidden
    /// meaning for one keypress.
    pub(super) fn adopt_added(&mut self, outcome: Result<&Value, &String>) {
        let decoded = match outcome {
            Ok(value) => serde_json::from_value::<wire::AddProviderResult>(value.clone())
                .map_err(|error| error.to_string()),
            Err(detail) => Err((*detail).clone()),
        };
        let updated = self
            .setup
            .as_ref()
            .is_some_and(|wizard| wizard.editing.is_some());
        match decoded {
            Ok(saved) => {
                let style = self.theme.success();
                self.commits
                    .push(Row::styled(format!("  {}", saved_line(&saved, updated)), style));
                for warning in &saved.warnings {
                    self.audit(warning.clone());
                }
                if let Some(wizard) = self.setup.as_mut() {
                    wizard.saved += 1;
                }
            }
            Err(detail) => match self.setup.as_mut() {
                Some(wizard) => wizard.failures.push(detail),
                // The panel is already gone (dismissed mid-flight): the failure
                // still has to be said somewhere.
                None => self.error(format!("{}: {detail}", wire::method::PROVIDER_ADD)),
            },
        }
        let Some(wizard) = self.setup.as_mut() else {
            return;
        };
        wizard.pending = wizard.pending.saturating_sub(1);
        if wizard.pending > 0 {
            return;
        }
        let (saved, first_run) = (wizard.saved, wizard.first_run);
        let failures = std::mem::take(&mut wizard.failures);
        if saved == 0 {
            // Nothing was written, so the form stays exactly as it was, message
            // and all: the user's next move is to fix one field, not type five
            // again.
            if let Some(detail) = failures.into_iter().next() {
                self.set_form_notice(Notice::error(detail));
            }
            return;
        }
        self.close_setup();
        for detail in failures {
            self.error(format!("{}: {detail}", wire::method::PROVIDER_ADD));
        }
        if first_run {
            self.audit("ready · type to start the session");
        }
    }

    /// Fold in `model/add`, from either the form or the argument form.
    pub(super) fn adopt_model_added(&mut self, outcome: Result<&Value, &String>) {
        let decoded = match outcome {
            Ok(value) => serde_json::from_value::<wire::AddModelResult>(value.clone())
                .map_err(|error| error.to_string()),
            Err(detail) => Err((*detail).clone()),
        };
        match decoded {
            Ok(added) => {
                let style = self.theme.success();
                self.commits.push(Row::styled(
                    format!(
                        "  model added · {}/{} — /model to switch",
                        added.provider, added.model
                    ),
                    style,
                ));
                if self.model_form_mut().is_some() {
                    self.overlay = None;
                }
            }
            Err(detail) => {
                if self.model_form_mut().is_some() {
                    self.set_form_notice(Notice::error(detail));
                } else {
                    self.error(format!("{}: {detail}", wire::method::MODEL_ADD));
                }
            }
        }
    }

    // -- shared -------------------------------------------------------------

    /// Put a message under whichever form is on screen.
    fn set_form_notice(&mut self, notice: Notice) {
        if let Some(form) = self.form_mut() {
            form.notice = Some(notice);
        }
    }

    /// Drop the wizard and whatever panel it had up.
    pub(super) fn close_setup(&mut self) {
        self.setup = None;
        if self
            .overlay
            .as_ref()
            .is_some_and(|open| open.kind == OverlayKind::ProviderForm)
        {
            self.overlay = None;
        }
    }
}

// ---------------------------------------------------------------------------
// The form, as data
// ---------------------------------------------------------------------------

/// Build the form. Endpoint first, because everything else is derived from it.
///
/// The two choice fields open **empty**: their options are the daemon's answer
/// (which protocols it can speak, which persistence choices *this machine* can
/// honour), and a plausible list invented here and corrected a frame later is
/// exactly the kind of first state that reads as a good one without being one.
///
/// The `also:` rows are declared here and hidden, one per protocol the schema
/// declares, because a field cannot be added to a form that is already
/// collecting a credential — and [`ConfigurableApiType::CONCRETE`] is a closed
/// set, not a guess.
///
/// `editing` names the provider being updated, and changes two things: the name
/// is a fixed row rather than a text field (see the module docs on renaming),
/// and there are no second-entry rows, because an edit is about one provider.
fn build_form(editing: Option<&str>) -> Form {
    let name = match editing {
        // A choice field with exactly one option: a value that is shown, that
        // navigation still walks past, and that no keystroke can change. There
        // is no "read-only text field" kind because this is one.
        Some(provider) => Field::choice(
            id::PROVIDER,
            "name",
            vec![Opt::new(provider, provider)
                .with_detail(Some("fixed · add a new provider to rename".to_owned()))],
            Some(provider),
        ),
        None => Field::text(id::PROVIDER, "name", ""),
    };
    let mut fields = vec![
        Field::text(id::BASE_URL, "endpoint", ""),
        Field::choice(
            id::API_TYPE,
            "protocol",
            vec![Opt::new(UNCHOSEN, "— choose —")],
            None,
        ),
        name,
        Field::choice(id::PERSIST, "credential", Vec::new(), None),
        Field::secret(id::API_KEY, "key"),
        Field::text(id::ENV_VAR, "variable", ""),
    ];
    if editing.is_none() {
        for api in &ConfigurableApiType::CONCRETE {
            let mut field = Field::text(id::also(api), EXTRA_LABEL, "");
            field.visible = false;
            fields.push(field);
        }
    }
    let mut form = Form::new(fields);
    form.set_visible(id::API_KEY, false);
    form.set_visible(id::ENV_VAR, false);
    form.focus(id::BASE_URL);
    form
}

/// Which persistence choice describes an auth source that already exists.
///
/// The two vocabularies are deliberately different — `static` says where a token
/// is, `plaintext` says what that costs — so the mapping is written out rather
/// than assumed.
fn persist_for(auth: &wire::ProviderAuthSource) -> ProviderPersist {
    match auth {
        wire::ProviderAuthSource::Keychain => ProviderPersist::Keychain,
        wire::ProviderAuthSource::Static => ProviderPersist::Plaintext,
        wire::ProviderAuthSource::Env => ProviderPersist::Env,
        wire::ProviderAuthSource::NoCredential => ProviderPersist::NoCredential,
        // A helper, or a source this build has not heard of. Neither is a thing
        // this form can offer to write, so it opens on the choice that would
        // replace one — and an untouched key field still sends `keep`, which
        // leaves the auth block exactly as it was found.
        wire::ProviderAuthSource::Plugin | wire::ProviderAuthSource::Other(_) => {
            ProviderPersist::Keychain
        }
    }
}

/// The protocol options: the empty one, then the daemon's.
///
/// `detected` is what the endpoint turned out to speak. When it named more than
/// one, every option it named says so, because the field is otherwise an
/// exclusive choice by every convention a form has — and this one is not: the
/// selection names *this* entry's protocol, and the rows below it name the rest.
fn protocol_options(
    options: &wire::ProviderSetupOptions,
    detected: &[ConfigurableApiType],
) -> Vec<Opt> {
    let found = (detected.len() > 1).then(|| multi_detail(detected.len()));
    let mut protocols = vec![Opt::new(UNCHOSEN, "— choose —")];
    protocols.extend(options.api_types.iter().map(|option| {
        let detail = found
            .clone()
            .filter(|_| detected.contains(&option.id))
            .or_else(|| option.detail.clone());
        Opt::new(option.id.as_str(), option.label.clone()).with_detail(detail)
    }));
    protocols
}

/// What a detected protocol's option says when it was not the only one.
fn multi_detail(found: usize) -> String {
    let head = if found == 2 {
        "both detected".to_owned()
    } else {
        format!("{found} detected")
    };
    format!("{head} · this entry")
}

/// What to call the *n*-th extra entry. The primary is the first provider, so
/// these start at the second, and [`ConfigurableApiType::CONCRETE`] is three
/// long, so "third" is the end of it.
const fn ordinal(extra: usize) -> &'static str {
    match extra {
        0 => "second",
        1 => "third",
        _ => "another",
    }
}

/// How many providers `Enter` would write, by exactly the rule
/// [`add_requests`] builds them with — the same expression twice would be two
/// chances to disagree, and the count line's whole job is to be true.
fn entry_count(form: &Form) -> usize {
    usize::from(api_type_of(form).is_some())
        + ConfigurableApiType::CONCRETE
            .iter()
            .filter(|api| second_entry(form, api).is_some())
            .count()
}

/// The persistence options, exactly as this machine resolved them.
fn persist_options(options: &wire::ProviderSetupOptions) -> Vec<Opt> {
    options
        .persist
        .iter()
        .map(|option| {
            Opt::new(option.id.as_str(), option.label.clone())
                .with_detail(option.detail.clone())
                .available(option.available)
        })
        .collect()
}

/// Which persistence choice the form opens on: the keychain, unless this machine
/// has no keychain to write to. Detection may still move it to `none`.
fn default_persist(options: &wire::ProviderSetupOptions) -> ProviderPersist {
    let available = |id: &ProviderPersist| {
        options
            .persist_option(id)
            .is_some_and(|option| option.available)
    };
    if available(&ProviderPersist::Keychain) {
        ProviderPersist::Keychain
    } else if available(&ProviderPersist::Plaintext) {
        ProviderPersist::Plaintext
    } else {
        options
            .persist
            .iter()
            .find(|option| option.available)
            .map_or(ProviderPersist::Keychain, |option| option.id.clone())
    }
}

/// Read a wire spelling back into a `wire_enum!`.
fn parse_wire<T: serde::de::DeserializeOwned>(value: &str, fallback: T) -> T {
    serde_json::from_value(Value::String(value.to_owned())).unwrap_or(fallback)
}

/// The persistence choice on screen. Read from the **field**, not from the
/// wizard, so it is whatever the user last cycled to.
fn persist_of(form: &Form) -> ProviderPersist {
    form.field(id::PERSIST)
        .map_or(ProviderPersist::NoCredential, |field| {
            parse_wire(&field.value(), ProviderPersist::NoCredential)
        })
}

/// The protocol on screen, when one has been chosen. `None` is the unchosen
/// row, which is a validation error rather than a default: a provider whose
/// protocol was guessed fails on its first request, far from here.
fn api_type_of(form: &Form) -> Option<ConfigurableApiType> {
    let value = form.value(id::API_TYPE);
    (!value.is_empty()).then(|| {
        parse_wire(
            &value,
            ConfigurableApiType::Other(value.clone()),
        )
    })
}

/// The name a second provider for `api` would be saved under, when its row is
/// on screen and not cleared.
fn second_entry(form: &Form, api: &ConfigurableApiType) -> Option<String> {
    let field = form.field(&id::also(api))?;
    field
        .visible
        .then(|| field.value())
        .filter(|name| !name.is_empty())
}

/// What is wrong with the form, in field order.
///
/// These are the daemon's own rules (`validateSetup` and `providerAddInput` in
/// `packages/lyra-app/src/provider-setup.ts`), restated where the user can act
/// on them. Restating them is not duplication for its own sake: the daemon
/// answers a bad request with one JSON-RPC error, and one error cannot say
/// *which of five fields* to go back to.
fn validate(form: &Form, editing: bool) -> Vec<(String, String)> {
    let mut problems: Vec<(String, String)> = Vec::new();
    let mut complain = |field: &str, message: &str| {
        problems.push((field.to_owned(), message.to_owned()));
    };
    let base_url = form.value(id::BASE_URL);
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        complain(id::BASE_URL, "must be an http(s) URL");
    }
    if api_type_of(form).is_none() {
        complain(id::API_TYPE, "a protocol is required · ← → to choose");
    }
    let provider = form.value(id::PROVIDER);
    if !is_provider_id(&provider) {
        complain(
            id::PROVIDER,
            "lowercase letters, digits and hyphens, starting with a letter",
        );
    }

    let persist = persist_of(form);
    let available = form
        .field(id::PERSIST)
        .and_then(crate::ui::form::Field::selected)
        .is_some_and(|option| option.available);
    if !available {
        complain(
            id::PERSIST,
            "this machine cannot store a credential that way",
        );
    }
    match persist {
        // On an edit, empty is an answer — "keep what is there" — so the one
        // rule that changes is this one.
        ProviderPersist::Keychain | ProviderPersist::Plaintext => {
            if !editing && form.secret_value(id::API_KEY).is_none() {
                complain(id::API_KEY, "a credential is required");
            }
        }
        ProviderPersist::Env => {
            if !is_env_var(&form.value(id::ENV_VAR)) {
                complain(
                    id::ENV_VAR,
                    "a variable name: letters, digits and underscores",
                );
            }
        }
        // `none` needs nothing, and cannot be given anything: the field it would
        // come from is not visible, so `secret_value` already reads as absent.
        // `keep` is never *selected* — it is what an empty key field on an edit
        // resolves to at request-build time — so it has nothing to check either.
        ProviderPersist::NoCredential | ProviderPersist::Keep | ProviderPersist::Other(_) => {}
    }

    // The second entries: same id rule, and no two providers may share a name.
    let mut names = vec![provider];
    for api in &ConfigurableApiType::CONCRETE {
        let Some(name) = second_entry(form, api) else {
            continue;
        };
        let field = id::also(api);
        if !is_provider_id(&name) {
            complain(&field, "lowercase letters, digits and hyphens");
        } else if names.contains(&name) {
            complain(&field, "another entry already has this name");
        }
        names.push(name);
    }
    problems
}

/// The requests, built only from **visible** fields: the provider itself, then
/// one per extra protocol whose row is filled in.
///
/// On an edit there is exactly one, it names a provider that already exists —
/// which is what makes `provider/add` an update — and an empty key field
/// resolves to [`ProviderPersist::Keep`]: no credential is read, none is
/// encoded, and the daemon reuses whatever already backs the provider.
fn add_requests(form: &Form, editing: Option<&Editing>) -> Vec<wire::AddProviderParams> {
    let selected = persist_of(form);
    let typed = form.secret_value(id::API_KEY);
    // The one rule of the edit form's credential section, in one expression.
    let keeping = editing.is_some()
        && typed.is_none()
        && matches!(
            selected,
            ProviderPersist::Keychain | ProviderPersist::Plaintext
        );
    let persist = if keeping {
        ProviderPersist::Keep
    } else {
        selected
    };
    let entry = |provider: String, api_type: ConfigurableApiType| wire::AddProviderParams {
        provider,
        base_url: form.value(id::BASE_URL),
        api_type,
        // Deliberately absent: discovery is the daemon's, and this form has
        // stopped asking a user to guess a model id (see the module docs).
        model: None,
        fast_model: None,
        merge_model: None,
        // Carried back out on an edit, because the form has no row for it and
        // an update that dropped it would be a change nobody asked for.
        websocket: editing.and_then(Editing::websocket),
        api_key: if keeping { None } else { typed.clone() },
        auth_env_var: Some(form.value(id::ENV_VAR)).filter(|value| !value.is_empty()),
        persist: persist.clone(),
    };
    let mut requests = Vec::new();
    if let Some(api_type) = api_type_of(form) {
        requests.push(entry(form.value(id::PROVIDER), api_type));
    }
    for api in &ConfigurableApiType::CONCRETE {
        if let Some(name) = second_entry(form, api) {
            requests.push(entry(name, api.clone()));
        }
    }
    requests
}

/// The one line a save commits.
///
/// The distinction it draws is the only one that matters next: a provider whose
/// models were listed is one `/model` away from usable, and one whose were not
/// needs a model declared before it can answer anything.
fn saved_line(saved: &wire::AddProviderResult, updated: bool) -> String {
    let verb = if updated { "updated" } else { "saved" };
    match saved.models_discovered {
        Some(models) => format!(
            "provider {verb} · {} · {models} models discovered — /model to switch",
            saved.provider
        ),
        None => format!(
            "provider {verb} · {} · no model listing — /model add to declare one",
            saved.provider
        ),
    }
}

/// `^[a-z][a-z0-9-]{0,63}$`, by hand: this crate has no regex dependency and
/// one predicate does not earn one.
///
/// Shared with the `/provider edit|delete <name>` argument forms, which reject a
/// name no provider could have rather than asking the daemon about it.
pub(super) fn is_provider_id(value: &str) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_lowercase())
        && value.len() <= 64
        && characters.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `^[A-Za-z_][A-Za-z0-9_]*$`.
fn is_env_var(value: &str) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// What a successful probe says, in one line.
///
/// The sample is the point: "reachable" is cheap to fake, and a list of model
/// ids is what tells a user they reached the provider they meant.
fn reached(result: &wire::VerifyProviderResult) -> String {
    let head = match result.models {
        Some(models) => format!("reached · {models} models"),
        None => "reached".to_owned(),
    };
    if result.sample.is_empty() {
        head
    } else {
        format!("{head} · {}", result.sample.join(", "))
    }
}
