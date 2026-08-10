import { ReliableProvider, type ProviderTransport, type TransportEvent } from "@lyra/provider";
import { ProtocolValidator, type SessionUpdate } from "@lyra/acp";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LyraRuntime, SLASH_COMMAND_CATALOG, SLASH_COMMANDS } from "../src/index.ts";
import type { MessageEntry, TranscriptEntry } from "@lyra/session";

const validator = new ProtocolValidator();

class Writer {
  readonly lines: string[] = [];
  write(data: string | Uint8Array): void { this.lines.push(typeof data === "string" ? data : new TextDecoder().decode(data)); }
  messages(): Array<Record<string, unknown>> {
    return this.lines.flatMap((line) => line.trim().split("\n").filter(Boolean).map((part) => JSON.parse(part) as Record<string, unknown>));
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "Lyra", GIT_AUTHOR_EMAIL: "lyra@test", GIT_COMMITTER_NAME: "Lyra", GIT_COMMITTER_EMAIL: "lyra@test" }, stdout: "ignore", stderr: "pipe" });
  const error = new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(await error);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lyra-protocol-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await writeFile(join(root, ".gitignore"), ".lyra/\n");
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "base"]);
  return root;
}

function environment(transport: ProviderTransport) {
  return {
    provider: new ReliableProvider(transport, { streamStallTimeoutMs: 10_000 }),
    providerName: "fixture",
    model: "fixture-model",
    config: {
      providers: { fixture: { base_url: "http://fixture.invalid/v1", api_type: "openai_completions" as const, auth: { type: "none" as const }, models: ["fixture-model"] } },
      roles: { default: "fixture/fixture-model" },
    },
  };
}

/** A transport driven by a per-round script, so a turn's shape is exactly what a test wants. */
function scripted(rounds: Array<(context: { signal: AbortSignal }) => AsyncGenerator<TransportEvent>>): ProviderTransport {
  let round = 0;
  return {
    id: "scripted",
    apiType: "openai_completions",
    stream(_request, context) {
      const step = rounds[Math.min(round, rounds.length - 1)]!;
      round += 1;
      return step(context);
    },
  };
}

function toolRound(id: string, name: string, args: Record<string, unknown>) {
  return async function* (): AsyncGenerator<TransportEvent> {
    yield { type: "text_delta", text: "working" };
    yield { type: "tool_call_start", id, name };
    yield { type: "tool_call_delta", id, argumentsDelta: JSON.stringify(args) };
    yield { type: "tool_call_end", id };
    yield { type: "complete", stopReason: "tool_use" };
  };
}

function textRound(text: string) {
  return async function* (): AsyncGenerator<TransportEvent> {
    yield { type: "text_delta", text };
    yield { type: "complete", stopReason: "end_turn" };
  };
}

/** Blocks until the turn is cancelled; the generator never produces a completion. */
function stallingRound(text?: string) {
  return async function* (context: { signal: AbortSignal }): AsyncGenerator<TransportEvent> {
    if (text !== undefined) yield { type: "text_delta", text };
    await new Promise<void>((_, reject) => {
      if (context.signal.aborted) { reject(context.signal.reason); return; }
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
    });
  };
}

function messages(entries: readonly TranscriptEntry[]): MessageEntry[] {
  return entries.filter((entry): entry is MessageEntry => entry.type === "message");
}

