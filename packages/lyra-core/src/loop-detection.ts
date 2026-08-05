import type { ToolProgress } from "./types.ts";
import type { LoopWarning } from "./types.ts";

const DEFAULT_NO_PROGRESS_TURNS = 10;

export interface LoopDetection {
  warnings: LoopWarning[];
  /** A request to the unattended runner, not an abort performed by the detector. */
  hardStopRequested: boolean;
}

export interface LoopDetectorOptions {
  noProgressTurns?: number;
  unattended?: boolean;
}

/** Detects the same tool and canonical JSON arguments on consecutive calls. */
export class IdenticalToolCallDetector {
  private previousCall: string | undefined;
  private consecutiveCalls = 0;

  record(tool: string, args: unknown): Extract<LoopWarning, { type: "identical_tool_call" }> | undefined {
    const call = `${tool.length}:${tool}:${canonicalToolArguments(args)}`;
    if (call === this.previousCall) {
      this.consecutiveCalls += 1;
    } else {
      this.previousCall = call;
      this.consecutiveCalls = 1;
    }
    if (this.consecutiveCalls < 3) return undefined;
    return { type: "identical_tool_call", tool, count: this.consecutiveCalls };
  }

  reset(): void {
    this.previousCall = undefined;
    this.consecutiveCalls = 0;
  }
}

/** Detects completed-turn windows in which no new externally observable state appears. */
export class NoProgressDetector {
  readonly turnLimit: number;
  private readonly filesRead = new Set<string>();
  private readonly exitCodes = new Set<number>();
  private turnsWithoutProgress = 0;

  constructor(turnLimit = DEFAULT_NO_PROGRESS_TURNS) {
    if (!Number.isInteger(turnLimit) || turnLimit < 1) {
      throw new RangeError("no-progress turn limit must be a positive integer");
    }
    this.turnLimit = turnLimit;
  }

  record(progress: readonly ToolProgress[]): Extract<LoopWarning, { type: "no_progress" }> | undefined {
    let madeProgress = false;
    for (const item of progress) {
      for (const path of item.filesRead ?? []) {
        if (!this.filesRead.has(path)) madeProgress = true;
        this.filesRead.add(path);
      }
      if ((item.filesModified?.length ?? 0) > 0) madeProgress = true;
      if (item.commandExitCode !== undefined) {
        if (!this.exitCodes.has(item.commandExitCode)) madeProgress = true;
        this.exitCodes.add(item.commandExitCode);
      }
    }

    if (madeProgress) {
      this.turnsWithoutProgress = 0;
      return undefined;
    }
    this.turnsWithoutProgress += 1;
    if (this.turnsWithoutProgress !== this.turnLimit) return undefined;
    return { type: "no_progress", turns: this.turnsWithoutProgress };
  }

  reset(): void {
    this.filesRead.clear();
    this.exitCodes.clear();
    this.turnsWithoutProgress = 0;
  }
}

interface FileHashState {
  edits: number;
  previousHash?: string;
  currentHash: string;
}

/** Detects immediate per-file two-state cycles such as A to B to A. */
export class FileOscillationDetector {
  private readonly files = new Map<string, FileHashState>();

  record(
    path: string,
    beforeHash: string | undefined,
    afterHash: string | undefined,
  ): Extract<LoopWarning, { type: "oscillation" }> | undefined {
    if (afterHash === undefined || afterHash === beforeHash) return undefined;
    const state = this.files.get(path);
    if (state === undefined || (beforeHash !== undefined && state.currentHash !== beforeHash)) {
      this.files.set(path, {
        edits: 1,
        ...(beforeHash === undefined ? {} : { previousHash: beforeHash }),
        currentHash: afterHash,
      });
      return undefined;
    }

    const edits = state.edits + 1;
    const oscillated = edits >= 2 && state.previousHash === afterHash;
    this.files.set(path, {
      edits,
      previousHash: state.currentHash,
      currentHash: afterHash,
    });
    if (!oscillated) return undefined;
    return { type: "oscillation", path, hash: afterHash };
  }

  reset(path?: string): void {
    if (path === undefined) this.files.clear();
    else this.files.delete(path);
  }
}

/** Composes the three detectors while keeping their state and warning policies independent. */
export class LoopDetector {
  readonly identicalToolCalls = new IdenticalToolCallDetector();
  readonly noProgress: NoProgressDetector;
  readonly oscillation = new FileOscillationDetector();
  readonly unattended: boolean;

  constructor(options: LoopDetectorOptions = {}) {
    this.noProgress = new NoProgressDetector(options.noProgressTurns);
    this.unattended = options.unattended ?? false;
  }

  recordToolCall(tool: string, args: unknown): LoopDetection {
    const warning = this.identicalToolCalls.record(tool, args);
    return {
      warnings: warning === undefined ? [] : [warning],
      hardStopRequested: false,
    };
  }

  recordFileEdit(
    path: string,
    beforeHash?: string,
    afterHash?: string,
  ): LoopDetection {
    const warning = this.oscillation.record(path, beforeHash, afterHash);
    return {
      warnings: warning === undefined ? [] : [warning],
      hardStopRequested: false,
    };
  }

  recordTurn(progress: ToolProgress | readonly ToolProgress[] = []): LoopDetection {
    const items = Array.isArray(progress) ? progress : [progress];
    const warnings: LoopWarning[] = [];
    for (const item of items) {
      for (const modified of item.filesModified ?? []) {
        const warning = this.oscillation.record(
          modified.path,
          modified.beforeHash,
          modified.afterHash,
        );
        if (warning !== undefined) warnings.push(warning);
      }
    }
    const noProgressWarning = this.noProgress.record(items);
    if (noProgressWarning !== undefined) warnings.push(noProgressWarning);
    return {
      warnings,
      hardStopRequested: this.unattended && noProgressWarning !== undefined,
    };
  }

  reset(): void {
    this.identicalToolCalls.reset();
    this.noProgress.reset();
    this.oscillation.reset();
  }
}

/** Stable JSON encoding makes object key insertion order irrelevant to repeat detection. */
export function canonicalToolArguments(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown): string | undefined => {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") return Number.isFinite(item) ? JSON.stringify(item) : "null";
    if (typeof item === "bigint") return JSON.stringify(item.toString());
    if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol") {
      return undefined;
    }
    if (ancestors.has(item)) return JSON.stringify("[Circular]");
    ancestors.add(item);
    let encoded: string;
    if (Array.isArray(item)) {
      encoded = `[${item.map((element) => encode(element) ?? "null").join(",")}]`;
    } else {
      const record = item as Record<string, unknown>;
      const fields: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const field = encode(record[key]);
        if (field !== undefined) fields.push(`${JSON.stringify(key)}:${field}`);
      }
      encoded = `{${fields.join(",")}}`;
    }
    ancestors.delete(item);
    return encoded;
  };
  return encode(value) ?? "null";
}
