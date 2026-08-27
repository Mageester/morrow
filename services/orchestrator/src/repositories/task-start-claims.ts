import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { redactSecrets } from "../provider/credentials.js";
import {
  executionLeaseOwnerStatus,
  type ExecutionLeaseOwnerStatus,
} from "./execution-continuity.js";

export type TaskStartClaimReason =
  | "new"
  | "expired"
  | "owner_dead"
  | "held"
  | "same_owner"
  | "task_missing"
  | "identity_mismatch"
  | "not_startable";

/**
 * A start is only ever authorized from a durable pre-start state. Anything
 * else means some owner already started this task (or it is finished), and no
 * lease decision may override that.
 */
export const STARTABLE_TASK_STATUSES = ["queued", "interrupted"] as const;

export interface TaskStartClaim {
  taskId: string;
  claimId: string;
  ownerId: string;
  claimedAt: string;
  leaseExpiresAt: string;
  updatedAt: string;
}

export interface TaskStartClaimAttempt {
  acquired: boolean;
  reason: TaskStartClaimReason;
  claim: TaskStartClaim | null;
}

export interface TaskStartClaimsRepositoryOptions {
  createId?: () => string;
  ownerStatus?: (ownerId: string) => ExecutionLeaseOwnerStatus;
  /** Durable statuses from which a start may be authorized. */
  startableStatuses?: readonly string[];
}

type TaskStartClaimRow = {
  task_id: string;
  claim_id: string;
  owner_id: string;
  claimed_at: string;
  lease_expires_at: string;
  updated_at: string;
};

function safe(value: unknown): string {
  return redactSecrets(typeof value === "string" ? value : String(value ?? "")).trim();
}

function fromRow(row: TaskStartClaimRow): TaskStartClaim {
  return {
    taskId: String(row.task_id),
    claimId: String(row.claim_id),
    ownerId: String(row.owner_id),
    claimedAt: String(row.claimed_at),
    leaseExpiresAt: String(row.lease_expires_at),
    updatedAt: String(row.updated_at),
  };
}

