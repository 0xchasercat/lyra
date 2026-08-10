import { describe, expect, test } from "bun:test";
import { ReliableProvider } from "../src/client.ts";
import { classifyProviderError, ProviderFault, type ProviderErrorClass } from "../src/errors.ts";
import type {
  CanonicalMessage,
  ProviderEvent,
  ProviderRequest,
  ReliableProviderEvent,
  RetryEvent,
} from "../src/types.ts";
import {
  baseRequest,
  collect,
  type FixtureAttempt,
  type FixtureScenario,
  type ProviderFixtureAdapter,
  type ProviderFixtureHandle,
  SUCCESS_EVENTS,
} from "./fixture-adapter.ts";

type StreamOutcome =
  | { type: "complete"; events: ReliableProviderEvent[] }
  | { type: "error"; events: ReliableProviderEvent[]; error: unknown };

const NO_DELAY = {
  random: () => 0,
  sleep: async (_ms: number, signal: AbortSignal) => {
    if (signal.aborted) throw signal.reason;
  },
} as const;

export function runProviderConformance(adapter: ProviderFixtureAdapter): void {
  describe(`${adapter.name} provider conformance`, () => {
    test("supports multi-turn tool use and remains resumable", async () => {
      const fixture = adapter.create({
        id: "multi-turn-tool-use",
        attempts: [
          {
            events: [
              { type: "tool_call_start", id: "call-weather", name: "weather" },
              { type: "tool_call_delta", id: "call-weather", argumentsDelta: "{\"city\":\"Paris\"}" },
              { type: "tool_call_end", id: "call-weather" },
              { type: "complete", stopReason: "tool_use", responseId: "response-1" },
            ],
          },
          { events: SUCCESS_EVENTS },
        ],
      });
      const provider = reliable(fixture);
      const first = await settle(provider.stream(baseRequest()));
      expectComplete(first, "tool_use");

      const messages: CanonicalMessage[] = [
        ...baseRequest().messages,
        {
          id: "assistant-1",
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "call-weather",
            name: "weather",
            input: { city: "Paris" },
          }],
        },
        {
          id: "user-2",
          role: "user",
          content: [{
            type: "tool_result",
            toolUseId: "call-weather",
            content: "18 C and sunny",
          }],
        },
      ];
      const second = await settle(provider.stream(baseRequest({ messages })));
      expectComplete(second, "end_turn");
      expect(fixture.invocations).toHaveLength(2);
      expect(fixture.invocations[1]?.request.messages.at(-1)?.content[0]).toEqual({
        type: "tool_result",
        toolUseId: "call-weather",
        content: "18 C and sunny",
      });
    });

    test("preserves parallel tool-call identity and ordering", async () => {
      const events: ProviderEvent[] = [
        { type: "tool_call_start", id: "call-a", name: "weather" },
        { type: "tool_call_start", id: "call-b", name: "weather" },
        { type: "tool_call_delta", id: "call-a", argumentsDelta: "{\"city\":" },
        { type: "tool_call_delta", id: "call-b", argumentsDelta: "{\"city\":\"Rome\"}" },
        { type: "tool_call_delta", id: "call-a", argumentsDelta: "\"Oslo\"}" },
        { type: "tool_call_end", id: "call-b" },
        { type: "tool_call_end", id: "call-a" },
        { type: "complete", stopReason: "tool_use" },
      ];
      const fixture = adapter.create({ id: "parallel-tools", attempts: [{ events }] });
      const outcome = await settle(reliable(fixture).stream(baseRequest()));
      expectComplete(outcome, "tool_use");
      if (outcome.type !== "complete") return;
      expect(outcome.events.filter((event) => event.type === "tool_call_start")).toEqual([
        { type: "tool_call_start", id: "call-a", name: "weather" },
        { type: "tool_call_start", id: "call-b", name: "weather" },
      ]);
    });

    test("preserves thinking blocks, signatures, and reasoning items", async () => {
      const reasoning = { id: "reasoning-1", summary: [{ text: "check both cities" }] };
      const fixture = adapter.create({
        id: "thinking-reasoning",
        attempts: [{
          events: [
            { type: "thinking_delta", thinking: "I should compare forecasts." },
            { type: "thinking_signature", signature: "signed-thinking" },
            { type: "reasoning_item", item: reasoning },
            { type: "text_delta", text: "The forecasts are similar." },
            { type: "complete", stopReason: "end_turn" },
          ],
        }],
      });
      const outcome = await settle(reliable(fixture).stream(baseRequest()));
      expectComplete(outcome, "end_turn");
      if (outcome.type !== "complete") return;
      expect(outcome.events.slice(0, 3)).toEqual([
        { type: "thinking_delta", thinking: "I should compare forecasts." },
        { type: "thinking_signature", signature: "signed-thinking" },
        { type: "reasoning_item", item: reasoning },
      ]);
    });

    test("surfaces transport fallback as part of the canonical stream", async () => {
      const fixture = adapter.create({
        id: "transport-fallback",
        attempts: [{
          events: [
            {
              type: "transport_fallback",
              from: "openai_websocket",
              to: "openai_responses",
              reason: "fixture socket unavailable",
            },
            ...SUCCESS_EVENTS,
          ],
        }],
      });
      const outcome = await settle(reliable(fixture).stream(baseRequest()));
      expectComplete(outcome, "end_turn");
      if (outcome.type === "complete") {
        expect(outcome.events[0]).toEqual({
          type: "transport_fallback",
          from: "openai_websocket",
          to: "openai_responses",
          reason: "fixture socket unavailable",
        });
      }
    });

    test("retries visibly after interruption in a tool call and resets partial output", async () => {
      const reset = Object.assign(new Error("fixture connection reset"), { code: "ECONNRESET" });
      const fixture = adapter.create({
        id: "interrupted-tool-call",
        attempts: [
          {
            events: [
              { type: "tool_call_start", id: "interrupted", name: "weather" },
              { type: "tool_call_delta", id: "interrupted", argumentsDelta: "{\"city\":" },
            ],
            termination: { type: "throw", error: reset },
          },
          {
            events: [
              { type: "tool_call_start", id: "resumed", name: "weather" },
              { type: "tool_call_delta", id: "resumed", argumentsDelta: "{\"city\":\"Paris\"}" },
              { type: "tool_call_end", id: "resumed" },
              { type: "complete", stopReason: "tool_use" },
            ],
          },
        ],
      });
      const outcome = await settle(reliable(fixture).stream(baseRequest()));
      expectComplete(outcome, "tool_use");
      if (outcome.type !== "complete") return;
      expect(retries(outcome.events)).toEqual([
        expect.objectContaining({
          attempt: 2,
          reason: "transient: fixture connection reset",
          resetsPartialOutput: true,
        }),
      ]);
      expect(fixture.invocations[1]?.request).toBe(fixture.invocations[0]?.request);
    });

    for (const errorClass of [
      "transient",
      "context_overflow",
      "content_shape",
      "auth",
      "quota",
      "model_unavailable",
      "bad_request",
      "refusal",
    ] as const satisfies readonly ProviderErrorClass[]) {
      test(`classifies and applies the ${errorClass} recovery policy`, async () => {
        await exerciseErrorPolicy(adapter, errorClass);
      });
    }

    test("compacts context once and retries the compacted request", async () => {
      const fixture = adapter.create({
        id: "context-compaction",
        attempts: [
          { termination: { type: "throw", error: faultFor("context_overflow") } },
          { events: SUCCESS_EVENTS },
        ],
      });
      const compacted = baseRequest({ metadata: { compacted: "yes" } });
      let compactions = 0;
      const provider = reliable(fixture, {
        compact: async () => {
          compactions += 1;
          return compacted;
        },
      });
      const outcome = await settle(provider.stream(baseRequest()));
      expectComplete(outcome, "end_turn");
      expect(compactions).toBe(1);
      expect(fixture.invocations[1]?.request).toBe(compacted);
    });

    test("refreshes authentication once and then surfaces a repeated auth fault", async () => {
      const fixture = adapter.create({
        id: "auth-refresh-once",
        attempts: [
          { termination: { type: "throw", error: faultFor("auth") } },
          { termination: { type: "throw", error: faultFor("auth") } },
          { events: SUCCESS_EVENTS },
        ],
      });
      let refreshes = 0;
      const provider = reliable(fixture, { refreshAuth: async () => { refreshes += 1; } });
      const first = await settle(provider.stream(baseRequest()));
      expectFault(first, "auth", "fixture auth message");
      expect(refreshes).toBe(1);
      expect(fixture.invocations).toHaveLength(2);

      const resumed = await settle(provider.stream(baseRequest()));
      expectComplete(resumed, "end_turn");
    });

    test("honors Retry-After and exposes retry timing", async () => {
      const fixture = adapter.create({
        id: "retry-after",
        attempts: [
          {
            termination: {
              type: "throw",
              error: classifyProviderError({
                status: 429,
                body: { error: { message: "slow down" } },
                headers: { "Retry-After": "2.5" },
              }),
            },
          },
          { events: SUCCESS_EVENTS },
        ],
      });
      const slept: number[] = [];
      const provider = reliable(fixture, {
        sleep: async (ms, signal) => {
          if (signal.aborted) throw signal.reason;
          slept.push(ms);
        },
      });
      const outcome = await settle(provider.stream(baseRequest()));
      expectComplete(outcome, "end_turn");
      if (outcome.type !== "complete") return;
      expect(retries(outcome.events)).toEqual([
        expect.objectContaining({
          attempt: 2,
          maxAttempts: 8,
          delayMs: 2_500,
          reason: "transient: slow down",
          resetsPartialOutput: false,
        }),
      ]);
      expect(slept).toEqual([2_500]);
    });

    test("repairs missing, unterminated, and malformed tool completions once", async () => {
      const malformedAttempts: readonly FixtureAttempt[] = [
        {
          events: [{ type: "text_delta", text: "partial" }],
        },
        {
          events: [
            { type: "tool_call_start", id: "open", name: "weather" },
            { type: "tool_call_delta", id: "open", argumentsDelta: "{\"city\":\"Paris\"}" },
            { type: "complete", stopReason: "tool_use" },
          ],
        },
        {
          events: [
            { type: "tool_call_start", id: "invalid-json", name: "weather" },
            { type: "tool_call_delta", id: "invalid-json", argumentsDelta: "{\"city\":" },
            { type: "tool_call_end", id: "invalid-json" },
            { type: "complete", stopReason: "tool_use" },
          ],
        },
      ];

      for (const [index, malformed] of malformedAttempts.entries()) {
        const fixture = adapter.create({
          id: `malformed-completion-${index}`,
          attempts: [malformed, { events: SUCCESS_EVENTS }],
        });
        const outcome = await settle(reliable(fixture).stream(baseRequest()));
        expectComplete(outcome, "end_turn");
        if (outcome.type === "complete") {
          expect(retries(outcome.events)).toEqual([
            expect.objectContaining({
              attempt: 2,
              reason: expect.stringContaining("content_shape:"),
              resetsPartialOutput: true,
            }),
          ]);
        }
      }
    });

    test("treats an empty turn as retryable once", async () => {
      const fixture = adapter.create({
        id: "empty-turn",
        attempts: [
          { events: [{ type: "complete", stopReason: "end_turn" }] },
          { events: SUCCESS_EVENTS },
        ],
      });
      const outcome = await settle(reliable(fixture).stream(baseRequest()));
      expectComplete(outcome, "end_turn");
      if (outcome.type === "complete") {
        expect(retries(outcome.events)).toEqual([
          expect.objectContaining({
            reason: "content_shape: Provider returned an empty assistant turn",
            resetsPartialOutput: false,
          }),
        ]);
      }
    });

    test("stalls after output began expire, abort the attempt, and resume", async () => {
      const fixture = adapter.create({
        id: "stall-deadline",
        attempts: [
          // The stall only counts once the stream has flowed: that is the F2 signature the
          // deadline exists for. Silence *before* the first token is a model thinking.
          { events: [{ type: "text_delta", text: "half a " }], termination: { type: "stall" } },
          { events: SUCCESS_EVENTS },
        ],
      });
      const provider = reliable(fixture, { streamStallTimeoutMs: 5 });
      const outcome = await settle(provider.stream(baseRequest()));
      expectComplete(outcome, "end_turn");
      expect(fixture.invocations).toHaveLength(2);
      expect(fixture.invocations[0]?.context.signal.aborted).toBe(true);
      if (outcome.type === "complete") {
        expect(retries(outcome.events)[0]).toEqual(expect.objectContaining({
          reason: "transient: Provider stream went silent for 5ms after output began",
          resetsPartialOutput: true,
        }));
      }
    });

    test("silence before the first token is never cancelled as a stall", async () => {
      const fixture = adapter.create({
        id: "slow-first-token",
        attempts: [{ events: SUCCESS_EVENTS, openingDelayMs: 60 }],
      });
      const provider = reliable(fixture, { streamStallTimeoutMs: 5 });
      const outcome = await settle(provider.stream(baseRequest()));
      expectComplete(outcome, "end_turn");
      expect(fixture.invocations).toHaveLength(1);
      if (outcome.type === "complete") expect(retries(outcome.events)).toHaveLength(0);
    });

    test("external cancellation is terminal and the next turn can resume", async () => {
      const fixture = adapter.create({
        id: "cancellation",
        attempts: [
          { termination: { type: "stall" } },
          { events: SUCCESS_EVENTS },
        ],
      });
      const controller = new AbortController();
      const reason = new DOMException("fixture user cancelled", "AbortError");
      const pending = settle(reliable(fixture).stream(baseRequest(), controller.signal));
      await waitForInvocations(fixture, 1);
      controller.abort(reason);
      const cancelled = await pending;
      expect(cancelled.type).toBe("error");
      if (cancelled.type === "error") expect(cancelled.error).toBe(reason);
      expect(fixture.invocations[0]?.context.signal.aborted).toBe(true);

      const resumed = await settle(reliable(fixture).stream(baseRequest()));
      expectComplete(resumed, "end_turn");
    });

    test("accepts an explicit cancelled completion without inventing content", async () => {
      const fixture = adapter.create({
        id: "cancelled-completion",
        attempts: [{ events: [{ type: "complete", stopReason: "cancelled" }] }],
      });
      const outcome = await settle(reliable(fixture).stream(baseRequest()));
      expectComplete(outcome, "cancelled");
      if (outcome.type === "complete") expect(retries(outcome.events)).toHaveLength(0);
    });

    test("deterministic chaos always reaches a defined terminal state and resumes", async () => {
      expect(deterministicChaosCases(0x5eed).map((item) => item.name)).toEqual(
        deterministicChaosCases(0x5eed).map((item) => item.name),
      );
      for (const chaos of deterministicChaosCases(0x5eed)) {
        const fixture = adapter.create({
          id: `chaos-${chaos.name}`,
          attempts: [chaos.attempt, { events: SUCCESS_EVENTS }],
        });
        let compactions = 0;
        let refreshes = 0;
        const provider = reliable(fixture, {
          streamStallTimeoutMs: 2,
          compact: async (request) => {
            compactions += 1;
            return { ...request, metadata: { chaosCompacted: "yes" } };
          },
          refreshAuth: async () => { refreshes += 1; },
        });
        const outcome = await settle(provider.stream(baseRequest()));
        expect(["complete", "error"]).toContain(outcome.type);
        if (outcome.type === "complete") {
          expectExactlyOneCompletion(outcome.events);
        } else {
          expect(outcome.error).toBeInstanceOf(ProviderFault);
          const resumed = await settle(provider.stream(baseRequest()));
          expectComplete(resumed, "end_turn");
        }
        expect(compactions).toBeLessThanOrEqual(1);
        expect(refreshes).toBeLessThanOrEqual(1);
      }
    });
  });
}

