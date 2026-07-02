import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { checkpointsRepository } from "../src/repositories/checkpoints.js";
import { snapshotFiles, restoreSnapshot, isValidCheckpointName } from "../src/workspace/checkpoints.js";

const roots: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("checkpoint name validation", () => {
  it("accepts human-friendly names and rejects hostile ones", () => {
    expect(isValidCheckpointName("before-refactor")).toBe(true);
    expect(isValidCheckpointName("v1.2/stable_3")).toBe(true);
    expect(isValidCheckpointName("auto/pre-restore-x-2026")).toBe(true);
    expect(isValidCheckpointName("")).toBe(false);
    expect(isValidCheckpointName("../escape")).toBe(false);
    expect(isValidCheckpointName("-leading-dash")).toBe(false);
    expect(isValidCheckpointName("a".repeat(101))).toBe(false);
    expect(isValidCheckpointName("has space")).toBe(false);
  });
});

describe("snapshotFiles / restoreSnapshot", () => {
  it("captures content, records absent files, and restores both directions", () => {
    const ws = tmp("cp-ws-");
    const backups = tmp("cp-bk-");
    writeFileSync(join(ws, "a.txt"), "original A", "utf8");

    // b.txt does not exist at snapshot time.
    const snap = snapshotFiles(ws, backups, ["a.txt", "b.txt"]);
    expect(snap.skipped).toEqual([]);
    expect(snap.files["a.txt"]).toMatch(/^[0-9a-f]{16,}$/);
    expect(snap.files["b.txt"]).toBe("");

    // Mutate the workspace: change a, create b.
    writeFileSync(join(ws, "a.txt"), "mutated A", "utf8");
    writeFileSync(join(ws, "b.txt"), "new B", "utf8");

    const restored = restoreSnapshot(ws, backups, snap.files);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("original A");
    expect(existsSync(join(ws, "b.txt"))).toBe(false);
    expect(restored.restoredFiles).toEqual(["a.txt"]);
    expect(restored.deletedFiles).toEqual(["b.txt"]);
  });

  it("is a no-op for files already at snapshot state", () => {
    const ws = tmp("cp-ws-");
    const backups = tmp("cp-bk-");
    writeFileSync(join(ws, "same.txt"), "unchanged", "utf8");
    const snap = snapshotFiles(ws, backups, ["same.txt"]);
    const restored = restoreSnapshot(ws, backups, snap.files);
    expect(restored.restoredFiles).toEqual([]);
    expect(restored.deletedFiles).toEqual([]);
  });

  it("rejects containment escapes", () => {
    const ws = tmp("cp-ws-");
    const backups = tmp("cp-bk-");
    expect(() => snapshotFiles(ws, backups, ["../outside.txt"])).toThrow(/traversal|Absolute/i);
    expect(() => restoreSnapshot(ws, backups, { "../outside.txt": "" })).toThrow(/traversal|Absolute/i);
  });

  it("fails restore up front when a backup blob is missing (no partial writes)", () => {
    const ws = tmp("cp-ws-");
    const backups = tmp("cp-bk-");
    writeFileSync(join(ws, "x.txt"), "current", "utf8");
    expect(() => restoreSnapshot(ws, backups, { "x.txt": "deadbeef" })).toThrow(/missing from backup store/);
    expect(readFileSync(join(ws, "x.txt"), "utf8")).toBe("current");
  });
});

describe("checkpoints repository", () => {
  it("enforces per-project name uniqueness and lists newest first", () => {
    const db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: new Date().toISOString() });
    projectRepository(db).createProject({ id: "p2", name: "P2", workspacePath: process.cwd(), createdAt: new Date().toISOString() });
    const repo = checkpointsRepository(db);
    repo.create({ id: "c1", projectId: "p1", name: "alpha", files: { "a.txt": "h1" } }, "2026-01-01T00:00:00.000Z");
    repo.create({ id: "c2", projectId: "p1", name: "beta", files: {} }, "2026-01-02T00:00:00.000Z");
    // Same name in a different project is fine.
    repo.create({ id: "c3", projectId: "p2", name: "alpha", files: {} });
    expect(() => repo.create({ id: "c4", projectId: "p1", name: "alpha", files: {} })).toThrow();
    expect(repo.listByProject("p1").map((c) => c.name)).toEqual(["beta", "alpha"]);
    expect(repo.getByName("p1", "alpha")?.files).toEqual({ "a.txt": "h1" });
    expect(repo.remove("p1", "alpha")).toBe(true);
    expect(repo.remove("p1", "alpha")).toBe(false);
    db.close();
  });
});

