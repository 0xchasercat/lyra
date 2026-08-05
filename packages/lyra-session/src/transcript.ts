import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  EntryId,
  NewTranscriptEntry,
  SessionDescriptor,
  SessionStartEntry,
  TranscriptEntry,
} from "./types.ts";

export interface TranscriptCreateOptions {
  path: string;
  name: string;
  origin: string;
  workspace: string;
  provider: string;
  model: string;
  sessionId?: string;
  entryId?: EntryId;
  timestamp?: string;
}

export class TranscriptCorruptionError extends Error {
  readonly path: string;
  readonly line: number;

  constructor(path: string, line: number, detail: string, options?: ErrorOptions) {
    super(`Corrupt transcript ${JSON.stringify(path)} at line ${line}: ${detail}`, options);
    this.name = "TranscriptCorruptionError";
    this.path = path;
    this.line = line;
  }
}

/**
 * An append-only transcript. The persisted JSONL file is the source of truth; the
 * mutable head is only a cursor into the immutable entry tree.
 */
export class TranscriptStore {
  readonly #path: string;
  readonly #entries: TranscriptEntry[];
  readonly #byId: Map<EntryId, TranscriptEntry>;
  readonly #session: SessionStartEntry;
  #head: TranscriptEntry;
  #descriptor: SessionDescriptor;
  #fd: number;
  #closed = false;

  private constructor(path: string, fd: number, entries: TranscriptEntry[]) {
    const session = entries[0];
    const head = entries.at(-1);
    if (session?.type !== "session") {
      throw new Error("A transcript store requires a session entry");
    }
    if (head === undefined) {
      throw new Error("A transcript store requires a head entry");
    }

    this.#path = path;
    this.#fd = fd;
    this.#entries = entries;
    this.#byId = new Map(entries.map((entry) => [entry.id, entry]));
    this.#session = session as SessionStartEntry;
    this.#head = head;
    this.#descriptor = this.#makeDescriptor();
  }

