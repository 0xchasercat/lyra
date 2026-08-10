import { Database } from "bun:sqlite";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { languagesInFamily, splitIdentifier } from "./qn.ts";
import type {
  BfsNode,
  BfsResult,
  Confidence,
  EdgeContext,
  EdgeRelation,
  FtsHit,
  LanguageFamily,
  MapEdge,
  MapLanguage,
  MapNode,
  StoredEdge,
  StoredNode,
} from "./types.ts";

/**
 * Bumping this drops every table and rebuilds from scratch on the next open. The
 * index is a cache of the working tree, so a rebuild is always safe and always
 * cheaper than migration code nobody will exercise.
 */
export const SCHEMA_VERSION = 1;

/** How often a name was mentioned in a file without a syntactic proof of its target. */
export interface Mention {
  /** Sites that resolved to nothing at all. */
  readonly dropped: number;
  /** Sites settled by a global-name guess, which a new definition elsewhere could change. */
  readonly inferred: number;
}

/** A row of the `files` table. */
export interface FileRow {
  readonly path: string;
  readonly contentSha: string;
  readonly surfaceSha: string;
  readonly language: MapLanguage;
  readonly indexedAt: string;
  readonly mtimeMs: number;
  readonly size: number;
}

/** Edge counts around one symbol. Structural relations are excluded — see {@link MapStore.degreesFor}. */
export interface Degree {
  in: number;
  out: number;
  /** How many of those edges are a global-name guess rather than a syntactic proof. */
  inferred: number;
}

/** A symbol with its degree already joined in, as {@link MapStore.topDegree} returns it. */
export interface DegreeNode extends StoredNode {
  readonly in: number;
  readonly out: number;
  /** Inbound edges that are guesses — the measure of how much of a hub's pull is uncertain. */
  readonly inferred: number;
}

/** One non-structural edge whose endpoints live in different files. */
export interface CrossEdge {
  readonly id: number;
  readonly srcId: number;
  readonly dstId: number;
  readonly srcQn: string;
  readonly dstQn: string;
  readonly srcFile: string;
  readonly dstFile: string;
  readonly relation: EdgeRelation;
  readonly confidence: Confidence;
  /** The file holding the relation site. */
  readonly file: string;
  readonly line: number;
}

export interface EdgeQueryOptions {
  readonly relations?: readonly EdgeRelation[];
  readonly confidence?: Confidence;
  readonly limit?: number;
}

export interface BfsOptions {
  readonly depth?: number;
  readonly direction?: "out" | "in" | "both";
  readonly relations?: readonly EdgeRelation[];
  readonly limit?: number;
}

interface NodeRowRaw {
  id: number;
  qn: string;
  name: string;
  kind: string;
  file: string;
  start: number;
  end: number;
  signature: string | null;
}

