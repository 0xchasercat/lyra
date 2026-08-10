//! Replaying a resumed session's transcript into scrollback.
//!
//! # Why this exists
//!
//! `session/snapshot` has always carried `entries` — the daemon's own JSONL, the
//! whole prior conversation — and this client threw them away. Resuming a
//! session therefore *worked* (the model had the context) while showing the user
//! an empty screen, which is indistinguishable from having loaded the wrong
//! session, or nothing at all. This module is the missing half.
//!
//! # Three rules it is built around
//!
//! 1. **Through the [`Transcript`], never around it.** Every replayed row is
//!    committed as a [`crate::ui::transcript::Entry`], so a purge resize
//!    re-renders resumed history at the new width exactly as it re-renders live
//!    output (DESIGN.md §1). Pushing pre-wrapped rows straight at the
//!    compositor would have been shorter and would have made every resumed
//!    session permanently stale.
//!
//! 2. **Loose JSON, tolerated.** `entries` is `Vec<Value>`: the daemon's entry
//!    vocabulary grows independently of this binary. An entry whose `type` this
//!    build does not know is skipped **silently** — forward compatibility means
//!    a new daemon must not paint an old client's scrollback with complaints —
//!    while an entry that is not a well-formed entry at all leaves one dim
//!    marker and the replay carries on. Nothing here can panic on input: there
//!    is no indexing, no `unwrap`, and no assumption that a field has the type
//!    its name suggests.
//!
//! 3. **Bounded.** Scrollback is immutable, so a replay is paid for in terminal
//!    writes that can never be taken back. [`REPLAY_CAP`] entries is the
//!    ceiling; what is dropped is *named* (`… 9 800 earlier entries not shown`)
//!    rather than silently missing, because a transcript that begins mid-thought
//!    with no explanation is its own bug report.
//!
//! # Credentials
//!
//! There are none to leak here. Every byte this module renders came out of the
//! session transcript, which is by definition what the user already saw; the
//! provider-setup surfaces are the ones that touch secrets, and they never reach
//! a transcript entry. The rule is nonetheless load-bearing in one direction:
//! this module renders transcript entries *only*, and must never be handed a
//! `provider/*` payload to "summarise".

use serde_json::{Map, Value};

use crate::state::{ToolCall, ToolState};
use crate::ui::tool_row::ToolView;
use crate::ui::transcript::Transcript;
use crate::ui::Row;

/// How many transcript entries a resume replays.
///
/// A ten-thousand-entry session must not cost a minute of terminal writes to
/// reattach to, and the rows above the cap are ones the user would have to
/// scroll past anyway. Two hundred entries is several screens of context —
/// enough to recognise the session and pick the thread back up — and the
/// elision marker says exactly how much came before.
pub const REPLAY_CAP: usize = 200;

/// How much of a tool result survives into its collapsed row.
const RESULT_SUMMARY_CHARS: usize = 200;

/// A tool call's outcome, recovered from the `tool_result` block that answered it.
struct Outcome {
    summary: Option<String>,
    is_error: bool,
}

/// Commit a resumed session's history to scrollback.
///
/// Returns the rows to print. An empty or brand-new session (nothing but its
/// session header entry) returns nothing at all: there is no history to bracket,
/// and a pair of rules around emptiness would be noise claiming to be context.
///
/// `session` names the session in the two bracket lines, so the screen says
/// which transcript this is rather than leaving the user to infer it.
pub fn replay(transcript: &mut Transcript, entries: &[Value], session: &str) -> Vec<Row> {
    let messages = message_count(entries);
    let renderable: Vec<&Value> = entries.iter().filter(|entry| renders(entry)).collect();
    if renderable.is_empty() {
        return Vec::new();
    }
    let skipped = renderable.len().saturating_sub(REPLAY_CAP);
    let kept = &renderable[skipped..];
    let outcomes = outcomes(kept);

    let mut rows = transcript.blank();
    rows.extend(transcript.rule(&format!("history · {session}")));
    if skipped > 0 {
        rows.extend(transcript.audit(&format!(
            "… {skipped} earlier {} not shown",
            plural(skipped, "entry", "entries")
        )));
    }
    for entry in kept {
        rows.extend(entry_rows(transcript, entry, &outcomes));
    }
    rows.extend(transcript.rule(&format!(
        "resumed · {session} · {messages} {}",
        plural(messages, "message", "messages")
    )));
    rows.extend(transcript.blank());
    rows
}

