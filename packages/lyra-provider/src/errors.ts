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
}

export class ProviderFault extends Error {
  readonly classification: ProviderErrorClass;
  readonly providerMessage: string;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly raw: unknown;

  constructor(options: {
    classification: ProviderErrorClass;
    providerMessage: string;
    status?: number;
    code?: string;
    retryAfterMs?: number;
    raw?: unknown;
    cause?: unknown;
  }) {
    super(options.providerMessage, { cause: options.cause });
    this.name = "ProviderFault";
    this.classification = options.classification;
    this.providerMessage = options.providerMessage;
    this.status = options.status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.raw = options.raw;
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
  "rate_limit_exceeded",
  "overloaded_error",
  "server_error",
  "upstream_unavailable",
  "service_unavailable",
  "connection_reset",
  "stream_stalled",
  "timeout",
]);

export function classifyProviderError(input: ProviderErrorInput): ProviderFault {
  if (input.cause instanceof ProviderFault) return input.cause;

  const extracted = extractError(input.body);
  const status = input.status;
  const code = normalizeCode(input.code ?? extracted.code);
  const providerMessage =
    input.message ?? extracted.message ?? messageFromCause(input.cause) ?? "Unknown provider error";
  const retryAfterMs = parseRetryAfter(input.headers);
  const classification = classify(status, code, providerMessage.toLowerCase(), input.cause);

  return new ProviderFault({
    classification,
    providerMessage,
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(input.body === undefined ? {} : { raw: input.body }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
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
  if (status === 408 || status === 429 || status === 502 || status === 503 || status === 529) return "transient";
  if (status !== undefined && status >= 500) return "transient";

  if (message.includes("context") && (message.includes("long") || message.includes("length"))) {
    return "context_overflow";
  }
  if (message.includes("quota") || message.includes("credit") || message.includes("billing")) {
    return "quota";
  }
  if (message.includes("refus") || message.includes("content policy")) return "refusal";
  if (message.includes("model") && (message.includes("not found") || message.includes("deprecated"))) {
    return "model_unavailable";
  }
  if (isTransientCause(cause)) return "transient";

  return "bad_request";
}

function extractError(body: unknown): { code?: string; message?: string } {
  if (!isRecord(body)) return {};
  const nested = isRecord(body.error) ? body.error : body;
  const code = stringValue(nested.code) ?? stringValue(nested.type);
  const message = stringValue(nested.message) ?? stringValue(body.message);
  return {
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  };
}

function normalizeCode(code: string | undefined): string | undefined {
  return code?.trim().toLowerCase().replaceAll("-", "_");
}

function messageFromCause(cause: unknown): string | undefined {
  return cause instanceof Error ? cause.message : undefined;
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
