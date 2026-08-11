#!/usr/bin/env bun
import { realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AgentTurnResult } from "@lyra/core";
import { runPluginsCommand } from "./plugins.ts";
import { needsProviderSetup, providerSetupText } from "./provider-setup.ts";
import { LyraRuntime } from "./runtime.ts";

/**
 * The Lyra entry point. Three modes, one runtime (DESIGN.md §2):
 *
 * - `--acp`            serve the ACP control plane on this process's stdio.
 * - `--prompt` / piped  one non-interactive turn, streamed to stdout.
 * - interactive         spawn the `lyra-tui` binary and hand it the very same
 *                       `AcpDaemon` over a private pipe pair. The TUI owns
 *                       input, state, and rendering; this file owns nothing but
 *                       argument parsing, process lifetime, and that pipe.
 *
 * There is no frame protocol, no UI state, and no wizard here any more: the old
 * `FrameRequest`/`UiRow`/`InteractiveUi`/`ProviderSetupUi`/`TuiBridge` design —
 * a stateless Rust renderer fed whole-UI frames — is the defect the rewrite
 * removed. Every picker and wizard is now an ACP flow inside the TUI.
 */

interface CliOptions { origin: string; session?: string; model?: string; prompt?: string; acp: boolean; help: boolean; }

/** The live runtime a signal must close. */
let shutdownTarget: { close(): Promise<void> } | undefined;

/**
 * ProcessHost spawns its children detached, in their own process groups, so a terminal signal
 * never reaches them: only a graceful close cascades the kill and reap that §11 requires
 * ("nothing is orphaned"). A second signal stops waiting for that and leaves immediately.
 */
function installShutdownHandlers(): void {
  let closing = false;
  const shutdown = (signal: "SIGINT" | "SIGTERM"): void => {
    const code = signal === "SIGINT" ? 130 : 143;
    const target = shutdownTarget;
    if (closing || target === undefined) { process.exit(code); return; }
    closing = true;
    void target.close().catch(() => undefined).then(() => process.exit(code));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // `lyra plugins …` is a management subcommand, not a session: it never boots a runtime, so it
  // is dispatched before argument parsing and returns without touching anything else. All of its
  // behaviour lives in plugins.ts; this file only routes.
  if (argv[0] === "plugins") {
    try { await runPluginsCommand(argv.slice(1)); }
    catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
    return;
  }
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(helpText()); return; }
  installShutdownHandlers();
  const runtimeOptions = options;
  if (options.acp) {
    const runtime = await LyraRuntime.create(runtimeOptions);
    shutdownTarget = runtime;
    try { await runtime.app.acp.serve(Bun.stdin.stream(), { write: (data) => { process.stdout.write(data); } }); }
    finally { await runtime.close(); }
  } else if (options.prompt !== undefined || !process.stdin.isTTY || !process.stdout.isTTY) {
    // The one mode with no wizard to offer. A daemon *does* boot unconfigured now, but a
    // single non-interactive turn has no way to run setup and no terminal to run it on, so
    // the instructions are still the honest answer here.
    if (await needsProviderSetup(options.origin, options.model)) { process.stderr.write(providerSetupText(options.origin)); process.exitCode = 1; return; }
    let streamed = false;
    const runtime = await LyraRuntime.create({ ...runtimeOptions, onReport: (message) => { process.stderr.write(`[report] ${message}\n`); }, onEvent: (event) => { if (event.type === "text_delta") { streamed = true; process.stdout.write(event.text); } } });
    shutdownTarget = runtime;
    try { const prompt = options.prompt ?? await new Response(Bun.stdin.stream()).text(); const result = await runtime.prompt(prompt.trim()); if (!streamed) process.stdout.write(assistantText(result)); process.stdout.write("\n"); }
    finally { await runtime.close(); }
  } else await runInteractive(runtimeOptions);
}

