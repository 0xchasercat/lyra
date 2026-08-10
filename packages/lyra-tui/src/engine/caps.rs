//! Terminal capability probing (DESIGN.md §4: "capability detection via
//! DA1-sentinel batch probing (zero timeouts, SSH-safe)").
//!
//! # The DA1 sentinel
//!
//! Feature queries have no negative reply: a terminal that does not understand
//! `CSI ? 2026 $ p` answers nothing at all. Waiting on silence costs a timeout
//! per query, which over SSH is the difference between an instant start and a
//! visibly stalled one.
//!
//! The fix is to batch every query and append `CSI c` (Primary Device
//! Attributes), which **every** terminal answers. The DA1 reply is therefore a
//! sentinel: once it arrives, every earlier query has either answered or never
//! will. One round trip, no per-feature timeout. The outer deadline only ever
//! fires for a terminal that answers nothing, i.e. not a terminal at all.
//!
//! Probed here: synchronized output (DECRQM 2026) and the current cursor row
//! (CPR), which the compositor needs to know where it may put the live region
//! without disturbing whatever the shell already printed.

use std::io::Write;
use std::time::Duration;

use crossbeam_channel::{Receiver, RecvTimeoutError};

/// What the terminal can do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Caps {
    /// DEC private mode 2026 is understood. Live-region updates are wrapped in
    /// BSU/ESU so the terminal composites one frame instead of tearing.
    pub synchronized_output: bool,
    /// Cursor row when probing finished, 1-indexed. `None` when unknown, in
    /// which case the compositor assumes the bottom of the screen.
    pub cursor_row: Option<u16>,
    /// Cursor column when probing finished, 1-indexed.
    pub cursor_col: Option<u16>,
    /// Whether a reply of any kind arrived. `false` means "not a terminal".
    pub responsive: bool,
}

/// Begin Synchronized Update.
pub const BSU: &[u8] = b"\x1b[?2026h";
/// End Synchronized Update.
pub const ESU: &[u8] = b"\x1b[?2026l";

/// The batched probe: DECRQM(2026), CPR, then the DA1 sentinel.
const PROBE: &[u8] = b"\x1b[?2026$p\x1b[6n\x1b[c";

