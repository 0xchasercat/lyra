import { isAbsolute, relative, resolve } from "node:path";
import type { ToolDefinition } from "@lyra/provider";
import type { ToolExecutionContext, ToolExecutionResult } from "@lyra/core";
import {
  IrcBus,
  MAX_SPAWN_WAIT_MS,
  SPAWN_LIFECYCLE_CHANNEL,
  SpawnManager,
  SpawnTimeoutError,
  foldToolAliases,
  rejectedField,
  toolArgs,
  type SpawnParentContext,
  type SpawnRequest,
  type SpawnStatus,
  type ToolAlias,
} from "@lyra/core";
import { LspManager } from "@lyra/lsp";
import { RuntimeManager } from "@lyra/runtime";
import { SkillRegistry, SkillTool } from "@lyra/skills";
import { McpGateway } from "@lyra/mcp";
import { ToolRegistry, coerceScalars, createDefaultToolRegistry, dropPadding, type DefaultToolRegistryOptions, type LyraTool } from "@lyra/tools";
import type { CheckpointDiff, CheckpointRecord, CheckpointRestoreResult } from "@lyra/git";
import type { CodeMap } from "@lyra/map";
import { mapQueryVerbs, vocabularySuggestions, type MapAccess, type SnippetTarget } from "./code-map.ts";

/**
 * The advertised schemas below carry canonical fields only (LYRA.md §3.7).
 *
 * Aliases used to be declared so a model could see that its own spelling was legitimate.
 * Live evidence reversed that: a model on a strict proxy emits *every* declared property on
 * every call, so declaring `prompt` beside `task` taught it to fill both — and paid tokens
 * for the privilege. Every foreign spelling is still accepted, folded by the normalizers
 * below before validation, and listed in the alias tables that follow. The schema stays the
 * smallest true statement of what the tool takes.
 */

const LSP_DEFINITION: ToolDefinition = Object.freeze({
  name: "lsp",
  description: "Ask an auto-started language server for semantic navigation, diagnostics, rename, or code actions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      op: { type: "string", enum: ["definition", "references", "hover", "rename", "diagnostics", "codeAction"], description: "Which language-server request to make." },
      language: { type: "string", description: "Language id, inferred from the params uri when omitted." },
      params: { type: "object", description: "Raw LSP request params: { textDocument: { uri: \"file:///abs/path\" }, position: { line, character } } with zero-based line and character, plus newName for rename and range for codeAction." },
    },
    required: ["op", "params"],
  },
});

/**
 * One delegation primitive, and now one place to watch what it started.
 *
 * The description carries the whole loop because this is the only place a model reads it,
 * and because the loop is what was missing: a session was observed spawning a child
 * non-blocking and then having no way at all to ask how it was doing — `hub wait` answered
 * `[]`, `hub list` showed only itself, and the parent gave up and redid the work by hand.
 */
const SPAWN_DEFINITION: ToolDefinition = Object.freeze({
  name: "spawn",
  // The first 180 characters are what the system prompt's tool list shows, so the loop's
  // four verbs come first and stand on their own; the rest is read from the schema.
  description:
    "The only way to run a subagent (never a nested CLI via bash): spawn { task } starts one, spawn { id } collects it, op: \"status\" reports, op: \"cancel\" stops. " +
    "Starting returns { id, peer, status } at once — peer is the name to address it by — and a bad model reference fails right here, at the call, naming the valid candidates (no need to probe a model by hand first). " +
    "Steer a running child with hub { op: \"send\", to: peer }: it arrives at the child's next tool boundary, and its reply reaches you the same way. " +
    "hub { op: \"wait\", channel: \"agents\" } streams every child starting and finishing. " +
    "A shared-tree child's result names the files it changed; an isolated one carries a merge recipe under integration.hint. " +
    "Messaging a finished child revives it, transcript intact, with your message as its next instruction.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", minLength: 1, description: "The complete instruction for a new child. It sees none of this conversation except what task and context say." },
      context: { type: "string", description: "Background the child needs but that is not itself the instruction." },
      output_schema: { type: "object", description: "JSON schema the child's result must satisfy; supplying it is what makes the child a typed workflow instead of a prose subagent." },
      schema_mode: { type: "string", enum: ["permissive", "strict"], description: "How hard output_schema is enforced. Defaults to permissive." },
      model: { type: "string", description: "Model id for the child; defaults to this session's model." },
      tools: { type: "array", items: { type: "string" }, description: "Tool names the child may use; defaults to every tool this session has." },
      isolated: { type: "boolean", description: "Give the child its own copy-on-write workspace instead of sharing this one." },
      workspace: { type: "string", description: "Workspace name: an existing one to run in, or — with isolated — the name to give the new copy-on-write workspace." },
      writeScope: { type: "array", items: { type: "string", minLength: 1 }, description: "Paths or globs this child may write, relative to the shared tree. Its write and edit refuse anything outside. Use it to partition work between children." },
      blocking: { type: "boolean", description: "true waits for the child's result before returning; omitted or false returns immediately and you collect later with spawn { id }." },
      label: { type: "string", description: "Short name for this child; becomes its peer name on the hub when it is a single word." },
      depth: { type: "integer", minimum: 0, description: "Delegation depth guard; leave unset and it is tracked for you." },
      acp: { type: "string", minLength: 1, description: "Name of a registered external ACP harness to run the task instead of Lyra." },
      id: { type: "string", minLength: 1, description: "An existing child, by spawn id or peer name. Alone it collects the result; with op it inspects or stops the child." },
      op: { type: "string", enum: ["status", "cancel", "list"], description: "status reports one child, cancel stops it, list shows every child. Omit to start a child (with task) or collect one (with id)." },
      timeoutMs: { type: "integer", minimum: 1, description: "How long to wait when collecting a result. The 60-minute delegation deadline is both the default and the ceiling; a shorter one returns a status report instead of the result and leaves the child running." },
    },
    additionalProperties: false,
  },
});

const HUB_DEFINITION: ToolDefinition = Object.freeze({
  name: "hub",
  description:
    "Talk to the other agents in this session. send addresses one peer by name, publish fans out to a channel, wait blocks for the next message with a deadline, inbox drains what arrived, list shows every peer with its state. " +
    "A message to a running agent folds into its next turn; a message to a finished one revives it. " +
    // Said because the default was invisible and read as the opposite: your own children's
    // endings are addressed to you, so `hub wait` with no channel already sees them. A model
    // that believes it must subscribe first waits on a channel it never joined.
    "Your own children's terminal events are addressed to you directly and arrive without subscribing — a plain wait or inbox sees them. " +
    "Subscribe to channel \"agents\" for the whole swarm's lifecycle, including children you did not spawn.",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["send", "publish", "subscribe", "unsubscribe", "wait", "inbox", "list"], description: "Which bus operation to perform." },
      to: { type: "string", description: "Recipient peer name. Required for send; it is the \"peer\" a spawn result reports." },
      peer: { type: "string", description: "Peer to subscribe, inspect, or wait for; defaults to this agent." },
      channel: { type: "string", description: "Channel name. Required for publish, subscribe, and unsubscribe; selects a channel wait." },
      message: { type: "string", description: "Message text." },
      data: { description: "Structured payload carried alongside message." },
      timeoutMs: { type: "integer", minimum: 0, description: "Deadline for wait, in milliseconds. Capped at 10 minutes." },
      await: { type: "boolean", description: "For send and publish: block until a revived recipient has acknowledged the message." },
    },
    required: ["op"],
    additionalProperties: false,
  },
});

/**
 * The description names `lyra:runtime` because nothing else does.
 *
 * §8's load-bearing claim is that a JIT script can delegate — `lyra.spawn()` inside a loop is
 * how an orchestration runs out of this context window. A model reading only "declare, run,
 * list, promote" writes a script that can compute and nothing else, because the one import
 * that makes the tool worth having was never mentioned anywhere it would read.
 */
const JIT_DEFINITION: ToolDefinition = Object.freeze({
  name: "jit",
  description:
    "Declare, run, list, or promote a session-scoped resumable TypeScript script that orchestrates work outside this context window. " +
    "The script imports { lyra } from \"lyra:runtime\" for lyra.spawn/exec/read/write/edit/glob/grep, lyra.irc.send/publish/wait, lyra.git.preview/apply/rollback, lyra.workspace.create/list/drop, lyra.checkpoint(state) to resume across restarts, and lyra.report(msg) — the only thing that reaches this conversation. " +
    "Use it when the loop, the branching, and the intermediate results should not cost context.",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["declare", "run", "list", "promote"], description: "declare stores source, run executes it, list enumerates scripts, promote copies one to .lyra/tools so it outlives this session." },
      name: { type: "string", minLength: 1, description: "Script name, lowercase with dashes. Required for declare, run, and promote." },
      source: { type: "string", minLength: 1, description: "TypeScript module source with a default export function (input, { checkpoint }). Required for declare." },
      input: { description: "Value passed to the script's default export by run." },
    },
    required: ["op"],
    additionalProperties: false,
  },
});

