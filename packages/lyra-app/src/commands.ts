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
  git(operation: "mode" | "review" | "apply" | "rollback", value?: string): Promise<unknown>;
  skills(): Promise<unknown>;
  mcp(): Promise<unknown>;
  install(tool: string): Promise<unknown>;
  sessions(operation: "fork" | "resume" | "list", value?: string): Promise<unknown>;
  health(): Promise<unknown>;
}
export interface SlashResult { command: string; output?: unknown; error?: string; }
export const SLASH_COMMANDS = ["copy", "dump", "settings", "provider", "model", "loop", "context", "compact", "clear", "agents", "kill", "workspaces", "cleanup", "gitmode", "review", "apply", "rollback", "skills", "mcp", "install", "fork", "resume", "sessions", "health"] as const;
const COMMAND_SET = new Set<string>(SLASH_COMMANDS);

export class SlashCommandRouter {
  constructor(private readonly services: SlashServices) {}
  async execute(input: string): Promise<SlashResult> {
    if (typeof input !== "string" || !input.startsWith("/")) return { command: "", error: "Slash commands must begin with /." };
    let tokens: string[];
    try { tokens = tokenize(input.slice(1)); } catch (error) { return { command: "", error: error instanceof Error ? error.message : String(error) }; }
    const command = tokens.shift()?.toLowerCase() ?? "";
    if (!COMMAND_SET.has(command)) return { command, error: `Unknown command /${command}. Available: ${SLASH_COMMANDS.map((name) => `/${name}`).join(", ")}.` };
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
        case "gitmode": if (tokens[0] !== "observe" && tokens[0] !== "stage" && tokens[0] !== "auto") throw new Error("/gitmode requires observe, stage, or auto."); output = await this.services.git("mode", tokens[0]); break;
        case "review": output = await this.services.git("review"); break;
        case "apply": output = await this.services.git("apply", optionValue(tokens, "--preview")); break;
        case "rollback": output = await this.services.git("rollback", optionValue(tokens, "--to")); break;
        case "skills": output = await this.services.skills(); break;
        case "mcp": output = await this.services.mcp(); break;
        case "install": if (!tokens[0]) throw new Error("/install requires a tool name."); output = await this.services.install(tokens[0]); break;
        case "fork": output = await this.services.sessions("fork", tokens[0]); break;
        case "resume": if (!tokens[0]) throw new Error("/resume requires a session name."); output = await this.services.sessions("resume", tokens[0]); break;
        case "sessions": output = await this.services.sessions("list"); break;
        case "health": output = await this.services.health(); break;
      }
      return { command, output };
    } catch (error) { return { command, error: error instanceof Error ? error.message : String(error) }; }
  }
}

function tokenize(input: string): string[] { const tokens: string[] = []; let current = ""; let quote: string | undefined; let escaped = false; for (const char of input.trim()) { if (escaped) { current += char; escaped = false; continue; } if (char === "\\") { escaped = true; continue; } if (quote) { if (char === quote) quote = undefined; else current += char; continue; } if (char === '"' || char === "'") { quote = char; continue; } if (/\s/.test(char)) { if (current) { tokens.push(current); current = ""; } } else current += char; } if (quote) throw new Error("Unterminated quote in slash command."); if (escaped) current += "\\"; if (current) tokens.push(current); return tokens; }
function optionValue(tokens: readonly string[], option: string): string | undefined { const index = tokens.indexOf(option); if (index < 0) return tokens[0]; if (!tokens[index + 1]) throw new Error(`${option} requires a value.`); return tokens[index + 1]; }
