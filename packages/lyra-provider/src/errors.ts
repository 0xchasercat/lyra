export type ProviderErrorClass =
  | "transient"
  | "context_overflow"
  | "content_shape"
  | "auth"
  | "quota"
  | "model_unavailable"
  | "bad_request"
  | "refusal";

export interface ProviderErrorInput {
  status?: number;
  code?: string;
  message?: string;
  body?: unknown;
  headers?: Headers | Readonly<Record<string, string>>;
  cause?: unknown;
  /**
   * The full URL the failing request was sent to.
   *
   * A 404 is a statement about a *path*, and the path is exactly what the response body of a
   * 404 never contains — the reported failure was "HTTP 404 with an empty error body", from
   * which no user could tell that the request had gone to `…/v1/v1/messages`. Carried here so
   * the sentence a user reads can name it. Never a credential: query strings are not part of
   * any Lyra endpoint, and the URL is built from `base_url` and a fixed route.
   */
  url?: string;
}

export class ProviderFault extends Error {
  readonly classification: ProviderErrorClass;
  readonly providerMessage: string;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly raw: unknown;
  /** The full URL the request went to, when the failure came from one. */
  readonly url: string | undefined;

  constructor(options: {
    classification: ProviderErrorClass;
    providerMessage: string;
    status?: number;
    code?: string;
    retryAfterMs?: number;
    raw?: unknown;
    cause?: unknown;
    url?: string;
  }) {
    super(options.providerMessage, { cause: options.cause });
    this.name = "ProviderFault";
    this.classification = options.classification;
    this.providerMessage = options.providerMessage;
    this.status = options.status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.raw = options.raw;
    this.url = options.url;
  }
}

const CONTEXT_CODES = new Set([
  "context_length_exceeded",
  "context_window_exceeded",
  "prompt_too_long",
  "max_tokens_exceeded",
]);
const QUOTA_CODES = new Set([
  "insufficient_quota",
  "billing_hard_limit_reached",
  "credit_balance_too_low",
]);
const MODEL_CODES = new Set([
  "model_not_found",
  "model_deprecated",
  "model_overloaded",
  "unsupported_model",
]);
const AUTH_CODES = new Set([
  "authentication_error",
  "expired_token",
  "invalid_api_key",
  "invalid_auth",
  "token_expired",
  "unauthorized",
]);
const CONTENT_CODES = new Set([
  "invalid_role_sequence",
  "orphaned_tool_use",
  "invalid_tool_result",
  "invalid_image",
  "unsupported_content_block",
  "malformed_completion",
  "empty_turn",
  "stream_truncated",
]);
const REFUSAL_CODES = new Set(["content_policy_violation", "refusal"]);
const TRANSIENT_CODES = new Set([
  // Gateways spell an overloaded backend a dozen ways. The codes are collected here and the
  // wording is matched below, because neither list is ever complete on its own.
  "server_is_overloaded",
  "server_overloaded",
  "engine_overloaded",
  // A dropped response chain is a fact about the server's store, not about the request: the
  // transports rebuild the chain from scratch and the next attempt carries the whole
  // conversation. It only reaches this classifier when a transport could not swallow it —
  // mid-stream, after output — and there the right answer is a retry that resets what was
  // rendered, not a failed turn.
  "previous_response_not_found",
  "rate_limit_exceeded",
  "overloaded_error",
  "server_error",
  "upstream_unavailable",
  "service_unavailable",
  "connection_reset",
  "stream_stalled",
  "timeout",
]);

/**
 * Overflow usually arrives as an ordinary 400 whose only signal is prose.
 * Anthropic sends `invalid_request_error` with "prompt is too long: 213000 tokens
 * > 200000 maximum"; OpenAI sends "This model's maximum context length is 8192
 * tokens"; gateways phrase it as an exceeded token limit.
 */
const CONTEXT_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\b(?:prompt|input|request|messages?|conversation)\s+(?:is\s+|was\s+|are\s+|were\s+)?too\s+long\b/,
  /\bcontext\s+(?:window|length|limit|size)\b/,
  /\bcontext\b[^.]*\b(?:too\s+long|exceed)/,
  /\bexceeds?\s+(?:the\s+)?(?:model'?s?\s+)?(?:maximum|max)\b[^.]*\btokens?\b/,
  /\btokens?\s+limit\s+exceeded\b/,
  /\btoo\s+many\s+(?:input\s+|prompt\s+)?tokens\b/,
];
const QUOTA_MESSAGE_PATTERN = /\b(?:quota|credits?|billing)\b/;

