import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTH_PLUGIN_REFRESH_MARGIN_MS,
  authPluginRoot,
  joinSystemPrefix,
  loadAuthPlugin,
  PluginAuth,
  providerHeaders,
  providerSystemPrefix,
} from "../src/index.ts";
import { resolveProvider } from "../src/config.ts";
import { ReliableProvider } from "../src/client.ts";
import { AnthropicMessagesTransport } from "../src/transports/anthropic-messages.ts";
import { OpenAICompletionsTransport } from "../src/transports/openai-completions.ts";
import { baseRequest } from "./fixture-adapter.ts";
import type { TransportContext } from "../src/types.ts";

const temporaryPaths: string[] = [];
const servers: Bun.Server<unknown>[] = [];

/** Unique per test file run, so Bun's module cache never serves one fixture as another. */
let counter = 0;

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
});
afterAll(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "lyra-plugin-home-"));
  temporaryPaths.push(path);
  await mkdir(authPluginRoot(path), { recursive: true });
  return path;
}

/** Writes a plugin fixture and returns `{ home, root, id }`. */
async function fixture(source: string, name = "fixture"): Promise<{ home: string; root: string; id: string }> {
  const home = await temporaryHome();
  const root = authPluginRoot(home);
  counter += 1;
  const id = `${name}-${counter}`;
  await mkdir(join(root, id), { recursive: true });
  await Bun.write(join(root, id, "plugin.ts"), source.replaceAll("$ID", id));
  return { home, root, id };
}

const CONTEXT: TransportContext = { signal: new AbortController().signal, headersTimeoutMs: 2_000 };

// -----------------------------------------------------------------------------------------------

describe("auth plugin loader", () => {
  test("loads plugin.ts, and index.ts as the fallback", async () => {
    const home = await temporaryHome();
    const root = authPluginRoot(home);
    counter += 1;
    const id = `legacy-${counter}`;
    await mkdir(join(root, id), { recursive: true });
    await Bun.write(join(root, id, "index.ts"), `export default { id: "${id}", async getToken() { return { token: "t" }; } };`);
    expect((await loadAuthPlugin(id, root)).id).toBe(id);
  });

  test("prefers plugin.ts when both entries exist", async () => {
    const { root, id } = await fixture(`export default { id: "$ID", systemPrefix: "from plugin.ts", async getToken() { return { token: "t" }; } };`);
    await Bun.write(join(root, id, "index.ts"), `export default { id: "${id}", systemPrefix: "from index.ts", async getToken() { return { token: "t" }; } };`);
    expect((await loadAuthPlugin(id, root)).systemPrefix).toBe("from plugin.ts");
  });

  test("a missing plugin names both entry paths and the install command", async () => {
    const home = await temporaryHome();
    await expect(loadAuthPlugin("absent", authPluginRoot(home))).rejects.toThrow(/plugin\.ts.*index\.ts|index\.ts/s);
    await expect(loadAuthPlugin("absent", authPluginRoot(home))).rejects.toThrow("lyra plugins install");
  });

  test("a missing default export names the file and shows the fix", async () => {
    const { root, id } = await fixture(`export const plugin = { id: "$ID", async getToken() { return { token: "t" }; } };`);
    const error = await loadAuthPlugin(id, root).catch((cause: unknown) => cause as Error);
    expect(error.message).toContain("has no default export");
    expect(error.message).toContain(join(root, id, "plugin.ts"));
    expect(error.message).toContain("export default");
  });

  test("an id mismatch names both ids and both ways out", async () => {
    const { root, id } = await fixture(`export default { id: "something-else", async getToken() { return { token: "t" }; } };`);
    const error = await loadAuthPlugin(id, root).catch((cause: unknown) => cause as Error);
    expect(error.message).toContain(`"something-else"`);
    expect(error.message).toContain(`"${id}"`);
    expect(error.message).toContain(join(root, id, "plugin.ts"));
  });

  test("a getToken that is not a function names the file and the signature", async () => {
    const { root, id } = await fixture(`export default { id: "$ID", getToken: "yes please" };`);
    const error = await loadAuthPlugin(id, root).catch((cause: unknown) => cause as Error);
    expect(error.message).toContain("does not export getToken()");
    expect(error.message).toContain(join(root, id, "plugin.ts"));
    expect(error.message).toContain("async getToken()");
  });

  test("a multi-line systemPrefix is refused, because a prefix is one line", async () => {
    const { root, id } = await fixture("export default { id: \"$ID\", systemPrefix: \"one\\ntwo\", async getToken() { return { token: \"t\" }; } };");
    await expect(loadAuthPlugin(id, root)).rejects.toThrow("single-line string");
  });

  test("non-string headers are refused with the shape they should have had", async () => {
    const { root, id } = await fixture(`export default { id: "$ID", headers: { "x-beta": 7 }, async getToken() { return { token: "t" }; } };`);
    await expect(loadAuthPlugin(id, root)).rejects.toThrow(/headers.*object of string values/s);
  });

  test("a login that is not a function is refused", async () => {
    const { root, id } = await fixture(`export default { id: "$ID", login: true, async getToken() { return { token: "t" }; } };`);
    await expect(loadAuthPlugin(id, root)).rejects.toThrow("not a function");
  });

  test("a module that throws on import reports the module's own error", async () => {
    const { root, id } = await fixture(`throw new Error("the plugin exploded"); export default {};`);
    await expect(loadAuthPlugin(id, root)).rejects.toThrow("the plugin exploded");
  });

  test("an id that could traverse is refused before anything is imported", async () => {
    await expect(loadAuthPlugin("../outside", "/tmp/plugins")).rejects.toThrow("is invalid");
    expect(() => new PluginAuth("../outside", "/tmp/plugins")).toThrow("is invalid");
  });

  test("a symlink out of the plugin root is refused", async () => {
    const outside = await temporaryHome();
    await mkdir(join(outside, "elsewhere"), { recursive: true });
    await Bun.write(join(outside, "elsewhere", "plugin.ts"), `export default { id: "escapee", async getToken() { return { token: "t" }; } };`);
    const home = await temporaryHome();
    const root = authPluginRoot(home);
    await symlink(join(outside, "elsewhere"), join(root, "escapee"));
    await expect(loadAuthPlugin("escapee", root)).rejects.toThrow("outside");
  });
});

