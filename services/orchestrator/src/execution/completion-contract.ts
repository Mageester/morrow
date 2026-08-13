import {
  canCompleteWithRequirements,
  type ExecutionRequirement,
  type RequirementEvaluation,
} from "./requirements.js";
import { redactSecrets } from "../provider/credentials.js";

export const TASK_SHAPES = [
  "read_only",
  "file_delivery",
  "cli_application",
  "frontend_application",
] as const;

export type TaskShape = typeof TASK_SHAPES[number];

export type CompletionEvidenceKind =
  | "canonical_final_answer"
  | "read_only_observation"
  | "durable_artifact"
  | "independent_verification"
  | "requirements"
  | "frontend_route"
  | "frontend_snapshot"
  | "frontend_console"
  | "frontend_interaction"
  | "frontend_viewports";

export type CompletionBlockerCode =
  | "unknown_task_shape"
  | "missing_canonical_final_answer"
  | "duplicate_canonical_narration"
  | "missing_read_only_observation"
  | "missing_durable_artifact"
  | "artifact_not_independently_observed"
  | "artifact_not_durable"
  | "missing_independent_verification"
  | "failed_final_verification"
  | "requirements_unresolved"
  | "requirement_failed"
  | "requirement_unavailable"
  | "requirement_unevaluated"
  | "frontend_route_missing"
  | "frontend_snapshot_missing"
  | "frontend_console_unclean"
  | "frontend_interaction_missing"
  | "frontend_viewports_incomplete"
  | "frontend_vision_missing"
  | "background_process_running";

export interface CompletionBlocker {
  code: CompletionBlockerCode;
  message: string;
  requirementId?: string;
  evidence?: string[];
}

export interface DurableArtifactEvidence {
  path: string;
  exists: boolean;
  contentHash?: string | null;
  fingerprint?: string | null;
  evidenceRef?: string | null;
  durable?: boolean;
  independentlyObserved?: boolean;
  observedBy?: "filesystem" | "tool" | "mission_ledger" | "model";
}

export interface IndependentVerificationEvidence {
  id?: string;
  command?: { executable: string; args: string[] } | string;
  passed?: boolean;
  exitCode?: number | null;
  completed?: boolean;
  independentlyObserved?: boolean;
  evidenceRef?: string | null;
  final?: boolean;
  failure?: string | null;
}

export interface DurableObservationEvidence {
  id: string;
  kind: string;
  independentlyObserved: boolean;
  durable?: boolean;
  evidenceRef?: string | null;
  ownerTaskId?: string;
  ownerOperationId?: string | null;
  status?: "requested" | "running" | "completed" | "failed" | "cancelled" | "blocked" | "denied";
  errorType?: string | null;
}

export interface CompletionEvidenceLineage {
  taskId: string;
  operationId?: string | null;
  inheritedFrom?: {
    taskId: string;
    operationId?: string | null;
  };
}

export interface FrontendCompletionEvidence {
  routeHealthy?: boolean;
  domSnapshot?: boolean;
  consoleClean?: boolean;
  interaction?: boolean;
  viewports?: readonly string[];
  visionAttached?: boolean;
  visionRequired?: boolean;
}

export interface CompletionRequirementEvidence {
  requirements: readonly ExecutionRequirement[];
  evaluations: readonly RequirementEvaluation[];
}

export interface CompletionInput {
  taskShape?: TaskShape;
  shape?: TaskShape;
  canonicalFinalAnswer?: string | null;
  /** Alias accepted at the boundary for callers with an existing final-answer name. */
  finalAnswer?: string | null;
  priorNarration?: readonly string[];
  durableArtifacts?: readonly DurableArtifactEvidence[];
  /** Alias accepted for persistence adapters that call these artifacts. */
  artifacts?: readonly DurableArtifactEvidence[];
  independentVerifications?: readonly IndependentVerificationEvidence[];
  /** Alias accepted for callers that already normalize verification evidence. */
  verifications?: readonly IndependentVerificationEvidence[];
  durableObservations?: readonly DurableObservationEvidence[];
  readOnlyObservations?: readonly DurableObservationEvidence[];
  lineage?: CompletionEvidenceLineage;
  frontend?: FrontendCompletionEvidence;
  requirements?: CompletionRequirementEvidence;
  executionRequirements?: readonly ExecutionRequirement[];
  requirementEvaluations?: readonly RequirementEvaluation[];
  /** A durable gate result supplied by the agent when the last mutation failed. */
  lastMutationOrVerification?: { passed: boolean; detail?: string } | null;
  stagnation?: { stalled?: boolean; reason?: string; interruptionPending?: boolean };
  /** Task-owned processes that remain live at the completion boundary. */
  runningBackgroundProcesses?: readonly { id: string; command: string }[];
  /** True only when the user's prompt explicitly requires cleanup before completion. */
  requiresBackgroundProcessCleanup?: boolean;
}

