import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { MockProvider } from "../src/provider/mock.js";

function now() { return new Date().toISOString(); }
const done = { type: "done" as const };

/**
 * A turn that only thinks and calls tools reports nothing: reasoning is
 * streamed to a separate view and is never the answer. The instruction that
 * asks for a line of ordinary text between tool calls used to live inside the
 * Build-mode block, so Ask and Plan — which can read for minutes at a stretch
 * — were free to go completely dark. It ships for every mode now.
 */
describe("work narration instruction", () => {
  let db: ReturnType<typeof openDatabase>;
  let workspace = "";

  beforeEach(() => {
    db = openDatabase(":memory:");
    workspace = mkdtempSync(join(tmpdir(), "morrow-narration-"));
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: workspace, createdAt: now() });
  });

  afterEach(() => {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  async function systemPromptForMode(mode: "agent" | "read-only" | "plan-only"): Promise<string> {
    const conversations = conversationsRepository(db);
    conversations.createConversation({ id: "c1", projectId: "p1", title: "T", createdAt: now(), updatedAt: now() });
    conversations.appendMessage({ id: "u1", conversationId: "c1", role: "user", content: "look at this project", createdAt: now(), updatedAt: now() });
    const task = taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: now() });
    conversations.appendMessage({ id: "a1", conversationId: "c1", role: "assistant", content: "", taskId: task.id, streamingState: "queued", createdAt: now(), updatedAt: now() });
    taskRoutingRepository(db).upsert({
      taskId: task.id,
      presetId: "best-quality",
      providerId: "mock",
      model: "mock-model",
      useMemory: false,
      decision: {
        version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model",
        reason: "test", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [],
        mode, autoApprove: false,
      },
      createdAt: now(),
    });
    taskRecordsRepository(db).transitionAgentState(task.id, { id: "s1", state: "idle", details: {}, createdAt: now() });

    const provider = new MockProvider({ chunks: [[{ type: "text", text: "done" }, done]] });
    await executeAgentChatTask({ db, taskId: task.id, provider, maxTurns: 2 });
    return provider.requests[0]?.filter((m) => m.role === "system").map((m) => m.content).join("\n") ?? "";
  }

  const NARRATION = "Say what you are doing in ordinary text as you work";

  it.each(["agent", "read-only", "plan-only"] as const)(
    "asks for narration between tool calls in %s mode",
    async (mode) => {
      expect(await systemPromptForMode(mode)).toContain(NARRATION);
    },
  );

  it("ships the narration instruction exactly once, not duplicated per mode block", async () => {
    const prompt = await systemPromptForMode("agent");
    expect(prompt.split(NARRATION).length - 1).toBe(1);
  });

  it("still scopes the mode-specific instructions to their own mode", async () => {
    expect(await systemPromptForMode("agent")).toContain("Build mode: you may change this project");
  });
});
