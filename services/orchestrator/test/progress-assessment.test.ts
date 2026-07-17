import { describe, expect, it } from "vitest";
import type { MissionProgressKind, MissionProgressObservation } from "@morrow/contracts";
import {
  assessExhaustion,
  assessProgress,
  type MissionProgressSnapshot,
} from "../src/execution/progress.js";

const now = "2026-07-16T12:00:00.000Z";

function snapshot(overrides: Partial<MissionProgressSnapshot> = {}): MissionProgressSnapshot {
  return {
    missionId: "mission-1",
    operationId: "operation-1",
    strategyFingerprint: "strategy:primary",
    artifactFingerprints: [],
    toolResultFingerprints: [],
    evidenceIds: [],
    uncertainty: 1,
    openHypotheses: [],
    checkpointIds: [],
    validatedCriterionIds: [],
    observedAt: now,
    ...overrides,
  };
}

function observation(
  kind: MissionProgressKind,
  strategyFingerprint = "strategy:primary",
): MissionProgressObservation {
  return {
    version: 1,
    id: `progress-${kind}`,
    missionId: "mission-1",
    operationId: "operation-1",
    kind,
    summary: kind,
    evidenceIds: [],
    strategyFingerprint,
    createdAt: now,
  };
}

describe("evidence-aware progress assessment", () => {
  it("detects legitimate investigation and verification deltas", () => {
    const previous = snapshot({
      uncertainty: 3,
      openHypotheses: ["auth", "network"],
    });
    const current = snapshot({
      strategyFingerprint: "strategy:fallback",
      evidenceIds: ["evidence-1"],
      uncertainty: 2,
      openHypotheses: ["network"],
      checkpointIds: ["checkpoint-1"],
      validatedCriterionIds: ["criterion-1"],
    });

    expect(assessProgress(previous, current).map((item) => item.kind)).toEqual([
      "evidence_gained",
      "uncertainty_reduced",
      "hypothesis_eliminated",
      "strategy_changed",
      "checkpoint_created",
      "criterion_validated",
    ]);
  });

  it.each([
    "evidence_gained",
    "uncertainty_reduced",
    "hypothesis_eliminated",
    "strategy_changed",
    "checkpoint_created",
    "criterion_validated",
  ] as const)("%s prevents stagnation", (kind) => {
    expect(assessExhaustion([observation(kind)])).toMatchObject({
      exhausted: false,
      next: "continue",
    });
  });

  it("requires focused diagnosis before declaring repeated work exhausted", () => {
    const history = [
      observation("tool_result_observed"),
      observation("tool_result_observed"),
      observation("tool_result_observed"),
    ];
    expect(assessExhaustion(history)).toMatchObject({
      exhausted: false,
      next: "focused_diagnosis",
    });
  });

  it("exhausts only after diagnosis and all supplied distinct strategies were tried", () => {
    const history = [
      observation("tool_result_observed", "strategy:primary"),
      observation("strategy_changed", "strategy:fallback"),
      observation("tool_result_observed", "strategy:fallback"),
    ];
    expect(assessExhaustion(history, {
      diagnosisCompleted: true,
      availableStrategyFingerprints: ["strategy:primary", "strategy:fallback"],
    })).toMatchObject({
      exhausted: true,
      next: "block_precisely",
    });
  });
});

describe("stagnation-aware exhaustion", () => {
  // The live bug: once any meaningful observation exists, the short-circuit
  // returned "continue" forever, so stagnation after real progress could never
  // be represented and the agent fell back to a blind three-strike counter.
  it("escalates when stagnant turns reach the threshold after meaningful progress", () => {
    expect(assessExhaustion([observation("artifact_changed")], {
      stagnantTurns: 3,
      stagnationThreshold: 3,
    })).toMatchObject({ exhausted: false, next: "focused_diagnosis" });
  });

  it("continues while stagnant turns remain below the threshold", () => {
    for (const stagnantTurns of [0, 1, 2]) {
      expect(assessExhaustion([observation("artifact_changed")], {
        stagnantTurns,
        stagnationThreshold: 3,
      })).toMatchObject({ exhausted: false, next: "continue" });
    }
  });

  // Narration produces no observations at all, so the history never grows and
  // `latest` stays undefined. That must not read as "nothing has gone wrong".
  it("escalates an entirely stagnant initial window instead of continuing forever", () => {
    expect(assessExhaustion([], { stagnantTurns: 3, stagnationThreshold: 3 }))
      .toMatchObject({ exhausted: false, next: "focused_diagnosis" });
  });

  it("does not treat narration-only turns as a reason to reset stagnation", () => {
    // History is unchanged across narration turns; only the counter advances.
    const history = [observation("artifact_changed")];
    expect(assessExhaustion(history, { stagnantTurns: 2, stagnationThreshold: 3 })).toMatchObject({ next: "continue" });
    expect(assessExhaustion(history, { stagnantTurns: 3, stagnationThreshold: 3 })).toMatchObject({ next: "focused_diagnosis" });
  });

  it("changes strategy after diagnosis while a distinct strategy remains untried", () => {
    expect(assessExhaustion([observation("artifact_changed", "strategy:primary")], {
      stagnantTurns: 3,
      diagnosisCompleted: true,
      availableStrategyFingerprints: ["strategy:primary", "strategy:fallback"],
    })).toMatchObject({
      exhausted: false,
      next: "change_strategy",
      untriedStrategyFingerprints: ["strategy:fallback"],
    });
  });

  it("retries with changed conditions when every strategy was tried but a condition can change", () => {
    expect(assessExhaustion([observation("tool_result_observed", "strategy:primary")], {
      stagnantTurns: 3,
      diagnosisCompleted: true,
      availableStrategyFingerprints: ["strategy:primary"],
      retriableConditions: ["provider rate limit clears"],
    })).toMatchObject({ exhausted: false, next: "retry_with_changed_conditions" });
  });

  it("blocks precisely once repeated ineffective strategies are exhausted", () => {
    const result = assessExhaustion([
      observation("tool_result_observed", "strategy:primary"),
      observation("strategy_changed", "strategy:fallback"),
    ], {
      stagnantTurns: 3,
      diagnosisCompleted: true,
      availableStrategyFingerprints: ["strategy:primary", "strategy:fallback"],
      blocker: "fixture database is unreachable",
    });
    expect(result).toMatchObject({ exhausted: true, next: "block_precisely" });
    expect(result.reason).toContain("fixture database is unreachable");
  });
});
