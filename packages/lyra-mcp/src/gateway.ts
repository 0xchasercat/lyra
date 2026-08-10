import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { McpStdioClient, McpError } from "./client.ts";
import type { McpClientOptions, McpServerConfig, McpToolDescriptor, McpToolSummary, McpGatewayOptions, McpToolLike, DracoInstallerOptions } from "./types.ts";
import { foldToolAliases, type ToolAlias, type ToolExecutionContext, type ToolExecutionResult } from "@lyra/core";
import type { ToolDefinition } from "@lyra/provider";

export class McpRegistry {
  readonly path: string;
  #configs: Record<string, McpServerConfig> = {};
  #clients = new Map<string, McpStdioClient>();
  #index: McpToolSummary[] = [];
  #loaded = false;
  #timeoutMs: number | undefined;

  constructor(root: string, options: { timeoutMs?: number } = {}) {
    if (typeof root !== "string" || root.length === 0) throw new TypeError("MCP registry root is required.");
    this.path = resolve(root, ".lyra", "mcp.json");
    this.#timeoutMs = options.timeoutMs;
  }
  async load(): Promise<Readonly<Record<string, McpServerConfig>>> {
    if (this.#loaded) return this.#configs;
    this.#loaded = true;
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config must be an object");
      for (const [name, config] of Object.entries(value)) this.validate(name, config);
      this.#configs = value as Record<string, McpServerConfig>;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw new Error(`MCP config is invalid: ${error instanceof Error ? error.message : String(error)}.`);
    }
    return this.#configs;
  }
  async set(name: string, config: McpServerConfig): Promise<void> { await this.load(); this.validate(name, config); this.#configs[name] = { command: config.command, ...(config.args === undefined ? {} : { args: [...config.args] }), ...(config.cwd === undefined ? {} : { cwd: config.cwd }), ...(config.env === undefined ? {} : { env: { ...config.env } }) }; await this.save(); }
  async remove(name: string): Promise<boolean> { await this.load(); if (!(name in this.#configs)) return false; await this.#clients.get(name)?.close(); this.#clients.delete(name); delete this.#configs[name]; await this.save(); return true; }
  async names(): Promise<string[]> { await this.load(); return Object.keys(this.#configs).sort(); }
  async client(name: string): Promise<McpStdioClient> { await this.load(); const config = this.#configs[name]; if (!config) throw new McpError("unknown_server", `Unknown MCP server ${name}. Available: ${Object.keys(this.#configs).sort().join(", ") || "none"}.`); const existing = this.#clients.get(name); if (existing) return existing; const created = new McpStdioClient({ ...config, name, ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }) }); this.#clients.set(name, created); return created; }
  async index(): Promise<readonly McpToolSummary[]> { await this.load(); const summaries: McpToolSummary[] = []; for (const server of Object.keys(this.#configs).sort()) { const descriptors = await this.allTools(await this.client(server)); summaries.push(...descriptors.map(({ name, description }) => ({ server, name, description }))); } this.#index = summaries; return this.#index; }
  get cachedIndex(): readonly McpToolSummary[] { return this.#index; }
  async describe(server: string, tool: string, signal?: AbortSignal): Promise<McpToolDescriptor> { const client = await this.client(server); try { const descriptors = await this.allTools(client, signal); const found = descriptors.find((candidate) => candidate.name === tool); if (!found) throw new McpError("unknown_tool", `MCP tool ${server}/${tool} is not available.`); return found; } finally { if (client.closed) this.#clients.delete(server); } }
  async call(server: string, tool: string, args: unknown, signal?: AbortSignal): Promise<unknown> { const client = await this.client(server); try { return await client.callTool(tool, args, signal); } finally { if (client.closed) { this.#clients.delete(server); } } }
  async close(): Promise<void> { await Promise.all([...this.#clients.values()].map((client) => client.close())); this.#clients.clear(); }
  private async allTools(client: McpStdioClient, signal?: AbortSignal): Promise<McpToolDescriptor[]> { const output: McpToolDescriptor[] = []; const cursors = new Set<string>(); let cursor: string | undefined; for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) { const page = await client.listTools(cursor, signal); output.push(...page.tools); if (output.length > 10_000) throw new McpError("protocol", "MCP tools/list exceeded 10,000 tools."); const next = page.nextCursor; if (!next) return output; if (cursors.has(next)) throw new McpError("protocol", `MCP tools/list repeated cursor ${next}.`); cursors.add(next); cursor = next; } throw new McpError("protocol", "MCP tools/list exceeded 100 pages."); }
  private validate(name: string, config: unknown): asserts config is McpServerConfig { if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new TypeError(`MCP server name ${name} is invalid.`); if (!config || typeof config !== "object" || typeof (config as { command?: unknown }).command !== "string" || (config as { command: string }).command.trim().length === 0) throw new TypeError(`MCP server ${name} needs a command.`); }
  private async save(): Promise<void> { await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 }); const temporary = `${this.path}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(this.#configs, null, 2)}\n`, { flag: "w", mode: 0o600 }); await rename(temporary, this.path); }
}

export const MCP_DEFINITION: ToolDefinition = Object.freeze({ name: "mcp", description: "Describe one indexed MCP tool or call it with explicit server, tool, and arguments.", inputSchema: Object.freeze({ type: "object", additionalProperties: false, properties: { op: { type: "string", enum: ["describe", "call"], description: "describe returns the tool's full schema; call invokes it." }, server: { type: "string", description: "Server name from the index in this description." }, tool: { type: "string", description: "Tool name on that server." }, args: { description: "Arguments object for the call, shaped by the schema describe returns." } }, required: ["op", "server", "tool"] }) });

const MCP_ALIASES: readonly ToolAlias[] = Object.freeze([{ canonical: "args", aliases: ["arguments"] }]);
/**
 * `arguments` is the MCP wire spelling of `tools/call` params, so models reach for it here
 * too. Accepted and folded — and deliberately *not* advertised (§3.7): a strict emitter
 * fills every declared property, so declaring both spellings taught it to send the same
 * object twice and pay tokens for the privilege.
 */
export function normalizeMcpArgs(input: unknown): unknown | string { return foldToolAliases(input, MCP_ALIASES, "mcp"); }
interface McpArtifactStore { put(content: string | Uint8Array, options?: { mimeType?: string; name?: string }): Promise<string>; }
export class McpGateway implements McpToolLike {
  readonly definition: ToolDefinition;
  constructor(private readonly registry: McpRegistry, private readonly artifactStore?: McpArtifactStore) {
    const index = registry.cachedIndex;
    const available = index.length === 0 ? "No MCP tools are currently registered." : `Available MCP tools:\n${index.map((tool) => `${tool.server}/${tool.name} — ${tool.description}`).join("\n")}`;
    this.definition = Object.freeze({ ...MCP_DEFINITION, description: `${MCP_DEFINITION.description} ${available}` });
  }
  normalize(args: unknown): unknown | string { return normalizeMcpArgs(args); }
  async execute(raw: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const input = normalizeMcpArgs(raw);
      if (typeof input === "string") throw new McpError("invalid_request", input);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new McpError("invalid_request", "mcp requires op, server, and tool.");
      if (!("op" in input) || (input.op !== "describe" && input.op !== "call")) throw new McpError("invalid_request", "mcp op must be describe or call.");
      if (!("server" in input) || typeof input.server !== "string" || !("tool" in input) || typeof input.tool !== "string") throw new McpError("invalid_request", "mcp server and tool must be strings.");
      if (input.op === "describe") return { content: await boundedResult(await this.registry.describe(input.server, input.tool, context.signal), context, this.artifactStore) };
      const args = "args" in input ? input.args : {};
      const result = await this.registry.call(input.server, input.tool, args, context.signal);
      return { content: await boundedResult(result, context, this.artifactStore), ...(result && typeof result === "object" && "isError" in result && result.isError === true ? { isError: true } : {}) };
    } catch (error) { return { content: `MCP call failed: ${error instanceof Error ? error.message : String(error)} Check server/tool names and use mcp describe first.`, isError: true }; }
  }
}

interface McpImagePart { type: "image"; data: string; mimeType?: string }

function isImagePart(value: unknown): value is McpImagePart {
  return value !== null && typeof value === "object" && (value as { type?: unknown }).type === "image"
    && typeof (value as { data?: unknown }).data === "string" && (value as { data: string }).data.length > 0;
}

/**
 * Take image parts out of the JSON and store them as images.
 *
 * An MCP screenshot arrives as base64 inside a `content` array. Serialized whole it is a wall
 * of base64 that no model can see and that blows the 128 KiB cap on its own; spilled with the
 * rest of the JSON it becomes an `application/json` artifact, and reading *that* back gives
 * text, not a picture. Each image therefore becomes its own artifact carrying its real
 * `mimeType`, which is exactly what `read` needs to hand the model an image block. The part
 * left in the JSON names the artifact, so nothing is lost and the model knows what to call.
 */
async function spillImages(value: unknown, store: McpArtifactStore | undefined): Promise<unknown> {
  if (store === undefined || value === null || typeof value !== "object") return value;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content) || !content.some(isImagePart)) return value;
  const parts = await Promise.all(content.map(async (part: unknown) => {
    if (!isImagePart(part)) return part;
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(Buffer.from(part.data, "base64")); } catch { return part; }
    if (bytes.byteLength === 0) return part;
    const mimeType = typeof part.mimeType === "string" && part.mimeType.trim().length > 0 ? part.mimeType.trim() : "image/png";
    const id = await store.put(bytes, { mimeType, name: `mcp-image.${mimeType.split("/")[1] ?? "png"}` });
    return { type: "image", mimeType, bytes: bytes.byteLength, artifact: id, note: `Call read({ path: ${JSON.stringify(id)} }) to see this image.` };
  }));
  return { ...(value as Record<string, unknown>), content: parts };
}

async function boundedResult(value: unknown, context: ToolExecutionContext, fallbackStore?: McpArtifactStore): Promise<string> {
  const contextStore = (context as ToolExecutionContext & { artifactStore?: McpArtifactStore }).artifactStore;
  const store = contextStore ?? fallbackStore;
  const serialized = JSON.stringify(await spillImages(value, store));
  const limit = 128 * 1024;
  if (Buffer.byteLength(serialized) <= limit) return serialized;
  const preview = serialized.slice(0, 16 * 1024);
  if (!store) throw new McpError("output_too_large", "MCP result exceeded 128 KiB and no durable artifact store is configured.");
  return `${preview}\n[truncated MCP result; full content: ${await store.put(serialized, { mimeType: "application/json", name: "mcp-result.json" })}]`;
}

const DRACO_REVISION = "32402e599d043660dccff74b2bf50692da530a0b";
const DRACO_INSTALL_URL = `https://raw.githubusercontent.com/0xchasercat/draco/${DRACO_REVISION}/install.sh`;
const DRACO_INSTALL_SHA256 = "a0058f92ff643a2a56346a2f4365f7fd9d01c68e8d3f5ae6e788e22f0b040831";
const MAX_INSTALLER_BYTES = 64 * 1024;
export class DracoInstaller {
  readonly origin: string;
  readonly statePath: string;
  readonly installUrl: string;
  readonly #expectedSha256: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #run: NonNullable<DracoInstallerOptions["run"]>;
  constructor(options: DracoInstallerOptions) { if (!options || typeof options.origin !== "string" || options.origin.length === 0) throw new TypeError("Draco installer origin is required."); this.origin = resolve(options.origin); this.statePath = join(resolve(options.home ?? this.origin), ".lyra", "draco.json"); this.installUrl = options.installUrl ?? DRACO_INSTALL_URL; this.#expectedSha256 = options.expectedSha256 ?? (options.installUrl === undefined ? DRACO_INSTALL_SHA256 : ""); if (!/^[a-f0-9]{64}$/.test(this.#expectedSha256)) throw new TypeError("A lowercase SHA-256 is required for a custom Draco installer URL."); this.#fetch = options.fetch ?? fetch; this.#run = options.run ?? defaultRun; }
  async shouldOffer(): Promise<boolean> { try { const value = JSON.parse(await readFile(this.statePath, "utf8")) as { offered?: unknown }; return value.offered !== true; } catch (error) { if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return true; throw error; } }
  async recordOffer(choice: "install" | "skip"): Promise<void> { await this.writeState({ offered: true, choice, recordedAt: new Date().toISOString() }); }
  async install(registry: McpRegistry): Promise<{ scriptPath: string; registered: string }> { await this.recordOffer("install"); const response = await this.#fetch(this.installUrl); if (!response.ok) throw new Error(`Draco installer returned HTTP ${response.status}.`); const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.byteLength > MAX_INSTALLER_BYTES) throw new Error("Draco installer exceeded the 64 KiB safety limit."); const actual = createHash("sha256").update(bytes).digest("hex"); if (actual !== this.#expectedSha256) throw new Error(`Draco installer SHA-256 mismatch; expected ${this.#expectedSha256}, received ${actual}.`); const script = new TextDecoder().decode(bytes); const directory = join(this.origin, ".lyra", "install"); await mkdir(directory, { recursive: true, mode: 0o700 }); const scriptPath = join(directory, "draco-install.sh"); await writeFile(scriptPath, script, { mode: 0o700 }); const result = await this.#run(scriptPath, { LYRA_INSTALLER: "lyra" }); if (result.exitCode !== 0) throw new Error(`Draco install failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`); await registry.set("draco", { command: "draco", args: ["mcp"] }); return { scriptPath, registered: "draco" }; }
  private async writeState(state: unknown): Promise<void> { await mkdir(join(this.statePath, ".."), { recursive: true, mode: 0o700 }); const temporary = `${this.statePath}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 }); await rename(temporary, this.statePath); }
}
async function defaultRun(scriptPath: string, env: Readonly<Record<string, string>>): Promise<{ exitCode: number; stdout: string; stderr: string }> { const child = Bun.spawn(["/bin/sh", scriptPath], { env: { HOME: homedir(), PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", SHELL: process.env.SHELL ?? "/bin/sh", TMPDIR: process.env.TMPDIR ?? tmpdir(), ...env }, stdout: "pipe", stderr: "pipe" }); const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); return { exitCode, stdout, stderr }; }
