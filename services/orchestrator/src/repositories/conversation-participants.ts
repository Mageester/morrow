import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  ConversationParticipantSchema,
  type Agent,
  type ConversationParticipant,
} from "@morrow/contracts";
import { agentsRepository } from "./agents.js";
import { teammateProfileFingerprint } from "../tools/teammate-delegation.js";

type ParticipantRow = Record<string, unknown>;

function mapParticipant(row: ParticipantRow, isConductor = false): ConversationParticipant {
  return ConversationParticipantSchema.parse({
    version: 1,
    id: String(row.id),
    conversationId: String(row.conversation_id),
    agentId: row.agent_id === null || row.agent_id === undefined ? null : String(row.agent_id),
    role: row.role,
    nameSnapshot: String(row.name_snapshot),
    roleSnapshot: String(row.role_snapshot),
    instructionsSnapshot: row.instructions_snapshot ?? null,
    providerOverrideSnapshot: row.provider_override_snapshot ?? null,
    modelOverrideSnapshot: row.model_override_snapshot ?? null,
    profileFingerprint: String(row.profile_fingerprint),
    position: Number(row.position),
    status: row.status,
    joinedAt: String(row.joined_at),
    updatedAt: String(row.updated_at),
    removedAt: row.removed_at ?? null,
    isConductor,
  });
}

function defaultConductorFingerprint(conversationId: string): string {
  return createHash("sha256").update(`default-conductor:${conversationId}`).digest("hex");
}

export type ParticipantMutationOutcome =
  | { outcome: "created"; participant: ConversationParticipant }
  | { outcome: "reactivated"; participant: ConversationParticipant }
  | { outcome: "already_active"; participant: ConversationParticipant }
  | { outcome: "not_found" }
  | { outcome: "conductor"; participant: ConversationParticipant }
  | { outcome: "team_agent" }
  | { outcome: "removed"; participant: ConversationParticipant };

