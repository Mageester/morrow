import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { agentsRepository } from "../src/repositories/agents.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { approvalsRepository } from "../src/repositories/approvals.js";
import { teamsRepository } from "../src/repositories/teams.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { MockProvider } from "../src/provider/mock.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { MissionService } from "../src/mission/service.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { AskTeammateSchema } from "@morrow/contracts";
import { getTool } from "../src/tools/catalog.js";

function now() { return new Date().toISOString(); }
const tool = (id: string, name: string, args: unknown) => ({
  type: "tool_call" as const,
  toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
});
const done = { type: "done" as const };

describe("model-initiated ask_teammate", () => {
  let db: ReturnType<typeof openDatabase>;
  let workspace = "";

  beforeEach(() => {
    db = openDatabase(":memory:");
    workspace = mkdtempSync(join(tmpdir(), "morrow-ask-teammate-"));
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: workspace, createdAt: now() });
  });

  afterEach(() => {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  function seedParent(agentId?: string, autoApprove = false, missionId?: string) {
    const conversations = conversationsRepository(db);
    conversations.createConversation({ id: "c1", projectId: "p1", title: "Parent", agentId: agentId ?? null, createdAt: now(), updatedAt: now() });
    conversations.appendMessage({ id: "u1", conversationId: "c1", role: "user", content: "Ask a teammate for help.", createdAt: now(), updatedAt: now() });
    const task = taskRepository(db).createTask({ id: "parent", projectId: "p1", kind: "agent_chat", status: "queued", ...(agentId ? { agentId } : {}), ...(missionId ? { missionId } : {}), createdAt: now() });
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
        mode: "agent", autoApprove,
      },
      createdAt: now(),
    });
    taskRecordsRepository(db).transitionAgentState(task.id, { id: "state-parent", state: "idle", details: {}, createdAt: now() });
    return task;
  }

  it("declares a strict ask_teammate tool shape", () => {
    const spec = getTool("ask_teammate");
    expect(spec).toMatchObject({ name: "ask_teammate", sideEffect: "execute", enabled: true });
    expect(spec?.parameters).toMatchObject({
      agentId: { type: "string" },
      objective: { type: "string" },
    });
    expect(AskTeammateSchema.safeParse({ agentId: "a", objective: "help" }).success).toBe(true);
    expect(AskTeammateSchema.safeParse({ agentId: "a", objective: "help", providerId: "openai" }).success).toBe(false);
  });

  /**
   * Observed live: a `morrow build` worker called ask_teammate, which created a
   * pending approval in a run with nobody to answer it. The mission then sat
   * until its 35-minute timeout having written a single file. Delegation needs
   * somebody to ask AND somebody to approve; a mission worker has neither, and
   * missions dispatch their own workers anyway.
   */
  it("never leaves an unattended mission waiting on an approval nobody can answer", async () => {
    const target = agentsRepository(db).create({ id: "target-agent", projectId: "p1", name: "Research", role: "researcher" });
    const missionId = new MissionService({
      repo: missionsRepository(db),
      getWorkspacePath: () => workspace,
      backupDir: join(workspace, ".morrow-checkpoints"),
    }).create("p1", { objective: "Build the thing end to end" }).id;
    seedParent(undefined, true, missionId);
    const provider = new MockProvider({ chunks: [
      [tool("delegate", "ask_teammate", { agentId: target.id, objective: "do the whole thing" }), done],
      [{ type: "text", text: "I completed the objective myself." }, done],
      [{ type: "text", text: "Nothing further remains." }, done],
    ], delayMs: 1 });

    await executeAgentChatTask({ db, taskId: "parent", provider, maxTurns: 8 });

    // Either the tool was never offered, or the call failed fast. What must
    // never happen is a pending approval left standing in an unattended run.
    expect(approvalsRepository(db).listByTask("parent").filter((a) => a.status === "pending")).toHaveLength(0);
    const call = conversationsRepository(db).listToolCallsForTask("parent").find((c) => c.id === "delegate");
    if (call) {
      expect(call.status).toBe("failed");
      expect(JSON.parse(call.resultJson!).kind).toBe("delegation_unavailable_unattended");
    }
  });

  it("does not expose ask_teammate when the project has no teammates to ask", async () => {
    // Not a statement about who may delegate — Morrow itself may. There is
    // simply nobody in this project, and a delegation tool with an empty
    // roster only invites an invented agentId.
    seedParent();
    const provider = new MockProvider({ chunks: [[{ type: "text", text: "finished" }, done]] });
    await executeAgentChatTask({ db, taskId: "parent", provider, maxTurns: 2 });
    expect(provider.requests[0]?.flatMap((message) => message.toolCalls ?? []).map((call) => call.function.name)).not.toContain("ask_teammate");
    expect(JSON.stringify(provider.requests[0] ?? [])).not.toContain("ask_teammate");
    const profileEvent = taskRecordsRepository(db).listEvents("parent").find((event) => event.type === "optimization.tool_profile_selected");
    expect(profileEvent?.payload.tools).not.toContain("ask_teammate");
  });

  it("exposes ask_teammate to Morrow itself, with the roster of teammates the user created", async () => {
    // The reported defect: teammates created in a project were unreachable
    // from the main Morrow chat, which is the surface people actually use.
    // ask_teammate was gated on the turn running as a named agent profile, so
    // the orchestrator was never given the tool and was never even told the
    // teammates existed.
    const target = agentsRepository(db).create({ id: "target-agent", projectId: "p1", name: "Research", role: "researcher" });
    seedParent(); // no agentId: this is Morrow, not a named teammate

    const provider = new MockProvider({ chunks: [[{ type: "text", text: "ready" }, done]] });
    await executeAgentChatTask({ db, taskId: "parent", provider, maxTurns: 2 });

    const profileEvent = taskRecordsRepository(db).listEvents("parent").find((event) => event.type === "optimization.tool_profile_selected");
    expect(profileEvent?.payload.tools).toContain("ask_teammate");
    const systemPrompt = provider.requests[0]?.filter((message) => message.role === "system").map((message) => message.content).join("\n") ?? "";
    expect(systemPrompt).toContain(target.id);
    expect(systemPrompt).toContain("Research");
  });

  it("Morrow holds no standing trust, so its delegation still stops for a one-shot approval", async () => {
    // A standing grant binds a caller teammate to a target. Morrow is not a
    // teammate and can hold no grant, so it must never inherit auto-approval
    // from the parent task's autoApprove flag.
    const target = agentsRepository(db).create({ id: "target-agent", projectId: "p1", name: "Research", role: "researcher" });
    seedParent(undefined, true); // autoApprove requested by the parent

    const spawned = vi.fn(() => ({ taskId: "child", agentId: target.id, providerId: "mock", model: "mock-model" }));
    const provider = new MockProvider({ chunks: [[tool("tc1", "ask_teammate", { agentId: target.id, objective: "look into it" }), done], [{ type: "text", text: "asked" }, done]] });
    const running = executeAgentChatTask({ db, taskId: "parent", provider, maxTurns: 3, teammateSpawner: spawned } as any);

    // The run parks on the approval rather than resolving, exactly as it does
    // for a named teammate: poll for it instead of awaiting the task.
    const started = Date.now();
    let approvalId = "";
    while (!approvalId && Date.now() - started < 5000) {
      approvalId = approvalsRepository(db).listByTask("parent").find((approval) => approval.status === "pending")?.id ?? "";
      if (!approvalId) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(approvalId).not.toBe("");
    expect(spawned).not.toHaveBeenCalled();
    expect(approvalsRepository(db).get(approvalId)?.details).toMatchObject({
      tool: "ask_teammate",
      targetAgentId: target.id,
      approvalMode: "allow_once_only",
    });
    const trust = taskRecordsRepository(db).listEvents("parent").find((event) => event.type === "delegation.trust_evaluated");
    expect(trust?.payload.granted).toBe(false);
    expect(trust?.payload.reason).toBe("no_agent_profile");

    const app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    const allow = await app.inject({ method: "POST", url: `/api/approvals/${approvalId}/resolve`, payload: { projectId: "p1", decision: "allow_once" } });
    expect(allow.statusCode).toBe(200);
    await running;
    expect(spawned).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("exposes an explicitly allowed ask_teammate to a legacy allow-list with a safe target roster", async () => {
    const parentAgent = agentsRepository(db).create({ id: "parent-agent", projectId: "p1", name: "Implementer", role: "custom" });
    const targetAgent = agentsRepository(db).create({ id: "target-agent", projectId: "p1", name: "Research", role: "researcher" });
    const disabledAgent = agentsRepository(db).create({ id: "disabled-agent", projectId: "p1", name: "Disabled", role: "researcher" });
    agentsRepository(db).update(disabledAgent.id, "p1", { enabled: false });
    teamsRepository(db).create({ id: "team-1", projectId: "p1", name: "Team", createdAt: now() });
    const teamAgent = agentsRepository(db).create({ id: "team-agent", projectId: "p1", name: "Team member", role: "researcher", teamId: "team-1" });
    projectRepository(db).createProject({ id: "p2", name: "P2", workspacePath: "C:/other", createdAt: now() });
    const otherProjectAgent = agentsRepository(db).create({ id: "other-project-agent", projectId: "p2", name: "Other project", role: "researcher" });
    agentsRepository(db).update(otherProjectAgent.id, "p2", { enabled: true });
    seedParent(parentAgent.id);
    // A legacy imported profile has an explicit allow-list. Adding one tool
    // must not make that profile fall back to the unrestricted default.
    agentsRepository(db).upsertToolPermission(parentAgent.id, { toolName: "read_file", effect: "allow" });
    agentsRepository(db).upsertToolPermission(parentAgent.id, { toolName: "ask_teammate", effect: "allow" });

    const provider = new MockProvider({ chunks: [[{ type: "text", text: "ready" }, done]] });
    await executeAgentChatTask({ db, taskId: "parent", provider, maxTurns: 2 });

    const profileEvent = taskRecordsRepository(db).listEvents("parent").find((event) => event.type === "optimization.tool_profile_selected");
    expect(profileEvent?.payload.tools).toContain("ask_teammate");
    expect(profileEvent?.payload.tools).not.toContain("run_command");
    const systemPrompt = provider.requests[0]?.filter((message) => message.role === "system").map((message) => message.content).join("\n") ?? "";
    expect(systemPrompt).toContain("agentId");
    expect(systemPrompt).toContain("target-agent");
    expect(systemPrompt).toContain("Research");
    expect(systemPrompt).not.toContain("other-project-agent");
    expect(systemPrompt).not.toContain(disabledAgent.id);
    expect(systemPrompt).not.toContain(teamAgent.id);
  });

  it("requires a one-shot approval even when the parent requested auto approval", async () => {
    const parentAgent = agentsRepository(db).create({ id: "parent-agent", projectId: "p1", name: "Parent", role: "researcher" });
    const targetAgent = agentsRepository(db).create({ id: "target-agent", projectId: "p1", name: "Research", role: "researcher" });
    seedParent(parentAgent.id, true);
    const spawned = vi.fn(() => ({ taskId: "child", agentId: targetAgent.id, providerId: "mock", model: "mock-model" }));
    const provider = new MockProvider({ chunks: [
      [tool("ask-1", "ask_teammate", { agentId: targetAgent.id, objective: "Check the release notes. SECRET=redact-me" }), done],
      [{ type: "text", text: "The teammate was asked." }, done],
    ] });
    const running = executeAgentChatTask({
      db,
      taskId: "parent",
      provider,
      maxTurns: 3,
      teammateSpawner: spawned,
    } as any);
    const started = Date.now();
    let approvalId = "";
    while (!approvalId && Date.now() - started < 5000) {
      approvalId = approvalsRepository(db).listByTask("parent").find((approval) => approval.status === "pending")?.id ?? "";
      if (!approvalId) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(approvalId).not.toBe("");
    expect(spawned).not.toHaveBeenCalled();
    const profileEvent = taskRecordsRepository(db).listEvents("parent").find((event) => event.type === "optimization.tool_profile_selected");
    expect(profileEvent?.payload.tools).toContain("ask_teammate");
    const approval = approvalsRepository(db).get(approvalId)!;
    expect(approval.details).toMatchObject({ tool: "ask_teammate", toolCallId: "ask-1", targetAgentId: targetAgent.id, approvalMode: "allow_once_only" });
    expect(approval.details.targetProfileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(approval.details)).not.toContain("redact-me");

    const app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    const trust = await app.inject({ method: "POST", url: `/api/approvals/${approvalId}/resolve`, payload: { projectId: "p1", decision: "trust_project", trustPattern: "ask_teammate" } });
    expect(trust.statusCode).toBe(400);
    expect(approvalsRepository(db).get(approvalId)?.status).toBe("pending");
    const allow = await app.inject({ method: "POST", url: `/api/approvals/${approvalId}/resolve`, payload: { projectId: "p1", decision: "allow_once" } });
    expect(allow.statusCode).toBe(200);
    await running;
    expect(spawned).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("fails closed when child startup fails and redacts spawn errors", async () => {
    const parentAgent = agentsRepository(db).create({ id: "parent-agent", projectId: "p1", name: "Parent", role: "researcher" });
    const targetAgent = agentsRepository(db).create({ id: "target-agent", projectId: "p1", name: "Research", role: "researcher" });
    seedParent(parentAgent.id, false);
    const spawned = vi.fn(() => { throw new Error("provider stdout SECRET=do-not-leak"); });
    const provider = new MockProvider({ chunks: [
      [tool("ask-fail", "ask_teammate", { agentId: targetAgent.id, objective: "Check one bounded thing" }), done],
      [{ type: "text", text: "The request could not be started." }, done],
    ] });
    const running = executeAgentChatTask({ db, taskId: "parent", provider, maxTurns: 3, teammateSpawner: spawned } as any);
    const started = Date.now();
    let approvalId = "";
    while (!approvalId && Date.now() - started < 5000) {
      approvalId = approvalsRepository(db).listByTask("parent").find((approval) => approval.status === "pending")?.id ?? "";
      if (!approvalId) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(approvalId).not.toBe("");
    const app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    const allow = await app.inject({ method: "POST", url: `/api/approvals/${approvalId}/resolve`, payload: { projectId: "p1", decision: "allow_once" } });
    expect(allow.statusCode).toBe(200);
    await running;
    expect(spawned).toHaveBeenCalledTimes(1);
    const toolCall = conversationsRepository(db).listToolCallsForTask("parent").find((call) => call.toolName === "ask_teammate");
    expect(toolCall?.resultJson).not.toContain("SECRET=do-not-leak");
    expect(toolCall?.resultJson).toContain("The teammate could not be started");
    await app.close();
  });

  it("rejects approval when the target profile drifts after the prompt", async () => {
    const parentAgent = agentsRepository(db).create({ id: "parent-agent", projectId: "p1", name: "Parent", role: "researcher" });
    const targetAgent = agentsRepository(db).create({ id: "target-agent", projectId: "p1", name: "Research", role: "researcher" });
    seedParent(parentAgent.id, false);
    const spawned = vi.fn(() => ({ taskId: "child", agentId: targetAgent.id, providerId: "mock", model: "mock-model" }));
    const provider = new MockProvider({ chunks: [
      [tool("ask-drift", "ask_teammate", { agentId: targetAgent.id, objective: "Check one bounded thing" }), done],
      [{ type: "text", text: "The request needs fresh approval." }, done],
    ] });
    const running = executeAgentChatTask({ db, taskId: "parent", provider, maxTurns: 3, teammateSpawner: spawned } as any);
    const started = Date.now();
    let approvalId = "";
    while (!approvalId && Date.now() - started < 5000) {
      approvalId = approvalsRepository(db).listByTask("parent").find((approval) => approval.status === "pending")?.id ?? "";
      if (!approvalId) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(approvalId).not.toBe("");
    agentsRepository(db).update(targetAgent.id, "p1", { modelOverride: "drifted-model" });
    const app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    const allow = await app.inject({ method: "POST", url: `/api/approvals/${approvalId}/resolve`, payload: { projectId: "p1", decision: "allow_once" } });
    expect(allow.statusCode).toBe(200);
    await running;
    expect(spawned).not.toHaveBeenCalled();
    expect(conversationsRepository(db).listToolCallsForTask("parent").find((call) => call.toolName === "ask_teammate")?.resultJson).toContain("profile changed");
    await app.close();
  });

  it("does not spawn a child when the parent is cancelled while awaiting approval", async () => {
    const parentAgent = agentsRepository(db).create({ id: "parent-agent", projectId: "p1", name: "Parent", role: "researcher" });
    const targetAgent = agentsRepository(db).create({ id: "target-agent", projectId: "p1", name: "Research", role: "researcher" });
    seedParent(parentAgent.id, false);
    const spawned = vi.fn(() => ({ taskId: "child", agentId: targetAgent.id, providerId: "mock", model: "mock-model" }));
    const abortController = new AbortController();
    const provider = new MockProvider({ chunks: [[tool("ask-cancel", "ask_teammate", { agentId: targetAgent.id, objective: "Wait for approval" }), done]] });
    const running = executeAgentChatTask({
      db,
      taskId: "parent",
      provider,
      maxTurns: 3,
      abortSignal: abortController.signal,
      teammateSpawner: spawned,
    } as any);
    const started = Date.now();
    let approvalId = "";
    while (!approvalId && Date.now() - started < 5000) {
      approvalId = approvalsRepository(db).listByTask("parent").find((approval) => approval.status === "pending")?.id ?? "";
      if (!approvalId) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(approvalId).not.toBe("");
    abortController.abort();
    await running;
    expect(spawned).not.toHaveBeenCalled();
    expect(taskRepository(db).getTaskById("parent")?.status).toBe("cancelled");
    expect(taskRepository(db).listChildren("parent")).toHaveLength(0);
  });

  it("leaves one consistent interrupted state when the approved profile changed before execution", async () => {
    const agents = agentsRepository(db);
    const target = agents.create({ id: "stale-target", projectId: "p1", name: "Research", role: "researcher" });
    const conversations = conversationsRepository(db);
    conversations.createConversation({ id: "c-stale", projectId: "p1", title: "Delegated: Research", agentId: target.id, createdAt: now(), updatedAt: now() });
    taskRepository(db).createTask({ id: "child-stale", projectId: "p1", kind: "agent_chat", status: "queued", agentId: target.id, createdAt: now() });
    const userMessage = conversations.appendMessage({ id: "u-stale", conversationId: "c-stale", role: "user", content: "Do the bounded thing.", taskId: "child-stale", createdAt: now(), updatedAt: now() });
    taskRoutingRepository(db).upsert({
      taskId: "child-stale",
      presetId: "best-quality",
      providerId: "mock",
      model: "mock-model",
      useMemory: false,
      decision: {
        version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model",
        reason: "test", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [],
        mode: "agent", autoApprove: false,
      },
      createdAt: now(),
    });
    // Approve-time binding that no longer matches the live profile.
    db.prepare("UPDATE tasks SET expected_agent_profile_hash='stale-hash' WHERE id='child-stale'").run();

    const provider = new MockProvider({ chunks: [[{ type: "text", text: "should never run" }, done]] });
    await executeAgentChatTask({ db, taskId: "child-stale", provider, maxTurns: 2 } as any);

    expect(taskRepository(db).getTaskById("child-stale")?.status).toBe("cancelled");
    const agentState = taskRecordsRepository(db).getAgentState("child-stale");
    expect(agentState?.state).toBe("interrupted");
    expect(agentState?.details?.reason).toBe("agent_profile_changed");
    const message = conversations.listMessages("c-stale").find((m) => m.id === userMessage.id);
    expect(message?.streamingState).toBe("interrupted");
  });
});
