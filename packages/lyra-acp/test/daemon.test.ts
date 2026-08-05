import { describe, expect, test } from "bun:test";
import { ACP_METHODS, AcpDaemon } from "../src/index.ts";
import type { AcpHandlers } from "../src/index.ts";

class Writer {
  readonly lines: string[] = [];
  write(data: string | Uint8Array): void { this.lines.push(typeof data === "string" ? data : new TextDecoder().decode(data)); }
  messages(): Array<Record<string, unknown>> { return this.lines.flatMap((line) => line.trim().split("\n").filter(Boolean).map((part) => JSON.parse(part) as Record<string, unknown>)); }
}
async function settle(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 5)); }

describe("ACP stdio daemon", () => {
  test("initialize advertises the complete control plane and every method routes", async () => {
    const writer = new Writer();
    const handlers: AcpHandlers = {};
    for (const method of ACP_METHODS) handlers[method] = async (params) => ({ method, params });
    const daemon = new AcpDaemon({ handlers });
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), writer);
    await settle();
    const initialized = writer.messages()[0]!;
    expect(initialized.result).toMatchObject({ serverInfo: { name: "lyra" }, capabilities: { bidirectional: true, cancellation: true, methods: ACP_METHODS } });
    for (let index = 0; index < ACP_METHODS.length; index += 1) await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: index + 2, method: ACP_METHODS[index], params: { index } }));
    await settle();
    const routed = writer.messages().slice(1);
    expect(routed).toHaveLength(ACP_METHODS.length);
    const routedMethods = routed.map((message) => {
      const result = message.result;
      return result && typeof result === "object" && "method" in result && typeof result.method === "string" ? result.method : "invalid";
    });
    expect(routedMethods).toEqual(ACP_METHODS);
    await daemon.close();
  });

  test("recovers from malformed input, unknown methods, deadline, and client cancellation", async () => {
    const writer = new Writer();
    const handlers: AcpHandlers = {
      "session/load": async (_params, context) => { const { promise, reject } = Promise.withResolvers<never>(); context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }); return promise; },
      "session/prompt": async (_params, context) => { const { promise, reject } = Promise.withResolvers<never>(); context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }); return promise; },
    };
    const daemon = new AcpDaemon({ handlers, requestTimeoutMs: 20 });
    await daemon.handleLine("{bad", writer);
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "missing/method" }));
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/load" }));
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "session/prompt" }));
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 4 } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const messages = writer.messages();
    expect(messages.find((message) => message.id === null)?.error).toMatchObject({ code: -32700 });
    expect(messages.find((message) => message.id === 2)?.error).toMatchObject({ code: -32601 });
    expect(messages.find((message) => message.id === 3)?.error).toMatchObject({ code: -32001 });
    expect(messages.find((message) => message.id === 4)?.error).toMatchObject({ code: -32800 });
    await daemon.close();
  });

  test("preserves structured provider diagnostics without exposing raw metadata as the contract", async () => {
    const writer = new Writer();
    const fault = Object.assign(new Error("provider request failed; request_id: noisy"), { classification: "transient", code: "upstream_unavailable", status: 400 });
    const daemon = new AcpDaemon({ handlers: { "session/prompt": async () => { throw fault; } } });
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt" }), writer);
    await settle();
    expect(writer.messages().find((message) => message.id === 1)?.error).toMatchObject({
      code: -32603,
      data: { classification: "transient", code: "upstream_unavailable", status: 400 },
    });
    await daemon.close();
  });

  test("rejects oversized frames and caps concurrent state-changing requests", async () => {
    const writer = new Writer();
    const daemon = new AcpDaemon({ handlers: { "session/load": async (_params, context) => { const { promise, reject } = Promise.withResolvers<never>(); context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }); return promise; } }, maxFrameBytes: 128, maxConcurrentRequests: 1 });
    await daemon.handleLine("x".repeat(129), writer);
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/load" }));
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/load" }));
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } }));
    await settle();
    expect(writer.messages().find((message) => message.id === null)?.error).toMatchObject({ code: -32003 });
    expect(writer.messages().find((message) => message.id === 2)?.error).toMatchObject({ code: -32002 });
    await daemon.close();
  });

  test("supports bidirectional client requests and notifications", async () => {
    const writer = new Writer();
    const notifications: unknown[] = [];
    const daemon = new AcpDaemon({ handlers: { "agent/message": async (params, context) => { await context.notify("session/update", { accepted: true }); const confirmation = await context.requestClient("window/confirm", params, 1000); notifications.push(confirmation); return { confirmation }; } } });
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), writer);
    await settle();
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "agent/message", params: { text: "continue" } }));
    await settle();
    const outbound = writer.messages().find((message) => message.method === "window/confirm")!;
    expect(outbound.id).toBe("server-1");
    expect(writer.messages().some((message) => message.method === "session/update")).toBe(true);
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: outbound.id, result: { confirmed: true } }));
    await settle();
    expect(notifications).toEqual([{ confirmed: true }]);
    expect(writer.messages().find((message) => message.id === 2)?.result).toEqual({ confirmation: { confirmed: true } });
    await daemon.close();
  });
});
