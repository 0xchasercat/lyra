import { basename, isAbsolute, join, relative } from "node:path";
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
import { SlashCommandRouter, type SlashServices } from "./commands.ts";
import { createIntegratedToolRegistry, INTEGRATED_TOOL_NAMES } from "./integrated-tools.ts";
import { MetricsStore } from "./metrics.ts";

type SessionAcpMethod = "session/new" | "session/load" | "session/prompt" | "session/update" | "session/cancel" | "session/fork" | "session/command" | "context/inspect";
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
  config: LyraConfig; workspace: WorkspaceRecord; workspaces: WorkspaceManager; processes: ProcessHost; bus: IrcBus; spawn: SpawnManager; lsp: LspManager; git: GitPipeline; mcp: McpRegistry; mcpTool: McpGateway; draco: DracoInstaller; skills: SkillRegistry; runtime: RuntimeManager; tools: ToolRegistry; metrics: MetricsStore; commands: SlashCommandRouter; acp: AcpDaemon;
}

export class LyraApplication {
  readonly config: LyraConfig;
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
    this.config = parts.config; this.workspace = parts.workspace; this.workspaces = parts.workspaces; this.processes = parts.processes; this.bus = parts.bus; this.spawn = parts.spawn; this.lsp = parts.lsp; this.git = parts.git; this.mcp = parts.mcp; this.mcpTool = parts.mcpTool; this.draco = parts.draco; this.skills = parts.skills; this.runtime = parts.runtime; this.tools = parts.tools; this.metrics = parts.metrics; this.commands = parts.commands; this.acp = parts.acp; this.#sessions = sessions;
  }

  static async boot(options: LyraApplicationOptions): Promise<LyraApplication> {
    if (!options || typeof options.origin !== "string" || options.origin.length === 0) throw new TypeError("Lyra application origin is required.");
    if (typeof options.session !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(options.session)) throw new TypeError("Lyra session must be a readable lowercase name.");
    if (typeof options.spawnExecutor !== "function") throw new TypeError("A real spawn executor is required; Lyra does not install a fake delegation fallback.");
    const config = await loadConfig(options.origin, options.home);
    const workspaces = await WorkspaceManager.open(options.origin);
    const existing = (await workspaces.list()).find((record) => record.state !== "dropped" && record.name === options.session);
    let workspace = existing ?? (config.workspace.enabled ? await workspaces.create(options.session) : { name: options.session, path: workspaces.origin, origin: workspaces.origin, state: "active" as const, mode: "clone" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    if (config.workspace.enabled) workspace = await workspaces.resume(workspace.name);
    const processes = new ProcessHost({ heavyLimit: config.exec.heavy, ioLimit: config.exec.io, cgroup: config.exec.cgroup });
    const bus = new IrcBus(); bus.register(workspace.name);
    const spawn = new SpawnManager({ defaultWorkspace: workspace.path, ...(config.roles.default === undefined ? {} : { defaultModel: config.roles.default }), availableTools: INTEGRATED_TOOL_NAMES, maxDepth: 2, createWorkspace: async (name, task, signal) => { const created = await workspaces.create({ ...(name === undefined ? {} : { name }), ...(task === undefined ? {} : { task }) }, signal); return { name: created.name, path: created.path }; }, resolveWorkspace: (name) => resolveSpawnWorkspace(workspaces, name), releaseWorkspace: (name) => workspaces.archive(name), executor: options.spawnExecutor });
    const lsp = await LspManager.create({ workspace: workspace.path, ...(options.lspFallback === undefined ? {} : { fallback: options.lspFallback }) });
    const git = new GitPipeline({ origin: workspaces.origin, mode: config.git.mode, ...(options.confirmAuto === undefined ? {} : { confirmAuto: options.confirmAuto }), resolver: { resolve: async (args, signal) => { try { await runSpawnWithSignal(spawn, { task: mergeResolverTask(args), model: "@merge", isolated: false, workspace: args.repo, label: "merge-resolver" }, signal ?? new AbortController().signal); return true; } catch (error) { await options.onReport?.(`[git merge] Resolver stopped: ${errorMessage(error)}`); return false; } } }, activity: (activity) => { void options.onReport?.(`[git ${activity.operation}] ${activity.detail}`); } });
    if (config.git.mode === "auto") await git.setMode("auto");
    const mcp = new McpRegistry(workspaces.origin);
    await mcp.index();
    const mcpGateway = new McpGateway(mcp, createArtifactStore(workspaces.origin));
    const draco = new DracoInstaller({ origin: workspaces.origin, ...(options.home === undefined ? {} : { home: options.home }) });
    const skills = new SkillRegistry({ workspace: workspace.path, ...(options.home === undefined ? {} : { home: options.home }) }); await skills.discover();
    const metrics = new MetricsStore(workspaces.origin);
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
    const runtime = new RuntimeManager({ origin: workspaces.origin, session: options.session, adapters: runtimeAdapters, runTimeoutMs: durationMs(config.reliability.turn_timeout) });
    tools = createIntegratedToolRegistry({ lsp, spawn, bus, peer: workspace.name, skills, runtime, mcp: mcpGateway, filesystem: { root: workspace.path }, bash: { root: workspace.path, processHost: processes } });
    const services = makeSlashServices(options.sessions, { workspaces, processes, bus, spawn, git, skills, mcp, draco, metrics, config });
    const handlers = makeAcpHandlers(options.sessions, { workspaces, spawn, bus, git, metrics, config });
    const acp = new AcpDaemon({ handlers });
    const commands = new SlashCommandRouter(services);
    return new LyraApplication({ config, workspace, workspaces, processes, bus, spawn, lsp, git, mcp, mcpTool: mcpGateway, draco, skills, runtime, tools, metrics, commands, acp }, options.sessions);
  }

  slash(command: string): Promise<unknown> { return this.commands.execute(command); }
  async close(): Promise<void> { await this.acp.close(); await this.spawn.close(); await Promise.allSettled([this.mcp.close(), this.lsp.close(), this.tools.close(), this.runtime.close(), this.processes.close()]); if (this.config.workspace.enabled) await this.workspaces.archive(this.workspace.name); this.bus.close(); }
}
function makeAcpHandlers(sessions: SessionServices, parts: { workspaces: WorkspaceManager; spawn: SpawnManager; bus: IrcBus; git: GitPipeline; metrics: MetricsStore; config: LyraConfig }): AcpHandlers {
  return {
    ...sessions.acp,
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
    copy: (target) => sessions.copy(target), dump: () => sessions.dump(), settings: (args) => sessions.settings(args), provider: (args) => sessions.provider(args), model: (args) => sessions.model(args), loop: (spec) => sessions.loop(spec), context: () => sessions.context(), compact: (clear) => sessions.compact(clear),
    agents: async (operation, name) => operation === "list" ? parts.spawn.list() : name ? parts.spawn.cancel(name) : false,
    workspaces: async (operation) => operation === "list" ? parts.workspaces.list() : cleanupWorkspaces(parts.workspaces, durationMs(parts.config.workspace.archive_after)),
    git: async (operation, value) => operation === "mode" ? parts.git.setMode(gitMode(value)) : operation === "review" ? assembleReview(parts.git, parts.workspaces) : operation === "apply" ? parts.git.apply(value) : parts.git.rollback(value),
    skills: async () => parts.skills.list(), mcp: async () => parts.mcp.index(), install: async (tool) => { if (tool !== "draco") throw new Error(`Unsupported installer: ${tool}.`); return parts.draco.install(parts.mcp); }, sessions: (operation, value) => sessions.sessions(operation, value), health: async () => parts.metrics.health({ processes: parts.processes.list().length, workspaces: (await parts.workspaces.list()).length }),
  };
}
async function resolveSpawnWorkspace(manager: WorkspaceManager, name: string): Promise<{ name: string; path: string }> {
  if (isAbsolute(name)) {
    const applyRoot = join(manager.origin, ".lyra", "apply");
    const child = relative(applyRoot, name);
    if (child === "" || child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(child)) throw new Error("Internal spawn workspace is outside the transactional apply root.");
    return { name: basename(name), path: name };
  }
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
