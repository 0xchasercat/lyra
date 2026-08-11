import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  alternateBaseUrl,
  canonicalBaseUrl,
  deleteKeychainCredential,
  discoverModels,
  fetchWithHeadersDeadline,
  loadProviderConfig,
  providerEndpoint,
  resolveProvider,
  storeKeychainCredential,
  supportsOsKeychain,
  type ProviderApiType,
  type ProviderDefinition,
} from "@lyra/provider";
import {
  ACP_DETECT_PROBE_TIMEOUT_MS,
  ACP_VERIFY_TIMEOUT_DEFAULT_MS,
  ACP_VERIFY_TIMEOUT_MAX_MS,
  ACP_VERIFY_TIMEOUT_MIN_MS,
  type AcpAddProviderParams,
  type AcpConfigurableApiType,
  type AcpDetectProviderParams,
  type AcpDetectProviderResult,
  type AcpProviderAuthType,
  type AcpProviderPersist,
  type AcpProviderPreset,
  type AcpProviderSetupOptions,
  type AcpVerifyProviderParams,
  type AcpVerifyProviderResult,
} from "@lyra/acp";
import { chooseFallbackReference } from "./provider.ts";

export type SetupAuth =
  | { type: "keychain"; token: string; service?: string; account?: string }
  | { type: "env"; variable: string }
  | { type: "static"; token: string }
  | { type: "none" }
  /**
   * Edit without touching the credential: the provider's existing `auth` table is carried
   * across byte for byte. It is the only setup that *requires* the provider to already exist,
   * because there is nothing to reuse otherwise — a form whose key field was left empty is
   * saying "leave the key alone", never "this provider has no key".
   */
  | { type: "keep" };
