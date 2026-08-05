import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ArtifactStore } from "./types.ts";

/** Metadata retained alongside each content-addressed artifact. */
export interface ArtifactMetadata {
  readonly id: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly name?: string;
}

const URI_RE = /^artifact:\/\/([a-f0-9]{64})$/i;
const HASH_RE = /^[a-f0-9]{64}$/i;

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
}

function artifactHash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function safeName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  // Metadata is not used as a filesystem path. Still reject control characters so
  // callers can safely display it without introducing terminal escapes.
  return trimmed.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 512);
}

function normalizeId(value: string): string {
  const match = URI_RE.exec(value) ?? (HASH_RE.test(value) ? ["", value] : undefined);
  if (!match) throw new Error("Invalid artifact id; expected artifact:// followed by a 64-character SHA-256 id.");
  return match[1]!.toLowerCase();
}

/**
 * Durable content-addressed storage for tool output. A write is completed by
 * renaming a temporary file, so a process crash cannot leave a partial artifact.
 */
export class FileArtifactStore implements ArtifactStore {
  readonly directory: string;
  readonly #metadata = new Map<string, ArtifactMetadata>();

  constructor(root: string) {
    if (typeof root !== "string" || root.length === 0) throw new Error("ArtifactStore requires a non-empty root path.");
    this.directory = resolve(root, ".lyra", "artifacts");
  }

  async put(content: string | Uint8Array, options: { mimeType?: string; name?: string } = {}): Promise<string> {
    const bytes = bytesOf(content);
    const hash = artifactHash(bytes);
    const dataPath = join(this.directory, hash);
    const safeArtifactName = safeName(options.name);
    const metadata: ArtifactMetadata = safeArtifactName === undefined
      ? {
        id: `artifact://${hash}`,
        bytes: bytes.byteLength,
        mimeType: typeof options.mimeType === "string" && options.mimeType.trim() ? options.mimeType.trim() : "application/octet-stream",
      }
      : {
        id: `artifact://${hash}`,
        bytes: bytes.byteLength,
        mimeType: typeof options.mimeType === "string" && options.mimeType.trim() ? options.mimeType.trim() : "application/octet-stream",
        name: safeArtifactName,
      };
    await mkdir(this.directory, { recursive: true });
    try {
      const existing = await readFile(dataPath);
      if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
        // A SHA-256 collision is not expected, but never silently overwrite data.
        throw new Error(`Artifact hash collision at ${hash}; refusing to overwrite existing content.`);
      }
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT/.test(error.message)) throw error;
      const temporary = join(this.directory, `.${hash}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        await rename(temporary, dataPath);
      } catch (writeError) {
        try {
          const existing = await readFile(dataPath);
          if (!Buffer.from(existing).equals(Buffer.from(bytes))) throw writeError;
        } catch {
          throw writeError;
        }
      }
    }
    const metadataPath = `${dataPath}.json`;
    try {
      await stat(metadataPath);
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT/.test(error.message)) throw error;
      const temporary = `${metadataPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(temporary, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
      try {
        await rename(temporary, metadataPath);
      } catch {
        // Another concurrent writer may have won. The bytes are immutable and
        // metadata is advisory, so retaining its complete record is sufficient.
        try { await readFile(temporary); } catch { /* already renamed */ }
      }
    }
    this.#metadata.set(hash, metadata);
    return metadata.id;
  }

  async read(id: string): Promise<Uint8Array> {
    const hash = normalizeId(id);
    const data = await readFile(join(this.directory, hash));
    return new Uint8Array(data);
  }

  async metadata(id: string): Promise<ArtifactMetadata> {
    const hash = normalizeId(id);
    const cached = this.#metadata.get(hash);
    if (cached) return cached;
    const dataPath = join(this.directory, hash);
    const raw = await readFile(`${dataPath}.json`, "utf8");
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || (value as { id?: unknown }).id !== `artifact://${hash}`) {
      throw new Error(`Artifact metadata for ${id} is invalid.`);
    }
    const metadata = value as ArtifactMetadata;
    this.#metadata.set(hash, metadata);
    return metadata;
  }
}

/** Alias used by callers that do not need to know the backing implementation. */
export const ArtifactStoreFs = FileArtifactStore;

export function createArtifactStore(root: string): FileArtifactStore {
  return new FileArtifactStore(root);
}

export function artifactId(value: string): string {
  return `artifact://${normalizeId(value)}`;
}

export function isArtifactUri(value: unknown): value is `artifact://${string}` {
  return typeof value === "string" && URI_RE.test(value);
}
