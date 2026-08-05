export type SpawnSchemaMode = "permissive" | "strict";
export interface SpawnOutputSchema { readonly type?: string; readonly required?: readonly string[]; readonly properties?: Readonly<Record<string, SpawnOutputSchema>>; readonly items?: SpawnOutputSchema; }
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
}
export interface SpawnResult { id: string; output: unknown; workspace: string; model?: string; label?: string; }
export interface SpawnHandle { id: string; workspace: string; label?: string; status: "queued" | "running" | "completed" | "failed" | "cancelled"; startedAt: number; }
export interface SpawnExecutorContext { id: string; signal: AbortSignal; parentId?: string; depth: number; workspace: string; model?: string; tools: readonly string[]; report(message: string): void; }
export type SpawnExecutor = (request: SpawnRequest, context: SpawnExecutorContext) => Promise<unknown>;
export interface SpawnManagerOptions { maxDepth?: number; maxConcurrent?: number; defaultWorkspace: string; defaultModel?: string; availableTools?: readonly string[]; createWorkspace?: (name?: string, task?: string, signal?: AbortSignal) => Promise<{ name: string; path: string }>; resolveWorkspace?: (name: string) => Promise<{ name: string; path: string }>; releaseWorkspace?: (name: string) => Promise<unknown>; executor: SpawnExecutor; now?: () => number; }
