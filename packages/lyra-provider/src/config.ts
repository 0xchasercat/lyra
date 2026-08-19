import { resolve } from "node:path";
import type { AuthSource, HttpTransportConfig } from "./auth.ts";
import { EnvironmentAuth, NoAuth, StaticAuth } from "./auth.ts";
import { KeychainAuth } from "./credentials.ts";
import type { ProviderApiType } from "./types.ts";
import { isValidAuthPluginId, PluginAuth } from "./plugin-auth.ts";

export type WebSocketPreference = "auto" | "on" | "off";

/**
 * How hard a reasoning model thinks before it answers, in the provider's own vocabulary.
 *
 * Sent as `reasoning.effort` on the Responses API and `reasoning_effort` on Chat Completions.
 * The Anthropic transport has no equivalent knob, so a definition that sets it there is
 * rejected at parse time rather than silently ignored.
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];

export type AuthConfig =
  | { type: "env"; var: string }
  | { type: "none" }
  | { type: "static"; token: string }
  | { type: "keychain"; service: string; account: string }
  | { type: "plugin"; plugin: string };

export interface ProviderDefinition {
  base_url: string;
  api_type: Exclude<ProviderApiType, "openai_websocket">;
  websocket?: WebSocketPreference;
  auth: AuthConfig;
  models?: string[];
  reasoning_effort?: ReasoningEffort;
}

export interface ProviderFileConfig {
  providers: Record<string, ProviderDefinition>;
  roles: Record<string, string>;
}

export interface ResolvedProvider extends HttpTransportConfig {
  apiType: Exclude<ProviderApiType, "openai_websocket">;
  websocket: WebSocketPreference;
  models: string[];
  reasoningEffort?: ReasoningEffort;
}

export async function loadProviderConfig(path?: string | readonly string[]): Promise<ProviderFileConfig> {
  let output = defaultProviderConfig();
  const paths = path === undefined ? [] : typeof path === "string" ? [path] : path;
  for (const candidate of paths) {
    const file = Bun.file(resolve(candidate));
    if (!(await file.exists())) continue;
    let parsed: unknown;
    try { parsed = Bun.TOML.parse(await file.text()); }
    catch (cause) { throw new Error(`Invalid Lyra TOML at ${candidate}: ${messageFrom(cause)}`, { cause }); }
    output = mergeProviderConfig(output, parsed);
  }
  return output;
}

export function defaultProviderConfig(): ProviderFileConfig {
  const providers: Record<string, ProviderDefinition> = {};
  const roles: Record<string, string> = {};

  if (Bun.env.ANTHROPIC_API_KEY !== undefined) {
    providers.anthropic = {
      // Canonical form: `base_url` is the exact prefix routes hang off, version segment
      // included, for every api_type alike (see endpoints.ts).
      base_url: "https://api.anthropic.com/v1",
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

export interface ResolveProviderOptions {
  /** Where auth plugins live. Defaults to `~/.lyra/plugins`; tests point it at a fixture home. */
  pluginRoot?: string;
}

export function resolveProvider(
  name: string,
  definition: ProviderDefinition,
  options: ResolveProviderOptions = {},
): ResolvedProvider {
  validateDefinition(name, definition);
  const auth = authSource(definition.auth, options);
  return {
    id: name,
    baseUrl: definition.base_url,
    apiType: definition.api_type,
    websocket: definition.websocket ?? "auto",
    models: definition.models ?? [],
    ...(definition.reasoning_effort === undefined ? {} : { reasoningEffort: definition.reasoning_effort }),
    ...(definition.api_type === "anthropic_messages"
      ? {
        // An API key goes in `x-api-key`; a plugin returns a *bearer* token by contract, and
        // the subscription endpoints that need a plugin reject it in `x-api-key`. The header
        // follows the credential's kind, not the wire format's default.
        authHeader: definition.auth.type === "plugin" ? "bearer" as const : "x-api-key" as const,
        headers: { "anthropic-version": "2023-06-01" },
      }
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
  const reasoningEffort = value.reasoning_effort;
  if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort)) {
    throw new Error(`Provider ${name} reasoning_effort must be one of ${REASONING_EFFORTS.join(", ")}`);
  }
  return {
    base_url: value.base_url,
    api_type: value.api_type,
    auth,
    ...(websocket === undefined ? {} : { websocket }),
    ...(models === undefined ? {} : { models }),
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
  };
}

function parseAuth(provider: string, value: unknown): AuthConfig {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error(`Provider ${provider} requires auth = { type = "env" | "keychain" | "static" | "none" | "plugin", ... }`);
  }
  if (value.type === "none") return { type: "none" };
  if (value.type === "env" && typeof value.var === "string") return { type: "env", var: value.var };
  if (value.type === "static" && typeof value.token === "string" && value.token.length > 0) return { type: "static", token: value.token };
  if (value.type === "keychain" && typeof value.service === "string" && value.service.length > 0 && typeof value.account === "string" && value.account.length > 0) return { type: "keychain", service: value.service, account: value.account };
  if (value.type === "plugin" && typeof value.plugin === "string") {
    if (!isValidAuthPluginId(value.plugin)) {
      throw new Error(
        `Provider ${provider} auth plugin id ${JSON.stringify(value.plugin)} is invalid. An id is the plugin's directory name under ~/.lyra/plugins: lowercase letters, digits and dashes, starting with a letter. Run \`lyra plugins list\` to see what is installed.`,
      );
    }
    return { type: "plugin", plugin: value.plugin };
  }
  throw new Error(`Provider ${provider} has invalid auth configuration for type ${value.type}`);
}

function authSource(config: AuthConfig, options: ResolveProviderOptions): AuthSource | undefined {
  if (config.type === "env") return new EnvironmentAuth(config.var);
  if (config.type === "static") return new StaticAuth(config.token);
  if (config.type === "keychain") return new KeychainAuth(config);
  if (config.type === "plugin") {
    return options.pluginRoot === undefined ? new PluginAuth(config.plugin) : new PluginAuth(config.plugin, options.pluginRoot);
  }
  return new NoAuth();
}

function validateDefinition(name: string, definition: ProviderDefinition): void {
  if (definition.api_type !== "openai_responses" && definition.websocket === "on") {
    throw new Error(`Provider ${name} enables websocket, but WebSocket mode requires api_type=openai_responses`);
  }
  if (definition.api_type === "anthropic_messages" && definition.reasoning_effort !== undefined) {
    throw new Error(`Provider ${name} sets reasoning_effort, but the Anthropic Messages API has no reasoning effort parameter; it applies to openai_responses and openai_completions only`);
  }
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
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
