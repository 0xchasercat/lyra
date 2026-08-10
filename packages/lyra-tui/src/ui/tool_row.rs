//! Tool rows — the transcript grammar of DESIGN.md §3.
//!
//! > "`▸ edit src/auth.ts +12 −4` collapsed tool rows (dim while pending,
//! > accent on run, plain on success, error on failure); `└─` tree children for
//! > results/detail (`Tab` expands the *last* tool call, never mouse-only)."
//!
//! # The presentation model is not the state model
//!
//! [`ToolView`] exists so this module does not reach into
//! [`crate::state::ToolCall`]'s field layout from six places. It is built once,
//! at the boundary, by [`ToolView::from_call`]; everything below it renders a
//! `ToolView` and nothing else. When the session store grows a field — a
//! `Denied` lifecycle state, structured edit payloads — exactly one function
//! changes.
//!
//! # Truncation happens before wrapping, not after
//!
//! A `bash` call can return fifty megabytes. Wrapping that to the terminal
//! width and *then* keeping the first ten rows costs the whole fifty megabytes
//! in allocations for ten rows of output. [`truncate_output`] cuts the raw
//! string at a line count and a byte budget first, so the renderer never sees
//! more than a few kilobytes.

use crate::state::{ToolCall, ToolState};
use crate::theme::Theme;
use crate::ui::diff::{self, DiffOptions, FileDiff};
use crate::ui::{Row, Span};
use crate::vendor::flywheel::Modifiers;

/// The collapsed-row glyph.
pub const TOOL_GLYPH: &str = "▸";
/// The tree-child prefix.
pub const CHILD_PREFIX: &str = "└─ ";
/// Default output lines shown collapsed.
pub const DEFAULT_OUTPUT_LINES: usize = 3;
/// Output lines shown for a command tool, whose output is the point.
pub const COMMAND_OUTPUT_LINES: usize = 10;
/// Byte budget scanned when truncating. Beyond it the line count is reported as
/// a lower bound rather than scanned for.
pub const TRUNCATE_SCAN_BUDGET: usize = 1 << 20;

/// How a tool row is coloured.
///
/// A one-to-one mirror of [`ToolState`] rather than a re-use of it, so this
/// module renders a presentation type and the session store stays free to
/// evolve its own. [`ToolStatus::of`] is the single translation point.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ToolStatus {
    /// Arguments still streaming.
    #[default]
    Pending,
    /// Executing.
    Running,
    /// Finished cleanly.
    Succeeded,
    /// Finished with an error.
    Failed,
    /// The user refused permission. Struck through, not red: nothing went
    /// wrong, the model was told no.
    Denied,
}

impl ToolStatus {
    /// Classify a call.
    #[must_use]
    pub const fn of(call: &ToolCall) -> Self {
        match call.state {
            ToolState::Pending => Self::Pending,
            ToolState::Running => Self::Running,
            ToolState::Succeeded => Self::Succeeded,
            ToolState::Failed => Self::Failed,
            ToolState::Denied => Self::Denied,
        }
    }

    /// The row style for this status.
    #[must_use]
    pub fn style(self, theme: &Theme) -> crate::ui::Style {
        match self {
            Self::Pending => theme.muted(),
            Self::Running => theme.accent(),
            Self::Succeeded => theme.text(),
            Self::Failed => theme.error(),
            Self::Denied => theme.muted().with(Modifiers::STRIKETHROUGH),
        }
    }
}

/// Everything a tool row needs, and nothing about how it is stored.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolView {
    /// Call id.
    pub id: String,
    /// Tool name as shown.
    pub name: String,
    /// The one argument worth showing beside the name: a path, a pattern, a
    /// command. `None` when the tool has no obvious subject.
    pub target: Option<String>,
    /// Colour state.
    pub status: ToolStatus,
    /// Structured edit, when the call carried before/after content or a patch.
    pub diff: Option<FileDiff>,
    /// Result text.
    pub output: Option<String>,
    /// Exit code for command tools.
    pub exit_code: Option<i64>,
    /// Paths the tool reported changing.
    pub files_modified: Vec<String>,
    /// A wait-class tool cut short by steering (DESIGN.md §0.2).
    pub interrupted: bool,
}