/**
 * The code graph, as one tool.
 *
 * The first 180 characters are the whole of what the system prompt's tool index shows, and
 * they have one job: make a model reach here *before* it greps. That is the spawn-vs-nested-
 * CLI lesson applied again — a capability a model has to be persuaded to use loses to the
 * habit it arrived with unless its one line says plainly that it is the cheaper path.
 *
 * The constrained-vocabulary rule lives in this description rather than in the prompt (§14
 * stays an index), because it is a rule about *this* tool's arguments: the index holds
 * identifiers, so a query invented out of English synonyms searches for words that were
 * never in the code.
 */
const MAP_DEFINITION: ToolDefinition = Object.freeze({
  name: "map",
  description:
    "The codebase graph: instant architecture, symbol search, who-calls-what, and change impact — cheaper than grep-and-read exploration. Explore here first; grep only for text. " +
    "ops: overview (the default) is the repository's shape; search { query } finds symbols by name; explain { symbol } gives one symbol's definition, callers, and callees; impact { symbol, depth } is what changing it would reach; path { from, to } is how two symbols connect; snippet { symbol } returns that symbol's exact source, read from disk. " +
    "The graph indexes identifiers, not prose: widen a query only with tokens the graph itself has shown you — names it printed, path segments it listed — never with an invented synonym. " +
    "Answers are budget-bounded and budget moves that bound. When files have changed since indexing, the answer ends with a stale line naming them; those files are ground truth, so read them.",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["overview", "search", "explain", "impact", "path", "snippet"], description: "Which question to ask. Defaults to overview, or is inferred from the fields sent." },
      query: { type: "string", minLength: 1, description: "search: identifier fragments to look for, in the graph's own vocabulary." },
      symbol: { type: "string", minLength: 1, description: "explain, impact, snippet: a symbol name, a qualified name, or a file path." },
      from: { type: "string", minLength: 1, description: "path: the symbol the connection starts at." },
      to: { type: "string", minLength: 1, description: "path: the symbol the connection ends at." },
      depth: { type: "integer", minimum: 1, description: "impact: how many hops of callers to follow. Small numbers answer the question; large ones bury it." },
      budget: { type: "integer", minimum: 1, description: "Rough ceiling on the size of the answer. Omit for the default, which is sized for a normal turn." },
    },
    additionalProperties: false,
  },
});

/**
 * Foreign spellings accepted at runtime and deliberately absent from the advertised schemas:
 * Claude Code's `prompt` / `description` / `timeout`, the camelCase and snake_case variants
 * of Lyra's own names, and the handle spellings a model reaches for when it wants to name a
 * child it already started. A canonical field always wins its own name; a disagreeing pair
 * is refused by name.
 */
const SPAWN_ALIASES: readonly ToolAlias[] = Object.freeze([
  { canonical: "task", aliases: ["prompt", "instruction"] },
  { canonical: "label", aliases: ["description", "name"] },
  { canonical: "output_schema", aliases: ["outputSchema"] },
  { canonical: "schema_mode", aliases: ["schemaMode"] },
  { canonical: "writeScope", aliases: ["write_scope", "scope"] },
  { canonical: "id", aliases: ["spawnId", "spawn_id", "agentId", "agent_id", "handle", "peer"] },
  { canonical: "timeoutMs", aliases: ["timeout", "timeout_ms"] },
]);
const HUB_ALIASES: readonly ToolAlias[] = Object.freeze([
  { canonical: "message", aliases: ["text", "msg", "body"] },
  { canonical: "timeoutMs", aliases: ["timeout", "timeout_ms"] },
  { canonical: "to", aliases: ["agent", "recipient"] },
  { canonical: "channel", aliases: ["topic"] },
]);
const JIT_ALIASES: readonly ToolAlias[] = Object.freeze([
  { canonical: "source", aliases: ["code", "script"] },
  { canonical: "name", aliases: ["script_name", "scriptName"] },
]);
const LSP_ALIASES: readonly ToolAlias[] = Object.freeze([
  { canonical: "params", aliases: ["arguments", "args"] },
  { canonical: "op", aliases: ["operation", "method"] },
]);
/**
 * `map` is the tool a model has the strongest priors about, because every harness it has
 * seen spells "look something up in the code" differently: `q`, `pattern`, `file_path`,
 * `max_depth`. Each of these is a first call that would otherwise be refused by
 * `additionalProperties: false` for saying the right thing in the wrong dialect.
 */
const MAP_ALIASES: readonly ToolAlias[] = Object.freeze([
  { canonical: "op", aliases: ["operation", "mode", "action", "verb", "command", "kind"] },
  { canonical: "query", aliases: ["q", "search", "term", "text", "pattern", "keyword", "keywords"] },
  { canonical: "symbol", aliases: ["name", "qn", "target", "identifier", "symbol_name", "symbolName", "file_path", "filePath", "path", "file"] },
  { canonical: "from", aliases: ["source", "start", "src"] },
  { canonical: "to", aliases: ["destination", "dest", "end", "dst"] },
  { canonical: "depth", aliases: ["levels", "maxDepth", "max_depth", "hops"] },
  { canonical: "budget", aliases: ["maxTokens", "max_tokens", "tokens", "limit", "maxBytes"] },
]);

/** Optional fields a schema-complete emitter pads. A number below a documented minimum is padding. */
const SPAWN_PADDING = Object.freeze({ context: true as const, model: true as const, workspace: true as const, label: true as const, acp: true as const, schema_mode: true as const, id: true as const, op: true as const, task: true as const, timeoutMs: 1, depth: 0 });
const SPAWN_SCALARS = Object.freeze({ isolated: "boolean" as const, blocking: "boolean" as const, run_in_background: "boolean" as const, depth: "integer" as const, timeoutMs: "integer" as const });
const HUB_PADDING = Object.freeze({ to: true as const, peer: true as const, channel: true as const, message: true as const, timeoutMs: 0 });
const HUB_SCALARS = Object.freeze({ timeoutMs: "integer" as const, await: "boolean" as const });
const JIT_PADDING = Object.freeze({ name: true as const, source: true as const });
const LSP_PADDING = Object.freeze({ language: true as const });
/** Every `map` field is optional, so a schema-complete emitter pads all seven of them. */
const MAP_PADDING = Object.freeze({ op: true as const, query: true as const, symbol: true as const, from: true as const, to: true as const, depth: 1, budget: 1 });
const MAP_SCALARS = Object.freeze({ depth: "integer" as const, budget: "integer" as const });

/**
 * The op a model meant, from the word it used.
 *
 * Every spelling here was reachable from the tool's own description or from another
 * harness's vocabulary — `callers` for impact, `source` for snippet, `find` for search.
 * Refusing them would be refusing a call that named the right operation.
 */
const MAP_OPS: Readonly<Record<string, string>> = Object.freeze({
  overview: "overview", architecture: "overview", summary: "overview", outline: "overview", structure: "overview", tree: "overview", map: "overview", repo: "overview",
  search: "search", find: "search", lookup: "search", query: "search", symbols: "search", grep: "search",
  explain: "explain", describe: "explain", info: "explain", detail: "explain", details: "explain", symbol: "explain", definition: "explain",
  impact: "impact", callers: "impact", caller: "impact", who_calls: "impact", whocalls: "impact", dependents: "impact", usages: "impact", references: "impact", blast: "impact", blast_radius: "impact",
  path: "path", path_between: "path", pathbetween: "path", between: "path", connect: "path", route: "path", trace: "path",
  snippet: "snippet", source: "snippet", code: "snippet", body: "snippet", show: "snippet", read: "snippet",
});

/**
 * `map` takes no required field, so the call has to be *read* rather than validated: a call
 * carrying only `symbol` is an explain, one carrying `from` and `to` is a path, and a bare
 * call is the overview. Inference happens after padding is dropped, for the same reason
 * `edit`'s mode inference does — an emitter that filled every field with `""` would
 * otherwise be read as asking for the op whose field it padded first.
 */
