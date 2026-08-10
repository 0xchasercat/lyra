//! The composer: the editor in the live region (DESIGN.md §4).
//!
//! # The buffer is atoms, not a string
//!
//! Every editing operation works on a `Vec<Atom>`, where an atom is either one
//! grapheme cluster or one paste chip. That single choice buys most of the
//! spec at once:
//!
//! - a chip is deleted by **one** `Backspace`, stepped over by **one** `Left`,
//!   and never split by wrapping, because it is one atom;
//! - the caret is an index, so it can never land inside a grapheme cluster and
//!   produce the mojibake a byte offset invites;
//! - the kill ring holds atoms, so `Ctrl+W` over a chip and `Ctrl+Y` back
//!   restores the chip rather than its label.
//!
//! # Line semantics
//!
//! Two notions of "line" coexist, deliberately:
//!
//! - `Ctrl+A`/`Ctrl+E`/`Ctrl+K`/`Ctrl+U` work on **logical** lines — the text
//!   between hard newlines. That is what readline does and what a user who types
//!   `Ctrl+K` means.
//! - `Up`/`Down` (when they are not history recall) move by **visual** lines,
//!   using the width the UI last set. That is what a user who can see wrapped
//!   text means.
//!
//! # What lives elsewhere
//!
//! Queueing, steering and the Esc ladder are *not* here: the composer never
//! decides whether a submission is sent or queued. It produces a
//! [`Submission`]; [`super::queue`] decides what happens to it.

use std::collections::HashMap;

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use super::chips::{should_collapse, ChipId, PasteChip};
use super::completion::{
    detect, CommandSource, CompletionRequest, CompletionState, NoCommands,
};
use super::history::{History, Recall};
use super::killring::{KillDirection, KillRing};
use super::undo::{EditKind, UndoStack};
use super::wrap::{locate, wrap, Piece, PieceKind};
use crate::keybind::Action;

/// The character a chip occupies in the composer's *logical* text.
///
/// `U+FFFC OBJECT REPLACEMENT CHARACTER` is the Unicode-sanctioned stand-in for
/// embedded content. It is neither whitespace nor a mention character, so a chip
/// terminates an `@mention` exactly the way a space would.
pub const CHIP_PLACEHOLDER: char = '\u{fffc}';

/// One editable unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Atom {
    /// A grapheme cluster. `"\n"` is a hard line break.
    Grapheme(String),
    /// A collapsed paste.
    Chip(ChipId),
}

impl Atom {
    /// A grapheme atom.
    fn grapheme(text: &str) -> Self {
        Self::Grapheme(text.to_owned())
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            Self::Grapheme(text) => Some(text),
            Self::Chip(_) => None,
        }
    }

    fn is_newline(&self) -> bool {
        self.as_str() == Some("\n")
    }

    /// Whether this atom is part of a word, for `Alt+B`/`Alt+F`/`Ctrl+W`.
    /// A chip is a word of its own.
    fn is_word(&self) -> bool {
        match self {
            Self::Grapheme(text) => text
                .chars()
                .next()
                .is_some_and(|c| c.is_alphanumeric() || c == '_'),
            Self::Chip(_) => true,
        }
    }
}

/// Prompt or shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ComposerMode {
    /// An ordinary prompt.
    #[default]
    Prompt,
    /// `!` bash mode: the border flips colour and the text is a shell command.
    /// One-shot — it resets after every submission.
    Bash,
}

/// A finished composition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Submission {
    /// The text, with every chip expanded losslessly.
    pub text: String,
    /// Which mode produced it.
    pub mode: ComposerMode,
}

/// What an action did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposerOutcome {
    /// The composer handled it.
    Handled,
    /// The composer does not bind this action; the caller should try the next
    /// layer. Returned by `Up`/`Down` when neither recall nor motion applies,
    /// which is what lets `Up` at the top of a buffer fall through.
    Ignored,
    /// A submission is ready. The caller decides whether it is sent or queued.
    Submit(Submission),
}

/// How an atom should be painted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// Ordinary text.
    Text,
    /// A paste chip placeholder.
    Chip,
    /// A leading `/command`. `recognised` drives DESIGN.md §4's highlight.
    Command {
        /// Whether a [`CommandSource`] knows this name.
        recognised: bool,
    },
    /// An `@mention`.
    Mention,
}

/// A run of display text sharing one class.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    /// The text to draw.
    pub text: String,
    /// How to paint it.
    pub class: Class,
}

/// The composer, laid out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    /// Visual rows.
    pub rows: Vec<Vec<Segment>>,
    /// Caret `(row, column)` in display units.
    pub caret: (usize, usize),
}

/// Undo snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Snapshot {
    atoms: Vec<Atom>,
    cursor: usize,
    mode: ComposerMode,
}

/// The editor.
#[derive(Debug)]
pub struct Composer {
    atoms: Vec<Atom>,
    cursor: usize,
    chips: HashMap<ChipId, PasteChip>,
    next_chip: ChipId,
    kills: KillRing<Atom>,
    undo: UndoStack<Snapshot>,
    mode: ComposerMode,
    history: History,
    recall: Recall,
    /// Buffer displaced by history recall, restored on walking past the newest.
    stash: Option<Vec<Atom>>,
    completion: CompletionState,
    /// Set when the last action was a yank, so `Alt+Y` knows what to replace.
    last_yank: Option<(usize, usize)>,
    width: usize,
}

impl Default for Composer {
    fn default() -> Self {
        Self::new(History::in_memory())
    }
}

impl Composer {
    /// An empty composer over a history store.
    #[must_use]
    pub fn new(history: History) -> Self {
        Self {
            atoms: Vec::new(),
            cursor: 0,
            chips: HashMap::new(),
            next_chip: 0,
            kills: KillRing::default(),
            undo: UndoStack::default(),
            mode: ComposerMode::Prompt,
            history,
            recall: Recall::default(),
            stash: None,
            completion: CompletionState::default(),
            last_yank: None,
            width: 80,
        }
    }

