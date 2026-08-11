import Parser from "tree-sitter";
import TypeScriptGrammars from "tree-sitter-typescript";
import PythonGrammar from "tree-sitter-python";
import RustGrammar from "tree-sitter-rust";
import GoGrammar from "tree-sitter-go";
import { oneLine } from "./qn.ts";
import type { EdgeContext, EdgeRelation, ImportFact, LanguageFamily, MapLanguage, NodeKind } from "./types.ts";

export type Node = Parser.SyntaxNode;

/** One declaration the walker should turn into a node. */
export interface Declaration {
  readonly name: string;
  readonly kind: NodeKind;
  readonly exported: boolean;
  /** Whether the name is visible outside its declaring scope (drives the surface hash). */
  readonly publicMember: boolean;
  /** Scope segments inserted before the name: a Rust impl type, a Go receiver type. */
  readonly owner?: readonly string[];
  readonly signature: string;
  /** The node whose line range the symbol occupies; defaults to the declaration node. */
  readonly range?: Node;
}

/** A use site the walker turns into an edge, or hands to the resolver. */
export interface RefSite {
  readonly name: string;
  readonly relation: EdgeRelation;
  readonly context: EdgeContext | null;
  readonly hint: "call" | "type" | "value";
  readonly line: number;
  /** `this.x` / `self.x`: the target must be looked up in the enclosing type, not the file. */
  readonly onSelf?: boolean;
  /**
   * The name was written after a receiver — `x.query()`, `pkg.Load()`, `db.get()`. The
   * receiver's type is not known here, so the resolver may only settle it with import
   * evidence; a global-name guess would attach the call to whatever unrelated symbol
   * happens to share the member's name.
   */
  readonly member?: boolean;
}

/** A declared type relationship, anchored at whatever symbol scope encloses it. */
export interface HeritageSite {
  readonly name: string;
  readonly relation: "extends" | "implements" | "inherits";
  readonly line: number;
}

export interface LanguageConfig {
  readonly id: MapLanguage;
  readonly family: LanguageFamily;
  grammar(): unknown;
  /** Declaration for this node, if it declares one. `depth` is the symbol nesting depth. */
  declaration(node: Node, depth: number, exportedByParent: boolean): Declaration | undefined;
  /** Import or re-export statement carried by this node. */
  importFact(node: Node): ImportFact | undefined;
  /** Scope segments this node pushes without declaring a symbol (Rust `impl`). */
  scopeOnly(node: Node): readonly string[] | undefined;
  /** Type relationships declared at this node. */
  heritage(node: Node): readonly HeritageSite[];
  /** Reference sites originating at this node — never at its descendants, so nothing double-counts. */
  sites(node: Node): readonly RefSite[];
  /** Node types whose subtrees carry an `export`/`pub` marker for their children. */
  marksExport(node: Node): boolean;
  /** Names too common or too built-in to be worth resolving. */
  readonly builtins: ReadonlySet<string>;
}

// ---------------------------------------------------------------- shared helpers

function field(node: Node, name: string): Node | null {
  return node.childForFieldName(name);
}

function childOfType(node: Node, type: string): Node | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

function childrenOfType(node: Node, type: string): Node[] {
  return node.namedChildren.filter((child) => child.type === type);
}

/** Text of the declaration head: everything before the body, collapsed to one line. */
function head(node: Node, bodyFieldNames: readonly string[] = ["body"]): string {
  for (const name of bodyFieldNames) {
    const body = field(node, name);
    if (body) return oneLine(node.text.slice(0, body.startIndex - node.startIndex));
  }
  const firstBrace = node.text.indexOf("{");
  return oneLine(firstBrace > 0 ? node.text.slice(0, firstBrace) : node.text);
}

/**
 * Every identifier in a type-position subtree, tagged `generic_arg` when it sits inside
 * type arguments. Primitive/builtin nodes never reach here: the grammars give them their
 * own node types.
 */
function typeIdentifiers(
  root: Node | null,
  identifierTypes: ReadonlySet<string>,
  genericTypes: ReadonlySet<string>,
  baseContext: EdgeContext | null,
  relation: EdgeRelation = "references",
): RefSite[] {
  if (!root) return [];
  const sites: RefSite[] = [];
  const seen = new Set<string>();
  const visit = (node: Node, generic: boolean): void => {
    if (identifierTypes.has(node.type)) {
      const key = `${node.text}:${node.startPosition.row}:${generic}`;
      if (!seen.has(key)) {
        seen.add(key);
        sites.push({
          name: node.text,
          relation,
          context: generic ? "generic_arg" : baseContext,
          hint: "type",
          line: node.startPosition.row + 1,
        });
      }
      return;
    }
    for (const child of node.namedChildren) visit(child, generic || genericTypes.has(child.type) || genericTypes.has(node.type));
  };
  visit(root, false);
  return sites;
}

