import { availableParallelism } from "node:os";
import process from "node:process";
import type {
  HostProcess,
  JobHandle,
  ProcessClass,
  ProcessRequest,
  ProcessResult,
  ProcessSurvivor,
} from "./types.ts";

/** The longest an item is allowed to wait for its class semaphore. */
export const DEFAULT_ACQUISITION_TIMEOUT_MS = 300_000;
/** Ordinary commands have a bounded lifetime even when no timeout is supplied. */
export const DEFAULT_PROCESS_TIMEOUT_MS = 60 * 60_000;
/**
 * How long a deliberately-waiting command may block before it is treated as a job.
 *
 * Matches the bash tool's inline budget: a `sleep` shorter than this finishes inside the
 * call the model made, so backgrounding it would only teach the model to chase a handle for
 * a result it was already going to get. Longer, or unbounded, and it really is a job.
 */
export const INLINE_WAIT_BUDGET_MS = 120_000;
/** Settled jobs stay retrievable for a while, then age out: a session runs for hours. */
export const DEFAULT_RETAINED_SETTLED_JOBS = 64;
/**
 * How long the output readers keep collecting after the shell has already exited.
 *
 * The call completes when the *shell* exits, not when its stdout pipe reaches EOF, because a
 * grandchild the shell backgrounded inherits that pipe and can hold it open for hours (§11).
 * Bytes the shell wrote just before exiting may still be in flight at that instant, so the
 * readers get a short grace to pick them up — long enough that nothing the shell itself
 * produced is lost (§3.8), short enough that it is not a second deadline.
 */
export const OUTPUT_DRAIN_GRACE_MS = 150;
/** A survivor survey must never become the reason a fast command feels slow. */
const SURVIVOR_SURVEY_TIMEOUT_MS = 2_000;
/** `ps` reports full argv; a pathological one must not end up pasted into a tool result. */
const SURVIVOR_COMMAND_LIMIT = 200;

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

/**
 * How long `sleep` will actually sleep, or undefined when that is unbounded or unknowable.
 *
 * GNU/BSD `sleep` accepts several operands and suffixes (`sleep 1m 30s`), so the total is
 * the sum. Anything that does not parse — a variable, an option, no operand at all — is
 * undefined, which is read as "unbounded" and therefore heavy: guessing short would be the
 * dangerous direction.
 */
function sleepDurationMs(args: readonly string[]): number | undefined {
  if (args.length === 0) return undefined;
  let total = 0;
  for (const argument of args) {
    const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(argument);
    if (match === null) return undefined;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return undefined;
    total += amount * { "": 1_000, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? ""]!;
  }
  return total >= INLINE_WAIT_BUDGET_MS ? undefined : total;
}

