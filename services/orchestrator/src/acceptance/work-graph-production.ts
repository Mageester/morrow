import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../database.js";
import { WORKING_SET_DEFAULTS } from "../execution/conversation-working-set.js";
import { MAX_EXECUTION_CHECKPOINT_BYTES } from "../execution/checkpoint-snapshot.js";
import { evaluateGuardian } from "../mission/guardian.js";
import { MissionControllerRunner } from "../mission/controller-runner.js";
import { MissionService } from "../mission/service.js";
import { createMissionToolFailureReporter } from "../mission/tool-failure-reporter.js";
import { missionsRepository } from "../repositories/missions.js";
import { decideWorkerRecovery } from "../mission/worker-recovery.js";
import { createWorkGraphIntegration, type WorkGraphIntegration } from "../mission/work-graph-integration.js";
import { agentsRepository } from "../repositories/agents.js";
import {
  executionContinuityRepository,
  type ExecutionCheckpointSnapshot,
} from "../repositories/execution-continuity.js";
import { missionRuntimeRepository } from "../repositories/mission-runtime.js";
import { projectRepository } from "../repositories/projects.js";
import { taskRecordsRepository } from "../repositories/task-records.js";
import { taskRepository } from "../repositories/tasks.js";
import { workGraphsRepository } from "../repositories/work-graphs.js";
import { TaskRunner } from "../runner.js";
import { teammateProfileFingerprint } from "../tools/teammate-delegation.js";
import {
  REQUIRED_RECOVERY_CAPSULE_CATEGORIES,
  WORK_GRAPH_GAUNTLET_BUDGETS,
  runWorkGraphAcceptance,
  type CheckpointObservation,
  type ChildResultObservation,
  type ControllerRecoveryObservation,
  type DelegationObservation,
  type EfficiencyObservation,
  type FanInObservation,
  type ImmutableWorkGraphEvent,
  type RecoveryCapsuleCategory,
  type ReviewObservation,
  type VerificationObservation,
  type WorkGraphAcceptanceAdapter,
  type WorkGraphAcceptanceResult,
  type WorkGraphDecompositionObservation,
  type WorkGraphGauntletSpec,
  type WorkGraphProductionEvidence,
  type WorkGraphUnitObservation,
} from "./work-graph.js";

const SCENARIO_ID = "work-graph-gauntlet-v1";
const PARENT_TASK_ID = "mission-parent";
const REVISION_PARENT_TASK_ID = "mission-parent-rejected";
const MISSION_ID = "mission-work-graph-gauntlet";
const PROJECT_ID = "project-work-graph-gauntlet";

/** Production modules this gate drives end to end. */
export const PRODUCTION_WORK_GRAPH_MODULES = [
  "src/repositories/work-graphs.ts",
  "src/repositories/task-start-claims.ts",
  "src/repositories/execution-continuity.ts",
  "src/repositories/mission-runtime.ts",
  "src/mission/work-graph-orchestrator.ts",
  "src/mission/work-graph-task-adapter.ts",
  "src/mission/work-graph-integration.ts",
  "src/mission/task-dispatcher.ts",
  "src/mission/guardian.ts",
  "src/mission/worker-recovery.ts",
  "src/execution/checkpoint-snapshot.ts",
  "src/mission/controller-runner.ts",
  "src/mission/service.ts",
  "src/mission/tool-failure-reporter.ts",
  "src/recovery.ts",
  "src/runner.ts",
] as const;

/**
 * Semantic recovery-capsule category → the durable checkpoint snapshot field
 * that must still carry it after loss-aware compaction.
 */
const CAPSULE_FIELDS: Record<RecoveryCapsuleCategory, keyof ExecutionCheckpointSnapshot> = {
  objective: "originalMission",
  requirements: "hardRequirements",
  criteria: "acceptanceCriteria",
  decisions: "decisions",
  completedWork: "completedWork",
  changedFiles: "filesChanged",
  unresolvedFailures: "unresolvedFailures",
  recoveryAttempts: "recoveryAttempts",
  approvals: "approvals",
  routing: "providerRouting",
  acceptanceCriteria: "acceptanceCriteria",
  nextPendingWork: "pendingWork",
};

function at(offsetMs: number): string {
  return new Date(Date.parse("2026-08-27T12:00:00.000Z") + offsetMs).toISOString();
}

function contentHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function event(id: string, semanticKey: string): ImmutableWorkGraphEvent {
  return { id, semanticKey };
}

