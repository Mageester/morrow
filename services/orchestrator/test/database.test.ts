import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrations, openDatabase } from "../src/database.js";
import { redactSecrets } from "../src/provider/credentials.js";

describe("database", () => {
  it("migrates in-memory database idempotently", () => {
    const db = openDatabase(":memory:");
    expect(db.prepare("SELECT count(*) n FROM schema_migrations").get()).toEqual({ n: migrations.length });
    db.close();
  });

  it("installs the durable mission runtime ledger and provider discovery schema", () => {
    const db = openDatabase(":memory:");
    expect(migrations.at(-1)!.id).toBeGreaterThanOrEqual(39);
    expect(db.prepare("PRAGMA table_info(tasks)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "idempotency_fingerprint" })]),
    );
    const missionColumns = (db.prepare("PRAGMA table_info(missions)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(missionColumns).toContain("execution_json");
    expect(missionColumns).toContain("idempotency_key");
    const tables = (db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name LIKE 'mission_runtime%' OR name IN ('mission_operations','mission_progress','mission_recovery_decisions')
      ORDER BY name`).all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual([
      "mission_operations",
      "mission_progress",
      "mission_recovery_decisions",
      "mission_runtime",
      "mission_runtime_transitions",
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learned_skills'").get()).toEqual({ name: "learned_skills" });
    const memoryColumns = (db.prepare("PRAGMA table_info(memory_entries)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(memoryColumns).toEqual(expect.arrayContaining(["normalized_content", "type", "lifecycle", "evidence_references_json", "sensitivity", "expires_at"]));
    const providerDiscoveryColumns = (db.prepare("PRAGMA table_info(provider_model_discovery)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(providerDiscoveryColumns).toEqual(expect.arrayContaining(["expires_at", "last_success_at", "credential_identity"]));
    const actionAttemptColumns = (db.prepare("PRAGMA table_info(action_attempts)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(actionAttemptColumns).toEqual(expect.arrayContaining([
      "task_id",
      "mission_id",
      "tool_call_id",
      "normalized_signature",
      "environment_fingerprint",
      "attempt_number",
      "strategy",
      "status",
      "exit_status",
      "termination_reason",
      "failure_category",
      "failure_fingerprint",
      "progress_fingerprint",
      "completed_at",
    ]));
    db.close();
  });

  it("installs migration 73 with source-qualified skill activation constraints", () => {
    const db = openDatabase(":memory:");
    expect(migrations.at(-1)).toMatchObject({ id: 73, name: "skill_activations" });
    expect(db.prepare("PRAGMA table_info(skill_activations)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "skill_key", type: "TEXT", pk: 1 }),
      expect.objectContaining({ name: "skill_id", type: "TEXT" }),
      expect.objectContaining({ name: "source", type: "TEXT" }),
      expect.objectContaining({ name: "project_id", type: "TEXT" }),
      expect.objectContaining({ name: "enabled", type: "INTEGER" }),
      expect.objectContaining({ name: "updated_at", type: "TEXT" }),
    ]));

    const insert = db.prepare("INSERT INTO skill_activations(skill_key,skill_id,source,project_id,enabled,updated_at) VALUES(?,?,?,?,?,?)");
    insert.run("workspace:p1:lint", "lint", "workspace", "p1", 1, "2026-08-28T00:00:00.000Z");
    expect(() => insert.run("workspace:p1:bad", "bad", "workspace", null, 1, "2026-08-28T00:00:00.000Z")).toThrow();
    expect(() => insert.run("user:bad", "bad", "user", "p1", 1, "2026-08-28T00:00:00.000Z")).toThrow();
    expect(() => insert.run("user:bad-enabled", "bad-enabled", "user", null, 2, "2026-08-28T00:00:00.000Z")).toThrow();
    expect(() => insert.run("unknown:bad", "bad", "unknown", null, 0, "2026-08-28T00:00:00.000Z")).toThrow();
    db.close();
  });

  it("upgrades a database at migration 72 with the skill activation table", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-skill-activation-upgrade-"));
    const file = join(directory, "morrow.db");
    const legacy = new Database(file);
    legacy.pragma("foreign_keys = ON");
    legacy.function("morrow_redact", { deterministic: true }, (value: unknown) => typeof value === "string" ? redactSecrets(value) : "");
    legacy.exec("CREATE TABLE schema_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
    const record = legacy.prepare("INSERT INTO schema_migrations VALUES(?,?,?)");
    for (const migration of migrations.filter(({ id }) => id <= 72)) {
      legacy.transaction(() => {
        if (migration.sql) legacy.exec(migration.sql);
        if (migration.up) migration.up(legacy);
        record.run(migration.id, migration.name, "2026-08-28T00:00:00.000Z");
      })();
    }
    legacy.close();

    const upgraded = openDatabase(file);
    expect(upgraded.prepare("SELECT MAX(id) id FROM schema_migrations").get()).toEqual({ id: 73 });
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_activations'").get()).toEqual({ name: "skill_activations" });
    upgraded.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates the durable recovery lease columns on a fresh database", () => {
    const db = openDatabase(":memory:");
    const columns = (db.prepare("PRAGMA table_info(schedule_runs)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["recovery_owner", "recovery_lease_expires_at", "recovery_attempts", "notification_observed_event"]));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schedule_notification_outbox'").get()).toEqual({ name: "schedule_notification_outbox" });
    db.close();
  });

  it("serves ordered conversation and tool-call projections without temporary sorts", () => {
    const db = openDatabase(":memory:");
    for (const [sql, parameter] of [
      ["SELECT * FROM conversation_messages WHERE conversation_id=? ORDER BY created_at,rowid", "c"],
      ["SELECT * FROM message_tool_calls WHERE message_id=? ORDER BY created_at,rowid", "m"],
      ["SELECT * FROM message_tool_calls WHERE task_id=? ORDER BY created_at,rowid", "t"],
    ] as const) {
      const detail = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(parameter) as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join(" | ");
      expect(detail).toMatch(/USING INDEX/);
      expect(detail).not.toMatch(/USE TEMP B-TREE/);
    }
    db.close();
  });

  it("adds recovery lease columns when upgrading a database already at migrations 54 and 55", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-schedule-recovery-"));
    const file = join(directory, "morrow.db");
    const legacy = new Database(file);
    legacy.pragma("foreign_keys = ON");
    legacy.function("morrow_redact", { deterministic: true }, (value: unknown) => typeof value === "string" ? redactSecrets(value) : "");
    legacy.exec("CREATE TABLE schema_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
    const record = legacy.prepare("INSERT INTO schema_migrations VALUES(?,?,?)");
    for (const migration of migrations.filter(({ id }) => id <= 55)) {
      legacy.transaction(() => {
        if (migration.sql) legacy.exec(migration.sql);
        if (migration.up) migration.up(legacy);
        record.run(migration.id, migration.name, new Date().toISOString());
      })();
    }
    legacy.close();

    const upgraded = openDatabase(file);
    const columns = (upgraded.prepare("PRAGMA table_info(schedule_runs)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["recovery_owner", "recovery_lease_expires_at", "recovery_attempts"]));
    expect(upgraded.prepare("SELECT MAX(id) id FROM schema_migrations").get()).toEqual({ id: migrations.at(-1)!.id });
    upgraded.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("enforces event sequence", () => {
    const db = openDatabase(":memory:");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run("p", 1, "p", "w", now, now);
    db.prepare("INSERT INTO tasks(id,schema_version,project_id,type,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run("t", 1, "p", "inspect_workspace", "queued", now, now);
    db.prepare("INSERT INTO task_events VALUES(?,?,?,?,?,?,?)").run("e", 1, "t", 1, "task.created", "{}", now);
    expect(() => db.prepare("INSERT INTO task_events VALUES(?,?,?,?,?,?,?)")
      .run("e2", 1, "t", 1, "task.created", "{}", now)).toThrow();
    db.close();
  });

  /**
   * `prepare` is memoized per connection because compiling SQL costs several
   * times more than running the compiled statement, and this codebase issues
   * the same few hundred statements over and over.
   *
   * Both properties below are load-bearing together. The bound has to clear the
   * static statement population (`src` holds close to 600 distinct literals),
   * or the cache evicts while merely walking the normal API surface; and once
   * anything does evict, insertion-order eviction would discard the statements
   * compiled earliest — the startup and per-request ones the process leans on
   * hardest — while keeping whichever interpolated one-off arrived last.
   */
  it("keeps a hot statement resident under eviction pressure, and reuses compiled statements", () => {
    const db = openDatabase(":memory:");
    const HOT = "SELECT count(*) n FROM schema_migrations";
    const COLD = "SELECT 0 AS n FROM schema_migrations";

    // The same SQL compiles once and is handed back thereafter.
    const hotBefore = db.prepare(HOT);
    expect(db.prepare(HOT)).toBe(hotBefore);
    const coldBefore = db.prepare(COLD);

    // Force eviction with distinct statements, touching the hot one throughout
    // — exactly the shape of an interpolated call site running alongside the
    // steady surface. COLD is never touched again.
    for (let i = 1; i <= 2_600; i++) {
      db.prepare(`SELECT ${i} AS n FROM schema_migrations`);
      db.prepare(HOT);
    }

    // Used on every iteration, so it is still the statement compiled at the top.
    expect(db.prepare(HOT)).toBe(hotBefore);
    // Never used again, so it was the one evicted and has to recompile.
    expect(db.prepare(COLD)).not.toBe(coldBefore);
    db.close();
  });

  it("never caches a PRAGMA, which callers reconfigure per use", () => {
    const db = openDatabase(":memory:");
    expect(db.prepare("PRAGMA integrity_check")).not.toBe(db.prepare("PRAGMA integrity_check"));
    expect(db.prepare("PRAGMA integrity_check").pluck().get()).toBe("ok");
    db.close();
  });

  it("creates parent directories and persists", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-"));
    const file = join(directory, ".morrow", "m.db");
    openDatabase(file).close();
    const db = openDatabase(file);
    expect(db.prepare("SELECT count(*) n FROM schema_migrations").get()).toEqual({ n: migrations.length });
    db.close();
    rmSync(directory, { recursive: true });
  });
});