function classifySegment(segment: string): ProcessClass {
  const parsed = commandTokens(segment);
  if (parsed === undefined) return "free";
  const { executable, args } = parsed;

  // `yes` and `tail -f` never end on their own, so they are always jobs. `sleep` is the
  // odd one out: a bounded, short one is the model waiting on purpose — `sleep 10; git
  // status` is a poll, not a build — and classifying it heavy backgrounded the whole
  // segment and left the model chasing a handle. It is a job only when the duration is
  // absent, unparseable, or past the inline budget.
  if (executable === "sleep") return sleepDurationMs(args) === undefined ? "heavy" : "free";
  if (executable === "yes" || (executable === "tail" && hasAny(args, ["-f", "--follow"]))) return "heavy";
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

/**
 * Whether a command ends on its own, and whether the caller should wait for it.
 *
 * This is a *different question* from the semaphore class above and is answered by its own
 * table. `cargo build` is `heavy` — it belongs in the eight-wide disk queue — and it is also
 * `inline`, because it finishes and its output is the answer the model asked for. Backgrounding
 * it taught the model to fire a build and then chase a handle for a result it was about to
 * get. The two axes stay separate:
 *
 * | Execution | Meaning | Examples |
 * |---|---|---|
 * | `inline` | Terminates, and the caller blocks for it under the inline budget | `npm run build`, `npm test`, `npx tsc`, `cargo build/check/test`, `bun test`, `make`, `pytest`, `go build` |
 * | `job` | Terminates eventually, but not on a human's timescale — a handle now | `npm install`, `npm ci`, `docker build`, `sleep 3600`, unknown `npm run <name>` |
 * | `server` | Never exits on its own; a handle now, and said so distinctly | `npm run dev`, `vite`, `next dev`, `python -m http.server`, `tsc --watch`, `npm start` |
 *
 * Classification is by command pattern, never by the model's declaration (§11). npm scripts
 * are opaque — nothing can read a `package.json` that may not exist yet — so `npm run <name>`
 * is classified by the naming conventions every project shares, and a name that matches
 * neither keeps the heavy default of a job.
 */
export type CommandExecution = "inline" | "job" | "server";

/** Long-lived by nature: none of these returns to a prompt without being killed. */
const SERVER_EXECUTABLES: Readonly<Record<string, true>> = Object.freeze({
  serve: true, "http-server": true, "https-server": true, "live-server": true, "lite-server": true,
  "webpack-dev-server": true, "json-server": true, "browser-sync": true, nodemon: true, watchexec: true,
  entr: true, nginx: true, caddy: true, httpd: true, uvicorn: true, gunicorn: true, hypercorn: true,
  daphne: true, puma: true, storybook: true, "start-storybook": true, ngrok: true,
});

/** Script names that stand up something long-lived, anywhere in a `:`/`-`/`_` separated name. */
const SERVER_SCRIPT = /(^|[:._-])(dev|serve|server|start|preview|watch|storybook|hmr|tunnel)([:._-]|$)/;
/** Script-name stems that terminate. Everything else keeps the heavy default. */
const FINITE_SCRIPT = /^(build|compile|bundle|test|tests|typecheck|types|tsc|check|checks|lint|format|fmt|coverage|cover|e2e|ci|verify|validate|docs|doc|clean|bench|audit)$/;

const WATCH_ARGUMENTS: readonly string[] = ["--watch", "--watchall", "--watch-all", "--serve", "--hot", "--hmr", "--live-reload", "--reload", "--watch-poll"];
/** Tools whose `-w` means "watch"; `grep -w` and `sort -w` mean something else entirely. */
const SHORT_WATCH_TOOLS: Readonly<Record<string, true>> = Object.freeze({
  tsc: true, rollup: true, esbuild: true, webpack: true, swc: true, babel: true, sass: true, tailwindcss: true, parcel: true, jest: true,
});

function watching(executable: string, args: readonly string[]): boolean {
  return args.some((argument) => {
    const value = argument.toLowerCase();
    if (WATCH_ARGUMENTS.includes(value)) return true;
    if (value.startsWith("--watch=")) return value !== "--watch=false";
    return value === "-w" && SHORT_WATCH_TOOLS[executable] === true;
  });
}

function words(args: readonly string[]): string[] {
  return args.filter((argument) => !argument.startsWith("-")).map((argument) => argument.toLowerCase());
}

function scriptExecution(name: string | undefined): CommandExecution {
  if (name === undefined || name.length === 0) return "job";
  const lower = name.toLowerCase();
  if (SERVER_SCRIPT.test(lower)) return "server";
  return FINITE_SCRIPT.test(lower.split(":")[0]!) ? "inline" : "job";
}

/** Dependency work: finite, but on the network's timescale rather than the agent's (§11). */
const INSTALL_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "audit", "dedupe",
  "prune", "rebuild", "link", "unlink", "publish", "pack", "init", "create", "exec", "dlx", "x", "import",
]);

function packageManagerExecution(manager: string, args: readonly string[]): CommandExecution {
  const rest = words(args);
  const first = rest[0];
  if (first === undefined) return "job";
  if (first === "run" || first === "run-script" || first === "task") return scriptExecution(rest[1]);
  if (first === "test" || first === "t") return "inline";
  if (first === "build" && (manager === "bun" || manager === "deno")) return "inline";
  if (first === "start") return "server";
  if (INSTALL_SUBCOMMANDS.has(first)) return "job";
  if (manager === "deno") {
    if (first === "serve") return "server";
    return ["check", "lint", "fmt", "bundle", "compile", "cache", "info", "doc", "bench"].includes(first) ? "inline" : "job";
  }
  // yarn and pnpm let a script name stand alone — `yarn build` is `yarn run build`. npm and
  // bun do not, so an unrecognised word there is something else entirely.
  return manager === "yarn" || manager === "pnpm" ? scriptExecution(first) : "job";
}

/** `npx tsc` is `tsc`: the runner is a delivery mechanism, not the command. */
function stripRunnerFlags(args: readonly string[]): string[] {
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "-p" || argument === "--package" || argument === "-c" || argument === "--call") { index += 1; continue; }
    if (argument.startsWith("-")) continue;
    rest.push(...args.slice(index));
    break;
  }
  return rest;
}

