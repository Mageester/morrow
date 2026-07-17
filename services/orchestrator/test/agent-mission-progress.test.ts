import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { missionRuntimeRepository } from "../src/repositories/mission-runtime.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import type { AiProvider, ProviderChunk } from "../src/provider/base.js";

/** Write-mode routing so workspace tools run without an approval wait. */
function routeWriteMode(taskId: string): void {
  const at = new Date().toISOString();
  taskRoutingRepository(db).upsert({
    taskId,
    presetId: "balanced",
    providerId: "mock",
    model: "mock-model",
    useMemory: false,
    createdAt: at,
    decision: {
      version: 1, presetId: "balanced", providerId: "mock", model: "mock-model",
      reason: "test", fallbackUsed: false, overridden: true, privacy: "local-only",
      candidates: [], mode: "agent", toolProfile: "agent", autoApprove: true,
    },
  });
}

const MISSION_ID = "mission-progress";
let workspace: string;
let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "morrow-agent-progress-"));
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
  rmSync(workspace, { recursive: true, force: true });
});

function seedMissionTask(): void {
  const at = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: at });
  missionsRepository(db).create({
    id: MISSION_ID,
    projectId: "p",
    objective: "Create the report artifact and verify it.",
    autoApprove: true,
    budget: { maxUsd: null, maxAttempts: null, maxReviewCycles: 2, spentUsd: 0, attemptsUsed: 0, reviewCyclesUsed: 0 },
  }, at);
  missionRuntimeRepository(db).create({ missionId: MISSION_ID, now: at });
  const convs = conversationsRepository(db);
  convs.createConversation({ id: "c", projectId: "p", title: "C", createdAt: at, updatedAt: at });
  convs.appendMessage({ id: "u", conversationId: "c", role: "user", content: "Create report.txt and finish.", createdAt: at, updatedAt: at });
  taskRepository(db).createTask({ id: "t", projectId: "p", missionId: MISSION_ID, kind: "agent_chat", status: "queued", createdAt: at });
  convs.appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "", taskId: "t", streamingState: "queued", createdAt: at, updatedAt: at });
  routeWriteMode("t");
}

describe("production agent execution emits durable progress", () => {
  it("writes evidence-backed progress observations to the mission ledger", async () => {
    seedMissionTask();
    let call = 0;
    const provider: AiProvider = {
      id: "mock",
      async *streamChat(): AsyncIterable<ProviderChunk> {
        const index = call++;
        if (index === 0) {
          yield { type: "tool_call", toolCalls: [{ id: "w", index: 0, type: "function", function: { name: "create_file", arguments: JSON.stringify({ path: "report.txt", content: "first\n" }) } }] };
        } else if (index === 1) {
          // Same tool, same path, different content: the old signature-only rule
          // still credits this, but the point is the artifact hash moves.
          yield { type: "tool_call", toolCalls: [{ id: "w2", index: 0, type: "function", function: { name: "create_file", arguments: JSON.stringify({ path: "report.txt", content: "second\n" }) } }] };
        } else {
          yield { type: "text", text: "Created report.txt." };
        }
        yield { type: "done" };
      },
    };

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 6 });

    const progress = missionRuntimeRepository(db).listProgress(MISSION_ID);
    // The acceptance scenario is not running here. Only production execution
    // could have written these rows.
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.map((item) => item.kind)).toContain("artifact_changed");
    expect(progress.every((item) => item.missionId === MISSION_ID)).toBe(true);
  });

  it("stores no file contents, credentials, or provider payloads in observations", async () => {
    seedMissionTask();
    writeFileSync(join(workspace, ".env"), "API_KEY=super-secret-value");
    let call = 0;
    const provider: AiProvider = {
      id: "mock",
      async *streamChat(): AsyncIterable<ProviderChunk> {
        const index = call++;
        if (index === 0) {
          yield { type: "tool_call", toolCalls: [{ id: "w", index: 0, type: "function", function: { name: "create_file", arguments: JSON.stringify({ path: "notes.txt", content: "TOKEN=leaked-content-value" }) } }] };
        } else {
          yield { type: "text", text: "Done." };
        }
        yield { type: "done" };
      },
    };

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 4 });

    const serialized = JSON.stringify(missionRuntimeRepository(db).listProgress(MISSION_ID));
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("leaked-content-value");
    expect(serialized).not.toContain(".env");
  });

  it("keeps a standalone task working without a mission ledger", async () => {
    const at = new Date().toISOString();
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: at });
    const convs = conversationsRepository(db);
    convs.createConversation({ id: "c", projectId: "p", title: "C", createdAt: at, updatedAt: at });
    convs.appendMessage({ id: "u", conversationId: "c", role: "user", content: "Create report.txt.", createdAt: at, updatedAt: at });
    taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: at });
    convs.appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "", taskId: "t", streamingState: "queued", createdAt: at, updatedAt: at });
    routeWriteMode("t");

    let call = 0;
    const provider: AiProvider = {
      id: "mock",
      async *streamChat(): AsyncIterable<ProviderChunk> {
        if (call++ === 0) {
          yield { type: "tool_call", toolCalls: [{ id: "w", index: 0, type: "function", function: { name: "create_file", arguments: JSON.stringify({ path: "report.txt", content: "standalone\n" }) } }] };
        } else {
          yield { type: "text", text: "Created report.txt." };
        }
        yield { type: "done" };
      },
    };

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 4 });
    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
  });
});
