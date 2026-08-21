import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { conversationContextRefsRepository } from "../src/repositories/conversation-context-refs.js";
import { toolArtifactsRepository } from "../src/repositories/tool-artifacts.js";
import { externalizeToolResult, renderExternalizedForContext } from "../src/execution/artifact-externalization.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { MockProvider } from "../src/provider/mock.js";
import type { ProviderChunk } from "../src/provider/base.js";

const NOW = "2026-08-20T12:00:00.000Z";

const tool = (id: string, name: string, args: unknown) => ({
  type: "tool_call" as const,
  toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
});
const done = { type: "done" as const };

describe("group coordination security regressions", () => {
  let db: ReturnType<typeof openDatabase>;
  let workspace: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    workspace = mkdtempSync(join(tmpdir(), "morrow-group-security-"));
  });

  afterEach(() => {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("counts read_artifact bytes cumulatively against the task context budget", async () => {
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: workspace, createdAt: NOW });
    const conversations = conversationsRepository(db);
    conversations.createConversation({ id: "c1", projectId: "p1", title: "Artifact budget", createdAt: NOW, updatedAt: NOW });
    conversations.appendMessage({ id: "user-1", conversationId: "c1", role: "user", content: "Read the supplied artifact twice.", createdAt: NOW, updatedAt: NOW });
    taskRepository(db).createTask({ id: "task-1", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: NOW });
    conversations.appendMessage({ id: "assistant-1", conversationId: "c1", role: "assistant", content: "", taskId: "task-1", streamingState: "queued", createdAt: NOW, updatedAt: NOW });
    taskRecordsRepository(db).transitionAgentState("task-1", { id: "state-1", state: "idle", details: {}, createdAt: NOW });
    taskRoutingRepository(db).upsert({
      taskId: "task-1", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false, createdAt: NOW,
      decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "test", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", toolProfile: "agent", autoApprove: true },
    });
    const artifact = externalizeToolResult(toolArtifactsRepository(db), "x".repeat(60_000), { taskId: "task-1", toolName: "run_command", kind: "tool_result", now: NOW });
    if (artifact.kind !== "artifact") throw new Error("expected artifact");
    conversations.upsertToolCall({
      id: "prior-artifact", messageId: "assistant-1", taskId: "task-1", toolName: "run_command",
      argsJson: "{}", resultJson: "complete", contextResultJson: renderExternalizedForContext(artifact), status: "completed", createdAt: NOW, completedAt: NOW,
    });

    const pages: ProviderChunk[][] = Array.from({ length: 11 }, (_, index) => [
      tool(`read-${index + 1}`, "read_artifact", { id: artifact.id, offset: index * 3_000, length: 3_000 }),
      done,
    ]);
    pages.push([{ type: "text" as const, text: "The budget stopped the eleventh page." }, done]);
    const provider = new MockProvider({ chunks: pages });
    await executeAgentChatTask({ db, taskId: "task-1", provider, maxContextBytes: 30_000, maxTurns: 20 });

    const calls = conversations.listToolCallsForTask("task-1");
    expect(calls.find((call) => call.id === "read-1")?.resultJson).toContain('"returnedBytes":3000');
    expect(calls.find((call) => call.id === "read-11")?.resultJson).toContain("Raw byte budget ceiling");
  });

  it("keeps per-task ownership for deduped artifacts and deduplicates context refs", () => {
    const projects = projectRepository(db);
    const tasks = taskRepository(db);
    projects.createProject({ id: "artifact-project", name: "Artifacts", workspacePath: workspace, createdAt: NOW });
    for (const id of ["artifact-source-a", "artifact-source-b", "artifact-target"]) {
      tasks.createTask({ id, projectId: "artifact-project", kind: "agent_chat", status: "completed", createdAt: NOW });
    }

    const artifacts = toolArtifactsRepository(db);
    const content = "shared artifact payload\n".repeat(2_000);
    const first = artifacts.create({ taskId: "artifact-source-a", toolName: "run_command", kind: "tool_result", contentType: "text/plain", content }, NOW);
    const later = artifacts.create({ taskId: "artifact-source-b", toolName: "run_command", kind: "tool_result", contentType: "text/plain", content }, NOW);
    expect(later.id).toBe(first.id);
    expect(db.prepare("SELECT task_id FROM tool_artifacts WHERE id=?").get(first.id)).toEqual({ task_id: "artifact-source-a" });
    expect(db.prepare("SELECT task_id FROM tool_artifact_task_refs WHERE artifact_id=? ORDER BY task_id").all(first.id)).toEqual([
      { task_id: "artifact-source-a" },
      { task_id: "artifact-source-b" },
    ]);

    const refs = conversationContextRefsRepository(db);
    expect(() => refs.validateSourceRefs("artifact-project", "artifact-source-b", [{ kind: "artifact", id: first.id }])).not.toThrow();
    refs.attach({ projectId: "artifact-project", sourceTaskId: "artifact-source-b", targetTaskId: "artifact-target", refs: [{ kind: "artifact", id: first.id }], now: NOW });
    refs.attach({ projectId: "artifact-project", sourceTaskId: "artifact-source-b", targetTaskId: "artifact-target", refs: [{ kind: "artifact", id: first.id }], now: NOW });
    expect(refs.listForTask("artifact-target")).toHaveLength(1);
  });
});
