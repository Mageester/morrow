import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveMorrowHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MORROW_HOME ? resolve(env.MORROW_HOME) : join(homedir(), ".morrow");
}

export function resolveDefaultDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_URL ? resolve(env.DATABASE_URL) : join(resolveMorrowHome(env), "morrow.db");
}

/** Legacy databases are migrated only from this installed Morrow source tree. */
export function resolveMorrowDevelopmentRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../..");
  return isMorrowDevelopmentRoot(root) ? root : null;
}

export function legacyDatabaseCandidatesForRepo(repoRoot: string | null): string[] {
  if (!repoRoot || !isMorrowDevelopmentRoot(repoRoot)) return [];
  return [
    join(repoRoot, ".morrow", "morrow.db"),
    join(repoRoot, "services", "orchestrator", ".morrow", "morrow.db"),
  ];
}

function isMorrowDevelopmentRoot(repoRoot: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { name?: unknown };
    return manifest.name === "morrow";
  } catch {
    return false;
  }
}

export function migrateLegacyDatabase(targetDbPath: string, candidates: string[]): { targetDbPath: string; migratedFrom: string | null } {
  const target = resolve(targetDbPath);
  if (existsSync(target)) return { targetDbPath: target, migratedFrom: null };

  const deduped = [...new Set(candidates.map((candidate) => resolve(candidate)))];
  for (const candidate of deduped) {
    if (candidate === target || !existsSync(candidate)) continue;

    mkdirSync(dirname(target), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = candidate + suffix;
      const destination = target + suffix;
      if (existsSync(source) && !existsSync(destination)) {
        copyFileSync(source, destination);
      }
    }

    return { targetDbPath: target, migratedFrom: candidate };
  }

  return { targetDbPath: target, migratedFrom: null };
}
