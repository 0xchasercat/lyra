//! `@` mentions and `/` commands: the trigger, and the popup it feeds.
//!
//! This module owns *noticing* — that the caret sits inside an `@token` or a
//! leading `/command` — and the popup state machine that results. It
//! deliberately does not own the answer: file ranking is a daemon concern
//! (DESIGN.md §4, "server-ranked, **not re-sorted**") and the command list is
//! the registry `session/commands` declares.
//!
//! # Who fills it
//!
//! [`crate::app`] does, through [`CompletionState::set_items`]: `/` from the
//! command registry it already holds, `@` from a debounced `session/complete`
//! round trip whose answer lands a frame or two later. That path has to be
//! asynchronous — a frame may never block on the daemon — which is why it is
//! the app's and not a trait's.
//!
//! [`CompletionSource`] remains the **synchronous** seam, for a caller that can
//! answer a request without a round trip; [`NoCompletions`] is its null
//! implementation, and a popup with no source simply never opens.
//!
//! # Ranking
//!
//! [`CompletionState::set_items`] stores candidates **in the order given**. That
//! is a rule, not an omission: the server has already ranked them with context
//! this process does not have, and a client-side re-sort would silently override
//! it.

/// What is being completed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionKind {
    /// `@path/to/file` — a file mention.
    Mention,
    /// `/command` at the start of the buffer.
    Command,
}

/// A request for candidates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionRequest {
    /// Which trigger fired.
    pub kind: CompletionKind,
    /// The text between the trigger character and the caret.
    pub query: String,
    /// Atom index of the trigger character (`@` or `/`).
    pub trigger_at: usize,
    /// Atom index of the caret when the request was made.
    pub caret_at: usize,
}

/// One candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionItem {
    /// What the popup shows.
    pub label: String,
    /// Optional right-hand detail (a directory, a description).
    pub detail: Option<String>,
    /// What replaces `trigger_at..caret_at`, trigger character included.
    pub insert: String,
}

impl CompletionItem {
    /// A candidate whose label is also what it inserts.
    #[must_use]
    pub fn new(label: impl Into<String>, insert: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            detail: None,
            insert: insert.into(),
        }
    }

    /// Attach detail text.
    #[must_use]
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

/// Where candidates come from.
///
/// The boundary with the ACP layer: phase 6 implements this over a
/// `session/complete` round trip.
pub trait CompletionSource {
    /// Candidates for a request, already ranked. May be empty.
    fn complete(&self, request: &CompletionRequest) -> Vec<CompletionItem>;
}

/// The null source. Answers nothing, so the popup never opens.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoCompletions;

impl CompletionSource for NoCompletions {
    fn complete(&self, _request: &CompletionRequest) -> Vec<CompletionItem> {
        Vec::new()
    }
}

/// Whether a `/name` is a real command, for the recognised-command highlight.
///
/// Separate from [`CompletionSource`] because the highlight must be answerable
/// synchronously on every keystroke, while completion may be a round trip.
pub trait CommandSource {
    /// Whether `name` (without its slash) is a command.
    fn is_command(&self, name: &str) -> bool;
}

/// Recognises nothing. Slash text renders unhighlighted.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoCommands;

impl CommandSource for NoCommands {
    fn is_command(&self, _name: &str) -> bool {
        false
    }
}

/// The popup's state.
#[derive(Debug, Clone, Default)]
pub struct CompletionState {
    request: Option<CompletionRequest>,
    items: Vec<CompletionItem>,
    selected: usize,
}

impl CompletionState {
    /// Whether the popup is open. Only true with both a request and candidates —
    /// an open-but-empty popup is a hole in the live region for no information.
    #[must_use]
    pub fn is_open(&self) -> bool {
        self.request.is_some() && !self.items.is_empty()
    }

    /// The request the candidates answer.
    #[must_use]
    pub const fn request(&self) -> Option<&CompletionRequest> {
        self.request.as_ref()
    }

    /// The candidates, in server order.
    #[must_use]
    pub fn items(&self) -> &[CompletionItem] {
        &self.items
    }

    /// Index of the highlighted candidate.
    #[must_use]
    pub const fn selected(&self) -> usize {
        self.selected
    }

    /// The highlighted candidate.
    #[must_use]
    pub fn current(&self) -> Option<&CompletionItem> {
        self.items.get(self.selected)
    }

    /// Open, or update, the request. Clears stale candidates.
    pub fn request_for(&mut self, request: CompletionRequest) {
        if self.request.as_ref() != Some(&request) {
            self.items.clear();
            self.selected = 0;
        }
        self.request = Some(request);
    }

    /// Install candidates **in the order given**.
    pub fn set_items(&mut self, items: Vec<CompletionItem>) {
        self.selected = 0;
        self.items = items;
    }

    /// Close the popup.
    pub fn dismiss(&mut self) {
        self.request = None;
        self.items.clear();
        self.selected = 0;
    }

    /// Move the selection, wrapping.
    pub fn select_next(&mut self) {
        if !self.items.is_empty() {
            self.selected = (self.selected + 1) % self.items.len();
        }
    }

    /// Move the selection back, wrapping.
    pub fn select_prev(&mut self) {
        if !self.items.is_empty() {
            self.selected = (self.selected + self.items.len() - 1) % self.items.len();
        }
    }
}

