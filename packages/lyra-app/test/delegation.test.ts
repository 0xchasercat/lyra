import { IrcBus, SpawnManager, SpawnResolutionError, SteerQueue, type SpawnExecutor, type SpawnExecutorContext } from "@lyra/core";
import type { SessionUpdate } from "@lyra/acp";
import { ToolRegistry, createDefaultToolRegistry } from "@lyra/tools";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubTool, ScopedWriteTool, SpawnTool } from "../src/integrated-tools.ts";
import { attachAgentLifecycle } from "../src/runtime.ts";
import type { LyraApplication } from "../src/app.ts";

/**
 * The delegation loop, as one real session tried and failed to run it.
 *
 * The session spawned a child non-blocking and then had nowhere to go: `hub wait` returned
 * `[]`, `hub list` showed only itself, `hub inbox` was empty, and no status, result, or
 * cancel existed. It gave up and did the child's work itself, in the same files the child
 * was writing, with no way to see the race. The first test here is that session, start to
 * finish, with every step it could not take.
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

interface Harness {
  bus: IrcBus;
  manager: SpawnManager;
  registry: ToolRegistry;
  updates: SessionUpdate[];
  call(tool: "spawn" | "hub", args: Record<string, unknown>): Promise<{ isError?: boolean; text: string; json: any }>;
}

/**
 * The wiring `LyraRuntime` builds, minus the provider: one bus, one spawn manager, the two
 * tools a parent drives them with, and the *real* [`attachAgentLifecycle`] between them.
 */
function harness(executor: SpawnExecutor, peer = "main"): Harness {
  const bus = new IrcBus();
  bus.register(peer);
  const updates: SessionUpdate[] = [];
  const manager = new SpawnManager({ defaultWorkspace: "/repo", executor, reservedPeers: () => bus.list().map((entry) => entry.name) });
  const detach = attachAgentLifecycle({ spawn: manager, bus, sessionName: peer } as unknown as LyraApplication, (update) => updates.push(update));
  const registry = new ToolRegistry([new SpawnTool(manager), new HubTool(bus, peer, { status: (name) => manager.status(name) })]);
  cleanups.push(async () => { detach(); await manager.close(); bus.close(); });
  const context = { signal: new AbortController().signal, sessionId: "delegation", workspace: "/repo", callId: "call-1" };
  return {
    bus, manager, registry, updates,
    call: async (tool, args) => {
      const result = await registry.execute(tool, args, context);
      const text = String(result.content);
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return { ...(result.isError === undefined ? {} : { isError: result.isError }), text, json };
    },
  };
}

