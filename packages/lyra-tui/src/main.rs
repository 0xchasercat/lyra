//! `lyra-tui` — the Lyra terminal client.
//!
//! Two entry modes:
//!
//! - `lyra-tui --smoke` runs a scripted session with no daemon. It exists to
//!   prove the phase-2 engine visually and to leave the terminal in a state you
//!   can inspect: scroll up and the transcript is *really there*, selectable and
//!   searchable by the terminal itself, because it was printed into native
//!   scrollback and never redrawn.
//! - `lyra-tui` (default) speaks ACP over stdin/stdout to the daemon `cli.ts`
//!   spawned it against, and drives the same pipeline from real events. Terminal
//!   I/O goes to `/dev/tty` so it cannot collide with the JSON-RPC stream.

use std::io::Write;
use std::time::{Duration, Instant};

use lyra_tui::acp::{AcpClient, AcpEvent, MethodNotFound};
use lyra_tui::app::{self, App};
use lyra_tui::engine::caps::Caps;
use lyra_tui::engine::commit::{StreamBlock, TextCommitPolicy};
use lyra_tui::engine::resize::{ReplaySource, ResizeDebouncer, ResizeMode, DEFAULT_DEBOUNCE};
use lyra_tui::engine::scrollback::{Compositor, Config, Frame, Metrics};
use lyra_tui::engine::{caps, Tty};
use lyra_tui::input::actor::{
    negotiate_kitty, restore_keyboard, terminal_size, InputActor, InputEvent, InputHandle,
    KittySupport, PROBE_DEADLINE,
};
use lyra_tui::theme::{adaptive, Theme};
use lyra_tui::ui::{Row, Style};
use lyra_tui::vendor::flywheel::{Modifiers, Rgb};

/// Accent colour used for the streaming indicator (DESIGN.md §3: two accents max).
const ACCENT: Rgb = Rgb::new(150, 130, 220);

fn main() {
    let options = match Options::parse(std::env::args().skip(1)) {
        Ok(Some(options)) => options,
        Ok(None) => return,
        Err(message) => {
            eprintln!("lyra-tui: {message}");
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    };

    let result = if options.smoke_content {
        run_smoke_content(&options)
    } else if options.smoke {
        run_smoke(&options)
    } else {
        run_acp(&options)
    };

    if let Err(error) = result {
        eprintln!("lyra-tui: {error}");
        std::process::exit(1);
    }
}

const USAGE: &str = "\
usage: lyra-tui [--smoke] [--smoke-content] [--region-height N] [--headless] [--purge]

  --smoke           run a scripted session with no daemon
  --smoke-content   render the phase-5 content demo (markdown, diff, tools,
                    retries, compaction) and exit
  --region-height N live region height in rows (default 6 for the demos, 12 for
                    a session, where the streaming tail lives in it)
  --headless        render into memory instead of a terminal (CI)
  --purge           select the opt-in purge resize mode
  --help            this message
";

/// Live-region height for the demos: activity, composer, hints, footer.
const DEMO_REGION_HEIGHT: u16 = 6;

/// Live-region height for a real session. The demos only ever show chrome; a
/// session also streams the unstable tail of the current block through here, so
/// it needs room for one to be legible before it commits.
const SESSION_REGION_HEIGHT: u16 = 12;

#[derive(Debug)]
struct Options {
    smoke: bool,
    smoke_content: bool,
    headless: bool,
    /// Only when the user asked. The default differs by mode, so it cannot be
    /// resolved here without losing the difference between "6" and "unset".
    region_height: Option<u16>,
    resize_mode: ResizeMode,
}

impl Options {
    fn parse(args: impl Iterator<Item = String>) -> Result<Option<Self>, String> {
        let mut options = Self {
            smoke: false,
            smoke_content: false,
            headless: false,
            region_height: None,
            resize_mode: ResizeMode::Conservative,
        };
        let mut args = args.peekable();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--smoke" => options.smoke = true,
                "--smoke-content" => options.smoke_content = true,
                "--headless" => options.headless = true,
                "--purge" => options.resize_mode = ResizeMode::Purge,
                "--help" | "-h" => {
                    println!("{USAGE}");
                    return Ok(None);
                }
                "--region-height" => {
                    let value = args.next().ok_or("--region-height needs a value")?;
                    options.region_height = Some(
                        value
                            .parse()
                            .map_err(|_| format!("bad --region-height: {value}"))?,
                    );
                }
                other => return Err(format!("unknown argument: {other}")),
            }
        }
        // DESIGN.md §1: purge is opt-in because `CSI 3 J` support is
        // undetectable — except under tmux/zellij, where it is reliable and is
        // therefore the default. An explicit `--purge` is never downgraded.
        options.resize_mode = ResizeMode::resolve(
            options.resize_mode,
            &lyra_tui::engine::resize::process_env,
        );
        Ok(Some(options))
    }

    const fn region_height(&self, default: u16) -> u16 {
        match self.region_height {
            Some(height) => height,
            None => default,
        }
    }

    const fn config(&self, default_height: u16) -> Config {
        Config {
            region_height: self.region_height(default_height),
            resize_mode: self.resize_mode,
            replay_cap: lyra_tui::engine::resize::DEFAULT_REPLAY_CAP,
        }
    }
}

/// Terminal setup shared by both modes.
struct Session {
    compositor: Compositor<lyra_tui::engine::tty::TtyWriter>,
    raw: bool,
    headless: bool,
    /// The sole reader of `/dev/tty` (build phase 4). Absent in headless mode
    /// and under the stdout fallback, where there is nothing to read.
    input: Option<InputHandle>,
    /// What the keyboard-protocol negotiation turned on, so `finish` can undo it.
    kitty: KittySupport,
    /// What the terminal said about its own colours. Kept so a DEC 2031 report
    /// can re-derive the `system` theme without re-probing.
    palette: adaptive::TerminalPalette,
    /// The theme in force, resolved from `~/.lyra/config.toml` over the probe.
    theme: Theme,
    /// Whether DEC 2031 colour-scheme reports were turned on.
    color_scheme_reports: bool,
}

