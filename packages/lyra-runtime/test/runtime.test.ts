import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, RuntimeManager } from "../src/index.ts";
import type { RuntimeAdapters } from "../src/index.ts";

async function fixture() {
  const origin = await mkdtemp(join(tmpdir(), "lyra-runtime-"));
  const calls: Array<{ kind: string; value: unknown }> = [];
  const adapters: RuntimeAdapters = {
    async spawn(value) { calls.push({ kind: "spawn", value }); return { spawned: true }; },
    async exec(command, options) { calls.push({ kind: "exec", value: { command, options } }); return { exitCode: 0, stdout: "ok" }; },
    async tool(name, args) { calls.push({ kind: `tool.${name}`, value: args }); return { name }; },
    async irc(operation, args) { calls.push({ kind: `irc.${operation}`, value: args }); return { operation }; },
    async git(operation, args) { calls.push({ kind: `git.${operation}`, value: args }); return { operation }; },
    async workspace(operation, args) { calls.push({ kind: `workspace.${operation}`, value: args }); return { operation }; },
    report(message) { calls.push({ kind: "report", value: message }); },
  };
  return { origin, calls, manager: new RuntimeManager({ origin, session: "session-one", adapters, requestTimeoutMs: 1000, runTimeoutMs: 10_000 }) };
}

describe("JIT runtime", () => {
  test("runs a real lyra:runtime script and resumes from atomic checkpoint", async () => {
    const { origin, calls, manager } = await fixture();
    try {
      await manager.declare("orchestrate", `
        import { lyra } from "lyra:runtime";
        export default async function(input, context) {
          const previous = context.checkpoint?.step ?? 0;
          const exec = await lyra.exec("printf ok", { cwd: "." });
          await lyra.spawn({ task: "child" });
          await lyra.read({ path: "x" });
          await lyra.irc.publish({ channel: "results", data: input });
          await lyra.git.preview();
          await lyra.workspace.list();
          await lyra.report("visible report");
          await lyra.checkpoint({ step: previous + 1 });
          return { input, previous, exec };
        }
      `);
      const first = await manager.run("orchestrate", { batch: 1 });
      expect(first).toMatchObject({ ok: true, output: { input: { batch: 1 }, previous: 0, exec: { exitCode: 0, stdout: "ok" } }, checkpoint: { step: 1 }, exitCode: 0 });
      const second = await manager.run("orchestrate", { batch: 2 });
      expect(second).toMatchObject({ ok: true, output: { input: { batch: 2 }, previous: 1 }, checkpoint: { step: 2 } });
      expect(calls.map((call) => call.kind)).toEqual(["exec", "spawn", "tool.read", "irc.publish", "git.preview", "workspace.list", "report", "exec", "spawn", "tool.read", "irc.publish", "git.preview", "workspace.list", "report"]);
      const promoted = await manager.promote("orchestrate");
      expect(await readFile(promoted, "utf8")).toContain("lyra:runtime");
      expect((await manager.list()).map((record) => record.name)).toEqual(["orchestrate"]);
    } finally { await rm(origin, { recursive: true, force: true }); }
  }, 20_000);

  test("checkpoint store rejects malformed data and survives a new instance", async () => {
    const { origin } = await fixture();
    try {
      const first = new CheckpointStore(origin, "session-one");
      await first.save("task", { cursor: 7 });
      const second = new CheckpointStore(origin, "session-one");
      expect(await second.load("task")).toEqual({ cursor: 7 });
      await expect(first.save("task", { invalid: 1n })).rejects.toThrow("JSON-serializable");
      expect(await second.clear("task")).toBe(true);
      expect(await second.load("task")).toBeUndefined();
    } finally { await rm(origin, { recursive: true, force: true }); }
  });

  test("declaration validates persistent session names and source", async () => {
    const { origin, manager } = await fixture();
    try {
      await expect(manager.declare("Bad Name", "export default 1")).rejects.toThrow("must match");
      await expect(manager.declare("valid", "   ")).rejects.toThrow("non-empty");
      await expect(stat(join(origin, ".lyra", "runtime", "session-one", "Bad Name.ts"))).rejects.toThrow();
    } finally { await rm(origin, { recursive: true, force: true }); }
  });
});
