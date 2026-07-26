import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
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
  const tempDir = join(process.cwd(), "test-temp-loop-" + Math.random().toString(36).slice(2));

  beforeEach(() => {
    db = openDatabase(":memory:");
    mkdirSync(tempDir, { recursive: true });
  });
  afterEach(() => {
    db.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
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
