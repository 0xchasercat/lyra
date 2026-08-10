import { describe, expect, test } from "bun:test";
import { ACP_DEFAULT_TURN_TIMEOUT_MS, ACP_METHODS, ACP_TURN_METHODS, AcpDaemon } from "../src/index.ts";
import type { AcpHandlers } from "../src/index.ts";

class Writer {
  readonly lines: string[] = [];
  write(data: string | Uint8Array): void { this.lines.push(typeof data === "string" ? data : new TextDecoder().decode(data)); }
  messages(): Array<Record<string, unknown>> { return this.lines.flatMap((line) => line.trim().split("\n").filter(Boolean).map((part) => JSON.parse(part) as Record<string, unknown>)); }
}
class FlakyWriter extends Writer {
  failNext = false;
  override write(data: string | Uint8Array): void { if (this.failNext) { this.failNext = false; throw new Error("stdout write failed."); } super.write(data); }
}
async function settle(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 5)); }
function recordDelays(delays: number[]): () => void {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...rest: unknown[]) => { delays.push(delay ?? 0); return real(handler, delay, ...rest); }) as unknown as typeof globalThis.setTimeout;
  return () => { globalThis.setTimeout = real; };
}

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
    // Turn-class: the 20ms deadline above is not its, so only the cancel below ends it.
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

  test("one failed write rejects that frame only and the connection keeps writing", async () => {
    const writer = new FlakyWriter();
    const daemon = new AcpDaemon({ handlers: {} });
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), writer);
    await settle();
    writer.failNext = true;
    await expect(daemon.notify("session/update", { poisoned: true })).rejects.toThrow("stdout write failed.");
    await daemon.notify("session/update", { recovered: true });
    await settle();
    expect(writer.messages().filter((message) => message.method === "session/update")).toEqual([{ jsonrpc: "2.0", method: "session/update", params: { recovered: true } }]);
    expect(writer.messages().find((message) => message.id === 1)?.result).toBeDefined();
    await daemon.close();
  });

  test("a write failure settles the pending client request instead of leaving an unobserved timer", async () => {
    const writer = new FlakyWriter();
    const daemon = new AcpDaemon({ handlers: {} });
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), writer);
    await settle();
    writer.failNext = true;
    await expect(daemon.requestClient("window/confirm", {}, 20)).rejects.toMatchObject({ code: -32000 });
    // The deadline of the failed request must not fire against nothing: nothing more is written for it.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(writer.messages().some((message) => message.method === "window/confirm")).toBe(false);
    await daemon.close();
  });

  test("honors a client request timeout above the default and bounds it explicitly", async () => {
    const writer = new Writer();
    const daemon = new AcpDaemon({ handlers: {} });
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), writer);
    await settle();
    const delays: number[] = [];
    const restore = recordDelays(delays);
    let pending: Promise<unknown>;
    try { pending = daemon.requestClient("window/confirm", {}, 300_000); } finally { restore(); }
    void pending.catch(() => undefined);
    expect(delays).toContain(300_000);
    expect(delays).not.toContain(60_000);
    await expect(daemon.requestClient("window/confirm", {}, 2_147_483_648)).rejects.toMatchObject({ code: -32600 });
    await daemon.close();
    await expect(pending).rejects.toMatchObject({ code: -32000 });
  });

  test("the method table gives a turn its own deadline and leaves every question on the generic one", async () => {
    const writer = new Writer();
    const handlers: AcpHandlers = {};
    // Every handler hangs: the deadline is the only thing that can end these requests.
    for (const method of ACP_METHODS) handlers[method] = async (_params, context) => { const { promise, reject } = Promise.withResolvers<never>(); context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }); return promise; };
    const daemon = new AcpDaemon({ handlers });
    const delays: number[] = [];
    let id = 0;
    const deadlineOf = async (method: string): Promise<number> => {
      const before = delays.length;
      const restore = recordDelays(delays);
      try { await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: (id += 1), method }), writer); } finally { restore(); }
      return delays[before]!;
    };
    for (const method of ACP_TURN_METHODS) expect(await deadlineOf(method)).toBe(ACP_DEFAULT_TURN_TIMEOUT_MS);
    expect(ACP_DEFAULT_TURN_TIMEOUT_MS).toBe(30 * 60 * 1000);
    // Cancel is issued *while* a turn runs and must answer inside it; the rest are questions.
    for (const method of ["session/cancel", "session/snapshot", "settings/get", "git/apply"]) {
      expect(await deadlineOf(method)).toBe(60_000);
    }
    await daemon.close();
  });

  test("a turn deadline that fires names itself, and turnTimeoutMs is bounded like every other deadline", async () => {
    // Inverted on purpose — a 30ms turn and a 5s question — so the *table* is what is
    // under test rather than which number happens to be larger.
    const writer = new Writer();
    const daemon = new AcpDaemon({
      handlers: { "session/prompt": async (_params, context) => { const { promise, reject } = Promise.withResolvers<never>(); context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }); return promise; } },
      requestTimeoutMs: 5_000,
      turnTimeoutMs: 30,
    });
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt" }), writer);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(writer.messages().find((message) => message.id === 1)?.error).toMatchObject({ code: -32001, message: "ACP request session/prompt exceeded 30ms." });
    await daemon.close();
    expect(() => new AcpDaemon({ handlers: {}, turnTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new AcpDaemon({ handlers: {}, turnTimeoutMs: 2_147_483_648 })).toThrow(RangeError);
  });

  test("a slow turn outlives the generic deadline, a question does not, and a cancel still lands mid-turn", async () => {
    const writer = new Writer();
    const started: string[] = [];
    const handlers: AcpHandlers = {
      // A turn that takes a second: far past the generic deadline, far inside the turn one.
      "session/prompt": async (_params, context) => {
        started.push("prompt");
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ status: "completed" }), 1_000);
          context.signal.addEventListener("abort", () => { clearTimeout(timer); reject(context.signal.reason); }, { once: true });
        });
      },
      // A question with no answer. Its own class, its own (short) deadline.
      "settings/get": async (_params, context) => { const { promise, reject } = Promise.withResolvers<never>(); context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }); return promise; },
    };
    const daemon = new AcpDaemon({ handlers, requestTimeoutMs: 200, turnTimeoutMs: 5_000 });
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { prompt: "spawn a subagent" } }), writer);
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "settings/get" }));
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { prompt: "the one that gets cancelled" } }));
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Past the generic deadline: the question is dead, both turns are alive.
    expect(writer.messages().find((message) => message.id === 2)?.error).toMatchObject({ code: -32001, message: "ACP request settings/get exceeded 200ms." });
    expect(writer.messages().some((message) => message.id === 1)).toBe(false);
    expect(writer.messages().some((message) => message.id === 3)).toBe(false);

    // A long deadline must not cost promptness: cancellation still interrupts at once.
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 3 } }));
    await settle();
    expect(writer.messages().find((message) => message.id === 3)?.error).toMatchObject({ code: -32800 });

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(writer.messages().find((message) => message.id === 1)?.result).toEqual({ status: "completed" });
    expect(started).toEqual(["prompt", "prompt"]);
    await daemon.close();
  });

  test("a client request whose id looks like internal notification bookkeeping still routes", async () => {
    const writer = new Writer();
    const gate = Promise.withResolvers<void>();
    const daemon = new AcpDaemon({ handlers: { "session/steer": async () => { await gate.promise; }, "settings/get": async () => ({ ok: true }) } });
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "session/steer", params: {} }), writer);
    await settle();
    await daemon.handleLine(JSON.stringify({ jsonrpc: "2.0", id: "notification-1", method: "settings/get" }));
    await settle();
    expect(writer.messages().find((message) => message.id === "notification-1")?.result).toEqual({ ok: true });
    gate.resolve();
    await daemon.close();
  });
});
