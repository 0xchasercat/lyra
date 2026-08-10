import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolValidator } from "@lyra/acp";
import { LyraRuntime } from "../src/index.ts";
import { suggestProviderName } from "../src/provider-setup.ts";

/**
 * The provider/model surface as a client actually drives it.
 *
 * The shape of the redesign these tests pin down: `/provider add` is pure addition and never
 * switches, `/model` is the one switching surface and it spans providers, `/model add` names a
 * model for an endpoint that cannot list its own, and a subagent's model is resolved against
 * every configured provider rather than against whichever one the parent happens to be on.
 *
 * Everything here runs against real local endpoints rather than mocked transports, because the
 * defects this surface has had — a provider that saved and then could not serve, a bare model
 * id resolved against the wrong provider — all lived in the gap between "the daemon said yes"
 * and "a turn ran".
 */

const validator = new ProtocolValidator();
const roots: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface StubOptions {
  /** Which endpoint answered, so a turn's text proves *where* it ran, not just that it ran. */
  label?: string;
  family?: "openai" | "anthropic";
  models?: readonly string[];
  /**
   * How the endpoint answers a POST to `/responses`.
   *
   * "validating" = the route exists and rejects a bad body; "missing" = there is no such
   * route; "generic" = a proxy that hands every unknown path to one handler and calls the
   * result a 400; "named" = a route that rejects the body by naming a Responses-only
   * parameter, at a proxy whose unknown-path answer has the very same shape.
   */
  responses?: "validating" | "missing" | "generic" | "named";
  /** When set, every request without this credential is refused the way that family refuses. */
  requireKey?: string;
  /** False for an endpoint with no model-listing route at all. */
  listsModels?: boolean;
  /** True for an endpoint that serves its API under /v1 and has nothing at its root. */
  versionedOnly?: boolean;
}

/**
 * A local endpoint that behaves like the family it claims to be: it lists models in that
 * family's shape, refuses in that family's error dialect, and answers a completion with the
 * model it was asked for and its own label.
 */
