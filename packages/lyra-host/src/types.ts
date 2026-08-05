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
  createdAt: string;
  updatedAt: string;
}

export type ProcessClass = "heavy" | "io" | "light" | "free";
export interface ProcessRequest {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
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
}
export interface HostProcess {
  run(request: ProcessRequest): Promise<ProcessResult | JobHandle>;
  wait(id: string, timeoutMs?: number): Promise<ProcessResult | undefined>;
  cancel(id: string): Promise<boolean>;
  classify(command: string): ProcessClass;
  close(): Promise<void>;
}
