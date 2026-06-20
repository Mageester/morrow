import { describe, expect, it } from "vitest";
import { PlanStepSchema } from "@morrow/contracts";
import { inspectWorkspacePlan } from "../src/plans/inspect-workspace.js";

describe("inspect workspace plan", () => {
  it("defines exactly three stable contract-valid pending steps", () => {
    const plan = inspectWorkspacePlan("task-1");
    expect(plan).toEqual([
      { version: 1, id: "inspect-workspace.validate-boundary", taskId: "task-1", position: 1, title: "Validate workspace boundary", description: "Resolve and validate canonical workspace directory.", status: "pending" },
      { version: 1, id: "inspect-workspace.inspect-files", taskId: "task-1", position: 2, title: "Inspect workspace files", description: "List bounded safe workspace file entries.", status: "pending" },
      { version: 1, id: "inspect-workspace.verify-evidence", taskId: "task-1", position: 3, title: "Verify inspection evidence", description: "Verify persisted evidence matches inspected files.", status: "pending" },
    ]);
    plan.forEach((step) => expect(PlanStepSchema.parse(step)).toEqual(step));
  });
});
