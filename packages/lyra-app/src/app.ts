import { realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { AcpDaemon, type AcpHandler, type AcpHandlers } from "@lyra/acp";
import { IrcBus, SpawnManager, type SpawnExecutor, type SpawnRequest } from "@lyra/core";
import { GitPipeline } from "@lyra/git";
import { ProcessHost, WorkspaceManager, type WorkspaceRecord } from "@lyra/host";
import { LspManager, type TextFallback } from "@lyra/lsp";
import { DracoInstaller, McpGateway, McpRegistry } from "@lyra/mcp";
import { RuntimeManager, type RuntimeAdapters } from "@lyra/runtime";
import { SkillRegistry } from "@lyra/skills";
import { createArtifactStore, type ToolRegistry } from "@lyra/tools";
import { loadConfig, durationMs, type LyraConfig } from "./config.ts";
import { SLASH_COMMAND_CATALOG, SlashCommandRouter, type SlashServices } from "./commands.ts";
import { createIntegratedToolRegistry, INTEGRATED_TOOL_NAMES } from "./integrated-tools.ts";
import { MetricsStore } from "./metrics.ts";

type SessionAcpMethod =
  | "session/new" | "session/load" | "session/list" | "session/snapshot"
  | "session/prompt" | "session/steer" | "session/cancel" | "session/fork" | "session/command"
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
  confirmAuto?: () => boolean | Promise<boolean>;
  onReport?: (message: string) => void | Promise<void>;
  home?: string;
}
interface ApplicationParts {
  config: LyraConfig; origin: string; workspace: WorkspaceRecord; workspaces: WorkspaceManager; processes: ProcessHost; bus: IrcBus; spawn: SpawnManager; lsp: LspManager; git: GitPipeline; mcp: McpRegistry; mcpTool: McpGateway; draco: DracoInstaller; skills: SkillRegistry; runtime: RuntimeManager; tools: ToolRegistry; metrics: MetricsStore; commands: SlashCommandRouter; acp: AcpDaemon;
}

