//! The scrollback compositor — DESIGN.md §1, the load-bearing choice.
//!
//! # The invariant
//!
//! The screen is divided at `region_top`. Everything above it has been printed
//! exactly once and is owned by the terminal: its selection, its search, its
//! scrollback. Everything from `region_top` down is the **live region**, a
//! bounded strip this type redraws by diffing.
//!
//! No escape sequence emitted here addresses a row above `region_top`. There is
//! no alternate screen, no `CSI 2J`, no mouse capture, and no internal viewport.
//!
//! [`Compositor::resize_with`] under [`ResizeMode::Purge`] is the one exception,
//! and it is not a leak in the invariant but the invariant's stated escape
//! hatch: DESIGN.md §1's opt-in mode, which erases saved lines and reprints the
//! transcript at the new width. Every other method upholds the rule above.
//!
//! # How a row reaches scrollback
//!
//! ```text
//!   before                     after committing 2 rows
//!   ┌────────────────┐         ┌────────────────┐
//!   │ …transcript…   │         │ …transcript…   │  ← scrolled up 2
//!   │                │         │ committed row 1│  ← printed once
//!   ├─ region_top ───┤         │ committed row 2│
//!   │ live region    │         ├─ region_top ───┤
//!   └────────────────┘         │ live region    │
//!                              └────────────────┘
//! ```
//!
//! 1. Park at `region_top`, erase from there to the end of the screen.
//! 2. Print the committed rows, each followed by `\r\n`. A `\n` on the bottom
//!    screen row scrolls, which is precisely how native scrollback grows.
//! 3. Re-reserve `region_height` blank rows, scrolling if the region would fall
//!    off the bottom, and record the region's new top row.
//! 4. Repaint the region by diffing a blank shadow against the new content.
//!
//! Step 4 is why commits are **batched per frame** rather than per row: the
//! region repaint is paid once for a frame that commits three hundred rows.
//!
//! # The fast path
//!
//! When the live region is already blank on screen, steps 1's erase and 4's
//! repaint are both no-ops, and a committed row costs only its own bytes plus
//! `\r\n`. [`Metrics::fast_path_commits`] counts rows that took this path.
//! Bulk transcript replay and non-interactive commits run entirely on it.
//!
//! # Why this cannot be Flywheel's `Engine`
//!
//! Flywheel's renderer resets to a full-screen redraw after every raw write and
//! its `render_full` clears the screen. Under this architecture either would
//! erase committed rows. Only its cell/buffer/diff core is reused, at
//! [`crate::vendor::flywheel`].

use std::collections::VecDeque;
use std::io::{self, Write};

use crate::ui::Row;
use crate::vendor::flywheel::diff::{render_region_diff, DiffState};
use crate::vendor::flywheel::{Buffer, Cell};

use super::caps::{Caps, BSU, ESU};
use super::resize::{ReplaySource, ResizeMode, DEFAULT_REPLAY_CAP};

/// Erase from the cursor to the end of the screen.
const ERASE_BELOW: &[u8] = b"\x1b[0J";
/// Erase the terminal's *saved* lines — the scrollback above the screen.
///
/// The one sequence in this crate that touches anything above the fold, emitted
/// only by [`ResizeMode::Purge`], whose entire purpose is to replace it. Support
/// is undetectable, which is why purge is opt-in outside a multiplexer.
const ERASE_SCROLLBACK: &[u8] = b"\x1b[3J";
/// Home the cursor.
const CURSOR_HOME: &[u8] = b"\x1b[H";
/// Hide the cursor.
const HIDE_CURSOR: &[u8] = b"\x1b[?25l";
/// Show the cursor.
const SHOW_CURSOR: &[u8] = b"\x1b[?25h";
/// Reset SGR.
const SGR_RESET: &[u8] = b"\x1b[0m";

/// What the live region should show this frame.
#[derive(Debug, Default)]
pub struct Frame<'a> {
    /// Region rows, top to bottom. Rows beyond the region height are dropped —
    /// the region is bounded by construction, never by content.
    pub rows: &'a [Row],
    /// Region-local `(column, row)` for the caret, or `None` to hide it.
    pub cursor: Option<(u16, u16)>,
}

/// Rendering counters. The `--smoke` binary prints these as its proof.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Metrics {
    /// Frames rendered.
    pub frames: u64,
    /// Rows committed to scrollback.
    pub committed_rows: u64,
    /// Committed rows that needed neither an erase nor a region repaint.
    pub fast_path_commits: u64,
    /// Frames whose commit forced a region repaint from blank.
    pub region_repaints: u64,
    /// Frames whose region changed without any commit.
    pub region_diffs: u64,
    /// Bytes written to the terminal.
    pub bytes_written: u64,
    /// Frames that emitted nothing at all.
    pub empty_frames: u64,
    /// Settled resizes handled.
    pub resizes: u64,
    /// Resizes that asked for [`ResizeMode::Purge`] but had no
    /// [`ReplaySource`] to purge *to*, and got conservative handling instead.
    pub purge_requests: u64,
    /// Purges actually performed: scrollback erased and the transcript
    /// re-rendered at the new width.
    pub purges: u64,
    /// Rows reprinted by those purges.
    pub replayed_rows: u64,
}

/// Compositor configuration.
#[derive(Debug, Clone, Copy)]
pub struct Config {
    /// Live region height in rows. DESIGN.md §1 bounds it at roughly 24.
    pub region_height: u16,
    /// Resize policy.
    pub resize_mode: ResizeMode,
    /// Cap on the replay ring.
    pub replay_cap: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            region_height: 8,
            resize_mode: ResizeMode::Conservative,
            replay_cap: DEFAULT_REPLAY_CAP,
        }
    }
}

