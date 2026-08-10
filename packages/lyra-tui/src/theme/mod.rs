//! Semantic colour tokens (DESIGN.md §3, build phase 5).
//!
//! # Why a token set and not a palette
//!
//! Evidence from both big TUIs: roughly six tokens carry over 90% of coloured
//! output. So the theme is not "a colour for every widget", it is a small
//! semantic vocabulary — **two accents maximum** (accent + agent-identity
//! tint), semantic error/warning/success, and a dim-first neutral ramp. Every
//! renderer in [`crate::ui`] asks for a token, never for a colour.
//!
//! # The transparency rule
//!
//! The background is *never* painted. Every theme leaves it at
//! [`Color::TERMINAL`], which the vendored diff emits as SGR 49, so the user's
//! own background — including transparency and image backdrops — shows through.
//! This is what DESIGN.md §3 means by "background alpha 0".
//!
//! # The pure-white / pure-black trap, encoded
//!
//! The vendored Flywheel is patched so that [`Rgb::DEFAULT_FG`] (which is
//! literally `#ffffff`) and [`Rgb::DEFAULT_BG`] (literally `#000000`) are
//! emitted as SGR 39/49 — *the terminal's own* colours — rather than as
//! truecolor white and black. A theme that asked for literal `#ffffff` would
//! therefore silently become "whatever the user's foreground is".
//!
//! Rather than leave that as a trap in a comment, [`Color::rgb`] **nudges**:
//! `#ffffff` becomes `#fefefe` and `#000000` becomes `#010101`, both visually
//! indistinguishable and both unambiguously literal. A theme that actually
//! wants the terminal default asks for it by name with [`Color::TERMINAL`].
//!
//! # Modules
//!
//! - [`adaptive`] — the `system` theme: OSC 4 palette probing, OSC 11
//!   background luminance, synthesized neutral ramp, DEC 2031 live re-theme.
//! - [`config`] — TOML overrides (data only).

pub mod adaptive;
pub mod config;

use crate::ui::Style;
use crate::vendor::flywheel::{Modifiers, Rgb};

/// A themed colour: either an explicit truecolor value or the terminal default.
///
/// [`Color::TERMINAL`] is not a colour the theme picked; it is a deliberate
/// refusal to pick one, and it is how the background stays transparent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Color(Option<Rgb>);

impl Color {
    /// The terminal's own colour (SGR 39 as a foreground, SGR 49 as a
    /// background). The default.
    pub const TERMINAL: Self = Self(None);

    /// An explicit colour.
    ///
    /// Pure white and pure black are nudged by one unit — see the module docs.
    /// This is the only place the nudge happens, so no theme can bypass it.
    #[must_use]
    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        let (r, g, b) = match (r, g, b) {
            (255, 255, 255) => (254, 254, 254),
            (0, 0, 0) => (1, 1, 1),
            other => other,
        };
        Self(Some(Rgb::new(r, g, b)))
    }

    /// An explicit colour from `0xRRGGBB`.
    #[must_use]
    pub const fn hex(hex: u32) -> Self {
        Self::rgb(
            ((hex >> 16) & 0xFF) as u8,
            ((hex >> 8) & 0xFF) as u8,
            (hex & 0xFF) as u8,
        )
    }

    /// Wrap a probed terminal colour, applying the same nudge.
    #[must_use]
    pub const fn from_rgb(rgb: Rgb) -> Self {
        Self::rgb(rgb.r, rgb.g, rgb.b)
    }

    /// Whether this is the terminal default.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        self.0.is_none()
    }

    /// The explicit value, if any.
    #[must_use]
    pub const fn value(self) -> Option<Rgb> {
        self.0
    }

    /// As a foreground for [`Style`].
    #[must_use]
    pub const fn as_fg(self) -> Rgb {
        match self.0 {
            Some(rgb) => rgb,
            None => Rgb::DEFAULT_FG,
        }
    }

    /// A [`Style`] painting this colour on the terminal's own background.
    #[must_use]
    pub const fn style(self) -> Style {
        Style {
            fg: self.as_fg(),
            bg: Rgb::DEFAULT_BG,
            modifiers: Modifiers::empty(),
        }
    }

    /// Mix towards `other`. `amount` is clamped to `0..=1`.
    ///
    /// Terminal-default operands have no numeric value to mix, so the explicit
    /// side wins; mixing two defaults yields the default.
    #[must_use]
    pub fn mix(self, other: Self, amount: f32) -> Self {
        let amount = amount.clamp(0.0, 1.0);
        match (self.0, other.0) {
            (Some(a), Some(b)) => Self::rgb(
                lerp(a.r, b.r, amount),
                lerp(a.g, b.g, amount),
                lerp(a.b, b.b, amount),
            ),
            (Some(a), None) => Self::from_rgb(a),
            (None, Some(b)) => Self::from_rgb(b),
            (None, None) => Self::TERMINAL,
        }
    }

    /// Relative luminance in `0..=1`, or `None` for the terminal default.
    #[must_use]
    pub fn luminance(self) -> Option<f32> {
        self.0.map(luminance)
    }
}

