import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  SendMessageSchema,
  type PresetId,
  type RoutingDecision,
  type SendMessageInput,
} from "@morrow/contracts";
import type { ProviderRouteMetadata } from "../provider/base.js";
import { createProvider } from "../provider/registry.js";
import { translateReasoning } from "../provider/reasoning.js";
import { conversationsRepository } from "../repositories/conversations.js";
import { missionsRepository } from "../repositories/missions.js";
import { taskRecordsRepository } from "../repositories/task-records.js";
import { taskRoutingRepository } from "../repositories/task-routing.js";
import { taskRepository } from "../repositories/tasks.js";
import { worktreesRepository } from "../repositories/worktrees.js";
import { resolveReasoningCapability } from "../routing/models.js";
import { DEFAULT_PRESET_ID, getPreset } from "../routing/presets.js";
import { resolveProviderForModel, routePreset } from "../routing/router.js";

export class AgentTaskDispatchError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "AgentTaskDispatchError";
  }
}

export interface AgentTaskRequest extends SendMessageInput {
  conversationId: string;
}

export interface AgentTaskDispatcherDependencies {
  db: Database.Database;
  runner: { run(taskId: string): unknown };
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  createId?: () => string;
}

function replayResult(
  db: Database.Database,
  conversationId: string,
  task: NonNullable<ReturnType<ReturnType<typeof taskRepository>["getTaskById"]>>,
) {
  const conversations = conversationsRepository(db);
  const messages = conversations.listMessages(conversationId);
  const assistantIndex = messages.findIndex((message) => message.taskId === task.id && message.role === "assistant");
  const assistantMessage = assistantIndex >= 0 ? messages[assistantIndex]! : null;
  const userMessage = assistantIndex >= 0
    ? [...messages.slice(0, assistantIndex)].reverse().find((message) => message.role === "user") ?? null
    : null;
  return {
    task,
    userMessage,
    assistantMessage,
    routing: taskRoutingRepository(db).get(task.id)?.decision ?? null,
    aggregateUrl: `/api/tasks/${task.id}`,
    sseUrl: `/api/tasks/${task.id}/events/stream`,
    replayed: true as const,
  };
}

function assertReplayMatches(
  db: Database.Database,
  conversationId: string,
  task: NonNullable<ReturnType<ReturnType<typeof taskRepository>["getTaskById"]>>,
  request: SendMessageInput,
): void {
  const mismatchedIdentity = task.missionId !== (request.missionId ?? null)
    || task.worktreeId !== (request.worktreeId ?? null)
    || task.agentId !== (request.agentId ?? null);
  const messages = conversationsRepository(db).listMessages(conversationId);
  const assistantIndex = messages.findIndex((message) => message.taskId === task.id && message.role === "assistant");
  if (assistantIndex < 0) {
    const owner = db.prepare("SELECT conversation_id FROM conversation_messages WHERE task_id=? AND role='assistant'")
      .get(task.id) as { conversation_id: string } | undefined;
    if (mismatchedIdentity || (owner && owner.conversation_id !== conversationId)) {
      throw new AgentTaskDispatchError(409, "Idempotency key was reused for a different request", "IDEMPOTENCY_CONFLICT");
    }
    return;
  }
  const userMessage = [...messages.slice(0, assistantIndex)].reverse()
    .find((message) => message.role === "user");
  if (mismatchedIdentity || userMessage?.content !== request.content) {
    throw new AgentTaskDispatchError(409, "Idempotency key was reused for a different request", "IDEMPOTENCY_CONFLICT");
  }
}

function resolveDecision(
  body: SendMessageInput,
  env: NodeJS.ProcessEnv,
): { presetId: PresetId; decision: RoutingDecision } {
  const presetId = body.preset ?? DEFAULT_PRESET_ID;
  const mode = body.mode ?? "agent";
  const toolProfile = mode === "plan-only" ? "none" : mode === "agent" ? "agent" : "read-only";
  const autoApprove = mode === "agent" && body.autoApprove === true;
  let decision: RoutingDecision;

  if (env.MOCK_PROVIDER === "true" && !body.providerId) {
    const preset = getPreset(presetId)!;
    decision = {
      version: 1,
      presetId,
      providerId: "mock",
      model: "mock-model",
      reason: "Routed to mock provider (MOCK_PROVIDER=true).",
      fallbackUsed: false,
      overridden: false,
      privacy: preset.privacy,
      candidates: [{ providerId: "mock", configured: true, reason: "mock enabled" }],
      mode,
      toolProfile,
      autoApprove,
    };
  } else {
    // A model selected without a provider must resolve to the provider that
    // actually serves it — never get stamped onto whatever provider preset
    // routing happened to choose (that produced header/runtime disagreement in
    // beta.31). If no configured provider serves it, fail here, before any
    // execution starts, with an actionable message.
    let providerId = body.providerId;
    if (body.model && !providerId) {
      const serving = resolveProviderForModel(body.model, env);
      if (!serving) {
        throw new AgentTaskDispatchError(
          400,
          `Model "${body.model}" is not served by any configured provider. Configure its provider or pick a model from \`morrow models list\`.`,
          "MODEL_UNROUTABLE",
        );
      }
      providerId = serving;
    }
    const override = providerId
      ? { providerId, ...(body.model ? { model: body.model } : {}) }
      : undefined;
    const result = routePreset(presetId, env, override);
    if (!result.ok) throw new AgentTaskDispatchError(400, result.reason, "PRESET_UNAVAILABLE");
    decision = result.decision;
    decision = { ...decision, mode, toolProfile, autoApprove };
  }

  if (body.reasoning && body.reasoning.mode !== "auto") {
    let route: ProviderRouteMetadata;
    if (decision.providerId === "mock") {
      route = {
        providerId: "mock",
        protocol: "mock",
        endpointKind: "injected",
        endpointHost: null,
        endpointLimitTokens: null,
        endpointLimitSource: "unknown",
      };
    } else {
      try {
        route = createProvider(decision.providerId, env, decision.model).route ?? {
          providerId: decision.providerId,
          protocol: "openai-chat",
          endpointKind: "injected",
          endpointHost: null,
          endpointLimitTokens: null,
          endpointLimitSource: "unknown",
        };
      } catch {
        route = {
          providerId: decision.providerId,
          protocol: "openai-chat",
          endpointKind: "injected",
          endpointHost: null,
          endpointLimitTokens: null,
          endpointLimitSource: "unknown",
        };
      }
    }
    const capability = resolveReasoningCapability(decision.providerId, decision.model);
    const translated = translateReasoning(body.reasoning, route.protocol, capability);
    if (!translated.ok) {
      throw new AgentTaskDispatchError(400, translated.reason, "REASONING_UNSUPPORTED");
    }
  }

  return {
    presetId,
    decision: { ...decision, ...(body.reasoning ? { reasoning: body.reasoning } : {}) },
  };
}

