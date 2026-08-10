import { constants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { clonefileSupported, nativeCloneEntry, type CloneEntry } from "./clonefile.ts";
import type { WorkspaceMode, WorkspaceRecord, WorkspaceState } from "./types.ts";

const ADJECTIVES = [
  "amber", "brisk", "calm", "clever", "cobalt", "crisp", "daring", "dusky",
  "eager", "fallow", "gentle", "hollow", "keen", "lucid", "mellow", "nimble",
  "opal", "plain", "quiet", "rapid", "sable", "spry", "steady", "tidy",
  "urban", "vivid", "warm", "wily", "young", "zealous",
] as const;
const NOUNS = [
  "arch", "beacon", "brook", "canyon", "cedar", "cliff", "comet", "cove",
  "falcon", "forge", "grove", "harbor", "isle", "lark", "mesa", "orbit",
  "peak", "quartz", "raven", "ridge", "shore", "spark", "summit", "vale",
  "willow", "wren", "yard", "zephyr",
] as const;

const VALID_STATES = new Set<WorkspaceState>([
  "created", "active", "paused", "resumed", "archived", "dropped",
]);
const VALID_MODES = new Set<WorkspaceMode>(["clone", "worktree"]);
const DEFAULT_WORKSPACE_RELATIVE = join(".lyra", "workspaces");

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<GitResult>;

export interface WorkspaceManagerOptions {
  /** The repository root to isolate. `origin` is accepted as an alias. */
  origin?: string;
  originRoot?: string;
  /** Optional override, which must remain below the real origin root. */
  workspaceRoot?: string;
  /** Injectable for deterministic tests; production uses the git executable. */
  git?: GitRunner;
  /**
   * Injectable copy-on-write clone of a single filesystem entry. Production uses macOS
   * `clonefile(2)`; pass `false` to force the portable copy path.
   */
  clonefile?: CloneEntry | false;
  now?: () => Date;
  onRecoveryIssue?: (message: string) => void;
}

export interface WorkspaceCreateOptions {
  name?: string;
  task?: string;
  /** Test and operator escape hatch; the default always tries an independent clone first. */
  mode?: WorkspaceMode;
}

export interface GitCapabilities {
  git: boolean;
  cloneLocal: boolean;
  /** True when the in-kernel hierarchy clone is available (macOS APFS `clonefile(2)`). */
  clonefile: boolean;
}

export class WorkspaceError extends Error {
  readonly code: string;
  readonly details: string | undefined;

  constructor(code: string, message: string, details?: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.details = details;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("/"));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function normalizeInput(value: WorkspaceManagerOptions | string): WorkspaceManagerOptions {
  return typeof value === "string" ? { origin: value } : value;
}

async function defaultGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitResult> {
  if (signal?.aborted) throw signal.reason;
  try {
    const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, detached: true });
    const abort = (): void => { if (typeof child.pid === "number" && child.pid > 1) { try { process.kill(-child.pid, "SIGTERM"); } catch {} } try { child.kill("SIGTERM"); } catch {} };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([child.stdout ? new Response(child.stdout).text() : Promise.resolve(""), child.stderr ? new Response(child.stderr).text() : Promise.resolve(""), child.exited]);
      if (signal?.aborted) throw signal.reason;
      return { stdout, stderr, exitCode };
    } finally { signal?.removeEventListener("abort", abort); }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return { stdout: "", stderr: errorMessage(error), exitCode: 127 };
  }
}

function validateName(name: string): string {
  if (
    name.length === 0 ||
    name.length > 80 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)
  ) {
    throw new WorkspaceError(
      "INVALID_NAME",
      `Invalid workspace name ${JSON.stringify(name)}; use lowercase adjective-noun text without path separators`,
    );
  }
  return name;
}

function cloneRecord(record: WorkspaceRecord): WorkspaceRecord {
  return { ...record };
}

function nowIso(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new WorkspaceError("INVALID_CLOCK", "Workspace clock must return a valid Date");
  }
  return value.toISOString();
}

