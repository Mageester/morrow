import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("REST API and Task Runner Vertical Slice", () => {
  let db: any;
  let runner: TaskRunner;
  let app: any;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "morrow-api-test-"));
    dbPath = join(tempDir, "morrow.db");
    db = openDatabase(dbPath);
    runner = new TaskRunner(db);
    app = buildServer({ db, runner });
  });

  afterEach(() => {
    app.close();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns 404 for missing resources", async () => {
    const res1 = await app.inject({ method: "GET", url: "/api/projects/unknown" });
    expect(res1.statusCode).toBe(404);
    expect(res1.json().error.code).toBe("NOT_FOUND");

    const res2 = await app.inject({ method: "GET", url: "/api/tasks/unknown" });
    expect(res2.statusCode).toBe(404);
  });

  it("canonicalizes workspace on project creation", async () => {
    const wsDir = join(tempDir, "ws");
    mkdirSync(wsDir);
    const createRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Test Project", workspacePath: wsDir + "/../ws" }
    });
    expect(createRes.statusCode).toBe(200);
    const p = createRes.json();
    expect(p.name).toBe("Test Project");
    expect(p.workspacePath).not.toContain("..");

    const listRes = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listRes.json()).toHaveLength(1);
  });

  it("returns structured error for invalid workspace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Test Project", workspacePath: join(tempDir, "does-not-exist") }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_WORKSPACE");
  });

  it("inspects workspace and streams events", async () => {
    const wsDir = join(tempDir, "ws");
    mkdirSync(wsDir);
    writeFileSync(join(wsDir, "test.txt"), "hello");

    const pRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Test", workspacePath: wsDir }
    });
    const projectId = pRes.json().id;

    const tRes = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks/inspect-workspace`
    });
    expect(tRes.statusCode).toBe(202);
    const taskId = tRes.json().taskId;

    await runner.waitFor(taskId);

    const aggRes = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
    const agg = aggRes.json();
    expect(agg.task.status).toBe("verified");
    expect(agg.evidence).toHaveLength(1);
    expect(agg.evidence[0].path).toBe("test.txt");

    const eRes = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/events?after=0` });
    const events = eRes.json();
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].type).toBe("task.verified");
  });

  it("prevents duplicate task execution", async () => {
    const wsDir = join(tempDir, "ws");
    mkdirSync(wsDir);
    const pRes = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Test", workspacePath: wsDir } });
    const projectId = pRes.json().id;

    // We can't really trigger duplicate execution easily since the route creates a NEW task each time, 
    // and runner.run() is synchronous in registering it. But we can test runner manually.
    const task = app.inject({ method: "POST", url: `/api/projects/${projectId}/tasks/inspect-workspace` });
    const task2 = app.inject({ method: "POST", url: `/api/projects/${projectId}/tasks/inspect-workspace` });
    
    const [res1, res2] = await Promise.all([task, task2]);
    // The fastify route creates a new task each time, so duplicate execution is prevented because
    // the POST handler calls runner.run(). If we test runner.run() directly, we can see the throw.
    
    const tRes = await app.inject({ method: "POST", url: `/api/projects/${projectId}/tasks/inspect-workspace` });
    const taskId = tRes.json().taskId;

    // Start a long-running task to simulate active processing
    const taskPromise = new Promise(resolve => setTimeout(resolve, 50));
    (runner as any).activeTasks.add("task-3");
    (runner as any).activePromises.set("task-3", taskPromise);
    expect(() => runner.run("task-3")).toThrow(/Duplicate/);
    (runner as any).activeTasks.delete("task-3");

    await runner.waitFor(taskId);
  });
});
