import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MapStore, SCHEMA_VERSION, toFtsQuery } from "../src/index.ts";
import type { MapEdge, MapNode } from "../src/index.ts";

const directories: string[] = [];

function temporaryPath(nested = false): string {
  const directory = mkdtempSync(join(tmpdir(), "lyra-map-store-"));
  directories.push(directory);
  return nested ? join(directory, "deep", ".lyra", "map.db") : join(directory, "map.db");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function node(qn: string, overrides: Partial<MapNode> = {}): MapNode {
  return {
    qn,
    name: qn.split(".").pop()!,
    kind: "function",
    file: "src/lib.ts",
    start: 1,
    end: 2,
    signature: null,
    ...overrides,
  };
}

function edge(src: string, dst: string, overrides: Partial<MapEdge> = {}): MapEdge {
  return {
    src,
    dst,
    relation: "calls",
    context: "call",
    confidence: "extracted",
    file: "src/lib.ts",
    line: 1,
    ...overrides,
  };
}

function seeded(): MapStore {
  const store = new MapStore(":memory:");
  store.transaction(() => {
    store.putFile({
      path: "src/lib.ts",
      contentSha: "a",
      surfaceSha: "b",
      language: "typescript",
      indexedAt: "2026-08-11T00:00:00.000Z",
      mtimeMs: 1,
      size: 2,
    });
    store.writeFileNodes("src/lib.ts", [
      node("src.lib", { kind: "file", name: "lib.ts" }),
      node("src.lib.updateCloudClient"),
      node("src.lib.helper"),
    ]);
    store.replaceEdges("src/lib.ts", [edge("src.lib.updateCloudClient", "src.lib.helper")]);
  });
  return store;
}

describe("schema and durability", () => {
  test("create its parent directory, lock the file down, and stamp the schema version", () => {
    const path = temporaryPath(true);
    const store = new MapStore(path);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    store.close();

    const raw = new Database(path, { strict: true });
    expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_VERSION);
    expect(raw.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    raw.close(false);
  });

  test("an older schema is rebuilt from scratch rather than migrated", () => {
    const path = temporaryPath();
    const store = new MapStore(path);
    store.transaction(() => store.writeFileNodes("src/lib.ts", [node("src.lib.old")]));
    expect(store.counts().nodes).toBe(1);
    store.close();

    const raw = new Database(path, { strict: true });
    raw.exec("PRAGMA user_version = 0");
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close(false);

    const reopened = new MapStore(path);
    expect(reopened.counts()).toMatchObject({ files: 0, nodes: 0, edges: 0 });
    expect(reopened.nodeByQn("src.lib.old")).toBeNull();
    reopened.close();
  });

  test("a closed store refuses further transactions", () => {
    const store = new MapStore(":memory:");
    store.close();
    expect(() => store.transaction(() => undefined)).toThrow(/closed/);
    store.close();
  });
});

describe("node identity", () => {
  test("a surviving qualified name keeps its row id across a rewrite", () => {
    const store = seeded();
    const before = store.nodeByQn("src.lib.helper")!;
    store.transaction(() =>
      store.writeFileNodes("src/lib.ts", [
        node("src.lib", { kind: "file", name: "lib.ts" }),
        node("src.lib.updateCloudClient", { start: 40, end: 44 }),
        node("src.lib.helper", { start: 50, end: 55, signature: "function helper(): number" }),
      ]),
    );
    const after = store.nodeByQn("src.lib.helper")!;
    expect(after.id).toBe(before.id);
    expect(after).toMatchObject({ start: 50, end: 55, signature: "function helper(): number" });
    store.close();
  });

  test("a qualified name that disappears takes its inbound edges with it, never dangling", () => {
    const store = seeded();
    expect(store.edgesTo("src.lib.helper")).toHaveLength(1);
    store.transaction(() =>
      store.writeFileNodes("src/lib.ts", [node("src.lib", { kind: "file", name: "lib.ts" }), node("src.lib.updateCloudClient")]),
    );
    expect(store.nodeByQn("src.lib.helper")).toBeNull();
    expect(store.allEdges()).toEqual([]);
    store.close();
  });

  test("deleting a file clears its nodes, edges, mentions, and search rows in one pass", () => {
    const store = seeded();
    store.transaction(() => store.replaceUnresolved("src/lib.ts", new Map([["missing", { dropped: 2, inferred: 0 }]])));
    expect(store.searchFts("updateCloud")).toHaveLength(1);
    store.transaction(() => store.deleteFile("src/lib.ts"));
    expect(store.counts()).toMatchObject({ files: 0, nodes: 0, edges: 0, unresolved: 0 });
    expect(store.searchFts("updateCloud")).toEqual([]);
    store.close();
  });

  test("an edge whose endpoint does not exist is refused and counted, never written", () => {
    const store = seeded();
    let dangling = 0;
    store.transaction(() => {
      dangling = store.addEdges([edge("src.lib.helper", "src.absent.symbol")]);
    });
    expect(dangling).toBe(1);
    expect(store.edgesFrom("src.lib.helper")).toEqual([]);
    store.close();
  });

  test("a repeated edge site is written once", () => {
    const store = seeded();
    store.transaction(() =>
      store.replaceEdges("src/lib.ts", [
        edge("src.lib.updateCloudClient", "src.lib.helper"),
        edge("src.lib.updateCloudClient", "src.lib.helper"),
        edge("src.lib.updateCloudClient", "src.lib.helper", { line: 2 }),
      ]),
    );
    expect(store.allEdges()).toHaveLength(2);
    store.close();
  });
});

describe("queries", () => {
  test("edges carry the site, and filters narrow by relation and confidence", () => {
    const store = seeded();
    store.transaction(() =>
      store.addEdges([
        edge("src.lib", "src.lib.helper", { relation: "defines", context: null, line: 9 }),
        edge("src.lib.helper", "src.lib.updateCloudClient", { confidence: "inferred", line: 12 }),
      ]),
    );
    expect(store.edgesFrom("src.lib", { relations: ["defines"] }).map((row) => `${row.dstQn}@${row.file}:${row.line}`)).toEqual([
      "src.lib.helper@src/lib.ts:9",
    ]);
    expect(store.edgesFrom("src.lib.helper", { confidence: "inferred" })).toHaveLength(1);
    expect(store.edgesFrom("src.lib.helper", { confidence: "extracted" })).toEqual([]);
    expect(store.edgesFrom("nothing.here")).toEqual([]);
    store.close();
  });

  test("names are looked up exactly, and confined to a language family on request", () => {
    const store = seeded();
    store.transaction(() => {
      store.putFile({
        path: "crates/x/src/lib.rs",
        contentSha: "c",
        surfaceSha: "d",
        language: "rust",
        indexedAt: "2026-08-11T00:00:00.000Z",
        mtimeMs: 1,
        size: 2,
      });
      store.writeFileNodes("crates/x/src/lib.rs", [node("crates.x.src.lib.helper", { file: "crates/x/src/lib.rs" })]);
    });
    expect(store.nodesByName("helper").map((row) => row.qn)).toEqual(["crates.x.src.lib.helper", "src.lib.helper"]);
    expect(store.nodesByName("helper", "js").map((row) => row.qn)).toEqual(["src.lib.helper"]);
    expect(store.nodesByName("helper", "rust").map((row) => row.qn)).toEqual(["crates.x.src.lib.helper"]);
    expect(store.nodesByName("nothing")).toEqual([]);
    store.close();
  });

  test("full-text search splits identifiers and requires every term", () => {
    const store = seeded();
    expect(store.searchFts("update cloud").map((row) => row.qn)).toEqual(["src.lib.updateCloudClient"]);
    expect(store.searchFts("updateCloud").map((row) => row.qn)).toEqual(["src.lib.updateCloudClient"]);
    expect(store.searchFts("cloud missing")).toEqual([]);
    expect(store.searchFts("lib").map((row) => row.qn).length).toBeGreaterThan(0);
    expect(store.searchFts("update", 0)).toEqual([]);
    expect(() => store.searchFts("update", -1)).toThrow(RangeError);
    expect(toFtsQuery("  ,  ")).toBeNull();
    store.close();
  });

  test("path helpers answer exactly, without touching the filesystem", () => {
    const store = seeded();
    store.transaction(() => {
      for (const path of ["go/svc/store/item.go", "go/svc/store/other.go", "go/svc/main.go"]) {
        store.putFile({ path, contentSha: "c", surfaceSha: "d", language: "go", indexedAt: "t", mtimeMs: 0, size: 0 });
      }
    });
    expect(store.hasFile("src/lib.ts")).toBe(true);
    expect(store.hasFile("src/nope.ts")).toBe(false);
    expect(store.filesInDir("go/svc/store")).toEqual(["go/svc/store/item.go", "go/svc/store/other.go"]);
    expect(store.filesInDir("go/svc")).toEqual(["go/svc/main.go"]);
    expect(store.filesWithSuffix("store/item.go")).toEqual(["go/svc/store/item.go"]);
    expect(store.filesInDirSuffix("store")).toEqual(["go/svc/store/item.go", "go/svc/store/other.go"]);
    store.close();
  });

  test("mentions are replaced wholesale and index by name", () => {
    const store = seeded();
    store.transaction(() => {
      store.replaceUnresolved("src/lib.ts", new Map([["future", { dropped: 3, inferred: 0 }], ["fuzzy", { dropped: 0, inferred: 1 }]]));
    });
    expect(store.filesMentioning(["future"])).toEqual(["src/lib.ts"]);
    expect(store.filesMentioning(["fuzzy"])).toEqual(["src/lib.ts"]);
    expect(store.filesMentioning(["absent"])).toEqual([]);
    expect(store.filesMentioning([])).toEqual([]);
    expect(store.unresolvedNames("src/lib.ts")).toEqual(["future", "fuzzy"]);
    expect(store.counts().dropped).toBe(3);

    store.transaction(() => store.replaceUnresolved("src/lib.ts", new Map()));
    expect(store.filesMentioning(["future"])).toEqual([]);
    store.close();
  });

  test("dependents are found through the reverse index, by target file", () => {
    const store = seeded();
    store.transaction(() => {
      store.putFile({ path: "src/app.ts", contentSha: "c", surfaceSha: "d", language: "typescript", indexedAt: "t", mtimeMs: 0, size: 0 });
      store.writeFileNodes("src/app.ts", [node("src.app", { kind: "file", name: "app.ts", file: "src/app.ts" })]);
      store.replaceEdges("src/app.ts", [edge("src.app", "src.lib.helper", { file: "src/app.ts", line: 3 })]);
    });
    expect(store.dependentsOf(["src/lib.ts"])).toEqual(["src/app.ts", "src/lib.ts"]);
    expect(store.dependentsOf(["src/app.ts"])).toEqual([]);
    expect(store.dependentsOf([])).toEqual([]);
    store.close();
  });

  test("counting symbols outside a set is what the collapse guard watches", () => {
    const store = seeded();
    expect(store.nodesOutside([])).toBe(3);
    expect(store.nodesOutside(["src/lib.ts"])).toBe(0);
    store.close();
  });

  test("meta and module tables round-trip", () => {
    const store = seeded();
    store.transaction(() => {
      store.metaSet("root", "/tmp/x");
      store.metaSet("root", "/tmp/y");
      store.putModule("@demo/core", "packages/core");
    });
    expect(store.metaGet("root")).toBe("/tmp/y");
    expect(store.metaGet("absent")).toBeNull();
    expect([...store.modules()]).toEqual([["@demo/core", "packages/core"]]);
    store.transaction(() => store.clearModules());
    expect(store.modules().size).toBe(0);
    store.close();
  });
});
