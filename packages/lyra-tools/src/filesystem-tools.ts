import { chmod, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { EditEngine, type EditFileSystem, type EditRequest, type SnapshotTag } from "@lyra/edit";
import { aliasSchema, foldToolAliases, rejectedField, toolArgs, type ToolAlias } from "@lyra/core";
import type { ContentBlock, ToolDefinition } from "@lyra/provider";
import type { ArtifactStore, LyraTool, ToolExecutionResult, ToolRuntimeContext } from "./types.ts";
import { FileArtifactStore, isArtifactUri } from "./artifacts.ts";

export interface FilesystemToolOptions {
  readonly displayBudget?: number;
  readonly artifactStore?: ArtifactStore;
  readonly engine?: EditEngine;
  /** Base directory used by direct calls without a runtime context. */
  readonly root?: string;
}

const DEFAULT_DISPLAY_BUDGET = 32 * 1024;
export const DEFAULT_TOOL_DISPLAY_BUDGET = DEFAULT_DISPLAY_BUDGET;
/** New files are created private; existing files keep whatever mode they already carry. */
const DEFAULT_FILE_MODE = 0o600;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".avif": "image/avif",
  ".json": "application/json", ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript", ".ts": "text/typescript", ".tsx": "text/tsx", ".jsx": "text/jsx", ".css": "text/css", ".html": "text/html", ".htm": "text/html", ".xml": "application/xml", ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".yaml": "text/yaml", ".yml": "text/yaml", ".toml": "text/plain", ".py": "text/x-python", ".rs": "text/x-rust", ".go": "text/x-go", ".java": "text/x-java", ".c": "text/x-c", ".h": "text/x-c", ".cpp": "text/x-c++src", ".sh": "text/x-shellscript",
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function contextValues(context: ToolRuntimeContext | undefined, root?: string): { cwd: string; origin: string } {
  const fallback = resolve(root ?? process.cwd());
  const maybe = context as Partial<ToolRuntimeContext> | undefined;
  const workspace = typeof maybe?.workspace === "string" && maybe.workspace.length > 0 ? resolve(maybe.workspace) : undefined;
  const origin = typeof maybe?.origin === "string" && maybe.origin.length > 0 ? resolve(maybe.origin) : workspace ?? fallback;
  const cwd = typeof maybe?.cwd === "string" && maybe.cwd.length > 0 ? resolve(maybe.cwd) : workspace ?? origin;
  return { cwd, origin };
}


async function existingRealPath(path: string): Promise<string | undefined> {
  try { return await realpath(path); } catch { return undefined; }
}

/** Resolve a local path from the model-selected cwd; Lyra runs in unapologetic YOLO mode. */
export async function resolveToolPath(value: unknown, context?: ToolRuntimeContext, root?: string): Promise<string> {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("A non-empty filesystem path is required.");
  if (value.includes("\u0000")) throw new Error("Path contains a NUL byte; provide a normal filesystem path.");
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) throw new Error("URLs and artifact URIs are not filesystem paths; pass a local path.");
  const { cwd } = contextValues(context, root);
  const lexical = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  return await existingRealPath(lexical) ?? lexical;
}

export class NodeFileSystem implements EditFileSystem {
  async read(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const mode = await stat(path).then((info) => info.mode & 0o7777).catch(() => DEFAULT_FILE_MODE);
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: DEFAULT_FILE_MODE });
    try {
      // The temporary is born private and only widened to the target's own mode just before it lands,
      // so an executable script stays executable without ever exposing a half-written file.
      if (mode !== DEFAULT_FILE_MODE) await chmod(temporary, mode);
      await rename(temporary, path);
    } catch (error) { await unlink(temporary).catch(() => { /* best effort cleanup */ }); throw error; }
  }
}

const sharedFileSystem = new NodeFileSystem();
const sharedEditEngine = new EditEngine(sharedFileSystem);

