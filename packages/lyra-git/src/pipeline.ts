import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  AgentWorkspace,
  ApplyResult,
  GitActivity,
  GitConflict,
  GitPipelineOptions,
  PreviewRecord,
  WorkspaceIntegration,
} from "./types.ts";

const NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;
/** Previews, checkpoints, and apply staging all live under .lyra; git must never read them as origin changes. */
const EXCLUDE_ENTRY = "/.lyra/";
/** How many uncommitted paths a child's integration summary carries before it is cut. */
const MAX_INTEGRATION_PATHS = 50;
/** Safe identity for merge commits made in Lyra's throwaway apply clone on an unconfigured host. */
const FALLBACK_GIT_IDENTITY = Object.freeze({ name: "Lyra", email: "lyra@localhost" });
interface GitOutput { stdout: string; stderr: string; exitCode: number; }

/**
 * The *mechanism* for assembling and applying agent work — not a policy, and no longer a
 * mode.
 *
 * There is no observe/stage/auto switch and no consent ceremony any more. Integrating an
 * isolated child's work is the parent model's job, done with ordinary tool calls against
 * the recipe every completed spawn reports (see [`summarizeWorkspace`]). What survives here
 * is what a model cannot reasonably assemble by hand: a preview repository that shows every
 * child's branch in one graph, and a transactional apply that merges into a scratch clone
 * and only touches the origin once the merge has already succeeded.
 */
export class GitPipeline {
  readonly origin: string;
  readonly previewRoot: string;
  readonly applyRoot: string;
  readonly #options: GitPipelineOptions;
  readonly #now: () => Date;

  constructor(options: GitPipelineOptions) {
    if (!options || typeof options !== "object" || typeof options.origin !== "string" || options.origin.length === 0) throw new TypeError("Git pipeline origin is required.");
    this.origin = resolve(options.origin);
    this.previewRoot = join(this.origin, ".lyra", "previews");
    this.applyRoot = join(this.origin, ".lyra", "apply");
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    const root = await this.git(this.origin, ["rev-parse", "--show-toplevel"], signal);
    const [reportedRoot, configuredRoot] = await Promise.all([realpath(root.stdout.trim()).catch(() => resolve(root.stdout.trim())), realpath(this.origin).catch(() => this.origin)]);
    if (root.exitCode !== 0 || reportedRoot !== configuredRoot) throw new Error(`Git pipeline origin ${this.origin} must be a repository root: ${root.stderr.trim() || root.stdout.trim()}.`);
    await this.excludeLyra(signal);
  }