async function exerciseErrorPolicy(
  adapter: ProviderFixtureAdapter,
  errorClass: ProviderErrorClass,
): Promise<void> {
  const fixture = adapter.create({
    id: `error-${errorClass}`,
    attempts: [
      { termination: { type: "throw", error: faultFor(errorClass) } },
      { events: SUCCESS_EVENTS },
    ],
  });
  let compactions = 0;
  let refreshes = 0;
  const provider = reliable(fixture, {
    compact: async (request) => {
      compactions += 1;
      return { ...request, metadata: { compacted: "yes" } };
    },
    refreshAuth: async () => { refreshes += 1; },
  });
  const retryable = ["transient", "context_overflow", "content_shape", "auth"].includes(errorClass);
  const first = await settle(provider.stream(baseRequest()));
  if (retryable) {
    expectComplete(first, "end_turn");
    if (first.type === "complete") {
      expect(retries(first.events)).toHaveLength(1);
      expect(retries(first.events)[0]?.reason).toBe(`${errorClass}: fixture ${errorClass} message`);
    }
  } else {
    expectFault(first, errorClass, `fixture ${errorClass} message`);
    expect(first.events).toHaveLength(0);
    const resumed = await settle(provider.stream(baseRequest()));
    expectComplete(resumed, "end_turn");
  }
  expect(compactions).toBe(errorClass === "context_overflow" ? 1 : 0);
  expect(refreshes).toBe(errorClass === "auth" ? 1 : 0);
}

