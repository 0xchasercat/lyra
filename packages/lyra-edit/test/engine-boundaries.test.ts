import { describe, expect, test } from "bun:test";
import { EditEngine } from "../src/index.ts";
import type { EditFileSystem } from "../src/index.ts";

class MemoryFileSystem implements EditFileSystem {
  readonly files = new Map<string, string>();
  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw Object.assign(new Error(`File not found: ${path}`), { code: "ENOENT" });
    return content;
  }
  async writeAtomic(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}

describe("EditEngine boundaries", () => {
  test("makes an empty file one addressable numbered line", async () => {
    const files = new MemoryFileSystem();
    files.files.set("empty.txt", "");
    const engine = new EditEngine(files);
    const read = await engine.read({ path: "empty.txt" });
    expect(read).toMatchObject({ ok: true, startLine: 1, endLine: 1, totalLines: 1, numbered: "[1] " });
  });

  /**
   * A range that runs past the end of the file is a guess about a length the caller could
   * not know before reading it, so it returns the lines that exist and says it clamped.
   * Only a range with nothing in it is still an error.
   */
  test("clamps an overshooting endLine and refuses a range with nothing in it", async () => {
    const files = new MemoryFileSystem();
    files.files.set("short.txt", Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n"));
    const engine = new EditEngine(files);

    const clamped = await engine.read({ path: "short.txt", startLine: 1, endLine: 100 });
    expect(clamped).toMatchObject({ ok: true, startLine: 1, endLine: 18, totalLines: 18, requestedEndLine: 100 });
    expect(clamped.ok && clamped.numbered.endsWith("[18] line 18")).toBe(true);

    // An exact range is not a clamp, and says nothing extra.
    const exact = await engine.read({ path: "short.txt", startLine: 2, endLine: 18 });
    expect(exact.ok && exact.requestedEndLine).toBeUndefined();

    const past = await engine.read({ path: "short.txt", startLine: 20, endLine: 30 });
    expect(past.ok).toBe(false);
    if (!past.ok) {
      expect(past.code).toBe("invalid_range");
      expect(past.message).toContain("past the end");
    }

    const backwards = await engine.read({ path: "short.txt", startLine: 5, endLine: 3 });
    expect(backwards.ok).toBe(false);
    if (!backwards.ok) expect(backwards.code).toBe("invalid_range");
  });

  test("allows untagged new writes but requires read/tag for existing files", async () => {
    const files = new MemoryFileSystem();
    files.files.set("existing.txt", "old");
    const engine = new EditEngine(files);

    expect(await engine.write("new.txt", "new")).toMatchObject({ ok: true, mode: "write" });
    expect(await engine.write("existing.txt", "unsafe")).toMatchObject({ ok: false, code: "stale_hash" });

    const read = await engine.read({ path: "existing.txt" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(await engine.write("existing.txt", "safe", read.tag)).toMatchObject({ ok: true });
    expect(files.files.get("existing.txt")).toBe("safe");
  });

  test("counts one terminal tier for every apply call", async () => {
    const files = new MemoryFileSystem();
    files.files.set("metrics.txt", "value\n");
    const engine = new EditEngine(files);
    const read = await engine.read({ path: "metrics.txt" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    await engine.apply({ mode: "search_replace", path: "metrics.txt", tag: read.tag, search: "missing", replace: "x" });
    const reread = await engine.read({ path: "metrics.txt" });
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    await engine.apply({ mode: "line_range", path: "metrics.txt", tag: reread.tag, startLine: 1, endLine: 1, replace: "changed" });

    const metrics = engine.getMetrics();
    expect(metrics.modeCalls.search_replace).toBe(1);
    expect(metrics.modeCalls.line_range).toBe(1);
    expect(Object.values(metrics.tierCalls).reduce((sum, count) => sum + count, 0)).toBe(2);
  });
});