/** The called name, whether the call went through `this`/`self`, and whether it had a receiver at all. */
function calleeName(callee: Node | null, propertyTypes: ReadonlySet<string>, selfWords: ReadonlySet<string>):
  | { name: string; onSelf: boolean; member: boolean }
  | undefined {
  if (!callee) return undefined;
  if (callee.type === "identifier" || callee.type === "type_identifier" || callee.type === "field_identifier") {
    return { name: callee.text, onSelf: false, member: false };
  }
  if (propertyTypes.has(callee.type)) {
    const property = callee.childForFieldName("property") ?? callee.childForFieldName("field") ?? callee.namedChildren[callee.namedChildCount - 1];
    const object = callee.childForFieldName("object") ?? callee.childForFieldName("operand") ?? callee.namedChildren[0];
    if (!property) return undefined;
    return { name: property.text, onSelf: object !== undefined && selfWords.has(object.text), member: true };
  }
  return undefined;
}

function stringLiteralText(node: Node | null): string | undefined {
  if (!node) return undefined;
  const fragment = node.namedChildren.find((child) => child.type.includes("fragment") || child.type.includes("content"));
  if (fragment) return fragment.text;
  const raw = node.text;
  return raw.length >= 2 && (raw.startsWith('"') || raw.startsWith("'") || raw.startsWith("`")) ? raw.slice(1, -1) : raw;
}

// ---------------------------------------------------------------- TypeScript / TSX / JavaScript

const TS_TYPE_IDENTIFIERS = new Set(["type_identifier", "nested_type_identifier"]);
const TS_GENERIC = new Set(["type_arguments"]);
const TS_CALLEE_PROPERTY = new Set(["member_expression"]);
const TS_SELF = new Set(["this"]);
const TS_FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function"]);

/**
 * Names that belong to the language, its standard library, or its test runner. A reference
 * to one of these is never worth a global-name guess and never worth remembering as
 * unresolved. Project code that defines its own `expect` still wins: same-file lookup runs
 * before this list is consulted.
 */
const TS_BUILTINS = new Set([
  // Globals and constructors
  "console", "require", "globalThis", "process", "Object", "Array", "String", "Number", "Boolean", "Function",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "JSON", "Math", "Date", "RegExp", "Symbol", "BigInt", "Proxy",
  "Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "Buffer", "URL", "URLSearchParams",
  "Uint8Array", "Int8Array", "Uint16Array", "Uint32Array", "Float32Array", "Float64Array", "ArrayBuffer", "DataView",
  "AbortController", "AbortSignal", "Response", "Request", "Headers", "Blob", "FormData", "TextEncoder", "TextDecoder",
  "Intl", "Reflect", "structuredClone", "queueMicrotask", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  // Utility types
  "Record", "Partial", "Required", "Readonly", "Pick", "Omit", "Exclude", "Extract", "NonNullable", "ReturnType",
  "Parameters", "ConstructorParameters", "InstanceType", "Awaited", "ThisType", "Iterable", "Iterator",
  "AsyncIterable", "AsyncIterator", "ArrayLike", "ReadonlyArray", "ReadonlySet", "ReadonlyMap", "PromiseLike",
  "Generator", "AsyncGenerator", "NodeJS", "Uppercase", "Lowercase", "Capitalize", "Uncapitalize",
  // Ubiquitous methods
  "log", "error", "warn", "info", "debug", "trace", "push", "pop", "shift", "unshift", "slice", "splice", "join",
  "split", "map", "filter", "reduce", "flatMap", "forEach", "find", "findIndex", "includes", "indexOf", "has",
  "get", "set", "add", "delete", "clear", "keys", "values", "entries", "then", "catch", "finally", "toString",
  "valueOf", "length", "call", "apply", "bind", "match", "matchAll", "replace", "replaceAll", "trim", "trimStart",
  "trimEnd", "concat", "sort", "reverse", "some", "every", "at", "padStart", "padEnd", "startsWith", "endsWith",
  "toLowerCase", "toUpperCase", "repeat", "charAt", "charCodeAt", "codePointAt", "normalize", "flat", "fill",
  "stringify", "parse", "freeze", "assign", "create", "defineProperty", "getPrototypeOf", "fromEntries", "isArray",
  "max", "min", "abs", "round", "floor", "ceil", "random", "now", "all", "allSettled", "race", "resolve", "reject",
  // Test runners
  "describe", "test", "it", "expect", "beforeEach", "afterEach", "beforeAll", "afterAll", "mock", "spyOn", "jest",
  "toBe", "toEqual", "toStrictEqual", "toContain", "toContainEqual", "toMatch", "toMatchObject", "toThrow",
  "toBeDefined", "toBeUndefined", "toBeNull", "toBeTruthy", "toBeFalsy", "toBeGreaterThan", "toBeLessThan",
  "toBeGreaterThanOrEqual", "toBeLessThanOrEqual", "toBeCloseTo", "toBeInstanceOf", "toHaveLength",
  "toHaveProperty", "toHaveBeenCalled", "toHaveBeenCalledWith", "toHaveBeenCalledTimes", "toMatchSnapshot",
  "rejects", "resolves", "not", "skip", "only", "todo", "each",
]);