/// Owns the bottom of the terminal, and nothing else.
#[derive(Debug)]
pub struct Compositor<W: Write> {
    out: W,
    caps: Caps,
    config: Config,
    width: u16,
    height: u16,
    /// 1-indexed absolute screen row of live region row 0.
    region_top: u16,
    region_height: u16,
    /// The height the region wants, which is [`Config::region_height`] until an
    /// overlay asks for more (see [`Compositor::set_region_height`]). Kept apart
    /// from the config so a resize re-derives the *current* request rather than
    /// silently snapping a grown region back.
    desired_height: u16,
    shadow: Buffer,
    next: Buffer,
    diff: DiffState,
    pending: Vec<Row>,
    replay: VecDeque<Row>,
    metrics: Metrics,
    scratch: Vec<u8>,
}

impl<W: Write> Compositor<W> {
    /// Take ownership of the bottom `config.region_height` rows.
    ///
    /// `caps.cursor_row` positions the region under whatever the shell already
    /// printed. When it is unknown the region is anchored to the bottom of the
    /// screen, which is correct for a full screen and merely cosmetic otherwise.
    ///
    /// # Errors
    ///
    /// Propagates terminal write failures.
    pub fn new(mut out: W, caps: Caps, width: u16, height: u16, config: Config) -> io::Result<Self> {
        let height = height.max(1);
        let width = width.max(1);
        let region_height = config.region_height.clamp(1, height);

        let mut bytes = Vec::with_capacity(64);
        let mut row = caps.cursor_row.unwrap_or(height).clamp(1, height);
        // A shell that left the cursor mid-line must not have that line
        // overwritten; start on a fresh one.
        if caps.cursor_col.unwrap_or(1) > 1 {
            bytes.extend_from_slice(b"\r\n");
            row = (row + 1).min(height);
        } else {
            bytes.push(b'\r');
        }
        bytes.extend(std::iter::repeat_n(b'\n', usize::from(region_height - 1)));
        row = row.saturating_add(region_height - 1).min(height);
        let region_top = row.saturating_sub(region_height - 1).max(1);
        // The reserved rows may still hold whatever was on screen below the
        // cursor; blank them so the shadow buffer is honest.
        move_to(&mut bytes, region_top, 1);
        bytes.extend_from_slice(ERASE_BELOW);
        out.write_all(&bytes)?;
        out.flush()?;

        Ok(Self {
            out,
            caps,
            config,
            width,
            height,
            region_top,
            region_height,
            desired_height: config.region_height,
            shadow: Buffer::new(width, region_height),
            next: Buffer::new(width, region_height),
            diff: DiffState::new(),
            pending: Vec::new(),
            replay: VecDeque::new(),
            metrics: Metrics {
                bytes_written: bytes.len() as u64,
                ..Metrics::default()
            },
            scratch: Vec::with_capacity(8192),
        })
    }

    /// Rendering counters.
    #[must_use]
    pub const fn metrics(&self) -> Metrics {
        self.metrics
    }

    /// Current terminal size.
    #[must_use]
    pub const fn size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    /// 1-indexed screen row of the live region's first row.
    #[must_use]
    pub const fn region_top(&self) -> u16 {
        self.region_top
    }

    /// Live region height.
    #[must_use]
    pub const fn region_height(&self) -> u16 {
        self.region_height
    }

    /// Grow or shrink the live region.
    ///
    /// The region is bounded (DESIGN.md §1) but not *fixed*: an overlay is a
    /// panel drawn into it, and a six-row region cannot hold a picker. Rather
    /// than give overlays a second rendering mode, they borrow rows.
    ///
    /// **The region grows downwards first and scrolls only for what is left
    /// over.** The rows between the region's bottom edge and the bottom of the
    /// screen are nobody's — the region sits directly under the last committed
    /// row, which early in a session is nowhere near the last screen row — so a
    /// panel that fits in them costs nothing at all. Only the deficit is
    /// scrolled, as newlines at the bottom of the screen, exactly as a commit
    /// scrolls: the top rows go into the terminal's own scrollback and the
    /// region takes the fresh blank ones. Nothing already printed is
    /// overwritten.
    ///
    /// Scrolling unconditionally was the `/model` blank-rows defect. A region
    /// with free rows under it was erased, then `extra` lines were scrolled off
    /// the top anyway — and because the region's *own* rows had just been
    /// blanked, what went into scrollback was them: a run of empty lines
    /// committed above whatever the picker's result printed next.
    ///
    /// Shrinking keeps the region's **top** edge and hands the rows back at the
    /// bottom, where they are free screen again for the next commit to reserve.
    /// Keeping the bottom edge instead would leave the vacated rows stranded
    /// *above* the region — blank, un-erasable, and destined for scrollback the
    /// moment anything scrolled: the same residue from the other direction, plus
    /// a visible gap between the transcript and the composer for as long as the
    /// session lasted.
    ///
    /// Scrollback itself is never touched in either direction; this is only ever
    /// a choice about which rows the region claims.
    ///
    /// # Errors
    ///
    /// Propagates terminal write failures.
    pub fn set_region_height(&mut self, height: u16) -> io::Result<()> {
        let target = height.clamp(1, self.height);
        self.desired_height = target;
        if target == self.region_height {
            return Ok(());
        }

        let mut out = Vec::with_capacity(64);
        move_to(&mut out, self.region_top, 1);
        out.extend_from_slice(ERASE_BELOW);

        if target > self.region_height {
            let free = self
                .height
                .saturating_sub(self.region_top + self.region_height - 1);
            let scroll = (target - self.region_height).saturating_sub(free);
            if scroll > 0 {
                move_to(&mut out, self.height, 1);
                out.extend(std::iter::repeat_n(b'\n', usize::from(scroll)));
                self.region_top = self.region_top.saturating_sub(scroll).max(1);
            }
        }
        self.region_height = target;
        // A region that would hang off the bottom is re-anchored to it; the
        // alternative is a composer drawn on rows that do not exist.
        if self.region_top.saturating_add(target - 1) > self.height {
            self.region_top = self.height.saturating_sub(target - 1).max(1);
        }

        self.shadow = Buffer::new(self.width, target);
        self.next = Buffer::new(self.width, target);
        self.diff.reset();
        move_to(&mut out, self.region_top, 1);
        out.extend_from_slice(ERASE_BELOW);
        out.extend_from_slice(SGR_RESET);

        self.out.write_all(&out)?;
        self.out.flush()?;
        self.metrics.bytes_written += out.len() as u64;
        Ok(())
    }

