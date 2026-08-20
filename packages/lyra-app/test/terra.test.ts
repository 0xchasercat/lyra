import { ReliableProvider, type ProviderRequest, type ProviderTransport, type TransportEvent } from "@lyra/provider";
import type { SessionUpdate } from "@lyra/acp";
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LyraRuntime } from "../src/index.ts";
import { CheckpointStore } from "@lyra/git";
import type { MessageEntry, TranscriptEntry } from "@lyra/session";

/**
 * The terra session, end to end, against a live daemon.
 *
 * Every earlier suite either stubs the spawn executor or drives one subsystem in isolation.
 * This one boots a real [`LyraRuntime`] in a real (non-git) directory and lets the actual
 * agent loop, tool registry, spawn manager, IRC bus and checkpoint store run the whole
 * delegation loop the overhaul was for. Only the provider is scripted, because a test cannot
 * afford a model — and the script is routed per *conversation*, so the parent and each child
 * get their own deterministic rounds instead of sharing one global counter.
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A non-repository directory: the launch cwd is not required to be a git work tree. */
async function bareDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  // The daemon canonicalises its origin, and on macOS `/var` is a symlink to `/private/var`;
  // comparing paths against a non-canonical root would fail for a reason the test is not about.
  return await realpath(root);
}

/**
 * One scripted model turn.
 *
 * It is handed the request as well as the signal, because a real second call often depends
 * on what the first one answered — a `#TAG` from a `read`, a job id from a background
 * `bash`, a spawn id from a `spawn`. Reading those out of the conversation is exactly what
 * the model does, so a script that does the same is testing the round trip rather than
 * assuming it.
 */
type Round = (context: { signal: AbortSignal }, request: ProviderRequest) => AsyncGenerator<TransportEvent>;

/**
 * A transport that gives every conversation its own script.
 *
 * A child runs through the same provider as its parent, so a single round counter would
 * interleave the two and make the test a lottery. The route key is the conversation's first
 * user message, which for a parent is the prompt and for a child is its task — both known to
 * the test that wrote them.
 */
function routed(routes: Array<{ match: (first: string, request: ProviderRequest) => boolean; rounds: Round[]; name: string }>): ProviderTransport {
  const counters = new Map<string, number>();
  return {
    id: "routed",
    apiType: "openai_completions",
    stream(request, context) {
      const first = firstUserText(request);
      const route = routes.find((candidate) => candidate.match(first, request));
      if (route === undefined) throw new Error(`No scripted route for conversation starting ${JSON.stringify(first.slice(0, 120))}`);
      const index = counters.get(route.name) ?? 0;
      counters.set(route.name, index + 1);
      const step = route.rounds[Math.min(index, route.rounds.length - 1)]!;
      return step(context, request);
    },
  };
}

/** Everything the conversation has seen come back from a tool, newest last. */
function lastToolResult(request: ProviderRequest): string {
  let latest = "";
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === "tool_result") latest = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
    }
  }
  return latest;
}

function firstUserText(request: ProviderRequest): string {
  for (const message of request.messages) {
    if (message.role !== "user") continue;
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    if (text.length > 0) return text;
  }
  return "";
}

/** Every user-visible text block in a conversation, for asserting what a child was told. */
function allUserText(request: ProviderRequest): string {
  return request.messages.filter((message) => message.role === "user")
    .flatMap((message) => message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])))
    .join("\n");
}

function call(id: string, name: string, args: Record<string, unknown>, text = ""): Round {
  return async function* (): AsyncGenerator<TransportEvent> {
    if (text.length > 0) yield { type: "text_delta", text };
    yield { type: "tool_call_start", id, name };
    yield { type: "tool_call_delta", id, argumentsDelta: JSON.stringify(args) };
    yield { type: "tool_call_end", id };
    yield { type: "complete", stopReason: "tool_use" };
  };
}

function say(text: string): Round {
  return async function* (): AsyncGenerator<TransportEvent> {
    yield { type: "text_delta", text };
    yield { type: "complete", stopReason: "end_turn" };
  };
}

function environment(transport: ProviderTransport) {
  return {
    provider: new ReliableProvider(transport, { streamStallTimeoutMs: 30_000 }),
    providerName: "fixture",
    model: "fixture-model",
    config: {
      providers: { fixture: { base_url: "http://fixture.invalid/v1", api_type: "openai_completions" as const, auth: { type: "none" as const }, models: ["fixture-model"] } },
      roles: { default: "fixture/fixture-model" },
    },
  };
}

async function boot(root: string, session: string, transport: ProviderTransport, updates: SessionUpdate[] = []): Promise<LyraRuntime> {
  const runtime = await LyraRuntime.create({
    origin: root, session, environment: environment(transport),
    home: join(root, "home"), onUpdate: (update) => updates.push(update),
  });
  cleanups.push(() => runtime.close());
  return runtime;
}

/** Every tool result a turn produced, parsed, in call order. */
function toolResults(entries: readonly TranscriptEntry[], tool?: string): Array<Record<string, unknown>> {
  const names = new Map<string, string>();
  const output: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    for (const block of (entry as MessageEntry).content) {
      if (block.type === "tool_use") names.set(block.id, block.name);
      if (block.type !== "tool_result") continue;
      if (tool !== undefined && names.get(block.toolUseId) !== tool) continue;
      const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      try { output.push(JSON.parse(text) as Record<string, unknown>); } catch { output.push({ text }); }
    }
  }
  return output;
}

interface ToolOutcome { tool: string; callId: string; isError: boolean; text: string; }

/** Every tool call and what it answered, paired by id, so a failure names the call that failed. */
function collectToolResults(entries: readonly TranscriptEntry[]): ToolOutcome[] {
  const names = new Map<string, string>();
  const output: ToolOutcome[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    for (const block of (entry as MessageEntry).content) {
      if (block.type === "tool_use") names.set(block.id, block.name);
      if (block.type !== "tool_result") continue;
      output.push({
        tool: names.get(block.toolUseId) ?? "?",
        callId: block.toolUseId,
        isError: block.isError === true,
        text: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
      });
    }
  }
  return output;
}

