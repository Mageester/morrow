import { describe, expect, it } from "vitest";
import { TaskEventSchema } from "../src/index.js";

describe("task execution events", () => {
  it("accepts deterministic execution event types", () => {
    for (const type of ["task.created", "task.running", "plan.created", "step.started", "step.completed", "workspace.inspected", "evidence.persisted", "verification.completed", "task.verified", "task.failed", "task.interrupted", "task.recovery_required"]) {
      expect(TaskEventSchema.parse({ id: "event", taskId: "task", sequence: 1, type, payload: {}, createdAt: "2026-01-01T00:00:00.000Z" }).type).toBe(type);
    }
  });
});
