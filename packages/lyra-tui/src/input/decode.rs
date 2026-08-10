//! The incremental terminal input decoder.
//!
//! One state machine turns a byte stream from `/dev/tty` into [`Decoded`]
//! events. It is deliberately a *pure* type: no I/O, no threads, no clock. The
//! actor in [`super::actor`] owns all three and drives this.
//!
//! # What it understands
//!
//! | encoding | shape | source |
//! |---|---|---|
//! | kitty keyboard protocol | `CSI code[:alt[:base]] ; mods[:event] [; text] u` | negotiated |
//! | xterm `modifyOtherKeys` | `CSI 27 ; mods ; code ~` | fallback |
//! | legacy function keys | `CSI n [; mods] ~` | universal |
//! | legacy cursor keys | `CSI [1 ; mods] A`…`D`/`H`/`F` | universal |
//! | SS3 application keys | `ESC O [1 ; mods] A`…`D`/`P`…`S`/`M` | universal |
//! | shift+tab | `CSI Z` | universal |
//! | bracketed paste | `CSI 200~ … CSI 201~` | universal |
//! | C0 control bytes | `0x00`…`0x1f`, `0x7f` | universal |
//! | `Alt`+key | `ESC <key>` | universal |
//! | terminal replies | DA1/DA2, DECRPM, CPR, kitty-flags, DCS, OSC | — |
//!
//! Mouse reporting is **not** listed because this crate never enables it
//! (DESIGN.md §1/§5). Any `CSI … M`/`m` that arrives anyway is dropped rather
//! than surfaced, so a terminal left in mouse mode by a previous program cannot
//! inject garbage into the composer.
//!
//! # The one ambiguity
//!
//! A lone `ESC` byte is either the Escape key or the first byte of a sequence
//! that has not finished arriving. No amount of parsing resolves it — only time
//! does. [`Decoder::pending_escape`] reports the ambiguity and
//! [`Decoder::flush_escape`] resolves it in favour of the Escape key; the actor
//! calls the second after a short read timeout. Under the kitty protocol the
//! Escape key is reported as `CSI 27 u`, so the ambiguity — and its latency —
//! simply does not arise.

use super::key::{decode_control_byte, normalise_codepoint, KeyCode, KeyEvent, KeyMods};

/// The result of decoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decoded {
    /// A keystroke.
    Key(KeyEvent),
    /// A bracketed-paste payload, with `\r\n`/`\r` already normalised to `\n`.
    Paste(String),
    /// A terminal *reply* (DA1, DECRPM, CPR, kitty flags, DCS, OSC), verbatim.
    ///
    /// Replies are routed to the capability layer rather than to the keymap.
    /// Keeping them in the same decoder is what lets the input actor own the tty
    /// file descriptor outright: there is no second reader racing it for the
    /// answer to `CSI c` (see [`super::actor`]).
    Reply(Vec<u8>),
}

/// Byte-stream decoder. Feed it bytes, pull events.
#[derive(Debug, Default)]
pub struct Decoder {
    buf: Vec<u8>,
    /// Accumulating bracketed-paste payload, when inside `CSI 200~`.
    paste: Option<Vec<u8>>,
}

/// Bracketed paste terminator.
const PASTE_END: &[u8] = b"\x1b[201~";

