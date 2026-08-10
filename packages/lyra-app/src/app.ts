import { realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { AcpDaemon, type AcpHandler, type AcpHandlers } from "@lyra/acp";
import { IrcBus, SpawnManager, type SpawnExecutor, type SpawnRequest } from "@lyra/core";
import { CheckpointStore, GitPipeline, excludeLyraState, summarizeWorkspace, type CheckpointGcResult, type CheckpointRecord } from "@lyra/git";
import { ProcessHost, WorkspaceManager, type WorkspaceRecord } from "@lyra/host";
import { LspManager, type TextFallback } from "@lyra/lsp";
import { DracoInstaller, McpGateway, McpRegistry } from "@lyra/mcp";
import { RuntimeManager, type RuntimeAdapters } from "@lyra/runtime";
import { SkillRegistry } from "@lyra/skills";
import { createArtifactStore, type ToolRegistry } from "@lyra/tools";
import { loadConfig, durationMs, type LyraConfig } from "./config.ts";
import { SLASH_COMMAND_CATALOG, SlashCommandRouter, type SlashServices } from "./commands.ts";
import { createIntegratedToolRegistry, INTEGRATED_TOOL_NAMES, type CheckpointAccess } from "./integrated-tools.ts";
import { assertWritableOrigin, claimSessionDirectory, describeConcurrentSession, releaseSessionDirectory, SessionCheckpointer } from "./checkpoints.ts";
import { MetricsStore } from "./metrics.ts";

type SessionAcpMethod =
  | "session/new" | "session/load" | "session/list" | "session/snapshot"
  | "session/prompt" | "session/steer" | "session/cancel" | "session/fork" | "session/rewind" | "session/command"
  | "session/complete"
  | "session/models" | "session/select_model" | "session/providers" | "session/select_provider"
  | "provider/setup_options" | "provider/detect" | "provider/verify" | "provider/add"
  | "provider/get" | "provider/remove"
  | "model/add"
  | "context/inspect";
export interface SessionServices {
  copy(target?: string): Promise<unknown>; dump(): Promise<unknown>; settings(args: readonly string[]): Promise<unknown>; provider(args: readonly string[]): Promise<unknown>; model(args: readonly string[]): Promise<unknown>; loop(spec: string): Promise<unknown>; context(): Promise<unknown>; compact(clear: boolean): Promise<unknown>; sessions(operation: "fork" | "resume" | "list", value?: string): Promise<unknown>;
  acp: Record<SessionAcpMethod, AcpHandler>;
}
export interface LyraApplicationOptions {
  origin: string;
  session: string;
  spawnExecutor: SpawnExecutor;
  sessions: SessionServices;
  lspFallback?: TextFallback;
  onReport?: (message: string) => void | Promise<void>;
  home?: string;
}
interface ApplicationParts {
  config: LyraConfig; origin: string; cwd: string; sessionName: string; checkpoints: CheckpointStore; workspaces: WorkspaceManager; processes: ProcessHost; bus: IrcBus; spawn: SpawnManager; lsp: LspManager; git: GitPipeline; mcp: McpRegistry; mcpTool: McpGateway; draco: DracoInstaller; skills: SkillRegistry; runtime: RuntimeManager; tools: ToolRegistry; metrics: MetricsStore; commands: SlashCommandRouter; acp: AcpDaemon;
}

export class LyraApplication {
  readonly config: LyraConfig;
  /** The launch directory's canonical path. */
  readonly origin: string;
  /**
   * Where the main session's tools operate: the launch directory itself.
   *
   * The main session has no workspace and never had a good reason for one. A clone made
   * every path the model saw a lie (`cd`-ing into `.lyra/workspaces/…` was a recurring
   * failure), forced the footer to show a path nobody recognised, and bought only
   * reversibility — which checkpoints now provide without moving anything. Isolation is
   * still one `spawn(isolated: true)` away, for the children that want it.
   */
  readonly cwd: string;
  readonly sessionName: string;
  /** The undo history: one shadow repository over [`cwd`], never the user's own `.git`. */
  readonly checkpoints: CheckpointStore;
  readonly workspaces: WorkspaceManager;
  readonly processes: ProcessHost;
  readonly bus: IrcBus;
  readonly spawn: SpawnManager;
  readonly lsp: LspManager;
  readonly git: GitPipeline;
  readonly mcp: McpRegistry;
  readonly mcpTool: McpGateway;
  readonly draco: DracoInstaller;
  readonly skills: SkillRegistry;
  readonly runtime: RuntimeManager;
  readonly tools: ToolRegistry;
  readonly metrics: MetricsStore;
  readonly commands: SlashCommandRouter;
  readonly acp: AcpDaemon;
  readonly #sessions: SessionServices;

  private constructor(parts: ApplicationParts, sessions: SessionServices) {
    this.config = parts.config; this.origin = parts.origin; this.cwd = parts.cwd; this.sessionName = parts.sessionName; this.checkpoints = parts.checkpoints; this.workspaces = parts.workspaces; this.processes = parts.processes; this.bus = parts.bus; this.spawn = parts.spawn; this.lsp = parts.lsp; this.git = parts.git; this.mcp = parts.mcp; this.mcpTool = parts.mcpTool; this.draco = parts.draco; this.skills = parts.skills; this.runtime = parts.runtime; this.tools = parts.tools; this.metrics = parts.metrics; this.commands = parts.commands; this.acp = parts.acp; this.#sessions = sessions;
  }

  static async boot(options: LyraApplicationOptions): Promise<LyraApplication> {
    if (!options || typeof options.origin !== "string" || options.origin.length === 0) throw new TypeError("Lyra application origin is required.");
    if (typeof options.session !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(options.session)) throw new TypeError("Lyra session must be a readable lowercase name.");
    if (typeof options.spawnExecutor !== "function") throw new TypeError("A real spawn executor is required; Lyra does not install a fake delegation fallback.");
    // Configuration and the origin's canonical path are both independent disk walks that
    // only need the origin path, so the two overlap instead of queueing.
    const [config, origin] = await Promise.all([loadConfig(options.origin, options.home), canonicalOrigin(options.origin)]);
    // Everything below writes into `<origin>/.lyra`. Proving that is possible here turns an
    // EACCES from whichever subsystem got there first into one sentence naming the fix.
    await assertWritableOrigin(origin);
    for (const notice of config.deprecations) void options.onReport?.(notice);
    // Opening the manager probes Git, and that probe is what rejects an origin which is not
    // a repository root. Nothing the main session does needs a clone any more, so the
    // manager is constructed but left closed and opens on its first real use — an isolated
    // spawn, or a workspace command. A plain directory therefore boots and runs, and an
    // impossible isolated spawn fails at the spawn with an actionable error instead of
    // taking the whole daemon down before the first prompt.
    const workspaces = new WorkspaceManager(origin);
    const cwd = origin;
    const checkpoints = await CheckpointStore.open({ root: cwd, onWarning: (message) => { void options.onReport?.(message); } });
    const concurrent = await claimSessionDirectory(origin, options.session);
    if (concurrent !== undefined) void options.onReport?.(describeConcurrentSession(origin, concurrent));
    // `.lyra` now sits inside the user's own checkout, because the session runs there. Best
    // effort, and silent in a directory that is not a repository — there is nothing to hide it from.
    void excludeLyraState(origin).catch(() => undefined);
    const processes = new ProcessHost({ heavyLimit: config.exec.heavy, ioLimit: config.exec.io, cgroup: config.exec.cgroup });
    const bus = new IrcBus(); bus.register(options.session);
    // `reservedPeers` is what keeps a child's label from shadowing a name that already
    // answers on the bus: two peers called `reviewer` is a lost message, not a collision.
    const spawn = new SpawnManager({ defaultWorkspace: cwd, ...(config.roles.default === undefined ? {} : { defaultModel: config.roles.default }), availableTools: INTEGRATED_TOOL_NAMES, maxDepth: 2, reservedPeers: () => bus.list().map((peer) => peer.name), createWorkspace: async (name, task, signal) => { const created = await workspaces.create({ ...(name === undefined ? {} : { name }), ...(task === undefined ? {} : { task }) }, signal); return { name: created.name, path: created.path }; }, resolveWorkspace: (name) => resolveSpawnWorkspace(workspaces, name), releaseWorkspace: (name) => workspaces.archive(name), describeWorkspace: (input) => summarizeWorkspace({ origin, workspace: input.name, path: input.path }), executor: options.spawnExecutor });
    const git = new GitPipeline({ origin, checkpoints, resolver: { resolve: async (args, signal) => { try { await runSpawnWithSignal(spawn, { task: mergeResolverTask(args), model: "@merge", isolated: false, workspace: args.repo, label: "merge-resolver" }, signal ?? new AbortController().signal); return true; } catch (error) { await options.onReport?.(`[git merge] Resolver stopped: ${errorMessage(error)}`); return false; } } }, activity: (activity) => { void options.onReport?.(`[git ${activity.operation}] ${activity.detail}`); } });
    const mcp = new McpRegistry(origin);
    const mcpGateway = new McpGateway(mcp, createArtifactStore(origin));
    const draco = new DracoInstaller({ origin, ...(options.home === undefined ? {} : { home: options.home }) });
    const skills = new SkillRegistry({ workspace: cwd, ...(options.home === undefined ? {} : { home: options.home }) });
    // Language servers, MCP indexing and skill discovery each depend only on the session
    // directory, which already exists, so they start together. Promise.all still propagates
    // the first failure, so a boot that used to throw still throws.
    const [lsp] = await Promise.all([
      LspManager.create({ workspace: cwd, ...(options.lspFallback === undefined ? {} : { fallback: options.lspFallback }) }),
      mcp.index(),
      skills.discover(),
    ]);
    const metrics = new MetricsStore(origin);
    let tools: ToolRegistry | undefined;
    const checkpointAccess = createCheckpointAccess(checkpoints, () => new SessionCheckpointer({ store: checkpoints }));
    const runtimeAdapters: RuntimeAdapters = {
      spawn: async (request, signal) => runSpawnWithSignal(spawn, runtimeSpawn(request), signal),
      exec: async (command, execOptions, signal) => processes.run({ command, cwd: runtimeCwd(execOptions, cwd), signal }),
      tool: async (name, args, signal) => { if (!tools) throw new Error("Runtime tool registry is not ready."); return tools.execute(name, args, { signal, sessionId: options.session, workspace: cwd, callId: `runtime-${name}` }); },
      irc: async (operation, args, signal) => runtimeIrc(bus, options.session, operation, args, signal),
      git: async (operation, args, signal) => { throwIfAborted(signal); return operation === "preview" ? git.preview(runtimeWorkspaces(args), undefined, signal) : operation === "apply" ? git.apply(runtimeName(args, "preview"), signal) : checkpointAccess.restore(runtimeOptionalName(args, "checkpoint") ?? "latest", runtimeFlag(args, "force")); },
      workspace: async (operation, args, signal) => { throwIfAborted(signal); const result = operation === "create" ? await workspaces.create(runtimeOptionalName(args, "name") ?? {}, signal) : operation === "list" ? await workspaces.list() : await workspaces.drop(runtimeName(args, "name"), signal); throwIfAborted(signal); return result; },
      report: async (message, signal) => { throwIfAborted(signal); await options.onReport?.(message); },
    };
    const runtime = new RuntimeManager({ origin, session: options.session, adapters: runtimeAdapters, runTimeoutMs: durationMs(config.reliability.turn_timeout) });
    tools = createIntegratedToolRegistry({ lsp, spawn, bus, peer: options.session, agents: { status: (name) => spawn.status(name) }, skills, runtime, mcp: mcpGateway, checkpoints: checkpointAccess, filesystem: { root: cwd }, bash: { root: cwd, processHost: processes } });
    const services = makeSlashServices(options.sessions, { workspaces, processes, bus, spawn, git, checkpoints, skills, mcp, draco, metrics, config });
    const handlers = makeAcpHandlers(options.sessions, { workspaces, spawn, bus, sessionName: options.session, git, checkpoints, metrics, config });
    // The turn-class deadline is the *configured* one, so `reliability.turn_timeout` bounds
    // the ACP request that carries a turn exactly as it bounds the loop running inside it.
    // Both stdio paths — `--acp` and the TUI's private pipe pair — are this one daemon.
    const acp = new AcpDaemon({ handlers, turnTimeoutMs: durationMs(config.reliability.turn_timeout) });
    const commands = new SlashCommandRouter(services);
    return new LyraApplication({ config, origin, cwd, sessionName: options.session, checkpoints, workspaces, processes, bus, spawn, lsp, git, mcp, mcpTool: mcpGateway, draco, skills, runtime, tools, metrics, commands, acp }, options.sessions);
  }

  /** A checkpointer bound to this session's store, for one agent loop. */
  checkpointer(entryId?: () => string | undefined): SessionCheckpointer {
    return new SessionCheckpointer({ store: this.checkpoints, ...(entryId === undefined ? {} : { entryId }) });
  }

  slash(command: string): Promise<unknown> { return this.commands.execute(command); }
  async close(): Promise<void> { await this.acp.close(); await this.spawn.close(); await Promise.allSettled([this.mcp.close(), this.lsp.close(), this.tools.close(), this.runtime.close(), this.processes.close(), this.checkpoints.close(), releaseSessionDirectory(this.origin)]); this.bus.close(); }
}

/**
 * A checkpoint as a client is allowed to see it.
 *
 * The stored record also carries the shadow repository's commit and tree oids, the raw
 * commit message, and the per-path attribution the never-clobber rule runs on. None of
 * that is a client's business — the oids are unstable across thinning and the attribution
 * is an internal ledger — and the protocol declares the projection closed, so shipping them
 * would be a schema violation rather than a harmless extra.
 */
export function wireCheckpoint(record: CheckpointRecord): Record<string, unknown> {
  return {
    id: record.id, kind: record.kind, label: record.label, createdAt: record.createdAt,
    changedFiles: record.changedFiles, excluded: record.excluded,
    ...(record.entryId === undefined ? {} : { entryId: record.entryId }),
    ...(record.tool === undefined ? {} : { tool: record.tool }),
    ...(record.callId === undefined ? {} : { callId: record.callId }),
  };
}

function wireRestore(result: Awaited<ReturnType<CheckpointStore["restore"]>>): Record<string, unknown> {
  return { target: wireCheckpoint(result.target), safety: wireCheckpoint(result.safety), restored: result.restored, preserved: result.preserved, forced: result.forced, excluded: result.excluded };
}

/**
 * The four checkpoint operations, as the model and the protocol both see them.
 *
 * `create` goes through a checkpointer rather than the store directly so a manual mark
 * carries the same attribution bookkeeping an automatic one does; everything else reads.
 */
export function createCheckpointAccess(store: CheckpointStore, checkpointer: () => SessionCheckpointer): CheckpointAccess {
  return {
    unavailable: () => store.unavailable,
    list: (limit) => store.list(limit === undefined ? {} : { limit }),
    create: (label) => checkpointer().mark(label),
    restore: (reference, force) => store.restore(reference, { force }),
    diff: (input) => store.diff({
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
      ...(input.patches === undefined ? {} : { patches: input.patches }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }),
  };
}

function makeAcpHandlers(sessions: SessionServices, parts: { workspaces: WorkspaceManager; spawn: SpawnManager; bus: IrcBus; sessionName: string; git: GitPipeline; checkpoints: CheckpointStore; metrics: MetricsStore; config: LyraConfig }): AcpHandlers {
  return {
    ...sessions.acp,
    // Served straight from the router's own table: the popup and the router can never
    // disagree about which commands exist.
    "session/commands": () => ({ commands: SLASH_COMMAND_CATALOG }),
    "workspace/list": () => parts.workspaces.list(), "workspace/create": (params, context) => parts.workspaces.create(runtimeOptionalName(params, "name") ?? {}, context.signal), "workspace/drop": (params, context) => parts.workspaces.drop(runtimeName(params, "name"), context.signal),
    "agent/list": () => parts.spawn.statusList(),
    "agent/spawn": async (params, context) => { const handle = parts.spawn.spawn({ ...runtimeSpawn(params), blocking: false }); const cancel = (): void => { parts.spawn.cancel(handle.id); }; context.signal.addEventListener("abort", cancel, { once: true }); try { return await parts.spawn.wait(handle.id); } finally { context.signal.removeEventListener("abort", cancel); } },
    "agent/cancel": (params) => parts.spawn.cancel(runtimeName(params, "id")),
    // Addressed from the session peer, which is a peer the bus actually knows — sending as
    // the invented name "main" produced `Unknown sender peer: main` for every caller.
    "agent/message": (params) => runtimeIrc(parts.bus, parts.sessionName, "send", params),
    "git/preview": (params, context) => parts.git.preview(runtimeWorkspaces(params), undefined, context.signal), "git/apply": (params, context) => parts.git.apply(runtimeName(params, "preview"), context.signal),
    // The rewind surface. `checkpoint/list` is a question, `checkpoint/diff` renders one,
    // and `checkpoint/restore` is the only one that writes — and it writes nothing a
    // caller did not attribute to Lyra unless `force` says so.
    "checkpoint/list": async (params) => ({
      checkpoints: (await parts.checkpoints.list(runtimeCount(params, "limit") === undefined ? {} : { limit: runtimeCount(params, "limit")! })).map(wireCheckpoint),
      available: parts.checkpoints.available,
      ...(parts.checkpoints.unavailable === undefined ? {} : { unavailable: parts.checkpoints.unavailable }),
    }),
    "checkpoint/diff": (params) => parts.checkpoints.diff({
      ...(runtimeOptionalName(params, "from") === undefined ? {} : { from: runtimeOptionalName(params, "from")! }),
      ...(runtimeOptionalName(params, "to") === undefined ? {} : { to: runtimeOptionalName(params, "to")! }),
      patches: runtimeFlag(params, "patches"),
      ...(runtimeCount(params, "limit") === undefined ? {} : { limit: runtimeCount(params, "limit")! }),
    }),
    "checkpoint/restore": async (params) => wireRestore(await parts.checkpoints.restore(runtimeName(params, "checkpoint"), { force: runtimeFlag(params, "force") })),
    "settings/get": () => parts.config, "settings/set": (params) => sessions.settings(runtimeStrings(params, "args")),
  };
}
function makeSlashServices(sessions: SessionServices, parts: { workspaces: WorkspaceManager; processes: ProcessHost; bus: IrcBus; spawn: SpawnManager; git: GitPipeline; checkpoints: CheckpointStore; skills: SkillRegistry; mcp: McpRegistry; draco: DracoInstaller; metrics: MetricsStore; config: LyraConfig }): SlashServices {
  return {
    copy: async (target) => report(`Copied ${textLength(await sessions.copy(target))} characters of the assistant's reply to the clipboard.`),
    dump: async () => report(`Copied the full transcript to the clipboard as ${textLength(await sessions.dump())} characters of JSON.`),
    settings: async (args) => report(args.length === 0 ? "Effective runtime settings." : `Applied ${args[0]}.`, await sessions.settings(args)),
    provider: async (args) => report(args.length === 0 ? "Configured providers." : `Switched provider to ${args.join("/")}.`, await sessions.provider(args)),
    // Selecting a model answers with the whole model surface rather than an
    // acknowledgement, so /model has one declared shape whether or not it was given a
    // reference — the client renders one view and never branches on the arguments it sent.
    model: async (args) => {
      if (args.length > 0 && args[0] !== "refresh") await sessions.model(args);
      return sessions.model(args[0] === "refresh" ? ["refresh"] : []);
    },
    loop: async (spec) => report(`Autonomous loop finished: ${spec}.`, await sessions.loop(spec)),
    // The measured payload itself is megabytes and no client renders it; the breakdown is
    // the answer. `context/inspect` still returns the whole inspection for callers that
    // want the payload.
    context: async () => contextBreakdown(await sessions.context()),
    compact: async (clear) => report(clear ? "Cleared the context behind a boundary; the transcript on disk is untouched." : "Compacted the transcript into a summary boundary.", await sessions.compact(clear)),
    // The state vocabulary is the point of this command now: "running" used to cover a child
    // three tool calls in and one whose provider never answered, and `/agents` was where a
    // user went to tell them apart and could not.
    agents: async (operation, name) => {
      if (operation === "list") return { agents: parts.spawn.statusList() };
      if (name === undefined) return report("No agent id was given. Run /agents to see them, then /kill <id>.");
      const status = parts.spawn.status(name);
      if (status === undefined) return report(`No agent answers to ${name}. Run /agents to see the ones this session knows.`);
      if (parts.spawn.cancel(status.id)) return report(`Cancelled ${status.id} (${status.peer}).`);
      return report(status.resultAvailable
        ? `${status.id} (${status.peer}) had already ${status.status === "completed" ? "completed" : status.status}; nothing was stopped and its result is still collectable.`
        : `${status.id} (${status.peer}) is already ${status.status}, so there was nothing to cancel.`);
    },
    workspaces: async (operation) => operation === "list"
      ? { workspaces: await parts.workspaces.list() }
      : cleanup(parts, durationMs(parts.config.workspace.archive_after)),
    // The same listing `checkpoint/list` answers with. `available: false` with its reason is
    // the load-bearing half: an empty list in a directory that cannot host checkpoints at all
    // reads as "nothing has happened yet", which is a different and wrong thing.
    checkpoints: async () => ({
      checkpoints: (await parts.checkpoints.list({ limit: 50 })).map(wireCheckpoint),
      available: parts.checkpoints.available,
      ...(parts.checkpoints.unavailable === undefined ? {} : { unavailable: parts.checkpoints.unavailable }),
    }),
    // /review is the diff surface now, not a merge ceremony: what has changed since a
    // checkpoint, plus every agent workspace holding work the model could still integrate.
    // Patches ride along per file, so a client renders one summary row per path and expands
    // the hunks for the one path the user asked about.
    review: async (from) => ({
      diff: await parts.checkpoints.diff({ ...(from === undefined ? {} : { from }), patches: true, limit: 100 }),
      agents: await integrableWorkspaces(parts.workspaces, parts.git.origin),
    }),
    rollback: async (reference, force) => {
      const result = await parts.checkpoints.restore(reference ?? "latest", { force });
      return report(
        `Restored ${result.restored.length} file(s) to ${result.target.label} (${result.target.id}); undo this with /rollback ${result.safety.id}.` +
        (result.preserved.length === 0 ? "" : ` Left ${result.preserved.length} file(s) that changed outside Lyra's own tool calls untouched: ${result.preserved.slice(0, 10).join(", ")}${result.preserved.length > 10 ? "…" : ""}. Re-run with --force to revert those too.`),
        wireRestore(result),
      );
    },
    apply: async (preview) => report("Applied the reviewed merge preview to the repository.", await parts.git.apply(preview)),
    skills: async () => ({ skills: parts.skills.list() }),
    mcp: async () => ({ tools: await parts.mcp.index() }),
    install: async (tool) => { if (tool !== "draco") throw new Error(`Unsupported installer: ${tool}.`); return report(`Installed ${tool} and re-indexed the MCP registry.`, await parts.draco.install(parts.mcp)); },
    sessions: async (operation, value) => operation === "list" ? { sessions: await sessions.sessions("list") }
      : operation === "resume" ? report(`Loaded session ${value ?? ""}.`, await sessions.sessions(operation, value))
      : report(value === undefined ? "Forked the transcript at its head." : `Forked the transcript at ${value}.`, await sessions.sessions(operation, value)),
    health: async () => parts.metrics.health({ processes: parts.processes.list().length, workspaces: await workspaceCount(parts.workspaces) }),
  };
}
/**
 * The shape every free-form command answers with: one printable line, plus the command's
 * own payload beside it. The line is for the client to render as-is; the payload is not
 * flattened into prose, so nothing a command computed is lost on the way to the wire.
 */
function report(message: string, detail?: unknown): { report: string; detail?: unknown } {
  return { report: message, ...(detail === undefined ? {} : { detail }) };
}
function textLength(value: unknown): number { return typeof value === "string" ? value.length : 0; }

/**
 * A context inspection without its `payload`: the measurement, not the megabytes. Every
 * field is copied by name, so a new field in the inspection is an explicit decision here
 * rather than an accidental addition to the protocol.
 */
function contextBreakdown(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Context inspection returned no breakdown.");
  const fields = ["tokenEstimate", "contextWindow", "sections", "repairs", "lossMarkers", "cacheBreakpoints", "sourceEntryIds"] as const;
  return Object.fromEntries(fields.flatMap((field) => field in value ? [[field, value[field]] as const] : []));
}

/**
 * How many workspaces exist, for a health report that is about everything else. The manager
 * may never have opened — nothing about the main session needs it — and an origin that
 * cannot host a workspace holds none, so it answers zero rather than failing an unrelated
 * report.
 */
async function workspaceCount(manager: WorkspaceManager): Promise<number> {
  try { return (await manager.list()).length; } catch { return 0; }
}

/**
 * The origin's canonical path — the same value an opened `WorkspaceManager` reports.
 * A path that cannot be resolved is left as written: the manager says why, in its own
 * words, the moment anything actually needs it.
 */
async function canonicalOrigin(origin: string): Promise<string> {
  const resolved = resolve(origin);
  try { return await realpath(resolved); } catch { return resolved; }
}

async function resolveSpawnWorkspace(manager: WorkspaceManager, name: string): Promise<{ name: string; path: string }> {
  if (isAbsolute(name)) return { name: basename(name), path: resolve(name) };
  const existing = await manager.get(name);
  if (!existing || existing.state === "dropped") throw new Error(`Workspace ${name} does not exist.`);
  const resumed = existing.state === "active" ? existing : await manager.resume(name);
  return { name: resumed.name, path: resumed.path };
}

function mergeResolverTask(args: { conflict: { files: string[]; workspace: { task: string }; priorTasks: string[] }; allWorkspaces: readonly { name: string; task: string }[] }): string {
  return `Resolve the current Git merge conflict without committing. Work only in this repository. Preserve the intent of every original task; do not choose a side mechanically. Inspect the conflicting history and files, remove every conflict marker, stage the resolved files with git add, and run git diff --check. If an honest resolution is impossible, leave the conflicts unresolved and explain why.\n\nConflicted files: ${args.conflict.files.join(", ")}\nIncoming task: ${args.conflict.workspace.task}\nAlready merged tasks: ${args.conflict.priorTasks.join(" | ") || "none"}\nAll workspace contracts:\n${args.allWorkspaces.map((workspace) => `- ${workspace.name}: ${workspace.task}`).join("\n")}`;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/**
 * Every workspace still holding work, with the commands that integrate it.
 *
 * Abandoned, interrupted, and outright broken children are all in here: the filter is on
 * "not dropped", not on "finished cleanly", precisely so a child that died mid-task stays
 * visible and reachable rather than becoming an orphan directory nobody is told about.
 */
async function integrableWorkspaces(manager: WorkspaceManager, origin: string): Promise<unknown[]> {
  let records: WorkspaceRecord[];
  try { records = await manager.list(); } catch { return []; }
  const live = records.filter((record) => record.state !== "dropped");
  return Promise.all(live.map(async (record) => ({
    ...record,
    integration: await summarizeWorkspace({ origin, workspace: record.name, path: record.path }),
  })));
}

/**
 * `/cleanup`: archived workspaces past their retention, stale preview repositories, and the
 * checkpoint history thinned by age and count. One command, because they are one question —
 * "reclaim what this session no longer needs" — and three would be three things to remember.
 */
async function cleanup(parts: { workspaces: WorkspaceManager; git: GitPipeline; checkpoints: CheckpointStore }, minimumAgeMs: number): Promise<unknown> {
  const dropped: WorkspaceRecord[] = [];
  const cutoff = Date.now() - minimumAgeMs;
  try {
    for (const record of await parts.workspaces.list()) {
      if (record.state === "archived" && Date.parse(record.updatedAt) <= cutoff) dropped.push(await parts.workspaces.drop(record.name));
    }
  } catch { /* no workspace root: nothing to reclaim, and not an error in a plain directory */ }
  const previews = await parts.git.cleanupPreviews(minimumAgeMs).catch(() => [] as string[]);
  let checkpoints: CheckpointGcResult = { kept: 0, dropped: 0, checkpoints: [] };
  try { checkpoints = await parts.checkpoints.collect(); } catch { /* thinning is best effort; the history stays as it was */ }
  return { workspaces: dropped, previews, checkpoints: { kept: checkpoints.kept, dropped: checkpoints.dropped } };
}

function runtimeWorkspaces(value: unknown): Array<{ name: string; path: string; task: string }> { if (!Array.isArray(value)) throw new Error("workspaces must be an array."); return value.map((entry) => { if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.path !== "string" || typeof entry.task !== "string") throw new Error("Each workspace needs name, path, and task."); return { name: entry.name, path: entry.path, task: entry.task }; }); }
function runtimeSpawn(value: unknown): SpawnRequest { if (!isRecord(value) || typeof value.task !== "string") throw new Error("spawn requires task."); const request: SpawnRequest = { task: value.task }; if (typeof value.model === "string") request.model = value.model; if (Array.isArray(value.tools) && value.tools.every((tool) => typeof tool === "string")) request.tools = value.tools; if (typeof value.context === "string") request.context = value.context; if (typeof value.label === "string") request.label = value.label; if (typeof value.isolated === "boolean") request.isolated = value.isolated; if (typeof value.workspace === "string") request.workspace = value.workspace; if (typeof value.acp === "string") request.acp = value.acp; if (Array.isArray(value.writeScope) && value.writeScope.every((entry) => typeof entry === "string")) request.writeScope = value.writeScope; return request; }
function runtimeCwd(value: unknown, fallback: string): string { return isRecord(value) && typeof value.cwd === "string" ? value.cwd : fallback; }
function runtimeName(value: unknown, field: string): string { const result = runtimeOptionalName(value, field); if (!result) throw new Error(`${field} is required.`); return result; }
function runtimeOptionalName(value: unknown, field: string): string | undefined { return isRecord(value) && typeof value[field] === "string" && value[field].length > 0 ? value[field] : undefined; }
function runtimeFlag(value: unknown, field: string): boolean { return isRecord(value) && value[field] === true; }
function runtimeCount(value: unknown, field: string): number | undefined { const raw = isRecord(value) ? value[field] : undefined; if (raw === undefined) return undefined; if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) throw new Error(`${field} must be a positive integer.`); return raw; }
function runtimeStrings(value: unknown, field: string): string[] { if (!isRecord(value) || !Array.isArray(value[field]) || !value[field].every((entry) => typeof entry === "string")) throw new Error(`${field} must be an array of strings.`); return value[field]; }
async function runtimeIrc(bus: IrcBus, peer: string, operation: "send" | "publish" | "wait", value: unknown, signal?: AbortSignal): Promise<unknown> { if (!isRecord(value)) throw new Error(`irc ${operation} requires arguments.`); throwIfAborted(signal); if (operation === "send") return bus.send({ from: peer, to: runtimeName(value, "to"), ...(typeof value.message === "string" ? { text: value.message } : {}), ...(value.data === undefined ? {} : { data: value.data }) }); if (operation === "publish") return bus.publish({ from: peer, channel: runtimeName(value, "channel"), ...(value.data === undefined ? {} : { data: value.data }) }); return typeof value.channel === "string" ? bus.wait({ channel: value.channel, ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}), ...(signal === undefined ? {} : { signal }) }) : bus.wait({ peer, ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}), ...(signal === undefined ? {} : { signal }) }); }
async function runSpawnWithSignal(manager: SpawnManager, request: SpawnRequest, signal: AbortSignal): Promise<unknown> { throwIfAborted(signal); const handle = manager.spawn({ ...request, blocking: false }); const cancel = (): void => { manager.cancel(handle.id); }; signal.addEventListener("abort", cancel, { once: true }); try { return await manager.wait(handle.id); } finally { signal.removeEventListener("abort", cancel); } }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

export type { CheckpointRecord };
