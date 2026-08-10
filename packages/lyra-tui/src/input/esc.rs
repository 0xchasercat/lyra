//! The Esc ladder — DESIGN.md §4's "one ordered function".
//!
//! > **Esc policy is one ordered function** — overlay dismiss → composer clear
//! > (armed) → cancel turn → rewind (armed) — documented order, no fall-through
//! > surprises.
//!
//! # The order, as implemented
//!
//! Exactly these steps, tried top to bottom. The first one that applies runs and
//! the function returns; there is **no** fall-through past the list, and an Esc
//! that reaches the end returns [`EscStep::Ignored`] rather than doing something
//! surprising.
//!
//! | # | condition | step |
//! |---|---|---|
//! | 1 | an overlay is open | dismiss it |
//! | 2 | the completion popup is open | dismiss it |
//! | 3 | the composer is non-empty | **armed** clear: first press arms and shows a hint, second press clears |
//! | 4 | the queue is non-empty | pop the most recent queued entry back into the composer |
//! | 5 | a turn is running | cancel it, keeping partial output |
//! | 6 | the last turn can be rewound | **armed** rewind: first press arms, second rewinds |
//!
//! Steps 1–2 are DESIGN.md's "overlay dismiss" split in two, because a
//! completion popup and a full overlay are different surfaces with different
//! owners. Steps 5–6 are DESIGN.md's "cancel turn → rewind (armed)" verbatim.
//!
//! **Step 4 is the one addition**, and it is placed deliberately. The queue is
//! composer-adjacent state — text the user typed that has not been sent — so the
//! ladder reads as one idea from top to bottom: *undo my most recent input
//! intent, then stop the machine.* Putting it after cancel would mean a user
//! could never edit a queued entry without first killing the turn. `Esc` still
//! reaches cancel in one more press once the queue drains, and `Ctrl+C` cancels
//! unconditionally at any depth.
//!
//! # Arming
//!
//! Two steps are destructive and therefore two-press: clearing a composed
//! prompt, and rewinding a turn. Arming is visible — [`EscLadder::hint`] returns
//! the text the composer shows — and it expires, so an Esc pressed a minute ago
//! cannot silently make the next one destructive. **Any other key disarms**, via
//! [`EscLadder::disarm`].
//!
//! # The mash
//!
//! A ladder alone is not enough, because the gesture users actually make when a
//! turn is going wrong is not one Esc — it is five. Walked at mash speed the
//! ordered function is a chain: the first press cancels, and the ones still
//! arriving fall through to *the next rung*, arming and confirming something
//! destructive inside a single burst the user experienced as one gesture. That
//! is how a cancel became a rewind that replayed a whole session.
//!
//! So the ladder is deaf for [`MASH_GRACE`] after any rung **acts**, and the
//! same window is the floor on confirming an arm: a press cannot confirm a
//! destructive rung it armed less than [`MASH_GRACE`] ago, because the hint
//! naming what the next press will do had not yet been on screen when it was
//! made. Pressing again inside that window re-stamps the arm rather than
//! confirming it, so *holding* Esc down never clears or rewinds anything. Both
//! rules key off consecutive Esc presses only — [`EscLadder::disarm`], which
//! every other key calls, ends the burst.

use std::time::{Duration, Instant};

/// How long an armed Esc stays armed.
///
/// Long enough for a deliberate second press, short enough that it cannot be
/// confused with a fresh one. DESIGN.md §3's "transient hints display ≥700ms"
/// sets the floor.
pub const ARM_WINDOW: Duration = Duration::from_millis(2000);

/// The frustration-mash grace: how long the ladder ignores Esc after a rung has
/// acted, and how long an arm must have stood before a press may confirm it.
///
/// One constant for both because it is one number: the length of a burst. Key
/// repeat is ~30/s and a two-handed panic mash is faster still, so anything
/// inside 450ms of the last Esc is the same gesture, not a new decision. Above
/// it, a press is deliberate — which is exactly the property the destructive
/// rungs need, and the reason arming and confirming can no longer happen in one
/// burst.
pub const MASH_GRACE: Duration = Duration::from_millis(450);