    // -- queries -----------------------------------------------------------

    /// Whether the buffer holds nothing. Bash mode alone does not count as
    /// content, but it does keep `Backspace` meaningful.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.atoms.is_empty()
    }

    /// Atom count.
    #[must_use]
    pub fn len(&self) -> usize {
        self.atoms.len()
    }

    /// Caret position, as an atom index.
    #[must_use]
    pub const fn cursor(&self) -> usize {
        self.cursor
    }

    /// Current mode.
    #[must_use]
    pub const fn mode(&self) -> ComposerMode {
        self.mode
    }

    /// The completion popup's state.
    #[must_use]
    pub const fn completion(&self) -> &CompletionState {
        &self.completion
    }

    /// Mutable access to the completion popup, for the caller that feeds it.
    pub const fn completion_mut(&mut self) -> &mut CompletionState {
        &mut self.completion
    }

    /// The history store.
    #[must_use]
    pub const fn history(&self) -> &History {
        &self.history
    }

    /// The full text, with every chip expanded. This is what is sent.
    #[must_use]
    pub fn text(&self) -> String {
        self.expand(&self.atoms)
    }

    /// The buffer as **exactly one `char` per atom**.
    ///
    /// A grapheme cluster contributes its base character and a chip contributes
    /// [`CHIP_PLACEHOLDER`]. That is what makes a char offset in this string an
    /// atom index, and it is why `@`/`/` detection and the paint-class scan can
    /// both be plain string walks with no index translation — the class of bug
    /// that produces a highlight one column off after an emoji.
    ///
    /// It is deliberately **not** the text to send: for that, see
    /// [`Composer::text`].
    #[must_use]
    pub fn logical_text(&self) -> String {
        self.atoms
            .iter()
            .map(|atom| match atom {
                Atom::Grapheme(text) => text.chars().next().unwrap_or(' '),
                Atom::Chip(_) => CHIP_PLACEHOLDER,
            })
            .collect()
    }

    /// Tell the composer how wide it is. Used by visual-line motion and layout.
    pub const fn set_width(&mut self, width: usize) {
        self.width = if width == 0 { 1 } else { width };
    }

    fn expand(&self, atoms: &[Atom]) -> String {
        let mut text = String::new();
        for atom in atoms {
            match atom {
                Atom::Grapheme(grapheme) => text.push_str(grapheme),
                Atom::Chip(id) => {
                    if let Some(chip) = self.chips.get(id) {
                        text.push_str(&chip.payload);
                    }
                }
            }
        }
        text
    }

    // -- mutation ----------------------------------------------------------

    /// Replace the whole buffer, e.g. when the Esc ladder pops a queued item
    /// back for editing.
    pub fn set_text(&mut self, text: &str) {
        let before = self.snapshot();
        self.undo.begin_group(&before);
        self.atoms = graphemes(text);
        self.cursor = self.atoms.len();
        self.undo.end_group();
        self.after_edit();
    }

    /// Empty the buffer and return what it held, expanded.
    ///
    /// Chip payloads are dropped with it: a cleared composer must not keep a
    /// megabyte of pasted text alive for the rest of the session.
    pub fn clear(&mut self) -> String {
        let text = self.text();
        let before = self.snapshot();
        self.undo.begin_group(&before);
        self.atoms.clear();
        self.cursor = 0;
        self.mode = ComposerMode::Prompt;
        self.chips.clear();
        self.undo.end_group();
        self.after_edit();
        text
    }

    /// Insert typed text at the caret.
    ///
    /// This is the only path a printable keystroke takes. `!` in an empty
    /// prompt-mode buffer flips to bash mode instead of being inserted
    /// (DESIGN.md §4: "`!` bash mode (border flips colour, one-shot)").
    pub fn insert_text(&mut self, text: &str) {
        if text == "!" && self.atoms.is_empty() && self.mode == ComposerMode::Prompt {
            self.mode = ComposerMode::Bash;
            return;
        }
        self.insert_literal(text);
    }

    /// Insert typed text with **no mode magic**.
    ///
    /// [`Composer::insert_text`] reads a leading `!` as the bash-mode trigger,
    /// which is right for the prompt and wrong for every other consumer of this
    /// editor: in a provider-setup field a leading `!` is a character of a
    /// credential, not a request for a shell. The form
    /// ([`crate::ui::form`]) therefore types through this door.
    pub fn insert_literal(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let atoms = graphemes(text);
        self.edit(EditKind::Insert, |composer| {
            let at = composer.cursor;
            composer.splice(at, at, atoms);
        });
    }

    /// The text to the left of the caret, chips expanded.
    ///
    /// What a single-line consumer measures to place its own caret: the
    /// composer's own layout does it in display columns, and a form field that
    /// re-derived the width from the atom count would sit one column off after
    /// the first wide grapheme.
    #[must_use]
    pub fn text_before_cursor(&self) -> String {
        self.expand(&self.atoms[..self.cursor.min(self.atoms.len())])
    }

    /// Handle a bracketed paste.
    ///
    /// Three outcomes, in order:
    ///
    /// 1. **Repaste-to-expand.** A paste byte-identical to the chip immediately
    ///    before the caret expands that chip in place. Pasting the same thing
    ///    twice is how a user asks to see it.
    /// 2. **Collapse.** A paste of ≥3 lines or >150 characters becomes a chip.
    /// 3. **Literal.** Anything smaller is inserted as text.
    pub fn paste(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        if let Some((index, id)) = self.repastable_chip(text) {
            let atoms = graphemes(text);
            self.edit(EditKind::Paste, |composer| {
                composer.splice(index, index + 1, atoms);
            });
            self.chips.remove(&id);
            return;
        }
        if should_collapse(text) {
            let id = self.next_chip;
            self.next_chip += 1;
            self.chips.insert(id, PasteChip::new(id, text));
            self.edit(EditKind::Paste, |composer| {
                let at = composer.cursor;
                composer.splice(at, at, vec![Atom::Chip(id)]);
            });
            return;
        }
        let atoms = graphemes(text);
        self.edit(EditKind::Paste, |composer| {
            let at = composer.cursor;
            composer.splice(at, at, atoms);
        });
    }

    /// Run a keybinding action.
    #[allow(clippy::too_many_lines)]
    pub fn apply(&mut self, action: Action) -> ComposerOutcome {
        match action {
            Action::Submit => self.submit(),
            Action::Newline => {
                self.insert_text("\n");
                ComposerOutcome::Handled
            }
            Action::DeleteCharBefore => self.delete_before(),
            Action::DeleteCharAfter => {
                if self.cursor < self.atoms.len() {
                    let at = self.cursor;
                    self.edit(EditKind::Delete, |composer| {
                        composer.splice(at, at + 1, Vec::new());
                        composer.cursor = at;
                    });
                }
                ComposerOutcome::Handled
            }
            Action::MoveCharLeft => self.move_to(self.cursor.saturating_sub(1)),
            Action::MoveCharRight => self.move_to((self.cursor + 1).min(self.atoms.len())),
            Action::MoveWordLeft => self.move_to(self.word_start()),
            Action::MoveWordRight => self.move_to(self.word_end()),
            Action::MoveLineStart => self.move_to(self.line_start()),
            Action::MoveLineEnd => self.move_to(self.line_end()),
            Action::MoveBufferStart => self.move_to(0),
            Action::MoveBufferEnd => self.move_to(self.atoms.len()),
            Action::KillToLineEnd => {
                let (from, to) = (self.cursor, self.line_end());
                self.kill(from, to, KillDirection::Forward)
            }
            Action::KillToLineStart => {
                let (from, to) = (self.line_start(), self.cursor);
                self.kill(from, to, KillDirection::Backward)
            }
            Action::KillWordBefore => {
                let (from, to) = (self.word_start(), self.cursor);
                self.kill(from, to, KillDirection::Backward)
            }
            Action::KillWordAfter => {
                let (from, to) = (self.cursor, self.word_end());
                self.kill(from, to, KillDirection::Forward)
            }
            Action::Yank => self.yank(),
            Action::YankPop => self.yank_pop(),
            Action::TransposeChars => self.transpose(),
            Action::Undo => {
                let current = self.snapshot();
                if let Some(previous) = self.undo.undo(&current) {
                    self.restore(previous);
                }
                ComposerOutcome::Handled
            }
            Action::Redo => {
                let current = self.snapshot();
                if let Some(next) = self.undo.redo(&current) {
                    self.restore(next);
                }
                ComposerOutcome::Handled
            }
            Action::HistoryPrev => self.history_prev(),
            Action::HistoryNext => self.history_next(),
            _ => ComposerOutcome::Ignored,
        }
    }

    /// Produce a submission, if there is anything to submit.
    ///
    /// Records history and resets the composer, including the one-shot bash
    /// mode. Returns [`ComposerOutcome::Handled`] for an empty buffer so an
    /// accidental `Enter` is inert rather than sending nothing.
    pub fn submit(&mut self) -> ComposerOutcome {
        if self.atoms.is_empty() {
            return ComposerOutcome::Handled;
        }
        let text = self.text();
        let mode = self.mode;
        self.history.record(&text);
        self.atoms.clear();
        self.chips.clear();
        self.cursor = 0;
        self.mode = ComposerMode::Prompt;
        self.undo = UndoStack::default();
        self.recall.reset();
        self.stash = None;
        self.completion.dismiss();
        self.last_yank = None;
        ComposerOutcome::Submit(Submission { text, mode })
    }

    fn delete_before(&mut self) -> ComposerOutcome {
        if self.cursor == 0 {
            // `Backspace` at offset 0 leaves bash mode: the flip must be
            // reversible by the same key that would have deleted the `!`.
            if self.mode == ComposerMode::Bash {
                self.mode = ComposerMode::Prompt;
            }
            return ComposerOutcome::Handled;
        }
        let at = self.cursor - 1;
        self.edit(EditKind::Delete, |composer| {
            composer.splice(at, at + 1, Vec::new());
            composer.cursor = at;
        });
        ComposerOutcome::Handled
    }

    fn move_to(&mut self, index: usize) -> ComposerOutcome {
        let index = index.min(self.atoms.len());
        if index != self.cursor {
            self.undo.caret_jumped();
            self.kills.interrupt();
            self.last_yank = None;
        }
        self.cursor = index;
        self.refresh_completion();
        ComposerOutcome::Handled
    }

    fn kill(&mut self, from: usize, to: usize, direction: KillDirection) -> ComposerOutcome {
        if from >= to {
            return ComposerOutcome::Handled;
        }
        let killed = self.atoms[from..to].to_vec();
        self.edit_raw(EditKind::Kill, |composer| {
            composer.splice(from, to, Vec::new());
            composer.cursor = from;
        });
        self.kills.kill(killed, direction);
        self.last_yank = None;
        ComposerOutcome::Handled
    }

    fn yank(&mut self) -> ComposerOutcome {
        let Some(items) = self.kills.yank().map(<[Atom]>::to_vec) else {
            return ComposerOutcome::Handled;
        };
        let at = self.cursor;
        let count = items.len();
        self.edit(EditKind::Yank, |composer| {
            composer.splice(at, at, items);
        });
        self.last_yank = Some((at, at + count));
        ComposerOutcome::Handled
    }

    fn yank_pop(&mut self) -> ComposerOutcome {
        let Some((from, to)) = self.last_yank else {
            return ComposerOutcome::Handled;
        };
        let Some(items) = self.kills.rotate().map(<[Atom]>::to_vec) else {
            return ComposerOutcome::Handled;
        };
        let count = items.len();
        self.edit(EditKind::Yank, |composer| {
            composer.splice(from, to, items);
        });
        self.last_yank = Some((from, from + count));
        ComposerOutcome::Handled
    }

    fn transpose(&mut self) -> ComposerOutcome {
        // At the end of the buffer, transpose the two atoms behind the caret —
        // the readline behaviour that makes `Ctrl+T` useful while typing.
        let right = if self.cursor >= self.atoms.len() {
            self.atoms.len().checked_sub(1)
        } else {
            Some(self.cursor)
        };
        let Some(right) = right else {
            return ComposerOutcome::Handled;
        };
        let Some(left) = right.checked_sub(1) else {
            return ComposerOutcome::Handled;
        };
        self.edit(EditKind::Replace, |composer| {
            composer.atoms.swap(left, right);
            composer.cursor = (right + 1).min(composer.atoms.len());
        });
        ComposerOutcome::Handled
    }

    // -- history -----------------------------------------------------------

    fn history_prev(&mut self) -> ComposerOutcome {
        // Recall *enters* only from the very start of the buffer; anywhere else
        // `Up` is visual-line motion. Once recall is walking, it keeps walking —
        // otherwise the caret parked at the end of the recalled prompt would
        // make the second `Up` do something else than the first, which is the
        // one thing a history key must never do.
        let may_recall = self.cursor == 0 || self.recall.is_active();
        if let Some(position) = may_recall
            .then(|| self.recall.older(self.history.len()))
            .flatten()
        {
            if self.stash.is_none() {
                self.stash = Some(self.atoms.clone());
            }
            if let Some(text) = self.history.recall(position) {
                let atoms = graphemes(text);
                self.replace_buffer(atoms);
            }
            return ComposerOutcome::Handled;
        }
        self.move_visual_line(-1)
    }

    fn history_next(&mut self) -> ComposerOutcome {
        if self.recall.is_active() {
            match self.recall.newer() {
                Some(position) => {
                    if let Some(text) = self.history.recall(position) {
                        let atoms = graphemes(text);
                        self.replace_buffer(atoms);
                    }
                }
                None => {
                    let stash = self.stash.take().unwrap_or_default();
                    self.replace_buffer(stash);
                }
            }
            return ComposerOutcome::Handled;
        }
        self.move_visual_line(1)
    }

    /// Swap the buffer wholesale, parking the caret at the end.
    ///
    /// End, not start: a recalled prompt is almost always about to be extended
    /// or re-sent, and a caret at offset 0 turns `!` into a bash flip and every
    /// keystroke into a prefix.
    fn replace_buffer(&mut self, atoms: Vec<Atom>) {
        let before = self.snapshot();
        self.undo.begin_group(&before);
        self.atoms = atoms;
        self.cursor = self.atoms.len();
        self.undo.end_group();
        self.refresh_completion();
    }

    /// Move one visual line, keeping the display column where possible.
    ///
    /// Returns [`ComposerOutcome::Ignored`] when there is no line to move to, so
    /// `Up` at the top of the buffer falls through to whatever the caller does
    /// with an unhandled `Up`.
    fn move_visual_line(&mut self, delta: isize) -> ComposerOutcome {
        let pieces = self.pieces();
        let lines = wrap(&pieces, self.width);
        let (row, column) = locate(&pieces, &lines, self.cursor);
        let Some(target) = row.checked_add_signed(delta) else {
            return ComposerOutcome::Ignored;
        };
        let Some(line) = lines.get(target) else {
            return ComposerOutcome::Ignored;
        };
        let mut index = line.start;
        let mut used = 0usize;
        for at in line.clone() {
            if pieces[at].kind == PieceKind::Newline || used >= column {
                break;
            }
            used += pieces[at].width;
            index = at + 1;
        }
        self.move_to(index)
    }

    // -- completion --------------------------------------------------------

    /// Re-run `@`/`/` detection at the caret.
    ///
    /// Called after every edit and every motion. The *request* is produced here;
    /// candidates arrive from a [`super::completion::CompletionSource`] the
    /// caller owns, which is the seam a later phase fills in.
    fn refresh_completion(&mut self) {
        let text = self.logical_text();
        match detect(&text, self.cursor) {
            Some(request) if self.mode == ComposerMode::Prompt => {
                self.completion.request_for(request);
            }
            _ => self.completion.dismiss(),
        }
    }

    /// The completion request the caller should service, if any.
    #[must_use]
    pub fn pending_completion(&self) -> Option<&CompletionRequest> {
        self.completion.request()
    }

    /// Accept a completion, replacing the trigger span.
    pub fn accept_completion(&mut self) -> ComposerOutcome {
        let Some(request) = self.completion.request().cloned() else {
            return ComposerOutcome::Ignored;
        };
        let Some(item) = self.completion.current().cloned() else {
            return ComposerOutcome::Ignored;
        };
        let atoms = graphemes(&item.insert);
        let (from, to) = (request.trigger_at, request.caret_at.min(self.atoms.len()));
        self.edit(EditKind::Replace, |composer| {
            let inserted = atoms.len();
            composer.splice(from, to, atoms);
            composer.cursor = from + inserted;
        });
        self.completion.dismiss();
        ComposerOutcome::Handled
    }

    // -- layout ------------------------------------------------------------

    /// Lay the buffer out at `width` columns.
    #[must_use]
    pub fn layout(&self, width: usize, commands: &dyn CommandSource) -> Layout {
        let width = width.max(1);
        let pieces = self.pieces();
        let lines = wrap(&pieces, width);
        let classes = self.classes(commands);
        let mut rows = Vec::with_capacity(lines.len());
        for line in &lines {
            let mut segments: Vec<Segment> = Vec::new();
            for index in line.clone() {
                let text = match &self.atoms[index] {
                    Atom::Grapheme(grapheme) if grapheme == "\n" => continue,
                    Atom::Grapheme(grapheme) => grapheme.clone(),
                    Atom::Chip(id) => self
                        .chips
                        .get(id)
                        .map_or_else(|| "[pasted]".to_owned(), PasteChip::label),
                };
                let class = classes[index];
                match segments.last_mut() {
                    Some(last) if last.class == class => last.text.push_str(&text),
                    _ => segments.push(Segment { text, class }),
                }
            }
            rows.push(segments);
        }
        Layout {
            rows,
            caret: locate(&pieces, &lines, self.cursor),
        }
    }

    /// Convenience layout with no command recognition.
    #[must_use]
    pub fn layout_plain(&self, width: usize) -> Layout {
        self.layout(width, &NoCommands)
    }

    fn pieces(&self) -> Vec<Piece> {
        self.atoms
            .iter()
            .map(|atom| match atom {
                Atom::Grapheme(text) if text == "\n" => Piece::new(0, PieceKind::Newline),
                Atom::Grapheme(text) if text.chars().all(char::is_whitespace) => {
                    Piece::new(UnicodeWidthStr::width(text.as_str()).max(1), PieceKind::Space)
                }
                Atom::Grapheme(text) => {
                    let width = UnicodeWidthStr::width(text.as_str()).max(1);
                    let kind = if width > 1 {
                        PieceKind::Wide
                    } else {
                        PieceKind::Narrow
                    };
                    Piece::new(width, kind)
                }
                Atom::Chip(id) => {
                    let label = self
                        .chips
                        .get(id)
                        .map_or_else(|| "[pasted]".to_owned(), PasteChip::label);
                    Piece::new(UnicodeWidthStr::width(label.as_str()), PieceKind::Chip)
                }
            })
            .collect()
    }

    /// Per-atom paint class: chips, the leading `/command`, and `@mentions`.
    fn classes(&self, commands: &dyn CommandSource) -> Vec<Class> {
        let mut classes = vec![Class::Text; self.atoms.len()];
        for (index, atom) in self.atoms.iter().enumerate() {
            if matches!(atom, Atom::Chip(_)) {
                classes[index] = Class::Chip;
            }
        }
        let chars: Vec<char> = self.logical_text().chars().collect();

        if self.mode == ComposerMode::Prompt && chars.first() == Some(&'/') {
            let end = chars
                .iter()
                .position(|c| c.is_whitespace())
                .unwrap_or(chars.len());
            let name: String = chars[1..end].iter().collect();
            let class = Class::Command {
                recognised: commands.is_command(&name),
            };
            for slot in classes.iter_mut().take(end) {
                *slot = class;
            }
        }

        let mut index = 0usize;
        while index < chars.len() {
            if chars[index] == '@' && (index == 0 || chars[index - 1].is_whitespace()) {
                let mut end = index + 1;
                while end < chars.len() && is_mention_body(chars[end]) {
                    end += 1;
                }
                if end > index + 1 {
                    for slot in classes.iter_mut().take(end).skip(index) {
                        if *slot == Class::Text {
                            *slot = Class::Mention;
                        }
                    }
                }
                index = end;
                continue;
            }
            index += 1;
        }
        classes
    }

    // -- internals ---------------------------------------------------------

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            atoms: self.atoms.clone(),
            cursor: self.cursor,
            mode: self.mode,
        }
    }

    fn restore(&mut self, snapshot: Snapshot) {
        self.atoms = snapshot.atoms;
        self.cursor = snapshot.cursor.min(self.atoms.len());
        self.mode = snapshot.mode;
        self.last_yank = None;
        self.kills.interrupt();
        self.refresh_completion();
    }

    /// Run a mutation with undo bookkeeping and post-edit housekeeping.
    fn edit(&mut self, kind: EditKind, mutate: impl FnOnce(&mut Self)) {
        self.edit_raw(kind, mutate);
        self.kills.interrupt();
        if kind != EditKind::Yank {
            self.last_yank = None;
        }
    }

    /// As [`Composer::edit`], but leaves the kill ring's accumulation alone so
    /// consecutive kills merge.
    fn edit_raw(&mut self, kind: EditKind, mutate: impl FnOnce(&mut Self)) {
        let before = self.snapshot();
        self.undo.edit(&before, kind, before.cursor);
        mutate(self);
        self.undo.settle(kind, self.cursor);
        self.after_edit();
    }

    fn after_edit(&mut self) {
        self.cursor = self.cursor.min(self.atoms.len());
        self.recall.break_recall();
        self.refresh_completion();
    }

    /// Replace `from..to` with `atoms`, keeping the caret consistent.
    fn splice(&mut self, from: usize, to: usize, atoms: Vec<Atom>) {
        let from = from.min(self.atoms.len());
        let to = to.clamp(from, self.atoms.len());
        let inserted = atoms.len();
        self.atoms.splice(from..to, atoms);
        if self.cursor >= to {
            self.cursor = self.cursor - (to - from) + inserted;
        } else if self.cursor > from {
            self.cursor = from + inserted;
        }
    }

    /// The chip immediately before the caret, when `text` is byte-identical to
    /// its payload — DESIGN.md §4's "repaste-to-expand".
    fn repastable_chip(&self, text: &str) -> Option<(usize, ChipId)> {
        let index = self.cursor.checked_sub(1)?;
        let Some(Atom::Chip(id)) = self.atoms.get(index) else {
            return None;
        };
        (self.chips.get(id)?.payload == text).then_some((index, *id))
    }

    fn line_start(&self) -> usize {
        self.atoms[..self.cursor]
            .iter()
            .rposition(Atom::is_newline)
            .map_or(0, |at| at + 1)
    }

    fn line_end(&self) -> usize {
        self.atoms[self.cursor..]
            .iter()
            .position(Atom::is_newline)
            .map_or(self.atoms.len(), |at| self.cursor + at)
    }

    fn word_start(&self) -> usize {
        let mut at = self.cursor;
        while at > 0 && !self.atoms[at - 1].is_word() {
            at -= 1;
        }
        while at > 0 && self.atoms[at - 1].is_word() {
            at -= 1;
        }
        at
    }

    fn word_end(&self) -> usize {
        let mut at = self.cursor;
        while at < self.atoms.len() && !self.atoms[at].is_word() {
            at += 1;
        }
        while at < self.atoms.len() && self.atoms[at].is_word() {
            at += 1;
        }
        at
    }
}

