import type {
  ContentBlock,
  ReliableProviderEvent,
  StopReason,
  ToolDefinition,
  ToolUseBlock,
} from "@lyra/provider";
import { ProviderFault, ReliableProvider } from "@lyra/provider";
import type { MessageEntry, TranscriptEntry } from "@lyra/session";
import { TranscriptStore } from "@lyra/session";
import type { Compactor } from "./compaction.ts";
import { deriveContext } from "./context.ts";
import type { LoopDetector } from "./loop-detection.ts";
import type { SteerQueue } from "./steering.ts";
import { ToolDispatcher } from "./tool-dispatch.ts";
import type {
  AgentEvent,
  AgentTurnResult,
  ContextDerivationOptions,
  DerivedContext,
  LoopWarning,
  SteerBoundary,
  ToolExecutionResult,
  ToolRegistry,
} from "./types.ts";

export const DEFAULT_AGENT_TURN_TIMEOUT_MS = 30 * 60_000;

export interface AgentLoopOptions {
  provider: ReliableProvider;
  store: TranscriptStore;
  tools: ToolRegistry;
  model: string;
  system: string;
  contextWindow: number;
  workspace: string;
  imageByteLimit?: number;
  toolTimeoutMs?: number;
  turnTimeoutMs?: number;
  compactor?: Compactor;
  loopDetector?: LoopDetector;
  /** Tools a steering message may interrupt mid-execution; defaults to the wait-class set. */
  waitTools?: readonly string[];
}

export type UserTurnContent = string | ContentBlock[];

export interface RunTurnOptions {
  /**
   * Live steering channel. Text pushed while the turn runs is drained at the next tool
   * boundary — or at the boundary where the turn would otherwise end — and appended as a
   * standalone synthetic user message, never folded into a tool result.
   */
  steering?: SteerQueue;
}

export class AgentLoop {
  readonly definitions: readonly ToolDefinition[];
  readonly system: string;

