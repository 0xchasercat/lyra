import { afterEach, describe, expect, test } from "bun:test";
import {
  SpawnCancelledError,
  SpawnContractError,
  SpawnManager,
  SpawnRequestError,
} from "../src/spawn.ts";
import type { SpawnExecutor, SpawnRequest } from "../src/spawn-types.ts";

const managers: SpawnManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
});

test("returns an async handle and waits for executor output", async () => {
  const reports: string[] = [];
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    executor: async (_request, context) => {
      context.report("started");
      return { ok: true };
    },
  }));
  manager.onReport(({ message }) => reports.push(message));

  const handle = manager.spawn({ task: "inspect the repository" });
  expect(handle.status).toBe("running");
  const result = await manager.wait(handle);
  expect(result).toMatchObject({ id: handle.id, output: { ok: true }, workspace: "/repo" });
  expect(manager.getHandle(handle.id)?.status).toBe("completed");
  expect(reports).toEqual(["started"]);
});

test("blocking spawn returns a full result", async () => {
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    defaultModel: "@fast",
    executor: async (request, context) => ({ task: request.task, model: context.model }),
  }));
  const result = await manager.spawn({ task: "summarize", blocking: true, label: "summary" });
  expect(result).toMatchObject({ output: { task: "summarize", model: "@fast" }, workspace: "/repo", model: "@fast", label: "summary" });
});

test("enforces depth and validates malformed requests", () => {
  const manager = track(new SpawnManager({ defaultWorkspace: "/repo", maxDepth: 2, executor: async () => "ok" }));
  expect(() => manager.spawn({ task: "", } as SpawnRequest)).toThrow(SpawnRequestError);
  expect(() => manager.spawn({ task: "too deep", depth: 3 })).toThrow(/maxDepth/);
  expect(() => manager.spawn({ task: "bad mode", schema_mode: "other" } as unknown as SpawnRequest)).toThrow(SpawnRequestError);

  const constrained = track(new SpawnManager({
    defaultWorkspace: "/repo",
    availableTools: ["read"],
    executor: async () => "ok",
  }));
  expect(() => constrained.spawn({ task: "unknown tool", tools: ["write"] })).toThrow(/not available/);
});

test("queues work at max concurrency and drains in order", async () => {
  const release: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    maxConcurrent: 1,
    executor: async (request) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
      return request.task;
    },
  }));

  const first = manager.spawn({ task: "first" });
  const second = manager.spawn({ task: "second" });
  expect(first.status).toBe("running");
  expect(second.status).toBe("queued");
  release.shift()?.();
  expect(await manager.wait(first)).toMatchObject({ output: "first" });
  await waitFor(() => second.status === "running");
  release.shift()?.();
  expect(await manager.wait(second)).toMatchObject({ output: "second" });
  expect(peak).toBe(1);
});

test("creates isolated workspaces and passes resolved context", async () => {
  const calls: Array<string | undefined> = [];
  const tasks: Array<string | undefined> = [];
  const released: string[] = [];
  let peer = "";
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    createWorkspace: async (name, task) => {
      calls.push(name);
      tasks.push(task);
      return { name: "copy", path: "/repo-copy" };
    },
    releaseWorkspace: async (name) => { released.push(name); },
    executor: async (_request, context) => { peer = context.id; return context.workspace; },
  }));

  const handle = manager.spawn({ task: "build" });
  const result = await manager.wait(handle);
  expect(calls).toEqual([undefined]);
  expect(handle.workspace).toBe("/repo-copy");
  expect(tasks).toEqual(["build"]);
  expect(result.workspace).toBe("/repo-copy");
  expect(result.output).toBe("/repo-copy");
  expect(released).toEqual(["copy"]);
  expect(peer).toBe("copy");
});

test("resolves an explicit existing workspace without releasing it", async () => {
  const released: string[] = [];
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    resolveWorkspace: async (name) => ({ name, path: `/repo/${name}` }),
    releaseWorkspace: async (name) => { released.push(name); },
    executor: async (_request, context) => context.workspace,
  }));
  const result = await manager.spawn({ task: "continue", workspace: "amber-arch", blocking: true });
  expect(result).toMatchObject({ workspace: "/repo/amber-arch", output: "/repo/amber-arch" });
  expect(released).toEqual([]);
});

test("strict schema rejects and permissive schema preserves output with diagnostics", async () => {
  const executor: SpawnExecutor = async () => ({ findings: "not-an-array" });
  const schema = { type: "object", required: ["findings"], properties: { findings: { type: "array" } } } as const;
  const manager = track(new SpawnManager({ defaultWorkspace: "/repo", executor }));

  const permissive = await manager.spawn({ task: "review", output_schema: schema, schema_mode: "permissive", blocking: true });
  expect(permissive.output).toEqual({ findings: "not-an-array" });
  expect((permissive as { metadata?: { schemaValid?: boolean } }).metadata?.schemaValid).toBe(false);

  await expect(manager.spawn({ task: "review", output_schema: schema, schema_mode: "strict", blocking: true })).rejects.toBeInstanceOf(SpawnContractError);
});

test("cancels queued and running jobs and closes the manager", async () => {
  let unblock!: () => void;
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    maxConcurrent: 1,
    executor: async (_request, context) => {
      await Promise.race([
        new Promise<void>((resolve) => { unblock = resolve; }),
        new Promise<never>((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true })),
      ]);
      return "done";
    },
  }));
  const running = manager.spawn({ task: "running" });
  const queued = manager.spawn({ task: "queued" });
  expect(manager.cancel(queued)).toBe(true);
  await expect(manager.wait(queued)).rejects.toBeInstanceOf(SpawnCancelledError);
  manager.close();
  await expect(manager.wait(running)).rejects.toBeInstanceOf(SpawnCancelledError);
  expect(() => manager.spawn({ task: "after close" })).toThrow(/closed/);
  unblock?.();
});

test("inherits model and tools from parent context", async () => {
  const seen: Array<{ model?: string; tools: readonly string[] }> = [];
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    availableTools: ["read", "write", "spawn"],
    defaultModel: "@default",
    executor: async (_request, context) => {
      seen.push({ model: context.model, tools: context.tools });
      return "ok";
    },
  }));

  await manager.spawn({ task: "child", blocking: true }, { depth: 1, model: "@parent", tools: ["read"] });
  expect(seen).toEqual([{ model: "@parent", tools: ["read"] }]);
  expect(() => manager.spawn({ task: "widen", tools: ["write"] }, { depth: 1, model: "@parent", tools: ["read"] })).toThrow(/parent/);
  await manager.spawn({ task: "depth cap", blocking: true }, { depth: 1, model: "@parent", tools: ["read", "spawn"] });
  expect(seen.at(-1)).toEqual({ model: "@parent", tools: ["read"] });
});

function track(manager: SpawnManager): SpawnManager {
  managers.push(manager);
  return manager;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await Bun.sleep(0);
  }
  throw new Error("condition did not become true");
}
