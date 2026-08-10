import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CodeMap, NodeCollapseError } from "../src/index.ts";

const roots: string[] = [];

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "lyra-map-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  return root;
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function remove(root: string, path: string): void {
  rmSync(join(root, path), { force: true });
}

function open(root: string, name = "map.db"): CodeMap {
  return CodeMap.open({ root, path: join(root, ".lyra", name) });
}

/**
 * The graph in a form that ignores everything an implementation is free to choose — row
 * ids, insertion order, timestamps — and nothing else. Two indexes with the same canonical
 * form hold the same facts.
 */
function canonical(map: CodeMap): { nodes: string[]; edges: string[]; unresolved: string[] } {
  return {
    nodes: map.store.allNodes().map((node) => `${node.kind} ${node.qn} ${node.file}:${node.start}-${node.end} ${node.signature ?? ""}`),
    edges: map.store
      .allEdges()
      .map((edge) => `${edge.srcQn} -${edge.relation}/${edge.context ?? "-"}/${edge.confidence}-> ${edge.dstQn} @${edge.file}:${edge.line}`)
      .sort(),
    unresolved: map.store.allUnresolved().map((row) => `${row.file} ${row.name} ${row.dropped}/${row.inferred}`),
  };
}

/** A full index of the same tree into a throwaway database — the reference every pass is held to. */
async function fromScratch(root: string): Promise<{ nodes: string[]; edges: string[]; unresolved: string[] }> {
  const reference = open(root, `reference-${Math.random().toString(36).slice(2)}.db`);
  await reference.index();
  const snapshot = canonical(reference);
  reference.close();
  return snapshot;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the fixture repository

const FIXTURE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }),
  "packages/core/package.json": JSON.stringify({ name: "@fixture/core" }),
  "packages/core/src/index.ts": `export { Engine } from "./engine.ts";\nexport { Config } from "./config.ts";\n`,
  "packages/core/src/engine.ts": `import { Config } from "./config.ts";\n
export class Engine {
  constructor(private config: Config) {}
  run(): number { return this.tick(); }
  private tick(): number { return 1; }
}
export function boot(config: Config): Engine { return new Engine(config); }
`,
  "packages/core/src/config.ts": `export interface Config { name: string; }\nexport const DEFAULT: Config = { name: "d" };\n`,
  "packages/app/package.json": JSON.stringify({ name: "@fixture/app" }),
  "packages/app/src/app.ts": `import { Engine, Config } from "@fixture/core";\nimport { format } from "./format.ts";\n
export function main(config: Config): string {
  const engine = new Engine(config);
  return format(engine.run());
}
`,
  "packages/app/src/format.ts": `export function format(value: number): string { return String(value); }\n`,
  "packages/app/test/app.test.ts": `import { main } from "../src/app.ts";\nexport function check(): string { return main({ name: "x" }); }\n`,
  "services/api/handler.py": `from .models import Record\n\ndef handle(record: Record):\n    return record\n`,
  "services/api/models.py": `class Record:\n    def key(self):\n        return 1\n`,
  "crates/engine/src/lib.rs": `pub mod parts;\nuse crate::parts::Part;\n\npub fn assemble(p: Part) -> u32 { p.size() }\n`,
  "crates/engine/src/parts.rs": `pub struct Part { pub n: u32 }\n\nimpl Part {\n    pub fn size(&self) -> u32 { self.n }\n}\n`,
  "go/svc/store/item.go": `package store\n\ntype Item struct { Name string }\n\nfunc Load() *Item { return &Item{} }\n`,
  "go/svc/main.go": `package main\n\nimport "example.com/svc/store"\n\nfunc run() *store.Item { return store.Load() }\n`,
};

