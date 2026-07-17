import { describe, expect, it } from "vitest";
import { assessExhaustion, assessProgress } from "../src/execution/progress.js";
import {
  buildExecutionProgressSnapshot,
  type ExecutionProgressInputs,
} from "../src/execution/progress-snapshot.js";

const now = "2026-07-16T12:00:00.000Z";

function inputs(overrides: Partial<ExecutionProgressInputs> = {}): ExecutionProgressInputs {
  return {
    missionId: "mission-1",
    operationId: null,
    strategyFingerprint: "worker:primary",
    changedFiles: [],
    completedToolSignatures: [],
    verifications: [],
    unresolvedFailures: [],
    checkpointIds: [],
    validatedCriterionIds: [],
    observedAt: now,
    ...overrides,
  };
}

const kinds = (a: ExecutionProgressInputs, b: ExecutionProgressInputs): string[] =>
  assessProgress(buildExecutionProgressSnapshot(a), buildExecutionProgressSnapshot(b)).map((item) => item.kind);

describe("execution progress snapshots", () => {
  // The consumer-facing false no-progress bug: `turnMadeProgress` only credits a
  // novel *successful tool signature*. A turn that genuinely rewrites a file
  // while its verification command keeps emitting byte-identical output scores
  // zero progress, and three such turns kill a mission that is really working.
  it("counts a changed file as progress even when every tool signature repeats", () => {
    const before = inputs({
      changedFiles: [{ path: "src/sum.js", contentHash: "hash-v1" }],
      completedToolSignatures: ["run_command:npm test:result:identical"],
    });
    const after = inputs({
      // Same repeated tool signature, but the file content genuinely changed.
      changedFiles: [{ path: "src/sum.js", contentHash: "hash-v2" }],
      completedToolSignatures: ["run_command:npm test:result:identical"],
    });

    expect(kinds(before, after)).toContain("artifact_changed");
  });

  it("counts a cleared verification failure as reduced uncertainty and an eliminated hypothesis", () => {
    const before = inputs({ unresolvedFailures: ["run_command: pytest exited 1"] });
    const after = inputs({ unresolvedFailures: [] });

    expect(kinds(before, after)).toEqual(
      expect.arrayContaining(["uncertainty_reduced", "hypothesis_eliminated"]),
    );
  });

  it("counts a newly passed verification as evidence gained", () => {
    const before = inputs({ verifications: [{ id: "verify-1", passed: false }] });
    const after = inputs({ verifications: [{ id: "verify-1", passed: true }] });

    expect(kinds(before, after)).toContain("evidence_gained");
  });

  it("does not count narration, longer text, or a repeated plan as progress", () => {
    // Narration has no observable execution delta, so it must produce nothing.
    const before = inputs({ completedToolSignatures: ["read_file:src/sum.js:result:h"] });
    const after = inputs({ completedToolSignatures: ["read_file:src/sum.js:result:h"] });

    expect(kinds(before, after)).toEqual([]);
  });

  it("does not count a repeated identical tool result as progress", () => {
    const signature = "run_command:npm test:result:identical";
    expect(kinds(
      inputs({ completedToolSignatures: [signature] }),
      inputs({ completedToolSignatures: [signature] }),
    )).toEqual([]);
  });

  it("keeps a mission alive while real artifact progress continues", () => {
    const history = assessProgress(
      buildExecutionProgressSnapshot(inputs({ changedFiles: [{ path: "a.js", contentHash: "v1" }] })),
      buildExecutionProgressSnapshot(inputs({ changedFiles: [{ path: "a.js", contentHash: "v2" }] })),
    );

    expect(assessExhaustion(history)).toMatchObject({ exhausted: false, next: "continue" });
  });
});
