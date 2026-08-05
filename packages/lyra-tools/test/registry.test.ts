import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileArtifactStore } from "../src/artifacts.ts";
import { createDefaultToolRegistry } from "../src/registry.ts";
import { ToolRegistry, type LyraTool, type ToolRuntimeContext } from "../src/types.ts";

const TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "glob", "git"] as const;

function context(root: string): ToolRuntimeContext {
  return {
    signal: new AbortController().signal,
    sessionId: "registry-fuzz",
    workspace: root,
    callId: "fuzz-call",
    cwd: root,
    origin: root,
    artifactStore: new FileArtifactStore(join(root, ".lyra", "artifacts")),
  };
}

function tool(name: string, execute: LyraTool["execute"] = async () => ({ content: "ok" })): LyraTool {
  return {
    definition: { name, description: `Run the ${name} test tool.`, inputSchema: { type: "object", additionalProperties: false } },
    execute,
  };
}

describe("ToolRegistry adversarial contract", () => {
  test("keeps canonical order and immutable definitions", () => {
    const registry = createDefaultToolRegistry();
    expect(registry.definitions().map((definition) => definition.name)).toEqual([...TOOL_NAMES]);
    expect(Object.isFrozen(registry.definitions())).toBe(true);
    expect(Object.isFrozen(registry.definitions()[0])).toBe(true);
    expect(Object.isFrozen(registry.definitions()[0].inputSchema)).toBe(true);
    expect(() => (registry.definitions() as unknown as unknown[]).push({})).toThrow();
    expect(() => ((registry.definitions()[0].inputSchema as Record<string, unknown>).type = "array")).toThrow();
    expect(registry.definitions().map((definition) => definition.name)).toEqual([...TOOL_NAMES]);
  });

  test("never throws for deterministic malformed arguments across every built-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-registry-fuzz-"));
    try {
      const registry = createDefaultToolRegistry({ filesystem: { root } });
      const executionContext = context(root);
      const malformed: unknown[] = [undefined, null, true, 0, "arguments", [], { unknown: "property" }, { path: 17 }, { path: "x", unknown: true }];
      for (const name of TOOL_NAMES) for (const input of malformed) {
        const result = await registry.execute(name, input, executionContext);
        expect(result.isError).toBe(true);
        expect(typeof result.content === "string" || Array.isArray(result.content)).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports alternatives and catches tool failures", async () => {
    const registry = createDefaultToolRegistry();
    const result = await registry.execute("missing", {}, context(process.cwd()));
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("Use one of: read, write, edit, bash, grep, glob, git.");
    const throwing = new ToolRegistry([tool("explode", async () => { throw new Error("boom"); })]);
    const failure = await throwing.execute("explode", {}, context(process.cwd()));
    expect(failure.isError).toBe(true);
    expect(String(failure.content)).toContain("boom");
    expect(String(failure.content)).toContain("Retry");
  });

  test("preserves partial metadata and artifact references on failure", async () => {
    const partial = new ToolRegistry([tool("partial", async () => {
      throw { result: { content: "served [truncated: 3 of 9 bytes — artifact://abc]", metadata: { artifactUri: "artifact://abc", servedBytes: 3, totalBytes: 9 } } };
    })]);
    const result = await partial.execute("partial", {}, context(process.cwd()));
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("artifact://abc");
    expect(result.metadata).toEqual({ artifactUri: "artifact://abc", servedBytes: 3, totalBytes: 9 });
  });

  test("rejects duplicate and malformed definitions before first use", () => {
    expect(() => new ToolRegistry([tool("same"), tool("same")])).toThrow(/Duplicate Lyra tool/);
    expect(() => new ToolRegistry([{ definition: { name: "bad", description: "Bad schema.", inputSchema: { type: "invalid" } }, execute: async () => ({ content: "never" }) }])).toThrow(/inputSchema\.type/);
    expect(() => new ToolRegistry([{ definition: { name: "bad", description: "Bad schema.", inputSchema: { type: "object", required: ["x", "x"] } }, execute: async () => ({ content: "never" }) }])).toThrow(/required/);
  });
});
