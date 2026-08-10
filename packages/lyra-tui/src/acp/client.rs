//! Bidirectional JSON-RPC 2.0 client over newline-delimited stdio.
//!
//! # Threading
//!
//! One reader thread owns the input pipe and never blocks on application code:
//! it decodes frames, resolves pending calls through one-shot channels, answers
//! daemon requests itself, and forwards everything else onto an unbounded event
//! channel the render loop drains. The writer is a mutex around the output pipe,
//! so any thread may send.
//!
//! # Why the daemon's requests are answered on the reader thread
//!
//! `AcpDaemon.requestClient` *blocks its handler* until we reply or its timeout
//! fires (60 s by default). Deferring the reply to the render loop would stall a
//! turn behind a frame. Until the permission UI exists (build phase 6), every
//! daemon request is answered `-32601` immediately — the daemon converts that
//! into a normal handler rejection and keeps serving. Phase 6 replaces
//! [`Responder`] with a real prompt without touching this transport.
//!
//! # Who owns a request's deadline
//!
//! The daemon does, per method. It gives prompt-class requests
//! (`session/prompt`, `session/steer`, `session/command`, `agent/spawn`) the
//! configured turn deadline — 30 minutes by LYRA.md §3.4 — and every other
//! method the generic one. So the blocking helpers below take an explicit
//! `timeout` because they are *questions* asked during startup, while
//! [`AcpClient::session_prompt`] takes none at all: it returns a [`Call`] the
//! render loop polls without blocking, and the answer arrives whenever the turn
//! ends. Nothing here waits forever regardless — the reader thread fails every
//! outstanding call the moment the pipe closes.
//!
//! # Not connected to the terminal
//!
//! In ACP-on-stdio mode stdin/stdout belong to the daemon. Terminal I/O goes to
//! `/dev/tty` (see [`crate::engine::tty`]). Nothing in this module writes to the
//! terminal, and nothing in the engine writes to stdout.

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crossbeam_channel::{bounded, unbounded, Receiver, Sender};
use serde_json::{json, Value};

use super::codec::{self, Decoder, FramingError};
use super::types::{
    method, CancelParams, CancelResult, Id, Inbound, InitializeResult,
    ModelSelection, ModelsParams, ModelsResult, Outbound, ProvidersResult, RawMessage, RpcError,
    SelectModelParams, SelectProviderParams, SessionDescriptor, SessionSnapshot, SessionSummary,
    SteerResult, UpdateNotification,
};

/// A failure surfaced to a caller.
#[derive(Debug)]
pub enum AcpError {
    /// The daemon answered with a JSON-RPC error.
    Rpc(RpcError),
    /// The result did not match the expected shape.
    Decode(String),
    /// The transport failed or the daemon went away.
    Transport(String),
}

impl std::fmt::Display for AcpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rpc(error) => write!(f, "acp: {error}"),
            Self::Decode(detail) => write!(f, "acp: malformed result: {detail}"),
            Self::Transport(detail) => write!(f, "acp: transport: {detail}"),
        }
    }
}

impl std::error::Error for AcpError {}

/// Something the render loop needs to see.
#[derive(Debug, Clone)]
pub enum AcpEvent {
    /// A canonical `session/update` notification: `{sessionId, update}`. The only
    /// shape the daemon emits.
    Update(Box<UpdateNotification>),
    /// Any other notification, kept raw so an extended daemon is still legible.
    Notification {
        /// Method name.
        method: String,
        /// Raw params.
        params: Option<Value>,
    },
    /// A request from the daemon, already answered by [`Responder`].
    ServerRequest {
        /// Method name.
        method: String,
        /// Raw params.
        params: Option<Value>,
    },
    /// A frame that could not be parsed. Non-fatal.
    Malformed(String),
    /// The reader thread stopped. Terminal.
    Closed(Option<String>),
}