describe("checkpoint API", () => {
  let db: any;
  let app: any;
  let ws: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    ws = tmp("cp-api-ws-");
    const home = tmp("cp-api-home-");
    priorHome = process.env.MORROW_HOME;
    process.env.MORROW_HOME = home;
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: ws, createdAt: new Date().toISOString() });
  });
  afterEach(() => {
    if (priorHome === undefined) delete process.env.MORROW_HOME;
    else process.env.MORROW_HOME = priorHome;
    app.close();
    db.close();
  });

  it("creates, lists, restores (with safety checkpoint), and deletes", async () => {
    writeFileSync(join(ws, "main.ts"), "v1", "utf8");

    const create = await app.inject({
      method: "POST",
      url: "/api/projects/p1/checkpoints",
      payload: { name: "before-change", files: ["main.ts"] },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({ name: "before-change", fileCount: 1, files: ["main.ts"], skipped: [] });

    writeFileSync(join(ws, "main.ts"), "v2-broken", "utf8");

    const restore = await app.inject({ method: "POST", url: "/api/projects/p1/checkpoints/before-change/restore" });
    expect(restore.statusCode).toBe(200);
    const body = restore.json();
    expect(body.restoredFiles).toEqual(["main.ts"]);
    expect(body.safetyCheckpoint).toMatch(/^auto\/pre-restore-before-change-/);
    expect(readFileSync(join(ws, "main.ts"), "utf8")).toBe("v1");

    // The safety checkpoint can undo the restore itself.
    const undoRestore = await app.inject({
      method: "POST",
      url: `/api/projects/p1/checkpoints/${encodeURIComponent(body.safetyCheckpoint)}/restore`,
    });
    expect(undoRestore.statusCode).toBe(200);
    expect(readFileSync(join(ws, "main.ts"), "utf8")).toBe("v2-broken");

    const list = await app.inject({ method: "GET", url: "/api/projects/p1/checkpoints" });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((c: any) => c.name)).toContain("before-change");

    const del = await app.inject({ method: "DELETE", url: "/api/projects/p1/checkpoints/before-change" });
    expect(del.statusCode).toBe(200);
    const missing = await app.inject({ method: "POST", url: "/api/projects/p1/checkpoints/before-change/restore" });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects duplicates, invalid names, hostile paths, and empty defaults", async () => {
    writeFileSync(join(ws, "f.txt"), "x", "utf8");
    const first = await app.inject({ method: "POST", url: "/api/projects/p1/checkpoints", payload: { name: "dup", files: ["f.txt"] } });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({ method: "POST", url: "/api/projects/p1/checkpoints", payload: { name: "dup", files: ["f.txt"] } });
    expect(dup.statusCode).toBe(409);

    const badName = await app.inject({ method: "POST", url: "/api/projects/p1/checkpoints", payload: { name: "bad name!", files: ["f.txt"] } });
    expect(badName.statusCode).toBe(400);

    const hostile = await app.inject({ method: "POST", url: "/api/projects/p1/checkpoints", payload: { name: "esc", files: ["../etc/passwd"] } });
    expect(hostile.statusCode).toBe(403);

    // No files given and no change sets exist yet → actionable 400, not an empty success.
    const empty = await app.inject({ method: "POST", url: "/api/projects/p1/checkpoints", payload: { name: "nothing" } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.message).toMatch(/Nothing to checkpoint/);

    const missingProject = await app.inject({ method: "GET", url: "/api/projects/nope/checkpoints" });
    expect(missingProject.statusCode).toBe(404);
  });
});