impl Session {
    fn start(
        options: &Options,
        allow_stdout_fallback: bool,
        default_region: u16,
    ) -> std::io::Result<Self> {
        let config = user_config();
        if options.headless {
            let tty = Tty::sink();
            let compositor = Compositor::new(
                tty.writer,
                Caps::default(),
                80,
                24,
                options.config(default_region),
            )?;
            let palette = adaptive::TerminalPalette::default();
            return Ok(Self {
                theme: resolve_theme(config.as_deref(), &palette),
                compositor,
                raw: false,
                headless: true,
                input: None,
                kitty: KittySupport::unsupported(),
                palette,
                color_scheme_reports: false,
            });
        }

        let mut tty = Tty::open(allow_stdout_fallback)?;
        // Raw mode first: the capability probe's replies are line-buffered
        // otherwise, and every query would hit its deadline.
        let raw = crossterm::terminal::enable_raw_mode().is_ok();

        // The input actor starts *before* anything is probed, because it is the
        // only thing allowed to read the terminal (see `input::actor`). Every
        // probe below reads its answers from the actor's reply channel.
        let input = match tty.reader.take() {
            Some(reader) => Some(InputActor::start(reader)?),
            None => None,
        };
        let (kitty, probed, palette) = match &input {
            Some(handle) => {
                let kitty =
                    negotiate_kitty(&mut tty.writer, handle.replies(), PROBE_DEADLINE)
                        .unwrap_or_else(|_| KittySupport::unsupported());
                let caps = caps::probe_replies(&mut tty.writer, handle.replies(), PROBE_DEADLINE)
                    .unwrap_or_default();
                // Same sentinel-bounded shape as the capability probe, and for
                // the same reason: a terminal that answers no OSC query costs
                // nothing rather than one timeout per colour.
                let palette =
                    adaptive::probe_replies(&mut tty.writer, handle.replies(), PROBE_DEADLINE)
                        .unwrap_or_default();
                (kitty, caps, palette)
            }
            None => (
                KittySupport::unsupported(),
                Caps::default(),
                adaptive::TerminalPalette::default(),
            ),
        };
        // Ask to be told when the user flips their terminal between light and
        // dark. The reports come back down the same reply channel as the probes.
        let color_scheme_reports = input.is_some()
            && tty
                .writer
                .write_all(adaptive::ENABLE_COLOR_SCHEME_REPORTS)
                .and_then(|()| tty.writer.flush())
                .is_ok();

        let (width, height) = terminal_size();
        let compositor = Compositor::new(
            tty.writer,
            probed,
            width,
            height,
            options.config(default_region),
        )?;
        Ok(Self {
            theme: resolve_theme(config.as_deref(), &palette),
            compositor,
            raw,
            headless: false,
            input,
            kitty,
            palette,
            color_scheme_reports,
        })
    }

    /// Terminal replies that arrived since the last call.
    ///
    /// After probing, the only thing a well-behaved terminal sends unprompted is
    /// a DEC 2031 colour-scheme report, so this is where a live re-theme starts.
    fn appearance_change(&self) -> Option<lyra_tui::theme::Appearance> {
        let handle = self.input.as_ref()?;
        let mut latest = None;
        for reply in handle.replies().try_iter() {
            if let Some(appearance) = adaptive::parse_color_scheme_report(&reply) {
                latest = Some(appearance);
            }
        }
        latest
    }

    /// Block until input, a daemon event or a terminal reply is available, or
    /// `timeout` elapses.
    ///
    /// One `Select` over both channels rather than a poll: a keystroke wakes the
    /// loop immediately instead of waiting out a frame budget, and a quiet
    /// session costs nothing. The timeout exists only for what the *clock*
    /// drives — the retry countdown, the stall colour, an armed gesture.
    fn park(&self, events: &crossbeam_channel::Receiver<AcpEvent>, timeout: Duration) {
        let mut select = crossbeam_channel::Select::new();
        if let Some(handle) = &self.input {
            select.recv(handle.events());
            select.recv(handle.replies());
        }
        select.recv(events);
        let _ = select.ready_timeout(timeout);
    }

    /// Drain input events, applying resizes through the engine's debounced path.
    ///
    /// Replaces phase 2's per-frame `terminal::size()` poll: resizes now arrive
    /// as `SIGWINCH`-driven events on the same channel as keys.
    fn pump_input(
        &mut self,
        debouncer: &mut ResizeDebouncer,
        keys: &mut Vec<InputEvent>,
    ) -> std::io::Result<()> {
        let Some(handle) = &self.input else {
            return Ok(());
        };
        let now = Instant::now();
        for event in handle.drain() {
            match event {
                InputEvent::Resize { width, height } => debouncer.observe(width, height, now),
                other => keys.push(other),
            }
        }
        Ok(())
    }

    /// Apply a settled resize, replaying the transcript when the mode purges.
    fn settle_resize(
        &mut self,
        debouncer: &mut ResizeDebouncer,
        source: &mut dyn ReplaySource,
    ) -> std::io::Result<Option<(u16, u16)>> {
        let Some((width, height)) = debouncer.poll(Instant::now()) else {
            return Ok(None);
        };
        self.compositor.resize_with(width, height, None, source)?;
        Ok(Some((width, height)))
    }

    fn finish(mut self, metrics_label: &str) {
        let _ = self.compositor.finish();
        let metrics = self.compositor.metrics();
        if let Some(input) = &self.input {
            input.shutdown();
        }
        if self.raw {
            let _ = crossterm::terminal::disable_raw_mode();
        }
        let mut out = self.compositor.into_inner();
        if self.color_scheme_reports {
            let _ = out.write_all(adaptive::DISABLE_COLOR_SCHEME_REPORTS);
        }
        // Hand the terminal back in the keyboard mode we found it in.
        let _ = restore_keyboard(&mut out, self.kitty);
        let summary = format_metrics(metrics_label, metrics);
        if self.headless {
            println!("{summary}");
        } else {
            let _ = out.write_all(summary.as_bytes());
            let _ = out.flush();
        }
    }
}

