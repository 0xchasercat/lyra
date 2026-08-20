import { resolve as resolvePath } from "node:path";
import { authPluginRoot, cachedModels, createProviderTransport, loadProviderConfig, ProviderFault, ReliableProvider, resolveProvider, resolveModelRole } from "@lyra/provider";
import type { AuthConfig, AuthSource, ModelInfo, ProviderDefinition, ProviderFileConfig, ProviderTransport, ResolveProviderOptions } from "@lyra/provider";
import { saveProviderResponseChaining } from "./provider-setup.ts";

export interface EnvironmentProviderOptions {
  configPath?: string;
  configPaths?: readonly string[];
  model?: string;
  maxAttempts?: number;
  /**
   * `reliability.stream_stall_timeout`: the gap allowed *between* events once the stream has
   * produced output (§3.3). Time to first token is not bounded by it — that wait is a model
   * thinking, and only the turn deadline bounds it.
   */
  streamStallTimeoutMs?: number;
  turnTimeoutMs?: number;
  /** Home directory auth plugins are read from. Defaults to the real one; tests point it away. */
  home?: string;
  /**
   * Where a boot-time degradation is said out loud.
   *
   * A configuration can name a provider that is not there — `[roles].default` left pointing at
   * one that was removed, a `--model` whose provider was never added — and that is a *stale*
   * configuration, not a broken one. [`createEnvironmentProvider`] boots on a fallback rather
   * than throwing (see there), and this is the one line that says so.
   */
  onNotice?: (message: string) => void;
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

/**
 * Boot an environment from configuration on disk, degrading rather than crashing when that
 * configuration has gone stale.
 *
 * The observed failure: a provider was removed and `[roles].default` kept naming it, so the
 * next launch threw `Provider "alex" is not configured` out of `createConfiguredProvider` —
 * uncaught, as a raw stack trace, from a process that had already spawned the TUI. Nothing
 * about that is a decision the user has to make before Lyra can run: another provider *is*
 * configured, and running on it beats not running at all.
 *
 * So a reference whose provider is missing while other providers exist is not an error here.
 * The deterministic fallback ([`chooseFallbackReference`]) is booted instead and `onNotice`
 * carries one actionable line about it. Every other way a reference can be wrong — a role that
 * does not exist, a malformed `provider/model`, a provider that is configured but unusable —
 * still throws, because those name something to fix rather than something merely out of date.
 *
 * When nothing at all is configured the caller's unconfigured path applies; when the only
 * providers left have no model to name, this returns an unconfigured environment carrying the
 * same sentence, so the daemon comes up and `/provider` and `/model` are reachable.
 */
export async function createEnvironmentProvider(options: EnvironmentProviderOptions = {}): Promise<EnvironmentProvider> {
  const config = await loadProviderConfig(options.configPaths ?? options.configPath);
  const missing = missingProviderFor(config, options.model);
  if (missing === undefined) return createConfiguredProvider(config, options);
  const candidates = Object.entries(config.providers).map(([name, definition]) => ({ name, models: definition.models ?? [] }));
  const fallback = await chooseFallbackReference(candidates, options.home === undefined ? {} : { home: options.home });
  const source = options.model === undefined
    ? `[roles].default names provider ${missing}, which is not configured`
    : `--model ${options.model} names provider ${missing}, which is not configured`;
  if (fallback === undefined) {
    const reason = `${source}, and no other configured provider declares a model to fall back to (${Object.keys(config.providers).sort().join(", ")}). Pick one with /model, register a model with "/model add <provider> <id>", or fix [roles].default in Lyra TOML.`;
    options.onNotice?.(reason);
    return createUnconfiguredEnvironment(config, reason);
  }
  options.onNotice?.(`${source} — running on ${fallback}; use /model to choose another, or fix [roles].default in Lyra TOML.`);
  return createConfiguredProvider(config, { ...options, model: fallback });
}

/**
 * The provider a reference names and the configuration does not have — the one shape of
 * staleness that is safe to boot around. `undefined` for every reference that resolves to a
 * configured provider, and for every configuration that has no provider at all (that is the
 * unconfigured path, which the caller already handles).
 *
 * The bare-id rule is the same one [`createConfiguredProvider`] applies, because a bare id is
 * resolved against `[roles].default`'s provider: `--model gpt-5.6` against a default that
 * names a removed provider is the same staleness by another route.
 */
function missingProviderFor(config: ProviderFileConfig, model: string | undefined): string | undefined {
  if (Object.keys(config.providers).length === 0) return undefined;
  if (model === undefined && config.roles.default === undefined) return undefined;
  // A role that does not exist is a typo, not staleness: it still throws, from the one place
  // that lists the roles that do exist.
  const reference = resolveModelRole(model ?? "@default", config.roles);
  const separator = reference.indexOf("/");
  const name = separator > 0
    ? reference.slice(0, separator)
    : config.roles.default?.split("/")[0] ?? Object.keys(config.providers)[0]!;
  return config.providers[name] === undefined ? name : undefined;
}

/** A provider a fallback may land on: its name, and the models it declares. */
export interface FallbackCandidate { name: string; models: readonly string[] }

/**
 * Which `provider/model` a stale configuration lands on, decided the same way every time.
 *
 * Deterministic on purpose: alphabetical order, and the first candidate that has a model at
 * all. Declared models are preferred over discovered ones across the whole set — a provider
 * someone wrote `models = [...]` for is a provider they meant to use, and a cache is only
 * evidence that some endpoint answered once. A candidate with neither is skipped rather than
 * turned into a `provider/` reference nothing can serve.
 */
export async function chooseFallbackReference(
  candidates: readonly FallbackCandidate[],
  options: { home?: string } = {},
): Promise<string | undefined> {
  const sorted = [...candidates].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const candidate of sorted) {
    const declared = candidate.models[0];
    if (declared !== undefined && declared.length > 0) return `${candidate.name}/${declared}`;
  }
  for (const candidate of sorted) {
    let cached: readonly ModelInfo[] | undefined;
    try { cached = await cachedModels(candidate.name, options.home === undefined ? undefined : resolvePath(options.home, ".lyra", "providers")); }
    catch { continue; /* an unreadable cache is no candidate, not a failed fallback */ }
    const first = cached?.[0]?.id;
    if (first !== undefined && first.length > 0) return `${candidate.name}/${first}`;
  }
  return undefined;
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
  // An endpoint that cannot chain Responses turns teaches Lyra so on its first refusal; the
  // lesson is written onto the provider so the next session opens already knowing it. Best
  // effort by design: a read-only or unwritable config still runs, it just relearns next time.
  const transport = createProviderTransport({
    ...resolved,
    onChainingUnsupported: (): void => {
      void saveProviderResponseChaining(providerName, false, {
        ...(options.home === undefined ? {} : { home: options.home }),
      }).catch(() => { /* remembering is an optimisation, never a reason to fail a turn */ });
    },
  });
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
  const fault = await probeProviderCredential(name, definition, options);
  if (fault === undefined) return;
  throw new Error(
    fault.kind === "config"
      ? `Cannot select ${reference}: its configuration is not usable — ${fault.detail}. ${fault.remedy}`
      : `Cannot select ${reference}: ${fault.detail}. ${fault.remedy}`,
    { cause: fault.cause },
  );
}

