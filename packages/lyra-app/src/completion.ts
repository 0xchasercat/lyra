import { stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { globPaths } from "@lyra/tools";
import {
  ACP_COMPLETION_LIMIT_DEFAULT,
  ACP_COMPLETION_LIMIT_MAX,
  type AcpCompletionItem,
  type AcpCompletionResult,
} from "@lyra/acp";

/**
 * Server-side completion for the TUI's composer popups (DESIGN §4: "`@` file mentions
 * (server-ranked, not re-sorted)").
 *
 * Ranking lives here rather than in the client for one reason: the client cannot see the
 * signals. It does not know which paths git ignores, when each file was last touched, or
 * how many candidates were dropped below the limit. A client that re-sorted the ten rows
 * it received would be sorting a sample, not the population, and would reliably bury the
 * file the user meant.
 */

interface IndexedFile {
  /** Workspace-relative, forward-slashed: exactly what the client inserts. */
  readonly path: string;
  readonly lower: string;
  readonly name: string;
  readonly directory: string;
  readonly mtimeMs: number;
}

interface Ranked { readonly file: IndexedFile; readonly tier: number; readonly offset: number; }

/** Prefix beats substring beats subsequence, and a basename hit beats a path hit inside each. */
const TIER_NAME_PREFIX = 0;
const TIER_PATH_PREFIX = 1;
const TIER_NAME_SUBSTRING = 2;
const TIER_PATH_SUBSTRING = 3;
const TIER_FUZZY = 4;
/** An empty query matches everything at one tier, so the mtime tiebreak orders it alone. */
const TIER_ANY = 5;

function slash(value: string): string { return value.split(sep).join("/"); }

/**
 * The file list for one workspace, cached and invalidated by directory mtimes.
 *
 * A cold build walks the tree through `globPaths`, which is the same gitignore-aware
 * machinery `glob` and `grep` use — the ignore chain, its last-match-wins precedence, and
 * the `.git` exclusion are not restated here, so a fix there is a fix for completion too.
 *
 * Validation is not a second walk: a directory's mtime changes whenever an entry is added,
 * removed, or renamed inside it, which is exactly the set of events that changes a *file
 * list*. Editing a file's contents does not invalidate the list — it only makes the
 * recency tiebreak slightly stale, which is not worth a rebuild. The one case this misses
 * is a directory that held only ignored files gaining its first visible one; it corrects
 * itself as soon as any watched directory changes.
 */
export class WorkspaceFileIndex {
  readonly root: string;
  #files: IndexedFile[] = [];
  #directories = new Map<string, number>();
  #built = false;
  #building: Promise<void> | undefined;

  constructor(root: string) {
    if (typeof root !== "string" || root.length === 0) throw new TypeError("A workspace file index needs a root path.");
    this.root = resolve(root);
  }

  /** The current file list, rebuilt only when the tree's shape has actually changed. */
  async files(): Promise<readonly IndexedFile[]> {
    if (this.#built && !(await this.#changed())) return this.#files;
    // Concurrent callers share one walk: a burst of keystrokes must not queue N walks.
    this.#building ??= this.#build().finally(() => { this.#building = undefined; });
    await this.#building;
    return this.#files;
  }

  /** Ranked candidates for `query`, newest-first when the query is empty. */
  async complete(query: string, limit?: number): Promise<AcpCompletionResult> {
    const bound = boundLimit(limit);
    const needle = normalizeQuery(query);
    const ranked: Ranked[] = [];
    for (const file of await this.files()) {
      const hit = score(file, needle);
      if (hit !== undefined) ranked.push(hit);
    }
    ranked.sort(compare);
    return {
      items: ranked.slice(0, bound).map((entry) => item(entry.file)),
      truncated: ranked.length > bound,
    };
  }

  async #build(): Promise<void> {
    const paths = await globPaths("**/*", this.root, this.root);
    const files = await Promise.all(paths.map(async (path): Promise<IndexedFile> => {
      const relativePath = slash(relative(this.root, path));
      const mtimeMs = await stat(path).then((info) => info.mtimeMs, () => 0);
      const cut = relativePath.lastIndexOf("/");
      return {
        path: relativePath,
        lower: relativePath.toLowerCase(),
        name: basename(relativePath),
        directory: cut < 0 ? "" : relativePath.slice(0, cut),
        mtimeMs,
      };
    }));
    const directories = new Set<string>([this.root]);
    for (const file of files) {
      let current = file.directory;
      while (current.length > 0) {
        directories.add(resolve(this.root, current));
        const cut = current.lastIndexOf("/");
        current = cut < 0 ? "" : current.slice(0, cut);
      }
    }
    const stamped = await Promise.all([...directories].map(async (directory) => [
      directory,
      await stat(directory).then((info) => info.mtimeMs, () => Number.NaN),
    ] as const));
    this.#files = files;
    this.#directories = new Map(stamped);
    this.#built = true;
  }

  /** True when any watched directory's mtime moved, or it stopped being readable. */
  async #changed(): Promise<boolean> {
    const checks = await Promise.all([...this.#directories].map(([directory, mtimeMs]) =>
      stat(directory).then((info) => info.mtimeMs === mtimeMs, () => false)));
    return checks.some((unchanged) => !unchanged);
  }
}

