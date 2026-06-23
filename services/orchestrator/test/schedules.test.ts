import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { schedulesRepository } from "../src/repositories/schedules.js";
import { SchedulerTicker } from "../src/schedule/ticker.js";

describe("schedules repository", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: "2026-01-01T00:00:00.000Z" });
  });
  afterEach(() => db.close());

  it("returns only enabled, due schedules and advances on markRan", () => {
    const repo = schedulesRepository(db);
    repo.create({ id: "s1", projectId: "p1", cron: "*/15 * * * *", taskKind: "inspect_workspace", nextRunAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });
    repo.create({ id: "s2", projectId: "p1", cron: "0 0 * * *", taskKind: "inspect_workspace", nextRunAt: "2026-06-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });

    expect(repo.due("2026-01-01T00:05:00.000Z").map((s) => s.id)).toEqual(["s1"]);
    repo.setEnabled("s1", false);
    expect(repo.due("2026-01-01T00:05:00.000Z")).toEqual([]);
    repo.setEnabled("s1", true);
    repo.markRan("s1", "2026-01-01T00:05:00.000Z", "2026-01-01T00:15:00.000Z");
    expect(repo.get("s1")?.nextRunAt).toBe("2026-01-01T00:15:00.000Z");
    expect(repo.due("2026-01-01T00:10:00.000Z")).toEqual([]);
  });
});

describe("SchedulerTicker", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: "2026-01-01T00:00:00.000Z" });
  });
  afterEach(() => db.close());

  it("fires one isolated task per due schedule and advances next_run_at", () => {
    const repo = schedulesRepository(db);
    repo.create({ id: "s1", projectId: "p1", cron: "*/15 * * * *", taskKind: "inspect_workspace", nextRunAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });

    let clock = new Date("2026-01-01T00:07:00.000Z");
    const ticker = new SchedulerTicker({ db, runner: new TaskRunner(db, async () => {}), now: () => clock });

    const fired = ticker.tick();
    expect(fired).toHaveLength(1);
    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(1);
    // next run is the next */15 boundary strictly after 00:07 → 00:15.
    expect(repo.get("s1")?.nextRunAt).toBe("2026-01-01T00:15:00.000Z");
    expect(repo.get("s1")?.lastRunAt).toBe("2026-01-01T00:07:00.000Z");

    // Not due again until the clock reaches the next boundary.
    expect(ticker.tick()).toHaveLength(0);
    clock = new Date("2026-01-01T00:15:30.000Z");
    expect(ticker.tick()).toHaveLength(1);
    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(2);
  });
});

describe("schedules API", () => {
  let db: any;
  let app: any;
  beforeEach(() => {
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: new Date().toISOString() });
  });
  afterEach(() => {
    app.close();
    db.close();
  });

  it("creates, lists, runs, and deletes a schedule", async () => {
    const create = await app.inject({ method: "POST", url: "/api/projects/p1/schedules", payload: { cron: "0 9 * * 1-5" } });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;
    expect(create.json().nextRunAt).toBeTruthy();

    const list = await app.inject({ method: "GET", url: "/api/projects/p1/schedules" });
    expect(list.json().map((s: any) => s.id)).toEqual([id]);

    const run = await app.inject({ method: "POST", url: `/api/schedules/${id}/run` });
    expect(run.statusCode).toBe(202);
    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(1);

    const del = await app.inject({ method: "DELETE", url: `/api/schedules/${id}` });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/projects/p1/schedules" })).json()).toEqual([]);
  });

  it("rejects an invalid cron expression with 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/schedules", payload: { cron: "not a cron" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("404s scheduling under an unknown project", async () => {
    expect((await app.inject({ method: "POST", url: "/api/projects/nope/schedules", payload: { cron: "* * * * *" } })).statusCode).toBe(404);
  });
});
