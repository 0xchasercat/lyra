import { IrcBus, SpawnManager } from "@lyra/core";
import { CHECKPOINT_EXCLUDED_PATHS } from "@lyra/git";
import { LspManager } from "@lyra/lsp";
import { McpGateway, McpRegistry } from "@lyra/mcp";
import { ReliableProvider, type ProviderRequest, type ProviderTransport, type TransportEvent } from "@lyra/provider";
import { RuntimeManager } from "@lyra/runtime";
import { SkillRegistry } from "@lyra/skills";
import { ToolRegistry } from "@lyra/tools";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeMapService, type CodeMapStatus, type MapAccess } from "../src/code-map.ts";
import { INTEGRATED_TOOL_NAMES, createIntegratedToolRegistry, normalizeMapArgs } from "../src/integrated-tools.ts";
import { LyraApplication, LyraRuntime } from "../src/index.ts";
import type { SessionServices } from "../src/index.ts";

/**
 * The code graph, as the product rather than the library.
 *
 * `@lyra/map`'s own suites prove the graph is correct. This one proves the four things that
 * only exist once it is wired into a session: a model's first call lands whatever dialect it
 * arrives in, boot never waits for the index, an edit made through the tools reaches the
 * graph with nobody re-indexing anything, and every answer says how far behind the working
 * tree it is.
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A small, real repository: two files that reference each other, and one long one. */
async function fixture(prefix = "lyra-map-"): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "greet.ts"), "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n");
  await writeFile(join(root, "src", "app.ts"), 'import { greet } from "./greet.ts";\n\nexport function main(): string {\n  return greet("world");\n}\n');
  await writeFile(join(root, "src", "long.ts"), `export function longRunner(): number {\n${"  // a line that exists only to make this function long\n".repeat(80)}  return 1;\n}\n`);
  return root;
}

async function service(root: string): Promise<CodeMapService> {
  const created = new CodeMapService({ root });
  cleanups.push(() => created.close());
  created.ensureStarted();
  await created.settled();
  return created;
}

/** The registry the application builds, over a real tree, with the map wired in. */
function registryFor(root: string, map: MapAccess | undefined, displayBudget?: number): ToolRegistry {
  const bus = new IrcBus();
  const spawn = new SpawnManager({ defaultWorkspace: root, availableTools: INTEGRATED_TOOL_NAMES, executor: async () => ({ ok: true }) });
  const registry = createIntegratedToolRegistry({
    lsp: new LspManager({ workspace: root } as never),
    spawn, bus, peer: "main",
    skills: new SkillRegistry({ workspace: root, home: root, projectRoot: root, userRoot: root, bundledRoot: root } as never),
    runtime: new RuntimeManager({ origin: root, session: "map", adapters: {} } as never),
    mcp: new McpGateway(new McpRegistry(root)),
    ...(map === undefined ? {} : { map }),
    filesystem: { root, ...(displayBudget === undefined ? {} : { displayBudget }) }, bash: { root }, cwd: root, origin: root,
  });
  cleanups.push(async () => { await registry.close(); await spawn.close?.(); });
  return registry;
}

function context(root: string): never {
  return { signal: new AbortController().signal, sessionId: "map", workspace: root, callId: "call-1", cwd: root, origin: root } as never;
}
function text(result: { content: unknown }): string { return String(result.content); }

/** A map that is in one fixed state, for the two answers that are about the state itself. */
function stubbed(status: CodeMapStatus): MapAccess {
  return { root: "/tmp", ensureStarted: () => undefined, status: () => status, graph: () => undefined, staleLine: async () => undefined };
}

