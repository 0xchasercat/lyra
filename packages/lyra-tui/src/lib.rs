//! Lyra's small, deterministic TUI model rendered by Flywheel's buffer and diff engine.
//! Application state remains actor-owned; Flywheel supplies the double-buffered terminal compositor.
#![forbid(unsafe_code)]

use flywheel::buffer::diff::{DiffState, render_diff};
use flywheel::{Buffer, Cell as FlywheelCell};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Color(pub u8, pub u8, pub u8);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Theme {
    pub name: &'static str,
    pub accent: Color,
    pub live_accent: Color,
}

pub const THEMES: [Theme; 3] = [
    Theme {
        name: "graphite",
        accent: Color(135, 175, 255),
        live_accent: Color(255, 190, 95),
    },
    Theme {
        name: "paper",
        accent: Color(60, 95, 160),
        live_accent: Color(170, 95, 30),
    },
    Theme {
        name: "forest",
        accent: Color(105, 190, 135),
        live_accent: Color(235, 175, 85),
    },
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RowKind {
    User,
    Assistant,
    Thinking,
    ToolCollapsed {
        name: String,
        path: String,
        added: i32,
        removed: i32,
    },
    ToolExpanded,
    Diff,
    Notice,
    Boundary,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Row {
    pub id: u64,
    pub kind: RowKind,
    pub text: String,
    pub expanded: bool,
}

impl Row {
    pub fn user(id: u64, text: impl Into<String>) -> Self {
        Self {
            id,
            kind: RowKind::User,
            text: text.into(),
            expanded: true,
        }
    }
    pub fn assistant(id: u64, text: impl Into<String>) -> Self {
        Self {
            id,
            kind: RowKind::Assistant,
            text: text.into(),
            expanded: true,
        }
    }
    pub fn tool(
        id: u64,
        name: impl Into<String>,
        path: impl Into<String>,
        added: i32,
        removed: i32,
    ) -> Self {
        Self {
            id,
            kind: RowKind::ToolCollapsed {
                name: name.into(),
                path: path.into(),
                added,
                removed,
            },
            text: String::new(),
            expanded: false,
        }
    }
    pub fn notice(id: u64, text: impl Into<String>) -> Self {
        Self {
            id,
            kind: RowKind::Notice,
            text: text.into(),
            expanded: true,
        }
    }
    pub fn boundary(id: u64, before: u64, after: u64) -> Self {
        Self {
            id,
            kind: RowKind::Boundary,
            text: format!("context compacted · {before} → {after} tokens"),
            expanded: true,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Activity {
    pub live_agents: Vec<String>,
    pub queued: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Footer {
    pub input_tokens: u64,
    pub context_tokens: u64,
    pub context_window: u64,
    pub cost_cents: u64,
    pub elapsed_ms: u64,
    pub retry: Option<RetryStatus>,
    pub context_repair: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetryStatus {
    pub attempt: u8,
    pub max_attempts: u8,
    pub reason: String,
    pub remaining_ms: u64,
}

impl Default for Footer {
    fn default() -> Self {
        Self {
            input_tokens: 0,
            context_window: 200_000,
            context_tokens: 0,
            cost_cents: 0,
            elapsed_ms: 0,
            retry: None,
            context_repair: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SetupOption {
    pub key: String,
    pub label: String,
    pub detail: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SetupControl {
    Select {
        options: Vec<SetupOption>,
        selected: usize,
    },
    Input {
        value: String,
        default_value: Option<String>,
        secret: bool,
    },
    Complete,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SetupSaved {
    pub path: String,
    pub provider: String,
    pub model: String,
    pub auth: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SetupScreen {
    pub step: usize,
    pub total: usize,
    pub title: String,
    pub detail: String,
    pub answers: Vec<String>,
    pub error: Option<String>,
    pub saved: Option<SetupSaved>,
    pub control: SetupControl,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TuiState {
    pub project: String,
    pub branch: String,
    pub model: String,
    pub session: String,
    pub rows: Vec<Row>,
    pub activity: Activity,
    pub composer: String,
    pub streaming: bool,
    pub footer: Footer,
    pub setup: Option<SetupScreen>,
    pub next_id: u64,
}

impl TuiState {
    pub fn new(
        project: impl Into<String>,
        branch: impl Into<String>,
        model: impl Into<String>,
        session: impl Into<String>,
    ) -> Self {
        Self {
            project: project.into(),
            branch: branch.into(),
            model: model.into(),
            session: session.into(),
            rows: Vec::new(),
            activity: Activity::default(),
            composer: String::new(),
            streaming: false,
            footer: Footer::default(),
            setup: None,
            next_id: 1,
        }
    }
    pub fn push(&mut self, row: Row) {
        self.next_id = self.next_id.max(row.id.saturating_add(1));
        self.rows.push(row);
    }
    pub fn append_assistant(&mut self, text: &str) {
        if let Some(last) = self
            .rows
            .last_mut()
            .filter(|row| row.kind == RowKind::Assistant && self.streaming)
        {
            last.text.push_str(text);
        } else {
            let id = self.next_id;
            self.next_id += 1;
            self.rows.push(Row::assistant(id, text));
        }
    }
    pub fn toggle_tool(&mut self, id: u64) -> bool {
        let Some(row) = self.rows.iter_mut().find(|row| row.id == id) else {
            return false;
        };
        if matches!(
            row.kind,
            RowKind::ToolCollapsed { .. } | RowKind::ToolExpanded
        ) {
            row.expanded = !row.expanded;
            true
        } else {
            false
        }
    }
    pub fn activity_line(&self) -> String {
        if self.activity.live_agents.is_empty() && self.activity.queued == 0 {
            return "  Enter send  ·  Ctrl+Enter queue  ·  Tab inspect tools  ·  Esc exit".into();
        }
        let agents = self
            .activity
            .live_agents
            .iter()
            .map(|agent| format!("◎ {agent}"))
            .collect::<Vec<_>>()
            .join("  ");
        let queued = if self.activity.queued == 0 {
            String::new()
        } else {
            format!("  ○ {} queued", self.activity.queued)
        };
        format!("{agents}{queued}")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cell {
    pub ch: char,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Frame {
    pub width: usize,
    pub height: usize,
    pub cells: Vec<Cell>,
}

impl Frame {
    pub fn blank(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            cells: vec![Cell { ch: ' ' }; width.saturating_mul(height)],
        }
    }
    pub fn set(&mut self, x: usize, y: usize, ch: char) {
        if x < self.width && y < self.height {
            self.cells[y * self.width + x].ch = ch;
        }
    }
    pub fn line(&self, y: usize) -> String {
        if y >= self.height {
            return String::new();
        }
        (0..self.width)
            .map(|x| self.cells[y * self.width + x].ch)
            .collect()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenderBatch {
    pub ansi: String,
    pub frame: Frame,
    pub fast_path: bool,
}

#[derive(Clone, Debug)]
pub struct Renderer {
    previous: Option<Buffer>,
    diff_state: DiffState,
    theme: Theme,
}

impl Renderer {
    pub fn new(theme: Theme) -> Self {
        Self {
            previous: None,
            diff_state: DiffState::new(),
            theme,
        }
    }
    pub fn theme(&self) -> Theme {
        self.theme
    }
    pub fn render(&mut self, state: &TuiState, width: usize, height: usize) -> RenderBatch {
        let width = width.min(u16::MAX as usize);
        let height = height.min(u16::MAX as usize);
        let frame = compose(state, width, height, self.theme);
        if width == 0 || height == 0 {
            self.previous = None;
            return RenderBatch {
                ansi: String::new(),
                frame,
                fast_path: false,
            };
        }
        let next = flywheel_buffer(&frame);
        let dimensions_changed = self.previous.as_ref().is_some_and(|buffer| {
            buffer.width() as usize != width || buffer.height() as usize != height
        });
        if dimensions_changed {
            self.previous = None;
            self.diff_state.reset();
        }
        let initial = self.previous.is_none();
        let current = self
            .previous
            .as_ref()
            .cloned()
            .unwrap_or_else(|| Buffer::new(width as u16, height as u16));
        let mut bytes = if initial {
            b"\x1b[2J\x1b[H\x1b[?25l".to_vec()
        } else {
            Vec::new()
        };
        let result = render_diff(&current, &next, &[], &mut bytes, &mut self.diff_state);
        let fast_path = !initial && result.cells_changed < width.max(1) / 2;
        self.previous = Some(next);
        RenderBatch {
            ansi: String::from_utf8_lossy(&bytes).into_owned(),
            frame,
            fast_path,
        }
    }
    pub fn set_theme(&mut self, theme: Theme) {
        if self.theme != theme {
            self.theme = theme;
            self.previous = None;
            self.diff_state.reset();
        }
    }
    pub fn append_stream(
        &mut self,
        state: &mut TuiState,
        chunk: &str,
        width: usize,
        height: usize,
    ) -> RenderBatch {
        if let Some(row) = state
            .rows
            .last_mut()
            .filter(|row| row.kind == RowKind::Assistant && state.streaming)
        {
            row.text.push_str(chunk);
        }
        self.render(state, width, height)
    }
}

fn compose(state: &TuiState, width: usize, height: usize, theme: Theme) -> Frame {
    let mut frame = Frame::blank(width, height);
    if width == 0 || height == 0 {
        return frame;
    }
    let header = format!(
        " lyra   {}   {}   {}   {}",
        state.project, state.branch, state.model, state.session
    );
    put_wrapped(&mut frame, 0, 0, &header, width);
    if height > 1 {
        put_wrapped(&mut frame, 0, 1, &"─".repeat(width), width);
    }
    if let Some(setup) = &state.setup {
        return compose_setup(setup, width, height);
    }
    let footer_rows = if height >= 4 {
        4
    } else {
        height.saturating_sub(2)
    };
    let body_end = height.saturating_sub(footer_rows);
    let mut y = 2;
    if state.rows.is_empty() {
        put_wrapped(&mut frame, 0, y, "  Ready", width);
        y += 1;
        put_wrapped(
            &mut frame,
            0,
            y,
            "  Describe a coding task, ask about the repository, or type /help.",
            width,
        );
        y += 2;
    }
    for row in &state.rows {
        if y >= body_end {
            break;
        }
        let line = row_line(row);
        let prefix = if row.expanded { "  " } else { "  ▸ " };
        for wrapped in wrap_text(&format!("{prefix}{line}"), width.saturating_sub(1)) {
            if y >= body_end {
                break;
            }
            put_wrapped(&mut frame, 0, y, &wrapped, width);
            y += 1;
        }
    }
    if body_end < height {
        put_wrapped(&mut frame, 0, body_end, &"─".repeat(width), width);
    }
    if footer_rows >= 3 && body_end + 1 < height {
        put_wrapped(&mut frame, 0, body_end + 1, &state.activity_line(), width);
    }
    if footer_rows >= 2 && body_end + 2 < height {
        put_wrapped(
            &mut frame,
            0,
            body_end + 2,
            &format!("  > {}", state.composer),
            width,
        );
    }
    if body_end + 1 < height {
        let border = if state.streaming {
            theme.live_accent
        } else {
            theme.accent
        };
        put_wrapped(
            &mut frame,
            0,
            height - 1,
            &if let Some(retry) = &state.footer.retry {
                format!(
                    "  retry {}/{} · {} · {:.1}s   {}k/{}k   ${:.2}",
                    retry.attempt,
                    retry.max_attempts,
                    retry.reason,
                    retry.remaining_ms as f64 / 1000.0,
                    state.footer.context_tokens / 1000,
                    state.footer.context_window / 1000,
                    state.footer.cost_cents as f64 / 100.0
                )
            } else {
                format!(
                    "  {}  in:{}  {}k/{}k  ${:.2}  {:.1}s",
                    if state.streaming { "┌" } else { "▸" },
                    state.footer.input_tokens,
                    state.footer.context_tokens / 1000,
                    state.footer.context_window / 1000,
                    state.footer.cost_cents as f64 / 100.0,
                    state.footer.elapsed_ms as f64 / 1000.0
                )
            },
            width,
        );
        let _ = border;
    }
    frame
}

fn compose_setup(setup: &SetupScreen, width: usize, height: usize) -> Frame {
    let mut frame = Frame::blank(width, height);
    if width == 0 || height == 0 {
        return frame;
    }
    put_wrapped(
        &mut frame,
        0,
        0,
        &format!(
            " lyra   / first-run setup                 step {}/{}",
            setup.step, setup.total
        ),
        width,
    );
    if height > 1 {
        put_wrapped(&mut frame, 0, 1, &"─".repeat(width), width);
    }
    let mut y = 3;
    put_setup_wrapped(
        &mut frame,
        &mut y,
        &format!("SETUP  /  {}", setup.title),
        width,
        height,
    );
    put_setup_wrapped(&mut frame, &mut y, &setup.detail, width, height);
    if !setup.answers.is_empty() {
        y += 1;
        put_setup_wrapped(&mut frame, &mut y, "Completed", width, height);
        for answer in setup.answers.iter().rev().take(4).rev() {
            put_setup_wrapped(&mut frame, &mut y, &format!("  ✓ {answer}"), width, height);
        }
    }
    y += 1;
    match &setup.control {
        SetupControl::Select { options, selected } => {
            put_setup_wrapped(
                &mut frame,
                &mut y,
                "Choose one  ·  ↑/↓ move  ·  number jump  ·  Enter confirm",
                width,
                height,
            );
            for (index, option) in options.iter().enumerate() {
                let marker = if index == *selected { "▸" } else { " " };
                put_setup_wrapped(
                    &mut frame,
                    &mut y,
                    &format!("  {marker} {}  {}", option.key, option.label),
                    width,
                    height,
                );
                put_setup_wrapped(
                    &mut frame,
                    &mut y,
                    &format!("        {}", option.detail),
                    width,
                    height,
                );
            }
        }
        SetupControl::Input {
            value,
            default_value,
            secret,
        } => {
            put_setup_wrapped(
                &mut frame,
                &mut y,
                "Type in the field below  ·  Enter accept  ·  Esc cancel",
                width,
                height,
            );
            let shown = if value.is_empty() {
                default_value
                    .as_ref()
                    .map(|value| format!("<default: {value}>"))
                    .unwrap_or_else(|| "<type here>".into())
            } else if *secret {
                "•".repeat(value.chars().count())
            } else {
                value.clone()
            };
            put_setup_wrapped(
                &mut frame,
                &mut y,
                &format!("  > [ {shown} ]"),
                width,
                height,
            );
            if value.is_empty() && default_value.is_some() {
                put_setup_wrapped(
                    &mut frame,
                    &mut y,
                    "    Leave blank to use the default.",
                    width,
                    height,
                );
            }
        }
        SetupControl::Complete => {
            put_setup_wrapped(&mut frame, &mut y, "✓ Provider saved", width, height);
            if let Some(saved) = &setup.saved {
                put_setup_wrapped(
                    &mut frame,
                    &mut y,
                    &format!("  {}/{}", saved.provider, saved.model),
                    width,
                    height,
                );
                put_setup_wrapped(
                    &mut frame,
                    &mut y,
                    &format!("  Auth: {}", saved.auth),
                    width,
                    height,
                );
                put_setup_wrapped(
                    &mut frame,
                    &mut y,
                    &format!("  File: {}", saved.path),
                    width,
                    height,
                );
            }
            put_setup_wrapped(
                &mut frame,
                &mut y,
                "Press Enter to start Lyra  ·  Esc cancel",
                width,
                height,
            );
        }
    }
    if let Some(error) = &setup.error {
        y += 1;
        put_setup_wrapped(&mut frame, &mut y, &format!("! {error}"), width, height);
    }
    if height >= 2 {
        put_wrapped(&mut frame, 0, height - 2, &"─".repeat(width), width);
        put_wrapped(
            &mut frame,
            0,
            height - 1,
            &format!("  step {}/{}  ·  Esc cancel", setup.step, setup.total),
            width,
        );
    }
    frame
}

fn put_setup_wrapped(frame: &mut Frame, y: &mut usize, text: &str, width: usize, height: usize) {
    for wrapped in wrap_text(text, width.saturating_sub(2)) {
        if *y < height.saturating_sub(2) {
            put_wrapped(frame, 1, *y, &wrapped, width.saturating_sub(1));
        }
        *y += 1;
    }
}

fn row_line(row: &Row) -> String {
    match &row.kind {
        RowKind::User => format!("you · {}", row.text),
        RowKind::Assistant => row.text.clone(),
        RowKind::Thinking => format!("thinking · {}", row.text),
        RowKind::ToolCollapsed {
            name,
            path,
            added,
            removed,
        } => {
            let location = if path.is_empty() {
                String::new()
            } else {
                format!("  {path}")
            };
            let stats = if *added == 0 && *removed == 0 {
                String::new()
            } else {
                format!("  +{added} −{removed}")
            };
            let hint = if row.expanded {
                "[Tab/Enter collapse]"
            } else {
                "[Tab/Enter expand]"
            };
            if row.expanded && !row.text.is_empty() {
                format!("{name}{location}{stats}  {hint}\n{}", row.text)
            } else {
                format!("{name}{location}{stats}  {hint}")
            }
        }
        RowKind::ToolExpanded => row.text.clone(),
        RowKind::Diff => format!("diff · {}", row.text),
        RowKind::Notice => format!("note · {}", row.text),
        RowKind::Boundary => format!("──── {}", row.text),
    }
}
fn put_wrapped(frame: &mut Frame, x: usize, y: usize, text: &str, width: usize) {
    for (index, ch) in display_chars(text)
        .take(width.saturating_sub(x))
        .enumerate()
    {
        frame.set(x + index, y, ch);
    }
}
fn wrap_text(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![String::new()];
    }
    let mut output = Vec::new();
    for logical_line in text.split('\n') {
        let chars: Vec<char> = display_chars(logical_line).collect();
        if chars.is_empty() {
            output.push(String::new());
        } else {
            output.extend(chars.chunks(width).map(|chunk| chunk.iter().collect()));
        }
    }
    output
}
fn display_chars(text: &str) -> impl Iterator<Item = char> + '_ {
    text.chars().map(|ch| {
        if ch == '\t' {
            ' '
        } else if ch.is_control() {
            '�'
        } else {
            ch
        }
    })
}
fn flywheel_buffer(frame: &Frame) -> Buffer {
    let mut buffer = Buffer::new(frame.width as u16, frame.height as u16);
    for y in 0..frame.height {
        for x in 0..frame.width {
            let cell = FlywheelCell::from_char(frame.cells[y * frame.width + x].ch);
            let _ = buffer.set(x as u16, y as u16, cell);
        }
    }
    buffer
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InputEvent {
    Enter,
    CtrlEnter,
    Escape,
    CtrlC,
    Character(char),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InputAction {
    Steer(String),
    Queue(String),
    Cancel,
    Rewind,
    Exit,
    Edit,
}

#[derive(Clone, Debug, Default)]
pub struct InputController {
    escape_pending: bool,
    ctrl_c_count: u8,
}
impl InputController {
    pub fn handle(
        &mut self,
        event: InputEvent,
        composer: &mut String,
        streaming: bool,
    ) -> Option<InputAction> {
        match event {
            InputEvent::Enter if streaming => {
                if composer.is_empty() {
                    Some(InputAction::Steer(String::new()))
                } else {
                    Some(InputAction::Steer(std::mem::take(composer)))
                }
            }
            InputEvent::CtrlEnter if streaming => {
                Some(InputAction::Queue(std::mem::take(composer)))
            }
            InputEvent::Escape => {
                if self.escape_pending {
                    self.escape_pending = false;
                    Some(InputAction::Rewind)
                } else {
                    self.escape_pending = true;
                    Some(InputAction::Cancel)
                }
            }
            InputEvent::CtrlC => {
                self.ctrl_c_count = self.ctrl_c_count.saturating_add(1);
                if self.ctrl_c_count >= 2 {
                    self.ctrl_c_count = 0;
                    Some(InputAction::Exit)
                } else {
                    Some(InputAction::Cancel)
                }
            }
            InputEvent::Character(ch) => {
                self.escape_pending = false;
                self.ctrl_c_count = 0;
                composer.push(ch);
                Some(InputAction::Edit)
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapsed_tool_and_activity_fit_the_reference_layout() {
        let mut state = TuiState::new("proj", "main", "opus-5", "purple-falcon");
        state.push(Row::tool(1, "edit", "src/auth.ts", 12, 4));
        state.activity.live_agents = vec!["hollow-peak".into(), "amber-forge".into()];
        state.activity.queued = 2;
        let mut renderer = Renderer::new(THEMES[0]);
        let batch = renderer.render(&state, 50, 12);
        assert!(batch.frame.line(2).contains("▸ edit  src/auth.ts  +12 −4"));
        assert!(batch.frame.line(9).contains("◎ hollow-peak"));
    }

    #[test]
    fn non_diff_tools_do_not_claim_zero_file_changes() {
        let mut state = TuiState::new("proj", "main", "model", "session");
        let mut spawn = Row::tool(1, "spawn", "failed", 0, 0);
        spawn.text = "Input\n{}".into();
        spawn.expanded = true;
        state.push(spawn);
        let mut renderer = Renderer::new(THEMES[0]);
        let batch = renderer.render(&state, 80, 12);
        assert!(
            batch
                .frame
                .line(2)
                .contains("spawn  failed  [Tab/Enter collapse]")
        );
        assert!(!batch.frame.line(2).contains("+0"));
    }

    #[test]
    fn empty_session_explains_the_prompt_and_visible_controls() {
        let state = TuiState::new("proj", "main", "model", "session");
        let mut renderer = Renderer::new(THEMES[0]);
        let batch = renderer.render(&state, 90, 12);
        assert!(batch.frame.line(2).contains("Ready"));
        assert!(batch.frame.line(3).contains("Describe a coding task"));
        assert!(batch.frame.line(9).contains("Enter send"));
        assert!(batch.frame.line(10).contains(">"));
    }

    #[test]
    fn second_render_diffs_only_changed_cells_and_streaming_uses_fast_path() {
        let mut state = TuiState::new("proj", "main", "model", "session");
        state.push(Row::assistant(1, "hello"));
        state.streaming = true;
        let mut renderer = Renderer::new(THEMES[0]);
        let first = renderer.render(&state, 40, 10);
        assert!(first.ansi.starts_with("\x1b[2J\x1b[H\x1b[?25l"));
        let second = renderer.append_stream(&mut state, " world", 40, 10);
        assert!(second.fast_path);
        assert!(!second.ansi.starts_with("\x1b[2J"));
        assert!(second.frame.line(2).contains("world"));
        let resized = renderer.render(&state, 41, 10);
        assert!(resized.ansi.starts_with("\x1b[2J\x1b[H\x1b[?25l"));
    }

    #[test]
    fn multiline_rows_never_emit_literal_terminal_control_bytes() {
        let mut state = TuiState::new("proj", "main", "model", "session");
        state.push(Row::assistant(1, "first line\nsecond line\x1b[31m"));
        let mut renderer = Renderer::new(THEMES[0]);
        let batch = renderer.render(&state, 50, 12);
        assert!(batch.frame.line(2).contains("first line"));
        assert!(batch.frame.line(3).contains("second line�[31m"));
        assert!(!batch.ansi.contains('\n'));
        assert!(!batch.ansi.contains("\x1b[31m"));
    }

    #[test]
    fn setup_screen_renders_visible_selection_and_input_controls() {
        let mut state = TuiState::new("proj", "setup", "provider required", "first-run");
        state.setup = Some(SetupScreen {
            step: 1,
            total: 5,
            title: "Choose a provider".into(),
            detail: "Use arrows, then confirm.".into(),
            answers: Vec::new(),
            error: None,
            saved: None,
            control: SetupControl::Select {
                options: vec![
                    SetupOption {
                        key: "1".into(),
                        label: "OpenAI".into(),
                        detail: "Official API".into(),
                    },
                    SetupOption {
                        key: "2".into(),
                        label: "Anthropic".into(),
                        detail: "Official API".into(),
                    },
                ],
                selected: 0,
            },
        });
        let mut renderer = Renderer::new(THEMES[0]);
        let selection = renderer.render(&state, 90, 24);
        let selection_text = (0..24)
            .map(|line| selection.frame.line(line))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(selection_text.contains("step 1/5"));
        assert!(selection_text.contains("↑/↓ move"));
        assert!(selection_text.contains("▸ 1  OpenAI"));

        state.setup.as_mut().unwrap().control = SetupControl::Input {
            value: String::new(),
            default_value: Some("gpt-5.6".into()),
            secret: false,
        };
        let input = renderer.render(&state, 90, 24);
        let input_text = (0..24)
            .map(|line| input.frame.line(line))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(input_text.contains("> [ <default: gpt-5.6> ]"));
        assert!(input_text.contains("Leave blank to use the default."));
    }

    #[test]
    fn steering_and_interrupt_semantics_keep_queued_text_visible_to_caller() {
        let mut input = InputController::default();
        let mut composer = "fix the loop".to_string();
        assert_eq!(
            input.handle(InputEvent::Enter, &mut composer, true),
            Some(InputAction::Steer("fix the loop".into()))
        );
        composer = "after this turn".into();
        assert_eq!(
            input.handle(InputEvent::CtrlEnter, &mut composer, true),
            Some(InputAction::Queue("after this turn".into()))
        );
        assert_eq!(
            input.handle(InputEvent::Escape, &mut composer, true),
            Some(InputAction::Cancel)
        );
        assert_eq!(
            input.handle(InputEvent::Escape, &mut composer, true),
            Some(InputAction::Rewind)
        );
        assert_eq!(
            input.handle(InputEvent::CtrlC, &mut composer, true),
            Some(InputAction::Cancel)
        );
        assert_eq!(
            input.handle(InputEvent::CtrlC, &mut composer, true),
            Some(InputAction::Exit)
        );
    }
}
