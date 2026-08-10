import type {
  ProviderEvent,
  ProviderRequest,
  ProviderTransport,
  TransportContext,
  TransportFallbackEvent,
} from "../src/types.ts";

export type FixtureTransportEvent = ProviderEvent | TransportFallbackEvent;

export type FixtureTermination =
  | { type: "return" }
  | { type: "throw"; error: unknown }
  | { type: "stall" };

export interface FixtureAttempt {
  readonly events?: readonly FixtureTransportEvent[];
  readonly termination?: FixtureTermination;
  /**
   * How long the transport accepts the request and says nothing before its first event —
   * a reasoning model thinking. Not a stall: §3.3 arms no deadline before the first token.
   */
  readonly openingDelayMs?: number;
}

export interface FixtureScenario {
  readonly id: string;
  readonly attempts: readonly FixtureAttempt[];
}

export interface FixtureInvocation {
  readonly request: ProviderRequest;
  readonly context: TransportContext;
}

export interface ProviderFixtureHandle {
  readonly transport: ProviderTransport;
  readonly invocations: FixtureInvocation[];
}

/**
 * Adapters translate the behavior fixtures below into a concrete transport's
 * recorded wire format. The canonical adapter is intentionally protocol-free.
 */
export interface ProviderFixtureAdapter {
  readonly name: string;
  create(scenario: FixtureScenario): ProviderFixtureHandle;
}

export class CanonicalFixtureAdapter implements ProviderFixtureAdapter {
  readonly name = "canonical fake transport";

  create(scenario: FixtureScenario): ProviderFixtureHandle {
    const invocations: FixtureInvocation[] = [];
    const transport: ProviderTransport = {
      apiType: "openai_responses",
      id: `fixture:${scenario.id}`,
      async *stream(request, context) {
        const index = invocations.length;
        invocations.push({ request, context });
        const attempt = scenario.attempts[index];
        if (attempt === undefined) {
          throw new Error(`Fixture ${scenario.id} has no invocation ${index + 1}`);
        }

        if (attempt.openingDelayMs !== undefined) await Bun.sleep(attempt.openingDelayMs);

        for (const event of attempt.events ?? []) {
          if (context.signal.aborted) throw context.signal.reason;
          yield event;
        }

        const termination = attempt.termination ?? { type: "return" };
        if (termination.type === "throw") throw termination.error;
        if (termination.type === "stall") await waitForAbort(context.signal);
      },
    };
    return { transport, invocations };
  }
}

export function baseRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "fixture-model",
    system: "Use tools when needed.",
    messages: [{
      id: "user-1",
      role: "user",
      content: [{ type: "text", text: "What is the weather?" }],
    }],
    tools: [{
      name: "weather",
      description: "Read the weather for a city",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    }],
    ...overrides,
  };
}

export const SUCCESS_EVENTS = [
  { type: "text_delta", text: "done" },
  { type: "complete", stopReason: "end_turn", responseId: "response-success" },
] as const satisfies readonly ProviderEvent[];

export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

async function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) throw signal.reason;
  return new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
