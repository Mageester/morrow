import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  SkillDraftSchema,
  type SkillDraft,
  type SkillDraftPermissions,
} from "@morrow/contracts";
import { taskRecordsRepository } from "../repositories/task-records.js";
import { taskRepository } from "../repositories/tasks.js";
import { validateSkillDraftSafety } from "./skill-safety.js";

export type BuildSkillDraftOptions = {
  db: Database.Database;
  taskId: string;
  now?: () => string;
};

function cleanTarget(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const target = value.trim();
  if (!target || target.length > 2048 || /[\r\n]/.test(target)) return null;
  if (/ignore|system prompt|provider narration|page instruction|bearer\s+/i.test(target)) return null;
  return target;
}

function payloadText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stableFingerprint(parts: string[]): string {
  return createHash("sha256").update(parts.slice().sort().join("\n")).digest("hex");
}

function permissionsFor(task: ReturnType<ReturnType<typeof taskRepository>["getTaskById"]>, tools: string[], events: Array<{ payload: Record<string, unknown> }>): SkillDraftPermissions {
  const domains = events.flatMap(({ payload }) => {
    const value = payload.networkDomain ?? payload.domain;
    return typeof value === "string" && value.trim() ? [value.trim()] : [];
  });
  return {
    tools: [...new Set(tools)].sort(),
    filesystemScopes: task?.kind === "agent_chat" ? ["workspace"] : ["workspace"],
    networkDomains: [...new Set(domains)].sort(),
    requiredSecrets: [],
  };
}

/**
 * Build only from persisted verification/evidence/tool records. Provider
 * narration, assistant text, and page content are intentionally ignored.
 */
export function buildSkillDraft(options: BuildSkillDraftOptions): SkillDraft {
  const now = options.now ?? (() => new Date().toISOString());
  const tasks = taskRepository(options.db);
  const records = taskRecordsRepository(options.db);
  const task = tasks.getTaskById(options.taskId);
  if (!task) throw new Error("Task not found");
  if (task.status !== "verified") throw new Error("Only verified tasks can create a skill draft");
  const verification = records.getVerification(options.taskId);
  if (!verification || verification.status !== "verified") throw new Error("Verified task evidence is required");
  const evidence = records.listEvidence(options.taskId);
  if (evidence.length === 0) throw new Error("Durable task evidence is required");

  const events = records.listEvents(options.taskId);
  const completed = events.filter((event) => {
    if (event.type !== "tool.completed") return false;
    const success = event.payload.success ?? event.payload.ok ?? event.payload.passed;
    return success !== false && event.payload.error === undefined && event.payload.failure === undefined;
  });
  if (completed.length === 0) throw new Error("A verified task must contain successful durable tool evidence");

  const steps = completed.map((event, index) => {
    const tool = payloadText(event.payload.toolName ?? event.payload.name);
    if (!tool) throw new Error("A durable tool completion is missing its tool name");
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(tool)) throw new Error("A durable tool completion has an unsafe tool name");
    const target = cleanTarget(event.payload.path ?? event.payload.target ?? event.payload.file);
    const description = target ? `Use ${tool} on the bounded target ${target}.` : `Use the verified ${tool} operation.`;
    return { id: `step-${index + 1}`, position: index + 1, tool, description, target };
  });
  const permissions = permissionsFor(task, steps.map((step) => step.tool), completed);
  const evidencePaths = evidence.map((item) => item.path).filter((path) => path.length > 0);
  const sourceEventIds = completed.map((event) => event.id);
  const fingerprint = stableFingerprint([
    task.projectId, task.kind, ...sourceEventIds, ...evidencePaths,
    ...steps.map((step) => `${step.tool}:${step.target ?? ""}`),
  ]);
  const timestamp = now();
  const candidate: SkillDraft = {
    version: 1,
    id: `skill-draft-${fingerprint.slice(0, 16)}`,
    projectId: task.projectId,
    sourceTaskId: task.id,
    name: `Verified ${steps.map((step) => step.tool).slice(0, 2).join(" + ")} workflow`,
    description: "A reusable workflow derived from durable successful tool outcomes.",
    triggerDescription: "Use when a future task requests the same verified workflow and bounded targets.",
    inputs: ["task request", "bounded workspace target"],
    outputs: ["verified task outcome", "durable evidence"],
    steps,
    permissions,
    creatorPermissions: permissions,
    provenance: [{
      taskId: task.id,
      projectId: task.projectId,
      evidenceReferences: [
        { kind: "mission", reference: task.id, note: "Verified task outcome" },
        ...evidence.map((item) => ({ kind: "file" as const, reference: item.path, note: "Durable task evidence" })),
      ],
      sourceEventIds,
      sourceFingerprint: fingerprint,
      verifiedAt: verification.updatedAt,
    }],
    replayFixtures: [{
      id: `fixture-${fingerprint.slice(0, 12)}`,
      name: "Durable verified task fixture",
      inputs: { taskKind: task.kind, projectId: task.projectId },
      expectedOutputs: ["verified task outcome"],
      expectedFiles: evidencePaths,
      expectedEvidence: sourceEventIds,
    }],
    validation: {
      safety: { status: "pending", issues: [], warnings: [], checkedAt: timestamp },
      replay: { requiredSuccesses: 2, successfulRuns: 0, failedRuns: 0, results: [] },
    },
    lifecycle: "draft",
    workflowFingerprint: fingerprint,
    directory: null,
    rollbackHistory: [],
    warning: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    approvedAt: null,
    activatedAt: null,
  };
  const safety = validateSkillDraftSafety(candidate, { creatorPermissions: permissions, now });
  return SkillDraftSchema.parse({
    ...candidate,
    validation: {
      ...candidate.validation,
      safety: { status: safety.status, issues: safety.issues, warnings: safety.warnings, checkedAt: safety.checkedAt },
    },
  });
}

export const buildSkillDraftFromTask = buildSkillDraft;
