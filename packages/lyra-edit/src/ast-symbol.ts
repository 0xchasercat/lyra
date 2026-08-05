import Parser from "tree-sitter";
import TypeScriptGrammars from "tree-sitter-typescript";
import PythonGrammar from "tree-sitter-python";
import RustGrammar from "tree-sitter-rust";
import GoGrammar from "tree-sitter-go";
import type { AstSymbolMatch } from "./types.ts";

type LanguageName = "typescript" | "tsx" | "python" | "rust" | "go";

type AstFailureCode = "unsupported_language" | "symbol_not_found" | "ambiguous_match" | "no_op";

export type AstSymbolResolution =
  | { ok: true; match: AstSymbolMatch }
  | { ok: false; code: AstFailureCode; message: string; matches?: string[] };

export type AstSymbolApplyResult =
  | { ok: true; content: string; occurrences: number }
  | { ok: false; code: AstFailureCode; message: string; matches?: string[] };

type Node = Parser.SyntaxNode;

type Candidate = {
  node: Node;
  name: string;
  path: string;
};

const TYPESCRIPT_DECLARATIONS = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "method_signature",
  "interface_declaration",
  "enum_declaration",
]);
const PYTHON_DECLARATIONS = new Set([
  "class_definition",
  "function_definition",
  "async_function_definition",
]);
const RUST_DECLARATIONS = new Set([
  "struct_item",
  "enum_item",
  "trait_item",
  "mod_item",
  "function_item",
]);
const GO_DECLARATIONS = new Set([
  "function_declaration",
  "method_declaration",
  "type_declaration",
]);
const CALLABLE_VARIABLE_VALUES = new Set(["arrow_function", "function_expression"]);

function inferLanguage(languageOrPath?: string): LanguageName | undefined {
  if (!languageOrPath) return undefined;
  const value = languageOrPath.toLowerCase().split(/[?#]/, 1)[0] ?? "";
  const lastDot = value.lastIndexOf(".");
  const extension = lastDot >= 0 ? value.slice(lastDot + 1) : value;
  switch (extension) {
    case "typescript":
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "python":
    case "py":
      return "python";
    case "rust":
    case "rs":
      return "rust";
    case "go":
      return "go";
    default:
      return undefined;
  }
}

function grammarFor(language: LanguageName): unknown {
  switch (language) {
    case "typescript":
      return TypeScriptGrammars.typescript;
    case "tsx":
      return TypeScriptGrammars.tsx;
    case "python":
      return PythonGrammar;
    case "rust":
      return RustGrammar;
    case "go":
      return GoGrammar;
  }
}

function fieldText(node: Node, field: string): string | undefined {
  return node.childForFieldName(field)?.text;
}

function firstChildText(node: Node, types: Set<string>): string | undefined {
  for (const child of node.namedChildren) {
    if (types.has(child.type)) return child.text;
  }
  return undefined;
}

function declarationName(node: Node, language: LanguageName): string | undefined {
  const named = fieldText(node, "name");
  if (named) return named;
  if (language === "typescript" || language === "tsx") {
    return firstChildText(node, new Set(["type_identifier", "identifier", "property_identifier"]));
  }
  if (language === "python") {
    return firstChildText(node, new Set(["identifier"]));
  }
  if (language === "rust") {
    return firstChildText(node, new Set(["type_identifier", "identifier"]));
  }
  if (language === "go" && node.type === "type_declaration") {
    const spec = node.namedChildren.find((child) => child.type === "type_spec");
    return spec ? fieldText(spec, "name") ?? firstChildText(spec, new Set(["type_identifier", "identifier"])) : undefined;
  }
  return firstChildText(node, new Set(["identifier", "field_identifier", "type_identifier"]));
}

function isDeclaration(node: Node, language: LanguageName): boolean {
  return language === "typescript" || language === "tsx"
    ? TYPESCRIPT_DECLARATIONS.has(node.type)
    : language === "python"
      ? PYTHON_DECLARATIONS.has(node.type)
      : language === "rust"
        ? RUST_DECLARATIONS.has(node.type)
        : GO_DECLARATIONS.has(node.type);
}

function rustImplOwner(node: Node): string | undefined {
  // The type field is present for ordinary inherent impls. For generic and
  // trait impls, the first type_identifier is the concrete receiver type.
  const type = node.childForFieldName("type");
  if (type) return type.text.replace(/^\s*\([^)]*\)\s*/, "").replace(/[<].*$/, "");
  return firstChildText(node, new Set(["type_identifier"]));
}

function goReceiverOwner(node: Node): string | undefined {
  const receiver = node.namedChildren.find((child) => child.type === "parameter_list");
  const text = receiver?.text.trim() ?? "";
  const body = text.startsWith("(") && text.endsWith(")") ? text.slice(1, -1).trim() : text;
  const match = body.match(/(?:^|\s)(?:\[[^\]]+\])?\*?(?:[A-Za-z_$][A-Za-z0-9_$]*\.)?([A-Za-z_$][A-Za-z0-9_$]*)$/);
  return match?.[1];
}

