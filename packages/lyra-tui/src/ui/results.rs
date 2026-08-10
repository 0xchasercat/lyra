//! Slash-command results, rendered — **never dumped**.
//!
//! `session/command` answers with structured data, and the one thing this module
//! may not do with it is print it as JSON. A brace on the terminal is a bug
//! here: a slash command's whole purpose is to show something, and
//! `{"models":[{"id":"opus-5",...}]}` shows nothing that a table would not show
//! better.
//!
//! # Dispatch
//!
//! Every `session/command` answer names its own shape through `resultKind`
//! (`#/$defs/commandResultKind`), declared up front by `session/commands` and
//! repeated on the answer, so a client dispatches to a renderer instead of
//! sniffing the payload. [`KINDS`] is this module's half of that contract, and
//! `acp::conformance` asserts it equals the schema's enum.
//!
//! | kind | shape |
//! |---|---|
//! | `models`, `sessions`, `workspaces`, `agents`, `skills`, `mcp` | aligned table, dim header, `▸` on the current row |
//! | `health` | label/value rows, nested groups indented |
//! | `context` | token breakdown, raw numbers |
//! | `report` | markdown, through the same renderer the transcript uses |
//!
//! The `…Result` spellings of the same names are accepted too: they are what the
//! `$def` holding each shape is called, and a daemon that sends one is naming a
//! renderer this module has rather than an unknown one.
//!
//! # The two rules under the dispatch
//!
//! 1. **Raw measurements.** Token counts render as numbers. A percentage appears
//!    only when a real limit came over the wire (DESIGN.md §2: "absent limit ⇒
//!    render nothing rather than a wrong number").
//! 2. **No shape is unrenderable.** A kind this build has never heard of, or a
//!    payload that does not match its kind, falls through to a key/value tree —
//!    indented, dim-keyed, and still not JSON. The fallback is the reason no
//!    daemon change can put a brace on the terminal.

use serde_json::{Map, Value};
use unicode_width::UnicodeWidthStr;

use crate::theme::Theme;
use crate::ui::diff::FileDiff;
use crate::ui::tool_row::{self, ToolStatus, ToolView};
use crate::ui::{markdown, Row, Span};

/// Left margin every result row shares with the transcript grammar.
const INDENT: &str = "  ";

/// Every `resultKind` this module dispatches on, in the schema's spelling.
///
/// Kept in step with `#/$defs/commandResultKind` by a conformance test: a kind
/// the daemon can send and this list does not name would render as a key/value
/// tree, which is legible but is not the table it deserves.
pub const KINDS: [&str; 11] = [
    "models",
    "sessions",
    "workspaces",
    "agents",
    "health",
    "context",
    "skills",
    "mcp",
    "checkpoints",
    "review",
    "report",
];

/// Render one `session/command` answer.
///
/// `line` is the command as typed, for the error row. `declared` is the
/// `resultKind` the command registry declared, used when the payload does not
/// carry one of its own.
#[must_use]
pub fn render(
    theme: &Theme,
    width: u16,
    line: &str,
    declared: Option<&str>,
    value: &Value,
) -> Vec<Row> {
    if let Some(error) = string_at(value, "error") {
        return vec![
            Row::styled(format!("{INDENT}{line}: {error}"), theme.error()),
            Row::blank(),
        ];
    }
    // `{command, output?}` with no `output` is a command that did its work and
    // has nothing to show. Rendering `command  compact` back at the user would
    // be repeating what they just typed.
    static NOTHING: Value = Value::Null;
    let payload = value.get("output").unwrap_or_else(|| {
        if value.get("command").is_some() {
            &NOTHING
        } else {
            value
        }
    });
    let kind = string_at(value, "resultKind")
        .or_else(|| string_at(payload, "resultKind"))
        .or_else(|| declared.map(str::to_owned));
    // `models` and `modelsResult` name the same renderer: one is the enum
    // value, the other the `$def` holding the shape it points at.
    let kind = kind.map(|kind| kind.trim_end_matches("Result").to_owned());

    let mut rows = match kind.as_deref() {
        Some("models") => table(
            theme,
            width,
            payload,
            &["models"],
            &["id", "model", "name", "ownedBy", "contextWindow", "inputPricePerMillion", "outputPricePerMillion"],
        ),
        Some("sessions") => table(
            theme,
            width,
            payload,
            &["sessions"],
            &["name", "sessionId", "active", "updatedAt", "path"],
        ),
        Some("workspaces") => table(
            theme,
            width,
            payload,
            &["workspaces"],
            &["name", "state", "mode", "origin", "task", "degradedReason", "path"],
        ),
        // The `agentHandle` vocabulary, in the order a reader needs it: who it
        // is on the bus, what state it is in — `queued`/`awaiting_tool`/
        // `timed_out`/`cancelled` are distinct answers now, and telling them
        // apart is the whole reason `/agents` exists — then what it has done.
        // `filesModified`, `writeScope` and `scopeViolations` are arrays and get
        // no column at all: a table cell is a scalar (see [`columns`]), and the
        // paths belong to the child's own result.
        Some("agents") => table(
            theme,
            width,
            payload,
            &["agents"],
            &[
                "id",
                "peer",
                "label",
                "status",
                "model",
                "toolCalls",
                "currentTool",
                "elapsedMs",
                "error",
                "workspace",
            ],
        ),
        Some("skills") => table(
            theme,
            width,
            payload,
            &["skills"],
            &["name", "origin", "description", "path"],
        ),
        Some("mcp") => table(
            theme,
            width,
            payload,
            &["tools", "servers"],
            &["server", "name", "description"],
        ),
        Some("health") => Some(pairs(theme, width, payload)),
        Some("context") => Some(context(theme, width, payload)),
        Some("checkpoints") => Some(checkpoints(theme, width, payload)),
        Some("review") => Some(review(theme, width, payload)),
        _ => None,
    }
    .unwrap_or_else(|| open(theme, width, payload));

    if rows.is_empty() {
        rows.push(Row::styled(
            format!("{INDENT}{line} · ok"),
            theme.faint(),
        ));
    }
    rows.push(Row::blank());
    rows
}