  private readonly provider: ReliableProvider;
  private readonly store: TranscriptStore;
  private readonly dispatcher: ToolDispatcher;
  private readonly derivationOptions: ContextDerivationOptions;
  private readonly turnTimeoutMs: number;
  private readonly sessionId: string;
  private readonly workspace: string;
  private readonly compactor: Compactor | undefined;
  private readonly loopDetector: LoopDetector | undefined;

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.store = options.store;
    this.system = options.system;
    this.definitions = snapshotDefinitions(options.tools.definitions());
    this.derivationOptions = Object.freeze({
      model: options.model,
      system: this.system,
      apiType: options.provider.transport.apiType,
      tools: this.definitions,
      contextWindow: options.contextWindow,
      ...(options.imageByteLimit === undefined ? {} : { imageByteLimit: options.imageByteLimit }),
    });
    this.dispatcher = new ToolDispatcher(
      options.tools,
      this.definitions.map((definition) => definition.name),
      {
        ...(options.toolTimeoutMs === undefined ? {} : { timeoutMs: options.toolTimeoutMs }),
        ...(options.waitTools === undefined ? {} : { waitTools: options.waitTools }),
      },
    );
    this.compactor = options.compactor;
    this.loopDetector = options.loopDetector;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_AGENT_TURN_TIMEOUT_MS;
    if (!Number.isFinite(this.turnTimeoutMs) || this.turnTimeoutMs <= 0) {
      throw new RangeError("Agent turn timeout must be a positive finite number");
    }
    this.sessionId = this.store.descriptor.sessionId;
    this.workspace = options.workspace;
  }

  /**
   * Executes one user turn, including every model/tool round, under one outer
   * deadline. The generator return value is the exact terminal transcript state.
   */
  async *runTurn(
    userContent: UserTurnContent,
    signal?: AbortSignal,
    options: RunTurnOptions = {},
  ): AsyncGenerator<AgentEvent, AgentTurnResult, void> {
    const turnEntries: TranscriptEntry[] = [];
    appendMessage(this.store, turnEntries, {
      role: "user",
      content: normalizeUserContent(userContent),
      status: "complete",
    });
    const steering = options.steering;
    /**
     * Drains steering into standalone user messages. Returning the events rather than
     * yielding them keeps this a plain function the generator can splice in at each of the
     * two drain points.
     */
    const drainSteering = (at: SteerBoundary): AgentEvent[] => {
      if (steering === undefined) return [];
      return steering.drain().map((text) => {
        const entry = appendMessage(this.store, turnEntries, {
          role: "user",
          content: [{ type: "text", text }],
          status: "complete",
        });
        return { type: "steered" as const, entryId: entry.id, text, at };
      });
    };

    const deadlineReason = new DOMException(
      `Agent turn exceeded its ${this.turnTimeoutMs}ms deadline`,
      "TimeoutError",
    );
    const controller = new AbortController();
    const onUserAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onUserAbort, { once: true });
    if (signal?.aborted === true) controller.abort(signal.reason);
    const timer = setTimeout(() => controller.abort(deadlineReason), this.turnTimeoutMs);

    try {
      while (true) {
        if (controller.signal.aborted) {
          const assistant = appendCancellation(
            this.store,
            turnEntries,
            new AttemptAssembly(),
            controller.signal.reason === deadlineReason,
            controller.signal.reason,
          );
          return terminalResult("cancelled", assistant, turnEntries);
        }

        let derived: DerivedContext | undefined;
        try {
          while (derived === undefined) {
            let candidate: DerivedContext;
            try {
              candidate = deriveContext(this.store.lineage(), this.derivationOptions);
            } catch (error) {
              if (this.compactor === undefined || !isContextOverflow(error)) throw error;
              const forced = await this.compactor.compact({
                force: true,
                signal: controller.signal,
              });
              if (!forced.compacted) throw error;
              turnEntries.push(forced.boundary);
              yield {
                type: "compacted",
                boundaryId: forced.boundary.id,
                tokensBefore: forced.boundary.tokensBefore,
                tokensAfter: forced.boundary.tokensAfter,
                firstKeptEntry: forced.boundary.firstKeptEntry,
              };
              continue;
            }

            if (this.compactor !== undefined) {
              const compacted = await this.compactor.compact({
                tokensBefore: candidate.tokenEstimate,
                signal: controller.signal,
              });
              if (compacted.compacted) {
                turnEntries.push(compacted.boundary);
                yield {
                  type: "compacted",
                  boundaryId: compacted.boundary.id,
                  tokensBefore: compacted.boundary.tokensBefore,
                  tokensAfter: compacted.boundary.tokensAfter,
                  firstKeptEntry: compacted.boundary.firstKeptEntry,
                };
                continue;
              }
            }
            derived = candidate;
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            appendProviderFailure(this.store, turnEntries, new AttemptAssembly(), error);
            throw error;
          }
          const assistant = appendCancellation(
            this.store,
            turnEntries,
            new AttemptAssembly(),
            controller.signal.reason === deadlineReason,
            controller.signal.reason,
          );
          return terminalResult("cancelled", assistant, turnEntries);
        }

        // The exact payload size that is about to be sent. Raw number: a client derives a
        // percentage only when it independently knows a verified context limit.
        yield {
          type: "context_measured",
          tokenEstimate: derived.tokenEstimate,
          sourceEntryCount: derived.sourceEntryIds.length,
        };

        if (derived.repairs.length > 0) {
          const repair = this.store.append({
            type: "repair",
            requestId: crypto.randomUUID(),
            repairs: derived.repairs.map((item) => ({ ...item })),
          });
          turnEntries.push(repair);
          yield { type: "context_repaired", repairs: derived.repairs };
        }

        const assembly = new AttemptAssembly();
        let completedRound = false;
        try {
          for await (const event of this.provider.stream(derived.request, controller.signal)) {
            if (event.type === "retry" && event.resetsPartialOutput) assembly.reset();
            if (event.type === "transport_fallback" && event.resetsPartialOutput === true) {
              assembly.reset();
            }

            if (event.type === "complete") {
              completedRound = true;
              const content = assembly.content();
              const calls = toolCalls(content);
              validateCompletion(event.stopReason, content, calls);
              const assistant = appendCompletedAssistant(
                this.store,
                turnEntries,
                content,
                event.stopReason,
              );
              yield event;

              if (event.stopReason !== "tool_use") {
                // Turn boundary drain: a steer that arrived while the model was closing
                // out must not be swallowed. It becomes a user turn and the loop runs on,
                // so the turn ends only once nothing is queued.
                const boundarySteers = drainSteering("turn_boundary");
                if (boundarySteers.length > 0) {
                  for (const steered of boundarySteers) yield steered;
                  break;
                }
                let hardStopRequested = false;
                if (this.loopDetector !== undefined) {
                  const detection = this.loopDetector.recordTurn([]);
                  hardStopRequested = detection.hardStopRequested;
                  for (const warning of detection.warnings) {
                    yield { type: "loop_warning", warning, hardStopRequested };
                  }
                }
                return terminalResult(event.stopReason, assistant, turnEntries, hardStopRequested);
              }

              let hardStopRequested = false;
              const warningsByCall = new Map<string, LoopWarning[]>();
              if (this.loopDetector !== undefined) {
                for (const call of calls) {
                  const detection = this.loopDetector.recordToolCall(call.name, call.input);
                  if (detection.warnings.length > 0) warningsByCall.set(call.id, detection.warnings);
                  for (const warning of detection.warnings) {
                    yield { type: "loop_warning", warning, hardStopRequested: detection.hardStopRequested };
                  }
                }
              }
              for (const call of calls) {
                yield { type: "tool_started", id: call.id, name: call.name, input: call.input };
              }
              let dispatched = await this.dispatcher.dispatch(calls, {
                signal: controller.signal,
                sessionId: this.sessionId,
                workspace: this.workspace,
                ...(steering === undefined ? {} : { interrupter: steering }),
              });
              dispatched = dispatched.map((item) => ({
                ...item,
                result: addLoopWarnings(item.result, warningsByCall.get(item.call.id) ?? []),
              }));
              if (this.loopDetector !== undefined) {
                const progress = dispatched.flatMap(({ result }) =>
                  result.progress === undefined ? [] : [result.progress]
                );
                const detection = this.loopDetector.recordTurn(progress);
                hardStopRequested = detection.hardStopRequested;
                for (const warning of detection.warnings) {
                  yield { type: "loop_warning", warning, hardStopRequested };
                }
                const last = dispatched.at(-1);
                if (last !== undefined && detection.warnings.length > 0) {
                  last.result = addLoopWarnings(last.result, detection.warnings);
                }
              }
              for (const item of dispatched) {
                yield {
                  type: "tool_finished",
                  id: item.call.id,
                  name: item.call.name,
                  result: item.result,
                };
              }
              appendMessage(this.store, turnEntries, {
                role: "user",
                content: dispatched.map(({ call, result }) => ({
                  type: "tool_result" as const,
                  toolUseId: call.id,
                  content: structuredClone(result.content),
                  ...(result.isError === undefined ? {} : { isError: result.isError }),
                })),
                status: "complete",
              });
              // Tool boundary drain — the primary steering delivery point. The synthetic
              // user message is appended *after* the tool-result message, so it is its own
              // turn in the transcript rather than a paragraph glued onto a tool result.
              for (const steered of drainSteering("tool_boundary")) yield steered;
              if (hardStopRequested) {
                const stopped = appendMessage(this.store, turnEntries, {
                  role: "assistant",
                  content: [{
                    type: "marker",
                    reason: "interrupted",
                    detail: "The unattended loop stopped after repeated turns without observable progress.",
                  }],
                  status: "interrupted",
                });
                return terminalResult("cancelled", stopped, turnEntries, true);
              }

              if (controller.signal.aborted) {
                const cancelled = appendCancellation(
                  this.store,
                  turnEntries,
                  new AttemptAssembly(),
                  controller.signal.reason === deadlineReason,
                  controller.signal.reason,
                );
                return terminalResult("cancelled", cancelled, turnEntries);
              }
              break;
            }

            assembly.accept(event);
            yield event;
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            appendProviderFailure(this.store, turnEntries, assembly, error);
            throw error;
          }
          const assistant = appendCancellation(
            this.store,
            turnEntries,
            assembly,
            controller.signal.reason === deadlineReason,
            controller.signal.reason,
          );
          return terminalResult("cancelled", assistant, turnEntries);
        }

        if (!completedRound) {
          throw new Error("ReliableProvider ended without a completion event");
        }
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onUserAbort);
    }
  }
}

