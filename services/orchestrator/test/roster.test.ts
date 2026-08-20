import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { approvalsRepository } from "../src/repositories/approvals.js";
import { RosterSchema } from "@morrow/contracts";

function ts() { return new Date().toISOString(); }

async function createAgent(app: any, name: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects/p1/agents",
    payload: { name, role: "researcher", ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe("Teammate roster", () => {
  let db: any;
  let app: any;

  beforeEach(() => {
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts() });
  });
  afterEach(() => { app.close(); db.close(); });

  it("always includes the built-in default teammate, even with no agents and no history", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/roster" });
    expect(res.statusCode).toBe(200);
    const roster = RosterSchema.parse(res.json());
    expect(roster.entries).toHaveLength(1);
    expect(roster.entries[0]).toMatchObject({
      agentId: null,
      name: "Morrow",
      status: "idle",
      conversationId: null,
      conversationCount: 0,
    });
  });

  it("names the default teammate from the assistant profile when the user has set one", async () => {
    await app.inject({ method: "PATCH", url: "/api/assistant-profile", payload: { assistantName: "Ada" } });
    const roster = RosterSchema.parse((await app.inject({ method: "GET", url: "/api/projects/p1/roster" })).json());
    expect(roster.entries[0]!.name).toBe("Ada");
  });

  it("attributes a conversation to the teammate it was created for, and leaves unassigned ones with the default", async () => {
    const agent = await createAgent(app, "Research");
    const own = await app.inject({
      method: "POST", url: "/api/projects/p1/conversations",
      payload: { title: "Owned thread", agentId: agent.id },
    });
    expect(own.statusCode).toBe(201);
    expect(own.json().agentId).toBe(agent.id);

    const unassigned = await app.inject({ method: "POST", url: "/api/projects/p1/conversations", payload: { title: "Plain thread" } });
    expect(unassigned.json().agentId).toBeNull();

    const roster = RosterSchema.parse((await app.inject({ method: "GET", url: "/api/projects/p1/roster" })).json());
    const byName = Object.fromEntries(roster.entries.map((entry) => [entry.name, entry]));
    expect(byName.Morrow!.conversationId).toBe(unassigned.json().id);
    expect(byName.Morrow!.conversationCount).toBe(1);
    expect(byName.Research!.agentId).toBe(agent.id);
    expect(byName.Research!.conversationId).toBe(own.json().id);
    expect(byName.Research!.conversationCount).toBe(1);
  });

  it("refuses a conversation bound to an agent from another project, or to a disabled agent", async () => {
    projectRepository(db).createProject({ id: "p2", name: "P2", workspacePath: process.cwd(), createdAt: ts() });
    const foreign = await app.inject({
      method: "POST", url: "/api/projects/p2/agents", payload: { name: "Foreign", role: "researcher" },
    });
    const crossProject = await app.inject({
      method: "POST", url: "/api/projects/p1/conversations", payload: { agentId: foreign.json().id },
    });
    expect(crossProject.statusCode).toBe(404);

    const agent = await createAgent(app, "Retired");
    await app.inject({ method: "PUT", url: `/api/agents/${agent.id}`, payload: { projectId: "p1", enabled: false } });
    const disabled = await app.inject({
      method: "POST", url: "/api/projects/p1/conversations", payload: { agentId: agent.id },
    });
    expect(disabled.statusCode).toBe(409);
  });

  it("reports a teammate as working while one of its tasks is in flight", async () => {
    const agent = await createAgent(app, "Research");
    taskRepository(db).createTask({
      id: "t1", projectId: "p1", kind: "agent_chat", status: "running", agentId: agent.id, createdAt: ts(),
    });

    const roster = RosterSchema.parse((await app.inject({ method: "GET", url: "/api/projects/p1/roster" })).json());
    const entry = roster.entries.find((e) => e.agentId === agent.id)!;
    expect(entry.status).toBe("working");
    expect(entry.runningTaskCount).toBe(1);
    // The default teammate has nothing in flight and must not inherit the state.
    expect(roster.entries.find((e) => e.agentId === null)!.status).toBe("idle");
  });

  it("reports waiting rather than working when a pending approval is blocking the run", async () => {
    const agent = await createAgent(app, "Research");
    taskRepository(db).createTask({
      id: "t1", projectId: "p1", kind: "agent_chat", status: "running", agentId: agent.id, createdAt: ts(),
    });
    approvalsRepository(db).create({
      id: "a1", taskId: "t1", projectId: "p1", kind: "command",
      summary: "Run the test suite", details: {}, createdAt: ts(),
    });

    const roster = RosterSchema.parse((await app.inject({ method: "GET", url: "/api/projects/p1/roster" })).json());
    const entry = roster.entries.find((e) => e.agentId === agent.id)!;
    expect(entry.status).toBe("waiting");
    expect(entry.pendingApprovalCount).toBe(1);
  });

  it("reports a switched-off agent as disabled, not idle", async () => {
    const agent = await createAgent(app, "Retired");
    await app.inject({ method: "PUT", url: `/api/agents/${agent.id}`, payload: { projectId: "p1", enabled: false } });
    const roster = RosterSchema.parse((await app.inject({ method: "GET", url: "/api/projects/p1/roster" })).json());
    expect(roster.entries.find((e) => e.agentId === agent.id)!.status).toBe("disabled");
  });

  it("shows the opening line of the teammate's last reply, clamped to one line", async () => {
    const agent = await createAgent(app, "Research");
    const conversation = conversationsRepository(db).createConversation({
      id: "c1", projectId: "p1", title: "Thread", agentId: agent.id, createdAt: ts(), updatedAt: ts(),
    });
    conversationsRepository(db).appendMessage({
      id: "m1", conversationId: conversation.id, role: "assistant",
      content: "Summarised the release notes.\nThen filed three follow-ups.",
      createdAt: ts(), updatedAt: ts(),
    });

    const roster = RosterSchema.parse((await app.inject({ method: "GET", url: "/api/projects/p1/roster" })).json());
    const entry = roster.entries.find((e) => e.agentId === agent.id)!;
    expect(entry.lastLine).toBe("Summarised the release notes.");
    expect(entry.lastActivityAt).not.toBeNull();
  });

  it("does not leak an archived conversation as the thread to open", async () => {
    const agent = await createAgent(app, "Research");
    const created = await app.inject({
      method: "POST", url: "/api/projects/p1/conversations", payload: { agentId: agent.id },
    });
    await app.inject({
      method: "PATCH", url: `/api/projects/p1/conversations/${created.json().id}`, payload: { archived: true },
    });
    const roster = RosterSchema.parse((await app.inject({ method: "GET", url: "/api/projects/p1/roster" })).json());
    const entry = roster.entries.find((e) => e.agentId === agent.id)!;
    expect(entry.conversationId).toBeNull();
    expect(entry.conversationCount).toBe(0);
  });

  it("404s the roster for a project that does not exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/nope/roster" });
    expect(res.statusCode).toBe(404);
  });
});

