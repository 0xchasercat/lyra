import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/system-prompt.ts";

describe("buildSystemPrompt", () => {
  test("renders only stable environment facts and capability indexes", () => {
    const prompt = buildSystemPrompt({
      os: "darwin 27.0.0",
      arch: "arm64",
      workspace: "/project/.lyra/workspaces/purple-falcon",
      origin: "/project",
      session: "swift-tide-4f2a",
      tools: [{ name: "read", description: "files, directories, URLs, images" }],
      skills: [{ name: "review", description: "adversarial implementer/reviewer split" }],
    });

    expect(prompt).toBe(`# Lyra
OS: darwin 27.0.0 arm64
Workspace: /project/.lyra/workspaces/purple-falcon
Origin: /project
Session: swift-tide-4f2a

## Tools
read     — files, directories, URLs, images

## Skills
review   — adversarial implementer/reviewer split
`);
    expect(prompt).not.toContain("branch");
    expect(prompt).not.toContain("token");
  });

  test("rejects dynamic multiline descriptions", () => {
    expect(() => buildSystemPrompt({
      os: "linux",
      arch: "x64",
      workspace: "/w",
      origin: "/o",
      session: "s",
      tools: [{ name: "read", description: "first\nsecond" }],
      skills: [],
    })).toThrow("must fit on one line");
  });
});
