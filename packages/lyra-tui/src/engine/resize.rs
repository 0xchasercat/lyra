//! Resize policy (DESIGN.md §1: "Resize is the tax").
//!
//! Two modes, both of ante's design:
//!
//! - [`ResizeMode::Conservative`] (default) — scrollback is never rewritten.
//!   Rows printed at the old width keep their old wrapping and may look stale.
//!   This is the only mode that is *safe everywhere*, because nothing it does
//!   depends on an undetectable terminal feature.
//! - [`ResizeMode::Purge`] — `CSI 3 J` (erase saved lines) followed by a replay
//!   of the recent transcript at the new width. Opt-in: support for `CSI 3 J` is
//!   undetectable, and on a terminal that ignores it the replay duplicates
//!   content instead of replacing it. DESIGN.md says to always purge under
//!   tmux/zellij, where it is reliable.
//!
//! Resize events are debounced at 250 ms: dragging a window edge produces a
//! storm, and reacting to each frame of it is how a TUI ends up with torn
//! output and a scrollback full of half-drawn regions.

use std::time::{Duration, Instant};

use crate::ui::Row;

/// The default debounce window from DESIGN.md §1.
pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(250);

/// The replay cap from DESIGN.md §1.
pub const DEFAULT_REPLAY_CAP: usize = 2000;

/// How a resize is handled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ResizeMode {
    /// Never rewrite scrollback. Safe on every terminal.
    #[default]
    Conservative,
    /// Erase saved lines and replay the recent transcript at the new width.
    ///
    /// Opt-in because `CSI 3 J` support is *undetectable*: a terminal that
    /// ignores it leaves the old scrollback in place and the replay appends a
    /// duplicate transcript instead of replacing one. There is no query that
    /// distinguishes the two, so the only honest default is off — except under
    /// a multiplexer, where the behaviour is known ([`purge_is_reliable`]).
    Purge,
}

impl ResizeMode {
    /// Resolve the configured mode against the environment.
    ///
    /// DESIGN.md §1: "always-purge under tmux/zellij where it is reliable". A
    /// user who asked for `Purge` gets it everywhere; a user who asked for
    /// nothing gets it only where it cannot go wrong.
    #[must_use]
    pub fn resolve(configured: Self, env: &dyn Fn(&str) -> Option<String>) -> Self {
        match configured {
            Self::Purge => Self::Purge,
            Self::Conservative if purge_is_reliable(env) => Self::Purge,
            Self::Conservative => Self::Conservative,
        }
    }
}

/// Whether `CSI 3 J` is known to work here.
///
/// True under tmux and zellij, which implement scrollback erasure themselves
/// and do not forward it to the outer terminal — so the outcome does not depend
/// on what the outer terminal happens to be.
#[must_use]
pub fn purge_is_reliable(env: &dyn Fn(&str) -> Option<String>) -> bool {
    if env("TMUX").is_some() || env("ZELLIJ").is_some() || env("ZELLIJ_SESSION_NAME").is_some() {
        return true;
    }
    // `screen-256color` is also what tmux sets `TERM` to by default.
    let term = env("TERM").unwrap_or_default();
    term.starts_with("tmux") || term.starts_with("screen")
}

/// Read the process environment. The argument [`ResizeMode::resolve`] takes in
/// production; tests pass a closure over a fixture instead.
#[must_use]
pub fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

/// Where [`ResizeMode::Purge`] gets its replacement rows.
///
/// **Not the compositor's replay ring.** That ring holds rows already wrapped
/// at the *old* width; replaying them would reproduce exactly the stale
/// wrapping purge exists to remove. A `ReplaySource` re-renders from semantic
/// state at the new width — see [`crate::ui::transcript::Transcript`], which
/// implements it.
pub trait ReplaySource {
    /// The tail of the transcript, re-rendered at `width`, capped at `cap`
    /// rows.
    fn replay_rows(&mut self, width: u16, cap: usize) -> Vec<Row>;
}

impl ReplaySource for Vec<Row> {
    /// A fixed set of rows, for tests and for a caller that has already
    /// rendered. Ignores `width`, so it is *not* a substitute for a real
    /// transcript — it cannot fix stale wrapping.
    fn replay_rows(&mut self, _width: u16, cap: usize) -> Vec<Row> {
        let start = self.len().saturating_sub(cap);
        self[start..].to_vec()
    }
}

/// Collapses a burst of size changes into one settled size.
#[derive(Debug)]
pub struct ResizeDebouncer {
    window: Duration,
    pending: Option<(u16, u16)>,
    last_seen: Option<Instant>,
    current: (u16, u16),
}

impl ResizeDebouncer {
    /// Start from a known size.
    #[must_use]
    pub const fn new(width: u16, height: u16, window: Duration) -> Self {
        Self {
            window,
            pending: None,
            last_seen: None,
            current: (width, height),
        }
    }

    /// The size last reported as settled.
    #[must_use]
    pub const fn current(&self) -> (u16, u16) {
        self.current
    }

