import type Database from "better-sqlite3";
import {
  ApprovalSchema,
  CommandTrustSchema,
  type Approval,
  type ApprovalDecision,
  type ApprovalStatus,
  type CommandTrust,
} from "@morrow/contracts";

type CreateApprovalInput = Omit<Approval, "version" | "status" | "decision" | "decisionNote" | "resolvedAt">;
type ResolveApprovalInput = { decision: ApprovalDecision; note?: string; resolvedAt: string };
type GrantTrustInput = Omit<CommandTrust, "version" | "updatedAt">;

function parseDetails(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("Malformed persisted approval details");
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Malformed persisted approval details");
  }
}

function mapApproval(row: unknown): Approval {
  const value = row as Record<string, unknown>;
  return ApprovalSchema.parse({
    version: value.schema_version,
    id: value.id,
    taskId: value.task_id,
    projectId: value.project_id,
    kind: value.kind,
    status: value.status,
    summary: value.summary,
    details: parseDetails(value.details_json),
    decision: value.decision,
    decisionNote: value.decision_note,
    createdAt: value.created_at,
    resolvedAt: value.resolved_at,
  });
}

function mapTrust(row: unknown): CommandTrust {
  const value = row as Record<string, unknown>;
  return CommandTrustSchema.parse({ version: 1, projectId: value.project_id, pattern: value.pattern, createdAt: value.created_at, updatedAt: value.updated_at });
}

export function approvalsRepository(db: Database.Database) {
  const get = db.prepare("SELECT * FROM approvals WHERE id=?");

  return {
    create(input: CreateApprovalInput): Approval {
      const task = db.prepare("SELECT project_id FROM tasks WHERE id=?").get(input.taskId) as { project_id?: string } | undefined;
      if (!task || task.project_id !== input.projectId) throw new Error("Approval task does not belong to project");
      const value = ApprovalSchema.parse({ ...input, version: 1, status: "pending", decision: null, decisionNote: null, resolvedAt: null });
      db.prepare("INSERT INTO approvals(id,schema_version,task_id,project_id,kind,status,summary,details_json,decision,decision_note,created_at,resolved_at) VALUES(?,1,?,?,?,?,?,?,?,?,?,?)")
        .run(value.id, value.taskId, value.projectId, value.kind, value.status, value.summary, JSON.stringify(value.details), null, null, value.createdAt, null);
      return this.get(value.id)!;
    },
    get(id: string): Approval | undefined {
      const row = get.get(id);
      return row ? mapApproval(row) : undefined;
    },
    listByTask(taskId: string): Approval[] {
      return db.prepare("SELECT * FROM approvals WHERE task_id=? ORDER BY created_at ASC, id ASC").all(taskId).map(mapApproval);
    },
    listByProject(projectId: string, status?: ApprovalStatus): Approval[] {
      const sql = status
        ? "SELECT * FROM approvals WHERE project_id=? AND status=? ORDER BY created_at DESC, id DESC"
        : "SELECT * FROM approvals WHERE project_id=? ORDER BY created_at DESC, id DESC";
      return (status ? db.prepare(sql).all(projectId, status) : db.prepare(sql).all(projectId)).map(mapApproval);
    },
    resolve(id: string, input: ResolveApprovalInput): Approval | undefined {
      const current = this.get(id);
      if (!current || current.status !== "pending") return undefined;
      const status = input.decision === "deny" ? "denied" : "approved";
      db.prepare("UPDATE approvals SET status=?, decision=?, decision_note=?, resolved_at=? WHERE id=? AND status='pending'")
        .run(status, input.decision, input.note ?? null, input.resolvedAt, id);
      return this.get(id);
    },
    grantCommandTrust(input: GrantTrustInput): CommandTrust {
      const project = db.prepare("SELECT id FROM projects WHERE id=?").get(input.projectId);
      if (!project) throw new Error("Project not found");
      const value = CommandTrustSchema.parse({ ...input, version: 1, updatedAt: input.createdAt });
      db.prepare("INSERT INTO project_command_trusts(project_id,pattern,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id,pattern) DO UPDATE SET updated_at=excluded.updated_at")
        .run(value.projectId, value.pattern, value.createdAt, value.updatedAt);
      return this.getCommandTrust(value.projectId, value.pattern)!;
    },
    getCommandTrust(projectId: string, pattern: string): CommandTrust | undefined {
      const row = db.prepare("SELECT * FROM project_command_trusts WHERE project_id=? AND pattern=?").get(projectId, pattern);
      return row ? mapTrust(row) : undefined;
    },
    listCommandTrusts(projectId: string): CommandTrust[] {
      return db.prepare("SELECT * FROM project_command_trusts WHERE project_id=? ORDER BY pattern ASC").all(projectId).map(mapTrust);
    },
    revokeCommandTrust(projectId: string, pattern: string): boolean {
      return db.prepare("DELETE FROM project_command_trusts WHERE project_id=? AND pattern=?").run(projectId, pattern).changes > 0;
    },
  };
}
