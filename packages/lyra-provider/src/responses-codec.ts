import { classifyProviderError, type ProviderFault } from "./errors.ts";
import type {
  CanonicalMessage,
  ContentBlock,
  ProviderEvent,
  ProviderRequest,
  ProviderUsage,
  StopReason,
  ToolDefinition,
} from "./types.ts";

export type ResponseItem = Readonly<Record<string, unknown>>;

export interface ResponsesRequestOptions {
  stream: boolean;
  previousResponseId?: string | null;
  input?: readonly ResponseItem[];
  generate?: boolean;
  contextManagement?: readonly Readonly<Record<string, unknown>>[];
}

export function serializeResponseItems(messages: readonly CanonicalMessage[]): ResponseItem[] {
  const items: ResponseItem[] = [];
  for (const message of messages) serializeMessage(message, items);
  return items;
}

export function serializeResponseTools(tools: readonly ToolDefinition[]): ResponseItem[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

export function buildResponsesRequest(
  request: ProviderRequest,
  options: ResponsesRequestOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    instructions: request.system,
    input: options.input ?? serializeResponseItems(request.messages),
    tools: serializeResponseTools(request.tools),
    store: false,
    include: ["reasoning.encrypted_content"],
    stream: options.stream,
  };
  if (options.previousResponseId !== undefined) {
    body.previous_response_id = options.previousResponseId;
  }
  if (options.generate !== undefined) body.generate = options.generate;
  if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.metadata !== undefined) body.metadata = request.metadata;
  if (options.contextManagement !== undefined) {
    body.context_management = options.contextManagement;
  }
  return body;
}

export function responseItemsStartWith(
  items: readonly ResponseItem[],
  prefix: readonly ResponseItem[],
): boolean {
  if (prefix.length > items.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (itemFingerprint(items[index]!) !== itemFingerprint(prefix[index]!)) return false;
  }
  return true;
}
export interface PreparedResponseInput {
  fullInput: ResponseItem[];
  input: ResponseItem[];
  previousResponseId: string | null;
  incremental: boolean;
}

export class ResponsesChainState {
  private responseId: string | undefined;
  private model: string | undefined;
  private canonicalWindow: ResponseItem[] = [];
  private compacted:
    | { model: string; source: ResponseItem[]; output: readonly ResponseItem[] }
    | undefined;

  prepare(request: ProviderRequest): PreparedResponseInput {
    const fullInput = serializeResponseItems(request.messages);
    if (
      this.responseId !== undefined &&
      this.model === request.model &&
      responseItemsStartWith(fullInput, this.canonicalWindow)
    ) {
      return {
        fullInput,
        input: fullInput.slice(this.canonicalWindow.length),
        previousResponseId: this.responseId,
        incremental: true,
      };
    }

    const compacted = this.compacted;
    this.compacted = undefined;
    this.clearLiveChain();
    if (
      compacted !== undefined &&
      compacted.model === request.model &&
      responseItemsStartWith(fullInput, compacted.source)
    ) {
      return {
        fullInput,
        input: [...compacted.output, ...fullInput.slice(compacted.source.length)],
        previousResponseId: null,
        incremental: false,
      };
    }
    return { fullInput, input: fullInput, previousResponseId: null, incremental: false };
  }

  recovery(request: ProviderRequest): PreparedResponseInput {
    this.clearLiveChain();
    this.compacted = undefined;
    const fullInput = serializeResponseItems(request.messages);
    return { fullInput, input: fullInput, previousResponseId: null, incremental: false };
  }

  commit(
    request: ProviderRequest,
    prepared: PreparedResponseInput,
    responseId: string | undefined,
    output: readonly ResponseItem[],
  ): void {
    if (responseId === undefined) {
      this.clearLiveChain();
      return;
    }
    this.responseId = responseId;
    this.model = request.model;
    this.canonicalWindow = [...prepared.fullInput, ...output];
  }

  stageCompacted(
    request: ProviderRequest,
    output: readonly ResponseItem[],
  ): void {
    this.clearLiveChain();
    this.compacted = {
      model: request.model,
      source: serializeResponseItems(request.messages),
      output,
    };
  }

