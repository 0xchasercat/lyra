import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReliableProvider,
  type ProviderRequest,
  type ProviderTransport,
  type ToolDefinition,
  type TransportContext,
  type TransportEvent,
} from "@lyra/provider";
import { TranscriptStore } from "@lyra/session";
import { AgentLoop } from "../src/agent-loop.ts";
import { SteerQueue, renderHubAside } from "../src/steering.ts";
import { DEFAULT_TOOL_TIMEOUTS, ToolDispatcher } from "../src/tool-dispatch.ts";
import type { AgentEvent, AgentTurnResult, ToolRegistry } from "../src/types.ts";

/**
 * Inter-agent messages inside a running turn (LYRA.md §9).
 *
 * Two properties separate an aside from a steer, and both are load-bearing. An aside is
 * **non-interrupting** — another agent's opinion may not cut short a wait the user is
 * paying for — and it **names its sender** in the transcript, because a message that reads
 * as the user's is a message the model will answer as if the user had asked.
 */

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("hub asides", () => {
  test("a hub aside lands as its own user turn, marked with the peer that sent it", async () => {
    const store = createStore();
    const steering = new SteerQueue();
    const loop = new AgentLoop({
      provider: reliable(scripted([
        async function* () {
          yield { type: "tool_call_start", id: "c1", name: "wait" };
          yield { type: "tool_call_delta", id: "c1", argumentsDelta: "{}" };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "complete", stopReason: "tool_use" };
        },
        async function* () {
          yield { type: "text_delta", text: "acknowledged" };
          yield { type: "complete", stopReason: "end_turn" };
        },
      ])),
      store,
      tools: {
        definitions: () => [{ name: "wait", description: "wait", inputSchema: { type: "object" } } satisfies ToolDefinition],
        execute: async () => { steering.aside({ from: "reviewer", text: "the lexer is the problem", messageId: "m-1" }); return { content: "waited" }; },
      },
      model: "fixture-model",
      system: "stable",
      contextWindow: 32_000,
      workspace: "/workspace",
    });

    const outcome = await settle(loop.runTurn("start", undefined, { steering }));
    const steered = outcome.events.filter((event): event is Extract<AgentEvent, { type: "steered" }> => event.type === "steered");
    expect(steered).toHaveLength(1);
    expect(steered[0]).toMatchObject({ at: "tool_boundary", source: "hub", from: "reviewer" });
    expect(steered[0]!.text).toContain("[hub message from reviewer]");
    expect(steered[0]!.text).toContain("the lexer is the problem");
    // Its own user-role entry, appended after the tool-result message rather than glued
    // onto it — which is what makes /context and compaction attribute it correctly.
    const users = store.lineage().filter((entry) => entry.type === "message" && entry.role === "user");
    expect(users).toHaveLength(3);
    expect(String(JSON.stringify(users.at(-1)))).toContain("hub message from reviewer");
    store.close();
  });

  test("an aside never interrupts a wait; a steer always does", () => {
    const queue = new SteerQueue();
    let interruptions = 0;
    const unsubscribe = queue.subscribe(() => { interruptions += 1; });
    queue.aside({ from: "reviewer", text: "still going" });
    expect(interruptions).toBe(0);
    expect(queue.size).toBe(1);
    queue.push("stop and summarise");
    expect(interruptions).toBe(1);
    unsubscribe();

    // A wait registered after an aside is queued must not be woken by it either, while a
    // wait registered after a *steer* fires immediately so the steer is never swallowed.
    const later = new SteerQueue();
    later.aside({ from: "reviewer", text: "fyi" });
    let woken = 0;
    later.subscribe(() => { woken += 1; })();
    expect(woken).toBe(0);
    later.push("now");
    let wokenAfterSteer = 0;
    later.subscribe(() => { wokenAfterSteer += 1; })();
    expect(wokenAfterSteer).toBe(1);
  });

  test("a message the agent already read for itself is not delivered twice", () => {
    const queue = new SteerQueue();
    queue.aside({ from: "reviewer", text: "one", messageId: "m-1" });
    queue.aside({ from: "reviewer", text: "two", messageId: "m-2" });
    queue.push("user text");
    expect(queue.consume(["m-1"])).toBe(1);
    expect(queue.drain().map((entry) => entry.kind === "hub" ? entry.text : entry.text)).toEqual(["two", "user text"]);
  });

  test("steering and an aside in one turn stay distinguishable and keep their order", async () => {
    const store = createStore();
    const steering = new SteerQueue();
    const loop = new AgentLoop({
      provider: reliable(scripted([
        async function* () {
          yield { type: "tool_call_start", id: "c1", name: "wait" };
          yield { type: "tool_call_delta", id: "c1", argumentsDelta: "{}" };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "complete", stopReason: "tool_use" };
        },
        async function* () {
          yield { type: "text_delta", text: "done" };
          yield { type: "complete", stopReason: "end_turn" };
        },
      ])),
      store,
      tools: {
        definitions: () => [{ name: "wait", description: "wait", inputSchema: { type: "object" } } satisfies ToolDefinition],
        execute: async () => {
          steering.aside({ from: "reviewer", text: "child says hi" });
          steering.push("and the user says stop");
          return { content: "waited" };
        },
      },
      model: "fixture-model",
      system: "stable",
      contextWindow: 32_000,
      workspace: "/workspace",
    });
    const outcome = await settle(loop.runTurn("start", undefined, { steering }));
    const steered = outcome.events.filter((event): event is Extract<AgentEvent, { type: "steered" }> => event.type === "steered");
    expect(steered.map((event) => event.source)).toEqual(["hub", "user"]);
    expect(steered[1]!.text).toBe("and the user says stop");
    expect(steered[1]!.from).toBeUndefined();
    store.close();
  });

  test("the rendered aside tells the model how to answer and that it is not the user", () => {
    const rendered = renderHubAside({ from: "builder", text: "the build is green", data: { exitCode: 0 } });
    expect(rendered).toContain("[hub message from builder]");
    expect(rendered).toContain('{"exitCode":0}');
    expect(rendered).toContain('hub { op: "send", to: "builder"');
    expect(rendered).toContain("not the user");
  });
});

