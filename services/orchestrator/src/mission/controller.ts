import { randomUUID } from "node:crypto";
import type {
  ApprovalStatus,
  MissionRecoveryAction,
  MissionRecoveryCategory,
  MissionRuntime,
  MissionStatus,
  TaskStatus,
} from "@morrow/contracts";
import type {
  MissionRuntimeLeaseFence,
  missionRuntimeRepository,
} from "../repositories/mission-runtime.js";
import type { GuardianDecision } from "./guardian.js";

type MissionRuntimeRepository = ReturnType<typeof missionRuntimeRepository>;

export interface ControllerRecovery {
  category: MissionRecoveryCategory;
  diagnosis: string;
  failedStrategyFingerprint: string | null;
  nextStrategyFingerprint: string | null;
  action: MissionRecoveryAction;
  retryCondition: string | null;
  exhausted: boolean;
}

export interface ControllerSnapshot {
  tasks: Array<{ id: string; status: TaskStatus }>;
  approvals: Array<{ id: string; status: ApprovalStatus; autoResolvable?: boolean }>;
  guardianDecision: GuardianDecision;
  recovery: ControllerRecovery | null;
  /**
   * The mission aggregate's own status. The runtime machine (this controller)
   * and the mission status machine advance together; the controller reads this
   * so it never runs ahead of a mission that is waiting on a human (plan
   * approval) or already terminal (cancelled).
   */
  missionStatus?: MissionStatus;
}

export interface MissionControllerDependencies {
  runtime: MissionRuntimeRepository;
  loadSnapshot(missionId: string): ControllerSnapshot;
  dispatchWorker(input: { missionId: string; idempotencyKey: string }): Promise<{ taskId: string }> | { taskId: string };
  finalizeMission(missionId: string): Promise<unknown> | unknown;
  validateMission?(missionId: string): Promise<unknown> | unknown;
  reviewMission?(missionId: string): Promise<unknown> | unknown;
  resolveApproval?(approvalId: string): Promise<unknown> | unknown;
  /**
   * Prepare the mission plan (success criteria) before execution starts. Runs
   * once during the planning phase; returns whether the plan now awaits a
   * human approval so the controller can park in `waiting_for_approval`
   * instead of executing an unapproved plan. Absent in tests that drive the
   * runtime machine alone.
   */
  prepareMission?(missionId: string): Promise<{ awaitingApproval: boolean }> | { awaitingApproval: boolean };
  /**
   * Record a dispatch failure in the mission's durable, user-visible history
   * (mission event + status). The controller itself only owns runtime state;
   * this hook keeps the mission aggregate truthful without coupling the
   * controller to the mission service.
   */
  recordDispatchFailure?(missionId: string, message: string): void;
  now?: () => string;
  createId?: () => string;
}

export interface ControllerTickResult {
  runtime: MissionRuntime;
  action: string;
  immediate: boolean;
  waitingForExternal: boolean;
}

export function wakeReasonForTask(taskId: string): string {
  return `task:${taskId}:state_changed`;
}

