import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitPipeline } from "../src/index.ts";

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
  await writeFile(join(origin, ".gitignore"), ".lyra/\n");
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
  test("assembles a starburst preview, snapshots, applies transactionally, and rolls back", async () => {
    const { root, origin } = await repoFixture();
    const activities: Array<{ operation: string; destructive: boolean }> = [];
    try {
      const one = await workspace(root, origin, "purple-falcon", "one.txt", "one\n", "add one");
      const two = await workspace(root, origin, "amber-forge", "two.txt", "two\n", "add two");
      const pipeline = new GitPipeline({ origin, mode: "stage", activity: (event) => activities.push(event), now: () => new Date("2026-08-05T12:46:00Z") });
      const preview = await pipeline.preview([one, two], "preview-one");
      expect(preview.branches).toEqual(["agent/purple-falcon", "agent/amber-forge"]);
      expect(await git(preview.path, ["show-ref", "--verify", "refs/heads/agent/purple-falcon"])).toContain("refs/heads/agent/purple-falcon");
      const applied = await pipeline.apply();
      expect(applied.ok).toBe(true);
      expect(await readFile(join(origin, "one.txt"), "utf8")).toBe("one\n");
      expect(await readFile(join(origin, "two.txt"), "utf8")).toBe("two\n");
      expect((await pipeline.listSnapshots()).map((snapshot) => snapshot.name)).toEqual([applied.snapshot.name]);
      await pipeline.rollback(applied.snapshot.name);
      await expect(readFile(join(origin, "one.txt"), "utf8")).rejects.toThrow();
      expect(await readFile(join(origin, "base.txt"), "utf8")).toBe("base\n");
      expect(activities.some((event) => event.operation === "apply" && event.destructive)).toBe(true);
      expect(activities.some((event) => event.operation === "rollback" && event.destructive)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("observe mode never touches origin and auto mode requires confirmation", async () => {
    const { root, origin } = await repoFixture();
    try {
      const one = await workspace(root, origin, "hollow-peak", "one.txt", "one\n", "add one");
      const pipeline = new GitPipeline({ origin });
      await pipeline.preview([one], "observe-preview");
      await expect(pipeline.apply("observe-preview")).rejects.toThrow("observe never touches");
      await expect(pipeline.setMode("auto")).rejects.toThrow("confirmation");
      const denied = new GitPipeline({ origin, confirmAuto: () => false });
      await expect(denied.setMode("auto")).rejects.toThrow("not confirmed");
      expect(await readFile(join(origin, "base.txt"), "utf8")).toBe("base\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("refuses apply while any untracked origin file could be lost", async () => {
    const { root, origin } = await repoFixture();
    try {
      const one = await workspace(root, origin, "safe-agent", "collision.txt", "preview\n", "add collision");
      const pipeline = new GitPipeline({ origin, mode: "stage" });
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
      const pipeline = new GitPipeline({ origin, mode: "stage", now: () => new Date("2026-08-05T13:00:00Z") });
      await pipeline.preview([one, two], "conflict-preview");
      const result = await pipeline.apply("conflict-preview");
      expect(result.ok).toBe(false);
      expect(result.conflicts?.[0]).toMatchObject({ files: ["base.txt"], workspace: { name: "second-agent", task: "second intent" }, priorTasks: ["first intent"] });
      expect(await readFile(join(origin, "base.txt"), "utf8")).toBe("base\n");
      expect(await pipeline.listSnapshots()).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("auto mode invokes the resolver with task contracts and applies its staged resolution", async () => {
    const { root, origin } = await repoFixture();
    let seen: unknown;
    try {
      const one = await workspace(root, origin, "first-agent", "base.txt", "first\n", "first intent");
      const two = await workspace(root, origin, "second-agent", "base.txt", "second\n", "second intent");
      const pipeline = new GitPipeline({
        origin,
        confirmAuto: () => true,
        resolver: { resolve: async ({ repo, conflict, allWorkspaces }) => { seen = { conflict, allWorkspaces }; await writeFile(join(repo, "base.txt"), "first and second\n"); await git(repo, ["add", "base.txt"]); return true; } },
      });
      await pipeline.setMode("auto");
      await pipeline.preview([one, two], "auto-conflict-preview");
      expect(await pipeline.apply("auto-conflict-preview")).toMatchObject({ ok: true });
      expect(await readFile(join(origin, "base.txt"), "utf8")).toBe("first and second\n");
      expect(seen).toMatchObject({ conflict: { priorTasks: ["first intent"], workspace: { task: "second intent" } }, allWorkspaces: [{ task: "first intent" }, { task: "second intent" }] });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