fn lerp(a: u8, b: u8, amount: f32) -> u8 {
    let a = f32::from(a);
    let b = f32::from(b);
    (a + (b - a) * amount).round().clamp(0.0, 255.0) as u8
}

/// Rec. 601 relative luminance, good enough to answer "is this light or dark".
#[must_use]
pub fn luminance(rgb: Rgb) -> f32 {
    (0.299 * f32::from(rgb.r) + 0.587 * f32::from(rgb.g) + 0.114 * f32::from(rgb.b)) / 255.0
}

/// Whether a theme is built for a light or a dark terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Appearance {
    /// Dark background.
    #[default]
    Dark,
    /// Light background.
    Light,
}

impl Appearance {
    /// Classify a probed background colour (OSC 11).
    #[must_use]
    pub fn of(background: Rgb) -> Self {
        if luminance(background) > 0.5 {
            Self::Light
        } else {
            Self::Dark
        }
    }
}

/// The semantic token set.
///
/// Deliberately small. Adding a token is a design decision, not a convenience:
/// every one added is one more thing three bundled themes and the adaptive
/// `system` theme must answer for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tokens {
    // -- the two accents ---------------------------------------------------
    /// Primary accent: running tools, the composer border while streaming,
    /// code spans, links.
    pub accent: Color,
    /// Agent-identity tint. The *only* second accent (DESIGN.md §3).
    pub agent: Color,

    // -- semantics ---------------------------------------------------------
    /// Failures.
    pub error: Color,
    /// Degradations that are not failures (fallbacks, loop warnings).
    pub warning: Color,
    /// Confirmations.
    pub success: Color,

    // -- the dim-first neutral ramp ---------------------------------------
    /// Body text. Terminal default in every bundled theme.
    pub text: Color,
    /// Secondary text: metadata, audit rows, tool detail.
    pub muted: Color,
    /// Tertiary: rules, gutters, elision markers.
    pub faint: Color,

    // -- markdown ----------------------------------------------------------
    /// `h1`. Strong.
    pub heading: Color,
    /// `h2`/`h3`. Modest by design.
    pub subheading: Color,
    /// Blockquote text and its `▎` rail.
    pub quote: Color,

    // -- diff --------------------------------------------------------------
    /// Added lines.
    pub diff_add: Color,
    /// Removed lines.
    pub diff_del: Color,
    /// Intra-line word emphasis inside an added line.
    pub diff_add_emph: Color,
    /// Intra-line word emphasis inside a removed line.
    pub diff_del_emph: Color,

    // -- syntax ------------------------------------------------------------
    /// Keywords.
    pub syn_keyword: Color,
    /// String and char literals.
    pub syn_string: Color,
    /// Numeric literals.
    pub syn_number: Color,
    /// Comments.
    pub syn_comment: Color,
    /// Types, traits, classes.
    pub syn_type: Color,
    /// Function and method names at a call or definition site.
    pub syn_function: Color,
}

