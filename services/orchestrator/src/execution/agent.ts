import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { inspectWorkspace, type WorkspaceEntry } from "../workspace/inspector.js";
import { readWorkspaceFile, SafeReadError } from "../workspace/safe-reader.js";
import { projectRepository } from "../repositories/projects.js";
import { taskRepository } from "../repositories/tasks.js";
import { taskRecordsRepository } from "../repositories/task-records.js";
import { conversationsRepository, type ToolCallRecord } from "../repositories/conversations.js";
import { AiProvider, ChatMessage, ToolDefinition, ProviderChunk } from "../provider/base.js";
import { OpenAiProvider } from "../provider/openai.js";
import { MockProvider } from "../provider/mock.js";

type Dependencies = {
  db: Database.Database;
  taskId: string;
  provider?: AiProvider;
  now?: () => string;
  maxTurns?: number;
  maxFileBytes?: number;
  maxContextBytes?: number;
  abortSignal?: AbortSignal;
};

export async function executeAgentChatTask({
  db,
  taskId,
  provider,
  now = () => new Date().toISOString(),
  maxTurns = 5,
  maxFileBytes = 102400, // 100 KB
  maxContextBytes = 512000, // 500 KB
  abortSignal
}: Dependencies): Promise<void> {
  const projects = projectRepository(db);
  const tasks = taskRepository(db);
  const records = taskRecordsRepository(db);
  const convs = conversationsRepository(db);

  const task = tasks.getTaskById(taskId);
  if (!task || task.kind !== "agent_chat" || task.status !== "queued") {
    throw new Error("Task is not available for agent execution");
  }

  const project = projects.getProjectById(task.projectId);
  if (!project) {
    throw new Error("Project not found");
  }

  // Find the assistant message associated with this task
  const allMessages = db.prepare("SELECT * FROM conversation_messages WHERE task_id = ?").all(taskId);
  if (allMessages.length === 0) {
    throw new Error("Assistant message not found for task");
  }
  const assistantMessageRow = allMessages[0] as any;
  const conversationId = assistantMessageRow.conversation_id;

  const event = (type: Parameters<typeof records.appendEvent>[0]["type"], payload: Record<string, unknown> = {}) => {
    return records.appendEvent({ id: randomUUID(), taskId, type, payload, createdAt: now() });
  };

  // Define plan
  const plan = [
    { id: randomUUID(), position: 1, title: "Analyze & Plan", description: "Understand request and determine necessary workspace inspection tools.", status: "pending" as const },
    { id: randomUUID(), position: 2, title: "Read Workspace", description: "Inspect project structure and read relevant files.", status: "pending" as const },
    { id: randomUUID(), position: 3, title: "Generate Answer", description: "Synthesize findings and stream response to user.", status: "pending" as const }
  ];
  records.replacePlan(taskId, plan);
  event("plan.created", { stepCount: plan.length });

  // Resolve active provider
  const activeProvider = provider || (process.env.MOCK_PROVIDER === "true" ? new MockProvider({
    chunks: [
      // Turn 0: LLM decides to inspect files
      [
        {
          type: "tool_call",
          toolCalls: [
            {
              id: "call-1",
              index: 0,
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "evidence.txt" }) }
            }
          ]
        },
        { type: "done" }
      ],
      // Turn 1: LLM answers based on tool call
      [
        { type: "text", text: "Based on the evidence, the system is fully operational." },
        { type: "done" }
      ]
    ],
    delayMs: 150
  }) : new OpenAiProvider());
  const providerType = activeProvider.constructor.name === "MockProvider" ? "mock" as const : "openai" as const;

  // Enforce disclosure
  records.upsertDisclosure({
    taskId,
    executionMode: "agent-interactive",
    provider: providerType,
    networkAccess: providerType === "mock" ? "disabled" : "enabled",
    filesystemAccess: "read-only",
    shellExecution: false,
    modelInvocation: true,
    workspaceScope: project.workspacePath,
    estimatedCostUsd: "$0.00",
    createdAt: now(),
    updatedAt: now()
  });

  // Check if provider is configured
  if (providerType === "openai" && !process.env.OPENAI_API_KEY) {
    records.transitionTask(taskId, "failed", { id: randomUUID(), createdAt: now(), payload: { message: "No AI provider configured" } });
    convs.updateMessageContentAndState(assistantMessageRow.id, "No AI provider configured. Please set the OPENAI_API_KEY environment variable.", "failed", now());
    event("task.failed", { message: "No AI provider configured" });
    return;
  }

  records.transitionTask(taskId, "running", { id: randomUUID(), createdAt: now(), payload: {} });
  convs.updateMessageContentAndState(assistantMessageRow.id, "", "streaming", now());

  // Setup tools definitions
  const tools: ToolDefinition[] = [
    {
      name: "inspect_workspace",
      description: "Recursively lists all files in the project workspace. Returns a list of relative file paths and sizes.",
      parameters: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "list_files",
      description: "Lists directory contents (files and subdirectories) relative to the workspace root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative directory path (e.g. '.' or 'src')" }
        },
        required: ["path"]
      }
    },
    {
      name: "read_file",
      description: "Reads the content of a specific source or text file in the workspace. Rejects secret files, binary formats, or files exceeding 100 KB.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path (e.g. 'package.json')" }
        },
        required: ["path"]
      }
    }
  ];

  // Load conversation messages before this task's assistant message
  const chatMessages: ChatMessage[] = [];
  const dbMessages = convs.listMessages(conversationId);
  
  // System instructions
  chatMessages.push({
    role: "system",
    content: `You are Morrow, a secure personal AI coding assistant.
You are running in a read-only environment scoped to the project: ${project.name} located at ${project.workspacePath}.
You have access to safe read-only tools to inspect the workspace and read files.
You MUST choose relevant files, do NOT automatically ingest the entire repository.
If you need to explore, first call inspect_workspace or list_files, then call read_file on selected files.
You are forbidden from writing files, executing shell commands, or accessing external networks besides your provider.`
  });

  for (const msg of dbMessages) {
    if (msg.id === assistantMessageRow.id) break;
    chatMessages.push({
      role: msg.role === "user" ? "user" : "assistant",
      content: msg.content
    });
  }

  let turn = 0;
  let totalBytesRead = 0;
  let responseContent = "";
  const steps = records.listPlanSteps(taskId);

  let activeStepId = steps[0]!.id; // Start with "Analyze & Plan"
  records.updatePlanStepStatus(activeStepId, "running", now());
  event("step.started", { stepId: activeStepId });

  // Handle AbortSignal cancellation
  const checkCancelled = (): boolean => {
    if (abortSignal?.aborted || tasks.getTaskById(taskId)?.status === "cancelled") {
      return true;
    }
    return false;
  };

  const handleCancellation = () => {
    const currentTask = tasks.getTaskById(taskId);
    if (currentTask && currentTask.status !== "cancelled") {
      records.transitionTask(taskId, "cancelled", { id: randomUUID(), createdAt: now(), payload: {} });
    }
    convs.updateMessageContentAndState(assistantMessageRow.id, responseContent, "cancelled", now());
    if (activeStepId) {
      records.updatePlanStepStatus(activeStepId, "failed", now());
    }
    const existingEvents = records.listEvents(taskId);
    if (!existingEvents.some(ev => ev.type === "task.cancelled")) {
      event("task.cancelled", {});
    }
  };

  while (turn < maxTurns) {
    if (checkCancelled()) {
      handleCancellation();
      return;
    }

    turn++;
    let hasToolCalls = false;
    const currentToolCalls: any[] = [];

    try {
      const stream = activeProvider.streamChat(chatMessages, {
        ...(abortSignal ? { abortSignal } : {}),
        tools,
        model: assistantMessageRow.model || "gpt-4o-mini"
      });

      for await (const chunk of stream) {
        if (checkCancelled()) {
          handleCancellation();
          return;
        }

        if (chunk.type === "error") {
          throw new Error(chunk.error?.message || "Model provider error");
        }

        if (chunk.type === "text" && chunk.text) {
          // If we transitioned to generating final text, mark Generate Answer as running
          if (activeStepId !== steps[2]!.id) {
            records.updatePlanStepStatus(activeStepId, "completed", now());
            event("step.completed", { stepId: activeStepId });
            activeStepId = steps[2]!.id;
            records.updatePlanStepStatus(activeStepId, "running", now());
            event("step.started", { stepId: activeStepId });
          }

          responseContent += chunk.text;
          convs.updateMessageContentAndState(assistantMessageRow.id, responseContent, "streaming", now());
          
          // Emit a live streaming text update event
          event("evidence.persisted", { deltaText: chunk.text });
        }

        if (chunk.type === "tool_call" && chunk.toolCalls) {
          hasToolCalls = true;
          for (const tc of chunk.toolCalls) {
            const index = tc.index !== undefined ? tc.index : 0;
            if (!currentToolCalls[index]) {
              currentToolCalls[index] = { id: "", name: "", arguments: "" };
            }
            if (tc.id) currentToolCalls[index].id = tc.id;
            if (tc.function?.name) currentToolCalls[index].name = tc.function.name;
            if (tc.function?.arguments) {
              currentToolCalls[index].arguments += tc.function.arguments;
            }
          }
        }
      }
    } catch (e: any) {
      console.error("Provider stream error", e);
      const errMessage = e.message || "Failed to query AI provider";
      records.transitionTask(taskId, "failed", { id: randomUUID(), createdAt: now(), payload: { message: errMessage } });
      convs.updateMessageContentAndState(assistantMessageRow.id, responseContent + `\n\n[Error: ${errMessage}]`, "failed", now());
      if (activeStepId) {
        records.updatePlanStepStatus(activeStepId, "failed", now());
      }
      event("task.failed", { message: errMessage });
      return;
    }

    if (checkCancelled()) {
      handleCancellation();
      return;
    }

    if (hasToolCalls && currentToolCalls.length > 0) {
      // Transition step to Read Workspace
      if (activeStepId !== steps[1]!.id) {
        records.updatePlanStepStatus(activeStepId, "completed", now());
        event("step.completed", { stepId: activeStepId });
        activeStepId = steps[1]!.id;
        records.updatePlanStepStatus(activeStepId, "running", now());
        event("step.started", { stepId: activeStepId });
      }

      const toolOutputs: ChatMessage[] = [];

      // Append assistant message with tool calls to prompt history
      chatMessages.push({
        role: "assistant",
        content: responseContent,
        toolCalls: currentToolCalls.map(tc => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments }
        }))
      });

      for (const tc of currentToolCalls) {
        if (!tc.id || !tc.name) continue;

        // Persist tool call state
        const toolCallRecord = convs.upsertToolCall({
          id: tc.id,
          messageId: assistantMessageRow.id,
          taskId,
          toolName: tc.name,
          argsJson: tc.arguments,
          status: "running",
          createdAt: now(),
          startedAt: now()
        });

        let resultStr = "";
        let isSuccess = true;
        let errorType = null;
        let errorMessage = null;

        try {
          let args: any = {};
          try {
            args = JSON.parse(tc.arguments || "{}");
          } catch {
            throw new Error("Invalid tool arguments format");
          }

          if (tc.name === "inspect_workspace") {
            const res = inspectWorkspace(project.workspacePath, { maxDepth: 8, maxResults: 500 });
            resultStr = JSON.stringify({
              entries: res.entries.map(e => ({ path: e.path, size: e.size })),
              truncatedByDepth: res.truncatedByDepth,
              truncatedByCount: res.truncatedByCount
            });
            event("workspace.inspected", { resultCount: res.entries.length });
          } else if (tc.name === "list_files") {
            const relPath = args.path || ".";
            const res = inspectWorkspace(project.workspacePath, { startPath: relPath, maxDepth: 1, maxResults: 100 });
            resultStr = JSON.stringify({
              entries: res.entries.map(e => ({ path: e.path, size: e.size })),
              truncatedByCount: res.truncatedByCount
            });
            event("workspace.inspected", { path: relPath, resultCount: res.entries.length });
          } else if (tc.name === "read_file") {
            const relPath = args.path;
            if (!relPath) throw new Error("Missing required argument: path");
            
            const fileData = readWorkspaceFile(project.workspacePath, relPath, maxFileBytes);
            totalBytesRead += fileData.size;

            if (totalBytesRead > maxContextBytes) {
              throw new SafeReadError(`Raw byte budget ceiling (${maxContextBytes / 1024} KB) exceeded`);
            }

            resultStr = fileData.content;
            
            // Record task evidence for right inspector
            records.appendEvidence({
              id: randomUUID(),
              taskId,
              type: "file",
              path: fileData.path,
              metadata: { size: fileData.size },
              createdAt: now()
            });

            event("evidence.persisted", { path: fileData.path, size: fileData.size });
          } else {
            throw new Error(`Forbidden tool: ${tc.name}`);
          }
        } catch (err: any) {
          isSuccess = false;
          errorType = err instanceof SafeReadError ? "safe_read_rejected" : "tool_failed";
          errorMessage = err.message || "Unknown error";
          resultStr = JSON.stringify({ error: errorMessage });
          event("task.failed", { toolName: tc.name, message: errorMessage });
        }

        // Complete tool call record
        convs.upsertToolCall({
          ...toolCallRecord,
          status: isSuccess ? "completed" : "failed",
          resultJson: resultStr,
          errorType,
          errorMessage,
          completedAt: now()
        });

        chatMessages.push({
          role: "tool",
          name: tc.name,
          toolCallId: tc.id,
          content: resultStr
        });
      }
    } else {
      // No more tool calls, we're done
      break;
    }
  }

  if (checkCancelled()) {
    handleCancellation();
    return;
  }

  if (turn >= maxTurns) {
    const loopErrMsg = `Agent turn loop limit reached (${maxTurns})`;
    records.transitionTask(taskId, "failed", { id: randomUUID(), createdAt: now(), payload: { message: loopErrMsg } });
    convs.updateMessageContentAndState(assistantMessageRow.id, responseContent + `\n\n[Error: ${loopErrMsg}]`, "failed", now());
    if (activeStepId) {
      records.updatePlanStepStatus(activeStepId, "failed", now());
    }
    event("task.failed", { message: loopErrMsg });
    return;
  }

  // Complete plan steps
  records.updatePlanStepStatus(activeStepId, "completed", now());
  event("step.completed", { stepId: activeStepId });

  // Make sure all steps are complete
  for (const step of steps) {
    if (step.status !== "completed") {
      records.updatePlanStepStatus(step.id, "completed", now());
    }
  }

  // Final transition to completed
  records.transitionTask(taskId, "completed", { id: randomUUID(), createdAt: now(), payload: {} });
  convs.updateMessageContentAndState(assistantMessageRow.id, responseContent, "completed", now());
  event("task.completed", {});
}
