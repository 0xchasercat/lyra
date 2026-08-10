import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface LyraConfig {
  roles: { default?: string; fast?: string; merge?: string };
  exec: { heavy: number; io: number; cgroup: boolean };
  git: { gui: string };
  /** Retention for the agent workspaces isolated children run in; `/cleanup` reads it. */
  workspace: { archive_after: string };
  tui: { theme: "graphite" | "paper" | "forest"; accent: string };
  reliability: { stream_stall_timeout: string; turn_timeout: string; max_retries: number; compact_at: number };
  /**
   * Settings that were read, accepted, and no longer do anything, one sentence each.
   *
   * Retired keys are not errors. `workspace.enabled = false` in particular is what the
   * benchmark harness writes, and a config that suddenly refuses to parse would break every
   * such caller to make a point about tidiness. They are surfaced once at boot instead.
   */
  deprecations: string[];
}
const DEFAULT_VALUES: LyraConfig = { roles: {}, exec: { heavy: Math.min(navigator.hardwareConcurrency || 1, 8), io: 4, cgroup: false }, git: { gui: "auto" }, workspace: { archive_after: "7d" }, tui: { theme: "graphite", accent: "#7aa2f7" }, reliability: { stream_stall_timeout: "45s", turn_timeout: "30m", max_retries: 8, compact_at: 0.8 }, deprecations: [] };

/**
 * Keys that were removed by the workspace/git redesign, and what to say about each.
 *
 * `workspace.enabled` toggled whether the *main* session ran in a copy-on-write clone.
 * There is no clone any more — the main session runs in the launch directory, always — so
 * the flag has nothing left to switch, and `false` (what the harness sets) is now simply
 * what Lyra does. `git.mode` selected between observe/stage/auto; integration is the
 * model's job through ordinary tool calls now, so there is no mode to be in.
 */
const RETIRED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "workspace.enabled": "workspace.enabled no longer does anything: the main session always runs in the launch directory, and reversibility comes from checkpoints (/rollback). Remove the key when convenient.",
  "git.mode": "git.mode no longer does anything: observe/stage/auto are gone, and integrating an agent workspace is now something the model does with the git tool. Remove the key when convenient.",
});
export const DEFAULT_CONFIG: LyraConfig = Object.freeze(DEFAULT_VALUES);
export async function loadConfig(workspace: string, home = homedir()): Promise<LyraConfig> {
  let output = structuredClone(DEFAULT_CONFIG);
  for (const path of [join(resolve(home), ".lyra", "config.toml"), join(resolve(home), ".lyra", "providers.toml"), join(resolve(workspace), ".lyra", "config.toml")]) {
    try { output = applyConfig(output, parseToml(await readFile(path, "utf8"), path), path); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  return output;
}

function parseToml(raw: string, path: string): Map<string, unknown> {
  let parsed: unknown;
  try { parsed = Bun.TOML.parse(raw); } catch (error) { throw new Error(`Invalid TOML at ${path}: ${error instanceof Error ? error.message : String(error)}.`); }
  if (!isRecord(parsed)) throw new Error(`Invalid TOML at ${path}: root must be a table.`);
  const values = new Map<string, unknown>();
  const appSections = new Set(["roles", "exec", "git", "workspace", "tui", "reliability"]);
  for (const [section, sectionValue] of Object.entries(parsed)) {
    if (section === "providers") continue;
    if (!appSections.has(section)) throw new Error(`Unknown Lyra config section [${section}] in ${path}.`);
    if (!isRecord(sectionValue)) throw new Error(`[${section}] in ${path} must be a table.`);
    for (const [name, value] of Object.entries(sectionValue)) values.set(`${section}.${name}`, value);
  }
  return values;
}
function applyConfig(config: LyraConfig, values: Map<string, unknown>, path: string): LyraConfig {
  const output = structuredClone(config);
  for (const [key, value] of values) {
    switch (key) {
      case "roles.default": requireString(key, value, path); output.roles.default = value; break;
      case "roles.fast": requireString(key, value, path); output.roles.fast = value; break;
      case "roles.merge": requireString(key, value, path); output.roles.merge = value; break;
      case "exec.heavy": requireInteger(key, value, path, 1); if (value > 8) throw new Error(`${key} in ${path} must not exceed 8.`); output.exec.heavy = value; break;
      case "exec.io": requireInteger(key, value, path, 1); output.exec.io = value; break;
      case "exec.cgroup": requireBoolean(key, value, path); output.exec.cgroup = value; break;
      case "git.gui": requireString(key, value, path); output.git.gui = value; break;
      case "workspace.archive_after": requireDuration(key, value, path); output.workspace.archive_after = value; break;
      case "tui.theme": if (value !== "graphite" && value !== "paper" && value !== "forest") throw new Error(`${key} in ${path} must be graphite, paper, or forest.`); output.tui.theme = value; break;
      case "tui.accent": requireString(key, value, path); if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${key} in ${path} must be a six-digit hex color.`); output.tui.accent = value; break;
      case "reliability.stream_stall_timeout": requireDuration(key, value, path); output.reliability.stream_stall_timeout = value; break;
      case "reliability.turn_timeout": requireDuration(key, value, path); output.reliability.turn_timeout = value; break;
      case "reliability.max_retries": requireInteger(key, value, path, 1); output.reliability.max_retries = value; break;
      case "reliability.compact_at": if (typeof value !== "number" || value <= 0 || value >= 1) throw new Error(`${key} in ${path} must be between 0 and 1.`); output.reliability.compact_at = value; break;
      default: {
        const retired = RETIRED_KEYS[key];
        if (retired === undefined) throw new Error(`Unknown Lyra config key ${key} in ${path}; remove the typo or use a documented setting.`);
        const notice = `${path}: ${retired}`;
        if (!output.deprecations.includes(notice)) output.deprecations.push(notice);
        break;
      }
    }
  }
  return output;
}
export function durationMs(value: string): number { const match = /^(\d+)(ms|s|m|h|d)$/.exec(value); if (!match) throw new TypeError(`Invalid duration ${value}.`); const amount = Number(match[1]); switch (match[2]) { case "ms": return amount; case "s": return amount * 1000; case "m": return amount * 60_000; case "h": return amount * 3_600_000; case "d": return amount * 86_400_000; default: throw new TypeError(`Invalid duration ${value}.`); } }
function requireString(key: string, value: unknown, path: string): asserts value is string { if (typeof value !== "string" || value.length === 0) throw new Error(`${key} in ${path} must be a non-empty string.`); }
function requireBoolean(key: string, value: unknown, path: string): asserts value is boolean { if (typeof value !== "boolean") throw new Error(`${key} in ${path} must be boolean.`); }
function requireInteger(key: string, value: unknown, path: string, minimum: number): asserts value is number { if (!Number.isSafeInteger(value) || typeof value !== "number" || value < minimum) throw new Error(`${key} in ${path} must be an integer >= ${minimum}.`); }
function requireDuration(key: string, value: unknown, path: string): asserts value is string { requireString(key, value, path); try { durationMs(value); } catch { throw new Error(`${key} in ${path} must be a duration like 45s, 30m, or 7d.`); } }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
