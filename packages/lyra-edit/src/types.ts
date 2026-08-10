export type EditMode = "read" | "search_replace" | "ast_symbol" | "line_range" | "write";
export type EditTier = "exact" | "whitespace_agnostic" | "contextual_anchor" | "not_applied";
export type SnapshotTag = `#${string}`;

export interface EditFileSystem {
  read(path: string): Promise<string>;
  writeAtomic(path: string, content: string): Promise<void>;
}

export interface ReadRequest {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface ReadResult {
  ok: true;
  path: string;
  tag: SnapshotTag;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  numbered: string;
  /**
   * The `endLine` that was asked for, present only when it ran past the end of the file and
   * was clamped to `totalLines`. A range that overshoots the file is a guess about a length
   * the caller could not know — `read({ startLine: 1, endLine: 100 })` on an 18-line file is
   * the whole file, not a mistake — so the lines come back and the overshoot is reported in
   * band rather than raised as an error.
   */
  requestedEndLine?: number;
}

export type EditRequest =
  | {
      mode: "search_replace";
      path: string;
      tag: SnapshotTag;
      search: string;
      replace: string;
    }
  | {
      mode: "ast_symbol";
      path: string;
      tag: SnapshotTag;
      symbol: string;
      replace: string;
      language?: string;
    }
  | {
      mode: "line_range";
      path: string;
      tag: SnapshotTag;
      startLine: number;
      endLine: number;
      replace: string;
    };

export interface EditSuccess {
  ok: true;
  path: string;
  mode: EditMode;
  tier: EditTier;
  tag: SnapshotTag;
  changed: true;
  bytesBefore: number;
  bytesAfter: number;
  occurrences: number;
}

export interface EditFailure {
  ok: false;
  path: string;
  mode: EditMode;
  code:
    | "invalid_request"
    | "stale_hash"
    | "no_match"
    | "ambiguous_match"
    | "no_op"
    | "unsupported_language"
    | "symbol_not_found"
    | "invalid_range"
    | "read_failed"
    | "write_failed";
  message: string;
  tag?: SnapshotTag;
  closest?: string;
  matches?: string[];
}

export type EditResult = EditSuccess | EditFailure;

export interface BatchEditResult {
  ok: boolean;
  results: EditResult[];
  applied: string[];
  failed: string[];
}

export interface EditMetrics {
  reads: number;
  writes: number;
  modeCalls: Record<EditMode, number>;
  tierCalls: Record<EditTier, number>;
}

export interface AstSymbolMatch {
  startByte: number;
  endByte: number;
  symbol: string;
}
