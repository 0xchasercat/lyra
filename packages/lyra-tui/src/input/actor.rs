//! The input actor: the **sole** reader of the terminal.
//!
//! # Why this owns the file descriptor
//!
//! Build phase 2 probed capabilities by detaching a thread on `/dev/tty` and
//! reading the replies from it. That was correct exactly as long as nothing else
//! read the same descriptor — and the note in `engine/caps.rs` said so. Two
//! readers on one tty is not a race you can win: bytes are delivered to whoever
//! calls `read` first, so a keystroke typed during a probe can vanish into the
//! probe's buffer and a DA1 reply can vanish into the keymap.
//!
//! Phase 4 removes the second reader instead of synchronising it. This actor
//! starts **before** any probe, takes the descriptor, and decodes everything.
//! Terminal *replies* (DA1, DECRPM, CPR, the kitty flags answer, DCS, OSC) are
//! routed to a separate channel that [`crate::engine::caps::probe_replies`] and
//! [`negotiate_kitty`] read; keystrokes go to the event channel. One reader, two
//! consumers, no race.
//!
//! The reader thread is detached, because a blocking `read` on a tty cannot be
//! cancelled without `unsafe` and this crate forbids it. That is safe here in a
//! way it was not before: the thread owns the descriptor for the life of the
//! process and there is no one to race.
//!
//! # Resize
//!
//! `SIGWINCH`, not polling. Phase 2 called `terminal::size()` once per frame,
//! which costs an `ioctl` per frame and still misses a resize between frames.
//! The signal thread emits [`InputEvent::Resize`] into the same channel as keys,
//! so the engine's debounced resize path (`engine::resize::ResizeDebouncer`)
//! sees resizes as events rather than as poll results.
//!
//! # Mouse
//!
//! Never enabled, never parsed into events (DESIGN.md §1/§5). The terminal keeps
//! selection, copy and search.
//!
//! # Degradation matrix
//!
//! DESIGN.md §4 asks for kitty negotiation *and* "full legacy fallback parsing",
//! which means being explicit about what is lost where. Three tiers, chosen by
//! what the terminal answers at startup:
//!
//! | tier | detected by | `Enter` | `Shift+Enter` | `Ctrl+Enter` | `Alt+Enter` | `Esc` latency | `Ctrl+Shift+…` | `Super+…` |
//! |---|---|---|---|---|---|---|---|---|
//! | **kitty** | `CSI ? <flags> u` | `CSI 13u` | `CSI 13;2u` | `CSI 13;5u` | `CSI 13;3u` | none | yes | yes |
//! | **modifyOtherKeys** | DA1 only | `\r` | `CSI 27;2;13~` ¹ | `CSI 27;5;13~` ¹ | `ESC \r` | 25 ms | partial ² | no |
//! | **bare legacy** | DA1 only, level 1 ignored | `\r` | `\r` ³ | `\r` ³ | `ESC \r` | 25 ms | no | no |
//!
//! 1. xterm, foot, and WezTerm honour level 1 for `Enter`. Terminals that accept
//!    `CSI > 4 ; 1 m` and then ignore it land in the bare-legacy row, which is
//!    why the fallback below is not conditional on anything.
//! 2. Only for keys the terminal cannot otherwise represent; `Ctrl+Shift+S` is
//!    commonly indistinguishable from `Ctrl+S`.
//! 3. Terminal.app, older iTerm2, Linux console. `Shift+Enter` is physically
//!    unreportable there.
//!
//! **The fallback that makes tier 3 usable is `Alt+Enter`**, which is `ESC \r`
//! and which every terminal in existence sends. It is declared alongside
//! `Shift+Enter` in [`crate::keybind::BINDINGS`] rather than being substituted
//! at runtime, so the cheatsheet lists both and no tier detection is needed to
//! know what to press. `Ctrl+J` (`\n`) is declared as a third spelling for the
//! terminals that swallow `Alt`.
//!
//! Everything else degrades without a decision: `Shift+Tab` is `CSI Z`
//! everywhere, bracketed paste is universal, and the readline set is built from
//! C0 control bytes and `ESC <char>`, which predate all of this.

