import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../database.js";
import { projectRepository } from "../repositories/projects.js";
import { missionsRepository } from "../repositories/missions.js";
import { missionRuntimeRepository } from "../repositories/mission-runtime.js";
import { executionContinuityRepository } from "../repositories/execution-continuity.js";
import { MissionService } from "../mission/service.js";
import { TaskRunner } from "../runner.js";
import { createDefaultMissionControllerRunner, isMissionRuntimeTerminal } from "../mission/controller-runner.js";
import { reconcileMissionsOnStartup } from "../recovery.js";
import { executeAgentChatTask } from "../execution/agent.js";
import type { AiProvider, ChatMessage, ProviderChunk } from "../provider/base.js";

const WORK_UNITS = 96;

/**
 * Small window so real context accounting reaches pressure on real history,
 * without needing thousands of turns to trigger a rollover.
 */
const ROUTE = {
  providerId: "mock" as const,
  protocol: "openai-chat" as const,
  endpointKind: "default" as const,
  endpointHost: null,
  endpointLimitTokens: 24_000,
  endpointLimitSource: "provider-metadata" as const,
};

export interface SustainedAutonomyAcceptanceResult {
  scenarioId: "sustained-autonomy-v1";
  passed: boolean;
  message: string | null;
  missionId: string;
  terminalState: string | null;
  productiveWorkUnits: number;
  progressObservationCount: number;
  contextRolloverCount: number;
  checkpointCount: number;
  recoveryCount: number;
  recoveryCategories: string[];
  databaseRestartCount: number;
  leaseGenerationBeforeRestart: number;
  leaseGenerationAfterRestart: number;
  duplicateCompletedOperations: number;
  guardianRejectionCount: number;
  guardianAuthorizationCount: number;
  transitionActors: string[];
  operationKinds: string[];
  sqliteIntegrity: "ok" | "failed";
  deadlineMs: null;
  userContinuations: 0;
  wallClockMs: number;
}

interface Script {
  readUnits: number;
  providerFailures: number;
  malformedResults: number;
  wroteBroken: boolean;
  wroteFixed: boolean;
  verifiedFix: boolean;
}

/**
 * Deterministic provider. This is the only injected boundary: it stands in for
 * the external model, using the documented TaskRunner executor/completion
 * injection seam. Every durable effect this scenario measures is produced by
 * production code (MissionControllerRunner, TaskRunner, executeAgentChatTask,
 * the recovery planner, and the real Guardian) reacting to these turns.
 */
function scriptedProvider(script: Script, phase: "break" | "fix"): AiProvider {
  return {
    id: "mock",
    route: ROUTE,
    async *streamChat(_messages: ChatMessage[]): AsyncIterable<ProviderChunk> {
      if (phase === "break") {
        if (script.readUnits === 12 && script.providerFailures === 0) {
          script.providerFailures += 1;
          throw new Error("Injected transient provider failure");
        }
        if (script.readUnits === 20 && script.malformedResults === 0) {
          script.malformedResults += 1;
          yield { type: "tool_call", toolCalls: [{ id: "bad-args", index: 0, type: "function", function: { name: "read_file", arguments: "{not valid json" } }] };
          yield { type: "done" };
          return;
        }
        if (script.readUnits < WORK_UNITS) {
          script.readUnits += 1;
          yield { type: "tool_call", toolCalls: [{ id: `read-${script.readUnits}`, index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `inputs/unit-${script.readUnits}.txt` }) } }] };
          yield { type: "done" };
          return;
        }
        if (!script.wroteBroken) {
          script.wroteBroken = true;
          yield { type: "tool_call", toolCalls: [{ id: "write-broken", index: 0, type: "function", function: { name: "create_file", arguments: JSON.stringify({ path: "result.json", content: JSON.stringify({ ok: false, units: script.readUnits }) }) } }] };
          yield { type: "done" };
          return;
        }
      } else if (!script.wroteFixed) {
        script.wroteFixed = true;
        yield { type: "tool_call", toolCalls: [{ id: "write-fixed", index: 0, type: "function", function: { name: "create_file", arguments: JSON.stringify({ path: "result.json", content: JSON.stringify({ ok: true, units: WORK_UNITS }) }) } }] };
        yield { type: "done" };
        return;
      } else if (!script.verifiedFix) {
        script.verifiedFix = true;
        yield { type: "tool_call", toolCalls: [{ id: "verify-fixed", index: 0, type: "function", function: { name: "run_command", arguments: JSON.stringify({ executable: "node", args: ["check.js"], purpose: "verify result.json reports ok" }) } }] };
        yield { type: "done" };
        return;
      }
      yield { type: "text", text: `Read ${script.readUnits} inputs and wrote result.json. Candidate ready for the Guardian.` };
      yield { type: "done" };
    },
  };
}