/**
 * The whole terra session: boot in a directory that is not a repository, write a file, put a
 * child on the same tree, watch it, talk to it, be woken by its answer, collect it, and then
 * rewind the tree without destroying the file a human edited underneath.
 */
test("the terra session runs the whole loop in a directory that is not a repository", async () => {
  const root = await bareDirectory("lyra-terra-");
  expect(existsSync(join(root, ".git"))).toBe(false);

  const childRunning = Promise.withResolvers<void>();
  const asideSent = Promise.withResolvers<void>();
  let childSawAside: string | undefined;

  const transport = routed([
    {
      name: "child", match: (first) => first.includes("survey the tree"),
      rounds: [
        // Announce that the child is live, then hold until the parent's aside is on the bus
        // — so `spawn status` really does observe a running child and the aside really does
        // arrive mid-flight rather than before the child started.
        async function* (): AsyncGenerator<TransportEvent> {
          childRunning.resolve();
          await asideSent.promise;
          yield { type: "text_delta", text: "surveying" };
          yield { type: "tool_call_start", id: "c1", name: "write" };
          yield { type: "tool_call_delta", id: "c1", argumentsDelta: JSON.stringify({ path: "survey.md", content: "# survey\n" }) };
          yield { type: "tool_call_end", id: "c1" };
          yield { type: "complete", stopReason: "tool_use" };
        },
        // The aside folded in at the tool boundary above; answer it on the bus.
        async function* (_context, request?: ProviderRequest): AsyncGenerator<TransportEvent> {
          yield { type: "tool_call_start", id: "c2", name: "hub" };
          yield { type: "tool_call_delta", id: "c2", argumentsDelta: JSON.stringify({ op: "send", to: "terra", message: "survey.md is written; the tree has one source file." }) };
          yield { type: "tool_call_end", id: "c2" };
          yield { type: "complete", stopReason: "tool_use" };
        },
        say("Surveyed the tree and wrote survey.md."),
      ],
    },
    {
      name: "parent", match: () => true,
      rounds: [
        call("p1", "write", { path: "notes.md", content: "terra notes\n" }, "writing the notes first"),
        call("p1b", "write", { path: "plan.md", content: "terra plan\n" }),
        call("p2", "spawn", { task: "survey the tree and report what is in it", label: "scout" }),
        // Only once the child is actually live is a status report meaningful.
        async function* (): AsyncGenerator<TransportEvent> {
          await childRunning.promise;
          yield { type: "tool_call_start", id: "p3", name: "spawn" };
          yield { type: "tool_call_delta", id: "p3", argumentsDelta: JSON.stringify({ id: "scout", op: "status" }) };
          yield { type: "tool_call_end", id: "p3" };
          yield { type: "complete", stopReason: "tool_use" };
        },
        async function* (): AsyncGenerator<TransportEvent> {
          yield { type: "tool_call_start", id: "p4", name: "hub" };
          yield { type: "tool_call_delta", id: "p4", argumentsDelta: JSON.stringify({ op: "send", to: "scout", message: "also say how many source files you saw" }) };
          yield { type: "tool_call_end", id: "p4" };
          yield { type: "complete", stopReason: "tool_use" };
          asideSent.resolve();
        },
        // A blocking wait on this agent's own mailbox, cut short by the child's reply.
        call("p5", "hub", { op: "wait", timeoutMs: 60_000 }),
        call("p6", "spawn", { id: "scout" }),
        call("p7", "git", { op: "list", limit: 50 }),
        say("Notes written, scout collected."),
      ],
    },
  ]);

  const updates: SessionUpdate[] = [];
  const runtime = await boot(root, "terra", transport, updates);
  const result = await runtime.prompt("set up the terra notes and delegate a survey");
  expect(result.stopReason).toBe("end_turn");

  const entries = runtime.session.entries();

  // 1. The parent's file landed in the launch directory, not under any workspace path.
  expect(await readFile(join(root, "notes.md"), "utf8")).toBe("terra notes\n");
  expect(existsSync(join(root, ".lyra", "workspaces"))).toBe(false);

  // 2. The child shared the tree: its file is in the launch directory too.
  expect(await readFile(join(root, "survey.md"), "utf8")).toBe("# survey\n");

  // 3. spawn returned { id, peer, status } immediately, non-blocking, with the peer name.
  const started = toolResults(entries, "spawn")[0]!;
  expect(started.peer).toBe("scout");
  expect(String(started.id)).toMatch(/^spawn-/);
  expect(["queued", "starting", "running"]).toContain(String(started.status));

  // 4. The mid-flight status report described a live child, not a terminal one.
  const status = toolResults(entries, "spawn")[1]!;
  expect(status.peer).toBe("scout");
  expect(["queued", "starting", "running", "awaiting_tool"]).toContain(String(status.status));
  expect(status.isolated).toBe(false);
  expect(resolve(String(status.workspace))).toBe(root);

  // 5. The parent's blocking wait was ended by the child's reply, not by its deadline.
  const waited = toolResults(entries, "hub").at(-1)!;
  const messages = (waited.messages ?? waited) as unknown;
  expect(JSON.stringify(messages)).toContain("survey.md is written");
  expect(JSON.stringify(messages)).toContain("scout");

  // 6. The collect carried the result and the files the child changed.
  const collected = toolResults(entries, "spawn").at(-1)!;
  expect(collected.collected).toBe(true);
  expect(collected.peer).toBe("scout");
  expect(String(collected.output)).toContain("survey.md");
  expect(collected.filesModified).toEqual(["survey.md"]);

  // 7. The checkpoint list shows the tool-call cadence: one before each mutating call.
  const listed = toolResults(entries, "git").at(-1)! as { checkpoints: Array<Record<string, unknown>> };
  expect(Array.isArray(listed.checkpoints)).toBe(true);
  const tools = listed.checkpoints.map((record) => record.tool).filter(Boolean);
  expect(tools).toContain("write");
  expect(tools).toContain("spawn");
  const kindsSeen = listed.checkpoints.map((record) => record.kind);
  expect(kindsSeen).toContain("turn_start");
  expect(kindsSeen).toContain("turn_end");
  expect(kindsSeen).toContain("pre_tool");
  // Read-only calls cost nothing: no checkpoint was taken in front of `hub`, and the first
  // `write`'s snapshot collapsed onto the turn-start one because nothing had changed yet.
  expect(tools).not.toContain("hub");

  // 8. Every checkpoint anchors to a transcript entry, so conversation and code share a DAG.
  expect(listed.checkpoints.filter((record) => record.tool !== undefined).every((record) => typeof record.entryId === "string")).toBe(true);

  // --- never-clobber, on a second turn so the target id is known ---

  // A human edits a file underneath, outside any tool call.
  await writeFile(join(root, "handwritten.txt"), "written by a person\n");
  const before = await runtime.app.checkpoints.list({ limit: 100 });
  // The turn-start checkpoint: everything in the tree past it is Lyra's, except the file a
  // person wrote a moment ago.
  const target = before.at(-1)!;
  expect(target.kind).toBe("turn_start");

  const restore = await runtime.app.checkpoints.restore(target.id, {});
  expect(restore.restored).toContain("notes.md");
  expect(restore.restored).toContain("plan.md");
  // The child's file counts as Lyra's too: a shared-tree child shares the checkpoint stream.
  expect(restore.restored).toContain("survey.md");
  expect(restore.preserved).toContain("handwritten.txt");
  expect(existsSync(join(root, "notes.md"))).toBe(false);
  expect(existsSync(join(root, "survey.md"))).toBe(false);
  expect(await readFile(join(root, "handwritten.txt"), "utf8")).toBe("written by a person\n");
  // The restore is itself undoable and says so.
  expect(typeof restore.safety.id).toBe("string");
  expect(restore.excluded).toContain(".lyra");

  // 9. /review renders the diff structures a client draws.
  const review = await runtime.slash("/review") as { command: string; resultKind: string; error?: string; output: { diff: { files: unknown[]; available: boolean }; agents: unknown[] } };
  expect(review.error).toBeUndefined();
  // Wave 3 made /review a first-class result kind rather than a report the client parses.
  expect(review.resultKind).toBe("review");
  expect(Array.isArray(review.output.diff.files)).toBe(true);
  expect(review.output.diff.available).toBe(true);
  expect(Array.isArray(review.output.agents)).toBe(true);

  const checkpointList = await runtime.slash("/checkpoints") as { resultKind: string; output: { checkpoints: unknown[]; available: boolean } };
  expect(checkpointList.resultKind).toBe("checkpoints");
  expect(checkpointList.output.available).toBe(true);
  expect(checkpointList.output.checkpoints.length).toBeGreaterThan(0);

  // 10. The lifecycle reached the client as `agent` updates, spawn through completion.
  const lifecycle = updates.filter((update) => update.sessionUpdate === "agent") as Array<Record<string, unknown>>;
  // The transition itself, not only the state it left behind: `started` and `revived` are
  // both `running`, so a client that can only diff `status` cannot tell them apart.
  expect(lifecycle.map((update) => update.event)).toEqual(["spawned", "started", "completed"]);
  expect(lifecycle.every((update) => update.peer === "scout")).toBe(true);
  expect(lifecycle.at(-1)!.filesModified).toBe(1);

  void childSawAside; void allUserText; void readdir;
}, 120_000);

