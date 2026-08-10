import { ProcessHost } from "@lyra/host";
import { deriveContext } from "@lyra/core";
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  NodeFileSystem,
  ReadTool,
  WriteTool,
  createDefaultToolRegistry,
} from "../src/index.ts";

/** A real, complete 1×1 PNG — small enough to assert on byte for byte. */
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

  test("allows explicit paths across the filesystem while retaining artifact and glob behavior", async () => {
    const { root, store, context } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "lyra-tools-outside-"));
    try {
      await writeFile(join(root, "a.txt"), "alpha\n".repeat(40));
      await writeFile(join(root, "b.ts"), "beta\n");
      await writeFile(join(root, ".gitignore"), "ignored.txt\n");
      await writeFile(join(root, "ignored.txt"), "hidden\n");
      const truncated = await new ReadTool({ root, artifactStore: store, displayBudget: 32 }).execute({ path: "a.txt" }, context);
      expect(truncated.content.toString()).toContain("truncated:");
      const artifact = truncated.content.toString().match(/artifact:\/\/[a-f0-9]{64}/)?.[0];
      expect(artifact).toBeString();
      expect(new TextDecoder().decode(await store.read(artifact!))).toContain("alpha");
      const binaryArtifact = await store.put(new Uint8Array([0xff, 0x00, 0x41]), { mimeType: "application/octet-stream", name: "payload.bin" });
      const binaryRead = await new ReadTool({ root, artifactStore: store }).execute({ path: binaryArtifact }, context);
      expect(binaryRead.isError).toBe(true);
      await writeFile(join(outside, "outside.txt"), "outside content\n");
      const read = await new ReadTool({ root, artifactStore: store }).execute({ path: join(outside, "outside.txt") }, context);
      expect(read.isError).not.toBe(true);
      expect(read.content.toString()).toContain("outside content");
      const write = await new WriteTool({ root, artifactStore: store }).execute({ path: join(outside, "created.txt"), content: "created\n" }, context);
      expect(write.isError).not.toBe(true);
      expect(await readFile(join(outside, "created.txt"), "utf8")).toBe("created\n");
      const invalid = await new GrepTool({ root, artifactStore: store }).execute({ path: ".", pattern: "[" }, context);
      expect(invalid.isError).toBe(true);
      const glob = await new GlobTool({ root, artifactStore: store }).execute({ path: outside, pattern: "**/*.txt" }, context);
      expect(glob.isError).not.toBe(true);
      expect(glob.content.toString()).toContain("outside.txt");
      expect(glob.content.toString()).toContain("created.txt");
    } finally { await Promise.all([dispose(root), dispose(outside)]); }
  });

  test("bash and git follow explicit paths outside the default workspace", async () => {
    const { root, store, context } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "lyra-tools-outside-"));
    const events: unknown[] = [];
    const processes = new ProcessHost();
    const bash = new BashTool({ root, artifactStore: store, processHost: processes, activity: (event) => events.push(event) });
    try {
      const ok = await bash.execute({ command: "printf 'hello'" }, context);
      expect(ok.isError).not.toBe(true);
      expect(ok.content.toString()).toContain("hello");
      const outsidePwd = await bash.execute({ command: "pwd", cwd: outside }, context);
      expect(outsidePwd.isError).not.toBe(true);
      expect(outsidePwd.content.toString()).toContain(outside);
      const bad = await bash.execute({ command: "printf 'bad' >&2; exit 7" }, context);
      expect(bad.isError).toBe(true);
      expect(bad.content.toString()).toContain("exit_code: 7");
      const heavy = await bash.execute({ command: "sleep 3600" }, context);
      expect(heavy.metadata).toMatchObject({ heavy: true });
      const jobId = String(heavy.metadata?.jobId);
      expect(jobId).toStartWith("job-");
      // An hour-long job proves the classification; nobody waits for it.
      await processes.cancel(jobId);
      await command(["git", "init", "-q", root]);
      await command(["git", "init", "-q", outside]);
      await writeFile(join(root, "tracked.txt"), "tracked\n");
      const git = new GitTool({ root, artifactStore: store, activity: (event) => events.push(event) });
      const status = await git.execute({ args: ["status", "--short"] }, context);
      expect(status.isError).not.toBe(true);
      expect(status.content.toString()).toContain("tracked.txt");
      const outsideStatus = await git.execute({ args: ["status", "--short"], cwd: outside }, context);
      expect(outsideStatus.isError).not.toBe(true);
      const activity = events as Array<{ type?: string }>;
      expect(activity.some((event) => event.type === "git_started")).toBe(true);
    } finally { await processes.close(); await Promise.all([dispose(root), dispose(outside)]); }
  });

  test("git follows an in-workspace cwd symlink to another repository", async () => {
    const { root, store, context } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "lyra-tools-outside-"));
    try {
      await command(["git", "init", "-q", outside]);
      await symlink(outside, join(root, "external-repo"), "dir");
      const result = await new GitTool({ root, artifactStore: store }).execute({ args: ["status"], cwd: "external-repo" }, context);
      expect(result.isError).not.toBe(true);
    } finally { await Promise.all([dispose(root), dispose(outside)]); }
  });

  test("atomic writes preserve an existing file's mode and clean up after a failed rename", async () => {
    const { root, store, context } = await fixture();
    try {
      const script = join(root, "run.sh");
      await writeFile(script, "echo one\n");
      await chmod(script, 0o755);
      const read = await new ReadTool({ root, artifactStore: store }).execute({ path: "run.sh" }, context);
      const tag = read.content.toString().match(/(#[a-f0-9]+)/i)?.[1];
      const edit = await new EditTool({ root, artifactStore: store }).execute({ mode: "search_replace", path: "run.sh", tag, search: "one", replace: "two" }, context);
      expect(edit.isError).not.toBe(true);
      expect(await readFile(script, "utf8")).toBe("echo two\n");
      expect((await stat(script)).mode & 0o777).toBe(0o755);
      const created = await new WriteTool({ root, artifactStore: store }).execute({ path: "fresh.txt", content: "fresh\n" }, context);
      expect(created.isError).not.toBe(true);
      expect((await stat(join(root, "fresh.txt"))).mode & 0o777).toBe(0o600);
      const blocked = join(root, "as-directory");
      await mkdir(blocked);
      await expect(new NodeFileSystem().writeAtomic(blocked, "content\n")).rejects.toThrow();
      expect((await readdir(root)).filter((entry) => entry.startsWith("as-directory."))).toEqual([]);
    } finally { await dispose(root); }
  });

  test("grep skips binary files instead of abandoning the search", async () => {
    const { root, store, context } = await fixture();
    try {
      // Sorts before the text file, so the old abort-on-first-binary path would have hidden the match entirely.
      await writeFile(join(root, "a-payload.bin"), new Uint8Array([0x00, 0xff, 0x41, 0x00]));
      await writeFile(join(root, "z-notes.txt"), "needle here\n");
      const result = await new GrepTool({ root, artifactStore: store }).execute({ path: ".", pattern: "needle" }, context);
      expect(result.isError).not.toBe(true);
      expect(result.content.toString()).toContain("z-notes.txt:1: needle here");
      expect(result.content.toString()).toContain("skipped 1 binary file");
      expect(result.content.toString()).toContain("a-payload.bin");
    } finally { await dispose(root); }
  });

  test("gitignore rules stop at the repository root and the deepest file wins", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-tools-ignore-"));
    try {
      const repo = join(root, "repo");
      const nested = join(repo, "nested");
      await mkdir(join(repo, ".git"), { recursive: true });
      await mkdir(nested, { recursive: true });
      await writeFile(join(root, ".gitignore"), "above.txt\n");
      await writeFile(join(repo, ".gitignore"), "shared.txt\n");
      await writeFile(join(repo, "above.txt"), "above\n");
      await writeFile(join(repo, "shared.txt"), "shared\n");
      await writeFile(join(nested, ".gitignore"), "!shared.txt\n");
      await writeFile(join(nested, "shared.txt"), "nested shared\n");
      const base = { signal: new AbortController().signal, sessionId: "ignore-test", callId: "call-ignore" };
      const repoStore = createArtifactStore(repo);
      const fromRepo = await new GlobTool({ root: repo, artifactStore: repoStore })
        .execute({ pattern: "*.txt" }, { ...base, workspace: repo, cwd: repo, origin: repo, artifactStore: repoStore } as any);
      expect(fromRepo.isError).not.toBe(true);
      // A .gitignore above the repository root is never consulted, so above.txt stays visible.
      expect(fromRepo.content.toString().split("\n")).toContain("above.txt");
      expect(fromRepo.content.toString().split("\n")).not.toContain("shared.txt");
      const nestedStore = createArtifactStore(nested);
      const fromNested = await new GlobTool({ root: nested, artifactStore: nestedStore })
        .execute({ pattern: "*.txt" }, { ...base, workspace: nested, cwd: nested, origin: nested, artifactStore: nestedStore } as any);
      expect(fromNested.isError).not.toBe(true);
      // The nested negation is the deepest rule, so it overrides the repository root's ignore.
      expect(fromNested.content.toString().split("\n")).toContain("shared.txt");
    } finally { await dispose(root); }
  });

  test("bash accepts the description field models habitually send, and ignores it", async () => {
    // Models trained on other harnesses attach a `description` to bash calls; rejecting
    // it costs retries (LYRA.md §3.7 — a misused tool is the tool's defect). It is
    // accepted as display metadata and has no effect on execution.
    const { root, store, context } = await fixture();
    try {
      const registry = createDefaultToolRegistry({ filesystem: { root, artifactStore: store }, bash: { root, artifactStore: store }, git: { root, artifactStore: store } });
      const result = await registry.execute("bash", { command: "printf 'described'", description: "List files in the project" }, context);
      expect(result.isError).not.toBe(true);
      expect(result.content).toContain("described");
    } finally { await dispose(root); }
  });

  /**
   * The browser rail: a screenshot spilled to an artifact has to arrive at a vision model as
   * a picture, or the artifact is a dead end. It used to be measured against the 32 KiB text
   * display budget — smaller than any real screenshot — and the refusal pointed at an
   * artifact whose own read produced the same refusal.
   */
  test("an image artifact reads back as an image, and an oversized one refuses with a way out", async () => {
    const { root, store, context } = await fixture();
    try {
      const png = new Uint8Array(Buffer.from(ONE_PIXEL_PNG, "base64"));
      const id = await store.put(png, { mimeType: "image/png", name: "screenshot.png" });
      const read = new ReadTool({ root, artifactStore: store });

      const result = await read.execute({ path: id }, context);
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: "image", mediaType: "image/png", data: ONE_PIXEL_PNG }]);

      // 200 KiB is an ordinary screenshot, and far past the text display budget.
      const large = new Uint8Array(200 * 1024);
      large.set(png);
      const largeId = await store.put(large, { mimeType: "image/png", name: "big.png" });
      const larger = await read.execute({ path: largeId }, context);
      expect(Array.isArray(larger.content)).toBe(true);
      expect((larger.content as Array<{ type: string }>)[0]?.type).toBe("image");

      // Above the §3.6 limit there is no honest picture to send — no image library, and a
      // truncated PNG is a corrupt file, not a preview — so the refusal is actionable.
      const strict = new ReadTool({ root, artifactStore: store, imageByteLimit: 1024 });
      const refused = await strict.execute({ path: largeId }, context);
      expect(typeof refused.content).toBe("string");
      expect(String(refused.content)).toContain("image not sent");
      expect(String(refused.content)).toContain(largeId);
      expect(String(refused.content)).toContain("resize");

      // A non-image binary artifact keeps today's refusal exactly.
      const blob = await store.put(new Uint8Array([0, 1, 2, 3, 255]), { mimeType: "application/octet-stream", name: "blob.bin" });
      const binary = await read.execute({ path: blob }, context);
      expect(binary.isError).toBe(true);
      expect(String(binary.content)).toContain("binary");
    } finally { await dispose(root); }
  });

  test("an image tool result survives into the derived provider request as an image block", async () => {
    const { root, store, context } = await fixture();
    try {
      const id = await store.put(new Uint8Array(Buffer.from(ONE_PIXEL_PNG, "base64")), { mimeType: "image/png", name: "shot.png" });
      const result = await new ReadTool({ root, artifactStore: store }).execute({ path: id }, context);
      const entries = [
        { id: "e1", type: "message", role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read", input: { path: id } }], status: "complete" },
        { id: "e2", type: "message", role: "user", content: [{ type: "tool_result", toolUseId: "call-1", content: result.content }], status: "complete" },
      ];
      const derived = deriveContext(entries as any, { model: "m", system: "s", apiType: "anthropic_messages", tools: [], contextWindow: 100_000 });
      const block = derived.request.messages.at(-1)!.content[0] as { type: string; content: unknown };
      expect(block.type).toBe("tool_result");
      expect(block.content).toEqual([{ type: "image", mediaType: "image/png", data: ONE_PIXEL_PNG }]);
      expect(derived.repairs).toEqual([]);
    } finally { await dispose(root); }
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
