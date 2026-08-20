import type Database from "better-sqlite3";
import {
  RoutineSchema,
  RoutineRecordingSchema,
  type CreateRoutineInput,
  type Routine,
  type RoutineRecording,
  type UpdateRoutineInput,
} from "@morrow/contracts";

function mapRoutine(row: Record<string, unknown>): Routine {
  return RoutineSchema.parse({
    version: 1,
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id ?? null,
    name: row.name,
    objective: row.objective,
    steps: JSON.parse(String(row.steps_json ?? "[]")),
    sourceConversationId: row.source_conversation_id ?? null,
    runCount: Number(row.run_count ?? 0),
    lastRunAt: row.last_run_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapRecording(row: Record<string, unknown>): RoutineRecording {
  return RoutineRecordingSchema.parse({
    version: 1,
    id: row.id,
    conversationId: row.conversation_id,
    agentId: row.agent_id ?? null,
    routineId: row.routine_id ?? null,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at ?? null,
  });
}

export function routinesRepository(db: Database.Database) {
  return {
    // ── Routines ─────────────────────────────────────────────────────────────

    listByProject(projectId: string): Routine[] {
      return db.prepare("SELECT * FROM routines WHERE project_id=? ORDER BY updated_at DESC, id")
        .all(projectId).map((row) => mapRoutine(row as Record<string, unknown>));
    },

    get(id: string): Routine | undefined {
      const row = db.prepare("SELECT * FROM routines WHERE id=?").get(id) as Record<string, unknown> | undefined;
      return row ? mapRoutine(row) : undefined;
    },

    /**
     * Update only the user-editable definition. Provenance, run counters and
     * timestamps for prior executions stay untouched so editing a routine
     * never rewrites its history.
     */
    update(id: string, projectId: string, input: UpdateRoutineInput, updatedAt: string): Routine | undefined {
      const current = this.get(id);
      if (!current || current.projectId !== projectId) return undefined;
      const name = input.name ?? current.name;
      const objective = input.objective ?? current.objective;
      const steps = input.steps ?? current.steps;
      db.prepare(
        "UPDATE routines SET name=?, objective=?, steps_json=?, updated_at=? WHERE id=? AND project_id=?",
      ).run(name, objective, JSON.stringify(steps), updatedAt, id, projectId);
      return this.get(id);
    },

    create(input: { id: string; projectId: string; now: string } & CreateRoutineInput): Routine {
      db.prepare(
        `INSERT INTO routines (id,project_id,agent_id,name,objective,steps_json,source_conversation_id,run_count,last_run_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,0,NULL,?,?)`,
      ).run(
        input.id,
        input.projectId,
        input.agentId ?? null,
        input.name,
        input.objective,
        JSON.stringify(input.steps ?? []),
        input.sourceConversationId ?? null,
        input.now,
        input.now,
      );
      return this.get(input.id)!;
    },

    /** Counts a run against the routine. Never widens anything — bookkeeping only. */
    recordRun(id: string, at: string): Routine | undefined {
      db.prepare("UPDATE routines SET run_count=run_count+1, last_run_at=?, updated_at=? WHERE id=?").run(at, at, id);
      return this.get(id);
    },

    delete(id: string, projectId: string): boolean {
      return db.prepare("DELETE FROM routines WHERE id=? AND project_id=?").run(id, projectId).changes > 0;
    },

    // ── Recordings ───────────────────────────────────────────────────────────

    /**
     * The thread's open recording, if it has one. The unique partial index
     * guarantees there is at most one, so this cannot silently pick between
     * two half-open spans.
     */
    openForConversation(conversationId: string): RoutineRecording | undefined {
      const row = db.prepare(
        "SELECT * FROM routine_recordings WHERE conversation_id=? AND stopped_at IS NULL",
      ).get(conversationId) as Record<string, unknown> | undefined;
      return row ? mapRecording(row) : undefined;
    },

    /** The most recent recording, open or closed — what the UI reads back from. */
    latestForConversation(conversationId: string): RoutineRecording | undefined {
      const row = db.prepare(
        "SELECT * FROM routine_recordings WHERE conversation_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1",
      ).get(conversationId) as Record<string, unknown> | undefined;
      return row ? mapRecording(row) : undefined;
    },

    startRecording(input: {
      id: string;
      projectId: string;
      conversationId: string;
      agentId: string | null;
      startedAt: string;
    }): RoutineRecording {
      db.prepare(
        "INSERT INTO routine_recordings (id,project_id,conversation_id,agent_id,started_at,stopped_at,routine_id) VALUES (?,?,?,?,?,NULL,NULL)",
      ).run(input.id, input.projectId, input.conversationId, input.agentId, input.startedAt);
      return mapRecording(
        db.prepare("SELECT * FROM routine_recordings WHERE id=?").get(input.id) as Record<string, unknown>,
      );
    },

    stopRecording(id: string, stoppedAt: string): RoutineRecording | undefined {
      db.prepare("UPDATE routine_recordings SET stopped_at=? WHERE id=? AND stopped_at IS NULL").run(stoppedAt, id);
      const row = db.prepare("SELECT * FROM routine_recordings WHERE id=?").get(id) as Record<string, unknown> | undefined;
      return row ? mapRecording(row) : undefined;
    },

    /** Links the recording to the routine the user chose to keep from it. */
    attachRoutine(id: string, routineId: string): void {
      db.prepare("UPDATE routine_recordings SET routine_id=? WHERE id=?").run(routineId, id);
    },
  };
}

export type RoutinesRepository = ReturnType<typeof routinesRepository>;
