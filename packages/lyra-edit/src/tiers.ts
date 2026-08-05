import type { EditTier } from "./types.ts";

export interface TierApplySuccess {
  ok: true;
  content: string;
  tier: Exclude<EditTier, "not_applied">;
  occurrences: number;
}

export interface TierApplyFailure {
  ok: false;
  code: "no_match" | "ambiguous_match" | "no_op";
  message: string;
  closest?: string;
  matches?: string[];
}

export type TierApplyResult = TierApplySuccess | TierApplyFailure;

interface LineSpan {
  start: number;
  textEnd: number;
  end: number;
  text: string;
}

function lineSpans(input: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let start = 0;

  while (start < input.length) {
    let cursor = start;
    while (cursor < input.length && input[cursor] !== "\n" && input[cursor] !== "\r") {
      cursor += 1;
    }

    const textEnd = cursor;
    let end = cursor;
    if (cursor < input.length) {
      end += input[cursor] === "\r" && input[cursor + 1] === "\n" ? 2 : 1;
    }

    spans.push({ start, textEnd, end, text: input.slice(start, textEnd) });
    start = end;
  }

  return spans;
}

function hasTrailingLineBreak(input: string): boolean {
  return input.endsWith("\n") || input.endsWith("\r");
}

function splice(input: string, start: number, end: number, replacement: string): string {
  return input.slice(0, start) + replacement + input.slice(end);
}

function matchFailure(
  code: TierApplyFailure["code"],
  message: string,
  extra: Pick<TierApplyFailure, "closest" | "matches"> = {},
): TierApplyFailure {
  return { ok: false, code, message, ...extra };
}

function exactOccurrences(input: string, search: string): number[] {
  const occurrences: number[] = [];
  let offset = 0;
  while (offset <= input.length - search.length) {
    const found = input.indexOf(search, offset);
    if (found < 0) break;
    occurrences.push(found);
    offset = found + search.length;
  }
  return occurrences;
}

function snippet(input: string, start: number, end: number): string {
  return input.slice(start, end);
}

/** Apply only the byte-for-byte tier. A repeated search is never silently resolved. */
export function applyExact(content: string, search: string, replace: string): TierApplyResult {
  if (search.length === 0) {
    return matchFailure("no_match", "Search text must not be empty.");
  }

  const occurrences = exactOccurrences(content, search);
  if (occurrences.length === 0) {
    return matchFailure("no_match", "The search text was not found.");
  }
  if (occurrences.length > 1) {
    return matchFailure(
      "ambiguous_match",
      `The search text matched ${occurrences.length} locations; include more context to make it unique.`,
      { matches: occurrences.map((start) => snippet(content, start, start + search.length)) },
    );
  }

  const next = splice(content, occurrences[0]!, occurrences[0]! + search.length, replace);
  if (next === content) {
    return matchFailure("no_op", "The replacement does not change the file.");
  }
  return { ok: true, content: next, tier: "exact", occurrences: 1 };
}

function whitespaceKey(line: string): string {
  // sa3p's whitespace tier intentionally ignores indentation and trailing spacing,
  // but does not alter meaningful spacing within a line.
  return line.trim();
}

function searchLines(search: string): string[] {
  return lineSpans(search).map((line) => line.text);
}

interface WindowMatch {
  start: number;
  end: number;
  text: string;
}

function whitespaceMatches(content: string, search: string): WindowMatch[] {
  const originalLines = lineSpans(content);
  const wanted = searchLines(search);
  if (wanted.length === 0 || originalLines.length < wanted.length) return [];

  const matches: WindowMatch[] = [];
  for (let start = 0; start <= originalLines.length - wanted.length; start += 1) {
    let equal = true;
    for (let index = 0; index < wanted.length; index += 1) {
      if (whitespaceKey(originalLines[start + index]!.text) !== whitespaceKey(wanted[index]!)) {
        equal = false;
        break;
      }
    }
    if (!equal) continue;

    const first = originalLines[start]!;
    const last = originalLines[start + wanted.length - 1]!;
    const end = hasTrailingLineBreak(search) ? last.end : last.textEnd;
    matches.push({ start: first.start, end, text: snippet(content, first.start, end) });
  }
  return matches;
}