use std::io::{self, Read, Write};
use std::time::Duration;

use crossbeam_channel::{bounded, unbounded, Receiver, RecvTimeoutError, Sender};

use super::decode::{Decoded, Decoder};
use super::key::KeyEvent;

/// How long a lone `ESC` waits for the rest of a sequence before it is taken to
/// be the Escape key.
///
/// 25 ms is under the threshold at which a keypress feels delayed and well over
/// the inter-byte gap of a locally generated escape sequence. Under the kitty
/// protocol the ambiguity does not arise at all — Escape arrives as `CSI 27 u` —
/// so this latency is only ever paid by legacy terminals.
pub const ESCAPE_TIMEOUT: Duration = Duration::from_millis(25);

/// The default probe deadline. Only ever reached by something that is not a
/// terminal, because every probe is DA1-sentinel bounded.
pub const PROBE_DEADLINE: Duration = Duration::from_millis(200);

/// What the actor emits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputEvent {
    /// A keystroke.
    Key(KeyEvent),
    /// A bracketed paste, newlines normalised.
    Paste(String),
    /// The terminal changed size (`SIGWINCH`).
    Resize {
        /// Columns.
        width: u16,
        /// Rows.
        height: u16,
    },
    /// The terminal closed. No further events will arrive.
    Closed,
}

/// What the kitty keyboard protocol negotiation found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KittySupport {
    /// Whether the terminal answered the flags query at all.
    pub active: bool,
    /// The flags the terminal reports as current.
    pub flags: u8,
}

impl KittySupport {
    /// The "this terminal has never heard of kitty" answer.
    #[must_use]
    pub const fn unsupported() -> Self {
        Self {
            active: false,
            flags: 0,
        }
    }
}

/// The flags this client asks for: bit 1, *disambiguate escape codes*.
///
/// Only bit 1. It is the one that buys DESIGN.md §4's requirement — telling
/// `Enter` from `Shift+Enter` from `Ctrl+Enter` — and every higher bit costs
/// something for nothing here:
///
/// - bit 2 (*report event types*) adds key-release reports, which would fire
///   every binding twice unless filtered, and we filter them anyway
///   ([`super::decode`]) for terminals that send them under other flags;
/// - bit 4 (*report alternate keys*) is layout metadata we do not use;
/// - bit 8 (*report all keys as escape codes*) turns ordinary text into CSI-u
///   and would need bit 16 to reconstruct it — a large regression risk for a
///   composer, in exchange for nothing.
pub const KITTY_FLAGS: u8 = 0b1;

