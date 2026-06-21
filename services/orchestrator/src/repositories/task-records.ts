import type Database from "better-sqlite3";
import {
  ExecutionDisclosureSchema,
  PlanStepSchema,
  TaskEvidenceSchema,
  TaskEventSchema,
  TaskSchema,
  VerificationResultSchema,
  type ExecutionDisclosure,
  type PlanStep,
  type Task,
  type TaskEvidence,
  type TaskEvent,
  type VerificationResult,
} from "@morrow/contracts";

type EventInput = Omit<TaskEvent, "sequence">;
type TransitionEvent = Omit<EventInput, "taskId" | "type">;
type PlanInput = Omit<PlanStep, "version" | "taskId">;
type DisclosureInput = Omit<ExecutionDisclosure, "version">;
type EvidenceInput = Omit<TaskEvidence, "version">;
type VerificationInput = Omit<VerificationResult, "version">;

const eventTypes = {
  running: "task.running",
  verified: "task.verified",
  completed: "task.completed",
  failed: "task.failed",
  cancelled: "task.cancelled",
  interrupted: "task.interrupted",
} as const;

const allowedTransitions: Record<Task["status"], readonly Task["status"][]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["verified", "completed", "failed", "cancelled", "interrupted"],
  completed: [],
  verified: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

function parseJson(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string") throw new Error(`Malformed persisted ${label}`);
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Malformed persisted ${label}`);
  }
}

export function taskRecordsRepository(db: Database.Database) {
  const mapTask = (row: unknown): Task => {
    const value = row as Record<string, unknown>;
    return TaskSchema.parse({ version: value.schema_version, id: value.id, projectId: value.project_id, kind: value.type, status: value.status, createdAt: value.created_at, updatedAt: value.updated_at });
  };
  const mapEvent = (row: unknown): TaskEvent => {
    const value = row as Record<string, unknown>;
    return TaskEventSchema.parse({ id: value.id, taskId: value.task_id, sequence: value.sequence, type: value.type, payload: parseJson(value.payload_json, "event payload"), createdAt: value.created_at });
  };
  const mapPlan = (row: unknown): PlanStep => {
    const value = row as Record<string, unknown>;
    return PlanStepSchema.parse({ version: value.schema_version, id: value.id, taskId: value.task_id, position: value.position, title: value.title, description: value.description, status: value.status });
  };
  const mapDisclosure = (row: unknown): ExecutionDisclosure => {
    const value = row as Record<string, unknown>;
    return ExecutionDisclosureSchema.parse({ version: value.schema_version, taskId: value.task_id, executionMode: value.execution_mode, provider: value.provider, networkAccess: value.network_access, filesystemAccess: value.filesystem_access, shellExecution: Number(value.shell_execution) !== 0, modelInvocation: Number(value.model_invocation) !== 0, workspaceScope: value.workspace_scope, estimatedCostUsd: value.estimated_cost_usd, createdAt: value.created_at, updatedAt: value.updated_at });
  };
  const mapEvidence = (row: unknown): TaskEvidence => {
    const value = row as Record<string, unknown>;
    return TaskEvidenceSchema.parse({ version: value.schema_version, id: value.id, taskId: value.task_id, type: value.type, path: value.path, metadata: parseJson(value.metadata_json, "evidence metadata"), createdAt: value.created_at });
  };
  const mapVerification = (row: unknown): VerificationResult => {
    const value = row as Record<string, unknown>;
    return VerificationResultSchema.parse({ version: value.schema_version, taskId: value.task_id, status: value.status, summary: value.summary, details: parseJson(value.details_json, "verification details"), createdAt: value.created_at, updatedAt: value.updated_at });
  };

  const appendEvent = (input: EventInput): TaskEvent => db.transaction(() => {
    const sequence = (db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_events WHERE task_id = ?").get(input.taskId) as { sequence: number }).sequence;
    const event = TaskEventSchema.parse({ ...input, sequence });
    db.prepare("INSERT INTO task_events(id,schema_version,task_id,sequence,type,payload_json,created_at) VALUES(?,1,?,?,?,?,?)").run(event.id, event.taskId, event.sequence, event.type, JSON.stringify(event.payload), event.createdAt);
    return event;
  })();

  const transition = (id: string, target: Task["status"], event: TransitionEvent, explicitResume = false): Task => db.transaction(() => {
    const currentRow = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!currentRow) throw new Error(`Task not found: ${id}`);
    const current = mapTask(currentRow);
    const allowed = explicitResume ? current.status === "interrupted" && target === "running" : allowedTransitions[current.status].includes(target);
    if (!allowed) throw new Error(`Invalid task transition: ${current.status} -> ${target}`);
    const type = eventTypes[target as keyof typeof eventTypes];
    if (!type) throw new Error(`No task event for transition to ${target}`);
    const startedAt = target === "running" ? event.createdAt : null;
    const completedAt = target === "verified" || target === "failed" ? event.createdAt : null;
    db.prepare("UPDATE tasks SET status=?,updated_at=?,started_at=COALESCE(?,started_at),completed_at=COALESCE(?,completed_at) WHERE id=?").run(target, event.createdAt, startedAt, completedAt, id);
    appendEvent({ ...event, taskId: id, type });
    return mapTask(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id));
  })();

  return {
    appendEvent,
    listEvents(taskId: string, afterSequence?: number) {
      const sql = afterSequence === undefined ? "SELECT * FROM task_events WHERE task_id=? ORDER BY sequence ASC" : "SELECT * FROM task_events WHERE task_id=? AND sequence>? ORDER BY sequence ASC";
      return db.prepare(sql).all(taskId, ...(afterSequence === undefined ? [] : [afterSequence])).map(mapEvent);
    },
    transitionTask(id: string, target: Task["status"], event: TransitionEvent) { return transition(id, target, event); },
    resumeInterruptedTask(id: string, event: TransitionEvent) { return transition(id, "running", event, true); },
    replacePlan(taskId: string, steps: PlanInput[]) {
      const positions = new Set<number>();
      for (const step of steps) {
        if (positions.has(step.position)) throw new Error(`Duplicate plan position: ${step.position}`);
        positions.add(step.position);
        PlanStepSchema.parse({ ...step, version: 1, taskId });
      }
      db.transaction(() => {
        db.prepare("DELETE FROM plan_steps WHERE task_id=?").run(taskId);
        const insert = db.prepare("INSERT INTO plan_steps(id,schema_version,task_id,position,title,description,status,created_at,updated_at) VALUES(?,1,?,?,?,?,?,?,?)");
        const timestamp = new Date().toISOString();
        for (const step of steps) insert.run(step.id, taskId, step.position, step.title, step.description, step.status, timestamp, timestamp);
      })();
      return this.listPlanSteps(taskId);
    },
    listPlanSteps(taskId: string) { return db.prepare("SELECT * FROM plan_steps WHERE task_id=? ORDER BY position ASC").all(taskId).map(mapPlan); },
    updatePlanStepStatus(id: string, status: PlanStep["status"], updatedAt: string) {
      db.prepare("UPDATE plan_steps SET status=?,updated_at=? WHERE id=?").run(status, updatedAt, id);
      const row = db.prepare("SELECT * FROM plan_steps WHERE id=?").get(id);
      return row ? mapPlan(row) : undefined;
    },
    upsertDisclosure(input: DisclosureInput) {
      const value = ExecutionDisclosureSchema.parse({ ...input, version: 1 });
      db.prepare("INSERT INTO execution_disclosures(task_id,schema_version,execution_mode,provider,network_access,workspace_scope,estimated_cost_usd,created_at,updated_at,filesystem_access,shell_execution,model_invocation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET execution_mode=excluded.execution_mode,provider=excluded.provider,network_access=excluded.network_access,filesystem_access=excluded.filesystem_access,shell_execution=excluded.shell_execution,model_invocation=excluded.model_invocation,workspace_scope=excluded.workspace_scope,estimated_cost_usd=excluded.estimated_cost_usd,updated_at=excluded.updated_at").run(value.taskId, 1, value.executionMode, value.provider, value.networkAccess, value.workspaceScope, value.estimatedCostUsd, value.createdAt, value.updatedAt, value.filesystemAccess, value.shellExecution ? 1 : 0, value.modelInvocation ? 1 : 0);
      return this.getDisclosure(value.taskId)!;
    },
    getDisclosure(taskId: string) { const row = db.prepare("SELECT * FROM execution_disclosures WHERE task_id=?").get(taskId); return row ? mapDisclosure(row) : undefined; },
    appendEvidence(input: EvidenceInput) {
      const value = TaskEvidenceSchema.parse({ ...input, version: 1 });
      db.prepare("INSERT INTO task_evidence(id,schema_version,task_id,type,path,metadata_json,created_at) VALUES(?,1,?,?,?,?,?)").run(value.id, value.taskId, value.type, value.path, JSON.stringify(value.metadata), value.createdAt);
      return value;
    },
    listEvidence(taskId: string) { return db.prepare("SELECT * FROM task_evidence WHERE task_id=? ORDER BY created_at ASC,id ASC").all(taskId).map(mapEvidence); },
    upsertVerification(input: VerificationInput) {
      const value = VerificationResultSchema.parse({ ...input, version: 1 });
      db.prepare("INSERT INTO verification_results(task_id,schema_version,status,summary,details_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET status=excluded.status,summary=excluded.summary,details_json=excluded.details_json,updated_at=excluded.updated_at").run(value.taskId, 1, value.status, value.summary, JSON.stringify(value.details), value.createdAt, value.updatedAt);
      return this.getVerification(value.taskId)!;
    },
    getVerification(taskId: string) { const row = db.prepare("SELECT * FROM verification_results WHERE task_id=?").get(taskId); return row ? mapVerification(row) : undefined; },
    getAggregate(taskId: string) {
      const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
      if (!row) throw new Error(`Task not found: ${taskId}`);
      return { task: mapTask(row), plan: this.listPlanSteps(taskId), events: this.listEvents(taskId), disclosure: this.getDisclosure(taskId), evidence: this.listEvidence(taskId), verification: this.getVerification(taskId) };
    },
  };
}
