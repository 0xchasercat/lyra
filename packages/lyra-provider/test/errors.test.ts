import { describe, expect, test } from "bun:test";
import {
  classifyProviderError,
  ProviderFault,
  type ProviderErrorClass,
  type ProviderErrorInput,
} from "../src/errors.ts";

describe("classifyProviderError adversarial inputs", () => {
  const cases: readonly [string, ProviderErrorInput, ProviderErrorClass][] = [
    ["429", { status: 429, message: "rate limited" }, "transient"],
    ["request timeout", { status: 408, message: "request timeout" }, "transient"],
    ["provider overload", { status: 529, message: "overloaded" }, "transient"],
    ["connection reset", { cause: codedError("socket reset", "ECONNRESET") }, "transient"],
    ["upstream unavailable", nested("upstream_unavailable", "proxy could not reach upstream", 400), "transient"],
    ["context code", nested("context_length_exceeded", "too many tokens"), "context_overflow"],
    ["context spelling", { message: "maximum context length is too long" }, "context_overflow"],
    [
      "openai context overflow",
      nested(
        "invalid_request_error",
        "This model's maximum context length is 8192 tokens. However, your messages resulted in 10000 tokens.",
      ),
      "context_overflow",
    ],
    ["gateway token limit", { status: 400, message: "Token limit exceeded for this request" }, "context_overflow"],
    ["hard quota 429", { status: 429, message: "You exceeded your current quota, please check your plan and billing details." }, "quota"],
    ["content shape", nested("orphaned-tool-use", "orphaned call"), "content_shape"],
    ["expired token", nested("expired_token", "token expired"), "auth"],
    ["auth status", { status: 403, message: "forbidden" }, "auth"],
    ["quota code", nested("insufficient_quota", "buy more credits", 429), "quota"],
    ["quota prose", { status: 400, message: "Credit balance is too low" }, "quota"],
    ["model code", nested("model_deprecated", "retired model"), "model_unavailable"],
    ["model prose", { message: "requested model was not found" }, "model_unavailable"],
    ["refusal code", nested("content_policy_violation", "cannot comply"), "refusal"],
    ["refusal prose", { message: "Provider refused this request" }, "refusal"],
    ["unknown", nested("brand_new_error", "unrecognized client failure", 400), "bad_request"],
  ];

  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(classifyProviderError(input).classification).toBe(expected);
    });
  }

  test("routes Anthropic's real overflow wire body to compaction, not bad_request", () => {
    const fault = classifyProviderError({
      status: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "prompt is too long: 213000 tokens > 200000 maximum",
        },
      },
    });
    expect(fault.classification).toBe("context_overflow");
    expect(fault.providerMessage).toBe("prompt is too long: 213000 tokens > 200000 maximum");
    expect(fault.code).toBe("invalid_request_error");
  });

  test("a hard-quota 429 is permanent while a plain 429 stays retryable", () => {
    expect(classifyProviderError({
      status: 429,
      message: "Your credit balance is too low to access the Anthropic API",
    }).classification).toBe("quota");
    expect(classifyProviderError({
      status: 429,
      message: "Rate limit reached for gpt-5.6 in organization org-x on requests per min",
    }).classification).toBe("transient");
  });

  test("known provider code wins over a generic status", () => {
    expect(classifyProviderError(nested("insufficient_quota", "hard ceiling", 429)).classification)
      .toBe("quota");
    expect(classifyProviderError(nested("model_overloaded", "model is busy", 503)).classification)
      .toBe("model_unavailable");
    expect(classifyProviderError(nested("refusal", "blocked", 500)).classification)
      .toBe("refusal");
  });

  test("explicit code wins over a contradictory body code", () => {
    const fault = classifyProviderError({
      status: 400,
      code: "invalid_role_sequence",
      body: { error: { code: "insufficient_quota", message: "provider detail" } },
    });
    expect(fault.classification).toBe("content_shape");
    expect(fault.providerMessage).toBe("provider detail");
  });

  test("preserves the provider message, raw body, status, and normalized code", () => {
    const body = {
      type: "error",
      error: { type: "Context-Window-Exceeded", message: "Exact Provider Wording: 17,001 > 16,384" },
    };
    const fault = classifyProviderError({ status: 400, body });
    expect(fault).toEqual(expect.objectContaining({
      classification: "context_overflow",
      providerMessage: "Exact Provider Wording: 17,001 > 16,384",
      status: 400,
      code: "context_window_exceeded",
      raw: body,
    }));
    expect(fault.message).toBe("Exact Provider Wording: 17,001 > 16,384");
  });

  test("does not mistake malformed bodies for classified provider errors", () => {
    for (const body of [null, [], "plain string", { error: [] }, { error: { code: 7, message: {} } }]) {
      const fault = classifyProviderError({ status: 400, body });
      expect(fault.classification).toBe("bad_request");
      // A body that describes nothing leaves the status as the only fact there is, and the
      // status is what the sentence is built from. It must never degrade into a phrase that
      // names neither what happened nor where: that wording used to reach the TUI verbatim
      // as the entire explanation of a failed turn.
      expect(fault.providerMessage).toBe("The provider answered HTTP 400 with an empty error body");
    }
  });

  test("describes an empty error response and a non-error rejection by what is actually known", () => {
    // The exact shape a fresh provider fails with: 401, zero-length body.
    expect(classifyProviderError({ status: 401, body: undefined })).toMatchObject({
      classification: "auth",
      providerMessage: "The provider answered HTTP 401 with an empty error body",
    });
    // A socket layer that rejects with an event rather than an Error still has to say so.
    expect(classifyProviderError({ cause: { kind: "close" } }).providerMessage).toContain("non-error value");
    expect(classifyProviderError({}).providerMessage).toBe("The provider request failed without reporting a reason");
    // An Error whose message is empty carries no more information than no Error at all.
    expect(classifyProviderError({ cause: new Error("") }).providerMessage).toBe("The provider request failed without reporting a reason");
  });

  test("uses Error messages without discarding the original cause", () => {
    const cause = new TypeError("fetch failed exactly");
    const fault = classifyProviderError({ cause });
    expect(fault.providerMessage).toBe("fetch failed exactly");
    expect(fault.cause).toBe(cause);
  });

  test("returns an existing ProviderFault unchanged", () => {
    const original = new ProviderFault({
      classification: "refusal",
      providerMessage: "verbatim refusal",
      raw: { private: "provider payload" },
    });
    expect(classifyProviderError({ status: 503, cause: original })).toBe(original);
  });

  test("honors numeric Retry-After case-insensitively", () => {
    const recordFault = classifyProviderError({
      status: 429,
      message: "wait",
      headers: { "rEtRy-AfTeR": "1.25" },
    });
    const headersFault = classifyProviderError({
      status: 503,
      message: "wait",
      headers: new Headers({ "Retry-After": "0" }),
    });
    expect(recordFault.retryAfterMs).toBe(1_250);
    expect(headersFault.retryAfterMs).toBe(0);
  });

  test("ignores invalid Retry-After values", () => {
    for (const retryAfter of ["-1", "not-a-date", "Infinity"] ) {
      expect(classifyProviderError({
        status: 429,
        message: "wait",
        headers: { "retry-after": retryAfter },
      }).retryAfterMs).toBeUndefined();
    }
  });
});

function nested(code: string, message: string, status = 400): ProviderErrorInput {
  return { status, body: { error: { code, message } } };
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}