export async function runSustainedAutonomyAcceptance(input: { root: string }): Promise<SustainedAutonomyAcceptanceResult> {
  const startedAt = Date.now();
  mkdirSync(input.root, { recursive: true });
  const workspace = mkdtempSync(join(input.root, "ws-"));
  const home = mkdtempSync(join(input.root, "home-"));
  const dbPath = join(input.root, "runtime.sqlite");
  const env = { ...process.env, MOCK_PROVIDER: "true", MORROW_HOME: home };

  mkdirSync(join(workspace, "inputs"), { recursive: true });
  writeFileSync(join(workspace, "check.js"), [
    "const { readFileSync } = require('node:fs');",
    "let ok = false;",
    "try { ok = JSON.parse(readFileSync('result.json', 'utf8')).ok === true; } catch { ok = false; }",
    "process.exit(ok ? 0 : 1);",
  ].join("\n"));
  for (let index = 1; index <= WORK_UNITS; index += 1) {
    writeFileSync(join(workspace, "inputs", `unit-${index}.txt`), `value=${index}\n${"pad ".repeat(200)}`);
  }

  const script: Script = { readUnits: 0, providerFailures: 0, malformedResults: 0, wroteBroken: false, wroteFixed: false, verifiedFix: false };
  let db = openDatabase(dbPath);
  let missionId = "";

  try {
    const at = new Date().toISOString();
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: at });

    const completion = async (_m: ChatMessage[], o: { purpose: "planning" | "review" }) => o.purpose === "review"
      ? { text: JSON.stringify({ verdict: "approved", recommendedStatus: "completed", criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [], concerns: [], summary: "Verified." }), provider: "mock", model: "reviewer" }
      : { text: "[]", provider: "mock", model: "planner" };

    const fixtureService = new MissionService({
      repo: missionsRepository(db), getWorkspacePath: () => workspace,
      backupDir: join(home, "checkpoints"), completion,
    });
    const mission = fixtureService.create("p", { objective: `Read ${WORK_UNITS} inputs and produce a verified result.json.`, autoApprove: true });
    missionId = mission.id;
    fixtureService.addCriterion(mission.id, "result.json reports ok", {
      kind: "command",
      command: "node check.js",
      expectExitCode: 0,
    });
    fixtureService.approveCriteria(mission.id);
    missionRuntimeRepository(db).create({ missionId: mission.id, now: at });

    const missionTaskIds = (): string[] =>
      (db.prepare("SELECT id FROM tasks WHERE mission_id=? ORDER BY created_at,id").all(mission.id) as Array<{ id: string }>)
        .map((row) => row.id);

    const buildStack = (phase: "break" | "fix", ownerId: string) => {
      const runner = new TaskRunner(db, async ({ db: taskDb, taskId, abortSignal, recovery }) => {
        await executeAgentChatTask({
          db: taskDb, taskId,
          provider: scriptedProvider(script, phase),
          maxTurns: 200,
          ...(abortSignal ? { abortSignal } : {}),
          ...(recovery ? { recovery } : {}),
        });
      });
      return { runner, controller: createDefaultMissionControllerRunner({ db, taskRunner: runner, env, ownerId, completion }) };
    };

    type Stack = ReturnType<typeof buildStack>;
    const drive = async (stack: Stack, done: () => boolean, budgetMs: number): Promise<void> => {
      const deadline = Date.now() + budgetMs;
      stack.controller.run(mission.id);
      while (Date.now() < deadline && !done()) {
        const runtime = missionRuntimeRepository(db).get(mission.id)!;
        if (isMissionRuntimeTerminal(runtime)) break;
        await stack.controller.waitFor(mission.id);
        const activeTaskId = missionRuntimeRepository(db).get(mission.id)?.activeTaskId;
        if (activeTaskId && stack.runner.isActive(activeTaskId)) await stack.runner.waitFor(activeTaskId);
        else if (!stack.controller.isActive(mission.id)) stack.controller.run(mission.id);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    };
    const settleActive = async (stack: Stack): Promise<void> => {
      await stack.controller.waitFor(mission.id);
      for (const id of missionTaskIds()) {
        if (stack.runner.isActive(id)) await stack.runner.waitFor(id);
      }
      await stack.controller.waitFor(mission.id);
    };
    const rejected = () => missionRuntimeRepository(db).listTransitions(mission.id).some((t) => t.cause === "guardian_rejected");

    let stack = buildStack("break", "controller-before-restart");
    await drive(stack, () => script.readUnits >= WORK_UNITS && rejected(), 60_000);
    await settleActive(stack);

    const beforeRestartOps = missionRuntimeRepository(db).listOperations(mission.id)
      .filter((o) => o.status === "completed").map((o) => o.idempotencyKey);
    const leaseGenerationBeforeRestart = missionRuntimeRepository(db).get(mission.id)!.leaseGeneration;

    db.close();
    db = openDatabase(dbPath);
    const databaseRestartCount = 1;

    stack = buildStack("fix", "controller-after-restart");
    const reconciliation = reconcileMissionsOnStartup({ db, runner: stack.runner, controllerRunner: stack.controller });
    if (reconciliation.missionsResumed !== 1) throw new Error(`Startup reconciliation resumed ${reconciliation.missionsResumed} mission(s), expected exactly 1`);

    await drive(stack, () => isMissionRuntimeTerminal(missionRuntimeRepository(db).get(mission.id)!), 60_000);
    await settleActive(stack);

    const runtimeRepo = missionRuntimeRepository(db);
    const runtime = runtimeRepo.get(mission.id)!;
    const progress = runtimeRepo.listProgress(mission.id);
    const operations = runtimeRepo.listOperations(mission.id);
    const recoveries = runtimeRepo.listRecoveryDecisions(mission.id);
    const transitions = runtimeRepo.listTransitions(mission.id);
    const continuity = executionContinuityRepository(db);
    const segments = missionTaskIds().flatMap((id) => continuity.listSegments(id));
    const rollovers = segments.filter((segment) => segment.boundaryReason === "context_pressure");
    const checkpoints = db.prepare("SELECT id FROM agent_execution_checkpoints WHERE mission_id=?").all(mission.id) as Array<{ id: string }>;
    const guardianRejections = transitions.filter((t) => t.cause === "guardian_rejected");
    const guardianAuthorizations = transitions.filter((t) => t.to === "completed" && t.cause === "guardian_passed");
    const transitionActors = [...new Set(transitions.map((t) => t.actor))];
    const operationKeys = operations.map((o) => o.idempotencyKey);
    const uniqueOperationKeys = new Set(operationKeys).size === operationKeys.length;
    const completedAfter = operations.filter((o) => o.status === "completed").map((o) => o.idempotencyKey);
    const duplicateCompletedOperations = completedAfter.filter((key) => beforeRestartOps.includes(key)).length - beforeRestartOps.length;
    const integrity = db.prepare("PRAGMA integrity_check").pluck().get();
    const sqliteIntegrity = integrity === "ok" ? "ok" as const : "failed" as const;

    const passed = script.readUnits === WORK_UNITS
      && progress.length > 0
      && uniqueOperationKeys
      && duplicateCompletedOperations === 0
      && runtime.state === "completed"
      && guardianRejections.length > 0
      && guardianAuthorizations.length === 1
      && runtime.leaseGeneration > leaseGenerationBeforeRestart
      && rollovers.length >= 3
      && checkpoints.length > 0
      && recoveries.length >= 2
      && databaseRestartCount === 1
      && sqliteIntegrity === "ok"
      && transitionActors.includes("controller") && transitionActors.includes("worker") && transitionActors.includes("guardian");

    return {
      scenarioId: "sustained-autonomy-v1",
      passed,
      message: passed ? null : `units=${script.readUnits}; rollovers=${rollovers.length}; recoveries=${recoveries.length}; guardianRejections=${guardianRejections.length}; guardianAuthorizations=${guardianAuthorizations.length}; state=${runtime.state}; leaseBefore=${leaseGenerationBeforeRestart}; leaseAfter=${runtime.leaseGeneration}; duplicateCompleted=${duplicateCompletedOperations}; integrity=${String(integrity)}`,
      missionId: mission.id,
      terminalState: runtime.state,
      productiveWorkUnits: script.readUnits,
      progressObservationCount: progress.length,
      contextRolloverCount: rollovers.length,
      checkpointCount: checkpoints.length,
      recoveryCount: recoveries.length,
      recoveryCategories: recoveries.map((r) => r.category),
      databaseRestartCount,
      leaseGenerationBeforeRestart,
      leaseGenerationAfterRestart: runtime.leaseGeneration,
      duplicateCompletedOperations,
      guardianRejectionCount: guardianRejections.length,
      guardianAuthorizationCount: guardianAuthorizations.length,
      transitionActors,
      operationKinds: [...new Set(operations.map((o) => o.kind))],
      sqliteIntegrity,
      deadlineMs: null,
      userContinuations: 0,
      wallClockMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      scenarioId: "sustained-autonomy-v1",
      passed: false,
      message: error instanceof Error ? error.message : String(error),
      missionId,
      terminalState: missionId ? missionRuntimeRepository(db).get(missionId)?.state ?? null : null,
      productiveWorkUnits: script.readUnits,
      progressObservationCount: 0,
      contextRolloverCount: 0,
      checkpointCount: 0,
      recoveryCount: 0,
      recoveryCategories: [],
      databaseRestartCount: 0,
      leaseGenerationBeforeRestart: 0,
      leaseGenerationAfterRestart: 0,
      duplicateCompletedOperations: 0,
      guardianRejectionCount: 0,
      guardianAuthorizationCount: 0,
      transitionActors: [],
      operationKinds: [],
      sqliteIntegrity: "failed",
      deadlineMs: null,
      userContinuations: 0,
      wallClockMs: Date.now() - startedAt,
    };
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