function storeFor(context: ToolRuntimeContext | undefined, supplied: ArtifactStore | undefined, root?: string): ArtifactStore {
  if (supplied) return supplied;
  const contextStore = (context as Partial<ToolRuntimeContext> | undefined)?.artifactStore;
  if (contextStore && typeof contextStore.put === "function" && typeof contextStore.read === "function") return contextStore;
  const fallbackContext = contextValues(context, root);
  return new FileArtifactStore(fallbackContext.origin);
}

function budgetFor(options: FilesystemToolOptions): number {
  return Number.isInteger(options.displayBudget) && options.displayBudget! > 0 ? options.displayBudget! : DEFAULT_DISPLAY_BUDGET;
}

function textBytes(value: string): Uint8Array { return new TextEncoder().encode(value); }

/** Keep model output bounded while retaining every byte in an artifact. */
export async function boundText(value: string, store: ArtifactStore, options: { budget?: number; mimeType?: string; name?: string } = {}): Promise<string> {
  const bytes = textBytes(value);
  const budget = Number.isInteger(options.budget) && options.budget! > 0 ? options.budget! : DEFAULT_DISPLAY_BUDGET;
  if (bytes.byteLength <= budget) return value;
  const id = options.name === undefined
    ? await store.put(bytes, { mimeType: options.mimeType ?? "text/plain; charset=utf-8" })
    : await store.put(bytes, { mimeType: options.mimeType ?? "text/plain; charset=utf-8", name: options.name });
  const served = new TextDecoder().decode(bytes.slice(0, budget));
  const servedBytes = textBytes(served).byteLength;
  return `${served}[truncated: ${servedBytes} of ${bytes.byteLength} bytes — ${id} for full]`;
}

async function boundImage(bytes: Uint8Array, mimeType: string, name: string | undefined, store: ArtifactStore, budget: number): Promise<string | ContentBlock[]> {
  // Image data is sent as a provider image block only when it fits the budget;
  // otherwise the marker points to the exact original bytes.
  if (bytes.byteLength > budget) {
    const id = name === undefined ? await store.put(bytes, { mimeType }) : await store.put(bytes, { mimeType, name });
    return `[truncated: 0 of ${bytes.byteLength} bytes — ${id} for full]`;
  }
  const data = Buffer.from(bytes).toString("base64");
  if (data.length > budget) {
    const id = name === undefined ? await store.put(bytes, { mimeType }) : await store.put(bytes, { mimeType, name });
    return `[truncated: 0 of ${bytes.byteLength} bytes — ${id} for full]`;
  }
  return [{ type: "image", mediaType: mimeType, data }];
}

function ok(content: string | ContentBlock[], progress?: ToolExecutionResult["progress"]): ToolExecutionResult {
  return { content, ...(progress ? { progress } : {}) };
}
function fail(message: string): ToolExecutionResult { return { content: message, isError: true }; }
function validObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function argString(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === "string" ? args[key] as string : undefined;
}
function jsonResult(value: unknown): string { return JSON.stringify(value); }

