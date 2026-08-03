import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { missionRuntimeRepository } from "../src/repositories/mission-runtime.js";
import { toolArtifactsRepository, type ToolArtifactRepository } from "../src/repositories/tool-artifacts.js";
import { readArtifactRange } from "../src/execution/artifact-externalization.js";

/**
 * Task 5 review round 2 reproduced two fix regressions. Both are cases where a
 * value is redacted on one side of a comparison and raw on the other, so the
 * two sides can never agree.
 *
 *  - Legacy artifacts store a pre-redaction `bytes` column, but `getContent`
 *    redacts on read. Range pagination mixed the two, so the last page of a
 *    legacy artifact containing a secret reported `truncated` forever.
 *  - `completeOperation` / `failOperation` compared the redacted persisted
 *    result against the caller's raw retry input, so an idempotent retry
 *    carrying a secret was rejected as a conflicting result.
 */

const createdAt = "2026-08-02T12:00:00.000Z";
const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => {
  db.close();
});

/**
 * Write an artifact the way a pre-sanitization build did: raw secret-bearing
 * content, and a `bytes` column measuring that raw content.
 */
function insertLegacyArtifact(id: string, raw: string): void {
  db.prepare(
    `INSERT INTO tool_artifacts
      (id, task_id, tool_name, kind, content_type, bytes, content_hash, summary, excerpt, content, refcount, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
  ).run(
    id,
    "task-legacy",
    "read_file",
    "tool-result",
    "text/plain",
    Buffer.byteLength(raw, "utf8"),
    createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex"),
    "legacy artifact",
    raw.slice(0, 120),
    Buffer.from(raw, "utf8"),
    createdAt,
  );
}

describe("legacy artifact range pagination", () => {
  it("terminates on the last page when redaction shrinks legacy content", () => {
    const repo: ToolArtifactRepository = toolArtifactsRepository(db);
    const raw = `config loaded\ntoken=${secret}\ntrailing line\n`;
    insertLegacyArtifact("artifact-legacy", raw);

    const row = repo.get("artifact-legacy")!;
    const served = repo.getContent("artifact-legacy")!;
    // Precondition: the stored byte count is stale relative to what is served.
    expect(served.byteLength).toBeLessThan(row.bytes);

    const offered = new Set(["artifact-legacy"]);
    const first = readArtifactRange(repo, offered, { id: "artifact-legacy" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The whole (redacted) artifact fits in one page, so this is the last page.
    expect(first.payload.returnedBytes).toBe(served.byteLength);
    expect(first.payload.totalBytes).toBe(served.byteLength);
    expect(first.payload.truncated).toBe(false);
    expect(first.payload).not.toHaveProperty("nextOffset");
    expect(first.payload.content).not.toContain(secret);
  });

  it("never advertises a next offset that returns no further bytes", () => {
    const repo: ToolArtifactRepository = toolArtifactsRepository(db);
    insertLegacyArtifact("artifact-loop", `head\napi_key=${secret}\ntail\n`);
    const offered = new Set(["artifact-loop"]);

    // Follow pagination the way a compliant model would. A stale byte count
    // previously made this run forever.
    let offset = 0;
    const seen = new Set<number>();
    for (let page = 0; page < 8; page += 1) {
      const result = readArtifactRange(repo, offered, { id: "artifact-loop", offset, length: 8 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      if (!result.payload.truncated) return;
      const next = (result.payload as { nextOffset?: number }).nextOffset!;
      expect(result.payload.returnedBytes).toBeGreaterThan(0);
      expect(seen.has(next)).toBe(false);
      seen.add(next);
      offset = next;
    }
    throw new Error("legacy artifact pagination did not terminate");
  });
});

function runtimeHarness() {
  projectRepository(db).createProject({
    id: "project-1",
    name: "Round 2 fixture",
    workspacePath: "C:/synthetic-workspace",
    createdAt,
  });
  const mission = missionsRepository(db).create(
    {
      id: "mission-1",
      projectId: "project-1",
      objective: "Synthetic runtime fixture",
      budget: {
        maxUsd: null,
        maxAttempts: null,
        maxReviewCycles: 2,
        spentUsd: 0,
        attemptsUsed: 0,
        reviewCyclesUsed: 0,
      },
    },
    createdAt,
  );
  const runtime = missionRuntimeRepository(db);
  runtime.create({ missionId: "mission-1", now: createdAt });
  return { mission, runtime };
}

function claimLease(runtime: ReturnType<typeof missionRuntimeRepository>) {
  const fence = runtime.claimLease({
    missionId: "mission-1",
    ownerId: "worker-1",
    now: createdAt,
    expiresAt: "2026-08-02T13:00:00.000Z",
  });
  if (!fence) throw new Error("expected to claim the runtime lease");
  return { fence };
}

describe("mission operation idempotent retry", () => {
  it("accepts a repeated completion whose raw result carries a secret", () => {
    const { runtime } = runtimeHarness();
    const lease = claimLease(runtime);
    const operation = runtime.enqueueOperation({
      missionId: "mission-1",
      idempotencyKey: "op-1",
      kind: "dispatch_worker",
      strategyFingerprint: null,
      input: { command: "deploy" },
      now: createdAt,
    });
    runtime.startOperation({ missionId: "mission-1", operationId: operation.id, fence: lease.fence, now: createdAt });

    const result = { stdout: `deployed with token=${secret}` };
    const first = runtime.completeOperation({
      missionId: "mission-1",
      operationId: operation.id,
      fence: lease.fence,
      result,
      effectEvidenceIds: [`evidence for ${secret}`],
      now: createdAt,
    });
    expect(JSON.stringify(first.result)).not.toContain(secret);

    // The same caller retries with the same raw payload after a crash.
    const retried = runtime.completeOperation({
      missionId: "mission-1",
      operationId: operation.id,
      fence: lease.fence,
      result,
      effectEvidenceIds: [`evidence for ${secret}`],
      now: createdAt,
    });
    expect(retried.id).toBe(first.id);
    expect(retried.status).toBe("completed");
  });

  it("still rejects a repeated completion with a genuinely different result", () => {
    const { runtime } = runtimeHarness();
    const lease = claimLease(runtime);
    const operation = runtime.enqueueOperation({
      missionId: "mission-1",
      idempotencyKey: "op-1",
      kind: "dispatch_worker",
      strategyFingerprint: null,
      input: { command: "deploy" },
      now: createdAt,
    });
    runtime.startOperation({ missionId: "mission-1", operationId: operation.id, fence: lease.fence, now: createdAt });
    runtime.completeOperation({
      missionId: "mission-1",
      operationId: operation.id,
      fence: lease.fence,
      result: { stdout: "first" },
      effectEvidenceIds: [],
      now: createdAt,
    });

    expect(() =>
      runtime.completeOperation({
        missionId: "mission-1",
        operationId: operation.id,
        fence: lease.fence,
        result: { stdout: "second" },
        effectEvidenceIds: [],
        now: createdAt,
      }),
    ).toThrow(/different result/);
  });

  it("accepts a repeated failure whose raw result carries a secret", () => {
    const { runtime } = runtimeHarness();
    const lease = claimLease(runtime);
    const operation = runtime.enqueueOperation({
      missionId: "mission-1",
      idempotencyKey: "op-2",
      kind: "dispatch_worker",
      strategyFingerprint: null,
      input: { command: "deploy" },
      now: createdAt,
    });
    runtime.startOperation({ missionId: "mission-1", operationId: operation.id, fence: lease.fence, now: createdAt });

    const result = { stderr: `refused for token=${secret}` };
    const first = runtime.failOperation({
      missionId: "mission-1",
      operationId: operation.id,
      fence: lease.fence,
      result,
      effectEvidenceIds: [],
      now: createdAt,
    });
    expect(JSON.stringify(first.result)).not.toContain(secret);

    const retried = runtime.failOperation({
      missionId: "mission-1",
      operationId: operation.id,
      fence: lease.fence,
      result,
      effectEvidenceIds: [],
      now: createdAt,
    });
    expect(retried.id).toBe(first.id);
    expect(retried.status).toBe("failed");
  });
});
