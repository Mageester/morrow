import type Database from "better-sqlite3";
import type { Task as TaskRecord } from "@morrow/contracts";

type Input = {
  id: string; projectId: string; kind: string; status: string;
  idempotencyKey?: string; parentTaskId?: string; agentId?: string; worktreeId?: string; missionId?: string;
  createdAt: string; updatedAt?: string; startedAt?: string; completedAt?: string;
};
type Update = { status: string; updatedAt: string; startedAt?: string | null; completedAt?: string | null };

function map(row: Record<string, unknown>): TaskRecord {
  return {
    version: Number(row.schema_version),
    id: String(row.id),
    projectId: String(row.project_id),
    kind: String(row.type || row.kind),
    status: String(row.status),
    parentTaskId: row.parent_task_id ? String(row.parent_task_id) : null,
    agentId: row.agent_id ? String(row.agent_id) : null,
    worktreeId: row.worktree_id ? String(row.worktree_id) : null,
    missionId: row.mission_id ? String(row.mission_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  } as TaskRecord;
}

export function taskRepository(db: Database.Database) {
  const get = db.prepare("SELECT * FROM tasks WHERE id=?");
  return {
    createTask(i: Input) {
      db.prepare(
        "INSERT INTO tasks(id,schema_version,project_id,type,status,idempotency_key,parent_task_id,agent_id,worktree_id,mission_id,created_at,updated_at,started_at,completed_at) VALUES(@id,1,@projectId,@kind,@status,@idempotencyKey,@parentTaskId,@agentId,@worktreeId,@missionId,@createdAt,@updatedAt,@startedAt,@completedAt)"
      ).run({
        ...i,
        idempotencyKey: i.idempotencyKey ?? null,
        parentTaskId: i.parentTaskId ?? null,
        agentId: i.agentId ?? null,
        worktreeId: i.worktreeId ?? null,
        missionId: i.missionId ?? null,
        updatedAt: i.updatedAt ?? i.createdAt,
        startedAt: i.startedAt ?? null,
        completedAt: i.completedAt ?? null,
      });
      return this.getTaskById(i.id)!;
    },
    findByIdempotencyKey(projectId: string, key: string) {
      const r = db.prepare("SELECT * FROM tasks WHERE project_id=? AND idempotency_key=?").get(projectId, key);
      return r ? map(r as Record<string, unknown>) : undefined;
    },
    getTaskById(id: string) {
      const r = get.get(id);
      return r ? map(r as Record<string, unknown>) : undefined;
    },
    listTasksByProject(projectId: string) {
      return db.prepare("SELECT * FROM tasks WHERE project_id=? ORDER BY created_at ASC,id ASC").all(projectId).map(r => map(r as Record<string, unknown>));
    },
    listChildren(parentTaskId: string) {
      return db.prepare("SELECT * FROM tasks WHERE parent_task_id=? ORDER BY created_at ASC,id ASC").all(parentTaskId).map(r => map(r as Record<string, unknown>));
    },
    updateTaskStatus(id: string, u: Update) {
      const old = this.getTaskById(id);
      if (!old) return;
      db.prepare("UPDATE tasks SET status=?,updated_at=?,started_at=COALESCE(?,started_at),completed_at=COALESCE(?,completed_at) WHERE id=?").run(u.status, u.updatedAt, u.startedAt ?? null, u.completedAt ?? null, id);
      return this.getTaskById(id);
    },
  };
}
