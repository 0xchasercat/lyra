import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
async function ignoreRules(origin: string): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  let current = origin;
  while (true) {
    const file = resolve(current, ".gitignore");
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
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    const rel = relative(origin, current);
    if (rel === "" || rel.startsWith(`..${sep}`)) break;
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

export const GLOB_DEFINITION: ToolDefinition = Object.freeze({ name: "glob", description: "Find files with deterministic gitignore-aware glob patterns.", inputSchema: Object.freeze({ type: "object", properties: { pattern: { type: "string", description: "Glob such as src/**/*.ts." }, path: { type: "string", description: "Directory to search, defaulting to cwd." } }, required: ["pattern"], additionalProperties: false }) });
export const GREP_DEFINITION: ToolDefinition = Object.freeze({ name: "grep", description: "Search UTF-8 files with a regular expression and deterministic results.", inputSchema: Object.freeze({ type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, flags: { type: "string" }, glob: { type: "string" }, maxResults: { type: "integer", minimum: 1 }, before: { type: "integer", minimum: 0 }, after: { type: "integer", minimum: 0 } }, required: ["pattern"], additionalProperties: false }) });

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
      const output = matches.map((file) => slash(relative(cwd, file))).join("\n");
      return ok(await boundText(output, storeFor(context, this.options.artifactStore, this.options.root), { budget: budgetFor(this.options), mimeType: "text/plain", name: args.pattern }));
    } catch (error) { return fail(`Unable to glob files: ${errorMessage(error)} Check the directory, pattern syntax, and permissions, then retry.`); }
  }
}
interface MatchLine { path: string; line: number; text: string; }
export class GrepTool implements LyraTool {
  readonly definition = GREP_DEFINITION;
  constructor(private readonly options: SearchToolOptions = {}) {}
  async execute(args: unknown, context: ToolRuntimeContext): Promise<ToolExecutionResult> {
    try {
      if (!validObject(args) || !str(args.pattern)) return fail("grep requires pattern as a regular-expression string.");
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
      const store = storeFor(context, this.options.artifactStore, this.options.root);
      for (const file of files) {
        const bytes = new Uint8Array(await readFile(file));
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { const id = await store.put(bytes, { mimeType: "application/octet-stream", name: file }); return fail(`Cannot grep binary file ${file}; full content is preserved at ${id}. Search a text path or inspect the artifact.`); }
        if (bytes.includes(0)) { const id = await store.put(bytes, { mimeType: "application/octet-stream", name: file }); return fail(`Cannot grep binary file ${file}; full content is preserved at ${id}. Search a text path or inspect the artifact.`); }
        const lines = text.replace(/\r\n/g, "\n").split("\n");
        const found: number[] = [];
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) { regex.lastIndex = 0; if (regex.test(lines[lineIndex]!)) found.push(lineIndex); }
        for (const lineIndex of found) {
          if (matches.length >= maxResults) break;
          const start = Math.max(0, lineIndex - (before as number));
          const end = Math.min(lines.length - 1, lineIndex + (after as number));
          for (let i = start; i <= end; i++) matches.push({ path: slash(relative(origin, file)), line: i + 1, text: lines[i]! });
        }
        if (matches.length >= maxResults) break;
      }
      const seen = new Set<string>();
      const output = matches.filter((match) => { const key = `${match.path}:${match.line}`; if (seen.has(key)) return false; seen.add(key); return true; }).map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n");
      return ok(await boundText(output, store, { budget: budgetFor(this.options), mimeType: "text/plain", name: "grep.txt" }));
    } catch (error) { return fail(`Unable to grep files: ${errorMessage(error)} Check the path, expression syntax, and permissions, then retry.`); }
  }
}
export function createSearchTools(options: SearchToolOptions = {}): LyraTool[] { return [new GlobTool(options), new GrepTool(options)]; }
export const searchToolDefinitions = Object.freeze([GLOB_DEFINITION, GREP_DEFINITION]);
