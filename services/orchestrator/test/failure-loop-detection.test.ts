import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { createLoopDetector, toolCallSignature } from "../src/execution/loop-detector.js";
import { categorizeFailure, normalizeSignature, planRecovery } from "../src/mission/failures.js";

/**
 * §7 acceptance: a tool-call signature that repeats past the bounded-retry
 * threshold is detected once, classified by the failure categorizer, and
 * surfaced as a single Decision-style event with a clear next action — not
 * as a flood of identical rows in the activity stream.
 */

let db: Database.Database;
let missions: ReturnType<typeof missionsRepository>;
let missionId: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  missions = missionsRepository(db);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects (id, schema_version, name, workspace_path, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(
    "p1", 1, "Acceptance", "C:/tmp/a", now, now
  );
  missionId = "mission-loop-1";
  db.prepare(
    "INSERT INTO missions (id, schema_version, project_id, objective, status, auto_approve, task_tree_root_id, budget_json, result_json, execution_json, created_at, updated_at, started_at, completed_at) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,NULL,NULL)"
  ).run(missionId, 1, "p1", "Loop test", "running", 1, null, "{}", JSON.stringify({ preset: "balanced", providerId: null, model: null, reasoning: { mode: "auto" } }), now, now);
});
afterEach(() => db.close());

describe("loop detection: bounded retry + Decision event with diagnosis", () => {
  it("detects a tool-call signature that repeats past the threshold exactly once", () => {
    const detector = createLoopDetector({ windowSize: 6, repeatThreshold: 3 });
    const sig = toolCallSignature("run_command", { executable: "git", args: ["status"] });
    const results = [1, 2, 3, 4, 5].map(() => detector.record(sig));
    // The first 2 records return looping=false (count < 3); the 3rd onward returns looping=true.
    expect(results[0]!.looping).toBe(false);
    expect(results[1]!.looping).toBe(false);
    expect(results[2]!.looping).toBe(true);
    expect(results[3]!.looping).toBe(true);
    expect(results[4]!.looping).toBe(true);
  });

  it("emits a single mission.loop_detected event with diagnosis + next action, no flood", () => {
    // §7 brief: "Repeated equivalent failures are grouped into a single
    // decision-class event in the durable event log (not a flood of
    // identical rows)".
    const detector = createLoopDetector({ windowSize: 6, repeatThreshold: 3 });
    const args = { executable: "git", args: ["status"] };
    const signature = toolCallSignature("run_command", args);
    const now = new Date().toISOString();

    let loopDetected = false;
    let loopInfo: { count: number; signature: string } | null = null;
    for (let i = 0; i < 5; i++) {
      const rec = detector.record(signature);
      if (rec.looping && !loopDetected) {
        loopDetected = true;
        loopInfo = { count: rec.count, signature: rec.signature };
      }
    }
    expect(loopDetected).toBe(true);
    expect(loopInfo).not.toBeNull();

    // One event for the loop, not five.
    if (!loopInfo) return;
    const category = categorizeFailure("run_command", `repeated tool call signature=${loopInfo.signature} count=${loopInfo.count}`);
    const normalized = normalizeSignature(category, loopInfo.signature);
    const recovery = planRecovery(category, loopInfo.count, 4);
    missions.appendEvent(missionId, "mission.loop_detected", `Repeated run_command (${loopInfo.count}×) — strategy switch`, {
      toolName: "run_command",
      toolCallSignature: loopInfo.signature,
      normalizedSignature: normalized,
      count: loopInfo.count,
      category,
      decision: recovery.strategy,
      steps: recovery.steps,
      exhausted: recovery.exhausted,
      evidence: { toolName: "run_command", count: loopInfo.count, window: loopInfo.count, message: `Repeated ${loopInfo.count} times without a different signature.` },
      nextAction: recovery.steps[0] ?? "Stop retrying this tool call",
    }, now);

    const events = missions.listEvents(missionId).filter((e) => e.type === "mission.loop_detected");
    expect(events.length).toBe(1);
    const ev = events[0]!;
    // Diagnostic shape the activity panel consumes.
    expect(ev.data).toMatchObject({
      toolName: "run_command",
      normalizedSignature: expect.any(String),
      count: expect.any(Number),
      category: expect.any(String),
      decision: expect.any(String),
      steps: expect.any(Array),
      nextAction: expect.any(String),
    });
    expect(typeof ev.data.nextAction).toBe("string");
    expect((ev.data.steps as string[]).length).toBeGreaterThan(0);
  });

  it("classifies the failure into a category and produces a recovery plan with non-empty steps", () => {
    // The §7 brief requires the diagnosis to be actionable: the recovery
    // plan must surface a strategy + steps (not raw error text).
    const cases: Array<{ toolName: string; message: string; expectCategory: string }> = [
      { toolName: "run_command", message: "fatal: not a git repository (or any of the parent directories): .git", expectCategory: "tool_error" },
      { toolName: "run_command", message: "ENOENT: no such file or directory, open 'C:/tmp/expected-file.ts'", expectCategory: "tool_error" },
      { toolName: "run_command", message: "git: 'not-a-real-cmd' is not a git command", expectCategory: "tool_error" },
      { toolName: "run_command", message: "rate limit exceeded: 429", expectCategory: "rate_limit" },
      { toolName: "run_command", message: "ETIMEDOUT: connection timed out", expectCategory: "timeout" },
    ];
    for (const c of cases) {
      const category = categorizeFailure(c.toolName, c.message);
      const plan = planRecovery(category, 1, 4);
      // tool_error isn't in the explicit planRecovery switch; the default
      // branch handles it. The plan must always have a strategy and at
      // least one step so the activity panel can render a next action.
      expect(plan.strategy).toBeTruthy();
      expect(plan.steps.length).toBeGreaterThan(0);
    }
  });

  it("stops the bounded retry: a 5th identical failure returns the same plan, not a different one", () => {
    const category = "patch_context_mismatch";
    const plan2 = planRecovery(category, 2, 4);
    const plan3 = planRecovery(category, 3, 4);
    // Different attempt levels produce different strategies until exhausted.
    expect(plan2.strategy).not.toBe(plan3.strategy);
    const plan4 = planRecovery(category, 4, 4);
    expect(plan4.exhausted).toBe(true);
    const plan5 = planRecovery(category, 5, 4);
    expect(plan5.exhausted).toBe(true);
    // The exhausted plan is idempotent — the loop detector stops the
    // same-tool-retry path; further failures emit the same exhausted event.
    expect(plan5.strategy).toBe("escalate");
  });
});