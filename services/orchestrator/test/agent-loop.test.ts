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
import { executeAgentChatTask } from "../src/execution/agent.js";

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

  function seed() {
    const ts = new Date().toISOString();
    projectRepository(db).createProject({ id: "p1", name: "Loop", workspacePath: tempDir, createdAt: ts });
    writeFileSync(join(tempDir, "readme.md"), "Morrow");
    conversationsRepository(db).createConversation({ id: "c1", projectId: "p1", title: "Loop", createdAt: ts, updatedAt: ts });
    conversationsRepository(db).appendMessage({ id: "msg-user", conversationId: "c1", role: "user", content: "go", createdAt: ts, updatedAt: ts });
    taskRepository(db).createTask({ id: "task-1", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: ts });
    conversationsRepository(db).appendMessage({ id: "msg-assistant", conversationId: "c1", role: "assistant", content: "", taskId: "task-1", streamingState: "queued", createdAt: ts, updatedAt: ts });
  }

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
    const provider = new MockProvider({ chunks: [repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn()] });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    const tasks = taskRepository(db);
    const records = taskRecordsRepository(db) as any;
    const finalTask = tasks.getTaskById("task-1");
    expect(finalTask?.status).toBe("interrupted");
    expect(finalTask?.status).not.toBe("completed");
    expect(finalTask?.status).not.toBe("verified");

    const events = records.listEvents("task-1") as Array<{ type: string; payload: any }>;
    expect(events.some((e) => e.payload?.reason === "loop_detected")).toBe(true);

    const msg = conversationsRepository(db).getMessage("msg-assistant");
    expect(msg?.streamingState).toBe("interrupted");
    expect(msg?.content).toContain("Loop detected");
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

  it("automatically continues a productive task past its initial 18-turn budget", async () => {
    seed();
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

    await executeAgentChatTask({ db, taskId: "task-1", provider: new MockProvider({ chunks: turns }), maxTurns: 18 });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    const events = taskRecordsRepository(db).listEvents("task-1") as Array<{ type: string; payload: any }>;
    expect(events.filter((event) => event.type === "assistant.turn_started")).toHaveLength(20);
    expect(events.some((event) => event.payload?.reason === "turn_budget_reached")).toBe(false);
  });
});
