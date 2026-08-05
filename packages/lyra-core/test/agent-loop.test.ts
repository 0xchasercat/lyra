import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyProviderError,
  ProviderFault,
  ReliableProvider,
  type ProviderRequest,
  type ProviderTransport,
  type ToolDefinition,
  type ToolUseBlock,
  type TransportContext,
  type TransportEvent,
} from "@lyra/provider";
import { TranscriptStore } from "@lyra/session";
import { AgentLoop } from "../src/agent-loop.ts";
import { LoopDetector } from "../src/loop-detection.ts";
import { ToolDispatcher } from "../src/tool-dispatch.ts";
import type {
  AgentEvent,
  AgentTurnResult,
  ToolExecutionResult,
  ToolRegistry,
} from "../src/types.ts";

type TransportScript = (
  request: ProviderRequest,
  context: TransportContext,
) => AsyncIterable<TransportEvent>;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("AgentLoop", () => {
  test("waits for a complete tool-use turn, runs parallel calls once, and persists results in call order", async () => {
    const store = createStore();
    const reachedCompletionGate = deferred<void>();
    const releaseCompletion = deferred<void>();
    const toolSettlements = new Map<string, ReturnType<typeof deferred<ToolExecutionResult>>>();
    const executions: string[] = [];
    let definitionsCalls = 0;

    const definitions: ToolDefinition[] = [toolDefinition("lookup")];
    const tools: ToolRegistry = {
      definitions() {
        definitionsCalls += 1;
        return definitions;
      },
      async execute(_name, _input, context) {
        executions.push(context.callId);
        const settlement = deferred<ToolExecutionResult>();
        toolSettlements.set(context.callId, settlement);
        return settlement.promise;
      },
    };

    const fixture = scriptedTransport([
      async function* () {
        yield { type: "tool_call_start", id: "call-a", name: "lookup" };
        yield { type: "tool_call_delta", id: "call-a", argumentsDelta: '{"key":"a"}' };
        yield { type: "tool_call_end", id: "call-a" };
        yield { type: "tool_call_start", id: "call-b", name: "lookup" };
        yield { type: "tool_call_delta", id: "call-b", argumentsDelta: '{"key":"b"}' };
        yield { type: "tool_call_end", id: "call-b" };
        reachedCompletionGate.resolve(undefined);
        await releaseCompletion.promise;
        yield { type: "complete", stopReason: "tool_use" };
      },
      async function* () {
        yield { type: "text_delta", text: "discard me" };
        throw classifyProviderError({ status: 503, message: "fixture reconnect" });
      },
      async function* () {
        yield { type: "thinking_delta", thinking: "checked" };
        yield { type: "thinking_signature", signature: "sig-" };
        yield { type: "thinking_signature", signature: "tail" };
        yield { type: "reasoning_item", item: { id: "reasoning-1", encrypted: "opaque" } };
        yield { type: "text_delta", text: "finished" };
        yield { type: "complete", stopReason: "end_turn" };
      },
    ]);
    const provider = reliable(fixture.transport);
    const options = {
      provider,
      store,
      tools,
      model: "fixture-model",
      system: "stable system",
      contextWindow: 32_000,
      workspace: "/workspace",
    };
    const loop = new AgentLoop(options);

    definitions[0]!.description = "mutated after construction";
    options.system = "mutated after construction";
    const pendingTurn = settleTurn(loop.runTurn("do both"));
    await reachedCompletionGate.promise;
    expect(executions).toEqual([]);

    releaseCompletion.resolve(undefined);
    await waitFor(() => executions.length === 2);
    expect(executions).toEqual(["call-a", "call-b"]);
    toolSettlements.get("call-b")!.resolve({ content: "result-b" });
    toolSettlements.get("call-a")!.resolve({ content: "result-a" });

    const outcome = await pendingTurn;
    expect(outcome.result.stopReason).toBe("end_turn");
    expect(definitionsCalls).toBe(1);
    expect(executions).toEqual(["call-a", "call-b"]);
    expect(outcome.events.filter((event) => event.type === "retry")).toEqual([
      expect.objectContaining({ resetsPartialOutput: true }),
    ]);
    expect(outcome.result.assistant.content).toEqual([
      { type: "thinking", thinking: "checked", signature: "sig-tail" },
      { type: "reasoning", provider: "openai", raw: { id: "reasoning-1", encrypted: "opaque" } },
      { type: "text", text: "finished" },
    ]);
    expect(JSON.stringify(outcome.result.assistant.content)).not.toContain("discard me");

    const turnMessages = outcome.result.entries.filter((entry) => entry.type === "message");
    expect(turnMessages).toHaveLength(4);
    expect(turnMessages[1]?.role).toBe("assistant");
    expect(turnMessages[2]?.content).toEqual([
      { type: "tool_result", toolUseId: "call-a", content: "result-a" },
      { type: "tool_result", toolUseId: "call-b", content: "result-b" },
    ]);
    expect(outcome.events.filter((event) => event.type === "tool_finished").map((event) =>
      event.type === "tool_finished" ? event.id : ""
    )).toEqual(["call-a", "call-b"]);

    expect(fixture.requests).toHaveLength(3);
    expect(fixture.requests[0]?.system).toBe("stable system");
    expect(fixture.requests[2]?.system).toBe("stable system");
    expect(fixture.requests[2]?.tools[0]?.description).toBe("Lookup a value");
    expect(toolResultIds(fixture.requests[2]!)).toEqual(["call-a", "call-b"]);
    store.close();
  });

  test("turns unknown tools, thrown failures, and deadlines into ordered actionable results", async () => {
    let executions = 0;
    const registry: ToolRegistry = {
      definitions: () => [toolDefinition("explode"), toolDefinition("hang")],
      async execute(name, _input, context) {
        executions += 1;
        if (name === "explode") throw new Error("invalid target path");
        await waitForAbort(context.signal);
      },
    };
    const dispatcher = new ToolDispatcher(registry, ["explode", "hang"], { timeoutMs: 5 });
    const results = await dispatcher.dispatch([
      toolCall("unknown", "one"),
      toolCall("explode", "two"),
      toolCall("hang", "three"),
    ], {
      signal: new AbortController().signal,
      sessionId: "session-1",
      workspace: "/workspace",
    });

    expect(executions).toBe(2);
    expect(results.map((item) => item.call.id)).toEqual(["one", "two", "three"]);
    expect(results.every((item) => item.result.isError)).toBe(true);
    expect(results[0]?.result.content).toContain('Unknown tool "unknown"');
    expect(results[1]?.result.content).toContain("invalid target path");
    expect(results[2]?.result.content).toContain("exceeded its 5ms deadline");
  });

  test("persists classified provider faults as error entries without fabricating assistant completion", async () => {
    const store = createStore();
    const fixture = scriptedTransport([async function* () {
      throw classifyProviderError({
        status: 429,
        code: "insufficient_quota",
        message: "credits exhausted; add funds",
      });
    }]);
    const loop = new AgentLoop({
      provider: reliable(fixture.transport),
      store,
      tools: emptyRegistry(),
      model: "fixture-model",
      system: "stable",
      contextWindow: 32_000,
      workspace: "/workspace",
    });

    await expect(settleTurn(loop.runTurn("start"))).rejects.toBeInstanceOf(ProviderFault);
    const entries = store.entries();
    expect(entries.filter((entry) => entry.type === "message" && entry.role === "assistant")).toEqual([]);
    expect(entries.at(-1)).toEqual(expect.objectContaining({
      type: "error",
      classification: "quota",
      message: "credits exhausted; add funds",
    }));
    store.close();
  });

  test("logs context repairs before the request that consumes them", async () => {
    const store = createStore();
    store.append({
      type: "message",
      role: "user",
      status: "complete",
      content: [{ type: "text", text: "old request" }],
    });
    store.append({
      type: "message",
      role: "assistant",
      status: "interrupted",
      content: [{ type: "tool_use", id: "orphaned-call", name: "read", input: { path: "x" } }],
    });

    const fixture = scriptedTransport([async function* () {
      yield { type: "text_delta", text: "resumed" };
      yield { type: "complete", stopReason: "end_turn" };
    }]);
    const loop = new AgentLoop({
      provider: reliable(fixture.transport),
      store,
      tools: emptyRegistry(),
      model: "fixture-model",
      system: "stable",
      contextWindow: 32_000,
      workspace: "/workspace",
    });

    const outcome = await settleTurn(loop.runTurn("continue"));
    const repairEvent = outcome.events.find((event) => event.type === "context_repaired");
    expect(repairEvent?.type).toBe("context_repaired");
    if (repairEvent?.type === "context_repaired") {
      expect(repairEvent.repairs.some((repair) => repair.code === "missing_tool_result")).toBe(true);
    }
    const repairEntry = outcome.result.entries.find((entry) => entry.type === "repair");
    expect(repairEntry?.type).toBe("repair");
    if (repairEntry?.type === "repair") {
      expect(repairEntry.repairs.some((repair) => repair.code === "missing_tool_result")).toBe(true);
    }
    expect(fixture.requests[0]?.messages.some((message) => message.content.some((block) =>
      block.type === "tool_result" && block.toolUseId === "orphaned-call"
    ))).toBe(true);
    store.close();
  });

  test("retains cancellation partials and resumes from the append-only transcript", async () => {
    const store = createStore();
    const partialSeen = deferred<void>();
    const fixture = scriptedTransport([async function* (_request, context) {
      yield { type: "text_delta", text: "partial answer" };
      partialSeen.resolve(undefined);
      await waitForAbort(context.signal);
    }]);
    const loop = new AgentLoop({
      provider: reliable(fixture.transport),
      store,
      tools: emptyRegistry(),
      model: "fixture-model",
      system: "stable",
      contextWindow: 32_000,
      workspace: "/workspace",
    });
    const cancellation = new AbortController();
    const pending = settleTurn(loop.runTurn("start", cancellation.signal));
    await partialSeen.promise;
    cancellation.abort(new DOMException("user pressed escape", "AbortError"));
    const cancelled = await pending;

    expect(cancelled.result.stopReason).toBe("cancelled");
    expect(cancelled.result.assistant.status).toBe("cancelled");
    expect(cancelled.result.assistant.content).toEqual([
      { type: "text", text: "partial answer" },
      expect.objectContaining({ type: "marker", reason: "cancelled" }),
    ]);
    const transcriptPath = store.descriptor.path;
    const cancelledId = cancelled.result.assistant.id;
    store.close();

    const reopened = TranscriptStore.open(transcriptPath);
    expect(reopened.entries().some((entry) => entry.id === cancelledId)).toBe(true);
    const resumedFixture = scriptedTransport([async function* () {
      yield { type: "text_delta", text: "after resume" };
      yield { type: "complete", stopReason: "end_turn" };
    }]);
    const resumedLoop = new AgentLoop({
      provider: reliable(resumedFixture.transport),
      store: reopened,
      tools: emptyRegistry(),
      model: "fixture-model",
      system: "stable",
      contextWindow: 32_000,
      workspace: "/workspace",
    });
    const resumed = await settleTurn(resumedLoop.runTurn("continue"));
    expect(resumed.result.stopReason).toBe("end_turn");
    expect(resumed.result.assistant.content).toEqual([{ type: "text", text: "after resume" }]);
    expect(reopened.lineage().some((entry) => entry.id === cancelledId)).toBe(true);
    reopened.close();
  });

  test("distinguishes deadline interruption, max-token truncation, and refusal terminal states", async () => {
    const deadlineStore = createStore();
    const deadlineFixture = scriptedTransport([async function* (_request, context) {
      yield { type: "text_delta", text: "deadline partial" };
      await waitForAbort(context.signal);
    }]);
    const deadlineLoop = new AgentLoop({
      provider: reliable(deadlineFixture.transport),
      store: deadlineStore,
      tools: emptyRegistry(),
      model: "fixture-model",
      system: "stable",
      contextWindow: 32_000,
      workspace: "/workspace",
      turnTimeoutMs: 5,
    });
    const interrupted = await settleTurn(deadlineLoop.runTurn("deadline"));
    expect(interrupted.result).toEqual(expect.objectContaining({ stopReason: "cancelled" }));
    expect(interrupted.result.assistant.status).toBe("interrupted");
    expect(interrupted.result.assistant.content.at(-1)).toEqual(
      expect.objectContaining({ type: "marker", reason: "interrupted" }),
    );
    deadlineStore.close();

    const terminalStore = createStore();
    const terminalFixture = scriptedTransport([
      async function* () {
        yield { type: "text_delta", text: "truncated" };
        yield { type: "complete", stopReason: "max_tokens" };
      },
      async function* () {
        yield { type: "text_delta", text: "provider refusal" };
        yield { type: "complete", stopReason: "refusal" };
      },
    ]);
    const terminalLoop = new AgentLoop({
      provider: reliable(terminalFixture.transport),
      store: terminalStore,
      tools: emptyRegistry(),
      model: "fixture-model",
      system: "stable",
      contextWindow: 32_000,
      workspace: "/workspace",
    });
    const maximum = await settleTurn(terminalLoop.runTurn("one"));
    expect(maximum.result.stopReason).toBe("max_tokens");
    expect(maximum.result.assistant.status).toBe("interrupted");
    expect(maximum.result.assistant.content.at(-1)).toEqual(
      expect.objectContaining({ type: "marker", reason: "truncated" }),
    );
    const refusal = await settleTurn(terminalLoop.runTurn("two"));
    expect(refusal.result.stopReason).toBe("refusal");
    expect(refusal.result.assistant.status).toBe("complete");
    terminalStore.close();
  });
  test("counts text-only turns and exposes unattended no-progress hard stops", async () => {
    const store = createStore();
    const fixture = scriptedTransport([async function* () {
      yield { type: "text_delta", text: "no observable progress" };
      yield { type: "complete", stopReason: "end_turn" };
    }]);
    const loop = new AgentLoop({
      provider: reliable(fixture.transport),
      store,
      tools: emptyRegistry(),
      model: "fixture-model",
      system: "stable",
      contextWindow: 32_000,
      workspace: "/workspace",
      loopDetector: new LoopDetector({ noProgressTurns: 1, unattended: true }),
    });

    const outcome = await settleTurn(loop.runTurn("keep trying"));
    expect(outcome.result.stopReason).toBe("end_turn");
    expect(outcome.result.hardStopRequested).toBe(true);
    expect(outcome.events).toContainEqual(expect.objectContaining({
      type: "loop_warning",
      hardStopRequested: true,
      warning: { type: "no_progress", turns: 1 },
    }));
    store.close();
  });

});

