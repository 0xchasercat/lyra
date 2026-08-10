import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type {
  CheckpointDiff,
  CheckpointDiffEndpoint,
  CheckpointFileChange,
  CheckpointGcPolicy,
  CheckpointGcResult,
  CheckpointKind,
  CheckpointRecord,
  CheckpointRestoreResult,
  CheckpointStoreOptions,
  CheckpointTarget,
} from "./types.ts";

/**
 * Everything younger than this is kept unconditionally. A day of work is a day a user
 * may still want to rewind through call by call.
 */
export const CHECKPOINT_KEEP_ALL_MS = 24 * 60 * 60 * 1000;
/** The newest N are always kept, however old they are: a paused session must stay rewindable. */
export const CHECKPOINT_KEEP_RECENT = 200;
/** Past the keep-all window, at most one checkpoint survives per bucket of this width. */
export const CHECKPOINT_THIN_INTERVAL_MS = 60 * 60 * 1000;
/** The hard ceiling. Beyond it the oldest are dropped regardless of age. */
export const CHECKPOINT_MAX_TOTAL = 2_000;

export const DEFAULT_CHECKPOINT_GC_POLICY: Readonly<Required<CheckpointGcPolicy>> = Object.freeze({
  keepAllMs: CHECKPOINT_KEEP_ALL_MS,
  keepRecent: CHECKPOINT_KEEP_RECENT,
  thinIntervalMs: CHECKPOINT_THIN_INTERVAL_MS,
  maxTotal: CHECKPOINT_MAX_TOTAL,
});

/**
 * The hard exclusion set, and the whole of it.
 *
 * The rule is deliberately *not* "honour .gitignore". A checkpoint exists to undo what
 * Lyra did, and a build artifact the model wrote is exactly the kind of thing a user
 * needs restored — gitignored or not. So the shadow index is built with `--force`, which
 * ignores every ignore rule, and only these four paths are held back:
 *
 * - `.lyra` — Lyra's own state, including every other workspace and this repository
 *   itself. Nesting it would grow without bound (a nested-state incident once reached
 *   20 GB).
 * - `node_modules`, `target` — the two churn sinks big enough to make per-tool-call
 *   checkpointing untenable, and both reconstructible from a lockfile or a rebuild.
 * - `.git` — git never adds its own directory, but a *nested* one would become a gitlink;
 *   naming it keeps the intent explicit.
 *
 * Every checkpoint records the set that was in force, so a restore is never quietly
 * partial: what was outside the snapshot is named in the metadata.
 */
export const CHECKPOINT_EXCLUDED_PATHS: readonly string[] = Object.freeze([".lyra", "node_modules", "target", ".git"]);

/** Directory, relative to the working tree, holding the shadow repository. */
export const CHECKPOINT_DIRECTORY = join(".lyra", "checkpoints");
/** The one ref the linear checkpoint chain lives on. */
const CHECKPOINT_REF = "refs/lyra/checkpoints";
/** Trailer keys carried in each checkpoint commit message; the metadata *is* the git object. */
const TRAILER_PREFIX = "lyra-";
/** How many attributed paths one checkpoint records before the list is truncated. */
const MAX_ATTRIBUTED = 200;
/** Default cap on how many per-file patches one diff carries. */
const DEFAULT_PATCH_LIMIT = 50;
/** Default cap on one file's patch text. */
const DEFAULT_PATCH_BYTES = 128 * 1024;
/** How long a contended shadow index is waited out before the checkpoint is abandoned. */
const INDEX_LOCK_RETRY_MS = [25, 75, 200, 500] as const;

interface GitOutput { stdout: string; stderr: string; exitCode: number; }

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/**
 * A second git repository that shadows a session's working directory.
 *
 * `GIT_DIR` is `<root>/.lyra/checkpoints` and the work tree is `<root>` itself, so nothing
 * here can reach the user's real `.git`: no ref of theirs is read, none is written, and a
 * directory that is not a repository at all works identically — which is the point, because
 * the main session now runs in the launch directory and the launch directory is often not a
 * repository.
 *
 * A checkpoint is a commit over a content-addressed tree, so an unchanged tree costs one
 * `write-tree` and no new object at all; the mtime-cached index git maintains natively is
 * what keeps a per-tool-call cadence affordable on a large working tree.
 */
export class CheckpointStore {
  readonly root: string;
  readonly gitDir: string;
  readonly excluded: readonly string[];
  readonly #env: Record<string, string>;
  readonly #now: () => Date;
  readonly #onWarning: ((message: string) => void) | undefined;
  #mutation: Promise<unknown> = Promise.resolve();
  #unavailable: string | undefined;
  #sequence = 0;
  #closed = false;
  /**
   * Paths this store changed itself, waiting for the checkpoint that will record them.
   *
   * Two things put entries here, and both are the same fact: work Lyra did that no *tool*
   * reported, so nothing else would ever attribute it.
   *
   * 1. A restore reverts files. That is Lyra's own doing, and if it goes unattributed the
   *    next restore reads those reversions as somebody else's work and preserves them —
   *    which made "the restore is itself undoable, and the result names the checkpoint that
   *    undoes it" (§10.2) quietly false: `undoWith` resolved, ran, and changed nothing.
   * 2. A checkpoint that collapsed onto its parent records no attribution of its own, so
   *    whatever it was handed has to survive to the next one that actually commits.
   */
  #attribution = new Set<string>();

