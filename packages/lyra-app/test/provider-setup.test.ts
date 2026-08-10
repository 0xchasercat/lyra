import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadProviderConfig } from "@lyra/provider";
import { loadConfig } from "../src/config.ts";
import { ProviderSetupWizard, needsProviderSetup, providerAddInput, providerConfigPaths, providerSetupText, removeProviderCredential, removeProviderSetup, saveProviderSetup } from "../src/provider-setup.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("first-run wizard configures a local provider with keyboard defaults", () => {
  const wizard = new ProviderSetupWizard();
  wizard.submit("4");
  wizard.submit("");
  wizard.submit("");
  wizard.submit("qwen2.5-coder:14b");
  expect(wizard.complete).toBe(true);
  expect(wizard.result()).toEqual({ provider: "local", baseUrl: "http://localhost:11434/v1", apiType: "openai_completions", model: "qwen2.5-coder:14b", auth: { type: "none" } });
});

test("first-run wizard exposes labeled choices and accurate progress", () => {
  const wizard = new ProviderSetupWizard();
  expect(wizard.progress()).toEqual({ current: 1, total: 5 });
  expect(wizard.current().options?.map((option) => option.label)).toEqual(["OpenAI", "Anthropic", "OpenAI-compatible", "Local"]);
  wizard.submit("4");
  expect(wizard.progress()).toEqual({ current: 2, total: 5 });
  expect(wizard.current()).toMatchObject({ title: "Provider id", defaultValue: "local" });
});

test("setup persists keychain references and roles without writing the token", async () => {
  const home = await temporaryRoot();
  const origin = await temporaryRoot();
  const stored: unknown[] = [];
  const saved = await saveProviderSetup({ provider: "openai", baseUrl: "https://api.openai.com/v1", apiType: "openai_responses", websocket: "auto", model: "gpt-5.6", fastModel: "gpt-5.6-luna", mergeModel: "gpt-5.6", auth: { type: "keychain", token: "secret-token", service: "dev.lyra.openai", account: "operator" } }, { home, storeKeychain: async (...args) => { stored.push(args); } });
  const text = await readFile(saved.path, "utf8");
  expect(text).toContain('type = "keychain"');
  expect(text).not.toContain("secret-token");
  expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
  expect(stored).toHaveLength(1);
  const provider = await loadProviderConfig(providerConfigPaths(origin, home));
  expect(provider.roles).toMatchObject({ default: "openai/gpt-5.6", fast: "openai/gpt-5.6-luna", merge: "openai/gpt-5.6" });
  expect((await loadConfig(origin, home)).roles.default).toBe("openai/gpt-5.6");
  expect(await needsProviderSetup(origin, undefined, home)).toBe(false);
});

test("explicit plaintext setup remains available and is confined to the protected provider file", async () => {
  const home = await temporaryRoot();
  const origin = await temporaryRoot();
  const saved = await saveProviderSetup({ provider: "gateway", baseUrl: "https://gateway.example/v1", apiType: "openai_completions", model: "coder", auth: { type: "static", token: "explicit-secret" } }, { home });
  expect(await readFile(saved.path, "utf8")).toContain('auth = { type = "static", token = "explicit-secret" }');
  const provider = await loadProviderConfig(providerConfigPaths(origin, home));
  expect(provider.providers.gateway?.auth).toEqual({ type: "static", token: "explicit-secret" });
});

/**
 * Adding a provider used to render a fresh file from the one definition in hand, so the
 * second provider a user added deleted the first — including, in the session this was found
 * in, the provider Lyra was running on at the time.
 */