/// How daemon-initiated requests are answered.
pub trait Responder: Send + 'static {
    /// Produce a reply for a daemon request.
    ///
    /// Must return promptly; the daemon's handler is blocked meanwhile.
    fn respond(&self, method: &str, params: Option<&Value>) -> Result<Value, RpcError>;
}

/// The phase-2 responder: declines everything, politely and without dying.
#[derive(Debug, Default, Clone, Copy)]
pub struct MethodNotFound;

impl Responder for MethodNotFound {
    fn respond(&self, method: &str, _params: Option<&Value>) -> Result<Value, RpcError> {
        Err(RpcError {
            code: -32601,
            message: format!("lyra-tui does not implement {method} yet"),
            data: None,
        })
    }
}

type Pending = Arc<Mutex<HashMap<Id, Sender<Result<Value, RpcError>>>>>;

/// A request that has been sent but not yet answered.
#[derive(Debug)]
pub struct Call {
    id: Id,
    receiver: Receiver<Result<Value, RpcError>>,
}

impl Call {
    /// The request id, for `$/cancelRequest`.
    #[must_use]
    pub const fn id(&self) -> &Id {
        &self.id
    }

    /// Non-blocking poll.
    ///
    /// `None` means still in flight.
    pub fn poll(&self) -> Option<Result<Value, AcpError>> {
        match self.receiver.try_recv() {
            Ok(Ok(value)) => Some(Ok(value)),
            Ok(Err(error)) => Some(Err(AcpError::Rpc(error))),
            Err(crossbeam_channel::TryRecvError::Empty) => None,
            Err(crossbeam_channel::TryRecvError::Disconnected) => {
                Some(Err(AcpError::Transport("connection closed".to_owned())))
            }
        }
    }

    /// Block until answered.
    ///
    /// # Errors
    ///
    /// Transport failure, timeout, or a JSON-RPC error from the daemon.
    pub fn wait(self, timeout: Duration) -> Result<Value, AcpError> {
        match self.receiver.recv_timeout(timeout) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(AcpError::Rpc(error)),
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => Err(AcpError::Transport(format!(
                "request {} timed out after {timeout:?}",
                self.id
            ))),
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                Err(AcpError::Transport("connection closed".to_owned()))
            }
        }
    }
}

/// A live ACP connection.
pub struct AcpClient {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pending: Pending,
    events: Receiver<AcpEvent>,
    next_id: AtomicI64,
    reader: Option<JoinHandle<()>>,
}

impl AcpClient {
    /// Start a client over the given pipes.
    ///
    /// `input` and `output` are the daemon's stdout and stdin respectively.
    #[must_use]
    pub fn spawn<R, W, P>(input: R, output: W, responder: P) -> Self
    where
        R: Read + Send + 'static,
        W: Write + Send + 'static,
        P: Responder,
    {
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(Box::new(output)));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (event_tx, event_rx) = unbounded();

        let reader = std::thread::Builder::new()
            .name("lyra-acp-reader".to_owned())
            .spawn({
                let writer = Arc::clone(&writer);
                let pending = Arc::clone(&pending);
                move || read_loop(input, &writer, &pending, &event_tx, &responder)
            })
            .expect("spawn acp reader thread");

