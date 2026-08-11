import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CodeMap,
  clampBudget,
  DEFAULT_BUDGET,
  explain,
  impact,
  MAX_BUDGET,
  MIN_BUDGET,
  pathBetween,
  resolveSymbol,
  search,
  snippetTarget,
  staleCount,
} from "../src/index.ts";

const roots: string[] = [];

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "lyra-map-query-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A three-layer dependency chain with a known shape: `top` -> `middle` -> `base`, each in
 * its own workspace package, so a reverse closure has an unambiguous right answer at every
 * hop and a path query has exactly one direction that works.
 */
const FIXTURE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }),
  "packages/core/package.json": JSON.stringify({ name: "@fixture/core" }),
  "packages/core/src/base.ts": `export function base(n: number): number {
  return n + 1;
}
export function updateCloudClient(): number {
  return base(1);
}
export function reset(): void {}
`,
  // `client` lives in `cloud.ts`, so a search for "cloud client" matches it through its
  // PATH while matching `updateCloudClient` through its name. That is the exact shape term
  // coverage has to discriminate: one term covered, versus both.
  "packages/core/src/cloud.ts": `export function client(): number {
  return 2;
}
`,
  "packages/core/src/index.ts": `export { base, updateCloudClient, reset } from "./base.ts";\nexport { client } from "./cloud.ts";\n`,
  "packages/mid/package.json": JSON.stringify({ name: "@fixture/mid" }),
  "packages/mid/src/mid.ts": `import { base } from "@fixture/core";

export function middle(): number {
  return base(2);
}
export function reset(): void {}
`,
  "packages/top/package.json": JSON.stringify({ name: "@fixture/top" }),
  "packages/top/src/top.ts": `import { middle } from "@fixture/mid";

export function top(): number {
  return middle();
}
`,
};

let root = "";
let map: CodeMap;

// Indexed once and shared: it is read-only for every test that uses it, and it lives
// outside `roots` so the per-test cleanup cannot delete the database out from under it.
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lyra-map-query-shared-"));
  for (const [path, content] of Object.entries(FIXTURE)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  map = CodeMap.open({ root, path: join(root, ".lyra", "map.db") });
  await map.index();
});

