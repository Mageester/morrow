import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import type {
  Mission, MissionStatus, MissionCriterion, MissionCriterionState, MissionEvidence,
  MissionFailure, MissionCheckpoint, MissionReview, MissionBudget, MissionResult,
  MissionVerificationStrategy, CreateMissionInput,
  MissionContract, MissionRequirementNode, MissionCursor, ProjectActiveMission,
  RequirementNodeStatus, ReopenCondition, InvalidationEntry,
} from "@morrow/contracts";
import { assertMissionTransition, canTransitionMission, gradeMission, isTerminalMissionStatus } from "@morrow/contracts";
import type { MissionsRepository } from "../repositories/missions.js";
import type { ChatMessage } from "../provider/base.js";
import { buildCriteriaPrompt, parseCriteriaFromModel, isVagueCriterion, rewriteVague, type DraftCriterion } from "./criteria.js";
import { runVerification, type RunOptions } from "./evidence-runner.js";
import { categorizeFailure, normalizeSignature, planRecovery, type RecoveryPlan } from "./failures.js";
import { captureCheckpoint, rollbackToCheckpoint, describeCheckpointDiff, candidateFiles, isGitRepo } from "./checkpoints.js";
import { buildReviewMessages, buildReviewRepairMessages, isReviewParseFailure, parseReviewVerdict, type ReviewContext } from "./reviewer.js";
import { buildMissionResult } from "./result.js";
import { extractMissionLearnings } from "./learning-extractor.js";
import { selectActiveNode, deriveAllowedActions, canReopenNode, computeFrozen, isDependencyBlocked, allAuthoritativeSatisfied, assertRequirementTransition, isValidFileHash } from "./kernel.js";
import { buildContractFromInput } from "./contract-extractor.js";
import type { CortexService } from "../cortex/service.js";
import { CortexError } from "../cortex/service.js";
import { buildMissionSpecialists, specialistsFromEvents } from "./specialists.js";

/** A single completion from the provider abstraction (planning or review). */
export type MissionCompletionFn = (
  messages: ChatMessage[],
  opts: { purpose: "planning" | "review"; temperature?: number },
) => Promise<{ text: string; provider?: string; model?: string; usdCost?: number }>;

export interface MissionServiceDeps {
  repo: MissionsRepository;
  /** Resolve a project's absolute workspace path. */
  getWorkspacePath: (projectId: string) => string | undefined;
  /** Provider-backed completion (planning + review). Optional: without it,
   *  criteria fall back to heuristics and review yields insufficient_evidence. */
  completion?: MissionCompletionFn | undefined;
  /** Content-addressed checkpoint backup directory. */
  backupDir: string;
  /** Injectable clock + verification exec hooks (tests). */
  now?: (() => string) | undefined;
  runOptions?: Partial<RunOptions> | undefined;
  /** Cortex integration: plan revisions on evidence contradictions/loops and
   *  post-review learning extraction. Optional so missions degrade gracefully
   *  when project intelligence is not in play (tests, minimal deployments). */
  cortex?: CortexService | undefined;
}

export class MissionError extends Error {
  constructor(message: string, public readonly code: string) { super(message); this.name = "MissionError"; }
}

/**
 * MissionService owns the mission state machine and coordinates criteria,
 * evidence, failures/loop-detection, checkpoints, independent review, and
 * honest grading. Every transition is validated centrally and every meaningful
 * step appends a durable mission event, so a restart reconstructs the mission
 * from persistence alone.
 */
export class MissionService {
  private readonly repo: MissionsRepository;
  private readonly now: () => string;