function tsAccessibility(node: Node): string | undefined {
  return node.namedChildren.find((child) => child.type === "accessibility_modifier")?.text;
}

function tsFunctionSites(node: Node): RefSite[] {
  return typeIdentifiers(field(node, "return_type"), TS_TYPE_IDENTIFIERS, TS_GENERIC, "return_type");
}

/** Annotation parents whose types a more specific rule already reported, with a better context. */
const TS_CLAIMED_ANNOTATION_PARENTS = new Set([
  "required_parameter", "optional_parameter", "public_field_definition", "property_signature",
  "function_declaration", "generator_function_declaration", "method_definition", "method_signature",
  "abstract_method_signature", "arrow_function", "function_expression", "function_signature",
]);

const TYPESCRIPT_KINDS = new Map<string, NodeKind>([
  ["class_declaration", "class"],
  ["abstract_class_declaration", "class"],
  ["interface_declaration", "interface"],
  ["enum_declaration", "enum"],
  ["type_alias_declaration", "type"],
  ["function_declaration", "function"],
  ["generator_function_declaration", "function"],
  // An overload signature is a declaration in its own right; it collides with the
  // implementation on purpose, and the qualified-name disambiguator keeps both.
  ["function_signature", "function"],
  ["method_definition", "method"],
  ["method_signature", "method"],
  ["abstract_method_signature", "method"],
  ["public_field_definition", "field"],
  ["property_signature", "field"],
  ["enum_assignment", "field"],
]);

function typescriptConfig(id: "typescript" | "tsx" | "javascript"): LanguageConfig {
  return {
    id,
    family: "js",
    grammar: () => (id === "tsx" ? TypeScriptGrammars.tsx : TypeScriptGrammars.typescript),
    builtins: TS_BUILTINS,

    marksExport: (node) => node.type === "export_statement",

    declaration(node, depth, exportedByParent) {
      const kind = TYPESCRIPT_KINDS.get(node.type);
      if (kind) {
        const nameNode = field(node, "name") ?? node.namedChildren.find((child) => TS_TYPE_IDENTIFIERS.has(child.type) || child.type === "identifier" || child.type === "property_identifier");
        const name = nameNode?.text;
        if (!name) return undefined;
        const access = tsAccessibility(node);
        return {
          name,
          kind,
          exported: exportedByParent && depth === 0,
          publicMember: access !== "private" && access !== "protected" && !name.startsWith("#"),
          // Fields and aliases have no body worth cutting at; their whole text is the signature.
          signature: kind === "field" || kind === "type" ? oneLine(node.text) : head(node, ["body"]),
        };
      }
      // A bare enum member carries no value node, so it has no declaration type of its own.
      if (node.type === "property_identifier" && node.parent?.type === "enum_body") {
        return { name: node.text, kind: "field", exported: false, publicMember: true, signature: node.text };
      }
      if (node.type === "variable_declarator") {
        const nameNode = field(node, "name");
        const value = field(node, "value");
        if (!nameNode || nameNode.type !== "identifier") return undefined;
        const callable = value !== null && TS_FUNCTION_VALUES.has(value.type);
        // Module-level data is only worth a row when it leaves the file; callables always are.
        if (!callable && !(exportedByParent && depth === 0)) return undefined;
        return {
          name: nameNode.text,
          kind: callable ? "function" : "field",
          exported: exportedByParent && depth === 0,
          publicMember: true,
          signature: callable && value ? oneLine(`${nameNode.text} = ${head(value, ["body"])}`) : oneLine(node.text),
        };
      }
      return undefined;
    },

    scopeOnly: () => undefined,

    importFact(node) {
      if (node.type === "import_statement") {
        const specifier = stringLiteralText(field(node, "source"));
        if (specifier === undefined) return undefined;
        const clause = childOfType(node, "import_clause");
        const names: { imported: string; local: string }[] = [];
        if (clause) {
          for (const child of clause.namedChildren) {
            if (child.type === "identifier") names.push({ imported: "default", local: child.text });
            else if (child.type === "namespace_import") {
              const alias = childOfType(child, "identifier");
              if (alias) names.push({ imported: "*", local: alias.text });
            } else if (child.type === "named_imports") {
              for (const specifierNode of childrenOfType(child, "import_specifier")) {
                const parts = specifierNode.namedChildren.filter((part) => part.type === "identifier" || part.type === "string");
                const imported = field(specifierNode, "name")?.text ?? parts[0]?.text;
                const local = field(specifierNode, "alias")?.text ?? parts[1]?.text ?? imported;
                if (imported && local) names.push({ imported, local });
              }
            }
          }
        }
        return { specifier, names, kind: "import", line: node.startPosition.row + 1 };
      }
      if (node.type === "export_statement") {
        const specifier = stringLiteralText(field(node, "source"));
        if (specifier === undefined) return undefined;
        const clause = childOfType(node, "export_clause");
        const names: { imported: string; local: string }[] = [];
        if (clause) {
          for (const specifierNode of childrenOfType(clause, "export_specifier")) {
            const parts = specifierNode.namedChildren.filter((part) => part.type === "identifier" || part.type === "string");
            const imported = field(specifierNode, "name")?.text ?? parts[0]?.text;
            const local = field(specifierNode, "alias")?.text ?? parts[1]?.text ?? imported;
            if (imported && local) names.push({ imported, local });
          }
        } else {
          names.push({ imported: "*", local: "*" });
        }
        return { specifier, names, kind: "re_export", line: node.startPosition.row + 1 };
      }
      return undefined;
    },

    heritage(node) {
      const sites: HeritageSite[] = [];
      if (node.type === "class_heritage") {
        for (const clause of node.namedChildren) {
          const relation = clause.type === "implements_clause" ? "implements" : "extends";
          for (const site of typeIdentifiers(clause, new Set([...TS_TYPE_IDENTIFIERS, "identifier"]), TS_GENERIC, null)) {
            if (site.context !== "generic_arg") sites.push({ name: site.name, relation, line: site.line });
          }
        }
      }
      if (node.type === "extends_type_clause") {
        for (const site of typeIdentifiers(node, TS_TYPE_IDENTIFIERS, TS_GENERIC, null)) {
          if (site.context !== "generic_arg") sites.push({ name: site.name, relation: "extends", line: site.line });
        }
      }
      return sites;
    },

    sites(node) {
      switch (node.type) {
        case "required_parameter":
        case "optional_parameter":
          return typeIdentifiers(field(node, "type"), TS_TYPE_IDENTIFIERS, TS_GENERIC, "parameter_type");
        case "function_declaration":
        case "generator_function_declaration":
        case "method_definition":
        case "method_signature":
        case "abstract_method_signature":
        case "arrow_function":
        case "function_expression":
          return tsFunctionSites(node);
        case "public_field_definition":
        case "property_signature":
          return typeIdentifiers(field(node, "type"), TS_TYPE_IDENTIFIERS, TS_GENERIC, "field");
        case "type_alias_declaration":
          return typeIdentifiers(field(node, "value"), TS_TYPE_IDENTIFIERS, TS_GENERIC, null);
        case "type_annotation":
          // A bare annotation the cases above did not already claim (`const x: Foo = …`).
          return node.parent && TS_CLAIMED_ANNOTATION_PARENTS.has(node.parent.type)
            ? []
            : typeIdentifiers(node, TS_TYPE_IDENTIFIERS, TS_GENERIC, null);
        case "call_expression":
        case "new_expression": {
          const callee = calleeName(field(node, "function") ?? field(node, "constructor"), TS_CALLEE_PROPERTY, TS_SELF);
          if (!callee) return [];
          return [{
            name: callee.name,
            relation: "calls",
            context: "call",
            hint: "call",
            line: node.startPosition.row + 1,
            ...(callee.onSelf ? { onSelf: true } : {}),
            ...(callee.member ? { member: true } : {}),
          }];
        }
        default:
          return [];
      }
    },
  };
}

