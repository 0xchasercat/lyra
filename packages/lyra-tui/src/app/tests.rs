//! The app loop, driven by **bytes and frames**, not by synthesized calls.
//!
//! Every keystroke below goes through `input::decode` exactly as `/dev/tty`
//! bytes would, and every daemon event goes through `acp::types` exactly as a
//! wire frame would. That is deliberate: the bug these tests exist to prevent
//! was not a broken component — every component passed its own tests — it was
//! that nothing was *wired to anything*. A test that calls `App::dispatch`
//! directly would have passed against the dead loop too.

use super::*;

use crossbeam_channel::{unbounded, Sender};

use crate::acp::types::{Secret, UpdateNotification};
use crate::input::actor::Router;
use crate::input::history::History;
use crate::keybind::Keymap;
use crate::theme::Theme;
use crate::ui::reliability::SPINNER_FRAMES;
use crate::ui::thinking::ThinkingMode;

/// Records what reached the wire, and hands back scripted answers.
#[derive(Debug, Default)]
struct ScriptedDaemon {
    sent: Vec<Call>,
    answers: Vec<Reply>,
}

impl Daemon for ScriptedDaemon {
    fn send(&mut self, call: Call) {
        self.sent.push(call);
    }
    fn poll(&mut self) -> Vec<Reply> {
        std::mem::take(&mut self.answers)
    }
}

impl ScriptedDaemon {
    fn methods(&self) -> Vec<&'static str> {
        self.sent.iter().map(Call::method).collect()
    }
    fn prompts(&self) -> Vec<&str> {
        self.sent
            .iter()
            .filter_map(|call| match call {
                Call::Prompt(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }
}

fn app() -> App {
    App::new(
        Theme::lyra(),
        Keymap::default(),
        // In-memory history: a test must never write to `~/.lyra`.
        Composer::new(History::in_memory()),
        80,
    )
}

/// Decode terminal bytes into the events the actor would have emitted.
fn typed(bytes: &[u8]) -> Vec<InputEvent> {
    let mut router = Router::new();
    let mut events = Vec::new();
    router.feed(bytes, |event| events.push(event), |_| ());
    // A trailing lone ESC is only the Escape key once the timeout says so.
    router.timeout(|event| events.push(event));
    events
}

/// A canonical `session/update` frame, from its JSON body.
fn update(body: &str) -> AcpEvent {
    let value: serde_json::Value = serde_json::from_str(body).expect("valid update json");
    AcpEvent::Update(Box::new(UpdateNotification {
        session_id: "s-1".to_owned(),
        update: Update::from_json(value),
    }))
}

/// Drive one frame with `bytes` on the keyboard and whatever is on the channel.
fn press(app: &mut App, daemon: &mut ScriptedDaemon, events: &Receiver<AcpEvent>, bytes: &[u8]) {
    tick(app, daemon, typed(bytes), events, Instant::now());
}

/// A gap long enough to be a second decision rather than the same gesture.
///
/// The Esc ladder swallows presses for [`crate::input::esc::MASH_GRACE`] after a
/// rung acts, and will not confirm an arm younger than that, so a test that
/// means "the user pressed Esc, read the hint, and pressed it again" has to say
/// how long they took over it.
const DELIBERATE: Duration = Duration::from_millis(500);

/// As [`press`], at an exact moment. A test about the mash grace has to own the
/// clock: "two ticks in a row" is only a mash if the machine running them was
/// quick, and a test must not depend on that.
fn press_at(
    app: &mut App,
    daemon: &mut ScriptedDaemon,
    events: &Receiver<AcpEvent>,
    bytes: &[u8],
    at: Instant,
) {
    tick(app, daemon, typed(bytes), events, at);
}

/// As [`press`], from the future. The `@` completion debounce is the only thing
/// in the loop that waits on the clock, so a test that wants it to fire has to
/// say so rather than sleep for it.
fn settle(app: &mut App, daemon: &mut ScriptedDaemon, events: &Receiver<AcpEvent>) {
    tick(
        app,
        daemon,
        Vec::new(),
        events,
        Instant::now() + Duration::from_millis(200),
    );
}

fn wire() -> (Sender<AcpEvent>, Receiver<AcpEvent>) {
    unbounded()
}

fn scrollback(app: &mut App) -> String {
    app.take_commits()
        .iter()
        .map(Row::plain_text)
        .collect::<Vec<_>>()
        .join("\n")
}

/// The live region as the loop would draw it — at the height the app asks for,
/// because an overlay borrows rows and a test that clipped them would be
/// asserting against a frame the user never sees.
fn live_text(app: &App) -> String {
    app.live(app.desired_region_height(12), Instant::now())
        .rows
        .iter()
        .map(Row::plain_text)
        .collect::<Vec<_>>()
        .join("\n")
}

/// The activity strip's glyph at a moment in time.
///
/// Found by *shape* rather than by row index: the strip sits under however many
/// live transcript rows there happen to be, and a test that counted them would
/// be asserting about the transcript instead of about the spinner.
fn activity_glyph(app: &App, at: Instant) -> String {
    strip(app, at).0
}

/// The activity strip's glyph and the style it is painted in.
fn strip(app: &App, at: Instant) -> (String, crate::ui::Style) {
    app.live(app.desired_region_height(12), at)
        .rows
        .iter()
        .find_map(|row| {
            let span = row.spans.first()?;
            let glyph = span.text.trim_end();
            let known = SPINNER_FRAMES.contains(&glyph)
                || glyph == Activity::Idle.glyph()
                || glyph == Activity::Streaming.glyph();
            known.then(|| (glyph.to_owned(), span.style))
        })
        .expect("the live region always carries an activity strip")
}

/// Whether the glyph is one of the moving frames, i.e. "a turn is running".
fn spinning(glyph: &str) -> bool {
    SPINNER_FRAMES.contains(&glyph)
}

// ---------------------------------------------------------------------------
// The dead-loop regressions
// ---------------------------------------------------------------------------

#[test]
fn typing_reaches_the_composer() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"explain this");
    assert_eq!(app.composer().text(), "explain this");
    assert!(daemon.sent.is_empty(), "typing sends nothing");
}

#[test]
fn the_live_region_is_the_real_composer_not_a_placeholder() {
    // The phase-2 loop rendered a hard-coded strip. The composer frame, the
    // generated hint line and the footer are what say the real one is mounted.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"hi");
    let text = live_text(&app);
    assert!(text.contains('╭') && text.contains('╯'), "{text}");
    assert!(text.contains("hi"), "{text}");
    assert!(text.contains("enter send"), "the hint line is generated: {text}");
}

#[test]
fn input_is_processed_while_the_event_channel_is_saturated() {
    // The bug: the loop blocked on `events().recv_deadline(...)` *before*
    // draining input, so a chatty daemon made the keyboard dead. Input is now
    // routed first and the event drain is capped, so neither a full channel nor
    // a very loud turn can delay a keystroke by more than a frame.
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    for index in 0..(MAX_EVENTS_PER_TICK * 3) {
        tx.send(update(&format!(
            r#"{{"sessionUpdate":"report","message":"noise {index}"}}"#
        )))
        .expect("channel open");
    }
    press(&mut app, &mut daemon, &rx, b"still typing");
    assert_eq!(app.composer().text(), "still typing");
    assert!(
        !rx.is_empty(),
        "the event drain is bounded, so the next tick still gets to read the keyboard"
    );
}

// ---------------------------------------------------------------------------
// Submit, queue, steer
// ---------------------------------------------------------------------------

#[test]
fn enter_at_idle_sends_session_prompt_with_the_composer_text() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"ship it\r");
    assert_eq!(daemon.sent, vec![Call::Prompt("ship it".to_owned())]);
    assert!(app.composer().is_empty(), "submitting empties the composer");
    assert!(
        scrollback(&mut app).contains("ship it"),
        "the user band is echoed locally, at keystroke latency"
    );
}

#[test]
fn enter_while_a_turn_runs_queues_instead_of_sending() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"first\r");
    press(&mut app, &mut daemon, &rx, b"then this\r");
    assert_eq!(daemon.prompts(), vec!["first"], "only the first went out");
    let queued: Vec<&str> = app.queued().map(|item| item.text.as_str()).collect();
    assert_eq!(queued, vec!["then this"]);
    assert!(
        live_text(&app).contains("queued"),
        "the queue is visible while it is pending"
    );
}

#[test]
fn ctrl_s_flushes_the_queue_and_the_composer_as_steering() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"first\r");
    press(&mut app, &mut daemon, &rx, b"also this\r");
    press(&mut app, &mut daemon, &rx, b"and this\x13");
    assert_eq!(
        daemon.sent,
        vec![
            Call::Prompt("first".to_owned()),
            Call::Steer("also this".to_owned()),
            Call::Steer("and this".to_owned()),
        ],
        "the queue drains first, the composer goes last"
    );
    assert_eq!(app.queued().count(), 0);
}

#[test]
fn a_turn_ending_auto_submits_one_queued_entry() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"first\r");
    press(&mut app, &mut daemon, &rx, b"second\r");
    tx.send(update(
        r#"{"sessionUpdate":"turn_end","turnId":"t-1","status":"completed",
            "durationMs":10,"partialRetained":false}"#,
    ))
    .expect("channel open");
    press(&mut app, &mut daemon, &rx, b"");
    assert_eq!(daemon.prompts(), vec!["first", "second"]);
}

#[test]
fn a_slash_command_goes_to_session_command_not_session_prompt() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/context\r");
    assert_eq!(
        daemon.sent,
        vec![Call::Command("/context".to_owned())],
        "the leading slash is what the daemon's router parses"
    );
    // A command is not a turn, so the next Enter must send rather than queue.
    press(&mut app, &mut daemon, &rx, b"now do it\r");
    assert_eq!(daemon.prompts(), vec!["now do it"]);
}

#[test]
fn a_slash_command_report_reaches_scrollback() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/health\r");
    let _ = scrollback(&mut app);
    daemon.answers.push(Reply {
        call: Call::Command("/health".to_owned()),
        outcome: Ok(serde_json::json!({ "command": "health", "output": "all green" })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    assert!(scrollback(&mut app).contains("all green"));
}

// ---------------------------------------------------------------------------
// Esc, Ctrl+C, Tab
// ---------------------------------------------------------------------------

#[test]
fn esc_during_a_turn_cancels_it_and_rewinds_the_prompt() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"do the thing\r");
    press(&mut app, &mut daemon, &rx, b"\x1b");
    assert_eq!(
        daemon.sent.last(),
        Some(&Call::Cancel {
            rewound_to_composer: true
        }),
        "a zero-output turn whose prompt really went back may be trimmed"
    );
    assert_eq!(app.composer().text(), "do the thing");
}

#[test]
fn esc_never_claims_a_rewind_it_did_not_perform() {
    // The send+cancel double-prompt bug: the turn has already said something, so
    // the prompt stays in history and the composer stays empty.
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"do the thing\r");
    tx.send(update(
        r#"{"sessionUpdate":"delta","messageId":"m-1","partId":"p-1",
            "field":"text","delta":"working on it\n"}"#,
    ))
    .expect("channel open");
    // A frame with no keystroke, so the delta is folded in before Esc is
    // pressed — input leads events by design, and this test is about what
    // happens once the output has actually arrived.
    press(&mut app, &mut daemon, &rx, b"");
    press(&mut app, &mut daemon, &rx, b"\x1b");
    assert_eq!(
        daemon.sent.last(),
        Some(&Call::Cancel {
            rewound_to_composer: false
        })
    );
    assert!(app.composer().is_empty());
}

#[test]
fn esc_with_text_in_the_composer_arms_before_it_clears() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"half a thought");
    let start = Instant::now();
    press_at(&mut app, &mut daemon, &rx, b"\x1b", start);
    assert_eq!(app.composer().text(), "half a thought", "first press arms");
    press_at(&mut app, &mut daemon, &rx, b"\x1b", start + DELIBERATE);
    assert!(app.composer().is_empty(), "second press clears");
    assert!(daemon.sent.is_empty(), "clearing the composer is not a cancel");
}

#[test]
fn a_mash_of_escapes_during_a_turn_cancels_once_and_climbs_no_further() {
    // The live defect, at the level the user met it: a turn going wrong, Esc
    // pressed five times in frustration, and the presses the cancel did not
    // consume walking on into rungs that arm and then fire something
    // destructive — inside what the user experienced as one gesture.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"do the thing\r");
    let start = Instant::now();
    for step in 0..5 {
        // 30ms apart: key repeat, or a hand that has given up on the turn.
        press_at(
            &mut app,
            &mut daemon,
            &rx,
            b"\x1b",
            start + Duration::from_millis(30) * step,
        );
    }
    assert_eq!(
        daemon
            .sent
            .iter()
            .filter(|call| matches!(call, Call::Cancel { .. }))
            .count(),
        1,
        "one cancel, not five: {:?}",
        daemon.methods()
    );
    assert_eq!(
        app.composer().text(),
        "do the thing",
        "and the prompt the cancel rewound is still there to edit"
    );
}

#[test]
fn a_deliberate_second_press_after_the_mash_grace_still_reaches_the_next_rung() {
    // The protection must not cost the ladder its ordered walk: pause, and Esc
    // means the next thing down.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"do the thing\r");
    let start = Instant::now();
    press_at(&mut app, &mut daemon, &rx, b"\x1b", start);
    assert_eq!(app.composer().text(), "do the thing", "cancelled and rewound");
    press_at(&mut app, &mut daemon, &rx, b"\x1b", start + DELIBERATE);
    assert_eq!(app.composer().text(), "do the thing", "which arms the clear");
    press_at(&mut app, &mut daemon, &rx, b"\x1b", start + DELIBERATE * 2);
    assert!(app.composer().is_empty(), "and the deliberate press clears it");
}

#[test]
fn esc_pops_the_most_recent_queued_entry_back_for_editing() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"first\r");
    press(&mut app, &mut daemon, &rx, b"queued one\r");
    press(&mut app, &mut daemon, &rx, b"\x1b");
    assert_eq!(app.composer().text(), "queued one");
    assert_eq!(app.queued().count(), 0);
}

#[test]
fn two_ctrl_c_presses_exit_and_the_first_cancels() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"long job\r");
    press(&mut app, &mut daemon, &rx, b"\x03");
    assert!(!app.finished(), "the first press cancels, it does not exit");
    assert!(daemon
        .sent
        .iter()
        .any(|call| matches!(call, Call::Cancel { .. })));
    press(&mut app, &mut daemon, &rx, b"\x03");
    assert!(app.finished(), "the second press exits");
}

#[test]
fn tab_expands_the_last_tool_call() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    for frame in [
        r#"{"sessionUpdate":"tool_call_start","toolCallId":"c-1","messageId":"m-1",
            "partId":"p-1","tool":"edit","argsSummary":"src/auth.ts"}"#,
        r#"{"sessionUpdate":"tool_call_update","toolCallId":"c-1","status":"running",
            "args":{"path":"src/auth.ts"}}"#,
        r#"{"sessionUpdate":"tool_call_end","toolCallId":"c-1","status":"ok",
            "resultSummary":"12 lines changed","durationMs":40}"#,
    ] {
        tx.send(update(frame)).expect("channel open");
    }
    press(&mut app, &mut daemon, &rx, b"");
    assert_eq!(app.transcript_mut().last_tool_expanded(), Some(false));
    let _ = scrollback(&mut app);

    press(&mut app, &mut daemon, &rx, b"\t");
    assert_eq!(app.transcript_mut().last_tool_expanded(), Some(true));
    assert!(
        !scrollback(&mut app).is_empty(),
        "the expansion is appended below the collapsed row"
    );
}

// ---------------------------------------------------------------------------
// Streaming, reliability, teardown
// ---------------------------------------------------------------------------

#[test]
fn assistant_text_streams_through_markdown_into_scrollback() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"write something\r");
    let _ = scrollback(&mut app);
    for chunk in ["## Heading\n", "\nbody text that is stable\n", "\nmore\n"] {
        tx.send(update(&format!(
            r#"{{"sessionUpdate":"delta","messageId":"m-1","partId":"p-1",
                "field":"text","delta":{}}}"#,
            serde_json::to_string(chunk).expect("string")
        )))
        .expect("channel open");
    }
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);
    assert!(committed.contains("Heading"), "{committed}");
    assert!(
        committed.contains("body text that is stable"),
        "the markdown policy committed the stable block: {committed}"
    );
}

#[test]
fn a_retry_reaches_both_the_transcript_and_the_footer() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    tx.send(update(
        r#"{"sessionUpdate":"retry","attempt":2,"maxAttempts":8,
            "classification":"quota","providerMessage":"slow down",
            "delayMs":4000,"retryAtMs":0,"resetsPartialOutput":false}"#,
    ))
    .expect("channel open");
    press(&mut app, &mut daemon, &rx, b"");
    assert!(scrollback(&mut app).contains("retry 2/8"));
    assert!(live_text(&app).contains("retry 2/8"), "and in the footer");
}

#[test]
fn the_activity_strip_names_the_running_tool_and_lets_go_of_it() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    tx.send(update(
        r#"{"sessionUpdate":"tool_call_start","toolCallId":"c-1","messageId":"m-1",
            "partId":"p-1","tool":"edit","argsSummary":"src/auth.ts"}"#,
    ))
    .expect("channel open");
    press(&mut app, &mut daemon, &rx, b"");
    assert!(live_text(&app).contains("▸ edit src/auth.ts"), "{}", live_text(&app));

    tx.send(update(
        r#"{"sessionUpdate":"tool_call_end","toolCallId":"c-1","status":"ok","durationMs":9}"#,
    ))
    .expect("channel open");
    press(&mut app, &mut daemon, &rx, b"");
    assert!(!live_text(&app).contains("▸ edit"));
}

#[test]
fn a_running_tool_keeps_the_spinner_turning_however_long_it_takes() {
    // Execution is local — the wire has nothing to say while `bash` runs — and a
    // ten-minute command is not a hang. Nor is the silence after it finishes.
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    let start = Instant::now();
    press_at(&mut app, &mut daemon, &rx, b"run the tests\r", start);
    tx.send(update(r#"{"sessionUpdate":"turn_start","turnId":"t-1","source":"user"}"#))
        .expect("channel open");
    tx.send(update(
        r#"{"sessionUpdate":"tool_call_start","toolCallId":"c-1","messageId":"m-1",
            "partId":"p-1","tool":"bash","argsSummary":"cargo test"}"#,
    ))
    .expect("channel open");
    press_at(&mut app, &mut daemon, &rx, b"", start);

    for after in [4u64, 30, 600] {
        let glyph = activity_glyph(&app, start + Duration::from_secs(after));
        assert!(spinning(&glyph), "frozen {after}s into a running tool: {glyph:?}");
    }

    tx.send(update(
        r#"{"sessionUpdate":"tool_call_end","toolCallId":"c-1","status":"ok","durationMs":9}"#,
    ))
    .expect("channel open");
    let ended = start + Duration::from_secs(600);
    press_at(&mut app, &mut daemon, &rx, b"", ended);
    let glyph = activity_glyph(&app, ended + Duration::from_secs(30));
    assert!(
        spinning(&glyph),
        "the turn is still running, so the spinner still spins: {glyph:?}"
    );
}

#[test]
fn wire_silence_mid_turn_never_freezes_the_spinner() {
    // The owner decision this replaced a three-second heuristic with: a model
    // thinking silently is a *normal* turn. The client holds no provider
    // connection and cannot tell a long thought from a hang, so it stops
    // guessing — the motion means "this turn is still ours" and nothing else.
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    let start = Instant::now();
    press_at(&mut app, &mut daemon, &rx, b"explain this\r", start);
    tx.send(update(
        r#"{"sessionUpdate":"delta","messageId":"m-1","partId":"p-1","field":"text",
            "delta":"one moment"}"#,
    ))
    .expect("channel open");
    press_at(&mut app, &mut daemon, &rx, b"", start);

    let theme = Theme::lyra();
    for after in [3u64, 10, 60, 600] {
        let (glyph, style) = strip(&app, start + Duration::from_secs(after));
        assert!(spinning(&glyph), "froze after {after}s of wire silence: {glyph:?}");
        assert_eq!(
            style,
            theme.accent(),
            "and never went amber on the client's own say-so ({after}s)"
        );
    }

    // Consecutive ticks are different frames: it is *smooth*, not a still.
    let at = start + Duration::from_secs(10);
    assert_ne!(
        activity_glyph(&app, at),
        activity_glyph(&app, at + Duration::from_millis(100)),
    );

    // And it stops when the turn does.
    tx.send(update(
        r#"{"sessionUpdate":"turn_end","turnId":"t-1","status":"completed","durationMs":1,
            "partialRetained":false}"#,
    ))
    .expect("channel open");
    let done = start + Duration::from_secs(600);
    press_at(&mut app, &mut daemon, &rx, b"", done);
    assert_eq!(activity_glyph(&app, done), Activity::Idle.glyph());
}

