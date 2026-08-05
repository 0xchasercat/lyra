import type { ResolvedProvider } from "./config.ts";
import type { ProviderTransport } from "./types.ts";
import { AnthropicMessagesTransport } from "./transports/anthropic-messages.ts";
import { OpenAICompletionsTransport } from "./transports/openai-completions.ts";
import { OpenAIResponsesTransport } from "./transports/openai-responses.ts";
import { OpenAIWebSocketTransport } from "./transports/openai-websocket.ts";

export function createProviderTransport(config: ResolvedProvider): ProviderTransport {
  switch (config.apiType) {
    case "anthropic_messages":
      return new AnthropicMessagesTransport(config);
    case "openai_completions":
      return new OpenAICompletionsTransport(config);
    case "openai_responses":
      return config.websocket === "off"
        ? new OpenAIResponsesTransport(config)
        : new OpenAIWebSocketTransport(config);
  }
}
