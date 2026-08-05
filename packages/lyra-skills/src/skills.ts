import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ToolDefinition } from "@lyra/provider";
import type { ToolExecutionContext, ToolExecutionResult } from "@lyra/core";

export type SkillOrigin = "project" | "user" | "bundled";
export interface SkillRecord { name: string; description: string; origin: SkillOrigin; path: string; }
export interface SkillDiscoveryOptions { workspace: string; home?: string; projectRoot?: string; userRoot?: string; bundledRoot?: string; }
export interface SkillDiscoveryIssue { root: string; detail: string; }

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export class SkillError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.name = "SkillError"; this.code = code; } }

export class SkillRegistry {
  readonly options: Required<Pick<SkillDiscoveryOptions, "workspace" | "home" | "projectRoot" | "userRoot" | "bundledRoot">>;
  readonly issues: SkillDiscoveryIssue[] = [];
  #skills = new Map<string, SkillRecord>();
  #discovered = false;
  constructor(options: SkillDiscoveryOptions) {
    if (!options || typeof options.workspace !== "string" || options.workspace.length === 0) throw new TypeError("Skill workspace is required.");
    const workspace = resolve(options.workspace);
    const home = resolve(options.home ?? homedir());
    this.options = { workspace, home, projectRoot: resolve(options.projectRoot ?? join(workspace, ".lyra", "skills")), userRoot: resolve(options.userRoot ?? join(home, ".lyra", "skills")), bundledRoot: resolve(options.bundledRoot ?? fileURLToPath(new URL("../bundled", import.meta.url))) };
  }
  async discover(): Promise<readonly SkillRecord[]> {
    if (this.#discovered) return this.list();
    this.#discovered = true;
    for (const [origin, root] of [["bundled", this.options.bundledRoot], ["user", this.options.userRoot], ["project", this.options.projectRoot]] as const) await this.scan(root, origin);
    return this.list();
  }
  list(): readonly SkillRecord[] { return [...this.#skills.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  index(): string { return this.list().map((skill) => `${skill.name} — ${skill.description}`).join("\n"); }
  async load(name: string): Promise<{ record: SkillRecord; body: string }> {
    await this.discover();
    validateName(name);
    const record = this.#skills.get(name);
    if (!record) throw new SkillError("not_found", `Skill ${name} is not installed. Available: ${this.list().map((skill) => skill.name).join(", ") || "none"}.`);
    const root = record.origin === "project" ? this.options.projectRoot : record.origin === "user" ? this.options.userRoot : this.options.bundledRoot;
    const [canonicalRoot, current] = await Promise.all([
      realpath(root).catch(() => root),
      realpath(record.path).catch((error) => { throw new SkillError("unreadable", `Skill ${name} disappeared: ${message(error)}.`); }),
    ]);
    if (!within(canonicalRoot, current)) throw new SkillError("path_escape", `Skill ${name} resolves outside its ${record.origin} skill root; refusing to load it.`);
    const raw = await readFile(current, "utf8");
    const parsed = parseSkill(raw, current);
    if (parsed.name !== name) throw new SkillError("changed", `Skill ${name} metadata changed after discovery; rediscover before loading.`);
    return { record: { ...record, path: current }, body: parsed.body };
  }
  private async scan(root: string, origin: SkillOrigin): Promise<void> {
    const canonicalRoot = await realpath(root).catch(() => undefined);
    if (!canonicalRoot) return;
    let entries;
    try { entries = await readdir(canonicalRoot, { withFileTypes: true }); }
    catch (error) { this.issues.push({ root, detail: message(error) }); return; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
      const skillPath = join(canonicalRoot, entry.name, "SKILL.md");
      try {
        const target = await realpath(skillPath);
        if (!within(canonicalRoot, target)) { this.issues.push({ root: skillPath, detail: "symlink resolves outside skill root" }); continue; }
        const parsed = parseSkill(await readFile(target, "utf8"), target);
        if (parsed.name !== entry.name) throw new SkillError("metadata", `directory ${entry.name} and frontmatter name differ`);
        this.#skills.set(parsed.name, { name: parsed.name, description: parsed.description, origin, path: target });
      } catch (error) { this.issues.push({ root: skillPath, detail: message(error) }); }
    }
  }
}

export const SKILL_DEFINITION: ToolDefinition = Object.freeze({ name: "skill", description: "Load one discovered skill's full instructions only when needed.", inputSchema: Object.freeze({ type: "object", additionalProperties: false, properties: { name: { type: "string", pattern: NAME.source } }, required: ["name"] }) });
export class SkillTool {
  readonly definition = SKILL_DEFINITION;
  constructor(private readonly registry: SkillRegistry) {}
  async execute(input: unknown, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      if (!input || typeof input !== "object" || !("name" in input) || typeof input.name !== "string") return { content: "skill requires a discovered skill name.", isError: true };
      const result = await this.registry.load(input.name);
      return { content: `# ${result.record.name}\n\n${result.body}` };
    } catch (error) {
      return { content: `Skill load failed: ${message(error)} Check the discovered skill index and retry.`, isError: true };
    }
  }
}

function parseSkill(raw: string, path: string): { name: string; description: string; body: string } {
  const match = FRONTMATTER.exec(raw);
  if (!match) throw new SkillError("frontmatter", `Skill ${path} must start with YAML frontmatter.`);
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/u)) { const separator = line.indexOf(":"); if (separator <= 0) throw new SkillError("frontmatter", `Skill ${path} has malformed frontmatter.`); const key = line.slice(0, separator).trim(); const value = line.slice(separator + 1).trim(); if (key === "alwaysApply") throw new SkillError("frontmatter", `Skill ${path} uses forbidden alwaysApply; skills are lazy.`); fields.set(key, value.replace(/^['"]|['"]$/g, "")); }
  const name = fields.get("name"); const description = fields.get("description");
  if (!name || !NAME.test(name)) throw new SkillError("frontmatter", `Skill ${path} needs a valid name.`);
  if (!description || description.length === 0 || description.includes("\n")) throw new SkillError("frontmatter", `Skill ${path} needs a one-line description.`);
  return { name, description, body: match[2]!.trim() };
}
function validateName(value: string): void { if (!NAME.test(value)) throw new SkillError("invalid_name", `Skill name ${JSON.stringify(value)} is invalid.`); }
function within(root: string, child: string): boolean { const parent = resolve(root); const target = resolve(child); return target === parent || target.startsWith(`${parent}/`); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fileURLToPath(url: URL): string { return new URL(url).pathname; }
