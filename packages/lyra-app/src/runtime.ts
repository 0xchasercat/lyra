import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AgentLoop,
  Compactor,
  LoopDetector,
  ProviderSummaryGenerator,
  SPAWN_LIFECYCLE_CHANNEL,
  SPAWN_TERMINAL_STATES,
  SteerQueue,
  buildSystemPrompt,
  deriveContext,
  inspectContext,
  renderHubAside,
  type AgentEvent,
  type AgentTurnResult,
  type SpawnLifecycleEvent,
} from "@lyra/core";
import {
  SessionUpdateEncoder,
  type AcpCompletionResult,
  type SessionUpdate,
  type TurnSource,
  type TurnStatus,
  type UsageContext,
  type WireError,
} from "@lyra/acp";
import { LspManager } from "@lyra/lsp";
import { discoverModels, loadProviderConfig, mergeModelLists, resolveModelRole, resolveProvider, type ModelInfo, type ProviderUsage } from "@lyra/provider";
import { TranscriptStore, type MessageEntry, type TranscriptEntry } from "@lyra/session";
import { CheckpointStore } from "@lyra/git";
import { createCheckpointAccess, LyraApplication, type SessionServices } from "./app.ts";
import { SessionCheckpointer } from "./checkpoints.ts";
import { createAgentSpawnExecutor } from "./agent-executor.ts";
import { assertProviderUsable, createConfiguredProvider, createEnvironmentProvider, createUnconfiguredEnvironment, describeProviderFailure, NO_PROVIDER_MESSAGE, type EnvironmentProvider } from "./provider.ts";
import { createIntegratedToolRegistry } from "./integrated-tools.ts";
import { parseLoopSpec, SoakRunner } from "./soak.ts";
import { WorkspaceFileIndex } from "./completion.ts";
import { runExternalAcpAgent } from "./external-acp.ts";
import { durationMs, loadConfig } from "./config.ts";
import { detectProviderApis, needsProviderSetup, providerAddInput, providerConfigPaths, providerSetupOptions, removeProviderCredential, removeProviderSetup, saveProviderModel, saveProviderSetup, verifyProviderSetup } from "./provider-setup.ts";
import type { AcpAddModelParams, AcpAddModelResult, AcpAddProviderParams, AcpAddProviderResult, AcpDetectProviderParams, AcpDetectProviderResult, AcpGetProviderParams, AcpGetProviderResult, AcpModelsResult, AcpProviderModels, AcpProviderSetupOptions, AcpRemoveProviderParams, AcpRemoveProviderResult, AcpVerifyProviderParams, AcpVerifyProviderResult } from "@lyra/acp";
import type { AuthConfig } from "@lyra/provider";

/**
 * How long one provider's model discovery is given inside a listing.
 *
 * `session/models` spans every configured provider, so a single endpoint that accepts a
 * connection and then says nothing must cost that provider its discovered rows and nothing
 * else. The listing runs them concurrently, so this is the whole call's worst case.
 */
export const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
export interface LyraRuntimeOptions {
  origin?: string;
  session?: string;
  model?: string;
  environment?: EnvironmentProvider;
  home?: string;
  contextWindow?: number;
  onReport?: (message: string) => void | Promise<void>;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  onUpdate?: (update: SessionUpdate) => void;
}

export class LyraRuntime {
  readonly app: LyraApplication;
  readonly session: MainSession;
  private constructor(app: LyraApplication, session: MainSession) { this.app = app; this.session = session; }

