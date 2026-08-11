/**
 * The query verbs — what the `map` tool actually calls.
 *
 * Every verb returns TOON (never JSON), is bounded by an explicit character budget, and
 * answers about the *graph*: not "which files contain this string" — `grep` already does
 * that, faster — but "who calls this", "what breaks if I change it", "how do these two
 * things reach each other". The relation SITE (`file:line` of the call, not of the
 * definition) is on every edge row, because a caller you cannot jump to is trivia.
 *
 * ## Naming a symbol
 *
 * Every verb that takes a symbol accepts four spellings, tried in this order:
 *
 * 1. the exact qualified name — `src.store.MapStore.searchFts`
 * 2. a bare name — `searchFts`
 * 3. a dotted tail — `MapStore.searchFts`
 * 4. any of the above in the wrong case
 *
 * Case is preserved in storage and an exact-case hit always wins; folding is a query-time
 * courtesy only. When a spelling matches more than one symbol the verb answers with the
 * candidate list rather than picking one, and when it matches none it answers with the
 * nearest full-text hits, so a wrong guess teaches the right call instead of returning
 * nothing.
 */

import { hashContent } from "@lyra/edit";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { CodeMap } from "./incremental.ts";
import { fileQn, splitIdentifier, toPosix } from "./qn.ts";
import { clampBudget, renderDocument, type Section } from "./render.ts";
import type { Degree, DegreeNode, FileRow } from "./store.ts";
import type { EdgeRelation, NodeKind, StoredEdge, StoredNode } from "./types.ts";
import {
  QN_RULE,
  SITE_RULE,
  toonField,
  toonFlatTable,
  toonGroupedTable,
  toonList,
  toonNote,
  type ToonNode,
  type ToonRow,
  type ToonTable,
} from "./toon.ts";

/**
 * The relations that make one symbol depend on another. `contains` and `defines` are
 * excluded: they say "declared here", which is true of every symbol and propagates a
 * whole file into any closure that follows them.
 */
export const IMPACT_RELATIONS: readonly EdgeRelation[] = Object.freeze([
  "calls",
  "references",
  "imports",
  "imports_from",
  "re_exports",
  "extends",
  "implements",
  "inherits",
]);

/**
 * Relations a path may travel. `defines` is dropped because it is the transitive closure of
 * `contains` flattened onto the file node — keeping it would let any two symbols in a file
 * claim a two-hop connection that no reader would call a connection.
 */
const PATH_RELATIONS: readonly EdgeRelation[] = Object.freeze([...IMPACT_RELATIONS, "contains"]);

/** How far a path search will look before reporting honestly that it found nothing. */
const PATH_MAX_HOPS = 8;
/** Ceiling on nodes visited by a path search, so a hub cannot turn one call into a scan. */
const PATH_MAX_VISITS = 20_000;
/** Ceiling on edges pulled per direction by `explain`. */
const EDGE_FETCH_CAP = 400;
/** Files beyond which the cheap mtime staleness check is skipped rather than paid for. */
const STALE_SCAN_CAP = 20_000;
/** How many same-size mtime drifts one call will settle by hashing before it stops paying. */
const STALE_HASH_CAP = 512;

/**
 * How much each declaration kind is worth in a search ranking. A function or a method is
 * what someone searching for behaviour means; a file or a module is a container that
 * matches everything inside it and would otherwise crowd out its own contents.
 */
export const KIND_WEIGHT: Readonly<Record<NodeKind, number>> = Object.freeze({
  function: 1,
  method: 1,
  class: 0.85,
  interface: 0.85,
  struct: 0.85,
  trait: 0.85,
  enum: 0.8,
  type: 0.7,
  field: 0.55,
  test: 0.5,
  module: 0.15,
  file: 0.15,
});

/** Structural relations sort last in an explanation; they are context, not payload. */
const STRUCTURAL = new Set<EdgeRelation>(["contains", "defines"]);

// ---------------------------------------------------------------- symbol resolution

/** A symbol argument resolved against the graph. Exactly one of the three outcomes holds. */
export interface SymbolLookup {
  readonly query: string;
  /** The single symbol the argument named. */
  readonly node?: StoredNode;
  /** Several symbols answer to the argument; the caller must disambiguate. */
  readonly candidates: readonly StoredNode[];
  /** Nothing answered to it; the nearest full-text hits, so the next call can be right. */
  readonly suggestions: readonly StoredNode[];
}

