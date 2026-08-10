import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { authPluginRoot, isValidAuthPluginId, loadAuthPlugin, PluginAuth, type AuthPlugin } from "@lyra/provider";

/**
 * `lyra plugins` — the management surface for the one executable hatch (LYRA.md §5.5).
 *
 * The *loader* is `@lyra/provider`'s `loadAuthPlugin`, not this file: auth resolution has to
 * import and validate the plugin anyway, and a second validator here would be a second opinion
 * to drift from. This layer owns only what the provider layer must not — the filesystem, `git`,
 * and a terminal — which is also why it lives above it rather than inside it.
 *
 * Everything here is a function returning text. `cli.ts` dispatches; it does not decide.
 */

export interface PluginsCommandOptions {
  /** Home directory to manage plugins under. Defaults to the real one; tests point it away. */
  home?: string;
  /** Where progress goes as it happens. Defaults to stdout. */
  write?: (text: string) => void;
}

/**
 * The sentence a user reads before any third-party code reaches their disk.
 *
 * Lyra is YOLO by default (§1) and does not gate this behind a confirmation — a gate the user
 * would click through is not a safety property. What it does instead is refuse to be quiet
 * about it: the source is named, and what running it means is stated in the same breath.
 */
export function installWarning(source: string): string {
  return `Installing an auth plugin from ${source}.\n`
    + `  An auth plugin is executable code. Lyra imports it into its own process, so it runs\n`
    + `  with your environment variables, your filesystem access, and your network. Nothing\n`
    + `  sandboxes it. Install plugins you have read, or from people you trust.\n`;
}

export function pluginsHelpText(): string {
  return `Usage: lyra plugins <command>

  install <git-url|path> [id]  clone or copy an auth plugin into ~/.lyra/plugins
  list                         what is installed, where it came from, and whether it loads
  update <id>                  git pull an installed plugin and re-validate it
  remove <id>                  delete an installed plugin
  login <id>                   run the plugin's interactive sign-in, then verify a token

Wire a plugin to a provider in ~/.lyra/providers.toml:

  [providers.claude-max]
  base_url = "https://api.anthropic.com/v1"
  api_type = "anthropic_messages"
  auth     = { type = "plugin", plugin = "claude-oauth" }

See docs/plugins.md for the plugin contract.
`;
}

export async function runPluginsCommand(argv: readonly string[], options: PluginsCommandOptions = {}): Promise<void> {
  const say = options.write ?? ((text: string): void => { process.stdout.write(text); });
  const root = authPluginRoot(options.home ?? homedir());
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      say(pluginsHelpText());
      return;
    case "install":
      return installPlugin(rest[0], rest[1], root, say);
    case "list":
      return listPlugins(root, say);
    case "update":
      return updatePlugin(rest[0], root, say);
    case "remove":
      return removePlugin(rest[0], root, say);
    case "login":
      return loginPlugin(rest[0], root, say);
    default:
      throw new Error(`Unknown plugins command ${JSON.stringify(command)}.\n\n${pluginsHelpText()}`);
  }
}

// ---------------------------------------------------------------------------------------------

async function installPlugin(
  source: string | undefined,
  explicitId: string | undefined,
  root: string,
  say: (text: string) => void,
): Promise<void> {
  if (source === undefined) {
    throw new Error("`lyra plugins install` needs a source: a git URL, or a path to a directory containing plugin.ts.");
  }
  const git = await isGitSource(source);
  const id = explicitId ?? derivePluginId(source);
  if (!isValidAuthPluginId(id)) {
    throw new Error(
      `Cannot install ${source}: the name it derives to, ${JSON.stringify(id)}, is not a valid plugin id. `
      + `An id is a directory name — lowercase letters, digits and dashes, starting with a letter. `
      + `Give one explicitly: \`lyra plugins install ${source} <id>\`.`,
    );
  }
  const target = join(root, id);
  if (await pathExists(target)) {
    throw new Error(
      `Auth plugin ${id} is already installed at ${target}. Update it with \`lyra plugins update ${id}\`, `
      + `or remove it first with \`lyra plugins remove ${id}\`.`,
    );
  }

  say(installWarning(source));
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    if (git) await runGit(["clone", "--depth", "1", source, target], root);
    else await cp(resolve(source), target, { recursive: true });
  } catch (cause) {
    await rm(target, { recursive: true, force: true });
    throw new Error(`Could not install ${source} into ${target}: ${messageOf(cause)}.`, { cause });
  }

  let plugin: AuthPlugin;
  try {
    plugin = await loadAuthPlugin(id, root);
  } catch (cause) {
    // A directory that cannot load is not an installation, it is litter. Rolled back so
    // `lyra plugins list` never has to explain a half-installed plugin.
    await rm(target, { recursive: true, force: true });
    throw new Error(`Installed ${source} into ${target}, but it is not a usable auth plugin, so it was removed again.\n${messageOf(cause)}`, { cause });
  }

  say(`Installed auth plugin ${id} at ${target}.\n`);
  // What it will do to requests, stated at the moment it becomes able to do it. The login flow
  // is not repeated here — the next line is about nothing else.
  const traits = describeTraits(plugin);
  if (traits !== undefined) say(`  ${traits}\n`);
  say(plugin.login === undefined
    ? `  This plugin has no login flow — see its own documentation for where it reads credentials from.\n`
    : `  Next: \`lyra plugins login ${id}\`, then point a provider at it:\n`
      + `    auth = { type = "plugin", plugin = "${id}" }\n`);
}

