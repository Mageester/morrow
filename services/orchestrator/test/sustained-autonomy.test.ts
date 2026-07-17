import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { missionRuntimeRepository } from "../src/repositories/mission-runtime.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { MissionService } from "../src/mission/service.js";
import { TaskRunner } from "../src/runner.js";
import { createDefaultMissionControllerRunner, isMissionRuntimeTerminal } from "../src/mission/controller-runner.js";
import { reconcileMissionsOnStartup } from "../src/recovery.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import type { AiProvider, ChatMessage, ProviderChunk } from "../src/provider/base.js";

const WORK_UNITS = 96;

let workspace: string;
let home: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
let openDb: { close(): void; open: boolean } | null = null;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "morrow-sustained-ws-"));
  home = mkdtempSync(join(tmpdir(), "morrow-sustained-home-"));
  dbPath = join(workspace, "runtime.sqlite");
  env = { ...process.env, MOCK_PROVIDER: "true", MORROW_HOME: home };
  mkdirSync(join(workspace, "inputs"), { recursive: true });
  // A fixture checker avoids shell-quoting differences across platforms.
  writeFileSync(join(workspace, "check.js"), [
    "const { readFileSync } = require('node:fs');",
    "let ok = false;",
    "try { ok = JSON.parse(readFileSync('result.json', 'utf8')).ok === true; } catch { ok = false; }",
    "process.exit(ok ? 0 : 1);",
  ].join("\n"));
  for (let index = 1; index <= WORK_UNITS; index += 1) {
    // Each input is a distinct bounded fact the worker must actually read.
    writeFileSync(join(workspace, "inputs", `unit-${index}.txt`), `value=${index}\n${"pad ".repeat(200)}`);
  }
});

