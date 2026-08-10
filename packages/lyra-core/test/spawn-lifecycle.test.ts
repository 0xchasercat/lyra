import { afterEach, expect, test } from "bun:test";
import { SpawnDeadlineError, SpawnManager, SpawnResolutionError, SpawnTimeoutError } from "../src/spawn.ts";
import type { SpawnLifecycleEvent } from "../src/spawn-types.ts";

/**
 * The lifecycle half of the delegation surface, against the session that produced it.
 *
 * A parent spawned a child non-blocking and then had no way to ask anything about it: no
 * status, no result, no cancel, and a blocking spawn that died at a generic deadline with
 * no diagnosis. Every test here is one of those dead ends.
 */

const managers: SpawnManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) void manager.close(); });
function track(manager: SpawnManager): SpawnManager { managers.push(manager); return manager; }

/** Poll until a predicate holds, so a test never depends on how many ticks a step takes. */
async function until<T>(read: () => T | undefined, label: string, budgetMs = 2_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("a running child reports what it is doing, not just that it exists", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    executor: async (_request, context) => {
      context.activity({ state: "awaiting_tool", tool: "bash", toolCall: true });
      context.activity({ text: "checking the build" });
      await gate;
      context.activity({ state: "running", filesModified: ["src/build.ts"] });
      return "built";
    },
  }));

  const handle = manager.spawn({ task: "build the project", label: "builder" });
  expect(handle.peer).toBe("builder");

  const busy = await until(() => { const status = manager.status("builder"); return status?.status === "awaiting_tool" ? status : undefined; }, "the child to enter a tool call");
  expect(busy).toMatchObject({ id: handle.id, peer: "builder", currentTool: "bash", toolCalls: 1, resultAvailable: false });
  expect(busy.partialOutput).toBe("checking the build");
  expect(busy.elapsedMs).toBeGreaterThanOrEqual(0);

  release();
  const result = await manager.wait(handle.id, 2_000);
  expect(result.filesModified).toEqual(["src/build.ts"]);
  const done = manager.status(handle.id)!;
  expect(done.status).toBe("completed");
  expect(done.resultAvailable).toBe(true);
  expect(done.currentTool).toBeUndefined();
});

test("a completed child stays collectable, by id and by peer name", async () => {
  const manager = track(new SpawnManager({ defaultWorkspace: "/repo", executor: async () => "answer" }));
  const handle = manager.spawn({ task: "summarise", label: "summariser" });
  await manager.wait(handle.id, 2_000);
  // Both spellings reach the same child: the parent knows it by the name it talks to.
  expect((await manager.wait(handle.id, 10)).output).toBe("answer");
  expect(manager.status("summariser")?.id).toBe(handle.id);
  expect(manager.idForPeer("summariser")).toBe(handle.id);
});

test("an unknown reference says what does exist rather than only what does not", async () => {
  const manager = track(new SpawnManager({ defaultWorkspace: "/repo", executor: async () => "ok" }));
  manager.spawn({ task: "one", label: "alpha" });
  await expect(manager.wait("beta", 10)).rejects.toThrow(/alpha/);
  expect(manager.status("beta")).toBeUndefined();
});

test("a label that would shadow a live peer falls back to the spawn id", async () => {
  const manager = track(new SpawnManager({ defaultWorkspace: "/repo", reservedPeers: () => ["main"], executor: async () => "ok" }));
  expect(manager.spawn({ task: "a", label: "main" }).peer).toBe("spawn-1");
  expect(manager.spawn({ task: "b", label: "helper" }).peer).toBe("helper");
  // A second child asking for the same label does not get to answer to it either.
  expect(manager.spawn({ task: "c", label: "helper" }).peer).toBe("spawn-3");
  // A label with spaces is made addressable rather than refused: the bus has no room for
  // a space, but "code reviewer" is still a better name than spawn-4.
  expect(manager.spawn({ task: "d", label: "code reviewer" }).peer).toBe("code-reviewer");
  // One that cannot be made into a name at all falls back rather than being mangled.
  expect(manager.spawn({ task: "e", label: "#!$%" }).peer).toBe("spawn-5");
});

