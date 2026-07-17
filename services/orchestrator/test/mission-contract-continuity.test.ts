import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import type { AiProvider, ProviderChunk } from "../src/provider/base.js";

/** A provider that always fails to start with a retryable transport error —
 * forces the provider-fallback path, which persists a durable checkpoint. */
function throwingProvider(message: string): AiProvider {
  return {
    // eslint-disable-next-line require-yield
    async *streamChat(): AsyncIterable<ProviderChunk> {
      throw new Error(message);
    },
  } as unknown as AiProvider;
}

const MISSION_PROMPT = [
  "Build the complete Mission Control web application with all interactions.",
  "You must implement every panel, add tests, and verify in a real browser.",
  "The build must pass and screenshots are required as proof.",
  "Do not push to main and never delete existing files.",
].join("\n");

// Beta.31 regression: after a manual continuation ("continue"), the durable
// checkpoint re-derived the mission contract from the trivial continuation
// prompt — the original definition of done was destroyed and a scaffold-only
// result was treated as completion. The contract must be immutable across
// checkpoints of one task AND inherited by a continuation task in the same
// conversation.
describe("mission contract continuity across checkpoints and continuations", () => {
  let db: Database.Database;
  const tempDir = join(process.cwd(), "test-temp-contract-" + Math.random().toString(36).slice(2));

  beforeEach(() => {
    db = openDatabase(":memory:");
    mkdirSync(tempDir, { recursive: true });
    const ts = new Date().toISOString();
    projectRepository(db).createProject({ id: "p1", name: "MC", workspacePath: tempDir, createdAt: ts });
    conversationsRepository(db).createConversation({ id: "c1", projectId: "p1", title: "MC", createdAt: ts, updatedAt: ts });
    conversationsRepository(db).appendMessage({ id: "mu1", conversationId: "c1", role: "user", content: MISSION_PROMPT, createdAt: ts, updatedAt: ts });
    taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: ts });
    conversationsRepository(db).appendMessage({ id: "ma1", conversationId: "c1", role: "assistant", content: "", taskId: "t1", streamingState: "queued", createdAt: ts, updatedAt: ts });
  });
  afterEach(() => {
    db.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  async function runTask(taskId: string): Promise<void> {
    const secondary = new MockProvider({ chunks: [[{ type: "text", text: "progress" }, { type: "done" }]] });
    (secondary as unknown as { id: string }).id = "secondary";
    await executeAgentChatTask({
      db,
      taskId,
      provider: throwingProvider("ECONNREFUSED"),
      fallbackProviders: [secondary],
    });
  }

  it("captures the full mission contract in the first durable checkpoint", async () => {
    await runTask("t1");
    const checkpoint = executionContinuityRepository(db).latestCheckpoint("t1");
    expect(checkpoint).toBeTruthy();
    expect(checkpoint!.snapshot.originalMission).toBe(MISSION_PROMPT);
    expect(checkpoint!.snapshot.acceptanceCriteria.join("\n")).toContain("must implement every panel");
    expect(checkpoint!.snapshot.prohibitedActions.join("\n")).toContain("Do not push to main");
  });

  it("a continuation task inherits the original contract instead of re-deriving it from 'continue'", async () => {
    await runTask("t1");
    const ts = new Date().toISOString();
    conversationsRepository(db).appendMessage({ id: "mu2", conversationId: "c1", role: "user", content: "continue", createdAt: ts, updatedAt: ts });
    taskRepository(db).createTask({ id: "t2", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: ts });
    conversationsRepository(db).appendMessage({ id: "ma2", conversationId: "c1", role: "assistant", content: "", taskId: "t2", streamingState: "queued", createdAt: ts, updatedAt: ts });
    await runTask("t2");

    const checkpoint = executionContinuityRepository(db).latestCheckpoint("t2");
    expect(checkpoint).toBeTruthy();
    // The definition of done survives the manual continuation.
    expect(checkpoint!.snapshot.originalMission).toBe(MISSION_PROMPT);
    expect(checkpoint!.snapshot.hardRequirements).toEqual([MISSION_PROMPT]);
    expect(checkpoint!.snapshot.acceptanceCriteria.join("\n")).toContain("must implement every panel");
    expect(checkpoint!.snapshot.prohibitedActions.join("\n")).toContain("never delete existing files");
  });

  it("a genuinely new mission prompt starts a new contract (no false inheritance)", async () => {
    await runTask("t1");
    const ts = new Date().toISOString();
    const newMission = "Audit the repository dependency tree and produce a licensing report. You must list every license.";
    conversationsRepository(db).appendMessage({ id: "mu3", conversationId: "c1", role: "user", content: newMission, createdAt: ts, updatedAt: ts });
    taskRepository(db).createTask({ id: "t3", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: ts });
    conversationsRepository(db).appendMessage({ id: "ma3", conversationId: "c1", role: "assistant", content: "", taskId: "t3", streamingState: "queued", createdAt: ts, updatedAt: ts });
    await runTask("t3");

    const checkpoint = executionContinuityRepository(db).latestCheckpoint("t3");
    expect(checkpoint!.snapshot.originalMission).toBe(newMission);
  });
});
