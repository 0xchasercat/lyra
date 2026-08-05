import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { AuthSource, AuthToken } from "./auth.ts";
import { authenticationFault } from "./auth.ts";

export interface AuthPlugin {
  id: string;
  getToken(): Promise<AuthToken>;
}

export class PluginAuth implements AuthSource {
  readonly pluginId: string;
  readonly pluginDirectory: string;
  private plugin: AuthPlugin | undefined;
  private cached: AuthToken | undefined;

  constructor(pluginId: string, pluginDirectory = resolve(homedir(), ".lyra", "plugins")) {
    this.pluginId = pluginId;
    this.pluginDirectory = pluginDirectory;
  }

  async getToken(signal?: AbortSignal): Promise<AuthToken> {
    if (signal?.aborted) throw signal.reason;
    if (this.cached !== undefined && !expiresSoon(this.cached.expiresAt)) return this.cached;
    const plugin = await withSignal(this.load(), signal);
    let token: AuthToken;
    try {
      token = await withSignal(plugin.getToken(), signal);
    } catch (cause) {
      if (signal?.aborted) throw signal.reason;
      throw authenticationFault(`Auth plugin ${this.pluginId} failed to return a bearer token`, cause);
    }
    if (token.token.length === 0) {
      throw authenticationFault(`Auth plugin ${this.pluginId} returned an empty bearer token`);
    }
    if (token.expiresAt !== undefined && Number.isNaN(Date.parse(token.expiresAt))) {
      throw authenticationFault(`Auth plugin ${this.pluginId} returned invalid expiresAt: ${token.expiresAt}`);
    }
    this.cached = token;
    return token;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async load(): Promise<AuthPlugin> {
    if (this.plugin !== undefined) return this.plugin;
    const entry = resolve(this.pluginDirectory, this.pluginId, "index.ts");
    let module: Record<string, unknown>;
    try {
      // Plugin entrypoints are user-installed and selected by runtime configuration.
      module = await import(pathToFileURL(entry).href) as Record<string, unknown>;
    } catch (cause) {
      throw authenticationFault(
        `Auth plugin ${this.pluginId} could not be loaded from ${entry}. Install it under ~/.lyra/plugins/${this.pluginId}/index.ts.`,
        cause,
      );
    }
    const candidate = module.default ?? module.plugin;
    if (!isAuthPlugin(candidate)) {
      throw authenticationFault(
        `Auth plugin ${this.pluginId} must export { id: string, getToken(): Promise<{ token, expiresAt? }> } as default or plugin`,
      );
    }
    if (candidate.id !== this.pluginId) {
      throw authenticationFault(`Auth plugin id ${candidate.id} does not match configured id ${this.pluginId}`);
    }
    this.plugin = candidate;
    return candidate;
  }
}

function expiresSoon(expiresAt: string | undefined): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= Date.now() + 60_000;
}

function isAuthPlugin(value: unknown): value is AuthPlugin {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.getToken === "function";
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
