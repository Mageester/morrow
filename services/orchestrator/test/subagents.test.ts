import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { agentsRepository } from "../src/repositories/agents.js";
import { teamsRepository } from "../src/repositories/teams.js";

describe("task graph repository", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: new Date().toISOString() });
  });
  afterEach(() => db.close());

  it("links children to a parent and lists them", () => {
    const tasks = taskRepository(db);
    tasks.createTask({ id: "root", projectId: "p1", kind: "agent_chat", status: "running", createdAt: new Date().toISOString() });
    tasks.createTask({ id: "child-a", projectId: "p1", kind: "inspect_workspace", status: "queued", parentTaskId: "root", createdAt: new Date().toISOString() });
    tasks.createTask({ id: "child-b", projectId: "p1", kind: "inspect_workspace", status: "queued", parentTaskId: "root", createdAt: new Date().toISOString() });
    tasks.createTask({ id: "orphan", projectId: "p1", kind: "inspect_workspace", status: "queued", createdAt: new Date().toISOString() });

    expect(tasks.getTaskById("root")?.parentTaskId).toBeNull();
    expect(tasks.getTaskById("child-a")?.parentTaskId).toBe("root");
    expect(tasks.listChildren("root").map((t) => t.id)).toEqual(["child-a", "child-b"]);
    expect(tasks.listChildren("child-a")).toEqual([]);
  });

  it("cascade-deletes children when the parent is removed", () => {
    const tasks = taskRepository(db);
    tasks.createTask({ id: "root", projectId: "p1", kind: "agent_chat", status: "running", createdAt: new Date().toISOString() });
    tasks.createTask({ id: "child", projectId: "p1", kind: "inspect_workspace", status: "queued", parentTaskId: "root", createdAt: new Date().toISOString() });
    db.prepare("DELETE FROM tasks WHERE id = ?").run("root");
    expect(tasks.getTaskById("child")).toBeUndefined();
  });
});