/**
 * Resolve a symbol argument. The ladder is ordered by how much the caller told us: an
 * exact qualified name is unambiguous by construction, a bare name usually is, a dotted
 * tail narrows a name that is not, and case folding is the last resort.
 */
export function resolveSymbol(map: CodeMap, symbol: string): SymbolLookup {
  const query = typeof symbol === "string" ? symbol.trim() : "";
  if (query.length === 0) return { query, candidates: [], suggestions: [] };

  const exact = map.nodeByQn(query);
  if (exact) return { query, node: exact, candidates: [], suggestions: [] };

  // A path is the spelling a reader already has in hand — it is what every other tool in the
  // session takes — so it resolves to that file's own node, whose edges are exactly the
  // file's symbols and the modules it trades names with.
  const asPath = byPath(map, query);
  if (asPath) return asPath;

  const byName = map.nodesByName(query);
  if (byName.length === 1) return { query, node: byName[0]!, candidates: [], suggestions: [] };

  // `MapStore.searchFts` — a tail of the qualified name, at a dot boundary. SQLite's LIKE
  // folds ASCII case for free, so this pass covers the wrong-case spelling too; an
  // exact-case tail is preferred whenever one exists.
  const bySuffix = map.store.nodesByQnSuffix(query);
  const caseExact = bySuffix.filter((node) => node.qn === query || node.qn.endsWith(`.${query}`));
  const suffix = caseExact.length > 0 ? caseExact : bySuffix;
  if (suffix.length === 1) return { query, node: suffix[0]!, candidates: [], suggestions: [] };

  if (byName.length > 1) return { query, candidates: rankCandidates(byName), suggestions: [] };
  if (suffix.length > 1) return { query, candidates: rankCandidates(suffix), suggestions: [] };

  const folded = map.store.nodesByNameFold(query);
  if (folded.length === 1) return { query, node: folded[0]!, candidates: [], suggestions: [] };
  if (folded.length > 1) return { query, candidates: rankCandidates(folded), suggestions: [] };

  return { query, candidates: [], suggestions: nearest(map, query) };
}

/**
 * A file path resolved to its own node: repository-relative, absolute under the root, or any
 * unambiguous tail of one (`src/store.ts`). A tail that names several files answers with
 * them as candidates rather than picking one, exactly as an ambiguous symbol does.
 *
 * Only path-shaped arguments reach the store: a bare `store.ts` is left to the name ladder,
 * which already matches file nodes by their basename.
 */
