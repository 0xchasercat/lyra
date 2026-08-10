import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CheckpointMoment, ToolCheckpointer } from "@lyra/core";
import type { CheckpointStore } from "@lyra/git";

/**
 * The tools a checkpoint is taken in front of.
 *
 * Every one of them can change the working tree: `write` and `edit` obviously, `bash`
 * because a command can do anything, `git` because a reset can erase a day, `jit` because a
 * promoted script is written to disk and a run executes arbitrary code, `mcp` because an
 * external server's tool is opaque to us, and `spawn` because a child without `isolated`
 * shares this very directory. Read-only tools — `read`, `grep`, `glob`, `lsp`, `hub`,
 * `skill` — are not on the list, so a survey pass costs nothing at all.
 *
 * Being generous here is affordable because an unchanged tree collapses onto the previous
 * checkpoint and writes no object; the cost of a false positive is one index refresh.
 */
export const CHECKPOINTED_TOOLS: readonly string[] = Object.freeze(["write", "edit", "bash", "git", "jit", "mcp", "spawn"]);

export interface SessionCheckpointerOptions {
  store: CheckpointStore;
  /** The transcript entry a pre-tool checkpoint anchors to, read at the moment it is taken. */
  entryId?: () => string | undefined;
  tools?: readonly string[];
}

/**
 * Binds a [`CheckpointStore`] to one session's tool traffic.
 *
 * It carries the one piece of state the never-clobber rule needs: the paths tools have
 * reported changing since the last checkpoint. Those travel into the next checkpoint as its
 * attribution, which is what lets a restore tell "Lyra wrote this" from "somebody else did"
 * without watching the filesystem.
 */
export class SessionCheckpointer implements ToolCheckpointer {
  readonly store: CheckpointStore;
  readonly #entryId: (() => string | undefined) | undefined;
  readonly #tools: ReadonlySet<string>;
  #pending = new Set<string>();

  constructor(options: SessionCheckpointerOptions) {
    this.store = options.store;
    this.#entryId = options.entryId;
    this.#tools = new Set(options.tools ?? CHECKPOINTED_TOOLS);
  }

