import { describe, expect, test } from "bun:test";
import { NoAuth } from "../src/auth.ts";
import { ReliableProvider } from "../src/client.ts";
import { OpenAICompletionsTransport } from "../src/transports/openai-completions.ts";
import type {
  ProviderRequest,
  ProviderTransport,
  ReliableProviderEvent,
  RetryEvent,
  TransportEvent,
} from "../src/types.ts";

/**
 * The §3.3 watchdog's two phases, and the byte-level liveness that feeds the second one.
 *
 * The bug these cover was live and repeatable: a reasoning model that thinks past the
 * 45s inter-token budget before its first token looked identical to a dead stream, so the
 * watchdog cancelled the request, resent the whole context at full input cost, and the model
 * started thinking again — sometimes on every attempt until the retry budget ran out.
 */

const STALL_MS = 40;

function request(): ProviderRequest {
  return {
    model: "test-model",
    system: "Be brief.",
    messages: [{ id: "user-1", role: "user", content: [{ type: "text", text: "think hard" }] }],
    tools: [],
  };
}

function scripted(script: (emit: Emit) => Promise<void>): ProviderTransport {
  return {
    apiType: "openai_completions",
    id: "scripted",
    async *stream(_request, context) {
      const queue: TransportEvent[] = [];
      let pending: (() => void) | undefined;
      let finished = false;
      const emit: Emit = {
        event(event) {
          queue.push(event);
          pending?.();
        },
        async idle(ms) {
          await Bun.sleep(ms);
        },
      };
      const run = script(emit).finally(() => {
        finished = true;
        pending?.();
      });
      while (true) {
        if (context.signal.aborted) throw context.signal.reason;
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (finished) break;
        await Promise.race([
          new Promise<void>((resolve) => { pending = resolve; }),
          new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
      }
      await run;
    },
  };
}

interface Emit {
  event(event: TransportEvent): void;
  idle(ms: number): Promise<void>;
}

async function settle(source: AsyncIterable<ReliableProviderEvent>): Promise<ReliableProviderEvent[]> {
  const events: ReliableProviderEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function retries(events: readonly ReliableProviderEvent[]): RetryEvent[] {
  return events.filter((event): event is RetryEvent => event.type === "retry");
}

describe("the stall watchdog's phases", () => {
  test("a request that is accepted and stays silent well past the inter-token budget still succeeds", async () => {
    const transport = scripted(async (emit) => {
      // Three times the budget with nothing on the wire: a hard problem being thought about
      // behind a proxy that does not stream reasoning.
      await emit.idle(STALL_MS * 3);
      emit.event({ type: "text_delta", text: "the answer" });
      emit.event({ type: "complete", stopReason: "end_turn" });
    });
    const provider = new ReliableProvider(transport, {
      streamStallTimeoutMs: STALL_MS,
      sleep: async () => {},
    });
    const events = await settle(provider.stream(request()));
    expect(retries(events)).toHaveLength(0);
    expect(events.at(-1)).toEqual({ type: "complete", stopReason: "end_turn" });
  });

  test("thinking deltas keep a long reasoning stream alive", async () => {
    const transport = scripted(async (emit) => {
      for (let index = 0; index < 6; index += 1) {
        await emit.idle(STALL_MS / 2);
        emit.event({ type: "thinking_delta", thinking: `step ${index} ` });
      }
      emit.event({ type: "text_delta", text: "done" });
      emit.event({ type: "complete", stopReason: "end_turn" });
    });
    const provider = new ReliableProvider(transport, {
      streamStallTimeoutMs: STALL_MS,
      sleep: async () => {},
    });
    const events = await settle(provider.stream(request()));
    expect(retries(events)).toHaveLength(0);
    expect(events.filter((event) => event.type === "thinking_delta")).toHaveLength(6);
  });

  test("silence after output began retries, and the reason names the phase", async () => {
    let attempts = 0;
    const transport = scripted(async (emit) => {
      attempts += 1;
      if (attempts === 1) {
        emit.event({ type: "text_delta", text: "half a sen" });
        await emit.idle(STALL_MS * 20);
        return;
      }
      emit.event({ type: "text_delta", text: "a whole sentence" });
      emit.event({ type: "complete", stopReason: "end_turn" });
    });
    const provider = new ReliableProvider(transport, {
      streamStallTimeoutMs: STALL_MS,
      sleep: async () => {},
    });
    const events = await settle(provider.stream(request()));
    expect(retries(events)).toEqual([
      expect.objectContaining({
        attempt: 2,
        classification: "transient",
        providerMessage: `Provider stream went silent for ${STALL_MS}ms after output began`,
        reason: `transient: Provider stream went silent for ${STALL_MS}ms after output began`,
        resetsPartialOutput: true,
      }),
    ]);
    expect(events.at(-1)).toEqual({ type: "complete", stopReason: "end_turn" });
  });
});

interface KeepAliveFixture {
  readonly baseUrl: string;
  readonly requests: number[];
  stop(): Promise<void>;
}

/**
 * A proxy that streams one token, then holds the connection with SSE comments while the
 * model thinks, then finishes. `keepAlive: false` is the same timeline with nothing on the
 * wire — the control that proves the comments are what saved the turn.
 */
function startThinkingProxy(options: { keepAlive: boolean }): KeepAliveFixture {
  const requests: number[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.json();
      const attempt = requests.push(0);
      const encoder = new TextEncoder();
      if (attempt > 1) {
        return sse(encoder, [chunk({ content: "recovered" }), chunk({}, "stop"), "[DONE]"], 0, false);
      }
      return sse(
        encoder,
        [chunk({ role: "assistant", content: "first " }), chunk({ content: "token" }), chunk({}, "stop"), "[DONE]"],
        STALL_MS * 4,
        options.keepAlive,
      );
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    async stop() { await server.stop(true); },
  };
}

function sse(
  encoder: TextEncoder,
  frames: readonly unknown[],
  pauseMs: number,
  keepAlive: boolean,
): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [index, frame] of frames.entries()) {
        const payload = typeof frame === "string" ? frame : JSON.stringify(frame);
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        // The pause lands after the first token, so the inter-token phase is armed for it.
        if (index === 0 && pauseMs > 0) {
          const ticks = keepAlive ? Math.ceil(pauseMs / (STALL_MS / 2)) : 1;
          for (let tick = 0; tick < ticks; tick += 1) {
            await Bun.sleep(pauseMs / ticks);
            if (keepAlive) controller.enqueue(encoder.encode(": ping\n\n"));
          }
        }
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunk(delta: Record<string, unknown>, finishReason?: string): Record<string, unknown> {
  return {
    id: "chatcmpl-1",
    choices: [{
      index: 0,
      delta,
      ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
    }],
  };
}

describe("bytes are liveness", () => {
  test("SSE comments during a long pause keep the inter-token deadline alive", async () => {
    const proxy = startThinkingProxy({ keepAlive: true });
    const transport = new OpenAICompletionsTransport({ id: "keepalive", baseUrl: proxy.baseUrl, auth: new NoAuth() });
    try {
      const provider = new ReliableProvider(transport, { streamStallTimeoutMs: STALL_MS, sleep: async () => {} });
      const events = await settle(provider.stream(request()));
      expect(retries(events)).toHaveLength(0);
      expect(proxy.requests).toHaveLength(1);
      const text = events.filter((event) => event.type === "text_delta").map((event) => event.text).join("");
      expect(text).toBe("first token");
    } finally {
      await proxy.stop();
    }
  });

  test("the same pause with nothing on the wire is a stall, and retries", async () => {
    const proxy = startThinkingProxy({ keepAlive: false });
    const transport = new OpenAICompletionsTransport({ id: "silent", baseUrl: proxy.baseUrl, auth: new NoAuth() });
    try {
      const provider = new ReliableProvider(transport, { streamStallTimeoutMs: STALL_MS, sleep: async () => {} });
      const events = await settle(provider.stream(request()));
      expect(retries(events)).toEqual([
        expect.objectContaining({
          classification: "transient",
          providerMessage: `Provider stream went silent for ${STALL_MS}ms after output began`,
          resetsPartialOutput: true,
        }),
      ]);
      expect(proxy.requests).toHaveLength(2);
    } finally {
      await proxy.stop();
    }
  });
});
