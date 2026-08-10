import { childQn, familyOf, fileQn, languageOf, stripExtension } from "./qn.ts";
import type { Mention } from "./store.ts";
import type { ExtractedFile, ImportFact, LanguageFamily, MapEdge, RawReference, StoredNode } from "./types.ts";

/** Everything the resolver needs from an extraction; the node list is not part of it. */
export type ResolveInput = Pick<ExtractedFile, "path" | "language" | "imports" | "references">;

/** Above this many same-named candidates, proximity is guessing rather than inferring. */
const MAX_GLOBAL_CANDIDATES = 8;

/** A package import can legitimately pull in a whole directory; bound the fan-out anyway. */
const MAX_MODULE_FILES = 32;

/** Barrel files chain; three hops covers `index -> group -> module` without looping forever. */
const MAX_REEXPORT_HOPS = 3;

/** The read-only view of the index the resolver needs. {@link MapStore} satisfies it. */
export interface ResolverStore {
  hasFile(path: string): boolean;
  /** Files directly inside `dir` — no recursion. */
  filesInDir(dir: string): string[];
  /** Files whose path equals `suffix` or ends with `/suffix`. */
  filesWithSuffix(suffix: string): string[];
  /** Files whose immediate directory equals `suffix` or ends with `/suffix`. */
  filesInDirSuffix(suffix: string): string[];
  nodesNamedInFiles(name: string, files: readonly string[]): StoredNode[];
  /** Specifiers through which a file forwards `name` (including its `export *` sources). */
  reexportsFor(file: string, name: string): string[];
  nodesByName(name: string, family?: LanguageFamily): StoredNode[];
  /** Workspace package name → directory, harvested from package.json. */
  modules(): Map<string, string>;
}

export interface ResolveResult {
  readonly edges: MapEdge[];
  /**
   * Names this file mentioned whose target is not pinned by syntax — dropped outright, or
   * guessed from a unique global name. Both must be revisited when a definition appears or
   * disappears elsewhere, which is exactly what the `unresolved` table indexes.
   */
  readonly unresolved: Map<string, Mention>;
  readonly dropped: number;
}

/** Per-pass memo so a hundred files importing the same module resolve it once. */
export class ResolveCache {
  readonly modules = new Map<string, readonly string[]>();
  readonly packages = new Map<string, string>();
}

const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_REWRITES: readonly (readonly [string, readonly string[]])[] = [
  [".js", [".ts", ".tsx", ".js"]],
  [".jsx", [".tsx", ".jsx"]],
  [".mjs", [".mts", ".mjs"]],
  [".cjs", [".cts", ".cjs"]],
];

/**
 * Turn one file's imports and raw reference facts into edges.
 *
 * Three rules, applied in order, and never a fourth:
 *
 * 1. **Import evidence.** The file imports `X` from module `M`, and `M` — resolved to a
 *    real indexed path — defines `X`. The syntax proves the target, so the edge is
 *    `extracted`.
 * 2. **Unique global name, same language family.** Exactly one symbol in the whole index
 *    carries the name, or several do and one is strictly closer in the directory tree
 *    than every other. The edge is `inferred`, and callers may discard it wholesale.
 * 3. **Drop.** Nothing is written. The name is recorded in `unresolved` so that the day a
 *    file starts exporting it, this file is re-resolved without a repository rescan.
 *
 * A TypeScript name never resolves into a Rust symbol: candidates are confined to the
 * referring file's language family before any of this begins.
 */
