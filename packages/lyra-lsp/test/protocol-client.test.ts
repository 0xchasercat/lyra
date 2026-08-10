import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LanguageServerClient } from "../src/client.ts";
import { encodeFrame, LspError, LspJsonRpcTransport } from "../src/protocol.ts";

const roots: string[] = [];
async function workspace(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "lyra-lsp-client-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class FakeProcess {
  readonly writes: Uint8Array[] = [];
  killed = false;
  /** Invoked with every complete frame the client writes; the fake server hooks this. */
  onFrame: ((message: Record<string, unknown>) => void) | undefined;
  private readonly queued: Uint8Array[] = [];
  private readonly waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  private ended = false;
  readonly stdin = {
    write: (data: string | Uint8Array) => {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : Uint8Array.from(data);
      this.writes.push(bytes);
      this.onFrame?.(bodyOf(bytes));
    },
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

function serverRequest(process: FakeProcess, id: number, method: string, params?: unknown): void {
  process.push(encodeFrame({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
}

/** Frames the client wrote that are replies rather than requests or notifications. */
function replies(process: FakeProcess): Array<Record<string, unknown>> {
  return process.writes.map(bodyOf).filter((frame) => frame.method === undefined && frame.id !== undefined);
}

function settle(): Promise<void> { return Bun.sleep(2); }

interface FakeDocument { languageId: string; version: number; text: string }
interface FakeServerOptions {
  /** Answer navigation with null until the document has been opened, as real servers do. */
  requireOpen?: boolean;
  capabilities?: Record<string, unknown>;
  /** Reject textDocument/diagnostic with MethodNotFound and push diagnostics instead. */
  pushDiagnostics?: readonly unknown[];
  /** Send the startup requests rust-analyzer and pyright send before answering initialize. */
  greet?: boolean;
}

/** A fake that behaves the way real servers do, not the way the client wishes they did. */
function fakeLanguageServer(process: FakeProcess, options: FakeServerOptions = {}) {
  const state = {
    open: new Map<string, FakeDocument>(),
    notifications: [] as Array<{ method: string; params: Record<string, unknown> }>,
    requests: [] as string[],
    initialize: undefined as Record<string, unknown> | undefined,
  };
  const reply = (id: number, result: unknown): void => { process.push(encodeFrame({ jsonrpc: "2.0", id, result })); };
  const fail = (id: number, code: number, message: string): void => { process.push(encodeFrame({ jsonrpc: "2.0", id, error: { code, message } })); };
  const uriOf = (params: Record<string, unknown> | undefined): string => String((params?.textDocument as { uri?: string } | undefined)?.uri ?? "");

  process.onFrame = (message) => {
    const method = typeof message.method === "string" ? message.method : undefined;
    if (method === undefined) return; // The client replying to one of our requests.
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (message.id === undefined) {
      state.notifications.push({ method, params });
      const document = params.textDocument as { uri: string; languageId?: string; version?: number } | undefined;
      if (method === "textDocument/didOpen" && document) {
        state.open.set(document.uri, { languageId: String(document.languageId), version: Number(document.version), text: String((params.textDocument as { text?: unknown }).text) });
        for (const diagnostics of options.pushDiagnostics === undefined ? [] : [options.pushDiagnostics]) {
          process.push(encodeFrame({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: document.uri, diagnostics } }));
        }
      }
      if (method === "textDocument/didChange" && document) {
        const changes = params.contentChanges as Array<{ text: string }>;
        state.open.set(document.uri, { languageId: state.open.get(document.uri)?.languageId ?? "", version: Number(document.version), text: changes[0]!.text });
      }
      if (method === "textDocument/didClose" && document) state.open.delete(document.uri);
      return;
    }
    const id = Number(message.id);
    state.requests.push(method);
    if (method === "initialize") {
      state.initialize = params;
      if (options.greet === true) {
        serverRequest(process, 9001, "window/workDoneProgress/create", { token: "index" });
        serverRequest(process, 9002, "workspace/configuration", { items: [{ section: "rust-analyzer" }, { section: "files" }] });
        serverRequest(process, 9003, "client/registerCapability", { registrations: [{ id: "watch", method: "workspace/didChangeWatchedFiles" }] });
        process.push(encodeFrame({ jsonrpc: "2.0", method: "$/progress", params: { token: "index", value: { kind: "begin", title: "indexing" } } }));
      }
      reply(id, { capabilities: options.capabilities ?? { textDocumentSync: 1 } });
      return;
    }
    if (method === "shutdown") { reply(id, null); return; }
    if (method === "textDocument/diagnostic") {
      if (options.pushDiagnostics !== undefined) { fail(id, -32601, "Unhandled method textDocument/diagnostic"); return; }
      reply(id, { kind: "full", items: [{ message: "unused" }] });
      return;
    }
    const uri = uriOf(params);
    if (options.requireOpen === true && !state.open.has(uri)) { reply(id, null); return; }
    if (method === "textDocument/definition") {
      reply(id, [{ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]);
      return;
    }
    reply(id, null);
  };
  return state;
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

  test("answers server-initiated requests mid-stream without failing the transport", async () => {
    const process = new FakeProcess();
    const transport = new LspJsonRpcTransport(process, { defaultTimeoutMs: 500 });
    const pending = transport.request("initialize");
    await Bun.sleep(0);
    serverRequest(process, 7001, "window/workDoneProgress/create", { token: "index" });
    serverRequest(process, 7002, "workspace/configuration", { items: [{ section: "a" }, { section: "b" }] });
    serverRequest(process, 7003, "client/registerCapability", { registrations: [] });
    process.push(encodeFrame({ jsonrpc: "2.0", method: "$/progress", params: { token: "index" } }));
    await settle();
    respond(process, 1, { capabilities: {} });
    expect(await pending).toEqual({ capabilities: {} });
    expect(replies(process)).toEqual([
      { jsonrpc: "2.0", id: 7001, result: null },
      { jsonrpc: "2.0", id: 7002, result: [null, null] },
      { jsonrpc: "2.0", id: 7003, result: null },
    ]);
    expect(process.killed).toBe(false);
    await transport.close();
  });

  test("rejects unknown server requests with MethodNotFound and keeps serving", async () => {
    const process = new FakeProcess();
    const transport = new LspJsonRpcTransport(process, { defaultTimeoutMs: 500 });
    const pending = transport.request("hover");
    await Bun.sleep(0);
    serverRequest(process, 8001, "window/inventedRequest", {});
    await settle();
    respond(process, 1, "still alive");
    expect(await pending).toBe("still alive");
    expect(replies(process)[0]).toMatchObject({ id: 8001, error: { code: -32601 } });
    await transport.close();
  });

  test("forwards server notifications to onNotification", async () => {
    const process = new FakeProcess();
    const seen: Array<{ method: string; params: unknown }> = [];
    const transport = new LspJsonRpcTransport(process, { defaultTimeoutMs: 500, onNotification: (method, params) => { seen.push({ method, params }); } });
    process.push(encodeFrame({ jsonrpc: "2.0", method: "window/logMessage", params: { message: "loaded" } }));
    await settle();
    expect(seen).toEqual([{ method: "window/logMessage", params: { message: "loaded" } }]);
    await transport.close();
  });

  test("honors maxTimeoutMs for both the default and per-request deadlines", async () => {
    const capped = new FakeProcess();
    const transport = new LspJsonRpcTransport(capped, { defaultTimeoutMs: 60_000, maxTimeoutMs: 15 });
    await expect(transport.request("slow")).rejects.toMatchObject({ kind: "timeout" });

    const perRequest = new FakeProcess();
    const second = new LspJsonRpcTransport(perRequest, { defaultTimeoutMs: 10_000, maxTimeoutMs: 15 });
    await expect(second.request("slow", undefined, 60_000)).rejects.toMatchObject({ kind: "timeout" });
  });

  test("allows a ceiling above the twenty second default when asked", async () => {
    const process = new FakeProcess();
    const transport = new LspJsonRpcTransport(process, { defaultTimeoutMs: 45_000, maxTimeoutMs: 60_000 });
    const pending = transport.request("slow");
    await Bun.sleep(0);
    respond(process, 1, "ok");
    expect(await pending).toBe("ok");
    await transport.close();
  });
});

describe("LanguageServerClient", () => {
  test("initializes with real capabilities and exposes provider operations", async () => {
    const process = new FakeProcess();
    const server = fakeLanguageServer(process);
    const root = await workspace();
    const client = new LanguageServerClient({ command: "fake", cwd: root, spawn: () => process as never, requestTimeoutMs: 500 });
    expect(await client.initialize()).toEqual({ capabilities: { textDocumentSync: 1 } });
    const capabilities = server.initialize?.capabilities as Record<string, Record<string, unknown>>;
    expect(capabilities.general).toEqual({ positionEncodings: ["utf-16"] });
    expect(Object.keys(capabilities.textDocument!)).toEqual([
      "synchronization", "definition", "references", "hover", "rename", "codeAction", "publishDiagnostics", "diagnostic",
    ]);
    // A missing root is why rust-analyzer answers nothing; cwd is the sane default.
    expect(server.initialize?.rootUri).toBe(pathToFileURL(root).href);
    // A path that cannot be read is still forwarded, but never announced as open.
    const missing = pathToFileURL(join(root, "absent.ts")).href;
    expect(await client.definition({ textDocument: { uri: missing } })).toEqual([
      { uri: missing, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    ]);
    expect(client.openDocuments).toEqual([]);
    expect(await client.diagnostics({})).toEqual([{ message: "unused" }]);
    await client.close();
  });

  test("opens a document before requesting against it", async () => {
    const process = new FakeProcess();
    const server = fakeLanguageServer(process, { requireOpen: true });
    const root = await workspace();
    const file = join(root, "lib.ts");
    await writeFile(file, "export const x = 1;\n");
    const uri = pathToFileURL(file).href;
    const client = new LanguageServerClient({ command: "fake", cwd: root, spawn: () => process as never, requestTimeoutMs: 500 });
    const found = await client.definition({ textDocument: { uri }, position: { line: 0, character: 13 } });
    expect(found).toEqual([{ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]);
    expect(server.open.get(uri)).toEqual({ languageId: "typescript", version: 1, text: "export const x = 1;\n" });
    expect(client.openDocuments).toEqual([uri]);
    await client.close();
  });

  test("resends content only when the file changed on disk", async () => {
    const process = new FakeProcess();
    const server = fakeLanguageServer(process, { requireOpen: true });
    const root = await workspace();
    const file = join(root, "main.py");
    await writeFile(file, "x = 1\n");
    const uri = pathToFileURL(file).href;
    const client = new LanguageServerClient({ command: "fake", cwd: root, spawn: () => process as never, requestTimeoutMs: 500 });
    await client.hover({ textDocument: { uri } });
    await client.hover({ textDocument: { uri } });
    expect(server.notifications.filter(({ method }) => method === "textDocument/didOpen")).toHaveLength(1);
    expect(server.notifications.filter(({ method }) => method === "textDocument/didChange")).toHaveLength(0);
    expect(server.open.get(uri)?.languageId).toBe("python");

    await writeFile(file, "x = 2\ny = 3\n");
    await client.hover({ textDocument: { uri } });
    expect(server.notifications.filter(({ method }) => method === "textDocument/didChange")).toHaveLength(1);
    expect(server.open.get(uri)).toEqual({ languageId: "python", version: 2, text: "x = 2\ny = 3\n" });
    await client.close();
  });

  test("reopens instead of changing when the server declines change notifications", async () => {
    const process = new FakeProcess();
    const server = fakeLanguageServer(process, { capabilities: { textDocumentSync: { openClose: true, change: 0 } } });
    const root = await workspace();
    const file = join(root, "lib.rs");
    await writeFile(file, "fn main() {}\n");
    const uri = pathToFileURL(file).href;
    const client = new LanguageServerClient({ command: "fake", cwd: root, spawn: () => process as never, requestTimeoutMs: 500 });
    await client.hover({ textDocument: { uri } });
    await writeFile(file, "fn main() { let x = 1; }\n");
    await client.hover({ textDocument: { uri } });
    expect(server.notifications.map(({ method }) => method)).toEqual([
      "initialized", "textDocument/didOpen", "textDocument/didClose", "textDocument/didOpen",
    ]);
    expect(server.open.get(uri)).toEqual({ languageId: "rust", version: 2, text: "fn main() { let x = 1; }\n" });
    await client.close();
  });

  test("sends no document notifications when the server wants none", async () => {
    const process = new FakeProcess();
    const server = fakeLanguageServer(process, { capabilities: { textDocumentSync: 0 } });
    const root = await workspace();
    const file = join(root, "lib.ts");
    await writeFile(file, "export const x = 1;\n");
    const client = new LanguageServerClient({ command: "fake", cwd: root, spawn: () => process as never, requestTimeoutMs: 500 });
    await client.hover({ textDocument: { uri: pathToFileURL(file).href } });
    expect(server.notifications.map(({ method }) => method)).toEqual(["initialized"]);
    await client.close();
  });

  test("closes the least recently used document once the working set is full", async () => {
    const process = new FakeProcess();
    const server = fakeLanguageServer(process);
    const root = await workspace();
    const uris: string[] = [];
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      const file = join(root, name);
      await writeFile(file, `export const ${name[0]} = 1;\n`);
      uris.push(pathToFileURL(file).href);
    }
    const client = new LanguageServerClient({ command: "fake", cwd: root, spawn: () => process as never, requestTimeoutMs: 500, maxOpenDocuments: 2 });
    for (const uri of uris) await client.hover({ textDocument: { uri } });
    expect(server.notifications.filter(({ method }) => method === "textDocument/didClose").map(({ params }) => (params.textDocument as { uri: string }).uri)).toEqual([uris[0]]);
    expect(client.openDocuments).toEqual([uris[1]!, uris[2]!]);
    expect([...server.open.keys()]).toEqual([uris[1]!, uris[2]!]);
    await client.close();
  });

  test("falls back to published diagnostics when pull diagnostics are unsupported", async () => {
    const process = new FakeProcess();
    const pushed = [{ message: "unused variable", severity: 2 }];
    const server = fakeLanguageServer(process, { pushDiagnostics: pushed });
    const root = await workspace();
    const file = join(root, "lib.rs");
    await writeFile(file, "fn main() { let x = 1; }\n");
    const uri = pathToFileURL(file).href;
    const client = new LanguageServerClient({ command: "fake", cwd: root, spawn: () => process as never, requestTimeoutMs: 500 });
    expect(await client.diagnostics({ textDocument: { uri } })).toEqual(pushed);
    // The pull attempt is made once, then abandoned for the life of the client.
    expect(await client.diagnostics({ textDocument: { uri } })).toEqual(pushed);
    expect(server.requests.filter((method) => method === "textDocument/diagnostic")).toHaveLength(1);
    await client.close();
  });

  test("performs the shutdown handshake before the process is killed", async () => {
    const process = new FakeProcess();
    const server = fakeLanguageServer(process);
    const root = await workspace();
    const client = new LanguageServerClient({ command: "fake", cwd: root, spawn: () => process as never, requestTimeoutMs: 500 });
    await client.initialize();
    expect(process.killed).toBe(false);
    expect(await client.shutdown(50)).toBeUndefined();
    const sent = process.writes.map(bodyOf).map((frame) => frame.method).filter((method) => method !== undefined);
    expect(sent).toEqual(["initialize", "initialized", "shutdown", "exit"]);
    expect(server.requests).toEqual(["initialize", "shutdown"]);
    expect(process.killed).toBe(true);
    await client.close();
  });

  test("survives a server that opens progress and pulls configuration during startup", async () => {
    const process = new FakeProcess();
    const server = fakeLanguageServer(process, { greet: true, requireOpen: true });
    const root = await workspace();
    const file = join(root, "lib.rs");
    await writeFile(file, "fn main() {}\n");
    const uri = pathToFileURL(file).href;
    const client = new LanguageServerClient({ command: "fake", cwd: root, spawn: () => process as never, requestTimeoutMs: 500 });
    const found = await client.definition({ textDocument: { uri }, position: { line: 0, character: 3 } });
    expect(found).toEqual([{ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]);
    expect(replies(process).map((frame) => frame.id)).toEqual([9001, 9002, 9003]);
    expect(replies(process)[1]?.result).toEqual([null, null]);
    expect(server.open.has(uri)).toBe(true);
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