fn format_metrics(label: &str, metrics: Metrics) -> String {
    let Metrics {
        frames,
        committed_rows,
        fast_path_commits,
        region_repaints,
        region_diffs,
        bytes_written,
        empty_frames,
        resizes,
        purge_requests,
        purges,
        replayed_rows,
    } = metrics;
    let per_row = bytes_written.checked_div(committed_rows).unwrap_or(0);
    format!(
        "\r\n{label}\r\n\
         \x20 frames {frames} (empty {empty_frames})\r\n\
         \x20 committed rows {committed_rows} — fast path {fast_path_commits}, \
         repaints {region_repaints}\r\n\
         \x20 region-only diffs {region_diffs}\r\n\
         \x20 resizes {resizes} — {purges} purged, {replayed_rows} rows replayed \
         (requests without a replay source {purge_requests})\r\n\
         \x20 bytes {bytes_written} (~{per_row} per committed row)\r\n"
    )
}

// ---------------------------------------------------------------------------
// Smoke mode
// ---------------------------------------------------------------------------

/// Prose used by the scripted session. Long enough to wrap at any width.
const SCRIPT: &[&str] = &[
    "The scrollback architecture is the load-bearing choice: finished output is \
     printed to the terminal exactly once and never touched again.",
    "Only a bounded bottom region is diffed and redrawn. Scroll up while this \
     runs and the terminal's own scrollback, selection and search all work, \
     because nothing above the fold belongs to this program any more.",
    "Streaming commits only provably-stable rows. Text holds back its final row \
     because the next token can still extend it, and an extension that crosses \
     the wrap width would move a word onto a new line — rewriting a row that has \
     already been printed.",
    "Markdown will commit whole blocks instead, through the same CommitPolicy \
     trait, without the compositor changing at all.",
];

fn run_smoke(options: &Options) -> std::io::Result<()> {
    let mut session = Session::start(options, true, DEMO_REGION_HEIGHT)?;
    let (width, _) = session.compositor.size();

    // The one-line header, printed once into scrollback (DESIGN.md §3: no
    // persistent header row, no splash, no mascot).
    session.compositor.commit(Row {
        spans: vec![
            lyra_tui::ui::Span::new("lyra", Style::fg(ACCENT).with(Modifiers::BOLD)),
            lyra_tui::ui::Span::new(
                " · smoke · main · opus-5 · purple-falcon",
                Style::dim(),
            ),
        ],
    });
    session.compositor.commit(Row::blank());
    session.compositor.commit(Row::styled("> render a few hundred lines", Style::default()));
    session.compositor.commit(Row::blank());

    let mut debouncer = ResizeDebouncer::new(width, session.compositor.size().1, DEFAULT_DEBOUNCE);
    let mut committed_total = 0usize;

    // -- Phase A: commit-stable-rows streaming into scrollback ---------------
    for (index, paragraph) in SCRIPT.iter().cycle().take(24).enumerate() {
        let mut block = StreamBlock::new(TextCommitPolicy, width);
        for chunk in chunks(paragraph, 7) {
            let stable = block.push(chunk);
            committed_total += stable.len();
            session.compositor.commit_all(stable);
            let tail = block.live_rows();
            let rows = live_region(&tail, index, committed_total, options.region_height(DEMO_REGION_HEIGHT));
            session.compositor.render(&Frame {
                rows: &rows,
                cursor: Some((2, options.region_height(DEMO_REGION_HEIGHT).saturating_sub(2))),
            })?;
            settle(&mut session, &mut debouncer, &mut Vec::new())?;
            sleep(2);
        }
        let stable = block.finish();
        committed_total += stable.len();
        session.compositor.commit_all(stable);
        session.compositor.commit(Row::blank());
        committed_total += 1;
    }

    // -- Phase B: fast-path append with a blank live region ------------------
    let before = session.compositor.metrics();
    session.compositor.render(&Frame::default())?;
    for step in 0..200 {
        session.compositor.commit(Row::styled(
            format!("  fast-path append {step:03} — no live-region re-diff"),
            Style::dim(),
        ));
        session.compositor.render(&Frame::default())?;
    }
    let after = session.compositor.metrics();
    let fast = after.fast_path_commits - before.fast_path_commits;
    session.compositor.commit(Row::blank());
    session.compositor.commit(Row::styled(
        format!("  {fast}/200 appends took the fast path"),
        Style::fg(ACCENT),
    ));

    // -- Phase C: a resize, debounced ---------------------------------------
    let (width, height) = session.compositor.size();
    let now = Instant::now();
    debouncer.observe(width.saturating_sub(1).max(20), height, now);
    if let Some((new_width, new_height)) = debouncer.poll(now + DEFAULT_DEBOUNCE) {
        session.compositor.resize(new_width, new_height, None)?;
        session.compositor.commit(Row::styled(
            format!("  resize settled at {new_width}x{new_height} — scrollback untouched"),
            Style::dim(),
        ));
    }
    let rows = live_region(&[], 0, committed_total, options.region_height(DEMO_REGION_HEIGHT));
    session.compositor.render(&Frame {
        rows: &rows,
        cursor: None,
    })?;

    // -- Phase D: the composer, the queue and the Esc ladder ------------------
    run_composer_demo(&mut session, options)?;

    session.finish("smoke complete");
    Ok(())
}

// ---------------------------------------------------------------------------
// Phase D — the build-phase-4 surfaces, driven by real bytes
// ---------------------------------------------------------------------------

/// The scripted keyboard for the composer demo.
///
/// These are the **bytes a terminal sends**, not synthesized events: they go
/// through `input::decode` exactly as `/dev/tty` bytes would, so the demo
/// exercises the kitty CSI-u path, bracketed paste and the legacy fallbacks
/// rather than a parallel test-only route.
const KEYSTROKES: &[(&str, &[u8])] = &[
    ("typing", b"explain "),
    ("bracketed paste collapses to a chip", b"\x1b[200~fn main() {\n    let a = 1;\n    let b = 2;\n    let c = 3;\n    println!(\"{a}{b}{c}\");\n}\x1b[201~"),
    ("an @ mention raises a completion request", b" in @src/main.rs"),
    ("shift+enter (kitty CSI-u) inserts a newline", b"\x1b[13;2u"),
    ("more typing", b"be brief"),
    ("enter submits: the turn starts", b"\r"),
    ("enter while streaming queues instead", b"now add tests\r"),
    ("and queues again", b"then update the docs\r"),
    ("esc pops the most recent queued item back", b"\x1b"),
    ("esc arms, esc clears", b"\x1b\x1b"),
    ("ctrl+s flushes the queue as steering", b"\x13"),
];

