import type { McpCallResult, McpClientOptions, McpToolDescriptor } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
// setTimeout keeps its delay in a signed 32-bit integer; a larger delay fires immediately and turns
// a deadline into a no-op. This is the only bound on a configured timeout — 60s is the default
// (§3.4 "MCP call | 60s"), never a silent ceiling on what the workspace configured.
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export class McpError extends Error {
  readonly code: string | number;
  constructor(code: string | number, message: string) { super(message); this.name = "McpError"; this.code = code; }
}
interface Pending { method: string; resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout>; cleanup?: () => void; }

export class McpStdioClient {
  readonly name: string;
  readonly options: McpClientOptions;
  readonly #process: Bun.Subprocess;
  readonly #pending = new Map<number, Pending>();
  #writeTail: Promise<void> = Promise.resolve();
  #nextId = 1;
  #buffer = "";
  #closed = false;
  #initialized = false;
  #reader: Promise<void>;
  constructor(options: McpClientOptions) {
    if (!options || typeof options.name !== "string" || options.name.trim().length === 0) throw new TypeError("MCP server name is required.");
    if (typeof options.command !== "string" || options.command.trim().length === 0) throw new TypeError("MCP server command is required.");
    this.name = options.name;
    this.options = options;
    const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: process.env.LANG ?? "C.UTF-8", ...(options.env ?? {}) };
    const spawnOptions = options.cwd === undefined ? { stdin: "pipe" as const, stdout: "pipe" as const, stderr: "pipe" as const, env } : { cwd: options.cwd, stdin: "pipe" as const, stdout: "pipe" as const, stderr: "pipe" as const, env };
    this.#process = Bun.spawn([options.command, ...(options.args ?? [])], spawnOptions);
    this.#reader = this.readStdout();
    if (typeof this.#process.stderr !== "number") void this.readStderr();
    void this.#process.exited.then((code) => { if (!this.#closed) this.fail(new McpError("process", `MCP server ${this.name} exited with code ${code}.`)); });
  }
  get closed(): boolean { return this.#closed; }
  async initialize(signal?: AbortSignal): Promise<unknown> {
    if (this.#initialized) return undefined;
    const result = await this.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "lyra", version: "0.1.0" } }, signal);
    await this.notify("notifications/initialized", {});
    this.#initialized = true;
    return result;
  }
  async listTools(cursor?: string, signal?: AbortSignal): Promise<{ tools: McpToolDescriptor[]; nextCursor?: string }> {
    await this.initialize(signal);
    const result = await this.request("tools/list", cursor === undefined ? {} : { cursor }, signal);
    if (!result || typeof result !== "object" || !Array.isArray((result as { tools?: unknown }).tools)) throw new McpError("protocol", `MCP server ${this.name} returned an invalid tools/list result.`);
    const tools = (result as { tools: unknown[] }).tools.map((tool) => {
      if (!tool || typeof tool !== "object" || typeof (tool as { name?: unknown }).name !== "string") throw new McpError("protocol", `MCP server ${this.name} returned a tool without a name.`);
      const value = tool as Record<string, unknown>;
      return { server: this.name, name: value.name as string, description: typeof value.description === "string" ? value.description : "MCP tool", inputSchema: value.inputSchema && typeof value.inputSchema === "object" ? value.inputSchema as Readonly<Record<string, unknown>> : { type: "object" }, ...(value.annotations && typeof value.annotations === "object" ? { annotations: value.annotations as Readonly<Record<string, unknown>> } : {}) };
    });
    const next = (result as { nextCursor?: unknown }).nextCursor;
    return { tools, ...(typeof next === "string" && next.length > 0 ? { nextCursor: next } : {}) };
  }
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    if (typeof name !== "string" || name.length === 0) throw new McpError("invalid_request", "MCP tool name must be non-empty.");
    await this.initialize(signal);
    const result = await this.request("tools/call", { name, arguments: args ?? {} }, signal);
    if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) throw new McpError("protocol", `MCP server ${this.name} returned an invalid tools/call result.`);
    const value = result as { content: unknown; isError?: unknown; structuredContent?: unknown };
    return { content: value.content, ...(value.isError === true ? { isError: true } : {}), ...(value.structuredContent === undefined ? {} : { structuredContent: value.structuredContent }) };
  }
  async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new McpError("closed", `MCP server ${this.name} is closed.`);
    if (typeof method !== "string" || method.length === 0) throw new McpError("invalid_request", "MCP method must be non-empty.");
    if (signal?.aborted) throw signal.reason;
    const id = this.#nextId++;
    const configured = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(Number.isFinite(configured) ? configured : DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n";
    return new Promise((resolve, reject) => {
      // A deadline or a cancel settles this request alone; concurrent callers keep the shared server.
      const timer = setTimeout(() => this.settle(id, new McpError("timeout", `MCP request ${method} exceeded ${timeoutMs}ms.`), "timeout"), timeoutMs);
      const onAbort = (): void => this.settle(id, signal?.reason ?? new McpError("cancelled", `MCP request ${method} was cancelled.`), "cancelled");
      const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
      this.#pending.set(id, { method, resolve, reject, timer, cleanup });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#write(message).catch((error: unknown) => this.settle(id, error instanceof McpError ? error : new McpError("transport", String(error))));
    });
  }
  async notify(method: string, params?: unknown): Promise<void> { if (this.#closed) throw new McpError("closed", `MCP server ${this.name} is closed.`); await this.#write(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }) + "\n"); }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.cleanup?.(); pending.reject(new McpError("closed", `MCP server ${this.name} is closed.`)); }
    this.#pending.clear();
    try { this.#process.kill(); } catch {}
    try { const stdin = this.#process.stdin; if (stdin !== undefined && typeof stdin !== "number") stdin.end(); } catch {}
    await this.#reader.catch(() => undefined);
  }
  // One failed write rejects that write for its caller only: the tail carries the recovered promise
  // so every later frame to this server is still attempted in order.
  async #write(value: string): Promise<void> { const attempt = this.#writeTail.then(async () => { if (this.#closed) throw new McpError("closed", `MCP server ${this.name} is closed.`); const stdin = this.#process.stdin; if (stdin === undefined || typeof stdin === "number") throw new McpError("transport", `MCP server ${this.name} stdin is unavailable.`); await stdin.write(value); }); this.#writeTail = attempt.catch(() => undefined); return attempt; }
  private async readStdout(): Promise<void> { try { const stdout = this.#process.stdout; if (stdout === undefined || typeof stdout === "number") throw new McpError("transport", `MCP server ${this.name} stdout is unavailable.`); for await (const chunk of stdout) { this.#buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk); let newline = this.#buffer.indexOf("\n"); while (newline >= 0) { const rawLine = this.#buffer.slice(0, newline); if (Buffer.byteLength(rawLine) > MAX_FRAME_BYTES) throw new McpError("protocol", `MCP server ${this.name} exceeded the 4 MiB frame limit.`); const line = rawLine.trim(); this.#buffer = this.#buffer.slice(newline + 1); if (line.length > 0) this.handleLine(line); newline = this.#buffer.indexOf("\n"); } if (Buffer.byteLength(this.#buffer) > MAX_FRAME_BYTES) throw new McpError("protocol", `MCP server ${this.name} exceeded the 4 MiB frame limit.`); } if (!this.#closed) this.fail(new McpError("process", `MCP server ${this.name} stdout reached EOF.`)); } catch (error) { if (!this.#closed) this.fail(error); } }
  private async readStderr(): Promise<void> { const stderr = this.#process.stderr; if (stderr === undefined || typeof stderr === "number") return; for await (const chunk of stderr) { const line = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk); this.options.onLog?.(line); } }
  private handleLine(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { this.fail(new McpError("protocol", `MCP server ${this.name} emitted invalid JSON.`)); return; }
    if (!message || typeof message !== "object") return;
    const value = message as { id?: unknown; method?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    // A frame carrying a method is the server calling us, never an answer to our request — its id
    // lives in the server's own space and may collide with ours.
    if (typeof value.method === "string") { this.declineServerRequest(value.id, value.method); return; }
    if (typeof value.id !== "number") return;
    const pending = this.#pending.get(value.id);
    if (!pending) return;
    this.#pending.delete(value.id); clearTimeout(pending.timer); pending.cleanup?.();
    if (value.error) { pending.reject(new McpError(typeof value.error.code === "number" ? value.error.code : "server", typeof value.error.message === "string" ? value.error.message : "MCP server request failed.")); return; }
    pending.resolve(value.result);
  }
  // Lyra is an MCP client with no sampling or roots capability. Answering -32601 lets a server that
  // asks fail fast instead of waiting out its own deadline (§3.4).
  private declineServerRequest(id: unknown, method: string): void {
    if (typeof id !== "string" && typeof id !== "number") return;
    void this.#write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `MCP client lyra does not implement ${method}.` } }) + "\n").catch(() => undefined);
  }
  private settle(id: number, error: unknown, cancelReason?: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id); clearTimeout(pending.timer); pending.cleanup?.(); pending.reject(error);
    // MCP forbids cancelling initialize, and a dead transport cannot carry the notice.
    if (cancelReason === undefined || this.#closed || pending.method === "initialize") return;
    void this.notify("notifications/cancelled", { requestId: id, reason: cancelReason }).catch(() => undefined);
  }
  private fail(error: unknown): void { if (this.#closed) return; const typed = error instanceof McpError ? error : new McpError("transport", String(error)); this.#closed = true; for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.cleanup?.(); pending.reject(typed); } this.#pending.clear(); try { this.#process.kill(); } catch {} }
}
