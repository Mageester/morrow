import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  legacyDatabaseCandidatesForRepo,
  migrateLegacyDatabase,
  resolveDefaultDatabasePath,
  resolveMorrowHome,
} from "../src/home.js";

describe("Morrow home helpers", () => {
  it("resolves MORROW_HOME-based locations", () => {
    const customHome = join(tmpdir(), "custom-morrow-home");
    expect(resolveMorrowHome({ MORROW_HOME: customHome } as NodeJS.ProcessEnv)).toBe(customHome);
    expect(resolveDefaultDatabasePath({ MORROW_HOME: customHome } as NodeJS.ProcessEnv)).toBe(join(customHome, "morrow.db"));
  });

  it("lists legacy repo database candidates in stable order", () => {
    const repo = join(tmpdir(), "repo-root");
    try {
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "morrow" }));
      expect(legacyDatabaseCandidatesForRepo(repo)).toEqual([
        join(repo, ".morrow", "morrow.db"),
        join(repo, "services", "orchestrator", ".morrow", "morrow.db"),
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects legacy database candidates from unrelated workspaces", () => {
    const repo = mkdtempSync(join(tmpdir(), "morrow-untrusted-workspace-"));
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "other-project" }));
      expect(legacyDatabaseCandidatesForRepo(repo)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("copies legacy database files into MORROW_HOME when target is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-home-"));
    const legacyDir = join(root, "repo", "services", "orchestrator", ".morrow");
    const targetDir = join(root, "home");
    try {
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "morrow.db"), "main");
      writeFileSync(join(legacyDir, "morrow.db-wal"), "wal");
      writeFileSync(join(legacyDir, "morrow.db-shm"), "shm");

      const target = join(targetDir, "morrow.db");
      const migration = migrateLegacyDatabase(target, [join(legacyDir, "morrow.db")]);

      expect(migration.migratedFrom).toBe(join(legacyDir, "morrow.db"));
      expect(readFileSync(target, "utf8")).toBe("main");
      expect(readFileSync(target + "-wal", "utf8")).toBe("wal");
      expect(readFileSync(target + "-shm", "utf8")).toBe("shm");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
