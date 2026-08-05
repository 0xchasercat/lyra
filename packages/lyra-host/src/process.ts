import { availableParallelism } from "node:os";
import process from "node:process";
import type {
  HostProcess,
  JobHandle,
  ProcessClass,
  ProcessRequest,
  ProcessResult,
} from "./types.ts";

/** The longest an item is allowed to wait for its class semaphore. */
export const DEFAULT_ACQUISITION_TIMEOUT_MS = 300_000;
/** Ordinary commands have a bounded lifetime even when no timeout is supplied. */
export const DEFAULT_PROCESS_TIMEOUT_MS = 60 * 60_000;

const MAX_TIMER_MS = 2_147_000_000;

type Release = () => void;

export class ProcessRequestError extends TypeError {
  readonly code = "invalid_process_request";
  constructor(message: string) {
    super(message);
    this.name = "ProcessRequestError";
  }
}

export class ProcessClosedError extends Error {
  readonly code = "process_host_closed";
  constructor() {
    super("The process host is closed and cannot accept new commands");
    this.name = "ProcessClosedError";
  }
}

export class ProcessQueueTimeoutError extends Error {
  readonly code = "process_queue_timeout";
  constructor(timeoutMs: number) {
    super(`Process remained queued for ${timeoutMs}ms without acquiring its class semaphore`);
    this.name = "ProcessQueueTimeoutError";
  }
}

export class ProcessCancelledError extends Error {
  readonly code = "process_cancelled";
  constructor(message = "Process was cancelled before it could start") {
    super(message);
    this.name = "ProcessCancelledError";
  }
}

interface SemaphoreWaiter {
  settled: boolean;
  resolve: (release: Release) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface SemaphoreTicket extends Promise<Release> {
  readonly promise: Promise<Release>;
  cancel(): void;
}

/**
 * A small FIFO counting semaphore. A ticket can be cancelled without leaving a
 * waiter behind, which is important when a host is closed while jobs are queued.
 */
export class Semaphore {
  readonly limit: number;
  #active = 0;
  readonly #waiters: SemaphoreWaiter[] = [];

  constructor(limit: number) {
    if (!(limit > 0) && limit !== Infinity) {
      throw new RangeError("Semaphore limit must be positive");
    }
    if (!Number.isFinite(limit) && limit !== Infinity) {
      throw new RangeError("Semaphore limit must be finite or Infinity");
    }
    this.limit = limit;
  }

  get activeCount(): number { return this.#active; }
  get queuedCount(): number { return this.#waiters.length; }

  acquire(timeoutMs = DEFAULT_ACQUISITION_TIMEOUT_MS, signal?: AbortSignal): SemaphoreTicket {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("Semaphore acquisition timeout must be a non-negative finite number");
    }

    let resolvePromise!: (release: Release) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<Release>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const waiter: SemaphoreWaiter = {
      settled: false,
      resolve: resolvePromise,
      reject: rejectPromise,
      ...(signal === undefined ? {} : { signal }),
    };

    const settleRejected = (error: unknown): void => {
      if (waiter.settled) return;
      waiter.settled = true;
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      const index = this.#waiters.indexOf(waiter);
      if (index >= 0) this.#waiters.splice(index, 1);
      waiter.reject(error);
      this.#pump();
    };

    const cancel = (): void => settleRejected(new ProcessCancelledError());
    waiter.onAbort = (): void => settleRejected(new ProcessCancelledError("Process was cancelled while queued"));
    const ticket = Object.assign(promise as SemaphoreTicket, { promise, cancel });

    if (signal?.aborted === true) {
      settleRejected(new ProcessCancelledError("Process was cancelled while queued"));
      return ticket;
    }

    if (signal !== undefined) signal.addEventListener("abort", waiter.onAbort, { once: true });

    if (this.#active < this.limit) {
      waiter.settled = true;
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      this.#active += 1;
      let released = false;
      resolvePromise(() => {
        if (released) return;
        released = true;
        this.#active -= 1;
        this.#pump();
      });
      return ticket;
    }

    this.#waiters.push(waiter);
    if (timeoutMs === 0) {
      settleRejected(new ProcessQueueTimeoutError(timeoutMs));
    } else {
      waiter.timer = setTimeout(() => settleRejected(new ProcessQueueTimeoutError(timeoutMs)), Math.min(timeoutMs, MAX_TIMER_MS));
    }
    return ticket;
  }

  #pump(): void {
    while (this.#active < this.limit && this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()!;
      if (waiter.settled) continue;
      waiter.settled = true;
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      this.#active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.#active -= 1;
        this.#pump();
      });
    }
  }
}