afterEach(() => {
  // Every SQLite handle must be closed before Windows will release the file.
  if (openDb?.open) openDb.close();
  openDb = null;
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Small window so real context accounting reaches pressure on real history. */
const route = {
  providerId: "mock" as const,
  protocol: "openai-chat" as const,
  endpointKind: "default" as const,
  endpointHost: null,
  endpointLimitTokens: 24_000,
  endpointLimitSource: "provider-metadata" as const,
};

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
 * the external model. Every durable effect below is produced by production code
 * reacting to these turns.
 */
function scriptedProvider(script: Script, phase: "break" | "fix"): AiProvider {
  return {
    id: "mock",
    route,
    async *streamChat(_messages: ChatMessage[]): AsyncIterable<ProviderChunk> {
      if (phase === "break") {
        // One transient provider failure at the real provider boundary.
        if (script.readUnits === 12 && script.providerFailures === 0) {
          script.providerFailures += 1;
          throw new Error("Injected transient provider failure");
        }
        // One malformed tool result at the real tool boundary.
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
          // A deliberately failing result, so the real Guardian must reject it.
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
        // Production requires a mission worker to verify its own final write
        // with a passing run_command before it may hold the canonical answer.
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

describe("sustained autonomy through production paths", () => {
  it("completes a long mission with real rollovers, recovery, restart, and Guardian authorization", async () => {
    const script: Script = { readUnits: 0, providerFailures: 0, malformedResults: 0, wroteBroken: false, wroteFixed: false, verifiedFix: false };
    const startedAt = Date.now();
    let db = openDatabase(dbPath);
    openDb = db;
    const at = new Date().toISOString();
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: at });

    // Deterministic review at the model boundary; the Guardian itself is real.
    const completion = async (_m: ChatMessage[], o: { purpose: "planning" | "review" }) => o.purpose === "review"
      ? { text: JSON.stringify({ verdict: "approved", recommendedStatus: "completed", criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [], concerns: [], summary: "Verified." }), provider: "mock", model: "reviewer" }
      : { text: "[]", provider: "mock", model: "planner" };

    const fixtureService = new MissionService({
      repo: missionsRepository(db), getWorkspacePath: () => workspace,
      backupDir: join(home, "checkpoints"), completion,
    });
    const mission = fixtureService.create("p", { objective: `Read ${WORK_UNITS} inputs and produce a verified result.json.`, autoApprove: true });
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
    /** Drive the controller until `done`, letting production wakes do the work. */
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
    /**
     * Let whatever is in flight right now finish writing. The worker is never
     * cancelled: production treats a cancelled worker as a terminal blocked
     * mission, which would defeat the restart this models.
     */
    const settleActive = async (stack: Stack): Promise<void> => {
      await stack.controller.waitFor(mission.id);
      for (const id of missionTaskIds()) {
        if (stack.runner.isActive(id)) await stack.runner.waitFor(id);
      }
      await stack.controller.waitFor(mission.id);
    };
    const rejected = () => missionRuntimeRepository(db).listTransitions(mission.id).some((t) => t.cause === "guardian_rejected");

    // Phase 1: the long productive run, through the Guardian's first rejection.
    let stack = buildStack("break", "controller-before-restart");
    await drive(stack, () => script.readUnits >= WORK_UNITS && rejected(), 60_000);
    await settleActive(stack);

    const beforeRestartOps = missionRuntimeRepository(db).listOperations(mission.id)
      .filter((o) => o.status === "completed").map((o) => o.idempotencyKey);
    // Lease generation only advances when an owner actually claims the lease, so
    // it is the durable proof that a different controller took over below.
    const leaseGenerationBeforeRestart = missionRuntimeRepository(db).get(mission.id)!.leaseGeneration;

    // Restart at a supported boundary: close SQLite, reopen the same file, and
    // let a new owner reclaim through production lease logic.
    db.close();
    db = openDatabase(dbPath);
    openDb = db;
    const databaseRestartCount = 1;

    stack = buildStack("fix", "controller-after-restart");
    // A restart leaves durable work that only the process that dispatched it was
    // tracking in memory: a `queued` task no live runner owns, and a non-terminal
    // controller nobody is driving. Production reclaims both here, and both
    // standalone and packaged startup use this exact call (see src/index.ts).
    const reconciliation = reconcileMissionsOnStartup({ db, runner: stack.runner, controllerRunner: stack.controller });
    expect(reconciliation.missionsResumed).toBe(1);

    await drive(stack, () => isMissionRuntimeTerminal(missionRuntimeRepository(db).get(mission.id)!), 60_000);
    await settleActive(stack);

    // --- Measurements, all read back from durable runtime state ---
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
    const completedAfter = operations.filter((o) => o.status === "completed").map((o) => o.idempotencyKey);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      productiveWorkUnits: script.readUnits,
      progressObservationCount: progress.length,
      contextRolloverCount: rollovers.length,
      checkpointCount: checkpoints.length,
      recoveryCount: recoveries.length,
      databaseRestartCount,
      transitionActorCount: transitionActors.length,
      leaseGenerationBeforeRestart,
      leaseGenerationAfterRestart: runtime.leaseGeneration,
      elapsedMs: Date.now() - startedAt,
      terminalState: runtime.state,
      transitions: transitions.map((t) => `${t.from}->${t.to}:${t.cause}`),
      recoveryCategories: recoveries.map((r) => r.category),
      recoveryStrategies: recoveries.map((r) => `${r.failedStrategyFingerprint}->${r.nextStrategyFingerprint}:${r.action}`),
      transitionActors,
      rolloverReasons: [...new Set(segments.map((s) => s.boundaryReason))],
      guardianRejectionReasons: guardianRejections.map((t) => JSON.stringify(t.details)),
      guardianAuthorization: guardianAuthorizations.map((t) => `${t.actor}:${t.cause}`),
      operationKinds: [...new Set(operations.map((o) => o.kind))],
      finalTransition: transitions.at(-1),
    }, null, 2));

    expect(script.readUnits).toBe(WORK_UNITS);
    expect(progress.length).toBeGreaterThan(0);
    expect(new Set(operationKeys).size).toBe(operationKeys.length);
    // Nothing already completed before the restart may run a second time.
    expect(completedAfter.filter((key) => beforeRestartOps.includes(key)).length).toBe(beforeRestartOps.length);
    expect(runtime.state).toBe("completed");
    expect(guardianRejections.length).toBeGreaterThan(0);
    expect(guardianAuthorizations.length).toBe(1);
    // The post-restart controller is a different owner, and only a real claim
    // advances the generation: ownership genuinely transferred.
    expect(runtime.leaseGeneration).toBeGreaterThan(leaseGenerationBeforeRestart);
    expect(transitionActors).toEqual(expect.arrayContaining(["controller", "worker", "guardian"]));
  }, 180_000);
});