describe("steering over ACP", () => {
  test("a steer lands at the tool boundary as its own user turn and interrupts a blocking wait", async () => {
    const root = await fixture();
    const reachedTool = Promise.withResolvers<void>();
    const transport = scripted([
      async function* (): AsyncGenerator<TransportEvent> {
        yield { type: "text_delta", text: "waiting for the child" };
        yield { type: "tool_call_start", id: "call-wait", name: "hub" };
        yield { type: "tool_call_delta", id: "call-wait", argumentsDelta: JSON.stringify({ op: "wait", timeoutMs: 20_000 }) };
        yield { type: "tool_call_end", id: "call-wait" };
        yield { type: "complete", stopReason: "tool_use" };
        reachedTool.resolve();
      },
      textRound("switched approach"),
    ]);
    const updates: SessionUpdate[] = [];
    const runtime = await LyraRuntime.create({ origin: root, session: "steer-boundary", environment: environment(transport), home: join(root, "home"), onUpdate: (update) => updates.push(update) });
    try {
      const turn = runtime.prompt("wait for the child agent");
      await reachedTool.promise;
      const delivery = await runtime.steer("stop waiting, read src/auth.ts instead");
      expect(delivery).toEqual({ delivery: "steered", pending: 1 });
      const result = await turn;
      expect(result.stopReason).toBe("end_turn");

      const entries = messages(runtime.session.entries());
      // user prompt, assistant tool_use, user tool_result, user steer, assistant answer.
      expect(entries).toHaveLength(5);
      const toolResult = entries[2]!;
      const steer = entries[3]!;
      expect(toolResult.role).toBe("user");
      expect(toolResult.content.every((block) => block.type === "tool_result")).toBe(true);
      // The load-bearing invariant: the steer is a STANDALONE user entry, never folded
      // into the tool result, so compaction, replay, and /context attribute it correctly.
      expect(steer.role).toBe("user");
      expect(steer.content).toEqual([{ type: "text", text: "stop waiting, read src/auth.ts instead" }]);

      // The blocked wait was cut short, and the model was told why in its own language.
      const waitResult = toolResult.content.find((block) => block.type === "tool_result");
      expect(JSON.stringify(waitResult)).toContain("Wait interrupted: the user sent a message.");

      const steered = updates.find((update) => update.sessionUpdate === "steer");
      expect(steered).toMatchObject({ sessionUpdate: "steer", at: "tool_boundary", text: "stop waiting, read src/auth.ts instead" });
      const toolEnd = updates.find((update) => update.sessionUpdate === "tool_call_end");
      expect(toolEnd).toMatchObject({ tool: "hub", interrupted: true, status: "ok" });
      // The steer pause bracket is closed explicitly.
      expect(updates.some((update) => update.sessionUpdate === "turn_resume" && update.after === "steer")).toBe(true);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("a steer with no turn running is an ordinary prompt", async () => {
    const root = await fixture();
    const runtime = await LyraRuntime.create({ origin: root, session: "steer-idle", environment: environment(scripted([textRound("answered")])), home: join(root, "home") });
    try {
      expect(await runtime.steer("just ask")).toEqual({ delivery: "prompted", pending: 0 });
      expect(messages(runtime.session.entries()).map((entry) => entry.role)).toEqual(["user", "assistant"]);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("a steer that arrives as the turn ends still lands as a user turn rather than being dropped", async () => {
    const root = await fixture();
    const firstRound = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const transport = scripted([
      async function* (): AsyncGenerator<TransportEvent> {
        yield { type: "text_delta", text: "done" };
        firstRound.resolve();
        await release.promise;
        yield { type: "complete", stopReason: "end_turn" };
      },
      textRound("and the follow-up"),
    ]);
    const updates: SessionUpdate[] = [];
    const runtime = await LyraRuntime.create({ origin: root, session: "steer-late", environment: environment(transport), home: join(root, "home"), onUpdate: (update) => updates.push(update) });
    try {
      const turn = runtime.prompt("first");
      await firstRound.promise;
      await runtime.steer("one more thing");
      release.resolve();
      await turn;
      expect(updates.find((update) => update.sessionUpdate === "steer")).toMatchObject({ at: "turn_boundary" });
      const roles = messages(runtime.session.entries()).map((entry) => entry.role);
      expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});

describe("cancel semantics", () => {
  test("partial output is kept and the prompt survives even when the client rewound", async () => {
    const root = await fixture();
    const runtime = await LyraRuntime.create({ origin: root, session: "cancel-partial", environment: environment(scripted([stallingRound("half an ans")])), home: join(root, "home") });
    try {
      const turn = runtime.prompt("produce something");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const outcome = await runtime.session.cancel({ rewoundToComposer: true });
      await turn;
      expect(outcome).toEqual({ cancelled: true, promptTrimmed: false });
      const lineage = messages(runtime.session.entries());
      expect(lineage.some((entry) => entry.role === "user" && JSON.stringify(entry.content).includes("produce something"))).toBe(true);
      const assistant = lineage.find((entry) => entry.role === "assistant");
      expect(assistant?.status).toBe("cancelled");
      expect(assistant?.content.some((block) => block.type === "text")).toBe(true);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("a zero-output cancel trims the prompt only when the client rewound it into the composer", async () => {
    const root = await fixture();
    const runtime = await LyraRuntime.create({ origin: root, session: "cancel-zero", environment: environment(scripted([stallingRound()])), home: join(root, "home") });
    try {
      const kept = runtime.prompt("no rewind");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await runtime.session.cancel()).toEqual({ cancelled: true, promptTrimmed: false });
      await kept;
      expect(JSON.stringify(runtime.session.entries())).toContain("no rewind");

      const trimmed = runtime.prompt("rewound prompt");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await runtime.session.cancel({ rewoundToComposer: true })).toEqual({ cancelled: true, promptTrimmed: true });
      await trimmed;
      // The entry stays on disk but leaves the active lineage: nothing is destroyed, and
      // the model will never see the prompt twice.
      const all = runtime.session.entries();
      const rewound = all.find((entry) => entry.type === "message" && JSON.stringify(entry.content).includes("rewound prompt"));
      expect(rewound).toBeDefined();
      const byId = new Map(all.map((entry) => [entry.id, entry]));
      const active = new Set<string>();
      // The head moved back to the rewound prompt's parent, so walk from the head, not
      // from the last appended entry — the cancelled turn's entries are still on disk.
      let cursor: TranscriptEntry | undefined = byId.get(runtime.session.descriptor.headId);
      while (cursor !== undefined) { active.add(cursor.id); cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId); }
      expect(active.has(rewound!.id)).toBe(false);
      // The earlier, un-rewound prompt is still on the lineage — only the rewound one left.
      expect(JSON.stringify(await runtime.session.context())).toContain("no rewind");
      expect(JSON.stringify(await runtime.session.context())).not.toContain("rewound prompt");
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("cancelling with no turn running reports no cancellation", async () => {
    const root = await fixture();
    const runtime = await LyraRuntime.create({ origin: root, session: "cancel-idle", environment: environment(scripted([textRound("ok")])), home: join(root, "home") });
    try {
      expect(await runtime.session.cancel({ rewoundToComposer: true })).toEqual({ cancelled: false });
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});

describe("daemon conformance", () => {
  test("every notification a real turn emits validates against the schema file", async () => {
    const root = await fixture();
    const transport = scripted([toolRound("call-read", "read", { path: "base.txt" }), textRound("read it")]);
    const runtime = await LyraRuntime.create({ origin: root, session: "wire-conformance", environment: environment(transport), home: join(root, "home") });
    const writer = new Writer();
    try {
      await runtime.app.acp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), writer);
      await runtime.app.acp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { prompt: "read the base file" } }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const frames = writer.messages().filter((message) => message.method === "session/update");
      expect(frames.length).toBeGreaterThan(10);
      for (const notification of frames) validator.assertNotification(notification);

      // There is exactly one frame shape now. The pre-rewrite `{event, stats, report}`
      // frame is gone from the daemon and from the schema, so a client can no longer
      // double-apply a turn by reading both.
      const canonical = frames.filter((message) => {
        const params = message.params as Record<string, unknown>;
        return params !== null && typeof params === "object" && "update" in params;
      });
      expect(canonical).toHaveLength(frames.length);
      for (const notification of canonical) {
        validator.assert(notification.params, "#/$defs/canonicalUpdateParams", "canonical params");
      }
      const tags = canonical.map((message) => ((message.params as { update: { sessionUpdate: string } }).update.sessionUpdate));
      expect(tags[0]).toBe("turn_start");
      expect(tags.at(-1)).toBe("turn_end");
      for (const required of ["turn_start", "context", "message_start", "part_start", "delta", "part_end", "tool_call_start", "tool_call_update", "tool_call_end", "message_end", "turn_end"]) {
        expect(tags).toContain(required);
      }
      const end = canonical.at(-1)!.params as { update: Record<string, unknown> };
      expect(end.update).toMatchObject({ sessionUpdate: "turn_end", status: "completed", stopReason: "end_turn" });

      // Deltas carry chunks, never the accumulated message.
      const deltas = canonical
        .map((message) => (message.params as { update: Record<string, unknown> }).update)
        .filter((update) => update.sessionUpdate === "delta");
      expect(deltas.some((delta) => delta.field === "text")).toBe(true);
      expect(deltas.some((delta) => delta.field === "arguments")).toBe(true);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("the new session, steer, cancel, and listing methods route and return declared shapes", async () => {
    const root = await fixture();
    const runtime = await LyraRuntime.create({ origin: root, session: "method-surface", environment: environment(scripted([textRound("hello")])), home: join(root, "home") });
    const writer = new Writer();
    try {
      await runtime.app.acp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), writer);
      const call = async (id: number, method: string, params?: unknown): Promise<unknown> => {
        await runtime.app.acp.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        const message = writer.messages().find((entry) => entry.id === id);
        if (message?.error !== undefined) throw new Error(JSON.stringify(message.error));
        return message?.result;
      };

      const snapshot = await call(2, "session/snapshot") as { descriptor: { sessionId: string } };
      validator.assert(snapshot, "#/$defs/requests/session~1snapshot/result", "session/snapshot result");
      const list = await call(3, "session/list") as Array<{ sessionId: string; active: boolean }>;
      validator.assert(list, "#/$defs/requests/session~1list/result", "session/list result");
      // A listing row is addressable: its sessionId is the one `session/update` frames carry.
      expect(list.find((row) => row.active)?.sessionId).toBe(snapshot.descriptor.sessionId);
      validator.assert(await call(4, "session/providers"), "#/$defs/requests/session~1providers/result", "session/providers result");
      expect(await call(5, "session/cancel", { rewoundToComposer: true })).toEqual({ cancelled: false });
      const steer = await call(6, "session/steer", { prompt: "no turn is running" });
      validator.assert(steer, "#/$defs/requests/session~1steer/result", "session/steer result");
      expect(steer).toEqual({ delivery: "prompted", pending: 0 });

      // The model surface is cross-provider: `current` is a full reference, and the catalogue
      // is grouped by provider rather than being the active one's list.
      const models = await call(7, "session/models") as { providers: Array<{ provider: string; models: Array<{ id: string }> }>; current: string };
      expect(models.current).toBe("fixture/fixture-model");
      expect(models.providers.map((row) => row.provider)).toEqual(["fixture"]);
      // The endpoint is unreachable on purpose, so the declared models are the whole answer —
      // a failed discovery leaves a provider with what it declares, not with nothing.
      expect(models.providers[0]!.models.map((model) => model.id)).toEqual(["fixture-model"]);
      validator.assert(models, "#/$defs/requests/session~1models/result", "session/models result");
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});

/** Writes files in the order given, so later files have later modification times. */
async function seed(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

/**
 * Issues ACP requests against a live daemon and returns each result.
 *
 * Polls for the reply rather than sleeping a fixed interval: several of these commands do
 * real work on disk — opening a workspace manager, walking a checkpoint history — and a
 * fixed sleep turns a slow machine into a failing assertion about the wrong thing.
 */
function caller(runtime: LyraRuntime, writer: Writer): (method: string, params?: unknown) => Promise<unknown> {
  let id = 100;
  return async (method, params) => {
    const current = (id += 1);
    await runtime.app.acp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: current, method, ...(params === undefined ? {} : { params }) }));
    const deadline = Date.now() + 20_000;
    let message = writer.messages().find((entry) => entry.id === current);
    while (message === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      message = writer.messages().find((entry) => entry.id === current);
    }
    if (message === undefined) throw new Error(`ACP request ${method} produced no reply within 20s.`);
    if (message.error !== undefined) throw new Error(JSON.stringify(message.error));
    return message.result;
  };
}

describe("slash command surface", () => {
  test("the command list is served as data, and every command's live output has the shape it declares", async () => {
    const root = await fixture();
    const runtime = await LyraRuntime.create({ origin: root, session: "command-surface", environment: environment(scripted([textRound("hello")])), home: join(root, "home") });
    const writer = new Writer();
    try {
      await runtime.app.acp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), writer);
      const call = caller(runtime, writer);

      // One real turn first: the rewind assertions below are about what a turn leaves
      // behind, and a daemon that has never run one honestly has nothing to list.
      await call("session/prompt", { prompt: "say hello" });

      const listing = await call("session/commands") as { commands: Array<{ name: string; resultKind: string; usage?: string }> };
      validator.assert(listing, "#/$defs/requests/session~1commands/result", "session/commands result");
      // The listing is the router's own table, not a restatement of it: a command that is
      // advertised is routed, and a routed command is advertised.
      expect(listing.commands.map((entry) => entry.name)).toEqual(SLASH_COMMAND_CATALOG.map((entry) => entry.name));
      expect(listing.commands).toEqual([...SLASH_COMMAND_CATALOG]);
      // An unlisted name is not routed, so the popup can never offer one that fails.
      const unknown = await call("session/command", { command: "/todo" }) as { command: string; resultKind: string; error?: string };
      validator.assert(unknown, "#/$defs/requests/session~1command/result", "/todo result");
      expect(unknown.error).toContain("Unknown command /todo");

      // Each enumerable kind, run for real and validated against the shape it names.
      for (const [command, kind] of [
        ["/agents", "agents"], ["/workspaces", "workspaces"], ["/sessions", "sessions"],
        ["/skills", "skills"], ["/mcp", "mcp"], ["/health", "health"], ["/context", "context"],
        ["/model", "models"],
      ] as const) {
        const result = await call("session/command", { command }) as { resultKind: string; output?: unknown; error?: string };
        expect(result.error).toBeUndefined();
        expect(result.resultKind).toBe(kind);
        validator.assert(result.output, `#/$defs/${kind}Result`, `${command} output`);
      }

      // The rewind surface names its own shapes: a checkpoint listing and a per-file diff
      // are structure, so they are declared kinds rather than prose with a payload stapled
      // to it, and a client dispatches to a renderer without sniffing `detail`.
      const checkpoints = await call("session/command", { command: "/checkpoints" }) as { resultKind: string; output: unknown };
      expect(checkpoints.resultKind).toBe("checkpoints");
      validator.assert(checkpoints.output, "#/$defs/checkpointsResult", "/checkpoints output");
      const listed = (checkpoints.output as { checkpoints: Array<{ id: string; kind: string }> }).checkpoints;
      // The turn that just ran left its boundary checkpoints behind.
      expect(listed.length).toBeGreaterThan(0);
      for (const record of listed) validator.assert(record, "#/$defs/checkpoint", "checkpoint record");

      const review = await call("session/command", { command: "/review" }) as { resultKind: string; output: unknown };
      expect(review.resultKind).toBe("review");
      validator.assert(review.output, "#/$defs/reviewResult", "/review output");
      validator.assert((review.output as { diff: unknown }).diff, "#/$defs/checkpointDiffResult", "/review diff");

      // Moving the head back is its own method, and the only one that reports itself as a
      // rewind: nothing is deleted, so the entry it lands on is echoed and what stopped
      // being an ancestor of the head is counted.
      const anchored = listed.find((record) => (record as { entryId?: string }).entryId !== undefined) as { id: string; entryId: string } | undefined;
      expect(anchored).toBeDefined();
      const before = await call("session/snapshot") as { entries: unknown[] };
      // With no entryId the daemon picks the newest anchored checkpoint itself — never the
      // entry the head is already on, because landing where you already are is not a rewind.
      const defaulted = await call("session/rewind") as { descriptor: { headId: string }; entryId: string };
      validator.assert(defaulted, "#/$defs/requests/session~1rewind/result", "session/rewind default");
      expect(defaulted.descriptor.headId).toBe(defaulted.entryId);

      const rewound = await call("session/rewind", { entryId: anchored!.entryId }) as { descriptor: { headId: string }; entryId: string; removedMessages?: number };
      validator.assert(rewound, "#/$defs/requests/session~1rewind/result", "session/rewind result");
      expect(rewound.entryId).toBe(anchored!.entryId);
      expect(rewound.descriptor.headId).toBe(anchored!.entryId);
      // Nothing is deleted: the transcript is a DAG on disk, so the entries stay in the
      // file and only the head moved. That is what makes the rewind itself reversible.
      const after = await call("session/snapshot") as { entries: unknown[] };
      expect(after.entries.length).toBe(before.entries.length);

      // Rewinding is the same mechanism, reported as a sentence plus the structure.
      const rolled = await call("session/command", { command: `/rollback ${listed.at(-1)!.id}` }) as { resultKind: string; output: unknown; error?: string };
      expect(rolled.error).toBeUndefined();
      validator.assert(rolled.output, "#/$defs/reportResult", "/rollback output");
      validator.assert((rolled.output as { detail: unknown }).detail, "#/$defs/checkpointRestoreResult", "/rollback detail");

      // The three rewind methods answer in their declared shapes over the wire too.
      validator.assert(await call("checkpoint/list", { limit: 5 }), "#/$defs/requests/checkpoint~1list/result", "checkpoint/list result");
      validator.assert(await call("checkpoint/diff", { patches: true }), "#/$defs/requests/checkpoint~1diff/result", "checkpoint/diff result");
      validator.assert(await call("checkpoint/restore", { checkpoint: listed[0]!.id }), "#/$defs/requests/checkpoint~1restore/result", "checkpoint/restore result");

      // /gitmode is gone with the modes it set; an unlisted name is not routed.
      const retired = await call("session/command", { command: "/gitmode auto" }) as { error?: string };
      expect(retired.error).toContain("Unknown command /gitmode");

      // Selecting a model answers with the same shape listing does, so a client renders
      // one view instead of branching on the arguments it happened to send.
      const selected = await call("session/command", { command: "/model fixture-model" }) as { resultKind: string; output: unknown };
      expect(selected.resultKind).toBe("models");
      validator.assert(selected.output, "#/$defs/modelsResult", "/model <ref> output");
      expect((selected.output as { current: string }).current).toBe("fixture/fixture-model");

      // A failure declares a renderable kind too, and never invents an output.
      const missing = await call("session/command", { command: "/kill" }) as { resultKind: string; output?: unknown; error?: string };
      validator.assert(missing, "#/$defs/commandResult", "/kill result");
      expect(missing.output).toBeUndefined();
      expect(missing.error).toContain("/kill requires an agent name");
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe("workspace file completion", () => {
  test("candidates are workspace-relative, gitignore-aware, and ranked prefix before substring before fuzzy", async () => {
    const root = await fixture();
    const runtime = await LyraRuntime.create({ origin: root, session: "completion", environment: environment(scripted([textRound("hello")])), home: join(root, "home") });
    const writer = new Writer();
    const workspace = runtime.app.cwd;
    const sessionId = runtime.session.descriptor.sessionId;
    try {
      await runtime.app.acp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), writer);
      const call = caller(runtime, writer);
      await seed(workspace, {
        ".gitignore": ".lyra/\nnode_modules/\n*.log\n",
        "src/authz-helper.ts": "export const authz = true;\n",
        "src/auth.ts": "export const auth = true;\n",
        "lib/reauth.ts": "export const reauth = true;\n",
        "app/utils/theme.ts": "export const theme = 1;\n",
        "node_modules/pkg/index.js": "module.exports = {};\n",
        "debug.log": "noise\n",
      });

      const result = await call("session/complete", { sessionId, kind: "file", query: "auth" }) as { items: Array<{ value: string; label?: string; detail?: string }>; truncated: boolean };
      validator.assert(result, "#/$defs/requests/session~1complete/result", "session/complete result");
      // Ranked, and the order is the answer: basename prefix, then basename substring,
      // then subsequence. A client that re-sorted this would bury src/auth.ts.
      expect(result.items.map((entry) => entry.value)).toEqual([
        "src/auth.ts", "src/authz-helper.ts", "lib/reauth.ts", "app/utils/theme.ts",
      ]);
      expect(result.truncated).toBe(false);
      // Paths are workspace-relative and forward-slashed: the client inserts `value` verbatim.
      expect(result.items[0]).toEqual({ value: "src/auth.ts", label: "auth.ts", detail: "src" });
      // Ignored files are not candidates at all — not ranked last, absent.
      const everything = await call("session/complete", { sessionId, kind: "file", query: "", limit: 50 }) as { items: Array<{ value: string }> };
      const values = everything.items.map((entry) => entry.value);
      expect(values).not.toContain("debug.log");
      expect(values.some((value) => value.startsWith("node_modules/"))).toBe(false);
      expect(values).toContain("src/auth.ts");

      // A file added after the index was built is found: the cache is invalidated by the
      // directory mtimes it was built from, not by a timer.
      await seed(workspace, { "src/authenticate.ts": "export const authenticate = 1;\n" });
      const refreshed = await call("session/complete", { sessionId, kind: "file", query: "authen" }) as { items: Array<{ value: string }> };
      expect(refreshed.items.map((entry) => entry.value)).toContain("src/authenticate.ts");

      // The limit is clamped, not obeyed blindly, and truncation is reported rather than
      // implied by a short list.
      await seed(workspace, Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`many/file-${index}.ts`, `export const n = ${index};\n`])));
      const capped = await call("session/complete", { sessionId, kind: "file", query: "", limit: 50 }) as { items: unknown[]; truncated: boolean };
      expect(capped.items).toHaveLength(50);
      expect(capped.truncated).toBe(true);
      const paged = await call("session/complete", { sessionId, kind: "file", query: "" }) as { items: unknown[]; truncated: boolean };
      expect(paged.items).toHaveLength(10);
      expect(paged.truncated).toBe(true);

      // A popup keystroke must not cost a tree walk: the warm path validates the cache
      // against directory mtimes instead of rebuilding it.
      const started = performance.now();
      await call("session/complete", { sessionId, kind: "file", query: "fil" });
      expect(performance.now() - started).toBeLessThan(50);

      // An unimplemented kind is an error naming what exists, never an empty list a client
      // would render as "no matches".
      await expect(call("session/complete", { sessionId, kind: "symbol", query: "auth" })).rejects.toThrow(/completes: file/);
      await expect(call("session/complete", { sessionId: "not-this-session", kind: "file", query: "" })).rejects.toThrow(/not the session/);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});

/** One `session/list` row, as a client reads it. */
interface ListingRow {
  sessionId: string;
  name: string;
  path: string;
  active: boolean;
  firstPrompt?: string;
  updatedAtMs?: number;
  messages?: number;
}

describe("session listing previews", () => {
  test("a row carries its first prompt, its raw mtime and its message count, from memory and from disk alike", async () => {
    const root = await fixture();
    const runtime = await LyraRuntime.create({ origin: root, session: "with-history", environment: environment(scripted([textRound("hello")])), home: join(root, "home") });
    const writer = new Writer();
    try {
      await runtime.app.acp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), writer);
      const call = caller(runtime, writer);
      // Long enough to truncate, and shaped so the collapse of newlines is visible.
      const prompt = `  ${"explain the retry ladder ".repeat(8)}\n\nand the queue  `;
      const collapsed = prompt.replace(/\s+/g, " ").trim();
      expect(collapsed.length).toBeGreaterThan(100);
      await runtime.prompt(prompt);

      // The active session is previewed from memory: no read, same answer.
      const active = await call("session/list") as ListingRow[];
      validator.assert(active, "#/$defs/requests/session~1list/result", "session/list result");
      const row = active.find((entry) => entry.name === "with-history")!;
      expect(row.active).toBe(true);
      expect(row.firstPrompt).toBe(`${collapsed.slice(0, 100)}…`);
      expect(row.messages).toBe(2);
      // A raw measurement, not a rendered one: epoch milliseconds, integral, and the
      // file's own mtime rather than the moment the listing ran.
      const stats = await stat(row.path);
      expect(Number.isSafeInteger(row.updatedAtMs)).toBe(true);
      expect(Math.abs(row.updatedAtMs! - stats.mtimeMs)).toBeLessThan(1_000);
      expect(Math.abs(row.updatedAtMs! - Date.now())).toBeLessThan(60_000);

      // Switching away re-reads the same transcript from disk. The two paths must agree.
      await call("session/new", { name: "empty-session" });
      const listed = await call("session/list") as ListingRow[];
      validator.assert(listed, "#/$defs/requests/session~1list/result", "session/list result");
      const fromDisk = listed.find((entry) => entry.name === "with-history")!;
      expect(fromDisk.active).toBe(false);
      expect(fromDisk.firstPrompt).toBe(row.firstPrompt);
      expect(fromDisk.messages).toBe(2);
      expect(fromDisk.sessionId).toBe(row.sessionId);

      // A session with nothing said in it previews nothing: the field is absent rather
      // than an empty string a picker would render as a blank column.
      const fresh = listed.find((entry) => entry.name === "empty-session")!;
      expect(fresh.messages).toBe(0);
      expect("firstPrompt" in fresh).toBe(false);
      expect(fresh.updatedAtMs).toBeGreaterThan(0);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("an oversized transcript keeps its prompt preview and reports no count at all", async () => {
    const root = await fixture();
    const runtime = await LyraRuntime.create({ origin: root, session: "budgeted", environment: environment(scripted([textRound("hello")])), home: join(root, "home") });
    const writer = new Writer();
    try {
      await runtime.app.acp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), writer);
      const call = caller(runtime, writer);
      const sessions = dirname((await call("session/list") as ListingRow[])[0]!.path);

      // A transcript past the per-file scan budget, written directly: the first lines
      // carry the header and the prompt, and the bulk is past where the scan stops.
      const entry = (index: number, extra: Record<string, unknown>) => JSON.stringify({
        id: `e-${index}`, parentId: index === 0 ? null : `e-${index - 1}`,
        timestamp: "2026-08-09T10:00:00.000Z", ...extra,
      });
      const lines = [
        entry(0, { type: "session", sessionId: "s-huge", name: "huge", origin: root, workspace: root, provider: "fixture", model: "fixture-model" }),
        entry(1, { type: "message", role: "user", content: [{ type: "text", text: "why is the transcript so large" }], status: "complete" }),
      ];
      const filler = "x".repeat(64 * 1024);
      for (let index = 2; index < 82; index += 1) {
        lines.push(entry(index, { type: "message", role: "assistant", content: [{ type: "text", text: filler }], status: "complete" }));
      }
      await writeFile(join(sessions, "huge.jsonl"), `${lines.join("\n")}\n`);
      expect((await stat(join(sessions, "huge.jsonl"))).size).toBeGreaterThan(4 * 1024 * 1024);

      const listed = await call("session/list") as ListingRow[];
      validator.assert(listed, "#/$defs/requests/session~1list/result", "session/list result");
      const huge = listed.find((entry) => entry.name === "huge")!;
      // Addressable and previewable — the two things a picker needs — while the count it
      // could not finish measuring is absent rather than a partial number.
      expect(huge.sessionId).toBe("s-huge");
      expect(huge.firstPrompt).toBe("why is the transcript so large");
      expect("messages" in huge).toBe(false);
      expect(huge.updatedAtMs).toBeGreaterThan(0);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});

/**
 * The Rust TUI ships a hard-coded copy of the command names so `/` works on the first
 * keystroke of a session, before `session/commands` has answered — and on a daemon that
 * never declares a registry at all. It is a *fallback*, replaced the moment the real
 * registry lands, so a stale entry costs only a missing description; but it went stale
 * once already (it still offered `/gitmode` a release after the modes it set were
 * deleted, and offered nothing for the rewind surface that had replaced them), and a
 * fallback that offers a command the daemon will refuse is worse than no fallback.
 *
 * This is the tripwire. It reads the constant out of the Rust source rather than
 * restating it, because a restatement is a third copy with its own drift.
 */
describe("the client's pre-hydration command list", () => {
  test("names exactly the commands this daemon routes", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "..", "..", "lyra-tui", "src", "app.rs")).text();
    const block = /pub const SLASH_COMMANDS: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(source);
    expect(block).not.toBeNull();
    const names = [...block![2]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    expect(names.length).toBe(Number(block![1]));
    expect([...names].sort()).toEqual([...SLASH_COMMANDS].sort());
  });
});
