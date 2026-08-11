import type Database from "better-sqlite3";
import {
  TeamSchema,
  TeamMemberSchema,
  type Team,
  type TeamMember,
  type TeamStatus,
  type SharedMemoryPolicy,
  type TeamArtifactPolicy,
} from "@morrow/contracts";

function mapTeam(row: Record<string, unknown>): Team {
  return TeamSchema.parse({
    version: 1,
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    purpose: row.purpose ?? null,
    status: row.status,
    sharedMemoryPolicy: row.shared_memory_policy,
    defaultMaxProviderCalls: row.default_max_provider_calls ?? null,
    defaultMaxTokenBudget: row.default_max_token_budget ?? null,
    defaultMaxWallClockMs: row.default_max_wall_clock_ms ?? null,
    defaultConcurrencyLimit: Number(row.default_concurrency_limit),
    defaultApprovalRequired: Boolean(row.default_approval_required),
    artifactPolicy: row.artifact_policy,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapMember(row: Record<string, unknown>): TeamMember {
  return TeamMemberSchema.parse({
    version: 1,
    teamId: row.team_id,
    agentId: row.agent_id,
    position: Number(row.position),
    createdAt: row.created_at,
  });
}

export interface CreateTeamInput {
  id: string;
  projectId: string;
  name: string;
  purpose?: string | null;
  sharedMemoryPolicy?: SharedMemoryPolicy;
  defaultMaxProviderCalls?: number | null;
  defaultMaxTokenBudget?: number | null;
  defaultMaxWallClockMs?: number | null;
  defaultApprovalRequired?: boolean;
  artifactPolicy?: TeamArtifactPolicy;
  createdAt: string;
}

/**
 * Durable, inspectable teams — not invisible subagents. A team starts
 * `draft` until explicitly activated. Concurrency stays fixed at 1
 * (sequential-only) in this slice; see TeamSchema.defaultConcurrencyLimit.
 */
export function teamsRepository(db: Database.Database) {
  return {
    create(input: CreateTeamInput): Team {
      db.prepare(
        `INSERT INTO teams(
           id,schema_version,project_id,name,purpose,status,shared_memory_policy,
           default_max_provider_calls,default_max_token_budget,default_max_wall_clock_ms,
           default_concurrency_limit,default_approval_required,artifact_policy,revision,created_at,updated_at
         ) VALUES(?,1,?,?,?,'draft',?,?,?,?,1,?,?,1,?,?)`
      ).run(
        input.id,
        input.projectId,
        input.name,
        input.purpose ?? null,
        input.sharedMemoryPolicy ?? "read",
        input.defaultMaxProviderCalls ?? null,
        input.defaultMaxTokenBudget ?? null,
        input.defaultMaxWallClockMs ?? null,
        input.defaultApprovalRequired === false ? 0 : 1,
        input.artifactPolicy ?? "verified_only",
        input.createdAt,
        input.createdAt,
      );
      return this.get(input.id)!;
    },

    get(id: string): Team | undefined {
      const row = db.prepare("SELECT * FROM teams WHERE id=?").get(id) as Record<string, unknown> | undefined;
      return row ? mapTeam(row) : undefined;
    },

    listByProject(projectId: string): Team[] {
      return db.prepare("SELECT * FROM teams WHERE project_id=? ORDER BY created_at ASC")
        .all(projectId).map((r) => mapTeam(r as Record<string, unknown>));
    },

    setStatus(id: string, status: TeamStatus, updatedAt: string): Team | undefined {
      db.prepare("UPDATE teams SET status=?, revision=revision+1, updated_at=? WHERE id=?").run(status, updatedAt, id);
      return this.get(id);
    },

    addMember(teamId: string, agentId: string, position: number, createdAt: string): TeamMember {
      db.prepare(
        `INSERT INTO team_members(schema_version,team_id,agent_id,position,created_at) VALUES(1,?,?,?,?)
         ON CONFLICT(team_id,agent_id) DO UPDATE SET position=excluded.position`
      ).run(teamId, agentId, position, createdAt);
      const row = db.prepare("SELECT * FROM team_members WHERE team_id=? AND agent_id=?").get(teamId, agentId) as Record<string, unknown>;
      return mapMember(row);
    },

    listMembers(teamId: string): TeamMember[] {
      return db.prepare("SELECT * FROM team_members WHERE team_id=? ORDER BY position ASC")
        .all(teamId).map((r) => mapMember(r as Record<string, unknown>));
    },

    removeMember(teamId: string, agentId: string): boolean {
      return db.prepare("DELETE FROM team_members WHERE team_id=? AND agent_id=?").run(teamId, agentId).changes > 0;
    },
  };
}
