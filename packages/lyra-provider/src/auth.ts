import { ProviderFault } from "./errors.ts";

export interface AuthToken {
  token: string;
  expiresAt?: string;
}

export interface AuthSource {
  getToken(signal?: AbortSignal): Promise<AuthToken | undefined>;
  invalidate?(): void;
  /**
   * Extra request headers this credential source's endpoint mandates.
   *
   * Optional because only one source has them: an API key is a header, but a subscription
   * endpoint is a *set* of headers — a beta flag, a client identifier — that travel with the
   * credential and are meaningless without it. Resolving them here rather than in
   * `resolveProvider` keeps that resolution async, which it has to be: the plugin declaring
   * them is a module that has not been imported yet when configuration is read.
   */
  requestHeaders?(signal?: AbortSignal): Promise<Readonly<Record<string, string>> | undefined>;
  /**
   * A static line this endpoint requires as the *first* system block.
   *
   * Provider-mandated overhead, not Lyra's prompt: it is authored by the credential source,
   * fixed for the life of the session, and deliberately outside the system-prompt budget
   * (`buildSystemPrompt` never sees it). See `AuthPlugin.systemPrefix`.
   */
  systemPrefix?(signal?: AbortSignal): Promise<string | undefined>;
}

export class EnvironmentAuth implements AuthSource {
  readonly variable: string;

  constructor(variable: string) {
    this.variable = variable;
  }

  async getToken(): Promise<AuthToken> {
    const token = Bun.env[this.variable];
    if (token === undefined || token.length === 0) {
      throw authenticationFault(`Authentication variable ${this.variable} is not set`);
    }
    return { token };
  }
}

export class StaticAuth implements AuthSource {
  constructor(private readonly token: string) {}

  async getToken(): Promise<AuthToken> {
    return { token: this.token };
  }
}

export class NoAuth implements AuthSource {
  async getToken(): Promise<undefined> {
    return undefined;
  }
}

export interface HttpTransportConfig {
  id: string;
  baseUrl: string;
  auth?: AuthSource;
  headers?: Readonly<Record<string, string>>;
  authHeader?: "bearer" | "x-api-key";
}

export async function providerHeaders(
  config: HttpTransportConfig,
  signal?: AbortSignal,
): Promise<Headers> {
  const headers = new Headers(config.headers);
  headers.set("content-type", "application/json");
  // The credential source's headers win over the provider's defaults: the endpoint that issued
  // the credential is the authority on what it wants sent with it. The credential itself is
  // applied last, so a plugin cannot accidentally shadow its own token with a stale one.
  for (const [name, value] of Object.entries(await config.auth?.requestHeaders?.(signal) ?? {})) {
    headers.set(name, value);
  }
  const token = await config.auth?.getToken(signal);
  if (token !== undefined) {
    if (config.authHeader === "x-api-key") headers.set("x-api-key", token.token);
    else headers.set("authorization", `Bearer ${token.token}`);
  }
  return headers;
}

/**
 * The line this provider's credential source requires ahead of Lyra's system prompt, if any.
 *
 * Asked once per request, next to `providerHeaders`, because it is the same kind of fact: what
 * this endpoint mandates in order to answer at all. Every transport resolves it at the same
 * point it resolves headers, so no route can forget it — including the ones a spawned child or
 * the compaction summarizer takes, which never pass through session setup.
 */
export async function providerSystemPrefix(
  config: HttpTransportConfig,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const prefix = await config.auth?.systemPrefix?.(signal);
  return prefix === undefined || prefix.length === 0 ? undefined : prefix;
}

/**
 * A prefix and a system prompt, joined for the wire formats that carry only one string.
 *
 * A blank line between them, so the mandated line reads as its own paragraph rather than the
 * first sentence of Lyra's prompt.
 */
export function joinSystemPrefix(prefix: string | undefined, system: string): string {
  if (prefix === undefined || prefix.length === 0) return system;
  return system.length === 0 ? prefix : `${prefix}\n\n${system}`;
}

/**
 * A base and a path, joined.
 *
 * Kept as the primitive it always was, and no longer used to *decide* anything: every route a
 * transport asks for now goes through `endpoints.ts`, which owns the one rule about where a
 * provider's routes live and the retry that forgives a base one `/v1` away from it. Four
 * call sites each joining their own way is what let a provider be detected at one path shape
 * and requested at another.
 */
export function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export function authenticationFault(message: string, cause?: unknown): ProviderFault {
  return new ProviderFault({
    classification: "auth",
    providerMessage: message,
    code: "auth_source_error",
    ...(cause === undefined ? {} : { cause }),
  });
}
