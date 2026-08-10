//! TOML theme overrides — **data, never code** (DESIGN.md §4's rule for
//! keybindings, applied to colour for the same reason).
//!
//! ```toml
//! [tui.theme]
//! name = "system"          # a bundled theme, or "system"
//! hyperlinks = false       # opt out of OSC 8
//!
//! [tui.theme.colors]       # override individual semantic tokens
//! accent  = "#7aa2f7"
//! agent   = "rgb:5f5f/afaf/d7d7"
//! text    = "terminal"     # explicitly inherit
//! ```
//!
//! Two properties matter more than the syntax:
//!
//! 1. **An unknown key is an error**, not a silent no-op. A mistyped token name
//!    that is quietly ignored is indistinguishable from a theme engine that
//!    does not work.
//! 2. **Overrides compose onto a base theme.** A file that sets `accent` alone
//!    still gets a complete, coherent token set, so a partial theme cannot
//!    leave a surface unstyled.

use std::collections::BTreeMap;
use std::fmt;

use super::{adaptive, Color, Theme};

/// Why a theme file was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    /// The file is not valid TOML.
    Syntax(String),
    /// `name` did not match a bundled theme.
    UnknownTheme(String),
    /// A key under `[theme.colors]` is not a token name.
    UnknownToken(String),
    /// A value was not a colour.
    BadColor {
        /// The token whose value was rejected.
        token: String,
        /// The offending value.
        value: String,
    },
    /// A value had the wrong TOML type.
    BadType {
        /// The key.
        key: String,
        /// What was expected.
        expected: &'static str,
    },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Syntax(detail) => write!(f, "theme: invalid TOML: {detail}"),
            Self::UnknownTheme(name) => write!(
                f,
                "theme: unknown theme {name:?} (bundled: {})",
                Theme::BUNDLED.join(", ")
            ),
            Self::UnknownToken(token) => write!(f, "theme: unknown colour token {token:?}"),
            Self::BadColor { token, value } => write!(
                f,
                "theme: {token} = {value:?} is not a colour \
                 (expected \"#rrggbb\", \"rgb:r/g/b\" or \"terminal\")"
            ),
            Self::BadType { key, expected } => {
                write!(f, "theme: {key} must be {expected}")
            }
        }
    }
}

impl std::error::Error for ConfigError {}

/// Every overridable token name, in the order the docs list them.
pub const TOKEN_NAMES: [&str; 21] = [
    "accent",
    "agent",
    "error",
    "warning",
    "success",
    "text",
    "muted",
    "faint",
    "heading",
    "subheading",
    "quote",
    "diff_add",
    "diff_del",
    "diff_add_emph",
    "diff_del_emph",
    "syn_keyword",
    "syn_string",
    "syn_number",
    "syn_comment",
    "syn_type",
    "syn_function",
];

/// A parsed `[theme]` table, not yet applied.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThemeConfig {
    /// Base theme name, if the file named one.
    pub name: Option<String>,
    /// OSC 8 opt-out.
    pub hyperlinks: Option<bool>,
    /// Token overrides, by name.
    pub colors: BTreeMap<String, Color>,
}

impl ThemeConfig {
    /// Parse a config document.
    ///
    /// Looks for `[theme]` at the root and `[tui.theme]`, so the same parser
    /// serves a standalone theme file and Lyra's main config. A document with
    /// neither yields an empty config rather than an error — most config files
    /// do not theme anything.
    ///
    /// # Errors
    ///
    /// [`ConfigError`] for invalid TOML, unknown names and bad values.
    pub fn parse(source: &str) -> Result<Self, ConfigError> {
        let document: toml::Value =
            toml::from_str(source).map_err(|error| ConfigError::Syntax(error.to_string()))?;
        let table = document
            .get("tui")
            .and_then(|tui| tui.get("theme"))
            .or_else(|| document.get("theme"));
        let Some(table) = table else {
            return Ok(Self::default());
        };
        let table = table.as_table().ok_or(ConfigError::BadType {
            key: "theme".to_owned(),
            expected: "a table",
        })?;

        let mut config = Self::default();
        for (key, value) in table {
            match key.as_str() {
                "name" => {
                    config.name = Some(
                        value
                            .as_str()
                            .ok_or(ConfigError::BadType {
                                key: "theme.name".to_owned(),
                                expected: "a string",
                            })?
                            .to_owned(),
                    );
                }
                "hyperlinks" => {
                    config.hyperlinks = Some(value.as_bool().ok_or(ConfigError::BadType {
                        key: "theme.hyperlinks".to_owned(),
                        expected: "a boolean",
                    })?);
                }
                "colors" => {
                    let colors = value.as_table().ok_or(ConfigError::BadType {
                        key: "theme.colors".to_owned(),
                        expected: "a table",
                    })?;
                    for (token, raw) in colors {
                        if !TOKEN_NAMES.contains(&token.as_str()) {
                            return Err(ConfigError::UnknownToken(token.clone()));
                        }
                        let text = raw.as_str().ok_or_else(|| ConfigError::BadType {
                            key: format!("theme.colors.{token}"),
                            expected: "a string",
                        })?;
                        let color = parse_color(text).ok_or_else(|| ConfigError::BadColor {
                            token: token.clone(),
                            value: text.to_owned(),
                        })?;
                        config.colors.insert(token.clone(), color);
                    }
                }
                other => return Err(ConfigError::UnknownToken(other.to_owned())),
            }
        }
        Ok(config)
    }

