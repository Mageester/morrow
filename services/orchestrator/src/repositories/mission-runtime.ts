import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import {
  MISSION_RUNTIME_TERMINAL_STATES,
  MissionOperationSchema,
  MissionProgressObservationSchema,
  MissionRecoveryDecisionSchema,
  MissionRuntimeSchema,
  MissionRuntimeTransitionSchema,
  type MissionOperation,
  type MissionOperationKind,
  type MissionProgressKind,
  type MissionRecoveryAction,
  type MissionRecoveryCategory,
  type MissionRuntime,
  type MissionRuntimeState,
  type MissionRuntimeTransition,
  type MissionRuntimeTransitionActor,
} from "@morrow/contracts";
import { assertMissionRuntimeTransition } from "../mission/runtime-state.js";

export interface MissionRuntimeLeaseFence {
  ownerId: string;
  generation: number;
}

export class MissionRuntimeLeaseFenceError extends Error {
  readonly code = "MISSION_RUNTIME_LEASE_LOST";

  constructor(message = "Mission runtime controller lease fence was lost") {
    super(message);
    this.name = "MissionRuntimeLeaseFenceError";
  }
}

function runtimeFromRow(row: any): MissionRuntime {
  return MissionRuntimeSchema.parse({
    version: row.schema_version,
    missionId: row.mission_id,
    state: row.state,
    finalDisposition: row.final_disposition ?? null,
    activeOperationId: row.active_operation_id ?? null,
    activeTaskId: row.active_task_id ?? null,
    wakeReason: row.wake_reason ?? null,
    transitionSequence: row.transition_sequence,
    operationSequence: row.operation_sequence,
    leaseOwner: row.lease_owner ?? null,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function transitionFromRow(row: any): MissionRuntimeTransition {
  return MissionRuntimeTransitionSchema.parse({
    version: 1,
    id: row.id,
    missionId: row.mission_id,
    sequence: row.sequence,
    from: row.from_state,
    to: row.to_state,
    cause: row.cause,
    actor: row.actor,
    details: JSON.parse(row.details_json),
    createdAt: row.created_at,
  });
}

function operationFromRow(row: any): MissionOperation {
  return MissionOperationSchema.parse({
    version: 1,
    id: row.id,
    missionId: row.mission_id,
    sequence: row.sequence,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    status: row.status,
    strategyFingerprint: row.strategy_fingerprint ?? null,
    input: JSON.parse(row.input_json),
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    effectEvidenceIds: JSON.parse(row.effect_evidence_ids_json),
    attempt: row.attempt,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function missionRuntimeRepository(db: Database.Database) {
  const selectRuntime = db.prepare("SELECT * FROM mission_runtime WHERE mission_id=?");
  const selectOperation = db.prepare("SELECT * FROM mission_operations WHERE id=? AND mission_id=?");

  const requireRuntimeRow = (missionId: string): any => {
    const row = selectRuntime.get(missionId);
    if (!row) throw new Error(`Mission runtime not found: ${missionId}`);
    return row;
  };

  const requireOperationRow = (missionId: string, operationId: string): any => {
    const row = selectOperation.get(operationId, missionId);
    if (!row) throw new Error(`Mission operation not found: ${operationId}`);
    return row;
  };

  const assertFence = (
    missionId: string,
    fence: MissionRuntimeLeaseFence,
    now: string,
  ): void => {
    const row = db.prepare(`SELECT mission_id FROM mission_runtime
      WHERE mission_id=? AND lease_owner=? AND lease_generation=?
        AND lease_expires_at IS NOT NULL AND lease_expires_at>=?`)
      .get(missionId, fence.ownerId, fence.generation, now);
    if (!row) throw new MissionRuntimeLeaseFenceError();
  };

  const repo = {
    create(input: { missionId: string; now: string; state?: MissionRuntimeState }): MissionRuntime {
      db.prepare(`INSERT INTO mission_runtime
        (mission_id,schema_version,state,final_disposition,active_operation_id,active_task_id,wake_reason,
         transition_sequence,operation_sequence,lease_owner,lease_generation,lease_expires_at,created_at,updated_at)
        VALUES(?,1,?,NULL,NULL,NULL,NULL,0,0,NULL,0,NULL,?,?)`)
        .run(input.missionId, input.state ?? "created", input.now, input.now);
      return runtimeFromRow(requireRuntimeRow(input.missionId));
    },

    get(missionId: string): MissionRuntime | null {
      const row = selectRuntime.get(missionId);
      return row ? runtimeFromRow(row) : null;
    },

    transition(input: {
      missionId: string;
      from: MissionRuntimeState;
      to: MissionRuntimeState;
      cause: string;
      actor: MissionRuntimeTransitionActor;
      details?: Record<string, unknown>;
      now: string;
    }): MissionRuntimeTransition {
      return db.transaction(() => {
        assertMissionRuntimeTransition(input.from, input.to, input.cause);
        const current = runtimeFromRow(requireRuntimeRow(input.missionId));
        if (current.state !== input.from) {
          throw new Error(`Mission runtime state changed: expected ${input.from}, found ${current.state}`);
        }
        const sequence = current.transitionSequence + 1;
        const finalDisposition = (MISSION_RUNTIME_TERMINAL_STATES as readonly MissionRuntimeState[])
          .includes(input.to) ? input.to : null;
        const updated = db.prepare(`UPDATE mission_runtime
          SET state=?, final_disposition=?, transition_sequence=?, updated_at=?
          WHERE mission_id=? AND state=? AND transition_sequence=?`)
          .run(input.to, finalDisposition, sequence, input.now, input.missionId, input.from, current.transitionSequence);
        if (updated.changes !== 1) throw new Error("Mission runtime state changed during transition");
        const id = randomUUID();
        db.prepare(`INSERT INTO mission_runtime_transitions
          (id,mission_id,sequence,from_state,to_state,cause,actor,details_json,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(id, input.missionId, sequence, input.from, input.to, input.cause, input.actor, JSON.stringify(input.details ?? {}), input.now);
        return transitionFromRow(db.prepare("SELECT * FROM mission_runtime_transitions WHERE id=?").get(id));
      })();
    },

    listTransitions(missionId: string): MissionRuntimeTransition[] {
      return (db.prepare("SELECT * FROM mission_runtime_transitions WHERE mission_id=? ORDER BY sequence")
        .all(missionId) as any[]).map(transitionFromRow);
    },

    claimLease(input: { missionId: string; ownerId: string; now: string; expiresAt: string }): MissionRuntimeLeaseFence | null {
      const result = db.prepare(`UPDATE mission_runtime
        SET lease_owner=?, lease_generation=lease_generation+1, lease_expires_at=?, updated_at=?
        WHERE mission_id=?
          AND state NOT IN ('blocked','completed','cancelled','abandoned','superseded')
          AND (lease_owner IS NULL OR lease_expires_at<?)`)
        .run(input.ownerId, input.expiresAt, input.now, input.missionId, input.now);
      if (result.changes !== 1) return null;
      const runtime = runtimeFromRow(requireRuntimeRow(input.missionId));
      return { ownerId: input.ownerId, generation: runtime.leaseGeneration };
    },

    renewLease(input: { missionId: string; fence: MissionRuntimeLeaseFence; expiresAt: string; now: string }): boolean {
      return db.prepare(`UPDATE mission_runtime SET lease_expires_at=?,updated_at=?
        WHERE mission_id=? AND lease_owner=? AND lease_generation=?
          AND state NOT IN ('blocked','completed','cancelled','abandoned','superseded')`)
        .run(input.expiresAt, input.now, input.missionId, input.fence.ownerId, input.fence.generation).changes === 1;
    },

    releaseLease(input: { missionId: string; fence: MissionRuntimeLeaseFence; now: string }): boolean {
      return db.prepare(`UPDATE mission_runtime SET lease_owner=NULL,lease_expires_at=NULL,updated_at=?
        WHERE mission_id=? AND lease_owner=? AND lease_generation=?`)
        .run(input.now, input.missionId, input.fence.ownerId, input.fence.generation).changes === 1;
    },

    enqueueOperation(input: {
      id?: string;
      missionId: string;
      idempotencyKey: string;
      kind: MissionOperationKind;
      strategyFingerprint: string | null;
      input: Record<string, unknown>;
      now: string;
    }): MissionOperation {
      return db.transaction(() => {
        const existingRow = db.prepare("SELECT * FROM mission_operations WHERE mission_id=? AND idempotency_key=?")
          .get(input.missionId, input.idempotencyKey) as any;
        if (existingRow) {
          const existing = operationFromRow(existingRow);
          if (
            existing.kind !== input.kind
            || existing.strategyFingerprint !== input.strategyFingerprint
            || !isDeepStrictEqual(existing.input, input.input)
          ) {
            throw new Error(`Mission operation idempotency key ${input.idempotencyKey} was reused with different input`);
          }
          return existing;
        }
        const runtime = runtimeFromRow(requireRuntimeRow(input.missionId));
        const sequence = runtime.operationSequence + 1;
        const id = input.id ?? randomUUID();
        db.prepare(`INSERT INTO mission_operations
          (id,mission_id,sequence,idempotency_key,kind,status,strategy_fingerprint,input_json,result_json,
           effect_evidence_ids_json,attempt,started_at,completed_at,created_at,updated_at)
          VALUES(?,?,?,?,?,'pending',?,?,NULL,'[]',0,NULL,NULL,?,?)`)
          .run(id, input.missionId, sequence, input.idempotencyKey, input.kind, input.strategyFingerprint, JSON.stringify(input.input), input.now, input.now);
        const updated = db.prepare(`UPDATE mission_runtime
          SET operation_sequence=?,active_operation_id=?,updated_at=?
          WHERE mission_id=? AND operation_sequence=?`)
          .run(sequence, id, input.now, input.missionId, runtime.operationSequence);
        if (updated.changes !== 1) throw new Error("Mission operation sequence changed during enqueue");
        return operationFromRow(requireOperationRow(input.missionId, id));
      })();
    },

    startOperation(input: { missionId: string; operationId: string; fence: MissionRuntimeLeaseFence; now: string }): MissionOperation {
      return db.transaction(() => {
        assertFence(input.missionId, input.fence, input.now);
        const current = operationFromRow(requireOperationRow(input.missionId, input.operationId));
        if (current.status === "running") return current;
        if (current.status !== "pending" && current.status !== "failed") {
          throw new Error(`Mission operation cannot start from ${current.status}`);
        }
        db.prepare(`UPDATE mission_operations
          SET status='running',attempt=attempt+1,result_json=NULL,effect_evidence_ids_json='[]',
              started_at=?,completed_at=NULL,updated_at=?
          WHERE id=? AND mission_id=?`)
          .run(input.now, input.now, input.operationId, input.missionId);
        return operationFromRow(requireOperationRow(input.missionId, input.operationId));
      })();
    },

    completeOperation(input: {
      missionId: string;
      operationId: string;
      fence: MissionRuntimeLeaseFence;
      result: Record<string, unknown>;
      effectEvidenceIds: string[];
      now: string;
    }): MissionOperation {
      return db.transaction(() => {
        assertFence(input.missionId, input.fence, input.now);
        const current = operationFromRow(requireOperationRow(input.missionId, input.operationId));
        if (current.status === "completed") {
          if (isDeepStrictEqual(current.result, input.result)
            && isDeepStrictEqual(current.effectEvidenceIds, input.effectEvidenceIds)) return current;
          throw new Error("Mission operation already completed with a different result");
        }
        if (current.status !== "running") throw new Error(`Mission operation cannot complete from ${current.status}`);
        db.prepare(`UPDATE mission_operations
          SET status='completed',result_json=?,effect_evidence_ids_json=?,completed_at=?,updated_at=?
          WHERE id=? AND mission_id=?`)
          .run(JSON.stringify(input.result), JSON.stringify(input.effectEvidenceIds), input.now, input.now, input.operationId, input.missionId);
        db.prepare(`UPDATE mission_runtime SET active_operation_id=NULL,updated_at=?
          WHERE mission_id=? AND active_operation_id=?`)
          .run(input.now, input.missionId, input.operationId);
        return operationFromRow(requireOperationRow(input.missionId, input.operationId));
      })();
    },

    failOperation(input: {
      missionId: string;
      operationId: string;
      fence: MissionRuntimeLeaseFence;
      result: Record<string, unknown>;
      effectEvidenceIds?: string[];
      unknownEffect?: boolean;
      now: string;
    }): MissionOperation {
      return db.transaction(() => {
        assertFence(input.missionId, input.fence, input.now);
        const current = operationFromRow(requireOperationRow(input.missionId, input.operationId));
        const status = input.unknownEffect ? "unknown_effect" : "failed";
        if (current.status === status) {
          if (isDeepStrictEqual(current.result, input.result)
            && isDeepStrictEqual(current.effectEvidenceIds, input.effectEvidenceIds ?? [])) return current;
          throw new Error(`Mission operation already ${status} with a different result`);
        }
        if (current.status !== "running") throw new Error(`Mission operation cannot fail from ${current.status}`);
        db.prepare(`UPDATE mission_operations
          SET status=?,result_json=?,effect_evidence_ids_json=?,completed_at=?,updated_at=?
          WHERE id=? AND mission_id=?`)
          .run(status, JSON.stringify(input.result), JSON.stringify(input.effectEvidenceIds ?? []), input.now, input.now, input.operationId, input.missionId);
        db.prepare(`UPDATE mission_runtime SET active_operation_id=NULL,updated_at=?
          WHERE mission_id=? AND active_operation_id=?`)
          .run(input.now, input.missionId, input.operationId);
        return operationFromRow(requireOperationRow(input.missionId, input.operationId));
      })();
    },

    listOperations(missionId: string): MissionOperation[] {
      return (db.prepare("SELECT * FROM mission_operations WHERE mission_id=? ORDER BY sequence")
        .all(missionId) as any[]).map(operationFromRow);
    },

    appendProgress(input: {
      id?: string;
      missionId: string;
      operationId: string | null;
      kind: MissionProgressKind;
      summary: string;
      evidenceIds: string[];
      strategyFingerprint: string | null;
      now: string;
    }) {
      const observation = MissionProgressObservationSchema.parse({
        version: 1,
        id: input.id ?? randomUUID(),
        missionId: input.missionId,
        operationId: input.operationId,
        kind: input.kind,
        summary: input.summary,
        evidenceIds: input.evidenceIds,
        strategyFingerprint: input.strategyFingerprint,
        createdAt: input.now,
      });
      db.prepare(`INSERT INTO mission_progress
        (id,mission_id,operation_id,kind,summary,evidence_ids_json,strategy_fingerprint,created_at)
        VALUES(?,?,?,?,?,?,?,?)`)
        .run(observation.id, observation.missionId, observation.operationId, observation.kind,
          observation.summary, JSON.stringify(observation.evidenceIds), observation.strategyFingerprint, observation.createdAt);
      return observation;
    },

    listProgress(missionId: string) {
      return (db.prepare("SELECT * FROM mission_progress WHERE mission_id=? ORDER BY created_at,id").all(missionId) as any[])
        .map((row) => MissionProgressObservationSchema.parse({
          version: 1,
          id: row.id,
          missionId: row.mission_id,
          operationId: row.operation_id ?? null,
          kind: row.kind,
          summary: row.summary,
          evidenceIds: JSON.parse(row.evidence_ids_json),
          strategyFingerprint: row.strategy_fingerprint ?? null,
          createdAt: row.created_at,
        }));
    },

    recordRecovery(input: {
      id?: string;
      missionId: string;
      operationId: string | null;
      category: MissionRecoveryCategory;
      diagnosis: string;
      failedStrategyFingerprint: string | null;
      nextStrategyFingerprint: string | null;
      action: MissionRecoveryAction;
      retryCondition: string | null;
      exhausted: boolean;
      now: string;
    }) {
      const decision = MissionRecoveryDecisionSchema.parse({
        version: 1,
        id: input.id ?? randomUUID(),
        missionId: input.missionId,
        operationId: input.operationId,
        category: input.category,
        diagnosis: input.diagnosis,
        failedStrategyFingerprint: input.failedStrategyFingerprint,
        nextStrategyFingerprint: input.nextStrategyFingerprint,
        action: input.action,
        retryCondition: input.retryCondition,
        exhausted: input.exhausted,
        createdAt: input.now,
      });
      db.prepare(`INSERT INTO mission_recovery_decisions
        (id,mission_id,operation_id,category,diagnosis,failed_strategy_fingerprint,next_strategy_fingerprint,
         action,retry_condition,exhausted,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(decision.id, decision.missionId, decision.operationId, decision.category, decision.diagnosis,
          decision.failedStrategyFingerprint, decision.nextStrategyFingerprint, decision.action,
          decision.retryCondition, decision.exhausted ? 1 : 0, decision.createdAt);
      return decision;
    },

    listRecoveryDecisions(missionId: string) {
      return (db.prepare("SELECT * FROM mission_recovery_decisions WHERE mission_id=? ORDER BY created_at,id")
        .all(missionId) as any[]).map((row) => MissionRecoveryDecisionSchema.parse({
        version: 1,
        id: row.id,
        missionId: row.mission_id,
        operationId: row.operation_id ?? null,
        category: row.category,
        diagnosis: row.diagnosis,
        failedStrategyFingerprint: row.failed_strategy_fingerprint ?? null,
        nextStrategyFingerprint: row.next_strategy_fingerprint ?? null,
        action: row.action,
        retryCondition: row.retry_condition ?? null,
        exhausted: row.exhausted === 1,
        createdAt: row.created_at,
      }));
    },
  };

  return repo;
}