function byPath(map: CodeMap, query: string): SymbolLookup | undefined {
  const posix = toPosix(query).replace(/\/+$/, "");
  const relative = posix.startsWith(`${toPosix(map.root)}/`) ? posix.slice(map.root.length + 1) : posix.replace(/^\.\//, "");
  if (!relative.includes("/") || relative.length === 0) return undefined;

  const node = map.nodeByQn(map.qnForPath(relative));
  if (node) return { query, node, candidates: [], suggestions: [] };

  const hits = map.store.filesWithSuffix(relative);
  if (hits.length === 0) return undefined;
  const nodes = hits.map((path) => map.nodeByQn(fileQn(path))).filter((found): found is StoredNode => found !== null);
  if (nodes.length === 1) return { query, node: nodes[0]!, candidates: [], suggestions: [] };
  if (nodes.length > 1) return { query, candidates: nodes, suggestions: [] };
  return undefined;
}

/**
 * The nearest symbols to a name that matched nothing.
 *
 * Full-text search is conjunctive over prefixes, so a single typo — `updateCloudClinet` —
 * matches nothing at all, and a "not found" with no suggestions teaches the caller nothing.
 * Falling back to the individual split terms recovers it: `update` and `cloud` still hit,
 * even though `clinet` never will.
 */
function nearest(map: CodeMap, query: string): StoredNode[] {
  const direct = map.searchFts(query, 5);
  if (direct.length > 0) return direct;
  const found = new Map<number, StoredNode>();
  for (const term of queryTerms(query)) {
    if (term.length < 3) continue;
    for (const hit of map.searchFts(term, 3)) if (!found.has(hit.id)) found.set(hit.id, hit);
  }
  return [...found.values()].sort((a, b) => weightOf(b) - weightOf(a) || a.qn.localeCompare(b.qn)).slice(0, 5);
}

/** Most-likely-meant first: real declarations before containers, then alphabetical. */
function rankCandidates(nodes: readonly StoredNode[]): StoredNode[] {
  return [...nodes].sort((a, b) => weightOf(b) - weightOf(a) || a.qn.localeCompare(b.qn));
}

function weightOf(node: StoredNode): number {
  return KIND_WEIGHT[node.kind] ?? 0.5;
}

// ---------------------------------------------------------------- verbs

export interface BudgetOptions {
  readonly budget?: number;
}

export interface SearchOptions extends BudgetOptions {
  readonly limit?: number;
}

export interface ImpactOptions extends BudgetOptions {
  readonly depth?: number;
}

/**
 * Rank symbols against a free-text query.
 *
 * Full-text search supplies the candidate pool and a bm25 score; that score alone is not a
 * ranking, because it treats `modules` (a field whose *path* happens to contain "resolve")
 * as comparable to `resolveModule` (a function whose name is the query). Two corrections
 * fix it:
 *
 * - **Structural weight** — {@link KIND_WEIGHT}. What is matched matters as much as how well.
 * - **Term coverage, squared** — a hit that accounts for every term in the query is worth
 *   far more than one that accounts for a single generic term. Squaring is what stops one
 *   common word from burying a multi-term match; halving coverage quarters the bonus.
 */
export function search(map: CodeMap, query: string, options: SearchOptions = {}): string {
  const budget = clampBudget(options.budget);
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 20)));
  const text = typeof query === "string" ? query.trim() : "";

  const head: ToonNode[] = [toonField("verb", "search"), toonField("query", text)];
  if (text.length === 0) {
    head.push(toonNote("empty query — pass one or more identifier terms"));
    return renderDocument({ head, sections: [], budget, stale: staleCount(map) });
  }

  const pool = map.searchFts(text, Math.min(400, limit * 8));
  const terms = queryTerms(text);
  const compact = text.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, "");
  const scored = pool
    .map((hit) => ({ hit, score: scoreHit(hit.qn, hit.name, hit.kind, -hit.rank, terms, compact, text) }))
    .sort((a, b) => b.score - a.score || a.hit.qn.localeCompare(b.hit.qn))
    .slice(0, limit);

  head.push(toonField("matches", scored.length));
  if (scored.length === 0) {
    head.push(toonNote("no symbol matched — try `vocabulary` for terms this graph actually contains"));
    return renderDocument({ head, sections: [], budget, stale: staleCount(map) });
  }

  const degrees = map.store.degreesFor(scored.map((entry) => entry.hit.id));
  head.push(toonNote(QN_RULE));
  const table = toonGroupedTable(
    "results",
    ["prefix", "file"],
    ["name", "kind", "lines", "in", "out"],
    scored,
    (entry) => [prefixOf(entry.hit.qn), entry.hit.file],
    (entry) => {
      const degree = degrees.get(entry.hit.id);
      return [entry.hit.name, entry.hit.kind, lineRange(entry.hit), degree?.in ?? 0, degree?.out ?? 0];
    },
  );

  return renderDocument({
    head,
    sections: [{ table, floor: 5 }],
    budget,
    hint: "more query terms or a smaller limit",
    stale: staleCount(map),
  });
}

/**
 * One symbol in full: what it is, where it is, and every relation into and out of it with
 * the site of that relation. The site is the point — `explain` answers "who calls this"
 * with a `file:line` a reader can open, not with a list of names to go hunting for.
 */
