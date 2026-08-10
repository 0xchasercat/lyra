import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { languageOf, toPosix } from "./qn.ts";

/** Files above this never earn their parse; the map is for source, not for data blobs. */
export const MAX_FILE_BYTES = 1_048_576;

/** A file with a line this long is minified or generated, whatever its extension says. */
const MAX_LINE_LENGTH = 5_000;

const MAX_LINES = 50_000;

/**
 * Directories the map never descends into, whatever .gitignore says. `.lyra` is Lyra's
 * own state — the same exclusion the filesystem and search tools enforce — and the rest
 * are build output and dependency trees that would swamp the graph with foreign symbols.
 */
export const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git", ".lyra", "node_modules", "target", "dist", "build", "out", "vendor",
  "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".turbo", ".cache", "coverage",
]);

interface IgnoreRule {
  readonly regex: RegExp;
  readonly negate: boolean;
  readonly basenameOnly: boolean;
}

/** The result of a repository walk: source files plus the workspace packages that own them. */
export interface WalkResult {
  /** Repository-relative POSIX paths, sorted. */
  readonly files: readonly string[];
  /** Package name → repository-relative directory, read from every package.json found. */
  readonly packages: ReadonlyMap<string, string>;
}

/** Why a file present on disk is not in the index. */
export type SkipReason = "too_large" | "binary" | "generated" | "minified" | "unsupported";

export type SourceRead =
  | { readonly ok: true; readonly content: string; readonly mtimeMs: number; readonly size: number }
  | { readonly ok: false; readonly reason: SkipReason | "missing" };

/**
 * Convert a .gitignore pattern to a regular expression, matching git's own semantics for
 * `*`, `**`, `?`, character classes, and brace alternatives.
 */
export function globRegex(pattern: string): RegExp {
  let out = "^";
  let classes = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "[") {
      classes += 1;
      out += "[";
      continue;
    }
    if (char === "]") {
      if (classes === 0) throw new Error(`Malformed ignore pattern ${JSON.stringify(pattern)}: closing ] has no opening [`);
      classes -= 1;
      out += "]";
      continue;
    }
    if (char === "\\") {
      if (i + 1 >= pattern.length) throw new Error(`Malformed ignore pattern ${JSON.stringify(pattern)}: trailing escape`);
      i += 1;
      out += `\\${pattern[i]}`;
      continue;
    }
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    if (char === "{") {
      const close = pattern.indexOf("}", i + 1);
      if (close < 0) throw new Error(`Malformed ignore pattern ${JSON.stringify(pattern)}: opening { is not closed`);
      const alternatives = pattern.slice(i + 1, close).split(",");
      if (alternatives.length < 2 || alternatives.some((part) => part.length === 0)) {
        throw new Error(`Malformed ignore pattern ${JSON.stringify(pattern)}: brace alternatives must be non-empty`);
      }
      out += `(?:${alternatives.map((part) => part.replace(/[.+^$()|\\]/g, "\\$&")).join("|")})`;
      i = close;
      continue;
    }
    out += /[.+^$()|]/.test(char) ? `\\${char}` : char;
  }
  if (classes !== 0) throw new Error(`Malformed ignore pattern ${JSON.stringify(pattern)}: opening [ is not closed`);
  return new RegExp(`${out}$`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Directories whose .gitignore applies, outermost first — git never reads above the repository root. */
async function ignoreChain(root: string): Promise<string[]> {
  const chain: string[] = [];
  let current = root;
  for (;;) {
    chain.unshift(current);
    if (await exists(resolve(current, ".git"))) return chain;
    const parent = dirname(current);
    if (parent === current) return [root];
    current = parent;
  }
}

/** Load the ignore rules that govern a root, outermost first so the deepest file wins. */
export async function ignoreRules(root: string): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  for (const directory of await ignoreChain(root)) {
    let raw: string;
    try {
      raw = await readFile(resolve(directory, ".gitignore"), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const negate = trimmed.startsWith("!");
      const pattern = (negate ? trimmed.slice(1) : trimmed).replace(/^\//, "").replace(/\/$/, "");
      if (!pattern) continue;
      try {
        rules.push({ regex: globRegex(pattern), negate, basenameOnly: !pattern.includes("/") });
      } catch {
        // A pattern git itself would reject is simply not applied.
      }
    }
  }
  return rules;
}

/** Last match wins, exactly as git resolves competing patterns. */
export function isIgnored(relativePath: string, rules: readonly IgnoreRule[]): boolean {
  const segments = relativePath.split("/");
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) return true;
  let ignored = false;
  const base = segments[segments.length - 1] ?? relativePath;
  for (const rule of rules) if (rule.regex.test(rule.basenameOnly ? base : relativePath)) ignored = !rule.negate;
  return ignored;
}

/**
 * Every indexable source file under `root`, gitignore-correct and deterministic, plus the
 * workspace packages found on the way. Symlinks are never followed: a link into a
 * dependency tree would let the graph escape the repository.
 */
export async function walkRepository(root: string): Promise<WalkResult> {
  const absoluteRoot = resolve(root);
  const rules = await ignoreRules(absoluteRoot);
  const files: string[] = [];
  const packages = new Map<string, string>();

  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = resolve(directory, entry.name);
      const relativePath = toPosix(relative(absoluteRoot, absolute));
      if (isIgnored(relativePath, rules)) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === "package.json") {
        const name = await packageName(absolute);
        if (name) packages.set(name, toPosix(relative(absoluteRoot, directory)));
        continue;
      }
      if (languageOf(relativePath)) files.push(relativePath);
    }
  };

  await visit(absoluteRoot);
  files.sort();
  return { files, packages };
}

async function packageName(path: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const name = (parsed as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read one file if it is worth indexing. Oversized, binary, minified, and generated files
 * are refused by content, not by name: a `.ts` extension on a 3 MB bundle proves nothing.
 */
export async function readIndexable(root: string, relativePath: string, maxBytes = MAX_FILE_BYTES): Promise<SourceRead> {
  const absolute = resolve(root, relativePath);
  if (!languageOf(relativePath)) return { ok: false, reason: "unsupported" };
  let info;
  try {
    info = await stat(absolute);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!info.isFile()) return { ok: false, reason: "missing" };
  if (info.size > maxBytes) return { ok: false, reason: "too_large" };
  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (bytes.subarray(0, 8_192).includes(0)) return { ok: false, reason: "binary" };
  const content = bytes.toString("utf8");
  const skip = generatedReason(relativePath, content);
  if (skip) return { ok: false, reason: skip };
  return { ok: true, content, mtimeMs: Math.round(info.mtimeMs), size: info.size };
}

const GENERATED_MARKER = /@generated|Code generated by .* DO NOT EDIT|DO NOT EDIT THIS FILE|autogenerated|auto-generated/i;

/** Generated and machine-emitted files, detected by their own header or by their shape. */
export function generatedReason(relativePath: string, content: string): SkipReason | undefined {
  const base = basename(relativePath).toLowerCase();
  if (base.endsWith(".min.js") || base.endsWith(".min.ts")) return "minified";
  const lines = content.split("\n");
  if (lines.length > MAX_LINES) return "generated";
  for (const line of lines.slice(0, 8)) if (GENERATED_MARKER.test(line)) return "generated";
  for (const line of lines) if (line.length > MAX_LINE_LENGTH) return "minified";
  return undefined;
}
