import { describe, expect, test } from "bun:test";
import { NoAuth } from "../src/auth.ts";
import { OpenAIWebSocketTransport } from "../src/transports/openai-websocket.ts";
import type { TransportContext, TransportEvent } from "../src/types.ts";
import { baseRequest } from "./fixture-adapter.ts";

const CONTEXT: TransportContext = {
  signal: new AbortController().signal,
  headersTimeoutMs: 2_000,
};

/** A provider that answers `/responses` over HTTP and never offers a socket — the common case. */
function startHttpOnlyProvider(): { baseUrl: string; stop(): Promise<void> } {
  let responses = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      responses += 1;
      const id = `resp_${responses}`;
      const frames = [
        { type: "response.created", response: { id } },
        { type: "response.output_text.delta", item_id: `msg_${responses}`, output_index: 0, content_index: 0, delta: "over http" },
        {
          type: "response.completed",
          response: {
            id,
            status: "completed",
            output: [{ type: "message", role: "assistant", id: `msg_${responses}`, status: "completed", content: [{ type: "output_text", text: "over http" }] }],
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        },
      ];
      return new Response(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    async stop() {
      await server.stop(true);
    },
  };
}

class RefusedSocket extends EventTarget {
  readyState = WebSocket.CONNECTING;

  constructor() {
    super();
    queueMicrotask(() => {
      if (this.readyState !== WebSocket.CONNECTING) return;
      this.dispatchEvent(new Event("error"));
    });
  }

  send(): void {
    throw new Error("This socket never opened");
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

async function collect(source: AsyncIterable<TransportEvent>): Promise<TransportEvent[]> {
  const events: TransportEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

/** Runs `turns` turns against a provider with no socket, and reports what the client saw. */
async function fallbackTurns(
  websocket: "auto" | "on" | undefined,
  turns: number,
): Promise<{ events: TransportEvent[][]; attempts: number }> {
  const provider = startHttpOnlyProvider();
  let attempts = 0;
  const transport = new OpenAIWebSocketTransport({
    id: "fallback",
    baseUrl: provider.baseUrl,
    auth: new NoAuth(),
    ...(websocket === undefined ? {} : { websocket }),
    websocketFactory: () => {
      attempts += 1;
      return new RefusedSocket() as unknown as WebSocket;
    },
  });
  try {
    const events: TransportEvent[][] = [];
    for (let turn = 0; turn < turns; turn += 1) {
      events.push(await collect(transport.stream(baseRequest(), CONTEXT)));
    }
    return { events, attempts };
  } finally {
    await transport.close();
  }
}

describe("falling back from the Responses WebSocket", () => {
  test("marks the fallback expected when websocket is auto — the socket was a probe, not a promise", async () => {
    const { events, attempts } = await fallbackTurns("auto", 3);
    const notices = events.flat().filter((event) => event.type === "transport_fallback");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual(expect.objectContaining({ expected: true }));
    for (const turn of events) {
      expect(turn).toContainEqual({ type: "text_delta", text: "over http" });
    }
    // The verdict is a session fact: the socket is tried until it has failed enough, never again.
    expect(attempts).toBe(2);
  });

  test("defaults to expected when no websocket preference was configured", async () => {
    const { events } = await fallbackTurns(undefined, 2);
    const notices = events.flat().filter((event) => event.type === "transport_fallback");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual(expect.objectContaining({ expected: true }));
  });

  test("announces once when websocket is explicitly on and the socket is not there", async () => {
    const { events, attempts } = await fallbackTurns("on", 3);
    const notices = events.flat().filter((event) => event.type === "transport_fallback");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual(expect.objectContaining({
      type: "transport_fallback",
      from: "openai_websocket",
      to: "openai_responses",
      expected: false,
    }));
    // On the first turn, and never repeated afterwards.
    expect(events[0]?.some((event) => event.type === "transport_fallback")).toBe(true);
    expect(events[1]?.some((event) => event.type === "transport_fallback")).toBe(false);
    expect(attempts).toBe(2);
  });
});
