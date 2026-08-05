import { BashTool } from "./exec-tools.ts";
import { GitTool } from "./git-tools.ts";
import { EditTool, ReadTool, WriteTool } from "./filesystem-tools.ts";
import { GlobTool, GrepTool } from "./search-tools.ts";
import { ToolRegistry, type ArtifactStore, type LyraTool } from "./types.ts";

/** Options accepted by the built-in registry factory. */
export interface DefaultToolRegistryOptions {
  /** Options forwarded to filesystem and search tools. */
  filesystem?: unknown;
  /** Options forwarded to the command runner. */
  bash?: unknown;
  /** Options forwarded to workspace git. */
  git?: unknown;
  /** Optional defaults useful to hosts that construct execution contexts. */
  cwd?: string;
  origin?: string;
  artifactStore?: ArtifactStore;
}

export function createDefaultToolRegistry(options: DefaultToolRegistryOptions = {}): ToolRegistry {
  const filesystemOptions = options.filesystem;
  const bashOptions = options.bash;
  const gitOptions = options.git;
  const tools: LyraTool[] = [
    construct(ReadTool, filesystemOptions),
    construct(WriteTool, filesystemOptions),
    construct(EditTool, filesystemOptions),
    construct(BashTool, bashOptions),
    construct(GrepTool, filesystemOptions),
    construct(GlobTool, filesystemOptions),
    construct(GitTool, gitOptions),
  ];
  return new ToolRegistry(tools);
}

function construct(Tool: unknown, options: unknown): LyraTool {
  const Constructor = Tool as new (options?: unknown) => LyraTool;
  return new Constructor(options);
}

export { ToolRegistry } from "./types.ts";
export type { LyraTool, ToolRuntimeContext, ArtifactStore } from "./types.ts";
