import { describe, expect, test } from "bun:test";
import { NoAuth } from "../src/auth.ts";
import { ProviderFault } from "../src/errors.ts";
import { AnthropicMessagesTransport } from "../src/transports/anthropic-messages.ts";
import { OpenAICompletionsTransport } from "../src/transports/openai-completions.ts";
import { OpenAIResponsesTransport } from "../src/transports/openai-responses.ts";
import type {
  CanonicalMessage,
  TransportEvent,
  ProviderRequest,
  ProviderTransport,
  TransportContext,
} from "../src/types.ts";
import { baseRequest } from "./fixture-adapter.ts";

type HttpKind = "openai_completions" | "openai_responses" | "anthropic_messages";
type RecordedHttpResponse =
  | { status: number; body: unknown; headers?: Readonly<Record<string, string>> }
  | { status?: 200; frames: readonly RecordedSseFrame[] };
type RecordedSseFrame =
  | { data: unknown; event?: string }
  | { rawData: string; event?: string };

interface HttpWireAdapter {
  readonly kind: HttpKind;
  create(baseUrl: string): ProviderTransport;
  richFrames(): readonly RecordedSseFrame[];
  successFrames(responseId: string): readonly RecordedSseFrame[];
  truncatedFrames(): readonly RecordedSseFrame[];
  errorBody(message: string): unknown;
  expectsReasoningItem: boolean;
  expectsThinkingSignature: boolean;
}

const CONTEXT: TransportContext = {
  signal: new AbortController().signal,
  headersTimeoutMs: 2_000,
};

const HTTP_ADAPTERS: readonly HttpWireAdapter[] = [
  {
    kind: "openai_completions",
    create: (baseUrl) => new OpenAICompletionsTransport({ id: "wire-completions", baseUrl, auth: new NoAuth() }),
    richFrames: completionsRichFrames,
    successFrames: completionsSuccessFrames,
    truncatedFrames: () => [completionChunk({ content: "partial" })],
    errorBody: (message) => ({ error: { type: "invalid_request_error", message } }),
    expectsReasoningItem: false,
    expectsThinkingSignature: false,
  },
  {
    kind: "openai_responses",
    create: (baseUrl) => new OpenAIResponsesTransport({ id: "wire-responses", baseUrl, auth: new NoAuth() }),
    richFrames: responsesRichFrames,
    successFrames: responsesSuccessFrames,
    truncatedFrames: () => [
      responseFrame({ type: "response.created", response: { id: "truncated-response" } }),
      responseFrame({ type: "response.output_text.delta", item_id: "message-1", content_index: 0, delta: "partial" }),
    ],
    errorBody: (message) => ({ error: { code: "invalid_request_error", message } }),
    expectsReasoningItem: true,
    expectsThinkingSignature: false,
  },
  {
    kind: "anthropic_messages",
    create: (baseUrl) => new AnthropicMessagesTransport({
      id: "wire-anthropic",
      baseUrl,
      auth: new NoAuth(),
      cacheBreakpoints: { system: false },
    }),
    richFrames: anthropicRichFrames,
    successFrames: anthropicSuccessFrames,
    truncatedFrames: () => [
      anthropicFrame({
        type: "message_start",
        message: { id: "truncated-message", usage: { input_tokens: 3, output_tokens: 0 } },
      }),
      anthropicFrame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }),
    ],
    errorBody: (message) => ({ type: "error", error: { type: "invalid_request_error", message } }),
    expectsReasoningItem: false,
    expectsThinkingSignature: true,
  },
];

