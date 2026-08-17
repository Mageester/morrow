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
  it("shows automatic learning as a subtle inspectable activity step", () => {
    const activity = projectConversationActivity({
      projectId: "project-1",
      conversationId: "conversation-1",
      tasks: [{
        taskId: "task-1",
        events: [event(1, "memory.learned", { count: 2 })],
      }],
    });

    expect(activity.entries).toMatchObject([
      { kind: "memory", status: "completed", summary: "Updated memory", detail: "2 useful details learned" },
    ]);
  });

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

  it("names a tool with no hand-written verb after the tool that actually ran", () => {
    const activity = projectConversationActivity({
      projectId: "project-1",
      conversationId: "conversation-1",
      tasks: [{
        taskId: "task-1",
        events: [
          event(1, "tool.started", { id: "b-1", toolName: "browser_navigate", target: "https://example.test" }),
          event(2, "tool.completed", { id: "b-1", toolName: "browser_navigate", elapsedMs: 120 }),
          event(3, "tool.started", { id: "b-2", toolName: "browser_screenshot" }),
        ],
      }],
    });

    // Every one of these used to read "Used tool", which made distinct actions
    // look like one repeated step.
    expect(activity.entries.map((item) => item.summary)).toEqual([
      "Used browser navigate https://example.test",
      "Using browser screenshot",
    ]);
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

  it("surfaces route selection, reasoning fallback, and admitted context budgeting", () => {
    const activity = projectConversationActivity({
      projectId: "project-1",
      conversationId: "conversation-1",
      tasks: [{
        taskId: "task-1",
        events: [
          event(1, "provider.route_selected", { providerId: "gemini", model: "gemini-3.7-flash", fallbackUsed: false }),
          event(2, "provider.reasoning_unavailable", {
            provider: "deepseek",
            model: "deepseek-v4-flash",
            reason: "Unsupported reasoning effort \"max\" for this exact route.",
          }),
          event(3, "context.budget_calculated", {
            admitted: true,
            provider: "gemini",
            model: "gemini-3.7-flash",
            currentModelVisibleTokens: 12_000,
            usableInputTokens: 990_000,
            contextWindowConfidence: "verified",
          }),
          // A rejected (non-admitted) candidate on the same turn is diagnostic
          // noise for this route, not something Morrow did — it must not
          // appear as its own timeline row.
          event(4, "context.budget_calculated", { admitted: false, provider: "deepseek", model: "deepseek-v4-flash" }),
        ],
      }],
    });

    expect(activity.entries).toMatchObject([
      { kind: "provider", status: "completed", summary: "Route selected", detail: "gemini / gemini-3.7-flash" },
      {
        kind: "provider",
        status: "warning",
        summary: "Requested reasoning not supported; used route default",
        detail: "Unsupported reasoning effort \"max\" for this exact route.",
        target: "deepseek / deepseek-v4-flash",
      },
      { kind: "context", status: "completed", summary: "Context budget calculated", detail: "12,000 / 990,000 usable input tokens, verified" },
    ]);
    expect(activity.entries).toHaveLength(3);
  });
});

