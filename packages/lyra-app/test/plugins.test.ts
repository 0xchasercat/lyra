import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authPluginRoot } from "@lyra/provider";
import { LyraRuntime } from "../src/index.ts";
import { assertProviderUsable, credentialSource } from "../src/provider.ts";
import { derivePluginId, inspectPlugins, runPluginsCommand } from "../src/plugins.ts";

/**
 * `lyra plugins`, driven the way the CLI drives it.
 *
 * Every case uses a temporary home, a fixture plugin on disk, and — where git is involved — a
 * real local repository, because the failures this surface has to get right (a half-installed
 * directory, a plugin whose id does not match where it was put, a pull against something that
 * was never cloned) are all filesystem facts rather than logic.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

let counter = 0;

async function temporary(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `lyra-${prefix}-`));
  roots.push(path);
  return path;
}

/** A capture of everything the command wrote, plus the home it wrote it about. */
function recorder(): { write: (text: string) => void; text(): string } {
  const chunks: string[] = [];
  return { write: (text) => { chunks.push(text); }, text: () => chunks.join("") };
}

function pluginSource(id: string, extra = ""): string {
  return `export default {
  id: ${JSON.stringify(id)},
  systemPrefix: "You are a mandated identity line.",
  headers: { "x-beta": "on" },
  ${extra}
  async getToken() { return { token: "token-for-${id}" }; },
};
`;
}

/** A directory containing a plugin, ready to be installed from as a plain path. */
async function sourceDirectory(id: string, body?: string): Promise<string> {
  const parent = await temporary("plugin-src");
  const directory = join(parent, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "plugin.ts"), body ?? pluginSource(id));
  return directory;
}

