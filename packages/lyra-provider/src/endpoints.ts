import type { HttpTransportConfig } from "./auth.ts";
import { fetchWithHeadersDeadline } from "./sse.ts";

/**
 * Where a provider's routes live, decided once for every transport.
 *
 * ## The rule
 *
 * **`base_url` is the exact prefix Lyra joins a route onto.** Every api_type shares it:
 *
 * | api_type            | request                          |
 * | ------------------- | -------------------------------- |
 * | openai_completions  | `{base}/chat/completions`        |
 * | openai_responses    | `{base}/responses`               |
 * | openai_websocket    | `{base}/responses` over ws(s)    |
 * | anthropic_messages  | `{base}/messages`                |
 * | *(all of them)*     | `{base}/models` for discovery    |
 *
 * Canonically that prefix **carries the API version segment**, because that is where every
 * ecosystem actually serves: `https://api.openai.com/v1`, `https://api.anthropic.com/v1`,
 * `http://localhost:4100/v1`, and a gateway's own versioned prefix `https://host/api/v1`
 * unchanged. [`canonicalBaseUrl`] is that convention as a function, and `provider/add`
 * persists what it returns.
 *
 * This replaces four transports that each joined differently — the Anthropic transport
 * hard-coded `/v1/messages` while model discovery appended `/v1/models` only when the base
 * did *not* already end in `/v1`. A base of `https://proxy/v1` therefore made discovery
 * (and so `provider/detect`) succeed at `https://proxy/v1/models` while the very first turn
 * asked for `https://proxy/v1/v1/messages` and came back `404` with an empty body. One rule,
 * written once, is what makes those two agree.
 *
 * ## The forgiveness
 *
 * Users paste both shapes, and hand-written configs predate this rule, so a base that is one
 * `/v1` away from correct still has to work. Every route therefore has an **alternate**:
 * the same route under the base with its version segment added, or removed, whichever it did
 * not have. [`fetchProviderRoute`] tries the exact join first and, on a `404` from a request
 * that has not streamed anything yet, tries the alternate exactly once. What answered is
 * remembered in memory for that provider, and the caller is told — with the `base_url` to
 * write down — so a healed config never becomes a silent permanent divergence.
 */
export type ProviderRoute =
  | "chat/completions"
  | "responses"
  | "responses/compact"
  | "messages"
  | "models";

/** A route this module never guesses at: whatever the caller passed, joined verbatim. */
export type ProviderPath = ProviderRoute | (string & {});

/** Trailing slashes are noise; every join here starts from the base without them. */
function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * A base someone typed without a scheme, given one. `http` for anything that is
 * plainly a machine on the desk or the LAN — `localhost`, loopback, an IP
 * literal — and `https` for a hostname, because that is what a hostname on the
 * internet means. Note the `://` requirement in the test: `localhost:4100`
 * would otherwise parse as a URL whose *scheme* is `localhost`.
 */
function ensureScheme(clean: string): string {
  if (clean.length === 0 || HAS_SCHEME.test(clean)) return clean;
  const host = clean.replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const local = host === "localhost"
    || host === "::1"
    || host === "0.0.0.0"
    || /^127\./.test(host)
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  return `${local ? "http" : "https"}://${clean}`;
}

/**
 * The prefix a route can actually be joined onto, whatever shape was pasted:
 * scheme added when missing, trailing slashes gone, and a full route someone
 * copied from a doc page (`…/v1/messages`) cut back to the prefix it hangs
 * off — a base that already names a route can never be joined onto, so
 * stripping it is always correct and costs no request. Every derivation in
 * this module starts here, which is what makes `localhost:4100`,
 * `http://localhost:4100/v1`, and `http://localhost:4100/v1/messages` the
 * same provider out of the box.
 */
function prefixBase(baseUrl: string): string {
  let clean = ensureScheme(trimBase(baseUrl));
  const pasted = PASTED_ROUTES.exec(clean);
  if (pasted !== null) clean = trimBase(clean.slice(0, pasted.index));
  return clean;
}

/**
 * A base URL whose last path segment is an API version — `v1`, `v2`, `v1beta`, `v1alpha1`,
 * in whichever ecosystem's spelling — with that segment captured.
 */
const VERSIONED_BASE = /^(.*)\/(v\d[a-z0-9._-]*)$/i;

/** The routes a user is most likely to paste in full, having copied them from a doc page. */
const PASTED_ROUTES = /\/(?:chat\/completions|responses\/compact|responses|messages|completions|embeddings|models)$/;

/** One route under one base, joined exactly. This is the whole resolution rule. */
export function providerEndpoint(baseUrl: string, route: ProviderPath): string {
  return `${prefixBase(baseUrl)}/${route.replace(/^\/+/, "")}`;
}

/**
 * The base one version segment away from this one: added when it is absent, removed when it
 * is present. It is the *only* alternative Lyra will try, because it is the only difference
 * that has ever been the cause — the `/v1`-or-not convention differs by ecosystem, and both
 * shapes are pasted by users who have no way to know which one this endpoint wants.
 */
