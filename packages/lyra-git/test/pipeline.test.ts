import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, GitPipeline, summarizeWorkspace } from "../src/index.ts";

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "Lyra Test", GIT_AUTHOR_EMAIL: "lyra@example.test", GIT_COMMITTER_NAME: "Lyra Test", GIT_COMMITTER_EMAIL: "lyra@example.test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function repoFixture() {
  const root = await mkdtemp(join(tmpdir(), "lyra-git-"));
  const origin = join(root, "origin");
  await Bun.$`mkdir -p ${origin}`;
  await git(origin, ["init", "-q", "-b", "main"]);
  await writeFile(join(origin, "base.txt"), "base\n");
  await git(origin, ["add", "."]);
  await git(origin, ["commit", "-q", "-m", "base"]);
  return { root, origin };
}

async function workspace(root: string, origin: string, name: string, file: string, content: string, task: string) {
  const path = join(root, name);
  await git(root, ["clone", "-q", "--local", origin, path]);
  await writeFile(join(path, file), content);
  await git(path, ["add", "."]);
  await git(path, ["commit", "-q", "-m", task]);
  return { name, path, task };
}

describe("transactional git pipeline", () => {
  test("assembles a starburst preview, applies transactionally, and the checkpoint undoes it", async () => {
    const { root, origin } = await repoFixture();
    const activities: Array<{ operation: string; destructive: boolean }> = [];
    try {
      const one = await workspace(root, origin, "purple-falcon", "one.txt", "one\n", "add one");
      const two = await workspace(root, origin, "amber-forge", "two.txt", "two\n", "add two");
      const checkpoints = await CheckpointStore.open({ root: origin });
      const pipeline = new GitPipeline({ origin, checkpoints, activity: (event) => activities.push(event), now: () => new Date("2026-08-05T12:46:00Z") });
      const preview = await pipeline.preview([one, two], "preview-one");
      expect(preview.branches).toEqual(["agent/purple-falcon", "agent/amber-forge"]);
      expect(await git(preview.path, ["show-ref", "--verify", "refs/heads/agent/purple-falcon"])).toContain("refs/heads/agent/purple-falcon");
      const applied = await pipeline.apply();
      expect(applied.ok).toBe(true);
      expect(await readFile(join(origin, "one.txt"), "utf8")).toBe("one\n");
      expect(await readFile(join(origin, "two.txt"), "utf8")).toBe("two\n");
      // One undo mechanism, not two: the apply's rollback point is an ordinary checkpoint.
      expect(applied.checkpoint).toBeDefined();
      expect(applied.message).toContain(`/rollback ${applied.checkpoint!.id}`);
      const restored = await checkpoints.restore(applied.checkpoint!.id, { force: true });
      expect(restored.restored).toContain("one.txt");
      await expect(readFile(join(origin, "one.txt"), "utf8")).rejects.toThrow();
      expect(await readFile(join(origin, "base.txt"), "utf8")).toBe("base\n");
      expect(activities.some((event) => event.operation === "apply" && event.destructive)).toBe(true);
      await checkpoints.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  test("hides .lyra through .git/info/exclude instead of the repository .gitignore", async () => {
    const { root, origin } = await repoFixture();
    try {
      const one = await workspace(root, origin, "quiet-otter", "one.txt", "one\n", "add one");
      const pipeline = new GitPipeline({ origin });
      await pipeline.preview([one], "exclude-preview");
      expect(await readFile(join(origin, ".git", "info", "exclude"), "utf8")).toContain("/.lyra/");
      await expect(readFile(join(origin, ".gitignore"), "utf8")).rejects.toThrow();
      expect(await git(origin, ["status", "--porcelain"])).toBe("");
      const applied = await pipeline.apply("exclude-preview");
      expect(applied.ok).toBe(true);
      expect(await readFile(join(origin, "one.txt"), "utf8")).toBe("one\n");
      expect(await git(origin, ["status", "--porcelain"])).toBe("");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("refuses apply while any untracked origin file could be lost", async () => {
    const { root, origin } = await repoFixture();
    try {
      const one = await workspace(root, origin, "safe-agent", "collision.txt", "preview\n", "add collision");
      const pipeline = new GitPipeline({ origin });
      await pipeline.preview([one], "untracked-preview");
      await writeFile(join(origin, "collision.txt"), "private untracked bytes\n");
      await expect(pipeline.apply("untracked-preview")).rejects.toThrow("tracked or untracked changes");
      expect(await readFile(join(origin, "collision.txt"), "utf8")).toBe("private untracked bytes\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("conflicts surface both task contracts without changing origin", async () => {
    const { root, origin } = await repoFixture();
    try {
      const one = await workspace(root, origin, "first-agent", "base.txt", "first\n", "first intent");
      const two = await workspace(root, origin, "second-agent", "base.txt", "second\n", "second intent");
      const pipeline = new GitPipeline({ origin, now: () => new Date("2026-08-05T13:00:00Z") });
      await pipeline.preview([one, two], "conflict-preview");
      const result = await pipeline.apply("conflict-preview");
      expect(result.ok).toBe(false);
      expect(result.conflicts?.[0]).toMatchObject({ files: ["base.txt"], workspace: { name: "second-agent", task: "second intent" }, priorTasks: ["first intent"] });
      expect(await readFile(join(origin, "base.txt"), "utf8")).toBe("base\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  // No mode gates the resolver any more: a caller that configured one wanted it.
  test("a configured resolver receives the task contracts and its staged resolution is applied", async () => {
    const { root, origin } = await repoFixture();
    let seen: unknown;
    try {
      const one = await workspace(root, origin, "first-agent", "base.txt", "first\n", "first intent");
      const two = await workspace(root, origin, "second-agent", "base.txt", "second\n", "second intent");
      const pipeline = new GitPipeline({
        origin,
        resolver: { resolve: async ({ repo, conflict, allWorkspaces }) => { seen = { conflict, allWorkspaces }; await writeFile(join(repo, "base.txt"), "first and second\n"); await git(repo, ["add", "base.txt"]); return true; } },
      });
      await pipeline.preview([one, two], "auto-conflict-preview");
      expect(await pipeline.apply("auto-conflict-preview")).toMatchObject({ ok: true });
      expect(await readFile(join(origin, "base.txt"), "utf8")).toBe("first and second\n");
      expect(seen).toMatchObject({ conflict: { priorTasks: ["first intent"], workspace: { task: "second intent" } }, allWorkspaces: [{ task: "first intent" }, { task: "second intent" }] });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("/cleanup drops preview repositories past their retention", async () => {
    const { root, origin } = await repoFixture();
    try {
      const one = await workspace(root, origin, "old-agent", "one.txt", "one\n", "add one");
      let clock = Date.parse("2026-08-01T00:00:00.000Z");
      const pipeline = new GitPipeline({ origin, now: () => new Date(clock) });
      const preview = await pipeline.preview([one], "stale-preview");
      expect(await pipeline.cleanupPreviews(7 * 86_400_000)).toEqual([]);
      clock += 8 * 86_400_000;
      expect(await pipeline.cleanupPreviews(7 * 86_400_000)).toEqual(["stale-preview"]);
      expect(await pipeline.listPreviews()).toEqual([]);
      expect(await Bun.file(join(preview.path, "HEAD")).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});

describe("model-driven integration", () => {
  // The spawn result carries this, and the recipe in it is the whole replacement for the
  // observe/stage/auto modes: the parent runs these commands with the git tool it has.
  test("a finished child is summarised as commands the parent model can run", async () => {
    const { root, origin } = await repoFixture();
    try {
      const child = await workspace(root, origin, "hollow-peak", "feature.txt", "work\n", "add a feature");
      await writeFile(join(child.path, "scratch.txt"), "not committed\n");
      const summary = await summarizeWorkspace({ origin, workspace: child.name, path: child.path });
      expect(summary).toMatchObject({ workspace: "hollow-peak", commits: 1, truncated: false });
      expect(summary.uncommitted).toEqual(["scratch.txt"]);
      expect(summary.hint[0]).toBe(`git fetch ${child.path} HEAD:refs/lyra/agents/hollow-peak`);
      expect(summary.hint.some((line) => line.includes("git merge"))).toBe(true);
      // The uncommitted work is called out, because a fetch will not carry it.
      expect(summary.hint.at(-1)).toContain("1 uncommitted path(s)");
      // And the recipe actually works.
      await git(origin, summary.hint[0]!.split(" ").slice(1));
      expect(await git(origin, ["log", "--format=%s", "-1", "refs/lyra/agents/hollow-peak"])).toBe("add a feature");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  // A child that died mid-task, or never started one, must stay reachable rather than
  // becoming an orphan directory the model is never told about.
  test("a broken or empty child workspace is described, not raised", async () => {
    const { root, origin } = await repoFixture();
    try {
      const broken = join(root, "broken");
      await Bun.$`mkdir -p ${broken}`;
      const summary = await summarizeWorkspace({ origin, workspace: "broken", path: broken });
      expect(summary.unavailable).toBeDefined();
      expect(summary.commits).toBe(0);
      expect(summary.hint[0]).toContain("git fetch");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
