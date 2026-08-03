import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskContinuationsRepository } from "../src/repositories/task-continuations.js";

const at = "2026-07-13T00:00:00.000Z";

describe("task continuation durable privacy", () => {
  it("redacts continuation arguments on writes and legacy reads", () => {
    const db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: "/tmp/p", createdAt: at });
    taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "running", createdAt: at });
    const repo = taskContinuationsRepository(db);
    const probe = "credential sk-abcdefghijklmnop";
    const args = { nested: { secret: probe }, opaque: [probe] };

    repo.save({ taskId: "t", toolCallId: "call", toolName: "run_command", args }, at);
    const stored = db.prepare("SELECT args_json FROM task_continuations WHERE task_id=?").get("t") as { args_json: string };
    expect(stored.args_json).not.toContain(probe);
    expect(JSON.stringify(repo.get("t"))).not.toContain(probe);

    db.prepare("UPDATE task_continuations SET args_json=? WHERE task_id=?").run(JSON.stringify(args), "t");
    expect(JSON.stringify(repo.get("t"))).not.toContain(probe);
    db.close();
  });
});
