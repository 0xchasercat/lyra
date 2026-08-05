import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { McpStdioClient, McpError } from "./client.ts";
import type { McpClientOptions, McpServerConfig, McpToolDescriptor, McpToolSummary, McpGatewayOptions, McpToolLike, DracoInstallerOptions } from "./types.ts";
import type { ToolExecutionContext, ToolExecutionResult } from "@lyra/core";
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
  async describe(server: string, tool: string): Promise<McpToolDescriptor> { const descriptors = await this.allTools(await this.client(server)); const found = descriptors.find((candidate) => candidate.name === tool); if (!found) throw new McpError("unknown_tool", `MCP tool ${server}/${tool} is not available.`); return found; }
  async call(server: string, tool: string, args: unknown): Promise<unknown> { return (await this.client(server)).callTool(tool, args); }
  async close(): Promise<void> { await Promise.all([...this.#clients.values()].map((client) => client.close())); this.#clients.clear(); }
  private async allTools(client: McpStdioClient): Promise<McpToolDescriptor[]> { const output: McpToolDescriptor[] = []; let cursor: string | undefined; do { const page = await client.listTools(cursor); output.push(...page.tools); cursor = page.nextCursor; } while (cursor); return output; }
  private validate(name: string, config: unknown): asserts config is McpServerConfig { if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new TypeError(`MCP server name ${name} is invalid.`); if (!config || typeof config !== "object" || typeof (config as { command?: unknown }).command !== "string" || (config as { command: string }).command.trim().length === 0) throw new TypeError(`MCP server ${name} needs a command.`); }
  private async save(): Promise<void> { await mkdir(join(this.path, ".."), { recursive: true }); const temporary = `${this.path}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(this.#configs, null, 2)}\n`, { flag: "w", mode: 0o600 }); await rename(temporary, this.path); }
}

export const MCP_DEFINITION: ToolDefinition = Object.freeze({ name: "mcp", description: "Describe one indexed MCP tool or call it with explicit server, tool, and arguments.", inputSchema: Object.freeze({ type: "object", additionalProperties: false, properties: { op: { type: "string", enum: ["describe", "call"] }, server: { type: "string" }, tool: { type: "string" }, args: {} }, required: ["op", "server", "tool"] }) });
export class McpGateway implements McpToolLike {
  readonly definition = MCP_DEFINITION;
  constructor(private readonly registry: McpRegistry) {}
  async execute(input: unknown, _context: ToolExecutionContext): Promise<ToolExecutionResult> { try { if (!input || typeof input !== "object" || Array.isArray(input)) throw new McpError("invalid_request", "mcp requires op, server, and tool."); const value = input as Record<string, unknown>; if (value.op !== "describe" && value.op !== "call") throw new McpError("invalid_request", "mcp op must be describe or call."); if (typeof value.server !== "string" || typeof value.tool !== "string") throw new McpError("invalid_request", "mcp server and tool must be strings."); if (value.op === "describe") return { content: JSON.stringify(await this.registry.describe(value.server, value.tool)) }; const result = await this.registry.call(value.server, value.tool, value.args ?? {}); return { content: JSON.stringify(result), ...(result && typeof result === "object" && (result as { isError?: unknown }).isError === true ? { isError: true } : {}) }; } catch (error) { return { content: `MCP call failed: ${error instanceof Error ? error.message : String(error)} Check server/tool names and use mcp describe first.`, isError: true }; } }
}

export class DracoInstaller {
  readonly origin: string;
  readonly statePath: string;
  readonly installUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #run: NonNullable<DracoInstallerOptions["run"]>;
  constructor(options: DracoInstallerOptions) { if (!options || typeof options.origin !== "string" || options.origin.length === 0) throw new TypeError("Draco installer origin is required."); this.origin = resolve(options.origin); this.statePath = join(resolve(options.home ?? this.origin), ".lyra", "draco.json"); this.installUrl = options.installUrl ?? "https://raw.githubusercontent.com/0xchasercat/draco/main/install.sh"; this.#fetch = options.fetch ?? fetch; this.#run = options.run ?? defaultRun; }
  async shouldOffer(): Promise<boolean> { try { const value = JSON.parse(await readFile(this.statePath, "utf8")) as { offered?: unknown }; return value.offered !== true; } catch (error) { if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return true; throw error; } }
  async recordOffer(choice: "install" | "skip"): Promise<void> { await this.writeState({ offered: true, choice, recordedAt: new Date().toISOString() }); }
  async install(registry: McpRegistry): Promise<{ scriptPath: string; registered: string }> { await this.recordOffer("install"); const response = await this.#fetch(this.installUrl); if (!response.ok) throw new Error(`Draco installer returned HTTP ${response.status}.`); const script = await response.text(); if (!script.includes("draco") || script.trim().length < 100) throw new Error("Draco installer did not look like the expected script; refusing to execute it."); const directory = join(this.origin, ".lyra", "install"); await mkdir(directory, { recursive: true }); const scriptPath = join(directory, "draco-install.sh"); await writeFile(scriptPath, script, { mode: 0o700 }); const result = await this.#run(scriptPath, { LYRA_INSTALLER: "lyra" }); if (result.exitCode !== 0) throw new Error(`Draco installation failed: ${result.stderr || result.stdout}`); await registry.set("draco", { command: "draco", args: ["mcp"] }); return { scriptPath, registered: "draco" }; }
  private async writeState(state: unknown): Promise<void> { await mkdir(join(this.statePath, ".."), { recursive: true }); const temporary = `${this.statePath}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 }); await rename(temporary, this.statePath); }
}
async function defaultRun(scriptPath: string, env: Readonly<Record<string, string>>): Promise<{ exitCode: number; stdout: string; stderr: string }> { const child = Bun.spawn(["/bin/sh", scriptPath], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); return { exitCode, stdout, stderr }; }
