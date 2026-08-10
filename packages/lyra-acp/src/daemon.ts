import { ACP_DEFAULT_TURN_TIMEOUT_MS, ACP_METHODS, ACP_TURN_METHODS, type AcpCapabilities, type AcpDaemonOptions, type AcpHandlerContext, type AcpMethod, type AcpWriter, type JsonRpcId } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
// setTimeout keeps its delay in a signed 32-bit integer; a larger delay fires immediately and turns
// a deadline into a no-op. This is the only bound on a configured timeout, and it is explicit: a
// timeout above it is rejected rather than silently shortened (§3.4 — every deadline has a defined expiry).
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 32;
interface PendingClient { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; }
interface RpcError { code: number; message: string; data?: unknown; }

export class AcpError extends Error { readonly code: number; readonly data: unknown; constructor(code: number, message: string, data?: unknown) { super(message); this.name = "AcpError"; this.code = code; this.data = data; } }

export class AcpDaemon {
  readonly capabilities: AcpCapabilities = Object.freeze({ methods: ACP_METHODS, bidirectional: true, cancellation: true, transport: "stdio" });
  readonly #options: Required<Pick<AcpDaemonOptions, "requestTimeoutMs" | "turnTimeoutMs" | "maxFrameBytes" | "maxConcurrentRequests" | "serverName" | "serverVersion">> & AcpDaemonOptions;
  readonly #active = new Map<JsonRpcId | symbol, AbortController>();
  readonly #operations = new Set<Promise<void>>();
  readonly #clientPending = new Map<JsonRpcId, PendingClient>();
  #writer: AcpWriter | undefined;
  #writeTail: Promise<void> = Promise.resolve();
  #clientSequence = 0;
  #notificationSequence = 0;
  #closed = false;

