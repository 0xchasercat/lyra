import type {
  ProviderRequest,
  ReliableProviderEvent,
} from "@lyra/provider";
import type {
  CheckpointEntry,
  CompactionBoundaryEntry,
  EntryId,
  NewTranscriptEntry,
  TranscriptEntry,
} from "@lyra/session";

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_MESSAGE_TAIL = 8;
const SUMMARY_SYSTEM_PROMPT = `You compact an agent transcript. Summarize only the supplied older prefix.
Preserve decisions, constraints, unfinished work, errors, and facts needed to continue. Do not invent events.
The verbatim tail, active checkpoint, and pending tool calls are supplied separately and must not be repeated.`;

export interface SummaryRequest {
  entries: readonly TranscriptEntry[];
  latestCheckpoint?: CheckpointEntry;
  firstKeptEntry: EntryId;
  tokensBefore: number;
  targetTokens: number;
}

export interface SummaryGenerator {
  generate(request: SummaryRequest, signal?: AbortSignal): Promise<string>;
}

/** The provider surface needed to generate a real summary. ReliableProvider satisfies it. */
export interface SummaryProvider {
  stream(
    request: ProviderRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ReliableProviderEvent>;
}

export interface ProviderSummaryGeneratorOptions {
  provider: SummaryProvider;
  model: string;
  system?: string;
  maxOutputTokens?: number;
}

/** Summary generator backed by the same reliable provider stream used for agent turns. */
export class ProviderSummaryGenerator implements SummaryGenerator {
  readonly provider: SummaryProvider;
  readonly model: string;
  readonly system: string;
  readonly maxOutputTokens: number;

  constructor(options: ProviderSummaryGeneratorOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.system = options.system ?? SUMMARY_SYSTEM_PROMPT;
    this.maxOutputTokens = options.maxOutputTokens ?? 2_048;
  }

  async generate(request: SummaryRequest, signal?: AbortSignal): Promise<string> {
    const providerRequest: ProviderRequest = {
      model: this.model,
      system: this.system,
      tools: [],
      maxOutputTokens: this.maxOutputTokens,
      messages: [{
        id: `compaction-${request.firstKeptEntry}`,
        role: "user",
        content: [{
          type: "text",
          text: renderSummaryInput(request),
        }],
      }],
    };

    let summary = "";
    for await (const event of this.provider.stream(providerRequest, signal)) {
      if ((event.type === "retry" || event.type === "transport_fallback") && event.resetsPartialOutput) {
        summary = "";
      } else if (event.type === "text_delta") {
        summary += event.text;
      }
    }
    const trimmed = summary.trim();
    if (trimmed.length === 0) {
      throw new Error("Summary provider completed without summary text");
    }
    return trimmed;
  }
}

export interface CompactionTranscript {
  lineage(headId?: EntryId): readonly TranscriptEntry[];
  append(entry: NewTranscriptEntry): unknown;
}

export interface TokenEstimator {
  entries(entries: readonly TranscriptEntry[]): number;
  text(text: string): number;
}

export interface CompactorOptions {
  transcript: CompactionTranscript;
  summaryGenerator: SummaryGenerator;
  contextWindow: number;
  threshold?: number;
  messageTail?: number;
  tokenEstimator?: TokenEstimator;
  createId?: () => EntryId;
  now?: () => string;
}

export interface CompactOptions {
  tokensBefore?: number;
  force?: boolean;
  signal?: AbortSignal;
}

export type CompactionResult =
  | {
    compacted: false;
    reason: "below_threshold" | "nothing_to_summarize";
    tokensBefore: number;
  }
  | {
    compacted: true;
    boundary: CompactionBoundaryEntry;
    summarizedEntryIds: EntryId[];
    keptEntryIds: EntryId[];
  };

export interface ClearResult {
  boundary: CompactionBoundaryEntry;
}

/**
 * Appends boundaries without rewriting transcript history. A boundary selects a derived
 * context window; entries before it remain authoritative transcript records.
 */
export class Compactor {
  readonly threshold: number;
  readonly messageTail: number;
  readonly contextWindow: number;
  private readonly transcript: CompactionTranscript;
  private readonly summaryGenerator: SummaryGenerator;
  private readonly tokenEstimator: TokenEstimator;
  private readonly createId: () => EntryId;
  private readonly now: () => string;

  constructor(options: CompactorOptions) {
    if (!Number.isFinite(options.contextWindow) || options.contextWindow <= 0) {
      throw new RangeError("contextWindow must be a positive number");
    }
    const threshold = options.threshold ?? DEFAULT_THRESHOLD;
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
      throw new RangeError("threshold must be greater than 0 and at most 1");
    }
    const messageTail = options.messageTail ?? DEFAULT_MESSAGE_TAIL;
    if (!Number.isInteger(messageTail) || messageTail < 1) {
      throw new RangeError("messageTail must be a positive integer");
    }