export class MissionController {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly dependencies: MissionControllerDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createId = dependencies.createId ?? randomUUID;
  }

  async tick(missionId: string, fence: MissionRuntimeLeaseFence): Promise<ControllerTickResult> {
    const now = this.now();
    const runtime = this.dependencies.runtime.requireLease({ missionId, fence, now });
    const snapshot = this.dependencies.loadSnapshot(missionId);

    const transition = (to: Parameters<MissionRuntimeRepository["transition"]>[0]["to"], cause: string, actor: "controller" | "guardian" = "controller") => {
      this.dependencies.runtime.transition({
        missionId,
        from: runtime.state,
        to,
        cause,
        actor,
        details: {},
        fence,
        now,
      });
      return this.result(missionId, `transition:${to}`, true, false);
    };

    // A cancelled mission aggregate always wins: park the runtime machine in
    // its own cancelled state instead of continuing to drive dead work.
    if (
      snapshot.missionStatus === "cancelled"
      && !["blocked", "completed", "cancelled", "abandoned", "superseded"].includes(runtime.state)
    ) {
      return transition("cancelled", "mission_cancelled");
    }

    switch (runtime.state) {
      case "created":
        return transition("orienting", "controller_started");
      case "orienting":
        return transition("planning", "orientation_complete");
      case "planning": {
        if (this.dependencies.prepareMission) {
          const prepared = await this.dependencies.prepareMission(missionId);
          if (prepared.awaitingApproval) {
            return transition("waiting_for_approval", "plan_awaiting_approval");
          }
        }
        return transition("executing", "plan_ready");
      }
      case "replanning":
        return transition("executing", "replan_ready");
      case "waiting_for_tool": {
        const active = this.activeTask(runtime, snapshot);
        if (active?.status === "completed" || active?.status === "verified") {
          return transition("executing", "tool_completed");
        }
        return this.result(missionId, "wait:tool", false, true);
      }
      case "waiting_for_approval": {
        const pending = snapshot.approvals.find((approval) => approval.status === "pending");
        if (pending) return this.result(missionId, "wait:approval", false, true);
        // The mission-level plan approval is not an approvals-table row; the
        // mission status carries it. Keep waiting until a human approves.
        if (snapshot.missionStatus === "awaiting_criteria_approval") {
          return this.result(missionId, "wait:plan_approval", false, true);
        }
        return transition("executing", "approval_resolved");
      }
      case "executing":
        return this.executeTick(missionId, runtime, snapshot, fence, now);
      case "validating":
        return this.validationTick(missionId, runtime, snapshot, fence, now);
      case "recovering":
        if (snapshot.recovery?.exhausted) return transition("blocked", "strategies_exhausted");
        this.dependencies.runtime.setActiveTask({ missionId, taskId: null, fence, now });
        return transition("replanning", "recovery_selected");
      case "blocked":
      case "completed":
      case "cancelled":
      case "abandoned":
      case "superseded":
        return this.result(missionId, `terminal:${runtime.state}`, false, false);
    }
  }

  private async executeTick(
    missionId: string,
    runtime: MissionRuntime,
    snapshot: ControllerSnapshot,
    fence: MissionRuntimeLeaseFence,
    now: string,
  ): Promise<ControllerTickResult> {
    const pendingApproval = snapshot.approvals.find((approval) => approval.status === "pending");
    if (pendingApproval) {
      if (pendingApproval.autoResolvable && this.dependencies.resolveApproval) {
        await this.dependencies.resolveApproval(pendingApproval.id);
        return this.result(missionId, "approval:auto_resolved", true, false);
      }
      this.dependencies.runtime.transition({
        missionId,
        from: "executing",
        to: "waiting_for_approval",
        cause: "approval_required",
        actor: "controller",
        details: { approvalId: pendingApproval.id },
        fence,
        now,
      });
      return this.result(missionId, "wait:approval", false, true);
    }

    const active = this.activeTask(runtime, snapshot);
    if (!active) return this.dispatchTick(missionId, runtime, fence, now);
    if (active.status === "queued" || active.status === "running") {
      return this.result(missionId, `wait:${active.id}`, false, true);
    }
    if (active.status === "completed" || active.status === "verified") {
      this.dependencies.runtime.transition({
        missionId,
        from: "executing",
        to: "validating",
        cause: "candidate_answer_ready",
        actor: "worker",
        details: { taskId: active.id },
        fence,
        now,
      });
      return this.result(missionId, "validate:candidate", true, false);
    }
    if (active.status === "failed" || active.status === "interrupted") {
      await this.recordRecovery(missionId, active.id, snapshot.recovery, fence, now);
      this.dependencies.runtime.transition({
        missionId,
        from: "executing",
        to: "recovering",
        cause: "worker_recovery_required",
        actor: "controller",
        details: { taskId: active.id },
        fence,
        now,
      });
      return this.result(missionId, "recover:worker", true, false);
    }
    this.dependencies.runtime.transition({
      missionId,
      from: "executing",
      to: "blocked",
      cause: "worker_cancelled",
      actor: "controller",
      details: { taskId: active.id },
      fence,
      now,
    });
    return this.result(missionId, "blocked:worker_cancelled", false, false);
  }

  private async dispatchTick(
    missionId: string,
    runtime: MissionRuntime,
    fence: MissionRuntimeLeaseFence,
    now: string,
  ): Promise<ControllerTickResult> {
    const idempotencyKey = `dispatch:${missionId}:phase:${runtime.transitionSequence}`;
    const operation = this.dependencies.runtime.enqueueOperation({
      missionId,
      idempotencyKey,
      kind: "dispatch_worker",
      strategyFingerprint: "worker:primary",
      input: { missionId },
      fence,
      now,
    });
    if (operation.status === "completed") {
      const taskId = typeof operation.result?.taskId === "string" ? operation.result.taskId : null;
      if (taskId) this.dependencies.runtime.setActiveTask({ missionId, taskId, fence, now });
      return this.result(missionId, "dispatch:reconciled", false, true);
    }
    this.dependencies.runtime.startOperation({ missionId, operationId: operation.id, fence, now });
    try {
      const dispatched = await this.dependencies.dispatchWorker({ missionId, idempotencyKey });
      this.dependencies.runtime.completeOperation({
        missionId,
        operationId: operation.id,
        fence,
        result: { taskId: dispatched.taskId },
        effectEvidenceIds: [],
        now,
      });
      this.dependencies.runtime.setActiveTask({ missionId, taskId: dispatched.taskId, fence, now });
      return this.result(missionId, "dispatch:worker", false, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dependencies.runtime.failOperation({
        missionId,
        operationId: operation.id,
        fence,
        result: { message },
        now,
      });
      // A dispatch that cannot even start a worker (typically: no configured
      // model provider) is not transient — retrying in-process would fail the
      // same way forever. Park the mission in `blocked` with a durable
      // recovery decision so the UI can present the exact cause and a
      // user-driven retry, and record it in the mission's visible history.
      // Silently swallowing this error is what once left missions stuck
      // showing "Draft" while the runtime claimed to be executing.
      this.dependencies.runtime.recordRecovery({
        id: this.createId(),
        missionId,
        operationId: operation.id,
        category: "provider_failure",
        diagnosis: message.slice(0, 2_000),
        failedStrategyFingerprint: "worker:primary",
        nextStrategyFingerprint: null,
        action: "await_retry_condition",
        retryCondition: "A model provider is configured and the mission is retried.",
        exhausted: false,
        fence,
        now,
      });
      this.dependencies.recordDispatchFailure?.(missionId, message);
      this.dependencies.runtime.transition({
        missionId,
        from: "executing",
        to: "blocked",
        cause: "dispatch_failed",
        actor: "controller",
        details: { operationId: operation.id, message },
        fence,
        now,
      });
      return this.result(missionId, "blocked:dispatch_failed", false, false);
    }
  }

  private async validationTick(
    missionId: string,
    runtime: MissionRuntime,
    snapshot: ControllerSnapshot,
    fence: MissionRuntimeLeaseFence,
    now: string,
  ): Promise<ControllerTickResult> {
    if (!snapshot.guardianDecision.passed) {
      const requested = new Set(snapshot.guardianDecision.nextActions);
      if (this.dependencies.validateMission && [
        "validate_criteria",
        "validate_requirements",
        "run_required_validation",
      ].some((action) => requested.has(action))) {
        const result = await this.runGuardianAction(
          missionId,
          runtime,
          fence,
          now,
          "validate_criteria",
          "guardian:validate",
          () => this.dependencies.validateMission!(missionId),
        );
        if (result) return result;
      }
      if (this.dependencies.reviewMission && requested.has("run_independent_review")) {
        const result = await this.runGuardianAction(
          missionId,
          runtime,
          fence,
          now,
          "run_review",
          "guardian:review",
          () => this.dependencies.reviewMission!(missionId),
        );
        if (result) return result;
      }
      this.dependencies.runtime.transition({
        missionId,
        from: "validating",
        to: "recovering",
        cause: "guardian_rejected",
        actor: "guardian",
        details: { nextActions: snapshot.guardianDecision.nextActions },
        fence,
        now,
      });
      return this.result(missionId, "recover:guardian", true, false);
    }
    const operation = this.dependencies.runtime.enqueueOperation({
      missionId,
      idempotencyKey: `guardian:${missionId}:complete`,
      kind: "guardian_review",
      strategyFingerprint: "guardian:completion",
      input: { evidenceSnapshot: snapshot.guardianDecision.evidenceSnapshot },
      fence,
      now,
    });
    if (operation.status !== "completed") {
      this.dependencies.runtime.startOperation({ missionId, operationId: operation.id, fence, now });
      try {
        await this.dependencies.finalizeMission(missionId);
        this.dependencies.runtime.completeOperation({
          missionId,
          operationId: operation.id,
          fence,
          result: { passed: true },
          effectEvidenceIds: [],
          now,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.dependencies.runtime.failOperation({
          missionId,
          operationId: operation.id,
          fence,
          result: { message },
          now,
        });
        this.dependencies.runtime.recordRecovery({
          id: this.createId(),
          missionId,
          operationId: operation.id,
          category: "verification_failure",
          diagnosis: `Guardian passed but finalization failed: ${message}`,
          failedStrategyFingerprint: "guardian:completion",
          nextStrategyFingerprint: "guardian:reconcile-finalization",
          action: "replan",
          retryCondition: null,
          exhausted: false,
          fence,
          now,
        });
        this.dependencies.runtime.transition({
          missionId,
          from: "validating",
          to: "recovering",
          cause: "finalization_failed",
          actor: "controller",
          details: { operationId: operation.id, message },
          fence,
          now,
        });
        return this.result(missionId, "recover:finalization", true, false);
      }
    }
    this.dependencies.runtime.transition({
      missionId,
      from: "validating",
      to: "completed",
      cause: "guardian_passed",
      actor: "guardian",
      details: { operationId: operation.id },
      fence,
      now,
    });
    return this.result(missionId, "complete:guardian", false, false);
  }

  private async runGuardianAction(
    missionId: string,
    runtime: MissionRuntime,
    fence: MissionRuntimeLeaseFence,
    now: string,
    kind: "validate_criteria" | "run_review",
    strategyFingerprint: string,
    action: () => Promise<unknown> | unknown,
  ): Promise<ControllerTickResult | null> {
    const operation = this.dependencies.runtime.enqueueOperation({
      missionId,
      idempotencyKey: `${kind}:${missionId}:task:${runtime.activeTaskId ?? runtime.transitionSequence}`,
      kind,
      strategyFingerprint,
      input: { taskId: runtime.activeTaskId },
      fence,
      now,
    });
    if (operation.status === "completed") return null;
    this.dependencies.runtime.startOperation({ missionId, operationId: operation.id, fence, now });
    try {
      await action();
      this.dependencies.runtime.completeOperation({
        missionId,
        operationId: operation.id,
        fence,
        result: { completed: true },
        effectEvidenceIds: [],
        now,
      });
      return this.result(missionId, `guardian_action:${kind}`, true, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dependencies.runtime.failOperation({
        missionId,
        operationId: operation.id,
        fence,
        result: { message },
        now,
      });
      this.dependencies.runtime.transition({
        missionId,
        from: "validating",
        to: "recovering",
        cause: "guardian_action_failed",
        actor: "guardian",
        details: { kind, operationId: operation.id, message },
        fence,
        now,
      });
      return this.result(missionId, `recover:${kind}`, true, false);
    }
  }

  private async recordRecovery(
    missionId: string,
    taskId: string,
    supplied: ControllerRecovery | null,
    fence: MissionRuntimeLeaseFence,
    now: string,
  ): Promise<void> {
    const recovery: ControllerRecovery = supplied ?? {
      category: "process_interruption",
      diagnosis: "Worker ended before the mission reached validation.",
      failedStrategyFingerprint: `worker:${taskId}`,
      nextStrategyFingerprint: "worker:replacement",
      action: "restore_checkpoint",
      retryCondition: null,
      exhausted: false,
    };
    const operation = this.dependencies.runtime.enqueueOperation({
      missionId,
      idempotencyKey: `recover:${taskId}:${recovery.nextStrategyFingerprint ?? recovery.action}`,
      kind: "recover",
      strategyFingerprint: recovery.nextStrategyFingerprint,
      input: { taskId, category: recovery.category },
      fence,
      now,
    });
    if (operation.status !== "completed") {
      this.dependencies.runtime.startOperation({ missionId, operationId: operation.id, fence, now });
      this.dependencies.runtime.completeOperation({
        missionId,
        operationId: operation.id,
        fence,
        result: { action: recovery.action },
        effectEvidenceIds: [],
        now,
      });
      this.dependencies.runtime.recordRecovery({
        id: this.createId(),
        missionId,
        operationId: operation.id,
        ...recovery,
        fence,
        now,
      });
    }
  }

  private activeTask(runtime: MissionRuntime, snapshot: ControllerSnapshot) {
    if (!runtime.activeTaskId) return undefined;
    return snapshot.tasks.find((task) => task.id === runtime.activeTaskId);
  }

  private result(
    missionId: string,
    action: string,
    immediate: boolean,
    waitingForExternal: boolean,
  ): ControllerTickResult {
    const runtime = this.dependencies.runtime.get(missionId);
    if (!runtime) throw new Error(`Mission runtime not found: ${missionId}`);
    return { runtime, action, immediate, waitingForExternal };
  }
}
