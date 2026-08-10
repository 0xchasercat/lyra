import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  TranscriptCorruptionError,
  TranscriptStore,
  type TranscriptCreateOptions,
  type TranscriptEntry,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

const baseOptions = (path: string): TranscriptCreateOptions => ({
  path,
  name: "behavior test",
  origin: "test",
  workspace: "/worktree",
  provider: "fixture",
  model: "fixture-model",
  sessionId: "session-test",
  entryId: "root",
  timestamp: "2026-08-05T00:00:00.000Z",
});

function temporaryPath(name = "session.jsonl"): string {
  const directory = mkdtempSync(join(tmpdir(), "lyra-session-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

function userEntry(text: string, id?: string, parentId?: string) {
  return {
    type: "message" as const,
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    status: "complete" as const,
    ...(id === undefined ? {} : { id }),
    ...(parentId === undefined ? {} : { parentId }),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TranscriptStore", () => {
  test("creates nested directories and keeps one human-readable JSON object per line", () => {
    const path = temporaryPath(join("nested", "sessions", "readable.jsonl"));
    const store = TranscriptStore.create(baseOptions(path));
    const appended = store.append(userEntry("show the transcript", "user-1"));
    store.close();

    const text = readFileSync(path, "utf8");
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => JSON.parse(line))).toBeTruthy();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "session", id: "root" });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      type: "message",
      id: appended.id,
      parentId: "root",
    });
  });

  test("preserves branches and restores the last persisted branch as head", () => {
    const path = temporaryPath();
    const store = TranscriptStore.create(baseOptions(path));
    const main = store.append(userEntry("main branch", "main"));
    store.fork("root");
    const branch = store.append(userEntry("alternate branch", "branch"));

    expect(store.entries().map((entry) => entry.id)).toEqual(["root", main.id, branch.id]);
    expect(store.lineage().map((entry) => entry.id)).toEqual(["root", branch.id]);
    expect(store.descriptor.headId).toBe(branch.id);
    store.close();

    const reopened = TranscriptStore.open(path);
    expect(reopened.head.id).toBe(branch.id);
    expect(reopened.lineage(main.id).map((entry) => entry.id)).toEqual(["root", main.id]);
    expect(reopened.entries().map((entry) => entry.id)).toEqual(["root", main.id, branch.id]);
    reopened.close();
  });

  test("persists classified provider or tool errors as ordinary transcript entries", () => {
    const path = temporaryPath();
    const store = TranscriptStore.create(baseOptions(path));
    const error = store.append({
      type: "error",
      classification: "provider_fault",
      message: "upstream request failed",
      code: "rate_limit",
      status: 429,
    });
    expect(error).toMatchObject({
      type: "error",
      parentId: "root",
      classification: "provider_fault",
      code: "rate_limit",
      status: 429,
    });
    store.close();
    const reopened = TranscriptStore.open(path);
    expect(reopened.head).toMatchObject({ id: error.id, type: "error" });
    reopened.close();
  });

  test("round-trips turn usage and keeps unmeasured counts absent rather than zero", () => {
    const path = temporaryPath();
    const store = TranscriptStore.create(baseOptions(path));
    const measured = store.append({ type: "usage", inputTokens: 1_200, outputTokens: 340, cacheReadTokens: 900, cacheWriteTokens: 128, costMicroUsd: 4_100 });
    const partial = store.append({ type: "usage", inputTokens: 50, outputTokens: 7 });
    store.close();

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(JSON.parse(lines[2]!)).not.toHaveProperty("cacheReadTokens");
    expect(JSON.parse(lines[2]!)).not.toHaveProperty("costMicroUsd");

    const reopened = TranscriptStore.open(path);
    expect(reopened.entries().filter((entry) => entry.type === "usage")).toEqual([measured, partial]);
    expect(reopened.head.id).toBe(partial.id);
    reopened.close();

    writeFileSync(path, `${readFileSync(path, "utf8").trimEnd().split("\n")[0]!}\n{"type":"usage","id":"bad","parentId":"root","timestamp":"2026-08-05T00:00:01.000Z","inputTokens":-1,"outputTokens":0}\n`);
    expect(() => TranscriptStore.open(path)).toThrow("usage token counts must be non-negative");
  });

  test("loads a transcript written before usage entries existed", () => {
    const path = temporaryPath();
    // A byte-for-byte pre-change transcript: no usage entry anywhere, and the head is the
    // assistant reply it always was. Adding an entry type must not strand these.
    writeFileSync(path, [
      '{"type":"session","id":"root","parentId":null,"timestamp":"2026-08-05T00:00:00.000Z","sessionId":"session-test","name":"legacy","origin":"test","workspace":"/worktree","provider":"fixture","model":"fixture-model"}',
      '{"type":"message","id":"ask","parentId":"root","timestamp":"2026-08-05T00:00:01.000Z","role":"user","content":[{"type":"text","text":"ask"}],"status":"complete"}',
      '{"type":"message","id":"reply","parentId":"ask","timestamp":"2026-08-05T00:00:02.000Z","role":"assistant","content":[{"type":"text","text":"reply"}],"status":"complete"}',
      "",
    ].join("\n"));
    const store = TranscriptStore.open(path);
    expect(store.lineage().map((entry) => entry.id)).toEqual(["root", "ask", "reply"]);
    const appended = store.append({ type: "usage", inputTokens: 10, outputTokens: 2 });
    expect(appended.parentId).toBe("reply");
    store.close();
    const reopened = TranscriptStore.open(path);
    expect(reopened.entries().map((entry) => entry.type)).toEqual(["session", "message", "message", "usage"]);
    reopened.close();
  });

  test("truncates only an invalid unterminated tail and preserves every prior entry", () => {
    const path = temporaryPath();
    const store = TranscriptStore.create(baseOptions(path));
    store.append(userEntry("durable", "durable"));
    store.close();
    const durableBytes = readFileSync(path).byteLength;
    appendFileSync(path, '{"type":"message","id":"torn"');

    const reopened = TranscriptStore.open(path);
    expect(reopened.entries().map((entry) => entry.id)).toEqual(["root", "durable"]);
    reopened.close();
    expect(readFileSync(path).byteLength).toBe(durableBytes);
  });

  test("retains a valid final object whose newline alone was torn", () => {
    const path = temporaryPath();
    const store = TranscriptStore.create(baseOptions(path));
    store.append(userEntry("complete object", "complete"));
    store.close();
    const withoutNewline = readFileSync(path).subarray(0, -1);
    writeFileSync(path, withoutNewline);

    const reopened = TranscriptStore.open(path);
    expect(reopened.entries().map((entry) => entry.id)).toEqual(["root", "complete"]);
    reopened.close();
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });

  test("rejects a graph-invalid JSON tail without truncating it", () => {
    const path = temporaryPath();
    const store = TranscriptStore.create(baseOptions(path));
    store.close();
    appendFileSync(
      path,
      JSON.stringify({
        ...userEntry("not a torn write", "orphan", "missing"),
        timestamp: "2026-08-05T00:00:01.000Z",
      }),
    );
    const corrupted = readFileSync(path);

    expect(() => TranscriptStore.open(path)).toThrow("unknown parent id");
    expect(readFileSync(path)).toEqual(corrupted);
  });

  test("rejects a forward parent reference even when the parent exists later", () => {
    const path = temporaryPath();
    const store = TranscriptStore.create(baseOptions(path));
    store.close();
    const child = {
      ...userEntry("child", "child", "future-parent"),
      timestamp: "2026-08-05T00:00:01.000Z",
    };
    const futureParent = {
      ...userEntry("future parent", "future-parent", "root"),
      timestamp: "2026-08-05T00:00:02.000Z",
    };
    appendFileSync(path, `${JSON.stringify(child)}\n${JSON.stringify(futureParent)}\n`);

    expect(() => TranscriptStore.open(path)).toThrow("must precede its child");
  });

  test("rejects complete middle corruption with its path and line without truncating", () => {
    const path = temporaryPath();
    const store = TranscriptStore.create(baseOptions(path));
    store.append(userEntry("first", "first"));
    store.append(userEntry("second", "second"));
    store.close();
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    const corrupted = `${lines[0]}\nnot-json\n${lines[2]}\n`;
    writeFileSync(path, corrupted);

    let error: unknown;
    try {
      TranscriptStore.open(path);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TranscriptCorruptionError);
    expect(String(error)).toContain(path);
    expect(String(error)).toContain("line 2");
    expect(readFileSync(path, "utf8")).toBe(corrupted);
  });

  test("rejects duplicate ids, missing parents, and parent cycles", () => {
    const path = temporaryPath();
    const root: TranscriptEntry = {
      type: "session",
      id: "root",
      parentId: null,
      timestamp: "2026-08-05T00:00:00.000Z",
      sessionId: "session-test",
      name: "test",
      origin: "test",
      workspace: "/worktree",
      provider: "fixture",
      model: "fixture-model",
    };
    const message = (id: string, parentId: string): TranscriptEntry => ({
      type: "message",
      id,
      parentId,
      timestamp: "2026-08-05T00:00:01.000Z",
      role: "user",
      content: [{ type: "text", text: id }],
      status: "complete",
    });
    const writeEntries = (entries: TranscriptEntry[]) => {
      writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    };

    writeEntries([root, message("root", "root")]);
    expect(() => TranscriptStore.open(path)).toThrow("duplicate entry id");

    writeEntries([root, message("orphan", "missing")]);
    expect(() => TranscriptStore.open(path)).toThrow("unknown parent id");

    writeEntries([root, message("a", "b"), message("b", "a")]);
    expect(() => TranscriptStore.open(path)).toThrow("parent cycle");
  });

  test("fork changes only the in-memory cursor until a new entry is appended", () => {
    const path = temporaryPath();
    const store = TranscriptStore.create(baseOptions(path));
    store.append(userEntry("first", "first"));
    const bytesBeforeFork = readFileSync(path);
    store.fork("root");
    expect(readFileSync(path)).toEqual(bytesBeforeFork);
    expect(store.head.id).toBe("root");
    expect(() => store.fork("unknown")).toThrow("unknown transcript entry");
    store.close();
  });
});