    /// The bounded ring of recently committed rows.
    ///
    /// Exists for [`ResizeMode::Purge`]'s replay. Capped at
    /// [`Config::replay_cap`]; a long session's memory is bounded by it.
    #[must_use]
    pub const fn replay_buffer(&self) -> &VecDeque<Row> {
        &self.replay
    }

    /// Queue a row for the next frame's commit to scrollback.
    ///
    /// The row is not written until [`Compositor::render`] runs, so a burst of
    /// commits costs one region repaint rather than one per row.
    pub fn commit(&mut self, row: Row) {
        self.pending.push(row);
    }

    /// Queue several rows.
    pub fn commit_all<I: IntoIterator<Item = Row>>(&mut self, rows: I) {
        self.pending.extend(rows);
    }

    /// Number of rows queued but not yet written.
    #[must_use]
    pub fn pending_commits(&self) -> usize {
        self.pending.len()
    }

    /// Write one frame: commit queued rows, then reconcile the live region.
    ///
    /// # Errors
    ///
    /// Propagates terminal write failures.
    pub fn render(&mut self, frame: &Frame<'_>) -> io::Result<()> {
        let mut out = std::mem::take(&mut self.scratch);
        out.clear();

        let committed = std::mem::take(&mut self.pending);
        self.paint_next(frame);
        let region_changed = self.next.cells() != self.shadow.cells();

        if committed.is_empty() && !region_changed && frame.cursor.is_none() {
            self.pending = committed;
            self.pending.clear();
            self.metrics.frames += 1;
            self.metrics.empty_frames += 1;
            self.scratch = out;
            return Ok(());
        }

        // Synchronized output (DEC 2026): the terminal buffers everything between
        // BSU and ESU and composites one frame, so a commit plus a region repaint
        // cannot be seen half-applied.
        if self.caps.synchronized_output {
            out.extend_from_slice(BSU);
        }
        out.extend_from_slice(HIDE_CURSOR);

        if !committed.is_empty() {
            let shadow_blank = buffer_is_blank(&self.shadow);
            self.emit_commits(&committed, shadow_blank, &mut out);
            self.metrics.committed_rows += committed.len() as u64;
            if shadow_blank {
                self.metrics.fast_path_commits += committed.len() as u64;
            } else {
                self.metrics.region_repaints += 1;
            }
            for row in committed {
                if self.replay.len() == self.config.replay_cap {
                    self.replay.pop_front();
                }
                self.replay.push_back(row);
            }
        } else if region_changed {
            self.metrics.region_diffs += 1;
        }

        // The cursor is parked between frames, so the diff state cannot be
        // carried across one. Resetting costs a single cursor move.
        self.diff.reset();
        render_region_diff(
            &self.shadow,
            &self.next,
            self.region_top - 1,
            &mut out,
            &mut self.diff,
        );
        self.shadow.copy_from(&self.next);

        match frame.cursor {
            Some((x, y)) => {
                let row = self.region_top + y.min(self.region_height - 1);
                move_to(&mut out, row, x.min(self.width.saturating_sub(1)) + 1);
                out.extend_from_slice(SGR_RESET);
                out.extend_from_slice(SHOW_CURSOR);
            }
            None => {
                move_to(&mut out, self.region_top + self.region_height - 1, 1);
                out.extend_from_slice(SGR_RESET);
            }
        }
        if self.caps.synchronized_output {
            out.extend_from_slice(ESU);
        }

        self.out.write_all(&out)?;
        self.out.flush()?;
        self.metrics.frames += 1;
        self.metrics.bytes_written += out.len() as u64;
        self.scratch = out;
        Ok(())
    }

    /// Apply a settled resize.
    ///
    /// `cursor_row` is a freshly probed cursor position when one is available.
    /// Without it the region is re-anchored to the bottom of the screen, which
    /// is where terminals leave the cursor after a reflow.
    ///
    /// Scrollback is never rewritten: rows printed at the old width keep their
    /// old wrapping. That staleness is [`ResizeMode::Conservative`]'s explicit
    /// trade, and the only behaviour that is safe on every terminal.
    ///
    /// # Errors
    ///
    /// Propagates terminal write failures.
    pub fn resize(&mut self, width: u16, height: u16, cursor_row: Option<u16>) -> io::Result<()> {
        if self.config.resize_mode == ResizeMode::Purge {
            // Purge with no transcript to replay would erase the session and
            // put nothing back. Counted, and handled conservatively.
            // `resize_with` is the call that actually purges.
            self.metrics.purge_requests += 1;
        }
        self.reanchor(width, height, cursor_row)?;
        self.metrics.resizes += 1;
        Ok(())
    }