  break(): void {
    this.clearLiveChain();
    this.compacted = undefined;
  }

  private clearLiveChain(): void {
    this.responseId = undefined;
    this.model = undefined;
    this.canonicalWindow = [];
  }
}

export function responseError(event: unknown): ProviderFault {
  if (!isRecord(event)) {
    return malformedResponse("The provider returned a non-object error event", event);
  }
  const status = numberValue(event.status);
  return classifyProviderError({
    ...(status === undefined ? {} : { status }),
    body: event,
  });
}

export class ResponsesStreamDecoder {
  responseId: string | undefined;
  output: ResponseItem[] = [];
  completed = false;

  private readonly callsByItem = new Map<string, { id: string; name: string }>();
  private readonly callsStarted = new Set<string>();
  private readonly callArguments = new Map<string, string>();
  private readonly callsEnded = new Set<string>();
  private readonly reasoningEmitted = new Set<string>();
  private readonly textEmitted = new Set<string>();
  private refusal = false;
  private sawToolCall = false;

  consume(value: unknown): ProviderEvent[] {
    if (!isRecord(value)) throw malformedResponse("The provider returned a non-object stream event", value);
    const type = stringValue(value.type);
    if (type === undefined) throw malformedResponse("A provider stream event is missing its type", value);

    switch (type) {
      case "response.created":
      case "response.in_progress": {
        this.captureResponseId(value.response);
        return [];
      }
      case "response.output_text.delta": {
        const delta = requiredString(value.delta, "output text delta", value);
        this.textEmitted.add(contentKey(value));
        return delta.length === 0 ? [] : [{ type: "text_delta", text: delta }];
      }
      case "response.output_text.done": {
        const key = contentKey(value);
        if (this.textEmitted.has(key)) return [];
        const text = requiredString(value.text, "completed output text", value);
        this.textEmitted.add(key);
        return text.length === 0 ? [] : [{ type: "text_delta", text }];
      }
      case "response.refusal.delta": {
        this.refusal = true;
        const delta = requiredString(value.delta, "refusal delta", value);
        this.textEmitted.add(contentKey(value));
        return delta.length === 0 ? [] : [{ type: "text_delta", text: delta }];
      }
      case "response.refusal.done": {
        this.refusal = true;
        const key = contentKey(value);
        if (this.textEmitted.has(key)) return [];
        const refusal = requiredString(value.refusal, "completed refusal", value);
        this.textEmitted.add(key);
        return refusal.length === 0 ? [] : [{ type: "text_delta", text: refusal }];
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const delta = requiredString(value.delta, "reasoning delta", value);
        return delta.length === 0 ? [] : [{ type: "thinking_delta", thinking: delta }];
      }
      case "response.output_item.added":
        return this.itemAdded(value);
      case "response.function_call_arguments.delta":
        return this.argumentsDelta(value);
      case "response.function_call_arguments.done":
        return this.argumentsDone(value);
      case "response.output_item.done":
        return this.itemDone(value);
      case "response.completed":
      case "response.incomplete":
      case "response.cancelled":
        return this.finish(value, type);
      case "response.failed": {
        this.captureResponseId(value.response);
        const response = isRecord(value.response) ? value.response : value;
        throw responseError({
          ...response,
          status: numberValue(value.status) ?? numberValue(response.status),
          error: response.error ?? value.error,
        });
      }
      case "error":
        throw responseError(value);
      default:
        return [];
    }
  }

  private itemAdded(event: Record<string, unknown>): ProviderEvent[] {
    const item = requiredRecord(event.item, "output item", event);
    if (item.type !== "function_call") return [];
    const call = this.captureCall(item, event);
    return this.startCall(call);
  }

  private argumentsDelta(event: Record<string, unknown>): ProviderEvent[] {
    const call = this.callForEvent(event);
    const events = this.startCall(call);
    const delta = requiredString(event.delta, "function-call argument delta", event);
    if (delta.length > 0) {
      this.callArguments.set(call.id, (this.callArguments.get(call.id) ?? "") + delta);
      events.push({ type: "tool_call_delta", id: call.id, argumentsDelta: delta });
    }
    return events;
  }

