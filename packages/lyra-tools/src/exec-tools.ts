import { join, resolve } from "node:path";
import type { ToolDefinition } from "@lyra/provider";
import type { ToolExecutionContext, ToolExecutionResult } from "@lyra/core";
import { boundText } from "./filesystem-tools.ts";
import type { ArtifactStore, LyraTool, ToolRuntimeContext } from "./types.ts";
import { createArtifactStore } from "./artifacts.ts";
export interface BashToolOptions {
  root?: string;
  displayBudget?: number;
  artifactStore?: ArtifactStore;
  maxInlineMs?: number;
  activity?: (event: { type: "bash_started" | "bash_finished"; command: string; cwd: string; jobId?: string; exitCode?: number | null }) => void;
}

export interface BashRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface BashJob {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly promise: Promise<BashCompleted>;
  cancel(): void;
}

export interface BashCompleted {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

class JobManager {
  readonly #jobs = new Map<string, BashJob>();
  #sequence = 0;

  start(command: string, cwd: string, timeoutMs: number, run: (onProcess: (process: Bun.Subprocess) => void) => Promise<BashCompleted>): BashJob {
    const id = `bash-${Date.now().toString(36)}-${(++this.#sequence).toString(36)}`;
    let child: Bun.Subprocess | undefined;
    const promise = run((process) => { child = process; }).finally(() => { this.#jobs.delete(id); });
    const job: BashJob = { id, command, cwd, startedAt: Date.now(), promise, cancel: () => child?.kill() };
    this.#jobs.set(id, job);
    return job;
  }

  get(id: string): BashJob | undefined { return this.#jobs.get(id); }
  list(): readonly BashJob[] { return [...this.#jobs.values()]; }
}

export const bashJobs = new JobManager();

export const BASH_DEFINITION: ToolDefinition = Object.freeze({
  name: "bash",
  description: "Run a shell command in the active workspace and report complete stdout, stderr, exit status, and cancellation details.",
  inputSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: "string", minLength: 1, description: "The exact command to run." },
      cwd: { type: "string", minLength: 1, description: "Optional workspace-relative working directory." },
      timeoutMs: { type: "integer", minimum: 1, maximum: 3_600_000, description: "Optional deadline in milliseconds." },
    },
    required: ["command"],
  }),
});

function runtime(context: ToolExecutionContext, root?: string): { cwd: string; origin: string; store: ArtifactStore } {
  const value = context as Partial<ToolRuntimeContext>;
  const workspace = typeof value.workspace === "string" && value.workspace.length > 0 ? value.workspace : process.cwd();
  const cwd = typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd : workspace;
  const origin = typeof value.origin === "string" && value.origin.length > 0 ? value.origin : root ?? workspace;
  const store = value.artifactStore ?? createArtifactStore(origin);
  return { cwd, origin, store };
}

function contained(path: string, root: string): boolean {
  const relative = resolve(path).slice(resolve(root).length);
  return relative === "" || relative.startsWith("/");
}

function commandClass(command: string): "light" | "heavy" {
  return /(^|\s)(cargo|npm|bun|pnpm|yarn|go|rustc|tsc|pytest|vitest|jest|make|cmake)(\s|$)/i.test(command)
    || /(^|\s)(build|test|check|install|compile|watch|serve|dev)(\s|$)/i.test(command)
    || /\b(sleep|yes|tail\s+-f)\b/i.test(command)
    ? "heavy" : "light";
}

function parseArgs(args: unknown): BashRequest | string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object with a command";
  const value = args as Record<string, unknown>;
  if (typeof value.command !== "string" || value.command.trim().length === 0) return "command must be a non-empty string";
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.trim().length === 0)) return "cwd must be a non-empty string when provided";
  const rawTimeout = value.timeoutMs;
  if (rawTimeout !== undefined && (typeof rawTimeout !== "number" || !Number.isSafeInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > 3_600_000)) return "timeoutMs must be an integer between 1 and 3600000";
  return { command: value.command, ...(value.cwd === undefined ? {} : { cwd: value.cwd as string }), ...(rawTimeout === undefined ? {} : { timeoutMs: rawTimeout }) };
}

function errorResult(message: string): ToolExecutionResult { return { content: message, isError: true }; }

async function runBash(command: string, cwd: string, timeoutMs: number, signal: AbortSignal, notify?: (process: Bun.Subprocess) => void): Promise<BashCompleted> {
  const started = Date.now();
  const child = Bun.spawn(["/bin/bash", "-lc", command], { cwd, stdout: "pipe", stderr: "pipe" });
  notify?.(child);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => { timedOut = true; child.kill(); };
  if (timeoutMs > 0) timer = setTimeout(stop, timeoutMs);
  const onAbort = (): void => child.kill();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode, signal: null, timedOut, durationMs: Date.now() - started };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function present(result: BashCompleted, store: ArtifactStore, budget: number): Promise<string> {
  const body = [
    `exit_code: ${result.exitCode ?? "null"}`,
    `signal: ${result.signal ?? "none"}`,
    `timed_out: ${result.timedOut}`,
    `duration_ms: ${result.durationMs}`,
    "--- stdout ---",
    result.stdout,
    "--- stderr ---",
    result.stderr,
  ].join("\n");
  return boundText(body, store, { budget, mimeType: "text/plain", name: "bash-output.txt" });
}

export class BashTool implements LyraTool {
  readonly definition = BASH_DEFINITION;
  readonly #options: Required<Pick<BashToolOptions, "displayBudget" | "maxInlineMs">> & BashToolOptions;
  constructor(options: BashToolOptions = {}) {
    this.#options = { displayBudget: 32 * 1024, maxInlineMs: 120_000, ...options };
  }

  async execute(args: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const parsed = parseArgs(args);
    if (typeof parsed === "string") return errorResult(`Invalid bash arguments: ${parsed}.`);
    const base = runtime(context, this.#options.root);
    const requested = parsed.cwd === undefined ? base.cwd : resolve(base.cwd, parsed.cwd);
    const root = resolve(this.#options.root ?? base.origin);
    if (!contained(requested, root)) return errorResult(`Bash cwd escapes the workspace root ${root}; choose a workspace-relative directory.`);
    const cwd = requested;
    const timeoutMs = parsed.timeoutMs ?? this.#options.maxInlineMs;
    const heavy = commandClass(parsed.command) === "heavy";
    if (heavy) {
      const job = bashJobs.start(parsed.command, cwd, timeoutMs, (notify) => runBash(parsed.command, cwd, timeoutMs, context.signal, notify));
      this.#options.activity?.({ type: "bash_started", command: parsed.command, cwd, jobId: job.id });
      return { content: `Started heavy bash command as job ${job.id}. Use the host job wait/status API to retrieve complete output.`, metadata: { jobId: job.id, command: parsed.command, cwd, heavy: true } };
    }
    this.#options.activity?.({ type: "bash_started", command: parsed.command, cwd });
    const result = await runBash(parsed.command, cwd, timeoutMs, context.signal);
    this.#options.activity?.({ type: "bash_finished", command: parsed.command, cwd, exitCode: result.exitCode });
    return { content: await present(result, base.store, this.#options.displayBudget), ...(result.exitCode === 0 ? {} : { isError: true }) };
  }
}

export function createBashTool(options: BashToolOptions = {}): BashTool { return new BashTool(options); }
