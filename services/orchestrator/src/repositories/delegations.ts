import type Database from "better-sqlite3";
import { DelegationSchema, type Delegation, type MemoryScope } from "@morrow/contracts";

function mapDelegation(row: Record<string, unknown>): Delegation {
  return DelegationSchema.parse({
    version: 1,
    id: row.id,
    parentTaskId: row.parent_task_id,
    teamId: row.team_id,
    agentId: row.agent_id,
    objective: row.objective,
    acceptanceCriteria: JSON.parse(String(row.acceptance_criteria_json ?? "[]")),
    contextSnapshotRef: row.context_snapshot_ref,
    allowedTools: JSON.parse(String(row.allowed_tools_json ?? "[]")),
    allowedMemoryScopes: JSON.parse(String(row.allowed_memory_scopes_json ?? "[]")),
    allowedWriteMemoryScopes: JSON.parse(String(row.allowed_write_memory_scopes_json ?? "[]")),
    providerId: row.provider_id ?? null,
    model: row.model ?? null,
    budget: {
      maxProviderCalls: row.budget_max_provider_calls ?? null,
      maxTokenBudget: row.budget_max_token_budget ?? null,
      maxWallClockMs: row.budget_max_wall_clock_ms ?? null,
    },
    approvalRequired: Boolean(row.approval_required),
    status: row.status,
    deadlineAt: row.deadline_at ?? null,
    correlationId: row.correlation_id,
    childTaskId: row.child_task_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export interface CreateDelegationRow {
  id: string;
  parentTaskId: string;
  teamId: string;
  agentId: string;
  objective: string;
  acceptanceCriteria: string[];
  contextSnapshotRef: string;
  allowedTools: string[];
  allowedMemoryScopes: MemoryScope[];
  /** Server-computed write intersection; defaults to [] (no delegated writes). */
  allowedWriteMemoryScopes?: MemoryScope[];
  providerId: string | null;
  model: string | null;
  budget: { maxProviderCalls: number | null; maxTokenBudget: number | null; maxWallClockMs: number | null };
  approvalRequired: boolean;
  deadlineAt: string | null;
  correlationId: string;
  createdAt: string;
}

export type DelegationAdmissionOutcome =
  | "admitted"
  | "already_admitted"
  | "concurrency_limit"
  | "team_inactive"
  | "not_pending"
  | "not_found";

export interface DelegationAdmission {
  outcome: DelegationAdmissionOutcome;
  delegation?: Delegation;
}

/**
 * Durable delegations from a parent task to a team/agent. Every field that
 * could widen authority (status, budget, allowedTools, allowedMemoryScopes,
 * providerId/model, approvalRequired) is written here from server-computed
 * values only — this repository has no "client input" shape, by design; see
 * the dispatch layer that computes the policy intersection before calling
 * `create`. `child_task_id` stays null until approval actually spawns the
 * child, and the DB enforces at most one running delegation per child task
 * via `delegations_one_running_per_child`.
 */
export function delegationsRepository(db: Database.Database) {
  return {
    create(input: CreateDelegationRow): Delegation {
      db.prepare(
        `INSERT INTO delegations(
           id,schema_version,parent_task_id,team_id,agent_id,objective,
           acceptance_criteria_json,context_snapshot_ref,allowed_tools_json,allowed_memory_scopes_json,allowed_write_memory_scopes_json,
           provider_id,model,budget_max_provider_calls,budget_max_token_budget,budget_max_wall_clock_ms,
           approval_required,status,deadline_at,correlation_id,child_task_id,created_at,updated_at
         ) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_approval',?,?,NULL,?,?)`
      ).run(
        input.id,
        input.parentTaskId,
        input.teamId,
        input.agentId,
        input.objective,
        JSON.stringify(input.acceptanceCriteria),
        input.contextSnapshotRef,
        JSON.stringify(input.allowedTools),
        JSON.stringify(input.allowedMemoryScopes),
        JSON.stringify(input.allowedWriteMemoryScopes ?? []),
        input.providerId,
        input.model,
        input.budget.maxProviderCalls,
        input.budget.maxTokenBudget,
        input.budget.maxWallClockMs,
        input.approvalRequired ? 1 : 0,
        input.deadlineAt,
        input.correlationId,
        input.createdAt,
        input.createdAt,
      );
      return this.get(input.id)!;
    },

    get(id: string): Delegation | undefined {
      const row = db.prepare("SELECT * FROM delegations WHERE id=?").get(id) as Record<string, unknown> | undefined;
      return row ? mapDelegation(row) : undefined;
    },

    getByChildTask(childTaskId: string): Delegation | undefined {
      const row = db.prepare("SELECT * FROM delegations WHERE child_task_id=? ORDER BY created_at DESC LIMIT 1")
        .get(childTaskId) as Record<string, unknown> | undefined;
      return row ? mapDelegation(row) : undefined;
    },

    listByParentTask(parentTaskId: string): Delegation[] {
      return db.prepare("SELECT * FROM delegations WHERE parent_task_id=? ORDER BY created_at ASC")
        .all(parentTaskId).map((r) => mapDelegation(r as Record<string, unknown>));
    },

    /**
     * Atomically reserve one team slot for a delegation.
     *
     * `approved` is an intentional intermediate state: it owns a concurrency
     * slot while the deferred child bundle is being created. The conditional
     * update and the active-count predicate live in one SQLite transaction so
     * overlapping callers cannot both observe the same free slot.
     */
    reserveForStart(id: string, concurrencyLimit: number, updatedAt: string): DelegationAdmission {
      if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 1) {
        throw new RangeError("Delegation concurrency limit must be a positive integer");
      }
      // IMMEDIATE takes the write reservation before the active-count read;
      // two concurrent callers therefore serialize instead of both opening a
      // deferred read transaction and one failing with SQLITE_BUSY on upgrade.
      return db.transaction(() => {
        const current = db.prepare("SELECT * FROM delegations WHERE id=?").get(id) as Record<string, unknown> | undefined;
        if (!current) return { outcome: "not_found" as const };
        const status = String(current.status);
        if (status === "approved" || status === "running") {
          return { outcome: "already_admitted" as const, delegation: mapDelegation(current) };
        }
        if (status !== "pending_approval") {
          return { outcome: "not_pending" as const, delegation: mapDelegation(current) };
        }

        const changed = db.prepare(`
          UPDATE delegations
          SET status='approved', updated_at=?
          WHERE id=? AND status='pending_approval'
            AND EXISTS (
              SELECT 1 FROM teams
              WHERE teams.id=delegations.team_id AND teams.status='active'
            )
            AND (
              SELECT COUNT(*) FROM delegations AS active
              WHERE active.team_id=delegations.team_id
                AND active.status IN ('approved','running')
            ) < ?
        `).run(updatedAt, id, concurrencyLimit);
        if (changed.changes === 1) {
          return {
            outcome: "admitted" as const,
            delegation: mapDelegation(db.prepare("SELECT * FROM delegations WHERE id=?").get(id) as Record<string, unknown>),
          };
        }

        const team = db.prepare("SELECT status FROM teams WHERE id=?").get(current.team_id) as { status?: unknown } | undefined;
        if (!team || team.status !== "active") return { outcome: "team_inactive" as const, delegation: mapDelegation(current) };
        const active = db.prepare(
          "SELECT COUNT(*) AS n FROM delegations WHERE team_id=? AND status IN ('approved','running')",
        ).get(current.team_id) as { n: number };
        if (active.n >= concurrencyLimit) return { outcome: "concurrency_limit" as const, delegation: mapDelegation(current) };
        // A concurrent admission may have won and changed the status between
        // the initial read and this classification. Report it as a replay,
        // never as a fresh admission.
        const latest = db.prepare("SELECT * FROM delegations WHERE id=?").get(id) as Record<string, unknown> | undefined;
        if (latest && (latest.status === "approved" || latest.status === "running")) {
          return { outcome: "already_admitted" as const, delegation: mapDelegation(latest) };
        }
        if (!latest) return { outcome: "not_found" as const };
        return { outcome: "not_pending" as const, delegation: mapDelegation(latest) };
      }).immediate();
    },

    /** Release an unstarted reservation after child bundle creation failed. */
    releaseReservation(id: string, updatedAt: string): Delegation | undefined {
      db.prepare("UPDATE delegations SET status='pending_approval', updated_at=? WHERE id=? AND status='approved' AND child_task_id IS NULL")
        .run(updatedAt, id);
      return this.get(id);
    },

    /** Approve: attach the already-spawned child task and move to running.
     * Throws (DB constraint) if that child task already has a running
     * delegation — at most one in-flight delegation per child, enforced
     * durably, not by an in-memory lock. */
    approveAndStart(id: string, childTaskId: string, updatedAt: string, options: { concurrencyLimit?: number } = {}): Delegation | undefined {
      return db.transaction(() => {
        const current = db.prepare("SELECT * FROM delegations WHERE id=?").get(id) as Record<string, unknown> | undefined;
        if (!current) return undefined;
        const status = String(current.status);
        if (status === "running") {
          if (current.child_task_id === childTaskId) return mapDelegation(current);
          throw new Error("Delegation is already running with another child task");
        }
        if (status === "completed" || status === "failed" || status === "cancelled" || status === "rejected") {
          return mapDelegation(current);
        }
        if (status === "approved" && current.child_task_id && current.child_task_id !== childTaskId) {
          throw new Error("Approved delegation is already bound to another child task");
        }
        const child = db.prepare("SELECT id,parent_task_id,project_id,type,agent_id FROM tasks WHERE id=?").get(childTaskId) as { id: string; parent_task_id: string | null; project_id: string; type: string; agent_id: string | null } | undefined;
        const parent = db.prepare("SELECT project_id FROM tasks WHERE id=?").get(current.parent_task_id) as { project_id?: string } | undefined;
        if (!child || !parent || child.parent_task_id !== current.parent_task_id || child.id === current.parent_task_id
          || child.project_id !== parent.project_id || child.type !== "agent_chat" || child.agent_id !== current.agent_id) {
          throw new Error("Child task is not owned by the delegation parent");
        }

        if (status === "pending_approval" && options.concurrencyLimit !== undefined) {
          if (!Number.isSafeInteger(options.concurrencyLimit) || options.concurrencyLimit < 1) {
            throw new RangeError("Delegation concurrency limit must be a positive integer");
          }
          db.prepare(`
            UPDATE delegations
            SET status='running', child_task_id=?, updated_at=?
            WHERE id=? AND status='pending_approval'
              AND EXISTS (
                SELECT 1 FROM teams
                WHERE teams.id=delegations.team_id AND teams.status='active'
              )
              AND (
                SELECT COUNT(*) FROM delegations AS active
                WHERE active.team_id=delegations.team_id
                  AND active.status IN ('approved','running')
              ) < ?
          `).run(childTaskId, updatedAt, id, options.concurrencyLimit);
        } else {
          db.prepare(`
            UPDATE delegations
            SET status='running', child_task_id=?, updated_at=?
            WHERE id=? AND status IN ('pending_approval','approved')
              AND (child_task_id IS NULL OR child_task_id=?)
          `).run(childTaskId, updatedAt, id, childTaskId);
        }
        // A conditional update may lose a race, but the winner's durable
        // state is still safe to inspect and replay.
        return mapDelegation(db.prepare("SELECT * FROM delegations WHERE id=?").get(id) as Record<string, unknown>);
      })();
    },

    reject(id: string, updatedAt: string): Delegation | undefined {
      db.prepare("UPDATE delegations SET status='rejected', updated_at=? WHERE id=? AND status='pending_approval'")
        .run(updatedAt, id);
      return this.get(id);
    },

    complete(id: string, updatedAt: string): Delegation | undefined {
      db.prepare("UPDATE delegations SET status='completed', updated_at=? WHERE id=? AND status='running'")
        .run(updatedAt, id);
      return this.get(id);
    },

    fail(id: string, updatedAt: string): Delegation | undefined {
      db.prepare("UPDATE delegations SET status='failed', updated_at=? WHERE id=? AND status='running'")
        .run(updatedAt, id);
      return this.get(id);
    },

    /** Parent cancellation propagates here: stops a pending, admitted, or running
     * delegation and leaves an inspectable final state (never silently
     * deleted). */
    cancel(id: string, updatedAt: string): Delegation | undefined {
      db.prepare("UPDATE delegations SET status='cancelled', updated_at=? WHERE id=? AND status IN ('pending_approval','approved','running')")
        .run(updatedAt, id);
      return this.get(id);
    },

    /** Reconcile terminal child execution that did not come through a
     * delegation-specific HTTP mutation. Failed/cancelled children release
     * their admission slot; completed children remain running until a
     * verified handoff imports the canonical result. */
    reconcileChildSettlement(childTaskId: string, childStatus: string, updatedAt: string): Delegation | undefined {
      return db.transaction(() => {
        const row = db.prepare("SELECT d.* FROM delegations AS d JOIN tasks AS t ON t.id=d.child_task_id WHERE d.child_task_id=?").get(childTaskId) as Record<string, unknown> | undefined;
        if (!row) return undefined;
        if (row.status === "running" && (childStatus === "failed" || childStatus === "cancelled")) {
          db.prepare("UPDATE delegations SET status=?, updated_at=? WHERE id=? AND status='running'")
            .run(childStatus, updatedAt, row.id);
        }
        const latest = db.prepare("SELECT * FROM delegations WHERE id=?").get(row.id) as Record<string, unknown> | undefined;
        return latest ? mapDelegation(latest) : undefined;
      })();
    },
  };
}