/// The state the ladder inspects and mutates.
///
/// This is the seam with the session store and the surrounding app: everything
/// the ladder needs, and nothing else. Phase 3's store and phase 6's app
/// implement it; `TestWorld` in this module's tests is the reference
/// implementation of the contract.
pub trait EscWorld {
    /// Whether a full overlay (cheatsheet, palette, picker) is open.
    fn overlay_open(&self) -> bool;
    /// Close the topmost overlay.
    fn dismiss_overlay(&mut self);

    /// Whether the `@`/`/` completion popup is open.
    fn completion_open(&self) -> bool;
    /// Close the completion popup.
    fn dismiss_completion(&mut self);

    /// Whether the composer holds anything.
    fn composer_is_empty(&self) -> bool;
    /// Empty the composer.
    fn clear_composer(&mut self);

    /// How many submissions are queued.
    fn queue_depth(&self) -> usize;
    /// Pop the most recent queued entry back into the composer.
    fn pop_queue_into_composer(&mut self);

    /// Whether a turn is streaming or retrying.
    fn turn_running(&self) -> bool;
    /// Cancel it, keeping partial output (DESIGN.md §0.2).
    fn cancel_turn(&mut self);

    /// Whether the previous turn can be rewound into the composer.
    fn can_rewind(&self) -> bool;
    /// Rewind: restore the last prompt into the composer and trim the turn.
    fn rewind(&mut self);
}

/// One rung of the ladder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EscStep {
    /// An overlay was (or would be) dismissed.
    DismissOverlay,
    /// The completion popup was (or would be) dismissed.
    DismissCompletion,
    /// First press on a non-empty composer: armed, hint shown, nothing cleared.
    ArmComposerClear,
    /// Second press: the composer was cleared.
    ClearComposer,
    /// The most recent queued entry went back into the composer.
    PopQueue,
    /// The running turn was cancelled.
    CancelTurn,
    /// First press with a rewindable turn: armed, hint shown.
    ArmRewind,
    /// Second press: the turn was rewound.
    Rewind,
    /// Nothing applied. Esc did nothing at all.
    Ignored,
    /// The press landed inside [`MASH_GRACE`] of a rung that had just acted, and
    /// was dropped without consulting the ladder at all. Distinct from
    /// [`EscStep::Ignored`], which means the ladder was consulted and had
    /// nothing to offer.
    Swallowed,
}

impl EscStep {
    /// Whether the step only armed something rather than doing it.
    #[must_use]
    pub const fn is_arming(self) -> bool {
        matches!(self, Self::ArmComposerClear | Self::ArmRewind)
    }

    /// Whether the step changed the world — the steps that start the grace.
    #[must_use]
    pub const fn is_action(self) -> bool {
        matches!(
            self,
            Self::DismissOverlay
                | Self::DismissCompletion
                | Self::ClearComposer
                | Self::PopQueue
                | Self::CancelTurn
                | Self::Rewind
        )
    }
}

/// What is currently armed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Armed {
    ComposerClear,
    Rewind,
}

/// The ladder.
#[derive(Debug, Clone, Default)]
pub struct EscLadder {
    armed: Option<(Armed, Instant)>,
    /// When a rung last acted. The grace is measured from here.
    acted: Option<Instant>,
}

