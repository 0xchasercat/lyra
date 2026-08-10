//! Newline-delimited JSON framing.
//!
//! The wire format is fixed by `packages/lyra-acp/src/daemon.ts`, which was read
//! rather than assumed: `AcpDaemon.serve` splits its input on `\n`, `.trim()`s
//! each line, skips empty lines, and `JSON.parse`s the remainder; `AcpDaemon.write`
//! emits `${JSON.stringify(value)}\n`. It is **not** LSP-style `Content-Length`
//! framing, and there is no header block.
//!
//! Two daemon behaviours this codec mirrors exactly:
//!
//! - A frame larger than `maxFrameBytes` (default 4 MiB) is fatal: the daemon
//!   replies `-32003` and returns from `serve`, killing the connection. The
//!   decoder therefore treats overflow as a hard error rather than truncating.
//! - Trailing bytes with no final newline are still parsed when the stream ends
//!   (`serve`'s post-loop `if (buffer.trim().length > 0)`), so [`Decoder::finish`]
//!   exists.

use std::fmt;

/// Default frame ceiling, matching `DEFAULT_MAX_FRAME_BYTES` in `daemon.ts`.
pub const DEFAULT_MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// A framing-level failure. Distinct from a JSON-RPC error: these kill the pipe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FramingError {
    /// A single frame exceeded the negotiated ceiling.
    FrameTooLarge {
        /// Bytes accumulated when the limit was crossed.
        len: usize,
        /// The configured ceiling.
        limit: usize,
    },
    /// A frame was not valid UTF-8.
    NotUtf8,
}

impl fmt::Display for FramingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FrameTooLarge { len, limit } => {
                write!(f, "ACP frame of {len} bytes exceeds the {limit} byte limit")
            }
            Self::NotUtf8 => f.write_str("ACP frame is not valid UTF-8"),
        }
    }
}

impl std::error::Error for FramingError {}

/// Incremental newline-delimited frame decoder.
///
/// Feed arbitrary byte chunks; take back whole trimmed, non-empty frames. Byte
/// buffering (rather than string buffering) means a multi-byte grapheme split
/// across two reads is reassembled correctly.
#[derive(Debug)]
pub struct Decoder {
    buffer: Vec<u8>,
    limit: usize,
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_FRAME_BYTES)
    }
}

impl Decoder {
    /// Create a decoder with an explicit frame ceiling.
    #[must_use]
    pub const fn new(limit: usize) -> Self {
        Self {
            buffer: Vec::new(),
            limit,
        }
    }

    /// Bytes currently held in the partial-frame buffer.
    #[must_use]
    pub fn pending(&self) -> usize {
        self.buffer.len()
    }

    /// Feed a chunk, appending every complete frame to `out`.
    ///
    /// Blank frames are dropped, matching the daemon's `if (line.length > 0)`.
    ///
    /// # Errors
    ///
    /// [`FramingError::FrameTooLarge`] if a frame (complete or still partial)
    /// crosses the ceiling; [`FramingError::NotUtf8`] for undecodable frames.
    pub fn feed(&mut self, chunk: &[u8], out: &mut Vec<String>) -> Result<(), FramingError> {
        self.buffer.extend_from_slice(chunk);
        let mut start = 0usize;
        while let Some(offset) = memchr_newline(&self.buffer[start..]) {
            let end = start + offset;
            let raw = &self.buffer[start..end];
            if raw.len() > self.limit {
                return Err(FramingError::FrameTooLarge {
                    len: raw.len(),
                    limit: self.limit,
                });
            }
            let line = std::str::from_utf8(raw).map_err(|_| FramingError::NotUtf8)?;
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                out.push(trimmed.to_owned());
            }
            start = end + 1;
        }
        self.buffer.drain(..start);
        if self.buffer.len() > self.limit {
            return Err(FramingError::FrameTooLarge {
                len: self.buffer.len(),
                limit: self.limit,
            });
        }
        Ok(())
    }

    /// Take any trailing frame that arrived without a terminating newline.
    ///
    /// # Errors
    ///
    /// As [`Decoder::feed`].
    pub fn finish(&mut self) -> Result<Option<String>, FramingError> {
        if self.buffer.is_empty() {
            return Ok(None);
        }
        let raw = std::mem::take(&mut self.buffer);
        let line = std::str::from_utf8(&raw).map_err(|_| FramingError::NotUtf8)?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            Ok(None)
        } else {
            Ok(Some(trimmed.to_owned()))
        }
    }
}