/// The open shapes: a markdown report, otherwise a key/value tree.
fn open(theme: &Theme, width: u16, payload: &Value) -> Vec<Row> {
    if let Some(report) = string_at(payload, "report") {
        let mut rows = markdown::render_document(&report, theme, width);
        // The raw payload travels *beside* the prose rather than flattened into
        // it, so it gets the tree rather than being dropped on the floor.
        match payload.get("detail") {
            None | Some(Value::Null) => {}
            Some(detail) => rows.extend(tree(theme, width, detail, 1)),
        }
        return rows;
    }
    match payload {
        Value::Null => Vec::new(),
        // A bare string answer is prose, and prose goes through markdown like
        // every other piece of prose this TUI shows.
        Value::String(text) => markdown::render_document(text, theme, width),
        other => tree(theme, width, other, 1),
    }
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/// Find the row array and render it as an aligned table.
///
/// `containers` are the keys the array is expected under; the first array of
/// objects anywhere in the payload is the fallback, so a daemon that renames
/// `servers` to `mcpServers` degrades to a correct table rather than to a dump.
fn table(
    theme: &Theme,
    width: u16,
    payload: &Value,
    containers: &[&str],
    preferred: &[&str],
) -> Option<Vec<Row>> {
    let items = containers
        .iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_array))
        .or_else(|| payload.as_array())
        .or_else(|| first_object_array(payload))?;
    let objects: Vec<&Map<String, Value>> = items.iter().filter_map(Value::as_object).collect();
    if objects.is_empty() {
        // An empty list is a fact, and "never render nothing" means saying it.
        return Some(vec![Row::styled(format!("{INDENT}none"), theme.faint())]);
    }

    let columns = columns(&objects, preferred);
    let current = payload
        .get("current")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let cells: Vec<Vec<String>> = objects
        .iter()
        .map(|object| {
            columns
                .iter()
                .map(|key| scalar(object.get(key.as_str())))
                .collect()
        })
        .collect();
    let marked: Vec<bool> = objects
        .iter()
        .map(|object| is_current(object, current.as_deref()))
        .collect();

    let mut widths: Vec<usize> = columns
        .iter()
        .map(|key| UnicodeWidthStr::width(header(key).as_str()))
        .collect();
    for row in &cells {
        for (index, cell) in row.iter().enumerate() {
            widths[index] = widths[index].max(UnicodeWidthStr::width(cell.as_str()));
        }
    }
    // The marker column plus the indent; the last column is never padded, so a
    // wide table degrades by truncation rather than by wrapping.
    let budget = (width as usize).saturating_sub(INDENT.len() + 2);

    let mut rows = vec![Row {
        spans: vec![
            Span::new(format!("{INDENT}  "), theme.faint()),
            Span::new(
                lay_out(&columns.iter().map(|key| header(key)).collect::<Vec<_>>(), &widths, budget),
                theme.faint(),
            ),
        ],
    }];
    for (index, row) in cells.iter().enumerate() {
        let (marker, style) = if marked[index] {
            ("▸ ", theme.accent())
        } else {
            ("  ", theme.muted())
        };
        rows.push(Row {
            spans: vec![
                Span::new(format!("{INDENT}{marker}"), theme.accent()),
                Span::new(lay_out(row, &widths, budget), style),
            ],
        });
    }
    Some(rows)
}

/// Which columns a table shows: the preferred ones that exist, then whatever
/// else the rows carry, in first-row order. Nested values get no column — a
/// table cell is a scalar or it is nothing.
fn columns(objects: &[&Map<String, Value>], preferred: &[&str]) -> Vec<String> {
    let usable = |key: &str| {
        objects
            .iter()
            .any(|object| object.get(key).is_some_and(is_scalar))
    };
    let mut columns: Vec<String> = preferred
        .iter()
        .filter(|key| usable(key))
        .map(|key| (*key).to_owned())
        .collect();
    for object in objects {
        for key in object.keys() {
            if !NEVER_A_COLUMN.contains(&key.as_str()) && usable(key) && !columns.contains(key) {
                columns.push(key.clone());
            }
        }
    }
    columns
}

/// Scalar fields that are nonetheless not table cells.
///
/// `resultKind` is the envelope's, not a row's. `partialOutput` is the tail of
/// what a child has *said* — prose, often several lines of it — and a column is
/// one line by construction, so putting it in one would truncate the answer to
/// its first few words while making every other column unreadable. A caller who
/// wants it has `/agents <id>` and the child's own result.
const NEVER_A_COLUMN: [&str; 2] = ["resultKind", "partialOutput"];

