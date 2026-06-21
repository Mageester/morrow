import { z } from "zod";
import Fastify, { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import {
  CreateProjectSchema,
  CreateTaskSchema,
  StructuredApiErrorSchema,
  SendMessageSchema,
  CreateMemoryEntrySchema,
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
import { recoverRunningTasks } from "./recovery.js";
import { TaskRunner } from "./runner.js";
import { listProviderStatuses } from "./provider/registry.js";
import { OAUTH_FINDINGS } from "./provider/oauth.js";
import { listModels } from "./routing/models.js";
import { listPresets, getPreset, isPresetId, DEFAULT_PRESET_ID } from "./routing/presets.js";
import { routePreset, listPresetStatuses } from "./routing/router.js";

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
    return { ...agg, toolCalls, routing };
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
    return convs.listConversationsByProject(projectId);
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
    const body = z.object({ enabled: z.boolean() }).parse(request.body);
    return memory.setEnabled(id, body.enabled, new Date().toISOString());
  });

  app.delete("/api/memory/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = memory.delete(id);
    if (!removed) throw new ApiError(404, "Memory entry not found", "NOT_FOUND");
    reply.status(204).send();
  });

  return app;
}
