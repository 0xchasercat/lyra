//! Key *spec* parsing: the `"ctrl+s"` strings that appear in the registry's
//! declarations and in a user's `[tui.keys]` table.
//!
//! One grammar serves both, so a default binding and an override are written
//! identically and a typo fails the same way in both places.
//!
//! ```text
//! spec       := modifier* key
//! modifier   := ("ctrl" | "control" | "alt" | "meta" | "opt" | "option"
//!               | "shift" | "super" | "cmd" | "command" | "win" | "hyper") "+"
//! key        := named | <single character>
//! named      := "enter" | "return" | "tab" | "shift+tab" | "space" | "esc" | …
//! ```
//!
//! Parsing is case-insensitive and normalises to exactly the same [`KeyEvent`]
//! the decoder produces, which is the property that makes lookup a hash probe
//! rather than a comparison ladder: `"shift+a"`, `"A"` and a kitty
//! `CSI 97:65;2u` all become `Char('A')` with no modifier bits.

use crate::input::key::{KeyCode, KeyEvent, KeyMods};

/// Why a spec could not be parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpecError {
    /// The string was empty or only modifiers.
    Empty,
    /// An unrecognised modifier name.
    UnknownModifier(String),
    /// An unrecognised key name.
    UnknownKey(String),
}

impl std::fmt::Display for SpecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => f.write_str("empty key spec"),
            Self::UnknownModifier(name) => write!(f, "unknown modifier `{name}`"),
            Self::UnknownKey(name) => write!(f, "unknown key `{name}`"),
        }
    }
}

/// Parse a key spec.
///
/// # Errors
///
/// Returns [`SpecError`] for an empty, modifier-only or unrecognised spec. A bad
/// spec in a user config is reported and skipped, never fatal — a typo in
/// `[tui.keys]` must not stop the TUI from starting.
pub fn parse_key(spec: &str) -> Result<KeyEvent, SpecError> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err(SpecError::Empty);
    }
    // Split on `+`, with the escape hatch that a trailing `+` *is* the key:
    // `"ctrl++"` splits to `["ctrl", "", ""]` and the last empty field means the
    // plus character.
    let mut parts: Vec<String> = spec.split('+').map(str::to_owned).collect();
    if parts.len() >= 2 && parts.last().is_some_and(String::is_empty) {
        parts.pop();
        if let Some(last) = parts.last_mut() {
            if last.is_empty() {
                *last = "+".to_owned();
            } else {
                parts.push("+".to_owned());
            }
        }
    }

    let key = parts.pop().ok_or(SpecError::Empty)?;
    if key.is_empty() {
        return Err(SpecError::Empty);
    }
    let mut mods = KeyMods::NONE;
    for part in parts {
        mods |= modifier(&part.to_ascii_lowercase())
            .ok_or(SpecError::UnknownModifier(part.clone()))?;
    }
    let code = key_code(&key)?;
    Ok(normalise(code, mods))
}

/// Normalise `(code, mods)` the same way the decoder normalises the wire.
///
/// Two rules, both of them lifted from [`crate::input::key`]:
/// `Shift+Tab` is the `BackTab` key rather than a modified Tab, and a shifted
/// letter carries its case instead of a modifier bit.
fn normalise(code: KeyCode, mods: KeyMods) -> KeyEvent {
    match code {
        KeyCode::Tab if mods.contains(KeyMods::SHIFT) => {
            KeyEvent::with(KeyCode::BackTab, mods.without(KeyMods::SHIFT))
        }
        KeyCode::Char(c) if mods.contains(KeyMods::SHIFT) && !mods.contains(KeyMods::CTRL) => {
            let upper = c.to_uppercase().next().unwrap_or(c);
            if upper == c {
                KeyEvent::with(code, mods)
            } else {
                KeyEvent::with(KeyCode::Char(upper), mods.without(KeyMods::SHIFT))
            }
        }
        KeyCode::Char(c) if mods.contains(KeyMods::CTRL) => {
            let lower = c.to_lowercase().next().unwrap_or(c);
            KeyEvent::with(KeyCode::Char(lower), mods)
        }
        _ => KeyEvent::with(code, mods),
    }
}

fn modifier(name: &str) -> Option<KeyMods> {
    Some(match name {
        "ctrl" | "control" | "c" => KeyMods::CTRL,
        "alt" | "meta" | "opt" | "option" | "m" | "a" => KeyMods::ALT,
        "shift" | "s" => KeyMods::SHIFT,
        "super" | "cmd" | "command" | "win" => KeyMods::SUPER,
        "hyper" => KeyMods::HYPER,
        _ => return None,
    })
}

