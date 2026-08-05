import { describe, expect, test } from "bun:test";
import { encodeFrame, LspError, LspJsonRpcTransport } from "../src/protocol.ts";

class ByteQueue implements AsyncIterable<Uint8Array> {
  readonly values: Uint8Array[] = [];
  readonly waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  done = false;
  push(value: Uint8Array): void { const waiter = this.waiters.shift(); if (waiter) waiter({ done: false, value }); else this.values.push(value); }
  end(): void { this.done = true; while (this.waiters.length) this.waiters.shift()!({ done: true, value: undefined as never }); }
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (true) {
      if (this.values.length) { yield this.values.shift()!; continue; }
      if (this.done) return;
      const value = await new Promise<IteratorResult<Uint8Array>>((resolve) => this.waiters.push(resolve));
      if (value.done) return;
      yield value.value;
    }
  }
}

class FakeProcess {
  readonly stdout = new ByteQueue();
  readonly writes: Uint8Array[] = [];
  killed = 0;
  readonly stdin = {
    write: (data: Uint8Array): void => { this.writes.push(new Uint8Array(data)); },
    end: (): void => this.stdout.end(),
  };
  kill(): void { this.killed += 1; }
}

function response(id: number | string, result: unknown): Uint8Array { return encodeFrame({ jsonrpc: "2.0", id, result }); }
function requestFrom(bytes: Uint8Array): { id: number; method: string; params?: unknown } {
  const split = new TextDecoder().decode(bytes).indexOf("\r\n\r\n");
  return JSON.parse(new TextDecoder().decode(bytes.slice(split + 4))) as { id: number; method: string; params?: unknown };
}

function processForTransport(fake: FakeProcess): ConstructorParameters<typeof LspJsonRpcTransport>[0] {
  return fake as unknown as ConstructorParameters<typeof LspJsonRpcTransport>[0];
}

describe("LSP JSON-RPC framing", () => {
  test("uses UTF-8 byte length and handles fragmented response frames", async () => {
    const fake = new FakeProcess();
    const transport = new LspJsonRpcTransport(processForTransport(fake), { defaultTimeoutMs: 1000 });
    const pending = transport.request("textDocument/hover", { text: "café 日本語" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sent = new TextDecoder().decode(fake.writes[0]!);
    const headerLength = Number(sent.match(/Content-Length: (\d+)/)?.[1]);
    const body = sent.slice(sent.indexOf("\r\n\r\n") + 4);
    expect(new TextEncoder().encode(body).byteLength).toBe(headerLength);
    const id = requestFrom(fake.writes[0]!).id;
    const framed = response(id, { contents: "résultat" });
    fake.stdout.push(framed.slice(0, 7));
    fake.stdout.push(framed.slice(7));
    await expect(pending).resolves.toEqual({ contents: "résultat" });
    await transport.close();
  });

  test("correlates concurrent responses and serializes writes", async () => {
    const fake = new FakeProcess();
    const transport = new LspJsonRpcTransport(processForTransport(fake), { defaultTimeoutMs: 1000 });
    const first = transport.request("one");
    const second = transport.request("two");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstId = requestFrom(fake.writes[0]!).id;
    const secondId = requestFrom(fake.writes[1]!).id;
    fake.stdout.push(response(secondId, "second"));
    fake.stdout.push(response(firstId, "first"));
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(fake.writes).toHaveLength(2);
    await transport.close();
  });

  test("rejects a timed-out request, kills the process, and rejects malformed responses", async () => {
    const fake = new FakeProcess();
    const transport = new LspJsonRpcTransport(processForTransport(fake), { defaultTimeoutMs: 15 });
    await expect(transport.request("slow")).rejects.toMatchObject({ kind: "timeout" });
    expect(fake.killed).toBeGreaterThan(0);

    const secondFake = new FakeProcess();
    const second = new LspJsonRpcTransport(processForTransport(secondFake), { defaultTimeoutMs: 1000 });
    const pending = second.request("bad");
    await new Promise((resolve) => setTimeout(resolve, 0));
    secondFake.stdout.push(new TextEncoder().encode("Content-Length: 2\r\n\r\n{}"));
    await expect(pending).rejects.toBeInstanceOf(LspError);
    await second.close();
  });
});
