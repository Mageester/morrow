import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrations, openDatabase } from "../src/database.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { projectRepository } from "../src/repositories/projects.js";

// ════════════════════════════════════════════════════════════════════════════
// BLOCKER 3 — migration 28 was edited in place after it had already been
// applied to real databases. Migration 28 (in src/database.ts) has been
// restored to its EXACT original schema as of commit 29d036471bc0aaf7ce7687a
// -09fc422c1 (see `git show 29d0364...:services/orchestrator/src/database.ts`),
// and every schema change that had been smuggled into the edited copy is
// delivered as a new, deterministic migration 29.
//
// These tests exercise all three historical starting points that must
// converge on the same final schema:
//   A. a database created at 29d0364, with the ORIGINAL (un-edited) migration
//      28 actually applied;
//   B. a development database at f812872, whose migration 28 had ALREADY been
//      silently edited (source_locator present, nullable pointer + old
//      triggers already applied under migration id 28);
//   C. a brand-new database running migrations 1..29 in order.
// ════════════════════════════════════════════════════════════════════════════

const roots: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

/** The EXACT migration-28 SQL as it existed at commit 29d036471bc0aaf7ce7687a
 *  d3-09fc422c1, BEFORE it was edited. Captured via:
 *  `git show 29d036471bc0aaf7ce7687a09fc422c1:services/orchestrator/src/database.ts`
 *  Hardcoded here as an immutable historical fixture — this is the schema a
 *  real 29d0364-era database actually has on disk, independent of whatever
 *  src/database.ts says migration 28 is today. */
const ORIGINAL_MIGRATION_28_SQL = `
    CREATE TABLE mission_contracts (
      mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL,
      source_prompt TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      expected_artifacts_json TEXT NOT NULL DEFAULT '[]',
      acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
      verification_commands_json TEXT NOT NULL DEFAULT '[]',
      required_git_result TEXT,
      unresolved_ambiguities_json TEXT NOT NULL DEFAULT '[]',
      frozen INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE mission_requirement_nodes (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      ordering INTEGER NOT NULL,
      statement TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'objective',
      source_prompt_excerpt TEXT,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      authoritative INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      dependencies_json TEXT NOT NULL DEFAULT '[]',
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      affected_files_json TEXT NOT NULL DEFAULT '[]',
      verified_file_hashes_json TEXT NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_failure_json TEXT,
      completed_at TEXT,
      invalidation_history_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX mission_requirement_nodes_mission_idx ON mission_requirement_nodes(mission_id, ordering);
    CREATE UNIQUE INDEX mission_requirement_nodes_one_active ON mission_requirement_nodes(mission_id) WHERE status = 'active';
    CREATE TABLE mission_cursors (
      mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL,
      active_node_id TEXT,
      active_objective TEXT,
      allowed_next_actions_json TEXT NOT NULL DEFAULT '[]',
      blocked_reason TEXT,
      last_completed_action TEXT,
      frozen_node_ids_json TEXT NOT NULL DEFAULT '[]',
      invalidated_node_ids_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE project_active_mission (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE SET NULL,
      schema_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `;

/** The migration-28 SQL as it existed (already edited) at commit f8128724450
 *  ee6a51bb9cfa7681e7c836cd97205 — the divergent copy this whole blocker is
 *  about. Captured from `git show f812872...:.../database.ts` before this
 *  repair began. */
