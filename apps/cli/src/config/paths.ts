import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { legacyDatabaseCandidatesForRepo, resolveDefaultDatabasePath, resolveMorrowDevelopmentRoot, resolveMorrowHome } from "@morrow/orchestrator";

/**
 * Resolves the canonical Morrow filesystem locations. Global service state
 * lives under MORROW_HOME by default, while repository-local .morrow remains
 * available for project metadata such as CLI config.
 */
export interface MorrowPaths {
  home: string;
  repoRoot: string | null;
  legacyDbPaths: string[];
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
  const home = resolveMorrowHome(env);
  const repoRoot = findRepoRoot(cwd);
  const projectConfigFile = repoRoot ? join(repoRoot, ".morrow", "cli.json") : null;
  const defaultDbPath = resolveDefaultDatabasePath(env);
  return {
    home,
    repoRoot,
    legacyDbPaths: legacyDatabaseCandidatesForRepo(resolveMorrowDevelopmentRoot()),
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
