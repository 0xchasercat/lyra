import { describe, expect, test } from "bun:test";
import { extractFile, fileQn, isTestPath, splitIdentifier, stripExtension } from "../src/index.ts";
import type { ExtractedFile, MapEdge } from "../src/index.ts";

function symbols(result: ExtractedFile): string[] {
  return result.nodes.map((node) => `${node.kind} ${node.qn}`);
}

function relations(result: ExtractedFile, ...wanted: MapEdge["relation"][]): string[] {
  const set = new Set(wanted);
  return result.edges
    .filter((edge) => set.has(edge.relation))
    .map((edge) => `${edge.src} -${edge.relation}${edge.context ? `:${edge.context}` : ""}-> ${edge.dst} @${edge.line}`);
}

function facts(result: ExtractedFile): string[] {
  return result.references.map(
    (reference) =>
      `${reference.from} -> ${reference.name} (${reference.relation}/${reference.context ?? "-"}/${reference.hint}${reference.builtin ? "/builtin" : ""}) @${reference.line}`,
  );
}

describe("qualified names", () => {
  test("root a file at the repository, preserve case, and strip only the known extension", () => {
    expect(fileQn("packages/lyra-core/src/agent-loop.ts")).toBe("packages.lyra-core.src.agent-loop");
    expect(fileQn("pkg/store/Item_test.go")).toBe("pkg.store.Item_test");
    expect(fileQn("src/app.test.ts")).toBe("src.app.test");
    expect(stripExtension("a/b/c.tsx")).toBe("a/b/c");
    expect(stripExtension("a/b/Makefile")).toBe("a/b/Makefile");
  });

  test("detect test files by every convention the repository uses", () => {
    expect(isTestPath("packages/x/test/app.test.ts")).toBe(true);
    expect(isTestPath("pkg/store/item_test.go")).toBe(true);
    expect(isTestPath("app/tests/helpers.py")).toBe(true);
    expect(isTestPath("app/test_widget.py")).toBe(true);
    expect(isTestPath("src/widget.spec.tsx")).toBe(true);
    expect(isTestPath("src/attestation.ts")).toBe(false);
    expect(isTestPath("src/latest.ts")).toBe(false);
  });

  test("split identifiers for search without losing the original", () => {
    expect(splitIdentifier("updateCloudClient")).toBe("updatecloudclient update cloud client");
    expect(splitIdentifier("parse_http_response")).toBe("parse_http_response parse http response");
    expect(splitIdentifier("lyra-core")).toBe("lyra-core lyra core");
    expect(splitIdentifier("parseHTTPResponse")).toBe("parsehttpresponse parse http response");
    expect(splitIdentifier("base64Encode")).toBe("base64encode base 64 encode");
  });
});

