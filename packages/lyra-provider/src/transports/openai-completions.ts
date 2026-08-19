import { providerHeaders, providerSystemPrefix } from "../auth.ts";
import type { HttpTransportConfig } from "../auth.ts";
import type { ReasoningEffort } from "../config.ts";
import { fetchProviderRoute } from "../endpoints.ts";
import { classifyProviderError, ProviderFault } from "../errors.ts";
import { usesMaxCompletionTokens } from "../models.ts";
import { parseSse, readJsonError } from "../sse.ts";
import type {
  ContentBlock,
  ProviderEvent,
  ProviderRequest,
  ProviderTransport,
  ProviderUsage,
  StopReason,
  ToolResultBlock,
  TransportContext,
} from "../types.ts";

interface ToolCallState {
  readonly index: number;
  id?: string;
  name: string;
  argumentsText: string;
  readonly pendingArguments: string[];
  started: boolean;
}

interface StreamState {
  responseId?: string;
  stopReason?: StopReason;
  readonly toolCalls: Map<number, ToolCallState>;
  readonly toolCallIndexesById: Map<string, number>;
  toolCallsClosed: boolean;
}

export interface OpenAICompletionsTransportConfig extends HttpTransportConfig {
  /** Forwarded as `reasoning_effort` on every request this transport sends. */
  reasoningEffort?: ReasoningEffort;
}

export class OpenAICompletionsTransport implements ProviderTransport {
  readonly apiType = "openai_completions" as const;
  readonly id: string;

  constructor(private readonly config: OpenAICompletionsTransportConfig) {
    this.id = config.id;
  }

  async *stream(
    request: ProviderRequest,
    context: TransportContext,
  ): AsyncGenerator<ProviderEvent> {
    const headers = await providerHeaders(this.config, context.signal);
    const body = serializeRequest(request, await providerSystemPrefix(this.config, context.signal), this.config.reasoningEffort);
    let serializedBody: string;
    try {
      serializedBody = JSON.stringify(body);
    } catch (cause) {
      throw contentShapeFault(
        `Request for model ${JSON.stringify(request.model)} could not be serialized as JSON: ${errorMessage(cause)}`,
        body,
        cause,
      );
    }

    const { response, url } = await fetchProviderRoute(
      this.config,
      "chat/completions",
      {
        method: "POST",
        headers,
        body: serializedBody,
        signal: context.signal,
      },
      context.headersTimeoutMs,
    );

    if (!response.ok) {
      const errorBody = await readJsonError(response);
      throw classifyProviderError({
        status: response.status,
        body: errorBody,
        headers: response.headers,
        url,
      });
    }
    if (response.body === null) {
      throw contentShapeFault(
        "Provider returned a successful Chat Completions response without an SSE body",
      );
    }

    yield* parseCompletionStream(response.body, response.headers, context.signal, context.onLiveness);
  }
}

function serializeRequest(
  request: ProviderRequest,
  systemPrefix?: string,
  reasoningEffort?: ReasoningEffort,
): Readonly<Record<string, unknown>> {
  const messages: Record<string, unknown>[] = [];
  // Its own system message, ahead of Lyra's: the same separation the Anthropic transport gets
  // from a separate system block, in the shape this wire format has for it.
  if (systemPrefix !== undefined && systemPrefix.length > 0) {
    messages.push({ role: "system", content: systemPrefix });
  }
  if (request.system.length > 0) {
    messages.push({ role: "system", content: request.system });
  }
  for (const message of request.messages) {
    if (message.role === "assistant") {
      messages.push(serializeAssistantMessage(message.id, message.content));
    } else {
      messages.push(...serializeUserMessage(message.id, message.content));
    }
  }

  return {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }),
    ...(request.maxOutputTokens === undefined
      ? {}
      : usesMaxCompletionTokens(request.model)
        ? { max_completion_tokens: request.maxOutputTokens }
        : { max_tokens: request.maxOutputTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
  };
}

