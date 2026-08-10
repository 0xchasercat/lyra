import { classifyProviderError } from "@lyra/provider";
import type {
  CanonicalMessage,
  ContentBlock,
  ProviderApiType,
  ProviderRequest,
  ToolResultBlock,
  ToolUseBlock,
} from "@lyra/provider";
import type { CompactionBoundaryEntry, MessageEntry, TranscriptEntry } from "@lyra/session";
import type {
  ContextDerivationOptions,
  ContextRepair,
  ContextRepairCode,
  DerivedContext,
} from "./types.ts";

const DEFAULT_IMAGE_BYTE_LIMIT = 5 * 1024 * 1024;

type WorkingMessage = CanonicalMessage & { sourceEntryIds: string[] };

export function deriveContext(
  entries: readonly TranscriptEntry[],
  options: ContextDerivationOptions,
): DerivedContext {
  if (!Number.isFinite(options.contextWindow) || options.contextWindow <= 0) {
    throw new RangeError("contextWindow must be a positive finite number");
  }
  const imageByteLimit = options.imageByteLimit ?? DEFAULT_IMAGE_BYTE_LIMIT;
  if (!Number.isFinite(imageByteLimit) || imageByteLimit <= 0) {
    throw new RangeError("imageByteLimit must be a positive finite number");
  }

  const repairs: ContextRepair[] = [];
  const active = activeEntries(entries);
  const normalized: WorkingMessage[] = [];
  if (active.summary !== undefined && active.summary.summary.length > 0) {
    normalized.push({
      id: `boundary-${active.summary.id}`,
      role: "user",
      content: [{ type: "text", text: `Compacted context:\n${active.summary.summary}` }],
      sourceEntryIds: [active.summary.id],
    });
  }

  for (const entry of active.entries) {
    if (entry.type !== "message") continue;
    const message = normalizeMessage(entry, options.apiType, imageByteLimit, repairs);
    if (message !== undefined) normalized.push(message);
  }

  const merged = mergeAdjacentRoles(normalized, repairs);
  const paired = pairToolCalls(merged, repairs);
  const messages = mergeAdjacentRoles(
    paired.filter((message) => {
      if (message.content.length > 0) return true;
      addRepair(repairs, "empty_content", "Dropped a message left empty after context repair", message.sourceEntryIds[0]!, message);
      return false;
    }),
    repairs,
  ).map(({ sourceEntryIds: _sourceEntryIds, ...message }) => message);

  const request: ProviderRequest = {
    model: options.model,
    system: options.system,
    messages,
    tools: options.tools,
  };
  const tokenEstimate = estimateTokens(request);
  if (tokenEstimate >= options.contextWindow) {
    throw classifyProviderError({
      code: "context_length_exceeded",
      message: `Derived context is approximately ${tokenEstimate} tokens, exceeding the ${options.contextWindow}-token model window; compact the transcript and retry`,
      body: { tokenEstimate, contextWindow: options.contextWindow },
    });
  }

  return {
    request,
    repairs: freshRepairs(entries, repairs),
    tokenEstimate,
    sourceEntryIds: unique([
      ...(active.summary === undefined ? [] : [active.summary.id]),
      ...paired.flatMap((message) => message.sourceEntryIds),
    ]),
  };
}

function freshRepairs(entries: readonly TranscriptEntry[], repairs: readonly ContextRepair[]): ContextRepair[] {
  const recorded = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "repair") continue;
    for (const repair of entry.repairs) recorded.add(repairKey(repair));
  }
  return repairs.filter((repair) => !recorded.has(repairKey(repair)));
}

function repairKey(repair: { code: string; detail: string; entryId?: string }): string {
  return `${repair.code}\u0000${repair.entryId ?? ""}\u0000${repair.detail}`;
}

function activeEntries(entries: readonly TranscriptEntry[]): {
  summary?: CompactionBoundaryEntry;
  entries: TranscriptEntry[];
} {
  const boundaryIndex = entries.findLastIndex((entry) => entry.type === "boundary");
  if (boundaryIndex < 0) return { entries: [...entries] };
  const boundary = entries[boundaryIndex] as CompactionBoundaryEntry;
  if (boundary.kind === "clear") return { entries: entries.slice(boundaryIndex + 1) };
  if (boundary.firstKeptEntry === null) {
    throw classifyProviderError({
      code: "malformed_completion",
      message: `Compaction boundary ${boundary.id} has no firstKeptEntry`,
      body: boundary,
    });
  }
  const keptIndex = entries.findIndex((entry) => entry.id === boundary.firstKeptEntry);
  if (keptIndex < 0 || keptIndex >= boundaryIndex) {
    throw classifyProviderError({
      code: "malformed_completion",
      message: `Compaction boundary ${boundary.id} references unavailable entry ${boundary.firstKeptEntry}`,
      body: boundary,
    });
  }
  return {
    summary: boundary,
    entries: [
      ...entries.slice(keptIndex, boundaryIndex),
      ...entries.slice(boundaryIndex + 1),
    ],
  };
}

