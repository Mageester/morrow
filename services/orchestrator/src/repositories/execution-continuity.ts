import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import type { ProviderContinuationState } from "../provider/base.js";

export interface ExecutionSegment {
  id: string;
  taskId: string;
  missionId: string | null;
  sequence: number;
  status: "running" | "checkpointed" | "completed" | "failed";
  boundaryReason: string | null;
  providerId: string;
  model: string;
  routeJson: Record<string, unknown>;
  ownerId: string | null;
  generation: number;
  leaseExpiresAt: string | null;
  startedAt: string;
  closedAt: string | null;
}

export interface ExecutionLeaseFence {
  ownerId: string;
  generation: number;
}

export const MISSION_WORKER_OUTCOMES = [
  "context_rollover_required",
  "provider_recovery_required",
  "strategy_change_required",
  "validation_required",
  "candidate_answer_ready",
] as const;
export type MissionWorkerOutcome = typeof MISSION_WORKER_OUTCOMES[number];

export type ExecutionLeaseOwnerStatus = "alive" | "dead" | "unknown";

export class ExecutionLeaseFenceError extends Error {
  readonly code = "EXECUTION_LEASE_LOST";

  constructor(message = "Execution segment lease fence was lost") {
    super(message);
    this.name = "ExecutionLeaseFenceError";
  }
}

export interface ExecutionCheckpointSnapshot {
  version: 1;
  originalMission: string;
  hardRequirements: string[];
  prohibitedActions: string[];
  acceptanceCriteria: string[];
  decisions: string[];
  completedWork: string[];
  currentPhase: string;
  filesChanged: string[];
  gitStatus: string;
  tests: Array<{ command: string; exitCode: number | null; result: string }>;
  unresolvedFailures: string[];
  recoveryAttempts: string[];
  pendingWork: string[];
  approvals: Record<string, unknown>;
  taskId: string;
  missionId: string | null;
  providerRouting: Record<string, unknown>;
  providerContinuationRefs: string[];
  evidenceRequired: string[];
}

export interface ExecutionCheckpoint {
  id: string;
  taskId: string;
  missionId: string | null;
  segmentId: string;
  cursor: number;
  snapshot: ExecutionCheckpointSnapshot;
  createdAt: string;
}

const LEASE_OWNER_PREFIX = "morrow-pid";

/**
 * Lease owners include the local process id so startup recovery can distinguish
 * an abandoned segment from work still owned by another live local
 * orchestrator. The random suffix prevents two executors in one process from
 * sharing ownership.
 */
export function createExecutionLeaseOwnerId(): string {
  return `${LEASE_OWNER_PREFIX}:${process.pid}:${randomUUID()}`;
}

/**
 * Determine whether a lease owner can be proven alive or dead. Unknown and
 * legacy formats are deliberately not treated as dead: a timestamp alone is
 * not proof that another orchestrator stopped.
 */
