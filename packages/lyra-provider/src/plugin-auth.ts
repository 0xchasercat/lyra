import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import type { AuthSource, AuthToken } from "./auth.ts";
import { authenticationFault } from "./auth.ts";

/**
 * The one executable extension point (LYRA.md §5.5).
 *
 * Every subscription tier — Claude Max, ChatGPT, Copilot, whatever comes next — resolves to an
 * OpenAI- or Anthropic-compatible endpoint. Only three things differ from an API key, and this
 * is all three: how a bearer token is acquired ([`getToken`]/[`login`]), what extra headers the
 * endpoint mandates ([`headers`]), and the one identity line some of them require as the first
 * system block ([`systemPrefix`]).
 *
 * That last field is why this is not a two-line interface. The alternative — a proxy that
 * injects a whole vendor system prompt to make the request look native — buys access by
 * replacing Lyra's instructions with someone else's. A declared prefix pays the one line the
 * endpoint actually checks and leaves Lyra's prompt in authority (§14).
 */
export interface AuthPlugin {
  /** Must equal the directory the plugin was installed into. */
  id: string;
  /** Extra request headers this endpoint mandates. Merged over the provider's own. */
  headers?: Readonly<Record<string, string>>;
  /** A static line prepended as the *first* system block, ahead of Lyra's prompt. */
  systemPrefix?: string;
  /** Interactive credential acquisition. Only ever run by `lyra plugins login <id>`. */
  login?(): Promise<void>;
  /** Non-interactive. Throws with an actionable message when there are no stored credentials. */
  getToken(): Promise<AuthToken>;
}

/** The two entry filenames a plugin directory may use, in the order they are tried. */
export const AUTH_PLUGIN_ENTRIES = ["plugin.ts", "index.ts"] as const;

/** Plugin ids are directory names, so they are constrained to what a directory name may be. */
export const AUTH_PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * How early a token is refreshed before it expires.
 *
 * A token that expires between the header being built and the endpoint reading it is a 401 the
 * user did nothing to deserve. The margin is the width of that race plus a slow round trip.
 */
export const AUTH_PLUGIN_REFRESH_MARGIN_MS = 60_000;

/** Where plugins live, unless a caller (a test, a packaged install) says otherwise. */
export function authPluginRoot(home = homedir()): string {
  return resolve(home, ".lyra", "plugins");
}

export function isValidAuthPluginId(value: string): boolean {
  return AUTH_PLUGIN_ID_PATTERN.test(value);
}

/**
 * The loader of record: resolve `<root>/<id>/{plugin,index}.ts`, import it, and check the shape.
 *
 * It lives here rather than in the app layer because auth resolution has to load the plugin
 * anyway, and `@lyra/provider` cannot depend upward. `lyra plugins` calls straight into it, so
 * the validation a user sees at install time is the same code the transport runs at request
 * time — there is no second opinion to drift.
 *
 * Every rejection names the file and the fix. "Invalid plugin" is not an error message a user
 * can act on, and this is user-authored code where the mistake is always in a specific line.
 */
export async function loadAuthPlugin(id: string, root = authPluginRoot()): Promise<AuthPlugin> {
  if (!isValidAuthPluginId(id)) {
    throw authenticationFault(
      `Auth plugin id ${JSON.stringify(id)} is invalid. An id is the plugin's directory name: lowercase letters, digits and dashes, starting with a letter (for example "claude-oauth").`,
    );
  }
  const directory = resolve(root);
  const entry = await resolveEntry(id, directory);

  let module: Record<string, unknown>;
  try {
    // User-installed code, selected by this machine's own configuration. Running it is the
    // point of the hatch; `lyra plugins install` is where that is said out loud.
    module = await import(pathToFileURL(entry).href) as Record<string, unknown>;
  } catch (cause) {
    throw authenticationFault(
      `Auth plugin ${id} failed to load from ${entry}: ${messageOf(cause)}. Fix the error in that file, or reinstall the plugin with \`lyra plugins update ${id}\`.`,
      cause,
    );
  }

  const candidate = module.default;
  if (typeof candidate !== "object" || candidate === null) {
    throw authenticationFault(
      `Auth plugin ${id} has no default export in ${entry}. End the file with:\n`
      + `  export default { id: ${JSON.stringify(id)}, async getToken() { return { token: "…" }; } };`,
    );
  }
  const record = candidate as Record<string, unknown>;

  if (typeof record.id !== "string" || record.id.length === 0) {
    throw authenticationFault(
      `Auth plugin ${id} exports no id in ${entry}. Add \`id: ${JSON.stringify(id)}\` to the default export — it must match the directory name.`,
    );
  }
  if (record.id !== id) {
    throw authenticationFault(
      `Auth plugin in ${entry} declares id ${JSON.stringify(record.id)}, but it is installed as ${JSON.stringify(id)}. Change the id to ${JSON.stringify(id)}, or reinstall the plugin into a directory named ${JSON.stringify(record.id)}.`,
    );
  }
  if (typeof record.getToken !== "function") {
    throw authenticationFault(
      `Auth plugin ${id} does not export getToken() in ${entry}. Add:\n`
      + `  async getToken() { return { token: "…", expiresAt: "…" }; }`,
    );
  }
  if (record.login !== undefined && typeof record.login !== "function") {
    throw authenticationFault(
      `Auth plugin ${id} exports login, but it is not a function, in ${entry}. Make it \`async login() { … }\`, or remove it.`,
    );
  }
  if (record.systemPrefix !== undefined && (typeof record.systemPrefix !== "string" || record.systemPrefix.includes("\n"))) {
    throw authenticationFault(
      `Auth plugin ${id} exports systemPrefix, but it is not a single-line string, in ${entry}. A systemPrefix is one static line prepended as the first system block; remove it if the endpoint does not require one.`,
    );
  }
  if (record.headers !== undefined && !isHeaderRecord(record.headers)) {
    throw authenticationFault(
      `Auth plugin ${id} exports headers, but it is not an object of string values, in ${entry}. Use \`headers: { "anthropic-beta": "oauth-2025-04-20" }\`, or remove it.`,
    );
  }

  return candidate as AuthPlugin;
}