function normalizeMessage(
  entry: MessageEntry,
  apiType: ProviderApiType,
  imageByteLimit: number,
  repairs: ContextRepair[],
): WorkingMessage | undefined {
  const original = structuredClone(entry.content);
  const content: ContentBlock[] = [];
  for (const block of original) {
    const normalized = normalizeBlock(block, entry, apiType, imageByteLimit, repairs);
    if (normalized !== undefined) content.push(normalized);
  }
  if (content.length === 0) {
    addRepair(repairs, "empty_content", "Dropped a message with no valid content blocks", entry.id, entry.content);
    return undefined;
  }
  const reasoning = content.filter((block) => block.type === "thinking" || block.type === "reasoning");
  const visible = content.filter((block) => block.type !== "thinking" && block.type !== "reasoning");
  const reordered = [...reasoning, ...visible];
  if (!sameBlockOrder(content, reordered)) {
    addRepair(
      repairs,
      "thinking_reordered",
      "Moved thinking and reasoning blocks before visible content in the assistant turn",
      entry.id,
      content,
    );
  }
  return {
    id: entry.id,
    role: entry.role,
    content: reordered,
    sourceEntryIds: [entry.id],
  };
}

function normalizeBlock(
  block: ContentBlock,
  entry: MessageEntry,
  apiType: ProviderApiType,
  imageByteLimit: number,
  repairs: ContextRepair[],
): ContentBlock | undefined {
  switch (block.type) {
    case "text":
      if (block.text.length > 0) return block;
      addRepair(repairs, "empty_content", "Dropped an empty text block", entry.id, block);
      return undefined;
    case "thinking":
      if (entry.role !== "assistant") {
        addRepair(repairs, "empty_content", "Dropped thinking from a user message", entry.id, block);
        return undefined;
      }
      if (block.thinking.length === 0) {
        addRepair(repairs, "empty_content", "Dropped an empty thinking block", entry.id, block);
        return undefined;
      }
      if (apiType === "anthropic_messages") {
        if (block.signature !== undefined && block.signature.length > 0) return block;
        addRepair(
          repairs,
          "thinking_signature_dropped",
          "Dropped Anthropic thinking whose signature was unavailable or invalid",
          entry.id,
          block,
        );
        return undefined;
      }
      if (apiType === "openai_responses" || apiType === "openai_websocket") {
        addRepair(
          repairs,
          "provider_reasoning_dropped",
          "Dropped Anthropic thinking while deriving an OpenAI Responses request; signed thinking does not map to a reasoning item",
          entry.id,
          block,
        );
        return undefined;
      }
      return block;
    case "reasoning":
      if (entry.role !== "assistant") {
        addRepair(repairs, "provider_reasoning_dropped", "Dropped reasoning from a user message", entry.id, block);
        return undefined;
      }
      if ((apiType === "openai_responses" || apiType === "openai_websocket") && isReasoningItem(block.raw)) {
        return block;
      }
      addRepair(
        repairs,
        "provider_reasoning_dropped",
        `Dropped an OpenAI reasoning item while deriving ${apiType}; the provider formats are not lossless`,
        entry.id,
        block,
      );
      return undefined;
    case "image": {
      const issue = entry.role === "assistant"
        ? "images are valid only in user messages"
        : imageIssue(block.mediaType, block.data, imageByteLimit);
      if (issue === undefined) return block;
      addRepair(repairs, "image_dropped", `Dropped image: ${issue}`, entry.id, block);
      return { type: "marker", reason: "image_dropped", detail: issue };
    }
    case "marker":
      if (block.detail.length > 0) return block;
      addRepair(repairs, "empty_content", `Dropped empty ${block.reason} marker`, entry.id, block);
      return undefined;
    case "tool_use":
      if (entry.role === "assistant") return block;
      addRepair(repairs, "empty_content", `Dropped tool call ${block.id} from a user message`, entry.id, block);
      return undefined;
    case "tool_result":
      if (entry.role === "user") return normalizeToolResult(block, entry, imageByteLimit, repairs);
      addRepair(repairs, "orphan_tool_result", `Dropped tool result ${block.toolUseId} from an assistant message`, entry.id, block);
      return undefined;
  }
}

/**
 * A tool result may carry images — a screenshot spilled to an artifact and read back is the
 * whole point of the browser path — and §3.6 applies to those exactly as it applies to an
 * image a user pasted. Validating only top-level blocks left the one route a picture actually
 * takes into the context unchecked, so an oversized or malformed one reached the provider as
 * a 400 instead of a marker the model could read.
 */
