import { describe, expect, test } from "bun:test";
import { EditEngine, snapshotTag, type EditFileSystem } from "../src/index.ts";

class MemoryFs implements EditFileSystem {
  constructor(private readonly files = new Map<string, string>()) {}
  reads = 0;
  writes = 0;
  async read(path: string): Promise<string> {
    this.reads++;
    const value = this.files.get(path);
    if (value === undefined) throw new Error("not found");
    return value;
  }
  async writeAtomic(path: string, content: string): Promise<void> {
    this.writes++;
    this.files.set(path, content);
  }
  value(path: string): string | undefined { return this.files.get(path); }
}

describe("lyra edit engine corpus", () => {
  test("reads numbered Unicode and CRLF content and records normalized tag", async () => {
    const fs = new MemoryFs(new Map([["unicode.ts", "const café = '✓';\r\nreturn café;\r\n"]]));
    const engine = new EditEngine(fs);
    const result = await engine.read({ path: "unicode.ts" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.numbered).toBe("[1] const café = '✓';\n[2] return café;");
    expect(result.totalLines).toBe(2);
    expect(result.tag).toBe(snapshotTag("const café = '✓';\nreturn café;\n"));
  });

  test("exact search replacement is atomic and returns a post-write tag", async () => {
    const fs = new MemoryFs(new Map([["main.ts", "function main() {\n  return 1;\n}\n"]]));
    const engine = new EditEngine(fs);
    const read = await engine.read({ path: "main.ts" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const result = await engine.apply({ mode: "search_replace", path: "main.ts", tag: read.tag, search: "return 1;", replace: "return 2;" });
    expect(result).toMatchObject({ ok: true, mode: "search_replace", tier: "exact", occurrences: 1 });
    if (result.ok) expect(result.tag).toBe(snapshotTag(fs.value("main.ts")!));
    expect(fs.writes).toBe(1);
  });

  test("whitespace and contextual tiers do not silently pick duplicate anchors", async () => {
    const fs = new MemoryFs(new Map([["text.txt", "  alpha\n  beta\n  alpha\n  beta\n"]]));
    const engine = new EditEngine(fs);
    const read = await engine.read({ path: "text.txt" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const ambiguous = await engine.apply({ mode: "search_replace", path: "text.txt", tag: read.tag, search: "alpha\nbeta", replace: "gamma" });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.code).toBe("ambiguous_match");
  });
  test("AST symbol replacement resolves language-specific functions", async () => {
    const fixtures: Array<[string, string, string, string, string]> = [
      ["x.ts", "function greet() { return 'ts'; }\n", "greet", "function greet() { return 'changed'; }", "function greet() { return 'changed'; }\n"],
      ["x.py", "def greet():\n    return 'py'\n", "greet", "def greet():\n    return 'changed'", "def greet():\n    return 'changed'\n"],
      ["x.rs", "fn greet() { println!(\"rs\"); }\n", "greet", "fn greet() { println!(\"changed\"); }", "fn greet() { println!(\"changed\"); }\n"],
      ["x.go", "package p\nfunc greet() {}\n", "greet", "func greet() { println(\"changed\") }", "package p\nfunc greet() { println(\"changed\") }\n"],
    ];
    for (const [path, source, symbol, replacement, expected] of fixtures) {
      const fs = new MemoryFs(new Map([[path, source]]));
      const engine = new EditEngine(fs);
      const read = await engine.read({ path });
      expect(read.ok).toBe(true);
      if (!read.ok) continue;
      const result = await engine.apply({ mode: "ast_symbol", path, tag: read.tag, symbol, replace: replacement });
      expect(result.ok).toBe(true);
      expect(fs.value(path)).toBe(expected);
    }
  });

  test("line ranges are inclusive and enforce boundaries", async () => {
    const fs = new MemoryFs(new Map([["lines.json", "{\n  \"a\": 1,\n  \"b\": 2\n}\n"]]));
    const engine = new EditEngine(fs);
    const read = await engine.read({ path: "lines.json", startLine: 2, endLine: 3 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const result = await engine.apply({ mode: "line_range", path: "lines.json", tag: read.tag, startLine: 2, endLine: 3, replace: "  \"changed\": true," });
    expect(result.ok).toBe(true);
    expect(fs.value("lines.json")).toContain("changed");

    const reread = await engine.read({ path: "lines.json" });
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    const bad = await engine.apply({ mode: "line_range", path: "lines.json", tag: reread.tag, startLine: 0, endLine: 1, replace: "x" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("invalid_range");
  });

  test("stale tags and no-ops are rejected without writes", async () => {
    const fs = new MemoryFs(new Map([["stale.txt", "one\n"]]));
    const engine = new EditEngine(fs);
    const read = await engine.read({ path: "stale.txt" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    fs.writeAtomic("stale.txt", "outside\n");
    const stale = await engine.apply({ mode: "search_replace", path: "stale.txt", tag: read.tag, search: "one", replace: "two" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("stale_hash");
    const fresh = await engine.read({ path: "stale.txt" });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    const noop = await engine.apply({ mode: "search_replace", path: "stale.txt", tag: fresh.tag, search: "outside", replace: "outside" });
    expect(noop.ok).toBe(false);
    if (!noop.ok) expect(noop.code).toBe("no_op");
  });

  test("batch reports exactly applied and failed paths", async () => {
    const fs = new MemoryFs(new Map([["a.txt", "a\n"], ["b.txt", "b\n"]]));
    const engine = new EditEngine(fs);
    const a = await engine.read({ path: "a.txt" });
    const b = await engine.read({ path: "b.txt" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const result = await engine.applyBatch([
      { mode: "search_replace", path: "a.txt", tag: a.tag, search: "a", replace: "A" },
      { mode: "search_replace", path: "b.txt", tag: b.tag, search: "missing", replace: "B" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.applied).toEqual(["a.txt"]);
    expect(result.failed).toEqual(["b.txt"]);
    expect(result.results[0]?.ok).toBe(true);
    expect(result.results[1]?.ok).toBe(false);
  });
});
