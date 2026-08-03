import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { missionRuntimeRepository } from "../src/repositories/mission-runtime.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";

const createdAt = "2026-08-02T12:00:00.000Z";
const probe = "credential sk-abcdefghijklmnop";

function missionHarness() {
  const db = openDatabase(":memory:");
  projectRepository(db).createProject({
    id: "project-1",
    name: "Privacy boundary fixture",
    workspacePath: "C:/synthetic-workspace",
    createdAt,
  });
  const missions = missionsRepository(db);
  const mission = missions.create({
    id: "mission-1",
    projectId: "project-1",
    objective: "Synthetic privacy fixture",
    budget: {
      maxUsd: null,
      maxAttempts: null,
      maxReviewCycles: 2,
      spentUsd: 0,
      attemptsUsed: 0,
      reviewCyclesUsed: 0,
    },
  }, createdAt);
  return { db, missions, mission };
}

describe("Task 5 durable privacy boundaries", () => {
  it("redacts tool-call failure messages on write and legacy reads", () => {
    const db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "project-1", name: "Synthetic", workspacePath: "C:/synthetic-workspace", createdAt });
    taskRepository(db).createTask({ id: "task-1", projectId: "project-1", kind: "agent_chat", status: "queued", createdAt });
    const conversations = conversationsRepository(db);
    conversations.createConversation({ id: "conversation-1", projectId: "project-1", title: "Synthetic", createdAt, updatedAt: createdAt });
    conversations.appendMessage({ id: "assistant-1", conversationId: "conversation-1", role: "assistant", content: "", taskId: "task-1", createdAt, updatedAt: createdAt });
    conversations.upsertToolCall({
      id: "tool-call-1",
      messageId: "assistant-1",
      taskId: "task-1",
      toolName: "run_command",
      argsJson: JSON.stringify({ command: probe }),
      resultJson: JSON.stringify({ error: probe }),
      status: "failed",
      errorType: "provider_failure",
      errorMessage: probe,
      createdAt,
    });

    expect(JSON.stringify(conversations.getToolCall("tool-call-1"))).not.toContain(probe);
    expect((db.prepare("SELECT error_message FROM message_tool_calls WHERE id=?").get("tool-call-1") as { error_message: string }).error_message).not.toContain(probe);

    db.prepare("UPDATE message_tool_calls SET error_message=? WHERE id=?").run(probe, "tool-call-1");
    expect(JSON.stringify(conversations.getToolCall("tool-call-1"))).not.toContain(probe);
    db.close();
  });

  it("redacts mission evidence, failures, and events on write and legacy reads", () => {
    const { db, missions, mission } = missionHarness();
    const evidence = missions.addEvidence({
      id: "evidence-1",
      missionId: mission.id,
      criterionIds: [],
      type: "command",
      summary: probe,
      command: probe,
      exitCode: 1,
      outputRef: probe,
      artifactPath: probe,
      status: "failed",
      recordedAt: createdAt,
    });
    const failure = missions.addFailure({
      id: "failure-1",
      missionId: mission.id,
      taskId: null,
      agentId: null,
      operation: "run_command",
      normalizedSignature: "provider_failure:run_command",
      category: "provider_failure",
      message: probe,
      attempt: 1,
      recoveryStrategy: "switch_provider",
      recovered: false,
      createdAt,
    });
    const event = missions.appendEvent(mission.id, "mission.failure_recorded", probe, { message: probe, nested: [probe] }, createdAt);

    expect(JSON.stringify({ evidence, failure, event })).not.toContain(probe);
    expect((db.prepare("SELECT summary,command,output_ref,artifact_path FROM mission_evidence WHERE id=?").get(evidence.id) as Record<string, string | null>).summary).not.toContain(probe);
    expect((db.prepare("SELECT message FROM mission_failures WHERE id=?").get(failure.id) as { message: string }).message).not.toContain(probe);
    expect((db.prepare("SELECT summary,data_json FROM mission_events WHERE id=?").get(event.id) as Record<string, string>).summary).not.toContain(probe);

    db.prepare("UPDATE mission_evidence SET summary=?,command=?,output_ref=?,artifact_path=? WHERE id=?").run(probe, probe, probe, probe, evidence.id);
    db.prepare("UPDATE mission_failures SET message=? WHERE id=?").run(probe, failure.id);
    db.prepare("UPDATE mission_events SET summary=?,data_json=? WHERE id=?").run(probe, JSON.stringify({ message: probe }), event.id);

    expect(JSON.stringify(missions.getEvidence(evidence.id))).not.toContain(probe);
    expect(JSON.stringify(missions.listFailures(mission.id))).not.toContain(probe);
    expect(JSON.stringify(missions.listEvents(mission.id))).not.toContain(probe);
    db.close();
  });

  it("redacts mission runtime operations, progress, recovery, and transition details on write and legacy reads", () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run("project-1", 1, "Project", "C:/synthetic-workspace", createdAt, createdAt);
    db.prepare(`INSERT INTO missions
      (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run("mission-1", 1, "project-1", "Synthetic runtime", "running", 1, "{}", createdAt, createdAt);
    const runtime = missionRuntimeRepository(db);
    runtime.create({ missionId: "mission-1", now: createdAt });
    const transition = runtime.transition({
      missionId: "mission-1",
      from: "created",
      to: "orienting",
      cause: "controller_started",
      actor: "controller",
      details: { message: probe },
      now: createdAt,
    });
    const lease = runtime.claimLease({ missionId: "mission-1", ownerId: "runtime-owner", now: createdAt, expiresAt: "2026-08-02T12:01:00.000Z" });
    if (!lease) throw new Error("synthetic runtime fixture could not claim its lease");
    const operation = runtime.enqueueOperation({
      missionId: "mission-1",
      idempotencyKey: "synthetic:operation",
      kind: "dispatch_worker",
      strategyFingerprint: "synthetic:strategy",
      input: { message: probe },
      fence: lease,
      now: createdAt,
    });
    runtime.startOperation({ missionId: "mission-1", operationId: operation.id, fence: lease, now: createdAt });
    runtime.completeOperation({ missionId: "mission-1", operationId: operation.id, fence: lease, result: { message: probe }, effectEvidenceIds: [], now: createdAt });
    runtime.appendProgress({
      id: "progress-1",
      missionId: "mission-1",
      operationId: operation.id,
      kind: "evidence_gained",
      summary: probe,
      evidenceIds: ["evidence-1"],
      strategyFingerprint: "synthetic:strategy",
      now: createdAt,
    });
    runtime.recordRecovery({
      missionId: "mission-1",
      operationId: operation.id,
      category: "provider_failure",
      diagnosis: probe,
      failedStrategyFingerprint: "synthetic:strategy",
      nextStrategyFingerprint: "synthetic:fallback",
      action: "switch_provider",
      retryCondition: probe,
      exhausted: false,
      now: createdAt,
    });

    expect(JSON.stringify({ transition, operation: runtime.listOperations("mission-1"), progress: runtime.listProgress("mission-1"), recovery: runtime.listRecoveryDecisions("mission-1") })).not.toContain(probe);

    db.prepare("UPDATE mission_runtime_transitions SET details_json=? WHERE id=?").run(JSON.stringify({ message: probe }), transition.id);
    db.prepare("UPDATE mission_operations SET input_json=?,result_json=? WHERE id=?").run(JSON.stringify({ message: probe }), JSON.stringify({ message: probe }), operation.id);
    db.prepare("UPDATE mission_progress SET summary=? WHERE id=?").run(probe, "progress-1");
    db.prepare("UPDATE mission_recovery_decisions SET diagnosis=?,retry_condition=? WHERE mission_id=?").run(probe, probe, "mission-1");

    expect(JSON.stringify(runtime.listTransitions("mission-1"))).not.toContain(probe);
    expect(JSON.stringify(runtime.listOperations("mission-1"))).not.toContain(probe);
    expect(JSON.stringify(runtime.listProgress("mission-1"))).not.toContain(probe);
    expect(JSON.stringify(runtime.listRecoveryDecisions("mission-1"))).not.toContain(probe);
    db.close();
  });

  it("redacts task evidence, verification, and agent-state metadata on write and legacy reads", () => {
    const db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "project-1", name: "Synthetic", workspacePath: "C:/synthetic-workspace", createdAt });
    taskRepository(db).createTask({ id: "task-1", projectId: "project-1", kind: "agent_chat", status: "queued", createdAt });
    const records = taskRecordsRepository(db);
    records.transitionAgentState("task-1", { id: "state-1", state: "idle", details: { message: probe }, createdAt });
    records.appendEvidence({ id: "evidence-1", taskId: "task-1", type: "file", path: probe, metadata: { message: probe }, createdAt });
    records.upsertVerification({ taskId: "task-1", status: "verified", summary: probe, details: { message: probe }, createdAt, updatedAt: createdAt });

    expect(JSON.stringify(records.getAggregate("task-1"))).not.toContain(probe);
    db.prepare("UPDATE agent_state_transitions SET details_json=? WHERE id=?").run(JSON.stringify({ message: probe }), "state-1");
    db.prepare("UPDATE task_evidence SET path=?,metadata_json=? WHERE id=?").run(probe, JSON.stringify({ message: probe }), "evidence-1");
    db.prepare("UPDATE verification_results SET summary=?,details_json=? WHERE task_id=?").run(probe, JSON.stringify({ message: probe }), "task-1");

    expect(JSON.stringify(records.getAggregate("task-1"))).not.toContain(probe);
    db.close();
  });
});
