import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyDatabaseCandidatesForRepo, resolveMorrowDevelopmentRoot } from "@morrow/orchestrator";
import { resolvePaths } from "../src/config/paths.js";

describe("resolvePaths", () => {
  it("uses MORROW_HOME and never treats the current project as a legacy database source", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-cli-paths-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    try {
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");

      const paths = resolvePaths({ MORROW_HOME: home }, repo);

      expect(paths.home).toBe(home);
      expect(paths.defaultDbPath).toBe(join(home, "morrow.db"));
      expect(paths.legacyDbPaths).toEqual(legacyDatabaseCandidatesForRepo(resolveMorrowDevelopmentRoot()));
      expect(paths.legacyDbPaths).not.toContain(join(repo, ".morrow", "morrow.db"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
