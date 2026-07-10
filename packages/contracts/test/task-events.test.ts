import { describe, expect, it } from "vitest";
import { TaskEventSchema } from "../src/index.js";

describe("task execution events", () => {
  it("accepts deterministic execution event types", () => {
    for (const type of ["task.created", "task.running", "plan.created", "step.started", "step.completed", "workspace.inspected", "evidence.persisted", "assistant.turn_started", "assistant.turn_completed", "agent.state_changed", "approval.requested", "approval.resolved", "verification.completed", "task.verified", "task.failed", "task.interrupted", "task.progress_warning", "task.recovery_required", "task.recovery_requeued"]) {
      expect(TaskEventSchema.parse({ id: "event", taskId: "task", sequence: 1, type, payload: {}, createdAt: "2026-01-01T00:00:00.000Z" }).type).toBe(type);
    }
  });

  it("accepts a realistic assistant.turn_completed payload marking the canonical final turn", () => {
    const parsed = TaskEventSchema.parse({
      id: "event",
      taskId: "task",
      sequence: 12,
      type: "assistant.turn_completed",
      payload: { turnId: "task:turn-12", text: "VERIFICATION PASSED.", final: true, hasToolCalls: false },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.payload).toMatchObject({ final: true, hasToolCalls: false });
  });
});
