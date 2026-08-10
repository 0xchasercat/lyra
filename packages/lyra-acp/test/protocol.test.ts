import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@lyra/core";
import {
  ACP_COMMAND_RESULT_KINDS,
  ACP_COMPLETION_LIMIT_MAX,
  ACP_METHODS,
  AcpDaemon,
  ProtocolValidator,
  SessionUpdateEncoder,
  loadProtocolSchema,
  type SessionUpdate,
  type UsageContext,
} from "../src/index.ts";

const validator = new ProtocolValidator();
const SESSION = "session-conformance";

class Writer {
  readonly lines: string[] = [];
  write(data: string | Uint8Array): void { this.lines.push(typeof data === "string" ? data : new TextDecoder().decode(data)); }
  messages(): Array<Record<string, unknown>> {
    return this.lines.flatMap((line) => line.trim().split("\n").filter(Boolean).map((part) => JSON.parse(part) as Record<string, unknown>));
  }
}

function frame(update: SessionUpdate): Record<string, unknown> {
  return { jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update } };
}

function encoderWith(usage: UsageContext, clock = { value: 1_000 }): SessionUpdateEncoder {
  return new SessionUpdateEncoder({ sessionId: SESSION, usage: () => usage, now: () => (clock.value += 10) });
}

const BARE_USAGE: UsageContext = { sessionInputTokens: 120, sessionOutputTokens: 40 };

/** The full vocabulary a real turn produces, in the order the agent loop yields it. */
function scriptedTurn(): AgentEvent[] {
  return [
    { type: "context_measured", tokenEstimate: 4_200, sourceEntryCount: 7 },
    { type: "context_repaired", repairs: [{ code: "missing_tool_result", detail: "synthesised a missing result", entryId: "e-9", tokenEstimate: 12 }] },
    { type: "thinking_delta", thinking: "weigh" },
    { type: "thinking_delta", thinking: "ing" },
    { type: "thinking_signature", signature: "sig-1" },
    { type: "text_delta", text: "Reading " },
    { type: "text_delta", text: "the file." },
    { type: "tool_call_start", id: "call-1", name: "read" },
    { type: "tool_call_delta", id: "call-1", argumentsDelta: "{\"path\":" },
    { type: "tool_call_delta", id: "call-1", argumentsDelta: "\"src/auth.ts\"}" },
    { type: "tool_call_end", id: "call-1" },
    { type: "usage", usage: { inputTokens: 90, outputTokens: 30, cacheReadTokens: 64 } },
    { type: "complete", stopReason: "tool_use" },
    { type: "tool_started", id: "call-1", name: "read", input: { path: "src/auth.ts" } },
    { type: "tool_finished", id: "call-1", name: "read", result: { content: "export function auth() {}\nmore", progress: { filesRead: ["src/auth.ts"] } } },
    { type: "steered", entryId: "e-42", text: "use the session helper instead", at: "tool_boundary" },
    {
      type: "retry",
      attempt: 2,
      maxAttempts: 8,
      reason: "transient: upstream 503",
      classification: "transient",
      providerMessage: "upstream 503",
      delayMs: 4_000,
      retryAtMs: 1_700_000_000_000,
      resetsPartialOutput: true,
    },
    { type: "transport_fallback", from: "openai_websocket", to: "openai_completions", reason: "handshake refused", resetsPartialOutput: false },
    { type: "compacted", boundaryId: "e-77", tokensBefore: 180_000, tokensAfter: 42_000, firstKeptEntry: "e-51" },
    { type: "loop_warning", warning: { type: "no_progress", turns: 3 }, hardStopRequested: false },
    { type: "reasoning_item", item: { id: "reasoning-1", encrypted: "opaque" } },
    { type: "text_delta", text: "Done." },
    { type: "complete", stopReason: "end_turn" },
  ];
}

function runScript(encoder: SessionUpdateEncoder, events: readonly AgentEvent[]): SessionUpdate[] {
  return events.flatMap((event) => encoder.encode(event));
}

describe("ACP protocol schema", () => {
  test("the schema file is the method table: every routed method is declared and vice versa", () => {
    const declared = new Set(validator.declaredMethods());
    // initialize is answered by the daemon itself rather than by a handler, so it is
    // declared in the schema but absent from the handler-routing table.
    expect(declared.has("initialize")).toBe(true);
    declared.delete("initialize");
    expect([...declared].sort()).toEqual([...ACP_METHODS].sort());
  });

  test("the update union is discriminated: one tag selects exactly one variant", () => {
    const tags = validator.declaredUpdates();
    // A duplicated tag would make client-side dispatch ambiguous.
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags).toContain("delta");
    expect(tags).toContain("turn_resume");
    expect(tags).toContain("tool_call_end");
    // An unknown tag matches nothing rather than falling through to a permissive variant.
    expect(validator.validate({ sessionUpdate: "invented" }, "#/$defs/update").join("; "))
      .toContain("matches none of the");
  });

  test("the schema uses only keywords the validator implements", () => {
    const supported = new Set([
      "$schema", "$id", "$ref", "$comment", "$defs", "title", "description", "deprecated",
      "type", "const", "enum", "required", "properties", "additionalProperties", "items",
      "oneOf", "anyOf", "allOf", "minLength", "maxLength", "pattern", "minimum", "maximum",
      "minItems", "maxItems",
    ]);
    const unsupported = new Set<string>();
    const walk = (node: unknown, inMap: boolean): void => {
      if (Array.isArray(node)) { for (const item of node) walk(item, false); return; }
      if (node === null || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        // `properties`, `$defs` and the request maps hold arbitrary names as keys.
        const isNameMap = key === "properties" || key === "$defs" || key === "requests" || key === "clientRequests";
        if (!inMap && !supported.has(key) && !isNameMap) unsupported.add(key);
        walk(value, isNameMap);
      }
    };
    walk(loadProtocolSchema(), false);
    expect([...unsupported].sort()).toEqual(["params", "result"]);
  });

  test("an undeclared field is a validation failure, not a silent pass", () => {
    const drifted = { sessionUpdate: "delta", messageId: "m", partId: "p", field: "text", delta: "hi", colour: "red" };
    expect(validator.validate(drifted, "#/$defs/update").join("; ")).toContain("colour is not declared");
    // And a wrong-typed declared field fails too.
    expect(validator.validate({ sessionUpdate: "compaction", boundaryId: "b", tokensBefore: "lots", tokensAfter: 1, firstKeptEntry: null }, "#/$defs/update").join("; "))
      .toContain("tokensBefore");
  });
});