// ---------------------------------------------------------------- Python

const PY_BUILTINS = new Set([
  "print", "len", "range", "str", "int", "float", "bool", "list", "dict", "set", "tuple", "type", "isinstance",
  "issubclass", "super", "open", "enumerate", "zip", "map", "filter", "sorted", "reversed", "sum", "min", "max",
  "abs", "any", "all", "round", "divmod", "pow", "iter", "next", "callable", "id", "hash", "vars", "dir",
  "getattr", "setattr", "hasattr", "delattr", "repr", "format", "append", "extend", "insert", "remove", "pop",
  "items", "keys", "values", "get", "join", "split", "strip", "lstrip", "rstrip", "replace", "startswith",
  "endswith", "lower", "upper", "encode", "decode", "read", "write", "close", "update", "copy", "sort", "index",
  "self", "cls", "Exception", "BaseException", "ValueError", "TypeError", "KeyError", "IndexError", "RuntimeError",
  "AttributeError", "NotImplementedError", "StopIteration", "None", "object", "property", "staticmethod",
  "classmethod", "Optional", "Union", "Any", "List", "Dict", "Set", "Tuple", "Callable", "Iterable", "Iterator",
  "Sequence", "Mapping", "TypeVar", "Generic", "Protocol", "dataclass", "field",
]);

const PY_IDENTIFIERS = new Set(["identifier"]);
const PY_GENERIC = new Set(["subscript"]);
const PY_SELF = new Set(["self", "cls"]);

function pythonDottedName(node: Node | null): string | undefined {
  if (!node) return undefined;
  if (node.type === "dotted_name") return node.namedChildren.map((child) => child.text).join(".");
  if (node.type === "relative_import") {
    const prefix = node.children.find((child) => child.type === "import_prefix")?.text ?? ".";
    const rest = childOfType(node, "dotted_name");
    return `${prefix}${rest ? rest.namedChildren.map((child) => child.text).join(".") : ""}`;
  }
  return node.text;
}

