//! Prompt history (DESIGN.md §4: "history (↑ at buffer start; no chord)").
//!
//! Storage is JSONL under `~/.lyra/`: one `{"ts":…,"text":…}` object per line,
//! appended and never rewritten. The format is chosen for the failure mode, not
//! for elegance — a truncated write costs the last line and nothing else, and a
//! line this crate cannot parse is skipped rather than fatal. A history file is
//! not worth a startup failure.
//!
//! Recall policy, and why each rule exists:
//!
//! - **`↑` recalls only from the start of the buffer.** Anywhere else `↑` is
//!   line-wise cursor motion, because the composer is multiline. No chord is
//!   introduced for either meaning; the caret disambiguates.
//! - **Editing stops recall.** Once a recalled prompt has been modified, further
//!   `↑` moves the caret instead of throwing the edit away.
//! - **Consecutive duplicates are not recorded.** Re-sending the same prompt
//!   twice must not make `↑ ↑` land back on it.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// How many entries are kept in memory and replayed from disk.
pub const DEFAULT_CAP: usize = 1000;

/// The prompt history.
#[derive(Debug, Clone)]
pub struct History {
    entries: Vec<String>,
    path: Option<PathBuf>,
    cap: usize,
}

impl Default for History {
    fn default() -> Self {
        Self::in_memory()
    }
}

impl History {
    /// A history that is never persisted. Used by tests and by `--smoke`.
    #[must_use]
    pub const fn in_memory() -> Self {
        Self {
            entries: Vec::new(),
            path: None,
            cap: DEFAULT_CAP,
        }
    }

    /// Load history from `path`, creating nothing.
    ///
    /// A missing or unreadable file yields an empty history with the path still
    /// armed for writing, so the first successful prompt creates it.
    #[must_use]
    pub fn load(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let mut entries = Vec::new();
        if let Ok(file) = std::fs::File::open(&path) {
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                if let Some(text) = parse_line(&line) {
                    entries.push(text);
                }
            }
        }
        let cap = DEFAULT_CAP;
        if entries.len() > cap {
            entries.drain(..entries.len() - cap);
        }
        Self {
            entries,
            path: Some(path),
            cap,
        }
    }

    /// The default location: `$LYRA_HOME/history.jsonl`, else
    /// `~/.lyra/history.jsonl`. `None` when neither variable is set.
    #[must_use]
    pub fn default_path() -> Option<PathBuf> {
        if let Some(home) = std::env::var_os("LYRA_HOME") {
            return Some(Path::new(&home).join("history.jsonl"));
        }
        let home = std::env::var_os("HOME")?;
        Some(Path::new(&home).join(".lyra").join("history.jsonl"))
    }

    /// Entries, oldest first.
    #[must_use]
    pub fn entries(&self) -> &[String] {
        &self.entries
    }

    /// Number of entries.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether there is nothing to recall.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The `index`-th entry counting back from the newest (`0` is newest).
    #[must_use]
    pub fn recall(&self, index: usize) -> Option<&str> {
        let at = self.entries.len().checked_sub(index + 1)?;
        self.entries.get(at).map(String::as_str)
    }

    /// Record a submitted prompt.
    ///
    /// Returns whether it was kept. Empty and whitespace-only prompts, and any
    /// prompt identical to the previous one, are dropped.
    pub fn record(&mut self, text: &str) -> bool {
        if text.trim().is_empty() || self.entries.last().is_some_and(|last| last == text) {
            return false;
        }
        self.entries.push(text.to_owned());
        if self.entries.len() > self.cap {
            self.entries.remove(0);
        }
        self.append_to_disk(text);
        true
    }

    fn append_to_disk(&self, text: &str) {
        let Some(path) = &self.path else { return };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_millis());
        let line = serde_json::json!({ "ts": millis as u64, "text": text });
        // A history write must never take the TUI down with it: a read-only home
        // directory, a full disk and a stale NFS handle are all survivable.
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

fn parse_line(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let text = value.get("text")?.as_str()?;
    if text.is_empty() {
        return None;
    }
    Some(text.to_owned())
}

/// Where recall currently is.
///
/// Held by the composer, which also owns the stashed buffer that recall
/// displaced. Kept separate from [`History`] so history stays a pure store.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Recall {
    /// Distance back from the newest entry, when recall is active.
    position: Option<usize>,
    /// Set once the recalled text has been edited: recall is over.
    broken: bool,
}

impl Recall {
    /// Whether recall is currently walking the history.
    #[must_use]
    pub const fn is_active(&self) -> bool {
        self.position.is_some()
    }

    /// The current position, if any.
    #[must_use]
    pub const fn position(&self) -> Option<usize> {
        self.position
    }

