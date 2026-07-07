import nodePath from "node:path";

type PathImpl = Pick<typeof nodePath, "relative" | "isAbsolute">;

/**
 * True when `target` is the workspace root itself or lives inside it.
 *
 * Containment is computed with `path.relative` rather than a raw
 * `target.startsWith(root + sep)` string test. The string test is
 * case-sensitive and separator-fragile, which breaks on Windows: a real path
 * resolved by `fs.realpathSync` can come back with a different drive-letter
 * case (`C:` vs `c:`) or 8.3/long-name form than the stored workspace root, and
 * OneDrive-redirected known folders make this especially common. Windows file
 * systems are case-insensitive, and `path.win32.relative` compares
 * case-insensitively, so routing containment through `relative` treats those
 * equivalent paths as equal instead of falsely reporting "outside workspace".
 *
 * Both paths must already be absolute (callers pass `realpathSync` output). The
 * `impl` seam lets tests exercise the win32 and posix dialects deterministically
 * regardless of the host OS.
 */
export function isWithinWorkspace(root: string, target: string, impl: PathImpl = nodePath): boolean {
  const rel = impl.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !impl.isAbsolute(rel));
}