interface EdgeRowRaw {
  id: number;
  src: number;
  dst: number;
  srcQn: string;
  dstQn: string;
  relation: string;
  context: string | null;
  confidence: string;
  file: string;
  line: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  content_sha TEXT NOT NULL,
  surface_sha TEXT NOT NULL,
  language    TEXT NOT NULL,
  indexed_at  TEXT NOT NULL,
  mtime_ms    INTEGER NOT NULL DEFAULT 0,
  size        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nodes (
  id        INTEGER PRIMARY KEY,
  qn        TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  file      TEXT NOT NULL,
  "start"   INTEGER NOT NULL,
  "end"     INTEGER NOT NULL,
  signature TEXT
);
CREATE INDEX IF NOT EXISTS nodes_file ON nodes(file);
CREATE INDEX IF NOT EXISTS nodes_name ON nodes(name);

CREATE TABLE IF NOT EXISTS edges (
  id         INTEGER PRIMARY KEY,
  src        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  relation   TEXT NOT NULL,
  context    TEXT,
  confidence TEXT NOT NULL,
  file       TEXT NOT NULL,
  line       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS edges_file ON edges(file);
-- No unique index on the full edge tuple: it cost a fifth of the database to enforce
-- something the writer already guarantees. Every edge whose site is in a file is written
-- by exactly one replaceEdges call, which de-duplicates in memory before it inserts.

-- Names whose resolution is not pinned by syntax: dropped outright, or settled only by a
-- global-name guess. Both are fragile in the same way — a new definition elsewhere can
-- change the answer — so both are remembered here. This turns "a new export appeared, who
-- might have wanted it?" from a repository rescan into an indexed lookup.
CREATE TABLE IF NOT EXISTS unresolved (
  file     TEXT NOT NULL,
  name     TEXT NOT NULL,
  dropped  INTEGER NOT NULL DEFAULT 0,
  inferred INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (file, name)
);
CREATE INDEX IF NOT EXISTS unresolved_name ON unresolved(name);

-- "export ... from" facts, written in the same phase as nodes so that resolution can
-- follow a barrel file without depending on which file happened to be resolved first.
CREATE TABLE IF NOT EXISTS reexports (
  file      TEXT NOT NULL,
  imported  TEXT NOT NULL,
  specifier TEXT NOT NULL,
  PRIMARY KEY (file, imported, specifier)
);

-- Workspace package name -> directory, harvested from package.json during the walk so
-- a bare specifier like "@lyra/core" is import evidence rather than a global guess.
CREATE TABLE IF NOT EXISTS modules (
  name TEXT PRIMARY KEY,
  dir  TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name_split,
  qn,
  path,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

/**
 * The persistence layer. Every write is a prepared statement; every multi-row write
 * runs inside a transaction the caller opens. The store never parses and never reads
 * the filesystem — it only stores what the extractor and resolver hand it.
 */
export class MapStore {
  readonly path: string;
  readonly #db: Database;
  #closed = false;
  /** qn → id, warm across a whole write pass so edge writing never re-queries. */
  readonly #ids = new Map<string, number>();

  constructor(inputPath: string) {
    if (typeof inputPath !== "string" || inputPath.length === 0) {
      throw new TypeError("Code map path must be a non-empty string");
    }
    this.path = inputPath === ":memory:" ? inputPath : resolve(inputPath);
    if (this.path !== ":memory:") {
      const directory = dirname(this.path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      closeSync(openSync(this.path, "a", 0o600));
      chmodSync(this.path, 0o600);
    }
    this.#db = new Database(this.path, { create: true, strict: true });
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    const version = this.#db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version !== 0 && version !== SCHEMA_VERSION) this.#dropEverything();
    this.#db.exec(SCHEMA);
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    this.#secure();
  }

  static open(path: string): MapStore {
    return new MapStore(path);
  }

  /** Run `body` in one transaction; the id cache is dropped if it rolls back. */
  transaction<T>(body: () => T): T {
    this.#assertOpen();
    try {
      return this.#db.transaction(body)();
    } catch (error) {
      this.#ids.clear();
      throw error;
    }
  }

  // ---------------------------------------------------------------- files

  fileRow(path: string): FileRow | null {
    return this.#db
      .query<FileRow, [string]>(
        `SELECT path, content_sha AS contentSha, surface_sha AS surfaceSha, language, indexed_at AS indexedAt,
                mtime_ms AS mtimeMs, size
         FROM files WHERE path = ?`,
      )
      .get(path);
  }

  allFiles(): FileRow[] {
    return this.#db
      .query<FileRow, []>(
        `SELECT path, content_sha AS contentSha, surface_sha AS surfaceSha, language, indexed_at AS indexedAt,
                mtime_ms AS mtimeMs, size
         FROM files ORDER BY path`,
      )
      .all();
  }

  hasFile(path: string): boolean {
    return this.#db.query<{ n: number }, [string]>("SELECT 1 AS n FROM files WHERE path = ?").get(path) !== null;
  }

  /** Files directly inside `dir` — no recursion, no subdirectories. */
  filesInDir(dir: string): string[] {
    const prefix = dir.length === 0 ? "" : `${dir}/`;
    return this.#db
      .query<{ path: string }, [string, number]>(
        "SELECT path FROM files WHERE path LIKE ? || '%' AND instr(substr(path, ? ), '/') = 0 ORDER BY path",
      )
      .all(prefix, prefix.length + 1)
      .map((row) => row.path);
  }

  /** Files whose path equals `suffix` or ends with `/suffix`. */
  filesWithSuffix(suffix: string): string[] {
    return this.#db
      .query<{ path: string }, [string, string]>("SELECT path FROM files WHERE path = ? OR path LIKE '%/' || ? ORDER BY path")
      .all(suffix, suffix)
      .map((row) => row.path);
  }

  /** Files whose immediate directory equals `suffix` or ends with `/suffix`. */
  filesInDirSuffix(suffix: string): string[] {
    return this.#db
      .query<{ path: string }, [string, string]>("SELECT path FROM files WHERE path LIKE '%/' || ? || '/%' OR path LIKE ? || '/%' ORDER BY path")
      .all(suffix, suffix)
      .map((row) => row.path)
      .filter((path) => {
        const directory = path.slice(0, path.lastIndexOf("/"));
        return directory === suffix || directory.endsWith(`/${suffix}`);
      });
  }

  putFile(row: FileRow): void {
    this.#db
      .query<void, [string, string, string, string, string, number, number]>(
        `INSERT INTO files(path, content_sha, surface_sha, language, indexed_at, mtime_ms, size)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           content_sha = excluded.content_sha, surface_sha = excluded.surface_sha,
           language = excluded.language, indexed_at = excluded.indexed_at,
           mtime_ms = excluded.mtime_ms, size = excluded.size`,
      )
      .run(row.path, row.contentSha, row.surfaceSha, row.language, row.indexedAt, row.mtimeMs, row.size);
  }

  /** Drop a file and everything anchored to it. Inbound edges die by foreign-key cascade. */
  deleteFile(path: string): void {
    this.#db.query<void, [string]>("DELETE FROM nodes_fts WHERE rowid IN (SELECT id FROM nodes WHERE file = ?)").run(path);
    this.#db.query<void, [string]>("DELETE FROM nodes WHERE file = ?").run(path);
    this.#db.query<void, [string]>("DELETE FROM edges WHERE file = ?").run(path);
    this.#db.query<void, [string]>("DELETE FROM unresolved WHERE file = ?").run(path);
    this.#db.query<void, [string]>("DELETE FROM reexports WHERE file = ?").run(path);
    this.#db.query<void, [string]>("DELETE FROM files WHERE path = ?").run(path);
    this.#ids.clear();
  }

  // ---------------------------------------------------------------- nodes

  /**
   * Replace one file's symbols. Surviving qualified names keep their row id — that
   * stability is what lets an unrelated file's inbound edges outlive a body-only edit
   * instead of being cascaded away and never rebuilt.
   */
  writeFileNodes(file: string, nodes: readonly MapNode[]): void {
    const upsert = this.#db.query<{ id: number }, [string, string, string, string, number, number, string | null]>(
      `INSERT INTO nodes(qn, name, kind, file, "start", "end", signature) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(qn) DO UPDATE SET
         name = excluded.name, kind = excluded.kind, file = excluded.file,
         "start" = excluded."start", "end" = excluded."end", signature = excluded.signature
       RETURNING id`,
    );
    const dropFts = this.#db.query<void, [number]>("DELETE FROM nodes_fts WHERE rowid = ?");
    const addFts = this.#db.query<void, [number, string, string, string]>(
      "INSERT INTO nodes_fts(rowid, name_split, qn, path) VALUES (?, ?, ?, ?)",
    );
    for (const node of nodes) {
      const id = upsert.get(node.qn, node.name, node.kind, node.file, node.start, node.end, node.signature)?.id;
      if (id === undefined) throw new Error(`Failed to write node ${node.qn}`);
      this.#ids.set(node.qn, id);
      dropFts.run(id);
      addFts.run(id, splitIdentifier(node.name), node.qn, node.file);
    }
    const keep = JSON.stringify(nodes.map((node) => node.qn));
    this.#db
      .query<void, [string, string]>(
        "DELETE FROM nodes_fts WHERE rowid IN (SELECT id FROM nodes WHERE file = ? AND qn NOT IN (SELECT value FROM json_each(?)))",
      )
      .run(file, keep);
    this.#db
      .query<void, [string, string]>("DELETE FROM nodes WHERE file = ? AND qn NOT IN (SELECT value FROM json_each(?))")
      .run(file, keep);
  }

  /** Every symbol, ordered by qualified name. The canonical form of the graph's vertices. */
  allNodes(): StoredNode[] {
    return this.#db.query<NodeRowRaw, []>(`${NODE_SELECT} ORDER BY qn`).all().map(toNode);
  }

  /** Every edge, ordered by endpoint names and site. The canonical form of the graph's arcs. */
  allEdges(): StoredEdge[] {
    return this.#db
      .query<EdgeRowRaw, []>(
        `SELECT e.id, e.src, e.dst, s.qn AS srcQn, d.qn AS dstQn, e.relation, e.context, e.confidence, e.file, e.line
         FROM edges e JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         ORDER BY s.qn, e.relation, d.qn, e.file, e.line, e.context`,
      )
      .all()
      .map(toEdge);
  }

  /** Every remembered fragile name, ordered by file then name. */
  allUnresolved(): { file: string; name: string; dropped: number; inferred: number }[] {
    return this.#db
      .query<{ file: string; name: string; dropped: number; inferred: number }, []>(
        "SELECT file, name, dropped, inferred FROM unresolved ORDER BY file, name",
      )
      .all();
  }

  nodeByQn(qn: string): StoredNode | null {
    const row = this.#db.query<NodeRowRaw, [string]>(`${NODE_SELECT} WHERE qn = ?`).get(qn);
    return row ? toNode(row) : null;
  }

  nodeById(id: number): StoredNode | null {
    const row = this.#db.query<NodeRowRaw, [number]>(`${NODE_SELECT} WHERE id = ?`).get(id);
    return row ? toNode(row) : null;
  }

  /** Every symbol with this exact name, optionally confined to one language family. */
  nodesByName(name: string, family?: LanguageFamily): StoredNode[] {
    if (family === undefined) {
      return this.#db.query<NodeRowRaw, [string]>(`${NODE_SELECT} WHERE name = ? ORDER BY qn`).all(name).map(toNode);
    }
    const languages = JSON.stringify(languagesInFamily(family));
    return this.#db
      .query<NodeRowRaw, [string, string]>(
        `SELECT n.id, n.qn, n.name, n.kind, n.file, n."start" AS start, n."end" AS end, n.signature
         FROM nodes n JOIN files f ON f.path = n.file
         WHERE n.name = ? AND f.language IN (SELECT value FROM json_each(?))
         ORDER BY n.qn`,
      )
      .all(name, languages)
      .map(toNode);
  }

  /** Every symbol with this name declared in any of `files` — the import-evidence lookup. */
  nodesNamedInFiles(name: string, files: readonly string[]): StoredNode[] {
    if (files.length === 0) return [];
    return this.#db
      .query<NodeRowRaw, [string, string]>(
        `${NODE_SELECT} WHERE name = ? AND file IN (SELECT value FROM json_each(?)) ORDER BY qn`,
      )
      .all(name, JSON.stringify(files))
      .map(toNode);
  }

  nodesInFile(file: string): StoredNode[] {
    return this.#db.query<NodeRowRaw, [string]>(`${NODE_SELECT} WHERE file = ? ORDER BY "start", qn`).all(file).map(toNode);
  }

  /** Node ids by qualified name, warmed by {@link writeFileNodes} within a write pass. */
  idOf(qn: string): number | undefined {
    const cached = this.#ids.get(qn);
    if (cached !== undefined) return cached;
    const row = this.#db.query<{ id: number }, [string]>("SELECT id FROM nodes WHERE qn = ?").get(qn);
    if (row) this.#ids.set(qn, row.id);
    return row?.id;
  }

  /** Forget the qn → id cache; required after any write that bypassed this store. */
  resetIdCache(): void {
    this.#ids.clear();
  }

  // ---------------------------------------------------------------- edges

  /**
   * Replace every relation whose SITE is in `file`. Edges pointing INTO this file from
   * elsewhere are untouched — they belong to their own site's file.
   *
   * Returns how many edges were dropped because an endpoint does not exist.
   */
  replaceEdges(file: string, edges: readonly MapEdge[]): number {
    this.#db.query<void, [string]>("DELETE FROM edges WHERE file = ?").run(file);
    return this.addEdges(edges);
  }

  /**
   * Insert edges, skipping any whose endpoints no longer exist and any that repeat a
   * (src, dst, relation, context, site) tuple already inserted in this call. Returns how
   * many were dropped for a missing endpoint.
   */
  addEdges(edges: readonly MapEdge[]): number {
    const insert = this.#db.query<void, [number, number, string, string | null, string, string, number]>(
      `INSERT INTO edges(src, dst, relation, context, confidence, file, line) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let dangling = 0;
    const seen = new Set<string>();
    // Extracted before inferred, so a repeated site keeps the stronger claim.
    const ordered = [...edges].sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "extracted" ? -1 : 1));
    for (const edge of ordered) {
      const src = this.idOf(edge.src);
      const dst = this.idOf(edge.dst);
      if (src === undefined || dst === undefined) {
        dangling += 1;
        continue;
      }
      const key = `${src} ${dst} ${edge.relation} ${edge.context ?? ""} ${edge.file} ${edge.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      insert.run(src, dst, edge.relation, edge.context, edge.confidence, edge.file, edge.line);
    }
    return dangling;
  }

  edgesFrom(node: string | number, options: EdgeQueryOptions = {}): StoredEdge[] {
    return this.#edges("src", node, options);
  }

  edgesTo(node: string | number, options: EdgeQueryOptions = {}): StoredEdge[] {
    return this.#edges("dst", node, options);
  }

  /** Files holding a relation site that points into any of `files`. The reverse index earns its keep here. */
  dependentsOf(files: readonly string[]): string[] {
    if (files.length === 0) return [];
    return this.#db
      .query<{ file: string }, [string]>(
        `SELECT DISTINCT e.file FROM edges e JOIN nodes n ON n.id = e.dst
         WHERE n.file IN (SELECT value FROM json_each(?)) ORDER BY e.file`,
      )
      .all(JSON.stringify(files))
      .map((row) => row.file);
  }

  // ---------------------------------------------------------------- unresolved

  replaceUnresolved(file: string, names: ReadonlyMap<string, Mention>): void {
    this.#db.query<void, [string]>("DELETE FROM unresolved WHERE file = ?").run(file);
    const insert = this.#db.query<void, [string, string, number, number]>(
      `INSERT INTO unresolved(file, name, dropped, inferred) VALUES (?, ?, ?, ?)
       ON CONFLICT(file, name) DO UPDATE SET dropped = excluded.dropped, inferred = excluded.inferred`,
    );
    for (const [name, mention] of names) insert.run(file, name, mention.dropped, mention.inferred);
  }

  /** Files that mentioned any of these names without a syntactic proof of the target. */
  filesMentioning(names: readonly string[]): string[] {
    if (names.length === 0) return [];
    return this.#db
      .query<{ file: string }, [string]>(
        "SELECT DISTINCT file FROM unresolved WHERE name IN (SELECT value FROM json_each(?)) ORDER BY file",
      )
      .all(JSON.stringify(names))
      .map((row) => row.file);
  }

  unresolvedNames(file: string): string[] {
    return this.#db
      .query<{ name: string }, [string]>("SELECT name FROM unresolved WHERE file = ? ORDER BY name")
      .all(file)
      .map((row) => row.name);
  }

  // ---------------------------------------------------------------- re-exports

  /** Replace a file's `export … from` facts. `imported` is `*` for a whole-module forward. */
  replaceReexports(file: string, facts: readonly { imported: string; specifier: string }[]): void {
    this.#db.query<void, [string]>("DELETE FROM reexports WHERE file = ?").run(file);
    const insert = this.#db.query<void, [string, string, string]>(
      "INSERT OR IGNORE INTO reexports(file, imported, specifier) VALUES (?, ?, ?)",
    );
    for (const fact of facts) insert.run(file, fact.imported, fact.specifier);
  }

