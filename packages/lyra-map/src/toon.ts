/**
 * TOON — Token-Oriented Object Notation.
 *
 * The map's query verbs answer in a tabular text format rather than JSON, for one measured
 * reason: JSON repeats every field name on every row. A hundred search hits cost a hundred
 * copies of `"kind"`, `"file"`, `"start"`, `"end"`. TOON declares the fields once in a header
 * and streams bare rows beneath it, and it factors the part of every row that repeats — the
 * qualified-name prefix and the file — into a group header so a row carries only what makes
 * it different. On real result sets from this repository that is a ~72% reduction against the
 * equivalent JSON (`toon.test.ts` pins the claim at ≥60% so it cannot silently regress).
 *
 * The format is deliberately boring, because the reader is a language model:
 *
 * ```
 * verb: search
 * # qn = prefix + "." + name
 * results[5]{prefix,file}{name,kind,lines,in,out}:
 *   src.store,src/store.ts[3]:
 *     MapStore,class,173-712,4,31
 *     toNode,function,731-742,3,1
 *     toFtsQuery,function,745-752,2,2
 *   src.qn,src/qn.ts[2]:
 *     splitIdentifier,function,100-117,4,0
 *     fileQn,function,67-69,3,1
 * ```
 *
 * A table header is `name[totalRows]{keyFields}{rowFields}:` — the `{keyFields}` block is
 * omitted for a flat table. Each group header is `keyValues[rowCount]:`. Every line is
 * comma-delimited, and every value obeys one quoting rule (see {@link toonScalar}), so a
 * consumer can parse it by splitting on commas outside quotes and nothing else.
 *
 * Nothing here knows about code maps. The emitter is generic on purpose — grep and glob
 * results have the same shape problem and should eventually answer the same way.
 */

/** A single cell. `null`/`undefined` render as the empty marker `-`. */
export type ToonScalar = string | number | boolean | null | undefined;

/** One row's cells, positionally matched to the table's `fields`. */
export type ToonRow = readonly ToonScalar[];

/** Rows sharing a factored key — the (prefix, file) pair that would otherwise repeat. */
export interface ToonGroup {
  readonly key: ToonRow;
  readonly rows: readonly ToonRow[];
}

/** A single `key: value` line. */
export interface ToonField {
  readonly kind: "field";
  readonly key: string;
  readonly value: ToonScalar;
}

/** A `# ...` line. Used for reconstruction rules and truncation notices. */
export interface ToonNote {
  readonly kind: "note";
  readonly text: string;
}

/** A one-line counted sequence: `name[3]: a,b,c`. */
export interface ToonList {
  readonly kind: "list";
  readonly name: string;
  readonly items: ToonRow;
}

/** A counted table. Flat when `keyFields` is absent, prefix-factored when it is present. */
export interface ToonTable {
  readonly kind: "table";
  readonly name: string;
  readonly fields: readonly string[];
  readonly keyFields?: readonly string[];
  readonly groups: readonly ToonGroup[];
}

export type ToonNode = ToonField | ToonNote | ToonList | ToonTable;

/** One indentation level. Group headers sit at one, their rows at two. */
export const TOON_INDENT = "  ";

/** The cell value meaning "absent". A literal `-` string is quoted to stay distinguishable. */
export const TOON_EMPTY = "-";

const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const RESERVED = new Set(["true", "false", "null", "-", "~"]);

