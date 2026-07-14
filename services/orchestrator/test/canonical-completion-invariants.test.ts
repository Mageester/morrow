import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { MissionService, type MissionCompletionFn } from "../src/mission/service.js";
import { MissionError } from "../src/mission/service.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

async function readyMission() {
  const workspace = mkdtempSync(join(tmpdir(), "morrow-canonical-mission-"));
  roots.push(workspace);
  const db = openDatabase(":memory:");
  const at = "2026-07-13T00:00:00.000Z";
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: at });
  const completion: MissionCompletionFn = async (_messages, opts) => opts.purpose === "review"
    ? { text: JSON.stringify({ verdict: "approved", recommendedStatus: "completed", criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [], concerns: [], summary: "approved" }) }
    : { text: "[]" };
  const service = new MissionService({ repo: missionsRepository(db), getWorkspacePath: () => workspace, backupDir: join(workspace, "checkpoints"), completion });
  const mission = service.create("p", { objective: "Return one evidence-backed result" });
  const command = service.addCriterion(mission.id, "Node reports its version", { kind: "command", command: "node --version", expectExitCode: 0 });
  service.addCriterion(mission.id, "Independent review approves", { kind: "review" });
  service.approveCriteria(mission.id);
  await service.verifyCriterion(mission.id, command.id);
  await service.runReview(mission.id);
  return { db, service, mission, at };
}

function createAgentTask(db: ReturnType<typeof openDatabase>, missionId: string, id: string, createdAt: string) {
  taskRepository(db).createTask({ id, projectId: "p", missionId, kind: "agent_chat", status: "completed", createdAt });
  taskRecordsRepository(db).appendEvent({ id: `event-${id}`, taskId: id, type: "task.progress_warning", payload: {}, createdAt });
  const cursor = taskRecordsRepository(db).appendEvent({
    id: `verification-${id}`,
    taskId: id,
    type: "tool.completed",
    payload: { id: `verify-${id}`, toolName: "run_command", status: "completed", summary: "exit 0", exitCode: 0 },
    createdAt,
  });
  const continuity = executionContinuityRepository(db);
  const segment = continuity.openSegment({ taskId: id, missionId, providerId: "mock", model: "mock-model", routeJson: {}, ownerId: "worker", now: createdAt });
  continuity.recordProviderTurn({ id: `turn-${id}`, taskId: id, segmentId: segment.id, turnKey: "final-turn", ordinal: 1, assistantText: "final", toolCalls: [], isFinal: true, ownerId: "worker", generation: segment.generation, now: createdAt });
  return cursor.sequence;
}

function saveCanonicalAnswer(
  db: ReturnType<typeof openDatabase>,
  input: { id: string; taskId: string; missionId: string; content: string; evidenceJson: Record<string, unknown>; now: string },
) {
  const continuity = executionContinuityRepository(db);
  const segment = continuity.getRunningSegment(input.taskId)!;
  return continuity.createCanonicalAnswer({ ...input, segmentId: segment.id, ownerId: segment.ownerId!, generation: segment.generation });
}

function canonicalEvidence(cursor: number, patch: Record<string, unknown> = {}) {
  return {
    sourceTurnKey: "final-turn",
    durableEventCursor: cursor,
    verification: { status: "passed", toolCallId: "verify-agent-owner", exitCode: 0 },
    unresolvedBlocker: null,
    unresolvedFailures: [],
    ...patch,
  };
}

function expectMissionError(run: () => unknown, code: string) {
  try {
    run();
    throw new Error(`Expected MissionError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(MissionError);
    expect((error as MissionError).code).toBe(code);
  }
}

describe("canonical mission completion invariants", () => {
  it("requires the authoritative newest agent task to own the canonical answer", async () => {
    const { db, service, mission, at } = await readyMission();
    const oldCursor = createAgentTask(db, mission.id, "agent-old", at);
    createAgentTask(db, mission.id, "agent-owner", "2026-07-13T00:01:00.000Z");
    saveCanonicalAnswer(db, { id: "answer-old", taskId: "agent-old", missionId: mission.id, content: "stale", evidenceJson: canonicalEvidence(oldCursor), now: at });

    expectMissionError(() => service.finalize(mission.id), "finalize_missing_canonical_answer");
    expect(service.get(mission.id).status).toBe("reviewing");
    db.close();
  });

  it("allows a newer mission task to replace an older task as canonical-answer owner", async () => {
    const { db, service, mission, at } = await readyMission();
    const oldCursor = createAgentTask(db, mission.id, "agent-old", at);
    saveCanonicalAnswer(db, { id: "answer-old", taskId: "agent-old", missionId: mission.id, content: "old", evidenceJson: canonicalEvidence(oldCursor), now: at });
    const newestAt = "2026-07-13T00:01:00.000Z";
    const newestCursor = createAgentTask(db, mission.id, "agent-owner", newestAt);

    expect(() => saveCanonicalAnswer(db, { id: "answer-new", taskId: "agent-owner", missionId: mission.id, content: "new", evidenceJson: canonicalEvidence(newestCursor), now: newestAt })).not.toThrow();
    expect(service.finalize(mission.id).status).toBe("completed");
    db.close();
  });

  it.each([
    ["missing evidence cursor", { durableEventCursor: null }, "finalize_invalid_canonical_evidence"],
    ["fabricated final turn", { sourceTurnKey: "unknown-turn" }, "finalize_invalid_canonical_evidence"],
    ["unpassed verification", { verification: { status: "failed" } }, "finalize_unverified_canonical_answer"],
    ["unresolved blocker", { unresolvedBlocker: "approval pending" }, "finalize_canonical_answer_blocked"],
    ["unresolved failure", { unresolvedFailures: ["tests failed"] }, "finalize_canonical_answer_blocked"],
  ])("rejects %s", async (_name, patch, code) => {
    const { db, service, mission, at } = await readyMission();
    const cursor = createAgentTask(db, mission.id, "agent-owner", at);
    saveCanonicalAnswer(db, { id: "answer", taskId: "agent-owner", missionId: mission.id, content: "final", evidenceJson: canonicalEvidence(cursor, patch), now: at });

    expectMissionError(() => service.finalize(mission.id), code);
    expect(service.get(mission.id).status).toBe("reviewing");
    db.close();
  });

  it("accepts the authoritative completed task only with durable passed evidence and no blocker", async () => {
    const { db, service, mission, at } = await readyMission();
    const cursor = createAgentTask(db, mission.id, "agent-owner", at);
    saveCanonicalAnswer(db, { id: "answer", taskId: "agent-owner", missionId: mission.id, content: "final", evidenceJson: canonicalEvidence(cursor), now: at });

    expect(service.finalize(mission.id).status).toBe("completed");
    db.close();
  });

  it("rejects a canonical cursor that predates its referenced successful verification", async () => {
    const { db, service, mission, at } = await readyMission();
    const verificationCursor = createAgentTask(db, mission.id, "agent-owner", at);
    saveCanonicalAnswer(db, {
      id: "answer",
      taskId: "agent-owner",
      missionId: mission.id,
      content: "final",
      evidenceJson: canonicalEvidence(verificationCursor - 1),
      now: at,
    });

    expectMissionError(() => service.finalize(mission.id), "finalize_invalid_canonical_evidence");
    expect(service.get(mission.id).status).toBe("reviewing");
    db.close();
  });
});