interface InstalledPlugin {
  id: string;
  path: string;
  source?: string;
  valid: boolean;
  hasLogin: boolean;
  systemPrefix?: string;
  reason?: string;
}

/** What is installed, and — for each — whether it would actually work if a turn asked it to. */
export async function inspectPlugins(root: string): Promise<InstalledPlugin[]> {
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch { return []; }

  const plugins: InstalledPlugin[] = [];
  for (const id of entries) {
    const path = join(root, id);
    const source = await gitRemote(path);
    try {
      const plugin = await loadAuthPlugin(id, root);
      plugins.push({
        id, path, valid: true, hasLogin: plugin.login !== undefined,
        ...(source === undefined ? {} : { source }),
        ...(plugin.systemPrefix === undefined ? {} : { systemPrefix: plugin.systemPrefix }),
      });
    } catch (cause) {
      plugins.push({ id, path, valid: false, hasLogin: false, reason: messageOf(cause), ...(source === undefined ? {} : { source }) });
    }
  }
  return plugins;
}

async function listPlugins(root: string, say: (text: string) => void): Promise<void> {
  const plugins = await inspectPlugins(root);
  if (plugins.length === 0) {
    say(`No auth plugins are installed in ${root}.\nInstall one with \`lyra plugins install <git-url>\`.\n`);
    return;
  }
  for (const plugin of plugins) {
    const login = plugin.hasLogin ? "login" : "no login";
    say(`${plugin.id}  ${plugin.valid ? `ok, ${login}` : "INVALID"}\n`);
    say(`  path    ${plugin.path}\n`);
    say(`  source  ${plugin.source ?? "installed from a local path"}\n`);
    if (plugin.systemPrefix !== undefined) say(`  prefix  ${plugin.systemPrefix}\n`);
    if (plugin.reason !== undefined) say(`  reason  ${plugin.reason}\n`);
  }
}

async function updatePlugin(id: string | undefined, root: string, say: (text: string) => void): Promise<void> {
  const target = await installedDirectory(id, root, "update");
  if (!(await pathExists(join(target, ".git")))) {
    throw new Error(
      `Auth plugin ${id} was not installed from git, so there is nothing to pull. `
      + `Replace it in place, or reinstall it with \`lyra plugins remove ${id}\` then \`lyra plugins install <source>\`.`,
    );
  }
  const output = await runGit(["-C", target, "pull", "--ff-only"], root);
  say(output.trim().length === 0 ? `Updated ${id}.\n` : `${output.trim()}\n`);
  try {
    const plugin = await loadAuthPlugin(id!, root);
    say(`${id} still loads. ${describeCapabilities(plugin)}\n`);
  } catch (cause) {
    // Not rolled back: the user's own git history is right there, and deleting a repository
    // someone may have local work in would be the worse failure.
    throw new Error(`Pulled ${id}, but it no longer loads:\n${messageOf(cause)}\nRoll back with \`git -C ${target} reset --hard HEAD@{1}\`.`, { cause });
  }
}

async function removePlugin(id: string | undefined, root: string, say: (text: string) => void): Promise<void> {
  const target = await installedDirectory(id, root, "remove");
  await rm(target, { recursive: true, force: true });
  say(`Removed auth plugin ${id} from ${target}.\n`
    + `Any provider still declaring auth = { type = "plugin", plugin = "${id}" } will now fail to authenticate.\n`);
}

/**
 * The one place `login()` is ever called.
 *
 * A login flow opens a browser, prints a code, waits on a redirect — it owns the terminal for
 * as long as it takes. That is fine here and nowhere else: a turn that discovers a missing
 * credential must fail with a sentence, not silently start an interactive dance inside a
 * streaming response. `PluginAuth` never touches `login`; only this does.
 */