function reliable(transport: ProviderTransport): ReliableProvider {
  return new ReliableProvider(transport, {
    maxAttempts: 3,
    sleep: async () => {},
    random: () => 0,
  });
}

function scriptedTransport(scripts: readonly TransportScript[]): {
  transport: ProviderTransport;
  requests: ProviderRequest[];
} {
  const requests: ProviderRequest[] = [];
  const transport: ProviderTransport = {
    apiType: "openai_responses",
    id: "agent-loop-fixture",
    async *stream(request, context) {
      const script = scripts[requests.length];
      requests.push(structuredClone(request));
      if (script === undefined) throw new Error(`Missing transport script ${requests.length}`);
      yield* script(request, context);
    },
  };
  return { transport, requests };
}

function createStore(): TranscriptStore {
  const directory = mkdtempSync(join(tmpdir(), "lyra-agent-loop-"));
  temporaryDirectories.push(directory);
  return TranscriptStore.create({
    path: join(directory, "session.jsonl"),
    name: "fixture",
    origin: "/origin",
    workspace: "/workspace",
    provider: "fixture",
    model: "fixture-model",
    sessionId: "fixture-session",
  });
}

function emptyRegistry(): ToolRegistry {
  return {
    definitions: () => [],
    async execute(name) {
      throw new Error(`Unexpected tool execution: ${name}`);
    },
  };
}

function toolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: "Lookup a value",
    inputSchema: { type: "object" },
  };
}

function toolCall(name: string, id: string): ToolUseBlock {
  return { type: "tool_use", id, name, input: {} };
}

function toolResultIds(request: ProviderRequest): string[] {
  return request.messages.flatMap((message) => message.content.flatMap((block) =>
    block.type === "tool_result" ? [block.toolUseId] : []
  ));
}

async function settleTurn(
  generator: AsyncGenerator<AgentEvent, AgentTurnResult, void>,
): Promise<{ events: AgentEvent[]; result: AgentTurnResult }> {
  const events: AgentEvent[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for fixture state");
}

async function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) throw signal.reason;
  return new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

