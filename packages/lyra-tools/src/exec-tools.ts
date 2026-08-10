import { resolve } from "node:path";
import { ProcessHost, classifyCommand, type HostProcess, type JobHandle, type ProcessResult } from "@lyra/host";
import type { ToolDefinition } from "@lyra/provider";
import { foldToolAliases, toolArgs, type ToolAlias, type ToolExecutionContext, type ToolExecutionResult } from "@lyra/core";
import { boundText } from "./filesystem-tools.ts";
import { coerceScalars, dropPadding, type ArtifactStore, type LyraTool, type ToolRuntimeContext } from "./types.ts";
import { createArtifactStore } from "./artifacts.ts";
export interface BashToolOptions {
  root?: string;
  displayBudget?: number;
  artifactStore?: ArtifactStore;
  maxInlineMs?: number;
  processHost?: HostProcess;
  activity?: (event: { type: "bash_started" | "bash_finished"; command: string; cwd: string; jobId?: string; exitCode?: number | null }) => void;
}

export interface BashRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  background?: boolean;
}

export type BashCompleted = ProcessResult;

export const BASH_DEFINITION: ToolDefinition = Object.freeze({
  name: "bash",
  description: "Run a shell command from the model-selected working directory and report complete stdout, stderr, exit status, and cancellation details. Put the command in `command`; every other field is optional and is best left out. Heavy commands (builds, test suites, servers) return a job id immediately — a later call with `job` set to that id collects the complete output.",
  inputSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: ["string", "array"], items: { type: "string" }, minLength: 1, minItems: 1, description: "The command to run, as one shell string. An argv array such as [\"bash\", \"-lc\", \"ls\"] is also accepted and joined. Send this to run something; leave it out or empty when job names a job you are collecting, and anything sent anyway is ignored and reported as ignored." },
      cwd: { type: "string", minLength: 1, description: "Optional absolute or cwd-relative working directory." },
      timeoutMs: { type: "integer", minimum: 1, maximum: 3_600_000, description: "Optional deadline in milliseconds. With job, how long to wait for the job to finish." },
      description: { type: "string", maxLength: 200, description: "Optional one-line summary of what the command does, shown in the UI. Has no effect on execution." },
      run_in_background: { type: "boolean", description: "Return a job id immediately instead of blocking. Heavy commands do this regardless of this flag." },
      job: { type: ["string", "null"], description: "A job id such as \"job-000001\" reported by an earlier background or heavy call. Sending it waits for that job and returns its complete output; any command sent alongside it is ignored and reported as ignored. Leave it out, empty, or null whenever you are running a command." },
    },
  }),
});

/**
 * Foreign spellings accepted at runtime and deliberately absent from the advertised schema —
 * declaring them taught strict emitters to fill every one of them at once (§3.7).
 */
const BASH_ALIASES: readonly ToolAlias[] = Object.freeze([
  { canonical: "timeoutMs", aliases: ["timeout", "timeout_ms"] },
  { canonical: "cwd", aliases: ["workdir", "working_directory", "workingDirectory"] },
  { canonical: "run_in_background", aliases: ["runInBackground", "background"] },
  { canonical: "command", aliases: ["cmd", "script"] },
]);

/** Quote one argv element so a joined array runs as the same command it described. */
function shellQuote(part: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part.split("'").join(`'\\''`)}'`;
}

/**
 * Codex-family models send `command` as an argv array. Lyra runs commands through
 * `bash -lc`, so `["bash", "-lc", script]` *is* the script, and any other argv joins back
 * losslessly once each element is quoted.
 */
export function commandFromArgv(parts: readonly string[]): string {
  const shell = parts[0] ?? "";
  if (parts.length === 3 && /(^|\/)(bash|sh|zsh)$/.test(shell) && (parts[1] === "-lc" || parts[1] === "-c")) return parts[2]!;
  return parts.map(shellQuote).join(" ");
}