    /// Resolve to a complete theme.
    ///
    /// `probed` supplies the `system` theme's colours; pass
    /// [`adaptive::TerminalPalette::default`] when nothing was probed.
    ///
    /// # Errors
    ///
    /// [`ConfigError::UnknownTheme`] when `name` matches nothing.
    pub fn resolve(&self, probed: &adaptive::TerminalPalette) -> Result<Theme, ConfigError> {
        let mut theme = match self.name.as_deref() {
            None => Theme::default(),
            Some("system") => adaptive::system_theme(probed),
            Some(name) => {
                Theme::by_name(name).ok_or_else(|| ConfigError::UnknownTheme(name.to_owned()))?
            }
        };
        if let Some(hyperlinks) = self.hyperlinks {
            theme.hyperlinks = hyperlinks;
        }
        for (token, color) in &self.colors {
            apply_token(&mut theme, token, *color);
        }
        Ok(theme)
    }
}

/// Parse one colour value.
#[must_use]
pub fn parse_color(text: &str) -> Option<Color> {
    let text = text.trim();
    if text.eq_ignore_ascii_case("terminal") || text.eq_ignore_ascii_case("default") {
        return Some(Color::TERMINAL);
    }
    adaptive::parse_rgb_spec(text).map(Color::from_rgb)
}

