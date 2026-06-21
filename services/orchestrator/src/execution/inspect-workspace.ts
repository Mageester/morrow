import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { inspectWorkspace } from "../workspace/inspector.js";
import { validateWorkspace } from "../workspace/validator.js";
import { inspectWorkspacePlan } from "../plans/inspect-workspace.js";
import { projectRepository } from "../repositories/projects.js";
import { taskRepository } from "../repositories/tasks.js";
import { taskRecordsRepository } from "../repositories/task-records.js";

type Hooks = { beforeEvidencePersist?: () => void; beforeVerificationPersist?: () => void; beforeFinalTransition?: () => void };
type Dependencies = { db: Database.Database; taskId: string; now?: () => string; maxDepth?: number; maxResults?: number; inspect?: typeof inspectWorkspace; hooks?: Hooks };

export function executeInspectWorkspaceTask({ db, taskId, now = () => new Date().toISOString(), maxDepth = 8, maxResults = 500, inspect = inspectWorkspace, hooks = {} }: Dependencies) {
  const projects = projectRepository(db); const tasks = taskRepository(db); const records = taskRecordsRepository(db);
  const task = tasks.getTaskById(taskId);
  if (!task || task.kind !== "inspect_workspace" || task.status !== "queued") throw new Error("Task is not available for workspace inspection");
  const project = projects.getProjectById(task.projectId);
  if (!project) throw new Error("Task project is unavailable");
  const event = (type: Parameters<typeof records.appendEvent>[0]["type"], payload: Record<string, unknown> = {}) => records.appendEvent({ id: randomUUID(), taskId, type, payload, createdAt: now() });
  const plan = inspectWorkspacePlan(taskId);
  records.replacePlan(taskId, plan.map(({ version: _, taskId: __, ...step }) => step));
  event("plan.created", { stepCount: plan.length });
  let activeStepId: string | undefined;
  try {
  const canonicalPath = project.workspacePath;
  console.log("INSPECTING WORKSPACE PATH:", canonicalPath);
  records.upsertDisclosure({ taskId, executionMode: "deterministic-local", provider: "deterministic-local", networkAccess: "disabled", filesystemAccess: "read-only", shellExecution: false, modelInvocation: false, workspaceScope: canonicalPath, estimatedCostUsd: "$0.00", createdAt: now(), updatedAt: now() });
  records.transitionTask(taskId, "running", { id: randomUUID(), createdAt: now(), payload: {} });
  const steps = records.listPlanSteps(taskId);
  const runStep = <T>(stepId: string, action: () => T): T => {
    activeStepId = stepId;
    records.updatePlanStepStatus(stepId, "running", now()); event("step.started", { stepId });
    const value = action(); records.updatePlanStepStatus(stepId, "completed", now()); event("step.completed", { stepId }); activeStepId = undefined; return value;
  };
  const validatedPath = runStep(steps[0]!.id, () => validateWorkspace(canonicalPath).canonicalPath);
  const inspectionStep = steps[1]!;
  activeStepId = inspectionStep.id;
  records.updatePlanStepStatus(inspectionStep.id, "running", now()); event("step.started", { stepId: inspectionStep.id });
  const inspection = inspect(validatedPath, { maxDepth, maxResults });
  for (const entry of inspection.entries) { hooks.beforeEvidencePersist?.(); records.appendEvidence({ id: randomUUID(), taskId, type: "file", path: entry.path, metadata: { type: entry.type, size: entry.size }, createdAt: now() }); }
  event("workspace.inspected", { resultCount: inspection.entries.length, depthTruncated: inspection.truncatedByDepth, countTruncated: inspection.truncatedByCount, inaccessibleEntryCount: inspection.inaccessibleEntryCount });
  event("evidence.persisted", { count: inspection.entries.length });
  records.updatePlanStepStatus(inspectionStep.id, "completed", now()); event("step.completed", { stepId: inspectionStep.id }); activeStepId = undefined;
  const verificationStep = steps[2]!; activeStepId = verificationStep.id;
  records.updatePlanStepStatus(verificationStep.id, "running", now()); event("step.started", { stepId: verificationStep.id });
  const evidence = records.listEvidence(taskId);
  if (evidence.length !== inspection.entries.length || evidence.some((item) => item.path.startsWith("/") || item.path.includes(".."))) throw new Error("Workspace evidence verification failed");
  db.transaction(() => {
    hooks.beforeVerificationPersist?.();
    records.upsertVerification({ taskId, status: "verified", summary: `Inspected ${evidence.length} workspace file(s)`, details: { resultCount: inspection.entries.length, depthTruncated: inspection.truncatedByDepth, countTruncated: inspection.truncatedByCount, inaccessibleEntryCount: inspection.inaccessibleEntryCount }, createdAt: now(), updatedAt: now() });
    event("verification.completed", { evidenceCount: evidence.length });
    records.updatePlanStepStatus(verificationStep.id, "completed", now()); event("step.completed", { stepId: verificationStep.id });
    hooks.beforeFinalTransition?.();
    records.transitionTask(taskId, "verified", { id: randomUUID(), createdAt: now(), payload: {} });
  })();
  activeStepId = undefined;
  return records.getAggregate(taskId);
  } catch (err: any) {
    console.error("Workspace task execution error:", err);
    if (activeStepId) records.updatePlanStepStatus(activeStepId, "failed", now());
    if (tasks.getTaskById(taskId)?.status === "running" || tasks.getTaskById(taskId)?.status === "queued") records.transitionTask(taskId, "failed", { id: randomUUID(), createdAt: now(), payload: { message: err.message || "Workspace task failed" } });
    throw new Error(`Workspace task failed: ${err.message}`);
  }
}