test("adding a provider keeps every other provider, role, and section already in the file", async () => {
  const home = await temporaryRoot();
  const origin = await temporaryRoot();
  const path = providerConfigPaths(origin, home)[1]!;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [
    "# hand written",
    "[providers.a6api]",
    'base_url = "https://a6.example/v1"',
    'api_type = "openai_completions"',
    'auth = { type = "env", var = "A6_API_KEY" }',
    'models = ["gpt-5.6-sol"]',
    "",
    "[roles]",
    'default = "a6api/gpt-5.6-sol"',
    'fast = "a6api/gpt-5.6-sol"',
    "",
    "[tui]",
    'theme = "paper"',
    "",
  ].join("\n"));

  const stored: unknown[] = [];
  const saved = await saveProviderSetup(
    { provider: "claude-code", baseUrl: "https://api.anthropic.com", apiType: "anthropic_messages", model: "claude-opus-5", auth: { type: "keychain", token: "secret-token", account: "operator" } },
    { home, storeKeychain: async (...args) => { stored.push(args); } },
  );
  expect(saved.preserved).toEqual(["a6api"]);
  // Formatting is what the round trip costs, and the caller is told rather than left to
  // notice; content is what it must never cost.
  expect(saved.warnings?.[0]).toContain("Comments");

  const config = await loadProviderConfig(providerConfigPaths(origin, home));
  expect(Object.keys(config.providers).sort()).toEqual(["a6api", "claude-code"]);
  expect(config.providers.a6api).toMatchObject({ base_url: "https://a6.example/v1", auth: { type: "env", var: "A6_API_KEY" }, models: ["gpt-5.6-sol"] });
  // The added provider takes the roles, which is what the user asked for by adding it; a
  // role the file had and this one does not name survives untouched.
  expect(config.roles).toMatchObject({ default: "claude-code/claude-opus-5", fast: "claude-code/claude-opus-5", merge: "claude-code/claude-opus-5" });
  // Sections that are nothing to do with providers are still there.
  expect((await loadConfig(origin, home)).tui.theme).toBe("paper");
  // The credential went to the keychain and the file holds only a reference to it.
  expect(stored).toHaveLength(1);
  const text = await readFile(path, "utf8");
  expect(text).not.toContain("secret-token");
  expect(text).toContain('auth = { type = "keychain", service = "dev.lyra.provider.claude-code", account = "operator" }');
  // Re-adding the same provider is idempotent rather than accumulative.
  await saveProviderSetup({ provider: "claude-code", baseUrl: "https://api.anthropic.com", apiType: "anthropic_messages", model: "claude-opus-5", auth: { type: "keychain", token: "secret-token", account: "operator" } }, { home, storeKeychain: async () => undefined });
  expect(await readFile(path, "utf8")).toBe(text);
});

test("a model-less add leaves the roles untouched and reports no model", async () => {
  const home = await temporaryRoot();
  const origin = await temporaryRoot();
  const path = providerConfigPaths(origin, home)[1]!;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [
    "[providers.a6api]",
    'base_url = "https://a6.example/v1"',
    'api_type = "openai_completions"',
    'auth = { type = "env", var = "A6_API_KEY" }',
    "",
    "[roles]",
    'default = "a6api/gpt-5.6-sol"',
    'fast = "a6api/gpt-5.6-sol"',
    "",
  ].join("\n"));

  const saved = await saveProviderSetup(
    { provider: "claude-code", baseUrl: "https://api.anthropic.com", apiType: "anthropic_messages", auth: { type: "keychain", token: "secret-token", account: "operator" } },
    { home, storeKeychain: async () => undefined },
  );
  // Adding never switches: no model was chosen, so nothing about what runs next moved.
  expect(saved.model).toBeUndefined();

  const config = await loadProviderConfig(providerConfigPaths(origin, home));
  expect(Object.keys(config.providers).sort()).toEqual(["a6api", "claude-code"]);
  expect(config.roles).toMatchObject({ default: "a6api/gpt-5.6-sol", fast: "a6api/gpt-5.6-sol" });
  // No declared models either — /model discovers, /model add declares.
  expect(config.providers["claude-code"]?.models ?? []).toEqual([]);
});

