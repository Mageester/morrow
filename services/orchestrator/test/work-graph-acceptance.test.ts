import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import {
  REQUIRED_RECOVERY_CAPSULE_CATEGORIES,
  WORK_GRAPH_GAUNTLET_SPEC,
  runWorkGraphAcceptance,
  type CheckpointObservation,
  type ControllerRecoveryObservation,
  type DelegationObservation,
  type EfficiencyObservation,
  type FanInObservation,
  type ReviewObservation,
  type VerificationObservation,
  type WorkGraphAcceptanceAdapter,
  type WorkGraphDecompositionObservation,
} from "../src/acceptance/work-graph.js";

const UNIT_IDS = ["worker:research", "worker:build", "reviewer:quality"] as const;
const event = (id: string, semanticKey = id) => ({ id, semanticKey });

/**
 * Deterministic adapter used by this acceptance gate. It is deliberately
 * test-owned: the production path will provide the same boundary once the
 * controller/delegation wiring is ready.
 */
class DeterministicWorkGraphAdapter implements WorkGraphAcceptanceAdapter {
  readonly calls: string[] = [];
  readonly db = openDatabase(":memory:");
  private decompositionCalls = 0;
  constructor(private readonly overrides: {
    repeatedDiscoveryReads?: number;
    canonicalVerified?: boolean;
    duplicateChildIds?: boolean;
    duplicateEventIds?: boolean;
    mismatchedRestartEvents?: boolean;
    semanticCollisionEvents?: boolean;
    mismatchedReplayManifest?: boolean;
    mismatchedReviewIdentity?: boolean;
    mismatchedFanInLedger?: boolean;
    providerFailures?: number;
    toolFailures?: number;
    injectedRetries?: number;
    providerTurns?: number;
    toolCalls?: number;
    tokenEstimate?: number;
    sqliteIntegrity?: "ok" | "failed";
  } = {}) {
    this.db.exec("CREATE TABLE acceptance_effects(id TEXT PRIMARY KEY, kind TEXT NOT NULL)");
    this.db.prepare("INSERT INTO acceptance_effects(id,kind) VALUES(?,?)").run("effect:one", "synthesis");
  }

  close(): void {
    this.db.close();
  }

  reset(): void {
    this.calls.push("reset");
  }

  decompose(): WorkGraphDecompositionObservation {
    this.calls.push("decompose");
    this.decompositionCalls += 1;
    const units = [
      { id: UNIT_IDS[0], key: "research", kind: "worker" as const, position: 1, ownerId: "agent:research", ownerProfileHash: "profile:research", dependsOn: [] as string[] },
      { id: UNIT_IDS[1], key: "build", kind: "worker" as const, position: 2, ownerId: "agent:build", ownerProfileHash: "profile:build", dependsOn: [] as string[] },
      { id: UNIT_IDS[2], key: "quality", kind: "reviewer" as const, position: 3, ownerId: "agent:quality", ownerProfileHash: "profile:quality", dependsOn: [UNIT_IDS[0], UNIT_IDS[1]] },
    ];
    if (this.overrides.mismatchedReplayManifest && this.decompositionCalls > 1) units[1]!.ownerProfileHash = "profile:drifted";
    return {
      graphId: "graph:mission-parent",
      parentTaskId: WORK_GRAPH_GAUNTLET_SPEC.parentTaskId,
      maxConcurrency: 2,
      units,
      duplicateSuppressed: this.decompositionCalls > 1,
    };
  }

