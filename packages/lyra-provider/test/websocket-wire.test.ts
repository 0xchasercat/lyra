import { describe, expect, test } from "bun:test";
import { NoAuth } from "../src/auth.ts";
import { ProviderFault } from "../src/errors.ts";
import { OpenAIWebSocketTransport } from "../src/transports/openai-websocket.ts";
import type { TransportContext, TransportEvent } from "../src/types.ts";
import { baseRequest } from "./fixture-adapter.ts";

interface SocketPlan {
  readonly frames: readonly Readonly<Record<string, unknown>>[];
  readonly closeAfter?: boolean;
}

const CONTEXT: TransportContext = {
  signal: new AbortController().signal,
  headersTimeoutMs: 2_000,
};

describe("recorded OpenAI Responses WebSocket conformance", () => {
  test("decodes reasoning and parallel calls across multiple turns", async () => {
    const fixture = socketFixture([
      { frames: richFrames() },
      { frames: successFrames("ws-second") },
    ]);
    const transport = createTransport(fixture);
    try {
      const first = await collectOutcome(transport.stream(baseRequest(), CONTEXT));
      expect(first.error).toBeUndefined();
      expectTerminal(first.events, "tool_use");
      expect(first.events.filter((event) => event.type === "tool_call_start")).toEqual([
        { type: "tool_call_start", id: "call-a", name: "weather" },
        { type: "tool_call_start", id: "call-b", name: "weather" },
      ]);
      expect(first.events).toContainEqual({ type: "thinking_delta", thinking: "compare both cities" });
      expect(first.events).toContainEqual(expect.objectContaining({ type: "reasoning_item" }));

      const second = await collectOutcome(transport.stream(baseRequest({
        messages: [
          ...baseRequest().messages,
          {
            id: "assistant-tools",
            role: "assistant",
            content: [
              { type: "tool_use", id: "call-a", name: "weather", input: { city: "Oslo" } },
              { type: "tool_use", id: "call-b", name: "weather", input: { city: "Rome" } },
              {
                type: "reasoning",
                provider: "openai",
                raw: { type: "reasoning", id: "reasoning-1", summary: [{ text: "compare both cities" }] },
              },
            ],
          },
          {
            id: "user-results",
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "call-a", content: "Oslo: 8 C" },
              { type: "tool_result", toolUseId: "call-b", content: "Rome: 22 C" },
            ],
          },
        ],
      }), CONTEXT));
      expect(second.error).toBeUndefined();
      expectTerminal(second.events, "end_turn");
      expect(fixture.requests).toHaveLength(2);
      expect(JSON.stringify(fixture.requests[1])).toContain("call-a");
      expect(JSON.stringify(fixture.requests[1])).toContain("call-b");
    } finally {
      await transport.close();
    }
  });

  test("preserves structured socket errors and remains reusable", async () => {
    const fixture = socketFixture([
      {
        frames: [{
          type: "error",
          status: 429,
          error: { code: "rate_limit_exceeded", message: "exact websocket rate limit" },
        }],
      },
      { frames: successFrames("ws-error-resume") },
    ]);
    const transport = createTransport(fixture);
    try {
      const failed = await collectOutcome(transport.stream(baseRequest(), CONTEXT));
      expect(failed.error).toBeInstanceOf(ProviderFault);
      expect(failed.error).toEqual(expect.objectContaining({
        classification: "transient",
        providerMessage: "exact websocket rate limit",
      }));
      const resumed = await collectOutcome(transport.stream(baseRequest(), CONTEXT));
      expect(resumed.error).toBeUndefined();
      expectTerminal(resumed.events, "end_turn");
    } finally {
      await transport.close();
    }
  });

  test("classifies a mid-stream close and starts the next turn on a clean socket", async () => {
    const fixture = socketFixture([
      {
        frames: [
          { type: "response.created", response: { id: "ws-truncated" } },
          { type: "response.output_text.delta", item_id: "message-truncated", content_index: 0, delta: "partial" },
        ],
        closeAfter: true,
      },
      { frames: successFrames("ws-truncation-resume") },
    ]);
    const transport = createTransport(fixture);
    try {
      const truncated = await collectOutcome(transport.stream(baseRequest(), CONTEXT));
      expect(truncated.events).toEqual([{ type: "text_delta", text: "partial" }]);
      expect(truncated.error).toBeInstanceOf(ProviderFault);
      expect(truncated.error).toEqual(expect.objectContaining({ classification: "transient" }));
      const resumed = await collectOutcome(transport.stream(baseRequest(), CONTEXT));
      expect(resumed.error).toBeUndefined();
      expectTerminal(resumed.events, "end_turn");
      expect(fixture.sockets).toHaveLength(2);
    } finally {
      await transport.close();
    }
  });
});

