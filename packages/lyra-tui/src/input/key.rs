//! The key model: what a decoded keystroke *is*, independent of how the
//! terminal spelled it.
//!
//! Every terminal encoding this crate understands — kitty CSI-u, xterm
//! `modifyOtherKeys`, the SS3/CSI legacy zoo, raw control bytes — is normalised
//! into a [`KeyEvent`] before it reaches the keybinding registry. That
//! normalisation is the whole point: [`crate::keybind`] is written once against
//! `KeyEvent`, and a terminal that spells `Shift+Enter` three different ways
//! costs nothing above [`crate::input::decode`].
//!
//! # Normalisation rules
//!
//! - **Case lives in the character, not the modifier.** `Shift+a` is
//!   `Char('A')` with no `SHIFT` bit, because that is what the terminal reports
//!   and what a keymap author means. `SHIFT` is only ever set on keys that have
//!   no shifted character form (`Enter`, `Tab`, arrows, function keys).
//! - **Control characters are decoded to their letter.** Byte `0x03` becomes
//!   `Char('c')` + `CTRL`, never `Char('\u{3}')`.
//! - **`Ctrl` letters are lowercase.** `Ctrl+Shift+S` (kitty only) is
//!   `Char('s')` + `CTRL | SHIFT`, so a binding written `ctrl+s` cannot
//!   accidentally miss because the terminal reported an uppercase codepoint.

use std::fmt;

/// Modifier bits.
///
/// `SUPER`/`HYPER`/`META` only ever arrive from the kitty keyboard protocol;
/// legacy encodings cannot express them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, PartialOrd, Ord)]
pub struct KeyMods(u8);

impl KeyMods {
    /// No modifiers.
    pub const NONE: Self = Self(0);
    /// Shift.
    pub const SHIFT: Self = Self(1 << 0);
    /// Alt / Meta / Option.
    pub const ALT: Self = Self(1 << 1);
    /// Control.
    pub const CTRL: Self = Self(1 << 2);
    /// Super / Command / Windows.
    pub const SUPER: Self = Self(1 << 3);
    /// Hyper.
    pub const HYPER: Self = Self(1 << 4);
    /// Meta, as distinct from Alt. Kitty reports these separately.
    pub const META: Self = Self(1 << 5);

    /// Union.
    #[must_use]
    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    /// Whether every bit in `other` is set.
    #[must_use]
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    /// Whether no bits are set.
    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// Remove the bits in `other`.
    #[must_use]
    pub const fn without(self, other: Self) -> Self {
        Self(self.0 & !other.0)
    }

    /// Decode the CSI parameter used by both kitty and xterm, where the wire
    /// value is a 1-based bitfield (`1` = no modifiers).
    #[must_use]
    pub const fn from_csi_param(param: u32) -> Self {
        if param == 0 {
            return Self::NONE;
        }
        let bits = param - 1;
        let mut mods = 0u8;
        if bits & 0b1 != 0 {
            mods |= Self::SHIFT.0;
        }
        if bits & 0b10 != 0 {
            mods |= Self::ALT.0;
        }
        if bits & 0b100 != 0 {
            mods |= Self::CTRL.0;
        }
        if bits & 0b1000 != 0 {
            mods |= Self::SUPER.0;
        }
        if bits & 0b1_0000 != 0 {
            mods |= Self::HYPER.0;
        }
        if bits & 0b10_0000 != 0 {
            mods |= Self::META.0;
        }
        Self(mods)
    }
}

impl std::ops::BitOr for KeyMods {
    type Output = Self;

    fn bitor(self, other: Self) -> Self {
        self.union(other)
    }
}

impl std::ops::BitOrAssign for KeyMods {
    fn bitor_assign(&mut self, other: Self) {
        self.0 |= other.0;
    }
}

