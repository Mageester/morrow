import type Database from "better-sqlite3";

/**
 * Named workspace checkpoints: a project-scoped snapshot of a set of files.
 * `files` maps a workspace-relative path to the content hash captured at
 * snapshot time ("" means the file did not exist). File *content* lives in the
 * content-addressed backup store (`MORROW_HOME/backups/<hash>.bak`) shared
 * with change-set undo, so identical content is stored once.
 */
export interface Checkpoint {
  id: string;
  projectId: string;
  name: string;
  taskId: string | null;
  files: Record<string, string>;
  createdAt: string;
}

function mapCheckpoint(row: any): Checkpoint {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    taskId: row.task_id,
    files: JSON.parse(row.files_json),
    createdAt: row.created_at,
  };
}

export function checkpointsRepository(db: Database.Database) {
  return {
    create(input: { id: string; projectId: string; name: string; taskId?: string | null; files: Record<string, string> }, now = new Date().toISOString()): Checkpoint {
      db.prepare(
        "INSERT INTO checkpoints (id, project_id, name, task_id, files_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(input.id, input.projectId, input.name, input.taskId ?? null, JSON.stringify(input.files), now);
      return this.getByName(input.projectId, input.name)!;
    },

    getByName(projectId: string, name: string): Checkpoint | undefined {
      const row = db.prepare("SELECT * FROM checkpoints WHERE project_id = ? AND name = ?").get(projectId, name);
      return row ? mapCheckpoint(row) : undefined;
    },

    listByProject(projectId: string): Checkpoint[] {
      return db
        .prepare("SELECT * FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC, name ASC")
        .all(projectId)
        .map(mapCheckpoint);
    },

    remove(projectId: string, name: string): boolean {
      const res = db.prepare("DELETE FROM checkpoints WHERE project_id = ? AND name = ?").run(projectId, name);
      return res.changes > 0;
    },
  };
}
