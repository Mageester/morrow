import { describe, it, expect } from "vitest";
import { migrations, openDatabase } from "../src/database.js";
import {
  projectRepository,
  reconcileProjectWorkspaceDuplicates,
} from "../src/repositories/projects.js";

const t = "2026-01-01T00:00:00.000Z";
const add = (repository: any, id: string) => repository.createProject({
  id,
  name: id,
  workspacePath: `C:/work/${id}`,
  createdAt: t,
});

describe("project repository", () => {
  it("creates, gets, lists and isolates projects", () => {
    const db = openDatabase(":memory:");
    const repository = projectRepository(db);
    add(repository, "a");
    add(repository, "b");

    expect(repository.getProjectById("missing")).toBeUndefined();
    expect(repository.listProjects().map((project: any) => project.id)).toEqual(["a", "b"]);
    db.prepare("DELETE FROM projects WHERE id='a'").run();
    expect(repository.getProjectById("b")?.workspacePath).toBe("C:/work/b");
    db.close();
  });

  it("reuses the existing project when a workspace is registered again", () => {
    const db = openDatabase(":memory:");
    const repository = projectRepository(db);
    const first = repository.createProject({
      id: "first",
      name: "First",
      workspacePath: "C:/same",
      createdAt: t,
    });
    const reused = repository.createProject({
      id: "second",
      name: "Second",
      workspacePath: "C:/same",
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    expect(reused).toEqual(first);
    expect(repository.listProjects().map((project: any) => project.id)).toEqual(["first"]);
    db.close();
  });

  it("reparents task history to the oldest project while collapsing legacy duplicate rows", () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run(
      "old", 1, "Old", "C:/same", "2026-01-01T00:00:00.000Z", t,
    );
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run(
      "new", 1, "New", "C:/same", "2026-01-02T00:00:00.000Z", t,
    );
    db.prepare(
      "INSERT INTO tasks(id,schema_version,project_id,type,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run("task-new", 1, "new", "agent_chat", "completed", t, t);

    reconcileProjectWorkspaceDuplicates(db);

    expect(db.prepare("SELECT id FROM projects ORDER BY id").all()).toEqual([{ id: "old" }]);
    expect(db.prepare("SELECT project_id FROM tasks WHERE id='task-new'").get()).toEqual({ project_id: "old" });
    db.close();
  });

  it("migration 74 reconciles old duplicate rows before its registration lookup prevents new duplicates", () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run(
      "old", 1, "Old", "C:/legacy", "2026-01-01T00:00:00.000Z", t,
    );
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run(
      "new", 1, "New", "C:/legacy", "2026-01-02T00:00:00.000Z", t,
    );

    const migration = migrations.find((item) => item.id === 74)!;
    migration.up!(db);

    expect(db.prepare("SELECT id FROM projects").all()).toEqual([{ id: "old" }]);
    const reused = projectRepository(db).createProject({
      id: "third",
      name: "Third",
      workspacePath: "C:/legacy",
      createdAt: t,
    });
    expect(reused.id).toBe("old");
    db.close();
  });

  it("rejects corrupted rows", () => {
    const db = openDatabase(":memory:");
    const repository = projectRepository(db);
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run("x", 2, "x", "c", t, t);
    expect(() => repository.getProjectById("x")).toThrow();
    db.close();
  });
});
