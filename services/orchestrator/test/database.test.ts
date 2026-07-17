import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations, openDatabase } from "../src/database.js";

describe("database", () => {
  it("migrates in-memory database idempotently", () => {
    const db = openDatabase(":memory:");
    expect(db.prepare("SELECT count(*) n FROM schema_migrations").get()).toEqual({ n: migrations.length });
    db.close();
  });

  it("installs the durable mission runtime ledger and provider discovery schema", () => {
    const db = openDatabase(":memory:");
    expect(migrations.at(-1)?.id).toBe(35);
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
    db.close();
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