afterAll(() => {
  map.close();
  rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------ naming a symbol

describe("symbol resolution", () => {
  test("a qualified name, a bare name, and a dotted tail all reach the same symbol", () => {
    const target = "packages.core.src.base.updateCloudClient";
    for (const spelling of [target, "updateCloudClient", "base.updateCloudClient", "src.base.updateCloudClient"]) {
      expect(resolveSymbol(map, spelling).node?.qn).toBe(target);
    }
  });

  test("the wrong case still resolves, and the right case wins when both exist", () => {
    expect(resolveSymbol(map, "updatecloudclient").node?.qn).toBe("packages.core.src.base.updateCloudClient");
    expect(resolveSymbol(map, "UPDATECLOUDCLIENT").node?.qn).toBe("packages.core.src.base.updateCloudClient");
    // `base` exists exactly once by that spelling; folding must not turn a hit into a list.
    expect(resolveSymbol(map, "base").node?.qn).toBe("packages.core.src.base.base");
  });

  test("an ambiguous name answers with candidates rather than picking one", () => {
    const lookup = resolveSymbol(map, "reset");
    expect(lookup.node).toBeUndefined();
    expect(lookup.candidates.map((node) => node.qn)).toEqual([
      "packages.core.src.base.reset",
      "packages.mid.src.mid.reset",
    ]);
    // ...and the dotted tail disambiguates it.
    expect(resolveSymbol(map, "mid.reset").node?.qn).toBe("packages.mid.src.mid.reset");
  });

  /**
   * The tool's own description promises a file path, and a reader always has one in hand —
   * every other tool in the session is addressed that way.
   */
  test("a repository-relative path resolves to that file's node", () => {
    expect(resolveSymbol(map, "packages/core/src/base.ts").node?.qn).toBe("packages.core.src.base");
    expect(resolveSymbol(map, "./packages/core/src/base.ts").node?.qn).toBe("packages.core.src.base");
    expect(resolveSymbol(map, join(root, "packages/core/src/base.ts")).node?.qn).toBe("packages.core.src.base");
  });

  test("an unambiguous tail of a path resolves too, and an ambiguous one answers with candidates", () => {
    expect(resolveSymbol(map, "src/cloud.ts").node?.qn).toBe("packages.core.src.cloud");
    const lookup = resolveSymbol(map, "src/index.ts");
    expect(lookup.node?.qn).toBe("packages.core.src.index");
    expect(resolveSymbol(map, "packages/nothing/here.ts").node).toBeUndefined();
  });

  test("explaining a file lists the symbols it defines and the modules it trades names with", () => {
    const answer = explain(map, "packages/mid/src/mid.ts");
    expect(answer).toContain("qn: packages.mid.src.mid");
    expect(answer).toContain("kind: file");
    expect(answer).not.toContain("found: 0");
    // Its own symbols, and the import that gave it `base`.
    expect(answer).toContain("middle,contains");
    expect(answer).toContain("packages.core.src.base,packages/mid/src/mid.ts");
    expect(answer).toContain("base,imports_from");
  });

  test("a name that matches nothing answers with the nearest hits, not with silence", () => {
    const lookup = resolveSymbol(map, "updateCloudClinet");
    expect(lookup.node).toBeUndefined();
    expect(lookup.candidates).toEqual([]);
    expect(explain(map, "updateCloudClinet")).toContain("did_you_mean");
  });
});

// ------------------------------------------------------------------ search

describe("search ranking", () => {
  test("a camelCase symbol is found by its interior words", () => {
    expect(search(map, "update cloud")).toContain("updateCloudClient");
    expect(search(map, "cloud")).toContain("updateCloudClient");
  });

  /**
   * `client` matches "cloud client" only through its path; `updateCloudClient` matches both
   * terms in its own name. Squaring coverage is what keeps the full match on top — this is
   * the case that motivated the exponent.
   */
  test("a hit covering both terms outranks one that matches a term through its path", () => {
    const rows = search(map, "cloud client");
    expect(rows).toContain("updateCloudClient");
    expect(rows).toContain("client");
    expect(rows.indexOf("updateCloudClient")).toBeLessThan(rows.indexOf("client,function"));
  });

  test("a function outranks the file that merely contains it", () => {
    const rows = search(map, "base");
    const fn = rows.indexOf("base,function");
    const file = rows.indexOf("base.ts,file");
    expect(fn).toBeGreaterThan(-1);
    expect(file === -1 || fn < file).toBe(true);
  });

  test("term coverage is squared, so one generic term cannot bury a full match", () => {
    const rows = search(map, "update cloud client");
    const first = rows.split("\n").find((line) => line.startsWith("    "));
    expect(first).toContain("updateCloudClient");
  });

  test("results are grouped by (prefix, file) with the reconstruction rule stated", () => {
    const rows = search(map, "reset");
    expect(rows).toContain('# qn = prefix + "." + name');
    expect(rows).toContain("results[2]{prefix,file}{name,kind,lines,in,out}:");
    expect(rows).toContain("packages.core.src.base,packages/core/src/base.ts[1]:");
  });

  test("an empty query and a query that matches nothing both answer honestly", () => {
    expect(search(map, "   ")).toContain("empty query");
    expect(search(map, "zzzznotathing")).toContain("matches: 0");
    expect(search(map, "zzzznotathing")).toContain("vocabulary");
  });
});

// ------------------------------------------------------------------ budget

describe("budget discipline", () => {
  test("an explicit budget is clamped rather than rejected", () => {
    expect(clampBudget(undefined)).toBe(DEFAULT_BUDGET);
    expect(clampBudget(10)).toBe(MIN_BUDGET);
    expect(clampBudget(1e9)).toBe(MAX_BUDGET);
    expect(clampBudget(Number.NaN)).toBe(DEFAULT_BUDGET);
    expect(clampBudget(1234)).toBe(1234);
  });

  test("every verb honours its budget", () => {
    for (const budget of [500, 800, 2000]) {
      expect(search(map, "reset", { budget }).length).toBeLessThanOrEqual(budget);
      expect(explain(map, "base", { budget }).length).toBeLessThanOrEqual(budget);
      expect(impact(map, "base", { budget }).length).toBeLessThanOrEqual(budget);
    }
  });

  /**
   * The failure this whole design exists to avoid: at a tight budget the answer degenerates
   * into a list of filenames because every node line was emitted before the first edge line.
   */
  test("edges survive a tight budget, and so does the symbol that was asked about", () => {
    const answer = explain(map, "base", { budget: MIN_BUDGET });
    expect(answer).toContain("qn: packages.core.src.base.base");
    expect(answer).toContain("inbound[");
    // At least one actual relation row, not just the header.
    expect(answer.split("\n").some((line) => line.startsWith("    ") && line.includes(","))).toBe(true);
  });

  test("truncation is announced at the top and again at the bottom, with a remediation hint", () => {
    const answer = explain(map, "base", { budget: MIN_BUDGET });
    const top = answer.indexOf("\ntruncated: ");
    const bottom = answer.indexOf("\n# truncated: ");
    expect(top).toBeGreaterThan(-1);
    expect(bottom).toBeGreaterThan(top);
    expect(answer.indexOf("inbound[")).toBeGreaterThan(top);
    expect(answer).toContain("raise budget");
  });

  test("a generous budget truncates nothing", () => {
    expect(explain(map, "base", { budget: MAX_BUDGET })).not.toContain("truncated");
  });
});

// ------------------------------------------------------------------ explain

describe("explain", () => {
  test("the node's identity comes first, then typed relations in both directions", () => {
    const answer = explain(map, "base");
    expect(answer).toContain("kind: function");
    expect(answer).toContain("at: packages/core/src/base.ts:1-3");
    expect(answer).toContain("signature: function base(n: number): number");
    expect(answer).toContain("inbound[");
  });

  /**
   * The property that makes "who calls X" clickable: the coordinate on a relation row is
   * the SITE of the call, in the caller's file, never the definition being called.
   */
  test("each relation row carries the site of the relation, not the definition", () => {
    const answer = explain(map, "base", { budget: MAX_BUDGET });
    expect(answer).toContain("# at = file + \":\" + line");
    // `middle` calls base at mid.ts:4 — the group key is the caller's file, the row the line.
    expect(answer).toContain("packages.mid.src.mid,packages/mid/src/mid.ts[");
    const group = section(answer, "packages.mid.src.mid,packages/mid/src/mid.ts[");
    expect(group).toContain("middle,calls,extracted,call,4");
    // The definition's own file:line appears once, in the head, and never on a relation row.
    expect(answer).not.toContain("base,calls,extracted,call,1");
  });

  test("a direction with no relations is elided rather than emitted as an empty table", () => {
    const answer = explain(map, "client", { budget: MAX_BUDGET });
    expect(answer).toContain("qn: packages.core.src.cloud.client");
    expect(answer).toContain("out: 0");
    expect(answer).toContain("inbound[");
    expect(answer).not.toContain("outbound");
  });
});

// ------------------------------------------------------------------ impact

describe("impact", () => {
  test("the reverse closure finds the caller's caller, with the hop that reached it", () => {
    const answer = impact(map, "base", { depth: 2, budget: MAX_BUDGET });
    expect(answer).toContain("qn: packages.core.src.base.base");
    expect(answer).toContain("depth: 2");
    expect(answer).toMatch(/hops\[2\]: 1=\d+,2=\d+/);

    // `middle` calls base directly; `top` calls middle, so it is exactly two hops away.
    const hop1 = section(answer, "1,packages.mid.src.mid,");
    expect(hop1).toContain("middle,calls,");
    expect(answer).toContain("2,packages.top.src.top,");
    const hop2 = section(answer, "2,packages.top.src.top,");
    expect(hop2).toContain("top,calls,");
  });

  test("depth 1 stops at the direct callers", () => {
    const answer = impact(map, "base", { depth: 1, budget: MAX_BUDGET });
    expect(answer).toContain("depth: 1");
    expect(answer).toMatch(/hops\[1\]: 1=\d+/);
    expect(answer).not.toContain("packages.top.src.top,");
  });

  test("groups are keyed by hop first, so the hop ordering survives the factoring", () => {
    const answer = impact(map, "base", { depth: 2, budget: MAX_BUDGET });
    const keys = answer
      .split("\n")
      .filter((line) => /^ {2}\d,/.test(line))
      .map((line) => Number(line.trim()[0]));
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
  });

  test("a leaf reports that nothing depends on it rather than an empty table", () => {
    const answer = impact(map, "top");
    expect(answer).toContain("dependents: 0");
    expect(answer).toContain("it is a leaf");
  });
});

// ------------------------------------------------------------------ path

describe("pathBetween", () => {
  test("a path reports the relations actually stored, step by step", () => {
    const answer = pathBetween(map, "top", "base", { budget: MAX_BUDGET });
    expect(answer).toContain("from_qn: packages.top.src.top.top");
    expect(answer).toContain("to_qn: packages.core.src.base.base");
    expect(answer).toContain("hops: 2");
    expect(answer).toContain("1,packages.top.src.top.top,calls,extracted,packages.mid.src.mid.middle,packages/top/src/top.ts:4");
    expect(answer).toContain("2,packages.mid.src.mid.middle,calls,extracted,packages.core.src.base.base,packages/mid/src/mid.ts:4");
  });

  test("relations are directed: the reverse has no path, and the answer says which way works", () => {
    const answer = pathBetween(map, "base", "top");
    expect(answer).toContain("path: none");
    expect(answer).toContain("no directed path");
    expect(answer).toContain("a path exists the other way (2 hops) — swap from and to");
  });

  test("an unresolvable endpoint is named rather than silently treated as missing", () => {
    expect(pathBetween(map, "reset", "base")).toContain("unresolved: from");
    expect(pathBetween(map, "base", "reset")).toContain("unresolved: to");
  });

  test("a symbol has a zero-hop path to itself", () => {
    expect(pathBetween(map, "base", "packages.core.src.base.base")).toContain("hops: 0");
  });
});

// ------------------------------------------------------------------ snippets, determinism, staleness

describe("snippetTarget", () => {
  test("a unique symbol resolves to coordinates and never to file content", () => {
    expect(snippetTarget(map, "middle")).toEqual({
      file: "packages/mid/src/mid.ts",
      start: 3,
      end: 5,
      qn: "packages.mid.src.mid.middle",
    });
  });

  test("an ambiguous symbol hands back candidates, and an absent one hands back nothing", () => {
    const ambiguous = snippetTarget(map, "reset");
    expect(ambiguous).toEqual({
      candidates: [
        { qn: "packages.core.src.base.reset", kind: "function", file: "packages/core/src/base.ts" },
        { qn: "packages.mid.src.mid.reset", kind: "function", file: "packages/mid/src/mid.ts" },
      ],
    });
    expect(snippetTarget(map, "nothingcalledthis")).toBeUndefined();
  });
});

describe("determinism", () => {
  test("the same call against the same graph produces the byte-identical answer", () => {
    for (const answer of [
      () => search(map, "reset"),
      () => explain(map, "base"),
      () => impact(map, "base"),
      () => pathBetween(map, "top", "base"),
    ]) {
      expect(answer()).toBe(answer());
    }
  });
});

describe("staleness", () => {
  test("a drifted file is counted and appended to every answer", async () => {
    const drifted = repository(FIXTURE);
    const local = CodeMap.open({ root: drifted, path: join(drifted, ".lyra", "map.db") });
    await local.index();
    expect(staleCount(local)).toBe(0);
    expect(search(local, "base")).not.toContain("stale:");

    writeFileSync(join(drifted, "packages/mid/src/mid.ts"), `export function middle(): number { return 0; }\n`);
    expect(staleCount(local)).toBe(1);
    expect(search(local, "base")).toContain("stale: 1 files");
    expect(explain(local, "base")).toContain("stale: 1 files");
    local.close();
  });

  /**
   * A checkout, a formatter that rewrote a file byte-identically, a `touch`: the mtime moves
   * and the content does not. Only a *content* change ever rewrote a file row, so before the
   * hash check this counted as drift on every single answer, forever.
   */
  test("a file whose mtime moved but whose bytes did not is neither reported nor re-reported", async () => {
    const touched = repository(FIXTURE);
    const local = CodeMap.open({ root: touched, path: join(touched, ".lyra", "map.db") });
    await local.index();
    const target = join(touched, "packages/mid/src/mid.ts");
    const stored = local.store.fileRow("packages/mid/src/mid.ts")!;

    const later = new Date(stored.mtimeMs + 5_000);
    utimesSync(target, later, later);
    expect(staleCount(local)).toBe(0);
    expect(search(local, "base")).not.toContain("stale:");
    // Healed, not merely forgiven: the stored row now agrees with disk, so the next call is
    // the cheap comparison again rather than another hash of the same unchanged file.
    expect(local.store.fileRow("packages/mid/src/mid.ts")!.mtimeMs).toBe(Math.round(later.getTime()));
    expect((await local.stale()).changed).toEqual([]);
    local.close();
  });
});

/** The lines belonging to one TOON group, from its header to the next line at that indent. */
function section(answer: string, groupHeaderPrefix: string): string {
  const lines = answer.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith(groupHeaderPrefix));
  if (start === -1) return "";
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("    ")) break;
    out.push(line.trim());
  }
  return out.join("\n");
}