export class LyraApplication {
  readonly config: LyraConfig;
  /**
   * The origin repository's canonical path. It is read from here rather than from
   * `workspaces.origin` because the manager only learns its own canonical path when
   * it opens, and with workspaces disabled it is never opened.
   */
  readonly origin: string;
  readonly workspace: WorkspaceRecord;
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
    this.config = parts.config; this.origin = parts.origin; this.workspace = parts.workspace; this.workspaces = parts.workspaces; this.processes = parts.processes; this.bus = parts.bus; this.spawn = parts.spawn; this.lsp = parts.lsp; this.git = parts.git; this.mcp = parts.mcp; this.mcpTool = parts.mcpTool; this.draco = parts.draco; this.skills = parts.skills; this.runtime = parts.runtime; this.tools = parts.tools; this.metrics = parts.metrics; this.commands = parts.commands; this.acp = parts.acp; this.#sessions = sessions;
  }

  static async boot(options: LyraApplicationOptions): Promise<LyraApplication> {
    if (!options || typeof options.origin !== "string" || options.origin.length === 0) throw new TypeError("Lyra application origin is required.");
    if (typeof options.session !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(options.session)) throw new TypeError("Lyra session must be a readable lowercase name.");
    if (typeof options.spawnExecutor !== "function") throw new TypeError("A real spawn executor is required; Lyra does not install a fake delegation fallback.");
    // Configuration and the origin's canonical path are both independent disk walks that
    // only need the origin path, so the two overlap instead of queueing.
    const [config, origin] = await Promise.all([loadConfig(options.origin, options.home), canonicalOrigin(options.origin)]);
    // Opening the manager probes Git, and that probe is what rejects an origin which is
    // not a repository root. With workspaces disabled nothing here needs a clone, so the
    // manager is constructed but left closed and opens on its first real use — a spawn
    // asking for isolation, or a workspace command. A plain directory therefore boots and
    // runs, and an impossible isolated spawn fails at the spawn with an actionable error
    // instead of taking the whole daemon down before the first prompt.
    const workspaces = new WorkspaceManager(options.origin);
    let workspace: WorkspaceRecord;
    if (config.workspace.enabled) {
      await workspaces.ready();
      const existing = (await workspaces.list()).find((record) => record.state !== "dropped" && record.name === options.session);
      workspace = await workspaces.resume((existing ?? await workspaces.create(options.session)).name);
    } else {
      const now = new Date().toISOString();
      workspace = { name: options.session, path: origin, origin, state: "active", mode: "clone", createdAt: now, updatedAt: now };
    }
    const processes = new ProcessHost({ heavyLimit: config.exec.heavy, ioLimit: config.exec.io, cgroup: config.exec.cgroup });
    const bus = new IrcBus(); bus.register(workspace.name);
    const spawn = new SpawnManager({ defaultWorkspace: workspace.path, ...(config.roles.default === undefined ? {} : { defaultModel: config.roles.default }), availableTools: INTEGRATED_TOOL_NAMES, maxDepth: 2, createWorkspace: async (name, task, signal) => { const created = await workspaces.create({ ...(name === undefined ? {} : { name }), ...(task === undefined ? {} : { task }) }, signal); return { name: created.name, path: created.path }; }, resolveWorkspace: (name) => resolveSpawnWorkspace(workspaces, name), releaseWorkspace: (name) => workspaces.archive(name), executor: options.spawnExecutor });
    const git = new GitPipeline({ origin, mode: config.git.mode, ...(options.confirmAuto === undefined ? {} : { confirmAuto: options.confirmAuto }), resolver: { resolve: async (args, signal) => { try { await runSpawnWithSignal(spawn, { task: mergeResolverTask(args), model: "@merge", isolated: false, workspace: args.repo, label: "merge-resolver" }, signal ?? new AbortController().signal); return true; } catch (error) { await options.onReport?.(`[git merge] Resolver stopped: ${errorMessage(error)}`); return false; } } }, activity: (activity) => { void options.onReport?.(`[git ${activity.operation}] ${activity.detail}`); } });
    const mcp = new McpRegistry(origin);
    const mcpGateway = new McpGateway(mcp, createArtifactStore(origin));
    const draco = new DracoInstaller({ origin, ...(options.home === undefined ? {} : { home: options.home }) });
    const skills = new SkillRegistry({ workspace: workspace.path, ...(options.home === undefined ? {} : { home: options.home }) });
    // Language servers, MCP indexing, skill discovery, and the Git mode probe each depend
    // only on the workspace that already exists, so they start together. Promise.all still
    // propagates the first failure, so a boot that used to throw still throws.
    const [lsp] = await Promise.all([
      LspManager.create({ workspace: workspace.path, ...(options.lspFallback === undefined ? {} : { fallback: options.lspFallback }) }),
      mcp.index(),
      skills.discover(),
      config.git.mode === "auto" ? git.setMode("auto") : undefined,
    ]);
    const metrics = new MetricsStore(origin);
    let tools: ToolRegistry | undefined;
    const runtimeAdapters: RuntimeAdapters = {
      spawn: async (request, signal) => runSpawnWithSignal(spawn, runtimeSpawn(request), signal),
      exec: async (command, execOptions, signal) => processes.run({ command, cwd: runtimeCwd(execOptions, workspace.path), signal }),
      tool: async (name, args, signal) => { if (!tools) throw new Error("Runtime tool registry is not ready."); return tools.execute(name, args, { signal, sessionId: options.session, workspace: workspace.path, callId: `runtime-${name}` }); },
      irc: async (operation, args, signal) => runtimeIrc(bus, workspace.name, operation, args, signal),
      git: async (operation, args, signal) => { throwIfAborted(signal); return operation === "preview" ? git.preview(runtimeWorkspaces(args), undefined, signal) : operation === "apply" ? git.apply(runtimeName(args, "preview"), signal) : git.rollback(runtimeOptionalName(args, "snapshot"), signal); },
      workspace: async (operation, args, signal) => { throwIfAborted(signal); const result = operation === "create" ? await workspaces.create(runtimeOptionalName(args, "name") ?? {}, signal) : operation === "list" ? await workspaces.list() : await workspaces.drop(runtimeName(args, "name"), signal); throwIfAborted(signal); return result; },
      report: async (message, signal) => { throwIfAborted(signal); await options.onReport?.(message); },
    };
    const runtime = new RuntimeManager({ origin, session: options.session, adapters: runtimeAdapters, runTimeoutMs: durationMs(config.reliability.turn_timeout) });
    tools = createIntegratedToolRegistry({ lsp, spawn, bus, peer: workspace.name, skills, runtime, mcp: mcpGateway, filesystem: { root: workspace.path }, bash: { root: workspace.path, processHost: processes } });
    const services = makeSlashServices(options.sessions, { workspaces, processes, bus, spawn, git, skills, mcp, draco, metrics, config });
    const handlers = makeAcpHandlers(options.sessions, { workspaces, spawn, bus, git, metrics, config });
    // The turn-class deadline is the *configured* one, so `reliability.turn_timeout` bounds
    // the ACP request that carries a turn exactly as it bounds the loop running inside it.
    // Both stdio paths — `--acp` and the TUI's private pipe pair — are this one daemon.
    const acp = new AcpDaemon({ handlers, turnTimeoutMs: durationMs(config.reliability.turn_timeout) });
    const commands = new SlashCommandRouter(services);
    return new LyraApplication({ config, origin, workspace, workspaces, processes, bus, spawn, lsp, git, mcp, mcpTool: mcpGateway, draco, skills, runtime, tools, metrics, commands, acp }, options.sessions);
  }

  slash(command: string): Promise<unknown> { return this.commands.execute(command); }
  async close(): Promise<void> { await this.acp.close(); await this.spawn.close(); await Promise.allSettled([this.mcp.close(), this.lsp.close(), this.tools.close(), this.runtime.close(), this.processes.close()]); if (this.config.workspace.enabled) await this.workspaces.archive(this.workspace.name); this.bus.close(); }
}
function makeAcpHandlers(sessions: SessionServices, parts: { workspaces: WorkspaceManager; spawn: SpawnManager; bus: IrcBus; git: GitPipeline; metrics: MetricsStore; config: LyraConfig }): AcpHandlers {
  return {
    ...sessions.acp,
    // Served straight from the router's own table: the popup and the router can never
    // disagree about which commands exist.
    "session/commands": () => ({ commands: SLASH_COMMAND_CATALOG }),
    "workspace/list": () => parts.workspaces.list(), "workspace/create": (params, context) => parts.workspaces.create(runtimeOptionalName(params, "name") ?? {}, context.signal), "workspace/drop": (params, context) => parts.workspaces.drop(runtimeName(params, "name"), context.signal),
    "agent/list": () => parts.spawn.list(),
    "agent/spawn": async (params, context) => { const handle = parts.spawn.spawn({ ...runtimeSpawn(params), blocking: false }); const cancel = (): void => { parts.spawn.cancel(handle.id); }; context.signal.addEventListener("abort", cancel, { once: true }); try { return await parts.spawn.wait(handle.id); } finally { context.signal.removeEventListener("abort", cancel); } },
    "agent/cancel": (params) => parts.spawn.cancel(runtimeName(params, "id")), "agent/message": (params) => runtimeIrc(parts.bus, "main", "send", params),
    "git/preview": (params, context) => parts.git.preview(runtimeWorkspaces(params), undefined, context.signal), "git/apply": (params, context) => parts.git.apply(runtimeName(params, "preview"), context.signal), "git/rollback": (params, context) => parts.git.rollback(runtimeOptionalName(params, "snapshot"), context.signal), "git/snapshot": (params, context) => parts.git.snapshot(runtimeOptionalName(params, "name"), context.signal),
    "settings/get": () => parts.config, "settings/set": (params) => sessions.settings(runtimeStrings(params, "args")),
  };
}
function makeSlashServices(sessions: SessionServices, parts: { workspaces: WorkspaceManager; processes: ProcessHost; bus: IrcBus; spawn: SpawnManager; git: GitPipeline; skills: SkillRegistry; mcp: McpRegistry; draco: DracoInstaller; metrics: MetricsStore; config: LyraConfig }): SlashServices {
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
    agents: async (operation, name) => operation === "list" ? { agents: parts.spawn.list() } : report(name === undefined ? "No agent id was given." : await parts.spawn.cancel(name) ? `Cancelled agent ${name}.` : `Agent ${name} is not running.`),
    workspaces: async (operation) => ({ workspaces: operation === "list" ? await parts.workspaces.list() : await cleanupWorkspaces(parts.workspaces, durationMs(parts.config.workspace.archive_after)) }),
    git: async (operation, value) => operation === "mode" ? report(`Git mode is now ${await parts.git.setMode(gitMode(value))}.`)
      : operation === "review" ? report("Assembled a merge preview of the completed agent workspaces.", await assembleReview(parts.git, parts.workspaces))
      : operation === "apply" ? report("Applied the reviewed preview to the origin repository.", await parts.git.apply(value))
      : report("Rolled the repository back to the snapshot.", await parts.git.rollback(value)),
    skills: async () => ({ skills: parts.skills.list() }),
    mcp: async () => ({ tools: await parts.mcp.index() }),
    install: async (tool) => { if (tool !== "draco") throw new Error(`Unsupported installer: ${tool}.`); return report(`Installed ${tool} and re-indexed the MCP registry.`, await parts.draco.install(parts.mcp)); },
    sessions: async (operation, value) => operation === "list" ? { sessions: await sessions.sessions("list") }
      : operation === "resume" ? report(`Loaded session ${value ?? ""}.`, await sessions.sessions(operation, value))
      : report(value === undefined ? "Forked the transcript at its head." : `Forked the transcript at ${value}.`, await sessions.sessions(operation, value)),
    health: async () => parts.metrics.health({ processes: parts.processes.list().length, workspaces: await workspaceCount(parts.workspaces, parts.config.workspace.enabled) }),
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
 * How many workspaces exist, for a health report that is about everything else. With
 * workspaces enabled the manager is already open and any failure is real. With them
 * disabled the manager may never have opened, and an origin that cannot host a
 * workspace holds none — so it answers zero instead of failing an unrelated report.
 */
async function workspaceCount(manager: WorkspaceManager, enabled: boolean): Promise<number> {
  try { return (await manager.list()).length; }
  catch (error) { if (enabled) throw error; return 0; }
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
async function assembleReview(git: GitPipeline, manager: WorkspaceManager): Promise<unknown> {
  const workspaces = (await manager.list()).filter((workspace): workspace is WorkspaceRecord & { task: string } => workspace.state === "archived" && typeof workspace.task === "string");
  if (workspaces.length === 0) throw new Error("No completed agent workspaces are available to review.");
  return git.preview(workspaces.map((workspace) => ({ name: workspace.name, path: workspace.path, task: workspace.task })));
}
async function cleanupWorkspaces(manager: WorkspaceManager, minimumAgeMs: number): Promise<unknown> { const dropped = []; const cutoff = Date.now() - minimumAgeMs; for (const record of await manager.list()) if (record.state === "archived" && Date.parse(record.updatedAt) <= cutoff) dropped.push(await manager.drop(record.name)); return dropped; }
function gitMode(value: string | undefined): "observe" | "stage" | "auto" { if (value !== "observe" && value !== "stage" && value !== "auto") throw new Error("git mode must be observe, stage, or auto."); return value; }
function runtimeWorkspaces(value: unknown): Array<{ name: string; path: string; task: string }> { if (!Array.isArray(value)) throw new Error("workspaces must be an array."); return value.map((entry) => { if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.path !== "string" || typeof entry.task !== "string") throw new Error("Each workspace needs name, path, and task."); return { name: entry.name, path: entry.path, task: entry.task }; }); }
function runtimeSpawn(value: unknown): SpawnRequest { if (!isRecord(value) || typeof value.task !== "string") throw new Error("spawn requires task."); const request: SpawnRequest = { task: value.task }; if (typeof value.model === "string") request.model = value.model; if (Array.isArray(value.tools) && value.tools.every((tool) => typeof tool === "string")) request.tools = value.tools; if (typeof value.context === "string") request.context = value.context; if (typeof value.label === "string") request.label = value.label; if (typeof value.isolated === "boolean") request.isolated = value.isolated; if (typeof value.workspace === "string") request.workspace = value.workspace; if (typeof value.acp === "string") request.acp = value.acp; return request; }
function runtimeCwd(value: unknown, fallback: string): string { return isRecord(value) && typeof value.cwd === "string" ? value.cwd : fallback; }
function runtimeName(value: unknown, field: string): string { const result = runtimeOptionalName(value, field); if (!result) throw new Error(`${field} is required.`); return result; }
function runtimeOptionalName(value: unknown, field: string): string | undefined { return isRecord(value) && typeof value[field] === "string" ? value[field] : undefined; }
function runtimeStrings(value: unknown, field: string): string[] { if (!isRecord(value) || !Array.isArray(value[field]) || !value[field].every((entry) => typeof entry === "string")) throw new Error(`${field} must be an array of strings.`); return value[field]; }
async function runtimeIrc(bus: IrcBus, peer: string, operation: "send" | "publish" | "wait", value: unknown, signal?: AbortSignal): Promise<unknown> { if (!isRecord(value)) throw new Error(`irc ${operation} requires arguments.`); throwIfAborted(signal); if (operation === "send") return bus.send({ from: peer, to: runtimeName(value, "to"), ...(typeof value.message === "string" ? { text: value.message } : {}), ...(value.data === undefined ? {} : { data: value.data }) }); if (operation === "publish") return bus.publish({ from: peer, channel: runtimeName(value, "channel"), ...(value.data === undefined ? {} : { data: value.data }) }); return typeof value.channel === "string" ? bus.wait({ channel: value.channel, ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}), ...(signal === undefined ? {} : { signal }) }) : bus.wait({ peer, ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}), ...(signal === undefined ? {} : { signal }) }); }
async function runSpawnWithSignal(manager: SpawnManager, request: SpawnRequest, signal: AbortSignal): Promise<unknown> { throwIfAborted(signal); const handle = manager.spawn({ ...request, blocking: false }); const cancel = (): void => { manager.cancel(handle.id); }; signal.addEventListener("abort", cancel, { once: true }); try { return await manager.wait(handle.id); } finally { signal.removeEventListener("abort", cancel); } }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
