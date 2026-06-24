import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";

describe("idempotent task creation", () => {
  let db: any;
  let app: any;
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "morrow-idem-"));
    db = openDatabase(":memory:");
    // A no-op executor so created tasks settle without doing real work.
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: ws, createdAt: new Date().toISOString() });
  });

  afterEach(() => {
    app.close();
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("returns the same task for a repeated Idempotency-Key and creates only one task", async () => {
    const headers = { "Idempotency-Key": "req-123" };
    const first = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace", headers });
    expect(first.statusCode).toBe(202);
    const firstId = first.json().taskId;

    const second = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace", headers });
    expect(second.statusCode).toBe(200);
    expect(second.json().taskId).toBe(firstId);
    expect(second.json().replayed).toBe(true);

    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(1);
  });

  it("creates distinct tasks for different keys and for no key", async () => {
    const a = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace", headers: { "Idempotency-Key": "k-a" } });
    const b = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace", headers: { "Idempotency-Key": "k-b" } });
    const c = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace" });
    const d = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace" });
    const ids = new Set([a, b, c, d].map((r) => r.json().taskId));
    expect(ids.size).toBe(4);
    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(4);
  });

  it("accepts the key from the request body as well as the header", async () => {
    const first = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace", payload: { idempotencyKey: "body-key" } });
    const second = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace", payload: { idempotencyKey: "body-key" } });
    expect(first.json().taskId).toBe(second.json().taskId);
    expect(second.json().replayed).toBe(true);
  });
});
