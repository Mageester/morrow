import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * File completion for `@` references.
 *
 * A bounded, lazy walk of the workspace rather than a watcher or an index:
 * completion has to feel instant on the first keystroke of a cold session, and
 * a project scan that blocks the first frame is worse than a slightly smaller
 * candidate set.
 *
 * Directories that are never worth referencing are skipped outright — they are
 * also the ones large enough to make the walk slow.
 */
const SKIP = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next",
  ".turbo", ".cache", "target", "vendor", "__pycache__", ".venv",
]);

const MAX_FILES = 4_000;

export function buildFileIndex(root: string, maxFiles = MAX_FILES): string[] {
  const files: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0 && files.length < maxFiles) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // Unreadable directory: skip it rather than fail completion.
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) {
        files.push(relative(root, full).split(sep).join("/"));
        if (files.length >= maxFiles) break;
      }
    }
  }
  return files;
}

/**
 * Ranks candidates for a typed prefix. A basename match outranks a match buried
 * in a directory name, because "app" almost always means `app.tsx`, not
 * `apps/web/src/…/other.ts`.
 */
export function completeFile(index: readonly string[], prefix: string, limit = 10): string[] {
  const query = prefix.toLowerCase();
  if (!query) return index.slice(0, limit);

  const scored: Array<{ path: string; score: number }> = [];
  for (const path of index) {
    const lower = path.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let score = -1;
    if (base.startsWith(query)) score = 100 - base.length;
    else if (lower.startsWith(query)) score = 80 - lower.length / 10;
    else if (base.includes(query)) score = 50 - base.length;
    else if (lower.includes(query)) score = 20 - lower.length / 10;
    if (score >= 0) scored.push({ path, score });
  }
  return scored
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map((entry) => entry.path);
}
