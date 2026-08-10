import { describe, expect, test } from "bun:test";
import { NoAuth } from "../src/auth.ts";
import { ReliableProvider } from "../src/client.ts";
import { OpenAIResponsesTransport } from "../src/transports/openai-responses.ts";
import type { CanonicalMessage, ProviderRequest, ReliableProviderEvent } from "../src/types.ts";

/**
 * A local proxy that speaks `/responses` badly.
 *
 * Every misbehaviour modelled here was observed in the wild from a CLIProxyAPI-style
 * translator: no response store (so the incremental chain never resolves), the request's
 * own `input` echoed back inside `response.output`, and the finished text repeated under an
 * item id that never appeared in the stream. Each one on its own is legal-looking; together
 * they made Lyra render a turn N+1 times on turn N.
 */
interface SloppyProxyOptions {
  /** `previous_response_id` is answered 404 `previous_response_not_found` (no store). */
  readonly chainStored?: boolean;
  /** `response.completed.output` repeats the request's `input` items before the new one. */
  readonly echoesInput?: boolean;
  /** The terminal message item carries an id the stream never used. */
  readonly freshTerminalId?: boolean;
  /** `response.output_text.done` carries a fresh id too, so id-keyed dedup misses it. */
  readonly freshDoneId?: boolean;
  /** Deltas re-send everything emitted so far instead of only the new characters. */
  readonly cumulativeDeltas?: boolean;
  /** Every turn answers with this exact text, so a genuine verbatim repeat is exercised. */
  readonly constantReply?: string;
  /**
   * The chain is refused *after* the proxy has already streamed some text — a 200 that turns
   * into `response.failed` halfway down, rather than a 404 before the first byte.
   */
  readonly chainRefusedMidStream?: boolean;
}

interface SloppyProxy {
  readonly baseUrl: string;
  readonly requests: Array<Record<string, unknown>>;
  stop(): Promise<void>;
}

