import type {
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  LspProcess,
  LspTransport,
} from "./types.ts";

/** A failure produced while talking to a language server. */
export class LspError extends Error {
  readonly name = "LspError";
  readonly kind: "protocol" | "transport" | "timeout" | "server" | "closed" | "process";
  /** JSON-RPC's numeric error code, when this was a server error. */
  readonly rpcCode?: number;
  readonly data?: unknown;
  readonly method?: string;

  constructor(
    kind: LspError["kind"],
    message: string,
    options: { rpcCode?: number; data?: unknown; method?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.kind = kind;
    if (options.rpcCode !== undefined) this.rpcCode = options.rpcCode;
    if (options.data !== undefined) this.data = options.data;
    if (options.method !== undefined) this.method = options.method;
  }

  /** String code is convenient for callers; RPC callers can inspect rpcCode. */
  get code(): string | number {
    return this.rpcCode ?? this.kind;
  }
}

export function isLspError(error: unknown): error is LspError {
  return error instanceof LspError;
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: LspError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface LspJsonRpcTransportOptions {
  /** Default request deadline. Values are always capped at `maxTimeoutMs`. */
  defaultTimeoutMs?: number;
  /** Hard ceiling for every request on this transport. Defaults to the §3.4 LSP deadline of 20s. */
  maxTimeoutMs?: number;
  /** Server-initiated notifications: $/progress, publishDiagnostics, logMessage, ... */
  onNotification?: (method: string, params: unknown) => void;
}

const MAX_TIMEOUT_MS = 20_000;
/** JSON-RPC's MethodNotFound. Server→client requests we do not implement get this. */
export const LSP_METHOD_NOT_FOUND = -32601;
/** Marks a server→client request this client deliberately does not implement. */
const UNSUPPORTED = Symbol("lsp-unsupported-request");
const textEncoder = new TextEncoder();

function bytesFromChunk(chunk: Uint8Array | string): Uint8Array<ArrayBuffer> {
  return typeof chunk === "string" ? textEncoder.encode(chunk) : Uint8Array.from(chunk);
}

function appendBytes(left: Uint8Array<ArrayBuffer>, right: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;

}

function findHeaderEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}

function sameId(a: JsonRpcId | null, b: JsonRpcId): boolean {
  return a !== null && (typeof a === typeof b) && a === b;
}

function parseContentLength(header: string): number {
  const lines = header.split("\r\n");
  let length: number | undefined;
  for (const line of lines) {
    if (line.length === 0) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new LspError("protocol", `Malformed LSP header line: ${JSON.stringify(line)}`);
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name !== "content-length") continue;
    if (length !== undefined) throw new LspError("protocol", "Duplicate Content-Length header");
    if (!/^\d+$/.test(value)) throw new LspError("protocol", `Invalid Content-Length: ${JSON.stringify(value)}`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new LspError("protocol", "Content-Length exceeds safe integer range");
    length = parsed;
  }
  if (length === undefined) throw new LspError("protocol", "LSP frame has no Content-Length header");
  return length;
}

/**
 * Minimal answers to the server→client requests real servers send unprompted.
 *
 * rust-analyzer and pyright open progress tokens, pull configuration and register
 * capabilities during startup. Leaving any of them unanswered stalls indexing, and
 * treating them as protocol violations tears down an otherwise healthy session.
 */
function serverRequestResult(method: string, params: unknown): unknown {
  switch (method) {
    case "window/workDoneProgress/create":
    case "client/registerCapability":
    case "client/unregisterCapability":
    case "window/showMessageRequest":
    case "workspace/workspaceFolders":
    case "workspace/codeLens/refresh":
    case "workspace/diagnostic/refresh":
    case "workspace/inlayHint/refresh":
    case "workspace/inlineValue/refresh":
    case "workspace/semanticTokens/refresh":
      return null;
    case "workspace/configuration": {
      // One entry per requested section; null means "this client configures nothing".
      const items = params !== null && typeof params === "object" ? (params as { items?: unknown }).items : undefined;
      return Array.isArray(items) ? items.map(() => null) : [];
    }
    // This client never applies server-driven edits or navigation on its own.
    case "workspace/applyEdit":
      return { applied: false };
    case "window/showDocument":
      return { success: false };
    default:
      return UNSUPPORTED;
  }
}

/** JSON-RPC 2.0 transport using LSP's byte-counted stdio framing. */
export class LspJsonRpcTransport implements LspTransport {
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly onNotification: ((method: string, params: unknown) => void) | undefined;
  private input = new Uint8Array(0);
  private nextId = 1;
  private writeQueue: Promise<void> = Promise.resolve();
  private readerStarted = false;
  private closed = false;
  private terminalError: LspError | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly process: LspProcess, options: LspJsonRpcTransportOptions = {}) {
    this.maxTimeoutMs = clampTimeout(options.maxTimeoutMs ?? MAX_TIMEOUT_MS, Number.MAX_SAFE_INTEGER);
    this.defaultTimeoutMs = clampTimeout(options.defaultTimeoutMs ?? this.maxTimeoutMs, this.maxTimeoutMs);
    this.onNotification = options.onNotification;
    this.startReader();
    if (process.exited) {
      void process.exited.then((code) => {
        if (!this.closed) this.fail(new LspError("process", `Language server exited with code ${code}`));
      }).catch((error: unknown) => {
        if (!this.closed) this.fail(new LspError("process", "Language server process failed", { cause: error }));
      });
    }
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(this.terminalError ?? new LspError("closed", "LSP transport is closed", { method }));
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    if (params !== undefined) request.params = params;
    const timeout = clampTimeout(timeoutMs ?? this.defaultTimeoutMs, this.maxTimeoutMs);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        const error = new LspError("timeout", `LSP request timed out after ${timeout}ms: ${method}`, { method });
        pending.reject(error);
        // A timed-out server cannot be safely correlated with subsequent replies.
        this.fail(error);
      }, timeout);
      this.pending.set(id, { method, resolve, reject, timer });
      void this.enqueueWrite(encodeFrame(request)).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(toLspError(error, "transport", method));
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return Promise.reject(this.terminalError ?? new LspError("closed", "LSP transport is closed", { method }));
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method };
    if (params !== undefined) notification.params = params;
    return this.enqueueWrite(encodeFrame(notification));
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.terminalError ??= new LspError("closed", "LSP transport is closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.terminalError);
    }
    this.pending.clear();
    try { this.process.kill(); } catch { /* process may already have exited */ }
    try {
      const end = this.process.stdin.end;
      if (end) await end.call(this.process.stdin);
    } catch { /* killing the process is the authoritative close operation */ }
    this.closePromise = Promise.resolve();
    return this.closePromise;
  }

  private startReader(): void {
    if (this.readerStarted) return;
    this.readerStarted = true;
    void this.readStdout();
  }

  private async readStdout(): Promise<void> {
    try {
      for await (const chunk of this.process.stdout) {
        if (this.closed) return;
        this.input = appendBytes(this.input, bytesFromChunk(chunk));
        this.parseFrames();
      }
      if (!this.closed) this.fail(new LspError("process", "Language server stdout reached EOF"));
    } catch (error: unknown) {
      if (!this.closed) this.fail(toLspError(error, "transport"));
    }
  }

  private parseFrames(): void {
    while (!this.closed) {
      const headerEnd = findHeaderEnd(this.input);
      if (headerEnd < 0) return;
      let length: number;
      try {
        length = parseContentLength(new TextDecoder().decode(this.input.subarray(0, headerEnd)));
      } catch (error: unknown) {
        this.fail(toLspError(error, "protocol"));
        return;
      }
      const bodyStart = headerEnd + 4;
      if (this.input.byteLength < bodyStart + length) return;
      const body = this.input.subarray(bodyStart, bodyStart + length);
      this.input = this.input.slice(bodyStart + length);
      let message: unknown;
      try {
        message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch (error: unknown) {
        this.fail(new LspError("protocol", "Invalid JSON in LSP response", { cause: error }));
        return;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.fail(new LspError("protocol", "LSP response must be a JSON object"));
      return;
    }
    const envelope = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    if (envelope.jsonrpc !== "2.0") {
      this.fail(new LspError("protocol", "LSP response has invalid jsonrpc or id"));
      return;
    }
    // Server-initiated traffic carries a method: with an id it is a request, without one a notification.
    if (typeof envelope.method === "string") {
      if (envelope.id === undefined || envelope.id === null) {
        this.onNotification?.(envelope.method, envelope.params);
        return;
      }
      if (typeof envelope.id !== "string" && typeof envelope.id !== "number") {
        this.fail(new LspError("protocol", "LSP request id must be a string or number"));
        return;
      }
      this.answerServerRequest(envelope.id, envelope.method, envelope.params);
      return;
    }
    const response = message as Partial<JsonRpcResponse>;
    if (response.id === undefined) {
      this.fail(new LspError("protocol", "LSP response has invalid jsonrpc or id"));
      return;
    }
    if (typeof response.id !== "string" && typeof response.id !== "number") {
      this.fail(new LspError("protocol", "LSP response id must be a string or number"));
      return;
    }
    const pending = [...this.pending.entries()].find(([id]) => sameId(response.id as JsonRpcId, id));
    if (!pending) {
      this.fail(new LspError("protocol", `LSP response id does not match a pending request: ${String(response.id)}`));
      return;
    }
    const [id, request] = pending;
    this.pending.delete(id);
    clearTimeout(request.timer);
    if (response.error !== undefined) {
      const rpcError = response.error;
      if (!rpcError || typeof rpcError !== "object" || typeof rpcError.code !== "number" || typeof rpcError.message !== "string") {
        request.reject(new LspError("protocol", "Malformed JSON-RPC error response", { method: request.method }));
      } else {
        request.reject(new LspError("server", rpcError.message, { rpcCode: rpcError.code, data: rpcError.data, method: request.method }));
      }
      return;
    }
    if (!("result" in response)) {
      request.reject(new LspError("protocol", "JSON-RPC response has neither result nor error", { method: request.method }));
      return;
    }
    request.resolve(response.result);
  }

  private answerServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    const result = serverRequestResult(method, params);
    const response: JsonRpcResponse = result === UNSUPPORTED
      ? { jsonrpc: "2.0", id, error: { code: LSP_METHOD_NOT_FOUND, message: `Unsupported client method: ${method}` } }
      : { jsonrpc: "2.0", id, result };
    // A failed reply already fails the transport; it must not also reject unobserved here.
    void this.enqueueWrite(encodeFrame(response)).catch(() => undefined);
  }

  private enqueueWrite(data: Uint8Array): Promise<void> {
    const write = this.writeQueue.then(async () => {
      if (this.closed) throw this.terminalError ?? new LspError("closed", "LSP transport is closed");
      await this.process.stdin.write(data);
    });
    const settled = write.catch((error: unknown) => {
      const typed = toLspError(error, "transport");
      this.fail(typed);
      throw typed;
    });
    this.writeQueue = settled.catch(() => undefined);
    return settled;
  }

  private fail(error: LspError): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    try { this.process.kill(); } catch { /* best effort */ }
  }
}

export const JsonRpcTransport = LspJsonRpcTransport;
export const LspTransportImpl = LspJsonRpcTransport;

export function encodeFrame(message: unknown): Uint8Array {
  const body = textEncoder.encode(JSON.stringify(message));
  const header = textEncoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
  return appendBytes(header, body);
}

function clampTimeout(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return max;
  return Math.min(Math.floor(value), max);
}

function toLspError(error: unknown, kind: LspError["kind"] = "transport", method?: string): LspError {
  if (error instanceof LspError) return error;
  const options: { cause: unknown; method?: string } = { cause: error };
  if (method !== undefined) options.method = method;
  return new LspError(kind, error instanceof Error ? error.message : String(error), options);
}
