import {
  ImprovementEvaluationSchema,
  OptimizationSnapshotSchema,
  type ImprovementEvaluation,
  type ImprovementProposalDraft,
  type OptimizationSnapshot,
} from "@morrow/contracts";
import type { ImprovementProposalRepository } from "../repositories/improvement-proposals.js";

type MetricSnapshotKey = keyof Pick<OptimizationSnapshot, "providerAttempts" | "duplicateObservations" | "retries" | "compactions" | "toolSchemaTokens" | "wallClockMs" | "interventionCount" | "costMicros">;

export interface ShadowFixtureEvaluationInput {
  fixtureId: string;
  baseline: OptimizationSnapshot;
  candidate: OptimizationSnapshot;
}

function metricKey(metric: string): MetricSnapshotKey {
  const keys: Record<string, MetricSnapshotKey> = {
    provider_attempts: "providerAttempts",
    retries: "retries",
    compactions: "compactions",
    tool_schema_tokens: "toolSchemaTokens",
    wall_clock_ms: "wallClockMs",
    intervention_count: "interventionCount",
    cost_micros: "costMicros",
    duplicate_observations: "duplicateObservations",
  };
  const key = keys[metric];
  if (!key) throw new Error(`Unsupported improvement metric ${metric}`);
  return key;
}

function firstRegression(candidate: OptimizationSnapshot): string | null {
  if (candidate.outcome !== "passed") return "candidate outcome did not pass";
  if (candidate.privacy !== "passed") return "privacy outcome regressed or is unavailable";
  if (candidate.reliability !== "passed") return "reliability outcome regressed or is unavailable";
  if (candidate.verification !== "passed") return "verification outcome regressed or is unavailable";
  return null;
}

export class ImprovementEvaluator {
  constructor(private readonly repository: ImprovementProposalRepository) {}

  createProposal(input: ImprovementProposalDraft) {
    if (input.evidenceTaskIds.length === 0 || input.benchmarkFixtureIds.length === 0) {
      throw new Error("Improvement proposals require durable task and benchmark fixture evidence");
    }
    return this.repository.create(input);
  }

  evaluateInShadow(proposalId: string, input: ShadowFixtureEvaluationInput): ImprovementEvaluation {
    const proposal = this.repository.get(proposalId);
    if (!proposal) throw new Error(`Unknown improvement proposal ${proposalId}`);
    if (!proposal.benchmarkFixtureIds.includes(input.fixtureId)) {
      throw new Error(`Improvement fixture ${input.fixtureId} is not declared by proposal ${proposalId}`);
    }
    const baseline = OptimizationSnapshotSchema.parse(input.baseline);
    const candidate = OptimizationSnapshotSchema.parse(input.candidate);
    let reason = firstRegression(candidate);
    if (!reason && (baseline.privacy !== "passed" || baseline.reliability !== "passed" || baseline.verification !== "passed")) {
      reason = "baseline privacy, reliability, or verification evidence is incomplete";
    }
    if (!reason) {
      const key = metricKey(proposal.expectedEffect.metric);
      const candidateValue = candidate[key] ?? null;
      const target = proposal.expectedEffect.target;
      if (candidateValue === null || target === null) {
        reason = "required optimization measurement is unavailable";
      } else if (candidateValue > target) {
        reason = `candidate ${proposal.expectedEffect.metric} value ${candidateValue} did not meet target ${target}`;
      } else {
        reason = "candidate met the stated acceptance criterion without privacy, reliability, or verification regression";
      }
    }
    const evaluation = ImprovementEvaluationSchema.parse({
      proposalId,
      proposalVersion: proposal.version,
      mode: "shadow",
      fixtureId: input.fixtureId,
      baseline,
      candidate,
      promotable: reason.startsWith("candidate met"),
      reason,
      evaluatedAt: new Date().toISOString(),
    });
    this.repository.recordEvaluation(proposalId, evaluation);
    return evaluation;
  }

  evaluateShadowFixture(proposalId: string, input: ShadowFixtureEvaluationInput): ImprovementEvaluation {
    return this.evaluateInShadow(proposalId, input);
  }
}
