import { dlopen, FFIType, read } from "bun:ffi";

/**
 * macOS `clonefile(2)`.
 *
 * APFS clones a whole hierarchy in one kernel call — "If src names a directory, the
 * directory hierarchy is cloned as if by a recursive copy" — sharing extents instead of
 * copying bytes. A repository workspace is therefore ~30 syscalls rather than 80k userland
 * copies, and costs no disk until something is written.
 */

/**
 * `CLONE_NOFOLLOW`: clone a symbolic link itself instead of the file it points at.
 *
 * Without it a top-level symlink is dereferenced and materialised as a real hierarchy,
 * which both diverges from the per-file copy path (Node's `cp` preserves links) and would
 * happily pull an out-of-tree target into the workspace. Links nested inside a cloned
 * directory are always cloned as links, so this also keeps the top level consistent with
 * everything below it.
 */
const CLONE_NOFOLLOW = 0x0001;

/** Darwin errno names worth reading in a fallback message. */
const ERRNO_NAMES: Readonly<Record<number, string>> = {
  1: "EPERM", 2: "ENOENT", 13: "EACCES", 17: "EEXIST", 18: "EXDEV", 20: "ENOTDIR",
  21: "EISDIR", 22: "EINVAL", 28: "ENOSPC", 30: "EROFS", 45: "ENOTSUP", 62: "ELOOP",
  63: "ENAMETOOLONG", 69: "EDQUOT", 102: "EOPNOTSUPP",
};

export interface CloneOutcome {
  ok: boolean;
  errno?: number;
  message?: string;
}

/**
 * Clones one filesystem entry. Injectable so tests can script a failure and exercise the
 * portable fallback on a machine where the real call would succeed.
 */
export type CloneEntry = (source: string, destination: string) => CloneOutcome | Promise<CloneOutcome>;

interface NativeClone {
  clonefile(source: Uint8Array, destination: Uint8Array, flags: number): number;
  errno(): number;
}

let native: NativeClone | null | undefined;

function loadNative(): NativeClone | null {
  if (native !== undefined) return native;
  native = null;
  if (process.platform !== "darwin") return native;
  try {
    // libSystem lives in the dyld shared cache on modern macOS; dlopen still resolves it.
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      clonefile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    native = {
      clonefile: (source, destination, flags) => library.symbols.clonefile(source, destination, flags),
      errno: () => {
        const location = library.symbols.__error();
        return location ? read.i32(location, 0) : 0;
      },
    };
  } catch {
    // No FFI, no libSystem, or a sandbox that forbids dlopen: the caller copies instead.
    native = null;
  }
  return native;
}

function cPath(path: string): Uint8Array {
  return Buffer.from(`${path}\0`, "utf8");
}

/** True when the in-kernel clone is callable at all; it can still fail per filesystem. */
export function clonefileSupported(): boolean {
  return loadNative() !== null;
}

/**
 * Clone `source` to `destination` in the kernel. `destination` must not exist.
 *
 * Every failure is reported rather than thrown: an unsupported filesystem (`ENOTSUP`), a
 * different volume (`EXDEV`), or a permission problem all mean "copy this the slow way".
 */
export const nativeCloneEntry: CloneEntry = (source, destination) => {
  const library = loadNative();
  if (!library) {
    return { ok: false, message: process.platform === "darwin" ? "clonefile could not be loaded from libSystem" : `clonefile is macOS-only (platform ${process.platform})` };
  }
  const result = library.clonefile(cPath(source), cPath(destination), CLONE_NOFOLLOW);
  if (result === 0) return { ok: true };
  const errno = library.errno();
  return { ok: false, errno, message: `${ERRNO_NAMES[errno] ?? `errno ${errno}`} cloning ${source}` };
};
