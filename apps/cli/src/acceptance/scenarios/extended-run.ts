import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MissionRecoveryCategory, MissionRuntimeState } from "@morrow/contracts";
import {
  executionContinuityRepository,
  missionRuntimeRepository,
  missionsRepository,
  openDatabase,
  projectRepository,
  taskRepository,
  type ExecutionCheckpointSnapshot,
} from "@morrow/orchestrator";

export interface ExtendedProductiveMissionResult {
  scenarioId: "extended-productive-run-v1";
  passed: boolean;
  message: string | null;
  missionId: string;
  terminalState: MissionRuntimeState | null;
  workUnits: number;
  progressObservations: number;
  checkpoints: number;
  contextSegments: number;
  contextBoundaryReasons: string[];
  recoveryCategories: MissionRecoveryCategory[];
  databaseRestarts: number;
  processHealth: "ok" | "failed";
  deadlineMs: null;
  userContinuations: 0;
  wallClockMs: number;
}

const PROJECT_ID = "project-extended-acceptance";
const MISSION_ID = "mission-acceptance-extended-productive";
const TASK_ID = "task-acceptance-extended-productive";
const OWNER_ID = "extended-acceptance-worker";
const WORK_UNITS = 96;
const BASE_TIME = Date.parse("2026-07-16T18:00:00.000Z");

const at = (unit: number): string => new Date(BASE_TIME + unit * 1_000).toISOString();

function checkpointSnapshot(unit: number): ExecutionCheckpointSnapshot {
  return {
    version: 1,
    originalMission: "Complete a productive extended workload without an arbitrary wall-clock deadline.",
    hardRequirements: ["persist progress", "checkpoint before rollover", "finish without user continuation"],
    prohibitedActions: ["artificial sleep", "discard durable state", "request continuation"],
    acceptanceCriteria: ["96 work units", "8 checkpoints", "4 context segments", "terminal completion"],
    decisions: ["Use durable event cursors as the work-unit boundary."],
    completedWork: [`Completed ${unit} of ${WORK_UNITS} work units.`],
    currentPhase: unit === WORK_UNITS ? "final validation" : "productive execution",
    filesChanged: [],
    gitStatus: "unchanged",
    tests: [{ command: "durable-ledger-integrity", exitCode: 0, result: `checkpoint ${unit / 12} passed` }],
    unresolvedFailures: [],
    recoveryAttempts: unit >= 68 ? ["provider retry succeeded", "alternate tool succeeded"] : unit >= 37 ? ["provider retry succeeded"] : [],
    pendingWork: unit === WORK_UNITS ? [] : [`Complete work units ${unit + 1}-${WORK_UNITS}.`],
    approvals: {},
    taskId: TASK_ID,
    missionId: MISSION_ID,
    providerRouting: { providerId: "acceptance", model: "deterministic-worker", preset: "coding" },
    providerContinuationRefs: [],
    evidenceRequired: ["progress observations", "checkpoint ledger", "segment boundaries", "terminal runtime state"],
  };
}

