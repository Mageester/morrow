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
const openDatabases: Database.Database[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
function openTestDatabase(path: string): Database.Database {
  const db = openDatabase(path);
  openDatabases.push(db);
  return db;
}
afterEach(() => {
  openDatabases.splice(0).forEach((db) => {
    if (db.open) db.close();
  });
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

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

/** Build a database with migrations 1..30 applied but migration 31 absent, so
 * migration-31 review hydration can be exercised against real migration-30
 * schema and data. */
function buildMigration30Db(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE schema_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
  const insertMigrationRow = db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)");
  for (const m of migrations) {
    if (m.id > 30) continue;
    db.transaction(() => {
      if (m.sql) db.exec(m.sql);
      if (m.up) m.up(db);
      insertMigrationRow.run(m.id, m.name, "2026-01-01T00:00:00.000Z");
    })();
  }
  return db;
}

function seedMigration30Mission(db: Database.Database, input: {
  id: string;
  status?: string;
  reviews?: Array<{ id: string; verdict: string; createdAt: string }>;
  resultReviewVerdict?: string | null;
  reviewCyclesUsed?: number;
}): void {
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare("INSERT OR IGNORE INTO projects (id, schema_version, name, workspace_path, created_at, updated_at) VALUES ('legacy-project',1,'Legacy','/tmp/legacy',?,?)").run(now, now);
  const result = input.resultReviewVerdict === undefined ? null : JSON.stringify({
    status: input.status ?? "completed",
    reviewVerdict: input.resultReviewVerdict,
    summary: "legacy result",
    changedFiles: [], humanInterventions: 0, tasksCompleted: 0,
    elapsedMs: null, spentUsd: null,
  });
  db.prepare(
    `INSERT INTO missions (id, schema_version, project_id, objective, status, auto_approve, task_tree_root_id, budget_json, result_json, created_at, updated_at, started_at, completed_at, current_review_cycle_id)
     VALUES (?,1,'legacy-project','Legacy mission',?,0,NULL,?,?,?, ?, ?, ?, NULL)`,
  ).run(
    input.id,
    input.status ?? "running",
    JSON.stringify({ maxUsd: null, maxAttempts: null, maxReviewCycles: 5, spentUsd: 0, attemptsUsed: 0, reviewCyclesUsed: input.reviewCyclesUsed ?? 0 }),
    result,
    now,
    now,
    now,
    (input.status ?? "running").startsWith("completed") ? now : null,
  );
  for (const review of input.reviews ?? []) {
    db.prepare(
      `INSERT INTO mission_reviews (id, mission_id, verdict, reviewer_provider, reviewer_model, payload_json, created_at, review_cycle_id)
       VALUES (?, ?, ?, 'legacy-provider', 'legacy-model', ?, ?, NULL)`,
    ).run(review.id, input.id, review.verdict, JSON.stringify({ summary: review.id, concerns: [], criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [] }), review.createdAt);
  }
}

describe("BLOCKER 3 — migration 29 upgrades a genuine 29d0364-era database", () => {
  it("migration 29 applies, preserves data, adds source_locator, and rebuilds project_active_mission", () => {
    const dbPath = join(tmp("ek-mig-a-"), "m.db");
    buildHistoricalDb(dbPath, ORIGINAL_MIGRATION_28_SQL);
    seedRepresentativeData(dbPath, { nodeHasSourceLocator: false });

    // Open with the CURRENT application code: migration 29 must apply cleanly.
    const db = openTestDatabase(dbPath);
    const appliedIds = (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    expect(appliedIds).toContain(29);
    expect(Math.max(...appliedIds)).toBe(35);

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

    const db = openTestDatabase(dbPath);
    const appliedIds = (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    expect(appliedIds).toContain(29);
    expect(Math.max(...appliedIds)).toBe(35);

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

describe("BLOCKER 3 — fresh database migrations in order", () => {
  it("applies all migrations and produces the correct final schema and triggers", () => {
    const dbPath = join(tmp("ek-mig-c-"), "m.db");
    const db = openTestDatabase(dbPath);
    const appliedIds = (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    expect(appliedIds).toEqual(Array.from({ length: 35 }, (_, i) => i + 1));
    expect(migrations.at(-1)!.id).toBe(35);
    const reviewCycleCols = (db.prepare("PRAGMA table_info(mission_review_cycles)").all() as { name: string }[]).map((c) => c.name);
    expect(reviewCycleCols).toEqual(expect.arrayContaining(["id", "mission_id", "sequence", "status", "reserved_at", "resolved_at", "owner_id", "lease_expires_at"]));

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

describe("MAJOR — migration 31 preserves legacy review authority", () => {
  it("hydrates one legacy review through an applied cycle without changing its payload or budget", () => {
    const dbPath = join(tmp("ek-mig31-one-"), "m.db");
    const seed = buildMigration30Db(dbPath);
    seedMigration30Mission(seed, { id: "m1", status: "reviewing", reviewCyclesUsed: 1, reviews: [
      { id: "r1", verdict: "approved", createdAt: "2026-01-02T00:00:00.000Z" },
    ] });
    seed.close();

    const db = openTestDatabase(dbPath);
    const repo = missionsRepository(db);
    expect(repo.get("m1")!.finalReview).toMatchObject({ id: "r1", verdict: "approved", summary: "r1" });
    expect(repo.get("m1")!.budget.reviewCyclesUsed).toBe(1);
    const cycle = db.prepare("SELECT * FROM mission_review_cycles WHERE mission_id = 'm1'").get() as any;
    expect(cycle).toMatchObject({ sequence: 1, status: "applied" });
    expect((db.prepare("SELECT review_cycle_id FROM mission_reviews WHERE id = 'r1'").get() as any).review_cycle_id).toBe(cycle.id);
  });

  it("assigns deterministic per-mission sequence and points at the ordered latest legacy review", () => {
    const dbPath = join(tmp("ek-mig31-many-"), "m.db");
    const seed = buildMigration30Db(dbPath);
    seedMigration30Mission(seed, { id: "m1", status: "reviewing", reviewCyclesUsed: 2, reviews: [
      { id: "later", verdict: "revisions_required", createdAt: "2026-01-03T00:00:00.000Z" },
      { id: "earlier", verdict: "approved", createdAt: "2026-01-02T00:00:00.000Z" },
    ] });
    seed.close();

    const db = openTestDatabase(dbPath);
    const rows = db.prepare(`SELECT r.id, c.sequence FROM mission_reviews r JOIN mission_review_cycles c ON c.id = r.review_cycle_id WHERE r.mission_id = 'm1' ORDER BY c.sequence`).all() as any[];
    expect(rows).toEqual([{ id: "earlier", sequence: 1 }, { id: "later", sequence: 2 }]);
    expect(missionsRepository(db).get("m1")!.finalReview?.id).toBe("later");
    expect(missionsRepository(db).get("m1")!.budget.reviewCyclesUsed).toBe(2);
  });

  it("preserves completed mission result/review agreement", () => {
    const dbPath = join(tmp("ek-mig31-complete-"), "m.db");
    const seed = buildMigration30Db(dbPath);
    seedMigration30Mission(seed, { id: "m1", status: "completed", resultReviewVerdict: "approved", reviews: [
      { id: "r1", verdict: "approved", createdAt: "2026-01-02T00:00:00.000Z" },
    ] });
    seed.close();
    const db = openTestDatabase(dbPath);
    const mission = missionsRepository(db).get("m1")!;
    expect(mission.status).toBe("completed");
    expect(mission.finalReview?.verdict).toBe("approved");
    expect(mission.result?.reviewVerdict).toBe("approved");
  });

  it("aborts and rolls back on tied latest legacy timestamps", () => {
    const dbPath = join(tmp("ek-mig31-tie-"), "m.db");
    const seed = buildMigration30Db(dbPath);
    seedMigration30Mission(seed, { id: "m1", reviews: [
      { id: "r1", verdict: "approved", createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "r2", verdict: "approved_with_risks", createdAt: "2026-01-02T00:00:00.000Z" },
    ] });
    seed.close();
    expect(() => openTestDatabase(dbPath)).toThrow(/tied latest.*m1/i);
    const raw = new Database(dbPath);
    expect((raw.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE id = 31").get() as any).n).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) n FROM mission_review_cycles").get() as any).n).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) n FROM mission_reviews WHERE review_cycle_id IS NOT NULL").get() as any).n).toBe(0);
    expect((raw.prepare("PRAGMA table_info(mission_review_cycles)").all() as any[]).map((c) => c.name)).not.toContain("owner_id");
    raw.close();
  });

  it("aborts and rolls back when a completed result contradicts the latest legacy review", () => {
    const dbPath = join(tmp("ek-mig31-conflict-"), "m.db");
    const seed = buildMigration30Db(dbPath);
    seedMigration30Mission(seed, { id: "m1", status: "completed", resultReviewVerdict: "approved", reviews: [
      { id: "r1", verdict: "revisions_required", createdAt: "2026-01-02T00:00:00.000Z" },
    ] });
    seed.close();
    expect(() => openTestDatabase(dbPath)).toThrow(/result.*contradict.*review/i);
    const raw = new Database(dbPath);
    expect((raw.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE id = 31").get() as any).n).toBe(0);
    expect((raw.prepare("SELECT review_cycle_id FROM mission_reviews WHERE id = 'r1'").get() as any).review_cycle_id).toBeNull();
    raw.close();
  });

  it("leaves already-valid migration-30 review-cycle data unchanged", () => {
    const dbPath = join(tmp("ek-mig31-valid-"), "m.db");
    const seed = buildMigration30Db(dbPath);
    seedMigration30Mission(seed, { id: "m1" });
    seed.prepare("INSERT INTO mission_review_cycles (id, mission_id, sequence, status, reserved_at, resolved_at) VALUES ('cycle-1','m1',7,'applied','2026-01-02','2026-01-03')").run();
    seed.prepare("INSERT INTO mission_reviews (id, mission_id, verdict, payload_json, created_at, review_cycle_id) VALUES ('r1','m1','approved','{}','2026-01-02','cycle-1')").run();
    seed.prepare("UPDATE missions SET current_review_cycle_id = 'cycle-1' WHERE id = 'm1'").run();
    seed.close();
    const db = openTestDatabase(dbPath);
    expect(db.prepare("SELECT id, mission_id, sequence, status, reserved_at, resolved_at FROM mission_review_cycles").all()).toEqual([
      { id: "cycle-1", mission_id: "m1", sequence: 7, status: "applied", reserved_at: "2026-01-02", resolved_at: "2026-01-03" },
    ]);
    expect((db.prepare("SELECT current_review_cycle_id FROM missions WHERE id = 'm1'").get() as any).current_review_cycle_id).toBe("cycle-1");
  });

  it("rolls back schema, pointers, cycle inserts, and migration row when a late backfill write fails", () => {
    const dbPath = join(tmp("ek-mig31-rollback-"), "m.db");
    const seed = buildMigration30Db(dbPath);
    seedMigration30Mission(seed, { id: "existing" });
    seedMigration30Mission(seed, { id: "legacy", reviews: [
      { id: "r1", verdict: "approved", createdAt: "2026-01-02T00:00:00.000Z" },
    ] });
    seed.prepare("INSERT INTO mission_review_cycles (id, mission_id, sequence, status, reserved_at, resolved_at) VALUES ('legacy-review-cycle-r1','existing',1,'applied','2026-01-01','2026-01-01')").run();
    seed.close();

    expect(() => openTestDatabase(dbPath)).toThrow(/unique|constraint/i);
    const raw = new Database(dbPath);
    expect((raw.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE id = 31").get() as any).n).toBe(0);
    expect((raw.prepare("PRAGMA table_info(mission_review_cycles)").all() as any[]).map((c) => c.name)).not.toContain("owner_id");
    expect(raw.prepare("SELECT id, mission_id, sequence, status FROM mission_review_cycles").all()).toEqual([
      { id: "legacy-review-cycle-r1", mission_id: "existing", sequence: 1, status: "applied" },
    ]);
    expect((raw.prepare("SELECT review_cycle_id FROM mission_reviews WHERE id = 'r1'").get() as any).review_cycle_id).toBeNull();
    expect((raw.prepare("SELECT current_review_cycle_id FROM missions WHERE id = 'legacy'").get() as any).current_review_cycle_id).toBeNull();
    raw.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MAJOR 3 — migration 29 must refuse to upgrade a database whose EXISTING
// project_active_mission pointer is ownership-corrupt (points at a mission
// owned by a different project, or at no mission at all), rather than
// silently carrying the corrupt pointer forward (the previous behavior) or
// silently dropping/rewriting it.
// ════════════════════════════════════════════════════════════════════════════
describe("MAJOR 3 — migration 29 refuses ownership-corrupt existing pointers", () => {
  it("a cross-project pointer aborts the upgrade: openDatabase throws, migration 29 is not recorded, source_locator is not added, original data is unchanged, and a corrected retry succeeds", () => {
    const dbPath = join(tmp("ek-mig-corrupt-"), "m.db");
    buildHistoricalDb(dbPath, ORIGINAL_MIGRATION_28_SQL);

    // Seed a genuine cross-project ownership-corrupt pointer directly at the
    // raw (pre-migration-29) schema, exactly as a real historical database
    // could contain — no ownership trigger exists at this schema stage.
    const seed = new Database(dbPath);
    const now = new Date().toISOString();
    seed.prepare("INSERT INTO projects (id, schema_version, name, workspace_path, created_at, updated_at) VALUES (?,1,?,?,?,?)")
      .run("proj-1", "Project One", "/tmp/proj-1", now, now);
    seed.prepare("INSERT INTO projects (id, schema_version, name, workspace_path, created_at, updated_at) VALUES (?,1,?,?,?,?)")
      .run("proj-2", "Project Two", "/tmp/proj-2", now, now);
    seed.prepare(
      `INSERT INTO missions (id, schema_version, project_id, objective, status, auto_approve, task_tree_root_id, budget_json, result_json, created_at, updated_at, started_at, completed_at)
       VALUES (?,1,?,?, 'running', 0, NULL, ?, NULL, ?, ?, ?, NULL)`,
    ).run("mission-1", "proj-1", "Owned by proj-1", JSON.stringify({ maxUsd: null, maxAttempts: null, maxReviewCycles: 2, spentUsd: 0, attemptsUsed: 0, reviewCyclesUsed: 0 }), now, now, now);
    // proj-2's active-mission pointer names a mission actually owned by proj-1.
    seed.prepare(
      `INSERT INTO project_active_mission (project_id, mission_id, schema_version, updated_at) VALUES (?,?,1,?)`,
    ).run("proj-2", "mission-1", now);
    seed.close();

    expect(() => openTestDatabase(dbPath)).toThrow(/ownership-corrupt/i);

    // Inspect the ON-DISK state directly (not via openDatabase, which would
    // attempt to re-run migrations) to prove nothing partially applied.
    const raw = new Database(dbPath);
    try {
      const appliedIds = (raw.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map((r) => r.id);
      expect(appliedIds).toEqual(Array.from({ length: 28 }, (_, i) => i + 1)); // migration 29 (and 30) never recorded
      expect(Math.max(...appliedIds)).toBe(28);

      const cols = (raw.prepare("PRAGMA table_info(mission_requirement_nodes)").all() as { name: string }[]).map((c) => c.name);
      expect(cols).not.toContain("source_locator"); // not partially added

      // Original table/data remains unchanged: still the old nullable-mission_id
      // shape, still holding the (uncorrected, still corrupt) pointer row.
      const pamCols = (raw.prepare("PRAGMA table_info(project_active_mission)").all() as { name: string }[]).map((c) => c.name);
      expect(pamCols).toEqual(["project_id", "mission_id", "schema_version", "updated_at"]);
      const pointer = raw.prepare("SELECT * FROM project_active_mission WHERE project_id = ?").get("proj-2") as any;
      expect(pointer.mission_id).toBe("mission-1");
    } finally {
      raw.close();
    }

    // Retry after correcting the data succeeds.
    const fix = new Database(dbPath);
    try {
      fix.prepare("UPDATE project_active_mission SET project_id = 'proj-1' WHERE mission_id = 'mission-1'").run();
    } finally {
      fix.close();
    }

    const db = openTestDatabase(dbPath);
    try {
      const appliedAfterFix = (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map((r) => r.id);
      expect(Math.max(...appliedAfterFix)).toBe(35);
      const repo = missionsRepository(db);
      expect(repo.getProjectActiveMission("proj-1")?.missionId).toBe("mission-1");
      expect(repo.getProjectActiveMission("proj-2")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("a pointer referencing a nonexistent mission is also refused", () => {
    const dbPath = join(tmp("ek-mig-corrupt-missing-"), "m.db");
    buildHistoricalDb(dbPath, ORIGINAL_MIGRATION_28_SQL);

    // A dangling pointer with no corresponding mission row at all — e.g. from
    // a hard delete performed while foreign key enforcement was off, which
    // this seed connection deliberately leaves off to allow the insert.
    const seed = new Database(dbPath);
    seed.pragma("foreign_keys = OFF");
    const now = new Date().toISOString();
    seed.prepare("INSERT INTO projects (id, schema_version, name, workspace_path, created_at, updated_at) VALUES (?,1,?,?,?,?)")
      .run("proj-1", "Project One", "/tmp/proj-1", now, now);
    seed.prepare(
      `INSERT INTO project_active_mission (project_id, mission_id, schema_version, updated_at) VALUES (?,?,1,?)`,
    ).run("proj-1", "mission-ghost", now);
    seed.close();

    expect(() => openTestDatabase(dbPath)).toThrow(/ownership-corrupt/i);
    const raw = new Database(dbPath);
    try {
      const appliedIds = (raw.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map((r) => r.id);
      expect(Math.max(...appliedIds)).toBe(28);
    } finally {
      raw.close();
    }
  });
});
