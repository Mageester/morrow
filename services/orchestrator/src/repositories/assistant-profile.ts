import type Database from "better-sqlite3";
import { AssistantProfileSchema, type AssistantProfile, type UpdateAssistantProfileInput, type AssistantGoal } from "@morrow/contracts";

const SINGLETON_ID = "default";

function mapProfile(row: Record<string, unknown>): AssistantProfile {
  return AssistantProfileSchema.parse({
    version: 1,
    id: "default",
    displayName: row.display_name ?? null,
    assistantName: row.assistant_name ?? null,
    commsVerbosity: row.comms_verbosity,
    commsTone: row.comms_tone,
    timezone: row.timezone ?? null,
    locale: row.locale ?? null,
    defaultProviderId: row.default_provider_id ?? null,
    defaultModel: row.default_model ?? null,
    defaultReasoning: JSON.parse(String(row.default_reasoning_json ?? '{"mode":"auto"}')),
    defaultPrivacyMode: row.default_privacy_mode,
    defaultApprovalPosture: row.default_approval_posture,
    goals: JSON.parse(String(row.goals_json ?? "[]")),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * Single local, cross-project row — this is deliberately the one entity in
 * Morrow that is NOT project-scoped (see docs/decisions/0012). Never
 * client-created with an arbitrary id; `get()` lazily materializes the
 * singleton with defaults on first read so callers never special-case "no
 * profile yet".
 */
export function assistantProfileRepository(db: Database.Database) {
  return {
    get(): AssistantProfile {
      let row = db.prepare("SELECT * FROM assistant_profile WHERE id=?").get(SINGLETON_ID) as Record<string, unknown> | undefined;
      if (!row) {
        const now = new Date().toISOString();
        db.prepare("INSERT INTO assistant_profile(id,schema_version,created_at,updated_at) VALUES(?,1,?,?)")
          .run(SINGLETON_ID, now, now);
        row = db.prepare("SELECT * FROM assistant_profile WHERE id=?").get(SINGLETON_ID) as Record<string, unknown>;
      }
      return mapProfile(row);
    },

    update(input: UpdateAssistantProfileInput, updatedAt: string): AssistantProfile {
      this.get(); // ensure the singleton row exists before updating
      const sets: string[] = ["updated_at=?"];
      const vals: unknown[] = [updatedAt];
      if (input.displayName !== undefined) { sets.push("display_name=?"); vals.push(input.displayName); }
      if (input.assistantName !== undefined) { sets.push("assistant_name=?"); vals.push(input.assistantName); }
      if (input.commsVerbosity !== undefined) { sets.push("comms_verbosity=?"); vals.push(input.commsVerbosity); }
      if (input.commsTone !== undefined) { sets.push("comms_tone=?"); vals.push(input.commsTone); }
      if (input.timezone !== undefined) { sets.push("timezone=?"); vals.push(input.timezone); }
      if (input.locale !== undefined) { sets.push("locale=?"); vals.push(input.locale); }
      if (input.defaultProviderId !== undefined) { sets.push("default_provider_id=?"); vals.push(input.defaultProviderId); }
      if (input.defaultModel !== undefined) { sets.push("default_model=?"); vals.push(input.defaultModel); }
      if (input.defaultReasoning !== undefined) { sets.push("default_reasoning_json=?"); vals.push(JSON.stringify(input.defaultReasoning)); }
      if (input.defaultPrivacyMode !== undefined) { sets.push("default_privacy_mode=?"); vals.push(input.defaultPrivacyMode); }
      if (input.defaultApprovalPosture !== undefined) { sets.push("default_approval_posture=?"); vals.push(input.defaultApprovalPosture); }
      vals.push(SINGLETON_ID);
      db.prepare(`UPDATE assistant_profile SET ${sets.join(", ")} WHERE id=?`).run(...vals);
      return this.get();
    },

    /** A user-authored goal is a direct write. Model-suggested facts never
     * land here directly — they become candidate memory_entries rows that
     * require explicit approval first (see repositories/memory.ts). */
    addGoal(goal: AssistantGoal, updatedAt: string): AssistantProfile {
      const current = this.get();
      const goals = [...current.goals, goal];
      db.prepare("UPDATE assistant_profile SET goals_json=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(goals), updatedAt, SINGLETON_ID);
      return this.get();
    },

    setGoalEnabled(goalId: string, enabled: boolean, updatedAt: string): AssistantProfile {
      const current = this.get();
      const goals = current.goals.map((g) => (g.id === goalId ? { ...g, enabled } : g));
      db.prepare("UPDATE assistant_profile SET goals_json=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(goals), updatedAt, SINGLETON_ID);
      return this.get();
    },

    removeGoal(goalId: string, updatedAt: string): AssistantProfile {
      const current = this.get();
      const goals = current.goals.filter((g) => g.id !== goalId);
      db.prepare("UPDATE assistant_profile SET goals_json=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(goals), updatedAt, SINGLETON_ID);
      return this.get();
    },
  };
}
