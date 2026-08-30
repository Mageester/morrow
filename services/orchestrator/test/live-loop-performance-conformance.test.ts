import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { contextSummariesRepository } from "../src/repositories/context-summaries.js";
import { memoryRepository } from "../src/repositories/memory.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { MissionService } from "../src/mission/service.js";
import { MockProvider } from "../src/provider/mock.js";
import type { ProviderChunk } from "../src/provider/base.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import {
  MAX_EXECUTION_CHECKPOINT_BYTES,
  projectCheckpointSnapshot,
} from "../src/execution/checkpoint-snapshot.js";
import { projectProviderRequest } from "../src/execution/provider-projection.js";
import { resolveModelBudget } from "../src/routing/model-budget.js";

const NOW = "2026-08-02T12:00:00.000Z";

function baseCheckpointSnapshot(taskId: string) {
  return {
    version: 1 as const,
    originalMission: "Build the requested artifact.",
    hardRequirements: ["deliver the artifact"],
    prohibitedActions: ["do not expose secrets"],
    acceptanceCriteria: ["the artifact exists"],
    decisions: ["use the smallest safe change"],
    completedWork: [],
    currentPhase: "working",
    filesChanged: [],
    gitStatus: "",
    tests: [],
    unresolvedFailures: [],
    recoveryAttempts: [],
    pendingWork: ["finish the artifact"],
    approvals: {},
    taskId,
    missionId: null,
    providerRouting: { providerId: "mock", model: "mock-model" },
    providerContinuationRefs: [],
    evidenceRequired: ["artifact evidence"],
  };
}

function seedArtifactTask(db: Database.Database, workspacePath: string, options: {
  conversationPrompt?: string;
  missionObjective?: string;
  useMemory?: boolean;
} = {}): void {
  const projects = projectRepository(db);
  const tasks = taskRepository(db);
  const conversations = conversationsRepository(db);
  projects.createProject({ id: "project-1", name: "Performance", workspacePath, createdAt: NOW });
  const missionId = options.missionObjective
    ? new MissionService({
        repo: missionsRepository(db),
        getWorkspacePath: () => workspacePath,
        backupDir: join(workspacePath, ".morrow-checkpoints"),
      }).create("project-1", { objective: options.missionObjective }).id
    : undefined;
  conversations.createConversation({ id: "conversation-1", projectId: "project-1", title: "Performance", createdAt: NOW, updatedAt: NOW });
  conversations.appendMessage({ id: "user-1", conversationId: "conversation-1", role: "user", content: options.conversationPrompt ?? "Implement the requested artifact in the workspace and verify it.", createdAt: NOW, updatedAt: NOW });
  tasks.createTask({ id: "task-1", projectId: "project-1", ...(missionId ? { missionId } : {}), kind: "agent_chat", status: "queued", createdAt: NOW });
  conversations.appendMessage({ id: "assistant-1", conversationId: "conversation-1", role: "assistant", content: "", taskId: "task-1", streamingState: "queued", createdAt: NOW, updatedAt: NOW });
  taskRoutingRepository(db).upsert({
    taskId: "task-1",
    presetId: "balanced",
    providerId: "mock",
    model: "mock-model",
    useMemory: options.useMemory ?? false,
    decision: {
      version: 1,
      presetId: "balanced",
      providerId: "mock",
      model: "mock-model",
      reason: "deterministic conformance fixture",
      fallbackUsed: false,
      overridden: false,
      privacy: "cloud",
      candidates: [],
      mode: "agent",
      autoApprove: true,
    },
    createdAt: NOW,
  });
}

function observationTurn(index: number): ProviderChunk[] {
  const tools = [
    { name: "read_file", args: { path: "README.md" } },
    { name: "list_files", args: { path: "." } },
    { name: "inspect_workspace", args: {} },
  ] as const;
  const tool = tools[index % tools.length]!;
  return [
    {
      type: "tool_call",
      toolCalls: [{ id: `observation-${index}`, index: 0, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }],
    },
    { type: "done" },
  ];
}

function narrationTurn(index: number): ProviderChunk[] {
  return [
    { type: "text", text: `I am still analyzing the requested artifact, pass ${index}.` },
    { type: "done" },
  ];
}

class FailAfterRecoveryMarkerProvider extends MockProvider {
  private requestCount = 0;

  override async *streamChat(...args: Parameters<MockProvider["streamChat"]>) {
    if (this.requestCount++ === 6) {
      throw new Error("simulated restart after durable recovery marker");
    }
    yield* super.streamChat(...args);
  }
}

