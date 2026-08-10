//! The `system` theme: colours taken from the terminal, not from us.
//!
//! DESIGN.md §3 asks for "terminal-adaptive `system` theme from the 16-color
//! palette with background alpha 0; live re-theme on DEC 2031; OSC 11 luminance
//! for auto light/dark".
//!
//! # Probing
//!
//! Same shape as [`crate::engine::caps`]: a **batched** query terminated by the
//! DA1 sentinel (`CSI c`), which every terminal answers. OSC replies that never
//! come are therefore free rather than one timeout each — the difference
//! between an instant start and a visibly stalled one over SSH.
//!
//! Queried: `OSC 4 ; n ; ?` for the eight colours the token set actually maps
//! onto, `OSC 10 ; ?` (default foreground) and `OSC 11 ; ?` (default
//! background). The background is used *only* to decide light vs dark and to
//! synthesize the neutral ramp — it is never painted, so the terminal's own
//! background (and its transparency) survives.
//!
//! # The ramp
//!
//! A 16-colour palette has no greys between "black" and "white" worth using —
//! ANSI 8 is a wildcard and many themes make it unreadable. So `muted` and
//! `faint` are *synthesized* by mixing the terminal's foreground towards its
//! background. That produces a ramp that is legible on any background by
//! construction, including light ones, which is exactly what ANSI 8 fails at.
//!
//! # Live re-theme
//!
//! `CSI ? 2031 h` asks the terminal to report colour-scheme changes; it then
//! sends `CSI ? 997 ; 1 n` (switched to dark) or `CSI ? 997 ; 2 n` (light).
//! [`parse_color_scheme_report`] turns that byte string into an
//! [`Appearance`]; the input actor owns the file descriptor and calls it.

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

use crate::vendor::flywheel::Rgb;

use super::{Appearance, Color, Theme, Tokens};

/// Ask the terminal to report colour-scheme changes (DEC private mode 2031).
pub const ENABLE_COLOR_SCHEME_REPORTS: &[u8] = b"\x1b[?2031h";
/// Stop colour-scheme reports. Emitted on shutdown so the terminal is left as
/// it was found.
pub const DISABLE_COLOR_SCHEME_REPORTS: &[u8] = b"\x1b[?2031l";

/// ANSI palette indices the token set maps onto. Probing eight instead of
/// sixteen halves the reply volume for no loss: 8–15 are the bright variants
/// and are derived by mixing when they are wanted.
pub const PROBED_INDICES: [u8; 8] = [0, 1, 2, 3, 4, 5, 6, 7];

/// What the terminal told us about itself.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TerminalPalette {
    /// ANSI 0–15. `None` for an index the terminal did not report.
    pub ansi: [Option<Rgb>; 16],
    /// Default foreground (OSC 10).
    pub foreground: Option<Rgb>,
    /// Default background (OSC 11).
    pub background: Option<Rgb>,
}

impl TerminalPalette {
    /// The palette entry, or the first available fallback.
    #[must_use]
    pub fn color(&self, index: usize, fallbacks: &[usize]) -> Option<Rgb> {
        self.ansi
            .get(index)
            .copied()
            .flatten()
            .or_else(|| fallbacks.iter().find_map(|slot| self.ansi.get(*slot).copied().flatten()))
    }

    /// Light or dark, from the probed background. Defaults to dark, which is
    /// the safer guess: a dark-tuned ramp on a light terminal is merely low
    /// contrast, while the reverse is invisible.
    #[must_use]
    pub fn appearance(&self) -> Appearance {
        self.background.map_or(Appearance::Dark, Appearance::of)
    }

    /// Whether the terminal answered anything at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.foreground.is_none()
            && self.background.is_none()
            && self.ansi.iter().all(Option::is_none)
    }
}

/// The bytes of the batched probe: the palette entries, foreground,
/// background, then the DA1 sentinel.
#[must_use]
pub fn probe_sequence() -> Vec<u8> {
    let mut out = Vec::with_capacity(160);
    for index in PROBED_INDICES {
        out.extend_from_slice(format!("\x1b]4;{index};?\x1b\\").as_bytes());
    }
    out.extend_from_slice(b"\x1b]10;?\x1b\\");
    out.extend_from_slice(b"\x1b]11;?\x1b\\");
    out.extend_from_slice(b"\x1b[c");
    out
}

