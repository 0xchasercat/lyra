/**
 * Budget discipline for query answers.
 *
 * The studied flaw this file exists to prevent: an answer that renders every *node* line
 * before it renders any *edge* line. Under a tight budget that ordering degenerates into a
 * list of filenames — the shape of the graph, which is the only thing a code map knows that
 * `grep` does not, is exactly what gets cut. Edges are the payload.
 *
 * So allocation is not "fill the document top to bottom until it is full". It is:
 *
 * 1. The **head** — the queried symbol and its identity — is emitted unconditionally. The
 *    thing that was asked about always survives the cut, even if it is all that fits.
 * 2. Every section gets its **floor** of rows before any section gets a second helping.
 * 3. The remainder is handed out **round-robin**, one row at a time. A section with two
 *    thousand callers cannot starve the section holding the four edges that answer the
 *    question.
 *
 * Whatever is dropped is announced twice — once at the top, before the reader has spent any
 * attention, and once at the bottom, where a reader who ran out of rows is looking — and
 * both notices carry a remediation hint naming the knob to turn.
 */

import {
  emitToon,
  toonField,
  toonGroupHeader,
  toonNote,
  toonRow,
  toonTableHeader,
  TOON_INDENT,
  type ToonNode,
  type ToonRow,
  type ToonTable,
} from "./toon.ts";

/** Chosen so a default answer is a few thousand characters: large enough to carry edges. */
export const DEFAULT_BUDGET = 4000;
/** Below this nothing useful survives, so an explicit smaller budget is raised to it. */
export const MIN_BUDGET = 500;
/** Above this a query is the wrong tool; read the file instead. */
export const MAX_BUDGET = 32_000;

/** Slack above the measured worst-case notice, covering the optional `stale` line. */
const NOTICE_RESERVE = 24;

/**
 * Resolve a caller-supplied budget. Absent or unusable means {@link DEFAULT_BUDGET};
 * anything else is clamped into `[MIN_BUDGET, MAX_BUDGET]` rather than rejected, because a
 * tool argument out of range should still answer the question.
 */
export function clampBudget(budget?: number): number {
  if (budget === undefined || !Number.isFinite(budget)) return DEFAULT_BUDGET;
  return Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.floor(budget)));
}

/** One trimmable block of the answer. */
export interface Section {
  readonly table: ToonTable;
  /** Rows this section is guaranteed before round-robin starts. Defaults to 3. */
  readonly floor?: number;
}

export interface DocumentInput {
  /** Emitted whole, before anything is priced. The answer's identity lives here. */
  readonly head: readonly ToonNode[];
  readonly sections: readonly Section[];
  readonly budget: number;
  /** How to see more: `"a narrower query"`, `"relation=calls"`, … */
  readonly hint?: string;
  /** Files whose bytes no longer match the index; omitted from the output when zero. */
  readonly stale?: number;
}

interface Priced {
  readonly section: Section;
  /** Flat row list in emission order, each with its own cost and its group index. */
  readonly rows: readonly { row: ToonRow; group: number; cost: number }[];
  readonly groupCost: readonly number[];
  readonly headerCost: number;
  taken: number;
  /** Groups already paid for, by index. */
  readonly paid: Set<number>;
}

/**
 * Assemble a budget-bounded TOON answer. The returned string is never longer than
 * `budget` unless the head alone is, which is deliberate: an answer that omits the symbol
 * it was asked about is not a shorter answer, it is a wrong one.
 */
export function renderDocument(input: DocumentInput): string {
  const budget = input.budget;
  const priced = input.sections.map(price).filter((entry) => entry.rows.length > 0);
  const headCost = costOf(input.head);

  // Everything might fit, in which case no notice is emitted and no reserve is owed.
  allocate(priced, budget - headCost);
  let output = assemble(input, priced);
  if (output.length <= budget && priced.every((entry) => entry.taken === entry.rows.length)) return output;

  // Something will be cut, so the notice is owed. Reserve its worst case — every section
  // cut, which is the longest it can be — then hand the slack back row by row against the
  // real measurement. Guessing the reserve and retrying on overflow compounds: each retry
  // over-corrects, and on a five-section brief it converged on showing nothing at all.
  allocate(priced, budget - headCost - noticeReserve(input, priced));
  output = assemble(input, priced);
  output = topUp(input, priced, output, budget);

  // Belt and braces: shed the largest section a row at a time until it fits.
  while (output.length > budget) {
    const fattest = priced.reduce<Priced | undefined>((best, entry) => (entry.taken > (best?.taken ?? 0) ? entry : best), undefined);
    if (!fattest || fattest.taken === 0) break;
    fattest.taken -= 1;
    output = assemble(input, priced);
  }
  return output;
}

/**
 * The longest the two notices can be, measured rather than guessed: assemble the document
 * with every section cut to nothing (which is when the notice is at its most verbose) and
 * subtract the same document with no sections at all (which never carries a notice).
 */
function noticeReserve(input: DocumentInput, sections: readonly Priced[]): number {
  if (sections.length === 0) return 0;
  const worst = sections.map((entry) => ({ ...entry, taken: 0 }));
  return Math.max(0, assemble(input, worst).length - assemble(input, []).length) + NOTICE_RESERVE;
}