  /** Specifiers a file forwards `name` through, plus every `export *` it carries. */
  reexportsFor(file: string, name: string): string[] {
    return this.#db
      .query<{ specifier: string }, [string, string]>(
        "SELECT DISTINCT specifier FROM reexports WHERE file = ? AND (imported = ? OR imported = '*') ORDER BY specifier",
      )
      .all(file, name)
      .map((row) => row.specifier);
  }

  // ---------------------------------------------------------------- modules

  putModule(name: string, dir: string): void {
    this.#db
      .query<void, [string, string]>("INSERT INTO modules(name, dir) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET dir = excluded.dir")
      .run(name, dir);
  }

  modules(): Map<string, string> {
    const rows = this.#db.query<{ name: string; dir: string }, []>("SELECT name, dir FROM modules").all();
    return new Map(rows.map((row) => [row.name, row.dir]));
  }

  clearModules(): void {
    this.#db.exec("DELETE FROM modules");
  }

  // ---------------------------------------------------------------- search

  /**
   * Full-text search over split identifiers, qualified names, and paths.
   * `updateCloud` matches `updateCloudClient` because the index stores `update cloud client`.
   */
  searchFts(query: string, limit = 20): FtsHit[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Search limit must be a non-negative safe integer");
    if (limit === 0) return [];
    const match = toFtsQuery(query);
    if (match === null) return [];
    return this.#db
      .query<NodeRowRaw & { rank: number }, [string, number]>(
        `SELECT n.id, n.qn, n.name, n.kind, n.file, n."start" AS start, n."end" AS end, n.signature, bm25(nodes_fts) AS rank
         FROM nodes_fts JOIN nodes n ON n.id = nodes_fts.rowid
         WHERE nodes_fts MATCH ?
         ORDER BY rank ASC, n.qn ASC
         LIMIT ?`,
      )
      .all(match, limit)
      .map((row) => ({ ...toNode(row), rank: row.rank }));
  }

