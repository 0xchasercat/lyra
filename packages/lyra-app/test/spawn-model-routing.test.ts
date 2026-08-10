import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpawnManager, SpawnResolutionError } from "@lyra/core";
import { ToolRegistry } from "@lyra/tools";
import type { ProviderFileConfig } from "@lyra/provider";
import { assertModelReferenceUsable, ModelReferenceError } from "../src/provider.ts";
import { SpawnTool } from "../src/integrated-tools.ts";

/**
 * Model routing on the spawn path, against the session that broke it.
 *
 * The observed call was `spawn { model: "claude-max/opus-5", label: "stylist", ... }` against
 * a configured, authenticated `claude-max` whose models are all spelled `claude-…`. It
 * answered `status: running` with a live handle, and the reason surfaced minutes later,
 * through the bus, as `Spawn spawn-1 failed: model: opus-5` — no provider prefix, no statement
 * of what was wrong, and a dead child holding the name the retry then had to work around.
 *
 * Everything here is that call: rejected where it was made, in words that name which of the
 * three things went wrong, with the provider's own models beside it.
 */

const roots: string[] = [];
const managers: SpawnManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The configuration as the session had it: claude-max declaring the family, openai unusable. */
function configuration(overrides: Partial<ProviderFileConfig> = {}): ProviderFileConfig {
  return {
    providers: {
      "claude-max": {
        base_url: "https://api.anthropic.com/v1",
        api_type: "anthropic_messages",
        auth: { type: "static", token: "a-token" },
        models: ["claude-opus-5", "claude-fable-5", "claude-haiku-4-5"],
      },
      openai: {
        base_url: "https://api.openai.com/v1",
        api_type: "openai_responses",
        // Deliberately never exported: a provider that resolves and cannot produce a credential.
        auth: { type: "env", var: "LYRA_SPAWN_ROUTING_ABSENT_KEY" },
        models: ["gpt-5.6"],
      },
    },
    roles: { default: "claude-max/claude-opus-5", fast: "claude-max/claude-haiku-4-5" },
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(() => undefined, (value: unknown) => value);
  if (!(error instanceof Error)) throw new Error(`Expected a rejection, got ${String(error)}`);
  return error;
}

/** A home with a discovery cache already written, as a live session would have one. */
async function homeWithCachedModels(provider: string, models: readonly string[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "lyra-spawn-routing-"));
  roots.push(home);
  const directory = join(home, ".lyra", "providers", provider);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "models.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), models: models.map((id) => ({ id })) }));
  return home;
}

