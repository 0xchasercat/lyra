import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AgentLoop,
  Compactor,
  LoopDetector,
  ProviderSummaryGenerator,
  buildSystemPrompt,
  deriveContext,
  inspectContext,
  type AgentEvent,
  type AgentTurnResult,
} from "@lyra/core";
import { LspManager } from "@lyra/lsp";
import { discoverModels, resolveModelRole, resolveProvider, type ModelInfo } from "@lyra/provider";
import { TranscriptStore, type MessageEntry, type TranscriptEntry } from "@lyra/session";
import { LyraApplication, type SessionServices } from "./app.ts";
import { createAgentSpawnExecutor } from "./agent-executor.ts";
import { createConfiguredProvider, createEnvironmentProvider, type EnvironmentProvider } from "./provider.ts";
import { createIntegratedToolRegistry } from "./integrated-tools.ts";
import { parseLoopSpec, SoakRunner } from "./soak.ts";
import { runExternalAcpAgent } from "./external-acp.ts";
import { durationMs, loadConfig } from "./config.ts";
import { providerConfigPaths } from "./provider-setup.ts";
export interface LyraRuntimeOptions {
  origin?: string;
  session?: string;
  model?: string;
  environment?: EnvironmentProvider;
  home?: string;
  contextWindow?: number;
  confirmAuto?: () => boolean | Promise<boolean>;
  onReport?: (message: string) => void | Promise<void>;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export class LyraRuntime {
  readonly app: LyraApplication;
  readonly session: MainSession;
  private constructor(app: LyraApplication, session: MainSession) { this.app = app; this.session = session; }

  static async create(options: LyraRuntimeOptions = {}): Promise<LyraRuntime> {
    const origin = resolve(options.origin ?? process.cwd());
    const sessionName = validName(options.session ?? `session-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`);
    const runtimeConfig = await loadConfig(origin, options.home);
    let currentEnvironment = options.environment ?? await createEnvironmentProvider({ configPaths: providerConfigPaths(origin, options.home), maxAttempts: runtimeConfig.reliability.max_retries, streamStallTimeoutMs: durationMs(runtimeConfig.reliability.stream_stall_timeout), turnTimeoutMs: durationMs(runtimeConfig.reliability.turn_timeout), ...(options.model === undefined ? {} : { model: options.model }) });
    let app: LyraApplication | undefined;
    let main: MainSession | undefined;
    const emitEvent = async (event: AgentEvent): Promise<void> => { const stats = event.type === "usage" ? await main?.stats().catch(() => undefined) : undefined; if (app) await app.acp.notify("session/update", { event, ...(stats === undefined ? {} : { stats }) }).catch(() => undefined); await options.onEvent?.(event); };
    const services = deferredServices(() => main);
    const spawnExecutor = createAgentSpawnExecutor({
      provider: () => currentEnvironment.provider,
      resolveEnvironment: (reference) => { if (reference === undefined) return currentEnvironment; const resolved = resolveModelRole(reference, currentEnvironment.config.roles); const prefix = `${currentEnvironment.providerName}/`; if (resolved.startsWith(prefix)) return { provider: currentEnvironment.provider, model: resolved.slice(prefix.length) }; return { ...createConfiguredProvider(currentEnvironment.config, { model: resolved, maxAttempts: runtimeConfig.reliability.max_retries, streamStallTimeoutMs: durationMs(runtimeConfig.reliability.stream_stall_timeout), turnTimeoutMs: durationMs(runtimeConfig.reliability.turn_timeout) }), owned: true }; },
      tools: async (context) => {
        if (!app) throw new Error("Lyra application tools are not initialized.");
        const ownsLsp = context.workspace !== app.workspace.path && context.tools.includes("lsp");
        const lsp = ownsLsp ? await LspManager.create({ workspace: context.workspace }) : app.lsp;
        return createIntegratedToolRegistry({ lsp, ownLsp: ownsLsp, spawn: app.spawn, parent: { id: context.id, ...(context.parentId === undefined ? {} : { parentId: context.parentId }), depth: context.depth, workspace: context.workspace, ...(context.model === undefined ? {} : { model: context.model }), tools: context.tools }, allowedTools: context.tools, bus: app.bus, peer: context.id, skills: app.skills, runtime: app.runtime, mcp: app.mcpTool, filesystem: { root: context.workspace }, bash: { root: context.workspace, processHost: app.processes }, git: { root: context.workspace } });
      },
      externalAcp: async (command, request, context) => { if (!app) throw new Error("Lyra application is not initialized."); return runExternalAcpAgent(command, request, context, app.bus, app.workspace.name); },
      peerLifecycle: { register: (id, label) => { if (!app) throw new Error("Lyra IRC bus is not initialized."); app.bus.register(id, label === undefined ? {} : { label }); }, unregister: (id) => { app?.bus.unregister(id); } },
      origin,
      defaultModel: () => currentEnvironment.model,
      system: ({ workspace, session, tools }) => {
        if (!app) throw new Error("Lyra application capabilities are not initialized.");
        return systemPrompt(app, workspace, session, tools);
      },
      ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
      turnTimeoutMs: durationMs(runtimeConfig.reliability.turn_timeout),
      compactAt: runtimeConfig.reliability.compact_at,
    });
    app = await LyraApplication.boot({ origin, session: sessionName, spawnExecutor, sessions: services, confirmAuto: () => confirmAutoGit(origin, options.confirmAuto), onReport: async (message) => { main?.report(message); if (app) await app.acp.notify("session/update", { report: message }).catch(() => undefined); await options.onReport?.(message); }, ...(options.home === undefined ? {} : { home: options.home }) });
    main = await MainSession.create({ app, environment: currentEnvironment, sessionName, contextWindow: options.contextWindow ?? 200_000, onEvent: emitEvent, updateEnvironment: (next) => { currentEnvironment = next; } });
    return new LyraRuntime(app, main);
  }

  prompt(text: string, signal?: AbortSignal): Promise<AgentTurnResult> { return this.session.prompt(text, signal); }
  async command(command: string): Promise<unknown> { return this.app.slash(command); }
  slash(command: string): Promise<unknown> { return this.app.slash(command); }
  async close(): Promise<void> { await this.session.close(); await this.app.close(); await this.session.closeProvider(); }
}

interface MainSessionOptions {
  app: LyraApplication;
  environment: EnvironmentProvider;
  sessionName: string;
  contextWindow: number;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  updateEnvironment(environment: EnvironmentProvider): void;
}

export class MainSession {
  readonly app: LyraApplication;
  readonly contextWindow: number;
  readonly #onEvent: ((event: AgentEvent) => void | Promise<void>) | undefined;
  readonly #updateEnvironment: (environment: EnvironmentProvider) => void;
  readonly #sessionRoot: string;
  #environment: EnvironmentProvider;
  #store: TranscriptStore;
  readonly #toolCalls = new Map<string, number>();
  #models: ModelInfo[] = [];
  #inputTokens = 0;
  #outputTokens = 0;
  #costCents = 0;
  #lastTurnProgress = false;
  #lastTurnHardStop = false;
  #path: string;
  #loop: AgentLoop;
  #activeController: AbortController | undefined;
  #activeTurn: Promise<AgentTurnResult> | undefined;

