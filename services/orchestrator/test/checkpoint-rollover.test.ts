import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { executionContinuityRepository, createExecutionLeaseOwnerId, type ExecutionCheckpointSnapshot } from "../src/repositories/execution-continuity.js";

/**
 * §5+§6 acceptance: when context pressure triggers a checkpoint + fresh-session
 * rollover, the mission ID is preserved (same mission continues), a new
 * execution segment is opened under that mission, and a durable mission
 * checkpoint event is recorded so the activity panel can show the rollover.
 *
 * This test does NOT exercise the full agent loop; it drives the persistence
 * primitives directly with the same shape the agent uses so the contract is
 * locked. The end-to-end version is exercised by the live disposable
 * acceptance mission (commit 10).
 */

let db: Database.Database;
let continuity: ReturnType<typeof executionContinuityRepository>;
let missions: ReturnType<typeof missionsRepository>;
let ownerId: string;
let projectId: string;
let missionId: string;
let taskId: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  continuity = executionContinuityRepository(db);
  missions = missionsRepository(db);
  ownerId = createExecutionLeaseOwnerId();
  const now = new Date().toISOString();
  // Project + mission + task: required because checkpoints/missions are linked.
  // Direct SQL insert (mirrors the pattern in cortex-core.test.ts) so the test
  // doesn't have to spin up the MissionService contract machinery.
  db.prepare("INSERT INTO projects (id, schema_version, name, workspace_path, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(
    "project-1", 1, "Acceptance", "C:/tmp/acceptance", now, now
  );
  projectId = "project-1";
  missionId = "mission-test-1";
  db.prepare(
    "INSERT INTO missions (id, schema_version, project_id, objective, status, auto_approve, task_tree_root_id, budget_json, result_json, execution_json, created_at, updated_at, started_at, completed_at) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,NULL,NULL)"
  ).run(
    missionId, 1, projectId, "Build a small CLI calculator", "running", 1, null, "{}", JSON.stringify({ preset: "balanced", providerId: null, model: null, reasoning: { mode: "auto" } }), now, now
  );
  // Initial mission events so the durable log is shaped like the real path.
  db.prepare("INSERT INTO mission_events (id, mission_id, sequence, type, summary, data_json, created_at) VALUES (?,?,?,?,?,?,?)").run(
    "ev-created", missionId, 1, "mission.created", "Mission created", "{}", now
  );
  taskId = "task-1";
  db.prepare("INSERT INTO tasks (id, schema_version, project_id, type, status, created_at, updated_at, mission_id) VALUES (?,?,?,?,?,?,?,?)").run(
    taskId, 1, projectId, "agent_chat", "running", now, now, missionId
  );
});
afterEach(() => db.close());

function makeSnapshot(reason: string): ExecutionCheckpointSnapshot {
  return {
    version: 1,
    originalMission: "Build a small CLI calculator with add/subtract/mul/div.",
    hardRequirements: ["add", "subtract", "multiply", "divide"],
    prohibitedActions: [],
    acceptanceCriteria: ["a CLI", "all four operations"],
    decisions: [`Context pressure rollover: ${reason}`],
    completedWork: ["scaffolded the repo", "added package.json"],
    currentPhase: reason,
    filesChanged: ["package.json", "src/index.ts"],
    gitStatus: "?? src/index.ts\nM package.json",
    tests: [],
    unresolvedFailures: [],
    recoveryAttempts: [],
    pendingWork: ["continue with subtraction implementation"],
    approvals: { records: [] },
    taskId,
    missionId,
    providerRouting: { providerId: "opencode-go", model: "glm-5.2", route: { endpointHost: "opencode.ai", endpointKind: "custom" } },
    providerContinuationRefs: [],
    evidenceRequired: ["all four operations present", "tests pass"],
  };
}

