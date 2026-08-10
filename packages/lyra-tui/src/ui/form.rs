//! The form: the third overlay body, and the only one that takes an answer
//! longer than one keypress.
//!
//! [`crate::ui::overlay`] has a filterable list and a scrollable block of rows.
//! Neither can ask for six values at once, which is what adding a provider is,
//! so this module adds the third body — a labelled column of fields, drawn into
//! the same [`Panel`](crate::ui::overlay::Panel) frame, in the same bottom live
//! region, above the same composer. There is still no second rendering mode.
//!
//! # One editor, three field kinds
//!
//! Text fields are the **composer's own editor**
//! ([`crate::input::composer::Composer`]), one instance per field. That is not
//! reuse for its own sake: it is how `Ctrl+W`, `Alt+B`, undo, and a pasted key
//! with a wide grapheme in it behave identically in a form field and in the
//! prompt, from one implementation. Choice fields cycle a fixed list. Secret
//! fields are text fields with two differences, and both are load-bearing:
//!
//! 1. They render **`•` per grapheme**, never the plaintext — no path in this
//!    module puts the characters of one into a [`Row`].
//! 2. The buffer holding them is [`Masked`], whose `Debug` is hand-written to
//!    print `<redacted>`. Every enclosing type — [`Field`], [`Form`],
//!    [`crate::app::App`] — derives `Debug`, so a derived `Debug` here would
//!    put an API key one `{:?}` away from a panic message or a log line.
//!
//! # What the form does not decide
//!
//! Validation *messages* are rendered here; validation *rules* are the
//! wizard's ([`crate::app`]), because they are rules about providers, not about
//! forms. Likewise `Enter` and `Ctrl+T`: this module never talks to a daemon.

use std::fmt;

use unicode_width::UnicodeWidthStr;

use crate::acp::types::Secret;
use crate::input::composer::Composer;
use crate::input::history::History;
use crate::keybind::Action;
use crate::theme::Theme;
use crate::ui::overlay::truncate;
use crate::ui::{Row, Span, Style};

/// Columns the focus marker occupies.
const MARKER_COLUMNS: usize = 2;

/// Widest a label column may get before the value column starts paying for it.
const MAX_LABEL_COLUMNS: usize = 12;

/// The bullet a secret renders as. One per grapheme, so the length is visible
/// (a user needs to see that a paste landed) and nothing else is.
const BULLET: &str = "•";

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

/// How a message should be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    /// Something is wrong and the user must change it.
    Error,
    /// Something is in flight. DESIGN.md §3: state, not animation.
    Pending,
    /// Something worked.
    Ok,
    /// Neither good nor bad, but worth knowing.
    Info,
}

impl Tone {
    fn style(self, theme: &Theme) -> Style {
        match self {
            Self::Error => theme.error(),
            Self::Pending => theme.muted(),
            Self::Ok => theme.success(),
            Self::Info => theme.faint(),
        }
    }

    const fn glyph(self) -> &'static str {
        match self {
            Self::Pending => "⟳ ",
            Self::Error | Self::Ok => "● ",
            Self::Info => "  ",
        }
    }
}

/// One line of prose attached to a field or to the form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    /// What to say.
    pub text: String,
    /// How to say it.
    pub tone: Tone,
}

impl Notice {
    /// A message the user must act on.
    #[must_use]
    pub fn error(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            tone: Tone::Error,
        }
    }

    /// A message about something in flight.
    #[must_use]
    pub fn pending(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            tone: Tone::Pending,
        }
    }

    /// A message about something that worked.
    #[must_use]
    pub fn ok(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            tone: Tone::Ok,
        }
    }

    /// A message that is merely true.
    #[must_use]
    pub fn info(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            tone: Tone::Info,
        }
    }
}

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

/// One option of a choice field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opt {
    /// What the wizard reads back.
    pub value: String,
    /// What the user sees.
    pub label: String,
    /// Why to pick it, or why it cannot be picked.
    pub detail: Option<String>,
    /// Whether this machine can honour it. An unavailable option is rendered
    /// **with its reason** rather than hidden, so the absence is explained
    /// rather than mysterious.
    pub available: bool,
}