describe("full index", () => {
  test("index a mixed repository and expose it through the raw primitives", async () => {
    const root = repository(FIXTURE);
    const map = open(root);
    const stats = await map.index();

    expect(stats.files).toBe(12);
    expect(stats.failed).toBe(0);
    expect(map.stats().nodes).toBeGreaterThan(20);

    const engine = map.nodeByQn("packages.core.src.engine.Engine");
    expect(engine).toMatchObject({ kind: "class", file: "packages/core/src/engine.ts" });

    // The relation site is in the referring file, never at the definition.
    const inbound = map.edgesTo(engine!.id, { relations: ["calls"] });
    expect(inbound.map((edge) => `${edge.srcQn} @${edge.file}:${edge.line}`)).toContain(
      "packages.app.src.app.main @packages/app/src/app.ts:5",
    );

    expect(map.nodeByQn("packages.app.test.app.test")).toMatchObject({ kind: "test" });
    expect(map.nodesInFile("packages/core/src/config.ts").map((node) => node.qn)).toEqual([
      "packages.core.src.config",
      "packages.core.src.config.Config",
      "packages.core.src.config.Config.name",
      "packages.core.src.config.DEFAULT",
    ]);
    map.close();
  });

  test("cross-language edges never form, in either direction", async () => {
    const root = repository(FIXTURE);
    const map = open(root);
    await map.index();
    const languageOfFile = new Map(map.store.allFiles().map((row) => [row.path, row.language]));
    const family = (path: string): string => {
      const language = languageOfFile.get(path);
      return language === "typescript" || language === "tsx" || language === "javascript" ? "js" : language ?? "?";
    };
    const nodes = new Map(map.store.allNodes().map((node) => [node.id, node]));
    for (const edge of map.store.allEdges()) {
      expect(family(nodes.get(edge.src)!.file)).toBe(family(nodes.get(edge.dst)!.file));
    }
    map.close();
  });

  test("full-text search matches split identifiers and qualified names", async () => {
    const root = repository({
      ...FIXTURE,
      "packages/app/src/cloud.ts": `export function updateCloudClient(): void {}\nexport const parse_http_response = 1;\n`,
    });
    const map = open(root);
    await map.index();
    expect(map.searchFts("updateCloud").map((hit) => hit.qn)).toContain("packages.app.src.cloud.updateCloudClient");
    expect(map.searchFts("cloud client").map((hit) => hit.qn)).toContain("packages.app.src.cloud.updateCloudClient");
    expect(map.searchFts("http response").map((hit) => hit.qn)).toContain("packages.app.src.cloud.parse_http_response");
    expect(map.searchFts("updateCloudClient").map((hit) => hit.qn)).toContain("packages.app.src.cloud.updateCloudClient");
    expect(map.searchFts("engine").map((hit) => hit.qn)).toContain("packages.core.src.engine.Engine");
    expect(map.searchFts("")).toEqual([]);
    map.close();
  });

  test("breadth-first traversal is bounded and deterministic", async () => {
    const root = repository(FIXTURE);
    const map = open(root);
    await map.index();
    const first = map.bfs("packages.core.src.engine.Engine", { depth: 2, direction: "in" });
    const second = map.bfs("packages.core.src.engine.Engine", { depth: 2, direction: "in" });
    expect(second.nodes.map((node) => node.qn)).toEqual(first.nodes.map((node) => node.qn));
    expect(first.nodes[0]!.depth).toBe(0);
    expect(map.bfs("packages.core.src.engine.Engine", { depth: 3, limit: 3 }).truncated).toBe(true);
    expect(map.bfs("no.such.symbol").nodes).toEqual([]);
    map.close();
  });

  test("the walk skips Lyra state, dependency trees, gitignored paths, and generated files", async () => {
    const root = repository({
      ...FIXTURE,
      ".gitignore": "ignored/\n*.gen.ts\n",
      "ignored/secret.ts": `export function hidden(): void {}\n`,
      "node_modules/dep/index.ts": `export function vendored(): void {}\n`,
      "packages/app/src/schema.gen.ts": `export function generatedByRule(): void {}\n`,
      "packages/app/src/machine.ts": `// Code generated by tool. DO NOT EDIT.\nexport function generatedByHeader(): void {}\n`,
      "packages/app/src/huge.ts": `export const wide = "${"x".repeat(6000)}";\n`,
    });
    write(root, ".lyra/scratch.ts", `export function lyraState(): void {}\n`);
    const map = open(root);
    const stats = await map.index();
    for (const name of ["hidden", "vendored", "generatedByRule", "generatedByHeader", "lyraState", "wide"]) {
      expect(map.nodesByName(name)).toEqual([]);
    }
    expect(stats.skipped).toBe(2);
    expect(map.nodesByName("format")).not.toEqual([]);
    map.close();
  });

  test("the map database lives under .lyra and is never indexed by the map itself", async () => {
    const root = repository(FIXTURE);
    const map = CodeMap.open({ root });
    await map.index();
    expect(existsSync(join(root, ".lyra", "map.db"))).toBe(true);
    expect(statSync(join(root, ".lyra", "map.db")).mode & 0o777).toBe(0o600);
    expect(map.store.allFiles().some((row) => row.path.startsWith(".lyra"))).toBe(false);
    map.close();
  });
});

