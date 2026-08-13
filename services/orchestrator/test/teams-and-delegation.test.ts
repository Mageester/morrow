import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { agentsRepository } from "../src/repositories/agents.js";
import { teamsRepository } from "../src/repositories/teams.js";
import { delegationsRepository } from "../src/repositories/delegations.js";
import { handoffsRepository } from "../src/repositories/handoffs.js";
import { assistantProfileRepository } from "../src/repositories/assistant-profile.js";
import { memoryRepository } from "../src/repositories/memory.js";

function ts() { return new Date().toISOString(); }

describe("teamsRepository", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts() });
  });
  afterEach(() => db.close());

  it("creates a draft team, activates it, and lists members in order", () => {
    const teams = teamsRepository(db);
    const agents = agentsRepository(db);
    const researcher = agents.create({ id: "agent-researcher", projectId: "p1", name: "Researcher", role: "researcher" });
    const verifier = agents.create({ id: "agent-verifier", projectId: "p1", name: "Verifier", role: "tester" });

    const team = teams.create({ id: "team-1", projectId: "p1", name: "Research and verify", purpose: "test", createdAt: ts() });
    expect(team.status).toBe("draft");
    expect(team.defaultConcurrencyLimit).toBe(1);

    teams.addMember("team-1", researcher.id, 0, ts());
    teams.addMember("team-1", verifier.id, 1, ts());
    expect(teams.listMembers("team-1").map((m) => m.agentId)).toEqual([researcher.id, verifier.id]);

    const activated = teams.setStatus("team-1", "active", ts());
    expect(activated?.status).toBe("active");
    expect(activated?.revision).toBe(2);
  });

  it("isolates teams by project", () => {
    projectRepository(db).createProject({ id: "p2", name: "P2", workspacePath: process.cwd(), createdAt: ts() });
    const teams = teamsRepository(db);
    teams.create({ id: "team-p1", projectId: "p1", name: "Team P1", createdAt: ts() });
    teams.create({ id: "team-p2", projectId: "p2", name: "Team P2", createdAt: ts() });
    expect(teams.listByProject("p1").map((t) => t.id)).toEqual(["team-p1"]);
    expect(teams.listByProject("p2").map((t) => t.id)).toEqual(["team-p2"]);
  });
});

describe("delegationsRepository", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts() });
    taskRepository(db).createTask({ id: "parent", projectId: "p1", kind: "agent_chat", status: "running", createdAt: ts() });
    agentsRepository(db).create({ id: "agent-researcher", projectId: "p1", name: "Researcher", role: "researcher" });
    teamsRepository(db).create({ id: "team-1", projectId: "p1", name: "Research and verify", createdAt: ts() });
  });
  afterEach(() => db.close());

  function create() {
    return delegationsRepository(db).create({
      id: "del-1", parentTaskId: "parent", teamId: "team-1", agentId: "agent-researcher",
      objective: "Summarize README", acceptanceCriteria: ["cites README.md"],
      contextSnapshotRef: "snap-1", allowedTools: ["read_file"], allowedMemoryScopes: ["project", "agent"],
      providerId: "deterministic-local", model: null,
      budget: { maxProviderCalls: 4, maxTokenBudget: 4000, maxWallClockMs: 60000 },
      approvalRequired: true, deadlineAt: null, correlationId: "corr-1", createdAt: ts(),
    });
  }

  it("creates a delegation in pending_approval with no child task yet", () => {
    const d = create();
    expect(d.status).toBe("pending_approval");
    expect(d.childTaskId).toBeNull();
  });

  it("approveAndStart attaches the child task and moves to running", () => {
    create();
    taskRepository(db).createTask({ id: "child", projectId: "p1", kind: "agent_chat", status: "queued", parentTaskId: "parent", createdAt: ts() });
    const started = delegationsRepository(db).approveAndStart("del-1", "child", ts());
    expect(started?.status).toBe("running");
    expect(started?.childTaskId).toBe("child");
  });

  it("rejects a second running delegation against the same child task (DB-enforced)", () => {
    create();
    taskRepository(db).createTask({ id: "child", projectId: "p1", kind: "agent_chat", status: "queued", parentTaskId: "parent", createdAt: ts() });
    delegationsRepository(db).approveAndStart("del-1", "child", ts());

    delegationsRepository(db).create({
      id: "del-2", parentTaskId: "parent", teamId: "team-1", agentId: "agent-researcher",
      objective: "Second delegation", acceptanceCriteria: [], contextSnapshotRef: "snap-2",
      allowedTools: [], allowedMemoryScopes: [], providerId: null, model: null,
      budget: { maxProviderCalls: null, maxTokenBudget: null, maxWallClockMs: null },
      approvalRequired: true, deadlineAt: null, correlationId: "corr-2", createdAt: ts(),
    });
    expect(() => delegationsRepository(db).approveAndStart("del-2", "child", ts())).toThrow();
  });

  it("reject only moves a pending delegation, not a running one", () => {
    create();
    taskRepository(db).createTask({ id: "child", projectId: "p1", kind: "agent_chat", status: "queued", parentTaskId: "parent", createdAt: ts() });
    delegationsRepository(db).approveAndStart("del-1", "child", ts());
    const rejected = delegationsRepository(db).reject("del-1", ts());
    expect(rejected?.status).toBe("running"); // unchanged — reject only applies from pending_approval
  });
});

