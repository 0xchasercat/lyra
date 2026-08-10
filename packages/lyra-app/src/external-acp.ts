import { ACP_DEFAULT_TURN_TIMEOUT_MS } from "@lyra/acp";
import type { IrcBus, SpawnExecutorContext, SpawnRequest } from "@lyra/core";

interface Pending { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; }

export async function runExternalAcpAgent(command: string, request: SpawnRequest, context: SpawnExecutorContext, bus: IrcBus, mainPeer: string): Promise<unknown> {
  if (command.trim().length === 0) throw new Error("External ACP command must not be empty.");
  if (context.signal.aborted) throw context.signal.reason;
  const child = Bun.spawn(["/bin/sh", "-lc", `exec ${command}`], { cwd: context.workspace, env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: process.env.LANG ?? "C.UTF-8" }, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
  const chunks: string[] = [];
  const client = new ExternalAcpClient(child, async (method, params) => {
    if (method === "session/update") {
      const text = updateText(params);
      if (text !== undefined) chunks.push(text);
      await bus.send({ from: context.peer, to: context.parentId ?? mainPeer, data: params });
    }
  });
  const abort = (): void => { void client.close(context.signal.reason); };
  context.signal.addEventListener("abort", abort, { once: true });
  const bridge = bridgeInbox(client, bus, context);
  try {
    const initialized = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "lyra", version: "0.1.0" } });
    const created = await client.request("session/new", { cwd: context.workspace, mcpServers: [] });
    const sessionId = recordString(created, "sessionId") ?? recordString(created, "id");
    const prompt = request.context ? `${request.context}\n\n${request.task}` : request.task;
    // The same split the daemon makes in the other direction: `initialize` and `session/new`
    // are questions and keep the 60s default, but this one *is* the external agent's turn and
    // gets the turn-scale deadline. A cancel still arrives through `context.signal` at once.
    const response = await client.request("session/prompt", { ...(sessionId === undefined ? {} : { sessionId }), prompt: [{ type: "text", text: prompt }] }, ACP_DEFAULT_TURN_TIMEOUT_MS);
    return { acp: nestedString(initialized, "agentInfo", "name") ?? "external", ...(sessionId === undefined ? {} : { sessionId }), content: chunks.join(""), stopReason: recordString(response, "stopReason") ?? "end_turn", response };
  } finally {
    context.signal.removeEventListener("abort", abort);
    await client.close(context.signal.aborted ? context.signal.reason : undefined);
    await bridge.catch(() => undefined);
  }
}

async function bridgeInbox(client: ExternalAcpClient, bus: IrcBus, context: SpawnExecutorContext): Promise<void> {
  while (!context.signal.aborted && !client.closed) {
    const messages = await bus.wait({ peer: context.peer, timeoutMs: 100, signal: context.signal }).catch(() => []);
    for (const message of messages) await client.notify("session/update", { message });
  }
}

class ExternalAcpClient {
  readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #stderr: Promise<string>;
  readonly #pending = new Map<number, Pending>();
  readonly #onNotification: (method: string, params: unknown) => void | Promise<void>;
  #nextId = 0;
  #buffer = "";
  #closed = false;
  #closePromise?: Promise<void>;
  constructor(child: Bun.Subprocess<"pipe", "pipe", "pipe">, onNotification: (method: string, params: unknown) => void | Promise<void>) {
    this.#child = child;
    this.#onNotification = onNotification;
    this.#stderr = new Response(child.stderr).text();
    void this.read();
    void child.exited.then(async (code) => { if (!this.#closed) { const stderr = (await this.#stderr).trim(); this.fail(new Error(`External ACP harness exited with code ${code}${stderr ? `: ${stderr}` : "."}`)); } });
  }
  get closed(): boolean { return this.#closed; }
  async request(method: string, params?: unknown, timeoutMs = 60_000): Promise<unknown> {
    if (this.#closed) throw new Error("External ACP harness is closed.");
    const id = ++this.#nextId;
    const deferred = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => { this.#pending.delete(id); deferred.reject(new Error(`External ACP request ${method} exceeded ${timeoutMs}ms.`)); }, timeoutMs);
    this.#pending.set(id, { resolve: deferred.resolve, reject: deferred.reject, timer });
    await this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return deferred.promise;
  }
  notify(method: string, params?: unknown): Promise<void> { return this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }); }
  close(reason: unknown = new Error("External ACP harness closed.")): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.#pending.clear();
    try { this.#child.stdin.end(); } catch {}
    killTree(this.#child, "SIGTERM");
    this.#closePromise = Promise.race([this.#child.exited.then(() => undefined), Bun.sleep(250)]).then(async () => { if (this.#child.exitCode === null) killTree(this.#child, "SIGKILL"); await this.#child.exited; });
    return this.#closePromise;
  }
  private async write(value: unknown): Promise<void> { if (this.#closed) throw new Error("External ACP harness is closed."); await this.#child.stdin.write(`${JSON.stringify(value)}\n`); }
  private async read(): Promise<void> {
    try {
      for await (const chunk of this.#child.stdout) {
        this.#buffer += new TextDecoder().decode(chunk);
        if (Buffer.byteLength(this.#buffer) > 4 * 1024 * 1024) throw new Error("External ACP frame exceeded 4 MiB.");
        let newline = this.#buffer.indexOf("\n");
        while (newline >= 0) { const line = this.#buffer.slice(0, newline).trim(); this.#buffer = this.#buffer.slice(newline + 1); if (line) await this.handle(line); newline = this.#buffer.indexOf("\n"); }
      }
    } catch (error) { this.fail(error); }
  }
  private async handle(line: string): Promise<void> {
    const message: unknown = JSON.parse(line);
    if (!message || typeof message !== "object") return;
    const value = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } };
    if (typeof value.method === "string") {
      if (value.id !== undefined) await this.write({ jsonrpc: "2.0", id: value.id, error: { code: -32601, message: `Unsupported external ACP client method ${value.method}.` } });
      else await this.#onNotification(value.method, value.params);
      return;
    }
    if (typeof value.id !== "number") return;
    const pending = this.#pending.get(value.id);
    if (!pending) return;
    this.#pending.delete(value.id);
    clearTimeout(pending.timer);
    if (value.error) pending.reject(new Error(typeof value.error.message === "string" ? value.error.message : "External ACP request failed.")); else pending.resolve(value.result);
  }
  private fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    killTree(this.#child, "SIGTERM");
  }
}

function recordString(value: unknown, field: string): string | undefined { return value && typeof value === "object" && field in value && typeof (value as Record<string, unknown>)[field] === "string" ? (value as Record<string, string>)[field] : undefined; }
function nestedString(value: unknown, object: string, field: string): string | undefined { if (!value || typeof value !== "object") return undefined; const nested = (value as Record<string, unknown>)[object]; return recordString(nested, field); }
function updateText(value: unknown): string | undefined { if (!value || typeof value !== "object") return undefined; const params = value as Record<string, unknown>; const candidate = params.update && typeof params.update === "object" ? params.update as Record<string, unknown> : params; const content = candidate.content; return content && typeof content === "object" && (content as Record<string, unknown>).type === "text" && typeof (content as Record<string, unknown>).text === "string" ? (content as Record<string, string>).text : undefined; }
function killTree(child: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void { if (typeof child.pid === "number" && child.pid > 1) { try { process.kill(-child.pid, signal); } catch {} } try { child.kill(signal); } catch {} }
