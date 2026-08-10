import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoAuth } from "../src/auth.ts";
import {
  alternateBaseUrl,
  canonicalBaseUrl,
  forgetLearnedBaseUrls,
  providerEndpoint,
  providerEndpointCandidates,
  type ProviderNotice,
} from "../src/endpoints.ts";
import { ProviderFault } from "../src/errors.ts";
import { discoverModels } from "../src/models.ts";
import { AnthropicMessagesTransport } from "../src/transports/anthropic-messages.ts";
import { OpenAICompletionsTransport } from "../src/transports/openai-completions.ts";
import { OpenAIResponsesTransport } from "../src/transports/openai-responses.ts";
import { OpenAIWebSocketTransport } from "../src/transports/openai-websocket.ts";
import type { ProviderTransport, TransportContext, TransportEvent } from "../src/types.ts";
import { baseRequest } from "./fixture-adapter.ts";

/**
 * Where a provider's routes live.
 *
 * The failure this file exists for: a proxy added with `base_url = "https://proxy/v1"`.
 * Detection succeeded, because model discovery appended `/v1/models` only when the base did
 * *not* already end in `/v1`. The first turn died with `HTTP 404 with an empty error body`,
 * because the Anthropic transport joined a hard-coded `/v1/messages` onto the same base and
 * asked for `https://proxy/v1/v1/messages`. Two joiners, one base, and a 404 whose body could
 * not say which path it was about.
 *
 * So: one rule for every transport (`{base}/{route}`), both `/v1` shapes reachable, and a 404
 * that names the URL it went to.
 */

const CONTEXT: TransportContext = { signal: new AbortController().signal, headersTimeoutMs: 5_000 };
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const caches: string[] = [];

beforeEach(() => { forgetLearnedBaseUrls(); });
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(caches.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  forgetLearnedBaseUrls();
});

/** A throwaway models cache, so discovery in one test can never answer another one. */
function cacheRoot(): string { const path = mkdtempSync(join(tmpdir(), "lyra-endpoints-")); caches.push(path); return path; }

/** The route each api_type hangs off `base_url`, which is the whole of the resolution rule. */
const ROUTES = [
  { apiType: "openai_completions", route: "chat/completions" },
  { apiType: "openai_responses", route: "responses" },
  { apiType: "openai_websocket", route: "responses" },
  { apiType: "anthropic_messages", route: "messages" },
  { apiType: "*", route: "models" },
] as const;

/** Every base shape users actually paste, and the prefix each one is really about. */
const BASES = [
  { base: "https://api.openai.com/v1", root: "https://api.openai.com" },
  { base: "https://api.anthropic.com", root: "https://api.anthropic.com" },
  { base: "https://host/api/v1", root: "https://host/api" },
  { base: "http://localhost:4100/v1", root: "http://localhost:4100" },
  { base: "http://localhost:4100", root: "http://localhost:4100" },
  { base: "https://gateway.example/v1/", root: "https://gateway.example" },
] as const;