test("lifecycle events name every transition, in order, with the identity to act on", async () => {
  const events: SpawnLifecycleEvent[] = [];
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    executor: async (_request, context) => { context.activity({ toolCall: true, filesModified: ["a.ts"] }); return "ok"; },
  }));
  manager.onLifecycle((event) => events.push(event));
  const handle = manager.spawn({ task: "work", label: "worker" });
  await manager.wait(handle.id, 2_000);
  expect(events.map((event) => event.type)).toEqual(["spawned", "started", "completed"]);
  for (const event of events) {
    expect(event.id).toBe(handle.id);
    expect(event.peer).toBe("worker");
  }
  expect(events.at(-1)).toMatchObject({ status: "completed", toolCalls: 1, filesModified: 1 });
});

test("a failure and a deadline are different terminal states with different events", async () => {
  const failures: SpawnLifecycleEvent[] = [];
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    executor: async (request) => { throw request.task === "slow" ? new DOMException("out of time", "TimeoutError") : new Error("the provider refused"); },
  }));
  manager.onLifecycle((event) => { if (event.type === "failed" || event.type === "timed_out") failures.push(event); });
  const broken = manager.spawn({ task: "broken" });
  const slow = manager.spawn({ task: "slow" });
  await expect(manager.wait(broken.id, 2_000)).rejects.toThrow(/refused/);
  await expect(manager.wait(slow.id, 2_000)).rejects.toBeInstanceOf(SpawnDeadlineError);
  expect(manager.status(broken.id)?.status).toBe("failed");
  expect(manager.status(slow.id)?.status).toBe("timed_out");
  expect(failures.map((event) => event.type).sort()).toEqual(["failed", "timed_out"]);
  expect(manager.status(broken.id)?.error).toContain("refused");
});

test("a wait that expires leaves the child running and says so", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = track(new SpawnManager({ defaultWorkspace: "/repo", executor: async () => { await gate; return "late"; } }));
  const handle = manager.spawn({ task: "slow" });
  await expect(manager.wait(handle.id, 20)).rejects.toBeInstanceOf(SpawnTimeoutError);
  expect(manager.status(handle.id)?.status).toBe("running");
  release();
  expect((await manager.wait(handle.id, 2_000)).output).toBe("late");
});

/** A cancel that loses the race must not read as a failure: the work is done. */
test("cancelling a child that has already finished reports the finish, not a failure", async () => {
  const manager = track(new SpawnManager({ defaultWorkspace: "/repo", executor: async () => "done" }));
  const handle = manager.spawn({ task: "quick" });
  await manager.wait(handle.id, 2_000);
  expect(manager.cancel(handle.id)).toBe(false);
  const status = manager.status(handle.id)!;
  expect(status.status).toBe("completed");
  expect(status.resultAvailable).toBe(true);
});

test("cancelling a running child is a cancel, and its result is a rejection", async () => {
  const manager = track(new SpawnManager({ defaultWorkspace: "/repo", executor: async () => new Promise<string>(() => undefined) }));
  const handle = manager.spawn({ task: "endless" });
  const pending = manager.wait(handle.id, 2_000);
  expect(manager.cancel(handle.id)).toBe(true);
  await expect(pending).rejects.toThrow(/cancelled/i);
  expect(manager.status(handle.id)?.status).toBe("cancelled");
});

/**
 * LYRA.md §9: a message revives a parked agent, and it is the only resume primitive. The
 * property that matters is that it is the *same* child — same id, same peer, same
 * transcript — one turn later.
 */
test("revival re-runs the same child with the message as its next instruction", async () => {
  const prompts: string[] = [];
  const resumes: boolean[] = [];
  const events: string[] = [];
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    executor: async (request, context) => { prompts.push(request.task); resumes.push(context.resume === true); return `handled: ${request.task}`; },
  }));
  manager.onLifecycle((event) => events.push(event.type));
  const handle = manager.spawn({ task: "review the parser", label: "reviewer" });
  await manager.wait(handle.id, 2_000);

  const revived = manager.revive("reviewer", "also check the lexer");
  expect(revived).toMatchObject({ id: handle.id, peer: "reviewer" });
  const result = await manager.wait(handle.id, 2_000);
  expect(result.output).toBe("handled: also check the lexer");
  expect(prompts).toEqual(["review the parser", "also check the lexer"]);
  expect(resumes).toEqual([false, true]);
  expect(manager.status("reviewer")).toMatchObject({ revivals: 1, status: "completed" });
  expect(events).toEqual(["spawned", "started", "completed", "revived", "started", "completed"]);
});

/**
 * The other half of the model-routing defect: the failure notice for a child that died at
 * resolution suggested `hub send to:"stylist"` — a revive path pointed at the one failure it
 * cannot repair — and left the name held, which is why the user's retry was called `stylist2`.
 */
