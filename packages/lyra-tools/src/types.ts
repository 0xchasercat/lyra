import type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry as CoreToolRegistry,
} from "@lyra/core";
import type { ToolDefinition } from "@lyra/provider";

export type { ToolDefinition, ToolExecutionContext, ToolExecutionResult };

export interface ArtifactStore {
  put(content: string | Uint8Array, options?: { mimeType?: string; name?: string }): Promise<string>;
  read(id: string): Promise<Uint8Array>;
  metadata?(id: string): Promise<{ bytes: number; mimeType: string; name?: string }>;
}

export interface LyraTool {
  readonly definition: ToolDefinition;
  /**
   * Fold schema-declared argument aliases onto their canonical names and refuse fields Lyra
   * deliberately does not implement. Runs before schema validation, so a first call spelled
   * the way another harness trained the model still lands (LYRA.md §3.7). Returns the
   * rewritten arguments, or a sentence explaining the correct call.
   */
  normalize?(args: unknown): unknown | string;
  execute(args: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult>;
  close?(): void | Promise<void>;
}

export interface ToolRuntimeContext extends ToolExecutionContext {
  readonly cwd: string;
  readonly origin: string;
  readonly artifactStore: ArtifactStore;
}

/**
 * Immutable registry for built-in tools. Definitions are copied and deeply frozen at
 * construction so a tool cannot change the provider-facing schema after registration.
 */
export class ToolRegistry implements CoreToolRegistry {
  readonly #tools: ReadonlyMap<string, LyraTool>;
  readonly #definitions: readonly ToolDefinition[];
  readonly #schemas: ReadonlyMap<string, Readonly<Record<string, unknown>>>;

  constructor(tools: readonly LyraTool[]) {
    if (!Array.isArray(tools)) throw new TypeError("Tool registry requires an array of tool implementations.");
    const map = new Map<string, LyraTool>();
    const schemas = new Map<string, Readonly<Record<string, unknown>>>();
    const definitions: ToolDefinition[] = [];
    for (const tool of tools) {
      validateTool(tool);
      const definition = cloneDefinition(tool.definition);
      if (map.has(definition.name)) throw new Error(`Duplicate Lyra tool: ${definition.name}`);
      map.set(definition.name, tool);
      schemas.set(definition.name, definition.inputSchema);
      definitions.push(definition);
    }
    this.#tools = map;
    this.#schemas = schemas;
    this.#definitions = Object.freeze(definitions);
  }

  definitions(): readonly ToolDefinition[] {
    return this.#definitions;
  }

