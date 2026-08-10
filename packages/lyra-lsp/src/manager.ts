import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LanguageServerClient } from "./client.ts";
import { discoverLanguageServers, type DiscoverLanguageServersOptions } from "./discovery.ts";
import type { LanguageServerClientOptions, LanguageServerSpec, LspMethod, LspSpawn, TextFallback } from "./types.ts";

const DEFAULT_DEADLINE_MS = 20_000;
/** A graceful exit is worth a short wait, never a slow one. */
const DEFAULT_SHUTDOWN_DEADLINE_MS = 2_000;
/** One restart per language per session: enough for a cold index, not a restart loop. */
const DEFAULT_RESTART_LIMIT = 1;
const TIMED_OUT = Symbol("lsp-manager-timeout");

export interface ManagedLanguageServerClient {
  initialize(): Promise<unknown>;
  /** The LSP exit handshake, attempted before close() tears the process down. */
  shutdown?(timeoutMs?: number): Promise<unknown>;
  request?(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  definition?(params: unknown): Promise<unknown>;
  references?(params: unknown): Promise<unknown>;
  hover?(params: unknown): Promise<unknown>;
  rename?(params: unknown): Promise<unknown>;
  diagnostics?(params: unknown): Promise<unknown>;
  codeAction?(params: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export type LanguageServerClientFactory = (options: LanguageServerClientOptions, spec: LanguageServerSpec) => ManagedLanguageServerClient;

export interface LspManagerOptions extends DiscoverLanguageServersOptions {
  workspace: string;
  fallback?: TextFallback;
  deadlineMs?: number;
  /** Deadline for the graceful shutdown handshake during close(). */
  shutdownDeadlineMs?: number;
  /** Restarts allowed per language for the life of the manager. Defaults to one. */
  restartLimit?: number;
  spawn?: LspSpawn;
  onLog?: (line: string) => void;
  onWarning?: (message: string) => void;
  clientFactory?: LanguageServerClientFactory;
}

export interface LspFallbackResult {
  kind: "text-fallback-unavailable";
  method: LspMethod;
  message: string;
}

const DEFAULT_FALLBACK: TextFallback = {
  async run(method) {
    return { kind: "text-fallback-unavailable", method, message: `No text fallback is configured for ${method}` } satisfies LspFallbackResult;
  },
  warn() {},
};

interface ClientSlot { spec: LanguageServerSpec; client: ManagedLanguageServerClient; }
type OperationName = "definition" | "references" | "hover" | "rename" | "diagnostics" | "codeAction";

const METHOD_BY_OPERATION: Readonly<Record<OperationName, LspMethod>> = {
  definition: "textDocument/definition", references: "textDocument/references", hover: "textDocument/hover",
  rename: "textDocument/rename", diagnostics: "textDocument/diagnostic", codeAction: "textDocument/codeAction",
};
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".rs": "rust", ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python", ".go": "go",
};
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  rs: "rust", rust: "rust", ts: "typescript", tsx: "typescript", typescript: "typescript",
  js: "javascript", jsx: "javascript", javascript: "javascript", py: "python", python: "python", go: "go", golang: "go",
};

function normalizeOptions(optionsOrWorkspace: LspManagerOptions | string, fallback?: TextFallback, extra: Omit<LspManagerOptions, "workspace" | "fallback"> = {}): LspManagerOptions {
  if (typeof optionsOrWorkspace !== "string") return optionsOrWorkspace;
  return fallback === undefined ? { workspace: optionsOrWorkspace, ...extra } : { workspace: optionsOrWorkspace, fallback, ...extra };
}
function defaultClientFactory(options: LanguageServerClientOptions, _spec: LanguageServerSpec): ManagedLanguageServerClient { return new LanguageServerClient(options); }
function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (record.error !== null && typeof record.error === "object" && typeof (record.error as Record<string, unknown>).message === "string") return (record.error as Record<string, unknown>).message as string;
  }
  return String(value);
}
function isErrorResult(value: unknown): boolean {
  if (value instanceof Error || value === null || typeof value !== "object") return value instanceof Error;
  const record = value as Record<string, unknown>;
  return record.ok === false || record.error !== undefined || record.kind === "error" || record.name === "LspError";
}
function isTimeoutResult(value: unknown): boolean {
  if (!isErrorResult(value)) return false;
  const text = errorText(value).toLowerCase();
  const record = value as Record<string, unknown>;
  const discriminator = String(record.kind ?? record.code ?? record.type ?? "").toLowerCase();
  return text.includes("timeout") || text.includes("timed out") || text.includes("deadline") || discriminator.includes("timeout") || discriminator.includes("deadline");
}
async function workspaceIsDirectory(workspace: string): Promise<boolean> { try { return (await stat(workspace)).isDirectory(); } catch { return false; } }
function uriFromParams(params: unknown): string | undefined {
  if (params === null || typeof params !== "object") return undefined;
  const record = params as Record<string, unknown>;
  if (typeof record.uri === "string") return record.uri;
  if (record.textDocument !== null && typeof record.textDocument === "object" && typeof (record.textDocument as Record<string, unknown>).uri === "string") return (record.textDocument as Record<string, unknown>).uri as string;
  return undefined;
}
function languageFromParams(params: unknown): string | undefined {
  const uri = uriFromParams(params); if (uri === undefined) return undefined;
  try { return LANGUAGE_BY_EXTENSION[extname(uri.startsWith("file:") ? new URL(uri).pathname : uri).toLowerCase()]; } catch { return LANGUAGE_BY_EXTENSION[extname(uri).toLowerCase()]; }
}
async function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(TIMED_OUT), deadlineMs); });
  // Losing the race means nobody observes this promise again; a late rejection must not go unhandled.
  void promise.catch(() => undefined);
  try { return await Promise.race([promise, timeout]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

export class LspManager {
  readonly workspace: string;
  readonly deadlineMs: number;
  readonly shutdownDeadlineMs: number;
  readonly warnings: string[] = [];
  reason: string | undefined;
  private readonly fallback: TextFallback;
  private readonly options: LspManagerOptions;
  private readonly clients = new Map<string, ClientSlot>();
  /** Specs of languages that started at least once, so a dropped client can be revived. */
  private readonly specs = new Map<string, LanguageServerSpec>();
  private readonly restartBudget = new Map<string, number>();
  private readonly restartLimit: number;
  private readonly warnedLanguages = new Set<string>();
  private readonly readyPromise: Promise<void>;
  private closed = false;

  constructor(options: LspManagerOptions);
  constructor(workspace: string, fallback?: TextFallback, options?: Omit<LspManagerOptions, "workspace" | "fallback">);
  constructor(optionsOrWorkspace: LspManagerOptions | string, fallback?: TextFallback, extra?: Omit<LspManagerOptions, "workspace" | "fallback">) {
    this.options = normalizeOptions(optionsOrWorkspace, fallback, extra); this.workspace = resolve(this.options.workspace || "."); this.deadlineMs = this.options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.shutdownDeadlineMs = this.options.shutdownDeadlineMs ?? Math.min(this.deadlineMs, DEFAULT_SHUTDOWN_DEADLINE_MS); this.restartLimit = Math.max(0, this.options.restartLimit ?? DEFAULT_RESTART_LIMIT);
    this.fallback = this.options.fallback ?? DEFAULT_FALLBACK; this.readyPromise = this.startDiscoveredServers();
  }
  static async create(options: LspManagerOptions): Promise<LspManager>;
  static async create(workspace: string, fallback?: TextFallback, options?: Omit<LspManagerOptions, "workspace" | "fallback">): Promise<LspManager>;
  static async create(optionsOrWorkspace: LspManagerOptions | string, fallback?: TextFallback, extra?: Omit<LspManagerOptions, "workspace" | "fallback">): Promise<LspManager> {
    const manager = typeof optionsOrWorkspace === "string" ? new LspManager(optionsOrWorkspace, fallback, extra) : new LspManager(optionsOrWorkspace); await manager.ready(); return manager;
  }
  async ready(): Promise<this> { await this.readyPromise; return this; }
  get languages(): readonly string[] { return [...this.clients.keys()]; }
  get warningLog(): readonly string[] { return this.warnings; }
  has(language: string): boolean { return this.clients.has(this.normalizeLanguage(language)); }

  async definition(language: string, params: unknown): Promise<unknown>;
  async definition(params: unknown, language?: string): Promise<unknown>;
  async definition(a: string | unknown, b?: unknown): Promise<unknown> { return this.route("definition", a, b); }
  async references(language: string, params: unknown): Promise<unknown>;
  async references(params: unknown, language?: string): Promise<unknown>;
  async references(a: string | unknown, b?: unknown): Promise<unknown> { return this.route("references", a, b); }
  async hover(language: string, params: unknown): Promise<unknown>;
  async hover(params: unknown, language?: string): Promise<unknown>;
  async hover(a: string | unknown, b?: unknown): Promise<unknown> { return this.route("hover", a, b); }
  async rename(language: string, params: unknown): Promise<unknown>;
  async rename(params: unknown, language?: string): Promise<unknown>;
  async rename(a: string | unknown, b?: unknown): Promise<unknown> { return this.route("rename", a, b); }
  async diagnostics(language: string, params: unknown): Promise<unknown>;
  async diagnostics(params: unknown, language?: string): Promise<unknown>;
  async diagnostics(a: string | unknown, b?: unknown): Promise<unknown> { return this.route("diagnostics", a, b); }
  async codeAction(language: string, params: unknown): Promise<unknown>;
  async codeAction(params: unknown, language?: string): Promise<unknown>;
  async codeAction(a: string | unknown, b?: unknown): Promise<unknown> { return this.route("codeAction", a, b); }

  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; await this.readyPromise;
    const clients = [...new Set([...this.clients.values()].map((slot) => slot.client))]; this.clients.clear(); await Promise.allSettled(clients.map((client) => this.stop(client)));
  }

  /** Ask for the LSP exit handshake, then tear the process down regardless of the answer. */
  private async stop(client: ManagedLanguageServerClient): Promise<void> {
    if (typeof client.shutdown === "function") {
      try { await withDeadline(Promise.resolve(client.shutdown(this.shutdownDeadlineMs)), this.shutdownDeadlineMs); } catch { /* close() below is authoritative */ }
    }
    await client.close();
  }

  private async startDiscoveredServers(): Promise<void> {
    if (!this.options.workspace || !(await workspaceIsDirectory(this.workspace))) { this.reason = `Workspace is not a readable directory: ${this.options.workspace || "(empty)"}`; return; }
    const discovery: DiscoverLanguageServersOptions = {
      ...(this.options.specs === undefined ? {} : { specs: this.options.specs }),
      ...(this.options.commands === undefined ? {} : { commands: this.options.commands }),
      ...(this.options.commandOverrides === undefined ? {} : { commandOverrides: this.options.commandOverrides }),
    };
    const specs = await discoverLanguageServers(this.workspace, discovery);
    if (specs.length === 0) { this.reason = "No supported language-server markers found"; return; }
    const startedCommands = new Set<string>();
    for (const spec of specs) {
      if (this.closed || this.clients.has(spec.language)) continue;
      const commandKey = `${spec.command}\0${spec.args.join("\0")}`; if (startedCommands.has(commandKey)) continue; startedCommands.add(commandKey);
      await this.startClient(spec);
    }
    if (this.clients.size === 0 && this.reason === undefined) this.reason = "Detected language servers were unavailable";
  }

  private clientOptions(spec: LanguageServerSpec): LanguageServerClientOptions {
    return {
      command: spec.command, args: spec.args, cwd: this.workspace, rootUri: pathToFileURL(this.workspace).href, requestTimeoutMs: this.deadlineMs,
      ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }), ...(this.options.onLog === undefined ? {} : { onLog: this.options.onLog }),
    };
  }

  private async startClient(spec: LanguageServerSpec): Promise<ClientSlot | undefined> {
    const factory = this.options.clientFactory ?? defaultClientFactory;
    let client: ManagedLanguageServerClient;
    try { client = factory(this.clientOptions(spec), spec); } catch (error) { this.markUnavailable(spec.language, errorText(error)); return undefined; }
    try {
      const initialized = await withDeadline(Promise.resolve(client.initialize()), this.deadlineMs);
      if (initialized === TIMED_OUT || isErrorResult(initialized)) { this.markUnavailable(spec.language, initialized === TIMED_OUT ? `initialization exceeded ${this.deadlineMs}ms` : errorText(initialized)); void client.close().catch(() => {}); return undefined; }
      if (this.closed) { await client.close(); return undefined; }
      const slot: ClientSlot = { spec, client };
      this.clients.set(spec.language, slot); this.specs.set(spec.language, spec);
      // Seeded once, so a successful restart never refills its own budget.
      if (!this.restartBudget.has(spec.language)) this.restartBudget.set(spec.language, this.restartLimit);
      return slot;
    } catch (error) { this.markUnavailable(spec.language, errorText(error)); void client.close().catch(() => {}); return undefined; }
  }

  /** One slow cold index must not disable a language for the session — but only once. */
  private async restart(language: string): Promise<ClientSlot | undefined> {
    const spec = this.specs.get(language); const budget = this.restartBudget.get(language) ?? 0;
    if (spec === undefined || budget <= 0) return undefined;
    this.restartBudget.set(language, budget - 1);
    return this.startClient(spec);
  }

  private async route(operation: OperationName, a: unknown, b?: unknown): Promise<unknown> {
    await this.readyPromise;
    const explicitFirst = typeof a === "string" && typeof b !== "string"; const params = explicitFirst ? b : a; const explicitLanguage = explicitFirst ? a : typeof b === "string" ? b : undefined;
    const language = this.selectLanguage(explicitLanguage, params); const method = METHOD_BY_OPERATION[operation];
    let slot = language === undefined || this.closed ? undefined : this.clients.get(language);
    if (slot === undefined && language !== undefined && !this.closed) slot = await this.restart(language);
    if (this.closed || language === undefined || slot === undefined) return this.runFallback(language ?? explicitLanguage ?? languageFromParams(params) ?? "unknown", method, params);
    const activeLanguage = language;
    try {
      const operationFunction = slot.client[operation];
      const request = typeof operationFunction === "function" ? Promise.resolve(operationFunction.call(slot.client, params)) : slot.client.request !== undefined ? Promise.resolve(slot.client.request(method, params, this.deadlineMs)) : Promise.resolve({ kind: "error", message: `Client does not implement ${operation}` });
      const result = await withDeadline(request, this.deadlineMs);
      if (result === TIMED_OUT || isTimeoutResult(result)) { this.clients.delete(activeLanguage); this.markUnavailable(activeLanguage, `request ${method} exceeded ${this.deadlineMs}ms`); void slot.client.close().catch(() => {}); return this.runFallback(activeLanguage, method, params); }
      return result;
    } catch (error) { this.clients.delete(activeLanguage); this.markUnavailable(activeLanguage, errorText(error)); void slot.client.close().catch(() => {}); return this.runFallback(activeLanguage, method, params); }
  }
  private selectLanguage(explicit: string | undefined, params: unknown): string | undefined {
    const requested = explicit === undefined ? languageFromParams(params) : this.normalizeLanguage(explicit); if (requested !== undefined) { if (this.clients.has(requested)) return requested; if (requested === "javascript" && this.clients.has("typescript")) return "typescript"; if (requested === "typescript" && this.clients.has("javascript")) return "javascript"; return requested; }
    if (this.clients.size === 1) return this.clients.keys().next().value; return undefined;
  }
  private normalizeLanguage(language: string): string { const lower = language.trim().toLowerCase(); return LANGUAGE_ALIASES[lower] ?? lower; }
  private markUnavailable(language: string, detail: string): void { this.warnOnce(language, `LSP unavailable for ${language}; using text fallback (${detail})`); }
  private warnOnce(language: string, message: string): void { if (this.warnedLanguages.has(language)) return; this.warnedLanguages.add(language); this.warnings.push(message); this.fallback.warn(message); this.options.onWarning?.(message); }
  private async runFallback(language: string, method: LspMethod, params: unknown): Promise<unknown> { this.warnOnce(language, `LSP unavailable for ${language}; using text fallback`); try { return await this.fallback.run(method, params); } catch (error) { return { kind: "text-fallback-unavailable", method, message: errorText(error) } satisfies LspFallbackResult; } }
}
