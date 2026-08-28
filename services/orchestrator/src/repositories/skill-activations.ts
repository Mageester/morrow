import type Database from "better-sqlite3";

export type SkillActivationSource = "bundled" | "user" | "workspace";

export interface SkillActivationRecord {
  skillKey: string;
  skillId: string;
  source: SkillActivationSource;
  projectId: string | null;
  enabled: boolean;
  updatedAt: string;
}

interface SkillActivationRow {
  skill_key: unknown;
  skill_id: unknown;
  source: unknown;
  project_id: unknown;
  enabled: unknown;
  updated_at: unknown;
}

function sourceOf(value: unknown): SkillActivationSource {
  if (value === "bundled" || value === "user" || value === "workspace") return value;
  throw new Error("Invalid skill activation source");
}

function recordOf(row: SkillActivationRow): SkillActivationRecord {
  const source = sourceOf(row.source);
  if (typeof row.skill_key !== "string" || typeof row.skill_id !== "string" || typeof row.updated_at !== "string") {
    throw new Error("Invalid skill activation record");
  }
  if (row.project_id !== null && typeof row.project_id !== "string") throw new Error("Invalid skill activation project");
  return {
    skillKey: row.skill_key,
    skillId: row.skill_id,
    source,
    projectId: row.project_id as string | null,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  };
}

export function skillActivationsRepository(db: Database.Database) {
  const get = db.prepare("SELECT skill_key,skill_id,source,project_id,enabled,updated_at FROM skill_activations WHERE skill_key=?");
  const list = db.prepare("SELECT skill_key,skill_id,source,project_id,enabled,updated_at FROM skill_activations ORDER BY skill_key");
  const set = db.prepare(`
    INSERT INTO skill_activations(skill_key,skill_id,source,project_id,enabled,updated_at)
    VALUES(@skillKey,@skillId,@source,@projectId,@enabled,@updatedAt)
    ON CONFLICT(skill_key) DO UPDATE SET
      skill_id=excluded.skill_id,
      source=excluded.source,
      project_id=excluded.project_id,
      enabled=excluded.enabled,
      updated_at=excluded.updated_at
  `);
  const remove = db.prepare("DELETE FROM skill_activations WHERE skill_key=?");

  return {
    get(skillKey: string): SkillActivationRecord | undefined {
      const row = get.get(skillKey) as SkillActivationRow | undefined;
      return row ? recordOf(row) : undefined;
    },

    list(): SkillActivationRecord[] {
      return (list.all() as SkillActivationRow[]).map(recordOf);
    },

    set(input: SkillActivationRecord): SkillActivationRecord {
      if (typeof input.enabled !== "boolean") throw new Error("Skill activation enabled must be boolean");
      // Validate before handing the value to SQLite. The database CHECKs remain
      // authoritative for source/project invariants, including callers that
      // bypass this repository.
      const source = sourceOf(input.source);
      set.run({
        skillKey: input.skillKey,
        skillId: input.skillId,
        source,
        projectId: input.projectId,
        enabled: input.enabled ? 1 : 0,
        updatedAt: input.updatedAt,
      });
      const saved = get.get(input.skillKey) as SkillActivationRow | undefined;
      if (!saved) throw new Error("Skill activation was not persisted");
      return recordOf(saved);
    },

    remove(skillKey: string): boolean {
      return remove.run(skillKey).changes > 0;
    },
  };
}

export type SkillActivationsRepository = ReturnType<typeof skillActivationsRepository>;