const PYTHON_CONFIG: LanguageConfig = {
  id: "python",
  family: "python",
  grammar: () => PythonGrammar,
  builtins: PY_BUILTINS,
  marksExport: () => false,

  declaration(node, depth) {
    if (node.type === "class_definition" || node.type === "function_definition") {
      const name = field(node, "name")?.text;
      if (!name) return undefined;
      const kind: NodeKind = node.type === "class_definition" ? "class" : depth > 0 ? "method" : "function";
      return {
        name,
        kind,
        // Python has no export keyword; the leading-underscore convention is the contract.
        exported: depth === 0 && !name.startsWith("_"),
        publicMember: !name.startsWith("_"),
        signature: head(node, ["body"]),
      };
    }
    if (node.type === "assignment" && depth <= 1) {
      const target = field(node, "left");
      if (!target || target.type !== "identifier") return undefined;
      return {
        name: target.text,
        kind: "field",
        exported: depth === 0 && !target.text.startsWith("_"),
        publicMember: !target.text.startsWith("_"),
        signature: oneLine(node.text),
      };
    }
    return undefined;
  },

  scopeOnly: () => undefined,

  importFact(node) {
    const line = node.startPosition.row + 1;
    if (node.type === "import_statement") {
      const names: { imported: string; local: string }[] = [];
      let specifier = "";
      for (const child of node.namedChildren) {
        if (child.type === "aliased_import") {
          const dotted = pythonDottedName(childOfType(child, "dotted_name") ?? null) ?? "";
          const alias = field(child, "alias")?.text ?? child.namedChildren[child.namedChildCount - 1]?.text ?? dotted;
          specifier = specifier || dotted;
          names.push({ imported: "*", local: alias });
        } else if (child.type === "dotted_name") {
          const dotted = pythonDottedName(child) ?? "";
          specifier = specifier || dotted;
          names.push({ imported: "*", local: dotted.split(".")[0] ?? dotted });
        }
      }
      return specifier ? { specifier, names, kind: "import", line } : undefined;
    }
    if (node.type === "import_from_statement") {
      const moduleNode = field(node, "module_name") ?? node.namedChildren[0];
      const specifier = pythonDottedName(moduleNode ?? null);
      if (!specifier) return undefined;
      const names: { imported: string; local: string }[] = [];
      for (const child of node.namedChildren.slice(1)) {
        if (child.type === "dotted_name") {
          const text = child.namedChildren[0]?.text ?? child.text;
          names.push({ imported: text, local: text });
        } else if (child.type === "aliased_import") {
          const imported = childOfType(child, "dotted_name")?.namedChildren[0]?.text ?? "";
          const local = field(child, "alias")?.text ?? imported;
          if (imported) names.push({ imported, local });
        } else if (child.type === "wildcard_import") {
          names.push({ imported: "*", local: "*" });
        }
      }
      return { specifier, names, kind: "import", line };
    }
    return undefined;
  },

  heritage(node) {
    if (node.type !== "class_definition") return [];
    const bases = field(node, "superclasses");
    if (!bases) return [];
    return bases.namedChildren
      .filter((child) => child.type === "identifier" || child.type === "attribute")
      .map((child) => ({
        name: child.type === "attribute" ? child.namedChildren[child.namedChildCount - 1]?.text ?? child.text : child.text,
        relation: "inherits" as const,
        line: child.startPosition.row + 1,
      }));
  },

  sites(node) {
    switch (node.type) {
      case "typed_parameter":
      case "typed_default_parameter":
        return typeIdentifiers(field(node, "type"), PY_IDENTIFIERS, PY_GENERIC, "parameter_type");
      case "function_definition":
        return typeIdentifiers(field(node, "return_type"), PY_IDENTIFIERS, PY_GENERIC, "return_type");
      case "call": {
        const callee = calleeName(field(node, "function"), new Set(["attribute"]), PY_SELF);
        if (!callee) return [];
        return [{
          name: callee.name,
          relation: "calls",
          context: "call",
          hint: "call",
          line: node.startPosition.row + 1,
          ...(callee.onSelf ? { onSelf: true } : {}),
          ...(callee.member ? { member: true } : {}),
        }];
      }
      default:
        return [];
    }
  },
};

// ---------------------------------------------------------------- Rust

const RUST_BUILTINS = new Set([
  "Self", "String", "str", "Vec", "Option", "Result", "Box", "Rc", "Arc", "Cell", "RefCell", "Mutex", "RwLock",
  "HashMap", "HashSet", "BTreeMap", "BTreeSet", "VecDeque", "Cow", "PhantomData", "Path", "PathBuf", "Duration",
  "Some", "None", "Ok", "Err", "Clone", "Copy", "Debug", "Display", "Default", "Iterator", "IntoIterator", "From",
  "Into", "TryFrom", "TryInto", "AsRef", "Deref", "Drop", "Send", "Sync", "Sized", "Eq", "PartialEq", "Ord",
  "PartialOrd", "Hash", "Error",
  "println", "print", "eprintln", "format", "write", "writeln", "vec", "panic", "assert", "assert_eq", "assert_ne",
  "clone", "into", "from", "to_string", "unwrap", "expect", "iter", "into_iter", "iter_mut", "collect", "push",
  "pop", "insert", "remove", "get", "len", "is_empty", "new", "default", "as_str", "as_ref", "as_mut", "to_owned",
  "map", "map_err", "filter", "and_then", "or_else", "unwrap_or", "unwrap_or_default", "unwrap_or_else", "ok",
  "ok_or", "borrow", "borrow_mut", "drop", "clone_from", "contains", "starts_with", "ends_with", "trim", "split",
  "join", "extend", "next", "count", "sum", "min", "max", "sort", "cloned", "copied", "unwrap_err",
]);

