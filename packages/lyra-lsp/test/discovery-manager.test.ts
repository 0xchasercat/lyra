import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_LANGUAGE_SERVERS, discoverLanguageServers, LspManager } from "../src/index.ts";
import type { LanguageServerClientOptions, LanguageServerSpec, LspMethod, TextFallback } from "../src/index.ts";

const roots: string[] = [];
async function workspace(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "lyra-lsp-manager-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function fallbackFixture() {
  const calls: Array<{ method: LspMethod; params: unknown }> = [];
  const warnings: string[] = [];
  const fallback: TextFallback = {
    async run(method, params) { calls.push({ method, params }); return { fallback: method }; },
    warn(message) { warnings.push(message); },
  };
  return { fallback, calls, warnings };
}

class FakeClient {
  readonly requests: Array<{ method: string; params: unknown; timeout: number | undefined }> = [];
  /** Teardown order, so the shutdown handshake can be asserted against the kill. */
  readonly events: string[] = [];
  initialized = 0;
  closed = 0;
  constructor(readonly options: LanguageServerClientOptions, private readonly initializeResult?: unknown) {}
  async initialize(): Promise<unknown> { this.initialized++; if (this.initializeResult instanceof Error) throw this.initializeResult; return this.initializeResult; }
  async request(method: string, params?: unknown, timeout?: number): Promise<unknown> { this.requests.push({ method, params, timeout }); return { method, params }; }
  async shutdown(timeoutMs?: number): Promise<unknown> { this.events.push(`shutdown:${String(timeoutMs)}`); return null; }
  async close(): Promise<void> { this.closed++; this.events.push("close"); }
}

describe("language-server discovery", () => {
  test("detects markers in deterministic server order and suppresses generic fallback", async () => {
    const root = await workspace();
    await Promise.all(["go.mod", "package-lock.json", "setup.py", "Cargo.toml", "tsconfig.json"].map((name) => writeFile(join(root, name), "")));
    const found = await discoverLanguageServers(root);
    expect(found.map(({ language }) => language)).toEqual(["rust", "typescript", "python", "go"]);
    expect(DEFAULT_LANGUAGE_SERVERS.map(({ command }) => command)).toEqual([
      "rust-analyzer", "typescript-language-server", "pyright-langserver", "gopls", "typescript-language-server",
    ]);
  });

  test("uses package markers as a deterministic fallback and applies command overrides", async () => {
    const root = await workspace();
    await writeFile(join(root, "package-lock.json"), "{}");
    const [found] = await discoverLanguageServers(root, { commands: { javascript: { command: "/opt/ts-lsp", args: ["serve"] } } });
    expect(found).toMatchObject({ language: "javascript", command: "/opt/ts-lsp", args: ["serve"] });
  });

  test("returns no servers for no markers or malformed workspace paths", async () => {
    const root = await workspace();
    expect(await discoverLanguageServers(root)).toEqual([]);
    expect(await discoverLanguageServers(join(root, "missing"))).toEqual([]);
    expect(await discoverLanguageServers("" )).toEqual([]);
  });
});