fn apply_token(theme: &mut Theme, token: &str, color: Color) {
    let tokens = &mut theme.tokens;
    match token {
        "accent" => tokens.accent = color,
        "agent" => tokens.agent = color,
        "error" => tokens.error = color,
        "warning" => tokens.warning = color,
        "success" => tokens.success = color,
        "text" => tokens.text = color,
        "muted" => tokens.muted = color,
        "faint" => tokens.faint = color,
        "heading" => tokens.heading = color,
        "subheading" => tokens.subheading = color,
        "quote" => tokens.quote = color,
        "diff_add" => tokens.diff_add = color,
        "diff_del" => tokens.diff_del = color,
        "diff_add_emph" => tokens.diff_add_emph = color,
        "diff_del_emph" => tokens.diff_del_emph = color,
        "syn_keyword" => tokens.syn_keyword = color,
        "syn_string" => tokens.syn_string = color,
        "syn_number" => tokens.syn_number = color,
        "syn_comment" => tokens.syn_comment = color,
        "syn_type" => tokens.syn_type = color,
        "syn_function" => tokens.syn_function = color,
        // Unreachable: `parse` rejects unknown names before this is called.
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vendor::flywheel::Rgb;

    #[test]
    fn an_empty_document_themes_nothing() {
        let config = ThemeConfig::parse("").unwrap();
        assert_eq!(config, ThemeConfig::default());
        let theme = config.resolve(&adaptive::TerminalPalette::default()).unwrap();
        assert_eq!(theme.name, "lyra");
    }

    #[test]
    fn a_config_with_other_sections_is_not_disturbed_by_them() {
        let config = ThemeConfig::parse("[tui.keys]\nsubmit = \"enter\"\n").unwrap();
        assert_eq!(config, ThemeConfig::default());
    }

    #[test]
    fn both_table_paths_are_accepted() {
        let root = ThemeConfig::parse("[theme]\nname = \"ember\"\n").unwrap();
        let nested = ThemeConfig::parse("[tui.theme]\nname = \"ember\"\n").unwrap();
        assert_eq!(root, nested);
        assert_eq!(root.name.as_deref(), Some("ember"));
    }

    #[test]
    fn overrides_compose_onto_a_complete_base_theme() {
        let config = ThemeConfig::parse(
            "[tui.theme]\nname = \"mono\"\n[tui.theme.colors]\naccent = \"#7aa2f7\"\n",
        )
        .unwrap();
        let theme = config.resolve(&adaptive::TerminalPalette::default()).unwrap();
        assert_eq!(theme.tokens.accent.value(), Some(Rgb::new(0x7a, 0xa2, 0xf7)));
        // Untouched tokens still come from mono, so nothing is left unstyled.
        let mut expected = Theme::mono().tokens;
        expected.accent = theme.tokens.accent;
        assert_eq!(theme.tokens, expected);
    }

    #[test]
    fn terminal_is_spelled_by_name_rather_than_as_a_colour() {
        let config =
            ThemeConfig::parse("[theme.colors]\nmuted = \"terminal\"\nfaint = \"DEFAULT\"\n")
                .unwrap();
        let theme = config.resolve(&adaptive::TerminalPalette::default()).unwrap();
        assert!(theme.tokens.muted.is_terminal());
        assert!(theme.tokens.faint.is_terminal());
    }

    #[test]
    fn an_override_of_pure_white_is_still_nudged() {
        let config = ThemeConfig::parse("[theme.colors]\nheading = \"#ffffff\"\n").unwrap();
        let theme = config.resolve(&adaptive::TerminalPalette::default()).unwrap();
        assert_eq!(
            theme.tokens.heading.value(),
            Some(Rgb::new(254, 254, 254)),
            "the no-pure-white constraint must survive the config path too"
        );
    }

    #[test]
    fn a_mistyped_token_is_an_error_not_a_silent_no_op() {
        let error = ThemeConfig::parse("[theme.colors]\nacent = \"#fff000\"\n").unwrap_err();
        assert_eq!(error, ConfigError::UnknownToken("acent".to_owned()));
        assert!(error.to_string().contains("acent"));
    }

    #[test]
    fn a_mistyped_key_is_an_error_too() {
        assert!(matches!(
            ThemeConfig::parse("[theme]\nhyperlink = true\n"),
            Err(ConfigError::UnknownToken(_))
        ));
    }

    #[test]
    fn a_bad_colour_names_the_token_and_the_value() {
        let error = ThemeConfig::parse("[theme.colors]\naccent = \"blurple\"\n").unwrap_err();
        assert_eq!(
            error,
            ConfigError::BadColor {
                token: "accent".to_owned(),
                value: "blurple".to_owned()
            }
        );
    }

    #[test]
    fn an_unknown_theme_name_lists_the_bundled_ones() {
        let error = ThemeConfig::parse("[theme]\nname = \"solarised\"\n")
            .unwrap()
            .resolve(&adaptive::TerminalPalette::default())
            .unwrap_err();
        let text = error.to_string();
        for name in Theme::BUNDLED {
            assert!(text.contains(name), "{text}");
        }
    }

    #[test]
    fn invalid_toml_is_reported_rather_than_panicking() {
        assert!(matches!(
            ThemeConfig::parse("[theme\nname = 1"),
            Err(ConfigError::Syntax(_))
        ));
    }

    #[test]
    fn hyperlinks_can_be_turned_off() {
        let theme = ThemeConfig::parse("[theme]\nhyperlinks = false\n")
            .unwrap()
            .resolve(&adaptive::TerminalPalette::default())
            .unwrap();
        assert!(!theme.hyperlinks);
    }

    #[test]
    fn every_token_name_is_reachable_from_the_config() {
        for token in TOKEN_NAMES {
            let source = format!("[theme.colors]\n{token} = \"#123456\"\n");
            let theme = ThemeConfig::parse(&source)
                .unwrap()
                .resolve(&adaptive::TerminalPalette::default())
                .unwrap();
            let wanted = Some(Rgb::new(0x12, 0x34, 0x56));
            let hit = [
                theme.tokens.accent,
                theme.tokens.agent,
                theme.tokens.error,
                theme.tokens.warning,
                theme.tokens.success,
                theme.tokens.text,
                theme.tokens.muted,
                theme.tokens.faint,
                theme.tokens.heading,
                theme.tokens.subheading,
                theme.tokens.quote,
                theme.tokens.diff_add,
                theme.tokens.diff_del,
                theme.tokens.diff_add_emph,
                theme.tokens.diff_del_emph,
                theme.tokens.syn_keyword,
                theme.tokens.syn_string,
                theme.tokens.syn_number,
                theme.tokens.syn_comment,
                theme.tokens.syn_type,
                theme.tokens.syn_function,
            ]
            .iter()
            .filter(|color| color.value() == wanted)
            .count();
            assert!(hit >= 1, "{token} did not reach any token");
        }
    }
}
