import { describe, expect, test } from "bun:test";
import { extractFile, MapStore, ResolveCache, resolveFile, resolveModule } from "../src/index.ts";
import type { MapEdge, StoredEdge } from "../src/index.ts";

/**
 * Build an in-memory index from a virtual repository, then resolve one of its files. The
 * store is written exactly the way {@link CodeMap} writes it: every node first, then edges.
 */
function indexed(files: Record<string, string>): MapStore {
  const store = new MapStore(":memory:");
  store.transaction(() => {
    for (const [path, content] of Object.entries(files)) {
      const extracted = extractFile(path, content);
      store.putFile({
        path,
        contentSha: extracted.contentSha,
        surfaceSha: extracted.surfaceSha,
        language: extracted.language,
        indexedAt: "2026-08-11T00:00:00.000Z",
        mtimeMs: 0,
        size: content.length,
      });
      store.writeFileNodes(path, extracted.nodes);
      store.replaceReexports(
        path,
        extracted.imports
          .filter((fact) => fact.kind === "re_export")
          .flatMap((fact) => fact.names.map((name) => ({ imported: name.imported, specifier: fact.specifier }))),
      );
    }
  });
  return store;
}

function resolved(files: Record<string, string>, target: string): { edges: MapEdge[]; unresolved: string[]; dropped: number } {
  const store = indexed(files);
  try {
    const result = resolveFile(extractFile(target, files[target]!), store);
    return {
      edges: result.edges,
      unresolved: [...result.unresolved.keys()].sort(),
      dropped: result.dropped,
    };
  } finally {
    store.close();
  }
}

function describeEdges(edges: readonly (MapEdge | StoredEdge)[]): string[] {
  return edges
    .map((edge) => {
      const source = "srcQn" in edge ? edge.srcQn : edge.src;
      const target = "dstQn" in edge ? edge.dstQn : edge.dst;
      return `${source} -${edge.relation}/${edge.confidence}-> ${target} @${edge.line}`;
    })
    .sort();
}

describe("import evidence", () => {
  test("a named import of a symbol the module defines is extracted, not guessed", () => {
    const result = resolved(
      {
        "src/util.ts": `export function helper(): number { return 1; }\n`,
        "src/app.ts": `import { helper } from "./util.ts";\nexport function run(): number { return helper(); }\n`,
      },
      "src/app.ts",
    );
    expect(describeEdges(result.edges)).toEqual([
      "src.app -imports_from/extracted-> src.util.helper @1",
      "src.app.run -calls/extracted-> src.util.helper @2",
    ]);
    expect(result.dropped).toBe(0);
  });

  test("an alias resolves to the exporting module's name, not the local one", () => {
    const result = resolved(
      {
        "src/util.ts": `export function helper(): number { return 1; }\n`,
        "src/app.ts": `import { helper as h } from "./util.ts";\nexport function run(): number { return h(); }\n`,
      },
      "src/app.ts",
    );
    expect(describeEdges(result.edges)).toContain("src.app.run -calls/extracted-> src.util.helper @2");
  });

  test("a barrel file is followed to the definition it forwards", () => {
    const result = resolved(
      {
        "src/engine.ts": `export class Engine { run(): number { return 1; } }\n`,
        "src/index.ts": `export { Engine } from "./engine.ts";\n`,
        "src/app.ts": `import { Engine } from "./index.ts";\nexport function boot(): Engine { return new Engine(); }\n`,
      },
      "src/app.ts",
    );
    expect(describeEdges(result.edges)).toEqual([
      "src.app -imports_from/extracted-> src.engine.Engine @1",
      "src.app.boot -calls/extracted-> src.engine.Engine @2",
      "src.app.boot -references/extracted-> src.engine.Engine @2",
    ]);
  });

  test("a workspace package name resolves through its own package.json entry", () => {
    const store = indexed({
      "packages/core/src/engine.ts": `export class Engine {}\n`,
      "packages/core/src/index.ts": `export { Engine } from "./engine.ts";\n`,
      "packages/app/src/app.ts": `import { Engine } from "@demo/core";\nexport function boot(): Engine { return new Engine(); }\n`,
    });
    store.putModule("@demo/core", "packages/core");
    const source = `import { Engine } from "@demo/core";\nexport function boot(): Engine { return new Engine(); }\n`;
    const result = resolveFile(extractFile("packages/app/src/app.ts", source), store);
    expect(describeEdges(result.edges)).toContain(
      "packages.app.src.app.boot -calls/extracted-> packages.core.src.engine.Engine @2",
    );
    store.close();
  });

  test("an extensionless and a .js-for-.ts specifier both find the TypeScript file", () => {
    for (const specifier of ["./util", "./util.js", "./util.ts"]) {
      const result = resolved(
        {
          "src/util.ts": `export function helper(): number { return 1; }\n`,
          "src/app.ts": `import { helper } from "${specifier}";\nexport const x = helper();\n`,
        },
        "src/app.ts",
      );
      expect(describeEdges(result.edges)).toContain("src.app -imports_from/extracted-> src.util.helper @1");
    }
  });

  test("a directory specifier resolves through its index file", () => {
    const result = resolved(
      {
        "src/parts/index.ts": `export function helper(): number { return 1; }\n`,
        "src/app.ts": `import { helper } from "./parts";\nexport const x = helper();\n`,
      },
      "src/app.ts",
    );
    expect(describeEdges(result.edges)).toContain("src.app -imports_from/extracted-> src.parts.index.helper @1");
  });

  test("a namespace import makes every name in the module import evidence", () => {
    const result = resolved(
      {
        "src/util.ts": `export function helper(): number { return 1; }\n`,
        "src/app.ts": `import * as util from "./util.ts";\nexport const x = util.helper();\n`,
      },
      "src/app.ts",
    );
    expect(describeEdges(result.edges)).toEqual([
      "src.app -imports/extracted-> src.util @1",
      "src.app.x -calls/extracted-> src.util.helper @2",
    ]);
  });
});