function subcommandExecution(subcommand: string | undefined, finite: readonly string[], server: readonly string[]): CommandExecution {
  if (subcommand === undefined) return "job";
  if (server.includes(subcommand)) return "server";
  return finite.includes(subcommand) ? "inline" : "job";
}

function executionOfSegment(segment: string): CommandExecution {
  const parsed = commandTokens(segment);
  if (parsed === undefined) return "inline";
  const { executable, args } = parsed;
  if (executable === "bash" || executable === "sh" || executable === "zsh") {
    const inlineIndex = args.findIndex((argument, index) => (argument === "-c" || argument === "-lc" || argument === "-ec") && args[index + 1] !== undefined);
    if (inlineIndex >= 0) return classifyExecution(args[inlineIndex + 1]!);
  }
  if (executable === "npx" || executable === "bunx" || executable === "pnpx" || executable === "yarn-dlx") {
    const rest = stripRunnerFlags(args);
    return rest.length === 0 ? "job" : executionOfSegment(rest.join(" "));
  }
  if (SERVER_EXECUTABLES[executable] === true) return "server";
  if (watching(executable, args)) return "server";
  const rest = words(args);
  const first = rest[0];
  switch (executable) {
    case "npm": case "pnpm": case "yarn": case "bun": case "deno":
      return packageManagerExecution(executable, args);
    case "cargo":
      if (first === "watch") return "server";
      return subcommandExecution(first, ["build", "b", "check", "c", "test", "t", "clippy", "fmt", "doc", "bench", "tree", "metadata", "fetch", "vendor", "package"], []);
    case "go":
      return subcommandExecution(first, ["build", "test", "vet", "fmt", "generate", "mod", "list", "doc", "work"], []);
    case "tsc": case "esbuild": case "rollup": case "swc": case "babel": case "sass": case "tailwindcss":
      return "inline";
    case "vite": case "parcel": case "astro": case "nuxt": case "remix": case "wrangler":
      // A bare `vite` *is* the dev server; only an explicit build or check terminates.
      if (first === undefined) return "server";
      return subcommandExecution(first, ["build", "check", "optimize", "types", "sync", "deploy"], ["dev", "serve", "preview", "start", "watch"]);
    case "next": case "ng": case "react-scripts": case "vue-cli-service": case "expo": case "gatsby":
      return subcommandExecution(first, ["build", "lint", "test", "export", "e2e", "info", "telemetry"], ["dev", "serve", "start", "preview", "watch"]);
    case "webpack":
      return first === "serve" || first === "watch" ? "server" : "inline";
    case "vitest":
      // `vitest` alone is watch mode; only `vitest run` ends.
      return first === "run" || first === "bench" || first === "related" || first === "typecheck" ? "inline" : "server";
    case "jest": case "mocha": case "ava": case "pytest": case "phpunit": case "rspec": case "tox": case "nox":
      return "inline";
    case "make": case "gmake": case "cmake": case "ninja": case "bazel": case "buck": case "gradle": case "mvn": case "maven":
      return first !== undefined && SERVER_SCRIPT.test(first) ? "server" : "inline";
    case "xcodebuild": case "swift": case "dotnet": case "rustc": case "clang": case "gcc": case "g++": case "javac":
      return executable === "dotnet" || executable === "swift" ? subcommandExecution(first, ["build", "test", "publish", "restore", "pack", "format"], ["run", "watch"]) : "inline";
    case "python": case "python3": case "python2":
      // `python -m http.server` is the canonical throwaway web server.
      if (args.some((argument) => /^http\.server$|^SimpleHTTPServer$/i.test(argument))) return "server";
      break;
    case "php":
      return args.includes("-S") ? "server" : "inline";
    case "docker": case "podman":
      // Images and containers are the heavy-but-finite case, exactly like `npm install`:
      // a handle now, output later. Only `up`/`start` never come back.
      return first === "up" || first === "start" ? "server" : "job";
    case "ruby":
      return args.includes("-run") ? "server" : "inline";
    default:
      break;
  }
  // Everything the tables do not name keeps today's rule exactly: heavy is a job, and
  // anything lighter has always blocked.
  return classifySegment(segment) === "heavy" ? "job" : "inline";
}