export function normalizeMapArgs(input: unknown): unknown | string {
  const folded = dropPadding(coerceScalars(foldToolAliases(input, MAP_ALIASES, "map"), MAP_SCALARS), MAP_PADDING);
  if (typeof folded === "string") return folded;
  const args = toolArgs(folded);
  if (args === undefined) return folded;
  const output: Record<string, unknown> = { ...args };
  if (output.op !== undefined) {
    if (typeof output.op !== "string") return "op must be a string: overview, search, explain, impact, path, or snippet.";
    const canonical = MAP_OPS[output.op.trim().toLowerCase().replace(/[\s-]+/g, "_")];
    if (canonical === undefined) return `map op ${JSON.stringify(output.op)} is not one of overview, search, explain, impact, path, or snippet. Omit op entirely for the repository overview.`;
    output.op = canonical;
  } else {
    // A call that named two endpoints wanted a path; one that named a symbol wanted that
    // symbol explained; one that named nothing wanted the repository. `from` *without* `to`
    // still infers a path, so the answer is "a path needs both ends" rather than an overview
    // that quietly ignored the one end the call did name.
    output.op = output.from !== undefined || output.to !== undefined ? "path"
      : output.query !== undefined ? "search"
      : output.symbol !== undefined ? "explain"
      : "overview";
  }
  // One subject, two field names: a search that put its words in `symbol` and an explain that
  // put its symbol in `query` both said something unambiguous, so both are taken at their word.
  if (output.op === "search" && output.query === undefined && typeof output.symbol === "string") { output.query = output.symbol; delete output.symbol; }
  if ((output.op === "explain" || output.op === "impact" || output.op === "snippet") && output.symbol === undefined && typeof output.query === "string") { output.symbol = output.query; delete output.query; }
  if (output.op === "path" && (output.from === undefined || output.to === undefined)) {
    return `map op "path" needs both from and to — the two symbols to connect. Use op "impact" for everything one symbol reaches.`;
  }
  if (output.op === "search" && output.query === undefined) return `map op "search" needs query: the identifier fragments to look for.`;
  if ((output.op === "explain" || output.op === "impact" || output.op === "snippet") && output.symbol === undefined) {
    return `map op ${JSON.stringify(output.op)} needs symbol: a symbol name, a qualified name, or a file path. Run map { op: "search", query: "..." } to find the name first.`;
  }
  // A field belonging to another op is neither dropped nor refused here: dropping it would be
  // §3.7.5's accept-and-ignore, and refusing a call that is otherwise answerable would cost a
  // round trip to say something the answer can carry. It reaches the handler, which names it.
  return output;
}

/** Which fields each op reads. Anything else the call carried is reported, never ignored. */
const MAP_OP_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  overview: [], search: ["query"], explain: ["symbol"], impact: ["symbol", "depth"], path: ["from", "to"], snippet: ["symbol"],
});

/** The §3.8 sentence for a field the chosen op does not read: said, rather than swallowed. */
function unusedMapFields(op: string, value: Record<string, unknown>): string | undefined {
  const used = new Set([...(MAP_OP_FIELDS[op] ?? []), "op", "budget"]);
  const extra = Object.keys(value).filter((field) => !used.has(field));
  if (extra.length === 0) return undefined;
  return `note: ${extra.join(" and ")} ${extra.length === 1 ? "is not read" : "are not read"} by op ${JSON.stringify(op)}, so ${extra.length === 1 ? "it was" : "they were"} ignored — ${extra.map((field) => `${field} belongs to ${describeMapField(field)}`).join(", ")}.`;
}
function describeMapField(field: string): string {
  switch (field) {
    case "query": return `op "search"`;
    case "symbol": return `ops "explain", "impact", and "snippet"`;
    case "depth": return `op "impact"`;
    case "from": case "to": return `op "path"`;
    default: return "another op";
  }
}

/** Lyra has one delegation primitive, so a named agent type has nothing to select (§7). */
export function normalizeSpawnArgs(input: unknown): unknown | string {
  for (const field of ["subagent_type", "subagentType"]) {
    const lesson = rejectedField(input, field, `${field} is not supported: spawn has one primitive and no agent registry. Put the role in task, narrow the child with tools, and give it output_schema when you need a typed result.`);
    if (lesson !== undefined) return lesson;
  }
  const folded = dropPadding(coerceScalars(foldToolAliases(input, SPAWN_ALIASES, "spawn"), SPAWN_SCALARS), SPAWN_PADDING);
  if (typeof folded === "string") return folded;
  const args = toolArgs(folded);
  if (args === undefined) return folded;
  // Two of spawn's optionals flip its mode entirely — `acp` reroutes to an external harness,
  // `output_schema` turns a prose subagent into a typed workflow — so a padded value must be
  // dropped before it can change what the tool does. An empty output_schema constrains
  // nothing; an empty tools array would silently leave a child with no tools at all.
  const cleaned: Record<string, unknown> = { ...args };
  const schema = cleaned.output_schema;
  if (schema === null || (typeof schema === "object" && schema !== null && !Array.isArray(schema) && Object.keys(schema).length === 0)) {
    delete cleaned.output_schema;
  }
  for (const field of ["tools", "writeScope"]) {
    const value = cleaned[field];
    if (value === null || (Array.isArray(value) && value.length === 0)) delete cleaned[field];
  }
  for (const field of ["isolated", "blocking", "run_in_background"]) {
    if (cleaned[field] === null) delete cleaned[field];
  }
  if (cleaned.run_in_background !== undefined) {
    if (typeof cleaned.run_in_background !== "boolean") return "run_in_background must be a boolean; it is the inverse of blocking.";
    const blocking = !cleaned.run_in_background;
    if (cleaned.blocking !== undefined && cleaned.blocking !== blocking) return `spawn received both blocking and run_in_background asking for opposite things; run_in_background: ${cleaned.run_in_background} means blocking: ${blocking}, so send blocking alone.`;
    cleaned.blocking = blocking;
    delete cleaned.run_in_background;
  }
  // The call has to name what it is doing. Saying so here, once, is cheaper than three
  // different downstream errors that each describe one missing field.
  if (cleaned.op === "list") return cleaned;
  if (cleaned.task === undefined && cleaned.id === undefined) {
    return `spawn needs either task (to start a child) or id (to collect, inspect, or cancel one). Run spawn { op: "list" } to see the children this session has.`;
  }
  if (cleaned.task !== undefined && cleaned.id !== undefined) {
    return `spawn received both task and id, which ask for different things: task starts a new child, id addresses one that already exists. Send one of them.`;
  }
  if (cleaned.op !== undefined && cleaned.id === undefined) {
    return `spawn op ${JSON.stringify(cleaned.op)} needs an id naming the child it applies to, or op "list" to see every child.`;
  }
  return cleaned;
}
export function normalizeHubArgs(input: unknown): unknown | string {
  // `from` used to be accepted, which let one agent send under another's name and produced
  // the unactionable `Unknown sender peer: root` when the name was invented. An agent sends
  // as itself; there is nothing legitimate the field expressed.
  const lesson = rejectedField(input, "from", `from is not supported: every message is sent as this agent, under the peer name its own spawn result reported. To reach a specific agent use to; to see the names that exist use hub { op: "list" }.`);
  if (lesson !== undefined) return lesson;
  return dropPadding(coerceScalars(foldToolAliases(input, HUB_ALIASES, "hub"), HUB_SCALARS), HUB_PADDING);
}
export function normalizeJitArgs(input: unknown): unknown | string {
  return dropPadding(foldToolAliases(input, JIT_ALIASES, "jit"), JIT_PADDING);
}
/**
 * `lsp` takes raw LSP params, and the commonest first call flattens them — `uri`, `line`,
 * `character` at the top level. That is a reasonable reading of "raw params" and is folded
 * into the nested shape rather than refused by `additionalProperties`.
 */
export function normalizeLspArgs(input: unknown): unknown | string {
  const folded = dropPadding(foldToolAliases(input, LSP_ALIASES, "lsp"), LSP_PADDING);
  if (typeof folded === "string") return folded;
  const args = toolArgs(folded);
  if (args === undefined) return folded;
  const flat = ["uri", "line", "character", "newName", "range", "textDocument", "position"].filter((field) => args[field] !== undefined && args[field] !== null);
  if (flat.length === 0) return args;
  const output: Record<string, unknown> = { ...args };
  const params: Record<string, unknown> = { ...(toolArgs(args.params) ?? {}) };
  for (const field of flat) delete output[field];
  if (args.textDocument !== undefined) params.textDocument ??= args.textDocument;
  if (typeof args.uri === "string") params.textDocument ??= { uri: args.uri };
  if (args.position !== undefined) params.position ??= args.position;
  if (typeof args.line === "number" || typeof args.character === "number") {
    params.position ??= { line: typeof args.line === "number" ? args.line : 0, character: typeof args.character === "number" ? args.character : 0 };
  }
  if (args.newName !== undefined) params.newName ??= args.newName;
  if (args.range !== undefined) params.range ??= args.range;
  output.params = params;
  return output;
}