    this.transcript = options.transcript;
    this.summaryGenerator = options.summaryGenerator;
    this.contextWindow = options.contextWindow;
    this.threshold = threshold;
    this.messageTail = messageTail;
    this.tokenEstimator = options.tokenEstimator ?? approximateTokenEstimator;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async compact(options: CompactOptions = {}): Promise<CompactionResult> {
    const lineage = [...this.transcript.lineage()];
    const activeEntries = activeContextEntries(lineage);
    const tokensBefore = options.tokensBefore ?? this.tokenEstimator.entries(activeEntries);
    if (!options.force && tokensBefore < this.contextWindow * this.threshold) {
      return { compacted: false, reason: "below_threshold", tokensBefore };
    }

    const splitIndex = firstPreservedIndex(activeEntries, this.messageTail);
    if (splitIndex <= 0 || splitIndex >= activeEntries.length) {
      return { compacted: false, reason: "nothing_to_summarize", tokensBefore };
    }

    const prefix = activeEntries.slice(0, splitIndex);
    const kept = activeEntries.slice(splitIndex);
    const firstKeptEntry = kept[0]!.id;
    const latestCheckpoint = findLatestCheckpoint(activeEntries);
    const summary = (await this.summaryGenerator.generate({
      entries: prefix,
      ...(latestCheckpoint === undefined ? {} : { latestCheckpoint }),
      firstKeptEntry,
      tokensBefore,
      targetTokens: Math.floor(this.contextWindow * this.threshold),
    }, options.signal)).trim();
    if (summary.length === 0) throw new Error("Summary generator returned an empty summary");

    const boundary: CompactionBoundaryEntry = {
      id: this.createId(),
      parentId: lineage.at(-1)?.id ?? null,
      timestamp: this.now(),
      type: "boundary",
      kind: "compaction",
      firstKeptEntry,
      summary,
      tokensBefore,
      tokensAfter: this.tokenEstimator.text(summary) + this.tokenEstimator.entries(kept),
    };
    this.transcript.append(boundary);
    return {
      compacted: true,
      boundary,
      summarizedEntryIds: prefix.map((entry) => entry.id),
      keptEntryIds: kept.map((entry) => entry.id),
    };
  }

  /** Append a hard boundary. Derivation after a clear starts with subsequent entries only. */
  clear(tokensBefore?: number): ClearResult {
    const lineage = [...this.transcript.lineage()];
    const activeEntries = activeContextEntries(lineage);
    const boundary: CompactionBoundaryEntry = {
      id: this.createId(),
      parentId: lineage.at(-1)?.id ?? null,
      timestamp: this.now(),
      type: "boundary",
      kind: "clear",
      firstKeptEntry: null,
      summary: "",
      tokensBefore: tokensBefore ?? this.tokenEstimator.entries(activeEntries),
      tokensAfter: 0,
    };
    this.transcript.append(boundary);
    return { boundary };
  }
}

function activeContextEntries(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const boundaryIndex = entries.findLastIndex((entry) => entry.type === "boundary");
  if (boundaryIndex < 0) return entries.filter(isContextEntry);
  const boundary = entries[boundaryIndex]!;
  if (boundary.type !== "boundary" || boundary.kind === "clear" || boundary.firstKeptEntry === null) {
    return entries.slice(boundaryIndex + 1).filter(isContextEntry);
  }
  const firstKeptIndex = entries.findIndex((entry) => entry.id === boundary.firstKeptEntry);
  if (firstKeptIndex < 0 || firstKeptIndex >= boundaryIndex) {
    return [boundary, ...entries.slice(boundaryIndex + 1).filter(isContextEntry)];
  }
  return [
    boundary,
    ...entries.slice(firstKeptIndex, boundaryIndex).filter(isContextEntry),
    ...entries.slice(boundaryIndex + 1).filter(isContextEntry),
  ];
}

function isContextEntry(entry: TranscriptEntry): boolean {
  return entry.type === "message" || entry.type === "checkpoint";
}

function firstPreservedIndex(entries: readonly TranscriptEntry[], messageTail: number): number {
  const preserved = new Set<number>();

  const checkpointIndex = entries.findLastIndex((entry) => entry.type === "checkpoint");
  if (checkpointIndex >= 0) preserved.add(checkpointIndex);

  const messageIndexes: number[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index]!.type === "message") messageIndexes.push(index);
  }
  for (const index of messageIndexes.slice(-messageTail)) preserved.add(index);

  const pendingIds = pendingToolCallIds(entries);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type !== "message") continue;
    if (entry.content.some((block) => block.type === "tool_use" && pendingIds.has(block.id))) {
      preserved.add(index);
    }
  }

  if (preserved.size === 0) return entries.length;
  return Math.min(...preserved);
}

function pendingToolCallIds(entries: readonly TranscriptEntry[]): Set<string> {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "checkpoint") {
      for (const id of entry.pendingToolCallIds) calls.add(id);
      continue;
    }
    if (entry.type !== "message") continue;
    for (const block of entry.content) {
      if (block.type === "tool_use") calls.add(block.id);
      if (block.type === "tool_result") results.add(block.toolUseId);
    }
  }
  for (const id of results) calls.delete(id);
  return calls;
}

function findLatestCheckpoint(entries: readonly TranscriptEntry[]): CheckpointEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type === "checkpoint") return entry;
  }
  return undefined;
}

function renderSummaryInput(request: SummaryRequest): string {
  const checkpoint = request.latestCheckpoint === undefined
    ? "none"
    : stableStringify({
      plan: request.latestCheckpoint.plan,
      openFiles: request.latestCheckpoint.openFiles,
      pendingToolCallIds: request.latestCheckpoint.pendingToolCallIds,
    });
  return [
    `Tokens before compaction: ${request.tokensBefore}`,
    `First verbatim entry after this prefix: ${request.firstKeptEntry}`,
    `Active checkpoint (reference only; it remains verbatim): ${checkpoint}`,
    "Older transcript prefix:",
    ...request.entries.map((entry) => stableStringify(entry)),
  ].join("\n");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

const approximateTokenEstimator: TokenEstimator = {
  entries(entries) {
    return Math.ceil(stableStringify(entries).length / 4);
  },
  text(text) {
    return Math.ceil(text.length / 4);
  },
};