function item(file: IndexedFile): AcpCompletionItem {
  return {
    value: file.path,
    label: file.name,
    // A file at the workspace root has no directory to show, and an empty string is not a
    // detail — it is a blank column. Omit it instead.
    ...(file.directory === "" ? {} : { detail: file.directory }),
  };
}

function normalizeQuery(query: string): string {
  if (typeof query !== "string") throw new TypeError("A completion query must be a string.");
  return slash(query).replace(/^\.\//, "").trim().toLowerCase();
}

/** Clamps rather than rejects: a client asking for 500 rows gets the 50 it can render. */
function boundLimit(limit: number | undefined): number {
  if (limit === undefined) return ACP_COMPLETION_LIMIT_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("A completion limit must be a positive integer.");
  return Math.min(limit, ACP_COMPLETION_LIMIT_MAX);
}

function score(file: IndexedFile, needle: string): Ranked | undefined {
  if (needle.length === 0) return { file, tier: TIER_ANY, offset: 0 };
  const name = file.name.toLowerCase();
  if (name.startsWith(needle)) return { file, tier: TIER_NAME_PREFIX, offset: 0 };
  if (file.lower.startsWith(needle)) return { file, tier: TIER_PATH_PREFIX, offset: 0 };
  const inName = name.indexOf(needle);
  if (inName > 0) return { file, tier: TIER_NAME_SUBSTRING, offset: inName };
  const inPath = file.lower.indexOf(needle);
  if (inPath > 0) return { file, tier: TIER_PATH_SUBSTRING, offset: inPath };
  const span = subsequenceSpan(file.lower, needle);
  return span === undefined ? undefined : { file, tier: TIER_FUZZY, offset: span };
}

/**
 * Length of the tightest run that contains `needle` as a subsequence of `haystack`, or
 * undefined when it is not one. A tighter run means the typed characters landed closer
 * together, which is the only thing that separates "src/auth.ts" from a path that happens
 * to scatter a, u, t, h across forty characters.
 */
function subsequenceSpan(haystack: string, needle: string): number | undefined {
  let end = -1;
  let cursor = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found < 0) return undefined;
    cursor = found + 1;
    end = found;
  }
  // Walk back from the end to tighten the start, so a late, dense match scores as dense.
  let start = end;
  for (let index = needle.length - 2; index >= 0; index -= 1) {
    const found = haystack.lastIndexOf(needle[index]!, start - 1);
    if (found < 0) return end + 1;
    start = found;
  }
  return end - start + 1;
}

/** Total and deterministic: two runs over the same tree always produce the same order. */
function compare(a: Ranked, b: Ranked): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.offset !== b.offset) return a.offset - b.offset;
  if (a.file.mtimeMs !== b.file.mtimeMs) return b.file.mtimeMs - a.file.mtimeMs;
  if (a.file.path.length !== b.file.path.length) return a.file.path.length - b.file.path.length;
  return a.file.path.localeCompare(b.file.path);
}
