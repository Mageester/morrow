import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrations, openDatabase } from "../src/database.js";
import { memoryRepository, type MemoryActor } from "../src/repositories/memory.js";
import { projectRepository } from "../src/repositories/projects.js";
import { agentsRepository } from "../src/repositories/agents.js";
import { teamsRepository } from "../src/repositories/teams.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { MockProvider } from "../src/provider/mock.js";

const at = "2026-08-20T12:00:00.000Z";

describe("per-teammate memory ownership", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: at });
    projectRepository(db).createProject({ id: "p2", name: "P2", workspacePath: process.cwd(), createdAt: at });
  });

  afterEach(() => db.close());

  it("adds nullable owner columns and conservatively backfills only matching task/conversation agents", () => {
    const columns = (db.prepare("PRAGMA table_info(memory_entries)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["owner_agent_id", "owner_team_id"]));
  });

  it("attributes new private rows from the actor and filters private recall by exact ownership", () => {
    const agents = agentsRepository(db);
    const teams = teamsRepository(db);
    const teamA = teams.create({ id: "team-a", projectId: "p1", name: "A", createdAt: at });
    const teamB = teams.create({ id: "team-b", projectId: "p1", name: "B", createdAt: at });
    const agentA = agents.create({ id: "agent-a", projectId: "p1", name: "A", role: "assistant", teamId: teamA.id });
    const agentB = agents.create({ id: "agent-b", projectId: "p1", name: "B", role: "assistant", teamId: teamB.id });
    teams.setStatus(teamA.id, "active", at);
    teams.setStatus(teamB.id, "active", at);
    teams.addMember(teamA.id, agentA.id, 0, at);
    teams.addMember(teamB.id, agentB.id, 0, at);
    const memory = memoryRepository(db);
    const actorA: MemoryActor = { kind: "agent", agentId: agentA.id, teamId: teamA.id };
    const actorB: MemoryActor = { kind: "agent", agentId: agentB.id, teamId: teamB.id };

    const agentEntry = memory.create({ id: "agent-a-memory", projectId: "p1", scope: "agent", content: "A private fact", source: "cortex", actor: actorA, createdAt: at });
    const teamEntry = memory.create({ id: "team-a-memory", projectId: "p1", scope: "team", content: "A team fact", source: "cortex", actor: actorA, createdAt: at });
    memory.create({ id: "project-memory", projectId: "p1", scope: "project", content: "Shared project fact", source: "user", actor: actorA, createdAt: at });

    expect(agentEntry.ownerAgentId).toBe(agentA.id);
    expect(agentEntry.ownerTeamId).toBeNull();
    expect(teamEntry.ownerAgentId).toBeNull();
    expect(teamEntry.ownerTeamId).toBe(teamA.id);
    expect(memory.listByProject("p1", actorA).map((entry) => entry.id)).toEqual(expect.arrayContaining(["agent-a-memory", "team-a-memory", "project-memory"]));
    expect(memory.listByProject("p1", actorB).map((entry) => entry.id)).toEqual(["project-memory"]);
    expect(memory.listByProject("p1", { kind: "default" }).map((entry) => entry.id)).toEqual(["project-memory"]);
    expect(memory.get(agentEntry.id, actorB)).toBeUndefined();
    expect(() => memory.updateContent(agentEntry.id, "forged update", at, actorB)).toThrow(/ownership/);
    expect(() => memory.delete(teamEntry.id, actorB)).toThrow(/ownership/);
  });

  it("rejects missing or forged private ownership and lets users inspect disabled orphan rows", () => {
    const agents = agentsRepository(db);
    const agent = agents.create({ id: "agent-a", projectId: "p1", name: "A", role: "assistant" });
    const memory = memoryRepository(db);
    expect(() => memory.create({ id: "unowned", projectId: "p1", scope: "agent", content: "private", source: "user", createdAt: at })).toThrow(/owner/i);
    expect(() => memory.create({ id: "forged", projectId: "p1", scope: "agent", content: "private", source: "user", actor: { kind: "agent", agentId: "other-agent" }, createdAt: at })).toThrow(/owner|agent/i);

    db.prepare("INSERT INTO memory_entries (id,project_id,scope,content,source,enabled,created_at,updated_at,owner_agent_id) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("legacy-orphan", "p1", "agent", "legacy private", "user", 0, at, at, null);
    expect(memory.listByProject("p1").find((entry) => entry.id === "legacy-orphan")).toMatchObject({ enabled: false, ownerAgentId: null, ownerTeamId: null });
    expect(memory.listByProject("p1", { kind: "agent", agentId: agent.id, teamId: null }).map((entry) => entry.id)).not.toContain("legacy-orphan");
  });

  it("quarantines private rows when an agent is disabled", () => {
    const agent = agentsRepository(db).create({ id: "agent-disabled", projectId: "p1", name: "Disabled", role: "assistant" });
    const memory = memoryRepository(db);
    memory.create({ id: "disabled-memory", projectId: "p1", scope: "agent", content: "private", source: "cortex", actor: { kind: "agent", agentId: agent.id, teamId: null }, createdAt: at });
    agentsRepository(db).update(agent.id, "p1", { enabled: false });
    expect(memory.get("disabled-memory")).toMatchObject({ enabled: false, ownerAgentId: agent.id });
    expect(() => memory.retrieveRelevant("p1", "conversation", "private", at, 20, null, { kind: "agent", agentId: agent.id, teamId: null })).toThrow(/not the durable owner|not available/);
  });

  it("quarantines team rows when the team leaves active status", () => {
    const team = teamsRepository(db).create({ id: "team-inactive", projectId: "p1", name: "Inactive", createdAt: at });
    teamsRepository(db).setStatus(team.id, "active", at);
    const agent = agentsRepository(db).create({ id: "agent-team", projectId: "p1", name: "Team member", role: "assistant", teamId: team.id });
    teamsRepository(db).addMember(team.id, agent.id, 0, at);
    const memory = memoryRepository(db);
    memory.create({ id: "team-memory", projectId: "p1", scope: "team", content: "team private", source: "cortex", actor: { kind: "agent", agentId: agent.id, teamId: team.id }, createdAt: at });
    teamsRepository(db).setStatus(team.id, "paused", at);
    expect(memory.get("team-memory")).toMatchObject({ enabled: false, ownerTeamId: team.id });
  });

  it("quarantines and orphans private rows when an owner is deleted", () => {
    const agent = agentsRepository(db).create({ id: "agent-deleted", projectId: "p1", name: "Deleted", role: "assistant" });
    const memory = memoryRepository(db);
    memory.create({ id: "deleted-memory", projectId: "p1", scope: "agent", content: "private", source: "cortex", actor: { kind: "agent", agentId: agent.id, teamId: null }, createdAt: at });
    expect(agentsRepository(db).delete(agent.id, "p1")).toBe(true);
    expect(memory.get("deleted-memory")).toMatchObject({ enabled: false, ownerAgentId: null, ownerTeamId: null });
  });

  it("requires active membership and supports user reassignment of an orphan", () => {
    const teams = teamsRepository(db);
    const team = teams.create({ id: "team-reassign", projectId: "p1", name: "Reassign", createdAt: at });
    teams.setStatus(team.id, "active", at);
    const first = agentsRepository(db).create({ id: "agent-first", projectId: "p1", name: "First", role: "assistant", teamId: team.id });
    const replacement = agentsRepository(db).create({ id: "agent-replacement", projectId: "p1", name: "Replacement", role: "assistant", teamId: team.id });
    teams.addMember(team.id, first.id, 0, at);
    const memory = memoryRepository(db);
    memory.create({ id: "team-reassign-memory", projectId: "p1", scope: "team", content: "team fact", source: "cortex", actor: { kind: "agent", agentId: first.id, teamId: team.id }, createdAt: at });
    teams.removeMember(team.id, first.id);
    expect(memory.get("team-reassign-memory")).toMatchObject({ enabled: false, ownerTeamId: team.id });
    expect(() => memory.create({ id: "membership-required", projectId: "p1", scope: "team", content: "no member", source: "cortex", actor: { kind: "agent", agentId: replacement.id, teamId: team.id }, createdAt: at })).toThrow(/member/);
    teams.addMember(team.id, replacement.id, 0, at);
    expect(memory.reassignOwner("team-reassign-memory", { kind: "agent", agentId: replacement.id, teamId: team.id }, at)).toMatchObject({ enabled: true, ownerTeamId: team.id });
  });

  it("does not re-enable a forgotten Cortex row", () => {
    const agent = agentsRepository(db).create({ id: "agent-forgotten", projectId: "p1", name: "Forgotten", role: "assistant" });
    const memory = memoryRepository(db);
    memory.create({ id: "forgotten-cortex", projectId: "p1", scope: "agent", content: "old", source: "cortex", actor: { kind: "agent", agentId: agent.id }, createdAt: at });
    memory.setEnabled("forgotten-cortex", false, at, { kind: "agent", agentId: agent.id });
    expect(memory.upsertCortex({ id: "forgotten-cortex", projectId: "p1", scope: "agent", content: "refresh", actor: { kind: "agent", agentId: agent.id }, createdAt: at })).toMatchObject({ enabled: false });
  });

  it("keeps user_global memory after deleting its source project", () => {
    const memory = memoryRepository(db);
    memory.create({ id: "surviving-global", projectId: "p1", scope: "user_global", content: "survive deletion", source: "user", createdAt: at });
    projectRepository(db).deleteProject("p1");
    expect(memory.listAllUserGlobal().map((entry) => entry.id)).toContain("surviving-global");
    expect(memory.listByProject("p1").filter((entry) => entry.scope !== "user_global")).toEqual([]);
  });

  it("decouples user_global memory from a deleted source conversation", () => {
    const conversations = conversationsRepository(db);
    conversations.createConversation({ id: "global-conversation", projectId: "p1", title: "Source", createdAt: at, updatedAt: at });
    const memory = memoryRepository(db);
    memory.create({ id: "conversation-global", projectId: "p1", conversationId: "global-conversation", scope: "user_global", content: "conversation-independent", source: "user", createdAt: at });
    db.prepare("DELETE FROM conversations WHERE id=?").run("global-conversation");
    expect(memory.get("conversation-global")).toMatchObject({ scope: "user_global", conversationId: null, enabled: true });
    expect(db.prepare("SELECT conversation_id FROM search_index WHERE kind='memory' AND ref_id=?").get("conversation-global")).toEqual({ conversation_id: null });
  });

  it("does not let project Cortex refresh mutate another owner's private row", () => {
    const agent = agentsRepository(db).create({ id: "agent-cortex", projectId: "p1", name: "Cortex", role: "assistant" });
    const memory = memoryRepository(db);
    memory.create({ id: "private-cortex", projectId: "p1", scope: "agent", content: "private learning", source: "cortex", actor: { kind: "agent", agentId: agent.id, teamId: null }, createdAt: at });
    expect(memory.markCortexStale("p1", ["project_architecture"], at)).toBe(0);
    expect(memory.get("private-cortex")?.lifecycle).toBe("active");
  });

  it("keeps project isolation while user_global remains unowned and cross-project", () => {
    const memory = memoryRepository(db);
    memory.create({ id: "global", projectId: "p1", scope: "user_global", content: "global preference", source: "user", createdAt: at });
    memory.create({ id: "project", projectId: "p1", scope: "project", content: "p1 only", source: "user", createdAt: at });
    expect(memory.retrieveRelevant("p2", "conversation", "global preference", at, 20, null, { kind: "default" }).map((entry) => entry.id)).toEqual(["global"]);
    expect(memory.retrieveRelevant("p2", "conversation", "p1 only", at, 20, null, { kind: "default" })).toEqual([]);
  });

  it("uses the durable task teammate as the execution memory actor", async () => {
    const agent = agentsRepository(db).create({
      id: "agent-execution", projectId: "p1", name: "Execution", role: "assistant",
      memoryReadScopes: ["agent"],
    });
    const conversations = conversationsRepository(db);
    conversations.createConversation({ id: "agent-conversation", projectId: "p1", title: "Agent", agentId: agent.id, createdAt: at, updatedAt: at });
    conversations.appendMessage({ id: "agent-user", conversationId: "agent-conversation", role: "user", content: "Use my private fact.", createdAt: at, updatedAt: at });
    taskRepository(db).createTask({ id: "agent-task", projectId: "p1", kind: "agent_chat", status: "queued", agentId: agent.id, createdAt: at });
    conversations.appendMessage({ id: "agent-assistant", conversationId: "agent-conversation", role: "assistant", content: "", taskId: "agent-task", streamingState: "queued", createdAt: at, updatedAt: at });
    memoryRepository(db).create({ id: "execution-private", projectId: "p1", scope: "agent", content: "execution-only private fact", source: "cortex", actor: { kind: "agent", agentId: agent.id, teamId: null }, createdAt: at });

    const provider = new MockProvider({ chunks: [[{ type: "text", text: "Done." }, { type: "done" }]] });
    await executeAgentChatTask({ db, taskId: "agent-task", provider, maxTurns: 1 });
    expect(provider.requests[0]!.map((message) => message.content).join("\n")).toContain("execution-only private fact");

    conversations.createConversation({ id: "default-conversation", projectId: "p1", title: "Default", createdAt: at, updatedAt: at });
    conversations.appendMessage({ id: "default-user", conversationId: "default-conversation", role: "user", content: "Use any available fact.", createdAt: at, updatedAt: at });
    taskRepository(db).createTask({ id: "default-task", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: at });
    conversations.appendMessage({ id: "default-assistant", conversationId: "default-conversation", role: "assistant", content: "", taskId: "default-task", streamingState: "queued", createdAt: at, updatedAt: at });
    const defaultProvider = new MockProvider({ chunks: [[{ type: "text", text: "Done." }, { type: "done" }]] });
    await executeAgentChatTask({ db, taskId: "default-task", provider: defaultProvider, maxTurns: 1 });
    expect(defaultProvider.requests[0]!.map((message) => message.content).join("\n")).not.toContain("execution-only private fact");
  });
});

describe("migration 55 legacy ownership backfill", () => {
  let root: string;
  let file: string;
  let db: Database.Database | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "morrow-memory-ownership-"));
    file = join(root, "legacy.db");
    const legacy = new Database(file);
    legacy.pragma("foreign_keys = ON");
    legacy.function("morrow_redact", { deterministic: true }, (value: unknown) => typeof value === "string" ? value : "");
    legacy.exec("CREATE TABLE schema_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
    const insert = legacy.prepare("INSERT INTO schema_migrations VALUES(?,?,?)");
    for (const migration of migrations.filter((item) => item.id <= 54)) {
      if (migration.sql) legacy.exec(migration.sql);
      if (migration.up) migration.up(legacy);
      insert.run(migration.id, migration.name, at);
    }
    projectRepository(legacy).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: at });
    teamsRepository(legacy).create({ id: "team-a", projectId: "p1", name: "A", createdAt: at });
    teamsRepository(legacy).setStatus("team-a", "active", at);
    agentsRepository(legacy).create({ id: "agent-a", projectId: "p1", name: "A", role: "assistant", teamId: "team-a" });
    teamsRepository(legacy).addMember("team-a", "agent-a", 0, at);
    agentsRepository(legacy).create({ id: "agent-b", projectId: "p1", name: "B", role: "assistant" });
    const disabledAgent = agentsRepository(legacy).create({ id: "agent-disabled", projectId: "p1", name: "Disabled", role: "assistant" });
    agentsRepository(legacy).update(disabledAgent.id, "p1", { enabled: false });
    // Keep this database at the exact pre-migration-55 schema. The current
    // conversation repository also writes the later migration-58 `mode`
    // column, so legacy rows are seeded directly with the columns that
    // existed when migration 55 ran.
    legacy.prepare("INSERT INTO conversations (id,project_id,title,agent_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("c-a", "p1", "A", "agent-a", at, at);
    legacy.prepare("INSERT INTO conversations (id,project_id,title,agent_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("c-b", "p1", "B", "agent-b", at, at);
    legacy.prepare("INSERT INTO conversations (id,project_id,title,agent_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("c-disabled", "p1", "Disabled", "agent-disabled", at, at);
    taskRepository(legacy).createTask({ id: "task-a", projectId: "p1", kind: "agent_chat", status: "completed", agentId: "agent-a", createdAt: at });
    taskRepository(legacy).createTask({ id: "task-b", projectId: "p1", kind: "agent_chat", status: "completed", agentId: "agent-b", createdAt: at });
    taskRepository(legacy).createTask({ id: "task-disabled", projectId: "p1", kind: "agent_chat", status: "completed", agentId: "agent-disabled", createdAt: at });
    const add = legacy.prepare("INSERT INTO memory_entries (id,project_id,conversation_id,scope,content,source,enabled,origin_task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
    add.run("matching-agent", "p1", "c-a", "agent", "agent A", "cortex", 1, "task-a", at, at);
    add.run("matching-standalone", "p1", "c-b", "agent", "agent B", "cortex", 1, "task-b", at, at);
    add.run("matching-team", "p1", "c-a", "team", "team A", "cortex", 1, "task-a", at, at);
    add.run("mismatched", "p1", "c-b", "agent", "ambiguous", "cortex", 1, "task-a", at, at);
    add.run("missing-origin", "p1", "c-a", "team", "ambiguous", "cortex", 1, null, at, at);
    add.run("disabled-owner", "p1", "c-disabled", "agent", "ambiguous", "cortex", 1, "task-disabled", at, at);
    add.run("project", "p1", null, "project", "shared", "user", 1, null, at, at);
    add.run("global", "p1", null, "user_global", "global", "user", 1, null, at, at);
    legacy.close();
  });

  afterEach(() => {
    if (db?.open) db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("backfills only exact agent/conversation matches and quarantines ambiguous private rows", () => {
    db = openDatabase(file);
    const rows = db.prepare("SELECT id,owner_agent_id,owner_team_id,enabled FROM memory_entries ORDER BY id").all() as Array<{ id: string; owner_agent_id: string | null; owner_team_id: string | null; enabled: number }>;
    expect(rows.find((row) => row.id === "matching-agent")).toMatchObject({ owner_agent_id: "agent-a", owner_team_id: null, enabled: 1 });
    expect(rows.find((row) => row.id === "matching-standalone")).toMatchObject({ owner_agent_id: "agent-b", owner_team_id: null, enabled: 1 });
    expect(rows.find((row) => row.id === "matching-team")).toMatchObject({ owner_agent_id: null, owner_team_id: "team-a", enabled: 1 });
    expect(rows.find((row) => row.id === "mismatched")).toMatchObject({ owner_agent_id: null, owner_team_id: null, enabled: 0 });
    expect(rows.find((row) => row.id === "missing-origin")).toMatchObject({ owner_agent_id: null, owner_team_id: null, enabled: 0 });
    expect(rows.find((row) => row.id === "disabled-owner")).toMatchObject({ owner_agent_id: "agent-disabled", owner_team_id: null, enabled: 0 });
    expect(rows.find((row) => row.id === "project")).toMatchObject({ owner_agent_id: null, owner_team_id: null, enabled: 1 });
    expect(rows.find((row) => row.id === "global")).toMatchObject({ owner_agent_id: null, owner_team_id: null, enabled: 1 });
  });
});