describe("the rot test", () => {
  test("repeated no-op edits leave the graph byte-identical to a fresh full index", async () => {
    const root = repository(FIXTURE);
    const map = open(root);
    await map.index();
    const reference = await fromScratch(root);
    expect(canonical(map)).toEqual(reference);

    // The measured failure both studied tools exhibit: an edit that changes nothing
    // observable still erodes the graph, one pass at a time.
    for (let round = 1; round <= 4; round += 1) {
      write(
        root,
        "packages/app/src/format.ts",
        `export function format(value: number): string { return String(value); }\n// note ${round}\n`,
      );
      const stats = await map.update(["packages/app/src/format.ts"]);
      expect(stats.changed).toBe(1);
      expect(stats.bodyOnly).toBe(1);
      expect(stats.reresolved).toBe(0);
      expect(canonical(map)).toEqual(await fromScratch(root));
    }
    map.close();
  });

  test("a body-only edit never disturbs a single inbound edge", async () => {
    const root = repository(FIXTURE);
    const map = open(root);
    await map.index();
    const engine = map.nodeByQn("packages.core.src.engine.Engine")!;
    const inboundOf = (id: number): string[] =>
      map.edgesTo(id).map((edge) => `${edge.srcQn} ${edge.relation} ${edge.file}:${edge.line}`).sort();
    const before = inboundOf(engine.id);
    expect(before.length).toBeGreaterThan(2);

    write(
      root,
      "packages/core/src/engine.ts",
      `import { Config } from "./config.ts";\n
export class Engine {
  constructor(private config: Config) {}
  run(): number { return this.tick() + 41; }
  private tick(): number { return 1; }
}
export function boot(config: Config): Engine { return new Engine(config); }
`,
    );
    const stats = await map.update(["packages/core/src/engine.ts"]);
    expect(stats.bodyOnly).toBe(1);
    expect(map.nodeByQn("packages.core.src.engine.Engine")!.id).toBe(engine.id);
    expect(inboundOf(engine.id)).toEqual(before);
    map.close();
  });
});