/**
 * A provider credential backed by an auth plugin.
 *
 * The plugin module is imported once and kept; the *token* is cached until shortly before it
 * expires, and dropped outright by [`invalidate`] — which is what `ReliableProvider`'s auth
 * recovery calls on a 401, so an endpoint that revoked a token early is one retry away from a
 * fresh one rather than a dead session.
 */
export class PluginAuth implements AuthSource {
  readonly pluginId: string;
  readonly pluginDirectory: string;
  private plugin: AuthPlugin | undefined;
  private cached: AuthToken | undefined;

  constructor(pluginId: string, pluginDirectory = authPluginRoot()) {
    if (!isValidAuthPluginId(pluginId)) throw authenticationFault(`Auth plugin id ${JSON.stringify(pluginId)} is invalid`);
    this.pluginId = pluginId;
    this.pluginDirectory = resolve(pluginDirectory);
  }

  async getToken(signal?: AbortSignal): Promise<AuthToken> {
    if (signal?.aborted) throw signal.reason;
    if (this.cached !== undefined && !expiresSoon(this.cached.expiresAt)) return this.cached;
    const plugin = await this.load(signal);
    let token: AuthToken;
    try {
      token = await withSignal(plugin.getToken(), signal);
    } catch (cause) {
      if (signal?.aborted) throw signal.reason;
      // The plugin's own sentence is the useful half — it knows whether the credential file is
      // missing, expired, or refused. Lyra adds only the command that fixes it.
      throw authenticationFault(
        `Auth plugin ${this.pluginId} could not produce a token: ${messageOf(cause)}. ${this.remedy(plugin)}`,
        cause,
      );
    }
    if (typeof token !== "object" || token === null || typeof token.token !== "string") {
      throw authenticationFault(
        `Auth plugin ${this.pluginId} returned ${describe(token)} from getToken(); it must return { token: string, expiresAt?: string }.`,
      );
    }
    if (token.token.length === 0) {
      throw authenticationFault(`Auth plugin ${this.pluginId} returned an empty bearer token. ${this.remedy(plugin)}`);
    }
    if (token.expiresAt !== undefined && Number.isNaN(Date.parse(token.expiresAt))) {
      throw authenticationFault(
        `Auth plugin ${this.pluginId} returned invalid expiresAt: ${JSON.stringify(token.expiresAt)}. It must be an ISO 8601 instant, such as new Date(Date.now() + 3600e3).toISOString().`,
      );
    }
    this.cached = token;
    return token;
  }

  /** The extra headers this plugin's endpoint mandates. Merged over the provider's own. */
  async requestHeaders(signal?: AbortSignal): Promise<Readonly<Record<string, string>> | undefined> {
    return (await this.load(signal)).headers;
  }

  /** The one line this plugin's endpoint wants as the first system block, if any. */
  async systemPrefix(signal?: AbortSignal): Promise<string | undefined> {
    return (await this.load(signal)).systemPrefix;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  /** The loaded plugin, for the one caller allowed to run `login()`: `lyra plugins login`. */
  async resolve(signal?: AbortSignal): Promise<AuthPlugin> {
    return this.load(signal);
  }

  private async load(signal?: AbortSignal): Promise<AuthPlugin> {
    if (this.plugin !== undefined) return this.plugin;
    const plugin = await withSignal(loadAuthPlugin(this.pluginId, this.pluginDirectory), signal);
    this.plugin = plugin;
    return plugin;
  }

  private remedy(plugin: AuthPlugin): string {
    return plugin.login === undefined
      ? `This plugin declares no login flow, so its credentials come from somewhere else — check ${this.pluginDirectory}/${this.pluginId} for how it expects to be set up.`
      : `Run \`lyra plugins login ${this.pluginId}\`.`;
  }
}

/**
 * The entry file, resolved through realpath so a symlinked directory cannot reach out of the
 * plugin root — the id is configuration, and configuration is not a licence to import
 * arbitrary paths.
 */
async function resolveEntry(id: string, root: string): Promise<string> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (cause) {
    throw authenticationFault(
      `Auth plugin ${id} cannot be loaded: ${root} does not exist. Install it with \`lyra plugins install <git-url>\`.`,
      cause,
    );
  }
  for (const filename of AUTH_PLUGIN_ENTRIES) {
    let candidate: string;
    try {
      candidate = await realpath(resolve(realRoot, id, filename));
    } catch { continue; }
    const contained = relative(realRoot, candidate);
    if (contained.startsWith("..") || isAbsolute(contained)) {
      throw authenticationFault(
        `Auth plugin ${id} resolves to ${candidate}, which is outside ${realRoot}. A plugin must be a real directory under the plugin root, not a link out of it.`,
      );
    }
    return candidate;
  }
  throw authenticationFault(
    `Auth plugin ${id} has no entry file. Expected ${resolve(root, id, "plugin.ts")} or ${resolve(root, id, "index.ts")}. Install it with \`lyra plugins install <git-url>\`, or list what is installed with \`lyra plugins list\`.`,
  );
}

function expiresSoon(expiresAt: string | undefined): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= Date.now() + AUTH_PLUGIN_REFRESH_MARGIN_MS;
}

function isHeaderRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  return "an object without a string token";
}

function messageOf(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/\.$/, "");
}

async function withSignal<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
