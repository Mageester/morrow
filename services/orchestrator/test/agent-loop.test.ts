import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { MockProvider } from "../src/provider/mock.js";
import type { ProviderChunk } from "../src/provider/base.js";
import { executeAgentChatTask, runCommandIsVerification, toolCallPassedVerification } from "../src/execution/agent.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";

describe("agent loop detection", () => {
  let db: Database.Database;
  let tempDir = "";

  beforeEach(() => {
    db = openDatabase(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "morrow-agent-loop-"));
  });
  afterEach(() => {
    try {
      db.close();
    } finally {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = "";
      }
    }
  });

  function seed(missionLinked = false) {
    const ts = new Date().toISOString();
    projectRepository(db).createProject({ id: "p1", name: "Loop", workspacePath: tempDir, createdAt: ts });
    if (missionLinked) {
      db.prepare(`INSERT INTO missions
        (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`)
        .run("mission-1", 1, "p1", "Escape the repeated strategy", "running", 1, "{}", ts, ts);
    }
    writeFileSync(join(tempDir, "readme.md"), "Morrow");
    conversationsRepository(db).createConversation({ id: "c1", projectId: "p1", title: "Loop", createdAt: ts, updatedAt: ts });
    conversationsRepository(db).appendMessage({ id: "msg-user", conversationId: "c1", role: "user", content: "go", createdAt: ts, updatedAt: ts });
    taskRepository(db).createTask({ id: "task-1", projectId: "p1", ...(missionLinked ? { missionId: "mission-1" } : {}), kind: "agent_chat", status: "queued", createdAt: ts });
    conversationsRepository(db).appendMessage({ id: "msg-assistant", conversationId: "c1", role: "assistant", content: "", taskId: "task-1", streamingState: "queued", createdAt: ts, updatedAt: ts });
  }

  it("does not count a completed command transport with nonzero exit as passed verification", () => {
    expect(toolCallPassedVerification({
      status: "completed",
      toolName: "run_command",
      argsJson: JSON.stringify({ executable: "npm", args: ["test"], purpose: "verification" }),
      resultJson: JSON.stringify({ exitCode: 2 }),
    })).toBe(false);
    expect(toolCallPassedVerification({
      status: "completed",
      toolName: "run_command",
      argsJson: JSON.stringify({ executable: "npm", args: ["test"], purpose: "verification" }),
      resultJson: JSON.stringify({ exitCode: 0 }),
    })).toBe(true);
    expect(runCommandIsVerification({ executable: "type", args: ["src/index.ts"], purpose: "Read source file" })).toBe(false);
    expect(runCommandIsVerification({ executable: "npm", args: ["run", "build"], purpose: "Compile project" })).toBe(true);
  });

  // One turn that always requests the identical tool call. Repeated across turns
  // this is exactly the pathological loop the detector must catch.
  const repeatTurn = (): ProviderChunk[] => [
    {
      type: "tool_call",
      toolCalls: [
        { id: "c", index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "readme.md" }) } },
      ],
    },
    { type: "done" },
  ];

  it("interrupts a repeated identical tool call with reason loop_detected and does not mark success", async () => {
    seed();
    const provider = new MockProvider({ chunks: [repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn()] });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    const tasks = taskRepository(db);
    const records = taskRecordsRepository(db) as any;
    const finalTask = tasks.getTaskById("task-1");
    expect(finalTask?.status).toBe("interrupted");
    expect(finalTask?.status).not.toBe("completed");
    expect(finalTask?.status).not.toBe("verified");

    const events = records.listEvents("task-1") as Array<{ type: string; payload: any }>;
    expect(events.some((e) => e.payload?.reason === "loop_detected")).toBe(true);
    expect(events.some((e) => e.payload?.reason === "loop_recovery")).toBe(true);

    const msg = conversationsRepository(db).getMessage("msg-assistant");
    expect(msg?.streamingState).toBe("interrupted");
    expect(msg?.content).toContain("Loop detected");
  });

  it("uses one bounded recovery turn when the provider changes strategy", async () => {
    seed();
    writeFileSync(join(tempDir, "other.md"), "Other");
    const provider = new MockProvider({
      chunks: [
        repeatTurn(),
        repeatTurn(),
        repeatTurn(),
        [
          { type: "tool_call", toolCalls: [{ id: "other", index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "other.md" }) } }] },
          { type: "done" },
        ],
        [{ type: "text", text: "Recovered and finished." }, { type: "done" }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    expect(taskRecordsRepository(db).listEvents("task-1").some((event) => event.payload.reason === "loop_recovery")).toBe(true);
  });

  it("does not interrupt when the model varies its tool calls and then answers", async () => {
    seed();
    writeFileSync(join(tempDir, "other.md"), "Other");
    const provider = new MockProvider({
      chunks: [
        [
          { type: "tool_call", toolCalls: [{ id: "a", index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "readme.md" }) } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "b", index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "other.md" }) } }] },
          { type: "done" },
        ],
        [{ type: "text", text: "Both files read." }, { type: "done" }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider });
    const finalTask = taskRepository(db).getTaskById("task-1");
    expect(finalTask?.status).toBe("completed");
  });

  it("counts a repeated signature once per turn instead of treating one parallel batch as a loop", async () => {
    seed();
    const repeatedBatch: ProviderChunk[] = [
      {
        type: "tool_call",
        toolCalls: ["a", "b", "c"].map((id, index) => ({
          id,
          index,
          type: "function" as const,
          function: { name: "read_file", arguments: JSON.stringify({ path: "readme.md" }) },
        })),
      },
      { type: "done" },
    ];
    const provider = new MockProvider({
      chunks: [repeatedBatch, [{ type: "text", text: "File inspected." }, { type: "done" }]],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    expect(taskRecordsRepository(db).listEvents("task-1").some((event) => event.payload.reason === "loop_detected"))
      .toBe(false);
  });

  it("returns a mission loop to the controller as a strategy change", async () => {
    seed(true);
    const provider = new MockProvider({ chunks: [repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn()] });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("interrupted");
    expect(executionContinuityRepository(db).latestCheckpoint("task-1")?.snapshot.currentPhase)
      .toBe("strategy_change_required");
    expect(executionContinuityRepository(db).listSegments("task-1").at(-1)?.boundaryReason)
      .toBe("strategy_change_required");
    expect(taskRecordsRepository(db).listEvents("task-1").some((event) => event.payload.reason === "loop_detected"))
      .toBe(false);
  });

  it("ends a mission task after the durable tool-failure loop is exhausted", async () => {
    seed(true);
    const repeatedFailure: ProviderChunk[] = [
      {
        type: "tool_call",
        toolCalls: [{ id: "forbidden", index: 0, type: "function", function: { name: "unknown_tool", arguments: JSON.stringify({ target: "same" }) } }],
      },
      { type: "done" },
    ];
    const provider = new MockProvider({ chunks: [repeatedFailure, repeatedFailure, repeatedFailure, repeatedFailure, repeatedFailure] });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("interrupted");
    expect(db.prepare("SELECT status FROM missions WHERE id='mission-1'").get()).toEqual({ status: "blocked" });
    expect(provider.requests).toHaveLength(4);
    expect(taskRecordsRepository(db).listEvents("task-1").at(-1)?.payload).toMatchObject({
      reason: "strategy_change_required",
      terminalEntryKind: "tool_loop_exhausted",
    });
  });

  it("automatically continues a productive Coding-preset task beyond 18 turns", async () => {
    seed(true);
    const turns: ProviderChunk[][] = [];
    for (let index = 0; index < 19; index++) {
      const path = `evidence-${index}.md`;
      writeFileSync(join(tempDir, path), `evidence ${index}`);
      turns.push([
        {
          type: "tool_call",
          toolCalls: [{ id: `read-${index}`, index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path }) } }],
        },
        { type: "done" },
      ]);
    }
    turns.push([{ type: "text", text: "All 19 evidence files were inspected." }, { type: "done" }]);

    // Coding starts with six tool iterations. Its former 3× adaptive ceiling
    // stopped a still-progressing real consumer task exactly at turn 18.
    await executeAgentChatTask({ db, taskId: "task-1", provider: new MockProvider({ chunks: turns }), maxTurns: 6 });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    const events = taskRecordsRepository(db).listEvents("task-1") as Array<{ type: string; payload: any }>;
    expect(events.filter((event) => event.type === "assistant.turn_started")).toHaveLength(20);
    expect(events.some((event) => event.payload?.reason === "turn_budget_reached")).toBe(false);
    expect(executionContinuityRepository(db).listSegments("task-1").at(-1)?.boundaryReason)
      .toBe("candidate_answer_ready");
  });

  it("does not treat turn-budget checkpoints as progress during post-delivery read roaming", async () => {
    seed();
    taskRoutingRepository(db).upsert({
      taskId: "task-1",
      presetId: "coding",
      providerId: "mock",
      model: "mock-model",
      useMemory: false,
      decision: {
        version: 1,
        presetId: "coding",
        providerId: "mock",
        model: "mock-model",
        reason: "test",
        fallbackUsed: false,
        overridden: false,
        privacy: "cloud",
        candidates: [],
        mode: "agent",
        autoApprove: true,
      },
      createdAt: new Date().toISOString(),
    });

    const turns: ProviderChunk[][] = [[
      {
        type: "tool_call",
        toolCalls: [{
          id: "deliver",
          index: 0,
          type: "function",
          function: { name: "create_file", arguments: JSON.stringify({ path: "delivered.txt", content: "done\n" }) },
        }],
      },
      { type: "done" },
    ]];
    for (let index = 0; index < 20; index++) {
      const path = `roam-${index}.txt`;
      writeFileSync(join(tempDir, path), `roam ${index}`);
      turns.push([
        {
          type: "tool_call",
          toolCalls: [{
            id: `roam-${index}`,
            index: 0,
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path }) },
          }],
        },
        { type: "done" },
      ]);
    }
    turns.push([{ type: "text", text: "Finished after roaming." }, { type: "done" }]);

    await executeAgentChatTask({
      db,
      taskId: "task-1",
      provider: new MockProvider({ chunks: turns }),
      maxTurns: 6,
    });

    const reads = conversationsRepository(db).listToolCallsForTask("task-1")
      .filter((call) => call.toolName === "read_file");
    expect(reads.length).toBeLessThan(20);
    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("interrupted");
    expect(taskRecordsRepository(db).listEvents("task-1").some((event) => event.payload.reason === "stalled"))
      .toBe(true);
  });
});