#[test]
fn a_retry_is_the_one_thing_that_turns_the_strip_amber() {
    // Trouble is the *daemon's* word. The retry line carries the detail and the
    // strip carries the state — and the glyph keeps moving, because a frozen
    // warning beside a live countdown would contradict the pause it explains.
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    let start = Instant::now();
    press_at(&mut app, &mut daemon, &rx, b"go\r", start);
    tx.send(update(
        r#"{"sessionUpdate":"retry","attempt":2,"maxAttempts":8,
            "classification":"rate_limit","providerMessage":"slow down",
            "delayMs":30000,"retryAtMs":0,"resetsPartialOutput":false}"#,
    ))
    .expect("channel open");
    press_at(&mut app, &mut daemon, &rx, b"", start);
    // The line the retry commits to scrollback is untouched by any of this.
    let committed = scrollback(&mut app);
    assert!(committed.contains("⟳ rate limited · retry 2/8"), "{committed}");

    let (glyph, style) = strip(&app, start + Duration::from_secs(20));
    assert!(spinning(&glyph), "{glyph:?}");
    assert_eq!(style, Theme::lyra().warning());
    assert!(live_text(&app).contains("retry 2/8"), "{}", live_text(&app));
}

#[test]
fn a_provider_reported_stall_needs_no_new_client_state() {
    // The daemon's stall watchdog reports itself as an ordinary retry with a
    // phase-named classification. The strip goes amber for it because it is
    // trouble the daemon declared, and the line names it in the daemon's own
    // words rather than in a vocabulary this client would have to keep in step.
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    let start = Instant::now();
    press_at(&mut app, &mut daemon, &rx, b"go\r", start);
    tx.send(update(
        r#"{"sessionUpdate":"retry","attempt":1,"maxAttempts":3,
            "classification":"provider_stalled","providerMessage":"no bytes for 60s",
            "delayMs":5000,"retryAtMs":0,"resetsPartialOutput":false}"#,
    ))
    .expect("channel open");
    press_at(&mut app, &mut daemon, &rx, b"", start);
    let committed = scrollback(&mut app);
    assert!(committed.contains("provider stalled"), "{committed}");
    let (glyph, style) = strip(&app, start + Duration::from_secs(2));
    assert!(spinning(&glyph), "{glyph:?}");
    assert_eq!(style, Theme::lyra().warning());
}

// ---------------------------------------------------------------------------
// Thinking traces
// ---------------------------------------------------------------------------

/// The frames a thinking part is made of, so each test says only what it is
/// about. `THINK` opens it, `TRACE` streams it, `END` closes it.
const THINK: &str =
    r#"{"sessionUpdate":"part_start","messageId":"m-1","partId":"p-think","kind":"thinking"}"#;
const TRACE: &str = r#"{"sessionUpdate":"delta","messageId":"m-1","partId":"p-think",
    "field":"thinking","delta":"weighing the retry ladder against the queue"}"#;
const END: &str =
    r#"{"sessionUpdate":"part_end","messageId":"m-1","partId":"p-think"}"#;

/// Drive a whole thinking part: opened at `start`, closed `seconds` later.
fn think_for(
    app: &mut App,
    daemon: &mut ScriptedDaemon,
    tx: &Sender<AcpEvent>,
    rx: &Receiver<AcpEvent>,
    start: Instant,
    seconds: u64,
) {
    tx.send(update(THINK)).expect("channel open");
    tx.send(update(TRACE)).expect("channel open");
    press_at(app, daemon, rx, b"", start);
    tx.send(update(END)).expect("channel open");
    press_at(app, daemon, rx, b"", start + Duration::from_secs(seconds));
}

#[test]
fn thinking_streams_dim_into_the_live_region_and_never_into_the_answer() {
    // The plumbing was always there and the screen dropped it, so a model that
    // thought for a minute before speaking looked like a client doing nothing.
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    let start = Instant::now();
    press_at(&mut app, &mut daemon, &rx, b"think about it\r", start);
    // The user band is already in scrollback; what follows is about the thought.
    let _ = scrollback(&mut app);
    tx.send(update(THINK)).expect("channel open");
    tx.send(update(TRACE)).expect("channel open");
    press_at(&mut app, &mut daemon, &rx, b"", start);

    let live = live_text(&app);
    assert!(live.contains("∴ thinking"), "{live}");
    assert!(live.contains("weighing the retry ladder"), "{live}");
    // Nothing committed: a trace is transient by construction.
    assert_eq!(scrollback(&mut app), "");
    // And the strip names the state rather than the mechanism.
    assert!(live.contains("thinking"), "{live}");

    // Dim, on every row of it: thinking must not read as the answer.
    let region = app.live(app.desired_region_height(12), start);
    let trace = region
        .rows
        .iter()
        .find(|row| row.plain_text().contains("weighing"))
        .expect("the trace is on screen");
    for span in &trace.spans {
        assert!(
            span.style.modifiers.contains(crate::vendor::flywheel::Modifiers::DIM),
            "{trace:?}"
        );
    }
}

#[test]
fn a_thinking_delta_never_reaches_the_markdown_stream_or_the_answer_text() {
    // The routing bug this guards: `Delta` dispatched on the *field*, so a
    // thinking chunk that fell through to `assistant_delta` would be parsed as
    // markdown, published at its line boundaries, and committed to scrollback as
    // the model's reply — with the reasoning inside the answer.
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    let start = Instant::now();
    press_at(&mut app, &mut daemon, &rx, b"think about it\r", start);
    // The user band is already in scrollback; what follows is about the thought.
    let _ = scrollback(&mut app);
    tx.send(update(THINK)).expect("channel open");
    tx.send(update(
        r##"{"sessionUpdate":"delta","messageId":"m-1","partId":"p-think","field":"thinking",
            "delta":"# not a heading\nand not a paragraph\n"}"##,
    ))
    .expect("channel open");
    press_at(&mut app, &mut daemon, &rx, b"", start);
    assert_eq!(
        scrollback(&mut app),
        "",
        "a thinking delta published nothing, however markdown-shaped it was"
    );

    // The answer that follows is the answer alone, at every width.
    tx.send(update(END)).expect("channel open");
    tx.send(update(
        r#"{"sessionUpdate":"delta","messageId":"m-1","partId":"p-text","field":"text",
            "delta":"the answer\n"}"#,
    ))
    .expect("channel open");
    press_at(&mut app, &mut daemon, &rx, b"", start + Duration::from_secs(2));
    let committed = scrollback(&mut app);
    assert!(committed.contains("the answer"), "{committed}");
    assert!(!committed.contains("not a heading"), "{committed}");
    let replayed: Vec<String> = ReplaySource::replay_rows(&mut app, 40, 2000)
        .iter()
        .map(Row::plain_text)
        .collect();
    assert!(
        !replayed.iter().any(|row| row.contains("not a heading")),
        "the trace stayed out of the transcript's answer entry: {replayed:?}"
    );
}

#[test]
fn a_thinking_part_ending_collapses_to_one_dim_line_with_its_duration() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    let start = Instant::now();
    press_at(&mut app, &mut daemon, &rx, b"think about it\r", start);
    let _ = scrollback(&mut app);
    think_for(&mut app, &mut daemon, &tx, &rx, start, 23);

    let committed = scrollback(&mut app);
    assert_eq!(committed, "∴ thought for 23s", "{committed}");
    assert!(
        !live_text(&app).contains("weighing"),
        "the live block is gone once it has been accounted for"
    );
}

#[test]
fn full_mode_commits_the_trace_and_off_mode_renders_none_of_it() {
    for (mode, wants_trace, wants_line) in [
        (ThinkingMode::Full, true, true),
        (ThinkingMode::Off, false, false),
    ] {
        let (mut app, mut daemon, (tx, rx)) = (
            app().with_thinking(mode),
            ScriptedDaemon::default(),
            wire(),
        );
        let start = Instant::now();
        press_at(&mut app, &mut daemon, &rx, b"think about it\r", start);
        tx.send(update(THINK)).expect("channel open");
        tx.send(update(TRACE)).expect("channel open");
        press_at(&mut app, &mut daemon, &rx, b"", start);
        assert_eq!(
            live_text(&app).contains("weighing the retry ladder"),
            wants_trace,
            "{mode:?}: live region"
        );

        tx.send(update(END)).expect("channel open");
        press_at(&mut app, &mut daemon, &rx, b"", start + Duration::from_secs(9));
        let committed = scrollback(&mut app);
        assert_eq!(committed.contains("∴ thought for 9s"), wants_line, "{mode:?}: {committed}");
        assert_eq!(
            committed.contains("weighing the retry ladder"),
            wants_trace,
            "{mode:?}: {committed}"
        );
    }
}

#[test]
fn a_redacted_thinking_part_is_timed_and_never_shows_its_signature() {
    // Signature-only: provider-opaque bytes with nothing to say to a reader. The
    // part still happened, and the line it earns says only that.
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    let start = Instant::now();
    press_at(&mut app, &mut daemon, &rx, b"think about it\r", start);
    // The user band is already in scrollback; what follows is about the thought.
    let _ = scrollback(&mut app);
    tx.send(update(THINK)).expect("channel open");
    tx.send(update(
        r#"{"sessionUpdate":"delta","messageId":"m-1","partId":"p-think","field":"signature",
            "delta":"c2lnbmF0dXJlLWJ5dGVz"}"#,
    ))
    .expect("channel open");
    press_at(&mut app, &mut daemon, &rx, b"", start);
    assert!(!live_text(&app).contains("c2lnbmF0dXJl"), "{}", live_text(&app));

    tx.send(update(END)).expect("channel open");
    press_at(&mut app, &mut daemon, &rx, b"", start + Duration::from_secs(4));
    let committed = scrollback(&mut app);
    assert_eq!(committed, "∴ thought for 4s", "{committed}");
}

#[test]
fn a_cancelled_turn_closes_the_thought_it_was_in_the_middle_of() {
    // No `part_end` ever arrives for a cancelled thought. A live block that
    // outlived its turn would sit above the next prompt claiming the model was
    // still thinking.
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    let start = Instant::now();
    press_at(&mut app, &mut daemon, &rx, b"think about it\r", start);
    // The user band is already in scrollback; what follows is about the thought.
    let _ = scrollback(&mut app);
    tx.send(update(THINK)).expect("channel open");
    tx.send(update(TRACE)).expect("channel open");
    press_at(&mut app, &mut daemon, &rx, b"", start);
    tx.send(update(
        r#"{"sessionUpdate":"turn_end","turnId":"t-1","status":"cancelled","durationMs":5000,
            "partialRetained":true}"#,
    ))
    .expect("channel open");
    press_at(&mut app, &mut daemon, &rx, b"", start + Duration::from_secs(5));

    let committed = scrollback(&mut app);
    assert!(committed.contains("∴ thought for 5s"), "{committed}");
    assert!(!committed.contains("weighing"), "{committed}");
    assert!(!live_text(&app).contains("∴ thinking"), "{}", live_text(&app));
}

#[test]
fn the_strip_says_waiting_before_the_first_token_and_thinking_once_it_arrives() {
    // Two states the client used to have no word for, both now the daemon's:
    // `round_start` says a request is out, and the part kind says what is
    // arriving. The spinner turns throughout — the wait is the workload.
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    let start = Instant::now();
    press_at(&mut app, &mut daemon, &rx, b"think about it\r", start);
    tx.send(update(r#"{"sessionUpdate":"turn_start","turnId":"t-1","source":"user"}"#))
        .expect("channel open");
    tx.send(update(
        r#"{"sessionUpdate":"round_start","turnId":"t-1","round":1,
            "startedAtMs":1700000000000}"#,
    ))
    .expect("channel open");
    press_at(&mut app, &mut daemon, &rx, b"", start);
    assert!(live_text(&app).contains("waiting for the model"), "{}", live_text(&app));
    assert!(spinning(&activity_glyph(&app, start + Duration::from_secs(90))));

    tx.send(update(
        r#"{"sessionUpdate":"message_start","turnId":"t-1","messageId":"m-1","role":"assistant"}"#,
    ))
    .expect("channel open");
    tx.send(update(THINK)).expect("channel open");
    tx.send(update(TRACE)).expect("channel open");
    press_at(&mut app, &mut daemon, &rx, b"", start + Duration::from_secs(1));
    let live = live_text(&app);
    assert!(!live.contains("waiting for the model"), "the round is answered: {live}");
    assert!(live.contains("thinking"), "{live}");
}

#[test]
fn the_transcript_is_the_replay_source_a_purge_resize_reprints_from() {
    // Registering it is what makes a purge re-render at the *new* width instead
    // of reprinting rows already wrapped to the old one (DESIGN.md §1).
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"a question\r");
    tx.send(update(
        r#"{"sessionUpdate":"delta","messageId":"m-1","partId":"p-1","field":"text",
            "delta":"an answer long enough that its wrapping depends on the width\n\n"}"#,
    ))
    .expect("channel open");
    press(&mut app, &mut daemon, &rx, b"");

    let wide = ReplaySource::replay_rows(&mut app, 100, 2000).len();
    let narrow = ReplaySource::replay_rows(&mut app, 30, 2000).len();
    assert!(narrow > wide, "re-rendered at the new width: {narrow} vs {wide}");
}

#[test]
fn a_closed_pipe_finishes_the_loop() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    tx.send(AcpEvent::Closed(None)).expect("channel open");
    press(&mut app, &mut daemon, &rx, b"");
    assert!(app.finished());
}

#[test]
fn an_update_this_build_does_not_model_still_leaves_a_row() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    tx.send(update(r#"{"sessionUpdate":"telemetry","frames":12}"#))
        .expect("channel open");
    press(&mut app, &mut daemon, &rx, b"");
    assert!(scrollback(&mut app).contains("telemetry"));
}

#[test]
fn a_failed_prompt_puts_the_queue_back_to_idle() {
    // No `turn_end` will ever arrive for a call the daemon rejected, so nothing
    // else would ever let the user submit again.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"go\r");
    daemon.answers.push(Reply {
        call: Call::Prompt("go".to_owned()),
        outcome: Err("acp: provider unavailable".to_owned()),
    });
    press(&mut app, &mut daemon, &rx, b"");
    assert!(scrollback(&mut app).contains("provider unavailable"));
    press(&mut app, &mut daemon, &rx, b"again\r");
    assert_eq!(daemon.prompts(), vec!["go", "again"]);
}

// ---------------------------------------------------------------------------
// Completion: the `/` and `@` popups
// ---------------------------------------------------------------------------

/// The registry three of the tests below start from.
fn hydrate(app: &mut App, daemon: &mut ScriptedDaemon, events: &Receiver<AcpEvent>) {
    app.hydrate(daemon);
    // Two calls, both once: the command registry, and the checkpoint list the
    // `Esc Esc` rung answers `can_rewind` from without a round trip.
    assert_eq!(
        daemon.methods(),
        vec!["session/commands", "checkpoint/list"],
        "asked once, at bootstrap"
    );
    app.hydrate(daemon);
    assert_eq!(daemon.sent.len(), 2, "and only once");
    daemon.answers.push(Reply {
        call: Call::Commands,
        outcome: Ok(serde_json::json!({ "commands": [
            { "name": "context", "description": "Show the context breakdown.",
              "resultKind": "context" },
            { "name": "compact", "description": "Compact the transcript." },
            { "name": "models", "usage": "[--refresh]", "description": "List models.",
              "resultKind": "models" }
        ]})),
    });
    press(app, daemon, events, b"");
    daemon.sent.clear();
}

#[test]
fn a_slash_at_the_start_opens_a_popup_of_commands_and_filters_it() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    hydrate(&mut app, &mut daemon, &rx);

    press(&mut app, &mut daemon, &rx, b"/c");
    let text = live_text(&app);
    assert!(text.contains("/context"), "{text}");
    assert!(text.contains("/compact"), "{text}");
    assert!(
        text.contains("Show the context breakdown."),
        "the popup shows name and description: {text}"
    );
    assert!(
        !text.contains("/models"),
        "`c` is not a subsequence of `models`: {text}"
    );
    assert!(daemon.sent.is_empty(), "the command list is local, not a round trip");

    // Narrowing to one candidate, then accepting it, inserts the command.
    press(&mut app, &mut daemon, &rx, b"on");
    press(&mut app, &mut daemon, &rx, b"\t");
    assert_eq!(app.composer().text(), "/context");
    assert!(
        !live_text(&app).contains("Show the context breakdown."),
        "a fully typed name suggests nothing, so the popup closes"
    );

    // …and `Enter` then means run it, not accept-what-I-already-typed.
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(daemon.sent, vec![Call::Command("/context".to_owned())]);
}

#[test]
fn an_at_mention_asks_the_daemon_and_renders_the_answer_in_its_order() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"look at @src");
    assert!(
        daemon.sent.is_empty(),
        "the request is debounced, so typing a path is not one call per keystroke"
    );

    settle(&mut app, &mut daemon, &rx);
    assert_eq!(
        daemon.sent,
        vec![Call::Complete {
            session_id: None,
            kind: "file",
            query: "src".to_owned(),
            limit: 40,
        }]
    );

    // The daemon ranked these. `zebra` first is the whole point of the test.
    daemon.answers.push(Reply {
        call: daemon.sent[0].clone(),
        outcome: Ok(serde_json::json!({ "items": [
            { "value": "src/zebra.ts", "label": "zebra.ts", "detail": "src/" },
            { "value": "src/apple.ts", "label": "apple.ts", "detail": "src/" }
        ], "truncated": false })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let text = live_text(&app);
    assert!(
        text.find("zebra.ts") < text.find("apple.ts"),
        "server-ranked, not re-sorted: {text}"
    );

    // Accepting inserts the workspace-relative path the daemon returned.
    press(&mut app, &mut daemon, &rx, b"\t");
    assert_eq!(app.composer().text(), "look at @src/zebra.ts");
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

#[test]
fn ctrl_p_opens_the_palette_and_running_an_entry_runs_the_action() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    hydrate(&mut app, &mut daemon, &rx);

    press(&mut app, &mut daemon, &rx, b"\x10");
    assert!(live_text(&app).contains("commands"), "the panel is titled");

    // One list: the registry's own descriptions and the daemon's commands.
    press(&mut app, &mut daemon, &rx, b"send");
    assert!(
        live_text(&app).contains("Send the prompt."),
        "keybinding descriptions are palette rows: {}",
        live_text(&app)
    );
    for _ in 0..4 {
        press(&mut app, &mut daemon, &rx, b"\x7f");
    }
    press(&mut app, &mut daemon, &rx, b"compact");
    assert!(
        live_text(&app).contains("/compact"),
        "and so are the daemon's commands: {}",
        live_text(&app)
    );
    for _ in 0..7 {
        press(&mut app, &mut daemon, &rx, b"\x7f");
    }

    // `q` and `?` are filter characters here, not "close" and "help".
    press(&mut app, &mut daemon, &rx, b"exit");
    assert!(!app.finished(), "typing into the filter runs nothing");
    assert!(
        live_text(&app).contains("Exit, when the composer is empty."),
        "{}",
        live_text(&app)
    );
    press(&mut app, &mut daemon, &rx, b"\r");
    assert!(
        app.finished(),
        "the palette dispatches the very action its key would have"
    );
}

#[test]
fn a_palette_command_entry_runs_the_slash_command() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    hydrate(&mut app, &mut daemon, &rx);
    press(&mut app, &mut daemon, &rx, b"\x10");
    press(&mut app, &mut daemon, &rx, b"/compact");
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(daemon.sent, vec![Call::Command("/compact".to_owned())]);
    assert!(
        scrollback(&mut app).contains("/compact"),
        "it is echoed like anything else the user ran"
    );
}

#[test]
fn question_mark_renders_the_generated_cheatsheet() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"?");
    let text = live_text(&app);
    assert!(text.contains("keys"), "{text}");
    assert!(
        text.contains("anywhere") && text.contains("ctrl+c"),
        "grouped and generated from the registry: {text}"
    );
    assert!(
        !text.contains("not wired yet"),
        "the placeholder notice is gone: {text}"
    );
    assert!(app.composer().is_empty(), "`?` opened help rather than typing");

    // It scrolls, so the groups below the fold are reachable.
    for _ in 0..8 {
        press(&mut app, &mut daemon, &rx, b"\x1b[B");
    }
    assert_ne!(live_text(&app), text, "down scrolled the sheet");

    // A rows overlay keeps `q`.
    press(&mut app, &mut daemon, &rx, b"q");
    assert!(!live_text(&app).contains("anywhere"), "{}", live_text(&app));
}

#[test]
fn dismissing_an_overlay_leaves_the_composer_exactly_as_it_was() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"half a thought");
    press(&mut app, &mut daemon, &rx, b"\x10");
    assert!(live_text(&app).contains("commands"), "{}", live_text(&app));
    press(&mut app, &mut daemon, &rx, b"\x1b");
    assert!(
        !live_text(&app).contains("Send the prompt."),
        "esc rung 1 dismissed the overlay"
    );
    assert_eq!(
        app.composer().text(),
        "half a thought",
        "and the first esc must not have reached the composer's rung"
    );
    assert!(daemon.sent.is_empty());
}

#[test]
fn an_overlay_borrows_live_region_rows_and_gives_them_back() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    assert_eq!(app.desired_region_height(12), 12, "nothing open, nothing borrowed");
    press(&mut app, &mut daemon, &rx, b"?");
    assert!(
        app.desired_region_height(12) > 12,
        "the cheatsheet does not fit in the chrome's rows"
    );
    assert!(
        app.desired_region_height(12) <= MAX_REGION_HEIGHT,
        "an overlay may grow the region, never take the screen"
    );
    press(&mut app, &mut daemon, &rx, b"\x1b");
    assert_eq!(app.desired_region_height(12), 12);
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

