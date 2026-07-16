import type {
  ApprovalStatus,
  MissionCriterionState,
  MissionEvidenceStatus,
  MissionOperationStatus,
  MissionReviewVerdict,
  RequirementNodeStatus,
  TaskStatus,
} from "@morrow/contracts";

export type GuardianItemKind =
  | "criterion"
  | "requirement"
  | "evidence"
  | "operation"
  | "task"
  | "approval"
  | "canonical_answer"
  | "review"
  | "validation"
  | "diff"
  | "protected_path";

export interface GuardianItem {
  kind: GuardianItemKind;
  id: string;
  criterionId?: string;
  detail: string;
}

export interface GuardianInput {
  missionId: string;
  criteria: Array<{ id: string; state: MissionCriterionState; evidenceIds: string[] }>;
  requirements: Array<{
    id: string;
    authoritative: boolean;
    status: RequirementNodeStatus;
    evidenceRefs: string[];
  }>;
  evidence: Array<{ id: string; criterionIds: string[]; status: MissionEvidenceStatus }>;
  operations: Array<{ id: string; status: MissionOperationStatus; effectEvidenceIds: string[] }>;
  tasks: Array<{ id: string; status: TaskStatus }>;
  approvals: Array<{ id: string; status: ApprovalStatus }>;
  canonicalAnswer: {
    required: boolean;
    present: boolean;
    durableEvidenceValid: boolean;
    verificationPassed: boolean;
    unresolvedBlocker: string | null;
    unresolvedFailures: string[];
  };
  reviewVerdict: MissionReviewVerdict | null;
  requiredValidationKinds: string[];
  completedValidationKinds: string[];
  changedFiles: string[];
  diffChecked: boolean;
  protectedPathViolations: string[];
}

export interface GuardianDecision {
  passed: boolean;
  missing: GuardianItem[];
  failed: GuardianItem[];
  blocked: GuardianItem[];
  nextActions: string[];
  evidenceSnapshot: {
    missionId: string;
    criteria: { total: number; satisfied: number };
    requirements: { authoritative: number; satisfied: number };
    evidence: { passed: number; failed: number; inconclusive: number };
    operations: { resolved: number; unresolved: number };
    tasks: { resolved: number; unresolved: number };
    approvals: { resolved: number; unresolved: number };
    validation: { required: string[]; completed: string[] };
    changedFiles: string[];
  };
}

