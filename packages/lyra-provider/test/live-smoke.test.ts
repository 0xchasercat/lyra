import { expect, test } from "bun:test";
import { EnvironmentAuth } from "../src/auth.ts";
import type { ProviderEvent, ProviderRequest, ProviderTransport, TransportEvent } from "../src/types.ts";
import { AnthropicMessagesTransport } from "../src/transports/anthropic-messages.ts";
import { OpenAICompletionsTransport } from "../src/transports/openai-completions.ts";
import { OpenAIResponsesTransport } from "../src/transports/openai-responses.ts";
import { OpenAIWebSocketTransport } from "../src/transports/openai-websocket.ts";

const liveTest = Bun.env.LYRA_LIVE_PROVIDER_TESTS === "1" ? test : test.skip;

const request: ProviderRequest = {
  model: "",
  system: "You are in a provider transport smoke test.",
  messages: [{ id: "user-1", role: "user", content: [{ type: "text", text: "Reply with exactly: lyra-ok" }] }],
  tools: [],
  maxOutputTokens: 512,
};

liveTest("OpenAI Responses HTTP live smoke", async () => {
  const transport = new OpenAIResponsesTransport({
    id: "openai-live-http",
    baseUrl: Bun.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    auth: new EnvironmentAuth("OPENAI_API_KEY"),
  });
  await expectSuccessfulText(transport, { ...request, model: Bun.env.OPENAI_MODEL ?? "gpt-5.6-luna" });
});

liveTest("OpenAI Responses WebSocket live smoke", async () => {
  const transport = new OpenAIWebSocketTransport({
    id: "openai-live-websocket",
    baseUrl: Bun.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    auth: new EnvironmentAuth("OPENAI_API_KEY"),
  });
  try {
    await expectSuccessfulText(transport, { ...request, model: Bun.env.OPENAI_MODEL ?? "gpt-5.6-luna" });
  } finally {
    await transport.close();
  }
});

liveTest("OpenAI Chat Completions live smoke", async () => {
  const transport = new OpenAICompletionsTransport({
    id: "openai-live-completions",
    baseUrl: Bun.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    auth: new EnvironmentAuth("OPENAI_API_KEY"),
  });
  await expectSuccessfulText(transport, { ...request, model: Bun.env.OPENAI_MODEL ?? "gpt-5.6-luna" });
});

liveTest("Anthropic Messages live smoke", async () => {
  const transport = new AnthropicMessagesTransport({
    id: "anthropic-live",
    baseUrl: Bun.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    auth: new EnvironmentAuth("ANTHROPIC_API_KEY"),
    authHeader: "x-api-key",
  });
  await expectSuccessfulText(transport, {
    ...request,
    model: Bun.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5",
  });
});

async function expectSuccessfulText(
  transport: ProviderTransport,
  providerRequest: ProviderRequest,
): Promise<void> {
  const events: TransportEvent[] = [];
  for await (const event of transport.stream(providerRequest, {
    signal: AbortSignal.timeout(120_000),
    headersTimeoutMs: 30_000,
  })) {
    events.push(event);
  }
  const providerEvents = events.filter((event): event is ProviderEvent => event.type !== "transport_fallback");
  expect(providerEvents.filter((event) => event.type === "complete")).toHaveLength(1);
  expect(providerEvents.some((event) => event.type === "text_delta" && event.text.includes("lyra-ok"))).toBe(true);
}