/**
 * Decide whether a command blocks the caller, hands back a job, or is a server. Composed
 * across a compound command by severity: one server segment makes the whole line a server,
 * and one job segment makes it a job.
 *
 * A trailing-`&` line that stands a server up inline — `node server.js & sleep 1; curl …` —
 * stays `inline` on purpose, and the temptation to reclassify it as a `server` is a trap. The
 * foreground half of that line (the curls) *is* the answer the model asked for, so handing
 * back a job id would withhold the output and make the model chase a handle for a result it
 * had already produced. What made the inline path look broken was never the classification: it
 * was `#spawn` waiting for pipe EOF, which the backgrounded server held open until the
 * deadline. With the call ending on the shell's own exit, the line returns in its real 2.1s
 * with its curl output intact, and the server it left running is named in `survivors` instead
 * of being silently killed — which is the better answer on both axes.
 */
export function classifyExecution(command: string): CommandExecution {
  if (typeof command !== "string" || command.trim().length === 0) return "inline";
  let result: CommandExecution = "inline";
  for (const segment of splitShellCommands(command)) {
    const execution = executionOfSegment(segment);
    if (execution === "server") return "server";
    if (execution === "job") result = "job";
  }
  return result;
}

interface NormalizedRequest {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  background?: boolean;
  inlineBudgetMs?: number;
  owner?: string;
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
  const background = value.background;
  if (background !== undefined && typeof background !== "boolean") {
    throw new ProcessRequestError("Process background must be a boolean when provided");
  }
  const inlineBudget = value.inlineBudgetMs;
  if (inlineBudget !== undefined && (typeof inlineBudget !== "number" || !Number.isSafeInteger(inlineBudget) || inlineBudget <= 0)) {
    throw new ProcessRequestError("Process inlineBudgetMs must be a positive safe integer when provided");
  }
  const owner = value.owner;
  if (owner !== undefined && (typeof owner !== "string" || owner.length === 0)) {
    throw new ProcessRequestError("Process owner must be a non-empty string when provided");
  }
  return {
    command: value.command,
    cwd: value.cwd,
    ...(timeout === undefined ? {} : { timeoutMs: timeout }),
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
    ...(background === undefined ? {} : { background }),
    ...(inlineBudget === undefined ? {} : { inlineBudgetMs: inlineBudget }),
    ...(owner === undefined ? {} : { owner }),
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
  cgroupUnit?: string;
  result?: ProcessResult;
  cancelRequested: boolean;
  deadlineRequested: boolean;
  settled: boolean;
  /** Set once this job's output has actually reached someone. */
  collected: boolean;
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
  /** How many settled jobs stay retrievable through wait/status/list before ageing out. */
  retainSettledJobs?: number;
  /** Wrap heavy Linux jobs in a transient systemd user service. */
  cgroup?: boolean;
}
export interface ProcessStatus {
  readonly id: string;
  readonly class: ProcessClass;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly status: JobHandle["status"];
}

function snapshotHandle(job: JobInternal): JobHandle {
  return { ...job.handle, ...(job.collected ? { collected: true } : {}) };
}

function signalNameFromExitCode(exitCode: number | null): string | null {
  if (exitCode === null || exitCode < 129 || exitCode > 192) return null;
  const names: Record<number, string> = {
    1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 6: "SIGABRT", 9: "SIGKILL", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM",
  };
  return names[exitCode - 128] ?? null;
}

/**
 * An incremental reader for one of the child's pipes.
 *
 * Reading a pipe to EOF is *not* the same question as "has the command finished", and
 * conflating them was a live bug: `node server.js & sleep 1; curl …` printed everything and
 * the shell exited in 2.1s, but the orphaned server inherited the stdout pipe, EOF never came,
 * and the call sat until its 120s deadline and then reported `exit_code: 0` beside
 * `timed_out: true` and `signal: SIGTERM` — three claims that cannot all be true. So bytes are
 * accumulated as they arrive and the call ends on the shell's exit instead.
 */
interface OutputCollector {
  /** Everything read so far. */
  text(): string;
  /**
   * Stop accumulating, but keep draining the pipe.
   *
   * Deliberately not a cancel: closing our read end would hand the surviving grandchild an
   * EPIPE on its next log line and kill the very server the model asked to keep running
   * (§11's reap split below). Discarding costs nothing and the pipe dies with the group when
   * the host is closed.
   */
  detach(): void;
  /** Resolves when the pipe reaches EOF on its own. */
  readonly done: Promise<void>;
}

function collectOutput(stream: unknown): OutputCollector {
  if (stream === null || stream === undefined || typeof stream === "number") {
    return { text: () => "", detach: () => {}, done: Promise.resolve() };
  }
  const decoder = new TextDecoder();
  let text = "";
  let detached = false;
  const done = (async () => {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done === true) break;
        // After `detach` the bytes are still read — see the comment above — and dropped.
        if (!detached && chunk.value !== undefined) text += decoder.decode(chunk.value, { stream: true });
      }
      if (!detached) text += decoder.decode();
    } catch (error: unknown) {
      if (!detached) text += `Unable to read process output: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      try { reader.releaseLock(); } catch { /* already released by a cancelled stream */ }
    }
  })();
  return { text: () => text, detach: () => { detached = true; }, done };
}

function processGroupAlive(pgid: number): boolean { try { process.kill(-pgid, 0); return true; } catch (error) { return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "EPERM"; } }

/**
 * Name the processes still alive in a job's process group.
 *
 * The child is its own group leader (`detached: true`), so the group is exactly "the shell and
 * everything it started". `ps -A` plus a filter rather than `ps -g <pgid>`: BSD's `-g` selects
 * by process group, but procps' `-g` selects by *session* id, so the obvious portable-looking
 * spelling silently answers a different question on Linux.
 *
 * Failure is never fatal — a survey is a courtesy, not the result. When `ps` cannot be read we
 * still know from `processGroupAlive` that *something* is there, so the group leader's id is
 * reported with no command rather than pretending the group was empty (§3.8).
 */
async function surveyProcessGroup(pgid: number): Promise<readonly ProcessSurvivor[]> {
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || !processGroupAlive(pgid)) return [];
  const unidentified: readonly ProcessSurvivor[] = [{ pid: pgid, command: "" }];
  let ps: Bun.Subprocess | undefined;
  try {
    ps = Bun.spawn(["ps", "-A", "-o", "pgid=,pid=,args="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const text = await Promise.race([
      new Response(ps.stdout as unknown as BodyInit).text(),
      Bun.sleep(SURVIVOR_SURVEY_TIMEOUT_MS).then(() => undefined),
    ]);
    if (text === undefined) return unidentified;
    const survivors: ProcessSurvivor[] = [];
    for (const line of text.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match === null) continue;
      const pid = Number(match[2]);
      // The group leader *is* the shell, which is gone by the time this runs; excluding it
      // guards the case where its slot has not yet disappeared from the table.
      if (Number(match[1]) !== pgid || pid === pgid) continue;
      survivors.push({ pid, command: match[3]!.trim().slice(0, SURVIVOR_COMMAND_LIMIT) });
    }
    // An alive group that lists nothing is a race with the last member exiting, not a survivor.
    return survivors;
  } catch {
    return unidentified;
  } finally {
    if (ps !== undefined) { try { ps.kill("SIGKILL"); } catch { /* already exited */ } }
  }
}

function killProcessTree(child: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void {
  if (typeof child.pid === "number" && child.pid > 1) {
    try { process.kill(-child.pid, signal); } catch { /* the group may have exited */ }
  }
  try { child.kill(signal); } catch { /* the child may have exited between checks */ }
}

function killCgroupUnit(unit: string, signal: "SIGTERM" | "SIGKILL"): void {
  try { const child = Bun.spawn(["/usr/bin/env", "systemctl", "--user", "kill", "--kill-whom=all", `--signal=${signal}`, unit], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); void child.exited; }
  catch { /* systemd-run will still report the service failure through its own process */ }
}

async function reapProcessGroup(child: Bun.Subprocess): Promise<void> {
  if (typeof child.pid !== "number" || child.pid <= 1 || !processGroupAlive(child.pid)) return;
  killProcessTree(child, "SIGTERM");
  await Bun.sleep(150);
  if (processGroupAlive(child.pid)) killProcessTree(child, "SIGKILL");
}

/**
 * The same reap, for a group whose `Bun.Subprocess` is long gone.
 *
 * `processGroupAlive` is re-checked immediately before signalling because a pgid is just a
 * number the kernel recycles: signalling a remembered-but-dead group id is how a session-end
 * sweep ends up killing an unrelated process that happened to inherit it.
 */
async function reapGroup(pgid: number): Promise<void> {
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || !processGroupAlive(pgid)) return;
  try { process.kill(-pgid, "SIGTERM"); } catch { /* the group may have exited */ }
  await Bun.sleep(150);
  if (!processGroupAlive(pgid)) return;
  try { process.kill(-pgid, "SIGKILL"); } catch { /* the group may have exited */ }
}

export class ProcessHost implements HostProcess {
  readonly #semaphores: Readonly<Record<Exclude<ProcessClass, "free">, Semaphore>>;
  readonly #limits: ClassSemaphoreLimits;
  readonly #jobs = new Map<string, JobInternal>();
  /** Process groups completed jobs left running; §11's session-end sweep is `close`. */
  readonly #survivingGroups = new Set<number>();
  readonly #acquisitionTimeoutMs: number;
  readonly #defaultTimeoutMs: number;
  readonly #retainSettledJobs: number;
  readonly #cgroup: boolean;
  readonly #cgroupCpuQuota: string;
  #sequence = 0;
  #closed = false;

  constructor(options: ProcessHostOptions = {}) {
    const parallelism = options.nproc ?? options.parallelism ?? defaultParallelism();
    const defaults = classSemaphoreLimits(parallelism);
    const limits = {
      heavy: Math.min(options.heavyLimit ?? defaults.heavy, 8),
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
    const retainSettledJobs = options.retainSettledJobs ?? DEFAULT_RETAINED_SETTLED_JOBS;
    if (!Number.isFinite(acquisitionTimeoutMs) || acquisitionTimeoutMs < 0) throw new RangeError("acquisitionTimeoutMs must be non-negative");
    if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) throw new RangeError("defaultTimeoutMs must be positive");
    if (!Number.isSafeInteger(retainSettledJobs) || retainSettledJobs < 1) throw new RangeError("retainSettledJobs must be a positive safe integer");
    this.#limits = Object.freeze(limits);
    this.#semaphores = {
      heavy: new Semaphore(limits.heavy),
      io: new Semaphore(limits.io),
      light: new Semaphore(limits.light),
    };
    this.#acquisitionTimeoutMs = acquisitionTimeoutMs;
    this.#defaultTimeoutMs = defaultTimeoutMs;
    this.#retainSettledJobs = retainSettledJobs;
    this.#cgroup = options.cgroup === true && process.platform === "linux";
    this.#cgroupCpuQuota = `${Math.min(limits.heavy, 8) * 100}%`;
  }

  get limits(): ClassSemaphoreLimits { return this.#limits; }

  classify(command: string): ProcessClass { return classifyCommand(command); }

  /** The other axis: whether this command blocks the caller, is a job, or is a server. */
  execution(command: string): CommandExecution { return classifyExecution(command); }

  async run(request: ProcessRequest): Promise<ProcessResult | JobHandle> {
    const normalized = normalizeRequest(request);
    if (this.#closed) throw new ProcessClosedError();
    const processClass = classifyCommand(normalized.command);
    const execution = classifyExecution(normalized.command);
    const id = `job-${(++this.#sequence).toString(36).padStart(6, "0")}`;
    const handle: JobHandle = {
      id,
      class: processClass,
      command: normalized.command,
      cwd: normalized.cwd,
      startedAt: Date.now(),
      status: "queued",
      ...(normalized.owner === undefined ? {} : { owner: normalized.owner }),
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
      collected: false,
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
    // The semaphore class decided *where this queues*; the execution class decides *who
    // waits*. A finite build is heavy and still blocks, because its output is the answer.
    if (execution !== "inline" || normalized.background === true) return handle;
    if (normalized.inlineBudgetMs === undefined) { job.collected = true; return resultPromise; }
    // Past the budget the command is handed back rather than killed: it keeps running under
    // its own deadline and the caller collects it whenever it likes.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<JobHandle>((resolve) => {
      timer = setTimeout(() => resolve(handle), Math.min(normalized.inlineBudgetMs!, MAX_TIMER_MS));
    });
    try {
      const settled = await Promise.race([resultPromise, budget]);
      if (!("id" in settled)) job.collected = true;
      return settled;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * A job whose result is handed back here is *collected*: someone has the output, so the
   * turn-end report has nothing to say about it. A wait that times out collects nothing.
   */
  async wait(id: string, timeoutMs?: number): Promise<ProcessResult | undefined> {
    if (typeof id !== "string" || id.length === 0) return undefined;
    const job = this.#jobs.get(id);
    if (job === undefined) return undefined;
    const collect = (result: ProcessResult | undefined): ProcessResult | undefined => {
      if (result !== undefined) job.collected = true;
      return result;
    };
    if (timeoutMs === undefined) return job.resultPromise.then(collect) as Promise<ProcessResult>;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new ProcessRequestError("wait timeoutMs must be a non-negative safe integer");
    if (timeoutMs === 0) return collect(job.result);
    if (job.settled) return collect(job.result);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), Math.min(timeoutMs, MAX_TIMER_MS));
    });
    try {
      return collect(await Promise.race([job.resultPromise, timeout]));
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
    return [...this.#jobs.values()].map((job) => snapshotHandle(job));
  }

  list(): readonly JobHandle[] { return this.listJobs(); }

  status(id: string): JobHandle | undefined {
    const job = this.#jobs.get(id);
    return job === undefined ? undefined : snapshotHandle(job);
  }

  get(id: string): JobHandle | undefined { return this.status(id); }

  listStatuses(): readonly ProcessStatus[] {
    return this.listJobs();
  }

  getStatus(id: string): ProcessStatus | undefined { return this.status(id); }

  /**
   * Session end, and therefore where §11's "nothing is orphaned" is actually enforced.
   *
   * A completed job deliberately leaves its background descendants running (see the reap split
   * in `#spawn`), so closing has to sweep them: every group a finished job left behind is
   * reaped here alongside the jobs still in flight. Without this half, "descendants survive
   * the call" would mean "descendants survive the process", which is the leak §11 forbids.
   */
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
    const groups = [...this.#survivingGroups];
    this.#survivingGroups.clear();
    await Promise.all(groups.map((pgid) => reapGroup(pgid)));
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
      const command = this.#cgroup && job.class === "heavy" ? this.#cgroupCommand(job) : ["/bin/bash", "-lc", job.request.command];
      child = Bun.spawn(command, {
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
        timedOut: false,
        durationMs: Date.now() - started,
      };
    }

    const pgid = typeof child.pid === "number" ? child.pid : 0;
    let exited = false;
    let terminationSignal: string | null = null;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (): void => {
      // Only a kill aimed at a *live* shell is that shell's termination signal. Once the shell
      // has exited, `terminate` is only ever sweeping descendants — recording SIGTERM there is
      // how a command that exited 0 came back carrying a signal it never received.
      if (!exited && terminationSignal === null) terminationSignal = "SIGTERM";
      if (job.cgroupUnit) killCgroupUnit(job.cgroupUnit, "SIGTERM");
      killProcessTree(child, "SIGTERM");
      if (forceTimer === undefined) {
        forceTimer = setTimeout(() => { if (job.cgroupUnit) killCgroupUnit(job.cgroupUnit, "SIGKILL"); killProcessTree(child, "SIGKILL"); }, 150);
      }
    };
    const onAbort = (): void => terminate();
    job.controller.signal.addEventListener("abort", onAbort, { once: true });
    if (job.controller.signal.aborted) terminate();

    // Started before the first await so nothing the shell writes early can be missed.
    const stdout = collectOutput(child.stdout);
    const stderr = collectOutput(child.stderr);
    let killedByDeadline = false;

    try {
      const timeoutMs = job.request.timeoutMs ?? (job.class === "heavy" ? undefined : this.#defaultTimeoutMs);
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined) {
        deadlineTimer = setTimeout(() => {
          // A shell that already exited cannot be late. Before this guard the deadline fired
          // during the pipe-EOF wait a backgrounded grandchild was holding open, and a command
          // that finished in 2.1s reported itself timed out at 120s.
          if (exited) return;
          killedByDeadline = true;
          job.deadlineRequested = true;
          if (!job.controller.signal.aborted) job.controller.abort(new Error(`Process exceeded its ${timeoutMs}ms deadline`));
        }, Math.min(timeoutMs, MAX_TIMER_MS));
      }
      try {
        // The shell's own exit is the completion signal — never pipe EOF, which belongs to
        // whichever descendant holds the pipe last (see `OutputCollector`).
        const exitCode = await child.exited;
        exited = true;
        // Snapshotted here: a later `cancel` or `close` aimed at the surviving descendants
        // must not retroactively rewrite how this shell ended. `durationMs` is the shell's own
        // lifetime for the same reason — the drain grace and the survivor survey below are this
        // host's bookkeeping, and charging them to the command would make the reported duration
        // disagree with the "shell exited in 2.1s" the model is shown.
        const signal = terminationSignal ?? signalNameFromExitCode(exitCode);
        const timedOut = killedByDeadline;
        const durationMs = Date.now() - started;
        await Promise.race([Promise.all([stdout.done, stderr.done]), Bun.sleep(OUTPUT_DRAIN_GRACE_MS)]);
        stdout.detach();
        stderr.detach();
        // Only a job reaching its own natural end can leave anything behind; the other two
        // paths reap the whole group in the `finally` below, so the survey would be a lie.
        const survivors = timedOut || job.cancelRequested ? [] : await surveyProcessGroup(pgid);
        return {
          stdout: stdout.text(),
          stderr: stderr.text(),
          exitCode,
          signal,
          timedOut,
          durationMs,
          ...(survivors.length === 0 ? {} : { survivors }),
        };
      } catch (error: unknown) {
        return {
          stdout: stdout.text(),
          stderr: `Unable to collect process output: ${error instanceof Error ? error.message : String(error)}`,
          exitCode: null,
          signal: terminationSignal,
          timedOut: killedByDeadline,
          durationMs: Date.now() - started,
        };
      } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        // Idempotent, and the safety net for the error path: an attached collector would keep
        // appending a survivor's output to a string nobody will ever read again.
        stdout.detach();
        stderr.detach();
      }
    } finally {
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      job.controller.signal.removeEventListener("abort", onAbort);
      // The §11 reap split. "Nothing is orphaned. Session end kills its process tree" is a
      // *session*-level promise, and enforcing it per call is what limited a live session's
      // `node server.js &` to a single call: the server the model deliberately backgrounded
      // was killed the instant the call that started it returned, so the start-a-server-then-
      // poke-it-from-the-next-call pattern could not work at all. A job that reaches its own
      // natural end therefore leaves its descendants alone and hands the group to `close`,
      // which is where session end actually is. The two paths where killing the tree *is* the
      // correct answer keep it: a cancelled job (the caller asked for it to stop) and a job
      // the deadline killed (its shell was still running, so its children are that shell's
      // unfinished work, not something it chose to leave behind).
      if (job.cancelRequested || killedByDeadline) await reapProcessGroup(child);
      else this.#trackSurvivingGroup(pgid);
      job.child = undefined;
    }
  }