describe("a model reference names which of the three things is wrong", () => {
  test("an unknown model on a known provider lists that provider's models and suggests one", async () => {
    const error = await rejection(assertModelReferenceUsable(configuration(), "claude-max/opus-5"));
    expect(error).toBeInstanceOf(ModelReferenceError);
    expect((error as ModelReferenceError).fault).toBe("model");
    // The reference survives exactly as it was written: `model: opus-5` lost the prefix the
    // user actually typed, which is the half of the message that said which provider.
    expect(error.message).toContain('"claude-max/opus-5"');
    expect(error.message).toContain("Unknown model in");
    expect(error.message).toContain("provider claude-max is configured but does not serve");
    // The list, and the near-miss: `opus-5` is `claude-opus-5` with the family prefix dropped.
    expect(error.message).toContain("claude-max has: claude-opus-5, claude-fable-5, claude-haiku-4-5 — did you mean \"claude-opus-5\"?");
    expect(error.message).toContain("/model add");
  });

  test("an unknown provider is a different sentence with a different action", async () => {
    const error = await rejection(assertModelReferenceUsable(configuration(), "claude-code/claude-opus-5"));
    expect((error as ModelReferenceError).fault).toBe("provider");
    expect(error.message).toContain('"claude-code/claude-opus-5"');
    expect(error.message).toContain("Unknown provider in");
    expect(error.message).toContain('nothing is configured under "claude-code"');
    expect(error.message).toContain("Configured providers: claude-max, openai");
    expect(error.message).toContain("/provider add");
    // Nothing about models: the provider is the thing to fix, and listing models it does not
    // have would be advice about a provider that does not exist.
    expect(error.message).not.toContain("did you mean");
  });

  test("a known provider that cannot produce a credential is a third sentence again", async () => {
    const error = await rejection(assertModelReferenceUsable(configuration(), "openai/gpt-5.6"));
    expect((error as ModelReferenceError).fault).toBe("credential");
    expect(error.message).toContain('Provider openai cannot serve "openai/gpt-5.6"');
    expect(error.message).toContain("LYRA_SPAWN_ROUTING_ABSENT_KEY is not set");
    // The remedy is about the credential source, not about the model or the provider entry.
    expect(error.message).toContain("Export LYRA_SPAWN_ROUTING_ABSENT_KEY");
    expect(error.message).not.toContain("did you mean");
    expect(error.message).not.toContain("Unknown");
  });

  test("a usable reference passes, by id and through a role", async () => {
    await assertModelReferenceUsable(configuration(), "claude-max/claude-opus-5");
    await assertModelReferenceUsable(configuration(), "@fast");
    // A bare id belongs to the provider the caller says it is on, not to @default's.
    await assertModelReferenceUsable(configuration(), "claude-fable-5", { defaultProvider: "claude-max" });
  });

  test("a role that does not exist is its own mistake, and says which roles do", async () => {
    const error = await rejection(assertModelReferenceUsable(configuration(), "@cheap"));
    expect((error as ModelReferenceError).fault).toBe("role");
    expect(error.message).toContain('Cannot use model "@cheap"');
    expect(error.message).toContain("@default, @fast");
  });

  /**
   * A provider with no `/models` route and nothing declared can only be proven wrong by
   * asking it, so it is not second-guessed: refusing on the strength of an empty list would
   * ground every such endpoint.
   */
  test("a provider that lists nothing is not second-guessed about its models", async () => {
    const config = configuration();
    config.providers.local = { base_url: "http://localhost:8080/v1", api_type: "openai_completions", auth: { type: "none" } };
    await assertModelReferenceUsable(config, "local/whatever-it-serves");
  });

  test("discovered models count alongside declared ones, and a long list says how much it left out", async () => {
    const home = await homeWithCachedModels("claude-max", ["claude-sonnet-5", "claude-opus-4-8"]);
    // Discovered and never declared: known, so it is not refused.
    await assertModelReferenceUsable(configuration(), "claude-max/claude-sonnet-5", { home });

    const many = configuration();
    many.providers["claude-max"]!.models = Array.from({ length: 12 }, (_, index) => `model-${index}`);
    const error = await rejection(assertModelReferenceUsable(many, "claude-max/model-99"));
    expect(error.message).toContain("claude-max has: model-0, model-1, model-2, model-3, model-4, model-5, model-6, model-7 (+4 more)");
  });
});

/** The spawn manager, wired to the check the way an application wires it. */
function spawnTool(config: ProviderFileConfig, home?: string): { manager: SpawnManager; call(args: Record<string, unknown>): Promise<{ isError?: boolean; text: string; json: any }> } {
  const manager = new SpawnManager({
    defaultWorkspace: "/repo",
    validateModel: (model, signal) => assertModelReferenceUsable(config, model, {
      ...(home === undefined ? {} : { home }),
      ...(signal === undefined ? {} : { signal }),
    }),
    executor: async (request, context) => {
      // Stands in for the executor's own resolution step, for the paths that reach a child
      // anyway: the JIT runtime and ACP can spawn without going through the tool.
      if (request.model === "claude-max/opus-5") throw new SpawnResolutionError(`Spawn ${context.peer} could not start: Unknown model in "claude-max/opus-5"`);
      return `done: ${request.task}`;
    },
  });
  managers.push(manager);
  const registry = new ToolRegistry([new SpawnTool(manager)]);
  const context = { signal: new AbortController().signal, sessionId: "routing", workspace: "/repo", callId: "call-1" };
  return {
    manager,
    call: async (args) => {
      const result = await registry.execute("spawn", args, context);
      const text = String(result.content);
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return { ...(result.isError === undefined ? {} : { isError: result.isError }), text, json };
    },
  };
}