describe("handoffsRepository", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts() });
    taskRepository(db).createTask({ id: "parent", projectId: "p1", kind: "agent_chat", status: "running", createdAt: ts() });
    taskRepository(db).createTask({ id: "child", projectId: "p1", kind: "agent_chat", status: "running", parentTaskId: "parent", createdAt: ts() });
    agentsRepository(db).create({ id: "agent-researcher", projectId: "p1", name: "Researcher", role: "researcher" });
    agentsRepository(db).create({ id: "agent-verifier", projectId: "p1", name: "Verifier", role: "tester" });
    teamsRepository(db).create({ id: "team-1", projectId: "p1", name: "Research and verify", createdAt: ts() });
    delegationsRepository(db).create({
      id: "del-1", parentTaskId: "parent", teamId: "team-1", agentId: "agent-researcher",
      objective: "Summarize README", acceptanceCriteria: [], contextSnapshotRef: "snap-1",
      allowedTools: [], allowedMemoryScopes: [], providerId: null, model: null,
      budget: { maxProviderCalls: null, maxTokenBudget: null, maxWallClockMs: null },
      approvalRequired: true, deadlineAt: null, correlationId: "corr-1", createdAt: ts(),
    });
  });
  afterEach(() => db.close());

  it("records a durable handoff with acceptance-criteria status and artifact refs, not just prose", () => {
    const handoff = handoffsRepository(db).create({
      id: "handoff-1", delegationId: "del-1", taskId: "child",
      resultSummary: "README summarized and verified.",
      acceptanceCriteriaStatus: [{ criterion: "cites README.md", met: true, note: null }],
      artifactRefs: [{ id: "artifact-1", path: "summary.md", contentHash: "sha256:abc" }],
      verificationEvidence: "Verifier confirmed non-empty summary.",
      unresolvedRisks: [], sourceAgentId: "agent-researcher", targetAgentId: "agent-verifier", createdAt: ts(),
    });
    expect(handoff.acceptanceCriteriaStatus).toHaveLength(1);
    expect(handoffsRepository(db).getByDelegation("del-1")?.id).toBe(handoff.id);
    expect(handoffsRepository(db).listByTask("child")).toHaveLength(1);
  });
});

