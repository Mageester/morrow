import { z } from "zod";
import Fastify, { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { CreateProjectSchema, CreateTaskSchema, StructuredApiErrorSchema } from "@morrow/contracts";
import { openDatabase } from "./database.js";
import { realpathSync, existsSync, lstatSync } from "node:fs";
import { projectRepository } from "./repositories/projects.js";
import { taskRepository } from "./repositories/tasks.js";
import { taskRecordsRepository } from "./repositories/task-records.js";
import { conversationsRepository } from "./repositories/conversations.js";
import { recoverRunningTasks } from "./recovery.js";
import { TaskRunner } from "./runner.js";

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
    return { ...agg, toolCalls };
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
    
    const body = request.body as { content: string; preset?: "Balanced" | "Fast" | "Private Local" } | null;
    if (!body || !body.content?.trim()) {
      throw new ApiError(400, "Message content is required", "VALIDATION_ERROR");
    }

    const preset = body.preset || "Balanced";
    if (preset === "Private Local") {
      throw new ApiError(400, "Private Local preset is not available because a local provider is not configured", "PRESET_UNAVAILABLE");
    }

    const timestamp = new Date().toISOString();
    
    const userMsg = convs.appendMessage({
      id: crypto.randomUUID(),
      conversationId,
      role: "user",
      content: body.content,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    const task = tasks.createTask({
      id: crypto.randomUUID(),
      projectId: conversation.projectId,
      kind: "agent_chat",
      status: "queued",
      createdAt: timestamp
    });

    const assistantMsg = convs.appendMessage({
      id: crypto.randomUUID(),
      conversationId,
      role: "assistant",
      content: "",
      taskId: task.id,
      streamingState: "queued",
      provider: "openai",
      model: preset === "Fast" ? "gpt-4o-mini" : "gpt-4o-mini",
      createdAt: new Date(Date.now() + 50).toISOString(),
      updatedAt: new Date(Date.now() + 50).toISOString()
    });

    deps.runner.run(task.id);

    reply.status(202);
    return {
      task,
      userMessage: userMsg,
      assistantMessage: assistantMsg,
      aggregateUrl: `/api/tasks/${task.id}`,
      sseUrl: `/api/tasks/${task.id}/events/stream`
    };
  });

  app.post("/api/tasks/:taskId/cancel", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");
    
    deps.runner.cancel(taskId);
    reply.status(204).send();
  });

  app.get("/api/provider/status", async (request, reply) => {
    const isMock = process.env.MOCK_PROVIDER === "true";
    const hasKey = !!process.env.OPENAI_API_KEY;
    return {
      configured: isMock || hasKey,
      provider: isMock ? "mock" : "openai",
      model: isMock ? "mock-model" : "gpt-4o-mini"
    };
  });

  return app;
}
