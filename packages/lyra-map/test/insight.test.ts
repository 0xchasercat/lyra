import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CodeMap, explain, impact, MAX_BUDGET, overview, pathBetween, search, vocabulary } from "../src/index.ts";

const roots: string[] = [];

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "lyra-map-insight-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

async function indexed(files: Record<string, string>): Promise<CodeMap> {
  const root = repository(files);
  const map = CodeMap.open({ root, path: join(root, ".lyra", "map.db") });
  await map.index();
  return map;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Four languages, two workspace packages, and one crate that no manifest claims. */
const MIXED: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }),
  "packages/core/package.json": JSON.stringify({ name: "@fixture/core" }),
  "packages/core/src/index.ts": `export { Engine } from "./engine.ts";\nexport { Config } from "./config.ts";\n`,
  "packages/core/src/engine.ts": `import { Config } from "./config.ts";

export class Engine {
  constructor(private config: Config) {}
  run(): number { return this.tick(); }
  private tick(): number { return 1; }
}
export function boot(config: Config): Engine { return new Engine(config); }
`,
  "packages/core/src/config.ts": `export interface Config { name: string; }\nexport const DEFAULT: Config = { name: "d" };\n`,
  "packages/app/package.json": JSON.stringify({ name: "@fixture/app" }),
  "packages/app/src/main.ts": `import { Engine, Config } from "@fixture/core";
import { format } from "./format.ts";

export function main(config: Config): string {
  const engine = new Engine(config);
  return format(engine.run());
}
`,
  "packages/app/src/format.ts": `export function format(value: number): string { return String(value); }\n`,
  "services/api/handler.py": `from .models import Record\n\ndef handle(record: Record):\n    return record\n`,
  "services/api/models.py": `class Record:\n    def key(self):\n        return 1\n`,
  "crates/engine/src/lib.rs": `pub mod parts;\nuse crate::parts::Part;\n\npub fn assemble(p: Part) -> u32 { p.size() }\n`,
  "crates/engine/src/parts.rs": `pub struct Part { pub n: u32 }\n\nimpl Part {\n    pub fn size(&self) -> u32 { self.n }\n}\n`,
};