/// Drive the real composer, queue machine, Esc ladder and keymap from bytes.
fn run_composer_demo(session: &mut Session, options: &Options) -> std::io::Result<()> {
    use lyra_tui::input::actor::Router;

    session.compositor.commit(Row::blank());
    session.compositor.commit(Row::styled(
        "  phase 4 — composer, queue, esc ladder",
        Style::fg(ACCENT).with(Modifiers::BOLD),
    ));
    session.compositor.commit(Row::blank());

    let mut app = Demo::new();
    let mut router = Router::new();
    let mut debouncer =
        ResizeDebouncer::new(session.compositor.size().0, session.compositor.size().1, DEFAULT_DEBOUNCE);

    for (caption, bytes) in KEYSTROKES {
        session.compositor.commit(Row::styled(
            format!("  · {caption}"),
            Style::dim(),
        ));
        let mut events = Vec::new();
        router.feed(bytes, |event| events.push(event), |_| ());
        // A trailing lone ESC is only an Escape key once the timeout says so.
        router.timeout(|event| events.push(event));
        for event in events {
            app.handle(event);
            render_demo(session, &app, options)?;
            settle(session, &mut debouncer, &mut Vec::new())?;
            sleep(24);
        }
    }
    sleep(400);
    Ok(())
}

/// The live region for phase D: queue block, composer, hints, footer.
fn render_demo(
    session: &mut Session,
    app: &Demo,
    options: &Options,
) -> std::io::Result<()> {
    let (width, _) = session.compositor.size();
    let mut rows: Vec<Row> = Vec::new();

    let queued: Vec<_> = app.queue.entries().cloned().collect();
    rows.extend(lyra_tui::ui::queue::render(&app.theme, &queued, width));

    let layout = app
        .composer
        .layout_plain(lyra_tui::ui::composer::content_width(width));
    let view = lyra_tui::ui::composer::View {
        layout: &layout,
        mode: app.composer.mode(),
        border: lyra_tui::ui::composer::BorderState::of(
            app.composer.mode(),
            app.queue.is_streaming(),
        ),
        placeholder: "ask anything · ! for bash · / for commands · @ to mention a file",
        hint: app.esc.hint(),
        max_rows: 4,
    };
    let composer = lyra_tui::ui::composer::render(&app.theme, &view, width);
    let composer_top = rows.len();
    rows.extend(composer.rows);

    let stack = lyra_tui::keybind::ContextStack::build(
        false,
        app.composer.completion().is_open(),
        app.composer.is_empty(),
        app.queue.is_streaming(),
    );
    rows.push(lyra_tui::ui::hints::render(
        &app.theme,
        &app.keymap,
        &stack,
        width,
        |action| app.relabel(action),
    ));
    rows.push(lyra_tui::ui::footer::render(&app.theme, &app.footer, width));

    // The region is bounded; keep the tail, which is where the caret lives.
    let height = usize::from(options.region_height(DEMO_REGION_HEIGHT).max(4));
    let dropped = rows.len().saturating_sub(height);
    let rows: Vec<Row> = rows.into_iter().skip(dropped).collect();
    let caret_row = (composer_top + composer.caret.1 as usize).saturating_sub(dropped);

    session.compositor.render(&Frame {
        rows: &rows,
        cursor: Some((composer.caret.0, u16::try_from(caret_row).unwrap_or(0))),
    })
}

/// The smallest thing that can be called an app: everything phase 4 built,
/// wired together. Phase 6 replaces it with the real one.
struct Demo {
    theme: lyra_tui::theme::Theme,
    keymap: lyra_tui::keybind::Keymap,
    composer: lyra_tui::input::Composer,
    queue: lyra_tui::input::QueueMachine,
    esc: lyra_tui::input::EscLadder,
    footer: lyra_tui::ui::footer::FooterData,
}

impl Demo {
    fn new() -> Self {
        Self {
            theme: lyra_tui::theme::Theme::lyra(),
            keymap: lyra_tui::keybind::Keymap::default(),
            composer: lyra_tui::input::Composer::default(),
            queue: lyra_tui::input::QueueMachine::new(),
            esc: lyra_tui::input::EscLadder::new(),
            footer: lyra_tui::ui::footer::FooterData {
                model: Some("opus-5".to_owned()),
                context_used: Some(24_137),
                context_limit: Some(200_000),
                cost_cents: Some(342),
                retry: None,
            },
        }
    }

    /// The `Esc` hint is contextual because the ladder is: the key never
    /// changes, only the verb.
    fn relabel(&self, action: lyra_tui::keybind::Action) -> Option<String> {
        use lyra_tui::input::EscStep;
        if action != lyra_tui::keybind::Action::Escape {
            return None;
        }
        Some(
            match self.esc.peek(self, Instant::now()) {
                EscStep::DismissOverlay | EscStep::DismissCompletion => "dismiss",
                EscStep::ArmComposerClear | EscStep::ClearComposer => "clear",
                EscStep::PopQueue => "unqueue",
                EscStep::CancelTurn => "cancel",
                EscStep::ArmRewind | EscStep::Rewind => "rewind",
                EscStep::Ignored | EscStep::Swallowed => return Some(String::new()),
            }
            .to_owned(),
        )
    }

    fn handle(&mut self, event: InputEvent) {
        use lyra_tui::input::composer::ComposerOutcome;
        use lyra_tui::keybind::{Action, ContextStack};

        let key = match event {
            InputEvent::Paste(text) => {
                self.composer.paste(&text);
                self.esc.disarm();
                return;
            }
            InputEvent::Key(key) => key,
            InputEvent::Resize { .. } | InputEvent::Closed => return,
        };

        let stack = ContextStack::build(
            false,
            self.composer.completion().is_open(),
            self.composer.is_empty(),
            self.queue.is_streaming(),
        );
        let Some(action) = self.keymap.lookup(key, &stack) else {
            if let Some(c) = key.text_char() {
                self.esc.disarm();
                self.composer.insert_text(&c.to_string());
            }
            return;
        };
        if action != Action::Escape {
            self.esc.disarm();
        }
        match action {
            Action::Escape => {
                // The ladder mutates the world, and the ladder lives in it; lift
                // it out for the call rather than splitting the struct.
                let mut ladder = std::mem::take(&mut self.esc);
                ladder.press(self, Instant::now());
                self.esc = ladder;
            }
            Action::Steer => {
                self.queue.steer(None);
            }
            _ => {
                if let ComposerOutcome::Submit(submission) = self.composer.apply(action) {
                    self.queue.submit(submission);
                }
            }
        }
    }
}

