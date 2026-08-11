import { z } from "zod";
import { CostAccuracySchema } from "./cost.js";

const safeInteger = (name: string) => z.number().int().nonnegative().refine(Number.isSafeInteger, {
  message: `${name} must be a safe integer`,
});

const optionalNullableSafeInteger = (name: string) => safeInteger(name).nullable().optional().default(null);

export const ImprovementMetricSchema = z.enum([
  "provider_attempts",
  "duplicate_observations",
  "retries",
  "compactions",
  "tool_schema_tokens",
  "wall_clock_ms",
  "intervention_count",
  "cost_micros",
]);
export type ImprovementMetric = z.infer<typeof ImprovementMetricSchema>;

export const OptimizationMetricsSchema = z.object({
  providerAttempts: optionalNullableSafeInteger("providerAttempts"),
  duplicateObservations: optionalNullableSafeInteger("duplicateObservations"),
  retries: optionalNullableSafeInteger("retries"),
  compactions: optionalNullableSafeInteger("compactions"),
  toolSchemaTokens: optionalNullableSafeInteger("toolSchemaTokens"),
  wallClockMs: optionalNullableSafeInteger("wallClockMs"),
  interventionCount: optionalNullableSafeInteger("interventionCount"),
  costMicros: optionalNullableSafeInteger("costMicros"),
  costAccuracy: CostAccuracySchema,
  privacyOutcome: z.enum(["passed", "regressed", "unknown"]),
  reliabilityOutcome: z.enum(["passed", "regressed", "unknown"]),
  verificationOutcome: z.enum(["passed", "regressed", "unknown"]),
}).strict();
export type OptimizationMetrics = z.infer<typeof OptimizationMetricsSchema>;

export const ImprovementChangeSchema = z.object({
  kind: z.enum(["tool-profile", "budget-policy", "routing-policy"]),
  description: z.string().min(1),
  profile: z.string().min(1).optional(),
}).strict();
export type ImprovementChange = z.infer<typeof ImprovementChangeSchema>;

export const ImprovementExpectedEffectSchema = z.object({
  metric: ImprovementMetricSchema,
  baseline: z.number().finite().nullable(),
  target: z.number().finite().nullable(),
  acceptanceCriterion: z.string().min(1),
}).strict();
export type ImprovementExpectedEffect = z.infer<typeof ImprovementExpectedEffectSchema>;

export const ImprovementPrivacyImpactSchema = z.object({
  summary: z.string().min(1),
  networkAccess: z.enum(["unchanged", "expanded", "reduced", "unknown"]),
  permissionChange: z.enum(["none", "expanded", "reduced", "unknown"]),
}).strict();
export type ImprovementPrivacyImpact = z.infer<typeof ImprovementPrivacyImpactSchema>;

export const OptimizationSnapshotSchema = z.object({
  outcome: z.enum(["passed", "failed", "unknown"]),
  privacy: z.enum(["passed", "regressed", "unknown"]),
  reliability: z.enum(["passed", "regressed", "unknown"]),
  verification: z.enum(["passed", "regressed", "unknown"]),
  toolSchemaTokens: z.number().int().nonnegative().nullable(),
  providerAttempts: z.number().int().nonnegative().nullable().optional(),
  duplicateObservations: z.number().int().nonnegative().nullable().optional(),
  retries: z.number().int().nonnegative().nullable().optional(),
  compactions: z.number().int().nonnegative().nullable().optional(),
  wallClockMs: z.number().int().nonnegative().nullable().optional(),
  interventionCount: z.number().int().nonnegative().nullable().optional(),
  costMicros: z.number().int().nonnegative().nullable().optional(),
}).strict();
export type OptimizationSnapshot = z.infer<typeof OptimizationSnapshotSchema>;

export const ImprovementEvaluationSchema = z.object({
  proposalId: z.string(),
  proposalVersion: z.number().int().positive(),
  mode: z.literal("shadow"),
  fixtureId: z.string(),
  baseline: OptimizationSnapshotSchema,
  candidate: OptimizationSnapshotSchema,
  promotable: z.boolean(),
  reason: z.string().min(1),
  evaluatedAt: z.string().datetime(),
}).strict();
export type ImprovementEvaluation = z.infer<typeof ImprovementEvaluationSchema>;

export const ImprovementRolloutStateSchema = z.enum(["proposed", "evaluated", "approved", "rejected", "rolled_back"]);
export type ImprovementRolloutState = z.infer<typeof ImprovementRolloutStateSchema>;

export const ImprovementProposalSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  observedProblem: z.string().min(1),
  proposedChange: ImprovementChangeSchema,
  evidenceTaskIds: z.array(z.string().min(1)).min(1),
  benchmarkFixtureIds: z.array(z.string().min(1)).min(1),
  expectedEffect: ImprovementExpectedEffectSchema,
  privacyImpact: ImprovementPrivacyImpactSchema,
  rolloutState: ImprovementRolloutStateSchema,
  rollbackReference: z.string().min(1).nullable(),
  evaluation: ImprovementEvaluationSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type ImprovementProposal = z.infer<typeof ImprovementProposalSchema>;

export type ImprovementProposalDraft = Omit<ImprovementProposal, "id" | "version" | "rolloutState" | "rollbackReference" | "evaluation" | "createdAt" | "updatedAt">;
