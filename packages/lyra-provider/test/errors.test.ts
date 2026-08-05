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
      expect(fault.providerMessage).toBe("Unknown provider error");
    }
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
