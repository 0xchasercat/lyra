import { ProcessHost } from "@lyra/host";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  /**
   * Verbatim from the live session that made this rule: the model held a real job id and, being
   * unable to leave `command` out, sent `job-000005` beside a padded `"true"`. The old rule
   * refused the pair, fired twice, and the job's output was never collected. Both fields filled
   * now means the job wins, and the ignored command is named so a model that meant to run
   * something can resend it alone.
   */
  test("bash collects the job when a real job id arrives beside a padded command", async () => {
    const { registry, context, close } = await fixture();
    try {
      const started = await registry.execute("bash", { command: "printf 'collected'", run_in_background: true }, context);
      const jobId = String(started.metadata?.jobId);
      expect(jobId).toStartWith("job-");

      const collected = await registry.execute("bash", { command: "true", job: jobId, cwd: null, description: "Collect the job", timeoutMs: 30_000 }, context);
      expect(collected.isError).not.toBe(true);
      expect(text(collected)).toContain("collected");
      expect(text(collected)).toContain(`command ignored: collecting ${jobId}`);
      expect(text(collected)).toContain("send it with no job");
      expect(collected.metadata?.ignoredCommand).toBe("true");
    } finally { await close(); }
  });

  /**
   * The other spelling of the same padding, and the one that used to be unreachable.
   *
   * `command: ""` beside a real job id is what the emitter above sends when it has nothing to
   * put in a field it cannot omit. `minLength: 1` refused it in the validator — before
   * `parseArgs` could notice the job and collect it — so the collect path the `job` description
   * documents did not exist for the very caller the padding machinery is there to absorb.
   */
  test("bash collects the job when a blank command is padded beside a real job id", async () => {
    const { registry, context, close } = await fixture();
    try {
      const started = await registry.execute("bash", { command: "printf 'padded'", run_in_background: true }, context);
      const jobId = String(started.metadata?.jobId);

      const collected = await registry.execute("bash", { command: "", cwd: "", timeoutMs: 0, description: "", run_in_background: false, job: jobId }, context);
      expect(collected.isError).not.toBe(true);
      expect(text(collected)).toContain("padded");
      // A blank command was never a command, so there is nothing to report as ignored.
      expect(text(collected)).not.toContain("command ignored");
    } finally { await close(); }
  });

  /** A blank command with no job is a call with nothing to run, and says so in those terms. */
  test("bash teaches instead of failing schema validation on a padded empty command", async () => {
    const { registry, context, close } = await fixture();
    try {
      const result = await registry.execute("bash", { command: "", cwd: "", description: "" }, context);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("command must be a non-empty string");
      expect(text(result)).toContain("pass job to collect the output");
      expect(text(result)).not.toContain("must not be empty —");
    } finally { await close(); }
  });

  test("bash says the command was ignored even when the job id is unknown", async () => {
    const { registry, context, close } = await fixture();
    try {
      const result = await registry.execute("bash", { command: "printf 'hi'", job: "job-000999" }, context);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("job-000999");
      expect(text(result)).toContain("command ignored");
    } finally { await close(); }
  });

  /** Backgrounding a command the model expected to block is a surprise unless it says why. */
  test("bash names the pattern that sent a command to the background", async () => {
    const { registry, context, close } = await fixture();
    try {
      const heavy = await registry.execute("bash", { command: "sleep 3600; printf 'after'" }, context);
      expect(heavy.isError).not.toBe(true);
      expect(text(heavy)).toContain("backgrounded: matched heavy pattern \"sleep\"");
      expect(String(heavy.metadata?.reason)).toContain("sleep");
      // The hour-long job is the classification's proof; collect with a short
      // deadline and expect the still-running answer rather than the output.
      const pending = await registry.execute("bash", { job: String(heavy.metadata?.jobId), timeoutMs: 50 }, context);
      expect(text(pending)).toContain("still running");

      const asked = await registry.execute("bash", { command: "printf 'asked'", run_in_background: true }, context);
      expect(text(asked)).toContain("backgrounded: run_in_background was set");
      await registry.execute("bash", { job: String(asked.metadata?.jobId) }, context);
    } finally { await close(); }
  });

  /**
   * A build and a dev server are both "heavy", and treating them the same taught the model
   * to chase a handle for a build it was about to be handed — and to wait for a server that
   * will never finish. They are told apart by pattern, and the server says so distinctly.
   */
  test("a finite build blocks while a development server is a job that says it will not exit", async () => {
    const { registry, context, close } = await fixture();
    try {
      // Finite: the output *is* the answer, so the call blocks for it.
      const build = await registry.execute("bash", { command: "make --version" }, context);
      expect(text(build)).toContain("exit_code:");
      expect(text(build)).not.toContain("Started bash job");

      const server = await registry.execute("bash", { command: "vite" }, context);
      expect(server.isError).not.toBe(true);
      expect(String(server.metadata?.execution)).toBe("server");
      expect(text(server)).toContain("development server");
      expect(text(server)).toContain("will not exit on its own");
      // Never dressed as a pending build.
      expect(text(server)).not.toContain("backgrounded: matched heavy pattern");
      await registry.execute("bash", { job: String(server.metadata?.jobId), timeoutMs: 2_000 }, context);
    } finally { await close(); }
  });

  /** Delegation that routes around spawn loses the whole observability stack (§3.7). */
  test("a nested lyra --prompt run gets a one-line pointer at spawn", async () => {
    const { registry, context, close } = await fixture();
    try {
      const nested = await registry.execute("bash", { command: "echo lyra --prompt 'PONG' && true" }, context);
      expect(text(nested)).toContain("spawn { task } is the built-in subagent");

      const plain = await registry.execute("bash", { command: "printf 'no note here'" }, context);
      expect(text(plain)).not.toContain("built-in subagent");
      // The word alone is not the pattern: reading about lyra is not running it.
      const mention = await registry.execute("bash", { command: "grep -c lyra README.md 2>/dev/null; true" }, context);
      expect(text(mention)).not.toContain("built-in subagent");
    } finally { await close(); }
  });

  /** JSON-mode emitters stringify scalars; "$args.timeoutMs must be integer" teaches nothing. */
  test("numbers and booleans that arrive as strings are read as what they are", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "numbers.txt"), Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"));
      const ranged = await registry.execute("read", { path: "numbers.txt", startLine: "2", endLine: "3" }, context);
      expect(ranged.isError).not.toBe(true);
      expect(text(ranged)).toContain("line 2");
      expect(text(ranged)).not.toContain("line 4");

      const ran = await registry.execute("bash", { command: "printf 'stringy'", timeout: "30000", run_in_background: "false" }, context);
      expect(ran.isError).not.toBe(true);
      expect(text(ran)).toContain("stringy");

      const grepped = await registry.execute("grep", { pattern: "line", path: root, maxResults: "2" }, context);
      expect(grepped.isError).not.toBe(true);
      expect(text(grepped).split("\n")).toHaveLength(2);
    } finally { await close(); }
  });

  /** A cosmetic UI label must never cost the model its command. */
  test("bash truncates an over-long description instead of refusing the call", async () => {
    const { registry, context, close } = await fixture();
    try {
      const result = await registry.execute("bash", { command: "printf 'labelled'", description: "x".repeat(500) }, context);
      expect(result.isError).not.toBe(true);
      expect(text(result)).toContain("labelled");
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
      // The error names the call that produces the tag it is asking for.
      expect(text(overwrite)).toContain('read({ path: "blank-tag.txt" })');
      expect(text(overwrite)).toContain("#TAG");
    } finally { await close(); }
  });

  /** Creation takes path and content only; the contract says so and the schema agrees. */
  test("write states that tag is only for overwriting a file already read", async () => {
    const { registry, close } = await fixture();
    try {
      const write = registry.definitions().find((definition) => definition.name === "write")!;
      const tag = (write.inputSchema as { properties: Record<string, { description: string }> }).properties.tag;
      expect((write.inputSchema as { required: string[] }).required).toEqual(["path", "content"]);
      expect(tag.description).toContain("omit it when creating");
      expect(write.description).toContain("tag is required just for overwriting");
    } finally { await close(); }
  });

  /**
   * A schema-complete emitter fills every mode's fields at once. Inferring the mode before
   * dropping that padding read `symbol: ""` as a request for an AST edit and refused the
   * search/replace the model actually sent.
   */
  test("edit ignores the other modes' padded fields when inferring the mode", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "padded.ts"), "const value = 1;\n");
      const read = await registry.execute("read", { path: "padded.ts" }, context);
      const tag = text(read).match(/(#[a-f0-9]+)/i)?.[1];
      const result = await registry.execute("edit", {
        mode: "", path: "padded.ts", tag, search: "const value = 1;", replace: "const value = 2;",
        symbol: "", language: "", startLine: 0, endLine: null,
      }, context);
      expect(result.isError).not.toBe(true);
      expect(text(result)).toContain("search_replace");
      expect(await readFile(join(root, "padded.ts"), "utf8")).toBe("const value = 2;\n");
    } finally { await close(); }
  });

  test("grep survives a schema-complete emitter and names a bad flag", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "padded.txt"), "needle here\n");
      const padded = await registry.execute("grep", { pattern: "needle", path: "", flags: "", glob: "", output_mode: "", maxResults: 0, before: 0, after: 0 }, context);
      expect(padded.isError).not.toBe(true);
      expect(text(padded)).toContain("padded.txt:1");

      // "Invalid regular expression" would send the model to fix a pattern that was never wrong.
      const bad = await registry.execute("grep", { pattern: "needle", flags: "gx" }, context);
      expect(bad.isError).toBe(true);
      expect(text(bad)).toContain("\"x\" is not a regular-expression flag");

      // An empty pattern matches every line of every file; no call ever means that, and the
      // refusal carries the field's own documentation instead of a character count.
      const empty = await registry.execute("grep", { pattern: "", path: root }, context);
      expect(empty.isError).toBe(true);
      expect(text(empty)).toContain("$args.pattern must not be empty");
      expect(text(empty)).toContain("regular expression");
    } finally { await close(); }
  });

  /** `*.ts` where `**​/*.ts` was meant is the commonest empty glob; the fix is named, not hinted. */
  test("glob explains a non-recursive pattern that matched nothing", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "deep.ts"), "export const deep = 1;\n");
      const shallow = await registry.execute("glob", { pattern: "*.ts", path: root }, context);
      expect(shallow.isError).not.toBe(true);
      expect(text(shallow)).toContain("**/*.ts");
      expect(text(shallow)).toContain("* stops at one path segment");

      // A pasted absolute pattern is matched against the absolute path too.
      const absolute = await registry.execute("glob", { pattern: `${root}/**/*.ts`, path: root }, context);
      expect(absolute.isError).not.toBe(true);
      expect(text(absolute)).toContain("deep.ts");

      const missing = await registry.execute("glob", { pattern: "**/*.ts", path: "no-such-dir" }, context);
      expect(missing.isError).toBe(true);
      expect(text(missing)).toContain("No such directory");
    } finally { await close(); }
  });

  /** `["git", "status"]` and `"status --short"` both have one honest reading. */
  test("git drops a duplicated executable and splits a command line", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await Bun.spawn(["git", "init", "-q", root], { stdout: "ignore", stderr: "ignore" }).exited;
      const duplicated = await registry.execute("git", { args: ["git", "status", "--short"] }, context);
      expect(duplicated.isError).not.toBe(true);
      expect(text(duplicated)).toContain("args: git status --short");

      const line = await registry.execute("git", { args: "status --short" }, context);
      expect(line.isError).not.toBe(true);
      expect(text(line)).toContain("exit_code: 0");

      // The quoted value stays one argument rather than splitting on its space.
      const set = await registry.execute("git", { command: 'config --local user.name "Lyra Tester"' }, context);
      expect(set.isError).not.toBe(true);
      const got = await registry.execute("git", { args: ["config", "--local", "--get", "user.name"] }, context);
      expect(text(got)).toContain("Lyra Tester");
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

  /**
   * The reverse of the rule this suite used to assert. Declaring every alias legitimized the
   * model's own spelling, but a model on a strict proxy emits *every* declared property, so
   * `path`, `file_path`, and `filePath` side by side taught it to fill all three — its own
   * words: "In my calls I passed multiple aliases defensively... A smaller, stricter API will
   * lead to better tool-call accuracy." The advertised schema is now canonical-only.
   */
  test("no alias is advertised in the schema the model is shown", async () => {
    const { registry, close } = await fixture();
    try {
      const declared = new Map(registry.definitions().map((definition) => [definition.name, Object.keys((definition.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})]));
      const canonical: Record<string, readonly string[]> = {
        read: ["path", "startLine", "endLine"],
        write: ["path", "content", "tag"],
        edit: ["mode", "path", "tag", "search", "replace", "symbol", "language", "startLine", "endLine"],
        bash: ["command", "cwd", "timeoutMs", "description", "run_in_background", "job"],
        grep: ["pattern", "path", "flags", "glob", "maxResults", "before", "after", "output_mode"],
        glob: ["pattern", "path"],
        git: ["args", "cwd", "timeoutMs"],
      };
      for (const [tool, fields] of Object.entries(canonical)) expect(declared.get(tool)).toEqual([...fields]);

      const aliases = ["file_path", "filePath", "start_line", "end_line", "offset", "limit", "view_range", "file_text", "contents", "old_string", "oldString", "old_str", "new_string", "newString", "new_str", "timeout", "timeout_ms", "workdir", "runInBackground", "background", "cmd", "include", "head_limit", "headLimit", "-A", "-B", "-C", "-i", "-n", "outputMode", "directory", "arguments", "command"];
      for (const [tool, fields] of declared) for (const field of fields) {
        if (tool === "bash" && field === "command") continue;
        expect({ tool, field, advertised: aliases.includes(field) }).toEqual({ tool, field, advertised: false });
      }
    } finally { await close(); }
  });

  /** The aliases left the schema; they did not leave the tool. */
  test("foreign spellings still land even though the schema never mentions them", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "kept.ts"), "const value = 1;\n");
      const read = await registry.execute("read", { file_path: "kept.ts" }, context);
      expect(read.isError).not.toBe(true);
      const tag = text(read).match(/(#[a-f0-9]+)/i)?.[1];

      const edited = await registry.execute("edit", { filePath: "kept.ts", old_str: "1", new_str: "2", tag }, context);
      expect(edited.isError).not.toBe(true);

      // The text-editor tool's create spelling for whole-file content.
      const created = await registry.execute("write", { file_path: "made.ts", file_text: "export const made = true;\n" }, context);
      expect(created.isError).not.toBe(true);
      expect(await readFile(join(root, "made.ts"), "utf8")).toContain("made");

      const grepped = await registry.execute("grep", { regex: "value", directory: root, file_pattern: "**/*.ts", limit: 5 }, context);
      expect(grepped.isError).not.toBe(true);
      expect(text(grepped)).toContain("kept.ts");

      const globbed = await registry.execute("glob", { glob: "**/*.ts", dir: root }, context);
      expect(globbed.isError).not.toBe(true);
      expect(text(globbed)).toContain("kept.ts");

      const ran = await registry.execute("bash", { cmd: "printf 'aliased'", working_directory: root }, context);
      expect(ran.isError).not.toBe(true);
      expect(text(ran)).toContain("aliased");
    } finally { await close(); }
  });

  /** The Anthropic text-editor tool spells a range as view_range: [start, end]. */
  test("read accepts view_range and applies a range to artifact text", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "ranged.txt"), Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"));
      const ranged = await registry.execute("read", { path: "ranged.txt", view_range: [3, 4] }, context);
      expect(ranged.isError).not.toBe(true);
      expect(text(ranged)).toContain("line 3");
      expect(text(ranged)).not.toContain("line 5");

      const open = await registry.execute("read", { path: "ranged.txt", view_range: [19, -1] }, context);
      expect(open.isError).not.toBe(true);
      expect(text(open)).toContain("line 20");

      // A range against an artifact used to be accepted and silently ignored (§3.7.5).
      const store = createArtifactStore(root);
      const id = await store.put(new TextEncoder().encode("alpha\nbeta\ngamma\n"), { mimeType: "text/plain", name: "three.txt" });
      const sliced = await registry.execute("read", { path: id, startLine: 2, endLine: 2 }, context);
      expect(sliced.isError).not.toBe(true);
      expect(text(sliced)).toContain("beta");
      expect(text(sliced)).not.toContain("gamma");
    } finally { await close(); }
  });

  /**
   * A range past the end of the file used to be an error, which meant `read({ startLine: 1,
   * endLine: 100 })` failed on an 18-line file — a request for the whole file, refused for
   * being right. It clamps and says so, on every spelling of a range.
   */
  test("a range past the end of a file returns the file, clamped, and says what it clamped", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "short.ts"), Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n"));

      const overshoot = await registry.execute("read", { path: "short.ts", startLine: 1, endLine: 100 }, context);
      expect(overshoot.isError).not.toBe(true);
      expect(text(overshoot)).toContain("[lines 1-18 of 18 — requested 1-100, clamped]");
      expect(text(overshoot)).toContain("[18] line 18");

      // Claude Code's offset/limit is the same request in another spelling, and its default
      // limit is far larger than most files.
      const alias = await registry.execute("read", { file_path: "short.ts", offset: 10, limit: 2000 }, context);
      expect(alias.isError).not.toBe(true);
      expect(text(alias)).toContain("[lines 10-18 of 18 — requested 10-2009, clamped]");
      expect(text(alias)).toContain("[10] line 10");

      // …as is the text-editor tool's view_range.
      const view = await registry.execute("read", { path: "short.ts", view_range: [1, 100] }, context);
      expect(text(view)).toContain("clamped");

      // An exact range says nothing extra.
      const exact = await registry.execute("read", { path: "short.ts", startLine: 2, endLine: 4 }, context);
      expect(text(exact)).not.toContain("clamped");

      // A start past the end has nothing to return, so it is still an error — and one that
      // names the length the model did not know.
      const past = await registry.execute("read", { path: "short.ts", startLine: 40, endLine: 60 }, context);
      expect(past.isError).toBe(true);
      expect(text(past)).toContain("past the end");
      expect(text(past)).toContain("18 lines");

      const backwards = await registry.execute("read", { path: "short.ts", startLine: 9, endLine: 3 }, context);
      expect(backwards.isError).toBe(true);

      // Artifacts and URLs gained ranges recently and follow the same rule.
      const id = await context.artifactStore.put(new TextEncoder().encode("alpha\nbeta\ngamma"), { mimeType: "text/plain", name: "three.txt" });
      const artifact = await registry.execute("read", { path: id, startLine: 1, endLine: 90 }, context);
      expect(artifact.isError).not.toBe(true);
      expect(text(artifact)).toContain("[lines 1-3 of 3 — requested 1-90, clamped]");
      expect(text(artifact)).toContain("gamma");
      const artifactPast = await registry.execute("read", { path: id, startLine: 9 }, context);
      expect(artifactPast.isError).toBe(true);
      expect(text(artifactPast)).toContain("past the end");
    } finally { await close(); }
  });

  /**
   * Observed live: read of a directory returned bare names, indistinguishable from a file's
   * contents, and a line range on it was accepted and ignored.
   */
  test("read labels a directory listing and says the range does not apply", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "one.ts"), "one\n");
      await mkdir(join(root, "nested"));
      const listed = await registry.execute("read", { path: root, startLine: 1, endLine: 2 }, context);
      expect(listed.isError).not.toBe(true);
      expect(text(listed)).toContain(`directory: ${root}`);
      expect(text(listed)).toContain("- one.ts");
      expect(text(listed)).toContain("- nested/");
      expect(text(listed)).toContain("do not apply");
      // Nothing here can be mistaken for the numbered, #TAG-prefixed body of a file.
      expect(text(listed)).not.toMatch(/#[a-f0-9]{6}/i);
    } finally { await close(); }
  });

  /** §3.7.1: ENOENT is not an actionable failure; the near-miss sibling is. */
  test("read and edit name the closest path instead of reporting ENOENT", async () => {
    const { root, registry, context, close } = await fixture();
    try {
      await writeFile(join(root, "auth.ts"), "export const auth = 1;\n");
      const missing = await registry.execute("read", { path: "authh.ts" }, context);
      expect(missing.isError).toBe(true);
      expect(text(missing)).toContain("File not found: authh.ts");
      expect(text(missing)).toContain("Did you mean auth.ts?");
      expect(text(missing)).not.toContain("ENOENT");

      const edited = await registry.execute("edit", { path: "authh.ts", tag: "#abc123", search: "a", replace: "b" }, context);
      expect(edited.isError).toBe(true);
      expect(text(edited)).toContain("Did you mean auth.ts?");
      expect(text(edited)).toContain("write(");
    } finally { await close(); }
  });
});