export function resolveFile(extracted: ResolveInput, store: ResolverStore, cache = new ResolveCache()): ResolveResult {
  const edges: MapEdge[] = [];
  const unresolved = new Map<string, Mention>();
  const root = fileQn(extracted.path);
  let dropped = 0;

  const note = (name: string, field: keyof Mention): void => {
    const current = unresolved.get(name) ?? { dropped: 0, inferred: 0 };
    unresolved.set(name, { ...current, [field]: current[field] + 1 });
  };
  const drop = (name: string): void => {
    dropped += 1;
    note(name, "dropped");
  };

  // -------------------------------------------------------------- import evidence

  /** local binding → the module it came from and the name it has there. */
  const evidence = new Map<string, { readonly files: readonly string[]; readonly imported: string }>();
  /** Modules pulled in wholesale (`import *`, a Go package, `import os`): any name may come from them. */
  const wholesale: string[] = [];

  for (const fact of extracted.imports) {
    const files = resolveModule(fact.specifier, extracted, store, cache);
    edges.push(...importEdges(fact, files, extracted, root, store, cache, drop));
    if (files.length === 0) {
      // Only in-repo specifiers are remembered. A missing `node:fs` will never appear;
      // a missing `./widget.ts` might be created in the next commit.
      if (repoLocalSpecifier(fact.specifier, extracted.language, store, cache)) {
        for (const name of fact.names) if (name.imported !== "*") drop(name.imported);
        const tail = moduleTail(fact.specifier);
        if (tail) drop(tail);
      }
      continue;
    }
    for (const name of fact.names) {
      if (name.imported === "*") wholesale.push(...files);
      else evidence.set(name.local, { files, imported: name.imported });
    }
  }

  // -------------------------------------------------------------- reference facts

  const wholesaleFiles = [...new Set(wholesale)];
  for (const reference of extracted.references) {
    const target = resolveReference(reference, extracted, evidence, wholesaleFiles, store, cache);
    if (!target) {
      // A language builtin that no import claimed is not a hole in the graph; it is simply
      // not part of the repository, and recording it would bloat the re-resolution index.
      if (!reference.builtin) drop(reference.name);
      continue;
    }
    if (target.confidence === "inferred") note(reference.name, "inferred");
    edges.push({
      src: reference.from,
      dst: target.node.qn,
      relation: reference.relation,
      context: reference.context,
      confidence: target.confidence,
      file: extracted.path,
      line: reference.line,
    });
  }

  return { edges, unresolved, dropped };
}

function importEdges(
  fact: ImportFact,
  files: readonly string[],
  extracted: ResolveInput,
  root: string,
  store: ResolverStore,
  cache: ResolveCache,
  drop: (name: string) => void,
): MapEdge[] {
  const edges: MapEdge[] = [];
  const relation = fact.kind === "re_export" ? "re_exports" : "imports";
  const context = fact.kind === "re_export" ? "export" : "import";
  for (const name of fact.names) {
    if (name.imported === "*" || name.imported === "default") {
      for (const file of files) {
        edges.push({ src: root, dst: fileQn(file), relation, context, confidence: "extracted", file: extracted.path, line: fact.line });
      }
      continue;
    }
    const hit = bestInModule(name.imported, files, store, cache);
    if (hit) {
      edges.push({
        src: root,
        dst: hit.qn,
        relation: fact.kind === "re_export" ? "re_exports" : "imports_from",
        context,
        confidence: "extracted",
        file: extracted.path,
        line: fact.line,
      });
      continue;
    }
    // The module exists but does not define the name here — most often it forwards it on.
    // Record the module edge so the dependency is not lost, and remember the missing name.
    for (const file of files) {
      edges.push({ src: root, dst: fileQn(file), relation, context, confidence: "extracted", file: extracted.path, line: fact.line });
    }
    if (files.length > 0) drop(name.imported);
  }
  return edges;
}

function resolveReference(
  reference: RawReference,
  extracted: ResolveInput,
  evidence: ReadonlyMap<string, { readonly files: readonly string[]; readonly imported: string }>,
  wholesale: readonly string[],
  store: ResolverStore,
  cache: ResolveCache,
): { node: StoredNode; confidence: "extracted" | "inferred" } | undefined {
  const direct = evidence.get(reference.name);
  if (direct) {
    const hit = bestInModule(direct.imported, direct.files, store, cache);
    if (hit) return { node: hit, confidence: "extracted" };
  }
  if (wholesale.length > 0) {
    const hit = bestInModule(reference.name, wholesale, store, cache);
    if (hit) return { node: hit, confidence: "extracted" };
  }
  // No import proved it and the language owns the name: guessing globally would attach
  // every `map` call in the repository to whichever project symbol happens to be unique.
  if (reference.builtin) return undefined;

  const family = familyOf(extracted.language);
  const all = store.nodesByName(reference.name, family).filter((node) => node.file !== extracted.path && node.kind !== "file" && node.kind !== "test");
  if (all.length === 0 || all.length > MAX_GLOBAL_CANDIDATES) return undefined;
  const preferred = all.filter((node) => KIND_PREFERENCE[reference.hint].has(node.kind));
  const candidates = preferred.length > 0 ? preferred : all;
  if (candidates.length === 1) return { node: candidates[0]!, confidence: "inferred" };

  const scored = candidates
    .map((node) => ({ node, score: sharedPrefix(extracted.path, node.file) }))
    .sort((a, b) => b.score - a.score || a.node.qn.localeCompare(b.node.qn));
  const best = scored[0]!;
  const runnerUp = scored[1]!;
  // A tie means the map would be inventing a fact. Say nothing instead.
  return best.score > runnerUp.score ? { node: best.node, confidence: "inferred" } : undefined;
}