/// Push the kitty flags and read the terminal's answer.
///
/// Batched with a `CSI c` sentinel for the same reason
/// [`crate::engine::caps::probe_replies`] is: a terminal that does not know
/// `CSI ? u` answers nothing, and waiting on silence costs a timeout per query.
///
/// When the terminal does not support the protocol, xterm's `modifyOtherKeys`
/// level 1 is enabled instead. It cannot express as much — `Shift+Enter` is
/// reachable, `Ctrl+Enter` usually is, `Super` never is — but it is the best
/// fallback that exists, and the decoder understands both.
///
/// # Errors
///
/// Propagates write failures on the terminal.
pub fn negotiate_kitty<W: Write>(
    writer: &mut W,
    replies: &Receiver<Vec<u8>>,
    deadline: Duration,
) -> io::Result<KittySupport> {
    // Push our flags, ask what is now current, then the universal sentinel.
    write!(writer, "\x1b[>{KITTY_FLAGS}u\x1b[?u\x1b[c")?;
    writer.flush()?;

    let started = std::time::Instant::now();
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        let remaining = deadline.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        match replies.recv_timeout(remaining) {
            Ok(reply) => {
                let sentinel = ends_csi(&reply, b'c');
                buffer.extend_from_slice(&reply);
                if sentinel {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
        }
    }

    let support = parse_kitty_flags(&buffer).map_or_else(KittySupport::unsupported, |flags| {
        KittySupport {
            active: true,
            flags,
        }
    });
    if !support.active {
        // `CSI > 4 ; 1 m` — modifyOtherKeys level 1. Level 2 is not requested: it
        // reports *ordinary* keys as `CSI 27 ; … ~` too, which breaks terminals
        // that half-implement it.
        writer.write_all(b"\x1b[>4;1m")?;
        writer.flush()?;
    }
    Ok(support)
}

/// Undo whatever [`negotiate_kitty`] turned on.
///
/// Must run before the process exits, or the user's shell inherits a terminal in
/// a keyboard mode it does not understand.
///
/// # Errors
///
/// Propagates write failures on the terminal.
pub fn restore_keyboard<W: Write>(writer: &mut W, support: KittySupport) -> io::Result<()> {
    if support.active {
        // Pop the flags we pushed.
        writer.write_all(b"\x1b[<u")?;
    } else {
        writer.write_all(b"\x1b[>4;0m")?;
    }
    writer.flush()
}

/// Whether `bytes` contains a CSI sequence with the given final byte.
fn ends_csi(bytes: &[u8], final_byte: u8) -> bool {
    let mut index = 0usize;
    while index + 1 < bytes.len() {
        if bytes[index] != 0x1b || bytes[index + 1] != b'[' {
            index += 1;
            continue;
        }
        let mut end = index + 2;
        while end < bytes.len() && !(0x40..=0x7e).contains(&bytes[end]) {
            end += 1;
        }
        if end >= bytes.len() {
            return false;
        }
        if bytes[end] == final_byte {
            return true;
        }
        index = end + 1;
    }
    false
}

/// Extract the flags from a `CSI ? <flags> u` reply.
fn parse_kitty_flags(bytes: &[u8]) -> Option<u8> {
    let mut index = 0usize;
    while index + 2 < bytes.len() {
        if &bytes[index..index + 3] != b"\x1b[?" {
            index += 1;
            continue;
        }
        let start = index + 3;
        let mut end = start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if bytes.get(end) == Some(&b'u') {
            return std::str::from_utf8(&bytes[start..end])
                .ok()
                .and_then(|digits| digits.parse::<u8>().ok())
                .or(Some(0));
        }
        index = end.max(index + 1);
    }
    None
}

/// Splits a decoded stream into key events and terminal replies.
///
/// Pulled out of the actor's thread so the routing rule is testable without
/// threads, signals or a terminal.
#[derive(Debug, Default)]
pub struct Router {
    decoder: Decoder,
}

impl Router {
    /// A fresh router.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            decoder: Decoder::new(),
        }
    }

    /// Whether a lone escape is waiting on [`ESCAPE_TIMEOUT`].
    #[must_use]
    pub fn pending_escape(&self) -> bool {
        self.decoder.pending_escape()
    }

    /// Feed bytes, routing what falls out.
    pub fn feed(
        &mut self,
        bytes: &[u8],
        mut on_event: impl FnMut(InputEvent),
        mut on_reply: impl FnMut(Vec<u8>),
    ) {
        self.decoder.feed(bytes);
        while let Some(decoded) = self.decoder.pop() {
            match decoded {
                Decoded::Key(key) => on_event(InputEvent::Key(key)),
                Decoded::Paste(text) => on_event(InputEvent::Paste(text)),
                Decoded::Reply(reply) => on_reply(reply),
            }
        }
    }

    /// The escape timeout expired: resolve the ambiguity.
    pub fn timeout(&mut self, mut on_event: impl FnMut(InputEvent)) {
        if let Some(Decoded::Key(key)) = self.decoder.flush_escape() {
            on_event(InputEvent::Key(key));
        }
        while let Some(decoded) = self.decoder.pop() {
            match decoded {
                Decoded::Key(key) => on_event(InputEvent::Key(key)),
                Decoded::Paste(text) => on_event(InputEvent::Paste(text)),
                // A reply cannot appear here without more bytes, but routing it
                // to the floor is wrong, so drop it explicitly rather than
                // silently: replies after a timeout belong to nobody.
                Decoded::Reply(_) => {}
            }
        }
    }
}