/**
 * Hand back whatever the worst-case reserve over-reserved, one row at a time, measuring the
 * whole document each time. Round-robin across sections so the reclaimed space is shared.
 */
function topUp(input: DocumentInput, sections: readonly Priced[], start: string, budget: number): string {
  let output = start;
  let cursor = 0;
  for (let guard = 0; guard < 512; guard += 1) {
    let advanced = false;
    for (let probe = 0; probe < sections.length; probe += 1) {
      const entry = sections[(cursor + probe) % sections.length]!;
      if (entry.taken >= entry.rows.length) continue;
      entry.taken += 1;
      const candidate = assemble(input, sections);
      if (candidate.length <= budget) {
        output = candidate;
        cursor = (cursor + probe + 1) % sections.length;
        advanced = true;
        break;
      }
      entry.taken -= 1;
    }
    if (!advanced) break;
  }
  return output;
}

// ---------------------------------------------------------------- internals

function costOf(nodes: readonly ToonNode[]): number {
  const text = emitToon(nodes);
  return text.length === 0 ? 0 : text.length + 1;
}

function price(section: Section): Priced {
  const table = section.table;
  const grouped = table.keyFields !== undefined && table.keyFields.length > 0;
  const indent = grouped ? TOON_INDENT + TOON_INDENT : TOON_INDENT;
  const rows: { row: ToonRow; group: number; cost: number }[] = [];
  const groupCost: number[] = [];
  table.groups.forEach((group, index) => {
    groupCost.push(grouped ? TOON_INDENT.length + toonGroupHeader(group).length + 1 : 0);
    for (const row of group.rows) {
      rows.push({ row, group: index, cost: indent.length + toonRow(row).length + 1 });
    }
  });
  return {
    section,
    rows,
    groupCost,
    headerCost: toonTableHeader(table).length + 1,
    taken: 0,
    paid: new Set<number>(),
  };
}

/** What taking one more row from `entry` would add to the document. */
function nextCost(entry: Priced): number {
  const next = entry.rows[entry.taken];
  if (!next) return Number.POSITIVE_INFINITY;
  let cost = next.cost;
  if (entry.taken === 0) cost += entry.headerCost;
  if (!entry.paid.has(next.group)) cost += entry.groupCost[next.group] ?? 0;
  return cost;
}

function take(entry: Priced): void {
  entry.paid.add(entry.rows[entry.taken]!.group);
  entry.taken += 1;
}

/**
 * Floors first, then round-robin. The floor pass is what guarantees that a document with a
 * node section and an edge section shows edges: the edge section's floor is claimed before
 * the node section's fourth row is even considered.
 */
function allocate(sections: readonly Priced[], available: number): void {
  for (const entry of sections) {
    entry.taken = 0;
    entry.paid.clear();
  }
  let left = available;
  if (left <= 0) return;
  for (const entry of sections) {
    const floor = entry.section.floor ?? 3;
    while (entry.taken < floor && entry.taken < entry.rows.length) {
      const cost = nextCost(entry);
      if (cost > left) break;
      take(entry);
      left -= cost;
    }
  }
  let progressed = true;
  while (progressed && left > 0) {
    progressed = false;
    for (const entry of sections) {
      if (entry.taken >= entry.rows.length) continue;
      const cost = nextCost(entry);
      if (cost > left) continue;
      take(entry);
      left -= cost;
      progressed = true;
    }
  }
}

function trimmed(entry: Priced): ToonTable {
  const table = entry.section.table;
  const kept = entry.rows.slice(0, entry.taken);
  const groups = table.groups
    .map((group, index) => ({ key: group.key, rows: kept.filter((row) => row.group === index).map((row) => row.row) }))
    .filter((group) => group.rows.length > 0);
  return { ...table, groups };
}

/**
 * The top notice is an aggregate and the bottom one is the detail.
 *
 * They used to both enumerate every section, and on a five-section brief that cost 270
 * characters — more than half of a tight budget, spent announcing that there was no room
 * for anything. The notice must never be the reason the payload does not fit.
 */
function assemble(input: DocumentInput, sections: readonly Priced[]): string {
  const cut = sections.filter((entry) => entry.taken < entry.rows.length);
  let shown = 0;
  let total = 0;
  for (const entry of sections) {
    shown += entry.taken;
    total += entry.rows.length;
  }

  const nodes: ToonNode[] = [...input.head];
  if (cut.length > 0) nodes.push(toonField("truncated", `${shown}/${total} rows`));
  for (const entry of sections) if (entry.taken > 0) nodes.push(trimmed(entry));
  if (cut.length > 0) {
    const detail = cut
      .slice(0, 3)
      .map((entry) => `${entry.section.table.name} ${entry.taken}/${entry.rows.length}`)
      .join("; ");
    const more = cut.length > 3 ? `; +${cut.length - 3} more` : "";
    const hint = input.hint === undefined ? "" : `, or narrow with ${input.hint}`;
    nodes.push(toonNote(`truncated: ${detail}${more} — raise budget (now ${input.budget})${hint}`));
  }
  if (input.stale !== undefined && input.stale > 0) nodes.push(toonField("stale", `${input.stale} files`));
  return emitToon(nodes);
}
