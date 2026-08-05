import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry, SkillTool } from "../src/index.ts";

const skill = (name: string, description: string, body: string, extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`;
const context = { signal: new AbortController().signal, sessionId: "skills", workspace: ".", callId: "skill" };

describe("lazy skills", () => {
  test("discovers bundled skills and keeps bodies out of the one-line index", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-skills-"));
    try {
      const registry = new SkillRegistry({ workspace: root, home: root });
      const records = await registry.discover();
      expect(records.map((record) => record.name)).toEqual(["adversarial-review", "draco"]);
      expect(registry.index()).toContain("adversarial-review —");
      expect(registry.index()).not.toContain("one implementation agent");
      const loaded = await registry.load("adversarial-review");
      expect(loaded.body).toContain("one implementation agent and two independent reviewer agents");
      const result = await new SkillTool(registry).execute({ name: "draco" }, context);
      expect(result.isError).not.toBe(true);
      expect(result.content.toString()).toContain("Draco");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("project overrides user, which overrides bundled", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-skills-"));
    const workspace = join(root, "project");
    const home = join(root, "home");
    const bundled = join(root, "bundled");
    try {
      for (const [base, body] of [[bundled, "bundled body"], [join(home, ".lyra", "skills"), "user body"], [join(workspace, ".lyra", "skills"), "project body"]] as const) {
        await mkdir(join(base, "override"), { recursive: true });
        await writeFile(join(base, "override", "SKILL.md"), skill("override", `${body} description`, body));
      }
      const registry = new SkillRegistry({ workspace, home, bundledRoot: bundled });
      await registry.discover();
      expect(registry.list()).toMatchObject([{ name: "override", origin: "project" }]);
      expect((await registry.load("override")).body).toBe("project body");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects alwaysApply and escaping symlink bodies without losing valid skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-skills-"));
    const projectRoot = join(root, "project-skills");
    const bundled = join(root, "empty-bundled");
    try {
      await mkdir(join(projectRoot, "valid"), { recursive: true });
      await mkdir(join(projectRoot, "eager"), { recursive: true });
      await mkdir(join(projectRoot, "escape"), { recursive: true });
      await mkdir(bundled, { recursive: true });
      await writeFile(join(projectRoot, "valid", "SKILL.md"), skill("valid", "Valid lazy instructions", "safe"));
      await writeFile(join(projectRoot, "eager", "SKILL.md"), skill("eager", "Invalid eager instructions", "unsafe", "alwaysApply: true\n"));
      const outside = join(root, "outside.md");
      await writeFile(outside, skill("escape", "Escaping instructions", "outside"));
      await symlink(outside, join(projectRoot, "escape", "SKILL.md"));
      const registry = new SkillRegistry({ workspace: root, home: join(root, "home"), projectRoot, bundledRoot: bundled });
      await registry.discover();
      expect(registry.list().map((record) => record.name)).toEqual(["valid"]);
      expect(registry.issues.map((issue) => issue.detail).join("\n")).toContain("forbidden alwaysApply");
      expect(registry.issues.map((issue) => issue.detail).join("\n")).toContain("outside skill root");
      const missing = await new SkillTool(registry).execute({ name: "missing" }, context);
      expect(missing.isError).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
