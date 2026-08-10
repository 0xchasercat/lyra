import { hashContent } from "@lyra/edit";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { extractFile } from "./extract.ts";
import { fileQn, toPosix } from "./qn.ts";
import { ResolveCache, resolveFile } from "./resolve.ts";
import { MapStore, type BfsOptions, type EdgeQueryOptions, type FileRow, type Mention } from "./store.ts";
import { readIndexable, walkRepository, MAX_FILE_BYTES } from "./walk.ts";
import type {
  BfsResult,
  ExtractedFile,
  FtsHit,
  IndexStats,
  LanguageFamily,
  StaleReport,
  StoredEdge,
  StoredNode,
  UpdateStats,
} from "./types.ts";

/** Refuses a write that would delete symbols belonging to files nobody touched. */
export class NodeCollapseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeCollapseError";
  }
}

export interface CodeMapOptions {
  /** Repository root. Every stored path is relative to it. */
  readonly root: string;
  /** Database location; defaults to `<root>/.lyra/map.db`, alongside checkpoints and sessions. */
  readonly path?: string;
  readonly maxFileBytes?: number;
}

export interface IndexOptions {
  /**
   * Skip the magnitude guard. Only pass this when a repository really did shrink — the
   * guard exists because a broken ignore rule looks exactly like a deleted repository.
   */
  readonly force?: boolean;
}

export interface StaleOptions {
  /** Hash every file instead of trusting mtime and size. Slower, and never wrong. */
  readonly hash?: boolean;
}

interface Pass {
  readonly extracted: Map<string, ExtractedFile>;
  readonly meta: Map<string, { mtimeMs: number; size: number }>;
  readonly changed: Set<string>;
  readonly surfaceChanged: Set<string>;
  readonly removed: Set<string>;
  readonly toResolve: Set<string>;
  skipped: number;
  failed: number;
  unchanged: number;
}

/**
 * A symbol-granular code graph over a repository, kept correct incrementally.
 *
 * ## The incremental argument
 *
 * Extraction is a pure function of `(path, content)`. A file's own rows therefore depend
 * on nothing but its bytes, and re-extracting it after an edit reproduces exactly what a
 * full rebuild would write.
 *
 * Everything else is about the edges one file's content *cannot* determine alone. A file
 * `A`'s cross-file edges can only change when:
 *
 * 1. `A` itself changed — `A` is re-extracted and re-resolved;
 * 2. a file `A` already points into changed the symbols it offers or disappeared — found
 *    through `edges(dst)`, the reverse index, in one indexed query;
 * 3. a name `A` mentioned without a syntactic proof (dropped, or settled by a global-name
 *    guess) became available, or ambiguous, somewhere new — found through the `unresolved`
 *    table, again as a lookup rather than a rescan.
 *
 * Nothing else can move an edge, so re-resolving exactly `{A} ∪ (2) ∪ (3)` is sufficient.
 * Row ids survive re-extraction — a symbol keeps its id as long as its qualified name
 * survives — so a body-only edit provably cannot cascade away the inbound edges of
 * unrelated files. That is the failure both studied tools exhibit, and the reason
 * `incremental.test.ts` asserts a byte-identical graph across repeated no-op edits.
 */