  private constructor(options: { root: string; gitDir: string; excluded: readonly string[]; env: Record<string, string>; now: () => Date; onWarning?: (message: string) => void }) {
    this.root = options.root;
    this.gitDir = options.gitDir;
    this.excluded = options.excluded;
    this.#env = options.env;
    this.#now = options.now;
    this.#onWarning = options.onWarning;
  }

  /**
   * Opens (creating if needed) the shadow repository for `root`.
   *
   * Never throws for an environment that simply cannot host one — no git, an unwritable
   * directory. Those record a reason on [`unavailable`] and turn every later operation into
   * a no-op, because a session that cannot checkpoint is still a session, and refusing to
   * boot over it would be the worse failure.
   */
  static async open(options: CheckpointStoreOptions): Promise<CheckpointStore> {
    if (!options || typeof options.root !== "string" || options.root.length === 0) throw new TypeError("A checkpoint store needs a working-tree root.");
    const root = resolve(options.root);
    const gitDir = options.gitDir === undefined ? join(root, CHECKPOINT_DIRECTORY) : resolve(options.gitDir);
    const excluded = options.excluded ?? CHECKPOINT_EXCLUDED_PATHS;
    const store = new CheckpointStore({
      root,
      gitDir,
      excluded,
      env: {
        GIT_DIR: gitDir,
        GIT_WORK_TREE: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        // The shadow history is Lyra's own bookkeeping and is never pushed anywhere, so it
        // is authored by Lyra rather than by whoever happens to be at the keyboard — and a
        // host with no configured git identity can still take checkpoints.
        GIT_AUTHOR_NAME: "Lyra", GIT_AUTHOR_EMAIL: "lyra@localhost",
        GIT_COMMITTER_NAME: "Lyra", GIT_COMMITTER_EMAIL: "lyra@localhost",
      },
      now: options.now ?? (() => new Date()),
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
    });
    await store.initialize();
    return store;
  }

