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

export type EditApplyMode = EditRequest["mode"];

/** What is true of every applied change, whatever mode produced it. */
export interface EditSuccessBase {
  ok: true;
  path: string;
  tag: SnapshotTag;
  changed: true;
  bytesBefore: number;
  bytesAfter: number;
}

/**
 * A replacement that landed: which mode resolved it, which tier fired, how many sites it
 * touched (§6.2). `tier` is only ever a real tier here — `not_applied` names a call that
 * wrote nothing, so it cannot describe a success.
 */
export interface EditApplySuccess extends EditSuccessBase {
  mode: EditApplyMode;
  tier: EditTier;
  occurrences: number;
}

/**
 * A whole-file write, which has no tier and no occurrence count to report.
 *
 * Both used to be present and both were lies: `write` does no matching, so it carried
 * `tier: "not_applied"` — the marker for a call that changed nothing, on a call that had
 * just rewritten the file — and `occurrences: 1` counted a match that never happened. The
 * model paid for two fields on every file it created and read the first as a failure
 * signal. Splitting the success type is what keeps them gone: they are not optional here,
 * they are absent, so no future writer can set them by reflex.
 *
 * `created` replaces what the noise was standing in for — the one thing a write knows that
 * the byte counts do not say outright.
 */
export interface WriteSuccess extends EditSuccessBase {
  mode: "write";
  created: boolean;
}

export type EditSuccess = EditApplySuccess | WriteSuccess;

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
