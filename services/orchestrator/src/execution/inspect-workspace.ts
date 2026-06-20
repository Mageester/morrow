import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { inspectWorkspace } from "../workspace/inspector.js";
import { validateWorkspace } from "../workspace/validator.js";
import { inspectWorkspacePlan } from "../plans/inspect-workspace.js";
import { projectRepository } from "../repositories/projects.js";
import { taskRepository } from "../repositories/tasks.js";
import { taskRecordsRepository } from "../repositories/task-records.js";

type Dependencies = { db: Database.Database; taskId: string; now?: () => string; maxDepth?: number; maxResults?: number };

export function executeInspectWorkspaceTask({ db, taskId, now = () => new Date().toISOString(), maxDepth = 8, maxResults = 500 }: Dependencies) {
  const projects = projectRepository(db); const tasks = taskRepository(db); const records = taskRecordsRepository(db);
  const task = tasks.getTaskById(taskId);
  if (!task || task.kind !== "inspect_workspace" || task.status !== "queued") throw new Error("Task is not available for workspace inspection");
  const project = projects.getProjectById(task.projectId);
  if (!project) throw new Error("Task project is unavailable");
  const event = (type: Parameters<typeof records.appendEvent>[0]["type"], payload: Record<string, unknown> = {}) => records.appendEvent({ id: randomUUID(), taskId, type, payload, createdAt: now() });
  const plan = inspectWorkspacePlan(taskId);
  records.replacePlan(taskId, plan.map(({ version: _, taskId: __, ...step }) => step));
  event("task.created"); event("plan.created", { stepCount: plan.length });
  const canonicalPath = validateWorkspace(project.workspacePath).canonicalPath;
  records.upsertDisclosure({ taskId, executionMode: "deterministic-local", provider: "deterministic-local", networkAccess: "disabled", workspaceScope: canonicalPath, estimatedCostUsd: "$0.00", createdAt: now(), updatedAt: now() });
  records.transitionTask(taskId, "running", { id: randomUUID(), createdAt: now(), payload: {} });
  const steps = records.listPlanSteps(taskId);
  const runStep = <T>(stepId: string, action: () => T): T => {
    records.updatePlanStepStatus(stepId, "running", now()); event("step.started", { stepId });
    const value = action(); records.updatePlanStepStatus(stepId, "completed", now()); event("step.completed", { stepId }); return value;
  };
  runStep(steps[0]!.id, () => validateWorkspace(canonicalPath));
  const inspectionStep = steps[1]!;
  records.updatePlanStepStatus(inspectionStep.id, "running", now()); event("step.started", { stepId: inspectionStep.id });
  const inspection = inspectWorkspace(canonicalPath, { maxDepth, maxResults });
  for (const entry of inspection.entries) records.appendEvidence({ id: randomUUID(), taskId, type: "file", path: entry.path, metadata: { type: entry.type, size: entry.size }, createdAt: now() });
  event("workspace.inspected", { resultCount: inspection.entries.length, depthTruncated: inspection.truncatedByDepth, countTruncated: inspection.truncatedByCount, inaccessibleEntryCount: inspection.inaccessibleEntryCount });
  event("evidence.persisted", { count: inspection.entries.length });
  records.updatePlanStepStatus(inspectionStep.id, "completed", now()); event("step.completed", { stepId: inspectionStep.id });
  runStep(steps[2]!.id, () => {
    const evidence = records.listEvidence(taskId);
    if (evidence.length !== inspection.entries.length || evidence.some((item) => item.path.startsWith("/") || item.path.includes(".."))) throw new Error("Workspace evidence verification failed");
    records.upsertVerification({ taskId, status: "verified", summary: `Inspected ${evidence.length} workspace file(s)`, details: { resultCount: inspection.entries.length, depthTruncated: inspection.truncatedByDepth, countTruncated: inspection.truncatedByCount, inaccessibleEntryCount: inspection.inaccessibleEntryCount }, createdAt: now(), updatedAt: now() });
    event("verification.completed", { evidenceCount: evidence.length });
  });
  records.transitionTask(taskId, "verified", { id: randomUUID(), createdAt: now(), payload: {} });
  return records.getAggregate(taskId);
}