test("a providers.toml that cannot be parsed is reported, never rewritten", async () => {
  const home = await temporaryRoot();
  const origin = await temporaryRoot();
  const path = providerConfigPaths(origin, home)[1]!;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "[providers.broken\nbase_url = \n");
  await expect(saveProviderSetup({ provider: "openai", baseUrl: "https://api.openai.com/v1", apiType: "openai_responses", model: "gpt-5.6", auth: { type: "none" } }, { home }))
    .rejects.toThrow(/is not valid TOML/);
  // Refusing means refusing: the unreadable file is exactly as the user left it.
  expect(await readFile(path, "utf8")).toBe("[providers.broken\nbase_url = \n");
});

test("the first-run instructions print a providers.toml Lyra actually accepts", async () => {
  const home = await temporaryRoot();
  const origin = await temporaryRoot();
  const paths = providerConfigPaths(origin, home);
  const text = providerSetupText(origin, home);
  expect(text).toContain(paths[1]!);
  // The example is copied verbatim by a first-time user, so it is parsed here as
  // the config file it claims to be rather than merely pattern-matched.
  const block = text.split("2. Or declare one in")[1]!.split("\nThen run")[0]!;
  const example = block.split("\n").slice(1).map((line) => line.replace(/^ {7}/, "")).join("\n");
  expect(example).toContain("[providers.openai]");
  await mkdir(dirname(paths[1]!), { recursive: true });
  await writeFile(paths[1]!, `${example}\n`);
  const config = await loadProviderConfig(paths);
  expect(config.providers.openai?.auth).toEqual({ type: "env", var: "OPENAI_API_KEY" });
  expect(config.roles.default).toBe("openai/gpt-5.6");
  expect(await needsProviderSetup(origin, undefined, home)).toBe(false);
});

/**
 * The base URL is stored the way Lyra will use it, not the way it was typed. Anything else is
 * how a provider ends up detected at one path shape and requested at another — which is the
 * 404 with an empty body this whole convention exists to prevent.
 */
test("a provider is saved with its base URL in canonical form", async () => {
  const home = await temporaryRoot();
  const origin = await temporaryRoot();
  for (const [typed, stored] of [
    ["https://api.anthropic.com", "https://api.anthropic.com/v1"],
    ["https://gateway.example/v1/", "https://gateway.example/v1"],
    // Pasted from a docs page, route and all.
    ["https://gateway.example/v1/chat/completions", "https://gateway.example/v1"],
    // A gateway's own versioned prefix is left exactly as it is.
    ["https://host/api/v1", "https://host/api/v1"],
  ] as const) {
    const saved = await saveProviderSetup({ provider: "gateway", baseUrl: typed, apiType: "openai_completions", auth: { type: "none" } }, { home });
    expect(`${typed} → ${saved.baseUrl}`).toBe(`${typed} → ${stored}`);
    const config = await loadProviderConfig(providerConfigPaths(origin, home));
    expect(config.providers.gateway?.base_url).toBe(stored);
  }
});