function serializeAssistantMessage(
  messageId: string,
  blocks: readonly ContentBlock[],
): Record<string, unknown> {
  const visibleBlocks: ContentBlock[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  let reasoningContent = "";

  for (const block of blocks) {
    if (block.type === "tool_use") {
      let argumentsJson: string | undefined;
      try {
        argumentsJson = JSON.stringify(block.input);
      } catch (cause) {
        throw contentShapeFault(
          `Assistant message ${JSON.stringify(messageId)} tool call ${JSON.stringify(block.id)} has input that cannot be serialized as JSON: ${errorMessage(cause)}`,
          block.input,
          cause,
        );
      }
      if (argumentsJson === undefined) {
        throw contentShapeFault(
          `Assistant message ${JSON.stringify(messageId)} tool call ${JSON.stringify(block.id)} has undefined input; tool arguments must be JSON-serializable`,
          block.input,
        );
      }
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: argumentsJson },
      });
    } else if (block.type === "thinking") {
      reasoningContent += block.thinking;
    } else if (block.type === "tool_result") {
      throw contentShapeFault(
        `Assistant message ${JSON.stringify(messageId)} contains tool_result ${JSON.stringify(block.toolUseId)}; Chat Completions requires tool results in user turns`,
        block,
      );
    } else if (block.type === "reasoning") {
      throw contentShapeFault(
        `Assistant message ${JSON.stringify(messageId)} contains a Responses API reasoning item that cannot be sent to Chat Completions; re-derive the request for openai_completions`,
        block,
      );
    } else if (block.type === "image") {
      throw contentShapeFault(
        `Assistant message ${JSON.stringify(messageId)} contains an image; Chat Completions only accepts image_url content in user messages`,
        block,
      );
    } else {
      visibleBlocks.push(block);
    }
  }

  const content = visibleBlocks.length === 0 && toolCalls.length > 0
    ? null
    : serializeVisibleContent(messageId, visibleBlocks);
  return {
    role: "assistant",
    content,
    ...(reasoningContent.length === 0 ? {} : { reasoning_content: reasoningContent }),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
}

function serializeUserMessage(
  messageId: string,
  blocks: readonly ContentBlock[],
): Record<string, unknown>[] {
  const resultMessages: Record<string, unknown>[] = [];
  const visibleBlocks: ContentBlock[] = [];

  for (const block of blocks) {
    if (block.type === "tool_result") {
      resultMessages.push({
        role: "tool",
        tool_call_id: block.toolUseId,
        content: serializeToolResultContent(messageId, block),
      });
    } else if (block.type === "tool_use") {
      throw contentShapeFault(
        `User message ${JSON.stringify(messageId)} contains tool_use ${JSON.stringify(block.id)}; Chat Completions requires tool calls in assistant turns`,
        block,
      );
    } else if (block.type === "thinking" || block.type === "reasoning") {
      throw contentShapeFault(
        `User message ${JSON.stringify(messageId)} contains ${block.type}; reasoning content can only appear in assistant turns`,
        block,
      );
    } else {
      visibleBlocks.push(block);
    }
  }

  if (visibleBlocks.length > 0 || resultMessages.length === 0) {
    resultMessages.push({
      role: "user",
      content: serializeVisibleContent(messageId, visibleBlocks),
    });
  }
  return resultMessages;
}

function serializeToolResultContent(messageId: string, block: ToolResultBlock): unknown {
  if (typeof block.content === "string") return block.content;
  for (const nested of block.content) {
    if (nested.type !== "text" && nested.type !== "image" && nested.type !== "marker") {
      throw contentShapeFault(
        `Tool result ${JSON.stringify(block.toolUseId)} in message ${JSON.stringify(messageId)} contains unsupported nested ${nested.type} content`,
        nested,
      );
    }
  }
  return serializeVisibleContent(messageId, block.content);
}

function serializeVisibleContent(messageId: string, blocks: readonly ContentBlock[]): unknown {
  const hasImage = blocks.some((block) => block.type === "image");
  if (!hasImage) {
    let text = "";
    for (const block of blocks) {
      if (block.type === "text") text += block.text;
      else if (block.type === "marker") text += `[${block.reason}: ${block.detail}]`;
      else {
        throw contentShapeFault(
          `Message ${JSON.stringify(messageId)} contains unsupported ${block.type} content in a Chat Completions text message`,
          block,
        );
      }
    }
    return text;
  }

  return blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") {
      return {
        type: "image_url",
        image_url: { url: `data:${block.mediaType};base64,${block.data}` },
      };
    }
    if (block.type === "marker") {
      return { type: "text", text: `[${block.reason}: ${block.detail}]` };
    }
    throw contentShapeFault(
      `Message ${JSON.stringify(messageId)} contains unsupported ${block.type} content in a multimodal Chat Completions message`,
      block,
    );
  });
}