const RUST_TYPE_IDENTIFIERS = new Set(["type_identifier"]);
const RUST_GENERIC = new Set(["type_arguments", "generic_type"]);
const RUST_SELF = new Set(["self"]);

const RUST_KINDS = new Map<string, NodeKind>([
  ["struct_item", "struct"],
  ["enum_item", "enum"],
  ["union_item", "struct"],
  ["trait_item", "trait"],
  ["mod_item", "module"],
  ["type_item", "type"],
  ["function_item", "function"],
  ["function_signature_item", "method"],
  ["field_declaration", "field"],
  ["enum_variant", "field"],
  ["const_item", "field"],
  ["static_item", "field"],
]);

function rustIsPublic(node: Node): boolean {
  return node.namedChildren.some((child) => child.type === "visibility_modifier" && child.text.startsWith("pub"));
}

/** The receiver type an `impl` block hangs methods on, stripped of generics and references. */
function rustImplOwner(node: Node): string | undefined {
  const type = field(node, "type");
  if (!type) return undefined;
  const bare = type.type === "generic_type" ? field(type, "type")?.text ?? type.text : type.text;
  return bare.replace(/^[&*]\s*/, "").replace(/<.*$/, "").trim() || undefined;
}

const RUST_CONFIG: LanguageConfig = {
  id: "rust",
  family: "rust",
  grammar: () => RustGrammar,
  builtins: RUST_BUILTINS,
  marksExport: () => false,

  declaration(node, depth) {
    const kind = RUST_KINDS.get(node.type);
    if (!kind) return undefined;
    const nameNode = field(node, "name") ?? node.namedChildren.find((child) => child.type === "type_identifier" || child.type === "identifier" || child.type === "field_identifier");
    const name = nameNode?.text;
    if (!name) return undefined;
    const isPublic = rustIsPublic(node);
    return {
      name,
      kind: node.type === "function_item" && depth > 0 ? "method" : kind,
      exported: isPublic && depth === 0,
      publicMember: isPublic,
      signature: head(node, ["body", "declaration_list", "field_declaration_list", "enum_variant_list"]),
    };
  },

  scopeOnly(node) {
    if (node.type !== "impl_item") return undefined;
    const owner = rustImplOwner(node);
    return owner ? [owner] : undefined;
  },

  heritage(node) {
    if (node.type === "impl_item") {
      const trait = field(node, "trait");
      if (!trait) return [];
      const name = trait.type === "generic_type" ? field(trait, "type")?.text ?? trait.text : trait.text;
      return [{ name: name.replace(/<.*$/, ""), relation: "implements", line: trait.startPosition.row + 1 }];
    }
    if (node.type === "trait_item") {
      const bounds = childOfType(node, "trait_bounds");
      if (!bounds) return [];
      return typeIdentifiers(bounds, RUST_TYPE_IDENTIFIERS, RUST_GENERIC, null).map((site) => ({
        name: site.name,
        relation: "extends" as const,
        line: site.line,
      }));
    }
    return [];
  },

  importFact(node) {
    if (node.type !== "use_declaration") return undefined;
    const argument = field(node, "argument") ?? node.namedChildren[node.namedChildCount - 1];
    if (!argument) return undefined;
    const names: { imported: string; local: string }[] = [];
    const line = node.startPosition.row + 1;

    const pathText = (path: Node): string => path.text.replace(/\s+/g, "");
    if (argument.type === "scoped_use_list") {
      const prefix = pathText(field(argument, "path") ?? argument.namedChildren[0]!);
      const list = childOfType(argument, "use_list");
      for (const child of list?.namedChildren ?? []) {
        if (child.type === "use_as_clause") {
          const imported = field(child, "path")?.text ?? child.namedChildren[0]?.text ?? "";
          const local = field(child, "alias")?.text ?? child.namedChildren[1]?.text ?? imported;
          if (imported) names.push({ imported, local });
        } else if (child.type === "identifier" || child.type === "scoped_identifier") {
          const text = child.text.split("::").pop() ?? child.text;
          names.push({ imported: text, local: text });
        }
      }
      return { specifier: prefix, names, kind: "import", line };
    }
    if (argument.type === "use_as_clause") {
      const path = pathText(field(argument, "path") ?? argument.namedChildren[0]!);
      const alias = field(argument, "alias")?.text ?? argument.namedChildren[1]?.text ?? path;
      const segments = path.split("::");
      const imported = segments.pop() ?? path;
      return { specifier: segments.join("::"), names: [{ imported, local: alias }], kind: "import", line };
    }
    if (argument.type === "scoped_identifier" || argument.type === "identifier") {
      const segments = pathText(argument).split("::");
      const imported = segments.pop() ?? "";
      return { specifier: segments.join("::"), names: imported ? [{ imported, local: imported }] : [], kind: "import", line };
    }
    if (argument.type === "use_wildcard") {
      const segments = pathText(argument).replace(/::\*$/, "").split("::");
      return { specifier: segments.join("::"), names: [{ imported: "*", local: "*" }], kind: "import", line };
    }
    return undefined;
  },

  sites(node) {
    switch (node.type) {
      case "parameter":
        return typeIdentifiers(field(node, "type"), RUST_TYPE_IDENTIFIERS, RUST_GENERIC, "parameter_type");
      case "function_item":
      case "function_signature_item":
        return typeIdentifiers(field(node, "return_type"), RUST_TYPE_IDENTIFIERS, RUST_GENERIC, "return_type");
      case "field_declaration":
        return typeIdentifiers(field(node, "type"), RUST_TYPE_IDENTIFIERS, RUST_GENERIC, "field");
      case "type_item":
        return typeIdentifiers(field(node, "type"), RUST_TYPE_IDENTIFIERS, RUST_GENERIC, null);
      case "struct_expression":
        return typeIdentifiers(field(node, "name"), RUST_TYPE_IDENTIFIERS, RUST_GENERIC, null);
      case "call_expression": {
        const callee = calleeName(field(node, "function"), new Set(["field_expression"]), RUST_SELF);
        if (callee) {
          return [{
            name: callee.name,
            relation: "calls",
            context: "call",
            hint: "call",
            line: node.startPosition.row + 1,
            ...(callee.onSelf ? { onSelf: true } : {}),
            ...(callee.member ? { member: true } : {}),
          }];
        }
        // `Type::associated(..)` — the associated function, attributed to its own name.
        const target = field(node, "function");
        if (target?.type === "scoped_identifier") {
          const name = target.text.split("::").pop();
          if (name) return [{ name, relation: "calls", context: "call", hint: "call", line: node.startPosition.row + 1 }];
        }
        return [];
      }
      default:
        return [];
    }
  },
};