/** Apply the line-oriented whitespace-agnostic tier, requiring one window. */
export function applyWhitespaceAgnostic(
  content: string,
  search: string,
  replace: string,
): TierApplyResult {
  if (search.length === 0) {
    return matchFailure("no_match", "Search text must not be empty.");
  }

  const matches = whitespaceMatches(content, search);
  if (matches.length === 0) {
    return matchFailure("no_match", "No unique whitespace-equivalent search window was found.");
  }
  if (matches.length > 1) {
    return matchFailure(
      "ambiguous_match",
      `The whitespace-agnostic search matched ${matches.length} locations; include more context to make it unique.`,
      { matches: matches.map((match) => match.text) },
    );
  }

  const match = matches[0]!;
  const next = splice(content, match.start, match.end, replace);
  if (next === content) {
    return matchFailure("no_op", "The replacement does not change the file.");
  }
  return { ok: true, content: next, tier: "whitespace_agnostic", occurrences: 1 };
}

function normalizedForDistance(input: string): string {
  return lineSpans(input)
    .map((line) => line.text.split(/\s+/u).filter((part) => part.length > 0).join(" "))
    .join("\n")
    .trim();
}

/** Levenshtein distance over Unicode code points (not UTF-16 surrogate halves). */
function levenshtein(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 0; row < a.length; row += 1) {
    const current = [row + 1];
    for (let column = 0; column < b.length; column += 1) {
      current.push(
        Math.min(
          current[column]! + 1,
          previous[column + 1]! + 1,
          previous[column]! + (a[row] === b[column] ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

function contextualMatches(content: string, search: string): { matches: WindowMatch[]; closest?: string } {
  const originalLines = lineSpans(content);
  const wanted = searchLines(search);
  if (wanted.length === 0 || originalLines.length < wanted.length) return { matches: [] };

  const normalizedSearch = normalizedForDistance(search);
  const threshold = Array.from(normalizedSearch).length / 3;
  let bestScore = Number.POSITIVE_INFINITY;
  let best: WindowMatch[] = [];
  let closest: string | undefined;

  for (let start = 0; start <= originalLines.length - wanted.length; start += 1) {
    const first = originalLines[start]!;
    const last = originalLines[start + wanted.length - 1]!;
    const end = hasTrailingLineBreak(search) ? last.end : last.textEnd;
    const candidate = snippet(content, first.start, end);
    const joined = originalLines
      .slice(start, start + wanted.length)
      .map((line) => line.text)
      .join("\n");
    const score = levenshtein(normalizedForDistance(joined), normalizedSearch);

    if (score < bestScore) {
      bestScore = score;
      best = [{ start: first.start, end, text: candidate }];
      closest = candidate;
    } else if (score === bestScore) {
      best.push({ start: first.start, end, text: candidate });
    }
  }

  if (bestScore > threshold) {
    return closest === undefined ? { matches: [] } : { matches: [], closest };
  }
  return { matches: best };
}

/** Apply the contextual line-window tier with an exact normalized-length/3 threshold. */
export function applyContextualAnchor(
  content: string,
  search: string,
  replace: string,
): TierApplyResult {
  if (search.length === 0) {
    return matchFailure("no_match", "Search text must not be empty.");
  }

  const contextual = contextualMatches(content, search);
  if (contextual.matches.length === 0) {
    return matchFailure(
      "no_match",
      "No contextual search window was within the allowed edit distance; re-read the file and provide more context.",
      contextual.closest === undefined ? {} : { closest: contextual.closest },
    );
  }
  if (contextual.matches.length > 1) {
    return matchFailure(
      "ambiguous_match",
      "The contextual search has equally close matches; include more surrounding context to make it unique.",
      { matches: contextual.matches.map((match) => match.text) },
    );
  }

  const match = contextual.matches[0]!;
  const next = splice(content, match.start, match.end, replace);
  if (next === content) {
    return matchFailure("no_op", "The replacement does not change the file.");
  }
  return { ok: true, content: next, tier: "contextual_anchor", occurrences: 1 };
}

/** Try the tiers in order, refusing every ambiguous candidate. */
export function applySearchReplace(content: string, search: string, replace: string): TierApplyResult {
  if (search.length === 0) {
    return matchFailure("no_match", "Search text must not be empty.");
  }

  const exact = applyExact(content, search, replace);
  if (exact.ok || exact.code === "ambiguous_match" || exact.code === "no_op") return exact;

  const whitespace = applyWhitespaceAgnostic(content, search, replace);
  if (whitespace.ok || whitespace.code === "ambiguous_match" || whitespace.code === "no_op") return whitespace;

  const contextual = applyContextualAnchor(content, search, replace);
  if (contextual.ok || contextual.code === "ambiguous_match" || contextual.code === "no_op") return contextual;
  return contextual;
}

export const applyEditWithTiers = applySearchReplace;
