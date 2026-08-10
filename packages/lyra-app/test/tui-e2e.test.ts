import { ReliableProvider, type ProviderTransport, type TransportEvent } from "@lyra/provider";
import { ProtocolValidator } from "@lyra/acp";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LyraRuntime } from "../src/index.ts";

/**
 * The one test that runs the real two-process shape: the daemon on one side of a
 * pipe pair and the *release* `lyra-tui` binary on the other, exactly as
 * interactive `lyra` wires them.
 *
 * It deliberately proves only the seam. The TUI's own suite covers rendering,
 * input, and the pty; what cannot be tested from inside either process alone is
 * whether the two agree about the pipe — that the client speaks first with
 * `initialize`, that a real turn's canonical frames reach it, and that closing
 * its stdin is a clean exit rather than a hang or a non-zero code.
 *
 * `--headless` is what makes this runnable in CI: the binary refuses to write
 * escape sequences into a JSON-RPC stream, so without a tty it would otherwise
 * fail to start. Headless keeps stdin/stdout as the ACP pipe and renders into
 * memory instead of `/dev/tty`.
 */

const TUI_BINARY = resolve(import.meta.dir, "..", "..", "..", "target", "release", process.platform === "win32" ? "lyra-tui.exe" : "lyra-tui");
const HAVE_BINARY = existsSync(TUI_BINARY);
const validator = new ProtocolValidator();

async function git(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "Lyra", GIT_AUTHOR_EMAIL: "lyra@test", GIT_COMMITTER_NAME: "Lyra", GIT_COMMITTER_EMAIL: "lyra@test" }, stdout: "ignore", stderr: "pipe" });
  const error = new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(await error);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lyra-tui-e2e-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await writeFile(join(root, ".gitignore"), ".lyra/\n");
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "base"]);
  return root;
}

function environment(transport: ProviderTransport) {
  return {
    provider: new ReliableProvider(transport, { streamStallTimeoutMs: 10_000 }),
    providerName: "fixture",
    model: "fixture-model",
    config: {
      providers: { fixture: { base_url: "http://fixture.invalid/v1", api_type: "openai_completions" as const, auth: { type: "none" as const }, models: ["fixture-model"] } },
      roles: { default: "fixture/fixture-model" },
    },
  };
}

function textTransport(text: string): ProviderTransport {
  return {
    id: "scripted",
    apiType: "openai_completions",
    async *stream(): AsyncGenerator<TransportEvent> {
      yield { type: "text_delta", text };
      yield { type: "complete", stopReason: "end_turn" };
    },
  };
}

describe.skipIf(!HAVE_BINARY)("daemon ⇄ lyra-tui over pipes", () => {
  test("the release binary handshakes, receives a real turn as canonical frames, and exits cleanly on EOF", async () => {
    const root = await fixture();
    const runtime = await LyraRuntime.create({ origin: root, session: "tui-e2e", environment: environment(textTransport("hello from the daemon")), home: join(root, "home") });

    // stderr is captured rather than inherited so a panic becomes a test message.
    const child = Bun.spawn([TUI_BINARY, "--headless"], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const stderr = new Response(child.stderr).text();

    // Everything the daemon writes to the child, so the seam can be asserted on.
    const written: Array<Record<string, unknown>> = [];
    let ended = false;
    const endInput = (): void => { if (ended) return; ended = true; try { child.stdin.end(); } catch { /* already gone */ } };

    const served = runtime.app.acp.serve(child.stdout, {
      write: (data) => {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        for (const line of text.split("\n").filter(Boolean)) written.push(JSON.parse(line) as Record<string, unknown>);
        if (ended) return;
        child.stdin.write(text);
        void child.stdin.flush();
      },
    });

    try {
      // 1. The client speaks first. `initialize` is answered before anything else
      //    goes out, which is what the Rust side blocks on for up to ten seconds.
      const initialize = await waitFor(() => written.find((message) => "result" in message && isRecord(message.result) && "protocolVersion" in message.result));
      validator.assert(initialize.result, "#/$defs/requests/initialize/result", "initialize result");

      // 2. A real turn. The daemon drives it; every frame it produces crosses the pipe.
      const session = await runtime.session.newSession("tui-e2e-second") as { sessionId: string };
      expect(typeof session.sessionId).toBe("string");
      const result = await runtime.prompt("say hello");
      expect(result.stopReason).toBe("end_turn");
      await Bun.sleep(50);

      const frames = written.filter((message) => message.method === "session/update");
      expect(frames.length).toBeGreaterThan(3);
      for (const frame of frames) validator.assertNotification(frame);
      const tags = frames.map((frame) => (frame.params as { update: { sessionUpdate: string } }).update.sessionUpdate);
      // `session/new` announced the swap before the turn opened.
      expect(tags[0]).toBe("session_changed");
      // …and it is the *only* one. The TUI bootstraps with `session/snapshot`,
      // which attaches to whatever the daemon already has open; a `session/new`
      // at startup would show up here as a second swap and would silently
      // discard the session `lyra --session NAME` asked for.
      expect(tags.filter((tag) => tag === "session_changed")).toHaveLength(1);
      expect(tags.slice(tags.indexOf("turn_start"))).toContain("delta");
      expect(tags.at(-1)).toBe("turn_end");
      // Nothing else is on this wire: no `{event}`, no `{stats}`, no `{report}`.
      expect(frames.every((frame) => isRecord(frame.params) && "update" in frame.params)).toBe(true);

      // 3. EOF is a clean disconnect, not a crash and not a hang. Closing the
      //    child's stdin ends its reader; it exits, which closes its stdout and
      //    lets `serve()` return — the same two-directional shutdown cli.ts uses.
      endInput();
      const code = await child.exited;
      expect(code, `lyra-tui exited ${code}: ${await stderr}`).toBe(0);
      await served;
    } finally {
      endInput();
      child.kill();
      await child.exited;
      await served.catch(() => undefined);
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Polls until `probe` returns something, so the test waits on the child rather than a sleep. */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the TUI to speak");
    await Bun.sleep(20);
  }
}
