export type GitMode = "observe" | "stage" | "auto";
export interface AgentWorkspace { name: string; path: string; task: string; }
export interface PreviewRecord { name: string; path: string; createdAt: string; workspaces: AgentWorkspace[]; branches: string[]; }
export interface SnapshotRecord { name: string; path: string; createdAt: string; head: string; branch: string; }
export interface GitConflict { files: string[]; workspace: AgentWorkspace; priorTasks: string[]; }
export interface ApplyResult { ok: boolean; preview: string; snapshot: SnapshotRecord; appliedHead?: string; conflicts?: GitConflict[]; message: string; }
export interface GitActivity { operation: string; destructive: boolean; detail: string; createdAt: string; }
export interface ConflictResolver { resolve(args: { repo: string; conflict: GitConflict; allWorkspaces: readonly AgentWorkspace[] }): Promise<boolean>; }
export interface GitPipelineOptions {
  origin: string;
  mode?: GitMode;
  confirmAuto?: () => boolean | Promise<boolean>;
  resolver?: ConflictResolver;
  activity?: (activity: GitActivity) => void;
  now?: () => Date;
}