impl EscLadder {
    /// A disarmed ladder.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            armed: None,
            acted: None,
        }
    }

    /// The hint the composer should show, if anything is armed.
    ///
    /// Shown the moment the arm is made, even though the arm cannot be confirmed
    /// for another [`MASH_GRACE`]: that is the point of the delay — the hint gets
    /// to be on screen before the press that acts on it is allowed to count.
    #[must_use]
    pub const fn hint(&self) -> Option<&'static str> {
        match self.armed {
            Some((Armed::ComposerClear, _)) => Some("esc again to clear"),
            Some((Armed::Rewind, _)) => Some("esc again to rewind"),
            None => None,
        }
    }

    /// Whether anything is armed.
    #[must_use]
    pub const fn is_armed(&self) -> bool {
        self.armed.is_some()
    }

    /// Disarm, and end the Esc burst. **Every non-Esc key must call this**,
    /// which is what makes the two-press gesture a gesture rather than a trap —
    /// and what keeps the mash grace a property of *consecutive* Esc presses
    /// rather than a 450ms deafness the whole app has to wait out.
    pub const fn disarm(&mut self) {
        self.armed = None;
        self.acted = None;
    }

    /// What the next Esc would do, without doing it.
    ///
    /// Drives the contextual hint line: the `esc` hint can say `cancel`,
    /// `unqueue` or `clear` because it asks the same function the keypress will.
    /// The grace is deliberately *not* applied here — it changes for how long a
    /// press is dropped, never what the key means — so the hint does not flicker
    /// blank for half a second after every cancel.
    #[must_use]
    pub fn peek(&self, world: &dyn EscWorld, now: Instant) -> EscStep {
        self.resolve(world, self.confirmable_arm(now))
    }

    /// Press Esc.
    pub fn press(&mut self, world: &mut dyn EscWorld, now: Instant) -> EscStep {
        if self.in_grace(now) {
            return EscStep::Swallowed;
        }
        let step = self.resolve(world, self.confirmable_arm(now));
        match step {
            // Re-stamped rather than left standing, so a press that arrives too
            // soon to confirm pushes the confirmation further out instead of
            // counting towards it: a held Esc key can never clear or rewind.
            EscStep::ArmComposerClear => self.armed = Some((Armed::ComposerClear, now)),
            EscStep::ArmRewind => self.armed = Some((Armed::Rewind, now)),
            // Acted, or found nothing to act on: either way the arm is spent.
            _ => self.armed = None,
        }
        // The one place the grace begins. [`EscStep::is_action`] is the whole
        // rule, so a rung added below cannot forget to start it.
        if step.is_action() {
            self.acted = Some(now);
        }
        match step {
            EscStep::DismissOverlay => world.dismiss_overlay(),
            EscStep::DismissCompletion => world.dismiss_completion(),
            EscStep::ClearComposer => world.clear_composer(),
            EscStep::PopQueue => world.pop_queue_into_composer(),
            EscStep::CancelTurn => world.cancel_turn(),
            EscStep::Rewind => world.rewind(),
            EscStep::ArmComposerClear
            | EscStep::ArmRewind
            | EscStep::Ignored
            | EscStep::Swallowed => {}
        }
        step
    }

    /// Whether this press is part of the burst that a rung has already answered.
    fn in_grace(&self, now: Instant) -> bool {
        self.acted
            .is_some_and(|at| now.saturating_duration_since(at) < MASH_GRACE)
    }

    /// The arm a press may act on: still within [`ARM_WINDOW`], and old enough
    /// that its hint had a frame to be seen in.
    fn confirmable_arm(&self, now: Instant) -> Option<Armed> {
        let (armed, at) = self.armed?;
        let age = now.saturating_duration_since(at);
        (age >= MASH_GRACE && age <= ARM_WINDOW).then_some(armed)
    }

    /// **The ordered function.** Every Esc decision in the TUI is this list.
    fn resolve(&self, world: &dyn EscWorld, armed: Option<Armed>) -> EscStep {
        // 1. overlay
        if world.overlay_open() {
            return EscStep::DismissOverlay;
        }
        // 2. completion popup
        if world.completion_open() {
            return EscStep::DismissCompletion;
        }
        // 3. composer clear (armed)
        if !world.composer_is_empty() {
            return if armed == Some(Armed::ComposerClear) {
                EscStep::ClearComposer
            } else {
                EscStep::ArmComposerClear
            };
        }
        // 4. unqueue
        if world.queue_depth() > 0 {
            return EscStep::PopQueue;
        }
        // 5. cancel the turn
        if world.turn_running() {
            return EscStep::CancelTurn;
        }
        // 6. rewind (armed)
        if world.can_rewind() {
            return if armed == Some(Armed::Rewind) {
                EscStep::Rewind
            } else {
                EscStep::ArmRewind
            };
        }
        // No fall-through past this point. This is the whole ladder.
        EscStep::Ignored
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reference implementation of [`EscWorld`].
    #[derive(Debug, Default)]
    struct TestWorld {
        overlay: bool,
        completion: bool,
        composer: String,
        queue: Vec<String>,
        running: bool,
        rewindable: bool,
        log: Vec<&'static str>,
    }

    impl EscWorld for TestWorld {
        fn overlay_open(&self) -> bool {
            self.overlay
        }
        fn dismiss_overlay(&mut self) {
            self.overlay = false;
            self.log.push("dismiss-overlay");
        }
        fn completion_open(&self) -> bool {
            self.completion
        }
        fn dismiss_completion(&mut self) {
            self.completion = false;
            self.log.push("dismiss-completion");
        }
        fn composer_is_empty(&self) -> bool {
            self.composer.is_empty()
        }
        fn clear_composer(&mut self) {
            self.composer.clear();
            self.log.push("clear-composer");
        }
        fn queue_depth(&self) -> usize {
            self.queue.len()
        }
        fn pop_queue_into_composer(&mut self) {
            if let Some(text) = self.queue.pop() {
                self.composer = text;
            }
            self.log.push("pop-queue");
        }
        fn turn_running(&self) -> bool {
            self.running
        }
        fn cancel_turn(&mut self) {
            self.running = false;
            self.log.push("cancel-turn");
        }
        fn can_rewind(&self) -> bool {
            self.rewindable
        }
        fn rewind(&mut self) {
            self.rewindable = false;
            self.composer = "rewound prompt".to_owned();
            self.log.push("rewind");
        }
    }

    fn now() -> Instant {
        Instant::now()
    }

    /// A deliberate gap between presses: longer than [`MASH_GRACE`], so each
    /// press is its own decision rather than part of one burst.
    const DELIBERATE: Duration = Duration::from_millis(500);

    /// A mash gap: two presses of the same panicked gesture.
    const MASHED: Duration = Duration::from_millis(30);

    // -- step 1 ------------------------------------------------------------

    #[test]
    fn an_open_overlay_wins_over_everything_below_it() {
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            overlay: true,
            completion: true,
            composer: "typed".to_owned(),
            queue: vec!["queued".to_owned()],
            running: true,
            rewindable: true,
            ..TestWorld::default()
        };
        assert_eq!(ladder.press(&mut world, now()), EscStep::DismissOverlay);
        assert_eq!(world.log, ["dismiss-overlay"]);
        assert!(world.running, "nothing below step 1 ran");
    }

    // -- step 2 ------------------------------------------------------------

    #[test]
    fn the_completion_popup_is_dismissed_before_the_composer_is_touched() {
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            completion: true,
            composer: "@src".to_owned(),
            ..TestWorld::default()
        };
        assert_eq!(ladder.press(&mut world, now()), EscStep::DismissCompletion);
        assert_eq!(world.composer, "@src", "the text survives");
    }

    // -- step 3 ------------------------------------------------------------

    #[test]
    fn clearing_a_composed_prompt_takes_two_presses_and_shows_a_hint() {
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            composer: "half a thought".to_owned(),
            ..TestWorld::default()
        };
        let start = now();
        assert_eq!(ladder.press(&mut world, start), EscStep::ArmComposerClear);
        assert_eq!(world.composer, "half a thought", "the first press is safe");
        assert_eq!(ladder.hint(), Some("esc again to clear"));
        assert_eq!(
            ladder.press(&mut world, start + DELIBERATE),
            EscStep::ClearComposer
        );
        assert!(world.composer.is_empty());
        assert_eq!(ladder.hint(), None);
    }

    #[test]
    fn an_expired_arm_re_arms_rather_than_clearing() {
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            composer: "text".to_owned(),
            ..TestWorld::default()
        };
        let start = now();
        ladder.press(&mut world, start);
        assert_eq!(
            ladder.press(&mut world, start + ARM_WINDOW + Duration::from_millis(1)),
            EscStep::ArmComposerClear,
            "an Esc from a minute ago cannot make this one destructive"
        );
        assert_eq!(world.composer, "text");
    }

    #[test]
    fn any_other_key_disarms() {
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            composer: "text".to_owned(),
            ..TestWorld::default()
        };
        let start = now();
        ladder.press(&mut world, start);
        ladder.disarm();
        assert_eq!(ladder.hint(), None);
        assert_eq!(
            ladder.press(&mut world, start + Duration::from_millis(10)),
            EscStep::ArmComposerClear
        );
        assert_eq!(world.composer, "text");
    }

    // -- step 4 ------------------------------------------------------------

    #[test]
    fn esc_on_an_empty_composer_pops_the_most_recent_queued_entry() {
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            queue: vec!["first".to_owned(), "second".to_owned()],
            running: true,
            ..TestWorld::default()
        };
        assert_eq!(ladder.press(&mut world, now()), EscStep::PopQueue);
        assert_eq!(world.composer, "second");
        assert_eq!(world.queue, ["first"]);
        assert!(world.running, "unqueueing does not cancel");
    }

    #[test]
    fn the_queue_drains_one_press_at_a_time_then_esc_reaches_cancel() {
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            queue: vec!["only".to_owned()],
            running: true,
            ..TestWorld::default()
        };
        let start = now();
        let at = |step: u32| start + DELIBERATE * step;
        assert_eq!(ladder.press(&mut world, at(0)), EscStep::PopQueue);
        // The popped entry is now in the composer, so the ladder is back at
        // step 3 — which is the point: the user is editing it.
        assert_eq!(ladder.press(&mut world, at(1)), EscStep::ArmComposerClear);
        assert_eq!(ladder.press(&mut world, at(2)), EscStep::ClearComposer);
        assert_eq!(ladder.press(&mut world, at(3)), EscStep::CancelTurn);
    }

    // -- step 5 ------------------------------------------------------------

    #[test]
    fn esc_cancels_a_running_turn_when_nothing_above_applies() {
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            running: true,
            ..TestWorld::default()
        };
        assert_eq!(ladder.press(&mut world, now()), EscStep::CancelTurn);
        assert!(!world.running);
        assert_eq!(world.log, ["cancel-turn"]);
    }

    // -- step 6 ------------------------------------------------------------

    #[test]
    fn rewinding_takes_two_presses_and_is_the_last_rung() {
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            rewindable: true,
            ..TestWorld::default()
        };
        let start = now();
        assert_eq!(ladder.press(&mut world, start), EscStep::ArmRewind);
        assert_eq!(ladder.hint(), Some("esc again to rewind"));
        assert_eq!(ladder.press(&mut world, start + DELIBERATE), EscStep::Rewind);
        assert_eq!(world.composer, "rewound prompt");
    }

    #[test]
    fn esc_esc_after_a_cancel_is_cancel_then_rewind() {
        // DESIGN.md §0.2: "Esc → cancel turn, keep partial output, marked.
        // Esc Esc → rewind." Three deliberate presses, not one burst: the
        // gesture the design describes is a decision taken three times.
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            running: true,
            rewindable: true,
            ..TestWorld::default()
        };
        let start = now();
        let at = |step: u32| start + DELIBERATE * step;
        assert_eq!(ladder.press(&mut world, at(0)), EscStep::CancelTurn);
        assert_eq!(ladder.press(&mut world, at(1)), EscStep::ArmRewind);
        assert_eq!(ladder.press(&mut world, at(2)), EscStep::Rewind);
    }

    // -- the end of the ladder ---------------------------------------------

    #[test]
    fn esc_with_nothing_to_do_does_nothing() {
        let mut ladder = EscLadder::new();
        let mut world = TestWorld::default();
        assert_eq!(ladder.press(&mut world, now()), EscStep::Ignored);
        assert!(world.log.is_empty(), "no fall-through past the last rung");
    }

    // -- peek --------------------------------------------------------------

    #[test]
    fn peek_reports_the_next_step_without_taking_it() {
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            running: true,
            composer: "typed".to_owned(),
            ..TestWorld::default()
        };
        let start = now();
        assert_eq!(ladder.peek(&world, start), EscStep::ArmComposerClear);
        assert_eq!(world.composer, "typed", "peek is pure");
        ladder.press(&mut world, start);
        assert_eq!(
            ladder.peek(&world, start + DELIBERATE),
            EscStep::ClearComposer,
            "peek accounts for the arm"
        );
    }

    #[test]
    fn the_whole_ladder_is_walked_in_order_by_repeated_presses() {
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            overlay: true,
            completion: true,
            composer: "typed".to_owned(),
            queue: vec!["queued".to_owned()],
            running: true,
            rewindable: true,
            ..TestWorld::default()
        };
        let start = now();
        let mut steps = Vec::new();
        for step in 0..10 {
            steps.push(ladder.press(&mut world, start + DELIBERATE * step));
        }
        assert_eq!(
            steps,
            [
                EscStep::DismissOverlay,
                EscStep::DismissCompletion,
                EscStep::ArmComposerClear,
                EscStep::ClearComposer,
                EscStep::PopQueue,
                // the popped entry is text again
                EscStep::ArmComposerClear,
                EscStep::ClearComposer,
                EscStep::CancelTurn,
                EscStep::ArmRewind,
                EscStep::Rewind,
            ]
        );
    }

    // -- the mash ----------------------------------------------------------

    #[test]
    fn a_mash_of_five_escapes_during_a_turn_cancels_once_and_does_nothing_else() {
        // The live defect: a user whose turn was going wrong pressed Esc five
        // times "to cancel", and the presses the cancel did not consume walked
        // on down the ladder into a rewind nobody asked for.
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            running: true,
            rewindable: true,
            ..TestWorld::default()
        };
        let start = now();
        let mut steps = Vec::new();
        for step in 0..5 {
            steps.push(ladder.press(&mut world, start + MASHED * step));
        }
        assert_eq!(
            steps,
            [
                EscStep::CancelTurn,
                EscStep::Swallowed,
                EscStep::Swallowed,
                EscStep::Swallowed,
                EscStep::Swallowed,
            ]
        );
        assert_eq!(world.log, ["cancel-turn"], "exactly one action");
        assert!(world.rewindable, "the rewind rung was never reached");
        assert_eq!(ladder.hint(), None, "and nothing was left armed");
    }

    #[test]
    fn a_deliberate_press_a_pause_then_esc_esc_still_rewinds() {
        // The other half of the contract: protection from the mash must not cost
        // the user the gesture the design document promises.
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            running: true,
            rewindable: true,
            ..TestWorld::default()
        };
        let start = now();
        assert_eq!(ladder.press(&mut world, start), EscStep::CancelTurn);
        let after = start + Duration::from_secs(1);
        assert_eq!(ladder.press(&mut world, after), EscStep::ArmRewind);
        assert_eq!(ladder.hint(), Some("esc again to rewind"));
        assert_eq!(
            ladder.press(&mut world, after + DELIBERATE),
            EscStep::Rewind
        );
        assert_eq!(world.log, ["cancel-turn", "rewind"]);
    }

    #[test]
    fn a_destructive_rung_cannot_be_armed_and_confirmed_in_one_burst() {
        // Arming is not acting, so it starts no grace — but the arm carries its
        // own floor, and a press that beats it re-stamps the arm rather than
        // confirming it. Holding Esc down therefore never clears anything.
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            composer: "a prompt worth keeping".to_owned(),
            ..TestWorld::default()
        };
        let start = now();
        let mut steps = Vec::new();
        for step in 0..6 {
            steps.push(ladder.press(&mut world, start + MASHED * step));
        }
        assert!(
            steps.iter().all(|step| *step == EscStep::ArmComposerClear),
            "{steps:?}"
        );
        assert_eq!(world.composer, "a prompt worth keeping");
        // …and the arm is still standing, so one deliberate press finishes it.
        assert_eq!(
            ladder.press(&mut world, start + MASHED * 5 + DELIBERATE),
            EscStep::ClearComposer
        );
    }

    #[test]
    fn the_grace_covers_every_rung_that_acts_not_only_cancel() {
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            overlay: true,
            queue: vec!["queued".to_owned()],
            running: true,
            ..TestWorld::default()
        };
        let start = now();
        assert_eq!(ladder.press(&mut world, start), EscStep::DismissOverlay);
        assert_eq!(
            ladder.press(&mut world, start + MASHED),
            EscStep::Swallowed,
            "dismissing an overlay is an action like any other"
        );
        assert_eq!(world.queue.len(), 1, "the queue was not touched");
    }

    #[test]
    fn any_other_key_ends_the_burst_as_well_as_the_arm() {
        // The grace is a property of consecutive Esc presses. A user who cancels
        // and then types is no longer mashing, and must not find Esc dead.
        let mut ladder = EscLadder::new();
        let mut world = TestWorld {
            running: true,
            queue: vec!["queued".to_owned()],
            ..TestWorld::default()
        };
        let start = now();
        assert_eq!(ladder.press(&mut world, start), EscStep::PopQueue);
        ladder.disarm();
        assert_eq!(
            ladder.press(&mut world, start + MASHED),
            EscStep::ArmComposerClear,
            "the popped entry is in the composer again, and Esc still means something"
        );
    }
}
