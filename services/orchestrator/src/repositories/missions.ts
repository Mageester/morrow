import type Database from "better-sqlite3";
import type {
  Mission, MissionStatus, MissionCriterion, MissionCriterionState, MissionEvidence,
  MissionFailure, MissionCheckpoint, MissionReview, MissionBudget, MissionResult,
  MissionEvent, MissionEventType, MissionVerificationStrategy,
  MissionContract, MissionRequirementNode, MissionCursor, ProjectActiveMission,
  RequirementSource, RequirementNodeStatus, RequirementCategory, ReopenCondition,
  InvalidationEntry, MissionOperationStatus, TaskStatus, ApprovalStatus,
} from "@morrow/contracts";

/** A requirement node as supplied at contract-build time (before persistence). */
export interface ContractRequirementNodeInput {
  id: string;
  order: number;
  statement: string;
  category: RequirementCategory;
  sourcePromptExcerpt: string;
  sourceLocator?: string | null;
  source: RequirementSource;
  confidence: number;
  approved: boolean;
  authoritative: boolean;
  status?: RequirementNodeStatus;
  dependencies?: string[];
  evidenceRefs?: string[];
  affectedFiles?: string[];
  verifiedFileHashes?: string[];
  attempts?: number;
  lastFailure?: string | null;
  completedAt?: string | null;
  invalidationHistory?: InvalidationEntry[];
}

const SCHEMA_VERSION = 1;

/** A durable review-cycle reservation. `status` distinguishes an in-flight
 *  (reserved) cycle from one whose review has actually been applied. */
export interface MissionReviewCycle {
  id: string;
  missionId: string;
  sequence: number;
  status: "reserved" | "applied" | "abandoned";
  reservedAt: string;
  resolvedAt: string | null;
  ownerId: string | null;
  leaseExpiresAt: string | null;
}