/** Which precondition a provider failed, for a caller that words the two differently. */
interface ProviderCredentialFault {
  kind: "config" | "credential";
  detail: string;
  remedy: string;
  cause: unknown;
}

/**
 * The work of [`assertProviderUsable`], minus the sentence it wraps around the answer.
 *
 * Separated because two callers ask the same question in different words: selecting a
 * provider for this session, and checking that a *child's* model reference can serve a turn.
 * Sharing the sentence would have made a spawn rejection read as `Cannot select …`, which is
 * about a command the caller never ran.
 */
async function probeProviderCredential(
  name: string,
  definition: ProviderDefinition,
  options: { timeoutMs?: number; signal?: AbortSignal; home?: string },
): Promise<ProviderCredentialFault | undefined> {
  let auth: AuthSource | undefined;
  try {
    // Plugin auth is resolved and *run* here like any other source: the same 10s bound covers
    // importing the plugin module and its `getToken`, so a plugin that hangs on a network call
    // costs a deadline at selection time instead of the first turn.
    auth = resolveProvider(name, definition, pluginOptions(options.home)).auth;
  } catch (cause) {
    return { kind: "config", detail: messageOf(cause), remedy: `Fix [providers.${name}] in Lyra TOML, or re-add the provider with /provider add.`, cause };
  }
  if (auth === undefined) return undefined;
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
    return undefined;
  } catch (cause) {
    // A caller that cancelled gets its own cancellation back, not a provider verdict.
    if (options.signal?.aborted === true) throw cause;
    const detail = deadline.signal.aborted
      ? `${credentialSource(definition.auth)} did not answer within ${timeoutMs}ms`
      : messageOf(cause);
    return { kind: "credential", detail, remedy: credentialRemedy(name, definition.auth), cause };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which of the four things a `provider/model` reference can get wrong.
 *
 * They are separate because they call for four different actions — register a provider, pick
 * a different model, fix a credential, name a role that exists — and reporting them in one
 * voice is what turned a mistyped model into the unactionable `model: opus-5`.
 */
export type ModelReferenceFault = "role" | "provider" | "model" | "credential";

export class ModelReferenceError extends Error {
  readonly fault: ModelReferenceFault;
  /** The reference exactly as the caller wrote it, prefix and all. */
  readonly reference: string;
  readonly provider?: string;
  readonly model?: string;

  constructor(fault: ModelReferenceFault, reference: string, message: string, parts: { provider?: string; model?: string; cause?: unknown } = {}) {
    super(message, parts.cause === undefined ? undefined : { cause: parts.cause });
    this.name = "ModelReferenceError";
    this.fault = fault;
    this.reference = reference;
    if (parts.provider !== undefined) this.provider = parts.provider;
    if (parts.model !== undefined) this.model = parts.model;
  }
}

/** How many of a provider's models a rejection lists before it says how many it left out. */
const MODEL_SUGGESTION_LIMIT = 8;

export interface ModelReferenceCheckOptions {
  /** The provider a bare model id belongs to. Without one, `[roles].default`'s provider is used. */
  defaultProvider?: string;
  /** Home directory auth plugins and the model cache are read from. Tests point it away. */
  home?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Whether a `provider/model` reference can serve a turn — the whole question, answered before
 * anything commits to it.
 *
 * [`assertProviderUsable`] answers two thirds of it: the provider exists and its credential
 * source produces a credential. The third is the one that got away. A live session ran
 * `spawn { model: "claude-max/opus-5" }` against a configured, authenticated `claude-max`
 * whose models are all spelled `claude-…`; nothing checked the model at all, so the spawn
 * returned a running handle and the endpoint's own `model: opus-5` arrived minutes later,
 * through the bus, with the provider prefix stripped off it.
 *
 * So the model is checked here, against what the provider declares and what discovery
 * cached — but only when there is a list to check against. A provider with no `/models`
 * route and no declared ids can only be proven wrong by asking it, and refusing a model on
 * the strength of an empty list would ground every such provider.
 */
export async function assertModelReferenceUsable(
  config: ProviderFileConfig,
  reference: string,
  options: ModelReferenceCheckOptions = {},
): Promise<void> {
  const written = reference.trim();
  if (written.length === 0) throw new ModelReferenceError("model", written, `A model reference is required, in the form "provider/model" — for example "${config.roles.default ?? "anthropic/claude-opus-5"}".`);
  let resolved: string;
  try {
    resolved = resolveModelRole(written, config.roles);
  } catch (cause) {
    // `@fast` with no `[roles].fast` is its own mistake, and `resolveModelRole` already lists
    // the roles that do exist; only the reference the caller actually typed is added.
    throw new ModelReferenceError("role", written, `Cannot use model ${JSON.stringify(written)}: ${messageOf(cause)}.`, { cause });
  }
  const separator = resolved.indexOf("/");
  const providerName = separator > 0
    ? resolved.slice(0, separator)
    : options.defaultProvider ?? config.roles.default?.split("/")[0] ?? Object.keys(config.providers)[0] ?? "";
  const model = separator > 0 ? resolved.slice(separator + 1) : resolved;
  const definition = config.providers[providerName];
  if (definition === undefined) {
    const configured = Object.keys(config.providers).join(", ") || "none";
    throw new ModelReferenceError("provider", written, `Unknown provider in model ${JSON.stringify(written)}: nothing is configured under ${JSON.stringify(providerName)}. Configured providers: ${configured}. Add it with /provider add, or declare [providers.${providerName}] in Lyra TOML.`, { provider: providerName, model });
  }
  if (model.length === 0) {
    throw new ModelReferenceError("model", written, `Unknown model in ${JSON.stringify(written)}: the model half of the reference is empty. Write it as "${providerName}/<model>".`, { provider: providerName, model });
  }
  const known = await knownModels(providerName, definition, options.home);
  if (known.length > 0 && !known.includes(model)) {
    throw new ModelReferenceError("model", written, `Unknown model in ${JSON.stringify(written)}: provider ${providerName} is configured but does not serve ${JSON.stringify(model)}. ${describeCandidates(providerName, model, known)} Register it with /model add if ${providerName} serves it and its /models route does not list it.`, { provider: providerName, model });
  }
  const fault = await probeProviderCredential(providerName, definition, options);
  if (fault === undefined) return;
  throw new ModelReferenceError(
    "credential",
    written,
    fault.kind === "config"
      ? `Provider ${providerName} cannot serve ${JSON.stringify(written)}: its configuration is not usable — ${fault.detail}. ${fault.remedy}`
      : `Provider ${providerName} cannot serve ${JSON.stringify(written)}: ${fault.detail}. ${fault.remedy}`,
    { provider: providerName, model, cause: fault.cause },
  );
}

/**
 * Every model id this provider is known to serve: the ones it declares first, in the order
 * they were declared, then whatever discovery cached and the declaration did not name.
 *
 * Declared first because a hand-written `models = [...]` is a statement of intent, and it is
 * the list a user recognises when they are being told they got one of them wrong.
 */
async function knownModels(name: string, definition: ProviderDefinition, home: string | undefined): Promise<string[]> {
  const declared = definition.models ?? [];
  let discovered: string[] = [];
  try {
    // Cache only. Discovery is a network call, and a model check that reached out would turn
    // every spawn into a request against a provider the child may not even end up using.
    discovered = (await cachedModels(name, home === undefined ? undefined : resolvePath(home, ".lyra", "providers")))?.map((entry) => entry.id) ?? [];
  } catch { /* an unreadable cache is no list, and no list means no verdict */ }
  const seen = new Set(declared);
  return [...declared, ...discovered.filter((id) => !seen.has(id))];
}

/**
 * What the provider does have, and the one entry that is probably what was meant.
 *
 * The observed `opus-5` was `claude-opus-5` with the family prefix left off, which is a
 * near-miss no plain edit distance catches — the two differ by seven characters. Containment
 * is checked first for exactly that shape, and bounded edit distance covers the ordinary typo.
 */
function describeCandidates(provider: string, model: string, known: readonly string[]): string {
  const shown = known.slice(0, MODEL_SUGGESTION_LIMIT).join(", ");
  const overflow = known.length - Math.min(known.length, MODEL_SUGGESTION_LIMIT);
  const listed = `${provider} has: ${shown}${overflow > 0 ? ` (+${overflow} more)` : ""}`;
  const nearest = nearestModel(model, known);
  return `${listed}${nearest === undefined ? "." : ` — did you mean ${JSON.stringify(nearest)}?`}`;
}

function nearestModel(model: string, known: readonly string[]): string | undefined {
  const wanted = model.toLowerCase();
  // Containment first, and unbounded: an id that contains the whole of what was asked for is
  // a stronger signal than any distance, and `claude-opus-5` is seven edits from `opus-5`.
  // Scored by how much was missing, so it beats `claude-opus-4-8`, which contains it too.
  // Three characters minimum, because a two-character fragment is contained in everything.
  if (wanted.length >= 3) {
    const contained = nearest(known, (id) => (id.includes(wanted) || wanted.includes(id) ? Math.abs(id.length - wanted.length) : undefined));
    if (contained !== undefined) return contained;
  }
  const threshold = Math.max(2, Math.floor(wanted.length / 3));
  return nearest(known, (id) => { const score = boundedDistance(id, wanted); return score <= threshold ? score : undefined; });
}

/** The lowest-scoring candidate, where an undefined score means "not a candidate at all". */
function nearest(known: readonly string[], score: (id: string) => number | undefined): string | undefined {
  let best: { id: string; score: number } | undefined;
  for (const candidate of known) {
    const value = score(candidate.toLowerCase());
    if (value !== undefined && (best === undefined || value < best.score)) best = { id: candidate, score: value };
  }
  return best?.id;
}

/** Bounded edit distance, enough to tell `claude-opus-4` from `claude-opus-5` without a dependency. */
function boundedDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length]!;
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
