import type Database from "better-sqlite3";
import type {
  Mission, MissionStatus, MissionCriterion, MissionCriterionState, MissionEvidence,
  MissionFailure, MissionCheckpoint, MissionReview, MissionBudget, MissionResult,
  MissionEvent, MissionEventType, MissionVerificationStrategy,
  MissionContract, MissionRequirementNode, MissionCursor, ProjectActiveMission,
  RequirementSource, RequirementNodeStatus,
} from "@morrow/contracts";

const SCHEMA_VERSION = 1;

function mapCriterion(row: any): MissionCriterion {
  return {
    id: row.id,
    missionId: row.mission_id,
    order: row.ordering,
    description: row.description,
    state: row.state as MissionCriterionState,
    verification: JSON.parse(row.verification_json) as MissionVerificationStrategy,
    evidenceIds: JSON.parse(row.evidence_ids_json ?? "[]"),
    failureReason: row.failure_reason ?? null,
    waiverReason: row.waiver_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvidence(row: any): MissionEvidence {
  return {
    id: row.id,
    missionId: row.mission_id,
    criterionIds: JSON.parse(row.criterion_ids_json ?? "[]"),
    type: row.type,
    summary: row.summary,
    command: row.command ?? null,
    exitCode: row.exit_code ?? null,
    outputRef: row.output_ref ?? null,
    artifactPath: row.artifact_path ?? null,
    status: row.status,
    recordedAt: row.recorded_at,
  };
}

function mapFailure(row: any): MissionFailure {
  return {
    id: row.id,
    missionId: row.mission_id,
    taskId: row.task_id ?? null,
    agentId: row.agent_id ?? null,
    operation: row.operation,
    normalizedSignature: row.normalized_signature,
    category: row.category,
    message: row.message,
    attempt: row.attempt,
    recoveryStrategy: row.recovery_strategy ?? null,
    recovered: row.recovered === 1,
    createdAt: row.created_at,
  };
}

function mapCheckpoint(row: any): MissionCheckpoint {
  return {
    id: row.id,
    missionId: row.mission_id,
    label: row.label,
    reason: row.reason,
    gitRef: row.git_ref ?? null,
    checkpointName: row.checkpoint_name ?? null,
    affectedFiles: JSON.parse(row.affected_files_json ?? "[]"),
    rollbackAvailable: row.rollback_available === 1,
    createdAt: row.created_at,
  };
}

function mapReview(row: any): MissionReview {
  const payload = JSON.parse(row.payload_json);
  return {
    id: row.id,
    missionId: row.mission_id,
    verdict: row.verdict,
    reviewerProvider: row.reviewer_provider ?? null,
    reviewerModel: row.reviewer_model ?? null,
    criterionJudgments: payload.criterionJudgments ?? [],
    regressionRisks: payload.regressionRisks ?? [],
    suspiciousChanges: payload.suspiciousChanges ?? [],
    missingVerification: payload.missingVerification ?? [],
    concerns: payload.concerns ?? [],
    recommendedStatus: payload.recommendedStatus,
    summary: payload.summary ?? "",
    createdAt: row.created_at,
  };
}

function mapEvent(row: any): MissionEvent {
  return {
    id: row.id,
    missionId: row.mission_id,
    sequence: row.sequence,
    type: row.type,
    summary: row.summary,
    data: JSON.parse(row.data_json ?? "{}"),
    createdAt: row.created_at,
  };
}

function mapRequirementNode(row: any): MissionRequirementNode {
  return {
    version: 1,
    id: row.id,
    missionId: row.mission_id,
    order: row.ordering,
    statement: row.statement,
    source: row.source as RequirementSource,
    confidence: row.confidence,
    approved: row.approved === 1,
    status: row.status as RequirementNodeStatus,
    verifiedFileHash: row.verified_file_hash ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapContract(row: any): MissionContract {
  return {
    version: 1,
    missionId: row.mission_id,
    sourcePrompt: row.source_prompt,
    requirements: [],
    unresolvedAmbiguities: JSON.parse(row.unresolved_ambiguities_json ?? "[]"),
    frozen: row.frozen === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCursor(row: any): MissionCursor {
  return {
    version: 1,
    missionId: row.mission_id,
    activeNodeId: row.active_node_id ?? null,
    allowedActions: JSON.parse(row.allowed_actions_json ?? "[]"),
    reason: row.reason ?? null,
    updatedAt: row.updated_at,
  };
}

function mapProjectActiveMission(row: any): ProjectActiveMission {
  return {
    version: 1,
    projectId: row.project_id,
    missionId: row.mission_id,
    updatedAt: row.updated_at,
  };
}

export function missionsRepository(db: Database.Database) {
  const repo = {
    create(input: {
      id: string; projectId: string; conversationId?: string | null;
      objective: string; autoApprove?: boolean; budget: MissionBudget;
    }, now = new Date().toISOString()): Mission {
      db.prepare(
        `INSERT INTO missions (id, schema_version, project_id, conversation_id, objective, status, auto_approve, task_tree_root_id, budget_json, result_json, created_at, updated_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, NULL, ?, NULL, ?, ?, NULL, NULL)`,
      ).run(input.id, SCHEMA_VERSION, input.projectId, input.conversationId ?? null, input.objective,
        input.autoApprove ? 1 : 0, JSON.stringify(input.budget), now, now);
      return repo.get(input.id)!;
    },

    get(id: string): Mission | undefined {
      const row = db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as any;
      if (!row) return undefined;
      return repo.hydrate(row);
    },

    hydrate(row: any): Mission {
      const criteria = db.prepare("SELECT * FROM mission_criteria WHERE mission_id = ? ORDER BY ordering ASC").all(row.id).map(mapCriterion);
      const evidence = db.prepare("SELECT * FROM mission_evidence WHERE mission_id = ? ORDER BY recorded_at ASC").all(row.id).map(mapEvidence);
      const failures = db.prepare("SELECT * FROM mission_failures WHERE mission_id = ? ORDER BY created_at ASC").all(row.id).map(mapFailure);
      const checkpoints = db.prepare("SELECT * FROM mission_checkpoints WHERE mission_id = ? ORDER BY created_at ASC").all(row.id).map(mapCheckpoint);
      const reviewRow = db.prepare("SELECT * FROM mission_reviews WHERE mission_id = ? ORDER BY created_at DESC LIMIT 1").get(row.id) as any;
      return {
        version: 1,
        id: row.id,
        projectId: row.project_id,
        conversationId: row.conversation_id ?? null,
        objective: row.objective,
        status: row.status as MissionStatus,
        autoApprove: row.auto_approve === 1,
        criteria,
        taskTreeRootId: row.task_tree_root_id ?? null,
        budget: JSON.parse(row.budget_json) as MissionBudget,
        checkpoints,
        evidence,
        failures,
        finalReview: reviewRow ? mapReview(reviewRow) : null,
        result: row.result_json ? (JSON.parse(row.result_json) as MissionResult) : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at ?? null,
        completedAt: row.completed_at ?? null,
      };
    },

    listByProject(projectId: string, limit = 50): Mission[] {
      const rows = db.prepare("SELECT * FROM missions WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, limit) as any[];
      return rows.map((r) => repo.hydrate(r));
    },

    setStatus(id: string, status: MissionStatus, now = new Date().toISOString()): void {
      const patch: string[] = ["status = ?", "updated_at = ?"];
      const params: any[] = [status, now];
      if (status === "running") { patch.push("started_at = COALESCE(started_at, ?)"); params.push(now); }
      const terminal = ["completed", "completed_with_reservations", "partially_completed", "blocked", "failed", "cancelled"];
      if (terminal.includes(status)) { patch.push("completed_at = ?"); params.push(now); }
      params.push(id);
      db.prepare(`UPDATE missions SET ${patch.join(", ")} WHERE id = ?`).run(...params);
    },

    updateBudget(id: string, budget: MissionBudget, now = new Date().toISOString()): void {
      db.prepare("UPDATE missions SET budget_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(budget), now, id);
    },

    setTaskTreeRoot(id: string, taskId: string, now = new Date().toISOString()): void {
      db.prepare("UPDATE missions SET task_tree_root_id = ?, updated_at = ? WHERE id = ?").run(taskId, now, id);
    },

    setResult(id: string, result: MissionResult, now = new Date().toISOString()): void {
      db.prepare("UPDATE missions SET result_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(result), now, id);
    },

    // ── criteria ──────────────────────────────────────────────────────────
    addCriteria(missionId: string, criteria: Array<{ id: string; description: string; verification: MissionVerificationStrategy; state?: MissionCriterionState }>, now = new Date().toISOString()): void {
      const startOrder = (db.prepare("SELECT COALESCE(MAX(ordering), -1) n FROM mission_criteria WHERE mission_id = ?").get(missionId) as any).n + 1;
      const stmt = db.prepare(
        `INSERT INTO mission_criteria (id, mission_id, ordering, description, state, verification_json, evidence_ids_json, failure_reason, waiver_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', NULL, NULL, ?, ?)`,
      );
      db.transaction(() => {
        criteria.forEach((c, i) => stmt.run(c.id, missionId, startOrder + i, c.description, c.state ?? "proposed", JSON.stringify(c.verification), now, now));
      })();
    },

    updateCriterion(id: string, patch: Partial<{ description: string; state: MissionCriterionState; verification: MissionVerificationStrategy; failureReason: string | null; waiverReason: string | null; evidenceIds: string[] }>, now = new Date().toISOString()): MissionCriterion | undefined {
      const sets: string[] = ["updated_at = ?"];
      const params: any[] = [now];
      if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
      if (patch.state !== undefined) { sets.push("state = ?"); params.push(patch.state); }
      if (patch.verification !== undefined) { sets.push("verification_json = ?"); params.push(JSON.stringify(patch.verification)); }
      if (patch.failureReason !== undefined) { sets.push("failure_reason = ?"); params.push(patch.failureReason); }
      if (patch.waiverReason !== undefined) { sets.push("waiver_reason = ?"); params.push(patch.waiverReason); }
      if (patch.evidenceIds !== undefined) { sets.push("evidence_ids_json = ?"); params.push(JSON.stringify(patch.evidenceIds)); }
      params.push(id);
      db.prepare(`UPDATE mission_criteria SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      const row = db.prepare("SELECT * FROM mission_criteria WHERE id = ?").get(id) as any;
      return row ? mapCriterion(row) : undefined;
    },

    getCriterion(id: string): MissionCriterion | undefined {
      const row = db.prepare("SELECT * FROM mission_criteria WHERE id = ?").get(id) as any;
      return row ? mapCriterion(row) : undefined;
    },

    listCriteria(missionId: string): MissionCriterion[] {
      return db.prepare("SELECT * FROM mission_criteria WHERE mission_id = ? ORDER BY ordering ASC").all(missionId).map(mapCriterion);
    },

    removeCriterion(id: string): boolean {
      return db.prepare("DELETE FROM mission_criteria WHERE id = ?").run(id).changes > 0;
    },

    // ── evidence ──────────────────────────────────────────────────────────
    addEvidence(e: Omit<MissionEvidence, "recordedAt"> & { recordedAt?: string }): MissionEvidence {
      const now = e.recordedAt ?? new Date().toISOString();
      db.prepare(
        `INSERT INTO mission_evidence (id, mission_id, criterion_ids_json, type, summary, command, exit_code, output_ref, artifact_path, status, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(e.id, e.missionId, JSON.stringify(e.criterionIds ?? []), e.type, e.summary, e.command ?? null, e.exitCode ?? null, e.outputRef ?? null, e.artifactPath ?? null, e.status, now);
      // Link evidence into each referenced criterion's evidenceIds list.
      for (const cid of e.criterionIds ?? []) {
        const c = repo.getCriterion(cid);
        if (c && !c.evidenceIds.includes(e.id)) repo.updateCriterion(cid, { evidenceIds: [...c.evidenceIds, e.id] }, now);
      }
      return mapEvidence(db.prepare("SELECT * FROM mission_evidence WHERE id = ?").get(e.id));
    },

    listEvidence(missionId: string): MissionEvidence[] {
      return db.prepare("SELECT * FROM mission_evidence WHERE mission_id = ? ORDER BY recorded_at ASC").all(missionId).map(mapEvidence);
    },

    getEvidence(id: string): MissionEvidence | undefined {
      const row = db.prepare("SELECT * FROM mission_evidence WHERE id = ?").get(id) as any;
      return row ? mapEvidence(row) : undefined;
    },

    // ── failures ──────────────────────────────────────────────────────────
    addFailure(f: Omit<MissionFailure, "createdAt"> & { createdAt?: string }): MissionFailure {
      const now = f.createdAt ?? new Date().toISOString();
      db.prepare(
        `INSERT INTO mission_failures (id, mission_id, task_id, agent_id, operation, normalized_signature, category, message, attempt, recovery_strategy, recovered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(f.id, f.missionId, f.taskId ?? null, f.agentId ?? null, f.operation, f.normalizedSignature, f.category, f.message, f.attempt, f.recoveryStrategy ?? null, f.recovered ? 1 : 0, now);
      return mapFailure(db.prepare("SELECT * FROM mission_failures WHERE id = ?").get(f.id));
    },

    markFailureRecovered(id: string, recoveryStrategy: string): void {
      db.prepare("UPDATE mission_failures SET recovered = 1, recovery_strategy = COALESCE(recovery_strategy, ?) WHERE id = ?").run(recoveryStrategy, id);
    },

    countBySignature(missionId: string, signature: string): number {
      return (db.prepare("SELECT COUNT(*) n FROM mission_failures WHERE mission_id = ? AND normalized_signature = ?").get(missionId, signature) as any).n;
    },

    listFailures(missionId: string): MissionFailure[] {
      return db.prepare("SELECT * FROM mission_failures WHERE mission_id = ? ORDER BY created_at ASC").all(missionId).map(mapFailure);
    },

    // ── checkpoints ───────────────────────────────────────────────────────
    addCheckpoint(c: Omit<MissionCheckpoint, "createdAt"> & { createdAt?: string }): MissionCheckpoint {
      const now = c.createdAt ?? new Date().toISOString();
      db.prepare(
        `INSERT INTO mission_checkpoints (id, mission_id, label, reason, git_ref, checkpoint_name, affected_files_json, rollback_available, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(c.id, c.missionId, c.label, c.reason, c.gitRef ?? null, c.checkpointName ?? null, JSON.stringify(c.affectedFiles ?? []), c.rollbackAvailable ? 1 : 0, now);
      return mapCheckpoint(db.prepare("SELECT * FROM mission_checkpoints WHERE id = ?").get(c.id));
    },

    getCheckpoint(id: string): MissionCheckpoint | undefined {
      const row = db.prepare("SELECT * FROM mission_checkpoints WHERE id = ?").get(id) as any;
      return row ? mapCheckpoint(row) : undefined;
    },

    listCheckpoints(missionId: string): MissionCheckpoint[] {
      return db.prepare("SELECT * FROM mission_checkpoints WHERE mission_id = ? ORDER BY created_at ASC").all(missionId).map(mapCheckpoint);
    },

    // ── review ────────────────────────────────────────────────────────────
    setReview(r: MissionReview): MissionReview {
      const payload = {
        criterionJudgments: r.criterionJudgments,
        regressionRisks: r.regressionRisks,
        suspiciousChanges: r.suspiciousChanges,
        missingVerification: r.missingVerification,
        concerns: r.concerns,
        recommendedStatus: r.recommendedStatus,
        summary: r.summary,
      };
      db.prepare(
        `INSERT INTO mission_reviews (id, mission_id, verdict, reviewer_provider, reviewer_model, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(r.id, r.missionId, r.verdict, r.reviewerProvider ?? null, r.reviewerModel ?? null, JSON.stringify(payload), r.createdAt);
      return r;
    },

    // ── events ────────────────────────────────────────────────────────────
    appendEvent(missionId: string, type: MissionEventType, summary: string, data: Record<string, unknown> = {}, now = new Date().toISOString()): MissionEvent {
      const seq = (db.prepare("SELECT COALESCE(MAX(sequence), 0) n FROM mission_events WHERE mission_id = ?").get(missionId) as any).n + 1;
      const id = `${missionId}-ev-${seq}`;
      db.prepare(
        `INSERT INTO mission_events (id, mission_id, sequence, type, summary, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, missionId, seq, type, summary, JSON.stringify(data), now);
      return { id, missionId, sequence: seq, type, summary, data, createdAt: now };
    },

    listEvents(missionId: string): MissionEvent[] {
      return db.prepare("SELECT * FROM mission_events WHERE mission_id = ? ORDER BY sequence ASC").all(missionId).map(mapEvent);
    },

    // ── Advanced Execution Kernel: contract + requirement ledger ──────────
    createContract(input: {
      missionId: string;
      sourcePrompt: string;
      unresolvedAmbiguities?: string[];
      nodes: Array<{ id: string; order: number; statement: string; source: RequirementSource; confidence: number; approved: boolean }>;
      now?: string;
    }): MissionContract {
      const now = input.now ?? new Date().toISOString();
      db.prepare(
        `INSERT INTO mission_contracts (mission_id, schema_version, source_prompt, unresolved_ambiguities_json, frozen, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      ).run(input.missionId, SCHEMA_VERSION, input.sourcePrompt, JSON.stringify(input.unresolvedAmbiguities ?? []), now, now);
      this.addRequirementNodes(input.missionId, input.nodes, now);
      return this.getContract(input.missionId)!;
    },

    getContract(missionId: string): MissionContract | undefined {
      const row = db.prepare("SELECT * FROM mission_contracts WHERE mission_id = ?").get(missionId) as any;
      if (!row) return undefined;
      const contract = mapContract(row);
      contract.requirements = this.listRequirementNodes(missionId);
      return contract;
    },

    updateContractAmbiguities(missionId: string, ambiguities: string[], now = new Date().toISOString()): void {
      db.prepare("UPDATE mission_contracts SET unresolved_ambiguities_json = ?, updated_at = ? WHERE mission_id = ?")
        .run(JSON.stringify(ambiguities), now, missionId);
    },

    setContractFrozen(missionId: string, frozen: boolean, now = new Date().toISOString()): void {
      db.prepare("UPDATE mission_contracts SET frozen = ?, updated_at = ? WHERE mission_id = ?")
        .run(frozen ? 1 : 0, now, missionId);
    },

    // ── requirement nodes ──────────────────────────────────────────────────
    addRequirementNodes(missionId: string, nodes: Array<{ id: string; order: number; statement: string; source: RequirementSource; confidence: number; approved: boolean }>, now = new Date().toISOString()): void {
      const stmt = db.prepare(
        `INSERT INTO mission_requirement_nodes (id, mission_id, ordering, statement, source, confidence, approved, status, verified_file_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      );
      db.transaction(() => {
        nodes.forEach((n) => stmt.run(n.id, missionId, n.order, n.statement, n.source, n.confidence, n.approved ? 1 : 0, now, now));
      })();
    },

    updateRequirementNode(id: string, patch: Partial<{ statement: string; approved: boolean; status: RequirementNodeStatus; verifiedFileHash: string | null }>, now = new Date().toISOString()): MissionRequirementNode | undefined {
      const sets: string[] = ["updated_at = ?"];
      const params: any[] = [now];
      if (patch.statement !== undefined) { sets.push("statement = ?"); params.push(patch.statement); }
      if (patch.approved !== undefined) { sets.push("approved = ?"); params.push(patch.approved ? 1 : 0); }
      if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
      if (patch.verifiedFileHash !== undefined) { sets.push("verified_file_hash = ?"); params.push(patch.verifiedFileHash); }
      params.push(id);
      db.prepare(`UPDATE mission_requirement_nodes SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      const row = db.prepare("SELECT * FROM mission_requirement_nodes WHERE id = ?").get(id) as any;
      return row ? mapRequirementNode(row) : undefined;
    },

    getRequirementNode(id: string): MissionRequirementNode | undefined {
      const row = db.prepare("SELECT * FROM mission_requirement_nodes WHERE id = ?").get(id) as any;
      return row ? mapRequirementNode(row) : undefined;
    },

    listRequirementNodes(missionId: string): MissionRequirementNode[] {
      return db.prepare("SELECT * FROM mission_requirement_nodes WHERE mission_id = ? ORDER BY ordering ASC").all(missionId).map(mapRequirementNode);
    },

    // ── cursor (per mission) ─────────────────────────────────────────────
    upsertCursor(cursor: { missionId: string; activeNodeId: string | null; allowedActions: string[]; reason: string | null; now?: string }): MissionCursor {
      const now = cursor.now ?? new Date().toISOString();
      db.prepare(
        `INSERT INTO mission_cursors (mission_id, schema_version, active_node_id, allowed_actions_json, reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(mission_id) DO UPDATE SET active_node_id = excluded.active_node_id, allowed_actions_json = excluded.allowed_actions_json, reason = excluded.reason, updated_at = excluded.updated_at`,
      ).run(cursor.missionId, SCHEMA_VERSION, cursor.activeNodeId, JSON.stringify(cursor.allowedActions), cursor.reason, now);
      const row = db.prepare("SELECT * FROM mission_cursors WHERE mission_id = ?").get(cursor.missionId) as any;
      return mapCursor(row);
    },

    getCursor(missionId: string): MissionCursor | undefined {
      const row = db.prepare("SELECT * FROM mission_cursors WHERE mission_id = ?").get(missionId) as any;
      return row ? mapCursor(row) : undefined;
    },

    // ── project active mission pointer (separate per project) ──────────────
    setProjectActiveMission(projectId: string, missionId: string, now = new Date().toISOString()): void {
      db.prepare(
        `INSERT INTO project_active_mission (project_id, schema_version, mission_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET mission_id = excluded.mission_id, updated_at = excluded.updated_at`,
      ).run(projectId, SCHEMA_VERSION, missionId, now);
    },

    getProjectActiveMission(projectId: string): ProjectActiveMission | undefined {
      const row = db.prepare("SELECT * FROM project_active_mission WHERE project_id = ?").get(projectId) as any;
      return row ? mapProjectActiveMission(row) : undefined;
    },
  };
  return repo;
}

export type MissionsRepository = ReturnType<typeof missionsRepository>;