        Self {
            writer,
            pending,
            events: event_rx,
            next_id: AtomicI64::new(1),
            reader: Some(reader),
        }
    }

    /// The event stream. Drain it from the render loop; it never blocks a write.
    #[must_use]
    pub const fn events(&self) -> &Receiver<AcpEvent> {
        &self.events
    }

    /// Send a request and get a handle to its eventual answer.
    ///
    /// # Errors
    ///
    /// Fails only if the pipe is already broken.
    pub fn call(&self, method: &'static str, params: Option<Value>) -> Result<Call, AcpError> {
        let id = Id::Number(self.next_id.fetch_add(1, Ordering::Relaxed));
        // The one-shot is registered before the frame goes out: a daemon fast
        // enough to answer mid-`write` must still find somewhere to land.
        let (tx, rx) = bounded(1);
        self.pending
            .lock()
            .expect("pending map poisoned")
            .insert(id.clone(), tx);
        match self.send(&Outbound::request(id.clone(), method, params)) {
            Ok(()) => Ok(Call { id, receiver: rx }),
            Err(error) => {
                self.pending
                    .lock()
                    .expect("pending map poisoned")
                    .remove(&id);
                Err(error)
            }
        }
    }

    /// Send a notification.
    ///
    /// # Errors
    ///
    /// Fails only if the pipe is broken.
    pub fn notify(&self, method: &'static str, params: Option<Value>) -> Result<(), AcpError> {
        self.send(&Outbound::notification(method, params))
    }

    /// Ask the daemon to abandon an in-flight request.
    ///
    /// # Errors
    ///
    /// Fails only if the pipe is broken.
    pub fn cancel_request(&self, id: &Id) -> Result<(), AcpError> {
        self.notify(method::CANCEL_REQUEST, Some(json!({ "id": id })))
    }

    // -- typed surface -----------------------------------------------------

    /// `initialize` handshake.
    ///
    /// # Errors
    ///
    /// Transport or protocol failure.
    pub fn initialize(&self, timeout: Duration) -> Result<InitializeResult, AcpError> {
        decode(self.call(method::INITIALIZE, None)?.wait(timeout)?)
    }

    /// `session/new`.
    ///
    /// # Errors
    ///
    /// Transport or protocol failure.
    pub fn session_new(
        &self,
        name: Option<&str>,
        timeout: Duration,
    ) -> Result<SessionDescriptor, AcpError> {
        let params = name.map(|name| json!({ "name": name }));
        decode(self.call(method::SESSION_NEW, params)?.wait(timeout)?)
    }

    /// `session/list`.
    ///
    /// # Errors
    ///
    /// Transport or protocol failure.
    pub fn session_list(&self, timeout: Duration) -> Result<Vec<SessionSummary>, AcpError> {
        decode(self.call(method::SESSION_LIST, None)?.wait(timeout)?)
    }

    /// `session/snapshot` — the hydration payload.
    ///
    /// Fetch once at attach and apply live updates on top; a live update that
    /// arrives during the fetch wins (`SessionStore::hydrate`).
    ///
    /// # Errors
    ///
    /// Transport or protocol failure.
    pub fn session_snapshot(&self, timeout: Duration) -> Result<SessionSnapshot, AcpError> {
        decode(self.call(method::SESSION_SNAPSHOT, None)?.wait(timeout)?)
    }

    /// `session/prompt`. Returns immediately; the turn streams over
    /// `session/update` notifications and the [`Call`] resolves at turn end.
    ///
    /// # Errors
    ///
    /// Fails only if the pipe is broken.
    pub fn session_prompt(&self, prompt: &str) -> Result<Call, AcpError> {
        self.call(method::SESSION_PROMPT, Some(json!({ "prompt": prompt })))
    }

    /// `session/steer` — inject text into the running turn at the next tool
    /// boundary, as a standalone synthetic user turn (DESIGN.md §0.2; `Ctrl+S`
    /// flushes the queue through here).
    ///
    /// The deprecated `session/update` alias is never sent: it collides with the
    /// notification method of the same name.
    ///
    /// # Errors
    ///
    /// Transport or protocol failure.
    pub fn session_steer(&self, prompt: &str, timeout: Duration) -> Result<SteerResult, AcpError> {
        decode(
            self.call(method::SESSION_STEER, Some(json!({ "prompt": prompt })))?
                .wait(timeout)?,
        )
    }

    /// `session/cancel`.
    ///
    /// `rewound_to_composer` asserts the client has put the prompt text back in
    /// the composer and owns it; only then may the daemon trim a zero-output
    /// turn's prompt from history. Passing `true` without actually rewinding is
    /// how the send+cancel double-prompt bug comes back.
    ///
    /// # Errors
    ///
    /// Transport or protocol failure.
    pub fn session_cancel(
        &self,
        rewound_to_composer: bool,
        timeout: Duration,
    ) -> Result<CancelResult, AcpError> {
        let params = encode(&CancelParams {
            rewound_to_composer: rewound_to_composer.then_some(true),
        })?;
        decode(self.call(method::SESSION_CANCEL, Some(params))?.wait(timeout)?)
    }

    /// `session/models`.
    ///
    /// # Errors
    ///
    /// Transport or protocol failure.
    pub fn session_models(
        &self,
        refresh: bool,
        timeout: Duration,
    ) -> Result<ModelsResult, AcpError> {
        let params = encode(&ModelsParams {
            refresh: refresh.then_some(true),
        })?;
        decode(self.call(method::SESSION_MODELS, Some(params))?.wait(timeout)?)
    }

    /// `session/select_model`.
    ///
    /// # Errors
    ///
    /// Transport or protocol failure.
    pub fn session_select_model(
        &self,
        model: &str,
        timeout: Duration,
    ) -> Result<ModelSelection, AcpError> {
        let params = encode(&SelectModelParams {
            model: model.to_owned(),
        })?;
        decode(
            self.call(method::SESSION_SELECT_MODEL, Some(params))?
                .wait(timeout)?,
        )
    }

    /// `session/providers`.
    ///
    /// # Errors
    ///
    /// Transport or protocol failure.
    pub fn session_providers(&self, timeout: Duration) -> Result<ProvidersResult, AcpError> {
        decode(self.call(method::SESSION_PROVIDERS, None)?.wait(timeout)?)
    }

    /// `session/select_provider`.
    ///
    /// # Errors
    ///
    /// Transport or protocol failure.
    pub fn session_select_provider(
        &self,
        provider: &str,
        model: Option<&str>,
        timeout: Duration,
    ) -> Result<ModelSelection, AcpError> {
        let params = encode(&SelectProviderParams {
            provider: provider.to_owned(),
            model: model.map(str::to_owned),
        })?;
        decode(
            self.call(method::SESSION_SELECT_PROVIDER, Some(params))?
                .wait(timeout)?,
        )
    }

    fn send(&self, message: &Outbound) -> Result<(), AcpError> {
        let frame = codec::encode(message).map_err(|error| AcpError::Decode(error.to_string()))?;
        let mut writer = self.writer.lock().expect("writer poisoned");
        writer
            .write_all(&frame)
            .and_then(|()| writer.flush())
            .map_err(|error| AcpError::Transport(error.to_string()))
    }
}