test("a child that failed at resolution is not revivable and gives its name back", async () => {
  const events: SpawnLifecycleEvent[] = [];
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    executor: async (request) => {
      if (request.task === "restyle it") throw new SpawnResolutionError(`Spawn stylist could not start: Unknown model in "claude-max/opus-5"`);
      return "ok";
    },
  }));
  manager.onLifecycle((event) => events.push(event));

  const handle = manager.spawn({ task: "restyle it", label: "stylist" });
  await expect(manager.wait(handle.id, 2_000)).rejects.toThrow(/could not start/);
  expect(manager.status(handle.id)).toMatchObject({ status: "failed", failure: "resolution", revivable: false });

  // The one event the terminal notice is written from carries all three facts.
  expect(events.at(-1)).toMatchObject({ type: "failed", peer: "stylist", status: "failed", failure: "resolution", revivable: false, peerReleased: true });

  // Nothing answers to the name any more, so the retry may simply have it.
  expect(manager.status("stylist")).toBeUndefined();
  expect(manager.idForPeer("stylist")).toBeUndefined();
  expect(manager.spawn({ task: "again", label: "stylist" }).peer).toBe("stylist");

  // And reviving it by id says why, rather than re-deriving the same failure in a new turn.
  expect(() => manager.revive(handle.id, "try again")).toThrow(/before it ever ran/);
  expect(manager.status(handle.id)?.status).toBe("failed");
});

test("a child that ran and failed keeps its name and stays revivable", async () => {
  const events: SpawnLifecycleEvent[] = [];
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    executor: async (request) => { if (request.task === "review") throw new Error("the provider refused the request"); return "second pass"; },
  }));
  manager.onLifecycle((event) => events.push(event));

  const handle = manager.spawn({ task: "review", label: "reviewer" });
  await expect(manager.wait(handle.id, 2_000)).rejects.toThrow(/refused/);
  expect(manager.status("reviewer")).toMatchObject({ status: "failed", failure: "execution", revivable: true });
  expect(events.at(-1)).toMatchObject({ type: "failed", failure: "execution", revivable: true });
  expect(events.at(-1)).not.toHaveProperty("peerReleased");

  expect(manager.idForPeer("reviewer")).toBe(handle.id);
  expect(manager.revive("reviewer", "try the lexer instead")).toMatchObject({ id: handle.id, peer: "reviewer" });
  expect((await manager.wait(handle.id, 2_000)).output).toBe("second pass");
  expect(manager.status("reviewer")).toMatchObject({ status: "completed", revivable: true });
});

/** A child the manager never got as far as calling an executor for is the same case. */
test("a child whose workspace never resolved is treated as never having run", async () => {
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    createWorkspace: async () => { throw new Error("no space left on device"); },
    executor: async () => "ok",
  }));
  const handle = manager.spawn({ task: "swarm member", isolated: true, label: "swarmer" });
  await expect(manager.wait(handle.id, 2_000)).rejects.toThrow(/no space left/);
  expect(manager.status(handle.id)).toMatchObject({ status: "failed", failure: "resolution", revivable: false });
  expect(manager.status("swarmer")).toBeUndefined();
});

/**
 * The fail-fast seam. The manager owns no provider configuration and never will, so the check
 * is injected — but it is asked *before* a job exists, because the whole defect was that a
 * caller got `{ status: "running" }` and a handle to a child that could never run.
 */
test("an unusable model is refused before any child exists", async () => {
  const asked: string[] = [];
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    validateModel: (model) => { asked.push(model); if (model !== "claude-max/claude-opus-5") throw new Error(`Unknown model in ${JSON.stringify(model)}`); },
    executor: async () => "ok",
  }));

  await expect(manager.assertModelUsable("claude-max/opus-5")).rejects.toThrow(/Unknown model in "claude-max\/opus-5"/);
  // Installed after construction as well, because a provider added mid-session has to be
  // spawnable in the next turn and the boot-time environment cannot know about it.
  const late = track(new SpawnManager({ defaultWorkspace: "/repo", executor: async () => "ok" }));
  await late.assertModelUsable("anything/at-all"); // No check installed: nothing to refuse it with.
  late.setModelValidator(() => { throw new Error("Unknown provider in \"anything/at-all\""); });
  await expect(late.assertModelUsable("anything/at-all")).rejects.toThrow(/Unknown provider/);
  await manager.assertModelUsable("claude-max/claude-opus-5");
  // An inherited model is the one this session is already serving turns with; re-probing its
  // credential on every delegation would buy latency and nothing else.
  await manager.assertModelUsable(undefined);
  expect(asked).toEqual(["claude-max/opus-5", "claude-max/claude-opus-5"]);
  expect(manager.list()).toEqual([]);
});