describe("TypeScript extraction", () => {
  const source = `import { helper } from "./util.ts";
import type { Config } from "./config.ts";
export { Shape } from "./shape.ts";

export class Widget extends Base implements Shape {
  name: string;
  private cache: Map<string, Config>;
  render(target: Canvas): Output {
    this.paint(target);
    return helper(target);
  }
  private paint(t: Canvas): void {}
}

export interface Sized extends Measured { area(): number; }
export type Alias = Widget;
export enum Mode { A, B }
export const factory = (n: number): Widget => new Widget(n);
export function build(mode: Mode): Widget { return factory(1); }
function local() { return build(Mode.A); }
`;
  const result = extractFile("packages/demo/src/widget.ts", source);

  test("emit one node per declaration, with kinds, ranges, and a body-free signature", () => {
    expect(symbols(result)).toEqual([
      "file packages.demo.src.widget",
      "class packages.demo.src.widget.Widget",
      "field packages.demo.src.widget.Widget.name",
      "field packages.demo.src.widget.Widget.cache",
      "method packages.demo.src.widget.Widget.render",
      "method packages.demo.src.widget.Widget.paint",
      "interface packages.demo.src.widget.Sized",
      "method packages.demo.src.widget.Sized.area",
      "type packages.demo.src.widget.Alias",
      "enum packages.demo.src.widget.Mode",
      "field packages.demo.src.widget.Mode.A",
      "field packages.demo.src.widget.Mode.B",
      "function packages.demo.src.widget.factory",
      "function packages.demo.src.widget.build",
      "function packages.demo.src.widget.local",
    ]);
    expect(result.nodes.find((node) => node.qn.endsWith(".render"))).toMatchObject({
      start: 8,
      end: 11,
      signature: "render(target: Canvas): Output",
    });
    expect(result.nodes[0]).toMatchObject({ kind: "file", start: 1, end: 20, signature: null });
    expect(result.nodes.find((node) => node.name === "Widget")).toMatchObject({
      start: 5,
      end: 13,
      signature: "class Widget extends Base implements Shape",
    });
  });

  test("contains follows nesting while defines flattens the whole file", () => {
    expect(relations(result, "contains")).toContain(
      "packages.demo.src.widget.Widget -contains-> packages.demo.src.widget.Widget.render @8",
    );
    expect(relations(result, "defines")).toContain(
      "packages.demo.src.widget -defines-> packages.demo.src.widget.Widget.render @8",
    );
    expect(result.edges.filter((edge) => edge.relation === "defines")).toHaveLength(result.nodes.length - 1);
  });

  test("settle same-file uses as extracted edges at the use site's line", () => {
    expect(relations(result, "calls", "references", "implements", "extends")).toEqual([
      "packages.demo.src.widget.Widget.render -calls:call-> packages.demo.src.widget.Widget.paint @9",
      "packages.demo.src.widget.Alias -references-> packages.demo.src.widget.Widget @16",
      "packages.demo.src.widget.factory -references:return_type-> packages.demo.src.widget.Widget @18",
      "packages.demo.src.widget.factory -calls:call-> packages.demo.src.widget.Widget @18",
      "packages.demo.src.widget.build -references:return_type-> packages.demo.src.widget.Widget @19",
      "packages.demo.src.widget.build -references:parameter_type-> packages.demo.src.widget.Mode @19",
      "packages.demo.src.widget.build -calls:call-> packages.demo.src.widget.factory @19",
      "packages.demo.src.widget.local -calls:call-> packages.demo.src.widget.build @20",
    ]);
    for (const edge of result.edges) expect(edge.confidence).toBe("extracted");
  });

  test("hand every unsettled name to the resolver, with its site and its shape", () => {
    expect(facts(result)).toEqual([
      "packages.demo.src.widget.Widget -> Base (extends/-/type) @5",
      "packages.demo.src.widget.Widget -> Shape (implements/-/type) @5",
      "packages.demo.src.widget.Widget.cache -> Map (references/field/type/builtin) @7",
      "packages.demo.src.widget.Widget.cache -> Config (references/generic_arg/type) @7",
      "packages.demo.src.widget.Widget.render -> Output (references/return_type/type) @8",
      "packages.demo.src.widget.Widget.render -> Canvas (references/parameter_type/type) @8",
      "packages.demo.src.widget.Widget.render -> helper (calls/call/call) @10",
      "packages.demo.src.widget.Widget.paint -> Canvas (references/parameter_type/type) @12",
      "packages.demo.src.widget.Sized -> Measured (extends/-/type) @15",
    ]);
  });

  test("record imports and re-exports verbatim, resolving nothing", () => {
    expect(result.imports).toEqual([
      { specifier: "./util.ts", names: [{ imported: "helper", local: "helper" }], kind: "import", line: 1 },
      { specifier: "./config.ts", names: [{ imported: "Config", local: "Config" }], kind: "import", line: 2 },
      { specifier: "./shape.ts", names: [{ imported: "Shape", local: "Shape" }], kind: "re_export", line: 3 },
    ]);
  });

  test("aliases, namespaces, and defaults keep both names", () => {
    const aliased = extractFile("a/b.ts", `import def, { A as B } from "./m.ts";\nimport * as ns from "./n.ts";\nexport * from "./o.ts";\n`);
    expect(aliased.imports).toEqual([
      { specifier: "./m.ts", names: [{ imported: "default", local: "def" }, { imported: "A", local: "B" }], kind: "import", line: 1 },
      { specifier: "./n.ts", names: [{ imported: "*", local: "ns" }], kind: "import", line: 2 },
      { specifier: "./o.ts", names: [{ imported: "*", local: "*" }], kind: "re_export", line: 3 },
    ]);
  });

  test("export only what leaves the file, and keep module data out unless it does", () => {
    expect(result.exports).toEqual(["Alias", "Mode", "Sized", "Widget", "build", "factory"]);
    const internal = extractFile("a/b.ts", `const hidden = 1;\nexport const shown = 2;\nconst run = () => 3;\n`);
    expect(symbols(internal)).toEqual(["file a.b", "field a.b.shown", "function a.b.run"]);
    expect(internal.exports).toEqual(["shown"]);
  });

  test("TSX is the same extractor with a different grammar", () => {
    const tsx = extractFile("app/View.tsx", `export function View(props: Props) { return <div>{render(props)}</div>; }\n`);
    expect(tsx.language).toBe("tsx");
    expect(symbols(tsx)).toEqual(["file app.View", "function app.View.View"]);
    expect(facts(tsx).some((fact) => fact.includes("-> render"))).toBe(true);
  });
});