describe("per-tool deadlines", () => {
  /**
   * The generic 120s deadline killed a blocking spawn whose own limit is an hour, and would
   * kill a `hub wait` at the bus's 10-minute maximum. Three tools own a real duration.
   */
  test("the tools with a declared duration get it; everything else keeps the generic one", () => {
    const dispatcher = new ToolDispatcher(emptyRegistry(), ["read", "spawn", "hub", "bash"]);
    expect(dispatcher.deadlineFor("read")).toBe(dispatcher.timeoutMs);
    expect(dispatcher.deadlineFor("spawn")).toBe(DEFAULT_TOOL_TIMEOUTS.spawn);
    expect(dispatcher.deadlineFor("spawn")).toBeGreaterThan(60 * 60_000);
    expect(dispatcher.deadlineFor("hub")).toBeGreaterThan(600_000);
    expect(dispatcher.deadlineFor("bash")).toBeGreaterThan(3_600_000);
  });

  test("a per-tool deadline is what actually bounds the call", async () => {
    const started: string[] = [];
    const dispatcher = new ToolDispatcher({
      definitions: () => [],
      execute: async (name, _input, context) => {
        started.push(name);
        return await new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
      },
    }, ["slow"], { timeoutMs: 60_000, toolTimeouts: { slow: 20 } });
    const [dispatched] = await dispatcher.dispatch(
      [{ type: "tool_use", id: "c1", name: "slow", input: {} }],
      { signal: new AbortController().signal, sessionId: "s", workspace: "/w" },
    );
    expect(started).toEqual(["slow"]);
    expect(dispatched!.result.isError).toBe(true);
    expect(String(dispatched!.result.content)).toContain("20ms deadline");
  });

  test("a steer-interrupted wait says nothing was lost, because nothing was", async () => {
    const steering = new SteerQueue();
    const dispatcher = new ToolDispatcher({
      definitions: () => [],
      execute: async (_name, _input, context) => await new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true })),
    }, ["spawn"], { timeoutMs: 60_000 });
    const dispatch = dispatcher.dispatch(
      [{ type: "tool_use", id: "c1", name: "spawn", input: {} }],
      { signal: new AbortController().signal, sessionId: "s", workspace: "/w", interrupter: steering },
    );
    steering.push("stop waiting");
    const [dispatched] = await dispatch;
    expect(dispatched!.result.isError).not.toBe(true);
    expect(String(dispatched!.result.content)).toContain("Wait interrupted");
    expect(String(dispatched!.result.content)).toContain("a child is still running");
    expect(dispatched!.result.metadata).toEqual({ interrupted: "steer" });
  });
});

function reliable(transport: ProviderTransport): ReliableProvider {
  return new ReliableProvider(transport, { maxAttempts: 1, sleep: async () => {}, random: () => 0 });
}

function scripted(scripts: ReadonlyArray<(request: ProviderRequest, context: TransportContext) => AsyncIterable<TransportEvent>>): ProviderTransport {
  let index = 0;
  return {
    apiType: "openai_responses",
    id: "asides-fixture",
    async *stream(request, context) {
      const script = scripts[index++];
      if (script === undefined) throw new Error(`Missing transport script ${index}`);
      yield* script(request, context);
    },
  };
}

function createStore(): TranscriptStore {
  const directory = mkdtempSync(join(tmpdir(), "lyra-asides-"));
  directories.push(directory);
  return TranscriptStore.create({ path: join(directory, "session.jsonl"), name: "fixture", origin: "/origin", workspace: "/workspace", provider: "fixture", model: "fixture-model", sessionId: "asides-session" });
}

function emptyRegistry(): ToolRegistry {
  return { definitions: () => [], execute: async (name) => { throw new Error(`Unexpected tool execution: ${name}`); } };
}

async function settle(generator: AsyncGenerator<AgentEvent, AgentTurnResult, void>): Promise<{ events: AgentEvent[]; result: AgentTurnResult }> {
  const events: AgentEvent[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}
