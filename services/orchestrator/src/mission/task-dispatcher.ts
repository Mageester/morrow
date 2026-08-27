import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  SendMessageSchema,
  type PresetId,
  type ProviderId,
  type RoutingDecision,
  type SendMessageInput,
  type Task,
  type ConversationContextRef,
} from "@morrow/contracts";
import type { ProviderRouteMetadata } from "../provider/base.js";
import { createProvider } from "../provider/registry.js";
import { translateReasoning } from "../provider/reasoning.js";
import { conversationsRepository } from "../repositories/conversations.js";
import { agentsRepository } from "../repositories/agents.js";
import { delegationsRepository } from "../repositories/delegations.js";
import { conversationContextRefsRepository } from "../repositories/conversation-context-refs.js";
import { missionsRepository } from "../repositories/missions.js";
import { taskRecordsRepository } from "../repositories/task-records.js";
import { taskRoutingRepository } from "../repositories/task-routing.js";
import { taskRepository } from "../repositories/tasks.js";
import { assistantProfileRepository } from "../repositories/assistant-profile.js";
import { worktreesRepository } from "../repositories/worktrees.js";
import { resolveReasoningCapability } from "../routing/models.js";
import { DEFAULT_PRESET_ID, getPreset } from "../routing/presets.js";
import { routePreset } from "../routing/router.js";
import {
  resolveStandaloneTeammateTarget,
  teammateProfileFingerprint,
  TeammateSpawnRegistry,
  teammateSpawnKey,
} from "../tools/teammate-delegation.js";
import { isLocalPrivacyProvider } from "../security/privacy-policy.js";

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
  /** Set when this task is a delegated child of another task (subagent
   * delegation) — threaded straight through to tasks.createTask so the
   * child gets real provider routing, conversation linkage, and agent-state
   * events instead of the bare runner.run shortcut. Optional and additive:
   * every existing caller keeps working with no parent relationship. */
  parentTaskId?: string;
  /** Internal only: approval persists the delegation before the runner starts. */
  deferRun?: boolean;
  /** Internal only: binds a team-agent dispatch to one durable delegation. */
  delegationId?: string;
  /** Approval-time binding for the target's durable authority profile. */
  expectedAgentProfileHash?: string;
}

export interface AgentTaskDispatcherDependencies {
  db: Database.Database;
  runner: { run(taskId: string): unknown };
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  createId?: () => string;
}

export interface SpawnAgentChatSubagentOptions {
  deferRun?: boolean;
  delegationId?: string;
  /** Client-supplied retry key for REST child admission. */
  idempotencyKey?: string;
  /** Present only for model-authored ask_teammate calls. */
  toolCallId?: string;
  /** Model-authored calls must use the standalone-target refusal rules. */
  modelInitiated?: boolean;
  /** Approval-time binding for the target's durable authority profile. */
  targetProfileHash?: string;
  /** One process-local registry shared by the server and its task runner. */
  registry?: TeammateSpawnRegistry;
  /** Parent-owned artifact/evidence handles to authorize for the child task. */
  contextRefs?: ConversationContextRef[];
}

/**
 * A context-bearing child is held before its first run so refs can be
 * attached. If that boundary fails, remove the entire unstarted bundle in one
 * transaction; leaving a queued task or empty child thread would make a failed
 * handoff appear durable and could later run without its promised context.
 */
export function cleanupUnstartedChild(
  db: Database.Database,
  projectId: string,
  taskId: string,
  conversationId: string,
): void {
  db.transaction(() => {
    db.prepare("DELETE FROM conversation_context_refs WHERE target_task_id=?").run(taskId);
    // tool_artifacts predates task foreign-key ownership, so clean it
    // explicitly alongside the task's cascading execution ledger.
    db.prepare("DELETE FROM tool_artifacts WHERE task_id=?").run(taskId);
    db.prepare("DELETE FROM tasks WHERE id=? AND project_id=?").run(taskId, projectId);
    db.prepare("DELETE FROM conversations WHERE id=? AND project_id=?").run(conversationId, projectId);
  })();
}