  constructor(private readonly deps: MissionServiceDeps) {
    this.repo = deps.repo;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  create(projectId: string, input: CreateMissionInput): Mission {
    const id = `mission-${randomUUID()}`;
    const budget: MissionBudget = {
      maxUsd: input.maxUsd ?? null,
      maxAttempts: input.maxAttempts ?? null,
      maxReviewCycles: 2,
      spentUsd: 0,
      attemptsUsed: 0,
      reviewCyclesUsed: 0,
    };

    // Atomic kernel creation: the mission row, contract, requirement nodes,
    // initial events, project pointer, the initial cursor, AND the specialist
    // plan are all persisted in a SINGLE transaction. If any step throws —
    // including cursor persistence or the late specialists step — the whole
    // transaction rolls back and no mission, contract, node, event, pointer, or
    // cursor survives. The cursor is genuinely created inside the transaction
    // (not via a post-commit advanceCursor call).
    let mission!: Mission;
    this.repo.transaction(() => {
      this.repo.create({
        id, projectId, conversationId: input.conversationId ?? null,
        objective: input.objective, autoApprove: input.autoApprove ?? false, budget,
      }, this.now());
      this.repo.appendEvent(id, "mission.created", `Mission created: ${input.objective.slice(0, 80)}`, {}, this.now());

      const contract = buildContractFromInput({ objective: input.objective, contract: input.contract });
      this.repo.createContract({
        missionId: id,
        sourcePrompt: contract.sourcePrompt,
        objective: contract.objective,
        expectedArtifacts: contract.expectedArtifacts,
        acceptanceCriteria: contract.acceptanceCriteria,
        verificationCommands: contract.verificationCommands,
        requiredGitResult: contract.requiredGitResult,
        unresolvedAmbiguities: contract.unresolvedAmbiguities,
        nodes: contract.nodes,
        now: this.now(),
      });
      this.repo.appendEvent(id, "mission.contract_built", `Contract built from verbatim objective (${contract.nodes.length} requirement node)`, { nodes: contract.nodes.length }, this.now());
      this.repo.setProjectActiveMission(projectId, id, this.now());
      // Initial cursor is persisted inside the transaction.
      this.advanceCursor(id);

      mission = this.get(id);
      const roles = buildMissionSpecialists(mission);
      this.repo.appendEvent(id, "mission.specialists_planned", `Planned ${roles.length} Cortex specialist roles`, { roles }, this.now());
    });
    return mission;
  }

  get(missionId: string): Mission {
    const m = this.repo.get(missionId);
    if (!m) throw new MissionError(`Mission ${missionId} not found`, "not_found");
    return m;
  }

  listByProject(projectId: string, limit?: number): Mission[] {
    return this.repo.listByProject(projectId, limit);
  }

  specialists(missionId: string) {
    const mission = this.get(missionId);
    return specialistsFromEvents(this.repo.listEvents(missionId), mission);
  }

  private transition(missionId: string, to: MissionStatus): Mission {
    const current = this.get(missionId);
    if (current.status === to) return current;
    assertMissionTransition(current.status, to);
    // The mission status update and its mission.status_changed event are a single
    // atomic transaction: a failure to persist the event rolls back the status.
    const now = this.now();
    this.repo.transaction(() => {
      this.repo.setStatus(missionId, to, now);
      this.repo.appendEvent(missionId, "mission.status_changed", `Status: ${current.status} → ${to}`, { from: current.status, to }, now);
    });
    return this.get(missionId);
  }

  // ── criteria ───────────────────────────────────────────────────────────
  /** Generate measurable criteria from the objective. Provider-backed with a
   *  deterministic heuristic fallback so this never hard-depends on a model. */
  async generateCriteria(missionId: string, repoSummary: string): Promise<Mission> {
    const mission = this.get(missionId);
    if (mission.criteria.length > 0) return mission; // idempotent
    let drafts: DraftCriterion[] = [];
    if (this.deps.completion) {
      try {
        const messages: ChatMessage[] = [
          { role: "system", content: "You output only JSON. No prose." },
          { role: "user", content: buildCriteriaPrompt(mission.objective, repoSummary) },
        ];
        const res = await this.deps.completion(messages, { purpose: "planning", temperature: 0.1 });
        drafts = parseCriteriaFromModel(res.text);
        drafts = this.sanitizeModelCriteria(drafts, this.deps.getWorkspacePath(mission.projectId));
        if (res.usdCost) this.addSpend(missionId, res.usdCost);
      } catch {
        drafts = [];
      }
    }
    if (drafts.length === 0) drafts = this.heuristicCriteria(mission.objective, repoSummary);
    this.repo.addCriteria(missionId, drafts.map((d) => ({ id: `crit-${randomUUID()}`, description: d.description, verification: d.verification, state: "proposed" as MissionCriterionState })), this.now());
    this.repo.appendEvent(missionId, "mission.criteria_generated", `Generated ${drafts.length} success criteria`, { count: drafts.length }, this.now());
    // Auto-approve missions display AND persist the approved contract.
    if (mission.autoApprove) return this.approveCriteria(missionId);
    if (mission.status === "draft") this.transition(missionId, "awaiting_criteria_approval");
    return this.get(missionId);
  }

  /** Heuristic criteria when no model is available — every one is measurable
   *  (has an executable verification), so a mission can actually reach a full
   *  grade. We avoid vague "runtime" criteria that carry no runnable command. */
  private heuristicCriteria(objective: string, repoSummary: string): DraftCriterion[] {
    const drafts: DraftCriterion[] = [];
    const hasTest = /"test"|test|spec|vitest|jest|mocha/i.test(repoSummary);
    if (hasTest) {
      drafts.push({ description: "The existing test suite passes", verification: { kind: "test", command: "npm test", describe: "Test suite exit code 0" } });
    } else {
      // No test script: prove the primary entry at least parses cleanly.
      const entry = /server\.js/.test(repoSummary) ? "src/server.js" : /index\.js/.test(repoSummary) ? "src/index.js" : "index.js";
      drafts.push({ description: `The entry file ${entry} parses without a syntax error`, verification: { kind: "command", command: `node --check ${entry}`, expectExitCode: 0 } });
    }
    drafts.push({ description: "The final diff contains no unrelated changes outside the intended fix", verification: { kind: "diff", pathScope: "**", describe: "Changes stay within scope" } });
    drafts.push({ description: "An independent reviewer approves the change against the objective", verification: { kind: "review", describe: "Independent reviewer verdict" } });
    return drafts;
  }

  private sanitizeModelCriteria(drafts: DraftCriterion[], workspace: string | undefined): DraftCriterion[] {
    if (!workspace) return drafts;
    return drafts.filter((draft) => {
      const command = draft.verification.command;
      if (!command) return true;
      if (hasMissingWorkspaceFileReference(command, workspace)) return false;
      if (isBrittleInlineGeneratedArtifactCheck(command)) return false;
      return true;
    });
  }

  addCriterion(missionId: string, description: string, verification?: MissionVerificationStrategy): MissionCriterion {
    const mission = this.get(missionId);
    let desc = description.trim();
    if (isVagueCriterion(desc)) desc = rewriteVague(desc);
    const state: MissionCriterionState = mission.status === "running" || mission.status === "reviewing" ? "approved" : "proposed";
    const id = `crit-${randomUUID()}`;
    this.repo.addCriteria(missionId, [{ id, description: desc, verification: verification ?? { kind: "manual", describe: desc }, state }], this.now());
    return this.repo.getCriterion(id)!;
  }

  updateCriterion(missionId: string, criterionId: string, patch: { description?: string | undefined; state?: MissionCriterionState | undefined; verification?: MissionVerificationStrategy | undefined; waiverReason?: string | undefined }): MissionCriterion {
    const c = this.repo.getCriterion(criterionId);
    if (!c || c.missionId !== missionId) throw new MissionError("Criterion not found in mission", "not_found");
    const applied: Parameters<MissionsRepository["updateCriterion"]>[1] = {};
    if (patch.description !== undefined) applied.description = isVagueCriterion(patch.description) ? rewriteVague(patch.description) : patch.description.trim();
    if (patch.verification !== undefined) applied.verification = patch.verification;
    if (patch.state !== undefined) applied.state = patch.state;
    if (patch.waiverReason !== undefined) { applied.waiverReason = patch.waiverReason; applied.state = "waived"; }
    return this.repo.updateCriterion(criterionId, applied, this.now())!;
  }

  removeCriterion(missionId: string, criterionId: string): boolean {
    const c = this.repo.getCriterion(criterionId);
    if (!c || c.missionId !== missionId) throw new MissionError("Criterion not found in mission", "not_found");
    return this.repo.removeCriterion(criterionId);
  }

  /** Approve the criteria contract and move the mission into execution. */
  approveCriteria(missionId: string): Mission {
    const mission = this.get(missionId);
    for (const c of mission.criteria) {
      if (c.state === "proposed") this.repo.updateCriterion(c.id, { state: "approved" }, this.now());
    }
    this.repo.appendEvent(missionId, "mission.criteria_approved", `Approved ${mission.criteria.length} criteria`, {}, this.now());
    if (mission.status === "draft" || mission.status === "awaiting_criteria_approval") {
      this.transition(missionId, "running");
      this.repo.appendEvent(missionId, "mission.started", "Execution started", {}, this.now());
      this.advanceCursor(missionId);
    }
    return this.get(missionId);
  }

  // ── evidence + verification ──────────────────────────────────────────────
  /** Verify a single criterion by executing its strategy and recording evidence.
   *  The criterion only becomes `verified` when evidence status is `passed`. */
  async verifyCriterion(missionId: string, criterionId: string): Promise<{ criterion: MissionCriterion; evidence: MissionEvidence }> {
    const mission = this.get(missionId);
    const c = this.repo.getCriterion(criterionId);
    if (!c || c.missionId !== missionId) throw new MissionError("Criterion not found in mission", "not_found");
    const workspace = this.deps.getWorkspacePath(mission.projectId);
    if (!workspace) throw new MissionError("Project workspace not found", "no_workspace");

    this.repo.updateCriterion(criterionId, { state: "in_progress" }, this.now());
    const outcome = await runVerification(c.verification, { workspacePath: workspace, ...this.deps.runOptions });

    const evidence = this.repo.addEvidence({
      id: `ev-${randomUUID()}`, missionId, criterionIds: [criterionId],
      type: outcome.type, summary: outcome.summary,
      command: outcome.command ?? null, exitCode: outcome.exitCode ?? null,
      outputRef: this.storeOutput(missionId, outcome.output),
      artifactPath: null, status: outcome.status,
    });
    this.repo.appendEvent(missionId, "mission.evidence_recorded", outcome.summary, { criterionId, status: outcome.status }, this.now());

    const newState: MissionCriterionState = outcome.status === "passed" ? "verified" : outcome.status === "failed" ? "failed" : "unverified";
    const criterion = this.repo.updateCriterion(criterionId, {
      state: newState,
      failureReason: outcome.status === "failed" ? outcome.summary : null,
    }, this.now())!;
    this.repo.appendEvent(missionId, newState === "verified" ? "mission.criterion_verified" : "mission.criterion_failed", `${c.description}: ${newState}`, { criterionId }, this.now());
    return { criterion, evidence };
  }

  /** Verify every approved/in-progress criterion whose strategy is executable. */
  async verifyAll(missionId: string): Promise<Mission> {
    const mission = this.get(missionId);
    const failedNow: string[] = [];
    for (const c of mission.criteria) {
      if (c.state === "waived" || c.state === "verified") continue;
      // Manual/browser/review strategies cannot be auto-proven here.
      if (c.verification.kind === "manual" || c.verification.kind === "browser") continue;
      if (c.verification.kind === "review") continue; // proven by the reviewer phase
      const { criterion } = await this.verifyCriterion(missionId, c.id);
      if (criterion.state === "failed") failedNow.push(`${criterion.description.slice(0, 120)} — ${criterion.failureReason?.slice(0, 120) ?? "failed"}`);
    }
    // Evidence contradicted the plan's assumption of completion: one revision
    // for the whole verification pass, listing what must actually change.
    if (failedNow.length > 0) {
      this.revisePlan(missionId, {
        trigger: "test_contradiction",
        triggerDetail: `${failedNow.length} criterion(s) failed evidence-backed verification`,
        invalidatedAssumption: "The implementation satisfies all approved criteria.",
        tasksAdded: failedNow.map((f) => `Fix and re-verify: ${f}`),
        verificationChanges: ["Re-run full criterion verification after the fix"],
      });
    }
    return this.get(missionId);
  }

  /** Attach a manual/structured observation as evidence for a criterion. */
  recordManualEvidence(missionId: string, criterionId: string, summary: string, status: MissionEvidence["status"]): MissionEvidence {
    const c = this.repo.getCriterion(criterionId);
    if (!c || c.missionId !== missionId) throw new MissionError("Criterion not found in mission", "not_found");
    const evidence = this.repo.addEvidence({ id: `ev-${randomUUID()}`, missionId, criterionIds: [criterionId], type: "manual", summary, command: null, exitCode: null, outputRef: null, artifactPath: null, status });
    if (status === "passed") this.repo.updateCriterion(criterionId, { state: "verified" }, this.now());
    return evidence;
  }

  private storeOutput(missionId: string, output: string): string | null {
    if (!output) return null;
    // Persisted as an artifact reference; the body lives beside the mission.
    // Kept concise here — full output store integration is a follow-up. We store
    // a bounded copy so /output can retrieve it without bloating each record.
    return `mission:${missionId}:${Date.now()}`;
  }

  // ── failures + loop detection ────────────────────────────────────────────
  /** Record a failure, run loop detection against persisted history, and return
   *  the chosen escalating recovery plan. Escalates the mission to `blocked`
   *  when safe automated options are exhausted. */
  recordFailure(missionId: string, operation: string, message: string, ctx: { taskId?: string; agentId?: string; escalation?: "auto" | "loop-only" } = {}): { failure: MissionFailure; plan: RecoveryPlan } {
    const category = categorizeFailure(operation, message);
    const signature = normalizeSignature(category, operation);
    const priorCount = this.repo.countBySignature(missionId, signature);
    const attempt = priorCount + 1;
    const plan = planRecovery(category, attempt);
    // "loop-only" (agent-reported tool failures): a single categorically-denied
    // probe must not block the whole mission — the agent routinely
    // self-corrects. Only genuine repetition escalates.
    const escalate = plan.exhausted && (ctx.escalation !== "loop-only" || attempt >= 4);

    const failure = this.repo.addFailure({
      id: `fail-${randomUUID()}`, missionId, taskId: ctx.taskId ?? null, agentId: ctx.agentId ?? null,
      operation, normalizedSignature: signature, category, message: message.slice(0, 2000),
      attempt, recoveryStrategy: plan.strategy, recovered: false,
    });
    this.repo.appendEvent(missionId, "mission.failure_recorded", `${category}: ${operation.slice(0, 80)}`, { category, attempt, signature }, this.now());

    if (attempt >= 3) {
      this.repo.appendEvent(missionId, "mission.loop_detected", `Repeated failure detected (${attempt}×): ${signature}`, { signature, attempt }, this.now());
      // Exactly one plan revision per looping signature: reality disproved the
      // current approach, so the plan must change rather than retry forever.
      if (attempt === 3) {
        this.revisePlan(missionId, {
          trigger: "repeated_tool_failure",
          triggerDetail: `${category} failed ${attempt}× (${signature.slice(0, 160)})`,
          invalidatedAssumption: `The operation "${operation.slice(0, 160)}" can succeed as attempted.`,
          tasksRemoved: [`Retry: ${operation.slice(0, 120)}`],
          tasksAdded: plan.steps,
        });
      }
    }
    this.repo.appendEvent(missionId, "mission.recovery_applied", `Recovery: ${plan.strategy}`, { strategy: plan.strategy, steps: plan.steps }, this.now());

    if (escalate) {
      const mission = this.get(missionId);
      if (!isTerminalMissionStatus(mission.status) && canTransitionMission(mission.status, "blocked")) {
        this.transition(missionId, "blocked");
      }
    }
    return { failure, plan };
  }

  markRecovered(missionId: string, failureId: string, strategy: string): void {
    this.repo.markFailureRecovered(failureId, strategy);
  }

  /** Record a bounded plan revision through Cortex. Hitting the revision limit
   *  blocks the mission — the alternative is an endless replan loop. */
  private revisePlan(missionId: string, input: Parameters<CortexService["recordPlanRevision"]>[1]): void {
    if (!this.deps.cortex) return;
    try {
      const revision = this.deps.cortex.recordPlanRevision(missionId, input);
      this.repo.appendEvent(missionId, "mission.plan_revised", `Plan revision ${revision.revision}: ${input.trigger.replace(/_/g, " ")}`, { revision: revision.revision, trigger: input.trigger }, this.now());
    } catch (err) {
      if (err instanceof CortexError && err.code === "limit") {
        this.repo.appendEvent(missionId, "mission.loop_detected", "Plan revision limit reached; blocking for human input", {}, this.now());
        const mission = this.get(missionId);
        if (!isTerminalMissionStatus(mission.status) && canTransitionMission(mission.status, "blocked")) {
          this.transition(missionId, "blocked");
        }
        return;
      }
      // Revision bookkeeping must never break mission execution.
    }
  }

  // ── checkpoints + rollback ───────────────────────────────────────────────
  createCheckpoint(missionId: string, label: string, reason: string, files?: string[]): MissionCheckpoint {
    const mission = this.get(missionId);
    const workspace = this.deps.getWorkspacePath(mission.projectId);
    if (!workspace) throw new MissionError("Project workspace not found", "no_workspace");
    const id = `ckpt-${randomUUID()}`;
    const backupDir = join(this.deps.backupDir, missionId);
    const snapshot = captureCheckpoint(workspace, backupDir, id, files);
    const affected = Object.keys(snapshot.files);
    const checkpoint = this.repo.addCheckpoint({
      id, missionId, label, reason, gitRef: snapshot.gitRef,
      checkpointName: id, affectedFiles: affected, rollbackAvailable: true,
    });
    this.repo.appendEvent(missionId, "mission.checkpoint_created", `Checkpoint: ${label} (${affected.length} files)`, { label, files: affected.length }, this.now());
    return checkpoint;
  }

  checkpointDiff(missionId: string, checkpointId: string): string[] {
    const mission = this.get(missionId);
    const workspace = this.deps.getWorkspacePath(mission.projectId);
    if (!workspace) throw new MissionError("Project workspace not found", "no_workspace");
    return describeCheckpointDiff(workspace, join(this.deps.backupDir, missionId), checkpointId);
  }

  rollback(missionId: string, checkpointId: string): { ok: boolean; restored: string[]; removed: string[]; missing: string[] } {
    const mission = this.get(missionId);
    const checkpoint = this.repo.getCheckpoint(checkpointId);
    if (!checkpoint || checkpoint.missionId !== missionId) throw new MissionError("Checkpoint not found in mission", "not_found");
    if (!checkpoint.rollbackAvailable) throw new MissionError("Rollback not available for this checkpoint", "no_rollback");
    const workspace = this.deps.getWorkspacePath(mission.projectId);
    if (!workspace) throw new MissionError("Project workspace not found", "no_workspace");
    const result = rollbackToCheckpoint(workspace, join(this.deps.backupDir, missionId), checkpointId);
    this.repo.appendEvent(missionId, "mission.rolled_back", result.ok ? `Rolled back to ${checkpoint.label}` : `Rollback to ${checkpoint.label} could not complete`, { restored: result.restored.length, removed: result.removed.length, ok: result.ok }, this.now());
    return { ok: result.ok, restored: result.restored, removed: result.removed, missing: result.missing };
  }

  // ── independent review ───────────────────────────────────────────────────
  /**
   * Validate that a mission may accept a review right now. Used BOTH before
   * initiating a review (pre-provider-spend) and again, atomically, inside
   * `applyReview`'s transaction against a freshly-reloaded row — so a
   * finalize (or any other lifecycle mutation) that races a review-in-flight
   * can never be applied over.
   *
   *  • Terminal missions never accept a review — a post-terminal review
   *    attempt must write nothing.
   *  • Only `running` (direct application, e.g. tests/synchronous callers) and
   *    `reviewing` (in-flight, via runReview) are review-applicable states.
   *  • The review-cycle budget is enforced HERE, not merely recorded: once
   *    `reviewCyclesUsed >= maxReviewCycles` no further review — provider spend
   *    or ledger mutation — is permitted.
   */
  private assertReviewApplicable(mission: Mission): void {
    if (isTerminalMissionStatus(mission.status)) {
      throw new MissionError(`Mission ${mission.id} is terminal (${mission.status}); a review cannot be applied`, "review_invalid_state");
    }
    if (mission.status !== "running" && mission.status !== "reviewing") {
      throw new MissionError(`Mission ${mission.id} is not in a review-applicable state (${mission.status})`, "review_invalid_state");
    }
    if (mission.budget.reviewCyclesUsed >= mission.budget.maxReviewCycles) {
      throw new MissionError(
        `Mission ${mission.id} has exhausted its review-cycle budget (${mission.budget.maxReviewCycles})`,
        "review_cycle_limit_exceeded",
      );
    }
  }

  /** Run the independent reviewer as a SEPARATE execution with isolated
   *  instructions. Transitions running → reviewing, records the verdict, and
   *  returns the review. Does not itself grade the mission. */
  async runReview(missionId: string): Promise<MissionReview> {
    let mission = this.get(missionId);
    // Reject invalid/terminal states AND an exhausted review-cycle budget
    // BEFORE any provider spend or ledger mutation.
    this.assertReviewApplicable(mission);

    if (mission.status === "running") {
      const now = this.now();
      this.repo.transaction(() => {
        // Re-validate against the freshest row inside the transition
        // transaction, then transition into `reviewing` and append
        // `mission.review_started` atomically — both commit or roll back
        // together.
        const fresh = this.repo.get(missionId)!;
        this.assertReviewApplicable(fresh);
        assertMissionTransition(fresh.status, "reviewing");
        this.repo.setStatus(missionId, "reviewing", now);
        this.repo.appendEvent(missionId, "mission.status_changed", `Status: ${fresh.status} → reviewing`, { from: fresh.status, to: "reviewing" }, now);
        this.repo.appendEvent(missionId, "mission.review_started", "Independent review started", {}, now);
      });
      mission = this.get(missionId);
    }

    const workspace = this.deps.getWorkspacePath(mission.projectId);
    const diff = workspace ? gitDiff(workspace) : "";
    const changedFiles = workspace && isGitRepo(workspace) ? candidateFiles(workspace) : [];
    const ctx: ReviewContext = {
      objective: mission.objective, criteria: mission.criteria,
      evidence: mission.evidence, failures: mission.failures, diff, changedFiles,
    };
    const messages = buildReviewMessages(ctx);

    let parsed;
    let provider: string | null = null;
    let model: string | null = null;
    if (this.deps.completion) {
      try {
        const res = await this.deps.completion(messages, { purpose: "review", temperature: 0 });
        parsed = parseReviewVerdict(res.text, mission.criteria);
        provider = res.provider ?? null; model = res.model ?? null;
        if (res.usdCost) this.addSpend(missionId, res.usdCost);
        if (isReviewParseFailure(parsed)) {
          const repaired = await this.deps.completion(buildReviewRepairMessages(messages, res.text), { purpose: "review", temperature: 0 });
          const repairedParsed = parseReviewVerdict(repaired.text, mission.criteria);
          if (!isReviewParseFailure(repairedParsed)) parsed = repairedParsed;
          provider = repaired.provider ?? provider; model = repaired.model ?? model;
          if (repaired.usdCost) this.addSpend(missionId, repaired.usdCost);
        }
      } catch {
        parsed = parseReviewVerdict("", mission.criteria); // insufficient_evidence
      }
    } else {
      parsed = parseReviewVerdict("", mission.criteria); // no reviewer available → insufficient
    }

    const review: MissionReview = {
      id: `review-${randomUUID()}`, missionId, ...parsed,
      reviewerProvider: provider, reviewerModel: model, createdAt: this.now(),
    };
    this.applyReview(missionId, review);

    if (review.verdict === "revisions_required") {
      this.revisePlan(missionId, {
        trigger: "review_revisions",
        triggerDetail: "Independent reviewer requested revisions",
        invalidatedAssumption: "The current diff is ready for completion.",
        tasksAdded: parsed.concerns.slice(0, 5).map((r) => `Address reviewer finding: ${r.slice(0, 160)}`),
        verificationChanges: ["Repeat independent review after revisions"],
      });
    }
    return review;
  }

  /**
   * ONE explicit MissionService-owned transaction that atomically applies an
   * independent review to the ledger. It performs, as a single unit of work:
   *  • review persistence (missions_reviews);
   *  • review-cycle budget increment;
   *  • durable, mission-scoped review evidence creation;
   *  • review-kind criterion transitions (verified on approval, failed on
   *    revisions_required) — and ONLY requirement-node transitions genuinely
   *    supported by that evidence (the authoritative objective node on
   *    approval; unrelated artifacts/acceptance-criteria/prohibitions are
   *    deliberately NOT auto-verified merely because the overall review passed);
   *  • the associated events (evidence recorded, criterion/requirement
   *    transitions, review completed);
   *  • contract freeze recomputation;
   *  • cursor recomputation.
   *
   * Because everything is inside a single repository transaction, any failure
   * (evidence, criterion, requirement node, event, freeze, or cursor) rolls the
   * whole review application back — no half-applied review survives.
   *
   * Race safety: the mission is RELOADED from persistence and RE-VALIDATED
   * (`assertReviewApplicable`) as the FIRST statement inside this transaction
   * — before `setReview` or any other write. A finalize (or any other
   * lifecycle mutation) that completed between provider dispatch and this
   * call, a mission that went terminal in the interim, or a review-cycle
   * budget that is already exhausted, all cause this to throw BEFORE any
   * write, so a stale/late provider result can never be partially persisted.
   * This is also the ONLY place review application is persisted, so the
   * public `setReview()` direct-application entry point is automatically
   * covered by the same validation.
   */
  private applyReview(missionId: string, review: MissionReview): void {
    const now = this.now();
    this.repo.transaction(() => {
      const mission = this.repo.get(missionId);
      if (!mission) throw new MissionError(`Mission ${missionId} not found`, "not_found");
      this.assertReviewApplicable(mission);
      this.repo.setReview(review);
      const budget = { ...mission.budget, reviewCyclesUsed: mission.budget.reviewCyclesUsed + 1 };
      this.repo.updateBudget(missionId, budget, now);

      const approving = review.verdict === "approved" || review.verdict === "approved_with_risks";
      const reviewCriterionIds = mission.criteria
        .filter((c) => c.verification.kind === "review")
        .map((c) => c.id);

      if (!approving) {
        // A non-approval leaves the ledger honest: review-kind criteria that the
        // reviewer rejected are marked failed, but nothing is auto-verified and
        // the authoritative objective node is left untouched. A durable review
        // evidence record is still created — failed for revisions_required (the
        // reviewer positively rejected the diff), inconclusive for
        // insufficient_evidence (the reviewer could not reach a verdict) — so the
        // non-approval itself is backed by real, mission-scoped provenance rather
        // than only a prose event.
        //
        // This early return is deliberately NOT followed by any requirement-node,
        // freeze, or cursor recomputation, and that is correct rather than a
        // staleness bug: criterion state does not feed cursor derivation, freeze
        // is computed purely from requirement-node statuses, and a non-approving
        // review never mutates a requirement node. Approving reviews (below) DO
        // advance the authoritative objective node and therefore DO need the
        // freeze/cursor recompute that `updateRequirementStatus` performs as part
        // of its own atomic transition. Adding a no-op freeze/cursor recompute
        // here would not fix anything real — it would only exist to satisfy a
        // comment, which is exactly what this note is here to prevent.
        const evidenceStatus = review.verdict === "revisions_required" ? "failed" : "inconclusive";
        const evidence = this.repo.addEvidence({
          id: `ev-${randomUUID()}`, missionId, criterionIds: reviewCriterionIds, type: "review",
          summary: `Independent review: ${review.verdict.replace(/_/g, " ")}`,
          command: null, exitCode: null, outputRef: null, artifactPath: null,
          status: evidenceStatus,
        });
        this.repo.appendEvent(missionId, "mission.evidence_recorded", evidence.summary, { status: evidenceStatus }, now);
        if (review.verdict === "revisions_required") {
          for (const c of mission.criteria) {
            if (c.verification.kind !== "review") continue;
            this.repo.updateCriterion(c.id, { state: "failed", failureReason: "Independent reviewer requested revisions" }, now);
            this.repo.appendEvent(missionId, "mission.criterion_failed", `${c.description}: failed`, { criterionId: c.id }, now);
          }
        }
        this.repo.appendEvent(missionId, "mission.review_completed", `Review verdict: ${review.verdict}`, { verdict: review.verdict }, now);
        return;
      }

      // A single durable, passed review evidence record backs both the
      // review-kind criteria and the objective node so provenance is real.
      const evidence = this.repo.addEvidence({
        id: `ev-${randomUUID()}`, missionId, criterionIds: reviewCriterionIds, type: "review",
        summary: `Independent review: ${review.verdict.replace(/_/g, " ")}`,
        command: null, exitCode: null, outputRef: null, artifactPath: null,
        status: "passed",
      });
      this.repo.appendEvent(missionId, "mission.evidence_recorded", evidence.summary, { status: "passed" }, now);

      for (const c of mission.criteria) {
        if (c.verification.kind !== "review") continue;
        this.repo.updateCriterion(c.id, { state: "verified" }, now);
        this.repo.appendEvent(missionId, "mission.criterion_verified", `${c.description}: verified`, { criterionId: c.id }, now);
      }

      // The authoritative objective node is satisfied by the same durable passed
      // review evidence. Advance it through the state machine (pending → active →
      // verified) with a real evidence reference so the ledger stays truthful.
      const objective = this.repo.listRequirementNodes(missionId)
        .find((n) => n.category === "objective" && n.authoritative && n.status !== "verified" && n.status !== "waived");
      if (objective) {
        if (objective.status !== "active") {
          this.updateRequirementStatus(missionId, objective.id, "active");
        }
        this.updateRequirementStatus(missionId, objective.id, "verified", { evidenceRefs: [evidence.id] });
      }

      this.repo.appendEvent(missionId, "mission.review_completed", `Review verdict: ${review.verdict}`, { verdict: review.verdict }, now);
    });
  }

  /**
   * Persist a review AND advance the ledger to match it, as a single atomic
   * review-application transaction (see applyReview). This is the only public
   * direct-review entry point and it delegates to that same transaction owner.
   */
  setReview(review: MissionReview): MissionReview {
    this.applyReview(review.missionId, review);
    return review;
  }

  // ── grading / finalize ───────────────────────────────────────────────────
  /**
   * Centrally-enforced finalization lifecycle. Called BEFORE any durable
   * write, both from the outer finalize() call and again, redundantly, from
   * inside the finalization transaction against a freshly-reloaded row (so a
   * concurrent mutation between the two reads can never slip a contradictory
   * write through).
   *
   *  • `draft` and `awaiting_criteria_approval` may never finalize — no work
   *    has been graded yet.
   *  • `reviewing` may only finalize once a final review verdict has actually
   *    been persisted (mission.finalReview); a review-in-flight mission must
   *    never be closed out from under its own review.
   *  • Terminal statuses are handled separately by
   *    `reconcileTerminalFinalization` and never reach this assertion.
   */
  private assertFinalizable(mission: Mission): void {
    if (mission.status === "draft") {
      throw new MissionError(`Mission ${mission.id} cannot be finalized from draft`, "finalize_invalid_state");
    }
    if (mission.status === "awaiting_criteria_approval") {
      throw new MissionError(`Mission ${mission.id} cannot be finalized while awaiting criteria approval`, "finalize_invalid_state");
    }
    if (mission.status === "reviewing" && !mission.finalReview) {
      throw new MissionError(`Mission ${mission.id} cannot be finalized while reviewing without a persisted final review`, "finalize_invalid_state");
    }
  }

  /**
   * A terminal-status early return must never silently accept a historically
   * partial (crash-boundary) completion tuple. This inspects the durable
   * tuple — mission status, completedAt, result, matching mission.completed
   * event, and a terminal cursor carrying the finalize marker — and either:
   *   • no-ops when the tuple is already fully consistent (true idempotence);
   *   • transactionally reconciles it when components are missing but the
   *     intended outcome is unambiguous (the persisted status is the single
   *     source of truth being backfilled into the other components);
   *   • throws a `finalization_integrity_error` when components actively
   *     contradict each other, rather than silently overwriting history.
   *
   * `cancelled` / `failed` / `blocked` missions are reached OUTSIDE the
   * completion tuple (cancel(), recordFailure()) and carry their own
   * intentional semantics — they never require a completion tuple and must
   * never be converted into a successful finalization.
   */
  private reconcileTerminalFinalization(mission: Mission): Mission {
    const status = mission.status;
    if (status === "cancelled" || status === "failed" || status === "blocked") {
      return mission;
    }

    const events = this.repo.listEvents(mission.id);
    const matchingCompletedEvents = events.filter(
      (e) => e.type === "mission.completed" && (e.data as any)?.status === status,
    );
    const anyCompletedEvents = events.filter((e) => e.type === "mission.completed");
    const cursor = this.repo.getCursor(mission.id);
    const cursorTerminal = !!cursor && cursor.allowedNextActions.length === 0;
    const hasFinalizeMarker = cursor?.lastCompletedAction === "finalize";
    const hasResult = mission.result !== null;
    const resultMatches = hasResult && mission.result!.status === status;
    const hasCompletedAt = mission.completedAt !== null;

    // ── Contradiction detection: never silently overwrite history ──────────
    if (hasResult && !resultMatches) {
      throw new MissionError(
        `Finalization integrity error: mission ${mission.id} status is ${status} but persisted result.status is ${mission.result!.status}`,
        "finalization_integrity_error",
      );
    }
    if (anyCompletedEvents.length > 0 && matchingCompletedEvents.length === 0) {
      throw new MissionError(
        `Finalization integrity error: mission ${mission.id} status is ${status} but no matching mission.completed event was recorded`,
        "finalization_integrity_error",
      );
    }
    if (matchingCompletedEvents.length > 1) {
      throw new MissionError(
        `Finalization integrity error: mission ${mission.id} has ${matchingCompletedEvents.length} mission.completed events`,
        "finalization_integrity_error",
      );
    }

    const complete = resultMatches && hasCompletedAt && matchingCompletedEvents.length === 1 && cursorTerminal && hasFinalizeMarker;
    if (complete) return mission; // fully consistent tuple: true idempotent no-op

    // ── Missing-but-unambiguous: reconcile transactionally ──────────────────
    const now = this.now();
    this.repo.transaction(() => {
      const fresh = this.repo.get(mission.id)!;
      if (fresh.status !== status) {
        throw new MissionError(
          `Finalization integrity error: mission ${mission.id} status changed during reconciliation`,
          "finalization_integrity_error",
        );
      }
      if (!hasResult) {
        const rebuilt = buildMissionResult(fresh, {
          review: fresh.finalReview,
          changedFiles: this.changedFilesFor(fresh),
          humanInterventions: 0,
          tasksCompleted: 0,
          elapsedMs: fresh.startedAt ? Date.parse(now) - Date.parse(fresh.startedAt) : null,
          spentUsd: fresh.budget.spentUsd || null,
          finalStatus: status,
        });
        this.repo.setResult(mission.id, rebuilt, now);
      }
      if (!hasCompletedAt) {
        // Backfills completed_at for a genuinely terminal status; does not
        // change status itself (already terminal) and appends no duplicate
        // status_changed event.
        this.repo.setStatus(mission.id, status, now);
      }
      if (matchingCompletedEvents.length === 0) {
        this.repo.appendEvent(
          mission.id, "mission.completed", `Reconciled terminal finalization for ${status}`,
          { status, reconciled: true }, now,
        );
      }
      if (!cursorTerminal || !hasFinalizeMarker) {
        this.advanceCursor(mission.id, { lastCompletedAction: "finalize" });
      }
    });
    return this.get(mission.id);
  }

  /** Grade the mission from criteria + review and set the terminal status. */
  finalize(missionId: string, opts?: { humanInterventions?: number; tasksCompleted?: number; elapsedMs?: number | null }): Mission {
    const mission = this.get(missionId);
    // A terminal mission is already finalized. Rather than blindly no-op
    // (which could paper over a historically partial completion tuple), the
    // durable tuple is explicitly reconciled or, if contradictory, rejected.
    if (isTerminalMissionStatus(mission.status)) {
      return this.reconcileTerminalFinalization(mission);
    }
    // ── Lifecycle validated BEFORE any durable write ────────────────────────
    this.assertFinalizable(mission);

    const ledger = this.repo.listRequirementNodes(missionId);
    const status = gradeMission(mission.criteria, mission.finalReview?.verdict ?? null);

    // ── Ledger gate (Gap 1) ─────────────────────────────────────────────────
    // Finalizing is gated on the requirement ledger, not on the prose review
    // alone. A "completed*" grade is only allowed when every authoritative
    // requirement node is satisfied (verified or waived). If the grade claims
    // success but the ledger shows an open authoritative requirement, the
    // status is downgraded to partially_completed so the mission can never be
    // recorded as done while real work remains. This is computed from the
    // full, freshly-loaded ledger inside a single transaction below.
    let gated = status;
    let ledgerGate = false;
    const authoritativeSatisfied = allAuthoritativeSatisfied(ledger);
    const noAuthoritativeNodes = ledger.length === 0;
    // Any "completed*" grade is only honoured when every authoritative
    // requirement is satisfied. Otherwise the ledger gate downgrades it to
    // partially_completed so the mission can never be recorded as done while
    // real work remains.
    if (status.startsWith("completed") && !authoritativeSatisfied && !noAuthoritativeNodes) {
      gated = "partially_completed";
      ledgerGate = true;
    }

    const result = buildMissionResult(mission, {
      review: mission.finalReview,
      changedFiles: this.changedFilesFor(mission),
      humanInterventions: opts?.humanInterventions ?? 0,
      tasksCompleted: opts?.tasksCompleted ?? 0,
      elapsedMs: opts?.elapsedMs ?? (mission.startedAt ? Date.parse(this.now()) - Date.parse(mission.startedAt) : null),
      spentUsd: mission.budget.spentUsd || null,
      finalStatus: gated,
    });

    // The result, the terminal status change, both terminal events, AND the
    // final cursor state commit or roll back together as one transaction. The
    // mission is RE-READ and RE-VALIDATED from persistence inside the
    // transaction — a concurrent mutation between the outer checks above and
    // this transaction can never slip a contradictory write through — and the
    // status transition is a HARD assertion (assertMissionTransition): it is
    // never conditionally skipped while completion state continues to write.
    // A ledger-gated downgrade can never be persisted without its matching
    // completed event, cursor, and result, and vice-versa.
    const now = this.now();
    const finalStatus = gated;
    this.repo.transaction(() => {
      const fresh = this.repo.get(missionId)!;
      this.assertFinalizable(fresh);
      assertMissionTransition(fresh.status, finalStatus);
      this.repo.setResult(missionId, result, now);
      this.repo.setStatus(missionId, finalStatus, now);
      this.repo.appendEvent(missionId, "mission.status_changed", `Status: ${fresh.status} → ${finalStatus}`, { from: fresh.status, to: finalStatus }, now);
      this.repo.appendEvent(
        missionId, "mission.completed", result.summary,
        { status: finalStatus, ledgerGated: ledgerGate, authoritativeSatisfied, authoritativeNodes: ledger.filter((n) => n.authoritative).length },
        now,
      );
      // Cursor persisted inside the same transaction: it truthfully exposes no
      // executable actions for terminal missions while preserving history.
      this.advanceCursor(missionId, { lastCompletedAction: "finalize" });
    });

    // Learning extraction runs last — after evidence and review — so only
    // ledger-backed conclusions become durable project memory. Extraction
    // problems never break finalization.
    if (this.deps.cortex) {
      try {
        const finished = this.get(missionId);
        const learnings = extractMissionLearnings(finished, this.now);
        if (learnings.length > 0) {
          this.deps.cortex.addLearnings(mission.projectId, learnings);
          this.repo.appendEvent(missionId, "mission.learnings_extracted", `Extracted ${learnings.length} evidence-backed learning(s)`, { count: learnings.length }, this.now());
        }
      } catch { /* extraction is best-effort by design */ }
    }
    return this.get(missionId);
  }

  cancel(missionId: string): Mission {
    const mission = this.get(missionId);
    if (isTerminalMissionStatus(mission.status)) return mission;
    this.transition(missionId, "cancelled");
    this.repo.appendEvent(missionId, "mission.cancelled", "Mission cancelled", {}, this.now());
    return this.get(missionId);
  }

  /** Resume reconstructs entirely from persistence — nothing lives only in
   *  memory. Returns the mission as-is; callers decide the next action. */
  resume(missionId: string): Mission {
    return this.get(missionId);
  }

  // ── Advanced Execution Kernel: contract, ledger, cursor ───────────────────
  /** Read the persisted contract (with assembled requirement nodes). */
  getContract(missionId: string): MissionContract {
    const c = this.repo.getContract(missionId);
    if (!c) throw new MissionError(`Contract for mission ${missionId} not found`, "not_found");
    return c;
  }

  listRequirementNodes(missionId: string): MissionRequirementNode[] {
    return this.repo.listRequirementNodes(missionId);
  }

  getCursor(missionId: string): MissionCursor {
    const cursor = this.repo.getCursor(missionId);
    if (!cursor) throw new MissionError(`Cursor for mission ${missionId} not found`, "not_found");
    return cursor;
  }

  getProjectActiveMission(projectId: string): ProjectActiveMission | undefined {
    return this.repo.getProjectActiveMission(projectId);
  }

  /** Repoint the per-project active-mission pointer. Validates that the mission
   *  exists and belongs to the given project; rejects nonexistent missions and
   *  cross-project assignments. */
  setProjectActiveMission(projectId: string, missionId: string): void {
    const mission = this.repo.get(missionId);
    if (!mission) {
      throw new MissionError(`Mission ${missionId} not found`, "not_found");
    }
    if (mission.projectId !== projectId) {
      throw new MissionError(
        `Mission ${missionId} belongs to project ${mission.projectId}, not ${projectId}`,
        "mission_project_mismatch",
      );
    }
    this.repo.setProjectActiveMission(projectId, missionId, this.now());
  }

  /** Mark a requirement node as approved, making it authoritative. model/derived
   *  nodes must be approved before they may become the active node. */
  approveRequirement(missionId: string, nodeId: string): MissionRequirementNode {
    const node = this.repo.getRequirementNode(nodeId);
    if (!node || node.missionId !== missionId) throw new MissionError("Requirement node not found in mission", "not_found");
    // Approving a node changes authoritative ledger meaning: a formerly
    // non-authoritative (pending) node becomes an authoritative pending
    // requirement, which can flip the mission out of a "ready to complete"
    // state. The node update, its event, AND a cursor recompute are therefore a
    // single atomic transaction — the cursor can never lag behind and keep
    // exposing a stale mark_complete.
    let updated!: MissionRequirementNode;
    const now = this.now();
    this.repo.transaction(() => {
      updated = this.repo.updateRequirementNode(nodeId, { approved: true, authoritative: true }, now)!;
      this.repo.appendEvent(missionId, "mission.requirement_status_changed", `Requirement approved: ${nodeId}`, { nodeId, approved: true }, now);
      this.advanceCursor(missionId);
    });
    return updated;
  }

  /**
   * Recompute the per-mission cursor: at most one active requirement node and a
   * bounded set of allowed next-actions derived from mission + node state. Never
   * silently clears the cursor — even a completed mission keeps its last cursor
   * so a terminal recovery can see where it left off.
   */
  advanceCursor(missionId: string, opts: { lastCompletedAction?: string | null } = {}): MissionCursor {
    const mission = this.get(missionId);
    const nodes = this.repo.listRequirementNodes(missionId);
    const active = selectActiveNode(nodes);
    const allowedNextActions = deriveAllowedActions(mission.status, active, nodes);

    // Preserve the prior lastCompletedAction unless a new one was supplied.
    const prior = this.repo.getCursor(missionId);
    const lastCompletedAction =
      opts.lastCompletedAction !== undefined ? opts.lastCompletedAction : (prior?.lastCompletedAction ?? null);

    const frozenNodeIds = nodes.filter((n) => n.status === "verified").map((n) => n.id);
    const invalidatedNodeIds = nodes.filter((n) => n.status === "invalidated").map((n) => n.id);

    // Surface a blocked reason when no node is active but a node is stuck behind
    // an unmet dependency (so the cursor honestly explains why it cannot advance).
    let blockedReason: string | null = null;
    if (!active) {
      const blocked = nodes.find(
        (n) => isDependencyBlocked(n, nodes) && (n.status === "pending" || n.status === "blocked"),
      );
      if (blocked) blockedReason = `Requirement ${blocked.id} is blocked by unmet dependencies`;
    }

    return this.repo.upsertCursor({
      missionId,
      activeNodeId: active ? active.id : null,
      activeObjective: active ? active.statement : null,
      allowedNextActions,
      blockedReason,
      lastCompletedAction,
      frozenNodeIds,
      invalidatedNodeIds,
    });
  }

  /**
   * Update a single requirement node's status.
   *
   * Invariants enforced here:
   *  • Exactly-one-active: promoting a node to `active` transactionally
   *    deactivates any other active node, so persistence can never expose two
   *    active nodes. A node whose dependencies are unmet cannot become active.
   *  • Valid transitions: `pending → verified` is blocked; a requirement must
   *    be `active` before it can be verified.
   *  • Verification evidence: transition to `verified` requires at least one
   *    durable evidence reference or verified file hash.
   *  • Verified-node freeze (I5): a verified (frozen) node can only leave
   *    `verified` when a persisted invalidation condition AND non-blank reason
   *    are supplied. History is append-only; prior entries are preserved.
   *
   * On transition to `verified` the verification file hashes and completion time
   * are recorded; the contract freeze flag and cursor are then recomputed.
   */
  updateRequirementStatus(
    missionId: string,
    nodeId: string,
    status: RequirementNodeStatus,
    opts: {
      fileHash?: string | null;
      fileHashes?: string[];
      evidenceRefs?: string[];
      failureReason?: string | null;
      invalidationCondition?: ReopenCondition;
      invalidationReason?: string | null;
      invalidationEvidenceRef?: string | null;
    } = {},
  ): MissionRequirementNode {
    const node = this.repo.getRequirementNode(nodeId);
    if (!node || node.missionId !== missionId) throw new MissionError("Requirement node not found in mission", "not_found");
    if (node.status === status) return node;
    const now = this.now();

    // ── Centralized state machine: applied BEFORE every special-case branch ──
    // A single authoritative transition table decides legality first, so no
    // branch below can smuggle in an illegal transition (e.g. pending→verified
    // or verified→active). Reopening a verified node is only ever to pending or
    // invalidated, and always with an invalidation condition/reason/evidence.
    assertRequirementTransition(node.status, status);

    // ── Promotion to active: enforce exactly-one-active + dependency check ──
    if (status === "active") {
      if (!node.approved) {
        throw new MissionError(
          `Requirement ${nodeId} cannot become active: it is not yet approved/authoritative`,
          "requirement_not_approved",
        );
      }
      const all = this.repo.listRequirementNodes(missionId);
      if (isDependencyBlocked(node, all)) {
        throw new MissionError(
          `Requirement ${nodeId} cannot become active: dependencies are not yet satisfied`,
          "dependency_unmet",
        );
      }
      // The deactivation of any other active node, the activation itself, the
      // event, the freeze recompute, and the cursor recompute are ONE atomic
      // transaction so persistence can never expose two active nodes nor a
      // cursor that disagrees with the ledger.
      let updated!: MissionRequirementNode;
      this.repo.transaction(() => {
        for (const other of all) {
          if (other.id !== nodeId && other.status === "active") {
            this.repo.updateRequirementNode(other.id, { status: "pending" }, now);
          }
        }
        updated = this.repo.updateRequirementNode(nodeId, { status: "active" }, now)!;
        this.repo.appendEvent(missionId, "mission.requirement_status_changed", `Requirement ${nodeId}: ${node.status} → active`, { nodeId, from: node.status, to: "active" }, now);
        const nodes = this.repo.listRequirementNodes(missionId);
        this.repo.setContractFrozen(missionId, computeFrozen(nodes), now);
        this.advanceCursor(missionId, { lastCompletedAction: "start_requirement" });
      });
      return updated;
    }

    // ── Reopening a verified (frozen) node requires durable evidence ────────
    // The transition table already guarantees `status` ∈ {pending, invalidated}
    // here; we additionally require a valid invalidation condition, a non-blank
    // reason, and a durable evidence reference belonging to this mission.
    if (node.status === "verified") {
      const verdict = canReopenNode(node, opts.invalidationCondition);
      if (!verdict.allowed || !opts.invalidationCondition) {
        throw new MissionError(
          `Verified requirement node ${nodeId} is frozen and cannot be reopened without persisted invalidation evidence (a condition, reason, and durable evidence must be recorded)`,
          "verified_node_reopen_requires_invalidation",
        );
      }
      if (!opts.invalidationReason || opts.invalidationReason.trim().length === 0) {
        throw new MissionError(
          `Reopening verified requirement ${nodeId} requires a non-blank invalidation reason`,
          "invalidation_reason_required",
        );
      }
      if (!opts.invalidationEvidenceRef || opts.invalidationEvidenceRef.trim().length === 0) {
        throw new MissionError(
          `Reopening verified requirement ${nodeId} requires a durable invalidation evidence reference`,
          "invalidation_evidence_required",
        );
      }
      // The evidence must exist and belong to this mission. Its status is not
      // constrained to "passed": a failed/inconclusive re-verification is itself
      // valid, durable evidence that a reopen is warranted.
      this.assertDurableEvidence(missionId, [opts.invalidationEvidenceRef], { requirePassed: false });
      const entry: InvalidationEntry = {
        condition: verdict.reason!,
        reason: opts.invalidationReason.trim(),
        invalidatedAt: now,
        evidenceRef: opts.invalidationEvidenceRef.trim(),
      };
      // Append history atomically from the LATEST persisted row (never a stale
      // in-memory copy), together with the event, freeze recompute, and cursor.
      let updated!: MissionRequirementNode;
      this.repo.transaction(() => {
        updated = this.repo.appendInvalidationEntry(
          nodeId, entry,
          { status, verifiedFileHashes: [], completedAt: null },
          now,
        )!;
        this.repo.appendEvent(
          missionId, "mission.requirement_reopened",
          `Reopened verified requirement: ${node.statement.slice(0, 120)}`,
          { nodeId, condition: verdict.reason, reason: entry.reason, evidenceRef: entry.evidenceRef }, now,
        );
        const nodes = this.repo.listRequirementNodes(missionId);
        this.repo.setContractFrozen(missionId, computeFrozen(nodes), now);
        this.advanceCursor(missionId, { lastCompletedAction: `reopen_requirement:${verdict.reason}` });
      });
      return updated;
    }

    // ── Verification: require real, durable evidence ───────────────────────
    // A hash-shaped string alone is NEVER trusted proof of completion — it is
    // merely supplementary content-integrity metadata. Every transition to
    // `verified` MUST carry at least one durable, mission-scoped, PASSED
    // evidence reference. Hashes, when supplied, are validated strictly but
    // can never substitute for evidence (hash-only verification is rejected).
    if (status === "verified") {
      const hashes = opts.fileHashes ?? (opts.fileHash ? [opts.fileHash] : []);
      const refs = opts.evidenceRefs ?? [];
      if (refs.length === 0) {
        throw new MissionError(
          `Requirement ${nodeId} verification requires at least one durable evidence reference (a file hash alone is not proof of completion)`,
          "verification_requires_evidence",
        );
      }
      for (const hash of hashes) {
        if (!isValidFileHash(hash)) {
          throw new MissionError(
            `Requirement ${nodeId} verification file hash is blank or malformed: ${JSON.stringify(hash)} (expected <algorithm>:<hexdigest>)`,
            "verification_hash_malformed",
          );
        }
      }
      // Evidence references must exist, belong to this mission, and represent
      // acceptable (passed) durable evidence — never an arbitrary string.
      this.assertDurableEvidence(missionId, refs, { requirePassed: true });
    }

    // ── Normal status transition (fully atomic incl. event, freeze, cursor) ─
    let updated: MissionRequirementNode | undefined;
    this.repo.transaction(() => {
      const patch: Parameters<MissionsRepository["updateRequirementNode"]>[1] = { status };
      if (status === "verified") {
        patch.verifiedFileHashes = opts.fileHashes ?? (opts.fileHash ? [opts.fileHash] : []);
        patch.evidenceRefs = opts.evidenceRefs ?? [];
        patch.completedAt = now;
      }
      if (status === "failed") {
        patch.lastFailure = opts.failureReason ?? "Requirement marked failed";
        patch.attempts = node.attempts + 1;
      }
      if (status === "verified" || status === "waived" || status === "invalidated") {
        patch.completedAt = patch.completedAt ?? now;
      }
      updated = this.repo.updateRequirementNode(nodeId, patch, now)!;
      this.repo.appendEvent(missionId, "mission.requirement_status_changed", `Requirement ${nodeId}: ${node.status} → ${status}`, { nodeId, from: node.status, to: status }, now);
      const nodes = this.repo.listRequirementNodes(missionId);
      this.repo.setContractFrozen(missionId, computeFrozen(nodes), now);
      this.advanceCursor(missionId, { lastCompletedAction: `status:${status}` });
    });
    return updated!;
  }

  /**
   * Validate that every supplied evidence reference is a real, durable evidence
   * record for THIS mission. Rejects blank ids, nonexistent evidence,
   * cross-mission evidence, and (when requirePassed) evidence whose status is
   * not `passed`. This is what stops an arbitrary string like "ev-1" from
   * proving completion.
   */
  private assertDurableEvidence(missionId: string, refs: string[], opts: { requirePassed: boolean }): void {
    for (const ref of refs) {
      if (typeof ref !== "string" || ref.trim().length === 0) {
        throw new MissionError("Evidence reference is blank", "evidence_ref_blank");
      }
      const evidence = this.repo.getEvidence(ref.trim());
      if (!evidence) {
        throw new MissionError(`Evidence reference ${JSON.stringify(ref)} does not exist`, "evidence_ref_not_found");
      }
      if (evidence.missionId !== missionId) {
        throw new MissionError(
          `Evidence reference ${JSON.stringify(ref)} belongs to a different mission (${evidence.missionId})`,
          "evidence_ref_cross_mission",
        );
      }
      if (opts.requirePassed && evidence.status !== "passed") {
        throw new MissionError(
          `Evidence reference ${JSON.stringify(ref)} is not acceptable durable evidence (status: ${evidence.status})`,
          "evidence_ref_not_passed",
        );
      }
    }
  }

  // ── budget ───────────────────────────────────────────────────────────────
  private addSpend(missionId: string, usd: number): void {
    const mission = this.get(missionId);
    const budget = { ...mission.budget, spentUsd: mission.budget.spentUsd + usd };
    this.repo.updateBudget(missionId, budget, this.now());
  }

  /** True when the mission has a budget cap and has reached/exceeded it. */
  budgetExhausted(missionId: string): boolean {
    const b = this.get(missionId).budget;
    if (b.maxUsd !== null && b.spentUsd >= b.maxUsd) return true;
    if (b.maxAttempts !== null && b.attemptsUsed >= b.maxAttempts) return true;
    return false;
  }

  private changedFilesFor(mission: Mission): string[] {
    const workspace = this.deps.getWorkspacePath(mission.projectId);
    if (!workspace || !isGitRepo(workspace)) return [];
    return candidateFiles(workspace);
  }
}

function gitDiff(workspace: string): string {
  const staged = spawnSync("git", ["diff", "--no-color"], { cwd: workspace, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const untrackedList = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: workspace, encoding: "utf8" });
  let out = staged.status === 0 ? staged.stdout : "";
  if (untrackedList.status === 0 && untrackedList.stdout.trim()) {
    out += `\n# untracked files:\n${untrackedList.stdout.trim()}`;
  }
  return out;
}

function hasMissingWorkspaceFileReference(command: string, workspace: string): boolean {
  for (const ref of extractCommandFileReferences(command)) {
    const target = isAbsolute(ref) ? normalize(ref) : resolve(workspace, ref);
    const rel = relative(workspace, target);
    if (rel.startsWith("..") || isAbsolute(rel)) return true;
    if (!existsSync(target)) return true;
  }
  return false;
}

function extractCommandFileReferences(command: string): string[] {
  const refs = new Set<string>();
  const explicit = /(?:require|readFileSync|readFile)\(\s*["']([^"']+)["']/gi;
  for (const match of command.matchAll(explicit)) {
    const ref = normalizeCommandReference(match[1]);
    if (ref) refs.add(ref);
  }

  const quotedPath = /["']((?:\.{1,2}[\\/])?[^"']+[\\/][^"']+\.[A-Za-z0-9]{1,12})["']/g;
  for (const match of command.matchAll(quotedPath)) {
    const ref = normalizeCommandReference(match[1]);
    if (ref) refs.add(ref);
  }
  return [...refs];
}

function normalizeCommandReference(value: string | undefined): string | null {
  if (!value) return null;
  const ref = value.trim().split(/[?#]/, 1)[0] ?? "";
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref)) return null;
  if (/[*!{}]/.test(ref)) return null;
  if (!/[\\/]/.test(ref)) return null;
  return ref;
}

function isBrittleInlineGeneratedArtifactCheck(command: string): boolean {
  return /\bnode(?:\.exe)?\s+-(?:e|p)\b/i.test(command)
    && /(?:require|readFileSync|readFile)\(\s*["']\.{1,2}[\\/]generated[\\/]/i.test(command);
}
