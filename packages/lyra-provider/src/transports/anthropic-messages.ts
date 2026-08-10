import type { HttpTransportConfig } from "../auth.ts";
import { providerHeaders, providerSystemPrefix } from "../auth.ts";
import { fetchProviderRoute } from "../endpoints.ts";
import { classifyProviderError } from "../errors.ts";
import { parseSse, readJsonError } from "../sse.ts";
import type {
  CanonicalMessage,
  ContentBlock,
  ProviderEvent,
  ProviderRequest,
  ProviderTransport,
  ProviderUsage,
  StopReason,
  ToolDefinition,
  TransportContext,
} from "../types.ts";

export interface AnthropicCacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export interface AnthropicCacheBreakpoints {
  /** Cache the system prompt. Defaults to true. */
  system?: boolean | AnthropicCacheControl;
  /** Cache through the final content block of each named canonical message. */
  messageIds?: readonly string[];
  /** Cache through each named tool definition. */
  toolNames?: readonly string[];
}

/** Anthropic-specific options accepted in addition to the shared HTTP transport config. */
export interface AnthropicMessagesTransportConfig extends HttpTransportConfig {
  anthropicVersion?: string;
  anthropicBeta?: string | readonly string[];
  /**
   * The route under `base_url`, defaulting to `messages`.
   *
   * It is a route, not a path from the host root: the version segment belongs to `base_url`
   * (see `endpoints.ts`). This used to default to `/v1/messages`, which meant a base that
   * already ended in `/v1` — the shape half the ecosystem publishes — produced
   * `…/v1/v1/messages` and a 404 nothing explained.
   */
  path?: string;
  /** Used when a request does not specify maxOutputTokens. Defaults to 4096. */
  defaultMaxOutputTokens?: number;
  cacheBreakpoints?: AnthropicCacheBreakpoints;
}

type JsonRecord = Record<string, unknown>;
type StreamBlock =
  | { type: "text" }
  | { type: "thinking" }
  | { type: "opaque"; blockType: string }
  | { type: "tool_use"; id: string; argumentsEmitted: boolean };

/**
 * Deltas Anthropic has documented. A known delta on the wrong block is a real
 * protocol violation; an unrecognized one is a newer feature we ignore.
 */
const KNOWN_DELTA_TYPES = new Set([
  "text_delta",
  "thinking_delta",
  "signature_delta",
  "input_json_delta",
]);

const DEFAULT_VERSION = "2023-06-01";
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const EPHEMERAL_CACHE_CONTROL: AnthropicCacheControl = { type: "ephemeral" };

export class AnthropicMessagesTransport implements ProviderTransport {
  readonly apiType = "anthropic_messages" as const;
  readonly id: string;
  private readonly config: AnthropicMessagesTransportConfig;
  private readonly cacheBreakpoints: AnthropicCacheBreakpoints;

  constructor(config: AnthropicMessagesTransportConfig) {
    this.config = config;
    this.id = config.id;
    this.cacheBreakpoints = {
      system: config.cacheBreakpoints?.system ?? true,
      messageIds: [...(config.cacheBreakpoints?.messageIds ?? [])],
      toolNames: [...(config.cacheBreakpoints?.toolNames ?? [])],
    };
  }

  async *stream(
    request: ProviderRequest,
    context: TransportContext,
  ): AsyncGenerator<ProviderEvent> {
    const headers = await this.headers(context.signal);
    const systemPrefix = await providerSystemPrefix(this.config, context.signal);
    const { response, url } = await fetchProviderRoute(
      this.config,
      this.config.path ?? "messages",
      {
        method: "POST",
        headers,
        body: JSON.stringify(serializeRequest(request, this.config, this.cacheBreakpoints, systemPrefix)),
        signal: context.signal,
      },
      context.headersTimeoutMs,
    );

    if (!response.ok) {
      const body = await readJsonError(response);
      throw classifyProviderError({ status: response.status, body, headers: response.headers, url });
    }
    if (response.body === null) {
      throw contentShapeFault("Anthropic returned a successful response without an SSE body");
    }

    const blocks = new Map<number, StreamBlock>();
    let responseId: string | undefined;
    let stopReason: StopReason | undefined;
    let usage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };
    let started = false;