export interface ProviderSetupInput {
  provider: string;
  baseUrl: string;
  apiType: Exclude<ProviderApiType, "openai_websocket">;
  /** Absent per the add-never-switches design: the roles are left untouched and models are chosen later via `/model`. */
  model?: string;
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
        else if (value === "2") { this.#kind = "anthropic"; this.#provider = "anthropic"; this.#baseUrl = "https://api.anthropic.com/v1"; this.#apiType = "anthropic_messages"; this.#fastModel = "claude-haiku-4-5"; this.#mergeModel = "claude-opus-5"; this.#phase = "model"; }
        else if (value === "3" || value === "4") { this.#kind = value === "3" ? "compatible" : "local"; if (this.#kind === "local") this.#apiType = "openai_completions"; this.#phase = "provider-id"; }
        else throw new Error("Choose 1, 2, 3, or 4.");
        this.answers.push(`Provider · ${this.#kind}`); return;
      }
      case "provider-id": { const provider = value || this.current().defaultValue!; if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider)) throw new Error("Provider id must use lowercase letters, digits, and hyphens."); this.#provider = provider; this.answers.push(`Provider id · ${this.#provider}`); this.#phase = "base-url"; return; }
      case "base-url": { const url = canonicalBaseUrl(value || this.current().defaultValue!); if (!/^https?:\/\//.test(url)) throw new Error("Enter an http(s) base URL."); this.#baseUrl = url; this.answers.push(`Base URL · ${url}`); this.#phase = this.#kind === "local" ? "model" : "api-type"; return; }
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
export interface SavedProviderSetup {
  path: string;
  provider: string;
  /** Present only when the setup carried a model; a model-less add leaves roles untouched. */
  model?: string;
  /** The base URL as it was written: canonical form, which is not always what was passed in. */
  baseUrl: string;
  /** The source now backing the provider. For a `keep`, the source it already had. */
  auth: AcpProviderAuthType;
  /** The other providers the file already declared, all of which are still declared. */
  preserved: string[];
  /** What the round trip through the file cost, when it cost anything. */
  warnings?: string[];
}

export function providerConfigPaths(origin: string, home = homedir()): string[] {
  return [join(resolve(home), ".lyra", "config.toml"), join(resolve(home), ".lyra", "providers.toml"), join(resolve(origin), ".lyra", "config.toml")];
}
/**
 * First run with nothing configured, for the modes that have no wizard to offer:
 * `--acp`, `--prompt`, and piped stdin. Interactive `lyra` no longer prints this — it
 * launches the TUI, which drives setup over `provider/setup_options` and `provider/add`
 * against a daemon that boots unconfigured on purpose.
 *
 * The indented block is a literal config file, not prose about one: it is
 * copied verbatim into `providers.toml`, so every key it names must be a key
 * `loadProviderConfig` accepts. A test parses this very text to keep it so.
 */
export function providerSetupText(origin: string, home = homedir()): string {
  const paths = providerConfigPaths(origin, home);
  const globalConfig = paths[0]!;
  const providers = paths[1]!;
  return `Lyra has no provider configured, so there is nothing to start.

Pick one:
  1. Export a key for a provider Lyra knows:
       export OPENAI_API_KEY=...       # or ANTHROPIC_API_KEY=...
  2. Or declare one in ${providers}:
       [providers.openai]
       base_url = "https://api.openai.com/v1"
       api_type = "openai_responses"
       auth = { type = "env", var = "OPENAI_API_KEY" }

       [roles]
       default = "openai/gpt-5.6"

Then run \`lyra\` again. Configuration is read from ${globalConfig}, ${providers}, and <origin>/.lyra/config.toml.
`;
}

export async function needsProviderSetup(origin: string, model: string | undefined, home = homedir()): Promise<boolean> {
  const config = await loadProviderConfig(providerConfigPaths(origin, home));
  if (Object.keys(config.providers).length === 0) return true;
  if (model !== undefined && !model.startsWith("@")) return false;
  const role = model?.slice(1) ?? "default";
  return config.roles[role] === undefined;
}
/**
 * Write a provider into `~/.lyra/providers.toml`, keeping everything already in it.
 *
 * The file is the user's, not this function's: it can hold several providers, roles that
 * point at them, and any other Lyra section. Adding one provider used to render a whole new
 * file from the one definition in hand, so adding a second provider silently deleted the
 * first — including the one the session was running on, which turned a bad new provider into
 * a session with no way back. The existing file is therefore parsed, merged, and re-rendered.
 *
 * What survives is content, not formatting: comments and layout are lost to the round trip,
 * and the caller is told so rather than finding out later. A file that cannot be parsed is
 * never overwritten — the error names it and stops.
 *
 * The base URL is stored **canonically** ([`canonicalBaseUrl`]): the exact prefix Lyra joins
 * routes onto, version segment included. Storing whatever was typed is how a provider ends up
 * detected at one path shape and requested at another, which is a 404 with an empty body and
 * nothing in it to act on.
 *
 * A name that already exists is an **update**, and updates are field-wise: the fields the
 * caller carries replace, and the fields it omits keep whatever the file had — declared
 * models, a websocket preference, anything hand-written the form does not model. `keep` does
 * the same for the credential. An edit form with three rows on it must not be able to delete
 * everything it has no row for.
 */
export async function saveProviderSetup(input: ProviderSetupInput, options: { home?: string; signal?: AbortSignal; storeKeychain?: typeof storeKeychainCredential } = {}): Promise<SavedProviderSetup> {
  validateSetup(input);
  if (options.signal?.aborted) throw options.signal.reason;
  const home = resolve(options.home ?? homedir());
  const path = join(home, ".lyra", "providers.toml");
  const existing = await readProvidersFile(path);
  const declaredProviders = isRecord(existing.value.providers) ? existing.value.providers : {};
  let auth: Record<string, unknown>;
  if (input.auth.type === "keychain") {
    const service = input.auth.service ?? `dev.lyra.provider.${input.provider}`;
    const account = input.auth.account ?? process.env.USER ?? "lyra";
    await (options.storeKeychain ?? storeKeychainCredential)({ service, account }, input.auth.token, options.signal === undefined ? {} : { signal: options.signal });
    auth = { type: "keychain", service, account };
  } else if (input.auth.type === "env") {
    auth = { type: "env", var: input.auth.variable };
  } else if (input.auth.type === "static") {
    auth = { type: "static", token: input.auth.token };
  } else if (input.auth.type === "keep") {
    // The one branch that reads before it writes: the credential is not in hand, it is on
    // disk, and it is carried across untouched rather than re-derived. A provider that is not
    // there has no block to keep, and quietly writing `none` would turn "edit the base URL"
    // into "delete the credential".
    const current = isRecord(declaredProviders[input.provider]) ? declaredProviders[input.provider] as Record<string, unknown> : undefined;
    const block = current?.auth;
    if (!isRecord(block) || typeof block.type !== "string") {
      const names = Object.keys(declaredProviders).sort().join(", ") || "none";
      throw new Error(`Cannot keep the existing credential for "${input.provider}": ${current === undefined ? `${path} does not declare it` : `[providers.${input.provider}] has no auth table`}. ${path} declares: ${names}. Add the provider with a credential source instead of keeping one.`);
    }
    auth = block;
  } else auth = { type: "none" };
  const baseUrl = canonicalBaseUrl(input.baseUrl);
  // An add against a name that already exists is an *update*, and an update is field-wise:
  // what the form carries replaces, what it omits survives. The edit form has rows for the
  // base URL, the protocol and the credential and none for the model list, so building the
  // table from the input alone would silently delete every model the provider declared —
  // including the ones `/model add` was invented to register for endpoints that cannot list
  // their own. A provider is not re-created by being edited.
  const current = isRecord(declaredProviders[input.provider]) ? { ...declaredProviders[input.provider] as Record<string, unknown> } : undefined;
  const existingModels = Array.isArray(current?.models)
    ? (current.models as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const carriedModels = [input.model, input.fastModel, input.mergeModel].filter((value, index, all): value is string => typeof value === "string" && all.indexOf(value) === index);
  const declaredModels = [...existingModels, ...carriedModels.filter((id) => !existingModels.includes(id))];
  const definition: Record<string, unknown> = {
    // Spreading first keeps the file's own field order (an overwritten key keeps its place)
    // and carries anything hand-written that this form does not model.
    ...(current ?? {}),
    base_url: baseUrl,
    api_type: input.apiType,
    ...(input.websocket === undefined ? {} : { websocket: input.websocket }),
    auth,
    ...(declaredModels.length === 0 ? {} : { models: declaredModels }),
  };
  const preserved = Object.keys(declaredProviders).filter((name) => name !== input.provider);
  const providers = { ...declaredProviders, [input.provider]: definition };
  const existingRoles = isRecord(existing.value.roles) ? existing.value.roles : {};
  // Adding never switches: the roles move only when this add carries a model — the
  // legacy question-at-a-time path — and stay exactly as they were otherwise.
  const roles = input.model === undefined
    ? existingRoles
    : {
        ...existingRoles,
        default: `${input.provider}/${input.model}`,
        fast: `${input.provider}/${input.fastModel ?? input.model}`,
        merge: `${input.provider}/${input.mergeModel ?? input.model}`,
      };
  await writeProvidersFile(path, renderProvidersFile(existing.value, providers, roles));
  const warnings = existing.hadComments ? [`Comments in ${path} were not preserved when the provider was added; every provider, role, and setting in it was.`] : [];
  return { path, provider: input.provider, ...(input.model === undefined ? {} : { model: input.model }), baseUrl, auth: authTypeOf(auth), preserved, ...(warnings.length === 0 ? {} : { warnings }) };
}

/** The auth source a rendered block names, for the result. Never its contents. */
function authTypeOf(auth: Record<string, unknown>): AcpProviderAuthType {
  const type = auth.type;
  return type === "keychain" || type === "env" || type === "static" || type === "plugin" ? type : "none";
}

/** What persisting `[roles].default` wrote, and to which file. */
export interface SavedDefaultRole {
  /** The file that was written — the one that already defined `[roles].default`, or the user's. */
  path: string;
  /** The reference now stored, as `provider/model`. */
  model: string;
  /** False when the file already said exactly this and nothing was rewritten. */
  changed: boolean;
  warnings?: string[];
}

/**
 * Persist `[roles].default`, so choosing a model in a session survives the session.
 *
 * The defect this closes was reported as "changing /provider doesn't automatically change the
 * config": every in-session switch was live-only, so the file kept naming whatever was chosen
 * at setup time. Two sessions of drift later the file named a provider that had since been
 * removed, and the next launch walked into it before anything could report it.
 *
 * **Only `default`.** `fast` and `merge` are separate statements about separate jobs, and a
 * user switching the main model has said nothing about either; rewriting all three from one
 * `/model` was the other way to lose a user's configuration.
 *
 * **The file that already defines it.** Lyra reads several files in order and the last one to
 * set `[roles].default` wins, so writing to any earlier one would persist something the next
 * boot cannot see. When no file defines it, the write lands in `~/.lyra/providers.toml` — the
 * file `provider/add` owns. The write itself is the same read-merge-render round trip every
 * other writer here uses: content survives, comments do not, an unparseable file is never
 * overwritten.
 */
export async function saveDefaultRole(
  model: string,
  options: { home?: string; paths?: readonly string[]; origin?: string; signal?: AbortSignal } = {},
): Promise<SavedDefaultRole> {
  if (typeof model !== "string" || model.trim().length === 0) throw new TypeError("A default role must name a model as provider/model.");
  const reference = model.trim();
  if (options.signal?.aborted) throw options.signal.reason;
  const home = resolve(options.home ?? homedir());
  const paths = options.paths ?? providerConfigPaths(options.origin ?? process.cwd(), home);
  const path = await roleDefaultFile(paths) ?? join(home, ".lyra", "providers.toml");
  const existing = await readProvidersFile(path);
  const roles = isRecord(existing.value.roles) ? { ...existing.value.roles } : {};
  if (roles.default === reference) return { path, model: reference, changed: false };
  roles.default = reference;
  const providers = isRecord(existing.value.providers) ? existing.value.providers : {};
  await writeProvidersFile(path, renderProvidersFile(existing.value, providers, roles));
  return {
    path,
    model: reference,
    changed: true,
    ...(existing.hadComments ? { warnings: [`Comments in ${path} were not preserved when [roles].default was updated; every provider, role, and setting in it was.`] } : {}),
  };
}

/**
 * Which configuration file currently defines `[roles].default`, in load order — the *last* one
 * wins, because that is the one `loadProviderConfig` lets win. A file that cannot be read or
 * parsed defines nothing for this purpose: the write it would receive belongs somewhere the
 * next boot will actually read.
 */
async function roleDefaultFile(paths: readonly string[]): Promise<string | undefined> {
  let found: string | undefined;
  for (const candidate of paths) {
    const path = resolve(candidate);
    let parsed: unknown;
    try { parsed = Bun.TOML.parse(await readFile(path, "utf8")); } catch { continue; }
    if (isRecord(parsed) && isRecord(parsed.roles) && typeof parsed.roles.default === "string") found = path;
  }
  return found;
}

/** What `provider/remove` deleted, and what it deliberately did not. */
export interface RemovedProviderSetup {
  path: string;
  provider: string;
  /** The auth table the removed declaration carried, so a caller can offer to clean it up. */
  auth?: Record<string, unknown>;
  /** Roles still naming the removed provider after the write. Left in the file on purpose. */
  danglingRoles: string[];
  /** What `[roles].default` was repointed to, when the removal would have left it dangling. */
  defaultRepointedTo?: string;
  /** Roles deleted outright, because the last provider left with them. */
  rolesCleared?: string[];
  /** The other providers the file declared, all of which are still declared. */
  preserved: string[];
  warnings?: string[];
}

/**
 * Delete one provider from `providers.toml`, and nothing else.
 *
 * The same read-merge-render round trip [`saveProviderSetup`] writes with, run in reverse:
 * the file is parsed, one key leaves the `providers` table, and everything else — the other
 * providers, every role, every unrelated section — is re-rendered exactly as it was. A file
 * that cannot be parsed is never rewritten, because a delete that also loses the providers it
 * was not about is the worst possible outcome of asking for a delete.
 *
 * `[roles].default` is the one role that *is* repaired, and only when repairing it is the
 * lesser surprise. A dangling `default` is not a role that degrades — it is the reference the
 * next boot resolves before anything else, and leaving it pointing at a provider that no longer
 * exists is what turned a removal into a crash on the following launch. So when other providers
 * remain it is repointed at one, deterministically (see [`chooseFallbackReference`]), and the
 * new reference comes back in `defaultRepointedTo` to be said out loud; when the last provider
 * has just left, every role naming it is cleared rather than repointed at nothing.
 *
 * `fast` and `merge` still dangle on purpose. They are used by name, one call at a time, and a
 * dangling one fails that call with a sentence that names the provider and the fix — visibly
 * broken rather than invisibly changed. Their names come back in `danglingRoles`.
 */
export async function removeProviderSetup(
  provider: string,
  options: { home?: string; signal?: AbortSignal } = {},
): Promise<RemovedProviderSetup> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider)) throw new TypeError("Provider id must be lowercase letters, digits, and hyphens.");
  if (options.signal?.aborted) throw options.signal.reason;
  const home = resolve(options.home ?? homedir());
  const path = join(home, ".lyra", "providers.toml");
  const existing = await readProvidersFile(path);
  const declared = isRecord(existing.value.providers) ? existing.value.providers : {};
  if (!Object.hasOwn(declared, provider)) {
    const names = Object.keys(declared).sort().join(", ") || "none";
    throw new Error(`[providers.${provider}] is not declared in ${path}, so there is nothing to remove there. That file declares: ${names}. A provider that came from an environment variable or another config file is removed by unsetting or editing that source.`);
  }
  const current = isRecord(declared[provider]) ? declared[provider] as Record<string, unknown> : undefined;
  const auth = isRecord(current?.auth) ? current.auth : undefined;
  const providers = { ...declared };
  delete providers[provider];
  const roles = isRecord(existing.value.roles) ? { ...existing.value.roles } : {};
  const named = rolesNaming(roles, provider);
  const remaining = Object.keys(providers);
  let defaultRepointedTo: string | undefined;
  let rolesCleared: string[] | undefined;
  if (remaining.length === 0) {
    // Nothing left to point at. A cleared role is a role a fresh setup will write again;
    // a role naming a provider that cannot exist is a boot that fails for no reason.
    for (const role of named) delete roles[role];
    if (named.length > 0) rolesCleared = named;
  } else if (named.includes("default")) {
    defaultRepointedTo = await chooseFallbackReference(
      remaining.map((name) => ({ name, models: declaredModels(providers[name]) })),
      { home },
    );
    if (defaultRepointedTo !== undefined) roles.default = defaultRepointedTo;
  }
  await writeProvidersFile(path, renderProvidersFile(existing.value, providers, roles));
  return {
    path,
    provider,
    ...(auth === undefined ? {} : { auth }),
    // What the file says *after* the write: a repointed default is not dangling any more.
    danglingRoles: rolesNaming(roles, provider),
    ...(defaultRepointedTo === undefined ? {} : { defaultRepointedTo }),
    ...(rolesCleared === undefined ? {} : { rolesCleared }),
    preserved: remaining,
    ...(existing.hadComments ? { warnings: [`Comments in ${path} were not preserved when the provider was removed; every remaining provider, role, and setting in it was.`] } : {}),
  };
}

/** Every role whose model reference is served by one named provider, sorted. */
function rolesNaming(roles: Record<string, unknown>, provider: string): string[] {
  return Object.entries(roles)
    .filter(([, value]) => typeof value === "string" && value.slice(0, value.indexOf("/")) === provider)
    .map(([role]) => role)
    .sort();
}

/** The `models` array a raw provider table declares, and nothing else it happens to contain. */
function declaredModels(table: unknown): string[] {
  const models = isRecord(table) ? table.models : undefined;
  return Array.isArray(models) ? models.filter((value): value is string => typeof value === "string") : [];
}

/**
 * Delete a removed provider's OS-keychain entry, when the caller asked for that too.
 *
 * Only a keychain entry: an environment variable and a plaintext token belong to the user and
 * to the file respectively, and the file's copy left with the declaration it lived in. An
 * entry that was not there answers `false` rather than failing — the requested end state was
 * reached — and a keychain that refused throws, because that one really did not happen.
 */
export async function removeProviderCredential(
  auth: Record<string, unknown> | undefined,
  options: { deleteKeychain?: typeof deleteKeychainCredential; signal?: AbortSignal } = {},
): Promise<boolean> {
  if (!isRecord(auth) || auth.type !== "keychain") return false;
  const service = auth.service;
  const account = auth.account;
  if (typeof service !== "string" || service.length === 0 || typeof account !== "string" || account.length === 0) return false;
  return await (options.deleteKeychain ?? deleteKeychainCredential)({ service, account }, options.signal === undefined ? {} : { signal: options.signal });
}

/** What `model/add` wrote, and whether it had anything to write. */
export interface SavedProviderModel {
  path: string;
  provider: string;
  model: string;
  /** The provider's declared models after the write, in file order. */
  models: string[];
  /** False when the id was already declared: adding it twice is idempotent, not accumulative. */
  added: boolean;
}

/**
 * Declare one more model for an already-configured provider.
 *
 * Endpoints that cannot list their own models are ordinary — a gateway with no `/models`
 * route, a hosted deployment that exposes one id it does not advertise — and until now the
 * only way to name a model for one was to hand-edit TOML. This is that edit, through the same
 * non-destructive merge [`saveProviderSetup`] uses: the file is parsed, the one `models` array
 * is extended, and everything else in it is re-rendered untouched. Comments do not survive the
 * round trip; content always does, and an unparseable file is never overwritten.
 *
 * `definition` is the provider as the *live configuration* knows it, and is used only when the
 * file does not declare that provider at all — a provider that came from an exported
 * `OPENAI_API_KEY`, or from a config file other than this one. Materialising it is what makes
 * `/model add` work for those rather than failing on a technicality; when the file already has
 * the provider, nothing but its `models` array is touched.
 */
export async function saveProviderModel(
  provider: string,
  model: string,
  definition: ProviderDefinition,
  options: { home?: string; signal?: AbortSignal } = {},
): Promise<SavedProviderModel> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider)) throw new TypeError("Provider id must be lowercase letters, digits, and hyphens.");
  if (typeof model !== "string" || model.trim().length === 0) throw new TypeError("Model id is required.");
  const id = model.trim();
  if (options.signal?.aborted) throw options.signal.reason;
  const home = resolve(options.home ?? homedir());
  const path = join(home, ".lyra", "providers.toml");
  const existing = await readProvidersFile(path);
  const declared = isRecord(existing.value.providers) ? existing.value.providers : {};
  const current = isRecord(declared[provider]) ? { ...declared[provider] as Record<string, unknown> } : materialize(definition);
  const models = Array.isArray(current.models) ? current.models.filter((entry): entry is string => typeof entry === "string") : [];
  const added = !models.includes(id);
  current.models = added ? [...models, id] : models;
  const providers = { ...declared, [provider]: current };
  const roles = isRecord(existing.value.roles) ? existing.value.roles as Record<string, string> : {};
  await writeProvidersFile(path, renderProvidersFile(existing.value, providers, roles));
  return { path, provider, model: id, models: current.models as string[], added };
}