describe("Python extraction", () => {
  const result = extractFile("app/service.py", `import os
from .rel import Thing
from pkg.mod import Helper, Other as Alias

CONST = 1
_private = 2

class Widget(Base):
    attr: int = 0

    def render(self, target: Canvas) -> Output:
        self.paint(target)
        return Helper(target)

    def _paint(self, t):
        pass

def build(mode: Mode) -> Widget:
    return Widget()
`);

  test("classes, methods, module data, and the underscore convention", () => {
    expect(symbols(result)).toEqual([
      "file app.service",
      "field app.service.CONST",
      "field app.service._private",
      "class app.service.Widget",
      "field app.service.Widget.attr",
      "method app.service.Widget.render",
      "method app.service.Widget._paint",
      "function app.service.build",
    ]);
    expect(result.exports).toEqual(["CONST", "Widget", "build"]);
  });

  test("relative and dotted imports keep their written form", () => {
    expect(result.imports).toEqual([
      { specifier: "os", names: [{ imported: "*", local: "os" }], kind: "import", line: 1 },
      { specifier: ".rel", names: [{ imported: "Thing", local: "Thing" }], kind: "import", line: 2 },
      { specifier: "pkg.mod", names: [{ imported: "Helper", local: "Helper" }, { imported: "Other", local: "Alias" }], kind: "import", line: 3 },
    ]);
  });

  test("base classes become inherits and same-file uses resolve", () => {
    expect(facts(result)).toContain("app.service.Widget -> Base (inherits/-/type) @8");
    expect(relations(result, "calls", "references")).toEqual([
      "app.service.build -references:return_type-> app.service.Widget @18",
      "app.service.build -calls:call-> app.service.Widget @19",
    ]);
  });
});

describe("Rust extraction", () => {
  const result = extractFile("crates/core/src/item.rs", `use crate::foo::{Bar, Baz as Qux};
use super::other::Thing;

pub struct Item { pub name: String, count: u32 }
pub enum Kind { A, B }
pub trait Doer: Base { fn go(&self) -> u32; }
pub type Alias = Item;

impl Doer for Item {
    fn go(&self) -> u32 { self.helper() }
}

impl Item {
    pub fn new(name: String) -> Self { Item { name, count: 0 } }
    fn helper(&self) -> u32 { free(self.count) }
}

pub fn free(x: u32) -> Kind { Kind::A }
`);

  test("impl blocks hang their functions on the receiver type", () => {
    expect(symbols(result)).toEqual([
      "file crates.core.src.item",
      "struct crates.core.src.item.Item",
      "field crates.core.src.item.Item.name",
      "field crates.core.src.item.Item.count",
      "enum crates.core.src.item.Kind",
      "field crates.core.src.item.Kind.A",
      "field crates.core.src.item.Kind.B",
      "trait crates.core.src.item.Doer",
      "method crates.core.src.item.Doer.go",
      "type crates.core.src.item.Alias",
      "method crates.core.src.item.Item.go",
      "method crates.core.src.item.Item.new",
      "method crates.core.src.item.Item.helper",
      "function crates.core.src.item.free",
    ]);
  });

  test("a trait impl is an implements edge from the receiver, and pub drives the surface", () => {
    expect(relations(result, "implements")).toEqual(["crates.core.src.item.Item -implements-> crates.core.src.item.Doer @9"]);
    expect(relations(result, "calls")).toEqual([
      "crates.core.src.item.Item.go -calls:call-> crates.core.src.item.Item.helper @10",
      "crates.core.src.item.Item.helper -calls:call-> crates.core.src.item.free @15",
    ]);
    expect(result.exports).toEqual(["Alias", "Doer", "Item", "Kind", "free"]);
  });

  test("use declarations split the module path from the imported names", () => {
    expect(result.imports).toEqual([
      { specifier: "crate::foo", names: [{ imported: "Bar", local: "Bar" }, { imported: "Baz", local: "Qux" }], kind: "import", line: 1 },
      { specifier: "super::other", names: [{ imported: "Thing", local: "Thing" }], kind: "import", line: 2 },
    ]);
  });
});

