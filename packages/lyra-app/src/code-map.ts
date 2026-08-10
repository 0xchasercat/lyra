import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import * as mapPackage from "@lyra/map";
import { CodeMap, walkRepository } from "@lyra/map";

/**
 * The code graph as the session owns it: one index per tree, kept fresh by events.
 *
 * The map itself (`@lyra/map`) is a library — it indexes when told to and answers when
 * asked. Everything that makes it a *product* is here: it is opened at boot and indexed in
 * the background so nothing waits for it, it is told what changed by the tool dispatcher
 * instead of being re-indexed by hand, and every answer it gives carries the truth about
 * how far behind the working tree it is.
 *
 * Three rules shape the whole file:
 *
 * 1. **Boot never waits.** Indexing a large repository takes seconds; a session that
 *    blocked on it would be a session that got slower the more code it was given.
 * 2. **A query before the index exists answers honestly.** "Indexing — 0 of 1,240 files"
 *    is a usable answer; an empty overview is a lie (§3.8).
 * 3. **The index failing is never the session failing.** An indexing crash disables the
 *    tool, warns once, and leaves every other tool exactly as it was — the same
 *    graceful-degradation contract the language servers run under (§15).
 */

/** How long the debounce holds a burst of edits before folding them into one update. */
const DEFAULT_DEBOUNCE_MS = 500;
/** How often the idle catch-up may walk the tree looking for out-of-band edits. */
const CATCH_UP_INTERVAL_MS = 30_000;
/** A staleness answer is reused for this long, so three map calls in one turn walk once. */
const STALE_CACHE_MS = 1_000;
/** Above this many files a first index announces itself; below it, it is over before a line would land. */
const ANNOUNCE_ABOVE_FILES = 300;

export type CodeMapPhase = "cold" | "indexing" | "ready" | "unavailable";

export interface CodeMapStatus {
  readonly phase: CodeMapPhase;
  /** Files already queryable. Zero during a first index; the prior count during a catch-up. */
  readonly indexed: number;
  /** Files the walk found, once it has run. */
  readonly total: number;
  /** Why the map is unavailable, when it is. */
  readonly reason?: string;
}

export interface CodeMapServiceOptions {
  readonly root: string;
  /** Where a degradation notice goes. Called at most once per service. */
  readonly onWarning?: (message: string) => void;
  /** Where a progress line goes for a first index big enough to be worth announcing. */
  readonly onReport?: (message: string) => void;
  readonly debounceMs?: number;
}

/**
 * What the `map` tool is allowed to do with the index.
 *
 * An interface rather than the service itself, for the same reason `CheckpointAccess` is
 * one: the tool gets exactly these five capabilities, and a tool holding the service could
 * reach the debounce timer and the write queue too.
 */
export interface MapAccess {
  readonly root: string;
  /** Idempotent. Starts the background index the first time anything asks for the graph. */
  ensureStarted(): void;
  status(): CodeMapStatus;
  /** The graph, or undefined while it is still being built or after it failed. */
  graph(): CodeMap | undefined;
  /** The §3.8 line every answer carries when the tree has moved on. */
  staleLine(): Promise<string | undefined>;
}

/**
 * One tree's index, from boot to close.
 *
 * Construction opens nothing: an isolated child gets a service for its workspace the moment
 * its tool registry is built, and most children never call `map` at all. The SQLite file is
 * created by the first `ensureStarted`.
 */
export class CodeMapService implements MapAccess {
  readonly root: string;
  #map: CodeMap | undefined;
  #phase: CodeMapPhase = "cold";
  #reason: string | undefined;
  #indexed = 0;
  #total = 0;
  #started: Promise<void> | undefined;
  #pending = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #lastCatchUp = 0;
  #staleAt = 0;
  #staleLine: string | undefined;
  #updateFailure: string | undefined;
  #closed = false;
  readonly #debounceMs: number;
  readonly #onWarning: ((message: string) => void) | undefined;
  readonly #onReport: ((message: string) => void) | undefined;

  constructor(options: CodeMapServiceOptions) {
    if (!options || typeof options.root !== "string" || options.root.length === 0) {
      throw new TypeError("A code map service needs the root of the tree it indexes.");
    }
    this.root = resolve(options.root);
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#onWarning = options.onWarning;
    this.#onReport = options.onReport;
  }