fn is_mention_body(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '/' | '.' | '-' | '_' | '~' | '+')
}

/// Split text into grapheme atoms, normalising `\r\n` and `\r` to `\n`.
fn graphemes(text: &str) -> Vec<Atom> {
    let normalised = text.replace("\r\n", "\n").replace('\r', "\n");
    normalised
        .graphemes(true)
        .map(Atom::grapheme)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn composer() -> Composer {
        let mut composer = Composer::default();
        composer.set_width(40);
        composer
    }

    fn typed(text: &str) -> Composer {
        let mut composer = composer();
        for grapheme in text.graphemes(true) {
            composer.insert_text(grapheme);
        }
        composer
    }

    fn big_paste(lines: usize) -> String {
        (0..lines)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn typing_and_submitting_round_trips_the_text() {
        let mut composer = typed("hello world");
        assert_eq!(composer.text(), "hello world");
        let ComposerOutcome::Submit(submission) = composer.apply(Action::Submit) else {
            panic!("expected a submission");
        };
        assert_eq!(submission.text, "hello world");
        assert_eq!(submission.mode, ComposerMode::Prompt);
        assert!(composer.is_empty(), "submitting empties the composer");
    }

    #[test]
    fn submitting_an_empty_composer_is_inert() {
        let mut composer = composer();
        assert_eq!(composer.apply(Action::Submit), ComposerOutcome::Handled);
    }

    #[test]
    fn shift_enter_inserts_a_newline_without_submitting() {
        let mut composer = typed("one");
        composer.apply(Action::Newline);
        composer.insert_text("two");
        assert_eq!(composer.text(), "one\ntwo");
    }

    // -- readline set ------------------------------------------------------

    #[test]
    fn the_readline_motion_set_works_on_logical_lines() {
        let mut composer = typed("alpha beta\ngamma delta");
        composer.apply(Action::MoveLineStart);
        assert_eq!(composer.cursor(), 11, "start of the second logical line");
        composer.apply(Action::MoveLineEnd);
        assert_eq!(composer.cursor(), 22);
        composer.apply(Action::MoveBufferStart);
        assert_eq!(composer.cursor(), 0);
        composer.apply(Action::MoveWordRight);
        assert_eq!(composer.cursor(), 5, "end of `alpha`");
        composer.apply(Action::MoveWordRight);
        assert_eq!(composer.cursor(), 10);
        composer.apply(Action::MoveWordLeft);
        assert_eq!(composer.cursor(), 6);
    }

    #[test]
    fn ctrl_k_and_ctrl_u_kill_within_the_logical_line() {
        let mut composer = typed("keep this\ndrop that");
        composer.apply(Action::MoveLineStart);
        composer.apply(Action::KillToLineEnd);
        assert_eq!(composer.text(), "keep this\n");
        composer.apply(Action::Yank);
        assert_eq!(composer.text(), "keep this\ndrop that");
    }

    #[test]
    fn consecutive_kills_yank_back_as_one_block_in_order() {
        let mut composer = typed("alpha beta gamma");
        composer.apply(Action::KillWordBefore);
        composer.apply(Action::KillWordBefore);
        assert_eq!(composer.text(), "alpha ");
        composer.apply(Action::Yank);
        assert_eq!(
            composer.text(),
            "alpha beta gamma",
            "two ctrl+w presses yank back in the order they were typed"
        );
    }

    #[test]
    fn alt_y_cycles_the_kill_ring_in_place() {
        let mut composer = typed("first");
        composer.apply(Action::KillToLineStart);
        composer.insert_text("second");
        composer.apply(Action::KillToLineStart);
        assert!(composer.is_empty());
        composer.apply(Action::Yank);
        assert_eq!(composer.text(), "second");
        composer.apply(Action::YankPop);
        assert_eq!(composer.text(), "first");
    }

    #[test]
    fn transpose_swaps_the_two_graphemes_behind_the_caret() {
        let mut composer = typed("teh");
        composer.apply(Action::MoveCharLeft);
        composer.apply(Action::TransposeChars);
        assert_eq!(composer.text(), "the");
    }

    // -- undo groups -------------------------------------------------------

    #[test]
    fn a_run_of_typing_undoes_in_one_press() {
        let mut composer = typed("hello");
        composer.apply(Action::Undo);
        assert_eq!(composer.text(), "");
        composer.apply(Action::Redo);
        assert_eq!(composer.text(), "hello");
    }

    #[test]
    fn typing_then_deleting_are_two_undo_steps() {
        let mut composer = typed("hello");
        composer.apply(Action::DeleteCharBefore);
        composer.apply(Action::DeleteCharBefore);
        assert_eq!(composer.text(), "hel");
        composer.apply(Action::Undo);
        assert_eq!(composer.text(), "hello");
        composer.apply(Action::Undo);
        assert_eq!(composer.text(), "");
    }

    #[test]
    fn a_cursor_jump_splits_a_typing_run() {
        let mut composer = typed("abc");
        composer.apply(Action::MoveBufferStart);
        composer.insert_text("X");
        composer.apply(Action::Undo);
        assert_eq!(composer.text(), "abc");
    }

    #[test]
    fn a_paste_is_exactly_one_undo_step() {
        let mut composer = typed("before ");
        composer.paste(&big_paste(5));
        assert_eq!(composer.len(), 8, "seven graphemes plus one chip");
        composer.apply(Action::Undo);
        assert_eq!(composer.text(), "before ");
    }

    // -- paste chips -------------------------------------------------------

    #[test]
    fn a_small_paste_stays_literal() {
        let mut composer = composer();
        composer.paste("two\nlines");
        assert_eq!(composer.text(), "two\nlines");
        assert_eq!(composer.len(), 9);
    }

    #[test]
    fn a_large_paste_collapses_to_one_deletable_chip() {
        let mut composer = composer();
        let payload = big_paste(12);
        composer.paste(&payload);
        assert_eq!(composer.len(), 1, "the whole paste is one atom");
        let layout = composer.layout_plain(60);
        assert_eq!(layout.rows[0][0].text, "[pasted ~12 lines]");
        assert_eq!(layout.rows[0][0].class, Class::Chip);
        assert_eq!(
            composer.text(),
            payload,
            "the chip expands losslessly at submit"
        );
        composer.apply(Action::DeleteCharBefore);
        assert!(composer.is_empty(), "one backspace removes the whole chip");
    }

    #[test]
    fn a_long_single_line_paste_also_collapses() {
        let mut composer = composer();
        composer.paste(&"x".repeat(200));
        assert_eq!(composer.len(), 1);
    }

    #[test]
    fn the_caret_steps_over_a_chip_in_one_press() {
        let mut composer = composer();
        composer.insert_text("a");
        composer.paste(&big_paste(4));
        composer.insert_text("b");
        assert_eq!(composer.len(), 3);
        composer.apply(Action::MoveCharLeft);
        composer.apply(Action::MoveCharLeft);
        assert_eq!(composer.cursor(), 1, "one press crosses the whole chip");
    }

    #[test]
    fn repasting_the_same_text_onto_a_chip_expands_it() {
        let mut composer = composer();
        let payload = big_paste(4);
        composer.paste(&payload);
        assert_eq!(composer.len(), 1);
        composer.paste(&payload);
        assert_eq!(
            composer.len(),
            payload.graphemes(true).count(),
            "a byte-identical repaste expands the chip instead of adding another"
        );
        assert_eq!(composer.text(), payload);
    }

    #[test]
    fn repasting_something_else_adds_a_second_chip() {
        let mut composer = composer();
        composer.paste(&big_paste(4));
        composer.paste(&big_paste(5));
        assert_eq!(composer.len(), 2);
    }

    #[test]
    fn a_chip_survives_a_kill_and_a_yank() {
        let mut composer = composer();
        composer.paste(&big_paste(6));
        composer.apply(Action::KillToLineStart);
        assert!(composer.is_empty());
        composer.apply(Action::Yank);
        assert_eq!(composer.len(), 1);
        assert_eq!(composer.text(), big_paste(6));
    }

    // -- modes -------------------------------------------------------------

    #[test]
    fn a_bang_at_offset_zero_flips_to_bash_mode_without_inserting() {
        let mut composer = composer();
        composer.insert_text("!");
        assert_eq!(composer.mode(), ComposerMode::Bash);
        assert!(composer.is_empty());
        composer.insert_text("ls -la");
        assert_eq!(composer.text(), "ls -la");
        let ComposerOutcome::Submit(submission) = composer.apply(Action::Submit) else {
            panic!("expected a submission");
        };
        assert_eq!(submission.mode, ComposerMode::Bash);
        assert_eq!(
            composer.mode(),
            ComposerMode::Prompt,
            "bash mode is one-shot"
        );
    }

    #[test]
    fn a_bang_anywhere_else_is_just_a_bang() {
        let composer = typed("echo !");
        assert_eq!(composer.mode(), ComposerMode::Prompt);
        assert_eq!(composer.text(), "echo !");
    }

    #[test]
    fn backspace_at_offset_zero_leaves_bash_mode() {
        let mut composer = composer();
        composer.insert_text("!");
        composer.apply(Action::DeleteCharBefore);
        assert_eq!(composer.mode(), ComposerMode::Prompt);
    }

    // -- highlighting ------------------------------------------------------

    struct Commands;
    impl CommandSource for Commands {
        fn is_command(&self, name: &str) -> bool {
            name == "model"
        }
    }

    #[test]
    fn a_recognised_slash_command_is_marked_and_an_unknown_one_is_not() {
        let composer = typed("/model opus");
        let layout = composer.layout(60, &Commands);
        assert_eq!(layout.rows[0][0].text, "/model");
        assert_eq!(
            layout.rows[0][0].class,
            Class::Command { recognised: true }
        );

        let composer = typed("/nope opus");
        let layout = composer.layout(60, &Commands);
        assert_eq!(
            layout.rows[0][0].class,
            Class::Command { recognised: false }
        );
    }

    #[test]
    fn mentions_are_marked_and_email_addresses_are_not() {
        let composer = typed("see @src/auth.ts please");
        let layout = composer.layout_plain(60);
        assert!(layout.rows[0]
            .iter()
            .any(|segment| segment.class == Class::Mention
                && segment.text == "@src/auth.ts"));

        let composer = typed("mail me@example.com");
        let layout = composer.layout_plain(60);
        assert!(layout.rows[0]
            .iter()
            .all(|segment| segment.class != Class::Mention));
    }

    use crate::input::completion::{CompletionItem, CompletionKind};

    #[test]
    fn typing_a_mention_raises_a_completion_request() {
        let mut composer = typed("look at @sr");
        let request = composer.pending_completion().cloned().unwrap();
        assert_eq!(request.kind, CompletionKind::Mention);
        assert_eq!(request.query, "sr");

        // The stub source answers nothing, so the popup stays closed.
        assert!(!composer.completion().is_open());
        composer
            .completion_mut()
            .set_items(vec![CompletionItem::new("src/", "@src/")]);
        assert!(composer.completion().is_open());
        composer.accept_completion();
        assert_eq!(composer.text(), "look at @src/");
    }

    #[test]
    fn a_completion_request_disappears_when_the_mention_does() {
        let mut composer = typed("@src");
        assert!(composer.pending_completion().is_some());
        composer.insert_text(" ");
        assert!(composer.pending_completion().is_none());
    }

    // -- layout ------------------------------------------------------------

    #[test]
    fn wrapping_keeps_the_caret_where_the_text_put_it() {
        let mut composer = composer();
        composer.insert_text("0123456789abcdefghij");
        let layout = composer.layout_plain(10);
        assert_eq!(layout.rows.len(), 2);
        assert_eq!(layout.caret, (1, 10));
    }

    #[test]
    fn cjk_text_wraps_between_glyphs() {
        let mut composer = composer();
        composer.insert_text("日本語のテキスト");
        let layout = composer.layout_plain(7);
        assert!(layout.rows.len() >= 3);
        for row in &layout.rows {
            let width: usize = row
                .iter()
                .map(|segment| UnicodeWidthStr::width(segment.text.as_str()))
                .sum();
            assert!(width <= 7, "row {row:?} overflows the composer");
        }
    }

    #[test]
    fn up_and_down_move_by_visual_line_and_fall_through_at_the_edges() {
        let mut composer = composer();
        composer.set_width(10);
        // Three visual lines of 10, 10 and 5 columns.
        composer.insert_text("0123456789abcdefghijklmno");
        assert_eq!(composer.apply(Action::HistoryPrev), ComposerOutcome::Handled);
        assert_eq!(composer.cursor(), 15, "up keeps the display column");
        assert_eq!(composer.apply(Action::HistoryNext), ComposerOutcome::Handled);
        assert_eq!(composer.cursor(), 25);
        assert_eq!(
            composer.apply(Action::HistoryNext),
            ComposerOutcome::Ignored,
            "there is nothing below the last line"
        );
    }

    #[test]
    fn recall_parks_the_caret_at_the_end_of_the_recalled_prompt() {
        let mut composer = with_history(&["a previous prompt"]);
        composer.apply(Action::HistoryPrev);
        assert_eq!(composer.cursor(), composer.len());
        composer.insert_text("!");
        assert_eq!(composer.text(), "a previous prompt!");
    }

    // -- history -----------------------------------------------------------

    fn with_history(entries: &[&str]) -> Composer {
        let mut history = History::in_memory();
        for entry in entries {
            history.record(entry);
        }
        let mut composer = Composer::new(history);
        composer.set_width(40);
        composer
    }

    #[test]
    fn up_at_the_start_of_an_empty_buffer_recalls() {
        let mut composer = with_history(&["first", "second"]);
        composer.apply(Action::HistoryPrev);
        assert_eq!(composer.text(), "second");
        composer.apply(Action::HistoryPrev);
        assert_eq!(composer.text(), "first");
        composer.apply(Action::HistoryPrev);
        assert_eq!(composer.text(), "first", "the oldest entry is a wall");
        composer.apply(Action::HistoryNext);
        assert_eq!(composer.text(), "second");
        composer.apply(Action::HistoryNext);
        assert_eq!(composer.text(), "", "walking past the newest restores the draft");
    }

    #[test]
    fn recall_stashes_the_draft_and_gives_it_back() {
        let mut composer = with_history(&["earlier"]);
        composer.insert_text("draft");
        composer.apply(Action::MoveBufferStart);
        composer.apply(Action::HistoryPrev);
        assert_eq!(composer.text(), "earlier");
        composer.apply(Action::HistoryNext);
        assert_eq!(composer.text(), "draft");
    }

    #[test]
    fn editing_a_recalled_prompt_stops_recall() {
        let mut composer = with_history(&["one", "two"]);
        composer.apply(Action::HistoryPrev);
        assert_eq!(composer.text(), "two");
        composer.insert_text("!");
        composer.apply(Action::MoveBufferStart);
        composer.apply(Action::HistoryPrev);
        assert_eq!(
            composer.text(),
            "two!",
            "an edited recall is the user's text now, not a history cursor"
        );
    }

    #[test]
    fn up_away_from_the_buffer_start_does_not_recall() {
        let mut composer = with_history(&["earlier"]);
        composer.insert_text("draft");
        composer.apply(Action::HistoryPrev);
        assert_eq!(composer.text(), "draft", "the caret was not at offset 0");
    }

    #[test]
    fn submitting_records_history_and_skips_adjacent_duplicates() {
        let mut composer = composer();
        composer.insert_text("same");
        composer.apply(Action::Submit);
        composer.insert_text("same");
        composer.apply(Action::Submit);
        assert_eq!(composer.history().len(), 1);
    }

    // -- misc --------------------------------------------------------------

    #[test]
    fn clear_returns_the_text_and_forgets_the_chips() {
        let mut composer = composer();
        composer.insert_text("draft ");
        composer.paste(&big_paste(9));
        let text = composer.clear();
        assert!(text.starts_with("draft "));
        assert!(text.contains("line 8"));
        assert!(composer.is_empty());
        assert!(composer.chips.is_empty());
    }

    #[test]
    fn set_text_replaces_the_buffer_and_parks_the_caret_at_the_end() {
        let mut composer = typed("old");
        composer.set_text("queued item");
        assert_eq!(composer.text(), "queued item");
        assert_eq!(composer.cursor(), 11);
    }

    #[test]
    fn an_unbound_action_is_ignored_rather_than_swallowed() {
        let mut composer = composer();
        assert_eq!(composer.apply(Action::Palette), ComposerOutcome::Ignored);
        assert_eq!(composer.apply(Action::Steer), ComposerOutcome::Ignored);
    }

    #[test]
    fn grapheme_clusters_are_never_split() {
        let mut composer = composer();
        // A family emoji is one cluster of many scalars.
        composer.insert_text("👩‍👩‍👧‍👦");
        assert_eq!(composer.len(), 1);
        composer.apply(Action::DeleteCharBefore);
        assert!(composer.is_empty());
    }
}
