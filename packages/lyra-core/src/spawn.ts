import { isAbsolute, resolve as resolvePath } from "node:path";
import type {
  SpawnActivity,
  SpawnExecutor,
  SpawnExecutorContext,
  SpawnFailureKind,
  SpawnHandle,
  SpawnLifecycleEvent,
  SpawnOutputSchema,
  SpawnRequest,
  SpawnResult,
  SpawnState,
  SpawnStatus,
  SpawnIntegration,
  SpawnManagerOptions,
} from "./spawn-types.ts";

export const DEFAULT_SPAWN_MAX_DEPTH = 2;
export const DEFAULT_SPAWN_MAX_CONCURRENT = Number.MAX_SAFE_INTEGER; // Host pressure is governed by ProcessHost class semaphores.
export const DEFAULT_SPAWN_WAIT_MS = 60 * 60 * 1000;
/** The deliberate ceiling on one wait (§3.4). A longer request is clamped, and the clamp is reported. */
export const MAX_SPAWN_WAIT_MS = DEFAULT_SPAWN_WAIT_MS;
/** Terminal jobs stay listable, but only the most recent ones: a session runs for hours. */
export const DEFAULT_SPAWN_RETAINED_JOBS = 64;
/** How much of a child's output the manager keeps for a status answer. Enough to diagnose, not enough to matter. */
export const SPAWN_PARTIAL_OUTPUT_BUDGET = 2_000;
/** The bus channel every child's lifecycle is published on. `hub wait channel:"agents"` is the parent's event stream. */
export const SPAWN_LIFECYCLE_CHANNEL = "agents";

/** A parent execution context used when a running child creates another child. */
export interface SpawnParentContext {
  id?: string;
  peer?: string;
  parentId?: string;
  depth?: number;
  workspace?: string;
  model?: string;
  tools?: readonly string[];
}

export interface SpawnReport {
  id: string;
  message: string;
}

export interface SpawnContractIssue {
  path: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface SpawnContractDiagnostic {
  code: "output_schema_mismatch";
  message: string;
  issues: readonly SpawnContractIssue[];
}

/** Result fields are deliberately optional: valid results remain the shared contract. */
export interface SpawnDiagnosticResult extends SpawnResult {
  metadata?: Readonly<Record<string, unknown>>;
  error?: SpawnContractDiagnostic;
  /** Non-fatal trouble — cleanup that failed after the work itself already succeeded. */
  warnings?: readonly string[];
}

export class SpawnError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "SpawnError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class SpawnRequestError extends SpawnError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("invalid_request", message, details);
    this.name = "SpawnRequestError";
  }
}

export class SpawnContractError extends SpawnError {
  readonly issues: readonly SpawnContractIssue[];

  constructor(message: string, issues: readonly SpawnContractIssue[]) {
    super("output_schema_mismatch", message, { issues });
    this.name = "SpawnContractError";
    this.issues = issues;
  }
}

export class SpawnCancelledError extends SpawnError {
  constructor(id: string, message = `Spawn ${id} was cancelled`) {
    super("cancelled", message, { id });
    this.name = "SpawnCancelledError";
  }
}

/** Raised to the observer whose wait expired. The job it names keeps running. */
export class SpawnTimeoutError extends SpawnError {
  constructor(id: string, timeoutMs: number, details?: Readonly<Record<string, unknown>>) {
    super("timeout", `Spawn ${id} did not complete within ${timeoutMs}ms`, { id, timeoutMs, ...details });
    this.name = "SpawnTimeoutError";
  }
}

/**
 * The job itself ran out of time — not an observer's wait.
 *
 * Distinct from [`SpawnCancelledError`] because the two ask for different next moves: a
 * deadline says "give it less to do or more time", a cancel says "you stopped it".
 */
export class SpawnDeadlineError extends SpawnError {
  constructor(id: string, message = `Spawn ${id} exceeded its deadline`) {
    super("timed_out", message, { id });
    this.name = "SpawnDeadlineError";
  }
}

/**
 * The child could not be set up, so it never ran a turn.
 *
 * Thrown by an executor that got as far as being called and no further — an unresolvable
 * model, a tool registry it could not build, a missing external harness. It is a separate
 * class rather than a plain failure because the manager has to answer a question a message
 * alone cannot: is there a transcript here to continue? A child that died at resolution has
 * none, so it is marked [`SpawnFailureKind`] `resolution`, refused a revival, and gives its
 * peer name back (see [`SpawnManager.revive`]).
 */
export class SpawnResolutionError extends SpawnError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("resolution_failed", message, details);
    this.name = "SpawnResolutionError";
  }
}

/**
 * A model reference that cannot serve a turn, raised from the spawn call itself.
 *
 * Distinct from [`SpawnResolutionError`], which is a child already in flight discovering the
 * same thing: this one is raised before any child exists, so the caller gets an error where
 * it asked the question rather than a handle to something already dead.
 */
export class SpawnModelError extends SpawnError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("invalid_model", message, details);
    this.name = "SpawnModelError";
  }
}

export class SpawnClosedError extends SpawnError {
  constructor() {
    super("closed", "Spawn manager is closed");
    this.name = "SpawnClosedError";
  }
}

interface SpawnJob {
  readonly id: string;
  peer: string;
  request: SpawnRequest;
  readonly parent?: SpawnParentContext;
  readonly depth: number;
  readonly model?: string;
  readonly tools: readonly string[];
  readonly isolated: boolean;
  readonly writeScope?: readonly string[];
  workspace: string;
  workspaceReady: boolean;
  workspaceName?: string;
  workspaceReleased: boolean;
  /** Set by a revival whose isolated workspace was archived when the child last finished. */
  resumeWorkspace?: boolean;
  readonly handle: SpawnHandle;
  controller: AbortController;
  completion: Promise<SpawnResult>;
  resolve: (result: SpawnResult) => void;
  reject: (error: unknown) => void;
  terminal: boolean;
  queued: boolean;
  /**
   * Whether the executor has ever been entered for this job. Sticky across revivals, because
   * revival is a continuation: a child that ran once has a transcript, and a later run that
   * could not be set up does not retroactively make it a child that never existed.
   */
  started: boolean;
  /** Set when this job's terminal transition gave its peer name back. See [`fail`]. */
  peerReleased: boolean;
  /** Which half of its life the failure came from, once it has failed. */
  failure?: SpawnFailureKind;
  /**
   * The epochs of this job's executions that are still on the wire.
   *
   * A set rather than a boolean because a revival can start a second run while the first is
   * still unwinding: two executors really are running, the concurrency accounting has to say
   * so, and each has to give back its own slot exactly once.
   */
  runs: Set<number>;
  /**
   * Which run of this job is current.
   *
   * A revival re-uses the job — same id, same peer, same transcript — so the executor of a
   * *previous* run can still be unwinding when the next one starts. Without this, that stale
   * run reads the replacement's abort signal (not aborted), sails past its own guard, and
   * settles the revived run with the old run's output.
   */
  epoch: number;
  // Observability. Every one of these is measured from what the executor reported.
  queuedAt: number;
  lastActivity: number;
  toolCalls: number;
  currentTool?: string;
  filesModified: Set<string>;
  scopeViolations: string[];
  partialOutput: string;
  revivals: number;
  error?: string;
  result?: SpawnResult;
  integration?: SpawnIntegration;
}