#[test]
fn a_bare_slash_model_opens_one_picker_over_every_configured_provider() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/model\r");
    assert_eq!(
        daemon.sent,
        vec![Call::Models],
        "the bare form is a question, and a list is the answer"
    );

    daemon.answers.push(Reply {
        call: Call::Models,
        outcome: Ok(serde_json::json!({
            "current": "anthropic/opus-5",
            "providers": [
                { "provider": "anthropic", "models": [
                    { "id": "opus-5", "contextWindow": 200_000 },
                    { "id": "sonnet-4", "contextWindow": 200_000 }
                ]},
                { "provider": "local", "models": [ { "id": "qwen2.5-coder:14b" } ]}
            ]
        })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let text = live_text(&app);
    for row in ["anthropic/opus-5", "anthropic/sonnet-4", "local/qwen2.5-coder:14b"] {
        assert!(text.contains(row), "{row} is not in the picker: {text}");
    }
    assert!(text.contains("200k ctx"), "raw measurement, not a percentage: {text}");
    assert!(!text.contains('{'), "the picker is a list, not a dump: {text}");
    assert!(
        text.find("anthropic/sonnet-4") < text.find("local/qwen"),
        "the daemon's grouping is the order, so a provider's models stay adjacent: {text}"
    );

    // Down twice, then choose: the picker opened on the current model, and the
    // reference that goes back is the whole `provider/model` pair — which is
    // what makes this one picker a provider switch as well.
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\x1b[B\x1b[B");
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(
        daemon.sent,
        vec![Call::SelectModel("local/qwen2.5-coder:14b".to_owned())]
    );

    daemon.answers.push(Reply {
        call: daemon.sent[0].clone(),
        outcome: Ok(serde_json::json!({ "provider": "local", "model": "qwen2.5-coder:14b" })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    assert!(scrollback(&mut app).contains("qwen2.5-coder:14b"));
}

#[test]
fn the_old_flat_models_shape_still_renders_and_still_selects() {
    // Transition tolerance: a daemon that predates the cross-provider reshape
    // answers with one provider's models and takes a bare id back. Rendering a
    // prefix it never sent would be inventing one.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/model\r");
    daemon.answers.push(Reply {
        call: Call::Models,
        outcome: Ok(serde_json::json!({
            "provider": "anthropic",
            "current": "opus-5",
            "models": [
                { "id": "opus-5", "ownedBy": "anthropic", "contextWindow": 200_000 },
                { "id": "sonnet-4", "ownedBy": "anthropic", "contextWindow": 200_000 }
            ]
        })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let text = live_text(&app);
    assert!(text.contains("opus-5") && text.contains("sonnet-4"), "{text}");
    assert!(!text.contains("anthropic/opus-5"), "no invented prefix: {text}");

    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\x1b[B");
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(daemon.sent, vec![Call::SelectModel("sonnet-4".to_owned())]);
}

#[test]
fn the_provider_picker_ends_with_the_row_that_opens_the_wizard() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/provider\r");
    assert_eq!(daemon.sent, vec![Call::Providers]);

    daemon.answers.push(Reply {
        call: Call::Providers,
        outcome: Ok(serde_json::json!({
            "current": "anthropic",
            "available": ["anthropic"]
        })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let text = live_text(&app);
    assert!(
        text.contains("+ add a provider"),
        "the way to add a provider lives in the picker itself: {text}"
    );
    assert!(
        text.contains("/model switches models"),
        "and the picker says which surface the other half is on: {text}"
    );

    // The picker opens on the current provider; one step down is the add row,
    // and choosing it opens the wizard instead of selecting a provider.
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\x1b[B");
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(
        daemon.sent,
        vec![Call::ProviderSetupOptions],
        "accepting the add row asks for the wizard's catalog, not a selection"
    );
}

// ---------------------------------------------------------------------------
// The provider menu, edit and delete
// ---------------------------------------------------------------------------

/// `session/providers`, as the picker's rows come from.
fn providers() -> serde_json::Value {
    serde_json::json!({ "current": "anthropic", "available": ["anthropic", "openai"] })
}

/// `provider/get` for a keychain-backed provider that is **not** in use.
fn provider_info() -> serde_json::Value {
    serde_json::json!({
        "provider": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "apiType": "openai_responses",
        "authType": "keychain",
        "authDetail": "dev.lyra.provider.openai",
        "models": ["gpt-5.6", "gpt-5.6-luna"],
        "inUse": false
    })
}

/// Open the provider picker and let its rows land.
fn picker(app: &mut App, daemon: &mut ScriptedDaemon, events: &Receiver<AcpEvent>, line: &[u8]) {
    press(app, daemon, events, line);
    assert_eq!(daemon.sent, vec![Call::Providers], "{:?}", daemon.methods());
    daemon.answers.push(Reply {
        call: Call::Providers,
        outcome: Ok(providers()),
    });
    press(app, daemon, events, b"");
    daemon.sent.clear();
}

/// Answer the outstanding `provider/get`, whatever it was asked for.
fn describes(
    app: &mut App,
    daemon: &mut ScriptedDaemon,
    events: &Receiver<AcpEvent>,
    outcome: Result<serde_json::Value, String>,
) {
    let call = daemon
        .sent
        .iter()
        .rev()
        .find(|call| matches!(call, Call::ProviderGet { .. }))
        .expect("a provider/get went out")
        .clone();
    daemon.answers.push(Reply { call, outcome });
    press(app, daemon, events, b"");
}

/// The params of every `provider/remove` that went out.
fn removals(daemon: &ScriptedDaemon) -> Vec<&wire::RemoveProviderParams> {
    daemon
        .sent
        .iter()
        .filter_map(|call| match call {
            Call::ProviderRemove(params) => Some(params.as_ref()),
            _ => None,
        })
        .collect()
}

/// Open the edit form on `openai` through the menu, and let both answers land.
fn edit_form(app: &mut App, daemon: &mut ScriptedDaemon, events: &Receiver<AcpEvent>) {
    picker(app, daemon, events, b"/provider\r");
    // The picker opens on the current provider; one step down is `openai`.
    press(app, daemon, events, b"\x1b[B");
    press(app, daemon, events, b"\r");
    describes(app, daemon, events, Ok(provider_info()));
    daemon.sent.clear();
    // Menu: switch, edit, delete.
    press(app, daemon, events, b"\x1b[B");
    press(app, daemon, events, b"\r");
    assert_eq!(
        daemon.methods(),
        vec!["provider/setup_options", "provider/get"],
        "an edit form is the catalog plus the provider it is editing"
    );
    daemon.answers.push(Reply {
        call: Call::ProviderSetupOptions,
        outcome: Ok(catalog()),
    });
    press(app, daemon, events, b"");
    describes(app, daemon, events, Ok(provider_info()));
    daemon.sent.clear();
}

#[test]
fn a_provider_row_opens_a_menu_whose_first_entry_is_the_switch_it_used_to_be() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    picker(&mut app, &mut daemon, &rx, b"/provider\r");
    press(&mut app, &mut daemon, &rx, b"\x1b[B");
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(
        daemon.sent,
        vec![Call::ProviderGet {
            provider: "openai".to_owned(),
            purpose: Purpose::Menu,
        }],
        "accepting a provider row asks what it is, and switches nothing yet"
    );

    let text = live_text(&app);
    for row in ["switch to openai", "edit openai", "delete openai"] {
        assert!(text.contains(row), "{row} is not in the menu: {text}");
    }

    describes(&mut app, &mut daemon, &rx, Ok(provider_info()));
    let text = live_text(&app);
    assert!(
        text.contains("https://api.openai.com/v1") && text.contains("openai_responses"),
        "the menu says what it is about: {text}"
    );
    assert!(
        text.contains("keychain · dev.lyra.provider.openai"),
        "and where the credential it would delete lives: {text}"
    );

    // Enter, from the row the menu opened on: exactly the call accepting a
    // provider row made before there was a menu.
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(
        daemon.sent,
        vec![Call::SelectProvider {
            provider: "openai".to_owned(),
            model: None,
        }]
    );
}

#[test]
fn a_menu_that_never_learns_what_the_provider_is_still_works() {
    // `provider/get` is context, not a gate: the three verbs are the same three
    // verbs whether or not the daemon can describe the provider.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    picker(&mut app, &mut daemon, &rx, b"/provider\r");
    press(&mut app, &mut daemon, &rx, b"\x1b[B\r");
    describes(
        &mut app,
        &mut daemon,
        &rx,
        Err("acp: method not found".to_owned()),
    );
    assert!(scrollback(&mut app).contains("method not found"));
    let text = live_text(&app);
    assert!(text.contains("switch to openai") && text.contains("delete openai"), "{text}");

    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(
        daemon.sent,
        vec![Call::SelectProvider {
            provider: "openai".to_owned(),
            model: None,
        }]
    );
}

#[test]
fn editing_prefills_the_form_and_an_untouched_key_field_keeps_the_credential() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    edit_form(&mut app, &mut daemon, &rx);

    let text = live_text(&app);
    assert!(text.contains("edit openai"), "the panel says which: {text}");
    assert!(text.contains("https://api.openai.com/v1"), "endpoint: {text}");
    assert!(text.contains("OpenAI responses"), "protocol, in the catalog's words: {text}");
    assert!(text.contains("OS keychain"), "and where the credential is: {text}");
    assert!(
        text.contains("fixed · add a new provider to rename"),
        "the name is shown and not editable: {text}"
    );
    assert!(
        !text.contains("+ provider") && !text.contains("second provider"),
        "an edit is about one provider, so there are no second-entry rows: {text}"
    );

    // The credential section: the key field is empty, says what empty means,
    // and nothing from `provider/get` has been typed into it.
    press(&mut app, &mut daemon, &rx, b"\t\t\t\t");
    let text = live_text(&app);
    assert!(
        text.contains("empty keeps keychain · dev.lyra.provider.openai"),
        "the whole of where the credential is, at eighty columns: {text}"
    );
    assert!(!text.contains('•'), "nothing was pre-filled into the key field: {text}");

    // Enter on the last field saves. The name is unchanged, so this is an
    // update, and the credential is neither read nor sent.
    press(&mut app, &mut daemon, &rx, b"\r");
    let requests = added(&daemon);
    assert_eq!(requests.len(), 1, "{:?}", daemon.methods());
    assert_eq!(requests[0].provider, "openai");
    assert_eq!(requests[0].persist, wire::ProviderPersist::Keep);
    assert!(requests[0].api_key.is_none(), "{:?}", requests[0]);
    let encoded = serde_json::to_string(requests[0]).expect("params encode");
    assert!(!encoded.contains("apiKey"), "no credential reaches the wire: {encoded}");
    assert!(
        !encoded.contains("dev.lyra.provider"),
        "and neither does where one is kept: {encoded}"
    );
    assert!(
        encoded.contains("\"persist\":\"keep\""),
        "the one thing that says 'leave it alone': {encoded}"
    );

    saves(
        &mut app,
        &mut daemon,
        &rx,
        &serde_json::json!({ "ok": true, "auth": "keychain", "modelsDiscovered": 42,
                             "path": "/tmp/home/.lyra/providers.toml" }),
    );
    let committed = scrollback(&mut app);
    assert!(
        committed.contains("provider updated · openai · 42 models discovered — /model to switch"),
        "one line, and it says the provider was changed rather than created: {committed}"
    );
    assert!(!live_text(&app).contains("edit openai"), "and the form is done");
}

#[test]
fn an_edit_that_types_a_key_rotates_it_into_the_chosen_source() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    edit_form(&mut app, &mut daemon, &rx);
    press(&mut app, &mut daemon, &rx, b"\t\t\t\t");
    press(&mut app, &mut daemon, &rx, KEY.as_bytes());

    let text = live_text(&app);
    assert!(
        text.contains("replaces keychain · dev.lyra.provider.openai"),
        "the note follows what the field now holds: {text}"
    );
    assert!(!text.contains(KEY) && !text.contains("sk-"), "still masked: {text}");

    press(&mut app, &mut daemon, &rx, b"\r");
    let requests = added(&daemon);
    assert_eq!(requests.len(), 1, "{:?}", daemon.methods());
    assert_eq!(requests[0].persist, wire::ProviderPersist::Keychain);
    assert_eq!(requests[0].api_key.as_ref().map(Secret::expose), Some(KEY));
    assert_eq!(
        requests[0].websocket,
        None,
        "the provider declared none, so the update invents none"
    );
    let printed = format!("{:?}", daemon.sent);
    assert!(!printed.contains("sk-"), "a credential reached Debug: {printed}");
}

#[test]
fn the_edit_prefill_survives_a_catalog_that_lands_after_it() {
    // Two independent round trips: a choice field cannot hold a selection
    // before the catalog has given it options, so the answer that arrives first
    // has to be re-applied by the one that arrives second.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/provider edit openai\r");
    describes(&mut app, &mut daemon, &rx, Ok(provider_info()));
    daemon.answers.push(Reply {
        call: Call::ProviderSetupOptions,
        outcome: Ok(catalog()),
    });
    press(&mut app, &mut daemon, &rx, b"");
    daemon.sent.clear();

    let text = live_text(&app);
    assert!(text.contains("OpenAI responses"), "{text}");
    assert!(
        text.contains("OS keychain"),
        "and not the catalog's default, which happens to be the same one: {text}"
    );
    press(&mut app, &mut daemon, &rx, b"\t\t\t\t\r");
    let requests = added(&daemon);
    assert_eq!(requests.len(), 1, "{:?}", daemon.methods());
    assert_eq!(requests[0].api_type, wire::ConfigurableApiType::OpenAiResponses);
    assert_eq!(requests[0].base_url, "https://api.openai.com/v1");
    assert_eq!(requests[0].persist, wire::ProviderPersist::Keep);
}

#[test]
fn the_palette_reaches_the_two_verbs_that_are_not_actions() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    hydrate(&mut app, &mut daemon, &rx);
    press(&mut app, &mut daemon, &rx, b"\x10");
    press(&mut app, &mut daemon, &rx, b"provider delete");
    assert!(
        live_text(&app).contains("Remove a provider"),
        "{}",
        live_text(&app)
    );
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(
        daemon.sent,
        vec![Call::Providers],
        "the palette runs the very command the slash form does"
    );
}

#[test]
fn an_edit_preserves_what_the_form_has_no_field_for() {
    // The websocket policy has no row, and an update that silently dropped it
    // would be the edit changing something nobody asked it to.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/provider edit openai\r");
    daemon.answers.push(Reply {
        call: Call::ProviderSetupOptions,
        outcome: Ok(catalog()),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let mut info = provider_info();
    info["websocket"] = serde_json::json!("on");
    describes(&mut app, &mut daemon, &rx, Ok(info));
    daemon.sent.clear();

    press(&mut app, &mut daemon, &rx, b"\t\t\t\t\r");
    let requests = added(&daemon);
    assert_eq!(requests.len(), 1, "{:?}", daemon.methods());
    assert_eq!(requests[0].websocket, Some(wire::WebsocketMode::On));
}

#[test]
fn editing_an_env_backed_provider_names_the_variable_and_never_asks_for_a_key() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/provider edit openai\r");
    daemon.answers.push(Reply {
        call: Call::ProviderSetupOptions,
        outcome: Ok(catalog()),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let mut info = provider_info();
    info["authType"] = serde_json::json!("env");
    info["authDetail"] = serde_json::json!("OPENAI_API_KEY");
    describes(&mut app, &mut daemon, &rx, Ok(info));
    daemon.sent.clear();

    let text = live_text(&app);
    assert!(text.contains("Environment variable"), "{text}");
    assert!(
        text.contains("OPENAI_API_KEY"),
        "the variable name is a name, so it is shown: {text}"
    );
    assert!(!text.contains('•'), "and there is no key field at all: {text}");

    press(&mut app, &mut daemon, &rx, b"\t\t\t\t\r");
    let requests = added(&daemon);
    assert_eq!(requests.len(), 1, "{:?}", daemon.methods());
    assert_eq!(
        requests[0].persist,
        wire::ProviderPersist::Env,
        "`keep` is for a credential this client cannot see; a variable it can"
    );
    assert_eq!(requests[0].auth_env_var.as_deref(), Some("OPENAI_API_KEY"));
    assert!(requests[0].api_key.is_none());
}

#[test]
fn deleting_confirms_first_and_the_credential_is_a_row_that_toggles() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/provider delete openai\r");
    assert_eq!(
        daemon.sent,
        vec![Call::ProviderGet {
            provider: "openai".to_owned(),
            purpose: Purpose::Delete,
        }],
        "nothing is removed before it has been confirmed"
    );
    assert!(removals(&daemon).is_empty());

    describes(&mut app, &mut daemon, &rx, Ok(provider_info()));
    let text = live_text(&app);
    assert!(text.contains("delete openai?"), "the panel asks: {text}");
    assert!(text.contains("https://api.openai.com/v1"), "about which one: {text}");
    assert!(
        text.contains("[ ] also remove the stored credential"),
        "off by default: deleting a credential is not undone by re-adding: {text}"
    );
    assert!(text.contains("keychain · dev.lyra.provider.openai"), "{text}");
    assert!(text.contains("cancel"), "{text}");

    // Flip the checkbox: the panel stays up, and the highlight stays on it.
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\x1b[B");
    press(&mut app, &mut daemon, &rx, b"\r");
    assert!(daemon.sent.is_empty(), "a checkbox is not a decision: {:?}", daemon.methods());
    let text = live_text(&app);
    assert!(text.contains("[×] also remove the stored credential"), "{text}");
    press(&mut app, &mut daemon, &rx, b"\r");
    assert!(
        live_text(&app).contains("[ ] also remove the stored credential"),
        "and it flips back"
    );

    // Back to the delete row, and confirm.
    press(&mut app, &mut daemon, &rx, b"\x1b[A");
    press(&mut app, &mut daemon, &rx, b"\r");
    let asked = removals(&daemon);
    assert_eq!(asked.len(), 1, "{:?}", daemon.methods());
    assert_eq!(asked[0].provider, "openai");
    assert_eq!(asked[0].remove_credential, Some(false));

    // `credentialRemoved` is present only when one was asked for, so a removal
    // that was not asked to touch the keychain says nothing about it.
    daemon.answers.push(Reply {
        call: daemon.sent.last().expect("the removal").clone(),
        outcome: Ok(serde_json::json!({ "ok": true, "provider": "openai",
                                        "path": "/tmp/home/.lyra/providers.toml" })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);
    assert!(committed.contains("provider removed · openai"), "{committed}");
    assert!(
        !committed.contains("credential"),
        "it claims nothing about a credential it was not asked to touch: {committed}"
    );
    assert!(!live_text(&app).contains("delete openai?"), "and the panel is gone");
}

#[test]
fn a_credential_that_was_asked_for_and_was_not_there_is_not_reported_as_kept() {
    // `credentialRemoved: false` means the keychain had nothing under that
    // entry — the end state that was asked for, reached without deleting
    // anything. Reading it as "kept" would be the opposite claim.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/provider delete openai\r");
    describes(&mut app, &mut daemon, &rx, Ok(provider_info()));
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\x1b[B\r");
    press(&mut app, &mut daemon, &rx, b"\x1b[A\r");
    daemon.answers.push(Reply {
        call: daemon.sent.last().expect("the removal").clone(),
        outcome: Ok(serde_json::json!({ "ok": true, "provider": "openai",
                                        "path": "/tmp/p.toml", "credentialRemoved": false })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);
    assert!(committed.contains("no credential was stored"), "{committed}");
    assert!(!committed.contains("kept"), "{committed}");
}

#[test]
fn a_token_that_lives_in_the_declaration_is_stated_rather_than_offered_as_a_choice() {
    // `removeCredential` deletes an OS-keychain entry and nothing else. A
    // plaintext token *is* the declaration being removed, so a checkbox for it
    // would be a choice that does nothing either way.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/provider delete openai\r");
    let mut info = provider_info();
    info["authType"] = serde_json::json!("static");
    info["authDetail"] = serde_json::Value::Null;
    describes(&mut app, &mut daemon, &rx, Ok(info));
    let text = live_text(&app);
    assert!(
        !text.contains("also remove the stored credential"),
        "there is no choice to offer: {text}"
    );
    assert!(
        text.contains("its token goes with it"),
        "so it is said instead: {text}"
    );

    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(removals(&daemon)[0].remove_credential, None);
}

#[test]
fn a_confirmed_credential_removal_says_so_and_so_do_the_roles_left_behind() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/provider delete openai\r");
    describes(&mut app, &mut daemon, &rx, Ok(provider_info()));
    daemon.sent.clear();
    // Toggle on, back up, delete.
    press(&mut app, &mut daemon, &rx, b"\x1b[B\r");
    press(&mut app, &mut daemon, &rx, b"\x1b[A\r");
    assert_eq!(removals(&daemon)[0].remove_credential, Some(true));

    daemon.answers.push(Reply {
        call: daemon.sent.last().expect("the removal").clone(),
        outcome: Ok(serde_json::json!({ "ok": true, "provider": "openai",
                                        "path": "/tmp/p.toml", "credentialRemoved": true,
                                        "danglingRoles": ["default"] })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);
    assert!(committed.contains("credential removed"), "{committed}");
    assert!(
        committed.contains("roles still name it: default — /model to repoint"),
        "a role pointing at nothing is the one thing left to do: {committed}"
    );
}

#[test]
fn a_provider_with_nothing_stored_is_not_asked_whether_to_remove_it() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/provider delete local\r");
    let mut info = provider_info();
    info["provider"] = serde_json::json!("local");
    info["authType"] = serde_json::json!("none");
    info["authDetail"] = serde_json::Value::Null;
    describes(&mut app, &mut daemon, &rx, Ok(info));
    let text = live_text(&app);
    assert!(
        !text.contains("also remove the stored credential"),
        "there is nothing to have an opinion about: {text}"
    );

    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\r");
    let asked = removals(&daemon);
    assert_eq!(asked.len(), 1, "{:?}", daemon.methods());
    assert_eq!(asked[0].remove_credential, None);
    let encoded = serde_json::to_string(asked[0]).expect("params encode");
    assert!(!encoded.contains("removeCredential"), "{encoded}");
}

#[test]
fn refusing_to_remove_the_provider_in_use_is_rendered_with_the_way_out() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/provider delete anthropic\r");
    let mut info = provider_info();
    info["provider"] = serde_json::json!("anthropic");
    info["inUse"] = serde_json::json!(true);
    describes(&mut app, &mut daemon, &rx, Ok(info));
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\r");

    daemon.answers.push(Reply {
        call: daemon.sent.last().expect("the removal").clone(),
        outcome: Err("anthropic is the provider this session is using.".to_owned()),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);
    assert!(committed.contains("is the provider this session is using"), "{committed}");
    assert!(
        committed.contains("/model to switch, then delete it"),
        "a refusal without the way out is a dead end: {committed}"
    );
    assert!(!app.finished());
}

#[test]
fn escaping_the_confirmation_removes_nothing() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/provider delete openai\r");
    describes(&mut app, &mut daemon, &rx, Ok(provider_info()));
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\x1b");
    assert!(!live_text(&app).contains("delete openai?"));
    assert!(daemon.sent.is_empty(), "{:?}", daemon.methods());

    // And so does the cancel row, which is the same answer with a keystroke.
    press(&mut app, &mut daemon, &rx, b"/provider delete openai\r");
    describes(&mut app, &mut daemon, &rx, Ok(provider_info()));
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\x1b[B\x1b[B");
    press(&mut app, &mut daemon, &rx, b"\r");
    assert!(removals(&daemon).is_empty(), "{:?}", daemon.methods());
    assert!(!live_text(&app).contains("delete openai?"));
}

#[test]
fn the_bare_verbs_open_the_picker_in_that_mode_and_a_bad_name_never_leaves_the_client() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    picker(&mut app, &mut daemon, &rx, b"/provider delete\r");
    let text = live_text(&app);
    assert!(text.contains("delete provider"), "the title carries the mode: {text}");
    assert!(
        !text.contains("+ add a provider"),
        "there is nothing to delete about a provider that does not exist: {text}"
    );
    assert!(
        text.contains("in use · /model to switch first"),
        "the row a removal will be refused for says so first: {text}"
    );
    // Accepting a row here deletes rather than opening the menu.
    press(&mut app, &mut daemon, &rx, b"\x1b[B\r");
    assert_eq!(
        daemon.sent,
        vec![Call::ProviderGet {
            provider: "openai".to_owned(),
            purpose: Purpose::Delete,
        }]
    );
    assert!(live_text(&app).contains("delete openai?"), "{}", live_text(&app));
    press(&mut app, &mut daemon, &rx, b"\x1b");

    let (mut app, mut daemon, (_tx, rx)) =
        (super::tests::app(), ScriptedDaemon::default(), wire());
    picker(&mut app, &mut daemon, &rx, b"/provider edit\r");
    assert!(live_text(&app).contains("edit provider"), "{}", live_text(&app));
    press(&mut app, &mut daemon, &rx, b"\x1b[B\r");
    assert_eq!(
        daemon.methods(),
        vec!["provider/setup_options", "provider/get"],
        "and accepting one opens the edit form"
    );

    // An argument that cannot name a provider is a typo, not a round trip.
    let (mut app, mut daemon, (_tx, rx)) =
        (super::tests::app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/provider delete Open AI\r");
    assert!(daemon.sent.is_empty(), "{:?}", daemon.methods());
    assert!(scrollback(&mut app).contains("usage: /provider delete"), "two words is not a name");
    press(&mut app, &mut daemon, &rx, b"/provider edit OpenAI\r");
    assert!(daemon.sent.is_empty(), "{:?}", daemon.methods());
    assert!(scrollback(&mut app).contains("no provider is named OpenAI"));

    // …and `/provider` with anything else is still the daemon's report.
    press(&mut app, &mut daemon, &rx, b"/provider status\r");
    assert_eq!(daemon.sent, vec![Call::Command("/provider status".to_owned())]);
}

#[test]
fn a_normalised_endpoint_is_adopted_into_the_field_rather_than_applied_behind_it() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    form(&mut app, &mut daemon, &rx);
    endpoint(&mut app, &mut daemon, &rx, "https://api.openai.com/v1/");
    detects(
        &mut app,
        &mut daemon,
        &rx,
        Ok(serde_json::json!({ "apiTypes": ["openai_responses"], "suggestedName": "openai",
                               "authRequired": true,
                               "normalizedBaseUrl": ENDPOINT })),
    );
    let text = live_text(&app);
    assert!(text.contains(ENDPOINT), "{text}");
    assert!(
        !text.contains("/v1/ "),
        "the field holds what will be written, not what was typed: {text}"
    );
    assert!(text.contains("endpoint normalised"), "and it says it did: {text}");

    // The adopted URL is the probed one, so leaving the field again asks nothing.
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\x1b[Z\t");
    assert!(daemon.sent.is_empty(), "{:?}", daemon.methods());

    // protocol → name → credential → key, then save.
    press(&mut app, &mut daemon, &rx, b"\t\t\t");
    press(&mut app, &mut daemon, &rx, KEY.as_bytes());
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(
        added(&daemon).first().map(|params| params.base_url.clone()),
        Some(ENDPOINT.to_owned()),
        "and it is what gets saved"
    );
}

#[test]
fn a_slash_model_with_an_argument_still_goes_to_the_daemons_router() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/model opus-5\r");
    assert_eq!(
        daemon.sent,
        vec![Call::Command("/model opus-5".to_owned())],
        "an instruction is not a question"
    );
}

#[test]
fn the_theme_picker_previews_on_highlight_and_a_dismissal_puts_it_back() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    let before = app.theme_name().to_owned();
    press(&mut app, &mut daemon, &rx, b"/theme\r");
    assert!(daemon.sent.is_empty(), "the theme is this terminal's, not the session's");
    press(&mut app, &mut daemon, &rx, b"\x1b[B");
    let previewed = app.theme_name().to_owned();
    assert_ne!(previewed, before, "highlighting applies it live");
    press(&mut app, &mut daemon, &rx, b"\x1b");
    assert_eq!(app.theme_name(), before, "dismissing is what makes it a preview");

    press(&mut app, &mut daemon, &rx, b"/theme\r");
    press(&mut app, &mut daemon, &rx, b"\x1b[B");
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(app.theme_name(), previewed, "accepting keeps it");
}

// ---------------------------------------------------------------------------
// The provider form
// ---------------------------------------------------------------------------

/// The credential every form test types. Short, obvious in a failure message,
/// and asserted **absent** from every rendered row and every debug dump.
const KEY: &str = "sk-test-9f1c0d";

/// The endpoint most of them type.
const ENDPOINT: &str = "https://api.openai.com/v1";

/// `provider/setup_options`, as `packages/lyra-app/src/provider-setup.ts`
/// answers it: two presets, four persistence choices, three protocols.
fn catalog() -> serde_json::Value {
    serde_json::json!({
        "presets": [
            { "id": "openai", "label": "OpenAI", "detail": "Official API",
              "provider": "openai", "baseUrl": "https://api.openai.com/v1",
              "apiType": "openai_responses", "model": "gpt-5.6",
              "fastModel": "gpt-5.6-luna", "mergeModel": "gpt-5.6", "websocket": "auto",
              "authEnvVar": "OPENAI_API_KEY", "needsKey": true, "envVarSet": false,
              "custom": false },
            { "id": "local", "label": "Local", "detail": "Ollama · no credential",
              "provider": "local", "baseUrl": "http://localhost:11434/v1",
              "apiType": "openai_completions", "model": "qwen2.5-coder:14b",
              "needsKey": false, "custom": false }
        ],
        "persist": [
            { "id": "keychain", "label": "OS keychain",
              "detail": "the token never enters a file", "available": true },
            { "id": "env", "label": "Environment variable", "available": true },
            { "id": "plaintext", "label": "providers.toml", "available": true },
            { "id": "none", "label": "No credential", "available": true }
        ],
        "apiTypes": [
            { "id": "openai_responses", "label": "OpenAI responses" },
            { "id": "openai_completions", "label": "OpenAI chat completions" },
            { "id": "anthropic_messages", "label": "Anthropic messages" }
        ],
        "path": "/tmp/home/.lyra/providers.toml",
        "configured": []
    })
}

/// Open the form through `/provider add` and let its catalog land. There is no
/// preset step: this is where every test below starts, and the caret is already
/// in the endpoint field.
fn form(app: &mut App, daemon: &mut ScriptedDaemon, events: &Receiver<AcpEvent>) {
    press(app, daemon, events, b"/provider add\r");
    assert_eq!(
        daemon.sent,
        vec![Call::ProviderSetupOptions],
        "`/provider` is a report in the daemon's catalog, so `add` is ours"
    );
    daemon.answers.push(Reply {
        call: Call::ProviderSetupOptions,
        outcome: Ok(catalog()),
    });
    press(app, daemon, events, b"");
    daemon.sent.clear();
}

/// Type an endpoint and leave the field, which is what asks the daemon what is
/// at the other end of it.
fn endpoint(app: &mut App, daemon: &mut ScriptedDaemon, events: &Receiver<AcpEvent>, url: &str) {
    press(app, daemon, events, url.as_bytes());
    press(app, daemon, events, b"\t");
}

/// Answer the outstanding `provider/detect`.
fn detects(
    app: &mut App,
    daemon: &mut ScriptedDaemon,
    events: &Receiver<AcpEvent>,
    outcome: Result<serde_json::Value, String>,
) {
    let call = daemon
        .sent
        .iter()
        .rev()
        .find(|call| matches!(call, Call::ProviderDetect(_)))
        .expect("a detection went out")
        .clone();
    daemon.answers.push(Reply { call, outcome });
    press(app, daemon, events, b"");
}

/// The params of every `provider/add` that went out, in order.
fn added(daemon: &ScriptedDaemon) -> Vec<&wire::AddProviderParams> {
    daemon
        .sent
        .iter()
        .filter_map(|call| match call {
            Call::ProviderAdd(params) => Some(params.as_ref()),
            _ => None,
        })
        .collect()
}

/// Answer every outstanding `provider/add` with the same result body, with the
/// provider id filled in from the request so two saves answer as themselves.
fn saves(
    app: &mut App,
    daemon: &mut ScriptedDaemon,
    events: &Receiver<AcpEvent>,
    body: &serde_json::Value,
) {
    let answers: Vec<Reply> = daemon
        .sent
        .iter()
        .filter(|call| matches!(call, Call::ProviderAdd(_)))
        .map(|call| {
            let Call::ProviderAdd(params) = call else {
                unreachable!("filtered")
            };
            let mut result = body.clone();
            result["provider"] = serde_json::json!(params.provider);
            Reply {
                call: call.clone(),
                outcome: Ok(result),
            }
        })
        .collect();
    daemon.answers.extend(answers);
    press(app, daemon, events, b"");
}

fn detected(daemon: &ScriptedDaemon) -> Option<&wire::DetectProviderParams> {
    daemon.sent.iter().find_map(|call| match call {
        Call::ProviderDetect(params) => Some(params.as_ref()),
        _ => None,
    })
}

fn verified(daemon: &ScriptedDaemon) -> Option<&wire::VerifyProviderParams> {
    daemon.sent.iter().find_map(|call| match call {
        Call::ProviderVerify(params) => Some(params.as_ref()),
        _ => None,
    })
}

#[test]
fn the_form_asks_the_endpoint_first_and_leaving_it_detects_what_is_there() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    form(&mut app, &mut daemon, &rx);

    let text = live_text(&app);
    assert!(text.contains("add a provider") && text.contains("endpoint"), "{text}");
    assert!(
        !text.contains("Official API"),
        "there is no preset step: the catalog's vendor rows are not a screen any more: {text}"
    );
    assert!(
        text.contains("— choose —"),
        "and the protocol is unchosen until something concrete says otherwise: {text}"
    );

    press(&mut app, &mut daemon, &rx, ENDPOINT.as_bytes());
    assert!(
        detected(&daemon).is_none(),
        "typing an endpoint is not one round trip per keystroke"
    );

    press(&mut app, &mut daemon, &rx, b"\t");
    let probe = detected(&daemon).expect("leaving the field asks what is there");
    assert_eq!(probe.base_url, ENDPOINT);
    assert!(
        live_text(&app).contains("detecting"),
        "pending is visible while it is: {}",
        live_text(&app)
    );

    detects(
        &mut app,
        &mut daemon,
        &rx,
        Ok(serde_json::json!({ "apiTypes": ["openai_responses"],
                               "suggestedName": "openai", "authRequired": true })),
    );
    let text = live_text(&app);
    assert!(
        text.contains("OpenAI responses"),
        "the protocol came back filled in, in the catalog's own words: {text}"
    );
    assert!(text.contains("openai"), "and so did the name: {text}");
    assert!(text.contains("detected · OpenAI responses"), "{text}");
    assert!(
        !text.contains("will be saved") && !text.contains("protocols detected"),
        "one protocol is one provider, and counting it out loud is noise on \
         the ordinary setup: {text}"
    );
    assert!(
        !text.contains("+ provider") && !text.contains("this entry"),
        "and there is no second entry to explain: {text}"
    );
    assert!(
        text.contains("OS keychain"),
        "an endpoint that wants a credential opens on somewhere to put one: {text}"
    );

    // Moving on does not ask again: one endpoint, one detection.
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\t\t");
    assert!(daemon.sent.is_empty(), "{:?}", daemon.methods());
}

#[test]
fn enter_leaves_the_endpoint_field_too_and_detects_from_there() {
    // `Enter` on any field but the last means "next", so it leaves the endpoint
    // exactly as `Tab` does — and asking only on `Tab` would be a rule the hint
    // line does not state.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    form(&mut app, &mut daemon, &rx);
    press(&mut app, &mut daemon, &rx, b"http://localhost:11434/v1");
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(
        detected(&daemon).map(|params| params.base_url.clone()),
        Some("http://localhost:11434/v1".to_owned())
    );
    assert!(
        added(&daemon).is_empty(),
        "and it is not a save: {:?}",
        daemon.methods()
    );
}

#[test]
fn saving_sends_provider_add_with_no_model_and_never_selects_anything() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    form(&mut app, &mut daemon, &rx);
    endpoint(&mut app, &mut daemon, &rx, ENDPOINT);
    detects(
        &mut app,
        &mut daemon,
        &rx,
        Ok(serde_json::json!({ "apiTypes": ["openai_responses"],
                               "suggestedName": "openai", "authRequired": true })),
    );

    // protocol → name → credential → key. Three tabs, because the
    // environment-variable field is hidden while the keychain is the choice.
    press(&mut app, &mut daemon, &rx, b"\t\t\t");
    press(&mut app, &mut daemon, &rx, KEY.as_bytes());
    let text = live_text(&app);
    assert!(!text.contains(KEY), "the credential was rendered: {text}");
    assert!(!text.contains("sk-"), "even a prefix of it: {text}");
    assert!(text.contains(&"•".repeat(KEY.chars().count())), "{text}");

    // Ctrl+T: the optional check. It carries the credential, and nothing else.
    press(&mut app, &mut daemon, &rx, b"\x14");
    let probe = verified(&daemon).expect("a probe went out");
    assert_eq!(probe.base_url, ENDPOINT);
    assert_eq!(probe.api_type, wire::ConfigurableApiType::OpenAiResponses);
    assert_eq!(probe.api_key.as_ref().map(Secret::expose), Some(KEY));
    assert_eq!(probe.timeout_ms, Some(6_000), "the deadline is the daemon's");
    daemon.answers.push(Reply {
        call: daemon.sent.last().expect("the probe").clone(),
        outcome: Ok(serde_json::json!({ "ok": true, "models": 42,
                                        "sample": ["gpt-5.6", "gpt-5.6-luna"] })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    assert!(live_text(&app).contains("reached · 42 models"), "{}", live_text(&app));

    // Enter on the last field saves.
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\r");
    let requests = added(&daemon);
    assert_eq!(requests.len(), 1, "{:?}", daemon.methods());
    assert_eq!(requests[0].provider, "openai");
    assert_eq!(requests[0].base_url, ENDPOINT);
    assert_eq!(requests[0].api_type, wire::ConfigurableApiType::OpenAiResponses);
    assert_eq!(requests[0].persist, wire::ProviderPersist::Keychain);
    assert_eq!(requests[0].api_key.as_ref().map(Secret::expose), Some(KEY));
    assert_eq!(
        requests[0].model, None,
        "the form does not ask for a model, so it cannot send a guessed one"
    );
    let encoded = serde_json::to_string(requests[0]).expect("params encode");
    assert!(!encoded.contains("model"), "and none reaches the wire: {encoded}");

    saves(
        &mut app,
        &mut daemon,
        &rx,
        &serde_json::json!({
            "ok": true, "auth": "keychain", "modelsDiscovered": 42,
            "path": "/tmp/home/.lyra/providers.toml",
            "warnings": ["The keychain entry was created."]
        }),
    );
    assert!(
        !daemon
            .sent
            .iter()
            .any(|call| matches!(call, Call::SelectProvider { .. })),
        "adding is not switching: {:?}",
        daemon.methods()
    );
    let committed = scrollback(&mut app);
    assert!(
        committed.contains("provider saved · openai · 42 models discovered — /model to switch"),
        "{committed}"
    );
    assert!(committed.contains("The keychain entry was created."), "{committed}");
    assert!(!committed.contains(KEY), "the credential reached scrollback: {committed}");

    // And the panel is gone: the session proceeds normally.
    assert!(!live_text(&app).contains("add a provider"), "{}", live_text(&app));
    press(&mut app, &mut daemon, &rx, b"now do it\r");
    assert_eq!(app.composer().text(), "", "the composer is live again");
    assert!(daemon.prompts().contains(&"now do it"));

    // The last line of defence: nothing that went on the wire prints the key.
    let printed = format!("{:?}", daemon.sent);
    assert!(!printed.contains("sk-"), "a credential reached Debug: {printed}");
}

#[test]
fn an_endpoint_that_lists_no_models_says_so_and_points_at_the_way_out() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    form(&mut app, &mut daemon, &rx);
    endpoint(&mut app, &mut daemon, &rx, "http://localhost:8080/v1");
    detects(
        &mut app,
        &mut daemon,
        &rx,
        Ok(serde_json::json!({ "apiTypes": ["openai_completions"],
                               "suggestedName": "local", "authRequired": false })),
    );
    // `none` needs no credential, so the choice field is the last one.
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\t\t\r");
    assert_eq!(added(&daemon).len(), 1, "{:?}", daemon.methods());

    // No `modelsDiscovered` at all: absent is *unknown*, never zero.
    saves(
        &mut app,
        &mut daemon,
        &rx,
        &serde_json::json!({ "ok": true, "auth": "none", "path": "/tmp/p.toml" }),
    );
    let committed = scrollback(&mut app);
    assert!(
        committed.contains("provider saved · local · no model listing — /model add to declare one"),
        "{committed}"
    );
}

#[test]
fn one_endpoint_that_speaks_two_protocols_saves_one_provider_per_protocol() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    form(&mut app, &mut daemon, &rx);
    endpoint(&mut app, &mut daemon, &rx, "http://localhost:4000/v1");
    detects(
        &mut app,
        &mut daemon,
        &rx,
        Ok(serde_json::json!({ "apiTypes": ["openai_completions", "anthropic_messages"],
                               "suggestedName": "gateway", "authRequired": false })),
    );

    let text = live_text(&app);
    assert!(
        text.contains("2 protocols detected — 2 providers will be saved"),
        "the outcome is stated, not implied: {text}"
    );
    assert!(
        text.contains("both detected · this entry"),
        "so the protocol choice stops reading as an either/or: {text}"
    );
    assert!(
        text.contains("+ provider") && text.contains("gateway-anthropic"),
        "one row per extra protocol, named after the primary: {text}"
    );
    assert!(
        text.contains("second provider · Anthropic messages · clear to skip"),
        "and the row says it is a second entry, which protocol, and how to \
         decline it: {text}"
    );
    assert!(
        text.contains("No credential"),
        "an endpoint that answered unauthenticated opens on `none`: {text}"
    );

    // Renaming the primary renames what was derived from it.
    press(&mut app, &mut daemon, &rx, b"\t");
    press(&mut app, &mut daemon, &rx, b"\x15");
    press(&mut app, &mut daemon, &rx, b"litellm");
    press(&mut app, &mut daemon, &rx, b"\t");
    let text = live_text(&app);
    assert!(text.contains("litellm-anthropic"), "{text}");
    assert!(
        text.contains("2 providers will be saved"),
        "and renaming changes no count: {text}"
    );

    // credential → the second-entry row, which is the last visible field.
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\t\r");
    let requests = added(&daemon);
    assert_eq!(requests.len(), 2, "{:?}", daemon.methods());
    assert_eq!(requests[0].provider, "litellm");
    assert_eq!(
        requests[0].api_type,
        wire::ConfigurableApiType::OpenAiCompletions
    );
    assert_eq!(requests[1].provider, "litellm-anthropic");
    assert_eq!(
        requests[1].api_type,
        wire::ConfigurableApiType::AnthropicMessages
    );
    for request in &requests {
        assert_eq!(request.base_url, "http://localhost:4000/v1");
        assert_eq!(request.persist, wire::ProviderPersist::NoCredential);
        assert!(request.api_key.is_none(), "{request:?}");
    }

    saves(
        &mut app,
        &mut daemon,
        &rx,
        &serde_json::json!({ "ok": true, "auth": "none", "path": "/tmp/p.toml",
                             "modelsDiscovered": 7 }),
    );
    let committed = scrollback(&mut app);
    assert!(committed.contains("provider saved · litellm ·"), "{committed}");
    assert!(
        committed.contains("provider saved · litellm-anthropic ·"),
        "both entries are reported: {committed}"
    );
    assert_eq!(
        committed.matches("provider saved").count(),
        2,
        "one committed line per entry, so the plurality the form promised is \
         the plurality the transcript shows: {committed}"
    );
    assert!(!live_text(&app).contains("add a provider"), "and the form is done");
}

#[test]
fn clearing_a_second_entry_name_skips_that_protocol() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    form(&mut app, &mut daemon, &rx);
    endpoint(&mut app, &mut daemon, &rx, "http://localhost:4000/v1");
    detects(
        &mut app,
        &mut daemon,
        &rx,
        Ok(serde_json::json!({ "apiTypes": ["openai_completions", "anthropic_messages"],
                               "suggestedName": "gateway", "authRequired": false })),
    );
    // name → credential → the second-entry row, then clear it.
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\t\t\t");
    press(&mut app, &mut daemon, &rx, b"\x15");
    let text = live_text(&app);
    assert!(
        text.contains("2 protocols detected — 1 provider will be saved"),
        "the count follows the keystroke that changed it: {text}"
    );
    assert!(
        !text.contains("2 providers will be saved"),
        "the stale count is gone rather than merely contradicted: {text}"
    );
    assert!(
        text.contains("Anthropic messages · skipped · name it to save it"),
        "and the emptied row says the skip took, with the way back: {text}"
    );

    press(&mut app, &mut daemon, &rx, b"\r");
    let requests = added(&daemon);
    assert_eq!(
        requests.len(),
        1,
        "what was counted is what went out: {:?}",
        daemon.methods()
    );
    assert_eq!(requests[0].provider, "gateway");
    assert_eq!(
        requests[0].api_type,
        wire::ConfigurableApiType::OpenAiCompletions
    );

    saves(
        &mut app,
        &mut daemon,
        &rx,
        &serde_json::json!({ "ok": true, "auth": "none", "path": "/tmp/p.toml" }),
    );
    assert_eq!(
        scrollback(&mut app).matches("provider saved").count(),
        1,
        "and one committed line, matching the one the form counted"
    );
}

#[test]
fn choosing_the_extra_protocol_as_the_primary_moves_the_row_rather_than_duplicating_it() {
    // The two rows are one endpoint's two protocols, and which of them is
    // *this* entry is a choice like any other: making the second one primary
    // must leave the first as the extra, not save the same protocol twice.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    form(&mut app, &mut daemon, &rx);
    endpoint(&mut app, &mut daemon, &rx, "http://localhost:4000/v1");
    detects(
        &mut app,
        &mut daemon,
        &rx,
        Ok(serde_json::json!({ "apiTypes": ["openai_completions", "anthropic_messages"],
                               "suggestedName": "gateway", "authRequired": false })),
    );

    // The caret is on the protocol field: one step right is the other detected
    // protocol, which is also the one the extra row was for.
    press(&mut app, &mut daemon, &rx, b"\x1b[C");
    let text = live_text(&app);
    assert!(text.contains("Anthropic messages"), "the primary moved: {text}");
    assert!(
        text.contains("gateway-completions") && !text.contains("gateway-anthropic"),
        "and the row swapped with it, rather than staying beside itself: {text}"
    );
    assert!(
        text.contains("2 protocols detected — 2 providers will be saved"),
        "the count is unchanged, because the set of protocols is: {text}"
    );

    // name → credential → the extra row, which is the last visible field.
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\t\t\t\r");
    let requests = added(&daemon);
    assert_eq!(requests.len(), 2, "{:?}", daemon.methods());
    assert_eq!(requests[0].provider, "gateway");
    assert_eq!(
        requests[0].api_type,
        wire::ConfigurableApiType::AnthropicMessages
    );
    assert_eq!(requests[1].provider, "gateway-completions");
    assert_eq!(
        requests[1].api_type,
        wire::ConfigurableApiType::OpenAiCompletions
    );
}

#[test]
fn three_protocols_number_the_rows_and_the_count_line_follows_a_skip() {
    // The plural is not a special case of two: the rows are ordinals over the
    // entries that will actually be written, and a skip renumbers them rather
    // than leaving a "third provider" beside a line that promises two.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    form(&mut app, &mut daemon, &rx);
    endpoint(&mut app, &mut daemon, &rx, "http://localhost:4000/v1");
    detects(
        &mut app,
        &mut daemon,
        &rx,
        Ok(
            serde_json::json!({ "apiTypes": ["openai_responses", "openai_completions",
                                             "anthropic_messages"],
                                "suggestedName": "gateway", "authRequired": false }),
        ),
    );

    let text = live_text(&app);
    assert!(
        text.contains("3 protocols detected — 3 providers will be saved"),
        "{text}"
    );
    assert!(text.contains("3 detected · this entry"), "{text}");
    assert!(
        text.contains("second provider · OpenAI chat completions · clear to skip"),
        "{text}"
    );
    assert!(
        text.contains("third provider · Anthropic messages · clear to skip"),
        "{text}"
    );

    // name → credential → the first extra row, cleared.
    press(&mut app, &mut daemon, &rx, b"\t\t\t");
    press(&mut app, &mut daemon, &rx, b"\x15");
    let text = live_text(&app);
    assert!(
        text.contains("3 protocols detected — 2 providers will be saved"),
        "{text}"
    );
    assert!(
        text.contains("OpenAI chat completions · skipped · name it to save it"),
        "{text}"
    );
    assert!(
        text.contains("second provider · Anthropic messages · clear to skip"),
        "the row that is still being saved is the second one now: {text}"
    );

    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\t\r");
    let requests = added(&daemon);
    assert_eq!(requests.len(), 2, "{:?}", daemon.methods());
    assert_eq!(requests[0].provider, "gateway");
    assert_eq!(
        requests[0].api_type,
        wire::ConfigurableApiType::OpenAiResponses
    );
    assert_eq!(requests[1].provider, "gateway-anthropic");
    assert_eq!(
        requests[1].api_type,
        wire::ConfigurableApiType::AnthropicMessages
    );
}

#[test]
fn clearing_the_row_and_then_making_its_protocol_primary_still_saves_it_once() {
    // The awkward corner: a skipped protocol that becomes the chosen one. What
    // must hold is that nothing is saved twice and the count line is never a
    // number the save then contradicts.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    form(&mut app, &mut daemon, &rx);
    endpoint(&mut app, &mut daemon, &rx, "http://localhost:4000/v1");
    detects(
        &mut app,
        &mut daemon,
        &rx,
        Ok(serde_json::json!({ "apiTypes": ["openai_completions", "anthropic_messages"],
                               "suggestedName": "gateway", "authRequired": false })),
    );
    // name → credential → the extra row, cleared, then back to the protocol.
    press(&mut app, &mut daemon, &rx, b"\t\t\t");
    press(&mut app, &mut daemon, &rx, b"\x15");
    assert!(
        live_text(&app).contains("1 provider will be saved"),
        "{}",
        live_text(&app)
    );
    press(&mut app, &mut daemon, &rx, b"\x1b[Z\x1b[Z\x1b[Z\x1b[C");

    // The skip was of a *row*, and that row is gone: what is left is the other
    // protocol, offered by the same default as ever — "save what I found". That
    // is a second entry again, and the line that used to say one now says two
    // rather than leaving the extra add to be discovered in the transcript.
    let text = live_text(&app);
    assert!(text.contains("Anthropic messages"), "{text}");
    assert!(
        text.contains("2 protocols detected — 2 providers will be saved"),
        "the count is recomputed, never remembered: {text}"
    );
    assert!(
        !text.contains("1 provider will be saved"),
        "and there is exactly one count on screen: {text}"
    );

    // name → credential → the extra row, then save.
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\t\t\t\r");
    let requests = added(&daemon);
    assert_eq!(
        requests.len(),
        2,
        "the save is what the form counted: {:?}",
        daemon.methods()
    );
    let mut protocols: Vec<String> = requests
        .iter()
        .map(|params| params.api_type.as_str().to_owned())
        .collect();
    protocols.sort_unstable();
    protocols.dedup();
    assert_eq!(
        protocols.len(),
        requests.len(),
        "no protocol is saved twice: {requests:?}"
    );
    let mut names: Vec<&str> = requests
        .iter()
        .map(|params| params.provider.as_str())
        .collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), requests.len(), "and no name is: {requests:?}");
}

#[test]
fn a_failed_detection_leaves_a_manual_choice_and_the_protocol_is_still_required() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    form(&mut app, &mut daemon, &rx);
    endpoint(&mut app, &mut daemon, &rx, ENDPOINT);
    detects(
        &mut app,
        &mut daemon,
        &rx,
        Err("acp: method not found".to_owned()),
    );

    let text = live_text(&app);
    assert!(text.contains("not detected · choose one"), "{text}");
    assert!(
        text.contains("— choose —"),
        "the protocol stays empty rather than being guessed: {text}"
    );
    assert!(text.contains("method not found"), "{text}");
    assert!(!app.finished(), "detection is a convenience, not a gate");

    // Fill everything else in and try to save: an unchosen protocol is refused
    // here rather than written as an "auto" that fails on the first request.
    press(&mut app, &mut daemon, &rx, b"\t");
    press(&mut app, &mut daemon, &rx, b"openai");
    press(&mut app, &mut daemon, &rx, b"\t\t");
    press(&mut app, &mut daemon, &rx, KEY.as_bytes());
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\r");
    assert!(added(&daemon).is_empty(), "{:?}", daemon.methods());
    let text = live_text(&app);
    assert!(text.contains("a protocol is required"), "{text}");

    // Choosing one by hand — the field is focused, since it is the offender.
    press(&mut app, &mut daemon, &rx, b"\x1b[C");
    assert!(live_text(&app).contains("OpenAI responses"), "{}", live_text(&app));
    press(&mut app, &mut daemon, &rx, b"\t\t\t\r");
    let requests = added(&daemon);
    assert_eq!(requests.len(), 1, "{:?}", daemon.methods());
    assert_eq!(
        requests[0].api_type,
        wire::ConfigurableApiType::OpenAiResponses
    );
    assert_eq!(requests[0].api_key.as_ref().map(Secret::expose), Some(KEY));
}

#[test]
fn a_detection_answer_for_an_endpoint_that_has_been_retyped_is_dropped() {
    // A probe is slow by nature. Filling the protocol in from an answer about a
    // URL the user has since changed is a lie about the only thing it answers.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    form(&mut app, &mut daemon, &rx);
    endpoint(&mut app, &mut daemon, &rx, ENDPOINT);
    let stale = daemon.sent.last().expect("a detection").clone();

    // Back into the endpoint field, and change it.
    press(&mut app, &mut daemon, &rx, b"\x1b[Z");
    press(&mut app, &mut daemon, &rx, b"2");
    daemon.answers.push(Reply {
        call: stale,
        outcome: Ok(serde_json::json!({ "apiTypes": ["anthropic_messages"] })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    assert!(
        !live_text(&app).contains("Anthropic messages"),
        "{}",
        live_text(&app)
    );

    // Leaving the new endpoint asks about the new endpoint.
    press(&mut app, &mut daemon, &rx, b"\t");
    let probe = daemon
        .sent
        .iter()
        .filter_map(|call| match call {
            Call::ProviderDetect(params) => Some(params.as_ref()),
            _ => None,
        })
        .next_back()
        .expect("a second detection");
    assert_eq!(probe.base_url, format!("{ENDPOINT}2"));
}

#[test]
fn a_rejected_save_keeps_the_form_and_says_why() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    form(&mut app, &mut daemon, &rx);
    endpoint(&mut app, &mut daemon, &rx, ENDPOINT);
    detects(
        &mut app,
        &mut daemon,
        &rx,
        Ok(serde_json::json!({ "apiTypes": ["openai_responses"],
                               "suggestedName": "openai", "authRequired": true })),
    );
    press(&mut app, &mut daemon, &rx, b"\t\t\t");
    press(&mut app, &mut daemon, &rx, KEY.as_bytes());
    press(&mut app, &mut daemon, &rx, b"\r");

    daemon.answers.push(Reply {
        call: daemon.sent.last().expect("the save").clone(),
        outcome: Err("This machine has no OS keychain Lyra can write to.".to_owned()),
    });
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"");

    let text = live_text(&app);
    assert!(text.contains("no OS keychain"), "{text}");
    assert!(
        text.contains(&"•".repeat(KEY.chars().count())),
        "the user's next move is one field, not five: {text}"
    );
    assert!(daemon.sent.is_empty(), "a rejected save switches to nothing");

    // Cycling the credential source to one that works and saving again is the
    // whole point of leaving the form up.
    press(&mut app, &mut daemon, &rx, b"\x1b[Z\x1b[C\x1b[C");
    // The credential the user typed is still there — hiding a field does not
    // empty it — so one Enter advances to it and the next saves.
    press(&mut app, &mut daemon, &rx, b"\r\r");
    let requests = added(&daemon);
    assert_eq!(requests.len(), 1, "{:?}", daemon.methods());
    assert_eq!(requests[0].persist, wire::ProviderPersist::Plaintext);
}

#[test]
fn the_environment_source_hides_the_key_field_and_cannot_send_one() {
    // The rule the daemon enforces with an error, enforced here as a form that
    // does not ask: `persist: env` names a variable and carries no credential.
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    form(&mut app, &mut daemon, &rx);
    endpoint(&mut app, &mut daemon, &rx, ENDPOINT);
    detects(
        &mut app,
        &mut daemon,
        &rx,
        Ok(serde_json::json!({ "apiTypes": ["openai_responses"],
                               "suggestedName": "openai", "authRequired": true })),
    );
    press(&mut app, &mut daemon, &rx, b"\t\t\t");
    press(&mut app, &mut daemon, &rx, KEY.as_bytes());

    // Back to the credential source and one step right: keychain → env.
    press(&mut app, &mut daemon, &rx, b"\x1b[Z\x1b[C");
    let text = live_text(&app);
    assert!(text.contains("Environment variable"), "{text}");
    assert!(!text.contains('•'), "the key field is gone, not merely ignored: {text}");

    press(&mut app, &mut daemon, &rx, b"\t");
    press(&mut app, &mut daemon, &rx, b"OPENAI_API_KEY");
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\r");
    let requests = added(&daemon);
    assert_eq!(requests.len(), 1, "{:?}", daemon.methods());
    assert_eq!(requests[0].persist, wire::ProviderPersist::Env);
    assert_eq!(requests[0].auth_env_var.as_deref(), Some("OPENAI_API_KEY"));
    assert!(
        requests[0].api_key.is_none(),
        "a typed-then-hidden credential must not be sent: {:?}",
        requests[0]
    );
    let encoded = serde_json::to_string(requests[0]).expect("params encode");
    assert!(!encoded.contains("apiKey"), "{encoded}");
}

#[test]
fn an_invalid_field_is_marked_and_nothing_goes_out() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    form(&mut app, &mut daemon, &rx);
    endpoint(&mut app, &mut daemon, &rx, ENDPOINT);
    detects(
        &mut app,
        &mut daemon,
        &rx,
        Ok(serde_json::json!({ "apiTypes": ["openai_responses"],
                               "suggestedName": "openai", "authRequired": true })),
    );
    // Ctrl+U clears the suggested name; the caret is at the end of it.
    press(&mut app, &mut daemon, &rx, b"\t");
    press(&mut app, &mut daemon, &rx, b"\x15");
    press(&mut app, &mut daemon, &rx, b"\t\t");
    press(&mut app, &mut daemon, &rx, KEY.as_bytes());
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\r");

    assert!(added(&daemon).is_empty(), "{:?}", daemon.methods());
    let text = live_text(&app);
    assert!(text.contains("lowercase letters"), "{text}");
    assert!(text.contains("1 field to fix"), "{text}");

    // The focus moved to the offending field, so typing fixes it.
    press(&mut app, &mut daemon, &rx, b"openai");
    press(&mut app, &mut daemon, &rx, b"\t\t\r");
    assert_eq!(
        added(&daemon).first().map(|params| params.provider.clone()),
        Some("openai".to_owned())
    );
}

#[test]
fn first_run_goes_from_nothing_to_a_saved_provider_without_a_switch() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    let snapshot: wire::SessionSnapshot = serde_json::from_value(serde_json::json!({
        "descriptor": { "sessionId": "s-1", "name": "first-run" },
        "entries": [], "provider": "", "model": "", "providerConfigured": false
    }))
    .expect("a snapshot decodes");
    app.adopt_snapshot(&snapshot);
    app.hydrate(&mut daemon);

    assert_eq!(
        daemon.methods(),
        vec!["session/commands", "checkpoint/list", "provider/setup_options"],
        "the form opens itself when there is nothing to prompt with"
    );
    daemon.answers.push(Reply {
        call: Call::ProviderSetupOptions,
        outcome: Ok(catalog()),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let text = live_text(&app);
    assert!(text.contains("add a provider") && text.contains("endpoint"), "{text}");
    assert!(
        scrollback(&mut app).contains("no provider configured"),
        "and it says why"
    );

    daemon.sent.clear();
    endpoint(&mut app, &mut daemon, &rx, "http://localhost:11434/v1");
    detects(
        &mut app,
        &mut daemon,
        &rx,
        Ok(serde_json::json!({ "apiTypes": ["openai_completions"],
                               "suggestedName": "localhost", "authRequired": false })),
    );
    // protocol → name → credential, which is the last field when no credential
    // is wanted, so the next Enter saves.
    press(&mut app, &mut daemon, &rx, b"\t\t\r");
    assert_eq!(added(&daemon).len(), 1);
    saves(
        &mut app,
        &mut daemon,
        &rx,
        &serde_json::json!({ "ok": true, "auth": "none", "path": "/tmp/p.toml",
                             "modelsDiscovered": 3 }),
    );

    assert!(
        !daemon
            .sent
            .iter()
            .any(|call| matches!(call, Call::SelectProvider { .. } | Call::SelectModel(_))),
        "nothing is auto-selected: {:?}",
        daemon.methods()
    );
    let committed = scrollback(&mut app);
    assert!(committed.contains("provider saved · localhost · 3 models"), "{committed}");
    assert!(committed.contains("ready · type to start the session"), "{committed}");

    // The session proceeds: the banner is gone and the composer is live.
    assert!(!live_text(&app).contains("add a provider"), "{}", live_text(&app));
    press(&mut app, &mut daemon, &rx, b"hello\r");
    assert_eq!(daemon.prompts(), vec!["hello"]);
}

#[test]
fn a_configured_daemon_is_left_alone_and_so_is_one_that_predates_the_field() {
    for configured in [serde_json::json!(true), serde_json::Value::Null] {
        let mut app = super::tests::app();
        let mut daemon = ScriptedDaemon::default();
        let snapshot: wire::SessionSnapshot = serde_json::from_value(serde_json::json!({
            "descriptor": { "sessionId": "s-1", "name": "ordinary" },
            "entries": [], "provider": "anthropic", "model": "opus-5",
            "providerConfigured": configured
        }))
        .expect("a snapshot decodes");
        app.adopt_snapshot(&snapshot);
        app.hydrate(&mut daemon);
        assert_eq!(daemon.methods(), vec!["session/commands", "checkpoint/list"]);
    }
}

#[test]
fn esc_dismisses_the_form_and_leaves_everything_as_it_was() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"half a thought");
    press(&mut app, &mut daemon, &rx, b"\x10");
    press(&mut app, &mut daemon, &rx, b"/provider add");
    press(&mut app, &mut daemon, &rx, b"\r");
    daemon.answers.push(Reply {
        call: Call::ProviderSetupOptions,
        outcome: Ok(catalog()),
    });
    press(&mut app, &mut daemon, &rx, b"");
    endpoint(&mut app, &mut daemon, &rx, ENDPOINT);
    press(&mut app, &mut daemon, &rx, b"\t\t\t");
    press(&mut app, &mut daemon, &rx, KEY.as_bytes());
    let borrowed = app.desired_region_height(12);
    assert!(borrowed > 12, "the form borrowed rows from the region");

    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\x1b");
    assert!(!live_text(&app).contains("add a provider"), "{}", live_text(&app));
    assert!(daemon.sent.is_empty(), "cancelling saves nothing");
    assert_eq!(
        app.composer().text(),
        "half a thought",
        "the first esc dismissed the overlay and went no further down the ladder"
    );
    assert_eq!(app.desired_region_height(12), 12, "and gave the rows back");

    // Reopening starts from a fresh catalog request, not from the abandoned one.
    press(&mut app, &mut daemon, &rx, b"");
    assert!(daemon.sent.is_empty());
    press(&mut app, &mut daemon, &rx, b"\x10");
    press(&mut app, &mut daemon, &rx, b"provider add\r");
    assert_eq!(daemon.sent, vec![Call::ProviderSetupOptions]);
}

#[test]
fn a_catalog_that_never_arrives_closes_the_form_instead_of_hanging() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/provider add\r");
    daemon.answers.push(Reply {
        call: Call::ProviderSetupOptions,
        outcome: Err("acp: method not found".to_owned()),
    });
    press(&mut app, &mut daemon, &rx, b"");
    assert!(!live_text(&app).contains("add a provider"), "{}", live_text(&app));
    assert!(scrollback(&mut app).contains("method not found"));
    assert!(!app.finished());
}

// ---------------------------------------------------------------------------
// `/model add`
// ---------------------------------------------------------------------------

#[test]
fn slash_model_add_with_arguments_goes_straight_to_the_daemon() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/model add local qwen2.5-coder:14b\r");
    assert_eq!(
        daemon.sent,
        vec![Call::ModelAdd {
            provider: "local".to_owned(),
            model: "qwen2.5-coder:14b".to_owned(),
        }],
        "`/model` switches in the daemon's router, so declaring one is ours"
    );

    daemon.answers.push(Reply {
        call: daemon.sent[0].clone(),
        outcome: Ok(serde_json::json!({ "ok": true, "provider": "local",
                                        "model": "qwen2.5-coder:14b" })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    assert!(
        scrollback(&mut app).contains("model added · local/qwen2.5-coder:14b — /model to switch"),
        "one line, and it says where the model now is"
    );
}

#[test]
fn a_bare_slash_model_add_opens_a_two_field_form() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/model add\r");
    assert_eq!(
        daemon.sent,
        vec![Call::Providers],
        "the provider is a choice, not a second thing to spell correctly"
    );

    daemon.answers.push(Reply {
        call: Call::Providers,
        outcome: Ok(serde_json::json!({ "current": "local",
                                        "available": ["anthropic", "local"] })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let text = live_text(&app);
    assert!(text.contains("add a model"), "{text}");
    assert!(text.contains("local"), "opened on the active provider: {text}");
    assert!(
        !text.contains("+ add a provider"),
        "the provider *picker* did not open: {text}"
    );

    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\t");
    press(&mut app, &mut daemon, &rx, b"qwen2.5-coder:14b");
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(
        daemon.sent,
        vec![Call::ModelAdd {
            provider: "local".to_owned(),
            model: "qwen2.5-coder:14b".to_owned(),
        }]
    );

    daemon.answers.push(Reply {
        call: daemon.sent[0].clone(),
        outcome: Ok(serde_json::json!({ "ok": true, "provider": "local",
                                        "model": "qwen2.5-coder:14b" })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    assert!(scrollback(&mut app).contains("model added · local/qwen2.5-coder:14b"));
    assert!(!live_text(&app).contains("add a model"), "and the form is done");
}

#[test]
fn an_empty_model_id_is_refused_before_it_reaches_the_daemon() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/model add\r");
    daemon.answers.push(Reply {
        call: Call::Providers,
        outcome: Ok(serde_json::json!({ "current": "local", "available": ["local"] })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\t\r");
    assert!(daemon.sent.is_empty(), "{:?}", daemon.methods());
    assert!(live_text(&app).contains("a model id is required"), "{}", live_text(&app));
}

// ---------------------------------------------------------------------------
// Slash results
// ---------------------------------------------------------------------------

#[test]
fn a_models_result_reaches_scrollback_as_a_table_and_never_as_json() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    hydrate(&mut app, &mut daemon, &rx);
    press(&mut app, &mut daemon, &rx, b"/models\r");
    assert_eq!(daemon.sent, vec![Call::Command("/models".to_owned())]);
    let _ = scrollback(&mut app);

    daemon.answers.push(Reply {
        call: Call::Command("/models".to_owned()),
        outcome: Ok(serde_json::json!({
            "command": "models",
            "output": {
                "provider": "anthropic",
                "current": "opus-5",
                "models": [
                    { "id": "opus-5", "ownedBy": "anthropic", "contextWindow": 200_000 },
                    { "id": "sonnet-4", "ownedBy": "anthropic", "contextWindow": 200_000 }
                ]
            }
        })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);
    assert!(committed.contains("opus-5"), "{committed}");
    assert!(committed.contains("context window"), "a header row: {committed}");
    assert!(committed.contains("200,000"), "{committed}");
    for brace in ['{', '}', '[', ']'] {
        assert!(
            !committed.contains(brace),
            "a raw JSON {brace} reached the terminal:\n{committed}"
        );
    }
    // The renderer was chosen by the registry's declared `resultKind`, since
    // this payload carries none of its own.
    let marked = committed
        .lines()
        .find(|line| line.contains("opus-5"))
        .expect("a row for the current model");
    assert!(marked.trim_start().starts_with('▸'), "{marked:?}");
}

#[test]
fn a_command_answer_this_build_has_no_renderer_for_is_a_tree_not_a_dump() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/dump\r");
    let _ = scrollback(&mut app);
    daemon.answers.push(Reply {
        call: Call::Command("/dump".to_owned()),
        outcome: Ok(serde_json::json!({
            "command": "dump",
            "output": { "somethingNew": { "path": "/tmp/x", "entries": 12 } }
        })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);
    assert!(committed.contains("something new"), "{committed}");
    assert!(committed.contains("/tmp/x"), "{committed}");
    assert!(!committed.contains('{'), "{committed}");
}

#[test]
fn the_methods_the_app_speaks_are_exactly_the_four_it_declares() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"one\r");
    press(&mut app, &mut daemon, &rx, b"two\r");
    press(&mut app, &mut daemon, &rx, b"\x13");
    // Cancels, and rewinds `one` into the composer…
    let start = Instant::now();
    press_at(&mut app, &mut daemon, &rx, b"\x1b", start);
    assert_eq!(app.composer().text(), "one");
    // …which the next two *deliberate* presses arm and clear, sending nothing.
    press_at(&mut app, &mut daemon, &rx, b"\x1b", start + DELIBERATE);
    press_at(&mut app, &mut daemon, &rx, b"\x1b", start + DELIBERATE * 2);
    assert!(app.composer().is_empty());
    press(&mut app, &mut daemon, &rx, b"/health\r");
    assert_eq!(
        daemon.methods(),
        vec![
            "session/prompt",
            "session/steer",
            "session/cancel",
            "session/command",
        ]
    );
}



// ---------------------------------------------------------------------------
// Resuming a session: the picker, the load, and the history that follows
// ---------------------------------------------------------------------------

/// A `session/snapshot` result, as the daemon would put it on the wire.
fn snapshot_value(name: &str, entries: serde_json::Value) -> serde_json::Value {
    snapshot_at("s-9", name, "e-6", entries)
}

/// The same, for a test that cares which session it is or where its head is.
fn snapshot_at(
    session: &str,
    name: &str,
    head: &str,
    entries: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "descriptor": { "sessionId": session, "name": name, "headId": head },
        "entries": entries, "provider": "anthropic", "model": "opus-5"
    })
}

/// The same, decoded.
fn snapshot_of(name: &str, entries: serde_json::Value) -> wire::SessionSnapshot {
    serde_json::from_value(snapshot_value(name, entries)).expect("a snapshot decodes")
}

/// A decoded snapshot of a named session at a named head.
fn snapshot_of_at(
    session: &str,
    name: &str,
    head: &str,
    entries: serde_json::Value,
) -> wire::SessionSnapshot {
    serde_json::from_value(snapshot_at(session, name, head, entries)).expect("a snapshot decodes")
}

/// One transcript entry, with the envelope every entry carries.
fn entry(id: &str, body: serde_json::Value) -> serde_json::Value {
    let mut value = serde_json::json!({
        "id": id, "parentId": null, "timestamp": "2026-08-09T10:00:00.000Z"
    });
    let object = value.as_object_mut().expect("an object");
    for (key, member) in body.as_object().expect("an object") {
        object.insert(key.clone(), member.clone());
    }
    value
}

/// A conversation with one of everything the replay is supposed to interpret:
/// a prompt, prose, a tool call answered a message later, a compaction, and
/// three entries that must leave no trace — thinking, running totals, and a
/// type this build has never heard of.
fn history() -> serde_json::Value {
    serde_json::json!([
        entry("e-0", serde_json::json!({ "type": "session", "sessionId": "s-9",
            "name": "purple-falcon", "origin": "/o", "workspace": "/w",
            "provider": "anthropic", "model": "opus-5" })),
        entry("e-1", serde_json::json!({ "type": "message", "role": "user", "status": "complete",
            "content": [{ "type": "text", "text": "fix the retry ladder" }] })),
        entry("e-2", serde_json::json!({ "type": "message", "role": "assistant", "status": "complete",
            "content": [
                { "type": "thinking", "thinking": "a private musing" },
                { "type": "text", "text": "## Looking at it now" },
                { "type": "tool_use", "id": "c-1", "name": "bash",
                  "input": { "command": "cargo test" } }] })),
        entry("e-3", serde_json::json!({ "type": "message", "role": "user", "status": "complete",
            "content": [{ "type": "tool_result", "toolUseId": "c-1",
                          "content": "697 passed; 0 failed" }] })),
        entry("e-4", serde_json::json!({ "type": "boundary", "kind": "compaction",
            "firstKeptEntry": null, "summary": "earlier work",
            "tokensBefore": 40_000, "tokensAfter": 2_000 })),
        entry("e-5", serde_json::json!({ "type": "usage", "inputTokens": 10, "outputTokens": 2 })),
        entry("e-6", serde_json::json!({ "type": "telemetry", "frames": 12 })),
    ])
}

/// The index of the first row containing `needle`, for order assertions.
fn at(text: &str, needle: &str) -> usize {
    text.lines()
        .position(|line| line.contains(needle))
        .unwrap_or_else(|| panic!("no row contains {needle:?} in:\n{text}"))
}

#[test]
fn loading_a_session_renders_its_history_through_a_snapshot_it_asks_for_itself() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/sessions\r");
    assert_eq!(daemon.sent, vec![Call::Sessions], "{:?}", daemon.methods());
    daemon.answers.push(Reply {
        call: Call::Sessions,
        outcome: Ok(serde_json::json!([{ "sessionId": "s-9", "name": "purple-falcon",
                                         "path": "/tmp/purple-falcon.jsonl", "active": false }])),
    });
    press(&mut app, &mut daemon, &rx, b"");
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(
        daemon.sent,
        vec![Call::LoadSession("purple-falcon".to_owned())],
        "accepting a row loads that session"
    );

    // `session/load` answers with a descriptor and no conversation, so the
    // client asks for one the moment the daemon says the transcript changed.
    daemon.sent.clear();
    tx.send(update(
        r#"{"sessionUpdate":"session_changed","reason":"load",
            "descriptor":{"sessionId":"s-9","name":"purple-falcon"}}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    assert_eq!(daemon.methods(), vec!["session/snapshot"]);

    daemon.answers.push(Reply {
        call: Call::Snapshot,
        outcome: Ok(snapshot_value("purple-falcon", history())),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);

    // The conversation is on screen, in the order it happened, bracketed so live
    // output visibly begins after it.
    assert!(committed.contains("history · purple-falcon"), "{committed}");
    assert!(at(&committed, "> fix the retry ladder") < at(&committed, "Looking at it now"));
    assert!(at(&committed, "Looking at it now") < at(&committed, "bash"));
    assert!(at(&committed, "bash") < at(&committed, "compacted"));
    assert!(committed.contains("cargo test"), "the tool row keeps its subject");
    assert!(committed.contains("697 passed"), "and its real result: {committed}");
    assert!(
        at(&committed, "compacted") < at(&committed, "resumed · purple-falcon · 3 messages"),
        "{committed}"
    );
    // Thinking never reaches scrollback live, so a replay must not put it there
    // either; running totals belong to the footer; an unknown entry type is a
    // newer daemon talking, and says nothing.
    assert!(!committed.contains("private musing"), "{committed}");
    assert!(!committed.contains("telemetry"), "{committed}");
    assert!(!committed.contains("inputTokens"), "{committed}");
}

#[test]
fn a_resumed_session_replays_thinking_under_the_same_rule_the_live_path_used() {
    // `full` is the mode that asked to see reasoning, and a resumed session that
    // hid what a live one showed would be the same inconsistency in reverse.
    let mut verbose = app().with_thinking(ThinkingMode::Full);
    verbose.adopt_snapshot(&snapshot_of("purple-falcon", history()));
    let committed = scrollback(&mut verbose);
    assert!(committed.contains("a private musing"), "{committed}");
    // In block order, before the prose it preceded.
    assert!(at(&committed, "a private musing") < at(&committed, "Looking at it now"));

    // `off` is the mode that asked not to, and `collapsed` has nothing to say:
    // the one-liner's whole content is a duration, and a persisted transcript
    // carries none.
    for mode in [ThinkingMode::Off, ThinkingMode::Collapsed] {
        let mut quiet = app().with_thinking(mode);
        quiet.adopt_snapshot(&snapshot_of("purple-falcon", history()));
        let committed = scrollback(&mut quiet);
        assert!(!committed.contains("a private musing"), "{mode:?}: {committed}");
        assert!(!committed.contains('∴'), "{mode:?}: {committed}");
    }
}

#[test]
fn a_startup_snapshot_renders_history_and_a_repeated_answer_does_not_double_it() {
    let mut app = app();
    app.adopt_snapshot(&snapshot_of("purple-falcon", history()));
    let first = scrollback(&mut app);
    assert!(first.contains("> fix the retry ladder"), "{first}");
    assert!(first.contains("resumed · purple-falcon · 3 messages"), "{first}");

    // `session_changed` and a `session/load` reply can both lead to a snapshot.
    // The same transcript twice is one conversation, not two.
    app.adopt_snapshot(&snapshot_of("purple-falcon", history()));
    assert_eq!(scrollback(&mut app), "", "the second answer adds nothing");
}

/// The first three entries of [`history`]: what a rewind of one turn leaves.
fn rewound_history() -> serde_json::Value {
    let serde_json::Value::Array(mut entries) = history() else {
        panic!("history is an array")
    };
    entries.truncate(3);
    serde_json::Value::Array(entries)
}

#[test]
fn a_rewind_of_the_session_on_screen_replays_no_history_and_marks_itself_once() {
    // The live defect: Esc cancelled the turn, the daemon rewound the head and
    // reported it, and the client answered a moved head by reprinting the entire
    // conversation under a `history` rule — directly below the still-visible live
    // copy of the same conversation.
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    app.adopt_snapshot(&snapshot_of("purple-falcon", history()));
    assert!(
        scrollback(&mut app).contains("history · purple-falcon"),
        "the session was resumed once, which is the replay this test is about not repeating"
    );

    tx.send(update(
        r#"{"sessionUpdate":"session_changed","reason":"rewind",
            "descriptor":{"sessionId":"s-9","name":"purple-falcon"}}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    assert_eq!(
        daemon.methods(),
        vec!["session/snapshot"],
        "the store still re-syncs from the snapshot: what is gated is scrollback"
    );
    assert_eq!(
        scrollback(&mut app),
        "",
        "and the transcript on screen is neither dropped nor re-headed"
    );

    daemon.answers.push(Reply {
        call: Call::Snapshot,
        outcome: Ok(snapshot_at("s-9", "purple-falcon", "e-2", rewound_history())),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);
    assert_eq!(
        committed.trim(),
        "session rewind · back to 2 messages",
        "one dim marker, and not one row of replayed history: {committed:?}"
    );
    assert_eq!(
        app.store().descriptor().and_then(|d| d.head_id.as_deref()),
        Some("e-2"),
        "the store took the new head"
    );
}

#[test]
fn a_snapshot_of_the_same_session_at_the_same_head_says_nothing_at_all() {
    // A steer or a refresh asks for a snapshot the head has not moved under.
    // Nothing changed, so nothing is drawn — not even a marker.
    let mut app = app();
    app.adopt_snapshot(&snapshot_of("purple-falcon", history()));
    let _ = scrollback(&mut app);
    app.adopt_snapshot(&snapshot_of("purple-falcon", history()));
    assert_eq!(scrollback(&mut app), "");
}

#[test]
fn loading_away_and_back_replays_because_it_is_a_genuine_re_entry() {
    let mut app = app();
    app.adopt_snapshot(&snapshot_of("purple-falcon", history()));
    assert!(scrollback(&mut app).contains("history · purple-falcon"));

    app.adopt_snapshot(&snapshot_of_at("s-4", "lone-otter", "e-1", history()));
    assert!(
        scrollback(&mut app).contains("history · lone-otter"),
        "a different session is a different conversation"
    );

    app.adopt_snapshot(&snapshot_of("purple-falcon", history()));
    assert!(
        scrollback(&mut app).contains("history · purple-falcon"),
        "and coming back is a second visit, not a duplicate"
    );
}

#[test]
fn a_cancelled_turn_replays_as_one_line_not_two() {
    // The daemon states a cancellation twice: `status` on the entry, and a
    // `marker` block whose own text says "cancelled" a second time. One line.
    let mut app = app();
    let entries = serde_json::json!([
        entry("e-1", serde_json::json!({ "type": "message", "role": "user", "status": "complete",
            "content": [{ "type": "text", "text": "start something long" }] })),
        entry("e-2", serde_json::json!({ "type": "message", "role": "assistant",
            "status": "cancelled",
            "content": [
                { "type": "text", "text": "beginning to " },
                { "type": "marker", "reason": "cancelled",
                  "detail": "The user cancelled the turn; partial assistant output was retained. Turn cancelled by user" }] })),
    ]);
    app.adopt_snapshot(&snapshot_of("purple-falcon", entries));
    let committed = scrollback(&mut app);

    assert_eq!(
        committed.matches("cancelled").count(),
        1,
        "one line per cancelled turn: {committed}"
    );
    assert!(committed.contains("cancelled · partial output kept"), "{committed}");
    assert!(
        !committed.contains("partial assistant output was retained"),
        "the marker's own redundant sentence is not a second line: {committed}"
    );
    assert!(committed.contains("beginning to"), "partial output is kept: {committed}");
}

#[test]
fn a_cancellation_with_no_status_still_leaves_exactly_one_line() {
    // The marker is the fallback, not a second line: a transcript that carries
    // only the marker still says the turn was cancelled, in the same words.
    let mut app = app();
    let entries = serde_json::json!([
        entry("e-1", serde_json::json!({ "type": "message", "role": "assistant",
            "content": [{ "type": "marker", "reason": "cancelled", "detail": "stopped" }] })),
    ]);
    app.adopt_snapshot(&snapshot_of("purple-falcon", entries));
    let committed = scrollback(&mut app);
    assert_eq!(committed.matches("cancelled").count(), 1, "{committed}");
    assert!(committed.contains("cancelled · partial output kept"), "{committed}");
}

#[test]
fn an_empty_session_is_not_bracketed_as_if_it_had_history() {
    // A brand-new transcript: its session entry and nothing else.
    let entries = serde_json::json!([entry(
        "e-0",
        serde_json::json!({ "type": "session", "sessionId": "s-9", "name": "fresh",
                            "origin": "/o", "workspace": "/w",
                            "provider": "anthropic", "model": "opus-5" })
    )]);
    let mut fresh = app();
    fresh.adopt_snapshot(&snapshot_of("fresh", entries));
    assert_eq!(scrollback(&mut fresh), "", "nothing to resume, nothing printed");

    let mut empty = app();
    empty.adopt_snapshot(&snapshot_of("fresh", serde_json::json!([])));
    assert_eq!(scrollback(&mut empty), "");
}

#[test]
fn a_replay_past_the_cap_says_how_much_it_left_out() {
    let mut app = app();
    let mut entries = vec![entry(
        "e-0",
        serde_json::json!({ "type": "session", "sessionId": "s-9", "name": "long",
                            "origin": "/o", "workspace": "/w",
                            "provider": "anthropic", "model": "opus-5" }),
    )];
    for index in 1..=(history::REPLAY_CAP + 40) {
        entries.push(entry(
            &format!("e-{index}"),
            serde_json::json!({ "type": "message", "role": "user", "status": "complete",
                                "content": [{ "type": "text", "text": format!("turn {index}") }] }),
        ));
    }
    let total = entries.len() - 1;
    app.adopt_snapshot(&snapshot_of("long", serde_json::Value::Array(entries)));
    let committed = scrollback(&mut app);

    // The cap is on rows printed, never on what the line claims: the count is
    // the whole session's, and what was dropped is named rather than missing.
    assert!(committed.contains("… 40 earlier entries not shown"), "{committed}");
    assert!(committed.contains(&format!("resumed · long · {total} messages")), "{committed}");
    assert!(!committed.contains("turn 40\n"), "{committed}");
    assert!(committed.contains(&format!("turn {total}")), "{committed}");
}

#[test]
fn a_malformed_entry_is_marked_and_skipped_while_an_unknown_one_is_silent() {
    let mut app = app();
    let entries = serde_json::json!([
        entry("e-1", serde_json::json!({ "type": "message", "role": "user", "status": "complete",
            "content": [{ "type": "text", "text": "before" }] })),
        // Not an entry at all, an entry with no type, and an entry whose content
        // is the wrong shape: three ways to be damaged, none of them fatal.
        serde_json::json!("a bare string"),
        serde_json::json!({ "id": "e-3", "parentId": null }),
        entry("e-4", serde_json::json!({ "type": "message", "role": "user", "content": 7 })),
        // A newer daemon's entry type: no marker, no complaint, no row.
        entry("e-5", serde_json::json!({ "type": "reflection", "insight": "quiet" })),
        entry("e-6", serde_json::json!({ "type": "message", "role": "user", "status": "complete",
            "content": [{ "type": "text", "text": "after" }] })),
    ]);
    app.adopt_snapshot(&snapshot_of("damaged", entries));
    let committed = scrollback(&mut app);

    assert!(at(&committed, "> before") < at(&committed, "> after"), "{committed}");
    assert_eq!(
        committed.matches("unreadable transcript entry skipped").count(),
        3,
        "one marker per damaged entry, and none for the unknown one: {committed}"
    );
    assert!(!committed.contains("quiet"), "{committed}");
    assert!(!committed.contains("reflection"), "{committed}");
}

#[test]
fn replayed_history_survives_a_purge_resize_at_the_new_width() {
    // The reason history goes through the transcript rather than straight to the
    // compositor: a purge re-renders it, so resumed rows are not stale forever.
    let mut app = app();
    app.adopt_snapshot(&snapshot_of("purple-falcon", history()));
    let _ = scrollback(&mut app);
    let replayed: String = ReplaySource::replay_rows(&mut app, 60, 2_000)
        .iter()
        .map(Row::plain_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(replayed.contains("> fix the retry ladder"), "{replayed}");
    assert!(replayed.contains("resumed · purple-falcon"), "{replayed}");
    assert!(
        replayed.lines().all(|line| line.chars().count() <= 60),
        "and at the width it was asked for:\n{replayed}"
    );
}

#[test]
fn a_session_row_says_when_how_many_and_what_and_degrades_to_its_path() {
    let now = 1_754_733_600_000_i64;
    let rows = session_choices(
        &serde_json::json!([
            { "sessionId": "s-1", "name": "purple-falcon", "path": "/tmp/a.jsonl",
              "active": true, "firstPrompt": "fix the retry ladder",
              "updatedAtMs": now - 7_200_000_i64, "messages": 34 },
            { "sessionId": "s-2", "name": "lone-otter", "path": "/tmp/b.jsonl",
              "active": false, "updatedAtMs": now - 90_000_i64, "messages": 1 },
            { "sessionId": "s-3", "name": "old-daemon", "path": "/tmp/c.jsonl", "active": false },
        ]),
        now,
    );
    assert_eq!(
        rows.iter().map(|row| row.label.as_str()).collect::<Vec<_>>(),
        vec!["purple-falcon", "lone-otter", "old-daemon"]
    );
    assert_eq!(
        rows[0].detail.as_deref(),
        Some("2h ago · 34 msgs · fix the retry ladder")
    );
    assert!(rows[0].current, "the active session is marked");
    // Absent fields are simply not rendered — never a zero, never an empty column.
    assert_eq!(rows[1].detail.as_deref(), Some("1m ago · 1 msg"));
    // And a daemon that predates the previews still gets the row it always had.
    assert_eq!(rows[2].detail.as_deref(), Some("/tmp/c.jsonl"));
}

#[test]
fn relative_time_is_coarse_and_never_runs_backwards() {
    let now = 1_754_733_600_000_i64;
    assert_eq!(relative_time(now, now), "just now");
    // A daemon whose clock is ahead of ours must not produce "-4s ago".
    assert_eq!(relative_time(now, now + 4_000), "just now");
    assert_eq!(relative_time(now, now - 59_000), "just now");
    assert_eq!(relative_time(now, now - 60_000), "1m ago");
    assert_eq!(relative_time(now, now - 7_200_000), "2h ago");
    assert_eq!(relative_time(now, now - 3 * 86_400_000), "3d ago");
    assert_eq!(relative_time(now, now - 14 * 86_400_000), "2w ago");
    assert_eq!(relative_time(now, now - 200 * 86_400_000), "6mo ago");
}

#[test]
fn bare_resume_opens_the_same_picker_sessions_does_and_a_named_one_loads() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"/resume\r");
    assert_eq!(
        daemon.sent,
        vec![Call::Sessions],
        "bare /resume asks for the list rather than demanding a name nobody knows"
    );
    daemon.answers.push(Reply {
        call: Call::Sessions,
        outcome: Ok(serde_json::json!([{ "sessionId": "s-9", "name": "purple-falcon",
                                         "path": "/tmp/p.jsonl", "active": false,
                                         "firstPrompt": "fix the retry ladder",
                                         "messages": 34 }])),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let shown = live_text(&app);
    assert!(shown.contains("purple-falcon"), "{shown}");
    assert!(shown.contains("34 msgs"), "the picker row is not a bare id: {shown}");
    press(&mut app, &mut daemon, &rx, b"\x1b");

    // With a name it is an instruction, and goes out as the load itself rather
    // than as a report to the daemon's router.
    daemon.sent.clear();
    press(&mut app, &mut daemon, &rx, b"/resume purple-falcon\r");
    assert_eq!(daemon.sent, vec![Call::LoadSession("purple-falcon".to_owned())]);
}

#[test]
fn every_other_entry_kind_lands_as_the_row_its_live_counterpart_would_have() {
    let mut app = app();
    let entries = serde_json::json!([
        // A `[report]` line is an audit row this runtime wrote itself, not
        // something the user typed: it must not come back as a user band.
        entry("e-1", serde_json::json!({ "type": "message", "role": "user", "status": "complete",
            "content": [{ "type": "text", "text": "[report] session load · purple-falcon" }] })),
        // A tool call the transcript never saw answered: pending, which renders
        // dim, rather than a success it cannot vouch for.
        entry("e-2", serde_json::json!({ "type": "message", "role": "assistant", "status": "cancelled",
            "content": [{ "type": "tool_use", "id": "c-9", "name": "bash",
                          "input": { "command": "sleep 900" } }] })),
        entry("e-3", serde_json::json!({ "type": "repair", "requestId": "r-1",
            "repairs": [{ "code": "missing_tool_result", "detail": "c-9 had no result" }] })),
        entry("e-4", serde_json::json!({ "type": "error", "classification": "rate_limit",
            "message": "429 from the provider" })),
        entry("e-5", serde_json::json!({ "type": "provider_switch", "provider": "openai",
            "model": "gpt-5.6", "apiType": "openai_responses", "losses": [] })),
        entry("e-6", serde_json::json!({ "type": "checkpoint", "openFiles": [],
            "pendingToolCallIds": [] })),
    ]);
    app.adopt_snapshot(&snapshot_of("mixed", entries));
    let committed = scrollback(&mut app);

    assert!(committed.contains("session load · purple-falcon"), "{committed}");
    assert!(!committed.contains("> [report]"), "a report is not a user turn: {committed}");
    assert!(!committed.contains("[report]"), "and the marker itself is stripped");
    assert!(committed.contains("sleep 900"), "{committed}");
    assert!(committed.contains("cancelled · partial output kept"), "{committed}");
    assert!(committed.contains("context repaired · c-9 had no result"), "{committed}");
    assert!(committed.contains("error · rate_limit · 429 from the provider"), "{committed}");
    assert!(committed.contains("provider · openai gpt-5.6"), "{committed}");
    // A checkpoint is internal bookkeeping with nothing to say on screen.
    assert!(!committed.contains("checkpoint"), "{committed}");
    // Two messages, and the line counts messages rather than entries.
    assert!(committed.contains("resumed · mixed · 2 messages"), "{committed}");
}


// ---------------------------------------------------------------------------
// Children: the presence strip and the lifecycle rows
// ---------------------------------------------------------------------------

/// One `agent` update, as a wire frame.
fn agent(body: &str) -> AcpEvent {
    update(body)
}

/// The presence strip, found by shape: it is the row carrying a presence dot.
fn strip_text(app: &App) -> Option<String> {
    app.live(app.desired_region_height(12), Instant::now())
        .rows
        .iter()
        .map(Row::plain_text)
        .find(|text| {
            let trimmed = text.trim_start();
            ["◎ ", "◍ ", "○ ", "✓ ", "✗ "]
                .iter()
                .any(|glyph| trimmed.starts_with(glyph))
                && !trimmed.contains("spawned")
                && !trimmed.contains(" · ")
        })
}

#[test]
fn no_children_means_no_presence_row_and_no_extra_region() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"");
    assert_eq!(strip_text(&app), None);
    assert_eq!(app.desired_region_height(CHROME_ROWS), CHROME_ROWS);
}

#[test]
fn a_spawned_child_appears_in_the_strip_and_leaves_one_audit_row() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    tx.send(agent(
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"activity-module",
            "status":"running","model":"gpt-5.6-terra"}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");

    // The audit row is held back so a burst of them can collapse; it settles
    // into scrollback the moment anything that is not a transition arrives.
    assert!(live_text(&app).contains("◎ spawned activity-module · gpt-5.6-terra"));
    tx.send(update(
        r#"{"sessionUpdate":"turn_end","turnId":"t1","status":"completed","durationMs":1,
            "partialRetained":false}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);
    assert!(
        committed.contains("◎ spawned activity-module · gpt-5.6-terra"),
        "{committed}"
    );
    let strip = strip_text(&app).expect("a presence row");
    assert!(strip.contains("◎ activity-module"), "{strip}");
    // The row is chrome, and the region has to have been grown for it or it
    // would be drawn off the top.
    assert_eq!(app.desired_region_height(CHROME_ROWS), CHROME_ROWS + 1);
}

#[test]
fn the_strip_names_the_running_children_and_counts_the_queued_ones() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    for (id, peer, status) in [
        ("spawn-1", "activity-module", "running"),
        ("spawn-2", "qa-checker", "awaiting_tool"),
        ("spawn-3", "docs", "queued"),
        ("spawn-4", "lint", "queued"),
    ] {
        tx.send(agent(&format!(
            r#"{{"sessionUpdate":"agent","id":"{id}","peer":"{peer}","status":"{status}"}}"#
        )))
        .expect("send");
    }
    press(&mut app, &mut daemon, &rx, b"");
    let strip = strip_text(&app).expect("a presence row");
    assert_eq!(strip.trim(), "◎ activity-module ◍ qa-checker ○ 2 queued");
}

/// A swarm is a real shape, and the row must account for every child.
#[test]
fn twenty_children_collapse_into_one_row_and_one_scrollback_line() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    for index in 0..20 {
        tx.send(agent(&format!(
            r#"{{"sessionUpdate":"agent","id":"spawn-{index}","peer":"worker-{index}",
                 "status":"running"}}"#
        )))
        .expect("send");
    }
    press(&mut app, &mut daemon, &rx, b"");
    // Nothing has settled the run yet, so it is still in the live region.
    let live = live_text(&app);
    assert!(live.contains("20 agents"), "{live}");
    assert!(live.contains("20 spawned"), "{live}");
    for row in app.live(app.desired_region_height(12), Instant::now()).rows {
        assert!(row.width() <= 80, "{:?}", row.plain_text());
    }
}

#[test]
fn a_child_that_finishes_ticks_briefly_and_then_leaves_the_strip() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    tx.send(agent(
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"activity-module","status":"running"}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    let settled_at = Instant::now();
    tx.send(agent(
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"activity-module",
            "status":"completed","toolCalls":12,"filesModified":4}"#,
    ))
    .expect("send");
    press_at(&mut app, &mut daemon, &rx, b"", settled_at);

    // The spawn and the finish are one child with two things to say, so they
    // collapse into one line that counts the child once.
    let held = live_text(&app);
    assert!(held.contains("1 agent · 1 spawned · 1 done · activity-module"), "{held}");
    // The tick is on screen…
    let drawn = app
        .live(app.desired_region_height(12), settled_at)
        .rows
        .iter()
        .map(Row::plain_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(drawn.contains("✓ activity-module"), "{drawn}");
    // …and gone once its linger is up, while the row itself stays: a chrome row
    // that collapsed 0↔1 mid-stream is exactly the jitter DESIGN.md §3 forbids.
    let later = settled_at + ui::agent::SETTLED_LINGER + Duration::from_millis(1);
    let after = app
        .live(app.desired_region_height(12), later)
        .rows
        .iter()
        .map(Row::plain_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !after.contains("✓ activity-module"),
        "the tick has expired: {after}"
    );
    assert_eq!(
        app.desired_region_height(CHROME_ROWS),
        CHROME_ROWS + 1,
        "the row survives until a turn boundary"
    );
}

#[test]
fn a_failed_child_says_why_and_where_to_go() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    tx.send(agent(
        r#"{"sessionUpdate":"agent","id":"spawn-2","peer":"qa-checker","status":"timed_out",
            "error":"deadline expired"}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    let held = live_text(&app);
    assert!(held.contains("✗ qa-checker"), "{held}");
    assert!(held.contains("timed out"), "{held}");
    assert!(held.contains("/agents"), "{held}");
}

/// The strip must survive a child arriving before anything else has.
#[test]
fn an_agent_update_before_the_snapshot_is_kept_rather_than_dropped() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    tx.send(agent(
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"early","status":"running"}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    let _ = scrollback(&mut app);

    // The snapshot lands afterwards, reporting the same child at a state it has
    // already moved past. Live wins.
    let snapshot: wire::SessionSnapshot = serde_json::from_value(serde_json::json!({
        "descriptor": { "sessionId": "s-1", "name": "n", "path": "/p", "headId": "e-1",
                        "createdAt": "t" },
        "entries": [], "provider": "p", "model": "m",
        "agents": [{ "id": "spawn-1", "peer": "early", "workspace": "/w",
                     "status": "queued", "startedAt": 0 }]
    }))
    .expect("a snapshot decodes");
    app.adopt_snapshot(&snapshot);
    let strip = strip_text(&app).expect("a presence row");
    assert!(strip.contains("◎ early"), "live wins over hydration: {strip}");
}

#[test]
fn hydration_fills_the_strip_for_a_client_that_attached_mid_session() {
    let mut app = app();
    let snapshot: wire::SessionSnapshot = serde_json::from_value(serde_json::json!({
        "descriptor": { "sessionId": "s-1", "name": "n", "path": "/p", "headId": "e-1",
                        "createdAt": "t" },
        "entries": [], "provider": "p", "model": "m",
        "agents": [{ "id": "spawn-1", "peer": "activity-module", "workspace": "/w",
                     "status": "awaiting_tool", "startedAt": 0 },
                   { "id": "spawn-2", "peer": "already-done", "workspace": "/w",
                     "status": "completed", "startedAt": 0 }]
    }))
    .expect("a snapshot decodes");
    app.adopt_snapshot(&snapshot);
    let strip = strip_text(&app).expect("a presence row");
    assert!(strip.contains("◍ activity-module"), "{strip}");
    // A child that was already finished when this client attached never earned
    // a `✓` on screen, so it is history rather than presence.
    assert!(!strip.contains("already-done"), "{strip}");
}

/// Both the strip and an overlay grow the live region; only one of them is
/// drawn at a time, and the region must not be grown for both.
#[test]
fn an_overlay_does_not_pay_for_the_presence_row_it_covers() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    tx.send(agent(
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"worker","status":"running"}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    let with_strip = app.desired_region_height(CHROME_ROWS);
    press(&mut app, &mut daemon, &rx, b"\x10");
    let with_overlay = app.desired_region_height(CHROME_ROWS);
    assert!(with_overlay > with_strip, "the panel grows the region");
    assert_eq!(strip_text(&app), None, "and replaces the strip entirely");
}

/// The strip is chrome, and DESIGN.md §3 lets it grow mid-stream but shrink
/// only at a turn boundary. Both halves, in one session.
#[test]
fn the_presence_row_shrinks_only_at_a_turn_boundary() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    tx.send(agent(
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"worker","status":"running"}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    assert_eq!(app.desired_region_height(CHROME_ROWS), CHROME_ROWS + 1);

    // The child finishes *mid-turn*. The row must not vanish under the composer.
    tx.send(agent(
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"worker","status":"completed"}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    assert_eq!(
        app.desired_region_height(CHROME_ROWS),
        CHROME_ROWS + 1,
        "a child finishing mid-stream never collapses the row"
    );

    // The turn boundary is where it is allowed to go.
    tx.send(update(
        r#"{"sessionUpdate":"turn_end","turnId":"t1","status":"completed","durationMs":1,
            "partialRetained":false}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    assert_eq!(
        app.desired_region_height(CHROME_ROWS),
        CHROME_ROWS,
        "and only there"
    );
}

/// A turn ending while a child is still working keeps the row: the rule is
/// "shrink at a boundary", not "shrink at every boundary".
#[test]
fn a_turn_boundary_keeps_the_row_while_a_child_is_still_running() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    tx.send(agent(
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"long-runner","status":"awaiting_tool"}"#,
    ))
    .expect("send");
    tx.send(update(
        r#"{"sessionUpdate":"turn_end","turnId":"t1","status":"completed","durationMs":1,
            "partialRetained":false}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    assert_eq!(app.desired_region_height(CHROME_ROWS), CHROME_ROWS + 1);
    assert!(strip_text(&app).is_some_and(|row| row.contains("long-runner")));
}

/// The daemon says which transition this *is*; the client does not have to
/// guess. `started` and `revived` are both `running`, so guessing cannot work.
#[test]
fn a_declared_revival_earns_its_own_row_instead_of_a_silent_second_run() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    for body in [
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"activity-module","status":"queued",
            "event":"spawned","model":"opus-5"}"#,
        // `started`: the present tense, and the present tense is the strip's.
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"activity-module","status":"running",
            "event":"started"}"#,
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"activity-module","status":"completed",
            "event":"completed","toolCalls":4}"#,
        // Parked, then woken. Status goes back to `running` exactly as `started`
        // did, which is the whole reason the field exists.
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"activity-module","status":"running",
            "event":"revived","model":"opus-5"}"#,
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"activity-module","status":"completed",
            "event":"completed","toolCalls":9}"#,
    ] {
        tx.send(agent(body)).expect("send");
    }
    press(&mut app, &mut daemon, &rx, b"");
    // Anything that is not a transition settles the run into scrollback.
    tx.send(update(
        r#"{"sessionUpdate":"turn_end","turnId":"t1","status":"completed","durationMs":1,
            "partialRetained":false}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);

    // Four transitions, one child: the run collapses, and the tallies are
    // honest about the revival rather than folding it into the spawn.
    assert!(committed.contains("1 agent ·"), "{committed}");
    assert!(committed.contains("1 spawned"), "{committed}");
    assert!(committed.contains("1 revived"), "{committed}");
    assert!(committed.contains("2 done"), "{committed}");
    // `started` earned nothing: three kinds counted, not four.
    assert!(!committed.contains("started"), "{committed}");
}

/// The same revival, alone, so the row itself is readable.
#[test]
fn a_revival_row_says_revived_and_names_the_child() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    tx.send(agent(
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"activity-module","status":"running",
            "event":"revived","model":"opus-5"}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    let held = live_text(&app);
    assert!(held.contains("↻ revived activity-module · opus-5"), "{held}");
}

/// A declared `cancelled`/`timed_out` is a failure row even though the status
/// diff would have reached the same answer — the point is that the *declared*
/// path covers every terminal kind, not just the ones inference happened to.
#[test]
fn every_declared_terminal_transition_reaches_a_row() {
    for (transition, status) in [
        ("completed", "completed"),
        ("failed", "failed"),
        ("cancelled", "cancelled"),
        ("timed_out", "timed_out"),
    ] {
        let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
        tx.send(agent(&format!(
            r#"{{"sessionUpdate":"agent","id":"spawn-1","peer":"w","status":"{status}",
                 "event":"{transition}"}}"#
        )))
        .expect("send");
        press(&mut app, &mut daemon, &rx, b"");
        let held = live_text(&app);
        let glyph = if transition == "completed" { '✓' } else { '✗' };
        assert!(held.contains(glyph), "{transition}: {held}");
    }
}

/// The fallback, for a daemon that predates `agent.event`: transitions come
/// from the status diff, and the same state twice is not a transition.
#[test]
fn a_daemon_without_the_event_field_still_gets_rows_and_no_duplicates() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    for _ in 0..3 {
        tx.send(agent(
            r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"worker","status":"running"}"#,
        ))
        .expect("send");
    }
    press(&mut app, &mut daemon, &rx, b"");
    let held = live_text(&app);
    // One sighting, one row — not three, and therefore not collapsed either.
    assert!(held.contains("◎ spawned worker"), "{held}");
    assert!(!held.contains("agents ·"), "re-reports are not transitions: {held}");
}

// ---------------------------------------------------------------------------
// Hub asides
// ---------------------------------------------------------------------------

#[test]
fn a_hub_aside_is_rendered_as_another_agent_speaking_not_as_the_user() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    tx.send(update(
        r#"{"sessionUpdate":"steer","entryId":"e-9","text":"[hub message from activity-module] the parser tests pass now\n(Reply with hub { op: \"send\", to: \"activity-module\", message: \"...\" }. This is another agent speaking, not the user.)","at":"tool_boundary","source":"hub","from":"activity-module"}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);
    assert!(
        committed.contains("⇄ activity-module: the parser tests pass now"),
        "{committed}"
    );
    assert!(
        !committed.contains("> [hub message"),
        "never a user band: {committed}"
    );
    assert!(
        !committed.contains("Reply with hub"),
        "the envelope is written for the model, not the user: {committed}"
    );
}

#[test]
fn the_users_own_steering_still_gets_the_user_band() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    tx.send(update(
        r#"{"sessionUpdate":"steer","entryId":"e-9","text":"actually use fetch",
            "at":"tool_boundary","source":"user"}"#,
    ))
    .expect("send");
    // And a daemon that predates the field: absent reads as the user.
    tx.send(update(
        r#"{"sessionUpdate":"steer","entryId":"e-10","text":"and add a test",
            "at":"tool_boundary"}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);
    assert!(committed.contains("> actually use fetch"), "{committed}");
    assert!(committed.contains("> and add a test"), "{committed}");
    assert!(!committed.contains('⇄'), "{committed}");
}

#[test]
fn a_replayed_hub_aside_is_not_replayed_as_the_users_words() {
    let mut app = app();
    let entries = serde_json::json!([
        entry("e-1", serde_json::json!({ "type": "session", "name": "swarm" })),
        entry("e-2", serde_json::json!({ "type": "message", "role": "user", "content": [
            { "type": "text", "text": "[hub message from reviewer] found a leak in auth.ts\n(Reply with hub { op: \"send\", to: \"reviewer\", message: \"...\" }. This is another agent speaking, not the user.)" }
        ]})),
        entry("e-3", serde_json::json!({ "type": "message", "role": "user", "content": [
            { "type": "text", "text": "fix it" }
        ]})),
    ]);
    app.adopt_snapshot(&snapshot_of("swarm", entries));
    let committed = scrollback(&mut app);
    assert!(committed.contains("⇄ reviewer: found a leak in auth.ts"), "{committed}");
    assert!(committed.contains("> fix it"), "{committed}");
    assert!(!committed.contains("Reply with hub"), "{committed}");
}

/// A purge resize re-renders the transcript from *semantics* at the new width
/// (DESIGN.md §1). The wave-3 rows have to be entries for that to work — a block
/// of loose rows dropped into scrollback would come back at the old wrapping, or
/// not at all.
#[test]
fn lifecycle_rows_and_hub_asides_survive_a_purge_resize_at_the_new_width() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    tx.send(agent(
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"activity-module","status":"running",
            "event":"spawned","model":"opus-5"}"#,
    ))
    .expect("send");
    tx.send(update(
        r#"{"sessionUpdate":"steer","entryId":"e-9","text":"[hub message from reviewer] the parser tests pass now\n(Reply with hub { op: \"send\", to: \"reviewer\", message: \"...\" }. This is another agent speaking, not the user.)","at":"tool_boundary","source":"hub","from":"reviewer"}"#,
    ))
    .expect("send");
    tx.send(agent(
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"activity-module","status":"failed",
            "event":"failed","error":"the provider stopped answering"}"#,
    ))
    .expect("send");
    // Settle the held-back run: a transition is not an entry until something
    // that is not a transition arrives.
    tx.send(update(
        r#"{"sessionUpdate":"turn_end","turnId":"t1","status":"completed","durationMs":1,
            "partialRetained":false}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    let _ = scrollback(&mut app);

    for width in [40u16, 60, 100] {
        app.set_width(width);
        let rows = app.replay_rows(width, 2000);
        let replayed = rows
            .iter()
            .map(Row::plain_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(replayed.contains("◎ spawned activity-module"), "{width}: {replayed}");
        assert!(replayed.contains("✗ activity-module"), "{width}: {replayed}");
        assert!(replayed.contains("⇄ reviewer:"), "{width}: {replayed}");
        // Still another agent speaking, at every width.
        assert!(!replayed.contains("> [hub"), "{width}: {replayed}");
        for row in &rows {
            assert!(row.width() <= usize::from(width), "{:?}", row.plain_text());
        }
    }
}

// ---------------------------------------------------------------------------
// The rewind rung: Esc Esc, /rewind, and the restore confirmation
// ---------------------------------------------------------------------------

/// A `checkpoint/list` answer with `count` anchored checkpoints, newest first.
fn checkpoint_list(count: usize) -> serde_json::Value {
    let checkpoints: Vec<serde_json::Value> = (0..count)
        .map(|index| {
            serde_json::json!({
                "id": format!("c-{index}"),
                "kind": if index == 0 { "turn_start" } else { "pre_tool" },
                "label": format!("before step {index}"),
                "createdAt": "2026-08-10T09:00:00.000Z",
                "changedFiles": index + 1,
                "entryId": format!("e-{index}"),
                "excluded": [".lyra"],
            })
        })
        .collect();
    serde_json::json!({ "checkpoints": checkpoints, "available": true })
}

/// Answer whatever `checkpoint/list` is outstanding.
fn answer_checkpoints(daemon: &mut ScriptedDaemon, value: serde_json::Value) {
    let call = daemon
        .sent
        .iter()
        .rev()
        .find(|call| matches!(call, Call::Checkpoints { .. }))
        .cloned()
        .expect("a checkpoint/list went out");
    daemon.answers.push(Reply {
        call,
        outcome: Ok(value),
    });
}

#[test]
fn the_rewind_rung_stays_out_of_the_ladder_until_there_is_something_to_go_back_to() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    app.hydrate(&mut daemon);
    press(&mut app, &mut daemon, &rx, b"");
    assert!(!app.can_rewind(), "no checkpoints, no rung");
    // …and its hint is off the hint line, which is the difference between an
    // unimplemented feature and a lying one.
    assert!(!live_text(&app).contains("rewind"), "{}", live_text(&app));

    answer_checkpoints(&mut daemon, checkpoint_list(3));
    press(&mut app, &mut daemon, &rx, b"");
    assert!(app.can_rewind(), "the daemon reported three");
}

#[test]
fn a_directory_that_cannot_hold_checkpoints_never_offers_the_rung() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    app.hydrate(&mut daemon);
    answer_checkpoints(
        &mut daemon,
        serde_json::json!({ "checkpoints": [], "available": false,
                            "unavailable": "no git in PATH" }),
    );
    press(&mut app, &mut daemon, &rx, b"");
    assert!(!app.can_rewind());
    // And a background refresh that found nothing says nothing: there is
    // nothing the user did, and nothing they can do.
    assert_eq!(scrollback(&mut app).trim(), "");
}

#[test]
fn esc_esc_opens_a_confirmation_offering_conversation_only_or_code_as_well() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    app.hydrate(&mut daemon);
    answer_checkpoints(&mut daemon, checkpoint_list(3));
    press(&mut app, &mut daemon, &rx, b"");

    // The ladder's last rung is armed, then confirmed — a deliberate second
    // press, not a mash.
    let first = Instant::now();
    press_at(&mut app, &mut daemon, &rx, b"\x1b", first);
    assert!(live_text(&app).contains("esc again to rewind"), "{}", live_text(&app));
    press_at(&mut app, &mut daemon, &rx, b"\x1b", first + DELIBERATE);
    // The list is re-fetched before anything destructive is offered.
    answer_checkpoints(&mut daemon, checkpoint_list(3));
    press(&mut app, &mut daemon, &rx, b"");

    let panel = live_text(&app);
    assert!(panel.contains("rewind to before step 0?"), "{panel}");
    assert!(panel.contains("conversation only"), "{panel}");
    assert!(panel.contains("conversation and code"), "{panel}");
    assert!(panel.contains("cancel"), "{panel}");
}

#[test]
fn conversation_only_moves_the_head_and_touches_no_file() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    app.hydrate(&mut daemon);
    answer_checkpoints(&mut daemon, checkpoint_list(2));
    press(&mut app, &mut daemon, &rx, b"");
    press(&mut app, &mut daemon, &rx, b"/rewind\r");
    answer_checkpoints(&mut daemon, checkpoint_list(2));
    press(&mut app, &mut daemon, &rx, b"");
    // Choose the newest checkpoint, then the conversation-only row.
    press(&mut app, &mut daemon, &rx, b"\r");
    press(&mut app, &mut daemon, &rx, b"\r");

    assert_eq!(
        daemon.sent.last(),
        Some(&Call::Rewind {
            entry_id: Some("e-0".to_owned())
        })
    );
    assert!(
        !daemon.sent.iter().any(|call| matches!(call, Call::Restore { .. })),
        "nothing on disk was touched"
    );
}