  private argumentsDone(event: Record<string, unknown>): ProviderEvent[] {
    const call = this.callForEvent(event);
    const events = this.startCall(call);
    const argumentsText = requiredString(event.arguments, "function-call arguments", event);
    this.ensureArguments(call.id, argumentsText, events);
    return events;
  }

  private itemDone(event: Record<string, unknown>): ProviderEvent[] {
    const item = requiredRecord(event.item, "completed output item", event);
    this.recordOutput(event, item);
    if (item.type === "reasoning") return this.emitReasoning(item, event);
    if (item.type !== "function_call") return [];

    const call = this.captureCall(item, event);
    const events = this.startCall(call);
    const argumentsText = requiredString(item.arguments, "function-call arguments", event);
    this.ensureArguments(call.id, argumentsText, events);
    if (!this.callsEnded.has(call.id)) {
      this.callsEnded.add(call.id);
      events.push({ type: "tool_call_end", id: call.id });
    }
    return events;
  }

  private finish(event: Record<string, unknown>, eventType: string): ProviderEvent[] {
    if (this.completed) return [];
    const response = requiredRecord(event.response, "terminal response", event);
    this.captureResponseId(response);
    const events: ProviderEvent[] = [];
    const output = arrayOfRecords(response.output);
    if (output !== undefined) {
      this.output = output;
      for (let index = 0; index < output.length; index += 1) {
        const item = output[index]!;
        const synthetic = { output_index: index, item };
        if (item.type === "reasoning") events.push(...this.emitReasoning(item, synthetic));
        else if (item.type === "function_call") events.push(...this.finishTerminalCall(item, synthetic));
        else if (item.type === "message") events.push(...this.emitTerminalMessage(item));
      }
    }

    const usage = decodeUsage(response.usage);
    if (usage !== undefined) events.push({ type: "usage", usage });
    this.completed = true;
    events.push({
      type: "complete",
      stopReason: terminalStopReason(response, eventType, this.sawToolCall, this.refusal),
      ...(this.responseId === undefined ? {} : { responseId: this.responseId }),
    });
    return events;
  }

  private finishTerminalCall(
    item: Record<string, unknown>,
    event: Record<string, unknown>,
  ): ProviderEvent[] {
    const call = this.captureCall(item, event);
    const events = this.startCall(call);
    const argumentsText = requiredString(item.arguments, "function-call arguments", item);
    this.ensureArguments(call.id, argumentsText, events);
    if (!this.callsEnded.has(call.id)) {
      this.callsEnded.add(call.id);
      events.push({ type: "tool_call_end", id: call.id });
    }
    return events;
  }
  private ensureArguments(
    callId: string,
    completedArguments: string,
    events: ProviderEvent[],
  ): void {
    const accumulated = this.callArguments.get(callId) ?? "";
    const completed = completedArguments.trim().length > 0 ? completedArguments : "{}";
    let delta: string;
    if (completed.startsWith(accumulated)) delta = completed.slice(accumulated.length);
    else if (accumulated.trim().length === 0) delta = completed;
    else {
      throw malformedResponse("Streamed function-call arguments differ from the completed item", {
        call_id: callId,
        accumulated,
        completed,
      });
    }
    if (delta.length === 0) return;
    this.callArguments.set(callId, accumulated + delta);
    events.push({ type: "tool_call_delta", id: callId, argumentsDelta: delta });
  }