/// Whether an entry contributes anything to scrollback.
///
/// The split that matters is between *unknown* and *malformed*. An object with a
/// `type` this build has never heard of is a newer daemon talking, and is
/// skipped without a trace. A value that is not an object, or has no `type` at
/// all, is damage — it gets a marker, because silently dropping part of a
/// transcript is how a client teaches a user to distrust it.
fn renders(entry: &Value) -> bool {
    match kind(entry) {
        // Identity (already in the header), running totals (the footer's) and
        // internal checkpoints: real entries with nothing to say on screen.
        Some("session" | "usage" | "checkpoint") => false,
        Some(known) => KNOWN_TYPES.contains(&known),
        None => true,
    }
}

/// Entry types this build renders. Anything else with a `type` is a newer
/// daemon's, and is skipped in silence.
const KNOWN_TYPES: [&str; 5] = ["message", "boundary", "repair", "error", "provider_switch"];

/// The `type` of a well-formed entry.
fn kind(entry: &Value) -> Option<&str> {
    entry.as_object()?.get("type")?.as_str()
}

fn is_message(entry: &Value) -> bool {
    kind(entry) == Some("message")
}

/// How many messages a transcript holds.
///
/// The same count the `resumed · … · N messages` rule prints, exposed because a
/// same-session re-adoption renders no history block to put it in and still owes
/// the user a number: `session rewind · back to N messages` is the only thing on
/// screen that says where the transcript now ends.
#[must_use]
pub fn message_count(entries: &[Value]) -> usize {
    entries.iter().filter(|entry| is_message(entry)).count()
}

/// Pair every `tool_result` in the replayed slice with the call it answered.
///
/// A tool's outcome lives in the *next* message entry, and scrollback is
/// append-only: by the time the result is read the collapsed row is already
/// printed and unfixable. So the results are collected up front and the row is
/// rendered with its real summary the first time — which is the whole difference
/// between `▸ read src/auth.ts` and `▸ read src/auth.ts · 412 lines`.
fn outcomes(entries: &[&Value]) -> Map<String, Value> {
    let mut found = Map::new();
    for entry in entries {
        let Some(blocks) = content_blocks(entry) else {
            continue;
        };
        for block in blocks {
            let Some(block) = block.as_object() else {
                continue;
            };
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(id) = block.get("toolUseId").and_then(Value::as_str) else {
                continue;
            };
            found.insert(id.to_owned(), Value::Object(block.clone()));
        }
    }
    found
}

/// The `content` array of a message entry.
fn content_blocks(entry: &Value) -> Option<&Vec<Value>> {
    let object = entry.as_object()?;
    if object.get("type")?.as_str()? != "message" {
        return None;
    }
    object.get("content")?.as_array()
}