  covers(toolName: string): boolean { return this.#tools.has(toolName); }

  async before(moment: CheckpointMoment): Promise<void> {
    const attributed = [...this.#pending];
    this.#pending = new Set();
    const entryId = moment.entryId ?? this.#entryId?.();
    await this.store.checkpoint({
      kind: moment.kind,
      ...(moment.tool === undefined ? {} : { tool: moment.tool }),
      ...(moment.callId === undefined ? {} : { callId: moment.callId }),
      ...(entryId === undefined ? {} : { entryId }),
      attributed,
    });
  }

  /**
   * A tool reports the path it was given — which may be absolute, or relative to the
   * session directory. The checkpoint index speaks only in paths relative to its work tree,
   * so they are normalised here; an absolute path outside the tree is dropped rather than
   * recorded as attribution for something the snapshot does not contain.
   */
  after(input: { tool: string; callId: string; filesModified: readonly string[] }): void {
    for (const path of input.filesModified) {
      if (typeof path !== "string" || path.length === 0) continue;
      if (!isAbsolute(path)) { this.#pending.add(path.replace(/^\.\//, "")); continue; }
      const relative = relativeTo(this.store.root, path);
      if (relative !== undefined) this.#pending.add(relative);
    }
  }

  /** A named checkpoint on demand — `/rollback`'s counterpart and the `git` tool's `checkpoint` op. */
  async mark(label?: string, entryId?: string): Promise<Awaited<ReturnType<CheckpointStore["checkpoint"]>>> {
    const attributed = [...this.#pending];
    this.#pending = new Set();
    const anchor = entryId ?? this.#entryId?.();
    return this.store.checkpoint({ kind: "manual", ...(label === undefined ? {} : { label }), ...(anchor === undefined ? {} : { entryId: anchor }), attributed });
  }
}

/** Where the single-session marker for a directory lives. */
function lockPath(origin: string): string { return join(resolve(origin), ".lyra", "session.lock"); }

export interface ConcurrentSession { pid: number; session: string; startedAt: string; }

/**
 * Claim a directory for this session, and say so when somebody else already has it.
 *
 * Two Lyra sessions in one directory share a checkpoint index, a `.lyra/sessions` folder,
 * and a working tree. That is not forbidden — a second session is sometimes exactly what
 * you want, and refusing to start would be the more annoying failure — but it is worth
 * knowing about, because one session's `/rollback` can revert the other's edits and neither
 * will have attributed them. So this detects it and names the other session; the checkpoint
 * store separately retries a contended index rather than losing a snapshot to it.
 *
 * A marker whose process is gone is reclaimed silently: a crashed session must not make the
 * next one look like a collision.
 */
export async function claimSessionDirectory(origin: string, session: string): Promise<ConcurrentSession | undefined> {
  const path = lockPath(origin);
  let existing: ConcurrentSession | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Partial<ConcurrentSession>;
      if (typeof record.pid === "number" && typeof record.session === "string" && record.pid !== process.pid && isAlive(record.pid)) {
        existing = { pid: record.pid, session: record.session, startedAt: typeof record.startedAt === "string" ? record.startedAt : "an unknown time" };
      }
    }
  } catch { /* no marker, or an unreadable one: either way this session may claim it */ }
  // The newest session owns the marker. The point is to notice a collision, not to win one.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => undefined);
  await writeFile(path, `${JSON.stringify({ pid: process.pid, session, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 }).catch(() => undefined);
  return existing;
}

/** Drop this session's claim. Best effort: a marker left behind is reclaimed by pid liveness. */
export async function releaseSessionDirectory(origin: string): Promise<void> {
  const path = lockPath(origin);
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && (parsed as { pid?: unknown }).pid !== process.pid) return;
  } catch { return; }
  await rm(path, { force: true }).catch(() => undefined);
}

export function describeConcurrentSession(origin: string, other: ConcurrentSession): string {
  return `Another Lyra session (pid ${other.pid}, session ${other.session}, started ${other.startedAt}) is already running in ${origin}. Both write to the same working tree and the same checkpoint history, so a /rollback in one can revert the other's edits — and edits it never attributed are the ones it will refuse to revert, so a restore may come out partial. Run one session per directory, or start the other one elsewhere with --origin.`;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error instanceof Error && "code" in error && (error as { code?: string }).code === "EPERM"; }
}

/**
 * Prove the launch directory can hold Lyra's state before anything else is attempted.
 *
 * The main session runs in the launch directory now, so `.lyra` is created inside whatever
 * the user was standing in — which may be `/usr/share/doc` or a read-only mount. Finding
 * that out here costs one write and produces a sentence naming the directory and the fix;
 * finding it out later produces an EACCES from whichever subsystem happened to write first.
 */
export async function assertWritableOrigin(origin: string): Promise<void> {
  const directory = join(resolve(origin), ".lyra");
  const probe = join(directory, `.write-probe-${process.pid}`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(probe, "", { flag: "w" });
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    throw new Error(
      `Lyra cannot write to ${origin}${code === "" ? "" : ` (${code})`}, and it needs to: sessions, checkpoints, and agent workspaces all live in ${directory}.\n` +
      `  Run Lyra from a directory you own, or point it at one with:  lyra --origin <path>`,
    );
  } finally { await rm(probe, { force: true }).catch(() => undefined); }
}

/** `path` as a work-tree-relative path, or undefined when it escapes `root`. */
function relativeTo(root: string, path: string): string | undefined {
  const rel = relative(resolve(root), resolve(path));
  return rel.length === 0 || rel.startsWith("..") || rel.startsWith(sep) ? undefined : rel;
}

/** True when `path` is inside `root`. Used to decide whether a child shares the parent's tree. */
export function isWithin(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`${sep}`));
}
