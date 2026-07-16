import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import {
  MissionRuntimeLeaseFenceError,
  missionRuntimeRepository,
} from "../src/repositories/mission-runtime.js";

function harness() {
  const db = openDatabase(":memory:");
  const now = "2026-07-16T12:00:00.000Z";
  db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)")
    .run("project-1", 1, "Project", "/workspace", now, now);
  db.prepare(`INSERT INTO missions
    (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run("mission-1", 1, "project-1", "Durable work", "running", 1, "{}", now, now);
  return { db, repo: missionRuntimeRepository(db), now };
}

describe("mission runtime repository", () => {
  it("atomically records state and its append-only transition", () => {
    const { db, repo, now } = harness();
    repo.create({ missionId: "mission-1", now });

    repo.transition({
      missionId: "mission-1",
      from: "created",
      to: "orienting",
      cause: "controller_started",
      actor: "controller",
      details: { reason: "start" },
      now,
    });

    expect(repo.get("mission-1")?.state).toBe("orienting");
    expect(repo.listTransitions("mission-1")).toEqual([
      expect.objectContaining({ sequence: 1, from: "created", to: "orienting" }),
    ]);
    expect(() => repo.transition({
      missionId: "mission-1",
      from: "created",
      to: "orienting",
      cause: "stale_writer",
      actor: "controller",
      details: {},
      now,
    })).toThrow(/state changed/i);
    db.close();
  });

  it("deduplicates an operation by mission and idempotency key", () => {
    const { db, repo, now } = harness();
    repo.create({ missionId: "mission-1", now });
    const input = {
      id: "operation-1",
      missionId: "mission-1",
      idempotencyKey: "dispatch:requirement-1",
      kind: "dispatch_worker" as const,
      strategyFingerprint: "primary:openai:gpt-5.6",
      input: { requirementId: "requirement-1" },
      now,
    };

    const first = repo.enqueueOperation(input);
    const second = repo.enqueueOperation({ ...input, id: "operation-2" });

    expect(second.id).toBe(first.id);
    expect(repo.listOperations("mission-1")).toHaveLength(1);
    expect(() => repo.enqueueOperation({
      ...input,
      id: "operation-3",
      input: { requirementId: "different" },
    })).toThrow(/idempotency key/i);
    db.close();
  });

  it("fences operation effects and completes them idempotently", () => {
    const { db, repo, now } = harness();
    repo.create({ missionId: "mission-1", now });
    const lease = repo.claimLease({
      missionId: "mission-1",
      ownerId: "controller-1",
      now,
      expiresAt: "2026-07-16T12:01:00.000Z",
    });
    expect(lease).toEqual({ ownerId: "controller-1", generation: 1 });
    expect(repo.claimLease({
      missionId: "mission-1",
      ownerId: "controller-2",
      now,
      expiresAt: "2026-07-16T12:01:00.000Z",
    })).toBeNull();

    const operation = repo.enqueueOperation({
      id: "operation-1",
      missionId: "mission-1",
      idempotencyKey: "validate:criterion-1",
      kind: "validate_criteria",
      strategyFingerprint: "validate:test",
      input: { criterionId: "criterion-1" },
      now,
    });
    expect(() => repo.startOperation({
      missionId: "mission-1",
      operationId: operation.id,
      fence: { ownerId: "controller-2", generation: 1 },
      now,
    })).toThrow(MissionRuntimeLeaseFenceError);

    expect(repo.startOperation({ missionId: "mission-1", operationId: operation.id, fence: lease!, now }).attempt)
      .toBe(1);
    const completion = {
      missionId: "mission-1",
      operationId: operation.id,
      fence: lease!,
      result: { passed: true },
      effectEvidenceIds: ["evidence-1"],
      now,
    };
    expect(repo.completeOperation(completion).status).toBe("completed");
    expect(repo.completeOperation(completion).status).toBe("completed");
    expect(repo.get("mission-1")?.activeOperationId).toBeNull();
    expect(() => repo.completeOperation({ ...completion, result: { passed: false } }))
      .toThrow(/different result/i);
    expect(repo.renewLease({
      missionId: "mission-1",
      fence: lease!,
      expiresAt: "2026-07-16T12:02:00.000Z",
      now,
    })).toBe(true);
    expect(repo.releaseLease({ missionId: "mission-1", fence: lease!, now })).toBe(true);
    db.close();
  });

  it("records an ambiguous failed effect without leaving it active", () => {
    const { db, repo, now } = harness();
    repo.create({ missionId: "mission-1", now });
    const lease = repo.claimLease({
      missionId: "mission-1",
      ownerId: "controller-1",
      now,
      expiresAt: "2026-07-16T12:01:00.000Z",
    })!;
    const operation = repo.enqueueOperation({
      id: "operation-1",
      missionId: "mission-1",
      idempotencyKey: "tool:write-1",
      kind: "dispatch_worker",
      strategyFingerprint: "tool:write_file",
      input: { path: "result.txt" },
      now,
    });
    repo.startOperation({ missionId: "mission-1", operationId: operation.id, fence: lease, now });

    const failed = repo.failOperation({
      missionId: "mission-1",
      operationId: operation.id,
      fence: lease,
      result: { message: "Connection ended after dispatch" },
      unknownEffect: true,
      now,
    });

    expect(failed.status).toBe("unknown_effect");
    expect(repo.get("mission-1")?.activeOperationId).toBeNull();
    db.close();
  });

  it("persists progress observations and distinct recovery decisions", () => {
    const { db, repo, now } = harness();
    repo.create({ missionId: "mission-1", now });
    repo.appendProgress({
      id: "progress-1",
      missionId: "mission-1",
      operationId: null,
      kind: "hypothesis_eliminated",
      summary: "Authentication is healthy.",
      evidenceIds: ["evidence-1"],
      strategyFingerprint: "diagnose:auth",
      now,
    });
    repo.recordRecovery({
      id: "recovery-1",
      missionId: "mission-1",
      operationId: null,
      category: "provider_failure",
      diagnosis: "Primary provider failed before producing an effect.",
      failedStrategyFingerprint: "primary:openai:gpt-5.6",
      nextStrategyFingerprint: "fallback:anthropic:claude-sonnet-5",
      action: "switch_provider",
      retryCondition: null,
      exhausted: false,
      now,
    });

    expect(repo.listProgress("mission-1")).toEqual([
      expect.objectContaining({ kind: "hypothesis_eliminated", evidenceIds: ["evidence-1"] }),
    ]);
    expect(repo.listRecoveryDecisions("mission-1")).toEqual([
      expect.objectContaining({ action: "switch_provider", exhausted: false }),
    ]);
    db.close();
  });
});
