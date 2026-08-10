import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceError, WorkspaceManager, type GitResult } from "../src/workspaces.ts";

/** The in-kernel hierarchy clone is macOS-only; elsewhere the copy path is the only path. */
const onDarwin = process.platform === "darwin" ? test : test.skip;

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

  onDarwin("clones the hierarchy in the kernel instead of running git clone", async () => {
    await writeFile(join(origin, "README"), "dirty tracked\n");
    await writeFile(join(origin, "untracked.txt"), "untracked\n");
    const calls: string[][] = [];
    const manager = await WorkspaceManager.open({
      originRoot: origin,
      git: async (args, cwd) => { calls.push([...args]); return git(args, cwd); },
    });
    expect(manager.capabilities.clonefile).toBe(true);
    const record = await manager.create({ name: "kernel-clone" });
    expect(record.mode).toBe("clone");
    expect(record.degradedReason).toBeUndefined();
    expect(calls.some((args) => args[0] === "clone" && args.includes("--local"))).toBe(false);
    expect(calls.some((args) => args[0] === "worktree")).toBe(false);
    // The clone carries `.git`, which is what makes it an independent repository.
    expect((await lstat(join(record.path, ".git"))).isDirectory()).toBe(true);
    // `.lyra` holds every other workspace and must never be nested inside one.
    expect(await lstat(join(record.path, ".lyra")).catch(() => undefined)).toBeUndefined();
    const status = await git(["-C", record.path, "status", "--porcelain"], record.path);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("M README");
    expect(status.stdout).toContain("?? untracked.txt");
  });

  onDarwin("gives the kernel clone and the copy fallback the same working tree", async () => {
    await writeFile(join(origin, "delete-me.txt"), "tracked\n");
    expect((await git(["-C", origin, "add", "delete-me.txt"], origin)).exitCode).toBe(0);
    expect((await git(["-C", origin, "commit", "-qm", "add delete fixture"], origin)).exitCode).toBe(0);
    await rm(join(origin, "delete-me.txt"));
    await writeFile(join(origin, "README"), "dirty tracked\n");
    await writeFile(join(origin, "untracked.txt"), "untracked\n");
    await symlink("README", join(origin, "readme-link"));

    const snapshot = await (await WorkspaceManager.open({ originRoot: origin })).create({ name: "kernel-parity" });
    const copied = await (await WorkspaceManager.open({ originRoot: origin, clonefile: false })).create({ name: "copy-parity" });
    const states: string[] = [];
    for (const path of [snapshot.path, copied.path]) {
      expect(await readFile(join(path, "README"), "utf8")).toBe("dirty tracked\n");
      expect(await readFile(join(path, "untracked.txt"), "utf8")).toBe("untracked\n");
      expect(await lstat(join(path, "delete-me.txt")).catch(() => undefined)).toBeUndefined();
      // A top-level symlink stays a symlink: CLONE_NOFOLLOW matches what the copy does.
      expect((await lstat(join(path, "readme-link"))).isSymbolicLink()).toBe(true);
      const status = await git(["-C", path, "status", "--porcelain"], path);
      expect(status.exitCode).toBe(0);
      states.push(status.stdout.split("\n").sort().join("\n"));
    }
    expect(states[0]).toBe(states[1]);
  });

  onDarwin("drops the origin's index lock from the snapshot", async () => {
    // The copied lock names no live process, so keeping it would wedge every git command.
    await writeFile(join(origin, ".git", "index.lock"), "");
    try {
      const record = await (await WorkspaceManager.open(origin)).create({ name: "locked-origin" });
      expect(record.mode).toBe("clone");
      expect(await lstat(join(record.path, ".git", "index.lock")).catch(() => undefined)).toBeUndefined();
      expect((await git(["-C", record.path, "status", "--porcelain"], record.path)).exitCode).toBe(0);
    } finally {
      await rm(join(origin, ".git", "index.lock"), { force: true });
    }
  });

  onDarwin("creates a two thousand file workspace without walking it file by file", async () => {
    await mkdir(join(origin, "bulk"));
    await Promise.all(Array.from({ length: 2000 }, (_, index) => writeFile(join(origin, "bulk", `file-${index}.txt`), `${index}\n`)));
    const manager = await WorkspaceManager.open(origin);
    const started = performance.now();
    const record = await manager.create({ name: "bulk-clone" });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await readFile(join(record.path, "bulk", "file-1999.txt"), "utf8")).toBe("1999\n");
  });

  test("falls back to a single-pass git clone when the kernel clone fails", async () => {
    await writeFile(join(origin, "README"), "dirty tracked\n");
    await writeFile(join(origin, "untracked.txt"), "untracked\n");
    const calls: string[][] = [];
    let checkoutContents: string[] = [];
    const manager = await WorkspaceManager.open({
      originRoot: origin,
      clonefile: () => ({ ok: false, errno: 45, message: "ENOTSUP (scripted)" }),
      git: async (args, cwd) => {
        calls.push([...args]);
        const result = await git(args, cwd);
        // Observed between clone and copy: a checkout here would be a second write of
        // every file, which is exactly the double work this path used to do.
        if (args[0] === "clone" && args.includes("--local")) checkoutContents = (await readdir(args[args.length - 1])).sort();
        return result;
      },
    });
    const record = await manager.create({ name: "copy-fallback" });
    expect(record.mode).toBe("clone");
    expect(record.degradedReason).toBeUndefined();
    expect(calls.some((args) => args[0] === "clone" && args.includes("--local") && args.includes("--no-checkout"))).toBe(true);
    expect(checkoutContents).toEqual([".git"]);
    expect((await lstat(join(record.path, ".git"))).isDirectory()).toBe(true);
    expect(await readFile(join(record.path, "README"), "utf8")).toBe("dirty tracked\n");
    expect(await readFile(join(record.path, "untracked.txt"), "utf8")).toBe("untracked\n");
    // The restored index is what keeps the copied tree from looking wholly untracked.
    const status = await git(["-C", record.path, "status", "--porcelain"], record.path);
    expect(status.stdout).toContain("M README");
    expect(status.stdout).toContain("?? untracked.txt");
    expect(status.stdout).not.toContain("?? README");
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
      clonefile: false,
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
