//! Commit-stable-rows: deciding which rows may leave the live region forever.
//!
//! DESIGN.md §1: "Streaming commits **only provably-stable rows** into
//! scrollback: text/code hold back the final row (it may reflow); markdown
//! commits whole blocks as they stabilize."
//!
//! A committed row is immutable. If the commit decision is wrong the terminal
//! shows a row that later content contradicts, and there is no way to take it
//! back — so the decision is a pure function with its own tests, deliberately
//! separated from anything that touches a file descriptor.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::ui::{Row, Style};

/// Decides how many leading wrapped rows of a still-growing block are stable.
///
/// Implementors must be **monotone**: for a fixed width, appending text may only
/// increase the answer. Violating that would ask the engine to un-commit a row.
pub trait CommitPolicy {
    /// Number of leading rows of `rows` that can never change again.
    ///
    /// `finished` is true once the producing stream has ended, at which point
    /// everything is stable.
    fn stable_rows(&self, rows: &[String], finished: bool) -> usize;
}

/// The text/code policy: every row but the last is stable.
///
/// The final row is held back because the next token can extend it, and an
/// extension that crosses the wrap width moves a word onto a new row — which
/// would rewrite a row already in scrollback.
#[derive(Debug, Default, Clone, Copy)]
pub struct TextCommitPolicy;

impl CommitPolicy for TextCommitPolicy {
    fn stable_rows(&self, rows: &[String], finished: bool) -> usize {
        if finished {
            rows.len()
        } else {
            rows.len().saturating_sub(1)
        }
    }
}

/// The markdown policy: commit only rows belonging to a **closed** block.
///
/// Markdown cannot use [`TextCommitPolicy`]. A trailing `|` retroactively turns
/// the preceding line into a table header, and that table's column widths then
/// depend on every row that follows it. Holding back the last *row* is not
/// enough; the last *block* must be held back.
///
/// [`crate::ui::markdown`] decides where a block closes (see its module docs for
/// the full table of what is stable when) and reports the row count through
/// [`BlockCommitPolicy::close`]. This type's job is narrower and more
/// important: **make the count monotone whatever the renderer says.**
///
/// ```text
///   renderer says   3   5   4   ← a bug, or a re-parse that shrank
///   policy commits  3   5   5   ← never un-commits
/// ```
///
/// A wrong-but-monotone answer shows a stale row. A non-monotone answer asks
/// the compositor to rewrite scrollback, which it cannot do. So the clamp lives
/// here, below the renderer, where no content bug can reach past it.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct BlockCommitPolicy {
    /// Row count of the leading closed-block prefix, relative to the rows
    /// currently held. Public for construction in tests; use
    /// [`BlockCommitPolicy::close`] to advance it.
    pub closed_rows: usize,
}

impl BlockCommitPolicy {
    /// A policy with nothing closed yet.
    #[must_use]
    pub const fn new() -> Self {
        Self { closed_rows: 0 }
    }

    /// A policy with a known closed prefix.
    #[must_use]
    pub const fn closed(rows: usize) -> Self {
        Self { closed_rows: rows }
    }

    /// Report the renderer's closed-prefix row count.
    ///
    /// Monotone: the recorded count only ever grows. A renderer that re-parses
    /// its unstable tail and comes back with a *smaller* number has hit a bug
    /// or a pathological input; either way the rows already promised stay
    /// promised.
    pub const fn close(&mut self, rows: usize) {
        if rows > self.closed_rows {
            self.closed_rows = rows;
        }
    }

    /// Account for `rows` leaving the held region into scrollback.
    pub const fn take(&mut self, rows: usize) {
        self.closed_rows = self.closed_rows.saturating_sub(rows);
    }
}

impl CommitPolicy for BlockCommitPolicy {
    fn stable_rows(&self, rows: &[String], finished: bool) -> usize {
        if finished {
            rows.len()
        } else {
            self.closed_rows.min(rows.len())
        }
    }
}

/// A streaming text block that emits stable rows exactly once.
///
/// Owns the reflow: the uncommitted tail is re-wrapped on every append and on
/// every width change, while committed rows are gone and never reconsidered.
#[derive(Debug)]
pub struct StreamBlock<P: CommitPolicy> {
    policy: P,
    /// Text that has already been committed, kept only to re-derive `pending`
    /// after a width change.
    committed_text: String,
    pending: String,
    width: u16,
    finished: bool,
}

impl<P: CommitPolicy> StreamBlock<P> {
    /// A new block wrapped at `width`.
    pub const fn new(policy: P, width: u16) -> Self {
        Self {
            policy,
            committed_text: String::new(),
            pending: String::new(),
            width,
            finished: false,
        }
    }

    /// Rows still held back, i.e. what the live region must display.
    #[must_use]
    pub fn live_rows(&self) -> Vec<String> {
        wrap(&self.pending, self.width)
    }

