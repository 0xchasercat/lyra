import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { aliasSchema, foldToolAliases, rejectedField, toolArgs, type ToolAlias } from "@lyra/core";
import type { ToolDefinition } from "@lyra/provider";
import type { ArtifactStore, LyraTool, ToolExecutionResult, ToolRuntimeContext } from "./types.ts";
import { FileArtifactStore } from "./artifacts.ts";
import { boundText, DEFAULT_TOOL_DISPLAY_BUDGET, resolveToolPath, type FilesystemToolOptions } from "./filesystem-tools.ts";

export interface SearchToolOptions extends FilesystemToolOptions {
  readonly maxResults?: number;
}

function errorMessage(error: unknown): string { return error instanceof Error && error.message ? error.message : String(error); }
function fail(message: string): ToolExecutionResult { return { content: message, isError: true }; }
function ok(content: string): ToolExecutionResult { return { content }; }
function validObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function str(value: unknown): value is string { return typeof value === "string"; }
function storeFor(context: ToolRuntimeContext | undefined, supplied: ArtifactStore | undefined, root?: string): ArtifactStore {
  if (supplied) return supplied;
  const contextStore = (context as Partial<ToolRuntimeContext> | undefined)?.artifactStore;
  if (contextStore && typeof contextStore.put === "function" && typeof contextStore.read === "function") return contextStore;
  const origin = typeof context?.origin === "string" && context.origin ? context.origin : typeof context?.workspace === "string" && context.workspace ? context.workspace : root ?? process.cwd();
  return new FileArtifactStore(origin);
}
function budgetFor(options: SearchToolOptions): number { return Number.isInteger(options.displayBudget) && options.displayBudget! > 0 ? options.displayBudget! : DEFAULT_TOOL_DISPLAY_BUDGET; }
function slash(value: string): string { return value.split(sep).join("/"); }

/** Convert a glob to a deterministic regular expression, rejecting malformed classes. */
export function globRegex(pattern: string): RegExp {
  if (typeof pattern !== "string" || pattern.length === 0) throw new Error("Glob pattern must be a non-empty string.");
  if (pattern.includes("\u0000")) throw new Error("Glob pattern contains a NUL byte.");
  let out = "^";
  let classes = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "[") { classes++; out += "["; continue; }
    if (char === "]") { if (classes === 0) throw new Error(`Malformed glob ${JSON.stringify(pattern)}: closing ] has no opening [`); classes--; out += "]"; continue; }
    if (char === "\\") { if (i + 1 >= pattern.length) throw new Error(`Malformed glob ${JSON.stringify(pattern)}: trailing escape`); out += `\\${pattern[++i]}`; continue; }
    if (char === "*") {
      if (pattern[i + 1] === "*") { i++; if (pattern[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*"; }
      else out += "[^/]*";
      continue;
    }
    if (char === "?") { out += "[^/]"; continue; }
    if (char === "{") {
      const close = pattern.indexOf("}", i + 1);
      if (close < 0) throw new Error(`Malformed glob ${JSON.stringify(pattern)}: opening { is not closed`);
      const alternatives = pattern.slice(i + 1, close).split(",");
      if (alternatives.length < 2 || alternatives.some((part) => part.length === 0)) throw new Error(`Malformed glob ${JSON.stringify(pattern)}: brace alternatives must be non-empty`);
      out += `(?:${alternatives.map((part) => part.replace(/[.+^$()|\\]/g, "\\$&")).join("|")})`; i = close; continue;
    }
    out += /[.+^$()|]/.test(char) ? `\\${char}` : char;
  }
  if (classes !== 0) throw new Error(`Malformed glob ${JSON.stringify(pattern)}: opening [ is not closed`);
  try { return new RegExp(`${out}$`); } catch (error) { throw new Error(`Malformed glob ${JSON.stringify(pattern)}: ${errorMessage(error)}`); }
}

interface IgnoreRule { readonly regex: RegExp; readonly negate: boolean; readonly basenameOnly: boolean; }
async function pathExists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
/** Directories whose .gitignore applies, outermost first: git stops at the repository root and never reads above it. */
async function ignoreChain(origin: string): Promise<string[]> {
  const chain: string[] = [];
  let current = origin;
  while (true) {
    chain.unshift(current);
    if (await pathExists(resolve(current, ".git"))) return chain;
    const parent = dirname(current);
    if (parent === current) return [origin];
    current = parent;
  }
}
async function ignoreRules(origin: string): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  // Outermost first, so last-match-wins in ignored() gives the deepest .gitignore the final word, as git does.
  for (const directory of await ignoreChain(origin)) {
    const file = resolve(directory, ".gitignore");
    try {
      const raw = await readFile(file, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const negate = trimmed.startsWith("!");
        const pattern = (negate ? trimmed.slice(1) : trimmed).replace(/^\//, "").replace(/\/$/, "");
        if (pattern) rules.push({ regex: globRegex(pattern), negate, basenameOnly: !pattern.includes("/") });
      }
    } catch (error) { if (!/ENOENT/.test(errorMessage(error))) throw new Error(`Unable to read ${file}: ${errorMessage(error)}`); }
  }
  return rules;
}
function ignored(path: string, origin: string, rules: readonly IgnoreRule[]): boolean {
  const rel = slash(relative(origin, path));
  if (rel === ".git" || rel.startsWith(".git/") || rel === ".lyra/artifacts" || rel.startsWith(".lyra/artifacts/")) return true;
  let result = false;
  for (const rule of rules) if (rule.regex.test(rule.basenameOnly ? basename(rel) : rel)) result = !rule.negate;
  return result;
}
async function walk(root: string, origin: string, rules: readonly IgnoreRule[]): Promise<string[]> {
  const output: string[] = [];
  async function visit(path: string): Promise<void> {
    const info = await stat(path);
    const rel = slash(relative(origin, path));
    if (rel && ignored(path, origin, rules)) return;
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) { if (!entry.isSymbolicLink()) await visit(resolve(path, entry.name)); }
    } else if (info.isFile()) output.push(path);
  }
  await visit(root);
  return output;
}
async function searchRoot(value: unknown, context: ToolRuntimeContext, root?: string): Promise<{ path: string; origin: string; cwd: string }> {
  const originValue = typeof context?.origin === "string" && context.origin ? resolve(context.origin) : typeof context?.workspace === "string" && context.workspace ? resolve(context.workspace) : resolve(root ?? process.cwd());
  const cwdValue = typeof context?.cwd === "string" && context.cwd ? resolve(context.cwd) : typeof context?.workspace === "string" && context.workspace ? resolve(context.workspace) : originValue;
  const origin = await realpath(originValue).catch(() => originValue);
  const cwd = await realpath(cwdValue).catch(() => cwdValue);
  const path = value === undefined ? cwd : await resolveToolPath(value, context, root);
  return { path, origin, cwd };
}