/** The shape of every job id this tool hands out, so a placeholder is recognisably not one. */
const JOB_ID = /^job-[0-9a-z]+$/i;

/**
 * Optional fields a schema-complete emitter pads; blank means the model had nothing to say.
 *
 * `command` is in the list even though it is the tool's whole point, because it is optional in
 * exactly one shape: a call that carries a `job`. The same emitter that pads a real job id with
 * `command: "true"` (see `normalizeBashArgs` below) also pads it with `command: ""`, and there
 * the schema's own `minLength: 1` refused the call before `parseArgs` could collect the job —
 * making the documented collect path unreachable for the one emitter the padding exists for.
 * Dropped rather than defaulted: a blank command with no job then reaches `parseArgs`, which
 * says what to send instead, rather than surfacing as a schema violation the model cannot act on.
 */
const BASH_PADDING = Object.freeze({ command: true as const, job: true as const, cwd: true as const, description: true as const, timeoutMs: 1, run_in_background: true as const });

/** Scalars a stringifying emitter sends as text. */
const BASH_SCALARS = Object.freeze({ timeoutMs: "integer" as const, run_in_background: "boolean" as const });

/** The UI label is cosmetic; an over-long one must never cost the model its command. */
const DESCRIPTION_LIMIT = 200;

function runnable(command: unknown): boolean {
  return (typeof command === "string" && command.trim().length > 0) || (Array.isArray(command) && command.length > 0);
}

/**
 * Claude Code's `timeout` is milliseconds, so it folds onto `timeoutMs` with no conversion.
 *
 * The rest of this is defence against a provider that emits *every* declared property on
 * every call — observed live from an openai_completions proxy, which sent the whole schema
 * and padded `job` with `"?"`, `"x"`, `"."`, `".undefined"` because the field was declared as
 * a non-empty string. That padding flipped the tool into collection mode and made the call
 * unrecoverable: the model could not stop sending `job`, so it retried the same failure
 * forever. A `job` that arrives beside a real command and is not one of our ids is therefore
 * padding, and the command is the request.
 *
 * The mirror case is the same emitter's other half, also observed live: it holds a *real* job
 * id and still has to fill `command`, so it sends `job-000005` beside `"true"`. Both fields
 * survive normalization there; `parseArgs` collects the job and says the command was ignored,
 * because a model that cannot leave a field out must still be able to read its own output.
 */
export function normalizeBashArgs(input: unknown): unknown | string {
  const folded = dropPadding(coerceScalars(foldToolAliases(input, BASH_ALIASES, "bash"), BASH_SCALARS), BASH_PADDING);
  if (typeof folded === "string") return folded;
  const source = toolArgs(folded);
  if (source === undefined) return folded;
  const args = { ...source };
  if (typeof args.description === "string" && args.description.length > DESCRIPTION_LIMIT) args.description = `${args.description.slice(0, DESCRIPTION_LIMIT - 1)}…`;
  if (typeof args.job === "string") {
    const job = args.job.trim();
    // A job id we never issued cannot be collected, so beside a command it is padding and
    // alone it is a call with nothing to run — both are the command's request, not a job's.
    if (!JOB_ID.test(job)) delete args.job;
    else args.job = job;
  }
  if (!Array.isArray(args.command)) return args;
  if (args.command.length === 0 || args.command.some((part) => typeof part !== "string")) return "command as an array must contain only strings, such as [\"bash\", \"-lc\", \"ls -la\"]; a single shell string is simpler.";
  return { ...args, command: commandFromArgv(args.command as string[]) };
}

/**
 * Name the pattern that sent a command to the background, so a model that expected inline
 * output learns why it got a job id instead. The classifier owns the pattern table
 * (`@lyra/host`); this asks it, segment by segment, which part triggered.
 */
