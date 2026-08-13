import type Database from "better-sqlite3";
import { HandoffSchema, type Handoff } from "@morrow/contracts";

function mapHandoff(row: Record<string, unknown>): Handoff {
  return HandoffSchema.parse({
    version: 1,
    id: row.id,
    delegationId: row.delegation_id,
    taskId: row.task_id,
    resultSummary: row.result_summary,
    acceptanceCriteriaStatus: JSON.parse(String(row.acceptance_criteria_status_json ?? "[]")),
    artifactRefs: JSON.parse(String(row.artifact_refs_json ?? "[]")),
    verificationEvidence: row.verification_evidence ?? null,
    unresolvedRisks: JSON.parse(String(row.unresolved_risks_json ?? "[]")),
    sourceAgentId: row.source_agent_id,
    targetAgentId: row.target_agent_id ?? null,
    createdAt: row.created_at,
  });
}

export interface CreateHandoffInput {
  id: string;
  delegationId: string;
  taskId: string;
  resultSummary: string;
  acceptanceCriteriaStatus: { criterion: string; met: boolean; note: string | null }[];
  artifactRefs: { id: string; path: string; contentHash: string }[];
  verificationEvidence: string | null;
  unresolvedRisks: string[];
  sourceAgentId: string;
  targetAgentId: string | null;
  createdAt: string;
}

/**
 * A durable handoff record — never a model's prose alone. Callers must
 * populate acceptanceCriteriaStatus/artifactRefs/verificationEvidence with
 * real, inspectable proof; the parent task reads this row, not chat text.
 */
export function handoffsRepository(db: Database.Database) {
  return {
    create(input: CreateHandoffInput): Handoff {
      db.prepare(
        `INSERT INTO handoffs(
           id,schema_version,delegation_id,task_id,result_summary,
           acceptance_criteria_status_json,artifact_refs_json,verification_evidence,unresolved_risks_json,
           source_agent_id,target_agent_id,created_at
         ) VALUES(?,1,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        input.id,
        input.delegationId,
        input.taskId,
        input.resultSummary,
        JSON.stringify(input.acceptanceCriteriaStatus),
        JSON.stringify(input.artifactRefs),
        input.verificationEvidence,
        JSON.stringify(input.unresolvedRisks),
        input.sourceAgentId,
        input.targetAgentId,
        input.createdAt,
      );
      return this.get(input.id)!;
    },

    get(id: string): Handoff | undefined {
      const row = db.prepare("SELECT * FROM handoffs WHERE id=?").get(id) as Record<string, unknown> | undefined;
      return row ? mapHandoff(row) : undefined;
    },

    getByDelegation(delegationId: string): Handoff | undefined {
      const row = db.prepare("SELECT * FROM handoffs WHERE delegation_id=? ORDER BY created_at DESC LIMIT 1")
        .get(delegationId) as Record<string, unknown> | undefined;
      return row ? mapHandoff(row) : undefined;
    },

    listByTask(taskId: string): Handoff[] {
      return db.prepare("SELECT * FROM handoffs WHERE task_id=? ORDER BY created_at ASC")
        .all(taskId).map((r) => mapHandoff(r as Record<string, unknown>));
    },
  };
}