export const GLOB_DEFINITION: ToolDefinition = Object.freeze({
  name: "glob",
  description: "List files matching a glob, gitignore-aware, sorted deterministically.",
  inputSchema: Object.freeze({
    type: "object",
    properties: {
      pattern: { type: "string", minLength: 1, description: "Glob such as src/**/*.ts. ** crosses directories, * and ? do not." },
      path: { type: "string", minLength: 1, description: "Directory to search, defaulting to cwd." },
    },
    required: ["pattern"],
    additionalProperties: false,
  }),
});
export const GREP_DEFINITION: ToolDefinition = Object.freeze({
  name: "grep",
  description: "Search UTF-8 files line by line with a JavaScript regular expression, skipping gitignored and binary files.",
  inputSchema: Object.freeze({
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression, matched against one line at a time." },
      path: { type: "string", minLength: 1, description: "File or directory to search, defaulting to cwd." },
      flags: { type: "string", description: "JavaScript RegExp flags, such as \"i\" for case-insensitive." },
      glob: { type: "string", description: "Restrict the search to files matching this glob, such as **/*.ts." },
      maxResults: { type: "integer", minimum: 1, description: "Cap on matched lines, or on matched files in the other output modes. Defaults to 1000." },
      before: { type: "integer", minimum: 0, description: "Context lines to include before each match." },
      after: { type: "integer", minimum: 0, description: "Context lines to include after each match." },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "content (default) returns path:line: text; files_with_matches returns matching paths; count returns path:count." },
      include: aliasSchema("glob", "string"),
      head_limit: aliasSchema("maxResults", "integer", { minimum: 1 }),
      headLimit: aliasSchema("maxResults", "integer", { minimum: 1 }),
      "-A": aliasSchema("after", "integer", { minimum: 0 }),
      "-B": aliasSchema("before", "integer", { minimum: 0 }),
      "-C": { type: "integer", minimum: 0, description: "Context lines on both sides; sets before and after together." },
      "-i": { type: "boolean", description: "Case-insensitive; the ripgrep spelling, folded into flags." },
      "-n": { type: "boolean", description: "Line numbers. Matches are always reported as path:line: text, so only true is meaningful." },
    },
    required: ["pattern"],
    additionalProperties: false,
  }),
});

const GREP_ALIASES: readonly ToolAlias[] = Object.freeze([
  { canonical: "glob", aliases: ["include"] },
  { canonical: "maxResults", aliases: ["head_limit", "headLimit"] },
  { canonical: "after", aliases: ["-A"] },
  { canonical: "before", aliases: ["-B"] },
]);