impl Drop for AcpClient {
    fn drop(&mut self) {
        // The reader thread exits when the pipe closes; it is detached rather
        // than joined so a wedged daemon cannot hang teardown of the terminal.
        drop(self.reader.take());
    }
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, AcpError> {
    serde_json::from_value(value).map_err(|error| AcpError::Decode(error.to_string()))
}

fn encode<T: serde::Serialize>(params: &T) -> Result<Value, AcpError> {
    serde_json::to_value(params).map_err(|error| AcpError::Decode(error.to_string()))
}

fn read_loop<R: Read>(
    input: R,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    pending: &Pending,
    events: &Sender<AcpEvent>,
    responder: &dyn Responder,
) {
    let mut reader = BufReader::new(input);
    let mut decoder = Decoder::default();
    let mut chunk = [0u8; 16 * 1024];
    let mut frames = Vec::new();
    let closed: Option<String> = loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) => break decoder
                .finish()
                .ok()
                .flatten()
                .map(|frame| {
                    handle_frame(&frame, writer, pending, events, responder);
                })
                .and(None),
            Ok(read) => read,
            Err(error) => break Some(error.to_string()),
        };
        frames.clear();
        if let Err(error) = decoder.feed(&chunk[..read], &mut frames) {
            break Some(FramingError::to_string(&error));
        }
        for frame in &frames {
            handle_frame(frame, writer, pending, events, responder);
        }
    };

    // Nothing will ever answer the outstanding calls; let them fail fast rather
    // than sit on their timeouts.
    pending.lock().expect("pending map poisoned").clear();
    let _ = events.send(AcpEvent::Closed(closed));
}

