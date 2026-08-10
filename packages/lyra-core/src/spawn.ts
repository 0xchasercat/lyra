import type {
  SpawnExecutor,
  SpawnExecutorContext,
  SpawnHandle,
  SpawnOutputSchema,
  SpawnRequest,
  SpawnResult,
  SpawnManagerOptions,
  SpawnSchemaMode,
} from "./spawn-types.ts";

export const DEFAULT_SPAWN_MAX_DEPTH = 2;
export const DEFAULT_SPAWN_MAX_CONCURRENT = Number.MAX_SAFE_INTEGER; // Host pressure is governed by ProcessHost class semaphores.
export const DEFAULT_SPAWN_WAIT_MS = 60 * 60 * 1000;
/** The deliberate ceiling on one wait (§3.4). A longer request is clamped, and the clamp is reported. */
export const MAX_SPAWN_WAIT_MS = DEFAULT_SPAWN_WAIT_MS;
/** Terminal jobs stay listable, but only the most recent ones: a session runs for hours. */
export const DEFAULT_SPAWN_RETAINED_JOBS = 64;

/** A parent execution context used when a running child creates another child. */
export interface SpawnParentContext {
  id?: string;
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

export class SpawnClosedError extends SpawnError {
  constructor() {
    super("closed", "Spawn manager is closed");
    this.name = "SpawnClosedError";
  }
}

interface SpawnJob {
  readonly id: string;
  readonly request: SpawnRequest;
  readonly parent?: SpawnParentContext;
  readonly depth: number;
  readonly model?: string;
  readonly tools: readonly string[];
  workspace: string;
  workspaceReady: boolean;
  workspaceName?: string;
  workspaceReleased: boolean;
  readonly handle: SpawnHandle;
  readonly controller: AbortController;
  readonly completion: Promise<SpawnResult>;
  resolve: (result: SpawnResult) => void;
  reject: (error: unknown) => void;
  terminal: boolean;
  queued: boolean;
  running: boolean;
}

interface SchemaValidationResult {
  readonly issues: readonly SpawnContractIssue[];
}

const VALID_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/**
 * Owns child execution and its lifecycle. The executor is intentionally injected: this
 * class only schedules and validates work, and never invents a fallback implementation.
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
  private readonly resolveNamedWorkspace: SpawnManagerOptions["resolveWorkspace"];
  private readonly releaseWorkspace: SpawnManagerOptions["releaseWorkspace"];
  private readonly now: () => number;
  private readonly jobs = new Map<string, SpawnJob>();
  private readonly queue: SpawnJob[] = [];
  private readonly reportListeners = new Set<(report: SpawnReport) => void>();
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
    if (options.createWorkspace !== undefined && typeof options.createWorkspace !== "function") {
      throw new SpawnRequestError("createWorkspace must be a function when provided");
    }
    if (options.resolveWorkspace !== undefined && typeof options.resolveWorkspace !== "function") {
      throw new SpawnRequestError("resolveWorkspace must be a function when provided");
    }
    if (options.releaseWorkspace !== undefined && typeof options.releaseWorkspace !== "function") {
      throw new SpawnRequestError("releaseWorkspace must be a function when provided");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new SpawnRequestError("now must be a function when provided");
    }

    this.maxDepth = maxDepth;
    this.maxConcurrent = maxConcurrent;
    this.defaultWorkspace = options.defaultWorkspace;
    this.defaultModel = options.defaultModel;
    this.availableTools = options.availableTools;
    this.executor = options.executor;
    this.createWorkspace = options.createWorkspace;
    this.resolveNamedWorkspace = options.resolveWorkspace;
    this.releaseWorkspace = options.releaseWorkspace;
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

  /** Listen to reports without coupling the executor to a UI or session. */
  onReport(listener: (report: SpawnReport) => void): () => void {
    if (typeof listener !== "function") throw new SpawnRequestError("report listener must be a function");
    this.reportListeners.add(listener);
    return () => this.reportListeners.delete(listener);
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
   * Every wait has a deadline (§3.4), bounded by MAX_SPAWN_WAIT_MS. The deadline belongs to the
   * observer, never to the job: an expired wait rejects with the job's live status and leaves it
   * running, so one poller cannot kill work that every other observer is still waiting on.
   */
  wait(handleOrId: SpawnHandle | string, timeoutMs = DEFAULT_SPAWN_WAIT_MS): Promise<SpawnDiagnosticResult> {
    const id = typeof handleOrId === "string" ? handleOrId : handleOrId?.id;
    if (typeof id !== "string" || id.length === 0) {
      return Promise.reject(new SpawnRequestError("A spawn id or handle is required to wait"));
    }
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new SpawnRequestError(`Unknown spawn id: ${id}`, { id }));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(new SpawnRequestError("wait timeout must be a non-negative finite number"));
    }
    const boundedTimeout = Math.min(timeoutMs, MAX_SPAWN_WAIT_MS);
    if (job.terminal) return job.completion;

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
      void job.completion.then(
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
    const job = this.jobs.get(id);
    if (!job || job.terminal) return false;
    const error = reason ?? new SpawnCancelledError(id);
    job.terminal = true;
    job.queued = false;
    job.handle.status = "cancelled";
    job.controller.abort(error);
    job.reject(error);
    this.pump();
    this.pruneTerminalJobs();
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
    return this.jobs.get(id)?.handle;
  }

