import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { MockProvider } from "../src/provider/mock.js";
import type { ProviderChunk } from "../src/provider/base.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import {
  ARTIFACT_DELIVERY_RECOVERY_TURN,
  ARTIFACT_DELIVERY_STOP_TURN,
  MAX_OBSERVATION_SIGNATURE_EXECUTIONS,
  createProgressEpoch,
  assessArtifactDelivery,
  observationSignature,
} from "../src/execution/progress-epoch.js";
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

function seedArtifactTask(db: Database.Database, workspacePath: string): void {
  const projects = projectRepository(db);
  const tasks = taskRepository(db);
  const conversations = conversationsRepository(db);
  projects.createProject({ id: "project-1", name: "Performance", workspacePath, createdAt: NOW });
  conversations.createConversation({ id: "conversation-1", projectId: "project-1", title: "Performance", createdAt: NOW, updatedAt: NOW });
  conversations.appendMessage({ id: "user-1", conversationId: "conversation-1", role: "user", content: "Implement the requested artifact in the workspace and verify it.", createdAt: NOW, updatedAt: NOW });
  tasks.createTask({ id: "task-1", projectId: "project-1", kind: "agent_chat", status: "queued", createdAt: NOW });
  conversations.appendMessage({ id: "assistant-1", conversationId: "conversation-1", role: "assistant", content: "", taskId: "task-1", streamingState: "queued", createdAt: NOW, updatedAt: NOW });
  taskRoutingRepository(db).upsert({
    taskId: "task-1",
    presetId: "balanced",
    providerId: "mock",
    model: "mock-model",
    useMemory: false,
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

  it("counts exact interleaved observation signatures across compaction and evidence in one epoch", () => {
    const epoch = createProgressEpoch();
    const sequence = [
      ["read_file", { path: "README.md" }],
      ["list_files", { path: "." }],
      ["inspect_workspace", {}],
    ] as const;

    for (let repeat = 0; repeat < MAX_OBSERVATION_SIGNATURE_EXECUTIONS + 1; repeat++) {
      for (const [toolName, args] of sequence) {
        epoch.recordObservation(toolName, args);
        epoch.recordObservationEvidence(`observation-${repeat}-${toolName}`);
        epoch.recordCompaction();
      }
    }

    const read = epoch.recordObservation("read_file", { path: "README.md" });
    expect(read.executionsPerSignature).toBe(MAX_OBSERVATION_SIGNATURE_EXECUTIONS + 2);
    expect(read.exceeded).toBe(true);
    expect(epoch.currentEpoch()).toBe(0);
    expect(epoch.count("read_file", { path: "README.md" })).toBe(MAX_OBSERVATION_SIGNATURE_EXECUTIONS + 2);
  });

  it("does not treat observation evidence or compaction as meaningful delivery progress", () => {
    const epoch = createProgressEpoch();
    epoch.recordObservation("read_file", { path: "README.md" });
    const before = epoch.snapshot();

    epoch.recordObservationEvidence("evidence-1");
    epoch.recordCompaction();

    expect(epoch.snapshot()).toEqual(before);
    expect(epoch.hasMeaningfulDeliveryProgress()).toBe(false);

    epoch.recordMutation("artifact:README.md@hash-1");
    expect(epoch.currentEpoch()).toBe(1);
    expect(epoch.hasMeaningfulDeliveryProgress()).toBe(true);
  });

  it("collapses semantically equivalent observation aliases into one epoch signature", () => {
    const aliases = [
      {},
      { path: "." },
      { path: "" },
      { path: "./" },
      { path: "src/.." },
      { path: ".\\" },
      { path: "./src/../" },
    ];
    const signatures = aliases.map((args) => observationSignature("list_files", args));
    expect(new Set(signatures)).toHaveLength(1);

    const epoch = createProgressEpoch();
    const observations = aliases.map((args) => epoch.recordObservation("list_files", args));
    expect(observations[0]?.executionsPerSignature).toBe(1);
    expect(observations[MAX_OBSERVATION_SIGNATURE_EXECUTIONS - 1]?.exceeded).toBe(false);
    expect(observations[MAX_OBSERVATION_SIGNATURE_EXECUTIONS]?.exceeded).toBe(true);
  });

  it("keeps malformed required observation arguments distinct from valid empty values", () => {
    const readFileSignatures = [
      observationSignature("read_file", {}),
      observationSignature("read_file", { path: "" }),
      observationSignature("read_file", { path: "README.md" }),
    ];
    const searchTextSignatures = [
      observationSignature("search_text", {}),
      observationSignature("search_text", { query: "" }),
      observationSignature("search_text", { query: "needle" }),
    ];

    expect(new Set(readFileSignatures)).toHaveLength(3);
    expect(new Set(searchTextSignatures)).toHaveLength(3);

    const readEpoch = createProgressEpoch();
    for (let index = 0; index < MAX_OBSERVATION_SIGNATURE_EXECUTIONS; index++) {
      readEpoch.recordObservation("read_file", { path: "" });
    }
    const malformedRead = readEpoch.recordObservation("read_file", {});
    expect(malformedRead.executionsPerSignature).toBe(1);
    expect(malformedRead.exceeded).toBe(false);
    expect(readEpoch.recordObservation("read_file", { path: "" }).exceeded).toBe(true);

    const searchEpoch = createProgressEpoch();
    for (let index = 0; index < MAX_OBSERVATION_SIGNATURE_EXECUTIONS; index++) {
      searchEpoch.recordObservation("search_text", { query: "" });
    }
    const malformedSearch = searchEpoch.recordObservation("search_text", {});
    expect(malformedSearch.executionsPerSignature).toBe(1);
    expect(malformedSearch.exceeded).toBe(false);
    expect(searchEpoch.recordObservation("search_text", { query: "" }).exceeded).toBe(true);
  });

  it("requires action-only recovery by turn 6 and strategy termination by turn 12 for artifact delivery", () => {
    expect(assessArtifactDelivery({ requiresArtifact: true, providerTurn: ARTIFACT_DELIVERY_RECOVERY_TURN, mutationObserved: false }))
      .toMatchObject({ actionOnlyRecoveryRequired: true, strategyTerminationRequired: false });
    expect(assessArtifactDelivery({ requiresArtifact: true, providerTurn: ARTIFACT_DELIVERY_STOP_TURN, mutationObserved: false }))
      .toMatchObject({ actionOnlyRecoveryRequired: false, strategyTerminationRequired: true });
    expect(assessArtifactDelivery({ requiresArtifact: false, providerTurn: 100, mutationObserved: false }))
      .toMatchObject({ actionOnlyRecoveryRequired: false, strategyTerminationRequired: false });
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

  it("bounds an artifact-only provider loop to twelve turns even when observations interleave", async () => {
    workspacePath = mkdtempSync(join(tmpdir(), "morrow-task-2-loop-"));
    writeFileSync(join(workspacePath, "README.md"), "fixture\n");
    db = openDatabase(":memory:");
    seedArtifactTask(db, workspacePath);
    const provider = new MockProvider({ chunks: Array.from({ length: 20 }, (_, index) => observationTurn(index)) });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 6 });

    const records = taskRecordsRepository(db);
    const events = records.listEvents("task-1") as Array<{ type: string; payload: Record<string, unknown> }>;
    const providerTurns = events.filter((event) => event.type === "assistant.turn_started");
    const recovery = events.find((event) => event.payload.reason === "artifact_delivery_recovery");
    const termination = events.find((event) => event.payload.reason === "artifact_delivery_stalled");
    expect(providerTurns.length).toBeLessThanOrEqual(ARTIFACT_DELIVERY_STOP_TURN);
    expect(recovery?.payload.turn).toBeLessThanOrEqual(ARTIFACT_DELIVERY_RECOVERY_TURN);
    expect(termination?.payload.turn).toBeLessThanOrEqual(ARTIFACT_DELIVERY_STOP_TURN);
    expect(conversationsRepository(db).listToolCallsForTask("task-1").some((call) => ["propose_patch", "create_file", "create_directory"].includes(call.toolName) && call.status === "completed")).toBe(false);
  });

  it("routes repeated no-tool artifact narration through recovery before stopping", async () => {
    workspacePath = mkdtempSync(join(tmpdir(), "morrow-task-2-narration-"));
    writeFileSync(join(workspacePath, "README.md"), "fixture\n");
    db = openDatabase(":memory:");
    seedArtifactTask(db, workspacePath);
    const provider = new MockProvider({ chunks: Array.from({ length: 20 }, (_, index) => narrationTurn(index)) });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 12 });

    const records = taskRecordsRepository(db);
    const events = records.listEvents("task-1") as Array<{ type: string; payload: Record<string, unknown> }>;
    const providerTurns = events.filter((event) => event.type === "assistant.turn_started");
    const recovery = events.find((event) => event.payload.reason === "artifact_delivery_recovery");
    const termination = events.find((event) => event.payload.reason === "artifact_delivery_stalled");
    expect(provider.requests.length).toBeLessThanOrEqual(ARTIFACT_DELIVERY_STOP_TURN);
    expect(providerTurns.length).toBeLessThanOrEqual(ARTIFACT_DELIVERY_STOP_TURN);
    expect(recovery?.payload.turn).toBe(ARTIFACT_DELIVERY_RECOVERY_TURN);
    expect(termination?.payload.turn).toBe(ARTIFACT_DELIVERY_STOP_TURN);
    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("interrupted");
    expect(conversationsRepository(db).listToolCallsForTask("task-1")).toHaveLength(0);
  });
});
