import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { agentsRepository } from "../src/repositories/agents.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { toolArtifactsRepository } from "../src/repositories/tool-artifacts.js";
import { teammateProfileFingerprint } from "../src/tools/teammate-delegation.js";
import { ConversationParticipantsSchema } from "@morrow/contracts";
import { teamsRepository } from "../src/repositories/teams.js";
import { spawnAgentChatSubagent } from "../src/mission/task-dispatcher.js";

const NOW = "2026-08-20T12:00:00.000Z";

describe("group conversation coordination", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof buildServer>;
  let conductor: ReturnType<ReturnType<typeof agentsRepository>["create"]>;
  let researcher: ReturnType<ReturnType<typeof agentsRepository>["create"]>;
  let writer: ReturnType<ReturnType<typeof agentsRepository>["create"]>;

  beforeEach(() => {
    process.env.MOCK_PROVIDER = "true";
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "project-1", name: "Project", workspacePath: process.cwd(), createdAt: NOW });
    const agents = agentsRepository(db);
    conductor = agents.create({ id: "agent-conductor", projectId: "project-1", name: "Conductor", role: "assistant" });
    researcher = agents.create({ id: "agent-research", projectId: "project-1", name: "Research", role: "researcher", instructions: "Find evidence." });
    writer = agents.create({ id: "agent-writer", projectId: "project-1", name: "Writer", role: "writer" });
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    delete process.env.MOCK_PROVIDER;
  });

  async function createGroup() {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/conversations",
      payload: { title: "Launch group", mode: "group", agentId: conductor.id },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; mode: string; agentId: string };
  }

  it("persists a conductor-bound group and ordered participant snapshots", async () => {
    const group = await createGroup();
    expect(group.mode).toBe("group");
    expect(group.agentId).toBe(conductor.id);

    const inviteResearch = await app.inject({
      method: "POST",
      url: `/api/projects/project-1/conversations/${group.id}/participants`,
      payload: { agentId: researcher.id },
    });
    expect(inviteResearch.statusCode, inviteResearch.body).toBe(201);
    const inviteWriter = await app.inject({
      method: "POST",
      url: `/api/projects/project-1/conversations/${group.id}/participants`,
      payload: { agentId: writer.id },
    });
    expect(inviteWriter.statusCode, inviteWriter.body).toBe(201);

    const listed = ConversationParticipantsSchema.parse((await app.inject({
      method: "GET",
      url: `/api/projects/project-1/conversations/${group.id}/participants`,
    })).json());
    expect(listed.participants.map((participant) => participant.agentId)).toEqual([
      conductor.id,
      researcher.id,
      writer.id,
    ]);
    expect(listed.participants[0]).toMatchObject({ role: "conductor", status: "active", position: 0, nameSnapshot: "Conductor" });
    expect(listed.participants[1]).toMatchObject({ role: "participant", status: "active", position: 1, nameSnapshot: "Research", roleSnapshot: "researcher" });
    expect(listed.participants[1]?.profileFingerprint).toBe(teammateProfileFingerprint(researcher, []));
  });

  it("supports deterministic reorder and refuses conductor removal", async () => {
    const group = await createGroup();
    await app.inject({ method: "POST", url: `/api/projects/project-1/conversations/${group.id}/participants`, payload: { agentId: researcher.id } });
    await app.inject({ method: "POST", url: `/api/projects/project-1/conversations/${group.id}/participants`, payload: { agentId: writer.id } });

    const reorder = await app.inject({
      method: "PATCH",
      url: `/api/projects/project-1/conversations/${group.id}/participants/${writer.id}`,
      payload: { position: 1 },
    });
    expect(reorder.statusCode, reorder.body).toBe(200);
    const listed = ConversationParticipantsSchema.parse((await app.inject({
      method: "GET", url: `/api/projects/project-1/conversations/${group.id}/participants`,
    })).json());
    expect(listed.participants.map((participant) => participant.agentId)).toEqual([conductor.id, writer.id, researcher.id]);
    expect(listed.participants.map((participant) => participant.position)).toEqual([0, 1, 2]);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/projects/project-1/conversations/${group.id}/participants/${researcher.id}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ agentId: researcher.id, status: "removed" });

    const conductorRemoval = await app.inject({
      method: "DELETE",
      url: `/api/projects/project-1/conversations/${group.id}/participants/${conductor.id}`,
    });
    expect(conductorRemoval.statusCode).toBe(409);
    expect(conductorRemoval.json().error.code).toBe("CONDUCTOR_CANNOT_BE_REMOVED");
  });

  it("rejects deleting a named conductor without tombstoning the binding", async () => {
    const group = await createGroup();
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/agents/${conductor.id}`,
      payload: { projectId: "project-1" },
    });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().error.code).toBe("AGENT_CONVERSATION_CONDUCTOR");
    expect(agentsRepository(db).get(conductor.id)).toBeDefined();
    expect((db.prepare("SELECT agent_id,role,status FROM conversation_participants WHERE conversation_id=?").get(group.id))).toMatchObject({ agent_id: conductor.id, role: "conductor", status: "active" });
  });

  it("allows deleting an agent whose only conversation binding is a single thread", async () => {
    const conversation = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/conversations",
      payload: { title: "Standalone thread", mode: "single", agentId: conductor.id },
    });
    expect(conversation.statusCode, conversation.body).toBe(201);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/agents/${conductor.id}`,
      payload: { projectId: "project-1" },
    });

    expect(deleted.statusCode).toBe(204);
    expect(agentsRepository(db).get(conductor.id)).toBeUndefined();
    expect((db.prepare("SELECT agent_id FROM conversations WHERE id=?").get(conversation.json().id))).toEqual({ agent_id: null });
  });

  it("rejects team agents from shared-thread invites", async () => {
    const group = await createGroup();
    const team = teamsRepository(db).create({ id: "team-1", projectId: "project-1", name: "Team", createdAt: NOW });
    const teamAgent = agentsRepository(db).create({ id: "team-agent", projectId: "project-1", name: "Team agent", role: "researcher", teamId: team.id });
    teamsRepository(db).addMember(team.id, teamAgent.id, 0, NOW);
    const invite = await app.inject({
      method: "POST",
      url: `/api/projects/project-1/conversations/${group.id}/participants`,
      payload: { agentId: teamAgent.id },
    });
    expect(invite.statusCode).toBe(409);
    expect(invite.json().error.code).toBe("TEAM_AGENT_REQUIRES_DELEGATION");
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_participants WHERE conversation_id=? AND agent_id=?").get(group.id, teamAgent.id)).toEqual({ count: 0 });
  });

  it("rejects a team agent as the immutable group conductor", async () => {
    const team = teamsRepository(db).create({ id: "conductor-team", projectId: "project-1", name: "Conductor team", createdAt: NOW });
    const teamAgent = agentsRepository(db).create({ id: "team-conductor", projectId: "project-1", name: "Team conductor", role: "researcher", teamId: team.id });
    teamsRepository(db).addMember(team.id, teamAgent.id, 0, NOW);

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/conversations",
      payload: { title: "Invalid group", mode: "group", agentId: teamAgent.id },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("TEAM_AGENT_REQUIRES_DELEGATION");
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE title=?").get("Invalid group")).toEqual({ count: 0 });
  });

  it("cleans the deferred child task, ledgers, and conversation if refs cannot attach", () => {
    const parent = taskRepository(db).createTask({ id: "parent-cleanup", projectId: "project-1", kind: "agent_chat", status: "completed", agentId: conductor.id, createdAt: NOW });
    expect(() => spawnAgentChatSubagent(
      { db, runner: { run: () => undefined }, env: { ...process.env, MOCK_PROVIDER: "true" } },
      parent,
      researcher.id,
      "Should be rolled back",
      { contextRefs: [{ kind: "artifact", id: "missing-artifact" }] },
    )).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id=?").get(parent.id)).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE title=?").get("Should be rolled back")).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_events WHERE task_id NOT IN (SELECT id FROM tasks)").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_context_refs WHERE target_task_id NOT IN (SELECT id FROM tasks)").get()).toEqual({ count: 0 });
  });

  it("stores only project-owned artifact references on a child handoff", async () => {
    const group = await createGroup();
    const conversations = conversationsRepository(db);
    const tasks = taskRepository(db);
    const records = taskRecordsRepository(db);
    conversations.createConversation({ id: "child-source", projectId: "project-1", title: "Source", createdAt: NOW, updatedAt: NOW });
    const parent = tasks.createTask({ id: "parent-task", projectId: "project-1", kind: "agent_chat", status: "completed", agentId: conductor.id, createdAt: NOW });
    conversations.appendMessage({ id: "parent-user", conversationId: group.id, role: "user", content: "Coordinate this", taskId: parent.id, createdAt: NOW, updatedAt: NOW });
    conversations.appendMessage({ id: "parent-assistant", conversationId: group.id, role: "assistant", content: "Working", taskId: parent.id, streamingState: "completed", createdAt: NOW, updatedAt: NOW });
    records.transitionAgentState(parent.id, { id: "parent-state-idle", state: "idle", details: {}, createdAt: NOW });
    const artifact = toolArtifactsRepository(db).create({ taskId: parent.id, toolName: "read_file", kind: "read_file", contentType: "text/plain", content: "bounded evidence" });
    await app.inject({ method: "POST", url: `/api/projects/project-1/conversations/${group.id}/participants`, payload: { agentId: researcher.id } });

    const handoff = await app.inject({
      method: "POST",
      url: `/api/projects/project-1/conversations/${group.id}/handoffs`,
      payload: { parentTaskId: parent.id, agentId: researcher.id, objective: "Check the bounded evidence", contextRefs: [{ kind: "artifact", id: artifact.id }] },
    });
    expect(handoff.statusCode, handoff.body).toBe(202);
    const childId = handoff.json().handoffTaskId as string;
    expect((db.prepare("SELECT parent_task_id, agent_id FROM tasks WHERE id=?").get(childId) as Record<string, unknown>)).toMatchObject({ parent_task_id: parent.id, agent_id: researcher.id });
    expect(db.prepare("SELECT kind, ref_id, source_task_id, target_task_id FROM conversation_context_refs WHERE target_task_id=?").get(childId)).toMatchObject({ kind: "artifact", ref_id: artifact.id, source_task_id: parent.id, target_task_id: childId });

    const transcript = conversations.listMessages((db.prepare("SELECT conversation_id FROM conversation_messages WHERE task_id=? ORDER BY rowid LIMIT 1").get(childId) as { conversation_id: string }).conversation_id);
    expect(transcript.map((message) => message.content).join("\n")).not.toContain("Coordinate this");
  });
});