/// The Esc ladder's view of the demo app — the boundary trait phase 3's
/// session store will implement for real.
impl lyra_tui::input::EscWorld for Demo {
    fn overlay_open(&self) -> bool {
        false
    }
    fn dismiss_overlay(&mut self) {}
    fn completion_open(&self) -> bool {
        self.composer.completion().is_open()
    }
    fn dismiss_completion(&mut self) {
        self.composer.completion_mut().dismiss();
    }
    fn composer_is_empty(&self) -> bool {
        self.composer.is_empty()
    }
    fn clear_composer(&mut self) {
        self.composer.clear();
    }
    fn queue_depth(&self) -> usize {
        self.queue.depth()
    }
    fn pop_queue_into_composer(&mut self) {
        if let Some(entry) = self.queue.pop_last() {
            self.composer.set_text(&entry.text);
        }
    }
    fn turn_running(&self) -> bool {
        self.queue.is_streaming()
    }
    fn cancel_turn(&mut self) {
        self.queue.turn_cancelled();
    }
    fn can_rewind(&self) -> bool {
        false
    }
    fn rewind(&mut self) {}
}


/// Split `text` into `size`-grapheme chunks, imitating a token stream.
fn chunks(text: &str, size: usize) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut count = 0usize;
    for (index, _) in text.char_indices() {
        if count == size && index > start {
            parts.push(&text[start..index]);
            start = index;
            count = 0;
        }
        count += 1;
    }
    if start < text.len() {
        parts.push(&text[start..]);
    }
    parts
}

/// The live region: streaming tail, activity strip, composer, footer.
///
/// Fixed height — DESIGN.md §3's anti-jitter rule is that chrome rows never
/// collapse 0↔1, so blanks are emitted rather than rows being omitted.
fn live_region(tail: &[String], step: usize, committed: usize, height: u16) -> Vec<Row> {
    let height = height.max(4) as usize;
    let mut rows = Vec::with_capacity(height);
    let stream_rows = height - 3;
    for index in 0..stream_rows {
        rows.push(
            tail.get(index)
                .map_or_else(Row::blank, |text| Row::text(text.clone())),
        );
    }
    rows.push(Row {
        spans: vec![
            lyra_tui::ui::Span::new("● ", Style::fg(ACCENT)),
            lyra_tui::ui::Span::new(
                format!("streaming · block {step} · {committed} rows committed"),
                Style::dim(),
            ),
        ],
    });
    rows.push(Row {
        spans: vec![
            lyra_tui::ui::Span::new("▸ ", Style::fg(ACCENT)),
            lyra_tui::ui::Span::plain(""),
        ],
    });
    rows.push(Row::styled(
        "  esc cancel · ctrl+s steer · tab expand",
        Style::dim(),
    ));
    rows
}

/// Drain input and settle any resize.
///
/// Phase 2 polled `terminal::size()` here once per frame. Phase 4 replaced the
/// poll with `SIGWINCH`: the input actor turns the signal into an event and this
/// only has to feed the debouncer. Keystrokes are collected into `keys` for the
/// caller.
fn settle(
    session: &mut Session,
    debouncer: &mut ResizeDebouncer,
    keys: &mut Vec<InputEvent>,
) -> std::io::Result<()> {
    if session.headless {
        return Ok(());
    }
    session.pump_input(debouncer, keys)?;
    // The demos have no transcript to replay, so they always resize
    // conservatively; `run_acp` hands `settle_resize` the real one.
    if let Some((width, height)) = debouncer.poll(Instant::now()) {
        session.compositor.resize(width, height, None)?;
    }
    Ok(())
}

fn sleep(millis: u64) {
    std::thread::sleep(Duration::from_millis(millis));
}

// ---------------------------------------------------------------------------
// ACP mode
// ---------------------------------------------------------------------------

/// The real client: `initialize`, attach a session, then the app loop.
///
/// Build phase 6. What used to be here was a passive viewer — it drained
/// keystrokes into a discarded `Vec`, never called `session/prompt`, and blocked
/// on the daemon before reading the keyboard. The loop below inverts that: input
/// is drained and routed first, every frame, and the composer, queue, Esc ladder
/// and keymap are the same ones `--smoke` exercises, backed by real ACP calls.
fn run_acp(options: &Options) -> std::io::Result<()> {
    // stdin/stdout are the daemon's pipes; the terminal is /dev/tty and the
    // stdout fallback is refused so a misconfigured spawn fails loudly rather
    // than writing escape sequences into a JSON-RPC stream.
    let mut session = Session::start(options, false, SESSION_REGION_HEIGHT)?;
    let client = AcpClient::spawn(std::io::stdin(), std::io::stdout(), MethodNotFound);
    let mut wire = Wire::new(&client);

    let (width, height) = session.compositor.size();
    let keymap = lyra_tui::keybind::Keymap::new(&key_overrides(user_config().as_deref()));
    let mut app = App::new(
        session.theme.clone(),
        keymap,
        lyra_tui::input::Composer::new(prompt_history()),
        width,
    );
    bootstrap(&client, &mut app);
    // The command registry, fetched once the session exists — a list of the
    // commands *this* session routes is worth nothing before there is one.
    app.hydrate(&mut wire);

    // The configured height, which an overlay may temporarily grow past.
    let base_region = options.region_height(SESSION_REGION_HEIGHT);
    let mut debouncer = ResizeDebouncer::new(width, height, DEFAULT_DEBOUNCE);
    let mut keys: Vec<InputEvent> = Vec::new();

    loop {
        // 1. INPUT FIRST. Nothing above this line waits on the daemon, which is
        //    the whole difference between a live composer and a dead one.
        keys.clear();
        session.pump_input(&mut debouncer, &mut keys)?;
        app::tick(
            &mut app,
            &mut wire,
            keys.drain(..),
            client.events(),
            Instant::now(),
        );

        // 2. Clock-driven work: a settled resize (purge replays the transcript
        //    at the new width) and a colour-scheme change.
        if let Some((width, _)) = session.settle_resize(&mut debouncer, &mut app)? {
            app.set_width(width);
        }
        if let Some(appearance) = session.appearance_change() {
            session.theme = adaptive::retheme(&session.theme, &session.palette, appearance);
            app.set_theme(session.theme.clone());
        }

        // 3. Render exactly once. An open overlay or completion popup borrows
        //    rows from the terminal first (DESIGN.md §1: the region is bounded,
        //    not fixed), and gives them back when it closes.
        let commits = app.take_commits();
        session.compositor.commit_all(commits);
        session
            .compositor
            .set_region_height(app.desired_region_height(base_region))?;
        let live = app.live(session.compositor.region_height(), Instant::now());
        session.compositor.render(&Frame {
            rows: &live.rows,
            cursor: Some(live.cursor),
        })?;

        if app.finished() {
            break;
        }
        // 4. Park until something can happen. Both sources are crossbeam
        //    channels, so one `Select` covers them and a keystroke wakes the
        //    loop with no polling interval in the way.
        session.park(
            client.events(),
            if app.needs_clock() {
                CLOCK_TICK
            } else {
                IDLE_PARK
            },
        );
    }

    drop(client);
    session.finish("acp session ended");
    Ok(())
}

