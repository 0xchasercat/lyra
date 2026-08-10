import type { AgentEvent, SteerBoundary, ToolExecutionResult, ToolProgress } from "@lyra/core";

/**
 * The wire vocabulary from `schema/protocol.json`, expressed as TypeScript, plus the
 * encoder that produces it.
 *
 * These types are the daemon-side mirror of the schema. They are not the contract — the
 * schema file is — and the conformance suite validates real encoder output against it, so
 * the two cannot drift silently.
 *
 * The encoder's whole job is turning a flat stream of loop events into *addressed*
 * semantic deltas: every streamed character is an append to one (messageId, partId, field)
 * triple, so a client can apply it without ever re-laying-out finished content. It also
 * owns the two things the loop cannot know: message/part identity, and the pause brackets
 * that a `turn_resume` must close.
 */

export type ProviderClassification =
  | "transient"
  | "context_overflow"
  | "content_shape"
  | "auth"
  | "quota"
  | "model_unavailable"
  | "bad_request"
  | "refusal";
export type StopReasonWire = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "cancelled";
export type ApiTypeWire = "openai_completions" | "openai_responses" | "openai_websocket" | "anthropic_messages";
export type PartKind = "text" | "thinking" | "reasoning" | "tool_call";
export type DeltaField = "text" | "thinking" | "signature" | "arguments";
export type ToolStatus = "ok" | "error" | "denied";
export type TurnStatus = "completed" | "cancelled" | "truncated" | "refusal" | "error";
export type TurnSource = "user" | "steer" | "loop" | "command";
export type PauseKind = "retry" | "compaction" | "context_repair" | "steer" | "transport_fallback";

export interface WireError {
  classification: ProviderClassification;
  message: string;
  code?: string;
  status?: number;
}

export type SessionUpdate =
  | { sessionUpdate: "turn_start"; turnId: string; promptEntryId?: string; source: TurnSource; startedAtMs: number }
  | { sessionUpdate: "turn_resume"; turnId: string; after: PauseKind; pausedMs: number }
  | {
    sessionUpdate: "turn_end";
    turnId: string;
    status: TurnStatus;
    stopReason?: StopReasonWire;
    durationMs: number;
    partialRetained: boolean;
    promptTrimmed?: boolean;
    hardStopRequested?: boolean;
    error?: WireError;
  }
  | { sessionUpdate: "message_start"; turnId: string; messageId: string; role: "assistant" }
  | { sessionUpdate: "part_start"; messageId: string; partId: string; kind: PartKind; toolCallId?: string }
  | { sessionUpdate: "delta"; messageId: string; partId: string; field: DeltaField; delta: string }
  | { sessionUpdate: "part_end"; messageId: string; partId: string }
  | { sessionUpdate: "reasoning_item"; messageId: string; partId: string; provider: string; item: Record<string, unknown> }
  | { sessionUpdate: "message_end"; messageId: string; stopReason: StopReasonWire }
  | { sessionUpdate: "tool_call_start"; toolCallId: string; messageId: string; partId: string; tool: string; argsSummary?: string }
  | {
    sessionUpdate: "tool_call_update";
    toolCallId: string;
    status: "pending" | "running";
    tool?: string;
    argsSummary?: string;
    args?: unknown;
    startedAtMs?: number;
  }
  | {
    sessionUpdate: "tool_call_end";
    toolCallId: string;
    tool?: string;
    status: ToolStatus;
    resultSummary?: string;
    durationMs: number;
    interrupted?: boolean;
    progress?: ToolProgress;
  }
  | {
    sessionUpdate: "retry";
    attempt: number;
    maxAttempts: number;
    classification: ProviderClassification;
    providerMessage: string;
    delayMs: number;
    retryAtMs: number;
    resetsPartialOutput: boolean;
  }
  | { sessionUpdate: "compaction"; boundaryId: string; tokensBefore: number; tokensAfter: number; firstKeptEntry: string | null }
  | { sessionUpdate: "context_repair"; repairs: Array<{ code: string; detail: string; entryId?: string; tokenEstimate?: number }> }
  | { sessionUpdate: "context"; tokenEstimate: number; sourceEntryCount: number; contextWindow?: number }
  | { sessionUpdate: "usage"; turn: TurnUsage; session: SessionUsage }
  | { sessionUpdate: "steer"; entryId: string; text: string; at: SteerBoundary }
  | { sessionUpdate: "loop_warning"; warning: Record<string, unknown>; hardStopRequested: boolean }
  | { sessionUpdate: "transport_fallback"; from: ApiTypeWire; to: ApiTypeWire; reason: string; resetsPartialOutput: boolean }
  | { sessionUpdate: "error"; error: WireError }
  | { sessionUpdate: "report"; message: string }
  | { sessionUpdate: "model_changed"; provider: string; model: string; apiType?: ApiTypeWire }
  | { sessionUpdate: "session_changed"; descriptor: Record<string, unknown>; reason: "new" | "load" | "fork" | "rewind" };