describe("the spawn tool refuses a model it cannot route", () => {
  test("the observed call is an error from the tool, not a handle to a dead child", async () => {
    const tool = spawnTool(configuration());
    const answer = await tool.call({ task: "restyle the landing page", model: "claude-max/opus-5", label: "stylist" });

    expect(answer.isError).toBe(true);
    expect(answer.json).toBeUndefined(); // Not a `{ id, peer, status }` handle in any shape.
    expect(answer.text).toContain("No child was started");
    expect(answer.text).toContain('"claude-max/opus-5"');
    expect(answer.text).toContain("provider claude-max is configured but does not serve");
    expect(answer.text).toContain("claude-max has: claude-opus-5, claude-fable-5, claude-haiku-4-5 — did you mean \"claude-opus-5\"?");
    expect(answer.text).not.toContain("running");

    // And there is nothing to collect, watch, cancel or name, because nothing was created.
    expect(tool.manager.list()).toEqual([]);
    expect(tool.manager.idForPeer("stylist")).toBeUndefined();
  });

  test("an unknown provider and an unusable one are refused in their own words", async () => {
    const tool = spawnTool(configuration());
    const provider = await tool.call({ task: "x", model: "claude-code/claude-opus-5" });
    expect(provider.isError).toBe(true);
    expect(provider.text).toContain("Unknown provider in");
    expect(provider.text).toContain("/provider add");

    const credential = await tool.call({ task: "x", model: "openai/gpt-5.6" });
    expect(credential.isError).toBe(true);
    expect(credential.text).toContain('Provider openai cannot serve "openai/gpt-5.6"');
    expect(credential.text).toContain("LYRA_SPAWN_ROUTING_ABSENT_KEY");
    expect(credential.text).not.toContain("Unknown");
    expect(tool.manager.list()).toEqual([]);
  });

  test("a model that does route starts a child as before", async () => {
    const tool = spawnTool(configuration());
    const answer = await tool.call({ task: "restyle the landing page", model: "claude-max/claude-opus-5", label: "stylist" });
    expect(answer.isError).not.toBe(true);
    expect(answer.json).toMatchObject({ id: "spawn-1", peer: "stylist", workspace: "/repo" });
  });

  /**
   * The tool is not the only way in — the JIT runtime and an ACP client both reach the
   * manager directly — so a child that gets as far as running still has to end in a state
   * that says a message would achieve nothing.
   */
  test("a child that slipped past the check still ends unrevivable, with its name freed", async () => {
    const tool = spawnTool(configuration());
    const handle = tool.manager.spawn({ task: "restyle", model: "claude-max/opus-5", label: "stylist" });
    await expect(tool.manager.wait(handle.id, 2_000)).rejects.toThrow(/could not start/);

    const collected = await tool.call({ id: handle.id });
    expect(collected.isError).toBe(true);
    expect(collected.json.next).toContain("nothing to revive");
    expect(collected.json.next).not.toContain('hub { op: "send"');
    expect(collected.json.detail).toMatchObject({ failure: "resolution", revivable: false });
    // The name the retry would otherwise have had to work around is free again.
    expect(tool.manager.idForPeer("stylist")).toBeUndefined();
  });

  test("a writeScope comes back rooted, so a mis-rooted one is visible at the spawn call", async () => {
    const tool = spawnTool(configuration());
    const answer = await tool.call({ task: "port the parser", label: "porter", writeScope: ["src/parser/**", "/etc/hosts"] });
    expect(answer.json).toMatchObject({
      writeScope: ["src/parser/**", "/etc/hosts"],
      // Relative entries are rooted at the child's tree; an absolute one is left where the
      // parent put it, because rooting it again would silently move it somewhere else.
      writeScopeResolved: ["/repo/src/parser/**", "/etc/hosts"],
    });
  });
});