interface SchemaValidationResult {
  readonly issues: readonly SpawnContractIssue[];
}

const VALID_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
/** Bus names have no whitespace and no control characters; a label becomes one or is refused one. */
const PEER_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/**
 * Owns child execution and its lifecycle. The executor is intentionally injected: this
 * class only schedules, observes, and validates work, and never invents a fallback
 * implementation.
 *
 * It knows nothing about the bus. It names peers and announces transitions through
 * [`onLifecycle`]; whoever owns the bus does the registering, parking and publishing.
 */
export class SpawnManager {
  readonly maxDepth: number;
  readonly maxConcurrent: number;
  readonly defaultWorkspace: string;
  readonly defaultModel: string | undefined;
  readonly availableTools: readonly string[] | undefined;
  /** How many terminal jobs stay inspectable through list() and getHandle(). */
  readonly retainedJobs: number = DEFAULT_SPAWN_RETAINED_JOBS;

  private readonly executor: SpawnExecutor;
  private readonly createWorkspace: SpawnManagerOptions["createWorkspace"];
  private readonly describeWorkspace: SpawnManagerOptions["describeWorkspace"];
  private readonly resolveNamedWorkspace: SpawnManagerOptions["resolveWorkspace"];
  private readonly releaseWorkspace: SpawnManagerOptions["releaseWorkspace"];
  private readonly reservedPeers: SpawnManagerOptions["reservedPeers"];
  /**
   * Not `readonly`, because the only thing that can answer "will this model serve a turn" is
   * the live provider environment, and that is re-read — and replaced — whenever a provider is
   * added mid-session. Whoever owns it installs the check here once the manager exists, rather
   * than the manager being constructed with a closure over an environment that is already stale.
   */
  private validateModel: SpawnManagerOptions["validateModel"];
  private readonly now: () => number;
  private readonly jobs = new Map<string, SpawnJob>();
  private readonly peers = new Map<string, string>();
  private readonly queue: SpawnJob[] = [];
  private readonly reportListeners = new Set<(report: SpawnReport) => void>();
  private readonly lifecycleListeners = new Set<(event: SpawnLifecycleEvent) => void>();
  private readonly executions = new Set<Promise<void>>();
  private nextId = 1;
  private active = 0;
  private closed = false;

  constructor(options: SpawnManagerOptions) {
    if (!options || typeof options !== "object") {
      throw new SpawnRequestError("Spawn manager options are required");
    }
    assertNonEmptyString(options.defaultWorkspace, "defaultWorkspace");
    if (options.defaultModel !== undefined) assertNonEmptyString(options.defaultModel, "defaultModel");
    if (options.executor === undefined || typeof options.executor !== "function") {
      throw new SpawnRequestError("executor must be a function; no fallback executor is provided");
    }
    const maxDepth = options.maxDepth ?? DEFAULT_SPAWN_MAX_DEPTH;
    const maxConcurrent = options.maxConcurrent ?? DEFAULT_SPAWN_MAX_CONCURRENT;
    assertNonNegativeInteger(maxDepth, "maxDepth");
    assertPositiveInteger(maxConcurrent, "maxConcurrent");
    if (options.availableTools !== undefined) assertTools(options.availableTools, "availableTools");
    for (const name of ["createWorkspace", "describeWorkspace", "resolveWorkspace", "releaseWorkspace", "now", "reservedPeers", "validateModel"] as const) {
      if (options[name] !== undefined && typeof options[name] !== "function") {
        throw new SpawnRequestError(`${name} must be a function when provided`);
      }
    }

    this.maxDepth = maxDepth;
    this.maxConcurrent = maxConcurrent;
    this.defaultWorkspace = options.defaultWorkspace;
    this.defaultModel = options.defaultModel;
    this.availableTools = options.availableTools;
    this.executor = options.executor;
    this.createWorkspace = options.createWorkspace;
    this.describeWorkspace = options.describeWorkspace;
    this.resolveNamedWorkspace = options.resolveWorkspace;
    this.releaseWorkspace = options.releaseWorkspace;
    this.reservedPeers = options.reservedPeers;
    this.validateModel = options.validateModel;
    this.now = options.now ?? Date.now;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get runningCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.reduce((count, job) => count + (job.queued && !job.terminal ? 1 : 0), 0);
  }

  /**
   * Install (or clear) the model check [`assertModelUsable`] runs. See [`validateModel`].
   *
   * Separate from the constructor because the manager is built before the thing that can
   * answer the question exists: a provider added mid-session has to be spawnable in the very
   * next turn, so the check reads a live environment rather than one captured at boot.
   */
  setModelValidator(validate: SpawnManagerOptions["validateModel"]): void {
    if (validate !== undefined && typeof validate !== "function") throw new SpawnRequestError("validateModel must be a function when provided");
    this.validateModel = validate;
  }

  /** Listen to reports without coupling the executor to a UI or session. */
  onReport(listener: (report: SpawnReport) => void): () => void {
    if (typeof listener !== "function") throw new SpawnRequestError("report listener must be a function");
    this.reportListeners.add(listener);
    return () => this.reportListeners.delete(listener);
  }

