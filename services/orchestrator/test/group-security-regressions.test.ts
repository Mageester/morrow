import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { ReadBudget, ReadBudgetExceeded } from "../src/execution/read-budget.js";
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

    // Three pages of 12 KB against a 30 KB ceiling: the third does not fit.
    // Few enough turns that the run reaches the ceiling before a compaction
    // boundary, which legitimately releases the budget it accounts for.
    const pages: ProviderChunk[][] = Array.from({ length: 3 }, (_, index) => [
      tool(`read-${index + 1}`, "read_artifact", { id: artifact.id, offset: index * 12_000, length: 12_000 }),
      done,
    ]);
    pages.push([{ type: "text" as const, text: "The budget stopped the third page." }, done]);
    pages.push([{ type: "text" as const, text: "There is no smaller slice worth reading." }, done]);
    const provider = new MockProvider({ chunks: pages });
    await executeAgentChatTask({ db, taskId: "task-1", provider, maxContextBytes: 30_000, maxTurns: 20 });

    const calls = conversations.listToolCallsForTask("task-1");
    expect(calls.find((call) => call.id === "read-1")?.resultJson).toContain('"returnedBytes":12000');
    // Paging cannot walk past the ceiling: the third page is refused. The
    // refusal names the *cumulative* budget rather than implying this page was
    // oversized, so a model can act on it instead of retrying the same call.
    const refusal = calls.find((call) => call.id === "read-3")?.resultJson ?? "";
    expect(refusal).toContain("Read budget exhausted");
    expect(refusal).toContain("will fail the same way");
    // Room remains, so the guidance points at the affordable slice rather than
    // telling the model to give up on reading entirely.
    expect(refusal).toContain("use offset to read a range");
  });

  /**
   * The per-segment budget is released by compaction, because those bytes
   * genuinely leave the provider request. On its own that is escapable: read
   * to the ceiling, force a rollover, read again, forever. A second ceiling
   * bounds the whole task and is never released.
   */
  it("cannot page unbounded bytes by repeatedly rolling the segment over", () => {
    const budget = new ReadBudget(30_000, 90_000);
    // Three segments' worth is allowed: a long legitimate task does compact.
    for (let segment = 0; segment < 3; segment++) {
      expect(() => budget.charge(30_000, "A large sweep")).not.toThrow();
      budget.releaseForCompaction();
    }
    expect(budget.lifetimeConsumedBytes).toBe(90_000);
    // The fourth is refused even though the per-segment counter is empty.
    expect(budget.consumedBytes).toBe(0);
    let message = "";
    try { budget.charge(1_000, "One more read"); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("Task read limit reached");
    expect(message).toContain("compaction does not reset");
    // And it stays refused: releasing again does not restore it.
    budget.releaseForCompaction();
    expect(() => budget.charge(1_000, "One more read")).toThrow(ReadBudgetExceeded);
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
