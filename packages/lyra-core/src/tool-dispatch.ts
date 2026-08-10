import type { ToolUseBlock } from "@lyra/provider";
import { DEFAULT_WAIT_CLASS_TOOLS, SteerInterrupt, WAIT_INTERRUPT_MESSAGE } from "./steering.ts";
import type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "./types.ts";

export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/**
 * Deadlines for the tools whose honest worst case is not two minutes (§3.4).
 *
 * The generic deadline is a guard against a tool that has hung. Three tools have a real,
 * declared duration instead, and applying the generic one to them turned a working call
 * into a failure with nothing to act on — observed live: a blocking `spawn` was killed at
 * 120s with no diagnosis at all, for a delegation whose own limit is an hour.
 *
 * Each number is that tool's own contract plus enough slack to let the tool report first,
 * which is the point: a tool that owns a deadline should be the one that explains it.
 */
export const DEFAULT_TOOL_TIMEOUTS: Readonly<Record<string, number>> = Object.freeze({
  /** §3.4 gives a delegated turn 60 minutes; the tool waits that long and then diagnoses. */
  spawn: 65 * 60_000,
  /** `bash` accepts a `timeoutMs` up to an hour and enforces it itself, per command. */
  bash: 65 * 60_000,
  /** The bus caps one wait at `IRC_MAX_WAIT_MS` (10 minutes). */
  hub: 11 * 60_000,
});

export interface ToolDispatcherOptions {
  timeoutMs?: number;
  /** Per-tool deadlines, overriding `timeoutMs` for the tools named. */
  toolTimeouts?: Readonly<Record<string, number>>;
  /** Tools whose executions block on an external event and may be interrupted by steering. */
  waitTools?: readonly string[];
  /** Snapshots the working tree before a state-changing call. See [`ToolCheckpointer`]. */
  checkpointer?: ToolCheckpointer;
  /**
   * A second, independent reader of the paths a call reported changing.
   *
   * The checkpointer already receives them, and threading a second consumer through it would
   * make the undo history responsible for things that are not undo — a code index, a watcher,
   * whatever comes next — and give each of them a way to break a checkpoint. This is the
   * smallest honest seam instead: one optional observer, called after the checkpointer, on
   * exactly the same event. It cannot fail a tool call (every throw is swallowed) and it is
   * never called for a call that changed nothing.
   */
  onFilesModified?: (report: FilesModifiedReport) => void;
}

/** What one completed tool call says it changed, as an observer sees it. */
export interface FilesModifiedReport {
  readonly tool: string;
  readonly callId: string;
  readonly filesModified: readonly string[];
}

/**
 * The undo hook, at tool-call granularity.
 *
 * A checkpoint is taken *before* every state-changing call, so the thing a user rewinds to
 * is "the moment before the model did that", not "the moment before the turn". `after`
 * closes the loop the never-clobber rule depends on: the paths a tool reports having
 * modified are what distinguishes Lyra's own changes from a human's when a restore has to
 * decide what it may revert.
 *
 * A failure here is never a tool failure. Checkpointing is a safety net, and a safety net
 * that can abort the work it protects is worse than none.
 */
export interface ToolCheckpointer {
  /** True for tools that can change the working tree. Read-only tools skip the snapshot. */
  covers(toolName: string): boolean;
  before(input: CheckpointMoment): Promise<void>;
  after(input: { tool: string; callId: string; filesModified: readonly string[] }): void;
}

/**
 * The three moments worth snapshotting. `entryId` is the transcript anchor: turn
 * boundaries know theirs exactly, and a pre-tool moment leaves it to the store, which reads
 * the transcript head it already has.
 */
export interface CheckpointMoment {
  kind: "turn_start" | "pre_tool" | "turn_end";
  tool?: string;
  callId?: string;
  entryId?: string;
}

/** Anything that can tell a blocked wait-class tool that the user has spoken. */
export interface WaitInterrupter {
  subscribe(listener: () => void): () => void;
}