export class LspTool implements LyraTool {
  readonly definition = LSP_DEFINITION;
  constructor(private readonly manager: LspManager, private readonly owned = false) {}
  normalize(args: unknown): unknown | string { return normalizeLspArgs(args); }
  async execute(input: unknown, _context: ToolExecutionContext): Promise<ToolExecutionResult> { try { const value = objectInput(input, "lsp"); const op = stringField(value, "op"); if (!("params" in value)) throw new Error("lsp requires params."); const language = typeof value.language === "string" ? value.language : undefined; let result: unknown; switch (op) { case "definition": result = await this.manager.definition(value.params, language); break; case "references": result = await this.manager.references(value.params, language); break; case "hover": result = await this.manager.hover(value.params, language); break; case "rename": result = await this.manager.rename(value.params, language); break; case "diagnostics": result = await this.manager.diagnostics(value.params, language); break; case "codeAction": result = await this.manager.codeAction(value.params, language); break; default: throw new Error("lsp op must be definition, references, hover, rename, diagnostics, or codeAction."); } return { content: JSON.stringify(result) }; } catch (error) { return failed("LSP", error); } }
  async close(): Promise<void> { if (this.owned) await this.manager.close(); }
}

/**
 * The `map` tool: six questions against one graph, and one sentence of truth about drift.
 *
 * Two properties are load-bearing and neither is in the query verbs:
 *
 * - **Every answer ends with the staleness line when the tree has moved on.** A code graph
 *   that quietly answers from yesterday's parse is the failure mode that makes indexes
 *   untrustworthy, and §3.8 forbids the silent version of it. The line names the files and
 *   says what to do about them.
 * - **`snippet` reads from disk, through `read`.** The graph stores line ranges and never
 *   source text, so the exact bytes must come from the file — and going through the read
 *   tool rather than around it is what makes a 4 MB generated file spill to an artifact here
 *   exactly as it would anywhere else, instead of landing whole in the context window.
 */
export class MapTool implements LyraTool {
  readonly definition = MAP_DEFINITION;
  constructor(private readonly service: MapAccess | undefined, private readonly read: LyraTool) {}
  normalize(args: unknown): unknown | string { return normalizeMapArgs(args); }

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const normalized = normalizeMapArgs(input);
      if (typeof normalized === "string") return { content: `Invalid map arguments: ${normalized}`, isError: true };
      const value = objectInput(normalized, "map");
      const op = typeof value.op === "string" ? value.op : "overview";
      const service = this.service;
      if (service === undefined) {
        return { content: "The code graph is not available in this session, so map has nothing to answer from. Explore with grep, glob, and read.", isError: true };
      }
      // Lazily for an isolated child: the first question is what builds its workspace's graph.
      service.ensureStarted();
      const status = service.status();
      if (status.phase === "unavailable") {
        return { content: `The code graph is unavailable for this session: ${status.reason ?? "the index could not be opened."} It will not recover before a restart. Explore with grep, glob, and read instead.`, isError: true };
      }
      const graph = service.graph();
      if (graph === undefined) {
        return {
          content: `The code graph is still being built: indexing — ${status.indexed} of ${status.total} files. Nothing is queryable yet, and no answer is better than a wrong one. Ask again in a few seconds, or explore with grep and read now.`,
        };
      }
      const budget = typeof value.budget === "number" ? value.budget : undefined;
      const answer = op === "snippet"
        ? await this.snippet(graph, stringField(value, "symbol"), context)
        : await this.query(graph, op, value, budget);
      if (answer.isError === true || typeof answer.content !== "string") return answer;
      const trailer = [unusedMapFields(op, value), await service.staleLine()].filter((line) => line !== undefined);
      return trailer.length === 0 ? answer : { ...answer, content: `${answer.content}\n${trailer.join("\n")}` };
    } catch (error) { return failed("Map", error); }
  }

  /** The five TOON-answering verbs, each bound at call time from `@lyra/map`. */
  private async query(graph: CodeMap, op: string, value: Record<string, unknown>, budget: number | undefined): Promise<ToolExecutionResult> {
    const verbs = mapQueryVerbs();
    const options = budget === undefined ? undefined : { budget };
    let answer: unknown;
    switch (op) {
      case "overview": {
        if (typeof verbs.overview !== "function") return notWired("overview", "overview");
        answer = await verbs.overview(graph, options);
        break;
      }
      case "search": {
        if (typeof verbs.search !== "function") return notWired("search", "search");
        answer = await verbs.search(graph, stringField(value, "query"), options);
        break;
      }
      case "explain": {
        if (typeof verbs.explain !== "function") return notWired("explain", "explain");
        answer = await verbs.explain(graph, stringField(value, "symbol"), options);
        break;
      }
      case "impact": {
        if (typeof verbs.impact !== "function") return notWired("impact", "impact");
        const depth = typeof value.depth === "number" ? value.depth : undefined;
        answer = await verbs.impact(graph, stringField(value, "symbol"), { ...(options ?? {}), ...(depth === undefined ? {} : { depth }) });
        break;
      }
      case "path": {
        if (typeof verbs.pathBetween !== "function") return notWired("path", "pathBetween");
        answer = await verbs.pathBetween(graph, stringField(value, "from"), stringField(value, "to"), options);
        break;
      }
      default: return { content: `map op must be overview, search, explain, impact, path, or snippet; received ${JSON.stringify(op)}.`, isError: true };
    }
    const text = typeof answer === "string" ? answer : JSON.stringify(answer);
    if (text.trim().length > 0) return { content: text };
    // An empty answer is a real result — the graph knows nothing by that name — and the one
    // useful thing to say next is which names it *does* know (§3.7.1: never a dead end).
    const term = typeof value.query === "string" ? value.query : typeof value.symbol === "string" ? value.symbol : undefined;
    return { content: `${op} found nothing for ${JSON.stringify(term ?? "")} in the graph.${suggestionLine(graph, term)}` };
  }

  /**
   * A symbol's exact source: the graph resolves the range, the file provides the bytes.
   *
   * Three answers, and the two that are not source text are the point of resolving through
   * the graph at all — an ambiguous name comes back as the candidates to choose between, and
   * an unknown one comes back with the vocabulary that would have worked.
   */
  private async snippet(graph: CodeMap, symbol: string, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const verb = mapQueryVerbs().snippetTarget;
    if (typeof verb !== "function") return notWired("snippet", "snippetTarget");
    const located = verb(graph, symbol);
    if (located === undefined) {
      return { content: `No symbol named ${JSON.stringify(symbol)} is in the graph.${suggestionLine(graph, symbol)} Run map { op: "search", query: "..." } to find the name the code uses.` };
    }
    if (!isSnippetTarget(located)) {
      const names = located.candidates.map((candidate) => typeof candidate === "string" ? candidate : candidate.qn ?? candidate.file ?? "").filter((name) => name.length > 0);
      return { content: `${JSON.stringify(symbol)} names ${names.length} symbols in this repository: ${names.join(", ")}. Ask again with the qualified name of the one you meant.` };
    }
    const path = resolve(graph.root, located.file);
    const result = await this.read.execute({ path, startLine: located.start, endLine: located.end }, context);
    if (typeof result.content !== "string") return result;
    // The read tool's own display budget and artifact spill already applied; the header is
    // added rather than substituted so the #TAG it printed still guards a following edit.
    return { ...result, content: `${located.file}:${located.start}-${located.end} — ${located.qn}\n${result.content}` };
  }
}

function isSnippetTarget(value: SnippetTarget | { candidates: unknown }): value is SnippetTarget {
  return typeof (value as SnippetTarget).file === "string";
}

/**
 * A verb wave 2 has not exported yet. Said as a fact about the build rather than as a
 * failure of the call, because there is nothing the model could have sent that would work.
 */
function notWired(op: string, verb: string): ToolExecutionResult {
  return {
    content: `map op ${JSON.stringify(op)} is not yet wired: @lyra/map exports no ${verb}(). The other ops still work, and grep, glob, and read answer this question the long way.`,
    isError: true,
  };
}

/** The graph's own words for what the caller was reaching for, when it has any. */
function suggestionLine(graph: CodeMap, term: string | undefined): string {
  const words = vocabularySuggestions(graph, term);
  return words.length === 0 ? "" : ` The graph does know: ${words.join(", ")} — widen the query with those, not with synonyms.`;
}

/** How long a collect waits before it answers with a status report instead (§3.4). */
export const SPAWN_COLLECT_DEFAULT_MS = 60 * 60 * 1000;