impl ToolView {
    /// Build the presentation model from a session-store call.
    #[must_use]
    pub fn from_call(call: &ToolCall) -> Self {
        let args = Arguments::of(call);
        let path = args
            .string("path")
            .or_else(|| args.string("file_path"))
            .or_else(|| args.string("filePath"))
            .or_else(|| args.string("filename"));
        let target = path
            .clone()
            .or_else(|| args.string("pattern"))
            .or_else(|| args.string("query"))
            .or_else(|| args.string("command"))
            .or_else(|| args.string("cmd"))
            .or_else(|| call.args_summary.clone())
            .or_else(|| call.files_modified.first().cloned())
            .or_else(|| call.files_read.first().cloned());

        let diff = build_diff(&args, path.as_deref(), call);

        Self {
            id: call.id.clone(),
            name: call.name.clone(),
            target,
            status: ToolStatus::of(call),
            diff,
            output: call.result_summary.clone(),
            exit_code: call.exit_code,
            files_modified: call.files_modified.clone(),
            interrupted: call.interrupted,
        }
    }

    /// Attach the full result text.
    ///
    /// BOUNDARY: the session store keeps only a one-line `result_summary`,
    /// which is the right thing for a transcript that must stay bounded over a
    /// long session. A caller that has the full text — the ACP layer, holding
    /// the frame it just decoded — hands it over here, and the expanded view
    /// shows it. Without it the expanded view shows the summary, which is
    /// degraded but never empty.
    #[must_use]
    pub fn with_output(mut self, output: impl Into<String>) -> Self {
        self.output = Some(output.into());
        self
    }

    /// Whether this call is a read or a search, and so eligible for run
    /// collapsing.
    #[must_use]
    pub fn is_survey(&self) -> bool {
        self.kind() != SurveyKind::Other
    }

    fn kind(&self) -> SurveyKind {
        let name = self.name.to_ascii_lowercase();
        const READS: [&str; 7] = ["read", "cat", "view", "open", "ls", "list", "glob"];
        const SEARCHES: [&str; 5] = ["grep", "search", "ripgrep", "rg", "find"];
        if READS.iter().any(|needle| name.contains(needle)) {
            SurveyKind::Read
        } else if SEARCHES.iter().any(|needle| name.contains(needle)) {
            SurveyKind::Search
        } else {
            SurveyKind::Other
        }
    }