describe("surface changes", () => {
  test("a new export reaches a file whose dropped fact was waiting for it", async () => {
    const root = repository({
      "src/app.ts": `export function run(): number { return futureHelper(); }\n`,
      "src/lib.ts": `export function present(): number { return 1; }\n`,
    });
    const map = open(root);
    await map.index();
    expect(map.edgesFrom("src.app.run", { relations: ["calls"] })).toEqual([]);
    expect(map.store.allUnresolved()).toContainEqual({ file: "src/app.ts", name: "futureHelper", dropped: 1, inferred: 0 });

    write(root, "src/lib.ts", `export function present(): number { return 1; }\nexport function futureHelper(): number { return 2; }\n`);
    const stats = await map.update(["src/lib.ts"]);

    // Only lib.ts changed, yet app.ts is re-resolved: the unresolved table named it.
    expect(stats.reresolved).toBe(1);
    expect(map.edgesFrom("src.app.run", { relations: ["calls"] }).map((edge) => edge.dstQn)).toEqual(["src.lib.futureHelper"]);
    expect(canonical(map)).toEqual(await fromScratch(root));
    map.close();
  });

  test("a removed export drops the edges that pointed at it, cleanly", async () => {
    const root = repository({
      "src/lib.ts": `export function helper(): number { return 1; }\nexport function other(): number { return 2; }\n`,
      "src/app.ts": `import { helper } from "./lib.ts";\nexport function run(): number { return helper(); }\n`,
    });
    const map = open(root);
    await map.index();
    expect(map.edgesFrom("src.app.run", { relations: ["calls"] }).map((edge) => edge.dstQn)).toEqual(["src.lib.helper"]);

    write(root, "src/lib.ts", `export function other(): number { return 2; }\n`);
    await map.update(["src/lib.ts"]);

    expect(map.nodeByQn("src.lib.helper")).toBeNull();
    expect(map.edgesFrom("src.app.run", { relations: ["calls"] })).toEqual([]);
    expect(map.store.allEdges().every((edge) => edge.dstQn !== "src.lib.helper")).toBe(true);
    expect(canonical(map)).toEqual(await fromScratch(root));
    map.close();
  });

  test("a rename re-points what it can and drops the rest, never dangling", async () => {
    const root = repository({
      "src/lib.ts": `export function helper(): number { return 1; }\n`,
      "src/byImport.ts": `import { helper } from "./lib.ts";\nexport function a(): number { return helper(); }\n`,
      "src/byName.ts": `export function b(): number { return helper(); }\n`,
    });
    const map = open(root);
    await map.index();
    const original = map.nodeByQn("src.lib.helper")!;
    expect(map.edgesTo(original.id, { relations: ["calls"] })).toHaveLength(2);

    write(root, "src/lib.ts", `export function helper2(): number { return 1; }\n`);
    write(root, "src/byName.ts", `export function b(): number { return helper2(); }\n`);
    await map.update(["src/lib.ts", "src/byName.ts"]);

    expect(map.nodeByQn("src.lib.helper")).toBeNull();
    const renamed = map.nodeByQn("src.lib.helper2")!;
    expect(renamed.id).not.toBe(original.id);
    // byName.ts followed the rename; byImport.ts still asks for the old name and gets nothing.
    expect(map.edgesTo(renamed.id, { relations: ["calls"] }).map((edge) => edge.file)).toEqual(["src/byName.ts"]);
    expect(map.edgesFrom("src.byImport.a", { relations: ["calls"] })).toEqual([]);
    expect(map.store.allEdges().every((edge) => edge.dstQn !== "src.lib.helper")).toBe(true);
    expect(canonical(map)).toEqual(await fromScratch(root));
    map.close();
  });

  test("a newly added file is found by the importer that was waiting for it", async () => {
    const root = repository({ "src/app.ts": `import { later } from "./later.ts";\nexport const x = later();\n` });
    const map = open(root);
    await map.index();
    expect(map.edgesFrom("src.app", { relations: ["imports_from"] })).toEqual([]);

    write(root, "src/later.ts", `export function later(): number { return 1; }\n`);
    const stats = await map.update(["src/later.ts"]);
    expect(stats.reresolved).toBe(1);
    expect(map.edgesFrom("src.app", { relations: ["imports_from"] }).map((edge) => edge.dstQn)).toEqual(["src.later.later"]);
    expect(canonical(map)).toEqual(await fromScratch(root));
    map.close();
  });

  test("a new definition elsewhere makes an inferred edge ambiguous, and it is revisited", async () => {
    const root = repository({
      "src/a/target.ts": `export function shared(): number { return 1; }\n`,
      "src/app.ts": `export function run(): number { return shared(); }\n`,
    });
    const map = open(root);
    await map.index();
    expect(map.edgesFrom("src.app.run", { relations: ["calls"] }).map((edge) => `${edge.dstQn}/${edge.confidence}`)).toEqual([
      "src.a.target.shared/inferred",
    ]);

    write(root, "src/b/target.ts", `export function shared(): number { return 2; }\n`);
    await map.update(["src/b/target.ts"]);

    // Two equally distant candidates: the map says nothing rather than keeping a stale guess.
    expect(map.edgesFrom("src.app.run", { relations: ["calls"] })).toEqual([]);
    expect(canonical(map)).toEqual(await fromScratch(root));
    map.close();
  });
});