/** A live provider definition as the TOML table that would have produced it. */
function materialize(definition: ProviderDefinition): Record<string, unknown> {
  return {
    base_url: definition.base_url,
    api_type: definition.api_type,
    ...(definition.websocket === undefined ? {} : { websocket: definition.websocket }),
    auth: { ...definition.auth },
    models: [...(definition.models ?? [])],
  };
}

/** Replace the file atomically, and never through a path something else already holds. */
async function writeProvidersFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

/** The current `providers.toml` as data. A file that cannot be parsed stops the write. */
async function readProvidersFile(path: string): Promise<{ value: Record<string, unknown>; hadComments: boolean }> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return { value: {}, hadComments: false };
    throw error;
  }
  let parsed: unknown;
  try { parsed = Bun.TOML.parse(raw); }
  catch (cause) {
    throw new Error(`${path} is not valid TOML, so Lyra will not rewrite it and risk losing what is in it: ${cause instanceof Error ? cause.message : String(cause)}. Fix the file, then add the provider again.`, { cause });
  }
  if (!isRecord(parsed)) throw new Error(`${path} must be a TOML table. Fix the file, then add the provider again.`);
  return { value: parsed, hadComments: /^\s*#/m.test(raw) };
}

/**
 * The merged file, rendered. Order is deterministic — scalars, providers, roles, then any
 * other section the file had — so re-adding the same provider twice produces the same bytes.
 */
