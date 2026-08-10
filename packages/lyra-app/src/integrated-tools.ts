import type { ToolDefinition } from "@lyra/provider";
import type { ToolExecutionContext, ToolExecutionResult } from "@lyra/core";
import { IrcBus, SpawnManager, aliasSchema, foldToolAliases, rejectedField, toolArgs, type SpawnParentContext, type SpawnRequest, type ToolAlias } from "@lyra/core";
import { LspManager } from "@lyra/lsp";
import { RuntimeManager } from "@lyra/runtime";
import { SkillRegistry, SkillTool } from "@lyra/skills";
import { McpGateway } from "@lyra/mcp";
import { ToolRegistry, createDefaultToolRegistry, type DefaultToolRegistryOptions, type LyraTool } from "@lyra/tools";

const LSP_DEFINITION: ToolDefinition = Object.freeze({
  name: "lsp",
  description: "Ask an auto-started language server for semantic navigation, diagnostics, rename, or code actions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      op: { type: "string", enum: ["definition", "references", "hover", "rename", "diagnostics", "codeAction"], description: "Which language-server request to make." },
      language: { type: "string", description: "Language id, inferred from the params uri when omitted." },
      params: { type: "object", description: "Raw LSP request params: { textDocument: { uri: \"file:///abs/path\" }, position: { line, character } } with zero-based line and character, plus newName for rename and range for codeAction." },
    },
    required: ["op", "params"],
  },
});
const SPAWN_DEFINITION: ToolDefinition = Object.freeze({
  name: "spawn",
  description: "Delegate one task to a subagent: prose for an open-ended job, output_schema for a typed workflow, acp to hand it to an external harness.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", minLength: 1, description: "The complete instruction for the child. It sees none of this conversation except what task and context say." },
      context: { type: "string", description: "Background the child needs but that is not itself the instruction." },
      output_schema: { type: "object", description: "JSON schema the child's result must satisfy; supplying it is what makes the child a typed workflow instead of a prose subagent." },
      schema_mode: { type: "string", enum: ["permissive", "strict"], description: "How hard output_schema is enforced. Defaults to permissive." },
      model: { type: "string", description: "Model id for the child; defaults to this session's model." },
      tools: { type: "array", items: { type: "string" }, description: "Tool names the child may use; defaults to every tool this session has." },
      isolated: { type: "boolean", description: "Give the child its own copy-on-write workspace instead of sharing this one." },
      workspace: { type: "string", description: "Name of an existing workspace to run in." },
      blocking: { type: "boolean", description: "true waits for the child's result; omitted or false returns a handle immediately." },
      label: { type: "string", description: "Short name for this child in the UI." },
      depth: { type: "integer", minimum: 0, description: "Delegation depth guard; leave unset and it is tracked for you." },
      acp: { type: "string", minLength: 1, description: "Name of a registered external ACP harness to run the task instead of Lyra." },
      prompt: aliasSchema("task", "string", { minLength: 1 }),
      description: aliasSchema("label", "string"),
      outputSchema: aliasSchema("output_schema", "object"),
      schemaMode: aliasSchema("schema_mode", "string", { enum: ["permissive", "strict"] }),
      run_in_background: { type: "boolean", description: "The inverse of blocking: false waits for the result, true returns a handle." },
    },
    required: ["task"],
    additionalProperties: false,
  },
});
const HUB_DEFINITION: ToolDefinition = Object.freeze({
  name: "hub",
  description: "Talk to other agents: send a direct message, publish to a channel, subscribe, wait with a deadline, or inspect peers and inboxes.",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["send", "publish", "subscribe", "wait", "inbox", "list"], description: "Which bus operation to perform." },
      from: { type: "string", description: "Sender peer name; defaults to this agent." },
      to: { type: "string", description: "Recipient peer name. Required for send." },
      peer: { type: "string", description: "Peer to subscribe, inspect, or wait for; defaults to this agent." },
      channel: { type: "string", description: "Channel name. Required for publish and subscribe; selects a channel wait." },
      message: { type: "string", description: "Message text." },
      data: { description: "Structured payload carried alongside message." },
      timeoutMs: { type: "integer", minimum: 0, description: "Deadline for wait, in milliseconds." },
      await: { type: "boolean", description: "For send and publish: block until a recipient reads the message." },
      text: aliasSchema("message", "string"),
      timeout: aliasSchema("timeoutMs", "integer", { minimum: 0 }),
    },
    required: ["op"],
    additionalProperties: false,
  },
});
const JIT_DEFINITION: ToolDefinition = Object.freeze({
  name: "jit",
  description: "Declare, run, list, or promote a session-scoped resumable TypeScript script that orchestrates work outside this context window.",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["declare", "run", "list", "promote"], description: "declare stores source, run executes it, list enumerates scripts, promote writes one to the workspace." },
      name: { type: "string", description: "Script name, lowercase with dashes. Required for declare, run, and promote." },
      source: { type: "string", description: "TypeScript module source with a default export function (input, { checkpoint }). Required for declare." },
      input: { description: "Value passed to the script's default export by run." },
      code: aliasSchema("source", "string"),
    },
    required: ["op"],
    additionalProperties: false,
  },
});

