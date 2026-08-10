import type { ContentBlock, ProviderApiType } from "@lyra/provider";

export type EntryId = string;
export type TranscriptMessageStatus = "complete" | "cancelled" | "interrupted";

export interface SessionEntryBase {
  id: EntryId;
  parentId: EntryId | null;
  timestamp: string;
}

export interface SessionStartEntry extends SessionEntryBase {
  type: "session";
  sessionId: string;
  name: string;
  origin: string;
  workspace: string;
  provider: string;
  model: string;
}

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  role: "user" | "assistant";
  content: ContentBlock[];
  status: TranscriptMessageStatus;
}

export interface SessionErrorEntry extends SessionEntryBase {
  type: "error";
  classification: string;
  message: string;
  code?: string;
  status?: number;
}

export interface CompactionBoundaryEntry extends SessionEntryBase {
  type: "boundary";
  kind: "compaction" | "clear";
  firstKeptEntry: EntryId | null;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
}

export interface ContextRepairEntry extends SessionEntryBase {
  type: "repair";
  requestId: string;
  repairs: Array<{
    code: string;
    detail: string;
    entryId?: EntryId;
  }>;
}

export interface CheckpointEntry extends SessionEntryBase {
  type: "checkpoint";
  plan?: string;
  openFiles: string[];
  pendingToolCallIds: string[];
  state?: Readonly<Record<string, unknown>>;
}

export interface ProviderSwitchEntry extends SessionEntryBase {
  type: "provider_switch";
  provider: string;
  model: string;
  apiType: ProviderApiType;
  losses: string[];
}

/**
 * What one completed turn cost, as the provider reported it, summed over every call the
 * turn made. It is written where the turn ended so that a transcript alone answers "how
 * many tokens did this session spend" — the running totals live in memory and on the ACP
 * wire, and neither survives the process.
 *
 * Every field is a raw count, never an estimate. Cache counts are present only for
 * providers that report them and `costMicroUsd` only for models with known pricing; an
 * absent field means "not measured", which is the one thing a derived zero cannot say.
 * The entry carries no derived totals, so replaying a transcript can only agree with it.
 */
export interface TurnUsageEntry extends SessionEntryBase {
  type: "usage";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMicroUsd?: number;
}

export type TranscriptEntry =
  | SessionStartEntry
  | MessageEntry
  | SessionErrorEntry
  | CompactionBoundaryEntry
  | ContextRepairEntry
  | CheckpointEntry
  | ProviderSwitchEntry
  | TurnUsageEntry;

export type NewTranscriptEntry = TranscriptEntry extends infer Entry
  ? Entry extends TranscriptEntry
    ? Omit<Entry, keyof SessionEntryBase> & {
        id?: EntryId;
        parentId?: EntryId | null;
        timestamp?: string;
      }
    : never
  : never;

export interface SessionDescriptor {
  sessionId: string;
  name: string;
  path: string;
  headId: EntryId;
  createdAt: string;
}

export interface PromptSearchHit {
  sessionId: string;
  entryId: EntryId;
  prompt: string;
  createdAt: string;
  rank: number;
}
