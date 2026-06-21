import { z } from "zod";
import Fastify, { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import {
  CreateProjectSchema,
  CreateTaskSchema,
  StructuredApiErrorSchema,
  SendMessageSchema,
  CreateMemoryEntrySchema,
  UpdateConversationSchema,
  ApprovalStatusSchema,
  ResolveApprovalSchema,
  ProviderIdSchema,
  type PresetId,
  type ProviderId,
  type RoutingDecision,
} from "@morrow/contracts";
import { openDatabase } from "./database.js";
import { realpathSync, existsSync, lstatSync } from "node:fs";
import { projectRepository } from "./repositories/projects.js";
import { taskRepository } from "./repositories/tasks.js";
import { taskRecordsRepository } from "./repositories/task-records.js";
import { conversationsRepository } from "./repositories/conversations.js";
import { taskRoutingRepository } from "./repositories/task-routing.js";
import { memoryRepository } from "./repositories/memory.js";
import { approvalsRepository } from "./repositories/approvals.js";
import { recoverRunningTasks } from "./recovery.js";
import { TaskRunner } from "./runner.js";
import { listProviderStatuses } from "./provider/registry.js";
import { OAUTH_FINDINGS } from "./provider/oauth.js";
import { listModels } from "./routing/models.js";
import { listPresets, getPreset, isPresetId, DEFAULT_PRESET_ID } from "./routing/presets.js";
import { routePreset, listPresetStatuses } from "./routing/router.js";
import { testProviderConnectivity } from "./provider/connectivity.js";
import { TOOL_CATALOG, PERMISSION_PROFILE } from "./tools/catalog.js";

export class ApiError extends Error {
  constructor(public statusCode: number, message: string, public code: string = "INTERNAL_ERROR") {
    super(message);
    this.name = "ApiError";
  }
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
};

export function buildServer(deps: ServerDependencies): FastifyInstance {
  const app = Fastify({ logger: false });

  const projects = projectRepository(deps.db);
  const tasks = taskRepository(deps.db);
  const records = taskRecordsRepository(deps.db);
  const convs = conversationsRepository(deps.db);
  const routingRepo = taskRoutingRepository(deps.db);
  const memory = memoryRepository(deps.db);
  const approvals = approvalsRepository(deps.db);

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

  app.post("/api/projects/:projectId/tasks/inspect-workspace", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");

    const task = tasks.createTask({
      id: crypto.randomUUID(),
      projectId,
      kind: "inspect_workspace",
      status: "queued",
      createdAt: new Date().toISOString()
    });

    deps.runner.run(task.id);
    reply.status(202);
    return {
      taskId: task.id,
      projectId,
      status: task.status,
      aggregateUrl: `/api/tasks/${task.id}`,
      eventHistoryUrl: `/api/tasks/${task.id}/events`,
      sseUrl: `/api/tasks/${task.id}/events/stream`
    };
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
    const mode = body.mode ?? "read-only";
    const toolProfile = mode === "plan-only" ? "none" : "read-only";

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
      decision = { ...decision, mode, toolProfile };
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

  app.post("/api/tasks/:taskId/cancel", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");
    
    deps.runner.cancel(taskId);
    reply.status(204).send();
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

  app.post("/api/approvals/:approvalId/resolve", async (request) => {
    const { approvalId } = request.params as { approvalId: string };
    const body = ResolveApprovalSchema.parse(request.body);
    const approval = approvals.get(approvalId);
    if (!approval || approval.projectId !== body.projectId) throw new ApiError(404, "Approval not found in project", "NOT_FOUND");

    const resolved = approvals.resolve(approvalId, { decision: body.decision, ...(body.note ? { note: body.note } : {}), resolvedAt: new Date().toISOString() });
    if (!resolved) throw new ApiError(409, "Approval is no longer pending", "APPROVAL_ALREADY_RESOLVED");
    if (body.decision === "trust_project") {
      approvals.grantCommandTrust({ projectId: approval.projectId, pattern: body.trustPattern!, createdAt: resolved.resolvedAt! });
    }
    records.appendEvent({
      id: crypto.randomUUID(),
      taskId: approval.taskId,
      type: "approval.resolved",
      payload: { approvalId, decision: body.decision },
      createdAt: resolved.resolvedAt!,
    });
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
    const body = z.object({ projectId: z.string().min(1), enabled: z.boolean() }).parse(request.body);
    if (existing.projectId !== body.projectId) throw new ApiError(404, "Memory entry not found", "NOT_FOUND");
    return memory.setEnabled(id, body.enabled, new Date().toISOString());
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

  return app;
}
