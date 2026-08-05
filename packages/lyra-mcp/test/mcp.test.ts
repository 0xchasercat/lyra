import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpGateway, McpRegistry, McpStdioClient, DracoInstaller } from "../src/index.ts";

const SERVER = `let buffer = ""; for await (const chunk of Bun.stdin.stream()) { buffer += new TextDecoder().decode(chunk); let index = buffer.indexOf("\\n"); while (index >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); const message = JSON.parse(line); if (message.id === undefined) { index = buffer.indexOf("\\n"); continue; } let result; if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }; else if (message.method === "tools/list") result = { tools: [{ name: "echo", description: "Echo values", inputSchema: { type: "object" } }] }; else if (message.method === "tools/call") result = { content: [{ type: "text", text: JSON.stringify(message.params.arguments) }] }; else if (message.method === "slow") { index = buffer.indexOf("\\n"); continue; } else result = {}; process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n"); index = buffer.indexOf("\\n"); } }`;

function context() { return { signal: new AbortController().signal, sessionId: "mcp", workspace: ".", callId: "mcp-call" }; }

describe("MCP client and Draco installer", () => {
  test("speaks newline JSON-RPC, indexes tools, describes and calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-mcp-"));
    const script = join(root, "server.ts");
    await writeFile(script, SERVER);
    const client = new McpStdioClient({ name: "fake", command: process.execPath, args: [script], cwd: root, timeoutMs: 500 });
    try {
      const initialized = await client.initialize();
      expect(initialized).toMatchObject({ serverInfo: { name: "fake" } });
      expect(await client.listTools()).toMatchObject({ tools: [{ name: "echo", description: "Echo values" }] });
      expect(await client.callTool("echo", { value: "ok" })).toMatchObject({ content: [{ type: "text" }] });
    } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("gateway exposes one stable describe/call surface and deadline errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-mcp-"));
    const script = join(root, "server.ts");
    await writeFile(script, SERVER);
    const registry = new McpRegistry(root, { timeoutMs: 500 });
    await registry.set("fake", { command: process.execPath, args: [script], cwd: root });
    const gateway = new McpGateway(registry);
    try {
      const described = await gateway.execute({ op: "describe", server: "fake", tool: "echo" }, context());
      expect(described.isError).not.toBe(true);
      const called = await gateway.execute({ op: "call", server: "fake", tool: "echo", args: { value: 3 } }, context());
      expect(called.content.toString()).toContain("value");
      const client = await registry.client("fake");
      await expect(client.request("slow")).rejects.toMatchObject({ code: "timeout" });
      await expect(gateway.execute({ op: "describe", server: "fake", tool: "missing" }, context())).resolves.toMatchObject({ isError: true });
    } finally { await registry.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("Draco offers once, validates fetched installer, runs it, and registers draco mcp", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-draco-"));
    const registry = new McpRegistry(root);
    const installer = new DracoInstaller({ origin: root, fetch: async () => new Response("#!/bin/sh\n# draco installer\n" + "echo draco\\n".repeat(30)), run: async () => ({ exitCode: 0, stdout: "installed", stderr: "" }) });
    try {
      expect(await installer.shouldOffer()).toBe(true);
      const result = await installer.install(registry);
      expect(result.registered).toBe("draco");
      expect(await installer.shouldOffer()).toBe(false);
      expect(await registry.names()).toEqual(["draco"]);
      await installer.recordOffer("skip");
      expect(await installer.shouldOffer()).toBe(false);
    } finally { await registry.close(); await rm(root, { recursive: true, force: true }); }
  });
});