    fn is_command(&self) -> bool {
        let name = self.name.to_ascii_lowercase();
        ["bash", "shell", "sh", "run", "exec", "command", "terminal"]
            .iter()
            .any(|needle| name.contains(needle))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SurveyKind {
    Read,
    Search,
    Other,
}

fn build_diff(args: &Arguments, path: Option<&str>, call: &ToolCall) -> Option<FileDiff> {
    let label = path
        .map(str::to_owned)
        .or_else(|| call.files_modified.first().cloned())
        .unwrap_or_else(|| call.name.clone());
    if let Some(patch) = args.string("patch").or_else(|| args.string("diff")) {
        let diff = FileDiff::from_unified(label.clone(), &patch);
        if !diff.is_empty() {
            return Some(diff);
        }
    }
    let old = args
        .string("old_string")
        .or_else(|| args.string("oldText"))
        .or_else(|| args.string("old"))?;
    let new = args
        .string("new_string")
        .or_else(|| args.string("newText"))
        .or_else(|| args.string("new"))
        .unwrap_or_default();
    let diff = FileDiff::between(label, &old, &new, 1);
    (!diff.is_empty()).then_some(diff)
}

/// A tool's arguments.
///
/// The store parses them once the model finishes streaming; until then they are
/// a JSON *fragment* and there is nothing to read. A row with no subject is
/// still a row with a tool name, which is what "never render nothing" asks for.
struct Arguments(Option<serde_json::Value>);

impl Arguments {
    fn of(call: &ToolCall) -> Self {
        Self(
            call.args
                .clone()
                .or_else(|| serde_json::from_str(&call.arguments).ok()),
        )
    }

    fn string(&self, key: &str) -> Option<String> {
        self.0
            .as_ref()?
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// The collapsed one-liner: `▸ edit src/auth.ts +12 −4`.
#[must_use]
pub fn collapsed(view: &ToolView, theme: &Theme, width: u16) -> Row {
    let style = view.status.style(theme);
    let mut spans = vec![
        Span::new(format!("{TOOL_GLYPH} "), style),
        Span::new(view.name.clone(), style),
    ];
    if let Some(target) = &view.target {
        spans.push(Span::new(format!(" {}", one_line(target)), theme.muted()));
    }
    if let Some(diff) = &view.diff {
        let (added, removed) = (diff.added(), diff.removed());
        if added > 0 {
            spans.push(Span::new(
                format!(" +{added}"),
                theme.tokens.diff_add.style(),
            ));
        }
        if removed > 0 {
            spans.push(Span::new(
                format!(" −{removed}"),
                theme.tokens.diff_del.style(),
            ));
        }
    }
    if let Some(code) = view.exit_code.filter(|code| *code != 0) {
        spans.push(Span::new(format!(" exit {code}"), theme.error()));
    }
    let mut row = Row { spans };
    fit(&mut row, width);
    row
}

/// The `└─` children: the result summary a collapsed row is allowed to show.
///
/// One row of detail at most, plus truncated output. Anything more belongs
/// behind [`expanded`].
#[must_use]
pub fn children(view: &ToolView, theme: &Theme, width: u16) -> Vec<Row> {
    let mut rows = Vec::new();
    if view.status == ToolStatus::Denied {
        rows.push(child_row("denied", theme.muted(), theme, width));
        return rows;
    }
    if view.interrupted {
        rows.push(child_row(
            "interrupted by steering",
            theme.warning(),
            theme,
            width,
        ));
    }
    let limit = if view.is_command() {
        COMMAND_OUTPUT_LINES
    } else {
        DEFAULT_OUTPUT_LINES
    };
    let Some(output) = &view.output else {
        return rows;
    };
    let (lines, hidden) = truncate_output(output, limit);
    if lines.is_empty() {
        return rows;
    }
    let style = if view.status == ToolStatus::Failed {
        theme.error()
    } else {
        theme.muted()
    };
    for (index, line) in lines.iter().enumerate() {
        let prefix = if index == 0 { CHILD_PREFIX } else { "   " };
        let mut row = Row {
            spans: vec![
                Span::new(prefix, theme.faint()),
                Span::new(line.clone(), style),
            ],
        };
        fit(&mut row, width);
        rows.push(row);
    }
    if let Some(hidden) = hidden {
        rows.push(Row {
            spans: vec![
                Span::new("   ", theme.faint()),
                Span::new(hidden, theme.faint()),
            ],
        });
    }
    rows
}

fn child_row(text: &str, style: crate::ui::Style, theme: &Theme, width: u16) -> Row {
    let mut row = Row {
        spans: vec![
            Span::new(CHILD_PREFIX, theme.faint()),
            Span::new(text.to_owned(), style),
        ],
    };
    fit(&mut row, width);
    row
}

/// The `Tab`-expanded form: the whole diff through the one diff renderer, and
/// the untruncated output.
///
/// The keybinding that reaches this lives with the input layer; the transcript
/// exposes the operation ([`super::transcript::Transcript::expand_last_tool`])
/// and this is what it renders.
#[must_use]
pub fn expanded(view: &ToolView, theme: &Theme, width: u16) -> Vec<Row> {
    let mut rows = vec![collapsed(view, theme, width)];
    if let Some(file_diff) = &view.diff {
        rows.extend(diff::render(
            file_diff,
            theme,
            &DiffOptions::expanded(width),
        ));
    }
    if let Some(output) = &view.output {
        // Expanded still bounds itself: "everything" for a fifty-megabyte dump
        // is not a design goal, it is a hang.
        let (lines, hidden) = truncate_output(output, 200);
        for line in lines {
            let mut row = Row {
                spans: vec![
                    Span::new("   ", theme.faint()),
                    Span::new(line, theme.muted()),
                ],
            };
            fit(&mut row, width);
            rows.push(row);
        }
        if let Some(hidden) = hidden {
            rows.push(Row {
                spans: vec![
                    Span::new("   ", theme.faint()),
                    Span::new(hidden, theme.faint()),
                ],
            });
        }
    }
    rows
}

/// Collapse a run of reads and searches into one prose line with counts.
///
/// `None` when the run is not worth collapsing (fewer than two calls), so the
/// caller renders them individually.
#[must_use]
pub fn collapse_run(views: &[&ToolView], theme: &Theme, width: u16) -> Option<Row> {
    if views.len() < 2 || !views.iter().all(|view| view.is_survey()) {
        return None;
    }
    let reads = views
        .iter()
        .filter(|view| view.kind() == SurveyKind::Read)
        .count();
    let searches = views.len() - reads;
    let mut parts: Vec<String> = Vec::new();
    if reads > 0 {
        parts.push(format!("read {reads} {}", plural(reads, "file", "files")));
    }
    if searches > 0 {
        parts.push(format!(
            "searched {searches} {}",
            plural(searches, "pattern", "patterns")
        ));
    }
    let failed = views
        .iter()
        .filter(|view| view.status == ToolStatus::Failed)
        .count();
    if failed > 0 {
        parts.push(format!("{failed} failed"));
    }
    let running = views
        .iter()
        .any(|view| matches!(view.status, ToolStatus::Running | ToolStatus::Pending));
    let style = if running {
        theme.accent()
    } else {
        theme.muted()
    };
    let mut row = Row {
        spans: vec![
            Span::new(format!("{TOOL_GLYPH} "), style),
            Span::new(parts.join(" · "), style),
        ],
    };
    fit(&mut row, width);
    Some(row)
}

fn plural(count: usize, one: &str, many: &str) -> String {
    if count == 1 { one } else { many }.to_owned()
}

/// Cut raw output to `limit` lines, returning the lines and a counted marker.
///
/// Scans at most [`TRUNCATE_SCAN_BUDGET`] bytes past the cut. Beyond that the
/// marker says `+N+ lines` rather than pretending to an exact count nobody
/// asked for and the terminal would not show.
#[must_use]
pub fn truncate_output(output: &str, limit: usize) -> (Vec<String>, Option<String>) {
    let mut lines: Vec<String> = Vec::with_capacity(limit);
    let mut consumed = 0usize;
    for line in output.lines() {
        if lines.len() == limit {
            break;
        }
        consumed += line.len() + 1;
        lines.push(one_line(line));
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    let rest = output.get(consumed.min(output.len())..).unwrap_or("");
    if rest.trim().is_empty() {
        return (lines, None);
    }
    let scanned = &rest[..rest.len().min(TRUNCATE_SCAN_BUDGET)];
    let hidden = scanned.bytes().filter(|byte| *byte == b'\n').count()
        + usize::from(!scanned.ends_with('\n'));
    let marker = if rest.len() > TRUNCATE_SCAN_BUDGET {
        format!("… +{hidden}+ lines")
    } else {
        format!("… +{hidden} lines")
    };
    (lines, Some(marker))
}

/// Flatten a value onto one row: tabs and newlines would desynchronise the
/// compositor's row accounting, and a control character would move the cursor.
fn one_line(text: &str) -> String {
    text.chars()
        .map(|ch| {
            if ch == '\t' {
                ' '
            } else if ch.is_control() {
                '·'
            } else {
                ch
            }
        })
        .collect()
}

/// Truncate a row to the terminal width, leaving a visible `…`.
fn fit(row: &mut Row, width: u16) {
    let width = usize::from(width).max(1);
    if row.width() <= width {
        return;
    }
    let mut used = 0usize;
    let mut kept: Vec<Span> = Vec::new();
    'outer: for span in std::mem::take(&mut row.spans) {
        let mut text = String::new();
        for ch in span.text.chars() {
            let advance = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(1).max(1);
            if used + advance + 1 > width {
                if !text.is_empty() {
                    kept.push(Span { text, ..span });
                }
                break 'outer;
            }
            text.push(ch);
            used += advance;
        }
        if !text.is_empty() {
            kept.push(Span { text, ..span });
        }
    }
    kept.push(Span::plain("…"));
    row.spans = kept;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ToolCall;

    fn theme() -> Theme {
        Theme::lyra()
    }

    fn call(name: &str, arguments: &str, state: ToolState) -> ToolCall {
        ToolCall {
            id: "c1".to_owned(),
            name: name.to_owned(),
            arguments: arguments.to_owned(),
            args: serde_json::from_str(arguments).ok(),
            args_summary: None,
            state,
            result_summary: None,
            started_at_ms: None,
            duration_ms: None,
            interrupted: false,
            files_read: Vec::new(),
            files_modified: Vec::new(),
            exit_code: None,
        }
    }

    fn view(call: &ToolCall) -> ToolView {
        ToolView::from_call(call)
    }

    #[test]
    fn the_collapsed_row_is_the_design_document_line() {
        let mut raw = call(
            "edit",
            r#"{"path":"src/auth.ts","old_string":"a\nb\nc","new_string":"A\nB\nC\nD"}"#,
            ToolState::Succeeded,
        );
        raw.result_summary = Some("ok".to_owned());
        let row = collapsed(&view(&raw), &theme(), 60);
        assert_eq!(row.plain_text(), "▸ edit src/auth.ts +4 −3");
    }

    #[test]
    fn status_drives_the_colour_and_denial_is_struck_through_not_red() {
        let theme = theme();
        let mut raw = call("edit", "{}", ToolState::Pending);
        assert_eq!(ToolStatus::of(&raw).style(&theme), theme.muted());
        raw.state = ToolState::Running;
        assert_eq!(ToolStatus::of(&raw).style(&theme), theme.accent());
        raw.state = ToolState::Succeeded;
        assert_eq!(ToolStatus::of(&raw).style(&theme), theme.text());
        raw.state = ToolState::Failed;
        assert_eq!(ToolStatus::of(&raw).style(&theme), theme.error());

        raw.state = ToolState::Denied;
        assert_eq!(ToolStatus::of(&raw), ToolStatus::Denied);
        let style = ToolStatus::Denied.style(&theme);
        assert!(style.modifiers.contains(Modifiers::STRIKETHROUGH));
        assert_ne!(style.fg, theme.error().fg, "a refusal is not a failure");
    }

    #[test]
    fn an_interrupted_wait_says_so_rather_than_looking_like_a_failure() {
        let mut raw = call("wait", "{}", ToolState::Succeeded);
        raw.interrupted = true;
        let rows: Vec<String> = children(&view(&raw), &theme(), 60)
            .iter()
            .map(Row::plain_text)
            .collect();
        assert_eq!(rows, ["└─ interrupted by steering"]);
    }

    #[test]
    fn a_pending_call_with_incomplete_arguments_still_names_its_tool() {
        let raw = call("edit", r#"{"path":"src/a"#, ToolState::Pending);
        let row = collapsed(&view(&raw), &theme(), 60);
        assert_eq!(row.plain_text(), "▸ edit", "never render nothing");
    }

    #[test]
    fn a_command_tool_shows_its_command_and_a_nonzero_exit() {
        let mut raw = call("bash", r#"{"command":"cargo test --all"}"#, ToolState::Failed);
        raw.exit_code = Some(101);
        let row = collapsed(&view(&raw), &theme(), 60);
        assert_eq!(row.plain_text(), "▸ bash cargo test --all exit 101");
    }

    #[test]
    fn children_hang_off_the_row_with_a_tree_prefix() {
        let raw = call("read", r#"{"path":"a.txt"}"#, ToolState::Succeeded);
        let view = view(&raw).with_output("one\ntwo\nthree\nfour\nfive\n");
        let rows = children(&view, &theme(), 60);
        let texts: Vec<String> = rows.iter().map(Row::plain_text).collect();
        assert_eq!(
            texts,
            ["└─ one", "   two", "   three", "   … +2 lines"]
        );
    }

    #[test]
    fn a_command_tool_gets_ten_lines_instead_of_three() {
        let raw = call("bash", r#"{"command":"ls"}"#, ToolState::Succeeded);
        let dump: String = (1..=20).map(|n| format!("line {n}\n")).collect();
        let rows = children(&view(&raw).with_output(dump), &theme(), 60);
        assert_eq!(rows.len(), 11, "ten lines plus the marker");
        assert!(rows.last().unwrap().plain_text().contains("+10 lines"));
    }

    #[test]
    fn a_huge_dump_is_cut_before_it_is_ever_wrapped() {
        let dump: String = std::iter::repeat_n("a line of output\n", 400_000).collect();
        assert!(dump.len() > TRUNCATE_SCAN_BUDGET);
        let started = std::time::Instant::now();
        let (lines, hidden) = truncate_output(&dump, 3);
        assert_eq!(lines.len(), 3);
        assert!(hidden.unwrap().ends_with("+ lines"), "an unscanned tail says so");
        assert!(
            started.elapsed().as_millis() < 200,
            "truncation scanned the whole dump"
        );
    }

    #[test]
    fn control_characters_never_reach_a_row() {
        let raw = call("bash", r#"{"command":"x"}"#, ToolState::Succeeded);
        let rows = children(
            &view(&raw).with_output("before\x1b[2Jafter\ttab\r\n"),
            &theme(),
            60,
        );
        let text = rows[0].plain_text();
        assert!(!text.contains('\x1b'), "{text:?}");
        assert!(!text.contains('\t'), "{text:?}");
    }

    #[test]
    fn a_denied_call_says_so_instead_of_dumping_its_error() {
        let mut raw = call("edit", "{}", ToolState::Denied);
        raw.result_summary = Some("user denied the edit".to_owned());
        let rows = children(&view(&raw), &theme(), 60);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].plain_text(), "└─ denied");
    }

    #[test]
    fn a_run_of_reads_and_searches_collapses_to_one_line_with_counts() {
        let calls: Vec<ToolCall> = vec![
            call("read", r#"{"path":"a"}"#, ToolState::Succeeded),
            call("read", r#"{"path":"b"}"#, ToolState::Succeeded),
            call("grep", r#"{"pattern":"x"}"#, ToolState::Succeeded),
        ];
        let views: Vec<ToolView> = calls.iter().map(ToolView::from_call).collect();
        let refs: Vec<&ToolView> = views.iter().collect();
        let row = collapse_run(&refs, &theme(), 60).unwrap();
        assert_eq!(row.plain_text(), "▸ read 2 files · searched 1 pattern");
    }

    #[test]
    fn a_run_containing_a_write_is_not_collapsed() {
        let calls = [
            call("read", r#"{"path":"a"}"#, ToolState::Succeeded),
            call("edit", r#"{"path":"b"}"#, ToolState::Succeeded),
        ];
        let views: Vec<ToolView> = calls.iter().map(ToolView::from_call).collect();
        let refs: Vec<&ToolView> = views.iter().collect();
        assert!(collapse_run(&refs, &theme(), 60).is_none());
    }

    #[test]
    fn a_single_call_is_not_collapsed() {
        let raw = call("read", r#"{"path":"a"}"#, ToolState::Succeeded);
        let view = view(&raw);
        assert!(collapse_run(&[&view], &theme(), 60).is_none());
    }

    #[test]
    fn a_collapsed_run_reports_failures_inside_it() {
        let calls = [
            call("read", r#"{"path":"a"}"#, ToolState::Succeeded),
            call("read", r#"{"path":"b"}"#, ToolState::Failed),
        ];
        let views: Vec<ToolView> = calls.iter().map(ToolView::from_call).collect();
        let refs: Vec<&ToolView> = views.iter().collect();
        assert!(collapse_run(&refs, &theme(), 60)
            .unwrap()
            .plain_text()
            .contains("1 failed"));
    }

    #[test]
    fn expansion_renders_the_diff_through_the_one_diff_renderer() {
        let raw = call(
            "edit",
            r#"{"path":"a.ts","old_string":"const a = 1;","new_string":"const a = 2;"}"#,
            ToolState::Succeeded,
        );
        let rows: Vec<String> = expanded(&view(&raw), &theme(), 60)
            .iter()
            .map(Row::plain_text)
            .collect();
        assert_eq!(rows[0], "▸ edit a.ts +1 −1");
        assert!(rows.iter().any(|row| row.contains("− const a = 1;")), "{rows:?}");
        assert!(rows.iter().any(|row| row.contains("+ const a = 2;")), "{rows:?}");
    }

    #[test]
    fn a_unified_patch_argument_is_understood_too() {
        let raw = call(
            "apply_patch",
            "{\"path\":\"a.ts\",\"patch\":\"@@ -1,1 +1,1 @@\\n-old\\n+new\\n\"}",
            ToolState::Succeeded,
        );
        assert_eq!(collapsed(&view(&raw), &theme(), 60).plain_text(), "▸ apply_patch a.ts +1 −1");
    }

    #[test]
    fn every_row_respects_the_terminal_width() {
        let raw = call(
            "bash",
            r#"{"command":"a very long command line that will not fit at all"}"#,
            ToolState::Succeeded,
        );
        let view = view(&raw).with_output("x".repeat(500));
        for width in [10u16, 24, 40] {
            let mut rows = vec![collapsed(&view, &theme(), width)];
            rows.extend(children(&view, &theme(), width));
            rows.extend(expanded(&view, &theme(), width));
            for row in rows {
                assert!(row.width() <= usize::from(width), "{:?}", row.plain_text());
            }
        }
    }
}