    for await (const sse of parseSse(response.body, context.signal)) {
      let event: JsonRecord;
      try {
        const parsed: unknown = JSON.parse(sse.data);
        if (!isRecord(parsed)) throw new Error("event payload is not an object");
        event = parsed;
      } catch (cause) {
        throw contentShapeFault(
          `Malformed Anthropic SSE JSON${sse.event === undefined ? "" : ` for ${sse.event}`}: ${errorMessage(cause)}`,
          sse.data,
        );
      }

      const eventType = stringField(event, "type", "Anthropic SSE event");
      switch (eventType) {
        case "ping":
          break;

        case "error":
          throw classifyProviderError({ body: event });

        case "message_start": {
          if (started) throw contentShapeFault("Anthropic stream contained more than one message_start", event);
          const message = recordField(event, "message", "message_start");
          responseId = optionalStringField(message, "id", "message_start.message");
          started = true;
          if (message.usage !== undefined) {
            usage = mergeUsage(usage, recordField(message, "usage", "message_start.message"));
            yield { type: "usage", usage };
          }
          break;
        }

        case "content_block_start": {
          requireStarted(started, eventType, event);
          const index = indexField(event, eventType);
          if (blocks.has(index)) {
            throw contentShapeFault(`Anthropic content block index ${index} was started more than once`, event);
          }
          const block = recordField(event, "content_block", eventType);
          const blockType = stringField(block, "type", `${eventType}.content_block`);
          switch (blockType) {
            case "text": {
              blocks.set(index, { type: "text" });
              const text = optionalStringField(block, "text", `${eventType}.content_block`);
              if (text !== undefined && text.length > 0) yield { type: "text_delta", text };
              break;
            }
            case "thinking": {
              blocks.set(index, { type: "thinking" });
              const thinking = optionalStringField(block, "thinking", `${eventType}.content_block`);
              if (thinking !== undefined && thinking.length > 0) {
                yield { type: "thinking_delta", thinking };
              }
              const signature = optionalStringField(block, "signature", `${eventType}.content_block`);
              if (signature !== undefined && signature.length > 0) {
                yield { type: "thinking_signature", signature };
              }
              break;
            }
            case "tool_use": {
              const id = stringField(block, "id", `${eventType}.content_block`);
              const name = stringField(block, "name", `${eventType}.content_block`);
              const toolBlock: StreamBlock = { type: "tool_use", id, argumentsEmitted: false };
              blocks.set(index, toolBlock);
              yield { type: "tool_call_start", id, name };
              const input = block.input;
              if (input !== undefined && !isRecord(input)) {
                throw contentShapeFault(
                  `Anthropic tool-use input at index ${index} must be an object`,
                  event,
                );
              }
              if (input !== undefined && Object.keys(input).length > 0) {
                const initialJson = JSON.stringify(input);
                if (initialJson === undefined) {
                  throw contentShapeFault(
                    `Anthropic tool-use input at index ${index} is not JSON serializable`,
                    event,
                  );
                }
                yield { type: "tool_call_delta", id, argumentsDelta: initialJson };
                toolBlock.argumentsEmitted = true;
              }
              break;
            }
            default:
              // `redacted_thinking` arrives unprompted whenever safety systems
              // encrypt a thinking block, and betas add further block types.
              // Track them so their deltas and stop event stay in sequence, but
              // emit nothing: neither has a canonical representation.
              blocks.set(index, { type: "opaque", blockType });
              break;
          }
          break;
        }

        case "content_block_delta": {
          requireStarted(started, eventType, event);
          const index = indexField(event, eventType);
          const block = blocks.get(index);
          if (block === undefined) {
            throw contentShapeFault(
              `Anthropic delta referenced content block index ${index} before it was started`,
              event,
            );
          }
          const delta = recordField(event, "delta", eventType);
          const deltaType = stringField(delta, "type", `${eventType}.delta`);
          if (block.type === "text" && deltaType === "text_delta") {
            yield { type: "text_delta", text: stringField(delta, "text", `${eventType}.delta`) };
          } else if (block.type === "thinking" && deltaType === "thinking_delta") {
            yield {
              type: "thinking_delta",
              thinking: stringField(delta, "thinking", `${eventType}.delta`),
            };
          } else if (block.type === "thinking" && deltaType === "signature_delta") {
            yield {
              type: "thinking_signature",
              signature: stringField(delta, "signature", `${eventType}.delta`),
            };
          } else if (block.type === "tool_use" && deltaType === "input_json_delta") {
            const argumentsDelta = stringField(delta, "partial_json", `${eventType}.delta`);
            if (argumentsDelta.length > 0) {
              block.argumentsEmitted = true;
              yield { type: "tool_call_delta", id: block.id, argumentsDelta };
            }
          } else if (block.type !== "opaque" && KNOWN_DELTA_TYPES.has(deltaType)) {
            throw contentShapeFault(
              `Anthropic ${deltaType} cannot apply to ${block.type} block at index ${index}`,
              event,
            );
          }
          break;
        }

        case "content_block_stop": {
          requireStarted(started, eventType, event);
          const index = indexField(event, eventType);
          const block = blocks.get(index);
          if (block === undefined) {
            throw contentShapeFault(
              `Anthropic stopped unknown content block index ${index}`,
              event,
            );
          }
          blocks.delete(index);
          if (block.type === "tool_use") {
            if (!block.argumentsEmitted) {
              yield { type: "tool_call_delta", id: block.id, argumentsDelta: "{}" };
            }
            yield { type: "tool_call_end", id: block.id };
          }
          break;
        }

        case "message_delta": {
          requireStarted(started, eventType, event);
          const delta = recordField(event, "delta", eventType);
          if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
            stopReason = parseStopReason(delta.stop_reason, event);
          }
          if (event.usage !== undefined) {
            usage = mergeUsage(usage, recordField(event, "usage", eventType));
            yield { type: "usage", usage };
          }
          break;
        }

        case "message_stop": {
          requireStarted(started, eventType, event);
          if (blocks.size !== 0) {
            throw contentShapeFault(
              `Anthropic stopped the message with open content block indices: ${[...blocks.keys()].join(", ")}`,
              event,
            );
          }
          if (stopReason === undefined) {
            throw contentShapeFault("Anthropic message_stop arrived without a stop reason", event);
          }
          yield {
            type: "complete",
            stopReason,
            ...(responseId === undefined ? {} : { responseId }),
          };
          return;
        }

        default:
          // Anthropic asks clients to ignore event types they do not know.
          break;
      }
    }

    throw contentShapeFault("Anthropic SSE stream ended before message_stop");
  }

  private async headers(signal: AbortSignal): Promise<Headers> {
    const headers = await providerHeaders(this.config, signal);
    headers.set("accept", "text/event-stream");
    if (this.config.anthropicVersion !== undefined) {
      headers.set("anthropic-version", this.config.anthropicVersion);
    } else if (!headers.has("anthropic-version")) {
      headers.set("anthropic-version", DEFAULT_VERSION);
    }
    const beta = this.config.anthropicBeta;
    if (beta !== undefined) {
      headers.set("anthropic-beta", typeof beta === "string" ? beta : beta.join(","));
    }
    return headers;
  }
}