  /**
   * Breadth-first neighbourhood around a node. Deterministic: each frontier is
   * expanded in edge-id order, so the same graph always yields the same walk.
   */
  bfs(start: string | number, options: BfsOptions = {}): BfsResult {
    const origin = typeof start === "number" ? this.nodeById(start) : this.nodeByQn(start);
    if (!origin) return { nodes: [], edges: [], truncated: false };
    const depth = options.depth ?? 2;
    const limit = options.limit ?? 200;
    const direction = options.direction ?? "out";
    const seen = new Map<number, BfsNode>([[origin.id, { ...origin, depth: 0 }]]);
    const edges: StoredEdge[] = [];
    const edgeIds = new Set<number>();
    let frontier: number[] = [origin.id];
    let truncated = false;
    for (let level = 0; level < depth && frontier.length > 0 && !truncated; level += 1) {
      const next: number[] = [];
      for (const id of frontier) {
        const outgoing = direction === "in" ? [] : this.edgesFrom(id, { ...(options.relations ? { relations: options.relations } : {}) });
        const incoming = direction === "out" ? [] : this.edgesTo(id, { ...(options.relations ? { relations: options.relations } : {}) });
        for (const edge of [...outgoing, ...incoming]) {
          if (!edgeIds.has(edge.id)) {
            edgeIds.add(edge.id);
            edges.push(edge);
          }
          const other = edge.src === id ? edge.dst : edge.src;
          if (seen.has(other)) continue;
          if (seen.size >= limit) {
            truncated = true;
            break;
          }
          const node = this.nodeById(other);
          if (!node) continue;
          seen.set(other, { ...node, depth: level + 1 });
          next.push(other);
        }
        if (truncated) break;
      }
      frontier = next;
    }
    return {
      nodes: [...seen.values()].sort((a, b) => a.depth - b.depth || a.qn.localeCompare(b.qn)),
      edges: edges.sort((a, b) => a.id - b.id),
      truncated,
    };
  }

