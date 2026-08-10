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
Directory: /project/.lyra/workspaces/purple-falcon
Project: /project
Session: swift-tide-4f2a
State: .lyra/ holds Lyra's own state — do not read or edit it. Every state-changing tool call is checkpointed there; git op:"list"/"diff"/"restore" inspects and rewinds.

## Tools
read     — files, directories, URLs, images

## Skills
review   — adversarial implementer/reviewer split
`);
    expect(prompt).not.toContain("branch");
    expect(prompt).not.toContain("token");
  });

  // The main session runs in the project directory, so naming it twice under two headings
  // invented a second location and models went looking for it.
  test("a session working in the project itself is given one path, not two", () => {
    const prompt = buildSystemPrompt({
      os: "darwin", arch: "arm64", workspace: "/project", origin: "/project", session: "s",
      tools: [{ name: "read", description: "files" }], skills: [],
    });
    expect(prompt).toContain("Directory: /project\n");
    expect(prompt).not.toContain("Project:");
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
