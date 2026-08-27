import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrations } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { providerRouteFingerprint } from "../src/routing/effective-context.js";
import {
  boundExecutionCheckpointSnapshot,
  MAX_EXECUTION_CHECKPOINT_BYTES,
} from "../src/execution/checkpoint-snapshot.js";

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

const ESSENTIAL_CHECKPOINT_CATEGORIES = [
  "originalMission",
  "hardRequirements",
  "acceptanceCriteria",
  "decisions",
  "completedWork",
  "filesChanged",
  "unresolvedFailures",
  "recoveryAttempts",
  "approvals",
  "providerRouting",
  "pendingWork",
] as const;

function oversizedCheckpointSnapshot() {
  const item = (category: string, index: number) => `${category}-semantic-${index} ${"durable context ".repeat(180)}`;
  const entries = (category: string) => Array.from({ length: 180 }, (_, index) => item(category, index));
  return {
    ...checkpointSnapshot(),
    originalMission: `objective-semantic-marker ${"mission context ".repeat(4_000)}`,
    hardRequirements: entries("requirement"),
    acceptanceCriteria: entries("criteria"),
    decisions: entries("decision"),
    completedWork: entries("completed"),
    filesChanged: entries("changed-file"),
    unresolvedFailures: entries("failure"),
    recoveryAttempts: entries("recovery"),
    pendingWork: entries("pending"),
    approvals: { state: "authorized", records: entries("approval") },
    providerRouting: { providerId: "deepseek", model: "deepseek-reasoner", route: { host: "api.deepseek.com", details: entries("route") } },
  };
}

