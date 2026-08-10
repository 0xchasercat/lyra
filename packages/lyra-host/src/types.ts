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
/**
 * A process still alive in the job's process group after its shell exited.
 *
 * A shell that backgrounds something (`node server.js &`) hands the pipe to a grandchild and
 * then exits. Naming that grandchild is the difference between a model that knows it started
 * a server and a model that stares at output which arrived "too fast" (§3.8: nothing about a
 * call's outcome is dropped on the floor).
 */
export interface ProcessSurvivor {
  readonly pid: number;
  /** The argv `ps` reported. Empty when enumeration failed and only the count is known. */
  readonly command: string;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  /**
   * True only when the deadline aborted a shell that was *still running* (§11).
   *
   * Explicit rather than inferred, because every inference from the other fields is wrong.
   * `signal !== null` was the old one, and it reported `timed_out: true` for a cancelled job
   * and for a shell that exited 0 at 2s while a backgrounded grandchild held the output pipe
   * open until the 120s deadline. A shell that reached its own exit is never timed out, no
   * matter what its descendants are doing.
   */
  timedOut: boolean;
  durationMs: number;
  /**
   * Processes still running in the job's group once the shell exited, when there are any.
   *
   * Only populated for a job that reached its own natural end: a cancelled or deadline-killed
   * job has its whole tree reaped, so by construction it leaves nothing behind.
   */
  survivors?: readonly ProcessSurvivor[];
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