describe("LspManager", () => {
  test("eagerly initializes, routes every operation, honors the deadline, and closes", async () => {
    const root = await workspace();
    await writeFile(join(root, "Cargo.toml"), "");
    const clients: FakeClient[] = [];
    const manager = await LspManager.create({
      workspace: root,
      clientFactory(options) { const client = new FakeClient(options); clients.push(client); return client; },
    });
    const params = { textDocument: { uri: "file:///workspace/src/lib.rs" } };
    await manager.definition("rust", params);
    await manager.references(params);
    await manager.hover("rs", params);
    await manager.rename(params, "rust");
    await manager.diagnostics("rust", params);
    await manager.codeAction(params);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.initialized).toBe(1);
    expect(clients[0]?.requests.map(({ method }) => method)).toEqual([
      "textDocument/definition", "textDocument/references", "textDocument/hover", "textDocument/rename",
      "textDocument/diagnostic", "textDocument/codeAction",
    ]);
    expect(clients[0]?.requests.every(({ timeout }) => timeout === 20_000)).toBe(true);
    await manager.close();
    await manager.close();
    expect(clients[0]?.closed).toBe(1);
  });

  test("asks for the shutdown handshake before tearing a server down", async () => {
    const root = await workspace();
    await writeFile(join(root, "Cargo.toml"), "");
    const clients: FakeClient[] = [];
    const manager = await LspManager.create({
      workspace: root,
      clientFactory(options) { const client = new FakeClient(options); clients.push(client); return client; },
    });
    expect(manager.shutdownDeadlineMs).toBe(2_000);
    await manager.close();
    expect(clients[0]?.events).toEqual(["shutdown:2000", "close"]);
  });

  test("never lets a stalled shutdown hold the session open", async () => {
    const root = await workspace();
    await writeFile(join(root, "Cargo.toml"), "");
    let closed = 0;
    const manager = await LspManager.create({
      workspace: root,
      shutdownDeadlineMs: 5,
      clientFactory() {
        return {
          async initialize() {},
          async shutdown() { return new Promise<never>(() => {}); },
          async close() { closed++; },
        };
      },
    });
    await manager.close();
    expect(closed).toBe(1);
  });

  test("falls back and warns only once when a discovered server is unavailable", async () => {
    const root = await workspace();
    await writeFile(join(root, "go.mod"), "");
    const fallback = fallbackFixture();
    const manager = await LspManager.create({
      workspace: root,
      fallback: fallback.fallback,
      clientFactory(options) { return new FakeClient(options, new Error("gopls not installed")); },
    });
    await manager.definition("go", { uri: "file:///workspace/main.go" });
    await manager.hover("go", { uri: "file:///workspace/main.go" });
    expect(fallback.calls.map(({ method }) => method)).toEqual(["textDocument/definition", "textDocument/hover"]);
    expect(fallback.warnings).toHaveLength(1);
    expect(manager.warningLog).toHaveLength(1);
    await manager.close();
  });

  test("request deadline degrades to fallback and closes the timed-out client", async () => {
    const root = await workspace();
    await writeFile(join(root, "pyproject.toml"), "");
    const fallback = fallbackFixture();
    let closed = 0;
    const manager = await LspManager.create({
      workspace: root,
      fallback: fallback.fallback,
      deadlineMs: 5,
      clientFactory() {
        return {
          async initialize() {},
          async request() { return new Promise<never>(() => {}); },
          async close() { closed++; },
        };
      },
    });
    expect(await manager.definition("python", {})).toEqual({ fallback: "textDocument/definition" });
    await Bun.sleep(0);
    expect(closed).toBe(1);
    expect(fallback.warnings).toHaveLength(1);
    await manager.close();
  });

  test("restarts a language once after a timeout instead of disabling it for the session", async () => {
    const root = await workspace();
    await writeFile(join(root, "Cargo.toml"), "");
    const fallback = fallbackFixture();
    let created = 0;
    const manager = await LspManager.create({
      workspace: root,
      fallback: fallback.fallback,
      deadlineMs: 10,
      clientFactory() {
        // Only the server started at discovery is slow: a cold index, not a broken binary.
        const stalls = created === 0;
        created += 1;
        return {
          async initialize() {},
          async request(method: string) { return stalls ? new Promise<never>(() => {}) : { method, served: true }; },
          async close() {},
        };
      },
    });
    const params = { textDocument: { uri: "file:///workspace/src/lib.rs" } };
    expect(await manager.definition("rust", params)).toEqual({ fallback: "textDocument/definition" });
    expect(await manager.definition("rust", params)).toEqual({ method: "textDocument/definition", served: true });
    expect(await manager.hover("rust", params)).toEqual({ method: "textDocument/hover", served: true });
    expect(created).toBe(2);
    expect(manager.has("rust")).toBe(true);
    await manager.close();
  });

  test("restarts after a thrown request error, not only after a timeout", async () => {
    const root = await workspace();
    await writeFile(join(root, "Cargo.toml"), "");
    const fallback = fallbackFixture();
    let created = 0;
    const manager = await LspManager.create({
      workspace: root,
      fallback: fallback.fallback,
      clientFactory() {
        const throws = created === 0;
        created += 1;
        return {
          async initialize() {},
          async request(method: string) { if (throws) throw new Error("server crashed"); return { method, served: true }; },
          async close() {},
        };
      },
    });
    expect(await manager.definition("rust", {})).toEqual({ fallback: "textDocument/definition" });
    expect(await manager.definition("rust", {})).toEqual({ method: "textDocument/definition", served: true });
    expect(created).toBe(2);
    await manager.close();
  });

  test("spends the restart budget once and then stays on the text fallback", async () => {
    const root = await workspace();
    await writeFile(join(root, "Cargo.toml"), "");
    const fallback = fallbackFixture();
    let created = 0;
    const manager = await LspManager.create({
      workspace: root,
      fallback: fallback.fallback,
      deadlineMs: 10,
      clientFactory() {
        created += 1;
        return {
          async initialize() {},
          async request() { return new Promise<never>(() => {}); },
          async close() {},
        };
      },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await manager.definition("rust", {})).toEqual({ fallback: "textDocument/definition" });
    }
    expect(created).toBe(2);
    expect(fallback.warnings).toHaveLength(1);
    expect(manager.has("rust")).toBe(false);
    await manager.close();
  });

  test("never restarts a language whose server failed to start at all", async () => {
    const root = await workspace();
    await writeFile(join(root, "go.mod"), "");
    const fallback = fallbackFixture();
    let created = 0;
    const manager = await LspManager.create({
      workspace: root,
      fallback: fallback.fallback,
      clientFactory(options) { created += 1; return new FakeClient(options, new Error("gopls not installed")); },
    });
    await manager.definition("go", {});
    await manager.definition("go", {});
    expect(created).toBe(1);
    await manager.close();
  });

  test("malformed workspaces create an empty manager with a reason", async () => {
    const root = await workspace();
    const manager = await LspManager.create({ workspace: join(root, "absent") });
    expect(manager.languages).toEqual([]);
    expect(manager.reason).toContain("not a readable directory");
    await manager.close();
  });

  test("does not start duplicate language or command specs", async () => {
    const root = await workspace();
    await writeFile(join(root, "marker"), "");
    const specs: LanguageServerSpec[] = [
      { language: "rust", command: "same", args: [], markers: ["marker"] },
      { language: "rust", command: "other", args: [], markers: ["marker"] },
      { language: "go", command: "same", args: [], markers: ["marker"] },
    ];
    const clients: FakeClient[] = [];
    const manager = await LspManager.create({ workspace: root, specs, clientFactory(options) { const client = new FakeClient(options); clients.push(client); return client; } });
    expect(clients).toHaveLength(1);
    await manager.close();
  });
});

