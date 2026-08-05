import { describe, expect, test } from "bun:test";
import { LanguageServerClient } from "../src/client.ts";
import { encodeFrame, LspError, LspJsonRpcTransport } from "../src/protocol.ts";

class FakeProcess {
  readonly writes: Uint8Array[] = [];
  killed = false;
  private readonly queued: Uint8Array[] = [];
  private readonly waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  private ended = false;
  readonly stdin = {
    write: (data: string | Uint8Array) => { this.writes.push(typeof data === "string" ? new TextEncoder().encode(data) : Uint8Array.from(data)); },
    end: () => { this.endOutput(); },
  };
  readonly stdout: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<Uint8Array>> => {
        if (this.queued.length > 0) return Promise.resolve({ done: false, value: this.queued.shift()! });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    }),
  };
  kill(): void { this.killed = true; this.endOutput(); }
  push(data: Uint8Array | string): void {
    const value = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.queued.push(value);
  }
  endOutput(): void { this.ended = true; for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined }); }
}

function bodyOf(frame: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(frame);
  const split = text.indexOf("\r\n\r\n");
  return JSON.parse(text.slice(split + 4)) as Record<string, unknown>;
}

function respond(process: FakeProcess, id: number, result: unknown): void {
  process.push(encodeFrame({ jsonrpc: "2.0", id, result }));
}

describe("LSP JSON-RPC transport", () => {
  test("frames UTF-8 byte lengths and parses fragmented frames", async () => {
    const process = new FakeProcess();
    const transport = new LspJsonRpcTransport(process, { defaultTimeoutMs: 500 });
    const request = transport.request("echo", { text: "héllo" });
    await Bun.sleep(0);
    const sent = process.writes[0]!;
    const text = new TextDecoder().decode(sent);
    const header = text.slice(0, text.indexOf("\r\n\r\n"));
    const payload = text.slice(text.indexOf("\r\n\r\n") + 4);
    expect(Number(header.slice(header.indexOf(":") + 1))).toBe(new TextEncoder().encode(payload).byteLength);
    const response = encodeFrame({ jsonrpc: "2.0", id: 1, result: "✓" });
    process.push(response.slice(0, 3));
    process.push(response.slice(3, 17));
    process.push(response.slice(17));
    expect(await request).toBe("✓");
    await transport.close();
  });

  test("correlates concurrent responses by id", async () => {
    const process = new FakeProcess();
    const transport = new LspJsonRpcTransport(process, { defaultTimeoutMs: 500 });
    const first = transport.request("first");
    const second = transport.request("second");
    await Bun.sleep(0);
    const ids = process.writes.map((write) => Number(bodyOf(write).id));
    respond(process, ids[1]!, "second-result");
    respond(process, ids[0]!, "first-result");
    expect(await Promise.all([first, second])).toEqual(["first-result", "second-result"]);
    await transport.close();
  });

  test("times out and kills an unresponsive process", async () => {
    const process = new FakeProcess();
    const transport = new LspJsonRpcTransport(process, { defaultTimeoutMs: 10 });
    const request = transport.request("hang");
    await expect(request).rejects.toMatchObject({ kind: "timeout" });
    expect(process.killed).toBe(true);
  });

  test("turns malformed JSON into an actionable protocol error", async () => {
    const process = new FakeProcess();
    const transport = new LspJsonRpcTransport(process, { defaultTimeoutMs: 500 });
    const request = transport.request("bad");
    await Bun.sleep(0);
    const invalid = new TextEncoder().encode("not-json");
    process.push(new TextEncoder().encode(`Content-Length: ${invalid.byteLength}\r\n\r\nnot-json`));
    await expect(request).rejects.toMatchObject({ kind: "protocol" });
    await transport.close();
  });
});

describe("LanguageServerClient", () => {
  test("initializes and exposes provider operations", async () => {
    const process = new FakeProcess();
    const spawn = () => process as never;
    const client = new LanguageServerClient({ command: "fake", cwd: ".", spawn, requestTimeoutMs: 500 });
    const server = async () => {
      while (process.writes.length > 0) {
        const body = bodyOf(process.writes.shift()!);
        if (typeof body.id !== "number") continue;
        const result = body.method === "initialize" ? { capabilities: {} }
          : body.method === "textDocument/definition" ? [{ uri: "file:///x.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
          : body.method === "textDocument/diagnostic" ? { items: [{ message: "unused" }] }
          : body.method === "shutdown" ? null : [];
        respond(process, body.id, result);
      }
    };
    const initialized = client.initialize();
    await Bun.sleep(0); await server();
    expect(await initialized).toEqual({ capabilities: {} });
    const definition = client.definition({});
    await Bun.sleep(0); await server();
    expect(await definition).toHaveLength(1);
    const diagnostics = client.diagnostics({});
    await Bun.sleep(0); await server();
    expect(await diagnostics).toEqual([{ message: "unused" }]);
    await client.close();
  });

  test("returns typed errors instead of throwing process failures", async () => {
    const spawn = () => { throw new Error("not installed"); };
    const client = new LanguageServerClient({ command: "missing", cwd: ".", spawn });
    const result = await client.initialize();
    expect(result).toBeInstanceOf(LspError);
    expect((result as LspError).kind).toBe("process");
  });
});
