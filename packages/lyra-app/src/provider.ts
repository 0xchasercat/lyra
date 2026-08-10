import { authPluginRoot, createProviderTransport, loadProviderConfig, ProviderFault, ReliableProvider, resolveProvider, resolveModelRole } from "@lyra/provider";
import type { AuthConfig, AuthSource, ProviderDefinition, ProviderFileConfig, ProviderTransport, ResolveProviderOptions } from "@lyra/provider";

export interface EnvironmentProviderOptions {
  configPath?: string;
  configPaths?: readonly string[];
  model?: string;
  maxAttempts?: number;
  streamStallTimeoutMs?: number;
  turnTimeoutMs?: number;
  /** Home directory auth plugins are read from. Defaults to the real one; tests point it away. */
  home?: string;
}

/** `~/.lyra/plugins`, or a test's stand-in for it, in the shape `resolveProvider` accepts. */
function pluginOptions(home: string | undefined): ResolveProviderOptions {
  return home === undefined ? {} : { pluginRoot: authPluginRoot(home) };
}
export interface EnvironmentProvider {
  provider: ReliableProvider;
  providerName: string;
  model: string;
  config: ProviderFileConfig;
  /**
   * Why there is no provider, when there is none. Present only on the placeholder
   * environment a first run boots with: everything that does not need a model keeps working,
   * and everything that does fails with this sentence rather than crashing the daemon.
   */
  unconfigured?: string;
}

/** What a prompt is told when nothing is configured. One sentence, and every route out of it. */
export const NO_PROVIDER_MESSAGE =
  "No provider is configured. Add one with /provider add, export OPENAI_API_KEY or ANTHROPIC_API_KEY, or declare one in ~/.lyra/providers.toml.";

/**
 * The environment a daemon boots with when nothing is configured (DESIGN.md §6.6: pickers and
 * wizards are ACP flows, and a wizard cannot run inside a process that refused to start).
 *
 * The session, the transcript, the tool registry, the slash router and every ACP method that
 * is not about models are all real. Only the model call is absent, and it is absent *loudly*:
 * the transport refuses with [`NO_PROVIDER_MESSAGE`] rather than being a null that surfaces
 * later as a type error somewhere far from the cause.
 *
 * `apiType` is a placeholder the context estimator needs a value for; nothing puts it on the
 * wire while `unconfigured` is set — `session/snapshot` omits it, because an unconfigured
 * daemon has no honest answer for what protocol it speaks.
 */
export function createUnconfiguredEnvironment(config: ProviderFileConfig, reason: string = NO_PROVIDER_MESSAGE): EnvironmentProvider {
  const transport: ProviderTransport = {
    id: "unconfigured",
    apiType: "openai_completions",
    // Never yields: refusing is the whole contract.
    async *stream(): AsyncGenerator<never> {
      throw new ProviderFault({ classification: "auth", providerMessage: reason, code: "provider_not_configured" });
    },
  };
  // One attempt: retrying a configuration mistake is a slower way to report the same thing.
  return { provider: new ReliableProvider(transport, { maxAttempts: 1 }), providerName: "", model: "", config, unconfigured: reason };
}

export async function createEnvironmentProvider(options: EnvironmentProviderOptions = {}): Promise<EnvironmentProvider> {
  const config = await loadProviderConfig(options.configPaths ?? options.configPath);
  return createConfiguredProvider(config, options);
}

