import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { loadProviderConfig, storeKeychainCredential, type ProviderApiType } from "@lyra/provider";

export type SetupAuth =
  | { type: "keychain"; token: string; service?: string; account?: string }
  | { type: "env"; variable: string }
  | { type: "static"; token: string }
  | { type: "none" };
export interface ProviderSetupInput {
  provider: string;
  baseUrl: string;
  apiType: Exclude<ProviderApiType, "openai_websocket">;
  model: string;
  fastModel?: string;
  mergeModel?: string;
  websocket?: "auto" | "on" | "off";
  auth: SetupAuth;
}

export interface SetupOption { key: string; label: string; detail: string; }
export interface SetupPrompt { title: string; detail: string; options?: readonly SetupOption[]; defaultValue?: string; secret?: boolean; }
type SetupPhase = "provider" | "provider-id" | "base-url" | "api-type" | "model" | "auth" | "credential" | "complete";


export class ProviderSetupWizard {
  #phase: SetupPhase = "provider";
  #kind: "openai" | "anthropic" | "compatible" | "local" = "openai";
  #provider = "";
  #baseUrl = "";
  #apiType: ProviderSetupInput["apiType"] = "openai_responses";
  #model = "";
  #fastModel: string | undefined;
  #mergeModel: string | undefined;
  #auth: SetupAuth | undefined;
  readonly answers: string[] = [];
  get complete(): boolean { return this.#phase === "complete"; }
  current(): SetupPrompt {
    switch (this.#phase) {
      case "provider": return { title: "Choose a provider", detail: "Use ↑/↓ or a number to highlight one, then press Enter.", options: [
        { key: "1", label: "OpenAI", detail: "Official OpenAI API · Responses" },
        { key: "2", label: "Anthropic", detail: "Official Anthropic API · Messages" },
        { key: "3", label: "OpenAI-compatible", detail: "Gateway or hosted endpoint" },
        { key: "4", label: "Local", detail: "Ollama or another local endpoint · no auth" },
      ] };
      case "provider-id": return { title: "Provider id", detail: "A short name used in model references and config.", defaultValue: this.#kind === "local" ? "local" : "gateway" };
      case "base-url": return { title: "Base URL", detail: "The endpoint Lyra sends requests to, including its API path.", defaultValue: this.#kind === "local" ? "http://localhost:11434/v1" : "https://api.example.com/v1" };
      case "api-type": return { title: "API protocol", detail: "Choose the request format implemented by this endpoint.", options: [
        { key: "1", label: "OpenAI chat completions", detail: "The widely supported /chat/completions format" },
        { key: "2", label: "OpenAI responses", detail: "The newer /responses format" },
      ] };
      case "model": { const defaultValue = this.#kind === "openai" ? "gpt-5.6" : this.#kind === "anthropic" ? "claude-opus-5" : undefined; return { title: "Default model", detail: "The exact model id Lyra will send to this provider.", ...(defaultValue === undefined ? {} : { defaultValue }) }; }
      case "auth": return { title: "Credential source", detail: "Choose where Lyra should read the API credential.", options: [
        { key: "1", label: "OS keychain", detail: "Recommended · token stays outside the config file" },
        { key: "2", label: "Environment variable", detail: "Reference a variable already exported in this shell" },
        { key: "3", label: "providers.toml", detail: "Explicit plaintext · file is protected mode 0600" },
      ] };
      case "credential": return this.#auth?.type === "env" ? { title: "Environment variable", detail: "Type the name of a variable already set in this shell.", defaultValue: `${this.#provider.toUpperCase().replace(/-/g, "_")}_API_KEY` } : { title: "API credential", detail: this.#auth?.type === "static" ? "Stored in ~/.lyra/providers.toml (mode 0600)." : "Stored in the OS keychain; the config stores only a reference.", secret: true };
      case "complete": return { title: "Provider ready", detail: `${this.#provider}/${this.#model} is configured as @default.` };
    }
  }
  progress(): { current: number; total: number } {
    const phases = this.#kind === "local" ? ["provider", "provider-id", "base-url", "model", "complete"] : this.#kind === "compatible" ? ["provider", "provider-id", "base-url", "api-type", "model", "auth", "credential", "complete"] : ["provider", "model", "auth", "credential", "complete"];
    return { current: phases.indexOf(this.#phase) + 1, total: phases.length };
  }
  submit(raw: string): void {
    const value = raw.trim();
    switch (this.#phase) {
      case "provider": {
        if (value === "1") { this.#kind = "openai"; this.#provider = "openai"; this.#baseUrl = "https://api.openai.com/v1"; this.#apiType = "openai_responses"; this.#fastModel = "gpt-5.6-luna"; this.#mergeModel = "gpt-5.6"; this.#phase = "model"; }
        else if (value === "2") { this.#kind = "anthropic"; this.#provider = "anthropic"; this.#baseUrl = "https://api.anthropic.com"; this.#apiType = "anthropic_messages"; this.#fastModel = "claude-haiku-4-5"; this.#mergeModel = "claude-opus-5"; this.#phase = "model"; }
        else if (value === "3" || value === "4") { this.#kind = value === "3" ? "compatible" : "local"; if (this.#kind === "local") this.#apiType = "openai_completions"; this.#phase = "provider-id"; }
        else throw new Error("Choose 1, 2, 3, or 4.");
        this.answers.push(`Provider · ${this.#kind}`); return;
      }
      case "provider-id": { const provider = value || this.current().defaultValue!; if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider)) throw new Error("Provider id must use lowercase letters, digits, and hyphens."); this.#provider = provider; this.answers.push(`Provider id · ${this.#provider}`); this.#phase = "base-url"; return; }
      case "base-url": { const url = value || this.current().defaultValue!; if (!/^https?:\/\//.test(url)) throw new Error("Enter an http(s) base URL."); this.#baseUrl = url; this.answers.push(`Base URL · ${url}`); this.#phase = this.#kind === "local" ? "model" : "api-type"; return; }
      case "api-type": if (value === "1") this.#apiType = "openai_completions"; else if (value === "2") this.#apiType = "openai_responses"; else throw new Error("Choose 1 or 2."); this.answers.push(`Protocol · ${this.#apiType}`); this.#phase = "model"; return;
      case "model": this.#model = value || this.current().defaultValue || ""; if (!this.#model) throw new Error("Model id is required."); this.answers.push(`Model · ${this.#model}`); if (this.#kind === "local") { this.#auth = { type: "none" }; this.#phase = "complete"; } else this.#phase = "auth"; return;
      case "auth": if (value === "1") this.#auth = { type: "keychain", token: "" }; else if (value === "2") this.#auth = { type: "env", variable: "" }; else if (value === "3") this.#auth = { type: "static", token: "" }; else throw new Error("Choose 1, 2, or 3."); this.answers.push(`Credential · ${this.#auth.type}`); this.#phase = "credential"; return;
      case "credential": if (this.#auth?.type === "env") { const variable = value || this.current().defaultValue!; if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new Error("Environment variable name is invalid."); if (!Bun.env[variable]) throw new Error(`${variable} is not set in this process. Export it, then rerun Lyra.`); this.#auth = { type: "env", variable }; } else if (this.#auth?.type === "keychain") { if (!value) throw new Error("API credential is required."); this.#auth = { type: "keychain", token: value }; } else if (this.#auth?.type === "static") { if (!value) throw new Error("API credential is required."); this.#auth = { type: "static", token: value }; } else throw new Error("Credential source is missing."); this.answers.push("Credential value · saved"); this.#phase = "complete"; return;
      case "complete": return;
    }
  }
  result(): ProviderSetupInput {
    if (!this.complete || !this.#auth) throw new Error("Provider setup is not complete.");
    return { provider: this.#provider, baseUrl: this.#baseUrl, apiType: this.#apiType, model: this.#model, ...(this.#fastModel === undefined ? {} : { fastModel: this.#fastModel }), ...(this.#mergeModel === undefined ? {} : { mergeModel: this.#mergeModel }), ...(this.#apiType === "openai_responses" ? { websocket: "auto" as const } : {}), auth: this.#auth };
  }
}
export interface SavedProviderSetup { path: string; provider: string; model: string; auth: SetupAuth["type"]; }

export function providerConfigPaths(origin: string, home = homedir()): string[] {
  return [join(resolve(home), ".lyra", "config.toml"), join(resolve(home), ".lyra", "providers.toml"), join(resolve(origin), ".lyra", "config.toml")];
}
export async function needsProviderSetup(origin: string, model: string | undefined, home = homedir()): Promise<boolean> {
  const config = await loadProviderConfig(providerConfigPaths(origin, home));
  if (Object.keys(config.providers).length === 0) return true;
  if (model !== undefined && !model.startsWith("@")) return false;
  const role = model?.slice(1) ?? "default";
  return config.roles[role] === undefined;
}
export async function saveProviderSetup(input: ProviderSetupInput, options: { home?: string; signal?: AbortSignal; storeKeychain?: typeof storeKeychainCredential } = {}): Promise<SavedProviderSetup> {
  validateSetup(input);
  if (options.signal?.aborted) throw options.signal.reason;
  const home = resolve(options.home ?? homedir());
  const path = join(home, ".lyra", "providers.toml");
  let auth: string;
  if (input.auth.type === "keychain") {
    const service = input.auth.service ?? `dev.lyra.provider.${input.provider}`;
    const account = input.auth.account ?? process.env.USER ?? "lyra";
    await (options.storeKeychain ?? storeKeychainCredential)({ service, account }, input.auth.token, options.signal === undefined ? {} : { signal: options.signal });
    auth = `{ type = "keychain", service = ${toml(service)}, account = ${toml(account)} }`;
  } else if (input.auth.type === "env") {
    auth = `{ type = "env", var = ${toml(input.auth.variable)} }`;
  } else if (input.auth.type === "static") {
    auth = `{ type = "static", token = ${toml(input.auth.token)} }`;
  } else auth = `{ type = "none" }`;
  const model = `${input.provider}/${input.model}`;
  const fast = `${input.provider}/${input.fastModel ?? input.model}`;
  const merge = `${input.provider}/${input.mergeModel ?? input.model}`;
  const content = [
    `# Generated by Lyra provider setup. Manual edits are supported.`,
    `[providers.${input.provider}]`,
    `base_url = ${toml(input.baseUrl)}`,
    `api_type = ${toml(input.apiType)}`,
    ...(input.websocket === undefined ? [] : [`websocket = ${toml(input.websocket)}`]),
    `auth = ${auth}`,
    `models = [${[input.model, input.fastModel, input.mergeModel].filter((value, index, all): value is string => typeof value === "string" && all.indexOf(value) === index).map(toml).join(", ")}]`,
    ``,
    `[roles]`,
    `default = ${toml(model)}`,
    `fast = ${toml(fast)}`,
    `merge = ${toml(merge)}`,
    ``,
  ].join("\n");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  return { path, provider: input.provider, model: input.model, auth: input.auth.type };
}

function validateSetup(input: ProviderSetupInput): void {
  if (!input || !/^[a-z][a-z0-9-]{0,63}$/.test(input.provider)) throw new TypeError("Provider id must be lowercase letters, digits, and hyphens.");
  if (typeof input.baseUrl !== "string" || !/^https?:\/\//.test(input.baseUrl)) throw new TypeError("Provider base URL must be an http(s) URL.");
  if (input.apiType !== "openai_completions" && input.apiType !== "openai_responses" && input.apiType !== "anthropic_messages") throw new TypeError("Provider API type is invalid.");
  if (typeof input.model !== "string" || input.model.length === 0) throw new TypeError("Provider model is required.");
  if (input.auth.type === "keychain" && input.auth.token.length === 0) throw new TypeError("Keychain token is required.");
  if (input.auth.type === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.auth.variable)) throw new TypeError("Environment variable name is invalid.");
  if (input.auth.type === "static" && input.auth.token.length === 0) throw new TypeError("Static token is required.");
}
function toml(value: string): string { return JSON.stringify(value); }
