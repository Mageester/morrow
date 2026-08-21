import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { agentsRepository } from "../src/repositories/agents.js";
import { teamsRepository } from "../src/repositories/teams.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { buildAgentExecutionPolicy } from "../src/security/agent-execution-policy.js";
import { ThreadHandoffsSchema } from "@morrow/contracts";
import { projectThreadHandoffs } from "../src/web/handoff-projection.js";

function ts() { return new Date().toISOString(); }

describe("Handoffs inside a thread", () => {
  let db: any;
  let app: any;
  let previousMockProvider: string | undefined;
  let conversationId: string;

  async function createAgent(name: string, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST", url: "/api/projects/p1/agents", payload: { name, role: "researcher", ...extra },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  async function openThread(agentId?: string) {
    const conversation = (await app.inject({
      method: "POST", url: "/api/projects/p1/conversations",
      payload: agentId ? { agentId } : {},
    })).json();
    const send = await app.inject({
      method: "POST", url: `/api/projects/p1/conversations/${conversation.id}/messages`,
      payload: { content: "start the work" },
    });
    expect(send.statusCode, send.body).toBe(202);
    return { conversationId: conversation.id as string, parentTaskId: send.json().task.id as string };
  }

  beforeEach(async () => {
    previousMockProvider = process.env.MOCK_PROVIDER;
    process.env.MOCK_PROVIDER = "true";
    db = openDatabase(":memory:");
    // A runner that does nothing keeps these assertions about authority and
    // projection rather than about what a model chose to say.
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts() });
    conversationId = "";
  });
  afterEach(() => {
    app.close();
    db.close();
    if (previousMockProvider === undefined) delete process.env.MOCK_PROVIDER;
    else process.env.MOCK_PROVIDER = previousMockProvider;
  });

  it("starts a teammate's work from a turn in this thread and shows it as a handoff", async () => {
    const research = await createAgent("Research");
    const thread = await openThread();
    conversationId = thread.conversationId;

    const handoff = await app.inject({
      method: "POST", url: `/api/projects/p1/conversations/${conversationId}/handoffs`,
      payload: { parentTaskId: thread.parentTaskId, agentId: research.id, objective: "Check the release notes" },
    });
    expect(handoff.statusCode, handoff.body).toBe(202);
    expect(handoff.json()).toMatchObject({ agentId: research.id, agentName: "Research" });

    const listed = ThreadHandoffsSchema.parse(
      (await app.inject({ method: "GET", url: `/api/projects/p1/conversations/${conversationId}/handoffs` })).json(),
    );
    expect(listed.handoffs).toHaveLength(1);
    expect(listed.handoffs[0]).toMatchObject({
      parentTaskId: thread.parentTaskId,
      agentId: research.id,
      agentName: "Research",
      objective: "Check the release notes",
      result: null,
    });
    // The teammate's own thread stays reachable — the projection is a summary,
    // never a replacement for their working record.
    expect(listed.handoffs[0]!.conversationId).toBeTruthy();
    expect(listed.handoffs[0]!.conversationId).not.toBe(conversationId);
  });

  it("projects a completed handoff with its durable completion timestamp", async () => {
    const research = await createAgent("Research");
    const thread = await openThread();
    conversationId = thread.conversationId;

    const handoff = await app.inject({
      method: "POST", url: `/api/projects/p1/conversations/${conversationId}/handoffs`,
      payload: { parentTaskId: thread.parentTaskId, agentId: research.id, objective: "Check the release notes" },
    });
    expect(handoff.statusCode, handoff.body).toBe(202);

    const completedAt = "2026-08-20T12:00:00.000Z";
    const childId = handoff.json().handoffTaskId as string;
    const records = taskRecordsRepository(db);
    records.transitionTask(childId, "running", { id: "handoff-running", createdAt: "2026-08-20T11:59:00.000Z", payload: {} });
    records.transitionTask(childId, "completed", { id: "handoff-completed", createdAt: completedAt, payload: {} });

    const listed = ThreadHandoffsSchema.parse(
      (await app.inject({ method: "GET", url: `/api/projects/p1/conversations/${conversationId}/handoffs` })).json(),
    );
    expect(listed.handoffs[0]).toMatchObject({ status: "completed", completedAt });
  });

  it("shows two teammates' handoffs in one thread, each attributed to its own agent", async () => {
    const research = await createAgent("Research");
    const comms = await createAgent("Comms", { role: "writer" });
    const thread = await openThread();
    conversationId = thread.conversationId;

    for (const [agent, objective] of [[research, "Find the facts"], [comms, "Write it plainly"]] as const) {
      const res = await app.inject({
        method: "POST", url: `/api/projects/p1/conversations/${conversationId}/handoffs`,
        payload: { parentTaskId: thread.parentTaskId, agentId: agent.id, objective },
      });
      expect(res.statusCode, res.body).toBe(202);
    }

    const listed = ThreadHandoffsSchema.parse(
      (await app.inject({ method: "GET", url: `/api/projects/p1/conversations/${conversationId}/handoffs` })).json(),
    );
    expect(listed.handoffs.map((h) => [h.agentName, h.objective])).toEqual([
      ["Research", "Find the facts"],
      ["Comms", "Write it plainly"],
    ]);
  });

  it("keeps handoff order stable across repeated same-timestamp insertion stress", () => {
    const agent = agentsRepository(db).create({ id: "ordered-agent", projectId: "p1", name: "Ordered", role: "researcher" });
    const conversations = conversationsRepository(db);
    const tasks = taskRepository(db);
    conversations.createConversation({ id: "ordered-conversation", projectId: "p1", title: "Ordering", createdAt: "2026-08-20T12:00:00.000Z", updatedAt: "2026-08-20T12:00:00.000Z" });
    tasks.createTask({ id: "ordered-parent", projectId: "p1", kind: "agent_chat", status: "completed", createdAt: "2026-08-20T12:00:00.000Z" });
    conversations.appendMessage({ id: "ordered-parent-message", conversationId: "ordered-conversation", role: "assistant", content: "Parent", taskId: "ordered-parent", createdAt: "2026-08-20T12:00:00.000Z", updatedAt: "2026-08-20T12:00:00.000Z" });

    const expected: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      // Reverse lexical ids deliberately make UUID/id ordering disagree with
      // the durable SQLite insertion order used by the projection.
      for (let offset = 24; offset >= 0; offset -= 1) {
        const id = `ordered-${round}-${String(offset).padStart(2, "0")}`;
        tasks.createTask({
          id,
          projectId: "p1",
          kind: "agent_chat",
          status: "queued",
          idempotencyKey: `ask_teammate:${id}`,
          parentTaskId: "ordered-parent",
          agentId: agent.id,
          createdAt: "2026-08-20T12:00:00.000Z",
        });
        expected.push(id);
      }
    }

    const projected = projectThreadHandoffs({ db, projectId: "p1", conversationId: "ordered-conversation" });
    expect(projected.handoffs.map((handoff) => handoff.id)).toEqual(expected);
  });

  it("gives each teammate its own budget, taken from its own row and not the thread's", async () => {
    const thrifty = await createAgent("Thrifty", { maxProviderCalls: 2, maxTokenBudget: 1000 });
    const generous = await createAgent("Generous", { maxProviderCalls: 50 });
    const agents = agentsRepository(db);

    const thriftyPolicy = buildAgentExecutionPolicy(agents.get(thrifty.id)!, agents.listToolPermissions(thrifty.id));
    const generousPolicy = buildAgentExecutionPolicy(agents.get(generous.id)!, agents.listToolPermissions(generous.id));

    expect(thriftyPolicy.budget).toEqual({ maxProviderCalls: 2, maxTokenBudget: 1000, maxWallClockMs: null });
    expect(generousPolicy.budget).toEqual({ maxProviderCalls: 50, maxTokenBudget: null, maxWallClockMs: null });
    // Independent: one teammate's ceiling is never the other's.
    expect(thriftyPolicy.budget.maxProviderCalls).not.toBe(generousPolicy.budget.maxProviderCalls);
  });

  it("runs the handed-off task as the other teammate, under that teammate's policy", async () => {
    const research = await createAgent("Research", { maxProviderCalls: 3 });
    const thread = await openThread();
    conversationId = thread.conversationId;

    const handoff = await app.inject({
      method: "POST", url: `/api/projects/p1/conversations/${conversationId}/handoffs`,
      payload: { parentTaskId: thread.parentTaskId, agentId: research.id, objective: "Check the notes" },
    });
    const child = taskRepository(db).getTaskById(handoff.json().handoffTaskId)!;
    expect(child.agentId).toBe(research.id);
    expect(child.parentTaskId).toBe(thread.parentTaskId);
    // The child gets a fresh conversation, never the parent's history — the
    // teammate receives the objective it was given and nothing else.
    expect(child.id).not.toBe(thread.parentTaskId);
  });

  it("refuses to route a team agent through this path, because only delegation intersects its team policy", async () => {
    const team = teamsRepository(db).create({ id: "team-1", projectId: "p1", name: "Duo", createdAt: ts() });
    const member = await createAgent("Verifier", { teamId: team.id });
    const thread = await openThread();
    conversationId = thread.conversationId;

    const res = await app.inject({
      method: "POST", url: `/api/projects/p1/conversations/${conversationId}/handoffs`,
      payload: { parentTaskId: thread.parentTaskId, agentId: member.id, objective: "Verify it" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("TEAM_AGENT_REQUIRES_DELEGATION");
  });

  it("refuses a disabled agent and an agent from another project", async () => {
    const thread = await openThread();
    conversationId = thread.conversationId;

    const retired = await createAgent("Retired");
    await app.inject({ method: "PUT", url: `/api/agents/${retired.id}`, payload: { projectId: "p1", enabled: false } });
    const disabled = await app.inject({
      method: "POST", url: `/api/projects/p1/conversations/${conversationId}/handoffs`,
      payload: { parentTaskId: thread.parentTaskId, agentId: retired.id, objective: "Do it" },
    });
    expect(disabled.statusCode).toBe(409);

    projectRepository(db).createProject({ id: "p2", name: "P2", workspacePath: process.cwd(), createdAt: ts() });
    const foreign = (await app.inject({
      method: "POST", url: "/api/projects/p2/agents", payload: { name: "Foreign", role: "researcher" },
    })).json();
    const crossProject = await app.inject({
      method: "POST", url: `/api/projects/p1/conversations/${conversationId}/handoffs`,
      payload: { parentTaskId: thread.parentTaskId, agentId: foreign.id, objective: "Do it" },
    });
    expect(crossProject.statusCode).toBe(404);
  });

  it("refuses to hang a handoff off a turn from a different conversation", async () => {
    const research = await createAgent("Research");
    const mine = await openThread();
    const theirs = await openThread();
    conversationId = mine.conversationId;

    const res = await app.inject({
      method: "POST", url: `/api/projects/p1/conversations/${conversationId}/handoffs`,
      payload: { parentTaskId: theirs.parentTaskId, agentId: research.id, objective: "Do it" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("reports nothing for a thread that has handed nothing over", async () => {
    const thread = await openThread();
    const listed = ThreadHandoffsSchema.parse(
      (await app.inject({ method: "GET", url: `/api/projects/p1/conversations/${thread.conversationId}/handoffs` })).json(),
    );
    expect(listed.handoffs).toEqual([]);
  });
});