/** C0 controls and DEL — anything that would break the line-oriented grammar. */
function hasControlByte(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Whether a bare string would be misread. Quoting is the exception, not the rule, because
 * every quote pair is two tokens that buy nothing when the value is an ordinary identifier.
 *
 * A value is quoted iff it is empty, carries leading or trailing whitespace, contains a
 * quote, a control byte, or the `,` delimiter, opens with a character that starts a
 * structural line (`#`, `[`, `{`), or would parse as a number, a boolean, or the empty
 * marker. A colon is deliberately *not* a trigger: `src/store.ts:551` is the single most
 * common value the map emits, and nothing in the grammar splits a row on a colon.
 */
export function toonNeedsQuote(text: string): boolean {
  if (text.length === 0) return true;
  if (text !== text.trim()) return true;
  if (hasControlByte(text)) return true;
  if (text.includes('"')) return true;
  if (text.includes(",")) return true;
  // Only a `# ` opening is ambiguous — that is the comment marker. `#apply` is an ordinary
  // private-method name in TypeScript and quoting every one of them would be pure overhead.
  if (text === "#" || text.startsWith("# ")) return true;
  if (text.startsWith("[") || text.startsWith("{")) return true;
  if (RESERVED.has(text.toLowerCase())) return true;
  return NUMERIC.test(text);
}

/**
 * Render one cell. A quoted cell is exactly a JSON string literal, so escaping never needs
 * its own rules and a consumer already has a parser for it.
 */
export function toonScalar(value: ToonScalar): string {
  if (value === null || value === undefined) return TOON_EMPTY;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  return toonNeedsQuote(value) ? JSON.stringify(value) : value;
}

/** Render a row as comma-joined cells. No trailing delimiter, no padding. */
export function toonRow(row: ToonRow): string {
  return row.map(toonScalar).join(",");
}

/** Total rows across a table's groups — the count its header advertises. */
export function toonTableSize(table: ToonTable): number {
  let total = 0;
  for (const group of table.groups) total += group.rows.length;
  return total;
}

/** Render one node into lines. Exposed so the budget fitter can price a table piecewise. */
export function toonLines(node: ToonNode): string[] {
  switch (node.kind) {
    case "field":
      return [`${node.key}: ${toonScalar(node.value)}`];
    case "note":
      return [`# ${node.text}`];
    case "list":
      return [`${node.name}[${node.items.length}]: ${toonRow(node.items)}`];
    case "table": {
      const lines = [toonTableHeader(node)];
      const grouped = node.keyFields !== undefined && node.keyFields.length > 0;
      for (const group of node.groups) {
        if (group.rows.length === 0) continue;
        if (grouped) {
          lines.push(`${TOON_INDENT}${toonGroupHeader(group)}`);
          for (const row of group.rows) lines.push(`${TOON_INDENT}${TOON_INDENT}${toonRow(row)}`);
        } else {
          for (const row of group.rows) lines.push(`${TOON_INDENT}${toonRow(row)}`);
        }
      }
      return lines;
    }
  }
}

/** The `name[N]{keys}{fields}:` line a table opens with. */
export function toonTableHeader(table: ToonTable): string {
  const keys = table.keyFields !== undefined && table.keyFields.length > 0 ? `{${table.keyFields.join(",")}}` : "";
  return `${table.name}[${toonTableSize(table)}]${keys}{${table.fields.join(",")}}:`;
}

/** The `keyValues[N]:` line a factored group opens with. */
export function toonGroupHeader(group: ToonGroup): string {
  return `${toonRow(group.key)}[${group.rows.length}]:`;
}

/** Render a whole document. Empty tables and empty lists are dropped, never padded. */
export function emitToon(nodes: readonly ToonNode[]): string {
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.kind === "table" && toonTableSize(node) === 0) continue;
    if (node.kind === "list" && node.items.length === 0) continue;
    lines.push(...toonLines(node));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- constructors

export function toonField(key: string, value: ToonScalar): ToonField {
  return { kind: "field", key, value };
}

export function toonNote(text: string): ToonNote {
  return { kind: "note", text };
}

export function toonList(name: string, items: ToonRow): ToonList {
  return { kind: "list", name, items };
}

/** A table with no factored key: every row stands alone under the header. */
export function toonFlatTable(name: string, fields: readonly string[], rows: readonly ToonRow[]): ToonTable {
  return { kind: "table", name, fields, groups: rows.length === 0 ? [] : [{ key: [], rows }] };
}

/**
 * Factor `items` into groups by a key, preserving the order in which each key was first
 * seen — the caller has already sorted for relevance and regrouping must not reorder it.
 */
export function toonGroupedTable<T>(
  name: string,
  keyFields: readonly string[],
  fields: readonly string[],
  items: readonly T[],
  keyOf: (item: T) => ToonRow,
  rowOf: (item: T) => ToonRow,
): ToonTable {
  const groups = new Map<string, { key: ToonRow; rows: ToonRow[] }>();
  for (const item of items) {
    const key = keyOf(item);
    const id = toonRow(key);
    let group = groups.get(id);
    if (!group) {
      group = { key, rows: [] };
      groups.set(id, group);
    }
    group.rows.push(rowOf(item));
  }
  return { kind: "table", name, fields, keyFields, groups: [...groups.values()] };
}

/**
 * The reconstruction rule for a `(prefix, file)`-factored symbol table. Emitted with every
 * such table so the model can rebuild an exact join key rather than guessing at one — a
 * short name alone is not addressable, and a guessed qualified name is worse than none.
 */
export const QN_RULE = 'qn = prefix + "." + name';

/**
 * The reconstruction rule for a table whose group key carries the relation site's file and
 * whose rows carry only the line. `file:line` is the coordinate a reader jumps to, so it
 * must be rebuildable without ambiguity even though it is never printed whole.
 */
export const SITE_RULE = 'at = file + ":" + line';