  dispatch(): DelegationObservation {
    this.calls.push("dispatch");
    const childIds = this.overrides.duplicateChildIds
      ? ["child:research", "child:research"]
      : ["child:research", "child:build"];
    return {
      workerUnitIds: [UNIT_IDS[0], UNIT_IDS[1]],
      reviewerUnitId: UNIT_IDS[2],
      childSpawnEvents: this.overrides.semanticCollisionEvents ? [event("spawn:research", "worker:research"), event("spawn:build", "worker:research")] : this.overrides.duplicateEventIds ? [event("spawn:research"), event("spawn:research")] : [event("spawn:research", "worker:research"), event("spawn:build", "worker:build")],
      effectEvents: this.overrides.semanticCollisionEvents ? [event("effect:research", "worker:research"), event("effect:build", "worker:research")] : this.overrides.duplicateEventIds ? [event("effect:research"), event("effect:research")] : [event("effect:research", "child-effect:worker:research"), event("effect:build", "child-effect:worker:build")],
      importEvents: this.overrides.semanticCollisionEvents ? [event("import:research", "worker:research"), event("import:build", "worker:research")] : this.overrides.duplicateEventIds ? [event("import:research"), event("import:research")] : [event("import:research", "child-evidence:worker:research"), event("import:build", "child-evidence:worker:build")],
      reviewAttemptEvents: this.overrides.semanticCollisionEvents ? [event("review:1", "review:quality"), event("review:2", "review:quality")] : this.overrides.duplicateEventIds ? [event("review:1"), event("review:1")] : [event("review:1", "review:quality:attempt:1"), event("review:2", "review:quality:attempt:2")],
      duplicateReviewAttempts: 0,
      childIdsBeforeRestart: childIds,
      childIdsAfterRestart: childIds,
      maxActive: 2,
      parallelWorkerCount: 2,
      duplicateChildSpawns: 0,
      duplicateEffects: 0,
      childImports: 2,
      duplicateImports: 0,
      providerFailures: this.overrides.providerFailures ?? 1,
      toolFailures: this.overrides.toolFailures ?? 1,
      injectedRetries: this.overrides.injectedRetries ?? 2,
      workerTerminalVerified: true,
      childResults: [
        { unitId: UNIT_IDS[0], status: "succeeded", canonical: true, verified: true, evidenceDurable: true },
        { unitId: UNIT_IDS[1], status: "succeeded", canonical: true, verified: true, evidenceDurable: true },
      ],
    };
  }

  recoverAfterRestart(): ControllerRecoveryObservation {
    this.calls.push("restart");
    const childIds = this.overrides.duplicateChildIds
      ? ["child:research", "child:research"]
      : ["child:research", "child:build"];
    return {
      abruptRestarted: true,
      recoveries: 1,
      retryDisposition: "retryable",
      activeWorkRecovered: true,
      duplicateChildSpawns: 0,
      providerFailures: this.overrides.providerFailures ?? 1,
      toolFailures: this.overrides.toolFailures ?? 1,
      childIdsBeforeRestart: childIds,
      childIdsAfterRestart: childIds,
      recoveryAttemptEvents: [event("recovery:1", "controller-recovery:attempt:1")],
      restartReviewAttemptEvents: this.overrides.mismatchedRestartEvents ? [event("review:other"), event("review:other-2")] : this.overrides.semanticCollisionEvents ? [event("review:1", "review:quality"), event("review:2", "review:quality")] : this.overrides.duplicateEventIds ? [event("review:1"), event("review:1")] : [event("review:1", "review:quality:attempt:1"), event("review:2", "review:quality:attempt:2")],
      restartImportEvents: this.overrides.semanticCollisionEvents ? [event("import:research", "worker:research"), event("import:build", "worker:research")] : this.overrides.duplicateEventIds ? [event("import:research"), event("import:research")] : [event("import:research", "child-evidence:worker:research"), event("import:build", "child-evidence:worker:build")],
      restartSynthesisEffectEvents: this.overrides.semanticCollisionEvents ? [event("effect:one", "aggregate:graph"), event("effect:two", "aggregate:graph")] : this.overrides.duplicateEventIds ? [event("effect:one"), event("effect:one")] : [event("effect:one", "aggregate:graph:mission-parent:synthesis")],
      duplicateReviewAttempts: 0,
      duplicateImports: 0,
      duplicateSynthesisEffects: 0,
    };
  }