    /// Apply a settled resize, purging and replaying when the mode asks for it.
    ///
    /// [`ResizeMode::Conservative`] ignores `source` entirely and behaves
    /// exactly like [`Compositor::resize`].
    ///
    /// [`ResizeMode::Purge`] erases the terminal's saved lines (`CSI 3 J`) and
    /// the visible screen, then reprints the transcript **re-rendered at the
    /// new width** — which is why it takes a [`ReplaySource`] rather than
    /// reusing [`Compositor::replay_buffer`]: that ring holds rows already
    /// wrapped to the old width, and reprinting them would reproduce the stale
    /// wrapping the purge was invoked to remove.
    ///
    /// The replay is capped at [`Config::replay_cap`] rows (DESIGN.md §1's
    /// ~2000). A purge that reprinted a whole day would take longer than the
    /// resize it is reacting to.
    ///
    /// # Errors
    ///
    /// Propagates terminal write failures.
    pub fn resize_with<S: ReplaySource + ?Sized>(
        &mut self,
        width: u16,
        height: u16,
        cursor_row: Option<u16>,
        source: &mut S,
    ) -> io::Result<()> {
        if self.config.resize_mode != ResizeMode::Purge {
            return self.resize(width, height, cursor_row);
        }

        self.width = width.max(1);
        self.height = height.max(1);
        self.region_height = self.desired_height.clamp(1, self.height);
        let rows = source.replay_rows(self.width, self.config.replay_cap);

        let mut out = Vec::with_capacity(8192);
        // Saved lines first, then the visible screen from the home position.
        // `CSI 0 J` from home rather than `CSI 2 J`: identical effect, and it
        // keeps the crate's "no full-screen erase" property literally true for
        // every mode but this one.
        out.extend_from_slice(ERASE_SCROLLBACK);
        out.extend_from_slice(CURSOR_HOME);
        out.extend_from_slice(ERASE_BELOW);

        // Reprint into scrollback exactly the way a normal commit does, so a
        // purged transcript is byte-identical to one printed at this width.
        for row in &rows {
            row.write_ansi(self.width, &mut out);
            out.extend_from_slice(b"\r\n");
        }
        // Reserve the live region under the replay, scrolling if it would fall
        // off the bottom.
        let printed = u16::try_from(rows.len()).unwrap_or(u16::MAX);
        let mut row = printed.saturating_add(1).min(self.height);
        let bottom = row.saturating_add(self.region_height - 1);
        if bottom > self.height {
            let scroll = bottom - self.height;
            move_to(&mut out, self.height, 1);
            out.extend(std::iter::repeat_n(b'\n', usize::from(scroll)));
            row = row.saturating_sub(scroll).max(1);
        }
        self.region_top = row.max(1);

        self.shadow = Buffer::new(self.width, self.region_height);
        self.next = Buffer::new(self.width, self.region_height);
        self.diff.reset();
        move_to(&mut out, self.region_top, 1);
        out.extend_from_slice(ERASE_BELOW);
        out.extend_from_slice(SGR_RESET);

        self.out.write_all(&out)?;
        self.out.flush()?;

        // The ring now holds the rows actually on screen, at the current width.
        self.replay.clear();
        for row in rows {
            if self.replay.len() == self.config.replay_cap {
                self.replay.pop_front();
            }
            self.replay.push_back(row);
        }

        self.metrics.bytes_written += out.len() as u64;
        self.metrics.resizes += 1;
        self.metrics.purges += 1;
        self.metrics.replayed_rows += u64::from(printed);
        Ok(())
    }

    fn reanchor(&mut self, width: u16, height: u16, cursor_row: Option<u16>) -> io::Result<()> {
        self.width = width.max(1);
        self.height = height.max(1);
        self.region_height = self.desired_height.clamp(1, self.height);
        self.region_top = self
            .height
            .saturating_sub(self.region_height - 1)
            .max(1);
        self.region_top = cursor_row
            .map_or(self.region_top, |row| {
                row.clamp(1, self.height)
                    .saturating_sub(self.region_height - 1)
                    .max(1)
            });

        self.shadow = Buffer::new(self.width, self.region_height);
        self.next = Buffer::new(self.width, self.region_height);
        self.diff.reset();

        let mut out = Vec::with_capacity(32);
        move_to(&mut out, self.region_top, 1);
        out.extend_from_slice(ERASE_BELOW);
        self.out.write_all(&out)?;
        self.out.flush()?;
        self.metrics.bytes_written += out.len() as u64;
        Ok(())
    }

    /// Release the terminal: erase the live region and leave the cursor on the
    /// first row it occupied, so a shell prompt lands directly under the
    /// transcript with no blank gap and no leftover chrome.
    ///
    /// # Errors
    ///
    /// Propagates terminal write failures.
    pub fn finish(&mut self) -> io::Result<()> {
        let mut out = Vec::with_capacity(32);
        move_to(&mut out, self.region_top, 1);
        out.extend_from_slice(ERASE_BELOW);
        out.extend_from_slice(SGR_RESET);
        out.extend_from_slice(SHOW_CURSOR);
        self.out.write_all(&out)?;
        self.out.flush()?;
        self.metrics.bytes_written += out.len() as u64;
        Ok(())
    }

    /// Consume the compositor, returning its output sink. Used by tests.
    pub fn into_inner(self) -> W {
        self.out
    }

    fn paint_next(&mut self, frame: &Frame<'_>) {
        self.next.clear();
        for (index, row) in frame.rows.iter().enumerate() {
            let Ok(y) = u16::try_from(index) else { break };
            if y >= self.region_height {
                break;
            }
            row.paint(&mut self.next, y);
        }
    }

