import { ProcessHost } from "@lyra/host";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BashTool,
  createArtifactStore,
  EditTool,
  FileArtifactStore,
  GitTool,
  GlobTool,
  GrepTool,
  ReadTool,
  WriteTool,
  createDefaultToolRegistry,
} from "../src/index.ts";

async function command(args: string[], cwd?: string): Promise<number> {
  const child = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "ignore" });
  return await child.exited;
}

async function fixture(): Promise<{ root: string; store: FileArtifactStore; context: any }> {
  const root = await mkdtemp(join(tmpdir(), "lyra-tools-"));
  const store = createArtifactStore(root);
  const context = {
    signal: new AbortController().signal,
    sessionId: "tool-test",
    workspace: root,
    callId: "call-test",
    cwd: root,
    origin: root,
    artifactStore: store,
  };
  return { root, store, context };
}

async function dispose(root: string): Promise<void> { await rm(root, { recursive: true, force: true }); }

describe("core tool behavior", () => {
  test("read → tagged edit → stale refusal → guarded write", async () => {
    const { root, store, context } = await fixture();
    try {
      await writeFile(join(root, "main.ts"), "const value = 1;\n");
      const read = await new ReadTool({ root, artifactStore: store }).execute({ path: "main.ts" }, context);
      expect(read.isError).not.toBe(true);
      const tag = read.content.toString().match(/(#[a-f0-9]+)/i)?.[1];
      expect(tag).toBeString();
      const edit = await new EditTool({ root, artifactStore: store }).execute({ mode: "search_replace", path: "main.ts", tag, search: "1", replace: "2" }, context);
      expect(edit.isError).not.toBe(true);
      await writeFile(join(root, "main.ts"), "const value = 3;\n");
      const stale = await new EditTool({ root, artifactStore: store }).execute({ mode: "search_replace", path: "main.ts", tag, search: "3", replace: "4" }, context);
      expect(stale.isError).toBe(true);
      const newRead = await new ReadTool({ root, artifactStore: store }).execute({ path: "main.ts" }, context);
      const newTag = newRead.content.toString().match(/(#[a-f0-9]+)/i)?.[1];
      const write = await new WriteTool({ root, artifactStore: store }).execute({ path: "new.txt", content: "created\n" }, context);
      expect(write.isError).not.toBe(true);
      expect(await readFile(join(root, "new.txt"), "utf8")).toBe("created\n");
      expect(newTag).toBeString();
    } finally { await dispose(root); }
  });

  test("path escapes, malformed regex, deterministic glob, and artifact truncation are explicit", async () => {
    const { root, store, context } = await fixture();
    try {
      await writeFile(join(root, "a.txt"), "alpha\n".repeat(40));
      await writeFile(join(root, "b.ts"), "beta\n");
      await writeFile(join(root, ".gitignore"), "ignored.txt\n");
      await writeFile(join(root, "ignored.txt"), "hidden\n");
      const read = await new ReadTool({ root, artifactStore: store, displayBudget: 32 }).execute({ path: "a.txt" }, context);
      expect(read.content.toString()).toContain("truncated:");
      const artifact = read.content.toString().match(/artifact:\/\/[a-f0-9]{64}/)?.[0];
      expect(artifact).toBeString();
      const artifactContent = new TextDecoder().decode(await store.read(artifact!));
      expect(artifactContent).toContain("[a.txt");
      expect(artifactContent.length).toBeGreaterThan(32);
      const binaryArtifact = await store.put(new Uint8Array([0xff, 0x00, 0x41]), { mimeType: "application/octet-stream", name: "payload.bin" });
      const binaryRead = await new ReadTool({ root, artifactStore: store }).execute({ path: binaryArtifact }, context);
      expect(binaryRead.isError).toBe(true);
      expect(binaryRead.content.toString()).toContain(binaryArtifact);
      expect([...await store.read(binaryArtifact)]).toEqual([0xff, 0x00, 0x41]);
      const escape = await new ReadTool({ root, artifactStore: store }).execute({ path: "../outside.txt" }, context);
      expect(escape.isError).toBe(true);
      const invalid = await new GrepTool({ root, artifactStore: store }).execute({ path: ".", pattern: "[" }, context);
      expect(invalid.isError).toBe(true);
      const glob = await new GlobTool({ root, artifactStore: store }).execute({ path: ".", pattern: "**/*.ts" }, context);
      expect(glob.isError).not.toBe(true);
      expect(glob.content.toString()).toContain("b.ts");
      expect(glob.content.toString()).not.toContain("ignored.txt");
    } finally { await dispose(root); }
  });

  test("bash and git preserve status, errors, and destructive activity", async () => {
    const { root, store, context } = await fixture();
    const events: unknown[] = [];
    const processes = new ProcessHost();
    const bash = new BashTool({ root, artifactStore: store, processHost: processes, activity: (event) => events.push(event) });
    try {
      const ok = await bash.execute({ command: "printf 'hello'" }, context);
      expect(ok.isError).not.toBe(true);
      expect(ok.content.toString()).toContain("hello");
      const bad = await bash.execute({ command: "printf 'bad' >&2; exit 7" }, context);
      expect(bad.isError).toBe(true);
      expect(bad.content.toString()).toContain("exit_code: 7");
      const heavy = await bash.execute({ command: "sleep 0.01" }, context);
      expect(heavy.metadata).toMatchObject({ heavy: true });
      const jobId = String(heavy.metadata?.jobId);
      expect(jobId).toStartWith("job-");
      await processes.wait(jobId);
      await command(["git", "init", "-q", root]);
      await writeFile(join(root, "tracked.txt"), "tracked\n");
      const git = new GitTool({ root, artifactStore: store, activity: (event) => events.push(event) });
      const status = await git.execute({ args: ["status", "--short"] }, context);
      expect(status.isError).not.toBe(true);
      expect(status.content.toString()).toContain("tracked.txt");
      const invalid = await git.execute({ args: ["status"], cwd: "../" }, context);
      expect(invalid.isError).toBe(true);
      const activity = events as Array<{ type?: string }>;
      expect(activity.some((event) => event.type === "git_started")).toBe(true);
    } finally { await processes.close(); await dispose(root); }
  });

  test("git refuses an in-workspace cwd symlink targeting another repository", async () => {
    const { root, store, context } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "lyra-tools-outside-"));
    try {
      await command(["git", "init", "-q", outside]);
      await symlink(outside, join(root, "external-repo"), "dir");
      const result = await new GitTool({ root, artifactStore: store }).execute({ args: ["status"], cwd: "external-repo" }, context);
      expect(result.isError).toBe(true);
      expect(result.content.toString()).toContain("escapes the workspace");
    } finally { await Promise.all([dispose(root), dispose(outside)]); }
  });

  test("default registry never throws for malformed inputs", async () => {
    const { root, store, context } = await fixture();
    try {
      const registry = createDefaultToolRegistry({ filesystem: { root, artifactStore: store }, bash: { root, artifactStore: store }, git: { root, artifactStore: store } });
      expect(registry.definitions().map((definition) => definition.name)).toEqual(["read", "write", "edit", "bash", "grep", "glob", "git"]);
      for (const name of registry.definitions().map((definition) => definition.name)) {
        for (const input of [null, 1, "bad", [], { unknown: true }]) {
          const result = await registry.execute(name, input, context);
          expect(result).toBeObject();
          expect(typeof result.content).toBe("string");
          expect(result.isError).toBe(true);
        }
      }
    } finally { await dispose(root); }
  });
});
