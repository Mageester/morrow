import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { TaskRunner } from "../src/runner.js";
import { buildServer } from "../src/server.js";
import { buildProviderProjection } from "../src/execution/provider-projection.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";

const NOW = "2026-07-22T12:00:00.000Z";

describe("project-scoped conversation API", () => {
  let app: ReturnType<typeof buildServer>;
  let db: ReturnType<typeof openDatabase>;
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "morrow-conversations-"));
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "project-a", name: "A", workspacePath: workspace, createdAt: NOW });
    projectRepository(db).createProject({ id: "project-b", name: "B", workspacePath: workspace, createdAt: NOW });
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(workspace, { force: true, recursive: true });
  });

  async function create(title = "Durable chat") {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-a/conversations",
      payload: { title },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string };
  }

  it("creates, lists, gets, loads, renames, and archives only within the owning project", async () => {
    const conversation = await create();

    const listed = await app.inject({ method: "GET", url: "/api/projects/project-a/conversations" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([expect.objectContaining({ id: conversation.id, projectId: "project-a", title: "Durable chat" })]);

    const loaded = await app.inject({
      method: "GET",
      url: `/api/projects/project-a/conversations/${conversation.id}`,
    });
    expect(loaded.statusCode).toBe(200);

    const messages = await app.inject({
      method: "GET",
      url: `/api/projects/project-a/conversations/${conversation.id}/messages`,
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json()).toEqual([]);

    const rename = await app.inject({
      method: "PATCH",
      url: `/api/projects/project-a/conversations/${conversation.id}`,
      payload: { title: "Renamed chat" },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().title).toBe("Renamed chat");

    const replayedRename = await app.inject({
      method: "PATCH",
      url: `/api/projects/project-a/conversations/${conversation.id}`,
      payload: { title: "Renamed chat" },
    });
    expect(replayedRename.statusCode).toBe(200);
    expect(replayedRename.json().title).toBe("Renamed chat");

    const archive = await app.inject({
      method: "PATCH",
      url: `/api/projects/project-a/conversations/${conversation.id}`,
      payload: { archived: true },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().archived).toBe(true);

    const replayedArchive = await app.inject({
      method: "PATCH",
      url: `/api/projects/project-a/conversations/${conversation.id}`,
      payload: { archived: true },
    });
    expect(replayedArchive.statusCode).toBe(200);
    expect(replayedArchive.json().archived).toBe(true);

    const hidden = await app.inject({ method: "GET", url: "/api/projects/project-a/conversations" });
    expect(hidden.json()).toEqual([]);
    const archived = await app.inject({ method: "GET", url: "/api/projects/project-a/conversations?includeArchived=true" });
    expect(archived.json()).toHaveLength(1);

    for (const request of [
      { method: "GET", url: `/api/projects/project-b/conversations/${conversation.id}` },
      { method: "GET", url: `/api/projects/project-b/conversations/${conversation.id}/messages` },
      { method: "PATCH", url: `/api/projects/project-b/conversations/${conversation.id}`, payload: { title: "Stolen" } },
      { method: "PATCH", url: `/api/projects/project-b/conversations/${conversation.id}`, payload: { archived: false } },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("NOT_FOUND");
    }
  });

  it("returns canonical persisted messages with truthful routing and safe tool summaries", async () => {
    const conversation = await create();
    const tasks = taskRepository(db);
    const conversations = conversationsRepository(db);
    tasks.createTask({ id: "task-complete", projectId: "project-a", kind: "agent_chat", status: "completed", createdAt: NOW });
    conversations.appendMessage({ id: "user-message", conversationId: conversation.id, role: "user", content: "Question", createdAt: NOW, updatedAt: NOW });
    conversations.appendMessage({
      id: "assistant-message", conversationId: conversation.id, role: "assistant", content: "Canonical answer",
      taskId: "task-complete", streamingState: "completed", provider: "mock", model: "mock-model", createdAt: NOW, updatedAt: NOW,
    });
    conversations.upsertToolCall({
      id: "tool-call", messageId: "assistant-message", taskId: "task-complete", toolName: "read_file",
      argsJson: JSON.stringify({ path: "secret.txt", token: "must-not-leak" }), resultJson: "private artifact contents",
      status: "completed", createdAt: NOW, completedAt: NOW,
    });
    taskRoutingRepository(db).upsert({
      taskId: "task-complete", presetId: "balanced", providerId: "mock", model: "mock-model", useMemory: true,
      decision: {
        version: 1, presetId: "balanced", providerId: "mock", model: "mock-model", reason: "Deterministic test",
        fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "read-only", toolProfile: "read-only", autoApprove: false,
      },
      createdAt: NOW,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/project-a/conversations/${conversation.id}/messages`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(2);
    expect(body.find((entry: { id: string }) => entry.id === "assistant-message")).toMatchObject({
      id: "assistant-message",
      content: "Canonical answer",
      taskStatus: "completed",
      routing: { providerId: "mock", model: "mock-model", mode: "read-only" },
      toolActivity: [{ id: "tool-call", toolName: "read_file", status: "completed", startedAt: null, completedAt: NOW }],
    });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
    expect(JSON.stringify(body)).not.toContain("private artifact contents");
    expect(JSON.stringify(body)).not.toContain("secret.txt");
  });

  it("preserves a bounded context result when a lifecycle replay omits it", () => {
    const tasks = taskRepository(db);
    const conversations = conversationsRepository(db);
    conversations.createConversation({ id: "conversation-context-replay", projectId: "project-a", title: "Context replay", createdAt: NOW, updatedAt: NOW });
    tasks.createTask({ id: "task-context-replay", projectId: "project-a", kind: "agent_chat", status: "running", createdAt: NOW });
    conversations.appendMessage({
      id: "assistant-context-replay", conversationId: "conversation-context-replay", role: "assistant", content: "Working",
      taskId: "task-context-replay", streamingState: "streaming", createdAt: NOW, updatedAt: NOW,
    });

    const first = conversations.upsertToolCall({
      id: "context-replay-call", messageId: "assistant-context-replay", taskId: "task-context-replay", toolName: "read_file",
      argsJson: JSON.stringify({ path: "result.txt" }), resultJson: "complete-result",
      contextResultJson: JSON.stringify({ artifactId: "artifact-1", truncatedForContext: true }),
      status: "completed", createdAt: NOW, completedAt: NOW,
    });
    expect(first.contextResultJson).toContain("artifact-1");

    const omitted = conversations.upsertToolCall({
      id: "context-replay-call", messageId: "assistant-context-replay", taskId: "task-context-replay", toolName: "read_file",
      argsJson: JSON.stringify({ path: "result.txt" }), resultJson: "complete-result",
      status: "completed", createdAt: NOW, completedAt: NOW,
    });
    expect(omitted.contextResultJson).toBe(first.contextResultJson);

    const explicitNull = conversations.upsertToolCall({
      id: "context-replay-call", messageId: "assistant-context-replay", taskId: "task-context-replay", toolName: "read_file",
      argsJson: JSON.stringify({ path: "result.txt" }), resultJson: "complete-result", contextResultJson: null,
      status: "completed", createdAt: NOW, completedAt: NOW,
    });
    expect(explicitNull.contextResultJson).toBe(first.contextResultJson);
  });

  it("rolls back artifact externalization when terminal tool-call persistence fails", () => {
    const tasks = taskRepository(db);
    const conversations = conversationsRepository(db);
    conversations.createConversation({ id: "conversation-atomic-context", projectId: "project-a", title: "Atomic context", createdAt: NOW, updatedAt: NOW });
    tasks.createTask({ id: "task-atomic-context", projectId: "project-a", kind: "agent_chat", status: "running", createdAt: NOW });
    const oversized = JSON.stringify({ output: "x".repeat(20_000) });

    expect(() => conversations.upsertToolCall({
      id: "atomic-context-failure", messageId: "missing-assistant-message", taskId: "task-atomic-context", toolName: "run_command",
      argsJson: JSON.stringify({ executable: "cat", args: ["large.txt"] }), resultJson: oversized,
      status: "completed", createdAt: NOW, completedAt: NOW,
    })).toThrow();
    expect((db.prepare("SELECT COUNT(*) AS count FROM tool_artifacts WHERE task_id=?").get("task-atomic-context") as { count: number }).count).toBe(0);

    conversations.appendMessage({
      id: "assistant-atomic-context", conversationId: "conversation-atomic-context", role: "assistant", content: "Working",
      taskId: "task-atomic-context", streamingState: "streaming", createdAt: NOW, updatedAt: NOW,
    });
    const persisted = conversations.upsertToolCall({
      id: "atomic-context-success", messageId: "assistant-atomic-context", taskId: "task-atomic-context", toolName: "run_command",
      argsJson: JSON.stringify({ executable: "cat", args: ["large.txt"] }), resultJson: oversized,
      status: "completed", createdAt: NOW, completedAt: NOW,
    });
    expect(persisted.contextResultJson).toContain("artifactId");
    expect((db.prepare("SELECT COUNT(*) AS count FROM tool_artifacts WHERE task_id=?").get("task-atomic-context") as { count: number }).count).toBe(1);
  });

  it("lazily externalizes a legacy null context result before provider projection", () => {
    const tasks = taskRepository(db);
    const conversations = conversationsRepository(db);
    conversations.createConversation({ id: "conversation-legacy-context", projectId: "project-a", title: "Legacy context", createdAt: NOW, updatedAt: NOW });
    tasks.createTask({ id: "task-legacy-context", projectId: "project-a", kind: "agent_chat", status: "running", createdAt: NOW });
    conversations.appendMessage({
      id: "assistant-legacy-context", conversationId: "conversation-legacy-context", role: "assistant", content: "Working",
      taskId: "task-legacy-context", streamingState: "streaming", createdAt: NOW, updatedAt: NOW,
    });
    const oversized = JSON.stringify({ output: "legacy-output-" + "x".repeat(20_000) });
    db.prepare(`INSERT INTO message_tool_calls
      (id, message_id, task_id, tool_name, args_json, result_json, context_result_json, status, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 'completed', ?, ?)`)
      .run(
        "legacy-context-call",
        "assistant-legacy-context",
        "task-legacy-context",
        "run_command",
        JSON.stringify({ executable: "cat", args: ["large.txt"] }),
        oversized,
        NOW,
        NOW,
      );

    const materialized = conversations.materializeToolContextForTask("task-legacy-context");
    const call = materialized.find((item) => item.id === "legacy-context-call");
    expect(call?.resultJson).toBe(oversized);
    expect(call?.contextResultJson).toContain("artifactId");
    expect(call?.contextResultJson).toContain("read_artifact");
    expect(call?.contextResultJson?.length).toBeLessThan(2_000);
    expect((db.prepare("SELECT COUNT(*) AS count FROM tool_artifacts WHERE task_id=?").get("task-legacy-context") as { count: number }).count).toBe(1);

    const projection = buildProviderProjection({
      prefixMessages: [{ role: "user", content: "Continue" }],
      turns: [{
        turnKey: "legacy-turn",
        assistantText: "Reading the file.",
        toolCalls: [{ id: "legacy-context-call", name: "run_command", arguments: JSON.stringify({ executable: "cat", args: ["large.txt"] }) }],
      }],
      toolResults: [{ id: call!.id, toolName: call!.toolName, result: call!.contextResultJson!, status: "completed" }],
    });
    const toolMessage = projection.find((message) => message.role === "tool");
    expect(toolMessage?.content).toBe(call?.contextResultJson);
    expect(toolMessage?.content).not.toContain("x".repeat(8_000));
  });

  it("returns only redacted provider-supplied reasoning for a task owned by this conversation", async () => {
    const conversation = await create("Reasoning projection");
    taskRepository(db).createTask({ id: "task-reasoning", projectId: "project-a", kind: "agent_chat", status: "completed", createdAt: NOW });
    conversationsRepository(db).appendMessage({
      id: "assistant-reasoning",
      conversationId: conversation.id,
      role: "assistant",
      content: "Finished",
      taskId: "task-reasoning",
      streamingState: "completed",
      provider: "deepseek",
      model: "deepseek-reasoner",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const continuity = executionContinuityRepository(db);
    const segment = continuity.openSegment({
      taskId: "task-reasoning",
      missionId: null,
      providerId: "deepseek",
      model: "deepseek-reasoner",
      routeJson: {},
      ownerId: "worker-reasoning",
      now: NOW,
    });
    continuity.saveProviderContinuation({
      id: "continuation-reasoning",
      taskId: "task-reasoning",
      segmentId: segment.id,
      providerId: "deepseek",
      routeFingerprint: "route-reasoning",
      turnKey: "turn-1",
      state: {
        reasoningContent: "Inspect first; credential sk-abcdefghijklmnop",
        opaque: { continuation: "must-not-reach-browser" },
      },
      ownerId: "worker-reasoning",
      generation: segment.generation,
      now: NOW,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/project-a/conversations/${conversation.id}/tasks/task-reasoning/reasoning`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      version: 1,
      taskId: "task-reasoning",
      providerSupplied: true,
      entries: [{
        turnKey: "turn-1",
        providerId: "deepseek",
        content: "Inspect first; credential ***redacted***",
        createdAt: NOW,
      }],
    });
    expect(response.body).not.toContain("must-not-reach-browser");

    const foreign = await app.inject({
      method: "GET",
      url: `/api/projects/project-b/conversations/${conversation.id}/tasks/task-reasoning/reasoning`,
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("redacts tool-call JSON on writes, legacy reads, task APIs, and provider projection", async () => {
    const conversation = await create("Tool-call privacy boundaries");
    const tasks = taskRepository(db);
    const conversations = conversationsRepository(db);
    tasks.createTask({ id: "task-tool-privacy", projectId: "project-a", kind: "agent_chat", status: "running", createdAt: NOW });
    conversations.appendMessage({
      id: "assistant-tool-privacy", conversationId: conversation.id, role: "assistant", content: "Working",
      taskId: "task-tool-privacy", streamingState: "streaming", createdAt: NOW, updatedAt: NOW,
    });
    const probe = "credential sk-abcdefghijklmnop";
    const argsJson = JSON.stringify({ nested: { secret: probe }, opaque: [probe] });
    const resultJson = JSON.stringify({ output: { secret: probe } });
    conversations.upsertToolCall({
      id: "tool-privacy", messageId: "assistant-tool-privacy", taskId: "task-tool-privacy", toolName: "run_command",
      argsJson, resultJson, status: "completed", createdAt: NOW, completedAt: NOW,
    });

    const stored = db.prepare("SELECT args_json, result_json FROM message_tool_calls WHERE id=?").get("tool-privacy") as { args_json: string; result_json: string };
    expect(stored.args_json).not.toContain(probe);
    expect(stored.result_json).not.toContain(probe);
    expect(JSON.stringify(conversations.getToolCall("tool-privacy"))).not.toContain(probe);

    db.prepare("UPDATE message_tool_calls SET args_json=?, result_json=? WHERE id=?").run(argsJson, resultJson, "tool-privacy");
    const legacy = conversations.getToolCall("tool-privacy")!;
    expect(JSON.stringify(legacy)).not.toContain(probe);

    const taskResponse = await app.inject({ method: "GET", url: "/api/tasks/task-tool-privacy" });
    expect(taskResponse.statusCode).toBe(200);
    expect(JSON.stringify(taskResponse.json())).not.toContain(probe);

    const projection = buildProviderProjection({
      prefixMessages: [{ role: "user", content: "Question" }],
      turns: [{ turnKey: "legacy", assistantText: "", toolCalls: [{ id: legacy.id, name: legacy.toolName, arguments: legacy.argsJson }] }],
      toolResults: [{ id: legacy.id, toolName: legacy.toolName, result: legacy.resultJson ?? "" }],
    });
    expect(JSON.stringify(projection)).not.toContain(probe);
    expect(JSON.stringify(projection)).toContain("credential ***redacted***");
  });

  it("redacts assistant writes and legacy reads/indexes while preserving user content", async () => {
    const conversation = await create("Assistant privacy boundaries");
    const conversations = conversationsRepository(db);
    const probe = "credential sk-abcdefghijklmnop";
    const userContent = "user-searchable-content";
    conversations.appendMessage({
      id: "assistant-written-secret",
      conversationId: conversation.id,
      role: "assistant",
      content: probe,
      createdAt: NOW,
      updatedAt: NOW,
    });
    conversations.appendMessage({
      id: "user-safe-content",
      conversationId: conversation.id,
      role: "user",
      content: userContent,
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.prepare(
      `INSERT INTO conversation_messages
       (id, conversation_id, role, content, task_id, streaming_state, provider, model, created_at, updated_at)
       VALUES (?, ?, 'assistant', ?, NULL, 'completed', NULL, NULL, ?, ?)`,
    ).run("assistant-legacy-secret", conversation.id, probe, NOW, NOW);

    expect((db.prepare("SELECT content FROM conversation_messages WHERE id=?").get("assistant-written-secret") as { content: string }).content).not.toContain(probe);
    expect(conversations.getMessage("assistant-written-secret")?.content).toBe("credential ***redacted***");
    expect(conversations.getMessage("assistant-legacy-secret")?.content).toBe("credential ***redacted***");
    expect(conversations.getMessage("user-safe-content")?.content).toBe(userContent);

    const indexed = db.prepare("SELECT ref_id, body FROM search_index WHERE kind='message' AND ref_id IN (?, ?)").all("assistant-written-secret", "assistant-legacy-secret") as Array<{ ref_id: string; body: string }>;
    expect(indexed).toHaveLength(2);
    expect(JSON.stringify(indexed)).not.toContain(probe);

    const webMessages = await app.inject({ method: "GET", url: `/api/projects/project-a/conversations/${conversation.id}/messages` });
    expect(webMessages.statusCode).toBe(200);
    const messageBody = webMessages.json() as Array<{ id: string; role: string; content: string }>;
    expect(messageBody.find((message) => message.id === "assistant-written-secret")?.content).toBe("credential ***redacted***");
    expect(messageBody.find((message) => message.id === "assistant-legacy-secret")?.content).toBe("credential ***redacted***");
    expect(messageBody.find((message) => message.id === "user-safe-content")?.content).toBe(userContent);

    const searchResponse = await app.inject({ method: "GET", url: "/api/projects/project-a/search?q=credential&kind=message" });
    expect(searchResponse.statusCode).toBe(200);
    const searchBody = searchResponse.json() as { hits: Array<{ refId: string; snippet: string }> };
    for (const refId of ["assistant-written-secret", "assistant-legacy-secret"]) {
      expect(searchBody.hits.find((hit) => hit.refId === refId)?.snippet).not.toContain(probe);
    }
    expect(searchBody.hits.some((hit) => hit.refId === "user-safe-content")).toBe(false);
    db.close();
  });

  it("projects chronological durable activity without exposing raw arguments, secrets, output, or private reasoning", async () => {
    const conversation = await create("Inspect durable work");
    const tasks = taskRepository(db);
    const conversations = conversationsRepository(db);
    const records = taskRecordsRepository(db);
    tasks.createTask({
      id: "task-activity",
      projectId: "project-a",
      kind: "agent_chat",
      status: "running",
      createdAt: NOW,
      startedAt: NOW,
    });
    conversations.appendMessage({
      id: "assistant-activity",
      conversationId: conversation.id,
      role: "assistant",
      content: "Working",
      taskId: "task-activity",
      streamingState: "streaming",
      createdAt: NOW,
      updatedAt: NOW,
    });

    records.appendEvent({
      id: "activity-plan",
      taskId: "task-activity",
      type: "plan.created",
      payload: { stepCount: 3, prompt: "PRIVATE USER PROMPT" },
      createdAt: "2026-07-22T12:00:01.000Z",
    });
    records.appendEvent({
      id: "activity-tool-start",
      taskId: "task-activity",
      type: "tool.started",
      payload: {
        id: "tool-1",
        toolName: "run_command",
        target: "pnpm test --token sk-super-secret-value",
        cwd: "apps/site",
        verification: true,
        arguments: { token: "must-not-leak" },
      },
      createdAt: "2026-07-22T12:00:02.000Z",
    });
    records.appendEvent({
      id: "activity-tool-failed",
      taskId: "task-activity",
      type: "tool.failed",
      payload: {
        toolName: "run_command",
        message: "Bearer should-never-leak-through-browser",
        classification: "tool_failed",
        exitCode: 1,
      },
      createdAt: "2026-07-22T12:00:03.000Z",
    });
    records.appendEvent({
      id: "activity-tool-complete",
      taskId: "task-activity",
      type: "tool.completed",
      payload: {
        id: "tool-1",
        toolName: "run_command",
        status: "failed",
        elapsedMs: 812,
        exitCode: 1,
        summary: "stdout includes private artifact contents",
        outputRef: "private-output-reference",
      },
      createdAt: "2026-07-22T12:00:04.000Z",
    });
    records.appendEvent({
      id: "activity-recovery",
      taskId: "task-activity",
      type: "tool.strategy_switch",
      payload: {
        tool: "run_command",
        from: "repeat",
        to: "isolated_test",
        reason: "repeated_failure",
        privateReasoning: "PRIVATE CHAIN OF THOUGHT",
      },
      createdAt: "2026-07-22T12:00:05.000Z",
    });
    records.appendEvent({
      id: "activity-evidence",
      taskId: "task-activity",
      type: "evidence.persisted",
      payload: {
        action: "patched",
        path: "src/app.ts",
        deltaText: "PRIVATE MODEL OUTPUT",
      },
      createdAt: "2026-07-22T12:00:06.000Z",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/project-a/conversations/${conversation.id}/activity`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      version: 1,
      projectId: "project-a",
      conversationId: conversation.id,
      // No plan entry: activity-projection.ts deliberately drops task and plan
      // lifecycle ("durable audit data, not chat activity") as of the compact
      // activity rail in d4f8059. This assertion still described the pre-refactor
      // shape and had been failing on the branch ever since; the redaction
      // assertions below — the actual subject of this test — never stopped
      // passing.
      entries: [
        {
          id: "task-activity:tool:tool-1",
          kind: "command",
          status: "failed",
          summary: "Ran pnpm test --token [redacted] — failed",
          detail: "Working directory: apps/site",
          target: "pnpm test --token [redacted]",
          durationMs: 812,
          exitCode: 1,
        },
        {
          kind: "recovery",
          status: "completed",
          summary: "Recovery strategy changed",
        },
        {
          kind: "file",
          status: "completed",
          summary: "File modified",
          target: "src/app.ts",
        },
      ],
    });
    const serialized = response.body;
    for (const privateValue of [
      "PRIVATE USER PROMPT",
      "sk-super-secret-value",
      "must-not-leak",
      "should-never-leak",
      "private artifact contents",
      "private-output-reference",
      "PRIVATE CHAIN OF THOUGHT",
      "PRIVATE MODEL OUTPUT",
      "arguments",
      "privateReasoning",
      "deltaText",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }

    const foreign = await app.inject({
      method: "GET",
      url: `/api/projects/project-b/conversations/${conversation.id}/activity`,
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("exports support summaries without raw events, tool payloads, or private reasoning", async () => {
    const conversation = await create("Support evidence");
    const tasks = taskRepository(db);
    const conversations = conversationsRepository(db);
    const records = taskRecordsRepository(db);
    const routing = taskRoutingRepository(db);
    tasks.createTask({ id: "task-support", projectId: "project-a", kind: "agent_chat", status: "completed", createdAt: NOW });
    conversations.appendMessage({
      id: "assistant-support",
      conversationId: conversation.id,
      role: "assistant",
      content: "Done",
      taskId: "task-support",
      streamingState: "completed",
      createdAt: NOW,
      updatedAt: NOW,
    });
    records.appendEvent({
      id: "support-tool",
      taskId: "task-support",
      type: "tool.completed",
      payload: { id: "tool-support", toolName: "run_command", exitCode: 0, privateReasoning: "do not export" },
      createdAt: NOW,
    });
    records.upsertDisclosure({
      taskId: "task-support",
      executionMode: "agent-interactive",
      provider: "mock",
      networkAccess: "disabled",
      filesystemAccess: "workspace-write",
      shellExecution: true,
      modelInvocation: true,
      workspaceScope: "project workspace",
      estimatedCostUsd: "0",
      createdAt: NOW,
      updatedAt: NOW,
    });
    routing.upsert({
      taskId: "task-support",
      presetId: "balanced",
      providerId: "mock",
      model: "mock-model",
      useMemory: false,
      createdAt: NOW,
      decision: {
        version: 1,
        presetId: "balanced",
        providerId: "mock",
        model: "mock-model",
        reason: "support test",
        fallbackUsed: false,
        overridden: false,
        privacy: "local-only",
        privacyMode: "local_only",
        candidates: [],
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/project-a/conversations/${conversation.id}/support-bundle`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      version: 1,
      projectId: "project-a",
      conversationId: conversation.id,
      tasks: [{ taskId: "task-support", providerId: "mock", model: "mock-model", privacyMode: "local_only", disclosure: { networkAccess: "disabled" } }],
    });
    expect(response.body).not.toContain("privateReasoning");
    expect(response.body).not.toContain("support test");
  });

  it.each(["failed", "interrupted"] as const)("retries a %s response after its prior terminal cursor", async (terminalState) => {
    const conversation = await create(`${terminalState} retry`);
    const tasks = taskRepository(db);
    const conversations = conversationsRepository(db);
    const records = taskRecordsRepository(db);
    tasks.createTask({ id: `task-${terminalState}`, projectId: "project-a", kind: "agent_chat", status: "running", createdAt: NOW, startedAt: NOW });
    conversations.appendMessage({
      id: `assistant-${terminalState}`,
      conversationId: conversation.id,
      role: "assistant",
      content: "Prior attempt",
      taskId: `task-${terminalState}`,
      streamingState: terminalState,
      createdAt: NOW,
      updatedAt: NOW,
    });
    records.transitionAgentState(`task-${terminalState}`, { id: `idle-${terminalState}`, state: "idle", details: {}, createdAt: NOW });
    records.transitionAgentState(`task-${terminalState}`, { id: `state-${terminalState}`, state: terminalState, details: {}, createdAt: NOW });
    records.transitionTask(`task-${terminalState}`, terminalState, { id: `terminal-${terminalState}`, payload: {}, createdAt: NOW });
    const priorCursor = records.listEvents(`task-${terminalState}`).at(-1)!.sequence;

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/project-a/conversations/${conversation.id}/tasks/task-${terminalState}/retry`,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      version: 1,
      taskId: `task-${terminalState}`,
      status: "queued",
      outcome: "retried",
      afterCursor: priorCursor,
    });
    expect(tasks.getTaskById(`task-${terminalState}`)?.status).toBe("queued");
    expect(conversations.getMessage(`assistant-${terminalState}`)).toMatchObject({ content: "", streamingState: "queued" });
  });

  it("requires explicit confirmation, rejects deletion while a related task is active, and deletes dependents without deleting tasks or projects", async () => {
    const conversation = await create("Delete me");
    const other = await create("Keep me");
    const tasks = taskRepository(db);
    const conversations = conversationsRepository(db);
    tasks.createTask({ id: "active-task", projectId: "project-a", kind: "agent_chat", status: "running", createdAt: NOW });
    conversations.appendMessage({ id: "assistant-active", conversationId: conversation.id, role: "assistant", content: "Working", taskId: "active-task", streamingState: "streaming", createdAt: NOW, updatedAt: NOW });

    const unconfirmed = await app.inject({
      method: "DELETE", url: `/api/projects/project-a/conversations/${conversation.id}`, payload: {},
    });
    expect(unconfirmed.statusCode).toBe(400);

    const foreign = await app.inject({
      method: "DELETE", url: `/api/projects/project-b/conversations/${conversation.id}`, payload: { confirmation: "delete" },
    });
    expect(foreign.statusCode).toBe(404);

    const active = await app.inject({
      method: "DELETE", url: `/api/projects/project-a/conversations/${conversation.id}`, payload: { confirmation: "delete" },
    });
    expect(active.statusCode).toBe(409);
    expect(active.json().error.code).toBe("CONVERSATION_TASK_ACTIVE");
    expect(conversations.getConversation(conversation.id)).toBeDefined();

    taskRepository(db).updateTaskStatus("active-task", { status: "completed", updatedAt: NOW, completedAt: NOW });
    conversations.upsertToolCall({
      id: "dependent-tool", messageId: "assistant-active", taskId: "active-task", toolName: "read_file",
      argsJson: "{}", resultJson: "{}", status: "completed", createdAt: NOW, completedAt: NOW,
    });

    const deleted = await app.inject({
      method: "DELETE", url: `/api/projects/project-a/conversations/${conversation.id}`, payload: { confirmation: "delete" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ version: 1, conversationId: conversation.id, deleted: true });
    expect(conversations.getConversation(conversation.id)).toBeUndefined();
    expect(conversations.getMessage("assistant-active")).toBeUndefined();
    expect(conversations.getToolCall("dependent-tool")).toBeUndefined();
    expect(tasks.getTaskById("active-task")).toBeDefined();
    expect(projectRepository(db).getProjectById("project-a")).toBeDefined();
    expect(conversations.getConversation(other.id)).toBeDefined();

    const replay = await app.inject({
      method: "DELETE", url: `/api/projects/project-a/conversations/${conversation.id}`, payload: { confirmation: "delete" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ version: 1, conversationId: conversation.id, deleted: false });
  });

  it("exposes route-aware context diagnostics, confidence, and the applied reasoning wire config on task detail", async () => {
    const tasks = taskRepository(db);
    tasks.createTask({ id: "task-capability", projectId: "project-a", kind: "agent_chat", status: "completed", createdAt: NOW });
    taskRoutingRepository(db).upsert({
      taskId: "task-capability",
      presetId: "balanced",
      providerId: "gemini",
      model: "gemini-3.7-flash",
      useMemory: false,
      createdAt: NOW,
      decision: {
        version: 1,
        presetId: "balanced",
        providerId: "gemini",
        model: "gemini-3.7-flash",
        reason: "user override",
        fallbackUsed: false,
        overridden: true,
        privacy: "cloud",
        candidates: [{ providerId: "gemini", configured: true, reason: "selected" }],
        reasoning: { mode: "effort", effort: "high" },
      },
    });
    taskRecordsRepository(db).appendEvent({
      id: "event-budget", taskId: "task-capability", type: "context.budget_calculated", createdAt: NOW,
      payload: {
        provider: "gemini", model: "gemini-3.7-flash", contextWindowTokens: 1_000_000,
        contextWindowConfidence: "verified", contextWindowSource: "model-metadata",
        nativeContextWindowTokens: 1_000_000, nativeContextWindowSource: "model-metadata",
        routeLimitTokens: null, routeLimitSource: "unknown",
        effectiveContextWindowTokens: 1_000_000, harnessReserveTokens: 1_536, totalReserveTokens: 3_584,
        currentModelVisibleTokens: 12_000, currentRequestTokens: 12_000, remainingInputTokens: 978_000,
        compactionThresholdTokens: 800_000, compactionThresholdRatio: 0.8, usableInputTokens: 990_000,
      },
    });
    taskRecordsRepository(db).appendEvent({
      id: "event-request", taskId: "task-capability", type: "provider.request_started", createdAt: NOW,
      payload: {
        provider: "gemini", model: "gemini-3.7-flash",
        reasoningRequested: { mode: "effort", effort: "high" },
        reasoningApplied: { mode: "effort", effort: "high" },
        reasoningSupported: true,
        reasoningWireParams: { thinkingConfig: { thinkingLevel: "HIGH" } },
        reasoningControl: "effort", reasoningSource: "provider-catalog", reasoningWire: "gemini-thinking-level",
        reasoningSupportsOff: false,
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/tasks/task-capability" });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.context).toMatchObject({
      contextWindowConfidence: "verified",
      nativeContextWindowTokens: 1_000_000,
      nativeContextWindowSource: "model-metadata",
      effectiveContextWindowTokens: 1_000_000,
      harnessReserveTokens: 1_536,
      compactionThresholdTokens: 800_000,
      compactionThresholdRatio: 0.8,
      remainingInputTokens: 978_000,
    });
    expect(body.routing).toMatchObject({
      providerId: "gemini", model: "gemini-3.7-flash", fallbackUsed: false,
      reasoning: { mode: "effort", effort: "high" },
    });
    expect(body.reasoningApplication).toMatchObject({
      applied: { mode: "effort", effort: "high" },
      supported: true,
      wireParams: { thinkingConfig: { thinkingLevel: "HIGH" } },
      wire: "gemini-thinking-level",
      fallbackToRouteDefault: false,
    });
  });
});
