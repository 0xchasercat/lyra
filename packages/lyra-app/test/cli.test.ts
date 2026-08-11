import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

/**
 * What a failed launch prints.
 *
 * The reported crash reached the user as Bun's own uncaught-exception report: a stack trace
 * full of `$bunfs` paths from inside the compiled bundle, wrapped around one sentence that
 * actually said what was wrong. `main()` is caught now — the sentence is the whole report, and
 * the trace belongs to whoever asks for it with `LYRA_DEBUG=1`.
 *
 * The subject is the real entry point, run as a real process, because that is the only place
 * the top-level catch and the exit code exist. `--acp`, `--prompt` and interactive launches all
 * hang or need a terminal, so the failure used here is the one that happens before any of that:
 * an argument the parser refuses.
 */

const CLI = resolve(import.meta.dir, "..", "src", "cli.ts");

async function run(args: readonly string[], env: Record<string, string> = {}): Promise<{ code: number; stderr: string; stdout: string }> {
  const child = Bun.spawn(["bun", CLI, ...args], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

describe("a launch that cannot start", () => {
  test("prints one actionable line, no stack, and exits 1", async () => {
    const { code, stderr } = await run(["--nonsense"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown argument --nonsense");
    expect(stderr).toContain("--help");
    // One line about the failure, and nothing from inside the bundle.
    expect(stderr.trim().split("\n").filter((line) => line.startsWith("lyra: "))).toHaveLength(1);
    expect(stderr).not.toContain("$bunfs");
    expect(stderr).not.toMatch(/\n\s+at /);
  }, 30_000);

  test("LYRA_DEBUG=1 adds the trace the message replaced", async () => {
    const { code, stderr } = await run(["--nonsense"], { LYRA_DEBUG: "1" });
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown argument --nonsense");
    expect(stderr).toMatch(/\n\s+at /);
  }, 30_000);

  test("--help says how to ask for that trace, and is not a failure", async () => {
    const { code, stdout } = await run(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("LYRA_DEBUG=1");
  }, 30_000);
});