  ensureStarted(): void {
    if (this.#phase !== "cold" || this.#closed) return;
    this.#phase = "indexing";
    this.#started = this.#firstPass();
    // Nothing awaits this. A rejection would still have been handled inside `#firstPass`,
    // but an unhandled rejection here would be a boot-time crash for a background job.
    void this.#started.catch(() => undefined);
  }

  status(): CodeMapStatus {
    return {
      phase: this.#phase,
      indexed: this.#indexed,
      total: this.#total,
      ...(this.#reason === undefined ? {} : { reason: this.#reason }),
    };
  }

  graph(): CodeMap | undefined {
    return this.#phase === "ready" ? this.#map : undefined;
  }

  /** True once the background first pass has settled; the test seam for "wait for the index". */
  async settled(): Promise<void> {
    await this.#started;
    await this.#queue.catch(() => undefined);
  }

  /**
   * A tool call changed these files. Coalesced, debounced, and serialized — a ten-file
   * refactor is one update, and two bursts can never interleave their read and write phases.
   */
  noteModified(paths: readonly string[]): void {
    // Nothing is remembered before the index exists: whenever it is finally built, it is
    // built from the tree as it stands, which already contains every edit made until then.
    // (This is also what stops a child that never asks the graph anything from accumulating
    // a path set for a graph nobody will open.)
    if (this.#closed || this.#phase === "cold" || this.#phase === "unavailable") return;
    let added = false;
    for (const path of paths) if (typeof path === "string" && path.length > 0) { this.#pending.add(path); added = true; }
    if (!added) return;
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => { this.#timer = undefined; this.#flush(); }, this.#debounceMs);
    // A pending index update must never be the reason a process stays alive.
    (this.#timer as { unref?: () => void }).unref?.();
  }

  /** Run the debounced work now. Used by tests and by `/cleanup`, never on the hot path. */
  flushNow(): Promise<void> {
    if (this.#timer !== undefined) { clearTimeout(this.#timer); this.#timer = undefined; }
    this.#flush();
    return this.settled();
  }

  async staleLine(): Promise<string | undefined> {
    const failure = this.#updateFailure;
    const drift = await this.#staleReport();
    if (drift === undefined) return failure === undefined ? undefined : `stale: the last incremental update failed (${failure}) — recent edits may not appear; read the files for ground truth`;
    return failure === undefined ? drift : `${drift} The last incremental update failed (${failure}).`;
  }

  /**
   * Everything `/health` and `/cleanup` want to say about the index: how big it is, how
   * fresh it is, and what it costs on disk.
   */
  async info(): Promise<Record<string, unknown>> {
    const status = this.status();
    const counts = this.#phase === "ready" || this.#phase === "indexing" ? this.#map?.stats() : undefined;
    let bytes: number | undefined;
    try { bytes = (await stat(resolve(this.root, ".lyra", "map.db"))).size; } catch { bytes = undefined; }
    let stale: number | undefined;
    if (this.#phase === "ready" && this.#map !== undefined) {
      try {
        const report = await this.#map.stale();
        stale = report.added.length + report.changed.length + report.removed.length;
      } catch { stale = undefined; }
    }
    return {
      root: this.root,
      state: status.phase,
      ...(status.reason === undefined ? {} : { reason: status.reason }),
      ...(counts === undefined ? {} : { files: counts.files, symbols: counts.nodes, edges: counts.edges }),
      ...(status.phase === "indexing" ? { indexing: { indexed: status.indexed, total: status.total } } : {}),
      ...(stale === undefined ? {} : { staleFiles: stale }),
      ...(bytes === undefined ? {} : { bytes }),
    };
  }

  /**
   * Drop the rows of files that no longer exist and pick up whatever drifted. Called by
   * `/cleanup`, which is where "reclaim what this session no longer needs" already lives —
   * the map's own retention story, since deleting the index would only mean paying for it
   * again on the next boot.
   */
  async collect(): Promise<{ removed: number; updated: number }> {
    if (this.#phase !== "ready" || this.#map === undefined) return { removed: 0, updated: 0 };
    const report = await this.#map.stale();
    const paths = [...report.added, ...report.changed, ...report.removed];
    if (paths.length === 0) return { removed: 0, updated: 0 };
    await this.#serial(() => this.#map!.update(paths));
    this.#staleAt = 0;
    return { removed: report.removed.length, updated: report.added.length + report.changed.length };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) { clearTimeout(this.#timer); this.#timer = undefined; }
    await this.#started?.catch(() => undefined);
    await this.#queue.catch(() => undefined);
    this.#map?.close();
  }

  // ---------------------------------------------------------------- internals

  /**
   * Open the store, then either build the graph or catch it up.
   *
   * A tree with no rows is a first boot: the whole repository is walked and parsed, and
   * nothing is queryable until it finishes. A tree that already has rows is queryable *now*,
   * so it goes straight to `ready` and the catch-up runs behind it — the drift it is closing
   * is exactly what the staleness line would otherwise report.
   */
  async #firstPass(): Promise<void> {
    try {
      this.#map = CodeMap.open({ root: this.root });
    } catch (error) { this.#disable(error); return; }
    const existing = this.#map.stats().files;
    this.#indexed = existing;
    if (existing > 0) {
      this.#phase = "ready";
      try { await this.#catchUp(); } catch (error) { this.#degrade(error); }
      return;
    }
    try {
      // Sizing the job before doing it is the only way "0 of N" can be honest, and it is the
      // only progress the underlying index exposes: it writes in one transaction, so there is
      // no half-built graph to count.
      const walk = await walkRepository(this.root);
      this.#total = walk.files.length;
      const announced = this.#total >= ANNOUNCE_ABOVE_FILES;
      if (announced) this.#onReport?.(`[map] Indexing ${this.#total} files in the background; the map tool answers "indexing" until it lands.`);
      const stats = await this.#map.index();
      this.#indexed = stats.files;
      this.#phase = "ready";
      if (announced) this.#onReport?.(`[map] Indexed ${stats.files} files, ${stats.nodes} symbols, ${stats.edges} relations in ${(stats.elapsedMs / 1000).toFixed(1)}s.`);
      await this.#drainPending();
    } catch (error) { this.#disable(error); }
  }

  /** Fold whatever the tree did while the first index ran. */
  async #drainPending(): Promise<void> {
    if (this.#pending.size === 0) return;
    const paths = [...this.#pending];
    this.#pending.clear();
    try { await this.#serial(() => this.#map!.update(paths)); } catch (error) { this.#degrade(error); }
  }

  #flush(): void {
    if (this.#closed || this.#phase === "unavailable") return;
    void this.#serial(async () => {
      // The paths are taken *inside* the queue, and only once there is a graph to apply them
      // to. Waiting for the first index here instead would deadlock: the first pass drains
      // this same queue when it finishes, so a queued waiter would be waiting on itself.
      if (this.#closed || this.#phase !== "ready" || this.#map === undefined) return;
      const paths = [...this.#pending];
      this.#pending.clear();
      if (paths.length > 0) {
        try {
          await this.#map.update(paths);
          this.#updateFailure = undefined;
        } catch (error) {
          // A failed update is not a failed tool call and not a dead map: the files simply
          // stay stale, and the staleness line already says so on every answer.
          this.#degrade(error);
        }
        this.#staleAt = 0;
      }
      // Out-of-band edits — the user's own editor — ride the same timer, at most twice a
      // minute, so an idle session converges without a watcher and a busy one does not walk
      // the tree after every write.
      if (this.#pending.size === 0) await this.#catchUp();
    });
  }

  /** Pick up drift nobody reported. Rate-limited; a walk is not free on a large tree. */
  async #catchUp(): Promise<void> {
    if (this.#map === undefined || this.#phase !== "ready") return;
    const now = Date.now();
    if (now - this.#lastCatchUp < CATCH_UP_INTERVAL_MS) return;
    this.#lastCatchUp = now;
    try {
      const report = await this.#map.stale();
      const paths = [...report.added, ...report.changed, ...report.removed];
      if (paths.length === 0) return;
      await this.#map.update(paths);
      this.#updateFailure = undefined;
      this.#staleAt = 0;
    } catch (error) { this.#degrade(error); }
  }

  async #staleReport(): Promise<string | undefined> {
    if (this.#phase !== "ready" || this.#map === undefined) return undefined;
    const now = Date.now();
    if (now - this.#staleAt < STALE_CACHE_MS) return this.#staleLine;
    let line: string | undefined;
    try {
      const report = await this.#map.stale();
      const files = [...report.changed, ...report.added, ...report.removed].sort();
      if (files.length > 0) {
        const shown = files.slice(0, 3).join(", ");
        line = `stale: ${files.length} file${files.length === 1 ? "" : "s"} (${shown}${files.length > 3 ? " …" : ""}) — recent edits may not appear; read the files for ground truth`;
      }
    } catch { line = undefined; }
    this.#staleAt = now;
    this.#staleLine = line;
    return line;
  }

  #serial<T>(body: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(body, body);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** The map is gone for this session. Said once, then never again (§3.8, §15's LSP rule). */
  #disable(error: unknown): void {
    if (this.#phase === "unavailable") return;
    this.#phase = "unavailable";
    this.#reason = message(error);
    this.#pending.clear();
    try { this.#map?.close(); } catch { /* a store that cannot close is already gone */ }
    this.#map = undefined;
    this.#onWarning?.(`[map] The code graph is unavailable for this session: ${this.#reason} Every other tool is unaffected; use grep, glob, and read to explore.`);
  }

  /** A write failed but the graph is still good. Remembered, and reported on every answer. */
  #degrade(error: unknown): void {
    this.#updateFailure = message(error);
  }
}

/**
 * One service per tree.
 *
 * A shared-tree child gets the parent's own instance — the same repository must not be
 * indexed twice, and wave 1 serializes writes inside a single `CodeMap`, not across two of
 * them. An isolated child's workspace is a different tree, so it gets its own, lazily.
 */
export class CodeMapRegistry {
  readonly #services = new Map<string, CodeMapService>();
  readonly #options: Omit<CodeMapServiceOptions, "root">;

  constructor(options: Omit<CodeMapServiceOptions, "root"> = {}) {
    this.#options = options;
  }

  get(root: string): CodeMapService {
    const key = resolve(root);
    const existing = this.#services.get(key);
    if (existing) return existing;
    const service = new CodeMapService({ ...this.#options, root: key });
    this.#services.set(key, service);
    return service;
  }

  list(): readonly CodeMapService[] { return [...this.#services.values()]; }

  async close(): Promise<void> {
    await Promise.allSettled(this.list().map((service) => service.close()));
    this.#services.clear();
  }
}

// ---------------------------------------------------------------- the query verbs

/**
 * The wave-2 query surface, as this package is allowed to depend on it.
 *
 * Declared as optional members over a namespace import rather than imported by name on
 * purpose: a named import of a function `@lyra/map` does not export yet is a link-time
 * crash for the *whole application*, and the honest failure for a verb that is not there is
 * one op saying so. Each is bound at call time, so the real function is picked up the
 * moment the package exports it.
 */
export interface MapQueryVerbs {
  overview?(map: CodeMap, options?: { budget?: number }): string | Promise<string>;
  search?(map: CodeMap, query: string, options?: { budget?: number }): string | Promise<string>;
  explain?(map: CodeMap, symbol: string, options?: { budget?: number }): string | Promise<string>;
  impact?(map: CodeMap, symbol: string, options?: { budget?: number; depth?: number }): string | Promise<string>;
  pathBetween?(map: CodeMap, from: string, to: string, options?: { budget?: number }): string | Promise<string>;
  snippetTarget?(map: CodeMap, symbol: string): SnippetTarget | SnippetCandidates | undefined;
  vocabulary?(map: CodeMap, limit?: number): unknown;
}

export interface SnippetTarget {
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly qn: string;
}
export interface SnippetCandidates {
  readonly candidates: readonly (string | { qn?: string; file?: string })[];
}

export function mapQueryVerbs(): MapQueryVerbs {
  return mapPackage as unknown as MapQueryVerbs;
}

/**
 * The tokens the graph itself knows, for the constrained-vocabulary rule the tool
 * description states: a query is expanded only with words the index reported. Tolerant of
 * whatever shape `vocabulary` answers with, because a suggestion that fails to parse is
 * worth nothing and must cost nothing.
 */
export function vocabularySuggestions(map: CodeMap, term: string | undefined, limit = 12): string[] {
  const verb = mapQueryVerbs().vocabulary;
  if (typeof verb !== "function") return [];
  let value: unknown;
  // Asked for the whole vocabulary, not for a filtered one: the second argument is a row
  // limit, and handing it a search term would be a silent type confusion at the SQL layer.
  try { value = verb(map); } catch { return []; }
  const words: string[] = [];
  const push = (candidate: unknown): void => {
    if (typeof candidate === "string" && candidate.trim().length > 0) { words.push(candidate.trim()); return; }
    if (candidate !== null && typeof candidate === "object") {
      const record = candidate as Record<string, unknown>;
      for (const field of ["term", "token", "name", "word", "qn"]) if (typeof record[field] === "string") { words.push(record[field] as string); return; }
    }
  };
  if (Array.isArray(value)) for (const entry of value) push(entry);
  else if (typeof value === "string") for (const entry of value.split(/[\s,]+/)) push(entry);
  else if (value instanceof Set) for (const entry of value) push(entry);
  else if (value !== null && typeof value === "object") for (const entry of Object.keys(value as Record<string, unknown>)) push(entry);
  const unique = [...new Set(words)];
  // Ranked by what the caller was reaching for when there is something to reach for: a term
  // that shares a stem with the failed query is a usable next query, and the frequency order
  // the graph returned is the fallback.
  const needle = term?.trim().toLowerCase() ?? "";
  const near = needle.length < 3 ? [] : unique.filter((word) => {
    const candidate = word.toLowerCase();
    return candidate.includes(needle) || needle.includes(candidate) || candidate.slice(0, 3) === needle.slice(0, 3);
  });
  return (near.length > 0 ? near : unique).slice(0, limit);
}

function message(error: unknown): string {
  const text = error instanceof Error && error.message.length > 0 ? error.message : String(error);
  return text.endsWith(".") ? text : `${text}.`;
}