function renderProvidersFile(existing: Record<string, unknown>, providers: Record<string, unknown>, roleTable: Record<string, unknown>): string {
  const others = Object.entries(existing).filter(([key]) => key !== "providers" && key !== "roles");
  const lines: string[] = [`# Generated by Lyra provider setup. Manual edits are supported.`];
  for (const [key, value] of others) if (!isRecord(value)) lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
  for (const [provider, value] of Object.entries(providers)) {
    if (!isRecord(value)) throw new TypeError(`[providers.${provider}] must be a table.`);
    lines.push(``, `[providers.${tomlKey(provider)}]`, ...Object.entries(value).map(([field, entry]) => `${tomlKey(field)} = ${tomlValue(entry)}`));
  }
  lines.push(``, `[roles]`, ...Object.entries(roleTable).map(([role, value]) => `${tomlKey(role)} = ${tomlValue(value)}`));
  for (const [key, value] of others) {
    if (!isRecord(value)) continue;
    lines.push(``, `[${tomlKey(key)}]`, ...Object.entries(value).map(([field, entry]) => `${tomlKey(field)} = ${tomlValue(entry)}`));
  }
  lines.push(``);
  return lines.join("\n");
}

function tomlKey(key: string): string { return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key); }
function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (isRecord(value)) return `{ ${Object.entries(value).map(([key, entry]) => `${tomlKey(key)} = ${tomlValue(entry)}`).join(", ")} }`;
  throw new TypeError(`A Lyra TOML value must be a string, number, boolean, array, or table; got ${value === null ? "null" : typeof value}.`);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

// ---------------------------------------------------------------------------
// The ACP provider-setup surface (`provider/setup_options`, `verify`, `add`)
// ---------------------------------------------------------------------------

/**
 * The presets the wizard offers, as data.
 *
 * Same four choices `ProviderSetupWizard` has always modelled — the non-interactive
 * question-at-a-time driver above — restated as a catalog a client can render in one
 * screen. Both feed `saveProviderSetup`, so a provider added through the TUI and one added
 * through the wizard are byte-identical on disk.
 *
 * `authEnvVar` is a variable **name**. Nothing in this catalog ever carries a credential,
 * which is what makes `provider/setup_options` safe to answer before anything is configured.
 */
