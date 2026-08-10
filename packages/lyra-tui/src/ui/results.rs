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
use crate::ui::{markdown, Row, Span};

/// Left margin every result row shares with the transcript grammar.
const INDENT: &str = "  ";

/// Every `resultKind` this module dispatches on, in the schema's spelling.
///
/// Kept in step with `#/$defs/commandResultKind` by a conformance test: a kind
/// the daemon can send and this list does not name would render as a key/value
/// tree, which is legible but is not the table it deserves.
pub const KINDS: [&str; 9] = [
    "models",
    "sessions",
    "workspaces",
    "agents",
    "health",
    "context",
    "skills",
    "mcp",
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
        Some("agents") => table(
            theme,
            width,
            payload,
            &["agents"],
            &["id", "label", "status", "workspace"],
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
            if key != "resultKind" && usable(key) && !columns.contains(key) {
                columns.push(key.clone());
            }
        }
    }
    columns
}

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