/**
 * The delegation tool: start a child, then keep track of it.
 *
 * Starting is unchanged. Everything else is new, and every one of it exists because a real
 * session could not do it: ask a running child how it is doing, collect a result later,
 * stop a child, or find out *why* a blocking spawn ran out of time.
 */
export class SpawnTool implements LyraTool {
  readonly definition = SPAWN_DEFINITION;
  constructor(private readonly manager: SpawnManager, private readonly parent?: SpawnParentContext) {}
  normalize(args: unknown): unknown | string { return normalizeSpawnArgs(args); }

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const normalized = normalizeSpawnArgs(input);
      if (typeof normalized === "string") return { content: `Invalid spawn arguments: ${normalized}`, isError: true };
      const value = objectInput(normalized, "spawn");
      const op = typeof value.op === "string" ? value.op : undefined;
      if (op === "list") return { content: JSON.stringify({ agents: this.manager.statusList() }) };
      const reference = typeof value.id === "string" ? value.id : undefined;
      if (reference !== undefined) {
        if (op === "status") return this.status(reference);
        if (op === "cancel") return this.cancel(reference);
        return this.collect(reference, numberField(value, "timeoutMs"));
      }
      return await this.start(value, context.signal);
    } catch (error) { return failed("Spawn", error); }
  }

  /**
   * Start a child. Non-blocking answers with the two names the rest of the loop needs.
   *
   * The model is resolved *here*, before anything is queued. It used to be resolved inside
   * the child's own first turn, which meant `spawn { model: "claude-max/opus-5" }` answered
   * `status: running` with a handle to an agent that could never run, and the reason —
   * `model: opus-5`, prefix stripped, cause unnamed — reached the parent through the bus
   * minutes later. A model this session cannot serve is a mistake in *this* call, so it is
   * reported as this call's result and no child is created.
   */
  private async start(value: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const request = spawnRequest(value);
    try {
      await this.manager.assertModelUsable(request.model, signal);
    } catch (error) {
      return { content: `No child was started: ${error instanceof Error ? error.message : String(error)} Correct the model and call spawn again, or omit model entirely to inherit this session's.`, isError: true };
    }
    if (request.blocking === true) {
      const { blocking: _blocking, ...rest } = request;
      const handle = this.manager.spawn({ ...rest, blocking: false }, this.parent);
      return this.collect(handle.id, numberField(value, "timeoutMs"));
    }
    const handle = this.manager.spawn({ ...request, blocking: false }, this.parent);
    // Read back rather than echoed: a `writeScope` is written relative to a tree the call
    // never names, and the resolved paths are the only way a parent that rooted it wrongly
    // finds out now instead of at the child's first refused write.
    const started = this.manager.status(handle.id);
    return {
      content: JSON.stringify({
        id: handle.id,
        peer: handle.peer,
        status: handle.status,
        ...(handle.label === undefined ? {} : { label: handle.label }),
        workspace: handle.workspace,
        ...(started?.writeScope === undefined ? {} : { writeScope: started.writeScope, writeScopeResolved: started.writeScopeResolved }),
        next: `Collect with spawn { id: ${JSON.stringify(handle.id)} }, check on it with spawn { id: ${JSON.stringify(handle.id)}, op: "status" }, or talk to it with hub { op: "send", to: ${JSON.stringify(handle.peer)}, message: "..." }.`,
      }),
    };
  }

  /**
   * Wait for a result, and on expiry say what the child is doing instead of failing.
   *
   * The expiry answer is the whole point: an observer's deadline never touches the job, so
   * "not yet" is a report with an id in it, not an error. A model reading it can wait
   * again, steer the child, or stop it, and knows which of those makes sense.
   */
  private async collect(reference: string, timeoutMs?: number): Promise<ToolExecutionResult> {
    const before = this.manager.status(reference);
    if (before === undefined) return { content: this.unknown(reference), isError: true };
    // Clamped here, not just in the manager: the manager already bounds its own wait at
    // MAX_SPAWN_WAIT_MS, and reporting the *requested* number in the diagnosis told a model
    // that asked for 90 minutes it had waited 90 when it had waited 60.
    const waited = Math.min(timeoutMs ?? SPAWN_COLLECT_DEFAULT_MS, MAX_SPAWN_WAIT_MS);
    try {
      const result = await this.manager.wait(before.id, waited);
      return { content: JSON.stringify({ collected: true, ...result }), ...progressFor(result.filesModified) };
    } catch (error) {
      if (error instanceof SpawnTimeoutError) return { content: JSON.stringify(this.diagnostics(before.id, waited)) };
      const status = this.manager.status(before.id);
      return {
        content: JSON.stringify({
          collected: false,
          id: before.id,
          peer: before.peer,
          status: status?.status ?? "failed",
          error: error instanceof Error ? error.message : String(error),
          ...(status === undefined ? {} : { detail: status }),
          // A child that died at resolution never ran, so the revive path is not merely
          // unhelpful here — it is the one instruction that cannot work, aimed at the one
          // failure it cannot repair. Its name is already free for the replacement to take.
          next: status?.revivable === false
            ? `The child never ran, so there is nothing to revive and its name ${JSON.stringify(before.peer)} has been released. Fix the spawn call — the error above says what could not be resolved — and start a new child with spawn { task: "..." }.`
            : `The child did not produce a result. Read its partialOutput and lastActivity above, then either re-spawn it with a narrower task or send it a message with hub { op: "send", to: ${JSON.stringify(before.peer)} } to revive it with corrected instructions.`,
        }),
        isError: true,
      };
    }
  }

  /**
   * The answer to "was the model unavailable? did it start? was there partial output?" —
   * the three questions a bare deadline could not answer.
   */
  private diagnostics(id: string, waitedMs: number): Record<string, unknown> {
    const status = this.manager.status(id);
    if (status === undefined) return { collected: false, id, note: this.unknown(id) };
    const idle = Math.max(0, Date.now() - status.lastActivity);
    return {
      collected: false,
      id: status.id,
      peer: status.peer,
      status: status.status,
      waitedMs,
      elapsedMs: status.elapsedMs,
      msSinceLastActivity: idle,
      toolCalls: status.toolCalls,
      ...(status.currentTool === undefined ? {} : { currentTool: status.currentTool }),
      ...(status.model === undefined ? {} : { model: status.model }),
      filesModified: status.filesModified,
      ...(status.partialOutput === undefined ? {} : { partialOutput: status.partialOutput }),
      diagnosis: describeStall(status, idle),
      next: `The child was not cancelled and is still ${status.status}. Wait again with spawn { id: ${JSON.stringify(status.id)} }, watch it with spawn { id: ${JSON.stringify(status.id)}, op: "status" }, redirect it with hub { op: "send", to: ${JSON.stringify(status.peer)}, message: "..." }, or stop it with spawn { id: ${JSON.stringify(status.id)}, op: "cancel" }.`,
    };
  }

  private status(reference: string): ToolExecutionResult {
    const status = this.manager.status(reference);
    if (status === undefined) return { content: this.unknown(reference), isError: true };
    return { content: JSON.stringify(status) };
  }

  /**
   * Stop a child — and say something true when the race is lost.
   *
   * A cancel that arrives after the child finished is not a failure and must not read like
   * one: the work is done and the result is still collectable, which is better news than
   * the cancel succeeding would have been.
   */
  private cancel(reference: string): ToolExecutionResult {
    const status = this.manager.status(reference);
    if (status === undefined) return { content: this.unknown(reference), isError: true };
    const cancelled = this.manager.cancel(status.id);
    if (cancelled) return { content: JSON.stringify({ cancelled: true, id: status.id, peer: status.peer, status: "cancelled" }) };
    const after = this.manager.status(status.id) ?? status;
    return {
      content: JSON.stringify({
        cancelled: false,
        id: after.id,
        peer: after.peer,
        status: after.status,
        note: after.resultAvailable
          ? `${after.id} finished before the cancel reached it. Nothing was stopped and nothing was lost — collect its result with spawn { id: ${JSON.stringify(after.id)} }.`
          : `${after.id} was already ${after.status}, so there was nothing to cancel.`,
      }),
    };
  }

  private unknown(reference: string): string {
    const live = this.manager.statusList().filter((status) => status.resultAvailable || !["completed", "failed", "cancelled", "timed_out"].includes(status.status));
    return `No child answers to ${JSON.stringify(reference)}. ` +
      (live.length === 0
        ? `This session has no children to address. Start one with spawn { task: "..." }.`
        : `Children this session knows: ${live.map((status) => `${status.id} (${status.peer}, ${status.status})`).join(", ")}. Run spawn { op: "list" } for the full picture.`);
  }
}