export const READ_DEFINITION: ToolDefinition = Object.freeze({
  name: "read",
  description: "Read a file, directory, http(s) URL, or artifact URI; text arrives as numbered lines prefixed with the #TAG that edit and write require.",
  inputSchema: Object.freeze({
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "Path, http(s) URL, or artifact URI to read." },
      startLine: { type: "integer", minimum: 1, description: "First line to return, 1-based. Whole file when omitted." },
      endLine: { type: "integer", minimum: 1, description: "Last line to return, inclusive." },
      file_path: aliasSchema("path", "string", { minLength: 1 }),
      filePath: aliasSchema("path", "string", { minLength: 1 }),
      start_line: aliasSchema("startLine", "integer", { minimum: 1 }),
      end_line: aliasSchema("endLine", "integer", { minimum: 1 }),
      offset: { type: "integer", minimum: 0, description: "First line to return, 1-based; the Claude Code spelling of startLine." },
      limit: { type: "integer", minimum: 1, description: "Number of lines to return starting at startLine; the Claude Code spelling of a range length, converted to endLine." },
    },
    required: ["path"],
    additionalProperties: false,
  }),
});
export const WRITE_DEFINITION: ToolDefinition = Object.freeze({
  name: "write",
  description: "Create or overwrite a whole UTF-8 text file — the first-class path for new files, files under ~80 lines, and change touching more than half the lines.",
  inputSchema: Object.freeze({
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "File to create or overwrite." },
      content: { type: "string", description: "Complete new file contents." },
      tag: { type: "string", pattern: "^#[a-fA-F0-9]+$", description: "Latest #TAG from read; required only when overwriting a file already read this session." },
      file_path: aliasSchema("path", "string", { minLength: 1 }),
      filePath: aliasSchema("path", "string", { minLength: 1 }),
    },
    required: ["path", "content"],
    additionalProperties: false,
  }),
});
export const EDIT_DEFINITION: ToolDefinition = Object.freeze({
  name: "edit",
  description: "Apply one #TAG-guarded edit: search/replace (the default), AST symbol replace, or line-range replace.",
  inputSchema: Object.freeze({
    type: "object",
    properties: {
      mode: { type: "string", enum: ["search_replace", "ast_symbol", "line_range"], description: "Defaults to search_replace; inferred from the fields sent when omitted." },
      path: { type: "string", minLength: 1, description: "File to edit." },
      tag: { type: "string", pattern: "^#[a-fA-F0-9]+$", description: "The #TAG from the most recent read of this file; the edit is refused if the file changed since." },
      search: { type: "string", description: "search_replace: exact text to find. Must match exactly once — add surrounding context to disambiguate." },
      replace: { type: "string", description: "Replacement text for the matched region." },
      symbol: { type: "string", description: "ast_symbol: symbol to rewrite whole, e.g. UserService.processPayment." },
      language: { type: "string", description: "ast_symbol: language override when the extension is ambiguous." },
      startLine: { type: "integer", minimum: 1, description: "line_range: first line to replace, 1-based inclusive." },
      endLine: { type: "integer", minimum: 1, description: "line_range: last line to replace, inclusive." },
      file_path: aliasSchema("path", "string", { minLength: 1 }),
      filePath: aliasSchema("path", "string", { minLength: 1 }),
      old_string: aliasSchema("search", "string"),
      oldString: aliasSchema("search", "string"),
      new_string: aliasSchema("replace", "string"),
      newString: aliasSchema("replace", "string"),
      start_line: aliasSchema("startLine", "integer", { minimum: 1 }),
      end_line: aliasSchema("endLine", "integer", { minimum: 1 }),
    },
    required: ["path", "tag", "replace"],
    additionalProperties: false,
  }),
});

const READ_ALIASES: readonly ToolAlias[] = Object.freeze([
  { canonical: "path", aliases: ["file_path", "filePath"] },
  { canonical: "startLine", aliases: ["start_line"] },
  { canonical: "endLine", aliases: ["end_line"] },
]);
const PATH_ALIASES: readonly ToolAlias[] = Object.freeze([{ canonical: "path", aliases: ["file_path", "filePath"] }]);
const EDIT_ALIASES: readonly ToolAlias[] = Object.freeze([
  { canonical: "path", aliases: ["file_path", "filePath"] },
  { canonical: "search", aliases: ["old_string", "oldString"] },
  { canonical: "replace", aliases: ["new_string", "newString"] },
  { canonical: "startLine", aliases: ["start_line"] },
  { canonical: "endLine", aliases: ["end_line"] },
]);