interface SocketFixture {
  readonly requests: unknown[];
  readonly sockets: FixtureSocket[];
  readonly factory: (url: string, options: { headers: Record<string, string> }) => WebSocket;
}

function createTransport(fixture: SocketFixture): OpenAIWebSocketTransport {
  return new OpenAIWebSocketTransport({
    id: "wire-websocket",
    baseUrl: "http://fixture.invalid/v1",
    auth: new NoAuth(),
    maxReplayAttempts: 0,
    maxConnectionFailures: 2,
    websocketFactory: fixture.factory,
  });
}

function socketFixture(plans: readonly SocketPlan[]): SocketFixture {
  const remaining = [...plans];
  const requests: unknown[] = [];
  const sockets: FixtureSocket[] = [];
  return {
    requests,
    sockets,
    factory: (_url, _options) => {
      const socket = new FixtureSocket(remaining, requests);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  };
}

class FixtureSocket extends EventTarget {
  readyState = WebSocket.CONNECTING;

  constructor(
    private readonly plans: SocketPlan[],
    private readonly requests: unknown[],
  ) {
    super();
    queueMicrotask(() => {
      if (this.readyState !== WebSocket.CONNECTING) return;
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const text = typeof data === "string" ? data : String(data);
    this.requests.push(JSON.parse(text) as unknown);
    const plan = this.plans.shift();
    if (plan === undefined) throw new Error("WebSocket fixture exhausted");
    for (const frame of plan.frames) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
    }
    if (plan.closeAfter === true) this.forceClose(1006, "fixture connection dropped");
  }

  close(): void {
    this.forceClose(1000, "fixture closed");
  }

  private forceClose(code: number, reason: string): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    const event = new Event("close") as CloseEvent;
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
      wasClean: { value: code === 1000 },
    });
    this.dispatchEvent(event);
  }
}

function richFrames(): readonly Readonly<Record<string, unknown>>[] {
  const callA = { id: "item-a", type: "function_call", call_id: "call-a", name: "weather", arguments: "{\"city\":\"Oslo\"}" };
  const callB = { id: "item-b", type: "function_call", call_id: "call-b", name: "weather", arguments: "{\"city\":\"Rome\"}" };
  const reasoning = { type: "reasoning", id: "reasoning-1", summary: [{ text: "compare both cities" }], encrypted_content: "opaque" };
  return [
    { type: "response.created", response: { id: "ws-rich" } },
    { type: "response.reasoning_summary_text.delta", delta: "compare both cities" },
    { type: "response.output_item.added", output_index: 0, item: { ...callA, arguments: "" } },
    { type: "response.output_item.added", output_index: 1, item: { ...callB, arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "item-a", delta: "{\"city\":\"Oslo\"}" },
    { type: "response.function_call_arguments.delta", item_id: "item-b", delta: "{\"city\":\"Rome\"}" },
    { type: "response.output_item.done", output_index: 0, item: callA },
    { type: "response.output_item.done", output_index: 1, item: callB },
    { type: "response.output_item.done", output_index: 2, item: reasoning },
    {
      type: "response.completed",
      response: {
        id: "ws-rich",
        status: "completed",
        output: [callA, callB, reasoning],
        usage: { input_tokens: 12, output_tokens: 9 },
      },
    },
  ];
}

function successFrames(responseId: string): readonly Readonly<Record<string, unknown>>[] {
  return [
    { type: "response.created", response: { id: responseId } },
    { type: "response.output_text.delta", item_id: "message-success", content_index: 0, delta: "done" },
    {
      type: "response.completed",
      response: { id: responseId, status: "completed", output: [], usage: { input_tokens: 4, output_tokens: 1 } },
    },
  ];
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
