import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  LanguageServerClientOptions,
  LspDiagnostic,
  LspLocation,
  LspMethod,
  LspProcess,
  LspSpawn,
  LspTransport,
} from "./types.ts";
import { LSP_METHOD_NOT_FOUND, LspError, LspJsonRpcTransport } from "./protocol.ts";

export type LanguageServerResult<T> = T | LspError;

const DEFAULT_TIMEOUT_MS = 20_000;
/** Open documents are a per-server resource; keep the working set small and bounded. */
const DEFAULT_MAX_OPEN_DOCUMENTS = 32;
const CLIENT_INFO = Object.freeze({ name: "lyra", version: "0.1.0" });

/** TextDocumentSyncKind. */
const SYNC_NONE = 0;
const SYNC_FULL = 1;

interface SyncPolicy {
  openClose: boolean;
  change: number;
}
/** Until a server says otherwise, assume it wants open/close plus full-content changes. */
const DEFAULT_SYNC: SyncPolicy = { openClose: true, change: SYNC_FULL };

/**
 * Exactly the capabilities this client exercises.
 *
 * Servers gate features on what they see here, and an empty object makes
 * rust-analyzer and pyright answer navigation requests with null. Positions are
 * exchanged as UTF-16 code units: that is the LSP default, it is the only encoding
 * advertised, and this client never rewrites a position, so a conformant server
 * cannot pick anything else.
 */
const CLIENT_CAPABILITIES = Object.freeze({
  general: { positionEncodings: ["utf-16"] },
  workspace: { configuration: true, workspaceFolders: false },
  window: { workDoneProgress: true },
  textDocument: {
    synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: false },
    // linkSupport stays off so servers return plain Location[] rather than LocationLink[].
    definition: { dynamicRegistration: false, linkSupport: false },
    references: { dynamicRegistration: false },
    hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
    rename: { dynamicRegistration: false, prepareSupport: false },
    codeAction: { dynamicRegistration: false, codeActionLiteralSupport: { codeActionKind: { valueSet: [] } } },
    // Both diagnostic transports: pull is preferred, push is the fallback (see diagnostics()).
    publishDiagnostics: { relatedInformation: true, versionSupport: false, tagSupport: { valueSet: [1, 2] } },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
  },
});

const LANGUAGE_ID_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".rs": "rust",
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact",
  ".py": "python", ".pyi": "python",
  ".go": "go", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
  ".json": "json", ".jsonc": "jsonc", ".md": "markdown", ".toml": "toml", ".yaml": "yaml", ".yml": "yaml",
};

interface OpenDocument {
  languageId: string;
  version: number;
  /** Cheap disk-freshness key; a changed mtime or size forces a resync. */
  signature: string;
}