fn handle_frame(
    frame: &str,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    pending: &Pending,
    events: &Sender<AcpEvent>,
    responder: &dyn Responder,
) {
    let raw = match serde_json::from_str::<RawMessage>(frame) {
        Ok(raw) => raw,
        Err(error) => {
            let _ = events.send(AcpEvent::Malformed(error.to_string()));
            return;
        }
    };
    let message = match raw.classify() {
        Ok(message) => message,
        Err(detail) => {
            let _ = events.send(AcpEvent::Malformed(detail));
            return;
        }
    };

    match message {
        Inbound::Response { id, outcome } => {
            if let Some(sender) = pending.lock().expect("pending map poisoned").remove(&id) {
                let _ = sender.send(*outcome);
            }
        }
        Inbound::Request { id, method, params } => {
            let reply = match responder.respond(&method, params.as_ref()) {
                Ok(result) => Outbound::result(id, result),
                Err(error) => Outbound::failure(id, error),
            };
            if let (Ok(bytes), Ok(mut writer)) = (codec::encode(&reply), writer.lock()) {
                let _ = writer.write_all(&bytes);
                let _ = writer.flush();
            }
            let _ = events.send(AcpEvent::ServerRequest { method, params });
        }
        Inbound::Notification { method, params } => {
            emit_notification(&method, params, events);
        }
    }
}

