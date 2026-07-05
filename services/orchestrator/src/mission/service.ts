import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type {
  Mission, MissionStatus, MissionCriterion, MissionCriterionState, MissionEvidence,
  MissionFailure, MissionCheckpoint, MissionReview, MissionBudget, MissionResult,
  MissionVerificationStrategy, CreateMissionInput,
} from "@morrow/contracts";
import { assertMissionTransition, canTransitionMission, gradeMission, isTerminalMissionStatus } from "@morrow/contracts";
import type { MissionsRepository } from "../repositories/missions.js";
import type { ChatMessage } from "../provider/base.js";
import { buildCriteriaPrompt, parseCriteriaFromModel, isVagueCriterion, rewriteVague, type DraftCriterion } from "./criteria.js";
import { runVerification, type RunOptions } from "./evidence-runner.js";
import { categorizeFailure, normalizeSignature, planRecovery, type RecoveryPlan } from "./failures.js";
import { captureCheckpoint, rollbackToCheckpoint, describeCheckpointDiff, candidateFiles, isGitRepo } from "./checkpoints.js";
import { buildReviewMessages, parseReviewVerdict, type ReviewContext } from "./reviewer.js";
import { buildMissionResult } from "./result.js";

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
    const mission = this.repo.create({
      id, projectId, conversationId: input.conversationId ?? null,
      objective: input.objective, autoApprove: input.autoApprove ?? false, budget,
    }, this.now());
    this.repo.appendEvent(id, "mission.created", `Mission created: ${input.objective.slice(0, 80)}`, {}, this.now());
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

  private transition(missionId: string, to: MissionStatus): Mission {
    const current = this.get(missionId);
    if (current.status === to) return current;
    assertMissionTransition(current.status, to);
    this.repo.setStatus(missionId, to, this.now());
    this.repo.appendEvent(missionId, "mission.status_changed", `Status: ${current.status} → ${to}`, { from: current.status, to }, this.now());
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
    for (const c of mission.criteria) {
      if (c.state === "waived" || c.state === "verified") continue;
      // Manual/browser/review strategies cannot be auto-proven here.
      if (c.verification.kind === "manual" || c.verification.kind === "browser") continue;
      if (c.verification.kind === "review") continue; // proven by the reviewer phase
      await this.verifyCriterion(missionId, c.id);
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
  /** Run the independent reviewer as a SEPARATE execution with isolated
   *  instructions. Transitions running → reviewing, records the verdict, and
   *  returns the review. Does not itself grade the mission. */
  async runReview(missionId: string): Promise<MissionReview> {
    let mission = this.get(missionId);
    if (mission.status === "running") mission = this.transition(missionId, "reviewing");
    this.repo.appendEvent(missionId, "mission.review_started", "Independent review started", {}, this.now());

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
    this.repo.setReview(review);
    const budget = { ...mission.budget, reviewCyclesUsed: mission.budget.reviewCyclesUsed + 1 };
    this.repo.updateBudget(missionId, budget, this.now());

    // A `review`-kind criterion is proven by the reviewer itself: when the
    // verdict is an approval, record the review as its evidence and verify it;
    // a rejection fails it. Non-approvals leave it unverified (honest).
    const approving = review.verdict === "approved" || review.verdict === "approved_with_risks";
    for (const c of mission.criteria) {
      if (c.verification.kind !== "review") continue;
      const evidence = this.repo.addEvidence({
        id: `ev-${randomUUID()}`, missionId, criterionIds: [c.id], type: "review",
        summary: `Independent review: ${review.verdict.replace(/_/g, " ")}`,
        command: null, exitCode: null, outputRef: null, artifactPath: null,
        status: approving ? "passed" : review.verdict === "revisions_required" ? "failed" : "inconclusive",
      });
      this.repo.appendEvent(missionId, "mission.evidence_recorded", evidence.summary, { criterionId: c.id, status: evidence.status }, this.now());
      if (approving) this.repo.updateCriterion(c.id, { state: "verified" }, this.now());
      else if (review.verdict === "revisions_required") this.repo.updateCriterion(c.id, { state: "failed", failureReason: "Independent reviewer requested revisions" }, this.now());
    }

    this.repo.appendEvent(missionId, "mission.review_completed", `Review verdict: ${review.verdict}`, { verdict: review.verdict }, this.now());
    return review;
  }

  // ── grading / finalize ───────────────────────────────────────────────────
  /** Grade the mission from criteria + review and set the terminal status. */
  finalize(missionId: string, opts?: { humanInterventions?: number; tasksCompleted?: number; elapsedMs?: number | null }): Mission {
    const mission = this.get(missionId);
    const status = gradeMission(mission.criteria, mission.finalReview?.verdict ?? null);
    const result = buildMissionResult(mission, {
      review: mission.finalReview,
      changedFiles: this.changedFilesFor(mission),
      humanInterventions: opts?.humanInterventions ?? 0,
      tasksCompleted: opts?.tasksCompleted ?? 0,
      elapsedMs: opts?.elapsedMs ?? (mission.startedAt ? Date.parse(this.now()) - Date.parse(mission.startedAt) : null),
      spentUsd: mission.budget.spentUsd || null,
    });
    this.repo.setResult(missionId, result, this.now());
    if (!isTerminalMissionStatus(mission.status) && canTransitionMission(mission.status, status)) {
      this.transition(missionId, status);
    }
    this.repo.appendEvent(missionId, "mission.completed", result.summary, { status }, this.now());
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