describe("editing a provider", () => {
  /**
   * The edit case: a form whose key field was left empty means "leave the key alone", and the
   * daemon has no way to re-derive a keychain reference or a plaintext token from an empty
   * field. `keep` carries the block across rather than writing `none` over it, which would
   * turn "change the base URL" into "delete the credential".
   */
  test("persist keep rewrites everything but the auth block, which survives byte for byte", async () => {
    const home = await temporaryRoot();
    const origin = await temporaryRoot();
    const path = providerConfigPaths(origin, home)[1]!;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, [
      "[providers.gateway]",
      'base_url = "https://old.example"',
      'api_type = "openai_completions"',
      'auth = { type = "keychain", service = "dev.lyra.provider.gateway", account = "operator" }',
      'models = ["coder"]',
      "",
      "[roles]",
      'default = "gateway/coder"',
      "",
    ].join("\n"));
    const authLine = 'auth = { type = "keychain", service = "dev.lyra.provider.gateway", account = "operator" }';

    const { input, warnings } = providerAddInput({ provider: "gateway", baseUrl: "https://new.example/v1", apiType: "openai_responses", persist: "keep" });
    expect(warnings).toEqual([]);
    const stored: unknown[] = [];
    const saved = await saveProviderSetup(input, { home, storeKeychain: async (...args) => { stored.push(args); } });

    // The credential was never touched: not re-stored, not re-read, not rewritten.
    expect(stored).toHaveLength(0);
    expect(saved.auth).toBe("keychain");
    const text = await readFile(path, "utf8");
    expect(text).toContain(authLine);
    // And the rest of the form did land.
    expect(text).toContain('base_url = "https://new.example/v1"');
    expect(text).toContain('api_type = "openai_responses"');
    // Adding never switches, so the role still names what the user chose.
    expect((await loadProviderConfig(providerConfigPaths(origin, home))).roles.default).toBe("gateway/coder");
  });

  /**
   * The edit form has rows for the base URL, the protocol and the credential, and none for
   * the model list — so an update built from the form alone would delete every model the
   * provider declared, including the ids `/model add` exists to register for endpoints that
   * cannot list their own. Editing a provider is not re-creating it.
   */
  test("an update replaces the fields it carries and preserves every field it does not", async () => {
    const home = await temporaryRoot();
    const origin = await temporaryRoot();
    const path = providerConfigPaths(origin, home)[1]!;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, [
      "[providers.gateway]",
      'base_url = "https://old.example"',
      'api_type = "openai_completions"',
      'websocket = "off"',
      'auth = { type = "env", var = "GATEWAY_API_KEY" }',
      // One declared at setup, one registered later through `/model add`.
      'models = ["coder", "internal-coder-v3"]',
      "",
      "[roles]",
      'default = "gateway/coder"',
      "",
    ].join("\n"));
    const before = await loadProviderConfig(providerConfigPaths(origin, home));

    // Exactly what the Rust client's edit form sends: the three fields it has, and no more.
    const { input } = providerAddInput({ provider: "gateway", baseUrl: "https://new.example/v1", apiType: "openai_responses", persist: "keep" });
    await saveProviderSetup(input, { home });

    const after = await loadProviderConfig(providerConfigPaths(origin, home));
    // Changed: exactly the two fields the form carried.
    expect(after.providers.gateway).toMatchObject({ base_url: "https://new.example/v1", api_type: "openai_responses" });
    // Untouched: the model list, the websocket preference, the credential, the roles.
    expect(after.providers.gateway?.models).toEqual(before.providers.gateway!.models!);
    expect(after.providers.gateway?.websocket).toBe("off");
    expect(after.providers.gateway?.auth).toEqual({ type: "env", var: "GATEWAY_API_KEY" });
    expect(after.roles).toEqual(before.roles);
    const text = await readFile(path, "utf8");
    expect(text).toContain('models = ["coder", "internal-coder-v3"]');
    expect(text).toContain('auth = { type = "env", var = "GATEWAY_API_KEY" }');

    // An update that *does* carry a model adds it, rather than replacing the list with it.
    await saveProviderSetup({ provider: "gateway", baseUrl: "https://new.example/v1", apiType: "openai_responses", model: "coder-next", auth: { type: "keep" } }, { home });
    const withModel = await loadProviderConfig(providerConfigPaths(origin, home));
    expect(withModel.providers.gateway?.models).toEqual(["coder", "internal-coder-v3", "coder-next"]);
    // Carrying a model is still what moves the roles, unchanged from the add path.
    expect(withModel.roles.default).toBe("gateway/coder-next");
  });

  test("keep refuses a provider that does not exist, and any credential sent alongside it", async () => {
    const home = await temporaryRoot();
    await expect(saveProviderSetup({ provider: "ghost", baseUrl: "https://host/v1", apiType: "openai_completions", auth: { type: "keep" } }, { home }))
      .rejects.toThrow(/Cannot keep the existing credential for "ghost"/);
    // Sending both is a contradiction, and picking a winner silently would make which one
    // wins a property of this function rather than of the request.
    expect(() => providerAddInput({ provider: "gateway", baseUrl: "https://host/v1", apiType: "openai_completions", persist: "keep", apiKey: "sk-new" })).toThrow(/must not carry an apiKey/);
    expect(() => providerAddInput({ provider: "gateway", baseUrl: "https://host/v1", apiType: "openai_completions", persist: "keep", authEnvVar: "GATEWAY_KEY" })).toThrow(/must not carry an authEnvVar/);
  });
});