describe("session update encoder conformance", () => {
  test("a scripted session produces the full vocabulary in order and every frame validates", () => {
    const encoder = encoderWith(BARE_USAGE);
    const updates = [
      ...encoder.beginTurn("user"),
      ...runScript(encoder, scriptedTurn()),
      ...encoder.endTurn({ status: "completed", stopReason: "end_turn", partialRetained: true }),
    ];

    for (const update of updates) validator.assertNotification(frame(update));

    const tags = updates.map((update) => update.sessionUpdate);
    expect(tags[0]).toBe("turn_start");
    expect(tags.at(-1)).toBe("turn_end");
    for (const required of [
      "turn_start", "context", "context_repair", "turn_resume", "message_start", "part_start",
      "delta", "part_end", "tool_call_start", "tool_call_update", "tool_call_end", "message_end",
      "usage", "steer", "retry", "transport_fallback", "compaction", "loop_warning",
      "reasoning_item", "turn_end",
    ]) {
      expect(tags).toContain(required);
    }
    // Ordering invariants a client's state machine relies on.
    expect(tags.indexOf("message_start")).toBeLessThan(tags.indexOf("delta"));
    expect(tags.indexOf("part_start")).toBeLessThan(tags.indexOf("delta"));
    expect(tags.indexOf("tool_call_start")).toBeLessThan(tags.indexOf("tool_call_update"));
    expect(tags.indexOf("tool_call_update")).toBeLessThan(tags.indexOf("tool_call_end"));
  });

  test("streaming is semantic deltas: each event ships only its own chunk, addressed by part and field", () => {
    const encoder = encoderWith(BARE_USAGE);
    encoder.beginTurn("user");
    const updates = runScript(encoder, [
      { type: "text_delta", text: "one " },
      { type: "text_delta", text: "two " },
      { type: "text_delta", text: "three" },
    ]);
    const deltas = updates.filter((update) => update.sessionUpdate === "delta");
    expect(deltas.map((delta) => (delta as { delta: string }).delta)).toEqual(["one ", "two ", "three"]);
    // One part, one message, one field: the client appends, it never re-lays-out.
    const parts = new Set(deltas.map((delta) => (delta as { partId: string }).partId));
    expect(parts.size).toBe(1);
    expect(new Set(deltas.map((delta) => (delta as { field: string }).field))).toEqual(new Set(["text"]));
    expect(updates.filter((update) => update.sessionUpdate === "message_start")).toHaveLength(1);
  });

  test("thinking, signature, and tool arguments stream on their own fields of their own parts", () => {
    const encoder = encoderWith(BARE_USAGE);
    encoder.beginTurn("user");
    const updates = runScript(encoder, [
      { type: "thinking_delta", thinking: "hmm" },
      { type: "thinking_signature", signature: "sig" },
      { type: "text_delta", text: "answer" },
      { type: "tool_call_start", id: "c1", name: "edit" },
      { type: "tool_call_delta", id: "c1", argumentsDelta: "{\"path\":\"a\"}" },
    ]);
    const byField = new Map(updates.filter((u) => u.sessionUpdate === "delta").map((u) => {
      const delta = u as { field: string; partId: string };
      return [delta.field, delta.partId];
    }));
    expect([...byField.keys()].sort()).toEqual(["arguments", "signature", "text", "thinking"]);
    // Signature belongs to the thinking part, not to the text part that followed it.
    expect(byField.get("signature")).toBe(byField.get("thinking"));
    expect(byField.get("text")).not.toBe(byField.get("thinking"));
    expect(byField.get("arguments")).not.toBe(byField.get("text"));
  });

  test("retry carries raw fields and its pause bracket is closed by an explicit turn_resume", () => {
    const encoder = encoderWith(BARE_USAGE);
    encoder.beginTurn("user");
    const updates = runScript(encoder, [
      {
        type: "retry",
        attempt: 3,
        maxAttempts: 8,
        reason: "quota: monthly limit reached",
        classification: "quota",
        providerMessage: "monthly limit reached",
        delayMs: 2_500,
        retryAtMs: 1_700_000_123_456,
        resetsPartialOutput: true,
      },
      { type: "text_delta", text: "resumed" },
    ]);
    const retry = updates.find((update) => update.sessionUpdate === "retry");
    expect(retry).toEqual({
      sessionUpdate: "retry",
      attempt: 3,
      maxAttempts: 8,
      classification: "quota",
      providerMessage: "monthly limit reached",
      delayMs: 2_500,
      retryAtMs: 1_700_000_123_456,
      resetsPartialOutput: true,
    });
    const resume = updates.find((update) => update.sessionUpdate === "turn_resume");
    expect(resume).toMatchObject({ sessionUpdate: "turn_resume", after: "retry" });
    expect(updates.indexOf(retry!)).toBeLessThan(updates.indexOf(resume!));
    // resetsPartialOutput restarts message identity so a client never appends to a part
    // whose content the retry discarded.
    const message = updates.find((update) => update.sessionUpdate === "message_start");
    expect(message).toBeDefined();
    expect(updates.indexOf(resume!)).toBeLessThan(updates.indexOf(message!));
  });

  test("a retry without raw fields degrades to splitting reason rather than inventing a classification", () => {
    const encoder = encoderWith(BARE_USAGE);
    encoder.beginTurn("user");
    const [retry] = runScript(encoder, [
      { type: "retry", attempt: 2, maxAttempts: 4, reason: "auth: token expired", delayMs: 0, resetsPartialOutput: false },
    ]);
    expect(retry).toMatchObject({ classification: "auth", providerMessage: "token expired" });
    validator.assertUpdate(retry);
  });

  test("every pause kind is bracketed and closed exactly once", () => {
    const encoder = encoderWith(BARE_USAGE);
    encoder.beginTurn("user");
    const updates = runScript(encoder, [
      { type: "compacted", boundaryId: "b1", tokensBefore: 10, tokensAfter: 4, firstKeptEntry: null },
      { type: "context_repaired", repairs: [{ code: "empty_content", detail: "dropped", entryId: "e1", tokenEstimate: 0 }] },
      { type: "steered", entryId: "e2", text: "also check the tests", at: "tool_boundary" },
      { type: "text_delta", text: "ok" },
    ]);
    const resumes = updates.filter((update) => update.sessionUpdate === "turn_resume").map((update) => (update as { after: string }).after);
    expect(resumes).toEqual(["compaction", "context_repair", "steer"]);
  });

  test("an expected transport fallback is silent, and an explicit one is not", () => {
    const expectedFallback = {
      type: "transport_fallback",
      from: "openai_websocket",
      to: "openai_responses",
      reason: "the provider rejected the Responses WebSocket connection",
      resetsPartialOutput: true,
      expected: true,
    } as const satisfies AgentEvent;

    const silent = encoderWith(BARE_USAGE);
    silent.beginTurn("user");
    const quiet = runScript(silent, [expectedFallback, { type: "text_delta", text: "ok" }]);
    // Nothing about the fallback reaches the client, and no pause is opened that a later
    // event would have to resume from.
    expect(quiet.filter((update) => update.sessionUpdate === "transport_fallback")).toEqual([]);
    expect(quiet.filter((update) => update.sessionUpdate === "turn_resume")).toEqual([]);
    expect(quiet.map((update) => update.sessionUpdate)).toEqual(["message_start", "part_start", "delta"]);

    const loud = encoderWith(BARE_USAGE);
    loud.beginTurn("user");
    const announced = runScript(loud, [
      { ...expectedFallback, expected: false },
      { type: "text_delta", text: "ok" },
    ]);
    expect(announced.filter((update) => update.sessionUpdate === "transport_fallback")).toHaveLength(1);
    expect(announced.filter((update) => update.sessionUpdate === "turn_resume")).toHaveLength(1);
  });

  test("an expected transport fallback still resets the partial output a client is rendering", () => {
    const encoder = encoderWith(BARE_USAGE);
    encoder.beginTurn("user");
    const updates = runScript(encoder, [
      { type: "text_delta", text: "half a sentence" },
      {
        type: "transport_fallback",
        from: "openai_websocket",
        to: "openai_responses",
        reason: "no socket here",
        resetsPartialOutput: true,
        expected: true,
      },
      { type: "text_delta", text: "the whole answer" },
    ]);
    const starts = updates.filter((update) => update.sessionUpdate === "message_start");
    expect(starts).toHaveLength(2);
    const deltas = updates.filter((update) => update.sessionUpdate === "delta") as Array<{ messageId: string }>;
    expect(deltas[0]?.messageId).not.toBe(deltas[1]?.messageId);
  });

  test("the compaction boundary ships tokens before/after and the first kept entry", () => {
    const encoder = encoderWith(BARE_USAGE);
    encoder.beginTurn("user");
    const [compaction] = runScript(encoder, [
      { type: "compacted", boundaryId: "b-9", tokensBefore: 180_000, tokensAfter: 42_000, firstKeptEntry: "e-51" },
    ]);
    expect(compaction).toEqual({
      sessionUpdate: "compaction",
      boundaryId: "b-9",
      tokensBefore: 180_000,
      tokensAfter: 42_000,
      firstKeptEntry: "e-51",
    });
    validator.assertUpdate(compaction);
    // A cleared context keeps the null, which is meaningful: nothing survived.
    const [cleared] = runScript(encoder, [
      { type: "compacted", boundaryId: "b-10", tokensBefore: 5, tokensAfter: 0, firstKeptEntry: null },
    ]);
    validator.assertUpdate(cleared);
  });

  test("tool lifecycle reports status, duration, summaries, and steer interruption", () => {
    const clock = { value: 0 };
    const encoder = encoderWith(BARE_USAGE, clock);
    encoder.beginTurn("user");
    const updates = runScript(encoder, [
      { type: "tool_started", id: "t1", name: "bash", input: { command: "bun test" } },
      { type: "tool_finished", id: "t1", name: "bash", result: { content: "3 pass", progress: { commandExitCode: 0 } } },
      { type: "tool_started", id: "t2", name: "edit", input: { path: "src/a.ts" } },
      { type: "tool_finished", id: "t2", name: "edit", result: { content: "no match", isError: true } },
      { type: "tool_started", id: "t3", name: "hub", input: { op: "wait" } },
      { type: "tool_finished", id: "t3", name: "hub", result: { content: "Wait interrupted: the user sent a message.", metadata: { interrupted: "steer" } } },
      { type: "tool_started", id: "t4", name: "git", input: { op: "apply" } },
      { type: "tool_finished", id: "t4", name: "git", result: { content: "refused", metadata: { denied: true } } },
    ]);
    const ends = updates.filter((update) => update.sessionUpdate === "tool_call_end") as Array<Record<string, unknown>>;
    expect(ends.map((end) => end.status)).toEqual(["ok", "error", "ok", "denied"]);
    expect(ends[0]).toMatchObject({ tool: "bash", resultSummary: "3 pass", progress: { commandExitCode: 0 } });
    expect(ends[2]).toMatchObject({ interrupted: true });
    expect(ends.every((end) => typeof end.durationMs === "number" && (end.durationMs as number) >= 0)).toBe(true);
    const starts = updates.filter((update) => update.sessionUpdate === "tool_call_update") as Array<Record<string, unknown>>;
    expect(starts[0]).toMatchObject({ status: "running", tool: "bash", argsSummary: "bun test" });
    for (const update of updates) validator.assertUpdate(update);
  });

  test("a tool call the provider never streamed still gets a minted, opened, and closed part", () => {
    const encoder = encoderWith(BARE_USAGE);
    encoder.beginTurn("user");
    const updates = runScript(encoder, [
      { type: "tool_started", id: "t1", name: "bash", input: { command: "bun test" } },
      { type: "tool_finished", id: "t1", name: "bash", result: { content: "3 pass" } },
    ]);
    const tags = updates.map((update) => update.sessionUpdate);
    expect(tags).toEqual(["message_start", "part_start", "tool_call_start", "tool_call_update", "part_end", "tool_call_end"]);

    const start = updates[2] as Record<string, unknown>;
    const partStart = updates[1] as Record<string, unknown>;
    const partEnd = updates[4] as Record<string, unknown>;
    // The encoder, not the client, owns identity: `messageId`/`partId` are always on the
    // wire, and they address a part that was really opened and really closed.
    expect(typeof start.messageId).toBe("string");
    expect(typeof start.partId).toBe("string");
    expect(partStart).toMatchObject({ kind: "tool_call", toolCallId: "t1", messageId: start.messageId, partId: start.partId });
    expect(partEnd).toMatchObject({ messageId: start.messageId, partId: start.partId });
    for (const update of updates) validator.assertUpdate(update);
  });

  test("every tool_call_start addresses a part, streamed or not", () => {
    const encoder = encoderWith(BARE_USAGE);
    encoder.beginTurn("user");
    const updates = runScript(encoder, [
      // Streamed: the part comes from the model's own tool_call_start.
      { type: "tool_call_start", id: "streamed", name: "read" },
      { type: "tool_call_delta", id: "streamed", argumentsDelta: "{}" },
      { type: "tool_call_end", id: "streamed" },
      { type: "tool_started", id: "streamed", name: "read", input: {} },
      { type: "tool_finished", id: "streamed", name: "read", result: { content: "ok" } },
      // Not streamed: the encoder mints one.
      { type: "tool_started", id: "minted", name: "bash", input: { command: "ls" } },
      { type: "tool_finished", id: "minted", name: "bash", result: { content: "ok" } },
    ]);
    const starts = updates.filter((update) => update.sessionUpdate === "tool_call_start") as Array<Record<string, unknown>>;
    expect(starts).toHaveLength(2);
    for (const start of starts) {
      expect(typeof start.messageId).toBe("string");
      expect(typeof start.partId).toBe("string");
    }
    for (const update of updates) validator.assertUpdate(update);
  });

  test("usage and context ship raw numbers, and omit cost or limit when unverified", () => {
    const bare = encoderWith(BARE_USAGE);
    bare.beginTurn("user");
    const [unverifiedUsage] = runScript(bare, [{ type: "usage", usage: { inputTokens: 90, outputTokens: 30 } }]);
    // The two scopes are separate objects, so "90" can never be read as a session total.
    expect(unverifiedUsage).toEqual({
      sessionUpdate: "usage",
      turn: { inputTokens: 90, outputTokens: 30 },
      session: { inputTokens: 120, outputTokens: 40 },
    });
    const [unverifiedContext] = runScript(bare, [{ type: "context_measured", tokenEstimate: 5_000, sourceEntryCount: 9 }]);
    expect(unverifiedContext).not.toHaveProperty("contextWindow");

    const known = encoderWith({ sessionInputTokens: 1, sessionOutputTokens: 2, costMicroUsd: 4_321, contextWindow: 200_000 });
    known.beginTurn("user");
    const [knownUsage] = runScript(known, [{ type: "usage", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } }]);
    expect(knownUsage).toMatchObject({ turn: { cacheReadTokens: 3, cacheWriteTokens: 4 }, session: { costMicroUsd: 4_321 } });
    const [knownContext] = runScript(known, [{ type: "context_measured", tokenEstimate: 5_000, sourceEntryCount: 9 }]);
    expect(knownContext).toMatchObject({ contextWindow: 200_000 });
    for (const update of [unverifiedUsage, unverifiedContext, knownUsage, knownContext]) validator.assertUpdate(update);
  });

  test("turn_end reports every terminal status and validates in each shape", () => {
    for (const status of ["completed", "cancelled", "truncated", "refusal", "error"] as const) {
      const encoder = encoderWith(BARE_USAGE);
      encoder.beginTurn("user");
      const updates = encoder.endTurn({
        status,
        partialRetained: status === "cancelled" || status === "truncated",
        ...(status === "cancelled" ? { promptTrimmed: true } : {}),
        ...(status === "error" ? { error: { classification: "bad_request" as const, message: "no such model", code: "model_not_found", status: 404 } } : {}),
      });
      const end = updates.at(-1) as Record<string, unknown>;
      expect(end.sessionUpdate).toBe("turn_end");
      expect(end.status).toBe(status);
      validator.assertUpdate(end);
    }
  });

  test("an unclosed pause and an open part are both closed by turn_end", () => {
    const encoder = encoderWith(BARE_USAGE);
    encoder.beginTurn("user");
    runScript(encoder, [{ type: "text_delta", text: "partial" }]);
    runScript(encoder, [{ type: "retry", attempt: 2, maxAttempts: 3, reason: "transient: boom", delayMs: 0, resetsPartialOutput: false }]);
    const closing = encoder.endTurn({ status: "cancelled", partialRetained: true }).map((update) => update.sessionUpdate);
    expect(closing).toEqual(["turn_resume", "part_end", "turn_end"]);
  });
});

