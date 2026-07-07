import type Database from "better-sqlite3";

/**
 * Persisted background-process registry rows.
 *
 * `runId` identifies the orchestrator process instance that spawned the child.
 * After a restart the new instance cannot control (or truthfully observe) a
 * child spawned by a previous instance, so startup reconciliation marks any
 * `running` row from another run as `lost` — a row alone never proves a
 * process is alive.
 */
export type ProcessStatus = "running" | "exited" | "failed" | "cancelled" | "lost";

export interface ProcessRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  agentId: string | null;
  command: string;
  args: string[];
  cwd: string;
  mode: "pipe" | "pty";
  pid: number | null;
  status: ProcessStatus;
  exitCode: number | null;
  runId: string;
  detail: string | null;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
}

function mapRow(row: any): ProcessRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    command: row.command,
    args: JSON.parse(row.args_json),
    cwd: row.cwd,
    mode: row.mode,
    pid: row.pid,
    status: row.status,
    exitCode: row.exit_code,
    runId: row.run_id,
    detail: row.detail,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
  };
}

export function processesRepository(db: Database.Database) {
  return {
    create(input: {
      id: string;
      projectId: string;
      taskId?: string | null;
      agentId?: string | null;
      command: string;
      args: string[];
      cwd: string;
      mode: "pipe" | "pty";
      pid: number | null;
      runId: string;
    }, now = new Date().toISOString()): ProcessRecord {
      db.prepare(
        `INSERT INTO processes (id, project_id, task_id, agent_id, command, args_json, cwd, mode, pid, status, exit_code, run_id, detail, started_at, ended_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, NULL, ?, NULL, ?)`
      ).run(
        input.id,
        input.projectId,
        input.taskId ?? null,
        input.agentId ?? null,
        input.command,
        JSON.stringify(input.args),
        input.cwd,
        input.mode,
        input.pid,
        input.runId,
        now,
        now
      );
      return this.get(input.id)!;
    },

    get(id: string): ProcessRecord | undefined {
      const row = db.prepare("SELECT * FROM processes WHERE id = ?").get(id);
      return row ? mapRow(row) : undefined;
    },

    listByProject(projectId: string, status?: ProcessStatus): ProcessRecord[] {
      const rows = status
        ? db.prepare("SELECT * FROM processes WHERE project_id = ? AND status = ? ORDER BY started_at DESC").all(projectId, status)
        : db.prepare("SELECT * FROM processes WHERE project_id = ? ORDER BY started_at DESC").all(projectId);
      return rows.map(mapRow);
    },

    listRunning(): ProcessRecord[] {
      return db.prepare("SELECT * FROM processes WHERE status = 'running'").all().map(mapRow);
    },

    /** Transition a running row to a terminal state. Returns false when it was not running. */
    finish(id: string, status: Exclude<ProcessStatus, "running">, exitCode: number | null, detail: string | null, now = new Date().toISOString()): boolean {
      const res = db
        .prepare("UPDATE processes SET status = ?, exit_code = ?, detail = ?, ended_at = ? WHERE id = ? AND status = 'running'")
        .run(status, exitCode, detail, now, id);
      return res.changes > 0;
    },
  };
}
