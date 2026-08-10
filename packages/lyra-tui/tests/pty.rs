//! The test that would have caught the dead loop.
//!
//! Everything else in this crate tests a component, or the app loop against a
//! scripted daemon *inside* the process. This spawns the **real binary** in the
//! **real two-process shape**:
//!
//! - stdin/stdout are pipes, and a scripted daemon speaks canonical ACP on them,
//!   exactly as `cli.ts` does;
//! - a pty is the child's **controlling terminal**, so `/dev/tty` — the only
//!   thing the TUI is allowed to read and draw on — is something this test owns
//!   both ends of.
//!
//! Then it types. The assertions are the two facts the shipped bug violated:
//! the composer echoes what was typed, and `Enter` puts a `session/prompt` on
//! the daemon's side of the pipe. Neither is provable from inside either
//! process alone, which is exactly why the bug survived 575 green tests.
//!
//! # Why there is `unsafe` here and nowhere else
//!
//! A controlling terminal can only be acquired with `setsid` + `TIOCSCTTY`
//! between `fork` and `exec`. That is `libc` and `pre_exec`, both unsafe. This
//! is an integration-test crate, so the library's `#![forbid(unsafe_code)]`
//! still holds for everything that ships.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Long enough to absorb three sentinel-bounded terminal probes (200 ms each,
/// all unanswered because this pty answers nothing) plus process start.
const DEADLINE: Duration = Duration::from_secs(20);

#[test]
fn the_real_binary_echoes_typing_and_turns_enter_into_a_prompt() {
    let mut harness = Harness::start();

    // 1. The client speaks first. Nothing is typed until it has a session.
    let initialize = harness.expect_request("initialize");
    harness.answer(
        &initialize,
        serde_json::json!({
            "protocolVersion": "1",
            "serverInfo": { "name": "scripted", "version": "0" },
            "capabilities": { "methods": ["session/prompt"], "bidirectional": true }
        }),
    );

    // 2. It attaches to the session the daemon already has open rather than
    //    replacing it — `--session foo` must survive the TUI starting.
    let snapshot = harness.expect_request("session/snapshot");
    harness.answer(
        &snapshot,
        serde_json::json!({
            "descriptor": { "sessionId": "s-1", "name": "pty-fixture" },
            "entries": [],
            "provider": "fixture",
            "model": "fixture-model",
            "workspace": "/tmp/lyra-pty-fixture",
            "agents": []
        }),
    );

    // 3. The header proves the transcript reached scrollback through the real
    //    compositor and the real tty.
    harness.expect_screen("pty-fixture");
    // …and its last field is the working directory, printed **verbatim**: a
    // real path the user can `cd` into, not a workspace name (DESIGN.md §3).
    harness.expect_screen("/tmp/lyra-pty-fixture");
    // The composer frame is the live region. Its border is the signature.
    harness.expect_screen("╭");

    // 4. Type. This is the assertion the bug failed: keystrokes reached the
    //    composer and were echoed at keystroke latency, with no daemon event
    //    involved at all.
    harness.type_bytes(b"explain the loop");
    harness.expect_screen("explain the loop");

    // 5. Enter. This is the other one: the loop actually calls the daemon.
    harness.type_bytes(b"\r");
    let prompt = harness.expect_request("session/prompt");
    assert_eq!(
        prompt.params.get("prompt").and_then(|v| v.as_str()),
        Some("explain the loop"),
        "the composer's text is what went on the wire: {prompt:?}"
    );

    // 6. A turn streams back and lands in scrollback.
    harness.notify(
        r#"{"sessionUpdate":"turn_start","turnId":"t-1","source":"user","startedAtMs":0}"#,
    );
    harness.notify(
        r#"{"sessionUpdate":"delta","messageId":"m-1","partId":"p-1","field":"text",
            "delta":"the loop reads input first\n\n"}"#,
    );
    harness.expect_screen("the loop reads input first");

    // 7. A spawned child reaches the presence strip: one dot, its peer name,
    //    and a count for the ones still waiting. This is the only proof that the
    //    strip survives the real compositor's live-region diffing — it is a
    //    chrome row that appears mid-turn, which is exactly the case a
    //    fixed-height region would have clipped off the top.
    for update in [
        r#"{"sessionUpdate":"agent","id":"spawn-1","peer":"activity-module",
            "status":"running","model":"fixture-model"}"#,
        r#"{"sessionUpdate":"agent","id":"spawn-2","peer":"qa-checker","status":"queued"}"#,
    ] {
        harness.notify(update);
    }
    // Asserted piecewise because the strip is styled: the dot and the name are
    // separate spans with an SGR between them, which is exactly what a
    // contiguous-substring assertion would miss.
    harness.expect_screen("activity-module");
    harness.expect_screen("○ 1 queued");

    // 8. `/` opens the command popup on a real terminal. The scripted daemon
    //    never answers `session/commands`, so this is also the proof that the
    //    built-in list stands on its own: the popup must open either way.
    harness.type_bytes(b"/mod");
    harness.expect_screen("/model");

    // 9. Closing the pipe is a clean exit, not a hang.
    harness.finish();
}

