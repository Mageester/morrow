import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Routine } from "@morrow/contracts";
import { agentsRepository } from "../repositories/agents.js";
import { conversationsRepository } from "../repositories/conversations.js";
import {
  AgentTaskDispatchError,
  dispatchAgentTask,
  type AgentTaskDispatcherDependencies,
} from "../mission/task-dispatcher.js";
import { taskRepository } from "../repositories/tasks.js";
import { renderRoutineAsMessage } from "../web/routine-proposal.js";

export interface RoutineDispatchDependencies extends AgentTaskDispatcherDependencies {
  now?: () => Date;
  createId?: () => string;
}

export interface RoutineTargetOptions {
  /** Scheduled runs must have a durable standalone teammate binding. */
  requireAgent?: boolean;
}

/**
 * Resolve a routine's current teammate target. A schedule stores the binding
 * it was created with, but this check deliberately reads the current rows so
 * disabled, deleted, cross-project, or team targets fail closed at fire time.
 */
export function assertRoutineTarget(
  db: Database.Database,
  routine: Pick<Routine, "projectId" | "agentId">,
  options: RoutineTargetOptions = {},
) {
  if (!routine.agentId) {
    if (options.requireAgent) {
      throw new AgentTaskDispatchError(409, "Scheduled routines require an enabled standalone teammate", "AGENT_REQUIRED");
    }
    return null;
  }
  const agent = agentsRepository(db).get(routine.agentId);
  if (!agent || agent.projectId !== routine.projectId) {
    throw new AgentTaskDispatchError(409, "The teammate this routine belongs to no longer exists", "AGENT_MISSING");
  }
  if (!agent.enabled) throw new AgentTaskDispatchError(409, "Agent is disabled", "AGENT_DISABLED");
  if (agent.teamId) {
    throw new AgentTaskDispatchError(409, "Scheduled routines require a standalone teammate", "TEAM_AGENT_REQUIRES_STANDALONE");
  }
  return agent;
}

/**
 * Shared manual and scheduled routine dispatch. Both paths create a fresh
 * teammate-bound conversation and use the ordinary agent dispatcher, so
 * provider routing, current policy, approvals, containment, and recovery do
 * not fork for automation. `autoApprove` is intentionally hard-coded false.
 */
export function dispatchRoutineTask(
  dependencies: RoutineDispatchDependencies,
  routine: Routine,
  options: { idempotencyKey?: string; requireAgent?: boolean } = {},
) {
  const targetOptions: RoutineTargetOptions = options.requireAgent === undefined
    ? {}
    : { requireAgent: options.requireAgent };
  const agent = assertRoutineTarget(dependencies.db, routine, targetOptions);
  const tasks = taskRepository(dependencies.db);
  const conversations = conversationsRepository(dependencies.db);
  const createId = dependencies.createId ?? randomUUID;
  let conversationId: string | undefined;
  let createdConversationId: string | undefined;

  // A durable schedule occurrence may be retried after a process crash. Find
  // the original conversation before creating a shell, allowing the existing
  // task idempotency bundle to replay safely after restart.
  if (options.idempotencyKey) {
    const existing = tasks.findByIdempotencyKey(routine.projectId, options.idempotencyKey);
    if (existing) {
      const row = dependencies.db.prepare(
        "SELECT conversation_id FROM conversation_messages WHERE task_id=? ORDER BY rowid ASC LIMIT 1",
      ).get(existing.id) as { conversation_id?: string } | undefined;
      if (!row?.conversation_id) {
        throw new AgentTaskDispatchError(409, "Scheduled routine dispatch is incomplete", "IDEMPOTENCY_INCOMPLETE");
      }
      conversationId = row.conversation_id;
    }
  }

  if (!conversationId) {
    const now = (dependencies.now ?? (() => new Date()))().toISOString();
    createdConversationId = createId();
    conversations.createConversation({
      id: createdConversationId,
      projectId: routine.projectId,
      title: routine.name,
      agentId: agent?.id ?? null,
      createdAt: now,
      updatedAt: now,
    });
    conversationId = createdConversationId;
  }

  try {
    return {
      ...dispatchAgentTask(dependencies, {
        conversationId,
        content: renderRoutineAsMessage(routine),
        mode: "agent",
        autoApprove: false,
        ...(agent ? {
          agentId: agent.id,
          ...(agent.providerOverride ? { providerId: agent.providerOverride as any } : {}),
          ...(agent.modelOverride ? { model: agent.modelOverride } : {}),
        } : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      }),
      conversationId,
    };
  } catch (error) {
    if (createdConversationId) conversations.deleteConversation(createdConversationId, routine.projectId);
    throw error;
  }
}