function leaseExpiry(now: string, leaseMs: number): string {
  if (!Number.isInteger(leaseMs) || leaseMs < 1) {
    throw new Error("Task start claim lease must be a positive integer");
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("Task start claim timestamp must be an ISO date");
  const expiryMs = nowMs + leaseMs;
  const expiry = new Date(expiryMs);
  if (!Number.isFinite(expiry.getTime())) throw new Error("Task start claim lease exceeds date range");
  return expiry.toISOString();
}

/**
 * Durable, task-keyed claim used to fence the side effect of calling a
 * runner. The transaction is deliberately kept synchronous: better-sqlite3
 * serializes it across connections, and no runner/provider work occurs while
 * the database lock is held.
 */
export function taskStartClaimsRepository(
  db: Database.Database,
  options: TaskStartClaimsRepositoryOptions = {},
) {
  const createId = options.createId ?? randomUUID;
  const ownerStatus = options.ownerStatus ?? executionLeaseOwnerStatus;
  const startable = new Set(options.startableStatuses ?? STARTABLE_TASK_STATUSES);
  const select = db.prepare("SELECT * FROM task_start_claims WHERE task_id=?");
  const selectTask = db.prepare("SELECT id,parent_task_id,status FROM tasks WHERE id=?");

  const get = (taskId: string): TaskStartClaim | null => {
    const normalizedTaskId = safe(taskId);
    if (!normalizedTaskId) return null;
    const row = select.get(normalizedTaskId) as TaskStartClaimRow | undefined;
    return row ? fromRow(row) : null;
  };

  const claim = (input: {
    taskId: string;
    ownerId: string;
    now: string;
    leaseMs: number;
    /** Authoritative parent binding, verified inside the claim transaction. */
    expectedParentTaskId?: string | null;
  }): TaskStartClaimAttempt => db.transaction((): TaskStartClaimAttempt => {
    const taskId = safe(input.taskId);
    const ownerId = safe(input.ownerId);
    if (!taskId) throw new Error("Task start claim task id is required");
    if (!ownerId) throw new Error("Task start claim owner id is required");
    const leaseExpiresAt = leaseExpiry(input.now, input.leaseMs);

    // Identity and startability are authoritative and are read in the same
    // transaction as the lease decision. A lease can only ever fence the
    // window before the runner flips the task out of a startable status; once
    // it has, no expired-lease takeover may start the task a second time.
    const taskRow = selectTask.get(taskId) as
      { id: string; parent_task_id: string | null; status: string } | undefined;
    if (!taskRow) return { acquired: false, reason: "task_missing", claim: null };
    if (input.expectedParentTaskId !== undefined
      && String(taskRow.parent_task_id ?? "") !== String(input.expectedParentTaskId ?? "")) {
      return { acquired: false, reason: "identity_mismatch", claim: null };
    }
    if (!startable.has(String(taskRow.status))) {
      const holder = select.get(taskId) as TaskStartClaimRow | undefined;
      return { acquired: false, reason: "not_startable", claim: holder ? fromRow(holder) : null };
    }

    const currentRow = select.get(taskId) as TaskStartClaimRow | undefined;

    if (!currentRow) {
      const claimId = safe(createId());
      if (!claimId) throw new Error("Task start claim id is required");
      db.prepare(`INSERT INTO task_start_claims
        (task_id,claim_id,owner_id,claimed_at,lease_expires_at,updated_at)
        VALUES(?,?,?,?,?,?)`)
        .run(taskId, claimId, ownerId, input.now, leaseExpiresAt, input.now);
      return {
        acquired: true,
        reason: "new",
        claim: fromRow(select.get(taskId) as TaskStartClaimRow),
      };
    }

    const current = fromRow(currentRow);
    const expired = Date.parse(current.leaseExpiresAt) <= Date.parse(input.now);
    if (!expired && current.ownerId === ownerId) {
      return { acquired: false, reason: "same_owner", claim: current };
    }

    const dead = !expired && ownerStatus(current.ownerId) === "dead";
    if (!expired && !dead) {
      return { acquired: false, reason: "held", claim: current };
    }

    const claimId = safe(createId());
    if (!claimId) throw new Error("Task start claim id is required");
    const updated = db.prepare(`UPDATE task_start_claims
      SET claim_id=?,owner_id=?,claimed_at=?,lease_expires_at=?,updated_at=?
      WHERE task_id=? AND claim_id=? AND owner_id=? AND lease_expires_at=?`)
      .run(claimId, ownerId, input.now, leaseExpiresAt, input.now,
        taskId, current.claimId, current.ownerId, current.leaseExpiresAt);
    if (updated.changes !== 1) {
      const winner = select.get(taskId) as TaskStartClaimRow | undefined;
      return {
        acquired: false,
        reason: "held",
        claim: winner ? fromRow(winner) : null,
      };
    }
    return {
      acquired: true,
      reason: expired ? "expired" : "owner_dead",
      claim: fromRow(select.get(taskId) as TaskStartClaimRow),
    };
  })();

  const release = (input: {
    taskId: string;
    ownerId: string;
    claimId: string;
    now: string;
  }): boolean => db.prepare(`DELETE FROM task_start_claims
    WHERE task_id=? AND owner_id=? AND claim_id=?`)
    .run(safe(input.taskId), safe(input.ownerId), safe(input.claimId)).changes === 1;

  /**
   * Settle a task's start claim. The row is dropped so a task that legitimately
   * returns to a startable status (a requeued restart) can be claimed again,
   * while a terminal task stays unstartable through the status gate above.
   * Ownership is not required: settlement is observed by whichever process
   * ran the task, which may have taken the claim over from a dead owner.
   */
  const settle = (taskId: string): boolean => {
    const normalized = safe(taskId);
    if (!normalized) return false;
    return db.prepare("DELETE FROM task_start_claims WHERE task_id=?").run(normalized).changes === 1;
  };

  return { claim, get, release, settle };
}