/**
 * Spawn a real agent_chat child from a durable parent task. The same helper is
 * used by the REST subagent route, delegation approval, and ask_teammate so
 * child conversation/provider routing and task links cannot drift. Model calls
 * pass only `toolCallId` and the narrow objective; all target profile fields
 * are resolved here from the server-side agent row.
 */
export function spawnAgentChatSubagent(
  dependencies: AgentTaskDispatcherDependencies,
  parent: Pick<Task, "id" | "projectId"> & { agentId?: string | null | undefined },
  agentId: string,
  label: string | undefined,
  options: SpawnAgentChatSubagentOptions = {},
) {
  const create = () => {
    const agents = agentsRepository(dependencies.db);
    const agent = agents.get(agentId);
    if (!agent) {
      throw new AgentTaskDispatchError(404, "Agent not found in this project", "NOT_FOUND");
    }
    if (options.modelInitiated) {
      if (parent.agentId) {
        const caller = agents.get(parent.agentId);
        if (caller?.teamId) {
          throw new AgentTaskDispatchError(409, "Team agents must use the delegation API", "TEAM_AGENT_REQUIRES_DELEGATION");
        }
      }
      try {
        resolveStandaloneTeammateTarget(parent, agent, agentId);
        const groupContext = conversationsRepository(dependencies.db).groupContextForTask(parent.id);
        if (groupContext?.mode === "group") {
          const participant = dependencies.db.prepare(
            `SELECT 1 FROM conversation_participants
             WHERE conversation_id=? AND agent_id=? AND role='participant' AND status='active'`,
          ).get(groupContext.conversationId, agent.id);
          if (!participant) throw new AgentTaskDispatchError(409, "Invite this teammate to the shared thread before asking them.", "AGENT_NOT_PARTICIPANT");
        }
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "AGENT_NOT_FOUND";
        const status = code === "AGENT_DISABLED" ? 409 : code === "AGENT_SELF" || code === "AGENT_TEAM_TARGET" || code === "AGENT_NOT_PARTICIPANT" ? 409 : 404;
        if (error instanceof AgentTaskDispatchError) throw error;
        throw new AgentTaskDispatchError(status, error instanceof Error ? error.message : "Teammate target is not allowed", code);
      }
    } else if (agent.projectId !== parent.projectId) {
      throw new AgentTaskDispatchError(404, "Agent not found in this project", "NOT_FOUND");
    }
    if (!agent.enabled) throw new AgentTaskDispatchError(409, "Agent is disabled", "AGENT_DISABLED");
    if (agent.teamId && !options.delegationId) {
      throw new AgentTaskDispatchError(409, "Team agents must be started through the delegation API", "TEAM_AGENT_REQUIRES_DELEGATION");
    }

    const idempotencyKey = options.idempotencyKey
      ?? (options.toolCallId
      ? `ask_teammate:${parent.id}:${options.toolCallId}`
      : options.delegationId
        ? `delegation:${parent.id}:${options.delegationId}`
        : undefined);
    const content = label ?? `Delegated task for ${agent.name}`;
    const tasks = taskRepository(dependencies.db);
    let conversationId: string | undefined;
    if (idempotencyKey) {
      const existing = tasks.findByIdempotencyKey(parent.projectId, idempotencyKey);
      if (existing) {
        if (existing.parentTaskId !== parent.id || existing.agentId !== agent.id) {
          throw new AgentTaskDispatchError(409, "Idempotency key was reused for a different parent or agent", "IDEMPOTENCY_CONFLICT");
        }
        const row = dependencies.db.prepare(
          "SELECT conversation_id FROM conversation_messages WHERE task_id=? ORDER BY rowid ASC LIMIT 1",
        ).get(existing.id) as { conversation_id?: string } | undefined;
        if (!row?.conversation_id) {
          throw new AgentTaskDispatchError(409, "Idempotent teammate spawn is incomplete", "IDEMPOTENCY_INCOMPLETE");
        }
        conversationId = row.conversation_id;
      }
    }

    if (!conversationId && options.modelInitiated && parent.agentId) {
      const caller = agents.get(parent.agentId);
      if (caller?.maxChildTasks !== null && caller?.maxChildTasks !== undefined
        && tasks.listChildren(parent.id).length >= caller.maxChildTasks) {
        throw new AgentTaskDispatchError(409, "Parent teammate child-task budget is exhausted", "PARENT_CHILD_TASK_LIMIT");
      }
    }
    if (options.modelInitiated && options.targetProfileHash
      && options.targetProfileHash !== teammateProfileFingerprint(agent, agents.listToolPermissions(agent.id))) {
      throw new AgentTaskDispatchError(409, "Teammate profile changed; request approval again", "AGENT_PROFILE_CHANGED");
    }

    const conversations = conversationsRepository(dependencies.db);
    let createdConversationId: string | undefined;
    let createdTaskId: string | undefined;
    if (!conversationId) {
      const now = new Date().toISOString();
      createdConversationId = (dependencies.createId ?? randomUUID)();
      conversations.createConversation({
        id: createdConversationId,
        projectId: parent.projectId,
        // A model-authored objective is task input, not a safe conversation
        // title: keep secrets or reasoning out of roster-visible metadata.
        title: options.modelInitiated ? `Delegated: ${agent.name}` : (label ?? `Delegated: ${agent.name}`),
        agentId: agent.id,
        createdAt: now,
        updatedAt: now,
      });
      conversationId = createdConversationId;
    }

    try {
      const dispatchDependencies: AgentTaskDispatcherDependencies = {
        db: dependencies.db,
        runner: dependencies.runner,
        ...(dependencies.env !== undefined ? { env: dependencies.env } : {}),
      };
      const contextRefs = options.contextRefs ?? [];
      const deferForContext = options.deferRun === true || contextRefs.length > 0;
      const result = dispatchAgentTask(dispatchDependencies, {
        conversationId,
        parentTaskId: parent.id,
        content,
        agentId: agent.id,
        providerId: agent.providerOverride ? agent.providerOverride as ProviderId : undefined,
        model: agent.modelOverride ?? undefined,
        mode: "agent",
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(deferForContext ? { deferRun: true } : {}),
        ...(options.delegationId ? { delegationId: options.delegationId } : {}),
        ...(options.targetProfileHash ? { expectedAgentProfileHash: options.targetProfileHash } : {}),
      });
      if (!result.replayed) createdTaskId = result.task.id;
      if (contextRefs.length > 0 && !result.replayed) {
        conversationContextRefsRepository(dependencies.db).attach({
          projectId: parent.projectId,
          sourceTaskId: parent.id,
          targetTaskId: result.task.id,
          refs: contextRefs,
          now: new Date().toISOString(),
        });
      }
      // A concurrent process can win the idempotency insert after this caller
      // created its fresh shell conversation. Replay the winner's messages and
      // remove that empty shell so a retry cannot leave an orphan conversation.
      if (result.replayed && createdConversationId
        && result.userMessage.conversationId !== createdConversationId) {
        conversations.deleteConversation(createdConversationId, parent.projectId);
      }
      // dispatchAgentTask already starts ordinary children. Context-bearing
      // children are deliberately deferred above so their validated handles
      // are attached before the first provider request.
      if (contextRefs.length > 0 && !options.deferRun && !result.replayed) dependencies.runner.run(result.task.id);
      return result;
    } catch (error) {
      // A dispatch transaction can fail after the fresh conversation exists.
      // Remove that empty shell, but never delete a previously durable child
      // being replayed by the idempotency path.
      if (createdConversationId && createdTaskId) {
        cleanupUnstartedChild(dependencies.db, parent.projectId, createdTaskId, createdConversationId);
      } else if (createdConversationId) {
        conversations.deleteConversation(createdConversationId, parent.projectId);
      }
      throw error;
    }
  };

  if (options.toolCallId && options.registry) {
    const key = teammateSpawnKey(parent.id, options.toolCallId);
    try {
      return options.registry.run(key, create);
    } finally {
      // Once create() returns, the durable child exists and its idempotency
      // key owns duplicate suppression. Entries must not accumulate for the
      // life of the process; failures were never cached and stay retryable.
      options.registry.clear(key);
    }
  }
  return create();
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

function requestFingerprint(
  conversationId: string,
  request: SendMessageInput,
  parentTaskId: string | null = null,
  delegationId: string | null = null,
): string {
  const canonical = {
    conversationId,
    parentTaskId,
    delegationId,
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
  const { conversationId, parentTaskId, deferRun, delegationId, expectedAgentProfileHash, ...rawBody } = request;
  const requested = SendMessageSchema.parse(rawBody);
  const env = dependencies.env ?? process.env;
  const privacyMode = assistantProfileRepository(dependencies.db).get().defaultPrivacyMode;
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const tasks = taskRepository(dependencies.db);
  const conversations = conversationsRepository(dependencies.db);
  const routing = taskRoutingRepository(dependencies.db);
  const records = taskRecordsRepository(dependencies.db);
  const agents = agentsRepository(dependencies.db);
  const delegations = delegationsRepository(dependencies.db);
  const conversation = conversations.getConversation(conversationId);
  if (!conversation) throw new AgentTaskDispatchError(404, "Conversation not found", "NOT_FOUND");

  // A conversation belongs to one teammate for its whole life. A request that
  // names no agent inherits that binding, so every turn in the thread runs
  // under the same agent's policy instead of silently falling back to the
  // default assistant. A request that names a DIFFERENT agent is refused
  // rather than honoured: running someone else's agent inside this thread
  // would execute under a policy the thread was never bound to.
  if (conversation.agentId && requested.agentId && requested.agentId !== conversation.agentId) {
    throw new AgentTaskDispatchError(
      409,
      "This conversation belongs to another agent; start a thread with that agent instead",
      "CONVERSATION_AGENT_MISMATCH",
    );
  }
  const body: SendMessageInput = conversation.agentId && !requested.agentId
    ? { ...requested, agentId: conversation.agentId }
    : requested;

  if (body.agentId) {
    const agent = agents.get(body.agentId);
    if (!agent || agent.projectId !== conversation.projectId) {
      throw new AgentTaskDispatchError(404, "Agent not found in this project", "NOT_FOUND");
    }
    if (!agent.enabled) throw new AgentTaskDispatchError(409, "Agent is disabled", "AGENT_DISABLED");
    const delegation = delegationId ? delegations.get(delegationId) : undefined;
    if (delegationId && (!delegation
      || delegation.parentTaskId !== parentTaskId
      || delegation.agentId !== agent.id
      || !((deferRun && (delegation.status === "pending_approval" || delegation.status === "approved"))
        || (!deferRun && delegation.status === "running")))) {
      throw new AgentTaskDispatchError(409, "Agent dispatch is not authorized by the delegation", "DELEGATION_POLICY_REQUIRED");
    }
    if (agent.teamId && (!delegation || delegation.parentTaskId !== parentTaskId)) {
      throw new AgentTaskDispatchError(409, "Team agents must be started through an approved delegation", "TEAM_AGENT_REQUIRES_DELEGATION");
    }
  }
  const idempotencyFingerprint = requestFingerprint(conversationId, body, parentTaskId ?? null, delegationId ?? null);

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

  const { presetId, decision: routedDecision } = resolveDecision(body, env);
  if (privacyMode === "local_only" && !isLocalPrivacyProvider(routedDecision.providerId, env)) {
    throw new AgentTaskDispatchError(
      409,
      `Local-only privacy blocks remote provider "${routedDecision.providerId}" for this request. Switch the assistant profile to Controlled cloud before sending.`,
      "PRIVACY_POLICY_BLOCKED",
    );
  }
  const decision: RoutingDecision = { ...routedDecision, privacyMode };
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
        ...(parentTaskId ? { parentTaskId } : {}),
        ...(expectedAgentProfileHash ? { expectedAgentProfileHash } : {}),
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
    const winnerConversation = dependencies.db.prepare(
      "SELECT conversation_id FROM conversation_messages WHERE task_id=? ORDER BY rowid ASC LIMIT 1",
    ).get(winner.id) as { conversation_id?: unknown } | undefined;
    if (typeof winnerConversation?.conversation_id !== "string" || !winnerConversation.conversation_id) {
      throw new AgentTaskDispatchError(
        409,
        "Idempotent request exists without a complete committed dispatch bundle",
        "IDEMPOTENCY_INCOMPLETE",
      );
    }
    return replayResult(dependencies.db, winnerConversation.conversation_id, winner);
  }
  if (!deferRun) dependencies.runner.run(bundle.task.id);

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