describe("removing a provider", () => {
  async function seeded(): Promise<{ home: string; origin: string; path: string }> {
    const home = await temporaryRoot();
    const origin = await temporaryRoot();
    const path = providerConfigPaths(origin, home)[1]!;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, [
      "# hand written",
      "[providers.a6api]",
      'base_url = "https://a6.example/v1"',
      'api_type = "openai_completions"',
      'auth = { type = "env", var = "A6_API_KEY" }',
      'models = ["gpt-5.6-sol"]',
      "",
      "[providers.gateway]",
      'base_url = "https://gateway.example/v1"',
      'api_type = "openai_completions"',
      'auth = { type = "keychain", service = "dev.lyra.provider.gateway", account = "operator" }',
      "",
      "[roles]",
      'default = "gateway/coder"',
      'fast = "a6api/gpt-5.6-sol"',
      'merge = "gateway/coder"',
      "",
      "[tui]",
      'theme = "paper"',
      "",
    ].join("\n"));
    return { home, origin, path };
  }

  test("takes one provider out and leaves every other provider, role, and section standing", async () => {
    const { home, origin, path } = await seeded();
    const removed = await removeProviderSetup("gateway", { home });
    expect(removed.preserved).toEqual(["a6api"]);
    // The roles that named it are reported, never rewritten: @default is the user's statement
    // about what they want, and repointing it at a provider they did not choose is a bigger
    // surprise than a role that visibly dangles.
    expect(removed.danglingRoles).toEqual(["default", "merge"]);
    expect(removed.warnings?.[0]).toContain("Comments");

    const config = await loadProviderConfig(providerConfigPaths(origin, home));
    expect(Object.keys(config.providers)).toEqual(["a6api"]);
    expect(config.roles).toMatchObject({ default: "gateway/coder", fast: "a6api/gpt-5.6-sol", merge: "gateway/coder" });
    expect((await loadConfig(origin, home)).tui.theme).toBe("paper");
    expect(await readFile(path, "utf8")).not.toContain("gateway.example");
  });

  test("names the file and what is in it when there is nothing to remove", async () => {
    const { home, path } = await seeded();
    await expect(removeProviderSetup("ghost", { home })).rejects.toThrow(new RegExp(`\\[providers.ghost\\] is not declared in ${path.replace(/[/.]/g, "\\$&")}`));
    // A refusal changes nothing.
    expect(await readFile(path, "utf8")).toContain("[providers.gateway]");
  });

  test("the stored credential goes only when asked, and only when there is one to go", async () => {
    const { home } = await seeded();
    const removed = await removeProviderSetup("gateway", { home });
    const deleted: unknown[] = [];

    // Not asked: the keychain is not touched at all.
    expect(await removeProviderCredential(removed.auth, {})).toBe(false);

    // Asked, and there was one.
    expect(await removeProviderCredential(removed.auth, { deleteKeychain: async (credential) => { deleted.push(credential); return true; } })).toBe(true);
    expect(deleted).toEqual([{ service: "dev.lyra.provider.gateway", account: "operator" }]);

    // Asked, and there was not: false is the honest answer, not a failure — the end state
    // asked for is the end state reached.
    expect(await removeProviderCredential(removed.auth, { deleteKeychain: async () => false })).toBe(false);

    // An env-var provider owns nothing Lyra may delete: the variable is the user's.
    const envRemoved = await removeProviderSetup("a6api", { home });
    expect(await removeProviderCredential(envRemoved.auth, { deleteKeychain: async () => { throw new Error("must not be called"); } })).toBe(false);
  });
});

async function temporaryRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "lyra-setup-")); roots.push(root); return root; }