export function dispatchAgentTask(
  dependencies: AgentTaskDispatcherDependencies,
  request: AgentTaskRequest,
) {
  const { conversationId, ...rawBody } = request;
  const body = SendMessageSchema.parse(rawBody);
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const tasks = taskRepository(dependencies.db);
  const conversations = conversationsRepository(dependencies.db);
  const routing = taskRoutingRepository(dependencies.db);
  const conversation = conversations.getConversation(conversationId);
  if (!conversation) throw new AgentTaskDispatchError(404, "Conversation not found", "NOT_FOUND");

  if (body.idempotencyKey) {
    const existing = tasks.findByIdempotencyKey(conversation.projectId, body.idempotencyKey);
    if (existing) {
      assertReplayMatches(dependencies.db, conversationId, existing, body);
      return replayResult(dependencies.db, conversationId, existing);
    }
  }

  if (body.worktreeId) {
    const worktree = worktreesRepository(dependencies.db).get(body.worktreeId);
    if (!worktree || worktree.projectId !== conversation.projectId) {
      throw new AgentTaskDispatchError(404, "Worktree not found in this project", "NOT_FOUND");
    }
    if (worktree.status !== "active") {
      throw new AgentTaskDispatchError(409, `Worktree is ${worktree.status}; create a fresh one`, "CONFLICT");
    }
  }

  if (body.missionId) {
    const mission = missionsRepository(dependencies.db).get(body.missionId);
    if (!mission || mission.projectId !== conversation.projectId) {
      throw new AgentTaskDispatchError(404, "Mission not found in this project", "NOT_FOUND");
    }
  }

  const { presetId, decision } = resolveDecision(body, env);
  const timestamp = now();
  const timestampIso = timestamp.toISOString();
  let task;
  try {
    task = tasks.createTask({
      id: createId(),
      projectId: conversation.projectId,
      kind: "agent_chat",
      status: "queued",
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      ...(body.agentId ? { agentId: body.agentId } : {}),
      ...(body.worktreeId ? { worktreeId: body.worktreeId } : {}),
      ...(body.missionId ? { missionId: body.missionId } : {}),
      createdAt: timestampIso,
    });
  } catch (error) {
    const winner = body.idempotencyKey
      ? tasks.findByIdempotencyKey(conversation.projectId, body.idempotencyKey)
      : undefined;
    if (!winner) throw error;
    assertReplayMatches(dependencies.db, conversationId, winner, body);
    return replayResult(dependencies.db, conversationId, winner);
  }

  const userMessage = conversations.appendMessage({
    id: createId(),
    conversationId,
    role: "user",
    content: body.content,
    createdAt: timestampIso,
    updatedAt: timestampIso,
  });
  taskRecordsRepository(dependencies.db).transitionAgentState(task.id, {
    id: createId(),
    state: "idle",
    details: {},
    createdAt: timestampIso,
  });
  const assistantTimestamp = new Date(timestamp.getTime() + 50).toISOString();
  const assistantMessage = conversations.appendMessage({
    id: createId(),
    conversationId,
    role: "assistant",
    content: "",
    taskId: task.id,
    streamingState: "queued",
    provider: decision.providerId,
    model: decision.model,
    createdAt: assistantTimestamp,
    updatedAt: assistantTimestamp,
  });

  routing.upsert({
    taskId: task.id,
    presetId,
    providerId: decision.providerId,
    model: decision.model,
    useMemory: body.useMemory ?? true,
    decision,
    createdAt: timestampIso,
  });
  dependencies.runner.run(task.id);

  return {
    task,
    userMessage,
    assistantMessage,
    routing: decision,
    aggregateUrl: `/api/tasks/${task.id}`,
    sseUrl: `/api/tasks/${task.id}/events/stream`,
    replayed: false as const,
  };
}