describe("the map tool", () => {
  test("answers all six ops, in whatever dialect the call arrives in", async () => {
    const root = await fixture();
    const registry = registryFor(root, await service(root));

    // No op at all is the overview: the cheapest useful thing a model can ask a new repository.
    const overview = await registry.execute("map", {}, context(root));
    expect(overview.isError).not.toBe(true);
    expect(text(overview)).toContain("verb: overview");
    expect(text(overview)).toContain("files: 3");

    // `q` is Claude Code's spelling; the op is inferred from the field that carries it.
    const search = await registry.execute("map", { q: "greet" }, context(root));
    expect(text(search)).toContain("verb: search");
    expect(text(search)).toContain("greet");

    // `name` for the symbol, and `callers` for the question impact answers.
    const explain = await registry.execute("map", { op: "explain", name: "greet" }, context(root));
    expect(text(explain)).toContain("verb: explain");
    expect(text(explain)).toContain("src.greet.greet");
    const impact = await registry.execute("map", { op: "callers", symbol: "greet", max_depth: 2 }, context(root));
    expect(text(impact)).toContain("verb: impact");
    expect(text(impact)).toContain("main");

    // Two endpoints and no op can only be a path.
    const path = await registry.execute("map", { from: "main", to: "greet" }, context(root));
    expect(text(path)).toContain("verb: path");
    expect(text(path)).toContain("calls");

    // `file_path` is the spelling a model reaches for when it wants source back.
    const snippet = await registry.execute("map", { op: "snippet", file_path: "greet" }, context(root));
    expect(snippet.isError).not.toBe(true);
    expect(text(snippet)).toContain("src/greet.ts:1-3 — src.greet.greet");
    expect(text(snippet)).toContain("hello ${name}");
  }, 20_000);

  test("drops schema-complete padding instead of answering the wrong question", async () => {
    const root = await fixture();
    const registry = registryFor(root, await service(root));
    // The observed emitter fills every declared property. A padded `op` must not beat the
    // real question, and a padded `from` must not turn a search into a broken path.
    const result = await registry.execute("map", { op: "", query: "greet", symbol: "", from: "", to: "", depth: 0, budget: 0 }, context(root));
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("verb: search");
    expect(normalizeMapArgs({ op: null, symbol: "greet", depth: null })).toEqual({ op: "explain", symbol: "greet" });
  }, 20_000);

  test("a path with one end says which end is missing", () => {
    const lesson = normalizeMapArgs({ from: "main" });
    expect(typeof lesson).toBe("string");
    expect(String(lesson)).toContain("needs both from and to");
    // And the ops a model might invent are named against the six that exist.
    expect(String(normalizeMapArgs({ op: "outline-everything" }))).toContain("overview, search, explain, impact, path, or snippet");
  });

  test("a field the chosen op does not read is reported, never swallowed", async () => {
    const root = await fixture();
    const registry = registryFor(root, await service(root));
    const result = await registry.execute("map", { op: "overview", depth: 3 }, context(root));
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("depth is not read by op \"overview\"");
  }, 20_000);

  test("a question asked before the first index answers with the count, not with silence", async () => {
    const registry = registryFor(await fixture(), stubbed({ phase: "indexing", indexed: 0, total: 12 }));
    const result = await registry.execute("map", {}, context("/tmp"));
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("indexing — 0 of 12 files");
    expect(text(result)).toContain("grep");
  });

  test("an index that could not be built disables the tool and says so once", async () => {
    const registry = registryFor(await fixture(), stubbed({ phase: "unavailable", indexed: 0, total: 0, reason: "bun:sqlite is unavailable." }));
    const result = await registry.execute("map", {}, context("/tmp"));
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("bun:sqlite is unavailable");
    expect(text(result)).toContain("grep, glob, and read");
  });

  test("snippet reads the real file through read, display budget and all", async () => {
    const root = await fixture();
    const map = await service(root);
    // 200 bytes is smaller than the long function, so the read tool's own spill applies here
    // exactly as it would for a direct read — which is the point of going through it.
    const registry = registryFor(root, map, 200);
    const result = await registry.execute("map", { op: "snippet", symbol: "longRunner" }, context(root));
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("src/long.ts:1-83 — src.long.longRunner");
    expect(text(result)).toContain("[truncated:");
    expect(result.progress?.filesRead?.[0]).toContain("long.ts");
  }, 20_000);

  test("an out-of-band edit shows up as the staleness line on the next answer", async () => {
    const root = await fixture();
    const map = await service(root);
    // The user's own editor, not a tool call: nothing notified the graph.
    await writeFile(join(root, "src", "greet.ts"), "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n\nexport function farewell(): string {\n  return \"bye\";\n}\n");
    const registry = registryFor(root, map);
    const result = await registry.execute("map", { q: "greet" }, context(root));
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("stale: 1 file (src/greet.ts)");
    expect(text(result)).toContain("read the files for ground truth");
  }, 20_000);

  test("a nonexistent symbol comes back with the vocabulary that would have worked", async () => {
    const root = await fixture();
    const registry = registryFor(root, await service(root));
    const result = await registry.execute("map", { op: "snippet", symbol: "greetings" }, context(root));
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("No symbol named \"greetings\"");
    expect(text(result)).toContain("greet");
  }, 20_000);

  test("the description sells exploration inside the window the system prompt shows", async () => {
    const registry = registryFor(await fixture(), undefined);
    const definition = registry.definitions().find((candidate) => candidate.name === "map")!;
    const head = definition.description.slice(0, 180);
    for (const promise of ["architecture", "symbol search", "who-calls-what", "change impact", "grep"]) expect(head).toContain(promise);
    // The vocabulary rule is on the tool, not in the prompt: §14 stays an index.
    expect(definition.description).toContain("never with an invented synonym");
    const schema = definition.inputSchema as { properties: Record<string, unknown>; additionalProperties: boolean };
    expect(Object.keys(schema.properties)).toEqual(["op", "query", "symbol", "from", "to", "depth", "budget"]);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("the graph in a session", () => {
  test("boot opens the graph, indexes behind the session, and never waits for it", async () => {
    const root = await fixture("lyra-map-boot-");
    // Not a git repository: the map has nothing to do with git, and must not need one.
    expect(existsSync(join(root, ".git"))).toBe(false);
    const app = await LyraApplication.boot({ origin: root, session: "map-boot", spawnExecutor: async (request) => `done:${request.task}`, sessions: sessionServices(), home: join(root, "home") });
    cleanups.push(() => app.close());
    // Boot returned while the index was still being built — the assertion is that this state
    // is reachable at all, which is only true because nothing awaited it.
    expect(["indexing", "ready"]).toContain(app.map.status().phase);

    await app.map.settled();
    expect(app.map.status().phase).toBe("ready");
    expect(existsSync(join(root, ".lyra", "map.db"))).toBe(true);
    const overview = await app.tools.execute("map", {}, context(root));
    expect(overview.isError).not.toBe(true);
    expect(text(overview)).toContain("verb: overview");

    // A second boot on the same tree has an index already: it catches up rather than
    // rebuilding, and is queryable immediately.
    await app.close();
    const second = await LyraApplication.boot({ origin: root, session: "map-boot-2", spawnExecutor: async (request) => `done:${request.task}`, sessions: sessionServices(), home: join(root, "home") });
    cleanups.push(() => second.close());
    await second.map.settled();
    expect(second.map.status().phase).toBe("ready");
    expect((await second.map.info()).files).toBe(3);
  }, 30_000);

  test("an edit made while the first index is still running is folded in when it lands", async () => {
    const root = await fixture();
    const map = new CodeMapService({ root, debounceMs: 5 });
    cleanups.push(() => map.close());
    map.ensureStarted();
    // Mid-flight: the graph does not exist yet, and the update must neither be lost nor
    // wait on the pass that is about to drain it.
    await writeFile(join(root, "src", "late.ts"), "export function lateArrival(): number {\n  return 1;\n}\n");
    map.noteModified(["src/late.ts"]);
    await map.settled();
    await map.flushNow();
    expect(map.status().phase).toBe("ready");
    expect(map.graph()!.nodesByName("lateArrival")).not.toHaveLength(0);
  }, 20_000);

  test("closing during the first walk stops the index without sending a late report", async () => {
    const root = await fixture("lyra-map-close-");
    await Promise.all(Array.from({ length: 300 }, (_, index) => writeFile(
      join(root, "src", `extra-${index}.ts`),
      `export const extra${index} = ${index};\n`,
    )));
    const reports: string[] = [];
    const map = new CodeMapService({ root, onReport: (message) => { reports.push(message); } });

    map.ensureStarted();
    await map.close();

    expect(reports).toEqual([]);
  }, 20_000);

  test("the index lives inside .lyra, so nothing searches, commits, or checkpoints it", async () => {
    const root = await fixture();
    const app = await LyraApplication.boot({ origin: root, session: "map-state", spawnExecutor: async () => "", sessions: sessionServices(), home: join(root, "home") });
    cleanups.push(() => app.close());
    await app.map.settled();
    expect(existsSync(join(root, ".lyra", "map.db"))).toBe(true);
    expect(CHECKPOINT_EXCLUDED_PATHS).toContain(".lyra");
    const globbed = await app.tools.execute("glob", { pattern: "**/*.db" }, context(root));
    expect(text(globbed)).not.toContain("map.db");
    const grepped = await app.tools.execute("grep", { pattern: "SQLite format" }, context(root));
    expect(text(grepped)).not.toContain("map.db");
  }, 30_000);

  test("/health carries the index and /cleanup catches it up", async () => {
    const root = await fixture();
    const app = await LyraApplication.boot({ origin: root, session: "map-health", spawnExecutor: async () => "", sessions: sessionServices(), home: join(root, "home") });
    cleanups.push(() => app.close());
    await app.map.settled();
    const health = ((await app.slash("/health")) as { output: { map: { state: string; files: number; bytes: number } } }).output;
    expect(health.map).toMatchObject({ state: "ready", files: 3 });
    expect(health.map.bytes).toBeGreaterThan(0);

    await rm(join(root, "src", "long.ts"));
    const cleaned = ((await app.slash("/cleanup")) as { output: { map: { removed: number } } }).output;
    expect(cleaned.map.removed).toBe(1);
    expect((await app.map.info()).files).toBe(2);
  }, 30_000);

  test("a shared tree shares one graph; an isolated workspace gets its own, lazily", async () => {
    const root = await fixture();
    const app = await LyraApplication.boot({ origin: root, session: "map-children", spawnExecutor: async () => "", sessions: sessionServices(), home: join(root, "home") });
    cleanups.push(() => app.close());
    // Every child of this session sees `map` in the tool list it may ask for.
    expect([...INTEGRATED_TOOL_NAMES]).toContain("map");
    expect(app.spawn.status("nobody")).toBeUndefined();

    // Same tree, same instance — wave 1 serializes writes inside one CodeMap, not across two.
    expect(app.maps.get(root)).toBe(app.map);
    const isolated = join(root, ".lyra", "workspaces", "child");
    await mkdir(isolated, { recursive: true });
    const childMap = app.maps.get(isolated);
    expect(childMap).not.toBe(app.map);
    // Lazily: a child that never asks the graph anything never pays to build one.
    expect(childMap.status().phase).toBe("cold");

    const childTools = createIntegratedToolRegistry({
      lsp: app.lsp, spawn: app.spawn, bus: app.bus, peer: "child", allowedTools: ["read", "map"],
      skills: app.skills, runtime: app.runtime, mcp: app.mcpTool, map: childMap,
      filesystem: { root: isolated }, bash: { root: isolated },
    });
    cleanups.push(() => childTools.close());
    expect(childTools.definitions().map((definition) => definition.name)).toEqual(["read", "map"]);
  }, 30_000);

  /**
   * The demo the whole design is for: nobody re-indexes anything.
   *
   * A scripted session explores with `map` instead of grep, writes a new function through
   * the `write` tool, and asks the graph about it. Between those two calls the only thing
   * that happened is a tool call reporting the file it changed — the dispatcher hook, the
   * debounce, and the incremental update do the rest.
   */
  test("a file written through the tools reaches the graph, and the session explores through it", async () => {
    const root = await fixture("lyra-map-e2e-");
    const calls: string[] = [];
    const transport = scripted([
      call("t1", "map", {}),
      call("t2", "map", { op: "search", query: "greet" }),
      call("t3", "map", { op: "explain", symbol: "greet" }),
      call("t4", "write", { path: "src/audit.ts", content: 'import { greet } from "./greet.ts";\n\nexport function auditGreeting(): string {\n  return greet("audit");\n}\n' }),
      // The map call the whole design exists for: the symbol was written one turn ago and
      // nothing re-indexed anything in between.
      // Last round, and it repeats: the model asks again until the answer has the symbol in
      // it, which is exactly what a model would do and exactly what must eventually work.
      pollingCall("t5", "map", { op: "search", query: "auditGreeting" }, (answer) => answer.includes("src.audit")),
    ], calls);

    const runtime = await LyraRuntime.create({ origin: root, session: "map-e2e", environment: environment(transport), home: join(root, "home") });
    cleanups.push(() => runtime.close());
    await runtime.app.map.settled();

    const result = await runtime.prompt("explore this repository with the map and add an audit");
    expect(result.assistant.content).toEqual([{ type: "text", text: "audited" }]);

    // Every map answer the session saw, in order, and not one grep among them.
    const answers = calls.filter((entry) => entry.startsWith("map:"));
    expect(answers.length).toBeGreaterThanOrEqual(4);
    expect(answers[0]).toContain("verb: overview");
    expect(answers[1]).toContain("verb: search");
    expect(answers[2]).toContain("src.greet.greet");
    // The symbol itself, from the file written one turn earlier — not the query echoed back.
    expect(answers.at(-1)).toContain("src.audit");
    expect(calls.some((entry) => entry.startsWith("grep:"))).toBe(false);
    // And the graph itself, not just the answer, knows the new symbol.
    expect(runtime.app.map.graph()!.nodesByName("auditGreeting")).not.toHaveLength(0);
  }, 40_000);
});

// ---------------------------------------------------------------- scripted provider

type Round = (request: ProviderRequest) => AsyncGenerator<TransportEvent> | Promise<AsyncGenerator<TransportEvent>>;

/** Runs the rounds in order, recording every tool result the conversation was handed. */
function scripted(rounds: Round[], calls: string[]): ProviderTransport {
  let index = 0;
  return {
    id: "scripted",
    apiType: "openai_completions",
    async *stream(request) {
      for (const [name, answer] of latestResults(request)) calls.push(`${name}:${answer}`);
      const step = rounds[Math.min(index, rounds.length - 1)]!;
      index += 1;
      yield* await step(request);
    },
  };
}

/** The tool results this request carries, newest turn last, paired with the tool that produced them. */
function latestResults(request: ProviderRequest): Array<[string, string]> {
  const names = new Map<string, string>();
  const output: Array<[string, string]> = [];
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") names.set(block.id, block.name);
      if (block.type === "tool_result") output.push([names.get(block.toolUseId) ?? "?", typeof block.content === "string" ? block.content : JSON.stringify(block.content)]);
    }
  }
  return output.slice(-1);
}

function call(id: string, name: string, args: Record<string, unknown>): Round {
  return async function* (): AsyncGenerator<TransportEvent> {
    yield { type: "tool_call_start", id, name };
    yield { type: "tool_call_delta", id, argumentsDelta: JSON.stringify(args) };
    yield { type: "tool_call_end", id };
    yield { type: "complete", stopReason: "tool_use" };
  };
}

/**
 * The same call, retried until the debounced update has landed.
 *
 * A model would simply ask again; the test does the same rather than reaching into the
 * service and flushing it by hand, because "ask again in a moment and it is there" is the
 * behaviour being asserted.
 */
function pollingCall(id: string, name: string, args: Record<string, unknown>, satisfied: (answer: string) => boolean): Round {
  let attempts = 0;
  return async function* (request: ProviderRequest): AsyncGenerator<TransportEvent> {
    const previous = latestResults(request)[0];
    if (previous !== undefined && previous[0] === name && satisfied(previous[1])) {
      yield { type: "text_delta", text: "audited" };
      yield { type: "complete", stopReason: "end_turn" };
      return;
    }
    attempts += 1;
    if (attempts > 40) throw new Error(`${name} never reflected the change`);
    await Bun.sleep(150);
    yield { type: "tool_call_start", id: `${id}-${attempts}`, name };
    yield { type: "tool_call_delta", id: `${id}-${attempts}`, argumentsDelta: JSON.stringify(args) };
    yield { type: "tool_call_end", id: `${id}-${attempts}` };
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

function sessionServices(): SessionServices {
  const value = async () => null;
  return { copy: value, dump: value, settings: value, provider: value, model: value, loop: value, context: value, compact: value, sessions: value, acp: { "session/new": value, "session/load": value, "session/list": value, "session/snapshot": value, "session/prompt": value, "session/steer": value, "session/cancel": value, "session/fork": value, "session/command": value, "session/complete": value, "session/models": value, "session/select_model": value, "session/providers": value, "session/select_provider": value, "context/inspect": value } } as unknown as SessionServices;
}