    /// Whether the block has any uncommitted content.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty() && self.committed_text.is_empty()
    }

    /// Append streamed text and return the rows that just became stable.
    pub fn push(&mut self, text: &str) -> Vec<Row> {
        self.pending.push_str(text);
        self.harvest()
    }

    /// Mark the stream finished; everything remaining becomes stable.
    pub fn finish(&mut self) -> Vec<Row> {
        self.finished = true;
        self.harvest()
    }

    /// Re-wrap at a new width.
    ///
    /// Only the uncommitted tail moves. Rows already in scrollback keep whatever
    /// wrapping they were printed with, which is exactly
    /// [`super::ResizeMode::Conservative`]'s accepted staleness.
    pub fn set_width(&mut self, width: u16) {
        self.width = width;
    }

    fn harvest(&mut self) -> Vec<Row> {
        let rows = wrap_indexed(&self.pending, self.width);
        let texts: Vec<String> = rows.iter().map(|row| row.text.clone()).collect();
        let stable = self.policy.stable_rows(&texts, self.finished);
        if stable == 0 {
            return Vec::new();
        }
        // The wrapper reports, for each row, the byte offset in the source at
        // which the *next* row begins. Splitting there is what makes a commit
        // exact: the whitespace wrapping discarded is consumed with the row that
        // ended at it, so no word is ever duplicated or dropped.
        let consumed = rows[stable - 1].end.min(self.pending.len());
        let remainder = self.pending.split_off(consumed);
        self.committed_text.push_str(&self.pending);
        self.pending = remainder;
        texts
            .into_iter()
            .take(stable)
            .map(|text| Row::styled(text, Style::default()))
            .collect()
    }
}

/// A wrapped row plus the source offset at which the next row begins.
#[derive(Debug, Clone, PartialEq, Eq)]
struct WrapRow {
    text: String,
    end: usize,
}

/// Wrap `text` to `width` columns, breaking at word boundaries where possible.
///
/// Hard newlines always break. A word longer than `width` is split at a
/// grapheme boundary rather than overflowing, so no row can ever exceed the
/// terminal width and trigger a terminal-side wrap the engine did not predict —
/// which would silently desynchronise the compositor's row accounting.
#[must_use]
pub fn wrap(text: &str, width: u16) -> Vec<String> {
    wrap_indexed(text, width)
        .into_iter()
        .map(|row| row.text)
        .collect()
}

fn wrap_indexed(text: &str, width: u16) -> Vec<WrapRow> {
    let width = width.max(1) as usize;
    let mut rows = Vec::new();
    let mut base = 0usize;
    let mut lines = text.split('\n').peekable();
    while let Some(line) = lines.next() {
        let has_newline = lines.peek().is_some();
        wrap_line(line, base, width, has_newline, &mut rows);
        base += line.len() + usize::from(has_newline);
    }
    rows
}

fn wrap_line(line: &str, base: usize, width: usize, has_newline: bool, rows: &mut Vec<WrapRow>) {
    let line_end = base + line.len() + usize::from(has_newline);
    if line.is_empty() {
        rows.push(WrapRow {
            text: String::new(),
            end: line_end,
        });
        return;
    }

    let mut current = String::new();
    let mut current_width = 0usize;

    for (offset, part) in parts(line) {
        let part_width = UnicodeWidthStr::width(part);
        if current_width + part_width <= width {
            current.push_str(part);
            current_width += part_width;
            continue;
        }
        if part.trim_start().is_empty() {
            // A run of spaces straddling the wrap point is consumed by the row
            // that ends at it, never carried onto the next one.
            rows.push(WrapRow {
                text: trimmed(&mut current),
                end: base + offset + part.len(),
            });
            current_width = 0;
            continue;
        }
        if !current.is_empty() {
            rows.push(WrapRow {
                text: trimmed(&mut current),
                end: base + offset,
            });
            current_width = 0;
        }
        if part_width <= width {
            current.push_str(part);
            current_width = part_width;
            continue;
        }
        // A single word wider than the terminal: hard-split at grapheme bounds.
        let mut consumed = 0usize;
        for grapheme in part.graphemes(true) {
            let advance = UnicodeWidthStr::width(grapheme).max(1);
            if current_width + advance > width {
                rows.push(WrapRow {
                    text: trimmed(&mut current),
                    end: base + offset + consumed,
                });
                current_width = 0;
            }
            current.push_str(grapheme);
            current_width += advance;
            consumed += grapheme.len();
        }
    }

    rows.push(WrapRow {
        text: trimmed(&mut current),
        end: line_end,
    });
}

/// Take `current`, trimming the trailing whitespace a wrap point discards.
fn trimmed(current: &mut String) -> String {
    let text = std::mem::take(current);
    let end = text.trim_end().len();
    let mut text = text;
    text.truncate(end);
    text
}

