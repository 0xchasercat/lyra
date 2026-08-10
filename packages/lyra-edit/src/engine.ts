import type {
  AstSymbolMatch,
  BatchEditResult,
  EditFileSystem,
  EditMetrics,
  EditRequest,
  EditResult,
  EditSuccess,
  EditMode,
  EditTier,
  ReadRequest,
  ReadResult,
  SnapshotTag,
} from "./types.ts";
import { byteLength, snapshotTag, normalizeContent } from "./hash.ts";
import { applySearchReplace } from "./tiers.ts";
import { applyAstSymbol } from "./ast-symbol.ts";
import { applyLineRange } from "./line-range.ts";

export type EngineReadResult = ReadResult | Extract<EditResult, { ok: false }>;

const APPLY_MODES = ["search_replace", "ast_symbol", "line_range"] as const;
type FailureCode = Extract<EditResult, { ok: false }>["code"];
const FAILURE_CODES: Record<FailureCode, true> = {
  invalid_request: true,
  stale_hash: true,
  no_match: true,
  ambiguous_match: true,
  no_op: true,
  unsupported_language: true,
  symbol_not_found: true,
  invalid_range: true,
  read_failed: true,
  write_failed: true,
};
const SEARCH_TIERS: Record<Exclude<EditTier, "not_applied">, true> = {
  exact: true,
  whitespace_agnostic: true,
  contextual_anchor: true,
};

function blankMetrics(): EditMetrics {
  return {
    reads: 0,
    writes: 0,
    modeCalls: {
      read: 0,
      search_replace: 0,
      ast_symbol: 0,
      line_range: 0,
      write: 0,
    },
    tierCalls: {
      exact: 0,
      whitespace_agnostic: 0,
      contextual_anchor: 0,
      not_applied: 0,
    },
  };
}

function isTag(value: unknown): value is SnapshotTag {
  return typeof value === "string" && /^#[a-f0-9]+$/i.test(value);
}

function error(
  path: string,
  mode: EditMode,
  code: FailureCode,
  message: string,
  extra?: Partial<Omit<Extract<EditResult, { ok: false }>, "ok" | "path" | "mode" | "code" | "message">>,
): Extract<EditResult, { ok: false }> {
  return { ok: false, path, mode, code, message, ...extra };
}


function splitLines(content: string): string[] {
  const lines = normalizeContent(content).split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === "string" && value in FAILURE_CODES;
}

function isSearchTier(value: unknown): value is Exclude<EditTier, "not_applied"> {
  return typeof value === "string" && value in SEARCH_TIERS;
}

function isNotFound(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const errorWithCode = cause as Error & { code?: unknown };
  return errorWithCode.code === "ENOENT" || /(?:not found|no such file)/i.test(cause.message);
}

type NormalizedApplyResult =
  | { ok: true; content: string; occurrences: number; tier?: EditTier }
  | { ok: false; code: FailureCode; message: string; closest?: string; matches?: string[] };

function normalizeApplyResult(result: unknown): NormalizedApplyResult {
  if (!result || typeof result !== "object") {
    return { ok: false, code: "no_match", message: "Edit resolver returned no result; re-read the file and retry." };
  }
  const value = result as Record<string, unknown>;
  if (value.ok === true && typeof value.content === "string") {
    return {
      ok: true,
      content: value.content,
      occurrences: typeof value.occurrences === "number" ? value.occurrences : 1,
      ...(isSearchTier(value.tier) ? { tier: value.tier } : {}),
    };
  }
  const code = value.code;
  return {
    ok: false,
    code: isFailureCode(code) ? code : "no_match",
    message: typeof value.message === "string" ? value.message : "Edit could not be resolved; re-read the file and retry.",
    ...(typeof value.closest === "string" ? { closest: value.closest } : {}),
    ...(Array.isArray(value.matches) ? { matches: value.matches.filter((x): x is string => typeof x === "string") } : {}),
  };
}

export class EditEngine {
  private readonly knownTags = new Map<string, SnapshotTag>();
  private readonly counts = blankMetrics();

  constructor(private readonly filesystem: EditFileSystem) {}

  get metrics(): EditMetrics {
    return {
      reads: this.counts.reads,
      writes: this.counts.writes,
      modeCalls: { ...this.counts.modeCalls },
      tierCalls: { ...this.counts.tierCalls },
    };
  }

  getMetrics(): EditMetrics {
    return this.metrics;
  }

