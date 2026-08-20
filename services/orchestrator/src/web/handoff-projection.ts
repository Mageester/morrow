import type Database from "better-sqlite3";
import { ThreadHandoffsSchema, type ThreadHandoff, type ThreadHandoffs } from "@morrow/contracts";
import { redactSecrets } from "../provider/credentials.js";

/**
 * The handoffs visible in one thread.
 *
 * A handoff is a child task assigned to another teammate, started from a turn
 * in this conversation. Everything below is projected from records the runner
 * already writes — `tasks.parent_task_id`, `tasks.agent_id`, and the child's
 * own conversation — rather than from a second store that could disagree with
 * what actually ran.
 *
 * The child's objective is the first message of its own thread and its result
 * is the last thing it said there, so both are text the user can already open
 * and read in full. Bounded and redacted here because this projection is
 * polled while work is in flight.
 */

const OBJECTIVE_MAX = 2_000;
const RESULT_MAX = 4_000;

/** Task statuses that map onto a handoff a reader would call finished. */
const STATUS_MAP: Record<string, ThreadHandoff["status"]> = {
  queued: "queued",
  running: "running",
  completed: "completed",
  verified: "completed",
  failed: "failed",
  interrupted: "failed",
  cancelled: "cancelled",
};

export interface HandoffProjectionInput {
  db: Database.Database;
  projectId: string;
  conversationId: string;
}

function clamp(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function projectThreadHandoffs(input: HandoffProjectionInput): ThreadHandoffs {
  const { db, projectId, conversationId } = input;

  /**
   * Child tasks of any turn in this thread that were assigned to a named
   * agent. `agent_id IS NOT NULL` is what makes it a handoff rather than an
   * ordinary subtask: work given to somebody.
   */
  const rows = db.prepare(
    `SELECT DISTINCT child.id            AS id,
            child.parent_task_id         AS parent_task_id,
            child.agent_id               AS agent_id,
            child.status                 AS status,
            child.created_at             AS created_at,
            child.completed_at           AS completed_at,
            child.idempotency_key        AS idempotency_key,
            agent.name                   AS agent_name
       FROM conversation_messages parent_message
       JOIN tasks child ON child.parent_task_id = parent_message.task_id
       JOIN agents agent ON agent.id = child.agent_id
      WHERE parent_message.conversation_id = ?
        AND child.project_id = ?
        AND child.agent_id IS NOT NULL
      ORDER BY child.created_at ASC, child.id ASC`,
  ).all(conversationId, projectId) as Array<{
    id: string;
    parent_task_id: string;
    agent_id: string;
    status: string;
    created_at: string;
    completed_at: string | null;
    agent_name: string;
    idempotency_key: string | null;
  }>;

  // The child's own thread: where its objective was posed and its answer
  // written. One indexed lookup per handoff, and a thread has few.
  const childConversation = db.prepare(
    `SELECT conversation_id FROM conversation_messages
      WHERE task_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1`,
  );
  const firstUserMessage = db.prepare(
    `SELECT content FROM conversation_messages
      WHERE conversation_id = ? AND role = 'user'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`,
  );
  const lastAssistantMessage = db.prepare(
    `SELECT content FROM conversation_messages
      WHERE conversation_id = ? AND role = 'assistant' AND TRIM(content) <> ''
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );
  const toolCount = db.prepare(
    "SELECT COUNT(*) AS count FROM message_tool_calls WHERE task_id = ?",
  );

  const handoffs = rows.map((row): ThreadHandoff => {
    const modelInitiated = row.idempotency_key?.startsWith("ask_teammate:") === true;
    const childConversationId = modelInitiated
      ? null
      : (childConversation.get(row.id) as { conversation_id: string } | undefined)?.conversation_id ?? null;
    const objective = childConversationId
      ? (firstUserMessage.get(childConversationId) as { content: string } | undefined)?.content ?? ""
      : "";
    const result = childConversationId
      ? (lastAssistantMessage.get(childConversationId) as { content: string } | undefined)?.content ?? null
      : null;
    return {
      version: 1,
      id: row.id,
      parentTaskId: row.parent_task_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      status: STATUS_MAP[row.status] ?? "running",
      objective: modelInitiated ? "" : clamp(redactSecrets(objective), OBJECTIVE_MAX),
      result: modelInitiated ? null : (result === null ? null : clamp(redactSecrets(result), RESULT_MAX) || null),
      conversationId: modelInitiated ? null : childConversationId,
      evidenceRef: modelInitiated ? `task:${row.id}` : null,
      toolCount: modelInitiated ? 0 : Number((toolCount.get(row.id) as { count: number }).count),
      startedAt: row.created_at,
      completedAt: row.completed_at,
    };
  });

  return ThreadHandoffsSchema.parse({ version: 1, projectId, conversationId, handoffs });
}