  private emitTerminalMessage(item: Record<string, unknown>): ProviderEvent[] {
    const content = arrayOfRecords(item.content);
    if (content === undefined) return [];
    const itemId = stringValue(item.id) ?? "terminal";
    const events: ProviderEvent[] = [];
    for (let index = 0; index < content.length; index += 1) {
      const part = content[index]!;
      const key = `${itemId}:${index}`;
      if (this.textEmitted.has(key)) continue;
      if (part.type === "output_text") {
        const text = stringValue(part.text);
        if (text !== undefined) {
          this.textEmitted.add(key);
          events.push({ type: "text_delta", text });
        }
      } else if (part.type === "refusal") {
        this.refusal = true;
        const refusal = stringValue(part.refusal);
        if (refusal !== undefined) {
          this.textEmitted.add(key);
          events.push({ type: "text_delta", text: refusal });
        }
      }
    }
    return events;
  }

  private emitReasoning(
    item: Record<string, unknown>,
    event: Record<string, unknown>,
  ): ProviderEvent[] {
    const key = stringValue(item.id) ?? `output:${numberValue(event.output_index) ?? this.output.length}`;
    if (this.reasoningEmitted.has(key)) return [];
    this.reasoningEmitted.add(key);
    return [{ type: "reasoning_item", item }];
  }

  private captureCall(
    item: Record<string, unknown>,
    event: Record<string, unknown>,
  ): { id: string; name: string } {
    const id = requiredString(item.call_id, "function-call call_id", item);
    const name = requiredString(item.name, "function-call name", item);
    const itemId = stringValue(item.id) ?? stringValue(event.item_id);
    if (itemId !== undefined) this.callsByItem.set(itemId, { id, name });
    this.sawToolCall = true;
    return { id, name };
  }

  private callForEvent(event: Record<string, unknown>): { id: string; name: string } {
    const itemId = requiredString(event.item_id, "function-call item_id", event);
    const call = this.callsByItem.get(itemId);
    if (call === undefined) {
      throw malformedResponse(`Function-call arguments arrived before item ${itemId}`, event);
    }
    return call;
  }

  private startCall(call: { id: string; name: string }): ProviderEvent[] {
    this.sawToolCall = true;
    if (this.callsStarted.has(call.id)) return [];
    this.callsStarted.add(call.id);
    return [{ type: "tool_call_start", id: call.id, name: call.name }];
  }

  private recordOutput(event: Record<string, unknown>, item: ResponseItem): void {
    const index = numberValue(event.output_index);
    if (index === undefined || index < 0 || !Number.isInteger(index)) {
      this.output.push(item);
      return;
    }
    this.output[index] = item;
  }

  private captureResponseId(value: unknown): void {
    if (!isRecord(value)) return;
    const id = stringValue(value.id);
    if (id !== undefined) this.responseId = id;
  }
}

function serializeMessage(message: CanonicalMessage, destination: ResponseItem[]): void {
  let content: Record<string, unknown>[] = [];
  const flush = (): void => {
    if (content.length === 0) return;
    destination.push({
      type: "message",
      role: message.role,
      content,
      ...(message.role === "assistant" ? { id: message.id, status: "completed" } : {}),
    });
    content = [];
  };

  for (const block of message.content) {
    if (block.type === "reasoning") {
      flush();
      if (block.raw.type !== "reasoning") {
        throw malformedResponse("An OpenAI reasoning block does not contain a reasoning item", block.raw);
      }
      destination.push(block.raw);
    } else if (block.type === "tool_use") {
      flush();
      destination.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: stringifyJson(block.input, "tool-call input"),
        status: "completed",
      });
    } else if (block.type === "tool_result") {
      flush();
      destination.push({
        type: "function_call_output",
        call_id: block.toolUseId,
        output: serializeToolOutput(block.content),
      });
    } else {
      const part = serializeMessagePart(block, message.role);
      if (part !== undefined) content.push(part);
    }
  }
  flush();
}

function serializeMessagePart(
  block: Exclude<ContentBlock, { type: "reasoning" | "tool_use" | "tool_result" }>,
  role: CanonicalMessage["role"],
): Record<string, unknown> | undefined {
  switch (block.type) {
    case "text":
      return { type: role === "assistant" ? "output_text" : "input_text", text: block.text };
    case "image":
      return {
        type: "input_image",
        detail: "auto",
        image_url: `data:${block.mediaType};base64,${block.data}`,
      };
    case "marker":
      return {
        type: role === "assistant" ? "output_text" : "input_text",
        text: `[${block.reason}: ${block.detail}]`,
      };
    case "thinking":
      return undefined;
  }
}