  // ---------------------------------------------------------------- wave 2 lookups

  /**
   * Symbols whose qualified name ends in `tail` at a dot boundary — the lookup behind
   * `AgentLoop.runTurn` naming a method without spelling the whole path to it. An exact
   * qualified name also matches, so a caller never has to decide which form it holds.
   */
  nodesByQnSuffix(tail: string): StoredNode[] {
    return this.#db
      .query<NodeRowRaw, [string, string]>(
        `${NODE_SELECT} WHERE qn = ? OR qn LIKE '%.' || ? ESCAPE '\\' ORDER BY LENGTH(qn), qn`,
      )
      .all(tail, escapeLike(tail))
      .map(toNode);
  }

  /**
   * Symbols whose name matches case-insensitively. Case is never folded in storage — that
   * is how a rename orphans edges — so this is a query-time convenience only, and the
   * caller is expected to prefer an exact-case hit when one exists.
   */
  nodesByNameFold(name: string): StoredNode[] {
    return this.#db
      .query<NodeRowRaw, [string]>(`${NODE_SELECT} WHERE name = ? COLLATE NOCASE ORDER BY qn`).all(name)
      .map(toNode);
  }

  /**
   * Inbound and outbound degree for a set of symbols, in one query rather than one per
   * symbol. Structural relations (`contains`, `defines`) are excluded: every symbol has
   * exactly one parent and one defining file, so counting them would rank nothing.
   */
  degreesFor(ids: readonly number[]): Map<number, Degree> {
    const out = new Map<number, Degree>();
    if (ids.length === 0) return out;
    const list = JSON.stringify([...ids]);
    const rows = this.#db
      .query<{ id: number; direction: string; confidence: string; n: number }, [string, string]>(
        `SELECT src AS id, 'out' AS direction, confidence, COUNT(*) AS n FROM edges
           WHERE ${MEANINGFUL} AND src IN (SELECT value FROM json_each(?)) GROUP BY src, confidence
         UNION ALL
         SELECT dst AS id, 'in' AS direction, confidence, COUNT(*) AS n FROM edges
           WHERE ${MEANINGFUL} AND dst IN (SELECT value FROM json_each(?)) GROUP BY dst, confidence`,
      )
      .all(list, list);
    for (const id of ids) out.set(id, { in: 0, out: 0, inferred: 0 });
    for (const row of rows) {
      const entry = out.get(row.id);
      if (!entry) continue;
      if (row.direction === "in") entry.in += row.n;
      else entry.out += row.n;
      if (row.confidence === "inferred") entry.inferred += row.n;
    }
    return out;
  }