/// Handle on a running actor.
#[derive(Debug)]
pub struct InputHandle {
    events: Receiver<InputEvent>,
    replies: Receiver<Vec<u8>>,
    signals: Option<signal_hook::iterator::Handle>,
}

impl InputHandle {
    /// Key, paste and resize events.
    #[must_use]
    pub const fn events(&self) -> &Receiver<InputEvent> {
        &self.events
    }

    /// Terminal replies, for the capability layer.
    #[must_use]
    pub const fn replies(&self) -> &Receiver<Vec<u8>> {
        &self.replies
    }

    /// Take everything that has already arrived, without blocking.
    pub fn drain(&self) -> Vec<InputEvent> {
        self.events.try_iter().collect()
    }

    /// The most recent resize in `events`, if any, having consumed the rest.
    ///
    /// Not used by the render loop (which wants every event in order); provided
    /// for teardown paths that only care about the final size.
    pub fn latest_resize(&self) -> Option<(u16, u16)> {
        self.drain()
            .into_iter()
            .filter_map(|event| match event {
                InputEvent::Resize { width, height } => Some((width, height)),
                _ => None,
            })
            .next_back()
    }

    /// Stop the `SIGWINCH` thread. The reader thread outlives the handle by
    /// design; see the module docs.
    pub fn shutdown(&self) {
        if let Some(signals) = &self.signals {
            signals.close();
        }
    }
}

impl Drop for InputHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Starts the actor.
#[derive(Debug)]
pub struct InputActor;