describe("A conversation runs as the teammate it belongs to", () => {
  let db: any;
  let app: any;
  let previousMockProvider: string | undefined;

  beforeEach(() => {
    // Dispatch needs a route it can resolve; the deterministic mock provider
    // keeps these assertions about agent binding, not about model access.
    previousMockProvider = process.env.MOCK_PROVIDER;
    process.env.MOCK_PROVIDER = "true";
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts() });
  });
  afterEach(() => {
    app.close();
    db.close();
    if (previousMockProvider === undefined) delete process.env.MOCK_PROVIDER;
    else process.env.MOCK_PROVIDER = previousMockProvider;
  });

  it("stamps the conversation's agent onto a task the request did not name one for", async () => {
    const agent = (await createAgent(app, "Research")).id;
    const conversation = (await app.inject({
      method: "POST", url: "/api/projects/p1/conversations", payload: { agentId: agent },
    })).json();

    const send = await app.inject({
      method: "POST",
      url: `/api/projects/p1/conversations/${conversation.id}/messages`,
      payload: { content: "look into the release notes" },
    });
    expect(send.statusCode).toBe(202);
    const task = taskRepository(db).getTaskById(send.json().task.id)!;
    expect(task.agentId).toBe(agent);
  });

  it("refuses to run a different agent inside a thread that already belongs to one", async () => {
    const owner = (await createAgent(app, "Research")).id;
    const intruder = (await createAgent(app, "Comms")).id;
    const conversation = (await app.inject({
      method: "POST", url: "/api/projects/p1/conversations", payload: { agentId: owner },
    })).json();

    const send = await app.inject({
      method: "POST",
      url: `/api/projects/p1/conversations/${conversation.id}/messages`,
      payload: { content: "do it anyway", agentId: intruder },
    });
    expect(send.statusCode).toBe(409);
    expect(send.json().error.code).toBe("CONVERSATION_AGENT_MISMATCH");
  });

  it("leaves an unbound conversation running as the default teammate", async () => {
    const conversation = (await app.inject({ method: "POST", url: "/api/projects/p1/conversations", payload: {} })).json();
    const send = await app.inject({
      method: "POST",
      url: `/api/projects/p1/conversations/${conversation.id}/messages`,
      payload: { content: "hello" },
    });
    expect(send.statusCode).toBe(202);
    expect(taskRepository(db).getTaskById(send.json().task.id)!.agentId).toBeNull();
  });
});