function reliable(
  fixture: ProviderFixtureHandle,
  options: ConstructorParameters<typeof ReliableProvider>[1] = {},
): ReliableProvider {
  return new ReliableProvider(fixture.transport, { ...NO_DELAY, ...options });
}

async function settle(source: AsyncIterable<ReliableProviderEvent>): Promise<StreamOutcome> {
  const events: ReliableProviderEvent[] = [];
  try {
    for await (const event of source) events.push(event);
    return { type: "complete", events };
  } catch (error) {
    return { type: "error", events, error };
  }
}

function expectComplete(outcome: StreamOutcome, stopReason: string): void {
  expect(outcome.type).toBe("complete");
  if (outcome.type !== "complete") return;
  expectExactlyOneCompletion(outcome.events);
  expect(outcome.events.at(-1)).toEqual(expect.objectContaining({ type: "complete", stopReason }));
}

function expectExactlyOneCompletion(events: readonly ReliableProviderEvent[]): void {
  expect(events.filter((event) => event.type === "complete")).toHaveLength(1);
  expect(events.at(-1)?.type).toBe("complete");
}

function expectFault(outcome: StreamOutcome, classification: ProviderErrorClass, message: string): void {
  expect(outcome.type).toBe("error");
  if (outcome.type !== "error") return;
  expect(outcome.error).toBeInstanceOf(ProviderFault);
  expect(outcome.error).toEqual(expect.objectContaining({
    classification,
    providerMessage: message,
  }));
}

