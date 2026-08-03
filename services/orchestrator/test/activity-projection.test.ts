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
        // Reads are transcript steps too: they are the evidence for the write
        // that follows, and hiding them left a change visible with its grounding
        // invisible.
        id: "task-1:tool:read-1",
        kind: "file",
        status: "completed",
        summary: "Read src/activity.ts",
        target: "src/activity.ts",
        durationMs: 38,
      },
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
    expect(activity.entries).toHaveLength(4);
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

  it("redacts credential-like streamed narration before it reaches web activity", () => {
    const activity = projectConversationActivity({
      projectId: "project-1",
      conversationId: "conversation-1",
      tasks: [{
        taskId: "task-1",
        events: [event(1, "evidence.persisted", {
          deltaText: "credential sk-abcdefghijklmnop",
          turnId: "task-1:turn-1",
        })],
      }],
    });

    expect(activity.entries[0]?.text).toBe("credential ***redacted***");
    expect(JSON.stringify(activity)).not.toContain("sk-abcdefghijklmnop");
  });
});

describe("interleaved transcript ordering", () => {
  it("folds streamed deltas into one narration entry per turn, in run order with the tools", () => {
    const activity = projectConversationActivity({
      projectId: "project-1",
      conversationId: "conversation-1",
      tasks: [{
        taskId: "task-1",
        events: [
          event(1, "assistant.turn_started", { turnId: "task-1:turn-1" }),
          event(2, "evidence.persisted", { deltaText: "Let me read ", turnId: "task-1:turn-1" }),
          event(3, "evidence.persisted", { deltaText: "the config.", turnId: "task-1:turn-1" }),
          event(4, "tool.started", { id: "read-1", toolName: "read_file", target: "package.json" }),
          event(5, "tool.completed", { id: "read-1", toolName: "read_file", elapsedMs: 12 }),
          event(6, "assistant.turn_started", { turnId: "task-1:turn-2" }),
          event(7, "evidence.persisted", { deltaText: "Now the fix.", turnId: "task-1:turn-2" }),
          event(8, "tool.started", { id: "w-1", toolName: "create_file", target: "src/a.ts" }),
          event(9, "tool.completed", { id: "w-1", toolName: "create_file", elapsedMs: 20 }),
        ],
      }],
    });

    // The transcript must read in the order the run actually happened.
    expect(activity.entries.map((e) => [e.kind, e.text ?? e.summary])).toEqual([
      ["narration", "Let me read the config."],
      ["file", "Read package.json"],
      ["narration", "Now the fix."],
      ["file", "Created src/a.ts"],
    ]);
  });

  it("never merges two turns, and keeps narration out of every other kind", () => {
    const activity = projectConversationActivity({
      projectId: "project-1",
      conversationId: "conversation-1",
      tasks: [{
        taskId: "task-1",
        events: [
          event(1, "evidence.persisted", { deltaText: "alpha", turnId: "task-1:turn-1" }),
          event(2, "evidence.persisted", { deltaText: "beta", turnId: "task-1:turn-2" }),
          event(3, "tool.started", { id: "r", toolName: "read_file", target: "a.txt" }),
          event(4, "tool.completed", { id: "r", toolName: "read_file" }),
        ],
      }],
    });
    const narration = activity.entries.filter((e) => e.kind === "narration");
    expect(narration.map((e) => e.text)).toEqual(["alpha", "beta"]);
    expect(activity.entries.filter((e) => e.kind !== "narration").every((e) => e.text === null)).toBe(true);
  });

  it("ignores whitespace-only narration so an empty turn adds no transcript step", () => {
    const activity = projectConversationActivity({
      projectId: "project-1",
      conversationId: "conversation-1",
      tasks: [{
        taskId: "task-1",
        events: [event(1, "evidence.persisted", { deltaText: "   ", turnId: "task-1:turn-1" })],
      }],
    });
    expect(activity.entries.filter((e) => e.kind === "narration")).toEqual([]);
  });
});

describe("narration cannot become a leak channel", () => {
  it("ignores deltaText riding on a file-evidence event, and never echoes it", () => {
    const activity = projectConversationActivity({
      projectId: "project-1",
      conversationId: "conversation-1",
      tasks: [{
        taskId: "task-1",
        events: [event(1, "evidence.persisted", {
          action: "patched",
          path: "src/app.ts",
          deltaText: "PRIVATE MODEL OUTPUT",
        })],
      }],
    });
    expect(activity.entries.map((e) => e.kind)).toEqual(["file"]);
    expect(activity.entries[0]).toMatchObject({ target: "src/app.ts", text: null });
    expect(JSON.stringify(activity)).not.toContain("PRIVATE MODEL OUTPUT");
  });
});