export class CodeMap {
  readonly root: string;
  /** The persistence layer. Wave 2 may reach through it; the primitives below are the contract. */
  readonly store: MapStore;
  readonly #maxFileBytes: number;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: CodeMapOptions) {
    if (typeof options?.root !== "string" || options.root.length === 0) {
      throw new TypeError("Code map root must be a non-empty string");
    }
    this.root = resolve(options.root);
    this.#maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.store = new MapStore(options.path ?? resolve(this.root, ".lyra", "map.db"));
    this.store.metaSet("root", this.root);
  }

  static open(options: CodeMapOptions): CodeMap {
    return new CodeMap(options);
  }

  // ---------------------------------------------------------------- writes

  /**
   * Index the whole repository: a gitignore-correct walk, then the same incremental pass
   * every other write uses. Re-running it on an up-to-date index is a cheap no-op — files
   * whose content hash still matches are never re-parsed.
   */
  index(options: IndexOptions = {}): Promise<IndexStats> {
    return this.#serial(async () => {
      const started = Bun.nanoseconds();
      const walk = await walkRepository(this.root);
      const existing = this.store.counts();
      if (!options.force && existing.files > 0 && walk.files.length === 0) {
        throw new NodeCollapseError(
          `Refusing to index: the walk found no source files while ${existing.files} are indexed. Pass force to accept it.`,
        );
      }
      if (!options.force && existing.files >= 8 && walk.files.length * 2 < existing.files) {
        throw new NodeCollapseError(
          `Refusing to index: the walk found ${walk.files.length} files, less than half of the ${existing.files} indexed. Pass force to accept it.`,
        );
      }
      this.store.transaction(() => {
        this.store.clearModules();
        for (const [name, dir] of walk.packages) this.store.putModule(name, dir);
      });

      const walked = new Set(walk.files);
      const gone = this.store.allFiles().map((row) => row.path).filter((path) => !walked.has(path));
      const stats = await this.#apply([...walk.files, ...gone], new Set(gone));
      return { ...stats, elapsedMs: Math.round((Bun.nanoseconds() - started) / 1e6) };
    });
  }

  /**
   * Re-index the given paths and everything whose edges they could have moved. Paths may be
   * absolute or repository-relative; a path that no longer exists on disk is treated as a
   * removal.
   */
  update(paths: readonly string[]): Promise<UpdateStats> {
    return this.#serial(() => this.#apply(this.#normalize(paths), new Set()));
  }

  /** Drop the given paths from the index, whatever is on disk, and repair what pointed into them. */
  remove(paths: readonly string[]): Promise<UpdateStats> {
    const normalized = this.#normalize(paths);
    return this.#serial(() => this.#apply(normalized, new Set(normalized)));
  }

  // ---------------------------------------------------------------- reads

  /**
   * Files on disk that disagree with the index. `mtime` and `size` are trusted as a first
   * filter and the content hash decides, so an out-of-band edit that preserved the mtime is
   * still caught whenever the size moved — and always, with `{ hash: true }`.
   */
  stale(options: StaleOptions = {}): Promise<StaleReport> {
    return this.#serial(async () => {
      const walk = await walkRepository(this.root);
      const known = new Map(this.store.allFiles().map((row) => [row.path, row]));
      const added: string[] = [];
      const changed: string[] = [];
      for (const path of walk.files) {
        const row = known.get(path);
        if (!row) {
          added.push(path);
          continue;
        }
        known.delete(path);
        let info;
        try {
          info = await stat(resolve(this.root, path));
        } catch {
          continue;
        }
        if (!options.hash && Math.round(info.mtimeMs) === row.mtimeMs && info.size === row.size) continue;
        const source = await readIndexable(this.root, path, this.#maxFileBytes);
        if (!source.ok) continue;
        // Hash directly: deciding whether a file moved never needs it parsed.
        if (hashContent(source.content) !== row.contentSha) changed.push(path);
      }
      return { added, changed, removed: [...known.keys()].sort() };
    });
  }

  /** Row counts, exactly as stored. */
  stats(): { files: number; nodes: number; edges: number; unresolved: number; dropped: number } {
    return this.store.counts();
  }

  // ---------------------------------------------------------------- raw query primitives

  /** One symbol by its globally unique dotted name. Wave 2's entry point for a known target. */
  nodeByQn(qn: string): StoredNode | null {
    return this.store.nodeByQn(qn);
  }

  /** Every symbol with an exact name, optionally confined to one language family. */
  nodesByName(name: string, family?: LanguageFamily): StoredNode[] {
    return this.store.nodesByName(name, family);
  }

  /** Every symbol declared in one file, in source order. */
  nodesInFile(path: string): StoredNode[] {
    return this.store.nodesInFile(toPosix(path));
  }

  /** Outgoing edges — what this symbol uses. `file`/`line` on each edge is the use site. */
  edgesFrom(node: string | number, options?: EdgeQueryOptions): StoredEdge[] {
    return this.store.edgesFrom(node, options);
  }

  /** Incoming edges — what uses this symbol. Backed by the `edges(dst)` reverse index. */
  edgesTo(node: string | number, options?: EdgeQueryOptions): StoredEdge[] {
    return this.store.edgesTo(node, options);
  }

  /** Full-text search over split identifiers, qualified names, and paths. */
  searchFts(query: string, limit?: number): FtsHit[] {
    return this.store.searchFts(query, limit);
  }

  /** Deterministic breadth-first neighbourhood around one symbol. */
  bfs(start: string | number, options?: BfsOptions): BfsResult {
    return this.store.bfs(start, options);
  }

  /** The qualified name a repository-relative path maps to. */
  qnForPath(path: string): string {
    return fileQn(toPosix(path));
  }

  /**
   * Release the database. Writes already in flight are not waited for — await the promise
   * from the last `index`/`update`/`remove` before closing.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.store.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // ---------------------------------------------------------------- internals

  /**
   * One writer at a time. Two `update` calls racing would interleave their read phase with
   * each other's write phase and resolve against a half-written node table.
   */
  #serial<T>(body: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Code map is closed"));
    const next = this.#queue.then(body, body);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #normalize(paths: readonly string[]): string[] {
    const out = new Set<string>();
    for (const raw of paths) {
      if (typeof raw !== "string" || raw.length === 0) continue;
      const absolute = isAbsolute(raw) ? resolve(raw) : resolve(this.root, raw);
      const relativePath = toPosix(relative(this.root, absolute));
      if (relativePath.length === 0 || relativePath.startsWith("..")) continue;
      out.add(relativePath);
    }
    return [...out].sort();
  }

  /**
   * The one write path. Phase 1 reads and parses without touching the database; phase 2
   * grows the working set through the reverse index and the unresolved table until it stops
   * growing; phase 3 writes everything in a single transaction.
   */
  async #apply(paths: readonly string[], forceRemove: ReadonlySet<string>): Promise<UpdateStats> {
    const started = Bun.nanoseconds();
    const pass: Pass = {
      extracted: new Map(),
      meta: new Map(),
      changed: new Set(),
      surfaceChanged: new Set(),
      removed: new Set(),
      toResolve: new Set(),
      skipped: 0,
      failed: 0,
      unchanged: 0,
    };

    for (const path of paths) await this.#ingest(path, pass, forceRemove.has(path));
    await this.#expand(pass);

    let reresolved = 0;
    for (const path of pass.toResolve) if (!pass.changed.has(path)) reresolved += 1;

    const touched = [...new Set([...pass.changed, ...pass.removed])];
    const before = this.store.nodesOutside(touched);
    let dropped = 0;

    this.store.transaction(() => {
      for (const path of pass.removed) this.store.deleteFile(path);
      const indexedAt = new Date().toISOString();
      for (const path of pass.changed) {
        const extracted = pass.extracted.get(path);
        const meta = pass.meta.get(path);
        if (!extracted || !meta) continue;
        this.store.writeFileNodes(path, extracted.nodes);
        // Forwarding facts land with the nodes, before anything resolves, so a barrel file
        // is followable no matter which file this pass happens to reach first.
        this.store.replaceReexports(
          path,
          extracted.imports
            .filter((fact) => fact.kind === "re_export")
            .flatMap((fact) => fact.names.map((name) => ({ imported: name.imported, specifier: fact.specifier }))),
        );
        const row: FileRow = {
          path,
          contentSha: extracted.contentSha,
          surfaceSha: extracted.surfaceSha,
          language: extracted.language,
          indexedAt,
          mtimeMs: meta.mtimeMs,
          size: meta.size,
        };
        this.store.putFile(row);
      }

      // Every symbol that vanished must belong to a file this pass rewrote or removed.
      // Anything else means a delete escaped its file, and the write is refused whole.
      const after = this.store.nodesOutside(touched);
      if (after !== before) {
        throw new NodeCollapseError(
          `Refusing the write: ${before - after} symbols outside the ${touched.length} touched files disappeared.`,
        );
      }

      const cache = new ResolveCache();
      for (const path of pass.toResolve) {
        const extracted = pass.extracted.get(path);
        if (!extracted) continue;
        const resolved = resolveFile(extracted, this.store, cache);
        const all = [...extracted.edges, ...resolved.edges];
        this.store.replaceEdges(path, all);
        this.store.replaceUnresolved(path, resolved.unresolved as ReadonlyMap<string, Mention>);
        dropped += resolved.dropped;
      }
    });

    const counts = this.store.counts();
    return {
      files: counts.files,
      nodes: counts.nodes,
      edges: counts.edges,
      skipped: pass.skipped,
      failed: pass.failed,
      dropped,
      changed: pass.changed.size,
      unchanged: pass.unchanged,
      removed: pass.removed.size,
      reresolved,
      bodyOnly: pass.changed.size - pass.surfaceChanged.size,
      elapsedMs: Math.round((Bun.nanoseconds() - started) / 1e6),
    } satisfies UpdateStats;
  }

  /** Read and classify one path. Never writes; may be called again for the same path safely. */
  async #ingest(path: string, pass: Pass, forceRemove: boolean): Promise<boolean> {
    if (pass.extracted.has(path) || pass.removed.has(path)) return false;
    const stored = this.store.fileRow(path);
    if (forceRemove) {
      if (stored) pass.removed.add(path);
      return stored !== null;
    }
    const source = await readIndexable(this.root, path, this.#maxFileBytes);
    if (!source.ok) {
      if (source.reason !== "missing" && source.reason !== "unsupported") pass.skipped += 1;
      // A file that became unreadable, oversized, or generated leaves the index; keeping a
      // stale copy would be worse than an honest absence.
      if (stored) pass.removed.add(path);
      return stored !== null;
    }
    let extracted: ExtractedFile;
    try {
      extracted = extractFile(path, source.content);
    } catch {
      pass.failed += 1;
      return false;
    }
    pass.extracted.set(path, extracted);
    pass.meta.set(path, { mtimeMs: source.mtimeMs, size: source.size });
    if (!stored || stored.contentSha !== extracted.contentSha) {
      pass.changed.add(path);
      pass.toResolve.add(path);
      if (!stored || stored.surfaceSha !== extracted.surfaceSha) pass.surfaceChanged.add(path);
      return true;
    }
    pass.unchanged += 1;
    return false;
  }

  /**
   * Grow the working set to a fixpoint. Both queries run against the pre-write graph, which
   * is why the whole read phase happens before any delete: once a symbol's row is gone, so
   * are the inbound edges that would have named its dependents.
   */
  async #expand(pass: Pass): Promise<void> {
    let frontier = [...new Set([...pass.surfaceChanged, ...pass.removed])];
    while (frontier.length > 0) {
      const names = new Set<string>();
      for (const path of frontier) {
        const extracted = pass.extracted.get(path);
        if (extracted) for (const name of providedNames(extracted)) names.add(name);
      }
      const candidates = new Set([...this.store.dependentsOf(frontier), ...this.store.filesMentioning([...names])]);
      const next: string[] = [];
      for (const path of [...candidates].sort()) {
        if (pass.removed.has(path) || pass.toResolve.has(path)) continue;
        const grew = await this.#ingest(path, pass, false);
        if (pass.removed.has(path)) {
          next.push(path);
          continue;
        }
        if (!pass.extracted.has(path)) continue;
        pass.toResolve.add(path);
        // A dependent that also changed on disk widens the blast radius in its own right.
        if (grew && pass.surfaceChanged.has(path)) next.push(path);
      }
      frontier = next;
    }
    for (const path of pass.removed) pass.toResolve.delete(path);
  }
}

/**
 * Names a file offers the rest of the repository: its exported symbols, and the module name
 * an importer would write. An `index`/`mod`/`__init__` file also stands for its directory.
 */
export function providedNames(extracted: ExtractedFile): string[] {
  const names = new Set(extracted.exports);
  const segments = extracted.path.split("/");
  const base = (segments.pop() ?? "").replace(/\.[^.]+$/, "");
  if (base) names.add(base);
  if (base === "index" || base === "mod" || base === "__init__" || base === "lib") {
    const directory = segments.pop();
    if (directory) names.add(directory);
  }
  return [...names];
}