/**
 * Interactive mode: the TUI process *is* the ACP client.
 *
 * stdin/stdout of the child are the JSON-RPC pipe; stderr is inherited so a
 * panic is visible. The child's own terminal I/O goes to `/dev/tty`, which it
 * opens itself — nothing here writes escape sequences, so a JSON-RPC stream and
 * a rendered frame can never collide.
 *
 * **A missing provider is no longer a refusal to start.** This used to print
 * instructions and exit 1, which meant the one surface that can run setup — the
 * TUI — was the one surface a first-time user could never reach. The daemon now
 * boots unconfigured (`session/snapshot` says so), the TUI opens its wizard, and
 * `provider/add` is the way out. Only the non-interactive modes, which have no
 * wizard, still print the instructions.
 *
 * Shutdown runs in both directions: the TUI exiting closes its stdout, which
 * ends `serve()` and closes the daemon; the daemon ending closes the child's
 * stdin, which the TUI sees as EOF and treats as a clean disconnect.
 */
async function runInteractive(cli: CliOptions): Promise<void> {
  const binary = await resolveTuiBinary();
  const child = Bun.spawn([binary], { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  let runtime: LyraRuntime;
  // Booting the runtime can still fail (unreadable config, a role naming nothing). The child is
  // already running by then, and by then it has also started probing the terminal — so killing
  // it is not enough. A killed child never finishes its own teardown, and the replies to the
  // probes it had in flight (`4;0;rgb:…` palette answers) land in the shell that outlives it.
  // Closing its stdin is the same clean disconnect a normal exit uses: the child sees EOF,
  // restores the terminal itself, and only a child that will not take that hint is killed.
  try { runtime = await LyraRuntime.create(cli); }
  catch (error) { await endChild(child); throw error; }
  let ended = false;
  const endInput = (): void => { if (ended) return; ended = true; try { child.stdin.end(); } catch { /* the child already went away */ } };
  shutdownTarget = { close: async () => { endInput(); await runtime.close(); } };
  try {
    await runtime.app.acp.serve(child.stdout, {
      write: (data) => { if (ended) return; child.stdin.write(data); void child.stdin.flush(); },
    });
  } finally {
    endInput();
    await runtime.close();
    const code = await child.exited;
    if (code !== 0 && process.exitCode === undefined) process.exitCode = code;
  }
}

/** How long a TUI child is given to see EOF and restore the terminal before it is killed. */
const CHILD_SHUTDOWN_GRACE_MS = 2_000;

/**
 * Shut a spawned TUI down the way it expects to be shut down: EOF on stdin, which it treats as
 * a clean disconnect and answers by restoring the keyboard and screen modes it set. The kill is
 * the fallback, not the plan — a child killed mid-probe leaves its own escape sequences and the
 * terminal's replies to them in the user's shell.
 */
async function endChild(child: { stdin?: { end(): void } | null; exited: Promise<number>; kill(): void }): Promise<void> {
  try { child.stdin?.end(); } catch { /* already gone; the wait below is still correct */ }
  const exited = await Promise.race([child.exited, Bun.sleep(CHILD_SHUTDOWN_GRACE_MS).then(() => undefined)]);
  if (exited !== undefined) return;
  child.kill();
  await child.exited;
}

/**
 * Where the TUI binary lives, in the order a real installation makes true:
 * an explicit override, then a sibling of this executable (the packaged bundle
 * puts `lyra` and `lyra-tui` in one directory), then the cargo release
 * directory of a source checkout.
 */
async function resolveTuiBinary(): Promise<string> {
  const name = process.platform === "win32" ? "lyra-tui.exe" : "lyra-tui";
  const override = process.env.LYRA_TUI_BIN;
  if (override) {
    const path = resolve(override);
    if (await exists(path)) return path;
    throw new Error(`LYRA_TUI_BIN points at ${path}, which does not exist.`);
  }
  const workspace = resolve(import.meta.dir, "..", "..", "..");
  const candidates = [
    join(dirname(realpathSync(process.execPath)), name),
    join(workspace, "target", "release", name),
    join(workspace, "packages", "lyra-tui", "target", "release", name),
  ];
  const binary = await firstAccessible(candidates);
  if (binary) return binary;
  throw new Error(
    `The Lyra TUI binary (${name}) was not found.\n` +
    `  Looked in:\n${candidates.map((path) => `    ${path}\n`).join("")}` +
    `  Build it from a source checkout with:\n` +
    `    cargo build --release -p lyra-tui\n` +
    `  or build the whole distributable bundle with:\n` +
    `    bun run build\n` +
    `  An installed copy must sit next to the \`lyra\` executable; ` +
    `set LYRA_TUI_BIN to point somewhere else.\n` +
    `  Non-interactive modes (--prompt, piped stdin, --acp) need no TUI binary.`,
  );
}

function parseArgs(args: string[]): CliOptions { const parsed: CliOptions = { origin: process.cwd(), acp: false, help: false }; for (let index = 0; index < args.length; index += 1) { const arg = args[index]!; if (arg === "--help" || arg === "-h") parsed.help = true; else if (arg === "--acp") parsed.acp = true; else if (arg === "--yes-auto-git") throw new Error("--yes-auto-git is gone: there is no auto Git mode to consent to. Lyra runs in the launch directory and every state-changing tool call is checkpointed, so /rollback is the undo. Integrating an agent workspace is something you ask the model to do."); else if (arg === "--origin" || arg === "--session" || arg === "--model" || arg === "--prompt") { const value = args[++index]; if (!value) throw new Error(`${arg} requires a value.`); if (arg === "--origin") parsed.origin = resolve(value); else if (arg === "--session") parsed.session = value; else if (arg === "--model") parsed.model = value; else parsed.prompt = value; } else throw new Error(`Unknown argument ${arg}. Use --help.`); } return parsed; }
function assistantText(result: AgentTurnResult): string { return result.assistant.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""); }
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function firstAccessible(paths: readonly string[]): Promise<string | undefined> { for (const path of paths) { if (await exists(path)) return path; } return undefined; }
function helpText(): string { return `Lyra — autonomous coding agent

Usage: lyra [--origin PATH] [--session NAME] [--model PROVIDER/MODEL] [--prompt TEXT] [--acp]
       lyra plugins <install|list|update|remove|login> …

Interactive launch starts the Lyra TUI and connects it to the agent daemon over a
private pipe. Configure a provider first (Lyra prints instructions if none exists).

Lyra works in the directory you launch it from — no clone, no copy, the paths you see are
the real ones. Every state-changing tool call is checkpointed into .lyra/checkpoints (a
shadow repository that never touches your own .git), so /checkpoints lists them and
/rollback puts the tree back. A rollback never reverts a file you changed yourself unless
you pass --force.

Interactive controls:
  Enter       send, or queue a follow-up while a turn is streaming
  Ctrl+S      flush the queue into the running turn as steering
  Shift+Enter insert a newline
  Esc         cancel the running turn; clear the composer when idle
  Esc Esc     rewind the last prompt back into the composer
  Ctrl+C      cancel the running turn; press twice to exit
  Tab         expand the last tool call
  Ctrl+P      command palette

Auth plugins (the one executable extension point — see docs/plugins.md):
  lyra plugins install <git-url|path> [id]   clone or copy into ~/.lyra/plugins
  lyra plugins list                          what is installed, and whether it loads
  lyra plugins update <id>                   git pull and re-validate
  lyra plugins remove <id>                   delete it
  lyra plugins login <id>                    run its interactive sign-in

Environment:
  LYRA_TUI_BIN  path to the lyra-tui binary, when it is not next to \`lyra\`
  LYRA_DEBUG=1  print the full stack trace when a launch fails, not just the reason

Configuration: ~/.lyra/config.toml, ~/.lyra/providers.toml, and <origin>/.lyra/config.toml
`; }

/**
 * The last line a failed launch prints.
 *
 * A boot failure used to escape `main()` entirely: Bun printed the exception with its own
 * stack, full of `$bunfs` paths from inside the compiled bundle, which is noise to everyone who
 * did not build Lyra and hides the one sentence that says what to fix. The message is the
 * whole report now, and the trace is available to anyone who asks for it by name.
 */
function failureReport(error: unknown, debug: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  const trace = debug && error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}\n` : "";
  return `lyra: ${message.trim()}\n${trace}`;
}

try { await main(); }
catch (error) {
  process.stderr.write(failureReport(error, Bun.env.LYRA_DEBUG === "1"));
  process.exit(1);
}