/** Claude Code's offset/limit is a start plus a count; Lyra's range is a start plus an end. */
export function normalizeReadArgs(input: unknown): unknown | string {
  const folded = foldToolAliases(input, READ_ALIASES, "read");
  if (typeof folded === "string") return folded;
  const args = toolArgs(folded);
  if (args === undefined || (args.offset === undefined && args.limit === undefined)) return folded;
  const output = { ...args };
  delete output.offset;
  delete output.limit;
  if (args.offset !== undefined) {
    if (typeof args.offset !== "number" || !Number.isSafeInteger(args.offset) || args.offset < 0) return "offset must be a non-negative integer line number; it is the Claude Code spelling of startLine.";
    const startLine = Math.max(1, args.offset);
    if (args.startLine !== undefined && args.startLine !== startLine) return "read received both startLine and offset with different values; offset is only another spelling of startLine, so send startLine alone.";
    output.startLine = startLine;
  }
  if (args.limit !== undefined) {
    if (typeof args.limit !== "number" || !Number.isSafeInteger(args.limit) || args.limit < 1) return "limit must be a positive integer line count; it is the Claude Code spelling for how many lines to return from startLine.";
    const startLine = typeof output.startLine === "number" ? output.startLine : 1;
    const endLine = startLine + args.limit - 1;
    if (args.endLine !== undefined && args.endLine !== endLine) return `read received both endLine and limit, which disagree: limit ${args.limit} from line ${startLine} ends at line ${endLine}. Send endLine alone.`;
    output.startLine = startLine;
    output.endLine = endLine;
  }
  return output;
}

/** `replace_all` has no honest mapping: tier-1 matching requires the search text to be unique (§6.2). */
/**
 * Providers that must emit every declared property pad the optional ones instead of leaving
 * them out — observed live as `tag: "#000000"` on a first write. An empty or null tag is that
 * padding, and it means exactly what an absent tag means: this file has not been read.
 */
function withoutPaddedTag(folded: unknown | string): unknown | string {
  if (typeof folded === "string") return folded;
  const args = toolArgs(folded);
  if (args === undefined || !("tag" in args)) return folded;
  if (args.tag !== null && !(typeof args.tag === "string" && args.tag.trim().length === 0)) return folded;
  const output = { ...args };
  delete output.tag;
  return output;
}

/** Folds write's path aliases and drops a padded tag. */
export function normalizeWriteArgs(input: unknown): unknown | string {
  return withoutPaddedTag(foldToolAliases(input, PATH_ALIASES, "write"));
}

export function normalizeEditArgs(input: unknown): unknown | string {
  for (const field of ["replace_all", "replaceAll"]) {
    const lesson = rejectedField(input, field, `${field} is not supported: the search text must match exactly once, so add surrounding context to make it unique, edit each site in its own call, or use write to replace the whole file.`);
    if (lesson !== undefined) return lesson;
  }
  const folded = withoutPaddedTag(foldToolAliases(input, EDIT_ALIASES, "edit"));
  if (typeof folded === "string") return folded;
  const args = toolArgs(folded);
  if (args === undefined || args.mode !== undefined) return folded;
  // §6.2: search/replace is the default mode, so a call that names its fields does not
  // also have to name the mode.
  const mode = args.symbol !== undefined ? "ast_symbol" : args.startLine !== undefined || args.endLine !== undefined ? "line_range" : "search_replace";
  return { ...args, mode };
}

interface BaseToolOptions extends FilesystemToolOptions {}

abstract class FileToolBase implements LyraTool {
  abstract readonly definition: ToolDefinition;
  protected readonly options: FilesystemToolOptions;
  protected readonly engine: EditEngine;
  constructor(options: FilesystemToolOptions = {}) {
    this.options = options;
    this.engine = options.engine ?? sharedEditEngine;
  }
  protected runtime(context: ToolRuntimeContext | undefined): { store: ArtifactStore; budget: number } {
    return { store: storeFor(context, this.options.artifactStore, this.options.root), budget: budgetFor(this.options) };
  }
  abstract execute(args: unknown, context: ToolRuntimeContext): Promise<ToolExecutionResult>;
}