describe("overview", () => {
  test("the brief opens with what the repository is made of", async () => {
    const map = await indexed(MIXED);
    const brief = overview(map);

    expect(brief).toContain("verb: overview");
    expect(brief).toMatch(/\nfiles: \d+/);
    expect(brief).toMatch(/\nnodes: \d+/);
    expect(brief).toMatch(/\nedges: \d+/);
    expect(brief).toContain("languages[3]:");
    expect(brief).toContain("typescript=");
    expect(brief).toContain("python=");
    expect(brief).toContain("rust=");
    expect(brief).toContain("confidence[");
    map.close();
  });

  test("the partition names workspace packages and keeps unclaimed directories separate", async () => {
    const map = await indexed(MIXED);
    const brief = overview(map, { budget: MAX_BUDGET });

    expect(brief).toContain("packages[");
    expect(brief).toContain("@fixture/core,packages/core");
    expect(brief).toContain("@fixture/app,packages/app");
    // A Rust crate has no package.json, so it is grouped at the depth the manifests live at
    // rather than collapsing into a shared parent with every other unclaimed directory.
    expect(brief).toContain("crates/engine");
    expect(brief).toContain("services/api");
    map.close();
  });

  /**
   * A crate with zero edges to the TypeScript packages is not a dead subsystem: the resolver
   * refuses to cross a language family at all, so those edges were never eligible to exist.
   * Before this, the brief invited the reader to investigate a boundary it had drawn itself.
   */
  test("a partition isolated only by its language says so instead of looking dead", async () => {
    const map = await indexed(MIXED);
    const brief = overview(map, { budget: MAX_BUDGET });

    expect(brief).toContain("islands by language:");
    expect(brief).toContain("crates/engine (rust)");
    expect(brief).toContain("services/api (python)");
    expect(brief).toContain("no cross-language edges by design");
    // ...and the same partitions are not also offered as a suspicious dead end.
    expect(brief).not.toContain("dead, or only reached dynamically");
    map.close();
  });

  test("a partition isolated within its own language is still worth asking about", async () => {
    const map = await indexed({
      "package.json": JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }),
      "packages/core/package.json": JSON.stringify({ name: "@fixture/core" }),
      "packages/core/src/engine.ts": `export function boot(): number { return 1; }\nexport function run(): number { return boot(); }\n`,
      "packages/app/package.json": JSON.stringify({ name: "@fixture/app" }),
      "packages/app/src/main.ts": `import { boot } from "@fixture/core";\nexport function main(): number { return boot(); }\n`,
      "packages/orphan/package.json": JSON.stringify({ name: "@fixture/orphan" }),
      "packages/orphan/src/alone.ts": `export function unreachableThing(): number { return 1; }\n`,
    });
    const brief = overview(map, { budget: MAX_BUDGET });
    expect(brief).not.toContain("islands by language:");
    expect(brief).toContain("dead, or only reached dynamically");
    map.close();
  });

  test("cross-package edge volume is counted in both directions", async () => {
    const map = await indexed(MIXED);
    const brief = overview(map, { budget: MAX_BUDGET });
    const app = brief.split("\n").find((line) => line.trim().startsWith("@fixture/app,"))!;
    const core = brief.split("\n").find((line) => line.trim().startsWith("@fixture/core,"))!;
    // app imports core, so app has outbound cross-package edges and core has inbound ones.
    expect(Number(app.trim().split(",")[4])).toBeGreaterThan(0);
    expect(Number(core.trim().split(",")[5])).toBeGreaterThan(0);
    map.close();
  });

  test("hubs exclude containers, so a test or file node can never be a god node", async () => {
    const map = await indexed(MIXED);
    const brief = overview(map, { budget: MAX_BUDGET });
    for (const line of rowsOf(brief, "hubs[")) {
      expect(["file", "module", "test"]).not.toContain(line.split(",")[1]);
    }
    map.close();
  });

  test("suggested questions are verbs with arguments the tool can take straight back", async () => {
    const map = await indexed(MIXED);
    const brief = overview(map, { budget: MAX_BUDGET });
    const questions = rowsOf(brief, "questions[");
    expect(questions.length).toBeGreaterThan(0);
    for (const question of questions) {
      expect(["explain", "impact", "search", "pathBetween"]).toContain(question.split(",")[0]);
    }
    map.close();
  });

  test("it fits the budget it was given, and defaults to a few kilobytes", async () => {
    const map = await indexed(MIXED);
    expect(overview(map).length).toBeLessThanOrEqual(4000);
    for (const budget of [500, 1500, 4000, 16_000]) {
      expect(overview(map, { budget }).length).toBeLessThanOrEqual(budget);
    }
    map.close();
  });

  test("the same graph always produces the same brief", async () => {
    const map = await indexed(MIXED);
    expect(overview(map)).toBe(overview(map));
    map.close();
  });

  /** No padded headings: a section with nothing to say does not appear at all. */
  test("empty sections are elided rather than emitted as bare headings", async () => {
    const map = await indexed({
      "package.json": JSON.stringify({ name: "solo" }),
      "only.ts": `export function alone(): number { return 1; }\n`,
    });
    const brief = overview(map, { budget: MAX_BUDGET });

    expect(brief).toContain("files: 1");
    // One group, no cross-file edges, no import cycles: none of those sections exist.
    expect(brief).not.toContain("packages[");
    expect(brief).not.toContain("surprises[");
    expect(brief).not.toContain("[0]");
    map.close();
  });

  test("an empty index says so instead of inventing structure", async () => {
    const map = await indexed({ "readme.md": "# nothing to index\n" });
    const brief = overview(map);
    expect(brief).toContain("files: 0");
    expect(brief).toContain("nothing indexed yet");
    expect(brief).not.toContain("hubs[");
    map.close();
  });
});

describe("vocabulary", () => {
  test("it reports the graph's own terms, most frequent first", async () => {
    const map = await indexed(MIXED);
    const terms = vocabulary(map);

    expect(terms.length).toBeGreaterThan(5);
    for (let index = 1; index < terms.length; index += 1) {
      expect(terms[index - 1]!.count).toBeGreaterThanOrEqual(terms[index]!.count);
    }
    expect(terms.map((entry) => entry.term)).toContain("engine");
    expect(terms.map((entry) => entry.term)).toContain("config");
    map.close();
  });

  test("the terms are split the same way the index split them, so a camelCase word appears alone", async () => {
    const map = await indexed(MIXED);
    const terms = new Set(vocabulary(map, 1000).map((entry) => entry.term));
    // `DEFAULT` and `boot` are whole identifiers; `Record.key` contributes `key`.
    expect(terms.has("default")).toBe(true);
    expect(terms.has("boot")).toBe(true);
    expect(terms.has("key")).toBe(true);
    map.close();
  });

  /** The point of the vocabulary: every term it hands out is a term that actually finds something. */
  test("every term it reports is a term search can use", async () => {
    const map = await indexed(MIXED);
    for (const entry of vocabulary(map, 12)) {
      expect(search(map, entry.term)).not.toContain("matches: 0");
    }
    map.close();
  });

  test("the limit is honoured and never returns nothing for a non-empty graph", async () => {
    const map = await indexed(MIXED);
    expect(vocabulary(map, 5)).toHaveLength(5);
    expect(vocabulary(map, 0)).toHaveLength(1);
    map.close();
  });
});

