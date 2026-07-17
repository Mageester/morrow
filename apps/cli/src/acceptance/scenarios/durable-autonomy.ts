import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MissionRecoveryCategory, MissionRuntimeState } from "@morrow/contracts";
import {
  MissionController,
  missionRuntimeRepository,
  missionsRepository,
  openDatabase,
  projectRepository,
  taskRepository,
  type ControllerSnapshot,
} from "@morrow/orchestrator";

export const DURABLE_AUTONOMY_FAULTS = [
  "premature_completion",
  "context_rollover",
  "provider_failure",
  "false_no_progress",
  "abrupt_process_restart",
] as const;

export type DurableAutonomyFault = (typeof DURABLE_AUTONOMY_FAULTS)[number];

export interface DurableAutonomyScenarioResult {
  fault: DurableAutonomyFault;
  passed: boolean;
  message: string | null;
  missionId: string;
  missionIds: string[];
  terminalState: MissionRuntimeState | null;
  operationKeys: string[];
  operationKinds: string[];
  recoveryCategories: MissionRecoveryCategory[];
  dispatchCount: number;
  guardianRejections: number;
  waitTicks: number;
  controllerOwners: string[];
}

export interface DurableAutonomyResult {
  scenarioId: "durable-autonomy-v1";
  scenarios: DurableAutonomyScenarioResult[];
}

const NOW = "2026-07-16T16:00:00.000Z";
const EXPIRES = "2026-07-16T17:00:00.000Z";

const passedGuardian = (missionId: string) => ({
  passed: true,
  missing: [],
  failed: [],
  blocked: [],
  nextActions: [],
  evidenceSnapshot: {
    missionId,
    criteria: { total: 1, satisfied: 1 },
    requirements: { authoritative: 1, satisfied: 1 },
    evidence: { passed: 1, failed: 0, inconclusive: 0 },
    operations: { resolved: 1, unresolved: 0 },
    tasks: { resolved: 1, unresolved: 0 },
    approvals: { resolved: 0, unresolved: 0 },
    validation: { required: ["tests"], completed: ["tests"] },
    changedFiles: ["sum.js"],
  },
});

const rejectedGuardian = (missionId: string) => ({
  ...passedGuardian(missionId),
  passed: false,
  missing: [{ kind: "criterion" as const, id: "criterion-1", criterionId: "criterion-1", detail: "Criterion lacks direct passed evidence." }],
  nextActions: ["validate_criteria", "run_required_validation"],
  evidenceSnapshot: {
    ...passedGuardian(missionId).evidenceSnapshot,
    criteria: { total: 1, satisfied: 0 },
    validation: { required: ["tests"], completed: [] },
  },
});

export async function runDurableAutonomyScenarios(input: { root: string }): Promise<DurableAutonomyResult> {
  mkdirSync(input.root, { recursive: true });
  const scenarios: DurableAutonomyScenarioResult[] = [];
  for (const fault of DURABLE_AUTONOMY_FAULTS) {
    scenarios.push(await runFault(join(input.root, fault), fault));
  }
  return { scenarioId: "durable-autonomy-v1", scenarios };
}

