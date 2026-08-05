import { ACP_METHODS, type AcpCapabilities, type AcpDaemonOptions, type AcpHandlerContext, type AcpMethod, type AcpWriter, type JsonRpcId } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
interface PendingClient { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; }
interface RpcError { code: number; message: string; data?: unknown; }

export class AcpError extends Error { readonly code: number; readonly data: unknown; constructor(code: number, message: string, data?: unknown) { super(message); this.name = "AcpError"; this.code = code; this.data = data; } }

export class AcpDaemon {
  readonly capabilities: AcpCapabilities = Object.freeze({ methods: ACP_METHODS, bidirectional: true, cancellation: true, transport: "stdio" });
  readonly #options: Required<Pick<AcpDaemonOptions, "requestTimeoutMs" | "serverName" | "serverVersion">> & AcpDaemonOptions;
  readonly #active = new Map<JsonRpcId, AbortController>();
  readonly #clientPending = new Map<JsonRpcId, PendingClient>();
  #writer: AcpWriter | undefined;
  #writeTail: Promise<void> = Promise.resolve();
  #clientSequence = 0;
  #closed = false;

  constructor(options: AcpDaemonOptions) {
    if (!options || typeof options !== "object" || !options.handlers || typeof options.handlers !== "object") throw new TypeError("ACP handlers are required.");
    const timeout = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1) throw new RangeError("ACP requestTimeoutMs must be a positive integer.");
    this.#options = { requestTimeoutMs: timeout, serverName: options.serverName ?? "lyra", serverVersion: options.serverVersion ?? "0.1.0", ...options };
  }

  async serve(input: AsyncIterable<Uint8Array | string>, writer: AcpWriter): Promise<void> {
    if (this.#writer) throw new AcpError(-32000, "ACP daemon is already serving a connection.");
    this.#writer = writer;
    let buffer = "";
    try {
      for await (const chunk of input) {
        if (this.#closed) break;
        buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) await this.handleLine(line);
          newline = buffer.indexOf("\n");
        }
      }
      if (buffer.trim().length > 0) await this.handleLine(buffer.trim());
    } finally { await this.close(); }
  }

  async handleLine(line: string, writer?: AcpWriter): Promise<void> {
    if (writer) this.#writer = writer;
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { await this.writeError(null, { code: -32700, message: "Parse error: each ACP stdio line must be one JSON-RPC object." }); return; }
    await this.handleMessage(message);
  }

  async notify(method: string, params?: unknown): Promise<void> { this.assertOpen(); if (typeof method !== "string" || method.length === 0) throw new AcpError(-32600, "Notification method must be non-empty."); await this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }); }

  async requestClient(method: string, params?: unknown, timeoutMs = this.#options.requestTimeoutMs): Promise<unknown> {
    this.assertOpen();
    if (typeof method !== "string" || method.length === 0) throw new AcpError(-32600, "Client request method must be non-empty.");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new AcpError(-32600, "Client request timeout must be positive.");
    const id = `server-${++this.#clientSequence}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.#clientPending.delete(id); reject(new AcpError(-32001, `ACP client request ${method} exceeded ${timeoutMs}ms.`)); }, Math.min(timeoutMs, DEFAULT_TIMEOUT_MS));
      this.#clientPending.set(id, { resolve, reject, timer });
    });
    await this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return result;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#active.values()) controller.abort(new AcpError(-32800, "ACP connection closed."));
    this.#active.clear();
    for (const pending of this.#clientPending.values()) { clearTimeout(pending.timer); pending.reject(new AcpError(-32000, "ACP connection closed.")); }
    this.#clientPending.clear();
    await this.#writeTail.catch(() => undefined);
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (!isRecord(value) || value.jsonrpc !== "2.0") { await this.writeError(requestId(value), { code: -32600, message: "Invalid JSON-RPC request." }); return; }
    if (typeof value.method !== "string") { this.handleClientResponse(value); return; }
    if (value.method === "$/cancelRequest") { this.cancelFrom(value.params); return; }
    const id = validId(value.id) ? value.id : undefined;
    if (value.id !== undefined && id === undefined) { await this.writeError(null, { code: -32600, message: "JSON-RPC id must be a string or number." }); return; }
    if (id === undefined) { void this.dispatchNotification(value.method, value.params); return; }
    void this.dispatchRequest(id, value.method, value.params);
  }

  private async dispatchRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    if (this.#active.has(id)) { await this.writeError(id, { code: -32600, message: `Duplicate in-flight request id ${String(id)}.` }); return; }
    const controller = new AbortController();
    this.#active.set(id, controller);
    const timeout = setTimeout(() => controller.abort(new AcpError(-32001, `ACP request ${method} exceeded ${this.#options.requestTimeoutMs}ms.`)), this.#options.requestTimeoutMs);
    try {
      const result = await Promise.race([this.invoke(method, params, id, controller.signal), abortPromise(controller.signal)]);
      await this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) { await this.writeError(id, rpcError(error, controller.signal)); }
    finally { clearTimeout(timeout); this.#active.delete(id); }
  }

  private async dispatchNotification(method: string, params: unknown): Promise<void> {
    try { await this.invoke(method, params, `notification-${Date.now()}`, new AbortController().signal); } catch { /* notifications have no response channel */ }
  }

  private async invoke(method: string, params: unknown, id: JsonRpcId, signal: AbortSignal): Promise<unknown> {
    if (method === "initialize") return { protocolVersion: "1", serverInfo: { name: this.#options.serverName, version: this.#options.serverVersion }, capabilities: this.capabilities };
    if (!isAcpMethod(method)) throw new AcpError(-32601, `ACP method not found: ${method}.`);
    const handler = this.#options.handlers[method];
    if (!handler) throw new AcpError(-32601, `ACP method ${method} is not configured by this control plane.`);
    const context: AcpHandlerContext = { id, signal, notify: (name, value) => this.notify(name, value), requestClient: (name, value, timeout) => this.requestClient(name, value, timeout) };
    return handler(params, context);
  }

  private cancelFrom(params: unknown): void {
    if (!isRecord(params) || !validId(params.id)) return;
    this.#active.get(params.id)?.abort(new AcpError(-32800, `ACP request ${String(params.id)} was cancelled by the client.`));
  }

  private handleClientResponse(value: Record<string, unknown>): void {
    if (!validId(value.id)) return;
    const pending = this.#clientPending.get(value.id);
    if (!pending) return;
    this.#clientPending.delete(value.id); clearTimeout(pending.timer);
    if (isRecord(value.error) && typeof value.error.code === "number" && typeof value.error.message === "string") pending.reject(new AcpError(value.error.code, value.error.message, value.error.data));
    else if ("result" in value) pending.resolve(value.result);
    else pending.reject(new AcpError(-32600, "Client response lacks result or error."));
  }

  private async write(value: unknown): Promise<void> { if (!this.#writer) throw new AcpError(-32000, "ACP writer is not attached."); const line = `${JSON.stringify(value)}\n`; this.#writeTail = this.#writeTail.then(async () => { await this.#writer!.write(line); }); return this.#writeTail; }
  private writeError(id: JsonRpcId | null, error: RpcError): Promise<void> { return this.write({ jsonrpc: "2.0", id, error }); }
  private assertOpen(): void { if (this.#closed) throw new AcpError(-32000, "ACP daemon is closed."); if (!this.#writer) throw new AcpError(-32000, "ACP writer is not attached."); }
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validId(value: unknown): value is JsonRpcId { return typeof value === "string" || typeof value === "number" && Number.isFinite(value); }
function requestId(value: unknown): JsonRpcId | null { return isRecord(value) && validId(value.id) ? value.id : null; }
function isAcpMethod(value: string): value is AcpMethod { return (ACP_METHODS as readonly string[]).includes(value); }
function rpcError(error: unknown, signal: AbortSignal): RpcError { const reason = signal.aborted ? signal.reason : error; if (reason instanceof AcpError) return { code: reason.code, message: reason.message, ...(reason.data === undefined ? {} : { data: reason.data }) }; return { code: -32603, message: reason instanceof Error ? reason.message : String(reason) }; }
function abortPromise(signal: AbortSignal): Promise<never> { if (signal.aborted) return Promise.reject(signal.reason); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