export class ReadTool extends FileToolBase {
  readonly definition = READ_DEFINITION;
  normalize(args: unknown): unknown | string { return normalizeReadArgs(args); }
  async execute(input: unknown, context: ToolRuntimeContext): Promise<ToolExecutionResult> {
    try {
      const normalized = normalizeReadArgs(input);
      if (typeof normalized === "string") return fail(normalized);
      const args = normalized as Record<string, unknown>;
      if (!validObject(args)) return fail("read requires an object with a non-empty path.");
      const pathValue = argString(args, "path");
      if (!pathValue) return fail("read requires path (alias file_path) as a non-empty string.");
      const { store, budget } = this.runtime(context);
      if (isArtifactUri(pathValue)) {
        const bytes = await store.read(pathValue);
        const metadata = await store.metadata?.(pathValue);
        const mime = metadata?.mimeType ?? "application/octet-stream";
        if (mime.startsWith("image/")) return ok(await boundImage(bytes, mime, metadata?.name ?? pathValue, store, budget));
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { return fail(`Artifact ${pathValue} is binary ${mime} data; use the artifact URI to retrieve its complete ${bytes.byteLength} bytes.`); }
        if (bytes.includes(0)) return fail(`Artifact ${pathValue} is binary ${mime} data; use the artifact URI to retrieve its complete ${bytes.byteLength} bytes.`);
        return ok(await boundText(text, store, { budget, mimeType: mime, name: metadata?.name ?? pathValue }));
      }
      if (/^https?:\/\//i.test(pathValue)) {
        const response = await fetch(pathValue, { signal: context?.signal });
        if (!response.ok) return fail(`Unable to read URL ${pathValue}: HTTP ${response.status}. Check the URL and retry.`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "text/plain";
        if (mime.startsWith("image/")) return ok(await boundImage(bytes, mime, pathValue, store, budget));
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { const id = await store.put(bytes, { mimeType: mime, name: pathValue }); return fail(`URL ${pathValue} is binary data; full content is preserved at ${id}.`); }
        return ok(await boundText(text, store, { budget, mimeType: mime, name: pathValue }));
      }
      const path = await resolveToolPath(pathValue, context, this.options.root);
      const info = await stat(path);
      if (info.isDirectory()) {
        const entries = (await readdir(path, { withFileTypes: true })).map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).sort((a, b) => a.localeCompare(b));
        return ok(await boundText(entries.join("\n"), store, { budget, mimeType: "text/plain", name: pathValue }));
      }
      const bytes = new Uint8Array(await readFile(path));
      const mime = MIME_TYPES[Object.keys(MIME_TYPES).find((extension) => path.toLowerCase().endsWith(extension)) ?? ""] ?? "application/octet-stream";
      if (mime.startsWith("image/")) return ok(await boundImage(bytes, mime, pathValue, store, budget), { filesRead: [path] });
      let raw: string;
      try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { const id = await store.put(bytes, { mimeType: mime, name: pathValue }); return fail(`File ${pathValue} is binary data; full content is preserved at ${id}.`); }
      if (bytes.includes(0)) { const id = await store.put(bytes, { mimeType: mime, name: pathValue }); return fail(`File ${pathValue} is binary data; full content is preserved at ${id}.`); }
      const startLine = args.startLine;
      const endLine = args.endLine;
      if (startLine !== undefined && (!Number.isInteger(startLine) || (startLine as number) < 1)) return fail("startLine must be a positive integer.");
      if (endLine !== undefined && (!Number.isInteger(endLine) || (endLine as number) < 1)) return fail("endLine must be a positive integer.");
      const result = await this.engine.read({ path, ...(startLine !== undefined ? { startLine: startLine as number } : {}), ...(endLine !== undefined ? { endLine: endLine as number } : {}) });
      if (!result.ok) return fail(result.message);
      const output = `[${pathValue}${result.tag}]\n${result.numbered}`;
      return ok(await boundText(output, store, { budget, mimeType: "text/plain; charset=utf-8", name: pathValue }), { filesRead: [path] });
    } catch (error) {
      return fail(`Unable to read the requested path: ${errorMessage(error)} Check the path, URL, and permissions, then retry.`);
    }
  }
}

