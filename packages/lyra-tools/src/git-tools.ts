import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolDefinition } from "@lyra/provider";
import type { ToolExecutionContext, ToolExecutionResult } from "@lyra/core";
import { boundText } from "./filesystem-tools.ts";
import type { ArtifactStore, LyraTool, ToolRuntimeContext } from "./types.ts";
import { createArtifactStore } from "./artifacts.ts";

export interface GitToolOptions {
  root?: string;
  displayBudget?: number;
  artifactStore?: ArtifactStore;
  activity?: (event: { type: "git_started" | "git_finished"; args: readonly string[]; cwd: string; exitCode?: number | null }) => void;
}

export const GIT_DEFINITION: ToolDefinition = Object.freeze({
  name: "git",
  description: "Run a validated git subcommand in the active workspace and report repository state, output, and exit status.",
  inputSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      args: { type: "array", minItems: 1, items: { type: "string" }, description: "Git arguments after the git executable." },
      cwd: { type: "string", minLength: 1, description: "Optional workspace-relative working directory." },
      timeoutMs: { type: "integer", minimum: 1, maximum: 3_600_000, description: "Optional deadline in milliseconds." },
    },
    required: ["args"],
  }),
});

function errorResult(message: string): ToolExecutionResult { return { content: message, isError: true }; }
function runtime(context: ToolExecutionContext, root?: string): { cwd: string; origin: string; store: ArtifactStore } {
  const value = context as Partial<ToolRuntimeContext>;
  const workspace = typeof value.workspace === "string" && value.workspace.length > 0 ? value.workspace : process.cwd();
  const cwd = typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd : workspace;
  const origin = typeof value.origin === "string" && value.origin.length > 0 ? value.origin : root ?? workspace;
  return { cwd, origin, store: value.artifactStore ?? createArtifactStore(origin) };
}
async function contained(path: string, root: string): Promise<string | undefined> {
  const [child, parent] = await Promise.all([realpath(path), realpath(root)]);
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation)) ? child : undefined;
}
function parse(args: unknown): { args: string[]; cwd?: string; timeoutMs?: number } | string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object with args";
  const value = args as Record<string, unknown>;
  if (!Array.isArray(value.args) || value.args.length === 0 || value.args.some((arg) => typeof arg !== "string")) return "args must be a non-empty array of strings";
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.trim().length === 0)) return "cwd must be a non-empty string when provided";
  const rawTimeout = value.timeoutMs;
  if (rawTimeout !== undefined && (typeof rawTimeout !== "number" || !Number.isSafeInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > 3_600_000)) return "timeoutMs must be an integer between 1 and 3600000";
  return { args: value.args as string[], ...(value.cwd === undefined ? {} : { cwd: value.cwd as string }), ...(rawTimeout === undefined ? {} : { timeoutMs: rawTimeout }) };
}
function isDestructive(args: readonly string[]): boolean {
  return /^(commit|reset|checkout|switch|merge|rebase|cherry-pick|revert|clean|restore|add|rm)$/i.test(args[0] ?? "") || args.includes("--force") || args.includes("-f");
}

async function runGit(args: readonly string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; durationMs: number }> {
  const started = Date.now();
  const child = Bun.spawn(["/usr/bin/env", "git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  const abort = (): void => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode, timedOut, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export class GitTool implements LyraTool {
  readonly definition = GIT_DEFINITION;
  readonly #options: Required<Pick<GitToolOptions, "displayBudget">> & GitToolOptions;
  constructor(options: GitToolOptions = {}) { this.#options = { displayBudget: 32 * 1024, ...options }; }

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const parsed = parse(input);
    if (typeof parsed === "string") return errorResult(`Invalid git arguments: ${parsed}.`);
    const base = runtime(context, this.#options.root);
    const requested = parsed.cwd === undefined ? base.cwd : resolve(base.cwd, parsed.cwd);
    const root = resolve(this.#options.root ?? base.origin);
    let cwd: string | undefined;
    try { cwd = await contained(requested, root); } catch (error) { return errorResult(`Git cwd is unavailable: ${error instanceof Error ? error.message : String(error)}.`); }
    if (!cwd) return errorResult(`Git cwd escapes the workspace root ${root}; choose a workspace-relative directory.`);
    if (parsed.args.some((arg) => arg.includes("\0"))) return errorResult("Git arguments cannot contain NUL bytes.");
    const destructive = isDestructive(parsed.args);
    this.#options.activity?.({ type: "git_started", args: parsed.args, cwd });
    const result = await runGit(parsed.args, cwd, parsed.timeoutMs ?? 120_000, context.signal);
    this.#options.activity?.({ type: "git_finished", args: parsed.args, cwd, exitCode: result.exitCode });
    const body = [
      `args: git ${parsed.args.join(" ")}`,
      `exit_code: ${result.exitCode ?? "null"}`,
      `timed_out: ${result.timedOut}`,
      `duration_ms: ${result.durationMs}`,
      `destructive: ${destructive}`,
      "--- stdout ---",
      result.stdout,
      "--- stderr ---",
      result.stderr,
    ].join("\n");
    return {
      content: await boundText(body, base.store, { budget: this.#options.displayBudget, mimeType: "text/plain", name: "git-output.txt" }),
      ...(result.exitCode === 0 ? {} : { isError: true }),
      metadata: { args: [...parsed.args], cwd, destructive, exitCode: result.exitCode, timedOut: result.timedOut },
    };
  }
}

export function createGitTool(options: GitToolOptions = {}): GitTool { return new GitTool(options); }
