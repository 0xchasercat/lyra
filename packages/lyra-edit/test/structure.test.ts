import { describe, expect, test } from "bun:test";
import { applyAstSymbol, applyLineRange, resolveAstSymbol } from "../src/index.ts";

describe("AST symbol corpus", () => {
  test("replaces qualified TypeScript class methods without substring matches", () => {
    const source = `class UserService {\n  process(): void {}\n  processPayment(): void { console.log("old") }\n}\n`;
    const result = applyAstSymbol(
      source,
      "UserService.processPayment",
      `processPayment(): void { console.log("new") }`,
      "service.ts",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain('process(): void {}');
      expect(result.content).toContain('console.log("new")');
    }
    expect(resolveAstSymbol(source, "UserService.processPay", "service.ts")).toMatchObject({
      ok: false,
      code: "symbol_not_found",
    });
  });

  test("finds nested declarations inside decorated Python functions", () => {
    const source = `@logged\ndef outer():\n    def inner():\n        return "old"\n    return inner()\n`;
    const result = applyAstSymbol(source, "outer.inner", `def inner():\n        return "new"`, "module.py");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toContain('return "new"');
  });

  test("resolves Rust impl methods, Go receivers, TSX arrows, and Unicode byte prefixes", () => {
    const fixtures: Array<[string, string, string]> = [
      [`struct User;\nimpl User { fn pay(&self) { println!("old"); } }\n`, "User.pay", "model.rs"],
      [`package p\ntype User struct{}\nfunc (u *User) Pay() { println("old") }\n`, "User.Pay", "model.go"],
      [`const marker = "✓";\nconst Panel = () => <div>old</div>;\n`, "Panel", "panel.tsx"],
    ];
    for (const [source, symbol, path] of fixtures) {
      const resolution = resolveAstSymbol(source, symbol, path);
      expect(resolution.ok).toBe(true);
      if (resolution.ok) {
        const bytes = Buffer.from(source, "utf8");
        expect(bytes.subarray(resolution.match.startByte, resolution.match.endByte).length).toBeGreaterThan(0);
      }
    }
  });

  test("reports duplicate exact symbol paths as ambiguous", () => {
    const source = `function same() { return 1 }\nfunction same() { return 2 }\n`;
    const result = resolveAstSymbol(source, "same", "duplicate.ts");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ambiguous_match");
      expect(result.matches).toHaveLength(2);
    }
  });

  test("reports structural no-ops accurately", () => {
    const source = `function stable() { return 1 }\n`;
    const result = applyAstSymbol(source, "stable", `function stable() { return 1 }`, "stable.ts");
    expect(result).toMatchObject({ ok: false, code: "no_op" });
  });
});

describe("line-range corpus", () => {
  test("preserves CRLF and the final-newline bit", () => {
    const result = applyLineRange("one\r\ntwo\r\nthree\r\n", 2, 2, "TWO");
    expect(result).toEqual({ ok: true, content: "one\r\nTWO\r\nthree\r\n", occurrences: 1 });
  });

  test("treats empty input as line one and trailing newline as no phantom line", () => {
    expect(applyLineRange("", 1, 1, "created")).toEqual({
      ok: true,
      content: "created",
      occurrences: 1,
    });
    expect(applyLineRange("one\n", 2, 2, "phantom")).toMatchObject({
      ok: false,
      code: "invalid_range",
    });
  });

  test("preserves Unicode outside the selected range", () => {
    const result = applyLineRange("café\n茶\nfin", 2, 2, "抹茶");
    expect(result).toEqual({ ok: true, content: "café\n抹茶\nfin", occurrences: 1 });
  });
});
