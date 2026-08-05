import type { McpCallResult, McpClientOptions, McpToolDescriptor } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
export class McpError extends Error {
  readonly code: string | number;
  constructor(code: string | number, message: string) { super(message); this.name = "McpError"; this.code = code; }
}
interface Pending { method: string; resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout>; }

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
    const spawnOptions = options.cwd === undefined
      ? { stdin: "pipe" as const, stdout: "pipe" as const, stderr: "pipe" as const, ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }) }
      : { cwd: options.cwd, stdin: "pipe" as const, stdout: "pipe" as const, stderr: "pipe" as const, ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }) };
    this.#process = Bun.spawn([options.command, ...(options.args ?? [])], spawnOptions);
    this.#reader = this.readStdout();
    if (typeof this.#process.stderr !== "number") void this.readStderr();
    void this.#process.exited.then((code) => { if (!this.#closed) this.fail(new McpError("process", `MCP server ${this.name} exited with code ${code}.`)); });
  }

  async initialize(): Promise<unknown> {
    if (this.#initialized) return undefined;
    const result = await this.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "lyra", version: "0.1.0" } });
    await this.notify("notifications/initialized", {});
    this.#initialized = true;
    return result;
  }

  async listTools(cursor?: string): Promise<{ tools: McpToolDescriptor[]; nextCursor?: string }> {
    await this.initialize();
    const result = await this.request("tools/list", cursor === undefined ? {} : { cursor });
    if (!result || typeof result !== "object" || !Array.isArray((result as { tools?: unknown }).tools)) throw new McpError("protocol", `MCP server ${this.name} returned an invalid tools/list result.`);
    const tools = (result as { tools: unknown[] }).tools.map((tool) => {
      if (!tool || typeof tool !== "object" || typeof (tool as { name?: unknown }).name !== "string") throw new McpError("protocol", `MCP server ${this.name} returned a tool without a name.`);
      const value = tool as Record<string, unknown>;
      return { server: this.name, name: value.name as string, description: typeof value.description === "string" ? value.description : "MCP tool", inputSchema: value.inputSchema && typeof value.inputSchema === "object" ? value.inputSchema as Readonly<Record<string, unknown>> : { type: "object" }, ...(value.annotations && typeof value.annotations === "object" ? { annotations: value.annotations as Readonly<Record<string, unknown>> } : {}) };
    });
    const next = (result as { nextCursor?: unknown }).nextCursor;
    return { tools, ...(typeof next === "string" && next.length > 0 ? { nextCursor: next } : {}) };
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    if (typeof name !== "string" || name.length === 0) throw new McpError("invalid_request", "MCP tool name must be non-empty.");
    await this.initialize();
    const result = await this.request("tools/call", { name, arguments: args ?? {} });
    if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) throw new McpError("protocol", `MCP server ${this.name} returned an invalid tools/call result.`);
    const value = result as { content: unknown; isError?: unknown; structuredContent?: unknown };
    return { content: value.content, ...(value.isError === true ? { isError: true } : {}), ...(value.structuredContent === undefined ? {} : { structuredContent: value.structuredContent }) };
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) throw new McpError("closed", `MCP server ${this.name} is closed.`);
    if (typeof method !== "string" || method.length === 0) throw new McpError("invalid_request", "MCP method must be non-empty.");
    const id = this.#nextId++;
    const timeoutMs = Math.min(Math.max(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), DEFAULT_TIMEOUT_MS);
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const pending = this.#pending.get(id); if (!pending) return; this.#pending.delete(id); const error = new McpError("timeout", `MCP request ${method} exceeded ${timeoutMs}ms.`); pending.reject(error); this.fail(error); }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#write(message).catch((error) => { const pending = this.#pending.get(id); if (!pending) return; this.#pending.delete(id); clearTimeout(pending.timer); pending.reject(new McpError("transport", String(error))); });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> { if (this.#closed) throw new McpError("closed", `MCP server ${this.name} is closed.`); await this.#write(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }) + "\n"); }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new McpError("closed", `MCP server ${this.name} is closed.`)); }
    this.#pending.clear();
    try { this.#process.kill(); } catch { /* already exited */ }
    try { const stdin = this.#process.stdin; if (stdin !== undefined && typeof stdin !== "number") stdin.end(); } catch { /* already ended */ }
    await this.#reader.catch(() => undefined);
  }

  async #write(value: string): Promise<void> {
    this.#writeTail = this.#writeTail.then(async () => {
      if (this.#closed) throw new McpError("closed", `MCP server ${this.name} is closed.`);
      const stdin = this.#process.stdin;
      if (stdin === undefined || typeof stdin === "number") throw new McpError("transport", `MCP server ${this.name} stdin is unavailable.`);
      await stdin.write(value);
    });
    return this.#writeTail;
  }

  private async readStdout(): Promise<void> {
    try {
      const stdout = this.#process.stdout;
      if (stdout === undefined || typeof stdout === "number") throw new McpError("transport", `MCP server ${this.name} stdout is unavailable.`);
      for await (const chunk of stdout) {
        this.#buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        let newline = this.#buffer.indexOf("\n");
        while (newline >= 0) {
          const line = this.#buffer.slice(0, newline).trim();
          this.#buffer = this.#buffer.slice(newline + 1);
          if (line.length > 0) this.handleLine(line);
          newline = this.#buffer.indexOf("\n");
        }
      }
      if (!this.#closed) this.fail(new McpError("process", `MCP server ${this.name} stdout reached EOF.`));
    } catch (error) { if (!this.#closed) this.fail(error); }
  }

  private async readStderr(): Promise<void> {
    const stderr = this.#process.stderr;
    if (stderr === undefined || typeof stderr === "number") return;
    for await (const chunk of stderr) { const line = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk); this.options.onLog?.(line); }
  }
  private handleLine(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { this.fail(new McpError("protocol", `MCP server ${this.name} emitted invalid JSON.`)); return; }
    if (!message || typeof message !== "object" || typeof (message as { id?: unknown }).id !== "number") return;
    const id = (message as { id: number }).id;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id); clearTimeout(pending.timer);
    const value = message as { result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (value.error) { pending.reject(new McpError(typeof value.error.code === "number" ? value.error.code : "server", typeof value.error.message === "string" ? value.error.message : "MCP server request failed.")); return; }
    pending.resolve(value.result);
  }
  private fail(error: unknown): void { const typed = error instanceof McpError ? error : new McpError("transport", String(error)); this.#closed = true; for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(typed); } this.#pending.clear(); try { this.#process.kill(); } catch {} }
}