export function conversationsParticipantsRepository(db: Database.Database) {
  const agents = agentsRepository(db);
  const getRow = (conversationId: string, agentId: string): ParticipantRow | undefined =>
    db.prepare("SELECT * FROM conversation_participants WHERE conversation_id=? AND agent_id=?").get(conversationId, agentId) as ParticipantRow | undefined;

  const map = (row: ParticipantRow): ConversationParticipant => mapParticipant(row, row.role === "conductor");

  const normalizePositions = (conversationId: string, now: string): void => {
    const rows = db.prepare(
      "SELECT id FROM conversation_participants WHERE conversation_id=? AND status='active' ORDER BY CASE role WHEN 'conductor' THEN 0 ELSE 1 END, position ASC, joined_at ASC, id ASC",
    ).all(conversationId) as Array<{ id: string }>;
    const update = db.prepare("UPDATE conversation_participants SET position=?,updated_at=? WHERE id=?");
    rows.forEach((row, index) => update.run(index, now, row.id));
  };

  const rowForAgent = (conversationId: string, agent: Agent, role: "conductor" | "participant", position: number, now: string): ParticipantRow => ({
    id: crypto.randomUUID(),
    conversation_id: conversationId,
    agent_id: agent.id,
    role,
    name_snapshot: agent.name,
    role_snapshot: agent.role,
    instructions_snapshot: agent.instructions,
    provider_override_snapshot: agent.providerOverride,
    model_override_snapshot: agent.modelOverride,
    profile_fingerprint: teammateProfileFingerprint(agent, agents.listToolPermissions(agent.id)),
    position,
    status: "active",
    joined_at: now,
    updated_at: now,
    removed_at: null,
  });

  return {
    /** Insert the immutable named conductor row for group conversations. */
    ensureConductor(conversationId: string, projectId: string, agent: Agent, now: string): ConversationParticipant {
      const existing = getRow(conversationId, agent.id);
      if (existing) return map(existing);
      const row = rowForAgent(conversationId, agent, "conductor", 0, now);
      db.prepare(`INSERT INTO conversation_participants(
        id,project_id,conversation_id,agent_id,role,name_snapshot,role_snapshot,
        instructions_snapshot,provider_override_snapshot,model_override_snapshot,
        profile_fingerprint,position,status,joined_at,updated_at,removed_at
      ) VALUES(@id,@project_id,@conversation_id,@agent_id,@role,@name_snapshot,@role_snapshot,
        @instructions_snapshot,@provider_override_snapshot,@model_override_snapshot,
        @profile_fingerprint,@position,@status,@joined_at,@updated_at,@removed_at)`).run({ ...row, project_id: projectId });
      return map(db.prepare("SELECT * FROM conversation_participants WHERE id=?").get(row.id) as ParticipantRow);
    },

    list(conversationId: string, includeRemoved = true): ConversationParticipant[] {
      const where = includeRemoved ? "" : " AND status='active'";
      return (db.prepare(`SELECT * FROM conversation_participants WHERE conversation_id=?${where} ORDER BY position ASC, joined_at ASC, id ASC`).all(conversationId) as ParticipantRow[]).map(map);
    },

    get(conversationId: string, agentId: string): ConversationParticipant | undefined {
      const row = getRow(conversationId, agentId);
      return row ? map(row) : undefined;
    },

    /** Project the built-in default conductor without inventing an agents row. */
    defaultConductor(conversationId: string): ConversationParticipant {
      const now = new Date(0).toISOString();
      return mapParticipant({
        id: `conductor:${conversationId}`,
        conversation_id: conversationId,
        agent_id: null,
        role: "conductor",
        name_snapshot: "Morrow",
        role_snapshot: "assistant",
        instructions_snapshot: null,
        provider_override_snapshot: null,
        model_override_snapshot: null,
        profile_fingerprint: defaultConductorFingerprint(conversationId),
        position: 0,
        status: "active",
        joined_at: now,
        updated_at: now,
        removed_at: null,
      }, true);
    },

    invite(input: { conversationId: string; projectId: string; agent: Agent; now: string }): ParticipantMutationOutcome {
      // Team members carry a separate delegation policy intersection and
      // cannot be silently downgraded into a shared-thread participant.
      if (input.agent.teamId) return { outcome: "team_agent" };
      const existing = getRow(input.conversationId, input.agent.id);
      if (existing?.role === "conductor") return { outcome: "conductor", participant: map(existing) };
      if (existing?.status === "active") return { outcome: "already_active", participant: map(existing) };
      if (existing) {
        const snapshot = rowForAgent(input.conversationId, input.agent, "participant", Number(existing.position) || 1, input.now);
        db.prepare(`UPDATE conversation_participants SET
          name_snapshot=?,role_snapshot=?,instructions_snapshot=?,provider_override_snapshot=?,model_override_snapshot=?,
          profile_fingerprint=?,position=?,status='active',updated_at=?,removed_at=NULL
          WHERE conversation_id=? AND agent_id=?`).run(
          snapshot.name_snapshot, snapshot.role_snapshot, snapshot.instructions_snapshot,
          snapshot.provider_override_snapshot, snapshot.model_override_snapshot, snapshot.profile_fingerprint,
          Math.max(1, Number(existing.position) || 1), input.now, input.conversationId, input.agent.id,
        );
        normalizePositions(input.conversationId, input.now);
        return { outcome: "reactivated", participant: map(getRow(input.conversationId, input.agent.id)! ) };
      }
      const activeCount = (db.prepare("SELECT COUNT(*) AS count FROM conversation_participants WHERE conversation_id=? AND status='active'").get(input.conversationId) as { count: number }).count;
      const row = rowForAgent(input.conversationId, input.agent, "participant", Math.max(1, activeCount), input.now);
      db.prepare(`INSERT INTO conversation_participants(
        id,project_id,conversation_id,agent_id,role,name_snapshot,role_snapshot,
        instructions_snapshot,provider_override_snapshot,model_override_snapshot,
        profile_fingerprint,position,status,joined_at,updated_at,removed_at
      ) VALUES(@id,@project_id,@conversation_id,@agent_id,@role,@name_snapshot,@role_snapshot,
        @instructions_snapshot,@provider_override_snapshot,@model_override_snapshot,
        @profile_fingerprint,@position,@status,@joined_at,@updated_at,@removed_at)`).run({ ...row, project_id: input.projectId });
      normalizePositions(input.conversationId, input.now);
      return { outcome: "created", participant: map(getRow(input.conversationId, input.agent.id)! ) };
    },

    reorder(conversationId: string, agentId: string, requestedPosition: number, now: string): ConversationParticipant | undefined {
      const target = getRow(conversationId, agentId);
      if (!target || target.status !== "active") return undefined;
      if (target.role === "conductor") return map(target);
      const rows = db.prepare("SELECT id,agent_id,role FROM conversation_participants WHERE conversation_id=? AND status='active' ORDER BY position ASC,joined_at ASC,id ASC").all(conversationId) as Array<{ id: string; agent_id: string; role: string }>;
      const conductor = rows.find((row) => row.role === "conductor");
      const others = rows.filter((row) => row.role !== "conductor" && row.agent_id !== agentId);
      const index = Math.min(Math.max(1, requestedPosition), others.length + 1) - 1;
      others.splice(index, 0, target as { id: string; agent_id: string; role: string });
      if (conductor) others.unshift(conductor);
      const update = db.prepare("UPDATE conversation_participants SET position=?,updated_at=? WHERE id=?");
      // Positions are the persisted projection order: conductor (when
      // present) is 0 and every following active participant is contiguous.
      others.forEach((row, idx) => update.run(idx, now, row.id));
      return map(getRow(conversationId, agentId)!);
    },

    remove(conversationId: string, agentId: string, now: string): ParticipantMutationOutcome {
      const existing = getRow(conversationId, agentId);
      if (!existing) return { outcome: "not_found" };
      if (existing.role === "conductor") return { outcome: "conductor", participant: map(existing) };
      if (existing.status === "removed") return { outcome: "removed", participant: map(existing) };
      db.prepare("UPDATE conversation_participants SET status='removed',removed_at=?,updated_at=? WHERE conversation_id=? AND agent_id=?").run(now, now, conversationId, agentId);
      normalizePositions(conversationId, now);
      return { outcome: "removed", participant: map(getRow(conversationId, agentId)! ) };
    },
  };
}

export { defaultConductorFingerprint };