describe("assistantProfileRepository", () => {
  let db: Database.Database;
  beforeEach(() => { db = openDatabase(":memory:"); });
  afterEach(() => db.close());

  it("lazily materializes the singleton profile with sane defaults on first read", () => {
    const profile = assistantProfileRepository(db).get();
    expect(profile.id).toBe("default");
    expect(profile.defaultPrivacyMode).toBe("local_only");
    expect(profile.defaultApprovalPosture).toBe("ask_always");
    expect(profile.goals).toEqual([]);
  });

  it("updates fields and preserves the singleton across reads", () => {
    const repo = assistantProfileRepository(db);
    repo.update({ displayName: "Aidan", defaultPrivacyMode: "controlled_cloud" }, ts());
    const profile = repo.get();
    expect(profile.displayName).toBe("Aidan");
    expect(profile.defaultPrivacyMode).toBe("controlled_cloud");
  });

  it("adds a goal with explicit enabled state and can disable it without deleting it", () => {
    const repo = assistantProfileRepository(db);
    repo.addGoal({ id: "g1", text: "Ping me about PRs", enabled: true }, ts());
    expect(repo.get().goals).toEqual([{ id: "g1", text: "Ping me about PRs", enabled: true }]);
    repo.setGoalEnabled("g1", false, ts());
    expect(repo.get().goals[0]?.enabled).toBe(false);
  });
});

describe("agentsRepository — team delegation fields", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts() });
  });
  afterEach(() => db.close());

  it("creates an agent with team membership, scopes, and a budget", () => {
    teamsRepository(db).create({ id: "team-1", projectId: "p1", name: "Research and verify", createdAt: ts() });
    const agent = agentsRepository(db).create({
      id: "agent-1", projectId: "p1", name: "Researcher", role: "researcher",
      teamId: "team-1", memoryReadScopes: ["project", "agent"], memoryWriteScopes: ["agent"],
      maxProviderCalls: 4, maxTokenBudget: 4000, maxWallClockMs: 60000, approvalRequired: true,
    });
    expect(agent.teamId).toBe("team-1");
    expect(agent.memoryReadScopes).toEqual(["project", "agent"]);
    expect(agent.maxProviderCalls).toBe(4);
    expect(agent.createdBy).toBe("user");
  });

  it("still creates a standalone agent with no team (existing behavior preserved)", () => {
    const agent = agentsRepository(db).create({ id: "agent-2", projectId: "p1", name: "Solo", role: "assistant" });
    expect(agent.teamId).toBeNull();
    expect(agent.memoryReadScopes).toEqual([]);
    expect(agent.maxProviderCalls).toBeNull();
  });
});

describe("memoryRepository — scope filtering for the memory vault", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts() });
    projectRepository(db).createProject({ id: "p2", name: "P2", workspacePath: process.cwd(), createdAt: ts() });
  });
  afterEach(() => db.close());

  it("listByScope filters strictly within one project for the project scope", () => {
    const memory = memoryRepository(db);
    memory.create({ id: "m1", projectId: "p1", scope: "project", content: "P1 fact", source: "user", createdAt: ts() });
    memory.create({ id: "m2", projectId: "p1", scope: "agent", content: "Agent fact", source: "user", createdAt: ts() });
    memory.create({ id: "m3", projectId: "p2", scope: "project", content: "P2 fact", source: "user", createdAt: ts() });

    expect(memory.listByScope("p1", "project").map((m) => m.id)).toEqual(["m1"]);
    expect(memory.listByScope("p1", "agent").map((m) => m.id)).toEqual(["m2"]);
    expect(memory.listByScope("p2", "project").map((m) => m.id)).toEqual(["m3"]);
  });

  it("listUserGlobal is the one query that crosses project boundaries, and only for user_global scope", () => {
    const memory = memoryRepository(db);
    memory.create({ id: "personal-1", projectId: "p1", scope: "user_global", content: "Prefers concise answers", source: "user", createdAt: ts() });
    memory.create({ id: "p1-only", projectId: "p1", scope: "project", content: "P1-only fact", source: "user", createdAt: ts() });

    const globalFromP1 = memory.listUserGlobal();
    expect(globalFromP1.map((m) => m.id)).toEqual(["personal-1"]);
    // Crucially: project-scoped memory is never returned by listUserGlobal,
    // and listByScope("p2", "project") must never see p1's project memory.
    expect(memory.listByScope("p2", "project")).toEqual([]);
  });
});