export function createConfiguredProvider(config: ProviderFileConfig, options: Omit<EnvironmentProviderOptions, "configPath" | "configPaths"> = {}): EnvironmentProvider {
  if (options.model === undefined && config.roles.default === undefined) throw new Error("No default provider is configured. Run `lyra` in an interactive terminal for setup, export OPENAI_API_KEY or ANTHROPIC_API_KEY, or add a provider and [roles].default to Lyra TOML.");
  let reference = resolveModelRole(options.model ?? "@default", config.roles);
  // Sane default for humans and agents: bare model id auto-maps to current/default provider.
  // This lets both "/model gpt-5.6-luna" and "/model openai/gpt-5.6-luna" work interchangeably.
  if (!reference.includes("/") && !reference.startsWith("@")) {
    const defaultProvider = config.roles.default?.split("/")[0] ?? Object.keys(config.providers)[0] ?? "openai";
    reference = `${defaultProvider}/${reference}`;
  }
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) {
    const hint = reference.includes("/") ? `Got "${reference}" — provider or model part is empty.` : `Got "${reference}" — missing "/"`;
    const currentDefault = config.roles.default ? ` Your [roles].default is "${config.roles.default}".` : "";
    const providers = Object.keys(config.providers).join(", ") || "none configured";
    throw new Error(
      `${hint} Lyra needs "provider/model" (e.g. "openai/gpt-5.6-luna" or "anthropic/claude-opus-5").` +
      `${currentDefault} Available providers: ${providers}.` +
      ` Bare ids like "gpt-5.6-luna" are auto-mapped to the current provider (e.g. "${Object.keys(config.providers)[0] ?? "openai"}/gpt-5.6-luna"), but an explicit "provider/model" is preferred when multiple providers are configured.` +
      ` Fix it with "/provider add" to add a provider, or run "/model add" to register a model for a provider that has no /v1/models endpoint.`
    );
  }
  const providerName = reference.slice(0, separator);
  const model = reference.slice(separator + 1);
  const definition = config.providers[providerName];
  if (!definition) throw new Error(`Provider "${providerName}" is not configured (you asked for "${reference}"). Available: ${Object.keys(config.providers).join(", ") || "none"}. Add it with "/provider add" or add [providers.${providerName}] to Lyra TOML.`);
  const resolved = resolveProvider(providerName, definition, pluginOptions(options.home));
  const transport = createProviderTransport(resolved);
  const auth = resolved.auth;
  const provider = new ReliableProvider(transport, {
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.streamStallTimeoutMs === undefined ? {} : { streamStallTimeoutMs: options.streamStallTimeoutMs }),
    ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    // Auth recovery, connected to the one credential source that can actually recover.
    //
    // A cached token outlives its welcome for two reasons a client cannot see: the endpoint
    // revoked it, or the plugin's clock disagreed with the endpoint's. Both arrive as a 401,
    // which `ReliableProvider` classifies as `auth` and offers exactly one retry for. Dropping
    // the cache here is what makes that retry mean something — the next `providerHeaders` call
    // asks the plugin again and gets a freshly refreshed token. A credential source with
    // nothing to invalidate (an env var, a static token) declares no hook, so its 401 still
    // surfaces immediately rather than costing a pointless second attempt.
    ...(auth?.invalidate === undefined ? {} : { refreshAuth: async (): Promise<void> => { auth.invalidate?.(); } }),
  });
  return { provider, providerName, model, config };
}

/** How long a credential source is given to answer before a selection gives up on it. */
export const PROVIDER_CREDENTIAL_PROBE_TIMEOUT_MS = 10_000;

/**
 * Whether a provider/model reference can actually serve a turn — asked *before* anything
 * switches to it.
 *
 * A selection used to check one thing: that `[providers.<name>]` exists. Everything else that
 * has to be true for that provider to answer — a definition the transport layer accepts, and a
 * credential source that can produce a credential — was first evaluated inside the next
 * prompt, which is why `session/select_provider` could report success and the following turn
 * fail. The probe here is the same work the first turn would do (resolve the definition, ask
 * the auth source for a token), moved to the moment the user can still act on the answer, and
 * bounded so a wedged credential helper costs a deadline rather than the session.
 *
 * It is deliberately not a network call: `provider/verify` is the liveness probe, this is the
 * resolution check. A reachable endpoint that rejects the credential is still a failed turn,
 * but it is a failed turn that now says which provider, which credential source, and what to
 * do about it (see [`describeProviderFailure`]).
 */