export function explain(map: CodeMap, symbol: string, options: BudgetOptions = {}): string {
  const budget = clampBudget(options.budget);
  const lookup = resolveSymbol(map, symbol);
  const head: ToonNode[] = [toonField("verb", "explain"), toonField("symbol", lookup.query)];
  const unresolved = unresolvedAnswer(head, lookup, budget, map);
  if (unresolved !== undefined) return unresolved;

  const node = lookup.node!;
  const inbound = map.edgesTo(node.id, { limit: EDGE_FETCH_CAP + 1 });
  const outbound = map.edgesFrom(node.id, { limit: EDGE_FETCH_CAP + 1 });

  head.push(
    toonField("qn", node.qn),
    toonField("kind", node.kind),
    toonField("at", `${node.file}:${node.start}-${node.end}`),
  );
  if (node.signature !== null) head.push(toonField("signature", node.signature));
  head.push(toonField("in", capped(inbound.length)), toonField("out", capped(outbound.length)));
  if (inbound.length > EDGE_FETCH_CAP || outbound.length > EDGE_FETCH_CAP) {
    head.push(toonNote(`edge list capped at ${EDGE_FETCH_CAP} per direction`));
  }

  const sections: Section[] = [];
  if (inbound.length > 0 || outbound.length > 0) head.push(toonNote(QN_RULE), toonNote(SITE_RULE));
  if (inbound.length > 0) sections.push({ table: edgeTable("inbound", inbound, "srcQn"), floor: 4 });
  if (outbound.length > 0) sections.push({ table: edgeTable("outbound", outbound, "dstQn"), floor: 4 });
  if (sections.length === 0) head.push(toonNote("no relations recorded for this symbol"));

  return renderDocument({ head, sections, budget, hint: "impact for callers only", stale: staleCount(map) });
}

/**
 * The reverse dependency closure — the operation `grep` cannot do at all.
 *
 * `grep` finds the name; it cannot find the caller of the caller, and it cannot tell a
 * definition from a use. This walks inbound {@link IMPACT_RELATIONS} to `depth` hops and
 * reports every symbol whose behaviour a change here could reach, each with the hop count
 * that found it and the site that connects it.
 */
export function impact(map: CodeMap, symbol: string, options: ImpactOptions = {}): string {
  const budget = clampBudget(options.budget);
  const depth = Math.min(6, Math.max(1, Math.floor(options.depth ?? 2)));
  const lookup = resolveSymbol(map, symbol);
  const head: ToonNode[] = [toonField("verb", "impact"), toonField("symbol", lookup.query)];
  const unresolved = unresolvedAnswer(head, lookup, budget, map);
  if (unresolved !== undefined) return unresolved;

  const node = lookup.node!;
  const walk = map.bfs(node.id, { depth, direction: "in", relations: IMPACT_RELATIONS, limit: 2000 });
  const depthOf = new Map(walk.nodes.map((reached) => [reached.id, reached.depth]));
  // The edge that reached a dependent points *from* it, into something one hop closer.
  const reachedBy = new Map<number, StoredEdge>();
  for (const edge of walk.edges) {
    const from = depthOf.get(edge.src);
    const into = depthOf.get(edge.dst);
    if (from === undefined || into === undefined || from !== into + 1) continue;
    if (!reachedBy.has(edge.src)) reachedBy.set(edge.src, edge);
  }

  const dependents = walk.nodes.filter((reached) => reached.depth > 0);
  const degrees = map.store.degreesFor(dependents.map((reached) => reached.id));
  const ordered = [...dependents].sort(
    (a, b) => a.depth - b.depth || totalDegree(degrees.get(b.id)) - totalDegree(degrees.get(a.id)) || a.qn.localeCompare(b.qn),
  );

  const perHop = new Map<number, number>();
  for (const reached of dependents) perHop.set(reached.depth, (perHop.get(reached.depth) ?? 0) + 1);

  head.push(
    toonField("qn", node.qn),
    toonField("at", `${node.file}:${node.start}-${node.end}`),
    toonField("depth", depth),
    toonField("dependents", dependents.length),
  );
  if (perHop.size > 0) {
    head.push(toonList("hops", [...perHop.keys()].sort((a, b) => a - b).map((hop) => `${hop}=${perHop.get(hop)}`)));
  }
  if (walk.truncated) head.push(toonNote("closure hit the traversal limit; counts are a lower bound"));
  if (dependents.length === 0) {
    head.push(toonNote("nothing depends on this symbol — it is a leaf, or its callers are unresolved"));
    return renderDocument({ head, sections: [], budget, stale: staleCount(map) });
  }

  // The hop is part of the group key, not just a column. That keeps every first-hop group
  // ahead of every second-hop group — hop order is the answer's meaning, and a factoring
  // that reordered it to keep a file together would trade the meaning for the compression.
  head.push(toonNote(QN_RULE), toonNote(SITE_RULE));
  const table = toonGroupedTable(
    "dependents",
    ["hop", "prefix", "file"],
    ["symbol", "relation", "line", "deg"],
    ordered,
    (reached) => [reached.depth, prefixOf(reached.qn), reachedBy.get(reached.id)?.file ?? reached.file],
    (reached) => {
      const edge = reachedBy.get(reached.id);
      return [tailOf(reached.qn), edge?.relation ?? "-", edge?.line ?? reached.start, totalDegree(degrees.get(reached.id))];
    },
  );

  return renderDocument({
    head,
    sections: [{ table, floor: 6 }],
    budget,
    hint: "depth=1",
    stale: staleCount(map),
  });
}

