export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface LspTransport {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface LspProcess {
  stdin: { write(data: string | Uint8Array): void | Promise<void>; end?(): void | Promise<void> };
  stdout: AsyncIterable<Uint8Array | string>;
  stderr?: AsyncIterable<Uint8Array | string>;
  kill(signal?: string): void;
  exited?: Promise<number>;
}

export type LspSpawn = (command: string, args: readonly string[], cwd: string) => LspProcess;

export interface LanguageServerClientOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  /** Defaults to `cwd`; servers that index a project refuse to work without a root. */
  rootUri?: string;
  requestTimeoutMs?: number;
  /** Ceiling for `requestTimeoutMs`. Defaults to the §3.4 LSP deadline of 20 seconds. */
  maxRequestTimeoutMs?: number;
  /** Size of the open-document working set held with the server. */
  maxOpenDocuments?: number;
  spawn?: LspSpawn;
  onLog?: (line: string) => void;
}

export interface LspPosition { line: number; character: number; }
export interface LspRange { start: LspPosition; end: LspPosition; }
export interface LspLocation { uri: string; range: LspRange; }
export interface LspDiagnostic { range: LspRange; message: string; severity?: number; source?: string; }

export type LspMethod = "textDocument/definition" | "textDocument/references" | "textDocument/hover" | "textDocument/rename" | "textDocument/diagnostic" | "textDocument/codeAction";

export interface TextFallback {
  run(method: LspMethod, params: unknown): Promise<unknown>;
  warn(message: string): void;
}

export interface LanguageServerSpec {
  language: string;
  command: string;
  args: readonly string[];
  markers: readonly string[];
}