impl Decoder {
    /// An empty decoder.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            buf: Vec::new(),
            paste: None,
        }
    }

    /// Append raw bytes.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Whether anything at all is buffered.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty() && self.paste.is_none()
    }

    /// Whether the buffer ends in an unresolved escape prefix.
    ///
    /// True for a lone `ESC` and for a half-arrived `ESC [ 1 ;` — both need
    /// either more bytes or the escape timeout.
    #[must_use]
    pub fn pending_escape(&self) -> bool {
        self.paste.is_none() && self.buf.first() == Some(&0x1b)
    }

    /// Pull the next fully-determined event.
    ///
    /// `None` means "the buffer holds only an incomplete prefix" — never "no
    /// input". Call it in a loop until it returns `None`.
    pub fn pop(&mut self) -> Option<Decoded> {
        loop {
            if let Some(event) = self.step()? {
                return Some(event);
            }
            // `Some(None)`: bytes were consumed but produced nothing the caller
            // should see (a key-release report, a stray paste terminator, a
            // mouse packet). Keep going rather than returning a spurious `None`,
            // which the caller reads as "incomplete".
        }
    }

    /// Resolve a pending escape in favour of the Escape key.
    ///
    /// Called by the actor when the escape timeout expires. A half-arrived
    /// sequence degrades the xterm way: the `ESC` becomes an Escape keypress and
    /// the bytes behind it decode as ordinary keys, which is exactly what the
    /// user sees if they typed `Esc` then `[`.
    pub fn flush_escape(&mut self) -> Option<Decoded> {
        if !self.pending_escape() {
            return None;
        }
        self.buf.remove(0);
        Some(Decoded::Key(KeyEvent::new(KeyCode::Esc)))
    }

    /// One decoding step.
    ///
    /// `None` — incomplete. `Some(None)` — consumed, nothing to report.
    #[allow(clippy::option_option)]
    fn step(&mut self) -> Option<Option<Decoded>> {
        if self.paste.is_some() {
            return self.step_paste();
        }
        let first = *self.buf.first()?;
        if first == 0x1b {
            return self.step_escape();
        }
        if first < 0x20 || first == 0x7f {
            self.buf.remove(0);
            return Some(decode_control_byte(first).map(Decoded::Key));
        }
        self.step_utf8(0)
    }

    /// Accumulate a bracketed paste until its terminator.
    #[allow(clippy::option_option)]
    fn step_paste(&mut self) -> Option<Option<Decoded>> {
        let end = find(&self.buf, PASTE_END)?;
        let mut payload = self.paste.take().unwrap_or_default();
        payload.extend_from_slice(&self.buf[..end]);
        self.buf.drain(..end + PASTE_END.len());
        let text = String::from_utf8_lossy(&payload).replace("\r\n", "\n").replace('\r', "\n");
        Some(Some(Decoded::Paste(text)))
    }

    /// A UTF-8 scalar starting at `at`, emitted as a character key.
    #[allow(clippy::option_option)]
    fn step_utf8(&mut self, at: usize) -> Option<Option<Decoded>> {
        let lead = *self.buf.get(at)?;
        let len = match lead {
            0x00..=0x7f => 1,
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            // A stray continuation byte. Drop it; resynchronising beats emitting
            // a replacement character into the user's prompt.
            _ => {
                self.buf.drain(..=at);
                return Some(None);
            }
        };
        if self.buf.len() < at + len {
            return None;
        }
        let bytes: Vec<u8> = self.buf.drain(..at + len).skip(at).collect();
        let event = std::str::from_utf8(&bytes)
            .ok()
            .and_then(|text| text.chars().next())
            .map(|c| Decoded::Key(KeyEvent::char(c)));
        Some(event)
    }

    /// Everything that starts with `ESC`.
    #[allow(clippy::option_option)]
    fn step_escape(&mut self) -> Option<Option<Decoded>> {
        match self.buf.get(1) {
            // Ambiguous: only the escape timeout can resolve it.
            None => None,
            Some(b'[') => self.step_csi(),
            Some(b'O') => self.step_ss3(),
            // DCS / OSC / APC / PM / SOS: string-terminated replies. XTVERSION
            // and OSC 11 (background luminance) both land here.
            Some(b'P' | b']' | b'_' | b'^' | b'X') => self.step_string_reply(),
            // `ESC ESC`: the first is the Escape key, the second re-enters this
            // path on the next call.
            Some(0x1b) => {
                self.buf.remove(0);
                Some(Some(Decoded::Key(KeyEvent::new(KeyCode::Esc))))
            }
            Some(byte) => {
                let byte = *byte;
                if byte < 0x20 || byte == 0x7f {
                    self.buf.drain(..2);
                    let event = decode_control_byte(byte).map(|key| {
                        Decoded::Key(KeyEvent::with(key.code, key.mods | KeyMods::ALT))
                    });
                    return Some(event);
                }
                // `ESC <char>` — Alt+char, the fallback every terminal supports.
                let decoded = self.step_utf8(1)?;
                Some(decoded.map(|event| match event {
                    Decoded::Key(key) => {
                        Decoded::Key(KeyEvent::with(key.code, key.mods | KeyMods::ALT))
                    }
                    other => other,
                }))
            }
        }
    }

    /// `ESC P` / `ESC ]` / `ESC _` / `ESC ^` — a string reply terminated by
    /// `ST` (`ESC \`) or, for OSC, `BEL`.
    #[allow(clippy::option_option)]
    fn step_string_reply(&mut self) -> Option<Option<Decoded>> {
        let st = find(&self.buf[2..], b"\x1b\\").map(|at| (at + 2, 2));
        let bel = find(&self.buf[2..], b"\x07").map(|at| (at + 2, 1));
        let (end, terminator) = match (st, bel) {
            (Some(a), Some(b)) => {
                if a.0 <= b.0 {
                    a
                } else {
                    b
                }
            }
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => return None,
        };
        let reply: Vec<u8> = self.buf.drain(..end + terminator).collect();
        Some(Some(Decoded::Reply(reply)))
    }

    /// `ESC O …` — the SS3 zoo. Application-cursor mode and the F1–F4 block.
    #[allow(clippy::option_option)]
    fn step_ss3(&mut self) -> Option<Option<Decoded>> {
        // Some terminals send `ESC O 1 ; mods P` for a modified F1.
        let mut at = 2usize;
        while matches!(self.buf.get(at), Some(0x30..=0x3b)) {
            at += 1;
        }
        let final_byte = *self.buf.get(at)?;
        let params = parse_params(&self.buf[2..at]);
        let mods = params.get(1).and_then(|group| group.first()).map_or(
            KeyMods::NONE,
            |value| KeyMods::from_csi_param(*value),
        );
        let code = match final_byte {
            b'A' => KeyCode::Up,
            b'B' => KeyCode::Down,
            b'C' => KeyCode::Right,
            b'D' => KeyCode::Left,
            b'H' => KeyCode::Home,
            b'F' => KeyCode::End,
            b'P' => KeyCode::F(1),
            b'Q' => KeyCode::F(2),
            b'R' => KeyCode::F(3),
            b'S' => KeyCode::F(4),
            // Keypad Enter. Terminals that send it expect Enter semantics.
            b'M' => KeyCode::Enter,
            _ => {
                self.buf.drain(..=at);
                return Some(None);
            }
        };
        self.buf.drain(..=at);
        Some(Some(Decoded::Key(KeyEvent::with(code, mods))))
    }

    /// `ESC [ …` — the CSI zoo, keys and replies alike.
    #[allow(clippy::option_option, clippy::too_many_lines)]
    fn step_csi(&mut self) -> Option<Option<Decoded>> {
        let mut at = 2usize;
        // Private-marker bytes (`<`, `=`, `>`, `?`) precede the parameters.
        let mut private = None;
        if matches!(self.buf.get(at), Some(0x3c..=0x3f)) {
            private = self.buf.get(at).copied();
            at += 1;
        }
        let params_start = at;
        while matches!(self.buf.get(at), Some(0x30..=0x3b)) {
            at += 1;
        }
        let params_end = at;
        // Intermediates (`$`, `"`, ` `, …) sit between parameters and the final.
        while matches!(self.buf.get(at), Some(0x20..=0x2f)) {
            at += 1;
        }
        let intermediates: Vec<u8> = self.buf[params_end..at].to_vec();
        let final_byte = *self.buf.get(at)?;
        if !(0x40..=0x7e).contains(&final_byte) {
            // Not a legal final byte: the sequence is malformed. Drop the `ESC`
            // and resynchronise rather than swallowing arbitrary input.
            self.buf.remove(0);
            return Some(None);
        }
        let params = parse_params(&self.buf[params_start..params_end]);
        let first = params.first().and_then(|group| group.first()).copied();

        // --- replies -------------------------------------------------------
        //
        // A reply is recognised by its final byte plus, for `u`, the `?` private
        // marker that distinguishes the kitty-flags answer from a kitty key.
        let is_reply = match final_byte {
            b'c' | b'y' | b'n' | b't' => true,
            // CPR. `CSI R` with no parameters is not a cursor report.
            b'R' => private.is_none() && !params.is_empty(),
            b'u' => private == Some(b'?'),
            _ => false,
        };
        if is_reply {
            let reply: Vec<u8> = self.buf.drain(..=at).collect();
            return Some(Some(Decoded::Reply(reply)));
        }

        let event = match final_byte {
            // Kitty keyboard protocol.
            b'u' => {
                let codepoint = first.unwrap_or(0);
                let mods = params
                    .get(1)
                    .and_then(|group| group.first())
                    .map_or(KeyMods::NONE, |value| KeyMods::from_csi_param(*value));
                // Sub-parameter 2 of the modifier group is the event type:
                // 1 press, 2 repeat, 3 release. Releases are dropped — the
                // registry is a press-only surface and reporting both would
                // fire every binding twice.
                let released = params
                    .get(1)
                    .and_then(|group| group.get(1))
                    .is_some_and(|kind| *kind == 3);
                if released {
                    None
                } else {
                    normalise_codepoint(codepoint, mods).map(Decoded::Key)
                }
            }
            b'~' => {
                let mods = params
                    .get(1)
                    .and_then(|group| group.first())
                    .map_or(KeyMods::NONE, |value| KeyMods::from_csi_param(*value));
                match first {
                    // Bracketed paste opens here; the payload is accumulated by
                    // `step_paste` until `CSI 201~`.
                    Some(200) => {
                        self.buf.drain(..=at);
                        self.paste = Some(Vec::new());
                        return Some(None);
                    }
                    // A terminator with no opener: a paste that began before we
                    // started reading. Dropping it is the honest answer.
                    Some(201) => None,
                    // xterm `modifyOtherKeys`: `CSI 27 ; mods ; codepoint ~`.
                    Some(27) => params
                        .get(2)
                        .and_then(|group| group.first())
                        .and_then(|codepoint| normalise_codepoint(*codepoint, mods))
                        .map(Decoded::Key),
                    Some(value) => {
                        function_key(value).map(|code| Decoded::Key(KeyEvent::with(code, mods)))
                    }
                    None => None,
                }
            }
            b'A' | b'B' | b'C' | b'D' | b'H' | b'F' | b'E' | b'P' | b'Q' | b'S' => {
                // `CSI 1 ; mods X`. The leading `1` is the (ignored) row count.
                let mods = params
                    .get(1)
                    .and_then(|group| group.first())
                    .map_or(KeyMods::NONE, |value| KeyMods::from_csi_param(*value));
                let code = match final_byte {
                    b'A' => KeyCode::Up,
                    b'B' => KeyCode::Down,
                    b'C' => KeyCode::Right,
                    b'D' => KeyCode::Left,
                    b'H' => KeyCode::Home,
                    b'F' => KeyCode::End,
                    b'E' => KeyCode::Char('5'),
                    b'P' => KeyCode::F(1),
                    b'Q' => KeyCode::F(2),
                    _ => KeyCode::F(4),
                };
                Some(Decoded::Key(KeyEvent::with(code, mods)))
            }
            // Shift+Tab. Every terminal spells it this way and none of them
            // report it as Tab with a shift bit.
            b'Z' => Some(Decoded::Key(KeyEvent::new(KeyCode::BackTab))),
            // Focus in/out and mouse packets. Neither is ever enabled by this
            // crate (DESIGN.md §5); a terminal left in mouse mode by a previous
            // program must not be able to type into the composer.
            b'I' | b'O' | b'M' | b'm' => None,
            _ => None,
        };
        let _ = intermediates;
        self.buf.drain(..=at);
        Some(event)
    }
}