/**
 * A chain the endpoint cannot resolve, stated in prose instead of as a code.
 *
 * OpenAI answers a stale `previous_response_id` with `previous_response_not_found`, which
 * needs no pattern. A gateway in front of a ChatGPT backend instead returns 403 with
 * "The service cannot safely review this request because its earlier conversation context is
 * unavailable or expired. Resend the complete context..." -- the same fact, and the same
 * recovery (resend the whole window), so it is read as the same code rather than surfacing
 * as a fatal permission error.
 */
const DROPPED_CHAIN_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\bearlier conversation context is (?:unavailable|expired)/,
  /\bresend the complete context\b/,
  /\bunsupported parameter:\s*previous_response_id\b/,
  /\bprevious[_ ]response[_ ]id\b[^.]*\b(?:not found|expired|unavailable|invalid)\b/,
  // The same gateway, refusing the same chained turn, in two wordings: which one it picks
  // depends on whether it could find a session for the id. Both mean the referenced turn is
  // not there to continue from, and both are answered by resending the whole window.
  /\bcannot safely review this (?:task|request)\b/,
  /\bstable session identifier\b/,
];

function isDroppedChainMessage(message: string): boolean {
  return DROPPED_CHAIN_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The provider refusing *our own* `max_tokens`, which is not a context overflow.
 *
 * The two collide because both are 400s whose prose is about tokens and maximums:
 * "max_tokens exceeds the maximum allowed number of output tokens" trips
 * `CONTEXT_MESSAGE_PATTERNS` word for word. Read as an overflow it triggers a pointless
 * compaction of a conversation that was never too long, and then surfaces the raw 400
 * anyway. The distinguishing signal is that a `max_tokens`-family request *field* is named,
 * so this is checked first and vetoes the overflow reading; recovery for it lives in
 * `output-limit.ts`, which lowers the ask and retries rather than compacting.
 */
const OUTPUT_CAP_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\bmax_?(?:tokens|output_tokens|completion_tokens)\b[^.]*\b(?:maximum|max|limit|allowed|greater|larger|exceed|too large)/,
  /\b(?:maximum|max)\b[^.]*\bnumber of (?:output|completion) tokens\b/,
  /\b(?:output|completion) tokens?\b[^.]*\b(?:exceeds?|above|greater than)\b/,
];