  knownTag(path: string): SnapshotTag | undefined {
    return this.knownTags.get(path);
  }

  async read(request: ReadRequest): Promise<EngineReadResult> {
    const path = typeof request?.path === "string" ? request.path : "";
    this.counts.modeCalls.read++;
    if (!path) return error(path, "read", "invalid_request", "A non-empty path is required to read a file.");
    if (request.startLine !== undefined && (!Number.isInteger(request.startLine) || request.startLine < 1)) {
      return error(path, "read", "invalid_range", "startLine must be a positive integer.");
    }
    if (request.endLine !== undefined && (!Number.isInteger(request.endLine) || request.endLine < 1)) {
      return error(path, "read", "invalid_range", "endLine must be a positive integer.");
    }

    let raw: string;
    try {
      this.counts.reads++;
      raw = await this.filesystem.read(path);
    } catch (cause) {
      return error(path, "read", "read_failed", `Unable to read ${path}: ${String(cause)}. Check the path and permissions, then retry.`);
    }
    const normalized = normalizeContent(raw);
    const lines = splitLines(normalized);
    const totalLines = lines.length;
    const startLine = request.startLine ?? 1;
    const endLine = request.endLine ?? totalLines;
    if (startLine < 1 || endLine < startLine || endLine > totalLines) {
      return error(path, "read", "invalid_range", `Line range ${startLine}-${endLine} is outside ${path} (1-${totalLines}).`);
    }
    const tag = snapshotTag(normalized);
    this.knownTags.set(path, tag);
    const selectedLines = lines.slice(startLine - 1, endLine);
    const content = selectedLines.join("\n");
    const numbered = selectedLines.map((line, index) => `[${startLine + index}] ${line}`).join("\n");
    return { ok: true, path, tag, startLine, endLine, totalLines, content, numbered };
  }

  async apply(request: EditRequest): Promise<EditResult> {
    const path = typeof request?.path === "string" ? request.path : "";
    const mode = request?.mode;
    if (!APPLY_MODES.includes(mode as (typeof APPLY_MODES)[number])) {
      this.counts.tierCalls.not_applied++;
      return error(path, "write", "invalid_request", "apply accepts search_replace, ast_symbol, or line_range requests; use write() for whole-file writes.");
    }
    this.counts.modeCalls[mode]++;
    if (!path || !isTag(request.tag)) {
      this.counts.tierCalls.not_applied++;
      return error(path, mode, "invalid_request", "A path and valid #TAG from the latest read are required; re-read the file and retry.");
    }
    const suppliedTag = request.tag;
    const known = this.knownTags.get(path);
    if (!known || known !== suppliedTag) {
      this.counts.tierCalls.not_applied++;
      return error(path, mode, "stale_hash", `Snapshot ${suppliedTag} is not the latest known snapshot for ${path}; re-read ${path} and retry.`, known ? { tag: known } : undefined);
    }

    let source: string;
    try {
      this.counts.reads++;
      source = await this.filesystem.read(path);
    } catch (cause) {
      this.counts.tierCalls.not_applied++;
      return error(path, mode, "read_failed", `Unable to read ${path}: ${String(cause)}. Re-read the file after checking the path and permissions.`);
    }
    const actualTag = snapshotTag(source);
    if (actualTag !== suppliedTag) {
      this.counts.tierCalls.not_applied++;
      return error(path, mode, "stale_hash", `${path} changed since it was read (expected ${suppliedTag}, found ${actualTag}); re-read and retry.`, { tag: actualTag });
    }

    let resolved: NormalizedApplyResult;
    try {
      if (mode === "search_replace") {
        resolved = normalizeApplyResult(applySearchReplace(source, request.search, request.replace));
      } else if (mode === "ast_symbol") {
        resolved = normalizeApplyResult(applyAstSymbol(source, request.symbol, request.replace, request.language ?? path));
      } else {
        resolved = normalizeApplyResult(applyLineRange(source, request.startLine, request.endLine, request.replace));
      }
    } catch (cause) {
      this.counts.tierCalls.not_applied++;
      return error(path, mode, "invalid_request", `Unable to resolve edit for ${path}: ${String(cause)}. Re-read the file and retry.`);
    }
    if (!resolved.ok) {
      this.counts.tierCalls.not_applied++;
      if (mode === "ast_symbol" && resolved.code === "no_match") resolved.code = "symbol_not_found";
      return error(path, mode, resolved.code, resolved.message, {
        ...(resolved.closest ? { closest: resolved.closest } : {}),
        ...(resolved.matches ? { matches: resolved.matches } : {}),
      });
    }
    if (resolved.content === source) {
      this.counts.tierCalls.not_applied++;
      return error(path, mode, "no_op", `Edit for ${path} produces no byte changes; revise the replacement and retry.`);
    }
    const tier = mode === "search_replace" ? (resolved.tier ?? "exact") : "not_applied";
    if (mode === "search_replace") this.counts.tierCalls[resolved.tier ?? "exact"]++;
    else this.counts.tierCalls.not_applied++;
    return this.persist(path, mode, source, resolved.content, resolved.occurrences, tier);
  }

