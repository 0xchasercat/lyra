import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProcessCancelledError,
  ProcessHost,
  ProcessQueueTimeoutError,
  Semaphore,
  classifyCommand,
  classifyExecution,
  INLINE_WAIT_BUDGET_MS,
} from "../src/process.ts";

const hosts: ProcessHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("classed process execution", () => {
  test("classifies executable and argument boundaries", () => {
    expect(classifyCommand("cargo build")).toBe("heavy");
    expect(classifyCommand("npmx test")).toBe("light");
    expect(classifyCommand("git grep -n needle")).toBe("io");
    expect(classifyCommand("grep -R needle .")).toBe("io");
    expect(classifyCommand("grep needle one-file.txt")).toBe("light");
    expect(classifyCommand("echo 'cargo build'")).toBe("free");
    expect(classifyCommand("printf 'ok'")).toBe("free");
    const capped = new ProcessHost({ heavyLimit: 99 });
    hosts.push(capped);
    expect(capped.limits.heavy).toBe(8);
  });

  // A bounded short sleep is the model waiting on purpose — `sleep 10; git status` is a
  // poll. Classifying it heavy backgrounded the whole segment and left the model chasing a
  // handle for a result it was about to get, so only an unbounded or long sleep is a job.
  test("sleep is a job only when it is unbounded or longer than the inline budget", () => {
    expect(classifyCommand("sleep 10")).toBe("free");
    expect(classifyCommand("sleep 0.5")).toBe("free");
    expect(classifyCommand("sleep 1m 30s")).toBe("free");
    expect(classifyCommand("sleep 10; git status")).toBe("light");
    expect(classifyCommand("sleep")).toBe("heavy");
    expect(classifyCommand("sleep 3600")).toBe("heavy");
    expect(classifyCommand("sleep 2m")).toBe("heavy");
    expect(classifyCommand(`sleep ${INLINE_WAIT_BUDGET_MS / 1000}`)).toBe("heavy");
    expect(classifyCommand("sleep $DURATION")).toBe("heavy");
    // The genuinely unbounded ones are unchanged: neither ever ends on its own.
    expect(classifyCommand("yes")).toBe("heavy");
    expect(classifyCommand("tail -f app.log")).toBe("heavy");
  });

  /**
   * The semaphore class says where a command queues; the execution class says who waits.
   * A build is heavy *and* blocking: backgrounding it left the model chasing a handle for
   * output it was about to be handed.
   */
  test("classifies finite work as inline, servers as servers, and leaves the rest a job", () => {
    for (const command of [
      "npm run build", "npm test", "npx tsc", "cargo build", "cargo check", "cargo test", "bun test",
      "yarn build", "pnpm lint", "bun run typecheck", "make", "pytest -q", "go build ./...", "vitest run",
      "npm run build:prod", "cd app && npm run build", "deno test", "webpack", "jest",
    ]) expect([command, classifyExecution(command)]).toEqual([command, "inline"]);

    for (const command of [
      "npm install", "npm ci", "yarn install", "bun install", "cargo run", "go run main.go",
      "docker build .", "npm run migrate-the-world", "sleep 3600", "yes", "tail -f app.log",
      "npm install && npm run build",
    ]) expect([command, classifyExecution(command)]).toEqual([command, "job"]);

    for (const command of [
      "npm run dev", "npm start", "vite", "next dev", "python -m http.server", "tsc --watch",
      "vitest", "npm run test:watch", "serve -s build", "nodemon index.js", "rollup -w",
      "bash -lc \"npm run dev\"", "php -S localhost:8000", "webpack serve",
    ]) expect([command, classifyExecution(command)]).toEqual([command, "server"]);

    // The two axes are independent, and a compound line takes the more severe answer.
    expect(classifyCommand("cargo build")).toBe("heavy");
    expect(classifyExecution("cargo build")).toBe("inline");
    expect(classifyExecution("npm run build && npm run dev")).toBe("server");
  });

  test("a finite command blocks, and one that outlives the budget is handed back rather than killed", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-host-process-"));
    roots.push(root);
    const host = new ProcessHost({ nproc: 1 });
    hosts.push(host);

    const inline = await host.run({ command: "printf finite", cwd: root, inlineBudgetMs: 5_000 });
    expect(inline).toMatchObject({ stdout: "finite", exitCode: 0 });
    expect(host.status("job-000001")?.collected).toBe(true);

    const slow = await host.run({ command: "printf partial; sleep 2", cwd: root, inlineBudgetMs: 30, owner: "session-a" });
    expect("id" in slow).toBe(true);
    if (!("id" in slow)) return;
    // Handed back, not killed: the process is still alive and nobody has its output yet.
    expect(host.status(slow.id)).toMatchObject({ status: "running", owner: "session-a" });
    expect(host.status(slow.id)?.collected).toBeUndefined();
    const collected = await host.wait(slow.id);
    expect(collected).toMatchObject({ stdout: "partial", exitCode: 0, signal: null });
    expect(host.status(slow.id)?.collected).toBe(true);
  });

  test("enforces class limits and expires queued tickets", async () => {
    const semaphore = new Semaphore(1);
    const first = semaphore.acquire();
    const second = semaphore.acquire(20);
    expect(semaphore.activeCount).toBe(1);
    expect(semaphore.queuedCount).toBe(1);
    await expect(second.promise).rejects.toBeInstanceOf(ProcessQueueTimeoutError);
    (await first.promise)();
    expect(semaphore.activeCount).toBe(0);
    expect(semaphore.queuedCount).toBe(0);
  });

  test("returns inline output and non-zero errors without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-host-process-"));
    roots.push(root);
    const host = new ProcessHost({ nproc: 1 });
    hosts.push(host);
    const result = await host.run({ command: "printf out; printf err >&2; exit 7", cwd: root });
    expect(result).toMatchObject({ stdout: "out", stderr: "err", exitCode: 7, signal: null });
    expect(host.status("job-000001")?.status).toBe("failed");
  });

  test("heavy commands return a handle and can be waited", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-host-process-"));
    roots.push(root);
    const host = new ProcessHost({ nproc: 1 });
    hosts.push(host);
    // A build tool, not a sleep: a bounded short sleep is the model waiting on purpose and
    // classifies free, so it would no longer be a job at all.
    const handle = await host.run({ command: "bun --version >/dev/null; printf heavy", cwd: root });
    expect(handle).toMatchObject({ id: "job-000001", class: "heavy" });
    const result = await host.wait(handle.id);
    expect(result?.stdout).toBe("heavy");
    expect(host.status(handle.id)?.status).toBe("completed");
    expect(host.listJobs().map((job) => job.id)).toEqual(["job-000001"]);
  });

  test("cancels a process and preserves already emitted output", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-host-process-"));
    roots.push(root);
    const host = new ProcessHost({ nproc: 1 });
    hosts.push(host);
    // `background` rather than a heavy classification: what is under test is cancellation,
    // not which pattern happens to send a command to the background this month.
    const handle = await host.run({ command: "printf partial; sleep 5", cwd: root, background: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await host.cancel(handle.id)).toBe(true);
    const result = await host.wait(handle.id);
    expect(result?.stdout).toContain("partial");
    expect(result?.signal).toBe("SIGTERM");
    expect(host.status(handle.id)?.status).toBe("cancelled");
    expect(await host.cancel(handle.id)).toBe(false);
  });

  test("honors ordinary process deadlines and preserves partial output", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-host-process-"));
    roots.push(root);
    const host = new ProcessHost({ nproc: 1, defaultTimeoutMs: 1_000 });
    hosts.push(host);
    const result = await host.run({
      command: "printf before; /usr/bin/perl -e 'select undef, undef, undef, 1'; printf after",
      cwd: root,
      timeoutMs: 40,
    });
    expect(result).toMatchObject({ stdout: "before", signal: "SIGTERM" });
    expect(result.stdout).not.toContain("after");
  });

  test("close cancels and reaps every child", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-host-process-"));
    roots.push(root);
    const host = new ProcessHost({ nproc: 1 });
    const first = await host.run({ command: "sleep 5", cwd: root, background: true });
    const second = await host.run({ command: "sleep 5", cwd: root, background: true });
    await host.close();
    expect((await host.wait(first.id))?.signal).toBe("SIGTERM");
    expect((await host.wait(second.id))?.signal).toBe("SIGTERM");
    expect(host.status(first.id)?.status).toBe("cancelled");
    await expect(host.run({ command: "printf no", cwd: root })).rejects.toThrow("closed");
  });

  test("reaps redirected background descendants when their shell exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-host-process-"));
    roots.push(root);
    const host = new ProcessHost({ nproc: 1 });
    hosts.push(host);
    const handle = await host.run({ command: "/bin/sleep 30 >/dev/null 2>&1 & echo $!", cwd: root });
    const result = "id" in handle ? await host.wait(handle.id) : handle;
    const pid = Number(result?.stdout.trim());
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("ages out the oldest settled jobs and never evicts a live one", async () => {
    const root = await mkdtemp(join(tmpdir(), "lyra-host-process-"));
    roots.push(root);
    const host = new ProcessHost({ nproc: 1, retainSettledJobs: 2 });
    hosts.push(host);

    const live = await host.run({ command: "sleep 5", cwd: root, background: true });
    for (let index = 0; index < 4; index += 1) await host.run({ command: `printf out-${index}`, cwd: root });

    // Only the newest two settled jobs survive, alongside the job that is still running.
    expect(host.listJobs().map((job) => job.id)).toEqual(["job-000001", "job-000004", "job-000005"]);
    expect(host.status("job-000002")).toBeUndefined();
    expect(await host.wait("job-000002")).toBeUndefined();
    expect((await host.wait("job-000005"))?.stdout).toBe("out-3");
    expect(host.status("job-000001")?.status).toBe("running");

    expect(await host.cancel(live.id)).toBe(true);
    expect((await host.wait(live.id))?.signal).toBe("SIGTERM");
  });

  test("rejects malformed requests promptly", async () => {
    const host = new ProcessHost();
    hosts.push(host);
    const malformed = [null, 1, "bad", [], {}, { command: "printf x" }, { command: "printf x", cwd: "", timeoutMs: -1 }];
    for (const request of malformed) {
      await expect(host.run(request as never)).rejects.toBeInstanceOf(TypeError);
    }
    await expect(host.wait("missing", 1)).resolves.toBeUndefined();
    expect(new ProcessCancelledError()).toBeInstanceOf(Error);
  });
});