function serializeToolOutput(content: string | ContentBlock[]): string | Record<string, unknown>[] {
  if (typeof content === "string") return content;
  const output: Record<string, unknown>[] = [];
  for (const block of content) {
    if (block.type === "text") output.push({ type: "input_text", text: block.text });
    else if (block.type === "image") {
      output.push({
        type: "input_image",
        detail: "auto",
        image_url: `data:${block.mediaType};base64,${block.data}`,
      });
    } else if (block.type === "marker") {
      output.push({ type: "input_text", text: `[${block.reason}: ${block.detail}]` });
    }
  }
  return output;
}

function itemFingerprint(item: ResponseItem): string {
  let comparable: unknown = item;
  if (item.type === "message") {
    comparable = {
      type: "message",
      role: item.role,
      content: Array.isArray(item.content)
        ? item.content.map((part) => {
            if (!isRecord(part)) return part;
            if (part.type === "output_text" || part.type === "input_text") {
              return { type: part.type, text: part.text };
            }
            if (part.type === "refusal") return { type: "refusal", refusal: part.refusal };
            if (part.type === "input_image") {
              return { type: "input_image", image_url: part.image_url, detail: part.detail };
            }
            return part;
          })
        : item.content,
    };
  } else if (item.type === "function_call") {
    comparable = {
      type: "function_call",
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
    };
  } else if (item.type === "function_call_output") {
    comparable = {
      type: "function_call_output",
      call_id: item.call_id,
      output: item.output,
    };
  }
  return stableJson(comparable);
}

function terminalStopReason(
  response: Record<string, unknown>,
  eventType: string,
  sawToolCall: boolean,
  refusal: boolean,
): StopReason {
  if (eventType === "response.cancelled" || response.status === "cancelled") return "cancelled";
  const details = isRecord(response.incomplete_details) ? response.incomplete_details : undefined;
  const reason = details === undefined ? undefined : stringValue(details.reason);
  const incomplete = eventType === "response.incomplete" || response.status === "incomplete";
  if (incomplete && reason === undefined) {
    throw malformedResponse("An incomplete response did not include an incomplete reason", response);
  }
  if (reason === "max_output_tokens") return "max_tokens";
  if (reason === "content_filter" || refusal) return "refusal";
  if (incomplete) {
    throw malformedResponse(`Unsupported incomplete response reason ${reason}`, response);
  }
  if (sawToolCall) return "tool_use";
  return "end_turn";
}

function decodeUsage(value: unknown): ProviderUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = numberValue(value.input_tokens);
  const outputTokens = numberValue(value.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const details = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined;
  const cacheReadTokens = details === undefined ? undefined : numberValue(details.cached_tokens);
  const cacheWriteTokens = details === undefined ? undefined : numberValue(details.cache_write_tokens);
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

function contentKey(event: Record<string, unknown>): string {
  return `${stringValue(event.item_id) ?? "unknown"}:${numberValue(event.content_index) ?? 0}`;
}

function malformedResponse(message: string, raw: unknown): ProviderFault {
  return classifyProviderError({
    code: "malformed_completion",
    message,
    body: raw,
  });
}

function stringifyJson(value: unknown, label: string): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError(`${label} is not JSON-serializable`);
    return encoded;
  } catch (cause) {
    throw classifyProviderError({
      code: "invalid_tool_result",
      message: `${label} is not JSON-serializable`,
      cause,
    });
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortJson(value[key]);
  return sorted;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value) || !value.every(isRecord)) return undefined;
  return value;
}

function requiredRecord(
  value: unknown,
  label: string,
  raw: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) throw malformedResponse(`The provider returned an invalid ${label}`, raw);
  return value;
}

function requiredString(value: unknown, label: string, raw: unknown): string {
  if (typeof value !== "string") {
    throw malformedResponse(`The provider returned an invalid ${label}`, raw);
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isResponseRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