/// A named token set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Theme {
    /// Theme name, as `[tui.theme] name = "..."` would spell it.
    pub name: String,
    /// Which background this theme was built for.
    pub appearance: Appearance,
    /// The tokens.
    pub tokens: Tokens,
    /// Whether to emit OSC 8 hyperlinks. Off for terminals known not to strip
    /// unknown OSC sequences cleanly; the renderers underline instead.
    pub hyperlinks: bool,
}

impl Default for Theme {
    fn default() -> Self {
        Self::lyra()
    }
}

impl Theme {
    /// Every bundled theme name, in listing order. `system` is adaptive and is
    /// built by [`adaptive::system_theme`] rather than being a constant.
    pub const BUNDLED: [&'static str; 4] = ["lyra", "ember", "mono", "system"];

    /// Look a bundled theme up by name.
    ///
    /// `system` resolves to the dark fallback here; a caller with a probed
    /// palette should use [`adaptive::system_theme`] instead.
    #[must_use]
    pub fn by_name(name: &str) -> Option<Self> {
        match name {
            "lyra" => Some(Self::lyra()),
            "ember" => Some(Self::ember()),
            "mono" => Some(Self::mono()),
            "system" => Some(adaptive::system_theme(&adaptive::TerminalPalette::default())),
            _ => None,
        }
    }

    /// The default theme: a single violet accent with a cyan agent tint.
    #[must_use]
    pub fn lyra() -> Self {
        Self {
            name: "lyra".to_owned(),
            appearance: Appearance::Dark,
            hyperlinks: true,
            tokens: Tokens {
                accent: Color::hex(0x9682DC),
                agent: Color::hex(0x5FB3C4),
                error: Color::hex(0xD25A5A),
                warning: Color::hex(0xC89B3C),
                success: Color::hex(0x6FA85F),
                text: Color::TERMINAL,
                muted: Color::hex(0x8A8A96),
                faint: Color::hex(0x5C5C66),
                heading: Color::hex(0xB6A6F0),
                subheading: Color::hex(0x9682DC),
                quote: Color::hex(0x8A8A96),
                diff_add: Color::hex(0x6FA85F),
                diff_del: Color::hex(0xD25A5A),
                diff_add_emph: Color::hex(0x9CDB86),
                diff_del_emph: Color::hex(0xF08C8C),
                syn_keyword: Color::hex(0x9682DC),
                syn_string: Color::hex(0x8FB06E),
                syn_number: Color::hex(0xC89B3C),
                syn_comment: Color::hex(0x6B6B78),
                syn_type: Color::hex(0x5FB3C4),
                syn_function: Color::hex(0xC0A9F5),
            },
        }
    }

    /// A warm theme: amber accent, rust agent tint.
    #[must_use]
    pub fn ember() -> Self {
        Self {
            name: "ember".to_owned(),
            appearance: Appearance::Dark,
            hyperlinks: true,
            tokens: Tokens {
                accent: Color::hex(0xD89A40),
                agent: Color::hex(0xB56A3C),
                error: Color::hex(0xCE5A4A),
                warning: Color::hex(0xC9A63A),
                success: Color::hex(0x7C9E52),
                text: Color::TERMINAL,
                muted: Color::hex(0x948B7E),
                faint: Color::hex(0x666058),
                heading: Color::hex(0xE8B45C),
                subheading: Color::hex(0xD89A40),
                quote: Color::hex(0x948B7E),
                diff_add: Color::hex(0x7C9E52),
                diff_del: Color::hex(0xCE5A4A),
                diff_add_emph: Color::hex(0xA6CE72),
                diff_del_emph: Color::hex(0xEE8272),
                syn_keyword: Color::hex(0xD89A40),
                syn_string: Color::hex(0x9CAF63),
                syn_number: Color::hex(0xC9A63A),
                syn_comment: Color::hex(0x716A61),
                syn_type: Color::hex(0xB56A3C),
                syn_function: Color::hex(0xE3C078),
            },
        }
    }

    /// Neutral-only: the ramp plus the three semantics, and nothing else.
    ///
    /// Not a "no colour" theme — reliability surfaces still need error and
    /// warning to be legible. Everything decorative collapses onto the ramp.
    #[must_use]
    pub fn mono() -> Self {
        let text = Color::TERMINAL;
        let muted = Color::hex(0x8C8C8C);
        let faint = Color::hex(0x5E5E5E);
        Self {
            name: "mono".to_owned(),
            appearance: Appearance::Dark,
            hyperlinks: true,
            tokens: Tokens {
                accent: Color::hex(0xC4C4C4),
                agent: muted,
                error: Color::hex(0xC76B6B),
                warning: Color::hex(0xBE9B4E),
                success: Color::hex(0x7EA874),
                text,
                muted,
                faint,
                heading: Color::hex(0xE2E2E2),
                subheading: Color::hex(0xC4C4C4),
                quote: muted,
                diff_add: Color::hex(0x7EA874),
                diff_del: Color::hex(0xC76B6B),
                diff_add_emph: Color::hex(0xA5C79B),
                diff_del_emph: Color::hex(0xE09090),
                syn_keyword: Color::hex(0xC4C4C4),
                syn_string: muted,
                syn_number: muted,
                syn_comment: faint,
                syn_type: Color::hex(0xD6D6D6),
                syn_function: Color::hex(0xD6D6D6),
            },
        }
    }

    // -- convenience styles -------------------------------------------------

    /// Body text.
    #[must_use]
    pub const fn text(&self) -> Style {
        self.tokens.text.style()
    }

    /// Secondary text: `DIM` *and* the muted colour, because a terminal that
    /// ignores SGR 2 must still show the hierarchy.
    #[must_use]
    pub const fn muted(&self) -> Style {
        self.tokens.muted.style().with(Modifiers::DIM)
    }

    /// Tertiary text: rules, gutters, elisions.
    #[must_use]
    pub const fn faint(&self) -> Style {
        self.tokens.faint.style().with(Modifiers::DIM)
    }

    /// The primary accent.
    #[must_use]
    pub const fn accent(&self) -> Style {
        self.tokens.accent.style()
    }

    /// The agent-identity tint.
    #[must_use]
    pub const fn agent(&self) -> Style {
        self.tokens.agent.style()
    }

    /// Failure.
    #[must_use]
    pub const fn error(&self) -> Style {
        self.tokens.error.style()
    }

    /// Degradation.
    #[must_use]
    pub const fn warning(&self) -> Style {
        self.tokens.warning.style()
    }

    /// Confirmation.
    #[must_use]
    pub const fn success(&self) -> Style {
        self.tokens.success.style()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every_token(theme: &Theme) -> Vec<Color> {
        let Tokens {
            accent,
            agent,
            error,
            warning,
            success,
            text,
            muted,
            faint,
            heading,
            subheading,
            quote,
            diff_add,
            diff_del,
            diff_add_emph,
            diff_del_emph,
            syn_keyword,
            syn_string,
            syn_number,
            syn_comment,
            syn_type,
            syn_function,
        } = theme.tokens;
        vec![
            accent,
            agent,
            error,
            warning,
            success,
            text,
            muted,
            faint,
            heading,
            subheading,
            quote,
            diff_add,
            diff_del,
            diff_add_emph,
            diff_del_emph,
            syn_keyword,
            syn_string,
            syn_number,
            syn_comment,
            syn_type,
            syn_function,
        ]
    }

    #[test]
    fn pure_white_is_nudged_so_it_cannot_collapse_to_the_terminal_default() {
        // Rgb::DEFAULT_FG *is* #ffffff and the vendored diff emits it as SGR 39.
        assert_eq!(Rgb::DEFAULT_FG, Rgb::new(255, 255, 255));
        let white = Color::rgb(255, 255, 255);
        assert_ne!(white.as_fg(), Rgb::DEFAULT_FG, "a literal white must stay literal");
        assert_eq!(white.value(), Some(Rgb::new(254, 254, 254)));
    }

    #[test]
    fn pure_black_is_nudged_so_it_cannot_collapse_to_the_terminal_default() {
        assert_eq!(Rgb::DEFAULT_BG, Rgb::new(0, 0, 0));
        assert_eq!(Color::rgb(0, 0, 0).value(), Some(Rgb::new(1, 1, 1)));
    }

    #[test]
    fn hex_and_probe_construction_go_through_the_same_nudge() {
        assert_eq!(Color::hex(0x00FFFFFF).value(), Some(Rgb::new(254, 254, 254)));
        assert_eq!(Color::hex(0x00000000).value(), Some(Rgb::new(1, 1, 1)));
        assert_eq!(
            Color::from_rgb(Rgb::new(255, 255, 255)).value(),
            Some(Rgb::new(254, 254, 254))
        );
    }

    #[test]
    fn no_bundled_theme_paints_a_background() {
        for name in ["lyra", "ember", "mono"] {
            let theme = Theme::by_name(name).unwrap();
            for token in every_token(&theme) {
                assert_eq!(
                    token.style().bg,
                    Rgb::DEFAULT_BG,
                    "{name}: a token painted a background, breaking transparency"
                );
            }
        }
    }

    #[test]
    fn no_bundled_token_is_accidentally_the_terminal_default_except_body_text() {
        for name in ["lyra", "ember", "mono"] {
            let theme = Theme::by_name(name).unwrap();
            assert!(theme.tokens.text.is_terminal(), "{name}: body text must inherit");
            for token in every_token(&theme) {
                if token.is_terminal() {
                    continue;
                }
                assert_ne!(
                    token.as_fg(),
                    Rgb::DEFAULT_FG,
                    "{name}: an explicit token collapsed to SGR 39"
                );
            }
        }
    }

    #[test]
    fn every_bundled_name_resolves() {
        for name in Theme::BUNDLED {
            assert!(Theme::by_name(name).is_some(), "{name}");
        }
        assert!(Theme::by_name("nope").is_none());
    }

    #[test]
    fn mixing_moves_between_two_colours() {
        let a = Color::rgb(10, 10, 10);
        let b = Color::rgb(210, 210, 210);
        assert_eq!(a.mix(b, 0.5).value(), Some(Rgb::new(110, 110, 110)));
        assert_eq!(a.mix(b, 0.0).value(), a.value());
        assert_eq!(a.mix(b, 1.0).value(), b.value());
    }

    #[test]
    fn mixing_with_the_terminal_default_keeps_the_explicit_side() {
        let explicit = Color::rgb(10, 20, 30);
        assert_eq!(explicit.mix(Color::TERMINAL, 0.5), explicit);
        assert_eq!(Color::TERMINAL.mix(explicit, 0.5), explicit);
        assert!(Color::TERMINAL.mix(Color::TERMINAL, 0.5).is_terminal());
    }

    #[test]
    fn appearance_follows_background_luminance() {
        assert_eq!(Appearance::of(Rgb::new(20, 20, 25)), Appearance::Dark);
        assert_eq!(Appearance::of(Rgb::new(250, 248, 240)), Appearance::Light);
    }

    #[test]
    fn muted_and_faint_carry_dim_as_well_as_a_colour() {
        let theme = Theme::lyra();
        assert!(theme.muted().modifiers.contains(Modifiers::DIM));
        assert!(theme.faint().modifiers.contains(Modifiers::DIM));
    }
}
