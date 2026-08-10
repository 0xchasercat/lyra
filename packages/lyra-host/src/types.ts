export type WorkspaceState = "created" | "active" | "paused" | "resumed" | "archived" | "dropped";
export type WorkspaceMode = "clone" | "worktree";

export interface WorkspaceRecord {
  name: string;
  path: string;
  origin: string;
  state: WorkspaceState;
  mode: WorkspaceMode;
  /** Present when a workspace had to use the shared-ref worktree fallback. */
  degradedReason?: string;
  /** Original child task contract, retained for review and merge resolution. */
  task?: string;
  createdAt: string;
  updatedAt: string;
}

export type ProcessClass = "heavy" | "io" | "light" | "free";
export interface ProcessRequest {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Return a job handle immediately even when the command classifies below `heavy`.
   * Classification still owns the semaphore class (§11) — this only decides whether the
   * caller blocks for the result or collects it later with `wait`.
   */
  background?: boolean;
  /**
   * How long the caller is willing to block before taking a job handle instead.
   *
   * Only consulted for a command whose pattern says it terminates. The process is *not*
   * killed when the budget expires — it keeps running and the caller collects it later —
   * so a build that turns out to be slower than the agent's patience costs a round trip
   * rather than the work (§3.8). `timeoutMs` remains the deadline that ends a process.
   */
  inlineBudgetMs?: number;
  /**
   * Which session started this job, so a turn can report the jobs *it* left running without
   * claiming a sibling's. Opaque to the host.
   */
  owner?: string;
}
export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
}
export interface JobHandle {
  id: string;
  class: ProcessClass;
  command: string;
  cwd: string;
  startedAt: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  /** The session that started it, when the caller named one. */
  owner?: string;
  /** True once someone has actually received this job's output. */
  collected?: boolean;
}
export interface HostProcess {
  run(request: ProcessRequest): Promise<ProcessResult | JobHandle>;
  wait(id: string, timeoutMs?: number): Promise<ProcessResult | undefined>;
  /** Present on hosts that keep a job table; lets a caller tell "unknown id" from "still running". */
  status?(id: string): JobHandle | undefined;
  cancel(id: string): Promise<boolean>;
  classify(command: string): ProcessClass;
  close(): Promise<void>;
}
