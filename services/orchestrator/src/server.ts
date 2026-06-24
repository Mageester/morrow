import { z } from "zod";
import Fastify, { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import {
  CreateProjectSchema,
  CreateTaskSchema,
  StructuredApiErrorSchema,
  SendMessageSchema,
  CreateMemoryEntrySchema,
  UpdateMemoryEntrySchema,
  UpdateConversationSchema,
  ApprovalStatusSchema,
  ResolveApprovalSchema,
  ProviderIdSchema,
  CreateAgentSchema,
  UpdateAgentSchema,
  UpsertToolPermissionSchema,
  UpsertSkillAccessSchema,
  type PresetId,
  type ProviderId,
  type RoutingDecision,
} from "@morrow/contracts";
import { openDatabase } from "./database.js";
import { realpathSync, existsSync, lstatSync } from "node:fs";
import { projectRepository } from "./repositories/projects.js";
import { agentsRepository } from "./repositories/agents.js";
import { taskRepository } from "./repositories/tasks.js";
import { taskRecordsRepository } from "./repositories/task-records.js";
import { conversationsRepository } from "./repositories/conversations.js";
import { taskRoutingRepository } from "./repositories/task-routing.js";
import { memoryRepository } from "./repositories/memory.js";
import { searchRepository } from "./repositories/search.js";
import { skillUsageRepository } from "./repositories/skill-usage.js";
import { schedulesRepository } from "./repositories/schedules.js";
import { assertValidCron, nextRun } from "./schedule/cron.js";
import { parseTscDiagnostics, parseEslintDiagnostics, summarizeDiagnostics } from "./workspace/diagnostics.js";
import { runProcessSafe } from "./tools/command-executor.js";
import { loadAdaptersFromEnv, notifyAll, type MessageAdapter } from "./messaging/adapter.js";
import { SearchKindSchema, CreateScheduleSchema, DiagnosticToolSchema, SpawnSubagentSchema, NotifyRequestSchema } from "@morrow/contracts";

export type DiagnosticsCommandResult = { stdout: string; stderr: string; exitCode: number | null };
export type DiagnosticsRunner = (tool: "tsc" | "eslint", cwd: string) => Promise<DiagnosticsCommandResult>;

const defaultDiagnosticsRunner: DiagnosticsRunner = async (tool, cwd) => {
  const args = tool === "tsc" ? ["tsc", "--noEmit", "--pretty", "false"] : ["eslint", ".", "-f", "json"];
  const result = await runProcessSafe("npx", args, cwd, process.env, { timeoutMs: 120000, maxOutputBytes: 4_000_000 });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
};
import { approvalsRepository } from "./repositories/approvals.js";
import { recoverRunningTasks } from "./recovery.js";
import { TaskRunner } from "./runner.js";
import { changeSetsRepository } from "./repositories/change-sets.js";
import { ApprovalContinuationRegistry } from "./execution/continuation.js";
import { hashString, assertContainedRealPath } from "./tools/diff-applier.js";
import { canonicalCommandTrustKey } from "./tools/command-policy.js";
import { resolveMorrowHome } from "./home.js";
import { unlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { listProviderStatuses } from "./provider/registry.js";
import { OAUTH_FINDINGS } from "./provider/oauth.js";
import { listModels } from "./routing/models.js";
import { listPresets, getPreset, isPresetId, DEFAULT_PRESET_ID } from "./routing/presets.js";
import { routePreset, listPresetStatuses } from "./routing/router.js";
import { testProviderConnectivity } from "./provider/connectivity.js";
import { configureProvider, removeProviderCredentials, providerEnvMapping } from "./provider/secrets.js";
import { TOOL_CATALOG, PERMISSION_PROFILE } from "./tools/catalog.js";

export class ApiError extends Error {
  constructor(public statusCode: number, message: string, public code: string = "INTERNAL_ERROR") {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * An idempotency key lets a client safely retry a creation request (e.g. after a
 * dropped connection) without spawning a duplicate task. Accepted from the
 * `Idempotency-Key` header or an `idempotencyKey` body field. Bounded and
 * trimmed; anything empty or oversized is treated as absent.
 */
function readIdempotencyKey(request: { headers?: Record<string, unknown>; body?: unknown }): string | undefined {
  const header = request.headers?.["idempotency-key"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const body = request.body as { idempotencyKey?: unknown } | undefined;
  const fromBody = typeof body?.idempotencyKey === "string" ? body.idempotencyKey : undefined;
  const raw = (typeof fromHeader === "string" ? fromHeader : undefined) ?? fromBody;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : undefined;
}

function parseEventCursor(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new ApiError(400, "Invalid cursor", "INVALID_CURSOR");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new ApiError(400, "Invalid cursor", "INVALID_CURSOR");
  return cursor;
}

export type ServerDependencies = {
  db: Database.Database;
  runner: TaskRunner;
  sseIntervalMs?: number;
  /** Injectable so the diagnostics route is fast and deterministic in tests. */
  diagnosticsRunner?: DiagnosticsRunner;
  /** Injectable messaging adapters; defaults to env-configured ones. */
  messageAdapters?: MessageAdapter[];
  /**
   * Absolute path to the Morrow secrets file. When provided, the
   * provider-configuration endpoints can persist credentials and hot-apply them
   * to the running process. When absent, those endpoints report that in-app
   * configuration is unavailable (e.g. in tests) rather than failing obscurely.
   */
  secretsFile?: string;
};

export function buildServer(deps: ServerDependencies): FastifyInstance {
  const app = Fastify({ logger: false });

  const projects = projectRepository(deps.db);
  const agents = agentsRepository(deps.db);
  const tasks = taskRepository(deps.db);
  const records = taskRecordsRepository(deps.db);
  const convs = conversationsRepository(deps.db);
  const routingRepo = taskRoutingRepository(deps.db);
  const memory = memoryRepository(deps.db);
  const search = searchRepository(deps.db);
  const skillUsage = skillUsageRepository(deps.db);
  const schedules = schedulesRepository(deps.db);
  const approvals = approvalsRepository(deps.db);
  const changeSets = changeSetsRepository(deps.db);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      reply.status(400).send({
        version: 1,
        error: { code: "VALIDATION_ERROR", message: "Invalid request payload" }
      });
      return;
    }
    
    if (error instanceof ApiError) {
      reply.status(error.statusCode).send({
        version: 1,
        error: { code: error.code, message: error.message }
      });
      return;
    }

    reply.status(500).send({
      version: 1,
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" }
    });
  });

  // Liveness + schema probe. Used by the CLI to detect a running service and by
  // `morrow doctor` to report migration state. Exposes no secrets.
  app.get("/", async () => ({
    name: "morrow-orchestrator",
    status: "healthy",
    ui: "http://127.0.0.1:5173",
    health: "/api/health",
  }));

  app.get("/api/health", async () => {
    const row = deps.db.prepare("SELECT MAX(id) AS latest, COUNT(*) AS applied FROM schema_migrations").get() as { latest: number | null; applied: number };
    return {
      ok: true,
      service: "morrow-orchestrator",
      apiVersion: 1,
      mockProvider: process.env.MOCK_PROVIDER === "true",
      migrations: { applied: Number(row.applied), latest: row.latest },
      time: new Date().toISOString(),
    };
  });

  app.post("/api/projects", async (request, reply) => {
    const body = CreateProjectSchema.parse(request.body);
    
    if (!existsSync(body.workspacePath) || !lstatSync(body.workspacePath).isDirectory()) {
      throw new ApiError(400, "Workspace must exist and be a directory", "INVALID_WORKSPACE");
    }

    let canonicalPath;
    try {
      canonicalPath = realpathSync(body.workspacePath);
    } catch {
      throw new ApiError(400, "Invalid workspace path", "INVALID_WORKSPACE");
    }

    try {
      const project = projects.createProject({
        id: crypto.randomUUID(),
        name: body.name,
        workspacePath: canonicalPath,
        createdAt: new Date().toISOString()
      });
      return project;
    } catch (e: any) {
      if (e.message.includes("Traversal rejected") || e.message.includes("Symlink escape")) {
         throw new ApiError(400, "Invalid workspace path", "INVALID_WORKSPACE");
      }
      throw e;
    }
  });

  app.get("/api/projects", async (request, reply) => {
    return projects.listProjects();
  });

  app.get("/api/projects/:projectId", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return project;
  });

  // ── Agents ─────────────────────────────────────────────────────────────────

  app.get("/api/projects/:projectId/agents", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return agents.listByProject(projectId);
  });

  app.post("/api/projects/:projectId/agents", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = CreateAgentSchema.parse(request.body);
    const agent = agents.create({ id: crypto.randomUUID(), projectId, ...body, role: body.role ?? "assistant" });
    reply.status(201);
    return agent;
  });

  app.get("/api/agents/:agentId", async (request) => {
    const { agentId } = request.params as { agentId: string };
    const agent = agents.get(agentId);
    if (!agent) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    return agent;
  });

  app.put("/api/agents/:agentId", async (request) => {
    const { agentId } = request.params as { agentId: string };
    const agent = agents.get(agentId);
    if (!agent) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    // Read projectId from body to authorize the update.
    const body = z.object({ projectId: z.string().min(1), ...UpdateAgentSchema.shape }).parse(request.body);
    const updated = agents.update(agentId, body.projectId, body);
    if (!updated) throw new ApiError(404, "Agent not found in project", "NOT_FOUND");
    return updated;
  });

  app.delete("/api/agents/:agentId", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const body = z.object({ projectId: z.string().min(1) }).parse(request.body);
    if (!agents.delete(agentId, body.projectId)) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    reply.status(204).send();
  });

  // ── Agent Tool Permissions ─────────────────────────────────────────────────

  app.get("/api/agents/:agentId/tool-permissions", async (request) => {
    const { agentId } = request.params as { agentId: string };
    if (!agents.get(agentId)) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    return agents.listToolPermissions(agentId);
  });

  app.put("/api/agents/:agentId/tool-permissions", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    if (!agents.get(agentId)) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    const body = UpsertToolPermissionSchema.parse(request.body);
    reply.status(200);
    return agents.upsertToolPermission(agentId, body);
  });

  app.delete("/api/agents/:agentId/tool-permissions/:toolName", async (request, reply) => {
    const { agentId, toolName } = request.params as { agentId: string; toolName: string };
    if (!agents.get(agentId)) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    if (!agents.deleteToolPermission(agentId, toolName)) throw new ApiError(404, "Tool permission not found", "NOT_FOUND");
    reply.status(204).send();
  });

  // ── Agent Skill Access ─────────────────────────────────────────────────────

  app.get("/api/agents/:agentId/skill-access", async (request) => {
    const { agentId } = request.params as { agentId: string };
    if (!agents.get(agentId)) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    return agents.listSkillAccess(agentId);
  });

  app.put("/api/agents/:agentId/skill-access", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    if (!agents.get(agentId)) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    const body = UpsertSkillAccessSchema.parse(request.body);
    reply.status(200);
    return agents.upsertSkillAccess(agentId, body);
  });

  app.delete("/api/agents/:agentId/skill-access/:skillId", async (request, reply) => {
    const { agentId, skillId } = request.params as { agentId: string; skillId: string };
    if (!agents.get(agentId)) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    if (!agents.deleteSkillAccess(agentId, skillId)) throw new ApiError(404, "Skill access not found", "NOT_FOUND");
    reply.status(204).send();
  });

  app.post("/api/projects/:projectId/tasks/inspect-workspace", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");

    const idempotencyKey = readIdempotencyKey(request);
    const links = (id: string) => ({
      taskId: id,
      projectId,
      aggregateUrl: `/api/tasks/${id}`,
      eventHistoryUrl: `/api/tasks/${id}/events`,
      sseUrl: `/api/tasks/${id}/events/stream`,
    });

    // Idempotent replay: a repeated request with the same key returns the
    // original task (200) instead of starting a second inspection.
    if (idempotencyKey) {
      const existing = tasks.findByIdempotencyKey(projectId, idempotencyKey);
      if (existing) {
        reply.status(200);
        return { ...links(existing.id), status: existing.status, replayed: true };
      }
    }

    const task = tasks.createTask({
      id: crypto.randomUUID(),
      projectId,
      kind: "inspect_workspace",
      status: "queued",
      ...(idempotencyKey ? { idempotencyKey } : {}),
      createdAt: new Date().toISOString(),
    });

    deps.runner.run(task.id);
    reply.status(202);
    return { ...links(task.id), status: task.status };
  });

  app.get("/api/projects/:projectId/tasks", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    return tasks.listTasksByProject(projectId);
  });

  app.get("/api/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");
    const agg = records.getAggregate(taskId);
    const toolCalls = convs.listToolCallsForTask(taskId);
    const routing = routingRepo.get(taskId)?.decision ?? null;
    return { ...agg, toolCalls, approvals: approvals.listByTask(taskId), routing };
  });

  app.get("/api/tasks/:taskId/events", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const { after } = request.query as { after?: string };
    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");
    
    let events = records.listEvents(taskId);
    if (after) {
      const cursor = parseEventCursor(after);
      events = events.filter(e => e.sequence > cursor);
    }
    return events;
  });

  app.get("/api/tasks/:taskId/events/stream", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    
    const lastEventIdHeader = request.headers["last-event-id"] as string | undefined;
    const afterQuery = (request.query as any).after as string | undefined;
    
    let afterSeq = 0;
    const cursorRaw = lastEventIdHeader ?? afterQuery;
    
    if (cursorRaw !== undefined) {
      afterSeq = parseEventCursor(cursorRaw);
    }

    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    let isClosed = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    request.raw.on("close", () => {
      isClosed = true;
      if (timeoutId) clearTimeout(timeoutId);
    });

    const sendEvent = (event: any) => {
      reply.raw.write(`id: ${event.sequence}\n`);
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const pollEvents = async () => {
      if (isClosed) return;
      
      const allEvents = records.listEvents(taskId);
      const newEvents = allEvents.filter(e => e.sequence > afterSeq);
      
      for (const e of newEvents) {
        sendEvent(e);
        afterSeq = e.sequence;
        if (["task.verified", "task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(e.type)) {
          reply.raw.end();
          return;
        }
      }

      const currentTask = tasks.getTaskById(taskId);
      if (currentTask && ["verified", "completed", "failed", "cancelled", "interrupted"].includes(currentTask.status) && newEvents.length === 0) {
        reply.raw.end();
        return;
      }

      timeoutId = setTimeout(pollEvents, deps.sseIntervalMs ?? 100);
    };

    pollEvents();
  });

  app.get("/api/projects/:projectId/conversations", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const { includeArchived } = request.query as { includeArchived?: string };
    return convs.listConversationsByProject(projectId, includeArchived === "true" || includeArchived === "1");
  });

  app.get("/api/conversations/:conversationId", async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const conversation = convs.getConversation(conversationId);
    if (!conversation) throw new ApiError(404, "Conversation not found", "NOT_FOUND");
    return conversation;
  });

  app.patch("/api/conversations/:conversationId", async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const conversation = convs.getConversation(conversationId);
    if (!conversation) throw new ApiError(404, "Conversation not found", "NOT_FOUND");
    const body = UpdateConversationSchema.parse(request.body);
    const now = new Date().toISOString();
    let updated = conversation;
    if (body.title !== undefined) updated = convs.renameConversation(conversationId, body.title.trim(), now) ?? updated;
    if (body.archived !== undefined) updated = convs.setArchived(conversationId, body.archived, now) ?? updated;
    return updated;
  });

  app.post("/api/projects/:projectId/conversations", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    
    const body = request.body as { title?: string } | null;
    const title = body?.title?.trim() || "New Conversation";
    
    const conversation = convs.createConversation({
      id: crypto.randomUUID(),
      projectId,
      title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    return conversation;
  });

  app.get("/api/conversations/:conversationId/messages", async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const conversation = convs.getConversation(conversationId);
    if (!conversation) throw new ApiError(404, "Conversation not found", "NOT_FOUND");
    return convs.listMessages(conversationId);
  });

  app.post("/api/conversations/:conversationId/messages", async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const conversation = convs.getConversation(conversationId);
    if (!conversation) throw new ApiError(404, "Conversation not found", "NOT_FOUND");
    
    const body = SendMessageSchema.parse(request.body);

    const presetId: PresetId = body.preset && isPresetId(body.preset) ? body.preset : DEFAULT_PRESET_ID;
    const mode = body.mode ?? "agent";
    const toolProfile = mode === "plan-only" ? "none" : mode === "agent" ? "agent" : "read-only";
    // YOLO / auto-approve only has meaning when execution tools are exposed.
    // Inspect (read-only) and plan-only never request approvals, so we refuse to
    // record an auto-approve flag for them rather than imply it does something.
    const autoApprove = mode === "agent" && body.autoApprove === true;

    // Resolve the provider+model the agent will actually use, and report it.
    let decision: RoutingDecision;
    if (process.env.MOCK_PROVIDER === "true" && !body.providerId) {
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
      const result = routePreset(presetId, process.env, override);
      if (!result.ok) {
        throw new ApiError(400, result.reason, "PRESET_UNAVAILABLE");
      }
      decision = result.decision;
      // Model-only override (keep routed provider, force the model id).
      if (body.model && !body.providerId) {
        decision = { ...decision, model: body.model, overridden: true };
      }
      decision = { ...decision, mode, toolProfile, autoApprove };
    }

    const timestamp = new Date().toISOString();

    const userMsg = convs.appendMessage({
      id: crypto.randomUUID(),
      conversationId,
      role: "user",
      content: body.content,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const task = tasks.createTask({
      id: crypto.randomUUID(),
      projectId: conversation.projectId,
      kind: "agent_chat",
      status: "queued",
      createdAt: timestamp,
    });
    records.transitionAgentState(task.id, { id: crypto.randomUUID(), state: "idle", details: {}, createdAt: timestamp });

    const assistantMsg = convs.appendMessage({
      id: crypto.randomUUID(),
      conversationId,
      role: "assistant",
      content: "",
      taskId: task.id,
      streamingState: "queued",
      provider: decision.providerId,
      model: decision.model,
      createdAt: new Date(Date.now() + 50).toISOString(),
      updatedAt: new Date(Date.now() + 50).toISOString(),
    });

    routingRepo.upsert({
      taskId: task.id,
      presetId,
      providerId: decision.providerId,
      model: decision.model,
      useMemory: body.useMemory ?? true,
      decision,
      createdAt: timestamp,
    });

    deps.runner.run(task.id);

    reply.status(202);
    return {
      task,
      userMessage: userMsg,
      assistantMessage: assistantMsg,
      routing: decision,
      aggregateUrl: `/api/tasks/${task.id}`,
      sseUrl: `/api/tasks/${task.id}/events/stream`,
    };
  });

  // Subagent delegation: a subagent is a child task with its own scope, linked
  // to its parent via parent_task_id. This builds the task graph.
  app.post("/api/tasks/:taskId/subagents", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const parent = tasks.getTaskById(taskId);
    if (!parent) throw new ApiError(404, "Task not found", "NOT_FOUND");
    const body = SpawnSubagentSchema.parse(request.body ?? {});
    const child = tasks.createTask({
      id: crypto.randomUUID(),
      projectId: parent.projectId,
      kind: body.kind,
      status: "queued",
      parentTaskId: parent.id,
      createdAt: new Date().toISOString(),
    });
    deps.runner.run(child.id);
    reply.status(202);
    return { parentTaskId: parent.id, taskId: child.id, aggregateUrl: `/api/tasks/${child.id}` };
  });

  app.get("/api/tasks/:taskId/tree", async (request) => {
    const { taskId } = request.params as { taskId: string };
    const root = tasks.getTaskById(taskId);
    if (!root) throw new ApiError(404, "Task not found", "NOT_FOUND");
    type Node = { task: typeof root; children: Node[] };
    const build = (node: NonNullable<typeof root>): Node => ({
      task: node,
      children: tasks.listChildren(node.id).map(build),
    });
    return build(root);
  });

  app.post("/api/tasks/:taskId/cancel", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");

    deps.runner.cancel(taskId);
    reply.status(204).send();
  });

  app.post("/api/tasks/:taskId/resume", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");
    if (task.status !== "interrupted") throw new ApiError(409, "Only interrupted tasks can be resumed", "TASK_NOT_RESUMABLE");
    records.resumeInterruptedTask(taskId, { id: crypto.randomUUID(), createdAt: new Date().toISOString(), payload: { reason: "user_continue" } });
    deps.runner.run(taskId);
    reply.status(202);
    return records.getAggregate(taskId).task;
  });

  app.post("/api/tasks/:taskId/retry", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");
    if (task.status !== "failed" && task.status !== "interrupted") {
      throw new ApiError(409, "Only failed or interrupted tasks can be retried", "TASK_NOT_RETRYABLE");
    }
    records.retryTask(taskId);
    deps.runner.run(taskId);
    reply.status(202);
    return records.getAggregate(taskId).task;
  });

  app.get("/api/tasks/:taskId/diff", async (request) => {
    const { taskId } = request.params as { taskId: string };
    const csList = changeSets.listByTask(taskId);
    // Select the most recent applicable change set (listByTask is created-ASC).
    const applied = [...csList].reverse().find(c => c.state === "applied" || c.state === "undone");
    if (!applied) {
      return { diff: null };
    }
    return {
      id: applied.id,
      state: applied.state,
      diff: applied.diff,
      diffHash: applied.diffHash,
      files: Object.keys(applied.originalHashes),
      undoResult: applied.undoResult,
    };
  });

  app.post("/api/tasks/:taskId/undo", async (request) => {
    const { taskId } = request.params as { taskId: string };
    const csList = changeSets.listByTask(taskId);
    // Undo the most recent applied change set (listByTask is created-ASC).
    const applied = [...csList].reverse().find(c => c.state === "applied");
    if (!applied) throw new ApiError(404, "No applied change set found for this task", "NOT_FOUND");

    const project = projects.getProjectById(applied.projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");

    // 1. Verify containment (incl. symlink escape), existence, and that the
    //    file still matches the hash we wrote — refuse if manually edited since.
    const containedPaths: Record<string, string> = {};
    for (const file of Object.keys(applied.originalHashes)) {
      if (file === "/dev/null") continue;
      let fullPath: string;
      try {
        fullPath = assertContainedRealPath(project.workspacePath, file);
      } catch (e: any) {
        throw new ApiError(403, `Path containment violation: ${file}`, "FORBIDDEN");
      }
      containedPaths[file] = fullPath;

      if (!existsSync(fullPath)) {
        throw new ApiError(409, `File has been deleted since application: ${file}`, "CONFLICT");
      }
      const currentContent = readFileSync(fullPath, "utf8");
      const currentHash = hashString(currentContent);
      if (currentHash !== applied.postApplyHashes?.[file]) {
        throw new ApiError(409, `Unsafe undo: file has manual modifications: ${file}`, "CONFLICT");
      }
    }

    // 2. Perform rollback from trusted backups only (no git reset/clean/checkout).
    const backupsDir = join(resolveMorrowHome(process.env), "backups");
    const restoredFiles: string[] = [];

    for (const file of Object.keys(applied.originalHashes)) {
      const originalHash = applied.originalHashes[file];
      const fullPath = file === "/dev/null" ? "" : (containedPaths[file] ?? assertContainedRealPath(project.workspacePath, file));

      if (originalHash === "") {
        // File was created by the change set: removing it restores the original
        // (absent) state.
        if (fullPath && existsSync(fullPath)) {
          unlinkSync(fullPath);
          restoredFiles.push(file);
        }
      } else {
        const backupFile = join(backupsDir, `${originalHash}.bak`);
        if (!existsSync(backupFile)) {
          throw new ApiError(500, `Backup file not found for ${file}`, "INTERNAL_ERROR");
        }
        const originalContent = readFileSync(backupFile, "utf8");
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, originalContent, "utf8");
        restoredFiles.push(file);
      }
    }

    // 3. Persist the undo result
    const undoResult = {
      undoneAt: new Date().toISOString(),
      restoredFiles
    };
    changeSets.updateUndone(applied.id, undoResult);

    return {
      status: "success",
      restoredFiles
    };
  });

  app.get("/api/projects/:projectId/approvals", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const { status } = request.query as { status?: string };
    if (status) {
      const parsed = ApprovalStatusSchema.safeParse(status);
      if (!parsed.success) throw new ApiError(400, "Invalid approval status", "VALIDATION_ERROR");
      return approvals.listByProject(projectId, parsed.data);
    }
    return approvals.listByProject(projectId);
  });

  app.get("/api/approvals/:approvalId", async (request) => {
    const { approvalId } = request.params as { approvalId: string };
    const approval = approvals.get(approvalId);
    if (!approval) throw new ApiError(404, "Approval not found", "NOT_FOUND");
    return approval;
  });

  app.post("/api/approvals/:approvalId/resolve", async (request) => {
    const { approvalId } = request.params as { approvalId: string };
    const body = ResolveApprovalSchema.parse(request.body);
    const approval = approvals.get(approvalId);
    if (!approval || approval.projectId !== body.projectId) throw new ApiError(404, "Approval not found in project", "NOT_FOUND");

    // Derive the trust binding server-side from the persisted approval — never
    // from a client-supplied pattern — and validate it BEFORE mutating state.
    let trustKey: string | undefined;
    if (body.decision === "trust_project") {
      const d = approval.details as { executable?: unknown; args?: unknown; cwd?: unknown };
      if (approval.kind !== "command" || typeof d.executable !== "string") {
        throw new ApiError(400, "Only command approvals can be trusted", "INVALID_TRUST");
      }
      trustKey = canonicalCommandTrustKey(d.executable, Array.isArray(d.args) ? (d.args as string[]) : [], typeof d.cwd === "string" ? d.cwd : "");
    }

    const resolved = approvals.resolve(approvalId, { decision: body.decision, ...(body.note ? { note: body.note } : {}), resolvedAt: new Date().toISOString() });
    if (!resolved) throw new ApiError(409, "Approval is no longer pending", "APPROVAL_ALREADY_RESOLVED");
    if (trustKey) {
      approvals.grantCommandTrust({ projectId: approval.projectId, pattern: trustKey, createdAt: resolved.resolvedAt! });
    }
    records.appendEvent({
      id: crypto.randomUUID(),
      taskId: approval.taskId,
      type: "approval.resolved",
      payload: { approvalId, decision: body.decision },
      createdAt: resolved.resolvedAt!,
    });

    const t = tasks.getTaskById(approval.taskId);
    if (t && t.status === "interrupted") {
      // Resume a task that a restart interrupted while it awaited this approval.
      deps.db.prepare("UPDATE tasks SET status='queued', updated_at=? WHERE id=?").run(new Date().toISOString(), approval.taskId);
      deps.runner.run(approval.taskId);
    } else if (t && (t.status === "running" || t.status === "queued")) {
      // Wake the live, in-process task.
      ApprovalContinuationRegistry.resolveApproval(approvalId, body.decision);
    } else {
      // Task already ended (failed/cancelled/completed). The decision is
      // recorded, but a dead task is never revived; drop any latched wakeup.
      ApprovalContinuationRegistry.clear(approvalId);
    }

    return resolved;
  });

  app.get("/api/projects/:projectId/command-trusts", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return approvals.listCommandTrusts(projectId);
  });

  app.delete("/api/projects/:projectId/command-trusts", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = z.object({ pattern: z.string().trim().min(1).max(240) }).parse(request.body);
    if (!approvals.revokeCommandTrust(projectId, body.pattern)) throw new ApiError(404, "Command trust not found", "NOT_FOUND");
    reply.status(204).send();
  });

  // Backward-compatible summary of the active default provider (no secrets).
  app.get("/api/provider/status", async () => {
    if (process.env.MOCK_PROVIDER === "true") {
      return { configured: true, provider: "mock", model: "mock-model" };
    }
    const routed = routePreset(DEFAULT_PRESET_ID, process.env);
    if (routed.ok) {
      return { configured: true, provider: routed.decision.providerId, model: routed.decision.model };
    }
    const anyConfigured = listProviderStatuses().find((s) => s.configured);
    if (anyConfigured) {
      return { configured: true, provider: anyConfigured.id, model: anyConfigured.defaultModel ?? "" };
    }
    return { configured: false, provider: "none", model: "" };
  });

  // Full provider status list (configured/available, capabilities, endpoint host).
  app.get("/api/providers", async () => listProviderStatuses());

  // Capability matrix for the UI.
  app.get("/api/providers/capabilities", async () =>
    listProviderStatuses().map((s) => ({
      id: s.id,
      label: s.label,
      kind: s.kind,
      configured: s.configured,
      capabilities: s.capabilities,
    }))
  );

  // Honest OAuth integration findings.
  app.get("/api/providers/oauth", async () => OAUTH_FINDINGS);

  // Bounded, server-side connectivity test for a single provider. The request is
  // made with credentials from the server environment; the response never
  // contains the key or any header value — only the host and a normalized result.
  app.post("/api/providers/:providerId/test", async (request) => {
    const { providerId } = request.params as { providerId: string };
    const parsed = ProviderIdSchema.safeParse(providerId);
    if (!parsed.success) throw new ApiError(400, `Unknown provider: ${providerId}`, "INVALID_PROVIDER");
    return testProviderConnectivity(parsed.data, process.env);
  });

  // Save provider credentials from the app (no PowerShell / env vars / restart).
  // The key is written to the server-side secrets file AND hot-applied to the
  // running process so it takes effect immediately. The response never echoes
  // the secret — only the refreshed, non-secret provider status.
  app.post("/api/providers/:providerId/configure", async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const parsed = ProviderIdSchema.safeParse(providerId);
    if (!parsed.success) throw new ApiError(400, `Unknown provider: ${providerId}`, "INVALID_PROVIDER");
    const id = parsed.data;
    if (!providerEnvMapping(id)) {
      throw new ApiError(400, `Provider "${id}" cannot be configured in-app.`, "PROVIDER_NOT_CONFIGURABLE");
    }
    if (!deps.secretsFile) {
      throw new ApiError(503, "In-app provider configuration is unavailable on this server.", "SECRETS_UNAVAILABLE");
    }
    const body = z
      .object({
        apiKey: z.string().max(8192).optional(),
        baseUrl: z.string().max(2048).optional(),
        model: z.string().max(256).optional(),
      })
      .strict()
      .parse((request.body ?? {}) as unknown);
    if (body.apiKey === undefined && body.baseUrl === undefined && body.model === undefined) {
      throw new ApiError(400, "Nothing to configure (provide apiKey, baseUrl, or model).", "EMPTY_CONFIGURE");
    }
    if (body.baseUrl !== undefined && body.baseUrl.trim() !== "") {
      try {
        const u = new URL(body.baseUrl.trim());
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
      } catch {
        throw new ApiError(400, "baseUrl must be a valid http(s) URL.", "INVALID_BASE_URL");
      }
    }
    const result = configureProvider(deps.secretsFile, id, body, process.env);
    const status = listProviderStatuses().find((s) => s.id === id) ?? null;
    reply.send({
      ok: true,
      provider: id,
      written: result.written,
      cleared: result.cleared,
      securePermissions: result.securePermissions,
      shadowedByEnv: result.shadowedByEnv,
      status,
    });
  });

  // Remove all stored credentials for a provider (file + running process).
  app.delete("/api/providers/:providerId/credentials", async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const parsed = ProviderIdSchema.safeParse(providerId);
    if (!parsed.success) throw new ApiError(400, `Unknown provider: ${providerId}`, "INVALID_PROVIDER");
    const id = parsed.data;
    if (!providerEnvMapping(id)) {
      throw new ApiError(400, `Provider "${id}" has no stored credentials.`, "PROVIDER_NOT_CONFIGURABLE");
    }
    if (!deps.secretsFile) {
      throw new ApiError(503, "In-app provider configuration is unavailable on this server.", "SECRETS_UNAVAILABLE");
    }
    const { removed } = removeProviderCredentials(deps.secretsFile, id, process.env);
    const status = listProviderStatuses().find((s) => s.id === id) ?? null;
    reply.send({ ok: true, provider: id, removed, status });
  });

  // Safe read-only tool catalog and the enforced permission profile.
  app.get("/api/tools", async () => TOOL_CATALOG);
  app.get("/api/permissions", async () => PERMISSION_PROFILE);

  // Audit: a truthful record of executed tasks with their disclosure, tool-call
  // count, and evidence count. Detailed per-run audit reuses GET /api/tasks/:id.
  app.get("/api/audit", async (request) => {
    const { projectId, limit } = request.query as { projectId?: string; limit?: string };
    const max = Math.min(Math.max(parseInt(limit ?? "50", 10) || 50, 1), 500);
    const where = projectId ? "WHERE t.project_id = ?" : "";
    const rows = deps.db
      .prepare(
        `SELECT t.id AS task_id, t.project_id, t.type AS kind, t.status, t.created_at,
                d.provider, d.network_access,
                (SELECT COUNT(*) FROM message_tool_calls mtc WHERE mtc.task_id = t.id) AS tool_calls,
                (SELECT COUNT(*) FROM task_evidence te WHERE te.task_id = t.id) AS evidence
         FROM tasks t LEFT JOIN execution_disclosures d ON d.task_id = t.id
         ${where} ORDER BY t.created_at DESC, t.id DESC LIMIT ?`
      )
      .all(...(projectId ? [projectId, max] : [max])) as any[];
    return rows.map((r) => {
      const routing = routingRepo.get(r.task_id)?.decision ?? null;
      return {
        taskId: r.task_id,
        projectId: r.project_id,
        kind: r.kind,
        status: r.status,
        provider: r.provider ?? routing?.providerId ?? null,
        model: routing?.model ?? null,
        networkAccess: r.network_access ?? null,
        toolCalls: Number(r.tool_calls),
        evidence: Number(r.evidence),
        createdAt: r.created_at,
      };
    });
  });

  // Built-in model registry with availability derived from configured providers.
  app.get("/api/models", async () => {
    const configured = new Set(listProviderStatuses().filter((s) => s.configured).map((s) => s.id));
    return listModels().map((model) => ({ model, available: configured.has(model.providerId) }));
  });

  // Presets with live availability + resolved provider/model. In mock mode every
  // preset resolves to the mock provider so the UI reflects what will actually run.
  app.get("/api/presets", async () => {
    if (process.env.MOCK_PROVIDER === "true") {
      return listPresets().map((preset) => ({ preset, available: true, unavailableReason: null, resolved: { providerId: "mock", model: "mock-model" } }));
    }
    return listPresetStatuses();
  });

  // ── Memory ──────────────────────────────────────────────────────────────────

  app.get("/api/projects/:projectId/search", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const q = z
      .object({
        q: z.string().max(500).optional().default(""),
        kind: z.union([SearchKindSchema, z.array(SearchKindSchema)]).optional(),
        conversationId: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
      })
      .parse(request.query);
    const kinds = q.kind === undefined ? undefined : Array.isArray(q.kind) ? q.kind : [q.kind];
    return search.search(projectId, q.q, {
      ...(kinds ? { kinds } : {}),
      ...(q.conversationId ? { conversationId: q.conversationId } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
  });

  const messageAdapters = deps.messageAdapters ?? loadAdaptersFromEnv(process.env);
  app.post("/api/notify", async (request) => {
    const body = NotifyRequestSchema.parse(request.body);
    const results = await notifyAll(messageAdapters, { text: body.text, ...(body.subject ? { subject: body.subject } : {}) });
    return { sent: results.filter((r) => r.ok).length, results };
  });

  const diagnosticsRunner = deps.diagnosticsRunner ?? defaultDiagnosticsRunner;
  app.get("/api/projects/:projectId/diagnostics", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const { tool } = z.object({ tool: DiagnosticToolSchema.default("tsc") }).parse(request.query);
    const result = await diagnosticsRunner(tool, project.workspacePath);
    const text = tool === "tsc" ? `${result.stdout}\n${result.stderr}` : result.stdout;
    const diagnostics = tool === "tsc" ? parseTscDiagnostics(text) : parseEslintDiagnostics(result.stdout);
    return summarizeDiagnostics(tool, diagnostics);
  });

  app.get("/api/projects/:projectId/schedules", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return schedules.listByProject(projectId);
  });

  app.post("/api/projects/:projectId/schedules", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = CreateScheduleSchema.parse(request.body);
    try {
      assertValidCron(body.cron);
    } catch (error) {
      throw new ApiError(400, `Invalid cron expression: ${(error as Error).message}`, "VALIDATION_ERROR");
    }
    const created = schedules.create({
      id: crypto.randomUUID(),
      projectId,
      cron: body.cron,
      taskKind: body.taskKind,
      nextRunAt: nextRun(body.cron, new Date()).toISOString(),
      createdAt: new Date().toISOString(),
    });
    reply.status(201);
    return created;
  });

  app.delete("/api/schedules/:scheduleId", async (request, reply) => {
    const { scheduleId } = request.params as { scheduleId: string };
    if (!schedules.get(scheduleId)) throw new ApiError(404, "Schedule not found", "NOT_FOUND");
    schedules.delete(scheduleId);
    reply.status(204).send();
  });

  app.post("/api/schedules/:scheduleId/run", async (request, reply) => {
    const { scheduleId } = request.params as { scheduleId: string };
    const schedule = schedules.get(scheduleId);
    if (!schedule) throw new ApiError(404, "Schedule not found", "NOT_FOUND");
    const taskId = crypto.randomUUID();
    tasks.createTask({ id: taskId, projectId: schedule.projectId, kind: schedule.taskKind, status: "queued", createdAt: new Date().toISOString() });
    deps.runner.run(taskId);
    reply.status(202);
    return { scheduleId, taskId, aggregateUrl: `/api/tasks/${taskId}` };
  });

  app.get("/api/projects/:projectId/skills/usage", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return skillUsage.listByProject(projectId);
  });

  app.post("/api/projects/:projectId/skills/:skillId/use", async (request, reply) => {
    const { projectId, skillId } = request.params as { projectId: string; skillId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(skillId)) throw new ApiError(400, "Invalid skill id", "VALIDATION_ERROR");
    reply.status(200);
    return skillUsage.recordUse(projectId, skillId, new Date().toISOString());
  });

  app.get("/api/projects/:projectId/memory", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return memory.listByProject(projectId);
  });

  app.post("/api/projects/:projectId/memory", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = CreateMemoryEntrySchema.parse(request.body);
    if (body.scope === "conversation") {
      if (!body.conversationId) throw new ApiError(400, "conversationId is required for conversation-scoped memory", "VALIDATION_ERROR");
      const conv = convs.getConversation(body.conversationId);
      if (!conv || conv.projectId !== projectId) throw new ApiError(404, "Conversation not found in project", "NOT_FOUND");
    }
    const entry = memory.create({
      id: crypto.randomUUID(),
      projectId,
      conversationId: body.conversationId ?? null,
      scope: body.scope,
      content: body.content,
      source: "user",
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      createdAt: new Date().toISOString(),
    });
    reply.status(201);
    return entry;
  });

  app.get("/api/conversations/:conversationId/memory", async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    const conversation = convs.getConversation(conversationId);
    if (!conversation) throw new ApiError(404, "Conversation not found", "NOT_FOUND");
    return memory.listActiveForConversation(conversation.projectId, conversationId);
  });

  app.patch("/api/memory/:id", async (request) => {
    const { id } = request.params as { id: string };
    const existing = memory.get(id);
    if (!existing) throw new ApiError(404, "Memory entry not found", "NOT_FOUND");
    const body = UpdateMemoryEntrySchema.parse(request.body);
    if (existing.projectId !== body.projectId) throw new ApiError(404, "Memory entry not found", "NOT_FOUND");
    const now = new Date().toISOString();
    let updated = existing;
    if (body.enabled !== undefined) updated = memory.setEnabled(id, body.enabled, now)!;
    if (body.pinned !== undefined) updated = memory.setPinned(id, body.pinned, now)!;
    return updated;
  });

  app.delete("/api/memory/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ projectId: z.string().min(1) }).parse(request.body);
    const existing = memory.get(id);
    if (!existing) throw new ApiError(404, "Memory entry not found", "NOT_FOUND");
    if (existing.projectId !== body.projectId) throw new ApiError(404, "Memory entry not found", "NOT_FOUND");
    const removed = memory.delete(id);
    if (!removed) throw new ApiError(404, "Memory entry not found", "NOT_FOUND");
    reply.status(204).send();
  });

  app.get("/api/onboarding", async () => {
    try {
      const rows = deps.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
      const state: Record<string, string> = {};
      for (const r of rows) {
        state[r.key] = r.value;
      }
      return {
        onboarded: state["user.onboarded"] === "true",
        onboardingStep: state["user.onboardingStep"] || null,
        useCase: state["user.useCase"] || null,
        name: state["user.name"] || null,
      };
    } catch {
      return { onboarded: false, onboardingStep: null, useCase: null, name: null };
    }
  });

  app.post("/api/onboarding", async (request) => {
    const body = z.object({
      onboarded: z.boolean().optional(),
      onboardingStep: z.string().nullable().optional(),
      useCase: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
    }).parse(request.body);

    deps.db.transaction(() => {
      const upsert = deps.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
      if (body.onboarded !== undefined) {
        upsert.run("user.onboarded", String(body.onboarded));
      }
      if (body.onboardingStep !== undefined) {
        upsert.run("user.onboardingStep", body.onboardingStep ?? "");
      }
      if (body.useCase !== undefined) {
        upsert.run("user.useCase", body.useCase ?? "");
      }
      if (body.name !== undefined) {
        upsert.run("user.name", body.name ?? "");
      }
    })();
    return { success: true };
  });

  app.post("/api/onboarding/reset", async () => {
    deps.db.prepare("DELETE FROM settings").run();
    return { success: true };
  });

  return app;
}
