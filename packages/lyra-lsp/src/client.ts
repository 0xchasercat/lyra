import type {
  LanguageServerClientOptions,
  LspDiagnostic,
  LspLocation,
  LspMethod,
  LspProcess,
  LspSpawn,
  LspTransport,
} from "./types.ts";
import { LspError, LspJsonRpcTransport } from "./protocol.ts";

export type LanguageServerResult<T> = T | LspError;

const DEFAULT_TIMEOUT_MS = 20_000;

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

/** A small LSP client with deliberately narrow, provider-facing operations. */
export class LanguageServerClient {
  private readonly spawn: LspSpawn;
  private transport: LspTransport | undefined;
  private process: LspProcess | undefined;
  private initialized = false;
  private initializing: Promise<LanguageServerResult<unknown>> | undefined;
  private closed = false;

  constructor(private readonly options: LanguageServerClientOptions) {
    this.spawn = options.spawn ?? defaultSpawn;
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

  async shutdown(): Promise<LanguageServerResult<void>> {
    if (this.closed) return;
    this.closed = true;
    const transport = this.transport;
    if (!transport) return;
    try {
      if (this.initialized) {
        await transport.request("shutdown", undefined, this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
        await transport.notify("exit");
      }
      await transport.close();
      this.initialized = false;
    } catch (error: unknown) {
      await transport.close();
      return asLspError(error);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.transport) await this.transport.close();
    this.initialized = false;
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
    const result = await this.call<LspDiagnostic[] | { items?: LspDiagnostic[] }>("textDocument/diagnostic", params);
    if (result instanceof LspError) return result;
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
      const params: { processId: null; rootUri?: string; capabilities: Record<string, never> } = {
        processId: null,
        capabilities: {},
      };
      if (this.options.rootUri !== undefined) params.rootUri = this.options.rootUri;
      const result = await transport.request("initialize", params, this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
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
    return this.request<T>(method, params);
  }

  private ensureTransport(): LspTransport {
    if (this.transport) return this.transport;
    if (this.closed) throw new LspError("closed", "Language server client is closed");
    try {
      this.process = this.spawn(this.options.command, this.options.args ?? [], this.options.cwd);
      this.transport = new LspJsonRpcTransport(this.process, {
        defaultTimeoutMs: this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
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