impl fmt::Display for KeyMods {
    /// The canonical spelling used by `[tui.keys]` and by every help surface:
    /// `ctrl+alt+shift+`, always in that order, always lowercase.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (bit, name) in [
            (Self::CTRL, "ctrl"),
            (Self::ALT, "alt"),
            (Self::SHIFT, "shift"),
            (Self::SUPER, "super"),
            (Self::HYPER, "hyper"),
            (Self::META, "meta"),
        ] {
            if self.contains(bit) {
                write!(f, "{name}+")?;
            }
        }
        Ok(())
    }
}

/// Which physical key produced the event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum KeyCode {
    /// A character key. Already case-folded per the module rules.
    Char(char),
    /// Return / Enter.
    Enter,
    /// Tab.
    Tab,
    /// Shift+Tab, which every terminal spells `CSI Z` rather than `Tab+SHIFT`.
    BackTab,
    /// Backspace (`0x7f`, or `0x08` where the terminal is configured that way).
    Backspace,
    /// Delete-forward.
    Delete,
    /// Insert.
    Insert,
    /// Escape.
    Esc,
    /// Cursor left.
    Left,
    /// Cursor right.
    Right,
    /// Cursor up.
    Up,
    /// Cursor down.
    Down,
    /// Home.
    Home,
    /// End.
    End,
    /// Page up.
    PageUp,
    /// Page down.
    PageDown,
    /// Function key `n`.
    F(u8),
}

impl fmt::Display for KeyCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Char(' ') => f.write_str("space"),
            Self::Char(c) => write!(f, "{c}"),
            Self::Enter => f.write_str("enter"),
            Self::Tab => f.write_str("tab"),
            Self::BackTab => f.write_str("shift+tab"),
            Self::Backspace => f.write_str("backspace"),
            Self::Delete => f.write_str("delete"),
            Self::Insert => f.write_str("insert"),
            Self::Esc => f.write_str("esc"),
            Self::Left => f.write_str("left"),
            Self::Right => f.write_str("right"),
            Self::Up => f.write_str("up"),
            Self::Down => f.write_str("down"),
            Self::Home => f.write_str("home"),
            Self::End => f.write_str("end"),
            Self::PageUp => f.write_str("pageup"),
            Self::PageDown => f.write_str("pagedown"),
            Self::F(n) => write!(f, "f{n}"),
        }
    }
}

/// A decoded keystroke.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct KeyEvent {
    /// The key.
    pub code: KeyCode,
    /// Its modifiers.
    pub mods: KeyMods,
}

impl KeyEvent {
    /// An unmodified key.
    #[must_use]
    pub const fn new(code: KeyCode) -> Self {
        Self {
            code,
            mods: KeyMods::NONE,
        }
    }

    /// A modified key.
    #[must_use]
    pub const fn with(code: KeyCode, mods: KeyMods) -> Self {
        Self { code, mods }
    }

    /// A plain character.
    #[must_use]
    pub const fn char(c: char) -> Self {
        Self::new(KeyCode::Char(c))
    }

    /// `Ctrl` + a letter.
    #[must_use]
    pub const fn ctrl(c: char) -> Self {
        Self::with(KeyCode::Char(c), KeyMods::CTRL)
    }

    /// `Alt` + a character.
    #[must_use]
    pub const fn alt(c: char) -> Self {
        Self::with(KeyCode::Char(c), KeyMods::ALT)
    }

    /// Whether this event is a plain, unmodified printable character — the only
    /// class of event the composer inserts verbatim.
    ///
    /// `Alt` and `Ctrl` disqualify; a bare `SHIFT` bit does not, because a
    /// shifted letter arrives as its uppercase form with no modifier at all and
    /// the only way `SHIFT` survives here is a kitty report for a key whose
    /// shifted form *is* the reported character.
    #[must_use]
    pub const fn is_text(&self) -> bool {
        matches!(self.code, KeyCode::Char(_))
            && !self.mods.contains(KeyMods::CTRL)
            && !self.mods.contains(KeyMods::ALT)
            && !self.mods.contains(KeyMods::SUPER)
            && !self.mods.contains(KeyMods::META)
    }

    /// The character this event inserts, if any.
    #[must_use]
    pub const fn text_char(&self) -> Option<char> {
        match self.code {
            KeyCode::Char(c) if self.is_text() => Some(c),
            _ => None,
        }
    }
}