// ------------------------------------------------------------------ against the real index

/**
 * Everything above runs on a fixture built for the test. This one runs on `@lyra/map`
 * itself: a real tree, a real walk, the real database shape, and result sets large enough
 * that the budget and the format have to do actual work.
 */
describe("a self-index of this package", () => {
  const PACKAGE_ROOT = resolve(import.meta.dir, "..");
  let scratch = "";
  let map: CodeMap;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "lyra-map-self-"));
    map = CodeMap.open({ root: PACKAGE_ROOT, path: join(scratch, "self.db") });
    await map.index();
  });

  afterAll(() => {
    map.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("the real graph is large enough to be worth querying", () => {
    const stats = map.stats();
    expect(stats.files).toBeGreaterThan(8);
    expect(stats.nodes).toBeGreaterThan(200);
    expect(stats.edges).toBeGreaterThan(500);
  });

  test("the brief describes this package and stays inside its budget", () => {
    const brief = overview(map);
    expect(brief.length).toBeLessThanOrEqual(4000);
    expect(brief).toContain("typescript=");
    expect(brief).toContain("hubs[");
    expect(brief).toContain("questions[");
    expect(brief).toBe(overview(map));
  });

  test("every verb answers about real symbols, in TOON, within budget", () => {
    expect(search(map, "code map store")).toContain("results[");
    expect(explain(map, "MapStore.searchFts")).toContain("qn: src.store.MapStore.searchFts");
    expect(explain(map, "searchFts")).toContain("ambiguous: 2");
    expect(impact(map, "splitIdentifier")).toContain("dependents:");
    expect(pathIsHonest(map)).toBe(true);
    for (const answer of [search(map, "map"), explain(map, "toonScalar"), impact(map, "toonRow")]) {
      expect(answer.length).toBeLessThanOrEqual(4000);
      expect(answer.startsWith("verb: ")).toBe(true);
      expect(() => JSON.parse(answer)).toThrow();
    }
  });

  /**
   * The measured reason the format exists, checked against a real result set rather than a
   * fixture built to flatter it. The JSON carries exactly the same facts with no whitespace.
   */
  test("the JSON carrying the same search facts is at least 60% larger", () => {
    const query = "node";
    const answer = search(map, query, { limit: 25, budget: MAX_BUDGET });
    const hits = map.searchFts(query, 25);
    expect(hits.length).toBeGreaterThan(8);

    const degrees = map.store.degreesFor(hits.map((hit) => hit.id));
    const json = JSON.stringify(
      hits.map((hit) => ({
        qn: hit.qn,
        name: hit.name,
        kind: hit.kind,
        file: hit.file,
        start: hit.start,
        end: hit.end,
        in: degrees.get(hit.id)?.in ?? 0,
        out: degrees.get(hit.id)?.out ?? 0,
      })),
    );
    expect(json.length).toBeGreaterThanOrEqual(Math.ceil(answer.length * 1.6));
  });

  test("the vocabulary of a real graph is large and usable", () => {
    const terms = vocabulary(map, 50);
    expect(terms).toHaveLength(50);
    expect(terms.map((entry) => entry.term)).toContain("node");
    expect(search(map, terms[0]!.term)).not.toContain("matches: 0");
  });
});

/** A path between two real symbols either reports stored relations or admits there is none. */
function pathIsHonest(map: CodeMap): boolean {
  const answer = pathBetween(map, "MapStore.searchFts", "splitIdentifier", { budget: MAX_BUDGET });
  if (answer.includes("path: none")) return answer.includes("no directed path");
  return /\n {2}1,[^,]+,(calls|references|contains|imports|imports_from|re_exports|extends|implements|inherits),/.test(answer);
}

/** The data rows of a named TOON table, without their indentation. */
function rowsOf(text: string, tableHeaderPrefix: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(tableHeaderPrefix));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break;
    out.push(line.trim());
  }
  return out;
}
