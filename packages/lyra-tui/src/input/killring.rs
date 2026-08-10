//! The emacs kill ring (DESIGN.md §4: "readline/emacs set with kill-ring").
//!
//! Two behaviours are what separate a kill ring from a clipboard, and both are
//! here:
//!
//! 1. **Accumulation.** Consecutive kills merge into one entry, in the direction
//!    they were made: `Ctrl+K Ctrl+K Ctrl+K` yields one yankable block of three
//!    lines, and `Ctrl+W Ctrl+W` yields two words in their original order rather
//!    than reversed. A non-kill action between them starts a new entry.
//! 2. **Rotation.** `Alt+Y` after a yank replaces the yanked text with the next
//!    older entry, which is why the ring is a ring and not a stack.
//!
//! The ring is generic over its element so the composer can kill *atoms* —
//! graphemes and paste chips alike — rather than losing a chip to a `Ctrl+W`.

/// Which end of the entry a kill attaches to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillDirection {
    /// Killed text that was *after* the caret: append to the entry.
    Forward,
    /// Killed text that was *before* the caret: prepend to the entry.
    Backward,
}

/// A kill ring of `T`s.
#[derive(Debug, Clone)]
pub struct KillRing<T> {
    entries: Vec<Vec<T>>,
    limit: usize,
    /// Set while the last action was a kill, so the next kill merges.
    accumulating: bool,
    /// Rotation cursor for `Alt+Y`. `0` is the most recent entry.
    rotation: usize,
}

impl<T: Clone> Default for KillRing<T> {
    fn default() -> Self {
        Self::new(64)
    }
}

impl<T: Clone> KillRing<T> {
    /// A ring holding at most `limit` entries.
    #[must_use]
    pub const fn new(limit: usize) -> Self {
        Self {
            entries: Vec::new(),
            limit,
            accumulating: false,
            rotation: 0,
        }
    }

    /// Number of entries.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the ring is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Record a kill.
    ///
    /// Merges with the previous entry when the previous action was also a kill.
    pub fn kill(&mut self, items: Vec<T>, direction: KillDirection) {
        if items.is_empty() {
            return;
        }
        self.rotation = 0;
        if let Some(top) = self.entries.last_mut().filter(|_| self.accumulating) {
            match direction {
                KillDirection::Forward => top.extend(items),
                KillDirection::Backward => {
                    let mut merged = items;
                    merged.append(top);
                    *top = merged;
                }
            }
            return;
        }
        self.entries.push(items);
        if self.entries.len() > self.limit {
            self.entries.remove(0);
        }
        self.accumulating = true;
    }

    /// Tell the ring that a non-kill action happened, so the next kill starts a
    /// new entry.
    pub fn interrupt(&mut self) {
        self.accumulating = false;
    }

    /// The entry a `Ctrl+Y` would yank.
    #[must_use]
    pub fn yank(&self) -> Option<&[T]> {
        let index = self.entries.len().checked_sub(1 + self.rotation)?;
        self.entries.get(index).map(Vec::as_slice)
    }

    /// Rotate to the next older entry and return it (`Alt+Y`).
    ///
    /// Wraps around, so holding `Alt+Y` walks the whole ring and comes back.
    pub fn rotate(&mut self) -> Option<&[T]> {
        if self.entries.is_empty() {
            return None;
        }
        self.rotation = (self.rotation + 1) % self.entries.len();
        self.yank()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring() -> KillRing<char> {
        KillRing::new(4)
    }

    fn chars(text: &str) -> Vec<char> {
        text.chars().collect()
    }

    fn yanked(ring: &KillRing<char>) -> String {
        ring.yank().unwrap_or(&[]).iter().collect()
    }

    #[test]
    fn consecutive_forward_kills_append_in_order() {
        let mut ring = ring();
        ring.kill(chars("one "), KillDirection::Forward);
        ring.kill(chars("two "), KillDirection::Forward);
        ring.kill(chars("three"), KillDirection::Forward);
        assert_eq!(ring.len(), 1, "three ctrl+k presses are one yankable block");
        assert_eq!(yanked(&ring), "one two three");
    }

    #[test]
    fn consecutive_backward_kills_prepend_so_word_order_survives() {
        let mut ring = ring();
        // Typing "alpha beta" then ctrl+w twice kills "beta" then "alpha ".
        ring.kill(chars("beta"), KillDirection::Backward);
        ring.kill(chars("alpha "), KillDirection::Backward);
        assert_eq!(yanked(&ring), "alpha beta");
    }

    #[test]
    fn an_intervening_action_starts_a_new_entry() {
        let mut ring = ring();
        ring.kill(chars("first"), KillDirection::Forward);
        ring.interrupt();
        ring.kill(chars("second"), KillDirection::Forward);
        assert_eq!(ring.len(), 2);
        assert_eq!(yanked(&ring), "second");
    }

    #[test]
    fn rotation_walks_older_entries_and_wraps() {
        let mut ring = ring();
        for word in ["a", "b", "c"] {
            ring.kill(chars(word), KillDirection::Forward);
            ring.interrupt();
        }
        assert_eq!(yanked(&ring), "c");
        assert_eq!(ring.rotate().unwrap().iter().collect::<String>(), "b");
        assert_eq!(ring.rotate().unwrap().iter().collect::<String>(), "a");
        assert_eq!(
            ring.rotate().unwrap().iter().collect::<String>(),
            "c",
            "the ring wraps"
        );
    }

    #[test]
    fn a_new_kill_resets_the_rotation() {
        let mut ring = ring();
        for word in ["a", "b"] {
            ring.kill(chars(word), KillDirection::Forward);
            ring.interrupt();
        }
        ring.rotate();
        assert_eq!(yanked(&ring), "a");
        ring.kill(chars("c"), KillDirection::Forward);
        assert_eq!(yanked(&ring), "c");
    }

    #[test]
    fn the_ring_is_bounded() {
        let mut ring = ring();
        for word in ["a", "b", "c", "d", "e", "f"] {
            ring.kill(chars(word), KillDirection::Forward);
            ring.interrupt();
        }
        assert_eq!(ring.len(), 4);
        assert_eq!(yanked(&ring), "f");
    }

    #[test]
    fn killing_nothing_does_nothing() {
        let mut ring = ring();
        ring.kill(Vec::new(), KillDirection::Forward);
        assert!(ring.is_empty());
        assert_eq!(ring.yank(), None);
    }
}