function mapReviewCycle(row: any): MissionReviewCycle {
  return {
    id: row.id,
    missionId: row.mission_id,
    sequence: row.sequence,
    status: row.status,
    reservedAt: row.reserved_at,
    resolvedAt: row.resolved_at ?? null,
    ownerId: row.owner_id ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
  };
}

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
    category: row.category as RequirementCategory,
    sourcePromptExcerpt: row.source_prompt_excerpt ?? "",
    sourceLocator: row.source_locator ?? null,
    source: row.source as RequirementSource,
    confidence: row.confidence,
    approved: row.approved === 1,
    authoritative: row.authoritative === 1,
    status: row.status as RequirementNodeStatus,
    dependencies: JSON.parse(row.dependencies_json ?? "[]"),
    evidenceRefs: JSON.parse(row.evidence_refs_json ?? "[]"),
    affectedFiles: JSON.parse(row.affected_files_json ?? "[]"),
    verifiedFileHashes: JSON.parse(row.verified_file_hashes_json ?? "[]"),
    attempts: row.attempts ?? 0,
    lastFailure: row.last_failure_json ?? null,
    completedAt: row.completed_at ?? null,
    invalidationHistory: JSON.parse(row.invalidation_history_json ?? "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapContract(row: any): MissionContract {
  return {
    version: 1,
    missionId: row.mission_id,
    sourcePrompt: row.source_prompt,
    objective: row.objective,
    expectedArtifacts: JSON.parse(row.expected_artifacts_json ?? "[]"),
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json ?? "[]"),
    verificationCommands: JSON.parse(row.verification_commands_json ?? "[]"),
    requiredGitResult: row.required_git_result ?? null,
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
    activeObjective: row.active_objective ?? null,
    allowedNextActions: JSON.parse(row.allowed_next_actions_json ?? "[]"),
    blockedReason: row.blocked_reason ?? null,
    lastCompletedAction: row.last_completed_action ?? null,
    frozenNodeIds: JSON.parse(row.frozen_node_ids_json ?? "[]"),
    invalidatedNodeIds: JSON.parse(row.invalidated_node_ids_json ?? "[]"),
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
      execution?: Mission["execution"];
    }, now = new Date().toISOString()): Mission {
      db.prepare(
        `INSERT INTO missions (id, schema_version, project_id, conversation_id, objective, status, auto_approve, task_tree_root_id, budget_json, result_json, execution_json, created_at, updated_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, NULL, ?, NULL, ?, ?, ?, NULL, NULL)`,
      ).run(input.id, SCHEMA_VERSION, input.projectId, input.conversationId ?? null, input.objective,
        input.autoApprove ? 1 : 0, JSON.stringify(input.budget), JSON.stringify(input.execution ?? {
          preset: "balanced", providerId: null, model: null, reasoning: { mode: "auto" },
        }), now, now);
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
      // The authoritative "final" review is whichever one is referenced by the
      // mission's durable current_review_cycle_id pointer — set exactly once,
      // atomically, when a review cycle is APPLIED (see applyReview in the
      // mission service) — never "whichever mission_reviews row has the
      // greatest created_at". A caller-controlled/backdated timestamp on a
      // review record can therefore never expose an older verdict as current.
      const reviewRow = row.current_review_cycle_id
        ? db.prepare("SELECT * FROM mission_reviews WHERE review_cycle_id = ?").get(row.current_review_cycle_id) as any
        : undefined;
      return {
        version: 1,
        id: row.id,
        projectId: row.project_id,
        conversationId: row.conversation_id ?? null,
        objective: row.objective,
        status: row.status as MissionStatus,
        autoApprove: row.auto_approve === 1,
        execution: JSON.parse(row.execution_json ?? '{"preset":"balanced","providerId":null,"model":null,"reasoning":{"mode":"auto"}}'),
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

    /** Look up a mission by the idempotency key it was created with (scoped to a
     *  project). Mirrors the tasks repository so a repeated create request can
     *  replay the original mission instead of spawning a duplicate. */
    findByIdempotencyKey(projectId: string, key: string): Mission | undefined {
      const row = db.prepare("SELECT * FROM missions WHERE project_id = ? AND idempotency_key = ?").get(projectId, key) as any;
      return row ? repo.hydrate(row) : undefined;
    },

    /** Bind an idempotency key to an already-created mission. The partial unique
     *  index (project_id, idempotency_key) is the durable guard against two
     *  concurrent creates ever sharing a key. */
    setIdempotencyKey(id: string, key: string): void {
      db.prepare("UPDATE missions SET idempotency_key = ? WHERE id = ?").run(key, id);
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

    missionLinkedAgentAnswerState(missionId: string): {
      hasAgentTask: boolean;
      ownerTaskId: string | null;
      ownerTaskStatus: string | null;
      hasCanonicalAnswer: boolean;
      canonicalEvidence: Record<string, unknown> | null;
      evidenceCursorExists: boolean;
      verificationEvidenceCovered: boolean;
      sourceTurnIsFinal: boolean;
    } {
      const row = db.prepare(`SELECT
        t.id AS task_id,
        t.status AS task_status,
        answer.evidence_json,
        EXISTS(
          SELECT 1 FROM task_events event
          WHERE event.task_id=t.id
            AND event.sequence=CAST(json_extract(answer.evidence_json,'$.durableEventCursor') AS INTEGER)
        ) AS evidence_cursor_exists,
        EXISTS(
          SELECT 1 FROM task_events verification_event
          WHERE verification_event.task_id=t.id
            AND verification_event.type='tool.completed'
            AND verification_event.sequence<=CAST(json_extract(answer.evidence_json,'$.durableEventCursor') AS INTEGER)
            AND json_extract(verification_event.payload_json,'$.id')=json_extract(answer.evidence_json,'$.verification.toolCallId')
            AND json_extract(verification_event.payload_json,'$.toolName')='run_command'
            AND json_extract(verification_event.payload_json,'$.status')='completed'
            AND CAST(json_extract(verification_event.payload_json,'$.exitCode') AS INTEGER)=0
        ) AS verification_evidence_covered,
        EXISTS(
          SELECT 1 FROM agent_provider_turns turn
          WHERE turn.task_id=t.id
            AND turn.turn_key=json_extract(answer.evidence_json,'$.sourceTurnKey')
            AND json_valid(turn.tool_calls_json)
            AND json_extract(turn.tool_calls_json,'$.isFinal')=1
        ) AS source_turn_is_final
        FROM tasks t
        LEFT JOIN canonical_task_answers answer ON answer.task_id=t.id AND answer.mission_id=t.mission_id
        WHERE t.mission_id=? AND t.type='agent_chat'
        ORDER BY t.created_at DESC,t.id DESC
        LIMIT 1`).get(missionId) as { task_id: string; task_status: string; evidence_json: string | null; evidence_cursor_exists: number; verification_evidence_covered: number; source_turn_is_final: number } | undefined;
      if (!row) return { hasAgentTask: false, ownerTaskId: null, ownerTaskStatus: null, hasCanonicalAnswer: false, canonicalEvidence: null, evidenceCursorExists: false, verificationEvidenceCovered: false, sourceTurnIsFinal: false };
      return {
        hasAgentTask: true,
        ownerTaskId: row.task_id,
        ownerTaskStatus: row.task_status,
        hasCanonicalAnswer: row.evidence_json !== null,
        canonicalEvidence: row.evidence_json === null ? null : JSON.parse(row.evidence_json) as Record<string, unknown>,
        evidenceCursorExists: row.evidence_cursor_exists === 1,
        verificationEvidenceCovered: row.verification_evidence_covered === 1,
        sourceTurnIsFinal: row.source_turn_is_final === 1,
      };
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
    /** Persist a review, durably tagged with the exact review cycle it belongs
     *  to. `reviewCycleId` is required — every review application (direct or
     *  via runReview) now goes through a reserved mission_review_cycles row
     *  (see reserveReviewCycle), so a review can never be persisted without a
     *  durable cycle identity to anchor it to. */
    setReview(r: MissionReview, reviewCycleId: string): MissionReview {
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
        `INSERT INTO mission_reviews (id, mission_id, verdict, reviewer_provider, reviewer_model, payload_json, created_at, review_cycle_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(r.id, r.missionId, r.verdict, r.reviewerProvider ?? null, r.reviewerModel ?? null, JSON.stringify(payload), r.createdAt, reviewCycleId);
      return r;
    },

    // ── review cycles (durable ownership; see migration 30) ─────────────────
    /** Reserve a new, durably-identified review cycle for a mission. At most
     *  one reserved cycle may exist per mission at a time — enforced by a
     *  partial unique index (mission_review_cycles_one_reserved), NOT merely
     *  by this pre-check — so a concurrent second reservation attempt throws
     *  here and writes nothing (the loser of the race). `sequence` is a
     *  database-generated monotonic counter per mission, used as the
     *  authoritative application order instead of any caller-supplied
     *  timestamp. */
    reserveReviewCycle(id: string, missionId: string, ownerId: string, leaseExpiresAt: string, now = new Date().toISOString()): MissionReviewCycle {
      const seq = (db.prepare("SELECT COALESCE(MAX(sequence), 0) n FROM mission_review_cycles WHERE mission_id = ?").get(missionId) as any).n + 1;
      db.prepare(
        `INSERT INTO mission_review_cycles (id, mission_id, sequence, status, reserved_at, resolved_at, owner_id, lease_expires_at)
         VALUES (?, ?, ?, 'reserved', ?, NULL, ?, ?)`,
      ).run(id, missionId, seq, now, ownerId, leaseExpiresAt);
      return { id, missionId, sequence: seq, status: "reserved", reservedAt: now, resolvedAt: null, ownerId, leaseExpiresAt };
    },

    getReviewCycle(id: string): MissionReviewCycle | undefined {
      const row = db.prepare("SELECT * FROM mission_review_cycles WHERE id = ?").get(id) as any;
      return row ? mapReviewCycle(row) : undefined;
    },

    /** The mission's currently in-flight (reserved, not yet applied) review
     *  cycle, if any. Its mere existence is what blocks finalize() — it is
     *  durable DB state, not an in-memory promise, so it survives a restart. */
    getReservedReviewCycle(missionId: string): MissionReviewCycle | undefined {
      const row = db.prepare("SELECT * FROM mission_review_cycles WHERE mission_id = ? AND status = 'reserved'").get(missionId) as any;
      return row ? mapReviewCycle(row) : undefined;
    },

    /** Extend a cycle lease only for the service instance that still owns the
     * reserved row. Applied/abandoned cycles and replacement cycles owned by
     * another instance are immutable to the old owner. */
    renewReviewCycle(id: string, ownerId: string, leaseExpiresAt: string): boolean {
      return db.prepare(`
        UPDATE mission_review_cycles
        SET lease_expires_at = ?
        WHERE id = ? AND status = 'reserved' AND owner_id = ?
      `).run(leaseExpiresAt, id, ownerId).changes === 1;
    },

    /** Mark a reserved cycle as applied. Idempotent-unsafe by design: calling
     *  this twice for the same cycle is a bug in the caller, not something
     *  this method silently tolerates — callers must check status === 'reserved'
     *  before ever reaching here (see MissionService.applyReview). */
    resolveReviewCycle(id: string, now = new Date().toISOString()): void {
      db.prepare("UPDATE mission_review_cycles SET status = 'applied', resolved_at = ? WHERE id = ?").run(now, id);
    },

    /** Atomically abandon the mission's reservation only when its persisted
     * lease has expired at the injected comparison time. A live lease cannot
     * be stolen by another service instance. */
    abandonExpiredReviewCycle(missionId: string, now: string): MissionReviewCycle | undefined {
      const row = db.prepare(`
        SELECT * FROM mission_review_cycles
        WHERE mission_id = ? AND status = 'reserved' AND lease_expires_at <= ?
      `).get(missionId, now) as any;
      if (!row) return undefined;
      const changed = db.prepare(`
        UPDATE mission_review_cycles
        SET status = 'abandoned', resolved_at = ?
        WHERE id = ? AND status = 'reserved' AND lease_expires_at <= ?
      `).run(now, row.id, now).changes;
      return changed === 1 ? mapReviewCycle({ ...row, status: "abandoned", resolved_at: now }) : undefined;
    },

    /** Abandon a known live reservation as part of a terminal mission
     * transition. Late provider results are then rejected by cycle status. */
    abandonReviewCycle(id: string, now = new Date().toISOString()): boolean {
      return db.prepare(`UPDATE mission_review_cycles
        SET status = 'abandoned', resolved_at = ?
        WHERE id = ? AND status = 'reserved'`).run(now, id).changes === 1;
    },

    /** Point the mission's single authoritative "current review" reference at
     *  the given (just-applied) cycle. This — never mission_reviews.created_at
     *  — is what `hydrate()` reads to resolve `mission.finalReview`. */
    setCurrentReviewCycle(missionId: string, reviewCycleId: string, now = new Date().toISOString()): void {
      db.prepare("UPDATE missions SET current_review_cycle_id = ?, updated_at = ? WHERE id = ?").run(reviewCycleId, now, missionId);
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

    listEventsAfter(missionId: string, afterSequence: number): MissionEvent[] {
      return db.prepare(
        "SELECT * FROM mission_events WHERE mission_id = ? AND sequence > ? ORDER BY sequence ASC",
      ).all(missionId, afterSequence).map(mapEvent);
    },

    // ── Advanced Execution Kernel: contract + requirement ledger ──────────
    createContract(input: {
      missionId: string;
      sourcePrompt: string;
      objective: string;
      expectedArtifacts?: string[];
      acceptanceCriteria?: string[];
      verificationCommands?: string[];
      requiredGitResult?: string | null;
      unresolvedAmbiguities?: string[];
      nodes: ContractRequirementNodeInput[];
      now?: string;
    }): MissionContract {
      const now = input.now ?? new Date().toISOString();
      db.prepare(
        `INSERT INTO mission_contracts (mission_id, schema_version, source_prompt, objective, expected_artifacts_json, acceptance_criteria_json, verification_commands_json, required_git_result, unresolved_ambiguities_json, frozen, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        input.missionId, SCHEMA_VERSION, input.sourcePrompt, input.objective,
        JSON.stringify(input.expectedArtifacts ?? []), JSON.stringify(input.acceptanceCriteria ?? []),
        JSON.stringify(input.verificationCommands ?? []), input.requiredGitResult ?? null,
        JSON.stringify(input.unresolvedAmbiguities ?? []), now, now,
      );
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
    addRequirementNodes(missionId: string, nodes: ContractRequirementNodeInput[], now = new Date().toISOString()): void {
      const stmt = db.prepare(
        `INSERT INTO mission_requirement_nodes (id, mission_id, ordering, statement, category, source_prompt_excerpt, source_locator, source, confidence, approved, authoritative, status, dependencies_json, evidence_refs_json, affected_files_json, verified_file_hashes_json, attempts, last_failure_json, completed_at, invalidation_history_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.transaction(() => {
        nodes.forEach((n) => stmt.run(
          n.id, missionId, n.order, n.statement, n.category, n.sourcePromptExcerpt ?? "",
          n.sourceLocator ?? null,
          n.source, n.confidence, n.approved ? 1 : 0, n.authoritative ? 1 : 0, n.status ?? "pending",
          JSON.stringify(n.dependencies ?? []),
          JSON.stringify(n.evidenceRefs ?? []),
          JSON.stringify(n.affectedFiles ?? []),
          JSON.stringify(n.verifiedFileHashes ?? []),
          n.attempts ?? 0,
          n.lastFailure ?? null,
          n.completedAt ?? null,
          JSON.stringify(n.invalidationHistory ?? []),
          now, now,
        ));
      })();
    },

    updateRequirementNode(id: string, patch: Partial<{
      statement: string; category: RequirementCategory; sourcePromptExcerpt: string; sourceLocator: string | null; source: RequirementSource;
      confidence: number; approved: boolean; authoritative: boolean; status: RequirementNodeStatus;
      dependencies: string[]; evidenceRefs: string[]; affectedFiles: string[]; verifiedFileHashes: string[];
      attempts: number; lastFailure: string | null; completedAt: string | null;
    }>, now = new Date().toISOString()): MissionRequirementNode | undefined {
      // Note: invalidation_history_json is intentionally NOT settable here. It is
      // append-only and may only be mutated through appendInvalidationEntry, which
      // reads the latest persisted row inside a transaction. This prevents a
      // read-copy-overwrite bypass that could silently drop history.
      const sets: string[] = ["updated_at = ?"];
      const params: any[] = [now];
      if (patch.statement !== undefined) { sets.push("statement = ?"); params.push(patch.statement); }
      if (patch.category !== undefined) { sets.push("category = ?"); params.push(patch.category); }
      if (patch.sourcePromptExcerpt !== undefined) { sets.push("source_prompt_excerpt = ?"); params.push(patch.sourcePromptExcerpt); }
      if (patch.sourceLocator !== undefined) { sets.push("source_locator = ?"); params.push(patch.sourceLocator); }
      if (patch.source !== undefined) { sets.push("source = ?"); params.push(patch.source); }
      if (patch.confidence !== undefined) { sets.push("confidence = ?"); params.push(patch.confidence); }
      if (patch.approved !== undefined) { sets.push("approved = ?"); params.push(patch.approved ? 1 : 0); }
      if (patch.authoritative !== undefined) { sets.push("authoritative = ?"); params.push(patch.authoritative ? 1 : 0); }
      if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
      if (patch.dependencies !== undefined) { sets.push("dependencies_json = ?"); params.push(JSON.stringify(patch.dependencies)); }
      if (patch.evidenceRefs !== undefined) { sets.push("evidence_refs_json = ?"); params.push(JSON.stringify(patch.evidenceRefs)); }
      if (patch.affectedFiles !== undefined) { sets.push("affected_files_json = ?"); params.push(JSON.stringify(patch.affectedFiles)); }
      if (patch.verifiedFileHashes !== undefined) { sets.push("verified_file_hashes_json = ?"); params.push(JSON.stringify(patch.verifiedFileHashes)); }
      if (patch.attempts !== undefined) { sets.push("attempts = ?"); params.push(patch.attempts); }
      if (patch.lastFailure !== undefined) { sets.push("last_failure_json = ?"); params.push(patch.lastFailure); }
      if (patch.completedAt !== undefined) { sets.push("completed_at = ?"); params.push(patch.completedAt); }
      params.push(id);
      db.prepare(`UPDATE mission_requirement_nodes SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      const row = db.prepare("SELECT * FROM mission_requirement_nodes WHERE id = ?").get(id) as any;
      return row ? mapRequirementNode(row) : undefined;
    },

    /**
     * Append one invalidation-history entry AND apply the reopen patch atomically.
     * The current history is read from the latest persisted row inside a single
     * transaction and the new entry is appended to it — never copied from a
     * possibly-stale in-memory node and overwritten. History is strictly
     * append-only: prior entries are always preserved.
     */
    appendInvalidationEntry(
      id: string,
      entry: InvalidationEntry,
      patch: Partial<{ status: RequirementNodeStatus; verifiedFileHashes: string[]; completedAt: string | null }>,
      now = new Date().toISOString(),
    ): MissionRequirementNode | undefined {
      return db.transaction(() => {
        const existing = db.prepare("SELECT invalidation_history_json FROM mission_requirement_nodes WHERE id = ?").get(id) as any;
        if (!existing) return undefined;
        const history: InvalidationEntry[] = JSON.parse(existing.invalidation_history_json ?? "[]");
        history.push(entry);
        const sets: string[] = ["updated_at = ?", "invalidation_history_json = ?"];
        const params: any[] = [now, JSON.stringify(history)];
        if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
        if (patch.verifiedFileHashes !== undefined) { sets.push("verified_file_hashes_json = ?"); params.push(JSON.stringify(patch.verifiedFileHashes)); }
        if (patch.completedAt !== undefined) { sets.push("completed_at = ?"); params.push(patch.completedAt); }
        params.push(id);
        db.prepare(`UPDATE mission_requirement_nodes SET ${sets.join(", ")} WHERE id = ?`).run(...params);
        const row = db.prepare("SELECT * FROM mission_requirement_nodes WHERE id = ?").get(id) as any;
        return row ? mapRequirementNode(row) : undefined;
      })();
    },

    getRequirementNode(id: string): MissionRequirementNode | undefined {
      const row = db.prepare("SELECT * FROM mission_requirement_nodes WHERE id = ?").get(id) as any;
      return row ? mapRequirementNode(row) : undefined;
    },

    listRequirementNodes(missionId: string): MissionRequirementNode[] {
      return db.prepare("SELECT * FROM mission_requirement_nodes WHERE mission_id = ? ORDER BY ordering ASC").all(missionId).map(mapRequirementNode);
    },

    // ── cursor (per mission) ─────────────────────────────────────────────
    upsertCursor(cursor: {
      missionId: string; activeNodeId: string | null; activeObjective?: string | null;
      allowedNextActions: string[]; blockedReason?: string | null; lastCompletedAction?: string | null;
      frozenNodeIds?: string[]; invalidatedNodeIds?: string[]; now?: string;
    }): MissionCursor {
      const now = cursor.now ?? new Date().toISOString();
      db.prepare(
        `INSERT INTO mission_cursors (mission_id, schema_version, active_node_id, active_objective, allowed_next_actions_json, blocked_reason, last_completed_action, frozen_node_ids_json, invalidated_node_ids_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mission_id) DO UPDATE SET active_node_id = excluded.active_node_id, active_objective = excluded.active_objective, allowed_next_actions_json = excluded.allowed_next_actions_json, blocked_reason = excluded.blocked_reason, last_completed_action = excluded.last_completed_action, frozen_node_ids_json = excluded.frozen_node_ids_json, invalidated_node_ids_json = excluded.invalidated_node_ids_json, updated_at = excluded.updated_at`,
      ).run(
        cursor.missionId, SCHEMA_VERSION, cursor.activeNodeId, cursor.activeObjective ?? null,
        JSON.stringify(cursor.allowedNextActions), cursor.blockedReason ?? null, cursor.lastCompletedAction ?? null,
        JSON.stringify(cursor.frozenNodeIds ?? []), JSON.stringify(cursor.invalidatedNodeIds ?? []), now,
      );
      const row = db.prepare("SELECT * FROM mission_cursors WHERE mission_id = ?").get(cursor.missionId) as any;
      return mapCursor(row);
    },

    /** Run a function inside a single SQLite transaction. */
    transaction(fn: () => void): void {
      db.transaction(fn)();
    },

    getCursor(missionId: string): MissionCursor | undefined {
      const row = db.prepare("SELECT * FROM mission_cursors WHERE mission_id = ?").get(missionId) as any;
      return row ? mapCursor(row) : undefined;
    },

    guardianDependencies(missionId: string) {
      // `guardian_review` is the Guardian's own completion bookkeeping, not
      // mission work it waits on. The controller marks it `running` before
      // calling finalize, and finalize re-assesses the Guardian — counting it
      // here would make the act of finalizing block finalization, and the
      // resulting failed row would poison every later evaluation.
      const operations = (db.prepare(`SELECT id,status,effect_evidence_ids_json
        FROM mission_operations WHERE mission_id=? AND kind<>'guardian_review'
        ORDER BY sequence`).all(missionId) as Array<{
          id: string; status: string; effect_evidence_ids_json: string;
        }>).map((row) => ({
        id: row.id,
        status: row.status as MissionOperationStatus,
        effectEvidenceIds: JSON.parse(row.effect_evidence_ids_json) as string[],
      }));
      // A worker the controller recovered from is superseded: production leaves
      // the old row `interrupted` and dispatches a replacement rather than
      // mutating it. Counting it as a live dependency would block authorization
      // forever for any mission that survived a single worker interruption. The
      // recovery transition is the durable record of that supersession, so an
      // interrupted worker with no such transition still blocks.
      const tasks = (db.prepare(`SELECT id,status FROM tasks
        WHERE mission_id=?
          AND id NOT IN (
            SELECT json_extract(details_json,'$.taskId')
            FROM mission_runtime_transitions
            WHERE mission_id=? AND cause='worker_recovery_required'
              AND json_extract(details_json,'$.taskId') IS NOT NULL
          )
        ORDER BY created_at,id`)
        .all(missionId, missionId) as Array<{ id: string; status: string }>)
        .map((row) => ({ id: row.id, status: row.status as TaskStatus }));
      const approvals = (db.prepare(`SELECT approval.id,approval.status
        FROM approvals approval
        JOIN tasks task ON task.id=approval.task_id
        WHERE task.mission_id=? ORDER BY approval.created_at,approval.id`).all(missionId) as Array<{
          id: string; status: string;
        }>).map((row) => ({ id: row.id, status: row.status as ApprovalStatus }));
      return { operations, tasks, approvals };
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