  /**
   * Listen to lifecycle transitions. This is the whole of the manager's outward-facing
   * story about children: who exists, what state each is in, and when that changed.
   */
  onLifecycle(listener: (event: SpawnLifecycleEvent) => void): () => void {
    if (typeof listener !== "function") throw new SpawnRequestError("lifecycle listener must be a function");
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  spawn(request: SpawnRequest & { blocking: true }, parent?: SpawnParentContext): Promise<SpawnDiagnosticResult>;
  spawn(request: SpawnRequest & { blocking?: false | undefined }, parent?: SpawnParentContext): SpawnHandle;
  spawn(request: SpawnRequest, parent?: SpawnParentContext): SpawnHandle | Promise<SpawnDiagnosticResult>;
  spawn(request: SpawnRequest, parent?: SpawnParentContext): SpawnHandle | Promise<SpawnDiagnosticResult> {
    if (request?.blocking === true) {
      try {
        const job = this.enqueue(request, parent);
        return this.wait(job.id, DEFAULT_SPAWN_WAIT_MS);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const job = this.enqueue(request, parent);
    return job.handle;
  }

  /** Explicit async spelling for callers that do not use the blocking request flag. */
  async run(request: SpawnRequest, parent?: SpawnParentContext): Promise<SpawnDiagnosticResult> {
    return await this.spawn({ ...request, blocking: true }, parent);
  }

  /**
   * Whether an explicitly requested model can serve a turn — asked before anything is queued.
   *
   * This is the fail-fast half of model routing, and it is a separate call rather than part
   * of `spawn` because the check is asynchronous (a credential source has to be asked) while
   * a non-blocking `spawn` returns its handle synchronously by contract. A caller that starts
   * a child from a tool call awaits this first and reports the rejection as the tool's own
   * result; the observed alternative was `status: running`, a handle to a child that could
   * never run, and the reason arriving through the bus minutes later.
   *
   * Only an *explicit* model is checked. An inherited one is the model this session is
   * already serving turns with, and re-probing its credential on every delegation would buy
   * nothing but latency.
   */
  async assertModelUsable(model: string | undefined, signal?: AbortSignal): Promise<void> {
    if (model === undefined || this.validateModel === undefined) return;
    assertNonEmptyString(model, "model");
    try {
      await this.validateModel(model, signal);
    } catch (error: unknown) {
      // Re-raised verbatim: the validator is the only thing that knows *which* failure this
      // is — unknown provider, unknown model, or an unusable one — and flattening those three
      // into one sentence is the defect this path exists to fix.
      if (error instanceof SpawnError) throw error;
      throw new SpawnModelError(error instanceof Error ? error.message : String(error), { model, cause: error });
    }
  }

  /**
   * Every wait has a deadline (§3.4), bounded by MAX_SPAWN_WAIT_MS. The deadline belongs to the
   * observer, never to the job: an expired wait rejects with the job's live status and leaves it
   * running, so one poller cannot kill work that every other observer is still waiting on.
   */
  wait(handleOrId: SpawnHandle | string, timeoutMs = DEFAULT_SPAWN_WAIT_MS): Promise<SpawnDiagnosticResult> {
    const id = typeof handleOrId === "string" ? handleOrId : handleOrId?.id;
    if (typeof id !== "string" || id.length === 0) {
      return Promise.reject(new SpawnRequestError("A spawn id or handle is required to wait"));
    }
    const job = this.resolveJob(id);
    if (!job) return Promise.reject(this.unknownJob(id));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(new SpawnRequestError("wait timeout must be a non-negative finite number"));
    }
    const boundedTimeout = Math.min(timeoutMs, MAX_SPAWN_WAIT_MS);
    if (job.terminal) return job.completion;
    const completion = job.completion;

    return new Promise<SpawnResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new SpawnTimeoutError(job.id, boundedTimeout, {
          status: job.handle.status,
          running: !job.terminal,
          cancelled: false,
          ...(boundedTimeout === timeoutMs ? {} : { requestedTimeoutMs: timeoutMs, maxTimeoutMs: MAX_SPAWN_WAIT_MS }),
        }));
      }, boundedTimeout);
      unrefTimer(timer);
      void completion.then(
        (result) => {
          cleanup();
          resolve(result);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  cancel(handleOrId: SpawnHandle | string, reason?: SpawnError): boolean {
    const id = typeof handleOrId === "string" ? handleOrId : handleOrId?.id;
    if (typeof id !== "string") return false;
    const job = this.resolveJob(id);
    if (!job || job.terminal) return false;
    const error = reason ?? new SpawnCancelledError(job.id);
    const state: SpawnState = error instanceof SpawnDeadlineError || error instanceof SpawnTimeoutError ? "timed_out" : "cancelled";
    job.terminal = true;
    job.queued = false;
    job.error = error.message;
    job.handle.status = state;
    job.lastActivity = this.now();
    job.controller.abort(error);
    job.reject(error);
    this.pump();
    this.pruneTerminalJobs();
    // Last, for the same reason `finish` announces last: a listener may revive this job.
    this.emitLifecycle(job, state === "timed_out" ? "timed_out" : "cancelled");
    return true;
  }

  /** Cancel queued and running work, then wait for every executor to unwind. */
  async close(reason = "Spawn manager closed"): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      const error = new SpawnCancelledError("manager", reason);
      for (const job of this.jobs.values()) if (!job.terminal) this.cancel(job.id, error);
      this.queue.length = 0;
    }
    await Promise.allSettled([...this.executions]);
  }

  getHandle(id: string): SpawnHandle | undefined {
    return this.resolveJob(id)?.handle;
  }

  list(): SpawnHandle[] {
    return [...this.jobs.values()].map((job) => ({ ...job.handle }));
  }

  /** Every child, in the detail a parent needs to decide what to do next. */
  statusList(): SpawnStatus[] {
    return [...this.jobs.values()].map((job) => this.describe(job));
  }

  /**
   * One child's live state, by spawn id or by peer name.
   *
   * Accepting the peer name is not an alias so much as the point: the parent knows children
   * by the name it talks to them with, and being told "unknown spawn id: reviewer" for a
   * child called `reviewer` is exactly the dead end this pass exists to remove.
   */
  status(idOrPeer: string): SpawnStatus | undefined {
    const job = this.resolveJob(idOrPeer);
    return job === undefined ? undefined : this.describe(job);
  }

  /** The spawn id a peer name belongs to, or undefined when nothing answers to it. */
  idForPeer(peer: string): string | undefined {
    return typeof peer === "string" ? this.peers.get(peer) : undefined;
  }

  /**
   * Re-run a terminal child with `message` as its next prompt (LYRA.md §9: "a message
   * revives a parked agent. The only resume primitive").
   *
   * The id, the peer name, the workspace and the transcript all survive — a revived child is
   * the same child, one turn later, not a new one wearing its name. A child that is still
   * running needs no revival and is left alone; the message reaches it as an aside instead.
   *
   * A child that failed at *resolution* is refused rather than restarted. It has no
   * transcript — it never ran — so there is nothing for the message to continue, and whatever
   * would not resolve would not resolve again; restarting it would spend a turn re-deriving
   * the error it already reported. The refusal throws, because "nothing happened" is exactly
   * the answer that sent a user chasing a child that was never coming back.
   */
  revive(idOrPeer: string, message: string): SpawnHandle | undefined {
    if (this.closed) throw new SpawnClosedError();
    assertNonEmptyString(message, "message");
    const job = this.resolveJob(idOrPeer);
    if (!job) return undefined;
    if (!job.terminal) return undefined;
    if (job.failure === "resolution") {
      throw new SpawnResolutionError(
        `Spawn ${job.id} (${job.peer}) cannot be revived: it failed before it ever ran — ${job.error ?? "its model, tools or workspace could not be resolved"}. ` +
        `There is no transcript to continue and the same resolution would fail again, so its name has been released. Fix the spawn call and start a new child with spawn { task: "..." }.`,
        { id: job.id, peer: job.peer, failure: "resolution" satisfies SpawnFailureKind },
      );
    }
    const { promise, resolve, reject } = withResolvers<SpawnResult>();
    void promise.catch(() => undefined);
    job.completion = promise;
    job.resolve = resolve;
    job.reject = reject;
    job.controller = new AbortController();
    job.terminal = false;
    job.queued = true;
    job.epoch += 1;
    job.revivals += 1;
    // A job cancelled while still queued is left in the queue by `cancel` (it is skipped as
    // terminal when pumped). Pushing it again would put the same job in twice.
    for (let index = this.queue.indexOf(job); index >= 0; index = this.queue.indexOf(job)) this.queue.splice(index, 1);
    job.request = { ...job.request, task: message, resume: true };
    delete job.error;
    delete job.failure;
    delete job.result;
    delete job.currentTool;
    job.partialOutput = "";
    job.lastActivity = this.now();
    // A revived isolated child re-enters the workspace it already has; it is never
    // re-created, because a new clone would revive the agent without its work. If that
    // workspace was archived when the child finished — the normal case — it is resumed by
    // name first, which is why this is a resolve rather than a flag flip.
    if (job.workspaceName !== undefined) {
      if (job.workspaceReleased) { job.workspaceReleased = false; job.workspaceReady = false; job.resumeWorkspace = true; }
      else job.workspaceReady = true;
    }
    this.transition(job, "queued", "revived");
    this.queue.push(job);
    this.pump();
    return { ...job.handle };
  }