describe("checkpoint + rollover preserves the mission ID", () => {
  it("a new execution segment is opened under the same mission after rollover", () => {
    const now = new Date().toISOString();
    const segmentA = continuity.openSegment({ taskId, missionId, providerId: "opencode-go", model: "glm-5.2", routeJson: {}, ownerId, now });
    expect(segmentA.missionId).toBe(missionId);
    expect(segmentA.status).toBe("running");

    // Save a checkpoint BEFORE the rollover so the next session has a resume point.
    continuity.saveCheckpoint({
      id: "ck-1",
      taskId,
      missionId,
      segmentId: segmentA.id,
      cursor: 12,
      snapshot: makeSnapshot("context_compaction"),
      ownerId,
      generation: 1,
      now,
    });
    // Verify the checkpoint row is durable and the snapshot round-trips.
    const saved = continuity.latestCheckpoint(taskId);
    expect(saved).not.toBeNull();
    expect(saved!.id).toBe("ck-1");
    expect(saved!.missionId).toBe(missionId);
    expect(saved!.snapshot.currentPhase).toBe("context_compaction");

    // Append a durable mission event for the checkpoint.
    missions.appendEvent(missionId, "mission.checkpoint_created", `Context checkpoint created (${segmentA.id})`, {
      taskId,
      segmentId: segmentA.id,
      checkpointId: "ck-1",
      phase: "context_compaction",
      decision: "Continuing in a fresh execution session",
    }, now);

    // Rollover the segment: same task + mission, new segment.
    const segmentB = continuity.rolloverSegment({
      taskId,
      currentSegmentId: segmentA.id,
      reason: "context_compaction",
      providerId: "opencode-go",
      model: "glm-5.2",
      routeJson: {},
      ownerId,
      generation: 1,
      now,
    });
    expect(segmentB.missionId).toBe(missionId);
    expect(segmentB.taskId).toBe(taskId);
    expect(segmentB.id).not.toBe(segmentA.id);
    expect(segmentB.status).toBe("running");
    // The closed segment is checkpointed, not still running.
    const closedA = db.prepare("SELECT * FROM agent_execution_segments WHERE id=?").get(segmentA.id) as { status: string; boundary_reason: string | null };
    expect(closedA.status).toBe("checkpointed");
    expect(closedA.boundary_reason).toBe("context_compaction");

    // §6 acceptance: the same mission continues under a fresh execution session.
    const events = missions.listEvents(missionId);
    const checkpointEvents = events.filter((e) => e.type === "mission.checkpoint_created");
    expect(checkpointEvents.length).toBe(1);
    expect(checkpointEvents[0]!.data).toMatchObject({
      taskId,
      segmentId: segmentA.id,
      checkpointId: "ck-1",
      phase: "context_compaction",
    });

    // The mission row is intact and still progressing — no NEW mission created
    // for the rollover.
    const mission = missions.get(missionId);
    expect(mission).toBeDefined();
    expect(mission!.id).toBe(missionId);
  });

  it("checkpointing repeatedly under one mission produces one mission with many segments, not many missions", () => {
    const now = new Date().toISOString();
    let seg = continuity.openSegment({ taskId, missionId, providerId: "opencode-go", model: "glm-5.2", routeJson: {}, ownerId, now });
    for (let i = 0; i < 3; i++) {
      continuity.saveCheckpoint({
        id: `ck-${i}`,
        taskId,
        missionId,
        segmentId: seg.id,
        cursor: i,
        snapshot: makeSnapshot(`pressure-${i}`),
        ownerId,
        generation: 1,
        now,
      });
      missions.appendEvent(missionId, "mission.checkpoint_created", `Context checkpoint ${i}`, {
        taskId, segmentId: seg.id, checkpointId: `ck-${i}`, phase: "context_compaction",
      }, now);
      seg = continuity.rolloverSegment({
        taskId, currentSegmentId: seg.id, reason: "context_compaction",
        providerId: "opencode-go", model: "glm-5.2", routeJson: {},
        ownerId, generation: 1, now,
      });
    }
    // One mission, four segments (1 initial + 3 rollovers).
    const allMissions = db.prepare("SELECT count(*) n FROM missions").get() as { n: number };
    expect(allMissions.n).toBe(1);
    const segs = continuity.listSegments(taskId);
    expect(segs.length).toBe(4);
    expect(segs.every((s) => s.missionId === missionId)).toBe(true);
    // Three mission events recorded.
    const events = missions.listEvents(missionId).filter((e) => e.type === "mission.checkpoint_created");
    expect(events.length).toBe(3);
  });
});