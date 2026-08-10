import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpGateway, McpRegistry, McpStdioClient, DracoInstaller } from "../src/index.ts";
const SERVER = `let buffer = ""; for await (const chunk of Bun.stdin.stream()) { buffer += new TextDecoder().decode(chunk); let index = buffer.indexOf("\\n"); while (index >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); const message = JSON.parse(line); if (message.id === undefined) { index = buffer.indexOf("\\n"); continue; } let result; if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }; else if (message.method === "tools/list") result = { tools: [{ name: "echo", description: "Echo values", inputSchema: { type: "object" } }] }; else if (message.method === "tools/call") result = { content: [{ type: "text", text: message.params.arguments.large ? "x".repeat(200000) : JSON.stringify(message.params.arguments) }] }; else if (message.method === "slow") { index = buffer.indexOf("\\n"); continue; } else result = {}; process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n"); index = buffer.indexOf("\\n"); } }`;
// Opens with a server→client request that reuses id 1 — the id the client itself uses for initialize —
// and echoes whatever the client answered back through tools/call.
const SAMPLING_SERVER = `let buffer = ""; let answer = null; process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sampling/createMessage", params: {} }) + "\\n"); for await (const chunk of Bun.stdin.stream()) { buffer += new TextDecoder().decode(chunk); let index = buffer.indexOf("\\n"); while (index >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); index = buffer.indexOf("\\n"); const message = JSON.parse(line); if (message.method === undefined) { answer = message; continue; } if (message.id === undefined) continue; const result = message.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "sampler", version: "1" } } : { content: [{ type: "text", text: JSON.stringify(answer) }] }; process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n"); } }`;

/** A real, complete 1×1 PNG, as an MCP image part would carry it. */
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const IMAGE_SERVER = `let buffer = ""; for await (const chunk of Bun.stdin.stream()) { buffer += new TextDecoder().decode(chunk); let index = buffer.indexOf("\\n"); while (index >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); index = buffer.indexOf("\\n"); const message = JSON.parse(line); if (message.id === undefined) continue; let result; if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "shots", version: "1" } }; else if (message.method === "tools/list") result = { tools: [{ name: "screenshot", description: "Take a screenshot", inputSchema: { type: "object" } }] }; else if (message.method === "tools/call") result = { content: [{ type: "text", text: "captured" }, { type: "image", data: "${ONE_PIXEL_PNG}", mimeType: "image/png" }] }; else result = {}; process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n"); } }`;