function stub(options: StubOptions = {}): string {
  const family = options.family ?? "openai";
  const label = options.label ?? "stub";
  const models = options.models ?? ["model-a"];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const credential = request.headers.get("x-api-key") ?? (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      // A real API answers only where it lives; "every path is mine" is a test fiction that
      // would make the two base-URL shapes indistinguishable.
      if (options.versionedOnly === true && !url.pathname.startsWith("/v1/")) return new Response(null, { status: 404 });
      if (options.requireKey !== undefined && credential !== options.requireKey) return refusal(family);
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        if (options.listsModels === false) return Response.json({ error: { message: "Unknown path", type: "invalid_request_error" } }, { status: 404 });
        return family === "anthropic"
          ? Response.json({ data: models.map((id) => ({ type: "model", id, display_name: id })), has_more: false })
          : Response.json({ object: "list", data: models.map((id) => ({ id, object: "model", owned_by: label })) });
      }
      // A proxy with one handler for everything it does not recognise, `/responses` included:
      // the same status and the same shape whatever path it is asked for.
      if (request.method === "POST" && options.responses === "generic" && !url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: { message: `Unsupported endpoint ${url.pathname}` } }, { status: 400 });
      }
      if (request.method === "POST" && options.responses === "named" && !url.pathname.endsWith("/chat/completions")) {
        return url.pathname.endsWith("/responses")
          ? Response.json({ error: { message: "Missing required parameter: 'input'.", type: "invalid_request_error", param: "input", code: "missing_required_parameter" } }, { status: 400 })
          : Response.json({ error: { message: `Unsupported endpoint ${url.pathname}`, type: "invalid_request_error", param: "path", code: "unknown_route" } }, { status: 400 });
      }
      if (request.method === "POST" && url.pathname.endsWith("/responses")) {
        return options.responses === "validating"
          ? Response.json({ error: { message: "Missing required parameter: 'model'.", type: "invalid_request_error" } }, { status: 400 })
          : Response.json({ error: { message: "Unrecognized request URL.", type: "invalid_request_error" } }, { status: 404 });
      }
      const body = await request.json() as { model?: string };
      const chunks = [
        { choices: [{ index: 0, delta: { content: `answered by ${body.model} @ ${label}` } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/v1`;
}

/** How each family says "no credential", which is what makes a 401 identify a family at all. */
function refusal(family: "openai" | "anthropic"): Response {
  return family === "anthropic"
    ? Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 })
    : Response.json({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 });
}

/** An origin with workspaces off, and one provider configured to point at `url`. */
async function fixture(url: string, provider = "alpha", model = "model-a"): Promise<{ root: string; home: string; providers: string }> {
  const root = await mkdtemp(join(tmpdir(), "lyra-models-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(join(root, ".lyra"), { recursive: true });
  await mkdir(join(home, ".lyra"), { recursive: true });
  await writeFile(join(root, ".lyra", "config.toml"), "[workspace]\nenabled = false\n");
  const providers = join(home, ".lyra", "providers.toml");
  await writeFile(providers, `[providers.${provider}]\nbase_url = "${url}"\napi_type = "openai_completions"\nauth = { type = "none" }\nmodels = ["${model}"]\n\n[roles]\ndefault = "${provider}/${model}"\n`);
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
async function connected(runtime: LyraRuntime): Promise<(method: string, params?: unknown) => Promise<unknown>> {
  const writer = new Writer();
  await runtime.app.acp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), writer);
  let id = 100;
  return async (method, params) => {
    const current = (id += 1);
    await runtime.app.acp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: current, method, ...(params === undefined ? {} : { params }) }));
    const deadline = Date.now() + 30_000;
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

type ModelSurface = { current?: string; providers: Array<{ provider: string; models: Array<{ id: string }> }>; roles?: Record<string, string>; refreshed?: boolean };
function idsFor(surface: ModelSurface, provider: string): string[] {
  return surface.providers.find((row) => row.provider === provider)?.models.map((model) => model.id) ?? [];
}

describe("provider/detect", () => {
  test("identifies the family and the most capable protocol an endpoint actually implements", async () => {
    const completions = stub({ family: "openai", responses: "missing" });
    const responses = stub({ family: "openai", responses: "validating" });
    const anthropic = stub({ family: "anthropic", models: ["claude-opus-5"] });
    const { root, home } = await fixture(completions);
    const runtime = await LyraRuntime.create({ origin: root, session: "detect", home });
    try {
      const call = await connected(runtime);

      // No /responses route: the honest answer is the protocol that is there.
      const plain = await call("provider/detect", { baseUrl: completions });
      validator.assert(plain, "#/$defs/requests/provider~1detect/result", "detect completions");
      expect(plain).toMatchObject({ apiTypes: ["openai_completions"], suggestedName: "local" });

      // A /responses route that validates its input is a route that exists.
      expect(await call("provider/detect", { baseUrl: responses })).toMatchObject({ apiTypes: ["openai_responses"] });

      // Anthropic is identified by the shape of its list, not by its hostname.
      expect(await call("provider/detect", { baseUrl: anthropic })).toMatchObject({ apiTypes: ["anthropic_messages"] });

      // Nothing was refused, and no credential was offered, so the endpoint is known to be open.
      expect(plain).toMatchObject({ authRequired: false });
    } finally { await runtime.close(); }
  }, 30_000);

  /**
   * The defect this pins down: a user's local proxy answered every unrecognised path with a
   * generic 400, detection read that as "the /responses route validated my body", and every
   * turn afterwards went out over a protocol nothing behind the proxy spoke.
   */
  test("a proxy that answers every unknown path the same way is completions, not responses", async () => {
    const catchAll = stub({ family: "openai", responses: "generic" });
    const named = stub({ family: "openai", responses: "named" });
    const { root, home } = await fixture(stub());
    const runtime = await LyraRuntime.create({ origin: root, session: "detect-proxy", home });
    try {
      const call = await connected(runtime);

      // The 400 is not evidence: a route that does not exist answers identically.
      const proxy = await call("provider/detect", { baseUrl: catchAll }) as { apiTypes: string[] };
      validator.assert(proxy, "#/$defs/detectProviderResult", "detect a catch-all proxy");
      expect(proxy.apiTypes).toEqual(["openai_completions"]);

      // Same status, same shape at both paths — but one of them read the body and named a
      // parameter only the Responses API has, which is the route speaking for itself.
      expect(await call("provider/detect", { baseUrl: named })).toMatchObject({ apiTypes: ["openai_responses"] });
    } finally { await runtime.close(); }
  }, 30_000);

  test("a refusal still identifies the family, and says a credential is what is missing", async () => {
    const guarded = stub({ family: "openai", requireKey: "sk-right", responses: "validating" });
    const guardedAnthropic = stub({ family: "anthropic", requireKey: "sk-right" });
    const { root, home } = await fixture(stub());
    const runtime = await LyraRuntime.create({ origin: root, session: "detect-auth", home });
    try {
      const call = await connected(runtime);
      // Refused, but in OpenAI's dialect — which is enough to know what it is.
      const anonymous = await call("provider/detect", { baseUrl: guarded }) as { apiTypes: string[]; authRequired?: boolean };
      expect(anonymous.authRequired).toBe(true);
      expect(anonymous.apiTypes).toEqual(["openai_completions"]);
      expect(await call("provider/detect", { baseUrl: guardedAnthropic })).toMatchObject({ apiTypes: ["anthropic_messages"], authRequired: true });

      // With the credential the /responses probe gets past the guard and can be believed, so
      // the answer sharpens. This is the honest limit of anonymous detection, stated as a test.
      const authenticated = await call("provider/detect", { baseUrl: guarded, apiKey: "sk-right" }) as { apiTypes: string[]; authRequired?: boolean };
      expect(authenticated.apiTypes).toEqual(["openai_responses"]);
      // A credential was supplied and accepted, so whether one was *required* was never tested.
      expect(authenticated.authRequired).toBeUndefined();
    } finally { await runtime.close(); }
  }, 30_000);

  test("an endpoint that cannot be reached is an answer, not a failure, and nothing is cached", async () => {
    const { root, home } = await fixture(stub());
    const runtime = await LyraRuntime.create({ origin: root, session: "detect-dead", home });
    try {
      const call = await connected(runtime);
      // Port 1 refuses immediately; a typo in a base URL is a form to fix, not a broken daemon.
      const dead = await call("provider/detect", { baseUrl: "http://127.0.0.1:1/v1" }) as { apiTypes: string[]; suggestedName?: string };
      validator.assert(dead, "#/$defs/detectProviderResult", "unreachable detect");
      expect(dead.apiTypes).toEqual([]);
      // The name still comes back: it is derived from the URL, which is knowable regardless.
      expect(dead.suggestedName).toBe("local");
      expect(await call("provider/detect", { baseUrl: "not a url" })).toEqual({ apiTypes: [] });

      // Detection writes nothing: no provider appeared, and no probe left a cache behind.
      expect(await call("session/providers")).toMatchObject({ available: ["alpha"] });
      const cached = await readFile(join(root, ".lyra", "providers", "_verify", "models.json"), "utf8").catch(() => undefined);
      expect(cached).toBeUndefined();
    } finally { await runtime.close(); }
  }, 30_000);

  /**
   * The half of detection that was missing: which *path shape* answered.
   *
   * A user added a proxy whose base URL was one `/v1` away from where its routes lived.
   * Detection said "OpenAI, completions" and was right; the first turn asked for a URL that
   * did not exist and came back 404 with an empty body. Detecting the protocol without
   * detecting the path is half an answer, and the missing half was the one that failed.
   */
  test("reports the base URL that answered, canonically, and provider/add stores exactly that", async () => {
    const versioned = stub({ family: "openai", responses: "missing", versionedOnly: true });
    const bare = versioned.replace(/\/v1$/, "");
    const { root, home } = await fixture(stub());
    const runtime = await LyraRuntime.create({ origin: root, session: "detect-normalize", home });
    try {
      const call = await connected(runtime);

      // Typed as the bare host: the endpoint is still identified, and the base to save is the
      // one it actually answered on, not a convention guessed from the api_type.
      const detected = await call("provider/detect", { baseUrl: bare }) as { apiTypes: string[]; normalizedBaseUrl?: string };
      validator.assert(detected, "#/$defs/detectProviderResult", "detect with a bare base");
      expect(detected.apiTypes).toEqual(["openai_completions"]);
      expect(detected.normalizedBaseUrl).toBe(versioned);

      // Typed the other way round, trailing slash and all: already correct, so unchanged.
      expect(await call("provider/detect", { baseUrl: `${versioned}/` })).toMatchObject({ normalizedBaseUrl: versioned });

      // An endpoint nothing could be learned from still gets the canonical rewrite — it is a
      // suggestion for the form, and a form with a blank field helps nobody.
      expect(await call("provider/detect", { baseUrl: "http://127.0.0.1:1" })).toMatchObject({ apiTypes: [], normalizedBaseUrl: "http://127.0.0.1:1/v1" });
      expect(await call("provider/detect", { baseUrl: "not a url" })).toEqual({ apiTypes: [] });

      // And the add stores canonical form, so what was measured is what gets requested.
      await call("provider/add", { provider: "gateway", baseUrl: bare, apiType: "openai_completions", persist: "none" });
      expect(await call("provider/get", { provider: "gateway" })).toMatchObject({ baseUrl: versioned });
    } finally { await runtime.close(); }
  }, 30_000);

  test("the suggested provider id comes from the host, and is always a usable id", () => {
    expect(suggestProviderName("https://api.anthropic.com")).toBe("anthropic");
    expect(suggestProviderName("https://api.openai.com/v1")).toBe("openai");
    expect(suggestProviderName("http://localhost:11434/v1")).toBe("local");
    expect(suggestProviderName("http://127.0.0.1:8080")).toBe("local");
    expect(suggestProviderName("http://[::1]:8080/v1")).toBe("local");
    // "api" is not a name; the label after it is.
    expect(suggestProviderName("https://api.groq.com/openai/v1")).toBe("groq");
    expect(suggestProviderName("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(suggestProviderName("https://www.example.co.uk")).toBe("example");
    expect(suggestProviderName("nonsense")).toBeUndefined();
    // Whatever comes back is something `provider/add` will accept.
    for (const url of ["https://api.anthropic.com", "https://api.groq.com", "http://localhost:1234", "https://8-ball.example.com"]) {
      const name = suggestProviderName(url);
      if (name !== undefined) expect(name).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
    }
  });
});

describe("session/models spans every configured provider", () => {
  test("adding a provider adds it to the listing without switching to it, and reports what it found", async () => {
    const alpha = stub({ label: "alpha", models: ["model-a", "model-a-pro"] });
    const beta = stub({ label: "beta", models: ["model-b", "model-b-lite", "model-b-max"] });
    const { root, home } = await fixture(alpha);
    const runtime = await LyraRuntime.create({ origin: root, session: "cross-provider", home });
    try {
      const call = await connected(runtime);

      const before = await call("session/models") as ModelSurface;
      validator.assert(before, "#/$defs/requests/session~1models/result", "session/models result");
      expect(before.current).toBe("alpha/model-a");
      expect(before.providers.map((row) => row.provider)).toEqual(["alpha"]);
      // Discovered ∪ declared: the endpoint listed both, and the declaration named one of them.
      expect(idsFor(before, "alpha")).toEqual(["model-a", "model-a-pro"]);

      const added = await call("provider/add", { provider: "beta", baseUrl: beta, apiType: "openai_completions", model: "model-b", persist: "none" }) as { modelsDiscovered?: number };
      validator.assert(added, "#/$defs/addProviderResult", "provider/add result");
      // The add went looking, and says what it found — three listed by the endpoint.
      expect(added.modelsDiscovered).toBe(3);

      const after = await call("session/models") as ModelSurface;
      validator.assert(after, "#/$defs/requests/session~1models/result", "session/models after add");
      // Both providers, each with its own catalogue — the whole point of the reshape.
      expect(after.providers.map((row) => row.provider)).toEqual(["alpha", "beta"]);
      expect(idsFor(after, "beta")).toEqual(["model-b", "model-b-lite", "model-b-max"]);
      // Adding is pure addition: the session is exactly where it was.
      expect(after.current).toBe("alpha/model-a");
      expect(await call("session/providers")).toMatchObject({ current: "alpha" });
    } finally { await runtime.close(); }
  }, 30_000);

  test("one unreachable provider costs itself its discovered models and nothing else its listing", async () => {
    const alpha = stub({ label: "alpha", models: ["model-a"] });
    const { root, home, providers } = await fixture(alpha);
    await writeFile(providers, `${await readFile(providers, "utf8")}\n[providers.ghost]\nbase_url = "http://127.0.0.1:1/v1"\napi_type = "openai_completions"\nauth = { type = "none" }\nmodels = ["declared-only"]\n\n[providers.silent]\nbase_url = "http://127.0.0.1:1/v1"\napi_type = "openai_completions"\nauth = { type = "none" }\n`);
    const runtime = await LyraRuntime.create({ origin: root, session: "partial-outage", home });
    try {
      const call = await connected(runtime);
      const surface = await call("session/models") as ModelSurface;
      validator.assert(surface, "#/$defs/requests/session~1models/result", "session/models with an outage");
      expect(surface.providers.map((row) => row.provider)).toEqual(["alpha", "ghost", "silent"]);
      // The reachable provider is unaffected.
      expect(idsFor(surface, "alpha")).toEqual(["model-a"]);
      // The unreachable one falls back to what it declares, which is still true.
      expect(idsFor(surface, "ghost")).toEqual(["declared-only"]);
      // And one that declares nothing is listed empty rather than omitted: it exists.
      expect(idsFor(surface, "silent")).toEqual([]);
    } finally { await runtime.close(); }
  }, 30_000);

  test("a model reference switches provider and model in one validated step", async () => {
    const alpha = stub({ label: "alpha", models: ["model-a"] });
    const beta = stub({ label: "beta", models: ["model-b"] });
    const { root, home } = await fixture(alpha);
    const runtime = await LyraRuntime.create({ origin: root, session: "cross-select", home });
    try {
      const call = await connected(runtime);
      await call("provider/add", { provider: "beta", baseUrl: beta, apiType: "openai_completions", model: "model-b", persist: "none" });

      // One call moves both halves. There is no "select the provider first" step any more.
      const selection = await call("session/select_model", { model: "beta/model-b" });
      validator.assert(selection, "#/$defs/requests/session~1select_model/result", "cross-provider selection");
      expect(selection).toEqual({ provider: "beta", model: "model-b" });
      const turn = await call("session/prompt", { prompt: "hello" }) as { assistant: { content: Array<{ text?: string }> } };
      expect(turn.assistant.content[0]?.text).toBe("answered by model-b @ beta");
      expect((await call("session/models") as ModelSurface).current).toBe("beta/model-b");

      // A bare id still means "on the provider I am using", so /model stays terse.
      expect(await call("session/select_model", { model: "model-b-alias" }).catch((error: Error) => error.message)).toEqual({ provider: "beta", model: "model-b-alias" });
      expect(((await call("session/prompt", { prompt: "again" })) as { assistant: { content: Array<{ text?: string }> } }).assistant.content[0]?.text)
        .toBe("answered by model-b-alias @ beta");

      // And a reference to a provider that is not configured is refused by name, unchanged.
      const failure = await call("session/select_model", { model: "gamma/model-c" }).catch((error: Error) => error.message) as string;
      expect(failure).toContain(`Provider "gamma" is not configured`);
      expect((await call("session/models") as ModelSurface).current).toBe("beta/model-b-alias");
    } finally { await runtime.close(); }
  }, 30_000);
});

describe("model/add", () => {
  test("declares a model an endpoint cannot list, and the session can then select it", async () => {
    // An endpoint with no /models route at all: the only way to name a model is to declare it.
    const gateway = stub({ label: "gateway", listsModels: false });
    const { root, home, providers } = await fixture(gateway, "gateway", "known-model");
    const runtime = await LyraRuntime.create({ origin: root, session: "model-add", home });
    try {
      const call = await connected(runtime);
      expect(idsFor(await call("session/models") as ModelSurface, "gateway")).toEqual(["known-model"]);

      const added = await call("model/add", { provider: "gateway", model: "internal-coder-v3" });
      validator.assert(added, "#/$defs/requests/model~1add/result", "model/add result");
      expect(added).toEqual({ ok: true, provider: "gateway", model: "internal-coder-v3" });

      // Visible in the listing without a restart, and selectable, and it actually runs.
      expect(idsFor(await call("session/models") as ModelSurface, "gateway")).toEqual(["internal-coder-v3", "known-model"]);
      expect(await call("session/select_model", { model: "gateway/internal-coder-v3" })).toEqual({ provider: "gateway", model: "internal-coder-v3" });
      const turn = await call("session/prompt", { prompt: "hi" }) as { assistant: { content: Array<{ text?: string }> } };
      expect(turn.assistant.content[0]?.text).toBe("answered by internal-coder-v3 @ gateway");

      // The declaration is on disk, beside what was already there rather than instead of it.
      const text = await readFile(providers, "utf8");
      expect(text).toContain(`models = ["known-model", "internal-coder-v3"]`);
      expect(text).toContain(`default = "gateway/known-model"`);

      // Declaring the same id twice is idempotent, not accumulative.
      expect(await call("model/add", { provider: "gateway", model: "internal-coder-v3" })).toEqual({ ok: true, provider: "gateway", model: "internal-coder-v3" });
      expect(await readFile(providers, "utf8")).toBe(text);
    } finally { await runtime.close(); }
  }, 30_000);

  test("an unconfigured provider is refused with the ones that do exist", async () => {
    const { root, home } = await fixture(stub());
    const runtime = await LyraRuntime.create({ origin: root, session: "model-add-missing", home });
    try {
      const call = await connected(runtime);
      const failure = await call("model/add", { provider: "gamma", model: "model-c" }).catch((error: Error) => error.message) as string;
      expect(failure).toContain(`provider "gamma" is not configured`);
      expect(failure).toContain("Configured providers: alpha");
      expect(failure).toContain("/provider add");
      // Nothing was written for a provider that does not exist.
      expect((await call("session/models") as ModelSurface).providers.map((row) => row.provider)).toEqual(["alpha"]);
    } finally { await runtime.close(); }
  }, 30_000);

  test("the slash form routes to the same method and answers with the model surface", async () => {
    const gateway = stub({ label: "gateway", listsModels: false });
    const { root, home } = await fixture(gateway, "gateway", "known-model");
    const runtime = await LyraRuntime.create({ origin: root, session: "model-add-slash", home });
    try {
      const call = await connected(runtime);
      const result = await call("session/command", { command: "/model add gateway declared-by-slash" }) as { resultKind: string; output: unknown; error?: string };
      expect(result.error).toBeUndefined();
      // Still the models shape: the client renders one view for every form of /model.
      expect(result.resultKind).toBe("models");
      validator.assert(result.output, "#/$defs/modelsResult", "/model add output");
      expect(idsFor(result.output as ModelSurface, "gateway")).toEqual(["declared-by-slash", "known-model"]);

      // The catalogue advertises the form, so the popup can offer it.
      const listing = await call("session/commands") as { commands: Array<{ name: string; usage?: string }> };
      expect(listing.commands.find((entry) => entry.name === "model")?.usage).toContain("add <provider> <id>");

      const misuse = await call("session/command", { command: "/model add gateway" }) as { error?: string };
      expect(misuse.error).toContain("/model add <provider> <id>");
    } finally { await runtime.close(); }
  }, 30_000);
});

/**
 * Editing and deleting, which the provider surface had no way to express: a provider added
 * with a wrong base URL could only be replaced by retyping the whole form from memory, and a
 * provider added by mistake could only be removed by hand-editing TOML.
 */
describe("provider/get and provider/remove", () => {
  test("reads a provider back for an edit form, and never its credential", async () => {
    const alpha = stub({ label: "alpha", models: ["model-a"] });
    const beta = stub({ label: "beta", models: ["model-b"] });
    const { root, home } = await fixture(alpha);
    Bun.env.LYRA_TEST_EDIT_KEY = "edit-key";
    const runtime = await LyraRuntime.create({ origin: root, session: "provider-get", home });
    try {
      const call = await connected(runtime);

      // The provider the session is on: everything the form needs, plus the one fact a client
      // must have before it offers a delete button.
      const current = await call("provider/get", { provider: "alpha" }) as Record<string, unknown>;
      validator.assert(current, "#/$defs/requests/provider~1get/result", "provider/get result");
      expect(current).toEqual({ provider: "alpha", baseUrl: alpha, apiType: "openai_completions", authType: "none", models: ["model-a"], inUse: true });

      // A credential source is described by its *address*, which is what an edit form shows.
      await call("provider/add", { provider: "beta", baseUrl: beta, apiType: "openai_responses", websocket: "off", persist: "env", authEnvVar: "LYRA_TEST_EDIT_KEY" });
      const added = await call("provider/get", { provider: "beta" }) as Record<string, unknown>;
      validator.assert(added, "#/$defs/getProviderResult", "provider/get for an env provider");
      expect(added).toMatchObject({ provider: "beta", baseUrl: beta, apiType: "openai_responses", websocket: "off", authType: "env", authDetail: "LYRA_TEST_EDIT_KEY", inUse: false });
      // The *name* of the variable, never its contents. This is the assertion that makes the
      // method safe to call from a form that renders everything it receives.
      expect(JSON.stringify(added)).not.toContain("edit-key");

      // A token in the config file has no address to name, and naming its value is the one
      // thing this method must never do.
      await call("provider/add", { provider: "plain", baseUrl: beta, apiType: "openai_completions", persist: "plaintext", apiKey: "sk-super-secret" });
      const plain = await call("provider/get", { provider: "plain" }) as Record<string, unknown>;
      expect(plain).toMatchObject({ authType: "static", inUse: false });
      expect(plain.authDetail).toBeUndefined();
      expect(JSON.stringify(plain)).not.toContain("sk-super-secret");

      // An unknown name is an error that names what does exist and where to declare more.
      const failure = await call("provider/get", { provider: "ghost" }).catch((error: Error) => error.message) as string;
      expect(failure).toContain(`Provider "ghost" is not configured`);
      expect(failure).toContain("Configured providers: alpha, beta, plain");
      expect(failure).toContain("/provider add");
    } finally { delete Bun.env.LYRA_TEST_EDIT_KEY; await runtime.close(); }
  }, 30_000);

  test("an edit is provider/add with persist keep: the form changes, the key does not", async () => {
    const alpha = stub({ label: "alpha", models: ["model-a"] });
    const beta = stub({ label: "beta", models: ["model-b"] });
    const { root, home, providers } = await fixture(alpha);
    Bun.env.LYRA_TEST_KEEP_KEY = "keep-key";
    const runtime = await LyraRuntime.create({ origin: root, session: "provider-edit", home });
    try {
      const call = await connected(runtime);
      await call("provider/add", { provider: "beta", baseUrl: "http://127.0.0.1:1/v1", apiType: "openai_completions", persist: "env", authEnvVar: "LYRA_TEST_KEEP_KEY" });
      // A model the endpoint cannot list, registered the only way there is to register one.
      await call("model/add", { provider: "beta", model: "model-b" });
      const authLine = (await readFile(providers, "utf8")).split("\n").find((line) => line.startsWith("auth = { type = \"env\""))!;

      // The base URL was wrong. The key was not, and the form's key field is empty.
      const edited = await call("provider/add", { provider: "beta", baseUrl: beta, apiType: "openai_completions", persist: "keep" }) as { auth: string };
      validator.assert(edited, "#/$defs/addProviderResult", "provider/add with keep");
      expect(edited.auth).toBe("env");
      expect((await readFile(providers, "utf8")).split("\n").filter((line) => line.startsWith("auth = { type = \"env\""))).toEqual([authLine]);
      // The form has no model rows, so the edit must not be able to delete the model list.
      expect(await call("provider/get", { provider: "beta" })).toMatchObject({ baseUrl: beta, authDetail: "LYRA_TEST_KEEP_KEY", models: ["model-b"] });

      // And the edited provider works, which is the point of having edited it.
      await call("session/select_model", { model: "beta/model-b" });
      const turn = await call("session/prompt", { prompt: "hi" }) as { assistant: { content: Array<{ text?: string }> } };
      expect(turn.assistant.content[0]?.text).toBe("answered by model-b @ beta");

      // Keeping what is not there is refused rather than silently written as "no credential".
      const failure = await call("provider/add", { provider: "ghost", baseUrl: beta, apiType: "openai_completions", persist: "keep" }).catch((error: Error) => error.message) as string;
      expect(failure).toContain(`Cannot keep the existing credential for "ghost"`);
    } finally { delete Bun.env.LYRA_TEST_KEEP_KEY; await runtime.close(); }
  }, 30_000);

  test("removes a provider, refuses the one in use, and reports the roles left pointing at it", async () => {
    const alpha = stub({ label: "alpha", models: ["model-a"] });
    const beta = stub({ label: "beta", models: ["model-b"] });
    const { root, home, providers } = await fixture(alpha);
    const runtime = await LyraRuntime.create({ origin: root, session: "provider-remove", home });
    try {
      const call = await connected(runtime);
      // Adding with a model takes the roles with it, so removing beta will orphan all three.
      await call("provider/add", { provider: "beta", baseUrl: beta, apiType: "openai_completions", model: "model-b", persist: "plaintext", apiKey: "sk-beta" });

      // The session is on alpha, and removing the ground you are standing on is refused with
      // the move that makes it possible rather than with a broken session.
      const refused = await call("provider/remove", { provider: "alpha" }).catch((error: Error) => error.message) as string;
      expect(refused).toContain(`Cannot remove "alpha"`);
      expect(refused).toContain("running on");
      expect(refused).toContain("session/select_model");
      expect(await call("session/providers")).toMatchObject({ current: "alpha", available: ["alpha", "beta"] });

      // The one not in use goes, and says what it left behind.
      const removed = await call("provider/remove", { provider: "beta" }) as Record<string, unknown>;
      validator.assert(removed, "#/$defs/requests/provider~1remove/result", "provider/remove result");
      expect(removed).toMatchObject({ ok: true, provider: "beta", path: providers, danglingRoles: ["default", "fast", "merge"] });
      // Not asked about the credential, so nothing is claimed about one.
      expect(removed.credentialRemoved).toBeUndefined();

      // Gone from the file, from the listing, and from the model surface — without a restart.
      const text = await readFile(providers, "utf8");
      expect(text).not.toContain("[providers.beta]");
      expect(text).not.toContain("sk-beta");
      // A role Lyra did not write is a role Lyra does not rewrite: it still says beta.
      expect(text).toContain('default = "beta/model-b"');
      expect(await call("session/providers")).toEqual({ current: "alpha", available: ["alpha"] });
      expect((await call("session/models") as ModelSurface).providers.map((row) => row.provider)).toEqual(["alpha"]);
      expect(await call("provider/get", { provider: "beta" }).catch((error: Error) => error.message)).toContain(`Provider "beta" is not configured`);

      // Removing what is not there names what is.
      const missing = await call("provider/remove", { provider: "beta" }).catch((error: Error) => error.message) as string;
      expect(missing).toContain(`Provider "beta" is not configured`);
      expect(missing).toContain("Configured providers: alpha");

      // After switching away, the provider that was in use can be removed too.
      await call("provider/add", { provider: "beta", baseUrl: beta, apiType: "openai_completions", model: "model-b", persist: "none" });
      await call("session/select_model", { model: "beta/model-b" });
      expect(await call("provider/remove", { provider: "alpha" })).toMatchObject({ ok: true, provider: "alpha" });
    } finally { await runtime.close(); }
  }, 30_000);

  test("the credential is deleted only when asked, and the answer says whether there was one", async () => {
    const alpha = stub({ label: "alpha", models: ["model-a"] });
    const beta = stub({ label: "beta", models: ["model-b"] });
    const { root, home, providers } = await fixture(alpha);
    const runtime = await LyraRuntime.create({ origin: root, session: "provider-remove-credential", home });
    try {
      const call = await connected(runtime);
      await call("provider/add", { provider: "beta", baseUrl: beta, apiType: "openai_completions", persist: "plaintext", apiKey: "sk-beta" });

      // A plaintext token is not Lyra's to delete separately — it left with the declaration it
      // lived in — so the honest answer to "also remove the credential" is "there was none".
      const removed = await call("provider/remove", { provider: "beta", removeCredential: true }) as { credentialRemoved?: boolean };
      expect(removed.credentialRemoved).toBe(false);
      expect(await readFile(providers, "utf8")).not.toContain("sk-beta");
    } finally { await runtime.close(); }
  }, 30_000);

  test("the command catalog advertises edit and delete, and the daemon says who handles them", async () => {
    const { root, home } = await fixture(stub());
    const runtime = await LyraRuntime.create({ origin: root, session: "provider-commands", home });
    try {
      const call = await connected(runtime);
      const listing = await call("session/commands") as { commands: Array<{ name: string; usage?: string }> };
      const usage = listing.commands.find((entry) => entry.name === "provider")?.usage ?? "";
      expect(usage).toContain("edit <name>");
      expect(usage).toContain("delete <name>");

      // The report form is untouched...
      const report = await call("session/command", { command: "/provider" }) as { output: unknown; error?: string };
      expect(report.error).toBeUndefined();
      expect(report.output).toMatchObject({ detail: { current: "alpha", available: ["alpha"] } });

      // ...and the two the client intercepts are answered by name rather than mistaken for a
      // provider called "edit".
      const edit = await call("session/command", { command: "/provider edit alpha" }) as { error?: string };
      expect(edit.error).toContain("handled by the client");
      expect(edit.error).toContain("provider/get");
      const remove = await call("session/command", { command: "/provider delete alpha" }) as { error?: string };
      expect(remove.error).toContain("provider/remove");
    } finally { await runtime.close(); }
  }, 30_000);
});

describe("a subagent's model is resolved across every configured provider", () => {
  test("a child runs on a provider added mid-session, while the parent stays where it was", async () => {
    const alpha = stub({ label: "alpha", models: ["model-a"] });
    const beta = stub({ label: "beta", models: ["model-b"] });
    const { root, home } = await fixture(alpha);
    const runtime = await LyraRuntime.create({ origin: root, session: "spawn-cross", home });
    try {
      const call = await connected(runtime);
      // The provider the child will use did not exist when the daemon booted, when the spawn
      // executor was constructed, or when the parent's own provider was resolved.
      await call("provider/add", { provider: "beta", baseUrl: beta, apiType: "openai_completions", model: "model-b", persist: "none" });

      const child = await call("agent/spawn", { task: "say something", model: "beta/model-b", isolated: false }) as { output: string; model?: string };
      expect(child.model).toBe("beta/model-b");
      // The load-bearing assertion: the child's turn reached beta's endpoint, not alpha's.
      expect(child.output).toBe("answered by model-b @ beta");

      // And the parent is untouched by its child's provider.
      const turn = await call("session/prompt", { prompt: "and me?" }) as { assistant: { content: Array<{ text?: string }> } };
      expect(turn.assistant.content[0]?.text).toBe("answered by model-a @ alpha");
      expect((await call("session/models") as ModelSurface).current).toBe("alpha/model-a");
    } finally { await runtime.close(); }
  }, 60_000);

  test("a bare model id resolves against the provider the session is on, not against @default", async () => {
    const alpha = stub({ label: "alpha", models: ["model-a"] });
    const beta = stub({ label: "beta", models: ["model-b"] });
    const { root, home } = await fixture(alpha);
    const runtime = await LyraRuntime.create({ origin: root, session: "spawn-bare", home });
    try {
      const call = await connected(runtime);
      // Adding beta takes the roles with it, so @default now points at beta while the session
      // is still running on alpha. A bare id used to be mapped through @default's provider,
      // which sent the child to beta's endpoint with alpha's model id.
      await call("provider/add", { provider: "beta", baseUrl: beta, apiType: "openai_completions", model: "model-b", persist: "none" });
      expect((await call("session/models") as ModelSurface).roles?.default).toBe("beta/model-b");
      expect(await call("session/providers")).toMatchObject({ current: "alpha" });

      const child = await call("agent/spawn", { task: "say something", model: "model-a", isolated: false }) as { output: string };
      expect(child.output).toBe("answered by model-a @ alpha");

      // A role still means what the roles table says, which is the other provider entirely.
      const byRole = await call("agent/spawn", { task: "say something", model: "@default", isolated: false }) as { output: string };
      expect(byRole.output).toBe("answered by model-b @ beta");
    } finally { await runtime.close(); }
  }, 60_000);
});