/** A plain sentence about why a wait came back empty, from what was actually measured. */
function describeStall(status: SpawnStatus, idleMs: number): string {
  if (status.status === "queued") return "It has not started yet: it is behind other work in the queue.";
  if (status.status === "starting") return "It is still starting: its workspace or provider has not come up yet.";
  if (status.toolCalls === 0 && status.partialOutput === undefined) {
    return `It started but has produced nothing at all in ${Math.round(status.elapsedMs / 1000)}s — no tool call and no output. That usually means its provider or model is not answering.`;
  }
  if (status.status === "awaiting_tool") return `It is inside ${status.currentTool ?? "a tool call"}, which has been running for ${Math.round(idleMs / 1000)}s.`;
  return `It is working: ${status.toolCalls} tool call(s) so far, last activity ${Math.round(idleMs / 1000)}s ago.`;
}

function progressFor(filesModified?: readonly string[]): { progress?: { filesModified: Array<{ path: string }> } } {
  return filesModified === undefined || filesModified.length === 0 ? {} : { progress: { filesModified: filesModified.map((path) => ({ path })) } };
}

/**
 * A child's live state as the bus's own vocabulary cannot express it.
 *
 * `hub list` used to answer with peer records alone — a name and `running`/`parked` — which
 * is true and useless: it could not distinguish a child three tool calls into its work from
 * one that failed on its first. The spawn manager knows; this is how `hub` asks.
 */
export interface AgentDirectory {
  status(peer: string): SpawnStatus | undefined;
}

export class HubTool implements LyraTool {
  readonly definition = HUB_DEFINITION;
  constructor(private readonly bus: IrcBus, private readonly defaultPeer: string, private readonly agents?: AgentDirectory) {}
  normalize(args: unknown): unknown | string { return normalizeHubArgs(args); }
  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const normalized = normalizeHubArgs(input);
      if (typeof normalized === "string") return { content: `Invalid hub arguments: ${normalized}`, isError: true };
      const value = objectInput(normalized, "hub");
      const op = stringField(value, "op");
      const from = this.defaultPeer;
      switch (op) {
        case "send": {
          const to = stringField(value, "to");
          const delivery = await this.bus.send({ from, to, ...(typeof value.message === "string" ? { text: value.message } : {}), ...(value.data === undefined ? {} : { data: value.data }), ...(value.await === true ? { await: true } : {}) });
          // An undelivered message used to be a bare `delivered: false`, which reads as a
          // transport problem. It is nearly always a name that no longer answers.
          return { content: JSON.stringify(delivery.delivered ? delivery : { ...delivery, note: this.undeliverable(to) }) };
        }
        case "publish": return { content: JSON.stringify(await this.bus.publish({ from, channel: stringField(value, "channel"), ...(typeof value.message === "string" ? { text: value.message } : {}), ...(value.data === undefined ? {} : { data: value.data }), ...(value.await === true ? { await: true } : {}) })) };
        case "subscribe": return { content: JSON.stringify({ subscribed: this.bus.subscribe({ peer: typeof value.peer === "string" ? value.peer : from, channel: stringField(value, "channel") }) }) };
        case "unsubscribe": return { content: JSON.stringify({ unsubscribed: this.bus.unsubscribe({ peer: typeof value.peer === "string" ? value.peer : from, channel: stringField(value, "channel") }) }) };
        case "wait": {
          const timeout = numberField(value, "timeoutMs");
          const wait = timeout === undefined ? { signal: context.signal } : { timeoutMs: timeout, signal: context.signal };
          const messages = typeof value.channel === "string" ? await this.bus.wait({ channel: value.channel, ...wait }) : await this.bus.wait({ peer: typeof value.peer === "string" ? value.peer : from, ...wait });
          // An empty wait used to be indistinguishable from a broken bus. Say which it was.
          return { content: JSON.stringify(messages.length > 0 ? messages : { messages: [], note: emptyWaitNote(value, from) }) };
        }
        case "inbox": return { content: JSON.stringify(this.bus.inbox(typeof value.peer === "string" ? value.peer : from)) };
        case "list": return { content: JSON.stringify({ peers: this.describePeers() }) };
        default: throw new Error("hub op must be send, publish, subscribe, unsubscribe, wait, inbox, or list.");
      }
    } catch (error) { return failed("Hub", error); }
  }

  /** Why a name did not take a message, in terms of the names that would have. */
  private undeliverable(to: string): string {
    const names = this.bus.list().map((peer) => peer.name);
    return names.includes(to)
      ? `${to} is registered but has finished and is no longer accepting messages.`
      : `Nothing on the bus answers to ${JSON.stringify(to)}, so the message went nowhere. Peers now: ${names.join(", ") || "none"}. A child's address is the "peer" its spawn result reported; run hub { op: "list" } or spawn { op: "list" } to see them.`;
  }

  private describePeers(): Array<Record<string, unknown>> {
    return this.bus.list().map((peer) => {
      const agent = this.agents?.status(peer.name);
      return {
        name: peer.name,
        ...(peer.label === undefined ? {} : { label: peer.label }),
        // The bus knows whether a mailbox is live; the manager knows what the agent is
        // doing. Both are reported, because "parked" and "failed" are different answers.
        mailbox: peer.state,
        createdAt: peer.createdAt,
        ...(agent === undefined ? { kind: "session" } : {
          kind: "agent",
          id: agent.id,
          status: agent.status,
          toolCalls: agent.toolCalls,
          filesModified: agent.filesModified,
          workspace: agent.workspace,
          depth: agent.depth,
          ...(agent.model === undefined ? {} : { model: agent.model }),
          ...(agent.writeScope === undefined ? {} : { writeScope: agent.writeScope }),
          ...(agent.currentTool === undefined ? {} : { currentTool: agent.currentTool }),
          resultAvailable: agent.resultAvailable,
        }),
      };
    });
  }
}

function emptyWaitNote(value: Record<string, unknown>, from: string): string {
  if (typeof value.channel === "string") {
    return value.channel === SPAWN_LIFECYCLE_CHANNEL
      ? `Nothing was published to "${SPAWN_LIFECYCLE_CHANNEL}" before the deadline. That channel carries child lifecycle events, so an empty wait means no child started or finished in that window — not that the bus is broken. Check the children directly with spawn { op: "list" }.`
      : `Nothing was published to ${JSON.stringify(value.channel)} before the deadline. Subscribe with hub { op: "subscribe", channel: ${JSON.stringify(value.channel)} } if you have not, and check hub { op: "list" } for who could publish to it.`;
  }
  return `No message arrived for ${JSON.stringify(typeof value.peer === "string" ? value.peer : from)} before the deadline. Waiting on a peer only receives messages addressed to it; to watch children instead use hub { op: "wait", channel: "${SPAWN_LIFECYCLE_CHANNEL}" } or spawn { op: "list" }.`;
}

export class JitTool implements LyraTool {
  readonly definition = JIT_DEFINITION;
  constructor(private readonly runtime: RuntimeManager) {}
  normalize(args: unknown): unknown | string { return normalizeJitArgs(args); }
  async execute(input: unknown, _context: ToolExecutionContext): Promise<ToolExecutionResult> { try { const normalized = normalizeJitArgs(input); if (typeof normalized === "string") return { content: `Invalid jit arguments: ${normalized}`, isError: true }; const value = objectInput(normalized, "jit"); const op = stringField(value, "op"); switch (op) { case "declare": return { content: JSON.stringify(await this.runtime.declare(stringField(value, "name"), stringField(value, "source"))) }; case "run": return { content: JSON.stringify(await this.runtime.run(stringField(value, "name"), value.input)) }; case "list": return { content: JSON.stringify(await this.runtime.list()) }; case "promote": return { content: JSON.stringify({ path: await this.runtime.promote(stringField(value, "name")) }) }; default: throw new Error("jit op must be declare, run, list, or promote."); } } catch (error) { return failed("JIT", error); } }
}


/**
 * `writeScope`: a declared partition of a shared tree, not a lock.
 *
 * Two children editing the same file in one directory is the failure this addresses, and
 * the observed shape of it is worse than a conflict: the parent could not *see* the overlap
 * coming. Locks would be the heavy answer — a lock table, lease expiry, deadlock, and an
 * agent blocked on another agent's crash. A declared scope is the cheap one: the parent
 * says who owns what when it hands out the work, each child's own `write` and `edit` refuse
 * anything outside its share, and both the scope and any refusal are visible to the parent
 * through `spawn status`, `hub list`, and the child's result.
 *
 * Deliberately not enforced for `bash`: a shell command can write through a hundred
 * indirections and pretending otherwise would be a guarantee we cannot keep. The scope is
 * an honest statement about the two tools that take a path as an argument.
 */
