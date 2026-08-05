import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetricsStore, SoakRunner, parseLoopSpec } from "../src/index.ts";

describe("long-run soak harness", () => {
  test("simulates a 24-hour loop with no process or workspace leaks", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-soak-")); let clock = 0;
    try {
      const runner = new SoakRunner({ metrics: new MetricsStore(root), now: () => clock, cycle: async () => { clock += 3_600_000; return { progress: true, latencyMs: 10 }; }, processCount: () => 0, workspaceLeakCount: () => 0 });
      const result = await runner.run("keep repository healthy", parseLoopSpec("24h"));
      expect(result).toMatchObject({ cycles: 24, stopped: "complete", elapsedMs: 86_400_000, orphanedProcesses: 0, workspaceLeaks: 0 });
      expect(result.rssPeak).toBeGreaterThan(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("hard-stops an unattended no-progress loop after ten cycles", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-soak-"));
    try {
      const runner = new SoakRunner({ metrics: new MetricsStore(root), cycle: async () => ({ progress: false, latencyMs: 1 }), processCount: () => 0, workspaceLeakCount: () => 0 });
      const result = await runner.run("stalled goal", { kind: "count", count: 100 });
      expect(result).toMatchObject({ cycles: 10, stopped: "no_progress" });
      expect(parseLoopSpec('until "tests pass"')).toEqual({ kind: "until", condition: "tests pass", maxCycles: 10_000 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