  /** The graph's hubs: highest total degree first, excluding the given kinds. */
  topDegree(limit: number, excludeKinds: readonly string[] = []): DegreeNode[] {
    return this.#db
      .query<NodeRowRaw & { inDeg: number; outDeg: number; inferredDeg: number }, [string, number]>(
        `SELECT n.id, n.qn, n.name, n.kind, n.file, n."start" AS start, n."end" AS end, n.signature,
                COALESCE(i.n, 0) AS inDeg, COALESCE(o.n, 0) AS outDeg, COALESCE(f.n, 0) AS inferredDeg
         FROM nodes n
         LEFT JOIN (SELECT dst AS id, COUNT(*) AS n FROM edges WHERE ${MEANINGFUL} GROUP BY dst) i ON i.id = n.id
         LEFT JOIN (SELECT src AS id, COUNT(*) AS n FROM edges WHERE ${MEANINGFUL} GROUP BY src) o ON o.id = n.id
         LEFT JOIN (SELECT dst AS id, COUNT(*) AS n FROM edges
                    WHERE ${MEANINGFUL} AND confidence = 'inferred' GROUP BY dst) f ON f.id = n.id
         WHERE n.kind NOT IN (SELECT value FROM json_each(?))
         ORDER BY (COALESCE(i.n, 0) + COALESCE(o.n, 0)) DESC, n.qn ASC
         LIMIT ?`,
      )
      .all(JSON.stringify([...excludeKinds]), limit)
      .map((row) => ({ ...toNode(row), in: row.inDeg, out: row.outDeg, inferred: row.inferredDeg }));
  }