/// Repaint interval while something on screen is driven by the clock: the retry
/// countdown is 1 Hz, the stall colour flips at three seconds, armed gestures
/// expire. 100 ms is under the resolution of all three.
const CLOCK_TICK: Duration = Duration::from_millis(100);

/// Park length when nothing is moving. Long, because the `Select` wakes on the
/// first keystroke anyway; this only bounds how stale a purely time-based
/// surface can get while the session is idle.
const IDLE_PARK: Duration = Duration::from_millis(500);

/// Handshake, attach to a session, print the header.
///
/// **Attach, not create.** `cli.ts` has already opened the session the user
/// asked for (`lyra --session foo`), and `session/new` would discard it for a
/// fresh `session-<epoch>`. `session/snapshot` adopts what is already open and
/// fills in provider, model and workspace for the footer; `session/new` is the
/// fallback for a daemon that has no session open at all.
fn bootstrap(client: &AcpClient, app: &mut App) {
    let mut fields: Vec<String> = Vec::new();
    match client.initialize(HANDSHAKE_TIMEOUT) {
        Ok(result) => {
            if let Some(info) = result.server_info {
                fields.push(format!("{} {}", info.name, info.version));
            }
        }
        Err(error) => app.error(format!("initialize failed: {error}")),
    }

    let snapshot = match client.session_snapshot(CALL_TIMEOUT) {
        Ok(snapshot) => {
            fields.push(snapshot.descriptor.name.clone());
            if !snapshot.model.is_empty() {
                fields.push(snapshot.model.clone());
            }
            if let Some(workspace) = snapshot.workspace.clone() {
                fields.push(workspace);
            }
            Some(snapshot)
        }
        Err(snapshot_error) => {
            match client.session_new(None, CALL_TIMEOUT) {
                Ok(descriptor) => fields.push(descriptor.name),
                Err(error) => {
                    app.error(format!("no session: {snapshot_error}"));
                    app.error(format!("session/new failed: {error}"));
                }
            }
            None
        }
    };

    // The header first, then the conversation it heads. The order is the whole
    // reason the snapshot is adopted *after* it has been read for the header
    // fields: `adopt_snapshot` replays the prior transcript into scrollback, and
    // a header printed underneath its own history would be a header for nothing.
    let borrowed: Vec<&str> = fields.iter().map(String::as_str).collect();
    app.header(&borrowed);
    if let Some(snapshot) = &snapshot {
        // Also the one fact the store has no opinion about: whether the daemon
        // has a provider at all. `App::hydrate` opens the setup wizard when it
        // does not.
        app.adopt_snapshot(snapshot);
    }
}

/// How long the client waits for the handshake. `cli.ts` boots the runtime
/// *after* spawning this process, so the first answer can legitimately be slow.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Bootstrap calls after the handshake, when the daemon is known to be up.
const CALL_TIMEOUT: Duration = Duration::from_secs(10);

/// [`app::Daemon`] over a live [`AcpClient`].
///
/// Fire-and-forget: `send` puts a frame on the wire and keeps the pending
/// [`lyra_tui::acp::Call`] here, so a frame is never blocked on a round trip.
/// `poll` collects whatever has been answered since the last frame. That is why
/// `session/steer` and `session/cancel` are issued through `call` rather than
/// through the client's blocking typed wrappers.
///
/// Nothing here bounds how long a call may stay pending, and nothing should: a
/// `session/prompt` legitimately runs for minutes, the daemon's method table
/// holds the turn-scale deadline for it, and `poll` is non-blocking — so the
/// loop below keeps drawing, keeps reading the keyboard, and keeps letting Esc
/// cancel for the whole of it.
struct Wire<'a> {
    client: &'a AcpClient,
    pending: Vec<(app::Call, Inflight)>,
}

/// A call that has gone out, or one that never could.
enum Inflight {
    /// Waiting on the daemon.
    Waiting(lyra_tui::acp::Call),
    /// The pipe was already broken. Reported through the same path as any other
    /// failure rather than growing a second one.
    Failed(String),
}

impl<'a> Wire<'a> {
    const fn new(client: &'a AcpClient) -> Self {
        Self {
            client,
            pending: Vec::new(),
        }
    }
}

