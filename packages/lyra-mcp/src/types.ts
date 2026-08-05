import type { ToolDefinition } from "@lyra/provider";
import type { ToolExecutionContext, ToolExecutionResult } from "@lyra/core";

export interface McpServerConfig { command: string; args?: readonly string[]; env?: Readonly<Record<string, string>>; cwd?: string; }
export interface McpToolSummary { server: string; name: string; description: string; }
export interface McpToolDescriptor extends McpToolSummary { inputSchema: Readonly<Record<string, unknown>>; annotations?: Readonly<Record<string, unknown>>; }
export interface McpCallResult { content: unknown; isError?: boolean; structuredContent?: unknown; }
export interface McpClientOptions extends McpServerConfig { name: string; timeoutMs?: number; onLog?: (line: string) => void; }
export interface McpGatewayOptions { servers: Readonly<Record<string, McpServerConfig>>; timeoutMs?: number; }
export interface McpToolLike { readonly definition: ToolDefinition; execute(args: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult>; }
export interface DracoInstallerOptions { origin: string; home?: string; fetch?: typeof globalThis.fetch; run?: (scriptPath: string, env: Readonly<Record<string, string>>) => Promise<{ exitCode: number; stdout: string; stderr: string }>; installUrl?: string; expectedSha256?: string; }