describe("Go extraction", () => {
  const result = extractFile("pkg/store/item.go", `package store

import (
	"fmt"
	alias "example.com/x/y"
)

type Item struct {
	Name string
	count int
	Embedded
}

type Doer interface {
	Go() int
}

const Version = "1"

func (i *Item) Method(a Arg) Result { return helper(a) }

func Top(x int) *Item { return &Item{} }
`);

  test("receivers own their methods and capitalisation drives the surface", () => {
    expect(symbols(result)).toEqual([
      "file pkg.store.item",
      "struct pkg.store.item.Item",
      "field pkg.store.item.Item.Name",
      "field pkg.store.item.Item.count",
      "interface pkg.store.item.Doer",
      "method pkg.store.item.Doer.Go",
      "field pkg.store.item.Version",
      "method pkg.store.item.Item.Method",
      "function pkg.store.item.Top",
    ]);
    expect(result.exports).toEqual(["Doer", "Item", "Top", "Version"]);
    expect(result.nodes.find((node) => node.qn.endsWith("Item.Name"))).toBeDefined();
    expect(result.nodes.find((node) => node.name === "Item")?.signature).toBe("type Item struct");
  });

  test("an embedded field is inheritance, and the import path is kept whole", () => {
    expect(facts(result)).toContain("pkg.store.item.Item -> Embedded (inherits/-/type) @11");
    expect(result.imports).toEqual([
      { specifier: "fmt", names: [{ imported: "*", local: "fmt" }], kind: "import", line: 4 },
      { specifier: "example.com/x/y", names: [{ imported: "*", local: "alias" }], kind: "import", line: 5 },
    ]);
  });

  test("a Go test file is a test node", () => {
    const test = extractFile("pkg/store/item_test.go", `package store\nfunc TestThing(t *T) { Top(1) }\n`);
    expect(test.nodes[0]).toMatchObject({ kind: "test", qn: "pkg.store.item_test" });
  });
});

describe("extraction invariants", () => {
  test("same-named siblings are disambiguated deterministically, never overwritten", () => {
    const overloads = extractFile("a/b.ts", `export function run(a: string): void;\nexport function run(a: number): void;\nexport function run(a: unknown): void {}\n`);
    expect(symbols(overloads)).toEqual([
      "file a.b",
      "function a.b.run",
      "function a.b.run#2",
      "function a.b.run#3",
    ]);
    expect(overloads.notes).toHaveLength(2);
    expect(new Set(overloads.nodes.map((node) => node.qn)).size).toBe(overloads.nodes.length);
    expect(overloads.nodes.map((node) => node.start)).toEqual([1, 1, 2, 3]);
  });

  test("extraction is a pure function of path and content", () => {
    const source = `export class A { m(): B { return c(); } }\n`;
    const first = extractFile("x/y.ts", source);
    const second = extractFile("x/y.ts", source);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const moved = extractFile("z/y.ts", source);
    expect(moved.surfaceSha).toBe(first.surfaceSha);
    expect(moved.contentSha).toBe(first.contentSha);
  });

  test("the surface hash ignores bodies, positions, and declaration order", () => {
    const base = extractFile("a/b.ts", `export function one(): number { return 1; }\nexport function two(): string { return "a"; }\n`);
    const bodies = extractFile("a/b.ts", `export function one(): number { return 111; }\n\n\nexport function two(): string { return "zzz"; }\n`);
    const reordered = extractFile("a/b.ts", `export function two(): string { return "a"; }\nexport function one(): number { return 1; }\n`);
    const renamed = extractFile("a/b.ts", `export function one(): number { return 1; }\nexport function three(): string { return "a"; }\n`);
    const retyped = extractFile("a/b.ts", `export function one(): bigint { return 1n; }\nexport function two(): string { return "a"; }\n`);
    expect(bodies.surfaceSha).toBe(base.surfaceSha);
    expect(reordered.surfaceSha).toBe(base.surfaceSha);
    expect(renamed.surfaceSha).not.toBe(base.surfaceSha);
    expect(retyped.surfaceSha).not.toBe(base.surfaceSha);
    expect(bodies.contentSha).not.toBe(base.contentSha);
  });

  test("private members stay off the surface; public members of exported types stay on it", () => {
    const open = extractFile("a/b.ts", `export class A { pub(): void {} private hidden(): void {} }\n`);
    const changedPrivate = extractFile("a/b.ts", `export class A { pub(): void {} private hidden(x: number): void {} }\n`);
    const changedPublic = extractFile("a/b.ts", `export class A { pub(x: number): void {} private hidden(): void {} }\n`);
    expect(changedPrivate.surfaceSha).toBe(open.surfaceSha);
    expect(changedPublic.surfaceSha).not.toBe(open.surfaceSha);
  });

  test("a syntax error is recovered from, never thrown", () => {
    const broken = extractFile("a/b.ts", `export function ok(): void {}\nexport class {{{ broken\n`);
    expect(broken.notes[0]).toContain("parse recovered");
    expect(symbols(broken)).toContain("function a.b.ok");
  });

  test("an unknown extension is refused rather than guessed at", () => {
    expect(() => extractFile("a/b.toml", "x = 1")).toThrow(/No code-map grammar/);
  });

  test("an empty file still yields exactly its file node", () => {
    const empty = extractFile("a/b.ts", "");
    expect(symbols(empty)).toEqual(["file a.b"]);
    expect(empty.edges).toEqual([]);
    expect(empty.exports).toEqual([]);
  });
});
