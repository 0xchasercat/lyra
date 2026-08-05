import { describe, expect, test } from "bun:test";
import type {
  NewTranscriptEntry,
  TranscriptEntry,
} from "@lyra/session";
import {
  Compactor,
  ProviderSummaryGenerator,
  type SummaryGenerator,
  type SummaryRequest,
} from "../src/compaction.ts";

class MemoryTranscript {
  readonly value: TranscriptEntry[];
  readonly active: TranscriptEntry[];

  constructor(entries: TranscriptEntry[], active = entries) {
    this.value = [...entries];
    this.active = [...active];
  }

  lineage(): readonly TranscriptEntry[] {
    return this.active;
  }

  entries(): readonly TranscriptEntry[] {
    return this.value;
  }

  append(entry: NewTranscriptEntry): TranscriptEntry {
    const complete = entry as TranscriptEntry;
    this.value.push(complete);
    this.active.push(complete);
    return complete;
  }
}

class FixedSummary implements SummaryGenerator {
  calls: SummaryRequest[] = [];

  constructor(readonly summary = "durable summary") {}

  async generate(request: SummaryRequest): Promise<string> {
    this.calls.push(request);
    return this.summary;
  }
}

const base = { timestamp: "2026-08-05T00:00:00.000Z" } as const;
const session = (id = "session"): TranscriptEntry => ({
  ...base,
  id,
  parentId: null,
  type: "session",
  sessionId: "s",
  name: "test",
  origin: "/origin",
  workspace: "/workspace",
  provider: "test",
  model: "model",
});
const message = (
  id: string,
  parentId: string,
  role: "user" | "assistant",
  text: string,
): TranscriptEntry => ({
  ...base,
  id,
  parentId,
  type: "message",
  role,
  status: "complete",
  content: [{ type: "text", text }],
});

function makeCompactor(transcript: MemoryTranscript, summaryGenerator: SummaryGenerator): Compactor {
  return new Compactor({
    transcript,
    summaryGenerator,
    contextWindow: 100,
    messageTail: 2,
    createId: () => "boundary",
    now: () => "2026-08-05T01:00:00.000Z",
    tokenEstimator: {
      entries: (entries) => entries.length * 10,
      text: (text) => text.length,
    },
  });
}