describe("recorded HTTP transport wire conformance", () => {
  for (const adapter of HTTP_ADAPTERS) {
    describe(adapter.kind, () => {
      test("decodes thinking/reasoning and parallel tools, then accepts tool results", async () => {
        const fixture = startHttpFixture([
          { frames: adapter.richFrames() },
          { frames: adapter.successFrames(`${adapter.kind}-second`) },
        ]);
        const transport = adapter.create(fixture.baseUrl);
        try {
          const first = await collectOutcome(transport.stream(baseRequest(), CONTEXT));
          expect(first.error).toBeUndefined();
          expectTerminal(first.events, "tool_use");
          expect(first.events.filter((event) => event.type === "tool_call_start")).toEqual([
            { type: "tool_call_start", id: "call-a", name: "weather" },
            { type: "tool_call_start", id: "call-b", name: "weather" },
          ]);
          expect(first.events.some((event) => event.type === "thinking_delta")).toBe(true);
          expect(first.events.some((event) => event.type === "reasoning_item"))
            .toBe(adapter.expectsReasoningItem);
          expect(first.events.some((event) => event.type === "thinking_signature"))
            .toBe(adapter.expectsThinkingSignature);

          const second = await collectOutcome(transport.stream(
            toolResultRequest(adapter.kind === "openai_responses"),
            CONTEXT,
          ));
          expect(second.error).toBeUndefined();
          expectTerminal(second.events, "end_turn");
          expect(fixture.requests).toHaveLength(2);
          expect(JSON.stringify(fixture.requests[1]?.body)).toContain("call-a");
          expect(JSON.stringify(fixture.requests[1]?.body)).toContain("call-b");
        } finally {
          await transport.close?.();
          await fixture.stop();
        }
      });

      test("preserves a structured HTTP error and remains reusable", async () => {
        const message = `${adapter.kind} exact provider failure`;
        const fixture = startHttpFixture([
          { status: 400, body: adapter.errorBody(message) },
          { frames: adapter.successFrames(`${adapter.kind}-resumed-error`) },
        ]);
        const transport = adapter.create(fixture.baseUrl);
        try {
          const failed = await collectOutcome(transport.stream(baseRequest(), CONTEXT));
          expect(failed.error).toBeInstanceOf(ProviderFault);
          expect(failed.error).toEqual(expect.objectContaining({
            classification: "bad_request",
            providerMessage: message,
          }));
          const resumed = await collectOutcome(transport.stream(baseRequest(), CONTEXT));
          expect(resumed.error).toBeUndefined();
          expectTerminal(resumed.events, "end_turn");
        } finally {
          await transport.close?.();
          await fixture.stop();
        }
      });

      test("classifies a truncated wire stream and resumes cleanly", async () => {
        const fixture = startHttpFixture([
          { frames: adapter.truncatedFrames() },
          { frames: adapter.successFrames(`${adapter.kind}-resumed-truncation`) },
        ]);
        const transport = adapter.create(fixture.baseUrl);
        try {
          const truncated = await collectOutcome(transport.stream(baseRequest(), CONTEXT));
          expect(truncated.events).toContainEqual({ type: "text_delta", text: "partial" });
          expect(truncated.error).toBeInstanceOf(ProviderFault);
          expect(truncated.error).toEqual(expect.objectContaining({ classification: "content_shape" }));
          const resumed = await collectOutcome(transport.stream(baseRequest(), CONTEXT));
          expect(resumed.error).toBeUndefined();
          expectTerminal(resumed.events, "end_turn");
        } finally {
          await transport.close?.();
          await fixture.stop();
        }
      });
    });
  }
});

function toolResultRequest(includeReasoning: boolean): ProviderRequest {
  const assistantContent: CanonicalMessage["content"] = [
    { type: "thinking", thinking: "compare both", signature: "fixture-signature" },
    { type: "tool_use", id: "call-a", name: "weather", input: { city: "Oslo" } },
    { type: "tool_use", id: "call-b", name: "weather", input: { city: "Rome" } },
  ];
  if (includeReasoning) {
    assistantContent.push({
      type: "reasoning",
      provider: "openai",
      raw: { type: "reasoning", id: "reasoning-1", summary: [{ text: "compare both" }] },
    });
  }
  return baseRequest({
    messages: [
      ...baseRequest().messages,
      { id: "assistant-tools", role: "assistant", content: assistantContent },
      {
        id: "user-results",
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "call-a", content: "Oslo: 8 C" },
          { type: "tool_result", toolUseId: "call-b", content: "Rome: 22 C" },
        ],
      },
    ],
  });
}

function completionsRichFrames(): readonly RecordedSseFrame[] {
  return [
    {
      data: {
        id: "completion-rich",
        choices: [{
          index: 0,
          delta: {
            reasoning_content: "compare both cities",
            tool_calls: [
              { index: 0, id: "call-a", type: "function", function: { name: "weather", arguments: "{\"city\":" } },
              { index: 1, id: "call-b", type: "function", function: { name: "weather", arguments: "{\"city\":\"Rome\"}" } },
            ],
          },
          finish_reason: null,
        }],
      },
    },
    {
      data: {
        id: "completion-rich",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: "\"Oslo\"}" } }] },
          finish_reason: null,
        }],
      },
    },
    { data: { id: "completion-rich", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] } },
    { rawData: "[DONE]" },
  ];
}

function completionsSuccessFrames(responseId: string): readonly RecordedSseFrame[] {
  return [
    { data: { id: responseId, choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] } },
    { data: { id: responseId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } },
    { rawData: "[DONE]" },
  ];
}

function completionChunk(delta: Record<string, unknown>): RecordedSseFrame {
  return { data: { id: "completion-truncated", choices: [{ index: 0, delta, finish_reason: null }] } };
}