  private constructor(options: MainSessionOptions, store: TranscriptStore, path: string, loop: AgentLoop) {
    this.app = options.app;
    this.contextWindow = options.contextWindow;
    this.#onEvent = options.onEvent;
    this.#updateEnvironment = options.updateEnvironment;
    this.#environment = options.environment;
    this.#store = store;
    this.#path = path;
    this.#loop = loop;
    this.#sessionRoot = resolve(this.app.workspaces.origin, ".lyra", "sessions");
  }

  get environment(): EnvironmentProvider { return this.#environment; }
  get descriptor() { return this.#store.descriptor; }

  static async create(options: MainSessionOptions): Promise<MainSession> {
    const sessionRoot = resolve(options.app.workspaces.origin, ".lyra", "sessions");
    await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
    const path = join(sessionRoot, `${validName(options.sessionName)}.jsonl`);
    let store: TranscriptStore;
    try { store = TranscriptStore.create({ path, name: options.sessionName, origin: options.app.workspaces.origin, workspace: options.app.workspace.path, provider: options.environment.providerName, model: options.environment.model }); }
    catch (error) { if (!(error instanceof Error && "code" in error && (error as { code?: unknown }).code === "EEXIST")) throw error; store = TranscriptStore.open(path); }
    const loop = createLoop(options.app, options.environment, store, options.contextWindow);
    const session = new MainSession(options, store, path, loop);
    void session.refreshModels(false).catch(() => undefined);
    return session;
  }

  prompt(text: string, signal?: AbortSignal): Promise<AgentTurnResult> {
    if (typeof text !== "string" || text.trim().length === 0) return Promise.reject(new TypeError("Prompt must be a non-empty string."));
    if (this.#activeTurn) return Promise.reject(new Error("A session turn is already running; steer or cancel it first."));
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    this.#activeController = controller;
    const turn = this.#runPrompt(text, controller.signal).finally(() => {
      signal?.removeEventListener("abort", forwardAbort);
      this.#activeController = undefined;
      this.#activeTurn = undefined;
    });
    this.#activeTurn = turn;
    return turn;
  }

  async steer(text: string): Promise<AgentTurnResult> {
    const active = this.#activeTurn;
    if (active) { this.#activeController?.abort(new DOMException("Turn steered by user", "AbortError")); await active; }
    return this.prompt(text);
  }

  cancel(): boolean {
    if (!this.#activeController) return false;
    this.#activeController.abort(new DOMException("Turn cancelled by user", "AbortError"));
    return true;
  }

  async newSession(name?: string): Promise<unknown> {
    await this.#waitForIdle();
    const sessionName = validName(name ?? `session-${Date.now()}`);
    const path = join(this.#sessionRoot, `${sessionName}.jsonl`);
    const store = TranscriptStore.create({ path, name: sessionName, origin: this.app.workspaces.origin, workspace: this.app.workspace.path, provider: this.#environment.providerName, model: this.#environment.model });
    this.#replaceStore(store, path);
    return store.descriptor;
  }

  async loadSession(name: string): Promise<unknown> {
    await this.#waitForIdle();
    const path = join(this.#sessionRoot, `${validName(name.replace(/\.jsonl$/, ""))}.jsonl`);
    const store = TranscriptStore.open(path);
    this.#replaceStore(store, path);
    return store.descriptor;
  }

  async fork(entryId?: string): Promise<unknown> {
    await this.#waitForIdle();
    const target = entryId ?? this.#store.head.id;
    const head = this.#store.fork(target);
    this.#loop = createLoop(this.app, this.#environment, this.#store, this.contextWindow);
    return { descriptor: this.#store.descriptor, head };
  }

  async listSessions(): Promise<unknown[]> {
    await mkdir(this.#sessionRoot, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.#sessionRoot)).filter((name) => name.endsWith(".jsonl")).sort();
    return names.map((name) => ({ name: name.slice(0, -6), path: join(this.#sessionRoot, name), active: join(this.#sessionRoot, name) === this.#path }));
  }
  report(message: string): void { this.#store.append({ type: "message", role: "user", content: [{ type: "text", text: `[report] ${message}` }], status: "complete" }); }
  async dump(): Promise<string> { const text = JSON.stringify(this.#store.entries(), null, 2); await copyToClipboard(text); return text; }

  async copy(target?: string): Promise<string> {
    const messages = this.#store.lineage().filter((entry): entry is MessageEntry => entry.type === "message" && entry.role === "assistant");
    const selected = target ? messages.find((entry) => entry.id === target) : messages.at(-1);
    if (!selected) throw new Error(target ? `Assistant entry ${target} was not found.` : "No assistant response is available to copy.");
    const text = selected.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
    await copyToClipboard(text);
    return text;
  }
  entries(): readonly TranscriptEntry[] { return this.#store.entries(); }

  async settings(args: readonly string[]): Promise<unknown> {
    if (args.length === 0) return { config: this.app.config, provider: this.#environment.providerName, model: this.#environment.model, gitMode: this.app.git.mode };
    if (args[0] === "git.mode" && args[1]) { await this.app.git.setMode(parseGitMode(args[1])); return { gitMode: this.app.git.mode }; }
    throw new Error("Runtime settings supports: /settings git.mode observe|stage|auto. Persistent settings belong in .lyra/config.toml.");
  }
  command(command: string): Promise<unknown> { return this.app.slash(command); }

  async provider(args: readonly string[]): Promise<unknown> {
    if (args.length === 0) return { current: this.#environment.providerName, available: Object.keys(this.#environment.config.providers).sort() };
    const name = args[0]!;
    const definition = this.#environment.config.providers[name];
    if (!definition) throw new Error(`Provider ${name} is not configured.`);
    const model = args[1] ?? definition.models?.[0];
    if (!model) throw new Error(`/provider ${name} also requires a model because that provider declares no models.`);
    return this.switchEnvironment(`${name}/${model}`);
  }

  async model(args: readonly string[]): Promise<unknown> {
    if (args.length === 0 || args[0] === "refresh") return { provider: this.#environment.providerName, current: this.#environment.model, models: await this.refreshModels(args[0] === "refresh"), roles: this.#environment.config.roles, refreshed: args[0] === "refresh" };
    return this.switchEnvironment(args[0]!);
  }

  async refreshModels(force: boolean): Promise<ModelInfo[]> { const definition = this.#environment.config.providers[this.#environment.providerName]!; this.#models = await discoverModels(resolveProvider(this.#environment.providerName, definition), { cacheDirectory: join(this.app.workspaces.origin, ".lyra", "providers"), force, manual: definition.models?.map((id) => ({ id })) ?? [] }); return this.#models; }
  async stats(): Promise<{ inputTokens: number; outputTokens: number; contextTokens: number; contextWindow: number; costCents: number }> { const inspection = await this.context() as { tokenEstimate: number }; return { inputTokens: this.#inputTokens, outputTokens: this.#outputTokens, contextTokens: inspection.tokenEstimate, contextWindow: this.contextWindow, costCents: Math.round(this.#costCents) }; }

  async context(): Promise<unknown> {
    const derived = deriveContext(this.#store.lineage(), { model: this.#environment.model, system: this.#loop.system, apiType: this.#environment.provider.transport.apiType, tools: this.#loop.definitions, contextWindow: this.contextWindow });
    return inspectContext(derived, this.contextWindow);
  }

  async compact(clear: boolean): Promise<unknown> {
    await this.#waitForIdle();
    if (clear) {
      const before = (await this.context()) as { tokenEstimate: number };
      const boundary = this.#store.append({ type: "boundary", kind: "clear", firstKeptEntry: null, summary: "Context cleared by user.", tokensBefore: before.tokenEstimate, tokensAfter: 0 });
      this.#loop = createLoop(this.app, this.#environment, this.#store, this.contextWindow);
      return boundary;
    }
    return this.#compactor().compact({ force: true });
  }

  async runLoop(specification: string): Promise<unknown> {
    const spec = parseLoopSpec(specification);
    const goal = spec.kind === "until" ? spec.condition : "Continue the current task autonomously. End a response with <loop-complete> only when no actionable work remains.";
    const runner = new SoakRunner({
      cycle: async (cycleGoal, _index, signal) => {
        const started = Date.now();
        const result = await this.prompt(cycleGoal, signal);
        const text = assistantText(result);
        return { done: this.#lastTurnHardStop || text.includes("<loop-complete>"), progress: this.#lastTurnProgress, latencyMs: Date.now() - started };
      },
      processCount: () => this.app.processes.list().filter((job) => job.status === "queued" || job.status === "running").length,
      workspaceLeakCount: async () => (await this.app.workspaces.list()).filter((workspace) => workspace.state === "active" && workspace.name !== this.app.workspace.name).length,
      metrics: this.app.metrics,
    });
    return runner.run(goal, spec);
  }

  async close(): Promise<void> { this.#activeController?.abort(new DOMException("Session closed", "AbortError")); await this.#activeTurn?.catch(() => undefined); this.#store.close(); }
  async closeProvider(): Promise<void> { await this.#environment.provider.transport.close?.(); }

  async #runPrompt(text: string, signal: AbortSignal): Promise<AgentTurnResult> {
    const started = Date.now();
    let terminal: AgentTurnResult;
    const toolStarts = new Map<string, { name: string; started: number; firstCall: boolean }>();
    this.#lastTurnProgress = false;
    this.#lastTurnHardStop = false;
    try {
      const iterator = this.#loop.runTurn(text, signal);
      while (true) {
        const next = await iterator.next();
        if (next.done) { terminal = next.value; break; }
        if (next.value.type === "usage") this.#recordUsage(next.value.usage);
        await this.#onEvent?.(next.value);
        if (next.value.type === "retry") await this.app.metrics.record({ type: "provider_retry", classification: next.value.reason });
        if (next.value.type === "context_repaired") await this.app.metrics.record({ type: "context_repair", count: next.value.repairs.length });
        if (next.value.type === "compacted") await this.app.metrics.record({ type: "compaction", tokensBefore: next.value.tokensBefore, tokensAfter: next.value.tokensAfter });
        if (next.value.type === "tool_started") { const calls = this.#toolCalls.get(next.value.name) ?? 0; this.#toolCalls.set(next.value.name, calls + 1); toolStarts.set(next.value.id, { name: next.value.name, started: Date.now(), firstCall: calls === 0 }); }
        if (next.value.type === "tool_finished") { const start = toolStarts.get(next.value.id); if (start) await this.app.metrics.record({ type: "tool", name: start.name, success: next.value.result.isError !== true, firstCall: start.firstCall, latencyMs: Date.now() - start.started }); const progress = next.value.result.progress; if ((progress?.filesModified?.length ?? 0) > 0 || (progress?.filesRead?.length ?? 0) > 0 || progress?.commandExitCode !== undefined) this.#lastTurnProgress = true; }
        if (next.value.type === "loop_warning" && next.value.hardStopRequested) this.#lastTurnHardStop = true;
      }
      await this.app.metrics.record({ type: "turn", latencyMs: Date.now() - started, success: terminal.stopReason !== "cancelled" });
      this.#lastTurnHardStop ||= terminal.hardStopRequested === true;
      return terminal;
    } catch (error) {
      await this.app.metrics.record({ type: "turn", latencyMs: Date.now() - started, success: false });
      throw error;
    }
  }

  async switchEnvironment(reference: string): Promise<unknown> {
    await this.#waitForIdle();
    await this.#waitForChildren();
    const previous = this.#environment;
    const next = createConfiguredProvider(previous.config, { model: reference, maxAttempts: this.app.config.reliability.max_retries, streamStallTimeoutMs: durationMs(this.app.config.reliability.stream_stall_timeout), turnTimeoutMs: durationMs(this.app.config.reliability.turn_timeout) });
    this.#store.append({ type: "provider_switch", provider: next.providerName, model: next.model, apiType: next.provider.transport.apiType, losses: [] });
    this.#environment = next;
    this.#updateEnvironment(next);
    this.#loop = createLoop(this.app, next, this.#store, this.contextWindow);
    await previous.provider.transport.close?.();
    return { provider: next.providerName, model: next.model };
  }

  #replaceStore(store: TranscriptStore, path: string): void { this.#store.close(); this.#store = store; this.#path = path; this.#loop = createLoop(this.app, this.#environment, store, this.contextWindow); }
  async #waitForIdle(): Promise<void> { if (this.#activeTurn) await this.#activeTurn; }
  #compactor(): Compactor { return new Compactor({ transcript: this.#store, summaryGenerator: new ProviderSummaryGenerator({ provider: this.#environment.provider, model: this.#environment.model }), contextWindow: this.contextWindow, threshold: this.app.config.reliability.compact_at }); }
  async #waitForChildren(): Promise<void> { const active = this.app.spawn.list().filter((handle) => handle.status === "queued" || handle.status === "running"); await Promise.all(active.map((handle) => this.app.spawn.wait(handle.id).catch(() => undefined))); }
  #recordUsage(usage: { inputTokens: number; outputTokens: number }): void { this.#inputTokens += usage.inputTokens; this.#outputTokens += usage.outputTokens; const model = this.#models.find((candidate) => candidate.id === this.#environment.model); this.#costCents += ((usage.inputTokens * (model?.inputPricePerMillion ?? 0)) + (usage.outputTokens * (model?.outputPricePerMillion ?? 0))) / 10_000; }
}

function createLoop(app: LyraApplication, environment: EnvironmentProvider, store: TranscriptStore, contextWindow: number): AgentLoop {
  return new AgentLoop({ provider: environment.provider, store, tools: app.tools, model: environment.model, system: systemPrompt(app, app.workspace.path, store.descriptor.name), contextWindow, workspace: app.workspace.path, turnTimeoutMs: durationMs(app.config.reliability.turn_timeout), compactor: new Compactor({ transcript: store, summaryGenerator: new ProviderSummaryGenerator({ provider: environment.provider, model: environment.model }), contextWindow, threshold: app.config.reliability.compact_at }), loopDetector: new LoopDetector() });
}

function systemPrompt(app: LyraApplication, workspace: string, session: string, definitions: readonly { name: string; description: string }[] = app.tools.definitions()): string {
  const mcpIndex = app.mcp.cachedIndex.map((tool) => `${tool.server}/${tool.name}`).join(", ");
  return buildSystemPrompt({ os: process.platform, arch: process.arch, workspace, origin: app.workspaces.origin, session, tools: definitions.map((definition) => ({ name: definition.name, description: definition.name === "mcp" && mcpIndex ? `Describe or call indexed MCP tools: ${mcpIndex}` : oneLine(definition.description) })), skills: app.skills.list().map((skill) => ({ name: skill.name, description: oneLine(skill.description) })) });
}

function deferredServices(current: () => MainSession | undefined): SessionServices {
  const get = (): MainSession => { const value = current(); if (!value) throw new Error("Lyra main session is not initialized."); return value; };
  const stringParam = (params: unknown, field: string): string => { if (typeof params === "string") return params; if (params && typeof params === "object" && field in params && typeof (params as Record<string, unknown>)[field] === "string") return (params as Record<string, string>)[field]!; throw new Error(`${field} is required.`); };
  const optionalParam = (params: unknown, field: string): string | undefined => params && typeof params === "object" && field in params && typeof (params as Record<string, unknown>)[field] === "string" ? (params as Record<string, string>)[field] : undefined;
  return {
    copy: (target) => get().copy(target), dump: async () => get().dump(), settings: (args) => get().settings(args), provider: (args) => get().provider(args), model: (args) => get().model(args), loop: (spec) => get().runLoop(spec), context: () => get().context(), compact: (clear) => get().compact(clear), sessions: (operation, value) => operation === "list" ? get().listSessions() : operation === "resume" ? get().loadSession(value ?? "") : get().fork(value),
    acp: {
      "session/command": (params) => get().command(stringParam(params, "command")),
      "session/new": (params) => get().newSession(optionalParam(params, "name")),
      "session/load": (params) => get().loadSession(stringParam(params, "name")),
      "session/prompt": (params, context) => get().prompt(stringParam(params, "prompt"), context.signal),
      "session/update": (params) => get().steer(stringParam(params, "prompt")),
      "session/cancel": () => ({ cancelled: get().cancel() }),
      "session/fork": (params) => get().fork(optionalParam(params, "entryId")),
      "context/inspect": () => get().context(),
    },
  };
}
async function copyToClipboard(text: string): Promise<void> { const command = process.platform === "darwin" ? "/usr/bin/pbcopy" : Bun.which("wl-copy") ?? Bun.which("xclip") ?? Bun.which("xsel"); if (!command) throw new Error("No clipboard command is available. Install wl-clipboard, xclip, or xsel."); const args = command.endsWith("xclip") ? [command, "-selection", "clipboard"] : command.endsWith("xsel") ? [command, "--clipboard", "--input"] : [command]; const child = Bun.spawn(args, { stdin: "pipe", stdout: "ignore", stderr: "pipe" }); child.stdin.write(text); child.stdin.end(); const stderr = new Response(child.stderr).text(); if (await child.exited !== 0) throw new Error(`Clipboard command failed: ${(await stderr).trim()}`); }

function assistantText(result: AgentTurnResult): string { return result.assistant.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""); }
function validName(value: string): string { if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new TypeError("Session name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens (max 64 characters)."); return value; }
function oneLine(value: string): string { return value.replace(/\s+/g, " ").trim().slice(0, 180); }
function parseGitMode(value: string): "observe" | "stage" | "auto" { if (value !== "observe" && value !== "stage" && value !== "auto") throw new Error("git.mode must be observe, stage, or auto."); return value; }

async function confirmAutoGit(origin: string, confirm?: () => boolean | Promise<boolean>): Promise<boolean> { const path = join(origin, ".lyra", "auto-git-consent.json"); try { const value = JSON.parse(await readFile(path, "utf8")) as { approved?: unknown }; if (value.approved === true) return true; } catch (error) { if (!(error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error; } if (!confirm || !await confirm()) return false; await mkdir(join(origin, ".lyra"), { recursive: true, mode: 0o700 }); await writeFile(path, `${JSON.stringify({ approved: true, recordedAt: new Date().toISOString() })}\n`, { mode: 0o600 }); return true; }