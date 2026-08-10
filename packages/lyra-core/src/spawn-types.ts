export type SpawnSchemaMode = "permissive" | "strict";
/** Exactly the JSON Schema subset a spawn contract is validated against — no more, no less. */
export interface SpawnOutputSchema {
  readonly type?: string;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, SpawnOutputSchema>>;
  readonly items?: SpawnOutputSchema;
  readonly enum?: readonly unknown[];
  readonly additionalProperties?: boolean;
}
export interface SpawnRequest {
  task: string;
  context?: string;
  output_schema?: SpawnOutputSchema;
  schema_mode?: SpawnSchemaMode;
  model?: string;
  tools?: readonly string[];
  isolated?: boolean;
  workspace?: string;
  blocking?: boolean;
  label?: string;
  acp?: string;
  depth?: number;
  /**
   * The paths this child is allowed to write, as a declared partition of the shared tree.
   *
   * Advisory by design and enforced at the child's own `write`/`edit` tools: it is not a
   * lock, it is a statement the parent can read back (`spawn status`, `hub list`) when it
   * decides who works on what. Only meaningful for a child sharing the parent's directory —
   * an isolated child already has a tree of its own.
   */
  writeScope?: readonly string[];
  /**
   * Set by [`SpawnManager.revive`], never by a caller: continue the child's existing
   * transcript instead of starting a new one. See [`SpawnExecutorContext.resume`].
   */
  resume?: boolean;
}

/**
 * A child's lifecycle, as the parent sees it.
 *
 * `queued` and `starting` used to both be reported as "queued", and `running` covered both
 * "the model is thinking" and "the model is 40 minutes into a build" — which is precisely
 * the information a parent needed and could not get. `timed_out` is separate from
 * `cancelled` because "it ran out of time" and "I stopped it" call for different next moves.
 */
export type SpawnState =
  | "queued"
  | "starting"
  | "running"
  | "awaiting_tool"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

/** The states past which nothing more will happen unless the child is revived. */
export const SPAWN_TERMINAL_STATES: readonly SpawnState[] = Object.freeze(["completed", "failed", "timed_out", "cancelled"]);

export interface SpawnResult {
  id: string;
  /** The bus name this child answers to. Authoritative: `hub send to:` takes exactly this. */
  peer: string;
  output: unknown;
  workspace: string;
  model?: string;
  label?: string;
  integration?: SpawnIntegration;
  /** Paths this child's tools reported changing, for a shared-tree child. */
  filesModified?: string[];
  /** Present only when the child declared a `writeScope`. */
  scope?: { paths: string[]; violations: string[] };
}

/**
 * What an isolated child left behind, and how the parent gets it into the main tree.
 *
 * Integration is the parent model's job now, done with ordinary tool calls — there is no
 * pipeline mode that does it behind the model's back. So a completed isolated spawn hands
 * back the workspace path, a measure of what is in it, and the literal commands that review
 * and merge it. A child that produced nothing is visible as `commits: 0` with no
 * uncommitted paths, which is the answer to "is this worth merging" without a round trip.
 */
export interface SpawnIntegration {
  workspace: string;
  path: string;
  /** Commits the child made past the state it started from. */
  commits: number;
  head?: string;
  /** Paths changed but never committed in the child; a fetch will not carry these. */
  uncommitted: string[];
  truncated: boolean;
  /** Present when the child's repository could not be inspected; the spawn still succeeded. */
  unavailable?: string;
  /** The documented recipe, as commands the parent can run with its `git` tool. */
  hint: string[];
}

export interface SpawnHandle {
  id: string;
  /** The bus name. Stable for the child's whole life, including across a revival. */
  peer: string;
  workspace: string;
  label?: string;
  status: SpawnState;
  startedAt: number;
}

/**
 * A live child, in as much detail as the manager can honestly report.
 *
 * Every field is measured rather than inferred, and the ones that cannot be measured are
 * absent rather than zero: a `filesModified` of `[]` means "reported nothing", which for a
 * child that never called a tool is the truth.
 */