function normalizeToolResult(
  block: ToolResultBlock,
  entry: MessageEntry,
  imageByteLimit: number,
  repairs: ContextRepair[],
): ToolResultBlock {
  if (typeof block.content === "string") return block;
  let repaired = false;
  const content: ContentBlock[] = [];
  for (const nested of block.content) {
    if (nested.type !== "image") { content.push(nested); continue; }
    const issue = imageIssue(nested.mediaType, nested.data, imageByteLimit);
    if (issue === undefined) { content.push(nested); continue; }
    addRepair(repairs, "image_dropped", `Dropped image in tool result ${block.toolUseId}: ${issue}`, entry.id, nested);
    content.push({ type: "marker", reason: "image_dropped", detail: issue });
    repaired = true;
  }
  return repaired ? { ...block, content } : block;
}

function mergeAdjacentRoles(messages: readonly WorkingMessage[], repairs: ContextRepair[]): WorkingMessage[] {
  const output: WorkingMessage[] = [];
  for (const message of messages) {
    const previous = output.at(-1);
    if (previous === undefined || previous.role !== message.role) {
      output.push({
        id: message.id,
        role: message.role,
        content: [...message.content],
        sourceEntryIds: [...message.sourceEntryIds],
      });
      continue;
    }
    previous.content.push(...message.content);
    previous.sourceEntryIds.push(...message.sourceEntryIds);
    addRepair(
      repairs,
      "adjacent_role_merge",
      `Merged adjacent ${message.role} transcript entries ${previous.id} and ${message.id}`,
      message.sourceEntryIds[0]!,
      message,
    );
  }
  return output;
}

function pairToolCalls(messages: readonly WorkingMessage[], repairs: ContextRepair[]): WorkingMessage[] {
  const output: WorkingMessage[] = [];
  let pending = new Map<string, { call: ToolUseBlock; entryId: string }>();

  for (const message of messages) {
    if (message.role === "assistant") {
      if (pending.size > 0) output.push(syntheticResults(pending, repairs));
      output.push(message);
      pending = new Map();
      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        pending.set(block.id, { call: block, entryId: message.sourceEntryIds[0]! });
      }
      continue;
    }

    const results: ToolResultBlock[] = [];
    const visible: ContentBlock[] = [];
    const seenResults = new Set<string>();
    for (const block of message.content) {
      if (block.type !== "tool_result") {
        visible.push(block);
        continue;
      }
      const open = pending.get(block.toolUseId);
      if (open === undefined || seenResults.has(block.toolUseId)) {
        addRepair(
          repairs,
          "orphan_tool_result",
          `Dropped orphaned tool result ${block.toolUseId}`,
          message.sourceEntryIds[0]!,
          block,
        );
        continue;
      }
      results.push(block);
      seenResults.add(block.toolUseId);
      pending.delete(block.toolUseId);
    }
    if (pending.size > 0) {
      for (const [id, open] of pending) {
        results.push(interruptedResult(id));
        addRepair(
          repairs,
          "missing_tool_result",
          `Synthesized interrupted result for tool call ${open.call.name} (${id})`,
          open.entryId,
          open.call,
        );
      }
      pending.clear();
    }
    output.push({ ...message, content: [...results, ...visible] });
  }

  if (pending.size > 0) output.push(syntheticResults(pending, repairs));
  return output;
}

function syntheticResults(
  pending: ReadonlyMap<string, { call: ToolUseBlock; entryId: string }>,
  repairs: ContextRepair[],
): WorkingMessage {
  const first = pending.values().next().value as { call: ToolUseBlock; entryId: string };
  const content: ToolResultBlock[] = [];
  for (const [id, open] of pending) {
    content.push(interruptedResult(id));
    addRepair(
      repairs,
      "missing_tool_result",
      `Synthesized interrupted result for tool call ${open.call.name} (${id})`,
      open.entryId,
      open.call,
    );
  }
  return {
    id: `repair-tool-results-${first.entryId}`,
    role: "user",
    content,
    sourceEntryIds: [first.entryId],
  };
}

function interruptedResult(toolUseId: string): ToolResultBlock {
  return {
    type: "tool_result",
    toolUseId,
    content: "interrupted",
    isError: true,
  };
}

function sameBlockOrder(left: readonly ContentBlock[], right: readonly ContentBlock[]): boolean {
  return left.length === right.length && left.every((block, index) => block === right[index]);
}

function isReasoningItem(value: Readonly<Record<string, unknown>>): boolean {
  return value.type === "reasoning";
}

function imageIssue(mediaType: string, data: string, byteLimit: number): string | undefined {
  if (!mediaType.startsWith("image/")) return `unsupported media type ${mediaType || "(empty)"}`;
  if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return "image data is not valid base64";
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const bytes = data.length / 4 * 3 - padding;
  if (bytes > byteLimit) return `image is ${bytes} bytes, above the ${byteLimit}-byte limit`;
  return undefined;
}

function addRepair(
  repairs: ContextRepair[],
  code: ContextRepairCode,
  detail: string,
  entryId: string,
  value: unknown,
): void {
  repairs.push({ code, detail, entryId, tokenEstimate: estimateTokens(value) });
}

function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : stableJson(value);
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 3));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