function retries(events: readonly ReliableProviderEvent[]): RetryEvent[] {
  return events.filter((event): event is RetryEvent => event.type === "retry");
}

function faultFor(errorClass: ProviderErrorClass): ProviderFault {
  const inputByClass: Record<ProviderErrorClass, Parameters<typeof classifyProviderError>[0]> = {
    transient: { status: 503, body: { error: { message: "fixture transient message" } } },
    context_overflow: {
      status: 400,
      body: { error: { code: "context_length_exceeded", message: "fixture context_overflow message" } },
    },
    content_shape: {
      status: 400,
      body: { error: { code: "invalid_role_sequence", message: "fixture content_shape message" } },
    },
    auth: { status: 401, body: { error: { message: "fixture auth message" } } },
    quota: {
      status: 429,
      body: { error: { code: "insufficient_quota", message: "fixture quota message" } },
    },
    model_unavailable: {
      status: 404,
      body: { error: { code: "model_not_found", message: "fixture model_unavailable message" } },
    },
    bad_request: { status: 400, body: { error: { message: "fixture bad_request message" } } },
    refusal: {
      status: 400,
      body: { error: { code: "refusal", message: "fixture refusal message" } },
    },
  };
  return classifyProviderError(inputByClass[errorClass]);
}

interface ChaosCase {
  readonly name: string;
  readonly attempt: FixtureAttempt;
}