export function executionLeaseOwnerStatus(ownerId: string | null): ExecutionLeaseOwnerStatus {
  if (!ownerId) return "unknown";
  const match = new RegExp(`^${LEASE_OWNER_PREFIX}:(\\d+):`).exec(ownerId);
  if (!match) return "unknown";
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    // PID reuse is conservative: a live process at the recorded PID prevents
    // takeover even if it is not the process that originally created the id.
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return "alive";
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

export function isExecutionLeaseOwnerAlive(ownerId: string | null): boolean {
  return executionLeaseOwnerStatus(ownerId) === "alive";
}

type SegmentRow = {
  id: string; task_id: string; mission_id: string | null; sequence: number;
  status: ExecutionSegment["status"]; boundary_reason: string | null;
  provider_id: string; model: string; route_json: string; owner_id: string | null; lease_generation: number; lease_expires_at: string | null;
  started_at: string; closed_at: string | null;
};

function segment(row: SegmentRow): ExecutionSegment {
  return {
    id: row.id, taskId: row.task_id, missionId: row.mission_id, sequence: row.sequence,
    status: row.status, boundaryReason: row.boundary_reason, providerId: row.provider_id,
    model: row.model, routeJson: JSON.parse(row.route_json) as Record<string, unknown>,
    ownerId: row.owner_id, generation: row.lease_generation, leaseExpiresAt: row.lease_expires_at, startedAt: row.started_at, closedAt: row.closed_at,
  };
}

function providerTurnPayload(raw: string): { toolCalls: unknown[]; isFinal: boolean } {
  const parsed = JSON.parse(raw) as unknown;
  // Migration-32 rows stored only the tool-call array. They remain readable,
  // but are not safe to replay as canonical final turns because their finality
  // was inferred rather than durably asserted.
  if (Array.isArray(parsed)) return { toolCalls: parsed, isFinal: false };
  if (parsed && typeof parsed === "object") {
    const payload = parsed as { toolCalls?: unknown; isFinal?: unknown };
    return {
      toolCalls: Array.isArray(payload.toolCalls) ? payload.toolCalls : [],
      isFinal: payload.isFinal === true,
    };
  }
  return { toolCalls: [], isFinal: false };
}

export function executionContinuityRepository(db: Database.Database) {
  const getRunning = db.prepare("SELECT * FROM agent_execution_segments WHERE task_id=? AND status='running'");
  const getSegment = db.prepare("SELECT * FROM agent_execution_segments WHERE id=?");
  const insertSegment = db.prepare(`INSERT INTO agent_execution_segments
    (id,task_id,mission_id,sequence,status,boundary_reason,provider_id,model,route_json,owner_id,lease_generation,lease_expires_at,started_at,closed_at)
    VALUES (?,?,?,?, 'running',NULL,?,?,?,?,1,?,?,NULL)`);

  const assertFence = (segmentId: string, fence: ExecutionLeaseFence): SegmentRow => {
    const row = db.prepare(`SELECT * FROM agent_execution_segments
      WHERE id=? AND status='running' AND owner_id=? AND lease_generation=?`).get(segmentId, fence.ownerId, fence.generation) as SegmentRow | undefined;
    if (!row) throw new ExecutionLeaseFenceError();
    return row;
  };

  const openSegment = (input: { taskId: string; missionId: string | null; providerId: string; model: string; routeJson: Record<string, unknown>; ownerId: string; now: string; leaseExpiresAt?: string }): ExecutionSegment => {
    return db.transaction(() => {
      const current = getRunning.get(input.taskId) as SegmentRow | undefined;
      if (current) {
        if (current.owner_id === input.ownerId) return segment(current);
        throw new ExecutionLeaseFenceError("Execution segment is already owned by another lease");
      }
      const sequence = (db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM agent_execution_segments WHERE task_id=?").get(input.taskId) as { n: number }).n;
      const id = randomUUID();
      const defaultLease = new Date(Date.parse(input.now) + 5 * 60_000).toISOString();
      insertSegment.run(id, input.taskId, input.missionId, sequence, input.providerId, input.model, JSON.stringify(input.routeJson), input.ownerId, input.leaseExpiresAt ?? defaultLease, input.now);
      return segment(getSegment.get(id) as SegmentRow);
    })();
  };

  return {
    openSegment,
    getRunningSegment(taskId: string): ExecutionSegment | null {
      const row = getRunning.get(taskId) as SegmentRow | undefined;
      return row ? segment(row) : null;
    },
    claimResumableSegment(input: { taskId: string; ownerId: string; expectedOwnerId: string | null; expectedGeneration: number; takeoverReason: "owner_dead"; now: string; leaseExpiresAt: string }): { segment: ExecutionSegment; checkpointCursor: number } | null {
      return db.transaction(() => {
        const current = getRunning.get(input.taskId) as SegmentRow | undefined;
        if (!current) return null;
        if (input.takeoverReason !== "owner_dead" || executionLeaseOwnerStatus(input.expectedOwnerId) !== "dead") return null;
        const checkpoint = db.prepare("SELECT durable_event_cursor FROM agent_execution_checkpoints WHERE task_id=? ORDER BY durable_event_cursor DESC,id DESC LIMIT 1").get(input.taskId) as { durable_event_cursor: number } | undefined;
        if (!checkpoint) return null;
        const claimed = db.prepare(`UPDATE agent_execution_segments
          SET owner_id=?, lease_generation=lease_generation+1, lease_expires_at=?
          WHERE id=? AND status='running'
            AND owner_id IS ?
            AND lease_generation=?`).run(
              input.ownerId,
              input.leaseExpiresAt,
              current.id,
              input.expectedOwnerId,
              input.expectedGeneration,
            );
        if (claimed.changes !== 1) return null;
        return { segment: segment(getSegment.get(current.id) as SegmentRow), checkpointCursor: checkpoint.durable_event_cursor };
      })();
    },
    renewSegmentLease(input: { segmentId: string; ownerId: string; generation: number; leaseExpiresAt: string }): boolean {
      return db.prepare("UPDATE agent_execution_segments SET lease_expires_at=? WHERE id=? AND status='running' AND owner_id=? AND lease_generation=?")
        .run(input.leaseExpiresAt, input.segmentId, input.ownerId, input.generation).changes === 1;
    },
    rolloverSegment(input: { taskId: string; currentSegmentId: string; reason: string; providerId: string; model: string; routeJson: Record<string, unknown>; ownerId: string; generation: number; now: string }): ExecutionSegment {
      return db.transaction(() => {
        const current = getSegment.get(input.currentSegmentId) as SegmentRow | undefined;
        if (!current || current.task_id !== input.taskId) throw new Error("Execution segment not found");
        if (current.status === "running") {
          const closed = db.prepare(`UPDATE agent_execution_segments
            SET status='checkpointed', boundary_reason=?, closed_at=?, owner_id=NULL, lease_expires_at=NULL
            WHERE id=? AND status='running' AND owner_id=? AND lease_generation=?`)
            .run(input.reason, input.now, current.id, input.ownerId, input.generation);
          if (closed.changes !== 1) throw new ExecutionLeaseFenceError("Execution segment lease fence was lost during rollover");
        }
        return openSegment({ taskId: input.taskId, missionId: current.mission_id, providerId: input.providerId, model: input.model, routeJson: input.routeJson, ownerId: input.ownerId, now: input.now });
      })();
    },
    listSegments(taskId: string): ExecutionSegment[] {
      return (db.prepare("SELECT * FROM agent_execution_segments WHERE task_id=? ORDER BY sequence").all(taskId) as SegmentRow[]).map(segment);
    },
    completeSegment(
      segmentId: string,
      now: string,
      fence: ExecutionLeaseFence,
      boundaryReason = "task_complete",
    ): boolean {
      return db.prepare(`UPDATE agent_execution_segments
        SET status='completed', boundary_reason=?, closed_at=?, owner_id=NULL, lease_expires_at=NULL
        WHERE id=? AND status='running' AND owner_id=? AND lease_generation=?`)
        .run(boundaryReason, now, segmentId, fence.ownerId, fence.generation).changes === 1;
    },
    failSegment(segmentId: string, reason: string, now: string, fence: ExecutionLeaseFence): boolean {
      return db.prepare(`UPDATE agent_execution_segments
        SET status='failed', boundary_reason=?, closed_at=?, owner_id=NULL, lease_expires_at=NULL
        WHERE id=? AND status='running' AND owner_id=? AND lease_generation=?`)
        .run(reason, now, segmentId, fence.ownerId, fence.generation).changes === 1;
    },
    failAbandonedSegment(input: { segmentId: string; expectedOwnerId: string; expectedGeneration: number; reason: string; now: string }): boolean {
      if (executionLeaseOwnerStatus(input.expectedOwnerId) !== "dead") return false;
      return db.prepare(`UPDATE agent_execution_segments
        SET status='failed', boundary_reason=?, closed_at=?, owner_id=NULL, lease_expires_at=NULL
        WHERE id=? AND status='running' AND owner_id=? AND lease_generation=?`)
        .run(input.reason, input.now, input.segmentId, input.expectedOwnerId, input.expectedGeneration).changes === 1;
    },
    recordProviderTurn(input: { id: string; taskId: string; segmentId: string; turnKey: string; ordinal: number; assistantText: string; toolCalls: unknown[]; isFinal?: boolean; ownerId: string; generation: number; now: string }) {
      return db.transaction(() => {
        assertFence(input.segmentId, input);
        db.prepare(`INSERT INTO agent_provider_turns(id,task_id,segment_id,turn_key,ordinal,assistant_text,tool_calls_json,created_at)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(task_id,turn_key) DO NOTHING`).run(input.id, input.taskId, input.segmentId, input.turnKey, input.ordinal, input.assistantText, JSON.stringify({ version: 1, toolCalls: input.toolCalls, isFinal: input.isFinal === true }), input.now);
        const row = db.prepare("SELECT * FROM agent_provider_turns WHERE task_id=? AND turn_key=?").get(input.taskId, input.turnKey) as any;
        const payload = providerTurnPayload(row.tool_calls_json as string);
        return { id: row.id as string, taskId: row.task_id as string, segmentId: row.segment_id as string, turnKey: row.turn_key as string, ordinal: row.ordinal as number, assistantText: row.assistant_text as string, ...payload };
      })();
    },
    listProviderTurns(taskId: string) {
      return (db.prepare(`SELECT turn.* FROM agent_provider_turns AS turn
        JOIN agent_execution_segments AS segment ON segment.id=turn.segment_id
        WHERE turn.task_id=? ORDER BY segment.sequence,turn.ordinal,turn.id`).all(taskId) as any[]).map((row) => ({ id: row.id as string, segmentId: row.segment_id as string, turnKey: row.turn_key as string, ordinal: row.ordinal as number, assistantText: row.assistant_text as string, ...providerTurnPayload(row.tool_calls_json as string) }));
    },
    saveCheckpoint(input: { id: string; taskId: string; missionId: string | null; segmentId: string; cursor: number; snapshot: ExecutionCheckpointSnapshot; ownerId: string; generation: number; now: string }): void {
      if (input.snapshot.taskId !== input.taskId || input.snapshot.missionId !== input.missionId) throw new Error("Checkpoint identity mismatch");
      db.transaction(() => {
        assertFence(input.segmentId, input);
        db.prepare(`INSERT INTO agent_execution_checkpoints(id,task_id,mission_id,segment_id,version,durable_event_cursor,snapshot_json,created_at)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(task_id,durable_event_cursor) DO UPDATE SET snapshot_json=excluded.snapshot_json, created_at=excluded.created_at`).run(input.id, input.taskId, input.missionId, input.segmentId, input.snapshot.version, input.cursor, JSON.stringify(input.snapshot), input.now);
      })();
    },
    latestCheckpoint(taskId: string): ExecutionCheckpoint | null {
      const row = db.prepare("SELECT * FROM agent_execution_checkpoints WHERE task_id=? ORDER BY durable_event_cursor DESC,id DESC LIMIT 1").get(taskId) as any;
      return row ? { id: row.id, taskId: row.task_id, missionId: row.mission_id, segmentId: row.segment_id, cursor: row.durable_event_cursor, snapshot: JSON.parse(row.snapshot_json), createdAt: row.created_at } : null;
    },
    saveProviderContinuation(input: { id: string; taskId: string; segmentId: string; providerId: string; routeFingerprint: string; turnKey: string; state: ProviderContinuationState; ownerId: string; generation: number; now: string }): void {
      db.transaction(() => {
        assertFence(input.segmentId, input);
        db.prepare(`INSERT INTO agent_provider_continuations(id,task_id,segment_id,provider_id,route_fingerprint,turn_key,state_json,created_at)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(task_id,turn_key) DO UPDATE SET state_json=excluded.state_json,segment_id=excluded.segment_id,provider_id=excluded.provider_id,route_fingerprint=excluded.route_fingerprint,created_at=excluded.created_at`).run(input.id, input.taskId, input.segmentId, input.providerId, input.routeFingerprint, input.turnKey, JSON.stringify(input.state), input.now);
      })();
    },
    loadProviderContinuation(taskId: string, turnKey: string, routeFingerprint: string): ProviderContinuationState | null {
      const row = db.prepare("SELECT state_json FROM agent_provider_continuations WHERE task_id=? AND turn_key=? AND route_fingerprint=?").get(taskId, turnKey, routeFingerprint) as { state_json: string } | undefined;
      return row ? JSON.parse(row.state_json) as ProviderContinuationState : null;
    },
    listProviderContinuationRefs(taskId: string): string[] {
      return (db.prepare("SELECT id FROM agent_provider_continuations WHERE task_id=? ORDER BY created_at,id").all(taskId) as { id: string }[]).map((row) => row.id);
    },
    createCanonicalAnswer(input: { id: string; taskId: string; missionId: string | null; segmentId: string; content: string; evidenceJson: Record<string, unknown>; ownerId: string; generation: number; now: string }) {
      assertFence(input.segmentId, input);
      try {
        db.prepare("INSERT INTO canonical_task_answers(id,task_id,mission_id,content,evidence_json,created_at) VALUES(?,?,?,?,?,?)").run(input.id, input.taskId, input.missionId, input.content, JSON.stringify(input.evidenceJson), input.now);
      } catch (error) {
        if (/UNIQUE constraint failed/.test(error instanceof Error ? error.message : String(error))) {
          const row = db.prepare("SELECT * FROM canonical_task_answers WHERE task_id=?")
            .get(input.taskId) as any;
          if (row) {
            const existing = { id: row.id as string, taskId: row.task_id as string, missionId: row.mission_id as string | null, content: row.content as string, evidenceJson: JSON.parse(row.evidence_json as string) as Record<string, unknown>, createdAt: row.created_at as string };
            if (existing.taskId === input.taskId
              && existing.missionId === input.missionId
              && existing.content === input.content
              && isDeepStrictEqual(existing.evidenceJson, input.evidenceJson)) return existing;
          }
          throw new Error("Canonical answer already exists for this task");
        }
        throw error;
      }
      return { id: input.id, taskId: input.taskId, missionId: input.missionId, content: input.content, evidenceJson: input.evidenceJson, createdAt: input.now };
    },
    getCanonicalAnswer(taskId: string): { id: string; taskId: string; missionId: string | null; content: string; evidenceJson: Record<string, unknown>; createdAt: string } | null {
      const row = db.prepare("SELECT * FROM canonical_task_answers WHERE task_id=?").get(taskId) as any;
      return row ? { id: row.id, taskId: row.task_id, missionId: row.mission_id, content: row.content, evidenceJson: JSON.parse(row.evidence_json), createdAt: row.created_at } : null;
    },
    updateCanonicalAnswerEvidence(taskId: string, evidenceJson: Record<string, unknown>): void {
      const result = db.prepare("UPDATE canonical_task_answers SET evidence_json=? WHERE task_id=?").run(JSON.stringify(evidenceJson), taskId);
      if (result.changes !== 1) throw new Error("Canonical answer not found for task");
    },
  };
}
