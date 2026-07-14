import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { ProviderError, type AiProvider, type ChatMessage, type ProviderChunk } from "../src/provider/base.js";
import { TaskRunner } from "../src/runner.js";
import { reconcileTasksOnStartup } from "../src/recovery.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { countChatTokens, measureProviderRequest } from "../src/execution/context-budget.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { MissionService } from "../src/mission/service.js";
import { buildServer } from "../src/server.js";

describe("durable agent segments", () => {
  it("enforces the unattended segment cap before a context-pressure rollover", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "morrow-segment-cap-"));
    const db = openDatabase(":memory:");
    try {
      const at = new Date().toISOString();
      projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: at });
      const convs = conversationsRepository(db);
      convs.createConversation({ id: "c", projectId: "p", title: "C", createdAt: at, updatedAt: at });
      convs.appendMessage({ id: "old-u", conversationId: "c", role: "user", content: "OLD_CONTEXT ".repeat(140_000), createdAt: new Date(Date.parse(at) + 1).toISOString(), updatedAt: at });
      convs.appendMessage({ id: "old-a", conversationId: "c", role: "assistant", content: "Old response", createdAt: new Date(Date.parse(at) + 2).toISOString(), updatedAt: at });
      convs.appendMessage({ id: "u", conversationId: "c", role: "user", content: "Continue safely.", createdAt: new Date(Date.parse(at) + 3).toISOString(), updatedAt: at });
      taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: new Date(Date.parse(at) + 4).toISOString() });
      convs.appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "", taskId: "t", streamingState: "queued", createdAt: new Date(Date.parse(at) + 4).toISOString(), updatedAt: at });
      let providerCalls = 0;
      const provider: AiProvider = {
        id: "deepseek",
        route: { providerId: "deepseek", protocol: "openai-chat", endpointKind: "default", endpointHost: "api.deepseek.com", endpointLimitTokens: 131_072, endpointLimitSource: "provider-metadata" },
        async *streamChat(): AsyncIterable<ProviderChunk> {
          providerCalls++;
          yield { type: "text", text: "should not run" };
          yield { type: "done" };
        },
      };

      await executeAgentChatTask({ db, taskId: "t", provider, maxContextBytes: 4_000_000, maxAutomaticSegments: 1 });

      expect(providerCalls).toBe(0);
      expect(taskRepository(db).getTaskById("t")?.status).toBe("interrupted");
      expect(executionContinuityRepository(db).listSegments("t")).toHaveLength(1);
      expect(taskRecordsRepository(db).listEvents("t").some((event) => event.payload.reason === "segment_budget_exhausted")).toBe(true);
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("checkpoints and automatically continues across an adaptive turn boundary", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "morrow-segments-"));
    const db = openDatabase(":memory:");
    try {
      mkdirSync(workspace, { recursive: true });
      for (let i = 0; i < 25; i++) writeFileSync(join(workspace, `evidence-${i}.txt`), `evidence ${i}`);
      const at = new Date().toISOString();
      projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: at });
      conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "C", createdAt: at, updatedAt: at });
      conversationsRepository(db).appendMessage({ id: "u", conversationId: "c", role: "user", content: "Read all evidence and finish without asking me to continue.", createdAt: at, updatedAt: at });
      taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: at });
      conversationsRepository(db).appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "", taskId: "t", streamingState: "queued", createdAt: at, updatedAt: at });

      let providerCalls = 0;
      const provider: AiProvider = {
        id: "mock",
        route: { providerId: "mock", protocol: "mock", endpointKind: "injected", endpointHost: null, endpointLimitTokens: 131_072, endpointLimitSource: "endpoint-override" },
        async *streamChat(): AsyncIterable<ProviderChunk> {
          const index = providerCalls++;
          if (index < 25) {
            yield { type: "tool_call", toolCalls: [{ id: `read-${index}`, index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `evidence-${index}.txt` }) } }] };
          } else {
            yield { type: "text", text: "Verified final result." };
          }
          yield { type: "done" };
        },
      };

      await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 1 });

      expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
      expect(providerCalls).toBe(26);
      const continuity = executionContinuityRepository(db);
      expect(continuity.listSegments("t").map((segment) => segment.status)).toEqual(["checkpointed", "completed"]);
      const checkpoint = continuity.latestCheckpoint("t")!;
      expect(checkpoint.snapshot.originalMission).toContain("Read all evidence");
      expect(checkpoint.snapshot.hardRequirements).toContain("Read all evidence and finish without asking me to continue.");
      expect(checkpoint.cursor).toBeGreaterThan(0);
      expect(conversationsRepository(db).getMessage("a")?.content).toBe("Verified final result.");
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("recovers a retryable provider failure through a fresh durable segment", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "morrow-provider-recovery-"));
    const db = openDatabase(":memory:");
    try {
      const at = new Date().toISOString();
      projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: at });
      conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "C", createdAt: at, updatedAt: at });
      conversationsRepository(db).appendMessage({ id: "u", conversationId: "c", role: "user", content: "Finish despite a transient provider failure.", createdAt: at, updatedAt: at });
      taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: at });
      conversationsRepository(db).appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "", taskId: "t", streamingState: "queued", createdAt: at, updatedAt: at });
      let calls = 0;
      const provider: AiProvider = {
        id: "mock",
        async *streamChat(): AsyncIterable<ProviderChunk> {
          calls++;
          if (calls === 1) throw new ProviderError("network", "connection reset", { kind: "network", retryable: true });
          yield { type: "text", text: "Recovered final result." };
          yield { type: "done" };
        },
      };

      await executeAgentChatTask({ db, taskId: "t", provider });

      expect(calls).toBe(2);
      expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
      expect(executionContinuityRepository(db).listSegments("t").map((segment) => segment.status)).toEqual(["checkpointed", "completed"]);
      expect(executionContinuityRepository(db).latestCheckpoint("t")?.snapshot.recoveryAttempts).toBeDefined();
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("resumes from checkpoint after restart without duplicating writes or turns", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "morrow-restart-segment-"));
    const db = openDatabase(":memory:");
    try {
      const at = new Date().toISOString();
      writeFileSync(join(workspace, "result.txt"), "written once\n");
      projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: at });
      const convs = conversationsRepository(db);
      convs.createConversation({ id: "c", projectId: "p", title: "C", createdAt: at, updatedAt: at });
      convs.appendMessage({ id: "u", conversationId: "c", role: "user", content: "Preserve result.txt, verify, and finish after restart.", createdAt: at, updatedAt: at });
      taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "running", createdAt: at });
      convs.appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "PHASE_ONE", taskId: "t", streamingState: "streaming", createdAt: at, updatedAt: at });
      convs.upsertToolCall({ id: "write-once", messageId: "a", taskId: "t", toolName: "create_file", argsJson: JSON.stringify({ path: "result.txt", content: "written once\n" }), resultJson: JSON.stringify({ created: true }), status: "completed", createdAt: at, startedAt: at, completedAt: at });
      const continuity = executionContinuityRepository(db);
      const deadOwnerId = "morrow-pid:999999999:restart";
      const segment = continuity.openSegment({ taskId: "t", missionId: null, providerId: "mock", model: "mock-model", routeJson: {}, ownerId: deadOwnerId, now: at, leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
      continuity.recordProviderTurn({ id: "turn-1", taskId: "t", segmentId: segment.id, turnKey: "durable-turn-1", ordinal: 1, assistantText: "PHASE_ONE", toolCalls: [{ id: "write-once", name: "create_file", arguments: JSON.stringify({ path: "result.txt", content: "written once\n" }) }], ownerId: deadOwnerId, generation: segment.generation, now: at });
      continuity.saveCheckpoint({ id: "cp", taskId: "t", missionId: null, segmentId: segment.id, cursor: 1, snapshot: { version: 1, originalMission: "Preserve result.txt, verify, and finish after restart.", hardRequirements: ["Preserve result.txt"], prohibitedActions: [], acceptanceCriteria: ["finish after restart"], decisions: [], completedWork: ["created result.txt"], currentPhase: "verification", filesChanged: ["result.txt"], gitStatus: "?? result.txt", tests: [], unresolvedFailures: [], recoveryAttempts: [], pendingWork: ["final answer"], approvals: {}, taskId: "t", missionId: null, providerRouting: {}, providerContinuationRefs: [], evidenceRequired: ["final answer"] }, ownerId: deadOwnerId, generation: segment.generation, now: at });

      const requests: ChatMessage[][] = [];
      const provider: AiProvider = {
        id: "mock",
        async *streamChat(messages): AsyncIterable<ProviderChunk> {
          requests.push(structuredClone(messages));
          yield { type: "text", text: "RESTARTED_FINAL" };
          yield { type: "done" };
        },
      };
      const runner = new TaskRunner(db, async (deps) => executeAgentChatTask({ db: deps.db, taskId: deps.taskId, provider, ...(deps.abortSignal ? { abortSignal: deps.abortSignal } : {}), ...(deps.recovery ? { recovery: deps.recovery } : {}) }));

      expect(reconcileTasksOnStartup({ db, runner }).requeued).toBe(1);
      await runner.waitFor("t");

      expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(["PHASE_ONE"]);
      expect(requests[0]!.filter((message) => message.role === "tool")).toHaveLength(1);
      expect(convs.listToolCallsForMessage("a")).toHaveLength(1);
      expect(continuity.listProviderTurns("t")).toHaveLength(2);
      expect(continuity.getCanonicalAnswer("t")?.content).toBe("RESTARTED_FINAL");
      expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe("written once\n");
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("completes a crash-persisted final turn without calling the provider again", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "morrow-final-turn-replay-"));
    const db = openDatabase(":memory:");
    try {
      const at = new Date().toISOString();
      projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: at });
      const convs = conversationsRepository(db);
      convs.createConversation({ id: "c", projectId: "p", title: "C", createdAt: at, updatedAt: at });
      convs.appendMessage({ id: "u", conversationId: "c", role: "user", content: "Finish once.", createdAt: at, updatedAt: at });
      taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "running", createdAt: at });
      convs.appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "old narrationFINAL_ONCE", taskId: "t", streamingState: "streaming", createdAt: at, updatedAt: at });
      const continuity = executionContinuityRepository(db);
      const deadOwnerId = "morrow-pid:999999999:final";
      const segment = continuity.openSegment({ taskId: "t", missionId: null, providerId: "mock", model: "mock-model", routeJson: {}, ownerId: deadOwnerId, now: at, leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
      continuity.recordProviderTurn({ id: "final-turn", taskId: "t", segmentId: segment.id, turnKey: "final-key", ordinal: 1, assistantText: "FINAL_ONCE", toolCalls: [], isFinal: true, ownerId: deadOwnerId, generation: segment.generation, now: at });
      continuity.saveCheckpoint({ id: "cp", taskId: "t", missionId: null, segmentId: segment.id, cursor: 1, snapshot: { version: 1, originalMission: "Finish once.", hardRequirements: ["Finish once."], prohibitedActions: [], acceptanceCriteria: [], decisions: [], completedWork: [], currentPhase: "final", filesChanged: [], gitStatus: "", tests: [], unresolvedFailures: [], recoveryAttempts: [], pendingWork: [], approvals: {}, taskId: "t", missionId: null, providerRouting: {}, providerContinuationRefs: [], evidenceRequired: ["final answer"] }, ownerId: deadOwnerId, generation: segment.generation, now: at });
      let providerCalls = 0;
      const provider: AiProvider = { id: "mock", async *streamChat(): AsyncIterable<ProviderChunk> { providerCalls++; yield { type: "text", text: "DUPLICATE" }; yield { type: "done" }; } };
      const runner = new TaskRunner(db, async (deps) => executeAgentChatTask({ db: deps.db, taskId: deps.taskId, provider, ...(deps.recovery ? { recovery: deps.recovery } : {}) }));

      expect(reconcileTasksOnStartup({ db, runner, now: () => new Date(Date.parse(at) + 10 * 60_000).toISOString() }).requeued).toBe(1);
      await runner.waitFor("t");

      expect(providerCalls).toBe(0);
      expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
      expect(continuity.getCanonicalAnswer("t")?.content).toBe("FINAL_ONCE");
      expect(convs.getMessage("a")?.content).toBe("FINAL_ONCE");
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reproduces task 852da246 class across context, turn, restart, provider failure, verification, and one final result", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "morrow-852da246-"));
    const dbPath = join(workspace, ".morrow-incident.sqlite");
    let db = openDatabase(dbPath);
    try {
      const at = new Date().toISOString();
      for (let i = 1; i < 24; i++) writeFileSync(join(workspace, `evidence-${i}.txt`), `evidence ${i}`);
      projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: at });
      const completion = async (_messages: ChatMessage[], options: { purpose: "planning" | "review" }) => options.purpose === "review"
        ? { text: JSON.stringify({ verdict: "approved", recommendedStatus: "completed", criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [], concerns: [], summary: "All durable execution evidence is verified." }), provider: "mock", model: "independent-reviewer" }
        : { text: "[]", provider: "mock", model: "planner" };
      let missionService = new MissionService({
        repo: missionsRepository(db),
        getWorkspacePath: () => workspace,
        backupDir: join(workspace, ".morrow-checkpoints"),
        completion,
      });
      const mission = missionService.create("p", { objective: "Create result.txt once, preserve all requirements across recovery, verify the work, and return one authoritative final result." });
      const verificationCriterion = missionService.addCriterion(mission.id, "The recovered mission passes its required verification command", { kind: "command", command: "node --version", expectExitCode: 0 });
      missionService.addCriterion(mission.id, "An independent reviewer approves the recovered mission", { kind: "review" });
      missionService.approveCriteria(mission.id);
      let convs = conversationsRepository(db);
      convs.createConversation({ id: "c", projectId: "p", title: "Incident reproduction", createdAt: at, updatedAt: at });
      const oldContext = "OLD_CONTEXT ".repeat(140_000);
      expect(countChatTokens([{ role: "user", content: oldContext }], { providerId: "deepseek", model: "deepseek-v4-flash" }).tokens).toBeGreaterThan(148_403);
      convs.appendMessage({ id: "old-u", conversationId: "c", role: "user", content: oldContext, createdAt: new Date(Date.parse(at) + 1).toISOString(), updatedAt: at });
      convs.appendMessage({ id: "old-a", conversationId: "c", role: "assistant", content: "Old narration that must not recursively amplify.", createdAt: new Date(Date.parse(at) + 2).toISOString(), updatedAt: at });
      convs.appendMessage({ id: "u", conversationId: "c", role: "user", content: "Create result.txt once, inspect the evidence, survive restart, run verification, and return one final result.", createdAt: new Date(Date.parse(at) + 3).toISOString(), updatedAt: at });
      taskRepository(db).createTask({ id: "852da246-615d-481a-812e-550791ca89b3", projectId: "p", missionId: mission.id, kind: "agent_chat", status: "queued", createdAt: new Date(Date.parse(at) + 4).toISOString() });
      convs.appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "", taskId: "852da246-615d-481a-812e-550791ca89b3", streamingState: "queued", createdAt: new Date(Date.parse(at) + 4).toISOString(), updatedAt: at });
      taskRoutingRepository(db).upsert({ taskId: "852da246-615d-481a-812e-550791ca89b3", presetId: "balanced", providerId: "deepseek", model: "deepseek-v4-flash", useMemory: false, createdAt: at, decision: { version: 1, presetId: "balanced", providerId: "deepseek", model: "deepseek-v4-flash", reason: "reproduction", fallbackUsed: false, overridden: true, privacy: "cloud", candidates: [], mode: "agent", toolProfile: "agent", autoApprove: true } });

      let phaseOneCalls = 0;
      const sentMeasurements: number[] = [];
      const route = { providerId: "deepseek", protocol: "openai-chat" as const, endpointKind: "default" as const, endpointHost: "api.deepseek.com", endpointLimitTokens: 131_072, endpointLimitSource: "provider-metadata" as const };
      const firstProvider: AiProvider = {
        id: "deepseek", route,
        async *streamChat(messages, options): AsyncIterable<ProviderChunk> {
          sentMeasurements.push(measureProviderRequest({ providerId: "deepseek", model: "deepseek-v4-flash", protocol: "openai-chat", messages, tools: options.tools ?? [], outputReserveTokens: options.maxOutputTokens ?? 2_048 }).totalRequestTokens);
          const index = phaseOneCalls++;
          if (index === 0) yield { type: "tool_call", toolCalls: [{ id: "write-result", index: 0, type: "function", function: { name: "create_file", arguments: JSON.stringify({ path: "result.txt", content: "written once\n" }) } }] };
          else yield { type: "tool_call", toolCalls: [{ id: `read-${index}`, index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `evidence-${index}.txt` }) } }] };
          yield { type: "done" };
        },
      };

      let simulatedStop = false;
      try {
        await executeAgentChatTask({
          db, taskId: "852da246-615d-481a-812e-550791ca89b3", provider: firstProvider,
          maxTurns: 1, maxContextBytes: 4_000_000,
          onSegmentBoundary: (reason) => { if (reason === "turn_budget") throw new Error("SIMULATED_ORCHESTRATOR_STOP"); },
        });
      } catch (error) {
        if (error instanceof Error && error.message === "SIMULATED_ORCHESTRATOR_STOP") simulatedStop = true;
        else throw error;
      }
      expect(simulatedStop, JSON.stringify({ task: taskRepository(db).getTaskById("852da246-615d-481a-812e-550791ca89b3"), events: taskRecordsRepository(db).listEvents("852da246-615d-481a-812e-550791ca89b3").slice(-5) })).toBe(true);
      expect(taskRepository(db).getTaskById("852da246-615d-481a-812e-550791ca89b3")?.status).toBe("running");
      expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe("written once\n");
      db.prepare("UPDATE agent_execution_segments SET owner_id=? WHERE task_id=? AND status='running'")
        .run("morrow-pid:999999999:simulated-stopped-process", "852da246-615d-481a-812e-550791ca89b3");
      db.close();
      db = openDatabase(dbPath);
      convs = conversationsRepository(db);
      missionService = new MissionService({
        repo: missionsRepository(db),
        getWorkspacePath: () => workspace,
        backupDir: join(workspace, ".morrow-checkpoints"),
        completion,
      });

      let restartedCalls = 0;
      const restartedProvider: AiProvider = {
        id: "deepseek", route,
        async *streamChat(messages, options): AsyncIterable<ProviderChunk> {
          sentMeasurements.push(measureProviderRequest({ providerId: "deepseek", model: "deepseek-v4-flash", protocol: "openai-chat", messages, tools: options.tools ?? [], outputReserveTokens: options.maxOutputTokens ?? 2_048 }).totalRequestTokens);
          restartedCalls++;
          if (restartedCalls === 1) throw new ProviderError("network", "recoverable connection reset", { kind: "network", retryable: true });
          if (restartedCalls === 2) {
            yield { type: "tool_call", toolCalls: [{ id: "verify-node", index: 0, type: "function", function: { name: "run_command", arguments: JSON.stringify({ executable: "node", args: ["--version"], purpose: "verification" }) } }] };
          } else {
            yield { type: "text", text: "ONE_AUTHORITATIVE_FINAL_RESULT" };
          }
          yield { type: "done" };
        },
      };
      const runner = new TaskRunner(db, async (deps) => executeAgentChatTask({ db: deps.db, taskId: deps.taskId, provider: restartedProvider, maxContextBytes: 4_000_000, ...(deps.abortSignal ? { abortSignal: deps.abortSignal } : {}), ...(deps.recovery ? { recovery: deps.recovery } : {}) }));
      expect(reconcileTasksOnStartup({ db, runner, now: () => new Date(Date.parse(at) + 10 * 60_000).toISOString() }).requeued).toBe(1);
      await runner.waitFor("852da246-615d-481a-812e-550791ca89b3");

      const taskId = "852da246-615d-481a-812e-550791ca89b3";
      expect(taskRepository(db).getTaskById(taskId)?.status).toBe("completed");
      expect(sentMeasurements.every((tokens) => tokens <= 131_072)).toBe(true);
      expect(convs.listToolCallsForMessage("a").filter((call) => call.id === "write-result")).toHaveLength(1);
      expect(convs.listToolCallsForMessage("a").find((call) => call.id === "verify-node")?.status).toBe("completed");
      expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe("written once\n");
      expect(executionContinuityRepository(db).listSegments(taskId).length).toBeGreaterThanOrEqual(3);
      expect(executionContinuityRepository(db).getCanonicalAnswer(taskId)?.content).toBe("ONE_AUTHORITATIVE_FINAL_RESULT");
      expect(taskRecordsRepository(db).listEvents(taskId).filter((event) => event.type === "task.completed")).toHaveLength(1);
      expect(taskRecordsRepository(db).listEvents(taskId).filter((event) => event.payload.reason === "user_continue")).toHaveLength(0);

      const verification = await missionService.verifyCriterion(mission.id, verificationCriterion.id);
      expect(verification.evidence.status).toBe("passed");
      expect((await missionService.runReview(mission.id)).verdict).toBe("approved");
      expect(missionService.finalize(mission.id).status).toBe("completed");

      const app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
      const finalizeResponse = await app.inject({ method: "POST", url: `/api/missions/${mission.id}/finalize` });
      await app.close();
      expect(finalizeResponse.statusCode, finalizeResponse.body).toBe(200);
      expect(finalizeResponse.json().status).toBe("completed");
      const canonical = executionContinuityRepository(db).getCanonicalAnswer(taskId);
      expect(canonical?.missionId).toBe(mission.id);
      expect(canonical?.content).toBe("ONE_AUTHORITATIVE_FINAL_RESULT");
      expect(canonical?.evidenceJson).toMatchObject({ status: "completed", reviewVerdict: "approved" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_task_answers WHERE mission_id=?").get(mission.id)).toEqual({ count: 1 });
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
