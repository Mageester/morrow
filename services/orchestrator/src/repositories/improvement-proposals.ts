import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  ImprovementEvaluationSchema,
  ImprovementProposalSchema,
  type ImprovementEvaluation,
  type ImprovementProposal,
  type ImprovementProposalDraft,
  type ImprovementRolloutState,
} from "@morrow/contracts";

type ProposalRow = {
  id: string;
  version: number;
  observed_problem: string;
  proposed_change_json: string;
  evidence_task_ids_json: string;
  benchmark_fixture_ids_json: string;
  expected_effect_json: string;
  privacy_impact_json: string;
  rollout_state: ImprovementRolloutState;
  rollback_reference: string | null;
  evaluation_json: string | null;
  created_at: string;
  updated_at: string;
};

type VersionRow = {
  id: string;
  proposal_id: string;
  version: number;
  action: "created" | "evaluated" | "approved" | "rejected" | "rolled_back";
  actor: string;
  details_json: string;
  created_at: string;
};

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Malformed persisted ${label}`);
  }
}

function mapRow(row: ProposalRow): ImprovementProposal {
  const evaluation = row.evaluation_json === null
    ? undefined
    : ImprovementEvaluationSchema.parse(parseJson(row.evaluation_json, "improvement evaluation"));
  return ImprovementProposalSchema.parse({
    id: row.id,
    version: row.version,
    observedProblem: row.observed_problem,
    proposedChange: parseJson(row.proposed_change_json, "improvement change"),
    evidenceTaskIds: parseJson(row.evidence_task_ids_json, "improvement task evidence"),
    benchmarkFixtureIds: parseJson(row.benchmark_fixture_ids_json, "improvement fixture evidence"),
    expectedEffect: parseJson(row.expected_effect_json, "improvement expected effect"),
    privacyImpact: parseJson(row.privacy_impact_json, "improvement privacy impact"),
    rolloutState: row.rollout_state,
    rollbackReference: row.rollback_reference,
    ...(evaluation ? { evaluation } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function actorValue(actor: string | undefined): string {
  const value = actor?.trim();
  return value ? value.slice(0, 120) : "system";
}

export interface ImprovementProposalRepository {
  create(input: ImprovementProposalDraft): ImprovementProposal;
  get(id: string): ImprovementProposal | undefined;
  list(): ImprovementProposal[];
  recordEvaluation(id: string, evaluation: ImprovementEvaluation): ImprovementProposal;
  approve(id: string, input?: { actor?: string; note?: string }): ImprovementProposal;
  reject(id: string, input?: { actor?: string; note?: string }): ImprovementProposal;
  rollback(id: string, input: { actor?: string; reference: string }): ImprovementProposal;
  listVersions(id: string): Array<{ id: string; proposalId: string; version: number; action: VersionRow["action"]; actor: string; details: unknown; createdAt: string }>;
}

export function improvementProposalsRepository(db: Database.Database): ImprovementProposalRepository {
  const get = (id: string): ImprovementProposal | undefined => {
    const row = db.prepare("SELECT * FROM improvement_proposals WHERE id=?").get(id) as ProposalRow | undefined;
    return row ? mapRow(row) : undefined;
  };

  const requireProposal = (id: string): ImprovementProposal => {
    const proposal = get(id);
    if (!proposal) throw new Error(`Unknown improvement proposal ${id}`);
    return proposal;
  };

  const appendVersion = (proposal: ImprovementProposal, action: VersionRow["action"], actor: string, details: unknown): void => {
    db.prepare(`INSERT INTO improvement_proposal_versions
      (id,proposal_id,version,action,actor,details_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(
      randomUUID(), proposal.id, proposal.version, action, actorValue(actor), JSON.stringify(details), proposal.updatedAt,
    );
  };

  const updateState = (
    id: string,
    state: ImprovementRolloutState,
    action: "approved" | "rejected" | "rolled_back",
    details: Record<string, unknown>,
    actor?: string,
    rollbackReference?: string | null,
  ): ImprovementProposal => db.transaction(() => {
    const current = requireProposal(id);
    const updatedAt = new Date().toISOString();
    const next = {
      ...current,
      version: current.version + 1,
      rolloutState: state,
      rollbackReference: rollbackReference === undefined ? current.rollbackReference : rollbackReference,
      updatedAt,
    } satisfies ImprovementProposal;
    const parsed = ImprovementProposalSchema.parse(next);
    db.prepare(`UPDATE improvement_proposals SET version=?,rollout_state=?,rollback_reference=?,updated_at=? WHERE id=?`).run(
      parsed.version, parsed.rolloutState, parsed.rollbackReference, parsed.updatedAt, parsed.id,
    );
    appendVersion(parsed, action, actorValue(actor), details);
    return parsed;
  })();

  return {
    create(input) {
      const now = new Date().toISOString();
      const proposal = ImprovementProposalSchema.parse({
        ...input,
        id: randomUUID(),
        version: 1,
        rolloutState: "proposed",
        rollbackReference: null,
        createdAt: now,
        updatedAt: now,
      });
      return db.transaction(() => {
        db.prepare(`INSERT INTO improvement_proposals
          (id,version,observed_problem,proposed_change_json,evidence_task_ids_json,benchmark_fixture_ids_json,
           expected_effect_json,privacy_impact_json,rollout_state,rollback_reference,evaluation_json,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          proposal.id,
          proposal.version,
          proposal.observedProblem,
          JSON.stringify(proposal.proposedChange),
          JSON.stringify(proposal.evidenceTaskIds),
          JSON.stringify(proposal.benchmarkFixtureIds),
          JSON.stringify(proposal.expectedEffect),
          JSON.stringify(proposal.privacyImpact),
          proposal.rolloutState,
          proposal.rollbackReference,
          null,
          proposal.createdAt,
          proposal.updatedAt,
        );
        appendVersion(proposal, "created", "system", { evidenceTaskIds: proposal.evidenceTaskIds, benchmarkFixtureIds: proposal.benchmarkFixtureIds });
        return proposal;
      })();
    },
    get,
    list: () => (db.prepare("SELECT * FROM improvement_proposals ORDER BY updated_at DESC,id ASC").all() as ProposalRow[]).map(mapRow),
    recordEvaluation(id, evaluation) {
      const parsedEvaluation = ImprovementEvaluationSchema.parse(evaluation);
      return db.transaction(() => {
        const current = requireProposal(id);
        if (parsedEvaluation.proposalId !== id) throw new Error("Improvement evaluation proposal identity mismatch");
        if (parsedEvaluation.proposalVersion !== current.version) throw new Error("Improvement evaluation proposal version mismatch");
        if (!current.benchmarkFixtureIds.includes(parsedEvaluation.fixtureId)) throw new Error("Improvement evaluation fixture is not declared by the proposal");
        const updatedAt = new Date().toISOString();
        db.prepare("UPDATE improvement_proposals SET rollout_state='evaluated',evaluation_json=?,updated_at=? WHERE id=?").run(
          JSON.stringify(parsedEvaluation), updatedAt, id,
        );
        const updated = requireProposal(id)!;
        appendVersion(updated, "evaluated", "system", { fixtureId: parsedEvaluation.fixtureId, promotable: parsedEvaluation.promotable });
        return updated;
      })();
    },
    approve(id, input = {}) {
      const proposal = requireProposal(id);
      if (proposal.rolloutState !== "evaluated" || !proposal.evaluation?.promotable) {
        throw new Error("Improvement proposal must have a clean shadow evaluation before approval");
      }
      return updateState(id, "approved", "approved", { note: input.note ?? null }, input.actor);
    },
    reject(id, input = {}) {
      return updateState(id, "rejected", "rejected", { note: input.note ?? null }, input.actor);
    },
    rollback(id, input) {
      if (!input.reference.trim()) throw new Error("Rollback reference is required");
      return updateState(id, "rolled_back", "rolled_back", { reference: input.reference }, input.actor, input.reference);
    },
    listVersions(id) {
      return (db.prepare("SELECT * FROM improvement_proposal_versions WHERE proposal_id=? ORDER BY version ASC,created_at ASC,id ASC").all(id) as VersionRow[]).map((row) => ({
        id: row.id,
        proposalId: row.proposal_id,
        version: row.version,
        action: row.action,
        actor: row.actor,
        details: parseJson(row.details_json, "improvement proposal version details"),
        createdAt: row.created_at,
      }));
    },
  };
}