describe("Task 2 live-loop performance conformance", () => {
  let db: Database.Database | undefined;
  let workspacePath = "";

  afterEach(() => {
    db?.close();
    db = undefined;
    if (workspacePath) {
      rmSync(workspacePath, { recursive: true, force: true });
      workspacePath = "";
    }
  });

  it("bounds a projected checkpoint and excludes cumulative raw call arguments and results", () => {
    const rawArgument = "RAW_ARGUMENT_SHOULD_NOT_BE_STORED" + "x".repeat(20_000);
    const rawResult = "RAW_RESULT_SHOULD_NOT_BE_STORED" + "y".repeat(20_000);
    const calls = Array.from({ length: 1_000 }, (_, index) => ({
      id: `call-${index}`,
      toolName: "read_file",
      status: "completed",
      argsJson: JSON.stringify({ path: `src/${index}.ts`, rawArgument }),
      resultJson: JSON.stringify({ content: rawResult }),
      errorMessage: null,
    }));

    const snapshot = projectCheckpointSnapshot({
      snapshot: baseCheckpointSnapshot("task-1"),
      completedCalls: calls,
      testCalls: calls,
      failedCalls: calls,
      recoveryAttempts: calls.map((call) => ({ type: "task.recovery", payload: { call, rawResult } })),
    });

    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(MAX_EXECUTION_CHECKPOINT_BYTES);
    expect(JSON.stringify(snapshot)).not.toContain("RAW_ARGUMENT_SHOULD_NOT_BE_STORED");
    expect(JSON.stringify(snapshot)).not.toContain("RAW_RESULT_SHOULD_NOT_BE_STORED");
  });

  it("preserves bounded actionable failure context through checkpoint compaction", () => {
    const failedCall = {
      id: "failed-command",
      toolName: "run_command",
      status: "failed",
      argsJson: JSON.stringify({ executable: "pnpm", args: ["test", "--filter", "orchestrator", "--token", "SUPER_SECRET"], purpose: "verification" }),
      resultJson: JSON.stringify({ exitCode: 1, stderr: "TS2322: Type string is not assignable to type number" }),
      errorMessage: "command_exit_nonzero: TS2322: Type string is not assignable to type number; token=SUPER_SECRET",
      cursor: 87,
    };
    const checkpoint = projectCheckpointSnapshot({
      snapshot: baseCheckpointSnapshot("task-1"),
      failedCalls: [failedCall],
    });

    expect(Buffer.byteLength(JSON.stringify(checkpoint))).toBeLessThanOrEqual(MAX_EXECUTION_CHECKPOINT_BYTES);
    expect(checkpoint.unresolvedFailures[0]).toContain("run_command");
    expect(checkpoint.unresolvedFailures[0]).toContain("pnpm test");
    expect(checkpoint.unresolvedFailures[0]).toContain("TS2322");
    expect(checkpoint.unresolvedFailures[0]).toContain("cursor=87");
    expect(JSON.stringify(checkpoint)).not.toContain("SUPER_SECRET");

    const resolution = resolveModelBudget({
      providerId: "deepseek",
      selectedModel: "deepseek-v4-flash",
      endpoint: { kind: "default", host: "api.deepseek.com", protocol: "openai-chat", limitTokens: 131_072, limitSource: "provider-metadata" },
      outputBudgetTokens: 4_096,
    });
    const projected = projectProviderRequest({
      checkpoint,
      envelope: {
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        protocol: "openai-chat",
        messages: [{ role: "user", content: "old context ".repeat(35_000) }],
        tools: [],
        outputReserveTokens: 4_096,
      },
      resolution,
      forceCompaction: true,
    });
    const providerContext = projected.envelope.messages.map((message) => message.content).join("\n");
    expect(providerContext).toContain("pnpm test");
    expect(providerContext).toContain("TS2322");
    expect(providerContext).toContain("cursor=87");
    expect(providerContext).not.toContain("SUPER_SECRET");
  });

  it("redacts environment, header, bearer, password, and URI credentials from actionable diagnostics", () => {
    const secretValues = [
      "aws-secret-value",
      "openai-secret-value",
      "password-secret-value",
      "json-secret-value",
      "bearer-secret-value",
      "mixed-case-secret-value",
      "quoted-secret-value",
      "uri-secret-value",
    ];
    const failedCall = {
      id: "secret-bearing-failure",
      toolName: "run_command",
      status: "failed",
      argsJson: JSON.stringify({
        executable: "node",
        args: [
          "-e",
          "AWS_SECRET_ACCESS_KEY=aws-secret-value OPENAI_API_KEY=\"openai-secret-value\" PaSsWoRd='password-secret-value'",
          "https://alice:uri-secret-value@example.com/api",
        ],
      }),
      resultJson: JSON.stringify({
        exitCode: 1,
        stderr: [
          "TS2322: request failed while contacting service",
          "aws_secret_access_key=aws-secret-value",
          "\"OPENAI_API_KEY\": \"json-secret-value\"",
          "Authorization: Bearer bearer-secret-value",
          "X-API-KEY: mixed-case-secret-value",
          "pAsSwOrD: 'quoted-secret-value'",
          "endpoint=https://alice:uri-secret-value@example.com/api",
        ].join("; "),
      }),
      errorMessage: "diagnostic preserved: request failed for https://alice:uri-secret-value@example.com/api",
      cursor: 88,
    };
    const checkpoint = projectCheckpointSnapshot({
      snapshot: baseCheckpointSnapshot("task-1"),
      failedCalls: [failedCall],
    });
    const serialized = JSON.stringify(checkpoint);

    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(MAX_EXECUTION_CHECKPOINT_BYTES);
    expect(serialized).toContain("TS2322");
    expect(serialized).toContain("request failed");
    for (const secret of secretValues) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("rawArgument");
    expect(serialized).not.toContain("rawResult");
  });

  it("redacts complete cookie headers and credential authorization schemes without hiding benign fields", () => {
    const secretValues = [
      "session-cookie-secret",
      "auth-cookie-secret",
      "jwt-cookie-secret",
      "set-cookie-secret",
      "bearer-header-secret",
      "basic-header-secret",
      "api-header-secret",
    ];
    const failedCall = {
      id: "cookie-bearing-failure",
      toolName: "run_command",
      status: "failed",
      argsJson: JSON.stringify({ executable: "node", args: ["verify"] }),
      resultJson: JSON.stringify({
        exitCode: 1,
        stderr: [
          "request failed while contacting service",
          "Cookie: session=session-cookie-secret; auth=auth-cookie-secret; jwt=jwt-cookie-secret; theme=dark",
          "Set-Cookie: sid=set-cookie-secret; Path=/; HttpOnly; Secure",
          "Authorization: Bearer bearer-header-secret",
          "Authorization: Basic basic-header-secret",
          "X-API-Key: api-header-secret",
          "cache-key=abc123 object key=object-value index=7 keycode=200 authorization=disabled authorization=none",
          "diagnostic: connection refused",
        ].join("\n"),
      }),
      errorMessage: "useful diagnostic: connection refused",
      cursor: 89,
    };
    const checkpoint = projectCheckpointSnapshot({
      snapshot: baseCheckpointSnapshot("task-1"),
      failedCalls: [failedCall],
    });
    const serialized = JSON.stringify(checkpoint);

    for (const secret of secretValues) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("request failed while contacting service");
    expect(serialized).toContain("diagnostic: connection refused");
    expect(serialized).toContain("cache-key=abc123");
    expect(serialized).toContain("object key=object-value");
    expect(serialized).toContain("index=7");
    expect(serialized).toContain("keycode=200");
    expect(serialized).toContain("authorization=disabled");
    expect(serialized).toContain("authorization=none");
  });

  it("redacts secret-like uppercase bare KEY assignments without hiding benign key fields", () => {
    const secretValues = ["BARE_KEY_SECRET", "QUOTED_KEY_SECRET", "JSON_KEY_SECRET"];
    const failedCall = {
      id: "bare-key-failure",
      toolName: "run_command",
      status: "failed",
      argsJson: JSON.stringify({ executable: "node", args: ["inspect"] }),
      resultJson: JSON.stringify({
        exitCode: 1,
        stderr: [
          "env: KEY=BARE_KEY_SECRET export KEY=\"QUOTED_KEY_SECRET\"",
          "json: {\"KEY\":\"JSON_KEY_SECRET\"}",
          "object key=abc index key=abc cache-key=abc123 keycode=200 KEY=abc",
          "diagnostic: retryable=false",
        ].join("\n"),
      }),
      errorMessage: "useful diagnostic: retryable=false",
      cursor: 90,
    };
    const checkpoint = projectCheckpointSnapshot({
      snapshot: baseCheckpointSnapshot("task-1"),
      failedCalls: [failedCall],
    });
    const serialized = JSON.stringify(checkpoint);

    for (const secret of secretValues) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("object key=abc");
    expect(serialized).toContain("index key=abc");
    expect(serialized).toContain("cache-key=abc123");
    expect(serialized).toContain("keycode=200");
    expect(serialized).toContain("KEY=abc");
    expect(serialized).toContain("diagnostic: retryable=false");
  });

  it("redacts cookie values across header syntaxes while preserving inline trailing diagnostics", () => {
    const secretValues = [
      "COLON_SESSION",
      "COLON_AUTH",
      "COLON_JWT",
      "EQUAL_SESSION",
      "JSON_AUTH",
      "INLINE_JWT",
    ];
    const failedCall = {
      id: "cookie-syntax-failure",
      toolName: "run_command",
      status: "failed",
      argsJson: JSON.stringify({ executable: "node", args: ["headers"] }),
      resultJson: JSON.stringify({
        exitCode: 1,
        stderr: [
          "Cookie: session=COLON_SESSION; auth=COLON_AUTH; jwt=COLON_JWT; theme=dark; retryable=false, status=401",
          "Set-Cookie=session=EQUAL_SESSION; Path=/; HttpOnly; retryable=false, status=401",
          "json: {\"Set-Cookie\":\"auth=JSON_AUTH; Path=/; Secure\", \"status\":401}",
          "inline: Cookie: jwt=INLINE_JWT; theme=light; retryable=false, status=401",
          "diagnostic: connection refused",
        ].join("\n"),
      }),
      errorMessage: "useful diagnostic: connection refused",
      cursor: 91,
    };
    const checkpoint = projectCheckpointSnapshot({
      snapshot: baseCheckpointSnapshot("task-1"),
      failedCalls: [failedCall],
    });
    const serialized = JSON.stringify(checkpoint);

    for (const secret of secretValues) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("theme=dark");
    expect(serialized).toContain("theme=light");
    expect(serialized).toContain("Path=/");
    expect(serialized).toContain("HttpOnly");
    expect(serialized).toContain("retryable=false");
    expect(serialized).toContain("status=401");
    expect(serialized).toContain("diagnostic: connection refused");
  });

  it("retains only the latest checkpoint while preserving the newest bounded snapshot", () => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "project-1", name: "Checkpoint", workspacePath: "/tmp/checkpoint", createdAt: NOW });
    taskRepository(db).createTask({ id: "task-1", projectId: "project-1", kind: "agent_chat", status: "running", createdAt: NOW });
    const continuity = executionContinuityRepository(db);
    const segment = continuity.openSegment({ taskId: "task-1", missionId: null, providerId: "mock", model: "mock-model", routeJson: {}, ownerId: "worker-1", now: NOW });

    for (let cursor = 1; cursor <= 20; cursor++) {
      continuity.saveCheckpoint({
        id: `checkpoint-${cursor}`,
        taskId: "task-1",
        missionId: null,
        segmentId: segment.id,
        cursor,
        snapshot: projectCheckpointSnapshot({ snapshot: { ...baseCheckpointSnapshot("task-1"), currentPhase: `phase-${cursor}` } }),
        ownerId: "worker-1",
        generation: segment.generation,
        now: NOW,
      });
    }

    expect(db.prepare("SELECT count(*) AS count FROM agent_execution_checkpoints WHERE task_id=?").get("task-1")).toEqual({ count: 1 });
    expect(continuity.latestCheckpoint("task-1")?.cursor).toBe(20);
    expect(continuity.latestCheckpoint("task-1")?.snapshot.currentPhase).toBe("phase-20");
  });

  it("keeps the emitted checkpoint id authoritative when the durable cursor is reused", () => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "project-1", name: "Checkpoint identity", workspacePath: "/tmp/checkpoint-id", createdAt: NOW });
    taskRepository(db).createTask({ id: "task-1", projectId: "project-1", kind: "agent_chat", status: "running", createdAt: NOW });
    const continuity = executionContinuityRepository(db);
    const segment = continuity.openSegment({ taskId: "task-1", missionId: null, providerId: "mock", model: "mock-model", routeJson: {}, ownerId: "worker-1", now: NOW });

    continuity.saveCheckpoint({ id: "checkpoint-first", taskId: "task-1", missionId: null, segmentId: segment.id, cursor: 41, snapshot: baseCheckpointSnapshot("task-1"), ownerId: "worker-1", generation: segment.generation, now: NOW });
    continuity.saveCheckpoint({ id: "checkpoint-authoritative", taskId: "task-1", missionId: null, segmentId: segment.id, cursor: 41, snapshot: { ...baseCheckpointSnapshot("task-1"), currentPhase: "new phase" }, ownerId: "worker-1", generation: segment.generation, now: NOW });

    expect(continuity.latestCheckpoint("task-1")).toMatchObject({ id: "checkpoint-authoritative", cursor: 41, snapshot: { currentPhase: "new phase" } });
    expect(db.prepare("SELECT id FROM agent_execution_checkpoints WHERE task_id=? AND durable_event_cursor=?").get("task-1", 41)).toEqual({ id: "checkpoint-authoritative" });
  });

  it("reads only rows after a cursor and uses the task/sequence index with 10,000 historical events", () => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "project-1", name: "Events", workspacePath: "/tmp/events", createdAt: NOW });
    taskRepository(db).createTask({ id: "task-1", projectId: "project-1", kind: "agent_chat", status: "running", createdAt: NOW });
    const insert = db.prepare("INSERT INTO task_events(id,schema_version,task_id,sequence,type,payload_json,created_at) VALUES(?,1,?,?,?, ?,?)");
    const seed = db.transaction(() => {
      for (let sequence = 1; sequence <= 10_000; sequence++) {
        insert.run(`old-${sequence}`, "task-1", sequence, "task.progress", "{}", NOW);
      }
    });
    seed();
    const records = taskRecordsRepository(db);
    const newEvents = [
      records.appendEvent({ id: "new-1", taskId: "task-1", type: "task.progress_warning", payload: { phase: "new" }, createdAt: NOW }),
      records.appendEvent({ id: "new-2", taskId: "task-1", type: "task.completed", payload: {}, createdAt: NOW }),
    ];

    const eventsQuery = records.listEventsAfter("task-1", 10_000);
    expect(eventsQuery).toHaveLength(newEvents.length);
    expect(eventsQuery.map((event) => event.id)).toEqual(newEvents.map((event) => event.id));
    expect(records.latestEvent("task-1")?.id).toBe("new-2");
    expect(records.listEventsByType("task-1", "task.completed").map((event) => event.id)).toEqual(["new-2"]);

    const queryPlan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM task_events WHERE task_id=? AND sequence>? ORDER BY sequence ASC").all("task-1", 10_000) as Array<{ detail: string }>;
    expect(queryPlan.map((row) => row.detail).join(" ")).toMatch(/task_events_task_id_sequence_idx|USING INDEX|USING COVERING INDEX/i);
  });

  it("does not inject a semantic artifact stop into a model-owned observation loop", async () => {
    workspacePath = mkdtempSync(join(tmpdir(), "morrow-task-2-loop-"));
    writeFileSync(join(workspacePath, "README.md"), "fixture\n");
    db = openDatabase(":memory:");
    seedArtifactTask(db, workspacePath);
    const provider = new MockProvider({ chunks: Array.from({ length: 20 }, (_, index) => observationTurn(index)) });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 6 });

    const records = taskRecordsRepository(db);
    const events = records.listEvents("task-1") as Array<{ type: string; payload: Record<string, unknown> }>;
    const providerTurns = events.filter((event) => event.type === "assistant.turn_started");
    expect(providerTurns.length).toBeGreaterThan(6);
    expect(events.some((event) => event.payload.reason === "artifact_delivery_recovery")).toBe(false);
    expect(events.some((event) => event.payload.reason === "artifact_delivery_stalled")).toBe(false);
    expect(conversationsRepository(db).listToolCallsForTask("task-1").some((call) => ["propose_patch", "create_file", "create_directory"].includes(call.toolName) && call.status === "completed")).toBe(false);
  });

  it("treats the model's tool-free narration as authoritative after one bounded continuation", async () => {
    workspacePath = mkdtempSync(join(tmpdir(), "morrow-task-2-narration-"));
    writeFileSync(join(workspacePath, "README.md"), "fixture\n");
    db = openDatabase(":memory:");
    seedArtifactTask(db, workspacePath);
    const provider = new MockProvider({ chunks: Array.from({ length: 20 }, (_, index) => narrationTurn(index)) });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 12 });

    const records = taskRecordsRepository(db);
    const events = records.listEvents("task-1") as Array<{ type: string; payload: Record<string, unknown> }>;
    const providerTurns = events.filter((event) => event.type === "assistant.turn_started");
    // v0.8.1 grants one bounded continuation when acceptance evidence is
    // still outstanding; the stalled model repeats itself and the run settles.
    expect(provider.requests).toHaveLength(3);
    expect(providerTurns).toHaveLength(3);
    expect(events.some((event) => event.payload.reason === "artifact_delivery_recovery")).toBe(false);
    expect(events.some((event) => event.payload.reason === "artifact_delivery_stalled")).toBe(false);
    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    expect(executionContinuityRepository(db).getCanonicalAnswer("task-1")?.evidenceJson).toMatchObject({
      completion: { complete: false },
    });
    expect(conversationsRepository(db).listToolCallsForTask("task-1")).toHaveLength(0);
  });

  it("does not replace a model final with a synthetic fresh-context recovery", async () => {
    workspacePath = mkdtempSync(join(tmpdir(), "morrow-artifact-fresh-context-"));
    db = openDatabase(":memory:");
    const missionObjective = "Create the requested artifact in the workspace and verify it.";
    const controllerPrompt = "Build the assigned artifact using the persisted mission contract; this is a controller wrapper, not the user's original request.";
    seedArtifactTask(db, workspacePath, { conversationPrompt: controllerPrompt, missionObjective, useMemory: true });
    memoryRepository(db).create({
      id: "memory-only",
      projectId: "project-1",
      conversationId: "conversation-1",
      scope: "conversation",
      type: "project_architecture",
      content: "MEMORY_ONLY_SHOULD_NOT_REPLAY",
      source: "user",
      pinned: true,
      createdAt: NOW,
    });
    contextSummariesRepository(db).record({
      id: "manual-only",
      projectId: "project-1",
      conversationId: "conversation-1",
      taskId: null,
      method: "deterministic",
      content: "COMPACTION_ONLY_SHOULD_NOT_REPLAY",
      sourceStartIndex: 0,
      sourceEndIndex: 0,
      sourceMessageCount: 1,
      createdAt: NOW,
    });
    const provider = new MockProvider({
      chunks: [
        [
          { type: "tool_call", toolCalls: [{ id: "inspect", index: 0, type: "function", function: { name: "inspect_workspace", arguments: "{}" } }] },
          { type: "done", providerContinuation: { reasoningContent: "PRIVATE_PROVIDER_REASONING" } },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "list", index: 0, type: "function", function: { name: "list_files", arguments: JSON.stringify({ path: "." }) } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "status", index: 0, type: "function", function: { name: "git_status", arguments: "{}" } }] },
          { type: "done" },
        ],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
        [
          { type: "tool_call", toolCalls: [{ id: "deliver", index: 0, type: "function", function: { name: "create_file", arguments: JSON.stringify({ path: "recovered.txt", content: "recovered\n" }) } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "verify", index: 0, type: "function", function: { name: "run_command", arguments: JSON.stringify({ executable: "node", args: ["-e", "process.exit(0)"], purpose: "verify recovered artifact" }) } }] },
          { type: "done" },
        ],
        [{ type: "text", text: "The requested artifact is delivered." }, { type: "done" }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 10 });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    expect(provider.requests).toHaveLength(6);
    expect(conversationsRepository(db).getMessage("assistant-1")?.content).toContain("POISONED_PROVIDER_NARRATION");
    const durableTurns = executionContinuityRepository(db).listProviderTurns("task-1");
    expect(durableTurns.slice(0, 3).map((turn) => turn.toolCalls.map((call) => (call as { name?: string }).name))).toEqual([
      ["inspect_workspace"],
      ["list_files"],
      ["git_status"],
    ]);
    expect(durableTurns).toHaveLength(6);
    expect(taskRecordsRepository(db).listEvents("task-1").some((event) => event.payload.reason === "artifact_delivery_recovery")).toBe(false);
    expect(executionContinuityRepository(db).getCanonicalAnswer("task-1")?.evidenceJson).toMatchObject({
      completion: { complete: false },
    });
  });

  it("does not fresh-reset after a successful run_command that may mutate the workspace", async () => {
    workspacePath = mkdtempSync(join(tmpdir(), "morrow-artifact-command-mutation-"));
    db = openDatabase(":memory:");
    seedArtifactTask(db, workspacePath);
    const provider = new MockProvider({
      chunks: [
        [
          { type: "tool_call", toolCalls: [{ id: "inspect", index: 0, type: "function", function: { name: "inspect_workspace", arguments: "{}" } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "list", index: 0, type: "function", function: { name: "list_files", arguments: JSON.stringify({ path: "." }) } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "status", index: 0, type: "function", function: { name: "git_status", arguments: "{}" } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "mutate", index: 0, type: "function", function: { name: "run_command", arguments: JSON.stringify({ executable: "node", args: ["-e", "require('fs').writeFileSync('command-mutation.txt', 'changed\\n')"], purpose: "Prepare the workspace artifact" }) } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "list-again-1", index: 0, type: "function", function: { name: "list_files", arguments: JSON.stringify({ path: "." }) } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "list-again-2", index: 0, type: "function", function: { name: "list_files", arguments: JSON.stringify({ path: "." }) } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "deliver", index: 0, type: "function", function: { name: "create_file", arguments: JSON.stringify({ path: "after-command.txt", content: "delivered\n" }) } }] },
          { type: "done" },
        ],
        [{ type: "text", text: "The requested artifact is delivered." }, { type: "done" }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 10 });

    expect(readFileSync(join(workspacePath, "command-mutation.txt"), "utf8")).toBe("changed\n");
    expect(readFileSync(join(workspacePath, "after-command.txt"), "utf8")).toBe("delivered\n");
    const postCommandRequest = provider.requests[6]!;
    expect(postCommandRequest.some((message) => message.role === "assistant" || message.role === "tool")).toBe(true);
    expect(postCommandRequest.some((message) => message.role === "user" && message.content.includes("MORROW DELIVERY RECOVERY"))).toBe(false);
  });

  it("does not create a restart recovery marker after the model emits a final", async () => {
    workspacePath = mkdtempSync(join(tmpdir(), "morrow-artifact-restart-marker-"));
    db = openDatabase(":memory:");
    seedArtifactTask(db, workspacePath);
    const firstProvider = new FailAfterRecoveryMarkerProvider({
      chunks: [
        [
          { type: "tool_call", toolCalls: [{ id: "inspect", index: 0, type: "function", function: { name: "inspect_workspace", arguments: "{}" } }] },
          { type: "done", providerContinuation: { reasoningContent: "DURABLE_PRE_RECOVERY_REASONING" } },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "list", index: 0, type: "function", function: { name: "list_files", arguments: JSON.stringify({ path: "." }) } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "status", index: 0, type: "function", function: { name: "git_status", arguments: "{}" } }] },
          { type: "done" },
        ],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider: firstProvider, maxTurns: 10 });

    const records = taskRecordsRepository(db);
    const continuity = executionContinuityRepository(db);
    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    expect(firstProvider.requests).toHaveLength(6);
    expect(continuity.listProviderTurns("task-1")).toHaveLength(6);
    expect(conversationsRepository(db).listToolCallsForTask("task-1")).toHaveLength(3);
    expect(continuity.listProviderContinuationRefs("task-1")).toHaveLength(1);
    expect(records.listEvents("task-1").some((event) => event.payload.reason === "artifact_delivery_recovery")).toBe(false);
    expect(continuity.getCanonicalAnswer("task-1")?.evidenceJson).toMatchObject({
      completion: { complete: false },
    });
  });

  it("does not rebuild synthetic artifact-delivery context from a legacy marker", async () => {
    workspacePath = mkdtempSync(join(tmpdir(), "morrow-artifact-rollover-restart-"));
    db = openDatabase(":memory:");
    seedArtifactTask(db, workspacePath);
    const continuity = executionContinuityRepository(db);
    const ownerId = "seed-owner";
    const firstSegment = continuity.openSegment({ taskId: "task-1", missionId: null, providerId: "mock", model: "mock-model", routeJson: {}, ownerId, now: NOW });
    continuity.recordProviderTurn({
      id: "segment-turn-1",
      taskId: "task-1",
      segmentId: firstSegment.id,
      turnKey: "segment-turn-key-1",
      ordinal: 1,
      assistantText: "durable segment one context",
      toolCalls: [],
      isFinal: false,
      ownerId,
      generation: firstSegment.generation,
      now: NOW,
    });
    const secondSegment = continuity.rolloverSegment({
      taskId: "task-1",
      currentSegmentId: firstSegment.id,
      reason: "context_pressure",
      providerId: "mock",
      model: "mock-model",
      routeJson: {},
      ownerId,
      generation: firstSegment.generation,
      now: NOW,
    });
    const markerTurn = continuity.recordProviderTurn({
      id: "segment-turn-2",
      taskId: "task-1",
      segmentId: secondSegment.id,
      turnKey: "segment-turn-key-2",
      ordinal: 1,
      assistantText: "durable segment two context",
      toolCalls: [],
      isFinal: false,
      ownerId,
      generation: secondSegment.generation,
      now: NOW,
    });
    continuity.failSegment(secondSegment.id, "simulated_process_restart", NOW, { ownerId, generation: secondSegment.generation });
    const records = taskRecordsRepository(db);
    records.appendEvent({
      id: "rollover-recovery-marker",
      taskId: "task-1",
      type: "task.progress_warning",
      payload: {
        reason: "artifact_delivery_recovery",
        message: "No durable artifact mutation has landed yet.",
        turn: 2,
        recoveryTurnKey: markerTurn.turnKey,
        actionOnly: true,
      },
      createdAt: NOW,
    });
    const preRecoveryTurns = continuity.listProviderTurns("task-1");
    expect(preRecoveryTurns.at(-1)?.ordinal).toBe(1);
    expect(markerTurn.turnKey).toBe("segment-turn-key-2");

    const provider = new MockProvider({
      chunks: [
        [
          { type: "tool_call", toolCalls: [{ id: "deliver", index: 0, type: "function", function: { name: "create_file", arguments: JSON.stringify({ path: "rollover-recovered.txt", content: "recovered\n" }) } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "verify", index: 0, type: "function", function: { name: "run_command", arguments: JSON.stringify({ executable: "node", args: ["-e", "process.exit(0)"], purpose: "Verify rollover recovery" }) } }] },
          { type: "done" },
        ],
        [{ type: "text", text: "The rollover artifact is delivered." }, { type: "done" }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 10 });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    const freshRequest = provider.requests[0]!;
    expect(freshRequest.some((message) => message.role === "user" && message.content.includes("MORROW DELIVERY RECOVERY"))).toBe(false);
    expect(freshRequest.some((message) => message.role === "assistant" && message.content.includes("durable segment one context"))).toBe(true);
    expect(freshRequest.some((message) => message.role === "assistant" && message.content.includes("durable segment two context"))).toBe(true);
    const recoveryEvents = records.listEvents("task-1").filter((event) => event.payload.reason === "artifact_delivery_recovery");
    expect(recoveryEvents).toHaveLength(1);
    expect(recoveryEvents[0]?.payload.recoveryTurnKey).toBe(markerTurn.turnKey);
  });

  it("does not reset history after a model final even when a later scripted turn contains reasoning", async () => {
    workspacePath = mkdtempSync(join(tmpdir(), "morrow-artifact-restart-after-fresh-"));
    db = openDatabase(":memory:");
    seedArtifactTask(db, workspacePath);
    const firstProvider = new MockProvider({
      chunks: [
        [
          { type: "tool_call", toolCalls: [{ id: "inspect", index: 0, type: "function", function: { name: "inspect_workspace", arguments: "{}" } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "list", index: 0, type: "function", function: { name: "list_files", arguments: JSON.stringify({ path: "." }) } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "status", index: 0, type: "function", function: { name: "git_status", arguments: "{}" } }] },
          { type: "done" },
        ],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
        [{ type: "done", providerContinuation: { reasoningContent: "The fresh recovery attempt remained reasoning-only." } }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider: firstProvider, maxTurns: 12 });

    const records = taskRecordsRepository(db);
    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    expect(firstProvider.requests).toHaveLength(6);
    expect(executionContinuityRepository(db).listProviderTurns("task-1")).toHaveLength(6);
    expect(records.listEvents("task-1").filter((event) => event.payload.reason === "artifact_delivery_recovery")).toHaveLength(0);
  });

  it("fails safe for a malformed legacy recovery marker", async () => {
    workspacePath = mkdtempSync(join(tmpdir(), "morrow-artifact-legacy-marker-"));
    db = openDatabase(":memory:");
    seedArtifactTask(db, workspacePath);
    const records = taskRecordsRepository(db);
    records.appendEvent({
      id: "legacy-recovery-marker",
      taskId: "task-1",
      type: "task.progress_warning",
      payload: { reason: "artifact_delivery_recovery", turn: "6", message: "legacy marker without a numeric cursor" },
      createdAt: NOW,
    });
    const provider = new MockProvider({
      chunks: [
        [
          { type: "tool_call", toolCalls: [{ id: "deliver", index: 0, type: "function", function: { name: "create_file", arguments: JSON.stringify({ path: "legacy-safe.txt", content: "safe\n" }) } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "verify", index: 0, type: "function", function: { name: "run_command", arguments: JSON.stringify({ executable: "node", args: ["-e", "process.exit(0)"], purpose: "Verify legacy marker handling" }) } }] },
          { type: "done" },
        ],
        [{ type: "text", text: "The artifact is delivered safely." }, { type: "done" }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 10 });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    expect(provider.requests[0]?.some((message) => message.role === "user" && message.content.includes("MORROW DELIVERY RECOVERY"))).toBe(false);
    expect(records.listEvents("task-1").filter((event) => event.payload.reason === "artifact_delivery_recovery")).toHaveLength(1);
  });

  it("does not reach a later reasoning-only script after the model has already emitted a final", async () => {
    workspacePath = mkdtempSync(join(tmpdir(), "morrow-artifact-fresh-empty-"));
    db = openDatabase(":memory:");
    seedArtifactTask(db, workspacePath);
    const provider = new MockProvider({
      chunks: [
        [
          { type: "tool_call", toolCalls: [{ id: "inspect", index: 0, type: "function", function: { name: "inspect_workspace", arguments: "{}" } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "list", index: 0, type: "function", function: { name: "list_files", arguments: JSON.stringify({ path: "." }) } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "status", index: 0, type: "function", function: { name: "git_status", arguments: "{}" } }] },
          { type: "done" },
        ],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
        [{ type: "text", text: "No task exists. POISONED_PROVIDER_NARRATION" }, { type: "done" }],
        [{ type: "done", providerContinuation: { reasoningContent: "Still reasoning about whether a task exists." } }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 12 });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    expect(provider.requests).toHaveLength(6);
    const events = taskRecordsRepository(db).listEvents("task-1");
    expect(events.some((event) => event.payload.reason === "artifact_delivery_recovery_reasoning_only")).toBe(false);
    expect(events.filter((event) => event.payload.reason === "empty_provider_response")).toHaveLength(0);
    expect(events.some((event) => event.payload.reason === "artifact_delivery_stalled")).toBe(false);
    expect(conversationsRepository(db).listToolCallsForTask("task-1").some((call) => call.toolName === "create_file")).toBe(false);
  });

  it("executes repeated reads without observation-exhaustion interruption", async () => {
    workspacePath = mkdtempSync(join(tmpdir(), "morrow-cached-observation-"));
    db = openDatabase(":memory:");
    seedArtifactTask(db, workspacePath);
    const write = (id: string, path: string, content: string): ProviderChunk[] => [
      {
        type: "tool_call",
        toolCalls: [{
          id,
          index: 0,
          type: "function",
          function: {
            name: "create_file",
            arguments: JSON.stringify({ path, content, purpose: `Create ${path}` }),
          },
        }],
      },
      { type: "done" },
    ];
    const read = (id: string): ProviderChunk[] => [
      {
        type: "tool_call",
        toolCalls: [{
          id,
          index: 0,
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "first.txt" }) },
        }],
      },
      { type: "done" },
    ];
    const provider = new MockProvider({
      chunks: [
        write("write-first", "first.txt", "first\n"),
        ...Array.from({ length: 4 }, (_, index) => read(`read-first-${index}`)),
        write("write-second", "second.txt", "second\n"),
        [{ type: "text", text: "Both requested files are complete." }, { type: "done" }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 10 });

    const calls = conversationsRepository(db).listToolCallsForTask("task-1");
    const reads = calls.filter((call) => call.toolName === "read_file");
    expect(reads).toHaveLength(4);
    expect(reads.every((call) => call.status === "completed")).toBe(true);
    expect(calls.find((call) => call.id === "write-second")?.status).toBe("completed");
    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    expect(taskRecordsRepository(db).listEvents("task-1").some((event) => event.payload.reason === "observation_epoch_exhausted")).toBe(false);
  });
});