function heavyTrigger(command: string): string | undefined {
  for (const segment of command.split(/\|\||&&|[;|&\n]/)) {
    const trimmed = segment.trim();
    if (trimmed.length === 0 || classifyCommand(trimmed) !== "heavy") continue;
    const word = trimmed.split(/\s+/).find((part) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(part));
    if (word !== undefined) return word.split("/").pop();
  }
  return undefined;
}

function backgroundReason(command: string, heavy: boolean): string {
  if (!heavy) return "backgrounded: run_in_background was set";
  const trigger = heavyTrigger(command);
  return trigger === undefined
    ? "backgrounded: classified heavy, and heavy commands never block the agent"
    : `backgrounded: matched heavy pattern ${JSON.stringify(trigger)}, and heavy commands never block the agent`;
}

function runtime(context: ToolExecutionContext, root?: string): { cwd: string; origin: string; store: ArtifactStore } {
  const value = context as Partial<ToolRuntimeContext>;
  const workspace = typeof value.workspace === "string" && value.workspace.length > 0 ? value.workspace : process.cwd();
  const cwd = typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd : workspace;
  const origin = typeof value.origin === "string" && value.origin.length > 0 ? value.origin : root ?? workspace;
  const store = value.artifactStore ?? createArtifactStore(origin);
  return { cwd, origin, store };
}



type BashCall = { kind: "run"; request: BashRequest } | { kind: "collect"; job: string; timeoutMs?: number; ignoredCommand?: string };

function parseArgs(input: unknown): BashCall | string {
  const folded = normalizeBashArgs(input);
  if (typeof folded === "string") return folded;
  if (folded === null || typeof folded !== "object" || Array.isArray(folded)) return "arguments must be an object with a command";
  const value = folded as Record<string, unknown>;
  const rawTimeout = value.timeoutMs;
  if (rawTimeout !== undefined && (typeof rawTimeout !== "number" || !Number.isSafeInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > 3_600_000)) return "timeoutMs must be an integer between 1 and 3600000";
  if (value.job !== undefined) {
    if (typeof value.job !== "string" || value.job.trim().length === 0) return "job must be the job id string returned by an earlier bash call";
    // Both fields filled is the signature of an emitter that must fill them, not a
    // contradiction: the id is real, so the job is what the model is after. Refusing here is
    // what stranded a live session — it fired twice and the output was never collected.
    return {
      kind: "collect",
      job: value.job,
      ...(rawTimeout === undefined ? {} : { timeoutMs: rawTimeout }),
      ...(runnable(value.command) ? { ignoredCommand: String(value.command) } : {}),
    };
  }
  if (typeof value.command !== "string" || value.command.trim().length === 0) return "command must be a non-empty string, or pass job to collect the output of a command already started";
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.trim().length === 0)) return "cwd must be a non-empty string when provided";
  if (value.description !== undefined && typeof value.description !== "string") return "description must be a string when provided";
  const background = value.run_in_background;
  if (background !== undefined && typeof background !== "boolean") return "run_in_background must be a boolean when provided";
  // `description` is display metadata for the UI's collapsed tool row; execution ignores it.
  return {
    kind: "run",
    request: {
      command: value.command,
      ...(value.cwd === undefined ? {} : { cwd: value.cwd as string }),
      ...(rawTimeout === undefined ? {} : { timeoutMs: rawTimeout }),
      ...(background === true ? { background: true } : {}),
    },
  };
}

function errorResult(message: string): ToolExecutionResult { return { content: message, isError: true }; }

function isJobHandle(value: ProcessResult | JobHandle): value is JobHandle { return "id" in value; }