const EDITED_F812872_MIGRATION_28_SQL = `
    CREATE TABLE mission_contracts (
      mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL,
      source_prompt TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      expected_artifacts_json TEXT NOT NULL DEFAULT '[]',
      acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
      verification_commands_json TEXT NOT NULL DEFAULT '[]',
      required_git_result TEXT,
      unresolved_ambiguities_json TEXT NOT NULL DEFAULT '[]',
      frozen INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE mission_requirement_nodes (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      ordering INTEGER NOT NULL,
      statement TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'objective',
      source_prompt_excerpt TEXT,
      source_locator TEXT,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      authoritative INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      dependencies_json TEXT NOT NULL DEFAULT '[]',
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      affected_files_json TEXT NOT NULL DEFAULT '[]',
      verified_file_hashes_json TEXT NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_failure_json TEXT,
      completed_at TEXT,
      invalidation_history_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX mission_requirement_nodes_mission_idx ON mission_requirement_nodes(mission_id, ordering);
    CREATE UNIQUE INDEX mission_requirement_nodes_one_active ON mission_requirement_nodes(mission_id) WHERE status = 'active';
    CREATE TABLE mission_cursors (
      mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL,
      active_node_id TEXT,
      active_objective TEXT,
      allowed_next_actions_json TEXT NOT NULL DEFAULT '[]',
      blocked_reason TEXT,
      last_completed_action TEXT,
      frozen_node_ids_json TEXT NOT NULL DEFAULT '[]',
      invalidated_node_ids_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE project_active_mission (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
      schema_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TRIGGER project_active_mission_owner_ai
    BEFORE INSERT ON project_active_mission
    WHEN NEW.mission_id IS NOT NULL
      AND (SELECT project_id FROM missions WHERE id = NEW.mission_id) IS NOT NEW.project_id
    BEGIN
      SELECT RAISE(ABORT, 'project_active_mission: mission is not owned by this project');
    END;
    CREATE TRIGGER project_active_mission_owner_au
    BEFORE UPDATE ON project_active_mission
    WHEN NEW.mission_id IS NOT NULL
      AND (SELECT project_id FROM missions WHERE id = NEW.mission_id) IS NOT NEW.project_id
    BEGIN
      SELECT RAISE(ABORT, 'project_active_mission: mission is not owned by this project');
    END;
  `;

/** Build a raw file-backed database at exactly "migrations 1..27 (current) +
 *  the given historical migration-28 SQL", with schema_migrations correctly
 *  recording ids 1..28 as applied — i.e. a faithful reconstruction of a real
 *  historical database, NOT run through the current openDatabase(). */
function buildHistoricalDb(dbPath: string, migration28Sql: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE schema_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
  const insertMigrationRow = db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)");
  for (const m of migrations) {
    if (m.id >= 28) continue; // apply 1..27 from the current (unchanged) definitions
    db.transaction(() => {
      db.exec(m.sql!);
      insertMigrationRow.run(m.id, m.name, new Date().toISOString());
    })();
  }
  db.transaction(() => {
    db.exec(migration28Sql);
    insertMigrationRow.run(28, "mission_kernel_contract_ledger_cursor", new Date().toISOString());
  })();
  db.close();
  return db;
}