describe("observe-only telemetry does not read as a warning", () => {
  it("hides pure telemetry and states what a repeat advisory actually did", () => {
    // `task.progress_warning` carries several unrelated reasons. Rendering all
    // of them as "Progress warning recorded" filled the feed with identical,
    // alarming rows for events that control nothing — the live runs showed one
    // per turn. Policy observations and ledger-write diagnostics are not
    // user-facing at all; a repeat advisory is, but it is not a warning.
    const activity = projectConversationActivity({
      projectId: "project-1",
      conversationId: "conversation-1",
      tasks: [{
        taskId: "task-1",
        events: [
          event(1, "task.progress_warning", { reason: "execution_policy_observed", signal: "task_shape_inference" }),
          event(2, "task.progress_warning", { reason: "mission_ledger_write_failed", message: "disk full" }),
          event(3, "task.progress_warning", { reason: "exact_repeat_advisory", toolName: "read_file", count: 3 }),
          event(4, "task.progress_warning", { reason: "empty_provider_response", providerBoundaryClassification: "empty_response" }),
        ],
      }],
    });

    expect(activity.entries).toMatchObject([
      { kind: "recovery", status: "running", summary: "Repeat noted for the model", toolName: "read_file" },
      { kind: "provider", status: "warning", summary: "Provider returned no answer; retrying" },
    ]);
    expect(activity.entries.some((item) => item.summary === "Progress warning recorded")).toBe(false);
    expect(activity.entries[0]!.detail).toContain("repeated 3 times");
  });

  it("still surfaces an unrecognized recovery reason rather than swallowing it", () => {
    const activity = projectConversationActivity({
      projectId: "project-1",
      conversationId: "conversation-1",
      tasks: [{ taskId: "task-1", events: [event(1, "task.progress_warning", { reason: "verification_incomplete" })] }],
    });
    expect(activity.entries).toMatchObject([
      { kind: "recovery", status: "warning", summary: "Recovery evaluated", detail: "verification incomplete" },
    ]);
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

describe("context budget and route event coalescing", () => {
  it("does not spam identical per-turn context budgeting or route selection events", () => {
    const activity = projectConversationActivity({
      projectId: "project-1",
      conversationId: "conversation-1",
      tasks: [{
        taskId: "task-1",
        events: [
          event(1, "provider.route_selected", { providerId: "nvidia-nim", model: "nemotron-3-ultra", fallbackUsed: false }),
          event(2, "context.budget_calculated", {
            admitted: true,
            provider: "nvidia-nim",
            model: "nemotron-3-ultra",
            currentModelVisibleTokens: 4_000,
            usableInputTokens: 200_000,
            compactionThresholdTokens: 160_000,
            contextWindowConfidence: "verified",
          }),
          // Turn 2: identical route selection & regular recalculation with same parameters
          event(3, "provider.route_selected", { providerId: "nvidia-nim", model: "nemotron-3-ultra", fallbackUsed: false }),
          event(4, "context.budget_calculated", {
            admitted: true,
            provider: "nvidia-nim",
            model: "nemotron-3-ultra",
            currentModelVisibleTokens: 5_200,
            usableInputTokens: 200_000,
            compactionThresholdTokens: 160_000,
            contextWindowConfidence: "verified",
          }),
          // Turn 3: another routine calculation
          event(5, "context.budget_calculated", {
            admitted: true,
            provider: "nvidia-nim",
            model: "nemotron-3-ultra",
            currentModelVisibleTokens: 6_800,
            usableInputTokens: 200_000,
            compactionThresholdTokens: 160_000,
            contextWindowConfidence: "verified",
          }),
        ],
      }],
    });

    // Only the initial route and initial context budget appear; routine turns 2 and 3 do NOT duplicate
    expect(activity.entries).toHaveLength(2);
    expect(activity.entries[0]).toMatchObject({ kind: "provider", summary: "Route selected" });
    expect(activity.entries[1]).toMatchObject({ kind: "context", summary: "Context budget calculated" });
  });

  it("surfaces compaction lifecycle and near-threshold warnings", () => {
    const activity = projectConversationActivity({
      projectId: "project-1",
      conversationId: "conversation-1",
      tasks: [{
        taskId: "task-1",
        events: [
          event(1, "context.budget_calculated", {
            admitted: true,
            provider: "nvidia-nim",
            model: "nemotron-3-ultra",
            currentModelVisibleTokens: 40_000,
            usableInputTokens: 200_000,
            compactionThresholdTokens: 160_000,
          }),
          // Exceeding compaction threshold
          event(2, "context.budget_calculated", {
            admitted: true,
            provider: "nvidia-nim",
            model: "nemotron-3-ultra",
            currentModelVisibleTokens: 165_000,
            usableInputTokens: 200_000,
            compactionThresholdTokens: 160_000,
          }),
          // Compaction starts & completes
          event(3, "context.compaction_started"),
          event(4, "context.compaction_completed", { tokensBefore: 165_000, tokensAfter: 32_000 }),
        ],
      }],
    });

    expect(activity.entries).toMatchObject([
      { kind: "context", status: "completed", summary: "Context budget calculated" },
      { kind: "context", status: "warning", summary: "Context approaching compaction threshold" },
      { kind: "context", status: "running", summary: "Context compaction started" },
      { kind: "context", status: "completed", summary: "Context compacted", detail: "165,000 → 32,000 tokens" },
    ]);
  });
});