export class WriteTool extends FileToolBase {
  readonly definition = WRITE_DEFINITION;
  normalize(args: unknown): unknown | string { return normalizeWriteArgs(args); }
  async execute(input: unknown, context: ToolRuntimeContext): Promise<ToolExecutionResult> {
    try {
      const normalized = normalizeWriteArgs(input);
      if (typeof normalized === "string") return fail(normalized);
      const args = normalized as Record<string, unknown>;
      if (!validObject(args)) return fail("write requires an object with path and content strings.");
      const pathValue = argString(args, "path");
      const content = argString(args, "content");
      if (!pathValue || content === undefined) return fail("write requires path (alias file_path) and content as strings; include tag when overwriting a file already read this session.");
      const path = await resolveToolPath(pathValue, context, this.options.root);
      const tag = args.tag;
      if (tag !== undefined && typeof tag !== "string") return fail("tag must be the #TAG returned by the latest read.");
      const result = await this.engine.write(path, content, tag as SnapshotTag | undefined);
      if (!result.ok) return fail(result.message);
      return ok(jsonResult({ ...result, path: pathValue }), { filesModified: [{ path: pathValue, afterHash: result.tag }] });
    } catch (error) {
      return fail(`Unable to write ${String((input as { path?: unknown })?.path ?? "the requested path")}: ${errorMessage(error)} Check the path and permissions, then retry.`);
    }
  }
}

export class EditTool extends FileToolBase {
  readonly definition = EDIT_DEFINITION;
  normalize(args: unknown): unknown | string { return normalizeEditArgs(args); }
  async execute(input: unknown, context: ToolRuntimeContext): Promise<ToolExecutionResult> {
    try {
      const normalized = normalizeEditArgs(input);
      if (typeof normalized === "string") return fail(normalized);
      const args = normalized as Record<string, unknown>;
      if (!validObject(args)) return fail("edit requires path, tag, replace, and the fields for one mode.");
      const pathValue = argString(args, "path");
      if (!pathValue) return fail("edit requires path (alias file_path) as a non-empty string.");
      const path = await resolveToolPath(pathValue, context, this.options.root);
      const mode = args.mode;
      if (mode !== "search_replace" && mode !== "ast_symbol" && mode !== "line_range") return fail("edit mode must be search_replace, ast_symbol, or line_range; omit it to get search_replace.");
      if (typeof args.tag !== "string" || !/^#[a-f0-9]+$/i.test(args.tag)) return fail(`edit requires tag: the #TAG printed by the most recent read of this file. Call read({ path: ${JSON.stringify(pathValue)} }) and pass the #TAG it returns.`);
      if (typeof args.replace !== "string") return fail("edit requires replace (alias new_string) as a string.");
      let request: EditRequest;
      if (mode === "search_replace") {
        if (typeof args.search !== "string") return fail("search_replace mode requires search (alias old_string) as a string.");
        request = { mode, path, tag: args.tag as SnapshotTag, search: args.search, replace: args.replace };
      } else if (mode === "ast_symbol") {
        if (typeof args.symbol !== "string" || !args.symbol) return fail("ast_symbol mode requires a non-empty symbol.");
        request = { mode, path, tag: args.tag as SnapshotTag, symbol: args.symbol, replace: args.replace, ...(typeof args.language === "string" ? { language: args.language } : {}) };
      } else {
        if (!Number.isInteger(args.startLine) || !Number.isInteger(args.endLine) || (args.startLine as number) < 1 || (args.endLine as number) < (args.startLine as number)) return fail("line_range mode requires positive startLine and endLine with endLine >= startLine.");
        request = { mode, path, tag: args.tag as SnapshotTag, startLine: args.startLine as number, endLine: args.endLine as number, replace: args.replace };
      }
      const result = await this.engine.apply(request);
      if (!result.ok) return fail(result.message);
      return ok(jsonResult({ ...result, path: pathValue }), { filesModified: [{ path: pathValue, beforeHash: args.tag as string, afterHash: result.tag }] });
    } catch (error) {
      return fail(`Unable to edit ${String((input as { path?: unknown })?.path ?? "the requested path")}: ${errorMessage(error)} Re-read the file and retry with its latest #TAG.`);
    }
  }
}

export function createFilesystemTools(options: FilesystemToolOptions = {}): LyraTool[] {
  const engine = options.engine ?? sharedEditEngine;
  const shared = { ...options, engine };
  return [new ReadTool(shared), new WriteTool(shared), new EditTool(shared)];
}

export const filesystemToolDefinitions = Object.freeze([READ_DEFINITION, WRITE_DEFINITION, EDIT_DEFINITION]);
export type { ContentBlock };
