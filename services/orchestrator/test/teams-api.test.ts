import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { agentsRepository } from "../src/repositories/agents.js";
import { teamsRepository } from "../src/repositories/teams.js";
import { delegationsRepository } from "../src/repositories/delegations.js";
import { teammateProfileFingerprint } from "../src/tools/teammate-delegation.js";

function ts() { return new Date().toISOString(); }

describe("Teams API — Research and verify preset", () => {
  let db: any;
  let app: any;
  beforeEach(() => {
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts() });
  });
  afterEach(() => { app.close(); db.close(); });

  it("creates the Research and verify team with two named specialists and an inspectable policy", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/projects/p1/teams",
      payload: { preset: "research_and_verify" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.team.status).toBe("active");
    expect(body.members).toHaveLength(2);
    const names = body.members.map((a: any) => a.name).sort();
    expect(names).toEqual(["Researcher", "Verifier"]);

    const researcher = body.members.find((a: any) => a.name === "Researcher");
    const verifier = body.members.find((a: any) => a.name === "Verifier");
    // Researcher: no writes. Verifier: writes only approved artifacts.
    expect(researcher.memoryWriteScopes).toEqual(["agent"]);
    expect(verifier.memoryWriteScopes).toContain("team");
    expect(researcher.teamId).toBe(body.team.id);
    expect(verifier.teamId).toBe(body.team.id);
  });

  it("rejects an unknown preset", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/teams", payload: { preset: "build_and_test" } });
    expect(res.statusCode).toBe(400);
  });

  it("refuses to delete a teammate with a live delegation or unfinished task", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects/p1/teams", payload: { preset: "research_and_verify" } });
    const teamId = created.json().team.id;
    const researcher = created.json().members.find((m: any) => m.name === "Researcher");
    taskRepository(db).createTask({ id: "parent", projectId: "p1", kind: "agent_chat", status: "running", createdAt: ts() });
    const delegated = await app.inject({
      method: "POST",
      url: "/api/tasks/parent/delegations",
      payload: { teamId, agentId: researcher.id, objective: "Summarize sources" },
    });
    expect(delegated.statusCode).toBe(201);

    // Pending delegation: deletion must be refused, leaving the durable
    // record inspectable instead of dangling.
    const refused = await app.inject({ method: "DELETE", url: `/api/agents/${researcher.id}`, payload: { projectId: "p1" } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error?.code ?? refused.json().code).toBe("AGENT_IN_FLIGHT");

    // Terminal delegation and no unfinished tasks: deletion succeeds again.
    delegationsRepository(db).reject(delegated.json().id, ts());
    const deleted = await app.inject({ method: "DELETE", url: `/api/agents/${researcher.id}`, payload: { projectId: "p1" } });
    expect(deleted.statusCode).toBe(204);
  });

  it("narrows delegation memory writes to the team policy intersection", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects/p1/teams", payload: { preset: "research_and_verify" } });
    const teamId = created.json().team.id;
    const verifier = created.json().members.find((m: any) => m.name === "Verifier");
    taskRepository(db).createTask({ id: "parent", projectId: "p1", kind: "agent_chat", status: "running", createdAt: ts() });

    // A "read" team lets members read shared memory but never write it, no
    // matter what their standing profile says.
    teamsRepository(db).setStatus(teamId, "paused", ts());
    db.prepare("UPDATE teams SET status='active', shared_memory_policy='read' WHERE id=?").run(teamId);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/parent/delegations",
      payload: { teamId, agentId: verifier.id, objective: "Verify the findings" },
    });
    expect(res.statusCode).toBe(201);
    const delegation = res.json();
    expect(delegation.allowedMemoryScopes).toContain("team");
    expect(delegation.allowedWriteMemoryScopes).toEqual([]);
  });

  it("lists and fetches teams scoped to their project", async () => {
    await app.inject({ method: "POST", url: "/api/projects/p1/teams", payload: { preset: "research_and_verify" } });
    const list = await app.inject({ method: "GET", url: "/api/projects/p1/teams" });
    expect(list.json()).toHaveLength(1);
    const teamId = list.json()[0].id;
    const detail = await app.inject({ method: "GET", url: `/api/projects/p1/teams/${teamId}` });
    expect(detail.json().members).toHaveLength(2);
  });

  it("rejects cross-project team assignment during agent create and update", async () => {
    projectRepository(db).createProject({ id: "p2", name: "P2", workspacePath: process.cwd(), createdAt: ts() });
    const foreignTeam = teamsRepository(db).create({ id: "foreign-team", projectId: "p2", name: "Foreign", createdAt: ts() });

    const create = await app.inject({
      method: "POST", url: "/api/projects/p1/agents",
      payload: { name: "Cross-project", role: "researcher", teamId: foreignTeam.id },
    });
    expect(create.statusCode).toBe(400);

    const agent = agentsRepository(db).create({ id: "local-agent", projectId: "p1", name: "Local", role: "researcher" });
    const update = await app.inject({
      method: "PUT", url: `/api/agents/${agent.id}`,
      payload: { projectId: "p1", teamId: foreignTeam.id },
    });
    expect(update.statusCode).toBe(400);
    expect(agentsRepository(db).get(agent.id)?.teamId).toBeNull();
  });
});

