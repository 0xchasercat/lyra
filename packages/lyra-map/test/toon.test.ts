import { describe, expect, test } from "bun:test";
import {
  emitToon,
  toonField,
  toonFlatTable,
  toonGroupedTable,
  toonList,
  toonNeedsQuote,
  toonNote,
  toonRow,
  toonScalar,
  toonTableSize,
  QN_RULE,
} from "../src/index.ts";

describe("quoting", () => {
  test("an ordinary identifier, path, or file:line is never quoted", () => {
    for (const value of ["MapStore", "src/store.ts", "src/store.ts:551", "173-712", "_private", "#apply", "a-b", "Ünïcode"]) {
      expect(toonNeedsQuote(value)).toBe(false);
      expect(toonScalar(value)).toBe(value);
    }
  });

  test("a value that would be misread is quoted, and quoted values are JSON string literals", () => {
    const cases: [string, string][] = [
      ["", '""'],
      [" padded", '" padded"'],
      ["trailing ", '"trailing "'],
      ['say "hi"', '"say \\"hi\\""'],
      ["a\nb", '"a\\nb"'],
      ["a\tb", '"a\\tb"'],
      ["one,two", '"one,two"'],
      ["# not a comment", '"# not a comment"'],
      ["[bracket", '"[bracket"'],
      ["{brace", '"{brace"'],
      ["42", '"42"'],
      ["-3.5e2", '"-3.5e2"'],
      [".5", '".5"'],
      ["true", '"true"'],
      ["FALSE", '"FALSE"'],
      ["null", '"null"'],
      ["-", '"-"'],
    ];
    for (const [value, expected] of cases) {
      expect(toonNeedsQuote(value)).toBe(true);
      expect(toonScalar(value)).toBe(expected);
      expect(JSON.parse(toonScalar(value))).toBe(value);
    }
  });

  test("a NUL or DEL byte forces quoting even though it is invisible", () => {
    for (const code of [0x00, 0x1f, 0x7f]) {
      const value = `a${String.fromCharCode(code)}b`;
      expect(toonNeedsQuote(value)).toBe(true);
      expect(JSON.parse(toonScalar(value))).toBe(value);
    }
  });

  test("numbers and booleans render bare; absent values render as the empty marker", () => {
    expect(toonRow([1, -2.5, true, false, null, undefined])).toBe("1,-2.5,true,false,-,-");
    // A non-finite number is not a number the format can round-trip, so it becomes a string.
    expect(toonScalar(Number.NaN)).toBe('"NaN"');
  });
});

describe("emission", () => {
  test("a prefix-factored table declares its fields once and its key once per group", () => {
    const hits = [
      { qn: "src.store.MapStore", file: "src/store.ts", name: "MapStore", kind: "class", lines: "173-712", in: 4, out: 31 },
      { qn: "src.store.toNode", file: "src/store.ts", name: "toNode", kind: "function", lines: "731-742", in: 3, out: 1 },
      { qn: "src.qn.fileQn", file: "src/qn.ts", name: "fileQn", kind: "function", lines: "67-69", in: 3, out: 1 },
    ];
    const table = toonGroupedTable(
      "results",
      ["prefix", "file"],
      ["name", "kind", "lines", "in", "out"],
      hits,
      (hit) => [hit.qn.slice(0, hit.qn.lastIndexOf(".")), hit.file],
      (hit) => [hit.name, hit.kind, hit.lines, hit.in, hit.out],
    );
    expect(toonTableSize(table)).toBe(3);
    expect(emitToon([toonField("verb", "search"), toonNote(QN_RULE), table])).toBe(
      [
        "verb: search",
        '# qn = prefix + "." + name',
        "results[3]{prefix,file}{name,kind,lines,in,out}:",
        "  src.store,src/store.ts[2]:",
        "    MapStore,class,173-712,4,31",
        "    toNode,function,731-742,3,1",
        "  src.qn,src/qn.ts[1]:",
        "    fileQn,function,67-69,3,1",
      ].join("\n"),
    );
  });

  test("a flat table puts its rows straight under the header", () => {
    expect(
      emitToon([
        toonFlatTable("path", ["step", "from", "relation", "to"], [
          [1, "src.a.f", "calls", "src.b.g"],
          [2, "src.b.g", "calls", "src.c.h"],
        ]),
      ]),
    ).toBe(
      ["path[2]{step,from,relation,to}:", "  1,src.a.f,calls,src.b.g", "  2,src.b.g,calls,src.c.h"].join("\n"),
    );
  });

  test("grouping preserves the order relevance put the rows in", () => {
    const table = toonGroupedTable(
      "results",
      ["file"],
      ["name"],
      [
        { file: "b.ts", name: "first" },
        { file: "a.ts", name: "second" },
        { file: "b.ts", name: "third" },
      ],
      (item) => [item.file],
      (item) => [item.name],
    );
    expect(table.groups.map((group) => group.key[0])).toEqual(["b.ts", "a.ts"]);
    expect(table.groups[0]!.rows.map((row) => row[0])).toEqual(["first", "third"]);
  });

  test("empty tables and empty lists vanish rather than leaving a bare heading", () => {
    expect(emitToon([toonFlatTable("nothing", ["a"], []), toonList("also", []), toonField("kept", 1)])).toBe("kept: 1");
  });

  test("a list is one counted line", () => {
    expect(emitToon([toonList("languages", ["typescript=13", "rust=55"])])).toBe("languages[2]: typescript=13,rust=55");
  });
});

describe("the size claim", () => {
  /**
   * The reason this format exists. The comparison is deliberately fair: the JSON carries
   * exactly the same facts, with no whitespace, and every row spells out the qualified name
   * that TOON reconstructs from its group key.
   */
  test("the JSON carrying the same facts is at least 60% larger", () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      qn: `src.store.MapStore.method${index}`,
      name: `method${index}`,
      kind: index % 3 === 0 ? "method" : "function",
      file: index < 25 ? "src/store.ts" : "src/incremental.ts",
      start: 100 + index * 7,
      end: 106 + index * 7,
      in: index % 5,
      out: index % 7,
    }));

    const toon = emitToon([
      toonField("verb", "search"),
      toonNote(QN_RULE),
      toonGroupedTable(
        "results",
        ["prefix", "file"],
        ["name", "kind", "lines", "in", "out"],
        rows,
        (row) => [row.qn.slice(0, row.qn.lastIndexOf(".")), row.file],
        (row) => [row.name, row.kind, `${row.start}-${row.end}`, row.in, row.out],
      ),
    ]);
    const json = JSON.stringify({ verb: "search", results: rows });

    expect(json.length).toBeGreaterThanOrEqual(Math.ceil(toon.length * 1.6));
    // Everything the JSON says is still recoverable: the qualified name is the group key
    // plus the row's name, which is why the reconstruction rule is emitted with the table.
    expect(toon).toContain("src.store.MapStore,src/store.ts[25]:");
    expect(toon).toContain("method39,method,373-379,4,4");
  });
});
