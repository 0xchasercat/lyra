/**
 * `@lyra/map` — Lyra's native code graph.
 *
 * A symbol-granular SQLite index of a repository: one row per declaration, one row per
 * relation, no vectors, no embeddings, no source text. It is built to stay correct under
 * incremental updates rather than to be rebuilt when it drifts.
 *
 * Wave 1 is the data layer. {@link CodeMap} is the surface wave 2 builds query verbs on:
 * `open` / `index` / `update` / `remove` / `stale` / `close` for lifecycle, and
 * `nodeByQn` / `nodesByName` / `nodesInFile` / `edgesFrom` / `edgesTo` / `searchFts` / `bfs`
 * as the raw primitives.
 */

export { CodeMap, NodeCollapseError, providedNames } from "./incremental.ts";
export type { CodeMapOptions, IndexOptions, StaleOptions } from "./incremental.ts";

export { MapStore, SCHEMA_VERSION, toFtsQuery } from "./store.ts";
export type { BfsOptions, CrossEdge, Degree, DegreeNode, EdgeQueryOptions, FileRow, Mention } from "./store.ts";

// ---------------------------------------------------------------- wave 2: the query verbs
//
// Everything below answers in TOON, never JSON, and never exceeds its character budget.
// This is the surface the `map` tool is built on.

export {
  explain,
  impact,
  IMPACT_RELATIONS,
  KIND_WEIGHT,
  pathBetween,
  queryTerms,
  resolveSymbol,
  scoreHit,
  search,
  snippetTarget,
  staleCount,
} from "./query.ts";
export type { BudgetOptions, ImpactOptions, SearchOptions, SymbolLookup } from "./query.ts";

export { overview, vocabulary } from "./insight.ts";

export { clampBudget, renderDocument, DEFAULT_BUDGET, MAX_BUDGET, MIN_BUDGET } from "./render.ts";
export type { DocumentInput, Section } from "./render.ts";

export {
  emitToon,
  toonField,
  toonFlatTable,
  toonGroupedTable,
  toonGroupHeader,
  toonLines,
  toonList,
  toonNeedsQuote,
  toonNote,
  toonRow,
  toonScalar,
  toonTableHeader,
  toonTableSize,
  QN_RULE,
  SITE_RULE,
  TOON_EMPTY,
  TOON_INDENT,
} from "./toon.ts";
export type { ToonField, ToonGroup, ToonList, ToonNode, ToonRow, ToonScalar, ToonTable } from "./toon.ts";

export { extractFile, extractWithLanguage, dedupeEdges } from "./extract.ts";

export { resolveFile, resolveModule, ResolveCache, joinPath } from "./resolve.ts";
export type { ResolveInput, ResolveResult, ResolverStore } from "./resolve.ts";

export {
  EXCLUDED_DIRECTORIES,
  MAX_FILE_BYTES,
  generatedReason,
  globRegex,
  ignoreRules,
  isIgnored,
  readIndexable,
  walkRepository,
} from "./walk.ts";
export type { SkipReason, SourceRead, WalkResult } from "./walk.ts";

export {
  childQn,
  familyOf,
  fileQn,
  isTestPath,
  languageOf,
  languagesInFamily,
  oneLine,
  splitIdentifier,
  stripExtension,
  toPosix,
} from "./qn.ts";

export { languageConfig, parserFor } from "./languages.ts";
export type { Declaration, HeritageSite, LanguageConfig, RefSite } from "./languages.ts";

export * from "./types.ts";