  private describe(job: SpawnJob): SpawnStatus {
    const partial = job.partialOutput.trim();
    return {
      id: job.id,
      peer: job.peer,
      status: job.handle.status,
      ...(job.request.label === undefined ? {} : { label: job.request.label }),
      workspace: job.workspace,
      ...(job.workspaceName === undefined ? {} : { workspaceName: job.workspaceName }),
      isolated: job.isolated,
      ...(job.model === undefined ? {} : { model: job.model }),
      depth: job.depth,
      ...(job.parent?.id === undefined ? {} : { parentId: job.parent.id }),
      queuedAt: job.queuedAt,
      startedAt: job.handle.startedAt,
      lastActivity: job.lastActivity,
      elapsedMs: Math.max(0, this.now() - job.handle.startedAt),
      toolCalls: job.toolCalls,
      ...(job.currentTool === undefined ? {} : { currentTool: job.currentTool }),
      filesModified: [...job.filesModified],
      ...(job.writeScope === undefined ? {} : { writeScope: [...job.writeScope], writeScopeResolved: resolveScopePaths(job.workspace, job.writeScope) }),
      ...(job.scopeViolations.length === 0 ? {} : { scopeViolations: [...job.scopeViolations] }),
      ...(partial.length === 0 ? {} : { partialOutput: partial }),
      ...(job.revivals === 0 ? {} : { revivals: job.revivals }),
      ...(job.error === undefined ? {} : { error: job.error }),
      ...(job.failure === undefined ? {} : { failure: job.failure }),
      ...(job.terminal ? { revivable: job.failure !== "resolution" } : {}),
      resultAvailable: job.result !== undefined,
      ...(job.integration === undefined ? {} : { integration: job.integration }),
    };
  }

  /** A job by spawn id, or by the bus name it answers to. */
  private resolveJob(reference: string): SpawnJob | undefined {
    if (typeof reference !== "string" || reference.length === 0) return undefined;
    const direct = this.jobs.get(reference);
    if (direct !== undefined) return direct;
    const id = this.peers.get(reference);
    return id === undefined ? undefined : this.jobs.get(id);
  }

  /**
   * The error a bad reference gets: what exists, not just what does not.
   *
   * A retained job ages out (see [`pruneTerminalJobs`]), so "unknown" genuinely can mean
   * "finished a long time ago" — and a parent told only "unknown spawn id" would reasonably
   * conclude the child never existed.
   */
  private unknownJob(reference: string): SpawnRequestError {
    const live = [...this.jobs.values()].filter((job) => !job.terminal).map((job) => `${job.id} (${job.peer}, ${job.handle.status})`);
    const known = [...this.jobs.values()].map((job) => job.id);
    return new SpawnRequestError(
      `No spawn answers to ${JSON.stringify(reference)}. ` +
      (live.length > 0
        ? `Running now: ${live.join(", ")}.`
        : known.length > 0
          ? `Nothing is running; the most recent finished children are ${known.slice(-5).join(", ")}.`
          : `No child has been spawned in this session yet.`) +
      ` Only the ${this.retainedJobs} most recent finished children stay collectable.`,
      { reference, known },
    );
  }

  private enqueue(request: SpawnRequest, parent?: SpawnParentContext): SpawnJob {
    if (this.closed) throw new SpawnClosedError();
    const normalized = this.validateRequest(request, parent);
    const id = `spawn-${this.nextId++}`;
    const createdAt = this.now();
    const peer = this.namePeer(id, request.label);
    const handle: SpawnHandle = {
      id,
      peer,
      workspace: normalized.workspace,
      ...(request.label === undefined ? {} : { label: request.label }),
      status: "queued",
      startedAt: createdAt,
    };
    const { promise: completion, resolve, reject } = withResolvers<SpawnResult>();
    // Non-blocking jobs are allowed to fail without creating an unhandled rejection.
    void completion.catch(() => undefined);
    const job: SpawnJob = {
      id,
      peer,
      request: normalized.request,
      ...(parent === undefined ? {} : { parent }),
      depth: normalized.depth,
      ...(normalized.model === undefined ? {} : { model: normalized.model }),
      tools: normalized.tools,
      isolated: normalized.isolated,
      ...(normalized.writeScope === undefined ? {} : { writeScope: normalized.writeScope }),
      workspace: normalized.workspace,
      workspaceReady: normalized.workspaceReady,
      workspaceReleased: false,
      handle,
      controller: new AbortController(),
      completion,
      resolve,
      reject,
      terminal: false,
      queued: true,
      started: false,
      peerReleased: false,
      runs: new Set<number>(),
      epoch: 0,
      queuedAt: createdAt,
      lastActivity: createdAt,
      toolCalls: 0,
      filesModified: new Set<string>(),
      scopeViolations: [],
      partialOutput: "",
      revivals: 0,
    };
    this.jobs.set(id, job);
    this.peers.set(peer, id);
    this.queue.push(job);
    // Announced before it is pumped, so a listener that registers the peer has done so
    // before the child's own first tool call can address anybody.
    this.emitLifecycle(job, "spawned");
    this.pump();
    return job;
  }

