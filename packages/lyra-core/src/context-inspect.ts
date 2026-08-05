import type { ProviderRequest } from "@lyra/provider";
import type { ContextRepair, DerivedContext } from "./types.ts";

export interface ContextSectionUsage {
  name: string;
  tokens: number;
}

export interface ContextInspection {
  payload: ProviderRequest;
  repairs: readonly ContextRepair[];
  lossMarkers: Array<{ messageId: string; reason: string; detail: string }>;
  cacheBreakpoints: readonly string[];
  tokenEstimate: number;
  contextWindow: number;
  sections: ContextSectionUsage[];
  sourceEntryIds: readonly string[];
}

export function inspectContext(
  context: DerivedContext,
  contextWindow: number,
  cacheBreakpoints: readonly string[] = [],
): ContextInspection {
  const payload = context.request;
  const sections: ContextSectionUsage[] = [
    { name: "system", tokens: estimate(payload.system) },
    { name: "tools", tokens: estimate(payload.tools) },
    ...payload.messages.map((message) => ({
      name: `message:${message.id}`,
      tokens: estimate(message),
    })),
  ];
  const lossMarkers: ContextInspection["lossMarkers"] = [];
  for (const message of payload.messages) {
    for (const block of message.content) {
      if (block.type !== "marker") continue;
      lossMarkers.push({ messageId: message.id, reason: block.reason, detail: block.detail });
    }
  }
  return {
    payload,
    repairs: context.repairs,
    lossMarkers,
    cacheBreakpoints,
    tokenEstimate: context.tokenEstimate,
    contextWindow,
    sections,
    sourceEntryIds: context.sourceEntryIds,
  };
}

function estimate(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(new TextEncoder().encode(text).byteLength / 3);
}