impl fmt::Display for KeyEvent {
    /// Round-trips through [`crate::keybind::spec::parse_key`].
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // `BackTab` already spells its own shift; emitting the bit as well would
        // produce the unparseable `shift+shift+tab`.
        let mods = if self.code == KeyCode::BackTab {
            self.mods.without(KeyMods::SHIFT)
        } else {
            self.mods
        };
        write!(f, "{mods}{}", self.code)
    }
}

/// Decode a C0 control byte into the key the user actually pressed.
///
/// `0x00..=0x1f` are the ASCII control block. Every one of them is `Ctrl` plus
/// some character, except the four that have a key of their own — and those
/// four must win, because a terminal sends `\r` for `Enter`, not for `Ctrl+M`.
#[must_use]
pub fn decode_control_byte(byte: u8) -> Option<KeyEvent> {
    Some(match byte {
        0x00 => KeyEvent::with(KeyCode::Char(' '), KeyMods::CTRL),
        0x08 => KeyEvent::new(KeyCode::Backspace),
        0x09 => KeyEvent::new(KeyCode::Tab),
        0x0a => KeyEvent::ctrl('j'),
        0x0d => KeyEvent::new(KeyCode::Enter),
        0x1b => KeyEvent::new(KeyCode::Esc),
        0x1c => KeyEvent::ctrl('\\'),
        0x1d => KeyEvent::ctrl(']'),
        0x1e => KeyEvent::ctrl('^'),
        0x1f => KeyEvent::ctrl('_'),
        0x7f => KeyEvent::new(KeyCode::Backspace),
        // The remaining C0 bytes map linearly onto `a`..`z`.
        0x01..=0x1a => KeyEvent::ctrl((b'a' + (byte - 1)) as char),
        _ => return None,
    })
}