function seedRepresentativeData(dbPath: string, opts: { nodeHasSourceLocator: boolean }) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects (id, schema_version, name, workspace_path, created_at, updated_at) VALUES (?,1,?,?,?,?)")
    .run("proj-1", "Project One", "/tmp/proj-1", now, now);
  db.prepare("INSERT INTO projects (id, schema_version, name, workspace_path, created_at, updated_at) VALUES (?,1,?,?,?,?)")
    .run("proj-2", "Project Two", "/tmp/proj-2", now, now);
  db.prepare(
    `INSERT INTO missions (id, schema_version, project_id, objective, status, auto_approve, task_tree_root_id, budget_json, result_json, created_at, updated_at, started_at, completed_at)
     VALUES (?,1,?,?, 'running', 0, NULL, ?, NULL, ?, ?, ?, NULL)`,
  ).run("mission-1", "proj-1", "Historical objective", JSON.stringify({ maxUsd: null, maxAttempts: null, maxReviewCycles: 2, spentUsd: 0, attemptsUsed: 0, reviewCyclesUsed: 0 }), now, now, now);
  db.prepare(
    `INSERT INTO mission_contracts (mission_id, schema_version, source_prompt, objective, expected_artifacts_json, acceptance_criteria_json, verification_commands_json, required_git_result, unresolved_ambiguities_json, frozen, created_at, updated_at)
     VALUES (?,1,?,?, '[]','[]','[]', NULL, '[]', 0, ?, ?)`,
  ).run("mission-1", "Historical objective", "Historical objective", now, now);

  if (opts.nodeHasSourceLocator) {
    db.prepare(
      `INSERT INTO mission_requirement_nodes (id, mission_id, ordering, statement, category, source_prompt_excerpt, source_locator, source, confidence, approved, authoritative, status, dependencies_json, evidence_refs_json, affected_files_json, verified_file_hashes_json, attempts, last_failure_json, completed_at, invalidation_history_json, created_at, updated_at)
       VALUES (?,?,0,?,?,?,?,?,1,1,1,'pending','[]','[]','[]','[]',0,NULL,NULL,'[]',?,?)`,
    ).run("node-1", "mission-1", "Deliver the report", "objective", "excerpt", "contract.objective", "user", now, now);
  } else {
    db.prepare(
      `INSERT INTO mission_requirement_nodes (id, mission_id, ordering, statement, category, source_prompt_excerpt, source, confidence, approved, authoritative, status, dependencies_json, evidence_refs_json, affected_files_json, verified_file_hashes_json, attempts, last_failure_json, completed_at, invalidation_history_json, created_at, updated_at)
       VALUES (?,?,0,?,?,?,?,1,1,1,'pending','[]','[]','[]','[]',0,NULL,NULL,'[]',?,?)`,
    ).run("node-1", "mission-1", "Deliver the report", "objective", "excerpt", "user", now, now);
  }
  db.prepare(
    `INSERT INTO mission_cursors (mission_id, schema_version, active_node_id, active_objective, allowed_next_actions_json, blocked_reason, last_completed_action, frozen_node_ids_json, invalidated_node_ids_json, updated_at)
     VALUES (?,1,NULL,NULL,'[]',NULL,NULL,'[]','[]',?)`,
  ).run("mission-1", now);
  db.prepare(
    `INSERT INTO project_active_mission (project_id, mission_id, schema_version, updated_at) VALUES (?,?,1,?)`,
  ).run("proj-1", "mission-1", now);
  db.close();
}