function responsesRichFrames(): readonly RecordedSseFrame[] {
  const callA = { id: "item-a", type: "function_call", call_id: "call-a", name: "weather", arguments: "{\"city\":\"Oslo\"}" };
  const callB = { id: "item-b", type: "function_call", call_id: "call-b", name: "weather", arguments: "{\"city\":\"Rome\"}" };
  const reasoning = { type: "reasoning", id: "reasoning-1", summary: [{ text: "compare both cities" }], encrypted_content: "opaque" };
  return [
    responseFrame({ type: "response.created", response: { id: "response-rich" } }),
    responseFrame({ type: "response.reasoning_summary_text.delta", delta: "compare both cities" }),
    responseFrame({ type: "response.output_item.added", output_index: 0, item: { ...callA, arguments: "" } }),
    responseFrame({ type: "response.output_item.added", output_index: 1, item: { ...callB, arguments: "" } }),
    responseFrame({ type: "response.function_call_arguments.delta", item_id: "item-a", delta: "{\"city\":\"Oslo\"}" }),
    responseFrame({ type: "response.function_call_arguments.delta", item_id: "item-b", delta: "{\"city\":\"Rome\"}" }),
    responseFrame({ type: "response.output_item.done", output_index: 0, item: callA }),
    responseFrame({ type: "response.output_item.done", output_index: 1, item: callB }),
    responseFrame({ type: "response.output_item.done", output_index: 2, item: reasoning }),
    responseFrame({
      type: "response.completed",
      response: {
        id: "response-rich",
        status: "completed",
        output: [callA, callB, reasoning],
        usage: { input_tokens: 12, output_tokens: 9 },
      },
    }),
  ];
}

function responsesSuccessFrames(responseId: string): readonly RecordedSseFrame[] {
  return [
    responseFrame({ type: "response.created", response: { id: responseId } }),
    responseFrame({ type: "response.output_text.delta", item_id: "message-success", content_index: 0, delta: "done" }),
    responseFrame({
      type: "response.completed",
      response: { id: responseId, status: "completed", output: [], usage: { input_tokens: 4, output_tokens: 1 } },
    }),
  ];
}

function responseFrame(data: Readonly<Record<string, unknown>>): RecordedSseFrame {
  return { event: String(data.type), data };
}

function anthropicRichFrames(): readonly RecordedSseFrame[] {
  return [
    anthropicFrame({ type: "message_start", message: { id: "anthropic-rich", usage: { input_tokens: 12, output_tokens: 0 } } }),
    anthropicFrame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "compare both cities" } }),
    anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture-signature" } }),
    anthropicFrame({ type: "content_block_stop", index: 0 }),
    anthropicFrame({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call-a", name: "weather", input: {} } }),
    anthropicFrame({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call-b", name: "weather", input: {} } }),
    anthropicFrame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"city\":\"Oslo\"}" } }),
    anthropicFrame({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"city\":\"Rome\"}" } }),
    anthropicFrame({ type: "content_block_stop", index: 2 }),
    anthropicFrame({ type: "content_block_stop", index: 1 }),
    anthropicFrame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
    anthropicFrame({ type: "message_stop" }),
  ];
}

function anthropicSuccessFrames(responseId: string): readonly RecordedSseFrame[] {
  return [
    anthropicFrame({ type: "message_start", message: { id: responseId, usage: { input_tokens: 4, output_tokens: 0 } } }),
    anthropicFrame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
    anthropicFrame({ type: "content_block_stop", index: 0 }),
    anthropicFrame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    anthropicFrame({ type: "message_stop" }),
  ];
}

function anthropicFrame(data: Readonly<Record<string, unknown>>): RecordedSseFrame {
  return { event: String(data.type), data };
}

interface HttpFixture {
  readonly baseUrl: string;
  readonly requests: Array<{ url: string; body: unknown }>;
  stop(): Promise<void>;
}

function startHttpFixture(plans: readonly RecordedHttpResponse[]): HttpFixture {
  const remaining = [...plans];
  const requests: Array<{ url: string; body: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        body = undefined;
      }
      requests.push({ url: request.url, body });
      const plan = remaining.shift();
      if (plan === undefined) return new Response("fixture exhausted", { status: 500 });
      if ("body" in plan) {
        return Response.json(plan.body, { status: plan.status, headers: plan.headers });
      }
      return new Response(encodeSse(plan.frames), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    async stop() {
      await server.stop(true);
    },
  };
}

function encodeSse(frames: readonly RecordedSseFrame[]): string {
  return frames.map((frame) => {
    const event = frame.event === undefined ? "" : `event: ${frame.event}\n`;
    const data = "rawData" in frame ? frame.rawData : JSON.stringify(frame.data);
    return `${event}data: ${data}\n\n`;
  }).join("");
}

async function collectOutcome(source: AsyncIterable<TransportEvent>): Promise<{
  events: TransportEvent[];
  error?: unknown;
}> {
  const events: TransportEvent[] = [];
  try {
    for await (const event of source) events.push(event);
    return { events };
  } catch (error) {
    return { events, error };
  }
}

function expectTerminal(events: readonly TransportEvent[], stopReason: string): void {
  expect(events.filter((event) => event.type === "complete")).toHaveLength(1);
  expect(events.at(-1)).toEqual(expect.objectContaining({ type: "complete", stopReason }));
}