/// Pad every cell but the last, and stop at the width.
fn lay_out(cells: &[String], widths: &[usize], budget: usize) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    for (index, cell) in cells.iter().enumerate() {
        if used >= budget {
            break;
        }
        let last = index + 1 == cells.len();
        let padded = if last {
            cell.clone()
        } else {
            let pad = widths[index].saturating_sub(UnicodeWidthStr::width(cell.as_str()));
            format!("{cell}{}  ", " ".repeat(pad))
        };
        let room = budget - used;
        if UnicodeWidthStr::width(padded.as_str()) > room {
            out.push_str(&clip(&padded, room));
            break;
        }
        used += UnicodeWidthStr::width(padded.as_str());
        out.push_str(&padded);
    }
    out.trim_end().to_owned()
}

/// Whether a row is the one already in force.
fn is_current(object: &Map<String, Value>, current: Option<&str>) -> bool {
    if object.get("active").and_then(Value::as_bool) == Some(true)
        || object.get("current").and_then(Value::as_bool) == Some(true)
        || object.get("selected").and_then(Value::as_bool) == Some(true)
    {
        return true;
    }
    let Some(current) = current else { return false };
    ["id", "name", "model"]
        .iter()
        .filter_map(|key| object.get(*key).and_then(Value::as_str))
        .any(|value| value == current)
}

// ---------------------------------------------------------------------------
// Label/value and context
// ---------------------------------------------------------------------------

/// `healthResult`: one label/value row per scalar, nested groups indented.
fn pairs(theme: &Theme, width: u16, payload: &Value) -> Vec<Row> {
    tree(theme, width, payload, 1)
}

/// `contextResult`: the token breakdown.
///
/// Raw numbers always; a percentage only when a real limit arrived. A window of
/// zero, or none at all, renders as absence rather than as a divide by zero.
fn context(theme: &Theme, width: u16, payload: &Value) -> Vec<Row> {
    let used = number_at(payload, &["tokenEstimate", "tokens", "used", "contextTokens"]);
    let limit = number_at(payload, &["contextWindow", "limit", "maxTokens"]).filter(|n| *n > 0);
    let mut rows = Vec::new();
    if let Some(used) = used {
        let mut spans = vec![
            Span::new(format!("{INDENT}context  "), theme.faint()),
            Span::new(thousands(used), theme.text()),
        ];
        if let Some(limit) = limit {
            let percent = (used as f64 / limit as f64 * 100.0).round();
            spans.push(Span::new(
                format!(" / {} · {percent:.0}%", thousands(limit)),
                theme.muted(),
            ));
        }
        rows.push(Row { spans });
    }

    let breakdown = ["breakdown", "sections", "parts", "components"]
        .iter()
        .find_map(|key| payload.get(*key));
    match breakdown {
        Some(Value::Array(items)) => {
            let entries: Vec<(String, i64)> = items
                .iter()
                .filter_map(|item| {
                    let object = item.as_object()?;
                    let label = ["label", "name", "kind"]
                        .iter()
                        .find_map(|key| object.get(*key).and_then(Value::as_str))?;
                    let tokens = number_at(item, &["tokens", "tokenEstimate", "count"])?;
                    Some((label.to_owned(), tokens))
                })
                .collect();
            rows.extend(breakdown_rows(theme, &entries));
        }
        Some(Value::Object(map)) => {
            let entries: Vec<(String, i64)> = map
                .iter()
                .filter_map(|(key, value)| Some((key.clone(), value.as_i64()?)))
                .collect();
            rows.extend(breakdown_rows(theme, &entries));
        }
        _ => {}
    }

    if rows.is_empty() {
        return tree(theme, width, payload, 1);
    }
    rows
}

