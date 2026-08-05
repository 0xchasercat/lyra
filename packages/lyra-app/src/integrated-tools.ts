import type { ToolDefinition } from "@lyra/provider";
import type { ToolExecutionContext, ToolExecutionResult } from "@lyra/core";
import { IrcBus, SpawnManager, type SpawnParentContext, type SpawnRequest } from "@lyra/core";
import { LspManager } from "@lyra/lsp";
import { RuntimeManager } from "@lyra/runtime";
import { SkillRegistry, SkillTool } from "@lyra/skills";
import { McpGateway } from "@lyra/mcp";
import { ToolRegistry, createDefaultToolRegistry, type DefaultToolRegistryOptions, type LyraTool } from "@lyra/tools";

const LSP_DEFINITION: ToolDefinition = Object.freeze({ name: "lsp", description: "Use an auto-started language server for semantic code navigation, diagnostics, rename, and fixes.", inputSchema: { type: "object", additionalProperties: false, properties: { op: { type: "string", enum: ["definition", "references", "hover", "rename", "diagnostics", "codeAction"] }, language: { type: "string" }, params: { type: "object" } }, required: ["op", "params"] } });
const SPAWN_DEFINITION: ToolDefinition = Object.freeze({ name: "spawn", description: "Delegate one task to a typed or prose subagent in the current or isolated workspace, including external ACP harnesses.", inputSchema: { type: "object", properties: { task: { type: "string", minLength: 1 }, context: { type: "string" }, output_schema: { type: "object" }, schema_mode: { type: "string", enum: ["permissive", "strict"] }, model: { type: "string" }, tools: { type: "array", items: { type: "string" } }, isolated: { type: "boolean" }, workspace: { type: "string" }, blocking: { type: "boolean" }, label: { type: "string" }, depth: { type: "integer", minimum: 0 }, acp: { type: "string", minLength: 1 } }, required: ["task"], additionalProperties: false } });
const HUB_DEFINITION: ToolDefinition = Object.freeze({ name: "hub", description: "Send direct IRC messages, publish channels, wait with a deadline, or inspect named peers and inboxes.", inputSchema: { type: "object", properties: { op: { type: "string", enum: ["send", "publish", "subscribe", "wait", "inbox", "list"] }, from: { type: "string" }, to: { type: "string" }, peer: { type: "string" }, channel: { type: "string" }, message: { type: "string" }, data: {}, timeoutMs: { type: "integer", minimum: 0 }, await: { type: "boolean" } }, required: ["op"], additionalProperties: false } });
const JIT_DEFINITION: ToolDefinition = Object.freeze({ name: "jit", description: "Declare, run, list, or promote a session-scoped resumable TypeScript runtime script.", inputSchema: { type: "object", properties: { op: { type: "string", enum: ["declare", "run", "list", "promote"] }, name: { type: "string" }, source: { type: "string" }, input: {} }, required: ["op"], additionalProperties: false } });

export class LspTool implements LyraTool {
  readonly definition = LSP_DEFINITION;
  constructor(private readonly manager: LspManager, private readonly owned = false) {}
  async execute(input: unknown, _context: ToolExecutionContext): Promise<ToolExecutionResult> { try { const value = objectInput(input, "lsp"); const op = stringField(value, "op"); if (!("params" in value)) throw new Error("lsp requires params."); const language = typeof value.language === "string" ? value.language : undefined; let result: unknown; switch (op) { case "definition": result = await this.manager.definition(value.params, language); break; case "references": result = await this.manager.references(value.params, language); break; case "hover": result = await this.manager.hover(value.params, language); break; case "rename": result = await this.manager.rename(value.params, language); break; case "diagnostics": result = await this.manager.diagnostics(value.params, language); break; case "codeAction": result = await this.manager.codeAction(value.params, language); break; default: throw new Error("lsp op must be definition, references, hover, rename, diagnostics, or codeAction."); } return { content: JSON.stringify(result) }; } catch (error) { return failed("LSP", error); } }
  async close(): Promise<void> { if (this.owned) await this.manager.close(); }
}
export class SpawnTool implements LyraTool {
  readonly definition = SPAWN_DEFINITION;
  constructor(private readonly manager: SpawnManager, private readonly parent?: SpawnParentContext) {}
  async execute(input: unknown, _context: ToolExecutionContext): Promise<ToolExecutionResult> { try { const value = objectInput(input, "spawn"); const result = this.manager.spawn(spawnRequest(value), this.parent); return { content: JSON.stringify(await Promise.resolve(result)) }; } catch (error) { return failed("Spawn", error); } }
}
export class HubTool implements LyraTool {
  readonly definition = HUB_DEFINITION;
  constructor(private readonly bus: IrcBus, private readonly defaultPeer: string) {}
  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const value = objectInput(input, "hub");
      const op = stringField(value, "op");
      const from = typeof value.from === "string" ? value.from : this.defaultPeer;
      switch (op) {
        case "send": return { content: JSON.stringify(await this.bus.send({ from, to: stringField(value, "to"), ...(typeof value.message === "string" ? { text: value.message } : {}), ...(value.data === undefined ? {} : { data: value.data }), ...(value.await === true ? { await: true } : {}) })) };
        case "publish": return { content: JSON.stringify(await this.bus.publish({ from, channel: stringField(value, "channel"), ...(typeof value.message === "string" ? { text: value.message } : {}), ...(value.data === undefined ? {} : { data: value.data }), ...(value.await === true ? { await: true } : {}) })) };
        case "subscribe": return { content: JSON.stringify({ subscribed: this.bus.subscribe(typeof value.peer === "string" ? value.peer : from, stringField(value, "channel")) }) };
        case "wait": {
          const timeout = numberField(value, "timeoutMs");
          const wait = timeout === undefined ? { signal: context.signal } : { timeoutMs: timeout, signal: context.signal };
          const messages = typeof value.channel === "string" ? await this.bus.wait({ channel: value.channel, ...wait }) : await this.bus.wait({ peer: typeof value.peer === "string" ? value.peer : from, ...wait });
          return { content: JSON.stringify(messages) };
        }
        case "inbox": return { content: JSON.stringify(this.bus.inbox(typeof value.peer === "string" ? value.peer : from)) };
        case "list": return { content: JSON.stringify(this.bus.list()) };
        default: throw new Error("hub op is invalid.");
      }
    } catch (error) { return failed("Hub", error); }
  }
}
export class JitTool implements LyraTool {
  readonly definition = JIT_DEFINITION;
  constructor(private readonly runtime: RuntimeManager) {}
  async execute(input: unknown, _context: ToolExecutionContext): Promise<ToolExecutionResult> { try { const value = objectInput(input, "jit"); const op = stringField(value, "op"); switch (op) { case "declare": return { content: JSON.stringify(await this.runtime.declare(stringField(value, "name"), stringField(value, "source"))) }; case "run": return { content: JSON.stringify(await this.runtime.run(stringField(value, "name"), value.input)) }; case "list": return { content: JSON.stringify(await this.runtime.list()) }; case "promote": return { content: JSON.stringify({ path: await this.runtime.promote(stringField(value, "name")) }) }; default: throw new Error("jit op must be declare, run, list, or promote."); } } catch (error) { return failed("JIT", error); } }
}

