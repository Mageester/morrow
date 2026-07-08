import { readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { posix, win32, relative, resolve, sep } from "node:path";
import { createGitignoreMatcher, isBuiltInIgnoredName } from "./ignore.js";
import { isWithinWorkspace } from "./path-boundary.js";

export class WorkspaceInspectionError extends Error {
  readonly code = "workspace_inspection_rejected";
  constructor(message = "Workspace path is outside configured workspace") { super(message); }
}

export type WorkspaceEntry = { path: string; type: "file"; size?: number };
export type WorkspaceInspection = { entries: WorkspaceEntry[]; truncatedByDepth: boolean; truncatedByCount: boolean; inaccessibleEntryCount: number };
export type WorkspaceInspectionOptions = { startPath?: string; maxDepth: number; maxResults: number };

function contained(root: string, target: string) { return isWithinWorkspace(root, target); }
function normalized(root: string, target: string) { return relative(root, target).split(sep).join("/"); }
function isAnyAbsolutePath(candidate: string) { return posix.isAbsolute(candidate) || win32.isAbsolute(candidate); }

export function inspectWorkspace(canonicalRoot: string, options: WorkspaceInspectionOptions): WorkspaceInspection {
  if (!Number.isInteger(options.maxDepth) || options.maxDepth < 0 || !Number.isInteger(options.maxResults) || options.maxResults < 1) throw new WorkspaceInspectionError("Workspace inspection limits are invalid");
  const root = realpathSync(canonicalRoot);
  const requested = options.startPath ?? "";
  if (isAnyAbsolutePath(requested) || requested.split(/[\\/]+/).includes("..")) throw new WorkspaceInspectionError();
  const start = realpathSync(resolve(root, requested));
  if (!contained(root, start)) throw new WorkspaceInspectionError();
  const entries: WorkspaceEntry[] = [];
  const visited = new Set<string>();
  let truncatedByDepth = false;
  let truncatedByCount = false;
  let inaccessibleEntryCount = 0;
  const ignoredByGitignore = createGitignoreMatcher(root, (path) => {
    try { return readFileSync(path, "utf8"); } catch { return null; }
  });

  const walk = (directory: string, depth: number) => {
    if (visited.has(directory)) return;
    visited.add(directory);
    let children: Dirent<string>[];
    try { children = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)); }
    catch { inaccessibleEntryCount++; return; }
    for (const child of children) {
      if (isBuiltInIgnoredName(child.name, child.isDirectory())) continue;
      if (entries.length >= options.maxResults) { truncatedByCount = true; return; }
      const candidate = resolve(directory, child.name);
      const rel = normalized(root, candidate);
      if (ignoredByGitignore(rel, child.isDirectory())) continue;
      let target: string;
      try { target = realpathSync(candidate); } catch { inaccessibleEntryCount++; continue; }
      if (!contained(root, target)) throw new WorkspaceInspectionError();
      let stat: ReturnType<typeof statSync>;
      try { stat = statSync(target); } catch { inaccessibleEntryCount++; continue; }
      if (stat.isDirectory()) {
        if (depth >= options.maxDepth) { truncatedByDepth = true; continue; }
        walk(target, depth + 1);
      } else if (stat.isFile()) {
        entries.push({ path: normalized(root, target), type: "file", size: stat.size });
      }
    }
  };
  // A start path that resolves to a file is treated as a single-file scope
  // rather than an error. Models routinely pass a concrete file path to
  // search_text/search_files/list_files ("search inside foo.ts"); throwing
  // "Workspace start path must be a directory" turned that natural request into
  // an opaque tool failure. Containment and traversal were already enforced
  // above, so returning just the file is safe. gitignore is intentionally not
  // applied to an explicitly requested file — the caller asked for it by name.
  const startStat = statSync(start);
  if (!startStat.isDirectory()) {
    if (startStat.isFile()) {
      entries.push({ path: normalized(root, start), type: "file", size: startStat.size });
    }
    return { entries, truncatedByDepth, truncatedByCount, inaccessibleEntryCount };
  }
  walk(start, 0);
  return { entries, truncatedByDepth, truncatedByCount, inaccessibleEntryCount };
}
