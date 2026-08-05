import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EntryId, PromptSearchHit } from "./types.ts";

export interface PromptHistoryEntry {
  sessionId: string;
  entryId: EntryId;
  prompt: string;
  createdAt?: string;
}

interface PromptRow {
  sessionId: string;
  entryId: string;
  prompt: string;
  createdAt: string;
  rank: number;
}

/** A durable FTS index for user prompts. Transcript files remain the source of truth. */
export class PromptHistory {
  readonly path: string;
  readonly #database: Database;
  #closed = false;

  constructor(inputPath: string) {
    if (typeof inputPath !== "string" || inputPath.length === 0) {
      throw new TypeError("Prompt history path must be a non-empty string");
    }
    this.path = inputPath === ":memory:" ? inputPath : resolve(inputPath);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });

    this.#database = new Database(this.path, { create: true, strict: true });
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = FULL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS prompts (
        rowid INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        entry_id TEXT NOT NULL UNIQUE,
        prompt TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prompts_session_id ON prompts(session_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
        prompt,
        content = 'prompts',
        content_rowid = 'rowid',
        tokenize = 'unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS prompts_after_insert AFTER INSERT ON prompts BEGIN
        INSERT INTO prompts_fts(rowid, prompt) VALUES (new.rowid, new.prompt);
      END;
      CREATE TRIGGER IF NOT EXISTS prompts_after_delete AFTER DELETE ON prompts BEGIN
        INSERT INTO prompts_fts(prompts_fts, rowid, prompt)
        VALUES ('delete', old.rowid, old.prompt);
      END;
      CREATE TRIGGER IF NOT EXISTS prompts_after_update AFTER UPDATE ON prompts BEGIN
        INSERT INTO prompts_fts(prompts_fts, rowid, prompt)
        VALUES ('delete', old.rowid, old.prompt);
        INSERT INTO prompts_fts(rowid, prompt) VALUES (new.rowid, new.prompt);
      END;
    `);
  }

  static open(path: string): PromptHistory {
    return new PromptHistory(path);
  }

  add(entry: PromptHistoryEntry): void;
  add(sessionId: string, entryId: EntryId, prompt: string, createdAt?: string): void;
  add(
    entryOrSessionId: PromptHistoryEntry | string,
    positionalEntryId?: EntryId,
    positionalPrompt?: string,
    positionalCreatedAt?: string,
  ): void {
    this.#assertOpen();
    const entry: PromptHistoryEntry = typeof entryOrSessionId === "string"
      ? {
          sessionId: entryOrSessionId,
          entryId: positionalEntryId ?? "",
          prompt: positionalPrompt ?? "",
          ...(positionalCreatedAt === undefined ? {} : { createdAt: positionalCreatedAt }),
        }
      : entryOrSessionId;
    const createdAt = entry.createdAt ?? new Date().toISOString();
    validateHistoryEntry(entry, createdAt);

    this.#database
      .query<void, [string, string, string, string]>(
        "INSERT INTO prompts(session_id, entry_id, prompt, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(entry.sessionId, entry.entryId, entry.prompt, createdAt);
  }

  search(query: string, limit = 20): PromptSearchHit[] {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError("Prompt search limit must be a non-negative safe integer");
    }
    if (limit === 0) return [];

    const match = toFtsQuery(query);
    if (match === null) return [];

    return this.#database
      .query<PromptRow, [string, number]>(`
        SELECT
          prompts.session_id AS sessionId,
          prompts.entry_id AS entryId,
          prompts.prompt AS prompt,
          prompts.created_at AS createdAt,
          bm25(prompts_fts) AS rank
        FROM prompts_fts
        JOIN prompts ON prompts.rowid = prompts_fts.rowid
        WHERE prompts_fts MATCH ?
        ORDER BY rank ASC, prompts.created_at DESC, prompts.rowid DESC, prompts.session_id ASC, prompts.entry_id ASC
        LIMIT ?
      `)
      .all(match, limit)
      .map((row) => ({
        sessionId: row.sessionId,
        entryId: row.entryId,
        prompt: row.prompt,
        createdAt: row.createdAt,
        rank: row.rank,
      }));
  }

  remove(entryId: EntryId): boolean {
    this.#assertOpen();
    if (typeof entryId !== "string" || entryId.length === 0) {
      throw new TypeError("Prompt history entry id must be a non-empty string");
    }
    const result = this.#database.query<void, [string]>("DELETE FROM prompts WHERE entry_id = ?").run(entryId);
    return result.changes > 0;
  }

  removeSession(sessionId: string): number {
    this.#assertOpen();
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("Prompt history session id must be a non-empty string");
    }
    const count = this.#database
      .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM prompts WHERE session_id = ?")
      .get(sessionId)?.count ?? 0;
    this.#database.query<void, [string]>("DELETE FROM prompts WHERE session_id = ?").run(sessionId);
    return count;
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close(false);
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Prompt history is closed");
  }
}

function validateHistoryEntry(entry: PromptHistoryEntry, createdAt: string): void {
  if (typeof entry.sessionId !== "string" || entry.sessionId.length === 0) {
    throw new TypeError("Prompt history session id must be a non-empty string");
  }
  if (typeof entry.entryId !== "string" || entry.entryId.length === 0) {
    throw new TypeError("Prompt history entry id must be a non-empty string");
  }
  if (typeof entry.prompt !== "string" || entry.prompt.length === 0) {
    throw new TypeError("Prompt history prompt must be a non-empty string");
  }
  if (createdAt.length === 0 || Number.isNaN(Date.parse(createdAt))) {
    throw new TypeError("Prompt history createdAt must be a valid date string");
  }
}

function toFtsQuery(query: string): string | null {
  if (typeof query !== "string") throw new TypeError("Prompt search query must be a string");
  const terms = query.match(/[\p{L}\p{N}_]+/gu);
  if (terms === null || terms.length === 0) return null;
  return terms.map((term) => `"${term}"*`).join(" AND ");
}