function startSloppyProxy(options: SloppyProxyOptions = {}): SloppyProxy {
  const requests: Array<Record<string, unknown>> = [];
  let responses = 0;
  let items = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      if (options.chainStored !== true && typeof body.previous_response_id === "string") {
        if (options.chainRefusedMidStream !== true) {
          return Response.json(
            { error: { message: "Previous response not found", type: "invalid_request_error", code: "previous_response_not_found" } },
            { status: 404 },
          );
        }
        const failure = [
          { type: "response.created", response: { id: "resp_doomed" } },
          { type: "response.output_text.delta", item_id: "msg_doomed", output_index: 0, content_index: 0, delta: "half an ans" },
          { type: "response.failed", response: { id: "resp_doomed", status: "failed", error: { message: "Previous response not found", code: "previous_response_not_found" } } },
        ];
        return new Response(failure.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      responses += 1;
      const responseId = `resp_${responses}`;
      const input = Array.isArray(body.input) ? (body.input as Record<string, unknown>[]) : [];
      const reply = options.constantReply ?? `Reply to ${lastUserText(input)}`;
      const streamedId = `msg_${(items += 1)}`;
      const frames: string[] = [];
      const push = (value: unknown): void => {
        frames.push(`data: ${JSON.stringify(value)}\n\n`);
      };

      push({ type: "response.created", response: { id: responseId } });
      let sent = "";
      for (const chunk of splitChunks(reply)) {
        sent += chunk;
        push({
          type: "response.output_text.delta",
          item_id: streamedId,
          output_index: 0,
          content_index: 0,
          delta: options.cumulativeDeltas === true ? sent : chunk,
        });
      }
      push({
        type: "response.output_text.done",
        item_id: options.freshDoneId === true ? `msg_${(items += 1)}` : streamedId,
        output_index: 0,
        content_index: 0,
        text: reply,
      });
      const message = {
        type: "message",
        role: "assistant",
        status: "completed",
        id: options.freshTerminalId === false ? streamedId : `msg_${(items += 1)}`,
        content: [{ type: "output_text", text: reply }],
      };
      push({
        type: "response.completed",
        response: {
          id: responseId,
          status: "completed",
          output: options.echoesInput === true ? [...input, message] : [message],
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      });
      push("[DONE]");
      frames[frames.length - 1] = "data: [DONE]\n\n";
      return new Response(frames.join(""), {
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

function splitChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 5) chunks.push(text.slice(index, index + 5));
  return chunks;
}

function lastUserText(input: readonly Record<string, unknown>[]): string {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]!;
    if (item.type !== "message" || item.role !== "user") continue;
    const content = Array.isArray(item.content) ? (item.content as Record<string, unknown>[]) : [];
    const text = content.find((part) => part.type === "input_text")?.text;
    if (typeof text === "string") return text;
  }
  return "nothing";
}

function request(messages: readonly CanonicalMessage[]): ProviderRequest {
  return { model: "proxy-model", system: "Be brief.", messages, tools: [] };
}

/**
 * Drives `turns` prompts through the real transport and returns each turn's rendered text,
 * accumulating deltas the way a client does — including the reset a retry asks for.
 */
async function renderTurns(baseUrl: string, turns: number): Promise<string[]> {
  const transport = new OpenAIResponsesTransport({ id: "sloppy", baseUrl, auth: new NoAuth() });
  const provider = new ReliableProvider(transport, { maxAttempts: 2, sleep: async () => {} });
  const messages: CanonicalMessage[] = [];
  const rendered: string[] = [];
  try {
    for (let turn = 1; turn <= turns; turn += 1) {
      messages.push({ id: `user-${turn}`, role: "user", content: [{ type: "text", text: `question ${turn}` }] });
      let text = "";
      const events: ReliableProviderEvent[] = [];
      for await (const event of provider.stream(request(messages))) {
        events.push(event);
        if (event.type === "retry" && event.resetsPartialOutput) text = "";
        if (event.type === "text_delta") text += event.text;
      }
      rendered.push(text);
      messages.push({ id: `assistant-${turn}`, role: "assistant", content: [{ type: "text", text }] });
    }
  } finally {
    await transport.close?.();
  }
  return rendered;
}

describe("a proxy that speaks /responses badly", () => {
  test("renders each turn exactly once when the proxy echoes input and re-sends the final text", async () => {
    const proxy = startSloppyProxy({ echoesInput: true });
    try {
      const rendered = await renderTurns(proxy.baseUrl, 3);
      expect(rendered).toEqual([
        "Reply to question 1",
        "Reply to question 2",
        "Reply to question 3",
      ]);
    } finally {
      await proxy.stop();
    }
  });

  test("renders each turn exactly once when every text event carries a fresh item id", async () => {
    const proxy = startSloppyProxy({ echoesInput: true, freshDoneId: true });
    try {
      const rendered = await renderTurns(proxy.baseUrl, 3);
      expect(rendered).toEqual([
        "Reply to question 1",
        "Reply to question 2",
        "Reply to question 3",
      ]);
    } finally {
      await proxy.stop();
    }
  });

  test("still renders an answer that repeats an earlier turn word for word", async () => {
    const proxy = startSloppyProxy({ echoesInput: true, constantReply: "Hello! How can I help?" });
    try {
      const rendered = await renderTurns(proxy.baseUrl, 3);
      expect(rendered).toEqual([
        "Hello! How can I help?",
        "Hello! How can I help?",
        "Hello! How can I help?",
      ]);
    } finally {
      await proxy.stop();
    }
  });

  test("resends the whole conversation once the chain is refused, and only once", async () => {
    const proxy = startSloppyProxy({ echoesInput: true });
    try {
      await renderTurns(proxy.baseUrl, 2);
      // Turn 1 has no chain to try. Turn 2 tries the stored chain, is refused, and retries
      // once with the whole conversation — three requests, never a fourth.
      expect(proxy.requests).toHaveLength(3);
      expect(proxy.requests[0]?.previous_response_id).toBeNull();
      expect(typeof proxy.requests[1]?.previous_response_id).toBe("string");
      expect(proxy.requests[2]?.previous_response_id).toBeNull();
      expect((proxy.requests[2]?.input as unknown[]).length).toBe(3);
    } finally {
      await proxy.stop();
    }
  });

  test("a chain refused after text was already streamed retries visibly instead of replaying", async () => {
    const proxy = startSloppyProxy({ echoesInput: true, chainRefusedMidStream: true });
    try {
      const rendered = await renderTurns(proxy.baseUrl, 2);
      // The half-sentence the doomed attempt streamed is discarded by the retry, never
      // appended to and never left in front of the answer that replaced it.
      expect(rendered).toEqual(["Reply to question 1", "Reply to question 2"]);
    } finally {
      await proxy.stop();
    }
  });

  test("renders each turn exactly once when deltas are cumulative", async () => {
    const proxy = startSloppyProxy({ cumulativeDeltas: true });
    try {
      const rendered = await renderTurns(proxy.baseUrl, 2);
      expect(rendered).toEqual(["Reply to question 1", "Reply to question 2"]);
    } finally {
      await proxy.stop();
    }
  });
});