async function loginPlugin(id: string | undefined, root: string, say: (text: string) => void): Promise<void> {
  await installedDirectory(id, root, "log in to");
  const plugin = await loadAuthPlugin(id!, root);
  if (plugin.login === undefined) {
    throw new Error(
      `Auth plugin ${id} declares no login flow, so there is nothing to run. `
      + `It reads its credentials from somewhere else — see its own documentation, then check it with \`lyra plugins list\`.`,
    );
  }
  say(`Running ${id}'s login flow. It owns this terminal until it finishes.\n`);
  await plugin.login();

  // Sign-in that produces no usable token is a failure that used to surface on the next turn.
  const token = await new PluginAuth(id!, root).getToken();
  say(`Signed in to ${id}. ${describeExpiry(token.expiresAt)}\n`);
}

// ---------------------------------------------------------------------------------------------

async function installedDirectory(id: string | undefined, root: string, verb: string): Promise<string> {
  if (id === undefined) throw new Error(`\`lyra plugins ${verb === "log in to" ? "login" : verb}\` needs a plugin id. Run \`lyra plugins list\` to see what is installed.`);
  if (!isValidAuthPluginId(id)) throw new Error(`${JSON.stringify(id)} is not a valid plugin id: lowercase letters, digits and dashes, starting with a letter.`);
  const target = join(root, id);
  if (!(await pathExists(target))) {
    throw new Error(`Auth plugin ${id} is not installed, so there is nothing to ${verb}. Looked in ${target}. Run \`lyra plugins list\`, or install it with \`lyra plugins install <git-url>\`.`);
  }
  return target;
}

/** The repository or directory basename, minus the `.git` a clone URL carries. */
export function derivePluginId(source: string): string {
  const trimmed = source.replace(/[/\\]+$/, "");
  const name = basename(trimmed.includes(":") && !trimmed.includes("/") ? trimmed.split(":").pop()! : trimmed);
  return name.replace(/\.git$/, "");
}

/**
 * Whether a source is something `git clone` understands.
 *
 * A local path can be either: a working copy or a bare repository is cloned so `update` keeps
 * working, and a plain directory is copied. Checking the directory rather than the string is
 * what makes `lyra plugins install ./my-plugin` do the right thing in both cases.
 */
async function isGitSource(source: string): Promise<boolean> {
  if (/^(https?|git|ssh|file):\/\//.test(source) || /^[^/]+@[^/]+:/.test(source)) return true;
  if (source.endsWith(".git")) return true;
  const path = resolve(source);
  if (!(await pathExists(path))) {
    throw new Error(`Cannot install ${source}: it is neither a git URL nor a directory that exists.`);
  }
  if (await pathExists(join(path, ".git"))) return true;
  return (await pathExists(join(path, "HEAD"))) && (await pathExists(join(path, "objects")));
}

async function gitRemote(directory: string): Promise<string | undefined> {
  if (!(await pathExists(join(directory, ".git")))) return undefined;
  try { return (await runGit(["-C", directory, "remote", "get-url", "origin"], directory)).trim() || undefined; }
  catch { return undefined; }
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${code}): ${(stderr || stdout).trim()}`);
  return stdout;
}

function describeCapabilities(plugin: AuthPlugin): string {
  const traits = describeTraits(plugin);
  const login = plugin.login === undefined ? "No login flow" : "Has a login flow";
  return traits === undefined ? `${login}.` : `${login}; ${traits}`;
}

/** What a plugin adds to every request, or nothing when it only supplies a token. */
function describeTraits(plugin: AuthPlugin): string | undefined {
  const parts: string[] = [];
  const headers = Object.keys(plugin.headers ?? {});
  if (headers.length > 0) parts.push(`sends ${headers.join(", ")}`);
  if (plugin.systemPrefix !== undefined) parts.push(`prepends a system line: ${JSON.stringify(plugin.systemPrefix)}`);
  return parts.length === 0 ? undefined : `${parts.join("; ")}.`;
}

function describeExpiry(expiresAt: string | undefined): string {
  if (expiresAt === undefined) return "The token declares no expiry, so Lyra will keep using it until the endpoint rejects it.";
  const remaining = Date.parse(expiresAt) - Date.now();
  if (remaining <= 0) return `The token it returned is already expired (${expiresAt}); Lyra will ask the plugin to refresh it on first use.`;
  return `The token expires at ${expiresAt} (in ${Math.round(remaining / 60_000)} min); Lyra refreshes it shortly before then.`;
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