describe("removal", () => {
  test("deleting a file from disk removes it and repairs what pointed into it", async () => {
    const root = repository({
      "src/lib.ts": `export function helper(): number { return 1; }\n`,
      "src/app.ts": `import { helper } from "./lib.ts";\nexport function run(): number { return helper(); }\n`,
    });
    const map = open(root);
    await map.index();
    remove(root, "src/lib.ts");
    const stats = await map.update(["src/lib.ts"]);

    expect(stats.removed).toBe(1);
    expect(map.nodeByQn("src.lib")).toBeNull();
    expect(map.store.allEdges().every((edge) => !edge.dstQn.startsWith("src.lib"))).toBe(true);
    expect(canonical(map)).toEqual(await fromScratch(root));
    map.close();
  });

  test("remove() drops a file that is still on disk", async () => {
    const root = repository({ "src/lib.ts": `export function helper(): number { return 1; }\n` });
    const map = open(root);
    await map.index();
    const stats = await map.remove(["src/lib.ts"]);
    expect(stats.removed).toBe(1);
    expect(map.stats().files).toBe(0);
    expect(map.stats().nodes).toBe(0);
    expect(map.stats().edges).toBe(0);
    map.close();
  });

  test("a file that becomes generated leaves the index rather than going stale", async () => {
    const root = repository({ "src/lib.ts": `export function helper(): number { return 1; }\n` });
    const map = open(root);
    await map.index();
    expect(map.nodeByQn("src.lib.helper")).not.toBeNull();
    write(root, "src/lib.ts", `// @generated\nexport function helper(): number { return 1; }\n`);
    const stats = await map.update(["src/lib.ts"]);
    expect(stats.skipped).toBe(1);
    expect(stats.removed).toBe(1);
    expect(map.nodeByQn("src.lib.helper")).toBeNull();
    map.close();
  });
});

describe("write guards", () => {
  test("a canonical no-op does no work at all", async () => {
    const root = repository(FIXTURE);
    const map = open(root);
    await map.index();
    const before = canonical(map);
    const ids = map.store.allNodes().map((node) => node.id);

    const stats = await map.update(["packages/core/src/engine.ts", "packages/app/src/app.ts"]);
    expect(stats.changed).toBe(0);
    expect(stats.unchanged).toBe(2);
    expect(stats.reresolved).toBe(0);
    expect(canonical(map)).toEqual(before);
    expect(map.store.allNodes().map((node) => node.id)).toEqual(ids);
    map.close();
  });

  test("a full index refuses to accept a repository that appears to have vanished", async () => {
    const root = repository(FIXTURE);
    const map = open(root);
    await map.index();
    const before = canonical(map);

    for (const path of Object.keys(FIXTURE)) remove(root, path);
    await expect(map.index()).rejects.toThrow(NodeCollapseError);
    expect(canonical(map)).toEqual(before);

    // The same collapse is accepted when the caller says so.
    const forced = await map.index({ force: true });
    expect(forced.files).toBe(0);
    expect(map.stats().nodes).toBe(0);
    map.close();
  });

  test("a full index refuses a walk that lost more than half the repository", async () => {
    const root = repository(FIXTURE);
    const map = open(root);
    await map.index();
    for (const path of Object.keys(FIXTURE).filter((path) => /\.(ts|py)$/.test(path))) remove(root, path);
    await expect(map.index()).rejects.toThrow(/less than half/);
    expect(map.stats().files).toBe(12);
    map.close();
  });

  test("symbols outside the touched files can never disappear", async () => {
    const root = repository(FIXTURE);
    const map = open(root);
    await map.index();
    const untouched = map.store.allNodes().filter((node) => !node.file.startsWith("packages/app")).length;
    write(root, "packages/app/src/format.ts", `export function format(value: number): string { return \`${"$"}{value}\`; }\n`);
    await map.update(["packages/app/src/format.ts"]);
    expect(map.store.allNodes().filter((node) => !node.file.startsWith("packages/app")).length).toBe(untouched);
    map.close();
  });
});

describe("staleness", () => {
  test("report out-of-band edits, additions, and deletions", async () => {
    const root = repository(FIXTURE);
    const map = open(root);
    await map.index();
    expect(await map.stale()).toEqual({ added: [], changed: [], removed: [] });

    write(root, "packages/app/src/format.ts", `export function format(value: number): string { return "changed"; }\n`);
    write(root, "packages/app/src/fresh.ts", `export const fresh = 1;\n`);
    remove(root, "packages/app/src/app.ts");

    expect(await map.stale()).toEqual({
      added: ["packages/app/src/fresh.ts"],
      changed: ["packages/app/src/format.ts"],
      removed: ["packages/app/src/app.ts"],
    });
    // Hashing every file must reach the same verdict as trusting mtime and size.
    expect(await map.stale({ hash: true })).toEqual(await map.stale());
    map.close();
  });

  test("a rewrite that preserves size and mtime is still caught by hashing", async () => {
    const root = repository({ "src/lib.ts": `export const value = 1;\n` });
    const map = open(root);
    await map.index();
    const stored = map.store.fileRow("src/lib.ts")!;
    write(root, "src/lib.ts", `export const value = 2;\n`);
    // Restore the recorded mtime so only the content betrays the edit.
    const { utimesSync } = await import("node:fs");
    utimesSync(join(root, "src/lib.ts"), new Date(), new Date(stored.mtimeMs));
    expect((await map.stale()).changed).toEqual([]);
    expect((await map.stale({ hash: true })).changed).toEqual(["src/lib.ts"]);
    map.close();
  });
});