describe("Delegation API — objective to handoff", () => {
  let db: any;
  let app: any;
  let teamId: string;
  let researcherId: string;
  let verifierId: string;
  let previousMockProvider: string | undefined;
  beforeEach(async () => {
    // Approving a delegation dispatches through real routing — force the
    // deterministic mock provider so this never depends on ambient shell
    // credentials (see subagents.test.ts for the same rationale).
    previousMockProvider = process.env.MOCK_PROVIDER;
    process.env.MOCK_PROVIDER = "true";
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts() });
    taskRepository(db).createTask({ id: "parent", projectId: "p1", kind: "agent_chat", status: "running", createdAt: ts() });
    const created = (await app.inject({ method: "POST", url: "/api/projects/p1/teams", payload: { preset: "research_and_verify" } })).json();
    teamId = created.team.id;
    researcherId = created.members.find((a: any) => a.name === "Researcher").id;
    verifierId = created.members.find((a: any) => a.name === "Verifier").id;
  });
  afterEach(() => {
    app.close();
    db.close();
    if (previousMockProvider === undefined) delete process.env.MOCK_PROVIDER;
    else process.env.MOCK_PROVIDER = previousMockProvider;
  });

  it("creates a delegation with server-computed policy, ignoring any client-supplied budget/status", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/tasks/parent/delegations",
      payload: {
        teamId, agentId: researcherId, objective: "Summarize this project's README",
        acceptanceCriteria: ["cites README.md"],
        // Not part of CreateDelegationSchema — must be rejected, not silently accepted.
        status: "approved", budget: { maxProviderCalls: 999999 },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("full flow: create -> approve -> spawns real child -> handoff -> completed", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/tasks/parent/delegations",
      payload: { teamId, agentId: researcherId, objective: "Summarize this project's README", acceptanceCriteria: ["cites README.md"] },
    });
    expect(create.statusCode).toBe(201);
    const delegation = create.json();
    expect(delegation.status).toBe("pending_approval");
    expect(delegation.childTaskId).toBeNull();
    // Server-computed, not client input:
    expect(delegation.approvalRequired).toBe(true);
    expect(Array.isArray(delegation.allowedMemoryScopes)).toBe(true);

    const approve = await app.inject({ method: "POST", url: `/api/delegations/${delegation.id}/resolve`, payload: { parentTaskId: "parent", decision: "approve" } });
    expect(approve.statusCode).toBe(200);
    const running = approve.json();
    expect(running.status).toBe("running");
    expect(running.childTaskId).toBeTruthy();

    const child = taskRepository(db).getTaskById(running.childTaskId);
    expect(child?.parentTaskId).toBe("parent");
    expect(child?.agentId).toBe(researcherId);
    taskRecordsRepository(db).appendEvidence({
      id: "verified-readme", taskId: running.childTaskId, type: "file", path: "README.md",
      metadata: { role: "verified", contentHash: "sha256:abc" }, createdAt: ts(),
    });

    const handoff = await app.inject({
      method: "POST", url: `/api/delegations/${delegation.id}/handoff`,
      payload: {
        parentTaskId: "parent",
        resultSummary: "README summarized and verified.",
        acceptanceCriteriaStatus: [{ criterion: "cites README.md", met: true }],
        artifactRefs: [{ id: "artifact-1", path: "README.md", contentHash: "sha256:abc" }],
        verificationEvidence: "Verifier confirmed non-empty summary citing README.md",
        targetAgentId: verifierId,
      },
    });
    expect(handoff.statusCode).toBe(201);
    expect(handoff.json().acceptanceCriteriaStatus).toHaveLength(1);

    const after = await app.inject({ method: "GET", url: `/api/delegations/${delegation.id}?parentTaskId=parent` });
    expect(after.json().delegation.status).toBe("completed");
    expect(after.json().handoff.id).toBe(handoff.json().id);
  });

  it("reject stops the flow with no child task spawned", async () => {
    const create = (await app.inject({
      method: "POST", url: "/api/tasks/parent/delegations",
      payload: { teamId, agentId: researcherId, objective: "Summarize README" },
    })).json();
    const rejected = await app.inject({ method: "POST", url: `/api/delegations/${create.id}/resolve`, payload: { parentTaskId: "parent", decision: "reject" } });
    expect(rejected.json().status).toBe("rejected");
    expect(rejected.json().childTaskId).toBeNull();
  });

  it("404s a delegation against an agent outside the team/project", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/tasks/parent/delegations",
      payload: { teamId, agentId: "does-not-exist", objective: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("requires the durable parent task context for delegation reads and mutations", async () => {
    const create = (await app.inject({
      method: "POST", url: "/api/tasks/parent/delegations",
      payload: { teamId, agentId: researcherId, objective: "Summarize README" },
    })).json();
    const detailWithoutContext = await app.inject({ method: "GET", url: `/api/delegations/${create.id}` });
    expect(detailWithoutContext.statusCode).toBe(400);

    const wrongParent = await app.inject({
      method: "POST", url: `/api/delegations/${create.id}/resolve`,
      payload: { parentTaskId: "not-the-parent", decision: "approve" },
    });
    expect(wrongParent.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/delegations/${create.id}?parentTaskId=parent` })).json().delegation.status)
      .toBe("pending_approval");
  });

  it("rejects delegation creation for inactive teams and disabled agents", async () => {
    const team = teamsRepository(db).create({ id: "draft-team", projectId: "p1", name: "Draft", createdAt: ts() });
    const agent = agentsRepository(db).create({ id: "draft-agent", projectId: "p1", name: "Draft agent", role: "researcher", teamId: team.id });
    teamsRepository(db).addMember(team.id, agent.id, 0, ts());

    const draft = await app.inject({
      method: "POST", url: "/api/tasks/parent/delegations",
      payload: { teamId: team.id, agentId: agent.id, objective: "Should not run" },
    });
    expect(draft.statusCode).toBe(409);

    teamsRepository(db).setStatus(team.id, "active", ts());
    agentsRepository(db).update(agent.id, "p1", { enabled: false });
    const disabled = await app.inject({
      method: "POST", url: "/api/tasks/parent/delegations",
      payload: { teamId: team.id, agentId: agent.id, objective: "Should not run" },
    });
    expect(disabled.statusCode).toBe(409);
  });

  it("rejects a caller-forged handoff before it can complete the delegation", async () => {
    const create = (await app.inject({
      method: "POST", url: "/api/tasks/parent/delegations",
      payload: { teamId, agentId: researcherId, objective: "Summarize README", acceptanceCriteria: ["cites README.md"] },
    })).json();
    const approved = (await app.inject({
      method: "POST", url: `/api/delegations/${create.id}/resolve`,
      payload: { parentTaskId: "parent", decision: "approve" },
    })).json();
    const forged = await app.inject({
      method: "POST", url: `/api/delegations/${create.id}/handoff`,
      payload: {
        resultSummary: "done",
        acceptanceCriteriaStatus: [{ criterion: "cites README.md", met: true }],
        artifactRefs: [{ id: "fake", path: "README.md", contentHash: "sha256:fake" }],
        verificationEvidence: "fake evidence",
        targetAgentId: verifierId,
      },
    });
    expect(forged.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/delegations/${create.id}?parentTaskId=parent` })).json().delegation.status)
      .toBe("running");
    expect(approved.childTaskId).toBeTruthy();
  });
});