    /// Step one entry older. Returns the new position, or `None` at the end.
    pub fn older(&mut self, len: usize) -> Option<usize> {
        if self.broken || len == 0 {
            return None;
        }
        let next = self.position.map_or(0, |at| at + 1);
        if next >= len {
            return None;
        }
        self.position = Some(next);
        Some(next)
    }

    /// Step one entry newer. `None` once recall has walked back off the end,
    /// which is the signal to restore the stashed buffer.
    pub fn newer(&mut self) -> Option<usize> {
        let current = self.position?;
        if current == 0 {
            self.position = None;
            return None;
        }
        self.position = Some(current - 1);
        Some(current - 1)
    }

    /// Mark the buffer as edited: recall stops until it is reset.
    pub const fn break_recall(&mut self) {
        if self.position.is_some() {
            self.broken = true;
        }
        self.position = None;
    }

    /// Return to the "not recalling" state, ready to recall again.
    pub const fn reset(&mut self) {
        self.position = None;
        self.broken = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recall_counts_back_from_the_newest_entry() {
        let mut history = History::in_memory();
        history.record("first");
        history.record("second");
        history.record("third");
        assert_eq!(history.recall(0), Some("third"));
        assert_eq!(history.recall(2), Some("first"));
        assert_eq!(history.recall(3), None);
    }

    #[test]
    fn consecutive_duplicates_are_not_recorded() {
        let mut history = History::in_memory();
        assert!(history.record("same"));
        assert!(!history.record("same"));
        assert_eq!(history.len(), 1);
        assert!(history.record("other"));
        assert!(history.record("same"), "a non-adjacent repeat is still history");
        assert_eq!(history.len(), 3);
    }

    #[test]
    fn empty_prompts_are_not_recorded() {
        let mut history = History::in_memory();
        assert!(!history.record(""));
        assert!(!history.record("   \n "));
        assert!(history.is_empty());
    }

    #[test]
    fn the_store_is_bounded() {
        let mut history = History::in_memory();
        history.cap = 3;
        for step in 0..10 {
            history.record(&step.to_string());
        }
        assert_eq!(history.len(), 3);
        assert_eq!(history.recall(0), Some("9"));
    }

    #[test]
    fn a_jsonl_round_trip_survives_newlines_and_unicode() {
        let dir = std::env::temp_dir().join(format!(
            "lyra-history-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let path = dir.join("history.jsonl");
        let _ = std::fs::remove_dir_all(&dir);

        let mut history = History::load(&path);
        assert!(history.is_empty());
        history.record("multi\nline prompt");
        history.record("絵文字 🎈");

        let reloaded = History::load(&path);
        assert_eq!(reloaded.entries(), ["multi\nline prompt", "絵文字 🎈"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unparseable_line_is_skipped_not_fatal() {
        let dir = std::env::temp_dir().join(format!("lyra-history-bad-{}", std::process::id()));
        let path = dir.join("history.jsonl");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &path,
            "{\"ts\":1,\"text\":\"good\"}\nnot json at all\n{\"ts\":2}\n{\"ts\":3,\"text\":\"also good\"}\n",
        )
        .unwrap();
        let history = History::load(&path);
        assert_eq!(history.entries(), ["good", "also good"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_loads_as_empty_and_stays_writable() {
        let history = History::load("/nonexistent/lyra/history.jsonl");
        assert!(history.is_empty());
        assert!(history.path.is_some());
    }

    #[test]
    fn recall_walks_back_and_forward_and_falls_off_the_new_end() {
        let mut recall = Recall::default();
        assert_eq!(recall.older(3), Some(0));
        assert_eq!(recall.older(3), Some(1));
        assert_eq!(recall.older(3), Some(2));
        assert_eq!(recall.older(3), None, "the oldest entry is a wall");
        assert_eq!(recall.newer(), Some(1));
        assert_eq!(recall.newer(), Some(0));
        assert_eq!(recall.newer(), None, "falling off restores the stash");
        assert!(!recall.is_active());
    }

    #[test]
    fn editing_stops_recall_until_it_is_reset() {
        let mut recall = Recall::default();
        recall.older(3);
        recall.break_recall();
        assert!(!recall.is_active());
        assert_eq!(recall.older(3), None, "an edited recall does not resume");
        recall.reset();
        assert_eq!(recall.older(3), Some(0));
    }

    #[test]
    fn editing_a_never_recalled_buffer_leaves_recall_available() {
        let mut recall = Recall::default();
        recall.break_recall();
        assert_eq!(
            recall.older(2),
            Some(0),
            "typing into a fresh composer must not disable history"
        );
    }
}