export function alternateBaseUrl(baseUrl: string): string {
  const clean = prefixBase(baseUrl);
  const versioned = VERSIONED_BASE.exec(clean);
  return versioned === null ? `${clean}/v1` : versioned[1]!;
}

/** Both URLs a route could plausibly live at, most likely first. */
export function providerEndpointCandidates(
  baseUrl: string,
  route: ProviderPath,
): { primary: string; alternate?: string } {
  const primary = providerEndpoint(baseUrl, route);
  const alternate = providerEndpoint(alternateBaseUrl(baseUrl), route);
  return alternate === primary ? { primary } : { primary, alternate };
}

/**
 * A base URL in the form Lyra writes into `providers.toml`.
 *
 * Purely syntactic — it never asks the network anything, so it is safe to apply to a base
 * that has not been probed. Three things happen:
 *
 * - trailing slashes go;
 * - a full route someone pasted (`…/v1/chat/completions`, `…/v1/messages`) is cut back to the
 *   prefix it hangs off, because a base that already names a route can never be joined onto;
 * - a base with no path at all gains `/v1`, since no ecosystem serves its API from a host
 *   root, and a bare origin is what "I pasted the host" looks like.
 *
 * A base carrying a query string or fragment is returned untouched apart from the trim:
 * those belong to deployments (Azure's `?api-version=`) whose shape this function has no
 * business rewriting.
 */
export function canonicalBaseUrl(baseUrl: string): string {
  const clean = prefixBase(baseUrl);
  let url: URL;
  try { url = new URL(clean); } catch { return clean; }
  if (url.search.length > 0 || url.hash.length > 0) return clean;
  let path = url.pathname.replace(/\/+$/, "");
  const pasted = PASTED_ROUTES.exec(path);
  if (pasted !== null) path = path.slice(0, pasted.index);
  if (path.length === 0) path = "/v1";
  return `${url.origin}${path}`;
}

/**
 * Which shape of base actually answered for a provider, once something has.
 *
 * Keyed by provider id *and* base URL, so re-adding a provider with a corrected base starts
 * from a clean slate rather than inheriting the previous base's verdict. In memory only: the
 * config file is the user's, and a process that quietly rewrote it would be doing exactly the
 * thing this whole module exists to make visible.
 */
type Variant = "exact" | "alternate";
interface Learned { variant: Variant }
const learned = new Map<string, Learned>();

function learnedKey(config: HttpTransportConfig): string {
  return `${config.id} ${trimBase(config.baseUrl)}`;
}

/** Forgets every learned variant. Tests only: a process never needs to un-learn. */
export function forgetLearnedBaseUrls(): void {
  learned.clear();
}

/** The URL a route resolves to right now, including anything a 404 already taught us. */
export function resolvedProviderEndpoint(config: HttpTransportConfig, route: ProviderPath): string {
  const candidates = providerEndpointCandidates(config.baseUrl, route);
  return learned.get(learnedKey(config))?.variant === "alternate" && candidates.alternate !== undefined
    ? candidates.alternate
    : candidates.primary;
}

/**
 * One provider request, against the base URL shape that works.
 *
 * The retry is deliberately narrow. It happens only on `404` — the one status that means
 * "there is nothing at this path", as opposed to a request this endpoint disliked — and only
 * before a single byte of the response has been read, so replaying it cannot duplicate a
 * completion, a charge, or anything else. A second 404 ends it: the answer returned is the
 * *configured* shape's, because that is the one whose URL the user can act on.
 *
 * The resolution is silent by design (owner decision, 2026-08-10): a `base_url` names the
 * prefix where the API lives, with or without its version segment, and finding the exact
 * route is this module's job — normal behaviour, not a misconfiguration to announce.
 */
export async function fetchProviderRoute(
  config: HttpTransportConfig,
  route: ProviderPath,
  init: RequestInit,
  headersTimeoutMs: number,
): Promise<{ response: Response; url: string }> {
  const key = learnedKey(config);
  const candidates = providerEndpointCandidates(config.baseUrl, route);
  const known = learned.get(key)?.variant;
  const first = known === "alternate" && candidates.alternate !== undefined
    ? candidates.alternate
    : candidates.primary;
  const second = known === undefined && first === candidates.primary ? candidates.alternate : undefined;

  const response = await fetchWithHeadersDeadline(first, init, headersTimeoutMs);
  if (response.status !== 404 || second === undefined) {
    if (known === undefined && response.status !== 404) learned.set(key, { variant: "exact" });
    return { response, url: first };
  }

  const retry = await fetchWithHeadersDeadline(second, init, headersTimeoutMs);
  if (retry.status === 404) {
    await discard(retry);
    return { response, url: first };
  }
  await discard(response);
  learned.set(key, { variant: "alternate" });
  return { response: retry, url: second };
}

/** A response nobody will read. Cancelling it frees the socket instead of waiting for a GC. */
async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* already closed; nothing to release */ }
}
