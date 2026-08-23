import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { agentsRepository } from "../src/repositories/agents.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { teamsRepository } from "../src/repositories/teams.js";
import { delegationsRepository } from "../src/repositories/delegations.js";
import {
  spawnAgentChatSubagent,
} from "../src/mission/task-dispatcher.js";
import {
  resolveStandaloneTeammateTarget,
  TeammateSpawnRegistry,
} from "../src/tools/teammate-delegation.js";
import { buildAgentExecutionPolicy } from "../src/security/agent-execution-policy.js";
import { projectThreadHandoffs } from "../src/web/handoff-projection.js";

function now() { return new Date().toISOString(); }

describe("model-authored teammate dispatch boundary", () => {
  let db: ReturnType<typeof openDatabase>;
  let previousMockProvider: string | undefined;
  let run: ReturnType<typeof vi.fn<(taskId: string) => void>>;

  beforeEach(() => {
    previousMockProvider = process.env.MOCK_PROVIDER;
    process.env.MOCK_PROVIDER = "true";
    db = openDatabase(":memory:");
    run = vi.fn<(taskId: string) => void>();
    projectRepository(db).createProject({ id: "p1", name: "Project", workspacePath: "/workspace", createdAt: now() });
    projectRepository(db).createProject({ id: "p2", name: "Other", workspacePath: "/other", createdAt: now() });
  });

  afterEach(() => {
    db.close();
    if (previousMockProvider === undefined) delete process.env.MOCK_PROVIDER;
    else process.env.MOCK_PROVIDER = previousMockProvider;
  });

  function seedParent(agentId = "caller") {
    const caller = agentsRepository(db).create({ id: agentId, projectId: "p1", name: "Caller", role: "researcher" });
    taskRepository(db).createTask({
      id: "parent",
      projectId: "p1",
      kind: "agent_chat",
      status: "running",
      agentId: caller.id,
      createdAt: now(),
    });
    return caller;
  }

  it("refuses disabled, cross-project, self, team, and unknown targets", () => {
    const caller = seedParent();
    const disabled = agentsRepository(db).create({ id: "disabled", projectId: "p1", name: "Disabled", role: "researcher" });
    agentsRepository(db).update(disabled.id, "p1", { enabled: false });
    const crossProject = agentsRepository(db).create({ id: "cross", projectId: "p2", name: "Cross", role: "researcher" });
    teamsRepository(db).create({ id: "team-1", projectId: "p1", name: "Team", createdAt: now() });
    const team = agentsRepository(db).create({ id: "team", projectId: "p1", name: "Team", role: "researcher", teamId: "team-1" });

    const parent = { id: "parent", projectId: "p1", agentId: caller.id };
    const cases = [
      [disabled, "AGENT_DISABLED"],
      [crossProject, "AGENT_CROSS_PROJECT"],
      [caller, "AGENT_SELF"],
      [team, "AGENT_TEAM_TARGET"],
      [undefined, "AGENT_NOT_FOUND"],
    ] as const;
    for (const [target, code] of cases) {
      const currentTarget = target ? agentsRepository(db).get(target.id) : undefined;
      expect(() => resolveStandaloneTeammateTarget(parent, currentTarget, currentTarget?.id ?? "missing"))
        .toThrowError(expect.objectContaining({ code }));
      expect(() => spawnAgentChatSubagent(
        { db, runner: { run }, env: process.env },
        parent,
        currentTarget?.id ?? "missing",
        "bounded objective",
        { modelInitiated: true },
      )).toThrowError(expect.objectContaining({ code: code === "AGENT_NOT_FOUND" ? "NOT_FOUND" : code }));
    }
    expect(run).not.toHaveBeenCalled();
    expect(taskRepository(db).listChildren("parent")).toHaveLength(0);
  });

  it("refuses the simple model spawn path for a team caller", () => {
    const caller = seedParent();
    teamsRepository(db).create({ id: "caller-team", projectId: "p1", name: "Caller team", createdAt: now() });
    agentsRepository(db).update(caller.id, "p1", { teamId: "caller-team" });
    const target = agentsRepository(db).create({ id: "standalone-target", projectId: "p1", name: "Target", role: "researcher" });

    expect(() => spawnAgentChatSubagent(
      { db, runner: { run }, env: process.env },
      { id: "parent", projectId: "p1", agentId: caller.id },
      target.id,
      "bounded objective",
      { modelInitiated: true },
    )).toThrowError(expect.objectContaining({ code: "TEAM_AGENT_REQUIRES_DELEGATION" }));
    expect(run).not.toHaveBeenCalled();
    expect(taskRepository(db).listChildren("parent")).toHaveLength(0);
  });

  it("stores the approved profile hash on delegation-bound children", () => {
    seedParent();
    teamsRepository(db).create({ id: "team-1", projectId: "p1", name: "Team", createdAt: now() });
    const target = agentsRepository(db).create({ id: "team-target", projectId: "p1", name: "Verifier", role: "tester", teamId: "team-1" });
    delegationsRepository(db).create({
      id: "del-1", parentTaskId: "parent", teamId: "team-1", agentId: target.id,
      objective: "Verify the findings", acceptanceCriteria: [], contextSnapshotRef: "task:parent",
      allowedTools: [], allowedMemoryScopes: [], allowedWriteMemoryScopes: [],
      providerId: null, model: null,
      budget: { maxProviderCalls: null, maxTokenBudget: null, maxWallClockMs: null },
      approvalRequired: true, deadlineAt: null, correlationId: "corr-del-1", createdAt: now(),
    });

    const result = spawnAgentChatSubagent(
      { db, runner: { run }, env: process.env },
      { id: "parent", projectId: "p1" },
      target.id,
      "Verify the findings",
      { deferRun: true, delegationId: "del-1", targetProfileHash: "approved-hash" },
    );
    // The approve-time fingerprint rides on the task row so execution start
    // can refuse a profile that changed after the user said yes — the same
    // binding ask_teammate already carries.
    expect(taskRepository(db).getExpectedAgentProfileHash(result.task.id)).toBe("approved-hash");
    expect(run).not.toHaveBeenCalled(); // deferRun
  });

  it("reuses the durable child when a delegation spawn replays instead of forking a second", () => {
    seedParent();
    teamsRepository(db).create({ id: "team-1", projectId: "p1", name: "Team", createdAt: now() });
    const target = agentsRepository(db).create({ id: "team-target-2", projectId: "p1", name: "Verifier", role: "tester", teamId: "team-1" });
    delegationsRepository(db).create({
      id: "del-9", parentTaskId: "parent", teamId: "team-1", agentId: target.id,
      objective: "Verify the findings", acceptanceCriteria: [], contextSnapshotRef: "task:parent",
      allowedTools: [], allowedMemoryScopes: [], allowedWriteMemoryScopes: [],
      providerId: null, model: null,
      budget: { maxProviderCalls: null, maxTokenBudget: null, maxWallClockMs: null },
      approvalRequired: true, deadlineAt: null, correlationId: "corr-del-9", createdAt: now(),
    });

    const deps = { db, runner: { run }, env: process.env };
    const parent = { id: "parent", projectId: "p1" };
    const options = { deferRun: true as const, delegationId: "del-9" };
    // Simulates a crash (or client retry) between the first spawn and the
    // durable approveAndStart: the retry must land on the same deferred
    // child, not fork a second orphaned bundle.
    const first = spawnAgentChatSubagent(deps, parent, target.id, "Verify the findings", options);
    const second = spawnAgentChatSubagent(deps, parent, target.id, "Verify the findings", options);
    expect(second.task.id).toBe(first.task.id);
    expect(taskRepository(db).listChildren("parent")).toHaveLength(1);
  });

  it("suppresses duplicate in-process and post-restart spawns, while binding the child to its own profile", () => {
    const caller = seedParent();
    const target = agentsRepository(db).create({
      id: "target",
      projectId: "p1",
      name: "Target",
      role: "tester",
      providerOverride: "mock",
      modelOverride: "target-model",
      memoryReadScopes: ["project"],
      memoryWriteScopes: [],
      maxProviderCalls: 2,
      maxTokenBudget: 1200,
      maxWallClockMs: 10_000,
    });
    agentsRepository(db).upsertToolPermission(target.id, { toolName: "read_file", effect: "allow" });
    const registry = new TeammateSpawnRegistry();
    const deps = { db, runner: { run }, env: process.env };
    const parent = { id: "parent", projectId: "p1", agentId: caller.id };

    const objective = "Inspect only the target scope; SECRET=child-input";
    const first = spawnAgentChatSubagent(deps, parent, target.id, objective, {
      modelInitiated: true,
      toolCallId: "call-1",
      registry,
    });
    const duplicate = spawnAgentChatSubagent(deps, parent, target.id, objective, {
      modelInitiated: true,
      toolCallId: "call-1",
      registry,
    });

    // With registry eviction, the duplicate resolves through the durable
    // idempotency key rather than the process-local cache: same committed
    // child, runner still called exactly once.
    expect(duplicate.replayed).toBe(true);
    expect(duplicate.task.id).toBe(first.task.id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(taskRepository(db).listChildren("parent")).toHaveLength(1);
    expect(first.task.parentTaskId).toBe("parent");
    expect(first.task.agentId).toBe(target.id);
    // The conversation is found through the child user message, not through
    // the parent transcript; this is the projection the restart path reuses.
    const childAssistant = db.prepare("SELECT conversation_id FROM conversation_messages WHERE task_id=? LIMIT 1").get(first.task.id) as { conversation_id: string };
    const childMessage = conversationsRepository(db).listMessages(childAssistant.conversation_id).find((message) => message.role === "user")!;
    expect(childMessage.content).toContain(objective);
    expect(childMessage.content).not.toContain("parent secret");
    const childConversation = conversationsRepository(db).getConversation(childAssistant.conversation_id)!;
    expect(childConversation.agentId).toBe(target.id);
    expect(childConversation.title).not.toContain("child-input");
    expect(taskRoutingRepository(db).get(first.task.id)).toMatchObject({ providerId: "mock", model: "target-model" });

    // A fresh process-local registry cannot see the first call, but the
    // durable idempotency key still returns the committed child and does not
    // call the runner again.
    const restarted = spawnAgentChatSubagent(deps, parent, target.id, objective, {
      modelInitiated: true,
      toolCallId: "call-1",
      registry: new TeammateSpawnRegistry(),
    });
    expect(restarted.replayed).toBe(true);
    expect(restarted.task.id).toBe(first.task.id);
    expect(run).toHaveBeenCalledTimes(1);

    // Entries only need to live until the durable child exists; the registry
    // must not accumulate them for the life of the process.
    expect(registry.size()).toBe(0);

    const childPolicy = buildAgentExecutionPolicy(target, agentsRepository(db).listToolPermissions(target.id));
    expect(childPolicy.agentId).toBe(target.id);
    expect(childPolicy.allowedTools).toEqual(new Set(["read_file"]));
    expect([...childPolicy.readScopes]).toEqual(["project"]);
    expect(childPolicy.budget).toMatchObject({ maxProviderCalls: 2, maxTokenBudget: 1200, maxWallClockMs: 10_000 });
    expect(childPolicy.canUseTool("ask_teammate")).toBe(false);
  });

  it("caches only successful spawns and retries after a failure", () => {
    const registry = new TeammateSpawnRegistry();
    let attempts = 0;
    expect(() => registry.run("parent:call", () => {
      attempts++;
      throw new Error("transient");
    })).toThrow("transient");
    expect(registry.size()).toBe(0);
    expect(registry.run("parent:call", () => {
      attempts++;
      return { taskId: "child", agentId: "target", providerId: "mock", model: "mock-model" };
    })).toMatchObject({ taskId: "child" });
    expect(attempts).toBe(2);
  });

  it("enforces the caller's maxChildTasks ceiling before creating a model child", () => {
    const caller = seedParent();
    agentsRepository(db).update(caller.id, "p1", { maxChildTasks: 0 });
    const target = agentsRepository(db).create({ id: "target", projectId: "p1", name: "Target", role: "tester" });
    expect(() => spawnAgentChatSubagent(
      { db, runner: { run }, env: process.env },
      { id: "parent", projectId: "p1", agentId: caller.id },
      target.id,
      "bounded objective",
      { modelInitiated: true, toolCallId: "call-limit" },
    )).toThrowError(expect.objectContaining({ code: "PARENT_CHILD_TASK_LIMIT" }));
    expect(taskRepository(db).listChildren("parent")).toHaveLength(0);
  });

  it("projects model children as status/evidence only, never objective or assistant text", () => {
    const caller = seedParent();
    const target = agentsRepository(db).create({ id: "target", projectId: "p1", name: "Target", role: "tester" });
    conversationsRepository(db).createConversation({ id: "parent-conversation", projectId: "p1", title: "Parent", agentId: caller.id, createdAt: now(), updatedAt: now() });
    conversationsRepository(db).appendMessage({ id: "parent-assistant", conversationId: "parent-conversation", role: "assistant", content: "parent reasoning SECRET=hidden", taskId: "parent", streamingState: "completed", createdAt: now(), updatedAt: now() });
    const child = spawnAgentChatSubagent(
      { db, runner: { run }, env: process.env },
      { id: "parent", projectId: "p1", agentId: caller.id },
      target.id,
      "Objective SECRET=child-secret",
      { modelInitiated: true, toolCallId: "call-projection" },
    );
    const projected = projectThreadHandoffs({ db, projectId: "p1", conversationId: "parent-conversation" });
    expect(projected.handoffs).toHaveLength(1);
    expect(projected.handoffs[0]).toMatchObject({
      id: child.task.id,
      status: "queued",
      objective: "",
      result: null,
      conversationId: null,
      evidenceRef: `task:${child.task.id}`,
    });
    expect(JSON.stringify(projected)).not.toContain("child-secret");
    expect(JSON.stringify(projected)).not.toContain("parent reasoning");
  });
});
