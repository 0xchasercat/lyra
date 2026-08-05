import { ReliableProvider, type ProviderTransport } from "@lyra/provider";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LyraApplication, LyraRuntime, MetricsStore, SlashCommandRouter, durationMs, loadConfig, SLASH_COMMANDS } from "../src/index.ts";
import type { SessionServices, SlashServices } from "../src/index.ts";

async function git(cwd: string, args: string[]): Promise<void> { const child = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "Lyra", GIT_AUTHOR_EMAIL: "lyra@test", GIT_COMMITTER_NAME: "Lyra", GIT_COMMITTER_EMAIL: "lyra@test" }, stdout: "ignore", stderr: "pipe" }); const error = new Response(child.stderr).text(); if (await child.exited !== 0) throw new Error(await error); }
function sessionServices(): SessionServices { const value = async () => null; return { copy: value, dump: value, settings: value, provider: value, model: value, loop: value, context: value, compact: value, sessions: value, acp: { "session/new": value, "session/load": value, "session/prompt": value, "session/update": value, "session/cancel": value, "session/fork": value, "context/inspect": value } }; }

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
    const services: SlashServices = { copy: () => hit("copy"), dump: () => hit("dump"), settings: () => hit("settings"), provider: () => hit("provider"), model: () => hit("model"), loop: (spec) => hit(`loop:${spec}`), context: () => hit("context"), compact: (clear) => hit(clear ? "clear" : "compact"), agents: (op) => hit(`agents:${op}`), workspaces: (op) => hit(`workspaces:${op}`), git: (op, value) => hit(`git:${op}:${value ?? ""}`), skills: () => hit("skills"), mcp: () => hit("mcp"), install: (tool) => hit(`install:${tool}`), sessions: (op) => hit(`sessions:${op}`), health: () => hit("health") };
    const router = new SlashCommandRouter(services);
    expect((await router.execute('/loop until "tests pass"')).output).toBe("loop:until tests pass");
    expect((await router.execute("/gitmode auto")).output).toBe("git:mode:auto");
    expect((await router.execute("/todo")).error).toContain("Unknown command");
    expect(new Set<string>(SLASH_COMMANDS).has("todo")).toBe(false);
    expect(calls).toEqual(["loop:until tests pass", "git:mode:auto"]);
  });

  test("boots zero-config infrastructure with all thirteen stable tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-app-"));
    try {
      await git(root, ["init", "-q", "-b", "main"]); await writeFile(join(root, ".gitignore"), ".lyra/\n"); await writeFile(join(root, "file.txt"), "base\n"); await git(root, ["add", "."]); await git(root, ["commit", "-q", "-m", "base"]);
      const app = await LyraApplication.boot({ origin: root, session: "main-agent", spawnExecutor: async (request) => `done:${request.task}`, sessions: sessionServices(), home: join(root, "home") });
      try {
        expect(app.tools.definitions().map((definition) => definition.name)).toEqual(["read", "write", "edit", "bash", "grep", "glob", "lsp", "spawn", "hub", "skill", "jit", "mcp", "git"]);
        expect(app.workspace.path).toContain(join(".lyra", "workspaces", "main-agent"));
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
      const spawned = await runtime.app.tools.execute("spawn", { task: "child proof", blocking: true, model: "@fast" }, { signal: new AbortController().signal, sessionId: "runtime-test", workspace: runtime.app.workspace.path, callId: "spawn-proof" });
      expect(spawned.isError).not.toBe(true);
      expect(spawned.content.toString()).toContain("assembled");
      expect(seenModels).toContain("fast-model");
      const scoped = await runtime.app.tools.execute("spawn", { task: "inspect outside the default apply root", blocking: true, workspace: runtime.app.workspace.path, tools: ["read", "glob"] }, { signal: new AbortController().signal, sessionId: "runtime-test", workspace: runtime.app.workspace.path, callId: "spawn-scoped" });
      expect(scoped.isError).not.toBe(true);
      expect(scoped.content.toString()).toContain("assembled");
      const childWorkspace = (await runtime.app.workspaces.list()).find((workspace) => workspace.name !== runtime.app.workspace.name && workspace.state === "archived");
      expect(childWorkspace?.task).toBe("child proof");
      const review = await runtime.command("/review") as { error?: string; output?: { path?: string; workspaces?: unknown[] } };
      expect(review.error).toBeUndefined();
      expect(review.output?.path).toContain(join(".lyra", "previews"));
      expect(review.output?.workspaces).toHaveLength(1);
      expect((await runtime.session.context() as { payload: { messages: unknown[] } }).payload.messages.length).toBeGreaterThan(0);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