describe("frames on the wire", () => {
  test("notifications written by the daemon validate against the schema file", async () => {
    const writer = new Writer();
    const daemon = new AcpDaemon({ handlers: {} });
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), writer);
    const encoder = encoderWith(BARE_USAGE);
    const updates = [...encoder.beginTurn("user"), ...runScript(encoder, scriptedTurn()), ...encoder.endTurn({ status: "completed", stopReason: "end_turn", partialRetained: true })];
    for (const update of updates) await daemon.notify("session/update", { sessionId: SESSION, update });
    await daemon.close();

    const initialize = writer.messages().find((message) => message.id === 1);
    validator.assert(initialize?.result, "#/$defs/requests/initialize/result", "initialize result");

    const notifications = writer.messages().filter((message) => message.method === "session/update");
    expect(notifications).toHaveLength(updates.length);
    for (const notification of notifications) validator.assertNotification(notification);
  });

  test("request params validate against their declared method schemas", () => {
    validator.assert({ prompt: "hello" }, "#/$defs/requests/session~1prompt/params", "session/prompt params");
    validator.assert({ prompt: "actually use fetch" }, "#/$defs/requests/session~1steer/params", "session/steer params");
    validator.assert({ rewoundToComposer: true }, "#/$defs/requests/session~1cancel/params", "session/cancel params");
    validator.assert({ cancelled: true, promptTrimmed: false }, "#/$defs/requests/session~1cancel/result", "session/cancel result");
    validator.assert({ delivery: "steered", pending: 2 }, "#/$defs/requests/session~1steer/result", "session/steer result");
    expect(validator.validate({}, "#/$defs/requests/session~1prompt/params")).toEqual(["$.prompt is required"]);
    expect(validator.validate({ prompt: "hi", extra: 1 }, "#/$defs/requests/session~1prompt/params").join("; ")).toContain("not declared");
  });

  test("the command surface is declared as data a popup can render", () => {
    validator.assert({}, "#/$defs/requests/session~1commands/params", "session/commands params");
    validator.assert({
      commands: [
        { name: "model", description: "List the active provider's models.", resultKind: "models" },
        { name: "copy", description: "Copy the last reply.", usage: "/copy [entryId]", resultKind: "report" },
      ],
    }, "#/$defs/requests/session~1commands/result", "session/commands result");
    // usage is optional, but a declared field with the wrong type or an undeclared one is not.
    expect(validator.validate({ commands: [{ name: "x", description: "d", resultKind: "report", shortcut: "^X" }] }, "#/$defs/commandsResult").join("; "))
      .toContain("shortcut is not declared");
    expect(validator.validate({ commands: [{ name: "x", description: "d", resultKind: "invented" }] }, "#/$defs/commandsResult").join("; "))
      .toContain("resultKind");
  });

  test("every declared result kind names a real result shape, and the TS enum is the same list", () => {
    const kinds = validator.resolve("#/$defs/commandResultKind") as { enum: string[] };
    expect(kinds.enum).toEqual([...ACP_COMMAND_RESULT_KINDS]);
    // The naming convention is the contract: resultKind K means output validates against
    // #/$defs/KResult. A kind without a shape would leave a client with nothing to render.
    for (const kind of kinds.enum) expect(validator.resolve(`#/$defs/${kind}Result`)).toBeDefined();
  });

  test("a command result names its own shape and carries either output or an error", () => {
    validator.assert({ command: "health", resultKind: "health", output: { turns: 0 } }, "#/$defs/commandResult", "command result");
    validator.assert({ command: "kill", resultKind: "report", error: "/kill requires an agent name." }, "#/$defs/commandResult", "command error");
    // An unparseable input has no command name, and still declares a renderable kind.
    validator.assert({ command: "", resultKind: "report", error: "Slash commands must begin with /." }, "#/$defs/commandResult", "unparsed command");
    expect(validator.validate({ command: "health" }, "#/$defs/commandResult")).toEqual(["$.resultKind is required"]);
    expect(validator.validate({ command: "health", resultKind: "health", stdout: "" }, "#/$defs/commandResult").join("; "))
      .toContain("stdout is not declared");
  });

  test("the enumerable command shapes are closed, so a drifted field fails instead of reaching a renderer", () => {
    validator.assert({ sessions: [{ sessionId: "s-1", name: "main", path: "/tmp/main.jsonl", active: true }] }, "#/$defs/sessionsResult", "sessions");
    validator.assert({ agents: [{ id: "a-1", workspace: "/tmp/w", status: "running", startedAt: 1_700_000_000_000 }] }, "#/$defs/agentsResult", "agents");
    validator.assert({ skills: [{ name: "review", description: "d", origin: "bundled", path: "/tmp/s.md" }] }, "#/$defs/skillsResult", "skills");
    validator.assert({ tools: [{ server: "draco", name: "search", description: "d" }] }, "#/$defs/mcpResult", "mcp");
    validator.assert({ report: "Git mode is now auto.", detail: { mode: "auto" } }, "#/$defs/reportResult", "report");
    expect(validator.validate({ agents: [{ id: "a", workspace: "/w", status: "sleeping", startedAt: 0 }] }, "#/$defs/agentsResult").join("; "))
      .toContain("status");
    expect(validator.validate({ skills: [{ name: "n", description: "d", origin: "bundled", path: "/p", size: 12 }] }, "#/$defs/skillsResult").join("; "))
      .toContain("size is not declared");
    // report is the one open shape: free-form output has no declared structure to close.
    validator.assert({ report: "done", commit: "abc123" }, "#/$defs/reportResult", "open report");
  });

  test("completion asks for a kind and a query, and answers with a ranked, bounded list", () => {
    validator.assert({ sessionId: SESSION, kind: "file", query: "auth" }, "#/$defs/requests/session~1complete/params", "complete params");
    validator.assert({ sessionId: SESSION, kind: "file", query: "", limit: ACP_COMPLETION_LIMIT_MAX }, "#/$defs/requests/session~1complete/params", "complete params");
    // An empty query is a real request ("show me the default ranking"), so query is
    // required-but-possibly-empty rather than optional.
    expect(validator.validate({ sessionId: SESSION, kind: "file" }, "#/$defs/requests/session~1complete/params")).toEqual(["$.query is required"]);
    expect(validator.validate({ sessionId: SESSION, kind: "file", query: "a", limit: ACP_COMPLETION_LIMIT_MAX + 1 }, "#/$defs/requests/session~1complete/params").join("; "))
      .toContain("at most 50");
    expect(validator.validate({ sessionId: SESSION, kind: "file", query: "a", limit: 0 }, "#/$defs/requests/session~1complete/params").join("; "))
      .toContain("at least 1");

    validator.assert({ items: [{ value: "src/auth.ts", label: "auth.ts", detail: "src" }], truncated: true }, "#/$defs/requests/session~1complete/result", "complete result");
    validator.assert({ items: [{ value: "README.md" }], truncated: false }, "#/$defs/completionResult", "bare item");
    // truncated is not optional: "there are more" and "that is all" must not look alike.
    expect(validator.validate({ items: [] }, "#/$defs/completionResult")).toEqual(["$.truncated is required"]);
    expect(validator.validate({ items: [{ value: "a", score: 0.9 }], truncated: false }, "#/$defs/completionResult").join("; "))
      .toContain("score is not declared");
  });

  test("the model surface is cross-provider, and `current` is a full provider/model reference", () => {
    validator.assert({}, "#/$defs/requests/session~1models/params", "session/models params");
    validator.assert({ refresh: true }, "#/$defs/requests/session~1models/params", "session/models refresh");
    validator.assert({
      current: "anthropic/claude-opus-5",
      providers: [
        { provider: "anthropic", models: [{ id: "claude-opus-5", contextWindow: 1_000_000, inputPricePerMillion: 5, outputPricePerMillion: 25 }] },
        { provider: "openai", models: [{ id: "gpt-5.6", ownedBy: "openai" }] },
        // A provider whose endpoint said nothing and declares nothing is still listed: it
        // exists, and hiding it would make "unreachable" look like "not configured".
        { provider: "local", models: [] },
      ],
      roles: { default: "anthropic/claude-opus-5", fast: "anthropic/claude-haiku-4-5" },
      refreshed: true,
    }, "#/$defs/requests/session~1models/result", "session/models result");
    // Nothing configured: no `current` at all, rather than an empty string that reads as a model.
    validator.assert({ providers: [] }, "#/$defs/modelsResult", "unconfigured model surface");

    // The old single-provider shape is rejected, not merely tolerated alongside the new one.
    expect(validator.validate({ provider: "openai", current: "gpt-5.6", models: [], refreshed: false }, "#/$defs/modelsResult").join("; "))
      .toContain("$.providers is required");
    expect(validator.validate({ providers: [{ provider: "openai" }] }, "#/$defs/modelsResult").join("; "))
      .toContain("models is required");
    expect(validator.validate({ providers: [], current: "" }, "#/$defs/modelsResult").join("; "))
      .toContain("at least 1 characters");
    // `/model` names this same shape, so a client renders one view for the command and the method.
    expect((validator.resolve("#/$defs/commandResultKind") as { enum: string[] }).enum).toContain("models");
  });

  test("selecting a model takes a bare id, a provider/model reference, or a role", () => {
    for (const model of ["gpt-5.6-luna", "anthropic/claude-opus-5", "@fast"]) {
      validator.assert({ model }, "#/$defs/requests/session~1select_model/params", `select ${model}`);
    }
    validator.assert({ provider: "anthropic", model: "claude-opus-5" }, "#/$defs/requests/session~1select_model/result", "select_model result");
    expect(validator.validate({ model: "" }, "#/$defs/requests/session~1select_model/params").join("; ")).toContain("at least 1 characters");
    expect(validator.validate({ model: "x", provider: "y" }, "#/$defs/requests/session~1select_model/params").join("; ")).toContain("provider is not declared");
  });

  test("provider/detect asks about a URL and answers with families rather than failing", () => {
    validator.assert({ baseUrl: "https://api.anthropic.com" }, "#/$defs/requests/provider~1detect/params", "detect params");
    validator.assert({ baseUrl: "https://api.openai.com/v1", apiKey: "sk-probe" }, "#/$defs/requests/provider~1detect/params", "detect params with credential");
    validator.assert({ apiTypes: ["openai_responses"], suggestedName: "openai", authRequired: true }, "#/$defs/requests/provider~1detect/result", "detect result");
    // An endpoint nothing could be learned from is a valid answer, not an error.
    validator.assert({ apiTypes: [] }, "#/$defs/detectProviderResult", "unreachable endpoint");
    validator.assert({ apiTypes: ["anthropic_messages"], suggestedName: "anthropic", authRequired: false }, "#/$defs/detectProviderResult", "anthropic endpoint");
    expect(validator.validate({}, "#/$defs/detectProviderResult")).toEqual(["$.apiTypes is required"]);
    // Only protocols a provider can be *configured* to speak: the websocket transport is
    // negotiated for a responses provider, never something detection could recommend.
    expect(validator.validate({ apiTypes: ["openai_websocket"] }, "#/$defs/detectProviderResult").join("; ")).toContain("must be one of");
    expect(validator.validate({ apiTypes: [], models: 3 }, "#/$defs/detectProviderResult").join("; ")).toContain("models is not declared");
    expect(validator.validate({}, "#/$defs/requests/provider~1detect/params")).toEqual(["$.baseUrl is required"]);
  });

  test("adding a provider reports what it discovered, and absent is not zero", () => {
    validator.assert({ ok: true, provider: "beta", model: "model-b", auth: "none", path: "/home/u/.lyra/providers.toml", modelsDiscovered: 12 }, "#/$defs/addProviderResult", "add with discovery");
    // Zero is a real measurement — the endpoint answered with an empty catalogue.
    validator.assert({ ok: true, provider: "beta", model: "model-b", auth: "env", path: "/p", modelsDiscovered: 0 }, "#/$defs/addProviderResult", "empty catalogue");
    // Absent is the other thing entirely: nothing could be asked, and the add still succeeded.
    validator.assert({ ok: true, provider: "beta", model: "model-b", auth: "keychain", path: "/p" }, "#/$defs/addProviderResult", "discovery unavailable");
    expect(validator.validate({ ok: true, provider: "b", model: "m", auth: "none", path: "/p", modelsDiscovered: -1 }, "#/$defs/addProviderResult").join("; ")).toContain("at least 0");
  });

  test("model/add declares a model for a configured provider and answers with what it declared", () => {
    validator.assert({ provider: "gateway", model: "internal-coder-v3" }, "#/$defs/requests/model~1add/params", "model/add params");
    validator.assert({ ok: true, provider: "gateway", model: "internal-coder-v3" }, "#/$defs/requests/model~1add/result", "model/add result");
    expect(validator.validate({ provider: "gateway" }, "#/$defs/requests/model~1add/params")).toEqual(["$.model is required"]);
    expect(validator.validate({ model: "m" }, "#/$defs/requests/model~1add/params")).toEqual(["$.provider is required"]);
    // It declares; it never creates a provider, so there is nowhere to smuggle one in.
    expect(validator.validate({ provider: "g", model: "m", baseUrl: "https://x" }, "#/$defs/requests/model~1add/params").join("; ")).toContain("baseUrl is not declared");
    expect(validator.validate({ ok: false, provider: "g", model: "m" }, "#/$defs/addModelResult").join("; ")).toContain("must equal true");
  });

  test("detection reports the base URL that answered, in canonical form", () => {
    validator.assert(
      { apiTypes: ["openai_responses"], suggestedName: "gateway", authRequired: true, normalizedBaseUrl: "https://host/api/v1" },
      "#/$defs/requests/provider~1detect/result",
      "detect result with a normalized base",
    );
    // It is a suggestion for the form, so it is optional — an unparseable URL normalizes to
    // nothing, and an answer of "I could not tell" must stay expressible.
    validator.assert({ apiTypes: [] }, "#/$defs/detectProviderResult", "nothing learned");
    expect(validator.validate({ apiTypes: [], normalizedBaseUrl: "" }, "#/$defs/detectProviderResult").join("; ")).toContain("at least 1 characters");
  });

  test("persist 'keep' is declared, and it is the edit case rather than a fifth storage location", () => {
    const persist = validator.resolve("#/$defs/providerPersist") as { enum: string[]; description: string };
    expect(persist.enum).toEqual(["keychain", "plaintext", "env", "none", "keep"]);
    // The description is the contract a client builds its form from: it has to say that the
    // credential is reused, not that it is absent.
    expect(persist.description).toContain("existing auth block");
    for (const value of persist.enum) {
      validator.assert({ provider: "gateway", baseUrl: "https://host/v1", apiType: "openai_completions", persist: value, ...(value === "keychain" || value === "plaintext" ? { apiKey: "sk-x" } : {}), ...(value === "env" ? { authEnvVar: "GATEWAY_KEY" } : {}) }, "#/$defs/requests/provider~1add/params", `add with persist ${value}`);
    }
    // An edit reuses whatever the provider had, including sources setup never creates.
    validator.assert({ ok: true, provider: "gateway", auth: "plugin", path: "/p" }, "#/$defs/addProviderResult", "kept plugin auth");
  });

  test("provider/get describes a provider without ever carrying its credential", () => {
    validator.assert({ provider: "gateway" }, "#/$defs/requests/provider~1get/params", "get params");
    validator.assert({
      provider: "gateway",
      baseUrl: "https://host/api/v1",
      apiType: "openai_completions",
      websocket: "off",
      authType: "keychain",
      authDetail: "dev.lyra.provider.gateway/operator",
      models: ["internal-coder-v3"],
      inUse: true,
    }, "#/$defs/requests/provider~1get/result", "get result");
    // `inUse` is required: a client that could not tell would offer a delete that is refused.
    expect(validator.validate({ provider: "g", baseUrl: "https://h/v1", apiType: "openai_completions", authType: "none", models: [] }, "#/$defs/getProviderResult")).toEqual(["$.inUse is required"]);
    // There is nowhere on this shape to put a secret, by construction.
    expect(validator.validate({ provider: "g", baseUrl: "https://h/v1", apiType: "openai_completions", authType: "static", models: [], inUse: false, apiKey: "sk-leak" }, "#/$defs/getProviderResult").join("; ")).toContain("apiKey is not declared");
    expect(validator.validate({ provider: "g", baseUrl: "https://h/v1", apiType: "openai_completions", authType: "bearer", models: [], inUse: false }, "#/$defs/getProviderResult").join("; ")).toContain("must be one of");
  });

  test("provider/remove reports what it deleted and what it left dangling", () => {
    validator.assert({ provider: "gateway" }, "#/$defs/requests/provider~1remove/params", "remove params");
    validator.assert({ provider: "gateway", removeCredential: true }, "#/$defs/requests/provider~1remove/params", "remove with credential");
    validator.assert({ ok: true, provider: "gateway", path: "/home/u/.lyra/providers.toml" }, "#/$defs/removeProviderResult", "plain removal");
    validator.assert({ ok: true, provider: "gateway", path: "/p", credentialRemoved: false, danglingRoles: ["default", "fast"] }, "#/$defs/removeProviderResult", "removal with leftovers");
    // False is a measurement ("there was no keychain entry"), so it must not be confusable
    // with absent ("nobody asked me to look").
    expect(validator.validate({ ok: true, provider: "g", path: "/p", credentialRemoved: "no" }, "#/$defs/removeProviderResult").join("; ")).toContain("must be boolean");
    expect(validator.validate({ ok: true, path: "/p" }, "#/$defs/removeProviderResult")).toEqual(["$.provider is required"]);
    // Removing is not a switch: there is no model or role to send with it.
    expect(validator.validate({ provider: "g", model: "m" }, "#/$defs/requests/provider~1remove/params").join("; ")).toContain("model is not declared");
  });

  test("the permission request is a declared bidirectional call", () => {
    validator.assert({
      sessionId: SESSION,
      kind: "git_auto_mode",
      title: "Enable automatic Git commits?",
      detail: "Auto mode lets Lyra stage and commit its own work.",
      options: [
        { optionId: "allow_always", label: "Enable auto mode", kind: "allow_always" },
        { optionId: "reject", label: "Keep manual control", kind: "reject" },
      ],
    }, "#/$defs/clientRequests/session~1request_permission/params", "permission params");
    validator.assert({ optionId: "reject" }, "#/$defs/clientRequests/session~1request_permission/result", "permission result");
  });
});
