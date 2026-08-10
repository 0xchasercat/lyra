import type { SpawnIntegration } from "@lyra/core";

export interface AgentWorkspace { name: string; path: string; task: string; }
export interface PreviewRecord { name: string; path: string; createdAt: string; workspaces: AgentWorkspace[]; branches: string[]; }
export interface GitConflict { files: string[]; workspace: AgentWorkspace; priorTasks: string[]; }
/**
 * The transactional apply's verdict.
 *
 * `checkpoint` is the shadow-git checkpoint taken immediately before the origin was
 * touched — the single undo mechanism, shared with every tool call and turn boundary.
 * There is no second snapshot system any more.
 */
export interface ApplyResult { ok: boolean; preview: string; checkpoint?: CheckpointRecord; appliedHead?: string; conflicts?: GitConflict[]; message: string; }
export interface GitActivity { operation: string; destructive: boolean; detail: string; createdAt: string; }
export interface ConflictResolver { resolve(args: { repo: string; conflict: GitConflict; allWorkspaces: readonly AgentWorkspace[] }, signal?: AbortSignal): Promise<boolean>; }
export interface GitPipelineOptions {
  origin: string;
  resolver?: ConflictResolver;
  activity?: (activity: GitActivity) => void;
  now?: () => Date;
  /** Taken before the origin is modified, so an apply is undoable by the same mechanism as a tool call. */
  checkpoints?: { checkpoint(input: { kind: CheckpointKind; label?: string }): Promise<CheckpointRecord | undefined> };
}

/**
 * What a spawned child left behind, for the parent model to review and integrate itself.
 *
 * Integration is an ordinary sequence of tool calls now, not a pipeline mode: the child's
 * workspace is a complete independent repository, so `git fetch <path>` brings its commits
 * into the parent's repo without either working tree being touched. The shape is declared
 * by `@lyra/core` because the spawn result is what carries it; this alias is the name the
 * git layer uses for the same thing.
 */
export type WorkspaceIntegration = SpawnIntegration;

export type CheckpointKind = "turn_start" | "pre_tool" | "turn_end" | "pre_restore" | "manual";

/**
 * One recorded state of a working tree.
 *
 * `id` is the stable handle: garbage collection rewrites the commit chain and therefore
 * every `commit` oid downstream of a drop, but ids are carried across, so an id recorded in
 * a transcript keeps resolving for as long as the checkpoint survives at all.
 */
export interface CheckpointRecord {
  id: string;
  commit: string;
  tree: string;
  kind: CheckpointKind;
  label: string;
  createdAt: string;
  /** How many paths differ from the checkpoint before this one. */
  changedFiles: number;
  /** Paths Lyra's own tools reported changing in the interval that ends here. */
  attributed: string[];
  attributedTruncated?: number;
  /** The hard exclusion set in force when this was taken. */
  excluded: string[];
  /** Transcript entry this checkpoint is anchored to, so conversation and code rewind together. */
  entryId?: string;
  tool?: string;
  callId?: string;
  /** The raw commit message, kept so garbage collection can rewrite the chain verbatim. */
  message: string;
  /** Set when an unchanged tree reused the previous checkpoint instead of writing a new one. */
  collapsed?: true;
}

export type CheckpointTarget = string | "worktree" | "latest" | { parentOf: string };

export interface CheckpointFileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed";
  oldPath?: string;
  additions?: number;
  deletions?: number;
  binary?: true;
  /** Unified diff for this one path. Present only when patches were requested. */
  patch?: string;
  patchTruncated?: true;
}

export interface CheckpointDiffEndpoint { kind: "checkpoint" | "worktree" | "empty"; id?: string; label?: string; createdAt?: string; }

export interface CheckpointDiff {
  from: CheckpointDiffEndpoint;
  to: CheckpointDiffEndpoint;
  files: CheckpointFileChange[];
  /** True when more files changed than the limit carried. */
  truncated: boolean;
  available: boolean;
  unavailable?: string;
}

export interface CheckpointRestoreResult {
  target: CheckpointRecord;
  /** The checkpoint of the state that was replaced. Always taken, so a restore is itself undoable. */
  safety: CheckpointRecord;
  restored: string[];
  /** Changed outside Lyra's tool calls, and therefore left exactly as they were. */
  preserved: string[];
  forced: boolean;
  excluded: string[];
}

export interface CheckpointGcPolicy { keepAllMs?: number; keepRecent?: number; thinIntervalMs?: number; maxTotal?: number; }
export interface CheckpointGcResult { kept: number; dropped: number; checkpoints: CheckpointRecord[]; }

export interface CheckpointStoreOptions {
  /** The working tree being shadowed: the session's directory. */
  root: string;
  /** Override for tests; defaults to `<root>/.lyra/checkpoints`. */
  gitDir?: string;
  excluded?: readonly string[];
  now?: () => Date;
  onWarning?: (message: string) => void;
}