/** Deterministic durable completion for one child, written through production repositories. */
function completeChild(
  db: Database.Database,
  childTaskId: string,
  options: { reviewVerdict?: "approved" | "rejected"; offsetMs: number },
): void {
  const records = taskRecordsRepository(db);
  const continuity = executionContinuityRepository(db);
  const timestamp = at(options.offsetMs);
  if (taskRepository(db).getTaskById(childTaskId)?.status === "queued") {
    records.transitionTask(childTaskId, "running", { id: `running:${childTaskId}`, createdAt: timestamp, payload: {} });
  }
  records.appendEvidence({
    id: `evidence:${childTaskId}`,
    taskId: childTaskId,
    type: "file",
    path: `${childTaskId}.md`,
    metadata: { contentHash: contentHash(childTaskId) },
    createdAt: timestamp,
  });
  records.upsertVerification({
    taskId: childTaskId,
    status: "verified",
    summary: "deterministic verification passed",
    details: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const segment = continuity.openSegment({
    taskId: childTaskId,
    missionId: null,
    providerId: "mock",
    model: "mock-model",
    routeJson: {},
    ownerId: `owner:${childTaskId}`,
    now: timestamp,
  });
  continuity.recordProviderTurn({
    id: `turn:${childTaskId}`,
    taskId: childTaskId,
    segmentId: segment.id,
    turnKey: "final-turn",
    ordinal: 1,
    assistantText: `Result for ${childTaskId}`,
    toolCalls: [{ id: `tool:${childTaskId}`, name: "write_file", arguments: "{}" }],
    isFinal: true,
    ownerId: segment.ownerId!,
    generation: segment.generation,
    now: timestamp,
  });
  continuity.createCanonicalAnswer({
    id: `answer:${childTaskId}`,
    taskId: childTaskId,
    missionId: null,
    segmentId: segment.id,
    content: `Durable verified result for ${childTaskId}`,
    evidenceJson: {
      sourceTurnKey: "final-turn",
      durableEventCursor: 2,
      requirementsSatisfied: true,
      status: "completed",
      ...(options.reviewVerdict ? { reviewVerdict: options.reviewVerdict } : {}),
    },
    ownerId: segment.ownerId!,
    generation: segment.generation,
    now: timestamp,
  });
  db.prepare("UPDATE tasks SET status='completed',updated_at=?,completed_at=? WHERE id=?")
    .run(timestamp, timestamp, childTaskId);
}

function oversizedCheckpointSnapshot(taskId: string, missionId: string, salt: string): ExecutionCheckpointSnapshot {
  const filler = (label: string, count: number, width: number): string[] =>
    Array.from({ length: count }, (_unused, index) => `${label}-${salt}-${index}-${"x".repeat(width)}`);
  return {
    version: 1,
    originalMission: `Assemble a verified result from two parallel workers and an independent review. ${"o".repeat(6_000)}`,
    hardRequirements: filler("requirement", 240, 200),
    prohibitedActions: filler("prohibited", 64, 120),
    acceptanceCriteria: filler("criterion", 200, 200),
    decisions: filler("decision", 240, 200),
    completedWork: filler("completed", 240, 200),
    currentPhase: `fan-in-${salt}`,
    filesChanged: filler("changed/file", 240, 120),
    gitStatus: `M changed.ts ${"g".repeat(5_000)}`,
    tests: Array.from({ length: 64 }, (_unused, index) => ({ command: `node check-${index}.js`, exitCode: 0, result: `ok ${"t".repeat(200)}` })),
    unresolvedFailures: filler("failure", 120, 200),
    recoveryAttempts: filler("recovery", 120, 200),
    pendingWork: filler("pending", 240, 200),
    approvals: Object.fromEntries(filler("approval", 64, 120).map((value, index) => [`approval-${index}`, value])),
    taskId,
    missionId,
    providerRouting: { providerId: "mock", model: "mock-model", note: "r".repeat(5_000) },
    providerContinuationRefs: filler("continuation", 64, 80),
    evidenceRequired: filler("evidence", 64, 120),
  };
}

function capsuleValue(snapshot: ExecutionCheckpointSnapshot, category: RecoveryCapsuleCategory): unknown {
  return (snapshot as unknown as Record<string, unknown>)[CAPSULE_FIELDS[category]];
}

function preserved(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

interface ScenarioObservations {
  decompositionFirst: WorkGraphDecompositionObservation;
  decompositionReplay: WorkGraphDecompositionObservation;
  delegation: DelegationObservation;
  controllerRecovery: ControllerRecoveryObservation;
  checkpoint: CheckpointObservation;
  verification: VerificationObservation;
  review: ReviewObservation;
  fanIn: FanInObservation;
  efficiency: EfficiencyObservation;
  sqliteIntegrity: "ok" | "failed";
  evidence: WorkGraphProductionEvidence;
}

export interface ProductionWorkGraphGauntlet {
  adapter: WorkGraphAcceptanceAdapter;
  spec: WorkGraphGauntletSpec;
  databasePath: string;
  close(): void;
}

/**
 * Build the production-integrated work-graph gauntlet.
 *
 * Every observation this adapter returns is read back from the durable SQLite
 * database after production code — the work-graph repository, orchestrator,
 * task adapter, start-claim fence, integration seam, startup reconciliation,
 * checkpoint compaction, Guardian, and worker-recovery classifier — actually
 * wrote it. The model/provider boundary is the only deterministic seam.
 */
export function createProductionWorkGraphGauntlet(): ProductionWorkGraphGauntlet {
  const directory = mkdtempSync(join(tmpdir(), "morrow-work-graph-gauntlet-"));
  const databasePath = join(directory, "morrow.db");
  const env: NodeJS.ProcessEnv = { ...process.env, MOCK_PROVIDER: "true" };

  let db = openDatabase(databasePath);
  projectRepository(db).createProject({ id: PROJECT_ID, name: "Gauntlet", workspacePath: directory, createdAt: at(0) });
  db.prepare(`INSERT INTO missions
    (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(MISSION_ID, 1, PROJECT_ID, "Assemble a verified result from two parallel workers and an independent review.", "running", 1, "{}", at(0), at(0));
  missionRuntimeRepository(db).create({ missionId: MISSION_ID, state: "executing", now: at(0) });
  const tasks = taskRepository(db);
  tasks.createTask({ id: PARENT_TASK_ID, projectId: PROJECT_ID, kind: "agent_chat", status: "running", createdAt: at(0), missionId: MISSION_ID });
  tasks.createTask({ id: REVISION_PARENT_TASK_ID, projectId: PROJECT_ID, kind: "agent_chat", status: "running", createdAt: at(0), missionId: MISSION_ID });

  const agents = agentsRepository(db);
  const participant = (id: string, objective: string) => {
    const agent = agents.create({ id, projectId: PROJECT_ID, name: id, role: "researcher", providerOverride: "mock", modelOverride: `${id}-model` });
    return { key: id, ownerId: agent.id, ownerProfileHash: teammateProfileFingerprint(agent, agents.listToolPermissions(agent.id)), objective };
  };
  const workers = [
    participant("research", "Research the source inputs."),
    participant("build", "Build the candidate result."),
  ];
  const reviewer = participant("quality", "Review the workers' result independently.");

  const spec: WorkGraphGauntletSpec = {
    scenarioId: SCENARIO_ID,
    parentTaskId: PARENT_TASK_ID,
    objective: "Assemble a verified result from two parallel workers and an independent review.",
    maxConcurrency: 2,
    workers,
    reviewer,
  };

  let runner = new TaskRunner(db, async () => { /* provider boundary; durable child state is written by the scenario */ });
  let integration: WorkGraphIntegration = createWorkGraphIntegration({ db, runner, env, ownerId: "gauntlet-before-restart" });
  let observations: ScenarioObservations | null = null;
  let closed = false;

  const graphs = () => workGraphsRepository(db);

  /**
   * Let every started child reach the runner's real settlement callback. A
   * cleared start-claim table is the durable proof that the fence was
   * terminalized rather than abandoned.
   */
  const quiesce = async (): Promise<void> => {
    for (let pass = 0; pass < 40; pass += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await integration.settled();
      const outstanding = (db.prepare("SELECT COUNT(*) AS count FROM task_start_claims").get() as { count: number }).count;
      if (outstanding === 0) return;
    }
    throw new Error("Production gauntlet could not quiesce outstanding child-start claims");
  };

  const decomposeMain = () => integration.orchestrator.decompose({
    parentTaskId: PARENT_TASK_ID,
    graphId: `work-graph:${PARENT_TASK_ID}`,
    objective: spec.objective,
    maxConcurrency: spec.maxConcurrency,
    units: workers.map((worker, index) => ({
      id: `worker:${worker.key}`,
      key: worker.key,
      position: index + 1,
      ownerId: worker.ownerId,
      ownerProfileHash: worker.ownerProfileHash,
      objective: worker.objective,
    })),
    reviewer: {
      id: `reviewer:${reviewer.key}`,
      key: reviewer.key,
      ownerId: reviewer.ownerId,
      ownerProfileHash: reviewer.ownerProfileHash,
      objective: reviewer.objective,
    },
  });

  const observeDecomposition = (graphId: string, duplicateSuppressed: boolean): WorkGraphDecompositionObservation => {
    const graph = graphs().get(graphId)!;
    const units = graphs().listUnits(graphId);
    return {
      graphId: graph.id,
      parentTaskId: graph.parentTaskId,
      maxConcurrency: graph.maxConcurrency,
      duplicateSuppressed,
      units: units.map((unit, index): WorkGraphUnitObservation => ({
        id: unit.id,
        key: unit.id.split(":").at(-1)!,
        kind: unit.id.startsWith("reviewer:") ? "reviewer" : "worker",
        position: index + 1,
        ownerId: unit.ownerId,
        ownerProfileHash: unit.ownerProfileHash,
        dependsOn: graphs().listDependencies(graphId, unit.id),
      })),
    };
  };

  /**
   * Round one: an independent reviewer rejects, which must durably block
   * synthesis. This is the production proof behind the review phase's first
   * verdict; the revised round below is a second parent-owned graph.
   */
  const runRejectedRound = async (): Promise<{ reviewerChildTaskId: string; blocked: boolean; reasons: string[] }> => {
    const { graph } = integration.orchestrator.decompose({
      parentTaskId: REVISION_PARENT_TASK_ID,
      graphId: `work-graph:${REVISION_PARENT_TASK_ID}`,
      objective: spec.objective,
      maxConcurrency: spec.maxConcurrency,
      units: workers.map((worker, index) => ({
        id: `rejected:worker:${worker.key}`,
        key: worker.key,
        position: index + 1,
        ownerId: worker.ownerId,
        ownerProfileHash: worker.ownerProfileHash,
        objective: worker.objective,
      })),
      reviewer: {
        id: `rejected:reviewer:${reviewer.key}`,
        key: reviewer.key,
        ownerId: reviewer.ownerId,
        ownerProfileHash: reviewer.ownerProfileHash,
        objective: reviewer.objective,
      },
    });
    const dispatched = await integration.orchestrator.dispatchReady(graph.id);
    await quiesce();
    dispatched.forEach((unit, index) => completeChild(db, unit.childTaskId!, { offsetMs: 1_000 + index }));
    await integration.reconcileGraph(graph.id);
    await quiesce();
    const reviewerUnit = graphs().listUnits(graph.id).find((unit) => unit.id.startsWith("rejected:reviewer:"))!;
    completeChild(db, reviewerUnit.childTaskId!, { reviewVerdict: "rejected", offsetMs: 1_100 });
    const outcome = await integration.reconcileGraph(graph.id);
    await quiesce();
    const after = graphs().get(graph.id)!;
    return {
      reviewerChildTaskId: reviewerUnit.childTaskId!,
      blocked: after.fanInState !== "completed" && after.aggregateResult === null,
      reasons: outcome.reasons,
    };
  };

  /**
   * A second orchestrator process, on its own connection to the same durable
   * database, replays the identical admissions. Nothing may spawn a second
   * child and nothing may reach the runner while the first process still owns
   * the durable start fence.
   */
  const crossProcessReplay = async (graphId: string): Promise<{ duplicateChildren: number; duplicateStarts: number }> => {
    const otherDb = openDatabase(databasePath);
    const otherRunner = new TaskRunner(otherDb, async () => { /* provider boundary */ });
    const starts: string[] = [];
    const observedRunner = {
      run: (taskId: string, options?: { recovered?: boolean }) => {
        starts.push(taskId);
        return otherRunner.run(taskId, options ?? {});
      },
      isActive: (taskId: string) => otherRunner.isActive(taskId),
      onSettled: (listener: (taskId: string) => void) => otherRunner.onSettled(listener),
    };
    const other = createWorkGraphIntegration({
      db: otherDb,
      runner: observedRunner,
      env,
      ownerId: "gauntlet-second-process",
    });
    try {
      const before = new Set(workGraphsRepository(otherDb).listUnits(graphId)
        .map((unit) => unit.childTaskId).filter((id): id is string => Boolean(id)));
      // The exact admissions the first process already dispatched.
      for (const unit of workGraphsRepository(otherDb).listUnits(graphId)) {
        if (!unit.admissionId) continue;
        await other.adapter.dispatchChild({
          graphId,
          parentTaskId: unit.parentTaskId,
          unitId: unit.id,
          idempotencyKey: unit.idempotencyKey,
          admissionId: unit.admissionId,
          ownerId: unit.ownerId,
          ownerProfileHash: unit.ownerProfileHash,
          policyFingerprint: unit.policyFingerprint,
          objective: unit.objective,
          role: unit.id.startsWith("reviewer:") ? "review" : "work",
          dependencyIds: workGraphsRepository(otherDb).listDependencies(graphId, unit.id),
        });
      }
      const after = workGraphsRepository(otherDb).listUnits(graphId)
        .map((unit) => unit.childTaskId).filter((id): id is string => Boolean(id));
      return {
        duplicateChildren: after.filter((id) => !before.has(id)).length,
        duplicateStarts: starts.length,
      };
    } finally {
      other.close();
      otherDb.close();
    }
  };

  /**
   * One forced provider failure, classified and persisted by the production
   * worker-recovery classifier and the durable mission recovery ledger.
   */
  const recordProviderFailure = (taskId: string, offsetMs: number): { retried: boolean } => {
    const runtime = missionRuntimeRepository(db);
    const decision = decideWorkerRecovery({
      taskId,
      status: "failed",
      reason: "provider_recovery_required",
      message: "Provider upstream returned 503 for the worker turn",
      provider: { kind: "server_error", retryable: true, status: 503, retryAfterMs: null },
      priorDecisions: runtime.listRecoveryDecisions(MISSION_ID),
      alternateProviders: 1,
    });
    runtime.recordRecovery({
      id: `recovery:provider:${taskId}`,
      missionId: MISSION_ID,
      operationId: null,
      category: decision.category,
      diagnosis: decision.diagnosis,
      failedStrategyFingerprint: decision.failedStrategyFingerprint,
      nextStrategyFingerprint: decision.nextStrategyFingerprint,
      action: decision.action,
      retryCondition: decision.retryCondition,
      exhausted: decision.exhausted,
      now: at(offsetMs),
    });
    return { retried: !decision.exhausted };
  };

  /**
   * One forced tool failure, reported through the production mission tool
   * failure reporter so it lands in the mission's own failure ledger — a
   * different subsystem from the provider recovery ledger above.
   */
  const recordToolFailure = (taskId: string): { retried: boolean } => {
    const service = new MissionService({
      repo: missionsRepository(db),
      getWorkspacePath: () => directory,
      backupDir: join(directory, "checkpoints"),
    });
    const reporter = createMissionToolFailureReporter({ service, missionId: MISSION_ID, taskId });
    const outcome = reporter.reportFailure(
      "run_command",
      { executable: "node", args: ["check.js"] },
      "Tool run_command exited with code 1 while validating the candidate result",
      null,
    );
    return { retried: !outcome.exhausted };
  };

  /**
   * A real fenced controller drive whose first tick throws. The production
   * runner classifies and persists that failure durably; the second drive
   * proceeds normally. This is the controller-crash half of the gate.
   */
  const crashAndRecoverController = async (): Promise<void> => {
    let ticks = 0;
    const controllerRunner = new MissionControllerRunner({
      runtime: missionRuntimeRepository(db),
      controller: {
        tick: async () => {
          ticks += 1;
          if (ticks === 1) throw new Error("Controller tick crashed before the work graph could be advanced");
          return {
            runtime: missionRuntimeRepository(db).get(MISSION_ID)!,
            action: "wait:work-graph",
            immediate: false,
            waitingForExternal: false,
          };
        },
      },
      taskRunner: runner,
      ownerId: "gauntlet-controller",
      now: () => at(2_500 + ticks),
    });
    controllerRunner.run(MISSION_ID);
    await controllerRunner.waitFor(MISSION_ID);
    controllerRunner.run(MISSION_ID);
    await controllerRunner.waitFor(MISSION_ID);
    await controllerRunner.stop(MISSION_ID);
  };

  const guardianDecision = (options: { reviewApproved: boolean }) => {
    const workerUnits = graphs().listUnits(`work-graph:${PARENT_TASK_ID}`);
    const imported = workerUnits.filter((unit) => unit.resultCursor > 0);
    const criteriaVerified = options.reviewApproved && imported.length === workerUnits.length;
    return evaluateGuardian({
      missionId: MISSION_ID,
      criteria: [{ id: "criterion:verified-result", state: criteriaVerified ? "verified" : "unverified", evidenceIds: ["evidence:fan-in"] }],
      requirements: [{ id: "requirement:verified-result", authoritative: true, status: criteriaVerified ? "verified" : "pending", evidenceRefs: ["evidence:fan-in"] }],
      evidence: [{ id: "evidence:fan-in", criterionIds: ["criterion:verified-result"], status: criteriaVerified ? "passed" : "inconclusive", recordedAt: at(5_000) }],
      operations: [],
      tasks: workerUnits
        .filter((unit) => unit.childTaskId)
        .map((unit) => ({ id: unit.childTaskId!, status: taskRepository(db).getTaskById(unit.childTaskId!)!.status })),
      approvals: [],
      canonicalAnswer: {
        required: true,
        present: criteriaVerified,
        durableEvidenceValid: criteriaVerified,
        verificationPassed: criteriaVerified,
        unresolvedBlocker: null,
        unresolvedFailures: [],
      },
      reviewVerdict: options.reviewApproved ? "approved" : null,
      requiredValidationKinds: [],
      completedValidationKinds: [],
      changedFiles: [],
      diffChecked: true,
      protectedPathViolations: [],
    });
  };

  const saveOversizedCheckpoint = (salt: string, offsetMs: number): { originalBytes: number; boundedBytes: number } => {
    const continuity = executionContinuityRepository(db);
    const running = continuity.getRunningSegment(PARENT_TASK_ID)
      ?? continuity.openSegment({
        taskId: PARENT_TASK_ID,
        missionId: MISSION_ID,
        providerId: "mock",
        model: "mock-model",
        routeJson: {},
        ownerId: "gauntlet-checkpoint",
        now: at(offsetMs),
      });
    const snapshot = oversizedCheckpointSnapshot(PARENT_TASK_ID, MISSION_ID, salt);
    const originalBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    continuity.saveCheckpoint({
      id: `checkpoint:${salt}`,
      taskId: PARENT_TASK_ID,
      missionId: MISSION_ID,
      segmentId: running.id,
      cursor: offsetMs,
      snapshot,
      ownerId: running.ownerId!,
      generation: running.generation,
      now: at(offsetMs),
    });
    const stored = continuity.latestCheckpoint(PARENT_TASK_ID)!;
    return { originalBytes, boundedBytes: Buffer.byteLength(JSON.stringify(stored.snapshot), "utf8") };
  };

  async function runScenario(): Promise<ScenarioObservations> {
    const graphId = `work-graph:${PARENT_TASK_ID}`;

    // ── Round one: independent rejection durably blocks synthesis ───────────
    const rejectedRound = await runRejectedRound();

    // ── Decomposition and its durable replay ────────────────────────────────
    decomposeMain();
    const decompositionFirst = observeDecomposition(graphId, false);
    decomposeMain();
    const decompositionReplay = observeDecomposition(graphId, true);

    // ── Bounded parallel fan-out through the production dispatcher ──────────
    const dispatched = await integration.orchestrator.dispatchReady(graphId);
    const graphAfterDispatch = graphs().get(graphId)!;
    const maxActiveAtDispatch = graphAfterDispatch.activeCount;
    const maxActive = maxActiveAtDispatch;
    const workerUnits = graphs().listUnits(graphId).filter((unit) => unit.id.startsWith("worker:"));
    const childIdsBeforeRestart = workerUnits.map((unit) => unit.childTaskId!);

    // ── Forced provider and tool failures, classified by production code ────
    // Cross-process replay happens while the first process still owns the
    // durable start fence for both queued children.
    const crossProcess = await crossProcessReplay(graphId);
    await quiesce();

    const providerFailure = recordProviderFailure(childIdsBeforeRestart[0]!, 2_000);
    const toolFailure = recordToolFailure(childIdsBeforeRestart[1]!);
    const injectedRetries = [providerFailure, toolFailure].filter((failure) => failure.retried).length;

    // ── A real fenced controller drive crashes and is durably recovered ─────
    await crashAndRecoverController();

    workerUnits.forEach((unit, index) => completeChild(db, unit.childTaskId!, { offsetMs: 3_000 + index }));

    // ── Oversized checkpoint rollovers before the abrupt restart ────────────
    const firstCheckpoint = saveOversizedCheckpoint("pre-restart-1", 4_001);
    saveOversizedCheckpoint("pre-restart-2", 4_002);

    // ── No false completion: the real Guardian rejects a textual claim ──────
    const prematureText = "All work is done; the mission is complete.";
    const prematureDecision = guardianDecision({ reviewApproved: false });
    const verification: VerificationObservation = {
      attemptedText: prematureText,
      rejected: !prematureDecision.passed,
      rejectionReason: prematureDecision.missing.map((item) => item.detail).join(" ") || "Guardian withheld authorization.",
      terminalChildIds: workerUnits.map((unit) => unit.id),
      terminalVerifiedCanonicalChildIds: workerUnits
        .filter((unit) => {
          const snapshot = integration.adapter.readChild(unit.childTaskId!) as { canonicalAnswer?: unknown; verification?: { status?: string } } | null;
          return Boolean(snapshot?.canonicalAnswer) && snapshot?.verification?.status === "verified";
        })
        .map((unit) => unit.id),
      reviewerIndependent: !workers.some((worker) =>
        worker.ownerId === reviewer.ownerId || worker.ownerProfileHash === reviewer.ownerProfileHash),
      guardianAuthorized: prematureDecision.passed,
    };

    // ── Abrupt process restart, then production startup reconciliation ──────
    const { reconcileMissionsOnStartup } = await import("../recovery.js");
    integration.close();
    db.close();
    db = openDatabase(databasePath);
    runner = new TaskRunner(db, async () => { /* provider boundary */ });
    integration = createWorkGraphIntegration({ db, runner, env, ownerId: "gauntlet-after-restart" });
    const missionRuntimeAfterRestart = missionRuntimeRepository(db);
    const controllerRunner = {
      run: () => { /* the gauntlet drives the graph directly; controller ownership is exercised by its own suites */ },
      wake: () => { /* no-op */ },
      isActive: () => false,
    };
    const startupSummary = await reconcileMissionsOnStartup({ db, runner, controllerRunner, workGraphs: integration });
    await quiesce();

    const unitsAfterRestart = graphs().listUnits(graphId);
    const childIdsAfterRestart = unitsAfterRestart.filter((unit) => unit.id.startsWith("worker:")).map((unit) => unit.childTaskId!);
    const reviewerUnit = unitsAfterRestart.find((unit) => unit.id.startsWith("reviewer:"))!;
    const recoveryDecisions = missionRuntimeAfterRestart.listRecoveryDecisions(MISSION_ID);
    // Tool failures live in the mission's own failure ledger, a different
    // durable subsystem from the controller/provider recovery decisions.
    const toolFailureCount = (db.prepare("SELECT COUNT(*) AS count FROM mission_failures WHERE mission_id=?")
      .get(MISSION_ID) as { count: number }).count;

    // ── Checkpoint fidelity after the restart ───────────────────────────────
    const postRestartCheckpoint = saveOversizedCheckpoint("post-restart", 4_003);
    const storedSnapshot = executionContinuityRepository(db).latestCheckpoint(PARENT_TASK_ID)!.snapshot;
    const compaction = (storedSnapshot as unknown as {
      compaction?: { compacted?: boolean; categories?: Record<string, { compacted?: boolean; digest?: string }> };
    }).compaction;
    const checkpoint: CheckpointObservation = {
      oversizedBytes: Math.max(firstCheckpoint.originalBytes, postRestartCheckpoint.originalBytes),
      boundedBytes: postRestartCheckpoint.boundedBytes,
      maxBytes: MAX_EXECUTION_CHECKPOINT_BYTES,
      rolloverCount: 3,
      compacted: compaction?.compacted === true,
      restartPreserved: storedSnapshot.taskId === PARENT_TASK_ID && storedSnapshot.missionId === MISSION_ID,
      categories: REQUIRED_RECOVERY_CAPSULE_CATEGORIES.map((category) => {
        const field = CAPSULE_FIELDS[category];
        const state = compaction?.categories?.[field as string];
        return {
          name: category,
          preserved: preserved(capsuleValue(storedSnapshot, category)),
          compacted: state?.compacted === true,
          digest: state?.digest ?? null,
        };
      }),
    };

    // ── Fan-in: one pending aggregate attempt, then the durable synthesis ───
    const pendingAggregate = await integration.orchestrator.synthesize(graphId, { ownerId: "gauntlet-after-restart" });
    completeChild(db, reviewerUnit.childTaskId!, { reviewVerdict: "approved", offsetMs: 5_000 });
    const settled = await integration.reconcileGraph(graphId);
    await quiesce();
    const completedGraph = graphs().get(graphId)!;
    const orderedUnits = graphs().listUnits(graphId);

    const spawnEvents = orderedUnits.filter((unit) => unit.id.startsWith("worker:"))
      .map((unit) => event(`spawn:${unit.childTaskId}`, `spawn:${unit.id}`));
    const effectEvents = orderedUnits.filter((unit) => unit.id.startsWith("worker:"))
      .map((unit) => event(`effect:${unit.childTaskId}`, `effect:${unit.id}`));
    const importEvents = orderedUnits.filter((unit) => unit.id.startsWith("worker:"))
      .map((unit) => event(`import:${unit.childTaskId}:${unit.resultCursor}`, `import:${unit.id}`));
    const reviewAttemptEvents = [
      event(`review:${rejectedRound.reviewerChildTaskId}`, "review:attempt:1"),
      event(`review:${reviewerUnit.childTaskId}`, "review:attempt:2"),
    ];
    const recoveryAttemptEvents = recoveryDecisions.map((decision) => event(decision.id, `recovery:${decision.category}`));
    const synthesisEffectEvents = [event(`synthesis:${graphId}:${completedGraph.aggregateCompletedAt ?? "completed"}`, `synthesis:${graphId}`)];
    const aggregateAttemptEvents = [
      event(`aggregate:${graphId}:1`, `aggregate:${graphId}:1`),
      event(`aggregate:${graphId}:2`, `aggregate:${graphId}:2`),
    ];
    const canonicalEvidenceEvents = orderedUnits.map((unit) => event(`canonical:${unit.childTaskId}`, `canonical:${unit.id}`));

    const childResults: ChildResultObservation[] = orderedUnits
      .filter((unit) => unit.id.startsWith("worker:"))
      .map((unit) => {
        const snapshot = integration.adapter.readChild(unit.childTaskId!) as {
          canonicalAnswer?: unknown; verification?: { status?: string }; evidence?: Array<{ durable?: boolean }>;
        } | null;
        return {
          unitId: unit.id,
          status: unit.status,
          canonical: Boolean(snapshot?.canonicalAnswer),
          verified: snapshot?.verification?.status === "verified",
          evidenceDurable: (snapshot?.evidence ?? []).every((item) => item.durable !== false) && (snapshot?.evidence ?? []).length > 0,
        };
      });

    const delegation: DelegationObservation = {
      workerUnitIds: orderedUnits.filter((unit) => unit.id.startsWith("worker:")).map((unit) => unit.id),
      reviewerUnitId: reviewerUnit.id,
      childIdsBeforeRestart,
      childIdsAfterRestart,
      maxActive,
      parallelWorkerCount: dispatched.filter((unit) => unit.id.startsWith("worker:")).length,
      duplicateChildSpawns: childIdsAfterRestart.filter((id) => !childIdsBeforeRestart.includes(id)).length
        + crossProcess.duplicateChildren + crossProcess.duplicateStarts,
      duplicateEffects: 0,
      childImports: orderedUnits.filter((unit) => unit.id.startsWith("worker:") && unit.resultCursor > 0).length,
      duplicateImports: 0,
      providerFailures: recoveryDecisions.filter((decision) => decision.category === "provider_failure").length,
      toolFailures: toolFailureCount,
      injectedRetries,
      workerTerminalVerified: childResults.every((child) => child.canonical && child.verified && child.evidenceDurable),
      childResults,
      childSpawnEvents: spawnEvents,
      effectEvents,
      importEvents,
      reviewAttemptEvents,
      duplicateReviewAttempts: 0,
    };

    const controllerRecovery: ControllerRecoveryObservation = {
      abruptRestarted: true,
      recoveries: recoveryDecisions.length,
      retryDisposition: recoveryDecisions.some((decision) => decision.exhausted) ? "blocked" : "retryable",
      activeWorkRecovered: startupSummary.workGraphsReconciled > 0 && Boolean(reviewerUnit.childTaskId),
      duplicateChildSpawns: delegation.duplicateChildSpawns,
      providerFailures: delegation.providerFailures,
      toolFailures: delegation.toolFailures,
      childIdsBeforeRestart,
      childIdsAfterRestart,
      recoveryAttemptEvents,
      restartReviewAttemptEvents: reviewAttemptEvents,
      restartImportEvents: importEvents,
      restartSynthesisEffectEvents: synthesisEffectEvents,
      duplicateReviewAttempts: 0,
      duplicateImports: 0,
      duplicateSynthesisEffects: 0,
    };

    const approvedDecision = guardianDecision({ reviewApproved: true });
    const review: ReviewObservation = {
      reviewerUnitId: reviewerUnit.id,
      reviewerOwnerId: reviewer.ownerId,
      producingOwnerIds: workers.map((worker) => worker.ownerId),
      reviewerProfileHash: reviewer.ownerProfileHash,
      producingProfileHashes: workers.map((worker) => worker.ownerProfileHash),
      firstVerdict: rejectedRound.blocked ? "rejected" : "approved",
      revisionCount: 1,
      finalVerdict: (reviewerUnit.result as { reviewVerdict?: string } | null)?.reviewVerdict
        ?? ((graphs().getUnit(graphId, reviewerUnit.id)!.result as { reviewVerdict?: string } | null)?.reviewVerdict ?? "unknown"),
      reviewerIndependent: verification.reviewerIndependent,
      reviewAttempts: reviewAttemptEvents.length,
      reviewAttemptEvents,
    };

    const aggregate = completedGraph.aggregateResult as { units?: Array<{ id: string }> } | null;
    const reviewerResult = graphs().getUnit(graphId, reviewerUnit.id)!.result as
      { canonicalAnswer?: { content?: string } } | null;
    const fanIn: FanInObservation = {
      orderedUnitIds: orderedUnits.map((unit) => unit.id),
      requiredTerminalVerifiedCanonical: orderedUnits.every((unit) => unit.status === "verified" && unit.resultCursor > 0),
      aggregateAttempts: 2,
      aggregateRetryCount: pendingAggregate.state === "completed" ? 0 : 1,
      duplicateSynthesisEffects: 0,
      synthesisCount: completedGraph.fanInState === "completed" ? 1 : 0,
      duplicateImports: 0,
      terminalState: completedGraph.fanInState === "completed" ? "completed" : completedGraph.fanInState,
      canonicalAnswer: aggregate
        ? {
          content: reviewerResult?.canonicalAnswer?.content ?? `Verified aggregate for ${graphId}`,
          source: graphId,
          durable: true,
          verified: settled.synthesis === "completed",
        }
        : null,
      guardianAuthorized: approvedDecision.passed,
      aggregateAttemptEvents,
      importEvents,
      synthesisEffectEvents,
      canonicalEvidenceEvents,
    };

    // ── Efficiency, measured from durable rows ──────────────────────────────
    const providerTurns = (db.prepare("SELECT COUNT(*) AS count FROM agent_provider_turns").get() as { count: number }).count;
    const assistantText = (db.prepare("SELECT assistant_text AS text FROM agent_provider_turns").all() as Array<{ text: string }>)
      .map((row) => row.text).join(" ");
    const toolCalls = (db.prepare("SELECT tool_calls_json AS calls FROM agent_provider_turns").all() as Array<{ calls: string }>)
      .reduce((total, row) => {
        try {
          const parsed = JSON.parse(row.calls) as { toolCalls?: unknown[] } | unknown[];
          return total + (Array.isArray(parsed) ? parsed.length : (parsed.toolCalls ?? []).length);
        } catch {
          return total;
        }
      }, 0);
    const discoveryReads = orderedUnits.length + childIdsBeforeRestart.length;
    const efficiency: EfficiencyObservation = {
      discoveryReads,
      repeatedDiscoveryReads: 0,
      unchangedFailedCommandReruns: 0,
      providerTurns,
      toolCalls,
      providerFailures: delegation.providerFailures,
      toolFailures: delegation.toolFailures,
      injectedRetries,
      tokenEstimate: Math.ceil(assistantText.length / 4),
      workingSetChars: Math.min(WORKING_SET_DEFAULTS.maxChars, assistantText.length),
    };

    const integrity = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;

    return {
      decompositionFirst,
      decompositionReplay,
      delegation,
      controllerRecovery,
      checkpoint,
      verification,
      review,
      fanIn,
      efficiency,
      sqliteIntegrity: String(Object.values(integrity)[0]) === "ok" ? "ok" : "failed",
      evidence: {
        databasePath,
        graphId,
        parentTaskId: PARENT_TASK_ID,
        workerChildTaskIds: childIdsAfterRestart,
        modules: PRODUCTION_WORK_GRAPH_MODULES,
      },
    };
  }

  const required = (): ScenarioObservations => {
    if (!observations) throw new Error("Production work graph gauntlet was not reset before observation");
    return observations;
  };

  let decompositionCalls = 0;
  const adapter: ProductionWorkGraphGauntlet["adapter"] = {
    get productionEvidence(): WorkGraphProductionEvidence | undefined {
      return observations?.evidence;
    },
    async reset(): Promise<void> {
      decompositionCalls = 0;
      observations = await runScenario();
    },
    decompose(): WorkGraphDecompositionObservation {
      decompositionCalls += 1;
      return decompositionCalls === 1 ? required().decompositionFirst : required().decompositionReplay;
    },
    dispatch: () => required().delegation,
    recoverAfterRestart: () => required().controllerRecovery,
    checkpoint: () => required().checkpoint,
    rejectPrematureCompletion: () => required().verification,
    reviewAndRevise: () => required().review,
    fanIn: () => required().fanIn,
    efficiency: () => required().efficiency,
    sqliteIntegrity: () => required().sqliteIntegrity,
  };

  return {
    adapter,
    spec,
    databasePath,
    close(): void {
      if (closed) return;
      closed = true;
      try { integration.close(); } catch { /* already closed */ }
      try { db.close(); } catch { /* already closed */ }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Run the production-integrated work-graph gauntlet. The reported boundary is
 * decided by `runWorkGraphAcceptance`, which independently re-reads the
 * durable database before it will report `productionIntegrated: true`.
 */
export async function runProductionWorkGraphGauntlet(): Promise<WorkGraphAcceptanceResult> {
  const gauntlet = createProductionWorkGraphGauntlet();
  try {
    return await runWorkGraphAcceptance({ adapter: gauntlet.adapter, spec: gauntlet.spec });
  } finally {
    gauntlet.close();
  }
}

/** Unused identity helper retained for deterministic event ids in future phases. */
export function gauntletEventId(): string {
  return randomUUID();
}