export function requiresBackgroundProcessCleanup(prompt: string): boolean {
  return /\b(?:stop|terminate|shut\s+down|close)\b[^.\n]{0,160}\b(?:background\s+process|dev(?:elopment)?\s+server|server)\b[^.\n]{0,160}\b(?:before\s+(?:finishing|completion|completing)|when\s+(?:finished|done))\b/i.test(prompt);
}

export interface CompletionContract {
  readonly taskShape: TaskShape;
  readonly requiredEvidence: readonly CompletionEvidenceKind[];
  readonly requiresArtifact: boolean;
  readonly requiresIndependentVerification: boolean;
  readonly minimumIndependentVerifications: number;
  readonly evaluate: (input: CompletionInput, blockers: CompletionBlocker[]) => void;
}

export interface CompletionResult {
  complete: boolean;
  blockers: CompletionBlocker[];
}

const REQUIRED_VIEWPORTS = ["1440x900", "768x1024", "390x844"] as const;

const blocker = (
  code: CompletionBlockerCode,
  message: string,
  extras: Partial<CompletionBlocker> = {},
): CompletionBlocker => ({ code, message, ...extras });

function hasCanonicalAnswer(input: CompletionInput): boolean {
  const value = input.canonicalFinalAnswer ?? input.finalAnswer;
  if (typeof value !== "string") return false;
  const sanitized = redactSecrets(value).trim();
  // A response made only of a redaction marker contains no visible answer.
  // It must not become canonical merely because the raw provider text was
  // non-empty before the privacy boundary ran.
  return sanitized.length > 0 && !/^[\s"'`]*\*{3}redacted\*{3}[\s"'`.,;:!?]*$/i.test(sanitized);
}

function isPassedVerification(verification: IndependentVerificationEvidence): boolean {
  if (verification.passed === false || verification.completed === false) return false;
  return verification.passed === true || verification.exitCode === 0;
}

function belongsToLineage(observation: DurableObservationEvidence, lineage: CompletionEvidenceLineage | undefined): boolean {
  if (observation.ownerTaskId === undefined && observation.ownerOperationId === undefined) return true;
  if (!lineage) return false;
  const candidates = [lineage, ...(lineage.inheritedFrom ? [lineage.inheritedFrom] : [])];
  return candidates.some((candidate) =>
    (observation.ownerTaskId === undefined || observation.ownerTaskId === candidate.taskId)
    && (observation.ownerOperationId === undefined || observation.ownerOperationId === candidate.operationId),
  );
}

function hasIndependentObservation(observation: DurableObservationEvidence, input: CompletionInput): boolean {
  return observation.independentlyObserved === true
    && observation.durable !== false
    && (observation.status === undefined || observation.status === "completed")
    && !observation.errorType
    && observation.kind !== "narration"
    && belongsToLineage(observation, input.lineage);
}

function hasDurableIndependentArtifact(artifact: DurableArtifactEvidence): boolean {
  if (!artifact.exists) return false;
  const durable = artifact.durable === true
    || Boolean(artifact.contentHash)
    || Boolean(artifact.fingerprint)
    || Boolean(artifact.evidenceRef);
  const independent = artifact.independentlyObserved === true
    || artifact.observedBy === "filesystem"
    || artifact.observedBy === "tool"
    || artifact.observedBy === "mission_ledger";
  return durable && independent;
}

function evaluateFinalVerification(
  verifications: readonly IndependentVerificationEvidence[],
  blockers: CompletionBlocker[],
): void {
  if (verifications.length === 0) return;
  let lastPassed = -1;
  for (let index = 0; index < verifications.length; index++) {
    if (isPassedVerification(verifications[index]!)) lastPassed = index;
  }
  const failed = verifications
    .map((verification, index) => ({ verification, index }))
    .find(({ verification, index }) => !isPassedVerification(verification) && (index > lastPassed || verification.final === true));
  if (failed) {
    blockers.push(blocker(
      "failed_final_verification",
      `The final verification did not pass${failed.verification.failure ? `: ${failed.verification.failure}` : "."}`,
      ...(failed.verification.failure ? [{ evidence: [failed.verification.failure] }] : []),
    ));
  }
}

function evaluateRequirements(input: CompletionInput, blockers: CompletionBlocker[]): void {
  const requirements = input.requirements?.requirements ?? input.executionRequirements ?? [];
  if (requirements.length === 0) return;
  const evaluations = input.requirements?.evaluations ?? input.requirementEvaluations ?? [];
  const byId = new Map(evaluations.map((evaluation) => [evaluation.requirementId, evaluation]));
  if (canCompleteWithRequirements([...requirements], [...evaluations])) return;

  blockers.push(blocker("requirements_unresolved", "One or more authoritative task requirements are not verified or explicitly waived."));
  for (const requirement of requirements) {
    if (!requirement.authoritative) continue;
    const evaluation = byId.get(requirement.id);
    const status = evaluation?.status as string | undefined;
    const code = status === "failed"
      ? "requirement_failed"
      : status === "unavailable"
        ? "requirement_unavailable"
        : "requirement_unevaluated";
    blockers.push(blocker(
      code,
      `Requirement ${requirement.id} is ${status ?? "unevaluated"}.`,
      {
        requirementId: requirement.id,
        ...(evaluation?.evidence ? { evidence: evaluation.evidence } : {}),
      },
    ));
  }
}

function evaluateFrontend(input: CompletionInput, blockers: CompletionBlocker[]): void {
  const frontend = input.frontend ?? {};
  if (frontend.routeHealthy !== true) blockers.push(blocker("frontend_route_missing", "Frontend route health was not independently verified."));
  if (frontend.domSnapshot !== true) blockers.push(blocker("frontend_snapshot_missing", "A durable frontend DOM snapshot is missing."));
  if (frontend.consoleClean !== true) blockers.push(blocker("frontend_console_unclean", "Frontend console or page-error evidence is missing or not clean."));
  if (frontend.interaction !== true) blockers.push(blocker("frontend_interaction_missing", "No relevant frontend interaction was independently verified."));
  const viewports = new Set(frontend.viewports ?? []);
  const missing = REQUIRED_VIEWPORTS.filter((viewport) => !viewports.has(viewport));
  if (missing.length > 0) {
    blockers.push(blocker("frontend_viewports_incomplete", `Frontend viewport evidence is incomplete (${missing.join(", ")}).`, { evidence: missing }));
  }
  if (frontend.visionRequired === true && frontend.visionAttached !== true) {
    blockers.push(blocker("frontend_vision_missing", "The routed model requires verified vision attachment for frontend screenshots."));
  }
}

function evaluateCommon(input: CompletionInput, contract: CompletionContract, blockers: CompletionBlocker[]): void {
  const canonicalAnswer = input.canonicalFinalAnswer ?? input.finalAnswer;
  if (!hasCanonicalAnswer(input)) {
    blockers.push(blocker("missing_canonical_final_answer", "A concise canonical final answer is missing."));
  } else if (typeof canonicalAnswer === "string" && input.priorNarration && input.priorNarration.some((text) => redactSecrets(text).trim().replace(/\s+/g, " ") === redactSecrets(canonicalAnswer).trim().replace(/\s+/g, " "))) {
    blockers.push(blocker("duplicate_canonical_narration", "The proposed canonical answer duplicates earlier intermediate narration."));
  }

  const artifacts = input.durableArtifacts ?? input.artifacts ?? [];
  if (contract.requiresArtifact) {
    if (artifacts.length === 0 || !artifacts.some((artifact) => artifact.exists)) {
      blockers.push(blocker("missing_durable_artifact", "No durable delivered artifact was independently observed."));
    } else if (!artifacts.some(hasDurableIndependentArtifact)) {
      const independent = artifacts.some((artifact) => artifact.independentlyObserved === true || artifact.observedBy === "filesystem" || artifact.observedBy === "tool" || artifact.observedBy === "mission_ledger");
      blockers.push(blocker(independent ? "artifact_not_durable" : "artifact_not_independently_observed", independent
        ? "The delivered artifact has no durable fingerprint or evidence reference."
        : "The delivered artifact is present only as model narration or unverified existence."));
    }
  }

  const verifications = input.independentVerifications ?? input.verifications ?? [];
  const validVerifications = verifications.filter((verification) => verification.independentlyObserved === true && isPassedVerification(verification));
  if (contract.requiresIndependentVerification && validVerifications.length < contract.minimumIndependentVerifications) {
    blockers.push(blocker(
      "missing_independent_verification",
      `Expected at least ${contract.minimumIndependentVerifications} independently observed passing verification${contract.minimumIndependentVerifications === 1 ? "" : "s"}.`,
    ));
  }
  evaluateFinalVerification(verifications, blockers);
  if (input.lastMutationOrVerification && !input.lastMutationOrVerification.passed) {
    blockers.push(blocker("failed_final_verification", `The last mutation or verification failed${input.lastMutationOrVerification.detail ? `: ${input.lastMutationOrVerification.detail}` : "."}`));
  }
  evaluateRequirements(input, blockers);
  if (input.requiresBackgroundProcessCleanup === true && (input.runningBackgroundProcesses?.length ?? 0) > 0) {
    blockers.push(blocker(
      "background_process_running",
      "A task-owned background process is still running even though the request requires it to be stopped before completion.",
      { evidence: input.runningBackgroundProcesses!.map((process) => `${process.id}: ${process.command}`) },
    ));
  }
}

export const TASK_COMPLETION_CONTRACTS: Record<TaskShape, CompletionContract> = {
  read_only: {
    taskShape: "read_only",
    requiredEvidence: ["canonical_final_answer", "read_only_observation", "requirements"],
    requiresArtifact: false,
    requiresIndependentVerification: false,
    minimumIndependentVerifications: 0,
    evaluate(input, blockers) {
      const observations = input.durableObservations ?? input.readOnlyObservations ?? [];
      if (!observations.some((observation) => hasIndependentObservation(observation, input))) {
        blockers.push(blocker("missing_read_only_observation", "No durable independently observed read-only evidence is available."));
      }
    },
  },
  file_delivery: {
    taskShape: "file_delivery",
    requiredEvidence: ["canonical_final_answer", "durable_artifact", "requirements"],
    requiresArtifact: true,
    requiresIndependentVerification: false,
    minimumIndependentVerifications: 0,
    evaluate: () => undefined,
  },
  cli_application: {
    taskShape: "cli_application",
    requiredEvidence: ["canonical_final_answer", "durable_artifact", "independent_verification", "requirements"],
    requiresArtifact: true,
    requiresIndependentVerification: true,
    minimumIndependentVerifications: 1,
    evaluate: () => undefined,
  },
  frontend_application: {
    taskShape: "frontend_application",
    requiredEvidence: [
      "canonical_final_answer",
      "durable_artifact",
      "frontend_route",
      "frontend_snapshot",
      "frontend_console",
      "frontend_interaction",
      "frontend_viewports",
      "requirements",
    ],
    requiresArtifact: true,
    requiresIndependentVerification: false,
    minimumIndependentVerifications: 0,
    evaluate: evaluateFrontend,
  },
};

export function inferTaskShape(prompt: string, mode: "agent" | "ask" | "plan-only" | "read-only" = "agent"): TaskShape {
  if (mode !== "agent") return "read_only";
  const frontendIntent = /\b(?:frontend|front[- ]?end|web\s*app|website|landing\s+page|user\s+interface|responsive|react|next\.js|vue|svelte|css|html\s+page|dashboard\s+ui)\b/i.test(prompt);
  const cliIntent = /\b(?:cli|command[- ]line|terminal\s+app|console\s+app|executable|shell\s+app)\b/i.test(prompt);
  const deliveryIntent = /\b(?:fix|repair|patch|implement|refactor|build|develop|create|write|edit|modify|change|update|deliver|ship|save)\b/i.test(prompt);
  // Explicit delivery/application intent outranks review or inspection
  // wording. A request to "review and fix" is still a delivery contract.
  if (frontendIntent) return "frontend_application";
  if (cliIntent) return "cli_application";
  if (deliveryIntent) return "file_delivery";
  if (/\b(?:read[- ]?only|inspect|analy[sz]e|review|diagnos(?:e|is)|without\s+(?:changing|modifying|editing))\b/i.test(prompt)) return "read_only";
  return "read_only";
}

/**
 * Preserve the task brief when the user sends a short imperative continuation
 * such as "start building" or "continue". Treating that sentence as an
 * independent request discards the artifact type, constraints, and validation
 * requirements declared immediately before it. Self-contained follow-ups and
 * explicit read-only requests remain independent.
 */
export function resolveTaskIntentPrompt(latestPrompt: string, priorUserPrompts: readonly string[]): string {
  const latest = latestPrompt.trim();
  if (!latest || latest.length > 320) return latestPrompt;
  if (/\b(?:do not|don't|without)\s+(?:change|changing|modify|modifying|edit|editing|write|writing)\b/i.test(latest)) return latestPrompt;
  const isContinuation = /\b(?:continue|resume|carry on|keep going|proceed|go ahead|do it|try again|finish(?: it| this)?|start (?:building|coding|working)|get started|make it happen)\b/i.test(latest);
  if (!isContinuation) return latestPrompt;
  const prior = [...priorUserPrompts]
    .reverse()
    .map((prompt) => prompt.trim())
    .find((prompt) => prompt.length >= 40);
  if (!prior) return latestPrompt;
  return `${prior}\n\nCurrent follow-up: ${latest}`;
}

export function evaluateTaskCompletion(input: CompletionInput): CompletionResult {
  const taskShape = input.taskShape ?? input.shape;
  if (!taskShape || !TASK_COMPLETION_CONTRACTS[taskShape]) {
    return { complete: false, blockers: [blocker("unknown_task_shape", "The task shape is not declared in the completion contract registry.")] };
  }
  const contract = TASK_COMPLETION_CONTRACTS[taskShape];
  const blockers: CompletionBlocker[] = [];
  evaluateCommon(input, contract, blockers);
  contract.evaluate(input, blockers);
  return { complete: blockers.length === 0, blockers };
}
