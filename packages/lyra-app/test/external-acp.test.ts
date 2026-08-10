import { IrcBus } from "@lyra/core";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExternalAcpAgent } from "../src/external-acp.ts";

const SERVER = `let buffer = ""; for await (const chunk of Bun.stdin.stream()) { buffer += new TextDecoder().decode(chunk); let index = buffer.indexOf("\\n"); while (index >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); const message = JSON.parse(line); if (message.id !== undefined) { let result = {}; if (message.method === "initialize") result = { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fixture", version: "1" } }; else if (message.method === "session/new") result = { sessionId: "external-child" }; else if (message.method === "session/prompt") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "external-child", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "external answer" } } } }) + "\\n"); result = { stopReason: "end_turn" }; } process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n"); } index = buffer.indexOf("\\n"); } }`;
test("external ACP agents negotiate and stream output over the IRC bus", async () => {
  const root = await mkdtemp(join(tmpdir(), "lyra-external-acp-"));
  const script = join(root, "agent.ts");
  await writeFile(script, SERVER);
  const bus = new IrcBus();
  try {
    bus.register("parent");
    bus.register("external-child-peer");
    const signal = new AbortController().signal;
    const result = await runExternalAcpAgent(`${process.execPath} ${script}`, { task: "answer externally", workspace: root }, { id: "spawn-1", peer: "external-child-peer", signal, depth: 1, workspace: root, tools: ["read"], report() {}, activity() {} }, bus, "parent") as { acp: string; sessionId: string; stopReason: string; content: string };
    expect(result).toMatchObject({ acp: "fixture", sessionId: "external-child", stopReason: "end_turn" });
    expect(result.content).toBe("external answer");
    expect((await bus.inbox("parent")).length).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
