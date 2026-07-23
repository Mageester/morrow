import { createHash, randomUUID } from "node:crypto";
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
import { routePreset } from "../routing/router.js";

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
  const routing = taskRoutingRepository(db).get(task.id)?.decision ?? null;
  const agentState = taskRecordsRepository(db).getAgentState(task.id);
  if (!userMessage || !assistantMessage || !routing || !agentState) {
    throw new AgentTaskDispatchError(
      409,
      "Idempotent request exists without a complete committed dispatch bundle",
      "IDEMPOTENCY_INCOMPLETE",
    );
  }
  return {
    task,
    userMessage,
    assistantMessage,
    routing,
    aggregateUrl: `/api/tasks/${task.id}`,
    sseUrl: `/api/tasks/${task.id}/events/stream`,
    replayed: true as const,
  };
}

function assertReplayMatches(
  db: Database.Database,
  task: NonNullable<ReturnType<ReturnType<typeof taskRepository>["getTaskById"]>>,
  expectedFingerprint: string,
): void {
  const storedFingerprint = taskRepository(db).getIdempotencyFingerprint(task.id);
  if (!storedFingerprint) {
    throw new AgentTaskDispatchError(
      409,
      "Idempotent request exists without a canonical request fingerprint",
      "IDEMPOTENCY_INCOMPLETE",
    );
  }
  if (storedFingerprint !== expectedFingerprint) {
    throw new AgentTaskDispatchError(409, "Idempotency key was reused for a different request", "IDEMPOTENCY_CONFLICT");
  }
}

function requestFingerprint(conversationId: string, request: SendMessageInput): string {
  const canonical = {
    conversationId,
    content: request.content,
    missionId: request.missionId ?? null,
    worktreeId: request.worktreeId ?? null,
    agentId: request.agentId ?? null,
    mode: request.mode ?? "agent",
    preset: request.preset ?? DEFAULT_PRESET_ID,
    providerId: request.providerId ?? null,
    model: request.model ?? null,
    reasoning: request.reasoning ?? null,
    useMemory: request.useMemory ?? true,
    autoApprove: request.autoApprove ?? false,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
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
    const override = body.providerId
      ? { providerId: body.providerId, ...(body.model ? { model: body.model } : {}) }
      : undefined;
    const result = routePreset(presetId, env, override);
    if (!result.ok) throw new AgentTaskDispatchError(400, result.reason, "PRESET_UNAVAILABLE");
    decision = result.decision;
    if (body.model && !body.providerId) {
      decision = { ...decision, model: body.model, overridden: true };
    }
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
  const records = taskRecordsRepository(dependencies.db);
  const conversation = conversations.getConversation(conversationId);
  if (!conversation) throw new AgentTaskDispatchError(404, "Conversation not found", "NOT_FOUND");
  const idempotencyFingerprint = requestFingerprint(conversationId, body);

  if (body.idempotencyKey) {
    const existing = tasks.findByIdempotencyKey(conversation.projectId, body.idempotencyKey);
    if (existing) {
      assertReplayMatches(dependencies.db, existing, idempotencyFingerprint);
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
  let bundle;
  try {
    bundle = dependencies.db.transaction(() => {
      const task = tasks.createTask({
        id: createId(),
        projectId: conversation.projectId,
        kind: "agent_chat",
        status: "queued",
        ...(body.idempotencyKey ? {
          idempotencyKey: body.idempotencyKey,
          idempotencyFingerprint,
        } : {}),
        ...(body.agentId ? { agentId: body.agentId } : {}),
        ...(body.worktreeId ? { worktreeId: body.worktreeId } : {}),
        ...(body.missionId ? { missionId: body.missionId } : {}),
        createdAt: timestampIso,
      });
      const userMessage = conversations.appendMessage({
        id: createId(),
        conversationId,
        role: "user",
        content: body.content,
        createdAt: timestampIso,
        updatedAt: timestampIso,
      });
      records.transitionAgentState(task.id, {
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
      return { task, userMessage, assistantMessage };
    })();
  } catch (error) {
    const winner = body.idempotencyKey
      ? tasks.findByIdempotencyKey(conversation.projectId, body.idempotencyKey)
      : undefined;
    if (!winner) throw error;
    assertReplayMatches(dependencies.db, winner, idempotencyFingerprint);
    return replayResult(dependencies.db, conversationId, winner);
  }
  dependencies.runner.run(bundle.task.id);

  return {
    task: bundle.task,
    userMessage: bundle.userMessage,
    assistantMessage: bundle.assistantMessage,
    routing: decision,
    aggregateUrl: `/api/tasks/${bundle.task.id}`,
    sseUrl: `/api/tasks/${bundle.task.id}/events/stream`,
    replayed: false as const,
  };
}