describe("base URL resolution", () => {
  test("every api_type joins the same way, and both /v1 shapes are candidates for all of them", () => {
    for (const { base, root } of BASES) {
      for (const { apiType, route } of ROUTES) {
        const candidates = providerEndpointCandidates(base, route);
        const label = `${apiType} @ ${base}`;
        // The exact join is what the configuration says, so it is what is asked for first.
        expect(`${label}: ${candidates.primary}`).toBe(`${label}: ${base.replace(/\/+$/, "")}/${route}`);
        // And between the two candidates, both conventions are covered — the versioned root
        // every hosted API publishes and the bare root a gateway may serve from.
        const reachable = new Set([candidates.primary, candidates.alternate]);
        expect(reachable).toContain(`${root}/v1/${route}`);
        expect(reachable).toContain(`${root}/${route}`);
      }
    }
  });

  test("the alternate is one version segment away, in whichever direction is left", () => {
    expect(alternateBaseUrl("https://api.openai.com/v1")).toBe("https://api.openai.com");
    expect(alternateBaseUrl("https://api.openai.com")).toBe("https://api.openai.com/v1");
    expect(alternateBaseUrl("https://host/api/v1")).toBe("https://host/api");
    // A versioned gateway prefix is a version segment too, whatever it is spelled.
    expect(alternateBaseUrl("https://host/api/v1beta")).toBe("https://host/api");
    expect(providerEndpoint("https://host/api/v1beta", "models")).toBe("https://host/api/v1beta/models");
  });

  test("canonical form is the prefix routes hang off, with the version segment on it", () => {
    const table: ReadonlyArray<readonly [string, string]> = [
      ["https://api.openai.com/v1", "https://api.openai.com/v1"],
      ["https://api.openai.com/v1/", "https://api.openai.com/v1"],
      // A bare origin is what "I pasted the host" looks like; no ecosystem serves from one.
      ["https://api.anthropic.com", "https://api.anthropic.com/v1"],
      ["http://localhost:4100", "http://localhost:4100/v1"],
      // A gateway's own versioned prefix survives untouched.
      ["https://host/api/v1", "https://host/api/v1"],
      // Pasted straight from a docs page: the route is cut back to its prefix.
      ["https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1"],
      ["https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1"],
      ["https://host/api/v1/models", "https://host/api/v1"],
      // Deployments whose base carries query state are not this function's business.
      ["https://host/openai/deployments/x?api-version=2024-02-01", "https://host/openai/deployments/x?api-version=2024-02-01"],
      // No scheme at all: `localhost:4100` would otherwise parse as a URL whose *scheme* is
      // `localhost`. Local machines get http, hostnames get https.
      ["localhost:4100", "http://localhost:4100/v1"],
      ["localhost:4100/v1", "http://localhost:4100/v1"],
      ["localhost:4100/v1/messages", "http://localhost:4100/v1"],
      ["127.0.0.1:8080", "http://127.0.0.1:8080/v1"],
      ["192.168.1.20:4100/v1", "http://192.168.1.20:4100/v1"],
      ["api.example.com/v1", "https://api.example.com/v1"],
    ];
    for (const [input, expected] of table) expect(`${input} → ${canonicalBaseUrl(input)}`).toBe(`${input} → ${expected}`);
  });

  test("every pasteable shape of the same endpoint joins to the same request URL", () => {
    // The user-facing promise, verbatim: `localhost:4100`, `localhost:4100/v1`, and
    // `localhost:4100/v1/messages` are the same provider out of the box. The bare shape
    // differs only in needing the one 404-retry at request time (its exact join has no /v1);
    // the other two — and their scheme-less spellings — resolve identically with no retry.
    for (const base of [
      "http://localhost:4100/v1",
      "http://localhost:4100/v1/messages",
      "localhost:4100/v1",
      "localhost:4100/v1/messages",
    ]) {
      expect(providerEndpoint(base, "messages")).toBe("http://localhost:4100/v1/messages");
      expect(providerEndpoint(base, "chat/completions")).toBe("http://localhost:4100/v1/chat/completions");
    }
    // The bare origin joins without /v1 and carries the /v1 shape as its retry candidate.
    for (const base of ["http://localhost:4100", "localhost:4100"]) {
      const { primary, alternate } = providerEndpointCandidates(base, "messages");
      expect(primary).toBe("http://localhost:4100/messages");
      expect(alternate).toBe("http://localhost:4100/v1/messages");
    }
  });
});

/** Records every path asked for, and refuses all of them, so a transport shows its whole hand. */
function pathRecorder(): { url: (path?: string) => string; paths: string[] } {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      paths.push(new URL(request.url).pathname);
      return Response.json({ error: { message: "Unrecognized request URL.", type: "invalid_request_error" } }, { status: 404 });
    },
  });
  servers.push(server);
  return { url: (path = "") => `http://127.0.0.1:${server.port}${path}`, paths };
}

function transportFor(apiType: string, baseUrl: string, onNotice?: (notice: ProviderNotice) => void): ProviderTransport {
  const config = { id: `probe-${apiType}`, baseUrl, auth: new NoAuth(), ...(onNotice === undefined ? {} : { onNotice }) };
  if (apiType === "openai_completions") return new OpenAICompletionsTransport(config);
  if (apiType === "openai_responses") return new OpenAIResponsesTransport(config);
  return new AnthropicMessagesTransport({ ...config, cacheBreakpoints: { system: false } });
}

async function drain(source: AsyncIterable<TransportEvent>): Promise<unknown> {
  try { for await (const _ of source) { /* the paths are the assertion */ } return undefined; }
  catch (error) { return error; }
}

describe("every transport asks under both base shapes", () => {
  for (const apiType of ["openai_completions", "openai_responses", "anthropic_messages"] as const) {
    const route = apiType === "openai_completions" ? "chat/completions" : apiType === "openai_responses" ? "responses" : "messages";
    test(`${apiType} reaches ${route} from a versioned base and from a bare one`, async () => {
      for (const suffix of ["/v1", ""]) {
        forgetLearnedBaseUrls();
        const recorder = pathRecorder();
        await drain(transportFor(apiType, recorder.url(suffix)).stream(baseRequest(), CONTEXT));
        // Exactly the two shapes, and — the reported bug — never `/v1/v1/messages`.
        expect(`${apiType} @ "${suffix}": ${[...recorder.paths].sort().join(" ")}`)
          .toBe(`${apiType} @ "${suffix}": ${[`/${route}`, `/v1/${route}`].sort().join(" ")}`);
      }
    });
  }

  test("model discovery asks the same way for every api_type, x-api-key included", async () => {
    for (const authHeader of ["bearer", "x-api-key"] as const) {
      for (const suffix of ["/v1", ""]) {
        forgetLearnedBaseUrls();
        const recorder = pathRecorder();
        // A 404 on both shapes is "this endpoint lists nothing", not a failure.
        expect(await discoverModels({ id: `discovery-${authHeader}`, baseUrl: recorder.url(suffix), auth: new NoAuth(), authHeader }, { force: true, cacheDirectory: cacheRoot() })).toEqual([]);
        expect([...recorder.paths].sort()).toEqual(["/models", "/v1/models"]);
      }
    }
  });

  test("the websocket connects to the same route its HTTP twin would post to", async () => {
    const urls: string[] = [];
    for (const suffix of ["/v1", ""]) {
      const transport = new OpenAIWebSocketTransport({
        id: "probe-websocket",
        baseUrl: `http://127.0.0.1:9/${suffix.replace(/^\//, "")}`.replace(/\/$/, ""),
        auth: new NoAuth(),
        maxConnectionFailures: 1,
        maxReplayAttempts: 0,
        websocketFactory: (url) => { urls.push(url); throw new Error("no socket in this test"); },
      });
      await drain(transport.stream(baseRequest(), CONTEXT));
      await transport.close();
    }
    // ws(s), the exact join, and nothing invented in between.
    expect(urls).toEqual(["ws://127.0.0.1:9/v1/responses", "ws://127.0.0.1:9/responses"]);
  });
});