#[test]
fn conversation_and_code_rewinds_the_head_first_and_never_forces() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    app.hydrate(&mut daemon);
    answer_checkpoints(&mut daemon, checkpoint_list(2));
    press(&mut app, &mut daemon, &rx, b"");
    press(&mut app, &mut daemon, &rx, b"/rewind\r");
    answer_checkpoints(&mut daemon, checkpoint_list(2));
    press(&mut app, &mut daemon, &rx, b"");
    press(&mut app, &mut daemon, &rx, b"\r");
    // Second row: conversation and code.
    press(&mut app, &mut daemon, &rx, b"\x1b[B\r");

    let tail: Vec<&Call> = daemon.sent.iter().rev().take(2).collect();
    assert_eq!(
        tail,
        vec![
            &Call::Restore {
                checkpoint: "c-0".to_owned(),
                force: false
            },
            &Call::Rewind {
                entry_id: Some("e-0".to_owned())
            },
        ],
        "the head moves first, and the restore never forces"
    );
}

#[test]
fn a_restore_reports_what_it_did_not_do_and_only_then_offers_to_override_it() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    app.hydrate(&mut daemon);
    answer_checkpoints(&mut daemon, checkpoint_list(1));
    press(&mut app, &mut daemon, &rx, b"");
    press(&mut app, &mut daemon, &rx, b"/rewind\r");
    answer_checkpoints(&mut daemon, checkpoint_list(1));
    press(&mut app, &mut daemon, &rx, b"");
    press(&mut app, &mut daemon, &rx, b"\r");
    press(&mut app, &mut daemon, &rx, b"\x1b[B\r");

    daemon.answers.push(Reply {
        call: Call::Restore {
            checkpoint: "c-0".to_owned(),
            force: false,
        },
        outcome: Ok(serde_json::json!({
            "target": { "id": "c-0", "kind": "turn_start", "label": "before step 0",
                        "createdAt": "t", "changedFiles": 1, "excluded": [] },
            "safety": { "id": "c-99", "kind": "pre_restore", "label": "before restore",
                        "createdAt": "t", "changedFiles": 1, "excluded": [] },
            "restored": ["src/auth.ts"],
            "preserved": ["README.md", "build/out.js"],
            "forced": false,
            "excluded": [".lyra"]
        })),
    });
    press(&mut app, &mut daemon, &rx, b"");

    let committed = scrollback(&mut app);
    assert!(committed.contains("restored 1 file"), "{committed}");
    // The undo is named, or the restore should not have been offered.
    assert!(committed.contains("/rollback c-99"), "{committed}");
    // The never-clobber rule, by name rather than by count.
    assert!(committed.contains("README.md"), "{committed}");
    assert!(committed.contains("build/out.js"), "{committed}");
    assert!(committed.contains(".lyra"), "the excluded set is named too: {committed}");

    // And now — and *only* now — the override exists.
    let panel = live_text(&app);
    assert!(panel.contains("2 files left untouched"), "{panel}");
    assert!(panel.contains("[ ] revert them too"), "{panel}");

    // Ticking it, then confirming, is the one path that sends `force`.
    press(&mut app, &mut daemon, &rx, b"\x1b[B\r");
    assert!(live_text(&app).contains("[×] revert them too"));
    press(&mut app, &mut daemon, &rx, b"\x1b[B\r");
    assert_eq!(
        daemon.sent.last(),
        Some(&Call::Restore {
            checkpoint: "c-0".to_owned(),
            force: true
        })
    );
}

