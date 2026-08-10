import { ProcessHost } from "@lyra/host";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactStore, createDefaultToolRegistry, type ToolRegistry } from "../src/index.ts";

/**
 * LYRA.md §3.7: a model that misuses a tool is reporting a defect in the tool. Every case
 * here is the *first* call a model trained on another harness would make — Claude Code's
 * `file_path` / `old_string` / `timeout`, ripgrep's `-i` / `-C`, the camelCase spellings —
 * spelled verbatim. They must either land, or come back with an error that teaches the call.
 */

async function fixture(): Promise<{ root: string; registry: ToolRegistry; context: any; close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "lyra-first-call-"));
  const store = createArtifactStore(root);
  const processes = new ProcessHost();
  const registry = createDefaultToolRegistry({
    filesystem: { root, artifactStore: store },
    bash: { root, artifactStore: store, processHost: processes },
    git: { root, artifactStore: store },
  });
  const context = { signal: new AbortController().signal, sessionId: "first-call", workspace: root, callId: "call-1", cwd: root, origin: root, artifactStore: store };
  return { root, registry, context, close: async () => { await processes.close(); await registry.close(); await rm(root, { recursive: true, force: true }); } };
}

function text(result: { content: unknown }): string { return String(result.content); }

describe("first-call ergonomics", () => {
  test("read accepts Claude Code's file_path, offset, and limit", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "main.ts"), Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"));
      const whole = await registry.execute("read", { file_path: "main.ts" }, context);
      expect(whole.isError).not.toBe(true);
      expect(text(whole)).toContain("line 1");

      const ranged = await registry.execute("read", { file_path: "main.ts", offset: 10, limit: 3 }, context);
      expect(ranged.isError).not.toBe(true);
      expect(text(ranged)).toContain("line 10");
      expect(text(ranged)).toContain("line 12");
      expect(text(ranged)).not.toContain("line 13");

      // offset omitted means the range starts at line 1, exactly as Claude Code behaves.
      const capped = await registry.execute("read", { filePath: "main.ts", limit: 2 }, context);
      expect(capped.isError).not.toBe(true);
      expect(text(capped)).toContain("line 2");
      expect(text(capped)).not.toContain("line 3");

      const snake = await registry.execute("read", { path: "main.ts", start_line: 5, end_line: 6 }, context);
      expect(snake.isError).not.toBe(true);
      expect(text(snake)).toContain("line 5");
      expect(text(snake)).not.toContain("line 7");
    } finally { await close(); }
  });

  test("write accepts filePath and file_path", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      const camel = await registry.execute("write", { filePath: "camel.txt", content: "camel\n" }, context);
      expect(camel.isError).not.toBe(true);
      expect(await readFile(join(root, "camel.txt"), "utf8")).toBe("camel\n");

      const snake = await registry.execute("write", { file_path: "snake.txt", content: "snake\n" }, context);
      expect(snake.isError).not.toBe(true);
      expect(await readFile(join(root, "snake.txt"), "utf8")).toBe("snake\n");
    } finally { await close(); }
  });

  test("edit accepts file_path, old_string, new_string with no mode", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "app.ts"), "const value = 1;\n");
      const read = await registry.execute("read", { file_path: "app.ts" }, context);
      const tag = text(read).match(/(#[a-f0-9]+)/i)?.[1];
      expect(tag).toBeString();

      const edit = await registry.execute("edit", { file_path: "app.ts", old_string: "const value = 1;", new_string: "const value = 2;", tag }, context);
      expect(edit.isError).not.toBe(true);
      expect(await readFile(join(root, "app.ts"), "utf8")).toBe("const value = 2;\n");
      expect(text(edit)).toContain("search_replace");
    } finally { await close(); }
  });

  test("edit infers line_range and ast_symbol from the fields sent", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "lines.txt"), "one\ntwo\nthree\n");
      const read = await registry.execute("read", { path: "lines.txt" }, context);
      const tag = text(read).match(/(#[a-f0-9]+)/i)?.[1];
      const ranged = await registry.execute("edit", { path: "lines.txt", tag, start_line: 2, end_line: 2, replace: "TWO" }, context);
      expect(ranged.isError).not.toBe(true);
      expect(await readFile(join(root, "lines.txt"), "utf8")).toBe("one\nTWO\nthree\n");
    } finally { await close(); }
  });

  test("edit teaches instead of accepting replace_all", async () => {
    const { registry, context, close } = await fixture();
    try {
      const result = await registry.execute("edit", { file_path: "app.ts", old_string: "a", new_string: "b", replace_all: true, tag: "#abc" }, context);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("replace_all is not supported");
      expect(text(result)).toContain("match exactly once");
    } finally { await close(); }
  });

  test("edit names read as the source of the #TAG it requires", async () => {
    const { registry, context, close } = await fixture();
    try {
      const result = await registry.execute("edit", { file_path: "app.ts", old_string: "a", new_string: "b" }, context);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("tag");
      expect(text(result)).toContain("read");
    } finally { await close(); }
  });

  test("bash accepts description, timeout, and run_in_background", async () => {
    const { registry, context, close } = await fixture();
    try {
      const described = await registry.execute("bash", { command: "printf 'hi'", description: "Say hi", timeout: 30_000 }, context);
      expect(described.isError).not.toBe(true);
      expect(text(described)).toContain("hi");

      const background = await registry.execute("bash", { command: "printf 'later'", run_in_background: true }, context);
      expect(background.isError).not.toBe(true);
      const jobId = String(background.metadata?.jobId);
      expect(jobId).toStartWith("job-");
      // A job handle the model cannot collect would be a dead end (§3.7 F6).
      expect(text(background)).toContain(`bash({ job: "${jobId}" })`);

      const collected = await registry.execute("bash", { job: jobId }, context);
      expect(collected.isError).not.toBe(true);
      expect(text(collected)).toContain("later");
    } finally { await close(); }
  });

  test("bash accepts Codex's argv array, workdir, and timeout_ms", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      const wrapped = await registry.execute("bash", { command: ["bash", "-lc", "printf 'wrapped'"], workdir: root, timeout_ms: 30_000 }, context);
      expect(wrapped.isError).not.toBe(true);
      expect(text(wrapped)).toContain("wrapped");

      // A bare argv joins back with quoting, so an argument containing spaces survives.
      const bare = await registry.execute("bash", { command: ["printf", "two words"] }, context);
      expect(bare.isError).not.toBe(true);
      expect(text(bare)).toContain("two words");
    } finally { await close(); }
  });

  test("bash rejects an unknown job id by name", async () => {
    const { registry, context, close } = await fixture();
    try {
      const result = await registry.execute("bash", { job: "job-zzzzzz" }, context);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("job-zzzzzz");
    } finally { await close(); }
  });

  /**
   * Verbatim from a live session: subrouter/gpt-5.6-terra behind an openai_completions proxy
   * emitted every declared property on every call. `job` was declared as a non-empty string,
   * so the emitter could not leave it out and padded it — "?", "x", ".", ".undefined" — which
   * flipped bash into collection mode. The model could not stop sending `job`, so it replayed
   * the identical failing call until the turn was cancelled.
   */
  test("bash runs when a schema-complete proxy pads every declared field", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "marker.txt"), "marker\n");
      for (const padding of ["?", "x", ".", ".undefined", "", "   ", null]) {
        const result = await registry.execute("bash", {
          command: "ls -a",
          cwd: root,
          description: "Inspect starter workspace files and project setup.",
          job: padding,
          runInBackground: false,
          run_in_background: false,
          timeout: 10_000,
          timeoutMs: 10_000,
          timeout_ms: 10_000,
          workdir: root,
        }, context);
        expect(result.isError).not.toBe(true);
        expect(text(result)).toContain("marker.txt");
      }
    } finally { await close(); }
  });

  test("bash treats a null optional field as an omitted one", async () => {
    const { registry, context, close } = await fixture();
    try {
      const result = await registry.execute("bash", { command: "printf 'nulls'", cwd: null, description: null, job: null, timeoutMs: null, timeout: null, run_in_background: null }, context);
      expect(result.isError).not.toBe(true);
      expect(text(result)).toContain("nulls");
    } finally { await close(); }
  });

  test("bash still refuses a real job id sent alongside a command", async () => {
    const { registry, context, close } = await fixture();
    try {
      const result = await registry.execute("bash", { command: "printf 'hi'", job: "job-000001" }, context);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("job-000001");
      expect(text(result)).toContain("command");
    } finally { await close(); }
  });

  /**
   * The same schema-complete emitter padded write's optional `tag` with "#000000" on a first
   * write into a directory that did not exist yet. The tag turned the ENOENT that means "new
   * file" into "Unable to verify ... Re-read and retry" — advice no model can follow for a
   * path with no file at it, so the component was never created.
   */
  test("write creates a new file when a padded tag arrives with it", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      const nested = await registry.execute("write", { path: "components/TestStatusCard.tsx", filePath: "components/TestStatusCard.tsx", file_path: "components/TestStatusCard.tsx", content: "export const Card = () => null;\n", tag: "#000000" }, context);
      expect(nested.isError).not.toBe(true);
      expect(await readFile(join(root, "components/TestStatusCard.tsx"), "utf8")).toContain("Card");

      const blank = await registry.execute("write", { path: "blank-tag.txt", content: "blank\n", tag: "" }, context);
      expect(blank.isError).not.toBe(true);
      expect(await readFile(join(root, "blank-tag.txt"), "utf8")).toBe("blank\n");

      // The guard that matters is untouched: an existing file still needs its real tag.
      const overwrite = await registry.execute("write", { path: "blank-tag.txt", content: "again\n", tag: "#000000" }, context);
      expect(overwrite.isError).toBe(true);
      expect(text(overwrite)).toContain("read it first");
    } finally { await close(); }
  });

  test("glob and grep say so when nothing matched", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "only.txt"), "nothing interesting\n");
      const globbed = await registry.execute("glob", { pattern: "**/*.tsx", path: root }, context);
      expect(globbed.isError).not.toBe(true);
      expect(text(globbed)).toContain("**/*.tsx");
      expect(text(globbed).trim()).not.toBe("");

      const grepped = await registry.execute("grep", { pattern: "needle", path: root }, context);
      expect(grepped.isError).not.toBe(true);
      expect(text(grepped)).toContain("needle");
      expect(text(grepped).trim()).not.toBe("");
    } finally { await close(); }
  });

  test("grep accepts -i, -C, include, head_limit, and output_mode", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "notes.md"), "alpha\nNEEDLE here\nbeta\n");
      await writeFile(join(root, "other.txt"), "needle twice\nneedle again\n");

      const insensitive = await registry.execute("grep", { pattern: "needle", "-i": true }, context);
      expect(insensitive.isError).not.toBe(true);
      expect(text(insensitive)).toContain("notes.md:2");

      const contextual = await registry.execute("grep", { pattern: "NEEDLE", "-C": 1 }, context);
      expect(contextual.isError).not.toBe(true);
      expect(text(contextual)).toContain("notes.md:1: alpha");
      expect(text(contextual)).toContain("notes.md:3: beta");

      const included = await registry.execute("grep", { pattern: "needle", include: "**/*.txt" }, context);
      expect(included.isError).not.toBe(true);
      expect(text(included)).toContain("other.txt");
      expect(text(included)).not.toContain("notes.md");

      const limited = await registry.execute("grep", { pattern: "needle", head_limit: 1 }, context);
      expect(limited.isError).not.toBe(true);
      expect(text(limited).split("\n")).toHaveLength(1);

      const files = await registry.execute("grep", { pattern: "needle", "-i": true, output_mode: "files_with_matches" }, context);
      expect(files.isError).not.toBe(true);
      expect(text(files).split("\n").sort()).toEqual(["notes.md", "other.txt"]);

      const counts = await registry.execute("grep", { pattern: "needle", output_mode: "count" }, context);
      expect(counts.isError).not.toBe(true);
      expect(text(counts)).toBe("other.txt:2");
    } finally { await close(); }
  });

  test("grep teaches the Lyra spelling for multiline, type, and -n false", async () => {
    const { registry, context, close } = await fixture();
    try {
      const multiline = await registry.execute("grep", { pattern: "a.b", multiline: true }, context);
      expect(multiline.isError).toBe(true);
      expect(text(multiline)).toContain("one line at a time");

      const typed = await registry.execute("grep", { pattern: "a", type: "ts" }, context);
      expect(typed.isError).toBe(true);
      expect(text(typed)).toContain("glob");

      const unnumbered = await registry.execute("grep", { pattern: "a", "-n": false }, context);
      expect(unnumbered.isError).toBe(true);
      expect(text(unnumbered)).toContain("files_with_matches");
    } finally { await close(); }
  });

  test("glob already matches the Claude Code spelling", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "found.ts"), "export const x = 1;\n");
      const result = await registry.execute("glob", { pattern: "**/*.ts", path: root }, context);
      expect(result.isError).not.toBe(true);
      expect(text(result)).toContain("found.ts");
    } finally { await close(); }
  });

  test("git accepts timeout as the millisecond deadline", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await Bun.spawn(["git", "init", "-q", root], { stdout: "ignore", stderr: "ignore" }).exited;
      const result = await registry.execute("git", { args: ["status", "--short"], timeout: 30_000 }, context);
      expect(result.isError).not.toBe(true);
      expect(text(result)).toContain("exit_code: 0");
    } finally { await close(); }
  });

  test("a canonical field and its alias disagreeing is refused by name", async () => {
    const { registry, context, close } = await fixture();
    try {
      const read = await registry.execute("read", { path: "a.txt", file_path: "b.txt" }, context);
      expect(read.isError).toBe(true);
      expect(text(read)).toContain("path");
      expect(text(read)).toContain("file_path");

      const edit = await registry.execute("edit", { path: "a.txt", tag: "#a1", replace: "x", new_string: "y", old_string: "z" }, context);
      expect(edit.isError).toBe(true);
      expect(text(edit)).toContain("new_string");

      const bash = await registry.execute("bash", { command: "true", timeoutMs: 1000, timeout: 2000 }, context);
      expect(bash.isError).toBe(true);
      expect(text(bash)).toContain("timeoutMs");
      expect(text(bash)).toContain("timeout");

      const ranged = await registry.execute("read", { path: "a.txt", startLine: 1, endLine: 99, limit: 3 }, context);
      expect(ranged.isError).toBe(true);
      expect(text(ranged)).toContain("limit");
    } finally { await close(); }
  });

  test("a matching alias and canonical pair is not a conflict", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "same.txt"), "same\n");
      const result = await registry.execute("read", { path: "same.txt", file_path: "same.txt" }, context);
      expect(result.isError).not.toBe(true);
      expect(text(result)).toContain("same");
    } finally { await close(); }
  });

  test("an undocumented field is refused with the documented field list inline", async () => {
    const { registry, context, close } = await fixture();
    try {
      const result = await registry.execute("write", { path: "x.txt", content: "x", encoding: "utf8" }, context);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("encoding is not recognized");
      expect(text(result)).toContain("this tool takes: path, content, tag");
    } finally { await close(); }
  });

  test("every alias is declared in the schema the model is shown", async () => {
    const { registry, close } = await fixture();
    try {
      const declared = new Map(registry.definitions().map((definition) => [definition.name, Object.keys((definition.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})]));
      const expected: Record<string, readonly string[]> = {
        read: ["file_path", "filePath", "start_line", "end_line", "offset", "limit"],
        write: ["file_path", "filePath"],
        edit: ["file_path", "filePath", "old_string", "oldString", "new_string", "newString", "start_line", "end_line"],
        bash: ["timeout", "timeout_ms", "workdir", "description", "run_in_background", "runInBackground", "job"],
        grep: ["include", "head_limit", "headLimit", "-A", "-B", "-C", "-i", "-n", "output_mode"],
        git: ["timeout"],
      };
      for (const [tool, fields] of Object.entries(expected)) for (const field of fields) expect(declared.get(tool)).toContain(field);
    } finally { await close(); }
  });
});
