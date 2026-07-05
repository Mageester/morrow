import { randomUUID } from "node:crypto";
import type { Mission, MissionLearning, IntelligenceSource } from "@morrow/contracts";

/**
 * Extract concise, structured learnings from a finished mission.
 *
 * Runs AFTER evidence collection and independent review so that unsupported
 * agent claims never become project memory: every learning cites the evidence
 * or failure records that back it, and anything without support is simply not
 * extracted. Deterministic — derives only from the mission ledger.
 */

const MAX_LEARNINGS_PER_MISSION = 12;

export function extractMissionLearnings(mission: Mission, now: () => string = () => new Date().toISOString()): MissionLearning[] {
  const learnings: MissionLearning[] = [];
  const timestamp = now();
  const add = (l: Omit<MissionLearning, "id" | "missionId" | "freshness" | "createdAt">) => {
    if (learnings.length >= MAX_LEARNINGS_PER_MISSION) return;
    // Deduplicate identical statements within one mission.
    if (learnings.some((x) => x.statement === l.statement)) return;
    learnings.push({ ...l, id: `learn-${randomUUID()}`, missionId: mission.id, freshness: "current", createdAt: timestamp });
  };
  const missionSource = (note: string): IntelligenceSource => ({ kind: "mission", reference: mission.id, note });

  // 1. Commands that actually validated work (evidence: passed command runs).
  const passedCommands = mission.evidence.filter((e) => e.status === "passed" && e.command && e.exitCode === 0);
  for (const e of passedCommands.slice(0, 4)) {
    add({
      statement: `\`${e.command}\` verifies: ${e.summary.slice(0, 200)}`,
      type: "validation_command",
      confidence: 0.85,
      sources: [{ kind: "command", reference: e.command!, note: `evidence ${e.id}: exit 0` }],
      scope: ".",
      stalenessCondition: "The referenced script or test configuration changes.",
      affectsPlanning: true,
    });
  }

  // 2. Failed approaches: signature buckets that were never recovered.
  const bySignature = new Map<string, typeof mission.failures>();
  for (const f of mission.failures) {
    const bucket = bySignature.get(f.normalizedSignature) ?? [];
    bucket.push(f);
    bySignature.set(f.normalizedSignature, bucket);
  }
  for (const [, bucket] of bySignature) {
    const attempts = Math.max(...bucket.map((f) => f.attempt));
    const last = bucket[bucket.length - 1]!;
    const recovered = bucket.some((f) => f.recovered);
    if (!recovered && attempts >= 2) {
      add({
        statement: `Approach failed ${attempts}× and was never recovered: ${last.operation.slice(0, 160)} (${last.category}).`,
        type: "failed_approach",
        confidence: Math.min(0.95, 0.5 + attempts * 0.15),
        sources: bucket.slice(0, 3).map((f) => missionSource(`failure ${f.id}: ${f.message.slice(0, 120)}`)),
        scope: ".",
        stalenessCondition: "The implicated files or tooling change materially.",
        affectsPlanning: true,
      });
    } else if (recovered && attempts >= 2) {
      const strategy = bucket.find((f) => f.recovered)?.recoveryStrategy ?? "retry";
      add({
        statement: `Recovery strategy "${strategy}" resolved repeated ${last.category} on: ${last.operation.slice(0, 140)}.`,
        type: "recovery_strategy",
        confidence: 0.7,
        sources: bucket.slice(0, 3).map((f) => missionSource(`failure ${f.id}`)),
        scope: ".",
        stalenessCondition: null,
        affectsPlanning: true,
      });
    }
  }

  // 3. Criteria that failed verification despite execution: false assumptions.
  const failedCriteria = mission.criteria.filter((c) => c.state === "failed" && c.failureReason);
  for (const c of failedCriteria.slice(0, 3)) {
    const evidence = mission.evidence.filter((e) => e.criterionIds.includes(c.id));
    if (evidence.length === 0) continue; // no evidence → no learning, ever
    add({
      statement: `Criterion "${c.description.slice(0, 160)}" failed verification: ${c.failureReason!.slice(0, 160)}`,
      type: "false_assumption",
      confidence: 0.75,
      sources: evidence.slice(0, 3).map((e) => missionSource(`evidence ${e.id}: ${e.status}`)),
      scope: ".",
      stalenessCondition: "The underlying defect is fixed.",
      affectsPlanning: true,
    });
  }

  return learnings;
}
