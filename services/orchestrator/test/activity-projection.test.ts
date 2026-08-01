import { describe, expect, it } from "vitest";
import type { TaskEvent } from "@morrow/contracts";
import { projectConversationActivity } from "../src/web/activity-projection.js";

function event(sequence: number, type: TaskEvent["type"], payload: Record<string, unknown> = {}): TaskEvent {
  return {
    id: `event-${sequence}`,
    taskId: "task-1",
    sequence,
    type,
    createdAt: `2026-07-28T12:00:0${sequence}.000Z`,
    payload,
  };
}

describe("conversation activity projection", () => {
  it("keeps compact reasoning, tool, file, and skill records while hiding lifecycle noise", () => {
    const activity = projectConversationActivity({
      projectId: "project-1",
      conversationId: "conversation-1",
      tasks: [{
        taskId: "task-1",
        events: [
          event(0, "task.created"),
          event(1, "agent.state_changed", { state: "planning", privateReasoning: "must never reach browser" }),
          event(2, "plan.created", { steps: 3 }),
          event(3, "tool.started", { id: "read-1", toolName: "read_file", target: "src/activity.ts" }),
          event(4, "tool.completed", { id: "read-1", toolName: "read_file", elapsedMs: 38 }),
          event(5, "tool.started", { id: "file-1", toolName: "create_file", target: "src/activity.ts" }),
          event(6, "tool.completed", { id: "file-1", toolName: "create_file", elapsedMs: 38 }),
          event(7, "tool.started", { id: "skill-1", toolName: "load_skill", target: "playwright" }),
          event(8, "tool.completed", { id: "skill-1", toolName: "load_skill", elapsedMs: 9 }),
        ],
      }],
    });

    expect(activity.entries).toMatchObject([
      { kind: "assistant", status: "running", summary: "Thinking", detail: "Planning next step" },
      {
        id: "task-1:tool:file-1",
        kind: "file",
        status: "completed",
        summary: "Created src/activity.ts",
        target: "src/activity.ts",
        durationMs: 38,
      },
      {
        id: "task-1:tool:skill-1",
        kind: "tool",
        status: "completed",
        summary: "Used skill playwright",
        target: "playwright",
        durationMs: 9,
      },
    ]);
    expect(activity.entries).toHaveLength(3);
    expect(JSON.stringify(activity)).not.toContain("privateReasoning");
  });

  it("redacts command credentials before showing a target", () => {
    const activity = projectConversationActivity({
      projectId: "project-1",
      conversationId: "conversation-1",
      tasks: [{
        taskId: "task-1",
        events: [event(1, "tool.started", {
          id: "command-1",
          toolName: "run_command",
          target: "curl --token secret-value https://example.test",
        })],
      }],
    });

    expect(activity.entries[0]).toMatchObject({
      summary: "Running curl --token [redacted] https://example.test",
      target: "curl --token [redacted] https://example.test",
    });
    expect(JSON.stringify(activity)).not.toContain("secret-value");
  });
});
