//! The queue/steer state machine (DESIGN.md §0.2).
//!
//! The owner decision this implements: **queue by default, steer explicitly.**
//!
//! - `Enter` while a turn is running *queues*. The queue is visible above the
//!   composer and auto-submits when the turn ends.
//! - `Ctrl+S` *flushes* the queue into the running turn as steering, delivered
//!   at the next tool boundary.
//! - `Esc` pops the most recent queued entry back into the composer
//!   (see [`super::esc`]).
//!
//! Evidence, from DESIGN.md: grok-build shipped bare-key mid-turn steering and
//! migrated off it, because a mid-turn message is ambiguous between "also do
//! this" and "stop that". Making the steer explicit removes the ambiguity.
//!
//! # Two decisions this file makes that DESIGN.md leaves open
//!
//! 1. **Turn end submits one entry, not all of them.** Each `Enter` was a
//!    distinct message; concatenating them would merge two prompts into one turn
//!    and lose the user's own framing. The rest stay queued and go out at the
//!    end of the turn they cause.
//! 2. **Cancel keeps the queue and does not auto-submit.** A cancel is the user
//!    stopping the machine; firing the queue into the silence afterwards is the
//!    opposite of what they asked for. The queue stays visible and one `Enter`
//!    or `Esc` disposes of it deliberately.

use std::collections::VecDeque;

use super::composer::Submission;

/// Whether a turn is in flight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TurnPhase {
    /// No turn running. A submission is sent immediately.
    #[default]
    Idle,
    /// A turn is running. A submission is queued.
    Streaming,
}

/// What the caller must do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueueEffect {
    /// Send this as a new turn.
    Send(Submission),
    /// Held in the queue, which is now `depth` deep.
    Queued {
        /// Queue depth after the push.
        depth: usize,
    },
    /// Deliver these as steering into the running turn, in order.
    Steer(Vec<Submission>),
    /// Nothing to do.
    Nothing,
}

/// The machine.
#[derive(Debug, Default)]
pub struct QueueMachine {
    phase: TurnPhase,
    queue: VecDeque<Submission>,
}

impl QueueMachine {
    /// An idle machine with an empty queue.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Current phase.
    #[must_use]
    pub const fn phase(&self) -> TurnPhase {
        self.phase
    }

    /// Whether a turn is running.
    #[must_use]
    pub fn is_streaming(&self) -> bool {
        self.phase == TurnPhase::Streaming
    }

    /// Queued entries, oldest first.
    pub fn entries(&self) -> impl Iterator<Item = &Submission> {
        self.queue.iter()
    }

    /// Queue depth.
    #[must_use]
    pub fn depth(&self) -> usize {
        self.queue.len()
    }

    /// Whether the queue is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    /// A submission arrived from the composer.
    pub fn submit(&mut self, submission: Submission) -> QueueEffect {
        match self.phase {
            TurnPhase::Idle => {
                // Optimistic: the phase flips locally so the *next* `Enter`
                // queues without waiting for the daemon to confirm the turn.
                // DESIGN.md §1 calls this local-echo latency and it is the whole
                // reason the client owns state.
                self.phase = TurnPhase::Streaming;
                QueueEffect::Send(submission)
            }
            TurnPhase::Streaming => {
                self.queue.push_back(submission);
                QueueEffect::Queued {
                    depth: self.queue.len(),
                }
            }
        }
    }

    /// `Ctrl+S`: flush the queue into the running turn.
    ///
    /// `pending` is whatever the composer holds right now; it goes out last, so
    /// `Ctrl+S` with an empty queue still steers what the user just typed.
    /// Steering an idle session is meaningless and yields
    /// [`QueueEffect::Nothing`] — the caller should send instead.
    pub fn steer(&mut self, pending: Option<Submission>) -> QueueEffect {
        if self.phase != TurnPhase::Streaming {
            return QueueEffect::Nothing;
        }
        let mut batch: Vec<Submission> = self.queue.drain(..).collect();
        batch.extend(pending);
        if batch.is_empty() {
            return QueueEffect::Nothing;
        }
        QueueEffect::Steer(batch)
    }

    /// The daemon confirmed a turn is running.
    pub const fn turn_started(&mut self) {
        self.phase = TurnPhase::Streaming;
    }

    /// The turn ended normally. Auto-submits the head of the queue.
    pub fn turn_ended(&mut self) -> QueueEffect {
        match self.queue.pop_front() {
            Some(next) => {
                self.phase = TurnPhase::Streaming;
                QueueEffect::Send(next)
            }
            None => {
                self.phase = TurnPhase::Idle;
                QueueEffect::Nothing
            }
        }
    }

    /// The turn was cancelled. The queue is kept and nothing is sent.
    pub const fn turn_cancelled(&mut self) {
        self.phase = TurnPhase::Idle;
    }

    /// Pop the most recently queued entry, for the Esc ladder.
    pub fn pop_last(&mut self) -> Option<Submission> {
        self.queue.pop_back()
    }

