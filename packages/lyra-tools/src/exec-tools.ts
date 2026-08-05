import { resolve } from "node:path";
import { ProcessHost, type HostProcess, type JobHandle, type ProcessResult } from "@lyra/host";
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
  processHost?: HostProcess;
  activity?: (event: { type: "bash_started" | "bash_finished"; command: string; cwd: string; jobId?: string; exitCode?: number | null }) => void;
}

export interface BashRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export type BashCompleted = ProcessResult;

export const BASH_DEFINITION: ToolDefinition = Object.freeze({
  name: "bash",
  description: "Run a shell command from the model-selected working directory and report complete stdout, stderr, exit status, and cancellation details.",
  inputSchema: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: "string", minLength: 1, description: "The exact command to run." },
      cwd: { type: "string", minLength: 1, description: "Optional absolute or cwd-relative working directory." },
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

  async execute(args: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const parsed = parseArgs(args);
    if (typeof parsed === "string") return errorResult(`Invalid bash arguments: ${parsed}.`);
    const base = runtime(context, this.#options.root);
    const requested = parsed.cwd === undefined ? base.cwd : resolve(base.cwd, parsed.cwd);
    const cwd = requested;
    const timeoutMs = parsed.timeoutMs ?? this.#options.maxInlineMs;
    this.#options.activity?.({ type: "bash_started", command: parsed.command, cwd });
    try {
      const launched = await this.#host.run({ command: parsed.command, cwd, timeoutMs, signal: context.signal });
      if (isJobHandle(launched)) {
        this.#options.activity?.({ type: "bash_started", command: parsed.command, cwd, jobId: launched.id });
        return { content: `Started heavy bash command as job ${launched.id}. Use the host job wait/status API to retrieve complete output.`, metadata: { jobId: launched.id, command: parsed.command, cwd, heavy: true } };
      }
      this.#options.activity?.({ type: "bash_finished", command: parsed.command, cwd, exitCode: launched.exitCode });
      return { content: await present(launched, base.store, this.#options.displayBudget), ...(launched.exitCode === 0 ? {} : { isError: true }) };
    } catch (error) { return errorResult(`Bash failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  async close(): Promise<void> { if (this.#ownsHost) await this.#host.close(); }
}

export function createBashTool(options: BashToolOptions = {}): BashTool { return new BashTool(options); }