fn key_code(name: &str) -> Result<KeyCode, SpecError> {
    let lower = name.to_ascii_lowercase();
    if let Some(Ok(number @ 1..=24)) = lower
        .strip_prefix('f')
        .filter(|digits| !digits.is_empty())
        .map(str::parse::<u8>)
    {
        return Ok(KeyCode::F(number));
    }
    Ok(match lower.as_str() {
        "enter" | "return" | "cr" => KeyCode::Enter,
        "tab" => KeyCode::Tab,
        "backtab" => KeyCode::BackTab,
        "space" => KeyCode::Char(' '),
        "esc" | "escape" => KeyCode::Esc,
        "backspace" | "bs" => KeyCode::Backspace,
        "delete" | "del" => KeyCode::Delete,
        "insert" | "ins" => KeyCode::Insert,
        "left" => KeyCode::Left,
        "right" => KeyCode::Right,
        "up" => KeyCode::Up,
        "down" => KeyCode::Down,
        "home" => KeyCode::Home,
        "end" => KeyCode::End,
        "pageup" | "pgup" => KeyCode::PageUp,
        "pagedown" | "pgdn" => KeyCode::PageDown,
        _ => {
            // A single character is itself. Use the *original* spelling, not the
            // lowercased one, so `"A"` means the shifted letter.
            let mut chars = name.chars();
            let first = chars.next().ok_or(SpecError::Empty)?;
            if chars.next().is_some() {
                return Err(SpecError::UnknownKey(name.to_owned()));
            }
            KeyCode::Char(first)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modifiers_parse_in_any_order_and_any_case() {
        let expected = KeyEvent::with(KeyCode::Enter, KeyMods::CTRL | KeyMods::ALT);
        assert_eq!(parse_key("ctrl+alt+enter"), Ok(expected));
        assert_eq!(parse_key("Alt+Ctrl+Enter"), Ok(expected));
        assert_eq!(parse_key("  ctrl+alt+enter  "), Ok(expected));
    }

    #[test]
    fn a_spec_normalises_to_what_the_decoder_produces() {
        assert_eq!(parse_key("shift+tab"), Ok(KeyEvent::new(KeyCode::BackTab)));
        assert_eq!(parse_key("shift+a"), Ok(KeyEvent::char('A')));
        assert_eq!(parse_key("A"), Ok(KeyEvent::char('A')));
        assert_eq!(parse_key("ctrl+S"), Ok(KeyEvent::ctrl('s')));
    }

    #[test]
    fn the_plus_key_is_reachable() {
        assert_eq!(parse_key("+"), Ok(KeyEvent::char('+')));
        assert_eq!(parse_key("ctrl++"), Ok(KeyEvent::ctrl('+')));
    }

    #[test]
    fn named_keys_and_function_keys_parse() {
        assert_eq!(parse_key("f12"), Ok(KeyEvent::new(KeyCode::F(12))));
        assert_eq!(parse_key("pgup"), Ok(KeyEvent::new(KeyCode::PageUp)));
        assert_eq!(parse_key("space"), Ok(KeyEvent::char(' ')));
    }

    #[test]
    fn a_single_letter_key_named_f_is_not_a_function_key() {
        assert_eq!(parse_key("f"), Ok(KeyEvent::char('f')));
        assert_eq!(parse_key("alt+f"), Ok(KeyEvent::alt('f')));
    }

    #[test]
    fn bad_specs_are_reported_rather_than_guessed() {
        assert_eq!(parse_key(""), Err(SpecError::Empty));
        assert!(matches!(
            parse_key("hyper2+x"),
            Err(SpecError::UnknownModifier(_))
        ));
        assert!(matches!(
            parse_key("ctrl+wat"),
            Err(SpecError::UnknownKey(_))
        ));
    }

    #[test]
    fn display_round_trips_through_the_parser() {
        for spec in [
            "ctrl+s",
            "alt+b",
            "shift+enter",
            "shift+tab",
            "f5",
            "space",
            "esc",
            "up",
        ] {
            let parsed = parse_key(spec).unwrap();
            let printed = parsed.to_string();
            assert_eq!(
                parse_key(&printed),
                Ok(parsed),
                "{spec} printed as {printed}"
            );
        }
    }
}