async function runFault(root: string, fault: DurableAutonomyFault): Promise<DurableAutonomyScenarioResult> {
  mkdirSync(root, { recursive: true });
  const missionId = `mission-acceptance-${fault}`;
  const db = openDatabase(join(root, "runtime.db"));
  const runtime = missionRuntimeRepository(db);
  const projects = projectRepository(db);
  const tasks = taskRepository(db);
  const missions = missionsRepository(db);
  const taskStates = new Map<string, "running" | "completed" | "interrupted">();
  const controllerOwners: string[] = [];
  let dispatchCount = 0;
  let guardianRejections = 0;
  let waitTicks = 0;
  let validationPassed = fault !== "premature_completion";

  try {
    projects.createProject({ id: "project-acceptance", name: "Durable acceptance", workspacePath: root, createdAt: NOW });
    missions.create({
      id: missionId,
      projectId: "project-acceptance",
      objective: `Prove durable recovery from ${fault}`,
      autoApprove: true,
      budget: { maxUsd: null, maxAttempts: null, maxReviewCycles: 2, spentUsd: 0, attemptsUsed: 0, reviewCyclesUsed: 0 },
    }, NOW);
    runtime.create({ missionId, now: NOW });

    const snapshot = (): ControllerSnapshot => {
      const activeTaskId = runtime.get(missionId)?.activeTaskId;
      const recovery = activeTaskId && taskStates.get(activeTaskId) === "interrupted"
        ? fault === "context_rollover"
          ? {
              category: "context_exhaustion" as const,
              diagnosis: "Deterministic context boundary reached after a durable checkpoint.",
              failedStrategyFingerprint: "worker:primary",
              nextStrategyFingerprint: "worker:compacted-context",
              action: "compact_context" as const,
              retryCondition: "checkpoint persisted",
              exhausted: false,
            }
          : {
              category: "provider_failure" as const,
              diagnosis: "Injected provider turn failure.",
              failedStrategyFingerprint: "provider:primary",
              nextStrategyFingerprint: "provider:fallback",
              action: "switch_provider" as const,
              retryCondition: "fallback provider available",
              exhausted: false,
            }
        : null;
      return {
        tasks: [...taskStates].map(([id, status]) => ({ id, status })),
        approvals: [],
        guardianDecision: validationPassed ? passedGuardian(missionId) : rejectedGuardian(missionId),
        recovery,
      };
    };

    const dependencies = {
      runtime,
      loadSnapshot: snapshot,
      dispatchWorker: ({ idempotencyKey }: { missionId: string; idempotencyKey: string }) => {
        dispatchCount += 1;
        const taskId = `task-${fault}-${dispatchCount}`;
        const firstFaultedWorker = dispatchCount === 1 && (fault === "context_rollover" || fault === "provider_failure");
        const heldWorker = dispatchCount === 1 && (fault === "false_no_progress" || fault === "abrupt_process_restart");
        const status = firstFaultedWorker ? "interrupted" : heldWorker ? "running" : "completed";
        tasks.createTask({
          id: taskId,
          projectId: "project-acceptance",
          missionId,
          kind: "agent",
          status,
          idempotencyKey,
          createdAt: NOW,
        });
        taskStates.set(taskId, status);
        return { taskId };
      },
      finalizeMission: () => undefined,
      validateMission: () => { validationPassed = true; },
      now: () => NOW,
    };

    let controller = new MissionController(dependencies);
    const claim = (ownerId: string) => {
      const fence = runtime.claimLease({ missionId, ownerId, now: NOW, expiresAt: EXPIRES });
      if (!fence) throw new Error(`Could not claim controller lease for ${ownerId}`);
      controllerOwners.push(ownerId);
      return fence;
    };
    let fence = claim(fault === "abrupt_process_restart" ? "controller-before" : "controller-primary");
    const tick = async () => {
      const before = runtime.get(missionId);
      if (before?.state === "validating" && !snapshot().guardianDecision.passed) guardianRejections += 1;
      const result = await controller.tick(missionId, fence);
      if (result.action.startsWith("wait:")) waitTicks += 1;
      return result;
    };

    while (dispatchCount === 0) await tick();

    if (fault === "false_no_progress") {
      for (let index = 0; index < 4; index += 1) await tick();
      const taskId = runtime.get(missionId)?.activeTaskId;
      if (!taskId) throw new Error("No active worker during no-progress probe");
      taskStates.set(taskId, "completed");
      tasks.updateTaskStatus(taskId, { status: "completed", updatedAt: NOW, completedAt: NOW });
    }

    if (fault === "abrupt_process_restart") {
      const taskId = runtime.get(missionId)?.activeTaskId;
      if (!taskId) throw new Error("No active worker before restart");
      taskStates.set(taskId, "completed");
      tasks.updateTaskStatus(taskId, { status: "completed", updatedAt: NOW, completedAt: NOW });
      if (!runtime.releaseLease({ missionId, fence, now: NOW })) throw new Error("Could not release pre-restart lease");
      controller = new MissionController(dependencies);
      fence = claim("controller-after");
    }

    for (let ticks = 0; ticks < 30 && runtime.get(missionId)?.state !== "completed"; ticks += 1) await tick();

    const operations = runtime.listOperations(missionId);
    const transitions = runtime.listTransitions(missionId);
    const recoveries = runtime.listRecoveryDecisions(missionId);
    const terminalState = runtime.get(missionId)?.state ?? null;
    const missionIds = [...new Set([
      ...operations.map((item) => item.missionId),
      ...transitions.map((item) => item.missionId),
      ...recoveries.map((item) => item.missionId),
    ])];
    const operationKeys = operations.map((item) => item.idempotencyKey);
    const uniqueOperations = new Set(operationKeys).size === operationKeys.length;
    const faultPassed = terminalState === "completed"
      && missionIds.length === 1
      && missionIds[0] === missionId
      && uniqueOperations
      && dispatchCount > 0
      && (fault !== "premature_completion" || guardianRejections > 0)
      && (fault !== "context_rollover" || recoveries.some((item) => item.category === "context_exhaustion"))
      && (fault !== "provider_failure" || recoveries.some((item) => item.category === "provider_failure"))
      && (fault !== "false_no_progress" || waitTicks >= 4)
      && (fault !== "abrupt_process_restart" || dispatchCount === 1);

    return {
      fault,
      passed: faultPassed,
      message: faultPassed ? null : `terminal=${terminalState}; missions=${missionIds.join(",")}; dispatches=${dispatchCount}`,
      missionId,
      missionIds,
      terminalState,
      operationKeys,
      operationKinds: operations.map((item) => item.kind),
      recoveryCategories: recoveries.map((item) => item.category),
      dispatchCount,
      guardianRejections,
      waitTicks,
      controllerOwners,
    };
  } catch (error) {
    return {
      fault,
      passed: false,
      message: error instanceof Error ? error.message : String(error),
      missionId,
      missionIds: [],
      terminalState: runtime.get(missionId)?.state ?? null,
      operationKeys: runtime.get(missionId) ? runtime.listOperations(missionId).map((item) => item.idempotencyKey) : [],
      operationKinds: runtime.get(missionId) ? runtime.listOperations(missionId).map((item) => item.kind) : [],
      recoveryCategories: runtime.get(missionId) ? runtime.listRecoveryDecisions(missionId).map((item) => item.category) : [],
      dispatchCount,
      guardianRejections,
      waitTicks,
      controllerOwners,
    };
  } finally {
    db.close();
  }
}