export interface ToolDispatchContext {
  signal: AbortSignal;
  sessionId: string;
  workspace: string;
  /** Present while a turn accepts steering; only wait-class tools observe it. */
  interrupter?: WaitInterrupter;
}

export interface DispatchedToolResult {
  call: ToolUseBlock;
  result: ToolExecutionResult;
}

/**
 * Runs a completed assistant turn's tool calls concurrently. Promise.all keeps
 * the returned array in call order even when executions settle out of order.
 */
export class ToolDispatcher {
  readonly timeoutMs: number;
  readonly waitTools: ReadonlySet<string>;

  private readonly knownTools: ReadonlySet<string>;
  private readonly checkpointer: ToolCheckpointer | undefined;
  private readonly onFilesModified: ((report: FilesModifiedReport) => void) | undefined;
  private readonly toolTimeouts: ReadonlyMap<string, number>;

  constructor(
    private readonly registry: ToolRegistry,
    toolNames: readonly string[],
    options: ToolDispatcherOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError("Tool timeout must be a positive finite number");
    }
    const timeouts = new Map<string, number>(Object.entries({ ...DEFAULT_TOOL_TIMEOUTS, ...options.toolTimeouts }));
    for (const [name, value] of timeouts) {
      if (!Number.isFinite(value) || value <= 0) throw new RangeError(`Tool timeout for "${name}" must be a positive finite number`);
    }
    this.toolTimeouts = timeouts;
    this.knownTools = new Set(toolNames);
    this.waitTools = new Set(options.waitTools ?? DEFAULT_WAIT_CLASS_TOOLS);
    this.checkpointer = options.checkpointer;
    this.onFilesModified = options.onFilesModified;
  }

  /** The deadline one tool call runs under. Public so a caller can report it honestly. */
  deadlineFor(tool: string): number {
    return this.toolTimeouts.get(tool) ?? this.timeoutMs;
  }

  async dispatch(
    calls: readonly ToolUseBlock[],
    context: ToolDispatchContext,
  ): Promise<DispatchedToolResult[]> {
    return Promise.all(calls.map(async (call) => ({
      call,
      result: await this.executeOne(call, context),
    })));
  }

  private async executeOne(
    call: ToolUseBlock,
    context: ToolDispatchContext,
  ): Promise<ToolExecutionResult> {
    if (context.signal.aborted) return cancelledResult(call.name);
    if (!this.knownTools.has(call.name)) {
      const available = [...this.knownTools].sort().join(", ");
      return {
        content: available.length === 0
          ? `Unknown tool "${call.name}". No tools are available in this session.`
          : `Unknown tool "${call.name}". Available tools: ${available}. Choose one of the listed tools.`,
        isError: true,
      };
    }

    const controller = new AbortController();
    const timeoutMs = this.deadlineFor(call.name);
    const deadline = new DOMException(
      `Tool "${call.name}" exceeded its ${timeoutMs}ms deadline`,
      "TimeoutError",
    );
    const onParentAbort = (): void => controller.abort(context.signal.reason);
    context.signal.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => controller.abort(deadline), timeoutMs);
    // Only wait-class tools observe steering. A steer must never kill an edit or a build.
    const interrupt = new SteerInterrupt();
    const unsubscribe = context.interrupter !== undefined && this.waitTools.has(call.name)
      ? context.interrupter.subscribe(() => controller.abort(interrupt))
      : undefined;

    const executionContext: ToolExecutionContext = {
      signal: controller.signal,
      sessionId: context.sessionId,
      workspace: context.workspace,
      callId: call.id,
    };

    // Before the call, not after it: the state worth returning to is the one that existed
    // while the model was still deciding. A checkpoint that cannot be taken is reported by
    // the store itself and never stops the call.
    if (this.checkpointer !== undefined && this.checkpointer.covers(call.name)) {
      try { await this.checkpointer.before({ kind: "pre_tool", tool: call.name, callId: call.id }); } catch { /* the store warns; the work proceeds */ }
    }
    // A steer already queued when a wait-class tool is dispatched aborts synchronously
    // above, so the answer is known before anything runs — and taking it here rather than
    // through the race below is what keeps a rejected promise from existing unobserved
    // across the checkpoint's await.
    if (controller.signal.reason === interrupt) {
      clearTimeout(timer);
      unsubscribe?.();
      context.signal.removeEventListener("abort", onParentAbort);
      return waitInterruptedResult(call.name);
    }
    const abort = rejectOnAbort(controller.signal);
    try {
      const result = await Promise.race([
        this.registry.execute(call.name, structuredClone(call.input), executionContext),
        abort.promise,
      ]);
      this.report(call, result);
      return result;
    } catch (error) {
      if (controller.signal.reason === interrupt) return waitInterruptedResult(call.name);
      if (controller.signal.reason === deadline) {
        return {
          content: `${deadline.message} and was cancelled. Retry with a narrower operation or use a background job.`,
          isError: true,
        };
      }
      if (context.signal.aborted) return cancelledResult(call.name);
      return {
        content: `Tool "${call.name}" failed: ${errorMessage(error)}. Correct the input or try a different approach.`,
        isError: true,
      };
    } finally {
      clearTimeout(timer);
      abort.cleanup();
      unsubscribe?.();
      context.signal.removeEventListener("abort", onParentAbort);
    }
  }

  /**
   * Hand the checkpoint store the paths this call claims it changed.
   *
   * Only reached on a normal return. A call that threw, timed out, or was cancelled reports
   * nothing, so whatever it half-wrote is attributed to nobody — and an unattributed change
   * is one a restore refuses to revert. Erring toward "not Lyra's" is the safe direction for
   * a rule whose job is protecting work Lyra did not do.
   */
  private report(call: ToolUseBlock, result: ToolExecutionResult): void {
    const modified = result.progress?.filesModified ?? [];
    const paths = modified.map((entry) => entry.path);
    if (this.checkpointer !== undefined) {
      try { this.checkpointer.after({ tool: call.name, callId: call.id, filesModified: paths }); } catch { /* bookkeeping never fails a tool */ }
    }
    // Second, and independently: an observer that throws must not cost the checkpointer its
    // attribution, and neither of them may reach the model's result.
    if (this.onFilesModified !== undefined && paths.length > 0) {
      try { this.onFilesModified({ tool: call.name, callId: call.id, filesModified: paths }); } catch { /* observation never fails a tool */ }
    }
  }
}

