import type {
  ContentBlock,
  ProviderApiType,
  ProviderRequest,
  ReliableProviderEvent,
  StopReason,
  ToolDefinition,
} from "@lyra/provider";
import type { EntryId, MessageEntry, TranscriptEntry } from "@lyra/session";

export interface ToolProgress {
  filesRead?: string[];
  filesModified?: Array<{ path: string; beforeHash?: string; afterHash?: string }>;
  commandExitCode?: number;
}

export interface ToolExecutionResult {
  content: string | ContentBlock[];
  isError?: boolean;
  progress?: ToolProgress;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolExecutionContext {
  signal: AbortSignal;
  sessionId: string;
  workspace: string;
  callId: string;
}

export interface ToolRegistry {
  definitions(): readonly ToolDefinition[];
  execute(
    name: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

export type ContextRepairCode =
  | "missing_tool_result"
  | "orphan_tool_result"
  | "adjacent_role_merge"
  | "empty_content"
  | "thinking_reordered"
  | "thinking_signature_dropped"
  | "provider_reasoning_dropped"
  | "image_dropped"
  | "boundary_applied";

export interface ContextRepair {
  code: ContextRepairCode;
  detail: string;
  entryId: EntryId;
  tokenEstimate: number;
}

export interface DerivedContext {
  request: ProviderRequest;
  repairs: ContextRepair[];
  tokenEstimate: number;
  sourceEntryIds: EntryId[];
}

export interface ContextDerivationOptions {
  model: string;
  system: string;
  apiType: ProviderApiType;
  tools: readonly ToolDefinition[];
  contextWindow: number;
  imageByteLimit?: number;
}

export type LoopWarning =
  | { type: "identical_tool_call"; tool: string; count: number }
  | { type: "no_progress"; turns: number }
  | { type: "oscillation"; path: string; hash: string };

/** Where a drained steering message was injected into the running turn. */
export type SteerBoundary = "tool_boundary" | "turn_boundary";

export type AgentEvent =
  | ReliableProviderEvent
  | { type: "tool_started"; id: string; name: string; input: unknown }
  | { type: "tool_finished"; id: string; name: string; result: ToolExecutionResult }
  | { type: "context_repaired"; repairs: ContextRepair[] }
  | {
    type: "compacted";
    boundaryId: EntryId;
    tokensBefore: number;
    tokensAfter: number;
    firstKeptEntry: EntryId | null;
  }
  | { type: "context_measured"; tokenEstimate: number; sourceEntryCount: number }
  | {
    type: "steered";
    entryId: EntryId;
    text: string;
    at: SteerBoundary;
    /** Who spoke. `hub` is another agent's aside; absent is read as `user`. */
    source?: "user" | "hub";
    /** The peer that sent a `hub` aside. */
    from?: string;
  }
  | { type: "loop_warning"; warning: LoopWarning; hardStopRequested?: boolean };

export interface AgentTurnResult {
  stopReason: StopReason;
  assistant: MessageEntry;
  entries: TranscriptEntry[];
  hardStopRequested?: boolean;
}