/// Normalise a kitty/`modifyOtherKeys` `(codepoint, modifiers)` pair.
///
/// Kitty reports the *unshifted* codepoint plus a `SHIFT` bit for shifted
/// letters, so `Shift+a` arrives as `(97, shift)`. The module's rule is that
/// case lives in the character, so that becomes `Char('A')` with the bit
/// dropped. `Ctrl+S` arrives as `(115, ctrl)` and stays lowercase.
#[must_use]
pub fn normalise_codepoint(codepoint: u32, mods: KeyMods) -> Option<KeyEvent> {
    let code = match codepoint {
        13 | 57414 => KeyCode::Enter,
        9 => KeyCode::Tab,
        27 => KeyCode::Esc,
        8 | 127 => KeyCode::Backspace,
        57417 => KeyCode::Left,
        57418 => KeyCode::Right,
        57419 => KeyCode::Up,
        57420 => KeyCode::Down,
        57423 => KeyCode::Home,
        57424 => KeyCode::End,
        57421 => KeyCode::PageUp,
        57422 => KeyCode::PageDown,
        57425 => KeyCode::Insert,
        57426 => KeyCode::Delete,
        // Kitty's keypad-enter and keypad digits are reported in the private
        // range; only enter is load-bearing for us.
        _ => {
            let c = char::from_u32(codepoint)?;
            if c.is_control() {
                return None;
            }
            KeyCode::Char(c)
        }
    };
    let event = match code {
        KeyCode::Char(c) if mods.contains(KeyMods::SHIFT) && !mods.contains(KeyMods::CTRL) => {
            let upper = c.to_uppercase().next().unwrap_or(c);
            if upper == c {
                // The character has no distinct shifted form (digits, symbols on
                // some layouts). Keep the bit so a binding can still name it.
                KeyEvent::with(KeyCode::Char(c), mods)
            } else {
                KeyEvent::with(KeyCode::Char(upper), mods.without(KeyMods::SHIFT))
            }
        }
        KeyCode::Char(c) if mods.contains(KeyMods::CTRL) => {
            let lower = c.to_lowercase().next().unwrap_or(c);
            KeyEvent::with(KeyCode::Char(lower), mods)
        }
        other => KeyEvent::with(other, mods),
    };
    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_bytes_decode_to_their_letter_not_their_codepoint() {
        assert_eq!(decode_control_byte(0x03), Some(KeyEvent::ctrl('c')));
        assert_eq!(decode_control_byte(0x13), Some(KeyEvent::ctrl('s')));
        assert_eq!(decode_control_byte(0x01), Some(KeyEvent::ctrl('a')));
        assert_eq!(decode_control_byte(0x1a), Some(KeyEvent::ctrl('z')));
    }

    #[test]
    fn the_four_named_control_keys_win_over_their_ctrl_letter() {
        assert_eq!(
            decode_control_byte(0x0d),
            Some(KeyEvent::new(KeyCode::Enter)),
            "\\r is Enter, never Ctrl+M"
        );
        assert_eq!(decode_control_byte(0x09), Some(KeyEvent::new(KeyCode::Tab)));
        assert_eq!(decode_control_byte(0x1b), Some(KeyEvent::new(KeyCode::Esc)));
        assert_eq!(
            decode_control_byte(0x7f),
            Some(KeyEvent::new(KeyCode::Backspace))
        );
    }

    #[test]
    fn ctrl_j_stays_ctrl_j_so_it_can_be_the_universal_newline_fallback() {
        assert_eq!(decode_control_byte(0x0a), Some(KeyEvent::ctrl('j')));
    }

    #[test]
    fn csi_modifier_params_are_one_based() {
        assert_eq!(KeyMods::from_csi_param(1), KeyMods::NONE);
        assert_eq!(KeyMods::from_csi_param(2), KeyMods::SHIFT);
        assert_eq!(KeyMods::from_csi_param(3), KeyMods::ALT);
        assert_eq!(KeyMods::from_csi_param(5), KeyMods::CTRL);
        assert_eq!(
            KeyMods::from_csi_param(6),
            KeyMods::CTRL | KeyMods::SHIFT,
            "ctrl+shift"
        );
        assert_eq!(
            KeyMods::from_csi_param(8),
            KeyMods::CTRL | KeyMods::ALT | KeyMods::SHIFT
        );
    }

    #[test]
    fn shifted_letters_carry_their_case_not_a_modifier_bit() {
        let event = normalise_codepoint(u32::from('a'), KeyMods::SHIFT).unwrap();
        assert_eq!(event, KeyEvent::char('A'));
        assert!(event.mods.is_empty());
    }

    #[test]
    fn ctrl_letters_are_lowercased_so_bindings_cannot_miss() {
        let event = normalise_codepoint(u32::from('S'), KeyMods::CTRL).unwrap();
        assert_eq!(event, KeyEvent::ctrl('s'));
    }

    #[test]
    fn kitty_enter_variants_both_land_on_enter() {
        assert_eq!(
            normalise_codepoint(13, KeyMods::SHIFT),
            Some(KeyEvent::with(KeyCode::Enter, KeyMods::SHIFT))
        );
        assert_eq!(
            normalise_codepoint(57414, KeyMods::CTRL),
            Some(KeyEvent::with(KeyCode::Enter, KeyMods::CTRL))
        );
    }

    #[test]
    fn display_round_trips_the_canonical_spelling() {
        assert_eq!(KeyEvent::ctrl('s').to_string(), "ctrl+s");
        assert_eq!(
            KeyEvent::with(KeyCode::Enter, KeyMods::SHIFT).to_string(),
            "shift+enter"
        );
        assert_eq!(KeyEvent::new(KeyCode::BackTab).to_string(), "shift+tab");
        assert_eq!(KeyEvent::char(' ').to_string(), "space");
    }

    #[test]
    fn only_unmodified_printables_are_text() {
        assert!(KeyEvent::char('x').is_text());
        assert!(!KeyEvent::ctrl('x').is_text());
        assert!(!KeyEvent::alt('x').is_text());
        assert!(!KeyEvent::new(KeyCode::Enter).is_text());
    }
}