#[test]
fn a_checkpoint_that_anchors_no_entry_offers_the_code_and_says_so() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    app.hydrate(&mut daemon);
    answer_checkpoints(
        &mut daemon,
        serde_json::json!({ "checkpoints": [
            { "id": "c-0", "kind": "manual", "label": "by hand", "createdAt": "t",
              "changedFiles": 2, "excluded": [] }
        ], "available": true }),
    );
    press(&mut app, &mut daemon, &rx, b"");
    press(&mut app, &mut daemon, &rx, b"/rewind\r");
    answer_checkpoints(
        &mut daemon,
        serde_json::json!({ "checkpoints": [
            { "id": "c-0", "kind": "manual", "label": "by hand", "createdAt": "t",
              "changedFiles": 2, "excluded": [] }
        ], "available": true }),
    );
    press(&mut app, &mut daemon, &rx, b"");
    let picker = live_text(&app);
    assert!(picker.contains("code only"), "the picker says so too: {picker}");
    press(&mut app, &mut daemon, &rx, b"\r");
    let panel = live_text(&app);
    assert!(panel.contains("code only"), "{panel}");
    assert!(!panel.contains("conversation"), "there is no entry to go back to: {panel}");
    press(&mut app, &mut daemon, &rx, b"\r");
    assert_eq!(
        daemon.sent.last(),
        Some(&Call::Restore {
            checkpoint: "c-0".to_owned(),
            force: false
        })
    );
}

