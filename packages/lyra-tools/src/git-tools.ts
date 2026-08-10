import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition } from "@lyra/provider";
import { foldToolAliases, toolArgs, type ToolAlias, type ToolExecutionContext, type ToolExecutionResult } from "@lyra/core";
import { boundText } from "./filesystem-tools.ts";
import { coerceScalars, dropPadding, type ArtifactStore, type LyraTool, type ToolRuntimeContext } from "./types.ts";
import { createArtifactStore } from "./artifacts.ts";

export interface GitToolOptions {
  root?: string;
  displayBudget?: number;
  artifactStore?: ArtifactStore;
  activity?: (event: { type: "git_started" | "git_finished"; args: readonly string[]; cwd: string; exitCode?: number | null }) => void;
}

export const GIT_DEFINITION: ToolDefinition = Object.freeze({
  name: "git",
  // §10 reversed where work happens — the main session runs in the launch directory, not a
  // clone — so "the workspace" was the old vocabulary for a path the model now selects itself.
  // §12 deleted the git modes, and saying so is worth the words: every other harness has one.
  description: "Run one git command from the model-selected working directory and report its stdout, stderr, exit status, and whether the subcommand was destructive. There are no git modes: destructive subcommands are logged, never blocked.",
  inputSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      args: { type: "array", minItems: 1, items: { type: "string" }, description: "Arguments after the git executable, already split, with no leading \"git\": [\"commit\", \"-m\", \"fix: thing\"]." },
      cwd: { type: "string", minLength: 1, description: "Optional absolute or cwd-relative working directory." },
      timeoutMs: { type: "integer", minimum: 1, maximum: 3_600_000, description: "Optional deadline in milliseconds." },
    },
    required: ["args"],
  }),
});

/** Accepted at runtime, absent from the advertised schema (§3.7). */
const GIT_ALIASES: readonly ToolAlias[] = Object.freeze([
  { canonical: "timeoutMs", aliases: ["timeout", "timeout_ms"] },
  { canonical: "cwd", aliases: ["workdir", "working_directory"] },
  { canonical: "args", aliases: ["command", "cmd", "arguments"] },
]);
const GIT_PADDING = Object.freeze({ cwd: true as const, timeoutMs: 1 });

/** Split a git command line the way a shell would, so a quoted commit message survives. */
export function splitGitCommand(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote !== undefined) {
      if (char === quote) { quote = undefined; continue; }
      if (char === "\\" && quote === '"' && index + 1 < line.length) { current += line[++index]; continue; }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (char === "\\" && index + 1 < line.length) { current += line[++index]; started = true; continue; }
    if (/\s/.test(char)) { if (started || current.length > 0) { parts.push(current); current = ""; started = false; } continue; }
    current += char;
    started = true;
  }
  if (started || current.length > 0) parts.push(current);
  return parts;
}

/**
 * Two first calls this tool used to refuse outright, both of which have one honest reading:
 * `args: "status --short"` (or a one-element array holding the whole line) is a command line,
 * so it is split like one; a leading `"git"` is the executable this tool already runs, so it
 * is dropped rather than passed to git as a subcommand.
 */
export function normalizeGitArgs(input: unknown): unknown | string {
  const folded = dropPadding(coerceScalars(foldToolAliases(input, GIT_ALIASES, "git"), { timeoutMs: "integer" }), GIT_PADDING);
  if (typeof folded === "string") return folded;
  const source = toolArgs(folded);
  if (source === undefined) return folded;
  let args = source.args;
  if (typeof args === "string") args = splitGitCommand(args);
  if (Array.isArray(args) && args.length === 1 && typeof args[0] === "string" && /\s/.test(args[0])) args = splitGitCommand(args[0]);
  if (Array.isArray(args) && args.length > 1 && typeof args[0] === "string" && args[0].trim().toLowerCase() === "git") args = args.slice(1);
  return args === source.args ? source : { ...source, args };
}

function errorResult(message: string): ToolExecutionResult { return { content: message, isError: true }; }
function runtime(context: ToolExecutionContext, root?: string): { cwd: string; origin: string; store: ArtifactStore } {
  const value = context as Partial<ToolRuntimeContext>;
  const workspace = typeof value.workspace === "string" && value.workspace.length > 0 ? value.workspace : process.cwd();
  const cwd = typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd : workspace;
  const origin = typeof value.origin === "string" && value.origin.length > 0 ? value.origin : root ?? workspace;
  return { cwd, origin, store: value.artifactStore ?? createArtifactStore(origin) };
}
async function realCwd(path: string): Promise<string> { return await realpath(path); }
function parse(input: unknown): { args: string[]; cwd?: string; timeoutMs?: number } | string {
  const folded = normalizeGitArgs(input);
  if (typeof folded === "string") return folded;
  const args = folded;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object with args";
  const value = args as Record<string, unknown>;
  if (!Array.isArray(value.args) || value.args.length === 0 || value.args.some((arg) => typeof arg !== "string")) return "args must be a non-empty array of already-split strings, such as [\"status\", \"--short\"]";
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
  normalize(args: unknown): unknown | string { return normalizeGitArgs(args); }

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const parsed = parse(input);
    if (typeof parsed === "string") return errorResult(`Invalid git arguments: ${parsed}.`);
    const base = runtime(context, this.#options.root);
    const requested = parsed.cwd === undefined ? base.cwd : resolve(base.cwd, parsed.cwd);
    let cwd: string;
    try { cwd = await realCwd(requested); }
    catch (error) { return errorResult(`Git cwd is unavailable: ${error instanceof Error ? error.message : String(error)}.`); }
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