/** A child that runs until it is cancelled, exactly as a real one honours its signal. */
function untilCancelled(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function until<T>(read: () => T | undefined | false, label: string, budgetMs = 3_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * A child that behaves like a real one: it reports what it is doing, folds in a message
 * that arrives mid-run, answers it, and finishes with the files it touched.
 */
function conversationalChild(bus: IrcBus, parent: string): SpawnExecutor {
  return async (request, context: SpawnExecutorContext) => {
    const steering = new SteerQueue();
    const detach = bus.attach(context.peer, {
      deliver: (message) => { steering.aside({ from: message.from, ...(message.text === undefined ? {} : { text: message.text }), messageId: message.id }); },
      consume: (ids) => { steering.consume(ids); },
    });
    try {
      context.activity({ state: "awaiting_tool", tool: "grep", toolCall: true });
      context.activity({ text: `working on: ${request.task}` });
      const aside = await until(() => steering.drain().find((entry) => entry.kind === "hub"), "a message from the parent");
      if (aside.kind !== "hub") throw new Error("unreachable");
      bus.send({ from: context.peer, to: parent, text: `understood, narrowing to ${aside.text}` });
      context.activity({ state: "running", toolCall: true, filesModified: ["src/parser.ts"] });
      return `rewrote the parser, narrowed by "${aside.text}"`;
    } finally { detach(); }
  };
}

test("the session that could not watch its child, run the whole way through", async () => {
  const bus = { value: undefined as IrcBus | undefined };
  const app = harness((request, context) => conversationalChild(bus.value!, "main")(request, context));
  bus.value = app.bus;

  // 1. Spawn non-blocking. The answer carries the two names the rest of the loop needs.
  const started = await app.call("spawn", { task: "rewrite the parser", label: "parser" });
  expect(started.isError).not.toBe(true);
  expect(started.json).toMatchObject({ id: "spawn-1", peer: "parser", workspace: "/repo" });
  expect(started.json.next).toContain('spawn { id: "spawn-1" }');

  // 2. Ask how it is doing — the question that used to have no answer at all.
  const status = await until(async () => { const answer = await app.call("spawn", { id: "parser", op: "status" }); return answer.json?.status === "awaiting_tool" ? answer.json : undefined; }, "the child to reach a tool call").then((value) => value);
  expect(await status).toMatchObject({ id: "spawn-1", peer: "parser", currentTool: "grep", toolCalls: 1 });

  // 3. `hub list` shows the child, with the state the bus alone could not express.
  const listed = await app.call("hub", { op: "list" });
  const child = (listed.json.peers as any[]).find((entry) => entry.name === "parser");
  expect(child).toMatchObject({ kind: "agent", id: "spawn-1", status: "awaiting_tool", mailbox: "running" });

  // 4. Steer it mid-flight. Non-interrupting: it folds into the child's next boundary.
  const sent = await app.call("hub", { op: "send", to: "parser", message: "just the lexer" });
  expect(sent.json).toMatchObject({ delivered: true });

  // 5. Its reply reaches the parent on the same bus.
  const reply = await app.call("hub", { op: "wait", peer: "main", timeoutMs: 3_000 });
  expect(reply.json[0]).toMatchObject({ from: "parser" });
  expect(reply.json[0].text).toContain("just the lexer");

  // 6. Collect. The result names the files a shared-tree child changed.
  const collected = await app.call("spawn", { id: "spawn-1" });
  expect(collected.json).toMatchObject({ collected: true, id: "spawn-1", peer: "parser", filesModified: ["src/parser.ts"] });
  expect(collected.json.output).toContain("just the lexer");

  // 7. The whole run was on the `agents` channel the entire time — as prose, and only as
  // prose. It used to be published as a sentence *and* a full JSON restatement of the same
  // event, so every lifecycle delivery cost roughly three times what one fact is worth.
  const lifecycle = await app.call("hub", { op: "wait", channel: "agents", timeoutMs: 100 });
  const sentences = (lifecycle.json as any[]).map((message) => message.text as string);
  expect(sentences).toEqual([
    expect.stringContaining("was spawned"),
    expect.stringContaining("started"),
    expect.stringContaining("completed after"),
  ]);
  expect((lifecycle.json as any[]).every((message) => message.data === undefined)).toBe(true);
  // The fields a reader would otherwise have gone to the JSON blob for are inline.
  expect(sentences[2]).toContain("spawn-1");
  expect(sentences[2]).toContain("file(s) changed");

  // 8. And on the protocol, for a client that renders presence.
  const agentUpdates = app.updates.filter((update) => update.sessionUpdate === "agent");
  expect(agentUpdates.map((update: any) => update.status)).toEqual(["queued", "running", "completed"]);
  expect(agentUpdates[0]).toMatchObject({ id: "spawn-1", peer: "parser", label: "parser" });
});

test("a blocking spawn that runs out of time returns a diagnosis, not a bare cancel", async () => {
  const app = harness(async (_request, context) => {
    context.activity({ state: "awaiting_tool", tool: "bash", toolCall: true });
    context.activity({ text: "compiling" });
    return await untilCancelled(context.signal);
  });
  const answer = await app.call("spawn", { task: "build everything", label: "builder", blocking: true, timeoutMs: 40 });
  expect(answer.isError).not.toBe(true);
  expect(answer.json).toMatchObject({
    collected: false, id: "spawn-1", peer: "builder", status: "awaiting_tool",
    waitedMs: 40, toolCalls: 1, currentTool: "bash", partialOutput: "compiling",
  });
  expect(answer.json.diagnosis).toContain("bash");
  expect(answer.json.next).toContain('spawn { id: "spawn-1", op: "cancel" }');
  expect(answer.json.next).toContain('hub { op: "send", to: "builder"');
  // The wait expired; the child did not.
  expect(app.manager.status("spawn-1")?.status).toBe("awaiting_tool");
});

test("a child that never produced anything is diagnosed as such", async () => {
  const app = harness(async (_request, context) => await untilCancelled(context.signal));
  const answer = await app.call("spawn", { task: "ask the model", blocking: true, timeoutMs: 30 });
  expect(answer.json.diagnosis).toContain("no tool call and no output");
  expect(answer.json.diagnosis).toContain("provider or model is not answering");
});

test("cancel stops a running child and says something true when it loses the race", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = harness(async (request, context) => { if (request.task === "slow") await Promise.race([gate, untilCancelled(context.signal)]); return "done"; });

  const slow = await app.call("spawn", { task: "slow", label: "slow" });
  expect((await app.call("spawn", { id: "slow", op: "cancel" })).json).toMatchObject({ cancelled: true, id: slow.json.id, status: "cancelled" });

  const quick = await app.call("spawn", { task: "quick", label: "quick" });
  await until(() => app.manager.status("quick")?.status === "completed", "the quick child to finish");
  const raced = await app.call("spawn", { id: "quick", op: "cancel" });
  expect(raced.isError).not.toBe(true);
  expect(raced.json).toMatchObject({ cancelled: false, id: quick.json.id, status: "completed" });
  expect(raced.json.note).toContain("finished before the cancel reached it");
  release();
});

test("a message to a finished child revives it, and only the parent's message is its prompt", async () => {
  const prompts: string[] = [];
  const app = harness(async (request, context) => { prompts.push(request.task); return context.resume === true ? "revised" : "first pass"; });

  const started = await app.call("spawn", { task: "review the parser", label: "reviewer" });
  await until(() => app.manager.status("reviewer")?.status === "completed", "the first pass to finish");
  // Parked, not gone: the peer is still on the bus and still addressable.
  expect(app.bus.getPeer("reviewer")?.state).toBe("parked");
  expect((await app.call("hub", { op: "list" })).json.peers.find((entry: any) => entry.name === "reviewer")).toMatchObject({ mailbox: "parked", status: "completed" });

  await app.call("hub", { op: "send", to: "reviewer", message: "the lexer too, please" });
  await until(() => app.manager.status("reviewer")?.status === "completed" && prompts.length === 2, "the revival to finish");

  expect(prompts[1]).toContain("[hub message from main]");
  expect(prompts[1]).toContain("the lexer too, please");
  // The message became the instruction, so it is not also waiting to be read as a message.
  expect(app.bus.peekInbox("reviewer")).toEqual([]);
  expect((await app.call("spawn", { id: started.json.id })).json).toMatchObject({ collected: true, output: "revised" });
  expect(app.manager.status("reviewer")?.revivals).toBe(1);
});

test("an empty wait says which kind of empty it was", async () => {
  const app = harness(async () => "ok");
  const peerWait = await app.call("hub", { op: "wait", timeoutMs: 1 });
  expect(peerWait.json.note).toContain('channel: "agents"');
  const channelWait = await app.call("hub", { op: "wait", channel: "agents", timeoutMs: 1 });
  expect(channelWait.json.note).toContain("no child started or finished");
  const otherWait = await app.call("hub", { op: "wait", channel: "build-results", timeoutMs: 1 });
  expect(otherWait.json.note).toContain("subscribe");
});

test("spawn op list answers with every child and its state", async () => {
  const app = harness(async (request) => request.task);
  await app.call("spawn", { task: "one", label: "one" });
  await app.call("spawn", { task: "two", label: "two" });
  await until(() => app.manager.statusList().every((status) => status.status === "completed"), "both children to finish");
  const listed = await app.call("spawn", { op: "list" });
  expect((listed.json.agents as any[]).map((agent) => [agent.peer, agent.status])).toEqual([["one", "completed"], ["two", "completed"]]);
});

/**
 * `writeScope` against the real `write` and `edit` tools, in a real directory.
 *
 * Not a lock: nothing here blocks, waits, or coordinates. The child is simply refused the
 * paths its parent did not give it, and told which ones it does own.
 */
test("a declared write scope refuses paths outside it and names the scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "lyra-scope-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "owned.ts"), "const a = 1;\n");
  await writeFile(join(root, "theirs.ts"), "const b = 2;\n");
  const base = createDefaultToolRegistry({ filesystem: { root }, git: { root } });
  const violations: string[] = [];
  const registry = new ToolRegistry([
    new ScopedWriteTool(base.get("write")!, ["src/**", "owned.ts"], root, (path) => violations.push(path)),
    new ScopedWriteTool(base.get("edit")!, ["src/**", "owned.ts"], root, (path) => violations.push(path)),
    base.get("read")!,
  ]);
  const context = { signal: new AbortController().signal, sessionId: "scope", workspace: root, callId: "c", cwd: root, origin: root } as any;

  const inside = await registry.execute("write", { path: "src/new.ts", content: "ok\n" }, context);
  expect(inside.isError).not.toBe(true);
  expect(await readFile(join(root, "src", "new.ts"), "utf8")).toBe("ok\n");

  const outside = await registry.execute("write", { path: "theirs.ts", content: "clobbered\n" }, context);
  expect(outside.isError).toBe(true);
  expect(String(outside.content)).toContain("outside this agent's declared write scope");
  expect(String(outside.content)).toContain("src/**, owned.ts");
  expect(await readFile(join(root, "theirs.ts"), "utf8")).toBe("const b = 2;\n");

  // The foreign spelling reaches the same file, so the guard has to see it too.
  const aliased = await registry.execute("write", { file_path: join(root, "theirs.ts"), content: "clobbered\n" }, context);
  expect(aliased.isError).toBe(true);
  expect(await readFile(join(root, "theirs.ts"), "utf8")).toBe("const b = 2;\n");

  // And a path that escapes the tree entirely is outside every possible scope.
  const escaped = await registry.execute("write", { path: "../elsewhere.ts", content: "x\n" }, context);
  expect(escaped.isError).toBe(true);

  const read = await registry.execute("read", { path: "theirs.ts" }, context);
  const tag = String(read.content).match(/(#[a-f0-9]+)/i)?.[1];
  const edited = await registry.execute("edit", { path: "theirs.ts", tag, search: "const b = 2;", replace: "const b = 3;" }, context);
  expect(edited.isError).toBe(true);
  expect(await readFile(join(root, "theirs.ts"), "utf8")).toBe("const b = 2;\n");

  expect([...violations].sort()).toEqual(["../elsewhere.ts", "theirs.ts", "theirs.ts", join(root, "theirs.ts")].sort());
  await base.close();
});