const WRITE_SCOPED_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

/** Compile one glob-ish pattern into a matcher over tree-relative paths. */
function scopeMatcher(pattern: string): (path: string) => boolean {
  const cleaned = pattern.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (cleaned.length === 0) return () => false;
  if (!/[*?[\]]/.test(cleaned)) {
    // A plain path names a file or a directory, and a directory covers everything under it.
    return (path) => path === cleaned || path.startsWith(`${cleaned}/`);
  }
  const source = cleaned
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((piece) => {
      if (piece === "**/") return "(?:.*/)?";
      if (piece === "**") return ".*";
      if (piece === "*") return "[^/]*";
      if (piece === "?") return "[^/]";
      return piece.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  const expression = new RegExp(`^${source}$`);
  return (path) => expression.test(path);
}

/**
 * Wraps a path-taking tool so it refuses writes outside the agent's declared scope.
 *
 * The refusal names the scope rather than only the path: a child told "denied" learns
 * nothing, and a child told which paths it *does* own can finish its half of the work or
 * ask the parent to widen it.
 */
export class ScopedWriteTool implements LyraTool {
  readonly definition: ToolDefinition;
  readonly #base: LyraTool;
  readonly #scope: readonly string[];
  readonly #matchers: ReadonlyArray<(path: string) => boolean>;
  readonly #root: string;
  readonly #onViolation: ((path: string) => void) | undefined;

  constructor(base: LyraTool, scope: readonly string[], root: string, onViolation?: (path: string) => void) {
    this.#base = base;
    this.#scope = [...scope];
    this.#matchers = this.#scope.map(scopeMatcher);
    this.#root = resolve(root);
    this.#onViolation = onViolation;
    const schema = (base.definition.inputSchema ?? {}) as Record<string, unknown>;
    this.definition = Object.freeze({
      name: base.definition.name,
      description: `${base.definition.description} This agent may only write inside its declared scope: ${this.#scope.join(", ")}.`,
      inputSchema: schema,
    }) as ToolDefinition;
  }

  normalize(args: unknown): unknown | string { return this.#base.normalize?.(args) ?? args; }

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    // Checked on the normalized arguments, because `file_path` and `path` reach the same
    // file and a guard that only knew one spelling would be a guard in name only.
    const normalized = this.normalize(input);
    if (typeof normalized === "string") return this.#base.execute(input, context);
    const value = isRecord(normalized) ? normalized : {};
    const requested = typeof value.path === "string" ? value.path : undefined;
    if (requested !== undefined) {
      const relative = this.#relative(requested);
      if (relative === undefined || !this.#matchers.some((matches) => matches(relative))) {
        this.#onViolation?.(requested);
        return {
          content:
            `${this.definition.name} refused ${JSON.stringify(requested)}: it is outside this agent's declared write scope. ` +
            `This agent may write: ${this.#scope.join(", ")}. ` +
            `Do the part of the task that falls inside that scope, and report the paths you could not touch in your result so the agent that spawned you can hand them to whoever owns them.`,
          isError: true,
        };
      }
    }
    return this.#base.execute(normalized, context);
  }

  async close(): Promise<void> { await this.#base.close?.(); }

  /** The path as the scope speaks it: relative to the tree, or undefined when it escapes. */
  #relative(path: string): string | undefined {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.#root, path);
    const rel = relative(this.#root, absolute);
    return rel.length === 0 || rel.startsWith("..") || isAbsolute(rel) ? undefined : rel;
  }
}
/**
 * What the `git` tool can do with the checkpoint history, on the model's behalf.
 *
 * Deliberately an interface rather than the store itself: the ops a model gets are exactly
 * these four, and a tool that held the store could reach the thinning and the internals too.
 */
export interface CheckpointAccess {
  list(limit?: number): Promise<CheckpointRecord[]>;
  create(label?: string): Promise<CheckpointRecord | undefined>;
  restore(reference: string, force: boolean): Promise<CheckpointRestoreResult>;
  diff(input: { from?: string; to?: string; patches?: boolean; limit?: number }): Promise<CheckpointDiff>;
  unavailable(): string | undefined;
}

/** Optional checkpoint fields a schema-complete emitter pads; `limit: 0` can only be padding. */
const CHECKPOINT_PADDING = Object.freeze({ op: true as const, checkpoint: true as const, from: true as const, to: true as const, label: true as const, limit: 1 });
/** Scalars a stringifying emitter sends as text. */
const CHECKPOINT_SCALARS = Object.freeze({ limit: "integer" as const, force: "boolean" as const, patches: "boolean" as const });

/** How many checkpoints one `op: "list"` answers with by default. */
const CHECKPOINT_LIST_DEFAULT = 20;
/** How many files one `op: "diff"` carries patches for by default. */
const CHECKPOINT_DIFF_DEFAULT = 20;

/**
 * The `git` tool, extended with the checkpoint history rather than joined by a new tool.
 *
 * The tool budget is the reason: checkpoints *are* git — a second repository whose
 * work tree is this directory — so `git` is where a model already looks for "what changed"
 * and "put it back". Omitting `op` runs a git command exactly as before, so nothing a model
 * already knows how to do changes shape.
 *
 * It wraps rather than replaces the underlying tool, and it builds its schema from that
 * tool's own: a change to the git tool's arguments arrives here without an edit.
 */
export class GitCheckpointTool implements LyraTool {
  readonly definition: ToolDefinition;
  readonly #base: LyraTool;
  readonly #checkpoints: CheckpointAccess;

  constructor(base: LyraTool, checkpoints: CheckpointAccess) {
    this.#base = base;
    this.#checkpoints = checkpoints;
    const schema = (base.definition.inputSchema ?? {}) as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    this.definition = Object.freeze({
      name: base.definition.name,
      description: `${base.definition.description} With op, reads and rewinds Lyra's checkpoint history instead: a shadow repository under .lyra/checkpoints that snapshots this directory before every state-changing tool call and never touches your own .git.`,
      inputSchema: {
        ...schema,
        properties: {
          ...properties,
          op: { type: "string", enum: ["run", "checkpoint", "list", "diff", "restore"], description: "Omit or \"run\" to run a git command from args. checkpoint records the tree now; list shows recent checkpoints; diff compares two (or one against the live tree); restore rewinds to one." },
          checkpoint: { type: "string", minLength: 1, description: "Checkpoint id for restore, from op \"list\"." },
          from: { type: "string", minLength: 1, description: "Left side of a diff: a checkpoint id, or \"latest\". Defaults to the newest checkpoint." },
          to: { type: "string", minLength: 1, description: "Right side of a diff: a checkpoint id, or \"worktree\" for the live tree. Defaults to the live tree." },
          label: { type: "string", minLength: 1, description: "Human-readable name for a checkpoint created with op \"checkpoint\"." },
          force: { type: "boolean", description: "For restore: also revert files changed outside Lyra's own tool calls. Off by default, and off is the safe answer." },
          patches: { type: "boolean", description: "For diff: include a unified patch per file, not just the summary." },
          limit: { type: "integer", minimum: 1, maximum: 500, description: "How many checkpoints to list, or how many files a diff carries." },
        },
        required: [],
      },
    }) as ToolDefinition;
  }

  normalize(args: unknown): unknown | string {
    // The checkpoint fields get the same §3.7 padding treatment every other tool's do. Without
    // it a schema-complete emitter running `git { args: ["status"] }` also sends `checkpoint:
    // ""` and `op: ""`, and the schema's own minLength and enum refuse the call before the
    // handler — which strips those fields — ever sees it.
    const padded = dropPadding(coerceScalars(args, CHECKPOINT_SCALARS), CHECKPOINT_PADDING);
    if (typeof padded === "string") return padded;
    if (isRecord(padded) && typeof padded.op === "string" && padded.op !== "run") return padded;
    return this.#base.normalize?.(padded) ?? padded;
  }

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const value = isRecord(input) ? input : {};
    const op = typeof value.op === "string" && value.op.length > 0 ? value.op : "run";
    if (op === "run") {
      const { op: _dropped, checkpoint: _c, from: _f, to: _t, label: _l, force: _fo, patches: _p, limit: _li, ...rest } = value;
      return this.#base.execute(Object.keys(rest).length === 0 ? input : rest, context);
    }
    const blocked = this.#checkpoints.unavailable();
    if (blocked !== undefined) return { content: `Checkpoints are unavailable here: ${blocked}. Ordinary git commands still work; omit op to run one.`, isError: true };
    try {
      switch (op) {
        case "checkpoint": {
          const record = await this.#checkpoints.create(optionalText(value, "label"));
          if (record === undefined) return { content: "The checkpoint could not be recorded; nothing was changed.", isError: true };
          return { content: JSON.stringify(record.collapsed === true ? { ...summarize(record), note: "Nothing has changed since this checkpoint, so it was reused rather than duplicated." } : summarize(record)) };
        }
        case "list": {
          const records = await this.#checkpoints.list(optionalCount(value, "limit") ?? CHECKPOINT_LIST_DEFAULT);
          return { content: JSON.stringify({ checkpoints: records.map(summarize) }) };
        }
        case "diff": {
          const diff = await this.#checkpoints.diff({
            ...(optionalText(value, "from") === undefined ? {} : { from: optionalText(value, "from")! }),
            ...(optionalText(value, "to") === undefined ? {} : { to: optionalText(value, "to")! }),
            patches: value.patches === true,
            limit: optionalCount(value, "limit") ?? CHECKPOINT_DIFF_DEFAULT,
          });
          return { content: JSON.stringify(diff) };
        }
        case "restore": {
          const reference = optionalText(value, "checkpoint");
          if (reference === undefined) return { content: "restore needs a checkpoint id; run op \"list\" to see them.", isError: true };
          const result = await this.#checkpoints.restore(reference, value.force === true);
          return {
            content: JSON.stringify({
              restored: result.restored, preserved: result.preserved, forced: result.forced,
              target: summarize(result.target), undoWith: result.safety.id, excluded: result.excluded,
              ...(result.preserved.length === 0 ? {} : { note: `${result.preserved.length} file(s) changed outside Lyra's tool calls were left exactly as they were. Pass force: true to revert those too.` }),
            }),
            progress: { filesModified: result.restored.map((path) => ({ path })) },
          };
        }
        default: return { content: `git op must be run, checkpoint, list, diff, or restore; received ${JSON.stringify(op)}.`, isError: true };
      }
    } catch (error) { return failed("Git checkpoint", error); }
  }
}

