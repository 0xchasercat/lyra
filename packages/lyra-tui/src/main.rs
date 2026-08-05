use lyra_tui::{
    Color, Renderer, RetryStatus, Row, SetupControl, SetupOption, SetupSaved, SetupScreen, THEMES,
    Theme, TuiState,
};
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};

#[derive(Debug, Deserialize)]
struct FrameRequest {
    project: String,
    branch: String,
    model: String,
    session: String,
    #[serde(default = "default_theme")]
    theme: String,
    #[serde(default)]
    accent: String,
    width: usize,
    height: usize,
    #[serde(default)]
    rows: Vec<WireRow>,
    #[serde(default)]
    agents: Vec<String>,
    #[serde(default)]
    queued: usize,
    #[serde(default)]
    composer: String,
    #[serde(default)]
    streaming: bool,
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    context_tokens: u64,
    #[serde(default = "default_context_window")]
    context_window: u64,
    retry: Option<WireRetry>,
    #[serde(default)]
    cost_cents: u64,
    #[serde(default)]
    elapsed_ms: u64,
    setup: Option<WireSetup>,
}

#[derive(Debug, Deserialize)]
struct WireSetup {
    step: usize,
    total: usize,
    title: String,
    detail: String,
    #[serde(default)]
    answers: Vec<String>,
    error: Option<String>,
    saved: Option<WireSetupSaved>,
    control: WireSetupControl,
}

#[derive(Debug, Deserialize)]
struct WireSetupSaved {
    path: String,
    provider: String,
    model: String,
    auth: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum WireSetupControl {
    Select {
        options: Vec<WireSetupOption>,
        selected: usize,
    },
    Input {
        value: String,
        #[serde(rename = "defaultValue")]
        default_value: Option<String>,
        secret: bool,
    },
    Complete,
}

#[derive(Debug, Deserialize)]
struct WireSetupOption {
    key: String,
    label: String,
    detail: String,
}

#[derive(Debug, Deserialize)]
struct WireRetry {
    attempt: u8,
    max_attempts: u8,
    reason: String,
    remaining_ms: u64,
}

#[derive(Debug, Deserialize)]
struct WireRow {
    kind: String,
    text: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    added: i32,
    #[serde(default)]
    removed: i32,
    #[serde(default)]
    expanded: bool,
}

#[derive(Serialize)]
struct FrameResponse<'a> {
    ansi: &'a str,
    fast_path: bool,
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut renderer = Renderer::new(THEMES[0]);
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<FrameRequest>(&line) {
            Ok(request) => {
                renderer.set_theme(theme(&request.theme, &request.accent));
                let mut state = TuiState::new(
                    request.project,
                    request.branch,
                    request.model,
                    request.session,
                );
                for (index, row) in request.rows.into_iter().enumerate() {
                    let id = index as u64 + 1;
                    state.push(match row.kind.as_str() {
                        "user" => Row::user(id, row.text),
                        "assistant" => Row::assistant(id, row.text),
                        "tool" => {
                            let mut tool =
                                Row::tool(id, row.name, row.path, row.added, row.removed);
                            tool.text = row.text;
                            tool.expanded = row.expanded;
                            tool
                        }
                        "boundary" => Row::boundary(id, 0, 0),
                        _ => Row::notice(id, row.text),
                    });
                }
                state.setup = request.setup.map(|setup| SetupScreen {
                    step: setup.step,
                    total: setup.total,
                    title: setup.title,
                    detail: setup.detail,
                    answers: setup.answers,
                    error: setup.error,
                    saved: setup.saved.map(|saved| SetupSaved {
                        path: saved.path,
                        provider: saved.provider,
                        model: saved.model,
                        auth: saved.auth,
                    }),
                    control: match setup.control {
                        WireSetupControl::Select { options, selected } => SetupControl::Select {
                            options: options
                                .into_iter()
                                .map(|option| SetupOption {
                                    key: option.key,
                                    label: option.label,
                                    detail: option.detail,
                                })
                                .collect(),
                            selected,
                        },
                        WireSetupControl::Input {
                            value,
                            default_value,
                            secret,
                        } => SetupControl::Input {
                            value,
                            default_value,
                            secret,
                        },
                        WireSetupControl::Complete => SetupControl::Complete,
                    },
                });
                state.activity.live_agents = request.agents;
                state.activity.queued = request.queued;
                state.composer = request.composer;
                state.streaming = request.streaming;
                state.footer.input_tokens = request.input_tokens;
                state.footer.context_tokens = request.context_tokens;
                state.footer.context_window = request.context_window;
                state.footer.retry = request.retry.map(|retry| RetryStatus {
                    attempt: retry.attempt,
                    max_attempts: retry.max_attempts,
                    reason: retry.reason,
                    remaining_ms: retry.remaining_ms,
                });
                state.footer.cost_cents = request.cost_cents;
                state.footer.elapsed_ms = request.elapsed_ms;
                let batch = renderer.render(&state, request.width, request.height);
                serde_json::to_writer(
                    &mut stdout,
                    &FrameResponse {
                        ansi: &batch.ansi,
                        fast_path: batch.fast_path,
                    },
                )?;
                stdout.write_all(b"\n")?;
                stdout.flush()?;
            }
            Err(error) => {
                serde_json::to_writer(
                    &mut stdout,
                    &serde_json::json!({ "error": error.to_string() }),
                )?;
                stdout.write_all(b"\n")?;
                stdout.flush()?;
            }
        }
    }
    Ok(())
}

fn default_theme() -> String {
    "graphite".to_owned()
}
fn default_context_window() -> u64 {
    200_000
}
fn theme(name: &str, accent: &str) -> Theme {
    let base = THEMES
        .iter()
        .copied()
        .find(|theme| theme.name == name)
        .unwrap_or(THEMES[0]);
    let Some(color) = parse_color(accent) else {
        return base;
    };
    Theme {
        name: base.name,
        accent: color,
        live_accent: color,
    }
}
fn parse_color(value: &str) -> Option<Color> {
    let hex = value.strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let raw = u32::from_str_radix(hex, 16).ok()?;
    Some(Color(
        ((raw >> 16) & 0xff) as u8,
        ((raw >> 8) & 0xff) as u8,
        (raw & 0xff) as u8,
    ))
}