  constructor(options: AcpDaemonOptions) {
    if (!options || typeof options !== "object" || !options.handlers || typeof options.handlers !== "object") throw new TypeError("ACP handlers are required.");
    const timeout = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const turnTimeout = options.turnTimeoutMs ?? ACP_DEFAULT_TURN_TIMEOUT_MS;
    const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    const maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) throw new RangeError(`ACP requestTimeoutMs must be a positive integer no greater than ${MAX_TIMEOUT_MS}.`);
    if (!Number.isSafeInteger(turnTimeout) || turnTimeout < 1 || turnTimeout > MAX_TIMEOUT_MS) throw new RangeError(`ACP turnTimeoutMs must be a positive integer no greater than ${MAX_TIMEOUT_MS}.`);
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new RangeError("ACP maxFrameBytes must be a positive integer.");
    if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1) throw new RangeError("ACP maxConcurrentRequests must be a positive integer.");
    this.#options = { requestTimeoutMs: timeout, turnTimeoutMs: turnTimeout, maxFrameBytes, maxConcurrentRequests, serverName: options.serverName ?? "lyra", serverVersion: options.serverVersion ?? "0.1.0", ...options };
  }

  /**
   * The deadline one method gets, from the class it belongs to.
   *
   * A turn is a 30-minute operation by §3.4 and a question is a 60-second one; one number
   * for both meant the shorter of the two won, and `session/prompt` died mid-turn at 60s.
   * The deadline still *exists* either way — §3.4's rule is that nothing blocks forever,
   * not that everything blocks for the same length of time.
   */
  private deadlineFor(method: string): number {
    return (ACP_TURN_METHODS as readonly string[]).includes(method) ? this.#options.turnTimeoutMs : this.#options.requestTimeoutMs;
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
          const rawLine = buffer.slice(0, newline);
          if (Buffer.byteLength(rawLine) > this.#options.maxFrameBytes) { await this.writeError(null, { code: -32003, message: `ACP frame exceeds ${this.#options.maxFrameBytes} bytes.` }); return; }
          const line = rawLine.trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) await this.handleLine(line);
          newline = buffer.indexOf("\n");
        }
        if (Buffer.byteLength(buffer) > this.#options.maxFrameBytes) { await this.writeError(null, { code: -32003, message: `ACP frame exceeds ${this.#options.maxFrameBytes} bytes.` }); return; }
      }
      if (buffer.trim().length > 0) await this.handleLine(buffer.trim());
    } finally { await this.close(); }
  }

  async handleLine(line: string, writer?: AcpWriter): Promise<void> {
    if (writer) this.#writer = writer;
    if (Buffer.byteLength(line) > this.#options.maxFrameBytes) { await this.writeError(null, { code: -32003, message: `ACP frame exceeds ${this.#options.maxFrameBytes} bytes.` }); return; }
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { await this.writeError(null, { code: -32700, message: "Parse error: each ACP stdio line must be one JSON-RPC object." }); return; }
    await this.handleMessage(message);
  }

  async notify(method: string, params?: unknown): Promise<void> { this.assertOpen(); if (typeof method !== "string" || method.length === 0) throw new AcpError(-32600, "Notification method must be non-empty."); await this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }); }

  async requestClient(method: string, params?: unknown, timeoutMs = this.#options.requestTimeoutMs): Promise<unknown> {
    this.assertOpen();
    if (typeof method !== "string" || method.length === 0) throw new AcpError(-32600, "Client request method must be non-empty.");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new AcpError(-32600, `Client request timeout must be a positive integer no greater than ${MAX_TIMEOUT_MS}ms.`);
    const id = `server-${++this.#clientSequence}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.#clientPending.delete(id); reject(new AcpError(-32001, `ACP client request ${method} exceeded ${timeoutMs}ms.`)); }, timeoutMs);
      this.#clientPending.set(id, { resolve, reject, timer });
    });
    // A failed write must settle this request through the pending entry, so the caller observes it
    // exactly once via the returned promise and the timer can never reject an unobserved promise.
    await this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }).catch((error: unknown) => this.settleClientRequest(id, error instanceof AcpError ? error : new AcpError(-32000, `ACP client request ${method} could not be written: ${error instanceof Error ? error.message : String(error)}`)));
    return result;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#active.values()) controller.abort(new AcpError(-32800, "ACP connection closed."));
    for (const pending of this.#clientPending.values()) { clearTimeout(pending.timer); pending.reject(new AcpError(-32000, "ACP connection closed.")); }
    this.#clientPending.clear();
    await Promise.allSettled([...this.#operations]);
    this.#active.clear();
    await this.#writeTail.catch(() => undefined);
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (!isRecord(value) || value.jsonrpc !== "2.0") { await this.writeError(requestId(value), { code: -32600, message: "Invalid JSON-RPC request." }); return; }
    if (typeof value.method !== "string") { this.handleClientResponse(value); return; }
    if (value.method === "$/cancelRequest") { this.cancelFrom(value.params); return; }
    const id = validId(value.id) ? value.id : undefined;
    if (value.id !== undefined && id === undefined) { await this.writeError(null, { code: -32600, message: "JSON-RPC id must be a string or number." }); return; }
    if (id === undefined) { this.launch(this.dispatchNotification(value.method, value.params)); return; }
    this.launch(this.dispatchRequest(id, value.method, value.params));
  }

  private async dispatchRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    if (this.#active.has(id)) { await this.writeError(id, { code: -32600, message: `Duplicate in-flight request id ${String(id)}.` }); return; }
    if (this.#active.size >= this.#options.maxConcurrentRequests) { await this.writeError(id, { code: -32002, message: `ACP concurrency limit ${this.#options.maxConcurrentRequests} reached.` }); return; }
    const controller = new AbortController();
    this.#active.set(id, controller);
    const deadlineMs = this.deadlineFor(method);
    const timeout = setTimeout(() => controller.abort(new AcpError(-32001, `ACP request ${method} exceeded ${deadlineMs}ms.`)), deadlineMs);
    const invocation = Promise.resolve(this.invoke(method, params, id, controller.signal));
    try {
      const result = await Promise.race([invocation, abortPromise(controller.signal)]);
      await this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) { await this.writeError(id, rpcError(error, controller.signal)); }
    finally { clearTimeout(timeout); await invocation.catch(() => undefined); this.#active.delete(id); }
  }

  private async dispatchNotification(method: string, params: unknown): Promise<void> {
    if (this.#active.size >= this.#options.maxConcurrentRequests) return;
    const label = `notification-${++this.#notificationSequence}`;
    // Notifications have no client-visible id, so they occupy the concurrency map under a unique
    // symbol: a client is free to send a request whose literal id is "notification-1".
    const key = Symbol(label);
    const controller = new AbortController(); this.#active.set(key, controller);
    const deadlineMs = this.deadlineFor(method);
    const timeout = setTimeout(() => controller.abort(new AcpError(-32001, `ACP notification ${method} exceeded ${deadlineMs}ms.`)), deadlineMs);
    const invocation = Promise.resolve(this.invoke(method, params, label, controller.signal));
    try { await Promise.race([invocation, abortPromise(controller.signal)]); } catch { /* notifications have no response channel */ }
    finally { clearTimeout(timeout); await invocation.catch(() => undefined); this.#active.delete(key); }
  }

  private launch(operation: Promise<void>): void { this.#operations.add(operation); void operation.then(() => this.#operations.delete(operation), () => this.#operations.delete(operation)); }

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

  private settleClientRequest(id: JsonRpcId, error: unknown): void {
    const pending = this.#clientPending.get(id);
    if (!pending) return;
    this.#clientPending.delete(id); clearTimeout(pending.timer); pending.reject(error);
  }

  // One failed write rejects that write for its caller only: the tail carries the recovered promise
  // so every later frame on this connection is still attempted in order.
  private async write(value: unknown): Promise<void> { if (!this.#writer) throw new AcpError(-32000, "ACP writer is not attached."); const line = `${JSON.stringify(value)}\n`; const attempt = this.#writeTail.then(async () => { await this.#writer!.write(line); }); this.#writeTail = attempt.catch(() => undefined); return attempt; }
  private writeError(id: JsonRpcId | null, error: RpcError): Promise<void> { return this.write({ jsonrpc: "2.0", id, error }); }
  private assertOpen(): void { if (this.#closed) throw new AcpError(-32000, "ACP daemon is closed."); if (!this.#writer) throw new AcpError(-32000, "ACP writer is not attached."); }
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validId(value: unknown): value is JsonRpcId { return typeof value === "string" || typeof value === "number" && Number.isFinite(value); }
function requestId(value: unknown): JsonRpcId | null { return isRecord(value) && validId(value.id) ? value.id : null; }
function isAcpMethod(value: string): value is AcpMethod { return (ACP_METHODS as readonly string[]).includes(value); }
function rpcError(error: unknown, signal: AbortSignal): RpcError {
  const reason = signal.aborted ? signal.reason : error;
  if (reason instanceof AcpError) return { code: reason.code, message: reason.message, ...(reason.data === undefined ? {} : { data: reason.data }) };
  const data = errorData(reason);
  return { code: -32603, message: reason instanceof Error ? reason.message : String(reason), ...(data === undefined ? {} : { data }) };
}
function errorData(error: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = error as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const key of ["name", "classification", "code", "status", "retryAfterMs"] as const) {
    if (typeof value[key] === "string" || typeof value[key] === "number") data[key] = value[key];
  }
  return Object.keys(data).length === 0 ? undefined : data;
}
function abortPromise(signal: AbortSignal): Promise<never> { if (signal.aborted) return Promise.reject(signal.reason); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