/// Characters that may appear in a mention after the `@`.
///
/// Deliberately includes `/`, `.`, `-` and `_` so `@src/auth/token.ts` is one
/// mention, and excludes whitespace so a mention ends where a word does.
fn is_mention_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '/' | '.' | '-' | '_' | '~' | '@' | '+')
}

/// Detect a trigger in `text` at grapheme-independent `caret` (a char index).
///
/// `text` is the composer's *display* text with chips already reduced to a
/// single placeholder char, so indices line up with atom indices.
#[must_use]
pub fn detect(text: &str, caret: usize) -> Option<CompletionRequest> {
    let chars: Vec<char> = text.chars().collect();
    let caret = caret.min(chars.len());

    // `/command`: only at the very start of the buffer, and only while the caret
    // is still inside the first token.
    if chars.first() == Some(&'/') {
        let end = chars
            .iter()
            .position(|c| c.is_whitespace())
            .unwrap_or(chars.len());
        if caret <= end {
            return Some(CompletionRequest {
                kind: CompletionKind::Command,
                query: chars[1..caret.max(1)].iter().collect(),
                trigger_at: 0,
                caret_at: caret,
            });
        }
    }

    // `@mention`: walk back over mention characters to an `@` that is itself at
    // the start of the buffer or preceded by whitespace.
    let mut at = caret;
    while at > 0 && is_mention_char(chars[at - 1]) && chars[at - 1] != '@' {
        at -= 1;
    }
    if at == 0 || chars[at - 1] != '@' {
        return None;
    }
    let trigger = at - 1;
    if trigger > 0 && !chars[trigger - 1].is_whitespace() {
        return None;
    }
    Some(CompletionRequest {
        kind: CompletionKind::Mention,
        query: chars[at..caret].iter().collect(),
        trigger_at: trigger,
        caret_at: caret,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mention(text: &str) -> Option<CompletionRequest> {
        detect(text, text.chars().count())
    }

    #[test]
    fn an_at_sign_at_the_caret_opens_an_empty_mention_query() {
        let request = mention("look at @").unwrap();
        assert_eq!(request.kind, CompletionKind::Mention);
        assert_eq!(request.query, "");
        assert_eq!(request.trigger_at, 8);
    }

    #[test]
    fn a_mention_captures_a_whole_path() {
        let request = mention("see @src/auth/token.ts").unwrap();
        assert_eq!(request.query, "src/auth/token.ts");
        assert_eq!(request.trigger_at, 4);
    }

    #[test]
    fn an_email_address_is_not_a_mention() {
        assert_eq!(mention("mail me@example.com"), None);
    }

    #[test]
    fn a_mention_ends_at_whitespace() {
        assert_eq!(mention("@src/a.ts and then"), None);
        let request = detect("@src/a.ts and then", 5).unwrap();
        assert_eq!(request.query, "src/");
    }

    #[test]
    fn a_leading_slash_is_a_command_while_the_caret_is_in_the_first_token() {
        let request = mention("/mod").unwrap();
        assert_eq!(request.kind, CompletionKind::Command);
        assert_eq!(request.query, "mod");
        let request = detect("/model gpt", 4).unwrap();
        assert_eq!(request.kind, CompletionKind::Command);
        assert_eq!(request.query, "mod");
        assert_eq!(detect("/model gpt", 9), None, "past the first token");
    }

    #[test]
    fn a_slash_that_is_not_at_the_start_is_not_a_command() {
        assert_eq!(mention("read a/b"), None);
    }

    #[test]
    fn plain_text_triggers_nothing() {
        assert_eq!(mention("just a sentence"), None);
        assert_eq!(mention(""), None);
    }

    #[test]
    fn the_popup_only_opens_when_there_is_something_to_show() {
        let mut state = CompletionState::default();
        state.request_for(mention("@sr").unwrap());
        assert!(!state.is_open(), "a request with no candidates is not a popup");
        state.set_items(vec![CompletionItem::new("src/", "@src/")]);
        assert!(state.is_open());
        state.dismiss();
        assert!(!state.is_open());
    }

    #[test]
    fn candidates_are_kept_in_the_order_the_source_gave_them() {
        let mut state = CompletionState::default();
        state.request_for(mention("@a").unwrap());
        let items = vec![
            CompletionItem::new("zebra.ts", "@zebra.ts"),
            CompletionItem::new("apple.ts", "@apple.ts"),
        ];
        state.set_items(items.clone());
        assert_eq!(state.items(), items.as_slice(), "no client-side re-sort");
    }

    #[test]
    fn selection_wraps_in_both_directions() {
        let mut state = CompletionState::default();
        state.request_for(mention("@a").unwrap());
        state.set_items(vec![
            CompletionItem::new("one", "one"),
            CompletionItem::new("two", "two"),
        ]);
        state.select_next();
        assert_eq!(state.selected(), 1);
        state.select_next();
        assert_eq!(state.selected(), 0);
        state.select_prev();
        assert_eq!(state.selected(), 1);
    }

    #[test]
    fn a_changed_request_drops_stale_candidates() {
        let mut state = CompletionState::default();
        state.request_for(mention("@a").unwrap());
        state.set_items(vec![CompletionItem::new("a.ts", "@a.ts")]);
        state.request_for(mention("@ab").unwrap());
        assert!(
            !state.is_open(),
            "candidates for the previous query must not be shown for this one"
        );
    }

    #[test]
    fn the_null_source_never_opens_the_popup() {
        let request = mention("@x").unwrap();
        assert!(NoCompletions.complete(&request).is_empty());
        assert!(!NoCommands.is_command("model"));
    }
}