type AppendMessage = Pick<MessageEntry, "role" | "content" | "status">;

function appendMessage(
  store: TranscriptStore,
  entries: TranscriptEntry[],
  message: AppendMessage,
): MessageEntry {
  const entry = store.append({
    type: "message",
    role: message.role,
    content: structuredClone(message.content),
    status: message.status,
  });
  if (entry.type !== "message") throw new Error("TranscriptStore returned the wrong entry type");
  entries.push(entry);
  return entry;
}

function appendCompletedAssistant(
  store: TranscriptStore,
  entries: TranscriptEntry[],
  content: ContentBlock[],
  stopReason: StopReason,
): MessageEntry {
  if (stopReason === "cancelled") {
    return appendMessage(store, entries, {
      role: "assistant",
      content: [...content, cancellationMarker(false, undefined)],
      status: "cancelled",
    });
  }
  if (stopReason === "max_tokens") {
    return appendMessage(store, entries, {
      role: "assistant",
      content: [...content, {
        type: "marker",
        reason: "truncated",
        detail: "The provider reached its output-token limit; the partial response was retained.",
      }],
      status: "interrupted",
    });
  }
  return appendMessage(store, entries, { role: "assistant", content, status: "complete" });
}

function appendProviderFailure(
  store: TranscriptStore,
  entries: TranscriptEntry[],
  assembly: AttemptAssembly,
  error: unknown,
): void {
  if (!(error instanceof ProviderFault)) return;
  const partial = assembly.content();
  if (partial.length > 0) {
    appendMessage(store, entries, {
      role: "assistant",
      content: [...partial, {
        type: "marker",
        reason: "interrupted",
        detail: `The provider failed before completing this response: ${error.providerMessage}`,
      }],
      status: "interrupted",
    });
  }
  const persisted = store.append({
    type: "error",
    classification: error.classification,
    message: error.providerMessage,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.status === undefined ? {} : { status: error.status }),
  });
  entries.push(persisted);
}
function appendCancellation(
  store: TranscriptStore,
  entries: TranscriptEntry[],
  assembly: AttemptAssembly,
  interrupted: boolean,
  reason: unknown,
): MessageEntry {
  return appendMessage(store, entries, {
    role: "assistant",
    content: [...assembly.content(), cancellationMarker(interrupted, reason)],
    status: interrupted ? "interrupted" : "cancelled",
  });
}