/// First run, on a real terminal: no provider, so the wizard opens itself — and
/// the credential typed into it is drawn as bullets and never as itself.
///
/// The masking is asserted here, on the **bytes the child actually wrote to a
/// tty**, and not only in the unit tests, because "never rendered" is a claim
/// about the terminal and nothing inside the process can prove it.
#[test]
fn the_real_binary_masks_a_credential_typed_into_the_setup_wizard() {
    const SECRET: &str = "sk-pty-do-not-print";
    let mut harness = Harness::start();

    let initialize = harness.expect_request("initialize");
    harness.answer(
        &initialize,
        serde_json::json!({
            "protocolVersion": "1",
            "serverInfo": { "name": "scripted", "version": "0" },
            "capabilities": { "methods": ["provider/add"], "bidirectional": true }
        }),
    );

    // An unconfigured daemon: the session is real, but a prompt would be refused.
    let snapshot = harness.expect_request("session/snapshot");
    harness.answer(
        &snapshot,
        serde_json::json!({
            "descriptor": { "sessionId": "s-1", "name": "pty-first-run" },
            "entries": [], "provider": "", "model": "", "providerConfigured": false
        }),
    );

    // Nothing was typed: the client asked for the catalog on its own.
    let options = harness.expect_request("provider/setup_options");
    harness.answer(
        &options,
        serde_json::json!({
            "presets": [{ "id": "openai", "label": "OpenAI", "provider": "openai",
                          "baseUrl": "https://api.openai.com/v1",
                          "apiType": "openai_responses", "model": "gpt-5.6",
                          "needsKey": true, "custom": false }],
            "persist": [{ "id": "keychain", "label": "OS keychain", "available": true }],
            "apiTypes": [{ "id": "openai_responses", "label": "OpenAI responses" }],
            "path": "/tmp/providers.toml",
            "configured": []
        }),
    );
    harness.expect_screen("add a provider");
    harness.expect_screen("endpoint");

    // The endpoint is the first question. Leaving the field is what asks the
    // daemon what is at the other end of it — on a real terminal, off a real
    // `Tab` byte.
    harness.type_bytes(b"https://api.openai.com/v1");
    harness.expect_screen("api.openai.com");
    harness.type_bytes(b"\t");
    let detect = harness.expect_request("provider/detect");
    assert_eq!(
        detect.params.get("baseUrl").and_then(|v| v.as_str()),
        Some("https://api.openai.com/v1"),
        "the endpoint on screen is the one that was probed: {detect:?}"
    );
    harness.answer(
        &detect,
        serde_json::json!({
            "apiTypes": ["openai_responses"],
            "suggestedName": "openai",
            "authRequired": true
        }),
    );
    harness.expect_screen("OpenAI responses");

    // Tab to the credential field and type one.
    harness.type_bytes(b"\t\t\t");
    harness.type_bytes(SECRET.as_bytes());
    harness.expect_screen("•••");
    assert!(
        !harness.screen_text().contains(SECRET),
        "the credential was drawn on the terminal\n{}",
        harness.diagnostics()
    );
    assert!(
        !harness.screen_text().contains("sk-pty"),
        "even a prefix of it\n{}",
        harness.diagnostics()
    );

    harness.finish();
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// A request the child sent to its "daemon".
#[derive(Debug, Clone)]
struct Request {
    id: serde_json::Value,
    method: String,
    params: serde_json::Value,
}

struct Harness {
    child: Child,
    stdin: Option<ChildStdin>,
    requests: Receiver<Request>,
    /// Everything the child has drawn on the pty, as bytes.
    screen: Arc<Mutex<Vec<u8>>>,
    /// The pty master, for typing.
    keyboard: std::fs::File,
    /// Anything the child wrote to stderr — a panic, most usefully.
    stderr: Arc<Mutex<Vec<u8>>>,
    _home: TempHome,
}

impl Harness {
    fn start() -> Self {
        let (master, slave) = openpty();
        let home = TempHome::new();

        let mut command = Command::new(binary());
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Never touch the developer's real `~/.lyra`: this process writes
            // prompt history.
            .env("HOME", home.path())
            .env("LYRA_HOME", home.path())
            .env("TERM", "xterm-256color")
            // The purge resize mode erases the terminal's saved lines, which
            // would take the assertions with it.
            .env_remove("TMUX")
            .env_remove("ZELLIJ");

        let slave_fd = as_raw(&slave);
        // SAFETY: between fork and exec only async-signal-safe calls are made.
        // `setsid` detaches the child into its own session, which is the
        // precondition for `TIOCSCTTY` handing it the pty as its controlling
        // terminal — the only way `/dev/tty` resolves to something this test
        // owns.
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ioctl(slave_fd, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().expect("spawn lyra-tui");
        // The child holds its own copy now; keeping this one open would stop the
        // master ever seeing EOF.
        drop(slave);

        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        // Captured rather than discarded: a panic in the child is otherwise a
        // silent timeout here, which is the least debuggable failure there is.
        let stderr = collect(child.stderr.take().expect("piped stderr"));

        // The daemon side: one line per JSON-RPC frame.
        let (tx, requests) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let (Some(id), Some(method)) = (value.get("id"), value.get("method")) else {
                    continue;
                };
                let request = Request {
                    id: id.clone(),
                    method: method.as_str().unwrap_or_default().to_owned(),
                    params: value.get("params").cloned().unwrap_or(serde_json::Value::Null),
                };
                if tx.send(request).is_err() {
                    break;
                }
            }
        });

        // The terminal side: everything the child draws.
        let screen: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let mut reader = file(&master);
        let sink = Arc::clone(&screen);
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            // A pty master reads `EIO` when the last slave closes; that is the
            // child exiting, not a failure.
            while let Ok(read) = reader.read(&mut chunk) {
                if read == 0 {
                    break;
                }
                sink.lock().expect("screen").extend_from_slice(&chunk[..read]);
            }
        });

        Self {
            child,
            stdin: Some(stdin),
            requests,
            screen,
            keyboard: file(&master),
            stderr,
            _home: home,
        }
    }

    /// Wait for the child to call `method`, failing the test rather than hanging.
    fn expect_request(&mut self, method: &str) -> Request {
        let deadline = Instant::now() + DEADLINE;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for {method}\n{}",
                self.diagnostics()
            );
            match self.requests.recv_timeout(remaining) {
                Ok(request) if request.method == method => return request,
                // Anything else the client asks for is not this test's business,
                // but it must still be answered or the client would block.
                Ok(other) => self.answer(&other, serde_json::json!({})),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("the child closed its stdout before {method}")
                }
            }
        }
    }

    fn answer(&mut self, request: &Request, result: serde_json::Value) {
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": request.id,
            "result": result,
        });
        self.write_frame(&frame.to_string());
    }

    fn notify(&mut self, update: &str) {
        let update: serde_json::Value = serde_json::from_str(update).expect("valid update json");
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "sessionId": "s-1", "update": update },
        });
        self.write_frame(&frame.to_string());
    }

    fn write_frame(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().expect("stdin still open");
        stdin.write_all(line.as_bytes()).expect("write frame");
        stdin.write_all(b"\n").expect("write newline");
        stdin.flush().expect("flush frame");
    }

    fn type_bytes(&mut self, bytes: &[u8]) {
        self.keyboard.write_all(bytes).expect("type into the pty");
        self.keyboard.flush().expect("flush keystrokes");
    }

    /// Wait until `needle` appears in what the child has drawn.
    fn expect_screen(&self, needle: &str) {
        let deadline = Instant::now() + DEADLINE;
        while Instant::now() < deadline {
            if self.screen_text().contains(needle) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!(
            "{needle:?} never appeared on the terminal\n{}",
            self.diagnostics()
        );
    }

    /// What the child drew, with escape sequences left in: the assertions are
    /// substring matches on visible text, and stripping SGR would only hide a
    /// real difference.
    fn screen_text(&self) -> String {
        String::from_utf8_lossy(&self.screen.lock().expect("screen")).into_owned()
    }

    /// Everything a failure message should carry.
    fn diagnostics(&self) -> String {
        format!(
            "screen so far:\n{}\nstderr:\n{}",
            self.screen_text(),
            String::from_utf8_lossy(&self.stderr.lock().expect("stderr")),
        )
    }

    /// EOF on the ACP pipe is the shutdown `cli.ts` performs. The child must
    /// treat it as a clean disconnect and exit 0.
    fn finish(&mut self) {
        drop(self.stdin.take());
        let deadline = Instant::now() + DEADLINE;
        loop {
            match self.child.try_wait().expect("wait on the child") {
                Some(status) => {
                    assert!(status.success(), "lyra-tui exited {status}");
                    return;
                }
                None if Instant::now() >= deadline => {
                    let _ = self.child.kill();
                    panic!("lyra-tui did not exit on EOF\n{}", self.diagnostics());
                }
                None => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A throwaway `$HOME`, so prompt history and config never touch the real one.
struct TempHome(PathBuf);

impl TempHome {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "lyra-tui-pty-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |since| since.as_nanos())
        ));
        std::fs::create_dir_all(&path).expect("temp home");
        Self(path)
    }

    fn path(&self) -> &PathBuf {
        &self.0
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Drain a pipe into a buffer on its own thread.
fn collect(mut source: impl Read + Send + 'static) -> Arc<Mutex<Vec<u8>>> {
    let sink: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let handle = Arc::clone(&sink);
    std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        while let Ok(read) = source.read(&mut chunk) {
            if read == 0 {
                break;
            }
            handle.lock().expect("buffer").extend_from_slice(&chunk[..read]);
        }
    });
    sink
}

/// The binary under test, built by cargo for this integration test.
fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_lyra-tui")
}

fn as_raw(fd: &OwnedFd) -> libc::c_int {
    std::os::fd::AsRawFd::as_raw_fd(fd)
}

/// A second handle on a descriptor, since the reader and the writer live on
/// different threads.
fn file(fd: &OwnedFd) -> std::fs::File {
    let duplicate = fd.try_clone().expect("dup");
    std::fs::File::from(duplicate)
}

/// `openpty`, sized so the live region and the transcript both have room.
fn openpty() -> (OwnedFd, OwnedFd) {
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let mut size = libc::winsize {
        ws_row: 40,
        ws_col: 100,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: both out-parameters are valid for writes and `size` outlives the
    // call. The descriptors are handed straight to `OwnedFd`, which closes them.
    let code = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    assert_eq!(code, 0, "openpty: {}", std::io::Error::last_os_error());
    // SAFETY: `openpty` succeeded, so both are fresh owned descriptors.
    unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) }
}
