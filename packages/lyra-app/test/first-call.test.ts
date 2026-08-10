import { IrcBus, SpawnManager } from "@lyra/core";
import { McpGateway, McpRegistry } from "@lyra/mcp";
import { SkillRegistry, SkillTool } from "@lyra/skills";
import { ToolRegistry } from "@lyra/tools";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubTool, SpawnTool } from "../src/integrated-tools.ts";

/**
 * The delegation, bus, skill, and MCP tools get the same §3.7 treatment as the filesystem
 * ones: a first call spelled the way Claude Code trains a model must land or teach.
 */

function context(root: string): any {
  return { signal: new AbortController().signal, sessionId: "first-call", workspace: root, callId: "call-1", cwd: root, origin: root };
}

function text(result: { content: unknown }): string { return String(result.content); }

describe("first-call ergonomics for delegation and integration tools", () => {
  test("spawn accepts prompt, description, and run_in_background", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const manager = new SpawnManager({ defaultWorkspace: "/tmp", executor: async (request) => { seen.push(request as unknown as Record<string, unknown>); return { done: request.task }; } });
    const registry = new ToolRegistry([new SpawnTool(manager)]);
    try {
      const result = await registry.execute("spawn", { prompt: "Summarise the diff", description: "diff summary", run_in_background: false }, context("/tmp"));
      expect(result.isError).not.toBe(true);
      // run_in_background: false is blocking: true, so the child has already run.
      expect(seen[0]?.task).toBe("Summarise the diff");
      expect(seen[0]?.label).toBe("diff summary");
      expect(text(result)).toContain("Summarise the diff");
    } finally { await manager.close?.(); }
  });

  test("spawn drops schema-complete padding rather than letting it flip its mode", async () => {
    // The observed emitter fills every declared property (bash got job:"?", write got
    // tag:"#000000"). Padded acp would reroute to a nonexistent harness and a padded
    // output_schema would silently make the child a typed workflow — both must vanish.
    const seen: Array<Record<string, unknown>> = [];
    const manager = new SpawnManager({ defaultWorkspace: "/tmp", executor: async (request) => { seen.push(request as unknown as Record<string, unknown>); return { done: request.task }; } });
    const registry = new ToolRegistry([new SpawnTool(manager)]);
    try {
      const result = await registry.execute("spawn", {
        task: "Build the card component", prompt: "Build the card component",
        context: "", model: null, workspace: "", label: "  ",
        acp: "", schema_mode: "", output_schema: {},
        isolated: null, blocking: null, depth: null, tools: null,
        run_in_background: false,
      }, context("/tmp"));
      expect(result.isError).not.toBe(true);
      const request = seen[0]!;
      expect(request.task).toBe("Build the card component");
      // workspace/isolated/depth are absent from the loop: the manager resolves the
      // padded-away values to its own defaults downstream — correct, not padding.
      for (const field of ["context", "model", "label", "acp", "schema_mode", "output_schema"]) {
        expect(request[field]).toBeUndefined();
      }
    } finally { await manager.close?.(); }
  });

  test("spawn teaches that there is no subagent_type", async () => {
    const manager = new SpawnManager({ defaultWorkspace: "/tmp", executor: async () => ({}) });
    const registry = new ToolRegistry([new SpawnTool(manager)]);
    try {
      const result = await registry.execute("spawn", { prompt: "Review this", subagent_type: "code-reviewer" }, context("/tmp"));
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("subagent_type is not supported");
      expect(text(result)).toContain("output_schema");
    } finally { await manager.close?.(); }
  });

  test("spawn refuses blocking and run_in_background that disagree", async () => {
    const manager = new SpawnManager({ defaultWorkspace: "/tmp", executor: async () => ({}) });
    const registry = new ToolRegistry([new SpawnTool(manager)]);
    try {
      const result = await registry.execute("spawn", { task: "x", blocking: true, run_in_background: true }, context("/tmp"));
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("blocking");
      expect(text(result)).toContain("run_in_background");
    } finally { await manager.close?.(); }
  });

  test("hub accepts text and timeout", async () => {
    const bus = new IrcBus();
    bus.register("root");
    bus.register("child");
    const registry = new ToolRegistry([new HubTool(bus, "root")]);
    const sent = await registry.execute("hub", { op: "send", to: "child", text: "status?" }, context("/tmp"));
    expect(sent.isError).not.toBe(true);
    const inbox = await registry.execute("hub", { op: "inbox", peer: "child" }, context("/tmp"));
    expect(text(inbox)).toContain("status?");
    const waited = await registry.execute("hub", { op: "wait", peer: "nobody", timeout: 1 }, context("/tmp"));
    expect(waited.isError).not.toBe(true);
  });

  test("skill accepts Claude Code's skill field and refuses args", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-first-call-skill-"));
    try {
      const directory = join(root, ".lyra", "skills", "adversarial-review");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "SKILL.md"), "---\nname: adversarial-review\ndescription: One implementer, two reviewers.\n---\n\nSplit the context windows.\n");
      const registry = new ToolRegistry([new SkillTool(new SkillRegistry({ workspace: root, home: root, bundledRoot: join(root, "missing") })) as never]);

      const loaded = await registry.execute("skill", { skill: "adversarial-review" }, context(root));
      expect(loaded.isError).not.toBe(true);
      expect(text(loaded)).toContain("Split the context windows.");

      const parameterised = await registry.execute("skill", { skill: "adversarial-review", args: "--fast" }, context(root));
      expect(parameterised.isError).toBe(true);
      expect(text(parameterised)).toContain("instructions, not a command");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("mcp accepts the wire spelling `arguments`", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-first-call-mcp-"));
    try {
      const gateway = new McpGateway(new McpRegistry(root));
      const registry = new ToolRegistry([gateway as never]);
      const result = await registry.execute("mcp", { op: "call", server: "linear", tool: "create_issue", arguments: { title: "x" } }, context(root));
      // No such server here, but the arguments themselves must get past validation.
      expect(result.isError).toBe(true);
      expect(text(result)).not.toContain("is not recognized");
      expect(text(result)).toContain("linear");
      await gateway.close?.();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("every declared alias is visible in the schema the model is shown", async () => {
    const manager = new SpawnManager({ defaultWorkspace: "/tmp", executor: async () => ({}) });
    const registry = new ToolRegistry([new SpawnTool(manager), new HubTool(new IrcBus(), "root")]);
    try {
      const declared = new Map(registry.definitions().map((definition) => [definition.name, Object.keys((definition.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})]));
      for (const field of ["prompt", "description", "outputSchema", "schemaMode", "run_in_background"]) expect(declared.get("spawn")).toContain(field);
      for (const field of ["text", "timeout"]) expect(declared.get("hub")).toContain(field);
    } finally { await manager.close?.(); }
  });
});