async function* parseCompletionStream(
  body: ReadableStream<Uint8Array>,
  responseHeaders: Headers,
  signal: AbortSignal,
  onLiveness?: () => void,
): AsyncGenerator<ProviderEvent> {
  const state: StreamState = {
    toolCalls: new Map(),
    toolCallIndexesById: new Map(),
    toolCallsClosed: false,
  };
  let completed = false;

  for await (const event of parseSse(body, signal, onLiveness)) {
    const data = event.data.trim();
    if (data === "[DONE]") {
      if (state.stopReason === undefined) {
        throw contentShapeFault(
          "Provider sent [DONE] before a Chat Completions finish_reason",
          event.data,
        );
      }
      for (const toolEvent of closeToolCalls(state, event.data)) yield toolEvent;
      yield completeEvent(state);
      completed = true;
      break;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.data) as unknown;
    } catch (cause) {
      if (event.event === "error") {
        throw classifyProviderError({
          body: { message: event.data },
          headers: responseHeaders,
          cause,
        });
      }
      throw contentShapeFault(
        `SSE event contained invalid JSON (${errorMessage(cause)}); provider data was ${JSON.stringify(event.data)}`,
        event.data,
        cause,
      );
    }

    if (isStreamError(payload, event.event)) {
      const normalized = normalizeStreamError(payload);
      throw classifyProviderError({
        ...streamErrorStatus(normalized),
        body: normalized,
        headers: responseHeaders,
      });
    }
    if (!isRecord(payload)) {
      throw contentShapeFault(
        `SSE event must contain a JSON object, received ${describeValue(payload)}`,
        payload,
      );
    }

    readResponseId(payload, state);
    const usageEvent = parseUsage(payload.usage, payload);
    if (usageEvent !== undefined) yield usageEvent;

    if (!Object.hasOwn(payload, "choices")) {
      if (usageEvent === undefined) {
        throw contentShapeFault(
          "Chat Completions chunk contained neither choices nor usage",
          payload,
        );
      }
      continue;
    }
    if (!Array.isArray(payload.choices)) {
      throw contentShapeFault(
        `Chat Completions chunk choices must be an array, received ${describeValue(payload.choices)}`,
        payload,
      );
    }
    if (payload.choices.length === 0) {
      if (usageEvent === undefined) {
        throw contentShapeFault("Chat Completions chunk had an empty choices array and no usage", payload);
      }
      continue;
    }
    if (payload.choices.length !== 1) {
      throw contentShapeFault(
        `Chat Completions returned ${payload.choices.length} choices, but the canonical stream supports exactly one choice`,
        payload,
      );
    }

    const choice = payload.choices[0];
    if (!isRecord(choice)) {
      throw contentShapeFault(
        `choices[0] must be an object, received ${describeValue(choice)}`,
        payload,
      );
    }
    if (choice.index !== 0) {
      throw contentShapeFault(
        `choices[0].index must be 0, received ${describeValue(choice.index)}`,
        choice,
      );
    }
    if (!isRecord(choice.delta)) {
      throw contentShapeFault(
        `choices[0].delta must be an object, received ${describeValue(choice.delta)}`,
        choice,
      );
    }

    for (const deltaEvent of parseChoiceDelta(choice.delta, state)) yield deltaEvent;

    const finishReason = parseFinishReason(choice.finish_reason, choice);
    if (finishReason !== undefined) {
      if (state.stopReason !== undefined && state.stopReason !== finishReason) {
        throw contentShapeFault(
          `Provider changed finish_reason from ${JSON.stringify(state.stopReason)} to ${JSON.stringify(finishReason)}`,
          choice,
        );
      }
      state.stopReason = finishReason;
      for (const toolEvent of closeToolCalls(state, choice)) yield toolEvent;
    }
  }

  if (completed) return;
  if (state.stopReason === undefined) {
    throw classifyProviderError({
      code: "stream_truncated",
      message: "Chat Completions SSE stream ended before [DONE] or a finish_reason",
    });
  }
  for (const toolEvent of closeToolCalls(state, body)) yield toolEvent;
  yield completeEvent(state);
}

