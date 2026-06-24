import type Database from "better-sqlite3";
import { SkillUsageSchema, type SkillUsage } from "@morrow/contracts";

/**
 * Per-project skill usage counters. Recording a use is an idempotent upsert that
 * increments the counter and stamps the last-used time. Reads are project-scoped
 * and ordered most-used first so the agent and UI can surface proven skills.
 */
export function skillUsageRepository(db: Database.Database) {
  const map = (row: any): SkillUsage =>
    SkillUsageSchema.parse({
      skillId: row.skill_id,
      projectId: row.project_id,
      count: Number(row.count),
      lastUsedAt: row.last_used_at ?? null,
    });

  return {
    recordUse(projectId: string, skillId: string, at: string): SkillUsage {
      db.prepare(
        `INSERT INTO skill_usage (project_id, skill_id, count, last_used_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(project_id, skill_id) DO UPDATE SET
           count = count + 1,
           last_used_at = excluded.last_used_at`
      ).run(projectId, skillId, at);
      return this.get(projectId, skillId)!;
    },

    get(projectId: string, skillId: string): SkillUsage | undefined {
      const row = db.prepare("SELECT * FROM skill_usage WHERE project_id = ? AND skill_id = ?").get(projectId, skillId);
      return row ? map(row) : undefined;
    },

    listByProject(projectId: string): SkillUsage[] {
      return db
        .prepare("SELECT * FROM skill_usage WHERE project_id = ? ORDER BY count DESC, last_used_at DESC, skill_id ASC")
        .all(projectId)
        .map(map);
    },
  };
}
