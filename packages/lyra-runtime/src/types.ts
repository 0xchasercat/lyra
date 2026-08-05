export interface RuntimeAdapters {
  spawn(options: unknown): Promise<unknown>;
  exec(command: string, options?: unknown): Promise<unknown>;
  tool(name: "read" | "write" | "edit" | "glob" | "grep", args: unknown): Promise<unknown>;
  irc(operation: "send" | "publish" | "wait", args: unknown): Promise<unknown>;
  git(operation: "preview" | "apply" | "rollback", args?: unknown): Promise<unknown>;
  workspace(operation: "create" | "list" | "drop", args?: unknown): Promise<unknown>;
  report(message: string): void | Promise<void>;
}

export interface RuntimeScriptRecord {
  session: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeRunResult {
  ok: boolean;
  output?: unknown;
  stderr: string;
  exitCode: number | null;
  checkpoint?: unknown;
  error?: string;
}

export interface RuntimeManagerOptions {
  origin: string;
  session: string;
  adapters: RuntimeAdapters;
  requestTimeoutMs?: number;
  runTimeoutMs?: number;
}