/** Whether a provider message is about our own output-token ask. Message must be lowercased. */
export function isOutputCapMessage(message: string): boolean {
  return OUTPUT_CAP_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

export function classifyProviderError(input: ProviderErrorInput): ProviderFault {
  if (input.cause instanceof ProviderFault) return input.cause;

  const extracted = extractError(input.body);
  const status = input.status;
  const code = normalizeCode(input.code ?? extracted.code);
  const providerMessage =
    input.message ?? extracted.message ?? messageFromCause(input.cause) ?? undescribedFailure(status, input.cause, input.url);
  const retryAfterMs = parseRetryAfter(input.headers);
  // A gateway that states a dropped chain in prose gets the code OpenAI would have sent, so
  // one recovery path serves both and a 403 saying so does not read as a revoked credential.
  const effectiveCode = code ?? (isDroppedChainMessage(providerMessage.toLowerCase()) ? "previous_response_not_found" : undefined);
  const classification = classify(status, effectiveCode, providerMessage.toLowerCase(), input.cause);

  return new ProviderFault({
    classification,
    providerMessage,
    ...(status === undefined ? {} : { status }),
    ...(effectiveCode === undefined ? {} : { code: effectiveCode }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(input.body === undefined ? {} : { raw: input.body }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
    ...(input.url === undefined ? {} : { url: input.url }),
  });
}

function classify(
  status: number | undefined,
  code: string | undefined,
  message: string,
  cause: unknown,
): ProviderErrorClass {
  if (code !== undefined) {
    if (CONTEXT_CODES.has(code)) return "context_overflow";
    if (QUOTA_CODES.has(code)) return "quota";
    if (MODEL_CODES.has(code)) return "model_unavailable";
    if (AUTH_CODES.has(code)) return "auth";
    if (CONTENT_CODES.has(code)) return "content_shape";
    if (REFUSAL_CODES.has(code)) return "refusal";
    if (TRANSIENT_CODES.has(code)) return "transient";
  }

  if (status === 401 || status === 403) return "auth";
  // A hard-quota 429 is permanent; retrying it only burns the retry budget.
  if (status === 429 && isQuotaMessage(message)) return "quota";
  if (status === 408 || status === 429 || status === 502 || status === 503 || status === 529) return "transient";
  if (status !== undefined && status >= 500) return "transient";

  if (isContextOverflowMessage(message)) return "context_overflow";
  if (isQuotaMessage(message)) return "quota";
  if (message.includes("refus") || message.includes("content policy")) return "refusal";
  if (message.includes("model") && (message.includes("not found") || message.includes("deprecated"))) {
    return "model_unavailable";
  }
  if (isTransientMessage(message)) return "transient";
  if (isTransientCause(cause)) return "transient";

  return "bad_request";
}

function isContextOverflowMessage(message: string): boolean {
  if (isOutputCapMessage(message)) return false;
  return CONTEXT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

function isQuotaMessage(message: string): boolean {
  return QUOTA_MESSAGE_PATTERN.test(message);
}

/**
 * A provider saying "not now" rather than "not this".
 *
 * An overloaded backend is the one failure that is certain to be temporary — the message
 * itself asks for a retry — and it reaches Lyra as an error event inside a 200 stream, so
 * there is no status to classify it by. Without this it falls through to `bad_request`, which
 * is fatal: a whole session dies of a condition that a few seconds of backoff would clear.
 *
 * The patterns stay narrow. "Try again" alone is not enough — plenty of permanent failures
 * suggest trying again after you fix something — so only wording that points at the server's
 * load or a deadline counts.
 */
const TRANSIENT_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\boverloaded\b/,
  /\bat capacity\b/,
  /\btemporarily unavailable\b/,
  /\btry again (?:later|shortly|in a (?:few|moment|little))/,
  /\bplease retry\b/,
];

function isTransientMessage(message: string): boolean {
  return TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

function extractError(body: unknown): { code?: string; message?: string } {
  // Not every gateway wraps its complaint in OpenAI's `{ error: { message } }`. A bare string
  // body and FastAPI's `{ "detail": ... }` are both common, and reading neither is why a
  // provider that said exactly what was wrong was reported as answering with an empty body.
  const plain = stringValue(body);
  if (plain !== undefined) return { message: plain };
  if (!isRecord(body)) return {};
  const detail = isRecord(body.detail) ? body.detail : undefined;
  const nested = isRecord(body.error) ? body.error : detail ?? body;
  const code = stringValue(nested.code) ?? stringValue(nested.type);
  const message = stringValue(nested.message)
    ?? stringValue(body.message)
    ?? stringValue(body.detail);
  return {
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  };
}

function normalizeCode(code: string | undefined): string | undefined {
  return code?.trim().toLowerCase().replaceAll("-", "_");
}

function messageFromCause(cause: unknown): string | undefined {
  const message = cause instanceof Error ? cause.message : undefined;
  return message === undefined || message.length === 0 ? undefined : message;
}

/**
 * What a failure is called when the provider described it with nothing at all — an error
 * response with an empty body, or a rejection that is not an `Error`.
 *
 * The status is the only fact such a failure carries, so it is the fact the sentence is
 * built from. The generic wording it replaced ("Unknown provider error") named neither what
 * happened nor where, and it reached users unchanged: an endpoint that answers 401 with a
 * zero-length body is the single most common way a freshly configured provider fails, and
 * that phrasing is what the whole turn was reported as.
 *
 * The URL joins it whenever there is one, because "HTTP 404 with an empty error body" is a
 * sentence about a path that does not name the path.
 */
function undescribedFailure(status: number | undefined, cause: unknown, url: string | undefined): string {
  const at = url === undefined ? "" : ` for ${url}`;
  if (status !== undefined) return `The provider answered HTTP ${status} with an empty error body${at}`;
  if (cause !== undefined && !(cause instanceof Error)) return `The provider request failed with a non-error value: ${describeValue(cause)}`;
  return "The provider request failed without reporting a reason";
}

function describeValue(value: unknown): string {
  if (typeof value === "object" && value !== null) return value.constructor?.name ?? "object";
  return typeof value === "string" ? value : String(value);
}

function isTransientCause(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  if (cause.name === "AbortError" || cause.name === "TimeoutError") return true;
  const error = cause as Error & { code?: string; cause?: unknown };
  if (error.code !== undefined && ["ECONNRESET", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET"].includes(error.code)) {
    return true;
  }
  return error.cause !== undefined && error.cause !== cause && isTransientCause(error.cause);
}

function parseRetryAfter(
  headers: Headers | Readonly<Record<string, string>> | undefined,
): number | undefined {
  if (headers === undefined) return undefined;
  const raw = headers instanceof Headers
    ? headers.get("retry-after")
    : Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  if (raw === null || raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