/** ripgrep-flavoured switches fold onto grep's own fields; the ones with no honest mapping say so. */
export function normalizeGrepArgs(input: unknown): unknown | string {
  const unsupported: ReadonlyArray<readonly [string, string]> = [
    ["multiline", "multiline is not supported: grep matches one line at a time, so a pattern cannot span lines. Match a single-line anchor, then read the surrounding lines."],
    ["type", "type is not supported: filter by filename with glob instead, such as glob: \"**/*.ts\" rather than type: \"ts\"."],
  ];
  for (const [field, lesson] of unsupported) {
    const hit = rejectedField(input, field, lesson);
    if (hit !== undefined) return hit;
  }
  const folded = foldToolAliases(input, GREP_ALIASES, "grep");
  if (typeof folded === "string") return folded;
  const args = toolArgs(folded);
  if (args === undefined) return folded;
  let output: Record<string, unknown> | undefined;
  const draft = (): Record<string, unknown> => (output ??= { ...args });
  const both = args["-C"];
  if (both !== undefined) {
    if (typeof both !== "number" || !Number.isSafeInteger(both) || both < 0) return "-C must be a non-negative integer count of context lines.";
    for (const side of ["before", "after"] as const) {
      const supplied = (output ?? args)[side];
      if (supplied !== undefined && supplied !== both) return `grep received both ${side} and -C with different values; -C sets before and after together, so send ${side} alone.`;
      draft()[side] = both;
    }
    delete draft()["-C"];
  }
  const insensitive = args["-i"];
  if (insensitive !== undefined) {
    if (typeof insensitive !== "boolean") return "-i must be a boolean; it is the ripgrep spelling of the \"i\" regular-expression flag.";
    const flags = typeof (output ?? args).flags === "string" ? (output ?? args).flags as string : "";
    const merged = insensitive && !flags.includes("i") ? `${flags}i` : flags;
    if (merged.length === 0) delete draft().flags; else draft().flags = merged;
    delete draft()["-i"];
  }
  const numbered = args["-n"];
  if (numbered !== undefined) {
    if (typeof numbered !== "boolean") return "-n must be a boolean.";
    if (numbered === false) return "-n cannot be false: matches are always reported as path:line: text, so line numbers are never omitted. Use output_mode: \"files_with_matches\" for paths only.";
    delete draft()["-n"];
  }
  return output ?? args;
}

export async function globPaths(pattern: string, root: string, origin = root): Promise<string[]> {
  const regex = globRegex(slash(pattern));
  const rules = await ignoreRules(origin);
  const info = await stat(root);
  const files = info.isDirectory() ? await walk(root, origin, rules) : [root];
  return files.filter((path) => regex.test(slash(relative(root, path))) || regex.test(slash(relative(origin, path)))).sort((a, b) => slash(relative(origin, a)).localeCompare(slash(relative(origin, b))));
}

