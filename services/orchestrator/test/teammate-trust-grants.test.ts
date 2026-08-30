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
import { teammateTrustRepository } from "../src/repositories/teammate-trust.js";
import { teammateProfileFingerprint } from "../src/tools/teammate-delegation.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { MockProvider } from "../src/provider/mock.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";

function now() { return new Date().toISOString(); }
const tool = (id: string, name: string, args: unknown) => ({
  type: "tool_call" as const,
  toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
});
const done = { type: "done" as const };

/**
 * A standing grant is what turns a roster of teammates into a team: it removes
 * the per-hop prompt without removing any of the checks that decide whether
 * the delegation is allowed at all. These tests pin both halves — that a
 * granted pair actually proceeds unattended, and that every way a grant can
 * fail to apply falls back to asking rather than to silently proceeding.
 */
describe("standing teammate trust grants", () => {
  let db: ReturnType<typeof openDatabase>;
  let workspace = "";
  let grantSeq = 0;

  beforeEach(() => {
    db = openDatabase(":memory:");
    workspace = mkdtempSync(join(tmpdir(), "morrow-trust-"));
    grantSeq = 0;
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: workspace, createdAt: now() });
  });

  afterEach(() => {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  function seedParent(agentId: string, taskId = "parent", parentTaskId?: string) {
    const conversations = conversationsRepository(db);
    const conversationId = `c-${taskId}`;
    conversations.createConversation({ id: conversationId, projectId: "p1", title: "Parent", agentId, createdAt: now(), updatedAt: now() });
    conversations.appendMessage({ id: `u-${taskId}`, conversationId, role: "user", content: "Ask a teammate for help.", createdAt: now(), updatedAt: now() });
    const task = taskRepository(db).createTask({
      id: taskId, projectId: "p1", kind: "agent_chat", status: "queued", agentId,
      ...(parentTaskId ? { parentTaskId } : {}),
      createdAt: now(),
    });
    conversations.appendMessage({ id: `a-${taskId}`, conversationId, role: "assistant", content: "", taskId: task.id, streamingState: "queued", createdAt: now(), updatedAt: now() });
    taskRoutingRepository(db).upsert({
      taskId: task.id,
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
    taskRecordsRepository(db).transitionAgentState(task.id, { id: `state-${taskId}`, state: "idle", details: {}, createdAt: now() });
    return task;
  }

  function pair() {
    const caller = agentsRepository(db).create({ id: "caller", projectId: "p1", name: "Chief", role: "custom" });
    const target = agentsRepository(db).create({ id: "target", projectId: "p1", name: "Research", role: "researcher" });
    return { caller, target };
  }

  function grantFor(targetId: string, overrides: { callerAgentId?: string | null; maxDepth?: number; maxChildren?: number; profileHash?: string } = {}) {
    const target = agentsRepository(db).get(targetId)!;
    return teammateTrustRepository(db).grant({
      id: `grant-${targetId}-${grantSeq++}`,
      projectId: "p1",
      callerAgentId: overrides.callerAgentId === undefined ? "caller" : overrides.callerAgentId,
      targetAgentId: targetId,
      targetProfileHash: overrides.profileHash ?? teammateProfileFingerprint(target, agentsRepository(db).listToolPermissions(targetId)),
      maxDepth: overrides.maxDepth ?? 1,
      maxChildren: overrides.maxChildren ?? 4,
      createdAt: now(),
    });
  }

  async function runAsk(taskId = "parent") {
    const spawned = vi.fn(() => ({ taskId: `child-of-${taskId}`, agentId: "target", providerId: "mock", model: "mock-model" }));
    const provider = new MockProvider({ chunks: [
      [tool("ask-1", "ask_teammate", { agentId: "target", objective: "Summarise the release notes." }), done],
      [{ type: "text", text: "Handed off." }, done],
    ] });
    await Promise.race([
      executeAgentChatTask({ db, taskId, provider, maxTurns: 3, teammateSpawner: spawned } as any).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
    return {
      spawned,
      pendingApprovals: approvalsRepository(db).listByTask(taskId).filter((a) => a.status === "pending"),
      trustEvents: taskRecordsRepository(db).listEvents(taskId).filter((e) => e.type === "delegation.trust_evaluated"),
    };
  }

  it("hands off without a prompt when the pair is trusted", async () => {
    const { target } = pair();
    grantFor(target.id);
    seedParent("caller");

    const { spawned, pendingApprovals, trustEvents } = await runAsk();

    expect(spawned).toHaveBeenCalledTimes(1);
    expect(pendingApprovals).toHaveLength(0);
    expect(trustEvents[0]?.payload).toMatchObject({ granted: true, reason: "granted" });
  });

  it("still prompts when no grant exists", async () => {
    pair();
    seedParent("caller");

    const { spawned, pendingApprovals, trustEvents } = await runAsk();

    expect(spawned).not.toHaveBeenCalled();
    expect(pendingApprovals).toHaveLength(1);
    expect(trustEvents[0]?.payload).toMatchObject({ granted: false, reason: "no_grant" });
  });

  it("prompts again when the target profile drifted after the grant", async () => {
    const { target } = pair();
    grantFor(target.id, { profileHash: "0".repeat(64) });
    seedParent("caller");

    const { spawned, pendingApprovals, trustEvents } = await runAsk();

    expect(spawned).not.toHaveBeenCalled();
    expect(pendingApprovals).toHaveLength(1);
    expect(trustEvents[0]?.payload).toMatchObject({ granted: false, reason: "profile_drift" });
  });

  it("prompts once the chain is deeper than the grant permits", async () => {
    const { target } = pair();
    grantFor(target.id, { maxDepth: 1 });
    seedParent("caller", "root");
    seedParent("caller", "parent", "root");

    const { spawned, trustEvents } = await runAsk("parent");

    expect(spawned).not.toHaveBeenCalled();
    expect(trustEvents[0]?.payload).toMatchObject({ granted: false, reason: "depth_exhausted" });
  });

  it("permits an onward hop when the grant allows the depth", async () => {
    const { target } = pair();
    grantFor(target.id, { maxDepth: 2 });
    seedParent("caller", "root");
    seedParent("caller", "parent", "root");

    const { spawned, trustEvents } = await runAsk("parent");

    expect(spawned).toHaveBeenCalledTimes(1);
    expect(trustEvents[0]?.payload).toMatchObject({ granted: true });
  });

  it("prompts once the parent turn hit its fan-out ceiling", async () => {
    const { target } = pair();
    grantFor(target.id, { maxChildren: 1 });
    seedParent("caller");
    taskRepository(db).createTask({ id: "existing-child", projectId: "p1", kind: "agent_chat", status: "queued", agentId: "target", parentTaskId: "parent", createdAt: now() });

    const { spawned, trustEvents } = await runAsk();

    expect(spawned).not.toHaveBeenCalled();
    expect(trustEvents[0]?.payload).toMatchObject({ granted: false, reason: "fanout_exhausted" });
  });

  it("prompts again after the grant is revoked", async () => {
    const { target } = pair();
    const grant = grantFor(target.id);
    expect(teammateTrustRepository(db).revoke("p1", grant.id, now())).toBe(true);
    seedParent("caller");

    const { spawned, trustEvents } = await runAsk();

    expect(spawned).not.toHaveBeenCalled();
    expect(trustEvents[0]?.payload).toMatchObject({ granted: false, reason: "no_grant" });
  });

  it("does not let a project-wide grant leak across projects", () => {
    pair();
    grantFor("target", { callerAgentId: null });
    const repo = teammateTrustRepository(db);
    expect(repo.find("p1", "caller", "target")).toBeDefined();
    expect(repo.find("p2", "caller", "target")).toBeUndefined();
  });

  it("prefers a pair-specific grant over a broader project-wide one", () => {
    pair();
    const repo = teammateTrustRepository(db);
    grantFor("target", { callerAgentId: null, maxDepth: 5 });
    grantFor("target", { callerAgentId: "caller", maxDepth: 1 });
    expect(repo.find("p1", "caller", "target")?.maxDepth).toBe(1);
  });
});

describe("teammate trust grant API", () => {
  let db: ReturnType<typeof openDatabase>;
  let workspace = "";
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    workspace = mkdtempSync(join(tmpdir(), "morrow-trust-api-"));
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: workspace, createdAt: now() });
    agentsRepository(db).create({ id: "caller", projectId: "p1", name: "Chief", role: "custom" });
    agentsRepository(db).create({ id: "target", projectId: "p1", name: "Research", role: "researcher" });
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const grant = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/projects/p1/teammate-trust", payload });

  it("grants, lists, and revokes", async () => {
    const created = await grant({ callerAgentId: "caller", targetAgentId: "target" });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({ projectId: "p1", callerAgentId: "caller", targetAgentId: "target", maxDepth: 1, maxChildren: 4 });
    expect(body.targetProfileHash).toMatch(/^[a-f0-9]{64}$/);

    const listed = await app.inject({ method: "GET", url: "/api/projects/p1/teammate-trust" });
    expect(listed.json().grants).toHaveLength(1);

    const revoked = await app.inject({ method: "DELETE", url: `/api/projects/p1/teammate-trust/${body.id}` });
    expect(revoked.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/projects/p1/teammate-trust" })).json().grants).toHaveLength(0);
  });

  it("resolves the profile fingerprint server-side rather than trusting the caller", async () => {
    const created = await grant({ callerAgentId: "caller", targetAgentId: "target", targetProfileHash: "f".repeat(64) });
    // The extra field is refused outright by the strict schema, so a client can
    // never pin a grant to a fingerprint the server did not compute.
    expect(created.statusCode).toBe(400);
  });

  it("refuses a target from another project", async () => {
    projectRepository(db).createProject({ id: "p2", name: "P2", workspacePath: "C:/other", createdAt: now() });
    agentsRepository(db).create({ id: "outsider", projectId: "p2", name: "Outsider", role: "researcher" });
    expect((await grant({ callerAgentId: "caller", targetAgentId: "outsider" })).statusCode).toBe(404);
  });

  it("refuses self-delegation and disabled targets", async () => {
    expect((await grant({ callerAgentId: "target", targetAgentId: "target" })).statusCode).toBe(409);
    agentsRepository(db).update("target", "p1", { enabled: false });
    expect((await grant({ callerAgentId: "caller", targetAgentId: "target" })).statusCode).toBe(409);
  });

  it("re-granting a pair supersedes rather than stacking", async () => {
    await grant({ callerAgentId: "caller", targetAgentId: "target", maxDepth: 1 });
    await grant({ callerAgentId: "caller", targetAgentId: "target", maxDepth: 3 });
    const grants = (await app.inject({ method: "GET", url: "/api/projects/p1/teammate-trust" })).json().grants;
    expect(grants).toHaveLength(1);
    expect(grants[0].maxDepth).toBe(3);
  });
});