fn emit_notification(method: &str, params: Option<Value>, events: &Sender<AcpEvent>) {
    if method != method::SESSION_UPDATE {
        let _ = events.send(AcpEvent::Notification {
            method: method.to_owned(),
            params,
        });
        return;
    }
    let Some(params) = params else {
        let _ = events.send(AcpEvent::Malformed(
            "session/update notification carried no params".to_owned(),
        ));
        return;
    };
    let notification: UpdateNotification = match serde_json::from_value(params) {
        Ok(notification) => notification,
        Err(error) => {
            let _ = events.send(AcpEvent::Malformed(error.to_string()));
            return;
        }
    };
    let _ = events.send(AcpEvent::Update(Box::new(notification)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::mpsc;

    /// A writer that publishes each flushed frame so tests can assert on the wire.
    #[derive(Clone)]
    struct Tap(mpsc::Sender<String>);

    impl Write for Tap {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let _ = self.0.send(String::from_utf8_lossy(buf).into_owned());
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// A pipe that stays open: bytes arrive when the test sends them, and EOF
    /// comes only when the sender is dropped.
    ///
    /// [`Cursor`] hits EOF the moment its script runs out, which fails every
    /// outstanding call — the exact opposite of the condition a turn-length
    /// `session/prompt` lives in.
    struct Pipe {
        chunks: mpsc::Receiver<Vec<u8>>,
        rest: Vec<u8>,
    }

    impl Read for Pipe {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            while self.rest.is_empty() {
                match self.chunks.recv() {
                    Ok(chunk) => self.rest = chunk,
                    Err(_) => return Ok(0),
                }
            }
            let taken = self.rest.len().min(buf.len());
            buf[..taken].copy_from_slice(&self.rest[..taken]);
            self.rest.drain(..taken);
            Ok(taken)
        }
    }

    /// A client whose daemon is still connected and simply has not spoken yet.
    fn open_client(
        script: &str,
    ) -> (AcpClient, mpsc::Sender<Vec<u8>>, mpsc::Receiver<String>) {
        let (bytes_tx, bytes_rx) = mpsc::channel();
        let (wire_tx, wire_rx) = mpsc::channel();
        let client = AcpClient::spawn(
            Pipe {
                chunks: bytes_rx,
                rest: Vec::new(),
            },
            Tap(wire_tx),
            MethodNotFound,
        );
        bytes_tx.send(script.as_bytes().to_vec()).expect("pipe open");
        (client, bytes_tx, wire_rx)
    }

    fn client(script: &str) -> (AcpClient, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel();
        let client = AcpClient::spawn(
            Cursor::new(script.as_bytes().to_vec()),
            Tap(tx),
            MethodNotFound,
        );
        (client, rx)
    }

    fn drain(events: &Receiver<AcpEvent>, count: usize) -> Vec<AcpEvent> {
        (0..count)
            .map(|_| {
                events
                    .recv_timeout(Duration::from_secs(2))
                    .expect("event within 2s")
            })
            .collect()
    }

    /// A canonical `session/update` notification line.
    fn notification(update: &str) -> String {
        format!(
            "{{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\
              \"params\":{{\"sessionId\":\"s-1\",\"update\":{update}}}}}\n"
        )
    }

    #[test]
    fn resolves_a_pending_call_by_id() {
        let (client, _wire) = client("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"cancelled\":true}}\n");
        let result = client.session_cancel(false, Duration::from_secs(2)).unwrap();
        assert!(result.cancelled);
    }

    #[test]
    fn surfaces_a_daemon_error_as_rpc() {
        let (client, _wire) =
            client("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32800,\"message\":\"cancelled\"}}\n");
        let error = client
            .session_cancel(false, Duration::from_secs(2))
            .unwrap_err();
        assert!(matches!(error, AcpError::Rpc(ref rpc) if rpc.code == -32800));
    }

    #[test]
    fn answers_a_daemon_request_with_method_not_found_and_keeps_reading() {
        let (client, wire) = client(&format!(
            "{}{}",
            "{\"jsonrpc\":\"2.0\",\"id\":\"server-1\",\"method\":\"session/request_permission\"}\n",
            notification(r#"{"sessionUpdate":"report","message":"still alive"}"#),
        ));
        let events = drain(client.events(), 2);
        assert!(matches!(events[0], AcpEvent::ServerRequest { .. }));
        let AcpEvent::Update(ref frame) = events[1] else {
            panic!("expected an update");
        };
        assert!(
            matches!(frame.update, super::super::types::Update::Report(ref report)
                if report.message == "still alive")
        );

        let reply = wire.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(reply.contains("\"id\":\"server-1\""), "{reply}");
        assert!(reply.contains("-32601"), "{reply}");
        assert!(reply.ends_with('\n'));
    }

    #[test]
    fn a_frame_that_is_not_the_canonical_envelope_is_malformed_not_silently_dropped() {
        // The pre-rewrite `{event, …}` frame no longer exists on the wire. If one ever
        // reappeared it would be a daemon regression, so it surfaces as `Malformed`
        // rather than being filtered out where nobody would notice.
        let (client, _wire) = client(&format!(
            "{}{}",
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":\
              {\"event\":{\"type\":\"text_delta\",\"text\":\"hi\"}}}\n",
            notification(
                r#"{"sessionUpdate":"delta","messageId":"m","partId":"p","field":"text","delta":"hi"}"#
            ),
        ));
        let events = drain(client.events(), 2);
        assert!(matches!(events[0], AcpEvent::Malformed(_)), "{:?}", events[0]);
        let AcpEvent::Update(ref frame) = events[1] else {
            panic!("expected the canonical update");
        };
        assert_eq!(frame.update.tag(), "delta");
        assert_eq!(frame.session_id, "s-1");
    }

    #[test]
    fn an_update_this_build_does_not_model_still_reaches_the_render_loop() {
        let (client, _wire) = client(&notification(
            r#"{"sessionUpdate":"telemetry","frames":12}"#,
        ));
        let events = drain(client.events(), 1);
        let AcpEvent::Update(ref frame) = events[0] else {
            panic!("expected an update");
        };
        assert!(frame.update.is_unknown());
        assert_eq!(frame.update.tag(), "telemetry");
    }

    #[test]
    fn a_malformed_frame_does_not_stop_the_stream() {
        let (client, _wire) = client(&format!(
            "not json\n{}",
            notification(r#"{"sessionUpdate":"report","message":"ok"}"#),
        ));
        let events = drain(client.events(), 2);
        assert!(matches!(events[0], AcpEvent::Malformed(_)));
        assert!(matches!(events[1], AcpEvent::Update(_)));
    }

    #[test]
    fn closing_the_pipe_fails_outstanding_calls_instead_of_hanging() {
        let (client, _wire) = client("");
        // Give the reader thread a moment to observe EOF before we call.
        std::thread::sleep(Duration::from_millis(50));
        let error = client
            .session_cancel(false, Duration::from_secs(5))
            .unwrap_err();
        assert!(matches!(error, AcpError::Transport(_)));
    }

    #[test]
    fn prompt_frames_carry_the_prompt_field_the_daemon_reads() {
        let (client, wire) = client("");
        let _call = client.session_prompt("ship it");
        let frame = wire.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(frame.contains("\"method\":\"session/prompt\""), "{frame}");
        assert!(frame.contains("\"prompt\":\"ship it\""), "{frame}");
    }

    #[test]
    fn a_prompt_outlives_any_client_side_deadline_and_the_stream_keeps_moving() {
        // A turn is a 30-minute operation (LYRA.md §3.4). The *daemon* owns that
        // deadline — its method table gives prompt-class requests
        // `reliability.turn_timeout` rather than the 60s every question gets —
        // and this side's job is simply to tolerate the wait. `session_prompt`
        // therefore takes no timeout at all: it hands back a [`Call`] the render
        // loop polls without blocking, so updates keep arriving and the TUI stays
        // interactive for the whole turn.
        let (client, daemon, wire) = open_client("");
        let call = client.session_prompt("spawn a subagent and wait").unwrap();
        assert!(wire
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .contains("session/prompt"));

        for frame in [
            notification(
                r#"{"sessionUpdate":"tool_call_start","toolCallId":"c-1","messageId":"m-1","partId":"p-1","tool":"bash","argsSummary":"cargo test"}"#,
            ),
            notification(r#"{"sessionUpdate":"report","message":"still working"}"#),
        ] {
            daemon.send(frame.into_bytes()).expect("pipe open");
        }
        let events = drain(client.events(), 2);
        assert!(matches!(events[0], AcpEvent::Update(_)));
        assert!(matches!(events[1], AcpEvent::Update(_)));
        assert!(
            call.poll().is_none(),
            "the turn is still running and nothing on this side may end it"
        );

        // Cancellation still lands mid-turn: the notification goes out on the
        // same connection while the request is outstanding, and the daemon's
        // answer resolves the call that has been waiting all along.
        client.cancel_request(call.id()).unwrap();
        let cancel = wire.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(cancel.contains("$/cancelRequest"), "{cancel}");
        assert!(cancel.contains("\"id\":1"), "{cancel}");
        daemon
            .send(
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32800,\"message\":\"cancelled\"}}\n"
                    .as_bytes()
                    .to_vec(),
            )
            .expect("pipe open");
        let answered = call
            .wait(Duration::from_secs(2))
            .expect_err("a cancelled turn answers with an error");
        assert!(matches!(answered, AcpError::Rpc(ref rpc) if rpc.code == -32800));
    }

    #[test]
    fn steering_uses_the_renamed_method_not_the_colliding_alias() {
        let (client, wire) = client("");
        let _ = client.session_steer("use the session helper", Duration::from_millis(10));
        let frame = wire.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(frame.contains("\"method\":\"session/steer\""), "{frame}");
        assert!(!frame.contains("session/update"), "{frame}");
    }

    #[test]
    fn cancel_only_claims_a_rewind_when_one_happened() {
        let (plain, wire) = client("");
        let _ = plain.session_cancel(false, Duration::from_millis(10));
        let bare = wire.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(!bare.contains("rewoundToComposer"), "{bare}");

        let (rewinding, wire) = client("");
        let _ = rewinding.session_cancel(true, Duration::from_millis(10));
        let rewound = wire.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(rewound.contains("\"rewoundToComposer\":true"), "{rewound}");
    }
}