describe("plugin token caching", () => {
  test("caches until the refresh margin, then re-asks", async () => {
    const { root, id } = await fixture(`
let calls = 0;
export default {
  id: "$ID",
  async getToken() {
    calls += 1;
    // First token is comfortably live; the second is inside the refresh margin, so the third
    // call must go back to the plugin rather than serve a token about to expire.
    const ttl = calls === 1 ? 3_600_000 : ${AUTH_PLUGIN_REFRESH_MARGIN_MS} / 2;
    return { token: "token-" + calls, expiresAt: new Date(Date.now() + ttl).toISOString() };
  },
};
`);
    const auth = new PluginAuth(id, root);
    expect((await auth.getToken()).token).toBe("token-1");
    expect((await auth.getToken()).token).toBe("token-1");
    auth.invalidate();
    expect((await auth.getToken()).token).toBe("token-2");
    // token-2 expires inside the margin, so it is never served from cache.
    expect((await auth.getToken()).token).toBe("token-3");
  });

  test("a token with no expiry is cached until invalidated", async () => {
    const { root, id } = await fixture(`
let calls = 0;
export default { id: "$ID", async getToken() { calls += 1; return { token: "t" + calls }; } };
`);
    const auth = new PluginAuth(id, root);
    expect((await auth.getToken()).token).toBe("t1");
    expect((await auth.getToken()).token).toBe("t1");
    auth.invalidate();
    expect((await auth.getToken()).token).toBe("t2");
  });

  test("a credential-less plugin with a login flow says which command fixes it", async () => {
    const { root, id } = await fixture(`
export default {
  id: "$ID",
  async login() {},
  async getToken() { throw new Error("No stored credentials at /nowhere/credentials.json"); },
};
`);
    const error = await new PluginAuth(id, root).getToken().catch((cause: unknown) => cause as Error);
    expect(error.message).toContain("No stored credentials at /nowhere/credentials.json");
    expect(error.message).toContain(`lyra plugins login ${id}`);
  });

  test("a credential-less plugin with no login flow points at its directory instead", async () => {
    const { root, id } = await fixture(`export default { id: "$ID", async getToken() { throw new Error("nothing here"); } };`);
    const error = await new PluginAuth(id, root).getToken().catch((cause: unknown) => cause as Error);
    expect(error.message).toContain("declares no login flow");
    expect(error.message).not.toContain("lyra plugins login");
  });

  test("a malformed token is rejected with the shape it should have returned", async () => {
    const { root, id } = await fixture(`export default { id: "$ID", async getToken() { return { token: "" }; } };`);
    await expect(new PluginAuth(id, root).getToken()).rejects.toThrow("empty bearer token");

    const bad = await fixture(`export default { id: "$ID", async getToken() { return { token: "t", expiresAt: "soon" }; } };`);
    await expect(new PluginAuth(bad.id, bad.root).getToken()).rejects.toThrow(/invalid expiresAt.*ISO 8601/s);
  });
});