/**
 * Owns persistent, crash-recoverable repository workspaces.
 *
 * A local clone is the canonical mode: it has its own refs and therefore lets an
 * agent freely reset, stash, rebase, or commit. Git worktrees are only used when
 * the local clone probe/operation fails, and are marked degraded in metadata.
 */
export class WorkspaceManager {
  private readonly options: WorkspaceManagerOptions;
  private readonly originInput: string;
  private readonly git: GitRunner;
  private readonly cloneEntry: CloneEntry | undefined;
  private readonly now: () => Date;
  private readonly records = new Map<string, WorkspaceRecord>();
  private readonly occupiedNames = new Set<string>();
  private readonly recoveryIssues: string[] = [];
  private initialization?: Promise<void>;
  private mutation: Promise<void> = Promise.resolve();
  private originRoot = "";
  private workspaceRoot = "";
  private capabilitiesValue: GitCapabilities = { git: false, cloneLocal: false, clonefile: false };
  private temporaryCounter = 0;

  constructor(optionsOrOrigin: WorkspaceManagerOptions | string) {
    this.options = normalizeInput(optionsOrOrigin);
    this.originInput = this.options.originRoot ?? this.options.origin ?? "";
    if (typeof this.originInput !== "string" || this.originInput.trim() === "") {
      throw new WorkspaceError("INVALID_ORIGIN", "A repository origin root is required");
    }
    this.git = this.options.git ?? defaultGit;
    this.cloneEntry = this.options.clonefile === false
      ? undefined
      : this.options.clonefile ?? (clonefileSupported() ? nativeCloneEntry : undefined);
    this.capabilitiesValue.clonefile = this.cloneEntry !== undefined;
    this.now = this.options.now ?? (() => new Date());
  }

  /** Open and recover a manager before its first operation. */
  static async open(optionsOrOrigin: WorkspaceManagerOptions | string): Promise<WorkspaceManager> {
    const manager = new WorkspaceManager(optionsOrOrigin);
    await manager.ready();
    return manager;
  }

  /** Alias for `open`, useful for callers that treat the manager as a resource. */
  static async create(optionsOrOrigin: WorkspaceManagerOptions | string): Promise<WorkspaceManager> {
    return WorkspaceManager.open(optionsOrOrigin);
  }

  async ready(): Promise<this> {
    await this.initialize();
    return this;
  }

  get origin(): string {
    return this.originRoot;
  }

  get root(): string {
    return this.workspaceRoot;
  }

  get capabilities(): GitCapabilities {
    return { ...this.capabilitiesValue };
  }

  get recoveryWarnings(): readonly string[] {
    return [...this.recoveryIssues];
  }

  async probe(): Promise<GitCapabilities> {
    await this.initialize();
    return this.capabilities;
  }

  private async initialize(): Promise<void> {
    if (!this.initialization) this.initialization = this.load();
    return this.initialization;
  }

  private async load(): Promise<void> {
    const input = resolve(this.originInput);
    try {
      this.originRoot = await realpath(input);
    } catch (error) {
      throw new WorkspaceError(
        "ORIGIN_UNAVAILABLE",
        `Origin repository ${input} cannot be resolved; check that it exists and is accessible`,
        errorMessage(error),
      );
    }

    try {
      const originStat = await lstat(this.originRoot);
      if (!originStat.isDirectory()) throw new Error("origin is not a directory");
    } catch (error) {
      throw new WorkspaceError("INVALID_ORIGIN", `Origin ${this.originRoot} must be a directory`, errorMessage(error));
    }

    const version = await this.runGit(["--version"], this.originRoot);
    if (version.exitCode !== 0) {
      throw new WorkspaceError(
        "GIT_UNAVAILABLE",
        `Git is required to create workspaces; could not run git --version (${version.stderr.trim() || `exit ${version.exitCode}`})`,
      );
    }
    this.capabilitiesValue.git = true;

    const rootProbe = await this.runGit(["-C", this.originRoot, "rev-parse", "--show-toplevel"], this.originRoot);
    if (rootProbe.exitCode !== 0) {
      throw new WorkspaceError(
        "ORIGIN_NOT_GIT",
        `Origin ${this.originRoot} is not a Git working repository; initialize or select a repository root`,
        rootProbe.stderr.trim(),
      );
    }
    let gitRoot = rootProbe.stdout.trim();
    try {
      gitRoot = await realpath(gitRoot);
    } catch {
      // The command succeeded, so the direct origin path remains the useful error context.
      gitRoot = this.originRoot;
    }
    if (gitRoot !== this.originRoot) {
      throw new WorkspaceError(
        "ORIGIN_NOT_ROOT",
        `Origin ${this.originRoot} is inside Git root ${gitRoot}; pass the repository root instead`,
      );
    }

    const cloneProbe = await this.runGit(["clone", "-h"], this.originRoot);
    const cloneHelp = `${cloneProbe.stdout}\n${cloneProbe.stderr}`;
    this.capabilitiesValue.cloneLocal = /(?:^|[\s,])-l(?:[,\s]|$)|--(?:\[no-\])?local/.test(cloneHelp) || cloneProbe.exitCode === 0;

    await this.prepareWorkspaceRoot();
    await this.recoverMetadata();
  }

