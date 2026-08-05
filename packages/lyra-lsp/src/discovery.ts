import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LanguageServerSpec } from "./types.ts";

/** The built-in language servers, ordered by marker precedence. */
export const DEFAULT_LANGUAGE_SERVERS: readonly LanguageServerSpec[] = [
  { language: "rust", command: "rust-analyzer", args: [], markers: ["Cargo.toml"] },
  {
    language: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    markers: ["tsconfig.json", "package.json"],
  },
  {
    language: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    markers: ["pyproject.toml", "setup.py"],
  },
  { language: "go", command: "gopls", args: [], markers: ["go.mod"] },
  // This is deliberately last: package.json is also a TypeScript marker.
  {
    language: "javascript",
    command: "typescript-language-server",
    args: ["--stdio"],
    markers: ["package-lock.json", "package.json"],
  },
] as const;

export interface LanguageServerCommandOverride {
  command: string;
  args?: readonly string[];
}

export interface DiscoverLanguageServersOptions {
  /** Replace the built-in specs (useful for embedders and deterministic tests). */
  specs?: readonly LanguageServerSpec[];
  /** Override a command by language without changing marker detection. */
  commands?: Readonly<Record<string, string | LanguageServerCommandOverride>>;
  /** Alias accepted for callers that prefer a more explicit name. */
  commandOverrides?: Readonly<Record<string, string | LanguageServerCommandOverride>>;
}

function overrideSpec(
  spec: LanguageServerSpec,
  overrides: Readonly<Record<string, string | LanguageServerCommandOverride>> | undefined,
): LanguageServerSpec {
  const value = overrides?.[spec.language];
  if (value === undefined) return spec;
  if (typeof value === "string") return { ...spec, command: value };
  return { ...spec, command: value.command, args: value.args ?? spec.args };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function markerSet(workspace: string, markers: readonly string[]): Promise<Set<string>> {
  const present = await Promise.all(
    markers.map(async (marker) => {
      try {
        if (!(await stat(join(workspace, marker))).isFile()) return undefined;
        return marker;
      } catch {
        return undefined;
      }
    }),
  );
  return new Set(present.filter((marker): marker is string => marker !== undefined));
}

/**
 * Detect language servers from the workspace root.
 *
 * Detection is intentionally conservative: an invalid/non-directory workspace
 * never starts a process and simply produces no specs. Specs are returned in
 * their declared order, and each language appears at most once.
 */
export async function discoverLanguageServers(
  workspacePath: string,
  options: DiscoverLanguageServersOptions = {},
): Promise<LanguageServerSpec[]> {
  if (typeof workspacePath !== "string" || workspacePath.trim() === "") return [];
  const workspace = resolve(workspacePath);
  if (!(await isDirectory(workspace))) return [];

  const specs = options.specs ?? DEFAULT_LANGUAGE_SERVERS;
  const overrides = options.commandOverrides === undefined
    ? options.commands
    : options.commands === undefined
      ? options.commandOverrides
      : { ...options.commands, ...options.commandOverrides };
  const result: LanguageServerSpec[] = [];
  const fallbackSpecs: LanguageServerSpec[] = [];
  const seenLanguages = new Set<string>();

  // Evaluate in order. A generic JavaScript fallback only participates when
  // no language-specific marker matched (package.json is shared by both).
  for (const spec of specs) {
    if (seenLanguages.has(spec.language)) continue;
    const markers = await markerSet(workspace, spec.markers);
    if (markers.size === 0) continue;
    if (spec.language === "javascript" || spec.language === "fallback") {
      fallbackSpecs.push(spec);
      continue;
    }
    seenLanguages.add(spec.language);
    result.push(overrideSpec(spec, overrides));
  }
  if (result.length === 0) {
    for (const spec of fallbackSpecs) {
      if (seenLanguages.has(spec.language)) continue;
      seenLanguages.add(spec.language);
      result.push(overrideSpec(spec, overrides));
    }
  }
  return result;
}