test("a write scope reaches the child and its refusals reach the parent's status and result", async () => {
  const app = harness(async (_request, context) => {
    context.activity({ scopeViolation: "src/lexer.ts" });
    return "did what I could";
  });
  const started = await app.call("spawn", { task: "port the parser", label: "porter", writeScope: ["src/parser/**"] });
  // Echoed at the call, rooted: a `writeScope` aimed at the wrong tree is otherwise invisible
  // until the child is refused a write, where it reads as the child's mistake.
  expect(started.json).toMatchObject({ writeScope: ["src/parser/**"], writeScopeResolved: ["/repo/src/parser/**"] });
  const status = await until(async () => (await app.call("spawn", { id: "porter", op: "status" })).json, "a status");
  expect(await status).toMatchObject({ writeScope: ["src/parser/**"], writeScopeResolved: ["/repo/src/parser/**"] });
  const collected = await app.call("spawn", { id: started.json.id });
  expect(collected.json.scope).toEqual({ paths: ["src/parser/**"], resolved: ["/repo/src/parser/**"], violations: ["src/lexer.ts"] });
  const listed = await app.call("hub", { op: "list" });
  expect(listed.json.peers.find((entry: any) => entry.name === "porter")).toMatchObject({ writeScope: ["src/parser/**"] });
});