  async preview(workspaces: readonly AgentWorkspace[], name = timestampName(this.#now()), signal?: AbortSignal): Promise<PreviewRecord> {
    await this.initialize(signal);
    validateName(name, "preview name");
    if (!Array.isArray(workspaces) || workspaces.length === 0) throw new TypeError("Preview requires at least one agent workspace.");
    const normalized = workspaces.map(validateWorkspace);
    if (new Set(normalized.map((workspace) => workspace.name)).size !== normalized.length) throw new TypeError("Preview workspace names must be unique.");
    const path = join(this.previewRoot, name);
    await mkdir(this.previewRoot, { recursive: true });
    if (await exists(path)) throw new Error(`Preview ${name} already exists at ${path}.`);
    const clone = await this.git(this.origin, ["clone", "--local", this.origin, path], signal);
    if (clone.exitCode !== 0) throw new Error(`Could not create preview ${name}: ${clone.stderr.trim() || `git exited ${clone.exitCode}`}.`);
    const branches: string[] = [];
    try {
      for (const workspace of normalized) {
        const branch = `agent/${workspace.name}`;
        const fetched = await this.git(path, ["fetch", workspace.path, `HEAD:refs/heads/${branch}`], signal);
        if (fetched.exitCode !== 0) throw new Error(`Could not fetch ${workspace.name} into preview: ${fetched.stderr.trim() || `git exited ${fetched.exitCode}`}.`);
        branches.push(branch);
      }
      const record: PreviewRecord = { name, path, createdAt: this.#now().toISOString(), workspaces: normalized, branches };
      await atomicJson(this.previewMetadata(name), record);
      this.log("preview", false, `assembled ${name} from ${normalized.length} workspace(s)`);
      return record;
    } catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  }

  /**
   * Merge a preview into the origin, transactionally.
   *
   * The merge happens in a throwaway clone; the origin only ever sees a fast `fetch` and
   * `reset --hard` of an already-merged commit, so a conflict costs nothing and leaves no
   * half-merged working tree. The undo is a checkpoint taken immediately before — the same
   * checkpoint mechanism that covers every tool call, rather than a second snapshot system.
   */
  async apply(previewName?: string, signal?: AbortSignal): Promise<ApplyResult> {
    await this.initialize(signal);
    const selectedName = previewName ?? (await this.listPreviews()).at(-1)?.name;
    if (selectedName === undefined) throw new Error("No preview is available to apply.");
    validateName(selectedName, "preview name");
    const preview = await this.loadPreview(selectedName);
    await this.requireCleanOrigin("apply", signal);
    const checkpoint = await this.#options.checkpoints?.checkpoint({ kind: "manual", label: `before applying preview ${selectedName}` });
    const stagingPath = join(this.applyRoot, `${selectedName}-${randomBytes(4).toString("hex")}`);
    await mkdir(this.applyRoot, { recursive: true });
    const clone = await this.git(this.origin, ["clone", "--local", this.origin, stagingPath], signal);
    if (clone.exitCode !== 0) throw new Error(`Could not create transactional apply repository: ${clone.stderr.trim()}.`);
    try {
      // Repository-local identity is deliberately not copied by `git clone`. Carry the
      // origin's effective identity into this disposable clone, and use Lyra's identity only
      // on fresh hosts (such as CI) where the user has configured none. Without this, Git
      // rejects a non-fast-forward merge before it can even report real file conflicts.
      await this.configureApplyIdentity(stagingPath, signal);
      const priorTasks: string[] = [];
      for (const workspace of preview.workspaces) {
        const branch = `agent/${workspace.name}`;
        const fetched = await this.git(stagingPath, ["fetch", preview.path, `refs/heads/${branch}:refs/remotes/preview/${workspace.name}`], signal);
        if (fetched.exitCode !== 0) throw new Error(`Could not fetch preview branch ${branch}: ${fetched.stderr.trim()}.`);
        const merged = await this.git(stagingPath, ["merge", "--no-edit", `refs/remotes/preview/${workspace.name}`], signal);
        if (merged.exitCode !== 0) {
          const files = (await this.git(stagingPath, ["diff", "--name-only", "--diff-filter=U"], signal)).stdout.trim().split("\n").filter(Boolean);
          const conflict: GitConflict = { files, workspace, priorTasks: [...priorTasks] };
          // A resolver is invoked whenever one is configured: there is no mode left to gate
          // it on, and the caller that supplied it is the caller that wanted it.
          if (this.#options.resolver && await this.#options.resolver.resolve({ repo: stagingPath, conflict, allWorkspaces: preview.workspaces }, signal)) {
            const unresolved = (await this.git(stagingPath, ["diff", "--name-only", "--diff-filter=U"], signal)).stdout.trim();
            if (unresolved.length > 0) return { ok: false, preview: selectedName, ...(checkpoint === undefined ? {} : { checkpoint }), conflicts: [conflict], message: `Resolver left unresolved conflicts: ${unresolved}.` };
            const added = await this.git(stagingPath, ["add", "-A"], signal);
            const committed = added.exitCode === 0 ? await this.git(stagingPath, ["commit", "--no-edit"], signal) : added;
            if (committed.exitCode !== 0) return { ok: false, preview: selectedName, ...(checkpoint === undefined ? {} : { checkpoint }), conflicts: [conflict], message: `Resolver changes could not be committed: ${committed.stderr.trim()}.` };
          } else {
            return { ok: false, preview: selectedName, ...(checkpoint === undefined ? {} : { checkpoint }), conflicts: [conflict], message: `Conflicts in ${files.join(", ") || "unknown files"}; preview retained for manual resolution.` };
          }
        }
        priorTasks.push(workspace.task);
      }
      const head = (await this.git(stagingPath, ["rev-parse", "HEAD"], signal)).stdout.trim();
      const reference = `refs/lyra/apply/${timestampName(this.#now())}-${randomBytes(2).toString("hex")}`;
      const fetched = await this.git(this.origin, ["fetch", stagingPath, `HEAD:${reference}`], signal);
      if (fetched.exitCode !== 0) throw new Error(`Could not fetch transactional result: ${fetched.stderr.trim()}.`);
      const reset = await this.git(this.origin, ["reset", "--hard", reference], signal);
      if (reset.exitCode !== 0) throw new Error(`${checkpoint === undefined ? "No checkpoint was taken" : `Checkpoint ${checkpoint.id} still holds the previous state`}, and apply reset failed: ${reset.stderr.trim()}.`);
      this.log("apply", true, `applied preview ${selectedName} at ${head}${checkpoint === undefined ? "" : `; checkpoint ${checkpoint.id}`}`);
      return { ok: true, preview: selectedName, ...(checkpoint === undefined ? {} : { checkpoint }), appliedHead: head, message: `Applied ${preview.workspaces.length} workspace(s)${checkpoint === undefined ? "" : `; undo with /rollback ${checkpoint.id}`}.` };
    } finally { await rm(stagingPath, { recursive: true, force: true }); }
  }

  async listPreviews(): Promise<PreviewRecord[]> {
    try {
      const names = (await readdir(this.previewRoot)).filter((entry) => entry.endsWith(".preview.json")).sort();
      const records: PreviewRecord[] = [];
      for (const name of names) records.push(JSON.parse(await readFile(join(this.previewRoot, name), "utf8")) as PreviewRecord);
      return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch (error) { if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return []; throw error; }
  }

  /** Drop preview repositories older than `minimumAgeMs`; returns the names removed. */
  async cleanupPreviews(minimumAgeMs: number): Promise<string[]> {
    const cutoff = this.#now().getTime() - Math.max(0, minimumAgeMs);
    const dropped: string[] = [];
    for (const preview of await this.listPreviews()) {
      if (Date.parse(preview.createdAt) > cutoff) continue;
      await rm(preview.path, { recursive: true, force: true });
      await rm(this.previewMetadata(preview.name), { force: true });
      dropped.push(preview.name);
    }
    if (dropped.length > 0) this.log("cleanup", false, `dropped ${dropped.length} preview(s)`);
    return dropped;
  }

  private async loadPreview(name: string): Promise<PreviewRecord> {
    try { return JSON.parse(await readFile(this.previewMetadata(name), "utf8")) as PreviewRecord; }
    catch (error) { throw new Error(`Preview ${name} is unavailable: ${error instanceof Error ? error.message : String(error)}.`); }
  }
  private previewMetadata(name: string): string { return join(this.previewRoot, `${name}.preview.json`); }
  /** Hide .lyra through .git/info/exclude so the origin stays clean without rewriting a user-visible .gitignore. */
  private async excludeLyra(signal?: AbortSignal): Promise<void> {
    const gitDir = await this.git(this.origin, ["rev-parse", "--absolute-git-dir"], signal);
    const directory = gitDir.stdout.trim();
    if (gitDir.exitCode !== 0 || directory.length === 0) throw new Error(`Cannot locate the git directory for ${this.origin}: ${gitDir.stderr.trim() || `git exited ${gitDir.exitCode}`}.`);
    await writeExclude(directory);
  }
  private async requireCleanOrigin(operation: string, signal?: AbortSignal): Promise<void> {
    const status = await this.git(this.origin, ["status", "--porcelain"], signal);
    if (status.exitCode !== 0) throw new Error(`Cannot inspect origin before ${operation}: ${status.stderr.trim()}.`);
    if (status.stdout.trim().length > 0) throw new Error(`Origin has tracked or untracked changes; commit, move, or restore them before ${operation} so the merge lands on a state you can name.`);
  }
  private async configureApplyIdentity(repo: string, signal?: AbortSignal): Promise<void> {
    const configuredName = await this.git(this.origin, ["config", "--get", "user.name"], signal);
    const configuredEmail = await this.git(this.origin, ["config", "--get", "user.email"], signal);
    const name = nonEmpty(process.env.GIT_COMMITTER_NAME) ?? nonEmpty(process.env.GIT_AUTHOR_NAME) ?? (configuredName.exitCode === 0 ? nonEmpty(configuredName.stdout) : undefined) ?? FALLBACK_GIT_IDENTITY.name;
    const email = nonEmpty(process.env.GIT_COMMITTER_EMAIL) ?? nonEmpty(process.env.GIT_AUTHOR_EMAIL) ?? (configuredEmail.exitCode === 0 ? nonEmpty(configuredEmail.stdout) : undefined) ?? FALLBACK_GIT_IDENTITY.email;
    for (const [key, value] of [["user.name", name], ["user.email", email]] as const) {
      const set = await this.git(repo, ["config", "--local", key, value], signal);
      if (set.exitCode !== 0) throw new Error(`Could not configure ${key} in transactional apply repository: ${set.stderr.trim() || `git exited ${set.exitCode}`}.`);
    }
  }
  private async git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<GitOutput> {
    if (signal?.aborted) throw signal.reason;
    const child = Bun.spawn(["/usr/bin/env", "git", ...args], { cwd, stdout: "pipe", stderr: "pipe", detached: true });
    const abort = (): void => { if (typeof child.pid === "number" && child.pid > 1) { try { process.kill(-child.pid, "SIGTERM"); } catch {} } try { child.kill("SIGTERM"); } catch {} };
    signal?.addEventListener("abort", abort, { once: true });
    try { const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (signal?.aborted) throw signal.reason; return { stdout, stderr, exitCode }; }
    finally { signal?.removeEventListener("abort", abort); }
  }
  private log(operation: string, destructive: boolean, detail: string): void {
    const activity: GitActivity = { operation, destructive, detail, createdAt: this.#now().toISOString() };
    this.#options.activity?.(activity);
  }
}

/**
 * Hide `.lyra` from a repository's own status, best effort.
 *
 * The main session now runs in the launch directory, so `.lyra` — checkpoints, sessions,
 * previews, child workspaces — sits inside the user's checkout. `.git/info/exclude` is the
 * right place for that: it is per-clone, it is not a file anyone commits, and it leaves a
 * user-authored `.gitignore` untouched. A directory that is not a repository has nothing to
 * exclude and is not an error.
 */
export async function excludeLyraState(origin: string): Promise<boolean> {
  const child = Bun.spawn(["/usr/bin/env", "git", "rev-parse", "--absolute-git-dir"], { cwd: origin, stdout: "pipe", stderr: "ignore" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const directory = stdout.trim();
  if (exitCode !== 0 || directory.length === 0) return false;
  try { await writeExclude(directory); return true; } catch { return false; }
}

async function writeExclude(gitDirectory: string): Promise<void> {
  const file = join(gitDirectory, "info", "exclude");
  const existing = await readFile(file, "utf8").catch(() => "");
  if (existing.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_ENTRY)) return;
  await mkdir(join(gitDirectory, "info"), { recursive: true });
  await writeFile(file, `${existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`}${EXCLUDE_ENTRY}\n`);
}

/**
 * What an isolated child left behind, and the exact commands that integrate it.
 *
 * This replaces the old pipeline modes as the *default* answer to "the child finished, now
 * what": the parent model gets the child's path, a measure of what is there, and a recipe
 * it can run with the `git` tool it already has. Nothing here writes anything; it is a
 * description of a workspace, and a workspace that cannot be read is described as such
 * rather than raising — a spawn that succeeded must not be reported as failed because the
 * summary of it could not be taken.
 */
export async function summarizeWorkspace(input: { origin: string; workspace: string; path: string }): Promise<WorkspaceIntegration> {
  const reference = `refs/lyra/agents/${input.workspace}`;
  const hint = [
    `git fetch ${input.path} HEAD:${reference}`,
    `git diff HEAD..${reference}`,
    `git merge --no-ff ${reference}`,
  ];
  const run = async (args: readonly string[], cwd: string): Promise<GitOutput> => {
    try {
      const child = Bun.spawn(["/usr/bin/env", "git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, exitCode };
    } catch (error) { return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 127 }; }
  };
  const head = await run(["rev-parse", "--verify", "--quiet", "HEAD"], input.path);
  if (head.exitCode !== 0) {
    return { workspace: input.workspace, path: input.path, commits: 0, uncommitted: [], truncated: false, unavailable: head.stderr.trim() || "the workspace is not a readable Git repository", hint };
  }
  const status = await run(["status", "--porcelain"], input.path);
  const paths = status.stdout.split("\n").map((line) => line.slice(3).trim()).filter(Boolean);
  // How far the child moved past whatever the origin's HEAD was: `--not` against the origin
  // asks the child's own repository, so no ref is created anywhere to answer the question.
  const originHead = await run(["rev-parse", "--verify", "--quiet", "HEAD"], input.origin);
  const ahead = originHead.exitCode === 0
    ? await run(["rev-list", "--count", "HEAD", `^${originHead.stdout.trim()}`], input.path)
    : await run(["rev-list", "--count", "HEAD"], input.path);
  const commits = Number(ahead.stdout.trim());
  return {
    workspace: input.workspace,
    path: input.path,
    commits: Number.isFinite(commits) ? commits : 0,
    head: head.stdout.trim(),
    uncommitted: paths.slice(0, MAX_INTEGRATION_PATHS),
    truncated: paths.length > MAX_INTEGRATION_PATHS,
    hint: paths.length === 0 ? hint : [...hint, `git -C ${input.path} status --porcelain    # ${paths.length} uncommitted path(s) the fetch above will not carry`],
  };
}

function validateName(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !NAME.test(value)) throw new TypeError(`${label} must match ${NAME.source}.`); }
function validateWorkspace(value: AgentWorkspace): AgentWorkspace {
  if (!value || typeof value !== "object") throw new TypeError("Each preview workspace must be an object.");
  validateName(value.name, "workspace name");
  if (typeof value.path !== "string" || value.path.length === 0 || typeof value.task !== "string" || value.task.length === 0) throw new TypeError(`Workspace ${value.name} needs path and original task contract.`);
  return { name: value.name, path: resolve(value.path), task: value.task };
}
function timestampName(date: Date): string { return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").toLowerCase(); }
function nonEmpty(value: string | undefined): string | undefined { const trimmed = value?.trim(); return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed; }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
async function atomicJson(path: string, value: unknown): Promise<void> { const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`; await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