describe("Compactor", () => {
  test("does nothing below the default 80% threshold", async () => {
    const transcript = new MemoryTranscript([
      session(),
      message("u1", "session", "user", "old"),
      message("a1", "u1", "assistant", "reply"),
      message("u2", "a1", "user", "tail"),
      message("a2", "u2", "assistant", "tail reply"),
    ]);
    const summary = new FixedSummary();

    const result = await makeCompactor(transcript, summary).compact({ tokensBefore: 79 });

    expect(result).toEqual({ compacted: false, reason: "below_threshold", tokensBefore: 79 });
    expect(summary.calls).toHaveLength(0);
    expect(transcript.value).toHaveLength(5);
  });

  test("summarizes only the older prefix and preserves checkpoint and pending calls", async () => {
    const pendingCall: TranscriptEntry = {
      ...base,
      id: "pending-message",
      parentId: "a1",
      type: "message",
      role: "assistant",
      status: "complete",
      content: [{ type: "tool_use", id: "call-pending", name: "edit", input: { path: "a.ts" } }],
    };
    const checkpoint: TranscriptEntry = {
      ...base,
      id: "checkpoint",
      parentId: "pending-message",
      type: "checkpoint",
      plan: "finish compaction",
      openFiles: ["a.ts", "b.ts"],
      pendingToolCallIds: ["call-pending"],
      state: { phase: 2 },
    };
    const original = [
      session(),
      message("u1", "session", "user", "old request"),
      message("a1", "u1", "assistant", "old answer"),
      pendingCall,
      checkpoint,
      message("u2", "checkpoint", "user", "latest request"),
      message("a2", "u2", "assistant", "latest answer"),
    ];
    const transcript = new MemoryTranscript(original);
    const summary = new FixedSummary("summary");

    const result = await makeCompactor(transcript, summary).compact({ tokensBefore: 80 });

    expect(result.compacted).toBe(true);
    if (!result.compacted) throw new Error("expected compaction");
    expect(summary.calls).toHaveLength(1);
    expect(summary.calls[0]!.entries.map((entry) => entry.id)).toEqual(["u1", "a1"]);
    expect(summary.calls[0]!.latestCheckpoint).toBe(checkpoint);
    expect(result.boundary).toMatchObject({
      type: "boundary",
      kind: "compaction",
      firstKeptEntry: "pending-message",
      summary: "summary",
      tokensBefore: 80,
      tokensAfter: 47,
      parentId: "a2",
    });
    expect(result.keptEntryIds).toEqual(["pending-message", "checkpoint", "u2", "a2"]);
    expect(transcript.value.slice(0, -1)).toEqual(original);
    expect(transcript.value).toHaveLength(original.length + 1);
  });

  test("forced compaction bypasses threshold but not an empty prefix", async () => {
    const transcript = new MemoryTranscript([
      session(),
      message("u1", "session", "user", "one"),
      message("a1", "u1", "assistant", "two"),
    ]);
    const summary = new FixedSummary();

    const result = await makeCompactor(transcript, summary).compact({
      tokensBefore: 1,
      force: true,
    });

    expect(result).toEqual({ compacted: false, reason: "nothing_to_summarize", tokensBefore: 1 });
    expect(summary.calls).toHaveLength(0);
  });

  test("uses the active lineage rather than a detached physical branch", async () => {
    const active = [
      session(),
      message("u1", "session", "user", "old"),
      message("a1", "u1", "assistant", "answer"),
      message("u2", "a1", "user", "tail"),
      message("a2", "u2", "assistant", "tail answer"),
    ];
    const detached = message("detached", "session", "user", "other branch");
    const transcript = new MemoryTranscript([...active, detached], active);
    const summary = new FixedSummary();

    const result = await makeCompactor(transcript, summary).compact({ tokensBefore: 80 });

    expect(result.compacted).toBe(true);
    if (!result.compacted) throw new Error("expected compaction");
    expect(result.boundary.parentId).toBe("a2");
    expect(summary.calls[0]!.entries.some((entry) => entry.id === "detached")).toBe(false);
  });

  test("clear appends a hard boundary without summarization or transcript loss", () => {
    const original = [session(), message("u1", "session", "user", "discard from context")];
    const transcript = new MemoryTranscript(original);
    const summary = new FixedSummary();

    const result = makeCompactor(transcript, summary).clear(42);

    expect(result.boundary).toMatchObject({
      kind: "clear",
      firstKeptEntry: null,
      summary: "",
      tokensBefore: 42,
      tokensAfter: 0,
      parentId: "u1",
    });
    expect(summary.calls).toHaveLength(0);
    expect(transcript.value.slice(0, -1)).toEqual(original);
  });
});

describe("ProviderSummaryGenerator", () => {
  test("collects a provider-backed deterministic text summary", async () => {
    let seenModel: string | undefined;
    const generator = new ProviderSummaryGenerator({
      model: "summary-model",
      provider: {
        async *stream(request) {
          seenModel = request.model;
          yield { type: "text_delta", text: "stable " };
          yield { type: "text_delta", text: "summary" };
          yield {
            type: "complete",
            stopReason: "end_turn",
          };
        },
      },
    });

    const result = await generator.generate({
      entries: [session()],
      firstKeptEntry: "u1",
      tokensBefore: 90,
      targetTokens: 80,
    });

    expect(result).toBe("stable summary");
    expect(seenModel).toBe("summary-model");
  });
  test("restarts provider summary text when a retry resets partial output", async () => {
    const generator = new ProviderSummaryGenerator({
      model: "summary-model",
      provider: {
        async *stream() {
          yield { type: "text_delta", text: "discarded " };
          yield {
            type: "retry",
            attempt: 2,
            maxAttempts: 3,
            reason: "transient",
            delayMs: 0,
            resetsPartialOutput: true,
          };
          yield { type: "text_delta", text: "kept" };
          yield { type: "complete", stopReason: "end_turn" };
        },
      },
    });

    const result = await generator.generate({
      entries: [session()],
      firstKeptEntry: "u1",
      tokensBefore: 90,
      targetTokens: 80,
    });

    expect(result).toBe("kept");
  });

});
