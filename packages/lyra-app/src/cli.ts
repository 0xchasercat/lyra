#!/usr/bin/env bun
import { realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import type { AcpDaemon } from "@lyra/acp";
import type { AgentEvent, AgentTurnResult } from "@lyra/core";
import { supportsOsKeychain } from "@lyra/provider";
import { needsProviderSetup, ProviderSetupWizard, saveProviderSetup, type SavedProviderSetup } from "./provider-setup.ts";
import { LyraRuntime } from "./runtime.ts";

interface CliOptions { origin: string; session?: string; model?: string; prompt?: string; acp: boolean; help: boolean; allowAutoGit: boolean; }
interface UiRow { kind: "user" | "assistant" | "tool" | "notice" | "boundary"; text: string; name?: string; path?: string; added?: number; removed?: number; id?: string; expanded?: boolean; }
interface SetupOption { key: string; label: string; detail: string; }
interface SetupView { step: number; total: number; title: string; detail: string; answers: string[]; error?: string; saved?: { path: string; provider: string; model: string; auth: string }; control: { kind: "select"; options: SetupOption[]; selected: number } | { kind: "input"; value: string; defaultValue?: string; secret: boolean } | { kind: "complete" }; }
interface FrameRequest { project: string; branch: string; model: string; session: string; theme: string; accent: string; width: number; height: number; rows: UiRow[]; agents: string[]; queued: number; composer: string; streaming: boolean; input_tokens: number; context_tokens: number; context_window: number; cost_cents: number; elapsed_ms: number; retry?: { attempt: number; max_attempts: number; reason: string; remaining_ms: number }; setup?: SetupView; }
interface SessionStats { inputTokens: number; contextTokens: number; contextWindow: number; costCents: number; }
const ENTER_TUI = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l";
const LEAVE_TUI = "\x1b[0m\x1b[?25h\x1b[?1049l";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(helpText()); return; }
  const runtimeOptions = { ...options, confirmAuto: async () => options.allowAutoGit };
  if (options.acp) {
    const runtime = await LyraRuntime.create(runtimeOptions);
    try { await runtime.app.acp.serve(Bun.stdin.stream(), { write: (data) => { process.stdout.write(data); } }); }
    finally { await runtime.close(); }
  } else if (options.prompt !== undefined || !process.stdin.isTTY || !process.stdout.isTTY) {
    let streamed = false;
    const runtime = await LyraRuntime.create({ ...runtimeOptions, onReport: (message) => { process.stderr.write(`[report] ${message}\n`); }, onEvent: (event) => { if (event.type === "text_delta") { streamed = true; process.stdout.write(event.text); } } });
    try { const prompt = options.prompt ?? await new Response(Bun.stdin.stream()).text(); const result = await runtime.prompt(prompt.trim()); if (!streamed) process.stdout.write(assistantText(result)); process.stdout.write("\n"); }
    finally { await runtime.close(); }
  } else await runInteractive(runtimeOptions);
}
async function runInteractive(cli: CliOptions & { confirmAuto(): Promise<boolean> }): Promise<void> {
  const bridge = await TuiBridge.start();
  process.stdout.write(ENTER_TUI);
  let runtime: LyraRuntime | undefined;
  try {
    if (await needsProviderSetup(cli.origin, cli.model)) {
      const configured = await new ProviderSetupUi(bridge, cli).run();
      if (!configured) return;
    }
    runtime = await LyraRuntime.create(cli);
    const client = await InProcessAcpClient.connect(runtime.app.acp);
    const ui = new InteractiveUi(client, bridge, { project: basename(cli.origin), branch: await branchName(cli.origin), model: runtime.session.environment.model, session: runtime.session.descriptor.name, theme: runtime.app.config.tui.theme, accent: runtime.app.config.tui.accent });
    client.onNotification((method, params) => { if (method === "session/update") void ui.update(params); });
    await ui.run();
  } finally { await bridge.close(); await runtime?.close(); process.stdout.write(LEAVE_TUI); }
}