export class GlobTool implements LyraTool {
  readonly definition = GLOB_DEFINITION;
  constructor(private readonly options: SearchToolOptions = {}) {}
  async execute(args: unknown, context: ToolRuntimeContext): Promise<ToolExecutionResult> {
    try {
      if (!validObject(args) || !str(args.pattern) || !args.pattern) return fail("glob requires a non-empty pattern string.");
      const { path, origin, cwd } = await searchRoot(args.path, context, this.options.root);
      const regex = globRegex(slash(args.pattern));
      const rules = await ignoreRules(origin);
      const info = await stat(path);
      const files = info.isDirectory() ? await walk(path, origin, rules) : [path];
      const matches = files.filter((file) => {
        if (ignored(file, origin, rules)) return false;
        return regex.test(slash(relative(cwd, file))) || regex.test(slash(relative(origin, file)));
      }).sort((a, b) => slash(relative(cwd, a)).localeCompare(slash(relative(cwd, b))));
      // An empty string cannot be read as "no matches" — it looks like a broken tool, and a
      // model that cannot tell those apart retries the same call (§3.7).
      if (matches.length === 0) return ok(`No files match ${JSON.stringify(args.pattern)} under ${slash(relative(cwd, path)) || "."}. Widen the pattern, or check the directory with bash.`);
      const output = matches.map((file) => slash(relative(cwd, file))).join("\n");
      return ok(await boundText(output, storeFor(context, this.options.artifactStore, this.options.root), { budget: budgetFor(this.options), mimeType: "text/plain", name: args.pattern }));
    } catch (error) { return fail(`Unable to glob files: ${errorMessage(error)} Check the directory, pattern syntax, and permissions, then retry.`); }
  }
}
interface MatchLine { path: string; line: number; text: string; }
function binary(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return false; } catch { return true; }
}
export class GrepTool implements LyraTool {
  readonly definition = GREP_DEFINITION;
  constructor(private readonly options: SearchToolOptions = {}) {}
  normalize(args: unknown): unknown | string { return normalizeGrepArgs(args); }
  async execute(input: unknown, context: ToolRuntimeContext): Promise<ToolExecutionResult> {
    try {
      const normalized = normalizeGrepArgs(input);
      if (typeof normalized === "string") return fail(normalized);
      const args = normalized as Record<string, unknown>;
      if (!validObject(args) || !str(args.pattern)) return fail("grep requires pattern as a regular-expression string.");
      const outputMode = args.output_mode === undefined ? "content" : args.output_mode;
      if (outputMode !== "content" && outputMode !== "files_with_matches" && outputMode !== "count") return fail("output_mode must be content, files_with_matches, or count.");
      let regex: RegExp;
      try { regex = new RegExp(args.pattern, str(args.flags) ? args.flags : ""); } catch (error) { return fail(`Invalid regular expression ${JSON.stringify(args.pattern)}: ${errorMessage(error)} Escape special characters or provide a valid pattern.`); }
      const before = args.before === undefined ? 0 : args.before;
      const after = args.after === undefined ? 0 : args.after;
      const rawMaxResults = args.maxResults;
      const maxResults = rawMaxResults === undefined ? this.options.maxResults ?? 1000 : rawMaxResults;
      if (!Number.isInteger(before) || (before as number) < 0 || !Number.isInteger(after) || (after as number) < 0) return fail("before and after must be non-negative integers.");
      if (typeof maxResults !== "number" || !Number.isSafeInteger(maxResults) || maxResults < 1) return fail("maxResults must be a positive integer.");
      const { path, origin } = await searchRoot(args.path, context, this.options.root);
      const rules = await ignoreRules(origin);
      const info = await stat(path);
      let files = info.isDirectory() ? await walk(path, origin, rules) : [path];
      if (str(args.glob) && args.glob) { const glob = globRegex(slash(args.glob)); files = files.filter((file) => glob.test(slash(relative(path, file))) || glob.test(slash(relative(origin, file)))); }
      files = [...new Set(files)].sort((a, b) => slash(relative(origin, a)).localeCompare(slash(relative(origin, b))));
      const matches: MatchLine[] = [];
      const perFile: Array<{ path: string; count: number }> = [];
      const skipped: string[] = [];
      const store = storeFor(context, this.options.artifactStore, this.options.root);
      for (const file of files) {
        const bytes = new Uint8Array(await readFile(file));
        // A binary file is not a search failure: skip it and keep going so one .png never hides the rest of the tree.
        if (binary(bytes)) { skipped.push(slash(relative(origin, file))); continue; }
        const lines = new TextDecoder("utf-8").decode(bytes).replace(/\r\n/g, "\n").split("\n");
        const found: number[] = [];
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) { regex.lastIndex = 0; if (regex.test(lines[lineIndex]!)) found.push(lineIndex); }
        if (outputMode !== "content") {
          // maxResults caps files here, not lines, because a file is one output row in these modes.
          if (found.length > 0) perFile.push({ path: slash(relative(origin, file)), count: found.length });
          if (perFile.length >= maxResults) break;
          continue;
        }
        for (const lineIndex of found) {
          if (matches.length >= maxResults) break;
          const start = Math.max(0, lineIndex - (before as number));
          const end = Math.min(lines.length - 1, lineIndex + (after as number));
          for (let i = start; i <= end; i++) matches.push({ path: slash(relative(origin, file)), line: i + 1, text: lines[i]! });
        }
        if (matches.length >= maxResults) break;
      }
      const seen = new Set<string>();
      const output = outputMode === "files_with_matches"
        ? perFile.map((entry) => entry.path)
        : outputMode === "count"
          ? perFile.map((entry) => `${entry.path}:${entry.count}`)
          : matches.filter((match) => { const key = `${match.path}:${match.line}`; if (seen.has(key)) return false; seen.add(key); return true; }).map((match) => `${match.path}:${match.line}: ${match.text}`);
      if (output.length === 0) output.push(`No lines match ${JSON.stringify(args.pattern)} in ${files.length} searched file${files.length === 1 ? "" : "s"}.`);
      if (skipped.length > 0) output.push(`[skipped ${skipped.length} binary file${skipped.length === 1 ? "" : "s"}: ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? ", and more" : ""}]`);
      return ok(await boundText(output.join("\n"), store, { budget: budgetFor(this.options), mimeType: "text/plain", name: "grep.txt" }));
    } catch (error) { return fail(`Unable to grep files: ${errorMessage(error)} Check the path, expression syntax, and permissions, then retry.`); }
  }
}
export function createSearchTools(options: SearchToolOptions = {}): LyraTool[] { return [new GlobTool(options), new GrepTool(options)]; }
export const searchToolDefinitions = Object.freeze([GLOB_DEFINITION, GREP_DEFINITION]);
