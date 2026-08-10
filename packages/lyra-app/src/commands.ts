import type { AcpCommandResultKind } from "@lyra/acp";

export interface SlashServices {
  copy(target?: string): Promise<unknown>;
  dump(): Promise<unknown>;
  settings(args: readonly string[]): Promise<unknown>;
  provider(args: readonly string[]): Promise<unknown>;
  model(args: readonly string[]): Promise<unknown>;
  loop(spec: string): Promise<unknown>;
  context(): Promise<unknown>;
  compact(clear: boolean): Promise<unknown>;
  agents(operation: "list" | "kill", name?: string): Promise<unknown>;
  workspaces(operation: "list" | "cleanup"): Promise<unknown>;
  checkpoints(): Promise<unknown>;
  review(from?: string): Promise<unknown>;
  rollback(checkpoint: string | undefined, force: boolean): Promise<unknown>;
  apply(preview?: string): Promise<unknown>;
  skills(): Promise<unknown>;
  mcp(): Promise<unknown>;
  install(tool: string): Promise<unknown>;
  sessions(operation: "fork" | "resume" | "list", value?: string): Promise<unknown>;
  health(): Promise<unknown>;
}
/**
 * Every slash command the router accepts, with the one-line description the TUI's `/`
 * popup renders and the shape its output takes.
 *
 * This table is the single declaration of the command surface (DESIGN §4: "one command
 * declaration is reachable by key, palette, and `/name`"). `session/commands` serves it
 * verbatim, the router dispatches from it, and a conformance test asserts the two never
 * diverge — so a command that exists is listed and a listed command exists.
 */
export interface SlashCommandSpec {
  readonly name: string;
  readonly description: string;
  /** Present only when the command takes arguments. */
  readonly usage?: string;
  readonly resultKind: AcpCommandResultKind;
}
export const SLASH_COMMAND_CATALOG: readonly SlashCommandSpec[] = Object.freeze([
  { name: "copy", description: "Copy the last assistant reply, or one addressed by entry id, to the clipboard.", usage: "/copy [entryId]", resultKind: "report" },
  { name: "dump", description: "Copy the whole transcript to the clipboard as JSON.", resultKind: "report" },
  { name: "settings", description: "Show the effective runtime settings for this session.", resultKind: "report" },
  // `edit` and `delete` are advertised here and intercepted by the client: one opens the
  // setup form filled in from `provider/get` and saves it with `provider/add` (persist
  // "keep" when the key is not being rotated), the other confirms and calls `provider/remove`.
  // They are in the catalog because the `/` popup is built from it — a command a user cannot
  // discover is a command that does not exist — and the daemon answers them with what to do
  // instead, rather than mistaking "edit" for a provider name.
  { name: "provider", description: "Show the configured providers, switch to one and pick its model, or edit or delete one.", usage: "/provider [name [model]|edit <name>|delete <name>]", resultKind: "report" },
  { name: "model", description: "List every configured provider's models, switch to one across providers, or declare one an endpoint cannot list.", usage: "/model [id|provider/id|@role|refresh|add <provider> <id>]", resultKind: "models" },
  { name: "loop", description: "Run the agent autonomously for a count, a duration, or until a condition holds.", usage: "/loop <count|duration|until \"condition\">", resultKind: "report" },
  { name: "context", description: "Break down what the next request would send, section by section, with repairs and losses.", resultKind: "context" },
  { name: "compact", description: "Summarise the transcript now instead of waiting for the automatic threshold.", resultKind: "report" },
  { name: "clear", description: "Clear the context behind a boundary; nothing leaves the transcript on disk.", resultKind: "report" },
  { name: "agents", description: "List spawned agents: peer name, state, tool calls, files changed, and write scope.", resultKind: "agents" },
  { name: "kill", description: "Cancel a running agent by its spawn id or peer name.", usage: "/kill <agentId>", resultKind: "report" },
  { name: "workspaces", description: "List every agent workspace and its lifecycle state.", resultKind: "workspaces" },
  { name: "cleanup", description: "Reclaim what this session no longer needs: archived workspaces, stale previews, and old checkpoints.", resultKind: "workspaces" },
  // The rewind surface. These two have declared structure — a checkpoint listing and a
  // per-file diff — so they name it rather than hiding it under a report's `detail`: a
  // client that wants to draw the diff should dispatch on the kind, not sniff the payload,
  // which is the entire reason `resultKind` exists. The prose line they used to carry is
  // gone with the wrapper; the numbers it was made of are all still on the wire, and
  // composing the sentence is the client's job (DESIGN §2, raw measurements).
  { name: "checkpoints", description: "List the checkpoints taken before each state-changing tool call, newest first.", resultKind: "checkpoints" },
  { name: "review", description: "Show what changed since a checkpoint, plus every agent workspace holding work to integrate.", usage: "/review [checkpointId]", resultKind: "review" },
  { name: "rollback", description: "Restore the working tree to a checkpoint. Files changed outside Lyra are never reverted unless --force.", usage: "/rollback [checkpointId] [--force]", resultKind: "report" },
  { name: "apply", description: "Apply an assembled merge preview to the repository.", usage: "/apply [--preview <id>]", resultKind: "report" },
  { name: "skills", description: "List discovered skills and where each was found.", resultKind: "skills" },
  { name: "mcp", description: "Re-index the configured MCP servers and list the tools they advertise.", resultKind: "mcp" },
  { name: "install", description: "Install a bundled MCP integration.", usage: "/install draco", resultKind: "report" },
  { name: "fork", description: "Fork the transcript at an entry, leaving the original branch intact.", usage: "/fork [entryId]", resultKind: "report" },
  { name: "resume", description: "Load a saved session by name, replacing the active transcript.", usage: "/resume <session>", resultKind: "report" },
  { name: "sessions", description: "List the saved sessions on disk with their ids.", resultKind: "sessions" },
  { name: "health", description: "Report durable metrics: turn latency, retries, compactions, and tool reliability.", resultKind: "health" },
] satisfies readonly SlashCommandSpec[]);

