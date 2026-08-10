import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultProviderConfig,
  loadProviderConfig,
  resolveModelRole,
  resolveProvider,
} from "../src/config.ts";
import { discoverModels, usesMaxCompletionTokens } from "../src/models.ts";
import { PluginAuth } from "../src/plugin-auth.ts";
import { StaticAuth } from "../src/auth.ts";
import { KeychainAuth, storeKeychainCredential } from "../src/credentials.ts";

const temporaryPaths: string[] = [];
const servers: Bun.Server<unknown>[] = [];

const savedOpenAiKey = Bun.env.OPENAI_API_KEY;
const savedAnthropicKey = Bun.env.ANTHROPIC_API_KEY;

afterEach(async () => {
  if (savedOpenAiKey === undefined) delete Bun.env.OPENAI_API_KEY;
  else Bun.env.OPENAI_API_KEY = savedOpenAiKey;
  if (savedAnthropicKey === undefined) delete Bun.env.ANTHROPIC_API_KEY;
  else Bun.env.ANTHROPIC_API_KEY = savedAnthropicKey;
  for (const server of servers.splice(0)) await server.stop(true);
  for (const path of temporaryPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("provider configuration", () => {
  test("one environment key is enough for a usable default provider", () => {
    delete Bun.env.ANTHROPIC_API_KEY;
    Bun.env.OPENAI_API_KEY = "test-openai-key";

    const config = defaultProviderConfig();

    expect(config.providers.openai?.api_type).toBe("openai_responses");
    expect(config.providers.openai?.websocket).toBe("auto");
    expect(config.roles.default).toBe("openai/gpt-5.6");
    expect(config.roles.fast).toBe("openai/gpt-5.6-luna");
  });

  test("TOML overrides defaults without disabling environment providers", async () => {
    Bun.env.OPENAI_API_KEY = "test-openai-key";
    const directory = await temporaryDirectory();
    const path = join(directory, "config.toml");
    await Bun.write(path, `
[providers.local]
base_url = "http://localhost:8080/v1"
api_type = "openai_completions"
auth = { type = "none" }
models = ["local-model"]

[roles]
fast = "local/local-model"
`);

    const config = await loadProviderConfig(path);

    expect(config.providers.openai).toBeDefined();
    expect(config.providers.local?.models).toEqual(["local-model"]);
    expect(config.roles.fast).toBe("local/local-model");
  });

  test("model roles fail with an actionable list", () => {
    expect(() => resolveModelRole("@review", { fast: "local/a" })).toThrow(
      "Unknown model role @review. Available roles: @fast",
    );
  });

  test("Anthropic providers use x-api-key authentication", async () => {
    const resolved = resolveProvider("anthropic", {
      base_url: "https://api.anthropic.com",
      api_type: "anthropic_messages",
      auth: { type: "env", var: "ANTHROPIC_API_KEY" },
    });

    expect(resolved.authHeader).toBe("x-api-key");
    expect(resolved.headers?.["anthropic-version"]).toBe("2023-06-01");
  });

  test("parses keychain and explicit plaintext auth when chosen", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "providers.toml");
    await Bun.write(path, `[providers.secure]\nbase_url = "https://secure.example/v1"\napi_type = "openai_completions"\nauth = { type = "keychain", service = "dev.lyra.secure", account = "operator" }\n[providers.explicit]\nbase_url = "https://explicit.example/v1"\napi_type = "openai_completions"\nauth = { type = "static", token = "chosen-plaintext" }\n`);
    const config = await loadProviderConfig(path);
    expect(config.providers.secure?.auth).toEqual({ type: "keychain", service: "dev.lyra.secure", account: "operator" });
    expect(config.providers.explicit?.auth).toEqual({ type: "static", token: "chosen-plaintext" });
    expect((await resolveProvider("explicit", config.providers.explicit!).auth?.getToken()).token).toBe("chosen-plaintext");
  });

  test("reads and writes OS keychain credentials through the command boundary", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const run = async (command: string, args: readonly string[]) => { calls.push({ command, args }); return { exitCode: 0, stdout: "keychain-token\n", stderr: "" }; };
    const auth = new KeychainAuth({ service: "dev.lyra.fixture", account: "operator", platform: "darwin", run });
    expect((await auth.getToken()).token).toBe("keychain-token");
    await storeKeychainCredential({ service: "dev.lyra.fixture", account: "operator" }, "stored-token", { platform: "darwin", run });
    expect(calls[0]).toMatchObject({ command: "/usr/bin/security", args: ["find-generic-password", "-w", "-s", "dev.lyra.fixture", "-a", "operator"] });
    expect(calls[1]?.args).toContain("stored-token");
  });
});