/**
 * The shortest directed chain of stored relations from one symbol to another.
 *
 * Every step names the relation and the site actually recorded in the index. When there is
 * no path the answer says so and shows what each end *is* connected to, because "no path"
 * plus two neighbourhoods is a usable answer and "no path" alone is a dead end.
 */
export function pathBetween(map: CodeMap, from: string, to: string, options: BudgetOptions = {}): string {
  const budget = clampBudget(options.budget);
  const head: ToonNode[] = [toonField("verb", "path")];
  const source = resolveSymbol(map, from);
  const target = resolveSymbol(map, to);
  head.push(toonField("from", source.query), toonField("to", target.query));

  for (const [label, lookup] of [["from", source], ["to", target]] as const) {
    if (lookup.node) continue;
    head.push(toonField("unresolved", label));
    return unresolvedAnswer(head, lookup, budget, map)!;
  }

  const start = source.node!;
  const goal = target.node!;
  head.push(toonField("from_qn", start.qn), toonField("to_qn", goal.qn));

  if (start.id === goal.id) {
    head.push(toonField("hops", 0), toonNote("from and to are the same symbol"));
    return renderDocument({ head, sections: [], budget, stale: staleCount(map) });
  }

  const chain = shortestPath(map, start.id, goal.id);
  if (chain === undefined) {
    head.push(toonField("path", "none"));
    head.push(toonNote(`no directed path within ${PATH_MAX_HOPS} hops over stored relations`));
    // Relations are directed and the caller may simply have named them in the wrong order.
    // Saying so costs one more traversal and turns a dead end into the answer.
    const reverse = shortestPath(map, goal.id, start.id);
    if (reverse !== undefined) {
      head.push(toonNote(`a path exists the other way (${reverse.length} hops) — swap from and to`));
    }
    const sections: Section[] = [];
    const out = map.edgesFrom(start.id, { relations: IMPACT_RELATIONS, limit: 20 });
    const into = map.edgesTo(goal.id, { relations: IMPACT_RELATIONS, limit: 20 });
    if (out.length > 0) {
      sections.push({
        table: toonFlatTable(
          "from_reaches",
          ["symbol", "relation", "at"],
          out.map((edge) => [edge.dstQn, edge.relation, site(edge)] satisfies ToonRow),
        ),
        floor: 3,
      });
    }
    if (into.length > 0) {
      sections.push({
        table: toonFlatTable(
          "to_reached_by",
          ["symbol", "relation", "at"],
          into.map((edge) => [edge.srcQn, edge.relation, site(edge)] satisfies ToonRow),
        ),
        floor: 3,
      });
    }
    if (sections.length === 0) head.push(toonNote("neither endpoint has any recorded relation"));
    return renderDocument({ head, sections, budget, hint: "a different pair", stale: staleCount(map) });
  }

  head.push(toonField("hops", chain.length));
  const table = toonFlatTable(
    "path",
    ["step", "from", "relation", "conf", "to", "at"],
    chain.map((edge, index) => [index + 1, edge.srcQn, edge.relation, edge.confidence, edge.dstQn, site(edge)] satisfies ToonRow),
  );
  return renderDocument({ head, sections: [{ table, floor: chain.length }], budget, stale: staleCount(map) });
}

/**
 * Where a symbol's source lives, for a caller that will read the file itself. The map
 * stores line ranges and never source text, so this returns coordinates and nothing else.
 * Ambiguity is handed back as candidates rather than resolved by a coin flip.
 */
export function snippetTarget(
  map: CodeMap,
  symbol: string,
): { file: string; start: number; end: number; qn: string } | { candidates: { qn: string; kind: string; file: string }[] } | undefined {
  const lookup = resolveSymbol(map, symbol);
  if (lookup.node) {
    const node = lookup.node;
    return { file: node.file, start: node.start, end: node.end, qn: node.qn };
  }
  if (lookup.candidates.length > 0) {
    return { candidates: lookup.candidates.map((node) => ({ qn: node.qn, kind: node.kind, file: node.file })) };
  }
  return undefined;
}

