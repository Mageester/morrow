import nodePath, { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { realpathSync } from "node:fs";

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

export type WorkspacePathRejection = {
  ok: false;
  code: "path_outside_workspace" | "path_traversal";
  message: string;
  /** A concrete, valid value the caller can copy. */
  example: string;
};

export type WorkspacePathNormalization = { ok: true; path: string } | WorkspacePathRejection;

function isAnyAbsolute(candidate: string): boolean {
  return posix.isAbsolute(candidate) || win32.isAbsolute(candidate);
}

/** Best-effort canonical root. A root that cannot be resolved is used as-is. */
function rootCandidates(root: string): string[] {
  const values = [resolve(root)];
  try {
    const real = realpathSync(root);
    if (!values.includes(real)) values.push(real);
  } catch { /* an unresolvable root simply has one candidate */ }
  return values;
}

/**
 * Turn any caller-supplied path into a workspace-relative path, or explain
 * precisely why it cannot be one.
 *
 * Naming a workspace file by its absolute path is an ordinary thing for a model
 * to do, and rejecting it outright taught nothing: live evidence showed a model
 * re-sending the workspace's own absolute path eleven times against a message
 * claiming the path was "outside configured workspace". An absolute path that
 * genuinely resolves inside the root is therefore normalized rather than
 * refused.
 *
 * This is a LEXICAL normalization only. It never widens the security boundary:
 * every caller still runs its existing `realpathSync` + `isWithinWorkspace`
 * containment check, its denied-name check, and its symlink-escape check on the
 * normalized result. All this removes is a blanket "absolute paths are
 * rejected" rule that was refusing paths the containment check would have
 * accepted anyway.
 */
export function normalizeWorkspacePath(root: string, requested: string): WorkspacePathNormalization {
  const example = "assets/site.css";
  const traversalRejection = (value: string): WorkspacePathRejection => ({
    ok: false,
    code: "path_traversal",
    message: `Path "${value}" uses a ".." parent-traversal segment, which is never accepted. Pass a path relative to the workspace root with no ".." segments.`,
    example,
  });

  if (!isAnyAbsolute(requested)) {
    // A relative path keeps its exact spelling; the owning tool applies its own
    // traversal and containment rules. Only reject the traversal here so every
    // tool reports it the same, actionable way.
    if (requested.split(/[\\/]+/).includes("..")) return traversalRejection(requested);
    return { ok: true, path: requested };
  }

  // A win32-absolute path on a posix host (or the reverse) can never resolve
  // inside this root, so report it as outside rather than mangling it.
  const nativeAbsolute = isAbsolute(requested);
  if (nativeAbsolute) {
    const target = resolve(requested);
    for (const candidate of rootCandidates(root)) {
      const rel = relative(candidate, target);
      if (rel === "") return { ok: true, path: "." };
      if (!rel.startsWith("..") && !isAbsolute(rel)) {
        const normalized = rel.split(sep).join("/");
        if (normalized.split("/").includes("..")) return traversalRejection(requested);
        return { ok: true, path: normalized };
      }
    }
  }

  return {
    ok: false,
    code: "path_outside_workspace",
    message: `Path "${requested}" is outside this task's workspace root (${resolve(root)}). Pass a path relative to that root, or an absolute path inside it.`,
    example,
  };
}