  /** Non-structural edges crossing a file boundary, inferred first — the surprise candidates. */
  crossFileEdges(limit: number): CrossEdge[] {
    return this.#db
      .query<CrossEdge, [number]>(
        `SELECT e.id, s.qn AS srcQn, d.qn AS dstQn, s.file AS srcFile, d.file AS dstFile,
                s.id AS srcId, d.id AS dstId, e.relation, e.confidence, e.file, e.line
         FROM edges e JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE ${MEANINGFUL} AND s.file <> d.file
         ORDER BY e.confidence DESC, e.id ASC
         LIMIT ?`,
      )
      .all(limit);
  }

  /** File-to-file edge volume, for aggregating a directory partition into a package graph. */
  fileFlow(): { srcFile: string; dstFile: string; n: number }[] {
    return this.#db
      .query<{ srcFile: string; dstFile: string; n: number }, []>(
        `SELECT s.file AS srcFile, d.file AS dstFile, COUNT(*) AS n
         FROM edges e JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE ${MEANINGFUL} AND s.file <> d.file
         GROUP BY s.file, d.file ORDER BY s.file, d.file`,
      )
      .all();
  }

  /**
   * File pairs that import each other. A longer cycle needs a traversal, but a two-cycle
   * is a self-join, and it is the one the reader can act on immediately.
   */
  mutualImports(limit: number): { a: string; b: string }[] {
    return this.#db
      .query<{ a: string; b: string }, [number]>(
        `WITH imp AS (
           SELECT DISTINCT s.file AS src, d.file AS dst
           FROM edges e JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
           WHERE e.relation IN ${IMPORTISH} AND s.file <> d.file
         )
         SELECT x.src AS a, x.dst AS b FROM imp x JOIN imp y ON y.src = x.dst AND y.dst = x.src
         WHERE x.src < x.dst ORDER BY a, b LIMIT ?`,
      )
      .all(limit);
  }

  /** The names the resolver most often could not pin down, worst first. */
  unresolvedTop(limit: number): { name: string; dropped: number; inferred: number; files: number }[] {
    return this.#db
      .query<{ name: string; dropped: number; inferred: number; files: number }, [number]>(
        `SELECT name, SUM(dropped) AS dropped, SUM(inferred) AS inferred, COUNT(DISTINCT file) AS files
         FROM unresolved GROUP BY name
         ORDER BY (SUM(dropped) + SUM(inferred)) DESC, name ASC LIMIT ?`,
      )
      .all(limit);
  }

  /** Distinct symbol names with their multiplicity — the raw material of the vocabulary. */
  nameCounts(): { name: string; n: number }[] {
    return this.#db
      .query<{ name: string; n: number }, []>("SELECT name, COUNT(*) AS n FROM nodes GROUP BY name ORDER BY n DESC, name ASC")
      .all();
  }

  /** Indexed files per language. */
  languageCounts(): { language: MapLanguage; n: number }[] {
    return this.#db
      .query<{ language: MapLanguage; n: number }, []>(
        "SELECT language, COUNT(*) AS n FROM files GROUP BY language ORDER BY n DESC, language ASC",
      )
      .all();
  }

  /** Edges per confidence — how much of the graph is proof and how much is a good guess. */
  confidenceCounts(): { confidence: Confidence; n: number }[] {
    return this.#db
      .query<{ confidence: Confidence; n: number }, []>(
        "SELECT confidence, COUNT(*) AS n FROM edges GROUP BY confidence ORDER BY confidence ASC",
      )
      .all();
  }

  /** Symbols declared per file, file nodes excluded — the size of each partition member. */
  nodeCountsByFile(): { file: string; n: number }[] {
    return this.#db
      .query<{ file: string; n: number }, []>(
        "SELECT file, COUNT(*) AS n FROM nodes WHERE kind <> 'file' GROUP BY file ORDER BY file",
      )
      .all();
  }

  // ---------------------------------------------------------------- counts