// ---------------------------------------------------------------- shared internals

/**
 * Files whose size or mtime no longer matches what was indexed. This is the cheap check —
 * it never walks for new files, so it can run on every verb. A caller that needs the exact
 * answer awaits `CodeMap.stale()`.
 *
 * A moved mtime over an unchanged size is the ambiguous case, and it is common: a checkout,
 * a formatter that rewrote a file byte-identically, a `touch`. Reporting it costs the reader
 * a warning about a file nothing happened to, so the content hash decides it — and when the
 * content proves identical the stored timestamp is healed on the spot. Without that, only a
 * *content* change ever rewrites a file row, so the same false alarm returns on every answer
 * for the rest of the session.
 */
export function staleCount(map: CodeMap): number {
  const files = map.store.allFiles();
  if (files.length > STALE_SCAN_CAP) return 0;
  let drifted = 0;
  let hashed = 0;
  const healed: FileRow[] = [];
  for (const row of files) {
    let info;
    try {
      info = statSync(resolve(map.root, row.path));
    } catch {
      drifted += 1;
      continue;
    }
    const mtimeMs = Math.round(info.mtimeMs);
    if (mtimeMs === row.mtimeMs && info.size === row.size) continue;
    if (info.size !== row.size || hashed >= STALE_HASH_CAP) {
      drifted += 1;
      continue;
    }
    hashed += 1;
    if (sameContent(map, row)) healed.push({ ...row, mtimeMs, size: info.size });
    else drifted += 1;
  }
  if (healed.length > 0) {
    try {
      map.store.transaction(() => {
        for (const row of healed) map.store.putFile(row);
      });
    } catch {
      // A read verb that cannot heal still answers; the count above is already correct.
    }
  }
  return drifted;
}

/** Whether a file's bytes still hash to what the index recorded. */
function sameContent(map: CodeMap, row: FileRow): boolean {
  try {
    return hashContent(readFileSync(resolve(map.root, row.path), "utf8")) === row.contentSha;
  } catch {
    return false;
  }
}

/** Renders the ambiguous / not-found answers shared by every symbol verb. */
function unresolvedAnswer(head: ToonNode[], lookup: SymbolLookup, budget: number, map: CodeMap): string | undefined {
  if (lookup.node) return undefined;
  if (lookup.query.length === 0) {
    head.push(toonNote("empty symbol — pass a qualified name, a bare name, or a dotted tail"));
    return renderDocument({ head, sections: [], budget, stale: staleCount(map) });
  }
  if (lookup.candidates.length > 0) {
    head.push(toonField("ambiguous", lookup.candidates.length), toonNote("re-run with one of these qualified names"));
    return renderDocument({
      head,
      sections: [
        {
          table: toonFlatTable(
            "candidates",
            ["qn", "kind", "file", "lines"],
            lookup.candidates.map((node) => [node.qn, node.kind, node.file, lineRange(node)] satisfies ToonRow),
          ),
          floor: 6,
        },
      ],
      budget,
      hint: "a longer dotted tail",
      stale: staleCount(map),
    });
  }
  head.push(toonField("found", 0));
  const sections: Section[] =
    lookup.suggestions.length === 0
      ? []
      : [
          {
            table: toonFlatTable(
              "did_you_mean",
              ["qn", "kind", "file"],
              lookup.suggestions.map((node) => [node.qn, node.kind, node.file] satisfies ToonRow),
            ),
            floor: 5,
          },
        ];
  if (sections.length === 0) head.push(toonNote("no symbol by that name — check `overview` for what this map covers"));
  return renderDocument({ head, sections, budget, stale: staleCount(map) });
}

/** Breadth-first over {@link PATH_RELATIONS}, returning the edges of one shortest chain. */
function shortestPath(map: CodeMap, start: number, goal: number): StoredEdge[] | undefined {
  const cameFrom = new Map<number, StoredEdge>();
  const seen = new Set<number>([start]);
  let frontier = [start];
  for (let hop = 0; hop < PATH_MAX_HOPS && frontier.length > 0; hop += 1) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const edge of map.edgesFrom(id, { relations: PATH_RELATIONS })) {
        if (seen.has(edge.dst)) continue;
        seen.add(edge.dst);
        cameFrom.set(edge.dst, edge);
        if (edge.dst === goal) return rebuild(cameFrom, start, goal);
        next.push(edge.dst);
        if (seen.size >= PATH_MAX_VISITS) return undefined;
      }
    }
    frontier = next;
  }
  return undefined;
}