/// The `CSI n ~` function-key table.
fn function_key(value: u32) -> Option<KeyCode> {
    Some(match value {
        1 | 7 => KeyCode::Home,
        2 => KeyCode::Insert,
        3 => KeyCode::Delete,
        4 | 8 => KeyCode::End,
        5 => KeyCode::PageUp,
        6 => KeyCode::PageDown,
        11..=15 => KeyCode::F((value - 10) as u8),
        // `16` is skipped by the historical DEC table.
        17..=21 => KeyCode::F((value - 11) as u8),
        // `22` is skipped too.
        23..=26 => KeyCode::F((value - 12) as u8),
        28 | 29 => KeyCode::F((value - 13) as u8),
        31..=34 => KeyCode::F((value - 14) as u8),
        _ => return None,
    })
}

/// Split CSI parameter bytes into groups (`;`) of sub-parameters (`:`).
///
/// An empty field is a *default*, which callers read as "absent" rather than
/// as zero — `CSI ;5u` has no key code, not key code 0.
fn parse_params(bytes: &[u8]) -> Vec<Vec<u32>> {
    if bytes.is_empty() {
        return Vec::new();
    }
    bytes
        .split(|byte| *byte == b';')
        .map(|group| {
            group
                .split(|byte| *byte == b':')
                .filter_map(|field| {
                    std::str::from_utf8(field).ok()?.parse::<u32>().ok()
                })
                .collect()
        })
        .collect()
}