const SPAWN_ALIASES: readonly ToolAlias[] = Object.freeze([
  { canonical: "task", aliases: ["prompt"] },
  { canonical: "label", aliases: ["description"] },
  { canonical: "output_schema", aliases: ["outputSchema"] },
  { canonical: "schema_mode", aliases: ["schemaMode"] },
]);
const HUB_ALIASES: readonly ToolAlias[] = Object.freeze([
  { canonical: "message", aliases: ["text"] },
  { canonical: "timeoutMs", aliases: ["timeout"] },
]);
const JIT_ALIASES: readonly ToolAlias[] = Object.freeze([{ canonical: "source", aliases: ["code"] }]);

/** Lyra has one delegation primitive, so a named agent type has nothing to select (§7). */
export function normalizeSpawnArgs(input: unknown): unknown | string {
  for (const field of ["subagent_type", "subagentType"]) {
    const lesson = rejectedField(input, field, `${field} is not supported: spawn has one primitive and no agent registry. Put the role in task, narrow the child with tools, and give it output_schema when you need a typed result.`);
    if (lesson !== undefined) return lesson;
  }
  const folded = foldToolAliases(input, SPAWN_ALIASES, "spawn");
  if (typeof folded === "string") return folded;
  const args = toolArgs(folded);
  if (args === undefined) return folded;
  // Schema-complete emitters pad every declared property with junk they cannot
  // omit (observed live: bash job:"?", write tag:"#000000"). A null or blank
  // optional is padding, never intent — and two of spawn's optionals flip its
  // mode entirely (acp reroutes to an external harness, output_schema turns a
  // prose subagent into a typed workflow), so padding must be dropped before it
  // can change what the tool does. An empty output_schema object constrains
  // nothing and is dropped for the same reason.
  const cleaned: Record<string, unknown> = { ...args };
  for (const field of ["context", "model", "workspace", "label", "acp", "schema_mode"]) {
    const value = cleaned[field];
    if (value === null || (typeof value === "string" && value.trim().length === 0)) delete cleaned[field];
  }
  const schema = cleaned.output_schema;
  if (schema === null || (typeof schema === "object" && schema !== null && !Array.isArray(schema) && Object.keys(schema).length === 0)) {
    delete cleaned.output_schema;
  }
  for (const field of ["isolated", "blocking", "depth", "tools", "run_in_background"]) {
    if (cleaned[field] === null) delete cleaned[field];
  }
  if (cleaned.run_in_background === undefined) {
    delete cleaned.run_in_background;
    return cleaned;
  }
  if (typeof cleaned.run_in_background !== "boolean") return "run_in_background must be a boolean; it is the inverse of blocking.";
  const blocking = !cleaned.run_in_background;
  if (cleaned.blocking !== undefined && cleaned.blocking !== blocking) return `spawn received both blocking and run_in_background asking for opposite things; run_in_background: ${cleaned.run_in_background} means blocking: ${blocking}, so send blocking alone.`;
  const output: Record<string, unknown> = { ...cleaned, blocking };
  delete output.run_in_background;
  return output;
}
export function normalizeHubArgs(input: unknown): unknown | string { return foldToolAliases(input, HUB_ALIASES, "hub"); }
export function normalizeJitArgs(input: unknown): unknown | string { return foldToolAliases(input, JIT_ALIASES, "jit"); }