  private async prepareWorkspaceRoot(): Promise<void> {
    const rawConfigured = this.options.workspaceRoot ? resolve(this.options.workspaceRoot) : join(this.originRoot, DEFAULT_WORKSPACE_RELATIVE);
    const inputOrigin = resolve(this.originInput);
    const configured = this.options.workspaceRoot && isWithin(inputOrigin, rawConfigured)
      ? join(this.originRoot, relative(inputOrigin, rawConfigured))
      : rawConfigured;
    if (!isWithin(this.originRoot, configured)) {
      throw new WorkspaceError(
        "WORKSPACE_ROOT_ESCAPE",
        `Workspace root ${configured} must be beneath origin ${this.originRoot}; refusing an escaping path`,
      );
    }
    await this.rejectEscapingSymlinks(configured);
    try {
      await mkdir(configured, { recursive: true });
    } catch (error) {
      throw new WorkspaceError("WORKSPACE_ROOT_UNAVAILABLE", `Cannot create persistent workspace root ${configured}`, errorMessage(error));
    }
    let canonical: string;
    try {
      canonical = await realpath(configured);
    } catch (error) {
      throw new WorkspaceError("WORKSPACE_ROOT_UNAVAILABLE", `Cannot resolve workspace root ${configured}`, errorMessage(error));
    }
    if (!isWithin(this.originRoot, canonical)) {
      throw new WorkspaceError(
        "WORKSPACE_ROOT_ESCAPE",
        `Workspace root ${configured} resolves outside origin ${this.originRoot}; refusing a symlink escape`,
      );
    }
    const rootStat = await lstat(canonical);
    if (!rootStat.isDirectory()) throw new WorkspaceError("WORKSPACE_ROOT_UNAVAILABLE", `Workspace root ${canonical} is not a directory`);
    this.workspaceRoot = canonical;
  }

  /** Reject an existing symlink component unless its real target remains under origin. */
  private async rejectEscapingSymlinks(target: string): Promise<void> {
    if (!isWithin(this.originRoot, target)) {
      throw new WorkspaceError("PATH_ESCAPE", `Path ${target} is outside origin ${this.originRoot}`);
    }
    const parts = relative(this.originRoot, target).split(sep).filter(Boolean);
    let current = this.originRoot;
    for (const part of parts) {
      current = join(current, part);
      try {
        const entry = await lstat(current);
        if (entry.isSymbolicLink()) {
          const resolved = await realpath(current);
          if (!isWithin(this.originRoot, resolved)) {
            throw new WorkspaceError("SYMLINK_ESCAPE", `Symlink ${current} resolves outside origin; refusing workspace path`);
          }
          current = resolved;
        }
      } catch (error) {
        if (isMissing(error)) break;
        throw error;
      }
    }
  }