    fn emit_commits(&mut self, rows: &[Row], shadow_blank: bool, out: &mut Vec<u8>) {
        move_to(out, self.region_top, 1);
        if !shadow_blank {
            out.extend_from_slice(ERASE_BELOW);
        }

        let mut row = self.region_top;
        for committed in rows {
            committed.write_ansi(self.width, out);
            out.extend_from_slice(b"\r\n");
            row = (row + 1).min(self.height);
            // when it was already the last screen row the terminal scrolled; `row` stays pinned to the last screen
            // row and everything above it moved one line into scrollback.
        }

        // Re-reserve the region below the last committed row.
        let bottom = row.saturating_add(self.region_height - 1);
        if bottom > self.height {
            let scroll = bottom - self.height;
            move_to(out, self.height, 1);
            out.extend(std::iter::repeat_n(b'\n', usize::from(scroll)));
            row = row.saturating_sub(scroll).max(1);
        }
        self.region_top = row;
        self.shadow.clear();
        self.diff.reset();
    }
}

fn move_to(out: &mut Vec<u8>, row: u16, col: u16) {
    if col == 1 {
        out.extend_from_slice(format!("\x1b[{row}H").as_bytes());
    } else {
        out.extend_from_slice(format!("\x1b[{row};{col}H").as_bytes());
    }
}

