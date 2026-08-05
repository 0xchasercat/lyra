import { describe, expect, test } from "bun:test";
import { fetchWithHeadersDeadline, parseSse, readJsonError, type SseEvent } from "../src/sse.ts";

describe("parseSse adversarial framing", () => {
  test("parses LF, CRLF, and CR delimiters even across chunk boundaries", async () => {
    const chunks = [
      "event: alpha\r",
      "\nid: 7\rdata: one\r\r",
      "event: beta\ndata: two\n\n",
      "data: three\r\n\r\n",
    ];
    expect(await parse(chunks)).toEqual([
      { event: "alpha", id: "7", data: "one" },
      { event: "beta", data: "two" },
      { data: "three" },
    ]);
  });

  test("reassembles split UTF-8 code points and joins multiple data fields", async () => {
    const encoded = new TextEncoder().encode("data: café ☕\ndata: second line\n\n");
    const stream = bytesStream([
      encoded.slice(0, 9),
      encoded.slice(9, 11),
      encoded.slice(11, 13),
      encoded.slice(13),
    ]);
    expect(await collect(parseSse(stream))).toEqual([{ data: "café ☕\nsecond line" }]);
  });

  test("ignores comments and unknown fields without losing empty data", async () => {
    expect(await parse([
      ": keepalive\n",
      "unknown: value\n",
      "data\n",
      "data:  leading space kept once\n\n",
    ])).toEqual([{ data: "\n leading space kept once" }]);
  });

  test("flushes a final event at EOF without a trailing blank line", async () => {
    expect(await parse(["event: final\nid: eof\ndata: payload"])).toEqual([
      { event: "final", id: "eof", data: "payload" },
    ]);
  });

  test("accepts only valid retry integers and safe event IDs", async () => {
    expect(await parse([
      "retry: 1500\nid: safe\ndata: first\n\n",
      "retry: -1\nid: bad\u0000id\ndata: second\n\n",
      "retry: 12ms\ndata: third\n\n",
      "retry: 1.5\ndata: fourth\n\n",
      "retry: 999999999999999999999999\ndata: fifth\n\n",
    ])).toEqual([
      { retry: 1500, id: "safe", data: "first" },
      { data: "second" },
      { data: "third" },
      { data: "fourth" },
      { data: "fifth" },
    ]);
  });

  test("does not dispatch field-only frames", async () => {
    expect(await parse(["event: ping\nid: 4\nretry: 10\n\n"])).toEqual([]);
  });

  test("cancellation interrupts a pending read and cancels the reader", async () => {
    let cancelledWith: unknown;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        // Deliberately leave the read pending.
      },
      cancel(reason) {
        cancelledWith = reason;
      },
    });
    const controller = new AbortController();
    const reason = new DOMException("fixture cancellation", "AbortError");
    const iterator = parseSse(stream, controller.signal);
    const pending = iterator.next();
    await Bun.sleep(0);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(cancelledWith).toBe(reason);
  });
});

describe("fetchWithHeadersDeadline", () => {
  test("does not abort a delayed body after headers arrive", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("headers arrived:"));
            // Native fetch/AbortSignal deadlines are not driven by Bun's fake timer clock.
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode("delayed body"));
              controller.close();
            }, 30);
          },
        }));
      },
    });
    try {
      const response = await fetchWithHeadersDeadline(
        `http://127.0.0.1:${server.port}/`,
        {},
        10,
      );
      expect(await response.text()).toBe("headers arrived:delayed body");
    } finally {
      await server.stop(true);
    }
  });

  test("keeps caller cancellation attached after headers arrive", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
          },
        }));
      },
    });
    const controller = new AbortController();
    const reason = new DOMException("cancel after headers", "AbortError");
    try {
      const response = await fetchWithHeadersDeadline(
        `http://127.0.0.1:${server.port}/`,
        { signal: controller.signal },
        1_000,
      );
      const body = response.text();
      controller.abort(reason);
      await expect(body).rejects.toBeDefined();
    } finally {
      await server.stop(true);
    }
  });
});

describe("readJsonError", () => {
  test("preserves structured provider errors", async () => {
    const body = { error: { code: "insufficient_quota", message: "exact provider message" } };
    expect(await readJsonError(new Response(JSON.stringify(body), { status: 429 }))).toEqual(body);
  });

  test("wraps non-JSON provider text without replacing it", async () => {
    expect(await readJsonError(new Response("upstream proxy exploded", { status: 502 }))).toEqual({
      message: "upstream proxy exploded",
    });
  });

  test("returns undefined for an empty error body", async () => {
    expect(await readJsonError(new Response(null, { status: 500 }))).toBeUndefined();
  });
});

async function parse(chunks: readonly string[]): Promise<SseEvent[]> {
  return collect(parseSse(bytesStream(chunks.map((chunk) => new TextEncoder().encode(chunk)))));
}

function bytesStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}
