import { ReliableProvider, type ProviderTransport, type TransportEvent } from "@lyra/provider";
import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LyraRuntime } from "../src/index.ts";
import { assertWritableOrigin, claimSessionDirectory, describeConcurrentSession, releaseSessionDirectory } from "../src/checkpoints.ts";

async function git(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "Lyra", GIT_AUTHOR_EMAIL: "lyra@test", GIT_COMMITTER_NAME: "Lyra", GIT_COMMITTER_EMAIL: "lyra@test" }, stdout: "ignore", stderr: "pipe" });
  const error = new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(await error);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lyra-checkpoint-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await writeFile(join(root, "tracked.txt"), "original\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "base"]);
  return root;
}

function environment(transport: ProviderTransport) {
  return {
    provider: new ReliableProvider(transport, { streamStallTimeoutMs: 10_000 }),
    providerName: "fixture",
    model: "fixture-model",
    config: {
      providers: { fixture: { base_url: "http://fixture.invalid/v1", api_type: "openai_completions" as const, auth: { type: "none" as const }, models: ["fixture-model"] } },
      roles: { default: "fixture/fixture-model" },
    },
  };
}

function scripted(rounds: Array<() => AsyncGenerator<TransportEvent>>): ProviderTransport {
  let round = 0;
  return { id: "scripted", apiType: "openai_completions", stream() { const step = rounds[Math.min(round, rounds.length - 1)]!; round += 1; return step(); } };
}

function toolRound(id: string, name: string, args: Record<string, unknown>) {
  return async function* (): AsyncGenerator<TransportEvent> {
    yield { type: "tool_call_start", id, name };
    yield { type: "tool_call_delta", id, argumentsDelta: JSON.stringify(args) };
    yield { type: "tool_call_end", id };
    yield { type: "complete", stopReason: "tool_use" };
  };
}

function textRound(text: string) {
  return async function* (): AsyncGenerator<TransportEvent> {
    yield { type: "text_delta", text };
    yield { type: "complete", stopReason: "end_turn" };
  };
}

async function runtimeFor(root: string, session: string, rounds: Array<() => AsyncGenerator<TransportEvent>>, reports?: string[]): Promise<LyraRuntime> {
  return LyraRuntime.create({
    origin: root, session, environment: environment(scripted(rounds)), home: join(root, "home"),
    ...(reports === undefined ? {} : { onReport: (message: string) => { reports.push(message); } }),
  });
}

