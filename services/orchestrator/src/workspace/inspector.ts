import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class WorkspaceInspectionError extends Error {
  readonly code = "workspace_inspection_rejected";
  constructor(message = "Workspace path is outside configured workspace") { super(message); }
}

export type WorkspaceEntry = { path: string; type: "file"; size?: number };
export type WorkspaceInspection = { entries: WorkspaceEntry[]; truncatedByDepth: boolean; truncatedByCount: boolean; inaccessibleEntryCount: number };
export type WorkspaceInspectionOptions = { startPath?: string; maxDepth: number; maxResults: number };

function contained(root: string, target: string) { return target === root || target.startsWith(`${root}${sep}`); }
function normalized(root: string, target: string) { return relative(root, target).split(sep).join("/"); }

export function inspectWorkspace(canonicalRoot: string, options: WorkspaceInspectionOptions): WorkspaceInspection {
  if (!Number.isInteger(options.maxDepth) || options.maxDepth < 0 || !Number.isInteger(options.maxResults) || options.maxResults < 1) throw new WorkspaceInspectionError("Workspace inspection limits are invalid");
  const root = realpathSync(canonicalRoot);
  const requested = options.startPath ?? "";
  if (isAbsolute(requested) || requested.split(/[\\/]+/).includes("..")) throw new WorkspaceInspectionError();
  const start = realpathSync(resolve(root, requested));
  if (!contained(root, start)) throw new WorkspaceInspectionError();
  const entries: WorkspaceEntry[] = [];
  const visited = new Set<string>();
  let truncatedByDepth = false;
  let truncatedByCount = false;
  let inaccessibleEntryCount = 0;

  const walk = (directory: string, depth: number) => {
    if (visited.has(directory)) return;
    visited.add(directory);
    let children: Dirent<string>[];
    try { children = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)); }
    catch { inaccessibleEntryCount++; return; }
    for (const child of children) {
      if (child.name === ".morrow") continue;
      if (entries.length >= options.maxResults) { truncatedByCount = true; return; }
      const candidate = resolve(directory, child.name);
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
  if (!statSync(start).isDirectory()) throw new WorkspaceInspectionError("Workspace start path must be a directory");
  walk(start, 0);
  return { entries, truncatedByDepth, truncatedByCount, inaccessibleEntryCount };
}
