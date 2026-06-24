import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";

describe("task graph repository", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: new Date().toISOString() });
  });
  afterEach(() => db.close());

  it("links children to a parent and lists them", () => {
    const tasks = taskRepository(db);
    tasks.createTask({ id: "root", projectId: "p1", kind: "agent_chat", status: "running", createdAt: new Date().toISOString() });
    tasks.createTask({ id: "child-a", projectId: "p1", kind: "inspect_workspace", status: "queued", parentTaskId: "root", createdAt: new Date().toISOString() });
    tasks.createTask({ id: "child-b", projectId: "p1", kind: "inspect_workspace", status: "queued", parentTaskId: "root", createdAt: new Date().toISOString() });
    tasks.createTask({ id: "orphan", projectId: "p1", kind: "inspect_workspace", status: "queued", createdAt: new Date().toISOString() });

    expect(tasks.getTaskById("root")?.parentTaskId).toBeNull();
    expect(tasks.getTaskById("child-a")?.parentTaskId).toBe("root");
    expect(tasks.listChildren("root").map((t) => t.id)).toEqual(["child-a", "child-b"]);
    expect(tasks.listChildren("child-a")).toEqual([]);
  });

  it("cascade-deletes children when the parent is removed", () => {
    const tasks = taskRepository(db);
    tasks.createTask({ id: "root", projectId: "p1", kind: "agent_chat", status: "running", createdAt: new Date().toISOString() });
    tasks.createTask({ id: "child", projectId: "p1", kind: "inspect_workspace", status: "queued", parentTaskId: "root", createdAt: new Date().toISOString() });
    db.prepare("DELETE FROM tasks WHERE id = ?").run("root");
    expect(tasks.getTaskById("child")).toBeUndefined();
  });
});

describe("subagent API", () => {
  let db: any;
  let app: any;
  beforeEach(() => {
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: new Date().toISOString() });
    taskRepository(db).createTask({ id: "parent", projectId: "p1", kind: "agent_chat", status: "running", createdAt: new Date().toISOString() });
  });
  afterEach(() => {
    app.close();
    db.close();
  });

  it("spawns a child task linked to the parent and returns it in the tree", async () => {
    const spawn = await app.inject({ method: "POST", url: "/api/tasks/parent/subagents", payload: {} });
    expect(spawn.statusCode).toBe(202);
    const childId = spawn.json().taskId;
    expect(spawn.json().parentTaskId).toBe("parent");
    expect(taskRepository(db).getTaskById(childId)?.parentTaskId).toBe("parent");

    const tree = await app.inject({ method: "GET", url: "/api/tasks/parent/tree" });
    expect(tree.statusCode).toBe(200);
    expect(tree.json().task.id).toBe("parent");
    expect(tree.json().children.map((c: any) => c.task.id)).toEqual([childId]);
  });

  it("builds a nested tree across generations", async () => {
    const first = (await app.inject({ method: "POST", url: "/api/tasks/parent/subagents", payload: {} })).json().taskId;
    const second = (await app.inject({ method: "POST", url: `/api/tasks/${first}/subagents`, payload: {} })).json().taskId;
    const tree = (await app.inject({ method: "GET", url: "/api/tasks/parent/tree" })).json();
    expect(tree.children[0].task.id).toBe(first);
    expect(tree.children[0].children[0].task.id).toBe(second);
  });

  it("404s spawning under or fetching the tree of an unknown task", async () => {
    expect((await app.inject({ method: "POST", url: "/api/tasks/nope/subagents", payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/tasks/nope/tree" })).statusCode).toBe(404);
  });
});