const PROVIDER_PRESETS: readonly AcpProviderPreset[] = Object.freeze([
  Object.freeze({ id: "openai", label: "OpenAI", detail: "Official API · responses protocol", provider: "openai", baseUrl: "https://api.openai.com/v1", apiType: "openai_responses" as const, model: "gpt-5.6", fastModel: "gpt-5.6-luna", mergeModel: "gpt-5.6", websocket: "auto" as const, authEnvVar: "OPENAI_API_KEY", needsKey: true, custom: false }),
  Object.freeze({ id: "anthropic", label: "Anthropic", detail: "Official API · messages protocol", provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiType: "anthropic_messages" as const, model: "claude-opus-5", fastModel: "claude-haiku-4-5", mergeModel: "claude-opus-5", authEnvVar: "ANTHROPIC_API_KEY", needsKey: true, custom: false }),
  Object.freeze({ id: "compatible", label: "OpenAI-compatible", detail: "A gateway or hosted endpoint that speaks the OpenAI API", provider: "gateway", baseUrl: "https://api.example.com/v1", apiType: "openai_completions" as const, needsKey: true, custom: true }),
  Object.freeze({ id: "local", label: "Local", detail: "Ollama or another local endpoint · no credential", provider: "local", baseUrl: "http://localhost:11434/v1", apiType: "openai_completions" as const, model: "qwen2.5-coder:14b", needsKey: false, custom: false }),
]) as readonly AcpProviderPreset[];

/** The persistence choices, and why a machine might not be able to offer one. */
function persistOptions(platform: NodeJS.Platform): AcpProviderSetupOptions["persist"] {
  const keychain = supportsOsKeychain(platform);
  return [
    { id: "keychain", label: "OS keychain", detail: keychain ? "Recommended · the token never enters a file" : "Unavailable here · install secret-tool, or choose another source", available: keychain },
    { id: "env", label: "Environment variable", detail: "Reference a variable this process already exports", available: true },
    { id: "plaintext", label: "providers.toml", detail: "The token is written into the config file (mode 0600)", available: true },
    { id: "none", label: "No credential", detail: "A local endpoint that authenticates nothing", available: true },
  ];
}

const API_TYPE_OPTIONS: AcpProviderSetupOptions["apiTypes"] = Object.freeze([
  Object.freeze({ id: "openai_responses" as const, label: "OpenAI responses", detail: "The newer /responses format" }),
  Object.freeze({ id: "openai_completions" as const, label: "OpenAI chat completions", detail: "The widely supported /chat/completions format" }),
  Object.freeze({ id: "anthropic_messages" as const, label: "Anthropic messages", detail: "The /v1/messages format" }),
]);

/**
 * `provider/setup_options`: the wizard's catalog, resolved against *this* machine.
 *
 * Two facts are measured rather than assumed — whether a preset's conventional environment
 * variable is already exported, and whether the OS keychain can actually store anything —
 * because a wizard that offers a choice the machine cannot honour fails at the last step,
 * which is the worst place to find out.
 */
export async function providerSetupOptions(
  origin: string,
  options: { home?: string; env?: Record<string, string | undefined>; platform?: NodeJS.Platform } = {},
): Promise<AcpProviderSetupOptions> {
  const home = options.home ?? homedir();
  const environment = options.env ?? (Bun.env as Record<string, string | undefined>);
  const config = await loadProviderConfig(providerConfigPaths(origin, home));
  const configured = Object.keys(config.providers).sort();
  const presets = PROVIDER_PRESETS.map((preset) => ({
    ...preset,
    // A *name* is tested for presence; the value is never read into this answer.
    ...(preset.authEnvVar === undefined ? {} : { envVarSet: (environment[preset.authEnvVar] ?? "").length > 0 }),
    ...(preset.provider !== undefined && configured.includes(preset.provider) ? { configured: true } : {}),
  }));
  return { presets, persist: persistOptions(options.platform ?? process.platform), apiTypes: API_TYPE_OPTIONS, path: providerConfigPaths(origin, home)[1]!, configured };
}

/**
 * `provider/add` parameters, turned into the input `saveProviderSetup` already validates.
 *
 * The credential-shaped rules live here rather than in the caller because they are about the
 * *pairing*: a persistence choice that needs a token and did not get one, or got one it has
 * nowhere to put, is a request that cannot be honoured — and answering it by quietly dropping
 * the token would leave a provider configured with no way to authenticate.
 */
export function providerAddInput(params: AcpAddProviderParams, options: { env?: Record<string, string | undefined>; platform?: NodeJS.Platform } = {}): { input: ProviderSetupInput; warnings: string[] } {
  if (!params || typeof params !== "object") throw new TypeError("provider/add requires parameters.");
  const environment = options.env ?? (Bun.env as Record<string, string | undefined>);
  const warnings: string[] = [];
  const persist: AcpProviderPersist = params.persist;
  let auth: SetupAuth;
  if (persist === "keychain" || persist === "plaintext") {
    if (typeof params.apiKey !== "string" || params.apiKey.length === 0) throw new Error(`provider/add with persist "${persist}" requires apiKey.`);
    if (persist === "keychain") {
      if (!supportsOsKeychain(options.platform ?? process.platform)) throw new Error("This machine has no OS keychain Lyra can write to. Choose the environment variable or providers.toml source instead.");
      auth = { type: "keychain", token: params.apiKey };
    } else {
      auth = { type: "static", token: params.apiKey };
      warnings.push("The credential is stored in providers.toml as plaintext, protected only by file mode 0600.");
    }
  } else if (persist === "env") {
    if (typeof params.authEnvVar !== "string" || params.authEnvVar.length === 0) throw new Error('provider/add with persist "env" requires authEnvVar.');
    if (params.apiKey !== undefined) throw new Error('provider/add with persist "env" must not carry an apiKey: the variable is the credential source, and Lyra has nowhere to put a second one.');
    if ((environment[params.authEnvVar] ?? "").length === 0) warnings.push(`${params.authEnvVar} is not set in this process. Export it and restart Lyra, or the provider will fail to authenticate.`);
    auth = { type: "env", variable: params.authEnvVar };
  } else if (persist === "none") {
    if (params.apiKey !== undefined) throw new Error('provider/add with persist "none" must not carry an apiKey.');
    auth = { type: "none" };
  } else if (persist === "keep") {
    // The edit case. Both rejections below are about the same mistake — sending a credential
    // alongside "do not touch the credential" — and answering it by silently preferring one
    // over the other would make which of them won depend on reading this function.
    if (params.apiKey !== undefined) throw new Error('provider/add with persist "keep" must not carry an apiKey: "keep" means the stored credential is reused unchanged. Send persist "keychain" or "plaintext" to rotate it.');
    if (params.authEnvVar !== undefined) throw new Error('provider/add with persist "keep" must not carry an authEnvVar: "keep" reuses the provider\'s existing credential source. Send persist "env" to change it.');
    auth = { type: "keep" };
  } else throw new TypeError(`provider/add persist must be keychain, plaintext, env, none, or keep; got ${JSON.stringify(persist)}.`);

  const input: ProviderSetupInput = {
    provider: String(params.provider ?? ""),
    baseUrl: String(params.baseUrl ?? ""),
    apiType: params.apiType as ProviderSetupInput["apiType"],
    ...(typeof params.model === "string" && params.model.length > 0 ? { model: params.model } : {}),
    ...(params.fastModel === undefined ? {} : { fastModel: params.fastModel }),
    ...(params.mergeModel === undefined ? {} : { mergeModel: params.mergeModel }),
    ...(params.websocket === undefined ? {} : { websocket: params.websocket }),
    auth,
  };
  return { input, warnings };
}