  static async create(options: LyraRuntimeOptions = {}): Promise<LyraRuntime> {
    const origin = resolve(options.origin ?? process.cwd());
    const sessionName = validName(options.session ?? `session-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`);
    const runtimeConfig = await loadConfig(origin, options.home);
    let app: LyraApplication | undefined;
    let main: MainSession | undefined;
    // A provider notice is not an error and has no turn to belong to: it is the transport
    // saying that the URL it works against is not the URL the configuration describes. It is
    // A first run has nothing to select a model with, and refusing to boot is what left the
    // TUI with no way in (DESIGN.md §6.6). The daemon comes up unconfigured instead: the
    // session, the tools and every ACP method that is not about models are real, a prompt
    // answers with an actionable error, and `provider/add` is the way out of it. Other
    // configuration failures — unreadable TOML, a role pointing at a provider that is not
    // there — still throw, because those name something to fix rather than something to set up.
    let currentEnvironment = options.environment
      ?? (await needsProviderSetup(origin, options.model, options.home)
        ? createUnconfiguredEnvironment(await loadProviderConfig(providerConfigPaths(origin, options.home)))
        : await createEnvironmentProvider({ configPaths: providerConfigPaths(origin, options.home), maxAttempts: runtimeConfig.reliability.max_retries, streamStallTimeoutMs: durationMs(runtimeConfig.reliability.stream_stall_timeout), turnTimeoutMs: durationMs(runtimeConfig.reliability.turn_timeout), ...(options.model === undefined ? {} : { model: options.model }), ...(options.home === undefined ? {} : { home: options.home }) }));
    // Notifications are fire-and-forget. The daemon serializes its writes on an internal
    // tail, so frame order is preserved without the agent loop ever awaiting a socket —
    // a slow or wedged client must not be able to stall a turn.
    const emitUpdate = (update: SessionUpdate): void => {
      if (!app) return;
      const sessionId = main?.descriptor.sessionId ?? sessionName;
      void app.acp.notify("session/update", { sessionId, update }).catch(() => undefined);
      options.onUpdate?.(update);
    };
    // In-process observation only. Everything that reaches a connected client goes out as a
    // canonical `{sessionId, update}` frame through `emitUpdate`; there is no second,
    // raw-event shape on the wire any more.
    const emitEvent = async (event: AgentEvent): Promise<void> => { await options.onEvent?.(event); };
    const services = deferredServices(() => main);
    const spawnExecutor = createAgentSpawnExecutor({
      provider: () => currentEnvironment.provider,
      // A child's model is resolved against the configuration *as it stands now*, across every
      // provider in it — not against the one the parent happens to be using. `currentEnvironment`
      // is replaced whenever the configuration is re-read, so a provider added mid-session with
      // `provider/add` is spawnable in the very next turn.
      //
      // A bare id is read against the provider the session is on, which is the same rule
      // `/model` follows. It used to fall through to `createConfiguredProvider`, which maps a
      // bare id against `[roles].default` — so after switching the session to another provider,
      // `spawn(model: "some-id")` silently resolved to a *third* provider's namespace.
      resolveEnvironment: (reference) => {
        if (reference === undefined) return currentEnvironment;
        let resolved = resolveModelRole(reference, currentEnvironment.config.roles);
        if (!resolved.includes("/") && currentEnvironment.providerName.length > 0) resolved = `${currentEnvironment.providerName}/${resolved}`;
        const prefix = `${currentEnvironment.providerName}/`;
        // The parent's own client is reused only for the parent's own provider: sharing a
        // transport across providers would send one provider's request to another's endpoint.
        if (currentEnvironment.unconfigured === undefined && resolved.startsWith(prefix)) return { provider: currentEnvironment.provider, model: resolved.slice(prefix.length) };
        return { ...createConfiguredProvider(currentEnvironment.config, { model: resolved, maxAttempts: runtimeConfig.reliability.max_retries, streamStallTimeoutMs: durationMs(runtimeConfig.reliability.stream_stall_timeout), turnTimeoutMs: durationMs(runtimeConfig.reliability.turn_timeout), ...(options.home === undefined ? {} : { home: options.home }) }), owned: true };
      },
      // A child without `isolated` runs in the parent's directory — which is now the launch
      // directory itself — and shares its checkpoint stream. A child with its own workspace
      // gets a store rooted there, so its undo history lives beside its work and survives
      // the parent session that spawned it.
      checkpoints: async (context) => {
        const live = app;
        if (!live) return undefined;
        if (resolve(context.workspace) === live.cwd) return { checkpointer: live.checkpointer(), access: createCheckpointAccess(live.checkpoints, () => live.checkpointer()) };
        const store = await CheckpointStore.open({ root: context.workspace, onWarning: (message) => context.report(message) });
        const checkpointer = new SessionCheckpointer({ store });
        return { checkpointer, access: createCheckpointAccess(store, () => checkpointer), close: () => store.close() };
      },
      tools: async (context, checkpoints) => {
        if (!app) throw new Error("Lyra application tools are not initialized.");
        const live = app;
        const ownsLsp = context.workspace !== live.cwd && context.tools.includes("lsp");
        const lsp = ownsLsp ? await LspManager.create({ workspace: context.workspace }) : live.lsp;
        // The registry refuses a child that asked for tools this session does not have, and
        // the language server started for it a line ago would otherwise be a leaked child
        // process per rejected spawn.
        try {
          return createIntegratedToolRegistry({
            lsp, ownLsp: ownsLsp, spawn: live.spawn,
            // The child's own identity, so a grandchild it spawns inherits the right depth
            // and knows whose peer name to answer to.
            parent: { id: context.id, peer: context.peer, ...(context.parentId === undefined ? {} : { parentId: context.parentId }), depth: context.depth, workspace: context.workspace, ...(context.model === undefined ? {} : { model: context.model }), tools: context.tools },
            allowedTools: context.tools, bus: live.bus, peer: context.peer,
            agents: { status: (name) => live.spawn.status(name) },
            skills: live.skills, runtime: live.runtime, mcp: live.mcpTool,
            ...(checkpoints === undefined ? {} : { checkpoints }),
            ...(context.writeScope === undefined ? {} : { writeScope: context.writeScope, writeScopeRoot: context.workspace, onScopeViolation: (path: string) => context.activity({ scopeViolation: path }) }),
            filesystem: { root: context.workspace }, bash: { root: context.workspace, processHost: live.processes }, git: { root: context.workspace },
          });
        } catch (error) {
          if (ownsLsp) await lsp.close().catch(() => undefined);
          throw error;
        }
      },
      externalAcp: async (command, request, context) => { if (!app) throw new Error("Lyra application is not initialized."); return runExternalAcpAgent(command, request, context, app.bus, app.sessionName); },
      // A message addressed to a *running* child is folded into its next turn as a marked
      // aside (§9). It stays in the inbox too, so `hub inbox` still reads it explicitly and
      // `consume` is what stops the same sentence arriving twice.
      asides: (context, steering) => app?.bus.attach(context.peer, {
        deliver: (message) => { steering.aside({ from: message.from, ...(message.text === undefined ? {} : { text: message.text }), ...(message.data === undefined ? {} : { data: message.data }), messageId: message.id }); },
        consume: (ids) => { steering.consume(ids); },
      }),
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
    app = await LyraApplication.boot({
      origin,
      session: sessionName,
      spawnExecutor,
      sessions: services,
      onReport: async (message) => {
        main?.report(message);
        emitUpdate({ sessionUpdate: "report", message });
        await options.onReport?.(message);
      },
      ...(options.home === undefined ? {} : { home: options.home }),
    });
    attachAgentLifecycle(app, emitUpdate);
    main = await MainSession.create({
      app,
      environment: currentEnvironment,
      sessionName,
      contextWindow: options.contextWindow ?? 200_000,
      contextWindowVerified: options.contextWindow !== undefined,
      onEvent: emitEvent,
      onUpdate: emitUpdate,
      updateEnvironment: (next) => { currentEnvironment = next; },
      // Only a configuration this call read is a configuration this session may re-read.
      ...(options.environment === undefined ? { configPaths: providerConfigPaths(origin, options.home) } : {}),
      ...(options.home === undefined ? {} : { home: options.home }),
    });
    return new LyraRuntime(app, main);
  }

  prompt(text: string, signal?: AbortSignal): Promise<AgentTurnResult> { return this.session.prompt(text, signal); }
  steer(text: string): Promise<SteerDelivery> { return this.session.steer(text); }
  async command(command: string): Promise<unknown> { return this.app.slash(command); }
  slash(command: string): Promise<unknown> { return this.app.slash(command); }
  async close(): Promise<void> { await this.session.close(); await this.app.close(); await this.session.closeProvider(); }
}

interface MainSessionOptions {
  app: LyraApplication;
  environment: EnvironmentProvider;
  sessionName: string;
  contextWindow: number;
  /**
   * True only when the caller supplied a real limit. A default is a guess, and a guessed
   * limit is never put on the wire — the client renders nothing instead of a wrong number.
   */
  contextWindowVerified?: boolean;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  onUpdate?: (update: SessionUpdate) => void;
  updateEnvironment(environment: EnvironmentProvider): void;
  /** Where `providers.toml` lives, so `provider/add` writes and re-reads the same file. */
  home?: string;
  /**
   * The files the live configuration was read from, when it was read from files.
   *
   * Absent when the caller supplied an environment of its own: that configuration exists only
   * in memory, and re-reading the disk would replace it with something the caller never asked
   * for. `provider/add` still works in that case — it merges what it wrote (see `addProvider`)
   * rather than adopting the whole file.
   */
  configPaths?: readonly string[];
}

/** Result of `session/steer`: whether the text joined a running turn or started one. */
export interface SteerDelivery {
  delivery: "steered" | "prompted";
  pending: number;
}

export interface CancelOutcome {
  cancelled: boolean;
  promptTrimmed?: boolean;
}

export class MainSession {
  readonly app: LyraApplication;
  readonly contextWindow: number;
  readonly #onEvent: ((event: AgentEvent) => void | Promise<void>) | undefined;
  readonly #onUpdate: ((update: SessionUpdate) => void) | undefined;
  readonly #updateEnvironment: (environment: EnvironmentProvider) => void;
  readonly #sessionRoot: string;
  readonly #contextWindowVerified: boolean;
  readonly #home: string | undefined;
  readonly #configPaths: readonly string[] | undefined;
  #environment: EnvironmentProvider;
  #store: TranscriptStore;
  readonly #toolCalls = new Map<string, number>();
  #models: ModelInfo[] = [];
  #inputTokens = 0;
  #outputTokens = 0;
  #costMicroUsd = 0;
  #costKnown = false;
  #contextTokens: number | undefined;
  #lastTurnProgress = false;
  #lastTurnHardStop = false;
  #path: string;
  #loop: AgentLoop;
  #encoder: SessionUpdateEncoder;
  #activeController: AbortController | undefined;
  #activeTurn: Promise<AgentTurnResult> | undefined;
  #steering: SteerQueue | undefined;
  #rewindOnCancel = false;

  private constructor(options: MainSessionOptions, store: TranscriptStore, path: string, loop: AgentLoop) {
    this.app = options.app;
    this.contextWindow = options.contextWindow;
    this.#contextWindowVerified = options.contextWindowVerified === true;
    this.#onEvent = options.onEvent;
    this.#onUpdate = options.onUpdate;
    this.#updateEnvironment = options.updateEnvironment;
    this.#home = options.home;
    this.#configPaths = options.configPaths;
    this.#environment = options.environment;
    this.#store = store;
    this.#path = path;
    this.#loop = loop;
    this.#sessionRoot = resolve(this.app.origin, ".lyra", "sessions");
    this.#encoder = new SessionUpdateEncoder({ sessionId: store.descriptor.sessionId, usage: () => this.usageContext() });
  }

  get environment(): EnvironmentProvider { return this.#environment; }
  get descriptor() { return this.#store.descriptor; }

  static async create(options: MainSessionOptions): Promise<MainSession> {
    const sessionRoot = resolve(options.app.origin, ".lyra", "sessions");
    await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
    const path = join(sessionRoot, `${validName(options.sessionName)}.jsonl`);
    let store: TranscriptStore;
    try { store = TranscriptStore.create({ path, name: options.sessionName, origin: options.app.origin, workspace: options.app.cwd, provider: options.environment.providerName, model: options.environment.model }); }
    catch (error) { if (!(error instanceof Error && "code" in error && (error as { code?: unknown }).code === "EEXIST")) throw error; store = TranscriptStore.open(path); }
    const loop = createLoop(options.app, options.environment, store, options.contextWindow);
    const session = new MainSession(options, store, path, loop);
    void session.refreshModels(false).catch(() => undefined);
    return session;
  }

  /** Why there is no provider, when there is none. Used to refuse a turn before it opens one. */
  get unconfigured(): string | undefined { return this.#environment.unconfigured; }

  prompt(text: string, signal?: AbortSignal, source: TurnSource = "user"): Promise<AgentTurnResult> {
    if (typeof text !== "string" || text.trim().length === 0) return Promise.reject(new TypeError("Prompt must be a non-empty string."));
    // Refused *before* a turn opens, so an unconfigured daemon never emits a turn_start it
    // cannot close and a client is never left with a spinner for a turn that cannot exist.
    if (this.#environment.unconfigured !== undefined) return Promise.reject(new Error(this.#environment.unconfigured));
    if (this.#activeTurn) return Promise.reject(new Error("A session turn is already running; steer or cancel it first."));
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    this.#activeController = controller;
    const turn = this.#runPrompt(text, controller.signal, source).finally(() => {
      signal?.removeEventListener("abort", forwardAbort);
      this.#activeController = undefined;
      this.#activeTurn = undefined;
      this.#steering = undefined;
      this.#rewindOnCancel = false;
    });
    this.#activeTurn = turn;
    return turn;
  }

  /**
   * Steering (DESIGN §0.2). Text sent while a turn runs is *not* a cancel-and-resend: it
   * is queued into the live turn and delivered at the next tool boundary as a standalone
   * synthetic user message. A blocked wait-class tool is interrupted immediately so the
   * boundary arrives now rather than at the wait's deadline.
   */
  async steer(text: string): Promise<SteerDelivery> {
    if (typeof text !== "string" || text.trim().length === 0) throw new TypeError("Steering text must be a non-empty string.");
    const queue = this.#steering;
    if (this.#activeTurn !== undefined && queue !== undefined) return { delivery: "steered", pending: queue.push(text) };
    await this.prompt(text, undefined, "steer");
    return { delivery: "prompted", pending: 0 };
  }

  /**
   * Cancels the running turn. Partial output is always kept and marked. The prompt itself
   * is trimmed only when the turn produced nothing *and* the client states it has rewound
   * the text into its composer — otherwise a send-then-cancel leaves the prompt in both
   * places and the user sees it twice.
   */
  async cancel(options: { rewoundToComposer?: boolean } = {}): Promise<CancelOutcome> {
    const active = this.#activeTurn;
    if (!this.#activeController || active === undefined) return { cancelled: false };
    this.#rewindOnCancel = options.rewoundToComposer === true;
    this.#activeController.abort(new DOMException("Turn cancelled by user", "AbortError"));
    const result = await active.catch(() => undefined);
    return { cancelled: true, promptTrimmed: result === undefined ? false : this.#lastPromptTrimmed };
  }

  #lastPromptTrimmed = false;

  /** Hydration payload for a client attaching to a live session. */
  async snapshot(): Promise<Record<string, unknown>> {
    const usage = this.usageContext();
    const configured = this.#environment.unconfigured === undefined;
    return {
      descriptor: this.#store.descriptor,
      entries: this.#store.entries(),
      provider: this.#environment.providerName,
      model: this.#environment.model,
      // Omitted while unconfigured: the placeholder transport's protocol is an
      // implementation detail, and putting it on the wire would read as a real answer.
      ...(configured ? { apiType: this.#environment.provider.transport.apiType } : {}),
      providerConfigured: configured,
      workspace: this.app.cwd,
      turnActive: this.#activeTurn !== undefined,
      pendingSteer: this.#steering?.size ?? 0,
      // A client that attaches mid-session sees the children that already exist, so its
      // presence strip is populated by hydration rather than only by the next transition.
      agents: this.app.spawn.statusList(),
      usage: {
        session: {
          inputTokens: usage.sessionInputTokens,
          outputTokens: usage.sessionOutputTokens,
          ...(usage.costMicroUsd === undefined ? {} : { costMicroUsd: usage.costMicroUsd }),
        },
        ...(this.#contextTokens === undefined ? {} : { contextTokens: this.#contextTokens }),
        ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
      },
    };
  }

  /**
   * Raw cumulative measurements. Cost is present only with known model pricing and the
   * context limit only when verified: an absent number is a rendering instruction ("show
   * nothing"), which is strictly better than a confident wrong one.
   */
  usageContext(): UsageContext {
    const model = this.#models.find((candidate) => candidate.id === this.#environment.model);
    const contextWindow = model?.contextWindow ?? (this.#contextWindowVerified ? this.contextWindow : undefined);
    return {
      sessionInputTokens: this.#inputTokens,
      sessionOutputTokens: this.#outputTokens,
      ...(this.#costKnown ? { costMicroUsd: Math.round(this.#costMicroUsd) } : {}),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    };
  }

  async newSession(name?: string): Promise<unknown> {
    await this.#waitForIdle();
    const sessionName = validName(name ?? `session-${Date.now()}`);
    const path = join(this.#sessionRoot, `${sessionName}.jsonl`);
    const store = TranscriptStore.create({ path, name: sessionName, origin: this.app.origin, workspace: this.app.cwd, provider: this.#environment.providerName, model: this.#environment.model });
    this.#replaceStore(store, path, "new");
    return store.descriptor;
  }

  async loadSession(name: string): Promise<unknown> {
    await this.#waitForIdle();
    const path = join(this.#sessionRoot, `${validName(name.replace(/\.jsonl$/, ""))}.jsonl`);
    const store = TranscriptStore.open(path);
    this.#replaceStore(store, path, "load");
    return store.descriptor;
  }

  async fork(entryId?: string): Promise<unknown> {
    await this.#waitForIdle();
    const target = entryId ?? this.#store.head.id;
    const head = this.#store.fork(target);
    this.#loop = createLoop(this.app, this.#environment, this.#store, this.contextWindow);
    this.#contextTokens = undefined;
    this.#emit([{ sessionUpdate: "session_changed", descriptor: { ...this.#store.descriptor }, reason: "fork" }]);
    return { descriptor: this.#store.descriptor, head };
  }

  /**
   * Move the head back to an entry. Nothing is deleted: the transcript is a DAG on disk and
   * every entry stays in the file, so the turns after `entryId` simply stop being ancestors
   * of the head and stop being sent to the model.
   *
   * The machinery is `fork`'s — moving a head is moving a head — but the *intent* differs,
   * and the intent is what a client renders: a fork branches away from a conversation and a
   * rewind takes one back, so this reports `reason: "rewind"` and `fork` reports `"fork"`.
   *
   * With no `entryId` it rewinds to the entry the newest checkpoint is anchored to, which is
   * the boundary before the last state-changing thing that happened — the same anchor
   * `checkpoint/restore` would take the working directory back to. When no checkpoint carries
   * an anchor there is nothing to guess at, and the call says so rather than picking a turn.
   */
  async rewind(entryId?: string): Promise<unknown> {
    await this.#waitForIdle();
    const target = entryId ?? await this.#newestAnchor();
    if (target === undefined) throw new Error("No checkpoint anchors a transcript entry, so there is nothing to rewind to. Pass an entryId, or run /checkpoints to see what is recorded.");
    const before = this.#messagesInLineage();
    this.#store.fork(target);
    this.#loop = createLoop(this.app, this.#environment, this.#store, this.contextWindow);
    this.#contextTokens = undefined;
    this.#emit([{ sessionUpdate: "session_changed", descriptor: { ...this.#store.descriptor }, reason: "rewind" }]);
    return {
      descriptor: this.#store.descriptor,
      entryId: target,
      removedMessages: Math.max(0, before - this.#messagesInLineage()),
    };
  }

  /** The entry the newest checkpoint that anchors one points at. */
  async #newestAnchor(): Promise<string | undefined> {
    const records = await this.app.checkpoints.list({ limit: 100 }).catch(() => []);
    // The head's own anchor is not a rewind — it is where we already are.
    const head = this.#store.head.id;
    return records.map((record) => record.entryId).find((id) => id !== undefined && id !== head);
  }

  #messagesInLineage(): number {
    return this.#store.lineage().filter((entry) => entry.type === "message").length;
  }

  /**
   * Every transcript on disk, each with the `sessionId` that addresses it on the wire.
   * The name is a filename and the id is the identity every `session/update` frame is
   * tagged with; a client that only had the name could not correlate the two.
   *
   * A row also carries what a picker needs to tell one session from another: the first
   * prompt, when it was last written, and how many messages it holds. All three are
   * optional and independently absent — a transcript with no user message yet has no
   * first prompt, and a transcript too large for the scan budget below has no count.
   * Absent means "not measured", never zero, so a client renders nothing rather than a
   * wrong number (DESIGN.md §2, raw measurements).
   *
   * The cost is bounded twice: [`LISTING_SCAN_BYTES`] per file and
   * [`LISTING_SCAN_BUDGET`] across the whole listing. The active session costs no read
   * at all — its entries are already in memory. A file whose header will not parse
   * cannot be loaded either, so it is left out instead of listed as unusable.
   */
  async listSessions(): Promise<unknown[]> {
    await mkdir(this.#sessionRoot, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.#sessionRoot)).filter((name) => name.endsWith(".jsonl")).sort();
    const rows: SessionListing[] = [];
    let budget = LISTING_SCAN_BUDGET;
    for (const name of names) {
      const path = join(this.#sessionRoot, name);
      const active = path === this.#path;
      const file = Bun.file(path);
      const preview = active
        ? previewOfEntries(this.#store.entries())
        : await readPreview(file, Math.min(LISTING_SCAN_BYTES, budget));
      if (!active) budget = Math.max(0, budget - Math.min(file.size, LISTING_SCAN_BYTES));
      const sessionId = active ? this.#store.descriptor.sessionId : preview.sessionId;
      if (sessionId === undefined) continue;
      const updatedAtMs = Number.isFinite(file.lastModified) ? Math.trunc(file.lastModified) : undefined;
      rows.push({
        sessionId,
        name: name.slice(0, -6),
        path,
        active,
        ...(preview.firstPrompt === undefined ? {} : { firstPrompt: preview.firstPrompt }),
        ...(updatedAtMs === undefined || updatedAtMs < 0 ? {} : { updatedAtMs }),
        ...(preview.messages === undefined ? {} : { messages: preview.messages }),
      });
    }
    return rows;
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

  /**
   * `/settings` reads; nothing here writes any more.
   *
   * The one runtime-settable value used to be the Git mode, and there are no modes left —
   * integration is the model's job through the `git` tool. Everything else in the effective
   * configuration is declarative and belongs in `.lyra/config.toml`, where it survives a
   * restart, which is what anyone changing it actually wanted.
   */
  async settings(args: readonly string[]): Promise<unknown> {
    if (args.length === 0) return { config: this.app.config, provider: this.#environment.providerName, model: this.#environment.model, cwd: this.app.cwd, checkpoints: this.app.checkpoints.available ? "on" : (this.app.checkpoints.unavailable ?? "off") };
    throw new Error("/settings takes no arguments: it reports the effective configuration. Change a setting in .lyra/config.toml, or use /model and /provider for the ones that switch mid-session.");
  }
  command(command: string): Promise<unknown> { return this.app.slash(command); }

  /**
   * Ranked completion candidates for a composer popup (DESIGN §4). The ranking is final:
   * the daemon can see the whole candidate set, the gitignore state, and modification
   * times, and the client can see ten rows — a client that re-sorted would be sorting a
   * sample. An unimplemented kind is an error naming the kinds that do exist, rather than
   * an empty list a client would read as "no matches".
   */
  async complete(request: { sessionId: string; kind: string; query: string; limit?: number }): Promise<AcpCompletionResult> {
    if (request.sessionId !== this.descriptor.sessionId) throw new Error(`Session ${request.sessionId} is not the session this daemon is serving.`);
    if (request.kind !== "file") throw new Error(`Unsupported completion kind ${JSON.stringify(request.kind)}. This daemon completes: file.`);
    // Scoped to the session's workspace, which for a spawned agent is its own clone and
    // never the origin checkout: completion cannot offer a path the session cannot read.
    this.#files ??= new WorkspaceFileIndex(this.app.cwd);
    return this.#files.complete(request.query, request.limit);
  }
  #files: WorkspaceFileIndex | undefined;

  /**
   * `/provider`, `session/providers`, and `session/select_provider`.
   *
   * Both the listing and the selection start by re-reading the configuration, so the answer
   * describes the providers that exist *now* rather than the ones that existed at boot. That
   * is what makes `provider/add` visible in the same daemon, and it is the same thing that
   * makes a hand-edited `providers.toml` visible without a restart.
   */
  async provider(args: readonly string[]): Promise<unknown> {
    await this.reloadProviderConfig();
    const configured = Object.keys(this.#environment.config.providers).sort();
    if (args.length === 0) return { current: this.#environment.providerName, available: configured };
    const name = args[0]!;
    // `/provider edit` and `/provider delete` are the client's forms: editing is a filled-in
    // setup form (`provider/get` then `provider/add`) and deleting wants a confirmation, and
    // neither is expressible as a report. A daemon that fell through to the switch below would
    // answer them with `Provider "edit" is not configured`, which reads like a different bug.
    if (name === "edit" || name === "delete") {
      const target = args[1];
      return Promise.reject(new Error(`/provider ${name}${target === undefined ? "" : ` ${target}`} is handled by the client, not the daemon: it opens the ${name === "edit" ? "edit form (provider/get, then provider/add with persist \"keep\")" : "delete confirmation (provider/remove)"}. From a report-only client, ${name === "edit" ? `re-add the provider with /provider add` : `remove [providers.${target ?? "<name>"}] from ${this.#providersPath()}`}.`));
    }
    const definition = this.#environment.config.providers[name];
    if (!definition) throw new Error(`Provider "${name}" is not configured. Configured providers: ${configured.join(", ") || "none"}. Add it with /provider add, or declare [providers.${name}] in ${this.#providersPath()}.`);
    const model = args[1] ?? definition.models?.[0];
    if (!model) throw new Error(`Cannot select ${name}: it declares no models, so a model is required. Use "/provider ${name} <model>", or add models = ["<model>"] under [providers.${name}] in ${this.#providersPath()}.`);
    return this.switchEnvironment(`${name}/${model}`);
  }

  /** The file `provider/add` writes, named in the errors that ask a user to edit it. */
  #providersPath(): string { return providerConfigPaths(this.app.origin, this.#home)[1]!; }

  /**
   * `provider/setup_options` — the wizard's catalog. Answerable with nothing configured,
   * which is the only moment it matters.
   */
  setupOptions(): Promise<AcpProviderSetupOptions> {
    return providerSetupOptions(this.app.origin, this.#home === undefined ? {} : { home: this.#home });
  }

  /**
   * `provider/verify` — a bounded liveness probe against an endpoint that is not saved yet.
   * The credential it is given is used for one request and dropped; nothing about it is
   * kept, logged, or returned.
   */
  verifyProvider(params: AcpVerifyProviderParams, signal?: AbortSignal): Promise<AcpVerifyProviderResult> {
    return verifyProviderSetup(params, { origin: this.app.origin, ...(signal === undefined ? {} : { signal }) });
  }

  /**
   * `provider/add` — persist a provider, then re-read the configuration so the new one is
   * selectable without waiting for the next read.
   *
   * It deliberately does **not** switch to it. `session/select_provider` is the method that
   * switches, it already exists, and keeping the two apart means adding a provider you do not
   * want to use yet is expressible — and that a switch is announced by exactly one update.
   */
  async addProvider(params: AcpAddProviderParams, signal?: AbortSignal): Promise<AcpAddProviderResult> {
    const { input, warnings } = providerAddInput(params);
    const saved = await saveProviderSetup(input, { ...(this.#home === undefined ? {} : { home: this.#home }), ...(signal === undefined ? {} : { signal }) });
    // A session that reads its configuration from files adopts the file. A session that was
    // handed one adopts only what was just written into it, because everything else in that
    // configuration came from the caller and is not on disk to be re-read.
    if (this.#configPaths === undefined) {
      const written = await loadProviderConfig([saved.path]);
      const config = { providers: { ...this.#environment.config.providers, ...written.providers }, roles: { ...this.#environment.config.roles, ...written.roles } };
      this.#environment = { ...this.#environment, config };
      this.#updateEnvironment(this.#environment);
    } else await this.reloadProviderConfig();
    const all = [...warnings, ...saved.warnings ?? []];
    // Best-effort, and strictly after the provider is saved and live: a client that just added
    // a provider wants to know whether there is a catalogue to pick from, but an endpoint that
    // will not say must not turn a completed add into a failure.
    const modelsDiscovered = await this.#countModels(saved.provider);
    return {
      ok: true, provider: saved.provider, ...(saved.model === undefined ? {} : { model: saved.model }), auth: saved.auth, path: saved.path,
      ...(all.length === 0 ? {} : { warnings: all }),
      ...(modelsDiscovered === undefined ? {} : { modelsDiscovered }),
    };
  }

  /**
   * `provider/get` — one configured provider, read back for an edit form.
   *
   * The counterpart to `provider/add` being the update method too: a client that wants to
   * change a base URL has to be able to show what the base URL currently is, and everything
   * else the form holds, without asking the user to retype a provider they already configured.
   *
   * It answers with the credential's *address* and never its value. That is not only a secrecy
   * rule but the reason an edit form can be opened at all: reading a keychain entry would
   * prompt the OS for permission, for a value the form has no field for — `persist: "keep"`
   * exists precisely so the credential never has to be read to be preserved.
   */
  async getProvider(params: AcpGetProviderParams): Promise<AcpGetProviderResult> {
    if (!params || typeof params !== "object") throw new TypeError("provider/get requires parameters.");
    const name = String(params.provider ?? "").trim();
    // Added moments ago by `provider/add`, or hand-edited: the answer is about now.
    await this.reloadProviderConfig();
    const config = this.#environment.config;
    const definition = config.providers[name];
    if (definition === undefined) {
      const configured = Object.keys(config.providers).sort().join(", ") || "none";
      throw new Error(`Provider "${name}" is not configured, so there is nothing to read. Configured providers: ${configured}. Add it with "/provider add", or declare [providers.${name}] in ${this.#providersPath()}.`);
    }
    const detail = credentialAddress(definition.auth);
    return {
      provider: name,
      baseUrl: definition.base_url,
      apiType: definition.api_type,
      ...(definition.websocket === undefined ? {} : { websocket: definition.websocket }),
      authType: definition.auth.type,
      ...(detail === undefined ? {} : { authDetail: detail }),
      models: [...(definition.models ?? [])],
      inUse: this.#environment.unconfigured === undefined && this.#environment.providerName === name,
    };
  }

  /**
   * `provider/remove` — delete a provider's declaration, through the same non-destructive
   * merge that wrote it.
   *
   * Three things it refuses to do quietly. It will not remove the provider the session is
   * running on: the client switches first, because a session left with no provider can neither
   * prompt nor switch back, and "the delete worked, and now nothing does" is not a trade a user
   * agreed to. It will not touch a stored credential unless asked, because a key can back more
   * than one thing and deleting one is not undoable. And it will not repoint roles that named
   * the provider — it reports them instead, so `@default` keeps meaning what the user said it
   * meant, visibly broken rather than invisibly changed.
   */
  async removeProvider(params: AcpRemoveProviderParams, signal?: AbortSignal): Promise<AcpRemoveProviderResult> {
    if (!params || typeof params !== "object") throw new TypeError("provider/remove requires parameters.");
    const name = String(params.provider ?? "").trim();
    await this.reloadProviderConfig();
    const config = this.#environment.config;
    if (config.providers[name] === undefined) {
      const configured = Object.keys(config.providers).sort().join(", ") || "none";
      throw new Error(`Provider "${name}" is not configured, so there is nothing to remove. Configured providers: ${configured}.`);
    }
    if (this.#environment.unconfigured === undefined && this.#environment.providerName === name) {
      const others = Object.keys(config.providers).filter((other) => other !== name).sort();
      const move = others.length === 0
        ? `There is no other provider to switch to; add one with "/provider add" first.`
        : `Switch first with "/model ${others[0]}/<model>" (session/select_model), then remove it. Other configured providers: ${others.join(", ")}.`;
      throw new Error(`Cannot remove "${name}": it is the provider this session is running on. ${move}`);
    }
    const removed = await removeProviderSetup(name, { ...(this.#home === undefined ? {} : { home: this.#home }), ...(signal === undefined ? {} : { signal }) });
    // Strictly after the declaration is gone: a credential deleted for a provider that then
    // failed to be removed would leave a configured provider that can no longer authenticate.
    const credentialRemoved = params.removeCredential === true
      ? await removeProviderCredential(removed.auth, signal === undefined ? {} : { signal })
      : undefined;
    // Same rule the add path follows: a session reading files re-reads them, a session handed a
    // configuration has only the one entry to drop from the copy it was given.
    if (this.#configPaths === undefined) {
      const providers = { ...config.providers };
      delete providers[name];
      this.#environment = { ...this.#environment, config: { ...config, providers } };
      this.#updateEnvironment(this.#environment);
    } else await this.reloadProviderConfig();
    // A provider that another config file also declares survives its own deletion, and a
    // client told "removed" for a provider still in every listing would be right to distrust
    // the next answer too.
    if (this.#environment.config.providers[name] !== undefined) {
      const files = providerConfigPaths(this.app.origin, this.#home).join(", ");
      throw new Error(`[providers.${name}] was removed from ${removed.path}, but another configuration source still declares it, so the provider is still configured. Lyra reads, in order: ${files}, plus OPENAI_API_KEY and ANTHROPIC_API_KEY from the environment. Remove the declaration that remains.`);
    }
    return {
      ok: true,
      provider: name,
      path: removed.path,
      ...(credentialRemoved === undefined ? {} : { credentialRemoved }),
      ...(removed.danglingRoles.length === 0 ? {} : { danglingRoles: removed.danglingRoles }),
    };
  }

  /**
   * How many models a provider turned out to have, or `undefined` for "could not tell".
   *
   * The distinction is the whole point: absent means the endpoint had no `/models` route we
   * could reach, did not answer in time, or refused the credential — none of which is the same
   * as an endpoint that answered with an empty catalogue.
   */
  async #countModels(name: string): Promise<number | undefined> {
    const definition = this.#environment.config.providers[name];
    if (definition === undefined) return undefined;
    const declared = definition.models?.map((id) => ({ id })) ?? [];
    try {
      const discovered = await discoverModels(resolveProvider(name, definition), {
        cacheDirectory: join(this.app.origin, ".lyra", "providers"),
        force: true,
        manual: declared,
        signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
        headersTimeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
      });
      return mergeModelLists(discovered, declared).length;
    } catch { return undefined; }
  }

  /**
   * Re-read `providers.toml` into the live environment.
   *
   * The environment carries the parsed configuration, and everything that resolves a provider
   * resolves it from *that* copy — so a provider written to disk, by `provider/add` or by an
   * editor, does not exist as far as a selection is concerned until this runs.
   *
   * It replaces only the configuration (§13): the active provider, its client, the model, the
   * transcript and the agent loop are all untouched, so a reload is never a silent switch and
   * is safe while a turn is running. Only `switchEnvironment` re-derives, and only after the
   * turn it would have disturbed has finished.
   *
   * A session whose configuration was supplied rather than read has nothing to re-read, and
   * says so by doing nothing: adopting the disk would discard a caller's configuration.
   */
  async reloadProviderConfig(): Promise<void> {
    if (this.#configPaths === undefined) return;
    const config = await loadProviderConfig(this.#configPaths);
    this.#environment = { ...this.#environment, config };
    this.#updateEnvironment(this.#environment);
  }

  /**
   * `/model`, `session/models`, and `session/select_model` — the single surface for choosing
   * what answers the next turn.
   *
   * With no argument it lists; with a reference it switches, across providers, and then the
   * caller lists again. `add` is the third form, for endpoints that cannot list their own
   * models: it declares one rather than selecting it.
   */
  async model(args: readonly string[]): Promise<unknown> {
    if (args[0] === "add") {
      const provider = args[1];
      const model = args[2];
      if (provider === undefined || model === undefined) throw new Error('/model add declares a model for a provider whose endpoint cannot list its own. Usage: "/model add <provider> <id>".');
      if (args.length > 3) throw new Error(`/model add takes exactly a provider and one model id; got ${args.length - 1} arguments.`);
      return this.addModel({ provider, model });
    }
    if (args.length === 0 || args[0] === "refresh") return this.models(args[0] === "refresh");
    // A model reference may name another provider, and a role may point at one that was only
    // just written, so the same re-read the provider surface does applies here too.
    await this.reloadProviderConfig();
    let ref = args[0]!.trim();
    // Bare model id (no slash and not a role) → auto-map to current provider so
    // both "/model gpt-5.6-luna" and "/model openai/gpt-5.6-luna" work for human and agent.
    if (ref && !ref.includes("/") && !ref.startsWith("@")) ref = `${this.#environment.providerName}/${ref}`;
    return this.switchEnvironment(ref);
  }

  /**
   * Every configured provider's models, in one answer.
   *
   * The picker used to show the active provider's catalogue, which made switching provider a
   * separate step a user had to know to take first — and made a model that exists on another
   * configured provider invisible until they took it. `/model` switches provider and model
   * together now, so the listing it renders from spans providers too.
   *
   * Each provider is asked independently and with its own deadline: one endpoint that has gone
   * away costs that provider its discovered rows and leaves its declared ones, rather than
   * failing a call that is mostly about other providers. Discovery is never load-bearing here.
   */
  async models(refresh: boolean): Promise<AcpModelsResult> {
    // The set of providers is itself re-read, so a provider added by `provider/add`, by
    // `model/add`, or by an editor is in the listing without a restart.
    await this.reloadProviderConfig();
    const config = this.#environment.config;
    const rows = await Promise.all(Object.keys(config.providers).sort().map((name) => this.#providerModels(name, refresh)));
    // The active provider's catalogue is what pricing and context-window accounting read, so
    // a listing keeps it current as a side effect rather than needing a second round trip.
    const active = rows.find((row) => row.provider === this.#environment.providerName);
    if (active !== undefined && active.models.length > 0) this.#models = [...active.models];
    const configured = this.#environment.unconfigured === undefined && this.#environment.providerName.length > 0;
    return {
      // Absent, not empty, when nothing is configured: there is no model in use to name.
      ...(configured ? { current: `${this.#environment.providerName}/${this.#environment.model}` } : {}),
      providers: rows,
      roles: config.roles,
      refreshed: refresh,
    };
  }

  /**
   * One provider's models: what its endpoint lists, unioned with what it declares.
   *
   * A failure is an empty discovery, never a thrown error — the declared list is still true,
   * and a provider that answers nothing is more useful in the picker (with its declared
   * models, or with none) than a picker that refused to open.
   */
  async #providerModels(name: string, refresh: boolean): Promise<AcpProviderModels & { models: ModelInfo[] }> {
    const definition = this.#environment.config.providers[name];
    if (definition === undefined) return { provider: name, models: [] };
    const declared = definition.models?.map((id) => ({ id })) ?? [];
    try {
      const discovered = await discoverModels(resolveProvider(name, definition), {
        cacheDirectory: join(this.app.origin, ".lyra", "providers"),
        force: refresh,
        manual: declared,
        signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
        headersTimeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
      });
      return { provider: name, models: mergeModelLists(discovered, declared) };
    } catch {
      return { provider: name, models: mergeModelLists([], declared) };
    }
  }

  /** The active provider's catalogue, kept for pricing and context accounting. */
  async refreshModels(force: boolean): Promise<ModelInfo[]> {
    // Nothing to discover and nothing to be wrong about: an unconfigured daemon answers with
    // an empty catalogue so a model picker opens empty rather than failing to open.
    if (this.#environment.unconfigured !== undefined) { this.#models = []; return this.#models; }
    // The configuration is re-read while the session runs, so the active provider can be
    // edited out from under a picker. Its client keeps working — nothing here may crash
    // because the file changed.
    if (this.#environment.config.providers[this.#environment.providerName] === undefined) return this.#models;
    const row = await this.#providerModels(this.#environment.providerName, force);
    // An endpoint that answered nothing must not empty a catalogue that already had entries:
    // what we knew a moment ago is still the better answer than nothing at all.
    if (row.models.length > 0 || this.#models.length === 0) this.#models = row.models;
    return this.#models;
  }

  /**
   * `model/add` — declare a model for a provider whose endpoint cannot list its own.
   *
   * It is the counterpart to `provider/add` being pure addition: a provider can be configured
   * without Lyra ever learning what it can run, and before this the only way out was editing
   * TOML by hand. It declares; it never switches, and it never creates a provider.
   */
  async addModel(params: AcpAddModelParams, signal?: AbortSignal): Promise<AcpAddModelResult> {
    if (!params || typeof params !== "object") throw new TypeError("model/add requires parameters.");
    const provider = String(params.provider ?? "").trim();
    const model = String(params.model ?? "").trim();
    if (model.length === 0) throw new Error("model/add requires a model id.");
    // The provider may have been added moments ago by `provider/add`, or by an editor.
    await this.reloadProviderConfig();
    const config = this.#environment.config;
    const definition = config.providers[provider];
    if (definition === undefined) {
      const configured = Object.keys(config.providers).sort().join(", ") || "none";
      throw new Error(`Cannot declare "${model}": provider "${provider}" is not configured, so there is nothing to declare it for. Configured providers: ${configured}. Add the provider first with "/provider add", or declare [providers.${provider}] in ${this.#providersPath()}.`);
    }
    const saved = await saveProviderModel(provider, model, definition, { ...(this.#home === undefined ? {} : { home: this.#home }), ...(signal === undefined ? {} : { signal }) });
    // Same rule as `provider/add`: a session reading files re-reads them; a session handed a
    // configuration adopts only the one field that was just written into it.
    if (this.#configPaths === undefined) {
      const providers = { ...config.providers, [provider]: { ...definition, models: saved.models } };
      this.#environment = { ...this.#environment, config: { ...config, providers } };
      this.#updateEnvironment(this.#environment);
    } else await this.reloadProviderConfig();
    // A provider redeclared by a higher-precedence config file would swallow the write
    // silently, leaving a client told "saved" and a model that cannot be selected. Say so.
    if (this.#environment.config.providers[provider]?.models?.includes(saved.model) !== true) {
      const files = providerConfigPaths(this.app.origin, this.#home).join(", ");
      throw new Error(`"${saved.model}" was written to ${saved.path}, but [providers.${provider}] is redeclared by another configuration file and that declaration wins, so the model is still not selectable. Lyra reads, in order: ${files}. Add models = ["${saved.model}"] to the declaration that wins, or remove it.`);
    }
    return { ok: true, provider, model: saved.model };
  }

  /**
   * `provider/detect` — what an endpoint speaks, asked before anything is saved. Bounded,
   * side-effect free, and never fatal: an unreachable URL answers with an empty list.
   */
  detectProvider(params: AcpDetectProviderParams, signal?: AbortSignal): Promise<AcpDetectProviderResult> {
    return detectProviderApis(params, signal === undefined ? {} : { signal });
  }

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
      // Every workspace belongs to a child now; the main session has none, so an active one
      // outliving its child is unambiguously a leak.
      workspaceLeakCount: async () => (await this.app.workspaces.list().catch(() => [])).filter((workspace) => workspace.state === "active").length,
      metrics: this.app.metrics,
    });
    return runner.run(goal, spec);
  }

  async close(): Promise<void> { this.#activeController?.abort(new DOMException("Session closed", "AbortError")); await this.#activeTurn?.catch(() => undefined); this.#store.close(); }
  async closeProvider(): Promise<void> { await this.#environment.provider.transport.close?.(); }

  async #runPrompt(text: string, signal: AbortSignal, source: TurnSource): Promise<AgentTurnResult> {
    const started = Date.now();
    let terminal: AgentTurnResult;
    const toolStarts = new Map<string, { name: string; started: number; firstCall: boolean }>();
    const turnUsage: TurnUsageTotals = { calls: 0, inputTokens: 0, outputTokens: 0 };
    this.#lastTurnProgress = false;
    this.#lastTurnHardStop = false;
    this.#lastPromptTrimmed = false;
    const steering = new SteerQueue();
    this.#steering = steering;
    // The main session is a peer like any other: a child that answers a question lands in
    // this turn at its next tool boundary instead of waiting for someone to read an inbox.
    this.#emit(this.#encoder.beginTurn(source));
    // After the opening frame, so a client callback that throws cannot leave the sink
    // attached to a queue no turn will ever drain.
    const detachAsides = this.app.bus.attach(this.app.sessionName, {
      deliver: (message) => { steering.aside({ from: message.from, ...(message.text === undefined ? {} : { text: message.text }), ...(message.data === undefined ? {} : { data: message.data }), messageId: message.id }); },
      consume: (ids) => { steering.consume(ids); },
    });
    try {
      const iterator = this.#loop.runTurn(text, signal, { steering });
      while (true) {
        const next = await iterator.next();
        if (next.done) { terminal = next.value; break; }
        if (next.value.type === "usage") this.#recordUsage(next.value.usage, turnUsage);
        if (next.value.type === "context_measured") this.#contextTokens = next.value.tokenEstimate;
        this.#emit(this.#encoder.encode(next.value));
        await this.#onEvent?.(next.value);
        if (next.value.type === "retry") await this.app.metrics.record({ type: "provider_retry", classification: next.value.classification ?? next.value.reason });
        if (next.value.type === "context_repaired") await this.app.metrics.record({ type: "context_repair", count: next.value.repairs.length });
        if (next.value.type === "compacted") await this.app.metrics.record({ type: "compaction", tokensBefore: next.value.tokensBefore, tokensAfter: next.value.tokensAfter });
        if (next.value.type === "tool_started") { const calls = this.#toolCalls.get(next.value.name) ?? 0; this.#toolCalls.set(next.value.name, calls + 1); toolStarts.set(next.value.id, { name: next.value.name, started: Date.now(), firstCall: calls === 0 }); }
        if (next.value.type === "tool_finished") { const start = toolStarts.get(next.value.id); if (start) await this.app.metrics.record({ type: "tool", name: start.name, success: next.value.result.isError !== true, firstCall: start.firstCall, latencyMs: Date.now() - start.started }); const progress = next.value.result.progress; if ((progress?.filesModified?.length ?? 0) > 0 || (progress?.filesRead?.length ?? 0) > 0 || progress?.commandExitCode !== undefined) this.#lastTurnProgress = true; }
        if (next.value.type === "loop_warning" && next.value.hardStopRequested) this.#lastTurnHardStop = true;
      }
      // Recorded before the cancelled-prompt rewind below, so the tokens stay attached to
      // the branch that actually spent them: rewinding hides a prompt from the context, it
      // does not refund the calls the provider already billed.
      this.#appendTurnUsage(turnUsage);
      await this.app.metrics.record({ type: "turn", latencyMs: Date.now() - started, success: terminal.stopReason !== "cancelled" });
      this.#lastTurnHardStop ||= terminal.hardStopRequested === true;
      const partialRetained = retainedOutput(terminal);
      this.#lastPromptTrimmed = this.#trimCancelledPrompt(terminal, partialRetained);
      this.#emit(this.#encoder.endTurn({
        status: turnStatusOf(terminal.stopReason),
        stopReason: terminal.stopReason,
        partialRetained,
        ...(this.#lastPromptTrimmed ? { promptTrimmed: true } : {}),
        ...(terminal.hardStopRequested === true ? { hardStopRequested: true } : {}),
      }));
      return terminal;
    } catch (cause) {
      // A provider failure is reported by the endpoint, which knows nothing about which
      // configured provider is in front of it. The turn is the last place that still does, so
      // the name and the next move are attached here — the same sentence goes to the client's
      // `turn_end` and back as the request's error, and they must not disagree.
      const error = describeProviderFailure(this.#environment, cause);
      // A failed turn still spent whatever it spent. Recording that must never replace the
      // failure the caller is waiting for, so a transcript that cannot be written stays silent.
      try { this.#appendTurnUsage(turnUsage); } catch { /* the original error is the one worth raising */ }
      await this.app.metrics.record({ type: "turn", latencyMs: Date.now() - started, success: false });
      this.#emit(this.#encoder.endTurn({ status: "error", partialRetained: false, error: wireError(error) }));
      throw error;
    } finally {
      detachAsides();
    }
  }

  /**
   * The one case where history is rewritten: a cancelled turn that produced no output at
   * all, and only when the client has taken the prompt back into its composer. Anything
   * the model did produce stays in the transcript, marked.
   */
  #trimCancelledPrompt(terminal: AgentTurnResult, partialRetained: boolean): boolean {
    if (terminal.stopReason !== "cancelled" || !this.#rewindOnCancel || partialRetained) return false;
    const prompt = terminal.entries.find((entry) => entry.type === "message" && entry.role === "user");
    if (prompt === undefined || prompt.parentId === null) return false;
    this.#store.fork(prompt.parentId);
    this.#emit([{ sessionUpdate: "session_changed", descriptor: { ...this.#store.descriptor }, reason: "rewind" }]);
    return true;
  }

  #emit(updates: readonly SessionUpdate[]): void {
    if (this.#onUpdate === undefined) return;
    for (const update of updates) this.#onUpdate(update);
  }

  /**
   * Switch the session onto another provider/model, or fail without changing anything.
   *
   * The switch is validated before it is announced. `session/select_provider` used to report
   * success for any name the configuration contained and leave every other precondition — a
   * definition the transport accepts, a credential source that has a credential — to the next
   * prompt, so the client rendered a confirmation and the following turn failed. Nothing here
   * is written, emitted, or replaced until [`assertProviderUsable`] has agreed.
   */
  async switchEnvironment(reference: string): Promise<unknown> {
    await this.#waitForIdle();
    await this.#waitForChildren();
    let normalized = reference.trim();
    if (normalized && !normalized.includes("/") && !normalized.startsWith("@")) normalized = `${this.#environment.providerName}/${normalized}`;
    const previous = this.#environment;
    const next = createConfiguredProvider(previous.config, { model: normalized, maxAttempts: this.app.config.reliability.max_retries, streamStallTimeoutMs: durationMs(this.app.config.reliability.stream_stall_timeout), turnTimeoutMs: durationMs(this.app.config.reliability.turn_timeout), ...(this.#home === undefined ? {} : { home: this.#home }) });
    try {
      await assertProviderUsable(next.providerName, previous.config.providers[next.providerName]!, next.model, this.#home === undefined ? {} : { home: this.#home });
    } catch (error) {
      // The rejected client never served a turn and never will; it is closed here rather than
      // left holding whatever the transport opened when it was constructed.
      await next.provider.transport.close?.();
      throw error;
    }
    this.#store.append({ type: "provider_switch", provider: next.providerName, model: next.model, apiType: next.provider.transport.apiType, losses: [] });
    this.#environment = next;
    this.#updateEnvironment(next);
    this.#loop = createLoop(this.app, next, this.#store, this.contextWindow);
    this.#emit([{ sessionUpdate: "model_changed", provider: next.providerName, model: next.model, apiType: next.provider.transport.apiType }]);
    await previous.provider.transport.close?.();
    void this.refreshModels(false).catch(() => undefined);
    return { provider: next.providerName, model: next.model };
  }

  #replaceStore(store: TranscriptStore, path: string, reason: "new" | "load"): void {
    this.#store.close();
    this.#store = store;
    this.#path = path;
    this.#loop = createLoop(this.app, this.#environment, store, this.contextWindow);
    this.#contextTokens = undefined;
    this.#encoder = new SessionUpdateEncoder({ sessionId: store.descriptor.sessionId, usage: () => this.usageContext() });
    this.#emit([{ sessionUpdate: "session_changed", descriptor: { ...store.descriptor }, reason }]);
  }
  async #waitForIdle(): Promise<void> { if (this.#activeTurn) await this.#activeTurn; }
  #compactor(): Compactor { return new Compactor({ transcript: this.#store, summaryGenerator: new ProviderSummaryGenerator({ provider: this.#environment.provider, model: this.#environment.model }), contextWindow: this.contextWindow, threshold: this.app.config.reliability.compact_at }); }
  /** Every child that has not reached a terminal state, including the ones inside a tool call. */
  async #waitForChildren(): Promise<void> { const active = this.app.spawn.list().filter((handle) => !SPAWN_TERMINAL_STATES.includes(handle.status)); await Promise.all(active.map((handle) => this.app.spawn.wait(handle.id).catch(() => undefined))); }
  #recordUsage(usage: ProviderUsage, turn: TurnUsageTotals): void {
    this.#inputTokens += usage.inputTokens;
    this.#outputTokens += usage.outputTokens;
    turn.calls += 1;
    turn.inputTokens += usage.inputTokens;
    turn.outputTokens += usage.outputTokens;
    if (usage.cacheReadTokens !== undefined) turn.cacheReadTokens = (turn.cacheReadTokens ?? 0) + usage.cacheReadTokens;
    if (usage.cacheWriteTokens !== undefined) turn.cacheWriteTokens = (turn.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
    const model = this.#models.find((candidate) => candidate.id === this.#environment.model);
    // Pricing is either known for this model or it is not. When it is not, cost stays
    // absent from the wire rather than accumulating a silent zero that reads as "free".
    if (model?.inputPricePerMillion === undefined && model?.outputPricePerMillion === undefined) return;
    this.#costKnown = true;
    const micros = (usage.inputTokens * (model.inputPricePerMillion ?? 0)) + (usage.outputTokens * (model.outputPricePerMillion ?? 0));
    this.#costMicroUsd += micros;
    turn.costMicroUsd = (turn.costMicroUsd ?? 0) + micros;
  }

  /**
   * Persists what the turn cost. Without this the numbers exist only in this process,
   * so a finished session on disk can say what the agent did but not what it spent.
   * A turn the provider reported nothing for writes nothing: an all-zero entry would be
   * indistinguishable from a genuinely free turn.
   */
  #appendTurnUsage(turn: TurnUsageTotals): void {
    if (turn.calls === 0) return;
    this.#store.append({
      type: "usage",
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      ...(turn.cacheReadTokens === undefined ? {} : { cacheReadTokens: turn.cacheReadTokens }),
      ...(turn.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: turn.cacheWriteTokens }),
      ...(turn.costMicroUsd === undefined ? {} : { costMicroUsd: Math.round(turn.costMicroUsd) }),
    });
  }
}

/**
 * One turn's provider usage while it accumulates. The cache and cost fields start absent
 * and stay absent unless something reports them, so "not measured" survives the sum.
 */
interface TurnUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMicroUsd?: number;
}

/** One row of `session/list`. The three preview fields are independently optional. */
interface SessionListing {
  sessionId: string;
  name: string;
  path: string;
  active: boolean;
  firstPrompt?: string;
  updatedAtMs?: number;
  messages?: number;
}

/** What one transcript contributes to its listing row, before the row is assembled. */
interface SessionPreview {
  sessionId?: string;
  firstPrompt?: string;
  /** Absent when the scan was truncated: a partial count is worse than none. */
  messages?: number;
}

/**
 * How much of one transcript `session/list` may read for its preview. Session directories
 * are local JSONL, so a full read is cheap for every ordinary session; the cap is what
 * keeps one pathological multi-megabyte transcript from making a picker feel slow.
 */
const LISTING_SCAN_BYTES = 4 * 1024 * 1024;

/** The same bound across a whole listing, so a directory of large sessions is bounded too. */
const LISTING_SCAN_BUDGET = 64 * 1024 * 1024;

/** How much of the first prompt a listing row carries. */
const LISTING_PREVIEW_CHARS = 100;

/**
 * The preview for one transcript on disk. Reads the whole file when it fits in `budget`
 * — the message count is only honest if every line was seen — and otherwise reads a
 * prefix, which still finds the session header and the first prompt (both live in the
 * opening lines) and reports no count at all.
 */
async function readPreview(file: Bun.BunFile, budget: number): Promise<SessionPreview> {
  try {
    const complete = file.size <= budget;
    const text = complete ? await file.text() : await file.slice(0, Math.max(budget, 8192)).text();
    return previewOfLines(text.split("\n"), complete);
  } catch { return {}; }
}

/** The preview for the session already open: its entries are in memory, so nothing is read. */
function previewOfEntries(entries: readonly TranscriptEntry[]): SessionPreview {
  let firstPrompt: string | undefined;
  let messages = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    messages += 1;
    firstPrompt ??= promptPreview(entry);
  }
  return { ...(firstPrompt === undefined ? {} : { firstPrompt }), messages };
}

/**
 * Scan transcript lines for the header id, the first prompt and the message count. A line
 * that will not parse is skipped rather than fatal: the last line of a transcript killed
 * mid-write is a partial one, and a listing that threw on it would hide every session.
 */
function previewOfLines(lines: readonly string[], complete: boolean): SessionPreview {
  let sessionId: string | undefined;
  let firstPrompt: string | undefined;
  let messages = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type === "session") {
      sessionId ??= typeof record.sessionId === "string" && record.sessionId.length > 0 ? record.sessionId : undefined;
      continue;
    }
    if (record.type !== "message") continue;
    messages += 1;
    firstPrompt ??= promptPreview(record);
  }
  if (sessionId === undefined) return {};
  return {
    sessionId,
    ...(firstPrompt === undefined ? {} : { firstPrompt }),
    ...(complete ? { messages } : {}),
  };
}

/**
 * The one-line preview a user message contributes, or undefined when it contributes none.
 *
 * Only user prose counts: an assistant turn is not what a session is *about*, a
 * tool-result-only user message carries no prose, and a `[report]` line is an audit row
 * this runtime wrote itself. Newlines collapse because the preview is one row of a picker.
 */
function promptPreview(entry: Record<string, unknown> | MessageEntry): string | undefined {
  const record = entry as Record<string, unknown>;
  if (record.role !== "user" || !Array.isArray(record.content)) return undefined;
  const text = record.content
    .flatMap((block) => (block !== null && typeof block === "object" && (block as Record<string, unknown>).type === "text"
      ? [String((block as { text?: unknown }).text ?? "")]
      : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0 || text.startsWith("[report] ")) return undefined;
  if (text.length <= LISTING_PREVIEW_CHARS) return text;
  let cut = text.slice(0, LISTING_PREVIEW_CHARS);
  // Never split a surrogate pair: the truncated string still has to be valid UTF-16.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Put every spawned child on the bus, and keep it there.
 *
 * This is the wiring the observed failure was missing end to end. A child used to register
 * itself when its executor started and *unregister* when it finished, which meant: a child
 * that had not been scheduled yet could not be addressed, and a child that had finished
 * stopped existing — so `hub list` showed one peer, `hub wait` returned `[]`, and there was
 * nothing to send a follow-up to. Three changes fix it:
 *
 *  - **Registered at spawn**, before the job is even pumped, so the `peer` a spawn result
 *    reports is addressable from the moment the model reads it.
 *  - **Parked, never unregistered**, on every terminal state including failure. LYRA.md §9
 *    makes a message the only resume primitive, and that is only true if there is still
 *    somebody to send it to. `onRevive` turns that message into the child's next turn.
 *  - **Published to the `agents` channel**, so `hub { op: "wait", channel: "agents" }` is a
 *    real event stream and a parent never has to poll to learn a child finished.
 *
 * A client watching over ACP gets the same transitions as `agent` updates, which is what a
 * presence strip renders from.
 */
export function attachAgentLifecycle(app: LyraApplication, emit: (update: SessionUpdate) => void): () => void {
  const registered = new Set<string>();
  return app.spawn.onLifecycle((event) => {
    try {
      if (event.type === "spawned" && !registered.has(event.peer)) {
        // Added only once the bus has accepted the name, so a refused registration does not
        // leave a peer this wiring believes in and nothing else does.
        app.bus.register(event.peer, {
          ...(event.label === undefined ? {} : { label: event.label }),
          // A message to a parked child is its next instruction, with its transcript intact.
          // `true` means the message became the child's next instruction, so the bus does
          // not also queue it: a revived agent reading its own prompt out of its inbox
          // cannot tell it from a second, unanswered request.
          onRevive: (peer, message) => app.spawn.revive(peer.name, renderHubAside({ from: message.from, ...(message.text === undefined ? {} : { text: message.text }), ...(message.data === undefined ? {} : { data: message.data }) })) !== undefined,
        });
        registered.add(event.peer);
      }
      if (SPAWN_TERMINAL_STATES.includes(event.status) && registered.has(event.peer)) {
        // Parked rather than completed: a completed peer swallows messages, and swallowing
        // the one message that could have revived it is precisely the wrong behaviour.
        app.bus.setState(event.peer, "parked");
      } else if (event.type === "started" || event.type === "revived") {
        if (registered.has(event.peer)) app.bus.setState(event.peer, "running");
      }
    } catch { /* a bus that refuses a name must not stop the child it names */ }
    try {
      app.bus.publish({ channel: SPAWN_LIFECYCLE_CHANNEL, text: describeLifecycle(event), data: event });
      // And addressed straight to whoever asked for the child, when it ends.
      //
      // The channel alone is not enough: `hub wait` with no channel waits on the caller's
      // own mailbox, which is the natural thing for a parent mid-conversation with a child
      // to do — and a child that *failed* mid-conversation would never send again, leaving
      // that wait to expire with nothing and no reason. A terminal transition is news the
      // parent asked for, so it is delivered like any other message: folded into its running
      // turn, or waking its wait.
      if (SPAWN_TERMINAL_STATES.includes(event.status)) notifyParent(app, event);
    } catch { /* publishing is observation; it never fails the job */ }
    // Guarded like everything else here: a client callback that throws must not stop the
    // sweep below, or peers for children that no longer exist accumulate on the bus.
    try { emit(agentUpdate(event)); } catch { /* observation never fails the job */ }
    // A child that has aged out of the manager's retention has no state left to report, so
    // its mailbox is retired too rather than lingering as a name nothing answers to.
    for (const peer of [...registered]) {
      if (app.spawn.status(peer) !== undefined) continue;
      registered.delete(peer);
      try { app.bus.unregister(peer); } catch { /* already gone */ }
    }
  });
}

/**
 * Tell the agent that spawned this one that it has ended.
 *
 * Only when the parent is live. A parked parent is one that finished before its own child,
 * and reviving it to hear that a child it is no longer working on has ended would restart a
 * turn nobody asked for — the parent can still read the news from the `agents` channel or
 * from `spawn status` whenever something else revives it.
 */
function notifyParent(app: LyraApplication, event: SpawnLifecycleEvent): void {
  const parent = event.parentId === undefined ? app.sessionName : app.spawn.status(event.parentId)?.peer;
  if (parent === undefined || parent === event.peer) return;
  const state = app.bus.getPeer(parent)?.state;
  if (state === undefined || state === "parked" || state === "completed" || state === "failed") return;
  try { app.bus.send({ from: event.peer, to: parent, text: describeLifecycle(event), data: event }); } catch { /* the channel still carries it */ }
}

/** One sentence a human or a model can read off the `agents` channel without parsing JSON. */
function describeLifecycle(event: SpawnLifecycleEvent): string {
  const name = event.label === undefined || event.label === event.peer ? event.peer : `${event.peer} (${event.label})`;
  switch (event.type) {
    case "spawned": return `${name} was spawned.`;
    case "started": return `${name} started.`;
    case "revived": return `${name} was revived by a message.`;
    case "completed": return `${name} completed after ${event.toolCalls} tool call(s), ${event.filesModified} file(s) changed. Collect it with spawn { id: "${event.id}" }.`;
    case "failed": return `${name} failed: ${event.error ?? "no reason was reported"}.`;
    case "timed_out": return `${name} ran out of time: ${event.error ?? "its deadline expired"}.`;
    case "cancelled": return `${name} was cancelled.`;
  }
}

/** The protocol shape of one transition, for a client's presence strip. */
function agentUpdate(event: SpawnLifecycleEvent): SessionUpdate {
  return {
    sessionUpdate: "agent",
    id: event.id,
    peer: event.peer,
    ...(event.label === undefined ? {} : { label: event.label }),
    // The transition, not only the state it left behind: `started` and `revived` are both
    // `running`, and a client that can only diff states cannot tell a child that resumed
    // from one that never stopped.
    event: event.type,
    status: event.status,
    ...(event.model === undefined ? {} : { model: event.model }),
    depth: event.depth,
    workspace: event.workspace,
    toolCalls: event.toolCalls,
    filesModified: event.filesModified,
    ...(event.error === undefined ? {} : { error: event.error }),
  };
}

function createLoop(app: LyraApplication, environment: EnvironmentProvider, store: TranscriptStore, contextWindow: number): AgentLoop {
  // The checkpointer reads the transcript head at the moment it snapshots, so a pre-tool
  // checkpoint is anchored to the assistant message that asked for the tool call — which is
  // what makes "rewind the conversation and the code together" one operation.
  return new AgentLoop({ provider: environment.provider, store, tools: app.tools, model: environment.model, system: systemPrompt(app, app.cwd, store.descriptor.name), contextWindow, workspace: app.cwd, checkpointer: app.checkpointer(() => store.head.id), turnTimeoutMs: durationMs(app.config.reliability.turn_timeout), compactor: new Compactor({ transcript: store, summaryGenerator: new ProviderSummaryGenerator({ provider: environment.provider, model: environment.model }), contextWindow, threshold: app.config.reliability.compact_at }), loopDetector: new LoopDetector() });
}

function systemPrompt(app: LyraApplication, workspace: string, session: string, definitions: readonly { name: string; description: string }[] = app.tools.definitions()): string {
  const mcpIndex = app.mcp.cachedIndex.map((tool) => `${tool.server}/${tool.name}`).join(", ");
  return buildSystemPrompt({ os: process.platform, arch: process.arch, workspace, origin: app.origin, session, tools: definitions.map((definition) => ({ name: definition.name, description: definition.name === "mcp" && mcpIndex ? `Describe or call indexed MCP tools: ${mcpIndex}` : oneLine(definition.description) })), skills: app.skills.list().map((skill) => ({ name: skill.name, description: oneLine(skill.description) })) });
}

function deferredServices(current: () => MainSession | undefined): SessionServices {
  const get = (): MainSession => { const value = current(); if (!value) throw new Error("Lyra main session is not initialized."); return value; };
  const stringParam = (params: unknown, field: string): string => { if (typeof params === "string") return params; if (params && typeof params === "object" && field in params && typeof (params as Record<string, unknown>)[field] === "string") return (params as Record<string, string>)[field]!; throw new Error(`${field} is required.`); };
  const optionalParam = (params: unknown, field: string): string | undefined => params && typeof params === "object" && field in params && typeof (params as Record<string, unknown>)[field] === "string" ? (params as Record<string, string>)[field] : undefined;
  const booleanParam = (params: unknown, field: string): boolean => params !== null && typeof params === "object" && (params as Record<string, unknown>)[field] === true;
  const numberParam = (params: unknown, field: string): number | undefined => { const value = params && typeof params === "object" ? (params as Record<string, unknown>)[field] : undefined; if (value === undefined) return undefined; if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer.`); return value; };
  return {
    copy: (target) => get().copy(target), dump: async () => get().dump(), settings: (args) => get().settings(args), provider: (args) => get().provider(args), model: (args) => get().model(args), loop: (spec) => get().runLoop(spec), context: () => get().context(), compact: (clear) => get().compact(clear), sessions: (operation, value) => operation === "list" ? get().listSessions() : operation === "resume" ? get().loadSession(value ?? "") : get().fork(value),
    acp: {
      "session/command": (params) => get().command(stringParam(params, "command")),
      "session/complete": (params) => get().complete({ sessionId: stringParam(params, "sessionId"), kind: stringParam(params, "kind"), query: stringParam(params, "query"), ...(numberParam(params, "limit") === undefined ? {} : { limit: numberParam(params, "limit")! }) }),
      "session/new": (params) => get().newSession(optionalParam(params, "name")),
      "session/load": (params) => get().loadSession(stringParam(params, "name")),
      "session/list": () => get().listSessions(),
      "session/snapshot": () => get().snapshot(),
      "session/prompt": (params, context) => get().prompt(stringParam(params, "prompt"), context.signal),
      "session/steer": (params) => get().steer(stringParam(params, "prompt")),
      "session/cancel": (params) => get().cancel({ rewoundToComposer: booleanParam(params, "rewoundToComposer") }),
      "session/fork": (params) => get().fork(optionalParam(params, "entryId")),
      "session/rewind": (params) => get().rewind(optionalParam(params, "entryId")),
      "session/models": (params) => get().models(booleanParam(params, "refresh")),
      // One switching surface: the reference may name another provider, and switching to it
      // is the same validated step selecting a model on the current one is.
      "session/select_model": (params) => get().model([stringParam(params, "model")]),
      "session/providers": () => get().provider([]),
      "session/select_provider": (params) => { const model = optionalParam(params, "model"); return get().provider(model === undefined ? [stringParam(params, "provider")] : [stringParam(params, "provider"), model]); },
      // The provider-setup surface. `params` is destructured field by field and never logged,
      // spread, or echoed: `apiKey` is a credential, and the only place it is allowed to reach
      // is the auth source `persist` names. The handlers below return the daemon's own result
      // shapes, neither of which has anywhere to put one.
      "provider/setup_options": () => get().setupOptions(),
      "provider/detect": (params, context) => get().detectProvider(detectParams(params), context.signal),
      "provider/verify": (params, context) => get().verifyProvider(verifyParams(params), context.signal),
      "provider/add": (params, context) => get().addProvider(addProviderParams(params), context.signal),
      "provider/get": (params) => get().getProvider(getProviderParams(params)),
      "provider/remove": (params, context) => get().removeProvider(removeProviderParams(params), context.signal),
      "model/add": (params, context) => get().addModel(addModelParams(params), context.signal),
      "context/inspect": () => get().context(),
    },
  };
}

/**
 * The provider-setup parameter readers.
 *
 * Both copy field by field rather than casting the whole object through. That is not
 * ceremony: it means an undeclared field a future client invents — including a second
 * credential-shaped one — cannot reach the provider layer, and it means every error message
 * below names a *field* and never a value, so a malformed request can never quote a
 * credential back onto the wire.
 */
function verifyParams(value: unknown): AcpVerifyProviderParams {
  const record = providerRecord(value, "provider/verify");
  return {
    baseUrl: requiredText(record, "baseUrl"),
    apiType: configurableApiType(record.apiType),
    ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
    ...(typeof record.apiKey === "string" ? { apiKey: record.apiKey } : {}),
    ...(typeof record.authEnvVar === "string" ? { authEnvVar: record.authEnvVar } : {}),
    ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
  };
}
function detectParams(value: unknown): AcpDetectProviderParams {
  const record = providerRecord(value, "provider/detect");
  return {
    baseUrl: requiredText(record, "baseUrl"),
    ...(typeof record.apiKey === "string" ? { apiKey: record.apiKey } : {}),
  };
}
function addModelParams(value: unknown): AcpAddModelParams {
  const record = providerRecord(value, "model/add");
  return { provider: requiredText(record, "provider"), model: requiredText(record, "model") };
}
function getProviderParams(value: unknown): AcpGetProviderParams {
  return { provider: requiredText(providerRecord(value, "provider/get"), "provider") };
}
function removeProviderParams(value: unknown): AcpRemoveProviderParams {
  const record = providerRecord(value, "provider/remove");
  const removeCredential = record.removeCredential;
  if (removeCredential !== undefined && typeof removeCredential !== "boolean") throw new Error("provider/remove removeCredential must be a boolean.");
  return { provider: requiredText(record, "provider"), ...(removeCredential === undefined ? {} : { removeCredential }) };
}
function addProviderParams(value: unknown): AcpAddProviderParams {
  const record = providerRecord(value, "provider/add");
  const persist = record.persist;
  if (persist !== "keychain" && persist !== "plaintext" && persist !== "env" && persist !== "none" && persist !== "keep") throw new Error("provider/add persist must be keychain, plaintext, env, none, or keep.");
  const websocket = record.websocket;
  if (websocket !== undefined && websocket !== "auto" && websocket !== "on" && websocket !== "off") throw new Error("provider/add websocket must be auto, on, or off.");
  return {
    provider: requiredText(record, "provider"),
    baseUrl: requiredText(record, "baseUrl"),
    apiType: configurableApiType(record.apiType),
    ...(typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {}),
    persist,
    ...(typeof record.fastModel === "string" ? { fastModel: record.fastModel } : {}),
    ...(typeof record.mergeModel === "string" ? { mergeModel: record.mergeModel } : {}),
    ...(websocket === undefined ? {} : { websocket }),
    ...(typeof record.apiKey === "string" ? { apiKey: record.apiKey } : {}),
    ...(typeof record.authEnvVar === "string" ? { authEnvVar: record.authEnvVar } : {}),
  };
}
function providerRecord(value: unknown, method: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${method} requires an object of parameters.`);
  return value as Record<string, unknown>;
}
function requiredText(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required and must be a non-empty string.`);
  return value;
}
function configurableApiType(value: unknown): AcpAddProviderParams["apiType"] {
  if (value !== "openai_completions" && value !== "openai_responses" && value !== "anthropic_messages") throw new Error("apiType must be openai_completions, openai_responses, or anthropic_messages.");
  return value;
}

/**
 * Where a provider's credential is read from, as an address a user can act on — a variable
 * name, a keychain entry, a plugin id. Never its contents: a static token has an address that
 * *is* the value, so it deliberately has none to report.
 */
function credentialAddress(auth: AuthConfig): string | undefined {
  switch (auth.type) {
    case "env": return auth.var;
    case "keychain": return `${auth.service}/${auth.account}`;
    case "plugin": return auth.plugin;
    case "static":
    case "none": return undefined;
  }
}

/** Maps a terminal stop reason onto the turn statuses the protocol declares. */
function turnStatusOf(stopReason: AgentTurnResult["stopReason"]): TurnStatus {
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "max_tokens") return "truncated";
  if (stopReason === "refusal") return "refusal";
  return "completed";
}

/** True when the transcript kept real assistant content, not just a cancellation marker. */
function retainedOutput(result: AgentTurnResult): boolean {
  return result.assistant.content.some((block) => block.type !== "marker");
}

function wireError(error: unknown): WireError {
  const value = error as { classification?: unknown; providerMessage?: unknown; code?: unknown; status?: unknown } | null;
  const classification = typeof value?.classification === "string" ? value.classification as WireError["classification"] : "transient";
  const message = typeof value?.providerMessage === "string"
    ? value.providerMessage
    : error instanceof Error ? error.message : String(error);
  return {
    classification,
    message,
    ...(typeof value?.code === "string" ? { code: value.code } : {}),
    ...(typeof value?.status === "number" ? { status: value.status } : {}),
  };
}

async function copyToClipboard(text: string): Promise<void> { const command = process.platform === "darwin" ? "/usr/bin/pbcopy" : Bun.which("wl-copy") ?? Bun.which("xclip") ?? Bun.which("xsel"); if (!command) throw new Error("No clipboard command is available. Install wl-clipboard, xclip, or xsel."); const args = command.endsWith("xclip") ? [command, "-selection", "clipboard"] : command.endsWith("xsel") ? [command, "--clipboard", "--input"] : [command]; const child = Bun.spawn(args, { stdin: "pipe", stdout: "ignore", stderr: "pipe" }); child.stdin.write(text); child.stdin.end(); const stderr = new Response(child.stderr).text(); if (await child.exited !== 0) throw new Error(`Clipboard command failed: ${(await stderr).trim()}`); }

function assistantText(result: AgentTurnResult): string { return result.assistant.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""); }
function validName(value: string): string { if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new TypeError("Session name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens (max 64 characters)."); return value; }
function oneLine(value: string): string { return value.replace(/\s+/g, " ").trim().slice(0, 180); }