const KIND_PREFERENCE: Readonly<Record<RawReference["hint"], ReadonlySet<StoredNode["kind"]>>> = Object.freeze({
  call: new Set<StoredNode["kind"]>(["function", "method", "class", "struct", "type", "interface"]),
  type: new Set<StoredNode["kind"]>(["class", "interface", "struct", "enum", "trait", "type"]),
  value: new Set<StoredNode["kind"]>(["field", "function", "class", "struct", "enum", "type"]),
});

/**
 * Find `name` inside a module, following `export … from` barrels up to
 * {@link MAX_REEXPORT_HOPS} hops. The forwarding facts come from their own table rather
 * than from edges, so the answer never depends on which file this pass resolved first.
 *
 * Prefers a module's own top-level definition over anything nested inside it.
 */
function bestInModule(
  name: string,
  files: readonly string[],
  store: ResolverStore,
  cache = new ResolveCache(),
  hops = MAX_REEXPORT_HOPS,
  visited = new Set<string>(),
): StoredNode | undefined {
  if (files.length === 0) return undefined;
  const candidates = store.nodesNamedInFiles(name, files);
  if (candidates.length > 0) {
    const topLevel = candidates.filter((node) => node.qn === childQn(fileQn(node.file), name));
    const pool = topLevel.length > 0 ? topLevel : candidates;
    return [...pool].sort((a, b) => a.qn.length - b.qn.length || a.qn.localeCompare(b.qn))[0];
  }
  if (hops <= 0) return undefined;
  for (const file of [...files].sort()) {
    if (visited.has(file)) continue;
    visited.add(file);
    const language = languageOf(file);
    if (!language) continue;
    for (const specifier of store.reexportsFor(file, name)) {
      const forwarded = resolveModule(specifier, { path: file, language }, store, cache);
      const hit = bestInModule(name, forwarded, store, cache, hops - 1, visited);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Directory segments shared by two paths — the proximity used to break name ties. */
function sharedPrefix(a: string, b: string): number {
  const left = a.split("/").slice(0, -1);
  const right = b.split("/").slice(0, -1);
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared += 1;
  return shared;
}

/** Whether an unresolvable specifier names something the repository could plausibly grow. */
function repoLocalSpecifier(specifier: string, language: ResolveInput["language"], store: ResolverStore, cache: ResolveCache): boolean {
  switch (familyOf(language)) {
    case "js":
      return specifier.startsWith(".") || packageDirectory(specifier, store, cache) !== undefined;
    case "python":
      return specifier.startsWith(".");
    case "rust": {
      const first = specifier.split("::")[0];
      return first === "crate" || first === "self" || first === "super";
    }
    case "go":
      return false;
  }
}

/**
 * The module name an importer effectively wrote — `./later.ts` and `./later` and
 * `pkg.later` all name `later`. It matches what a newly added file reports as one of its
 * provided names, so a specifier that resolves to nothing today is re-checked when that
 * file appears.
 */
function moduleTail(specifier: string): string | undefined {
  return stripExtension(specifier)
    .split(/[/.:]+/)
    .filter((part) => part.length > 0 && part !== "." && part !== "..")
    .pop();
}

// ---------------------------------------------------------------- module resolution

/**
 * Map an import specifier onto indexed file paths. Resolution is pure database work —
 * nothing is stat-ed — so a specifier resolves identically whether it is reached during a
 * full index or an incremental pass.
 */
export function resolveModule(
  specifier: string,
  extracted: Pick<ResolveInput, "path" | "language">,
  store: ResolverStore,
  cache = new ResolveCache(),
): readonly string[] {
  const key = `${extracted.language} ${extracted.path} ${specifier}`;
  const cached = cache.modules.get(key);
  if (cached) return cached;
  const resolved = resolveModuleUncached(specifier, extracted, store, cache).slice(0, MAX_MODULE_FILES);
  cache.modules.set(key, resolved);
  return resolved;
}

function resolveModuleUncached(
  specifier: string,
  extracted: Pick<ResolveInput, "path" | "language">,
  store: ResolverStore,
  cache: ResolveCache,
): string[] {
  const family = familyOf(extracted.language);
  const directory = dirOf(extracted.path);
  switch (family) {
    case "js":
      return resolveJs(specifier, directory, store, cache);
    case "python":
      return resolvePython(specifier, directory, store);
    case "rust":
      return resolveRust(specifier, extracted.path, store);
    case "go":
      return resolveGo(specifier, store);
  }
}

function resolveJs(specifier: string, directory: string, store: ResolverStore, cache: ResolveCache): string[] {
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return [];
  if (specifier.startsWith(".")) return jsCandidates(joinPath(directory, specifier), store);
  if (specifier.startsWith("/")) return [];
  const dir = packageDirectory(specifier, store, cache);
  if (dir === undefined) return [];
  const subpath = packageSubpath(specifier);
  if (subpath) return jsCandidates(joinPath(dir, subpath), store);
  // No subpath: the package entry, else every source file the package owns at its root.
  const entry = jsCandidates(joinPath(dir, "src/index"), store);
  if (entry.length > 0) return entry;
  const index = jsCandidates(joinPath(dir, "index"), store);
  return index.length > 0 ? index : store.filesInDir(joinPath(dir, "src"));
}

function jsCandidates(base: string, store: ResolverStore): string[] {
  const rewrite = JS_REWRITES.find(([extension]) => base.toLowerCase().endsWith(extension));
  if (rewrite) {
    const stem = base.slice(0, base.length - rewrite[0].length);
    for (const extension of rewrite[1]) if (store.hasFile(stem + extension)) return [stem + extension];
  }
  if (store.hasFile(base)) return [base];
  for (const extension of JS_EXTENSIONS) if (store.hasFile(base + extension)) return [base + extension];
  for (const extension of JS_EXTENSIONS) if (store.hasFile(`${base}/index${extension}`)) return [`${base}/index${extension}`];
  return [];
}

/** Longest workspace package name that prefixes the specifier. */
function packageDirectory(specifier: string, store: ResolverStore, cache: ResolveCache): string | undefined {
  const cached = cache.packages.get(specifier);
  if (cached !== undefined) return cached.length > 0 ? cached : undefined;
  let best: { name: string; dir: string } | undefined;
  for (const [name, dir] of store.modules()) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    if (!best || name.length > best.name.length) best = { name, dir };
  }
  cache.packages.set(specifier, best?.dir ?? "");
  return best?.dir;
}

function packageSubpath(specifier: string): string | undefined {
  const parts = specifier.split("/");
  const skip = specifier.startsWith("@") ? 2 : 1;
  return parts.length > skip ? parts.slice(skip).join("/") : undefined;
}

function resolvePython(specifier: string, directory: string, store: ResolverStore): string[] {
  const leadingDots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  if (leadingDots > 0) {
    let base = directory;
    for (let i = 1; i < leadingDots; i += 1) base = dirOf(base);
    const rest = specifier.slice(leadingDots).split(".").filter(Boolean).join("/");
    return pythonCandidates(rest ? joinPath(base, rest) : base, store, false);
  }
  return pythonCandidates(specifier.split(".").filter(Boolean).join("/"), store, true);
}

function pythonCandidates(base: string, store: ResolverStore, bySuffix: boolean): string[] {
  const exact = [`${base}.py`, `${base}/__init__.py`, `${base}.pyi`];
  for (const candidate of exact) if (store.hasFile(candidate)) return [candidate];
  if (!bySuffix) return [];
  for (const candidate of exact) {
    const hits = store.filesWithSuffix(candidate);
    if (hits.length === 1) return hits;
    // Several roots define the same dotted module: refuse to pick, resolution falls through.
    if (hits.length > 1) return [];
  }
  return [];
}

function resolveRust(specifier: string, path: string, store: ResolverStore): string[] {
  const segments = specifier.split("::").filter(Boolean);
  if (segments.length === 0) return [];
  const first = segments[0]!;
  const rest = segments.slice(1);
  if (first === "std" || first === "core" || first === "alloc") return [];

  if (first === "crate") return rustCandidates(crateRoot(path), rest, store);
  if (first === "self") return rustCandidates(moduleDirectory(path), rest, store);
  if (first === "super") {
    let base = moduleDirectory(path);
    let index = 0;
    while (segments[index] === "super") {
      base = dirOf(base);
      index += 1;
    }
    return rustCandidates(base, segments.slice(index), store);
  }
  // A sibling module of this file, then anywhere in the index by path suffix.
  const local = rustCandidates(dirOf(path), segments, store);
  if (local.length > 0) return local;
  const joined = segments.join("/");
  for (const candidate of [`${joined}.rs`, `${joined}/mod.rs`]) {
    const hits = store.filesWithSuffix(candidate);
    if (hits.length === 1) return hits;
    if (hits.length > 1) return [];
  }
  return [];
}

/** The `src` directory that owns this file, which is where `crate::` starts. */
function crateRoot(path: string): string {
  const segments = path.split("/");
  const index = segments.lastIndexOf("src");
  return index >= 0 ? segments.slice(0, index + 1).join("/") : dirOf(path);
}

/**
 * The directory a Rust file's own module owns: `a/b/mod.rs` is module `a::b`, so its
 * directory is `a/b`, while `a/b/foo.rs` is module `a::b::foo`, whose children live in
 * `a/b/foo`. `super` is then one `dirname` away in both cases.
 */
function moduleDirectory(path: string): string {
  const base = path.split("/").pop() ?? path;
  if (base === "mod.rs" || base === "lib.rs" || base === "main.rs") return dirOf(path);
  return path.endsWith(".rs") ? path.slice(0, -3) : dirOf(path);
}

function rustCandidates(base: string, segments: readonly string[], store: ResolverStore): string[] {
  if (segments.length === 0) {
    for (const candidate of [`${base}/mod.rs`, `${base}/lib.rs`]) if (store.hasFile(candidate)) return [candidate];
    return [];
  }
  const joined = segments.join("/");
  for (const candidate of [joinPath(base, `${joined}.rs`), joinPath(base, `${joined}/mod.rs`)]) {
    if (store.hasFile(candidate)) return [candidate];
  }
  // `use crate::foo::Bar` where Bar is an item, not a module.
  if (segments.length > 1) {
    const parent = segments.slice(0, -1).join("/");
    for (const candidate of [joinPath(base, `${parent}.rs`), joinPath(base, `${parent}/mod.rs`)]) {
      if (store.hasFile(candidate)) return [candidate];
    }
  }
  return [];
}

function resolveGo(specifier: string, store: ResolverStore): string[] {
  const segments = specifier.split("/").filter(Boolean);
  // Trailing segments of the import path name a directory in the repository.
  for (let take = Math.min(segments.length, 4); take >= 1; take -= 1) {
    const suffix = segments.slice(segments.length - take).join("/");
    const exact = store.filesInDir(suffix).filter((file) => file.endsWith(".go"));
    if (exact.length > 0) return exact;
    const nested = store.filesInDirSuffix(suffix).filter((file) => file.endsWith(".go"));
    if (nested.length > 0) return nested;
  }
  return [];
}

// ---------------------------------------------------------------- path helpers

function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "" : path.slice(0, cut);
}

/** POSIX join that collapses `.` and `..` without touching the filesystem. */
export function joinPath(base: string, relative: string): string {
  const segments = base.length > 0 ? base.split("/") : [];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}