fn buffer_is_blank(buffer: &Buffer) -> bool {
    buffer.cells().iter().all(|cell| *cell == Cell::EMPTY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::Style;
    use crate::vendor::flywheel::Rgb;

    /// Terminal that answers everything, so tests exercise the full path.
    fn caps() -> Caps {
        Caps {
            synchronized_output: true,
            cursor_row: Some(24),
            cursor_col: Some(1),
            responsive: true,
        }
    }

    fn compositor(region_height: u16) -> Compositor<Vec<u8>> {
        Compositor::new(Vec::new(), caps(), 40, 24, Config {
            region_height,
            ..Config::default()
        })
        .unwrap()
    }

    fn drain(compositor: &mut Compositor<Vec<u8>>) -> String {
        let bytes = std::mem::take(compositor.out.by_ref());
        String::from_utf8(bytes).unwrap()
    }

    fn render(compositor: &mut Compositor<Vec<u8>>, rows: &[Row]) -> String {
        compositor.render(&Frame { rows, cursor: None }).unwrap();
        drain(compositor)
    }

    #[test]
    fn construction_reserves_the_region_and_anchors_it() {
        let compositor = compositor(4);
        // The cursor was on row 24 of a 24-row screen, so reserving 4 rows
        // scrolls 3 lines into scrollback and the region ends at the bottom.
        assert_eq!(compositor.region_top(), 21);
        assert_eq!(compositor.region_height(), 4);
    }

    #[test]
    fn construction_never_enters_the_alternate_screen_or_clears_the_display() {
        let mut compositor = compositor(4);
        let output = drain(&mut compositor);
        assert!(!output.contains("\x1b[?1049h"), "no alternate screen");
        assert!(!output.contains("\x1b[2J"), "no full-screen erase");
        assert!(!output.contains("\x1b[3J"), "no scrollback erase");
        assert!(!output.contains("\x1b[?1000h"), "no mouse capture");
    }

    #[test]
    fn a_committed_row_is_printed_once_and_never_addressed_again() {
        let mut compositor = compositor(3);
        let _ = drain(&mut compositor);
        compositor.commit(Row::text("committed line"));
        let first = render(&mut compositor, &[Row::text("live")]);
        assert!(first.contains("committed line"));

        // Ten more frames of live-region churn.
        for step in 0..10 {
            let output = render(&mut compositor, &[Row::text(format!("live {step}"))]);
            assert!(
                !output.contains("committed line"),
                "frame {step} rewrote a committed row: {output:?}"
            );
        }
    }

    #[test]
    fn no_frame_ever_addresses_a_row_above_the_region() {
        let mut compositor = compositor(5);
        let _ = drain(&mut compositor);
        for step in 0..40 {
            compositor.commit(Row::text(format!("row {step}")));
            let output = render(&mut compositor, &[
                Row::text(format!("tail {step}")),
                Row::text("─ activity ─"),
            ]);
            let top = compositor.region_top();
            for row in cursor_rows(&output) {
                assert!(
                    row >= top,
                    "frame {step} moved to row {row}, above region_top {top}"
                );
            }
        }
    }

    #[test]
    fn an_overlay_can_grow_the_region_and_give_the_rows_back() {
        let mut compositor = compositor(6);
        compositor.commit(Row::text("printed before the overlay"));
        let _ = render(&mut compositor, &[Row::text("tail")]);
        let (top, bottom) = (
            compositor.region_top(),
            compositor.region_top() + compositor.region_height() - 1,
        );

        compositor.set_region_height(18).unwrap();
        let grown = drain(&mut compositor);
        assert_eq!(compositor.region_height(), 18);
        assert!(
            compositor.region_top() < top,
            "the region grew upwards over rows the scroll just freed"
        );
        assert_eq!(
            grown.matches('\n').count(),
            18 - 6,
            "growing scrolls by exactly the rows it takes, so nothing printed is overwritten"
        );
        assert!(!grown.contains("\x1b[3J"), "and never erases scrollback");
        assert!(compositor.region_top() >= 1);

        let grown_top = compositor.region_top();
        compositor.set_region_height(6).unwrap();
        assert_eq!(compositor.region_height(), 6);
        assert_eq!(
            compositor.region_top(),
            grown_top,
            "shrinking keeps the top edge — the rows go back to the bottom of the \
             screen, where the next commit can reserve them, rather than being \
             stranded blank above the region on their way into scrollback"
        );
        assert!(
            compositor.region_top() + compositor.region_height() - 1 < bottom,
            "the composer rises with the panel it was under, leaving no gap"
        );
        assert_eq!(
            compositor.region_top(),
            top - 12,
            "the region is back on the row the transcript ends on — the twelve the \
             growth scrolled were transcript rows, and the next commit starts \
             immediately under them rather than twelve blank rows lower"
        );
    }

    #[test]
    fn growing_into_the_free_rows_under_the_region_scrolls_nothing() {
        // The `/model` blank-rows defect. The region sits directly under the last
        // committed row, so early in a session there is unused screen below it —
        // and growing scrolled the top of the screen away regardless. What went
        // over the top was the region's own rows, blanked a moment earlier by the
        // erase this method opens with: a run of empty lines committed to
        // scrollback above whatever the picker printed next.
        let mut compositor = Compositor::new(
            Vec::new(),
            Caps {
                cursor_row: Some(6),
                ..caps()
            },
            40,
            24,
            Config {
                region_height: 6,
                ..Config::default()
            },
        )
        .unwrap();
        let _ = drain(&mut compositor);
        let top = compositor.region_top();
        assert!(
            top + 6 - 1 < 24,
            "the fixture is the case that matters: free rows below the region"
        );

        compositor.set_region_height(18).unwrap();
        let grown = drain(&mut compositor);
        assert_eq!(
            grown.matches('\n').count(),
            0,
            "nothing scrolled, so nothing — least of all a blank row — was committed"
        );
        assert_eq!(compositor.region_top(), top, "the region grew downwards");
        assert_eq!(compositor.region_height(), 18);

        compositor.set_region_height(6).unwrap();
        assert_eq!(compositor.region_top(), top, "and gave the rows back");
    }

    #[test]
    fn a_partly_free_screen_scrolls_only_the_rows_it_is_short() {
        let mut compositor = Compositor::new(
            Vec::new(),
            Caps {
                cursor_row: Some(16),
                ..caps()
            },
            40,
            24,
            Config {
                region_height: 6,
                ..Config::default()
            },
        )
        .unwrap();
        let _ = drain(&mut compositor);
        // Region at rows 16..21, so three rows are free and a growth of eight
        // has to scroll for the other five.
        assert_eq!(compositor.region_top(), 16);
        compositor.set_region_height(14).unwrap();
        let grown = drain(&mut compositor);
        assert_eq!(grown.matches('\n').count(), 5);
        assert_eq!(compositor.region_top(), 11);
        assert_eq!(compositor.region_top() + compositor.region_height() - 1, 24);
    }

    #[test]
    fn a_grown_region_survives_a_resize() {
        let mut compositor = compositor(6);
        compositor.set_region_height(14).unwrap();
        compositor.resize(60, 30, None).unwrap();
        assert_eq!(
            compositor.region_height(),
            14,
            "a resize re-derives the height the app asked for, not the configured one"
        );
        compositor.set_region_height(6).unwrap();
        compositor.resize(60, 30, None).unwrap();
        assert_eq!(compositor.region_height(), 6);
    }

    #[test]
    fn a_region_taller_than_the_screen_is_clamped_rather_than_wrapping() {
        let mut compositor = compositor(6);
        compositor.set_region_height(200).unwrap();
        assert_eq!(compositor.region_height(), 24, "the screen is 24 rows");
        assert_eq!(compositor.region_top(), 1);
    }

    #[test]
    fn the_region_stays_bounded_no_matter_how_much_is_committed() {
        let mut compositor = compositor(6);
        for step in 0..500 {
            compositor.commit(Row::text(format!("line {step}")));
        }
        let _ = render(&mut compositor, &[Row::text("tail")]);
        assert_eq!(compositor.region_height(), 6);
        assert!(compositor.region_top() >= 1);
        assert!(compositor.region_top() + 6 - 1 <= 24);
    }

    #[test]
    fn committing_with_a_blank_region_takes_the_fast_path() {
        let mut compositor = compositor(3);
        let _ = drain(&mut compositor);
        compositor.commit(Row::text("alpha"));
        let output = render(&mut compositor, &[]);

        assert_eq!(compositor.metrics().fast_path_commits, 1);
        assert_eq!(compositor.metrics().region_repaints, 0);
        assert!(!output.contains("\x1b[0J"), "fast path erases nothing: {output:?}");
        // Sync markers, one cursor park, the row, CRLF and the trailing reset.
        assert!(output.len() < 64, "fast path emitted {} bytes: {output:?}", output.len());
    }

    #[test]
    fn bulk_appends_stay_on_the_fast_path_and_cost_about_a_line_each() {
        let mut compositor = compositor(3);
        let _ = drain(&mut compositor);
        let mut total = 0usize;
        for step in 0..200 {
            compositor.commit(Row::text(format!("line {step:03}")));
            total += render(&mut compositor, &[]).len();
        }
        assert_eq!(compositor.metrics().fast_path_commits, 200);
        assert_eq!(compositor.metrics().region_repaints, 0);
        let per_line = total / 200;
        assert!(per_line < 64, "fast-path append cost {per_line} bytes per line");
    }

    #[test]
    fn committing_under_a_populated_region_erases_and_repaints_exactly_once() {
        let mut compositor = compositor(3);
        let live = [Row::text("streaming tail"), Row::text("─ activity ─")];
        let _ = render(&mut compositor, &live);

        compositor.commit_all((0..50).map(|step| Row::text(format!("bulk {step}"))));
        let output = render(&mut compositor, &live);

        assert_eq!(compositor.metrics().region_repaints, 1, "one repaint for 50 rows");
        assert_eq!(compositor.metrics().committed_rows, 50);
        assert_eq!(output.matches("\x1b[0J").count(), 1, "one erase for the batch");
        // The diff writes only changed cells, so the repainted row arrives as
        // runs separated by cursor moves rather than as one contiguous string.
        assert!(output.contains("streaming"), "{output:?}");
        assert!(output.contains("tail"), "{output:?}");
    }

    #[test]
    fn an_unchanged_region_with_no_commits_writes_nothing() {
        let mut compositor = compositor(3);
        let rows = [Row::text("steady")];
        let _ = render(&mut compositor, &rows);
        let output = render(&mut compositor, &rows);
        assert!(output.is_empty(), "idle frame wrote {output:?}");
        assert_eq!(compositor.metrics().empty_frames, 1);
    }

    #[test]
    fn a_region_only_change_diffs_instead_of_repainting() {
        let mut compositor = compositor(3);
        let _ = render(&mut compositor, &[Row::text("aaaa"), Row::text("bbbb")]);
        let output = render(&mut compositor, &[Row::text("aaaa"), Row::text("bbbc")]);
        assert_eq!(compositor.metrics().region_diffs, 2);
        assert!(!output.contains("\x1b[0J"), "no erase for a region-only change");
        assert!(output.contains('c'));
        assert!(!output.contains("aaaa"), "unchanged rows are not rewritten: {output:?}");
    }

    #[test]
    fn synchronized_output_wraps_every_frame_that_writes() {
        let mut compositor = compositor(3);
        let _ = drain(&mut compositor);
        let output = render(&mut compositor, &[Row::text("x")]);
        assert!(output.starts_with("\x1b[?2026h"), "{output:?}");
        assert!(output.ends_with("\x1b[?2026l"), "{output:?}");
    }

    #[test]
    fn synchronized_output_is_omitted_when_the_terminal_lacks_it() {
        let mut compositor = Compositor::new(
            Vec::new(),
            Caps {
                synchronized_output: false,
                ..caps()
            },
            40,
            24,
            Config::default(),
        )
        .unwrap();
        let _ = drain(&mut compositor);
        let output = render(&mut compositor, &[Row::text("x")]);
        assert!(!output.contains("2026"), "{output:?}");
    }

    #[test]
    fn a_styled_committed_row_resets_attributes_so_nothing_bleeds() {
        let mut compositor = compositor(3);
        let _ = drain(&mut compositor);
        compositor.commit(Row::styled("warn", Style::fg(Rgb::new(200, 120, 0))));
        let output = render(&mut compositor, &[]);
        let row_end = output.find("\r\n").expect("committed row terminator");
        assert!(output[..row_end].ends_with("\x1b[0m"), "{output:?}");
    }

    #[test]
    fn a_resize_re_anchors_the_region_without_touching_scrollback() {
        let mut compositor = compositor(4);
        compositor.commit(Row::text("history"));
        let _ = render(&mut compositor, &[Row::text("live")]);

        compositor.resize(100, 40, None).unwrap();
        let output = drain(&mut compositor);
        assert!(!output.contains("\x1b[2J"));
        assert!(!output.contains("\x1b[3J"));
        assert_eq!(compositor.size(), (100, 40));
        assert_eq!(compositor.region_top(), 37);
        assert_eq!(compositor.metrics().resizes, 1);
    }

    #[test]
    fn a_resize_forces_a_full_region_repaint_from_blank() {
        let mut compositor = compositor(3);
        let rows = [Row::text("live")];
        let _ = render(&mut compositor, &rows);
        compositor.resize(40, 24, None).unwrap();
        let _ = drain(&mut compositor);
        let output = render(&mut compositor, &rows);
        assert!(output.contains("live"), "the region was repainted after resize");
    }

    fn purging(region_height: u16) -> Compositor<Vec<u8>> {
        Compositor::new(
            Vec::new(),
            caps(),
            40,
            24,
            Config {
                region_height,
                resize_mode: ResizeMode::Purge,
                ..Config::default()
            },
        )
        .unwrap()
    }

    /// A replay source that reports the width it was asked for, so a test can
    /// prove the transcript was re-rendered rather than replayed stale.
    struct Reflow;

    impl super::ReplaySource for Reflow {
        fn replay_rows(&mut self, width: u16, cap: usize) -> Vec<Row> {
            (0..cap.min(3))
                .map(|index| Row::text(format!("row {index} at {width}")))
                .collect()
        }
    }

    #[test]
    fn purge_without_a_replay_source_is_counted_and_stays_conservative() {
        let mut compositor = purging(3);
        compositor.resize(40, 30, None).unwrap();
        let output = drain(&mut compositor);
        assert_eq!(compositor.metrics().purge_requests, 1);
        assert_eq!(compositor.metrics().purges, 0);
        assert!(
            !output.contains("\x1b[3J"),
            "erasing scrollback with nothing to put back is worse than staleness"
        );
    }

    #[test]
    fn purge_erases_the_saved_lines_and_reprints_the_transcript() {
        let mut compositor = purging(3);
        let _ = drain(&mut compositor);
        compositor
            .resize_with(60, 30, None, &mut Reflow)
            .unwrap();
        let output = drain(&mut compositor);
        assert!(output.starts_with("\x1b[3J"), "{output:?}");
        assert!(output.contains("\x1b[H"), "the screen is cleared from home");
        assert!(output.contains("row 0 at 60"), "{output:?}");
        assert_eq!(compositor.metrics().purges, 1);
        assert_eq!(compositor.metrics().replayed_rows, 3);
        assert_eq!(compositor.size(), (60, 30));
    }

    #[test]
    fn purge_re_renders_at_the_new_width_rather_than_replaying_the_ring() {
        let mut compositor = purging(3);
        compositor.commit(Row::text("printed at the old width"));
        let _ = render(&mut compositor, &[]);
        compositor
            .resize_with(100, 30, None, &mut Reflow)
            .unwrap();
        let output = drain(&mut compositor);
        assert!(
            !output.contains("printed at the old width"),
            "the old-width ring must not be what gets reprinted: {output:?}"
        );
        assert!(output.contains("at 100"));
    }

    #[test]
    fn purge_leaves_the_live_region_reserved_and_diffable() {
        let mut compositor = purging(3);
        compositor
            .resize_with(40, 24, None, &mut Reflow)
            .unwrap();
        let _ = drain(&mut compositor);
        assert_eq!(compositor.region_height(), 3);
        assert!(compositor.region_top() >= 1);
        assert!(compositor.region_top() + 3 - 1 <= 24);
        // The region diff writes only changed cells, so a repainted row arrives
        // as runs separated by cursor moves rather than as one string.
        let output = render(&mut compositor, &[Row::text("live again")]);
        assert!(output.contains("live"), "{output:?}");
        assert!(output.contains("again"), "{output:?}");
    }

    #[test]
    fn purge_refreshes_the_ring_with_what_is_actually_on_screen() {
        let mut compositor = purging(3);
        compositor.commit(Row::text("stale"));
        let _ = render(&mut compositor, &[]);
        compositor
            .resize_with(60, 24, None, &mut Reflow)
            .unwrap();
        let ring: Vec<String> = compositor
            .replay_buffer()
            .iter()
            .map(Row::plain_text)
            .collect();
        assert_eq!(ring, ["row 0 at 60", "row 1 at 60", "row 2 at 60"]);
    }

    #[test]
    fn purge_honours_the_replay_cap() {
        let mut compositor = Compositor::new(
            Vec::new(),
            caps(),
            40,
            24,
            Config {
                region_height: 3,
                resize_mode: ResizeMode::Purge,
                replay_cap: 2,
            },
        )
        .unwrap();
        let mut source: Vec<Row> = (0..500).map(|n| Row::text(format!("line {n}"))).collect();
        compositor
            .resize_with(40, 24, None, &mut source)
            .unwrap();
        assert_eq!(compositor.metrics().replayed_rows, 2);
    }

    #[test]
    fn a_conservative_compositor_ignores_its_replay_source_entirely() {
        let mut compositor = compositor(3);
        let _ = drain(&mut compositor);
        compositor
            .resize_with(60, 30, None, &mut Reflow)
            .unwrap();
        let output = drain(&mut compositor);
        assert!(!output.contains("\x1b[3J"), "{output:?}");
        assert!(!output.contains("row 0"), "{output:?}");
        assert_eq!(compositor.metrics().purges, 0);
        assert_eq!(compositor.metrics().resizes, 1);
    }

    #[test]
    fn the_replay_ring_is_capped() {
        let mut compositor = Compositor::new(
            Vec::new(),
            caps(),
            40,
            24,
            Config {
                region_height: 3,
                replay_cap: 10,
                ..Config::default()
            },
        )
        .unwrap();
        for step in 0..100 {
            compositor.commit(Row::text(format!("line {step}")));
        }
        let _ = render(&mut compositor, &[]);
        assert_eq!(compositor.replay_buffer().len(), 10);
        assert_eq!(
            compositor.replay_buffer().back().unwrap().plain_text(),
            "line 99"
        );
    }

    #[test]
    fn finishing_erases_the_region_and_restores_the_cursor() {
        let mut compositor = compositor(3);
        let _ = render(&mut compositor, &[Row::text("live")]);
        compositor.finish().unwrap();
        let output = drain(&mut compositor);
        assert!(output.contains("\x1b[0J"));
        assert!(output.ends_with("\x1b[?25h"));
    }

    #[test]
    fn the_caret_lands_inside_the_region() {
        let mut compositor = compositor(4);
        let _ = drain(&mut compositor);
        compositor
            .render(&Frame {
                rows: &[Row::text("> hello")],
                cursor: Some((7, 0)),
            })
            .unwrap();
        let output = drain(&mut compositor);
        let expected = format!("\x1b[{};8H", compositor.region_top());
        assert!(output.contains(&expected), "{output:?}");
        assert!(output.contains("\x1b[?25h"));
    }

    #[test]
    fn rows_beyond_the_region_height_are_dropped_not_scrolled() {
        let mut compositor = compositor(2);
        let _ = drain(&mut compositor);
        let output = render(&mut compositor, &[
            Row::text("one"),
            Row::text("two"),
            Row::text("three"),
        ]);
        assert!(output.contains("one") && output.contains("two"));
        assert!(!output.contains("three"), "{output:?}");
    }

    /// Every absolute cursor move in `output`, as 1-indexed rows.
    fn cursor_rows(output: &str) -> Vec<u16> {
        let mut rows = Vec::new();
        let bytes = output.as_bytes();
        let mut index = 0;
        while index + 2 < bytes.len() {
            if bytes[index] != 0x1b || bytes[index + 1] != b'[' {
                index += 1;
                continue;
            }
            let start = index + 2;
            let mut end = start;
            while end < bytes.len() && !(0x40..=0x7e).contains(&bytes[end]) {
                end += 1;
            }
            if end < bytes.len() && bytes[end] == b'H' {
                let params = &output[start..end];
                let row = params.split(';').next().unwrap_or("");
                if let Ok(row) = row.parse::<u16>() {
                    rows.push(row);
                }
            }
            index = end.max(index + 1);
        }
        rows
    }
}
