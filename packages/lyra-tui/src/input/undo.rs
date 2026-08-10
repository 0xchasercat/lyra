//! Undo **groups** (DESIGN.md §4: "checkpoint on kind-change/cursor-jump;
//! composite operations are one undo step").
//!
//! Per-keystroke undo is unusable — twenty presses of `Ctrl+Z` to remove one
//! word — and per-command undo is too coarse. The rule that produces the
//! behaviour people expect is:
//!
//! > a run of same-kind edits at a contiguous caret is **one** step.
//!
//! So a checkpoint is taken when, and only when:
//!
//! 1. the **kind** of edit changes (typing → deleting → yanking), or
//! 2. the caret **jumped** since the previous edit (an arrow key, a click of
//!    `Ctrl+A`, an edit somewhere else entirely), or
//! 3. the edit is **atomic** by nature — a kill, a yank, a paste. These are
//!    single user gestures and must undo in one press even back-to-back.
//!
//! A composite operation (one gesture that mutates several times) wraps itself
//! in [`UndoStack::begin_group`]/[`UndoStack::end_group`] and lands as one step
//! regardless.
//!
//! The stack stores whole snapshots rather than a diff log. A composer buffer is
//! a few hundred graphemes and the depth is capped; a delta representation would
//! buy nothing but a class of bugs where undo and redo disagree.

/// What kind of edit was made. Two edits of different kinds never merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditKind {
    /// Typing.
    Insert,
    /// `Backspace` / `Delete`.
    Delete,
    /// A kill-ring operation.
    Kill,
    /// A yank.
    Yank,
    /// A paste, chip or literal.
    Paste,
    /// Anything else that mutates the buffer (mode flips, history recall).
    Replace,
}

impl EditKind {
    /// Whether this kind always begins its own undo step.
    const fn is_atomic(self) -> bool {
        matches!(self, Self::Kill | Self::Yank | Self::Paste | Self::Replace)
    }
}

/// A snapshot stack with grouping.
#[derive(Debug, Clone)]
pub struct UndoStack<S> {
    past: Vec<S>,
    future: Vec<S>,
    /// Kind and post-edit caret of the previous edit, when a run is open.
    run: Option<(EditKind, usize)>,
    limit: usize,
    depth: usize,
}

impl<S: Clone> Default for UndoStack<S> {
    fn default() -> Self {
        Self::new(200)
    }
}

impl<S: Clone> UndoStack<S> {
    /// A stack holding at most `limit` undo steps.
    #[must_use]
    pub const fn new(limit: usize) -> Self {
        Self {
            past: Vec::new(),
            future: Vec::new(),
            run: None,
            limit,
            depth: 0,
        }
    }

    /// Undo steps available.
    #[must_use]
    pub fn depth(&self) -> usize {
        self.past.len()
    }

    /// Whether a redo is available.
    #[must_use]
    pub fn can_redo(&self) -> bool {
        !self.future.is_empty()
    }

    /// Announce an edit that is *about* to happen.
    ///
    /// `before` is the pre-edit state; `caret` is the pre-edit caret. Call
    /// [`UndoStack::settle`] afterwards with the post-edit caret.
    pub fn edit(&mut self, before: &S, kind: EditKind, caret: usize) {
        self.future.clear();
        if self.depth > 0 {
            // Inside a composite operation: the group already checkpointed.
            return;
        }
        let boundary = match self.run {
            None => true,
            Some((last_kind, last_caret)) => {
                last_kind != kind || last_caret != caret || kind.is_atomic()
            }
        };
        if boundary {
            self.push(before.clone());
        }
    }

    /// Record where the caret ended up, closing the run at that point.
    pub fn settle(&mut self, kind: EditKind, caret: usize) {
        if self.depth == 0 {
            self.run = Some((kind, caret));
        }
    }

    /// Break the current run: the next edit checkpoints even if it is the same
    /// kind. Called by pure cursor motion.
    pub fn caret_jumped(&mut self) {
        self.run = None;
    }

    /// Open a composite operation. Nestable.
    pub fn begin_group(&mut self, before: &S) {
        if self.depth == 0 {
            self.push(before.clone());
            self.future.clear();
        }
        self.depth += 1;
    }

    /// Close a composite operation.
    pub fn end_group(&mut self) {
        self.depth = self.depth.saturating_sub(1);
        if self.depth == 0 {
            // A composite gesture never merges with what follows it.
            self.run = None;
        }
    }

    /// Undo one step, given the current state.
    pub fn undo(&mut self, current: &S) -> Option<S> {
        let previous = self.past.pop()?;
        self.future.push(current.clone());
        self.run = None;
        Some(previous)
    }

    /// Redo one step, given the current state.
    pub fn redo(&mut self, current: &S) -> Option<S> {
        let next = self.future.pop()?;
        self.past.push(current.clone());
        self.run = None;
        Some(next)
    }

