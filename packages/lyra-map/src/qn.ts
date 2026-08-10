import { sep } from "node:path";
import type { LanguageFamily, MapLanguage } from "./types.ts";

/** Source extensions the map understands, longest first so `.d.ts` never loses to `.ts`. */
const EXTENSIONS: readonly (readonly [string, MapLanguage])[] = Object.freeze([
  [".tsx", "tsx"],
  [".jsx", "tsx"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".ts", "typescript"],
  [".js", "javascript"],
  [".py", "python"],
  [".pyi", "python"],
  [".rs", "rust"],
  [".go", "go"],
]);

const FAMILIES: Readonly<Record<MapLanguage, LanguageFamily>> = Object.freeze({
  typescript: "js",
  tsx: "js",
  javascript: "js",
  python: "python",
  rust: "rust",
  go: "go",
});

/** Normalize any host path separator to the POSIX form the map stores. */
export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** The language of a path, or undefined when the map does not parse it. */
export function languageOf(path: string): MapLanguage | undefined {
  const lower = toPosix(path).toLowerCase();
  for (const [extension, language] of EXTENSIONS) if (lower.endsWith(extension)) return language;
  return undefined;
}

/** The resolution family a language belongs to; resolution never crosses families. */
export function familyOf(language: MapLanguage): LanguageFamily {
  return FAMILIES[language];
}

/** The SQL languages that share a family, for the resolver's language-boundary guard. */
export function languagesInFamily(family: LanguageFamily): MapLanguage[] {
  return (Object.keys(FAMILIES) as MapLanguage[]).filter((language) => FAMILIES[language] === family);
}

/** Strip the source extension a path is recognized by, leaving every other dot alone. */
export function stripExtension(path: string): string {
  const posix = toPosix(path);
  const lower = posix.toLowerCase();
  for (const [extension] of EXTENSIONS) if (lower.endsWith(extension)) return posix.slice(0, posix.length - extension.length);
  return posix;
}

/**
 * The qualified name of a file node: the repository-relative path with separators
 * turned into dots and the source extension removed. Case is preserved — casefolding
 * here is how both studied tools orphaned edges the moment a file was renamed.
 *
 * A path segment that already contains dots keeps them (`app.test.ts` → `app.test`),
 * which is harmless: the whole string is only ever compared, never re-split.
 */
export function fileQn(relativePath: string): string {
  return stripExtension(relativePath).replace(/\//g, ".");
}

/** Append a symbol name to a scope, producing the child's qualified name. */
export function childQn(scope: string, name: string): string {
  return `${scope}.${name}`;
}

const TEST_DIRECTORIES = new Set(["test", "tests", "__tests__", "spec", "specs", "testdata", "fixtures"]);

/**
 * Whether a path is a test by convention: `*.test.*` / `*.spec.*` / `*_test.go` /
 * `test_*.py` / `*_test.py`, or any segment that is a conventional test directory.
 */
export function isTestPath(relativePath: string): boolean {
  const posix = toPosix(relativePath);
  const segments = posix.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment.toLowerCase()))) return true;
  const lower = base.toLowerCase();
  if (/\.(test|spec)\.[^.]+$/.test(lower)) return true;
  if (/_test\.(go|py|rs|ts|tsx|js|jsx)$/.test(lower)) return true;
  if (/^test_[^.]*\.py$/.test(lower)) return true;
  return false;
}

/**
 * Split an identifier into lowercase words for full-text search: camelCase,
 * PascalCase, snake_case, kebab-case, and digit runs all break apart. Acronyms stay
 * whole (`parseHTTPResponse` → `parse HTTP response`), and the original identifier is
 * kept as its own token so an exact query still hits.
 */
export function splitIdentifier(identifier: string): string {
  const parts: string[] = [];
  for (const chunk of identifier.split(/[^\p{L}\p{N}]+/u)) {
    if (!chunk) continue;
    const words = chunk.match(/\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+|\p{N}+/gu);
    if (words) parts.push(...words);
    else parts.push(chunk);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [identifier, ...parts]) {
    const lower = part.toLowerCase();
    if (!lower || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out.join(" ");
}

/** Collapse a declaration head to a single stored line, capped so rows stay lean. */
export function oneLine(text: string, limit = 200): string {
  const collapsed = text.replace(/\s+/g, " ").trim().replace(/[;,]$/, "");
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}