export async function assertProviderUsable(
  name: string,
  definition: ProviderDefinition,
  model: string,
  options: { timeoutMs?: number; signal?: AbortSignal; home?: string } = {},
): Promise<void> {
  const reference = `${name}/${model}`;
  let auth: AuthSource | undefined;
  try {
    // Plugin auth is resolved and *run* here like any other source: the same 10s bound covers
    // importing the plugin module and its `getToken`, so a plugin that hangs on a network call
    // costs a deadline at selection time instead of the first turn.
    auth = resolveProvider(name, definition, pluginOptions(options.home)).auth;
  } catch (cause) {
    throw new Error(`Cannot select ${reference}: its configuration is not usable — ${messageOf(cause)}. Fix [providers.${name}] in Lyra TOML, or re-add the provider with /provider add.`, { cause });
  }
  if (auth === undefined) return;
  const timeoutMs = options.timeoutMs ?? PROVIDER_CREDENTIAL_PROBE_TIMEOUT_MS;
  // An owned timer rather than `AbortSignal.timeout`. That helper's signal is held weakly, and
  // a credential source that runs a dynamic `import()` — which is exactly what plugin auth does
  // — can see it collected before it ever fires, so the bound this function's whole contract
  // rests on silently did not bind. The timer is also cleared on the happy path, which the
  // helper never was.
  const deadline = new AbortController();
  const timer = setTimeout(() => { deadline.abort(); }, timeoutMs);
  const signal = options.signal === undefined ? deadline.signal : AbortSignal.any([options.signal, deadline.signal]);
  try {
    await auth.getToken(signal);
  } catch (cause) {
    // A caller that cancelled gets its own cancellation back, not a provider verdict.
    if (options.signal?.aborted === true) throw cause;
    const detail = deadline.signal.aborted
      ? `${credentialSource(definition.auth)} did not answer within ${timeoutMs}ms`
      : messageOf(cause);
    throw new Error(`Cannot select ${reference}: ${detail}. ${credentialRemedy(name, definition.auth)}`, { cause });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A provider failure, restated so it names the provider it came from and the next move.
 *
 * A transport reports what the endpoint said; it has no idea which configured provider is
 * behind it, and the ACP error a client renders is exactly this string. Left alone, a turn
 * against a misconfigured provider surfaces as a sentence about an anonymous HTTP status —
 * true, unusable, and indistinguishable from every other provider's failure in a session that
 * has more than one.
 *
 * Only the classifications that mean *this provider cannot serve you* are rewritten. A
 * transient failure, an overflow, or a refusal is about the turn rather than the configuration,
 * and prefixing those with configuration advice would be noise on the common path.
 */
export function describeProviderFailure(environment: EnvironmentProvider, error: unknown): unknown {
  if (!(error instanceof ProviderFault)) return error;
  if (environment.unconfigured !== undefined || environment.providerName.length === 0) return error;
  if (error.classification !== "auth" && error.classification !== "bad_request" && error.classification !== "model_unavailable") return error;
  const reference = `${environment.providerName}/${environment.model}`;
  if (error.providerMessage.startsWith(reference)) return error;
  const definition = environment.config.providers[environment.providerName];
  const remedy = error.classification === "auth"
    ? definition === undefined ? "" : ` ${authAdvice(environment.providerName, definition.auth)}`
    : error.classification === "model_unavailable"
      ? ` Pick another model with /model, or another provider with /provider.`
      : "";
  return new ProviderFault({
    classification: error.classification,
    providerMessage: `${reference} failed: ${error.providerMessage.replace(/\.$/, "")}.${remedy}${routeAdvice(environment.providerName, error)}`,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    ...(error.raw === undefined ? {} : { raw: error.raw }),
    ...(error.url === undefined ? {} : { url: error.url }),
    cause: error,
  });
}

/**
 * A 404, with the URL in it.
 *
 * "HTTP 404 with an empty error body" is the exact sentence a user reported being stuck on,
 * and it is unactionable for one reason: a 404 is a statement about a path, and it was the
 * only fact the sentence left out. The provider layer now carries the URL on the fault, and
 * this is where it becomes something to read — with the one thing that produces it, which is
 * a `base_url` that is not the prefix this deployment hangs its routes off.
 *
 * Only 404. Every other status is about the request or the credential, and a URL would be
 * noise beside them.
 */
function routeAdvice(name: string, error: ProviderFault): string {
  if (error.status !== 404 || error.url === undefined) return "";
  // Named once. An empty-bodied 404 already carries the URL in the sentence the provider
  // layer built for it; a 404 that came with prose does not.
  const located = error.providerMessage.includes(error.url) ? "" : ` The request went to ${error.url}.`;
  return `${located} Lyra joins its routes onto base_url exactly, so check base_url under [providers.${name}] in Lyra TOML — a 404 here is usually a "/v1" that belongs on the base, or one that does not.`;
}

/**
 * A rejected credential, explained: where this provider's credential comes from, and what to
 * do about it. A provider that declares none is told only the second half — "the credential
 * comes from no credential" is not a sentence.
 */
function authAdvice(name: string, auth: AuthConfig): string {
  const source = auth.type === "none" ? "" : `The credential comes from ${credentialSource(auth)}. `;
  return `${source}${credentialRemedy(name, auth)}`;
}

/** Where a provider's credential comes from, in words, and never the credential itself. */
export function credentialSource(auth: AuthConfig): string {
  switch (auth.type) {
    case "env": return `environment variable ${auth.var}`;
    case "keychain": return `OS keychain entry ${auth.service}/${auth.account}`;
    case "plugin": return `auth plugin ${auth.plugin}`;
    case "static": return "the token stored in Lyra TOML";
    case "none": return "no credential";
  }
}

/** What to do about a credential source that could not produce a credential. */
function credentialRemedy(name: string, auth: AuthConfig): string {
  switch (auth.type) {
    case "env": return `Export ${auth.var} in the shell that starts Lyra and select the provider again, or re-add it with /provider add to store the credential in the OS keychain.`;
    case "keychain": return `Store it again with /provider add.`;
    case "plugin": return `Sign in with \`lyra plugins login ${auth.plugin}\`, or check the plugin itself with \`lyra plugins list\` — it lives at ~/.lyra/plugins/${auth.plugin}/.`;
    case "static": return `Fix auth.token under [providers.${name}] in Lyra TOML, or re-add the provider with /provider add.`;
    case "none": return `[providers.${name}] declares no credential; add one with /provider add if the endpoint needs it.`;
  }
}

function messageOf(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/\.$/, "");
}