  checkpoint(): CheckpointObservation {
    this.calls.push("checkpoint");
    return {
      oversizedBytes: 410_000,
      boundedBytes: 131_072,
      maxBytes: 131_072,
      rolloverCount: 2,
      compacted: true,
      restartPreserved: true,
      categories: REQUIRED_RECOVERY_CAPSULE_CATEGORIES.map((name) => ({ name, preserved: true, compacted: true, digest: `sha256:${name}` })),
    };
  }

  rejectPrematureCompletion(): VerificationObservation {
    this.calls.push("premature");
    const canonicalVerified = this.overrides.canonicalVerified ?? true;
    return {
      attemptedText: "Done — all work is complete.",
      rejected: true,
      rejectionReason: "textual completion has no canonical verified evidence",
      terminalChildIds: canonicalVerified ? [UNIT_IDS[0], UNIT_IDS[1]] : [],
      terminalVerifiedCanonicalChildIds: canonicalVerified ? [UNIT_IDS[0], UNIT_IDS[1]] : [],
      reviewerIndependent: true,
      guardianAuthorized: false,
    };
  }

  reviewAndRevise(): ReviewObservation {
    this.calls.push("review");
    return {
      reviewerUnitId: UNIT_IDS[2],
      reviewerOwnerId: this.overrides.mismatchedReviewIdentity ? "agent:research" : "agent:quality",
      producingOwnerIds: ["agent:research", "agent:build"],
      reviewerProfileHash: this.overrides.mismatchedReviewIdentity ? "profile:research" : "profile:quality",
      producingProfileHashes: ["profile:research", "profile:build"],
      firstVerdict: "rejected",
      revisionCount: 1,
      finalVerdict: "approved",
      reviewerIndependent: true,
      reviewAttempts: 2,
      reviewAttemptEvents: this.overrides.semanticCollisionEvents ? [event("review:1", "review:quality"), event("review:2", "review:quality")] : this.overrides.duplicateEventIds ? [event("review:1"), event("review:1")] : [event("review:1", "review:quality:attempt:1"), event("review:2", "review:quality:attempt:2")],
    };
  }

  fanIn(): FanInObservation {
    this.calls.push("fan-in");
    const canonicalVerified = this.overrides.canonicalVerified ?? true;
    return {
      orderedUnitIds: [...UNIT_IDS],
      aggregateAttemptEvents: this.overrides.semanticCollisionEvents ? [event("aggregate:1", "aggregate:graph"), event("aggregate:2", "aggregate:graph")] : this.overrides.duplicateEventIds ? [event("aggregate:1"), event("aggregate:1")] : [event("aggregate:1", "aggregate:graph:mission-parent:attempt:1"), event("aggregate:2", "aggregate:graph:mission-parent:attempt:2")],
      importEvents: this.overrides.mismatchedFanInLedger ? [event("import:other"), event("import:other-2")] : this.overrides.semanticCollisionEvents ? [event("import:research", "worker:research"), event("import:build", "worker:research")] : this.overrides.duplicateEventIds ? [event("import:research"), event("import:research")] : [event("import:research", "child-evidence:worker:research"), event("import:build", "child-evidence:worker:build")],
      synthesisEffectEvents: this.overrides.semanticCollisionEvents ? [event("effect:one", "aggregate:graph"), event("effect:two", "aggregate:graph")] : this.overrides.duplicateEventIds ? [event("effect:one"), event("effect:one")] : [event("effect:one", "aggregate:graph:mission-parent:synthesis")],
      canonicalEvidenceEvents: this.overrides.semanticCollisionEvents ? [event("canonical:research", "worker:research"), event("canonical:build", "worker:research"), event("canonical:aggregate", "aggregate:graph")] : this.overrides.duplicateEventIds ? [event("canonical:research"), event("canonical:research"), event("canonical:aggregate")] : [event("canonical:research", "worker:research"), event("canonical:build", "worker:build"), event("canonical:aggregate", "aggregate:graph:mission-parent")],
      requiredTerminalVerifiedCanonical: canonicalVerified,
      aggregateAttempts: 2,
      aggregateRetryCount: 1,
      duplicateSynthesisEffects: 0,
      synthesisCount: 1,
      duplicateImports: 0,
      terminalState: canonicalVerified ? "completed" : "blocked",
      canonicalAnswer: canonicalVerified
        ? { content: "Research and build results, independently reviewed.", source: "aggregate:graph:mission-parent", durable: true, verified: true }
        : null,
      guardianAuthorized: canonicalVerified,
    };
  }

