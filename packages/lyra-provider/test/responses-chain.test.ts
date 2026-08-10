import { describe, expect, test } from "bun:test";
import { NoAuth } from "../src/auth.ts";
import { ResponsesChainState, type ResponseItem } from "../src/responses-codec.ts";
import { OpenAIResponsesTransport } from "../src/transports/openai-responses.ts";
import type { CanonicalMessage, ProviderRequest, TransportContext } from "../src/types.ts";

/**
 * The incremental chain and §3.6's tool-pairing invariant meet here.
 *
 * A derived window always pairs every tool result with its call. Slicing that window at the
 * chain cut can still put a lone `function_call_output` on the wire, because the cut falls
 * *after* the assistant's call and *before* the user's result — and an endpoint that does not
 * honour `previous_response_id` then forwards a tool result with nothing in front of it.
 * That is the exact 400 a local Responses→Anthropic proxy returned in a live session:
 * `messages.0.content.0: unexpected 'tool_use_id' found in 'tool_result' blocks`.
 */

const CONTEXT: TransportContext = { signal: new AbortController().signal, headersTimeoutMs: 5_000 };

function request(messages: readonly CanonicalMessage[]): ProviderRequest {
  return { model: "fixture-model", system: "Be brief.", messages, tools: [] };
}

const ASK: CanonicalMessage = { id: "u1", role: "user", content: [{ type: "text", text: "list the files" }] };
const CALL: CanonicalMessage = {
  id: "a1",
  role: "assistant",
  content: [{ type: "tool_use", id: "toolu_live", name: "bash", input: { command: "ls" } }],
};
const RESULT: CanonicalMessage = {
  id: "u2",
  role: "user",
  content: [{ type: "tool_result", toolUseId: "toolu_live", content: "exit_code: 0" }],
};

const CALL_ITEM: ResponseItem = {
  type: "function_call",
  call_id: "toolu_live",
  name: "bash",
  arguments: JSON.stringify({ command: "ls" }),
  status: "completed",
};

describe("the Responses chain never puts a tool result on the wire without its call", () => {
  test("a cut between an assistant tool call and its result resends the whole window", () => {
    const chain = new ResponsesChainState();
    const first = request([ASK]);
    const prepared = chain.prepare(first);
    chain.commit(first, prepared, "resp_1", [CALL_ITEM]);

    const next = chain.prepare(request([ASK, CALL, RESULT]));

    expect(next.incremental).toBe(false);
    expect(next.previousResponseId).toBeNull();
    expect(next.input.map((item) => item.type)).toEqual([
      "message",
      "function_call",
      "function_call_output",
    ]);
  });

  test("a clean cut still chains, so ordinary turns keep the incremental win", () => {
    const chain = new ResponsesChainState();
    const first = request([ASK]);
    const prepared = chain.prepare(first);
    chain.commit(first, prepared, "resp_1", [
      { type: "message", role: "assistant", id: "m1", status: "completed", content: [{ type: "output_text", text: "done" }] },
    ]);

    const next = chain.prepare(request([
      ASK,
      { id: "a1", role: "assistant", content: [{ type: "text", text: "done" }] },
      { id: "u2", role: "user", content: [{ type: "text", text: "thanks" }] },
    ]));

    expect(next.incremental).toBe(true);
    expect(next.previousResponseId).toBe("resp_1");
    expect(next.input).toHaveLength(1);
  });

  // The socket's cache is connection-local and dies with the connection (§5.3), so the tool
  // call the slice omits is state the same peer is holding. Losing this would cost the whole
  // point of WebSocket mode: every turn of a tool rollout would resend the conversation.
  test("a stateful chain keeps its one-item tool slice", () => {
    const chain = new ResponsesChainState({ stateful: true });
    const first = request([ASK]);
    const prepared = chain.prepare(first);
    chain.commit(first, prepared, "resp_1", [CALL_ITEM]);

    const next = chain.prepare(request([ASK, CALL, RESULT]));

    expect(next.incremental).toBe(true);
    expect(next.previousResponseId).toBe("resp_1");
    expect(next.input.map((item) => item.type)).toEqual(["function_call_output"]);
  });

  test("a proxy that silently ignores previous_response_id never receives a lone tool result", async () => {
    const bodies: Record<string, unknown>[] = [];
    let responses = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(incoming) {
        const body = (await incoming.json()) as Record<string, unknown>;
        bodies.push(body);
        // The misbehaviour observed in the wild: the id is accepted and then dropped, so
        // whatever `input` holds is the entire conversation the upstream model is shown.
        responses += 1;
        const id = `resp_${responses}`;
        const output = responses === 1
          ? [CALL_ITEM]
          : [{ type: "message", role: "assistant", id: "m1", status: "completed", content: [{ type: "output_text", text: "ok" }] }];
        const frames = [
          { type: "response.created", response: { id } },
          { type: "response.completed", response: { id, status: "completed", output, usage: { input_tokens: 4, output_tokens: 2 } } },
        ];
        return new Response(
          `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const transport = new OpenAIResponsesTransport({
      id: "proxy",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      auth: new NoAuth(),
    });

    try {
      for await (const _event of transport.stream(request([ASK]), CONTEXT)) {
        // Drained so the chain commits.
      }
      for await (const _event of transport.stream(request([ASK, CALL, RESULT]), CONTEXT)) {
        // The turn that used to 400 upstream.
      }
    } finally {
      await transport.close?.();
      await server.stop(true);
    }

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      const input = body.input as ResponseItem[];
      expect(input[0]?.type).not.toBe("function_call_output");
      const seen = new Set<unknown>();
      for (const item of input) {
        if (item.type === "function_call") seen.add(item.call_id);
        if (item.type === "function_call_output") expect(seen.has(item.call_id)).toBe(true);
      }
    }
    expect(bodies[1]?.previous_response_id).toBeNull();
  });
});