export type ClassSemaphoreLimits = Readonly<Record<ProcessClass, number>>;

export function defaultParallelism(): number {
  try {
    return Math.max(1, availableParallelism());
  } catch {
    return Math.max(1, process.env.NPROC === undefined ? 1 : Number.parseInt(process.env.NPROC, 10) || 1);
  }
}

/** Limits are deliberately separate: disk-heavy work must not consume light slots. */
export function classSemaphoreLimits(parallelism = defaultParallelism()): ClassSemaphoreLimits {
  if (!Number.isSafeInteger(parallelism) || parallelism < 1) {
    throw new RangeError("parallelism must be a positive safe integer");
  }
  return Object.freeze({
    heavy: Math.min(parallelism, 8),
    io: 4,
    light: parallelism * 2,
    free: Infinity,
  });
}

interface TokenizedCommand {
  executable: string;
  args: string[];
}

function splitShellCommands(command: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === ";" || character === "|" || character === "&" || character === "\n") {
      const segment = command.slice(start, index).trim();
      if (segment.length > 0) result.push(segment);
      if ((character === "|" || character === "&") && command[index + 1] === character) index += 1;
      start = index + 1;
    }
  }
  const tail = command.slice(start).trim();
  if (tail.length > 0) result.push(tail);
  return result;
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  const pattern = /'[^']*'|"(?:\\.|[^"\\])*"|[^\s]+/g;
  for (const match of segment.matchAll(pattern)) {
    tokens.push(match[0]!);
  }
  return tokens;
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
    return value.slice(1, -1);
  }
  return value;
}

function commandTokens(segment: string): TokenizedCommand | undefined {
  const tokens = tokenize(segment).map(unquote);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index]!)) index += 1;
  if (index >= tokens.length) return undefined;
  const executable = tokens[index]!.split("/").pop()!.toLowerCase();
  return { executable, args: tokens.slice(index + 1) };
}
const HEAVY_EXECUTABLES: Readonly<Record<string, true>> = Object.freeze({
  cargo: true, rustc: true, npm: true, npx: true, pnpm: true, yarn: true, bun: true, deno: true, go: true, tsc: true,
  webpack: true, vite: true, rollup: true, esbuild: true, docker: true, podman: true, make: true, gmake: true, cmake: true,
  ninja: true, gradle: true, mvn: true, maven: true, pytest: true, vitest: true, jest: true, mocha: true, ava: true,
  xcodebuild: true, swift: true, dotnet: true, bazel: true, buck: true,
});
const IO_EXECUTABLES: Readonly<Record<string, true>> = Object.freeze({
  find: true, rg: true, ripgrep: true, tar: true, gtar: true, zip: true, unzip: true, gzip: true, gunzip: true, bzip2: true,
  xz: true, rsync: true, du: true,
});
const LIGHT_EXECUTABLES: Readonly<Record<string, true>> = Object.freeze({
  git: true, svn: true, hg: true, eslint: true, prettier: true, stylelint: true, cat: true, head: true, tail: true, sed: true,
  awk: true, cut: true, sort: true, uniq: true, wc: true, ls: true, stat: true,
});
const FREE_EXECUTABLES: Readonly<Record<string, true>> = Object.freeze({
  echo: true, printf: true, true: true, false: true, pwd: true, which: true, where: true, command: true, date: true, uname: true,
  id: true, whoami: true,
});