describe("concurrency", () => {
  test("overlapping updates serialise instead of interleaving", async () => {
    const root = repository(FIXTURE);
    const map = open(root);
    await map.index();

    write(root, "packages/app/src/format.ts", `export function format(value: number): string { return "a"; }\n`);
    write(root, "packages/core/src/config.ts", `export interface Config { name: string; extra: number; }\nexport const DEFAULT: Config = { name: "d", extra: 1 };\n`);
    write(root, "packages/app/src/fresh.ts", `export function fresh(): number { return 1; }\n`);

    await Promise.all([
      map.update(["packages/app/src/format.ts"]),
      map.update(["packages/core/src/config.ts"]),
      map.update(["packages/app/src/fresh.ts"]),
      map.index(),
    ]);

    expect(canonical(map)).toEqual(await fromScratch(root));
    map.close();
  });

  test("a closed map refuses further writes", async () => {
    const root = repository({ "src/lib.ts": "export const a = 1;\n" });
    const map = open(root);
    await map.index();
    map.close();
    await expect(map.update(["src/lib.ts"])).rejects.toThrow(/closed/);
  });
});

describe("incremental equals a full rebuild", () => {
  /** A tiny deterministic generator, so a failure is always reproducible from its seed. */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  const MUTABLE = Object.keys(FIXTURE).filter((path) => /\.(ts|py|rs|go)$/.test(path));

  test.each([1, 7, 42, 1337, 90210])("random mutations under seed %i converge on the same graph", async (seed) => {
    const root = repository(FIXTURE);
    const map = open(root);
    await map.index();
    const next = random(seed);
    const live = new Set(MUTABLE);

    for (let round = 0; round < 4; round += 1) {
      const touched: string[] = [];
      const candidates = [...live].filter(() => next() < 0.4);
      for (const path of candidates.length > 0 ? candidates : [...live].slice(0, 1)) {
        const language = path.split(".").pop()!;
        const choice = next();
        if (choice < 0.3) {
          // Body-only: a comment the surface hash must ignore.
          write(root, path, `${readText(root, path)}\n${comment(language, round)}\n`);
          touched.push(path);
        } else if (choice < 0.55) {
          // A new exported symbol, which widens the blast radius through the unresolved table.
          write(root, path, `${readText(root, path)}\n${declaration(language, `added${round}_${slug(path)}`)}\n`);
          touched.push(path);
        } else if (choice < 0.75) {
          // A brand new file that other files may or may not already be asking for.
          const added = `${path.slice(0, path.lastIndexOf("."))}Extra${round}.${language}`;
          write(root, added, `${header(language)}${declaration(language, `extra${round}_${slug(path)}`)}\n`);
          live.add(added);
          touched.push(added);
        } else if (live.size > 4) {
          // A deletion, the harshest case for a reverse index.
          remove(root, path);
          live.delete(path);
          touched.push(path);
        }
      }
      if (touched.length === 0) continue;
      await map.update(touched);
      expect(canonical(map)).toEqual(await fromScratch(root));
    }
    map.close();
  });

  function readText(root: string, path: string): string {
    return require("node:fs").readFileSync(join(root, path), "utf8") as string;
  }
  function slug(path: string): string {
    return path.replace(/[^A-Za-z0-9]/g, "_");
  }
  function comment(language: string, round: number): string {
    return language === "py" ? `# note ${round}` : `// note ${round}`;
  }
  function header(language: string): string {
    return language === "go" ? "package extra\n\n" : "";
  }
  function declaration(language: string, name: string): string {
    switch (language) {
      case "py":
        return `def ${name}():\n    return 1`;
      case "rs":
        return `pub fn ${name}() -> u32 { 1 }`;
      case "go":
        return `func ${name.replace(/^./, (c) => c.toUpperCase())}() int { return 1 }`;
      default:
        return `export function ${name}(): number { return 1; }`;
    }
  }
});
