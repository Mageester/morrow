import type Database from "better-sqlite3";

export interface ChangeSet {
  id: string;
  taskId: string;
  projectId: string;
  approvalId: string | null;
  state: "proposed" | "applying" | "applied" | "failed" | "undone";
  diff: string;
  diffHash: string;
  originalHashes: Record<string, string>;
  postApplyHashes: Record<string, string> | null;
  backupReferences: Record<string, string> | null;
  undoResult: Record<string, any> | null;
  createdAt: string;
  updatedAt: string;
}

type CreateChangeSetInput = Omit<ChangeSet, "state" | "postApplyHashes" | "backupReferences" | "undoResult" | "createdAt" | "updatedAt">;

function mapChangeSet(row: any): ChangeSet {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    approvalId: row.approval_id,
    state: row.state,
    diff: row.diff,
    diffHash: row.diff_hash,
    originalHashes: JSON.parse(row.original_hashes_json),
    postApplyHashes: row.post_apply_hashes_json ? JSON.parse(row.post_apply_hashes_json) : null,
    backupReferences: row.backup_references_json ? JSON.parse(row.backup_references_json) : null,
    undoResult: row.undo_result_json ? JSON.parse(row.undo_result_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function changeSetsRepository(db: Database.Database) {
  return {
    create(input: CreateChangeSetInput, now = new Date().toISOString()): ChangeSet {
      db.prepare(
        `INSERT INTO change_sets (
          id, schema_version, task_id, project_id, approval_id, state, diff, diff_hash,
          original_hashes_json, post_apply_hashes_json, backup_references_json, undo_result_json,
          created_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, 'proposed', ?, ?, ?, NULL, NULL, NULL, ?, ?)`
      ).run(
        input.id,
        input.taskId,
        input.projectId,
        input.approvalId,
        input.diff,
        input.diffHash,
        JSON.stringify(input.originalHashes),
        now,
        now
      );
      return this.get(input.id)!;
    },

    get(id: string): ChangeSet | undefined {
      const row = db.prepare("SELECT * FROM change_sets WHERE id = ?").get(id);
      return row ? mapChangeSet(row) : undefined;
    },

    listByTask(taskId: string): ChangeSet[] {
      return db
        .prepare("SELECT * FROM change_sets WHERE task_id = ? ORDER BY created_at ASC")
        .all(taskId)
        .map(mapChangeSet);
    },

    listByProject(projectId: string): ChangeSet[] {
      return db
        .prepare("SELECT * FROM change_sets WHERE project_id = ? ORDER BY created_at ASC")
        .all(projectId)
        .map(mapChangeSet);
    },

    getLatestApproved(projectId: string): ChangeSet | undefined {
      const row = db
        .prepare(
          `SELECT c.* FROM change_sets c
           JOIN approvals a ON c.approval_id = a.id
           WHERE c.project_id = ? AND c.state = 'applied' AND a.status = 'approved'
           ORDER BY c.updated_at DESC, c.id DESC LIMIT 1`
        )
        .get(projectId);
      return row ? mapChangeSet(row) : undefined;
    },

    updateState(id: string, state: ChangeSet["state"], now = new Date().toISOString()): void {
      db.prepare("UPDATE change_sets SET state = ?, updated_at = ? WHERE id = ?").run(state, now, id);
    },

    updateApplied(
      id: string,
      postApplyHashes: Record<string, string>,
      backupReferences: Record<string, string>,
      now = new Date().toISOString()
    ): ChangeSet {
      db.prepare(
        `UPDATE change_sets
         SET state = 'applied', post_apply_hashes_json = ?, backup_references_json = ?, updated_at = ?
         WHERE id = ?`
      ).run(JSON.stringify(postApplyHashes), JSON.stringify(backupReferences), now, id);
      return this.get(id)!;
    },

    updateUndone(id: string, undoResult: Record<string, any>, now = new Date().toISOString()): ChangeSet {
      db.prepare(
        `UPDATE change_sets
         SET state = 'undone', undo_result_json = ?, updated_at = ?
         WHERE id = ?`
      ).run(JSON.stringify(undoResult), now, id);
      return this.get(id)!;
    },
  };
}