/**
 * Token counts for the single provider call that just finished.
 *
 * `turn` and `session` are separate objects rather than a flat record with two
 * naming conventions: `inputTokens` next to `sessionInputTokens` reads as a typo,
 * and a client that mixed them up would silently render one call's numbers as the
 * session total.
 */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Cumulative token counts for the whole session, plus cost when pricing is known. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  /** Omitted when the active model has no known pricing — never estimated. */
  costMicroUsd?: number;
}

/** Cumulative, session-scoped measurements the encoder attaches to usage and context events. */
export interface UsageContext {
  sessionInputTokens: number;
  sessionOutputTokens: number;
  /** Omitted when the active model has no known pricing — never estimated. */
  costMicroUsd?: number;
  /** Omitted when no verified context limit is known — never guessed from a default. */
  contextWindow?: number;
}

export interface EncoderOptions {
  sessionId: string;
  /** Read at emit time so cumulative counters are current. */
  usage: () => UsageContext;
  now?: () => number;
}

export interface TurnEndInput {
  status: TurnStatus;
  stopReason?: StopReasonWire;
  partialRetained: boolean;
  promptTrimmed?: boolean;
  hardStopRequested?: boolean;
  error?: WireError;
}

interface OpenPart {
  partId: string;
  kind: PartKind;
  toolCallId?: string;
}

export class SessionUpdateEncoder {
  readonly sessionId: string;
  readonly #usage: () => UsageContext;
  readonly #now: () => number;
  #turnSequence = 0;
  #messageSequence = 0;
  #partSequence = 0;
  #turnId: string | undefined;
  #turnStartedAt = 0;
  #messageId: string | undefined;
  #part: OpenPart | undefined;
  #lastThinkingPartId: string | undefined;
  /** `minted` marks a part the encoder created because the provider never streamed the call. */
  #toolParts = new Map<string, { partId: string; messageId: string; tool: string; minted?: boolean }>();
  #toolStarts = new Map<string, { tool: string; startedAtMs: number }>();
  #pause: { kind: PauseKind; atMs: number } | undefined;

  constructor(options: EncoderOptions) {
    if (!options || typeof options.sessionId !== "string" || options.sessionId.length === 0) {
      throw new TypeError("A session update encoder needs a session id.");
    }
    if (typeof options.usage !== "function") throw new TypeError("A session update encoder needs a usage reader.");
    this.sessionId = options.sessionId;
    this.#usage = options.usage;
    this.#now = options.now ?? Date.now;
  }

  get turnId(): string | undefined {
    return this.#turnId;
  }

  beginTurn(source: TurnSource, promptEntryId?: string): SessionUpdate[] {
    this.#turnSequence += 1;
    this.#turnId = `turn-${this.#turnSequence}`;
    this.#turnStartedAt = this.#now();
    this.#messageId = undefined;
    this.#part = undefined;
    this.#lastThinkingPartId = undefined;
    this.#toolParts.clear();
    this.#toolStarts.clear();
    this.#pause = undefined;
    return [{
      sessionUpdate: "turn_start",
      turnId: this.#turnId,
      ...(promptEntryId === undefined ? {} : { promptEntryId }),
      source,
      startedAtMs: this.#turnStartedAt,
    }];
  }

