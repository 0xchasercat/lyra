/**
 * The insight layer — what the map says when nobody asked a question yet.
 *
 * {@link overview} is the session-start brief: in three or four kilobytes, what this
 * repository is made of, which parts talk to which, which symbols everything leans on,
 * which connections look wrong, and what to ask next. It is the answer to "I have just
 * been dropped into an unfamiliar codebase" — the situation where a search tool is useless
 * because you do not yet know what to search for.
 *
 * Three deliberate refusals shape it:
 *
 * - **No clustering library.** The directory tree already *is* the community structure of
 *   a real repository; developers put related code together, and a spectral clustering of
 *   the call graph mostly rediscovers the folders at great expense. Groups come from the
 *   workspace's own package manifests where they exist and from the directory partition
 *   where they do not.
 * - **No invented confidence.** Every uncertain thing the map knows about itself — inferred
 *   edges, unresolved names, import cycles — is surfaced as uncertainty, and the suggested
 *   questions are derived from exactly those weak spots rather than from a template.
 * - **No padding.** Every section disappears when it is empty. A heading with nothing under
 *   it spends the reader's attention to say nothing.
 */

import type { CodeMap } from "./incremental.ts";
import { familyOf, splitIdentifier } from "./qn.ts";
import { clampBudget, MIN_BUDGET, renderDocument, type Section } from "./render.ts";
import { staleCount } from "./query.ts";
import type { CrossEdge, DegreeNode } from "./store.ts";
import type { LanguageFamily } from "./types.ts";
import { toonField, toonFlatTable, toonList, toonNote, type ToonNode, type ToonRow } from "./toon.ts";

/**
 * Names whose degree is an artifact rather than a fact. These are language, runtime, and
 * trait-protocol names; when the resolver settles a bare `constructor` or `Default` on a
 * repository symbol by global-name guess, the resulting hub says nothing about the code.
 * Blocking them is cheaper and more honest than trying to score around them.
 */
const BUILTIN_NOISE = new Set(
  [
    "constructor", "toString", "valueOf", "dispose", "default", "new", "init", "main",
    "__init__", "__new__", "__str__", "__repr__", "__enter__", "__exit__",
    "Clone", "Copy", "Debug", "Default", "Display", "Drop", "Deref", "From", "Into",
    "Error", "String", "Object", "Array", "Promise", "Result", "Option", "Self",
  ].map((name) => name.toLowerCase()),
);

/** Basenames that conventionally mean "start here". */
const ENTRY_BASENAMES = new Set(["index", "main", "cli", "mod", "lib", "app", "__init__", "__main__", "server"]);

/**
 * Kinds that can never be a hub. All three are containers: their degree counts what they
 * hold, not what depends on them, and a test file's node in particular out-degrees every
 * real symbol in the repository while nothing whatsoever depends on it.
 */
const HUB_EXCLUDED_KINDS: readonly string[] = Object.freeze(["file", "module", "test"]);

/** How many hub candidates to pull before filtering noise, so the filter cannot empty the list. */
const HUB_POOL = 60;
/** Cross-file edges considered as surprise candidates. Inferred ones are ordered first. */
const SURPRISE_POOL = 4000;

/** One member of the repository partition — a workspace package, or a directory standing in for one. */
interface Group {
  label: string;
  readonly dir: string;
  readonly files: string[];
  /** The language families its files belong to. Resolution never crosses one, so this bounds its edges. */
  readonly families: Set<LanguageFamily>;
  symbols: number;
  out: number;
  in: number;
}

/**
 * The session-start brief. Sections appear in the order a reader needs them — what the
 * repository is, how it is divided, what it leans on, what looks wrong, where to start,
 * what to ask — and the budget fitter gives each one a floor so the last section is not
 * starved by the first.
 */
