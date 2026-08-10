//! # lyra-tui
//!
//! Standalone Rust TUI client for Lyra. Owns input, state and rendering; speaks
//! ACP (JSON-RPC 2.0 over newline-delimited stdio) to the daemon and nothing else.
//!
//! Governing document: `packages/lyra-tui/DESIGN.md`.
//!
//! ## Module map
//!
//! | module | role | phase |
//! |---|---|---|
//! | [`vendor::flywheel`] | vendored compositor core (cell/buffer/diff) | 2 |
//! | [`engine`] | scrollback writer, live region, capabilities, resize | 2 |
//! | [`state`] | session store, delta application, tool lifecycle | 3 |
//! | [`acp`] | JSON-RPC client, framing codec, wire types | 1/2 |
//! | [`ui`] | content renderers and live-region widgets | 5 |
//! | [`theme`] | semantic colour tokens, adaptive `system` theme | 5 |
//! | [`input`] | input actor, decoder, composer, queue, Esc policy | 4 |
//! | [`keybind`] | the keybinding registry — one declaration, four surfaces | 4 |
//! | [`app`] | the application loop: input → ACP calls → rendering | 6 |
//!
//! ## The load-bearing invariant (DESIGN.md §1)
//!
//! A row printed above the live region is **never** addressed again. Every escape
//! sequence this crate emits is either (a) a plain write at the live-region top
//! that scrolls content into native scrollback, or (b) an absolute cursor move
//! into rows `[region_top, region_top + region_height)`. There is no alternate
//! screen, no `CSI 2J`, no mouse capture, and no internal viewport.
//!
//! The single, deliberate exception is [`engine::ResizeMode::Purge`], which
//! exists precisely to replace scrollback: it emits `CSI 3 J` and reprints the
//! transcript **re-rendered at the new width** from
//! [`ui::transcript::Transcript`]. It is opt-in outside tmux/zellij because
//! `CSI 3 J` support cannot be probed for.

#![forbid(unsafe_code)]

pub mod acp;
pub mod app;
pub mod engine;
pub mod input;
pub mod keybind;
pub mod state;
pub mod theme;
pub mod ui;
pub mod vendor;
