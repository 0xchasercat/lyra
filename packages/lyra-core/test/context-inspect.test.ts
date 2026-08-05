import { describe, expect, test } from "bun:test";
import { inspectContext } from "../src/context-inspect.ts";

describe("inspectContext", () => {
  test("shows the exact derived payload, repairs, markers, and token sections", () => {
    const payload = {
      model: "fixture-model",
      system: "stable system",
      tools: [],
      messages: [{
        id: "m1",
        role: "user" as const,
        content: [{ type: "marker" as const, reason: "image_dropped" as const, detail: "too large" }],
      }],
    };
    const repairs = [{ code: "image_dropped" as const, detail: "too large", entryId: "e1", tokenEstimate: 10 }];
    const inspection = inspectContext({
      request: payload,
      repairs,
      tokenEstimate: 42,
      sourceEntryIds: ["e1"],
    }, 200_000, ["after-system"]);

    expect(inspection.payload).toBe(payload);
    expect(inspection.repairs).toBe(repairs);
    expect(inspection.lossMarkers).toEqual([{
      messageId: "m1",
      reason: "image_dropped",
      detail: "too large",
    }]);
    expect(inspection.cacheBreakpoints).toEqual(["after-system"]);
    expect(inspection.sections.map((section) => section.name)).toEqual(["system", "tools", "message:m1"]);
    expect(inspection.tokenEstimate).toBe(42);
  });
});