export function overview(map: CodeMap, options: { budget?: number } = {}): string {
  const budget = clampBudget(options.budget);
  const counts = map.stats();
  const head: ToonNode[] = [
    toonField("verb", "overview"),
    toonField("root", map.root),
    toonField("files", counts.files),
    toonField("nodes", counts.nodes),
    toonField("edges", counts.edges),
  ];

  const languages = map.store.languageCounts();
  if (languages.length > 0) head.push(toonList("languages", languages.map((row) => `${row.language}=${row.n}`)));
  const confidence = map.store.confidenceCounts();
  if (confidence.length > 0) head.push(toonList("confidence", confidence.map((row) => `${row.confidence}=${row.n}`)));
  if (counts.unresolved > 0) {
    head.push(toonField("unresolved", `${counts.unresolved} names, ${counts.dropped} sites dropped`));
  }

  if (counts.files === 0) {
    head.push(toonNote("nothing indexed yet — run an index pass first"));
    return renderDocument({ head, sections: [], budget });
  }

  const groups = partition(map);
  const byFile = new Map<string, Group>();
  for (const group of groups) for (const file of group.files) byFile.set(file, group);
  for (const row of map.store.nodeCountsByFile()) {
    const group = byFile.get(row.file);
    if (group) group.symbols += row.n;
  }
  for (const flow of map.store.fileFlow()) {
    const from = byFile.get(flow.srcFile);
    const into = byFile.get(flow.dstFile);
    if (!from || !into || from === into) continue;
    from.out += flow.n;
    into.in += flow.n;
  }

  // An island that is the repository's only Rust — or its only Python — is not a disconnected
  // subsystem: the resolver refuses to cross a language family at all, so those edges were
  // never eligible to exist. Saying so is the difference between a finding and a false alarm.
  const islands = languageIslands(groups);
  // The head is never trimmed, so at the floor budget this annotation would be spending the
  // reader's only rows on a caveat. Everywhere else it is worth its one line.
  if (islands.length > 0 && budget > MIN_BUDGET) {
    const named = islands.slice(0, 3).map((island) => `${island.label} (${[...island.families].sort().join("/")})`).join(", ");
    const more = islands.length > 3 ? ` +${islands.length - 3}` : "";
    head.push(toonNote(`islands by language: ${named}${more} — no cross-language edges by design, not a missing dependency`));
  }

  const hubs = godNodes(map);
  const surprises = surprising(map, byFile);
  const entries = entryPoints(map, byFile);
  const questions = suggestedQuestions(map, groups, hubs, islands);

  const sections: Section[] = [];
  if (groups.length > 1) {
    sections.push({
      table: toonFlatTable(
        "packages",
        ["name", "dir", "files", "symbols", "out", "in"],
        [...groups]
          .sort((a, b) => b.symbols - a.symbols || a.label.localeCompare(b.label))
          .map((group) => [group.label, group.dir === "" ? "." : group.dir, group.files.length, group.symbols, group.out, group.in] satisfies ToonRow),
      ),
      floor: 4,
    });
  }
  if (hubs.length > 0) {
    sections.push({
      table: toonFlatTable(
        "hubs",
        ["symbol", "kind", "at", "in", "out", "guessed"],
        hubs.map((hub) => [hub.qn, hub.kind, `${hub.file}:${hub.start}`, hub.in, hub.out, hub.inferred] satisfies ToonRow),
      ),
      floor: 4,
    });
  }
  if (questions.length > 0) {
    sections.push({ table: toonFlatTable("questions", ["verb", "argument", "why"], questions), floor: 4 });
  }
  if (surprises.length > 0) {
    sections.push({ table: toonFlatTable("surprises", ["from", "to", "relation", "at", "why"], surprises), floor: 3 });
  }
  if (entries.length > 0) {
    sections.push({ table: toonFlatTable("entry_points", ["file", "symbols", "used_by", "why"], entries), floor: 2 });
  }

  return renderDocument({
    head,
    sections,
    budget,
    hint: "a specific verb — explain, impact, search",
    stale: staleCount(map),
  });
}

/**
 * The graph's own token vocabulary: the split-identifier terms the full-text index actually
 * contains, most frequent first.
 *
 * This exists so query expansion can be *constrained*. A model asked to broaden `auth` will
 * happily try `authenticate`, `authorization`, `credentials` — and in a repository that
 * spells it `signin`, every one of those returns nothing and the model concludes the code
 * is absent. Handing it the real terms turns guessing into looking up.
 */
export function vocabulary(map: CodeMap, limit = 200): { term: string; count: number }[] {
  const totals = new Map<string, number>();
  for (const row of map.store.nameCounts()) {
    for (const term of splitIdentifier(row.name).split(" ")) {
      if (term.length === 0) continue;
      totals.set(term, (totals.get(term) ?? 0) + row.n);
    }
  }
  const cap = Math.max(1, Math.floor(limit));
  return [...totals.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, cap);
}

// ---------------------------------------------------------------- partition

/**
 * Divide the repository into groups. Workspace packages win when the walk found manifests;
 * otherwise the directory tree is the partition, descending one level at a time until it
 * actually divides something. A group whose directory has no name of its own is labelled
 * by its highest-degree member, because "." tells the reader nothing.
 */