  private async runGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitResult> {
    try {
      if (signal?.aborted) throw signal.reason;
      const result = await this.git(args, cwd, signal);
      return {
        exitCode: Number.isFinite(result.exitCode) ? result.exitCode : 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return { exitCode: 127, stdout: "", stderr: errorMessage(error) };
    }
  }

  private metadataPath(name: string): string {
    return join(this.workspaceRoot, `${name}.json`);
  }

  private nextName(): string {
    const total = ADJECTIVES.length * NOUNS.length;
    for (let index = 0; index < total; index += 1) {
      const adjective = ADJECTIVES[Math.floor(index / NOUNS.length)];
      const noun = NOUNS[index % NOUNS.length];
      const name = `${adjective}-${noun}`;
      if (!this.records.has(name) && !this.occupiedNames.has(name)) return name;
    }
    throw new WorkspaceError("NAME_EXHAUSTED", "All curated workspace names are in use; drop an old workspace or provide a name");
  }

  private async assertRoots(): Promise<void> {
    try {
      const current = await realpath(this.workspaceRoot);
      if (current !== this.workspaceRoot || !isWithin(this.originRoot, current)) {
        throw new WorkspaceError("SYMLINK_ESCAPE", `Workspace root ${this.workspaceRoot} no longer resolves beneath origin`);
      }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError("WORKSPACE_ROOT_UNAVAILABLE", `Persistent workspace root ${this.workspaceRoot} is unavailable`, errorMessage(error));
    }
  }

  private async assertWorkspacePath(path: string, mustExist = true): Promise<void> {
    await this.assertRoots();
    if (!isWithin(this.workspaceRoot, path) || dirname(path) !== this.workspaceRoot) {
      throw new WorkspaceError("PATH_ESCAPE", `Workspace path ${path} is outside persistent workspace root`);
    }
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) throw new WorkspaceError("SYMLINK_ESCAPE", `Workspace path ${path} is a symlink; refusing possible escape`);
      const canonical = await realpath(path);
      if (canonical !== path || !isWithin(this.workspaceRoot, canonical)) {
        throw new WorkspaceError("SYMLINK_ESCAPE", `Workspace path ${path} resolves outside persistent workspace root`);
      }
    } catch (error) {
      if (isMissing(error) && !mustExist) return;
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError("WORKSPACE_UNAVAILABLE", `Workspace path ${path} cannot be verified`, errorMessage(error));
    }
  }

  private async removeWorkspace(record: WorkspaceRecord, signal?: AbortSignal): Promise<void> {
    const path = record.path;
    let exists = true;
    try {
      await this.assertWorkspacePath(path);
    } catch (error) {
      if (isMissing(error) || (error instanceof WorkspaceError && error.code === "WORKSPACE_UNAVAILABLE" && error.details?.includes("ENOENT"))) {
        exists = false;
      } else {
        throw error;
      }
    }
    if (!exists) return;

    if (record.mode === "worktree") {
      const result = await this.runGit(["worktree", "remove", "--force", path], this.originRoot, signal);
      if (result.exitCode !== 0) {
        throw new WorkspaceError(
          "WORKTREE_REMOVE_FAILED",
          `Could not remove worktree ${path}; resolve Git worktree state and retry`,
          result.stderr.trim(),
        );
      }
    }
    // rm is deliberate cleanup, never a copy and never follows a symlink after the guard above.
    await rm(path, { recursive: true, force: true });
  }

  private async writeMetadata(record: WorkspaceRecord): Promise<void> {
    await this.assertRoots();
    const destination = this.metadataPath(record.name);
    try {
      const existing = await lstat(destination);
      if (existing.isSymbolicLink()) throw new WorkspaceError("SYMLINK_ESCAPE", `Metadata path ${destination} is a symlink; refusing overwrite`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const temporary = `${destination}.tmp-${process.pid}-${this.temporaryCounter++}`;
    const body = `${JSON.stringify(record, null, 2)}\n`;
    try {
      await writeFile(temporary, body, { encoding: "utf8", flag: "wx" });
      await rename(temporary, destination);
    } catch (error) {
      try {
        await rm(temporary, { force: true });
      } catch {
        // Preserve the original actionable error.
      }
      throw new WorkspaceError("METADATA_WRITE_FAILED", `Cannot atomically write metadata for workspace ${record.name}`, errorMessage(error));
    }
  }

  private async recoverMetadata(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.workspaceRoot, { withFileTypes: true });
    } catch (error) {
      throw new WorkspaceError("METADATA_READ_FAILED", `Cannot inspect workspace metadata in ${this.workspaceRoot}`, errorMessage(error));
    }
    for (const entry of entries) {
      if (entry.isDirectory() && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(entry.name)) this.occupiedNames.add(entry.name);
      if (!entry.name.endsWith(".json") || !entry.isFile()) continue;
      const metadataName = entry.name.slice(0, -5);
      if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(metadataName)) this.occupiedNames.add(metadataName);
      const metadata = join(this.workspaceRoot, entry.name);
      try {
        const parsed: unknown = JSON.parse(await readFile(metadata, "utf8"));
        const record = this.validateRecord(parsed, metadata);
        if (this.records.has(record.name)) throw new Error(`duplicate metadata for ${record.name}`);
        this.records.set(record.name, record);
      } catch (error) {
        const message = `Ignoring malformed workspace metadata ${metadata}: ${errorMessage(error)}`;
        this.recoveryIssues.push(message);
        this.options.onRecoveryIssue?.(message);
      }
    }
  }

  private validateRecord(value: unknown, source: string): WorkspaceRecord {
    if (typeof value !== "object" || value === null) throw new Error("metadata must be an object");
    const candidate = value as Partial<WorkspaceRecord>;
    if (
      typeof candidate.name !== "string" ||
      typeof candidate.path !== "string" ||
      typeof candidate.origin !== "string" ||
      typeof candidate.state !== "string" ||
      typeof candidate.mode !== "string" ||
      typeof candidate.createdAt !== "string" ||
      typeof candidate.updatedAt !== "string"
    ) throw new Error("metadata is missing required fields");
    const name = validateName(candidate.name);
    if (!VALID_STATES.has(candidate.state) || !VALID_MODES.has(candidate.mode)) throw new Error("metadata contains an unknown state or mode");
    const expectedPath = join(this.workspaceRoot, name);
    if (resolve(candidate.path) !== expectedPath) throw new Error("metadata path is not the persistent workspace path");
    if (candidate.origin !== this.originRoot) throw new Error("metadata origin does not match this repository");
    if (candidate.degradedReason !== undefined && typeof candidate.degradedReason !== "string") throw new Error("degradedReason must be text");
    if (candidate.task !== undefined && (typeof candidate.task !== "string" || candidate.task.length === 0)) throw new Error("task must be non-empty text");
    const record: WorkspaceRecord = {
      name,
      path: expectedPath,
      origin: this.originRoot,
      state: candidate.state,
      mode: candidate.mode,
      ...(candidate.degradedReason ? { degradedReason: candidate.degradedReason } : {}),
      ...(candidate.task ? { task: candidate.task } : {}),
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
    };
    if (record.state !== "dropped") {
      // Missing paths are retained for recovery diagnostics and rejected by resume/create operations.
      void source;
    }
    return record;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutation.then(operation, operation);
    this.mutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private async existing(name: string): Promise<WorkspaceRecord> {
    await this.initialize();
    const record = this.records.get(validateName(name));
    if (!record) throw new WorkspaceError("NOT_FOUND", `Workspace ${name} does not exist`);
    return record;
  }

  async create(input: WorkspaceCreateOptions | string = {}, signal?: AbortSignal): Promise<WorkspaceRecord> {
    const requested: WorkspaceCreateOptions = typeof input === "string" ? { name: input } : input;
    if (requested.task !== undefined && (typeof requested.task !== "string" || requested.task.length === 0)) throw new WorkspaceError("INVALID_TASK", "Workspace task must be non-empty text");
    if (signal?.aborted) throw signal.reason;
    return this.enqueue(async () => {
      if (signal?.aborted) throw signal.reason;
      await this.initialize();
      await this.assertRoots();
      const name = requested.name === undefined ? this.nextName() : validateName(requested.name);
      if (this.records.has(name)) throw new WorkspaceError("NAME_IN_USE", `Workspace name ${name} is already in use`);
      const path = join(this.workspaceRoot, name);
      await this.assertWorkspacePath(path, false);
      try {
        const existing = await lstat(path);
        if (existing.isSymbolicLink()) throw new WorkspaceError("SYMLINK_ESCAPE", `Workspace destination ${path} is a symlink; refusing to follow it`);
        throw new WorkspaceError("NAME_IN_USE", `Workspace destination ${path} already exists`);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }

      let mode: WorkspaceMode = "clone";
      let degradedReason: string | undefined;
      let snapshotReason: string | undefined;
      let created = false;
      let mirrored = false;
      if (requested.mode === "worktree") {
        mode = "worktree";
        degradedReason = "Worktree mode was explicitly requested; refs are shared with the origin repository";
      } else {
        // The in-kernel hierarchy clone is the canonical mechanism: it carries `.git`, the
        // uncommitted working tree, and untracked files across as one copy-on-write
        // snapshot, so no checkout and no file-by-file mirror are needed at all.
        snapshotReason = await this.snapshotWorkspace(path, signal);
        if (snapshotReason === undefined) {
          created = true;
          mirrored = true;
        }
      }

      if (!created && requested.mode !== "worktree") {
        if (this.capabilitiesValue.cloneLocal) {
          // `--no-checkout` keeps this path from writing the working tree twice: the copy
          // below is the only pass over the files, and the index is restored afterwards.
          const clone = await this.runGit(["clone", "--local", "--no-checkout", this.originRoot, path], this.originRoot, signal);
          if (clone.exitCode === 0) {
            created = true;
          } else {
            degradedReason = `git clone --local failed (${clone.stderr.trim() || `exit ${clone.exitCode}`}); using a shared-ref worktree instead`;
          }
        } else {
          degradedReason = "git clone --local is unavailable; using a shared-ref worktree instead";
        }
      }

      if (!created) {
        await this.removePartialPath(path);
        mode = "worktree";
        const worktree = await this.runGit(["worktree", "add", "--detach", "--no-checkout", path, "HEAD"], this.originRoot, signal);
        if (worktree.exitCode !== 0) {
          await this.removePartialPath(path);
          throw new WorkspaceError(
            "WORKSPACE_CREATE_FAILED",
            `Could not create workspace ${name} by clone or worktree; check Git and repository permissions`,
            [snapshotReason, degradedReason ?? "clone unavailable", worktree.stderr.trim() || `worktree exit ${worktree.exitCode}`].filter(Boolean).join("; "),
          );
        }
        created = true;
      }
      if (!mirrored) {
        try {
          await this.mirrorWorkingTree(path, signal);
          await this.restoreIndex(path, signal);
        } catch (error) {
          await this.removePartialPath(path).catch(() => undefined);
          throw error;
        }
      }

      try {
        await this.assertWorkspacePath(path);
      } catch (error) {
        await this.removePartialPath(path);
        throw error;
      }
      const timestamp = nowIso(this.now);
      const record: WorkspaceRecord = {
        name,
        path,
        origin: this.originRoot,
        state: "created",
        mode,
        ...(degradedReason ? { degradedReason } : {}),
        ...(requested.task ? { task: requested.task } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      try {
        await this.writeMetadata(record);
      } catch (error) {
        await this.removeWorkspace(record).catch(() => undefined);
        throw error;
      }
      this.records.set(name, record);
      this.occupiedNames.add(name);
      return cloneRecord(record);
    });
  }

  /**
   * Clone the whole origin hierarchy in the kernel.
   *
   * On APFS this is a handful of `clonefile(2)` calls that share extents instead of copying
   * bytes, so `.git`, the uncommitted working tree, and untracked files all arrive as one
   * consistent snapshot — which is exactly the independent-repository semantics a workspace
   * needs. Returns `undefined` on success, or the reason the portable path must run instead.
   */
  private async snapshotWorkspace(destination: string, signal?: AbortSignal): Promise<string | undefined> {
    const clone = this.cloneEntry;
    if (!clone) return "an in-kernel hierarchy clone is unavailable on this host";
    try {
      // A `.git` file means the origin is itself a linked worktree or a submodule; copying
      // that pointer would silently share the origin's refs, the opposite of the intent.
      if (!(await lstat(join(this.originRoot, ".git"))).isDirectory()) return "origin .git is not a directory; only git clone can detach it";
    } catch (error) {
      return `origin .git cannot be inspected (${errorMessage(error)})`;
    }
    let entries: string[];
    try {
      entries = await readdir(this.originRoot);
    } catch (error) {
      return `origin ${this.originRoot} cannot be listed (${errorMessage(error)})`;
    }
    try {
      await mkdir(destination);
    } catch (error) {
      return `workspace directory ${destination} cannot be created (${errorMessage(error)})`;
    }
    try {
      for (const entry of entries) {
        // `.lyra` holds every other workspace; cloning it would nest the tree in itself.
        if (entry === ".lyra") continue;
        if (signal?.aborted) throw signal.reason;
        const outcome = await clone(join(this.originRoot, entry), join(destination, entry));
        // EXDEV, ENOTSUP, or anything else: leave no half-written tree behind and copy.
        if (!outcome.ok) return await this.abandonSnapshot(destination, `clonefile could not clone ${entry} (${outcome.message ?? `errno ${outcome.errno ?? 0}`})`);
      }
      const invalid = await this.verifySnapshot(destination, signal);
      return invalid === undefined ? undefined : await this.abandonSnapshot(destination, invalid);
    } catch (error) {
      await this.removePartialPath(destination).catch(() => undefined);
      throw error;
    }
  }

  private async abandonSnapshot(destination: string, reason: string): Promise<string> {
    await this.removePartialPath(destination).catch(() => undefined);
    return reason;
  }

  /** Confirm the cloned hierarchy is a working repository before anything is recorded. */
  private async verifySnapshot(destination: string, signal?: AbortSignal): Promise<string | undefined> {
    // The origin's index may have been locked mid-operation when the snapshot was taken.
    // The copied lock names no live process and nobody will ever release it, yet git
    // refuses every command while it exists — so the clone's copy is always meaningless.
    await rm(join(destination, ".git", "index.lock"), { force: true });
    const status = await this.runGit(["-C", destination, "status", "--porcelain"], destination, signal);
    if (status.exitCode !== 0) return `cloned snapshot is not a usable repository (${status.stderr.trim() || `git status exit ${status.exitCode}`})`;
    // `git clone --local` points `origin` at the local repository; keep both paths
    // identical so an agent in a workspace can never push straight at the real remote.
    const rewired = await this.runGit(["-C", destination, "remote", "set-url", "origin", this.originRoot], destination, signal);
    if (rewired.exitCode !== 0) {
      const added = await this.runGit(["-C", destination, "remote", "add", "origin", this.originRoot], destination, signal);
      if (added.exitCode !== 0) return `cloned snapshot could not point origin at ${this.originRoot} (${added.stderr.trim() || `git remote exit ${added.exitCode}`})`;
    }
    return undefined;
  }

  /**
   * Copy the live working tree over a `--no-checkout` clone or worktree.
   *
   * The destination holds only `.git` at this point, so every file is written exactly once;
   * the removal loop is a cheap guard against a stale directory, not a second pass.
   */
  private async mirrorWorkingTree(destination: string, signal?: AbortSignal): Promise<void> {
    for (const entry of await readdir(destination)) if (entry !== ".git") await rm(join(destination, entry), { recursive: true, force: true });
    for (const entry of await readdir(this.originRoot)) {
      if (signal?.aborted) throw signal.reason;
      if (entry === ".git" || entry === ".lyra") continue;
      await cp(join(this.originRoot, entry), join(destination, entry), { recursive: true, force: true, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE });
    }
  }

  /**
   * `--no-checkout` leaves an empty index, which would make every copied file look
   * untracked. Point the index back at HEAD; the working tree is not touched.
   */
  private async restoreIndex(destination: string, signal?: AbortSignal): Promise<void> {
    const head = await this.runGit(["-C", destination, "rev-parse", "--verify", "-q", "HEAD"], destination, signal);
    // An unborn HEAD (a repository with no commits) is already described by an empty index.
    if (head.exitCode !== 0) return;
    const reset = await this.runGit(["-C", destination, "reset", "-q", "--mixed", "HEAD"], destination, signal);
    if (reset.exitCode !== 0) {
      throw new WorkspaceError(
        "WORKSPACE_CREATE_FAILED",
        `Could not restore the Git index in workspace ${destination}; the working tree copy would look entirely untracked`,
        reset.stderr.trim() || `git reset exit ${reset.exitCode}`,
      );
    }
  }

  private async removePartialPath(path: string): Promise<void> {
    try {
      await this.assertWorkspacePath(path);
    } catch (error) {
      if (isMissing(error) || (error instanceof WorkspaceError && error.code === "WORKSPACE_UNAVAILABLE")) return;
      throw error;
    }
    await rm(path, { recursive: true, force: true });
  }

  async get(name: string): Promise<WorkspaceRecord | undefined> {
    await this.initialize();
    const record = this.records.get(validateName(name));
    return record ? cloneRecord(record) : undefined;
  }

  async list(): Promise<WorkspaceRecord[]> {
    await this.initialize();
    await this.assertRoots();
    return [...this.records.values()].sort((a, b) => a.name.localeCompare(b.name)).map(cloneRecord);
  }

  async resume(name: string): Promise<WorkspaceRecord> {
    return this.enqueue(async () => {
      const current = await this.existing(name);
      if (current.state === "archived" || current.state === "dropped") {
        throw new WorkspaceError("INVALID_LIFECYCLE", `Workspace ${name} is ${current.state} and cannot be resumed`);
      }
      await this.assertWorkspacePath(current.path);
      const nextState: WorkspaceState = current.state === "created" ? "active" : "resumed";
      const next = { ...current, state: nextState, updatedAt: nowIso(this.now) };
      await this.writeMetadata(next);
      this.records.set(name, next);
      return cloneRecord(next);
    });
  }

  async pause(name: string): Promise<WorkspaceRecord> {
    return this.enqueue(async () => {
      const current = await this.existing(name);
      if (current.state === "archived" || current.state === "dropped") {
        throw new WorkspaceError("INVALID_LIFECYCLE", `Workspace ${name} is ${current.state} and cannot be paused`);
      }
      await this.assertWorkspacePath(current.path);
      const next = { ...current, state: "paused" as const, updatedAt: nowIso(this.now) };
      await this.writeMetadata(next);
      this.records.set(name, next);
      return cloneRecord(next);
    });
  }

  async archive(name: string): Promise<WorkspaceRecord> {
    return this.enqueue(async () => {
      const current = await this.existing(name);
      if (current.state === "dropped") throw new WorkspaceError("INVALID_LIFECYCLE", `Workspace ${name} is already dropped`);
      await this.assertWorkspacePath(current.path);
      const next = { ...current, state: "archived" as const, updatedAt: nowIso(this.now) };
      await this.writeMetadata(next);
      this.records.set(name, next);
      return cloneRecord(next);
    });
  }

  async drop(name: string, signal?: AbortSignal): Promise<WorkspaceRecord> {
    return this.enqueue(async () => {
      const current = await this.existing(name);
      if (current.state === "dropped") return cloneRecord(current);
      const dropped = { ...current, state: "dropped" as const, updatedAt: nowIso(this.now) };
      await this.writeMetadata(dropped);
      try {
        await this.removeWorkspace(current, signal);
      } catch (error) {
        // Keep the tombstone: a retry can finish cleanup without losing lifecycle history.
        this.records.set(name, dropped);
        throw error;
      }
      this.records.set(name, dropped);
      return cloneRecord(dropped);
    });
  }
}

export const workspaceNameParts = {
  adjectives: [...ADJECTIVES],
  nouns: [...NOUNS],
} as const;