fn breakdown_rows(theme: &Theme, entries: &[(String, i64)]) -> Vec<Row> {
    let label_width = entries
        .iter()
        .map(|(label, _)| UnicodeWidthStr::width(label.as_str()))
        .max()
        .unwrap_or(0);
    let count_width = entries
        .iter()
        .map(|(_, tokens)| thousands(*tokens).len())
        .max()
        .unwrap_or(0);
    entries
        .iter()
        .map(|(label, tokens)| {
            let pad = label_width - UnicodeWidthStr::width(label.as_str());
            let count = thousands(*tokens);
            Row {
                spans: vec![
                    Span::new(format!("{INDENT}  {label}{}  ", " ".repeat(pad)), theme.faint()),
                    Span::new(format!("{:>width$}", count, width = count_width), theme.muted()),
                ],
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The rewind surface
// ---------------------------------------------------------------------------

/// `checkpointsResult`: the recorded states of the working directory.
///
/// `available: false` is the load-bearing case. An empty list in a directory
/// that *cannot* host a checkpoint repository at all reads as "nothing has
/// happened yet", which is a different and wrong thing, so the reason is
/// rendered instead of the table.
fn checkpoints(theme: &Theme, width: u16, payload: &Value) -> Vec<Row> {
    if payload.get("available").and_then(Value::as_bool) == Some(false) {
        let reason = string_at(payload, "unavailable")
            .unwrap_or_else(|| "this directory cannot hold checkpoints".to_owned());
        return vec![Row::styled(
            clip(
                &format!("{INDENT}checkpoints unavailable · {reason}"),
                width as usize,
            ),
            theme.warning(),
        )];
    }
    table(
        theme,
        width,
        payload,
        &["checkpoints"],
        &["id", "kind", "label", "changedFiles", "createdAt", "entryId", "tool"],
    )
    .unwrap_or_else(|| open(theme, width, payload))
}

/// One changed path of a `/review`, as the transcript's collapsed tool row.
///
/// A review row **is** a tool row: `▸ modified src/auth.ts +12 −4` is DESIGN.md
/// §3's collapsed grammar exactly, and the patch under it is the same
/// [`crate::ui::diff`] render an `edit` result gets. Building a [`ToolView`] is
/// therefore not a trick — it is the one presentation model this TUI has for
/// "something happened to a file", and reusing it is what makes `Tab` expand a
/// review row the way it expands everything else.
#[must_use]
pub fn review_files(payload: &Value) -> Vec<ToolView> {
    let Some(files) = payload
        .get("diff")
        .and_then(|diff| diff.get("files"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    files
        .iter()
        .filter_map(|file| {
            let path = string_at(file, "path")?;
            let status = string_at(file, "status").unwrap_or_else(|| "changed".to_owned());
            // A binary file has no patch and no counts by contract; saying so
            // beats a row that claims a zero-line change.
            let binary = file.get("binary").and_then(Value::as_bool) == Some(true);
            let diff = file
                .get("patch")
                .and_then(Value::as_str)
                .filter(|patch| !patch.trim().is_empty())
                .map(|patch| FileDiff::from_unified(path.clone(), patch));
            let truncated = file.get("patchTruncated").and_then(Value::as_bool) == Some(true);
            let mut output = Vec::new();
            if let Some(old) = string_at(file, "oldPath") {
                output.push(format!("from {old}"));
            }
            if binary {
                output.push("binary".to_owned());
            }
            // The collapsed row's `+A −B` is derived from the patch it is about
            // to show, so it agrees with what is on screen. When there is no
            // patch — a binary file — or only a prefix of one, the daemon's own
            // measurement is the honest number and it is carried here instead of
            // being silently replaced by a count of the prefix.
            if diff.is_none() || truncated {
                let counts = ["additions", "deletions"]
                    .iter()
                    .zip(['+', '−'])
                    .filter_map(|(key, sign)| {
                        let count = file.get(*key)?.as_u64()?;
                        Some(format!("{sign}{count}"))
                    })
                    .collect::<Vec<_>>();
                if !counts.is_empty() {
                    output.push(counts.join(" "));
                }
            }
            if truncated {
                output.push("patch truncated".to_owned());
            }
            Some(ToolView {
                id: path.clone(),
                name: status.replace('_', " "),
                target: Some(path.clone()),
                // Nothing here failed: a review reports what a finished turn
                // did, so every row is a settled fact.
                status: ToolStatus::Succeeded,
                diff,
                output: (!output.is_empty()).then(|| output.join(" · ")),
                exit_code: None,
                files_modified: vec![path],
                interrupted: false,
            })
        })
        .collect()
}

/// The line above a `/review`'s file rows, and the one below it.
///
/// Composed here from the raw numbers rather than read off a prose field: the
/// daemon ships `files.len()`, `truncated` and the two endpoints, and DESIGN.md
/// §2 says the sentence is the client's to write.
#[must_use]
pub fn review_summary(theme: &Theme, width: u16, payload: &Value) -> Vec<Row> {
    let diff = payload.get("diff");
    let available = diff
        .and_then(|diff| diff.get("available"))
        .and_then(Value::as_bool)
        != Some(false);
    if !available {
        let reason = diff
            .and_then(|diff| string_at(diff, "unavailable"))
            .unwrap_or_else(|| "this directory cannot hold checkpoints".to_owned());
        return vec![Row::styled(
            clip(&format!("{INDENT}review unavailable · {reason}"), width as usize),
            theme.warning(),
        )];
    }
    let files = diff
        .and_then(|diff| diff.get("files"))
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let since = diff
        .and_then(|diff| diff.get("from"))
        .map_or_else(|| "the last checkpoint".to_owned(), endpoint_label);
    let mut text = if files == 0 {
        format!("review · nothing has changed since {since}")
    } else {
        format!(
            "review · {files} {} changed since {since}",
            if files == 1 { "file" } else { "files" }
        )
    };
    if diff
        .and_then(|diff| diff.get("truncated"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        text.push_str(" · more files changed than this listing carries");
    }
    vec![Row::styled(
        clip(&format!("{INDENT}{text}"), width as usize),
        theme.faint(),
    )]
}

/// The agent workspaces a `/review` found still holding work.
///
/// Their integration hints come from the git pipeline and are carried verbatim:
/// they are commands the user can run, and a client that paraphrased a command
/// would be inventing one.
#[must_use]
pub fn review_agents(theme: &Theme, width: u16, payload: &Value) -> Vec<Row> {
    let Some(agents) = payload.get("agents").and_then(Value::as_array) else {
        return Vec::new();
    };
    if agents.is_empty() {
        return Vec::new();
    }
    let mut rows = vec![Row::styled(
        format!(
            "{INDENT}{} agent {} holding work",
            agents.len(),
            if agents.len() == 1 {
                "workspace"
            } else {
                "workspaces"
            }
        ),
        theme.faint(),
    )];
    for agent in agents {
        let name = string_at(agent, "name").unwrap_or_default();
        let state = string_at(agent, "state").unwrap_or_default();
        rows.push(Row {
            spans: vec![
                Span::new(format!("{INDENT}  ◆ "), theme.agent()),
                Span::new(
                    clip(
                        format!("{name} · {state}").trim_end_matches(" · "),
                        (width as usize).saturating_sub(INDENT.len() + 4),
                    ),
                    theme.muted(),
                ),
            ],
        });
        let hints = agent
            .get("integration")
            .and_then(|integration| integration.get("hint"))
            .and_then(Value::as_array);
        for hint in hints.into_iter().flatten().filter_map(Value::as_str) {
            rows.push(Row::styled(
                clip(&format!("{INDENT}    {hint}"), width as usize),
                theme.faint(),
            ));
        }
    }
    rows
}

/// `reviewResult`, whole, for a caller with nowhere to put an expandable row.
///
/// [`crate::app::App`] takes the other path — it commits the file rows as
/// transcript entries so `Tab` expands the last one — and both paths draw the
/// same row through [`tool_row::collapsed`], so there is one grammar and not
/// two.
fn review(theme: &Theme, width: u16, payload: &Value) -> Vec<Row> {
    let mut rows = review_summary(theme, width, payload);
    for view in review_files(payload) {
        rows.push(tool_row::collapsed(&view, theme, width));
        rows.extend(tool_row::children(&view, theme, width));
    }
    rows.extend(review_agents(theme, width, payload));
    rows
}

/// How a diff endpoint reads in the summary line.
fn endpoint_label(endpoint: &Value) -> String {
    match endpoint.get("kind").and_then(Value::as_str) {
        Some("worktree") => "the working tree".to_owned(),
        Some("empty") => "the start of this session".to_owned(),
        _ => string_at(endpoint, "label")
            .or_else(|| string_at(endpoint, "id"))
            .unwrap_or_else(|| "the last checkpoint".to_owned()),
    }
}

// ---------------------------------------------------------------------------
// The fallback
// ---------------------------------------------------------------------------

/// A structured key/value tree. The fallback for every shape above, and the
/// reason no payload can reach the terminal as JSON text.
fn tree(theme: &Theme, width: u16, value: &Value, depth: usize) -> Vec<Row> {
    let pad = INDENT.repeat(depth);
    let mut rows = Vec::new();
    match value {
        Value::Object(map) => {
            let label_width = map
                .iter()
                .filter(|(_, value)| is_scalar(value))
                .map(|(key, _)| UnicodeWidthStr::width(header(key).as_str()))
                .max()
                .unwrap_or(0);
            for (key, child) in map {
                if is_scalar(child) {
                    let label = header(key);
                    let gap = label_width - UnicodeWidthStr::width(label.as_str());
                    let used = UnicodeWidthStr::width(pad.as_str()) + label_width + 2;
                    rows.push(Row {
                        spans: vec![
                            Span::new(format!("{pad}{label}{}  ", " ".repeat(gap)), theme.faint()),
                            Span::new(
                                clip(&scalar(Some(child)), (width as usize).saturating_sub(used)),
                                theme.muted(),
                            ),
                        ],
                    });
                } else if let Some(items) = child.as_array()
                    && items.iter().all(is_scalar)
                {
                    let joined: Vec<String> = items.iter().map(|item| scalar(Some(item))).collect();
                    let label = header(key);
                    let used = UnicodeWidthStr::width(pad.as_str())
                        + UnicodeWidthStr::width(label.as_str())
                        + 2;
                    rows.push(Row {
                        spans: vec![
                            Span::new(format!("{pad}{label}  "), theme.faint()),
                            Span::new(
                                clip(&joined.join(", "), (width as usize).saturating_sub(used)),
                                theme.muted(),
                            ),
                        ],
                    });
                } else {
                    rows.push(Row::styled(format!("{pad}{}", header(key)), theme.agent()));
                    rows.extend(tree(theme, width, child, depth + 1));
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                if is_scalar(item) {
                    let used = UnicodeWidthStr::width(pad.as_str()) + 2;
                    rows.push(Row {
                        spans: vec![
                            Span::new(format!("{pad}· "), theme.faint()),
                            Span::new(
                                clip(&scalar(Some(item)), (width as usize).saturating_sub(used)),
                                theme.muted(),
                            ),
                        ],
                    });
                } else {
                    rows.extend(tree(theme, width, item, depth));
                    rows.push(Row::blank());
                }
            }
            if rows.last() == Some(&Row::blank()) {
                rows.pop();
            }
        }
        other => rows.push(Row::styled(
            format!(
                "{pad}{}",
                clip(
                    &scalar(Some(other)),
                    (width as usize).saturating_sub(UnicodeWidthStr::width(pad.as_str()))
                )
            ),
            theme.muted(),
        )),
    }
    rows
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

fn is_scalar(value: &Value) -> bool {
    matches!(
        value,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}

/// One cell. Never a brace: a non-scalar is summarised by its size.
fn scalar(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::Bool(flag)) => (if *flag { "yes" } else { "no" }).to_owned(),
        Some(Value::Number(number)) => number
            .as_i64()
            .map_or_else(|| number.to_string(), thousands),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => format!("{} items", items.len()),
        Some(Value::Object(map)) => format!("{} fields", map.len()),
    }
}

/// `contextWindow` → `context window`. Column headings read as prose.
fn header(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for (index, character) in key.chars().enumerate() {
        if character.is_uppercase() && index > 0 {
            out.push(' ');
            out.extend(character.to_lowercase());
        } else if character == '_' {
            out.push(' ');
        } else {
            out.push(character);
        }
    }
    out
}

/// Group digits so a token count reads at a glance.
fn thousands(value: i64) -> String {
    let negative = value < 0;
    let digits = value.unsigned_abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    if negative {
        format!("-{out}")
    } else {
        out
    }
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn number_at(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| value.get(*key)?.as_i64())
}

/// The first array of objects anywhere in the payload, breadth first.
fn first_object_array(value: &Value) -> Option<&Vec<Value>> {
    let map = value.as_object()?;
    map.values()
        .filter_map(Value::as_array)
        .find(|items| items.iter().any(Value::is_object))
}

fn clip(text: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    for grapheme in unicode_segmentation::UnicodeSegmentation::graphemes(text, true) {
        let advance = UnicodeWidthStr::width(grapheme).max(1);
        if used + advance > limit {
            break;
        }
        out.push_str(grapheme);
        used += advance;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn drawn(value: &Value, kind: Option<&str>) -> String {
        render(&Theme::lyra(), 100, "/x", kind, value)
            .iter()
            .map(Row::plain_text)
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The one assertion every renderer shares: no JSON reaches the terminal.
    fn assert_no_json(text: &str) {
        for brace in ['{', '}', '[', ']'] {
            assert!(
                !text.contains(brace),
                "a raw JSON {brace} reached the terminal:\n{text}"
            );
        }
        assert!(!text.contains("\":"), "a JSON key reached the terminal:\n{text}");
    }

    #[test]
    fn a_models_result_is_a_table_with_the_current_row_marked() {
        let text = drawn(
            &json!({
                "command": "model",
                "resultKind": "modelsResult",
                "output": {
                    "provider": "anthropic",
                    "current": "opus-5",
                    "models": [
                        { "id": "opus-5", "ownedBy": "anthropic", "contextWindow": 200000 },
                        { "id": "sonnet-4", "ownedBy": "anthropic", "contextWindow": 200000 }
                    ]
                }
            }),
            None,
        );
        assert_no_json(&text);
        assert!(text.contains("opus-5"), "{text}");
        assert!(text.contains("sonnet-4"), "{text}");
        assert!(text.contains("context window"), "a dim header row: {text}");
        assert!(text.contains("200,000"), "{text}");
        let current = text
            .lines()
            .find(|line| line.contains("opus-5"))
            .expect("a row for the current model");
        assert!(current.trim_start().starts_with('▸'), "{current:?}");
    }

    #[test]
    fn table_columns_line_up() {
        let text = drawn(
            &json!({ "resultKind": "agents", "output": { "agents": [
                { "id": "a", "status": "running" },
                { "id": "a-much-longer-name", "status": "idle" }
            ]}}),
            None,
        );
        let columns: Vec<usize> = text
            .lines()
            .filter(|line| line.contains("running") || line.contains("idle"))
            .map(|line| line.find("running").or_else(|| line.find("idle")).unwrap())
            .collect();
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0], columns[1], "the status column is aligned:\n{text}");
    }

    #[test]
    fn every_declared_result_kind_has_a_renderer_that_is_not_a_dump() {
        // The payloads are the schema's own shapes, field for field.
        let payloads = [
            (
                "models",
                json!({ "provider": "p", "current": "m", "refreshed": false,
                        "models": [{ "id": "m", "ownedBy": "p" }] }),
            ),
            (
                "sessions",
                json!({ "sessions": [
                    { "sessionId": "s-1", "name": "s", "path": "/t/s", "active": true }
                ]}),
            ),
            (
                "workspaces",
                json!({ "workspaces": [{ "name": "w", "path": "/t/w", "origin": "/r",
                                         "state": "active", "mode": "worktree",
                                         "createdAt": "t", "updatedAt": "t" }]}),
            ),
            (
                "agents",
                json!({ "agents": [{ "id": "a-1", "workspace": "w", "status": "running",
                                     "startedAt": 0 }]}),
            ),
            (
                "skills",
                json!({ "skills": [{ "name": "k", "description": "d", "origin": "user",
                                     "path": "/t/k" }]}),
            ),
            (
                "mcp",
                json!({ "tools": [{ "server": "fs", "name": "read", "description": "d" }]}),
            ),
            (
                "health",
                json!({ "turns": 12, "successfulTurns": 11, "compactions": 1,
                        "contextRepairs": 0, "malformedMetrics": 0,
                        "turnLatencyMs": { "p50": 100, "p95": 900, "p99": 1500 },
                        "retries": { "rate_limit": 2 },
                        "tools": { "read": { "calls": 8, "successes": 8,
                                             "firstCallSuccessRate": 1.0,
                                             "latencyP95Ms": 12 } } }),
            ),
            (
                "context",
                json!({ "tokenEstimate": 24137, "contextWindow": 200000,
                        "sections": [{ "name": "system", "tokens": 1200 }],
                        "repairs": [], "lossMarkers": [], "cacheBreakpoints": [],
                        "sourceEntryIds": [] }),
            ),
            ("report", json!({ "report": "all green" })),
        ];
        for (kind, output) in payloads {
            let text = drawn(
                &json!({ "command": "x", "resultKind": kind, "output": output }),
                None,
            );
            assert_no_json(&text);
            assert!(!text.trim().is_empty(), "{kind} rendered nothing");
            // …and the `$def` spelling reaches the same renderer.
            let aliased = drawn(
                &json!({ "command": "x", "resultKind": format!("{kind}Result"),
                         "output": output }),
                None,
            );
            assert_eq!(aliased, text, "{kind}Result must not be a different renderer");
        }
    }

    /// `/agents` was reshaped in wave 2: the columns are the `agentHandle`
    /// vocabulary now, and the state words are the ones that tell a child three
    /// tool calls in from one whose provider never answered.
    #[test]
    fn agents_renders_the_reshaped_vocabulary_and_never_a_wall_of_prose() {
        let text = drawn(
            &json!({ "resultKind": "agents", "output": { "agents": [
                { "id": "spawn-1", "peer": "activity-module", "label": "activity",
                  "workspace": "/tmp/w", "status": "awaiting_tool", "startedAt": 0,
                  "model": "gpt-5.6-terra", "toolCalls": 7, "currentTool": "edit",
                  "filesModified": ["src/a.ts", "src/b.ts"],
                  "writeScope": ["src/**"],
                  "partialOutput": "I have read the file and\nam about to change it",
                  "isolated": false, "depth": 0, "resultAvailable": false },
                { "id": "spawn-2", "peer": "qa-checker", "workspace": "/tmp/w",
                  "status": "timed_out", "startedAt": 0, "error": "deadline expired" }
            ]}}),
            None,
        );
        assert_no_json(&text);
        assert!(text.contains("peer"), "{text}");
        assert!(text.contains("activity-module"), "{text}");
        // The state words are the protocol's own, verbatim: they are what the
        // docs say and what a reader will search for, and a cell is data rather
        // than prose (only the header row is re-worded).
        assert!(text.contains("awaiting_tool"), "the state vocabulary: {text}");
        assert!(text.contains("timed_out"), "a deadline, not a decision: {text}");
        assert!(text.contains("tool calls"), "{text}");
        // The failure reason is a column, not something the reader has to go
        // looking for — at a width that has room for it.
        let wide = render(&Theme::lyra(), 180, "/agents", Some("agents"), &json!({
            "resultKind": "agents", "output": { "agents": [
                { "id": "spawn-2", "peer": "qa-checker", "workspace": "/tmp/w",
                  "status": "timed_out", "startedAt": 0, "error": "deadline expired" }
            ]}}))
            .iter()
            .map(Row::plain_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(wide.contains("deadline expired"), "{wide}");
        // The paths belong to the child's result, and a cell is a scalar.
        assert!(!text.contains("src/a.ts"), "{text}");
        // And the tail of what a child has *said* is prose, not a column.
        assert!(!text.contains("am about to change it"), "{text}");
    }

    #[test]
    fn checkpoints_renders_as_a_table_and_says_when_there_can_be_none() {
        let text = drawn(
            &json!({ "resultKind": "checkpoints", "output": { "available": true,
                "checkpoints": [
                    { "id": "c-1", "kind": "pre_tool", "label": "before edit src/auth.ts",
                      "createdAt": "2026-08-10T09:00:00.000Z", "changedFiles": 3,
                      "entryId": "e-42", "tool": "edit", "excluded": [".lyra"] }
                ]}}),
            None,
        );
        assert_no_json(&text);
        assert!(text.contains("before edit src/auth.ts"), "{text}");
        assert!(text.contains("pre_tool"), "{text}");
        assert!(text.contains("e-42"), "the transcript anchor: {text}");

        // Unavailable is a different answer from empty, and the reason is what
        // stops an empty list from reading as "nothing has happened yet".
        let nowhere = drawn(
            &json!({ "resultKind": "checkpoints",
                     "output": { "checkpoints": [], "available": false,
                                 "unavailable": "no git in PATH" } }),
            None,
        );
        assert!(nowhere.contains("checkpoints unavailable · no git in PATH"), "{nowhere}");
    }

    #[test]
    fn review_is_a_summary_line_a_row_per_file_and_the_workspaces_still_holding_work() {
        let value = json!({ "resultKind": "review", "output": {
            "diff": {
                "from": { "kind": "checkpoint", "id": "c-0", "label": "turn start" },
                "to": { "kind": "worktree" },
                "files": [
                    { "path": "src/auth.ts", "status": "modified", "additions": 12,
                      "deletions": 4, "binary": false,
                      "patch": "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\n" },
                    { "path": "logo.png", "status": "added", "binary": true },
                    { "path": "src/new.ts", "status": "renamed", "oldPath": "src/old.ts" }
                ],
                "truncated": true, "available": true },
            "agents": [ { "name": "activity-module", "path": "/tmp/w", "state": "active",
                          "integration": { "hint": ["git fetch /tmp/w activity-module"] } } ]
        }});
        let text = drawn(&value, None);
        assert_no_json(&text);
        assert!(text.contains("review · 3 files changed since turn start"), "{text}");
        assert!(text.contains("more files changed than this listing carries"), "{text}");
        assert!(text.contains("▸ modified src/auth.ts"), "{text}");
        assert!(text.contains("▸ added logo.png"), "{text}");
        assert!(text.contains("binary"), "a binary file says so: {text}");
        assert!(text.contains("from src/old.ts"), "a rename names where it came from: {text}");
        assert!(text.contains("git fetch /tmp/w activity-module"), "{text}");

        // The file views are the transcript's collapsed grammar, and none of
        // them is a survey call — a review's rows must not be held back waiting
        // for a run that will never form.
        let views = review_files(&value["output"]);
        assert_eq!(views.len(), 3);
        assert!(views.iter().all(|view| !view.is_survey()), "held back forever");
        assert!(views[0].diff.is_some(), "the patch is parsed, not printed");
        assert!(views[1].diff.is_none(), "a binary file carries none");
    }

    #[test]
    fn a_review_with_nothing_in_it_says_so_rather_than_rendering_nothing() {
        let text = drawn(
            &json!({ "resultKind": "review", "output": {
                "diff": { "from": { "kind": "checkpoint", "label": "turn start" },
                          "to": { "kind": "worktree" }, "files": [],
                          "truncated": false, "available": true },
                "agents": [] }}),
            None,
        );
        assert!(text.contains("nothing has changed since turn start"), "{text}");
    }

    #[test]
    fn health_renders_as_label_value_rows() {
        let text = drawn(
            &json!({ "resultKind": "health",
                     "output": { "provider": "reachable", "latencyMs": 12 } }),
            None,
        );
        assert_no_json(&text);
        assert!(text.contains("provider"), "{text}");
        assert!(text.contains("reachable"), "{text}");
        assert!(text.contains("latency ms"), "camelCase reads as prose: {text}");
    }

    #[test]
    fn context_shows_a_percentage_only_when_a_real_limit_arrived() {
        let with_limit = drawn(
            &json!({ "resultKind": "context",
                     "output": { "tokenEstimate": 50000, "contextWindow": 200000 } }),
            None,
        );
        assert!(with_limit.contains("50,000"), "{with_limit}");
        assert!(with_limit.contains("25%"), "{with_limit}");

        let without = drawn(
            &json!({ "resultKind": "context", "output": { "tokenEstimate": 50000 } }),
            None,
        );
        assert!(without.contains("50,000"), "{without}");
        assert!(!without.contains('%'), "no limit, no percentage: {without}");
    }

    #[test]
    fn a_report_goes_through_markdown() {
        let text = drawn(
            &json!({ "output": { "report": "# Heading\n\nsome **prose**\n" } }),
            None,
        );
        assert!(text.contains("Heading"), "{text}");
        assert!(!text.contains("**"), "markdown was rendered, not printed: {text}");
    }

    #[test]
    fn an_unknown_shape_becomes_a_tree_and_never_json() {
        let text = drawn(
            &json!({ "output": {
                "somethingNew": { "nested": true, "count": 3 },
                "list": ["a", "b"]
            }}),
            None,
        );
        assert_no_json(&text);
        assert!(text.contains("something new"), "{text}");
        assert!(text.contains("nested"), "{text}");
        assert!(text.contains("yes"), "booleans read as words: {text}");
        assert!(text.contains("a, b"), "{text}");
    }

    #[test]
    fn the_declared_kind_is_used_when_the_payload_does_not_carry_one() {
        let text = drawn(
            &json!({ "command": "model", "output": { "models": [{ "id": "opus-5" }] } }),
            Some("models"),
        );
        assert!(text.contains("opus-5"), "{text}");
        assert_no_json(&text);
    }

    #[test]
    fn an_error_is_an_error_row_and_nothing_else() {
        let text = drawn(&json!({ "command": "nope", "error": "Unknown command" }), None);
        assert!(text.contains("/x: Unknown command"), "{text}");
    }

    #[test]
    fn an_empty_list_says_none_rather_than_rendering_nothing() {
        let text = drawn(
            &json!({ "resultKind": "agents", "output": { "agents": [] } }),
            None,
        );
        assert!(text.contains("none"), "{text}");
    }

    #[test]
    fn a_result_with_no_output_still_leaves_a_row() {
        let text = drawn(&json!({ "command": "compact" }), None);
        assert!(text.contains("/x · ok"), "{text}");
    }

    #[test]
    fn a_wide_table_truncates_instead_of_wrapping() {
        let value = json!({ "resultKind": "skills", "output": { "skills": [
            { "name": "a-skill", "origin": "user",
              "description": "a description that is far longer than any narrow terminal could hold" }
        ]}});
        for width in [30u16, 50, 80] {
            for row in render(&Theme::lyra(), width, "/skills", None, &value) {
                assert!(
                    row.width() <= width as usize,
                    "width {width}: {:?}",
                    row.plain_text()
                );
            }
        }
    }
}