/**
 * `provider/verify`: one cheap liveness check against an endpoint that is not saved yet.
 *
 * It is the `/models` fetch the model picker already uses (`discoverModels`), pointed at an
 * in-memory definition instead of a configured one, so "reachable" here means exactly what
 * "reachable" means everywhere else in Lyra. Two properties matter and are enforced here:
 *
 * - **Bounded.** The deadline is a real abort, not just a headers timeout, so a server that
 *   accepts a connection and then says nothing costs `timeoutMs` and not a wedged wizard.
 * - **Not fatal.** Anything that goes wrong becomes `{ok:false, error}`; the wizard's next
 *   move is to fix a typo or save anyway, and neither is helped by a JSON-RPC failure.
 *
 * The credential is used and dropped: it is never written, never cached, and never named in
 * the result. The models cache lands under a `_verify` directory so an endpoint that was
 * probed and then rejected leaves nothing behind in a real provider's cache.
 */
export async function verifyProviderSetup(
  params: AcpVerifyProviderParams,
  options: { origin?: string; signal?: AbortSignal } = {},
): Promise<AcpVerifyProviderResult> {
  if (!params || typeof params !== "object") throw new TypeError("provider/verify requires parameters.");
  const timeoutMs = Math.min(Math.max(params.timeoutMs ?? ACP_VERIFY_TIMEOUT_DEFAULT_MS, ACP_VERIFY_TIMEOUT_MIN_MS), ACP_VERIFY_TIMEOUT_MAX_MS);
  const definition: ProviderDefinition = {
    base_url: params.baseUrl,
    api_type: params.apiType as ProviderDefinition["api_type"],
    auth: typeof params.apiKey === "string" && params.apiKey.length > 0
      ? { type: "static", token: params.apiKey }
      : typeof params.authEnvVar === "string" && params.authEnvVar.length > 0
        ? { type: "env", var: params.authEnvVar }
        : { type: "none" },
  };
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
  try {
    const resolved = resolveProvider(verifyId(params.provider), definition);
    const models = await discoverModels(resolved, {
      force: true,
      signal,
      headersTimeoutMs: timeoutMs,
      cacheDirectory: join(resolve(options.origin ?? process.cwd()), ".lyra", "providers", "_verify"),
    });
    return { ok: true, models: models.length, sample: models.slice(0, 3).map((model) => model.id) };
  } catch (error) {
    return { ok: false, error: verifyError(error, deadline.aborted, timeoutMs) };
  }
}

// ---------------------------------------------------------------------------
// `provider/detect` — what does this endpoint speak?
// ---------------------------------------------------------------------------

/** The API family a body identifies, independent of which probe collected it. */
type ApiFamily = "openai" | "anthropic";

/** One probe's outcome. `undefined` for a request that never produced a response at all. */
interface ProbeOutcome { status: number; body: unknown }

/** Everything one candidate base URL answered, so a shape can be chosen on evidence. */
interface BaseProbes {
  base: string;
  openai: ProbeOutcome | undefined;
  anthropic: ProbeOutcome | undefined;
  responses: ProbeOutcome | undefined;
  /**
   * The same POST, sent to a route that certainly does not exist.
   *
   * This is the control the `/responses` probe is read against. An endpoint that has the route
   * answers the two differently; a proxy that hands every unknown path to one generic handler
   * answers them the same, which is the whole reason a generic 400 could ever have been read
   * as "Responses is available".
   */
  control: ProbeOutcome | undefined;
}

/**
 * A route no deployment implements, used to learn what "not here" looks like at this endpoint.
 * Deliberately unlovely and fixed: it must never collide with a real route, and it must be the
 * same string every time so the answer is reproducible.
 */
const DETECT_CONTROL_PATH = "lyra_detect_no_such_route";

/**
 * Parameters only the Responses API has. `model`, `temperature`, `tools` and friends are
 * shared with Chat Completions, so a complaint about one of those says nothing about which
 * protocol answered — these are the words that do.
 */
const RESPONSES_ONLY_PARAMETERS: readonly string[] = [
  "input",
  "instructions",
  "previous_response_id",
  "max_output_tokens",
  "include",
  "store",
  "reasoning",
  "truncation",
  "conversation",
];

/**
 * `provider/detect`: ask a URL what it speaks, before anything is saved.
 *
 * The setup form used to make the user answer this. They cannot: "openai_responses" versus
 * "openai_completions" is a property of the deployment, not of the vendor, and the most common
 * way to end up with a provider that saves cleanly and fails on the first prompt was picking
 * the wrong one. The endpoint knows, so the endpoint is asked.
 *
 * Three probes run concurrently against each candidate base, each with its own deadline, so
 * the whole call costs one deadline rather than six:
 *
 * - `GET {base}/models` with a Bearer credential. An OpenAI-shaped list (`{object:"list",
 *   data:[…]}`) identifies the OpenAI family.
 * - `GET {base}/models` with `x-api-key` and `anthropic-version`. An Anthropic-shaped list
 *   (`data:[{type:"model"…}]`) identifies the Messages API.
 * - `POST {base}/responses` with a body that is deliberately invalid. 404 or 405 means the
 *   route is not there and the family is completions-only; a validation-class status (400,
 *   413, 422) or a 200 means Responses is available.
 *
 * The **candidates** are the base exactly as typed and the base one version segment away from
 * it — `/v1` added when it is absent, removed when it is present. Which of the two answers is
 * a property of the deployment that no user can be expected to know, and it is precisely the
 * gap this method used to leave open: it probed one shape, the transport requested another,
 * and the difference surfaced as a 404 on the first prompt rather than in the form. The shape
 * that answered comes back as `normalizedBaseUrl`, and the exact one wins when both do.
 *
 * What it deliberately does **not** do:
 *
 * - **Guess from a 401.** A refusal identifies the family only when the error envelope is
 *   recognisable — Anthropic's `{type:"error",…}` or OpenAI's `{error:{…}}` — and then it sets
 *   `authRequired` rather than claiming the probe succeeded.
 * - **Answer the Responses question without evidence.** A `/responses` probe that is refused
 *   (401) rather than validated tells us nothing, so the answer falls back to completions: the
 *   protocol that is always there when the OpenAI family is. Re-detecting with a credential is
 *   what upgrades it. This is the honest limit of probing an authenticating endpoint anonymously.
 * - **Report both OpenAI protocols.** Only `/responses` was probed, so only one of the two was
 *   genuinely established; reporting both would present an inference as a measurement.
 * - **Persist anything.** No cache file, no config write, and the credential is used for the
 *   probes and dropped. Detection is answerable before any provider exists, which is exactly
 *   when the setup form needs it.
 *
 * An endpoint that cannot be reached is an answer (`apiTypes: []`), never a thrown error: a
 * typo in a base URL is a form to correct, and a JSON-RPC failure would make it look like the
 * daemon broke.
 */
