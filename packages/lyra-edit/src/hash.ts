import type { SnapshotTag } from "./types.ts";

/** Normalize only the line-ending convention; all other bytes/code points stay unchanged. */
export function normalizeContent(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

/** Return the complete SHA-256 digest of normalized text as lowercase hexadecimal. */
export function hashContent(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(normalizeContent(content));
  return hasher.digest("hex");
}

/** Return the short snapshot tag used by the edit engine. */
export function snapshotTag(content: string): SnapshotTag {
  return `#${hashContent(content).slice(0, 8)}`;
}

/** Number of UTF-8 bytes represented by a string. */
export function byteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}