function parseChoiceDelta(
  delta: Readonly<Record<string, unknown>>,
  state: StreamState,
): ProviderEvent[] {
  if (state.stopReason !== undefined && Object.keys(delta).length > 0) {
    throw contentShapeFault("Provider sent a non-empty delta after finish_reason", delta);
  }
  if (delta.role !== undefined && delta.role !== null && delta.role !== "assistant") {
    throw contentShapeFault(
      `choices[0].delta.role must be assistant or null, received ${describeValue(delta.role)}`,
      delta,
    );
  }
  const events: ProviderEvent[] = [];

  if (delta.content !== undefined && delta.content !== null) {
    if (typeof delta.content !== "string") {
      throw contentShapeFault(
        `choices[0].delta.content must be a string or null, received ${describeValue(delta.content)}`,
        delta,
      );
    }
    if (delta.content.length > 0) events.push({ type: "text_delta", text: delta.content });
  }
  if (delta.refusal !== undefined && delta.refusal !== null) {
    if (typeof delta.refusal !== "string") {
      throw contentShapeFault(
        `choices[0].delta.refusal must be a string or null, received ${describeValue(delta.refusal)}`,
        delta,
      );
    }
    if (delta.refusal.length > 0) events.push({ type: "text_delta", text: delta.refusal });
  }

  const reasoningKeys = ["reasoning_content", "reasoning", "thinking"] as const;
  let reasoningDelta: string | undefined;
  for (const key of reasoningKeys) {
    const value = delta[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw contentShapeFault(
        `choices[0].delta.${key} must be a string or null, received ${describeValue(value)}`,
        delta,
      );
    }
    if (reasoningDelta === undefined || reasoningDelta.length === 0) reasoningDelta = value;
  }
  if (reasoningDelta !== undefined && reasoningDelta.length > 0) {
    events.push({ type: "thinking_delta", thinking: reasoningDelta });
  }

  const signatureKeys = ["thinking_signature", "reasoning_signature"] as const;
  let signature: string | undefined;
  for (const key of signatureKeys) {
    const value = delta[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw contentShapeFault(
        `choices[0].delta.${key} must be a string or null, received ${describeValue(value)}`,
        delta,
      );
    }
    if (signature === undefined || signature.length === 0) signature = value;
  }
  if (signature !== undefined && signature.length > 0) {
    events.push({ type: "thinking_signature", signature });
  }

  if (delta.reasoning_details !== undefined && delta.reasoning_details !== null) {
    if (!Array.isArray(delta.reasoning_details)) {
      throw contentShapeFault(
        `choices[0].delta.reasoning_details must be an array or null, received ${describeValue(delta.reasoning_details)}`,
        delta,
      );
    }
    for (const item of delta.reasoning_details) {
      if (!isRecord(item)) {
        throw contentShapeFault(
          `choices[0].delta.reasoning_details entries must be objects, received ${describeValue(item)}`,
          delta,
        );
      }
      events.push({ type: "reasoning_item", item });
    }
  }

  if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
    if (!Array.isArray(delta.tool_calls)) {
      throw contentShapeFault(
        `choices[0].delta.tool_calls must be an array or null, received ${describeValue(delta.tool_calls)}`,
        delta,
      );
    }
    if (state.toolCallsClosed) {
      throw contentShapeFault("Provider sent tool-call deltas after finish_reason", delta);
    }
    for (const toolCall of delta.tool_calls) {
      events.push(...parseToolCallDelta(toolCall, state));
    }
  }

  return events;
}