function context() { return { signal: new AbortController().signal, sessionId: "mcp", workspace: ".", callId: "mcp-call" }; }
async function fixture(source: string): Promise<{ root: string; script: string }> {
  const root = await mkdtemp(join(tmpdir(), "lyra-mcp-"));
  const script = join(root, "server.ts");
  await writeFile(script, source);
  return { root, script };
}

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
    let artifact = "";
    const gateway = new McpGateway(registry, { put: async (content) => { artifact = content.toString(); return "artifact://durable"; } });
    try {
      const described = await gateway.execute({ op: "describe", server: "fake", tool: "echo" }, context());
      expect(described.isError).not.toBe(true);
      const called = await gateway.execute({ op: "call", server: "fake", tool: "echo", args: { value: 3 } }, context());
      expect(called.content.toString()).toContain("value");
      const large = await gateway.execute({ op: "call", server: "fake", tool: "echo", args: { large: true } }, context());
      expect(large.content.toString()).toContain("artifact://durable");
      expect(artifact.length).toBeGreaterThan(128 * 1024);
      const client = await registry.client("fake");
      await expect(client.request("slow")).rejects.toMatchObject({ code: "timeout" });
      // A fired deadline is one request's answer, not the end of the server for everyone else.
      expect(client.closed).toBe(false);
      expect((await gateway.execute({ op: "call", server: "fake", tool: "echo", args: { value: 4 } }, context())).content.toString()).toContain("value");
      await expect(gateway.execute({ op: "describe", server: "fake", tool: "missing" }, context())).resolves.toMatchObject({ isError: true });
    } finally { await registry.close(); await rm(root, { recursive: true, force: true }); }
  });

  /**
   * A screenshot has to leave the gateway as *an image*. Serialized into the result JSON it
   * is a wall of base64 no model can see, and spilling that JSON wholesale stores it as
   * `application/json` — so reading the artifact back gives text, and the picture is lost
   * between an MCP server and a vision model that could have read it.
   */
  test("gateway stores an MCP image part as an image artifact rather than as JSON", async () => {
    const { root, script } = await fixture(IMAGE_SERVER);
    const registry = new McpRegistry(root, { timeoutMs: 1_000 });
    await registry.set("shots", { command: process.execPath, args: [script], cwd: root });
    const stored: Array<{ mimeType?: string; bytes: number }> = [];
    const gateway = new McpGateway(registry, {
      put: async (content, options) => { stored.push({ mimeType: options?.mimeType, bytes: content.length }); return "artifact://png"; },
    });
    try {
      const called = await gateway.execute({ op: "call", server: "shots", tool: "screenshot", args: {} }, context());
      expect(called.isError).not.toBe(true);
      expect(stored).toEqual([{ mimeType: "image/png", bytes: 70 }]);
      const body = called.content.toString();
      expect(body).toContain("artifact://png");
      expect(body).toContain("captured");
      // The base64 is gone from the transcript; the artifact holds the exact bytes.
      expect(body).not.toContain(ONE_PIXEL_PNG);
    } finally { await registry.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("cancelling one call leaves concurrent calls and the shared server alive", async () => {
    const { root, script } = await fixture(SERVER);
    const client = new McpStdioClient({ name: "fake", command: process.execPath, args: [script], cwd: root, timeoutMs: 200 });
    try {
      await client.initialize();
      const controller = new AbortController();
      const timing = client.request("slow");
      const cancelled = client.request("slow", {}, controller.signal);
      const concurrent = client.callTool("echo", { value: "alive" });
      controller.abort(new Error("caller cancelled"));
      await expect(cancelled).rejects.toThrow("caller cancelled");
      expect(await concurrent).toMatchObject({ content: [{ type: "text" }] });
      await expect(timing).rejects.toMatchObject({ code: "timeout" });
      expect(client.closed).toBe(false);
      expect(await client.callTool("echo", { value: "after" })).toMatchObject({ content: [{ type: "text" }] });
    } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("honors a configured timeout above the 60s default", async () => {
    const { root, script } = await fixture(SERVER);
    const client = new McpStdioClient({ name: "fake", command: process.execPath, args: [script], cwd: root, timeoutMs: 300_000 });
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...rest: unknown[]) => { delays.push(delay ?? 0); return real(handler, delay, ...rest); }) as unknown as typeof globalThis.setTimeout;
    let pending: Promise<unknown>;
    try { pending = client.request("slow"); } finally { globalThis.setTimeout = real; }
    void pending.catch(() => undefined);
    try {
      expect(delays).toContain(300_000);
      expect(delays).not.toContain(60_000);
    } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
    await expect(pending).rejects.toMatchObject({ code: "closed" });
  });

  test("answers unsupported server→client requests so the server fails fast", async () => {
    const { root, script } = await fixture(SAMPLING_SERVER);
    const client = new McpStdioClient({ name: "sampler", command: process.execPath, args: [script], cwd: root, timeoutMs: 2000 });
    try {
      expect(await client.initialize()).toMatchObject({ serverInfo: { name: "sampler" } });
      const echoed = await client.callTool("echo", {});
      const [first] = echoed.content as Array<{ text: string }>;
      expect(JSON.parse(first!.text)).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32601 } });
    } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("Draco offers once, validates fetched installer, runs it, and registers draco mcp", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-draco-"));
    const registry = new McpRegistry(root);
    const script = "#!/bin/sh\n# draco installer\n" + "echo draco\n".repeat(30);
    const installer = new DracoInstaller({ origin: root, installUrl: "https://installer.invalid/draco.sh", expectedSha256: createHash("sha256").update(script).digest("hex"), fetch: async () => new Response(script), run: async () => ({ exitCode: 0, stdout: "installed", stderr: "" }) });
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
