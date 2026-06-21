import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";

describe("agent execution state", () => {
  it("persists ordered transitions and exposes each state as an event", () => {
    const db = openDatabase(":memory:");
    const records = taskRecordsRepository(db) as any;
    const createdAt = "2026-06-21T00:00:00.000Z";
    projectRepository(db).createProject({ id: "project", name: "Project", workspacePath: "C:/workspace", createdAt });
    taskRepository(db).createTask({ id: "task", projectId: "project", kind: "agent_chat", status: "queued", createdAt });

    records.transitionAgentState("task", { id: "state-1", state: "idle", details: {}, createdAt });
    records.transitionAgentState("task", { id: "state-2", state: "understanding", details: { request: "fix test" }, createdAt });
    records.transitionAgentState("task", { id: "state-3", state: "planning", details: {}, createdAt });

    expect(records.listAgentStates("task").map((state: any) => state.state)).toEqual(["idle", "understanding", "planning"]);
    expect(records.getAggregate("task").agentState?.state).toBe("planning");
    expect(records.listEvents("task").map((event: any) => event.type)).toEqual([
      "agent.state_changed",
      "agent.state_changed",
      "agent.state_changed",
    ]);
    expect(records.listEvents("task")[1]?.payload).toMatchObject({ state: "understanding", request: "fix test" });
    expect(() => records.transitionAgentState("task", { id: "state-4", state: "applying_changes", details: {}, createdAt })).toThrow("Invalid agent state transition");

    db.close();
  });
});
