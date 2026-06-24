import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { skillUsageRepository } from "../src/repositories/skill-usage.js";

describe("skill usage repository", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
    const projects = projectRepository(db);
    projects.createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: new Date().toISOString() });
    projects.createProject({ id: "p2", name: "P2", workspacePath: process.cwd(), createdAt: new Date().toISOString() });
  });
  afterEach(() => db.close());

  it("increments the per-project counter and orders by count descending", () => {
    const usage = skillUsageRepository(db);
    usage.recordUse("p1", "coding", "2026-01-01T00:00:00.000Z");
    usage.recordUse("p1", "coding", "2026-01-01T00:01:00.000Z");
    usage.recordUse("p1", "testing", "2026-01-01T00:02:00.000Z");
    const list = usage.listByProject("p1");
    expect(list.map((u) => [u.skillId, u.count])).toEqual([
      ["coding", 2],
      ["testing", 1],
    ]);
    expect(usage.get("p1", "coding")?.lastUsedAt).toBe("2026-01-01T00:01:00.000Z");
  });

  it("isolates usage strictly by project", () => {
    const usage = skillUsageRepository(db);
    usage.recordUse("p1", "coding", "2026-01-01T00:00:00.000Z");
    usage.recordUse("p2", "coding", "2026-01-01T00:00:00.000Z");
    usage.recordUse("p2", "coding", "2026-01-01T00:01:00.000Z");
    expect(usage.get("p1", "coding")?.count).toBe(1);
    expect(usage.get("p2", "coding")?.count).toBe(2);
    expect(usage.listByProject("p1").map((u) => u.skillId)).toEqual(["coding"]);
  });
});

describe("skill usage API", () => {
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

  it("records a use and reflects it in the usage listing", async () => {
    const use = await app.inject({ method: "POST", url: "/api/projects/p1/skills/coding/use" });
    expect(use.statusCode).toBe(200);
    expect(use.json().count).toBe(1);
    const list = await app.inject({ method: "GET", url: "/api/projects/p1/skills/usage" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([{ skillId: "coding", projectId: "p1", count: 1, lastUsedAt: expect.any(String) }]);
  });

  it("404s on an unknown project and 400s on a malformed skill id", async () => {
    expect((await app.inject({ method: "POST", url: "/api/projects/nope/skills/coding/use" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/projects/p1/skills/has%20space/use" })).statusCode).toBe(400);
  });
});