  static create(options: TranscriptCreateOptions): TranscriptStore {
    const path = normalizePath(options.path);
    mkdirSync(dirname(path), { recursive: true });

    const timestamp = options.timestamp ?? new Date().toISOString();
    const session = canonicalEntry({
      type: "session",
      id: options.entryId ?? generateId("e"),
      parentId: null,
      timestamp,
      sessionId: options.sessionId ?? generateId("s"),
      name: options.name,
      origin: options.origin,
      workspace: options.workspace,
      provider: options.provider,
      model: options.model,
    }) as SessionStartEntry;
    validateEntry(session, path, 1);

    const fd = openSync(path, "wx+");
    try {
      writeAll(fd, `${JSON.stringify(session)}\n`);
      fsyncSync(fd);
      return new TranscriptStore(path, fd, [session]);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  static open(inputPath: string): TranscriptStore {
    const path = normalizePath(inputPath);
    const entries = readAndRepair(path);
    const fd = openSync(path, "a+");
    return new TranscriptStore(path, fd, entries);
  }

  get head(): TranscriptEntry {
    return this.#head;
  }

  get descriptor(): SessionDescriptor {
    return this.#descriptor;
  }

  entries(): readonly TranscriptEntry[] {
    return this.#entries.slice();
  }

  lineage(headId: EntryId = this.#head.id): readonly TranscriptEntry[] {
    this.#assertOpen();
    let entry = this.#byId.get(headId);
    if (entry === undefined) {
      throw new Error(`Cannot build lineage: unknown transcript entry ${JSON.stringify(headId)}`);
    }

    const reversed: TranscriptEntry[] = [];
    while (entry !== undefined) {
      reversed.push(entry);
      entry = entry.parentId === null ? undefined : this.#byId.get(entry.parentId);
    }
    reversed.reverse();
    return reversed;
  }

  append(entry: NewTranscriptEntry): TranscriptEntry {
    this.#assertOpen();

    const id = entry.id ?? this.#newEntryId();
    if (this.#byId.has(id)) {
      throw new Error(`Cannot append duplicate transcript entry id ${JSON.stringify(id)}`);
    }

    if (entry.type === "session") {
      throw new Error("Cannot append a second session entry");
    }

    const parentId = entry.parentId === undefined ? this.#head.id : entry.parentId;
    if (parentId === null || !this.#byId.has(parentId)) {
      throw new Error(`Cannot append transcript entry: unknown parent ${JSON.stringify(parentId)}`);
    }

    const persisted = canonicalEntry({
      ...entry,
      id,
      parentId,
      timestamp: entry.timestamp ?? new Date().toISOString(),
    });
    validateEntry(persisted, this.#path, this.#entries.length + 1);

    writeAll(this.#fd, `${JSON.stringify(persisted)}\n`);
    fsyncSync(this.#fd);

    this.#entries.push(persisted);
    this.#byId.set(persisted.id, persisted);
    this.#head = persisted;
    this.#descriptor = this.#makeDescriptor();
    return persisted;
  }

  fork(parentId: EntryId): TranscriptEntry {
    this.#assertOpen();
    const parent = this.#byId.get(parentId);
    if (parent === undefined) {
      throw new Error(`Cannot fork: unknown transcript entry ${JSON.stringify(parentId)}`);
    }
    this.#head = parent;
    this.#descriptor = this.#makeDescriptor();
    return parent;
  }

  close(): void {
    if (this.#closed) return;
    closeSync(this.#fd);
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Transcript store is closed");
  }

  #newEntryId(): EntryId {
    let id = generateId("e");
    while (this.#byId.has(id)) id = generateId("e");
    return id;
  }

  #makeDescriptor(): SessionDescriptor {
    return Object.freeze({
      sessionId: this.#session.sessionId,
      name: this.#session.name,
      path: this.#path,
      headId: this.#head.id,
      createdAt: this.#session.timestamp,
    });
  }
}

function readAndRepair(path: string): TranscriptEntry[] {
  const bytes = readFileSync(path);
  const lastNewline = bytes.lastIndexOf(0x0a);
  const completeEnd = lastNewline + 1;
  const completeEntries: TranscriptEntry[] = [];
  const lineOffsets: number[] = [];
  let start = 0;
  let line = 1;

  while (start < completeEnd) {
    const end = bytes.indexOf(0x0a, start);
    if (end < 0 || end >= completeEnd) break;
    completeEntries.push(parseEntryLine(bytes.subarray(start, end), path, line));
    lineOffsets.push(line);
    start = end + 1;
    line += 1;
  }

  if (completeEnd === bytes.length) {
    validateGraph(completeEntries, path, lineOffsets);
    return completeEntries;
  }
  if (completeEntries.length > 0) validateGraph(completeEntries, path, lineOffsets);

  const tail = bytes.subarray(completeEnd);
  let tailEntry: TranscriptEntry;
  try {
    tailEntry = parseEntryLine(tail, path, line);
  } catch {
    truncateAndSync(path, completeEnd);
    requireSession(completeEntries, path);
    return completeEntries;
  }

  const withTail = [...completeEntries, tailEntry];
  validateGraph(withTail, path, [...lineOffsets, line]);

  appendAndSync(path, "\n");
  return withTail;
}

function parseEntryLine(bytes: Uint8Array, path: string, line: number): TranscriptEntry {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TranscriptCorruptionError(path, line, "line is not valid UTF-8", { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new TranscriptCorruptionError(path, line, "invalid JSON", { cause: error });
  }

  validateEntry(value, path, line);
  return canonicalEntry(value);
}

function validateGraph(entries: readonly TranscriptEntry[], path: string, lines: readonly number[]): void {
  requireSession(entries, path);
  const byId = new Map<EntryId, TranscriptEntry>();
  const lineById = new Map<EntryId, number>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const line = lines[index] ?? index + 1;
    if (byId.has(entry.id)) {
      throw new TranscriptCorruptionError(path, line, `duplicate entry id ${JSON.stringify(entry.id)}`);
    }
    if (index > 0 && entry.type === "session") {
      throw new TranscriptCorruptionError(path, line, "a transcript may contain only one session entry");
    }
    byId.set(entry.id, entry);
    lineById.set(entry.id, line);
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const line = lines[index] ?? index + 1;
    if (index === 0) {
      if (entry.parentId !== null) {
        throw new TranscriptCorruptionError(path, line, "the session entry must have a null parent");
      }
      continue;
    }
    if (entry.parentId === null || !byId.has(entry.parentId)) {
      throw new TranscriptCorruptionError(
        path,
        line,
        `unknown parent id ${JSON.stringify(entry.parentId)}`,
      );
    }
  }

  const visited = new Set<EntryId>();
  for (const entry of entries) {
    if (visited.has(entry.id)) continue;
    const chain: TranscriptEntry[] = [];
    const chainIds = new Set<EntryId>();
    let current: TranscriptEntry | undefined = entry;
    while (current !== undefined && !visited.has(current.id)) {
      if (chainIds.has(current.id)) {
        throw new TranscriptCorruptionError(
          path,
          lineById.get(current.id) ?? 1,
          `parent cycle involving entry ${JSON.stringify(current.id)}`,
        );
      }
      chain.push(current);
      chainIds.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    for (const member of chain) visited.add(member.id);
  }

  const preceding = new Set<EntryId>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.parentId !== null && !preceding.has(entry.parentId)) {
      throw new TranscriptCorruptionError(
        path,
        lines[index] ?? index + 1,
        `parent id ${JSON.stringify(entry.parentId)} must precede its child`,
      );
    }
    preceding.add(entry.id);
  }
}

function requireSession(entries: readonly TranscriptEntry[], path: string): asserts entries is readonly [SessionStartEntry, ...TranscriptEntry[]] {
  if (entries.length === 0) {
    throw new TranscriptCorruptionError(path, 1, "transcript has no session entry");
  }
  if (entries[0]?.type !== "session") {
    throw new TranscriptCorruptionError(path, 1, "the first entry must be a session entry");
  }
}

function validateEntry(value: unknown, path: string, line: number): asserts value is TranscriptEntry {
  const fail = (detail: string): never => {
    throw new TranscriptCorruptionError(path, line, detail);
  };
  if (!isRecord(value)) throw new TranscriptCorruptionError(path, line, "entry must be a JSON object");
  if (!isNonEmptyString(value.id)) fail("entry id must be a non-empty string");
  if (value.parentId !== null && !isNonEmptyString(value.parentId)) {
    fail("entry parentId must be a non-empty string or null");
  }
  if (!isTimestamp(value.timestamp)) fail("entry timestamp must be a valid date string");

  switch (value.type) {
    case "session":
      for (const field of ["sessionId", "name", "origin", "workspace", "provider", "model"] as const) {
        if (!isNonEmptyString(value[field])) fail(`session ${field} must be a non-empty string`);
      }
      return;
    case "message":
      if (value.role !== "user" && value.role !== "assistant") fail("message role is invalid");
      if (!Array.isArray(value.content) || !value.content.every(isContentBlock)) {
        fail("message content must contain valid content blocks");
      }
      if (value.status !== "complete" && value.status !== "cancelled" && value.status !== "interrupted") {
        fail("message status is invalid");
      }
      return;
    case "error":
      if (!isNonEmptyString(value.classification)) fail("error classification must be a non-empty string");
      if (!isNonEmptyString(value.message)) fail("error message must be a non-empty string");
      if (value.code !== undefined && !isNonEmptyString(value.code)) {
        fail("error code must be a non-empty string");
      }
      if (value.status !== undefined &&
        (!Number.isSafeInteger(value.status) || (value.status as number) < 0)) {
        fail("error status must be a non-negative safe integer");
      }
      return;
    case "boundary":
      if (value.kind !== "compaction" && value.kind !== "clear") fail("boundary kind is invalid");
      if (value.firstKeptEntry !== null && !isNonEmptyString(value.firstKeptEntry)) {
        fail("boundary firstKeptEntry must be a non-empty string or null");
      }
      if (typeof value.summary !== "string") fail("boundary summary must be a string");
      if (!isNonNegativeFinite(value.tokensBefore) || !isNonNegativeFinite(value.tokensAfter)) {
        fail("boundary token counts must be non-negative finite numbers");
      }
      return;
    case "repair":
      if (!isNonEmptyString(value.requestId)) fail("repair requestId must be a non-empty string");
      if (!Array.isArray(value.repairs) || !value.repairs.every(isRepair)) {
        fail("repair repairs must contain valid repair records");
      }
      return;
    case "checkpoint":
      if (value.plan !== undefined && typeof value.plan !== "string") fail("checkpoint plan must be a string");
      if (!isStringArray(value.openFiles) || !isStringArray(value.pendingToolCallIds)) {
        fail("checkpoint file and tool-call lists must contain strings");
      }
      if (value.state !== undefined && !isRecord(value.state)) fail("checkpoint state must be an object");
      return;
    case "provider_switch":
      if (!isNonEmptyString(value.provider) || !isNonEmptyString(value.model)) {
        fail("provider switch provider and model must be non-empty strings");
      }
      if (
        value.apiType !== "openai_completions" &&
        value.apiType !== "openai_responses" &&
        value.apiType !== "openai_websocket" &&
        value.apiType !== "anthropic_messages"
      ) {
        fail("provider switch apiType is invalid");
      }
      if (!isStringArray(value.losses)) fail("provider switch losses must contain strings");
      return;
    default:
      fail(`unknown entry type ${JSON.stringify(value.type)}`);
  }
}

function isContentBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "thinking":
      return typeof value.thinking === "string" &&
        (value.signature === undefined || typeof value.signature === "string");
    case "image":
      return typeof value.mediaType === "string" && typeof value.data === "string";
    case "tool_use":
      return isNonEmptyString(value.id) && isNonEmptyString(value.name) && "input" in value;
    case "tool_result":
      return isNonEmptyString(value.toolUseId) &&
        (typeof value.content === "string" ||
          (Array.isArray(value.content) && value.content.every(isContentBlock))) &&
        (value.isError === undefined || typeof value.isError === "boolean");
    case "reasoning":
      return value.provider === "openai" && isRecord(value.raw);
    case "marker":
      return (value.reason === "image_dropped" ||
          value.reason === "interrupted" ||
          value.reason === "cancelled" ||
          value.reason === "truncated") &&
        typeof value.detail === "string";
    default:
      return false;
  }
}

function isRepair(value: unknown): boolean {
  return isRecord(value) &&
    isNonEmptyString(value.code) &&
    typeof value.detail === "string" &&
    (value.entryId === undefined || isNonEmptyString(value.entryId));
}

function canonicalEntry(value: unknown): TranscriptEntry {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Transcript entry is not JSON-serializable");
  const parsed: unknown = JSON.parse(serialized);
  return deepFreeze(parsed) as TranscriptEntry;
}

function deepFreeze(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

function normalizePath(path: string): string {
  if (!isNonEmptyString(path)) throw new TypeError("Transcript path must be a non-empty string");
  return resolve(path);
}

function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function truncateAndSync(path: string, length: number): void {
  truncateSync(path, length);
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function appendAndSync(path: string, text: string): void {
  const fd = openSync(path, "a");
  try {
    writeAll(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function generateId(prefix: "e" | "s"): string {
  return `${prefix}_${encodeTimestamp(Date.now())}${encodeRandom(randomBytes(10))}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTimestamp(timestamp: number): string {
  let remaining = timestamp;
  let encoded = "";
  for (let index = 0; index < 10; index += 1) {
    encoded = CROCKFORD[remaining % 32]! + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

function encodeRandom(bytes: Uint8Array): string {
  let bits = 0;
  let bitCount = 0;
  let encoded = "";
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      encoded += CROCKFORD[(bits >>> bitCount) & 31]!;
      bits &= (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0) encoded += CROCKFORD[(bits << (5 - bitCount)) & 31]!;
  return encoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