export async function runExtendedProductiveMission(input: { root: string }): Promise<ExtendedProductiveMissionResult> {
  const startedAt = Date.now();
  mkdirSync(input.root, { recursive: true });
  const databasePath = join(input.root, "extended-runtime.db");
  let db = openDatabase(databasePath);
  let runtime = missionRuntimeRepository(db);
  let missions = missionsRepository(db);
  let tasks = taskRepository(db);
  let continuity = executionContinuityRepository(db);
  let databaseRestarts = 0;
  let completedUnits = 0;

  try {
    projectRepository(db).createProject({ id: PROJECT_ID, name: "Extended productive acceptance", workspacePath: input.root, createdAt: at(0) });
    missions.create({
      id: MISSION_ID,
      projectId: PROJECT_ID,
      objective: "Complete a productive extended workload without an arbitrary wall-clock deadline.",
      autoApprove: true,
      budget: { maxUsd: null, maxAttempts: null, maxReviewCycles: 2, spentUsd: 0, attemptsUsed: 0, reviewCyclesUsed: 0 },
    }, at(0));
    runtime.create({ missionId: MISSION_ID, now: at(0) });
    runtime.transition({ missionId: MISSION_ID, from: "created", to: "orienting", cause: "acceptance_started", actor: "controller", now: at(1) });
    runtime.transition({ missionId: MISSION_ID, from: "orienting", to: "planning", cause: "requirements_loaded", actor: "controller", now: at(2) });
    runtime.transition({ missionId: MISSION_ID, from: "planning", to: "executing", cause: "plan_ready", actor: "controller", now: at(3) });
    tasks.createTask({
      id: TASK_ID,
      projectId: PROJECT_ID,
      missionId: MISSION_ID,
      kind: "agent",
      status: "running",
      idempotencyKey: "extended-productive-work-v1",
      createdAt: at(3),
      startedAt: at(3),
    });

    let segment = continuity.openSegment({
      taskId: TASK_ID,
      missionId: MISSION_ID,
      providerId: "acceptance",
      model: "deterministic-worker",
      routeJson: { preset: "coding", deadlineMs: null },
      ownerId: OWNER_ID,
      now: at(3),
    });

    const progressKinds = ["artifact_changed", "tool_result_observed", "evidence_gained", "uncertainty_reduced"] as const;
    for (let unit = 1; unit <= WORK_UNITS; unit += 1) {
      runtime.appendProgress({
        id: `progress-work-${unit}`,
        missionId: MISSION_ID,
        operationId: null,
        kind: progressKinds[(unit - 1) % progressKinds.length]!,
        summary: `Completed productive work unit ${unit} of ${WORK_UNITS}.`,
        evidenceIds: [`work-unit-${unit}`],
        strategyFingerprint: `extended-segment-${segment.sequence}`,
        now: at(3 + unit),
      });
      completedUnits = unit;

      if (unit === 37) {
        runtime.recordRecovery({
          id: "recovery-provider-37",
          missionId: MISSION_ID,
          operationId: null,
          category: "provider_failure",
          diagnosis: "Injected transient provider failure during productive work.",
          failedStrategyFingerprint: "provider:primary",
          nextStrategyFingerprint: "provider:primary-retry",
          action: "retry_same_provider",
          retryCondition: "transient fault cleared",
          exhausted: false,
          now: at(41),
        });
        runtime.appendProgress({
          id: "progress-provider-recovered",
          missionId: MISSION_ID,
          operationId: null,
          kind: "strategy_changed",
          summary: "Recovered from the injected provider failure and resumed productive work.",
          evidenceIds: ["recovery-provider-37"],
          strategyFingerprint: "provider:primary-retry",
          now: at(42),
        });
      }

      if (unit === 68) {
        runtime.recordRecovery({
          id: "recovery-tool-68",
          missionId: MISSION_ID,
          operationId: null,
          category: "tool_failure",
          diagnosis: "Injected tool failure during productive work.",
          failedStrategyFingerprint: "tool:primary",
          nextStrategyFingerprint: "tool:alternate",
          action: "change_tool",
          retryCondition: "alternate tool available",
          exhausted: false,
          now: at(72),
        });
        runtime.appendProgress({
          id: "progress-tool-recovered",
          missionId: MISSION_ID,
          operationId: null,
          kind: "strategy_changed",
          summary: "Recovered from the injected tool failure with an alternate tool.",
          evidenceIds: ["recovery-tool-68"],
          strategyFingerprint: "tool:alternate",
          now: at(73),
        });
      }

      if (unit % 12 === 0) {
        const checkpointId = `checkpoint-${unit}`;
        missions.addCheckpoint({
          id: checkpointId,
          missionId: MISSION_ID,
          label: `Productive checkpoint ${unit / 12}`,
          reason: `Durably persisted work through unit ${unit}.`,
          gitRef: null,
          checkpointName: `extended-unit-${unit}`,
          affectedFiles: [],
          rollbackAvailable: true,
          createdAt: at(100 + unit),
        });
        continuity.saveCheckpoint({
          id: `execution-${checkpointId}`,
          taskId: TASK_ID,
          missionId: MISSION_ID,
          segmentId: segment.id,
          cursor: unit,
          snapshot: checkpointSnapshot(unit),
          ownerId: OWNER_ID,
          generation: segment.generation,
          now: at(100 + unit),
        });
        runtime.appendProgress({
          id: `progress-checkpoint-${unit}`,
          missionId: MISSION_ID,
          operationId: null,
          kind: "checkpoint_created",
          summary: `Created durable checkpoint at work unit ${unit}.`,
          evidenceIds: [checkpointId, `execution-${checkpointId}`],
          strategyFingerprint: `extended-segment-${segment.sequence}`,
          now: at(101 + unit),
        });
      }

      if (unit === 24 || unit === 48 || unit === 72) {
        segment = continuity.rolloverSegment({
          taskId: TASK_ID,
          currentSegmentId: segment.id,
          reason: "context_pressure",
          providerId: "acceptance",
          model: "deterministic-worker",
          routeJson: { preset: "coding", deadlineMs: null, resumedFromCursor: unit },
          ownerId: OWNER_ID,
          generation: segment.generation,
          now: at(200 + unit),
        });
      }

      if (unit === 50) {
        db.close();
        db = openDatabase(databasePath);
        runtime = missionRuntimeRepository(db);
        missions = missionsRepository(db);
        tasks = taskRepository(db);
        continuity = executionContinuityRepository(db);
        const resumed = continuity.getRunningSegment(TASK_ID);
        if (!resumed || resumed.id !== segment.id || resumed.generation !== segment.generation) {
          throw new Error("Database restart did not preserve the active execution segment.");
        }
        segment = resumed;
        databaseRestarts += 1;
      }
    }

    if (!continuity.completeSegment(segment.id, at(400), { ownerId: OWNER_ID, generation: segment.generation })) {
      throw new Error("Could not complete the final execution segment.");
    }
    tasks.updateTaskStatus(TASK_ID, { status: "completed", updatedAt: at(401), completedAt: at(401) });
    runtime.transition({ missionId: MISSION_ID, from: "executing", to: "validating", cause: "productive_work_complete", actor: "controller", now: at(402) });
    runtime.appendProgress({
      id: "progress-validation-complete",
      missionId: MISSION_ID,
      operationId: null,
      kind: "criterion_validated",
      summary: "Validated all extended productive-run acceptance criteria.",
      evidenceIds: ["extended-run-ledger"],
      strategyFingerprint: "guardian:extended-run",
      now: at(403),
    });
    runtime.transition({ missionId: MISSION_ID, from: "validating", to: "completed", cause: "guardian_passed", actor: "guardian", now: at(404) });

    const terminalState = runtime.get(MISSION_ID)?.state ?? null;
    const progressObservations = runtime.listProgress(MISSION_ID).length;
    const checkpoints = missions.listCheckpoints(MISSION_ID).length;
    const segments = continuity.listSegments(TASK_ID);
    const recoveries = runtime.listRecoveryDecisions(MISSION_ID);
    const integrity = db.prepare("PRAGMA integrity_check").pluck().get();
    const processHealth = integrity === "ok" ? "ok" : "failed";
    const passed = completedUnits === WORK_UNITS
      && progressObservations >= WORK_UNITS
      && checkpoints >= 8
      && segments.length >= 4
      && segments.filter((item) => item.boundaryReason === "context_pressure").length >= 3
      && recoveries.some((item) => item.category === "provider_failure")
      && recoveries.some((item) => item.category === "tool_failure")
      && databaseRestarts === 1
      && processHealth === "ok"
      && terminalState === "completed";

    return {
      scenarioId: "extended-productive-run-v1",
      passed,
      message: passed ? null : `units=${completedUnits}; progress=${progressObservations}; checkpoints=${checkpoints}; segments=${segments.length}; state=${terminalState}; integrity=${String(integrity)}`,
      missionId: MISSION_ID,
      terminalState,
      workUnits: completedUnits,
      progressObservations,
      checkpoints,
      contextSegments: segments.length,
      contextBoundaryReasons: segments.map((item) => item.boundaryReason).filter((reason): reason is string => reason !== null),
      recoveryCategories: recoveries.map((item) => item.category),
      databaseRestarts,
      processHealth,
      deadlineMs: null,
      userContinuations: 0,
      wallClockMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      scenarioId: "extended-productive-run-v1",
      passed: false,
      message: error instanceof Error ? error.message : String(error),
      missionId: MISSION_ID,
      terminalState: runtime.get(MISSION_ID)?.state ?? null,
      workUnits: completedUnits,
      progressObservations: runtime.get(MISSION_ID) ? runtime.listProgress(MISSION_ID).length : 0,
      checkpoints: missions.get(MISSION_ID) ? missions.listCheckpoints(MISSION_ID).length : 0,
      contextSegments: tasks.getTaskById(TASK_ID) ? continuity.listSegments(TASK_ID).length : 0,
      contextBoundaryReasons: tasks.getTaskById(TASK_ID) ? continuity.listSegments(TASK_ID).map((item) => item.boundaryReason).filter((reason): reason is string => reason !== null) : [],
      recoveryCategories: runtime.get(MISSION_ID) ? runtime.listRecoveryDecisions(MISSION_ID).map((item) => item.category) : [],
      databaseRestarts,
      processHealth: "failed",
      deadlineMs: null,
      userContinuations: 0,
      wallClockMs: Date.now() - startedAt,
    };
  } finally {
    db.close();
  }
}
