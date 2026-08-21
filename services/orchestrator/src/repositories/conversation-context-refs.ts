import type Database from "better-sqlite3";
import type { ConversationContextRef } from "@morrow/contracts";

export class ConversationContextRefError extends Error {
  constructor(message: string, public readonly code = "CONTEXT_REF_NOT_FOUND") {
    super(message);
    this.name = "ConversationContextRefError";
  }
}

export interface ConversationContextRefRecord extends ConversationContextRef {
  projectId: string;
  sourceTaskId: string;
  targetTaskId: string;
  createdAt: string;
}

function map(row: Record<string, unknown>): ConversationContextRefRecord {
  return {
    kind: row.kind as ConversationContextRef["kind"],
    id: String(row.ref_id),
    projectId: String(row.project_id),
    sourceTaskId: String(row.source_task_id),
    targetTaskId: String(row.target_task_id),
    createdAt: String(row.created_at),
  };
}

/**
 * Context refs are intentionally a narrow capability handoff. The source
 * task must own the referenced durable artifact/evidence row and the target
 * task remains a separate task/conversation with its own policy.
 */
export function conversationContextRefsRepository(db: Database.Database) {
  const sourceTask = (taskId: string) => db.prepare("SELECT id,project_id FROM tasks WHERE id=?").get(taskId) as { id: string; project_id: string } | undefined;

  const ownsRef = (taskId: string, ref: ConversationContextRef): boolean => {
    if (ref.kind === "artifact") {
      // Deduplication keeps one canonical tool_artifacts row (whose legacy
      // task_id points at the first producer). The per-task edge is the
      // ownership authority for later producers; retain the direct check for
      // artifacts written by an older process during a rolling upgrade.
      return Boolean(
        db.prepare("SELECT 1 FROM tool_artifact_task_refs WHERE artifact_id=? AND task_id=?").get(ref.id, taskId)
        || db.prepare("SELECT 1 FROM tool_artifacts WHERE id=? AND task_id=?").get(ref.id, taskId),
      );
    }
    return Boolean(
      db.prepare("SELECT 1 FROM task_evidence WHERE id=? AND task_id=?").get(ref.id, taskId)
      || db.prepare("SELECT 1 FROM message_tool_calls WHERE id=? AND task_id=?").get(ref.id, taskId),
    );
  };

  return {
    validateSourceRefs(projectId: string, sourceTaskId: string, refs: ConversationContextRef[]): void {
      const task = sourceTask(sourceTaskId);
      if (!task || task.project_id !== projectId) throw new ConversationContextRefError("Context source task is not in this project", "CONTEXT_SOURCE_TASK_NOT_FOUND");
      for (const ref of refs) {
        if (!ownsRef(sourceTaskId, ref)) {
          throw new ConversationContextRefError(`Context reference ${ref.kind}:${ref.id} is not owned by the source task`);
        }
      }
    },

    attach(input: { projectId: string; sourceTaskId: string; targetTaskId: string; refs: ConversationContextRef[]; now: string }): ConversationContextRefRecord[] {
      const target = sourceTask(input.targetTaskId);
      if (!target || target.project_id !== input.projectId) throw new ConversationContextRefError("Context target task is not in this project", "CONTEXT_TARGET_TASK_NOT_FOUND");
      this.validateSourceRefs(input.projectId, input.sourceTaskId, input.refs);
      const insert = db.prepare(`INSERT INTO conversation_context_refs(
        id,project_id,source_task_id,target_task_id,kind,ref_id,created_at
      ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(target_task_id,kind,ref_id) DO NOTHING`);
      db.transaction(() => {
        for (const ref of input.refs) insert.run(crypto.randomUUID(), input.projectId, input.sourceTaskId, input.targetTaskId, ref.kind, ref.id, input.now);
      })();
      return this.listForTask(input.targetTaskId);
    },

    listForTask(targetTaskId: string): ConversationContextRefRecord[] {
      return (db.prepare("SELECT * FROM conversation_context_refs WHERE target_task_id=? ORDER BY created_at ASC,id ASC").all(targetTaskId) as Record<string, unknown>[]).map(map);
    },

    listForSourceTask(sourceTaskId: string): ConversationContextRefRecord[] {
      return (db.prepare("SELECT * FROM conversation_context_refs WHERE source_task_id=? ORDER BY created_at ASC,id ASC").all(sourceTaskId) as Record<string, unknown>[]).map(map);
    },
  };
}
