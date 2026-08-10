//! ACP: the only protocol this binary speaks (DESIGN.md §2).
//!
//! - [`codec`] — newline-delimited framing, matched to `packages/lyra-acp/src/daemon.ts`.
//! - [`types`] — serde types for the canonical schema,
//!   `packages/lyra-acp/schema/protocol.json`.
//! - `conformance` (test-only) — loads that schema file and asserts the types
//!   here have not drifted from it.
//! - [`client`] — bidirectional JSON-RPC client over stdio.

pub mod client;
pub mod codec;
#[cfg(test)]
mod conformance;
pub mod types;

pub use client::{AcpClient, AcpError, AcpEvent, Call, MethodNotFound, Responder};
pub use codec::{Decoder, FramingError};
pub use types::{Id, Secret, Update, UpdateNotification};