function rebuild(cameFrom: ReadonlyMap<number, StoredEdge>, start: number, goal: number): StoredEdge[] {
  const chain: StoredEdge[] = [];
  let cursor = goal;
  while (cursor !== start) {
    const edge = cameFrom.get(cursor);
    if (!edge) break;
    chain.push(edge);
    cursor = edge.src;
  }
  return chain.reverse();
}

/**
 * One direction of an explanation, factored on `(prefix, site file)`.
 *
 * The other end's qualified name and the site's path both repeat heavily — every caller in
 * one file shares both — so they become the group key and the row keeps only the short name
 * and the line. The two reconstruction rules emitted with the table make the full qualified
 * name and the full `file:line` recoverable exactly, which is the whole point: a caller you
 * cannot jump to is trivia.
 */
function edgeTable(name: string, edges: readonly StoredEdge[], other: "srcQn" | "dstQn"): ToonTable {
  return toonGroupedTable(
    name,
    ["prefix", "file"],
    [other === "srcQn" ? "caller" : "callee", "relation", "conf", "context", "line"],
    sortEdges(edges, other).slice(0, EDGE_FETCH_CAP),
    (edge) => [prefixOf(edge[other]), edge.file],
    (edge) => [tailOf(edge[other]), edge.relation, edge.confidence, edge.context, edge.line],
  );
}

/** Meaningful relations before structural ones, then a total order so output never wobbles. */
function sortEdges(edges: readonly StoredEdge[], other: "srcQn" | "dstQn"): StoredEdge[] {
  return [...edges].sort(
    (a, b) =>
      Number(STRUCTURAL.has(a.relation)) - Number(STRUCTURAL.has(b.relation)) ||
      a.relation.localeCompare(b.relation) ||
      a[other].localeCompare(b[other]) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.id - b.id,
  );
}

function site(edge: StoredEdge): string {
  return `${edge.file}:${edge.line}`;
}

function lineRange(node: StoredNode): string {
  return `${node.start}-${node.end}`;
}

function prefixOf(qn: string): string {
  const cut = qn.lastIndexOf(".");
  return cut === -1 ? "" : qn.slice(0, cut);
}

function tailOf(qn: string): string {
  const cut = qn.lastIndexOf(".");
  return cut === -1 ? qn : qn.slice(cut + 1);
}

function totalDegree(degree: Degree | undefined): number {
  return degree === undefined ? 0 : degree.in + degree.out;
}

function capped(count: number): number {
  return Math.min(count, EDGE_FETCH_CAP);
}

/** The query's search terms, split the same way the index split the identifiers it stores. */
export function queryTerms(query: string): string[] {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const out = new Set<string>();
  for (const token of tokens) for (const word of splitIdentifier(token).split(" ")) if (word) out.add(word);
  return [...out];
}

/**
 * Score one hit. Exported for the ranking tests, which pin the three properties that make
 * the ranking useful: an exact name beats a prefix beats a substring; a function beats a
 * file; and coverage is squared so a one-term partial cannot outrank a full match.
 */
export function scoreHit(
  qn: string,
  name: string,
  kind: string,
  bm25: number,
  terms: readonly string[],
  compact: string,
  raw: string,
): number {
  const weight = KIND_WEIGHT[kind as NodeKind] ?? 0.5;
  const nameTerms = new Set(splitIdentifier(name).split(" "));
  let hits = 0;
  for (const term of terms) if (nameTerms.has(term)) hits += 1;
  const coverage = terms.length === 0 ? 0 : hits / terms.length;

  const lower = name.toLowerCase();
  const target = raw.toLowerCase();
  let tier = 0;
  if (lower === target || lower === compact) tier = 60;
  else if (raw.includes(".") && qn.toLowerCase().endsWith(`.${target}`)) tier = 60;
  else if (compact.length > 0 && lower.startsWith(compact)) tier = 25;
  else if (compact.length > 0 && lower.includes(compact)) tier = 10;

  return weight * (bm25 + (tier + 20 * coverage) * coverage * coverage);
}

/** Re-exported for the insight layer, which ranks hubs by the same structural weights. */
export type { Degree, DegreeNode };