describe("subagent API", () => {
  let db: any;
  let app: any;
  beforeEach(() => {
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: new Date().toISOString() });
    taskRepository(db).createTask({ id: "parent", projectId: "p1", kind: "agent_chat", status: "running", createdAt: new Date().toISOString() });
  });
  afterEach(() => {
    app.close();
    db.close();
  });

  it("spawns a child task linked to the parent and returns it in the tree", async () => {
    const spawn = await app.inject({ method: "POST", url: "/api/tasks/parent/subagents", payload: {} });
    expect(spawn.statusCode).toBe(202);
    const childId = spawn.json().taskId;
    expect(spawn.json().parentTaskId).toBe("parent");
    expect(taskRepository(db).getTaskById(childId)?.parentTaskId).toBe("parent");

    const tree = await app.inject({ method: "GET", url: "/api/tasks/parent/tree" });
    expect(tree.statusCode).toBe(200);
    expect(tree.json().task.id).toBe("parent");
    expect(tree.json().children.map((c: any) => c.task.id)).toEqual([childId]);
  });

  it("builds a nested tree across generations", async () => {
    const first = (await app.inject({ method: "POST", url: "/api/tasks/parent/subagents", payload: {} })).json().taskId;
    const second = (await app.inject({ method: "POST", url: `/api/tasks/${first}/subagents`, payload: {} })).json().taskId;
    const tree = (await app.inject({ method: "GET", url: "/api/tasks/parent/tree" })).json();
    expect(tree.children[0].task.id).toBe(first);
    expect(tree.children[0].children[0].task.id).toBe(second);
  });

  it("404s spawning under or fetching the tree of an unknown task", async () => {
    expect((await app.inject({ method: "POST", url: "/api/tasks/nope/subagents", payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/tasks/nope/tree" })).statusCode).toBe(404);
  });
});

describe("subagent API — kind:\"agent_chat\" real delegation", () => {
  let db: any;
  let app: any;
  let previousMockProvider: string | undefined;
  beforeEach(() => {
    // Real dispatch (dispatchAgentTask) needs a provider route decision. Force
    // the deterministic in-memory "mock" provider rather than depending on
    // whatever real provider credentials happen to be in the ambient shell
    // environment — this must pass identically in CI and in a clean checkout.
    previousMockProvider = process.env.MOCK_PROVIDER;
    process.env.MOCK_PROVIDER = "true";
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: new Date().toISOString() });
    taskRepository(db).createTask({ id: "parent", projectId: "p1", kind: "agent_chat", status: "running", createdAt: new Date().toISOString() });
    agentsRepository(db).create({ id: "agent-researcher", projectId: "p1", name: "Researcher", role: "researcher" });
  });
  afterEach(() => {
    app.close();
    db.close();
    if (previousMockProvider === undefined) delete process.env.MOCK_PROVIDER;
    else process.env.MOCK_PROVIDER = previousMockProvider;
  });

  it("requires an agentId for kind:\"agent_chat\"", async () => {
    const spawn = await app.inject({ method: "POST", url: "/api/tasks/parent/subagents", payload: { kind: "agent_chat" } });
    expect(spawn.statusCode).toBe(400);
  });

  it("404s when the agentId does not belong to the parent task's project", async () => {
    const spawn = await app.inject({
      method: "POST", url: "/api/tasks/parent/subagents",
      payload: { kind: "agent_chat", agentId: "does-not-exist" },
    });
    expect(spawn.statusCode).toBe(404);
  });

  it("routes agent_chat through dispatchAgentTask: real provider routing, conversation linkage, and agent-state events — not the bare runner.run shortcut", async () => {
    const spawn = await app.inject({
      method: "POST", url: "/api/tasks/parent/subagents",
      payload: { kind: "agent_chat", agentId: "agent-researcher", label: "Summarize this project's README" },
    });
    expect(spawn.statusCode).toBe(202);
    const childId = spawn.json().taskId;
    expect(spawn.json().parentTaskId).toBe("parent");

    const child = taskRepository(db).getTaskById(childId);
    expect(child?.parentTaskId).toBe("parent");
    expect(child?.kind).toBe("agent_chat");
    expect(child?.agentId).toBe("agent-researcher");

    // Real dispatch means a routing decision and an initial agent-state
    // transition were recorded — the bare runner.run shortcut never wrote
    // these, which is exactly the gap this fixes.
    const { taskRoutingRepository } = await import("../src/repositories/task-routing.js");
    expect(taskRoutingRepository(db).get(childId)).toBeDefined();
    const { taskRecordsRepository } = await import("../src/repositories/task-records.js");
    expect(taskRecordsRepository(db).getAgentState(childId)?.state).toBe("idle");

    const tree = await app.inject({ method: "GET", url: "/api/tasks/parent/tree" });
    expect(tree.json().children.map((c: any) => c.task.id)).toEqual([childId]);
  });

  it("replays a REST agent_chat spawn with the supplied idempotency key and rejects a fingerprint mismatch", async () => {
    const headers = { "idempotency-key": "rest-agent-chat-spawn-1" };
    const first = await app.inject({
      method: "POST", url: "/api/tasks/parent/subagents", headers,
      payload: { kind: "agent_chat", agentId: "agent-researcher", label: "Summarize the README" },
    });
    expect(first.statusCode).toBe(202);

    const replay = await app.inject({
      method: "POST", url: "/api/tasks/parent/subagents", headers,
      payload: { kind: "agent_chat", agentId: "agent-researcher", label: "Summarize the README" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().taskId).toBe(first.json().taskId);
    expect(taskRepository(db).listChildren("parent")).toHaveLength(1);

    const conflict = await app.inject({
      method: "POST", url: "/api/tasks/parent/subagents", headers,
      payload: { kind: "agent_chat", agentId: "agent-researcher", label: "Summarize a different file" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error?.code ?? conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");
    expect(taskRepository(db).listChildren("parent")).toHaveLength(1);
  });

  it("requires the delegation API before a team agent can be spawned directly", async () => {
    const team = teamsRepository(db).create({ id: "team-1", projectId: "p1", name: "Team", createdAt: new Date().toISOString() });
    const teamAgent = agentsRepository(db).create({ id: "team-agent", projectId: "p1", name: "Team agent", role: "researcher", teamId: team.id });
    teamsRepository(db).addMember(team.id, teamAgent.id, 0, new Date().toISOString());
    teamsRepository(db).setStatus(team.id, "active", new Date().toISOString());

    const spawn = await app.inject({
      method: "POST", url: "/api/tasks/parent/subagents",
      payload: { kind: "agent_chat", agentId: teamAgent.id, label: "Must be delegated" },
    });
    expect(spawn.statusCode).toBe(409);
  });

  it("still handles kind:\"inspect_workspace\" on its exact prior code path (no agentId required, no conversation created)", async () => {
    const spawn = await app.inject({ method: "POST", url: "/api/tasks/parent/subagents", payload: {} });
    expect(spawn.statusCode).toBe(202);
    const child = taskRepository(db).getTaskById(spawn.json().taskId);
    expect(child?.kind).toBe("inspect_workspace");
    expect(child?.agentId).toBeNull();
  });
});
