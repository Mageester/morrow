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