describe("inference and dropping", () => {
  test("a unique global name resolves as inferred, and is remembered as fragile", () => {
    const store = indexed({
      "src/other.ts": `export function loneName(): number { return 1; }\n`,
      "src/app.ts": `export function run(): number { return loneName(); }\n`,
    });
    const result = resolveFile(extractFile("src/app.ts", `export function run(): number { return loneName(); }\n`), store);
    expect(describeEdges(result.edges)).toEqual(["src.app.run -calls/inferred-> src.other.loneName @1"]);
    expect(result.dropped).toBe(0);
    expect(result.unresolved.get("loneName")).toEqual({ dropped: 0, inferred: 1 });
    store.close();
  });

  test("path proximity breaks a tie, and a true tie is dropped rather than invented", () => {
    const near = resolved(
      {
        "src/a/target.ts": `export function shared(): number { return 1; }\n`,
        "src/b/deep/target.ts": `export function shared(): number { return 2; }\n`,
        "src/a/app.ts": `export function run(): number { return shared(); }\n`,
      },
      "src/a/app.ts",
    );
    expect(describeEdges(near.edges)).toEqual(["src.a.app.run -calls/inferred-> src.a.target.shared @1"]);

    const tied = resolved(
      {
        "src/a/target.ts": `export function shared(): number { return 1; }\n`,
        "src/b/target.ts": `export function shared(): number { return 2; }\n`,
        "src/app.ts": `export function run(): number { return shared(); }\n`,
      },
      "src/app.ts",
    );
    expect(tied.edges).toEqual([]);
    expect(tied.dropped).toBe(1);
    expect(tied.unresolved).toEqual(["shared"]);
  });

  test("a name nothing defines is dropped and remembered, never dangled", () => {
    const result = resolved({ "src/app.ts": `export function run(): number { return missingName(); }\n` }, "src/app.ts");
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual(["missingName"]);
    expect(result.dropped).toBe(1);
  });

  test("a language builtin nobody imported is neither guessed at nor remembered", () => {
    const result = resolved(
      {
        "src/decoy.ts": `export function stringify(): string { return ""; }\n`,
        "src/app.ts": `export function run(): string { return JSON.stringify({}); }\n`,
      },
      "src/app.ts",
    );
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  test("an explicitly imported name outranks the builtin list", () => {
    const result = resolved(
      {
        "src/factory.ts": `export function create(): number { return 1; }\n`,
        "src/app.ts": `import { create } from "./factory.ts";\nexport const x = create();\n`,
      },
      "src/app.ts",
    );
    expect(describeEdges(result.edges)).toContain("src.app.x -calls/extracted-> src.factory.create @2");
  });

  test("a missing relative module is remembered; a missing external one is not", () => {
    const local = resolved({ "src/app.ts": `import { Later } from "./later.ts";\nexport const x: Later = 1;\n` }, "src/app.ts");
    expect(local.unresolved).toEqual(["Later", "later"]);

    const external = resolved({ "src/app.ts": `import { readFile } from "node:fs";\nexport const x = readFile;\n` }, "src/app.ts");
    expect(external.unresolved).toEqual([]);
    expect(external.dropped).toBe(0);
  });
});

describe("the language boundary", () => {
  test("a TypeScript name never resolves into another language, however unique it is", () => {
    const result = resolved(
      {
        "crates/core/src/lib.rs": `pub fn uniqueThing() -> u32 { 1 }\n`,
        "app/main.py": `def uniqueThing():\n    return 1\n`,
        "src/app.ts": `export function run(): number { return uniqueThing(); }\n`,
      },
      "src/app.ts",
    );
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual(["uniqueThing"]);
  });

  test("the same name does resolve within its own family, TSX included", () => {
    const result = resolved(
      {
        "src/widget.tsx": `export function uniqueThing(): number { return 1; }\n`,
        "src/app.ts": `export function run(): number { return uniqueThing(); }\n`,
      },
      "src/app.ts",
    );
    expect(describeEdges(result.edges)).toEqual(["src.app.run -calls/inferred-> src.widget.uniqueThing @1"]);
  });
});

describe("module resolution per language", () => {
  const store = indexed({
    "src/util.ts": "export const a = 1;\n",
    "src/parts/index.ts": "export const b = 1;\n",
    "app/pkg/mod.py": "X = 1\n",
    "app/pkg/__init__.py": "Y = 1\n",
    "app/sibling.py": "Z = 1\n",
    "crates/core/src/lib.rs": "pub const A: u32 = 1;\n",
    "crates/core/src/foo/mod.rs": "pub const B: u32 = 1;\n",
    "crates/core/src/bar.rs": "pub const C: u32 = 1;\n",
    "go/svc/store/item.go": "package store\n",
    "go/svc/main.go": "package main\n",
  });
  const cache = new ResolveCache();
  const resolveFrom = (path: string, language: Parameters<typeof resolveModule>[1]["language"], specifier: string): readonly string[] =>
    resolveModule(specifier, { path, language }, store, cache);

  test("TypeScript relative paths, index files, and node builtins", () => {
    expect(resolveFrom("src/app.ts", "typescript", "./util.ts")).toEqual(["src/util.ts"]);
    expect(resolveFrom("src/app.ts", "typescript", "./parts")).toEqual(["src/parts/index.ts"]);
    expect(resolveFrom("src/deep/app.ts", "typescript", "../util.ts")).toEqual(["src/util.ts"]);
    expect(resolveFrom("src/app.ts", "typescript", "node:path")).toEqual([]);
    expect(resolveFrom("src/app.ts", "typescript", "left-pad")).toEqual([]);
  });

  test("Python dotted modules, packages, and relative imports", () => {
    expect(resolveFrom("app/main.py", "python", "pkg.mod")).toEqual(["app/pkg/mod.py"]);
    expect(resolveFrom("app/main.py", "python", "pkg")).toEqual(["app/pkg/__init__.py"]);
    expect(resolveFrom("app/pkg/mod.py", "python", ".")).toEqual(["app/pkg/__init__.py"]);
    expect(resolveFrom("app/pkg/mod.py", "python", "..sibling")).toEqual(["app/sibling.py"]);
  });

  test("Rust crate, super, and module directories", () => {
    expect(resolveFrom("crates/core/src/lib.rs", "rust", "crate::bar")).toEqual(["crates/core/src/bar.rs"]);
    expect(resolveFrom("crates/core/src/lib.rs", "rust", "crate::foo")).toEqual(["crates/core/src/foo/mod.rs"]);
    expect(resolveFrom("crates/core/src/foo/mod.rs", "rust", "super::bar")).toEqual(["crates/core/src/bar.rs"]);
    expect(resolveFrom("crates/core/src/lib.rs", "rust", "std::collections")).toEqual([]);
  });

  test("Go import paths resolve to the package directory's files", () => {
    expect(resolveFrom("go/svc/main.go", "go", "example.com/svc/store")).toEqual(["go/svc/store/item.go"]);
    expect(resolveFrom("go/svc/main.go", "go", "fmt")).toEqual([]);
  });
});

describe("cross-language resolution in practice", () => {
  test("Python relative imports carry names across files", () => {
    const result = resolved(
      {
        "app/helpers.py": `def compute(x):\n    return x\n`,
        "app/main.py": `from .helpers import compute\n\ndef run():\n    return compute(1)\n`,
      },
      "app/main.py",
    );
    expect(describeEdges(result.edges)).toEqual([
      "app.main -imports_from/extracted-> app.helpers.compute @1",
      "app.main.run -calls/extracted-> app.helpers.compute @4",
    ]);
  });

  test("Rust use declarations carry names across modules", () => {
    const result = resolved(
      {
        "crates/core/src/thing.rs": `pub struct Thing { pub n: u32 }\n`,
        "crates/core/src/lib.rs": `use crate::thing::Thing;\n\npub fn build() -> Thing { Thing { n: 1 } }\n`,
      },
      "crates/core/src/lib.rs",
    );
    expect(new Set(describeEdges(result.edges))).toEqual(
      new Set([
        "crates.core.src.lib -imports_from/extracted-> crates.core.src.thing.Thing @1",
        "crates.core.src.lib.build -references/extracted-> crates.core.src.thing.Thing @3",
      ]),
    );
  });

  test("a Go package import makes the package's exported names resolvable", () => {
    const result = resolved(
      {
        "go/svc/store/item.go": `package store\n\ntype Item struct { Name string }\n\nfunc Load() *Item { return &Item{} }\n`,
        "go/svc/main.go": `package main\n\nimport "example.com/svc/store"\n\nfunc run() { store.Load() }\n`,
      },
      "go/svc/main.go",
    );
    expect(describeEdges(result.edges)).toEqual([
      "go.svc.main -imports/extracted-> go.svc.store.item @3",
      "go.svc.main.run -calls/extracted-> go.svc.store.item.Load @5",
    ]);
  });
});
