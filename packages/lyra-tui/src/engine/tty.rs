//! The terminal is `/dev/tty`, never stdio.
//!
//! In ACP-on-stdio mode stdin and stdout belong to the daemon: `cli.ts` spawns
//! this binary with its pipes wired to `AcpDaemon`. Writing a single escape byte
//! to stdout would corrupt a JSON-RPC frame, and reading a byte from stdin would
//! steal a notification. Every terminal read and write therefore goes to
//! `/dev/tty`, which is the controlling terminal regardless of how stdio is
//! redirected.
//!
//! Falling back to stdout when `/dev/tty` cannot be opened is deliberate and
//! narrow: it keeps `--smoke` usable under a CI harness that has no controlling
//! terminal. The fallback is never taken when an ACP connection is live, because
//! [`Tty::open`] is called with `allow_stdout_fallback: false` in that mode.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};

/// A writable handle on the controlling terminal.
#[derive(Debug)]
pub enum TtyWriter {
    /// `/dev/tty`.
    Device(File),
    /// Process stdout. Only used when no controlling terminal exists.
    Stdout(io::Stdout),
    /// Discards output. Used by tests and by `--smoke --dry-run`.
    Sink(Vec<u8>),
}

impl Write for TtyWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Self::Device(file) => file.write(buf),
            Self::Stdout(stdout) => stdout.write(buf),
            Self::Sink(sink) => {
                sink.extend_from_slice(buf);
                Ok(buf.len())
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Device(file) => file.flush(),
            Self::Stdout(stdout) => stdout.flush(),
            Self::Sink(_) => Ok(()),
        }
    }
}

/// Handles on the controlling terminal.
#[derive(Debug)]
pub struct Tty {
    /// Output half.
    pub writer: TtyWriter,
    /// Input half, when a real device was opened. Absent under the stdout
    /// fallback, which disables capability probing.
    pub reader: Option<File>,
}

impl Tty {
    /// Open the controlling terminal.
    ///
    /// # Errors
    ///
    /// Fails when `/dev/tty` is unavailable and the caller forbade the stdout
    /// fallback.
    pub fn open(allow_stdout_fallback: bool) -> io::Result<Self> {
        match OpenOptions::new().read(true).write(true).open("/dev/tty") {
            Ok(file) => {
                let reader = file.try_clone().ok();
                Ok(Self {
                    writer: TtyWriter::Device(file),
                    reader,
                })
            }
            Err(error) if allow_stdout_fallback => {
                let _ = error;
                Ok(Self {
                    writer: TtyWriter::Stdout(io::stdout()),
                    reader: None,
                })
            }
            Err(error) => Err(error),
        }
    }

    /// A handle that captures output in memory.
    #[must_use]
    pub const fn sink() -> Self {
        Self {
            writer: TtyWriter::Sink(Vec::new()),
            reader: None,
        }
    }
}