/// Probe the terminal, reading the answers from the input actor.
///
/// # Who reads the terminal (amended in build phase 4)
///
/// This used to detach its own reader thread on `/dev/tty`. That was safe only
/// while nothing else read the same descriptor, and phase 4's composer does. Two
/// readers on one tty cannot be reconciled — whichever calls `read` first gets
/// the bytes — so the reader moved out rather than being synchronised:
/// [`crate::input::actor::InputActor`] owns the descriptor, decodes everything,
/// and routes terminal *replies* to the channel this function drains. The DA1
/// sentinel logic is unchanged; only its source of bytes is.
///
/// The terminal must already be in raw mode, otherwise the replies are line
/// buffered and the deadline always fires.
///
/// # Errors
///
/// Propagates write failures. A silent terminal is not an error: it yields
/// [`Caps::default`], and the engine degrades to unsynchronized updates at the
/// bottom of the screen.
pub fn probe_replies<W: Write>(
    writer: &mut W,
    replies: &Receiver<Vec<u8>>,
    deadline: Duration,
) -> std::io::Result<Caps> {
    writer.write_all(PROBE)?;
    writer.flush()?;

    let started = std::time::Instant::now();
    let mut buffer = Vec::new();
    loop {
        let remaining = deadline.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        match replies.recv_timeout(remaining) {
            Ok(chunk) => {
                buffer.extend_from_slice(&chunk);
                if has_da1_sentinel(&buffer) {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
        }
    }
    Ok(parse(&buffer))
}

/// Whether the DA1 reply (`CSI ? … c`) is present.
#[must_use]
pub fn has_da1_sentinel(buffer: &[u8]) -> bool {
    replies(buffer).any(|(final_byte, _)| final_byte == b'c')
}

/// Parse a probe reply buffer into capabilities.
#[must_use]
pub fn parse(buffer: &[u8]) -> Caps {
    let mut caps = Caps::default();
    for (final_byte, params) in replies(buffer) {
        caps.responsive = true;
        match final_byte {
            // DECRPM: `CSI ? 2026 ; Ps $ y`. Ps 1 = set, 2 = reset, 3 = permanently
            // set, 4 = permanently reset. 0 means "mode not recognised" — the only
            // reply that means unsupported. `$` lands in `params` as a trailing
            // intermediate, so match on the numeric prefix.
            b'y' => {
                let numbers = numbers(params);
                if numbers.first() == Some(&2026) {
                    caps.synchronized_output =
                        matches!(numbers.get(1), Some(1..=4));
                }
            }
            // CPR: `CSI row ; col R`.
            b'R' => {
                let numbers = numbers(params);
                caps.cursor_row = numbers.first().and_then(|row| u16::try_from(*row).ok());
                caps.cursor_col = numbers.get(1).and_then(|col| u16::try_from(*col).ok());
            }
            _ => {}
        }
    }
    caps
}

/// Iterate CSI replies as `(final byte, parameter bytes)`.
fn replies(buffer: &[u8]) -> impl Iterator<Item = (u8, &[u8])> {
    let mut index = 0usize;
    std::iter::from_fn(move || {
        while index + 1 < buffer.len() {
            if buffer[index] != 0x1b || buffer[index + 1] != b'[' {
                index += 1;
                continue;
            }
            let start = index + 2;
            let mut end = start;
            // Parameter and intermediate bytes precede a final byte in 0x40..=0x7e.
            while end < buffer.len() && !(0x40..=0x7e).contains(&buffer[end]) {
                end += 1;
            }
            if end >= buffer.len() {
                index = buffer.len();
                return None;
            }
            let params = &buffer[start..end];
            let final_byte = buffer[end];
            index = end + 1;
            return Some((final_byte, params));
        }
        None
    })
}

/// Extract the semicolon-separated numeric parameters, ignoring `?` and `$`.
fn numbers(params: &[u8]) -> Vec<u32> {
    params
        .split(|byte| *byte == b';')
        .filter_map(|field| {
            let digits: Vec<u8> = field
                .iter()
                .copied()
                .filter(u8::is_ascii_digit)
                .collect();
            if digits.is_empty() {
                return None;
            }
            std::str::from_utf8(&digits).ok()?.parse().ok()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_ghostty_style_reply() {
        // DECRPM(2026)=2 (reset but supported), CPR row 14 col 1, DA1 sentinel.
        let caps = parse(b"\x1b[?2026;2$y\x1b[14;1R\x1b[?62;c");
        assert!(caps.synchronized_output);
        assert_eq!(caps.cursor_row, Some(14));
        assert_eq!(caps.cursor_col, Some(1));
        assert!(caps.responsive);
    }

    #[test]
    fn mode_zero_means_the_terminal_does_not_know_2026() {
        let caps = parse(b"\x1b[?2026;0$y\x1b[3;1R\x1b[?1;2c");
        assert!(!caps.synchronized_output);
        assert_eq!(caps.cursor_row, Some(3));
    }

    #[test]
    fn a_terminal_that_answers_only_the_sentinel_degrades_cleanly() {
        let caps = parse(b"\x1b[?1;2c");
        assert!(!caps.synchronized_output);
        assert_eq!(caps.cursor_row, None);
        assert!(caps.responsive, "DA1 alone still proves a terminal is there");
    }

    #[test]
    fn silence_yields_defaults_rather_than_a_wrong_guess() {
        let caps = parse(b"");
        assert_eq!(caps, Caps::default());
        assert!(!caps.responsive);
    }

    #[test]
    fn the_sentinel_is_recognised_only_by_the_da1_final_byte() {
        assert!(!has_da1_sentinel(b"\x1b[?2026;2$y"));
        assert!(!has_da1_sentinel(b"\x1b[14;1R"));
        assert!(has_da1_sentinel(b"\x1b[?2026;2$y\x1b[14;1R\x1b[?62;4c"));
    }

    #[test]
    fn replies_split_across_reads_are_reassembled_by_the_caller_buffer() {
        let mut buffer = Vec::new();
        buffer.extend_from_slice(b"\x1b[?2026");
        assert!(!has_da1_sentinel(&buffer));
        buffer.extend_from_slice(b";2$y\x1b[?62c");
        assert!(has_da1_sentinel(&buffer));
        assert!(parse(&buffer).synchronized_output);
    }

    #[test]
    fn stray_keystrokes_interleaved_with_replies_are_ignored() {
        // The user typed "hi" while the probe was in flight.
        let caps = parse(b"h\x1b[?2026;1$yi\x1b[9;3R\x1b[?62c");
        assert!(caps.synchronized_output);
        assert_eq!(caps.cursor_row, Some(9));
    }
}
