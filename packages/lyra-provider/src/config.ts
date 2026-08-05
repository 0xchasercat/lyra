import { resolve } from "node:path";
import type { AuthSource, HttpTransportConfig } from "./auth.ts";
import { EnvironmentAuth, NoAuth } from "./auth.ts";
import type { ProviderApiType } from "./types.ts";
import { PluginAuth } from "./plugin-auth.ts";

export type WebSocketPreference = "auto" | "on" | "off";

export type AuthConfig =
  | { type: "env"; var: string }
  | { type: "none" }
  | { type: "plugin"; plugin: string };

export interface ProviderDefinition {
  base_url: string;
  api_type: Exclude<ProviderApiType, "openai_websocket">;
  websocket?: WebSocketPreference;
  auth: AuthConfig;
  models?: string[];
}

export interface ProviderFileConfig {
  providers: Record<string, ProviderDefinition>;
  roles: Record<string, string>;
}

export interface ResolvedProvider extends HttpTransportConfig {
  apiType: Exclude<ProviderApiType, "openai_websocket">;
  websocket: WebSocketPreference;
  models: string[];
}

export async function loadProviderConfig(path?: string): Promise<ProviderFileConfig> {
  const defaults = defaultProviderConfig();
  if (path === undefined) return defaults;
  const file = Bun.file(resolve(path));
  if (!(await file.exists())) return defaults;
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(await file.text());
  } catch (cause) {
    throw new Error(`Invalid Lyra TOML at ${path}: ${messageFrom(cause)}`, { cause });
  }
  return mergeProviderConfig(defaults, parsed);
}

export function defaultProviderConfig(): ProviderFileConfig {
  const providers: Record<string, ProviderDefinition> = {};
  const roles: Record<string, string> = {};

  if (Bun.env.ANTHROPIC_API_KEY !== undefined) {
    providers.anthropic = {
      base_url: "https://api.anthropic.com",
      api_type: "anthropic_messages",
      auth: { type: "env", var: "ANTHROPIC_API_KEY" },
    };
    roles.default = "anthropic/claude-opus-5";
    roles.fast = "anthropic/claude-haiku-4-5";
    roles.merge = "anthropic/claude-opus-5";
  }
  if (Bun.env.OPENAI_API_KEY !== undefined) {
    providers.openai = {
      base_url: "https://api.openai.com/v1",
      api_type: "openai_responses",
      websocket: "auto",
      auth: { type: "env", var: "OPENAI_API_KEY" },
    };
    if (roles.default === undefined) roles.default = "openai/gpt-5.6";
    if (roles.fast === undefined) roles.fast = "openai/gpt-5.6-luna";
    if (roles.merge === undefined) roles.merge = "openai/gpt-5.6";
  }

  return { providers, roles };
}

export function resolveProvider(
  name: string,
  definition: ProviderDefinition,
): ResolvedProvider {
  validateDefinition(name, definition);
  const auth = authSource(definition.auth);
  return {
    id: name,
    baseUrl: definition.base_url,
    apiType: definition.api_type,
    websocket: definition.websocket ?? "auto",
    models: definition.models ?? [],
    ...(definition.api_type === "anthropic_messages"
      ? { authHeader: "x-api-key" as const, headers: { "anthropic-version": "2023-06-01" } }
      : {}),
    ...(auth === undefined ? {} : { auth }),
  };
}

export function resolveModelRole(reference: string, roles: Readonly<Record<string, string>>): string {
  if (!reference.startsWith("@")) return reference;
  const role = reference.slice(1);
  const model = roles[role];
  if (model === undefined) {
    const available = Object.keys(roles).sort().map((name) => `@${name}`).join(", ");
    throw new Error(`Unknown model role @${role}. Available roles: ${available || "none configured"}`);
  }
  return model;
}

function mergeProviderConfig(defaults: ProviderFileConfig, value: unknown): ProviderFileConfig {
  if (!isRecord(value)) throw new Error("Lyra config root must be a TOML table");
  const providers = { ...defaults.providers };
  if (value.providers !== undefined) {
    if (!isRecord(value.providers)) throw new Error("[providers] must be a TOML table");
    for (const [name, raw] of Object.entries(value.providers)) {
      providers[name] = parseDefinition(name, raw);
    }
  }
  const roles = { ...defaults.roles };
  if (value.roles !== undefined) {
    if (!isRecord(value.roles)) throw new Error("[roles] must be a TOML table");
    for (const [role, model] of Object.entries(value.roles)) {
      if (typeof model !== "string" || model.length === 0) {
        throw new Error(`Role ${role} must name a model as provider/model`);
      }
      roles[role] = model;
    }
  }
  return { providers, roles };
}

function parseDefinition(name: string, value: unknown): ProviderDefinition {
  if (!isRecord(value)) throw new Error(`Provider ${name} must be a TOML table`);
  if (typeof value.base_url !== "string") throw new Error(`Provider ${name} requires base_url`);
  if (!isApiType(value.api_type)) {
    throw new Error(
      `Provider ${name} api_type must be openai_completions, openai_responses, or anthropic_messages`,
    );
  }
  const auth = parseAuth(name, value.auth);
  const websocket = value.websocket;
  if (websocket !== undefined && websocket !== "auto" && websocket !== "on" && websocket !== "off") {
    throw new Error(`Provider ${name} websocket must be auto, on, or off`);
  }
  const models = value.models;
  if (models !== undefined && (!Array.isArray(models) || !models.every((model) => typeof model === "string"))) {
    throw new Error(`Provider ${name} models must be an array of model ids`);
  }
  return {
    base_url: value.base_url,
    api_type: value.api_type,
    auth,
    ...(websocket === undefined ? {} : { websocket }),
    ...(models === undefined ? {} : { models }),
  };
}

function parseAuth(provider: string, value: unknown): AuthConfig {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error(`Provider ${provider} requires auth = { type = "env" | "none" | "plugin", ... }`);
  }
  if (value.type === "none") return { type: "none" };
  if (value.type === "env" && typeof value.var === "string") return { type: "env", var: value.var };
  if (value.type === "plugin" && typeof value.plugin === "string") {
    return { type: "plugin", plugin: value.plugin };
  }
  throw new Error(`Provider ${provider} has invalid auth configuration for type ${value.type}`);
}

function authSource(config: AuthConfig): AuthSource | undefined {
  if (config.type === "env") return new EnvironmentAuth(config.var);
  if (config.type === "plugin") return new PluginAuth(config.plugin);
  return new NoAuth();
}

function validateDefinition(name: string, definition: ProviderDefinition): void {
  if (definition.api_type !== "openai_responses" && definition.websocket === "on") {
    throw new Error(`Provider ${name} enables websocket, but WebSocket mode requires api_type=openai_responses`);
  }
}

function isApiType(value: unknown): value is ProviderDefinition["api_type"] {
  return value === "openai_completions"
    || value === "openai_responses"
    || value === "anthropic_messages";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageFrom(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
