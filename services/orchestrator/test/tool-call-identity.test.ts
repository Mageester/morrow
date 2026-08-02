import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";

const NOW = "2026-08-02T12:00:00.000Z";

/**
 * `message_tool_calls` is keyed globally on the tool-call id, and its
 * conflicting upsert refreshes only the lifecycle fields — status, result,
 * timestamps — because a single call legitimately writes several times as it
 * moves requested -> running -> completed.
 *
 * That design makes a genuine COLLISION between two tasks look exactly like a
 * normal lifecycle update, and lose data in total silence: the second task's
 * call overwrites the first task's row and is never recorded. It is how a
 * per-turn ordinal tool-call id in the Gemini adapter caused every Gemini
 * conversation after the first to show zero tool calls, undetected across
 * multiple releases and a green 2,659-test suite.
 *
 * The adapter-side fix (a per-stream nonce) is guarded in
 * provider-conformance.test.ts. This is the other half: the store itself now
 * refuses the write, so the next adapter to make the same mistake fails loudly
 * at the first collision instead of quietly discarding transcripts.
 */
describe("tool-call identity is enforced by the store, not just by adapters", () => {
  let db: ReturnType<typeof openDatabase>;
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "morrow-tool-identity-"));
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: NOW });
    conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "C", createdAt: NOW, updatedAt: NOW });
    for (const taskId of ["task-one", "task-two"]) {
      taskRepository(db).createTask({ id: taskId, projectId: "p", kind: "agent_chat", status: "running", createdAt: NOW });
      conversationsRepository(db).appendMessage({
        id: `assistant-${taskId}`, conversationId: "c", role: "assistant", content: "",
        taskId, streamingState: "streaming", createdAt: NOW, updatedAt: NOW,
      });
    }
  });

  afterEach(() => {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const call = (taskId: string, id: string, toolName: string, status: "requested" | "completed") => ({
    id, messageId: `assistant-${taskId}`, taskId, toolName,
    argsJson: JSON.stringify({ path: `${toolName}.txt` }),
    status, createdAt: NOW,
  });

  it("advances a call through its own lifecycle without complaint", () => {
    const convs = conversationsRepository(db);
    convs.upsertToolCall(call("task-one", "tc-1", "read_file", "requested"));
    const completed = convs.upsertToolCall({ ...call("task-one", "tc-1", "read_file", "completed"), resultJson: "ok", completedAt: NOW });
    expect(completed.status).toBe("completed");
    expect(completed.resultJson).toBe("ok");
    // The name and arguments recorded on the first write remain the truth.
    expect(completed.toolName).toBe("read_file");
    expect(convs.listToolCallsForTask("task-one")).toHaveLength(1);
  });

  it("refuses a write that lands on another task's row instead of silently overwriting it", () => {
    const convs = conversationsRepository(db);
    convs.upsertToolCall(call("task-one", "gemini-tool-0", "read_file", "completed"));

    // The exact shape of the shipped defect: a second task mints the same
    // ordinal id for a different tool.
    expect(() => convs.upsertToolCall(call("task-two", "gemini-tool-0", "list_files", "requested")))
      .toThrow(/collision/i);

    // The first task's record is intact, and the second task's is absent
    // rather than misattributed — the failure is visible, not lossy.
    const survivor = convs.getToolCall("gemini-tool-0")!;
    expect(survivor.taskId).toBe("task-one");
    expect(survivor.toolName).toBe("read_file");
    expect(convs.listToolCallsForTask("task-two")).toEqual([]);
  });

  it("names the offending id and both tasks so the minting adapter is identifiable", () => {
    const convs = conversationsRepository(db);
    convs.upsertToolCall(call("task-one", "gemini-tool-0", "read_file", "completed"));
    let message = "";
    try {
      convs.upsertToolCall(call("task-two", "gemini-tool-0", "list_files", "requested"));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("gemini-tool-0");
    expect(message).toContain("task-one");
    expect(message).toContain("task-two");
  });

  it("keeps distinct ids from different tasks independent", () => {
    const convs = conversationsRepository(db);
    convs.upsertToolCall(call("task-one", "gemini-tool-abc12345-0", "read_file", "completed"));
    convs.upsertToolCall(call("task-two", "gemini-tool-def67890-0", "list_files", "completed"));
    expect(convs.listToolCallsForTask("task-one")).toHaveLength(1);
    expect(convs.listToolCallsForTask("task-two")).toHaveLength(1);
  });
});
