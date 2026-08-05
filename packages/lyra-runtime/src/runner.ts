import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { CheckpointStore, validateRuntimeName } from "./checkpoint.ts";
import type { RuntimeAdapters, RuntimeManagerOptions, RuntimeRunResult, RuntimeScriptRecord } from "./types.ts";

const EXECUTABLE_ROOT = dirname(realpathSync(process.execPath));
const PACKAGED_CLIENT = join(EXECUTABLE_ROOT, "runtime-client.ts");
const PACKAGED_RUNNER = join(EXECUTABLE_ROOT, process.platform === "win32" ? "lyra-jit-runner.exe" : "lyra-jit-runner");
const CLIENT_PATH = process.env.LYRA_RUNTIME_CLIENT ?? (existsSync(PACKAGED_CLIENT) ? PACKAGED_CLIENT : fileURLToPath(new URL("./runtime-client.ts", import.meta.url)));
const JIT_RUNNER = process.env.LYRA_JIT_RUNNER ?? (existsSync(PACKAGED_RUNNER) ? PACKAGED_RUNNER : process.execPath);
const TOOL_METHODS = new Set(["read", "write", "edit", "glob", "grep"] as const);
const IRC_METHODS = new Set(["send", "publish", "wait"] as const);
const GIT_METHODS = new Set(["preview", "apply", "rollback"] as const);
const WORKSPACE_METHODS = new Set(["create", "list", "drop"] as const);

export class RuntimeManager {
  readonly origin: string;
  readonly session: string;
  readonly directory: string;
  readonly checkpoints: CheckpointStore;
  readonly #adapters: RuntimeAdapters;
  readonly #requestTimeoutMs: number;
  readonly #runTimeoutMs: number;
  #sequence = 0;
  readonly #children = new Set<Bun.Subprocess>();
  #closed = false;

  constructor(options: RuntimeManagerOptions) {
    if (!options || typeof options !== "object") throw new TypeError("Runtime manager options are required.");
    if (typeof options.origin !== "string" || options.origin.length === 0) throw new TypeError("Runtime origin must be a non-empty path.");
    validateRuntimeName(options.session, "session");
    if (!options.adapters || typeof options.adapters !== "object") throw new TypeError("Runtime adapters are required; no fake fallback is provided.");
    this.origin = resolve(options.origin);
    this.session = options.session;
    this.directory = join(this.origin, ".lyra", "runtime", this.session);
    this.checkpoints = new CheckpointStore(this.origin, this.session);
    this.#adapters = options.adapters;
    this.#requestTimeoutMs = positive(options.requestTimeoutMs ?? 60_000, "requestTimeoutMs");
    this.#runTimeoutMs = positive(options.runTimeoutMs ?? 30 * 60_000, "runTimeoutMs");
  }