function rejectOnAbort(signal: AbortSignal): { promise: Promise<never>; cleanup: () => void } {
  let listener: (() => void) | undefined;
  const promise = signal.aborted
    ? Promise.reject<never>(signal.reason)
    : new Promise<never>((_, reject) => {
      listener = () => reject(signal.reason);
      signal.addEventListener("abort", listener, { once: true });
    });
  return {
    promise,
    cleanup: () => {
      if (listener !== undefined) signal.removeEventListener("abort", listener);
    },
  };
}

/**
 * A steer-interrupted wait is not a failure: the wait simply ended early because the user
 * spoke. The model is told exactly that, and the metadata lets a client mark the row.
 */
function waitInterruptedResult(tool: string): ToolExecutionResult {
  return {
    content:
      `${WAIT_INTERRUPT_MESSAGE} The "${tool}" wait was cut short before its deadline. Nothing it was waiting for was lost or cancelled — a message is still in the inbox and a child is still running, and either can be picked up again. Read the user's message that follows before waiting again.`,
    metadata: { interrupted: "steer" },
  };
}

function cancelledResult(tool: string): ToolExecutionResult {
  return {
    content: `Tool "${tool}" was cancelled before completion. No successful result was recorded; inspect state before retrying.`,
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "an unknown execution error occurred";
}
