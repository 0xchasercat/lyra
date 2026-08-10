//! The rendering engine (DESIGN.md build phase 2).
//!
//! - [`tty`] — terminal I/O on `/dev/tty`, never on the ACP stdio pipes.
//! - [`caps`] — DA1-sentinel batch capability probing.
//! - [`commit`] — the commit-stable-rows decision, as a pure trait.
//! - [`scrollback`] — the compositor: scrollback writer + bounded live region.
//! - [`resize`] — debounce and the two resize modes.

pub mod caps;
pub mod commit;
pub mod resize;
pub mod scrollback;
pub mod tty;

pub use caps::Caps;
pub use commit::{BlockCommitPolicy, CommitPolicy, StreamBlock, TextCommitPolicy};
pub use resize::{ResizeDebouncer, ResizeMode};
pub use scrollback::{Compositor, Config, Frame, Metrics};
pub use tty::Tty;
