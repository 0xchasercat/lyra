import type { ProviderErrorClass } from "./errors.ts";

export type ProviderApiType =
  | "openai_completions"
  | "openai_responses"
  | "openai_websocket"
  | "anthropic_messages";

export type MessageRole = "user" | "assistant";

export type TextBlock = { type: "text"; text: string };
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
  | { type: "text_delta"; text: string }
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
