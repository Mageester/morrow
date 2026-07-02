import type Database from "better-sqlite3";

export type IntegrationStatus = "pending" | "clean" | "conflicted" | "applied" | "failed" | "cancelled";

export interface IntegrationAttempt {
  id: string;
  projectId: string;
  taskId: string | null;
  agentId: string | null;
  worktreeId: string;
  sourceBranch: string;
  targetBranch: string;
  sourceCommit: string;
  targetCommit: string;
  status: IntegrationStatus;
  conflictedFiles: string[];
  errorDetail: string | null;
  appliedCommit: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
  cancelledAt: string | null;
}

function mapRow(row: any): IntegrationAttempt {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    worktreeId: row.worktree_id,
    sourceBranch: row.source_branch,
    targetBranch: row.target_branch,
    sourceCommit: row.source_commit,
    targetCommit: row.target_commit,
    status: row.status,
    conflictedFiles: JSON.parse(row.conflicted_files_json),
    errorDetail: row.error_detail,
    appliedCommit: row.applied_commit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
    cancelledAt: row.cancelled_at,
  };
}

export function integrationsRepository(db: Database.Database) {
  return {
    create(input: {
      id: string;
      projectId: string;
      taskId?: string | null;
      agentId?: string | null;
      worktreeId: string;
      sourceBranch: string;
      targetBranch: string;
      sourceCommit: string;
      targetCommit: string;
      status: IntegrationStatus;
      conflictedFiles?: string[];
      errorDetail?: string | null;
    }, now = new Date().toISOString()): IntegrationAttempt {
      db.prepare(
        `INSERT INTO integration_attempts (
          id, project_id, task_id, agent_id, worktree_id, source_branch, target_branch,
          source_commit, target_commit, status, conflicted_files_json, error_detail,
          applied_commit, created_at, updated_at, applied_at, cancelled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL)`
      ).run(
        input.id,
        input.projectId,
        input.taskId ?? null,
        input.agentId ?? null,
        input.worktreeId,
        input.sourceBranch,
        input.targetBranch,
        input.sourceCommit,
        input.targetCommit,
        input.status,
        JSON.stringify(input.conflictedFiles ?? []),
        input.errorDetail ?? null,
        now,
        now
      );
      return this.get(input.id)!;
    },

    get(id: string): IntegrationAttempt | undefined {
      const row = db.prepare("SELECT * FROM integration_attempts WHERE id = ?").get(id);
      return row ? mapRow(row) : undefined;
    },

    listByProject(projectId: string, status?: IntegrationStatus): IntegrationAttempt[] {
      const rows = status
        ? db.prepare("SELECT * FROM integration_attempts WHERE project_id = ? AND status = ? ORDER BY created_at DESC").all(projectId, status)
        : db.prepare("SELECT * FROM integration_attempts WHERE project_id = ? ORDER BY created_at DESC").all(projectId);
      return rows.map(mapRow);
    },

    listByTask(taskId: string): IntegrationAttempt[] {
      return db.prepare("SELECT * FROM integration_attempts WHERE task_id = ? ORDER BY created_at DESC").all(taskId).map(mapRow);
    },

    update(id: string, patch: {
      status: IntegrationStatus;
      conflictedFiles?: string[];
      errorDetail?: string | null;
      appliedCommit?: string | null;
      appliedAt?: string | null;
      cancelledAt?: string | null;
    }, now = new Date().toISOString()): IntegrationAttempt {
      const current = this.get(id);
      if (!current) throw new Error("Integration attempt not found");
      db.prepare(
        `UPDATE integration_attempts
         SET status = ?, conflicted_files_json = ?, error_detail = ?, applied_commit = ?,
             updated_at = ?, applied_at = ?, cancelled_at = ?
         WHERE id = ?`
      ).run(
        patch.status,
        JSON.stringify(patch.conflictedFiles ?? current.conflictedFiles),
        patch.errorDetail === undefined ? current.errorDetail : patch.errorDetail,
        patch.appliedCommit === undefined ? current.appliedCommit : patch.appliedCommit,
        now,
        patch.appliedAt === undefined ? current.appliedAt : patch.appliedAt,
        patch.cancelledAt === undefined ? current.cancelledAt : patch.cancelledAt,
        id
      );
      return this.get(id)!;
    },
  };
}
