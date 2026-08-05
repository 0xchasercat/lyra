import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceError, WorkspaceManager, type GitResult } from "../src/workspaces.ts";

async function git(args: readonly string[], cwd: string): Promise<GitResult> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lyra-host-workspace-"));
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Lyra Test"]]) {
    const result = await git(args[0] === "init" ? args : ["-C", root, ...args], root);
    expect(result.exitCode).toBe(0);
  }
  await writeFile(join(root, "README"), "origin\n");
  expect((await git(["-C", root, "add", "README"], root)).exitCode).toBe(0);
  expect((await git(["-C", root, "commit", "-qm", "initial"], root)).exitCode).toBe(0);
  return root;
}

describe("WorkspaceManager", () => {
  let origin = "";

  beforeEach(async () => {
    origin = await repository();
  });

  afterEach(async () => {
    await rm(origin, { recursive: true, force: true });
  });

  test("creates a persistent independent clone with deterministic names", async () => {
    const manager = await WorkspaceManager.open({ originRoot: origin });
    const first = await manager.create();
    expect(first.name).toBe("amber-arch");
    expect(first.mode).toBe("clone");
    expect(first.path).toBe(join(await realpath(origin), ".lyra", "workspaces", first.name));
    expect(first.path).not.toContain(`${tmpdir()}/lyra-host-workspace-` + "-workspace");
    expect((await lstat(join(first.path, ".git"))).isDirectory()).toBe(true);

    const restarted = await WorkspaceManager.open({ originRoot: origin });
    const second = await restarted.create();
    expect(second.name).toBe("amber-beacon");
    expect((await restarted.list()).map((record) => record.name)).toEqual(["amber-arch", "amber-beacon"]);
  });

  test("mirrors tracked edits, deletions, and untracked files from the live origin", async () => {
    await writeFile(join(origin, "delete-me.txt"), "tracked\n");
    expect((await git(["-C", origin, "add", "delete-me.txt"], origin)).exitCode).toBe(0);
    expect((await git(["-C", origin, "commit", "-qm", "add delete fixture"], origin)).exitCode).toBe(0);
    await rm(join(origin, "delete-me.txt"));
    await writeFile(join(origin, "README"), "dirty tracked\n");
    await writeFile(join(origin, "untracked.txt"), "untracked\n");
    const manager = await WorkspaceManager.open(origin);
    const workspace = await manager.create("dirty-copy");
    expect(await readFile(join(workspace.path, "README"), "utf8")).toBe("dirty tracked\n");
    expect(await readFile(join(workspace.path, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(await lstat(join(workspace.path, "delete-me.txt")).catch(() => undefined)).toBeUndefined();
    expect((await lstat(join(workspace.path, ".git"))).isDirectory()).toBe(true);
  });

  test("recovers lifecycle metadata across restart", async () => {
    const manager = await WorkspaceManager.open(origin);
    const created = await manager.create({ name: "steady-forge" });
    expect((await manager.resume(created.name)).state).toBe("active");
    expect((await manager.pause(created.name)).state).toBe("paused");
    expect((await manager.resume(created.name)).state).toBe("resumed");
    expect((await manager.archive(created.name)).state).toBe("archived");

    const restarted = await WorkspaceManager.open(origin);
    expect((await restarted.get(created.name))?.state).toBe("archived");
    const dropped = await restarted.drop(created.name);
    expect(dropped.state).toBe("dropped");
    expect((await lstat(created.path).catch(() => undefined))).toBeUndefined();
    expect((await WorkspaceManager.open(origin)).get(created.name)).resolves.toMatchObject({ state: "dropped" });
  });

  test("falls back to a degraded worktree without hard-copy commands", async () => {
    const calls: string[][] = [];
    const manager = await WorkspaceManager.open({
      originRoot: origin,
      git: async (args, cwd) => {
        calls.push([...args]);
        if (args[0] === "clone" && args.includes("--local")) {
          return { exitCode: 1, stdout: "", stderr: "local clone disabled for test" };
        }
        return git(args, cwd);
      },
    });
    const record = await manager.create({ name: "degraded-ridge" });
    expect(record.mode).toBe("worktree");
    expect(record.degradedReason).toContain("clone --local failed");
    expect((await lstat(join(record.path, ".git"))).isFile()).toBe(true);
    expect(calls.some((args) => args[0] === "clone" && args.includes("--local"))).toBe(true);
    expect(calls.some((args) => args[0] === "cp" || args[0] === "copy" || args[0] === "rsync")).toBe(false);
    await manager.drop(record.name);
  });

  test("rejects invalid names and symlink escapes", async () => {
    const manager = await WorkspaceManager.open(origin);
    for (const name of ["../outside", "bad/name", "/tmp/escape", "UPPER-case"]) {
      await expect(manager.create({ name })).rejects.toMatchObject({ code: "INVALID_NAME" });
    }
    const outside = await mkdtemp(join(tmpdir(), "lyra-host-outside-"));
    const escaped = join(origin, ".lyra", "workspaces", "escape");
    await symlink(outside, escaped);
    await expect(manager.create({ name: "escape" })).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
    await rm(outside, { recursive: true, force: true });
  });

  test("recovers from malformed metadata and rejects a non-git origin", async () => {
    const manager = await WorkspaceManager.open(origin);
    await manager.create({ name: "lucid-cove" });
    await writeFile(join(origin, ".lyra", "workspaces", "broken.json"), "{not json\n");
    const restarted = await WorkspaceManager.open(origin);
    expect((await restarted.list()).map((record) => record.name)).toEqual(["lucid-cove"]);
    expect(restarted.recoveryWarnings).toHaveLength(1);

    const nonGit = await mkdtemp(join(tmpdir(), "lyra-host-not-git-"));
    try {
      await expect(WorkspaceManager.open(nonGit)).rejects.toMatchObject({ code: "ORIGIN_NOT_GIT" });
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });
});
