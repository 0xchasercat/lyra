import { describe, expect, test } from "bun:test";
import { ProviderFault } from "@lyra/provider";
import type { ContentBlock } from "@lyra/provider";
import type { TranscriptEntry } from "@lyra/session";
import { deriveContext } from "../src/context.ts";

const baseOptions = {
  model: "fixture-model",
  system: "stable",
  apiType: "openai_responses" as const,
  tools: [],
  contextWindow: 100_000,
};

describe("deriveContext", () => {
  test("repairs empty blocks, role adjacency, and thinking order without mutating transcript", () => {
    const entries = transcript([
      message("u1", "user", [{ type: "text", text: "one" }, { type: "text", text: "" }]),
      message("u2", "user", [{ type: "text", text: "two" }]),
      message("a1", "assistant", [
        { type: "text", text: "answer" },
        { type: "thinking", thinking: "private", signature: "sig" },
      ]),
    ]);
    const before = structuredClone(entries);

    const derived = deriveContext(entries, { ...baseOptions, apiType: "openai_completions" });

    expect(entries).toEqual(before);
    expect(derived.request.messages).toHaveLength(2);
    expect(derived.request.messages[0]).toMatchObject({ role: "user", content: [
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ] });
    expect(derived.request.messages[1]?.content.map((block) => block.type)).toEqual(["thinking", "text"]);
    expect(repairCodes(derived)).toEqual(expect.arrayContaining([
      "empty_content",
      "adjacent_role_merge",
      "thinking_reordered",
    ]));
    expect(derived.repairs.every((repair) => repair.tokenEstimate > 0)).toBe(true);
  });

  test("does not emit the same persisted repair on every subsequent turn", () => {
    const entries = transcript([
      message("u1", "user", [{ type: "text", text: "one" }]),
      message("u2", "user", [{ type: "text", text: "two" }]),
    ]);
    entries.push({
      id: "repair-1",
      parentId: "u2",
      timestamp: timestamp(3),
      type: "repair",
      requestId: "request-1",
      repairs: [{ code: "adjacent_role_merge", detail: "Merged adjacent user transcript entries u1 and u2", entryId: "u2" }],
    });
    const derived = deriveContext(entries, baseOptions);
    expect(derived.request.messages).toHaveLength(1);
    expect(derived.repairs).toEqual([]);
  });

  // Usage entries are bookkeeping the transcript carries for later analysis, not
  // conversation. Derivation must step over them, or every recorded turn would silently
  // change the prompt the model sees on the next one.
  test("ignores turn usage entries when deriving the request", () => {
    const withoutUsage = transcript([
      message("u1", "user", [{ type: "text", text: "ask" }]),
      message("a1", "assistant", [{ type: "text", text: "answer" }]),
    ]);
    const withUsage = transcript([
      message("u1", "user", [{ type: "text", text: "ask" }]),
      message("a1", "assistant", [{ type: "text", text: "answer" }]),
      { id: "usage-1", parentId: "placeholder", timestamp: timestamp(0), type: "usage", inputTokens: 1_200, outputTokens: 340, cacheReadTokens: 900, costMicroUsd: 4_100 },
    ]);

    const derived = deriveContext(withUsage, baseOptions);

    expect(derived.request).toEqual(deriveContext(withoutUsage, baseOptions).request);
    expect(derived.sourceEntryIds).not.toContain("usage-1");
    expect(derived.repairs).toEqual([]);
  });

  test("drops unsigned Anthropic thinking and exposes the exact loss", () => {
    const entries = transcript([message("a1", "assistant", [
      { type: "thinking", thinking: "unsigned" },
      { type: "text", text: "visible" },
    ])]);

    const derived = deriveContext(entries, { ...baseOptions, apiType: "anthropic_messages" });

    expect(derived.request.messages[0]?.content).toEqual([{ type: "text", text: "visible" }]);
    expect(repairCodes(derived)).toContain("thinking_signature_dropped");
  });

  test("preserves OpenAI reasoning items exactly and flags cross-provider loss", () => {
    const raw = {
      type: "reasoning",
      id: "r1",
      encrypted_content: "ciphertext",
      summary: [{ type: "summary_text", text: "checked invariants" }],
    };
    const entries = transcript([message("a1", "assistant", [
      { type: "reasoning", provider: "openai", raw },
      { type: "text", text: "done" },
    ])]);

    const openai = deriveContext(entries, baseOptions);
    const reasoning = openai.request.messages[0]?.content[0];
    expect(reasoning).toEqual({ type: "reasoning", provider: "openai", raw });
    expect(reasoning).not.toBe(entries[1] && entries[1].type === "message" ? entries[1].content[0] : undefined);

    const anthropic = deriveContext(entries, { ...baseOptions, apiType: "anthropic_messages" });
    expect(anthropic.request.messages[0]?.content).toEqual([{ type: "text", text: "done" }]);
    expect(repairCodes(anthropic)).toContain("provider_reasoning_dropped");
  });

  test("replaces malformed and oversized images with recoverable in-band markers", () => {
    const entries = transcript([message("u1", "user", [
      { type: "image", mediaType: "text/plain", data: "AQID" },
      { type: "image", mediaType: "image/png", data: "AQID" },
    ])]);

    const derived = deriveContext(entries, { ...baseOptions, imageByteLimit: 2 });

    expect(derived.request.messages[0]?.content).toEqual([
      expect.objectContaining({ type: "marker", reason: "image_dropped" }),
      expect.objectContaining({ type: "marker", reason: "image_dropped" }),
    ]);
    expect(repairCodes(derived).filter((code) => code === "image_dropped")).toHaveLength(2);
  });

  /**
   * A screenshot's only route into the context is a tool result, and §3.6 was checked on
   * top-level blocks only — so the one path a picture actually takes reached the provider
   * unvalidated, and an oversized one came back as a 400 instead of a marker.
   */
  test("applies the image limit to images carried inside a tool result", () => {
    const good = { type: "image" as const, mediaType: "image/png" as const, data: "AQIDBA==" };
    const entries = transcript([
      message("a1", "assistant", [{ type: "tool_use", id: "call-a", name: "read", input: {} }, { type: "tool_use", id: "call-b", name: "read", input: {} }]),
      message("u1", "user", [
        { type: "tool_result", toolUseId: "call-a", content: [{ type: "text", text: "shot" }, good] },
        { type: "tool_result", toolUseId: "call-b", content: [{ type: "image", mediaType: "image/png", data: "AQIDBAUGBwgJCgsM" }] },
      ]),
    ]);

    const derived = deriveContext(entries, { ...baseOptions, imageByteLimit: 8 });
    const results = derived.request.messages[1]?.content as Array<{ toolUseId: string; content: ContentBlock[] }>;

    // Under the limit it stays an image the model can actually see.
    expect(results[0]?.content).toEqual([{ type: "text", text: "shot" }, good]);
    // Over it, an in-band marker the model can read and act on.
    expect(results[1]?.content).toEqual([expect.objectContaining({ type: "marker", reason: "image_dropped" })]);
    expect(repairCodes(derived)).toContain("image_dropped");
  });

  test("drops orphan results and synthesizes every missing parallel result before user text", () => {
    const entries = transcript([
      message("a1", "assistant", [
        { type: "tool_use", id: "call-a", name: "read", input: { path: "a" } },
        { type: "tool_use", id: "call-b", name: "read", input: { path: "b" } },
      ]),
      message("u1", "user", [
        { type: "text", text: "continue" },
        { type: "tool_result", toolUseId: "orphan", content: "wrong" },
        { type: "tool_result", toolUseId: "call-a", content: "a-data" },
      ]),
    ]);

    const derived = deriveContext(entries, baseOptions);
    const user = derived.request.messages[1];

    expect(user?.content).toEqual([
      { type: "tool_result", toolUseId: "call-a", content: "a-data" },
      { type: "tool_result", toolUseId: "call-b", content: "interrupted", isError: true },
      { type: "text", text: "continue" },
    ]);
    expect(repairCodes(derived)).toEqual(expect.arrayContaining(["orphan_tool_result", "missing_tool_result"]));
  });

  test("synthesizes a user result turn when a tool call is the transcript tail", () => {
    const entries = transcript([message("a1", "assistant", [
      { type: "tool_use", id: "call-a", name: "read", input: {} },
    ])]);

    const derived = deriveContext(entries, baseOptions);

    expect(derived.request.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "call-a", content: "interrupted", isError: true }],
    });
  });

  test("applies the latest compaction boundary while retaining summary, kept tail, and new entries", () => {
    const items = [
      message("old-user", "user", [{ type: "text", text: "discard me" }]),
      message("old-assistant", "assistant", [{ type: "text", text: "old answer" }]),
      message("kept-user", "user", [{ type: "text", text: "verbatim tail" }]),
    ];
    const entries = transcript(items);
    const kept = entries.find((entry) => entry.id === "kept-user")!;
    entries.push({
      id: "boundary",
      parentId: kept.id,
      timestamp: timestamp(4),
      type: "boundary",
      kind: "compaction",
      firstKeptEntry: "kept-user",
      summary: "decisions from the old prefix",
      tokensBefore: 90,
      tokensAfter: 30,
    });
    entries.push({
      ...message("new-assistant", "assistant", [{ type: "text", text: "new answer" }]),
      parentId: "boundary",
      timestamp: timestamp(5),
    });

    const derived = deriveContext(entries, baseOptions);
    const serialized = JSON.stringify(derived.request.messages);

    expect(serialized).toContain("decisions from the old prefix");
    expect(serialized).toContain("verbatim tail");
    expect(serialized).toContain("new answer");
    expect(serialized).not.toContain("discard me");
    expect(derived.sourceEntryIds).toContain("boundary");
  });

  test("a clear boundary excludes all prior history without summarizing", () => {
    const entries = transcript([message("old", "user", [{ type: "text", text: "old" }])]);
    entries.push({
      id: "clear",
      parentId: "old",
      timestamp: timestamp(2),
      type: "boundary",
      kind: "clear",
      firstKeptEntry: null,
      summary: "",
      tokensBefore: 10,
      tokensAfter: 0,
    });
    entries.push({
      ...message("new", "user", [{ type: "text", text: "new" }]),
      parentId: "clear",
      timestamp: timestamp(3),
    });

    const derived = deriveContext(entries, baseOptions);

    expect(derived.request.messages).toEqual([{ id: "new", role: "user", content: [{ type: "text", text: "new" }] }]);
  });

  // §3.6's second invariant is about the derived *window*, not the transcript: whatever put
  // the tool result first — a compaction boundary, a rewind, a lineage that simply begins
  // there — the payload may not open with a result whose call is outside the window. A
  // provider that receives one answers `messages.0.content.0: unexpected 'tool_use_id' found
  // in 'tool_result' blocks` and the turn is lost.
  test("a window that begins with a tool result drops the orphan whatever put it first", () => {
    const entries = transcript([
      message("u1", "user", [{ type: "tool_result", toolUseId: "toolu_live", content: "exit_code: 0" }]),
      message("a1", "assistant", [{ type: "text", text: "the directory is empty" }]),
    ]);

    const derived = deriveContext(entries, baseOptions);

    expect(derived.request.messages[0]?.content.some((block) => block.type === "tool_result")).toBe(false);
    expect(repairCodes(derived)).toContain("orphan_tool_result");
    expect(leadsWithOrphanResult(derived)).toBe(false);
  });

  test("a compaction boundary landing between a tool call and its result drops the orphan", () => {
    const entries = transcript([
      message("old-user", "user", [{ type: "text", text: "list the files" }]),
      message("old-assistant", "assistant", [{ type: "tool_use", id: "toolu_live", name: "bash", input: { command: "ls" } }]),
      message("kept-result", "user", [{ type: "tool_result", toolUseId: "toolu_live", content: "exit_code: 0" }]),
    ]);
    entries.push({
      id: "boundary",
      parentId: "kept-result",
      timestamp: timestamp(4),
      type: "boundary",
      kind: "compaction",
      // The hostile boundary: the kept tail opens on the result, the call was summarized away.
      firstKeptEntry: "kept-result",
      summary: "ran ls in the workspace",
      tokensBefore: 90,
      tokensAfter: 30,
    });
    entries.push({
      ...message("new-user", "user", [{ type: "text", text: "continue" }]),
      parentId: "boundary",
      timestamp: timestamp(5),
    });

    const derived = deriveContext(entries, baseOptions);

    expect(JSON.stringify(derived.request.messages)).not.toContain("toolu_live");
    expect(JSON.stringify(derived.request.messages)).toContain("ran ls in the workspace");
    expect(repairCodes(derived)).toContain("orphan_tool_result");
    expect(leadsWithOrphanResult(derived)).toBe(false);
  });

  test("a rewind that lands between a tool call and its result drops the orphan", () => {
    // What a cancel-trim fork leaves behind: the lineage the next request derives from starts
    // after the assistant turn that opened the call.
    const entries = transcript([
      message("kept-result", "user", [{ type: "tool_result", toolUseId: "toolu_live", content: "exit_code: 0" }]),
      message("prompt", "user", [{ type: "text", text: "continue" }]),
    ]);

    const derived = deriveContext(entries, baseOptions);

    expect(derived.request.messages).toEqual([
      { id: "kept-result", role: "user", content: [{ type: "text", text: "continue" }] },
    ]);
    expect(repairCodes(derived)).toContain("orphan_tool_result");
    expect(leadsWithOrphanResult(derived)).toBe(false);
  });

  test("re-deriving the same hostile window for another provider drops the orphan every time", () => {
    const entries = transcript([
      message("u1", "user", [{ type: "tool_result", toolUseId: "toolu_live", content: "exit_code: 0" }]),
      message("a1", "assistant", [{ type: "text", text: "done" }]),
      message("u2", "user", [{ type: "text", text: "continue" }]),
    ]);

    for (const apiType of ["openai_completions", "openai_responses", "openai_websocket", "anthropic_messages"] as const) {
      const derived = deriveContext(entries, { ...baseOptions, apiType });
      expect(leadsWithOrphanResult(derived)).toBe(false);
      expect(repairCodes(derived)).toContain("orphan_tool_result");
    }
  });

  test("classifies a repaired payload that still exceeds the model window", () => {
    const entries = transcript([message("u1", "user", [{ type: "text", text: "x".repeat(1_000) }])]);

    expect(() => deriveContext(entries, { ...baseOptions, contextWindow: 10 })).toThrow(ProviderFault);
    try {
      deriveContext(entries, { ...baseOptions, contextWindow: 10 });
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderFault);
      expect((error as ProviderFault).classification).toBe("context_overflow");
      expect((error as ProviderFault).providerMessage).toContain("compact the transcript");
    }
  });
});

