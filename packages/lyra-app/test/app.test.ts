import { ReliableProvider, type ProviderTransport } from "@lyra/provider";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LyraApplication, LyraRuntime, MetricsStore, SlashCommandRouter, durationMs, loadConfig, SLASH_COMMANDS } from "../src/index.ts";
import type { SessionServices, SlashServices } from "../src/index.ts";

async function git(cwd: string, args: string[]): Promise<void> { const child = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "Lyra", GIT_AUTHOR_EMAIL: "lyra@test", GIT_COMMITTER_NAME: "Lyra", GIT_COMMITTER_EMAIL: "lyra@test" }, stdout: "ignore", stderr: "pipe" }); const error = new Response(child.stderr).text(); if (await child.exited !== 0) throw new Error(await error); }
function sessionServices(): SessionServices { const value = async () => null; return { copy: value, dump: value, settings: value, provider: value, model: value, loop: value, context: value, compact: value, sessions: value, acp: { "session/new": value, "session/load": value, "session/list": value, "session/snapshot": value, "session/prompt": value, "session/steer": value, "session/cancel": value, "session/fork": value, "session/command": value, "session/complete": value, "session/models": value, "session/select_model": value, "session/providers": value, "session/select_provider": value, "context/inspect": value } }; }

describe("Lyra application composition", () => {
  test("loads data-only config with project precedence and validates durations", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-app-")); const home = join(root, "home"); const project = join(root, "project");
    try {
      await mkdir(join(home, ".lyra"), { recursive: true }); await mkdir(join(project, ".lyra"), { recursive: true });
      await writeFile(join(home, ".lyra", "config.toml"), "[exec]\nheavy = 2\n[tui]\ntheme = 'paper'\n");
      await writeFile(join(project, ".lyra", "config.toml"), "[exec]\nheavy = 3\n[reliability]\nturn_timeout = '2m'\n[providers.local]\nbase_url = 'http://localhost:8080/v1'\napi_type = 'openai_completions'\nauth = { type = 'none' }\n");
      const config = await loadConfig(project, home);
      expect(config).toMatchObject({ exec: { heavy: 3 }, tui: { theme: "paper" }, reliability: { turn_timeout: "2m" } });
      expect(durationMs("2m")).toBe(120_000);
      await writeFile(join(project, ".lyra", "config.toml"), "[exec]\nheavy = 9\n");
      await expect(loadConfig(project, home)).rejects.toThrow("must not exceed 8");
      await writeFile(join(project, ".lyra", "config.toml"), "[unknown]\nvalue = true\n");
      await expect(loadConfig(project, home)).rejects.toThrow("Unknown Lyra config section");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("health summarizes durable metrics and first-call tool success", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-app-"));
    try {
      const metrics = new MetricsStore(root);
      await Promise.all([metrics.record({ type: "turn", latencyMs: 100, success: true }), metrics.record({ type: "turn", latencyMs: 300, success: false }), metrics.record({ type: "provider_retry", classification: "transient" }), metrics.record({ type: "tool", name: "read", success: true, firstCall: true, latencyMs: 10 }), metrics.record({ type: "compaction", tokensBefore: 100, tokensAfter: 40 }), metrics.record({ type: "context_repair", count: 2 })]);
      const health = await metrics.health({ processes: 1, workspaces: 2 });
      expect(health).toMatchObject({ turns: 2, successfulTurns: 1, retries: { transient: 1 }, compactions: 1, contextRepairs: 2, tools: { read: { firstCallSuccessRate: 1 } }, processes: 1, workspaces: 2 });
      expect(health.turnLatencyMs.p95).toBe(300);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("slash router exposes only the documented compact command surface", async () => {
    const calls: string[] = []; const hit = async (name: string) => { calls.push(name); return name; };
    const services: SlashServices = { copy: () => hit("copy"), dump: () => hit("dump"), settings: () => hit("settings"), provider: () => hit("provider"), model: () => hit("model"), loop: (spec) => hit(`loop:${spec}`), context: () => hit("context"), compact: (clear) => hit(clear ? "clear" : "compact"), agents: (op) => hit(`agents:${op}`), workspaces: (op) => hit(`workspaces:${op}`), checkpoints: () => hit("checkpoints"), review: (from) => hit(`review:${from ?? ""}`), rollback: (checkpoint, force) => hit(`rollback:${checkpoint ?? ""}:${force}`), apply: (preview) => hit(`apply:${preview ?? ""}`), skills: () => hit("skills"), mcp: () => hit("mcp"), install: (tool) => hit(`install:${tool}`), sessions: (op) => hit(`sessions:${op}`), health: () => hit("health") };
    const router = new SlashCommandRouter(services);
    expect((await router.execute('/loop until "tests pass"')).output).toBe("loop:until tests pass");
    // Rewinding is opt-in destructive: the bare form never reverts foreign edits, and the
    // checkpoint id is positional so a flag can never be mistaken for one.
    expect((await router.execute("/rollback cp-4-ab")).output).toBe("rollback:cp-4-ab:false");
    expect((await router.execute("/rollback cp-4-ab --force")).output).toBe("rollback:cp-4-ab:true");
    expect((await router.execute("/rollback")).output).toBe("rollback::false");
    // /gitmode died with the observe/stage/auto modes it set.
    expect((await router.execute("/gitmode auto")).error).toContain("Unknown command");
    expect((await router.execute("/todo")).error).toContain("Unknown command");
    expect(new Set<string>(SLASH_COMMANDS).has("todo")).toBe(false);
    expect(new Set<string>(SLASH_COMMANDS).has("gitmode")).toBe(false);
    expect(new Set<string>(SLASH_COMMANDS).has("checkpoints")).toBe(true);
    expect(calls).toEqual(["loop:until tests pass", "rollback:cp-4-ab:false", "rollback:cp-4-ab:true", "rollback::false"]);
  });

  test("boots zero-config infrastructure with all thirteen stable tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-app-"));
    try {
      await git(root, ["init", "-q", "-b", "main"]); await writeFile(join(root, ".gitignore"), ".lyra/\n"); await writeFile(join(root, "file.txt"), "base\n"); await git(root, ["add", "."]); await git(root, ["commit", "-q", "-m", "base"]);
      const app = await LyraApplication.boot({ origin: root, session: "main-agent", spawnExecutor: async (request) => `done:${request.task}`, sessions: sessionServices(), home: join(root, "home") });
      try {
        expect(app.tools.definitions().map((definition) => definition.name)).toEqual(["read", "write", "edit", "bash", "grep", "glob", "lsp", "spawn", "hub", "skill", "jit", "mcp", "git"]);
        // The main session runs where it was launched: no clone, and the path the model
        // sees is the path the user typed.
        expect(app.cwd).toBe(app.origin);
        expect(app.checkpoints.available).toBe(true);
        expect((await app.commands.execute("/health")).error).toBeUndefined();
        expect(app.skills.list().map((skill) => skill.name)).toContain("adversarial-review");
      } finally { await app.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("assembles provider, transcript, agent loop, tools, and child execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-runtime-"));
    await git(root, ["init", "-q", "-b", "main"]); await writeFile(join(root, ".gitignore"), ".lyra/\n"); await writeFile(join(root, "base.txt"), "base\n"); await git(root, ["add", "."]); await git(root, ["commit", "-q", "-m", "base"]);
    const seenModels: string[] = [];
    const transport: ProviderTransport = { id: "fixture", apiType: "openai_completions", async *stream(request) { seenModels.push(request.model); yield { type: "text_delta", text: "assembled" }; yield { type: "complete", stopReason: "end_turn" }; } };
    const environment = { provider: new ReliableProvider(transport), providerName: "fixture", model: "fixture-model", config: { providers: { fixture: { base_url: "http://fixture.invalid/v1", api_type: "openai_completions" as const, auth: { type: "none" as const }, models: ["fixture-model", "fast-model"] } }, roles: { default: "fixture/fixture-model", fast: "fixture/fast-model" } } };
    const runtime = await LyraRuntime.create({ origin: root, session: "runtime-test", environment, home: join(root, "home") });
    try {
      expect((await runtime.prompt("prove assembly")).assistant.content).toEqual([{ type: "text", text: "assembled" }]);
      expect(runtime.session.entries().filter((entry) => entry.type === "message")).toHaveLength(2);
      // Isolation is the model's decision, and the default is to share: a plain child runs
      // in the parent's own directory and creates no workspace at all.
      const shared = await runtime.app.tools.execute("spawn", { task: "help here", blocking: true, model: "@fast" }, { signal: new AbortController().signal, sessionId: "runtime-test", workspace: runtime.app.cwd, callId: "spawn-shared" });
      expect(shared.isError).not.toBe(true);
      expect(JSON.parse(shared.content.toString()) as { workspace: string }).toMatchObject({ workspace: runtime.app.cwd });
      expect(await runtime.app.workspaces.list()).toHaveLength(0);
      expect(seenModels).toContain("fast-model");

      // Asking for isolation is what makes a clone, and a finished isolated child hands the
      // parent the path and the commands that integrate it.
      const spawned = await runtime.app.tools.execute("spawn", { task: "child proof", blocking: true, isolated: true }, { signal: new AbortController().signal, sessionId: "runtime-test", workspace: runtime.app.cwd, callId: "spawn-proof" });
      expect(spawned.isError).not.toBe(true);
      expect(spawned.content.toString()).toContain("assembled");
      const integration = (JSON.parse(spawned.content.toString()) as { integration: { path: string; hint: string[] } }).integration;
      expect(integration.path).toContain(join(".lyra", "workspaces"));
      expect(integration.hint[0]).toContain("git fetch");
      const scoped = await runtime.app.tools.execute("spawn", { task: "inspect outside the default apply root", blocking: true, workspace: runtime.app.cwd, tools: ["read", "glob"] }, { signal: new AbortController().signal, sessionId: "runtime-test", workspace: runtime.app.cwd, callId: "spawn-scoped" });
      expect(scoped.isError).not.toBe(true);
      expect(scoped.content.toString()).toContain("assembled");
      const childWorkspace = (await runtime.app.workspaces.list()).find((workspace) => workspace.state === "archived");
      expect(childWorkspace?.task).toBe("child proof");
      // /review is the diff surface now: what changed since a checkpoint, plus every agent
      // workspace still holding work — with the exact commands that integrate each one.
      const review = await runtime.command("/review") as { error?: string; resultKind?: string; output?: { diff?: { available?: boolean }; agents?: Array<{ name: string; integration: { hint: string[] } }> } };
      expect(review.error).toBeUndefined();
      // A declared kind, not a report: the diff has structure, so it names it.
      expect(review.resultKind).toBe("review");
      expect(review.output?.diff?.available).toBe(true);
      const agents = review.output?.agents ?? [];
      expect(agents).toHaveLength(1);
      expect(agents[0]!.integration.hint[0]).toContain("git fetch");
      expect((await runtime.session.context() as { payload: { messages: unknown[] } }).payload.messages.length).toBeGreaterThan(0);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  // The session totals live in memory and on the ACP wire, so a finished run on disk
  // could say what the agent did but not what it cost. The transcript now answers both.
  test("persists each turn's reported token usage into the transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-usage-"));
    await mkdir(join(root, ".lyra"), { recursive: true });
    await writeFile(join(root, ".lyra", "config.toml"), "[workspace]\nenabled = false\n");
    const transport: ProviderTransport = { id: "fixture", apiType: "openai_completions", async *stream() { yield { type: "text_delta", text: "counted" }; yield { type: "usage", usage: { inputTokens: 1_200, outputTokens: 340, cacheReadTokens: 900 } }; yield { type: "complete", stopReason: "end_turn" }; } };
    const environment = { provider: new ReliableProvider(transport), providerName: "fixture", model: "fixture-model", config: { providers: { fixture: { base_url: "http://fixture.invalid/v1", api_type: "openai_completions" as const, auth: { type: "none" as const }, models: ["fixture-model"] } }, roles: { default: "fixture/fixture-model" } } };
    const runtime = await LyraRuntime.create({ origin: root, session: "usage-test", environment, home: join(root, "home") });
    try {
      await runtime.prompt("count this turn");
      await runtime.prompt("and this one");
      const usage = runtime.session.entries().filter((entry) => entry.type === "usage");
      expect(usage).toHaveLength(2);
      // Raw counts only: the fixture model has no known pricing, so cost is absent rather
      // than a zero that would read as "free".
      expect(usage[0]).toMatchObject({ inputTokens: 1_200, outputTokens: 340, cacheReadTokens: 900 });
      expect(usage[0]).not.toHaveProperty("costMicroUsd");
      expect(usage[0]).not.toHaveProperty("cacheWriteTokens");
      // The recorded turn is still a plain conversation as far as the model is concerned.
      expect((await runtime.session.context() as { payload: { messages: unknown[] } }).payload.messages).toHaveLength(4);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  // Opening the workspace manager probes Git. With workspaces disabled nothing needs a
  // clone, so a plain directory has to boot and run; the Git requirement belongs to the
  // operation that actually wants isolation, where the error names something to fix.
  test("runs in a plain directory, still checkpoints, and defers the Git demand to isolation", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-plain-"));
    await mkdir(join(root, ".lyra"), { recursive: true });
    // The retired flag is accepted and reported, never fatal: the benchmark harness writes
    // it, and a config that refused to parse would break every such caller to make a point.
    await writeFile(join(root, ".lyra", "config.toml"), "[workspace]\nenabled = false\n[git]\nmode = 'observe'\n");
    const transport: ProviderTransport = { id: "fixture", apiType: "openai_completions", async *stream() { yield { type: "text_delta", text: "ran without git" }; yield { type: "complete", stopReason: "end_turn" }; } };
    const environment = { provider: new ReliableProvider(transport), providerName: "fixture", model: "fixture-model", config: { providers: { fixture: { base_url: "http://fixture.invalid/v1", api_type: "openai_completions" as const, auth: { type: "none" as const }, models: ["fixture-model"] } }, roles: { default: "fixture/fixture-model" } } };
    const reports: string[] = [];
    const runtime = await LyraRuntime.create({ origin: root, session: "plain-dir", environment, home: join(root, "home"), onReport: (message) => { reports.push(message); } });
    try {
      expect(runtime.app.cwd).toBe(runtime.app.origin);
      expect(runtime.app.config.deprecations).toHaveLength(2);
      expect(reports.some((message) => message.includes("workspace.enabled no longer does anything"))).toBe(true);
      expect(reports.some((message) => message.includes("git.mode no longer does anything"))).toBe(true);
      expect((await runtime.prompt("prove it boots")).assistant.content).toEqual([{ type: "text", text: "ran without git" }]);
      expect((await runtime.command("/health")).error).toBeUndefined();
      // Checkpoints do not need the surrounding directory to be a repository at all: the
      // shadow repository is its own, which is why a plain directory is still undoable.
      const checkpoints = await runtime.app.checkpoints.list();
      expect(checkpoints.length).toBeGreaterThan(0);
      expect(await Bun.file(join(root, ".git", "HEAD")).exists()).toBe(false);
      const isolated = await runtime.app.tools.execute("spawn", { task: "needs its own clone", blocking: true, isolated: true }, { signal: new AbortController().signal, sessionId: "plain-dir", workspace: runtime.app.cwd, callId: "spawn-isolated" });
      expect(isolated.isError).toBe(true);
      expect(isolated.content.toString()).toContain("not a Git working repository");
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