/// Probe the terminal palette.
///
/// The terminal must already be in raw mode. A silent terminal is not an error:
/// it yields an empty [`TerminalPalette`], and [`system_theme`] falls back to a
/// palette-free ramp built entirely from the terminal's own defaults.
///
/// # Errors
///
/// Propagates write failures only.
pub fn probe<W: Write, R: Read + Send + 'static>(
    writer: &mut W,
    reader: Option<R>,
    deadline: Duration,
) -> std::io::Result<TerminalPalette> {
    let Some(mut reader) = reader else {
        return Ok(TerminalPalette::default());
    };
    writer.write_all(&probe_sequence())?;
    writer.flush()?;

    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("lyra-tui-palette".to_owned())
        .spawn(move || {
            let mut chunk = [0u8; 512];
            while let Ok(read) = reader.read(&mut chunk) {
                if read == 0 || tx.send(chunk[..read].to_vec()).is_err() {
                    break;
                }
            }
        })?;

    let started = std::time::Instant::now();
    let mut buffer = Vec::new();
    loop {
        let remaining = deadline.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        match rx.recv_timeout(remaining) {
            Ok(chunk) => {
                buffer.extend_from_slice(&chunk);
                if crate::engine::caps::has_da1_sentinel(&buffer) {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    Ok(parse_palette(&buffer))
}

/// Probe the palette through an already-running input actor.
///
/// The counterpart of [`crate::engine::caps::probe_replies`], and for the same
/// reason: [`crate::input::actor::InputActor`] is the sole reader of the
/// terminal, so a probe that opened its own reader would race it for the bytes.
/// [`probe`] remains for callers that own the descriptor themselves.
///
/// # Errors
///
/// Propagates write failures. A silent terminal is not an error: it yields an
/// empty [`TerminalPalette`], which [`system_theme`] degrades from cleanly.
pub fn probe_replies<W: Write>(
    writer: &mut W,
    replies: &crossbeam_channel::Receiver<Vec<u8>>,
    deadline: Duration,
) -> std::io::Result<TerminalPalette> {
    writer.write_all(&probe_sequence())?;
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
                // The DA1 sentinel bounds the wait: a terminal that answers no
                // OSC query still answers this one, so silence costs nothing.
                if crate::engine::caps::has_da1_sentinel(&buffer) {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    Ok(parse_palette(&buffer))
}

/// Parse OSC 4/10/11 replies out of a probe buffer.
///
/// Tolerates interleaved keystrokes, both string terminators (`ESC \` and
/// `BEL`), and any `rgb:` component width — terminals answer in 4-digit
/// components, but 1, 2 and 3 are all legal and some do.
#[must_use]
pub fn parse_palette(buffer: &[u8]) -> TerminalPalette {
    let mut palette = TerminalPalette::default();
    for body in osc_bodies(buffer) {
        let mut fields = body.splitn(3, ';');
        let Some(kind) = fields.next() else { continue };
        match kind {
            "4" => {
                let Some(index) = fields.next().and_then(|field| field.parse::<usize>().ok())
                else {
                    continue;
                };
                let Some(rgb) = fields.next().and_then(parse_rgb_spec) else {
                    continue;
                };
                if let Some(slot) = palette.ansi.get_mut(index) {
                    *slot = Some(rgb);
                }
            }
            "10" => palette.foreground = fields.next().and_then(parse_rgb_spec),
            "11" => palette.background = fields.next().and_then(parse_rgb_spec),
            _ => {}
        }
    }
    palette
}

/// Parse an `rgb:RRRR/GGGG/BBBB` (or `#rrggbb`) colour specification.
#[must_use]
pub fn parse_rgb_spec(spec: &str) -> Option<Rgb> {
    let spec = spec.trim();
    if let Some(hex) = spec.strip_prefix('#') {
        if hex.len() == 6 {
            let value = u32::from_str_radix(hex, 16).ok()?;
            return Some(Rgb::from_u32(value));
        }
        return None;
    }
    let body = spec.strip_prefix("rgb:").or_else(|| spec.strip_prefix("rgba:"))?;
    let mut components = body.split('/');
    let r = scale_component(components.next()?)?;
    let g = scale_component(components.next()?)?;
    let b = scale_component(components.next()?)?;
    Some(Rgb::new(r, g, b))
}

/// `ffff` → 255, `ff` → 255, `f` → 255. X11 scales by digit count.
fn scale_component(field: &str) -> Option<u8> {
    let digits = field.trim_end_matches(|c: char| !c.is_ascii_hexdigit());
    if digits.is_empty() || digits.len() > 4 {
        return None;
    }
    let value = u32::from_str_radix(digits, 16).ok()?;
    let max = (1u32 << (4 * digits.len() as u32)) - 1;
    Some(((value * 255 + max / 2) / max) as u8)
}

/// Iterate OSC payloads (`ESC ] … ST`) in a byte buffer.
fn osc_bodies(buffer: &[u8]) -> Vec<&str> {
    let mut out = Vec::new();
    let mut index = 0usize;
    while index + 1 < buffer.len() {
        if buffer[index] != 0x1b || buffer[index + 1] != b']' {
            index += 1;
            continue;
        }
        let start = index + 2;
        let mut end = start;
        let mut terminator = 0usize;
        while end < buffer.len() {
            if buffer[end] == 0x07 {
                terminator = 1;
                break;
            }
            if buffer[end] == 0x1b && buffer.get(end + 1) == Some(&b'\\') {
                terminator = 2;
                break;
            }
            end += 1;
        }
        if terminator == 0 {
            break;
        }
        if let Ok(body) = std::str::from_utf8(&buffer[start..end]) {
            out.push(body);
        }
        index = end + terminator;
    }
    out
}

/// Parse a DEC 2031 colour-scheme report (`CSI ? 997 ; Ps n`).
///
/// Returns `None` for anything else, so the input actor can hand it every
/// escape sequence it does not otherwise recognise.
#[must_use]
pub fn parse_color_scheme_report(buffer: &[u8]) -> Option<Appearance> {
    let needle = b"\x1b[?997;";
    let at = buffer
        .windows(needle.len())
        .position(|window| window == needle)?;
    let rest = &buffer[at + needle.len()..];
    let end = rest.iter().position(|byte| *byte == b'n')?;
    match std::str::from_utf8(&rest[..end]).ok()?.trim() {
        "1" => Some(Appearance::Dark),
        "2" => Some(Appearance::Light),
        _ => None,
    }
}

/// Build the `system` theme from a probed palette.
///
/// Every colour is either something the terminal reported or a mix of two such
/// colours. The background is left at [`Color::TERMINAL`] unconditionally.
#[must_use]
pub fn system_theme(palette: &TerminalPalette) -> Theme {
    let appearance = palette.appearance();
    let ink = palette.foreground.map_or(Color::TERMINAL, Color::from_rgb);
    // Something to mix *towards* for the ramp. A terminal that reported no
    // background gets the appearance's canonical extreme, which keeps the ramp
    // monotone rather than collapsing it onto the foreground.
    let ground = palette.background.map_or_else(
        || match appearance {
            Appearance::Dark => Color::rgb(0, 0, 0),
            Appearance::Light => Color::rgb(255, 255, 255),
        },
        Color::from_rgb,
    );
    // Mixing the foreground towards the background is legible on *both*
    // polarities by construction — unlike ANSI 8, which many palettes render
    // unreadable on one of them.
    let ink_or_extreme = if ink.is_terminal() {
        match appearance {
            Appearance::Dark => Color::rgb(255, 255, 255),
            Appearance::Light => Color::rgb(0, 0, 0),
        }
    } else {
        ink
    };
    let muted = ink_or_extreme.mix(ground, 0.42);
    let faint = ink_or_extreme.mix(ground, 0.66);

    let pick = |index: usize, fallbacks: &[usize]| {
        palette
            .color(index, fallbacks)
            .map_or(Color::TERMINAL, Color::from_rgb)
    };
    let red = pick(1, &[9]);
    let green = pick(2, &[10]);
    let yellow = pick(3, &[11]);
    let blue = pick(4, &[12]);
    let magenta = pick(5, &[13]);
    let cyan = pick(6, &[14]);

    // Two accents, exactly as DESIGN.md §3 requires: blue leads, magenta is the
    // agent-identity tint. Neither doubles as a semantic colour.
    let accent = if blue.is_terminal() { magenta } else { blue };
    let agent = if magenta.is_terminal() { cyan } else { magenta };

    Theme {
        name: "system".to_owned(),
        appearance,
        hyperlinks: true,
        tokens: Tokens {
            accent,
            agent,
            error: red,
            warning: yellow,
            success: green,
            text: Color::TERMINAL,
            muted,
            faint,
            heading: accent.mix(ink_or_extreme, 0.35),
            subheading: accent,
            quote: muted,
            diff_add: green,
            diff_del: red,
            diff_add_emph: green.mix(ink_or_extreme, 0.35),
            diff_del_emph: red.mix(ink_or_extreme, 0.35),
            syn_keyword: magenta,
            syn_string: green,
            syn_number: yellow,
            syn_comment: faint,
            syn_type: cyan,
            syn_function: blue,
        },
    }
}

/// Re-derive a theme after a DEC 2031 notification.
///
/// The palette is re-probed by the caller when it can be; when it cannot, the
/// ramp is rebuilt for the new polarity from the appearance alone, which is the
/// part that actually goes unreadable when the user flips their terminal.
#[must_use]
pub fn retheme(theme: &Theme, palette: &TerminalPalette, appearance: Appearance) -> Theme {
    if theme.name == "system" {
        let mut palette = *palette;
        if palette.background.is_none() {
            palette.background = Some(match appearance {
                Appearance::Dark => Rgb::new(0, 0, 0),
                Appearance::Light => Rgb::new(255, 255, 255),
            });
        }
        let mut rebuilt = system_theme(&palette);
        rebuilt.appearance = appearance;
        rebuilt.hyperlinks = theme.hyperlinks;
        return rebuilt;
    }
    // A bundled theme is a deliberate choice; a background flip does not
    // override it. Only the recorded appearance moves, so surfaces that ask
    // (the composer border) can adapt.
    let mut updated = theme.clone();
    updated.appearance = appearance;
    updated
}

#[cfg(test)]
mod tests {
    use super::*;

    fn palette() -> TerminalPalette {
        let mut palette = TerminalPalette {
            background: Some(Rgb::new(24, 24, 28)),
            foreground: Some(Rgb::new(220, 220, 224)),
            ..TerminalPalette::default()
        };
        palette.ansi[1] = Some(Rgb::new(204, 68, 68));
        palette.ansi[2] = Some(Rgb::new(120, 176, 96));
        palette.ansi[3] = Some(Rgb::new(200, 160, 60));
        palette.ansi[4] = Some(Rgb::new(96, 130, 220));
        palette.ansi[5] = Some(Rgb::new(170, 110, 200));
        palette.ansi[6] = Some(Rgb::new(90, 176, 190));
        palette
    }

    #[test]
    fn the_probe_is_one_batch_ended_by_the_da1_sentinel() {
        let sequence = probe_sequence();
        assert!(sequence.ends_with(b"\x1b[c"), "DA1 must be last");
        assert_eq!(
            sequence.windows(6).filter(|w| *w == b"\x1b]4;0;").count(),
            1
        );
        assert!(sequence.windows(8).any(|w| w == b"\x1b]11;?\x1b\\"));
    }

    #[test]
    fn parses_an_xterm_style_palette_reply() {
        let buffer = b"\x1b]4;1;rgb:cccc/4444/4444\x1b\\\
                       \x1b]10;rgb:dcdc/dcdc/e0e0\x1b\\\
                       \x1b]11;rgb:1818/1818/1c1c\x1b\\\
                       \x1b[?62;c";
        let parsed = parse_palette(buffer);
        assert_eq!(parsed.ansi[1], Some(Rgb::new(204, 68, 68)));
        assert_eq!(parsed.foreground, Some(Rgb::new(220, 220, 224)));
        assert_eq!(parsed.background, Some(Rgb::new(24, 24, 28)));
    }

    #[test]
    fn bel_terminated_replies_and_stray_keystrokes_both_parse() {
        let parsed = parse_palette(b"q\x1b]4;2;rgb:78/b0/60\x07z\x1b]11;#181820\x07");
        assert_eq!(parsed.ansi[2], Some(Rgb::new(120, 176, 96)));
        assert_eq!(parsed.background, Some(Rgb::new(24, 24, 32)));
    }

    #[test]
    fn component_widths_scale_the_way_x11_specifies() {
        assert_eq!(parse_rgb_spec("rgb:ffff/0000/8080"), Some(Rgb::new(255, 0, 128)));
        assert_eq!(parse_rgb_spec("rgb:f/0/8"), Some(Rgb::new(255, 0, 136)));
        assert_eq!(parse_rgb_spec("rgb:fff/000/888"), Some(Rgb::new(255, 0, 136)));
        assert_eq!(parse_rgb_spec("nonsense"), None);
    }

    #[test]
    fn a_truncated_reply_is_ignored_rather_than_half_parsed() {
        let parsed = parse_palette(b"\x1b]4;1;rgb:cccc/4444");
        assert!(parsed.is_empty());
    }

    #[test]
    fn the_system_theme_never_paints_a_background() {
        let theme = system_theme(&palette());
        assert!(theme.tokens.text.is_terminal());
        assert_eq!(theme.appearance, Appearance::Dark);
        assert_eq!(theme.tokens.accent.value(), Some(Rgb::new(96, 130, 220)));
        assert_eq!(theme.tokens.error.value(), Some(Rgb::new(204, 68, 68)));
    }

    #[test]
    fn the_synthesized_ramp_is_monotone_towards_the_background() {
        let theme = system_theme(&palette());
        let ink = super::super::luminance(Rgb::new(220, 220, 224));
        let muted = theme.tokens.muted.luminance().unwrap();
        let faint = theme.tokens.faint.luminance().unwrap();
        let ground = super::super::luminance(Rgb::new(24, 24, 28));
        assert!(ink > muted && muted > faint && faint > ground, "{ink} {muted} {faint} {ground}");
    }

    #[test]
    fn the_ramp_inverts_for_a_light_terminal() {
        let mut light = palette();
        light.background = Some(Rgb::new(250, 250, 246));
        light.foreground = Some(Rgb::new(40, 40, 44));
        let theme = system_theme(&light);
        assert_eq!(theme.appearance, Appearance::Light);
        let muted = theme.tokens.muted.luminance().unwrap();
        let faint = theme.tokens.faint.luminance().unwrap();
        assert!(muted < faint, "on a light background the ramp fades upwards");
        assert!(faint < super::super::luminance(Rgb::new(250, 250, 246)));
    }

    #[test]
    fn a_silent_terminal_still_yields_a_usable_theme() {
        let theme = system_theme(&TerminalPalette::default());
        assert_eq!(theme.appearance, Appearance::Dark);
        assert!(theme.tokens.text.is_terminal());
        // The ramp is synthesized from the appearance's extreme, so it is still
        // a ramp rather than three copies of the same colour.
        assert_ne!(theme.tokens.muted, theme.tokens.faint);
    }

    #[test]
    fn dec_2031_reports_are_recognised_and_everything_else_is_not() {
        assert_eq!(parse_color_scheme_report(b"\x1b[?997;1n"), Some(Appearance::Dark));
        assert_eq!(parse_color_scheme_report(b"\x1b[?997;2n"), Some(Appearance::Light));
        assert_eq!(parse_color_scheme_report(b"\x1b[?997;9n"), None);
        assert_eq!(parse_color_scheme_report(b"\x1b[A"), None);
        assert_eq!(parse_color_scheme_report(b""), None);
    }

    #[test]
    fn retheming_system_follows_the_terminal_and_retheming_a_choice_does_not() {
        let system = system_theme(&palette());
        let flipped = retheme(&system, &TerminalPalette::default(), Appearance::Light);
        assert_eq!(flipped.appearance, Appearance::Light);
        assert_ne!(flipped.tokens.muted, system.tokens.muted, "the ramp rebuilt");

        let chosen = Theme::ember();
        let after = retheme(&chosen, &palette(), Appearance::Light);
        assert_eq!(after.tokens, chosen.tokens, "an explicit theme is not overridden");
        assert_eq!(after.appearance, Appearance::Light);
    }
}