  /** Returns a registered implementation for host integrations without plugin hooks. */
  get(name: string): LyraTool | undefined {
    return typeof name === "string" ? this.#tools.get(name) : undefined;
  }
  async close(): Promise<void> { await Promise.all([...this.#tools.values()].map((tool) => tool.close?.())); }

  async execute(name: string, input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    let tool: LyraTool | undefined;
    try {
      tool = this.#tools.get(name);
    } catch (error) {
      return failedToolResult("unknown", error);
    }
    if (tool === undefined) {
      return {
        content: `Unknown tool ${safeJson(name)}. Use one of: ${[...this.#tools.keys()].join(", ")}.`,
        isError: true,
      };
    }
    const schema = this.#schemas.get(name);
    // Aliases are folded before validation: `additionalProperties: false` would otherwise
    // refuse a first call spelled the way another harness trained the model (§3.7).
    let normalized = input;
    try {
      if (typeof tool.normalize === "function") {
        const result = tool.normalize(input);
        if (typeof result === "string") return { content: `Invalid arguments for ${safeJson(name)}: ${result}`, isError: true };
        normalized = result;
      }
    } catch (error) {
      return { content: `Invalid arguments for ${safeJson(name)}: ${errorMessage(error)} Correct the arguments and retry.`, isError: true };
    }
    let argumentError: string | undefined;
    try {
      argumentError = validateInput(normalized, schema);
    } catch (error) {
      return {
        content: `Invalid arguments for ${safeJson(name)}: ${errorMessage(error)} Correct the arguments and retry.`,
        isError: true,
      };
    }
    if (argumentError !== undefined) {
      return {
        content: `Invalid arguments for ${safeJson(name)}: ${argumentError} Correct the arguments and retry.`,
        isError: true,
      };
    }
    try {
      const contextError = validateContext(context);
      if (contextError !== undefined) {
        return {
          content: `Invalid execution context for ${safeJson(name)}: ${contextError} Retry the tool call from the active session.`,
          isError: true,
        };
      }
    } catch (error) {
      return {
        content: `Invalid execution context for ${safeJson(name)}: ${errorMessage(error)} Retry the tool call from the active session.`,
        isError: true,
      };
    }
    try {
      const result = await tool.execute(normalized, context);
      if (!isToolExecutionResult(result)) {
        return {
          content: `Tool ${safeJson(name)} returned an invalid result. Retry with corrected arguments or report this defect.`,
          isError: true,
        };
      }
      return result;
    } catch (error) {
      return failedToolResult(name, error);
    }
  }
}

function cloneDefinition(definition: ToolDefinition): ToolDefinition {
  let cloned: ToolDefinition;
  try {
    cloned = structuredClone({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    });
  } catch (error) {
    throw new TypeError(`Tool definition ${JSON.stringify(String(definition?.name ?? ""))} is not cloneable: ${errorMessage(error)}.`);
  }
  validateDefinition(cloned);
  deepFreeze(cloned);
  return cloned;
}

function validateTool(tool: unknown): asserts tool is LyraTool {
  if (tool === null || typeof tool !== "object") throw new TypeError("Tool registry entries must be objects with a definition and execute method.");
  const candidate = tool as Partial<LyraTool>;
  validateDefinition(candidate.definition);
  if (typeof candidate.execute !== "function") throw new TypeError(`Tool ${JSON.stringify(candidate.definition.name)} must implement execute(args, context).`);
}

function validateDefinition(definition: unknown): asserts definition is ToolDefinition {
  if (definition === null || typeof definition !== "object") throw new TypeError("Tool definition must be an object.");
  const value = definition as Record<string, unknown>;
  if (typeof value.name !== "string" || value.name.trim().length === 0 || value.name !== value.name.trim()) {
    throw new TypeError("Tool definition name must be a non-empty trimmed string.");
  }
  if (typeof value.description !== "string" || value.description.trim().length === 0) {
    throw new TypeError(`Tool ${JSON.stringify(value.name)} needs a one-sentence description.`);
  }
  validateSchema(value.inputSchema, `Tool ${JSON.stringify(value.name)} inputSchema`);
}

function validateSchema(schema: unknown, label: string): asserts schema is Readonly<Record<string, unknown>> {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) throw new TypeError(`${label} must be a JSON schema object.`);
  const prototype = Object.getPrototypeOf(schema);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must contain plain JSON data.`);
  const value = schema as Record<string, unknown>;
  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (types.length === 0 || types.some((type) => typeof type !== "string" || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(type))) {
      throw new TypeError(`${label}.type must use JSON Schema primitive types.`);
    }
  }
  if (value.properties !== undefined) {
    if (value.properties === null || typeof value.properties !== "object" || Array.isArray(value.properties)) throw new TypeError(`${label}.properties must be an object.`);
    for (const [name, property] of Object.entries(value.properties as Record<string, unknown>)) validateSchema(property, `${label}.properties.${name}`);
  }
  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || value.required.some((name) => typeof name !== "string")) throw new TypeError(`${label}.required must be an array of property names.`);
    if (new Set(value.required).size !== value.required.length) throw new TypeError(`${label}.required must not contain duplicate property names.`);
  }
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") validateSchema(value.additionalProperties, `${label}.additionalProperties`);
  if (value.items !== undefined) validateSchema(value.items, `${label}.items`);
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0)) throw new TypeError(`${label}.enum must be a non-empty array.`);
  for (const keyword of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
    if (value[keyword] !== undefined && (!Number.isInteger(value[keyword]) || (value[keyword] as number) < 0)) throw new TypeError(`${label}.${keyword} must be a non-negative integer.`);
  }
  for (const keyword of ["minimum", "maximum"] as const) {
    if (value[keyword] !== undefined && (typeof value[keyword] !== "number" || !Number.isFinite(value[keyword]))) throw new TypeError(`${label}.${keyword} must be a finite number.`);
  }
  if (typeof value.minItems === "number" && typeof value.maxItems === "number" && value.minItems > value.maxItems) throw new TypeError(`${label}.minItems cannot exceed maxItems.`);
  if (typeof value.minLength === "number" && typeof value.maxLength === "number" && value.minLength > value.maxLength) throw new TypeError(`${label}.minLength cannot exceed maxLength.`);
}

function validateInput(input: unknown, schema: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (schema === undefined) return "the tool has no registered schema.";
  return schemaIssue(input, schema, "$args");
}

/** The documented field list, inlined into errors so the model never has to re-read the schema. */
function fieldList(properties: Record<string, unknown>): string {
  const names = Object.keys(properties);
  return names.length === 0 ? "this tool takes no arguments" : `this tool takes: ${names.join(", ")}`;
}

function schemaIssue(value: unknown, schema: Readonly<Record<string, unknown>>, path: string): string | undefined {
  if (schema.enum !== undefined && Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameJson(candidate, value))) return `${path} must be one of: ${schema.enum.map((candidate) => safeJson(candidate)).join(", ")}.`;
  const expected = schema.type;
  if (expected !== undefined) {
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.some((type) => matchesType(value, type))) return `${path} must be ${allowed.join(" or ")}.`;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} must contain at least ${schema.minLength} characters.`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} must contain at most ${schema.maxLength} characters.`;
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) return `${path} does not match the required pattern.`;
      } catch {
        return `${path} uses an invalid schema pattern.`;
      }
    }
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `${path} must be finite.`;
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} must be at least ${schema.minimum}.`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} must be at most ${schema.maximum}.`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} must contain at least ${schema.minItems} items.`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} must contain at most ${schema.maxItems} items.`;
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const issue = schemaIssue(value[index], schema.items as Readonly<Record<string, unknown>>, `${path}[${index}]`);
        if (issue !== undefined) return issue;
      }
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value) && (expected === undefined || expected === "object" || (Array.isArray(expected) && expected.includes("object")))) {
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties as Record<string, unknown> : {};
    if (Array.isArray(schema.required)) {
      // A missing required field is the highest-frequency first call to get wrong, so the
      // error carries that field's own documentation rather than a bare name (§3.7).
      for (const name of schema.required) if (!(name in value)) {
        const described = properties[name];
        const detail = described !== null && typeof described === "object" && !Array.isArray(described) && typeof (described as Record<string, unknown>).description === "string"
          ? (described as Record<string, string>).description
          : undefined;
        return detail === undefined ? `${path}.${name} is required (${fieldList(properties)}).` : `${path}.${name} is required — ${detail}`;
      }
    }
    for (const [name, propertySchema] of Object.entries(properties)) if (name in value && propertySchema && typeof propertySchema === "object" && !Array.isArray(propertySchema)) {
      const issue = schemaIssue((value as Record<string, unknown>)[name], propertySchema as Readonly<Record<string, unknown>>, `${path}.${name}`);
      if (issue !== undefined) return issue;
    }
    if (schema.additionalProperties === false) for (const name of Object.keys(value)) if (!(name in properties)) return `${path}.${name} is not recognized — ${fieldList(properties)}.`;
  }
  return undefined;
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return Object.is(a, b); }
}

function validateContext(context: unknown): string | undefined {
  if (context === null || typeof context !== "object") return "context must be an object.";
  const value = context as Record<string, unknown>;
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) return "sessionId must be a non-empty string.";
  if (typeof value.workspace !== "string" || value.workspace.length === 0) return "workspace must be a non-empty string.";
  if (typeof value.callId !== "string" || value.callId.length === 0) return "callId must be a non-empty string.";
  const signal = value.signal;
  if (signal === null || typeof signal !== "object" || !("aborted" in signal) || typeof signal.aborted !== "boolean") return "signal must be an AbortSignal-like object.";
  return undefined;
}

function isToolExecutionResult(value: unknown): value is ToolExecutionResult {
  if (value === null || typeof value !== "object" || !("content" in value)) return false;
  return typeof value.content === "string" || Array.isArray(value.content);
}

function failedToolResult(name: string, error: unknown): ToolExecutionResult {
  let partial: unknown;
  let metadata: ToolExecutionResult["metadata"];
  let progress: ToolExecutionResult["progress"];
  try {
    if (error !== null && typeof error === "object") {
      if ("result" in error) partial = error.result;
      else if ("partial" in error) partial = error.partial;
      if ("metadata" in error && error.metadata !== null && typeof error.metadata === "object") metadata = error.metadata as Readonly<Record<string, unknown>>;
      if ("progress" in error && error.progress !== null && typeof error.progress === "object") progress = error.progress as ToolExecutionResult["progress"];
    }
  } catch {
    // Hostile getters must not escape the tool boundary.
  }
  const failure = `Tool ${safeJson(name)} failed in the harness: ${errorMessage(error)} Retry with corrected arguments or report this defect.`;
  if (isToolExecutionResult(partial)) {
    const content = typeof partial.content === "string"
      ? `${partial.content}\n${failure}`
      : [...partial.content, { type: "text" as const, text: failure }];
    return { ...partial, isError: true, content };
  }
  return {
    content: failure,
    isError: true,
    ...(progress === undefined ? {} : { progress }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return encoded ?? String(value);
  } catch {
    return "<unprintable>";
  }
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error && error.message.length > 0 ? error.message : String(error);
  } catch {
    return "an unprintable error was thrown.";
  }
}
