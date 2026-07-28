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
  it("renders safe model phases and an expandable, target-specific tool record", () => {
    const activity = projectConversationActivity({
      projectId: "project-1",
      conversationId: "conversation-1",
      tasks: [{
        taskId: "task-1",
        events: [
          event(1, "agent.state_changed", { state: "planning", privateReasoning: "must never reach browser" }),
          event(2, "tool.started", { id: "read-1", toolName: "read_file", target: "src/activity.ts" }),
          event(3, "tool.completed", { id: "read-1", toolName: "read_file", elapsedMs: 38 }),
        ],
      }],
    });

    expect(activity.entries).toMatchObject([
      { kind: "assistant", status: "running", summary: "Morrow is planning next step" },
      {
        id: "task-1:tool:read-1",
        kind: "file",
        status: "completed",
        summary: "Read src/activity.ts",
        target: "src/activity.ts",
        durationMs: 38,
      },
    ]);
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