describe("plugin headers and systemPrefix", () => {
  const PLUGIN = `
export default {
  id: "$ID",
  headers: { "anthropic-beta": "oauth-2025-04-20", "x-client": "lyra" },
  systemPrefix: "You are a mandated identity line.",
  async getToken() { return { token: "bearer-token" }; },
};
`;

  test("plugin headers merge over the provider's own, and the token is applied last", async () => {
    const { root, id } = await fixture(PLUGIN);
    const config = { id: "p", baseUrl: "https://example.test/v1", auth: new PluginAuth(id, root), headers: { "anthropic-version": "2023-06-01", "x-client": "provider-default" } };
    const headers = await providerHeaders(config);
    expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("x-client")).toBe("lyra");
    expect(headers.get("authorization")).toBe("Bearer bearer-token");
  });

  test("plugin auth on anthropic_messages sends a bearer token, not x-api-key", async () => {
    const { root, id } = await fixture(PLUGIN);
    const resolved = resolveProvider("claude-max", {
      base_url: "https://example.test/v1",
      api_type: "anthropic_messages",
      auth: { type: "plugin", plugin: id },
    }, { pluginRoot: root });
    expect(resolved.authHeader).toBe("bearer");
    const headers = await providerHeaders(resolved);
    expect(headers.get("authorization")).toBe("Bearer bearer-token");
    expect(headers.get("x-api-key")).toBeNull();
    // An API key on the same wire format keeps the header it always had.
    expect(resolveProvider("anthropic", { base_url: "https://example.test/v1", api_type: "anthropic_messages", auth: { type: "env", var: "X" } }).authHeader).toBe("x-api-key");
  });

  test("providerSystemPrefix returns the declared line, and nothing for a plugin without one", async () => {
    const { root, id } = await fixture(PLUGIN);
    expect(await providerSystemPrefix({ id: "p", baseUrl: "u", auth: new PluginAuth(id, root) })).toBe("You are a mandated identity line.");
    const bare = await fixture(`export default { id: "$ID", async getToken() { return { token: "t" }; } };`);
    expect(await providerSystemPrefix({ id: "p", baseUrl: "u", auth: new PluginAuth(bare.id, bare.root) })).toBeUndefined();
  });

  test("joinSystemPrefix keeps the prefix first and separates it from Lyra's prompt", () => {
    expect(joinSystemPrefix("line", "# Lyra")).toBe("line\n\n# Lyra");
    expect(joinSystemPrefix(undefined, "# Lyra")).toBe("# Lyra");
    expect(joinSystemPrefix("line", "")).toBe("line");
  });

  test("the Anthropic wire carries the prefix as its own FIRST system block", async () => {
    const { root, id } = await fixture(PLUGIN);
    const captured = await captureBody((baseUrl) => new AnthropicMessagesTransport({
      id: "claude-max", baseUrl, auth: new PluginAuth(id, root), authHeader: "bearer",
    }), anthropicStream());

    expect(captured.body.system).toEqual([
      { type: "text", text: "You are a mandated identity line." },
      { type: "text", text: "Use tools when needed.", cache_control: { type: "ephemeral" } },
    ]);
    expect(captured.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(captured.headers.authorization).toBe("Bearer bearer-token");
  });

  test("without a plugin prefix the Anthropic system field is unchanged", async () => {
    const captured = await captureBody((baseUrl) => new AnthropicMessagesTransport({ id: "anthropic", baseUrl }), anthropicStream());
    expect(captured.body.system).toEqual([{ type: "text", text: "Use tools when needed.", cache_control: { type: "ephemeral" } }]);
  });

  test("the OpenAI completions wire puts the prefix in its own system message, first", async () => {
    const { root, id } = await fixture(PLUGIN);
    const captured = await captureBody((baseUrl) => new OpenAICompletionsTransport({
      id: "sub", baseUrl, auth: new PluginAuth(id, root),
    }), completionsStream());

    const messages = captured.body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "system", content: "You are a mandated identity line." });
    expect(messages[1]).toEqual({ role: "system", content: "Use tools when needed." });
  });
});