describe("Assistant Profile API", () => {
  let db: any;
  let app: any;
  beforeEach(() => {
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
  });
  afterEach(() => { app.close(); db.close(); });

  it("returns default singleton profile with no setup required", async () => {
    const res = await app.inject({ method: "GET", url: "/api/assistant-profile" });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("default");
    expect(res.json().defaultPrivacyMode).toBe("local_only");
  });

  it("updates the profile via PATCH", async () => {
    const patch = await app.inject({ method: "PATCH", url: "/api/assistant-profile", payload: { displayName: "Aidan", defaultPrivacyMode: "controlled_cloud" } });
    expect(patch.json().displayName).toBe("Aidan");
    expect(patch.json().defaultPrivacyMode).toBe("controlled_cloud");
  });

  it("adds and toggles a goal without deleting it", async () => {
    const added = await app.inject({ method: "POST", url: "/api/assistant-profile/goals", payload: { text: "Ping me about PRs" } });
    expect(added.statusCode).toBe(201);
    const goalId = added.json().goals[0].id;
    const toggled = await app.inject({ method: "PATCH", url: `/api/assistant-profile/goals/${goalId}`, payload: { enabled: false } });
    expect(toggled.json().goals[0].enabled).toBe(false);
    expect(toggled.json().goals).toHaveLength(1);
  });
});