/**
 * The parent's other dead end: a wait with no channel listens on the parent's own mailbox,
 * which is the natural thing to do mid-conversation with a child — and a child that *dies*
 * mid-conversation would never send again, leaving that wait to expire with nothing.
 */
test("a child that fails while the parent is waiting wakes the wait and says why", async () => {
  const app = harness(async () => { throw new Error("the provider refused the request"); });
  const started = await app.call("spawn", { task: "review", label: "reviewer" });
  const woken = await app.call("hub", { op: "wait", peer: "main", timeoutMs: 3_000 });
  expect(woken.json[0]).toMatchObject({ from: "reviewer" });
  // Prose carrying the fields, with no JSON restatement beside it.
  const notice = woken.json[0].text as string;
  expect(notice).toContain("failed");
  expect(notice).toContain(started.json.id);
  expect(notice).toContain("refused");
  expect(woken.json[0].data).toBeUndefined();
  // And collecting it explains the same thing, with a way forward.
  const collected = await app.call("spawn", { id: "reviewer" });
  expect(collected.isError).toBe(true);
  expect(collected.json).toMatchObject({ collected: false, status: "failed" });
  expect(collected.json.next).toContain("hub { op: \"send\", to: \"reviewer\" }");
});

test("a hub call padded by a schema-complete emitter still lands", async () => {
  const app = harness(async (request) => request.task);
  await app.call("spawn", { task: "one", label: "one" });
  // Every declared optional filled with the padding a strict grammar forces out.
  const padded = await app.call("hub", { op: "list", to: "", peer: "", channel: "", message: "", timeoutMs: 0, data: null });
  expect(padded.isError).not.toBe(true);
  expect((padded.json.peers as any[]).map((entry) => entry.name)).toEqual(["main", "one"]);
  // And a stringified scalar, which JSON-mode emitters routinely produce.
  const waited = await app.call("hub", { op: "wait", channel: "agents", timeoutMs: "1" as unknown as number });
  expect(waited.isError).not.toBe(true);
});

