import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrations } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { providerRouteFingerprint } from "../src/routing/effective-context.js";

const at = "2026-07-13T00:00:00.000Z";

function seeded() {
  const db = openDatabase(":memory:");
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath: "/tmp/p", createdAt: at });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "running", createdAt: at });
  return db;
}

function checkpointSnapshot(taskId = "t") {
  return {
    version: 1 as const,
    originalMission: "resume once",
    hardRequirements: [] as string[],
    prohibitedActions: [] as string[],
    acceptanceCriteria: [] as string[],
    decisions: [] as string[],
    completedWork: [] as string[],
    currentPhase: "work",
    filesChanged: [] as string[],
    gitStatus: "",
    tests: [] as Array<{ command: string; exitCode: number | null; result: string }>,
    unresolvedFailures: [] as string[],
    recoveryAttempts: [] as string[],
    pendingWork: [] as string[],
    approvals: {},
    taskId,
    missionId: null,
    providerRouting: {},
    providerContinuationRefs: [] as string[],
    evidenceRequired: [] as string[],
  };
}

describe("durable segmented execution migration", () => {
  it("is a versioned additive migration with restart-safe continuity tables", () => {
    expect(migrations.at(-1)).toMatchObject({ id: 32, name: "durable_segmented_execution" });
    const db = seeded();
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name));
    for (const name of [
      "agent_execution_segments",
      "agent_provider_turns",
      "agent_execution_checkpoints",
      "agent_provider_continuations",
      "canonical_task_answers",
    ]) expect(tables.has(name), name).toBe(true);
    db.close();
  });

  it("upgrades a file-backed migration-31 database without rewriting existing tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-migration-32-"));
    const dbPath = join(root, "morrow.sqlite");
    try {
      const legacy = new Database(dbPath);
      legacy.pragma("foreign_keys = ON");
      legacy.exec("CREATE TABLE schema_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
      const insertMigration = legacy.prepare("INSERT INTO schema_migrations VALUES(?,?,?)");
      for (const migration of migrations.filter((item) => item.id <= 31)) {
        legacy.transaction(() => {
          if (migration.sql) legacy.exec(migration.sql);
          if (migration.up) migration.up(legacy);
          insertMigration.run(migration.id, migration.name, at);
        })();
      }
      projectRepository(legacy).createProject({ id: "legacy-p", name: "Legacy", workspacePath: "/tmp/legacy", createdAt: at });
      taskRepository(legacy).createTask({ id: "legacy-t", projectId: "legacy-p", kind: "agent_chat", status: "interrupted", createdAt: at });
      legacy.close();

      const upgraded = openDatabase(dbPath);
      expect(taskRepository(upgraded).getTaskById("legacy-t")).toMatchObject({ status: "interrupted", projectId: "legacy-p" });
      const columns = upgraded.prepare("PRAGMA table_info(agent_execution_segments)").all() as Array<{ name: string; dflt_value: string | null }>;
      expect(columns.find((column) => column.name === "lease_generation")).toMatchObject({ dflt_value: "1" });
      const missionIndex = upgraded.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='canonical_task_answers_mission_idx'").get() as { sql: string };
      expect(missionIndex.sql).not.toMatch(/CREATE\s+UNIQUE/i);
      expect(executionContinuityRepository(upgraded).listSegments("legacy-t")).toEqual([]);
      upgraded.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("execution continuity repository", () => {
  it("rolls segments forward without changing mission/task identity", () => {
    const db = seeded();
    const repo = executionContinuityRepository(db);
    const first = repo.openSegment({ taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-v4-flash", routeJson: { endpointLimitTokens: 131072 }, ownerId: "worker-a", now: at });
    const same = repo.openSegment({ taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-v4-flash", routeJson: { endpointLimitTokens: 131072 }, ownerId: "worker-a", now: at });
    expect(same.id).toBe(first.id);
    const second = repo.rolloverSegment({ taskId: "t", currentSegmentId: first.id, reason: "turn_budget", providerId: "deepseek", model: "deepseek-v4-flash", routeJson: { endpointLimitTokens: 131072 }, ownerId: "worker-a", generation: first.generation, now: at });
    expect(second.taskId).toBe("t");
    expect(second.sequence).toBe(2);
    expect(repo.listSegments("t").map((segment) => segment.status)).toEqual(["checkpointed", "running"]);
    db.close();
  });

  it("rejects a second executor instead of adopting the live owner's identity", () => {
    const db = seeded();
    const repo = executionContinuityRepository(db);
    repo.openSegment({ taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-v4-flash", routeJson: {}, ownerId: "worker-a", now: at });

    expect(() => repo.openSegment({ taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-v4-flash", routeJson: {}, ownerId: "worker-b", now: at }))
      .toThrow(/already owned|lease/i);

    expect(repo.getRunningSegment("t")?.ownerId).toBe("worker-a");
    db.close();
  });

  it("allows exactly one owner to claim an expired resumable segment", () => {
    const db = seeded();
    const repo = executionContinuityRepository(db);
    const deadOwnerId = "morrow-pid:999999999:dead";
    const segment = repo.openSegment({ taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-v4-flash", routeJson: {}, ownerId: deadOwnerId, now: at, leaseExpiresAt: at });
    repo.saveCheckpoint({ id: "cp-claim", taskId: "t", missionId: null, segmentId: segment.id, cursor: 17, snapshot: { version: 1, originalMission: "resume once", hardRequirements: [], prohibitedActions: [], acceptanceCriteria: [], decisions: [], completedWork: [], currentPhase: "work", filesChanged: [], gitStatus: "", tests: [], unresolvedFailures: [], recoveryAttempts: [], pendingWork: [], approvals: {}, taskId: "t", missionId: null, providerRouting: {}, providerContinuationRefs: [], evidenceRequired: [] }, ownerId: deadOwnerId, generation: segment.generation, now: at });

    const first = repo.claimResumableSegment({ taskId: "t", ownerId: "recovery-a", expectedOwnerId: deadOwnerId, expectedGeneration: segment.generation, takeoverReason: "owner_dead", now: at, leaseExpiresAt: "2026-07-13T00:05:00.000Z" });
    const second = repo.claimResumableSegment({ taskId: "t", ownerId: "recovery-b", expectedOwnerId: deadOwnerId, expectedGeneration: segment.generation, takeoverReason: "owner_dead", now: at, leaseExpiresAt: "2026-07-13T00:05:00.000Z" });

    expect(first).toMatchObject({ checkpointCursor: 17, segment: { id: segment.id, ownerId: "recovery-a", leaseExpiresAt: "2026-07-13T00:05:00.000Z" } });
    expect(second).toBeNull();
    expect(repo.listSegments("t")).toHaveLength(1);
    db.close();
  });

  it("fences every stale-owner write after a dead-owner takeover", () => {
    const db = seeded();
    const repo = executionContinuityRepository(db);
    const oldOwnerId = "morrow-pid:999999999:old";
    const segment = repo.openSegment({ taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-v4-flash", routeJson: {}, ownerId: oldOwnerId, now: at, leaseExpiresAt: at });
    repo.saveCheckpoint({ id: "cp-before", taskId: "t", missionId: null, segmentId: segment.id, cursor: 17, snapshot: checkpointSnapshot(), ownerId: oldOwnerId, generation: 1, now: at });

    const claimed = repo.claimResumableSegment({
      taskId: "t",
      ownerId: "recovery-owner",
      expectedOwnerId: oldOwnerId,
      expectedGeneration: 1,
      takeoverReason: "owner_dead",
      now: at,
      leaseExpiresAt: "2026-07-13T00:05:00.000Z",
    });
    expect(claimed?.segment).toMatchObject({ ownerId: "recovery-owner", generation: 2 });

    const staleFence = { ownerId: oldOwnerId, generation: 1 };
    expect(repo.renewSegmentLease({ segmentId: segment.id, ...staleFence, leaseExpiresAt: "2026-07-13T00:10:00.000Z" })).toBe(false);
    expect(() => repo.saveCheckpoint({ id: "cp-stale", taskId: "t", missionId: null, segmentId: segment.id, cursor: 18, snapshot: checkpointSnapshot(), ...staleFence, now: at })).toThrow(/lease|owner|fence/i);
    expect(() => repo.recordProviderTurn({ id: "turn-stale", taskId: "t", segmentId: segment.id, turnKey: "stale", ordinal: 1, assistantText: "stale", toolCalls: [], ...staleFence, now: at })).toThrow(/lease|owner|fence/i);
    expect(() => repo.saveProviderContinuation({ id: "continuation-stale", taskId: "t", segmentId: segment.id, providerId: "deepseek", routeFingerprint: "route", turnKey: "stale", state: { reasoningContent: "private" }, ...staleFence, now: at })).toThrow(/lease|owner|fence/i);
    expect(() => repo.createCanonicalAnswer({ id: "answer-stale", taskId: "t", missionId: null, segmentId: segment.id, content: "stale", evidenceJson: {}, ...staleFence, now: at })).toThrow(/lease|owner|fence/i);
    expect(repo.getCanonicalAnswer("t")).toBeNull();
    repo.completeSegment(segment.id, at, staleFence);
    expect(repo.getRunningSegment("t")?.ownerId).toBe("recovery-owner");
    repo.failSegment(segment.id, "stale_cancel", at, staleFence);
    expect(repo.getRunningSegment("t")?.ownerId).toBe("recovery-owner");
    expect(() => repo.rolloverSegment({ taskId: "t", currentSegmentId: segment.id, reason: "stale", providerId: "deepseek", model: "deepseek-v4-flash", routeJson: {}, ...staleFence, now: at })).toThrow(/lease|owner|fence/i);

    db.close();
  });

  it("persists a structured checkpoint and durable cursor across repository reconstruction", () => {
    const db = seeded();
    const repo = executionContinuityRepository(db);
    const segment = repo.openSegment({ taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-v4-flash", routeJson: {}, ownerId: "worker-a", now: at });
    repo.saveCheckpoint({
      id: "checkpoint-1",
      taskId: "t",
      missionId: null,
      segmentId: segment.id,
      cursor: 41,
      snapshot: {
        version: 1,
        originalMission: "Implement continuity",
        hardRequirements: ["preserve requirements"],
        prohibitedActions: ["do not merge"],
        acceptanceCriteria: ["restart resumes"],
        decisions: ["durable segmented execution"],
        completedWork: ["route preflight"],
        currentPhase: "implementation",
        filesChanged: ["agent.ts"],
        gitStatus: " M agent.ts",
        tests: [{ command: "pnpm test", exitCode: 1, result: "one unresolved failure" }],
        unresolvedFailures: ["restart test failing"],
        recoveryAttempts: ["fresh provider segment"],
        pendingWork: ["repair restart"],
        approvals: { state: "authorized" },
        taskId: "t",
        missionId: null,
        providerRouting: { providerId: "deepseek", model: "deepseek-v4-flash" },
        providerContinuationRefs: [],
        evidenceRequired: ["full validation"],
      },
      ownerId: "worker-a",
      generation: segment.generation,
      now: at,
    });

    const reloaded = executionContinuityRepository(db).latestCheckpoint("t")!;
    expect(reloaded.cursor).toBe(41);
    expect(reloaded.snapshot.hardRequirements).toEqual(["preserve requirements"]);
    expect(reloaded.snapshot.unresolvedFailures).toEqual(["restart test failing"]);
    db.close();
  });

  it("stores opaque continuation separately and never includes it in checkpoint projections", () => {
    const db = seeded();
    const repo = executionContinuityRepository(db);
    const segment = repo.openSegment({ taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-reasoner", routeJson: {}, ownerId: "worker-a", now: at });
    const routeFingerprint = providerRouteFingerprint({ providerId: "deepseek", model: "deepseek-reasoner", protocol: "openai-chat", endpointKind: "default", endpointHost: "api.deepseek.com" });
    repo.saveProviderContinuation({ id: "private-1", taskId: "t", segmentId: segment.id, providerId: "deepseek", routeFingerprint, turnKey: "turn-1", state: { reasoningContent: "PRIVATE_REASONING" }, ownerId: "worker-a", generation: segment.generation, now: at });
    repo.saveCheckpoint({ id: "cp", taskId: "t", missionId: null, segmentId: segment.id, cursor: 1, snapshot: { version: 1, originalMission: "goal", hardRequirements: [], prohibitedActions: [], acceptanceCriteria: [], decisions: [], completedWork: [], currentPhase: "work", filesChanged: [], gitStatus: "", tests: [], unresolvedFailures: [], recoveryAttempts: [], pendingWork: [], approvals: {}, taskId: "t", missionId: null, providerRouting: {}, providerContinuationRefs: ["private-1"], evidenceRequired: [] }, ownerId: "worker-a", generation: segment.generation, now: at });
    expect(JSON.stringify(repo.latestCheckpoint("t"))).not.toContain("PRIVATE_REASONING");
    expect(repo.latestCheckpoint("t")?.snapshot.providerContinuationRefs).toEqual(["private-1"]);
    expect(repo.loadProviderContinuation("t", "turn-1", routeFingerprint)?.reasoningContent).toBe("PRIVATE_REASONING");
    const otherRoute = providerRouteFingerprint({ providerId: "openai", model: "gpt-5.4", protocol: "openai-chat", endpointKind: "default", endpointHost: "api.openai.com" });
    expect(repo.loadProviderContinuation("t", "turn-1", otherRoute)).toBeNull();
    db.close();
  });

  it("deduplicates provider turns and permits exactly one canonical final answer", () => {
    const db = seeded();
    const repo = executionContinuityRepository(db);
    const segment = repo.openSegment({ taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-v4-flash", routeJson: {}, ownerId: "worker-a", now: at });
    const fence = { ownerId: "worker-a", generation: segment.generation };
    const first = repo.recordProviderTurn({ id: "pt-1", taskId: "t", segmentId: segment.id, turnKey: "provider-response-abc", ordinal: 1, assistantText: "once", toolCalls: [], isFinal: true, ...fence, now: at });
    const duplicate = repo.recordProviderTurn({ id: "pt-2", taskId: "t", segmentId: segment.id, turnKey: "provider-response-abc", ordinal: 1, assistantText: "twice", toolCalls: [], isFinal: true, ...fence, now: at });
    expect(duplicate.id).toBe(first.id);
    expect(repo.listProviderTurns("t")).toEqual([
      expect.objectContaining({ id: first.id, assistantText: "once", isFinal: true }),
    ]);
    const canonicalInput = { id: "answer-1", taskId: "t", missionId: null, segmentId: segment.id, content: "authoritative", evidenceJson: { verified: true }, ...fence, now: at };
    expect(repo.createCanonicalAnswer(canonicalInput).content).toBe("authoritative");
    expect(repo.createCanonicalAnswer({ ...canonicalInput, id: "answer-retry", now: "2026-07-13T00:01:00.000Z" })).toMatchObject({
      id: "answer-1",
      content: "authoritative",
    });
    expect(() => repo.createCanonicalAnswer({ id: "answer-2", taskId: "t", missionId: null, segmentId: segment.id, content: "duplicate", evidenceJson: {}, ...fence, now: at })).toThrow(/canonical answer already exists/i);
    db.close();
  });

  it("reconstructs provider turns by segment sequence and turn ordinal when timestamps tie", () => {
    const db = seeded();
    const repo = executionContinuityRepository(db);
    const firstSegment = repo.openSegment({ taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-v4-flash", routeJson: {}, ownerId: "worker-a", now: at });
    repo.recordProviderTurn({ id: "z-earlier", taskId: "t", segmentId: firstSegment.id, turnKey: "turn-1", ordinal: 1, assistantText: "first", toolCalls: [], ownerId: "worker-a", generation: firstSegment.generation, now: at });
    const secondSegment = repo.rolloverSegment({ taskId: "t", currentSegmentId: firstSegment.id, reason: "turn_budget", providerId: "deepseek", model: "deepseek-v4-flash", routeJson: {}, ownerId: "worker-a", generation: firstSegment.generation, now: at });
    repo.recordProviderTurn({ id: "a-later", taskId: "t", segmentId: secondSegment.id, turnKey: "turn-2", ordinal: 1, assistantText: "second", toolCalls: [], ownerId: "worker-a", generation: secondSegment.generation, now: at });

    expect(repo.listProviderTurns("t").map((turn) => turn.assistantText)).toEqual(["first", "second"]);
    db.close();
  });
});