export interface SpawnStatus {
  id: string;
  peer: string;
  status: SpawnState;
  label?: string;
  /** The directory the child's tools operate in. */
  workspace: string;
  /** The workspace *name*, for an isolated child only. */
  workspaceName?: string;
  isolated: boolean;
  model?: string;
  depth: number;
  parentId?: string;
  queuedAt: number;
  startedAt: number;
  /** When the child last did anything observable — a tool call, or output. */
  lastActivity: number;
  elapsedMs: number;
  toolCalls: number;
  /** The tool the child is inside right now, while `status` is `awaiting_tool`. */
  currentTool?: string;
  filesModified: string[];
  writeScope?: string[];
  scopeViolations?: string[];
  /** The tail of whatever the child has said so far. Present only when it has said something. */
  partialOutput?: string;
  /** How many times a hub message has revived this child. */
  revivals?: number;
  /** Why it failed, for `failed` and `timed_out`. */
  error?: string;
  /** True once the result is collectable with `spawn { id }`. */
  resultAvailable: boolean;
  integration?: SpawnIntegration;
}

/** One observable step, reported by the executor as the child takes it. */
export interface SpawnActivity {
  state?: "running" | "awaiting_tool";
  /** The tool now running, when `state` is `awaiting_tool`. */
  tool?: string;
  /** Count this call toward the child's tool total. */
  toolCall?: boolean;
  filesModified?: readonly string[];
  /** A path the child's write scope refused. */
  scopeViolation?: string;
  /** Text the child produced; the manager keeps a bounded tail of it. */
  text?: string;
}

/**
 * Every transition a child can make, as the wire spells them.
 *
 * A runtime list rather than only a type, because these strings cross two language
 * boundaries — the ACP `agent` update's `event` and the Rust client's `AgentTransition` —
 * and the Rust decoder is deliberately forward-compatible: an unknown tag degrades to
 * "no row rendered" rather than to a failure. That is the right behaviour for an old client
 * meeting a new daemon and the wrong one for a typo, so the spellings are pinned here and
 * asserted against the schema instead of being trusted to match.
 */
export const SPAWN_LIFECYCLE_TYPES = Object.freeze(["spawned", "started", "completed", "failed", "cancelled", "timed_out", "revived"] as const);

export type SpawnLifecycleType = (typeof SPAWN_LIFECYCLE_TYPES)[number];

/**
 * A lifecycle transition, for whoever is watching: the bus channel `agents`, the ACP
 * `agent` update, and any client that wants a presence strip.
 */
export interface SpawnLifecycleEvent {
  type: SpawnLifecycleType;
  id: string;
  peer: string;
  label?: string;
  status: SpawnState;
  depth: number;
  parentId?: string;
  workspace: string;
  model?: string;
  toolCalls: number;
  filesModified: number;
  at: number;
  /** Present on `failed` and `timed_out`. */
  error?: string;
}

export interface SpawnExecutorContext {
  /** The spawn id — `spawn-N`. Stable, and the key a revival resumes against. */
  id: string;
  /** The bus name this child is registered under. */
  peer: string;
  signal: AbortSignal;
  parentId?: string;
  depth: number;
  workspace: string;
  /** The workspace *name*, for an isolated child only. */
  workspaceName?: string;
  model?: string;
  tools: readonly string[];
  /** Declared write partition, to be enforced by the child's own write tools. */
  writeScope?: readonly string[];
  /** True when this run continues an earlier one: keep the transcript, add a turn. */
  resume?: boolean;
  report(message: string): void;
  /** Report one observable step. Never throws; a dropped report is not a failed child. */
  activity(update: SpawnActivity): void;
}
export type SpawnExecutor = (request: SpawnRequest, context: SpawnExecutorContext) => Promise<unknown>;
export interface SpawnManagerOptions {
  describeWorkspace?: (input: { name: string; path: string }, signal?: AbortSignal) => Promise<SpawnIntegration>;
  maxDepth?: number;
  maxConcurrent?: number;
  defaultWorkspace: string;
  defaultModel?: string;
  availableTools?: readonly string[];
  createWorkspace?: (name?: string, task?: string, signal?: AbortSignal) => Promise<{ name: string; path: string }>;
  resolveWorkspace?: (name: string) => Promise<{ name: string; path: string }>;
  releaseWorkspace?: (name: string) => Promise<unknown>;
  executor: SpawnExecutor;
  now?: () => number;
  /** Names already taken on the bus, so a label never collides with a live peer. */
  reservedPeers?: () => Iterable<string>;
}
