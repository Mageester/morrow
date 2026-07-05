import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Deterministic, scoped repository fingerprints.
 *
 * Staleness detection hinges on these: each scope hashes only the files whose
 * change would actually invalidate the corresponding knowledge, so an edit to
 * an unrelated source file never invalidates architecture intelligence, while
 * a lockfile or workspace change invalidates exactly the affected scope.
 *
 * Pure code analysis — no model calls, no repository content stored beyond
 * hashes and repo-relative paths.
 */

export interface ScopeFingerprint {
  scope: string;
  hash: string;
  files: string[];
}

/** Files whose change invalidates a given knowledge scope (repo-relative). */
const SCOPE_PATTERNS: Record<string, RegExp[]> = {
  manifests: [/(^|\/)package\.json$/, /(^|\/)Cargo\.toml$/, /(^|\/)pyproject\.toml$/, /(^|\/)go\.mod$/, /(^|\/)composer\.json$/, /(^|\/)Gemfile$/],
  lockfiles: [/(^|\/)pnpm-lock\.yaml$/, /(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)Cargo\.lock$/, /(^|\/)poetry\.lock$/, /(^|\/)go\.sum$/],
  workspaces: [/^pnpm-workspace\.yaml$/, /^lerna\.json$/, /^nx\.json$/, /^turbo\.json$/, /^rush\.json$/],
  build_config: [/^tsconfig.*\.json$/, /(^|\/)tsconfig.*\.json$/, /^vite\.config\./, /^webpack\.config\./, /^rollup\.config\./, /^esbuild\./, /^\.swcrc$/, /^babel\.config\./],
  test_config: [/(^|\/)vitest\.config\./, /(^|\/)jest\.config\./, /(^|\/)playwright\.config\./, /(^|\/)cypress\.config\./, /(^|\/)\.mocharc/],
  ci: [/^\.github\/workflows\/.+\.(yml|yaml)$/],
  database: [/(^|\/)migrations?\//, /(^|\/)schema\.(sql|prisma)$/, /(^|\/)database\.(ts|js|py)$/],
  rules: [/^\.morrow\/rules\.json$/],
};

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".turbo", ".next", "target", "__pycache__", ".venv", "venv", ".artifacts", "test-results"]);
const MAX_DEPTH = 5;
const MAX_FILES_PER_SCOPE = 400;

/** Walk the repo (bounded) and collect repo-relative paths matching any scope. */
export function collectScopeFiles(workspacePath: string): Map<string, string[]> {
  const byScope = new Map<string, string[]>(Object.keys(SCOPE_PATTERNS).map((s) => [s, []]));
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        // Hidden directories are skipped except the two that carry
        // architecture-relevant files (CI workflows, Morrow rules).
        if (entry.startsWith(".") && entry !== ".github" && entry !== ".morrow") continue;
        walk(full, relPath, depth + 1);
      } else {
        for (const [scope, patterns] of Object.entries(SCOPE_PATTERNS)) {
          if (patterns.some((p) => p.test(relPath))) {
            const list = byScope.get(scope)!;
            if (list.length < MAX_FILES_PER_SCOPE) list.push(relPath);
          }
        }
      }
    }
  };
  walk(workspacePath, "", 0);
  for (const list of byScope.values()) list.sort();
  return byScope;
}

function hashFiles(workspacePath: string, files: string[]): string {
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update("\0");
    try {
      const full = join(workspacePath, rel);
      if (existsSync(full)) h.update(readFileSync(full));
    } catch { /* unreadable file contributes only its path */ }
    h.update("\0");
  }
  return h.digest("hex");
}

/** Compute all scoped fingerprints for a repository. */
export function computeScopeFingerprints(workspacePath: string): ScopeFingerprint[] {
  const byScope = collectScopeFiles(workspacePath);
  return [...byScope.entries()].map(([scope, files]) => ({
    scope,
    files,
    hash: hashFiles(workspacePath, files),
  }));
}

/** Whole-repository fingerprint over every architecture-critical file. */
export function computeRepositoryFingerprint(scopes: ScopeFingerprint[]): string {
  const h = createHash("sha256");
  for (const s of [...scopes].sort((a, b) => a.scope.localeCompare(b.scope))) {
    h.update(s.scope);
    h.update(s.hash);
  }
  return h.digest("hex");
}

/** Which scopes changed between a stored fingerprint set and the repo now. */
export function diffScopes(stored: ScopeFingerprint[], current: ScopeFingerprint[]): string[] {
  const before = new Map(stored.map((s) => [s.scope, s.hash]));
  const changed: string[] = [];
  for (const s of current) {
    if (before.get(s.scope) !== s.hash) changed.push(s.scope);
  }
  return changed.sort();
}