function defaultSpawn(command: string, args: readonly string[], cwd: string): LspProcess {
  const process = Bun.spawn([command, ...args], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return process as unknown as LspProcess;
}

function asLspError(error: unknown, kind: LspError["kind"] = "transport"): LspError {
  if (error instanceof LspError) return error;
  return new LspError(kind, error instanceof Error ? error.message : String(error), { cause: error });
}

function documentUri(params: unknown): string | undefined {
  if (params === null || typeof params !== "object") return undefined;
  const record = params as Record<string, unknown>;
  if (typeof record.uri === "string") return record.uri;
  const textDocument = record.textDocument;
  if (textDocument !== null && typeof textDocument === "object" && typeof (textDocument as Record<string, unknown>).uri === "string") {
    return (textDocument as Record<string, unknown>).uri as string;
  }
  return undefined;
}

function pathFromUri(uri: string): string | undefined {
  if (!uri.startsWith("file:")) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function languageIdFromPath(path: string): string {
  return LANGUAGE_ID_BY_EXTENSION[extname(path).toLowerCase()] ?? "plaintext";
}

function syncPolicyFrom(result: unknown): SyncPolicy {
  if (result === null || typeof result !== "object") return DEFAULT_SYNC;
  const capabilities = (result as { capabilities?: unknown }).capabilities;
  if (capabilities === null || typeof capabilities !== "object") return DEFAULT_SYNC;
  const sync = (capabilities as { textDocumentSync?: unknown }).textDocumentSync;
  if (typeof sync === "number") return { openClose: sync !== SYNC_NONE, change: sync };
  if (sync === null || typeof sync !== "object") return DEFAULT_SYNC;
  const record = sync as { openClose?: unknown; change?: unknown };
  return {
    openClose: record.openClose !== false,
    change: typeof record.change === "number" ? record.change : SYNC_FULL,
  };
}

function positionEncodingFrom(result: unknown): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const capabilities = (result as { capabilities?: unknown }).capabilities;
  if (capabilities === null || typeof capabilities !== "object") return undefined;
  const encoding = (capabilities as { positionEncoding?: unknown }).positionEncoding;
  return typeof encoding === "string" ? encoding : undefined;
}

function diagnosticsFrom(params: unknown): { uri: string; diagnostics: LspDiagnostic[] } | undefined {
  if (params === null || typeof params !== "object") return undefined;
  const record = params as { uri?: unknown; diagnostics?: unknown };
  if (typeof record.uri !== "string" || !Array.isArray(record.diagnostics)) return undefined;
  return { uri: record.uri, diagnostics: record.diagnostics as LspDiagnostic[] };
}

/** A small LSP client with deliberately narrow, provider-facing operations. */
export class LanguageServerClient {
  private readonly spawn: LspSpawn;
  private readonly maxOpenDocuments: number;
  /** Insertion-ordered, so the first key is always the least recently used document. */
  private readonly documents = new Map<string, OpenDocument>();
  private readonly published = new Map<string, LspDiagnostic[]>();
  private transport: LspTransport | undefined;
  private process: LspProcess | undefined;
  private initialized = false;
  private initializing: Promise<LanguageServerResult<unknown>> | undefined;
  private closed = false;
  private sync: SyncPolicy = DEFAULT_SYNC;
  private pullDiagnostics = true;
  private encoding = "utf-16";

  constructor(private readonly options: LanguageServerClientOptions) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.maxOpenDocuments = Math.max(1, options.maxOpenDocuments ?? DEFAULT_MAX_OPEN_DOCUMENTS);
  }

  /** The position encoding the server settled on. Always UTF-16 for conformant servers. */
  get positionEncoding(): string {
    return this.encoding;
  }

  /** URIs currently held open with the server. */
  get openDocuments(): readonly string[] {
    return [...this.documents.keys()];
  }

  async initialize(): Promise<LanguageServerResult<unknown>> {
    if (this.initialized) return {};
    if (this.closed) return new LspError("closed", "Language server client is closed");
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeOnce();
    const result = await this.initializing;
    this.initializing = undefined;
    return result;
  }

  /** The LSP exit handshake. Callers that need the process gone should still close() after. */
  async shutdown(timeoutMs?: number): Promise<LanguageServerResult<void>> {
    if (this.closed) return;
    this.closed = true;
    const transport = this.transport;
    if (!transport) return;
    const deadline = timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      if (this.initialized) {
        await transport.request("shutdown", undefined, deadline);
        await transport.notify("exit");
      }
      await transport.close();
      this.forget();
    } catch (error: unknown) {
      await transport.close();
      this.forget();
      return asLspError(error);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.transport) await this.transport.close();
    this.forget();
  }

  /** Issue a raw request. Domain methods initialize first; raw callers control lifecycle. */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<LanguageServerResult<T>> {
    if (this.closed) return new LspError("closed", "Language server client is closed", { method });
    try {
      const transport = this.ensureTransport();
      const result = await transport.request(method, params, timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
      return result as T;
    } catch (error: unknown) {
      return asLspError(error);
    }
  }

  async definition(params?: unknown): Promise<LanguageServerResult<LspLocation | LspLocation[] | null>> {
    return this.call<LspLocation | LspLocation[] | null>("textDocument/definition", params);
  }

  async references(params?: unknown): Promise<LanguageServerResult<LspLocation[]>> {
    return this.call<LspLocation[]>("textDocument/references", params);
  }

  async hover(params?: unknown): Promise<LanguageServerResult<unknown>> {
    return this.call("textDocument/hover", params);
  }

  async rename(params?: unknown): Promise<LanguageServerResult<unknown>> {
    return this.call("textDocument/rename", params);
  }

  async diagnostics(params?: unknown): Promise<LanguageServerResult<LspDiagnostic[] | unknown>> {
    // Push-only servers (rust-analyzer, older gopls) reject the pull request outright;
    // their diagnostics arrive as publishDiagnostics notifications instead.
    if (!this.pullDiagnostics) {
      const pushed = await this.publishedFor(params);
      if (pushed !== undefined) return pushed;
    }
    const result = await this.call<LspDiagnostic[] | { items?: LspDiagnostic[] }>("textDocument/diagnostic", params);
    if (result instanceof LspError) {
      if (result.rpcCode !== LSP_METHOD_NOT_FOUND) return result;
      this.pullDiagnostics = false;
      const pushed = await this.publishedFor(params);
      return pushed ?? result;
    }
    if (Array.isArray(result)) return result;
    if (result && typeof result === "object" && "items" in result && Array.isArray(result.items)) return result.items;
    return result;
  }

  async codeAction(params?: unknown): Promise<LanguageServerResult<unknown[] | null>> {
    return this.call<unknown[] | null>("textDocument/codeAction", params);
  }

  private async initializeOnce(): Promise<LanguageServerResult<unknown>> {
    try {
      const transport = this.ensureTransport();
      // A root is not optional in practice: rust-analyzer will not index without one.
      const rootUri = this.options.rootUri ?? pathToFileURL(resolve(this.options.cwd)).href;
      const params = {
        processId: null,
        clientInfo: CLIENT_INFO,
        rootUri,
        capabilities: CLIENT_CAPABILITIES,
      };
      const result = await transport.request("initialize", params, this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.sync = syncPolicyFrom(result);
      const encoding = positionEncodingFrom(result);
      if (encoding !== undefined && encoding !== this.encoding) {
        this.encoding = encoding;
        this.options.onLog?.(`Language server chose position encoding ${encoding}; this client assumes utf-16 offsets.`);
      }
      await transport.notify("initialized", {});
      this.initialized = true;
      return result;
    } catch (error: unknown) {
      return asLspError(error, "process");
    }
  }

  private async call<T>(method: LspMethod, params?: unknown): Promise<LanguageServerResult<T>> {
    const initialized = await this.initialize();
    if (initialized instanceof LspError) return initialized;
    await this.syncDocument(params);
    return this.request<T>(method, params);
  }

  /**
   * Bring the server's view of the requested document up to date.
   *
   * Servers answer null for documents they were never told about, so every domain
   * request opens its document first, and reopens or changes it when the bytes on
   * disk moved underneath us.
   */
  private async syncDocument(params: unknown): Promise<void> {
    if (!this.sync.openClose) return;
    const uri = documentUri(params);
    if (uri === undefined) return;
    const path = pathFromUri(uri);
    if (path === undefined) return;
    let signature: string;
    let text: string;
    try {
      const info = await stat(path);
      if (!info.isFile()) return;
      signature = `${info.mtimeMs}:${info.size}`;
      const fresh = this.documents.get(uri);
      if (fresh !== undefined && fresh.signature === signature) {
        this.touch(uri, fresh);
        return;
      }
      text = await readFile(path, "utf8");
    } catch {
      // An unreadable path is the server's diagnostic to report, not ours to invent.
      return;
    }
    const known = this.documents.get(uri);
    if (known === undefined) {
      await this.openDocument(uri, languageIdFromPath(path), text, signature);
      return;
    }
    await this.changeDocument(uri, known, text, signature);
  }

  private async openDocument(uri: string, languageId: string, text: string, signature: string): Promise<void> {
    await this.evictDocuments();
    const document: OpenDocument = { languageId, version: 1, signature };
    this.documents.set(uri, document);
    await this.send("textDocument/didOpen", { textDocument: { uri, languageId, version: document.version, text } });
  }

  private async changeDocument(uri: string, document: OpenDocument, text: string, signature: string): Promise<void> {
    document.version += 1;
    document.signature = signature;
    this.touch(uri, document);
    if (this.sync.change === SYNC_NONE) {
      // The server takes no change notifications, so a reopen is the only way to refresh it.
      await this.send("textDocument/didClose", { textDocument: { uri } });
      await this.send("textDocument/didOpen", { textDocument: { uri, languageId: document.languageId, version: document.version, text } });
      return;
    }
    // A change event without a range is a full replacement, which every sync kind accepts.
    await this.send("textDocument/didChange", { textDocument: { uri, version: document.version }, contentChanges: [{ text }] });
  }

  private async evictDocuments(): Promise<void> {
    while (this.documents.size >= this.maxOpenDocuments) {
      const oldest = this.documents.keys().next();
      if (oldest.done === true) return;
      this.documents.delete(oldest.value);
      await this.send("textDocument/didClose", { textDocument: { uri: oldest.value } });
    }
  }

  private touch(uri: string, document: OpenDocument): void {
    this.documents.delete(uri);
    this.documents.set(uri, document);
  }

  /** Notifications have no reply, so a failure here surfaces on the request that follows. */
  private async send(method: string, params: unknown): Promise<void> {
    try {
      await this.ensureTransport().notify(method, params);
    } catch { /* the pending request reports the real failure */ }
  }

  private async publishedFor(params: unknown): Promise<LspDiagnostic[] | undefined> {
    const uri = documentUri(params);
    if (uri === undefined) return undefined;
    const initialized = await this.initialize();
    if (initialized instanceof LspError) return undefined;
    await this.syncDocument(params);
    return this.published.get(uri) ?? [];
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "textDocument/publishDiagnostics") return;
    const published = diagnosticsFrom(params);
    if (published === undefined) return;
    // Bounded alongside the open set: a server may publish for files we never asked about.
    this.published.delete(published.uri);
    while (this.published.size >= this.maxOpenDocuments * 2) {
      const oldest = this.published.keys().next();
      if (oldest.done === true) break;
      this.published.delete(oldest.value);
    }
    this.published.set(published.uri, published.diagnostics);
  }

  private forget(): void {
    this.initialized = false;
    this.documents.clear();
    this.published.clear();
  }

  private ensureTransport(): LspTransport {
    if (this.transport) return this.transport;
    if (this.closed) throw new LspError("closed", "Language server client is closed");
    try {
      this.process = this.spawn(this.options.command, this.options.args ?? [], this.options.cwd);
      this.transport = new LspJsonRpcTransport(this.process, {
        defaultTimeoutMs: this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(this.options.maxRequestTimeoutMs === undefined ? {} : { maxTimeoutMs: this.options.maxRequestTimeoutMs }),
        onNotification: (method, params) => { this.handleNotification(method, params); },
      });
      if (this.process.stderr && this.options.onLog) {
        const onLog = this.options.onLog;
        void (async () => {
          try {
            for await (const chunk of this.process?.stderr ?? []) {
              const line = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
              onLog(line);
            }
          } catch { /* stderr is diagnostic only */ }
        })();
      }
      return this.transport;
    } catch (error: unknown) {
      throw asLspError(error, "process");
    }
  }
}

export const LspClient = LanguageServerClient;