/// Split into alternating word and whitespace runs, with their byte offsets.
fn parts(line: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut in_space = line.starts_with(char::is_whitespace);
    for (index, ch) in line.char_indices() {
        if ch.is_whitespace() != in_space {
            out.push((start, &line[start..index]));
            start = index;
            in_space = !in_space;
        }
    }
    if start < line.len() {
        out.push((start, &line[start..]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(rows: &[Row]) -> Vec<String> {
        rows.iter().map(Row::plain_text).collect()
    }

    #[test]
    fn text_policy_holds_back_the_final_row() {
        let rows = vec!["a".to_owned(), "b".to_owned(), "c".to_owned()];
        assert_eq!(TextCommitPolicy.stable_rows(&rows, false), 2);
    }

    #[test]
    fn text_policy_releases_everything_once_finished() {
        let rows = vec!["a".to_owned(), "b".to_owned()];
        assert_eq!(TextCommitPolicy.stable_rows(&rows, true), 2);
    }

    #[test]
    fn text_policy_commits_nothing_from_a_single_row() {
        assert_eq!(TextCommitPolicy.stable_rows(&["only".to_owned()], false), 0);
        assert_eq!(TextCommitPolicy.stable_rows(&[], false), 0);
    }

    #[test]
    fn block_policy_commits_only_closed_blocks() {
        let policy = BlockCommitPolicy::closed(2);
        let rows = vec!["#".to_owned(), "".to_owned(), "|a|".to_owned()];
        assert_eq!(policy.stable_rows(&rows, false), 2);
        assert_eq!(policy.stable_rows(&rows, true), 3);
    }

    #[test]
    fn the_block_policy_clamps_a_renderer_that_tries_to_un_commit() {
        let mut policy = BlockCommitPolicy::new();
        policy.close(3);
        policy.close(5);
        policy.close(4); // a shrinking re-parse
        assert_eq!(policy.closed_rows, 5, "a promised row stays promised");
    }

    #[test]
    fn taking_rows_moves_the_boundary_with_them() {
        let mut policy = BlockCommitPolicy::closed(5);
        policy.take(5);
        assert_eq!(policy.closed_rows, 0);
        policy.take(9);
        assert_eq!(policy.closed_rows, 0, "taking more than exists cannot underflow");
    }

    #[test]
    fn the_block_policy_never_promises_more_rows_than_it_holds() {
        let policy = BlockCommitPolicy::closed(99);
        assert_eq!(policy.stable_rows(&["a".to_owned()], false), 1);
    }

    #[test]
    fn a_row_is_never_committed_while_the_next_token_can_still_extend_it() {
        let mut block = StreamBlock::new(TextCommitPolicy, 10);
        assert!(block.push("hello").is_empty(), "one partial row commits nothing");
        assert!(block.push(" wor").is_empty());
        // "hello world" exceeds the width, so "hello" and then "world" both
        // become provably stable; only the trailing row is still held back.
        let committed = block.push("ld again");
        assert_eq!(texts(&committed), ["hello", "world"]);
        assert_eq!(block.live_rows(), ["again"]);
    }

    #[test]
    fn every_row_is_committed_exactly_once_across_a_whole_stream() {
        let mut block = StreamBlock::new(TextCommitPolicy, 12);
        let mut committed = Vec::new();
        for chunk in ["the quick ", "brown fox ", "jumps over ", "the lazy dog"] {
            committed.extend(texts(&block.push(chunk)));
        }
        committed.extend(texts(&block.finish()));
        assert_eq!(committed.join(" "), "the quick brown fox jumps over the lazy dog");
    }

    #[test]
    fn finishing_flushes_the_held_back_row() {
        let mut block = StreamBlock::new(TextCommitPolicy, 20);
        assert!(block.push("tail").is_empty());
        assert_eq!(texts(&block.finish()), ["tail"]);
        assert!(block.live_rows().is_empty() || block.live_rows() == [""]);
    }

    #[test]
    fn hard_newlines_break_rows() {
        assert_eq!(wrap("a\nb\nc", 40), ["a", "b", "c"]);
        assert_eq!(wrap("a\n\nb", 40), ["a", "", "b"]);
    }

    #[test]
    fn wrapping_breaks_at_word_boundaries() {
        assert_eq!(wrap("alpha beta gamma", 11), ["alpha beta", "gamma"]);
    }

    #[test]
    fn no_wrapped_row_can_exceed_the_terminal_width() {
        let text = "supercalifragilisticexpialidocious and more";
        for row in wrap(text, 8) {
            assert!(UnicodeWidthStr::width(row.as_str()) <= 8, "{row:?}");
        }
    }

    #[test]
    fn wrapping_accounts_for_double_width_graphemes() {
        for row in wrap("あいうえおかきくけこ", 6) {
            assert!(UnicodeWidthStr::width(row.as_str()) <= 6, "{row:?}");
        }
    }

    #[test]
    fn a_width_change_reflows_only_the_uncommitted_tail() {
        let mut block = StreamBlock::new(TextCommitPolicy, 10);
        let first = texts(&block.push("hello world again more words here"));
        assert_eq!(first, ["hello", "world", "again more"]);
        block.set_width(24);
        // Committed rows keep their old wrapping; only the tail re-wraps wider.
        assert_eq!(block.live_rows(), ["words here"]);
    }
}
