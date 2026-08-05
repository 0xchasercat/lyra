import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  AgentWorkspace,
  ApplyResult,
  GitActivity,
  GitConflict,
  GitMode,
  GitPipelineOptions,
  PreviewRecord,
  SnapshotRecord,
} from "./types.ts";

const NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;
interface GitOutput { stdout: string; stderr: string; exitCode: number; }

export class GitPipeline {
  readonly origin: string;
  readonly previewRoot: string;
  readonly snapshotRoot: string;
  readonly applyRoot: string;
  #mode: GitMode;
  #autoConfirmed = false;
  readonly #options: GitPipelineOptions;
  readonly #now: () => Date;

  constructor(options: GitPipelineOptions) {
    if (!options || typeof options !== "object" || typeof options.origin !== "string" || options.origin.length === 0) throw new TypeError("Git pipeline origin is required.");
    this.origin = resolve(options.origin);
    this.previewRoot = join(this.origin, ".lyra", "previews");
    this.snapshotRoot = join(this.origin, ".lyra", "snapshots");
    this.applyRoot = join(this.origin, ".lyra", "apply");
    this.#mode = options.mode ?? "observe";
    if (!isMode(this.#mode)) throw new TypeError("Git mode must be observe, stage, or auto.");
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  get mode(): GitMode { return this.#mode; }

  async initialize(): Promise<void> {
    const root = await this.git(this.origin, ["rev-parse", "--show-toplevel"]);
    const [reportedRoot, configuredRoot] = await Promise.all([realpath(root.stdout.trim()).catch(() => resolve(root.stdout.trim())), realpath(this.origin).catch(() => this.origin)]);
    if (root.exitCode !== 0 || reportedRoot !== configuredRoot) throw new Error(`Git pipeline origin ${this.origin} must be a repository root: ${root.stderr.trim() || root.stdout.trim()}.`);
  }

  async setMode(mode: GitMode): Promise<GitMode> {
    if (!isMode(mode)) throw new TypeError("Git mode must be observe, stage, or auto.");
    if (mode === "auto" && !this.#autoConfirmed) {
      if (!this.#options.confirmAuto) throw new Error("Auto git mode requires an explicit confirmation callback.");
      if (!(await this.#options.confirmAuto())) throw new Error("Auto git mode was not confirmed; mode remains unchanged.");
      this.#autoConfirmed = true;
    }
    this.#mode = mode;
    this.log("mode", false, `git mode set to ${mode}`);
    return mode;
  }

  async preview(workspaces: readonly AgentWorkspace[], name = timestampName(this.#now())): Promise<PreviewRecord> {
    await this.initialize();
    validateName(name, "preview name");
    if (!Array.isArray(workspaces) || workspaces.length === 0) throw new TypeError("Preview requires at least one agent workspace.");
    const normalized = workspaces.map(validateWorkspace);
    if (new Set(normalized.map((workspace) => workspace.name)).size !== normalized.length) throw new TypeError("Preview workspace names must be unique.");
    const path = join(this.previewRoot, name);
    await mkdir(this.previewRoot, { recursive: true });
    if (await exists(path)) throw new Error(`Preview ${name} already exists at ${path}.`);
    const clone = await this.git(this.origin, ["clone", "--local", this.origin, path]);
    if (clone.exitCode !== 0) throw new Error(`Could not create preview ${name}: ${clone.stderr.trim() || `git exited ${clone.exitCode}`}.`);
    const branches: string[] = [];
    try {
      for (const workspace of normalized) {
        const branch = `agent/${workspace.name}`;
        const fetched = await this.git(path, ["fetch", workspace.path, `HEAD:refs/heads/${branch}`]);
        if (fetched.exitCode !== 0) throw new Error(`Could not fetch ${workspace.name} into preview: ${fetched.stderr.trim() || `git exited ${fetched.exitCode}`}.`);
        branches.push(branch);
      }
      const record: PreviewRecord = { name, path, createdAt: this.#now().toISOString(), workspaces: normalized, branches };
      await atomicJson(this.previewMetadata(name), record);
      this.log("preview", false, `assembled ${name} from ${normalized.length} workspace(s)`);
      return record;
    } catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  }

  async apply(previewName: string): Promise<ApplyResult> {
    if (this.#mode === "observe") throw new Error("Git mode observe never touches the main repository; switch to stage or confirmed auto before apply.");
    await this.initialize();
    validateName(previewName, "preview name");
    const preview = await this.loadPreview(previewName);
    await this.requireCleanOrigin("apply");
    const snapshot = await this.snapshot();
    const stagingPath = join(this.applyRoot, `${previewName}-${randomBytes(4).toString("hex")}`);
    await mkdir(this.applyRoot, { recursive: true });
    const clone = await this.git(this.origin, ["clone", "--local", this.origin, stagingPath]);
    if (clone.exitCode !== 0) throw new Error(`Could not create transactional apply repository: ${clone.stderr.trim()}.`);
    try {
      const priorTasks: string[] = [];
      for (const workspace of preview.workspaces) {
        const branch = `agent/${workspace.name}`;
        const fetched = await this.git(stagingPath, ["fetch", preview.path, `refs/heads/${branch}:refs/remotes/preview/${workspace.name}`]);
        if (fetched.exitCode !== 0) throw new Error(`Could not fetch preview branch ${branch}: ${fetched.stderr.trim()}.`);
        const merged = await this.git(stagingPath, ["merge", "--no-edit", `refs/remotes/preview/${workspace.name}`]);
        if (merged.exitCode !== 0) {
          const files = (await this.git(stagingPath, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim().split("\n").filter(Boolean);
          const conflict: GitConflict = { files, workspace, priorTasks: [...priorTasks] };
          if (this.#mode === "auto" && this.#options.resolver && await this.#options.resolver.resolve({ repo: stagingPath, conflict, allWorkspaces: preview.workspaces })) {
            const unresolved = (await this.git(stagingPath, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim();
            if (unresolved.length > 0) return { ok: false, preview: previewName, snapshot, conflicts: [conflict], message: `Resolver left unresolved conflicts: ${unresolved}.` };
            const added = await this.git(stagingPath, ["add", "-A"]);
            const committed = added.exitCode === 0 ? await this.git(stagingPath, ["commit", "--no-edit"]) : added;
            if (committed.exitCode !== 0) return { ok: false, preview: previewName, snapshot, conflicts: [conflict], message: `Resolver changes could not be committed: ${committed.stderr.trim()}.` };
          } else {
            return { ok: false, preview: previewName, snapshot, conflicts: [conflict], message: `Conflicts in ${files.join(", ") || "unknown files"}; preview retained for manual resolution.` };
          }
        }
        priorTasks.push(workspace.task);
      }
      const head = (await this.git(stagingPath, ["rev-parse", "HEAD"])).stdout.trim();
      const reference = `refs/lyra/apply/${timestampName(this.#now())}-${randomBytes(2).toString("hex")}`;
      const fetched = await this.git(this.origin, ["fetch", stagingPath, `HEAD:${reference}`]);
      if (fetched.exitCode !== 0) throw new Error(`Could not fetch transactional result: ${fetched.stderr.trim()}.`);
      const reset = await this.git(this.origin, ["reset", "--hard", reference]);
      if (reset.exitCode !== 0) throw new Error(`Snapshot exists at ${snapshot.name}, but apply reset failed: ${reset.stderr.trim()}.`);
      this.log("apply", true, `applied preview ${previewName} at ${head}; snapshot ${snapshot.name}`);
      return { ok: true, preview: previewName, snapshot, appliedHead: head, message: `Applied ${preview.workspaces.length} workspace(s); rollback snapshot ${snapshot.name}.` };
    } finally { await rm(stagingPath, { recursive: true, force: true }); }
  }

  async snapshot(name = `snapshot-${timestampName(this.#now())}`): Promise<SnapshotRecord> {
    await this.initialize();
    validateName(name, "snapshot name");
    const path = join(this.snapshotRoot, name);
    await mkdir(this.snapshotRoot, { recursive: true });
    if (await exists(path)) throw new Error(`Snapshot ${name} already exists.`);
    const head = (await this.git(this.origin, ["rev-parse", "HEAD"])).stdout.trim();
    const branchOutput = await this.git(this.origin, ["symbolic-ref", "--short", "HEAD"]);
    const branch = branchOutput.exitCode === 0 ? branchOutput.stdout.trim() : "HEAD";
    const clone = await this.git(this.origin, ["clone", "--local", this.origin, path]);
    if (clone.exitCode !== 0) throw new Error(`Could not create snapshot ${name}: ${clone.stderr.trim()}.`);
    const record: SnapshotRecord = { name, path, createdAt: this.#now().toISOString(), head, branch };
    await atomicJson(this.snapshotMetadata(name), record);
    this.log("snapshot", false, `created ${name} at ${head}`);
    return record;
  }

  async rollback(name?: string): Promise<SnapshotRecord> {
    await this.initialize();
    const snapshots = await this.listSnapshots();
    const selected = name === undefined ? snapshots.at(-1) : snapshots.find((snapshot) => snapshot.name === name);
    if (!selected) throw new Error(name === undefined ? "No snapshots are available to roll back." : `Snapshot ${name} does not exist.`);
    const reference = `refs/lyra/rollback/${selected.name}-${randomBytes(2).toString("hex")}`;
    const fetched = await this.git(this.origin, ["fetch", selected.path, `HEAD:${reference}`]);
    if (fetched.exitCode !== 0) throw new Error(`Could not fetch snapshot ${selected.name}: ${fetched.stderr.trim()}.`);
    const reset = await this.git(this.origin, ["reset", "--hard", reference]);
    if (reset.exitCode !== 0) throw new Error(`Could not restore snapshot ${selected.name}: ${reset.stderr.trim()}.`);
    this.log("rollback", true, `restored ${selected.name} at ${selected.head}`);
    return selected;
  }

  async listSnapshots(): Promise<SnapshotRecord[]> { return this.readRecords(this.snapshotRoot, ".snapshot.json") as Promise<SnapshotRecord[]>; }
  async listPreviews(): Promise<PreviewRecord[]> { return this.readRecords(this.previewRoot, ".preview.json") as Promise<PreviewRecord[]>; }

  private async readRecords(root: string, suffix: string): Promise<Array<SnapshotRecord | PreviewRecord>> {
    try {
      const names = (await readdir(root)).filter((entry) => entry.endsWith(suffix)).sort();
      const records: Array<SnapshotRecord | PreviewRecord> = [];
      for (const name of names) records.push(JSON.parse(await readFile(join(root, name), "utf8")) as SnapshotRecord | PreviewRecord);
      return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch (error) { if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return []; throw error; }
  }

  private async loadPreview(name: string): Promise<PreviewRecord> {
    try { return JSON.parse(await readFile(this.previewMetadata(name), "utf8")) as PreviewRecord; }
    catch (error) { throw new Error(`Preview ${name} is unavailable: ${error instanceof Error ? error.message : String(error)}.`); }
  }
  private previewMetadata(name: string): string { return join(this.previewRoot, `${name}.preview.json`); }
  private snapshotMetadata(name: string): string { return join(this.snapshotRoot, `${name}.snapshot.json`); }
  private async requireCleanOrigin(operation: string): Promise<void> {
    const status = await this.git(this.origin, ["status", "--porcelain", "--untracked-files=no"]);
    if (status.exitCode !== 0) throw new Error(`Cannot inspect origin before ${operation}: ${status.stderr.trim()}.`);
    if (status.stdout.trim().length > 0) throw new Error(`Origin has tracked changes; commit or restore them before ${operation} so rollback remains exact.`);
  }
  private async git(cwd: string, args: readonly string[]): Promise<GitOutput> {
    const child = Bun.spawn(["/usr/bin/env", "git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  }
  private log(operation: string, destructive: boolean, detail: string): void {
    const activity: GitActivity = { operation, destructive, detail, createdAt: this.#now().toISOString() };
    this.#options.activity?.(activity);
  }
}

function isMode(value: unknown): value is GitMode { return value === "observe" || value === "stage" || value === "auto"; }
function validateName(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !NAME.test(value)) throw new TypeError(`${label} must match ${NAME.source}.`); }
function validateWorkspace(value: AgentWorkspace): AgentWorkspace {
  if (!value || typeof value !== "object") throw new TypeError("Each preview workspace must be an object.");
  validateName(value.name, "workspace name");
  if (typeof value.path !== "string" || value.path.length === 0 || typeof value.task !== "string" || value.task.length === 0) throw new TypeError(`Workspace ${value.name} needs path and original task contract.`);
  return { name: value.name, path: resolve(value.path), task: value.task };
}
function timestampName(date: Date): string { return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").toLowerCase(); }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
async function atomicJson(path: string, value: unknown): Promise<void> { const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`; await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