function partition(map: CodeMap): Group[] {
  const rows = map.store.allFiles().map((row) => ({ path: row.path, family: familyOf(row.language) }));
  const files = rows.map((row) => row.path);
  const familyOfFile = new Map(rows.map((row) => [row.path, row.family]));
  const modules = [...map.store.modules().entries()]
    .filter(([, dir]) => dir.length > 0)
    .sort((a, b) => b[1].length - a[1].length);

  const groups = new Map<string, Group>();
  const claim = (dir: string, label: string): Group => {
    let group = groups.get(dir);
    if (!group) {
      group = { label, dir, files: [], families: new Set(), symbols: 0, out: 0, in: 0 };
      groups.set(dir, group);
    }
    return group;
  };
  const add = (group: Group, file: string): void => {
    group.files.push(file);
    const family = familyOfFile.get(file);
    if (family) group.families.add(family);
  };

  // A file no manifest claims — a Rust crate beside the TypeScript packages, say — is
  // grouped at the depth the manifests live at, so it lands beside them as its own
  // directory rather than collapsing into the shared `packages/` parent with all its peers.
  const leftoverDepth = modules.reduce((deepest, [, dir]) => Math.max(deepest, dir.split("/").length), 1);
  for (const file of files) {
    const module = modules.find(([, dir]) => file === dir || file.startsWith(`${dir}/`));
    if (module) add(claim(module[1], module[0]), file);
    else {
      const dir = segment(file, leftoverDepth);
      add(claim(dir, dir), file);
    }
  }

  for (let depth = 1; groups.size <= 1 && depth <= 3; depth += 1) {
    groups.clear();
    for (const file of files) add(claim(segment(file, depth), segment(file, depth)), file);
  }

  const out = [...groups.values()];
  for (const group of out) if (group.label.length === 0) group.label = nameByHub(map, group);
  return out;
}

/**
 * Partitions whose isolation is the language boundary rather than a missing dependency: they
 * have no cross-group edges at all, and no other partition shares a language family with them,
 * so no edge the resolver is willing to draw could ever have connected them. A repository's
 * only Rust crate beside its TypeScript packages is the canonical case.
 */
function languageIslands(groups: readonly Group[]): Group[] {
  if (groups.length < 2) return [];
  return groups.filter((group) => {
    if (group.files.length === 0 || group.out + group.in > 0 || group.families.size === 0) return false;
    return groups.every((other) => other === group || ![...other.families].some((family) => group.families.has(family)));
  });
}

/** The directory `path` sits in, truncated to `depth` segments. `""` for a repository-root file. */
function segment(path: string, depth: number): string {
  const parts = path.split("/");
  return parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
}

/** An unnamed directory borrows the name of the biggest thing in it. */
function nameByHub(map: CodeMap, group: Group): string {
  const owned = new Set(group.files);
  for (const hub of map.store.topDegree(HUB_POOL, HUB_EXCLUDED_KINDS)) {
    if (owned.has(hub.file)) return hub.name;
  }
  return group.files[0] ?? "(root)";
}

// ---------------------------------------------------------------- sections

/**
 * Top-degree symbols with containers and resolver noise removed, re-ranked so that inbound
 * degree dominates. A "god node" is something the rest of the repository *leans on*; a
 * function that calls two hundred things is a long function, not a hub, and the two are not
 * equally worth knowing about on arrival. Inbound therefore counts triple.
 */
function godNodes(map: CodeMap): DegreeNode[] {
  return map.store
    .topDegree(HUB_POOL, HUB_EXCLUDED_KINDS)
    .filter((hub) => hub.in + hub.out > 0 && !BUILTIN_NOISE.has(hub.name.toLowerCase()))
    .sort((a, b) => b.in * 3 + b.out - (a.in * 3 + a.out) || a.qn.localeCompare(b.qn))
    .slice(0, 12);
}

/**
 * Connections worth a second look, scored as a product of three independent oddities:
 * the edge is a guess rather than a proof, it crosses a package boundary, and it runs from
 * something peripheral into something central. Any one alone is ordinary. All three at once
 * is usually either the most interesting dependency in the repository or a resolver mistake,
 * and both are worth the reader's time — so each row carries the reason it was picked.
 */