/// One entry's rows.
fn entry_rows(
    transcript: &mut Transcript,
    entry: &Value,
    outcomes: &Map<String, Value>,
) -> Vec<Row> {
    match kind(entry) {
        Some("message") => message_rows(transcript, entry, outcomes),
        Some("boundary") => boundary_rows(transcript, entry),
        Some("repair") => repair_rows(transcript, entry),
        Some("error") => {
            let object = entry.as_object();
            let message = object
                .and_then(|object| object.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("the turn failed");
            let classification = object
                .and_then(|object| object.get("classification"))
                .and_then(Value::as_str);
            transcript.audit(&match classification {
                Some(class) => format!("error · {class} · {}", one_line(message)),
                None => format!("error · {}", one_line(message)),
            })
        }
        Some("provider_switch") => {
            let object = entry.as_object();
            let provider = object
                .and_then(|object| object.get("provider"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let model = object
                .and_then(|object| object.get("model"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let line = format!("provider · {provider} {model}");
            transcript.audit(line.trim_end())
        }
        // `renders` already dropped every other known type; reaching here with a
        // `Some` would mean the two lists disagreed, which is a marker, not a panic.
        Some(_) | None => transcript.audit("· unreadable transcript entry skipped"),
    }
}

/// A `message` entry: the conversation itself.
fn message_rows(
    transcript: &mut Transcript,
    entry: &Value,
    outcomes: &Map<String, Value>,
) -> Vec<Row> {
    let Some(object) = entry.as_object() else {
        return transcript.audit("· unreadable transcript entry skipped");
    };
    let Some(blocks) = object.get("content").and_then(Value::as_array) else {
        return transcript.audit("· unreadable transcript entry skipped");
    };
    let role = object.get("role").and_then(Value::as_str).unwrap_or("");
    let mut rows = match role {
        "user" => user_rows(transcript, blocks),
        "assistant" => assistant_rows(transcript, blocks, outcomes),
        // A role this build does not model is still a message; showing its prose
        // dim beats showing nothing, and beats guessing it is the user's.
        _ => {
            let text = text_of(blocks);
            if text.is_empty() {
                Vec::new()
            } else {
                transcript.audit(&one_line(&text))
            }
        }
    };
    // How the turn ended, when it did not end ordinarily. **Once.** The daemon
    // states this twice — the entry's `status`, and a `marker` block the agent
    // loop appends to the assistant's content ("cancelled · The user cancelled
    // the turn; partial assistant output was retained. Turn cancelled by
    // user") — and rendering both put the same fact on screen two ways, one of
    // them saying "cancelled" twice in its own sentence. The marker is the
    // fallback for a transcript that carries no status, never a second line.
    match ending(object, blocks) {
        Some("interrupted") => rows.extend(transcript.audit("interrupted")),
        Some(status) => rows.extend(transcript.turn_end(status)),
        None => {}
    }
    rows
}

/// The turn endings that are stated twice, and are therefore rendered from
/// exactly one of the two statements.
const ENDINGS: [&str; 2] = ["cancelled", "interrupted"];

/// How this turn ended, from whichever of the two places says so.
fn ending<'a>(object: &'a Map<String, Value>, blocks: &'a [Value]) -> Option<&'a str> {
    if let Some(status) = object
        .get("status")
        .and_then(Value::as_str)
        .filter(|status| ENDINGS.contains(status))
    {
        return Some(status);
    }
    blocks
        .iter()
        .filter_map(|block| block.as_object())
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("marker"))
        .find_map(|block| {
            block
                .get("reason")
                .and_then(Value::as_str)
                .filter(|reason| ENDINGS.contains(reason))
        })
}

/// A user turn. Prose becomes a band; a `[report]` line is an audit row this
/// runtime wrote itself, not something the user typed; a `[hub message from …]`
/// line is another *agent* speaking and gets the aside row the live path gives
/// it; `tool_result` blocks render nothing, because they were already folded
/// into their tool rows.
///
/// The hub case is why this function reads the text rather than the role. A hub
/// aside is persisted as a user-role message — that is the whole point of the
/// design, so compaction and `/context` attribute it correctly — and a replay
/// that trusted the role alone would put another agent's words in the user's
/// band, which is exactly the misattribution the live path was fixed to avoid.
/// A transcript written before hub asides existed simply never matches, so the
/// absence costs nothing.
fn user_rows(transcript: &mut Transcript, blocks: &[Value]) -> Vec<Row> {
    let text = text_of(blocks);
    if text.trim().is_empty() {
        return Vec::new();
    }
    if let Some(report) = text.strip_prefix("[report] ") {
        return transcript.audit(&one_line(report));
    }
    match crate::ui::agent::unwrap_aside(&text) {
        (Some(from), body) => transcript.hub_aside(&from, &body),
        (None, _) => transcript.user(text.trim_end()),
    }
}

/// An assistant turn, in block order: prose as markdown, tool calls as collapsed
/// rows, thinking under whatever `[tui] thinking` says — because a replay that
/// showed more (or less) than the live path would contradict the session the
/// user actually watched.
///
/// The default (`collapsed`) shows nothing here, and that is not an oversight:
/// the live one-liner's whole content is a *duration*, which a persisted
/// transcript does not carry. `∴ thought` with no figure would be a row that
/// tells a reader only that a model thought, which every row in a transcript
/// already implies. `full` renders the trace, which is the mode that asked for
/// it. Should the daemon ever persist a thinking duration, this is the one place
/// that has to change.
fn assistant_rows(
    transcript: &mut Transcript,
    blocks: &[Value],
    outcomes: &Map<String, Value>,
) -> Vec<Row> {
    let mut rows = Vec::new();
    let mut prose = String::new();
    for block in blocks {
        let Some(block) = block.as_object() else {
            continue;
        };
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    prose.push_str(text);
                }
            }
            Some("tool_use") => {
                rows.extend(flush(transcript, &mut prose));
                let view = tool_view(block, outcomes);
                rows.extend(transcript.tool(view));
            }
            Some("thinking") => {
                let text = block
                    .get("thinking")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                // Never `signature`: it is opaque provider bytes, it is not
                // reasoning, and it is not shown in any mode (`ui::thinking`).
                let seconds = block.get("durationMs").and_then(Value::as_u64).map(seconds);
                if !text.trim().is_empty() || seconds.is_some() {
                    rows.extend(flush(transcript, &mut prose));
                    rows.extend(transcript.replayed_thinking(text, seconds));
                }
            }
            Some("marker") => {
                let reason = block
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("marker");
                // How the turn ended is [`message_rows`]'s line to draw, in the
                // live path's own words. Drawing it here as well is the
                // duplication this arm used to be half of.
                if ENDINGS.contains(&reason) {
                    continue;
                }
                rows.extend(flush(transcript, &mut prose));
                let detail = block.get("detail").and_then(Value::as_str).unwrap_or("");
                let marker = if detail.trim().is_empty() {
                    reason.to_owned()
                } else {
                    format!("{reason} · {}", one_line(detail))
                };
                rows.extend(transcript.audit(&marker));
            }
            // Reasoning, images, tool results in an assistant turn, and anything
            // a newer daemon invents: nothing on screen, no complaint.
            _ => {}
        }
    }
    rows.extend(flush(transcript, &mut prose));
    rows
}

/// Publish the accumulated prose as one markdown block and reset the buffer.
fn flush(transcript: &mut Transcript, prose: &mut String) -> Vec<Row> {
    if prose.trim().is_empty() {
        prose.clear();
        return Vec::new();
    }
    let source = std::mem::take(prose);
    let mut rows = transcript.assistant_delta(&source);
    rows.extend(transcript.end_assistant());
    rows
}

/// A compaction (or `/clear`) boundary, as the same rule the live path draws.
fn boundary_rows(transcript: &mut Transcript, entry: &Value) -> Vec<Row> {
    let object = entry.as_object();
    let number = |key: &str| -> i64 {
        object
            .and_then(|object| object.get(key))
            .and_then(Value::as_i64)
            .unwrap_or(0)
    };
    let delta = number("tokensAfter").saturating_sub(number("tokensBefore"));
    transcript.compacted(delta, None)
}

/// Context repairs, one marker each, exactly as the live `context_repair` update
/// renders them.
fn repair_rows(transcript: &mut Transcript, entry: &Value) -> Vec<Row> {
    let repairs = entry
        .as_object()
        .and_then(|object| object.get("repairs"))
        .and_then(Value::as_array);
    let Some(repairs) = repairs else {
        return transcript.context_repaired("");
    };
    let mut rows = Vec::new();
    for repair in repairs {
        let detail = repair
            .as_object()
            .and_then(|object| object.get("detail"))
            .and_then(Value::as_str)
            .unwrap_or("");
        rows.extend(transcript.context_repaired(detail));
    }
    rows
}

/// One tool call, as the collapsed row it would have been live.
///
/// Built as a [`ToolCall`] and handed to [`ToolView::from_call`] rather than
/// assembled by hand, so a replayed edit gets the same target extraction and the
/// same structured diff the live path gives it — one renderer, two sources.
fn tool_view(block: &Map<String, Value>, outcomes: &Map<String, Value>) -> ToolView {
    let id = block
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let outcome = outcomes.get(&id).map(outcome_of);
    ToolView::from_call(&ToolCall {
        id: id.clone(),
        name: block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_owned(),
        arguments: String::new(),
        args: block.get("input").cloned(),
        args_summary: None,
        // No result on file means the transcript ends mid-call: pending is the
        // honest state, and it renders dim rather than claiming success.
        state: match &outcome {
            Some(outcome) if outcome.is_error => ToolState::Failed,
            Some(_) => ToolState::Succeeded,
            None => ToolState::Pending,
        },
        result_summary: outcome.and_then(|outcome| outcome.summary),
        started_at_ms: None,
        duration_ms: None,
        interrupted: false,
        files_read: Vec::new(),
        files_modified: Vec::new(),
        exit_code: None,
    })
}

/// What a `tool_result` block says happened.
fn outcome_of(block: &Value) -> Outcome {
    let object = block.as_object();
    let is_error = object
        .and_then(|object| object.get("isError"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let content = object.and_then(|object| object.get("content"));
    let text = match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => text_of(blocks),
        _ => String::new(),
    };
    let summary = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| truncate(line, RESULT_SUMMARY_CHARS));
    Outcome { summary, is_error }
}

/// The prose of a block list: `text` blocks joined, everything else ignored.
fn text_of(blocks: &[Value]) -> String {
    let mut text = String::new();
    for block in blocks {
        let Some(block) = block.as_object() else {
            continue;
        };
        if block.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        if let Some(part) = block.get("text").and_then(Value::as_str) {
            text.push_str(part);
        }
    }
    text
}

/// Milliseconds as whole seconds, for a duration a transcript happened to keep.
const fn seconds(millis: u64) -> u64 {
    millis / 1_000
}

/// Collapse to one line, for the rows that are one line by contract.
fn one_line(text: &str) -> String {
    truncate(&text.split_whitespace().collect::<Vec<_>>().join(" "), 200)
}

/// Truncate on a character boundary, with the visible `…` DESIGN.md §3 asks for.
fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(limit).collect();
    out.push('…');
    out
}

const fn plural<'a>(count: usize, one: &'a str, many: &'a str) -> &'a str {
    if count == 1 {
        one
    } else {
        many
    }
}