    /// Drop everything queued.
    pub fn clear(&mut self) {
        self.queue.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::composer::ComposerMode;

    fn submission(text: &str) -> Submission {
        Submission {
            text: text.to_owned(),
            mode: ComposerMode::Prompt,
        }
    }

    // -- idle × empty ------------------------------------------------------

    #[test]
    fn idle_and_empty_sends_immediately_and_becomes_streaming() {
        let mut machine = QueueMachine::new();
        assert_eq!(machine.phase(), TurnPhase::Idle);
        assert_eq!(
            machine.submit(submission("one")),
            QueueEffect::Send(submission("one"))
        );
        assert_eq!(machine.phase(), TurnPhase::Streaming);
        assert!(machine.is_empty());
    }

    #[test]
    fn steering_an_idle_session_does_nothing() {
        let mut machine = QueueMachine::new();
        assert_eq!(machine.steer(Some(submission("hi"))), QueueEffect::Nothing);
        assert_eq!(machine.steer(None), QueueEffect::Nothing);
    }

    #[test]
    fn ending_an_idle_turn_with_an_empty_queue_settles_at_idle() {
        let mut machine = QueueMachine::new();
        assert_eq!(machine.turn_ended(), QueueEffect::Nothing);
        assert_eq!(machine.phase(), TurnPhase::Idle);
    }

    // -- streaming × empty -------------------------------------------------

    #[test]
    fn streaming_and_empty_queues_the_submission() {
        let mut machine = QueueMachine::new();
        machine.turn_started();
        assert_eq!(
            machine.submit(submission("later")),
            QueueEffect::Queued { depth: 1 }
        );
        assert_eq!(machine.depth(), 1);
    }

    #[test]
    fn ctrl_s_with_an_empty_queue_steers_what_is_in_the_composer() {
        let mut machine = QueueMachine::new();
        machine.turn_started();
        assert_eq!(
            machine.steer(Some(submission("actually, stop"))),
            QueueEffect::Steer(vec![submission("actually, stop")])
        );
    }

    #[test]
    fn ctrl_s_with_nothing_at_all_does_nothing() {
        let mut machine = QueueMachine::new();
        machine.turn_started();
        assert_eq!(machine.steer(None), QueueEffect::Nothing);
    }

    // -- streaming × nonempty ----------------------------------------------

    #[test]
    fn several_submissions_queue_in_order() {
        let mut machine = QueueMachine::new();
        machine.submit(submission("first"));
        for (index, text) in ["a", "b", "c"].iter().enumerate() {
            assert_eq!(
                machine.submit(submission(text)),
                QueueEffect::Queued { depth: index + 1 }
            );
        }
        let texts: Vec<_> = machine.entries().map(|item| item.text.as_str()).collect();
        assert_eq!(texts, ["a", "b", "c"]);
    }

    #[test]
    fn ctrl_s_flushes_the_whole_queue_with_the_composer_last() {
        let mut machine = QueueMachine::new();
        machine.turn_started();
        machine.submit(submission("a"));
        machine.submit(submission("b"));
        assert_eq!(
            machine.steer(Some(submission("and also c"))),
            QueueEffect::Steer(vec![
                submission("a"),
                submission("b"),
                submission("and also c")
            ])
        );
        assert!(machine.is_empty(), "a flush drains the queue");
    }

    #[test]
    fn turn_end_auto_submits_one_entry_and_keeps_the_rest() {
        let mut machine = QueueMachine::new();
        machine.turn_started();
        machine.submit(submission("a"));
        machine.submit(submission("b"));
        assert_eq!(machine.turn_ended(), QueueEffect::Send(submission("a")));
        assert_eq!(
            machine.phase(),
            TurnPhase::Streaming,
            "the auto-submitted entry starts the next turn"
        );
        assert_eq!(machine.depth(), 1);
        assert_eq!(machine.turn_ended(), QueueEffect::Send(submission("b")));
        assert_eq!(machine.turn_ended(), QueueEffect::Nothing);
        assert_eq!(machine.phase(), TurnPhase::Idle);
    }

    // -- idle × nonempty ---------------------------------------------------

    #[test]
    fn cancelling_keeps_the_queue_and_sends_nothing() {
        let mut machine = QueueMachine::new();
        machine.turn_started();
        machine.submit(submission("a"));
        machine.turn_cancelled();
        assert_eq!(machine.phase(), TurnPhase::Idle);
        assert_eq!(machine.depth(), 1, "a cancel must not throw the queue away");
    }

    #[test]
    fn submitting_after_a_cancel_sends_rather_than_queueing() {
        let mut machine = QueueMachine::new();
        machine.turn_started();
        machine.submit(submission("queued"));
        machine.turn_cancelled();
        assert_eq!(
            machine.submit(submission("new")),
            QueueEffect::Send(submission("new"))
        );
        assert_eq!(machine.depth(), 1);
    }

    // -- esc interaction ---------------------------------------------------

    #[test]
    fn pop_last_returns_the_most_recent_entry_for_editing() {
        let mut machine = QueueMachine::new();
        machine.turn_started();
        machine.submit(submission("a"));
        machine.submit(submission("b"));
        assert_eq!(machine.pop_last(), Some(submission("b")));
        assert_eq!(machine.pop_last(), Some(submission("a")));
        assert_eq!(machine.pop_last(), None);
    }

    #[test]
    fn a_queued_bash_command_keeps_its_mode() {
        let mut machine = QueueMachine::new();
        machine.turn_started();
        let bash = Submission {
            text: "ls -la".to_owned(),
            mode: ComposerMode::Bash,
        };
        machine.submit(bash.clone());
        assert_eq!(machine.turn_ended(), QueueEffect::Send(bash));
    }
}
