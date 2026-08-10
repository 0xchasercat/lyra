//! Paste chips (DESIGN.md §4).
//!
//! A large bracketed paste does not belong in the composer as text: it pushes
//! the prompt off the screen, it makes the caret useless, and every redraw
//! re-wraps thousands of graphemes. It collapses instead to a single
//! **placeholder** — `[pasted ~42 lines]` — that behaves like one character:
//! one `Backspace` removes it whole, the caret steps over it in one press, and
//! wrapping treats it as an unbreakable token.
//!
//! The payload is kept verbatim and re-expanded at submit, so the collapse is
//! lossless. The chip is the *display*; the paste is still the content.

/// A paste of at least this many lines collapses.
pub const COLLAPSE_LINES: usize = 3;

/// A paste of more than this many characters collapses.
pub const COLLAPSE_CHARS: usize = 150;

/// Identifier of a chip within one composer.
pub type ChipId = u32;

/// A collapsed paste.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasteChip {
    /// Identity within the composer that owns it.
    pub id: ChipId,
    /// The original text, byte-for-byte. Re-expanded at submit.
    pub payload: String,
}

impl PasteChip {
    /// A chip over `payload`.
    #[must_use]
    pub fn new(id: ChipId, payload: impl Into<String>) -> Self {
        Self {
            id,
            payload: payload.into(),
        }
    }

    /// Line count, counting a payload with no trailing newline as one line.
    #[must_use]
    pub fn lines(&self) -> usize {
        if self.payload.is_empty() {
            return 0;
        }
        self.payload.lines().count().max(1)
    }

    /// Character count.
    #[must_use]
    pub fn chars(&self) -> usize {
        self.payload.chars().count()
    }

    /// The placeholder text.
    ///
    /// A single very long line reports characters rather than "~1 lines", which
    /// is the only place this deviates from DESIGN.md's literal wording and does
    /// so because "1 line" tells the user nothing about what they pasted.
    #[must_use]
    pub fn label(&self) -> String {
        let lines = self.lines();
        if lines > 1 {
            format!("[pasted ~{lines} lines]")
        } else {
            format!("[pasted ~{} chars]", self.chars())
        }
    }
}

/// Whether a paste is large enough to collapse.
#[must_use]
pub fn should_collapse(text: &str) -> bool {
    text.lines().count() >= COLLAPSE_LINES || text.chars().count() > COLLAPSE_CHARS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_collapse_thresholds_are_the_documented_ones() {
        assert!(!should_collapse("one\ntwo"), "two lines stay inline");
        assert!(should_collapse("one\ntwo\nthree"), "three lines collapse");
        assert!(!should_collapse(&"x".repeat(150)));
        assert!(should_collapse(&"x".repeat(151)));
    }

    #[test]
    fn a_label_reports_lines_when_there_are_lines_to_report() {
        let chip = PasteChip::new(0, "a\nb\nc\nd");
        assert_eq!(chip.lines(), 4);
        assert_eq!(chip.label(), "[pasted ~4 lines]");
    }

    #[test]
    fn a_single_long_line_reports_characters_instead() {
        let chip = PasteChip::new(0, "x".repeat(400));
        assert_eq!(chip.label(), "[pasted ~400 chars]");
    }

    #[test]
    fn the_payload_is_kept_byte_for_byte() {
        let payload = "  indented\n\ttabbed\r\n";
        let chip = PasteChip::new(1, payload);
        assert_eq!(chip.payload, payload);
    }
}