// ---------------------------------------------------------------- Go

const GO_BUILTINS = new Set([
  "string", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "byte", "rune",
  "float32", "float64", "complex64", "complex128", "bool", "error", "any", "comparable", "uintptr", "rune",
  "make", "new", "len", "cap", "append", "copy", "delete", "panic", "recover", "print", "println", "close",
  "complex", "real", "imag", "nil", "true", "false", "iota", "min", "max", "clear",
  "Errorf", "Sprintf", "Printf", "Println", "Fprintf", "Error", "String", "Fatal", "Fatalf", "Helper", "Run",
]);

const GO_TYPE_IDENTIFIERS = new Set(["type_identifier"]);
const GO_GENERIC = new Set(["type_arguments", "generic_type"]);

/** The receiver type a Go method hangs on, stripped of pointer and generic decoration. */
function goReceiverOwner(node: Node): string | undefined {
  const receiver = field(node, "receiver");
  const declaration = receiver ? childOfType(receiver, "parameter_declaration") : undefined;
  const type = declaration ? field(declaration, "type") : undefined;
  const text = (type ?? declaration)?.text ?? "";
  const match = text.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*$/);
  return match?.[1];
}

function goTypeSpecKind(spec: Node): NodeKind {
  const type = field(spec, "type");
  if (!type) return "type";
  if (type.type === "struct_type") return "struct";
  if (type.type === "interface_type") return "interface";
  return "type";
}

/** `type Item struct` / `type Doer interface` / `type Alias = Other` — the head, without the body. */
function goTypeSignature(spec: Node, alias: boolean): string {
  const name = field(spec, "name")?.text ?? spec.text;
  const type = field(spec, "type");
  if (!type) return oneLine(`type ${name}`);
  if (type.type === "struct_type" || type.type === "interface_type") {
    return oneLine(`type ${name} ${type.type === "struct_type" ? "struct" : "interface"}`);
  }
  return oneLine(`type ${name} ${alias ? "= " : ""}${type.text}`);
}

/** A Go result list is a parameter_list too; tell the two apart so contexts stay honest. */
function goInResultList(node: Node): boolean {
  const list = node.parent;
  const owner = list?.parent;
  return owner !== null && owner !== undefined && owner.childForFieldName("result") === list;
}