/// Index of `needle` in `haystack`.
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(bytes: &[u8]) -> Vec<Decoded> {
        let mut decoder = Decoder::new();
        decoder.feed(bytes);
        let mut out = Vec::new();
        while let Some(event) = decoder.pop() {
            out.push(event);
        }
        out
    }

    fn keys(bytes: &[u8]) -> Vec<KeyEvent> {
        decode(bytes)
            .into_iter()
            .filter_map(|event| match event {
                Decoded::Key(key) => Some(key),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn plain_text_decodes_to_character_keys() {
        assert_eq!(
            keys(b"hi"),
            [KeyEvent::char('h'), KeyEvent::char('i')]
        );
    }

    #[test]
    fn multibyte_utf8_survives_being_split_across_reads() {
        let mut decoder = Decoder::new();
        let bytes = "é".as_bytes();
        decoder.feed(&bytes[..1]);
        assert_eq!(decoder.pop(), None, "half a scalar is not a keystroke");
        decoder.feed(&bytes[1..]);
        assert_eq!(decoder.pop(), Some(Decoded::Key(KeyEvent::char('é'))));
    }

    #[test]
    fn kitty_discriminates_the_three_enters() {
        assert_eq!(keys(b"\x1b[13u"), [KeyEvent::new(KeyCode::Enter)]);
        assert_eq!(
            keys(b"\x1b[13;2u"),
            [KeyEvent::with(KeyCode::Enter, KeyMods::SHIFT)]
        );
        assert_eq!(
            keys(b"\x1b[13;5u"),
            [KeyEvent::with(KeyCode::Enter, KeyMods::CTRL)]
        );
        assert_eq!(
            keys(b"\x1b[13;3u"),
            [KeyEvent::with(KeyCode::Enter, KeyMods::ALT)]
        );
    }

    #[test]
    fn kitty_key_release_reports_are_dropped() {
        // Press then release of ctrl+s under flags that report event types.
        assert_eq!(keys(b"\x1b[115;5:1u\x1b[115;5:3u"), [KeyEvent::ctrl('s')]);
    }

    #[test]
    fn kitty_alternate_key_subparameters_do_not_confuse_the_code() {
        // `CSI 97:65;2u` — key `a`, shifted form `A`, shift held.
        assert_eq!(keys(b"\x1b[97:65;2u"), [KeyEvent::char('A')]);
    }

    #[test]
    fn modify_other_keys_is_understood_as_a_fallback() {
        // xterm level 1: ctrl+enter as `CSI 27 ; 5 ; 13 ~`.
        assert_eq!(
            keys(b"\x1b[27;5;13~"),
            [KeyEvent::with(KeyCode::Enter, KeyMods::CTRL)]
        );
    }

    #[test]
    fn the_legacy_function_key_table_is_covered() {
        assert_eq!(keys(b"\x1b[3~"), [KeyEvent::new(KeyCode::Delete)]);
        assert_eq!(keys(b"\x1b[5~"), [KeyEvent::new(KeyCode::PageUp)]);
        assert_eq!(keys(b"\x1b[15~"), [KeyEvent::new(KeyCode::F(5))]);
        assert_eq!(keys(b"\x1b[24~"), [KeyEvent::new(KeyCode::F(12))]);
        assert_eq!(
            keys(b"\x1b[3;5~"),
            [KeyEvent::with(KeyCode::Delete, KeyMods::CTRL)]
        );
    }

    #[test]
    fn cursor_keys_decode_in_both_normal_and_application_mode() {
        assert_eq!(keys(b"\x1b[A"), [KeyEvent::new(KeyCode::Up)]);
        assert_eq!(keys(b"\x1bOA"), [KeyEvent::new(KeyCode::Up)]);
        assert_eq!(
            keys(b"\x1b[1;5C"),
            [KeyEvent::with(KeyCode::Right, KeyMods::CTRL)]
        );
        assert_eq!(
            keys(b"\x1b[1;3D"),
            [KeyEvent::with(KeyCode::Left, KeyMods::ALT)]
        );
    }

    #[test]
    fn ss3_covers_f1_through_f4_and_keypad_enter() {
        assert_eq!(keys(b"\x1bOP"), [KeyEvent::new(KeyCode::F(1))]);
        assert_eq!(keys(b"\x1bOS"), [KeyEvent::new(KeyCode::F(4))]);
        assert_eq!(keys(b"\x1bOM"), [KeyEvent::new(KeyCode::Enter)]);
    }

    #[test]
    fn shift_tab_is_its_own_key() {
        assert_eq!(keys(b"\x1b[Z"), [KeyEvent::new(KeyCode::BackTab)]);
    }

    #[test]
    fn alt_char_is_the_universal_meta_fallback() {
        assert_eq!(keys(b"\x1bb"), [KeyEvent::alt('b')]);
        assert_eq!(keys(b"\x1bf"), [KeyEvent::alt('f')]);
        assert_eq!(
            keys(b"\x1b\r"),
            [KeyEvent::with(KeyCode::Enter, KeyMods::ALT)],
            "alt+enter is the newline fallback where kitty is unavailable"
        );
    }

    #[test]
    fn a_lone_escape_is_ambiguous_until_the_timeout() {
        let mut decoder = Decoder::new();
        decoder.feed(b"\x1b");
        assert_eq!(decoder.pop(), None);
        assert!(decoder.pending_escape());
        assert_eq!(
            decoder.flush_escape(),
            Some(Decoded::Key(KeyEvent::new(KeyCode::Esc)))
        );
        assert!(decoder.is_empty());
    }

    #[test]
    fn escape_escape_reports_two_escapes() {
        let mut decoder = Decoder::new();
        decoder.feed(b"\x1b\x1b");
        assert_eq!(
            decoder.pop(),
            Some(Decoded::Key(KeyEvent::new(KeyCode::Esc)))
        );
        assert_eq!(decoder.pop(), None);
        assert_eq!(
            decoder.flush_escape(),
            Some(Decoded::Key(KeyEvent::new(KeyCode::Esc)))
        );
    }

    #[test]
    fn a_half_arrived_sequence_degrades_to_escape_plus_its_bytes() {
        let mut decoder = Decoder::new();
        decoder.feed(b"\x1b[1;");
        assert_eq!(decoder.pop(), None);
        assert_eq!(
            decoder.flush_escape(),
            Some(Decoded::Key(KeyEvent::new(KeyCode::Esc)))
        );
        assert_eq!(
            keys_of(&mut decoder),
            [
                KeyEvent::char('['),
                KeyEvent::char('1'),
                KeyEvent::char(';')
            ]
        );
    }

    fn keys_of(decoder: &mut Decoder) -> Vec<KeyEvent> {
        let mut out = Vec::new();
        while let Some(Decoded::Key(key)) = decoder.pop() {
            out.push(key);
        }
        out
    }

    #[test]
    fn bracketed_paste_is_one_event_with_normalised_newlines() {
        assert_eq!(
            decode(b"\x1b[200~a\r\nb\rc\x1b[201~"),
            [Decoded::Paste("a\nb\nc".to_owned())]
        );
    }

    #[test]
    fn a_paste_split_across_reads_is_reassembled() {
        let mut decoder = Decoder::new();
        decoder.feed(b"\x1b[200~one\n");
        assert_eq!(decoder.pop(), None, "no partial paste is ever emitted");
        decoder.feed(b"two\x1b[201~");
        assert_eq!(decoder.pop(), Some(Decoded::Paste("one\ntwo".to_owned())));
    }

    #[test]
    fn escape_sequences_inside_a_paste_are_payload_not_keys() {
        // A pasted literal `ESC [ A` must not become an Up arrow.
        let events = decode(b"\x1b[200~\x1b[A\x1b[201~");
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], Decoded::Paste(text) if text == "\u{1b}[A"));
    }

    #[test]
    fn terminal_replies_are_routed_away_from_the_keymap() {
        let events = decode(b"\x1b[?2026;2$y\x1b[14;1R\x1b[?62;4c\x1b[?1u");
        assert_eq!(events.len(), 4, "{events:?}");
        assert!(events.iter().all(|event| matches!(event, Decoded::Reply(_))));
    }

    #[test]
    fn a_kitty_key_is_not_mistaken_for_a_kitty_flags_reply() {
        // `CSI ? 1 u` is the flags answer; `CSI 1 1 5 ; 5 u` is ctrl+s.
        assert_eq!(keys(b"\x1b[115;5u"), [KeyEvent::ctrl('s')]);
        assert!(matches!(
            decode(b"\x1b[?1u").as_slice(),
            [Decoded::Reply(_)]
        ));
    }

    #[test]
    fn xtversion_and_osc_replies_are_replies() {
        let events = decode(b"\x1bP>|ghostty 1.0\x1b\\\x1b]11;rgb:1c/1c/1c\x07");
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|event| matches!(event, Decoded::Reply(_))));
    }

    #[test]
    fn mouse_packets_are_dropped_rather_than_typed_into_the_composer() {
        // A terminal left in SGR mouse mode by a previous program.
        assert_eq!(keys(b"\x1b[<0;10;5M\x1b[<0;10;5m"), []);
    }

    #[test]
    fn control_bytes_pass_through() {
        assert_eq!(
            keys(b"\x01\x05\x0b"),
            [
                KeyEvent::ctrl('a'),
                KeyEvent::ctrl('e'),
                KeyEvent::ctrl('k')
            ]
        );
    }

    #[test]
    fn a_stray_utf8_continuation_byte_resynchronises() {
        assert_eq!(keys(b"\x80a"), [KeyEvent::char('a')]);
    }
}
