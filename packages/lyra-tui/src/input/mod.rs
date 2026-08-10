//! Input (DESIGN.md §4, build phase 4).
//!
//! ## Module map
//!
//! | module | role |
//! |---|---|
//! | [`key`] | the normalised key model every other layer is written against |
//! | [`decode`] | the incremental terminal decoder (kitty + the legacy zoo) |
//! | [`actor`] | owns the tty read side, negotiates kitty, handles `SIGWINCH` |
//! | [`composer`] | the editor: kill ring, undo groups, chips, wrapping, modes |
//! | [`chips`] | paste chips — collapse, delete, expand losslessly at submit |
//! | [`killring`] | emacs kill ring with append/prepend accumulation |
//! | [`undo`] | undo groups: checkpoint on kind-change and cursor jump |
//! | [`wrap`] | width-aware wrapping that keeps CJK and long tokens aligned |
//! | [`history`] | JSONL prompt history under `~/.lyra/` |
//! | [`queue`] | the queue/steer state machine (DESIGN.md §0.2) |
//! | [`esc`] | the one ordered Esc ladder |
//! | [`completion`] | `@`/`/` detection and the completion-source seam |
//!
//! The keybinding registry lives one level up, in [`crate::keybind`], because
//! the palette and the `?` cheatsheet are rendering surfaces rather than input
//! ones and must not have to reach through this module to be generated.
//!
//! ## Terminal ownership
//!
//! Nothing here may reach for stdin: in ACP mode stdin is the daemon's pipe.
//! Input comes from `/dev/tty` by way of [`crate::engine::tty`], and
//! [`actor::InputActor`] is its **sole** reader — see that module for the
//! handover that removed phase 2's detached probe thread.

pub mod actor;
pub mod chips;
pub mod completion;
pub mod composer;
pub mod decode;
pub mod esc;
pub mod history;
pub mod key;
pub mod killring;
pub mod queue;
pub mod undo;
pub mod wrap;

pub use actor::{InputActor, InputEvent, InputHandle, KittySupport};
pub use composer::{Composer, ComposerMode, Submission};
pub use decode::{Decoded, Decoder};
pub use esc::{EscLadder, EscStep, EscWorld};
pub use key::{KeyCode, KeyEvent, KeyMods};
pub use queue::{QueueEffect, QueueMachine, TurnPhase};

/// Re-exported so phase-2 call sites written against `input::Action` keep
/// working. The declaration itself moved to [`crate::keybind`], where one
/// action serves dispatch, hints, the cheatsheet and the palette.
pub use crate::keybind::{Action, Context};