function parseToolCallDelta(toolCall: unknown, state: StreamState): ProviderEvent[] {
  if (!isRecord(toolCall)) {
    throw contentShapeFault(
      `Tool-call delta must be an object, received ${describeValue(toolCall)}`,
      toolCall,
    );
  }
  if (!isNonNegativeInteger(toolCall.index)) {
    throw contentShapeFault(
      `Tool-call delta index must be a non-negative integer, received ${describeValue(toolCall.index)}`,
      toolCall,
    );
  }
  if (
    toolCall.type !== undefined &&
    toolCall.type !== null &&
    toolCall.type !== "function"
  ) {
    throw contentShapeFault(
      `Tool-call delta ${toolCall.index} type must be function or null, received ${describeValue(toolCall.type)}`,
      toolCall,
    );
  }

  const index = toolCall.index;
  let call = state.toolCalls.get(index);
  if (call === undefined) {
    call = { index, name: "", argumentsText: "", pendingArguments: [], started: false };
    state.toolCalls.set(index, call);
  }

  if (toolCall.id !== undefined && toolCall.id !== null) {
    if (typeof toolCall.id !== "string" || toolCall.id.length === 0) {
      throw contentShapeFault(
        `Tool-call delta ${index} id must be a non-empty string, received ${describeValue(toolCall.id)}`,
        toolCall,
      );
    }
    if (call.id !== undefined && call.id !== toolCall.id) {
      throw contentShapeFault(
        `Tool-call index ${index} changed id from ${JSON.stringify(call.id)} to ${JSON.stringify(toolCall.id)}`,
        toolCall,
      );
    }
    const otherIndex = state.toolCallIndexesById.get(toolCall.id);
    if (otherIndex !== undefined && otherIndex !== index) {
      throw contentShapeFault(
        `Tool-call id ${JSON.stringify(toolCall.id)} was used for both indexes ${otherIndex} and ${index}`,
        toolCall,
      );
    }
    call.id = toolCall.id;
    state.toolCallIndexesById.set(toolCall.id, index);
  }

  const events: ProviderEvent[] = [];
  let sawArguments = false;
  if (toolCall.function !== undefined && toolCall.function !== null) {
    if (!isRecord(toolCall.function)) {
      throw contentShapeFault(
        `Tool-call delta ${index} function must be an object, received ${describeValue(toolCall.function)}`,
        toolCall,
      );
    }
    const functionDelta = toolCall.function;
    if (functionDelta.name !== undefined && functionDelta.name !== null) {
      if (typeof functionDelta.name !== "string") {
        throw contentShapeFault(
          `Tool-call delta ${index} function.name must be a string, received ${describeValue(functionDelta.name)}`,
          toolCall,
        );
      }
      if (call.started) {
        if (functionDelta.name.length > 0 && functionDelta.name !== call.name) {
          throw contentShapeFault(
            `Tool-call ${JSON.stringify(call.id)} changed function name after arguments began`,
            toolCall,
          );
        }
      } else {
        if (functionDelta.name !== call.name) call.name += functionDelta.name;
      }
    }
    if (functionDelta.arguments !== undefined && functionDelta.arguments !== null) {
      if (typeof functionDelta.arguments !== "string") {
        throw contentShapeFault(
          `Tool-call delta ${index} function.arguments must be a string, received ${describeValue(functionDelta.arguments)}`,
          toolCall,
        );
      }
      call.argumentsText += functionDelta.arguments;
      sawArguments = true;
      if (call.started) {
        events.push({ type: "tool_call_delta", id: call.id!, argumentsDelta: functionDelta.arguments });
      } else {
        call.pendingArguments.push(functionDelta.arguments);
      }
    }
  }

  if (sawArguments || call.pendingArguments.length > 0) {
    events.push(...startToolCallIfReady(call));
  }
  return events;
}

function startToolCallIfReady(call: ToolCallState): ProviderEvent[] {
  if (call.started || call.id === undefined || call.name.length === 0) return [];
  call.started = true;
  const events: ProviderEvent[] = [
    { type: "tool_call_start", id: call.id, name: call.name },
  ];
  for (const argumentsDelta of call.pendingArguments) {
    events.push({ type: "tool_call_delta", id: call.id, argumentsDelta });
  }
  call.pendingArguments.length = 0;
  return events;
}

function closeToolCalls(state: StreamState, raw: unknown): ProviderEvent[] {
  if (state.toolCallsClosed) return [];
  const events: ProviderEvent[] = [];
  const calls = [...state.toolCalls.values()].sort((left, right) => left.index - right.index);
  for (const call of calls) {
    if (call.id === undefined) {
      throw contentShapeFault(`Tool-call index ${call.index} ended without an id`, raw);
    }
    if (call.name.length === 0) {
      throw contentShapeFault(
        `Tool-call ${JSON.stringify(call.id)} at index ${call.index} ended without a function name`,
        raw,
      );
    }
    events.push(...startToolCallIfReady(call));
    if (call.argumentsText.trim().length === 0) {
      events.push({ type: "tool_call_delta", id: call.id, argumentsDelta: "{}" });
    }
    events.push({ type: "tool_call_end", id: call.id });
  }
  state.toolCallsClosed = true;
  return events;
}

