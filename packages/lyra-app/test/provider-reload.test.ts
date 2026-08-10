import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LyraRuntime } from "../src/index.ts";

/**
 * The provider surface of a *running* daemon: adding one, switching to one, and being told
 * why when neither is possible.
 *
 * The session this is written from: Lyra was running on one provider, the TUI wizard added a
 * second and reported it saved, `session/select_provider` answered success — and the next
 * prompt died with `Unknown provider error`. Three separate defects lined up to produce that,
 * and each has a test here: a selection that validated nothing beyond a name being present in
 * a table, a file rewrite that deleted the provider the session was running on, and a fault
 * message that named neither the provider nor anything to do about it.
 */

const roots: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A minimal OpenAI-compatible endpoint: it answers with the model it was asked for. */
function stubProvider(options: { reject?: boolean } = {}): string {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "gpt-5.6-sol" }, { id: "claude-opus-5" }] });
      // The exact shape that made the reported failure unreadable: a refusal with a
      // zero-length body, which leaves the status as the only fact about it.
      if (options.reject === true) return new Response(null, { status: 401 });
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

function providerToml(url: string): string {
  return `[providers.a6api]\nbase_url = "${url}"\napi_type = "openai_completions"\nauth = { type = "none" }\nmodels = ["gpt-5.6-sol"]\n\n[roles]\ndefault = "a6api/gpt-5.6-sol"\n`;
}

