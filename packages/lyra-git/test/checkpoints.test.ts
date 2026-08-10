import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKPOINT_EXCLUDED_PATHS,
  CheckpointStore,
  checkpointDirectory,
  hasCheckpointStore,
} from "../src/index.ts";

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

async function plainRoot(): Promise<string> { return mkdtemp(join(tmpdir(), "lyra-cp-")); }

describe("shadow-git checkpoints", () => {
  test("works in a directory that is not a repository, and never creates one", async () => {
    const root = await plainRoot();
    try {
      await writeFile(join(root, "a.txt"), "one\n");
      const store = await CheckpointStore.open({ root });
      expect(store.available).toBe(true);
      const first = await store.checkpoint({ kind: "manual", label: "first" });
      expect(first?.changedFiles).toBe(1);
      await writeFile(join(root, "a.txt"), "two\n");
      const second = await store.checkpoint({ kind: "pre_tool", tool: "edit", attributed: ["a.txt"] });
      expect(second?.changedFiles).toBe(1);
      expect(second?.label).toBe("before edit");
      // The user's own repository is never created, opened, or written.
      expect(await Bun.file(join(root, ".git", "HEAD")).exists()).toBe(false);
      expect(await hasCheckpointStore(root)).toBe(true);
      expect(checkpointDirectory(root)).toBe(join(root, ".lyra", "checkpoints"));
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("leaves the surrounding repository's refs, index, and status untouched", async () => {
    const root = await plainRoot();
    try {
      await git(root, ["init", "-q", "-b", "main"]);
      await writeFile(join(root, "tracked.txt"), "base\n");
      await git(root, ["add", "."]);
      await git(root, ["commit", "-q", "-m", "base"]);
      const head = await git(root, ["rev-parse", "HEAD"]);
      const store = await CheckpointStore.open({ root });
      await writeFile(join(root, "tracked.txt"), "changed\n");
      await store.checkpoint({ kind: "manual" });
      expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
      expect(await git(root, ["status", "--porcelain"])).toContain("tracked.txt");
      expect(await git(root, ["for-each-ref", "--format=%(refname)", "refs/lyra"])).toBe("");
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("captures gitignored output but never .lyra, node_modules, or target", async () => {
    const root = await plainRoot();
    try {
      await git(root, ["init", "-q", "-b", "main"]);
      await writeFile(join(root, ".gitignore"), "dist/\n");
      await mkdir(join(root, "dist"), { recursive: true });
      await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
      await mkdir(join(root, "target", "debug"), { recursive: true });
      await mkdir(join(root, "nested", "node_modules"), { recursive: true });
      await writeFile(join(root, "dist", "bundle.js"), "built\n");
      await writeFile(join(root, "node_modules", "pkg", "index.js"), "dep\n");
      await writeFile(join(root, "target", "debug", "bin"), "rust\n");
      await writeFile(join(root, "nested", "node_modules", "dep.js"), "nested dep\n");
      const store = await CheckpointStore.open({ root });
      const record = await store.checkpoint({ kind: "manual" });
      expect(record?.excluded).toEqual([...CHECKPOINT_EXCLUDED_PATHS]);
      const files = (await store.diff({ from: { parentOf: record!.id }, to: record!.id })).files.map((file) => file.path);
      // The gitignored build artifact is in: a model may have written it and it may matter.
      expect(files).toContain("dist/bundle.js");
      expect(files).toContain(".gitignore");
      expect(files.some((path) => path.includes("node_modules"))).toBe(false);
      expect(files.some((path) => path.startsWith("target/"))).toBe(false);
      expect(files.some((path) => path.startsWith(".lyra"))).toBe(false);
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("collapses a checkpoint whose tree did not change", async () => {
    const root = await plainRoot();
    try {
      await writeFile(join(root, "a.txt"), "one\n");
      const store = await CheckpointStore.open({ root });
      const first = await store.checkpoint({ kind: "manual" });
      const again = await store.checkpoint({ kind: "pre_tool", tool: "bash" });
      expect(again?.collapsed).toBe(true);
      expect(again?.id).toBe(first!.id);
      expect(await store.list()).toHaveLength(1);
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("restores a checkpoint, and never reverts a file Lyra did not touch", async () => {
    const root = await plainRoot();
    try {
      await writeFile(join(root, "lyra.txt"), "v1\n");
      await writeFile(join(root, "human.txt"), "human v1\n");
      const store = await CheckpointStore.open({ root });
      const base = await store.checkpoint({ kind: "turn_start", entryId: "entry-1" });
      expect(base?.entryId).toBe("entry-1");
      // Lyra edits one file and reports it; a human edits another and reports nothing.
      await writeFile(join(root, "lyra.txt"), "v2\n");
      await writeFile(join(root, "human.txt"), "human v2\n");
      await store.checkpoint({ kind: "pre_tool", tool: "edit", attributed: ["lyra.txt"] });
      const restored = await store.restore(base!.id);
      expect(restored.restored).toEqual(["lyra.txt"]);
      expect(restored.preserved).toEqual(["human.txt"]);
      expect(restored.forced).toBe(false);
      expect(await readFile(join(root, "lyra.txt"), "utf8")).toBe("v1\n");
      expect(await readFile(join(root, "human.txt"), "utf8")).toBe("human v2\n");
      // The state that was replaced is itself a checkpoint, so the restore is undoable —
      // here by collapsing onto the pre-tool checkpoint that already described that tree,
      // which is the cheapness the whole design turns on.
      expect(restored.safety.collapsed).toBe(true);
      expect(restored.safety.tree).not.toBe(restored.target.tree);
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  /**
   * The restore's own reversions are Lyra's, and nothing else will say so.
   *
   * This is the assertion the test above was one line short of. It checked that the safety
   * checkpoint *existed*; it never ran it. Restoring to it used to be a silent no-op —
   * reverting a file is not a tool call, so no tool reported a path, so the undo read every
   * reversion as a human's work and preserved all of it. "Undo this with <id>" resolved,
   * ran, changed nothing, and reported nothing wrong.
   */
  test("the checkpoint a restore names as its undo actually undoes it", async () => {
    const root = await plainRoot();
    try {
      await writeFile(join(root, "lyra.txt"), "v1\n");
      const store = await CheckpointStore.open({ root });
      const base = await store.checkpoint({ kind: "turn_start" });
      await writeFile(join(root, "lyra.txt"), "v2\n");
      await writeFile(join(root, "added.txt"), "new\n");
      await store.checkpoint({ kind: "pre_tool", tool: "write", attributed: ["lyra.txt", "added.txt"] });

      const back = await store.restore(base!.id);
      expect(back.restored).toEqual(["added.txt", "lyra.txt"]);
      expect(await readFile(join(root, "lyra.txt"), "utf8")).toBe("v1\n");
      expect(await Bun.file(join(root, "added.txt")).exists()).toBe(false);

      // Now the undo the result advertised, which is the whole point of naming it.
      const forward = await store.restore(back.safety.id);
      expect(forward.restored).toEqual(["added.txt", "lyra.txt"]);
      expect(forward.preserved).toEqual([]);
      expect(await readFile(join(root, "lyra.txt"), "utf8")).toBe("v2\n");
      expect(await readFile(join(root, "added.txt"), "utf8")).toBe("new\n");

      // And it is symmetric: undoing the undo returns to where the first restore left off.
      const again = await store.restore(forward.safety.id);
      expect(again.preserved).toEqual([]);
      expect(await readFile(join(root, "lyra.txt"), "utf8")).toBe("v1\n");
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  /**
   * A collapse records nothing, so it must not swallow the attribution it was handed.
   *
   * Otherwise a no-op call in front of a real one silently converts the real one's paths
   * into foreign work, and the restore that should revert them preserves them instead.
   */
  test("attribution handed to a collapsed checkpoint survives to the next real one", async () => {
    const root = await plainRoot();
    try {
      await writeFile(join(root, "a.txt"), "one\n");
      const store = await CheckpointStore.open({ root });
      const base = await store.checkpoint({ kind: "turn_start" });

      // A tool reported a path but changed nothing the index can see, so this collapses.
      const collapsed = await store.checkpoint({ kind: "pre_tool", tool: "bash", attributed: ["a.txt"] });
      expect(collapsed?.collapsed).toBe(true);

      // The next call really does change it, and the checkpoint after that carries both.
      await writeFile(join(root, "a.txt"), "two\n");
      const real = await store.checkpoint({ kind: "pre_tool", tool: "write", attributed: [] });
      expect(real?.collapsed).toBeUndefined();
      expect(real?.attributed).toEqual(["a.txt"]);

      const restored = await store.restore(base!.id);
      expect(restored.restored).toEqual(["a.txt"]);
      expect(restored.preserved).toEqual([]);
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("force reverts foreign changes, including a file a human created", async () => {
    const root = await plainRoot();
    try {
      await writeFile(join(root, "a.txt"), "v1\n");
      const store = await CheckpointStore.open({ root });
      const base = await store.checkpoint({ kind: "manual" });
      await writeFile(join(root, "a.txt"), "v2\n");
      await writeFile(join(root, "human-new.txt"), "mine\n");
      const gentle = await store.restore(base!.id);
      expect(gentle.preserved.sort()).toEqual(["a.txt", "human-new.txt"]);
      expect(await readFile(join(root, "a.txt"), "utf8")).toBe("v2\n");
      const forced = await store.restore(base!.id, { force: true });
      expect(forced.forced).toBe(true);
      expect(forced.preserved).toEqual([]);
      expect(await readFile(join(root, "a.txt"), "utf8")).toBe("v1\n");
      expect(await Bun.file(join(root, "human-new.txt")).exists()).toBe(false);
      // …and even that is undoable, because the forced restore checkpointed first.
      const back = await store.restore(forced.safety.id, { force: true });
      expect(back.forced).toBe(true);
      expect(await Bun.file(join(root, "human-new.txt")).exists()).toBe(true);
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("a restore does not resurrect a file a human deleted", async () => {
    const root = await plainRoot();
    try {
      await writeFile(join(root, "keep.txt"), "keep\n");
      await writeFile(join(root, "human.txt"), "human\n");
      const store = await CheckpointStore.open({ root });
      const base = await store.checkpoint({ kind: "manual" });
      await rm(join(root, "human.txt"));
      await writeFile(join(root, "keep.txt"), "edited by lyra\n");
      await store.checkpoint({ kind: "pre_tool", tool: "write", attributed: ["keep.txt"] });
      const restored = await store.restore(base!.id);
      expect(restored.preserved).toEqual(["human.txt"]);
      expect(await Bun.file(join(root, "human.txt")).exists()).toBe(false);
      expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("keep\n");
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("diffs between checkpoints and against the live tree, with per-file patches", async () => {
    const root = await plainRoot();
    try {
      await writeFile(join(root, "a.txt"), "one\n");
      const store = await CheckpointStore.open({ root });
      const first = await store.checkpoint({ kind: "manual" });
      await writeFile(join(root, "a.txt"), "one\ntwo\n");
      await writeFile(join(root, "b.txt"), "new\n");
      const second = await store.checkpoint({ kind: "manual" });
      const between = await store.diff({ from: first!.id, to: second!.id, patches: true });
      expect(between.files.map((file) => `${file.status} ${file.path}`).sort()).toEqual(["added b.txt", "modified a.txt"]);
      expect(between.files.find((file) => file.path === "a.txt")?.additions).toBe(1);
      expect(between.files.find((file) => file.path === "a.txt")?.patch).toContain("+two");
      expect(between.from).toMatchObject({ kind: "checkpoint", id: first!.id });
      // The live tree is diffable without disturbing the recorded chain.
      await writeFile(join(root, "c.txt"), "live\n");
      const live = await store.diff({ from: second!.id });
      expect(live.to.kind).toBe("worktree");
      expect(live.files.map((file) => file.path)).toEqual(["c.txt"]);
      expect(await store.list()).toHaveLength(2);
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("thins by age and count while keeping stable ids resolvable", async () => {
    const root = await plainRoot();
    let clock = Date.parse("2026-08-01T00:00:00.000Z");
    try {
      const store = await CheckpointStore.open({ root, now: () => new Date(clock) });
      const made = [];
      for (let index = 0; index < 12; index += 1) {
        await writeFile(join(root, `f${index}.txt`), `${index}\n`);
        made.push((await store.checkpoint({ kind: "manual", label: `step ${index}` }))!);
        clock += 20 * 60_000; // twenty minutes apart
      }
      // Two days later: everything is outside the keep-all window.
      clock += 2 * 24 * 60 * 60_000;
      const collected = await store.collect({ keepRecent: 2, keepAllMs: 60_000, thinIntervalMs: 60 * 60_000 });
      expect(collected.dropped).toBeGreaterThan(0);
      expect(collected.kept).toBe(collected.checkpoints.length);
      // The newest is never dropped, and a surviving checkpoint answers to the id it was
      // given even though thinning rewrote every commit oid after the first drop.
      const newest = made.at(-1)!;
      expect(collected.checkpoints[0]!.id).toBe(newest.id);
      const survivor = collected.checkpoints.at(-1)!;
      expect((await store.resolve(survivor.id))?.label).toBe(survivor.label);
      expect(await store.resolve("no-such-checkpoint")).toBeUndefined();
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  test("keeps everything inside the keep-all window", async () => {
    const root = await plainRoot();
    const clock = Date.parse("2026-08-01T00:00:00.000Z");
    try {
      const store = await CheckpointStore.open({ root, now: () => new Date(clock) });
      for (let index = 0; index < 5; index += 1) {
        await writeFile(join(root, `f${index}.txt`), `${index}\n`);
        await store.checkpoint({ kind: "manual" });
      }
      const collected = await store.collect();
      expect(collected).toMatchObject({ dropped: 0, kept: 5 });
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("degrades to a no-op instead of failing when the shadow repository cannot exist", async () => {
    const root = await plainRoot();
    try {
      // A file where the shadow directory has to be: creation cannot succeed.
      await mkdir(join(root, ".lyra"), { recursive: true });
      await writeFile(join(root, ".lyra", "checkpoints"), "not a directory\n");
      const warnings: string[] = [];
      const store = await CheckpointStore.open({ root, onWarning: (message) => warnings.push(message) });
      expect(store.available).toBe(false);
      expect(store.unavailable).toBeDefined();
      expect(warnings[0]).toContain("Checkpoints are disabled");
      expect(await store.checkpoint({ kind: "manual" })).toBeUndefined();
      expect(await store.list()).toEqual([]);
      expect((await store.diff({})).available).toBe(false);
      await expect(store.restore("cp-1")).rejects.toThrow("unavailable");
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("survives a crash: a reopened store reads its history back out of git", async () => {
    const root = await plainRoot();
    try {
      await writeFile(join(root, "a.txt"), "one\n");
      const first = await CheckpointStore.open({ root });
      const made = await first.checkpoint({ kind: "turn_start", entryId: "entry-7", label: "before turn" });
      // No close(): the process is imagined to have died here.
      const reopened = await CheckpointStore.open({ root });
      const listed = await reopened.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: made!.id, entryId: "entry-7", label: "before turn", kind: "turn_start" });
      // Ids keep counting up rather than colliding with the recovered ones.
      await writeFile(join(root, "a.txt"), "two\n");
      const next = await reopened.checkpoint({ kind: "manual" });
      expect(next!.id).not.toBe(made!.id);
      await reopened.close();
      await first.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