describe("plugin auth recovery", () => {
  test("a 401 drops the cached token, re-asks the plugin, and retries once", async () => {
    const { root, id } = await fixture(`
let calls = 0;
export default {
  id: "$ID",
  async getToken() { calls += 1; return { token: "token-" + calls }; },
};
`);
    const seen: (string | null)[] = [];
    const server = serve((request) => {
      seen.push(request.headers.get("authorization"));
      // The first token is refused the way a revoked subscription token is.
      if (seen.length === 1) return new Response(JSON.stringify({ error: { message: "expired token" } }), { status: 401 });
      return sse(completionsStream());
    });

    const auth = new PluginAuth(id, root);
    const transport = new OpenAICompletionsTransport({ id: "sub", baseUrl: `http://127.0.0.1:${server.port}/v1`, auth });
    const provider = new ReliableProvider(transport, {
      maxAttempts: 3,
      sleep: async () => undefined,
      refreshAuth: async () => { auth.invalidate(); },
    });

    const events = [];
    for await (const event of provider.stream(baseRequest())) events.push(event);

    expect(seen).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(events.some((event) => event.type === "retry" && event.classification === "auth")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "complete" });
  });

  test("without a refreshAuth hook the same 401 surfaces immediately", async () => {
    const { root, id } = await fixture(`export default { id: "$ID", async getToken() { return { token: "stale" }; } };`);
    let requests = 0;
    const server = serve(() => {
      requests += 1;
      return new Response(JSON.stringify({ error: { message: "expired token" } }), { status: 401 });
    });
    const transport = new OpenAICompletionsTransport({ id: "sub", baseUrl: `http://127.0.0.1:${server.port}/v1`, auth: new PluginAuth(id, root) });
    const provider = new ReliableProvider(transport, { maxAttempts: 3, sleep: async () => undefined });
    await expect((async () => { for await (const _ of provider.stream(baseRequest())) { /* drain */ } })()).rejects.toThrow();
    expect(requests).toBe(1);
  });
});

// -----------------------------------------------------------------------------------------------

function serve(handler: (request: Request) => Response | Promise<Response>): Bun.Server<unknown> {
  const server = Bun.serve({ port: 0, fetch: handler }) as Bun.Server<unknown>;
  servers.push(server);
  return server;
}

function sse(frames: readonly string[]): Response {
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}

/** Runs one streamed turn against a scripted endpoint and returns the request it actually sent. */
async function captureBody(
  create: (baseUrl: string) => { stream(request: ReturnType<typeof baseRequest>, context: TransportContext): AsyncIterable<unknown> },
  frames: readonly string[],
): Promise<{ body: Record<string, unknown>; headers: Record<string, string> }> {
  let body: Record<string, unknown> = {};
  let headers: Record<string, string> = {};
  const server = serve(async (request) => {
    body = await request.json() as Record<string, unknown>;
    headers = Object.fromEntries(request.headers.entries());
    return sse(frames);
  });
  const transport = create(`http://127.0.0.1:${server.port}/v1`);
  for await (const _ of transport.stream(baseRequest(), CONTEXT)) { /* drain */ }
  return { body, headers };
}

function anthropicStream(): readonly string[] {
  return [
    frame("message_start", { type: "message_start", message: { id: "msg-1", usage: { input_tokens: 1, output_tokens: 0 } } }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    frame("message_stop", { type: "message_stop" }),
  ];
}

function completionsStream(): readonly string[] {
  return [
    `data: ${JSON.stringify({ id: "c-1", choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
