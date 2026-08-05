import { describe, expect, test } from "bun:test";
import {
  canonicalToolArguments,
  LoopDetector,
} from "../src/loop-detection.ts";

describe("LoopDetector", () => {
  test("warns on the third canonical-equivalent consecutive tool call", () => {
    const detector = new LoopDetector();

    expect(detector.recordToolCall("read", { path: "a", offset: 1 }).warnings).toEqual([]);
    expect(detector.recordToolCall("read", { offset: 1, path: "a" }).warnings).toEqual([]);
    expect(detector.recordToolCall("read", { path: "a", offset: 1 }).warnings).toEqual([
      { type: "identical_tool_call", tool: "read", count: 3 },
    ]);

    expect(canonicalToolArguments({ z: [3, { b: 2, a: 1 }], a: true })).toBe(
      '{"a":true,"z":[3,{"a":1,"b":2}]}',
    );
  });

  test("a different tool or argument resets consecutive call detection", () => {
    const detector = new LoopDetector();
    detector.recordToolCall("read", { path: "a" });
    detector.recordToolCall("read", { path: "a" });
    detector.recordToolCall("read", { path: "b" });
    detector.recordToolCall("read", { path: "a" });

    expect(detector.recordToolCall("read", { path: "a" }).warnings).toEqual([]);
  });

  test("warns after ten completed turns without progress", () => {
    const detector = new LoopDetector();
    expect(detector.recordTurn({ filesRead: ["known.ts"] }).warnings).toEqual([]);
    for (let turn = 1; turn < 10; turn += 1) {
      expect(detector.recordTurn({ filesRead: ["known.ts"] }).warnings).toEqual([]);
    }

    expect(detector.recordTurn({ filesRead: ["known.ts"] }).warnings).toEqual([
      { type: "no_progress", turns: 10 },
    ]);
  });

  test("new reads, modifications, and novel exit codes independently reset no-progress", () => {
    const detector = new LoopDetector({ noProgressTurns: 2 });

    detector.recordTurn({});
    expect(detector.recordTurn({ filesRead: ["new.ts"] }).warnings).toEqual([]);
    detector.recordTurn({ filesRead: ["new.ts"] });
    expect(detector.recordTurn({ filesModified: [{ path: "new.ts" }] }).warnings).toEqual([]);
    detector.recordTurn({ commandExitCode: 0 });
    detector.recordTurn({ commandExitCode: 0 });
    expect(detector.recordTurn({ commandExitCode: 1 }).warnings).toEqual([]);
    expect(detector.recordTurn({ commandExitCode: 1 }).warnings).toEqual([]);
    expect(detector.recordTurn({ commandExitCode: 1 }).warnings).toEqual([
      { type: "no_progress", turns: 2 },
    ]);
  });

  test("warns when a file hash oscillates A to B to A after two edits", () => {
    const detector = new LoopDetector();

    expect(detector.recordFileEdit("src/a.ts", "A", "B").warnings).toEqual([]);
    expect(detector.recordFileEdit("src/a.ts", "B", "A").warnings).toEqual([
      { type: "oscillation", path: "src/a.ts", hash: "A" },
    ]);
  });

  test("only unattended no-progress asks the runner for a hard stop", () => {
    const detector = new LoopDetector({ unattended: true, noProgressTurns: 2 });

    detector.recordToolCall("read", { path: "a" });
    detector.recordToolCall("read", { path: "a" });
    expect(detector.recordToolCall("read", { path: "a" })).toMatchObject({
      warnings: [{ type: "identical_tool_call" }],
      hardStopRequested: false,
    });
    detector.recordFileEdit("a.ts", "A", "B");
    expect(detector.recordFileEdit("a.ts", "B", "A")).toMatchObject({
      warnings: [{ type: "oscillation" }],
      hardStopRequested: false,
    });
    expect(detector.recordTurn({}).hardStopRequested).toBe(false);
    expect(detector.recordTurn({})).toEqual({
      warnings: [{ type: "no_progress", turns: 2 }],
      hardStopRequested: true,
    });

    const attended = new LoopDetector({ noProgressTurns: 1 });
    expect(attended.recordTurn({})).toEqual({
      warnings: [{ type: "no_progress", turns: 1 }],
      hardStopRequested: false,
    });
  });
});