describe("Memory vault API — scope filter and export/import", () => {
  let db: any;
  let app: any;
  beforeEach(() => {
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts() });
    projectRepository(db).createProject({ id: "p2", name: "P2", workspacePath: process.cwd(), createdAt: ts() });
  });
  afterEach(() => { app.close(); db.close(); });

  it("filters the list by scope via query param", async () => {
    await app.inject({ method: "POST", url: "/api/projects/p1/memory", payload: { scope: "project", content: "fact A" } });
    await app.inject({ method: "POST", url: "/api/projects/p1/memory", payload: { scope: "user_global", content: "prefers concise" } });
    const filtered = await app.inject({ method: "GET", url: "/api/projects/p1/memory?scope=user_global" });
    expect(filtered.json()).toHaveLength(1);
    expect(filtered.json()[0].content).toBe("prefers concise");
  });

  it("runs the deterministic README-summary sample task end to end via the API", async () => {
    // p1's workspacePath is process.cwd() (this package root), which has a real README.md.
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/sample-tasks/readme-summary" });
    expect(res.statusCode).toBe(201);
    expect(res.json().handoff.acceptanceCriteriaStatus.every((c: any) => c.met)).toBe(true);
    expect(res.json().parentTask.status).toBe("completed");
  });

  it("exports then imports into a different project, re-scoping and never widening", async () => {
    await app.inject({ method: "POST", url: "/api/projects/p1/memory", payload: { scope: "project", content: "P1 fact" } });
    const exported = (await app.inject({ method: "GET", url: "/api/projects/p1/memory/export" })).json();
    expect(exported.entries).toHaveLength(1);

    const imported = await app.inject({ method: "POST", url: "/api/projects/p2/memory/import", payload: { entries: exported.entries } });
    expect(imported.json().importedCount).toBe(1);
    const p2list = await app.inject({ method: "GET", url: "/api/projects/p2/memory" });
    expect(p2list.json()).toHaveLength(1);
    expect(p2list.json()[0].projectId).toBe("p2");
  });

  it("rejects malformed imports without persisting a row", async () => {
    const invalid = await app.inject({
      method: "POST", url: "/api/projects/p2/memory/import",
      payload: { entries: [{ scope: "not-a-memory-scope", type: "not-a-memory-type", content: "bad" }] },
    });
    expect(invalid.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/projects/p2/memory" })).json()).toHaveLength(0);
  });

  it("does not partially import a batch when a later entry is malformed", async () => {
    await app.inject({ method: "POST", url: "/api/projects/p1/memory", payload: { scope: "project", content: "valid" } });
    const exported = (await app.inject({ method: "GET", url: "/api/projects/p1/memory/export" })).json();
    const invalid = await app.inject({
      method: "POST", url: "/api/projects/p2/memory/import",
      payload: { entries: [exported.entries[0], { scope: "not-a-memory-scope", type: "not-a-memory-type", content: "bad" }] },
    });
    expect(invalid.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/projects/p2/memory" })).json()).toHaveLength(0);
  });
});