export interface SlashResult { command: string; resultKind: AcpCommandResultKind; output?: unknown; error?: string; }
export const SLASH_COMMANDS: readonly string[] = Object.freeze(SLASH_COMMAND_CATALOG.map((entry) => entry.name));
const COMMAND_SET = new Map(SLASH_COMMAND_CATALOG.map((entry) => [entry.name, entry] as const));

export class SlashCommandRouter {
  constructor(private readonly services: SlashServices) {}
  /** Every command the router routes, in the order the popup should list them. */
  list(): readonly SlashCommandSpec[] { return SLASH_COMMAND_CATALOG; }
  async execute(input: string): Promise<SlashResult> {
    // A failure has no declared output shape, so it reports as free-form text — the one
    // resultKind that is always renderable.
    if (typeof input !== "string" || !input.startsWith("/")) return { command: "", resultKind: "report", error: "Slash commands must begin with /." };
    let tokens: string[];
    try { tokens = tokenize(input.slice(1)); } catch (error) { return { command: "", resultKind: "report", error: error instanceof Error ? error.message : String(error) }; }
    const command = tokens.shift()?.toLowerCase() ?? "";
    const spec = COMMAND_SET.get(command);
    if (!spec) return { command, resultKind: "report", error: `Unknown command /${command}. Available: ${SLASH_COMMANDS.map((name) => `/${name}`).join(", ")}.` };
    try {
      let output: unknown;
      switch (command) {
        case "copy": output = await this.services.copy(tokens[0]); break;
        case "dump": output = await this.services.dump(); break;
        case "settings": output = await this.services.settings(tokens); break;
        case "provider": output = await this.services.provider(tokens); break;
        case "model": output = await this.services.model(tokens); break;
        case "loop": if (tokens.length === 0) throw new Error("/loop requires a count, duration, or until condition."); output = await this.services.loop(tokens.join(" ")); break;
        case "context": output = await this.services.context(); break;
        case "compact": output = await this.services.compact(false); break;
        case "clear": output = await this.services.compact(true); break;
        case "agents": output = await this.services.agents("list"); break;
        case "kill": if (!tokens[0]) throw new Error("/kill requires an agent name."); output = await this.services.agents("kill", tokens[0]); break;
        case "workspaces": output = await this.services.workspaces("list"); break;
        case "cleanup": output = await this.services.workspaces("cleanup"); break;
        case "checkpoints": output = await this.services.checkpoints(); break;
        case "review": output = await this.services.review(tokens[0]); break;
        // `--force` is the one destructive flag in the whole surface, so it is spelled out
        // rather than inferred: a bare /rollback never reverts a file Lyra did not write.
        case "rollback": output = await this.services.rollback(tokens.find((token) => !token.startsWith("--")), tokens.includes("--force")); break;
        case "apply": output = await this.services.apply(optionValue(tokens, "--preview")); break;
        case "skills": output = await this.services.skills(); break;
        case "mcp": output = await this.services.mcp(); break;
        case "install": if (!tokens[0]) throw new Error("/install requires a tool name."); output = await this.services.install(tokens[0]); break;
        case "fork": output = await this.services.sessions("fork", tokens[0]); break;
        // The name is required *here* because a report cannot be a picker. A client that
        // can show a list intercepts the bare form and shows one (the Rust TUI opens the
        // same overlay `/sessions` does); every other client is pointed at the listing
        // rather than told to guess an id it has never been shown.
        case "resume": if (!tokens[0]) throw new Error("/resume needs a session name — run /sessions to see them."); output = await this.services.sessions("resume", tokens[0]); break;
        case "sessions": output = await this.services.sessions("list"); break;
        case "health": output = await this.services.health(); break;
      }
      return { command, resultKind: spec.resultKind, output };
    } catch (error) { return { command, resultKind: spec.resultKind, error: error instanceof Error ? error.message : String(error) }; }
  }
}

function tokenize(input: string): string[] { const tokens: string[] = []; let current = ""; let quote: string | undefined; let escaped = false; for (const char of input.trim()) { if (escaped) { current += char; escaped = false; continue; } if (char === "\\") { escaped = true; continue; } if (quote) { if (char === quote) quote = undefined; else current += char; continue; } if (char === '"' || char === "'") { quote = char; continue; } if (/\s/.test(char)) { if (current) { tokens.push(current); current = ""; } } else current += char; } if (quote) throw new Error("Unterminated quote in slash command."); if (escaped) current += "\\"; if (current) tokens.push(current); return tokens; }
function optionValue(tokens: readonly string[], option: string): string | undefined { const index = tokens.indexOf(option); if (index < 0) return tokens[0]; if (!tokens[index + 1]) throw new Error(`${option} requires a value.`); return tokens[index + 1]; }
