import type { PlanStep } from "@morrow/contracts";

const steps = [
  { id: "inspect-workspace.validate-boundary", position: 1, title: "Validate workspace boundary", description: "Resolve and validate canonical workspace directory." },
  { id: "inspect-workspace.inspect-files", position: 2, title: "Inspect workspace files", description: "List bounded safe workspace file entries." },
  { id: "inspect-workspace.verify-evidence", position: 3, title: "Verify inspection evidence", description: "Verify persisted evidence matches inspected files." },
] as const;

export function inspectWorkspacePlan(taskId: string): PlanStep[] {
  return steps.map((step) => ({ version: 1, taskId, ...step, id: `${taskId}-${step.id}`, status: "pending" }));
}