describe("model discovery", () => {
  test("fetches, augments, sorts, and reuses the 24-hour cache", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests += 1;
        expect(request.headers.get("authorization")).toBe("Bearer provider-token");
        return Response.json({
          data: [
            { id: "z-local", owned_by: "test" },
            { id: "gpt-5.6-sol", owned_by: "openai" },
          ],
        });
      },
    });
    servers.push(server);
    const cacheDirectory = await temporaryDirectory();
    const config = {
      id: "fixture",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      auth: new StaticAuth("provider-token"),
    };

    const first = await discoverModels(config, { cacheDirectory });
    const second = await discoverModels(config, { cacheDirectory });

    expect(requests).toBe(1);
    expect(second).toEqual(first);
    expect(first.map((model) => model.id)).toEqual(["gpt-5.6-sol", "z-local"]);
    expect(first[0]).toMatchObject({
      contextWindow: 1_050_000,
      inputPricePerMillion: 5,
      outputPricePerMillion: 30,
    });
  });

  test("augments an unlisted variant from its most specific known family", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ data: [{ id: "gpt-5.6-luna-x", owned_by: "openai" }] }),
    });
    servers.push(server);

    const models = await discoverModels(
      { id: "longest-prefix", baseUrl: `http://127.0.0.1:${server.port}/v1` },
      { cacheDirectory: await temporaryDirectory() },
    );

    // gpt-5.6 also prefixes this id, but luna pricing is 25x cheaper.
    expect(models[0]).toMatchObject({
      id: "gpt-5.6-luna-x",
      inputPricePerMillion: 0.2,
      outputPricePerMillion: 1.2,
    });
  });

  test("routes reasoning-class ids to max_completion_tokens", () => {
    for (const id of ["gpt-5.6-luna", "gpt-5", "o1-mini", "o3", "openai/gpt-5.4"]) {
      expect(usesMaxCompletionTokens(id)).toBe(true);
    }
    for (const id of ["gpt-4.1", "claude-opus-5", "local-llama", "o1x-custom"]) {
      expect(usesMaxCompletionTokens(id)).toBe(false);
    }
  });

  test("a missing models endpoint uses manual declarations", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("missing", { status: 404 }) });
    servers.push(server);

    const models = await discoverModels(
      { id: "manual", baseUrl: `http://127.0.0.1:${server.port}/v1` },
      { cacheDirectory: await temporaryDirectory(), manual: [{ id: "manual-model", contextWindow: 8_192 }] },
    );

    expect(models).toEqual([{ id: "manual-model", contextWindow: 8_192 }]);
  });
});

describe("auth plugins", () => {
  test("loads the one-function contract and caches until invalidated", async () => {
    const root = await temporaryDirectory();
    const pluginDirectory = join(root, "fixture-auth");
    await mkdir(pluginDirectory, { recursive: true });
    await Bun.write(join(pluginDirectory, "index.ts"), `
let calls = 0;
export default {
  id: "fixture-auth",
  async getToken() { calls += 1; return { token: "token-" + calls }; }
};
`);
    const auth = new PluginAuth("fixture-auth", root);

    expect((await auth.getToken()).token).toBe("token-1");
    expect((await auth.getToken()).token).toBe("token-1");
    auth.invalidate();
    expect((await auth.getToken()).token).toBe("token-2");
  });

  test("rejects plugin identifiers that can traverse directories", () => {
    expect(() => new PluginAuth("../outside", "/tmp/plugins")).toThrow("plugin id");
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "lyra-provider-"));
  temporaryPaths.push(path);
  return path;
}
