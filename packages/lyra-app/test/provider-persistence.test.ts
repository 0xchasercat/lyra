import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LyraRuntime } from "../src/index.ts";

/**
 * The four layers of one reported crash, each with the launch that produced it.
 *
 * What the user saw: a provider called `alex` was gone from `providers.toml` while
 * `[roles].default` still said `alex/claude-opus-5`. The next `lyra` threw
 * `Provider "alex" is not configured` as an uncaught exception — a raw Bun stack trace with
 * `$bunfs` paths in it — and the TUI it had already spawned was killed mid terminal-probe, so
 * the terminal's palette replies (`4;0;rgb:…`) spilled into the shell.
 *
 * Their own diagnosis was the root cause: "changing /provider doesn't automatically change the
 * config". Nothing persisted a selection, so the file drifted until a launch walked into it.
 *
 * So: selections persist (1), a removal repoints the default instead of dangling it (2), a
 * stale default degrades at boot instead of throwing (3), and a failed launch prints one line
 * (4, in `cli.test.ts`).
 */

const roots: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const restore: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const undo of restore.splice(0)) await undo().catch(() => undefined);
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A minimal OpenAI-compatible endpoint: it answers with the model it was asked for. */
function stubProvider(): string {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "gpt-5.6-sol" }, { id: "claude-opus-5" }] });
      const body = await request.json() as { model: string };
      const chunks = [
        { choices: [{ index: 0, delta: { content: `answered by ${body.model}` } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/v1`;
}

function providerBlock(name: string, url: string, models: readonly string[]): string {
  return `[providers.${name}]\nbase_url = "${url}"\napi_type = "openai_completions"\nauth = { type = "none" }\nmodels = [${models.map((model) => JSON.stringify(model)).join(", ")}]\n`;
}

/** An origin with workspaces off, and whatever `providers.toml` the test needs. */
async function fixture(providersToml: string, originToml = "[workspace]\nenabled = false\n"): Promise<{ root: string; home: string; providers: string }> {
  const root = await mkdtemp(join(tmpdir(), "lyra-persist-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(join(root, ".lyra"), { recursive: true });
  await mkdir(join(home, ".lyra"), { recursive: true });
  await writeFile(join(root, ".lyra", "config.toml"), originToml);
  const providers = join(home, ".lyra", "providers.toml");
  await writeFile(providers, providersToml);
  return { root, home, providers };
}

class Writer {
  readonly lines: string[] = [];
  write(data: string | Uint8Array): void { this.lines.push(typeof data === "string" ? data : new TextDecoder().decode(data)); }
  messages(): Array<Record<string, unknown>> {
    return this.lines.flatMap((line) => line.trim().split("\n").filter(Boolean).map((part) => JSON.parse(part) as Record<string, unknown>));
  }
}

/** Issues ACP requests against the live daemon and waits for each answer. */
function caller(runtime: LyraRuntime, writer: Writer): (method: string, params?: unknown) => Promise<unknown> {
  let id = 100;
  return async (method, params) => {
    const current = (id += 1);
    await runtime.app.acp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: current, method, ...(params === undefined ? {} : { params }) }));
    const deadline = Date.now() + 20_000;
    for (;;) {
      const message = writer.messages().find((entry) => entry.id === current);
      if (message !== undefined) {
        if (message.error !== undefined) throw new Error((message.error as { message: string }).message);
        return message.result;
      }
      if (Date.now() > deadline) throw new Error(`${method} never answered`);
      await Bun.sleep(5);
    }
  };
}

async function connected(runtime: LyraRuntime): Promise<(method: string, params?: unknown) => Promise<unknown>> {
  const writer = new Writer();
  await runtime.app.acp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), writer);
  return caller(runtime, writer);
}

/** The `[roles]` table a file declares, read back as data. */
async function roles(path: string): Promise<Record<string, unknown>> {
  const parsed = Bun.TOML.parse(await readFile(path, "utf8")) as { roles?: Record<string, unknown> };
  return parsed.roles ?? {};
}

describe("a model chosen in a session is still chosen next time", () => {
  test("session/select_model writes [roles].default, and the next daemon boots on it", async () => {
    const url = stubProvider();
    const { root, home, providers } = await fixture(
      `${providerBlock("a6api", url, ["gpt-5.6-sol"])}\n${providerBlock("zephyr", url, ["claude-opus-5"])}\n[roles]\ndefault = "a6api/gpt-5.6-sol"\nfast = "a6api/gpt-5.6-sol"\n`,
    );
    const first = await LyraRuntime.create({ origin: root, session: "persist-select", home });
    try {
      const call = await connected(first);
      expect(await call("session/select_model", { model: "zephyr/claude-opus-5" })).toEqual({ provider: "zephyr", model: "claude-opus-5" });
      // The whole defect, in one assertion: the choice reached the file.
      expect(await roles(providers)).toEqual({ default: "zephyr/claude-opus-5", fast: "a6api/gpt-5.6-sol" });
    } finally { await first.close(); }

    // A restart is what used to throw the choice away.
    const second = await LyraRuntime.create({ origin: root, session: "persist-select-2", home });
    try {
      expect(second.session.environment.providerName).toBe("zephyr");
      expect(second.session.environment.model).toBe("claude-opus-5");
      const call = await connected(second);
      const turn = await call("session/prompt", { prompt: "hello" }) as { assistant: { content: Array<{ type: string; text?: string }> } };
      expect(turn.assistant.content).toEqual([{ type: "text", text: "answered by claude-opus-5" }]);
    } finally { await second.close(); }
  }, 30_000);

  test("the write lands in the file that already defines [roles], not the one that does not", async () => {
    const url = stubProvider();
    // The roles live in the *origin* config, which is read last and therefore wins. A write to
    // ~/.lyra/providers.toml would be shadowed by it on the very next boot.
    const { root, home, providers } = await fixture(
      `${providerBlock("a6api", url, ["gpt-5.6-sol"])}\n${providerBlock("zephyr", url, ["claude-opus-5"])}\n`,
      `[workspace]\nenabled = false\n\n[roles]\ndefault = "a6api/gpt-5.6-sol"\n`,
    );
    const originConfig = join(root, ".lyra", "config.toml");
    const runtime = await LyraRuntime.create({ origin: root, session: "persist-precedence", home });
    try {
      const call = await connected(runtime);
      await call("session/select_provider", { provider: "zephyr", model: "claude-opus-5" });
      expect(await roles(originConfig)).toMatchObject({ default: "zephyr/claude-opus-5" });
      // Untouched: nothing was written where it would have been ignored.
      expect(await roles(providers)).toEqual({});
      // And the file is still a config file: what it said about everything else survived.
      expect(await readFile(originConfig, "utf8")).toContain("[workspace]");
    } finally { await runtime.close(); }
  }, 30_000);

  test("a switch whose persistence fails still switches, and says why it did not stick", async () => {
    if (process.getuid?.() === 0) return; // root writes into a read-only directory anyway
    const url = stubProvider();
    const { root, home, providers } = await fixture(
      `${providerBlock("a6api", url, ["gpt-5.6-sol"])}\n${providerBlock("zephyr", url, ["claude-opus-5"])}\n[roles]\ndefault = "a6api/gpt-5.6-sol"\n`,
    );
    const reports: string[] = [];
    const runtime = await LyraRuntime.create({
      origin: root, session: "persist-readonly", home,
      onUpdate: (update) => { if (update.sessionUpdate === "report") reports.push(update.message); },
    });
    try {
      const call = await connected(runtime);
      // The file stays readable — the daemon re-reads it on every selection — but the directory
      // the atomic rename needs a temporary file in does not accept one.
      const directory = join(home, ".lyra");
      await chmod(directory, 0o500);
      restore.push(async () => { await chmod(directory, 0o700); });

      expect(await call("session/select_model", { model: "zephyr/claude-opus-5" })).toEqual({ provider: "zephyr", model: "claude-opus-5" });
      // The live switch happened and stands: it was already done before anything was written.
      const turn = await call("session/prompt", { prompt: "hello" }) as { assistant: { content: Array<{ type: string; text?: string }> } };
      expect(turn.assistant.content).toEqual([{ type: "text", text: "answered by claude-opus-5" }]);
      // And the user is told the choice is this session only, rather than finding out at the
      // next launch that it silently was.
      const warning = reports.find((message) => message.includes("[roles].default could not be saved"));
      expect(warning).toBeDefined();
      expect(warning).toContain("zephyr/claude-opus-5");
      expect(await roles(providers)).toEqual({ default: "a6api/gpt-5.6-sol" });
    } finally { await runtime.close(); }
  }, 30_000);
});

describe("removing a provider does not leave the default naming it", () => {
  test("the default is repointed, reported, and is what the next daemon boots on", async () => {
    const url = stubProvider();
    const { root, home, providers } = await fixture(
      `${providerBlock("a6api", url, ["gpt-5.6-sol"])}\n${providerBlock("zephyr", url, ["claude-opus-5"])}\n[roles]\ndefault = "zephyr/claude-opus-5"\nfast = "zephyr/claude-opus-5"\n`,
    );
    const reports: string[] = [];
    // Running on a6api, so removing zephyr is allowed — the session's own provider never is.
    const first = await LyraRuntime.create({
      origin: root, session: "remove-repoint", home, model: "a6api/gpt-5.6-sol",
      onUpdate: (update) => { if (update.sessionUpdate === "report") reports.push(update.message); },
    });
    try {
      const call = await connected(first);
      const removed = await call("provider/remove", { provider: "zephyr" }) as Record<string, unknown>;
      expect(removed).toMatchObject({ ok: true, provider: "zephyr", defaultRepointedTo: "a6api/gpt-5.6-sol" });
      // `fast` still dangles on purpose: it fails one call at a time, by name.
      expect(removed.danglingRoles).toEqual(["fast"]);
      expect(await roles(providers)).toEqual({ default: "a6api/gpt-5.6-sol", fast: "zephyr/claude-opus-5" });
      // Said out loud too, for a client whose result type predates the field.
      expect(reports.some((message) => message.includes("[roles].default") && message.includes("a6api/gpt-5.6-sol"))).toBe(true);
    } finally { await first.close(); }

    // The launch that used to crash: it now has a default that names something real.
    const second = await LyraRuntime.create({ origin: root, session: "remove-repoint-2", home });
    try {
      expect(second.session.environment.providerName).toBe("a6api");
      expect(second.session.environment.model).toBe("gpt-5.6-sol");
    } finally { await second.close(); }
  }, 30_000);

  test("removing the last declared provider clears the roles that named it, and the next boot is unconfigured", async () => {
    const url = stubProvider();
    // The session runs on a provider declared in the *origin* config, so `providers.toml` is
    // down to its last one and removing it is allowed.
    const { root, home, providers } = await fixture(
      `${providerBlock("a6api", url, ["gpt-5.6-sol"])}\n[roles]\ndefault = "a6api/gpt-5.6-sol"\nfast = "a6api/gpt-5.6-sol"\n`,
      `[workspace]\nenabled = false\n\n${providerBlock("orig", url, ["claude-opus-5"])}`,
    );
    const first = await LyraRuntime.create({ origin: root, session: "remove-last", home, model: "orig/claude-opus-5" });
    try {
      const call = await connected(first);
      const removed = await call("provider/remove", { provider: "a6api" }) as Record<string, unknown>;
      expect(removed).toMatchObject({ ok: true, provider: "a6api" });
      // Nothing left to point at, so the roles go rather than being repointed at nothing.
      expect(removed.rolesCleared).toEqual(["default", "fast"]);
      expect(removed.defaultRepointedTo).toBeUndefined();
      expect(removed.danglingRoles).toBeUndefined();
      expect(await roles(providers)).toEqual({});
    } finally { await first.close(); }

    const second = await LyraRuntime.create({ origin: root, session: "remove-last-2", home });
    try {
      // No default to resolve: the first-run path, which boots and can run its own wizard.
      expect(second.session.environment.unconfigured).toBeDefined();
      expect(await connected(second).then((call) => call("session/providers"))).toMatchObject({ available: ["orig"] });
    } finally { await second.close(); }
  }, 30_000);
});

describe("the launch that crashed", () => {
  test("a [roles].default naming a provider that is gone boots on a fallback and says so", async () => {
    const url = stubProvider();
    // Exactly the file the report described: `alex` was removed, its roles were not.
    const { root, home } = await fixture(
      `${providerBlock("claude-max", url, ["claude-opus-5"])}\n[roles]\ndefault = "alex/claude-opus-5"\nfast = "alex/claude-haiku-4-5"\n`,
    );
    const reports: string[] = [];
    // The uncaught throw was here. Nothing about a stale role is a decision a user has to make
    // before Lyra can start.
    const runtime = await LyraRuntime.create({
      origin: root, session: "stale-default", home,
      onUpdate: (update) => { if (update.sessionUpdate === "report") reports.push(update.message); },
    });
    try {
      expect(runtime.session.environment.providerName).toBe("claude-max");
      expect(runtime.session.environment.model).toBe("claude-opus-5");
      expect(runtime.session.environment.unconfigured).toBeUndefined();

      const notice = reports.find((message) => message.includes("[roles].default"));
      expect(notice).toBeDefined();
      expect(notice).toContain("alex");
      expect(notice).toContain("claude-max/claude-opus-5");
      expect(notice).toContain("/model");

      // It is a working session, not a diagnostic one.
      const call = await connected(runtime);
      const turn = await call("session/prompt", { prompt: "hello" }) as { assistant: { content: Array<{ type: string; text?: string }> } };
      expect(turn.assistant.content).toEqual([{ type: "text", text: "answered by claude-opus-5" }]);

      // The other dangling role degrades where it is used, with a sentence naming the provider
      // that is missing and the way to add one — not a raw crash.
      const failure = await call("session/select_model", { model: "@fast" }).catch((error: Error) => error.message) as string;
      expect(failure).toContain(`Provider "alex" is not configured`);
      expect(failure).toContain("claude-max");
      expect(failure).toContain("/provider add");
    } finally { await runtime.close(); }
  }, 30_000);

  test("--model naming a provider that is not configured degrades the same way", async () => {
    const url = stubProvider();
    const { root, home } = await fixture(`${providerBlock("claude-max", url, ["claude-opus-5"])}\n[roles]\ndefault = "claude-max/claude-opus-5"\n`);
    const reports: string[] = [];
    const runtime = await LyraRuntime.create({
      origin: root, session: "stale-flag", home, model: "alex/claude-opus-5",
      onUpdate: (update) => { if (update.sessionUpdate === "report") reports.push(update.message); },
    });
    try {
      expect(runtime.session.environment.providerName).toBe("claude-max");
      expect(reports.some((message) => message.includes("--model alex/claude-opus-5") && message.includes("claude-max/claude-opus-5"))).toBe(true);
    } finally { await runtime.close(); }
  }, 30_000);

  test("nothing configured at all is a daemon that comes up, so the wizard has somewhere to run", async () => {
    // The other half of the same promise, and it was broken in the same way: a first run threw
    // out of the transcript header, which requires a provider name an unconfigured session does
    // not have. The wizard lives inside the TUI, which talks to this daemon — so a daemon that
    // refuses to boot is a first run with no way in at all.
    const root = await mkdtemp(join(tmpdir(), "lyra-persist-"));
    roots.push(root);
    const runtime = await LyraRuntime.create({ origin: root, session: "first-run", home: join(root, "home") });
    try {
      expect(runtime.session.environment.unconfigured).toBeDefined();
      const call = await connected(runtime);
      expect(await call("session/providers")).toMatchObject({ available: [] });
      // Every method that is not about models is real; only a turn refuses, and it says why.
      const failure = await call("session/prompt", { prompt: "hello" }).catch((error: Error) => error.message) as string;
      expect(failure).toContain("/provider add");
    } finally { await runtime.close(); }
  }, 30_000);

  test("a stale default with nothing to fall back to boots unconfigured rather than throwing", async () => {
    const url = stubProvider();
    // The remaining provider declares no models and has no discovery cache, so there is no
    // reference to build. That is still a daemon that comes up, with a wizard reachable.
    const { root, home } = await fixture(
      `[providers.silent]\nbase_url = "${url}"\napi_type = "openai_completions"\nauth = { type = "none" }\n\n[roles]\ndefault = "alex/claude-opus-5"\n`,
    );
    const runtime = await LyraRuntime.create({ origin: root, session: "stale-nothing", home });
    try {
      expect(runtime.session.environment.unconfigured).toContain("alex");
      const call = await connected(runtime);
      expect(await call("session/providers")).toMatchObject({ available: ["silent"] });
      // The prompt is where the absence surfaces, and it names what to do about it.
      const failure = await call("session/prompt", { prompt: "hello" }).catch((error: Error) => error.message) as string;
      expect(failure).toContain("alex");
    } finally { await runtime.close(); }
  }, 30_000);
});