function serializeRequest(
  request: ProviderRequest,
  config: AnthropicMessagesTransportConfig,
  breakpoints: AnthropicCacheBreakpoints,
  systemPrefix?: string,
): JsonRecord {
  const maxTokens = request.maxOutputTokens ?? config.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw contentShapeFault(`Anthropic max output tokens must be a positive integer, received ${maxTokens}`);
  }
  if (request.temperature !== undefined && !Number.isFinite(request.temperature)) {
    throw contentShapeFault(`Anthropic temperature must be finite, received ${request.temperature}`);
  }

  const messageBreakpoints = new Set(breakpoints.messageIds ?? []);
  const toolBreakpoints = new Set(breakpoints.toolNames ?? []);
  const systemCacheControl = cacheControl(breakpoints.system);
  const messages = request.messages.map((message) =>
    serializeMessage(message, messageBreakpoints.has(message.id))
  );
  const tools = request.tools.map((tool) => serializeTool(tool, toolBreakpoints.has(tool.name)));

  return {
    model: request.model,
    max_tokens: maxTokens,
    stream: true,
    system: serializeSystem(request.system, systemPrefix, systemCacheControl),
    messages,
    ...(tools.length === 0 ? {} : { tools }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
  };
}

/**
 * The system field, in the shape Anthropic's `system` accepts.
 *
 * A credential source's prefix is its *own* block, ahead of Lyra's — not a paragraph glued to
 * the front of it. The endpoints that mandate a prefix inspect the first block's text, and a
 * concatenated string is not that block. Blocks also keep the two authorships separable, which
 * is the whole reason the prefix exists instead of a whole injected vendor prompt.
 *
 * The cache breakpoint stays on the *last* block. Both blocks are static for the session, so
 * one breakpoint at the end covers the pair, and §13's cache stability is unchanged by the
 * presence of a prefix.
 */