  counts(): { files: number; nodes: number; edges: number; unresolved: number; dropped: number } {
    const one = (sql: string): number => this.#db.query<{ n: number }, []>(sql).get()?.n ?? 0;
    return {
      files: one("SELECT COUNT(*) AS n FROM files"),
      nodes: one("SELECT COUNT(*) AS n FROM nodes"),
      edges: one("SELECT COUNT(*) AS n FROM edges"),
      unresolved: one("SELECT COUNT(*) AS n FROM unresolved"),
      dropped: one("SELECT COALESCE(SUM(dropped), 0) AS n FROM unresolved"),
    };
  }

  /** How many symbols live outside this set of files — the quantity the collapse guard watches. */
  nodesOutside(files: readonly string[]): number {
    return (
      this.#db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM nodes WHERE file NOT IN (SELECT value FROM json_each(?))")
        .get(JSON.stringify(files))?.n ?? 0
    );
  }

  metaGet(key: string): string | null {
    return this.#db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  metaSet(key: string, value: string): void {
    this.#db
      .query<void, [string, string]>("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close(false);
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // ---------------------------------------------------------------- internals

  #edges(column: "src" | "dst", node: string | number, options: EdgeQueryOptions): StoredEdge[] {
    const id = typeof node === "number" ? node : this.idOf(node);
    if (id === undefined) return [];
    const filters: string[] = [`e.${column} = ?`];
    const parameters: (string | number)[] = [id];
    if (options.relations && options.relations.length > 0) {
      filters.push("e.relation IN (SELECT value FROM json_each(?))");
      parameters.push(JSON.stringify(options.relations));
    }
    if (options.confidence) {
      filters.push("e.confidence = ?");
      parameters.push(options.confidence);
    }
    const limit = options.limit === undefined ? "" : " LIMIT ?";
    if (options.limit !== undefined) parameters.push(options.limit);
    return this.#db
      .query<EdgeRowRaw, (string | number)[]>(
        `SELECT e.id, e.src, e.dst, s.qn AS srcQn, d.qn AS dstQn, e.relation, e.context, e.confidence, e.file, e.line
         FROM edges e JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE ${filters.join(" AND ")}
         ORDER BY e.id${limit}`,
      )
      .all(...parameters)
      .map(toEdge);
  }

  #dropEverything(): void {
    this.#db.exec(`
      DROP TABLE IF EXISTS nodes_fts;
      DROP TABLE IF EXISTS edges;
      DROP TABLE IF EXISTS nodes;
      DROP TABLE IF EXISTS unresolved;
      DROP TABLE IF EXISTS reexports;
      DROP TABLE IF EXISTS modules;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS meta;
    `);
  }

  #secure(): void {
    if (this.path === ":memory:") return;
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try {
        chmodSync(path, 0o600);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error;
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Code map store is closed");
  }
}

const NODE_SELECT = `SELECT id, qn, name, kind, file, "start" AS start, "end" AS end, signature FROM nodes`;

/**
 * Degree, hubs, and cross-file flow all ignore `contains` and `defines`. Those two say only
 * "this symbol is declared here" — every symbol has exactly one of each — so counting them
 * ranks nothing and drowns the relations that carry information.
 */
const MEANINGFUL = `relation NOT IN ('contains', 'defines')`;

/** The relations that make one file depend on another's surface. */
const IMPORTISH = `('imports', 'imports_from', 're_exports')`;

/** Neutralize LIKE wildcards so a name containing `_` cannot match a wider set than itself. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

function toEdge(row: EdgeRowRaw): StoredEdge {
  return {
    id: row.id,
    src: row.src,
    dst: row.dst,
    srcQn: row.srcQn,
    dstQn: row.dstQn,
    relation: row.relation as EdgeRelation,
    context: row.context as EdgeContext | null,
    confidence: row.confidence as Confidence,
    file: row.file,
    line: row.line,
  };
}

function toNode(row: NodeRowRaw): StoredNode {
  return {
    id: row.id,
    qn: row.qn,
    name: row.name,
    kind: row.kind as StoredNode["kind"],
    file: row.file,
    start: row.start,
    end: row.end,
    signature: row.signature,
  };
}

/** Turn free text into a conjunctive prefix query; returns null when nothing is searchable. */
export function toFtsQuery(query: string): string | null {
  if (typeof query !== "string") throw new TypeError("Search query must be a string");
  const terms = query.match(/[\p{L}\p{N}_]+/gu);
  if (terms === null || terms.length === 0) return null;
  const expanded = new Set<string>();
  for (const term of terms) for (const word of splitIdentifier(term).split(" ")) if (word) expanded.add(word);
  return [...expanded].map((term) => `"${term.replace(/"/g, '""')}"*`).join(" AND ");
}
