import type { ProviderErrorClass } from "./errors.ts";

export type ProviderApiType =
  | "openai_completions"
  | "openai_responses"
  | "openai_websocket"
  | "anthropic_messages";

export type MessageRole = "user" | "assistant";

/**
 * `phase` is the model's own label for what a message *is*: an intermediate update
 * (`"commentary"`) or the answer the turn was for (`"final_answer"`).
 *
 * GPT-5.5-class models emit it on every assistant message and read it back on replay. Drop it
 * and a stateless client tells the model that its own running commentary was the final answer
 * — after which it stops, having apparently already answered. It is carried opaquely: the
 * vocabulary belongs to the provider, and Lyra only has to return what it was given.
 */
export type TextBlock = { type: "text"; text: string; phase?: string };
export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
};
export type ImageBlock = {
  type: "image";
  mediaType: string;
  data: string;
};
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
export type ToolResultBlock = {
  type: "tool_result";
  toolUseId: string;
  content: string | ContentBlock[];
  isError?: boolean;
};
export type ReasoningBlock = {
  type: "reasoning";
  provider: "openai";
  raw: Readonly<Record<string, unknown>>;
};
export type MarkerBlock = {
  type: "marker";
  reason: "image_dropped" | "interrupted" | "cancelled" | "truncated";
  detail: string;
};

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ReasoningBlock
  | MarkerBlock;

export interface CanonicalMessage {
  id: string;
  role: MessageRole;
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: readonly CanonicalMessage[];
  tools: readonly ToolDefinition[];
  maxOutputTokens?: number;
  temperature?: number;
  metadata?: Readonly<Record<string, string>>;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "cancelled";

export type ProviderEvent =
  | { type: "text_delta"; text: string; phase?: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "thinking_signature"; signature: string }
  | { type: "reasoning_item"; item: Readonly<Record<string, unknown>> }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argumentsDelta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "usage"; usage: ProviderUsage }
  | {
      type: "complete";
      stopReason: StopReason;
      responseId?: string;
    };

export interface TransportContext {
  signal: AbortSignal;
  headersTimeoutMs: number;
  /**
   * Raw liveness: called the moment bytes arrive from the provider, *before* parsing decides
   * whether those bytes contained an event.
   *
   * The §3.3 stall watchdog asks "is this socket dead?", and the honest answer lives at the
   * byte level. An SSE comment (`: ping`), a blank heartbeat line, a partial frame — none of
   * them parse into a `ProviderEvent`, and all of them are the proxy in front of a reasoning
   * model proving the connection is alive while the model thinks. A watchdog fed only parsed
   * events cancels those turns; a watchdog fed this tick does not.
   *
   * Optional because a transport that never calls it is merely held to the event-level clock,
   * which is the old behaviour and still correct — just less generous.
   */
  onLiveness?: () => void;
}

export interface TransportFallbackEvent {
  type: "transport_fallback";
  from: ProviderApiType;
  to: ProviderApiType;
  reason: string;
  resetsPartialOutput?: boolean;
  /**
   * Whether this fallback is the configuration working as asked rather than something the
   * user needs to know.
   *
   * `websocket = "auto"` means *try the socket, use HTTP if it is not there*, and most
   * OpenAI-compatible endpoints — every local proxy among them — do not offer one. Announcing
   * that expected outcome put a line in front of the user at the start of every session, about
   * a preference they never expressed. Only `websocket = "on"` is a request the transport can
   * fail to honour, so only that failure is worth saying out loud.
   *
   * Consumers still act on the event: it is the announcement that is suppressed, never the
   * partial-output reset that keeps a client's rendering honest.
   */
  expected?: boolean;
}

export type TransportEvent = ProviderEvent | TransportFallbackEvent;

export interface ProviderTransport {
  readonly apiType: ProviderApiType;
  readonly id: string;
  stream(
    request: ProviderRequest,
    context: TransportContext,
  ): AsyncIterable<TransportEvent>;
  warmup?(request: ProviderRequest, context: TransportContext): Promise<void>;
  close?(): Promise<void>;
}

export interface RetryEvent {
  type: "retry";
  attempt: number;
  maxAttempts: number;
  /** Human-readable `${classification}: ${providerMessage}`; kept for existing consumers. */
  reason: string;
  /** Raw classification, so a client renders its own copy instead of parsing `reason`. */
  classification?: ProviderErrorClass;
  /** Raw provider message, unjoined. */
  providerMessage?: string;
  delayMs: number;
  /** Absolute wall-clock instant the next attempt is scheduled for (`Date.now() + delayMs`). */
  retryAtMs?: number;
  resetsPartialOutput: boolean;
}


export type ReliableProviderEvent = TransportEvent | RetryEvent;
