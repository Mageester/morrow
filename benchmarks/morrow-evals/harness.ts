import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  openDatabase, missionsRepository, MissionService, type MissionCompletionFn,
} from "../../services/orchestrator/src/lib.js";
import type { Mission } from "../../packages/contracts/src/index.js";

/**
 * A benchmark scenario. Everything is deterministic and reproducible: the
 * fixture, the implementer (what the "agent" does), and the hidden ground-truth
 * check that the mission never sees.
 */
export interface Scenario {
  name: string;
  description: string;
  /** Write the broken fixture into `dir`. */
  setup(dir: string): void;
  /** Deterministic success criteria (description + verification). */
  criteria(dir: string): Array<{ description: string; verification: any }>;
  /** Apply the "agent's" work to the fixture. May be correct or incomplete. */
  implement(dir: string, service: MissionService, missionId: string): Promise<void> | void;
  /** Independent, hidden ground-truth check: is the work ACTUALLY correct? */
  hiddenTest(dir: string): boolean;
  /** Optional deterministic reviewer verdict; defaults to evidence-driven. */
  reviewText?(mission: Mission): string;
  /** When true, the harness restarts the service (reopens the DB, rebuilds the
   *  MissionService) mid-flight to prove the mission survives a restart. */
  restart?: boolean;
}

export interface ScenarioResult {
  scenario: string;
  missionStatus: string;
  criteriaVerified: number;
  criteriaTotal: number;
  hiddenTestsPassed: boolean;
  claimedFullSuccess: boolean;
  finalClaimAccurate: boolean;
  regressionsIntroduced: number;
  humanInterventions: number;
  failedOperations: number;
  repeatedFailures: number;
  recoverySuccess: boolean;
  reviewerVerdict: string | null;
  elapsedMs: number;
}

const FULL_SUCCESS = new Set(["completed"]);

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const dir = mkdtempSync(join(tmpdir(), `eval-${scenario.name}-`));
  const home = mkdtempSync(join(tmpdir(), `eval-home-${scenario.name}-`));
  const started = Date.now();
  let dbRef: { close(): void } | null = null;
  try {
    gitInit(dir);
    scenario.setup(dir);
    gitCommitAll(dir, "fixture");

    // A file-backed DB so a "restart" (reopening the DB) genuinely reloads state.
    const dbPath = join(home, "morrow.db");
    const backupDir = join(home, "cp");
    let db = openDatabase(dbPath);
    dbRef = db;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO projects(id,schema_version,name,workspace_path,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("p", 1, scenario.name, dir, now, now);

    // Deterministic completions: criteria come from the scenario; the reviewer
    // is a SEPARATE isolated call whose verdict follows the recorded evidence.
    let service: MissionService;
    const buildService = (database: typeof db) => new MissionService({
      repo: missionsRepository(database),
      getWorkspacePath: () => dir,
      completion: async (_messages, opts) => {
        if (opts.purpose === "planning") return { text: JSON.stringify(scenario.criteria(dir)) };
        const mission = service.get(missionId);
        const allVerified = mission.criteria.every((c) => c.state === "verified" || c.state === "waived");
        const anyFailed = mission.criteria.some((c) => c.state === "failed");
        const verdict = anyFailed ? "revisions_required" : allVerified ? "approved" : "insufficient_evidence";
        const recommendedStatus = anyFailed ? "partially_completed" : allVerified ? "completed" : "partially_completed";
        return { text: JSON.stringify({ verdict, recommendedStatus, criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [], concerns: [], summary: "evidence-driven" }), provider: "eval", model: "reviewer" };
      },
      backupDir,
    });
    service = buildService(db);

    const mission = service.create("p", { objective: scenario.description, autoApprove: true });
    const missionId = mission.id;
    await service.generateCriteria(missionId, "fixture");

    // Checkpoint, then the "agent" implements.
    service.createCheckpoint(missionId, "pre", "before implement");
    await scenario.implement(dir, service, missionId);

    // Optionally simulate a service restart mid-flight: close the DB and rebuild
    // the service over a freshly reopened handle. State must reload from disk.
    if (scenario.restart) {
      db.close();
      db = openDatabase(dbPath);
      dbRef = db;
      service = buildService(db);
      const reloaded = service.resume(missionId);
      if (reloaded.objective !== scenario.description) throw new Error("restart lost mission state");
    }

    // Evidence-backed verification, independent review, honest grade.
    await service.verifyAll(missionId);
    await service.runReview(missionId);
    const final = service.finalize(missionId, { tasksCompleted: 1 });

    const hiddenPass = scenario.hiddenTest(dir);
    const claimedFull = FULL_SUCCESS.has(final.status);
    const failures = service.get(missionId).failures;
    const signatures = new Map<string, number>();
    for (const f of failures) signatures.set(f.normalizedSignature, (signatures.get(f.normalizedSignature) ?? 0) + 1);
    const repeated = [...signatures.values()].filter((n) => n >= 2).reduce((a, b) => a + b, 0);

    return {
      scenario: scenario.name,
      missionStatus: final.status,
      criteriaVerified: final.result?.criteriaVerified ?? 0,
      criteriaTotal: final.criteria.length,
      hiddenTestsPassed: hiddenPass,
      claimedFullSuccess: claimedFull,
      // The headline metric: the claim is accurate when a full-success grade
      // coincides with the hidden test passing, AND a non-full grade coincides
      // with the hidden test failing.
      finalClaimAccurate: claimedFull === hiddenPass,
      regressionsIntroduced: hiddenPass ? 0 : final.result?.criteriaFailed ?? 0,
      humanInterventions: 0,
      failedOperations: failures.length,
      repeatedFailures: repeated,
      recoverySuccess: failures.length === 0 || failures.some((f) => f.recovered),
      reviewerVerdict: final.finalReview?.verdict ?? null,
      elapsedMs: Date.now() - started,
    };
  } finally {
    try { dbRef?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

export async function runAll(scenarios: Scenario[]): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const s of scenarios) results.push(await runScenario(s));
  return results;
}

export function summarize(results: ScenarioResult[]): { total: number; claimAccurate: number; claimAccuracyPct: number } {
  const total = results.length;
  const claimAccurate = results.filter((r) => r.finalClaimAccurate).length;
  return { total, claimAccurate, claimAccuracyPct: total ? Math.round((claimAccurate / total) * 100) : 0 };
}

function gitInit(dir: string) {
  spawnSync("git", ["init", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "eval@morrow.dev"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "eval"], { cwd: dir });
}
function gitCommitAll(dir: string, msg: string) {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-m", msg], { cwd: dir });
}
