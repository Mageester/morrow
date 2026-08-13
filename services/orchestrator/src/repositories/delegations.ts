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
  providerId: string | null;
  model: string | null;
  budget: { maxProviderCalls: number | null; maxTokenBudget: number | null; maxWallClockMs: number | null };
  approvalRequired: boolean;
  deadlineAt: string | null;
  correlationId: string;
  createdAt: string;
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
           acceptance_criteria_json,context_snapshot_ref,allowed_tools_json,allowed_memory_scopes_json,
           provider_id,model,budget_max_provider_calls,budget_max_token_budget,budget_max_wall_clock_ms,
           approval_required,status,deadline_at,correlation_id,child_task_id,created_at,updated_at
         ) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_approval',?,?,NULL,?,?)`
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

    /** Approve: attach the already-spawned child task and move to running.
     * Throws (DB constraint) if that child task already has a running
     * delegation — at most one in-flight delegation per child, enforced
     * durably, not by an in-memory lock. */
    approveAndStart(id: string, childTaskId: string, updatedAt: string): Delegation | undefined {
      db.prepare("UPDATE delegations SET status='running', child_task_id=?, updated_at=? WHERE id=? AND status='pending_approval'")
        .run(childTaskId, updatedAt, id);
      return this.get(id);
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

    /** Parent cancellation propagates here: stops a pending or running
     * delegation and leaves an inspectable final state (never silently
     * deleted). */
    cancel(id: string, updatedAt: string): Delegation | undefined {
      db.prepare("UPDATE delegations SET status='cancelled', updated_at=? WHERE id=? AND status IN ('pending_approval','running')")
        .run(updatedAt, id);
      return this.get(id);
    },
  };
}