function summarize(record: CheckpointRecord): Record<string, unknown> {
  return {
    id: record.id, kind: record.kind, label: record.label, createdAt: record.createdAt, changedFiles: record.changedFiles,
    ...(record.entryId === undefined ? {} : { entryId: record.entryId }),
    ...(record.tool === undefined ? {} : { tool: record.tool }),
  };
}
function optionalText(value: Record<string, unknown>, name: string): string | undefined { const field = value[name]; return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined; }
function optionalCount(value: Record<string, unknown>, name: string): number | undefined { const field = value[name]; return typeof field === "number" && Number.isSafeInteger(field) && field > 0 ? Math.min(field, 500) : undefined; }

export const INTEGRATED_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "glob", "map", "lsp", "spawn", "hub", "skill", "jit", "mcp", "git"] as const;
export interface IntegratedToolOptions extends DefaultToolRegistryOptions {
  lsp: LspManager; ownLsp?: boolean; spawn: SpawnManager; parent?: SpawnParentContext;
  /**
   * The code graph for the tree these tools operate on. Absent only where a caller builds a
   * registry with no session behind it; `map` then says so rather than disappearing, because
   * a tool array that varies between sessions is a cache invalidation waiting to happen (§13).
   */
  map?: MapAccess;
  allowedTools?: readonly string[]; bus: IrcBus; peer: string; skills: SkillRegistry;
  runtime: RuntimeManager; mcp: McpGateway; checkpoints?: CheckpointAccess;
  /** What `hub list` asks about each peer that is a spawned child. */
  agents?: AgentDirectory;
  /** This agent's declared write partition; `write` and `edit` refuse anything outside it. */
  writeScope?: readonly string[];
  /** The tree a `writeScope` pattern is relative to. Defaults to the filesystem root. */
  writeScopeRoot?: string;
  /** Where a refused write is reported, so it reaches the parent in the child's result. */
  onScopeViolation?: (path: string) => void;
}
export function createIntegratedToolRegistry(options: IntegratedToolOptions): ToolRegistry {
  const base = createDefaultToolRegistry(options);
  const builtins: LyraTool[] = base.definitions().map((definition) => {
    const tool = base.get(definition.name);
    if (!tool) throw new Error(`Missing built-in tool ${definition.name}.`);
    return tool;
  });
  const git = options.checkpoints === undefined ? builtins[6]! : new GitCheckpointTool(builtins[6]!, options.checkpoints);
  // A declared partition is enforced where the writing happens, not where it was declared.
  const guarded = options.writeScope === undefined
    ? builtins.slice(0, 6)
    : builtins.slice(0, 6).map((tool) => WRITE_SCOPED_TOOLS.has(tool.definition.name)
      ? new ScopedWriteTool(tool, options.writeScope!, scopeRoot(options), options.onScopeViolation)
      : tool);
  // `map` sits with the other exploration tools rather than at the end of the list: the tool
  // index a model reads is in this order, and the answer to "how do I find things here" should
  // be next to grep and glob, not eleven rows below them.
  const assembled: LyraTool[] = [...guarded, new MapTool(options.map, builtins[0]!), new LspTool(options.lsp, options.ownLsp), new SpawnTool(options.spawn, options.parent), new HubTool(options.bus, options.peer, options.agents), new SkillTool(options.skills), new JitTool(options.runtime), options.mcp, git];
  if (options.allowedTools === undefined) return new ToolRegistry(assembled);
  const allowed = new Set(options.allowedTools);
  const filtered = assembled.filter((tool) => allowed.has(tool.definition.name));
  const missing = options.allowedTools.filter((name) => !filtered.some((tool) => tool.definition.name === name));
  if (missing.length > 0) throw new Error(`Child requested unavailable tools: ${missing.join(", ")}.`);
  return new ToolRegistry(filtered);
}
/** The tree write-scope patterns are measured against: whatever the tools were rooted at. */
function scopeRoot(options: IntegratedToolOptions): string {
  const fromOption = (value: unknown): string | undefined => isRecord(value) && typeof value.root === "string" && value.root.length > 0 ? value.root : undefined;
  return options.writeScopeRoot ?? fromOption(options.filesystem) ?? fromOption(options.bash) ?? options.cwd ?? process.cwd();
}
function objectInput(input: unknown, name: string): Record<string, unknown> { if (!isRecord(input)) throw new Error(`${name} requires an argument object.`); return input; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function spawnRequest(value: Record<string, unknown>): SpawnRequest {
  const request: SpawnRequest = { task: stringField(value, "task") };
  if (value.context !== undefined) request.context = stringField(value, "context");
  if (value.output_schema !== undefined) { if (!isRecord(value.output_schema)) throw new Error("output_schema must be an object."); request.output_schema = value.output_schema; }
  if (value.schema_mode !== undefined) { if (value.schema_mode !== "permissive" && value.schema_mode !== "strict") throw new Error("schema_mode must be permissive or strict."); request.schema_mode = value.schema_mode; }
  if (value.acp !== undefined) request.acp = stringField(value, "acp");
  if (value.model !== undefined) request.model = stringField(value, "model");
  if (value.tools !== undefined) { if (!Array.isArray(value.tools) || !value.tools.every((tool) => typeof tool === "string")) throw new Error("tools must be an array of strings."); request.tools = value.tools;
  }
  for (const name of ["isolated", "blocking"] as const) { if (value[name] !== undefined) { if (typeof value[name] !== "boolean") throw new Error(`${name} must be boolean.`); request[name] = value[name]; } }
  if (value.workspace !== undefined) request.workspace = stringField(value, "workspace");
  if (value.label !== undefined) request.label = stringField(value, "label");
  if (value.depth !== undefined) { if (typeof value.depth !== "number" || !Number.isSafeInteger(value.depth) || value.depth < 0) throw new Error("depth must be a non-negative integer."); request.depth = value.depth; }
  if (value.writeScope !== undefined) { if (!Array.isArray(value.writeScope) || !value.writeScope.every((entry) => typeof entry === "string" && entry.trim().length > 0)) throw new Error("writeScope must be an array of non-empty path patterns."); request.writeScope = value.writeScope; }
  return request;
}
function stringField(value: Record<string, unknown>, name: string): string { const field = value[name]; if (typeof field !== "string" || field.length === 0) throw new Error(`${name} must be a non-empty string.`); return field; }
function numberField(value: Record<string, unknown>, name: string): number | undefined { const field = value[name]; if (field === undefined) return undefined; if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) throw new Error(`${name} must be a non-negative integer.`); return field; }
function failed(label: string, error: unknown): ToolExecutionResult { return { content: `${label} failed: ${error instanceof Error ? error.message : String(error)} Correct the arguments and retry.`, isError: true }; }