function serializeSystem(
  system: string,
  prefix: string | undefined,
  cache: AnthropicCacheControl | undefined,
): string | JsonRecord[] {
  const tail: JsonRecord = { type: "text", text: system, ...(cache === undefined ? {} : { cache_control: cache }) };
  if (prefix === undefined || prefix.length === 0) return cache === undefined ? system : [tail];
  return [{ type: "text", text: prefix }, tail];
}

function serializeMessage(message: CanonicalMessage, cacheAtEnd: boolean): JsonRecord {
  const content: JsonRecord[] = [];
  for (const block of message.content) {
    const serialized = serializeContentBlock(block, message);
    if (serialized !== undefined) content.push(serialized);
  }
  if (content.length === 0) {
    throw contentShapeFault(`Canonical message ${JSON.stringify(message.id)} has no Anthropic-compatible content`);
  }
  if (cacheAtEnd) {
    const last = content[content.length - 1]!;
    content[content.length - 1] = { ...last, cache_control: EPHEMERAL_CACHE_CONTROL };
  }
  return { role: message.role, content };
}

function serializeContentBlock(block: ContentBlock, message: CanonicalMessage): JsonRecord | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      if (message.role !== "user") {
        throw contentShapeFault(`Image block in assistant message ${JSON.stringify(message.id)} is invalid`);
      }
      return {
        type: "image",
        source: { type: "base64", media_type: block.mediaType, data: block.data },
      };
    case "thinking":
      if (message.role !== "assistant") {
        throw contentShapeFault(`Thinking block in user message ${JSON.stringify(message.id)} is invalid`);
      }
      if (block.signature === undefined || block.signature.length === 0) return undefined;
      return { type: "thinking", thinking: block.thinking, signature: block.signature };
    case "tool_use":
      if (message.role !== "assistant") {
        throw contentShapeFault(`Tool-use block in user message ${JSON.stringify(message.id)} is invalid`);
      }
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      if (message.role !== "user") {
        throw contentShapeFault(`Tool-result block in assistant message ${JSON.stringify(message.id)} is invalid`);
      }
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: typeof block.content === "string"
          ? block.content
          : block.content.map((nested) => serializeToolResultContent(nested, message.id)),
        ...(block.isError === undefined ? {} : { is_error: block.isError }),
      };
    case "reasoning":
      throw contentShapeFault(
        `OpenAI reasoning block in message ${JSON.stringify(message.id)} cannot be sent to Anthropic`,
      );
    case "marker":
      throw contentShapeFault(
        `Marker block ${JSON.stringify(block.reason)} in message ${JSON.stringify(message.id)} must be repaired before provider serialization`,
      );
  }
}