async function git(args: readonly string[], cwd: string): Promise<void> {
  const child = Bun.spawn(["git", "-c", "user.email=t@lyra.test", "-c", "user.name=Lyra Test", ...args], {
    cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

/** A real git repository containing a plugin, so `install` and `update` exercise git itself. */
async function sourceRepository(id: string): Promise<string> {
  const directory = await sourceDirectory(id);
  await git(["init", "-b", "main", "."], directory);
  await git(["add", "."], directory);
  await git(["commit", "-m", "initial"], directory);
  return directory;
}

// -----------------------------------------------------------------------------------------------

describe("plugin id derivation", () => {
  test("comes from the repository or directory basename, minus .git", () => {
    expect(derivePluginId("https://github.com/someone/claude-oauth.git")).toBe("claude-oauth");
    expect(derivePluginId("https://github.com/someone/claude-oauth")).toBe("claude-oauth");
    expect(derivePluginId("git@github.com:someone/claude-oauth.git")).toBe("claude-oauth");
    expect(derivePluginId("/tmp/plugins/claude-oauth/")).toBe("claude-oauth");
    expect(derivePluginId("./claude-oauth")).toBe("claude-oauth");
  });
});

describe("lyra plugins install", () => {
  test("copies a local directory, says what it is about to run, and reports what it found", async () => {
    counter += 1;
    const id = `localplug${counter}`;
    const source = await sourceDirectory(id);
    const home = await temporary("home");
    const out = recorder();

    await runPluginsCommand(["install", source], { home, write: out.write });

    // The YOLO honesty line: the source, and what running it means. Named, not gated.
    expect(out.text()).toContain(`Installing an auth plugin from ${source}`);
    expect(out.text()).toContain("executable code");
    expect(out.text()).toContain("environment variables");
    expect(out.text()).toContain("Nothing\n  sandboxes it");

    expect(out.text()).toContain(`Installed auth plugin ${id}`);
    expect(out.text()).toContain("prepends a system line");
    expect(out.text()).toContain("x-beta");
    expect(await readFile(join(authPluginRoot(home), id, "plugin.ts"), "utf8")).toContain(id);
  });

  test("refuses to overwrite an existing plugin and points at update", async () => {
    counter += 1;
    const id = `dupeplug${counter}`;
    const source = await sourceDirectory(id);
    const home = await temporary("home");
    await runPluginsCommand(["install", source], { home, write: recorder().write });

    const failure = await runPluginsCommand(["install", source], { home, write: recorder().write })
      .catch((error: Error) => error.message);
    expect(failure).toContain("already installed");
    expect(failure).toContain(`lyra plugins update ${id}`);
    expect(failure).toContain(`lyra plugins remove ${id}`);
  });

  test("rolls back a directory that is not a usable plugin", async () => {
    counter += 1;
    const id = `brokenplug${counter}`;
    const source = await sourceDirectory(id, `export const notDefault = 1;`);
    const home = await temporary("home");

    const failure = await runPluginsCommand(["install", source], { home, write: recorder().write })
      .catch((error: Error) => error.message);
    expect(failure).toContain("not a usable auth plugin");
    expect(failure).toContain("has no default export");
    // Nothing is left behind for `list` to have to explain.
    expect(await inspectPlugins(authPluginRoot(home))).toEqual([]);
  });

  test("an id the directory name cannot supply is refused with the explicit form", async () => {
    const source = await sourceDirectory("Not_A_Valid_Id");
    const home = await temporary("home");
    const failure = await runPluginsCommand(["install", source], { home, write: recorder().write })
      .catch((error: Error) => error.message);
    expect(failure).toContain("is not a valid plugin id");
    expect(failure).toContain("<id>");
  });

  test("an explicit id overrides the derived one", async () => {
    counter += 1;
    const id = `renamed${counter}`;
    const source = await sourceDirectory("whatever-the-repo-is-called", pluginSource(id));
    const home = await temporary("home");
    await runPluginsCommand(["install", source, id], { home, write: recorder().write });
    expect((await inspectPlugins(authPluginRoot(home))).map((plugin) => plugin.id)).toEqual([id]);
  });

  test("a source that is neither a URL nor a directory says so", async () => {
    const home = await temporary("home");
    await expect(runPluginsCommand(["install", "/no/such/place"], { home, write: recorder().write }))
      .rejects.toThrow("neither a git URL nor a directory that exists");
  });
});

describe("lyra plugins list", () => {
  test("names the id, the source, the login flow and the prefix", async () => {
    counter += 1;
    const id = `listplug${counter}`;
    const source = await sourceRepository(id);
    const home = await temporary("home");
    await runPluginsCommand(["install", source], { home, write: recorder().write });

    const out = recorder();
    await runPluginsCommand(["list"], { home, write: out.write });
    expect(out.text()).toContain(`${id}  ok, no login`);
    expect(out.text()).toContain(source);
    expect(out.text()).toContain("You are a mandated identity line.");
  });

  test("an installed directory that stopped loading is INVALID with the reason", async () => {
    counter += 1;
    const id = `rotplug${counter}`;
    const home = await temporary("home");
    const root = authPluginRoot(home);
    await mkdir(join(root, id), { recursive: true });
    await writeFile(join(root, id, "plugin.ts"), `export default { id: "someone-else", async getToken() { return { token: "t" }; } };`);

    const out = recorder();
    await runPluginsCommand(["list"], { home, write: out.write });
    expect(out.text()).toContain(`${id}  INVALID`);
    expect(out.text()).toContain("declares id");
  });

  test("an empty plugin root says where it looked", async () => {
    const home = await temporary("home");
    const out = recorder();
    await runPluginsCommand(["list"], { home, write: out.write });
    expect(out.text()).toContain(authPluginRoot(home));
    expect(out.text()).toContain("lyra plugins install");
  });
});

describe("lyra plugins update", () => {
  test("clones from git and then pulls a later commit", async () => {
    counter += 1;
    const id = `gitplug${counter}`;
    const source = await sourceRepository(id);
    const home = await temporary("home");
    await runPluginsCommand(["install", source], { home, write: recorder().write });

    // A change on the other side of the remote.
    await writeFile(join(source, "NOTES.md"), "second commit\n");
    await git(["add", "."], source);
    await git(["commit", "-m", "second"], source);

    const out = recorder();
    await runPluginsCommand(["update", id], { home, write: out.write });
    expect(await readFile(join(authPluginRoot(home), id, "NOTES.md"), "utf8")).toBe("second commit\n");
    expect(out.text()).toContain("still loads");
  });

  test("a plugin installed from a plain directory has nothing to pull, and says so", async () => {
    counter += 1;
    const id = `copyplug${counter}`;
    const source = await sourceDirectory(id);
    const home = await temporary("home");
    await runPluginsCommand(["install", source], { home, write: recorder().write });

    const failure = await runPluginsCommand(["update", id], { home, write: recorder().write })
      .catch((error: Error) => error.message);
    expect(failure).toContain("not installed from git");
    expect(failure).toContain(`lyra plugins remove ${id}`);
  });

  test("updating something that was never installed names where it looked", async () => {
    const home = await temporary("home");
    const failure = await runPluginsCommand(["update", "ghost"], { home, write: recorder().write })
      .catch((error: Error) => error.message);
    expect(failure).toContain("is not installed");
    expect(failure).toContain(join(authPluginRoot(home), "ghost"));
  });
});

describe("lyra plugins remove", () => {
  test("deletes the directory and warns about providers still naming it", async () => {
    counter += 1;
    const id = `goneplug${counter}`;
    const source = await sourceDirectory(id);
    const home = await temporary("home");
    await runPluginsCommand(["install", source], { home, write: recorder().write });

    const out = recorder();
    await runPluginsCommand(["remove", id], { home, write: out.write });
    expect(out.text()).toContain(`Removed auth plugin ${id}`);
    expect(out.text()).toContain(`plugin = "${id}"`);
    expect(await inspectPlugins(authPluginRoot(home))).toEqual([]);
  });
});

describe("lyra plugins login", () => {
  test("runs the login flow, then proves a token comes out of it, with its expiry", async () => {
    counter += 1;
    const id = `loginplug${counter}`;
    const marker = join(await temporary("marker"), "logged-in");
    const source = await sourceDirectory(id, `
import { writeFile } from "node:fs/promises";
let signedIn = false;
export default {
  id: ${JSON.stringify(id)},
  async login() { signedIn = true; await writeFile(${JSON.stringify(marker)}, "yes"); },
  async getToken() {
    if (!signedIn) throw new Error("No stored credentials");
    return { token: "fresh", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  },
};
`);
    const home = await temporary("home");
    await runPluginsCommand(["install", source], { home, write: recorder().write });

    const out = recorder();
    await runPluginsCommand(["login", id], { home, write: out.write });
    expect(await readFile(marker, "utf8")).toBe("yes");
    expect(out.text()).toContain("owns this terminal");
    expect(out.text()).toContain(`Signed in to ${id}`);
    expect(out.text()).toMatch(/expires at .* \(in (59|60) min\)/);
  });

  test("a plugin with no login flow says there is nothing to run", async () => {
    counter += 1;
    const id = `nologinplug${counter}`;
    const source = await sourceDirectory(id);
    const home = await temporary("home");
    await runPluginsCommand(["install", source], { home, write: recorder().write });

    const failure = await runPluginsCommand(["login", id], { home, write: recorder().write })
      .catch((error: Error) => error.message);
    expect(failure).toContain("declares no login flow");
  });

  test("logging in to something that is not installed is an error, not an import", async () => {
    const home = await temporary("home");
    await expect(runPluginsCommand(["login", "ghost"], { home, write: recorder().write }))
      .rejects.toThrow("is not installed");
  });
});

describe("plugin auth in provider selection", () => {
  const definition = (plugin: string) => ({
    base_url: "https://example.test/v1",
    api_type: "anthropic_messages" as const,
    auth: { type: "plugin" as const, plugin },
  });

  test("assertProviderUsable resolves the plugin and gets a token", async () => {
    counter += 1;
    const id = `usableplug${counter}`;
    const source = await sourceDirectory(id);
    const home = await temporary("home");
    await runPluginsCommand(["install", source], { home, write: recorder().write });

    await assertProviderUsable("claude-max", definition(id), "claude-opus-5", { home });
  });

  test("a credential-less plugin fails selection with the login command", async () => {
    counter += 1;
    const id = `emptyplug${counter}`;
    const source = await sourceDirectory(id, `
export default {
  id: ${JSON.stringify(id)},
  async login() {},
  async getToken() { throw new Error("No stored credentials at credentials.json"); },
};
`);
    const home = await temporary("home");
    await runPluginsCommand(["install", source], { home, write: recorder().write });

    const failure = await assertProviderUsable("claude-max", definition(id), "claude-opus-5", { home })
      .catch((error: Error) => error.message);
    expect(failure).toContain("Cannot select claude-max/claude-opus-5");
    expect(failure).toContain("No stored credentials at credentials.json");
    expect(failure).toContain(`lyra plugins login ${id}`);
  });

  test("an uninstalled plugin fails selection by naming the install command", async () => {
    const home = await temporary("home");
    const failure = await assertProviderUsable("claude-max", definition("absent"), "claude-opus-5", { home })
      .catch((error: Error) => error.message);
    expect(failure).toContain("Cannot select claude-max/claude-opus-5");
    expect(failure).toContain("lyra plugins install");
  });

  test("a slow plugin costs the probe deadline rather than the session", async () => {
    counter += 1;
    const id = `slowplug${counter}`;
    const source = await sourceDirectory(id, `
export default {
  id: ${JSON.stringify(id)},
  async getToken() { await new Promise((resolve) => setTimeout(resolve, 2_000)); return { token: "late" }; },
};
`);
    const home = await temporary("home");
    await runPluginsCommand(["install", source], { home, write: recorder().write });

    const started = Date.now();
    const failure = await assertProviderUsable("claude-max", definition(id), "claude-opus-5", { home, timeoutMs: 150 })
      .catch((error: Error) => error.message);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(failure).toContain(`auth plugin ${id} did not answer within 150ms`);
  });

  test("a plugin credential is described by its id, never its token", () => {
    expect(credentialSource({ type: "plugin", plugin: "claude-oauth" })).toBe("auth plugin claude-oauth");
  });
});

describe("provider/get with plugin auth", () => {
  test("reports the plugin id as the credential's address", async () => {
    counter += 1;
    const id = `acpplug${counter}`;
    const source = await sourceDirectory(id);
    const root = await temporary("origin");
    const home = join(root, "home");
    await mkdir(join(root, ".lyra"), { recursive: true });
    await mkdir(join(home, ".lyra"), { recursive: true });
    await writeFile(join(root, ".lyra", "config.toml"), "[workspace]\nenabled = false\n");
    await runPluginsCommand(["install", source], { home, write: recorder().write });
    await writeFile(join(home, ".lyra", "providers.toml"),
      `[providers.local]\nbase_url = "http://127.0.0.1:1/v1"\napi_type = "openai_completions"\nauth = { type = "none" }\nmodels = ["m"]\n\n`
      + `[providers.claude-max]\nbase_url = "https://example.test/v1"\napi_type = "anthropic_messages"\nauth = { type = "plugin", plugin = "${id}" }\nmodels = ["claude-opus-5"]\n\n`
      + `[roles]\ndefault = "local/m"\n`);

    const runtime = await LyraRuntime.create({ origin: root, session: "plugin-auth", home });
    try {
      const writer = { lines: [] as string[], write(data: string | Uint8Array): void { this.lines.push(typeof data === "string" ? data : new TextDecoder().decode(data)); } };
      const messages = (): Record<string, unknown>[] => writer.lines.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      await runtime.app.acp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), writer);
      await runtime.app.acp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "provider/get", params: { provider: "claude-max" } }));
      let message: Record<string, unknown> | undefined;
      for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
        message = messages().find((entry) => entry.id === 2);
        if (message !== undefined) break;
        await Bun.sleep(5);
      }
      expect(message?.result).toMatchObject({ provider: "claude-max", authType: "plugin", authDetail: id, inUse: false });
      // The address, never the credential.
      expect(JSON.stringify(message?.result)).not.toContain("token-for-");
    } finally { await runtime.close(); }
  }, 30_000);
});