  /**
   * The name this child answers to on the bus.
   *
   * A label if it is usable and free, the spawn id otherwise. Legibility is the point
   * (LYRA.md §9: names are never UUIDs), but a *stable* name matters more: it is minted here,
   * before anything can be addressed to it, and never changes — not when an isolated
   * workspace is created later, and not across a revival. A label that collides with a live
   * peer falls back rather than shadowing it, because two children answering to one name is
   * a lost message, not a naming inconvenience.
   */
  private namePeer(id: string, label?: string): string {
    if (typeof label !== "string") return id;
    const candidate = label.trim().replace(/\s+/g, "-");
    if (!PEER_SAFE.test(candidate)) return id;
    // `spawn-7` as a *label* would collide with the id spawn-7 is eventually minted for,
    // and `resolveJob` checks ids before peer names — one name, two children.
    if (/^spawn-\d+$/.test(candidate)) return id;
    if (this.peers.has(candidate) || this.jobs.has(candidate)) return id;
    if (this.reservedPeers !== undefined) {
      try { for (const taken of this.reservedPeers()) if (taken === candidate) return id; } catch { return id; }
    }
    return candidate;
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) return;
      job.queued = false;
      if (job.terminal) continue;
      job.runs.add(job.epoch);
      job.handle.startedAt = this.now();
      job.lastActivity = job.handle.startedAt;
      // Status only, deliberately unannounced. `starting` is the sliver between being
      // dequeued and the executor being called — usually microseconds, and never long
      // enough to be worth a row on the `agents` channel. A parent that catches a child
      // there (an isolated clone being made) reads it from `spawn status`.
      job.handle.status = "starting";
      this.active += 1;
      const execution = this.execute(job);
      this.executions.add(execution);
      void execution.then(() => this.executions.delete(execution), () => this.executions.delete(execution));
    }
  }

  private async execute(job: SpawnJob): Promise<void> {
    // Captured, not read live: everything below belongs to *this* run of the job, and a
    // revival that starts another one must not be able to steal its result or its slot.
    const epoch = job.epoch;
    const controller = job.controller;
    try {
      if (!job.workspaceReady) await this.resolveWorkspace(job);
      if (controller.signal.aborted) throw controller.signal.reason ?? new SpawnCancelledError(job.id);
      const executionRequest = withResolvedRequest(job.request, job.model, job.tools, job.workspace);
      const context = this.makeExecutorContext(job, epoch, controller);
      // Recorded before the call, not after it returns: this is the fact `fail` reads to tell
      // a child that never got as far as an executor from one that ran and broke.
      job.started = true;
      this.transition(job, "running", "started");
      const output = await this.executor(executionRequest, context);
      if (controller.signal.aborted) throw controller.signal.reason ?? new SpawnCancelledError(job.id);
      // Measured before the workspace is released, and never allowed to fail the job: the
      // work is done either way, and a summary that could not be taken is reported as such.
      const integration = await this.describeIsolatedWorkspace(job, controller);
      if (integration !== undefined) job.integration = integration;
      const result = this.makeResult(job, output, integration);
      const contractResult = this.applyOutputContract(job.request, result);
      // Work that succeeded stays successful: a failed release is a warning, not a verdict.
      const releaseError = await this.releaseIsolatedWorkspace(job);
      this.finish(job, epoch, releaseError === undefined ? contractResult : withWarning(contractResult, releaseWarning(job, releaseError)));
    } catch (error: unknown) {
      // The original failure is the reportable one; cleanup trouble must never shadow it.
      const releaseError = await this.releaseIsolatedWorkspace(job);
      if (releaseError !== undefined) this.emitReport(job.id, releaseWarning(job, releaseError));
      this.fail(job, epoch, error);
    }
  }

  private async resolveWorkspace(job: SpawnJob): Promise<void> {
    if (job.workspaceReady) return;
    if (job.resumeWorkspace === true) {
      const name = job.workspaceName!;
      if (this.resolveNamedWorkspace === undefined) {
        throw new SpawnRequestError(`Spawn ${job.id} cannot be revived: its workspace ${name} was archived and this manager cannot resume one. Spawn a new child against that workspace instead.`, { id: job.id, workspace: name });
      }
      const resumed = await this.resolveNamedWorkspace(name);
      if (!resumed || typeof resumed.path !== "string" || resumed.path.trim().length === 0) {
        throw new SpawnRequestError(`Spawn ${job.id} cannot be revived: its workspace ${name} could not be resumed.`, { id: job.id, workspace: name });
      }
      job.workspace = resumed.path;
      job.handle.workspace = resumed.path;
      job.workspaceReady = true;
      job.resumeWorkspace = false;
      return;
    }
    const requested = job.request.workspace;
    const created = job.request.isolated
      ? await this.createWorkspace?.(requested, job.request.task, job.controller.signal)
      : requested === undefined ? undefined : await this.resolveNamedWorkspace?.(requested);
    if (!created || typeof created.name !== "string" || created.name.trim().length === 0 || typeof created.path !== "string" || created.path.trim().length === 0) {
      throw new SpawnRequestError(job.request.isolated ? "createWorkspace must return non-empty name and path" : "workspace must name an existing workspace", { id: job.id, workspace: requested });
    }
    job.workspace = created.path;
    job.handle.workspace = created.path;
    if (job.request.isolated) job.workspaceName = created.name;
    job.workspaceReady = true;
  }

  /** Returns the failure instead of throwing: cleanup never decides a job's verdict. */
  private async releaseIsolatedWorkspace(job: SpawnJob): Promise<unknown> {
    if (job.workspaceReleased || job.workspaceName === undefined || this.releaseWorkspace === undefined) return undefined;
    try {
      await this.releaseWorkspace(job.workspaceName);
    } catch (error: unknown) {
      return error; // The flag stays unset so a later attempt can still retry the release.
    }
    job.workspaceReleased = true;
    return undefined;
  }

  private makeResult(job: SpawnJob, output: unknown, integration?: SpawnIntegration): SpawnResult {
    return {
      id: job.id,
      peer: job.peer,
      output,
      workspace: job.workspace,
      ...(job.model === undefined ? {} : { model: job.model }),
      ...(job.request.label === undefined ? {} : { label: job.request.label }),
      ...(integration === undefined ? {} : { integration }),
      // A shared-tree child wrote into the parent's own directory, so what it touched is the
      // parent's next question. An isolated child answers that with `integration` instead.
      ...(job.filesModified.size === 0 ? {} : { filesModified: [...job.filesModified] }),
      // Resolved as well as declared: `writeScope: ["src/**"]` means nothing until it is said
      // which `src` — and the parent that mis-rooted it is the one reading this.
      ...(job.writeScope === undefined ? {} : { scope: { paths: [...job.writeScope], resolved: resolveScopePaths(job.workspace, job.writeScope), violations: [...job.scopeViolations] } }),
    };
  }

  /**
   * The completion payload for an isolated child: where its work is and how to merge it.
   *
   * Only isolated children get one. A child sharing the parent's directory has already
   * written into the tree the parent is looking at — there is nothing to fetch, and saying
   * otherwise would invite a merge of a workspace into itself.
   */
  private async describeIsolatedWorkspace(job: SpawnJob, controller: AbortController): Promise<SpawnIntegration | undefined> {
    if (job.workspaceName === undefined || this.describeWorkspace === undefined) return undefined;
    try { return await this.describeWorkspace({ name: job.workspaceName, path: job.workspace }, controller.signal); }
    catch (error) {
      return {
        workspace: job.workspaceName, path: job.workspace, commits: 0, uncommitted: [], truncated: false,
        unavailable: error instanceof Error ? error.message : String(error),
        hint: [`git fetch ${job.workspace} HEAD:refs/lyra/agents/${job.workspaceName}`],
      };
    }
  }

  private applyOutputContract(request: SpawnRequest, result: SpawnResult): SpawnResult {
    if (request.output_schema === undefined) return result;
    const validation = validateOutput(result.output, request.output_schema);
    if (validation.issues.length === 0) return result;
    const first = validation.issues[0];
    const message = `Output does not satisfy output_schema at ${first?.path ?? "$"}: ${first?.message ?? "invalid output"}`;
    const diagnostic: SpawnContractDiagnostic = {
      code: "output_schema_mismatch",
      message,
      issues: validation.issues,
    };
    if ((request.schema_mode ?? "permissive") === "strict") {
      throw new SpawnContractError(message, validation.issues);
    }
    return {
      ...result,
      metadata: {
        schemaMode: "permissive",
        schemaValid: false,
        contractError: diagnostic,
      },
      error: diagnostic,
    } as SpawnDiagnosticResult;
  }

  private finish(job: SpawnJob, epoch: number, result: SpawnResult): void {
    if (job.epoch !== epoch || job.terminal) {
      this.release(job, epoch);
      return;
    }
    job.terminal = true;
    job.result = result;
    delete job.currentTool;
    job.handle.status = "completed";
    // Settled *before* the transition is announced, because announcing it can come straight
    // back in: a listener parks the peer on the bus, and a message delivered to a parked
    // peer revives this very job — synchronously, from inside this call. Resolving first
    // means the waiter that asked for this run gets this run's result either way.
    job.resolve(result);
    this.release(job, epoch);
    this.emitLifecycle(job, "completed");
  }

  /**
   * Record a terminal failure, and say which kind it is.
   *
   * `resolution` when the executor was never entered (the workspace could not be resolved) or
   * when it was entered and reported that it could not set the child up at all. Everything
   * else ran, so it is `execution` — including a *revived* run that broke during setup, since
   * `started` is sticky and a child with a transcript is still a child a message can pick up.
   *
   * A resolution failure gives its peer name back here. Nothing can be sent to that child
   * that would achieve anything (`revive` refuses it), so holding the name only makes the
   * next spawn pick a worse one — which is exactly what a user did, naming their retry
   * `stylist2` because they could not tell whether `stylist` was still taken.
   */
  private fail(job: SpawnJob, epoch: number, error: unknown): void {
    if (job.epoch !== epoch || job.terminal) {
      this.release(job, epoch);
      return;
    }
    job.terminal = true;
    const normalized = normalizeExecutionError(job.id, error);
    job.error = normalized instanceof Error ? normalized.message : String(normalized);
    delete job.currentTool;
    const state: SpawnState = isDeadline(normalized) ? "timed_out" : "failed";
    if (state === "failed") job.failure = !job.started || isResolutionFailure(normalized) ? "resolution" : "execution";
    job.handle.status = state;
    // Freed before the announcement carries `peerReleased`, so a listener that unregisters
    // the name on that event and a spawn that asks for it a moment later agree about who
    // holds it. The job keeps the string: the terminal notice still has to name the child.
    if (job.failure === "resolution" && this.peers.get(job.peer) === job.id) {
      this.peers.delete(job.peer);
      job.peerReleased = true;
    }
    job.reject(normalized);
    this.release(job, epoch);
    this.emitLifecycle(job, state === "timed_out" ? "timed_out" : "failed");
  }

  /**
   * Give back the concurrency slot this run held — exactly once, and only if it still holds
   * one. A stale run that lost its job to a revival releases nothing: the slot it would
   * have returned is the one the revived run is standing in.
   */
  private release(job: SpawnJob, epoch: number): void {
    if (job.runs.delete(epoch)) this.active = Math.max(0, this.active - 1);
    this.pump();
    this.pruneTerminalJobs();
  }

  /**
   * Terminal jobs stay listable for inspection, but a session that delegates for hours must not
   * accumulate their requests, results and controllers forever: the oldest ones age out first.
   * release() already tolerates a job that is no longer in the map, so eviction is safe mid-flight.
   */
  private pruneTerminalJobs(): void {
    let terminal = 0;
    for (const job of this.jobs.values()) if (job.terminal) terminal += 1;
    let excess = terminal - this.retainedJobs;
    if (excess <= 0) return;
    for (const [id, job] of this.jobs) {
      if (excess <= 0) break;
      if (!job.terminal || job.runs.size > 0) continue;
      this.jobs.delete(id);
      if (this.peers.get(job.peer) === id) this.peers.delete(job.peer);
      excess -= 1;
    }
  }

  private validateRequest(request: SpawnRequest, parent?: SpawnParentContext): {
    request: SpawnRequest;
    depth: number;
    model?: string;
    tools: readonly string[];
    workspace: string;
    isolated: boolean;
    workspaceReady: boolean;
    writeScope?: readonly string[];
  } {
    if (!request || typeof request !== "object") throw new SpawnRequestError("spawn request is required");
    assertNonEmptyString(request.task, "task");
    if (request.context !== undefined && typeof request.context !== "string") {
      throw new SpawnRequestError("context must be a string when provided");
    }
    if (request.acp !== undefined) assertNonEmptyString(request.acp, "acp");
    if (request.model !== undefined) assertNonEmptyString(request.model, "model");
    if (request.label !== undefined) assertNonEmptyString(request.label, "label");
    if (request.workspace !== undefined) assertNonEmptyString(request.workspace, "workspace");
    if (request.isolated !== undefined && typeof request.isolated !== "boolean") {
      throw new SpawnRequestError("isolated must be a boolean when provided");
    }
    if (request.blocking !== undefined && typeof request.blocking !== "boolean") {
      throw new SpawnRequestError("blocking must be a boolean when provided");
    }
    if (request.schema_mode !== undefined && request.schema_mode !== "strict" && request.schema_mode !== "permissive") {
      throw new SpawnRequestError("schema_mode must be strict or permissive");
    }
    if (request.tools !== undefined) assertTools(request.tools, "tools");
    if (request.depth !== undefined) assertNonNegativeInteger(request.depth, "depth");
    if (parent !== undefined) this.validateParent(parent);
    if (request.output_schema !== undefined) validateSchemaDefinition(request.output_schema);
    let writeScope: readonly string[] | undefined;
    if (request.writeScope !== undefined) {
      assertTools(request.writeScope, "writeScope");
      const cleaned = request.writeScope.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      if (cleaned.length === 0) throw new SpawnRequestError("writeScope must name at least one path when provided", { field: "writeScope" });
      writeScope = Object.freeze(cleaned);
    }

    const parentDepth = parent?.depth ?? 0;
    const depth = request.depth ?? (parent === undefined ? 0 : parentDepth + 1);
    if (request.depth !== undefined && parent !== undefined && request.depth !== parentDepth + 1) {
      throw new SpawnRequestError(`depth must be ${parentDepth + 1} for a child of this execution`, {
        requested: request.depth,
        parentDepth,
      });
    }
    if (depth > this.maxDepth) {
      throw new SpawnRequestError(`spawn depth ${depth} exceeds maxDepth ${this.maxDepth}`, {
        depth,
        maxDepth: this.maxDepth,
      });
    }

    const model = request.model ?? parent?.model ?? this.defaultModel;
    const selectedTools = request.tools ?? this.availableTools ?? [];
    const tools = depth >= this.maxDepth ? selectedTools.filter((tool) => tool !== "spawn") : [...selectedTools];
    if (this.availableTools !== undefined) {
      const allowed = new Set(this.availableTools);
      for (const tool of tools) {
        if (!allowed.has(tool)) throw new SpawnRequestError(`tool is not available: ${tool}`, { tool });
      }
    }
    // Isolation is the model's decision, and the default is to share.
    //
    // It used to be inferred: any spawn without an explicit workspace got its own clone
    // whenever one could be made. That inverted the common case — most children are helping
    // with the work in front of the parent, and giving each one a private copy meant their
    // edits landed somewhere the parent could not see and had to be merged back. Sharing is
    // now the default and the #TAG guard is the collision protection; `isolated: true` is
    // for the swarm case, where children must not step on each other.
    const isolated = request.isolated === true;
    if (isolated && this.createWorkspace === undefined) throw new SpawnRequestError("isolated spawn requires createWorkspace");
    if (!isolated && request.workspace !== undefined && this.resolveNamedWorkspace === undefined) throw new SpawnRequestError("named workspace spawn requires resolveWorkspace");
    const workspace = request.workspace ?? parent?.workspace ?? this.defaultWorkspace;
    const normalizedRequest = { ...request, isolated };
    return {
      request: normalizedRequest,
      depth,
      ...(model === undefined ? {} : { model }),
      tools,
      workspace,
      isolated,
      workspaceReady: !isolated && request.workspace === undefined,
      ...(writeScope === undefined ? {} : { writeScope }),
    };

  }

  private validateParent(parent: SpawnParentContext): void {
    if (!parent || typeof parent !== "object") throw new SpawnRequestError("parent context must be an object");
    if (parent.id !== undefined) assertNonEmptyString(parent.id, "parent.id");
    if (parent.peer !== undefined) assertNonEmptyString(parent.peer, "parent.peer");
    if (parent.parentId !== undefined) assertNonEmptyString(parent.parentId, "parent.parentId");
    if (parent.workspace !== undefined) assertNonEmptyString(parent.workspace, "parent.workspace");
    if (parent.model !== undefined) assertNonEmptyString(parent.model, "parent.model");
    if (parent.depth !== undefined) assertNonNegativeInteger(parent.depth, "parent.depth");
    if (parent.tools !== undefined) assertTools(parent.tools, "parent.tools");
  }

  private makeExecutorContext(job: SpawnJob, epoch: number, controller: AbortController): SpawnExecutorContext {
    const parentId = job.parent?.id ?? job.parent?.parentId;
    return {
      id: job.id,
      peer: job.peer,
      signal: controller.signal,
      ...(parentId === undefined ? {} : { parentId }),
      depth: job.depth,
      workspace: job.workspace,
      ...(job.workspaceName === undefined ? {} : { workspaceName: job.workspaceName }),
      ...(job.model === undefined ? {} : { model: job.model }),
      tools: job.tools,
      ...(job.writeScope === undefined ? {} : { writeScope: job.writeScope }),
      ...(job.request.resume === true ? { resume: true } : {}),
      report: (message: string) => this.emitReport(job.id, message),
      // A superseded run's reports would otherwise overwrite the live run's picture.
      activity: (update: SpawnActivity) => { if (job.epoch === epoch) this.recordActivity(job, update); },
    };
  }

  /**
   * Fold one observed step into the job's live picture.
   *
   * Deliberately total: a malformed report from an executor is dropped rather than allowed
   * to throw into the middle of a child's turn.
   */
  private recordActivity(job: SpawnJob, update: SpawnActivity): void {
    if (job.terminal || update === null || typeof update !== "object") return;
    job.lastActivity = this.now();
    if (update.toolCall === true) job.toolCalls += 1;
    if (update.state === "awaiting_tool") {
      if (typeof update.tool === "string" && update.tool.length > 0) job.currentTool = update.tool;
      if (job.handle.status === "running" || job.handle.status === "starting") job.handle.status = "awaiting_tool";
    } else if (update.state === "running") {
      delete job.currentTool;
      if (job.handle.status === "awaiting_tool" || job.handle.status === "starting") job.handle.status = "running";
    }
    if (Array.isArray(update.filesModified)) {
      for (const path of update.filesModified) if (typeof path === "string" && path.length > 0) job.filesModified.add(path);
    }
    if (typeof update.scopeViolation === "string" && update.scopeViolation.length > 0 && !job.scopeViolations.includes(update.scopeViolation)) {
      job.scopeViolations.push(update.scopeViolation);
    }
    if (typeof update.text === "string" && update.text.length > 0) {
      const combined = job.partialOutput + update.text;
      job.partialOutput = combined.length > SPAWN_PARTIAL_OUTPUT_BUDGET ? combined.slice(combined.length - SPAWN_PARTIAL_OUTPUT_BUDGET) : combined;
    }
  }

  private transition(job: SpawnJob, state: SpawnState, type?: SpawnLifecycleEvent["type"]): void {
    job.handle.status = state;
    job.lastActivity = this.now();
    this.emitLifecycle(job, type ?? lifecycleTypeFor(state));
  }

  private emitLifecycle(job: SpawnJob, type: SpawnLifecycleEvent["type"]): void {
    if (this.lifecycleListeners.size === 0) return;
    const event: SpawnLifecycleEvent = {
      type,
      id: job.id,
      peer: job.peer,
      ...(job.request.label === undefined ? {} : { label: job.request.label }),
      status: job.handle.status,
      depth: job.depth,
      ...(job.parent?.id === undefined ? {} : { parentId: job.parent.id }),
      workspace: job.workspace,
      ...(job.model === undefined ? {} : { model: job.model }),
      toolCalls: job.toolCalls,
      filesModified: job.filesModified.size,
      at: this.now(),
      ...(job.error === undefined ? {} : { error: job.error }),
      ...(job.failure === undefined ? {} : { failure: job.failure }),
      // Stated rather than inferred: `failed` covers both the child a message repairs and the
      // one it cannot, and whoever writes the terminal notice must not have to guess which.
      ...(job.terminal ? { revivable: job.failure !== "resolution" } : {}),
      ...(job.peerReleased ? { peerReleased: true } : {}),
    };
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event);
      } catch {
        // Watching a child must never be able to fail the child.
      }
    }
  }

  private emitReport(id: string, message: string): void {
    if (typeof message !== "string") return;
    const report = { id, message };
    for (const listener of this.reportListeners) {
      try {
        listener(report);
      } catch {
        // Reporting is non-critical and must not turn a successful job into a failure.
      }
    }
  }
}