  async applyBatch(requests: readonly EditRequest[]): Promise<BatchEditResult> {
    const results: EditResult[] = [];
    const applied: string[] = [];
    const failed: string[] = [];
    for (const request of requests) {
      const result = await this.apply(request);
      results.push(result);
      if (result.ok) applied.push(result.path);
      else failed.push(result.path);
    }
    return { ok: failed.length === 0, results, applied, failed };
  }

  async write(path: string, content: string, tag?: SnapshotTag): Promise<EditResult> {
    this.counts.modeCalls.write++;
    this.counts.tierCalls.not_applied++;
    if (typeof path !== "string" || path.length === 0 || typeof content !== "string") {
      return error(path || "", "write", "invalid_request", "write requires a non-empty path and string content.");
    }
    if (tag !== undefined && !isTag(tag)) {
      return error(path, "write", "invalid_request", "write requires a valid #TAG from the latest read when overwriting a file.");
    }
    const known = this.knownTags.get(path);
    if (known && tag !== known) {
      return error(path, "write", "stale_hash", `Write for ${path} requires the latest snapshot tag ${known}; re-read and retry.`, { tag: known });
    }

    let before = "";
    let existed = false;
    try {
      this.counts.reads++;
      before = await this.filesystem.read(path);
      existed = true;
    } catch (cause) {
      // No file and no snapshot this engine ever issued: a tag sent anyway cannot be describing
      // anything, so it is padding rather than a claim about existing bytes, and creating the
      // file is exactly what the same call without it would do. Refusing here would strand the
      // model — "re-read and retry" is impossible advice for a path that does not exist.
      if (!known && isNotFound(cause)) {
        existed = false;
      } else {
        return error(path, "write", "read_failed", `Unable to verify ${path} before writing: ${String(cause)}. Re-read and retry.`);
      }
    }
    if (existed && !known) {
      return error(path, "write", "stale_hash", `${path} already exists but has no known snapshot; read it first and retry with the returned #TAG.`);
    }
    if (existed && snapshotTag(before) !== tag) {
      return error(path, "write", "stale_hash", `${path} changed since tag ${tag}; re-read and retry.`, { tag: snapshotTag(before) });
    }
    if (existed && before === content) {
      return error(path, "write", "no_op", `Write for ${path} produces no byte changes; revise the content and retry.`);
    }
    return this.persist(path, "write", before, content, 1, "not_applied");
  }

  private async persist(path: string, mode: EditRequest["mode"] | "write", before: string, content: string, occurrences: number, tier: EditTier): Promise<EditResult> {
    try {
      this.counts.writes++;
      await this.filesystem.writeAtomic(path, content);
    } catch (cause) {
      return error(path, mode, "write_failed", `Unable to atomically write ${path}: ${String(cause)}. No edit was committed; retry after checking permissions.`);
    }
    let actual: string;
    try {
      this.counts.reads++;
      actual = await this.filesystem.read(path);
    } catch (cause) {
      return error(path, mode, "write_failed", `Write to ${path} completed but post-write verification failed: ${String(cause)}. Re-read before continuing.`);
    }
    const tag = snapshotTag(actual);
    this.knownTags.set(path, tag);
    if (actual !== content) {
      return error(path, mode, "write_failed", `Post-write verification for ${path} did not match requested content; re-read before retrying.`, { tag });
    }
    const success: EditSuccess = {
      ok: true,
      path,
      mode,
      tier,
      tag,
      changed: true,
      bytesBefore: byteLength(before),
      bytesAfter: byteLength(actual),
      occurrences,
    };
    return success;
  }
}

export function createEditEngine(filesystem: EditFileSystem): EditEngine {
  return new EditEngine(filesystem);
}

export type { AstSymbolMatch };
