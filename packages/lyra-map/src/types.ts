/**
 * The vocabulary of the code map. Everything the extractor emits, the resolver
 * consumes, and the store persists is described here, so wave 2 can build query
 * verbs against a single stable set of names.
 */

/** Every symbol granularity the map records. `test` marks a test file's node, never a symbol. */
export type NodeKind =
  | "file"
  | "module"
  | "class"
  | "interface"
  | "struct"
  | "enum"
  | "trait"
  | "type"
  | "function"
  | "method"
  | "field"
  | "test";

export const NODE_KINDS: readonly NodeKind[] = Object.freeze([
  "file", "module", "class", "interface", "struct", "enum", "trait", "type", "function", "method", "field", "test",
]);

/**
 * Edge relations.
 *
 * - `contains` — lexical parenthood: file → top-level symbol, class → method/field.
 * - `defines`  — the flat index: file node → every symbol declared anywhere in it.
 * - `calls` / `references` — a use site inside the source symbol.
 * - `imports` — file → imported module's file node (whole-module import).
 * - `imports_from` — file → the specific imported symbol.
 * - `re_exports` — file → symbol or file forwarded by `export … from`.
 * - `extends` / `implements` / `inherits` — declared type hierarchy.
 */
export type EdgeRelation =
  | "contains"
  | "defines"
  | "calls"
  | "references"
  | "imports"
  | "imports_from"
  | "re_exports"
  | "extends"
  | "implements"
  | "inherits";

export const EDGE_RELATIONS: readonly EdgeRelation[] = Object.freeze([
  "contains", "defines", "calls", "references", "imports", "imports_from", "re_exports", "extends", "implements", "inherits",
]);

/** Why the reference exists at the site. `null` for structural edges (contains/defines). */
export type EdgeContext =
  | "call"
  | "import"
  | "parameter_type"
  | "return_type"
  | "generic_arg"
  | "field"
  | "export";

export const EDGE_CONTEXTS: readonly EdgeContext[] = Object.freeze([
  "call", "import", "parameter_type", "return_type", "generic_arg", "field", "export",
]);

/**
 * `extracted` — the edge is backed by syntax in the file (same-file resolution or an
 * explicit import that names the target's module). `inferred` — the target was chosen
 * by a unique global name match; it is a guess, and callers may filter it out.
 */
export type Confidence = "extracted" | "inferred";

/** Languages the extractor parses. JavaScript rides the TypeScript grammar. */
export type MapLanguage = "typescript" | "tsx" | "javascript" | "python" | "rust" | "go";

/**
 * Resolution never crosses a family boundary: a TypeScript name can never resolve
 * into a Rust symbol, however unique that name is globally.
 */
export type LanguageFamily = "js" | "python" | "rust" | "go";

/** A symbol as the extractor produces it: line ranges and one signature line, never source text. */
export interface MapNode {
  /** Globally unique dotted name rooted at the repository, case preserved. */
  readonly qn: string;
  readonly name: string;
  readonly kind: NodeKind;
  /** Repository-relative POSIX path. */
  readonly file: string;
  /** 1-based inclusive line range. */
  readonly start: number;
  readonly end: number;
  /** One collapsed line — the declaration head, without the body. */
  readonly signature: string | null;
}

/** A stored symbol, with the row id the store assigns and keeps stable across re-indexing. */
export interface StoredNode extends MapNode {
  readonly id: number;
}

/** An edge in qualified-name space; the store translates both ends to row ids. */
export interface MapEdge {
  readonly src: string;
  readonly dst: string;
  readonly relation: EdgeRelation;
  readonly context: EdgeContext | null;
  readonly confidence: Confidence;
  /** The file holding the relation SITE — the call or import line, never the target's definition. */
  readonly file: string;
  readonly line: number;
}

/** A stored edge, both ends resolved to row ids, with the endpoints' qualified names joined in. */
export interface StoredEdge {
  readonly id: number;
  readonly src: number;
  readonly dst: number;
  readonly srcQn: string;
  readonly dstQn: string;
  readonly relation: EdgeRelation;
  readonly context: EdgeContext | null;
  readonly confidence: Confidence;
  readonly file: string;
  readonly line: number;
}