  /** Remember a group a completed job left running, so `close` can honour §11 at session end. */
  #trackSurvivingGroup(pgid: number): void {
    if (!Number.isSafeInteger(pgid) || pgid <= 1 || !processGroupAlive(pgid)) return;
    this.#survivingGroups.add(pgid);
  }
  #cgroupCommand(job: JobInternal): string[] {
    const unit = `lyra-${process.pid}-${job.handle.id}`;
    job.cgroupUnit = unit;
    const inheritedEnvironment = Object.keys(process.env).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).map((name) => `--setenv=${name}`);
    return ["/usr/bin/env", "systemd-run", "--user", "--pipe", "--wait", "--collect", "--quiet", `--unit=${unit}`, `--working-directory=${job.request.cwd}`, "--service-type=exec", "--property=MemoryMax=4G", `--property=CPUQuota=${this.#cgroupCpuQuota}`, "--property=TasksMax=512", "--property=PrivatePIDs=yes", ...inheritedEnvironment, "/bin/bash", "-lc", job.request.command];
  }

  #settle(job: JobInternal, result: ProcessResult): void {
    if (job.settled) return;
    job.settled = true;
    job.result = result;
    if (job.cancelRequested) job.handle.status = "cancelled";
    else if (result.exitCode === 0 && !job.deadlineRequested) job.handle.status = "completed";
    else job.handle.status = "failed";
    job.resolveResult(result);
    this.#pruneSettledJobs();
  }

  /**
   * A settled job holds its whole ProcessResult — complete stdout and stderr — so the map cannot
   * be allowed to grow for the life of a session (§11). Heavy jobs hand a bare id to the model,
   * so results stay retrievable for a while; only the oldest settled entries age out, and a job
   * that is still queued or running is never evicted.
   */
  #pruneSettledJobs(): void {
    let settled = 0;
    for (const job of this.#jobs.values()) if (job.settled) settled += 1;
    let excess = settled - this.#retainSettledJobs;
    if (excess <= 0) return;
    for (const [id, job] of this.#jobs) {
      if (excess <= 0) break;
      if (!job.settled) continue;
      this.#jobs.delete(id);
      excess -= 1;
    }
  }

  #cancelledResult(job: JobInternal, message: string): ProcessResult {
    return {
      stdout: "",
      stderr: message,
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      durationMs: Math.max(0, Date.now() - job.handle.startedAt),
    };
  }

  #failedResult(job: JobInternal, message: string): ProcessResult {
    return {
      stdout: "",
      stderr: message,
      exitCode: null,
      signal: null,
      // A queue timeout is the *host* refusing to start work, not a shell overrunning its
      // deadline; conflating them would tell the model its command ran and was too slow.
      timedOut: false,
      durationMs: Math.max(0, Date.now() - job.handle.startedAt),
    };
  }
}

export function createHostProcess(options: ProcessHostOptions = {}): ProcessHost {
  return new ProcessHost(options);
}

export type { HostProcess, JobHandle, ProcessClass, ProcessRequest, ProcessResult, ProcessSurvivor } from "./types.ts";
