import { IrcBus, SpawnManager } from "@lyra/core";
import { McpGateway, McpRegistry } from "@lyra/mcp";
import { SkillRegistry, SkillTool } from "@lyra/skills";
import { ToolRegistry } from "@lyra/tools";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubTool, SpawnTool, normalizeLspArgs } from "../src/integrated-tools.ts";

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

  /**
   * The reverse of the rule this suite used to assert, and for the same reason the seven
   * filesystem tools flipped: declaring `prompt` beside `task` legitimized the model's own
   * spelling, but a schema-complete emitter fills every declared property, so it learned to
   * send both. The advertised schema is canonical-only; the aliases are still accepted.
   */
  test("no alias is advertised in the schema the model is shown", async () => {
    const manager = new SpawnManager({ defaultWorkspace: "/tmp", executor: async () => ({}) });
    const registry = new ToolRegistry([new SpawnTool(manager), new HubTool(new IrcBus(), "root")]);
    try {
      const declared = new Map(registry.definitions().map((definition) => [definition.name, Object.keys((definition.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})]));
      expect(declared.get("spawn")).toEqual(["task", "context", "output_schema", "schema_mode", "model", "tools", "isolated", "workspace", "writeScope", "blocking", "label", "depth", "acp", "id", "op", "timeoutMs"]);
      // The system prompt shows the first 180 characters of a description, so the loop's
      // four verbs have to stand on their own inside that budget.
      const spawnDescription = registry.definitions().find((definition) => definition.name === "spawn")!.description;
      for (const verb of ["spawn { task }", "spawn { id }", 'op: "status"', 'op: "cancel"']) expect(spawnDescription.slice(0, 180)).toContain(verb);
      expect(declared.get("hub")).toEqual(["op", "to", "peer", "channel", "message", "data", "timeoutMs", "await"]);
      const aliases = ["prompt", "instruction", "description", "outputSchema", "schemaMode", "write_scope", "scope", "spawnId", "spawn_id", "agentId", "agent_id", "handle", "run_in_background", "text", "msg", "body", "timeout", "timeout_ms", "agent", "recipient", "topic", "from", "subagent_type"];
      for (const [tool, fields] of declared) for (const field of fields) {
        expect({ tool, field, advertised: aliases.includes(field) }).toEqual({ tool, field, advertised: false });
      }
    } finally { await manager.close?.(); }
  });

  /** The aliases left the schema; they did not leave the tools. */
  test("every alias still lands at runtime", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const manager = new SpawnManager({ defaultWorkspace: "/tmp", executor: async (request) => { seen.push(request as unknown as Record<string, unknown>); return "ok"; } });
    const registry = new ToolRegistry([new SpawnTool(manager)]);
    try {
      const started = await registry.execute("spawn", { instruction: "audit the parser", name: "auditor", write_scope: ["src/parser/**"] }, context("/tmp"));
      expect(started.isError).not.toBe(true);
      const handle = JSON.parse(text(started)) as { id: string; peer: string };
      expect(handle.peer).toBe("auditor");
      // The alias spellings for an existing child address the same one the canonical does.
      const byAlias = await registry.execute("spawn", { agentId: "auditor", op: "status" }, context("/tmp"));
      expect(byAlias.isError).not.toBe(true);
      expect(JSON.parse(text(byAlias))).toMatchObject({ id: handle.id, peer: "auditor", writeScope: ["src/parser/**"] });
    } finally { await manager.close?.(); }
  });

  /** Naming neither a task nor a child is the one call that cannot mean anything. */
  test("spawn says which of its two jobs a bare call was trying to do", async () => {
    const manager = new SpawnManager({ defaultWorkspace: "/tmp", executor: async () => "ok" });
    const registry = new ToolRegistry([new SpawnTool(manager)]);
    try {
      const bare = await registry.execute("spawn", {}, context("/tmp"));
      expect(bare.isError).toBe(true);
      expect(text(bare)).toContain("task");
      expect(text(bare)).toContain("id");
      const both = await registry.execute("spawn", { task: "x", id: "spawn-1" }, context("/tmp"));
      expect(both.isError).toBe(true);
      expect(text(both)).toContain("different things");
    } finally { await manager.close?.(); }
  });

  /** Spoofing a sender produced the unactionable `Unknown sender peer: root`. */
  test("hub says where an undelivered message went", async () => {
    const bus = new IrcBus();
    bus.register("root");
    const registry = new ToolRegistry([new HubTool(bus, "root")]);
    const result = await registry.execute("hub", { op: "send", to: "ghost", message: "hi" }, context("/tmp"));
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("went nowhere");
    expect(text(result)).toContain("root");
  });

  test("hub refuses from and names how peers come to exist", async () => {
    const bus = new IrcBus();
    bus.register("root");
    const registry = new ToolRegistry([new HubTool(bus, "root")]);
    const spoof = await registry.execute("hub", { op: "send", to: "root", message: "hi", from: "somebody-else" }, context("/tmp"));
    expect(spoof.isError).toBe(true);
    expect(text(spoof)).toContain("sent as this agent");

    const missing = await registry.execute("hub", { op: "send", to: "ghost", message: "hi" }, context("/tmp"));
    expect(text(missing)).toContain("delivered");
    const badPeer = await registry.execute("hub", { op: "subscribe", peer: "ghost", channel: "agents" }, context("/tmp"));
    expect(badPeer.isError).toBe(true);
    expect(text(badPeer)).toContain("spawn result");
  });

  /** `lsp` is routinely first-called with the params flattened. */
  test("lsp folds a flattened uri, line, and character into params", () => {
    const folded = normalizeLspArgs({ op: "definition", uri: "file:///a/b.ts", line: 3, character: 7 }) as Record<string, unknown>;
    expect(folded.params).toEqual({ textDocument: { uri: "file:///a/b.ts" }, position: { line: 3, character: 7 } });
    expect(folded.uri).toBeUndefined();
  });
});