impl app::Daemon for Wire<'_> {
    fn send(&mut self, call: app::Call) {
        let params = match &call {
            app::Call::Prompt(text) => serde_json::json!({ "prompt": text }),
            app::Call::Steer(text) => serde_json::json!({ "prompt": text }),
            app::Call::Cancel {
                rewound_to_composer,
            } => {
                if *rewound_to_composer {
                    serde_json::json!({ "rewoundToComposer": true })
                } else {
                    serde_json::json!({})
                }
            }
            app::Call::Command(line) => serde_json::json!({ "command": line }),
            app::Call::Commands
            | app::Call::Providers
            | app::Call::Sessions
            | app::Call::Snapshot => serde_json::json!({}),
            app::Call::Complete {
                session_id,
                kind,
                query,
                limit,
            } => {
                let mut params = serde_json::json!({
                    "kind": kind,
                    "query": query,
                    "limit": limit,
                });
                // Omitted rather than sent empty when the snapshot has not
                // landed: the daemon's default is the session it has open, and
                // that is the only one this process can be talking about.
                if let Some(session_id) = session_id {
                    params["sessionId"] = serde_json::json!(session_id);
                }
                params
            }
            app::Call::Models | app::Call::ProviderSetupOptions => serde_json::json!({}),
            app::Call::SelectModel(model) => serde_json::json!({ "model": model }),
            app::Call::ModelAdd { provider, model } => {
                serde_json::json!({ "provider": provider, "model": model })
            }
            app::Call::SelectProvider { provider, model } => {
                let mut params = serde_json::json!({ "provider": provider });
                if let Some(model) = model {
                    params["model"] = serde_json::json!(model);
                }
                params
            }
            app::Call::LoadSession(name) => serde_json::json!({ "name": name }),
            // `purpose` is this client's routing, not the daemon's business:
            // the method takes a provider id and nothing else.
            app::Call::ProviderGet { provider, .. } => {
                serde_json::json!({ "provider": provider })
            }
            app::Call::ProviderRemove(params) => {
                serde_json::to_value(params).unwrap_or_else(|_| serde_json::json!({}))
            }
            // The three secret-carrying calls. `serde` builds them, because the
            // params are typed against the schema and hand-writing a credential
            // into a `json!` literal is how one ends up somewhere else too.
            app::Call::ProviderDetect(params) => {
                serde_json::to_value(params).unwrap_or_else(|_| serde_json::json!({}))
            }
            app::Call::ProviderVerify(params) => {
                serde_json::to_value(params).unwrap_or_else(|_| serde_json::json!({}))
            }
            app::Call::ProviderAdd(params) => {
                serde_json::to_value(params).unwrap_or_else(|_| serde_json::json!({}))
            }
        };
        let inflight = match self.client.call(call.method(), Some(params)) {
            Ok(pending) => Inflight::Waiting(pending),
            Err(error) => Inflight::Failed(error.to_string()),
        };
        self.pending.push((call, inflight));
    }

    fn poll(&mut self) -> Vec<app::Reply> {
        let mut replies = Vec::new();
        let mut index = 0;
        while index < self.pending.len() {
            let outcome = match &self.pending[index].1 {
                Inflight::Waiting(pending) => {
                    pending.poll().map(|result| result.map_err(|e| e.to_string()))
                }
                Inflight::Failed(detail) => Some(Err(detail.clone())),
            };
            match outcome {
                None => index += 1,
                Some(outcome) => {
                    let (call, _) = self.pending.remove(index);
                    replies.push(app::Reply { call, outcome });
                }
            }
        }
        replies
    }
}

/// `~/.lyra/config.toml`, when there is one. Theme and keybindings are data.
fn user_config() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    std::fs::read_to_string(std::path::PathBuf::from(home).join(".lyra/config.toml")).ok()
}

/// The theme in force: `LYRA_THEME` over `[tui.theme]` over the bundled default,
/// resolved against whatever the terminal reported about its own colours.
///
/// A broken theme block is never fatal — it falls back to the default, because a
/// mistyped colour must not cost the user their TUI. `LYRA_THEME=system` is the
/// terminal-adaptive theme (DESIGN.md §3) and is where the probed palette lands.
fn resolve_theme(config: Option<&str>, palette: &adaptive::TerminalPalette) -> Theme {
    let mut parsed = config
        .and_then(|source| lyra_tui::theme::config::ThemeConfig::parse(source).ok())
        .unwrap_or_default();
    if let Some(name) = std::env::var("LYRA_THEME").ok().filter(|s| !s.is_empty()) {
        parsed.name = Some(name);
    }
    parsed.resolve(palette).unwrap_or_default()
}

/// `[tui.keys]` overrides, if any. Same rule: unusable data degrades to the
/// defaults rather than refusing to start.
fn key_overrides(config: Option<&str>) -> lyra_tui::keybind::config::KeyOverrides {
    config.map_or_else(Default::default, |source| {
        lyra_tui::keybind::config::KeyOverrides::from_document(source)
    })
}

/// Prompt history under `~/.lyra`, in memory when there is nowhere to put it.
fn prompt_history() -> lyra_tui::input::history::History {
    lyra_tui::input::history::History::default_path().map_or_else(
        lyra_tui::input::history::History::in_memory,
        lyra_tui::input::history::History::load,
    )
}

// ---------------------------------------------------------------------------
// Content demo (build phase 5)
// ---------------------------------------------------------------------------