async function present(result: ProcessResult, store: ArtifactStore, budget: number): Promise<string> {
  const body = [
    `exit_code: ${result.exitCode ?? "null"}`,
    `signal: ${result.signal ?? "none"}`,
    `timed_out: ${result.signal !== null}`,
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
  readonly #host: HostProcess;
  readonly #ownsHost: boolean;
  constructor(options: BashToolOptions = {}) {
    this.#options = { displayBudget: 32 * 1024, maxInlineMs: 120_000, ...options };
    this.#host = options.processHost ?? new ProcessHost();
    this.#ownsHost = options.processHost === undefined;
  }

  normalize(args: unknown): unknown | string { return normalizeBashArgs(args); }

  async execute(args: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const parsed = parseArgs(args);
    if (typeof parsed === "string") return errorResult(`Invalid bash arguments: ${parsed}.`);
    const base = runtime(context, this.#options.root);
    if (parsed.kind === "collect") return this.#collect(parsed.job, parsed.timeoutMs ?? this.#options.maxInlineMs, base.store, parsed.ignoredCommand);
    const request = parsed.request;
    const requested = request.cwd === undefined ? base.cwd : resolve(base.cwd, request.cwd);
    const cwd = requested;
    const timeoutMs = request.timeoutMs ?? this.#options.maxInlineMs;
    this.#options.activity?.({ type: "bash_started", command: request.command, cwd });
    try {
      const launched = await this.#host.run({ command: request.command, cwd, timeoutMs, signal: context.signal, ...(request.background === true ? { background: true } : {}) });
      if (isJobHandle(launched)) {
        this.#options.activity?.({ type: "bash_started", command: request.command, cwd, jobId: launched.id });
        // Backgrounding a command the model expected to block is a surprise unless the
        // response says which rule fired (§3.7.1).
        const why = backgroundReason(request.command, launched.class === "heavy");
        return { content: `Started bash job ${launched.id} — ${why}. Call bash({ job: ${JSON.stringify(launched.id)} }) to wait for it and read the complete output.`, metadata: { jobId: launched.id, command: request.command, cwd, heavy: launched.class === "heavy", reason: why } };
      }
      this.#options.activity?.({ type: "bash_finished", command: request.command, cwd, exitCode: launched.exitCode });
      return { content: await present(launched, base.store, this.#options.displayBudget), ...(launched.exitCode === 0 ? {} : { isError: true }) };
    } catch (error) { return errorResult(`Bash failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** The other half of the job handle: without it, a heavy command's output is unreachable. */
  async #collect(id: string, timeoutMs: number, store: ArtifactStore, ignoredCommand?: string): Promise<ToolExecutionResult> {
    // Said out loud rather than dropped (§3.8): a model that padded `command` gets its output,
    // and a model that meant to run something sees exactly why it did not.
    const note = ignoredCommand === undefined ? "" : `command ignored: collecting ${id}. To run ${JSON.stringify(ignoredCommand)} instead, send it with no job.\n`;
    const ignored = ignoredCommand === undefined ? {} : { ignoredCommand };
    try {
      const known = this.#host.status?.(id);
      if (this.#host.status !== undefined && known === undefined) {
        return errorResult(`${note}No bash job ${JSON.stringify(id)} exists in this session. Job ids come from a bash call that reported "Started bash job ...".`);
      }
      const result = await this.#host.wait(id, timeoutMs);
      if (result === undefined) {
        const status = this.#host.status?.(id)?.status ?? "running";
        return { content: `${note}Bash job ${id} is still ${status} after ${timeoutMs}ms. Call bash({ job: ${JSON.stringify(id)} }) again to keep waiting.`, metadata: { jobId: id, pending: true, ...ignored } };
      }
      this.#options.activity?.({ type: "bash_finished", command: known?.command ?? id, cwd: known?.cwd ?? "", jobId: id, exitCode: result.exitCode });
      return { content: `${note}${await present(result, store, this.#options.displayBudget)}`, ...(result.exitCode === 0 ? {} : { isError: true }), metadata: { jobId: id, ...ignored } };
    } catch (error) { return errorResult(`${note}Unable to collect bash job ${id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  async close(): Promise<void> { if (this.#ownsHost) await this.#host.close(); }
}

export function createBashTool(options: BashToolOptions = {}): BashTool { return new BashTool(options); }
