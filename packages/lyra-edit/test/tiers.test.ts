import { describe, expect, test } from "bun:test";
import {
  applyContextualAnchor,
  applyExact,
  applySearchReplace,
  applyWhitespaceAgnostic,
  snapshotTag,
} from "../src/index.ts";

describe("sa3p tier port", () => {
  test("refuses duplicate exact matches instead of choosing the first", () => {
    const result = applyExact("token token token", "token", "value");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ambiguous_match");
      expect(result.matches).toHaveLength(3);
    }
  });

  test("uses whitespace matching only when exact matching misses", () => {
    const result = applySearchReplace(
      "function f() {\n    return 1;\n}\n",
      "function f() {\nreturn 1;\n}",
      "function f() {\n  return 2;\n}",
    );
    expect(result).toMatchObject({ ok: true, tier: "whitespace_agnostic" });
  });

  test("uses contextual matching within normalized length divided by three", () => {
    const result = applySearchReplace(
      "function calc() {\n  return total + fee;\n}\n",
      "function calc() {\n  return total + tax;\n}",
      "function calc() {\n  return total;\n}",
    );
    expect(result).toMatchObject({ ok: true, tier: "contextual_anchor" });
  });

  test("rejects equally close contextual windows", () => {
    const result = applyContextualAnchor(
      "alpha\none\nalpha\ntwo\n",
      "alpha\nzzz",
      "replacement",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ambiguous_match");
  });

  test("rejects tier no-ops and preserves hash normalization only for line endings", () => {
    const noOp = applyWhitespaceAgnostic("  alpha\n", "alpha", "  alpha");
    expect(noOp.ok).toBe(false);
    if (!noOp.ok) expect(noOp.code).toBe("no_op");
    expect(snapshotTag("a\r\nb\r\n")).toBe(snapshotTag("a\nb\n"));
    expect(snapshotTag("a\nb\n")).not.toBe(snapshotTag("a\nb!\n"));
  });
});