/// `--smoke-content`: drive every phase-5 renderer through the real compositor.
///
/// Additive to `--smoke` rather than folded into it, because the two prove
/// different things. `--smoke` proves the *engine* — that a committed row is
/// never addressed again, that bulk appends take the fast path. This proves the
/// *content*: that markdown streams by line and never commits a row a later
/// token contradicts, that a table arriving after its header does not tear, and
/// that every reliability surface has something to show.
///
/// Scroll up when it finishes. The transcript is really there, selectable and
/// searchable by the terminal, because it was printed once and never redrawn.
fn run_smoke_content(options: &Options) -> std::io::Result<()> {
    use lyra_tui::theme::{adaptive, Theme};
    use lyra_tui::ui::diff::FileDiff;
    use lyra_tui::ui::reliability::Retry;
    use lyra_tui::ui::tool_row::ToolStatus;
    use lyra_tui::ui::transcript::Transcript;

    let mut session = Session::start(options, true, DEMO_REGION_HEIGHT)?;
    let (width, _) = session.compositor.size();

    // The `system` theme with nothing probed still yields a complete token set;
    // that degradation is the point of testing it here rather than a bundled one.
    let theme = if std::env::var("LYRA_THEME").as_deref() == Ok("system") {
        adaptive::system_theme(&adaptive::TerminalPalette::default())
    } else {
        Theme::lyra()
    };
    let mut transcript = Transcript::new(theme, width);

    // -- the session header, printed once ------------------------------------
    let rows = transcript.header(&["lyra", "main", "opus-5", "purple-falcon"]);
    session.compositor.commit_all(rows);
    session.compositor.commit(Row::blank());

    let rows = transcript.user("show me every content surface");
    session.compositor.commit_all(rows);
    session.compositor.commit(Row::blank());

    // -- markdown, streamed a few graphemes at a time ------------------------
    // The table arrives *late*: its header line is streamed well before the
    // delimiter row that turns it into a table. Nothing above it may be
    // committed as a paragraph and then contradicted.
    const DOC: &str = "\
# Content demo

Streaming markdown commits **whole stable blocks**, never a row a later token \
could contradict. Code spans like `stable_rows` take the accent, and a link \
such as [DESIGN.md](https://example.com/design) becomes an OSC 8 hyperlink.

## The retroactive table

| surface | renderer | stable when |
|---|:--:|---:|
| markdown | markdown.rs | the block closes |
| diff | diff.rs | immediately |
| tool rows | tool_row.rs | the call settles |

> A blockquote gets a dim rail, and lists cycle bullets by depth.

- top level
  - nested once
    - nested twice

```rust
fn stable_rows(rows: &[String], finished: bool) -> usize {
    // A committed row can never be taken back.
    if finished { rows.len() } else { self.closed_rows.min(rows.len()) }
}
```

That is every markdown construct the transcript grammar uses.
";
    for chunk in chunks(DOC, 5) {
        let stable = transcript.assistant_delta(chunk);
        session.compositor.commit_all(stable);
        let live = transcript.live_rows();
        session.compositor.render(&Frame {
            rows: &live,
            cursor: None,
        })?;
        sleep(4);
    }
    session.compositor.commit_all(transcript.end_assistant());
    session.compositor.commit(Row::blank());

    // -- tool rows: a collapsed survey run, then an edit with a diff ---------
    for path in ["src/auth.ts", "src/session.ts", "src/tui.rs"] {
        let rows = transcript.tool(demo_view("read", path, ToolStatus::Succeeded, None));
        session.compositor.commit_all(rows);
        let live = transcript.live_rows();
        session.compositor.render(&Frame {
            rows: &live,
            cursor: None,
        })?;
        sleep(120);
    }
    let rows = transcript.tool(demo_view("grep", "CommitPolicy", ToolStatus::Succeeded, None));
    session.compositor.commit_all(rows);
    session.compositor.render(&Frame {
        rows: &transcript.live_rows(),
        cursor: None,
    })?;
    sleep(200);

    let edit = demo_view(
        "edit",
        "src/auth.ts",
        ToolStatus::Succeeded,
        Some(FileDiff::between(
            "src/auth.ts",
            "const timeout = 30;\nconst retries = 3;\nexport function auth() {\n  return check();\n}\n",
            "const timeout = 60;\nconst retries = 8;\nexport async function auth() {\n  return await check({ strict: true });\n}\n",
            1,
        )),
    );
    session.compositor.commit_all(transcript.tool(edit));
    // `Tab` expands the *last* tool call. The keybinding is the input layer's;
    // this is the operation it calls.
    session.compositor.commit_all(transcript.expand_last_tool());
    session.compositor.commit(Row::blank());

    let mut failing = demo_view("bash", "cargo test --all", ToolStatus::Failed, None);
    failing.exit_code = Some(101);
    let failing = failing.with_output(
        (1..=18)
            .map(|n| format!("test module::case_{n:02} ... FAILED\n"))
            .collect::<String>(),
    );
    session.compositor.commit_all(transcript.tool(failing));
    session.compositor.commit(Row::blank());

    // -- reliability: a retry sequence escalating past attempt 4 -------------
    for attempt in 1..=5u32 {
        let rows = transcript.retry(Retry {
            attempt,
            max_attempts: 8,
            classification: Some("rate_limit".to_owned()),
            seconds_remaining: Some(u64::from(6 - attempt)),
            elapsed_seconds: Some(u64::from(attempt) * 12),
        });
        session.compositor.commit_all(rows);
        session.compositor.render(&Frame::default())?;
        sleep(180);
    }

    // -- compaction, context repair, loop note, transport fallback ----------
    session.compositor.commit(Row::blank());
    session.compositor.commit_all(transcript.compacted(-38_214, Some(12)));
    session.compositor.commit_all(transcript.context_repaired("dropped 2 orphaned tool results"));
    session.compositor.commit_all(transcript.loop_warning("same edit attempted 3 times"));
    session.compositor.commit_all(transcript.transport_fallback(
        "websocket",
        "http",
        Some("handshake failed"),
    ));
    session.compositor.commit_all(transcript.turn_end("cancelled"));
    session.compositor.commit(Row::blank());

    // -- the purge proof -----------------------------------------------------
    // Re-render the whole transcript at half width and print the row counts.
    // A purge resize does exactly this, at the new width, after `CSI 3 J`.
    let narrow = (width / 2).max(20);
    let at_full = transcript.render_all(width).len();
    let at_narrow = transcript.render_all(narrow).len();
    session.compositor.commit(Row::styled(
        format!(
            "  transcript re-renders from state: {at_full} rows at {width} cols, \
             {at_narrow} at {narrow} — this is what purge replays"
        ),
        Style::dim(),
    ));
    session.compositor.render(&Frame::default())?;

    // Under `--purge` (or tmux/zellij) prove the whole path: erase saved lines
    // and reprint the transcript re-rendered at the current width. The rows come
    // out as if the terminal had always been this wide — which is the one thing
    // replaying the compositor's old-width ring could never do.
    if options.resize_mode == ResizeMode::Purge && !session.headless {
        let (width, height) = session.compositor.size();
        session
            .compositor
            .resize_with(width, height, None, &mut transcript)?;
        session.compositor.render(&Frame::default())?;
    }

    session.finish("content demo complete");
    Ok(())
}

/// A `ToolView` built by hand, since the demo has no session store behind it.
fn demo_view(
    name: &str,
    target: &str,
    status: lyra_tui::ui::tool_row::ToolStatus,
    diff: Option<lyra_tui::ui::diff::FileDiff>,
) -> lyra_tui::ui::tool_row::ToolView {
    lyra_tui::ui::tool_row::ToolView {
        id: format!("{name}-{target}"),
        name: name.to_owned(),
        target: Some(target.to_owned()),
        status,
        diff,
        output: None,
        exit_code: None,
        files_modified: Vec::new(),
        interrupted: false,
    }
}
