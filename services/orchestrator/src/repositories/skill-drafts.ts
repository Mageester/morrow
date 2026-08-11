import type Database from "better-sqlite3";
import {
  SkillDraftSchema,
  SkillDraftValidationSchema,
  SkillReplayResultSchema,
  type SkillDraft,
  type SkillDraftLifecycle,
  type SkillDraftValidation,
  type SkillReplayResult,
} from "@morrow/contracts";

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Malformed persisted ${label}`);
  try { return JSON.parse(value); } catch { throw new Error(`Malformed persisted ${label}`); }
}

function map(row: Record<string, unknown>): SkillDraft {
  return SkillDraftSchema.parse({
    version: 1,
    id: row.id,
    projectId: row.project_id,
    sourceTaskId: row.source_task_id,
    name: row.name,
    description: row.description,
    triggerDescription: row.trigger_description,
    inputs: parseJson(row.inputs_json, "skill draft inputs"),
    outputs: parseJson(row.outputs_json, "skill draft outputs"),
    steps: parseJson(row.steps_json, "skill draft steps"),
    permissions: parseJson(row.permissions_json, "skill draft permissions"),
    creatorPermissions: parseJson(row.creator_permissions_json, "skill draft creator permissions"),
    provenance: parseJson(row.provenance_json, "skill draft provenance"),
    replayFixtures: parseJson(row.replay_fixtures_json, "skill draft replay fixtures"),
    validation: parseJson(row.validation_json, "skill draft validation"),
    lifecycle: row.lifecycle,
    workflowFingerprint: row.workflow_fingerprint,
    directory: row.directory ?? null,
    rollbackHistory: parseJson(row.rollback_history_json ?? "[]", "skill draft rollback history"),
    warning: row.warning ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at ?? null,
    activatedAt: row.activated_at ?? null,
  });
}

const transitions: Record<SkillDraftLifecycle, readonly SkillDraftLifecycle[]> = {
  draft: ["security_review", "replay_pending", "approved", "rejected", "rolled_back"],
  security_review: ["replay_pending", "approved", "rejected", "rolled_back"],
  replay_pending: ["approved", "rejected", "rolled_back"],
  approved: ["active", "rejected", "rolled_back"],
  active: ["rolled_back"],
  rejected: [],
  rolled_back: [],
};

export function skillDraftsRepository(db: Database.Database) {
  const get = (id: string): SkillDraft | undefined => {
    const row = db.prepare("SELECT * FROM skill_drafts WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? map(row) : undefined;
  };

  return {
    get,

    getForProject(id: string, projectId: string): SkillDraft | undefined {
      const row = db.prepare("SELECT * FROM skill_drafts WHERE id=? AND project_id=?").get(id, projectId) as Record<string, unknown> | undefined;
      return row ? map(row) : undefined;
    },

    getBySourceTask(sourceTaskId: string): SkillDraft | undefined {
      const row = db.prepare("SELECT * FROM skill_drafts WHERE source_task_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(sourceTaskId) as Record<string, unknown> | undefined;
      return row ? map(row) : undefined;
    },

    listByProject(projectId: string): SkillDraft[] {
      return db.prepare("SELECT * FROM skill_drafts WHERE project_id=? ORDER BY created_at ASC,id ASC").all(projectId).map((row) => map(row as Record<string, unknown>));
    },

    create(input: SkillDraft): SkillDraft {
      const value = SkillDraftSchema.parse(input);
      db.prepare(`INSERT INTO skill_drafts(
        id,project_id,source_task_id,name,description,trigger_description,inputs_json,outputs_json,
        steps_json,permissions_json,creator_permissions_json,provenance_json,replay_fixtures_json,
        validation_json,lifecycle,workflow_fingerprint,directory,rollback_history_json,warning,
        created_at,updated_at,approved_at,activated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        value.id, value.projectId, value.sourceTaskId, value.name, value.description, value.triggerDescription,
        JSON.stringify(value.inputs), JSON.stringify(value.outputs), JSON.stringify(value.steps), JSON.stringify(value.permissions),
        JSON.stringify(value.creatorPermissions), JSON.stringify(value.provenance), JSON.stringify(value.replayFixtures),
        JSON.stringify(value.validation), value.lifecycle, value.workflowFingerprint, value.directory,
        JSON.stringify(value.rollbackHistory), value.warning, value.createdAt, value.updatedAt, value.approvedAt, value.activatedAt,
      );
      return get(value.id)!;
    },

    updateValidation(id: string, validation: SkillDraftValidation, updatedAt: string, lifecycle?: SkillDraftLifecycle): SkillDraft {
      const current = get(id);
      if (!current) throw new Error("Skill draft not found");
      const checked = SkillDraftValidationSchema.parse(validation);
      const nextLifecycle = lifecycle ?? current.lifecycle;
      if (nextLifecycle !== current.lifecycle && !transitions[current.lifecycle].includes(nextLifecycle)) {
        throw new Error(`Invalid skill draft transition: ${current.lifecycle} -> ${nextLifecycle}`);
      }
      db.prepare("UPDATE skill_drafts SET validation_json=?,lifecycle=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(checked), nextLifecycle, updatedAt, id);
      return get(id)!;
    },

    recordReplay(id: string, result: SkillReplayResult, updatedAt: string): SkillDraft {
      const current = get(id);
      if (!current) throw new Error("Skill draft not found");
      const checked = SkillReplayResultSchema.parse(result);
      if (current.validation.replay.results.some((item) => item.id === checked.id)) return current;
      const results = [...current.validation.replay.results, checked];
      const replay = {
        requiredSuccesses: 2 as const,
        successfulRuns: results.filter((item) => item.passed).length,
        failedRuns: results.filter((item) => !item.passed).length,
        results,
      };
      const validation = { ...current.validation, replay };
      const lifecycle = current.lifecycle === "draft" || current.lifecycle === "security_review" ? "replay_pending" : current.lifecycle;
      db.prepare("UPDATE skill_drafts SET validation_json=?,lifecycle=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(validation), lifecycle, updatedAt, id);
      return get(id)!;
    },

    setLifecycle(id: string, lifecycle: SkillDraftLifecycle, input: {
      updatedAt: string;
      directory?: string | null;
      warning?: string | null;
      approvedAt?: string | null;
      activatedAt?: string | null;
    }): SkillDraft {
      const current = get(id);
      if (!current) throw new Error("Skill draft not found");
      if (lifecycle !== current.lifecycle && !transitions[current.lifecycle].includes(lifecycle)) {
        throw new Error(`Invalid skill draft transition: ${current.lifecycle} -> ${lifecycle}`);
      }
      db.prepare(`UPDATE skill_drafts SET lifecycle=?,directory=COALESCE(?,directory),warning=COALESCE(?,warning),
        approved_at=COALESCE(?,approved_at),activated_at=COALESCE(?,activated_at),updated_at=? WHERE id=?`)
        .run(lifecycle, input.directory === undefined ? null : input.directory, input.warning === undefined ? null : input.warning,
          input.approvedAt === undefined ? null : input.approvedAt, input.activatedAt === undefined ? null : input.activatedAt,
          input.updatedAt, id);
      return get(id)!;
    },

    rollback(id: string, reason: string, updatedAt: string): SkillDraft {
      const current = get(id);
      if (!current) throw new Error("Skill draft not found");
      if (["rejected", "rolled_back"].includes(current.lifecycle)) throw new Error("Skill draft is already closed");
      const history = [...current.rollbackHistory, { version: "1.0.0", reason, at: updatedAt }];
      db.prepare("UPDATE skill_drafts SET lifecycle='rolled_back',directory=NULL,rollback_history_json=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(history), updatedAt, id);
      return get(id)!;
    },
  };
}

export type SkillDraftsRepository = ReturnType<typeof skillDraftsRepository>;