  efficiency(): EfficiencyObservation {
    this.calls.push("efficiency");
    return {
      discoveryReads: 2,
      repeatedDiscoveryReads: this.overrides.repeatedDiscoveryReads ?? 0,
      unchangedFailedCommandReruns: 0,
      providerTurns: this.overrides.providerTurns ?? 8,
      toolCalls: this.overrides.toolCalls ?? 6,
      providerFailures: this.overrides.providerFailures ?? 1,
      toolFailures: this.overrides.toolFailures ?? 1,
      injectedRetries: this.overrides.injectedRetries ?? 2,
      tokenEstimate: this.overrides.tokenEstimate ?? 1_900,
      workingSetChars: 1_800,
    };
  }

  async sqliteIntegrity(): Promise<"ok" | "failed"> {
    this.calls.push("integrity");
    if (this.overrides.sqliteIntegrity) return this.overrides.sqliteIntegrity;
    const result = this.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    return result.integrity_check === "ok" ? "ok" : "failed";
  }
}

describe("deterministic work-graph acceptance gauntlet", () => {
  it("runs the parallel/restart/review/fan-in scenario with phase attribution", async () => {
    const adapter = new DeterministicWorkGraphAdapter();
    try {
      const result = await runWorkGraphAcceptance({ adapter });

      expect(result.passed, result.message ?? "work-graph scenario failed").toBe(true);
      expect(result.scenarioId).toBe("work-graph-gauntlet-v1");
      expect(result.phases.decomposition.passed).toBe(true);
      expect(result.phases.controllerRecovery.passed).toBe(true);
      expect(result.phases.checkpointFidelity.passed).toBe(true);
      expect(result.phases.delegation.passed).toBe(true);
      expect(result.phases.verification.passed).toBe(true);
      expect(result.phases.fanIn.passed).toBe(true);
      expect(result.phases.efficiency.passed).toBe(true);
      expect(result.fanInOrder).toEqual([...UNIT_IDS]);
      expect(result.terminalState).toBe("completed");
      expect(result.sqliteIntegrity).toBe("ok");
      expect(result.counters.duplicates).toEqual({ childSpawns: 0, decompositionUnits: 0, effects: 0, imports: 0, synthesis: 0 });
      expect(result.counters.efficiency.repeatedDiscoveryReads).toBe(0);
      expect(result.counters.efficiency.unchangedFailedCommandReruns).toBe(0);
      expect(result.counters.checkpoint.rollovers).toBeGreaterThanOrEqual(2);
      expect(result.counters.checkpoint.workingSetChars).toBeLessThanOrEqual(result.counters.efficiency.workingSetLimit);
      expect(result.counters.checkpoint.workingSetChars).toBe(1_800);
      expect(result.phases.checkpointFidelity.counters.workingSetChars).toBe(1_800);
      expect(result.phases.delegation.counters).toMatchObject({
        providerFailures: 1,
        toolFailures: 1,
        injectedRetries: 2,
        reviewAttempts: 2,
        reviewerRejections: 1,
        reviewerApprovals: 1,
      });
      expect(result.phases.fanIn.counters).toMatchObject({ aggregateAttempts: 2, aggregateRetries: 1, synthesis: 1 });
      expect(result.counters.review).toEqual({ attempts: 2, rejections: 1, approvals: 1, revisions: 1 });
      expect(result.boundary.productionIntegrated).toBe(false);
      expect(result.counters.duplicates).toEqual({ childSpawns: 0, decompositionUnits: 0, effects: 0, imports: 0, synthesis: 0 });
      expect(adapter.calls).toEqual(["reset", "decompose", "decompose", "dispatch", "restart", "checkpoint", "premature", "review", "fan-in", "efficiency", "integrity"]);
    } finally {
      adapter.close();
    }
  });

  it("attributes an efficiency budget failure instead of returning opaque failure", async () => {
    const adapter = new DeterministicWorkGraphAdapter({ repeatedDiscoveryReads: 1 });
    try {
      const result = await runWorkGraphAcceptance({ adapter });

      expect(result.passed).toBe(false);
      expect(result.failedPhases).toEqual(["efficiency"]);
      expect(result.phases.efficiency.diagnostics.join(" ")).toMatch(/repeated discovery/i);
      expect(result.phases.delegation.passed).toBe(true);
      expect(result.phases.fanIn.passed).toBe(true);
    } finally {
      adapter.close();
    }
  });

  it("attributes missing terminal canonical evidence to verification and fan-in", async () => {
    const adapter = new DeterministicWorkGraphAdapter({ canonicalVerified: false });
    try {
      const result = await runWorkGraphAcceptance({ adapter });

      expect(result.passed).toBe(false);
      expect(result.failedPhases).toEqual(["verification", "fanIn"]);
      expect(result.phases.verification.diagnostics.join(" ")).toMatch(/canonical|verified/i);
      expect(result.phases.fanIn.diagnostics.join(" ")).toMatch(/canonical|verified/i);
      expect(result.terminalState).toBe("blocked");
    } finally {
      adapter.close();
    }
  });

  it("labels injected evidence and rejects duplicate child identities even when the adapter counter is zero", async () => {
    const adapter = new DeterministicWorkGraphAdapter({ duplicateChildIds: true });
    try {
      const result = await runWorkGraphAcceptance({ adapter });

      expect(result.passed).toBe(false);
      expect(result.failedPhases).toEqual(expect.arrayContaining(["controllerRecovery", "delegation"]));
      expect(result.counters.duplicates.childSpawns).toBeGreaterThan(0);
      expect(result.phases.delegation.diagnostics.join(" ")).toMatch(/duplicate.*child/i);
      expect(result.boundary).toEqual(expect.objectContaining({
        kind: "injected-adapter",
        productionIntegrated: false,
      }));
      expect(result.limitations.join(" ")).toMatch(/production/i);
    } finally {
      adapter.close();
    }
  });

  it("attributes SQLite integrity failure without hiding otherwise passing phase evidence", async () => {
    const adapter = new DeterministicWorkGraphAdapter({ sqliteIntegrity: "failed" });
    try {
      const result = await runWorkGraphAcceptance({ adapter });

      expect(result.passed).toBe(false);
      expect(result.sqliteIntegrity).toBe("failed");
      expect(result.diagnostics.join(" ")).toMatch(/SQLite integrity/i);
      expect(result.phases.delegation.passed).toBe(true);
      expect(result.phases.fanIn.passed).toBe(true);
    } finally {
      adapter.close();
    }
  });

  it("derives restart/import/review/synthesis duplication from immutable event identities", async () => {
    const adapter = new DeterministicWorkGraphAdapter({ duplicateEventIds: true });
    try {
      const result = await runWorkGraphAcceptance({ adapter });

      expect(result.passed).toBe(false);
      expect(result.counters.duplicates.effects).toBeGreaterThan(0);
      expect(result.counters.duplicates.imports).toBeGreaterThan(0);
      expect(result.counters.duplicates.synthesis).toBeGreaterThan(0);
      expect(result.phases.delegation.diagnostics.join(" ")).toMatch(/duplicate.*(?:event|review|effect|import)/i);
      expect(result.phases.fanIn.diagnostics.join(" ")).toMatch(/duplicate.*(?:event|synthesis|import|canonical)/i);
      expect(result.phases.controllerRecovery.diagnostics.join(" ")).toMatch(/duplicate.*(?:review|import|synthesis)/i);
    } finally {
      adapter.close();
    }
  });

  it("rejects restart evidence that cannot be reconciled to the original immutable review ledger", async () => {
    const adapter = new DeterministicWorkGraphAdapter({ mismatchedRestartEvents: true });
    try {
      const result = await runWorkGraphAcceptance({ adapter });

      expect(result.passed).toBe(false);
      expect(result.phases.controllerRecovery.diagnostics.join(" ")).toMatch(/restart.*review|review.*restart/i);
    } finally {
      adapter.close();
    }
  });

  it("rejects replay manifest drift instead of comparing replay only with itself", async () => {
    const adapter = new DeterministicWorkGraphAdapter({ mismatchedReplayManifest: true });
    try {
      const result = await runWorkGraphAcceptance({ adapter });

      expect(result.passed).toBe(false);
      expect(result.phases.decomposition.diagnostics.join(" ")).toMatch(/expected.*manifest/i);
    } finally {
      adapter.close();
    }
  });

  it("binds review identity to the manifest and restart/fan-in ledgers", async () => {
    const reviewerAdapter = new DeterministicWorkGraphAdapter({ mismatchedReviewIdentity: true });
    const ledgerAdapter = new DeterministicWorkGraphAdapter({ mismatchedFanInLedger: true });
    try {
      const reviewerResult = await runWorkGraphAcceptance({ adapter: reviewerAdapter });
      const ledgerResult = await runWorkGraphAcceptance({ adapter: ledgerAdapter });
      expect(reviewerResult.phases.delegation.passed).toBe(false);
      expect(reviewerResult.phases.delegation.diagnostics.join(" ")).toMatch(/reviewer.*(?:owner|profile)|producer/i);
      expect(ledgerResult.passed).toBe(false);
      expect(ledgerResult.phases.fanIn.diagnostics.join(" ")).toMatch(/import/i);
    } finally {
      reviewerAdapter.close();
      ledgerAdapter.close();
    }
  });

  it("attributes provider/tool/token over-budget and retry-mismatch evidence to efficiency", async () => {
    const adapter = new DeterministicWorkGraphAdapter({ providerTurns: 17, toolCalls: 17, tokenEstimate: 8_001, injectedRetries: 1 });
    try {
      const result = await runWorkGraphAcceptance({ adapter });

      expect(result.passed).toBe(false);
      expect(result.failedPhases).toContain("efficiency");
      expect(result.phases.efficiency.diagnostics.join(" ")).toMatch(/budget|retries|token/i);
    } finally {
      adapter.close();
    }
  });

  it("rejects distinct immutable IDs that reuse one semantic work-graph key", async () => {
    const adapter = new DeterministicWorkGraphAdapter({ semanticCollisionEvents: true });
    try {
      const result = await runWorkGraphAcceptance({ adapter });

      expect(result.passed).toBe(false);
      expect(result.counters.duplicates.effects).toBeGreaterThan(0);
      expect(result.counters.duplicates.imports).toBeGreaterThan(0);
      expect(result.counters.duplicates.synthesis).toBeGreaterThan(0);
      expect(result.phases.delegation.diagnostics.join(" ")).toMatch(/semantic key/i);
      expect(result.phases.fanIn.diagnostics.join(" ")).toMatch(/semantic key/i);
      expect(result.phases.controllerRecovery.diagnostics.join(" ")).toMatch(/semantic key/i);
    } finally {
      adapter.close();
    }
  });
});