/** An endpoint that serves the OpenAI API under `/v1` and has nothing at its root. */
function versionedOnly(): { origin: string; paths: string[] } {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (!path.startsWith("/v1/")) return new Response(null, { status: 404 });
      if (path === "/v1/models") return Response.json({ object: "list", data: [{ id: "model-a" }] });
      const chunks = [
        { choices: [{ index: 0, delta: { content: "healed" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  servers.push(server);
  return { origin: `http://127.0.0.1:${server.port}`, paths };
}

describe("a base URL one /v1 away from correct", () => {
  test("resolves the working shape on the first 404, once, and silently", async () => {
    const endpoint = versionedOnly();
    const transport = transportFor("openai_completions", endpoint.origin);

    const events: TransportEvent[] = [];
    for await (const event of transport.stream(baseRequest(), CONTEXT)) events.push(event);
    // The turn ran. Nothing was streamed before the retry, so replaying it cost a round trip
    // and no duplicated output. Silently: a base_url names the prefix where the API lives,
    // with or without its version segment, and resolving the route is Lyra's job — normal
    // behaviour, never a warning (owner decision, 2026-08-10).
    expect(events).toEqual([
      { type: "text_delta", text: "healed" },
      { type: "complete", stopReason: "end_turn" },
    ]);
    expect(endpoint.paths).toEqual(["/chat/completions", "/v1/chat/completions"]);

    // Learned: the second turn goes straight to the shape that works.
    endpoint.paths.length = 0;
    for await (const _ of transport.stream(baseRequest(), CONTEXT)) { /* drain */ }
    expect(endpoint.paths).toEqual(["/v1/chat/completions"]);
  }, 20_000);

  /**
   * Model discovery runs at boot and takes the same route resolution the turn does, so it is
   * usually the request that discovers which shape answers — and the turn that follows
   * inherits the learned shape rather than paying the probe again.
   */
  test("a shape learned by boot-time discovery is reused by the first turn", async () => {
    const endpoint = versionedOnly();
    expect(await discoverModels({ id: "boot", baseUrl: endpoint.origin, auth: new NoAuth() }, { force: true, cacheDirectory: cacheRoot() }))
      .toEqual([{ id: "model-a" }]);
    expect(endpoint.paths).toEqual(["/models", "/v1/models"]);

    // The turn goes straight to the working shape.
    const transport = new OpenAICompletionsTransport({ id: "boot", baseUrl: endpoint.origin, auth: new NoAuth() });
    endpoint.paths.length = 0;
    for await (const _ of transport.stream(baseRequest(), CONTEXT)) { /* drain */ }
    expect(endpoint.paths).toEqual(["/v1/chat/completions"]);
  });

  test("a 404 that survives both shapes is reported against the configured URL, named in full", async () => {
    const recorder = pathRecorder();
    const error = await drain(transportFor("anthropic_messages", recorder.url("/v1")).stream(baseRequest(), CONTEXT));
    expect(error).toBeInstanceOf(ProviderFault);
    const fault = error as ProviderFault;
    expect(fault.status).toBe(404);
    // The URL is on the fault, so every layer above can name it...
    expect(fault.url).toBe(recorder.url("/v1/messages"));
    // ...and the configured shape is the one reported, because that is the one to fix.
    expect(recorder.paths).toEqual(["/v1/messages", "/messages"]);
  });

  test("an empty-bodied 404 — the reported failure — carries the URL in its own message", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}/v1`;
    const error = await drain(transportFor("openai_completions", base).stream(baseRequest(), CONTEXT));
    const fault = error as ProviderFault;
    // Before: "The provider answered HTTP 404 with an empty error body" — true, and useless.
    expect(fault.providerMessage).toContain("HTTP 404");
    expect(fault.providerMessage).toContain(`${base}/chat/completions`);
  });
});