test("a running child is not revived: it is still running", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = track(new SpawnManager({ defaultWorkspace: "/repo", executor: async () => { await gate; return "ok"; } }));
  const handle = manager.spawn({ task: "long", label: "worker" });
  await until(() => manager.status("worker")?.status === "running", "the child to start");
  expect(manager.revive("worker", "a message")).toBeUndefined();
  release();
  await manager.wait(handle.id, 2_000);
});

test("a declared write scope travels to the child and its violations come back in the result", async () => {
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    executor: async (_request, context) => {
      expect(context.writeScope).toEqual(["src/parser/**"]);
      context.activity({ scopeViolation: "src/lexer/token.ts" });
      context.activity({ scopeViolation: "src/lexer/token.ts" });
      return "partial";
    },
  }));
  const handle = manager.spawn({ task: "port the parser", writeScope: ["src/parser/**"] });
  const result = await manager.wait(handle.id, 2_000);
  // Recorded once: the same refused path twice is one fact about the partition.
  // And rooted: the declaration is relative to a tree the call never names, so the result
  // says which tree it landed in rather than leaving a mis-rooted scope to show up as the
  // child's first refused write.
  expect(result.scope).toEqual({ paths: ["src/parser/**"], resolved: ["/repo/src/parser/**"], violations: ["src/lexer/token.ts"] });
  expect(manager.status(handle.id)?.writeScope).toEqual(["src/parser/**"]);
  expect(manager.status(handle.id)?.writeScopeResolved).toEqual(["/repo/src/parser/**"]);
  expect(() => manager.spawn({ task: "x", writeScope: [] })).toThrow(/writeScope/);
});

test("a grandchild is on the same directory, at the depth its parent implies", async () => {
  const seen: Array<{ peer: string; depth: number; parentId?: string }> = [];
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    executor: async (_request, context) => { seen.push({ peer: context.peer, depth: context.depth, ...(context.parentId === undefined ? {} : { parentId: context.parentId }) }); return "ok"; },
  }));
  const parent = manager.spawn({ task: "outer", label: "outer" });
  await manager.wait(parent.id, 2_000);
  const child = manager.spawn({ task: "inner", label: "inner" }, { id: parent.id, peer: "outer", depth: 0 });
  await manager.wait(child.id, 2_000);
  expect(seen).toEqual([{ peer: "outer", depth: 0 }, { peer: "inner", depth: 1, parentId: parent.id }]);
  expect(manager.status("inner")?.parentId).toBe(parent.id);
});

/**
 * An isolated child's workspace is archived when it finishes. Reviving it must put it back
 * in *that* directory: a fresh clone would revive the agent without its work, which is the
 * one thing a resume primitive may not do.
 */
test("reviving an isolated child resumes its archived workspace rather than cloning a new one", async () => {
  const created: string[] = [];
  const resumed: string[] = [];
  const released: string[] = [];
  const workspaces = new Map<string, string>();
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    createWorkspace: async () => { created.push("clone"); workspaces.set("agent-1", "/repo-agent-1"); return { name: "agent-1", path: "/repo-agent-1" }; },
    resolveWorkspace: async (name) => { resumed.push(name); return { name, path: workspaces.get(name)! }; },
    releaseWorkspace: async (name) => { released.push(name); },
    describeWorkspace: async (input) => ({ workspace: input.name, path: input.path, commits: 1, uncommitted: [], truncated: false, hint: [`git fetch ${input.path}`] }),
    executor: async (_request, context) => context.workspace,
  }));
  const handle = manager.spawn({ task: "port it", isolated: true, label: "porter" });
  expect((await manager.wait(handle.id, 2_000)).output).toBe("/repo-agent-1");
  expect(released).toEqual(["agent-1"]);

  manager.revive("porter", "one more file");
  const again = await manager.wait(handle.id, 2_000);
  expect(again.output).toBe("/repo-agent-1");
  expect(created).toEqual(["clone"]);
  expect(resumed).toEqual(["agent-1"]);
  expect(released).toEqual(["agent-1", "agent-1"]);
  expect(manager.status("porter")?.workspaceName).toBe("agent-1");
});