export async function detectProviderApis(
  params: AcpDetectProviderParams,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AcpDetectProviderResult> {
  if (!params || typeof params !== "object") throw new TypeError("provider/detect requires parameters.");
  if (typeof params.baseUrl !== "string" || params.baseUrl.length === 0) throw new TypeError("provider/detect requires baseUrl.");
  // Canonical first, so every pasteable shape probes as the same endpoint: `localhost:4100`
  // gains its scheme (and would otherwise parse as a URL whose *scheme* is `localhost`),
  // a copied full route is cut back to its prefix, a bare origin gains `/v1`.
  const canonical = canonicalBaseUrl(params.baseUrl);
  let url: URL;
  try { url = new URL(canonical); }
  catch { return { apiTypes: [] }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { apiTypes: [] };
  const suggested = suggestProviderName(canonical);
  const named = suggested === undefined ? {} : { suggestedName: suggested };

  const base = canonical;
  const key = typeof params.apiKey === "string" && params.apiKey.length > 0 ? params.apiKey : undefined;
  const timeoutMs = options.timeoutMs ?? ACP_DETECT_PROBE_TIMEOUT_MS;
  const alternate = alternateBaseUrl(base);
  const candidates = alternate === base ? [base] : [base, alternate];

  const postProbe = { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...(key === undefined ? {} : { authorization: `Bearer ${key}` }) }, body: "{}" } satisfies RequestInit;
  const probed: BaseProbes[] = await Promise.all(candidates.map(async (candidate) => {
    const [openai, anthropic, responses, control] = await Promise.all([
      probe(providerEndpoint(candidate, "models"), { method: "GET", headers: { accept: "application/json", ...(key === undefined ? {} : { authorization: `Bearer ${key}` }) } }, timeoutMs, options.signal),
      probe(providerEndpoint(candidate, "models"), { method: "GET", headers: { accept: "application/json", "anthropic-version": "2023-06-01", ...(key === undefined ? {} : { "x-api-key": key }) } }, timeoutMs, options.signal),
      // A body that is valid JSON and invalid input: the point is to learn whether the route
      // exists and validates, without ever asking the endpoint to generate anything.
      probe(providerEndpoint(candidate, "responses"), postProbe, timeoutMs, options.signal),
      probe(providerEndpoint(candidate, DETECT_CONTROL_PATH), postProbe, timeoutMs, options.signal),
    ]);
    return { base: candidate, openai, anthropic, responses, control };
  }));

  // The shape that answered is the shape to save. When both do — a server that routes every
  // path to the same handler — the base as typed wins, because rewriting a URL that already
  // works would be a change with nothing behind it.
  const answered = probed.find((entry) => identifiesFamily(entry)) ?? probed[0]!;
  const { openai, anthropic, responses, control } = answered;
  const normalizedBaseUrl = canonicalBaseUrl(answered.base);

  const families = new Set<ApiFamily>();
  let authRequired: boolean | undefined;
  let openWithoutCredential = false;
  for (const outcome of [openai, anthropic]) {
    if (outcome === undefined) continue;
    const family = classifyFamily(outcome.body);
    if (family === undefined) continue;
    if (outcome.status >= 200 && outcome.status < 300) {
      families.add(family);
      if (key === undefined) openWithoutCredential = true;
    } else if (outcome.status === 401 || outcome.status === 403) {
      // A refusal that still speaks the family's error dialect is identification, not silence.
      families.add(family);
      authRequired = true;
    }
  }
  if (authRequired === undefined && openWithoutCredential) authRequired = false;

  const apiTypes: AcpConfigurableApiType[] = [];
  if (families.has("openai")) apiTypes.push(respondsToResponses(responses, control) ? "openai_responses" : "openai_completions");
  if (families.has("anthropic")) apiTypes.push("anthropic_messages");
  return { apiTypes, ...named, ...(authRequired === undefined ? {} : { authRequired }), normalizedBaseUrl };
}

/**
 * Whether one candidate base got a recognisable answer at all — a models list in some
 * family's shape, or a refusal in some family's error dialect. Both are the endpoint saying
 * "this path is mine"; a 404, a gateway page, or silence is not.
 */
function identifiesFamily(probes: BaseProbes): boolean {
  return [probes.openai, probes.anthropic].some((outcome) =>
    outcome !== undefined
    && (outcome.status < 300 || outcome.status === 401 || outcome.status === 403)
    && classifyFamily(outcome.body) !== undefined
  );
}

/** One bounded request. Anything that goes wrong is an absent outcome, never a throw. */
async function probe(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<ProbeOutcome | undefined> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  try {
    const response = await fetchWithHeadersDeadline(url, { ...init, signal: combined, redirect: "follow" }, timeoutMs);
    const text = await response.text();
    // A megabyte of anything is not a models list; refusing to parse it keeps a hostile or
    // merely wrong endpoint from turning a 3-second probe into a memory question.
    if (text.length > 1_000_000) return { status: response.status, body: undefined };
    let body: unknown;
    try { body = JSON.parse(text) as unknown; } catch { body = undefined; }
    return { status: response.status, body };
  } catch { return undefined; }
}

/**
 * Which family a body belongs to, from the shapes only that family produces.
 *
 * Order matters: Anthropic wraps its errors in a top-level `{type:"error", error:{…}}`, which
 * would also satisfy the OpenAI error test below it, so the more specific envelope is checked
 * first. The last clause is the lenient one — a bare `{data:[{id}…]}` with none of OpenAI's
 * markers is what most OpenAI-compatible gateways actually return.
 */
function classifyFamily(body: unknown): ApiFamily | undefined {
  if (!isRecord(body)) return undefined;
  const data = body.data;
  if (Array.isArray(data) && data.some((item) => isRecord(item) && item.type === "model")) return "anthropic";
  if (body.type === "error" && isRecord(body.error)) return "anthropic";
  if (body.object === "list" && Array.isArray(data)) return "openai";
  if (isRecord(body.error) && ["message", "type", "code"].some((field) => typeof (body.error as Record<string, unknown>)[field] === "string")) return "openai";
  if (Array.isArray(data) && data.every((item) => isRecord(item) && typeof item.id === "string")) return "openai";
  return undefined;
}

/**
 * Whether `/responses` is really there — confirmed by shape, never by status alone.
 *
 * A validation-class status used to be the whole test, and it is not enough: a proxy that
 * hands every unrecognised path to one handler answers a generic 400, which read as "the
 * route validated my body" and classified the endpoint as `openai_responses`. The first turn
 * then went to a protocol nothing behind that proxy spoke. Every OpenAI-family endpoint
 * speaks Chat Completions, so completions is the answer that is never wrong on the strength
 * of no evidence, and it is what absence of confirmation now falls back to.
 *
 * Three things count as confirmation, in descending order of directness:
 *  - a 2xx whose body is a Response object, from an endpoint lenient enough to accept `{}`;
 *  - a validation error that names a parameter only the Responses API has, which is the
 *    route reading the body rather than a handler refusing an unknown path;
 *  - a validation error that differs from what the same POST gets at a route that certainly
 *    does not exist. A deployment with the route answers those two differently; a catch-all
 *    answers them identically, and identical is exactly what it is not evidence of.
 */
function respondsToResponses(outcome: ProbeOutcome | undefined, control: ProbeOutcome | undefined): boolean {
  if (outcome === undefined) return false;
  if (outcome.status >= 200 && outcome.status < 300) return isResponsesBody(outcome.body);
  if (outcome.status !== 400 && outcome.status !== 413 && outcome.status !== 422) return false;
  if (namesResponsesParameter(outcome.body)) return true;
  return control !== undefined && !sameAnswerShape(outcome, control);
}

/** A Response object: the thing `/responses` returns and no other route does. */
function isResponsesBody(body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (body.object === "response") return true;
  return Array.isArray(body.output) && (typeof body.id === "string" || typeof body.status === "string");
}

/** Whether a validation error is about a parameter only the Responses API defines. */
function namesResponsesParameter(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const error = isRecord(body.error) ? body.error : body;
  const param = typeof error.param === "string" ? error.param : undefined;
  if (param !== undefined && RESPONSES_ONLY_PARAMETERS.includes(param)) return true;
  const message = typeof error.message === "string" ? error.message : undefined;
  if (message === undefined) return false;
  // Quoted only. OpenAI names parameters in quotes ("Missing required parameter: 'input'."),
  // and matching bare words would read "please include a model parameter" as evidence.
  return RESPONSES_ONLY_PARAMETERS.some((name) => new RegExp(`['"\`]${name}['"\`]`).test(message));
}

/**
 * Whether two answers are the same answer. Compared as skeletons — statuses, key names and
 * value *types* — because a catch-all that echoes the path it did not recognise varies its
 * prose while saying the identical thing.
 */
function sameAnswerShape(left: ProbeOutcome, right: ProbeOutcome): boolean {
  return left.status === right.status && bodySkeleton(left.body) === bodySkeleton(right.body);
}

function bodySkeleton(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.length === 0 ? "" : bodySkeleton(value[0])}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${key}:${bodySkeleton(value[key])}`).join(",")}}`;
  }
  return typeof value;
}