/** The transition an entered state announces. Only these seven are broadcast. */
function lifecycleTypeFor(state: SpawnState): SpawnLifecycleEvent["type"] {
  switch (state) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "timed_out": return "timed_out";
    case "running": return "started";
    default: return "spawned";
  }
}

/** A child that reported it could never start, however the error reached us. */
function isResolutionFailure(error: unknown): boolean {
  return error instanceof SpawnError && error.code === "resolution_failed";
}

/**
 * A declared write partition, rooted at the tree the child actually writes in.
 *
 * Globs survive it: `**` and `*` are ordinary path segments to a resolver, so `src/**` under
 * `/repo` comes back as `/repo/src/**` and still means what it meant. An entry that is
 * already absolute is left where the parent put it, because a parent that wrote an absolute
 * path meant that path and rooting it again would silently move it.
 */
function resolveScopePaths(workspace: string, patterns: readonly string[]): string[] {
  return patterns.map((pattern) => (isAbsolute(pattern) ? pattern : resolvePath(workspace, pattern)));
}

function isDeadline(error: unknown): boolean {
  if (error instanceof SpawnDeadlineError || error instanceof SpawnTimeoutError) return true;
  if (error instanceof SpawnError && error.code === "timed_out") return true;
  return error instanceof DOMException && error.name === "TimeoutError";
}

function withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withResolvedRequest(request: SpawnRequest, model: string | undefined, tools: readonly string[], workspace: string): SpawnRequest {
  return {
    ...request,
    ...(model === undefined ? {} : { model }),
    tools,
    workspace,
  };
}

function releaseWarning(job: SpawnJob, error: unknown): string {
  return `Workspace ${job.workspaceName} could not be released: ${error instanceof Error ? error.message : String(error)}`;
}

function withWarning(result: SpawnResult, warning: string): SpawnDiagnosticResult {
  const existing = (result as SpawnDiagnosticResult).warnings ?? [];
  return { ...result, warnings: [...existing, warning] };
}

function normalizeExecutionError(id: string, error: unknown): unknown {
  if (error instanceof SpawnError) return error;
  if (error instanceof DOMException && error.name === "TimeoutError") return new SpawnDeadlineError(id, `Spawn ${id} exceeded its deadline: ${error.message}`);
  if (error instanceof Error) return new SpawnError("execution_failed", `Spawn ${id} failed: ${error.message}`, { id, cause: error.message });
  return new SpawnError("execution_failed", `Spawn ${id} failed: ${String(error)}`, { id, cause: String(error) });
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SpawnRequestError(`${field} must be a non-empty string`, { field });
  }
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new SpawnRequestError(`${field} must be a non-negative integer`, { field });
  }
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new SpawnRequestError(`${field} must be a positive integer`, { field });
  }
}

