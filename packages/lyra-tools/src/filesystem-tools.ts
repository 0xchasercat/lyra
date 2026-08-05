import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { EditEngine, type EditFileSystem, type EditRequest, type SnapshotTag } from "@lyra/edit";
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

function contained(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function existingRealPath(path: string): Promise<string | undefined> {
  try { return await realpath(path); } catch { return undefined; }
}

/** Resolve a user path while defending against lexical and symlink escapes. */
export async function resolveToolPath(value: unknown, context?: ToolRuntimeContext, root?: string): Promise<string> {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("A non-empty relative path is required.");
  if (value.includes("\u0000")) throw new Error("Path contains a NUL byte; provide a normal filesystem path.");
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) throw new Error("URLs and artifact URIs are not filesystem paths; pass a local path.");
  const { cwd, origin } = contextValues(context, root);
  const lexicalOrigin = await existingRealPath(origin) ?? origin;
  const lexical = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  if (!contained(lexical, origin)) {
    throw new Error(`Path ${JSON.stringify(value)} escapes the allowed origin ${origin}; use a path inside the workspace.`);
  }
  const actual = await existingRealPath(lexical);
  if (actual) {
    if (!contained(actual, lexicalOrigin)) throw new Error(`Path ${JSON.stringify(value)} resolves through a symlink outside the allowed origin.`);
    return actual;
  }
  // For a new file, verify the nearest existing parent (which catches a symlink
  // in any existing directory component) and retain the lexical filename.
  let parent = dirname(lexical);
  const suffix: string[] = [];
  while (!(await existingRealPath(parent))) {
    const next = dirname(parent);
    if (next === parent) break;
    suffix.unshift(parent.slice(next.length + 1));
    parent = next;
  }
  const parentReal = await existingRealPath(parent);
  if (parentReal && !contained(parentReal, lexicalOrigin)) throw new Error(`Path ${JSON.stringify(value)} resolves through a symlink outside the allowed origin.`);
  return lexical;
}

export class NodeFileSystem implements EditFileSystem {
  async read(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try { await rename(temporary, path); }
    catch (error) { try { await writeFile(temporary, "", { flag: "a" }); } catch { /* best effort cleanup */ } throw error; }
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
  description: "Read a file, directory, URL, or image without losing complete content.",
  inputSchema: Object.freeze({ type: "object", properties: { path: { type: "string", description: "Path, http(s) URL, or artifact URI to read." }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false }),
});
export const WRITE_DEFINITION: ToolDefinition = Object.freeze({
  name: "write",
  description: "Create or overwrite a UTF-8 text file using guarded edit semantics.",
  inputSchema: Object.freeze({ type: "object", properties: { path: { type: "string" }, content: { type: "string" }, tag: { type: "string", pattern: "^#[a-fA-F0-9]+$", description: "Latest #TAG when overwriting an existing file." } }, required: ["path", "content"], additionalProperties: false }),
});
export const EDIT_DEFINITION: ToolDefinition = Object.freeze({
  name: "edit",
  description: "Apply a tag-guarded search/replace, AST-symbol, or line-range edit.",
  inputSchema: Object.freeze({ type: "object", properties: { mode: { type: "string", enum: ["search_replace", "ast_symbol", "line_range"] }, path: { type: "string" }, tag: { type: "string", pattern: "^#[a-fA-F0-9]+$" }, search: { type: "string" }, replace: { type: "string" }, symbol: { type: "string" }, language: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, required: ["mode", "path", "tag", "replace"], additionalProperties: false }),
});

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
  async execute(args: unknown, context: ToolRuntimeContext): Promise<ToolExecutionResult> {
    try {
      if (!validObject(args)) return fail("read requires an object with a non-empty path.");
      const pathValue = argString(args, "path");
      if (!pathValue) return fail("read requires path as a non-empty string.");
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
  async execute(args: unknown, context: ToolRuntimeContext): Promise<ToolExecutionResult> {
    try {
      if (!validObject(args)) return fail("write requires an object with path and content strings.");
      const pathValue = argString(args, "path");
      const content = argString(args, "content");
      if (!pathValue || content === undefined) return fail("write requires path and content as strings; include tag when overwriting a file.");
      const path = await resolveToolPath(pathValue, context, this.options.root);
      const tag = args.tag;
      if (tag !== undefined && typeof tag !== "string") return fail("tag must be the #TAG returned by the latest read.");
      const result = await this.engine.write(path, content, tag as SnapshotTag | undefined);
      if (!result.ok) return fail(result.message);
      return ok(jsonResult({ ...result, path: pathValue }), { filesModified: [{ path: pathValue, afterHash: result.tag }] });
    } catch (error) {
      return fail(`Unable to write ${String((args as { path?: unknown })?.path ?? "the requested path")}: ${errorMessage(error)} Check the path and permissions, then retry.`);
    }
  }
}

export class EditTool extends FileToolBase {
  readonly definition = EDIT_DEFINITION;
  async execute(args: unknown, context: ToolRuntimeContext): Promise<ToolExecutionResult> {
    try {
      if (!validObject(args)) return fail("edit requires mode, path, #TAG, replace, and mode-specific fields.");
      const pathValue = argString(args, "path");
      if (!pathValue) return fail("edit requires path as a non-empty string.");
      const path = await resolveToolPath(pathValue, context, this.options.root);
      const mode = args.mode;
      if (mode !== "search_replace" && mode !== "ast_symbol" && mode !== "line_range") return fail("edit mode must be search_replace, ast_symbol, or line_range.");
      if (typeof args.tag !== "string" || !/^#[a-f0-9]+$/i.test(args.tag)) return fail("edit requires the #TAG returned by the latest read.");
      if (typeof args.replace !== "string") return fail("edit requires replace as a string.");
      let request: EditRequest;
      if (mode === "search_replace") {
        if (typeof args.search !== "string") return fail("search_replace mode requires search as a string.");
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
      return fail(`Unable to edit ${String((args as { path?: unknown })?.path ?? "the requested path")}: ${errorMessage(error)} Re-read the file and retry with its latest #TAG.`);
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
