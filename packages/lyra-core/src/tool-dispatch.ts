import type { ToolUseBlock } from "@lyra/provider";
import { DEFAULT_WAIT_CLASS_TOOLS, SteerInterrupt, WAIT_INTERRUPT_MESSAGE } from "./steering.ts";
import type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "./types.ts";

export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export interface ToolDispatcherOptions {
  timeoutMs?: number;
  /** Tools whose executions block on an external event and may be interrupted by steering. */
  waitTools?: readonly string[];
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

  constructor(
    private readonly registry: ToolRegistry,
    toolNames: readonly string[],
    options: ToolDispatcherOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError("Tool timeout must be a positive finite number");
    }
    this.knownTools = new Set(toolNames);
    this.waitTools = new Set(options.waitTools ?? DEFAULT_WAIT_CLASS_TOOLS);
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
    const deadline = new DOMException(
      `Tool "${call.name}" exceeded its ${this.timeoutMs}ms deadline`,
      "TimeoutError",
    );
    const onParentAbort = (): void => controller.abort(context.signal.reason);
    context.signal.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => controller.abort(deadline), this.timeoutMs);
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

    const abort = rejectOnAbort(controller.signal);
    try {
      return await Promise.race([
        this.registry.execute(call.name, structuredClone(call.input), executionContext),
        abort.promise,
      ]);
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
      `${WAIT_INTERRUPT_MESSAGE} The "${tool}" wait was cut short before its deadline; nothing was received. Read the user's message that follows before waiting again.`,
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
