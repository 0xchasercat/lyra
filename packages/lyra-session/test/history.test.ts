import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptHistory } from "../src/index.ts";

const temporaryDirectories: string[] = [];

function temporaryDatabase(nested = false): string {
  const directory = mkdtempSync(join(tmpdir(), "lyra-history-"));
  temporaryDirectories.push(directory);
  return nested ? join(directory, "deep", "history", "history.db") : join(directory, "history.db");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PromptHistory", () => {
  test("creates parent directories and returns deterministic ranked prompt matches", () => {
    const path = temporaryDatabase(true);
    const history = PromptHistory.open(path);
    const createdAt = "2026-08-05T00:00:00.000Z";
    history.add({
      sessionId: "session-b",
      entryId: "entry-b",
      prompt: "fix compiler error in parser",
      createdAt,
    });
    history.add({
      sessionId: "session-a",
      entryId: "entry-a",
      prompt: "fix compiler error in parser",
      createdAt,
    });
    history.add("session-c", "entry-c", "write the release notes", createdAt);

    expect(existsSync(path)).toBe(true);
    expect(history.search("compiler error").map((hit) => hit.entryId)).toEqual([
      "entry-a",
      "entry-b",
    ]);
    expect(history.search("compiler error")[0]).toMatchObject({
      sessionId: "session-a",
      entryId: "entry-a",
      prompt: "fix compiler error in parser",
      createdAt,
    });
    expect(Number.isFinite(history.search("compiler error")[0]!.rank)).toBe(true);
    history.close();
  });

  test("survives reopen and removal updates the full-text index", () => {
    const path = temporaryDatabase();
    const history = new PromptHistory(path);
    history.add("session-1", "entry-1", "investigate websocket reconnect");
    history.add("session-2", "entry-2", "websocket protocol documentation");
    history.close();

    const reopened = PromptHistory.open(path);
    expect(reopened.search("websocket").map((hit) => hit.entryId)).toEqual([
      "entry-2",
      "entry-1",
    ]);
    expect(reopened.remove("entry-1")).toBe(true);
    expect(reopened.remove("entry-1")).toBe(false);
    expect(reopened.search("websocket").map((hit) => hit.entryId)).toEqual(["entry-2"]);
    reopened.close();

    const afterRemoval = PromptHistory.open(path);
    expect(afterRemoval.search("reconnect")).toEqual([]);
    expect(afterRemoval.search("websocket").map((hit) => hit.entryId)).toEqual(["entry-2"]);
    afterRemoval.close();
  });

  test("removes a session and treats punctuation-heavy searches as plain terms", () => {
    const history = PromptHistory.open(temporaryDatabase());
    history.add("session-remove", "entry-1", "debug C++ parser: unexpected token");
    history.add("session-remove", "entry-2", "repair parser tokenization");
    history.add("session-keep", "entry-3", "parser reference");

    expect(history.search('parser: "unexpected')).toHaveLength(1);
    expect(history.removeSession("session-remove")).toBe(2);
    expect(history.search("parser").map((hit) => hit.entryId)).toEqual(["entry-3"]);
    history.close();
  });

  test("rejects duplicate transcript entry ids instead of silently replacing history", () => {
    const history = PromptHistory.open(temporaryDatabase());
    history.add("session-1", "entry", "original prompt");
    expect(() => history.add("session-2", "entry", "replacement prompt")).toThrow();
    expect(history.search("original").map((hit) => hit.sessionId)).toEqual(["session-1"]);
    expect(history.search("replacement")).toEqual([]);
    history.close();
  });
});
