import { z } from "zod";

export const MissionRuntimeStateSchema = z.enum([
  "created",
  "orienting",
  "planning",
  "executing",
  "validating",
  "waiting_for_tool",
  "waiting_for_approval",
  "recovering",
  "replanning",
  "blocked",
  "completed",
  "cancelled",
  "abandoned",
  "superseded",
]);
export type MissionRuntimeState = z.infer<typeof MissionRuntimeStateSchema>;

export const MISSION_RUNTIME_TERMINAL_STATES = [
  "blocked",
  "completed",
  "cancelled",
  "abandoned",
  "superseded",
] as const satisfies readonly MissionRuntimeState[];

export const MissionRuntimeFinalDispositionSchema = z.enum(MISSION_RUNTIME_TERMINAL_STATES);
export type MissionRuntimeFinalDisposition = z.infer<typeof MissionRuntimeFinalDispositionSchema>;

export const MissionRuntimeSchema = z.object({
  version: z.literal(1),
  missionId: z.string().min(1),
  state: MissionRuntimeStateSchema,
  finalDisposition: MissionRuntimeFinalDispositionSchema.nullable(),
  activeOperationId: z.string().min(1).nullable(),
  activeTaskId: z.string().min(1).nullable(),
  wakeReason: z.string().min(1).nullable(),
  transitionSequence: z.number().int().nonnegative(),
  operationSequence: z.number().int().nonnegative(),
  leaseOwner: z.string().min(1).nullable(),
  leaseGeneration: z.number().int().nonnegative(),
  leaseExpiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type MissionRuntime = z.infer<typeof MissionRuntimeSchema>;

export const MissionRuntimeTransitionActorSchema = z.enum([
  "controller",
  "worker",
  "guardian",
  "user",
  "system",
]);
export type MissionRuntimeTransitionActor = z.infer<typeof MissionRuntimeTransitionActorSchema>;

export const MissionRuntimeTransitionSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  missionId: z.string().min(1),
  sequence: z.number().int().positive(),
  from: MissionRuntimeStateSchema,
  to: MissionRuntimeStateSchema,
  cause: z.string().min(1),
  actor: MissionRuntimeTransitionActorSchema,
  details: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
}).strict();
export type MissionRuntimeTransition = z.infer<typeof MissionRuntimeTransitionSchema>;

export const MissionOperationKindSchema = z.enum([
  "orient",
  "plan",
  "dispatch_worker",
  "wait_for_tool",
  "wait_for_approval",
  "validate_criteria",
  "guardian_review",
  "recover",
  "cancel_worker",
]);
export type MissionOperationKind = z.infer<typeof MissionOperationKindSchema>;

export const MissionOperationStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "unknown_effect",
  "cancelled",
]);
export type MissionOperationStatus = z.infer<typeof MissionOperationStatusSchema>;

export const MissionOperationSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  missionId: z.string().min(1),
  sequence: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
  kind: MissionOperationKindSchema,
  status: MissionOperationStatusSchema,
  strategyFingerprint: z.string().min(1).nullable(),
  input: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).nullable(),
  effectEvidenceIds: z.array(z.string().min(1)),
  attempt: z.number().int().nonnegative(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type MissionOperation = z.infer<typeof MissionOperationSchema>;

export const MissionProgressKindSchema = z.enum([
  "artifact_changed",
  "tool_result_observed",
  "evidence_gained",
  "uncertainty_reduced",
  "hypothesis_eliminated",
  "strategy_changed",
  "checkpoint_created",
  "criterion_validated",
]);
export type MissionProgressKind = z.infer<typeof MissionProgressKindSchema>;

export const MissionProgressObservationSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  missionId: z.string().min(1),
  operationId: z.string().min(1).nullable(),
  kind: MissionProgressKindSchema,
  summary: z.string().trim().min(1),
  evidenceIds: z.array(z.string().min(1)),
  strategyFingerprint: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
}).strict();
export type MissionProgressObservation = z.infer<typeof MissionProgressObservationSchema>;

export const MissionRecoveryCategorySchema = z.enum([
  "provider_failure",
  "model_unavailable",
  "rate_limit",
  "network_failure",
  "context_exhaustion",
  "tool_failure",
  "invalid_tool_arguments",
  "verification_failure",
  "permission_denied",
  "approval_required",
  "repeated_strategy",
  "unknown_effect",
  "process_interruption",
]);
export type MissionRecoveryCategory = z.infer<typeof MissionRecoveryCategorySchema>;

export const MissionRecoveryActionSchema = z.enum([
  "retry_same_provider",
  "switch_model",
  "switch_provider",
  "compact_context",
  "repair_tool_arguments",
  "change_tool",
  "focused_diagnosis",
  "replan",
  "await_approval",
  "await_retry_condition",
  "verify_effect",
  "restore_checkpoint",
  "block_precisely",
]);
export type MissionRecoveryAction = z.infer<typeof MissionRecoveryActionSchema>;

export const MissionRecoveryDecisionSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  missionId: z.string().min(1),
  operationId: z.string().min(1).nullable(),
  category: MissionRecoveryCategorySchema,
  diagnosis: z.string().trim().min(1),
  failedStrategyFingerprint: z.string().min(1).nullable(),
  nextStrategyFingerprint: z.string().min(1).nullable(),
  action: MissionRecoveryActionSchema,
  retryCondition: z.string().trim().min(1).nullable(),
  exhausted: z.boolean(),
  createdAt: z.string().datetime(),
}).strict().superRefine((decision, context) => {
  if (
    decision.failedStrategyFingerprint !== null
    && decision.failedStrategyFingerprint === decision.nextStrategyFingerprint
  ) {
    context.addIssue({
      code: "custom",
      path: ["nextStrategyFingerprint"],
      message: "A recovery decision must select a distinct strategy",
    });
  }
});
export type MissionRecoveryDecision = z.infer<typeof MissionRecoveryDecisionSchema>;