    fn push(&mut self, state: S) {
        self.past.push(state);
        if self.past.len() > self.limit {
            self.past.remove(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A toy document so the stack can be tested without the composer.
    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Doc(String);

    struct Editor {
        doc: Doc,
        caret: usize,
        undo: UndoStack<Doc>,
    }

    impl Editor {
        fn new() -> Self {
            Self {
                doc: Doc(String::new()),
                caret: 0,
                undo: UndoStack::new(50),
            }
        }

        fn type_char(&mut self, c: char) {
            self.undo.edit(&self.doc, EditKind::Insert, self.caret);
            self.doc.0.push(c);
            self.caret += 1;
            self.undo.settle(EditKind::Insert, self.caret);
        }

        fn backspace(&mut self) {
            self.undo.edit(&self.doc, EditKind::Delete, self.caret);
            self.doc.0.pop();
            self.caret = self.caret.saturating_sub(1);
            self.undo.settle(EditKind::Delete, self.caret);
        }

        fn kill(&mut self, text: &str) {
            self.undo.edit(&self.doc, EditKind::Kill, self.caret);
            self.doc.0.push_str(text);
            self.caret += text.len();
            self.undo.settle(EditKind::Kill, self.caret);
        }

        fn undo(&mut self) -> bool {
            match self.undo.undo(&self.doc) {
                Some(previous) => {
                    self.doc = previous;
                    self.caret = self.doc.0.len();
                    true
                }
                None => false,
            }
        }

        fn redo(&mut self) -> bool {
            match self.undo.redo(&self.doc) {
                Some(next) => {
                    self.doc = next;
                    self.caret = self.doc.0.len();
                    true
                }
                None => false,
            }
        }
    }

    #[test]
    fn a_run_of_typing_is_one_undo_step() {
        let mut editor = Editor::new();
        for c in "hello".chars() {
            editor.type_char(c);
        }
        assert_eq!(editor.undo.depth(), 1);
        editor.undo();
        assert_eq!(editor.doc.0, "");
    }

    #[test]
    fn switching_from_typing_to_deleting_starts_a_new_step() {
        let mut editor = Editor::new();
        for c in "hello".chars() {
            editor.type_char(c);
        }
        editor.backspace();
        editor.backspace();
        assert_eq!(editor.undo.depth(), 2);
        editor.undo();
        assert_eq!(editor.doc.0, "hello", "the deletions undo as one group");
        editor.undo();
        assert_eq!(editor.doc.0, "");
    }

    #[test]
    fn a_caret_jump_breaks_the_run_even_within_one_kind() {
        let mut editor = Editor::new();
        editor.type_char('a');
        editor.type_char('b');
        assert_eq!(editor.undo.depth(), 1);
        editor.undo.caret_jumped();
        editor.type_char('c');
        assert_eq!(editor.undo.depth(), 2, "an arrow key ends the typing run");
    }

    #[test]
    fn back_to_back_kills_are_separate_steps_because_kills_are_atomic() {
        let mut editor = Editor::new();
        editor.kill("one");
        editor.kill("two");
        assert_eq!(editor.undo.depth(), 2);
    }

    #[test]
    fn a_composite_operation_is_exactly_one_step() {
        let mut editor = Editor::new();
        editor.type_char('x');
        let before = editor.doc.clone();
        editor.undo.begin_group(&before);
        // Several mutations inside one gesture.
        for c in "abc".chars() {
            editor.undo.edit(&editor.doc.clone(), EditKind::Insert, editor.caret);
            editor.doc.0.push(c);
            editor.caret += 1;
        }
        editor.undo.end_group();
        assert_eq!(editor.undo.depth(), 2);
        editor.undo();
        assert_eq!(editor.doc.0, "x");
    }

    #[test]
    fn redo_replays_what_undo_took_and_a_new_edit_discards_it() {
        let mut editor = Editor::new();
        editor.type_char('a');
        editor.undo.caret_jumped();
        editor.type_char('b');
        editor.undo();
        assert_eq!(editor.doc.0, "a");
        assert!(editor.undo.can_redo());
        editor.redo();
        assert_eq!(editor.doc.0, "ab");

        editor.undo();
        editor.undo.caret_jumped();
        editor.type_char('z');
        assert!(!editor.undo.can_redo(), "a fresh edit invalidates the redo arm");
    }

    #[test]
    fn undoing_an_empty_stack_is_a_no_op_rather_than_a_panic() {
        let mut editor = Editor::new();
        assert!(!editor.undo());
        assert!(!editor.redo());
    }

    #[test]
    fn the_stack_is_bounded() {
        let mut stack: UndoStack<Doc> = UndoStack::new(3);
        for step in 0..10 {
            stack.edit(&Doc(step.to_string()), EditKind::Kill, 0);
        }
        assert_eq!(stack.depth(), 3);
    }
}