function collectCandidates(root: Node, language: LanguageName): Candidate[] {
  const candidates: Candidate[] = [];
  const visit = (node: Node, scopes: string[], parentDecorated = false): void => {
    let nextScopes = scopes;
    let candidate: Candidate | undefined;

    if (language === "rust" && node.type === "impl_item") {
      const owner = rustImplOwner(node);
      if (owner) nextScopes = [...scopes, owner];
    }

    const callableValue = node.type === "variable_declarator" ? node.childForFieldName("value") : null;
    if ((language === "typescript" || language === "tsx") && callableValue && CALLABLE_VARIABLE_VALUES.has(callableValue.type)) {
      const name = declarationName(node, language);
      if (name) {
        candidate = { node: callableValue, name, path: [...scopes, name].join(".") };
        nextScopes = [...scopes, name];
      }
    }

    if (language === "python" && node.type === "decorated_definition") {
      const inner = node.namedChildren.find((child) => isDeclaration(child, language));
      const name = inner ? declarationName(inner, language) : undefined;
      if (name) {
        candidate = { node, name, path: [...scopes, name].join(".") };
        nextScopes = [...scopes, name];
      }
    } else if (isDeclaration(node, language) && !parentDecorated) {
      const name = declarationName(node, language);
      if (name) {
        let pathScopes = scopes;
        if (language === "go" && node.type === "method_declaration") {
          const owner = goReceiverOwner(node);
          if (owner) pathScopes = [...scopes, owner];
        }
        candidate = { node, name, path: [...pathScopes, name].join(".") };
        nextScopes = [...scopes, name];
      }
    }

    if (candidate) candidates.push(candidate);
    for (const child of node.namedChildren) {
      // A decorated Python declaration is represented by its wrapper so the
      // decorator and declaration stay atomic; avoid adding the inner node a
      visit(child, nextScopes, node.type === "decorated_definition" && isDeclaration(child, language));
    }
  };
  visit(root, []);
  return candidates;
}

function describeMatches(matches: Candidate[]): string[] {
  return matches.map((match) => `${match.path} (${match.node.startIndex}-${match.node.endIndex})`);
}

/** Resolve one exact, qualified AST declaration to its UTF-8 byte range. */
export function resolveAstSymbol(
  source: string,
  symbol: string,
  languageOrPath?: string,
): AstSymbolResolution {
  const language = inferLanguage(languageOrPath);
  if (!language) {
    const detail = languageOrPath ? ` for '${languageOrPath}'` : " (provide a supported language or file path)";
    return { ok: false, code: "unsupported_language", message: `Unsupported language${detail}; expected TypeScript, TSX, Python, Rust, or Go.` };
  }
  const wanted = symbol.trim();
  if (!wanted) return { ok: false, code: "symbol_not_found", message: "AST symbol is empty; provide a qualified symbol name." };

  try {
    const parser = new Parser();
    parser.setLanguage(grammarFor(language) as Parameters<Parser["setLanguage"]>[0]);
    const tree = parser.parse(source);
    const matches = collectCandidates(tree.rootNode, language).filter((candidate) => candidate.path === wanted);
    const location = languageOrPath ?? `${language} source`;
    if (matches.length === 0) {
      return { ok: false, code: "symbol_not_found", message: `AST symbol '${wanted}' was not found in '${location}'.` };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        code: "ambiguous_match",
        message: `AST symbol '${wanted}' matched ${matches.length} nodes in '${location}'; qualify the symbol or revise the source. Matches: ${describeMatches(matches).join(", ")}`,
        matches: describeMatches(matches),
      };
    }
    const match = matches[0]!;
    return { ok: true, match: { startByte: match.node.startIndex, endByte: match.node.endIndex, symbol: match.path } };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, code: "symbol_not_found", message: `Could not parse source while resolving AST symbol '${wanted}': ${detail}` };
  }
}

/** Replace exactly one resolved AST declaration, without mutating the input. */
export function applyAstSymbol(
  content: string,
  symbol: string,
  replace: string,
  languageOrPath?: string,
): AstSymbolApplyResult {
  const resolution = resolveAstSymbol(content, symbol, languageOrPath);
  if (!resolution.ok) return resolution;
  const before = Buffer.from(content, "utf8");
  const replacement = Buffer.from(replace, "utf8");
  const next = Buffer.concat([before.subarray(0, resolution.match.startByte), replacement, before.subarray(resolution.match.endByte)]).toString("utf8");
  if (next === content) {
    return { ok: false, code: "no_op", message: `AST replacement for '${symbol}' is a no-op; provide different replacement content.` };
  }
  return { ok: true, content: next, occurrences: 1 };
}