function cancellationMarker(interrupted: boolean, reason: unknown): ContentBlock {
  const reasonText = errorMessage(reason);
  return interrupted
    ? {
      type: "marker",
      reason: "interrupted",
      detail: reasonText === undefined
        ? "The turn deadline expired; partial assistant output was retained."
        : `The turn deadline expired; partial assistant output was retained. ${reasonText}`,
    }
    : {
      type: "marker",
      reason: "cancelled",
      detail: reasonText === undefined
        ? "The user cancelled the turn; partial assistant output was retained."
        : `The user cancelled the turn; partial assistant output was retained. ${reasonText}`,
    };
}

function terminalResult(
  stopReason: StopReason,
  assistant: MessageEntry,
  entries: readonly TranscriptEntry[],
  hardStopRequested = false,
): AgentTurnResult {
  return {
    stopReason,
    assistant,
    entries: [...entries],
    ...(hardStopRequested ? { hardStopRequested: true } : {}),
  };
}

function normalizeUserContent(content: UserTurnContent): ContentBlock[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : structuredClone(content);
}

function toolCalls(content: readonly ContentBlock[]): ToolUseBlock[] {
  return content.filter((block): block is ToolUseBlock => block.type === "tool_use");
}
function addLoopWarnings(
  result: ToolExecutionResult,
  warnings: readonly LoopWarning[],
): ToolExecutionResult {
  if (warnings.length === 0) return result;
  const note = warnings.map(renderLoopWarning).join("\n");
  return {
    ...result,
    content: typeof result.content === "string"
      ? `${result.content}\n\n${note}`
      : [...structuredClone(result.content), { type: "text", text: note }],
  };
}

function renderLoopWarning(warning: LoopWarning): string {
  switch (warning.type) {
    case "identical_tool_call":
      return `Loop warning: ${warning.tool} was called with identical arguments ${warning.count} consecutive times. Inspect state and change approach before repeating it.`;
    case "no_progress":
      return `Loop warning: no new observable progress was detected across ${warning.turns} turns. Reassess the approach before continuing.`;
    case "oscillation":
      return `Loop warning: ${warning.path} returned to prior content hash ${warning.hash}. Inspect the competing edits before changing it again.`;
  }
}

function isContextOverflow(error: unknown): boolean {
  return error instanceof ProviderFault && error.classification === "context_overflow";
}