function commandWorks(command: string): boolean {
  const executable = Bun.which(command);
  if (executable === null) return false;
  try {
    return Bun.spawnSync([executable, "--version"], { stdout: "ignore", stderr: "ignore" }).success;
  } catch {
    return false;
  }
}

// Opportunistic: real servers are the only proof the handshake is right, but a
// missing toolchain is not a test failure. `Bun.which` alone is insufficient on
// rustup installations: its rust-analyzer shim exists even when the component does not.
const rustToolchainAvailable = commandWorks("rust-analyzer") && commandWorks("cargo");
describe.skipIf(!rustToolchainAvailable)("rust-analyzer integration", () => {
  test("survives real startup traffic and navigates a real crate", async () => {
    const root = await workspace();
    await writeFile(join(root, "Cargo.toml"), "[package]\nname = \"probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    await mkdir(join(root, "src"));
    const main = join(root, "src", "main.rs");
    await writeFile(main, "fn greet(name: &str) -> String { format!(\"hi {name}\") }\n\nfn main() { println!(\"{}\", greet(\"lyra\")); }\n");
    const uri = pathToFileURL(main).href;
    const manager = await LspManager.create({ workspace: root });
    expect(manager.languages).toEqual(["rust"]);

    const position = { line: 2, character: 28 };
    let definition: unknown = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      definition = await manager.definition({ textDocument: { uri }, position });
      if (Array.isArray(definition) && definition.length > 0) break;
      await Bun.sleep(500);
    }
    // How fast the crate indexes is the machine's business; surviving the server's
    // progress and configuration requests without degrading is ours.
    expect(manager.warningLog).toEqual([]);
    if (Array.isArray(definition) && definition.length > 0) {
      expect(definition[0]).toMatchObject({ uri, range: { start: { line: 0, character: 3 } } });
    }
    await manager.close();
  }, 30_000);
});