test("an isolated child cannot be revived where no workspace can be resumed, and says so", async () => {
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    createWorkspace: async () => ({ name: "agent-1", path: "/repo-agent-1" }),
    releaseWorkspace: async () => undefined,
    executor: async (_request, context) => context.workspace,
  }));
  const handle = manager.spawn({ task: "port it", isolated: true, label: "porter" });
  await manager.wait(handle.id, 2_000);
  manager.revive("porter", "again");
  await expect(manager.wait(handle.id, 2_000)).rejects.toThrow(/cannot be revived/);
  // It ran once, so it keeps its name and stays revivable: `started` is sticky, and a child
  // with a transcript is not retroactively a child that never existed because one later
  // attempt to put it back in its workspace failed.
  expect(manager.status("porter")).toMatchObject({ status: "failed", failure: "execution", revivable: true });
  expect(manager.idForPeer("porter")).toBe(handle.id);
});

/**
 * A revival re-uses the job, so the executor of the *previous* run can still be unwinding
 * when the next one starts. Without a run epoch that stale run reads the replacement's abort
 * signal — not aborted — walks past its own guard, and settles the revived run with the old
 * run's output: the parent collects a pre-cancel answer as the answer to its new question.
 */
test("a superseded run cannot settle, announce, or release the run that replaced it", async () => {
  const gates = new Map<string, { release: (value: string) => void }>();
  const events: string[] = [];
  const manager = track(new SpawnManager({
    defaultWorkspace: "/repo",
    executor: async (request, context) => {
      context.activity({ text: request.task });
      return await new Promise<string>((resolve) => { gates.set(request.task, { release: resolve }); });
    },
  }));
  manager.onLifecycle((event) => events.push(`${event.type}:${event.status}`));

  const handle = manager.spawn({ task: "first", label: "kid" });
  await until(() => gates.has("first"), "the first run to start");
  // Cancelled, but its executor is still on the wire — the exact window a revival opens.
  manager.cancel(handle.id);
  await expect(manager.wait(handle.id, 500)).rejects.toThrow(/cancelled/i);
  expect(manager.runningCount).toBe(1);

  manager.revive("kid", "second");
  await until(() => gates.has("second"), "the revived run to start");
  expect(manager.runningCount).toBe(2);
  gates.get("first")!.release("STALE");
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The stale return neither completed the job nor gave back the live run's slot: two
  // executors really were on the wire, and each accounts for exactly its own.
  expect(manager.status("kid")?.status).toBe("running");
  expect(manager.runningCount).toBe(1);

  gates.get("second")!.release("FRESH");
  const result = await manager.wait(handle.id, 2_000);
  expect(result.output).toBe("FRESH");
  expect(events).toEqual(["spawned:queued", "started:running", "cancelled:cancelled", "revived:queued", "started:running", "completed:completed"]);
  expect(manager.runningCount).toBe(0);
});

/**
 * The child is taught to watch `hub wait channel:"agents"`, so it can be subscribed to the
 * channel its own completion is published on. That publish parks it and can deliver its own
 * completion event back to it — reviving it synchronously from inside `finish`.
 */
test("a completion that revives the same child still gives the waiter that run's result", async () => {
  const outputs = ["first", "second"];
  const manager = track(new SpawnManager({ defaultWorkspace: "/repo", executor: async () => outputs.shift() ?? "extra" }));
  let revivedOnce = false;
  manager.onLifecycle((event) => {
    // Stands in for the bus: the completion event comes straight back as a revival.
    if (event.type === "completed" && !revivedOnce) { revivedOnce = true; manager.revive(event.peer, "one more thing"); }
  });
  const handle = manager.spawn({ task: "review", label: "kid" });
  expect((await manager.wait(handle.id, 2_000)).output).toBe("first");
  await until(() => manager.status("kid")?.status === "completed" && manager.status("kid")?.revivals === 1, "the revived run to finish");
  expect((await manager.wait(handle.id, 2_000)).output).toBe("second");
});

test("a label may not claim a name a later spawn id will take", () => {
  const manager = track(new SpawnManager({ defaultWorkspace: "/repo", executor: async () => "ok" }));
  const first = manager.spawn({ task: "a", label: "spawn-3" });
  expect(first.peer).toBe("spawn-1");
  const third = manager.spawn({ task: "b" });
  const shadowed = manager.spawn({ task: "c" });
  expect(shadowed.id).toBe("spawn-3");
  expect(manager.status("spawn-3")?.id).toBe("spawn-3");
  expect(third.id).toBe("spawn-2");
});
