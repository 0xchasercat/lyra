import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  initialized = 0;
  closed = 0;
  constructor(readonly options: LanguageServerClientOptions, private readonly initializeResult?: unknown) {}
  async initialize(): Promise<unknown> { this.initialized++; if (this.initializeResult instanceof Error) throw this.initializeResult; return this.initializeResult; }
  async request(method: string, params?: unknown, timeout?: number): Promise<unknown> { this.requests.push({ method, params, timeout }); return { method, params }; }
  async close(): Promise<void> { this.closed++; }
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