export function evaluateGuardian(input: GuardianInput): GuardianDecision {
  const missing: GuardianItem[] = [];
  const failed: GuardianItem[] = [];
  const blocked: GuardianItem[] = [];
  const nextActions = new Set<string>();
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));

  for (const criterion of input.criteria) {
    if (criterion.state === "failed") {
      failed.push({ kind: "criterion", id: criterion.id, criterionId: criterion.id, detail: "Criterion failed verification." });
      nextActions.add("repair_failed_criteria");
      continue;
    }
    if (criterion.state === "waived") continue;
    const hasDirectPassedEvidence = criterion.evidenceIds.some((id) => {
      const evidence = evidenceById.get(id);
      return evidence?.status === "passed" && evidence.criterionIds.includes(criterion.id);
    });
    if (criterion.state !== "verified" || !hasDirectPassedEvidence) {
      missing.push({ kind: "criterion", id: criterion.id, criterionId: criterion.id, detail: "Criterion lacks direct passed evidence." });
      nextActions.add("validate_criteria");
    }
  }

  const authoritative = input.requirements.filter((item) => item.authoritative);
  for (const requirement of authoritative) {
    if (requirement.status === "failed") {
      failed.push({ kind: "requirement", id: requirement.id, detail: "Authoritative requirement failed." });
      nextActions.add("repair_failed_requirements");
      continue;
    }
    if (requirement.status === "waived") continue;
    const hasEvidence = requirement.evidenceRefs.some((id) => evidenceById.get(id)?.status === "passed");
    if (requirement.status !== "verified" || !hasEvidence) {
      missing.push({ kind: "requirement", id: requirement.id, detail: "Authoritative requirement lacks passed evidence." });
      nextActions.add("validate_requirements");
    }
  }

  for (const operation of input.operations) {
    if (operation.status === "completed") continue;
    if (operation.status === "failed" || operation.status === "cancelled") {
      failed.push({ kind: "operation", id: operation.id, detail: `Operation ended ${operation.status}.` });
      nextActions.add("recover_failed_operations");
    } else {
      blocked.push({ kind: "operation", id: operation.id, detail: `Operation is ${operation.status}.` });
      nextActions.add("reconcile_operations");
    }
  }

  for (const task of input.tasks) {
    if (task.status === "completed" || task.status === "verified") continue;
    if (task.status === "failed" || task.status === "cancelled") {
      failed.push({ kind: "task", id: task.id, detail: `Worker ended ${task.status}.` });
      nextActions.add("recover_failed_workers");
    } else {
      blocked.push({ kind: "task", id: task.id, detail: `Worker is ${task.status}.` });
      nextActions.add("wait_for_workers");
    }
  }

  for (const approval of input.approvals) {
    if (approval.status === "approved") continue;
    if (approval.status === "pending") {
      blocked.push({ kind: "approval", id: approval.id, detail: "Approval is pending." });
      nextActions.add("resolve_approvals");
    } else {
      failed.push({ kind: "approval", id: approval.id, detail: `Approval ended ${approval.status}.` });
      nextActions.add("replan_after_denial");
    }
  }

  const canonical = input.canonicalAnswer;
  if (canonical.required && (
    !canonical.present
    || !canonical.durableEvidenceValid
    || !canonical.verificationPassed
    || canonical.unresolvedBlocker !== null
    || canonical.unresolvedFailures.length > 0
  )) {
    blocked.push({ kind: "canonical_answer", id: input.missionId, detail: "Canonical answer is absent, unverified, or still blocked." });
    nextActions.add("repair_canonical_answer");
  }

  if (input.reviewVerdict !== "approved") {
    if (input.reviewVerdict === "revisions_required") {
      failed.push({ kind: "review", id: input.missionId, detail: "Independent review requires revisions." });
      nextActions.add("apply_review_revisions");
    } else {
      missing.push({ kind: "review", id: input.missionId, detail: "Independent approval is missing." });
      nextActions.add("run_independent_review");
    }
  }

  const completedValidation = new Set(input.completedValidationKinds);
  for (const kind of input.requiredValidationKinds) {
    if (!completedValidation.has(kind)) {
      missing.push({ kind: "validation", id: kind, detail: `Required validation ${kind} has not passed.` });
      nextActions.add("run_required_validation");
    }
  }

  if (input.changedFiles.length > 0 && !input.diffChecked) {
    missing.push({ kind: "diff", id: input.missionId, detail: "Changed files have not passed a final diff review." });
    nextActions.add("review_final_diff");
  }
  for (const path of input.protectedPathViolations) {
    failed.push({ kind: "protected_path", id: path, detail: `Protected path was modified: ${path}.` });
    nextActions.add("repair_protected_paths");
  }

  const criteriaSatisfied = input.criteria.filter((item) => item.state === "waived" || (
    item.state === "verified"
    && item.evidenceIds.some((id) => evidenceById.get(id)?.status === "passed")
  )).length;
  const requirementsSatisfied = authoritative.filter((item) => item.status === "waived" || (
    item.status === "verified"
    && item.evidenceRefs.some((id) => evidenceById.get(id)?.status === "passed")
  )).length;
  const resolvedOperations = input.operations.filter((item) => item.status === "completed").length;
  const resolvedTasks = input.tasks.filter((item) => item.status === "completed" || item.status === "verified").length;
  const resolvedApprovals = input.approvals.filter((item) => item.status === "approved").length;

  return {
    passed: missing.length === 0 && failed.length === 0 && blocked.length === 0,
    missing,
    failed,
    blocked,
    nextActions: [...nextActions],
    evidenceSnapshot: {
      missionId: input.missionId,
      criteria: { total: input.criteria.length, satisfied: criteriaSatisfied },
      requirements: { authoritative: authoritative.length, satisfied: requirementsSatisfied },
      evidence: {
        passed: input.evidence.filter((item) => item.status === "passed").length,
        failed: input.evidence.filter((item) => item.status === "failed").length,
        inconclusive: input.evidence.filter((item) => item.status === "inconclusive").length,
      },
      operations: { resolved: resolvedOperations, unresolved: input.operations.length - resolvedOperations },
      tasks: { resolved: resolvedTasks, unresolved: input.tasks.length - resolvedTasks },
      approvals: { resolved: resolvedApprovals, unresolved: input.approvals.length - resolvedApprovals },
      validation: { required: [...input.requiredValidationKinds], completed: [...input.completedValidationKinds] },
      changedFiles: [...input.changedFiles],
    },
  };
}