function assertTools(value: unknown, field: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw new SpawnRequestError(`${field} must be an array of strings`, { field });
  for (const tool of value) assertNonEmptyString(tool, `${field} entry`);
}

function validateSchemaDefinition(schema: unknown, path = "$"): asserts schema is SpawnOutputSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new SpawnRequestError(`output_schema${path.slice(1)} must be an object`, { path });
  }
  const candidate = schema as Record<string, unknown>;
  if (candidate.type !== undefined && (typeof candidate.type !== "string" || !VALID_SCHEMA_TYPES.has(candidate.type))) {
    throw new SpawnRequestError(`output_schema.type at ${path} is unsupported`, { path });
  }
  if (candidate.required !== undefined) {
    if (!Array.isArray(candidate.required)) throw new SpawnRequestError(`output_schema.required at ${path} must be an array`, { path });
    for (const key of candidate.required) assertNonEmptyString(key, `output_schema.required entry at ${path}`);
  }
  if (candidate.properties !== undefined) {
    if (!candidate.properties || typeof candidate.properties !== "object" || Array.isArray(candidate.properties)) {
      throw new SpawnRequestError(`output_schema.properties at ${path} must be an object`, { path });
    }
    for (const [key, child] of Object.entries(candidate.properties as Record<string, unknown>)) {
      assertNonEmptyString(key, `output_schema property at ${path}`);
      validateSchemaDefinition(child, `${path}.${key}`);
    }
  }
  if (candidate.items !== undefined) validateSchemaDefinition(candidate.items, `${path}[]`);
  const enumValues = candidate.enum;
  if (enumValues !== undefined && !Array.isArray(enumValues)) {
    throw new SpawnRequestError(`output_schema.enum at ${path} must be an array`, { path });
  }
  if (candidate.additionalProperties !== undefined && typeof candidate.additionalProperties !== "boolean") {
    throw new SpawnRequestError(`output_schema.additionalProperties at ${path} must be a boolean`, { path });
  }
}

function validateOutput(output: unknown, schema: SpawnOutputSchema): SchemaValidationResult {
  const issues: SpawnContractIssue[] = [];
  validateValue(output, schema as SpawnOutputSchema & Record<string, unknown>, "$", issues);
  return { issues };
}

function validateValue(
  value: unknown,
  schema: SpawnOutputSchema & Record<string, unknown>,
  path: string,
  issues: SpawnContractIssue[],
): void {
  const type = schema.type;
  if (type !== undefined && !matchesType(value, type)) {
    issues.push({ path, message: `expected ${type} but received ${describeType(value)}`, expected: type, actual: describeType(value) });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    issues.push({ path, message: "value is not one of the allowed enum values", actual: describeType(value) });
    return;
  }
  if (schema.required !== undefined) {
    if (!isRecord(value)) {
      issues.push({ path, message: "required properties can only be checked on an object", expected: "object", actual: describeType(value) });
      return;
    }
    for (const key of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        issues.push({ path: `${path}.${key}`, message: "required property is missing", expected: "present" });
      }
    }
  }
  if (schema.properties !== undefined) {
    if (!isRecord(value)) {
      issues.push({ path, message: "properties can only be checked on an object", expected: "object", actual: describeType(value) });
      return;
    }
    const properties = schema.properties;
    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateValue(value[key], child as SpawnOutputSchema & Record<string, unknown>, `${path}.${key}`, issues);
      }
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(properties));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) issues.push({ path: `${path}.${key}`, message: "additional property is not allowed" });
      }
    }
  }
  if (schema.items !== undefined) {
    if (!Array.isArray(value)) {
      issues.push({ path, message: "items can only be checked on an array", expected: "array", actual: describeType(value) });
      return;
    }
    value.forEach((entry, index) => validateValue(entry, schema.items as SpawnOutputSchema & Record<string, unknown>, `${path}[${index}]`, issues));
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null": return value === null;
    case "object": return isRecord(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    default: return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeTimer = timer as unknown as { unref?: () => void };
  maybeTimer.unref?.();
}