function surprising(map: CodeMap, byFile: ReadonlyMap<string, Group>): ToonRow[] {
  const candidates = map.store.crossFileEdges(SURPRISE_POOL);
  if (candidates.length === 0) return [];
  const ids = new Set<number>();
  for (const edge of candidates) {
    ids.add(edge.srcId);
    ids.add(edge.dstId);
  }
  const degrees = map.store.degreesFor([...ids]);
  const degreeOf = (id: number): number => {
    const degree = degrees.get(id);
    return degree === undefined ? 0 : degree.in + degree.out;
  };

  const scored: { edge: CrossEdge; score: number; why: string }[] = [];
  for (const edge of candidates) {
    const from = byFile.get(edge.srcFile);
    const into = byFile.get(edge.dstFile);
    const crossed = from !== undefined && into !== undefined && from !== into;
    const srcDegree = degreeOf(edge.srcId);
    const dstDegree = degreeOf(edge.dstId);
    const guess = edge.confidence === "inferred" ? 1 : 0.3;
    const boundary = crossed ? 1 : 0.25;
    const pull = Math.log2(2 + dstDegree) / Math.log2(2 + srcDegree);
    const score = guess * boundary * pull;
    if (score <= 0) continue;
    const reasons = [
      edge.confidence === "inferred" ? "guessed by global name" : "extracted",
      crossed ? `crosses ${from!.label} -> ${into!.label}` : "same package",
      `degree ${srcDegree} -> ${dstDegree}`,
    ];
    scored.push({ edge, score, why: reasons.join("; ") });
  }

  // One row per destination, keeping its best-scoring approach. Five different callers
  // guessing their way into the same hub is one finding repeated five times, and a brief
  // that spends half its surprise section on it has crowded out four other findings.
  const seen = new Set<string>();
  const rows: ToonRow[] = [];
  for (const { edge, why } of scored.sort((a, b) => b.score - a.score || a.edge.id - b.edge.id)) {
    if (seen.has(edge.dstQn)) continue;
    seen.add(edge.dstQn);
    rows.push([edge.srcQn, edge.dstQn, edge.relation, `${edge.file}:${edge.line}`, why]);
    if (rows.length >= 8) break;
  }
  return rows;
}

/**
 * Where to start reading. Two independent signals: a conventional entry basename, and a
 * file that nothing else in the graph points into — a root of the dependency forest.
 */
function entryPoints(map: CodeMap, byFile: ReadonlyMap<string, Group>): ToonRow[] {
  const usedBy = new Map<string, number>();
  const uses = new Map<string, number>();
  for (const flow of map.store.fileFlow()) {
    usedBy.set(flow.dstFile, (usedBy.get(flow.dstFile) ?? 0) + flow.n);
    uses.set(flow.srcFile, (uses.get(flow.srcFile) ?? 0) + flow.n);
  }
  const symbols = new Map(map.store.nodeCountsByFile().map((row) => [row.file, row.n]));

  const rows: { row: ToonRow; rank: number; file: string }[] = [];
  for (const file of byFile.keys()) {
    const base = (file.split("/").pop() ?? "").replace(/\.[^.]+$/, "").toLowerCase();
    const named = ENTRY_BASENAMES.has(base) || file.split("/").includes("bin");
    const root = (usedBy.get(file) ?? 0) === 0 && (uses.get(file) ?? 0) > 0;
    if (!named && !root) continue;
    const why = named && root ? "conventional name; nothing imports it" : named ? "conventional name" : "nothing imports it";
    rows.push({
      row: [file, symbols.get(file) ?? 0, usedBy.get(file) ?? 0, why],
      rank: (named ? 2 : 0) + (root ? 1 : 0),
      file,
    });
  }
  return rows
    .sort((a, b) => b.rank - a.rank || (symbols.get(b.file) ?? 0) - (symbols.get(a.file) ?? 0) || a.file.localeCompare(b.file))
    .slice(0, 8)
    .map((entry) => entry.row);
}

/**
 * Questions derived from the graph's own uncertainty rather than from a template. Each row
 * is a verb and an argument the reader can pass straight back to the tool, plus the measured
 * reason it is worth asking.
 */
function suggestedQuestions(
  map: CodeMap,
  groups: readonly Group[],
  hubs: readonly DegreeNode[],
  islands: readonly Group[] = [],
): ToonRow[] {
  const rows: ToonRow[] = [];

  for (const hub of hubs) {
    if (hub.in < 3 || hub.inferred * 3 < hub.in) continue;
    rows.push(["explain", hub.qn, `${hub.inferred} of ${hub.in} inbound edges are guesses, not proofs`]);
    if (rows.length >= 3) break;
  }

  for (const cycle of map.store.mutualImports(3)) {
    rows.push(["pathBetween", `${map.qnForPath(cycle.a)} -> ${map.qnForPath(cycle.b)}`, "these two files import each other"]);
  }

  if (groups.length > 1) {
    // A language island is already explained in the head; asking about it here would be
    // inviting the reader to investigate a boundary the map drew on purpose.
    const explained = new Set(islands);
    for (const group of [...groups].sort((a, b) => b.files.length - a.files.length)) {
      if (group.out + group.in > 0 || group.files.length === 0 || explained.has(group)) continue;
      rows.push(["search", group.label, `${group.label} has no edges to the rest of the graph — dead, or only reached dynamically?`]);
      break;
    }
  }

  for (const name of map.store.unresolvedTop(3)) {
    const total = name.dropped + name.inferred;
    if (total === 0) continue;
    rows.push(["search", name.name, `mentioned ${total} times in ${name.files} files without a resolved definition`]);
  }

  return rows.slice(0, 10);
}