    /// Record an observed size.
    pub fn observe(&mut self, width: u16, height: u16, now: Instant) {
        if (width, height) == self.current && self.pending.is_none() {
            return;
        }
        if self.pending == Some((width, height)) {
            // Same size still pending: keep the original deadline so a terminal
            // that repeats the size every poll cannot postpone the redraw forever.
            return;
        }
        self.pending = Some((width, height));
        self.last_seen = Some(now);
    }

    /// Return the settled size once the window has elapsed with no change.
    pub fn poll(&mut self, now: Instant) -> Option<(u16, u16)> {
        let pending = self.pending?;
        let last_seen = self.last_seen?;
        if now.duration_since(last_seen) < self.window {
            return None;
        }
        self.pending = None;
        self.last_seen = None;
        if pending == self.current {
            return None;
        }
        self.current = pending;
        Some(pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_change_settles_after_the_window() {
        let start = Instant::now();
        let mut debouncer = ResizeDebouncer::new(80, 24, DEFAULT_DEBOUNCE);
        debouncer.observe(100, 30, start);
        assert_eq!(debouncer.poll(start + Duration::from_millis(200)), None);
        assert_eq!(
            debouncer.poll(start + Duration::from_millis(260)),
            Some((100, 30))
        );
        assert_eq!(debouncer.current(), (100, 30));
    }

    #[test]
    fn a_drag_storm_produces_exactly_one_settled_size() {
        let start = Instant::now();
        let mut debouncer = ResizeDebouncer::new(80, 24, DEFAULT_DEBOUNCE);
        for step in 0..20u64 {
            let at = start + Duration::from_millis(step * 20);
            debouncer.observe(80 + u16::try_from(step).unwrap(), 24, at);
            assert_eq!(debouncer.poll(at), None, "no redraw mid-drag");
        }
        let settled = start + Duration::from_millis(19 * 20 + 260);
        assert_eq!(debouncer.poll(settled), Some((99, 24)));
        assert_eq!(debouncer.poll(settled), None, "settling fires once");
    }

    #[test]
    fn a_size_that_returns_to_where_it_started_produces_no_redraw() {
        let start = Instant::now();
        let mut debouncer = ResizeDebouncer::new(80, 24, DEFAULT_DEBOUNCE);
        debouncer.observe(120, 40, start);
        debouncer.observe(80, 24, start + Duration::from_millis(50));
        assert_eq!(debouncer.poll(start + Duration::from_millis(400)), None);
    }

    #[test]
    fn repeating_the_same_pending_size_does_not_postpone_settling() {
        let start = Instant::now();
        let mut debouncer = ResizeDebouncer::new(80, 24, DEFAULT_DEBOUNCE);
        for step in 0..10u64 {
            debouncer.observe(100, 30, start + Duration::from_millis(step * 100));
        }
        assert_eq!(
            debouncer.poll(start + Duration::from_millis(300)),
            Some((100, 30)),
            "a polling size source must not defeat the debounce"
        );
    }

    #[test]
    fn conservative_is_the_default_mode() {
        assert_eq!(ResizeMode::default(), ResizeMode::Conservative);
    }

    fn env(pairs: &[(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        move |key: &str| {
            pairs
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn purge_is_the_default_under_a_multiplexer_and_nowhere_else() {
        assert!(purge_is_reliable(&env(&[("TMUX", "/tmp/tmux-501/default,1,0")])));
        assert!(purge_is_reliable(&env(&[("ZELLIJ", "0")])));
        assert!(purge_is_reliable(&env(&[("TERM", "screen-256color")])));
        assert!(purge_is_reliable(&env(&[("TERM", "tmux-256color")])));
        assert!(!purge_is_reliable(&env(&[("TERM", "xterm-ghostty")])));
        assert!(!purge_is_reliable(&env(&[])));
    }

    #[test]
    fn an_empty_tmux_variable_does_not_count_as_being_in_tmux() {
        // `process_env` filters empties; the resolver must see the same thing.
        assert!(!purge_is_reliable(&|_| None));
    }

    #[test]
    fn resolution_honours_an_explicit_choice_everywhere() {
        assert_eq!(
            ResizeMode::resolve(ResizeMode::Purge, &env(&[("TERM", "xterm")])),
            ResizeMode::Purge,
            "an explicit --purge is not second-guessed"
        );
        assert_eq!(
            ResizeMode::resolve(ResizeMode::Conservative, &env(&[("TERM", "xterm")])),
            ResizeMode::Conservative
        );
        assert_eq!(
            ResizeMode::resolve(ResizeMode::Conservative, &env(&[("TMUX", "x")])),
            ResizeMode::Purge
        );
    }

    #[test]
    fn a_row_vector_replay_source_returns_its_capped_tail() {
        let mut rows: Vec<Row> = (0..10).map(|n| Row::text(format!("row {n}"))).collect();
        let replayed = rows.replay_rows(80, 3);
        assert_eq!(replayed.len(), 3);
        assert_eq!(replayed[0].plain_text(), "row 7");
    }
}