  /** Why checkpointing is off, when it is. Undefined means the store is live. */
  get unavailable(): string | undefined { return this.#unavailable; }
  get available(): boolean { return this.#unavailable === undefined && !this.#closed; }

  private async initialize(): Promise<void> {
    try {
      await mkdir(this.gitDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.disable(`the checkpoint directory ${this.gitDir} cannot be created (${errorMessage(error)})`);
      return;
    }
    const version = await this.git(["--version"]);
    if (version.exitCode !== 0) {
      this.disable(`git is not runnable on this host (${version.stderr.trim() || `exit ${version.exitCode}`})`);
      return;
    }
    const existing = await this.git(["rev-parse", "--git-dir"]);
    if (existing.exitCode !== 0) {
      const created = await this.git(["init", "--quiet"]);
      if (created.exitCode !== 0) {
        this.disable(`the checkpoint repository could not be initialised in ${this.gitDir} (${created.stderr.trim() || `exit ${created.exitCode}`})`);
        return;
      }
    }
    // Automatic maintenance is off: garbage collection is an explicit, reported operation
    // (`/cleanup`), never something that stalls a tool call for a second and a half.
    for (const [key, value] of [["gc.auto", "0"], ["core.logAllRefUpdates", "true"], ["core.preloadIndex", "true"], ["core.untrackedCache", "true"], ["core.fsmonitor", "false"], ["core.autocrlf", "false"]] as const) {
      await this.git(["config", key, value]);
    }
    // A marker so a human who finds this directory knows what it is and that deleting it
    // costs only the undo history.
    await writeFile(join(this.gitDir, "README"), CHECKPOINT_README, "utf8").catch(() => undefined);
    // Sequence numbers continue past a restart so ids stay ordered across crashes.
    const head = await this.head();
    this.#sequence = head === undefined ? 0 : sequenceOf(head.id);
  }

  private disable(reason: string): void {
    if (this.#unavailable !== undefined) return;
    this.#unavailable = reason;
    this.#onWarning?.(`Checkpoints are disabled for ${this.root}: ${reason}. Edits are not being snapshotted, so /rollback has nothing to restore.`);
  }

  /**
   * Records the working tree as it stands, and returns the checkpoint that now describes it.
   *
   * An unchanged tree produces no new commit: the previous checkpoint is returned with
   * `collapsed`, which is what makes a checkpoint before *every* state-changing tool call
   * affordable — a run of reads and failed edits costs one `git add` refresh each and not
   * one object.
   *
   * `attributed` names the paths Lyra's own tools reported changing since the previous
   * checkpoint. It is the entire basis of the never-clobber rule: anything that moved in
   * that interval and is not on this list was changed by something other than Lyra.
   */
  async checkpoint(input: {
    kind: CheckpointKind;
    label?: string;
    entryId?: string;
    tool?: string;
    callId?: string;
    attributed?: readonly string[];
  }): Promise<CheckpointRecord | undefined> {
    if (!this.available) return undefined;
    return this.enqueue(async () => {
      if (!this.available) return undefined;
      const parent = await this.head();
      const tree = await this.stageTree();
      if (tree === undefined) return undefined;
      const carried = [...(input.attributed ?? []), ...this.#attribution];
      // A collapse records nothing, so it must not swallow the attribution it was handed:
      // the paths stay pending and ride along on the next checkpoint that commits.
      if (parent !== undefined && parent.tree === tree) {
        for (const path of carried) this.#attribution.add(path);
        return { ...parent, collapsed: true as const };
      }
      const id = this.nextId();
      const attributed = normalizePaths(carried);
      const changed = parent === undefined ? await this.countTreeEntries(tree) : await this.countChanges(parent.tree, tree);
      const message = buildMessage({
        label: input.label ?? defaultLabel(input.kind, input.tool),
        id,
        kind: input.kind,
        createdAt: this.#now().toISOString(),
        changedFiles: changed,
        excluded: this.excluded,
        attributed,
        ...(input.entryId === undefined ? {} : { entryId: input.entryId }),
        ...(input.tool === undefined ? {} : { tool: input.tool }),
        ...(input.callId === undefined ? {} : { callId: input.callId }),
      });
      const commit = await this.commitTree(tree, parent?.commit, message);
      if (commit === undefined) return undefined;
      const updated = await this.git(["update-ref", CHECKPOINT_REF, commit, ...(parent === undefined ? [] : [parent.commit])]);
      if (updated.exitCode !== 0) {
        // Another process moved the ref between the read and the write. The commit object
        // survives and is harmless; the caller simply did not get a checkpoint.
        this.#onWarning?.(`A checkpoint could not be recorded in ${this.root}: ${updated.stderr.trim() || `git update-ref exited ${updated.exitCode}`}. Another Lyra session may be running in the same directory.`);
        return undefined;
      }
      // Recorded, so it is no longer pending. Anything that failed above leaves the set
      // alone: attribution outlives a checkpoint that did not happen.
      for (const path of carried) this.#attribution.delete(path);
      const record = await this.readOne(commit);
      return record;
    });
  }

  /**
   * Newest first. `limit` bounds the scan itself, not just the answer.
   *
   * Waits out any checkpoint still being written — turn boundaries record themselves
   * without blocking the turn, so a listing taken the instant a turn ends would otherwise
   * be one entry short of the truth.
   */
  async list(options: { limit?: number } = {}): Promise<CheckpointRecord[]> {
    // Turn boundaries record themselves without blocking the turn, so a listing taken the
    // instant a turn ends would otherwise be one entry short of the truth. Only the public
    // reads wait; the private `#read` below is what work already inside the queue uses, and
    // it cannot wait for a write it is itself part of.
    await this.#mutation.catch(() => undefined);
    return this.#read(options);
  }

  async #read(options: { limit?: number } = {}): Promise<CheckpointRecord[]> {
    if (!this.available) return [];
    const limit = options.limit === undefined ? undefined : Math.max(1, Math.trunc(options.limit));
    const log = await this.git(["log", "--format=%H%x00%T%x00%B%x01", ...(limit === undefined ? [] : [`-n${limit}`]), CHECKPOINT_REF]);
    if (log.exitCode !== 0) return [];
    return log.stdout.split("\x01").flatMap((block) => {
      const trimmed = block.replace(/^\n+/, "");
      if (trimmed.trim().length === 0) return [];
      const [commit, tree, body] = trimmed.split("\x00");
      if (commit === undefined || tree === undefined || body === undefined) return [];
      return [parseRecord(commit.trim(), tree.trim(), body)];
    });
  }

  /**
   * One checkpoint by stable id, by shadow-commit oid, or by `latest`/`HEAD`.
   *
   * The stable id is the addressable one: garbage collection rewrites the chain to drop
   * thinned checkpoints, which changes every commit oid downstream of the first drop but
   * carries the `lyra-id` trailers across unchanged. An id a transcript recorded therefore
   * keeps resolving for as long as the checkpoint itself survives.
   */
  async resolve(reference: string): Promise<CheckpointRecord | undefined> {
    await this.#mutation.catch(() => undefined);
    return this.#find(reference);
  }

  async #find(reference: string): Promise<CheckpointRecord | undefined> {
    if (!this.available) return undefined;
    const wanted = reference.trim();
    if (wanted.length === 0 || wanted === "latest" || wanted === "HEAD") return this.head();
    const all = await this.#read();
    const byId = all.find((record) => record.id === wanted);
    if (byId !== undefined) return byId;
    return all.find((record) => record.commit === wanted || (wanted.length >= 7 && record.commit.startsWith(wanted)));
  }

  /**
   * The newest checkpoint, or undefined when nothing has been recorded yet.
   *
   * Deliberately does not wait on the write queue: it is called from inside one.
   */
  async head(): Promise<CheckpointRecord | undefined> {
    const rows = await this.#read({ limit: 1 });
    return rows[0];
  }

  /**
   * What changed between two checkpoints, or between a checkpoint and the live tree.
   *
   * `to` defaults to the live working tree and `from` to the newest checkpoint, which makes
   * the no-argument form "what has happened since the last snapshot". Patches are per file
   * rather than one blob: the renderer wants a summary row per path and the hunks for the
   * one path it expanded, and reassembling that from a single mega-patch is the client-side
   * parsing this protocol exists to avoid.
   */
  async diff(options: { from?: CheckpointTarget; to?: CheckpointTarget; patches?: boolean; limit?: number; maxPatchBytes?: number } = {}): Promise<CheckpointDiff> {
    await this.#mutation.catch(() => undefined);
    if (!this.available) return { from: { kind: "empty" }, to: { kind: "worktree" }, files: [], truncated: false, available: false, ...(this.#unavailable === undefined ? {} : { unavailable: this.#unavailable }) };
    const to = await this.resolveTarget(options.to ?? "worktree");
    // With no explicit left-hand side: the live tree is compared against the last
    // checkpoint, and a checkpoint against the one before it — both spellings of "what did
    // this change", which is the only question a bare diff can mean.
    const from = await this.resolveTarget(options.from ?? (to.ref.kind === "worktree" ? "latest" : parentOf(to)));
    if (from.tree === undefined || to.tree === undefined) {
      return { from: from.ref, to: to.ref, files: [], truncated: false, available: true };
    }
    const limit = options.limit === undefined ? DEFAULT_PATCH_LIMIT : Math.max(0, Math.trunc(options.limit));
    const numstat = await this.git(["diff-tree", "-r", "-M", "--numstat", "-z", from.tree, to.tree]);
    const status = await this.git(["diff-tree", "-r", "-M", "--name-status", "-z", from.tree, to.tree]);
    const stats = parseNumstat(numstat.stdout);
    const files = parseNameStatus(status.stdout).map((entry) => {
      const stat = stats.get(entry.path);
      return {
        ...entry,
        ...(stat === undefined ? {} : stat.binary ? { binary: true as const } : { additions: stat.additions, deletions: stat.deletions }),
      } satisfies CheckpointFileChange;
    });
    const truncated = files.length > limit;
    const shown = truncated ? files.slice(0, limit) : files;
    if (options.patches === true) {
      const budget = options.maxPatchBytes ?? DEFAULT_PATCH_BYTES;
      for (const file of shown) {
        if (file.binary === true) continue;
        const patch = await this.git(["diff", "--no-color", "-M", from.tree, to.tree, "--", file.path, ...(file.oldPath === undefined ? [] : [file.oldPath])]);
        if (patch.exitCode !== 0) continue;
        if (patch.stdout.length > budget) { file.patch = patch.stdout.slice(0, budget); file.patchTruncated = true; }
        else file.patch = patch.stdout;
      }
    }
    return { from: from.ref, to: to.ref, files: shown, truncated, available: true };
  }

  /**
   * Restores the working tree to a checkpoint — without ever destroying work Lyra did not do.
   *
   * The order matters and is the whole guarantee:
   *
   * 1. The live tree is checkpointed first, so the state being left is always recoverable
   *    even when the restore turns out to be the wrong move.
   * 2. Everything that changed between the target and now is compared against the paths
   *    Lyra's tools *reported* touching over the same span. What is left over was changed by
   *    something else — an editor, a build, a colleague — and is preserved by name and
   *    reported, never reverted, unless `force` says otherwise.
   * 3. Excluded paths (`.lyra`, `node_modules`, `target`) are outside the index and so are
   *    outside the restore too; the checkpoint metadata names them for exactly this reason.
   */
  async restore(reference: string, options: { force?: boolean } = {}): Promise<CheckpointRestoreResult> {
    if (!this.available) throw new Error(`Checkpoints are unavailable here: ${this.#unavailable ?? "the store is closed"}.`);
    const target = await this.resolve(reference);
    if (target === undefined) throw new Error(`Checkpoint ${reference} does not exist. Run /checkpoints to see the ones that do.`);
    const safety = await this.checkpoint({ kind: "pre_restore", label: `before restoring ${target.id}`, ...(target.entryId === undefined ? {} : { entryId: target.entryId }) });
    if (safety === undefined) throw new Error("The working tree could not be snapshotted before the restore, so the restore was not attempted.");
    return this.enqueue(async () => {
      const changed = await this.changedPaths(target.tree, safety.tree);
      const attributed = await this.attributedBetween(target.id);
      const foreign = options.force === true ? [] : changed.filter((path) => !attributed.has(path));
      const reset = await this.git(["read-tree", "--reset", "-u", target.commit]);
      if (reset.exitCode !== 0) throw new Error(`The checkpoint could not be applied to the working tree: ${reset.stderr.trim() || `git read-tree exited ${reset.exitCode}`}. Nothing was lost — ${safety.id} still holds the state from before this attempt.`);
      if (foreign.length > 0) await this.reinstate(foreign, safety.commit);
      // The index is left describing the tree that is actually on disk, so the next
      // checkpoint measures a real delta rather than re-discovering the restore.
      await this.stageTree();
      const restored = changed.filter((path) => !foreign.includes(path));
      // Reverting a file is Lyra changing it, and nothing else will say so — no tool ran, so
      // no tool reported a path. Without this the next restore reads every reversion as
      // somebody else's work and preserves it, which is exactly the shape of "undo this with
      // <safety.id>" resolving, running, and doing nothing at all.
      for (const path of restored) this.#attribution.add(path);
      return {
        target,
        safety,
        restored,
        preserved: foreign,
        forced: options.force === true,
        excluded: [...this.excluded],
      };
    });
  }

  /**
   * Age-and-count thinning.
   *
   * Everything inside [`CHECKPOINT_KEEP_ALL_MS`] survives, as do the newest
   * [`CHECKPOINT_KEEP_RECENT`]; past that at most one per [`CHECKPOINT_THIN_INTERVAL_MS`]
   * survives, and [`CHECKPOINT_MAX_TOTAL`] is the ceiling regardless. The newest checkpoint
   * is never dropped.
   *
   * Dropping a link out of a linear chain means rewriting the chain, which is why the stable
   * id exists: the rewrite reuses the existing tree objects (no data is copied) and carries
   * every message across verbatim, so ids recorded in a transcript keep resolving.
   */
  async collect(policy: CheckpointGcPolicy = {}): Promise<CheckpointGcResult> {
    if (!this.available) return { kept: 0, dropped: 0, checkpoints: [] };
    const settings = { ...DEFAULT_CHECKPOINT_GC_POLICY, ...policy };
    return this.enqueue(async () => {
      const all = await this.#read();
      if (all.length === 0) return { kept: 0, dropped: 0, checkpoints: [] };
      const now = this.#now().getTime();
      const keep: CheckpointRecord[] = [];
      let lastThinnedBucket: number | undefined;
      for (const [index, record] of all.entries()) {
        const age = now - Date.parse(record.createdAt);
        if (index === 0 || index < settings.keepRecent || !(age > settings.keepAllMs)) { keep.push(record); continue; }
        const bucket = Math.floor(Date.parse(record.createdAt) / settings.thinIntervalMs);
        if (bucket === lastThinnedBucket) continue;
        lastThinnedBucket = bucket;
        keep.push(record);
      }
      const capped = keep.slice(0, Math.max(1, settings.maxTotal));
      const dropped = all.length - capped.length;
      if (dropped === 0) return { kept: capped.length, dropped: 0, checkpoints: capped };
      // Oldest first, so each rewritten commit can name the one before it as its parent.
      let parent: string | undefined;
      const rewritten: string[] = [];
      for (const record of [...capped].reverse()) {
        const commit = await this.commitTree(record.tree, parent, record.message);
        if (commit === undefined) throw new Error("Checkpoint thinning could not rewrite the chain; nothing was dropped.");
        parent = commit;
        rewritten.push(commit);
      }
      const updated = await this.git(["update-ref", CHECKPOINT_REF, parent!]);
      if (updated.exitCode !== 0) throw new Error(`Checkpoint thinning could not update ${CHECKPOINT_REF}: ${updated.stderr.trim()}.`);
      await this.git(["reflog", "expire", "--expire=now", "--all"]);
      await this.git(["gc", "--prune=now", "--quiet"]);
      return { kept: capped.length, dropped, checkpoints: await this.#read({ limit: capped.length }) };
    });
  }

  async close(): Promise<void> { this.#closed = true; await this.#mutation.catch(() => undefined); }

  /**
   * `git add -A --force`, minus the hard exclusion set, then `write-tree`.
   *
   * `--force` is what makes a checkpoint capture gitignored output; the pathspec exclusions
   * are what stop it capturing `.lyra` and the two churn sinks. Ignore rules cannot express
   * that combination, which is why this is a pathspec and not an `info/exclude`.
   */
  private async stageTree(): Promise<string | undefined> {
    const pathspec = [".", ...this.excluded.flatMap((entry) => [`:(exclude,glob)${entry}`, `:(exclude,glob)${entry}/**`, `:(exclude,glob)**/${entry}`, `:(exclude,glob)**/${entry}/**`])];
    for (const [attempt, delay] of [0, ...INDEX_LOCK_RETRY_MS].entries()) {
      if (attempt > 0) await Bun.sleep(delay!);
      const added = await this.git(["add", "-A", "--force", "--", ...pathspec]);
      if (added.exitCode === 0) break;
      const locked = /index\.lock/.test(added.stderr);
      if (!locked) { this.disable(`the working tree could not be staged (${added.stderr.trim() || `git add exited ${added.exitCode}`})`); return undefined; }
      if (attempt === INDEX_LOCK_RETRY_MS.length) {
        this.#onWarning?.(`A checkpoint was skipped in ${this.root}: the shadow index stayed locked. Another Lyra session is probably running in this directory; run one session per directory so checkpoints stay coherent.`);
        return undefined;
      }
    }
    const tree = await this.git(["write-tree"]);
    if (tree.exitCode !== 0) { this.disable(`the working tree could not be written (${tree.stderr.trim() || `git write-tree exited ${tree.exitCode}`})`); return undefined; }
    return tree.stdout.trim();
  }

  private async commitTree(tree: string, parent: string | undefined, message: string): Promise<string | undefined> {
    const result = await this.git(["commit-tree", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", message]);
    if (result.exitCode !== 0) { this.#onWarning?.(`A checkpoint commit failed in ${this.root}: ${result.stderr.trim() || `git commit-tree exited ${result.exitCode}`}.`); return undefined; }
    return result.stdout.trim();
  }

  private async readOne(commit: string): Promise<CheckpointRecord | undefined> {
    const log = await this.git(["log", "-n1", "--format=%H%x00%T%x00%B", commit]);
    if (log.exitCode !== 0) return undefined;
    const [oid, tree, body] = log.stdout.split("\x00");
    if (oid === undefined || tree === undefined || body === undefined) return undefined;
    return parseRecord(oid.trim(), tree.trim(), body);
  }

  /** Paths that differ between two trees, rename-aware on both sides. */
  private async changedPaths(fromTree: string, toTree: string): Promise<string[]> {
    const result = await this.git(["diff-tree", "-r", "-M", "--name-status", "-z", fromTree, toTree]);
    if (result.exitCode !== 0) return [];
    const paths = new Set<string>();
    for (const change of parseNameStatus(result.stdout)) {
      paths.add(change.path);
      if (change.oldPath !== undefined) paths.add(change.oldPath);
    }
    return [...paths].sort();
  }

  /**
   * Every path Lyra's own tools claimed, over the span the restore would undo.
   *
   * Walked newest-first from the chain head down to (and excluding) the target: those are
   * exactly the intervals a restore to `afterId` would roll back. A target that is not on
   * the chain at all — thinned away, or from a rewritten history — attributes nothing, so
   * every change reads as foreign. That is the conservative direction, and for a rule whose
   * whole job is not destroying someone else's work, conservative is correct.
   */
  private async attributedBetween(afterId: string): Promise<Set<string>> {
    const chain = await this.#read();
    const paths = new Set<string>();
    for (const record of chain) {
      if (record.id === afterId) return paths;
      for (const path of record.attributed) paths.add(path);
    }
    return new Set();
  }

  /** Put back the paths the restore was not allowed to revert. */
  private async reinstate(paths: readonly string[], safetyCommit: string): Promise<void> {
    const present = new Set((await this.git(["ls-tree", "-r", "--name-only", "-z", safetyCommit])).stdout.split("\0").filter(Boolean));
    const restore = paths.filter((path) => present.has(path));
    const remove = paths.filter((path) => !present.has(path));
    if (restore.length > 0) await this.git(["checkout", safetyCommit, "--", ...restore]);
    // Present in the target and absent from the live tree means a human deleted it after the
    // checkpoint; re-creating it would be exactly the clobber this rule forbids.
    if (remove.length > 0) await this.git(["rm", "-f", "--quiet", "--ignore-unmatch", "--", ...remove]);
  }

  private async countChanges(fromTree: string, toTree: string): Promise<number> {
    const result = await this.git(["diff-tree", "-r", "-M", "--name-only", "-z", fromTree, toTree]);
    return result.exitCode === 0 ? result.stdout.split("\0").filter(Boolean).length : 0;
  }

  private async countTreeEntries(tree: string): Promise<number> {
    const result = await this.git(["ls-tree", "-r", "--name-only", "-z", tree]);
    return result.exitCode === 0 ? result.stdout.split("\0").filter(Boolean).length : 0;
  }

  /**
   * A checkpoint reference, the live tree, or a checkpoint's parent, as a tree oid.
   *
   * The live tree is realised into a *temporary* index so that asking what has changed
   * since the last checkpoint never disturbs the real one — a diff is a question, and a
   * question must not move the state it asks about.
   */
  private async resolveTarget(target: CheckpointTarget): Promise<{ ref: CheckpointDiffEndpoint; tree?: string }> {
    if (target === "worktree") {
      const tree = await this.worktreeTree();
      return { ref: { kind: "worktree" }, ...(tree === undefined ? {} : { tree }) };
    }
    if (typeof target === "object") {
      const child = await this.#find(target.parentOf);
      if (child === undefined) throw new Error(`Checkpoint ${target.parentOf} does not exist. Run /checkpoints to see the ones that do.`);
      const parent = await this.git(["rev-parse", "--verify", "--quiet", `${child.commit}^`]);
      // The first checkpoint of a session has no predecessor; the empty tree is the honest
      // "before", and it renders as "everything here was added".
      if (parent.exitCode !== 0) return { ref: { kind: "empty" }, tree: await this.emptyTree() };
      const record = await this.readOne(parent.stdout.trim());
      return record === undefined ? { ref: { kind: "empty" }, tree: await this.emptyTree() } : { ref: refOf(record), tree: record.tree };
    }
    const record = await this.#find(target);
    if (record === undefined) throw new Error(`Checkpoint ${target} does not exist. Run /checkpoints to see the ones that do.`);
    return { ref: refOf(record), tree: record.tree };
  }

  private async worktreeTree(): Promise<string | undefined> {
    const temporary = join(this.gitDir, `diff-index-${process.pid}-${randomBytes(3).toString("hex")}`);
    const pathspec = [".", ...this.excluded.flatMap((entry) => [`:(exclude,glob)${entry}`, `:(exclude,glob)${entry}/**`, `:(exclude,glob)**/${entry}`, `:(exclude,glob)**/${entry}/**`])];
    try {
      const added = await this.git(["add", "-A", "--force", "--", ...pathspec], { GIT_INDEX_FILE: temporary });
      if (added.exitCode !== 0) return undefined;
      const tree = await this.git(["write-tree"], { GIT_INDEX_FILE: temporary });
      return tree.exitCode === 0 ? tree.stdout.trim() : undefined;
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  private async emptyTree(): Promise<string> {
    const result = await this.git(["hash-object", "-t", "tree", "--stdin"], undefined, "");
    return result.stdout.trim();
  }

  private nextId(): string { return `cp-${++this.#sequence}-${randomBytes(2).toString("hex")}`; }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutation.then(operation, operation);
    this.#mutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private async git(args: readonly string[], extraEnv?: Record<string, string>, stdin?: string): Promise<GitOutput> {
    try {
      const child = Bun.spawn(["git", "-c", "core.excludesFile=/dev/null", "-c", "core.attributesFile=/dev/null", ...args], {
        cwd: this.root,
        env: { ...process.env, ...this.#env, ...extraEnv },
        stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, exitCode };
    } catch (error) { return { stdout: "", stderr: errorMessage(error), exitCode: 127 }; }
  }
}

const CHECKPOINT_README = `This is Lyra's checkpoint repository.

It shadows the working directory above it: GIT_DIR is this folder and the work tree is the
session directory. Your own .git is never read or written by it. Every state-changing tool
call takes a checkpoint here, which is what /rollback restores from.

Deleting this directory costs only the undo history; nothing else depends on it.
`;

/**
 * Writes a checkpoint's metadata into its own commit message.
 *
 * There is no side-car database on purpose: the metadata is a git object, so it survives a
 * crash, a kill -9, and a full disk exactly as well as the tree it describes does.
 */
function buildMessage(fields: {
  label: string; id: string; kind: CheckpointKind; createdAt: string; changedFiles: number;
  excluded: readonly string[]; attributed: readonly string[]; entryId?: string; tool?: string; callId?: string;
}): string {
  const lines = [
    fields.label,
    "",
    `${TRAILER_PREFIX}id: ${fields.id}`,
    `${TRAILER_PREFIX}kind: ${fields.kind}`,
    `${TRAILER_PREFIX}at: ${fields.createdAt}`,
    `${TRAILER_PREFIX}changed: ${fields.changedFiles}`,
    `${TRAILER_PREFIX}excluded: ${fields.excluded.join(",")}`,
  ];
  if (fields.entryId !== undefined) lines.push(`${TRAILER_PREFIX}entry: ${fields.entryId}`);
  if (fields.tool !== undefined) lines.push(`${TRAILER_PREFIX}tool: ${fields.tool}`);
  if (fields.callId !== undefined) lines.push(`${TRAILER_PREFIX}call: ${fields.callId}`);
  for (const path of fields.attributed.slice(0, MAX_ATTRIBUTED)) lines.push(`${TRAILER_PREFIX}touched: ${path}`);
  if (fields.attributed.length > MAX_ATTRIBUTED) lines.push(`${TRAILER_PREFIX}touched-truncated: ${fields.attributed.length - MAX_ATTRIBUTED}`);
  return `${lines.join("\n")}\n`;
}

function parseRecord(commit: string, tree: string, body: string): CheckpointRecord {
  const lines = body.split("\n");
  const label = lines[0]?.trim() ?? "checkpoint";
  const attributed: string[] = [];
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (!line.startsWith(TRAILER_PREFIX)) continue;
    const separator = line.indexOf(": ");
    if (separator < 0) continue;
    const key = line.slice(TRAILER_PREFIX.length, separator);
    const value = line.slice(separator + 2).trim();
    if (key === "touched") attributed.push(value);
    else fields.set(key, value);
  }
  const excluded = fields.get("excluded");
  const changed = Number(fields.get("changed"));
  return {
    id: fields.get("id") ?? commit.slice(0, 12),
    commit,
    tree,
    kind: (fields.get("kind") ?? "manual") as CheckpointKind,
    label,
    createdAt: fields.get("at") ?? new Date(0).toISOString(),
    changedFiles: Number.isFinite(changed) ? changed : 0,
    attributed,
    excluded: excluded === undefined || excluded.length === 0 ? [] : excluded.split(","),
    message: body,
    ...(fields.get("entry") === undefined ? {} : { entryId: fields.get("entry")! }),
    ...(fields.get("tool") === undefined ? {} : { tool: fields.get("tool")! }),
    ...(fields.get("call") === undefined ? {} : { callId: fields.get("call")! }),
    ...(fields.get("touched-truncated") === undefined ? {} : { attributedTruncated: Number(fields.get("touched-truncated")) }),
  };
}

function refOf(record: CheckpointRecord): CheckpointDiffEndpoint {
  return { kind: "checkpoint", id: record.id, label: record.label, createdAt: record.createdAt };
}

function parentOf(target: { ref: CheckpointDiffEndpoint; tree?: string }): CheckpointTarget {
  return target.ref.kind === "checkpoint" && target.ref.id !== undefined ? { parentOf: target.ref.id } : "latest";
}

/**
 * `--numstat -z` emits `adds\tdels\tpath\0`, and for a rename `adds\tdels\t\0old\0new\0` —
 * the empty third column is the signal that two more NUL-separated fields follow. Keyed on
 * the *new* path, which is the one `--name-status` reports the change under.
 */
function parseNumstat(output: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field.length === 0) continue;
    const parts = field.split("\t");
    if (parts.length < 3) continue;
    const binary = parts[0] === "-";
    const additions = binary ? 0 : Number(parts[0]);
    const deletions = parts[1] === "-" ? 0 : Number(parts[1]);
    let path = parts[2] ?? "";
    if (path.length === 0) { path = fields[index + 2] ?? ""; index += 2; }
    if (path.length > 0) stats.set(path, { additions, deletions, binary });
  }
  return stats;
}

function parseNameStatus(output: string): CheckpointFileChange[] {
  const fields = output.split("\0").filter((value) => value.length > 0);
  const changes: CheckpointFileChange[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index]!;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = fields[++index];
      const path = fields[++index];
      if (oldPath === undefined || path === undefined) break;
      changes.push({ path, oldPath, status: letter === "R" ? "renamed" : "copied" });
      continue;
    }
    const path = fields[++index];
    if (path === undefined) break;
    changes.push({ path, status: letter === "A" ? "added" : letter === "D" ? "deleted" : letter === "T" ? "type_changed" : "modified" });
  }
  return changes;
}

function normalizePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0) continue;
    seen.add(path.replace(/^\.\//, ""));
  }
  return [...seen].sort();
}

function defaultLabel(kind: CheckpointKind, tool?: string): string {
  switch (kind) {
    case "turn_start": return "before this turn";
    case "turn_end": return "after this turn";
    case "pre_tool": return tool === undefined ? "before a tool call" : `before ${tool}`;
    case "pre_restore": return "before a restore";
    case "manual": return "checkpoint";
  }
}

function sequenceOf(id: string): number {
  const match = /^cp-(\d+)-/.exec(id);
  return match === null ? 0 : Number(match[1]);
}

/** True when `path` is inside the shadow repository of `root`. Used by callers policing writes. */
export function isCheckpointPath(root: string, path: string): boolean {
  const directory = join(resolve(root), CHECKPOINT_DIRECTORY);
  const candidate = resolve(path);
  return candidate === directory || candidate.startsWith(`${directory}/`) || dirname(candidate) === directory;
}

/** Exists so a caller can name the shadow location without rebuilding the join. */
export function checkpointDirectory(root: string): string { return join(resolve(root), CHECKPOINT_DIRECTORY); }

/** Whether a directory already holds a shadow repository, without opening one. */
export async function hasCheckpointStore(root: string): Promise<boolean> {
  try { return (await stat(join(checkpointDirectory(root), "HEAD"))).isFile(); } catch { return false; }
}