function hasAny(args: readonly string[], values: readonly string[]): boolean {
  return args.some((argument) => values.includes(argument.toLowerCase()));
}

function classifySegment(segment: string): ProcessClass {
  const parsed = commandTokens(segment);
  if (parsed === undefined) return "free";
  const { executable, args } = parsed;

  if (executable === "sleep" || executable === "yes" || (executable === "tail" && hasAny(args, ["-f", "--follow"]))) return "heavy";
  if (HEAVY_EXECUTABLES[executable] === true) return "heavy";

  if (executable === "git") {
    const subcommand = args.find((argument) => !argument.startsWith("-"))?.toLowerCase();
    if (subcommand === "grep") return "io";
    return "light";
  }
  if (executable === "grep" || executable === "rg" || executable === "ripgrep") {
    return hasAny(args, ["-r", "-R", "--recursive", "--files", "--files-with-matches", "--count-matches"]) ? "io" : "light";
  }
  if (IO_EXECUTABLES[executable] === true) return "io";
  if (executable === "cp" || executable === "mv") return hasAny(args, ["-r", "-R", "-a", "--recursive"]) ? "io" : "light";
  if (executable === "bash" || executable === "sh" || executable === "zsh") {
    const inlineIndex = args.findIndex((argument, index) => (argument === "-c" || argument === "-lc" || argument === "-ec") && args[index + 1] !== undefined);
    if (inlineIndex >= 0) return classifyCommand(args[inlineIndex + 1]!);
  }
  if (LIGHT_EXECUTABLES[executable] === true) return "light";
  if (FREE_EXECUTABLES[executable] === true) return "free";
  if (/^(build|compile|install|watch|serve|dev|check|lint)$/.test(executable)) return executable === "lint" ? "light" : "heavy";
  return "light";
}

/** Classify the command that will actually be sent to bash, never model input. */
export function classifyCommand(command: string): ProcessClass {
  if (typeof command !== "string" || command.trim().length === 0) return "free";
  let result: ProcessClass = "free";
  for (const segment of splitShellCommands(command)) {
    const classification = classifySegment(segment);
    if (classification === "heavy") return "heavy";
    if (classification === "io") result = "io";
    else if (classification === "light" && result === "free") result = "light";
  }
  return result;
}

interface NormalizedRequest {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function normalizeRequest(request: ProcessRequest): NormalizedRequest {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new ProcessRequestError("Process request must be an object");
  }
  const value = request as unknown as Record<string, unknown>;
  if (typeof value.command !== "string" || value.command.trim().length === 0) {
    throw new ProcessRequestError("Process command must be a non-empty string");
  }
  if (typeof value.cwd !== "string" || value.cwd.trim().length === 0) {
    throw new ProcessRequestError("Process cwd must be a non-empty string");
  }
  const timeout = value.timeoutMs;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0)) {
    throw new ProcessRequestError("Process timeoutMs must be a positive safe integer when provided");
  }
  const signal = value.signal;
  if (signal !== undefined && (typeof signal !== "object" || signal === null || typeof (signal as { addEventListener?: unknown }).addEventListener !== "function")) {
    throw new ProcessRequestError("Process signal must be an AbortSignal when provided");
  }
  return {
    command: value.command,
    cwd: value.cwd,
    ...(timeout === undefined ? {} : { timeoutMs: timeout }),
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
  };
}

interface JobInternal {
  readonly handle: JobHandle;
  readonly request: NormalizedRequest;
  readonly class: ProcessClass;
  readonly controller: AbortController;
  readonly resultPromise: Promise<ProcessResult>;
  readonly resolveResult: (result: ProcessResult) => void;
  acquireCancel: (() => void) | undefined;
  child: Bun.Subprocess | undefined;
  result?: ProcessResult;
  cancelRequested: boolean;
  deadlineRequested: boolean;
  settled: boolean;
}

