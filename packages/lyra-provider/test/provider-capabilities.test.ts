import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoAuth } from "../src/auth.ts";
import { classifyProviderError } from "../src/errors.ts";
import { loadProviderConfig, resolveProvider } from "../src/config.ts";
import { createProviderTransport } from "../src/registry.ts";
import { buildResponsesRequest } from "../src/responses-codec.ts";
import type { ProviderRequest } from "../src/types.ts";

const temporaryPaths: string[] = [];
const servers: Bun.Server<unknown>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const path of temporaryPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

async function configFrom(toml: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lyra-reasoning-"));
  temporaryPaths.push(directory);
  const path = join(directory, "providers.toml");
  await Bun.write(path, toml);
  return path;
}

const request: ProviderRequest = {
  model: "gpt-5.6",
  system: "You are terse.",
  messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
};

describe("reasoning_effort", () => {
  test("is parsed from providers.toml and carried onto the resolved provider", async () => {
    const path = await configFrom(`
[providers.proxy]
base_url = "http://localhost:1/v1"
api_type = "openai_responses"
auth = { type = "none" }
reasoning_effort = "xhigh"
`);
    const config = await loadProviderConfig(path);
    expect(config.providers.proxy?.reasoning_effort).toBe("xhigh");
    expect(resolveProvider("proxy", config.providers.proxy!).reasoningEffort).toBe("xhigh");
  });

  test("is optional and absent by default", async () => {
    const path = await configFrom(`
[providers.plain]
base_url = "http://localhost:1/v1"
api_type = "openai_responses"
auth = { type = "none" }
`);
    const config = await loadProviderConfig(path);
    expect(config.providers.plain?.reasoning_effort).toBeUndefined();
    expect("reasoningEffort" in resolveProvider("plain", config.providers.plain!)).toBe(false);
  });

  test("rejects values outside the provider vocabulary", async () => {
    const path = await configFrom(`
[providers.bad]
base_url = "http://localhost:1/v1"
api_type = "openai_responses"
auth = { type = "none" }
reasoning_effort = "maximum"
`);
    await expect(loadProviderConfig(path)).rejects.toThrow(/reasoning_effort must be one of none, minimal, low, medium, high, xhigh/);
  });

  test("is refused on an Anthropic provider instead of being silently dropped", () => {
    expect(() => resolveProvider("anthropic", {
      base_url: "https://api.anthropic.com/v1",
      api_type: "anthropic_messages",
      auth: { type: "none" },
      reasoning_effort: "high",
    })).toThrow(/reasoning_effort/);
  });

  test("becomes reasoning.effort on a Responses request body", () => {
    const withEffort = buildResponsesRequest(request, { stream: true, reasoningEffort: "xhigh" });
    expect(withEffort.reasoning).toEqual({ effort: "xhigh" });
    const without = buildResponsesRequest(request, { stream: true });
    expect("reasoning" in without).toBe(false);
  });

  test("reaches the wire through the Responses (HTTP) and Chat Completions transports", async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(incoming) {
        bodies.push(await incoming.json() as Record<string, unknown>);
        // A bare-minimum terminal stream for either wire format; the decoders tolerate a
        // response that ends immediately.
        const isResponses = new URL(incoming.url).pathname.endsWith("/responses");
        const frames = isResponses
          ? `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", output: [], usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`
          : `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`;
        return new Response(frames, { headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.port}/v1`;
    const context = { signal: new AbortController().signal, headersTimeoutMs: 5_000 };

    const responses = createProviderTransport({ id: "r", baseUrl, auth: new NoAuth(), apiType: "openai_responses", websocket: "off", models: [], reasoningEffort: "xhigh" });
    for await (const _ of responses.stream(request, context)) { /* drain */ }
    const completions = createProviderTransport({ id: "c", baseUrl, auth: new NoAuth(), apiType: "openai_completions", websocket: "off", models: [], reasoningEffort: "low" });
    for await (const _ of completions.stream(request, context)) { /* drain */ }

    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.reasoning).toEqual({ effort: "xhigh" });
    expect(bodies[1]?.reasoning_effort).toBe("low");
  });
});

describe("previous_response_id", () => {
  test("is omitted rather than sent as null when there is no chain to continue", () => {
    // A gateway in front of a ChatGPT backend answers 400 "Unsupported parameter:
    // previous_response_id" to the key's mere presence, so a null must not reach the wire.
    const fresh = buildResponsesRequest(request, { stream: true, previousResponseId: null });
    expect("previous_response_id" in fresh).toBe(false);

    const chained = buildResponsesRequest(request, { stream: true, previousResponseId: "resp_1" });
    expect(chained.previous_response_id).toBe("resp_1");
  });
});

describe("an endpoint that cannot chain at all", () => {
  // A gateway in front of a ChatGPT backend refuses `previous_response_id` in prose, with no
  // error code and a status that would otherwise read as an auth failure.
  const REFUSAL = "The service cannot safely review this request because its earlier conversation context is unavailable or expired. Resend the complete context, fork from an earlier safe message, or start a new task.";

  test("a prose refusal is read as a dropped chain, not a revoked credential", () => {
    const fault = classifyProviderError({ status: 403, body: REFUSAL, url: "http://x/responses" });
    expect(fault.code).toBe("previous_response_not_found");
    expect(fault.classification).toBe("transient");

    // An actual permission failure still reads as one.
    const auth = classifyProviderError({ status: 403, body: "Forbidden", url: "http://x/responses" });
    expect(auth.classification).toBe("auth");
  });

  test("the gateway's other wording for the same refusal is read the same way", () => {
    const fault = classifyProviderError({
      status: 403,
      body: "The service cannot safely review this task without a stable session identifier. Start a new task and try again.",
      url: "http://x/responses",
    });
    expect(fault.code).toBe("previous_response_not_found");
    expect(fault.classification).toBe("transient");
  });

  test("the parameter being rejected outright is the same fact", () => {
    const fault = classifyProviderError({ status: 400, body: { detail: "Unsupported parameter: previous_response_id" }, url: "http://x/responses" });
    expect(fault.code).toBe("previous_response_not_found");
  });

  test("is learned once: the chain is dropped, announced, and never retried", async () => {
    const bodies: Record<string, unknown>[] = [];
    let announced = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(incoming) {
        const body = await incoming.json() as Record<string, unknown>;
        bodies.push(body);
        if (body.previous_response_id !== undefined) {
          return new Response(REFUSAL, { status: 403 });
        }
        const id = `resp_${bodies.length}`;
        const frames = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`;
        return new Response(frames, { headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(server);
    const context = { signal: new AbortController().signal, headersTimeoutMs: 5_000 };
    const transport = createProviderTransport({
      id: "gw", baseUrl: `http://127.0.0.1:${server.port}/v1`, auth: new NoAuth(),
      apiType: "openai_responses", websocket: "off", models: [],
      onChainingUnsupported: () => { announced += 1; },
    });

    const user = (text: string) => ({ id: `u${text}`, role: "user" as const, content: [{ type: "text" as const, text }] });
    const assistant = (text: string) => ({ id: `a${text}`, role: "assistant" as const, content: [{ type: "text" as const, text }] });
    for (const messages of [[user("1")], [user("1"), assistant("ok"), user("2")], [user("1"), assistant("ok"), user("2"), assistant("ok"), user("3")]]) {
      for await (const _ of transport.stream({ ...request, messages }, context)) { /* drain */ }
    }

    // Turn 1 has no chain. Turn 2 tries one, is refused, and resends everything. Turn 3 does
    // not try again — the endpoint's answer is remembered.
    expect(bodies.filter((b) => b.previous_response_id !== undefined)).toHaveLength(1);
    expect(bodies).toHaveLength(4);
    expect(announced).toBe(1);
    // Nothing was lost: the final turn still carried the whole conversation.
    expect((bodies[3]?.input as unknown[]).length).toBe(5);
  });

  test("response_chaining = false skips even the first attempt", async () => {
    const path = await configFrom(`
[providers.gateway]
base_url = "http://localhost:1/v1"
api_type = "openai_responses"
auth = { type = "none" }
response_chaining = false
`);
    const config = await loadProviderConfig(path);
    expect(config.providers.gateway?.response_chaining).toBe(false);
    expect(resolveProvider("gateway", config.providers.gateway!).chaining).toBe(false);
  });
});
