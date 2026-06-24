import type Database from "better-sqlite3";
import {
  AgentSchema,
  AgentToolPermissionSchema,
  AgentSkillAccessSchema,
  type Agent,
  type AgentToolPermission,
  type AgentSkillAccess,
  type CreateAgentInput,
  type UpdateAgentInput,
  type UpsertToolPermissionInput,
  type UpsertSkillAccessInput,
} from "@morrow/contracts";

function mapAgent(row: Record<string, unknown>): Agent {
  return AgentSchema.parse({
    version: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    role: row.role,
    instructions: row.instructions ?? null,
    providerOverride: row.provider_override ?? null,
    modelOverride: row.model_override ?? null,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapToolPerm(row: Record<string, unknown>): AgentToolPermission {
  return AgentToolPermissionSchema.parse({
    version: row.schema_version,
    id: row.id,
    agentId: row.agent_id,
    toolName: row.tool_name,
    effect: row.effect,
    priority: row.priority ?? 0,
    createdAt: row.created_at,
  });
}

function mapSkillAccess(row: Record<string, unknown>): AgentSkillAccess {
  return AgentSkillAccessSchema.parse({
    version: row.schema_version,
    id: row.id,
    agentId: row.agent_id,
    skillId: row.skill_id,
    allowed: Boolean(row.allowed),
    createdAt: row.created_at,
  });
}

export function agentsRepository(db: Database.Database) {
  const now = () => new Date().toISOString();

  return {
    // ── Agent CRUD ───────────────────────────────────────────────────────────

    listByProject(projectId: string): Agent[] {
      return db.prepare("SELECT * FROM agents WHERE project_id=? ORDER BY name ASC, created_at ASC")
        .all(projectId).map(r => mapAgent(r as Record<string, unknown>));
    },

    get(id: string): Agent | undefined {
      const row = db.prepare("SELECT * FROM agents WHERE id=?").get(id) as Record<string, unknown> | undefined;
      return row ? mapAgent(row) : undefined;
    },

    create(input: { id: string; projectId: string } & CreateAgentInput): Agent {
      const ts = now();
      db.prepare(
        `INSERT INTO agents(id,schema_version,project_id,name,role,instructions,provider_override,model_override,enabled,created_at,updated_at)
         VALUES(?,1,?,?,?,?,?,?,1,?,?)`
      ).run(input.id, input.projectId, input.name, input.role, input.instructions ?? null, input.providerOverride ?? null, input.modelOverride ?? null, ts, ts);
      return this.get(input.id)!;
    },

    update(id: string, projectId: string, input: UpdateAgentInput): Agent | undefined {
      const existing = this.get(id);
      if (!existing || existing.projectId !== projectId) return undefined;
      const ts = now();
      const sets: string[] = ["updated_at=?"];
      const vals: unknown[] = [ts];
      if (input.name !== undefined) { sets.push("name=?"); vals.push(input.name); }
      if (input.role !== undefined) { sets.push("role=?"); vals.push(input.role); }
      if (input.instructions !== undefined) { sets.push("instructions=?"); vals.push(input.instructions); }
      if (input.providerOverride !== undefined) { sets.push("provider_override=?"); vals.push(input.providerOverride); }
      if (input.modelOverride !== undefined) { sets.push("model_override=?"); vals.push(input.modelOverride); }
      if (input.enabled !== undefined) { sets.push("enabled=?"); vals.push(input.enabled ? 1 : 0); }
      vals.push(id, projectId);
      db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id=? AND project_id=?`).run(...vals);
      return this.get(id);
    },

    delete(id: string, projectId: string): boolean {
      // CASCADE handles permissions and skill access rows.
      return db.prepare("DELETE FROM agents WHERE id=? AND project_id=?").run(id, projectId).changes > 0;
    },

    // ── Tool Permissions ─────────────────────────────────────────────────────

    listToolPermissions(agentId: string): AgentToolPermission[] {
      return db.prepare("SELECT * FROM agent_tool_permissions WHERE agent_id=? ORDER BY priority DESC, tool_name ASC")
        .all(agentId).map(r => mapToolPerm(r as Record<string, unknown>));
    },

    upsertToolPermission(agentId: string, input: UpsertToolPermissionInput): AgentToolPermission {
      const ts = now();
      db.prepare(
        `INSERT INTO agent_tool_permissions(id,schema_version,agent_id,tool_name,effect,priority,created_at)
         VALUES(?,1,?,?,?,?,?)
         ON CONFLICT(agent_id,tool_name) DO UPDATE SET effect=excluded.effect, priority=excluded.priority`
      ).run(crypto.randomUUID(), agentId, input.toolName, input.effect, input.priority ?? 0, ts);
      const row = db.prepare("SELECT * FROM agent_tool_permissions WHERE agent_id=? AND tool_name=?").get(agentId, input.toolName) as Record<string, unknown>;
      return mapToolPerm(row);
    },

    deleteToolPermission(agentId: string, toolName: string): boolean {
      return db.prepare("DELETE FROM agent_tool_permissions WHERE agent_id=? AND tool_name=?").run(agentId, toolName).changes > 0;
    },

    // ── Skill Access ──────────────────────────────────────────────────────────

    listSkillAccess(agentId: string): AgentSkillAccess[] {
      return db.prepare("SELECT * FROM agent_skill_access WHERE agent_id=? ORDER BY skill_id ASC")
        .all(agentId).map(r => mapSkillAccess(r as Record<string, unknown>));
    },

    upsertSkillAccess(agentId: string, input: UpsertSkillAccessInput): AgentSkillAccess {
      const ts = now();
      db.prepare(
        `INSERT INTO agent_skill_access(id,schema_version,agent_id,skill_id,allowed,created_at)
         VALUES(?,1,?,?,?,?)
         ON CONFLICT(agent_id,skill_id) DO UPDATE SET allowed=excluded.allowed`
      ).run(crypto.randomUUID(), agentId, input.skillId, input.allowed ? 1 : 0, ts);
      const row = db.prepare("SELECT * FROM agent_skill_access WHERE agent_id=? AND skill_id=?").get(agentId, input.skillId) as Record<string, unknown>;
      return mapSkillAccess(row);
    },

    deleteSkillAccess(agentId: string, skillId: string): boolean {
      return db.prepare("DELETE FROM agent_skill_access WHERE agent_id=? AND skill_id=?").run(agentId, skillId).changes > 0;
    },

    // ── Permission lookups for enforcement ────────────────────────────────────

    /** Returns the effective permission for a tool (deny overrides allow at same priority). Ordered by priority desc, then deny before allow. */
    getEffectiveToolPermission(agentId: string, toolName: string): ToolPermissionEffect | null {
      const row = db.prepare(
        "SELECT effect FROM agent_tool_permissions WHERE agent_id=? AND tool_name=? ORDER BY priority DESC, CASE effect WHEN 'deny' THEN 0 ELSE 1 END LIMIT 1"
      ).get(agentId, toolName) as Record<string, unknown> | undefined;
      return row ? (row.effect as ToolPermissionEffect) : null;
    },

    isSkillAllowed(agentId: string, skillId: string): boolean {
      const row = db.prepare("SELECT allowed FROM agent_skill_access WHERE agent_id=? AND skill_id=?").get(agentId, skillId) as Record<string, unknown> | undefined;
      return row ? Boolean(row.allowed) : true; // default: allow
    },

    getAllowedSkillIds(agentId: string): string[] {
      return (db.prepare("SELECT skill_id FROM agent_skill_access WHERE agent_id=? AND allowed=1").all(agentId) as Record<string, unknown>[])
        .map(r => String(r.skill_id));
    },

    getDeniedSkillIds(agentId: string): string[] {
      return (db.prepare("SELECT skill_id FROM agent_skill_access WHERE agent_id=? AND allowed=0").all(agentId) as Record<string, unknown>[])
        .map(r => String(r.skill_id));
    },
  };
}

type ToolPermissionEffect = "allow" | "deny";