describe("BLOCKER 3 — migration 29 upgrades a genuine 29d0364-era database", () => {
  it("migration 29 applies, preserves data, adds source_locator, and rebuilds project_active_mission", () => {
    const dbPath = join(tmp("ek-mig-a-"), "m.db");
    buildHistoricalDb(dbPath, ORIGINAL_MIGRATION_28_SQL);
    seedRepresentativeData(dbPath, { nodeHasSourceLocator: false });

    // Open with the CURRENT application code: migration 29 must apply cleanly.
    const db = openDatabase(dbPath);
    const appliedIds = (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    expect(appliedIds).toContain(29);
    expect(Math.max(...appliedIds)).toBe(29);

    // source_locator now exists and is queryable/writable.
    const cols = (db.prepare("PRAGMA table_info(mission_requirement_nodes)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("source_locator");

    // Data survived.
    const repo = missionsRepository(db);
    const mission = repo.get("mission-1")!;
    expect(mission.objective).toBe("Historical objective");
    const node = repo.getRequirementNode("node-1")!;
    expect(node.statement).toBe("Deliver the report");
    expect(node.sourceLocator).toBeNull(); // was never set pre-migration

    // The valid active-mission pointer survived and hydrates as a real string.
    const pointer = repo.getProjectActiveMission("proj-1");
    expect(pointer?.missionId).toBe("mission-1");

    // Cross-project / nonexistent pointer writes are rejected by the rebuilt triggers.
    expect(() => db.prepare("INSERT INTO project_active_mission (project_id, mission_id, schema_version, updated_at) VALUES (?,?,1,?)").run("proj-2", "mission-1", new Date().toISOString()))
      .toThrow(/not owned by this project/);
    expect(() => db.prepare("INSERT INTO project_active_mission (project_id, mission_id, schema_version, updated_at) VALUES (?,?,1,?)").run("proj-2", "mission-does-not-exist", new Date().toISOString()))
      .toThrow();

    // Mission creation succeeds afterward on the upgraded database.
    const projects = projectRepository(db);
    expect(projects.getProjectById("proj-2")).toBeDefined();
    const created = repo.create({ id: "mission-2", projectId: "proj-2", objective: "New mission after upgrade", budget: { maxUsd: null, maxAttempts: null, maxReviewCycles: 2, spentUsd: 0, attemptsUsed: 0, reviewCyclesUsed: 0 } });
    expect(created.id).toBe("mission-2");

    // Deleting the active mission removes its pointer row entirely — never a
    // row that hydrates as `{ missionId: null }`.
    db.prepare("DELETE FROM missions WHERE id = ?").run("mission-1");
    expect(repo.getProjectActiveMission("proj-1")).toBeUndefined();
  });
});

describe("BLOCKER 3 — migration 29 upgrades an edited-f812872 database", () => {
  it("migration 29 still succeeds when source_locator already exists, and data is preserved", () => {
    const dbPath = join(tmp("ek-mig-b-"), "m.db");
    buildHistoricalDb(dbPath, EDITED_F812872_MIGRATION_28_SQL);
    seedRepresentativeData(dbPath, { nodeHasSourceLocator: true });

    const db = openDatabase(dbPath);
    const appliedIds = (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    expect(appliedIds).toContain(29);
    expect(Math.max(...appliedIds)).toBe(29);

    const cols = (db.prepare("PRAGMA table_info(mission_requirement_nodes)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("source_locator");
    // No duplicate column, no error — ALTER TABLE ADD COLUMN was correctly skipped.
    expect(cols.filter((c) => c === "source_locator")).toHaveLength(1);

    const repo = missionsRepository(db);
    const mission = repo.get("mission-1")!;
    expect(mission.objective).toBe("Historical objective");
    const node = repo.getRequirementNode("node-1")!;
    expect(node.sourceLocator).toBe("contract.objective");

    const pointer = repo.getProjectActiveMission("proj-1");
    expect(pointer?.missionId).toBe("mission-1");

    // Final schema matches: mission_id is NOT NULL in the rebuilt table.
    const pamCols = (db.prepare("PRAGMA table_info(project_active_mission)").all() as { name: string; notnull: number }[]);
    const missionIdCol = pamCols.find((c) => c.name === "mission_id")!;
    expect(missionIdCol.notnull).toBe(1);
  });
});

describe("BLOCKER 3 — fresh database (migrations 1..29 in order)", () => {
  it("applies all migrations and produces the correct final schema and triggers", () => {
    const dbPath = join(tmp("ek-mig-c-"), "m.db");
    const db = openDatabase(dbPath);
    const appliedIds = (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    expect(appliedIds).toEqual(Array.from({ length: 29 }, (_, i) => i + 1));
    // No migration 30 exists.
    expect(migrations.at(-1)!.id).toBe(29);

    const cols = (db.prepare("PRAGMA table_info(mission_requirement_nodes)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("source_locator");

    const pamCols = (db.prepare("PRAGMA table_info(project_active_mission)").all() as { name: string; notnull: number }[]);
    const missionIdCol = pamCols.find((c) => c.name === "mission_id")!;
    expect(missionIdCol.notnull).toBe(1);

    const projects = projectRepository(db);
    const repo = missionsRepository(db);
    const now = new Date().toISOString();
    projects.createProject({ id: "p1", name: "p1", workspacePath: "/tmp/p1", createdAt: now });
    projects.createProject({ id: "p2", name: "p2", workspacePath: "/tmp/p2", createdAt: now });
    const m = repo.create({ id: "m1", projectId: "p1", objective: "Fresh objective", budget: { maxUsd: null, maxAttempts: null, maxReviewCycles: 2, spentUsd: 0, attemptsUsed: 0, reviewCyclesUsed: 0 } });
    repo.setProjectActiveMission("p1", m.id, now);
    expect(repo.getProjectActiveMission("p1")?.missionId).toBe(m.id);

    // Cross-project trigger rejects.
    expect(() => db.prepare("INSERT INTO project_active_mission (project_id, mission_id, schema_version, updated_at) VALUES (?,?,1,?) ON CONFLICT(project_id) DO UPDATE SET mission_id=excluded.mission_id").run("p2", m.id, now))
      .toThrow(/not owned by this project/);

    // Deleting the mission removes the pointer row (ON DELETE CASCADE), never
    // leaving a `{ missionId: null }` row.
    db.prepare("DELETE FROM missions WHERE id = ?").run(m.id);
    expect(repo.getProjectActiveMission("p1")).toBeUndefined();
  });
});
