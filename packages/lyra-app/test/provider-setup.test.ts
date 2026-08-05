import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProviderConfig } from "@lyra/provider";
import { loadConfig } from "../src/config.ts";
import { ProviderSetupWizard, needsProviderSetup, providerConfigPaths, saveProviderSetup } from "../src/provider-setup.ts";

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

async function temporaryRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "lyra-setup-")); roots.push(root); return root; }