export function deterministicChaosCases(seed: number): ChaosCase[] {
  const reset = Object.assign(new Error("chaos reset"), { code: "ECONNRESET" });
  const cases: ChaosCase[] = [
    { name: "drop", attempt: { termination: { type: "throw", error: reset } } },
    // Silence *after* output began — the only silence §3.3 treats as a stall.
    {
      name: "stall",
      attempt: {
        events: [{ type: "text_delta", text: "chaos partial" }],
        termination: { type: "stall" },
      },
    },
    // Silence *before* the first token, bounded only by the turn deadline: the model is
    // thinking, and the attempt has to survive it rather than cancel a healthy request.
    { name: "slow-first-token", attempt: { openingDelayMs: 25, events: SUCCESS_EVENTS } },
    { name: "empty", attempt: { events: [{ type: "complete", stopReason: "end_turn" }] } },
    {
      name: "truncated-tool-json",
      attempt: {
        events: [
          { type: "tool_call_start", id: "chaos-open", name: "weather" },
          { type: "tool_call_delta", id: "chaos-open", argumentsDelta: "{\"city\":" },
        ],
      },
    },
    {
      name: "malformed-tool-arguments",
      attempt: {
        events: [
          { type: "tool_call_start", id: "chaos-invalid", name: "weather" },
          { type: "tool_call_delta", id: "chaos-invalid", argumentsDelta: "not-json" },
          { type: "tool_call_end", id: "chaos-invalid" },
        ],
      },
    },
    ...([
      "transient",
      "context_overflow",
      "content_shape",
      "auth",
      "quota",
      "model_unavailable",
      "bad_request",
      "refusal",
    ] as const).map((errorClass) => ({
      name: `class-${errorClass}`,
      attempt: { termination: { type: "throw" as const, error: faultFor(errorClass) } },
    })),
  ];

  let state = seed >>> 0;
  for (let index = cases.length - 1; index > 0; index -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const swap = (state >>> 0) % (index + 1);
    [cases[index], cases[swap]] = [cases[swap]!, cases[index]!];
  }
  return cases;
}

async function waitForInvocations(fixture: ProviderFixtureHandle, count: number): Promise<void> {
  for (let spin = 0; spin < 100 && fixture.invocations.length < count; spin += 1) {
    await Bun.sleep(0);
  }
  expect(fixture.invocations.length).toBeGreaterThanOrEqual(count);
}