export interface ProcessHostOptions {
  /** Override nproc/availableParallelism in deterministic tests. */
  parallelism?: number;
  /** Alias for parallelism, retained for callers that use the nproc term. */
  nproc?: number;
  heavyLimit?: number;
  ioLimit?: number;
  lightLimit?: number;
  acquisitionTimeoutMs?: number;
  defaultTimeoutMs?: number;
}
export interface ProcessStatus {
  readonly id: string;
  readonly class: ProcessClass;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly status: JobHandle["status"];
}

function signalNameFromExitCode(exitCode: number | null): string | null {
  if (exitCode === null || exitCode < 129 || exitCode > 192) return null;
  const names: Record<number, string> = {
    1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 6: "SIGABRT", 9: "SIGKILL", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM",
  };
  return names[exitCode - 128] ?? null;
}

function readOutput(stream: unknown): Promise<string> {
  if (stream === null || stream === undefined || typeof stream === "number") return Promise.resolve("");
  return new Response(stream as unknown as BodyInit).text().catch((error: unknown) => `Unable to read process output: ${error instanceof Error ? error.message : String(error)}`);
}

function killProcessTree(child: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void {
  // detached:true puts bash and its descendants in a private process group on macOS.
  // Killing both the group and the Bun handle handles shells that have already exited.
  if (typeof child.pid === "number" && child.pid > 1) {
    try { process.kill(-child.pid, signal); } catch { /* the group may have exited */ }
  }
  try { child.kill(); } catch { /* the child may have exited between checks */ }
}

export class ProcessHost implements HostProcess {
  readonly #semaphores: Readonly<Record<Exclude<ProcessClass, "free">, Semaphore>>;
  readonly #limits: ClassSemaphoreLimits;
  readonly #jobs = new Map<string, JobInternal>();
  readonly #acquisitionTimeoutMs: number;
  readonly #defaultTimeoutMs: number;
  #sequence = 0;
  #closed = false;

  constructor(options: ProcessHostOptions = {}) {
    const parallelism = options.nproc ?? options.parallelism ?? defaultParallelism();
    const defaults = classSemaphoreLimits(parallelism);
    const limits = {
      heavy: options.heavyLimit ?? defaults.heavy,
      io: options.ioLimit ?? defaults.io,
      light: options.lightLimit ?? defaults.light,
      free: Infinity,
    } satisfies Record<ProcessClass, number>;
    for (const [name, limit] of Object.entries(limits)) {
      if (name === "free") continue;
      if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`${name} semaphore limit must be a positive safe integer`);
    }
    const acquisitionTimeoutMs = options.acquisitionTimeoutMs ?? DEFAULT_ACQUISITION_TIMEOUT_MS;
    const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
    if (!Number.isFinite(acquisitionTimeoutMs) || acquisitionTimeoutMs < 0) throw new RangeError("acquisitionTimeoutMs must be non-negative");
    if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) throw new RangeError("defaultTimeoutMs must be positive");
    this.#limits = Object.freeze(limits);
    this.#semaphores = {
      heavy: new Semaphore(limits.heavy),
      io: new Semaphore(limits.io),
      light: new Semaphore(limits.light),
    };
    this.#acquisitionTimeoutMs = acquisitionTimeoutMs;
    this.#defaultTimeoutMs = defaultTimeoutMs;
  }

  get limits(): ClassSemaphoreLimits { return this.#limits; }

  classify(command: string): ProcessClass { return classifyCommand(command); }

  async run(request: ProcessRequest): Promise<ProcessResult | JobHandle> {
    const normalized = normalizeRequest(request);
    if (this.#closed) throw new ProcessClosedError();
    const processClass = classifyCommand(normalized.command);
    const id = `job-${(++this.#sequence).toString(36).padStart(6, "0")}`;
    const handle: JobHandle = {
      id,
      class: processClass,
      command: normalized.command,
      cwd: normalized.cwd,
      startedAt: Date.now(),
      status: "queued",
    };
    let resolveResult!: (result: ProcessResult) => void;
    const resultPromise = new Promise<ProcessResult>((resolve) => { resolveResult = resolve; });
    const controller = new AbortController();
    const job: JobInternal = {
      handle,
      request: normalized,
      class: processClass,
      controller,
      resultPromise,
      resolveResult,
      acquireCancel: undefined,
      child: undefined,
      cancelRequested: false,
      deadlineRequested: false,
      settled: false,
    };
    this.#jobs.set(id, job);

    const onRequestAbort = (): void => {
      job.cancelRequested = true;
      if (!controller.signal.aborted) controller.abort(new ProcessCancelledError("Process request was cancelled"));
    };
    if (normalized.signal !== undefined) {
      normalized.signal.addEventListener("abort", onRequestAbort, { once: true });
      if (normalized.signal.aborted) onRequestAbort();
    }
    void this.#execute(job, onRequestAbort);
    if (processClass === "heavy") return handle;
    return resultPromise;
  }

  async wait(id: string, timeoutMs?: number): Promise<ProcessResult | undefined> {
    if (typeof id !== "string" || id.length === 0) return undefined;
    const job = this.#jobs.get(id);
    if (job === undefined) return undefined;
    if (timeoutMs === undefined) return job.resultPromise;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new ProcessRequestError("wait timeoutMs must be a non-negative safe integer");
    if (timeoutMs === 0) return job.result;
    if (job.settled) return job.result;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), Math.min(timeoutMs, MAX_TIMER_MS));
    });
    try {
      return await Promise.race([job.resultPromise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async cancel(id: string): Promise<boolean> {
    const job = this.#jobs.get(id);
    if (job === undefined || job.settled || job.cancelRequested) return false;
    job.cancelRequested = true;
    job.acquireCancel?.();
    if (!job.controller.signal.aborted) job.controller.abort(new ProcessCancelledError(`Process ${id} was cancelled`));
    if (job.child !== undefined) killProcessTree(job.child, "SIGTERM");
    return true;
  }

  /** A stable snapshot ordered by creation sequence, useful for status UIs and tests. */
  listJobs(): readonly JobHandle[] {
    return [...this.#jobs.values()].map((job) => ({ ...job.handle }));
  }

  list(): readonly JobHandle[] { return this.listJobs(); }

  status(id: string): JobHandle | undefined {
    const job = this.#jobs.get(id);
    return job === undefined ? undefined : { ...job.handle };
  }

  get(id: string): JobHandle | undefined { return this.status(id); }

  listStatuses(): readonly ProcessStatus[] {
    return this.listJobs();
  }

  getStatus(id: string): ProcessStatus | undefined { return this.status(id); }

  async close(): Promise<void> {
    if (!this.#closed) this.#closed = true;
    const pending = [...this.#jobs.values()].filter((job) => !job.settled);
    for (const job of pending) {
      job.cancelRequested = true;
      job.acquireCancel?.();
      if (!job.controller.signal.aborted) job.controller.abort(new ProcessCancelledError("Process host was closed"));
      if (job.child !== undefined) killProcessTree(job.child, "SIGTERM");
    }
    await Promise.all(pending.map((job) => job.resultPromise));
  }

  async #execute(job: JobInternal, onRequestAbort: () => void): Promise<void> {
    let release: Release | undefined;
    try {
      if (job.controller.signal.aborted) {
        this.#settle(job, this.#cancelledResult(job, "Process was cancelled before acquiring its semaphore"));
        return;
      }
      if (job.class !== "free") {
        const ticket = this.#semaphores[job.class].acquire(this.#acquisitionTimeoutMs, job.controller.signal);
        job.acquireCancel = ticket.cancel;
        try {
          release = await ticket.promise;
        } catch (error: unknown) {
          if (error instanceof ProcessQueueTimeoutError) {
            this.#settle(job, this.#failedResult(job, error.message));
          } else {
            this.#settle(job, this.#cancelledResult(job, error instanceof Error ? error.message : "Process was cancelled while queued"));
          }
          return;
        } finally {
          job.acquireCancel = undefined;
        }
      }

      if (job.controller.signal.aborted) {
        this.#settle(job, this.#cancelledResult(job, "Process was cancelled before spawning"));
        return;
      }
      job.handle.status = "running";
      const result = await this.#spawn(job);
      this.#settle(job, result);
    } catch (error: unknown) {
      this.#settle(job, this.#failedResult(job, `Process execution failed: ${error instanceof Error ? error.message : String(error)}`));
    } finally {
      release?.();
      job.request.signal?.removeEventListener("abort", onRequestAbort);
    }
  }

  async #spawn(job: JobInternal): Promise<ProcessResult> {
    const started = Date.now();
    let child: Bun.Subprocess;
    try {
      child = Bun.spawn(["/bin/bash", "-lc", job.request.command], {
        cwd: job.request.cwd,
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      job.child = child;
    } catch (error: unknown) {
      return {
        stdout: "",
        stderr: `Unable to spawn bash in ${job.request.cwd}: ${error instanceof Error ? error.message : String(error)}`,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - started,
      };
    }

    let terminationSignal: string | null = null;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (): void => {
      if (terminationSignal === null) terminationSignal = "SIGTERM";
      killProcessTree(child, "SIGTERM");
      if (forceTimer === undefined) {
        forceTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 150);
      }
    };
    const onAbort = (): void => terminate();
    job.controller.signal.addEventListener("abort", onAbort, { once: true });
    if (job.controller.signal.aborted) terminate();

    try {
      const timeoutMs = job.request.timeoutMs ?? (job.class === "heavy" ? undefined : this.#defaultTimeoutMs);
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined) {
        deadlineTimer = setTimeout(() => {
          job.deadlineRequested = true;
          if (!job.controller.signal.aborted) job.controller.abort(new Error(`Process exceeded its ${timeoutMs}ms deadline`));
        }, Math.min(timeoutMs, MAX_TIMER_MS));
      }
      try {
        const [stdout, stderr, exitCode] = await Promise.all([readOutput(child.stdout), readOutput(child.stderr), child.exited]);
        return {
          stdout,
          stderr,
          exitCode,
          signal: terminationSignal ?? signalNameFromExitCode(exitCode),
          durationMs: Date.now() - started,
        };
      } catch (error: unknown) {
        return {
          stdout: "",
          stderr: `Unable to collect process output: ${error instanceof Error ? error.message : String(error)}`,
          exitCode: null,
          signal: terminationSignal,
          durationMs: Date.now() - started,
        };
      } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      }
    } finally {
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      job.controller.signal.removeEventListener("abort", onAbort);
      job.child = undefined;
    }
  }

  #settle(job: JobInternal, result: ProcessResult): void {
    if (job.settled) return;
    job.settled = true;
    job.result = result;
    if (job.cancelRequested) job.handle.status = "cancelled";
    else if (result.exitCode === 0 && !job.deadlineRequested) job.handle.status = "completed";
    else job.handle.status = "failed";
    job.resolveResult(result);
  }

  #cancelledResult(job: JobInternal, message: string): ProcessResult {
    return {
      stdout: "",
      stderr: message,
      exitCode: null,
      signal: "SIGTERM",
      durationMs: Math.max(0, Date.now() - job.handle.startedAt),
    };
  }

  #failedResult(job: JobInternal, message: string): ProcessResult {
    return {
      stdout: "",
      stderr: message,
      exitCode: null,
      signal: null,
      durationMs: Math.max(0, Date.now() - job.handle.startedAt),
    };
  }
}

export function createHostProcess(options: ProcessHostOptions = {}): ProcessHost {
  return new ProcessHost(options);
}

export type { HostProcess, JobHandle, ProcessClass, ProcessRequest, ProcessResult } from "./types.ts";
