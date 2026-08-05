import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const NAME = /^[a-z][a-z0-9-]{0,63}$/;

export function validateRuntimeName(value: unknown, label = "runtime name"): asserts value is string {
  if (typeof value !== "string" || !NAME.test(value)) throw new TypeError(`${label} must match ${NAME.source}.`);
}

export class CheckpointStore {
  readonly directory: string;
  #sequence = 0;
  constructor(origin: string, session: string) {
    if (typeof origin !== "string" || origin.length === 0) throw new TypeError("Checkpoint origin must be a non-empty path.");
    validateRuntimeName(session, "session");
    this.directory = resolve(origin, ".lyra", "runtime", session);
  }

  path(name: string): string { validateRuntimeName(name); return join(this.directory, `${name}.checkpoint.json`); }

  async save(name: string, state: unknown): Promise<void> {
    const cloned = cloneJson(state);
    await mkdir(this.directory, { recursive: true });
    const destination = this.path(name);
    const temporary = `${destination}.${process.pid}.${++this.#sequence}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, state: cloned })}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  }

  async load(name: string): Promise<unknown | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path(name), "utf8"));
      if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || !("state" in value)) throw new Error("unsupported checkpoint envelope");
      return cloneJson((value as { state: unknown }).state);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return undefined;
      throw new Error(`Checkpoint ${name} is unreadable: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  async clear(name: string): Promise<boolean> {
    try { await rm(this.path(name)); return true; }
    catch (error) { if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return false; throw error; }
  }
}

function cloneJson<T>(value: T): T {
  try { return JSON.parse(JSON.stringify(value)) as T; }
  catch (error) { throw new TypeError(`Checkpoint state must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}.`); }
}
