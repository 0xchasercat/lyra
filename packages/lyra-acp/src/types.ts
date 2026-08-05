export const ACP_METHODS = [
  "session/new", "session/load", "session/prompt", "session/update", "session/cancel", "session/fork", "session/command",
  "workspace/list", "workspace/create", "workspace/drop",
  "agent/list", "agent/spawn", "agent/cancel", "agent/message",
  "git/preview", "git/apply", "git/rollback", "git/snapshot",
  "context/inspect", "settings/get", "settings/set",
] as const;
export type AcpMethod = typeof ACP_METHODS[number];
export type JsonRpcId = string | number;
export interface AcpHandlerContext { id: JsonRpcId; signal: AbortSignal; notify(method: string, params?: unknown): Promise<void>; requestClient(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>; }
export type AcpHandler = (params: unknown, context: AcpHandlerContext) => Promise<unknown> | unknown;
export type AcpHandlers = Partial<Record<AcpMethod, AcpHandler>>;
export interface AcpDaemonOptions { handlers: AcpHandlers; requestTimeoutMs?: number; maxFrameBytes?: number; maxConcurrentRequests?: number; serverName?: string; serverVersion?: string; }
export interface AcpWriter { write(data: string | Uint8Array): void | Promise<void>; }
export interface AcpCapabilities { methods: readonly AcpMethod[]; bidirectional: boolean; cancellation: boolean; transport: "stdio"; }