function parseUsage(value: unknown, raw: unknown): ProviderEvent | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw contentShapeFault(
      `Chat Completions usage must be an object or null, received ${describeValue(value)}`,
      raw,
    );
  }

  const inputTokens = readTokenCount(value, ["prompt_tokens", "input_tokens"]);
  const outputTokens = readTokenCount(value, ["completion_tokens", "output_tokens"]);
  if (inputTokens === undefined || outputTokens === undefined) {
    throw contentShapeFault(
      "Chat Completions usage must include non-negative integer prompt_tokens/completion_tokens (or input_tokens/output_tokens)",
      value,
    );
  }

  if (
    value.prompt_tokens_details !== undefined &&
    value.prompt_tokens_details !== null &&
    !isRecord(value.prompt_tokens_details)
  ) {
    throw contentShapeFault(
      `Usage field prompt_tokens_details must be an object or null, received ${describeValue(value.prompt_tokens_details)}`,
      value,
    );
  }
  if (
    value.input_tokens_details !== undefined &&
    value.input_tokens_details !== null &&
    !isRecord(value.input_tokens_details)
  ) {
    throw contentShapeFault(
      `Usage field input_tokens_details must be an object or null, received ${describeValue(value.input_tokens_details)}`,
      value,
    );
  }
  const promptDetails = isRecord(value.prompt_tokens_details)
    ? value.prompt_tokens_details
    : isRecord(value.input_tokens_details)
      ? value.input_tokens_details
      : undefined;
  const cacheReadTokens = readOptionalTokenCount(value, [
    "cache_read_tokens",
    "cache_read_input_tokens",
  ]) ?? (promptDetails === undefined ? undefined : readOptionalTokenCount(promptDetails, ["cached_tokens"]));
  const cacheWriteTokens = readOptionalTokenCount(value, [
    "cache_write_tokens",
    "cache_creation_input_tokens",
  ]);

  const usage: ProviderUsage = {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
  return { type: "usage", usage };
}

function readTokenCount(
  source: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (!isNonNegativeInteger(value)) {
      throw contentShapeFault(
        `Usage field ${key} must be a non-negative integer, received ${describeValue(value)}`,
        source,
      );
    }
    return value;
  }
  return undefined;
}

function readOptionalTokenCount(
  source: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): number | undefined {
  return readTokenCount(source, keys);
}

function parseFinishReason(value: unknown, raw: unknown): StopReason | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw contentShapeFault(
      `finish_reason must be a string or null, received ${describeValue(value)}`,
      raw,
    );
  }
  switch (value) {
    case "stop":
    case "eos":
    case "eos_token":
    case "stop_sequence":
      return "end_turn";
    case "tool_calls":
    case "tool_call":
    case "function_call":
      return "tool_use";
    case "length":
    case "max_tokens":
      return "max_tokens";
    case "content_filter":
    case "safety":
    case "refusal":
      return "refusal";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      throw contentShapeFault(
        `Unsupported Chat Completions finish_reason ${JSON.stringify(value)}; expected stop, tool_calls, length, content_filter, or cancelled`,
        raw,
      );
  }
}

function readResponseId(payload: Readonly<Record<string, unknown>>, state: StreamState): void {
  if (payload.id === undefined || payload.id === null) return;
  if (typeof payload.id !== "string" || payload.id.length === 0) {
    throw contentShapeFault(
      `Chat Completions chunk id must be a non-empty string, received ${describeValue(payload.id)}`,
      payload,
    );
  }
  if (state.responseId !== undefined && state.responseId !== payload.id) {
    throw contentShapeFault(
      `Provider changed completion id from ${JSON.stringify(state.responseId)} to ${JSON.stringify(payload.id)}`,
      payload,
    );
  }
  state.responseId = payload.id;
}

function completeEvent(state: StreamState): ProviderEvent {
  if (state.stopReason === undefined) {
    throw contentShapeFault("Cannot complete a Chat Completions stream without finish_reason");
  }
  return {
    type: "complete",
    stopReason: state.stopReason,
    ...(state.responseId === undefined ? {} : { responseId: state.responseId }),
  };
}

function isStreamError(payload: unknown, eventName: string | undefined): boolean {
  if (eventName === "error") return true;
  if (!isRecord(payload)) return false;
  return (
    (Object.hasOwn(payload, "error") && payload.error !== null && payload.error !== undefined) ||
    payload.type === "error" ||
    payload.object === "error"
  );
}

function normalizeStreamError(payload: unknown): unknown {
  if (!isRecord(payload) || typeof payload.error !== "string") return payload;
  return { ...payload, error: { message: payload.error } };
}

function streamErrorStatus(body: unknown): { status?: number } {
  if (!isRecord(body)) return {};
  const nested = isRecord(body.error) ? body.error : undefined;
  const value = nested?.status ?? body.status;
  return typeof value === "number" && Number.isInteger(value) ? { status: value } : {};
}

function contentShapeFault(message: string, raw?: unknown, cause?: unknown): ProviderFault {
  return classifyProviderError({
    code: "malformed_completion",
    message,
    ...(raw === undefined ? {} : { body: raw }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") return "an object";
  return `${typeof value} ${String(value)}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