/**
 * The other half of "a resolution failure is not revivable": what the *parent* is told.
 *
 * The observed notice suggested `hub send to:"stylist"` for a child that never ran, so the
 * documented next step could not work — and nothing said the name was free again, which is
 * why the user named their retry `stylist2`.
 */
test("a child that never ran is announced without a revive path, and gives its name back", async () => {
  const app = harness(async () => { throw new SpawnResolutionError('Cannot spawn with model "claude-max/opus-5"'); });
  await app.call("spawn", { task: "restyle", label: "stylist" });

  const woken = await app.call("hub", { op: "wait", peer: "main", timeoutMs: 3_000 });
  const notice = woken.json[0].text as string;
  expect(notice).toContain("failed");
  expect(notice).toContain("nothing to revive");
  expect(notice).not.toContain('hub { op: "send"');

  // The bus gave the name back with the announcement, so the retry can reuse it.
  expect(app.bus.getPeer("stylist")).toBeUndefined();
});

/** A child that ran and failed is the opposite case: its transcript exists, so a message works. */
test("a child that ran and failed keeps its name and is announced with the revive path", async () => {
  const app = harness(async () => { throw new Error("the tests did not pass"); });
  await app.call("spawn", { task: "review", label: "reviewer" });

  const woken = await app.call("hub", { op: "wait", peer: "main", timeoutMs: 3_000 });
  const notice = woken.json[0].text as string;
  expect(notice).toContain('hub { op: "send", to: "reviewer"');
  expect(app.bus.getPeer("reviewer")).toBeDefined();
});
