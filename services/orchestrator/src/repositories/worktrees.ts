import type Database from "better-sqlite3";

/**
 * Persisted git-worktree registry.
 *
 * Status semantics:
 * - `active`: the worktree directory exists and is managed by Morrow.
 * - `removed`: cleanly removed (any uncommitted work was preserved on the
 *   branch first; the branch itself is never deleted by removal).
 * - `abandoned`: reconciliation found the directory missing while the row
 *   said active — the branch may still hold the work.
 */
export type WorktreeStatus = "active" | "removed" | "abandoned";

export interface WorktreeRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  agentId: string | null;
  branch: string;
  path: string;
  baseRef: string;
  status: WorktreeStatus;
  detail: string | null;
  createdAt: string;
  removedAt: string | null;
}

function mapRow(row: any): WorktreeRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    branch: row.branch,
    path: row.path,
    baseRef: row.base_ref,
    status: row.status,
    detail: row.detail,
    createdAt: row.created_at,
    removedAt: row.removed_at,
  };
}

export function worktreesRepository(db: Database.Database) {
  return {
    create(input: {
      id: string; projectId: string; taskId?: string | null; agentId?: string | null;
      branch: string; path: string; baseRef: string;
    }, now = new Date().toISOString()): WorktreeRecord {
      db.prepare(
        `INSERT INTO worktrees (id, project_id, task_id, agent_id, branch, path, base_ref, status, detail, created_at, removed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, NULL)`
      ).run(input.id, input.projectId, input.taskId ?? null, input.agentId ?? null, input.branch, input.path, input.baseRef, now);
      return this.get(input.id)!;
    },

    get(id: string): WorktreeRecord | undefined {
      const row = db.prepare("SELECT * FROM worktrees WHERE id = ?").get(id);
      return row ? mapRow(row) : undefined;
    },

    findByBranch(projectId: string, branch: string): WorktreeRecord | undefined {
      const row = db.prepare("SELECT * FROM worktrees WHERE project_id = ? AND branch = ?").get(projectId, branch);
      return row ? mapRow(row) : undefined;
    },

    listByProject(projectId: string, status?: WorktreeStatus): WorktreeRecord[] {
      const rows = status
        ? db.prepare("SELECT * FROM worktrees WHERE project_id = ? AND status = ? ORDER BY created_at DESC").all(projectId, status)
        : db.prepare("SELECT * FROM worktrees WHERE project_id = ? ORDER BY created_at DESC").all(projectId);
      return rows.map(mapRow);
    },

    listActive(): WorktreeRecord[] {
      return db.prepare("SELECT * FROM worktrees WHERE status = 'active'").all().map(mapRow);
    },

    setStatus(id: string, status: Exclude<WorktreeStatus, "active">, detail: string | null, now = new Date().toISOString()): boolean {
      const res = db
        .prepare("UPDATE worktrees SET status = ?, detail = ?, removed_at = ? WHERE id = ? AND status = 'active'")
        .run(status, detail, now, id);
      return res.changes > 0;
    },
  };
}