export const INTEGRATED_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "glob", "lsp", "spawn", "hub", "skill", "jit", "mcp", "git"] as const;
export interface IntegratedToolOptions extends DefaultToolRegistryOptions { lsp: LspManager; ownLsp?: boolean; spawn: SpawnManager; parent?: SpawnParentContext; allowedTools?: readonly string[]; bus: IrcBus; peer: string; skills: SkillRegistry; runtime: RuntimeManager; mcp: McpGateway; }
export function createIntegratedToolRegistry(options: IntegratedToolOptions): ToolRegistry {
  const base = createDefaultToolRegistry(options);
  const builtins: LyraTool[] = base.definitions().map((definition) => {
    const tool = base.get(definition.name);
    if (!tool) throw new Error(`Missing built-in tool ${definition.name}.`);
    return tool;
  });
  const assembled: LyraTool[] = [...builtins.slice(0, 6), new LspTool(options.lsp, options.ownLsp), new SpawnTool(options.spawn, options.parent), new HubTool(options.bus, options.peer), new SkillTool(options.skills), new JitTool(options.runtime), options.mcp, builtins[6]!];
  if (options.allowedTools === undefined) return new ToolRegistry(assembled);
  const allowed = new Set(options.allowedTools);
  const filtered = assembled.filter((tool) => allowed.has(tool.definition.name));
  const missing = options.allowedTools.filter((name) => !filtered.some((tool) => tool.definition.name === name));
  if (missing.length > 0) throw new Error(`Child requested unavailable tools: ${missing.join(", ")}.`);
  return new ToolRegistry(filtered);
}
function objectInput(input: unknown, name: string): Record<string, unknown> { if (!isRecord(input)) throw new Error(`${name} requires an argument object.`); return input; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function spawnRequest(value: Record<string, unknown>): SpawnRequest {
  const request: SpawnRequest = { task: stringField(value, "task") };
  if (value.context !== undefined) request.context = stringField(value, "context");
  if (value.output_schema !== undefined) { if (!isRecord(value.output_schema)) throw new Error("output_schema must be an object."); request.output_schema = value.output_schema; }
  if (value.schema_mode !== undefined) { if (value.schema_mode !== "permissive" && value.schema_mode !== "strict") throw new Error("schema_mode must be permissive or strict."); request.schema_mode = value.schema_mode; }
  if (value.acp !== undefined) request.acp = stringField(value, "acp");
  if (value.model !== undefined) request.model = stringField(value, "model");
  if (value.tools !== undefined) { if (!Array.isArray(value.tools) || !value.tools.every((tool) => typeof tool === "string")) throw new Error("tools must be an array of strings."); request.tools = value.tools;
  }
  for (const name of ["isolated", "blocking"] as const) { if (value[name] !== undefined) { if (typeof value[name] !== "boolean") throw new Error(`${name} must be boolean.`); request[name] = value[name]; } }
  if (value.workspace !== undefined) request.workspace = stringField(value, "workspace");
  if (value.label !== undefined) request.label = stringField(value, "label");
  if (value.depth !== undefined) { if (typeof value.depth !== "number" || !Number.isSafeInteger(value.depth) || value.depth < 0) throw new Error("depth must be a non-negative integer."); request.depth = value.depth; }
  return request;
}
function stringField(value: Record<string, unknown>, name: string): string { const field = value[name]; if (typeof field !== "string" || field.length === 0) throw new Error(`${name} must be a non-empty string.`); return field; }
function numberField(value: Record<string, unknown>, name: string): number | undefined { const field = value[name]; if (field === undefined) return undefined; if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) throw new Error(`${name} must be a non-negative integer.`); return field; }
function failed(label: string, error: unknown): ToolExecutionResult { return { content: `${label} failed: ${error instanceof Error ? error.message : String(error)} Correct the arguments and retry.`, isError: true }; }
