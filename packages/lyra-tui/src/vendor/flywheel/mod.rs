//! Vendored Flywheel compositor core.
//!
//! Source: <https://github.com/0xchasercat/flywheel> @ `067a68fc4bc1e5c6790b746f9ec053553f1ed3a8`
//! (`flywheel-compositor` 0.1.5). Licensed MIT OR Apache-2.0.
//!
//! # What is vendored, and why only this
//!
//! Vendored verbatim: [`cell`] (cache-packed cell with grapheme overflow table),
//! [`buffer`] (cell grid), [`rect`]. Vendored with one documented patch: [`diff`]
//! (minimal-ANSI diffing with SGR/cursor state tracking).
//!
//! Deliberately **not** vendored, because each fights DESIGN.md §1
//! (native scrollback, no alt-screen, immutable rows above the fold):
//!
//! - `actor::Engine` — unconditionally enters raw mode and, by default, the
//!   alternate screen; owns a full-terminal `Buffer`; hides the cursor forever.
//!   Our compositor owns only a bounded bottom region and never leaves the
//!   normal screen.
//! - `actor::RendererActor` — its `RawOutput` handler sets `needs_full_redraw`,
//!   so *every* fast-path write forces a whole-screen repaint on the next frame.
//!   That is precisely the pathology the fast path exists to avoid, and under
//!   native scrollback a whole-screen repaint would overwrite committed rows.
//! - `buffer::diff::render_full` — emits `CSI 2J`. Removed here; a blank shadow
//!   buffer plus [`diff::render_region_diff`] yields the same pixels while
//!   touching nothing above the live region.
//! - `widget::{StreamWidget, ScrollBuffer}` — keep the whole transcript in an
//!   internal diffable scrollback. DESIGN.md §1 names that as the root defect of
//!   Claude Code's renderer.
//! - `actor::InputActor` — crossterm legacy key decoding only; DESIGN.md §4
//!   requires kitty-protocol negotiation. Phase 4 supplies its own.
//!
//! # The patch to `diff.rs`
//!
//! 1. `use crate::layout::Rect` → `use super::Rect` (module relocation).
//! 2. Added `render_diff_at` / `render_region_diff`: an `origin_row` applied when
//!    an absolute cursor move is emitted, so a region-sized buffer can be painted
//!    at an arbitrary screen row. `render_diff` keeps its upstream signature and
//!    delegates with origin 0.
//! 3. Removed `render_full` (see above).
//! 4. `Rgb::DEFAULT_FG` / `Rgb::DEFAULT_BG` now emit SGR 39 / 49 instead of
//!    truecolor white / truecolor black. Upstream painted an opaque black
//!    background into every blank cell, which makes DESIGN.md §3's
//!    terminal-adaptive `system` theme ("background alpha 0") impossible and
//!    inverts the page on a light terminal.

#[allow(clippy::module_inception)]
mod buffer;
mod cell;
pub mod diff;
mod rect;

pub use buffer::Buffer;
pub use cell::{Cell, CellFlags, Modifiers, Rgb};
pub use rect::Rect;