/// Encode one JSON-RPC message as a frame.
///
/// `serde_json`'s compact writer never emits a raw newline inside a string, so
/// `payload + b'\n'` is unambiguous.
///
/// # Errors
///
/// Propagates serialization failures.
pub fn encode<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, serde_json::Error> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn memchr_newline(haystack: &[u8]) -> Option<usize> {
    haystack.iter().position(|byte| *byte == b'\n')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(decoder: &mut Decoder, chunk: &str) -> Vec<String> {
        let mut out = Vec::new();
        decoder.feed(chunk.as_bytes(), &mut out).unwrap();
        out
    }

    #[test]
    fn splits_on_newlines() {
        let mut decoder = Decoder::default();
        assert_eq!(drain(&mut decoder, "{\"a\":1}\n{\"b\":2}\n"), vec![
            "{\"a\":1}".to_owned(),
            "{\"b\":2}".to_owned()
        ]);
    }

    #[test]
    fn reassembles_frames_split_across_chunks() {
        let mut decoder = Decoder::default();
        assert!(drain(&mut decoder, "{\"a\":").is_empty());
        assert!(drain(&mut decoder, "1}").is_empty());
        assert_eq!(decoder.pending(), 7);
        assert_eq!(drain(&mut decoder, "\n"), vec!["{\"a\":1}".to_owned()]);
        assert_eq!(decoder.pending(), 0);
    }

    #[test]
    fn reassembles_multibyte_graphemes_split_across_chunks() {
        let mut decoder = Decoder::default();
        let payload = "{\"t\":\"⟳\"}".as_bytes().to_vec();
        let (head, tail) = payload.split_at(7); // mid-way through the 3-byte glyph
        let mut out = Vec::new();
        decoder.feed(head, &mut out).unwrap();
        assert!(out.is_empty());
        decoder.feed(tail, &mut out).unwrap();
        decoder.feed(b"\n", &mut out).unwrap();
        assert_eq!(out, vec!["{\"t\":\"⟳\"}".to_owned()]);
    }

    #[test]
    fn drops_blank_frames_and_trims_carriage_returns() {
        let mut decoder = Decoder::default();
        assert_eq!(drain(&mut decoder, "\n  \n{\"a\":1}\r\n"), vec![
            "{\"a\":1}".to_owned()
        ]);
    }

    #[test]
    fn finish_yields_unterminated_trailing_frame() {
        let mut decoder = Decoder::default();
        assert!(drain(&mut decoder, "{\"a\":1}").is_empty());
        assert_eq!(decoder.finish().unwrap(), Some("{\"a\":1}".to_owned()));
        assert_eq!(decoder.finish().unwrap(), None);
    }

    #[test]
    fn rejects_oversized_complete_frame() {
        let mut decoder = Decoder::new(8);
        let mut out = Vec::new();
        let error = decoder.feed(b"0123456789\n", &mut out).unwrap_err();
        assert_eq!(error, FramingError::FrameTooLarge {
            len: 10,
            limit: 8
        });
    }

    #[test]
    fn rejects_oversized_partial_frame_before_it_completes() {
        let mut decoder = Decoder::new(8);
        let mut out = Vec::new();
        assert!(decoder.feed(b"0123456789", &mut out).is_err());
    }

    #[test]
    fn encode_appends_exactly_one_newline() {
        let bytes = encode(&serde_json::json!({"jsonrpc": "2.0"})).unwrap();
        assert_eq!(bytes.last(), Some(&b'\n'));
        assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 1);
    }

    #[test]
    fn encoded_frames_round_trip_through_the_decoder() {
        let mut wire = encode(&serde_json::json!({"method": "a\nb"})).unwrap();
        wire.extend(encode(&serde_json::json!({"method": "c"})).unwrap());
        let mut decoder = Decoder::default();
        let mut out = Vec::new();
        decoder.feed(&wire, &mut out).unwrap();
        assert_eq!(out.len(), 2, "an escaped newline must not split a frame");
    }
}
