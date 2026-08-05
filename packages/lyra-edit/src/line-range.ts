type LineEnding = "" | "\n" | "\r\n" | "\r";

type LineRecord = {
  contentStart: number;
  contentEnd: number;
  ending: LineEnding;
};

export type LineRangeResult =
  | { ok: true; content: string; occurrences: number }
  | { ok: false; code: "invalid_range"; message: string };

function splitLines(source: string): LineRecord[] {
  const lines: LineRecord[] = [];
  let lineStart = 0;
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "\n" || character === "\r") {
      const ending: LineEnding = character === "\r" && source[index + 1] === "\n" ? "\r\n" : character;
      lines.push({ contentStart: lineStart, contentEnd: index, ending });
      index += ending.length;
      lineStart = index;
    } else {
      index += 1;
    }
  }
  // A trailing line ending terminates the preceding line; it does not create
  // a phantom addressable line. Empty input is nevertheless line 1.
  if (lineStart < source.length || lines.length === 0) {
    lines.push({ contentStart: lineStart, contentEnd: source.length, ending: "" });
  }
  return lines;
}


/** Replace an inclusive, one-based line range while retaining source endings. */
export function applyLineRange(
  source: string,
  startLine: number,
  endLine: number,
  replace: string,
): LineRangeResult {
  const lines = splitLines(source);
  const totalLines = lines.length;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < 1) {
    return { ok: false, code: "invalid_range", message: `Line range must use positive integer lines; received ${String(startLine)}-${String(endLine)}.` };
  }
  if (startLine > endLine) {
    return { ok: false, code: "invalid_range", message: `Line range start (${startLine}) must not exceed end (${endLine}).` };
  }
  if (startLine > totalLines || endLine > totalLines) {
    return { ok: false, code: "invalid_range", message: `Line range ${startLine}-${endLine} is outside ${totalLines} addressable line${totalLines === 1 ? "" : "s"}; re-read the file and choose an in-bounds range.` };
  }

  const first = lines[startLine - 1]!;
  const last = lines[endLine - 1]!;
  // The selected line's terminator is part of the line boundary. Keep it when
  // replacement does not explicitly provide one; otherwise replacement owns
  // that boundary. This preserves CRLF/CR and the original final-newline bit.
  const selectedEnd = last.contentEnd + last.ending.length;
  const preservedEnding = /(?:\r\n|\r|\n)$/.test(replace) ? "" : last.ending;
  const content = source.slice(0, first.contentStart) + replace + preservedEnding + source.slice(selectedEnd);
  return { ok: true, content, occurrences: 1 };
}