function transcript(items: TranscriptEntry[]): TranscriptEntry[] {
  const session: TranscriptEntry = {
    id: "session-entry",
    parentId: null,
    timestamp: timestamp(0),
    type: "session",
    sessionId: "session-id",
    name: "fixture",
    origin: "/origin",
    workspace: "/workspace",
    provider: "fixture",
    model: "fixture-model",
  };
  let parentId = session.id;
  const entries = [session];
  for (let index = 0; index < items.length; index += 1) {
    const item = structuredClone(items[index]!);
    item.parentId = parentId;
    item.timestamp = timestamp(index + 1);
    entries.push(item);
    parentId = item.id;
  }
  return entries;
}

function message(id: string, role: "user" | "assistant", content: ContentBlock[]): TranscriptEntry {
  return {
    id,
    parentId: "placeholder",
    timestamp: timestamp(0),
    type: "message",
    role,
    content,
    status: "complete",
  };
}

function timestamp(index: number): string {
  return new Date(Date.UTC(2026, 7, 5, 0, 0, index)).toISOString();
}

function repairCodes(derived: ReturnType<typeof deriveContext>): string[] {
  return derived.repairs.map((repair) => repair.code);
}

/** Whether any tool result in the derived window has no tool call ahead of it. */
function leadsWithOrphanResult(derived: ReturnType<typeof deriveContext>): boolean {
  const calls = new Set<string>();
  for (const message of derived.request.messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") calls.add(block.id);
      if (block.type === "tool_result" && !calls.has(block.toolUseId)) return true;
    }
  }
  return false;
}