/** An origin with workspaces off (nothing here needs a clone) and one configured provider. */
async function fixture(url: string): Promise<{ root: string; home: string; providers: string }> {
  const root = await mkdtemp(join(tmpdir(), "lyra-provider-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(join(root, ".lyra"), { recursive: true });
  await mkdir(join(home, ".lyra"), { recursive: true });
  await writeFile(join(root, ".lyra", "config.toml"), "[workspace]\nenabled = false\n");
  const providers = join(home, ".lyra", "providers.toml");
  await writeFile(providers, providerToml(url));
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

describe("a provider added while the daemon runs", () => {
  test("is selectable and serves the very next prompt, and does not displace the provider already configured", async () => {
    const url = stubProvider();
    const { root, home, providers } = await fixture(url);
    Bun.env.LYRA_TEST_ADDED_KEY = "added-key";
    const runtime = await LyraRuntime.create({ origin: root, session: "provider-add", home });
    try {
      const call = await connected(runtime);
      expect(await call("session/providers")).toEqual({ current: "a6api", available: ["a6api"] });

      const added = await call("provider/add", { provider: "claude-code", baseUrl: url, apiType: "openai_completions", model: "claude-opus-5", persist: "env", authEnvVar: "LYRA_TEST_ADDED_KEY" }) as { ok: boolean; provider: string };
      expect(added).toMatchObject({ ok: true, provider: "claude-code", model: "claude-opus-5" });

      // The daemon resolves providers from the configuration it holds, so the added one has
      // to be in that copy — not merely on disk — before anything can select it.
      expect(await call("session/providers")).toEqual({ current: "a6api", available: ["a6api", "claude-code"] });
      expect(await call("session/select_provider", { provider: "claude-code", model: "claude-opus-5" })).toEqual({ provider: "claude-code", model: "claude-opus-5" });

      // The whole point: the next turn runs, on the provider that was just added.
      const turn = await call("session/prompt", { prompt: "hello" }) as { assistant: { content: Array<{ type: string; text?: string }> } };
      expect(turn.assistant.content).toEqual([{ type: "text", text: "answered by claude-opus-5" }]);

      // Adding a provider is not a factory reset. The provider the session booted on is still
      // configured, still on disk, and still selectable — which is the only way back if the
      // one just added turns out to be wrong.
      const text = await readFile(providers, "utf8");
      expect(text).toContain("[providers.a6api]");
      expect(text).toContain("[providers.claude-code]");
      expect(await call("session/select_provider", { provider: "a6api" })).toEqual({ provider: "a6api", model: "gpt-5.6-sol" });
      const back = await call("session/prompt", { prompt: "and back" }) as { assistant: { content: Array<{ type: string; text?: string }> } };
      expect(back.assistant.content).toEqual([{ type: "text", text: "answered by gpt-5.6-sol" }]);
    } finally { delete Bun.env.LYRA_TEST_ADDED_KEY; await runtime.close(); }
  }, 30_000);

  test("a provider hand-written into providers.toml is seen without restarting the daemon", async () => {
    const url = stubProvider();
    const { root, home, providers } = await fixture(url);
    const runtime = await LyraRuntime.create({ origin: root, session: "provider-edit", home });
    try {
      const call = await connected(runtime);
      expect(await call("session/providers")).toEqual({ current: "a6api", available: ["a6api"] });
      await writeFile(providers, `${providerToml(url)}\n[providers.handwritten]\nbase_url = "${url}"\napi_type = "openai_completions"\nauth = { type = "none" }\nmodels = ["claude-opus-5"]\n`);
      // No reload command, no restart: the provider surface re-reads its own files.
      expect(await call("session/providers")).toEqual({ current: "a6api", available: ["a6api", "handwritten"] });
      await call("session/select_provider", { provider: "handwritten" });
      const turn = await call("session/prompt", { prompt: "hello" }) as { assistant: { content: Array<{ type: string; text?: string }> } };
      expect(turn.assistant.content).toEqual([{ type: "text", text: "answered by claude-opus-5" }]);
    } finally { await runtime.close(); }
  }, 30_000);
});

describe("a selection that cannot work is refused, not confirmed", () => {
  test("an unconfigured name names the providers that do exist and the file to declare it in", async () => {
    const { root, home, providers } = await fixture(stubProvider());
    const runtime = await LyraRuntime.create({ origin: root, session: "provider-missing", home });
    try {
      const call = await connected(runtime);
      const failure = await call("session/select_provider", { provider: "claude-code", model: "claude-opus-5" }).catch((error: Error) => error.message);
      expect(failure).toContain(`Provider "claude-code" is not configured`);
      expect(failure).toContain("Configured providers: a6api");
      expect(failure).toContain(providers);
      expect(failure).toContain("/provider add");
      // Nothing moved: a refused selection leaves the session on what it was using.
      expect(await call("session/providers")).toMatchObject({ current: "a6api" });
    } finally { await runtime.close(); }
  }, 30_000);

  test("a credential that cannot be produced fails the selection, with the source and the fix", async () => {
    const url = stubProvider();
    const { root, home } = await fixture(url);
    await writeFile(join(home, ".lyra", "providers.toml"), `${providerToml(url)}\n[providers.claude-code]\nbase_url = "${url}"\napi_type = "openai_completions"\nauth = { type = "env", var = "LYRA_TEST_ABSENT_KEY" }\nmodels = ["claude-opus-5"]\n`);
    const runtime = await LyraRuntime.create({ origin: root, session: "provider-noauth", home });
    try {
      const call = await connected(runtime);
      // This is the reported bug: the name was in the table, so the selection said yes, and
      // the credential was first asked for by a turn the user had already started.
      const failure = await call("session/select_provider", { provider: "claude-code", model: "claude-opus-5" }).catch((error: Error) => error.message);
      expect(failure).toContain("Cannot select claude-code/claude-opus-5");
      expect(failure).toContain("LYRA_TEST_ABSENT_KEY is not set");
      expect(failure).toContain("Export LYRA_TEST_ABSENT_KEY");
      // The session is untouched, so the escape hatch is to keep working on what still works.
      expect(await call("session/providers")).toMatchObject({ current: "a6api" });
      const turn = await call("session/prompt", { prompt: "still working" }) as { assistant: { content: Array<{ type: string; text?: string }> } };
      expect(turn.assistant.content).toEqual([{ type: "text", text: "answered by gpt-5.6-sol" }]);
    } finally { await runtime.close(); }
  }, 30_000);

  test("a keychain reference with nothing behind it is refused by name", async () => {
    const url = stubProvider();
    const { root, home } = await fixture(url);
    const service = `dev.lyra.provider.test-${crypto.randomUUID()}`;
    await writeFile(join(home, ".lyra", "providers.toml"), `${providerToml(url)}\n[providers.claude-code]\nbase_url = "${url}"\napi_type = "openai_completions"\nauth = { type = "keychain", service = "${service}", account = "nobody" }\nmodels = ["claude-opus-5"]\n`);
    const runtime = await LyraRuntime.create({ origin: root, session: "provider-keychain", home });
    try {
      const call = await connected(runtime);
      const failure = await call("session/select_provider", { provider: "claude-code" }).catch((error: Error) => error.message) as string;
      expect(failure).toContain("Cannot select claude-code/claude-opus-5");
      // Whether this machine has no such entry or no keychain at all, the answer says the
      // credential source is the keychain and what to do about it. Where the platform can
      // look an entry up, it also names the entry it looked for.
      expect(failure).toContain("keychain");
      expect(failure).toContain("Store it again with /provider add");
      if (process.platform === "darwin") expect(failure).toContain(service);
      expect(await call("session/providers")).toMatchObject({ current: "a6api" });
    } finally { await runtime.close(); }
  }, 30_000);
});

/**
 * The reported failure, end to end: a provider whose `base_url` is one `/v1` away from where
 * its routes live. Detection succeeded against one path shape, the turn asked for another,
 * and what came back was `HTTP 404 with an empty error body` — a sentence with nothing in it
 * to act on, for a config that was one line from correct.
 */
describe("a base URL that is one /v1 away from where the endpoint lives", () => {
  /** Serves the OpenAI API under /v1 and nothing at its root, the way a real deployment does. */
  function versionedOnly(): { origin: string; paths: string[] } {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        paths.push(path);
        if (!path.startsWith("/v1/")) return new Response(null, { status: 404 });
        if (path === "/v1/models") return Response.json({ object: "list", data: [{ id: "gpt-5.6-sol" }] });
        const body = await request.json() as { model: string };
        const chunks = [
          { choices: [{ index: 0, delta: { content: `answered by ${body.model}` } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(server);
    return { origin: `http://127.0.0.1:${server.port}`, paths };
  }

  test("the turn resolves the working path shape once, silently, and the config keeps the user's value", async () => {
    const endpoint = versionedOnly();
    // The hand-written config this is all about: the base with no /v1 on it. A base_url
    // names the prefix where the API lives; finding the exact route is Lyra's job, so
    // nothing about the resolution is user-visible (owner decision, 2026-08-10).
    const { root, home } = await fixture(endpoint.origin);
    const reports: string[] = [];
    const runtime = await LyraRuntime.create({
      origin: root, session: "base-url-heal", home,
      onUpdate: (update) => { if (update.sessionUpdate === "report") reports.push(update.message); },
    });
    try {
      const call = await connected(runtime);
      // The turn runs. A 404 before anything has streamed is safe to replay, so the retry
      // costs a round trip and produces exactly one answer.
      const turn = await call("session/prompt", { prompt: "hello" }) as { assistant: { content: Array<{ type: string; text?: string }> } };
      expect(turn.assistant.content).toEqual([{ type: "text", text: "answered by gpt-5.6-sol" }]);
      expect(endpoint.paths).toContain("/chat/completions");
      expect(endpoint.paths).toContain("/v1/chat/completions");

      // Nothing reaches the user: route resolution is plumbing, not conversation.
      expect(reports.filter((message) => message.includes("base_url"))).toHaveLength(0);

      // Learned, not re-guessed: the next turn goes straight there.
      endpoint.paths.length = 0;
      await call("session/prompt", { prompt: "again" });
      expect(endpoint.paths).toEqual(["/v1/chat/completions"]);

      // The file still says exactly what the user wrote.
      expect(await readFile(join(home, ".lyra", "providers.toml"), "utf8")).toContain(`base_url = "${endpoint.origin}"`);
    } finally { await runtime.close(); }
  }, 30_000);

  test("a 404 that survives both shapes names the full URL it asked for", async () => {
    const endpoint = versionedOnly();
    // A base that is wrong in a way no /v1 can fix: nothing lives under /wrong at all.
    const { root, home } = await fixture(`${endpoint.origin}/wrong`);
    const runtime = await LyraRuntime.create({ origin: root, session: "base-url-404", home });
    try {
      const call = await connected(runtime);
      const failure = await call("session/prompt", { prompt: "hello" }).catch((error: Error) => error.message) as string;
      // What the user saw before, and could do nothing with.
      expect(failure).toContain("HTTP 404");
      expect(failure).toContain("empty error body");
      // What it now also says: which provider, which URL, and what produces that.
      expect(failure).toContain("a6api/gpt-5.6-sol failed");
      expect(failure).toContain(`${endpoint.origin}/wrong/chat/completions`);
      expect(failure).toContain("base_url");
    } finally { await runtime.close(); }
  }, 30_000);
});

describe("a provider failure says which provider failed", () => {
  test("an empty refusal from the endpoint becomes a sentence with a name and a next move", async () => {
    const url = stubProvider({ reject: true });
    const { root, home } = await fixture(url);
    const runtime = await LyraRuntime.create({ origin: root, session: "provider-401", home });
    try {
      const call = await connected(runtime);
      const failure = await call("session/prompt", { prompt: "hello" }).catch((error: Error) => error.message) as string;
      // Before: "Unknown provider error" — every provider's failure, worded identically, with
      // nothing in it a user could act on.
      expect(failure).not.toContain("Unknown provider error");
      expect(failure).toContain("a6api/gpt-5.6-sol failed");
      expect(failure).toContain("HTTP 401");
      expect(failure).toContain("no credential");
      // The client's turn_end carries the same sentence as the request's error; a client that
      // renders both must not show two different explanations of one failure.
      expect(JSON.stringify(runtime.session.entries())).not.toContain("Unknown provider error");
    } finally { await runtime.close(); }
  }, 30_000);
});