#[test]
fn a_rewind_says_how_many_messages_it_undid() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    daemon.answers.push(Reply {
        call: Call::Rewind {
            entry_id: Some("e-2".to_owned()),
        },
        outcome: Ok(serde_json::json!({
            "descriptor": { "sessionId": "s-1", "name": "n", "path": "/p", "headId": "e-2",
                            "createdAt": "t" },
            "entryId": "e-2", "removedMessages": 4
        })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    assert!(scrollback(&mut app).contains("rewound · 4 messages undone"));
}

#[test]
fn the_checkpoint_list_is_asked_for_again_at_every_turn_end() {
    let (mut app, mut daemon, (tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    app.hydrate(&mut daemon);
    daemon.sent.clear();
    tx.send(update(
        r#"{"sessionUpdate":"turn_end","turnId":"t1","status":"completed","durationMs":1,
            "partialRetained":false}"#,
    ))
    .expect("send");
    press(&mut app, &mut daemon, &rx, b"");
    assert!(daemon
        .sent
        .iter()
        .any(|call| matches!(call, Call::Checkpoints { why: Rewind::Refresh, .. })));
}

// ---------------------------------------------------------------------------
// /checkpoints — a first-class resultKind, not a report
// ---------------------------------------------------------------------------

#[test]
fn checkpoints_render_as_a_table_from_the_declared_result_kind() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    let mut answer = checkpoint_list(3);
    answer["resultKind"] = serde_json::json!("checkpoints");
    daemon.answers.push(Reply {
        call: Call::Command("/checkpoints".to_owned()),
        outcome: Ok(serde_json::json!({
            "command": "checkpoints", "resultKind": "checkpoints",
            "output": answer,
        })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);

    // A table with a header, one row per checkpoint — not prose, not JSON.
    assert!(committed.contains("id"), "{committed}");
    assert!(committed.contains("label"), "{committed}");
    assert!(committed.contains("changed files"), "{committed}");
    for index in 0..3 {
        assert!(committed.contains(&format!("c-{index}")), "{committed}");
        assert!(
            committed.contains(&format!("before step {index}")),
            "{committed}"
        );
    }
    assert!(!committed.contains("\":"), "no JSON reached the terminal: {committed}");
}

/// `available: false` is a different fact from an empty list, and the one the
/// user can act on. "Never render nothing" means saying which it is.
#[test]
fn checkpoints_in_a_directory_that_cannot_hold_them_says_why() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    daemon.answers.push(Reply {
        call: Call::Command("/checkpoints".to_owned()),
        outcome: Ok(serde_json::json!({
            "command": "checkpoints", "resultKind": "checkpoints",
            "output": { "checkpoints": [], "available": false,
                        "unavailable": "no git in PATH" },
        })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    assert!(scrollback(&mut app).contains("checkpoints unavailable · no git in PATH"));
}

/// The registry's declaration is enough: an answer that omits `resultKind`
/// still reaches the table, because `session/commands` already named the shape.
#[test]
fn a_declared_result_kind_picks_the_renderer_when_the_answer_omits_it() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    app.adopt_commands(&serde_json::json!({ "commands": [
        { "name": "checkpoints", "description": "The rewind list.",
          "resultKind": "checkpoints" }
    ]}));
    daemon.answers.push(Reply {
        call: Call::Command("/checkpoints".to_owned()),
        outcome: Ok(serde_json::json!({ "output": checkpoint_list(1) })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);
    assert!(committed.contains("changed files"), "{committed}");
    assert!(committed.contains("before step 0"), "{committed}");
}

// ---------------------------------------------------------------------------
// /review
// ---------------------------------------------------------------------------

/// A `/review` answer with one text file and one binary.
fn review_answer() -> serde_json::Value {
    serde_json::json!({
        "command": "review",
        "resultKind": "review",
        "output": {
            "diff": {
                "from": { "kind": "checkpoint", "id": "c-0", "label": "turn start" },
                "to": { "kind": "worktree" },
                "files": [
                    { "path": "src/auth.ts", "status": "modified", "additions": 2,
                      "deletions": 1, "binary": false,
                      "patch": "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,2 +1,3 @@\n context\n-old line\n+new line\n+added line\n" },
                    { "path": "logo.png", "status": "added", "binary": true }
                ],
                "truncated": false,
                "available": true
            },
            "agents": [
                { "name": "activity-module", "path": "/tmp/w", "origin": "/repo",
                  "state": "active", "mode": "worktree", "createdAt": "t", "updatedAt": "t",
                  "integration": { "hint": ["git fetch /tmp/w activity-module"] } }
            ]
        }
    })
}

#[test]
fn review_renders_a_file_row_each_and_expands_the_last_one_with_tab() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    daemon.answers.push(Reply {
        call: Call::Command("/review".to_owned()),
        outcome: Ok(review_answer()),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let committed = scrollback(&mut app);

    // The summary line is composed from the numbers, not read off a prose field.
    assert!(committed.contains("review · 2 files changed since turn start"), "{committed}");
    // One collapsed row per path, in the transcript grammar.
    assert!(committed.contains("▸ modified src/auth.ts"), "{committed}");
    assert!(committed.contains("▸ added logo.png"), "{committed}");
    assert!(committed.contains("+2"), "{committed}");
    // The agent workspaces, with the exact command that integrates each one.
    assert!(committed.contains("activity-module"), "{committed}");
    assert!(committed.contains("git fetch /tmp/w activity-module"), "{committed}");
    // No JSON reached the terminal.
    assert!(!committed.contains("\":"), "{committed}");

    // And `Tab` expands the last one, exactly as it expands the last tool call.
    press(&mut app, &mut daemon, &rx, b"\t");
    let expanded = scrollback(&mut app);
    assert!(!expanded.trim().is_empty(), "Tab expanded nothing");
}

#[test]
fn review_expands_a_patch_through_the_one_diff_renderer() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    // One text file only, so `Tab` lands on the patch rather than on the binary.
    let mut answer = review_answer();
    answer["output"]["diff"]["files"] = serde_json::json!([
        answer["output"]["diff"]["files"][0].clone()
    ]);
    daemon.answers.push(Reply {
        call: Call::Command("/review".to_owned()),
        outcome: Ok(answer),
    });
    press(&mut app, &mut daemon, &rx, b"");
    let _ = scrollback(&mut app);
    press(&mut app, &mut daemon, &rx, b"\t");
    let expanded = scrollback(&mut app);
    assert!(expanded.contains("new line"), "{expanded}");
    assert!(expanded.contains("old line"), "{expanded}");
}

#[test]
fn a_review_in_a_directory_without_checkpoints_says_why_instead_of_nothing() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    daemon.answers.push(Reply {
        call: Call::Command("/review".to_owned()),
        outcome: Ok(serde_json::json!({
            "command": "review", "resultKind": "review",
            "output": { "diff": { "from": { "kind": "empty" }, "to": { "kind": "worktree" },
                                  "files": [], "truncated": false, "available": false,
                                  "unavailable": "no git in PATH" },
                        "agents": [] }
        })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    assert!(scrollback(&mut app).contains("review unavailable · no git in PATH"));
}

/// A restore's answer must never open a panel over a surface the user opened
/// after asking for it.
#[test]
fn a_late_restore_answer_never_pops_a_panel_over_the_palette() {
    let (mut app, mut daemon, (_tx, rx)) = (app(), ScriptedDaemon::default(), wire());
    press(&mut app, &mut daemon, &rx, b"\x10");
    daemon.answers.push(Reply {
        call: Call::Restore {
            checkpoint: "c-0".to_owned(),
            force: false,
        },
        outcome: Ok(serde_json::json!({
            "target": { "id": "c-0", "kind": "turn_start", "label": "before step 0",
                        "createdAt": "t", "changedFiles": 1, "excluded": [] },
            "safety": { "id": "c-99", "kind": "pre_restore", "label": "before restore",
                        "createdAt": "t", "changedFiles": 1, "excluded": [] },
            "restored": ["src/auth.ts"], "preserved": ["README.md"],
            "forced": false, "excluded": []
        })),
    });
    press(&mut app, &mut daemon, &rx, b"");
    // The palette is still what is on screen…
    assert!(live_text(&app).contains("commands"), "{}", live_text(&app));
    // …and the override is named as the command it is, rather than as a modal.
    let committed = scrollback(&mut app);
    assert!(committed.contains("README.md"), "{committed}");
    assert!(committed.contains("/rollback c-0 --force"), "{committed}");
}