class ProviderSetupUi {
  readonly #wizard = new ProviderSetupWizard();
  readonly #done = Promise.withResolvers<boolean>();
  #composer = "";
  #error = "";
  #saved: SavedProviderSetup | undefined;
  #selected = 0;
  #promptTitle = "";
  #tail: Promise<void> = Promise.resolve();
  constructor(private readonly bridge: TuiBridge, private readonly cli: CliOptions) {}
  async run(): Promise<boolean> {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("keypress", this.#onKeypress);
    process.stdout.on("resize", this.#onResize);
    await this.render();
    const result = await this.#done.promise;
    await this.#tail;
    process.stdin.off("keypress", this.#onKeypress);
    process.stdout.off("resize", this.#onResize);
    process.stdin.setRawMode?.(false);
    return result;
  }
  readonly #onResize = (): void => { void this.render(); };
  readonly #onKeypress = (text: string, key: { name?: string; ctrl?: boolean; meta?: boolean }): void => {
    this.#tail = this.#tail.then(async () => {
      if ((key.ctrl && key.name === "c") || key.name === "escape") { this.#done.resolve(false); return; }
      const prompt = this.#wizard.current();
      if (prompt.options) {
        if (key.name === "up" || key.name === "down") {
          const delta = key.name === "up" ? -1 : 1;
          this.#selected = (this.#selected + delta + prompt.options.length) % prompt.options.length;
          await this.render();
          return;
        }
        const optionIndex = prompt.options.findIndex((option) => option.key === text);
        if (optionIndex >= 0) {
          this.#selected = optionIndex;
          await this.render();
          return;
        }
      }
      if (key.name === "backspace") this.#composer = [...this.#composer].slice(0, -1).join("");
      else if (key.name === "return") await this.submit();
      else if (!prompt.options && !key.ctrl && !key.meta && text && text >= " ") this.#composer += text;
      await this.render();
    }).catch((error) => { this.#error = error instanceof Error ? error.message : String(error); return this.render(); });
  };
  async submit(): Promise<void> {
    this.#error = "";
    if (this.#saved) { this.#done.resolve(true); return; }
    const prompt = this.#wizard.current();
    const raw = prompt.options?.[this.#selected]?.key ?? this.#composer;
    if (prompt.title === "Credential source" && raw === "1" && !supportsOsKeychain()) throw new Error("No supported OS keychain is available. Choose environment or plaintext storage.");
    if (!this.#wizard.complete) { this.#wizard.submit(raw); this.#composer = ""; }
    if (this.#wizard.complete) this.#saved = await saveProviderSetup(this.#wizard.result());
  }
  render(): Promise<void> {
    const prompt = this.#wizard.current();
    if (prompt.title !== this.#promptTitle) { this.#promptTitle = prompt.title; this.#selected = 0; }
    const progress = this.#wizard.progress();
    const setup: SetupView = {
      step: progress.current,
      total: progress.total,
      title: prompt.title,
      detail: prompt.detail,
      answers: this.#wizard.answers,
      ...(this.#error ? { error: this.#error } : {}),
      ...(this.#saved ? { saved: this.#saved } : {}),
      control: this.#saved ? { kind: "complete" } : prompt.options ? { kind: "select", options: [...prompt.options], selected: this.#selected } : { kind: "input", value: this.#composer, ...(prompt.defaultValue ? { defaultValue: prompt.defaultValue } : {}), secret: prompt.secret === true },
    };
    return this.bridge.render({ project: basename(this.cli.origin), branch: "setup", model: this.#saved ? `${this.#saved.provider}/${this.#saved.model}` : "provider required", session: "first-run", theme: "graphite", accent: "#7aa2f7", width: process.stdout.columns ?? 80, height: process.stdout.rows ?? 24, rows: [], agents: [], queued: 0, composer: "", streaming: false, input_tokens: 0, context_tokens: 0, context_window: 0, cost_cents: 0, elapsed_ms: 0, setup }).then((frame) => { process.stdout.write(frame); });
  }
}

class InteractiveUi {
  readonly #client: InProcessAcpClient;
  readonly #bridge: TuiBridge;
  readonly #base: Pick<FrameRequest, "project" | "branch" | "model" | "session" | "theme" | "accent">;
  readonly #rows: UiRow[] = [];
  readonly #queued: string[] = [];
  #composer = "";
  #streaming = false;
  #started = Date.now();
  #turnSequence = 0;
  #renderTail: Promise<void> = Promise.resolve();
  #stats: SessionStats = { inputTokens: 0, contextTokens: 0, contextWindow: 200_000, costCents: 0 };
  #retry: FrameRequest["retry"];
  #inputTail: Promise<void> = Promise.resolve();
  #done = Promise.withResolvers<void>();
  #agents: string[] = [];
  #toolCursor = 0;

  constructor(client: InProcessAcpClient, bridge: TuiBridge, base: Pick<FrameRequest, "project" | "branch" | "model" | "session" | "theme" | "accent">) { this.#client = client; this.#bridge = bridge; this.#base = base; }

  async run(): Promise<void> {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("keypress", this.#onKeypress);
    process.stdout.on("resize", this.#onResize);
    await this.render();
    await this.#done.promise;
    await this.#inputTail;
    await this.#renderTail;
    process.stdin.off("keypress", this.#onKeypress);
    process.stdout.off("resize", this.#onResize);
    process.stdin.setRawMode?.(false);
  }

  async update(params: unknown): Promise<void> {
    if (!params || typeof params !== "object") return;
    const value = params as { event?: AgentEvent; report?: unknown; stats?: SessionStats };
    if (typeof value.report === "string") this.#rows.push({ kind: "notice", text: `report · ${value.report}` });
    if (value.stats) this.#stats = value.stats;
    const event = value.event;
    if (!event) { await this.render(); return; }
    if (event.type === "text_delta") {
      const last = this.#rows.at(-1);
      if (last?.kind === "assistant") last.text += event.text;
      else this.#rows.push({ kind: "assistant", text: event.text });
    } else if (event.type === "tool_started") {
      const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
      this.#rows.push({ kind: "tool", id: event.id, text: `Input\n${formatOutput(input)}`, name: event.name, path: typeof input.path === "string" ? input.path : "", expanded: false });
      this.#toolCursor = this.#rows.filter((row) => row.kind === "tool").length;
    } else if (event.type === "tool_finished") {
      const row = this.#rows.findLast((candidate) => candidate.kind === "tool" && candidate.id === event.id);
      const progress = event.result.progress === undefined ? "" : `\n\nProgress\n${formatOutput(event.result.progress)}`;
      const output = `${formatOutput(event.result.content)}${progress}`;
      if (row) { row.text += `\n\n${event.result.isError ? "Failed" : "Output"}\n${output}`; row.path = [row.path, event.result.isError ? "failed" : "completed"].filter(Boolean).join(" · "); }
      else this.#rows.push({ kind: "notice", text: `${event.name} ${event.result.isError ? "failed" : "completed"}\n${output}` });
    }
    else if (event.type === "retry") this.#retry = { attempt: event.attempt, max_attempts: event.maxAttempts, reason: event.reason, remaining_ms: event.delayMs };
    else if (event.type === "complete") this.#retry = undefined;
    else if (event.type === "compacted") this.#rows.push({ kind: "boundary", text: `context compacted ${event.tokensBefore} → ${event.tokensAfter}` });
    else if (event.type === "context_repaired") this.#rows.push({ kind: "notice", text: `context repaired (${event.repairs.length})` });
    await this.render();
  }

  readonly #onResize = (): void => { void this.render(); };
  readonly #onKeypress = (text: string, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): void => {
    this.#inputTail = this.#inputTail.then(() => this.handleKey(text, key)).catch((error) => { this.#rows.push({ kind: "notice", text: error instanceof Error ? error.message : String(error) }); return this.render(); });
  };

  async handleKey(text: string, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): Promise<void> {
    if (key.ctrl && key.name === "c") { if (this.#streaming) { await this.#client.request("session/cancel"); this.#rows.push({ kind: "notice", text: "turn cancellation requested" }); await this.render(); return; } this.#done.resolve(); return; }
    if (key.name === "escape") { if (this.#streaming) await this.#client.request("session/cancel"); else this.#done.resolve(); return; }
    if (key.name === "tab") { this.toggleTool(); await this.render(); return; }
    if (key.name === "backspace") { this.#composer = [...this.#composer].slice(0, -1).join(""); await this.render(); return; }
    if (key.name === "return") {
      const prompt = this.#composer.trim(); this.#composer = "";
      if (!prompt) { this.toggleTool(true); await this.render(); return; }
      if (key.ctrl && this.#streaming) { this.#queued.push(prompt); await this.render(); return; }
      if (prompt.startsWith("/") && !this.#streaming) { await this.runSlash(prompt); return; }
      this.startTurn(prompt, this.#streaming); return;
    }
    if (!key.ctrl && !key.meta && text && text >= " ") { this.#composer += text; await this.render(); }
  }


  private toggleTool(latest = false): void {
    const indexes = this.#rows.flatMap((row, index) => row.kind === "tool" ? [index] : []);
    if (indexes.length === 0) return;
    if (latest) this.#toolCursor = indexes.length - 1;
    else this.#toolCursor = (this.#toolCursor - 1 + indexes.length) % indexes.length;
    const row = this.#rows[indexes[this.#toolCursor]!]!;
    row.expanded = !row.expanded;
  }
  startTurn(prompt: string, steer: boolean): void {
    const sequence = ++this.#turnSequence;
    this.#rows.push({ kind: "user", text: prompt }, { kind: "assistant", text: "" });
    this.#streaming = true;
    void this.render();
    const work = this.#client.request(steer ? "session/update" : "session/prompt", { prompt });
    void work.then(async (result) => {
      const assistant = extractAssistant(result);
      const last = this.#rows.at(-1); if (last?.kind === "assistant" && last.text.length === 0 && assistant) last.text = assistant;
      if (sequence !== this.#turnSequence) return;
      this.#streaming = false; await this.render();
      const next = this.#queued.shift(); if (next) this.startTurn(next, false);
    }, async (error) => { if (sequence !== this.#turnSequence) return; this.#streaming = false; this.#rows.push({ kind: "notice", text: error instanceof Error ? error.message : String(error) }); await this.render(); });
  }

  async runSlash(command: string): Promise<void> {
    this.#rows.push({ kind: "user", text: command });
    const result = await this.#client.request("session/command", { command }) as { output?: unknown; error?: string };
    this.#rows.push({ kind: "notice", text: result.error ?? formatOutput(result.output) });
    if (result.output && typeof result.output === "object" && "model" in result.output && typeof result.output.model === "string") this.#base.model = result.output.model;
    await this.render();
  }

  render(): Promise<void> {
    this.#renderTail = this.#renderTail.then(async () => {
      const handles = await this.#client.request("agent/list") as Array<{ id: string; label?: string; status: string }>;
      this.#agents = handles.filter((agent) => agent.status === "running").map((agent) => agent.label ?? agent.id);
      const response = await this.#bridge.render({ ...this.#base, width: process.stdout.columns ?? 80, height: process.stdout.rows ?? 24, rows: this.#rows, agents: this.#agents, queued: this.#queued.length, composer: this.#composer, streaming: this.#streaming, input_tokens: this.#stats.inputTokens, context_tokens: this.#stats.contextTokens, context_window: this.#stats.contextWindow, cost_cents: this.#stats.costCents, elapsed_ms: Date.now() - this.#started, ...(this.#retry === undefined ? {} : { retry: this.#retry }) });
      process.stdout.write(response);
    });
    return this.#renderTail;
  }
}

class InProcessAcpClient {
  readonly #daemon: AcpDaemon;
  readonly #pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
  readonly #listeners = new Set<(method: string, params: unknown) => void>();
  #sequence = 0;
  private constructor(daemon: AcpDaemon) { this.#daemon = daemon; }
  static async connect(daemon: AcpDaemon): Promise<InProcessAcpClient> { const client = new InProcessAcpClient(daemon); await client.request("initialize", {}); return client; }
  onNotification(listener: (method: string, params: unknown) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async request(method: string, params?: unknown): Promise<unknown> { const id = ++this.#sequence; const deferred = Promise.withResolvers<unknown>(); this.#pending.set(id, deferred); await this.#daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }), { write: (data) => this.receive(data) }); return deferred.promise; }
  private receive(data: string | Uint8Array): void { const text = typeof data === "string" ? data : new TextDecoder().decode(data); for (const line of text.trim().split("\n").filter(Boolean)) { const message = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } }; if (typeof message.method === "string") { for (const listener of this.#listeners) listener(message.method, message.params); continue; } if (typeof message.id !== "number") continue; const deferred = this.#pending.get(message.id); if (!deferred) continue; this.#pending.delete(message.id); if (message.error) deferred.reject(new Error(typeof message.error.message === "string" ? message.error.message : "ACP request failed.")); else deferred.resolve(message.result); } }
}

class TuiBridge {
  readonly #process: Bun.Subprocess<"pipe", "pipe", "inherit">;
  readonly #pending: Array<ReturnType<typeof Promise.withResolvers<string>>> = [];
  readonly #reader: Promise<void>;
  #buffer = "";
  private constructor(process: Bun.Subprocess<"pipe", "pipe", "inherit">) { this.#process = process; this.#reader = this.read(); }
  static async start(): Promise<TuiBridge> {
    const name = process.platform === "win32" ? "lyra-tui.exe" : "lyra-tui";
    const sibling = join(dirname(realpathSync(process.execPath)), name);
    const source = join(import.meta.dir, "../../lyra-tui", "native", `${process.platform}-${process.arch}`, name);
    const candidates = process.env.LYRA_TUI_BIN ? [resolve(process.env.LYRA_TUI_BIN)] : [sibling, source];
    const binary = await firstAccessible(candidates);
    if (!binary) throw new Error(`Native Flywheel TUI is unavailable for ${process.platform}-${process.arch}. Reinstall Lyra with the matching platform bundle.`);
    const child = Bun.spawn([binary], { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    return new TuiBridge(child);
  }
  async render(frame: FrameRequest): Promise<string> { const deferred = Promise.withResolvers<string>(); this.#pending.push(deferred); await this.#process.stdin.write(`${JSON.stringify(frame)}\n`); return deferred.promise; }
  async close(): Promise<void> { this.#process.stdin.end(); await this.#reader; }
  private async read(): Promise<void> { for await (const chunk of this.#process.stdout) { this.#buffer += new TextDecoder().decode(chunk); let newline = this.#buffer.indexOf("\n"); while (newline >= 0) { const line = this.#buffer.slice(0, newline); this.#buffer = this.#buffer.slice(newline + 1); newline = this.#buffer.indexOf("\n"); if (!line) continue; const deferred = this.#pending.shift(); if (!deferred) continue; try { const response = JSON.parse(line) as { ansi?: unknown; error?: unknown }; if (typeof response.ansi === "string") deferred.resolve(response.ansi); else deferred.reject(new Error(String(response.error ?? "Invalid TUI response."))); } catch (error) { deferred.reject(error); } } } for (const deferred of this.#pending.splice(0)) deferred.reject(new Error("Flywheel TUI exited before rendering.")); }
}

function parseArgs(args: string[]): CliOptions { const parsed: CliOptions = { origin: process.cwd(), acp: false, help: false, allowAutoGit: false }; for (let index = 0; index < args.length; index += 1) { const arg = args[index]!; if (arg === "--help" || arg === "-h") parsed.help = true; else if (arg === "--acp") parsed.acp = true; else if (arg === "--yes-auto-git") parsed.allowAutoGit = true; else if (arg === "--origin" || arg === "--session" || arg === "--model" || arg === "--prompt") { const value = args[++index]; if (!value) throw new Error(`${arg} requires a value.`); if (arg === "--origin") parsed.origin = resolve(value); else if (arg === "--session") parsed.session = value; else if (arg === "--model") parsed.model = value; else parsed.prompt = value; } else throw new Error(`Unknown argument ${arg}. Use --help.`); } return parsed; }
function assistantText(result: AgentTurnResult): string { return result.assistant.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""); }
function extractAssistant(result: unknown): string { if (!result || typeof result !== "object" || !("assistant" in result)) return ""; const assistant = (result as { assistant?: { content?: Array<{ type?: string; text?: string }> } }).assistant; return assistant?.content?.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("") ?? ""; }
function formatOutput(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
async function branchName(origin: string): Promise<string> { try { const head = (await readFile(join(origin, ".git", "HEAD"), "utf8")).trim(); return head.startsWith("ref: refs/heads/") ? head.slice(16) : head.slice(0, 8); } catch { return "no-git"; } }
async function firstAccessible(paths: readonly string[]): Promise<string | undefined> { for (const path of paths) { try { await access(path); return path; } catch {} } return undefined; }
function helpText(): string { return `Lyra — autonomous coding agent\n\nUsage: lyra [--origin PATH] [--session NAME] [--model PROVIDER/MODEL] [--prompt TEXT] [--acp] [--yes-auto-git]\n\nFirst interactive launch opens provider setup in the TUI. Credentials may use the OS keychain, an existing environment variable, or explicitly chosen plaintext TOML.\n\nInteractive controls:\n  Enter       send or steer the active turn\n  Ctrl+Enter  queue a follow-up while streaming\n  Escape      cancel the active turn; exit when idle\n  Ctrl+C      cancel the active turn; exit when idle\n\nConfiguration: ~/.lyra/config.toml, ~/.lyra/providers.toml, and <origin>/.lyra/config.toml\n`; }

await main();