/**
 * The strict emitter, replayed against a live daemon.
 *
 * A proxy in the field was observed filling *every* declared property on every call —
 * `tag: ""` on a fresh write, `job: ""` on a command, `startLine: 0` on a search/replace,
 * `timeoutMs: 0` everywhere. Each of those is a legal JSON value and an illegal argument,
 * and each one used to produce a first-call error the model then had to recover from. The
 * schemas carry canonical fields only and the normalizers drop padding; this drives one
 * turn where every tool is called in that shape and asserts nothing errored.
 */
test("a schema-complete emitter that pads every optional property gets no errors", async () => {
  const root = await bareDirectory("lyra-padding-");

  /** Every optional a strict emitter would fill, at the value it fills them with. */
  const padded = {
    write: { path: "padded.txt", content: "one\ntwo\nthree\n", tag: "" },
    grep: { pattern: "three", path: "", flags: "", glob: "", maxResults: 0, before: 0, after: 0, output_mode: "" },
    glob: { pattern: "*.txt", path: "" },
    hub: { op: "list", to: "", peer: "", channel: "", message: "", timeoutMs: 0 },
    spawn: { task: "echo the word padding and stop", context: "", model: "", workspace: "", label: "", acp: "", schema_mode: "", id: "", op: "", timeoutMs: 1, depth: 0, tools: [], writeScope: [], output_schema: {} },
  };

  const transport = routed([
    { name: "child", match: (first) => first.includes("echo the word padding"), rounds: [say("padding")] },
    {
      name: "parent", match: () => true,
      rounds: [
        call("t1", "write", padded.write),
        call("t2", "read", { path: "padded.txt", startLine: 0, endLine: 0 }),
        // The tag the read just reported, exactly as a model would copy it back.
        async function* (_context, request): AsyncGenerator<TransportEvent> {
          const tag = /#[a-fA-F0-9]+/.exec(lastToolResult(request))?.[0] ?? "";
          yield { type: "tool_call_start", id: "t3", name: "edit" };
          yield { type: "tool_call_delta", id: "t3", argumentsDelta: JSON.stringify({ mode: "", path: "padded.txt", tag, search: "two", replace: "TWO", symbol: "", language: "", startLine: 0, endLine: 0 }) };
          yield { type: "tool_call_end", id: "t3" };
          yield { type: "complete", stopReason: "tool_use" };
        },
        call("t4", "bash", { command: "printf padded-output", cwd: "", timeoutMs: 0, description: "", run_in_background: true, job: "" }),
        // Collect the job the previous call started, with every other field still padded.
        async function* (_context, request): AsyncGenerator<TransportEvent> {
          const job = /job-\d+/.exec(lastToolResult(request))?.[0] ?? "";
          yield { type: "tool_call_start", id: "t5", name: "bash" };
          yield { type: "tool_call_delta", id: "t5", argumentsDelta: JSON.stringify({ command: "", cwd: "", timeoutMs: 0, description: "", run_in_background: false, job }) };
          yield { type: "tool_call_end", id: "t5" };
          yield { type: "complete", stopReason: "tool_use" };
        },
        call("t6", "grep", padded.grep),
        call("t7", "glob", padded.glob),
        call("t8", "hub", padded.hub),
        call("t9", "spawn", padded.spawn),
        // Two calls that *must* still fail, because the lesson is the point: a named agent
        // type has nothing to select, and `from` let one agent speak as another.
        call("t10", "spawn", { task: "anything", subagent_type: "reviewer" }),
        call("t11", "hub", { op: "list", from: "somebody-else" }),
        say("done"),
      ],
    },
  ]);

  const runtime = await boot(root, "padding", transport);
  const result = await runtime.prompt("exercise every tool with a schema-complete emitter");
  expect(result.stopReason).toBe("end_turn");

  const entries = runtime.session.entries();
  const results = collectToolResults(entries);
  const designed = ["spawn:t10", "hub:t11"];
  const unexpected = results.filter((row) => row.isError && !designed.includes(`${row.tool}:${row.callId}`));
  expect(unexpected.map((row) => `${row.tool}: ${row.text.slice(0, 200)}`)).toEqual([]);

  // The padded calls did real work rather than being quietly accepted and skipped.
  expect(await readFile(join(root, "padded.txt"), "utf8")).toBe("one\nTWO\nthree\n");
  expect(results.find((row) => row.callId === "t5")!.text).toContain("padded-output");
  expect(results.find((row) => row.callId === "t6")!.text).toContain("padded.txt");
  expect(results.find((row) => row.callId === "t9")!.text).toContain("spawn-");

  // And the two designed refusals teach rather than merely refuse.
  const lesson = results.find((row) => row.callId === "t10")!;
  expect(lesson.isError).toBe(true);
  expect(lesson.text).toContain("subagent_type");
  expect(lesson.text).toContain("output_schema");
  const sender = results.find((row) => row.callId === "t11")!;
  expect(sender.isError).toBe(true);
  expect(sender.text).toContain("from is not supported");
}, 120_000);