impl InputActor {
    /// Take ownership of a terminal read half and start decoding.
    ///
    /// Call this **before** any capability probe: the probe reads its replies
    /// from [`InputHandle::replies`], and if it opened its own reader the two
    /// would race for the same bytes.
    ///
    /// # Errors
    ///
    /// Fails if a thread cannot be spawned or `SIGWINCH` cannot be registered.
    pub fn start<R: Read + Send + 'static>(reader: R) -> io::Result<InputHandle> {
        Self::start_with(reader, true)
    }

    /// As [`InputActor::start`], with `SIGWINCH` handling optional.
    ///
    /// Resize watching is off in tests and in headless mode, where the process
    /// has no controlling terminal to be resized.
    ///
    /// # Errors
    ///
    /// Fails if a thread cannot be spawned or `SIGWINCH` cannot be registered.
    pub fn start_with<R: Read + Send + 'static>(
        mut reader: R,
        watch_resize: bool,
    ) -> io::Result<InputHandle> {
        let (events_tx, events_rx) = unbounded::<InputEvent>();
        let (replies_tx, replies_rx) = unbounded::<Vec<u8>>();
        // Bounded, because a terminal can produce bytes faster than the decoder
        // drains them (a multi-megabyte paste) and an unbounded queue would just
        // move the memory problem.
        let (raw_tx, raw_rx) = bounded::<Vec<u8>>(256);

        std::thread::Builder::new()
            .name("lyra-tui-tty-read".to_owned())
            .spawn(move || {
                let mut chunk = [0u8; 4096];
                loop {
                    match reader.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            if raw_tx.send(chunk[..read].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
                // Dropping `raw_tx` closes the channel, which the decoder thread
                // reads as end of input.
            })?;

        let decode_events = events_tx.clone();
        std::thread::Builder::new()
            .name("lyra-tui-input".to_owned())
            .spawn(move || {
                let mut router = Router::new();
                loop {
                    let received = if router.pending_escape() {
                        raw_rx.recv_timeout(ESCAPE_TIMEOUT)
                    } else {
                        raw_rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
                    };
                    match received {
                        Ok(bytes) => {
                            let mut closed = false;
                            router.feed(
                                &bytes,
                                |event| {
                                    closed |= decode_events.send(event).is_err();
                                },
                                |reply| {
                                    // A reply with nobody listening is normal
                                    // once probing is done; drop it.
                                    let _ = replies_tx.send(reply);
                                },
                            );
                            if closed {
                                break;
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            let mut closed = false;
                            router.timeout(|event| {
                                closed |= decode_events.send(event).is_err();
                            });
                            if closed {
                                break;
                            }
                        }
                        Err(RecvTimeoutError::Disconnected) => {
                            let _ = decode_events.send(InputEvent::Closed);
                            break;
                        }
                    }
                }
            })?;

        let signals = if watch_resize {
            Some(spawn_winch(events_tx)?)
        } else {
            None
        };

        Ok(InputHandle {
            events: events_rx,
            replies: replies_rx,
            signals,
        })
    }
}

/// Start the `SIGWINCH` thread.
fn spawn_winch(events: Sender<InputEvent>) -> io::Result<signal_hook::iterator::Handle> {
    let mut signals =
        signal_hook::iterator::Signals::new([signal_hook::consts::signal::SIGWINCH])?;
    let handle = signals.handle();
    std::thread::Builder::new()
        .name("lyra-tui-winch".to_owned())
        .spawn(move || {
            for _ in &mut signals {
                let (width, height) = terminal_size();
                if events.send(InputEvent::Resize { width, height }).is_err() {
                    break;
                }
            }
        })?;
    Ok(handle)
}

/// Terminal size, with the conventional fallback.
///
/// `crossterm`'s implementation opens `/dev/tty` before falling back to stdout,
/// which is what makes it correct in ACP mode where stdout is a pipe.
#[must_use]
pub fn terminal_size() -> (u16, u16) {
    let (width, height) = crossterm::terminal::size().unwrap_or((0, 0));
    (
        if width == 0 { 80 } else { width },
        if height == 0 { 24 } else { height },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::key::{KeyCode, KeyMods};

    fn route(bytes: &[u8]) -> (Vec<InputEvent>, Vec<Vec<u8>>) {
        let mut router = Router::new();
        let mut events = Vec::new();
        let mut replies = Vec::new();
        router.feed(bytes, |event| events.push(event), |reply| replies.push(reply));
        (events, replies)
    }

    #[test]
    fn keys_and_replies_go_to_different_consumers() {
        let (events, replies) = route(b"\x1b[?2026;2$yhi\x1b[?62;4c");
        assert_eq!(
            events,
            [
                InputEvent::Key(KeyEvent::char('h')),
                InputEvent::Key(KeyEvent::char('i'))
            ]
        );
        assert_eq!(replies.len(), 2, "the probe still gets both of its answers");
    }

    #[test]
    fn a_paste_arrives_as_one_event_not_a_thousand_keys() {
        let (events, _) = route(b"\x1b[200~a\nb\x1b[201~");
        assert_eq!(events, [InputEvent::Paste("a\nb".to_owned())]);
    }

    #[test]
    fn the_escape_timeout_resolves_a_lone_escape() {
        let mut router = Router::new();
        let mut events = Vec::new();
        router.feed(b"\x1b", |event| events.push(event), |_| ());
        assert!(events.is_empty());
        assert!(router.pending_escape());
        router.timeout(|event| events.push(event));
        assert_eq!(events, [InputEvent::Key(KeyEvent::new(KeyCode::Esc))]);
        assert!(!router.pending_escape());
    }

    #[test]
    fn an_escape_sequence_that_completes_in_time_is_not_split() {
        let mut router = Router::new();
        let mut events = Vec::new();
        router.feed(b"\x1b", |event| events.push(event), |_| ());
        router.feed(b"[13;2u", |event| events.push(event), |_| ());
        assert_eq!(
            events,
            [InputEvent::Key(KeyEvent::with(KeyCode::Enter, KeyMods::SHIFT))]
        );
    }

    #[test]
    fn a_kitty_flags_reply_is_parsed_and_a_missing_one_degrades() {
        assert_eq!(parse_kitty_flags(b"\x1b[?1u"), Some(1));
        assert_eq!(parse_kitty_flags(b"\x1b[?0u\x1b[?62c"), Some(0));
        assert_eq!(parse_kitty_flags(b"\x1b[?62;4c"), None);
        assert_eq!(parse_kitty_flags(b""), None);
    }

    #[test]
    fn the_da1_sentinel_is_recognised_by_its_final_byte() {
        assert!(ends_csi(b"\x1b[?62;4c", b'c'));
        assert!(!ends_csi(b"\x1b[?1u", b'c'));
        assert!(!ends_csi(b"\x1b[?62;4", b'c'), "an incomplete reply is not a sentinel");
    }

    #[test]
    fn negotiation_pushes_flags_and_reports_support() {
        let (tx, rx) = unbounded();
        tx.send(b"\x1b[?1u".to_vec()).unwrap();
        tx.send(b"\x1b[?62;4c".to_vec()).unwrap();
        let mut out: Vec<u8> = Vec::new();
        let support = negotiate_kitty(&mut out, &rx, Duration::from_millis(50)).unwrap();
        assert!(support.active);
        assert_eq!(support.flags, 1);
        assert!(out.starts_with(b"\x1b[>1u\x1b[?u\x1b[c"));
        assert!(
            !out.windows(7).any(|window| window == b"\x1b[>4;1m"),
            "modifyOtherKeys must not be enabled behind kitty's back"
        );
    }

    #[test]
    fn a_terminal_that_answers_only_da1_falls_back_to_modify_other_keys() {
        let (tx, rx) = unbounded();
        tx.send(b"\x1b[?1;2c".to_vec()).unwrap();
        let mut out: Vec<u8> = Vec::new();
        let support = negotiate_kitty(&mut out, &rx, Duration::from_millis(50)).unwrap();
        assert!(!support.active);
        assert!(out.ends_with(b"\x1b[>4;1m"));
    }

    #[test]
    fn a_silent_terminal_degrades_without_hanging_forever() {
        let (_tx, rx) = unbounded::<Vec<u8>>();
        let mut out: Vec<u8> = Vec::new();
        let started = std::time::Instant::now();
        let support = negotiate_kitty(&mut out, &rx, Duration::from_millis(30)).unwrap();
        assert!(!support.active);
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn teardown_undoes_exactly_what_was_turned_on() {
        let mut out: Vec<u8> = Vec::new();
        restore_keyboard(&mut out, KittySupport { active: true, flags: 1 }).unwrap();
        assert_eq!(out, b"\x1b[<u");

        let mut out: Vec<u8> = Vec::new();
        restore_keyboard(&mut out, KittySupport::unsupported()).unwrap();
        assert_eq!(out, b"\x1b[>4;0m");
    }

    #[test]
    fn the_actor_decodes_a_real_stream_end_to_end() {
        let script: &[u8] = b"hi\x1b[13;5u\x1b[200~pasted\x1b[201~\x1b[?62;4c";
        let handle = InputActor::start_with(io::Cursor::new(script.to_vec()), false).unwrap();
        let mut events = Vec::new();
        while let Ok(event) = handle
            .events()
            .recv_timeout(Duration::from_millis(500))
        {
            let closed = event == InputEvent::Closed;
            events.push(event);
            if closed {
                break;
            }
        }
        assert_eq!(
            events,
            [
                InputEvent::Key(KeyEvent::char('h')),
                InputEvent::Key(KeyEvent::char('i')),
                InputEvent::Key(KeyEvent::with(KeyCode::Enter, KeyMods::CTRL)),
                InputEvent::Paste("pasted".to_owned()),
                InputEvent::Closed,
            ]
        );
        assert_eq!(
            handle.replies().try_iter().count(),
            1,
            "the DA1 reply reached the capability channel, not the keymap"
        );
    }

    #[test]
    fn no_mouse_sequence_ever_becomes_an_event() {
        let (events, replies) = route(b"\x1b[<35;10;5M\x1b[<35;10;5m");
        assert!(events.is_empty(), "{events:?}");
        assert!(replies.is_empty(), "{replies:?}");
    }
}