function validateCompletion(
  stopReason: StopReason,
  content: readonly ContentBlock[],
  calls: readonly ToolUseBlock[],
): void {
  if (stopReason === "cancelled") return;
  if (content.length === 0) throw new Error("Provider completed an empty assistant turn");
  if (stopReason === "tool_use" && calls.length === 0) {
    throw new Error("Provider completed with tool_use but supplied no tool calls");
  }
  if (stopReason !== "tool_use" && calls.length > 0) {
    throw new Error(`Provider completed with ${stopReason} while tool calls were pending`);
  }
}

function snapshotDefinitions(definitions: readonly ToolDefinition[]): readonly ToolDefinition[] {
  const names = new Set<string>();
  const snapshot = definitions.map((definition) => {
    if (names.has(definition.name)) throw new Error(`Duplicate tool definition: ${definition.name}`);
    names.add(definition.name);
    return Object.freeze({
      name: definition.name,
      description: definition.description,
      inputSchema: deepFreeze(structuredClone(definition.inputSchema)),
    });
  });
  return Object.freeze(snapshot);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return undefined;
}

type MutableAssemblyBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "reasoning"; provider: "openai"; raw: Readonly<Record<string, unknown>> }
  | {
    type: "tool";
    id: string;
    name: string;
    argumentsJson: string;
    input?: unknown;
    complete: boolean;
  };

class AttemptAssembly {
  private blocks: MutableAssemblyBlock[] = [];
  private toolBlocks = new Map<string, Extract<MutableAssemblyBlock, { type: "tool" }>>();

  reset(): void {
    this.blocks = [];
    this.toolBlocks.clear();
  }

  accept(event: ReliableProviderEvent): void {
    switch (event.type) {
      case "text_delta": {
        if (event.text.length === 0) return;
        const last = this.blocks.at(-1);
        if (last?.type === "text") last.text += event.text;
        else this.blocks.push({ type: "text", text: event.text });
        return;
      }
      case "thinking_delta": {
        if (event.thinking.length === 0) return;
        const last = this.blocks.at(-1);
        if (last?.type === "thinking" && last.signature === undefined) last.thinking += event.thinking;
        else this.blocks.push({ type: "thinking", thinking: event.thinking });
        return;
      }
      case "thinking_signature": {
        for (let index = this.blocks.length - 1; index >= 0; index -= 1) {
          const block = this.blocks[index];
          if (block?.type === "thinking") {
            block.signature = `${block.signature ?? ""}${event.signature}`;
            return;
          }
        }
        return;
      }
      case "reasoning_item":
        this.blocks.push({ type: "reasoning", provider: "openai", raw: structuredClone(event.item) });
        return;
      case "tool_call_start": {
        const block: Extract<MutableAssemblyBlock, { type: "tool" }> = {
          type: "tool",
          id: event.id,
          name: event.name,
          argumentsJson: "",
          complete: false,
        };
        this.blocks.push(block);
        this.toolBlocks.set(event.id, block);
        return;
      }
      case "tool_call_delta": {
        const block = this.toolBlocks.get(event.id);
        if (block === undefined) throw new Error(`Arguments arrived for unknown tool call ${event.id}`);
        block.argumentsJson += event.argumentsDelta;
        return;
      }
      case "tool_call_end": {
        const block = this.toolBlocks.get(event.id);
        if (block === undefined) throw new Error(`Unknown tool call ${event.id} ended`);
        block.input = JSON.parse(block.argumentsJson) as unknown;
        block.complete = true;
        return;
      }
      case "usage":
      case "retry":
      case "transport_fallback":
      case "complete":
        return;
    }
  }

  content(): ContentBlock[] {
    const content: ContentBlock[] = [];
    for (const block of this.blocks) {
      switch (block.type) {
        case "text":
          if (block.text.length > 0) content.push({ type: "text", text: block.text });
          break;
        case "thinking":
          if (block.thinking.length > 0) {
            content.push({
              type: "thinking",
              thinking: block.thinking,
              ...(block.signature === undefined ? {} : { signature: block.signature }),
            });
          }
          break;
        case "reasoning":
          content.push({ type: "reasoning", provider: "openai", raw: structuredClone(block.raw) });
          break;
        case "tool":
          if (block.complete) {
            content.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: structuredClone(block.input),
            });
          }
          break;
      }
    }
    return content;
  }
}