function serializeToolResultContent(block: ContentBlock, messageId: string): JsonRecord {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") {
    return {
      type: "image",
      source: { type: "base64", media_type: block.mediaType, data: block.data },
    };
  }
  throw contentShapeFault(
    `Tool result in message ${JSON.stringify(messageId)} contains unsupported ${JSON.stringify(block.type)} content`,
  );
}

function serializeTool(tool: ToolDefinition, cacheAtEnd: boolean): JsonRecord {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(cacheAtEnd ? { cache_control: EPHEMERAL_CACHE_CONTROL } : {}),
  };
}

function cacheControl(
  setting: boolean | AnthropicCacheControl | undefined,
): AnthropicCacheControl | undefined {
  if (setting === true) return EPHEMERAL_CACHE_CONTROL;
  if (setting === false || setting === undefined) return undefined;
  if (setting.type !== "ephemeral" || (setting.ttl !== undefined && setting.ttl !== "5m" && setting.ttl !== "1h")) {
    throw contentShapeFault("Anthropic cache control must be ephemeral with an optional 5m or 1h TTL", setting);
  }
  return { ...setting };
}

function mergeUsage(current: ProviderUsage, raw: JsonRecord): ProviderUsage {
  const cacheReadTokens = optionalNonnegativeInteger(raw, "cache_read_input_tokens", "usage")
    ?? current.cacheReadTokens;
  const cacheWriteTokens = optionalNonnegativeInteger(raw, "cache_creation_input_tokens", "usage")
    ?? current.cacheWriteTokens;
  return {
    inputTokens: optionalNonnegativeInteger(raw, "input_tokens", "usage") ?? current.inputTokens,
    outputTokens: optionalNonnegativeInteger(raw, "output_tokens", "usage") ?? current.outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

function parseStopReason(value: unknown, raw: unknown): StopReason {
  if (typeof value !== "string") throw contentShapeFault("Anthropic stop_reason must be a string", raw);
  switch (value) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "refusal":
      return value;
    case "stop_sequence":
    case "pause_turn":
      return "end_turn";
    case "model_context_window_exceeded":
      return "max_tokens";
    default:
      throw contentShapeFault(`Unsupported Anthropic stop reason ${JSON.stringify(value)}`, raw);
  }
}

function requireStarted(started: boolean, eventType: string, raw: unknown): void {
  if (!started) throw contentShapeFault(`Anthropic ${eventType} arrived before message_start`, raw);
}

function indexField(record: JsonRecord, context: string): number {
  const value = record.index;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw contentShapeFault(`${context}.index must be a non-negative integer`, record);
  }
  return value as number;
}

function recordField(record: JsonRecord, field: string, context: string): JsonRecord {
  const value = record[field];
  if (!isRecord(value)) throw contentShapeFault(`${context}.${field} must be an object`, record);
  return value;
}

function stringField(record: JsonRecord, field: string, context: string): string {
  const value = record[field];
  if (typeof value !== "string") throw contentShapeFault(`${context}.${field} must be a string`, record);
  return value;
}

function optionalStringField(record: JsonRecord, field: string, context: string): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw contentShapeFault(`${context}.${field} must be a string`, record);
  return value;
}

function optionalNonnegativeInteger(
  record: JsonRecord,
  field: string,
  context: string,
): number | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw contentShapeFault(`${context}.${field} must be a non-negative integer`, record);
  }
  return value as number;
}

function contentShapeFault(message: string, raw?: unknown) {
  return classifyProviderError({
    code: "malformed_completion",
    message,
    ...(raw === undefined ? {} : { body: raw }),
  });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
