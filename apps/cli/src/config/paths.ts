import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Resolves the canonical Morrow filesystem locations. The CLI prefers to share
 * the same SQLite database as the web app: when run inside the Morrow repo, the
 * default database path matches the orchestrator's dev path
 * (services/orchestrator/.morrow/morrow.db). Outside a repo it falls back to a
 * per-user data directory.
 */
export interface MorrowPaths {
  home: string;
  repoRoot: string | null;
  userConfigFile: string;
  projectConfigFile: string | null;
  secretsFile: string;
  pidFile: string;
  logFile: string;
  defaultDbPath: string;
}

export function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  // Walk up looking for the pnpm workspace marker.
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): MorrowPaths {
  const home = env.MORROW_HOME ? resolve(env.MORROW_HOME) : join(homedir(), ".morrow");
  const repoRoot = findRepoRoot(cwd);
  const projectConfigFile = repoRoot ? join(repoRoot, ".morrow", "cli.json") : null;
  const defaultDbPath = env.DATABASE_URL
    ? resolve(env.DATABASE_URL)
    : repoRoot
      ? join(repoRoot, "services", "orchestrator", ".morrow", "morrow.db")
      : join(home, "morrow.db");
  return {
    home,
    repoRoot,
    userConfigFile: join(home, "config.json"),
    projectConfigFile,
    secretsFile: join(home, "secrets.env"),
    pidFile: join(home, "orchestrator.pid"),
    logFile: join(home, "orchestrator.log"),
    defaultDbPath,
  };
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
