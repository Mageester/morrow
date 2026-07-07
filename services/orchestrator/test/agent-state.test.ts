import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";

describe("agent execution state", () => {
  const seedAgentTask = () => {
    const db = openDatabase(":memory:");
    const createdAt = "2026-06-21T00:00:00.000Z";
    projectRepository(db).createProject({ id: "project", name: "Project", workspacePath: "C:/workspace", createdAt });
    taskRepository(db).createTask({ id: "task", projectId: "project", kind: "agent_chat", status: "queued", createdAt });
    return { db, records: taskRecordsRepository(db) as any, createdAt };
  };

  it("persists ordered transitions and exposes each state as an event", () => {
    const { db, records, createdAt } = seedAgentTask();

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

  it("requires an observing boundary between applying changes and proposing another change", () => {
    const { db, records, createdAt } = seedAgentTask();

    for (const [index, state] of ["idle", "understanding", "planning", "proposing_changes", "applying_changes"].entries()) {
      records.transitionAgentState("task", { id: `state-${index}`, state, details: {}, createdAt });
    }

    expect(() => records.transitionAgentState("task", { id: "invalid", state: "proposing_changes", details: {}, createdAt })).toThrow("Invalid agent state transition: applying_changes -> proposing_changes");

    records.transitionAgentState("task", { id: "observe", state: "observing", details: { event: "tool_completed", toolCallId: "f1" }, createdAt });
    records.transitionAgentState("task", { id: "next-proposal", state: "proposing_changes", details: { toolCallId: "f2" }, createdAt });

    expect(records.listAgentStates("task").map((state: any) => state.state)).toEqual([
      "idle",
      "understanding",
      "planning",
      "proposing_changes",
      "applying_changes",
      "observing",
      "proposing_changes",
    ]);

    db.close();
  });
});