/** One name pulled in by an import statement. */
export interface ImportedName {
  /** The name as written in the exporting module. `*` for a namespace import. */
  readonly imported: string;
  /** The name as bound locally; equal to `imported` unless aliased. */
  readonly local: string;
}

/** An import or re-export statement, exactly as written. Module resolution happens later. */
export interface ImportFact {
  /** The specifier as written: `./mod.ts`, `@lyra/core`, `crate::foo`, `example.com/x/y`. */
  readonly specifier: string;
  readonly names: readonly ImportedName[];
  /** `import` binds names locally; `re_export` forwards them onward. */
  readonly kind: "import" | "re_export";
  readonly line: number;
}

/**
 * A reference the extractor could not settle inside its own file. The resolver turns
 * these into edges — or drops them and remembers the name.
 */
export interface RawReference {
  /** Qualified name of the enclosing symbol (or the file node) that holds the site. */
  readonly from: string;
  /** The referenced base name, as written. */
  readonly name: string;
  readonly relation: EdgeRelation;
  readonly context: EdgeContext | null;
  /** Narrows candidate kinds: a `call` site prefers callables, a `type` site prefers types. */
  readonly hint: "call" | "type" | "value";
  /**
   * The name belongs to the language, its standard library, or its test runner. The
   * resolver still tries import evidence — a project may legitimately export `create` —
   * but never guesses at one globally, and never records it as unresolved.
   */
  readonly builtin: boolean;
  readonly file: string;
  readonly line: number;
}

/** The complete, pure result of parsing one file. */
export interface ExtractedFile {
  readonly path: string;
  readonly language: MapLanguage;
  readonly family: LanguageFamily;
  readonly contentSha: string;
  /** Hash of the exported surface only: names, kinds, signatures — order-normalized, position-free. */
  readonly surfaceSha: string;
  readonly nodes: readonly MapNode[];
  /** Edges settled without leaving the file: contains, defines, and same-file uses. */
  readonly edges: readonly MapEdge[];
  readonly imports: readonly ImportFact[];
  readonly references: readonly RawReference[];
  /** Base names this file exports, for surface hashing and add-driven re-resolution. */
  readonly exports: readonly string[];
  /** Non-fatal notes: parse errors recovered from, collisions disambiguated. */
  readonly notes: readonly string[];
}

/** What a write did. Every counter is exact, not an estimate. */
export interface IndexStats {
  readonly files: number;
  readonly nodes: number;
  readonly edges: number;
  /** Files skipped by size, binary content, or generated-file heuristics. */
  readonly skipped: number;
  /** Files whose parse failed outright; their previous rows are left untouched. */
  readonly failed: number;
  /** References the resolver refused to guess at. */
  readonly dropped: number;
  readonly elapsedMs: number;
}

/** What an incremental pass did, including the blast radius it computed. */
export interface UpdateStats extends IndexStats {
  /** Files re-extracted because their content changed. */
  readonly changed: number;
  /** Files whose stored content already matched — no work done. */
  readonly unchanged: number;
  readonly removed: number;
  /** Files re-resolved because a file they point into changed its surface. */
  readonly reresolved: number;
  /** Files whose bytes changed but whose exported surface did not. */
  readonly bodyOnly: number;
}

/** Files on disk that no longer agree with the index. */
export interface StaleReport {
  readonly changed: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/** One full-text hit, ranked by bm25 (lower is better). */
export interface FtsHit extends StoredNode {
  readonly rank: number;
}

/** One node reached by {@link CodeMap.bfs}, with the hop count that reached it. */
export interface BfsNode extends StoredNode {
  readonly depth: number;
}

/** A breadth-first neighbourhood: the nodes reached and the edges that reached them. */
export interface BfsResult {
  readonly nodes: readonly BfsNode[];
  readonly edges: readonly StoredEdge[];
  /** True when the traversal stopped at the node limit rather than at the depth limit. */
  readonly truncated: boolean;
}