describe("empty-response recovery raises the output ceiling", () => {
  let db: Database.Database;
  let tempDir = "";
  beforeEach(() => { db = openDatabase(":memory:"); tempDir = mkdtempSync(join(tmpdir(), "morrow-agent-budget-")); });
  afterEach(() => {
    try {
      db.close();
    } finally {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = "";
      }
    }
  });

  it("escalates maxOutputTokens each retry instead of resending the same exhausted allowance", async () => {
    const ts = new Date().toISOString();
    projectRepository(db).createProject({ id: "p1", name: "B", workspacePath: tempDir, createdAt: ts });
    conversationsRepository(db).createConversation({ id: "c1", projectId: "p1", title: "B", createdAt: ts, updatedAt: ts });
    conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c1", role: "user", content: "go", createdAt: ts, updatedAt: ts });
    taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: ts });
    conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c1", role: "assistant", content: "", taskId: "t1", streamingState: "queued", createdAt: ts, updatedAt: ts });
    taskRoutingRepository(db).upsert({
      taskId: "t1", presetId: "balanced", providerId: "openai", model: "gpt-5.5", useMemory: true,
      decision: { version: 1, presetId: "balanced", providerId: "openai", model: "gpt-5.5", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [] },
      createdAt: ts,
    });

    // A reasoning-heavy route: always burns the whole allowance, never emits
    // visible text. Exactly what deepseek-v4-flash-free did live.
    const budgets: Array<number | null | undefined> = [];
    const timeouts: Array<number | undefined> = [];
    const provider = {
      id: "openai",
      async *streamChat(_m: unknown, options: { maxOutputTokens?: number | null; timeoutMs?: number }): AsyncIterable<ProviderChunk> {
        budgets.push(options.maxOutputTokens);
        timeouts.push(options.timeoutMs);
        yield { type: "done", usage: { promptTokens: 10, completionTokens: options.maxOutputTokens ?? 0 }, finishReason: "length" };
      },
    } as never;

    await executeAgentChatTask({ db, taskId: "t1", provider });

    // First attempt at the preset budget, then a strictly rising ceiling.
    expect(budgets.length).toBeGreaterThanOrEqual(4);
    expect(budgets[0]).toBe(4096);
    expect(budgets[1]).toBe(8192);
    expect(budgets[2]).toBe(16384);
    // Bounded: never escalates past the 8x cap.
    expect(Math.max(...budgets.map((b) => Number(b ?? 0)))).toBeLessThanOrEqual(4096 * 8);
    // The deadline must rise with the allowance. Raising tokens alone just
    // converts an empty response into a timeout before the turn can finish.
    expect(timeouts[0]).toBe(90_000);
    expect(timeouts[1]).toBe(180_000);
    expect(timeouts[2]).toBe(360_000);

    const warnings = (taskRecordsRepository(db).listEvents("t1") as Array<{ type: string; payload: Record<string, unknown> }>)
      .filter((e) => e.type === "task.progress_warning" && e.payload.reason === "empty_provider_response");
    expect(warnings[0]!.payload.previousOutputBudgetTokens).toBe(4096);
    expect(warnings[0]!.payload.outputBudgetTokens).toBe(8192);
  });
});
