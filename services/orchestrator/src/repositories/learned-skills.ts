import type Database from "better-sqlite3";
import { LearnedSkillSchema, type LearnedSkill, type LearnedSkillProvenance } from "@morrow/contracts";

function map(row: any): LearnedSkill {
  return LearnedSkillSchema.parse({
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    triggerConditions: JSON.parse(row.trigger_conditions_json),
    scope: row.scope,
    steps: JSON.parse(row.steps_json),
    permissions: JSON.parse(row.permissions_json),
    validationRequirements: JSON.parse(row.validation_requirements_json),
    provenance: JSON.parse(row.provenance_json),
    state: row.state,
    successCount: Number(row.success_count),
    failureCount: Number(row.failure_count),
    confidence: Number(row.confidence),
    lastVerifiedAt: row.last_verified_at ?? null,
    rollbackHistory: JSON.parse(row.rollback_history_json),
    workflowFingerprint: row.workflow_fingerprint,
    directory: row.directory ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function learnedSkillsRepository(db: Database.Database) {
  return {
    get(id: string): LearnedSkill | undefined {
      const row = db.prepare("SELECT * FROM learned_skills WHERE id=?").get(id);
      return row ? map(row) : undefined;
    },

    getByFingerprint(projectId: string, fingerprint: string): LearnedSkill | undefined {
      const row = db.prepare("SELECT * FROM learned_skills WHERE project_id=? AND workflow_fingerprint=?").get(projectId, fingerprint);
      return row ? map(row) : undefined;
    },

    listByProject(projectId: string): LearnedSkill[] {
      return db.prepare("SELECT * FROM learned_skills WHERE project_id=? ORDER BY created_at,id").all(projectId).map(map);
    },

    create(skill: LearnedSkill): LearnedSkill {
      const value = LearnedSkillSchema.parse(skill);
      db.prepare(`INSERT INTO learned_skills (
        id,project_id,version,trigger_conditions_json,scope,steps_json,permissions_json,
        validation_requirements_json,provenance_json,state,success_count,failure_count,
        confidence,last_verified_at,rollback_history_json,workflow_fingerprint,directory,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        value.id, value.projectId, value.version, JSON.stringify(value.triggerConditions), value.scope,
        JSON.stringify(value.steps), JSON.stringify(value.permissions), JSON.stringify(value.validationRequirements),
        JSON.stringify(value.provenance), value.state, value.successCount, value.failureCount, value.confidence,
        value.lastVerifiedAt, JSON.stringify(value.rollbackHistory), value.workflowFingerprint, value.directory,
        value.createdAt, value.updatedAt,
      );
      return this.get(value.id)!;
    },

    recordSuccess(id: string, provenance: LearnedSkillProvenance, confidence: number, updatedAt: string): LearnedSkill {
      const current = this.get(id);
      if (!current) throw new Error(`Learned skill ${id} not found`);
      if (current.provenance.some((item) => item.missionId === provenance.missionId)) return current;
      const nextProvenance = [...current.provenance, provenance];
      const successCount = nextProvenance.length;
      const nextConfidence = ((current.confidence * current.successCount) + confidence) / successCount;
      db.prepare("UPDATE learned_skills SET provenance_json=?,success_count=?,confidence=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(nextProvenance), successCount, nextConfidence, updatedAt, id);
      return this.get(id)!;
    },

    setValidation(id: string, state: LearnedSkill["state"], directory: string | null, lastVerifiedAt: string | null, updatedAt: string): LearnedSkill {
      db.prepare("UPDATE learned_skills SET state=?,directory=?,last_verified_at=?,updated_at=? WHERE id=?")
        .run(state, directory, lastVerifiedAt, updatedAt, id);
      return this.get(id)!;
    },

    recordRollback(id: string, reason: string, updatedAt: string): LearnedSkill {
      const current = this.get(id);
      if (!current) throw new Error(`Learned skill ${id} not found`);
      const history = [...current.rollbackHistory, { version: current.version, reason, at: updatedAt }];
      db.prepare("UPDATE learned_skills SET state='rolled_back',directory=NULL,rollback_history_json=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(history), updatedAt, id);
      return this.get(id)!;
    },
  };
}

export type LearnedSkillsRepository = ReturnType<typeof learnedSkillsRepository>;