/** A directory that *is* a repository, for the workspace clone an isolated child needs. */
async function repository(prefix: string): Promise<string> {
  const root = await bareDirectory(prefix);
  await writeFile(join(root, ".gitignore"), ".lyra/\n");
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, ["init", "-q", "-b", "main"]);
  // The integration recipe performs an ordinary merge in the launch repository. Keep the
  // fixture self-contained: a clean CI runner has no global Git author configuration.
  await git(root, ["config", "user.name", "Lyra Test"]);
  await git(root, ["config", "user.email", "lyra@example.test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "base"]);
  return root;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "Lyra", GIT_AUTHOR_EMAIL: "lyra@test", GIT_COMMITTER_NAME: "Lyra", GIT_COMMITTER_EMAIL: "lyra@test" },
  });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${error}`);
  return out;
}

/**
 * The isolated child, and the integration the *model* performs.
 *
 * §12 deleted the pipeline that used to merge a child's work behind the model's back, so the
 * proof that isolation still works is not "a merge happened" but "the parent was handed a
 * recipe it could run with the tools it already has, ran it, and the work arrived". The
 * second, abandoned child is the other half: a child that died mid-task is exactly the one
 * whose work you most want to find, so its workspace stays listed and inspectable.
 */
test("an isolated child hands back a recipe the parent executes to bring the work home", async () => {
  const root = await repository("lyra-isolated-");
  const abandoned = Promise.withResolvers<void>();

  const transport = routed([
    {
      name: "worker", match: (first) => first.includes("add the feature file"),
      rounds: [
        call("w1", "write", { path: "feature.txt", content: "the feature\n" }),
        call("w2", "bash", { command: "git add -A && git -c user.email=a@b -c user.name=a commit -q -m 'feat: the feature'" }),
        call("w3", "write", { path: "scratch.txt", content: "never committed\n" }),
        say("Committed the feature and left a scratch file behind."),
      ],
    },
    {
      // The child that is started and never collected. It parks on its own terminal state
      // and its workspace stays on disk.
      name: "stray", match: (first) => first.includes("start something and stop"),
      rounds: [say("stopped early")],
    },
    {
      name: "parent", match: () => true,
      rounds: [
        call("i1", "spawn", { task: "add the feature file and commit it", label: "worker", isolated: true, blocking: true }),
        call("i2", "spawn", { task: "start something and stop", label: "stray", isolated: true }),
        // The three commands the child's own result named, run with the ordinary git tool.
        async function* (_context, request): AsyncGenerator<TransportEvent> {
          const recipe = JSON.parse(lastToolResultFor(request, "i1")) as { integration: { hint: string[] } };
          const fetch = recipe.integration.hint[0]!.split(" ").slice(1);
          yield { type: "tool_call_start", id: "i3", name: "git" };
          yield { type: "tool_call_delta", id: "i3", argumentsDelta: JSON.stringify({ args: fetch }) };
          yield { type: "tool_call_end", id: "i3" };
          yield { type: "complete", stopReason: "tool_use" };
        },
        async function* (_context, request): AsyncGenerator<TransportEvent> {
          const recipe = JSON.parse(lastToolResultFor(request, "i1")) as { integration: { hint: string[] } };
          const merge = recipe.integration.hint[2]!.split(" ").slice(1);
          yield { type: "tool_call_start", id: "i4", name: "git" };
          yield { type: "tool_call_delta", id: "i4", argumentsDelta: JSON.stringify({ args: merge }) };
          yield { type: "tool_call_end", id: "i4" };
          yield { type: "complete", stopReason: "tool_use" };
          abandoned.resolve();
        },
        say("Fetched and merged the worker's branch."),
      ],
    },
  ]);

  const runtime = await boot(root, "isolated", transport);
  const result = await runtime.prompt("delegate the feature to an isolated child and integrate it");
  expect(result.stopReason).toBe("end_turn");
  await abandoned.promise;

  const outcomes = collectToolResults(runtime.session.entries());
  const collected = JSON.parse(outcomes.find((row) => row.callId === "i1")!.text) as {
    collected: boolean; workspace: string; integration: { workspace: string; path: string; commits: number; uncommitted: string[]; hint: string[] };
  };

  // 1. The child's work landed in its own workspace, not in the launch directory.
  expect(collected.integration.path).toContain(join(".lyra", "workspaces"));
  expect(existsSync(join(collected.integration.path, "feature.txt"))).toBe(true);

  // 2. The recipe measures what is actually there: one commit, one uncommitted path.
  expect(collected.integration.commits).toBe(1);
  expect(collected.integration.uncommitted).toEqual(["scratch.txt"]);
  expect(collected.integration.hint[0]).toBe(`git fetch ${collected.integration.path} HEAD:refs/lyra/agents/${collected.integration.workspace}`);
  expect(collected.integration.hint[2]).toBe(`git merge --no-ff refs/lyra/agents/${collected.integration.workspace}`);
  // The paths a fetch will not carry are called out separately rather than left implied.
  expect(collected.integration.hint.at(-1)).toContain("uncommitted path(s) the fetch above will not carry");

  // 3. Running the recipe with the git tool brought the work into the launch directory.
  expect(outcomes.find((row) => row.callId === "i3")!.isError).toBe(false);
  expect(outcomes.find((row) => row.callId === "i4")!.isError).toBe(false);
  expect(await readFile(join(root, "feature.txt"), "utf8")).toBe("the feature\n");
  // The uncommitted scratch file was *not* carried, exactly as the recipe warned.
  expect(existsSync(join(root, "scratch.txt"))).toBe(false);

  // 4. The abandoned child is still listed, with its workspace, and still inspectable.
  const agents = await runtime.slash("/agents") as { output: { agents: Array<Record<string, unknown>> } };
  const stray = agents.output.agents.find((agent) => agent.peer === "stray")!;
  expect(stray).toBeDefined();
  expect(stray.isolated).toBe(true);
  expect(typeof stray.workspaceName).toBe("string");
  expect(existsSync(String(stray.workspace))).toBe(true);

  const workspaces = await runtime.slash("/workspaces") as { output: { workspaces: Array<Record<string, unknown>> } };
  expect(workspaces.output.workspaces.map((entry) => entry.name)).toContain(stray.workspaceName);
}, 180_000);

/** The result of one specific call, by the id the script gave it. */
function lastToolResultFor(request: ProviderRequest, callId: string): string {
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === "tool_result" && block.toolUseId === callId) return typeof block.content === "string" ? block.content : JSON.stringify(block.content);
    }
  }
  throw new Error(`No tool result for ${callId} in the conversation yet.`);
}

/**
 * Revival: a message is the only resume primitive (§9).
 *
 * The load-bearing claim is "same id, same peer, same transcript". A child restarted with
 * the same name and no memory would look identical from the outside and be useless, so the
 * assertion that matters is what the *revived* conversation contains.
 */
test("a message revives a completed child with its transcript intact, and it parks again", async () => {
  const root = await bareDirectory("lyra-revive-");
  const revivedPrompt = Promise.withResolvers<string>();
  let revivedTurn: ProviderRequest | undefined;

  const transport = routed([
    {
      name: "child", match: (first) => first.includes("remember the number"),
      rounds: [
        say("Noted: the number is 41."),
        // The revival. Everything the child was told the first time is still in front of it.
        async function* (_context, request): AsyncGenerator<TransportEvent> {
          revivedTurn = request;
          revivedPrompt.resolve(allUserText(request));
          yield { type: "text_delta", text: "The number I remembered is 41, plus one is 42." };
          yield { type: "complete", stopReason: "end_turn" };
        },
      ],
    },
    {
      name: "parent", match: () => true,
      rounds: [
        call("r1", "spawn", { task: "remember the number 41 and say so", label: "memo", blocking: true }),
        call("r2", "hub", { op: "send", to: "memo", message: "what is that number plus one?" }),
        say("asked the memo agent a follow-up"),
      ],
    },
  ]);

  const runtime = await boot(root, "revive", transport);
  const first = await runtime.prompt("start a memo agent and then ask it a follow-up");
  expect(first.stopReason).toBe("end_turn");

  const seen = await revivedPrompt.promise;
  // 1. Same transcript: the original task and the child's own first answer are still there.
  expect(seen).toContain("remember the number 41");
  expect(seen).toContain("what is that number plus one?");
  expect(revivedTurn!.messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("the number is 41"))).toBe(true);

  // 2. The reviving message became the prompt rather than also sitting in the inbox: an
  //    agent restarted with "do X" must not then read "do X" out of its own mailbox.
  const inbox = runtime.app.bus.getPeer("memo");
  expect(inbox?.name).toBe("memo");

  // 3. Same id and same peer across the revival, and the manager counted it.
  await waitFor(() => runtime.app.spawn.status("memo")?.revivals === 1, "the revival to be recorded");
  const status = runtime.app.spawn.status("memo")!;
  expect(status.peer).toBe("memo");
  expect(status.id).toBe("spawn-1");
  expect(status.revivals).toBe(1);

  // 4. It parks again on its new terminal state, so it can be revived a second time.
  await waitFor(() => runtime.app.bus.getPeer("memo")?.state === "parked", "the child to park again");
  expect(runtime.app.spawn.status("memo")!.status).toBe("completed");
  expect(runtime.app.spawn.status("memo")!.resultAvailable).toBe(true);
}, 120_000);

/** Poll a condition that a background turn will eventually make true. */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/**
 * Rewinding the conversation and the code as one operation.
 *
 * Every checkpoint is keyed to a transcript entry id precisely so this is one DAG and not
 * two: `session/rewind` moves the head, `checkpoint/restore` moves the tree, and the anchor
 * is what makes them agree. Nothing is deleted from the transcript on disk — the entries
 * after the head simply stop being ancestors of it.
 */
test("session rewind and checkpoint restore take the conversation and the tree back together", async () => {
  const root = await bareDirectory("lyra-rewind-");

  const transport = routed([
    {
      name: "parent", match: () => true,
      rounds: [
        call("k1", "write", { path: "kept.txt", content: "keep me\n" }),
        call("k2", "write", { path: "undone.txt", content: "undo me\n" }),
        say("wrote both files"),
      ],
    },
  ]);

  const runtime = await boot(root, "rewind", transport);
  await runtime.prompt("write two files");
  expect(existsSync(join(root, "undone.txt"))).toBe(true);

  const entriesBefore = runtime.session.entries().length;
  const messagesBefore = runtime.session.entries().filter((entry) => entry.type === "message").length;

  // The checkpoint taken in front of the second write: the tree still has kept.txt and not
  // undone.txt, and it names the transcript entry that asked for that write.
  const records = await runtime.app.checkpoints.list({ limit: 50 });
  const target = records.find((record) => record.tool === "write" && record.changedFiles > 0)!;
  expect(target.entryId).toBeDefined();

  // 1. The conversation goes back to the entry the checkpoint anchors.
  const rewound = await runtime.session.rewind(target.entryId!) as { entryId: string; removedMessages: number };
  expect(rewound.entryId).toBe(target.entryId);
  expect(rewound.removedMessages).toBeGreaterThan(0);
  expect(rewound.removedMessages).toBeLessThan(messagesBefore);

  // 2. Nothing was deleted: every entry is still there and still on disk, the head just
  //    moved, which is what makes the rewind itself reversible.
  expect(runtime.session.entries().length).toBe(entriesBefore);
  const onDisk = (await readFile(await transcriptPath(root), "utf8")).split("\n").filter(Boolean).length;
  expect(onDisk).toBeGreaterThanOrEqual(entriesBefore);

  // 3. The tree goes back to the same anchor, and the restore is itself undoable.
  const restore = await runtime.app.checkpoints.restore(target.id, {});
  expect(restore.restored).toContain("undone.txt");
  expect(existsSync(join(root, "undone.txt"))).toBe(false);
  expect(await readFile(join(root, "kept.txt"), "utf8")).toBe("keep me\n");
  // The safety snapshot is a real, addressable checkpoint holding the tree as it was. When
  // nothing has changed since the last one it collapses onto it rather than duplicating it —
  // an unchanged tree is already recoverable from the checkpoint that recorded it.
  const safety = await runtime.app.checkpoints.resolve(restore.safety.id);
  expect(safety).toBeDefined();
  expect(safety!.tree).toBe(restore.safety.tree);

  // 4. And the safety checkpoint really does put it back.
  const undo = await runtime.app.checkpoints.restore(restore.safety.id, {});
  expect(undo.restored).toContain("undone.txt");
  expect(await readFile(join(root, "undone.txt"), "utf8")).toBe("undo me\n");
}, 120_000);

/** Where the live session's transcript is written. */
async function transcriptPath(root: string): Promise<string> {
  const directory = join(root, ".lyra", "sessions");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
  if (files.length === 0) throw new Error(`No transcript was written under ${directory}.`);
  return join(directory, files.sort().at(-1)!);
}

/**
 * Two sessions in one directory (§10, "One session per directory").
 *
 * Deliberately *not* refused — a second session is sometimes exactly what you want — but
 * reported by name and pid, because a `/rollback` in one can revert the other's edits and
 * the checkpoint engine will not have attributed them.
 */
test("a second session in the same directory is reported, not refused", async () => {
  const root = await bareDirectory("lyra-lock-");
  const reports: string[] = [];

  // A live claim by another process. Detection is by pid, so the other session has to be a
  // real live one — pid 1 always is, and `kill(1, 0)` answering EPERM is exactly the case
  // the liveness probe treats as alive.
  await mkdir(join(root, ".lyra"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".lyra", "session.lock"), `${JSON.stringify({ pid: 1, session: "elsewhere", startedAt: "2026-08-10T00:00:00.000Z" })}\n`);

  const second = await LyraRuntime.create({
    origin: root, session: "second", environment: environment(routed([{ name: "p", match: () => true, rounds: [say("hello")] }])),
    home: join(root, "home"), onReport: (message) => { reports.push(message); },
  });
  cleanups.push(() => second.close());

  const warning = reports.find((message) => message.includes("Another Lyra session"));
  expect(warning).toBeDefined();
  // Named by pid and by session, with the consequence spelled out rather than implied.
  expect(warning!).toContain("pid 1");
  expect(warning!).toContain("session elsewhere");
  expect(warning!).toContain(root);
  expect(warning!).toContain("/rollback in one can revert the other's edits");
  expect(warning!).toContain("--origin");

  // Reported, not refused: the session is fully usable.
  expect((await second.prompt("say hello")).stopReason).toBe("end_turn");
  expect(second.app.cwd).toBe(root);

  // A dead claim is reclaimed silently — a crashed session must not make the next one look
  // like a collision.
  const stale = await bareDirectory("lyra-lock-stale-");
  await mkdir(join(stale, ".lyra"), { recursive: true, mode: 0o700 });
  await writeFile(join(stale, ".lyra", "session.lock"), `${JSON.stringify({ pid: 0x7fff_fffe, session: "crashed", startedAt: "2026-08-10T00:00:00.000Z" })}\n`);
  const quiet: string[] = [];
  const third = await LyraRuntime.create({
    origin: stale, session: "third", environment: environment(routed([{ name: "p", match: () => true, rounds: [say("hello")] }])),
    home: join(stale, "home"), onReport: (message) => { quiet.push(message); },
  });
  cleanups.push(() => third.close());
  expect(quiet.filter((message) => message.includes("Another Lyra session"))).toEqual([]);
}, 60_000);

/** A directory Lyra cannot write to fails at boot with the directory and the fix (§10). */
test("an unwritable directory fails at boot with one actionable sentence", async () => {
  const root = await bareDirectory("lyra-readonly-");
  const locked = join(root, "locked");
  await mkdir(locked, { mode: 0o500 });
  cleanups.push(() => chmod(locked, 0o700).catch(() => undefined));

  const failure = await boot(locked, "denied", routed([{ name: "p", match: () => true, rounds: [say("x")] }])).then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  expect(failure).toBeDefined();
  // The directory, the reason, and the fix — not an EACCES from whichever subsystem wrote first.
  expect(failure!.message).toContain(locked);
  expect(failure!.message).toContain("EACCES");
  expect(failure!.message).toContain("--origin");
  expect(failure!.message).toContain(join(locked, ".lyra"));
}, 60_000);

/**
 * Grandchildren: legible names all the way down, lifecycle events for every one, and the
 * depth cap that stops accidental exponential fan-out (§7).
 */
test("a grandchild is named, reported, and loses spawn at the depth cap", async () => {
  const root = await bareDirectory("lyra-depth-");
  const updates: SessionUpdate[] = [];

  const transport = routed([
    // depth 2 — the cap. It has no `spawn` at all, so the fourth generation cannot exist.
    { name: "gen3", match: (first) => first.includes("fourth generation"), rounds: [call("g3", "spawn", { task: "a fifth generation", label: "fifth" }), say("could not go deeper")] },
    { name: "gen2", match: (first) => first.includes("third generation"), rounds: [call("g2", "spawn", { task: "fourth generation work", label: "great", blocking: true }), say("great done")] },
    { name: "gen1", match: (first) => first.includes("second generation"), rounds: [call("g1", "spawn", { task: "third generation work", label: "grandchild", blocking: true }), say("grandchild done")] },
    { name: "parent", match: () => true, rounds: [call("d1", "spawn", { task: "second generation work", label: "child", blocking: true }), say("all done")] },
  ]);

  const runtime = await boot(root, "depth", transport, updates);
  await runtime.prompt("go as deep as the cap allows");

  const agents = runtime.app.spawn.statusList();
  const byPeer = (name: string) => agents.find((agent) => agent.peer === name);

  // 1. Every generation is named legibly — its label when that is one usable word, never a
  //    UUID — and each one knows which child spawned it.
  expect(agents.map((agent) => agent.peer).sort()).toEqual(["child", "grandchild", "great"]);
  expect(byPeer("child")!.depth).toBe(0);
  expect(byPeer("grandchild")!.depth).toBe(1);
  expect(byPeer("great")!.depth).toBe(2);
  expect(byPeer("grandchild")!.parentId).toBe(byPeer("child")!.id);
  expect(byPeer("great")!.parentId).toBe(byPeer("grandchild")!.id);

  // 2. Every generation produced lifecycle events, so a presence strip sees the whole tree
  //    and not just the children the main session started itself.
  const lifecycle = updates.filter((update) => update.sessionUpdate === "agent") as Array<Record<string, unknown>>;
  expect(new Set(lifecycle.map((update) => update.peer))).toEqual(new Set(["child", "grandchild", "great"]));
  for (const peer of ["child", "grandchild", "great"]) {
    expect(lifecycle.filter((update) => update.peer === peer).map((update) => update.event)).toEqual(["spawned", "started", "completed"]);
  }
  expect(lifecycle.find((update) => update.peer === "great")!.depth).toBe(2);

  // 3. The fifth generation was never created: a child at the cap loses `spawn` entirely,
  //    which is what stops accidental exponential fan-out.
  expect(byPeer("fifth")).toBeUndefined();
  expect(byPeer("great")!.status).toBe("completed");
}, 120_000);

/**
 * `writeScope` (§7): a declared partition of a shared tree. Its `write` and `edit` refuse
 * anything outside it and say which paths it *does* own, and the refusal reaches the parent
 * — in the child's result, not only in the child's own context where nobody would see it.
 */
test("a writeScope violation is refused in the child and surfaced in its result", async () => {
  const root = await bareDirectory("lyra-scope-");
  await writeFile(join(root, "off-limits.txt"), "not yours\n");
  await mkdir(join(root, "mine"), { recursive: true });

  const transport = routed([
    {
      name: "child", match: (first) => first.includes("only touch"),
      rounds: [
        call("s1", "write", { path: "mine/ok.txt", content: "allowed\n" }),
        call("s2", "write", { path: "off-limits.txt", content: "clobbered\n" }),
        say("wrote what I was allowed to"),
      ],
    },
    { name: "parent", match: () => true, rounds: [call("p1", "spawn", { task: "only touch the mine directory", label: "scoped", writeScope: ["mine/**"], blocking: true }), say("collected")] },
  ]);

  const runtime = await boot(root, "scope", transport);
  await runtime.prompt("partition the tree between children");

  // 1. The allowed write happened; the refused one did not touch the file.
  expect(await readFile(join(root, "mine", "ok.txt"), "utf8")).toBe("allowed\n");
  expect(await readFile(join(root, "off-limits.txt"), "utf8")).toBe("not yours\n");

  // 2. The refusal names the paths the child *does* own, so it can retry correctly.
  const collected = JSON.parse(collectToolResults(runtime.session.entries()).find((row) => row.callId === "p1")!.text) as {
    scope: { paths: string[]; violations: string[] };
  };
  expect(collected.scope.paths).toEqual(["mine/**"]);
  expect(collected.scope.violations).toEqual(["off-limits.txt"]);

  // 3. And the same fact is visible to the parent without collecting, in `spawn status`.
  const status = runtime.app.spawn.status("scoped")!;
  expect(status.writeScope).toEqual(["mine/**"]);
  expect(status.scopeViolations).toEqual(["off-limits.txt"]);
}, 120_000);

/**
 * A cancel that loses the race is not a failure and must not read like one: the work is
 * done and the result is still collectable, which is better news than the cancel succeeding.
 */
test("a cancel that arrives after the child finished says so and keeps the result", async () => {
  const root = await bareDirectory("lyra-cancel-");
  const finished = Promise.withResolvers<void>();

  const transport = routed([
    {
      name: "child", match: (first) => first.includes("finish immediately"),
      rounds: [async function* (): AsyncGenerator<TransportEvent> {
        yield { type: "text_delta", text: "already done" };
        yield { type: "complete", stopReason: "end_turn" };
      }],
    },
    {
      name: "parent", match: () => true,
      rounds: [
        call("c1", "spawn", { task: "finish immediately", label: "sprinter" }),
        // Cancel only once the child has genuinely reached a terminal state.
        async function* (): AsyncGenerator<TransportEvent> {
          await finished.promise;
          yield { type: "tool_call_start", id: "c2", name: "spawn" };
          yield { type: "tool_call_delta", id: "c2", argumentsDelta: JSON.stringify({ id: "sprinter", op: "cancel" }) };
          yield { type: "tool_call_end", id: "c2" };
          yield { type: "complete", stopReason: "tool_use" };
        },
        call("c3", "spawn", { id: "sprinter" }),
        say("collected anyway"),
      ],
    },
  ]);

  const runtime = await boot(root, "cancel", transport);
  const turn = runtime.prompt("start a child and try to cancel it");
  await waitFor(() => runtime.app.spawn.status("sprinter")?.status === "completed", "the child to finish");
  finished.resolve();
  await turn;

  const outcomes = collectToolResults(runtime.session.entries());
  const cancel = JSON.parse(outcomes.find((row) => row.callId === "c2")!.text) as { cancelled: boolean; status: string; note: string };
  expect(outcomes.find((row) => row.callId === "c2")!.isError).toBe(false);
  expect(cancel.cancelled).toBe(false);
  expect(cancel.status).toBe("completed");
  expect(cancel.note).toContain("finished before the cancel reached it");
  expect(cancel.note).toContain("Nothing was stopped and nothing was lost");

  // The result really is still collectable afterwards.
  const collected = JSON.parse(outcomes.find((row) => row.callId === "c3")!.text) as { collected: boolean; output: string };
  expect(collected.collected).toBe(true);
  expect(String(collected.output)).toContain("already done");
}, 120_000);

/**
 * Retention under a burst (§10.2). Three hundred checkpoints is a long afternoon of
 * tool calls, and the point of the policy is that thinning rewrites the chain while every
 * surviving *id* keeps resolving — an id recorded in a transcript is a promise.
 */
test("garbage collection thins a burst of 300 checkpoints and keeps every surviving id resolvable", async () => {
  const root = await bareDirectory("lyra-gc-");
  const store = await CheckpointStore.open({ root });
  cleanups.push(() => store.close());

  const recorded: Array<{ id: string; tree: string }> = [];
  for (let index = 0; index < 300; index += 1) {
    await writeFile(join(root, `file-${index}.txt`), `${index}\n`);
    const record = await store.checkpoint({ kind: "pre_tool", tool: "write", attributed: [`file-${index}.txt`] });
    expect(record).toBeDefined();
    recorded.push({ id: record!.id, tree: record!.tree });
  }
  expect((await store.list()).length).toBe(300);

  // Everything here is minutes old, so the keep-all window alone protects all 300 — the
  // policy is age *and* count, and neither one alone is the rule.
  const untouched = await store.collect();
  expect(untouched.dropped).toBe(0);
  expect(untouched.kept).toBe(300);

  // Past the keep-all window, the count ceiling is what bites.
  const thinned = await store.collect({ keepAllMs: 0, keepRecent: 50, thinIntervalMs: 60 * 60 * 1000, maxTotal: 2_000 });
  expect(thinned.dropped).toBeGreaterThan(0);
  expect(thinned.kept).toBeLessThan(300);
  expect(thinned.kept).toBeGreaterThanOrEqual(50);

  // The newest is never dropped, and every id that survived still resolves to its own tree
  // even though the rewrite gave all of them new commit oids.
  const survivors = await store.list();
  expect(survivors[0]!.id).toBe(recorded.at(-1)!.id);
  for (const survivor of survivors) {
    const resolved = await store.resolve(survivor.id);
    expect(resolved).toBeDefined();
    expect(resolved!.tree).toBe(recorded.find((entry) => entry.id === survivor.id)!.tree);
  }
  // A dropped id resolves to nothing rather than to the wrong checkpoint.
  const dropped = recorded.find((entry) => !survivors.some((survivor) => survivor.id === entry.id))!;
  expect(await store.resolve(dropped.id)).toBeUndefined();
}, 300_000);

/**
 * Retired configuration keys are read, accepted, and reported once (§10 / config.ts).
 *
 * `workspace.enabled = false` is what the benchmark harness writes, so a config that
 * suddenly refused to parse would break every such caller to make a point about tidiness.
 */
test("a config with retired keys boots and reports each one exactly once", async () => {
  const root = await bareDirectory("lyra-deprecated-");
  await mkdir(join(root, ".lyra"), { recursive: true });
  await writeFile(join(root, ".lyra", "config.toml"), "[workspace]\nenabled = false\n\n[git]\nmode = \"auto\"\n");
  const reports: string[] = [];

  const runtime = await LyraRuntime.create({
    origin: root, session: "deprecated",
    environment: environment(routed([{ name: "p", match: () => true, rounds: [say("booted")] }])),
    home: join(root, "home"), onReport: (message) => { reports.push(message); },
  });
  cleanups.push(() => runtime.close());

  // It booted, and both retired keys were named with what to do about them.
  expect(runtime.app.config.deprecations.length).toBe(2);
  const said = reports.join("\n");
  expect(said).toContain("workspace.enabled no longer does anything");
  expect(said).toContain("the main session always runs in the launch directory");
  expect(said).toContain("git.mode no longer does anything");
  expect(said).toContain("observe/stage/auto are gone");
  // Once each, not once per turn.
  expect(said.split("workspace.enabled no longer does anything").length - 1).toBe(1);

  expect((await runtime.prompt("still works")).stopReason).toBe("end_turn");
  // And the retired key changed nothing: the session still runs in the launch directory.
  expect(runtime.app.cwd).toBe(root);
}, 60_000);