describe("durable segmented execution migration", () => {
  it("is a versioned additive migration with restart-safe continuity tables", () => {
    expect(migrations.find((migration) => migration.id === 32))
      .toMatchObject({ id: 32, name: "durable_segmented_execution" });
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
      // Seed the legacy rows with raw SQL against the migration-31 schema.
      // Using today's repositories here wrote columns that do not exist yet at
      // this migration level (`tasks.idempotency_fingerprint` arrives in
      // migration 39), so the test failed before it could assert anything about
      // the upgrade. A migration test has to speak the old schema.
      legacy
        .prepare("INSERT INTO projects (id, schema_version, name, workspace_path, created_at, updated_at) VALUES (?,1,?,?,?,?)")
        .run("legacy-p", "Legacy", "/tmp/legacy", at, at);
      legacy
        .prepare("INSERT INTO tasks (id, schema_version, project_id, type, status, created_at, updated_at) VALUES (?,1,?,?,?,?,?)")
        .run("legacy-t", "legacy-p", "agent_chat", "interrupted", at, at);
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
  it("keeps every essential category loss-aware when an oversized checkpoint is bounded", () => {
    const bounded = boundExecutionCheckpointSnapshot(oversizedCheckpointSnapshot() as any) as any;

    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(MAX_EXECUTION_CHECKPOINT_BYTES);
    expect(bounded.originalMission).toContain("objective-semantic-marker");
    const failures: string[] = [];
    if (bounded.compaction?.version !== 1 || bounded.compaction?.compacted !== true) {
      failures.push("compaction metadata is missing or not marked compacted");
    }
    for (const category of ESSENTIAL_CHECKPOINT_CATEGORIES) {
      const metadata = bounded.compaction?.categories?.[category];
      if (metadata?.compacted !== true || !/^[a-f0-9]{24}$/.test(metadata?.digest ?? "")) {
        failures.push(`${category}: missing deterministic loss metadata`);
      }
      if (!JSON.stringify(bounded[category]).includes(`checkpoint-compacted:${category}`)) {
        failures.push(`${category}: bounded value does not carry its loss marker`);
      }
    }
    expect(failures).toEqual([]);
    expect(boundExecutionCheckpointSnapshot(bounded)).toEqual(bounded);
  });

  it("preserves the bounded fidelity metadata after checkpoint restart reconstruction", () => {
    const db = seeded();
    const repo = executionContinuityRepository(db);
    const segment = repo.openSegment({ taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-reasoner", routeJson: {}, ownerId: "worker-a", now: at });
    const snapshot = boundExecutionCheckpointSnapshot(oversizedCheckpointSnapshot() as any) as any;
    repo.saveCheckpoint({ id: "oversized-checkpoint", taskId: "t", missionId: null, segmentId: segment.id, cursor: 73, snapshot, ownerId: "worker-a", generation: segment.generation, now: at });

    const reloaded = executionContinuityRepository(db).latestCheckpoint("t")!;
    expect(reloaded.cursor).toBe(73);
    expect(Buffer.byteLength(JSON.stringify(reloaded.snapshot), "utf8")).toBeLessThanOrEqual(MAX_EXECUTION_CHECKPOINT_BYTES);
    expect(reloaded.snapshot.originalMission).toContain("objective-semantic-marker");
    expect((reloaded.snapshot as any).compaction).toEqual((snapshot as any).compaction);
    for (const category of ESSENTIAL_CHECKPOINT_CATEGORIES) {
      expect(JSON.stringify((reloaded.snapshot as any)[category])).toContain(`checkpoint-compacted:${category}`);
    }
    db.close();
  });

  it("normalizes malformed legacy checkpoint fields without throwing or exceeding the byte bound", () => {
    const malformed = {
      version: 0,
      originalMission: null,
      hardRequirements: "legacy requirement",
      acceptanceCriteria: undefined,
      decisions: { unexpected: true },
      completedWork: ["valid", 42, null],
      currentPhase: 17,
      filesChanged: null,
      gitStatus: undefined,
      tests: [{ command: 42, exitCode: "failed", result: null }, null],
      unresolvedFailures: undefined,
      recoveryAttempts: { old: true },
      pendingWork: ["resume"],
      approvals: ["legacy"],
      taskId: "legacy-task",
      missionId: 42,
      providerRouting: "legacy-route",
      providerContinuationRefs: null,
      evidenceRequired: undefined,
      requirementBaselinePaths: ["src/existing.ts"],
      requirementBaselinePathCount: Number.MAX_SAFE_INTEGER,
      requirementBaselineIdentityHash: "not-a-digest",
      executionRequirements: [{
        id: "invalid-waiver",
        kind: null,
        sourceExcerpt: "legacy requirement",
        parameters: {},
        authoritative: true,
        status: "waived",
        waiver: { authorizedBy: "attacker", reason: "not authorized", evidenceRefs: ["legacy-proof"] },
      }],
    } as any;

    expect(() => boundExecutionCheckpointSnapshot(malformed)).not.toThrow();
    const bounded = boundExecutionCheckpointSnapshot(malformed) as any;
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(MAX_EXECUTION_CHECKPOINT_BYTES);
    expect(bounded.version).toBe(1);
    expect(bounded.originalMission).toBe("");
    expect(bounded.hardRequirements).toEqual([]);
    expect(bounded.acceptanceCriteria).toEqual([]);
    expect(bounded.decisions).toEqual([]);
    expect(bounded.completedWork).toEqual(["valid"]);
    expect(bounded.tests).toEqual([{ command: "42", exitCode: null, result: "" }]);
    expect(bounded.approvals).toEqual({});
    expect(bounded.providerRouting).toEqual({});
    expect(bounded.requirementBaselinePathCount).toBe(1);
    expect(bounded.requirementBaselineIdentityHash).toMatch(/^[a-f0-9]{24}$/);
    expect(bounded.executionRequirements[0]).toMatchObject({ id: "invalid-waiver", status: "unevaluated" });
    expect(bounded.executionRequirements[0]).not.toHaveProperty("waiver");
  });

  it("digests the complete normalized optional ledgers before retaining the tail", () => {
    const checkpoint = (prefix: string) => ({
      ...checkpointSnapshot(),
      executionRequirements: Array.from({ length: 257 }, (_, index) => ({
        id: `requirement-${index}`,
        kind: null,
        sourceExcerpt: `${prefix}-requirement-${index}`,
        parameters: {},
        authoritative: false,
        status: "unevaluated" as const,
      })),
      requirementEvaluations: Array.from({ length: 257 }, (_, index) => ({
        requirementId: `requirement-${index}`,
        kind: null,
        status: "unevaluated" as const,
        evidence: [`${prefix}-evidence-${index}`],
      })),
      taskArtifactFingerprints: Array.from({ length: 257 }, (_, index) => ({
        path: `src/${prefix}-${index}.ts`,
        contentHash: `hash-${index}`,
      })),
    });
    const before = boundExecutionCheckpointSnapshot(checkpoint("before")) as any;
    const after = boundExecutionCheckpointSnapshot(checkpoint("after")) as any;

    expect(before.compaction.categories.executionRequirements.digest)
      .not.toBe(after.compaction.categories.executionRequirements.digest);
    expect(before.compaction.categories.requirementEvaluations.digest)
      .not.toBe(after.compaction.categories.requirementEvaluations.digest);
    expect(before.compaction.categories.taskArtifactFingerprints.digest)
      .not.toBe(after.compaction.categories.taskArtifactFingerprints.digest);
  });

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

  it("redacts nested credentials in provider continuation state while preserving route lookup", () => {
    const db = seeded();
    const repo = executionContinuityRepository(db);
    const segment = repo.openSegment({ taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-reasoner", routeJson: {}, ownerId: "worker-a", now: at });
    const routeFingerprint = providerRouteFingerprint({ providerId: "deepseek", model: "deepseek-reasoner", protocol: "openai-chat", endpointKind: "default", endpointHost: "api.deepseek.com" });
    const probe = "credential sk-abcdefghijklmnop";
    repo.saveProviderContinuation({
      id: "private-redacted",
      taskId: "t",
      segmentId: segment.id,
      providerId: "deepseek",
      routeFingerprint,
      turnKey: "turn-redacted",
      state: {
        reasoningContent: probe,
        opaque: { nested: { probe }, array: [probe, { value: probe }], safe: "preserved" },
      },
      ownerId: "worker-a",
      generation: segment.generation,
      now: at,
    });

    const raw = db.prepare("SELECT state_json FROM agent_provider_continuations WHERE id=?").get("private-redacted") as { state_json: string };
    expect(raw.state_json).not.toContain(probe);
    expect(JSON.parse(raw.state_json)).toEqual({
      reasoningContent: "credential ***redacted***",
      opaque: { nested: { probe: "credential ***redacted***" }, array: ["credential ***redacted***", { value: "credential ***redacted***" }], safe: "preserved" },
    });
    expect(repo.loadProviderContinuation("t", "turn-redacted", routeFingerprint)).toEqual(JSON.parse(raw.state_json));
    expect(repo.loadProviderContinuation("t", "turn-redacted", "different-route")).toBeNull();
    expect(repo.listProviderReasoning("t")).toEqual([{
      turnKey: "turn-redacted",
      providerId: "deepseek",
      content: "credential ***redacted***",
      createdAt: at,
    }]);
    db.close();
  });

  it("stores hostile continuation state without invoking custom serializers or getters", () => {
    const db = seeded();
    const repo = executionContinuityRepository(db);
    const segment = repo.openSegment({ taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-reasoner", routeJson: {}, ownerId: "worker-a", now: at });
    const routeFingerprint = providerRouteFingerprint({ providerId: "deepseek", model: "deepseek-reasoner", protocol: "openai-chat", endpointKind: "default", endpointHost: "api.deepseek.com" });
    const probe = "credential sk-abcdefghijklmnop";
    let getterCalls = 0;
    const opaque = {} as Record<string, unknown>;
    Object.defineProperty(opaque, probe, { enumerable: true, value: probe });
    Object.defineProperty(opaque, "toJSON", { enumerable: true, value: () => ({ leaked: probe }) });
    Object.defineProperty(opaque, "getter", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return probe;
      },
    });
    opaque.bigint = BigInt(1);
    opaque.symbol = Symbol(probe);
    opaque.self = opaque;
    const inherited = Object.create({ toJSON: () => ({ leaked: probe }) }) as Record<string, unknown>;
    Object.defineProperty(inherited, "safe", { enumerable: true, value: "preserved" });
    opaque.inherited = inherited;

    repo.saveProviderContinuation({
      id: "hostile-continuation",
      taskId: "t",
      segmentId: segment.id,
      providerId: "deepseek",
      routeFingerprint,
      turnKey: "turn-hostile",
      state: { reasoningContent: probe, opaque },
      ownerId: "worker-a",
      generation: segment.generation,
      now: at,
    });

    const raw = db.prepare("SELECT state_json FROM agent_provider_continuations WHERE id=?").get("hostile-continuation") as { state_json: string };
    expect(getterCalls).toBe(0);
    expect(raw.state_json).not.toContain(probe);
    expect(JSON.parse(raw.state_json)).toEqual({
      reasoningContent: "credential ***redacted***",
      opaque: {
        "credential ***redacted***": "credential ***redacted***",
        toJSON: "[Unserializable]",
        getter: "[Unserializable]",
        bigint: "[Unserializable]",
        symbol: "[Unserializable]",
        self: "[Circular]",
        inherited: { safe: "preserved" },
      },
    });
    expect(repo.loadProviderContinuation("t", "turn-hostile", routeFingerprint)).toEqual(JSON.parse(raw.state_json));
    expect(repo.loadProviderContinuation("t", "turn-hostile", "different-route")).toBeNull();
    db.close();
  });

  it("redacts provider-turn tool calls and canonical evidence on writes and legacy reads", () => {
    const db = seeded();
    const repo = executionContinuityRepository(db);
    const segment = repo.openSegment({ taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-v4-flash", routeJson: {}, ownerId: "worker-a", now: at });
    const fence = { ownerId: "worker-a", generation: segment.generation };
    const probe = "credential sk-abcdefghijklmnop";
    const unsafeToolCalls = [{
      id: "call-secret",
      name: "run_command",
      arguments: JSON.stringify({ nested: { secret: probe }, [probe]: probe }),
      opaque: { value: probe },
    }];

    repo.recordProviderTurn({ id: "turn-secret", taskId: "t", segmentId: segment.id, turnKey: "turn-secret", ordinal: 1, assistantText: "safe", toolCalls: unsafeToolCalls, isFinal: true, ...fence, now: at });
    const storedTurn = db.prepare("SELECT tool_calls_json FROM agent_provider_turns WHERE id=?").get("turn-secret") as { tool_calls_json: string };
    expect(storedTurn.tool_calls_json).not.toContain(probe);
    expect(JSON.stringify(repo.listProviderTurns("t"))).not.toContain(probe);

    db.prepare("UPDATE agent_provider_turns SET tool_calls_json=? WHERE id=?")
      .run(JSON.stringify({ version: 1, toolCalls: unsafeToolCalls, isFinal: true }), "turn-secret");
    expect(JSON.stringify(repo.listProviderTurns("t"))).not.toContain(probe);

    const evidence = { verification: { nested: { secret: probe } }, [probe]: { value: probe } };
    repo.createCanonicalAnswer({ id: "answer-secret", taskId: "t", missionId: null, segmentId: segment.id, content: "safe answer", evidenceJson: evidence, ...fence, now: at });
    const storedAnswer = db.prepare("SELECT evidence_json FROM canonical_task_answers WHERE task_id=?").get("t") as { evidence_json: string };
    expect(storedAnswer.evidence_json).not.toContain(probe);
    expect(JSON.stringify(repo.getCanonicalAnswer("t"))).not.toContain(probe);

    db.prepare("UPDATE canonical_task_answers SET evidence_json=? WHERE task_id=?")
      .run(JSON.stringify(evidence), "t");
    expect(JSON.stringify(repo.getCanonicalAnswer("t"))).not.toContain(probe);
    repo.updateCanonicalAnswerEvidence("t", { updated: { nested: probe } });
    const updatedAnswer = db.prepare("SELECT evidence_json FROM canonical_task_answers WHERE task_id=?").get("t") as { evidence_json: string };
    expect(updatedAnswer.evidence_json).not.toContain(probe);
    expect(JSON.stringify(repo.getCanonicalAnswer("t"))).not.toContain(probe);
    db.close();
  });

  it("redacts provider route metadata before durable segment persistence", () => {
    const db = seeded();
    const repo = executionContinuityRepository(db);
    const probe = "credential sk-abcdefghijklmnop";
    const segment = repo.openSegment({
      taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-v4-flash",
      routeJson: { [probe]: { nested: probe }, safe: "preserved" }, ownerId: "worker-a", now: at,
    });
    const raw = db.prepare("SELECT route_json FROM agent_execution_segments WHERE id=?").get(segment.id) as { route_json: string };
    expect(raw.route_json).not.toContain(probe);
    expect(JSON.stringify(repo.listSegments("t"))).not.toContain(probe);
    db.close();
  });

  it("redacts checkpoint structured fields with collision-safe keys before persistence", () => {
    const db = seeded();
    const repo = executionContinuityRepository(db);
    const segment = repo.openSegment({ taskId: "t", missionId: null, providerId: "deepseek", model: "deepseek-v4-flash", routeJson: {}, ownerId: "worker-a", now: at });
    const probe = "credential sk-abcdefghijklmnop";
    const secretKey = "sk-abcdefghijklmnop";
    const snapshot = {
      ...checkpointSnapshot(),
      approvals: { [secretKey]: "secret-key value", "***redacted***": "literal marker value", raw: probe },
    };
    repo.saveCheckpoint({ id: "checkpoint-secret", taskId: "t", missionId: null, segmentId: segment.id, cursor: 1, snapshot, ownerId: "worker-a", generation: segment.generation, now: at });
    const raw = db.prepare("SELECT snapshot_json FROM agent_execution_checkpoints WHERE id=?").get("checkpoint-secret") as { snapshot_json: string };
    expect(raw.snapshot_json).not.toContain(probe);
    expect(JSON.parse(raw.snapshot_json).approvals).toEqual({
      "***redacted***": "secret-key value",
      "***redacted***#2": "literal marker value",
      raw: "credential ***redacted***",
    });
    expect(JSON.stringify(repo.latestCheckpoint("t"))).not.toContain(probe);
    db.close();
  });

  it("redacts canonical evidence in the mission-linked export for legacy rows", () => {
    const db = seeded();
    const mission = missionsRepository(db).create({
      id: "mission-secret", projectId: "p", objective: "Inspect evidence", budget: { maxUsd: null, maxAttempts: null, maxReviewCycles: 2, spentUsd: 0, attemptsUsed: 0, reviewCyclesUsed: 0 },
    }, at);
    taskRepository(db).createTask({ id: "mission-task-secret", projectId: "p", kind: "agent_chat", status: "running", missionId: mission.id, createdAt: at });
    const repo = executionContinuityRepository(db);
    const segment = repo.openSegment({ taskId: "mission-task-secret", missionId: mission.id, providerId: "deepseek", model: "deepseek-v4-flash", routeJson: {}, ownerId: "worker-a", now: at });
    const fence = { ownerId: "worker-a", generation: segment.generation };
    repo.createCanonicalAnswer({ id: "mission-answer-secret", taskId: "mission-task-secret", missionId: mission.id, segmentId: segment.id, content: "safe", evidenceJson: { safe: true }, ...fence, now: at });
    const probe = "credential sk-abcdefghijklmnop";
    db.prepare("UPDATE canonical_task_answers SET evidence_json=? WHERE task_id=?")
      .run(JSON.stringify({ nested: { secret: probe } }), "mission-task-secret");

    const exported = missionsRepository(db).missionLinkedAgentAnswerState(mission.id);
    expect(JSON.stringify(exported)).not.toContain(probe);
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
