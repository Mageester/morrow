import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions } from "../src/provider/base.js";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { TaskRunner } from "../src/runner.js";

function seedYolo(db: any, workspacePath: string): void {
  const now = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: now });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "T", createdAt: now, updatedAt: now });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: "Build the app and continue after checking the generated file.", createdAt: now, updatedAt: now });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", streamingState: "queued", createdAt: now, updatedAt: now });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "test", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: now,
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: now });
}

const done: ProviderChunk = { type: "done" };
const tool = (id: string, name: string, args: unknown): ProviderChunk => ({
  type: "tool_call",
  toolCalls: [{ id, index: 0, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

describe("externalized read continuation", () => {
  let db: any;
  let workspace = "";

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "morrow-read-continuation-")));
    db = openDatabase(":memory:");
    seedYolo(db, workspace);
  });

  afterEach(() => {
    try { db.close(); } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it("does not rewrite a file after an externalized read reports its content authoritatively", async () => {
    const body = "const ready = true;\n".repeat(900);
    const requests: ChatMessage[][] = [];
    let turn = 0;
    const provider: AiProvider = {
      id: "mock",
      async *streamChat(messages: ChatMessage[], _options: StreamOptions): AsyncIterable<ProviderChunk> {
        requests.push(structuredClone(messages));
        if (turn++ === 0) {
          yield tool("write", "create_file", { path: "public/app.js", content: body });
        } else if (turn === 2) {
          yield tool("read", "read_file", { path: "public/app.js" });
        } else {
          const readMessage = [...messages].reverse().find((message) => message.role === "tool" && message.toolCallId === "read")?.content ?? "";
          if (!readMessage.includes('"read_succeeded":true') || !readMessage.includes("const ready = true;")) {
            yield tool("rewrite", "create_file", { path: "public/app.js", content: body });
          } else {
            yield { type: "text", text: "The generated file is correct; continuing." };
          }
        }
        yield done;
      },
    };

    const runner = new TaskRunner(db, async (dependency) => executeAgentChatTask({ db: dependency.db, taskId: "t", provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    const writes = conversationsRepository(db).listToolCallsForTask("t")
      .filter((call) => call.toolName === "create_file" && JSON.parse(call.argsJson).path === "public/app.js");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.argsJson).content).toBe(body);
    expect(readFileSync(join(workspace, "public", "app.js"), "utf8")).toBe(body);

    const read = conversationsRepository(db).listToolCallsForTask("t").find((call) => call.id === "read");
    expect(read?.contextResultJson).toContain('"read_succeeded":true');
    expect(read?.contextResultJson).toContain("const ready = true;");
    expect(requests.length).toBeGreaterThanOrEqual(3);
  });

  it("materializes a legacy completed read with direct content for restart projection", () => {
    const body = "export const ready = true;\n".repeat(900);
    const now = new Date().toISOString();
    const call = conversationsRepository(db).upsertToolCall({
      id: "legacy-read",
      messageId: "ma",
      taskId: "t",
      toolName: "read_file",
      argsJson: JSON.stringify({ path: "public/app.js" }),
      resultJson: body,
      status: "completed",
      createdAt: now,
      completedAt: now,
    });

    const context = JSON.parse(call.contextResultJson ?? "{}") as Record<string, any>;
    expect(context.read_succeeded).toBe(true);
    expect(context.path).toBe("public/app.js");
    expect(context.content).toContain("export const ready = true;");
    expect(context.content).not.toBe(body);
    expect(context.artifactId).toBeUndefined();
    expect(Buffer.byteLength(call.contextResultJson ?? "", "utf8")).toBeLessThan(8 * 1024);
  });
});