describe("checkpoints in a live session", () => {
  test("the main session runs in the launch directory and its edits land there", async () => {
    const root = await fixture();
    const runtime = await runtimeFor(root, "in-cwd", [toolRound("c1", "write", { path: "written.txt", content: "by lyra\n" }), textRound("done")]);
    try {
      expect(runtime.app.cwd).toBe(runtime.app.origin);
      await runtime.prompt("write a file");
      // In the launch directory, not in a clone under .lyra/workspaces.
      expect(await readFile(join(root, "written.txt"), "utf8")).toBe("by lyra\n");
      // And the header/footer path a client renders is that same real path.
      expect((await runtime.session.snapshot()).workspace).toBe(runtime.app.cwd);
      expect(await runtime.app.workspaces.list()).toHaveLength(0);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  test("a checkpoint precedes every state-changing tool call and no read-only one", async () => {
    const root = await fixture();
    const runtime = await runtimeFor(root, "granularity", [
      toolRound("c1", "write", { path: "one.txt", content: "one\n" }),
      toolRound("c2", "read", { path: "tracked.txt" }),
      toolRound("c3", "write", { path: "two.txt", content: "two\n" }),
      toolRound("c4", "write", { path: "three.txt", content: "three\n" }),
      textRound("done"),
    ]);
    try {
      await runtime.prompt("do some work");
      const records = await runtime.app.checkpoints.list();
      const preTool = records.filter((record) => record.kind === "pre_tool");
      // The read is not checkpointed at all: nothing it can do needs undoing.
      expect(records.some((record) => record.tool === "read")).toBe(false);
      expect(preTool.every((record) => record.tool === "write")).toBe(true);
      // Three writes, but four checkpoints in total, not five: the first write's snapshot
      // found the tree exactly as `turn_start` left it and collapsed onto it rather than
      // writing a duplicate. That collapse is what makes a per-tool-call cadence cheap.
      expect(preTool).toHaveLength(2);
      expect(records.map((record) => record.kind)).toEqual(["turn_end", "pre_tool", "pre_tool", "turn_start"]);
      // Every checkpoint is anchored to a transcript entry, so a rewind can move the
      // conversation to the same point as the code.
      const anchors = new Set(runtime.session.entries().map((entry) => entry.id));
      for (const record of records) expect(anchors.has(record.entryId ?? "")).toBe(true);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  test("a rollback reverts Lyra's edit and never the one made behind its back", async () => {
    const root = await fixture();
    const runtime = await runtimeFor(root, "never-clobber", [toolRound("c1", "write", { path: "lyra.txt", content: "written by lyra\n" }), textRound("done")]);
    try {
      await runtime.prompt("write a file");
      const before = (await runtime.app.checkpoints.list()).find((record) => record.kind === "turn_start")!;
      // A human edits a tracked file Lyra never touched, the way an editor would.
      await writeFile(join(root, "tracked.txt"), "edited by a human\n");

      const rolled = await runtime.command("/rollback " + before.id) as { error?: string; output: { report: string; detail: { restored: string[]; preserved: string[]; forced: boolean; safety: { id: string } } } };
      expect(rolled.error).toBeUndefined();
      expect(rolled.output.detail.restored).toEqual(["lyra.txt"]);
      expect(rolled.output.detail.preserved).toEqual(["tracked.txt"]);
      expect(rolled.output.report).toContain("changed outside Lyra's own tool calls");
      expect(await Bun.file(join(root, "lyra.txt")).exists()).toBe(false);
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("edited by a human\n");

      // The restore is itself undoable, and the report says with what.
      expect(rolled.output.report).toContain(rolled.output.detail.safety.id);
      const undone = await runtime.command(`/rollback ${rolled.output.detail.safety.id} --force`) as { error?: string };
      expect(undone.error).toBeUndefined();
      expect(await readFile(join(root, "lyra.txt"), "utf8")).toBe("written by lyra\n");
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  test("the user's own repository is never touched by any of it", async () => {
    const root = await fixture();
    const runtime = await runtimeFor(root, "hands-off", [toolRound("c1", "write", { path: "new.txt", content: "x\n" }), textRound("done")]);
    try {
      await runtime.prompt("write a file");
      const refs = Bun.spawn(["git", "for-each-ref", "--format=%(refname)"], { cwd: root, stdout: "pipe" });
      expect((await new Response(refs.stdout).text()).split("\n").filter(Boolean).every((ref) => ref.startsWith("refs/heads/main"))).toBe(true);
      // .lyra is hidden from the user's own status rather than from a .gitignore they wrote.
      expect(await readFile(join(root, ".git", "info", "exclude"), "utf8")).toContain("/.lyra/");
      await expect(readFile(join(root, ".gitignore"), "utf8")).rejects.toThrow();
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe("the git tool's checkpoint operations", () => {
  test("list, diff, checkpoint, and restore are ops on the tool the model already has", async () => {
    const root = await fixture();
    const runtime = await runtimeFor(root, "git-ops", [textRound("ready")]);
    const context = { signal: new AbortController().signal, sessionId: "git-ops", workspace: runtime.app.cwd, callId: "c" };
    try {
      // Thirteen tools, still: checkpoints are git, so they live on the git tool.
      expect(runtime.app.tools.definitions()).toHaveLength(13);
      const definition = runtime.app.tools.definitions().find((entry) => entry.name === "git")!;
      expect(Object.keys((definition.inputSchema as { properties: Record<string, unknown> }).properties)).toContain("op");

      // No op at all is the ordinary git command it has always been.
      const status = await runtime.app.tools.execute("git", { args: ["status", "--porcelain"] }, context);
      expect(status.isError).not.toBe(true);
      expect(status.content.toString()).toContain("exit_code: 0");

      const marked = await runtime.app.tools.execute("git", { op: "checkpoint", label: "before the risky bit" }, context);
      const record = JSON.parse(marked.content.toString()) as { id: string; label: string };
      expect(record.label).toBe("before the risky bit");

      await writeFile(join(root, "tracked.txt"), "changed\n");
      const diff = JSON.parse((await runtime.app.tools.execute("git", { op: "diff", patches: true }, context)).content.toString()) as { files: Array<{ path: string; patch?: string }> };
      expect(diff.files.map((file) => file.path)).toEqual(["tracked.txt"]);
      expect(diff.files[0]!.patch).toContain("+changed");

      const listed = JSON.parse((await runtime.app.tools.execute("git", { op: "list", limit: 5 }, context)).content.toString()) as { checkpoints: Array<{ id: string }> };
      expect(listed.checkpoints.some((entry) => entry.id === record.id)).toBe(true);

      // The model's own restore obeys the same never-clobber rule the slash command does.
      const restored = JSON.parse((await runtime.app.tools.execute("git", { op: "restore", checkpoint: record.id }, context)).content.toString()) as { preserved: string[]; note?: string };
      expect(restored.preserved).toEqual(["tracked.txt"]);
      expect(restored.note).toContain("force: true");
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("changed\n");

      const forced = JSON.parse((await runtime.app.tools.execute("git", { op: "restore", checkpoint: record.id, force: true }, context)).content.toString()) as { forced: boolean };
      expect(forced.forced).toBe(true);
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("original\n");

      const bad = await runtime.app.tools.execute("git", { op: "restore" }, context);
      expect(bad.isError).toBe(true);
      expect(bad.content.toString()).toContain("run op");
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe("/cleanup and the directory guards", () => {
  test("/cleanup reclaims workspaces, previews, and old checkpoints in one answer", async () => {
    const root = await fixture();
    const runtime = await runtimeFor(root, "cleanup", [textRound("ready")]);
    try {
      const result = await runtime.command("/cleanup") as { error?: string; resultKind: string; output: { workspaces: unknown[]; previews: string[]; checkpoints: { kept: number; dropped: number } } };
      expect(result.error).toBeUndefined();
      expect(result.resultKind).toBe("workspaces");
      expect(result.output.previews).toEqual([]);
      // Nothing is old enough to thin yet, and saying so is the honest answer.
      expect(result.output.checkpoints.dropped).toBe(0);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  test("a second session in the same directory is detected and named", async () => {
    const root = await fixture();
    try {
      expect(await claimSessionDirectory(root, "first")).toBeUndefined();
      // A live marker belonging to another process is what a collision looks like.
      await writeFile(join(root, ".lyra", "session.lock"), `${JSON.stringify({ pid: process.pid + 1_000_000, session: "other", startedAt: "2026-08-10T00:00:00.000Z" })}\n`);
      await writeFile(join(root, ".lyra", "session.lock"), `${JSON.stringify({ pid: 1, session: "other", startedAt: "2026-08-10T00:00:00.000Z" })}\n`);
      const clash = await claimSessionDirectory(root, "second");
      expect(clash).toMatchObject({ pid: 1, session: "other" });
      expect(describeConcurrentSession(root, clash!)).toContain("Run one session per directory");
      // A marker whose process is gone is not a collision: a crash must not block the next run.
      await writeFile(join(root, ".lyra", "session.lock"), `${JSON.stringify({ pid: 2_147_480_000, session: "dead", startedAt: "x" })}\n`);
      expect(await claimSessionDirectory(root, "third")).toBeUndefined();
      await releaseSessionDirectory(root);
      expect(await Bun.file(join(root, ".lyra", "session.lock")).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("a directory Lyra cannot write to fails with the directory and the fix in one sentence", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-readonly-"));
    try {
      await chmod(root, 0o500);
      await expect(assertWritableOrigin(root)).rejects.toThrow(/cannot write to .*lyra --origin/s);
      await expect(runtimeFor(root, "readonly", [textRound("never")])).rejects.toThrow("cannot write to");
    } finally { await chmod(root, 0o700).catch(() => undefined); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