/**
 * A provider id derived from the host: the two Lyra knows by name, anything loopback or
 * literal-address as `local`, and otherwise the first host label that carries meaning —
 * `api.groq.com` is a groq, not an api.
 *
 * The result always satisfies the provider-id rule `provider/add` enforces, or is absent;
 * it is a *default for a form field*, never a decision, so a host that yields nothing usable
 * leaves the user to name their own provider rather than being given a mangled guess.
 */
export function suggestProviderName(baseUrl: string): string | undefined {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return undefined; }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "api.anthropic.com") return "anthropic";
  if (host === "api.openai.com") return "openai";
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host)) return "local";
  // A bare address names nothing; a machine reachable only by number is a local endpoint.
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return "local";
  const labels = host.split(".").filter((label) => label.length > 0);
  const meaningful = labels.find((label) => !["api", "www", "gateway", "v1", "inference"].includes(label)) ?? labels[0];
  if (meaningful === undefined) return undefined;
  const id = meaningful.replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+/g, "-").replace(/-$/, "").slice(0, 64);
  return id.length === 0 ? undefined : id;
}

/** A provider id the cache path can hold, for a provider that may not have a name yet. */
function verifyId(provider: string | undefined): string {
  return typeof provider === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(provider) ? provider : "unnamed";
}

/**
 * Why a probe failed, in the daemon's own error vocabulary.
 *
 * The message is the provider's or the exception's — never the request that produced it —
 * so a credential cannot reach the wire through an error string.
 */
function verifyError(error: unknown, timedOut: boolean, timeoutMs: number): NonNullable<AcpVerifyProviderResult["error"]> {
  if (timedOut) return { classification: "transient", message: `The endpoint did not answer within ${timeoutMs}ms.`, code: "verify_timeout" };
  const fault = error as { classification?: unknown; providerMessage?: unknown; code?: unknown; status?: unknown } | null;
  const classification = typeof fault?.classification === "string" ? fault.classification : "transient";
  const message = typeof fault?.providerMessage === "string" ? fault.providerMessage : error instanceof Error ? error.message : String(error);
  return {
    classification,
    message,
    ...(typeof fault?.code === "string" ? { code: fault.code } : {}),
    ...(typeof fault?.status === "number" ? { status: fault.status } : {}),
  };
}

function validateSetup(input: ProviderSetupInput): void {
  if (!input || typeof input.provider !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(input.provider)) throw new TypeError("Provider id must be lowercase letters, digits, and hyphens.");
  // Validated against the canonical form so `localhost:4100` passes the way the user meant
  // it: the scheme is added, the pasted route is stripped, and what is written is canonical.
  if (typeof input.baseUrl !== "string" || !/^https?:\/\//.test(canonicalBaseUrl(input.baseUrl))) throw new TypeError("Provider base URL must be an http(s) URL.");
  if (input.apiType !== "openai_completions" && input.apiType !== "openai_responses" && input.apiType !== "anthropic_messages") throw new TypeError("Provider API type is invalid.");
  if (input.model !== undefined && (typeof input.model !== "string" || input.model.length === 0)) throw new TypeError("Provider model, when given, must be non-empty text.");
  if (input.auth.type === "keychain" && input.auth.token.length === 0) throw new TypeError("Keychain token is required.");
  if (input.auth.type === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.auth.variable)) throw new TypeError("Environment variable name is invalid.");
  if (input.auth.type === "static" && input.auth.token.length === 0) throw new TypeError("Static token is required.");
}
function toml(value: string): string { return JSON.stringify(value); }