impl Opt {
    /// An available option.
    #[must_use]
    pub fn new(value: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
            detail: None,
            available: true,
        }
    }

    /// Attach the reason column.
    #[must_use]
    pub fn with_detail(mut self, detail: Option<String>) -> Self {
        self.detail = detail.filter(|text| !text.is_empty());
        self
    }

    /// Say whether this machine can honour it.
    #[must_use]
    pub const fn available(mut self, available: bool) -> Self {
        self.available = available;
        self
    }
}

// ---------------------------------------------------------------------------
// The masked buffer
// ---------------------------------------------------------------------------

/// A text buffer whose contents never reach `Debug`.
///
/// The inner editor is the ordinary [`Composer`], which derives `Debug` like
/// everything else in this crate. Wrapping it is what stops that derive from
/// being reachable: `Debug` for [`Field`] calls **this** implementation, and
/// this implementation prints nothing it holds.
pub struct Masked(Composer);

impl fmt::Debug for Masked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Deliberately not `self.0`: the whole point of the type.
        write!(f, "Masked(<redacted>, {} graphemes)", self.0.len())
    }
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/// What a field edits.
#[derive(Debug)]
enum Body {
    /// Free text.
    Text(Composer),
    /// Free text that is a credential.
    Secret(Masked),
    /// One of a fixed list.
    Choice {
        options: Vec<Opt>,
        selected: usize,
    },
}

/// One row of the form.
#[derive(Debug)]
pub struct Field {
    /// The stable key the wizard reads. Never displayed.
    pub id: String,
    /// The label column.
    pub label: String,
    body: Body,
    /// A validation message, under the field.
    pub note: Option<Notice>,
    /// Whether this field is part of the form right now. A hidden field is not
    /// navigable, not rendered, and — the point — not read: that is how
    /// `persist: env` is unable to carry an API key.
    pub visible: bool,
}

impl Field {
    /// A text field.
    #[must_use]
    pub fn text(id: impl Into<String>, label: impl Into<String>, value: &str) -> Self {
        let mut editor = Composer::new(History::in_memory());
        editor.insert_literal(value);
        Self::wrap(id, label, Body::Text(editor))
    }

    /// A credential field: bullets on screen, [`Masked`] in memory.
    #[must_use]
    pub fn secret(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self::wrap(
            id,
            label,
            Body::Secret(Masked(Composer::new(History::in_memory()))),
        )
    }

    /// A choice field, opening on `current` when it names an option.
    #[must_use]
    pub fn choice(
        id: impl Into<String>,
        label: impl Into<String>,
        options: Vec<Opt>,
        current: Option<&str>,
    ) -> Self {
        let selected = current
            .and_then(|value| options.iter().position(|option| option.value == value))
            .unwrap_or(0);
        Self::wrap(id, label, Body::Choice { options, selected })
    }