const GO_CONFIG: LanguageConfig = {
  id: "go",
  family: "go",
  grammar: () => GoGrammar,
  builtins: GO_BUILTINS,
  marksExport: () => false,

  declaration(node, depth) {
    const exported = (name: string): boolean => /^\p{Lu}/u.test(name);
    if (node.type === "function_declaration" || node.type === "method_declaration") {
      const name = field(node, "name")?.text;
      if (!name) return undefined;
      const owner = node.type === "method_declaration" ? goReceiverOwner(node) : undefined;
      return {
        name,
        kind: node.type === "method_declaration" ? "method" : "function",
        exported: exported(name),
        publicMember: exported(name),
        signature: head(node, ["body"]),
        ...(owner ? { owner: [owner] } : {}),
      };
    }
    if (node.type === "type_spec" || node.type === "type_alias") {
      const name = field(node, "name")?.text;
      if (!name) return undefined;
      return {
        name,
        kind: node.type === "type_alias" ? "type" : goTypeSpecKind(node),
        exported: exported(name),
        publicMember: exported(name),
        signature: goTypeSignature(node, node.type === "type_alias"),
      };
    }
    if (node.type === "field_declaration" && depth > 0) {
      const name = field(node, "name")?.text;
      if (!name) return undefined;
      return { name, kind: "field", exported: exported(name), publicMember: exported(name), signature: oneLine(node.text) };
    }
    if (node.type === "method_elem" || node.type === "method_spec") {
      const name = field(node, "name")?.text;
      if (!name) return undefined;
      return { name, kind: "method", exported: exported(name), publicMember: exported(name), signature: oneLine(node.text) };
    }
    if ((node.type === "const_spec" || node.type === "var_spec") && depth === 0) {
      const name = field(node, "name")?.text;
      if (!name) return undefined;
      return { name, kind: "field", exported: exported(name), publicMember: exported(name), signature: oneLine(node.text) };
    }
    return undefined;
  },

  scopeOnly: () => undefined,

  heritage(node) {
    // An embedded field is Go's inheritance: a struct embeds a type, an interface embeds an interface.
    if (node.type === "field_declaration" && field(node, "name") === null) {
      const type = field(node, "type");
      const name = type?.text.replace(/^\*/, "").split(".").pop();
      if (name && !GO_BUILTINS.has(name)) return [{ name, relation: "inherits", line: node.startPosition.row + 1 }];
    }
    if (node.type === "type_elem") {
      const name = node.text.replace(/^\*/, "").split(".").pop();
      if (name && /^\p{L}/u.test(name) && !GO_BUILTINS.has(name)) {
        return [{ name, relation: "extends", line: node.startPosition.row + 1 }];
      }
    }
    return [];
  },

  importFact(node) {
    if (node.type !== "import_spec") return undefined;
    const specifier = stringLiteralText(field(node, "path") ?? node.namedChildren[node.namedChildCount - 1] ?? null);
    if (!specifier) return undefined;
    const alias = field(node, "name")?.text;
    const local = alias ?? specifier.split("/").pop() ?? specifier;
    return { specifier, names: [{ imported: "*", local }], kind: "import", line: node.startPosition.row + 1 };
  },

  sites(node) {
    switch (node.type) {
      case "parameter_declaration":
        return typeIdentifiers(field(node, "type"), GO_TYPE_IDENTIFIERS, GO_GENERIC, goInResultList(node) ? "return_type" : "parameter_type");
      case "function_declaration":
      case "method_declaration": {
        const result = field(node, "result");
        // A multi-value result is a parameter_list whose members report themselves.
        return result === null || result.type === "parameter_list" ? [] : typeIdentifiers(result, GO_TYPE_IDENTIFIERS, GO_GENERIC, "return_type");
      }
      case "field_declaration":
        return field(node, "name") === null ? [] : typeIdentifiers(field(node, "type"), GO_TYPE_IDENTIFIERS, GO_GENERIC, "field");
      case "composite_literal":
        return typeIdentifiers(field(node, "type"), GO_TYPE_IDENTIFIERS, GO_GENERIC, null);
      case "call_expression": {
        const callee = calleeName(field(node, "function"), new Set(["selector_expression"]), new Set());
        if (!callee) return [];
        return [{
          name: callee.name,
          relation: "calls",
          context: "call",
          hint: "call",
          line: node.startPosition.row + 1,
          ...(callee.member ? { member: true } : {}),
        }];
      }
      default:
        return [];
    }
  },
};

const CONFIGS: Readonly<Record<MapLanguage, LanguageConfig>> = Object.freeze({
  typescript: typescriptConfig("typescript"),
  tsx: typescriptConfig("tsx"),
  javascript: typescriptConfig("javascript"),
  python: PYTHON_CONFIG,
  rust: RUST_CONFIG,
  go: GO_CONFIG,
});

export function languageConfig(language: MapLanguage): LanguageConfig {
  return CONFIGS[language];
}

/** Parsers are expensive to construct and safe to reuse; one per grammar, created on demand. */
const parsers = new Map<MapLanguage, Parser>();

export function parserFor(language: MapLanguage): Parser {
  const existing = parsers.get(language);
  if (existing) return existing;
  const parser = new Parser();
  parser.setLanguage(languageConfig(language).grammar() as Parameters<Parser["setLanguage"]>[0]);
  parsers.set(language, parser);
  return parser;
}