  async declare(name: string, source: string): Promise<RuntimeScriptRecord> {
    validateRuntimeName(name);
    if (typeof source !== "string" || source.trim().length === 0) throw new TypeError("Runtime source must be a non-empty TypeScript module.");
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${name}.ts`);
    const temporary = `${path}.${process.pid}.${++this.#sequence}.tmp`;
    await writeFile(temporary, source, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    const timestamp = new Date().toISOString();
    return { session: this.session, name, path, createdAt: timestamp, updatedAt: timestamp };
  }

  async list(): Promise<RuntimeScriptRecord[]> {
    try {
      const entries = (await readdir(this.directory)).filter((name) => /^[a-z][a-z0-9-]{0,63}\.ts$/.test(name) && !name.startsWith(".")).sort();
      return Promise.all(entries.map(async (entry) => {
        const path = join(this.directory, entry);
        const info = await stat(path);
        return { session: this.session, name: entry.slice(0, -3), path, createdAt: info.birthtime.toISOString(), updatedAt: info.mtime.toISOString() };
      }));
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return [];
      throw error;
    }
  }

  async promote(name: string): Promise<string> {
    const source = this.scriptPath(name);
    await stat(source);
    const destination = join(this.origin, ".lyra", "tools", `${name}.ts`);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${++this.#sequence}.tmp`;
    await copyFile(source, temporary);
    await rename(temporary, destination);
    return destination;
  }

  async run(name: string, input: unknown = null): Promise<RuntimeRunResult> {
    if (this.#closed) throw new Error("Runtime manager is closed.");
    const scriptPath = this.scriptPath(name);
    await stat(scriptPath).catch((error: unknown) => { throw new Error(`Runtime script ${name} does not exist: ${message(error)}.`); });
    const checkpoint = await this.checkpoints.load(name);
    const invocation = `${process.pid}-${++this.#sequence}-${randomBytes(4).toString("hex")}`;
    const runnerPath = join(this.directory, `.${name}.${invocation}.runner.ts`);
    const buildDirectory = join(this.directory, `.build-${name}-${invocation}`);
    const wrapper = `try {\n  const module = await import(${JSON.stringify(scriptPath)});\n  const envelope = JSON.parse(await Bun.stdin.text());\n  const output = typeof module.default === "function" ? await module.default(envelope.input, { checkpoint: envelope.checkpoint }) : (module.default ?? null);\n  process.stdout.write(JSON.stringify({ ok: true, output }) + "\\n");\n} catch (error) {\n  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }) + "\\n");\n  process.exitCode = 1;\n}\n`;
    await writeFile(runnerPath, wrapper, { flag: "wx", mode: 0o600 });
    let server: ReturnType<typeof Bun.serve> | undefined;
    let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
    try {
      const result = await Bun.build({
        entrypoints: [runnerPath],
        outdir: buildDirectory,
        target: "bun",
        format: "esm",
        minify: false,
        plugins: [{ name: "lyra-runtime", setup(build) { build.onResolve({ filter: /^lyra:runtime$/ }, () => ({ path: CLIENT_PATH })); } }],
      });
      if (!result.success || result.outputs.length !== 1) throw new Error(`Runtime compilation failed: ${result.logs.map(String).join("\n") || "no output"}.`);
      const token = randomBytes(24).toString("hex");
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => this.handleBridge(request, token, name),
      });
      child = Bun.spawn([JIT_RUNNER, result.outputs[0]!.path], {
        cwd: this.origin,
        env: { ...process.env, LYRA_RUNTIME_URL: `http://127.0.0.1:${server.port}/`, LYRA_RUNTIME_TOKEN: token },
        stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true,
      });
      this.#children.add(child);
      child.stdin.write(JSON.stringify({ input: jsonClone(input), checkpoint }));
      child.stdin.end();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; killTree(child!, "SIGTERM"); }, this.#runTimeoutMs);
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).finally(() => clearTimeout(timer));
      if (timedOut) return { ok: false, stderr, exitCode, checkpoint: await this.checkpoints.load(name), error: `Runtime ${name} exceeded ${this.#runTimeoutMs}ms and was cancelled.` };
      const lines = stdout.trim().split("\n").filter(Boolean);
      let envelope: unknown;
      try { envelope = JSON.parse(lines.at(-1) ?? ""); }
      catch { return { ok: false, stderr, exitCode, checkpoint: await this.checkpoints.load(name), error: `Runtime ${name} did not return JSON; stdout was ${JSON.stringify(stdout)}.` }; }
      if (!envelope || typeof envelope !== "object" || typeof (envelope as { ok?: unknown }).ok !== "boolean") return { ok: false, stderr, exitCode, checkpoint: await this.checkpoints.load(name), error: `Runtime ${name} returned an invalid JSON envelope.` };
      const saved = await this.checkpoints.load(name);
      if ((envelope as { ok: boolean }).ok) return { ok: exitCode === 0, output: (envelope as { output?: unknown }).output, stderr, exitCode, ...(saved === undefined ? {} : { checkpoint: saved }), ...(exitCode === 0 ? {} : { error: `Runtime ${name} exited with code ${exitCode}.` }) };
      return { ok: false, stderr, exitCode, ...(saved === undefined ? {} : { checkpoint: saved }), error: String((envelope as { error?: unknown }).error ?? `Runtime ${name} failed.`) };
    } finally {
      if (child) { await reapTree(child); this.#children.delete(child); }
      server?.stop(true);
      await Promise.allSettled([rm(runnerPath, { force: true }), rm(buildDirectory, { recursive: true, force: true })]);
    }
  }

  async close(): Promise<void> { this.#closed = true; const children = [...this.#children]; for (const child of children) killTree(child, "SIGTERM"); await Promise.allSettled(children.map((child) => child.exited)); }

  scriptPath(name: string): string { validateRuntimeName(name); return join(this.directory, `${name}.ts`); }

  private async handleBridge(request: Request, token: string, runtimeName: string): Promise<Response> {
    if (request.method !== "POST" || request.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ ok: false, error: "Unauthorized runtime bridge request." }, { status: 401 });
    try {
      const body: unknown = await request.json();
      if (!body || typeof body !== "object" || typeof (body as { method?: unknown }).method !== "string") throw new TypeError("Runtime bridge request needs a method string.");
      const method = (body as { method: string }).method;
      const args = (body as { args?: unknown }).args;
      const result = await deadline((signal) => this.dispatch(method, args, runtimeName, signal), this.#requestTimeoutMs, method);
      return Response.json({ ok: true, result });
    } catch (error) { return Response.json({ ok: false, error: message(error) }, { status: 400 }); }
  }

  private async dispatch(method: string, args: unknown, runtimeName: string, signal: AbortSignal): Promise<unknown> {
    if (method === "spawn") return this.#adapters.spawn(args, signal);
    if (method === "exec") {
      if (!args || typeof args !== "object" || typeof (args as { command?: unknown }).command !== "string") throw new TypeError("exec requires a command string.");
      return this.#adapters.exec((args as { command: string }).command, (args as { options?: unknown }).options, signal);
    }
    if (method.startsWith("tool.") && TOOL_METHODS.has(method.slice(5) as never)) return this.#adapters.tool(method.slice(5) as "read" | "write" | "edit" | "glob" | "grep", args, signal);
    if (method.startsWith("irc.") && IRC_METHODS.has(method.slice(4) as never)) return this.#adapters.irc(method.slice(4) as "send" | "publish" | "wait", args, signal);
    if (method.startsWith("git.") && GIT_METHODS.has(method.slice(4) as never)) return this.#adapters.git(method.slice(4) as "preview" | "apply" | "rollback", args, signal);
    if (method.startsWith("workspace.") && WORKSPACE_METHODS.has(method.slice(10) as never)) return this.#adapters.workspace(method.slice(10) as "create" | "list" | "drop", args, signal);
    if (method === "report") {
      if (!args || typeof args !== "object" || typeof (args as { message?: unknown }).message !== "string") throw new TypeError("report requires a message string.");
      await this.#adapters.report((args as { message: string }).message, signal); return null;
    }
    if (method === "checkpoint") {
      if (!args || typeof args !== "object" || !("state" in args)) throw new TypeError("checkpoint requires state.");
      await this.checkpoints.save(runtimeName, (args as { state: unknown }).state); return null;
    }
    throw new TypeError(`Unknown runtime method ${JSON.stringify(method)}.`);
  }
}

function positive(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer.`); return value; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function jsonClone<T>(value: T): T { try { return JSON.parse(JSON.stringify(value)) as T; } catch { throw new TypeError("Runtime input must be JSON-serializable."); } }
async function deadline<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number, method: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Runtime method ${method} exceeded ${timeoutMs}ms.`)), timeoutMs);
  try { return await Promise.race([work(controller.signal), abortPromise(controller.signal)]); } finally { clearTimeout(timer); }
}
function abortPromise(signal: AbortSignal): Promise<never> { if (signal.aborted) return Promise.reject(signal.reason); const { promise, reject } = Promise.withResolvers<never>(); signal.addEventListener("abort", () => reject(signal.reason), { once: true }); return promise; }
function killTree(child: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void { if (typeof child.pid === "number" && child.pid > 1) { try { process.kill(-child.pid, signal); } catch {} } try { child.kill(signal); } catch {} }
async function reapTree(child: Bun.Subprocess): Promise<void> { if (typeof child.pid !== "number" || child.pid <= 1) return; try { process.kill(-child.pid, 0); } catch { return; } killTree(child, "SIGTERM"); await Bun.sleep(150); try { process.kill(-child.pid, 0); killTree(child, "SIGKILL"); } catch {} }