  list(): SpawnHandle[] {
    return [...this.jobs.values()].map((job) => job.handle);
  }

  private enqueue(request: SpawnRequest, parent?: SpawnParentContext): SpawnJob {
    if (this.closed) throw new SpawnClosedError();
    const normalized = this.validateRequest(request, parent);
    const id = `spawn-${this.nextId++}`;
    const createdAt = this.now();
    const handle: SpawnHandle = {
      id,
      workspace: normalized.workspace,
      ...(request.label === undefined ? {} : { label: request.label }),
      status: "queued",
      startedAt: createdAt,
    };
    let resolve!: (result: SpawnResult) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // Non-blocking jobs are allowed to fail without creating an unhandled rejection.
    void completion.catch(() => undefined);
    const job: SpawnJob = {
      id,
      request: normalized.request,
      ...(parent === undefined ? {} : { parent }),
      depth: normalized.depth,
      ...(normalized.model === undefined ? {} : { model: normalized.model }),
      tools: normalized.tools,
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
      running: false,
    };
    this.jobs.set(id, job);
    this.queue.push(job);
    this.pump();
    return job;
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) return;
      job.queued = false;
      if (job.terminal) continue;
      job.running = true;
      job.handle.status = "running";
      job.handle.startedAt = this.now();
      this.active += 1;
      const execution = this.execute(job);
      this.executions.add(execution);
      void execution.then(() => this.executions.delete(execution), () => this.executions.delete(execution));
    }
  }

  private async execute(job: SpawnJob): Promise<void> {
    try {
      if (!job.workspaceReady) await this.resolveWorkspace(job);
      if (job.controller.signal.aborted) throw job.controller.signal.reason ?? new SpawnCancelledError(job.id);
      const executionRequest = withResolvedRequest(job.request, job.model, job.tools, job.workspace);
      const context = makeExecutorContext(job, this.emitReport.bind(this));
      const output = await this.executor(executionRequest, context);
      if (job.controller.signal.aborted) throw job.controller.signal.reason ?? new SpawnCancelledError(job.id);
      const result = this.makeResult(job, output);
      const contractResult = this.applyOutputContract(job.request, result);
      // Work that succeeded stays successful: a failed release is a warning, not a verdict.
      const releaseError = await this.releaseIsolatedWorkspace(job);
      this.finish(job, releaseError === undefined ? contractResult : withWarning(contractResult, releaseWarning(job, releaseError)));
    } catch (error: unknown) {
      // The original failure is the reportable one; cleanup trouble must never shadow it.
      const releaseError = await this.releaseIsolatedWorkspace(job);
      if (releaseError !== undefined) this.emitReport(job.id, releaseWarning(job, releaseError));
      this.fail(job, error);
    }
  }

  private async resolveWorkspace(job: SpawnJob): Promise<void> {
    if (job.workspaceReady) return;
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

  private makeResult(job: SpawnJob, output: unknown): SpawnResult {
    return {
      id: job.id,
      output,
      workspace: job.workspace,
      ...(job.model === undefined ? {} : { model: job.model }),
      ...(job.request.label === undefined ? {} : { label: job.request.label }),
    };
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

  private finish(job: SpawnJob, result: SpawnResult): void {
    if (job.terminal) {
      this.release(job);
      return;
    }
    job.terminal = true;
    job.handle.status = "completed";
    job.resolve(result);
    this.release(job);
  }

  private fail(job: SpawnJob, error: unknown): void {
    if (job.terminal) {
      this.release(job);
      return;
    }
    job.terminal = true;
    job.handle.status = "failed";
    job.reject(normalizeExecutionError(job.id, error));
    this.release(job);
  }

  private release(job: SpawnJob): void {
    if (!job.running && !this.jobs.has(job.id)) return;
    if (job.running) {
      job.running = false;
      this.active = Math.max(0, this.active - 1);
    }
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
      if (!job.terminal || job.running) continue;
      this.jobs.delete(id);
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
    const isolated = request.isolated ?? (request.workspace === undefined && this.createWorkspace !== undefined);
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
    };

  }

  private validateParent(parent: SpawnParentContext): void {
    if (!parent || typeof parent !== "object") throw new SpawnRequestError("parent context must be an object");
    if (parent.id !== undefined) assertNonEmptyString(parent.id, "parent.id");
    if (parent.parentId !== undefined) assertNonEmptyString(parent.parentId, "parent.parentId");
    if (parent.workspace !== undefined) assertNonEmptyString(parent.workspace, "parent.workspace");
    if (parent.model !== undefined) assertNonEmptyString(parent.model, "parent.model");
    if (parent.depth !== undefined) assertNonNegativeInteger(parent.depth, "parent.depth");
    if (parent.tools !== undefined) assertTools(parent.tools, "parent.tools");
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

function makeExecutorContext(job: SpawnJob, emit: (id: string, message: string) => void): SpawnExecutorContext {
  const parentId = job.parent?.id ?? job.parent?.parentId;
  return {
    id: job.workspaceName ?? job.id,
    signal: job.controller.signal,
    ...(parentId === undefined ? {} : { parentId }),
    depth: job.depth,
    workspace: job.workspace,
    ...(job.model === undefined ? {} : { model: job.model }),
    tools: job.tools,
    report: (message: string) => emit(job.id, message),
  };
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