export class LspTool implements LyraTool {
  readonly definition = LSP_DEFINITION;
  constructor(private readonly manager: LspManager, private readonly owned = false) {}
  async execute(input: unknown, _context: ToolExecutionContext): Promise<ToolExecutionResult> { try { const value = objectInput(input, "lsp"); const op = stringField(value, "op"); if (!("params" in value)) throw new Error("lsp requires params."); const language = typeof value.language === "string" ? value.language : undefined; let result: unknown; switch (op) { case "definition": result = await this.manager.definition(value.params, language); break; case "references": result = await this.manager.references(value.params, language); break; case "hover": result = await this.manager.hover(value.params, language); break; case "rename": result = await this.manager.rename(value.params, language); break; case "diagnostics": result = await this.manager.diagnostics(value.params, language); break; case "codeAction": result = await this.manager.codeAction(value.params, language); break; default: throw new Error("lsp op must be definition, references, hover, rename, diagnostics, or codeAction."); } return { content: JSON.stringify(result) }; } catch (error) { return failed("LSP", error); } }
  async close(): Promise<void> { if (this.owned) await this.manager.close(); }
}
export class SpawnTool implements LyraTool {
  readonly definition = SPAWN_DEFINITION;
  constructor(private readonly manager: SpawnManager, private readonly parent?: SpawnParentContext) {}
  normalize(args: unknown): unknown | string { return normalizeSpawnArgs(args); }
  async execute(input: unknown, _context: ToolExecutionContext): Promise<ToolExecutionResult> { try { const normalized = normalizeSpawnArgs(input); if (typeof normalized === "string") return { content: `Invalid spawn arguments: ${normalized}`, isError: true }; const value = objectInput(normalized, "spawn"); const result = this.manager.spawn(spawnRequest(value), this.parent); return { content: JSON.stringify(await Promise.resolve(result)) }; } catch (error) { return failed("Spawn", error); } }
}
export class HubTool implements LyraTool {
  readonly definition = HUB_DEFINITION;
  constructor(private readonly bus: IrcBus, private readonly defaultPeer: string) {}
  normalize(args: unknown): unknown | string { return normalizeHubArgs(args); }
  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const normalized = normalizeHubArgs(input);
      if (typeof normalized === "string") return { content: `Invalid hub arguments: ${normalized}`, isError: true };
      const value = objectInput(normalized, "hub");
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
  normalize(args: unknown): unknown | string { return normalizeJitArgs(args); }
  async execute(input: unknown, _context: ToolExecutionContext): Promise<ToolExecutionResult> { try { const normalized = normalizeJitArgs(input); if (typeof normalized === "string") return { content: `Invalid jit arguments: ${normalized}`, isError: true }; const value = objectInput(normalized, "jit"); const op = stringField(value, "op"); switch (op) { case "declare": return { content: JSON.stringify(await this.runtime.declare(stringField(value, "name"), stringField(value, "source"))) }; case "run": return { content: JSON.stringify(await this.runtime.run(stringField(value, "name"), value.input)) }; case "list": return { content: JSON.stringify(await this.runtime.list()) }; case "promote": return { content: JSON.stringify({ path: await this.runtime.promote(stringField(value, "name")) }) }; default: throw new Error("jit op must be declare, run, list, or promote."); } } catch (error) { return failed("JIT", error); } }
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