  endTurn(input: TurnEndInput): SessionUpdate[] {
    const updates: SessionUpdate[] = [];
    const turnId = this.#turnId ?? `turn-${this.#turnSequence || 1}`;
    updates.push(...this.closePause(turnId));
    updates.push(...this.closePart());
    updates.push({
      sessionUpdate: "turn_end",
      turnId,
      status: input.status,
      ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason }),
      durationMs: Math.max(0, this.#now() - this.#turnStartedAt),
      partialRetained: input.partialRetained,
      ...(input.promptTrimmed === undefined ? {} : { promptTrimmed: input.promptTrimmed }),
      ...(input.hardStopRequested === undefined ? {} : { hardStopRequested: input.hardStopRequested }),
      ...(input.error === undefined ? {} : { error: input.error }),
    });
    this.#turnId = undefined;
    this.#messageId = undefined;
    this.#part = undefined;
    return updates;
  }

  report(message: string): SessionUpdate {
    return { sessionUpdate: "report", message };
  }

  /** Translates one loop event into zero or more addressed updates. */
  encode(event: AgentEvent): SessionUpdate[] {
    const updates: SessionUpdate[] = [];
    const opens = pauseOpenedBy(event);
    // Any event that is not itself continuing the current pause closes it. This is what
    // guarantees a client's "paused" indicator can never be orphaned.
    if (this.#pause !== undefined) updates.push(...this.closePause(this.#turnId));
    updates.push(...this.encodeEvent(event));
    if (opens !== undefined) this.#pause = { kind: opens, atMs: this.#now() };
    return updates;
  }

  private encodeEvent(event: AgentEvent): SessionUpdate[] {
    switch (event.type) {
      case "text_delta":
        return event.text.length === 0 ? [] : this.delta("text", "text", event.text);
      case "thinking_delta":
        return event.thinking.length === 0 ? [] : this.delta("thinking", "thinking", event.thinking);
      case "thinking_signature": {
        const partId = this.#part?.kind === "thinking" ? this.#part.partId : this.#lastThinkingPartId;
        if (partId === undefined || this.#messageId === undefined) return [];
        return [{
          sessionUpdate: "delta",
          messageId: this.#messageId,
          partId,
          field: "signature",
          delta: event.signature,
        }];
      }
      case "reasoning_item": {
        const updates = this.closePart();
        const messageId = this.ensureMessage(updates);
        const partId = this.nextPartId();
        updates.push({ sessionUpdate: "part_start", messageId, partId, kind: "reasoning" });
        updates.push({
          sessionUpdate: "reasoning_item",
          messageId,
          partId,
          provider: "openai",
          item: { ...event.item },
        });
        updates.push({ sessionUpdate: "part_end", messageId, partId });
        return updates;
      }
      case "tool_call_start": {
        const updates = this.closePart();
        const messageId = this.ensureMessage(updates);
        const partId = this.nextPartId();
        this.#part = { partId, kind: "tool_call", toolCallId: event.id };
        this.#toolParts.set(event.id, { partId, messageId, tool: event.name });
        updates.push({ sessionUpdate: "part_start", messageId, partId, kind: "tool_call", toolCallId: event.id });
        updates.push({ sessionUpdate: "tool_call_start", toolCallId: event.id, messageId, partId, tool: event.name });
        return updates;
      }
      case "tool_call_delta": {
        const part = this.#toolParts.get(event.id);
        if (part === undefined || event.argumentsDelta.length === 0) return [];
        return [{
          sessionUpdate: "delta",
          messageId: part.messageId,
          partId: part.partId,
          field: "arguments",
          delta: event.argumentsDelta,
        }];
      }
      case "tool_call_end": {
        const part = this.#toolParts.get(event.id);
        if (part === undefined) return [];
        if (this.#part?.partId === part.partId) this.#part = undefined;
        return [{ sessionUpdate: "part_end", messageId: part.messageId, partId: part.partId }];
      }
      case "tool_started": {
        const updates: SessionUpdate[] = [];
        if (this.#toolParts.get(event.id) === undefined) {
          // A provider that never streamed the call still gets the full lifecycle. The
          // part is minted *here* rather than left to the client: a tool row has to live
          // somewhere in the message tree, and the encoder is the only place that knows
          // the identity scheme. That is what lets `messageId`/`partId` be required on
          // `tool_call_start` instead of a client-side "materialise a home" special case.
          updates.push(...this.closePart());
          const messageId = this.ensureMessage(updates);
          const partId = this.nextPartId();
          this.#part = { partId, kind: "tool_call", toolCallId: event.id };
          this.#toolParts.set(event.id, { partId, messageId, tool: event.name, minted: true });
          updates.push({ sessionUpdate: "part_start", messageId, partId, kind: "tool_call", toolCallId: event.id });
          updates.push({ sessionUpdate: "tool_call_start", toolCallId: event.id, messageId, partId, tool: event.name });
        }
        const startedAtMs = this.#now();
        this.#toolStarts.set(event.id, { tool: event.name, startedAtMs });
        const summary = summarizeArgs(event.input);
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId: event.id,
          status: "running",
          tool: event.name,
          ...(summary === undefined ? {} : { argsSummary: summary }),
          args: event.input,
          startedAtMs,
        });
        return updates;
      }
      case "tool_finished": {
        const start = this.#toolStarts.get(event.id);
        this.#toolStarts.delete(event.id);
        const summary = summarizeResult(event.result);
        const updates: SessionUpdate[] = [];
        // A minted part has no `tool_call_end` loop event to close it, so it is closed
        // here — in the same order the streamed path uses, part before result.
        const part = this.#toolParts.get(event.id);
        if (part?.minted === true) {
          this.#toolParts.delete(event.id);
          if (this.#part?.partId === part.partId) this.#part = undefined;
          updates.push({ sessionUpdate: "part_end", messageId: part.messageId, partId: part.partId });
        }
        updates.push({
          sessionUpdate: "tool_call_end",
          toolCallId: event.id,
          tool: event.name,
          status: toolStatus(event.result),
          ...(summary === undefined ? {} : { resultSummary: summary }),
          durationMs: start === undefined ? 0 : Math.max(0, this.#now() - start.startedAtMs),
          ...(isInterrupted(event.result) ? { interrupted: true } : {}),
          ...(event.result.progress === undefined ? {} : { progress: event.result.progress }),
        });
        return updates;
      }
      case "usage": {
        const totals = this.#usage();
        return [{
          sessionUpdate: "usage",
          turn: {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            ...(event.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: event.usage.cacheReadTokens }),
            ...(event.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: event.usage.cacheWriteTokens }),
          },
          session: {
            inputTokens: totals.sessionInputTokens,
            outputTokens: totals.sessionOutputTokens,
            ...(totals.costMicroUsd === undefined ? {} : { costMicroUsd: totals.costMicroUsd }),
          },
        }];
      }
      case "retry": {
        const { classification, providerMessage } = splitRetryReason(event);
        const delayMs = Math.max(0, Math.round(event.delayMs));
        // A retry that discards partial output ends the message the client is rendering,
        // so identity restarts here rather than silently continuing into a stale part.
        if (event.resetsPartialOutput) {
          this.#part = undefined;
          this.#messageId = undefined;
          this.#lastThinkingPartId = undefined;
        }
        return [{
          sessionUpdate: "retry",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          classification,
          providerMessage,
          delayMs,
          retryAtMs: event.retryAtMs ?? this.#now() + delayMs,
          resetsPartialOutput: event.resetsPartialOutput,
        }];
      }
      case "transport_fallback": {
        if (event.resetsPartialOutput === true) {
          this.#part = undefined;
          this.#messageId = undefined;
          this.#lastThinkingPartId = undefined;
        }
        // An expected fallback is plumbing: `websocket = "auto"` asked the transport to use a
        // socket *if there is one*, and there usually is not. The identity reset above still
        // happens — only the sentence is withheld, and with it the pause bracket that would
        // otherwise resume from a pause the client was never told about.
        if (event.expected === true) return [];
        return [{
          sessionUpdate: "transport_fallback",
          from: event.from,
          to: event.to,
          reason: event.reason,
          resetsPartialOutput: event.resetsPartialOutput === true,
        }];
      }
      case "complete": {
        const updates = this.closePart();
        if (this.#messageId !== undefined) {
          updates.push({ sessionUpdate: "message_end", messageId: this.#messageId, stopReason: event.stopReason });
          this.#messageId = undefined;
          this.#lastThinkingPartId = undefined;
        }
        return updates;
      }
      case "compacted":
        return [{
          sessionUpdate: "compaction",
          boundaryId: event.boundaryId,
          tokensBefore: event.tokensBefore,
          tokensAfter: event.tokensAfter,
          firstKeptEntry: event.firstKeptEntry,
        }];
      case "context_repaired":
        return event.repairs.length === 0 ? [] : [{
          sessionUpdate: "context_repair",
          repairs: event.repairs.map((repair) => ({
            code: repair.code,
            detail: repair.detail,
            ...(repair.entryId === undefined ? {} : { entryId: repair.entryId }),
            ...(repair.tokenEstimate === undefined ? {} : { tokenEstimate: repair.tokenEstimate }),
          })),
        }];
      case "context_measured": {
        const contextWindow = this.#usage().contextWindow;
        return [{
          sessionUpdate: "context",
          tokenEstimate: event.tokenEstimate,
          sourceEntryCount: event.sourceEntryCount,
          ...(contextWindow === undefined ? {} : { contextWindow }),
        }];
      }
      case "steered":
        return [{ sessionUpdate: "steer", entryId: event.entryId, text: event.text, at: event.at }];
      case "loop_warning":
        return [{
          sessionUpdate: "loop_warning",
          warning: { ...event.warning },
          hardStopRequested: event.hardStopRequested === true,
        }];
    }
  }

  private delta(kind: PartKind, field: DeltaField, text: string): SessionUpdate[] {
    const updates: SessionUpdate[] = [];
    const messageId = this.ensureMessage(updates);
    if (this.#part === undefined || this.#part.kind !== kind) {
      updates.push(...this.closePart());
      const partId = this.nextPartId();
      this.#part = { partId, kind };
      if (kind === "thinking") this.#lastThinkingPartId = partId;
      updates.push({ sessionUpdate: "part_start", messageId, partId, kind });
    }
    updates.push({ sessionUpdate: "delta", messageId, partId: this.#part.partId, field, delta: text });
    return updates;
  }

  private ensureMessage(updates: SessionUpdate[]): string {
    if (this.#messageId !== undefined) return this.#messageId;
    this.#messageSequence += 1;
    const turnId = this.#turnId ?? `turn-${this.#turnSequence || 1}`;
    this.#messageId = `${turnId}-msg-${this.#messageSequence}`;
    updates.push({ sessionUpdate: "message_start", turnId, messageId: this.#messageId, role: "assistant" });
    return this.#messageId;
  }

  private nextPartId(): string {
    this.#partSequence += 1;
    return `${this.#messageId ?? "orphan"}-part-${this.#partSequence}`;
  }

  private closePart(): SessionUpdate[] {
    if (this.#part === undefined || this.#messageId === undefined) {
      this.#part = undefined;
      return [];
    }
    const closed: SessionUpdate = { sessionUpdate: "part_end", messageId: this.#messageId, partId: this.#part.partId };
    this.#part = undefined;
    return [closed];
  }

  private closePause(turnId: string | undefined): SessionUpdate[] {
    const pause = this.#pause;
    if (pause === undefined) return [];
    this.#pause = undefined;
    return [{
      sessionUpdate: "turn_resume",
      turnId: turnId ?? `turn-${this.#turnSequence || 1}`,
      after: pause.kind,
      pausedMs: Math.max(0, this.#now() - pause.atMs),
    }];
  }
}

/** Which pause bracket, if any, this event opens. */
function pauseOpenedBy(event: AgentEvent): PauseKind | undefined {
  switch (event.type) {
    case "retry": return "retry";
    case "compacted": return "compaction";
    case "context_repaired": return "context_repair";
    case "steered": return "steer";
    case "transport_fallback": return event.expected === true ? undefined : "transport_fallback";
    default: return undefined;
  }
}

const CLASSIFICATIONS: readonly ProviderClassification[] = [
  "transient",
  "context_overflow",
  "content_shape",
  "auth",
  "quota",
  "model_unavailable",
  "bad_request",
  "refusal",
];

/**
 * Retry events carry raw fields. The `reason` split is only a fallback for a transport
 * that predates them; it never invents a classification.
 */
function splitRetryReason(
  event: { classification?: string; providerMessage?: string; reason: string },
): { classification: ProviderClassification; providerMessage: string } {
  if (isClassification(event.classification)) {
    return { classification: event.classification, providerMessage: event.providerMessage ?? event.reason };
  }
  const separator = event.reason.indexOf(": ");
  const head = separator < 0 ? event.reason : event.reason.slice(0, separator);
  return isClassification(head)
    ? { classification: head, providerMessage: event.reason.slice(separator + 2) }
    : { classification: "transient", providerMessage: event.reason };
}

function isClassification(value: unknown): value is ProviderClassification {
  return typeof value === "string" && (CLASSIFICATIONS as readonly string[]).includes(value);
}

function toolStatus(result: ToolExecutionResult): ToolStatus {
  if (result.metadata?.denied === true) return "denied";
  return result.isError === true ? "error" : "ok";
}

function isInterrupted(result: ToolExecutionResult): boolean {
  return result.metadata?.interrupted === "steer";
}

const SUMMARY_KEYS = ["path", "file_path", "command", "query", "pattern", "task", "name", "op", "to", "channel"] as const;

/** One-line, human-facing argument summary — the collapsed tool row's subject. */
export function summarizeArgs(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input === undefined ? undefined : truncate(String(input));
  }
  const record = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) parts.push(value);
    if (parts.length === 2) break;
  }
  if (parts.length > 0) return truncate(parts.join(" "));
  const encoded = safeJson(record);
  return encoded === undefined ? undefined : truncate(encoded);
}

/** First meaningful line of a tool result — the collapsed row's outcome. */
export function summarizeResult(result: ToolExecutionResult): string | undefined {
  const text = typeof result.content === "string"
    ? result.content
    : result.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
  const first = text.split("\n").find((line) => line.trim().length > 0);
  return first === undefined ? undefined : truncate(first.trim());
}

function truncate(value: string, limit = 200): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function safeJson(value: unknown): string | undefined {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined || encoded === "{}" ? undefined : encoded;
  } catch {
    return undefined;
  }
}