    fn wrap(id: impl Into<String>, label: impl Into<String>, body: Body) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            body,
            note: None,
            visible: true,
        }
    }

    /// The value, for every kind **except** a secret, which answers with the
    /// empty string here and only through [`Field::secret_value`] otherwise.
    ///
    /// That asymmetry is the type system carrying the rule: a caller that wants
    /// the credential has to ask for it by a name that says so.
    #[must_use]
    pub fn value(&self) -> String {
        match &self.body {
            Body::Text(editor) => editor.text(),
            Body::Secret(_) => String::new(),
            Body::Choice { options, selected } => options
                .get(*selected)
                .map(|option| option.value.clone())
                .unwrap_or_default(),
        }
    }

    /// The credential, when this is a secret field and it is not empty.
    #[must_use]
    pub fn secret_value(&self) -> Option<Secret> {
        match &self.body {
            Body::Secret(masked) if !masked.0.is_empty() => Some(Secret::new(masked.0.text())),
            _ => None,
        }
    }

    /// Whether this field is a credential.
    #[must_use]
    pub const fn is_secret(&self) -> bool {
        matches!(self.body, Body::Secret(_))
    }

    /// Whether the user has entered anything.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        match &self.body {
            Body::Text(editor) => editor.is_empty(),
            Body::Secret(masked) => masked.0.is_empty(),
            Body::Choice { options, .. } => options.is_empty(),
        }
    }

    /// The selected option, when this is a choice field.
    #[must_use]
    pub fn selected(&self) -> Option<&Opt> {
        match &self.body {
            Body::Choice { options, selected } => options.get(*selected),
            _ => None,
        }
    }

    /// Replace a text field's contents. Rejected for a secret: a credential is
    /// only ever typed or pasted, never programmed in.
    pub fn set_value(&mut self, value: &str) {
        if let Body::Text(editor) = &mut self.body {
            editor.set_text(value);
        }
    }

    /// Select a choice field's option **by value**. Answers whether there was
    /// one to select, so a caller filling a field from a daemon answer can tell
    /// "chosen" from "that option does not exist here".
    pub fn select(&mut self, value: &str) -> bool {
        let Body::Choice { options, selected } = &mut self.body else {
            return false;
        };
        match options.iter().position(|option| option.value == value) {
            Some(index) => {
                *selected = index;
                true
            }
            None => false,
        }
    }

    /// Replace a choice field's options, keeping the selected **value** when the
    /// new list still offers it.
    ///
    /// This is how a field can exist before the daemon has said what may go in
    /// it: the form opens with the field empty and this fills it, rather than
    /// the client inventing a plausible list and correcting it later.
    pub fn set_options(&mut self, replacement: Vec<Opt>) {
        let Body::Choice { options, selected } = &mut self.body else {
            return;
        };
        let current = options.get(*selected).map(|option| option.value.clone());
        *selected = current
            .and_then(|value| replacement.iter().position(|option| option.value == value))
            .unwrap_or(0);
        *options = replacement;
    }

    /// Move to the next option, wrapping. Text fields read this as
    /// "caret right", which is what makes one key mean the obvious thing in
    /// both kinds of field (the same trick `Up` plays for history).
    fn next_option(&mut self) {
        match &mut self.body {
            Body::Choice { options, selected } if !options.is_empty() => {
                *selected = (*selected + 1) % options.len();
            }
            Body::Text(editor) => {
                editor.apply(Action::MoveCharRight);
            }
            Body::Secret(masked) => {
                masked.0.apply(Action::MoveCharRight);
            }
            Body::Choice { .. } => {}
        }
    }

    fn prev_option(&mut self) {
        match &mut self.body {
            Body::Choice { options, selected } if !options.is_empty() => {
                *selected = (*selected + options.len() - 1) % options.len();
            }
            Body::Text(editor) => {
                editor.apply(Action::MoveCharLeft);
            }
            Body::Secret(masked) => {
                masked.0.apply(Action::MoveCharLeft);
            }
            Body::Choice { .. } => {}
        }
    }

    fn insert(&mut self, text: &str) {
        match &mut self.body {
            Body::Text(editor) => editor.insert_literal(text),
            Body::Secret(masked) => masked.0.insert_literal(text),
            Body::Choice { .. } => {}
        }
    }

    /// Route an editing action to the underlying editor.
    fn edit(&mut self, action: Action) -> bool {
        let editor = match &mut self.body {
            Body::Text(editor) => editor,
            Body::Secret(masked) => &mut masked.0,
            Body::Choice { .. } => return false,
        };
        editor.apply(action);
        true
    }

    /// What the value column shows, and how wide the caret sits into it.
    ///
    /// A secret answers with bullets. There is no branch that answers with the
    /// characters, which is the property the tests assert.
    fn display(&self) -> (String, usize) {
        match &self.body {
            Body::Text(editor) => (
                editor.text(),
                UnicodeWidthStr::width(editor.text_before_cursor().as_str()),
            ),
            Body::Secret(masked) => (
                BULLET.repeat(masked.0.len()),
                masked.0.cursor() * UnicodeWidthStr::width(BULLET),
            ),
            Body::Choice { options, selected } => {
                let label = options
                    .get(*selected)
                    .map(|option| option.label.clone())
                    .unwrap_or_default();
                (label, 0)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/// A column of fields with one focused.
#[derive(Debug)]
pub struct Form {
    fields: Vec<Field>,
    focus: usize,
    /// A line under the fields: the verify outcome, the save failure.
    pub notice: Option<Notice>,
}

impl Form {
    /// A form over its fields, focused on the first visible one.
    #[must_use]
    pub fn new(fields: Vec<Field>) -> Self {
        let mut form = Self {
            fields,
            focus: 0,
            notice: None,
        };
        form.focus = form.first_visible().unwrap_or(0);
        form
    }

    /// The fields, in declaration order, hidden ones included.
    #[must_use]
    pub fn fields(&self) -> &[Field] {
        &self.fields
    }

    /// A field by id.
    #[must_use]
    pub fn field(&self, id: &str) -> Option<&Field> {
        self.fields.iter().find(|field| field.id == id)
    }

    /// A field by id, mutably.
    pub fn field_mut(&mut self, id: &str) -> Option<&mut Field> {
        self.fields.iter_mut().find(|field| field.id == id)
    }

    /// A **visible** field's value, or the empty string. Hidden fields read as
    /// absent on purpose: that is how the wizard cannot send a credential to a
    /// persistence mode that has nowhere to put one.
    #[must_use]
    pub fn value(&self, id: &str) -> String {
        self.field(id)
            .filter(|field| field.visible)
            .map(Field::value)
            .unwrap_or_default()
    }

    /// A visible secret field's credential.
    #[must_use]
    pub fn secret_value(&self, id: &str) -> Option<Secret> {
        self.field(id)
            .filter(|field| field.visible)
            .and_then(Field::secret_value)
    }

    /// The focused field.
    #[must_use]
    pub fn focused(&self) -> Option<&Field> {
        self.fields.get(self.focus)
    }

    /// Replace a text field's contents.
    pub fn set_value(&mut self, id: &str, value: &str) {
        if let Some(field) = self.field_mut(id) {
            field.set_value(value);
        }
    }

    /// Select a choice field's option by value, answering whether it existed.
    pub fn select(&mut self, id: &str, value: &str) -> bool {
        self.field_mut(id)
            .is_some_and(|field| field.select(value))
    }

    /// Install a choice field's options, keeping its selected value if it
    /// survives.
    pub fn set_options(&mut self, id: &str, options: Vec<Opt>) {
        if let Some(field) = self.field_mut(id) {
            field.set_options(options);
        }
    }

    /// Focus a field by id, if it is visible.
    pub fn focus(&mut self, id: &str) {
        if let Some(index) = self
            .fields
            .iter()
            .position(|field| field.id == id && field.visible)
        {
            self.focus = index;
        }
    }

    /// Show or hide a field, keeping the focus on something visible.
    pub fn set_visible(&mut self, id: &str, visible: bool) {
        if let Some(field) = self.field_mut(id) {
            field.visible = visible;
        }
        if !self.fields.get(self.focus).is_some_and(|f| f.visible) {
            self.focus = self.first_visible().unwrap_or(0);
        }
    }

    /// Attach (or clear) a field's validation message.
    pub fn set_note(&mut self, id: &str, note: Option<Notice>) {
        if let Some(field) = self.field_mut(id) {
            field.note = note;
        }
    }

    /// Clear every field message. Called before each validation pass so a fixed
    /// field stops complaining.
    pub fn clear_notes(&mut self) {
        for field in &mut self.fields {
            field.note = None;
        }
    }

    /// Whether the focus is on the last visible field — the one whose `Enter`
    /// means "submit" rather than "next".
    #[must_use]
    pub fn on_last(&self) -> bool {
        self.visible_indices().last() == Some(&self.focus)
    }

    /// Type into the focused field.
    pub fn insert(&mut self, text: &str) {
        if let Some(field) = self.fields.get_mut(self.focus) {
            field.insert(text);
        }
    }

    /// Run a keybinding action. Returns whether the form consumed it.
    ///
    /// `Enter` and `Ctrl+T` are **not** here: submitting and verifying talk to a
    /// daemon, which this module has no business knowing about.
    pub fn apply(&mut self, action: Action) -> bool {
        match action {
            Action::FormNextField => {
                self.step(true);
                true
            }
            Action::FormPrevField => {
                self.step(false);
                true
            }
            Action::FormNextOption => {
                if let Some(field) = self.fields.get_mut(self.focus) {
                    field.next_option();
                }
                true
            }
            Action::FormPrevOption => {
                if let Some(field) = self.fields.get_mut(self.focus) {
                    field.prev_option();
                }
                true
            }
            _ => self
                .fields
                .get_mut(self.focus)
                .is_some_and(|field| field.edit(action)),
        }
    }

    fn visible_indices(&self) -> Vec<usize> {
        self.fields
            .iter()
            .enumerate()
            .filter(|(_, field)| field.visible)
            .map(|(index, _)| index)
            .collect()
    }

    fn first_visible(&self) -> Option<usize> {
        self.fields.iter().position(|field| field.visible)
    }

    /// Move the focus, wrapping, over visible fields only.
    fn step(&mut self, forward: bool) {
        let visible = self.visible_indices();
        if visible.is_empty() {
            return;
        }
        let at = visible.iter().position(|index| *index == self.focus);
        let next = match (at, forward) {
            (Some(at), true) => (at + 1) % visible.len(),
            (Some(at), false) => (at + visible.len() - 1) % visible.len(),
            (None, _) => 0,
        };
        self.focus = visible[next];
    }

    /// The rows this form wants, before the panel caps them.
    #[must_use]
    pub fn height(&self) -> usize {
        self.lines_len().max(1)
    }

    fn lines_len(&self) -> usize {
        self.fields.iter().filter(|field| field.visible).count()
            + self
                .fields
                .iter()
                .filter(|field| field.visible && field.note.is_some())
                .count()
            + usize::from(self.notice.is_some())
    }

    /// The label column's width, capped so a long label cannot eat the value.
    fn label_columns(&self) -> usize {
        self.fields
            .iter()
            .filter(|field| field.visible)
            .map(|field| UnicodeWidthStr::width(field.label.as_str()))
            .max()
            .unwrap_or(0)
            .min(MAX_LABEL_COLUMNS)
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// One drawn line, and where the caret sits in it.
pub struct Line {
    /// The spans, relative to the panel's inner width.
    pub spans: Vec<Span>,
    /// Caret column within the inner width, when this line owns the caret.
    pub caret: Option<usize>,
}

/// Draw the form into `inner` columns, showing at most `max` lines.
///
/// Scrolls to keep the focused field on screen, by the rule the select overlay
/// already uses for its highlight — a form taller than a small terminal must
/// lose its top rows, never its caret.
#[must_use]
pub fn render(theme: &Theme, form: &Form, inner: usize, max: usize) -> Vec<Line> {
    let label_columns = form.label_columns();
    let mut lines: Vec<Line> = Vec::with_capacity(form.height());
    let mut caret_line = 0usize;

    for (index, field) in form.fields.iter().enumerate() {
        if !field.visible {
            continue;
        }
        let focused = index == form.focus;
        if focused {
            caret_line = lines.len();
        }
        lines.push(field_line(theme, field, focused, label_columns, inner));
        if let Some(note) = &field.note {
            lines.push(note_line(theme, note, label_columns, inner, true));
        }
    }
    if let Some(notice) = &form.notice {
        lines.push(note_line(theme, notice, label_columns, inner, false));
    }
    if lines.is_empty() {
        lines.push(Line {
            spans: vec![Span::new("nothing to fill in".to_owned(), theme.faint())],
            caret: None,
        });
    }

    let viewport = max.max(1).min(lines.len());
    let first = caret_line
        .saturating_sub(viewport.saturating_sub(1))
        .min(lines.len() - viewport);
    lines.drain(..first);
    lines.truncate(viewport);
    lines
}

/// `▸ label   value                       detail`
fn field_line(theme: &Theme, field: &Field, focused: bool, label_columns: usize, inner: usize) -> Line {
    let marker = if focused {
        Span::new("▸ ", theme.accent())
    } else {
        Span::new("  ", Style::default())
    };
    let label = truncate(&field.label, label_columns);
    let label_pad = label_columns.saturating_sub(UnicodeWidthStr::width(label.as_str())) + 1;
    let value_column = MARKER_COLUMNS + label_columns + 1;
    let room = inner.saturating_sub(value_column);

    let (value, caret_offset) = field.display();
    let shown = truncate(&value, room);
    let shown_width = UnicodeWidthStr::width(shown.as_str());
    let value_style = match (focused, field.is_empty()) {
        (true, _) => theme.text(),
        (false, false) => theme.muted(),
        (false, true) => theme.faint(),
    };

    let mut spans = vec![
        marker,
        Span::new(label, theme.faint()),
        Span::new(" ".repeat(label_pad), Style::default()),
        Span::new(shown, value_style),
    ];
    let mut used = value_column + shown_width;

    // A choice field explains itself where a text field would show nothing.
    if let Some(detail) = field.selected().and_then(|option| option.detail.clone()) {
        let available = field.selected().is_some_and(|option| option.available);
        let space = inner.saturating_sub(used);
        if space > 4 {
            let detail = truncate(&detail, space - 2);
            let width = UnicodeWidthStr::width(detail.as_str());
            spans.push(Span::new(
                " ".repeat(inner - used - width),
                Style::default(),
            ));
            spans.push(Span::new(
                detail,
                if available { theme.faint() } else { theme.warning() },
            ));
            used = inner;
        }
    }
    spans.push(Span::new(
        " ".repeat(inner.saturating_sub(used)),
        Style::default(),
    ));

    Line {
        spans,
        caret: focused.then(|| (value_column + caret_offset.min(room)).min(inner)),
    }
}

/// `  └─ message` under a field, or `  ⟳ message` under the form.
fn note_line(theme: &Theme, notice: &Notice, label_columns: usize, inner: usize, under_field: bool) -> Line {
    let indent = if under_field {
        MARKER_COLUMNS + label_columns + 1
    } else {
        MARKER_COLUMNS
    };
    let lead = if under_field {
        "└─ "
    } else {
        notice.tone.glyph()
    };
    let room = inner.saturating_sub(indent + UnicodeWidthStr::width(lead));
    let text = truncate(&notice.text, room);
    let used = indent + UnicodeWidthStr::width(lead) + UnicodeWidthStr::width(text.as_str());
    Line {
        spans: vec![
            Span::new(" ".repeat(indent), Style::default()),
            Span::new(lead.to_owned(), notice.tone.style(theme)),
            Span::new(text, notice.tone.style(theme)),
            Span::new(" ".repeat(inner.saturating_sub(used)), Style::default()),
        ],
        caret: None,
    }
}

/// A form's lines as plain [`Row`]s, for tests and for any caller that wants
/// the content without the panel frame.
#[must_use]
pub fn rows(theme: &Theme, form: &Form, inner: usize, max: usize) -> Vec<Row> {
    render(theme, form, inner, max)
        .into_iter()
        .map(|line| Row { spans: line.spans })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "sk-live-9f1c0d";

    fn form() -> Form {
        Form::new(vec![
            Field::text("provider", "provider", "openai"),
            Field::choice(
                "persist",
                "credential",
                vec![
                    Opt::new("keychain", "OS keychain")
                        .with_detail(Some("the token never enters a file".to_owned())),
                    Opt::new("plaintext", "providers.toml"),
                    Opt::new("env", "environment variable"),
                ],
                Some("keychain"),
            ),
            Field::secret("apiKey", "api key"),
        ])
    }

    fn text(rows: &[Row]) -> String {
        rows.iter()
            .map(Row::plain_text)
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn typed(form: &mut Form, id: &str, text: &str) {
        form.focus(id);
        form.insert(text);
    }

    #[test]
    fn tab_walks_the_fields_and_wraps() {
        let mut form = form();
        assert_eq!(form.focused().map(|f| f.id.as_str()), Some("provider"));
        form.apply(Action::FormNextField);
        assert_eq!(form.focused().map(|f| f.id.as_str()), Some("persist"));
        assert!(!form.on_last());
        form.apply(Action::FormNextField);
        assert_eq!(form.focused().map(|f| f.id.as_str()), Some("apiKey"));
        assert!(form.on_last(), "enter here means submit, not next");
        form.apply(Action::FormNextField);
        assert_eq!(form.focused().map(|f| f.id.as_str()), Some("provider"));
        form.apply(Action::FormPrevField);
        assert_eq!(form.focused().map(|f| f.id.as_str()), Some("apiKey"));
    }

    #[test]
    fn a_hidden_field_is_skipped_by_navigation_and_read_as_absent() {
        let mut form = form();
        typed(&mut form, "apiKey", KEY);
        form.set_visible("apiKey", false);
        assert_eq!(
            form.secret_value("apiKey"),
            None,
            "a hidden credential is not sent, whatever is still in the buffer"
        );
        form.focus("persist");
        form.apply(Action::FormNextField);
        assert_eq!(
            form.focused().map(|f| f.id.as_str()),
            Some("provider"),
            "navigation wraps past the hidden field"
        );
    }

    #[test]
    fn hiding_the_focused_field_moves_the_focus_somewhere_real() {
        let mut form = form();
        form.focus("apiKey");
        form.set_visible("apiKey", false);
        assert_eq!(form.focused().map(|f| f.id.as_str()), Some("provider"));
    }

    #[test]
    fn a_choice_field_cycles_in_both_directions() {
        let mut form = form();
        form.focus("persist");
        assert_eq!(form.value("persist"), "keychain");
        form.apply(Action::FormNextOption);
        assert_eq!(form.value("persist"), "plaintext");
        form.apply(Action::FormPrevOption);
        form.apply(Action::FormPrevOption);
        assert_eq!(form.value("persist"), "env", "wraps backwards");
    }

    #[test]
    fn a_text_field_reads_the_option_keys_as_caret_motion() {
        // One key, the obvious meaning in both kinds of field.
        let mut form = form();
        typed(&mut form, "provider", "!open");
        assert_eq!(
            form.value("provider"),
            "openai!open",
            "a leading `!` is a character here, never the composer's bash mode"
        );
        form.apply(Action::FormPrevOption);
        form.apply(Action::DeleteCharBefore);
        assert_eq!(form.value("provider"), "openai!opn");
    }

    #[test]
    fn the_composers_editing_actions_work_in_a_field() {
        let mut form = form();
        typed(&mut form, "provider", " gateway");
        form.apply(Action::KillWordBefore);
        assert_eq!(form.value("provider"), "openai ");
        form.apply(Action::MoveLineStart);
        form.insert("x");
        assert_eq!(form.value("provider"), "xopenai ");
    }

    #[test]
    fn a_secret_renders_as_bullets_and_never_as_itself() {
        let theme = Theme::lyra();
        let mut form = form();
        typed(&mut form, "apiKey", KEY);
        assert_eq!(
            form.secret_value("apiKey").map(|s| s.expose().to_owned()),
            Some(KEY.to_owned()),
            "the wizard can still read it deliberately"
        );
        assert_eq!(
            form.field("apiKey").map(Field::value),
            Some(String::new()),
            "the ordinary accessor cannot"
        );

        let drawn = rows(&theme, &form, 60, 12);
        let printed = text(&drawn);
        assert!(printed.contains(&BULLET.repeat(KEY.chars().count())), "{printed}");
        for row in &drawn {
            let plain = row.plain_text();
            assert!(!plain.contains(KEY), "the key reached a rendered row: {plain}");
            assert!(!plain.contains("sk-"), "even a prefix of it: {plain}");
        }
    }

    #[test]
    fn a_secret_never_reaches_debug_output() {
        let mut form = form();
        typed(&mut form, "apiKey", KEY);
        let printed = format!("{form:?}");
        assert!(!printed.contains(KEY), "{printed}");
        assert!(!printed.contains("sk-"), "{printed}");
        assert!(printed.contains("redacted"), "and it says so: {printed}");
        // The length is not the secret, and a form with nothing typed into it is
        // a different bug report from one with a key in it.
        assert!(printed.contains("14 graphemes"), "{printed}");
    }

    #[test]
    fn backspacing_a_secret_shortens_the_bullets() {
        let theme = Theme::lyra();
        let mut form = form();
        typed(&mut form, "apiKey", "abcd");
        form.apply(Action::DeleteCharBefore);
        let printed = text(&rows(&theme, &form, 60, 12));
        assert!(printed.contains(&BULLET.repeat(3)), "{printed}");
        assert!(!printed.contains(&BULLET.repeat(4)), "{printed}");
    }

    #[test]
    fn every_rendered_line_is_exactly_the_inner_width() {
        let theme = Theme::lyra();
        let mut form = form();
        typed(&mut form, "apiKey", KEY);
        form.set_note("provider", Some(Notice::error("must be lowercase")));
        form.notice = Some(Notice::pending("checking https://api.openai.com/v1"));
        for inner in [20usize, 40, 76] {
            for line in render(&theme, &form, inner, 12) {
                let width: usize = line
                    .spans
                    .iter()
                    .map(|span| UnicodeWidthStr::width(span.text.as_str()))
                    .sum();
                assert_eq!(width, inner, "inner {inner}: {:?}", Row {
                    spans: line.spans.clone()
                }
                .plain_text());
            }
        }
    }

    #[test]
    fn a_message_appears_under_its_own_field() {
        let theme = Theme::lyra();
        let mut form = form();
        form.set_note("provider", Some(Notice::error("must be lowercase")));
        let printed = text(&rows(&theme, &form, 60, 12));
        let lines: Vec<&str> = printed.lines().collect();
        assert!(lines[0].contains("provider"));
        assert!(lines[1].contains("must be lowercase"), "{printed}");
        form.clear_notes();
        assert!(!text(&rows(&theme, &form, 60, 12)).contains("must be lowercase"));
    }

    #[test]
    fn a_form_taller_than_the_panel_scrolls_to_keep_the_caret() {
        let theme = Theme::lyra();
        let fields: Vec<Field> = (0..10)
            .map(|n| Field::text(format!("f{n}"), format!("field {n}"), &format!("value {n}")))
            .collect();
        let mut form = Form::new(fields);
        form.focus("f9");
        let drawn = rows(&theme, &form, 60, 4);
        assert_eq!(drawn.len(), 4);
        let printed = text(&drawn);
        assert!(printed.contains("value 9"), "{printed}");
        assert!(!printed.contains("value 0"), "{printed}");
        let caret = render(&theme, &form, 60, 4)
            .into_iter()
            .position(|line| line.caret.is_some());
        assert_eq!(caret, Some(3), "the caret is inside the window it scrolled to");
    }

    #[test]
    fn an_unavailable_choice_is_shown_with_its_reason_rather_than_hidden() {
        let theme = Theme::lyra();
        let form = Form::new(vec![Field::choice(
            "persist",
            "credential",
            vec![Opt::new("keychain", "OS keychain")
                .with_detail(Some("unavailable here · install secret-tool".to_owned()))
                .available(false)],
            None,
        )]);
        let printed = text(&rows(&theme, &form, 70, 12));
        assert!(printed.contains("unavailable here"), "{printed}");
    }
}
