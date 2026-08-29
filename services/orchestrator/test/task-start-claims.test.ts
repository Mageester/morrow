import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrations, openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskStartClaimsRepository } from "../src/repositories/task-start-claims.js";

const NOW = "2026-08-27T12:00:00.000Z";

function seed(db: Database.Database): void {
  projectRepository(db).createProject({ id: "project", name: "Project", workspacePath: "/tmp/project", createdAt: NOW });
  taskRepository(db).createTask({ id: "child", projectId: "project", kind: "agent_chat", status: "queued", createdAt: NOW });
}

describe("task start claims", () => {
  let db: Database.Database | undefined;

  afterEach(() => db?.close());

  it("migrates a task-keyed lease table with the expected durable columns", () => {
    db = openDatabase(":memory:");
    const columns = (db.prepare("PRAGMA table_info(task_start_claims)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(migrations.at(-1)?.id).toBe(73);
    expect(columns).toEqual(["task_id", "claim_id", "owner_id", "claimed_at", "lease_expires_at", "updated_at"]);
  });

  it("atomically grants one owner and holds it for another live owner", () => {
    db = openDatabase(":memory:");
    seed(db);
    let sequence = 0;
    const claims = taskStartClaimsRepository(db, { createId: () => `claim-${++sequence}`, ownerStatus: () => "alive" });

    const first = claims.claim({ taskId: "child", ownerId: "owner-a", now: NOW, leaseMs: 60_000 });
    const second = claims.claim({ taskId: "child", ownerId: "owner-b", now: NOW, leaseMs: 60_000 });

    expect(first).toMatchObject({ acquired: true, reason: "new", claim: { ownerId: "owner-a", claimId: "claim-1" } });
    expect(second).toMatchObject({ acquired: false, reason: "held", claim: { ownerId: "owner-a" } });
  });

  it("allows takeover after lease expiry", () => {
    db = openDatabase(":memory:");
    seed(db);
    let sequence = 0;
    const claims = taskStartClaimsRepository(db, { createId: () => `claim-${++sequence}`, ownerStatus: () => "alive" });
    claims.claim({ taskId: "child", ownerId: "owner-a", now: NOW, leaseMs: 1_000 });

    const takeover = claims.claim({ taskId: "child", ownerId: "owner-b", now: "2026-08-27T12:00:01.000Z", leaseMs: 60_000 });

    expect(takeover).toMatchObject({ acquired: true, reason: "expired", claim: { ownerId: "owner-b", claimId: "claim-2" } });
  });

  it("allows takeover from a provably dead owner before lease expiry", () => {
    db = openDatabase(":memory:");
    seed(db);
    let sequence = 0;
    const claims = taskStartClaimsRepository(db, {
      createId: () => `claim-${++sequence}`,
      ownerStatus: (ownerId) => ownerId === "owner-dead" ? "dead" : "alive",
    });
    claims.claim({ taskId: "child", ownerId: "owner-dead", now: NOW, leaseMs: 60_000 });

    const takeover = claims.claim({ taskId: "child", ownerId: "owner-b", now: NOW, leaseMs: 60_000 });

    expect(takeover).toMatchObject({ acquired: true, reason: "owner_dead", claim: { ownerId: "owner-b" } });
  });

  it("refuses a start once the task has left a startable status", () => {
    db = openDatabase(":memory:");
    seed(db);
    const claims = taskStartClaimsRepository(db, { createId: () => "claim-1", ownerStatus: () => "alive" });
    claims.claim({ taskId: "child", ownerId: "owner-a", now: NOW, leaseMs: 1_000 });
    db.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=?").run(NOW, "child");

    // The lease has expired, so only the authoritative task status can stop a
    // second process from starting an already-running child.
    const takeover = claims.claim({ taskId: "child", ownerId: "owner-b", now: "2026-08-27T12:00:05.000Z", leaseMs: 60_000 });

    expect(takeover).toMatchObject({ acquired: false, reason: "not_startable" });
  });

  it("refuses a claim whose authoritative parent binding does not match", () => {
    db = openDatabase(":memory:");
    seed(db);
    taskRepository(db).createTask({ id: "parent", projectId: "project", kind: "agent_chat", status: "running", createdAt: NOW });
    db.prepare("UPDATE tasks SET parent_task_id=? WHERE id=?").run("parent", "child");
    const claims = taskStartClaimsRepository(db, { createId: () => "claim-1", ownerStatus: () => "alive" });

    const wrongParent = claims.claim({ taskId: "child", ownerId: "owner-a", now: NOW, leaseMs: 60_000, expectedParentTaskId: "other-parent" });
    const rightParent = claims.claim({ taskId: "child", ownerId: "owner-a", now: NOW, leaseMs: 60_000, expectedParentTaskId: "parent" });

    expect(wrongParent).toMatchObject({ acquired: false, reason: "identity_mismatch", claim: null });
    expect(rightParent).toMatchObject({ acquired: true, reason: "new" });
  });

  it("refuses a claim for a task that does not exist", () => {
    db = openDatabase(":memory:");
    seed(db);
    const claims = taskStartClaimsRepository(db, { ownerStatus: () => "alive" });

    expect(claims.claim({ taskId: "ghost", ownerId: "owner-a", now: NOW, leaseMs: 60_000 }))
      .toMatchObject({ acquired: false, reason: "task_missing", claim: null });
  });

  it("terminalizes on settlement and lets a requeued task be reclaimed", () => {
    db = openDatabase(":memory:");
    seed(db);
    let sequence = 0;
    const claims = taskStartClaimsRepository(db, { createId: () => `claim-${++sequence}`, ownerStatus: () => "alive" });
    claims.claim({ taskId: "child", ownerId: "owner-a", now: NOW, leaseMs: 60_000 });
    db.prepare("UPDATE tasks SET status='completed',updated_at=? WHERE id=?").run(NOW, "child");

    expect(claims.settle("child")).toBe(true);
    expect(claims.get("child")).toBeNull();
    // A settled but terminal task stays unstartable.
    expect(claims.claim({ taskId: "child", ownerId: "owner-b", now: NOW, leaseMs: 60_000 }))
      .toMatchObject({ acquired: false, reason: "not_startable" });

    db.prepare("UPDATE tasks SET status='interrupted',updated_at=? WHERE id=?").run(NOW, "child");
    expect(claims.claim({ taskId: "child", ownerId: "owner-b", now: NOW, leaseMs: 60_000 }))
      .toMatchObject({ acquired: true, reason: "new", claim: { ownerId: "owner-b" } });
  });

  it("keeps the start claim atomic across two database connections", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-task-start-"));
    const path = join(directory, "morrow.db");
    const firstDb = openDatabase(path);
    const secondDb = openDatabase(path);
    try {
      seed(firstDb);
      const firstClaims = taskStartClaimsRepository(firstDb, { createId: () => "claim-a", ownerStatus: () => "alive" });
      const secondClaims = taskStartClaimsRepository(secondDb, { createId: () => "claim-b", ownerStatus: () => "alive" });
      const first = firstClaims.claim({ taskId: "child", ownerId: "owner-a", now: NOW, leaseMs: 60_000 });
      const second = secondClaims.claim({ taskId: "child", ownerId: "owner-b", now: NOW, leaseMs: 60_000 });

      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(false);
      expect(second.claim?.ownerId).toBe("owner-a");
    } finally {
      firstDb.close();
      secondDb.close();
      rmSync(directory, { recursive: true });
    }
  });
});
