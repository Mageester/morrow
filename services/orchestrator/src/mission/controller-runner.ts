import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { MissionRuntime, MissionStatus } from "@morrow/contracts";
import { resolveMorrowHome } from "../home.js";
import { buildMissionCompletion } from "./completion.js";
import { conversationsRepository } from "../repositories/conversations.js";
import { approvalsRepository } from "../repositories/approvals.js";
import { missionsRepository } from "../repositories/missions.js";
import { projectRepository } from "../repositories/projects.js";
import {
  MissionRuntimeLeaseFenceError,
  missionRuntimeRepository,
  type MissionRuntimeLeaseFence,
} from "../repositories/mission-runtime.js";
import { dispatchAgentTask } from "./task-dispatcher.js";
import { MissionError, MissionService, type MissionCompletionFn } from "./service.js";
import { MissionController, type ControllerRecovery, type ControllerTickResult } from "./controller.js";
import { intelligenceRepository } from "../repositories/intelligence.js";
import { memoryRepository } from "../repositories/memory.js";
import { learnedSkillsRepository } from "../repositories/learned-skills.js";
import { CortexService } from "../cortex/service.js";
import { AutomaticMemoryService } from "../cortex/automatic-memory.js";
import { AutomaticSkillService } from "../cortex/automatic-skills.js";
import { listProviderStatuses } from "../provider/registry.js";
import { decideWorkerRecovery, type ProviderFailureDetails } from "./worker-recovery.js";
import { playwrightController, resolvePlaywrightChannel } from "../browser/playwright.js";
import type { TaskCancelReason } from "../runner.js";
import { terminalDispositionForMission, TERMINAL_ENTRY_KINDS, type MissionTerminalOutcomeInput, type TerminalEntryKind } from "./terminal-outcome.js";

type MissionRuntimeRepository = ReturnType<typeof missionRuntimeRepository>;

export interface RunnableMissionController {
  tick(missionId: string, fence: MissionRuntimeLeaseFence): Promise<ControllerTickResult>;
}

export interface ObservableTaskRunner {
  isActive(taskId: string): boolean;
  waitFor(taskId: string): Promise<void>;
  cancel?(taskId: string, reason?: TaskCancelReason): void;
  cancelAndWait?(taskId: string, reason?: TaskCancelReason): Promise<void>;
  onSettled?(listener: (taskId: string) => void): () => void;
}

export interface MissionControllerRunnerDependencies {
  runtime: MissionRuntimeRepository;
  controller: MissionController | RunnableMissionController;
  taskRunner: ObservableTaskRunner;
  ownerId: string;
  concludeTerminalOutcome?(missionId: string, input: MissionTerminalOutcomeInput): Promise<unknown> | unknown;
  /** Read the mission aggregate status when close-out failed after a durable write. */
  getMissionStatus?(missionId: string): MissionStatus | null | undefined;
  now?: () => string;
  leaseMs?: number;
}

type ControllerFailurePhase = "drive" | "tick" | "prepare" | "closeout";

type DispatchEffect =
  | { kind: "none" }
  | { kind: "completed"; taskId: string }
  | { kind: "unknown"; operationId: string };

/**
 * Controller failures are intentionally bounded. The durable recovery row is
 * the retry ledger, so a process restart cannot turn one broken controller
 * action into an unbounded in-process loop.
 */
const MAX_CONTROLLER_FAILURE_ATTEMPTS = 2;
const CONTROLLER_FAILURE_STRATEGY_PREFIX = "controller-failure";

export interface DefaultMissionControllerRunnerDependencies {
  db: Database.Database;
  taskRunner: ObservableTaskRunner & { run(taskId: string): unknown };
  env?: NodeJS.ProcessEnv;
  ownerId?: string;
  now?: () => string;
  leaseMs?: number;
  /**
   * Model boundary for mission planning and review. Production omits it and
   * resolves a configured provider; deterministic gates inject a scripted
   * completion so the controller, Guardian, and review paths stay real while
   * the external model call does not.
   */
  completion?: MissionCompletionFn;
}

/**
 * Runs short, fenced controller ticks. A controller never owns a lease while it
 * waits for external work, and a second wake while active is coalesced into one
 * follow-up run.
 */
export class MissionControllerRunner {
  private readonly activePromises = new Map<string, Promise<void>>();
  // External worker waits outlive the fenced drive promise. Keep their
  // classification promise attached to the mission so waitFor() cannot report
  // success before a detached callback has durably handled its failure.
  private readonly detachedPromises = new Map<string, {
    promise: Promise<void>;
    waiters: number;
  }>();
  private readonly pendingWakes = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly now: () => string;
  private readonly leaseMs: number;

  constructor(private readonly dependencies: MissionControllerRunnerDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.leaseMs = dependencies.leaseMs ?? 60_000;
  }

  run(missionId: string): void {
    this.cancelled.delete(missionId);
    if (this.activePromises.has(missionId)) {
      this.pendingWakes.add(missionId);
      return;
    }
    const promise = this.drive(missionId).finally(() => {
      this.activePromises.delete(missionId);
      if (this.pendingWakes.delete(missionId) && !this.cancelled.has(missionId)) {
        this.run(missionId);
      }
    });
    this.activePromises.set(missionId, promise);
    // `drive` classifies expected controller failures durably. Keep this last
    // catch as a process-level guard for persistence/runtime failures in that
    // classifier itself; a rejected promise must never be mistaken for a
    // still-running mission.
    void promise.catch((error) => {
      console.error(`Mission controller run failed for ${missionId}:`, error);
    });
  }

  wake(missionId: string): void {
    this.run(missionId);
  }

  cancel(missionId: string): void {
    this.cancelled.add(missionId);
    this.pendingWakes.delete(missionId);
    const runtime = this.dependencies.runtime.get(missionId);
    if (runtime?.activeTaskId) this.dependencies.taskRunner.cancel?.(runtime.activeTaskId, "mission_terminal");
  }

  /**
   * Stop controller driving and await the durable worker tree. Callers use
   * this before returning a timeout/cancel response so the response cannot
   * race an active worker or one of its descendants.
   */
  async cancelAndWait(missionId: string): Promise<void> {
    this.cancelled.add(missionId);
    this.pendingWakes.delete(missionId);
    for (;;) {
      const runtime = this.dependencies.runtime.get(missionId);
      if (runtime?.activeTaskId) {
        await this.cancelTaskAndWait(runtime.activeTaskId);
      }
      await this.waitFor(missionId);

      // A controller tick that was already inside dispatch can persist its
      // active task after the first scan above. Re-read the runtime after the
      // controller settles and cancel that late task before returning to the
      // caller; otherwise a timeout response could still leave a worker alive.
      const lateTaskId = this.dependencies.runtime.get(missionId)?.activeTaskId;
      if (lateTaskId && this.dependencies.taskRunner.isActive(lateTaskId)) {
        await this.cancelTaskAndWait(lateTaskId);
        continue;
      }
      if (!this.isActive(missionId)) return;
    }
  }

  /** Stop this process from driving a mission without mutating durable worker state. */
  async stop(missionId: string): Promise<void> {
    this.cancelled.add(missionId);
    this.pendingWakes.delete(missionId);
    // Stopping a driver intentionally does not wait for the external worker;
    // its detached promise remains available to a subsequent waitFor() call
    // for truthful callback-path failure reporting.
    const active = this.activePromises.get(missionId);
    if (active) await active;
  }

  isActive(missionId: string): boolean {
    return this.activePromises.has(missionId);
  }

  async waitFor(missionId: string): Promise<void> {
    while (true) {
      const active = this.activePromises.get(missionId);
      if (active) {
        await active;
        continue;
      }
      const detached = this.detachedPromises.get(missionId);
      if (!detached) return;
      detached.waiters += 1;
      try {
        await detached.promise;
      } finally {
        detached.waiters -= 1;
        if (detached.waiters === 0 && this.detachedPromises.get(missionId) === detached) {
          this.detachedPromises.delete(missionId);
        }
      }
    }
  }

  /** Reconcile a terminal mission whose runtime is already terminal and cannot
   * acquire a normal controller lease. Active work is still cancelled and
   * settled before the same mission close-out method records its result. */
  async reconcileTerminalOutcome(missionId: string, input: MissionTerminalOutcomeInput): Promise<void> {
    const initial = this.dependencies.runtime.get(missionId);
    let fence: MissionRuntimeLeaseFence | undefined;
    if (initial && !isMissionRuntimeTerminal(initial)) {
      const claimedAt = this.now();
      fence = this.dependencies.runtime.claimTerminalRecoveryLease({
        missionId,
        ownerId: this.dependencies.ownerId,
        now: claimedAt,
        expiresAt: this.expiresAt(claimedAt),
      }) ?? undefined;
      const latest = this.dependencies.runtime.get(missionId);
      if (!fence && latest && !isMissionRuntimeTerminal(latest)) {
        throw new MissionError(`Terminal mission runtime lease could not be fenced for ${missionId}`, "finalization_integrity_error");
      }
    }
    const runtimeBeforeCloseout = this.dependencies.runtime.get(missionId);
    const runtimeWasTerminal = runtimeBeforeCloseout ? isMissionRuntimeTerminal(runtimeBeforeCloseout) : false;
    try {
      const runtime = runtimeBeforeCloseout ?? this.dependencies.runtime.get(missionId);
      if (runtime?.activeTaskId) {
        await this.cancelTaskAndWait(runtime.activeTaskId);
      }
      const closed = await this.dependencies.concludeTerminalOutcome?.(missionId, input);
      const status = typeof (closed as { status?: unknown } | undefined)?.status === "string"
        ? (closed as { status: Parameters<typeof terminalDispositionForMission>[0] }).status
        : input.preserveStatus ?? "blocked";
      this.settleTerminalRuntime(missionId, status, input, fence);
    } catch (error) {
      // Integrity contradictions and a lost terminal lease must remain
      // visible to startup reconciliation; converting either into a blocked
      // result would weaken canonical completion/fencing invariants.
      if (error instanceof MissionRuntimeLeaseFenceError) throw error;
      if (error instanceof MissionError && error.code === "finalization_integrity_error") throw error;
      await this.handleControllerFailure(missionId, error, "closeout", fence);
      // A first failure is durable but still non-terminal, so callers must see
      // the rejection and can retry on the next startup. Once the bounded
      // handler has settled the runtime, returning is safe and idempotent.
      const latest = this.dependencies.runtime.get(missionId);
      if (runtimeWasTerminal || !latest || !isMissionRuntimeTerminal(latest)) throw error;
    } finally {
      // A terminal-recovery lease is still a normal runtime lease. Release it
      // after both success and a classified failure so a retry does not wait
      // for the lease timeout (and so another claimant cannot be fenced out by
      // a process that already returned an error).
      if (fence) {
        this.dependencies.runtime.releaseLease({ missionId, fence, now: this.now() });
      }
    }
  }

  private async drive(missionId: string): Promise<void> {
    const claimedAt = this.now();
    let fence: MissionRuntimeLeaseFence | null = null;
    try {
      fence = this.dependencies.runtime.claimLease({
        missionId,
        ownerId: this.dependencies.ownerId,
        now: claimedAt,
        expiresAt: this.expiresAt(claimedAt),
      });
    } catch (error) {
      if (error instanceof MissionRuntimeLeaseFenceError) return;
      await this.handleControllerFailure(missionId, error, "drive");
      return;
    }
    if (!fence) return;

    let leaseHeld = true;
    try {
      while (!this.cancelled.has(missionId)) {
        const runtimeBeforeTick = this.dependencies.runtime.get(missionId);
        const priorControllerFailure = typeof this.dependencies.runtime.listRecoveryDecisions === "function"
          ? this.dependencies.runtime.listRecoveryDecisions(missionId)
            .filter((decision) => decision.failedStrategyFingerprint?.startsWith(`${CONTROLLER_FAILURE_STRATEGY_PREFIX}:`))
            .at(-1)
          : undefined;
        if (priorControllerFailure?.exhausted) {
          this.settleTerminalRuntime(missionId, "blocked", {
            kind: "controller_exhausted",
            reason: priorControllerFailure.diagnosis,
            preserveStatus: "blocked",
          }, fence);
          return;
        }
        const stateBeforeTick = runtimeBeforeTick?.state;
        const operationSequenceBeforeTick = runtimeBeforeTick?.operationSequence;
        const activeTaskIdBeforeTick = runtimeBeforeTick?.activeTaskId;
        let result: ControllerTickResult;
        try {
          result = await this.dependencies.controller.tick(missionId, fence);
        } catch (error) {
          if (error instanceof MissionRuntimeLeaseFenceError) return;
          await this.handleControllerFailure(
            missionId,
            error,
            stateBeforeTick === "planning" ? "prepare" : "tick",
            fence,
            operationSequenceBeforeTick,
            activeTaskIdBeforeTick,
          );
          return;
        }
        if (result.terminalOutcome) {
          try {
            await this.coordinateTerminalOutcome(missionId, result.terminalOutcome, fence);
          } catch (error) {
            if (error instanceof MissionRuntimeLeaseFenceError) return;
            await this.handleControllerFailure(missionId, error, "closeout", fence);
          }
          return;
        }
        if (!result.immediate) {
          const taskId = result.runtime.activeTaskId;
          let taskActive = false;
          if (result.waitingForExternal && taskId) {
            try {
              taskActive = this.dependencies.taskRunner.isActive(taskId);
            } catch (error) {
              if (error instanceof MissionRuntimeLeaseFenceError) return;
              await this.handleControllerFailure(missionId, error, "drive", fence);
              return;
            }
          }
          this.dependencies.runtime.releaseLease({ missionId, fence, now: this.now() });
          leaseHeld = false;
          if (taskActive && taskId) {
            const detached = this.dependencies.taskRunner.waitFor(taskId)
              .then(() => {
                if (!this.cancelled.has(missionId)) this.wake(missionId);
              })
              .then(undefined, async (error: unknown) => {
                if (error instanceof MissionRuntimeLeaseFenceError) return;
                await this.handleReleasedLeaseFailure(missionId, error);
              });
            const entry = { promise: detached, waiters: 0 };
            this.detachedPromises.set(missionId, entry);
            void detached.then(
              () => {
                if (entry.waiters === 0 && this.detachedPromises.get(missionId) === entry) {
                  this.detachedPromises.delete(missionId);
                }
              },
              () => {
                if (entry.waiters === 0 && this.detachedPromises.get(missionId) === entry) {
                  this.detachedPromises.delete(missionId);
                }
              },
            );
          }
          return;
        }
        const renewedAt = this.now();
        const renewed = this.dependencies.runtime.renewLease({
          missionId,
          fence,
          now: renewedAt,
          expiresAt: this.expiresAt(renewedAt),
        });
        if (!renewed) throw new MissionRuntimeLeaseFenceError();
        await Promise.resolve();
      }
    } catch (error) {
      if (error instanceof MissionRuntimeLeaseFenceError) return;
      await this.handleControllerFailure(missionId, error, "drive", fence);
    } finally {
      if (leaseHeld) {
        try {
          this.dependencies.runtime.releaseLease({ missionId, fence, now: this.now() });
        } catch (error) {
          if (!(error instanceof MissionRuntimeLeaseFenceError)) {
            await this.handleControllerFailure(missionId, error, "drive", fence);
          }
        }
      }
    }
  }

  /** Convert an arbitrary escaped controller error into durable recovery. */
  private async handleControllerFailure(
    missionId: string,
    error: unknown,
    phase: ControllerFailurePhase,
    fence?: MissionRuntimeLeaseFence,
    operationSequenceBeforeTick?: number,
    activeTaskIdBeforeTick?: string | null,
  ): Promise<void> {
    if (this.cancelled.has(missionId)) return;

    const message = error instanceof Error ? error.message : String(error);
    const strategyFingerprint = `${CONTROLLER_FAILURE_STRATEGY_PREFIX}:${phase}`;
    let runtime: MissionRuntime | null;
    let decisions: ReturnType<MissionRuntimeRepository["listRecoveryDecisions"]>;
    try {
      runtime = this.dependencies.runtime.get(missionId);
      if (!runtime || isMissionRuntimeTerminal(runtime)) return;
      decisions = typeof this.dependencies.runtime.listRecoveryDecisions === "function"
        ? this.dependencies.runtime.listRecoveryDecisions(missionId)
          .filter((decision) => decision.failedStrategyFingerprint?.startsWith(`${CONTROLLER_FAILURE_STRATEGY_PREFIX}:`))
        : [];
    } catch (persistenceError) {
      // There is no safe state transition if the runtime itself cannot be
      // read. Preserve the original failure and make the process-level catch
      // visible rather than pretending recovery was recorded.
      console.error(`Mission controller failure could not be classified for ${missionId}:`, persistenceError);
      throw persistenceError;
    }

    // A controller tick can persist a worker dispatch and then fail while
    // recording the active task. Re-entering through recovery would advance
    // the transition sequence and issue a second dispatch key. Reconcile the
    // operation created by this tick before deciding whether a retry is safe.
    let dispatchEffect: DispatchEffect = { kind: "none" };
    if (phase === "tick" && operationSequenceBeforeTick !== undefined) {
      try {
        const dispatches = this.dependencies.runtime.listOperations(missionId)
          .filter((operation) => operation.kind === "dispatch_worker" && operation.sequence > operationSequenceBeforeTick);
        const dispatch = dispatches.at(-1);
        if (dispatch) {
          const taskId = typeof dispatch.result?.taskId === "string" ? dispatch.result.taskId : null;
          dispatchEffect = dispatch.status === "completed" && taskId
            ? { kind: "completed", taskId }
            : dispatch.status === "failed" || dispatch.status === "cancelled"
              ? { kind: "none" }
              : { kind: "unknown", operationId: dispatch.id };
        }
      } catch (inspectionError) {
        // If the operation ledger cannot be inspected, no retry can prove that
        // dispatch did not happen. Surface the persistence fault instead of
        // manufacturing a recovery decision from missing evidence.
        console.error(`Mission controller dispatch effect could not be inspected for ${missionId}:`, inspectionError);
        throw inspectionError;
      }
    }

    const attempt = decisions.length + 1;
    const exhausted = dispatchEffect.kind === "unknown" || attempt >= MAX_CONTROLLER_FAILURE_ATTEMPTS;
    const decisionId = `${strategyFingerprint}:${missionId}:attempt:${attempt}`;
    const operationIdempotencyKey = `operation:${decisionId}`;
    let operationId: string | null = null;

    try {
      // A lease is required for operation state transitions. A drive failure
      // before claimLease therefore still gets a recovery decision, but does
      // not manufacture an unfenced operation row.
      if (fence) {
        if (dispatchEffect.kind === "unknown" && dispatchEffect.operationId !== "unavailable") {
          try {
            const dispatchOperation = this.dependencies.runtime.listOperations(missionId)
              .find((operation) => operation.id === dispatchEffect.operationId);
            if (dispatchOperation?.status === "pending" || dispatchOperation?.status === "running") {
              if (dispatchOperation.status === "pending") {
                this.dependencies.runtime.startOperation({
                  missionId,
                  operationId: dispatchOperation.id,
                  fence,
                  now: this.now(),
                });
              }
              this.dependencies.runtime.failOperation({
                missionId,
                operationId: dispatchOperation.id,
                fence,
                result: { phase, message: message.slice(0, 2_000) },
                unknownEffect: true,
                now: this.now(),
              });
            }
          } catch (dispatchPersistenceError) {
            if (dispatchPersistenceError instanceof MissionRuntimeLeaseFenceError) return;
            console.error(`Mission controller dispatch effect could not be marked unknown for ${missionId}:`, dispatchPersistenceError);
            throw dispatchPersistenceError;
          }
        }
        const operation = this.dependencies.runtime.enqueueOperation({
          missionId,
          idempotencyKey: operationIdempotencyKey,
          kind: "recover",
          strategyFingerprint,
          input: { phase },
          fence,
          now: this.now(),
        });
        operationId = operation.id;
        if (operation.status === "pending" || operation.status === "failed") {
          const started = operation.status === "pending"
            ? this.dependencies.runtime.startOperation({ missionId, operationId: operation.id, fence, now: this.now() })
            : operation;
          if (started.status === "running") {
            this.dependencies.runtime.failOperation({
              missionId,
              operationId: operation.id,
              fence,
              result: { phase, message: message.slice(0, 2_000) },
              unknownEffect: phase === "closeout",
              now: this.now(),
            });
          }
        }
      }

      if (!decisions.some((decision) => decision.id === decisionId)) {
        this.dependencies.runtime.recordRecovery({
          id: decisionId,
          missionId,
          operationId,
          category: phase === "closeout" || dispatchEffect.kind === "unknown" ? "unknown_effect" : "process_interruption",
          diagnosis: `Mission controller ${phase} failed: ${message}`.slice(0, 2_000),
          failedStrategyFingerprint: strategyFingerprint,
          nextStrategyFingerprint: exhausted ? null : strategyFingerprint,
          action: exhausted ? "block_precisely" : "await_retry_condition",
          retryCondition: exhausted ? null : "The fenced controller retries this phase once after the failure is recorded.",
          exhausted,
          ...(fence ? { fence } : {}),
          now: this.now(),
        });
      }
    } catch (persistenceError) {
      if (persistenceError instanceof MissionRuntimeLeaseFenceError) return;
      console.error(`Mission controller failure could not be persisted for ${missionId}:`, persistenceError);
      throw persistenceError;
    }

    const latest = this.dependencies.runtime.get(missionId);
    if (!latest || isMissionRuntimeTerminal(latest)) return;

    if (!exhausted) {
      if (phase === "tick" && (dispatchEffect.kind === "completed" || activeTaskIdBeforeTick)) {
        const current = this.dependencies.runtime.get(missionId);
        if (dispatchEffect.kind === "completed" && current && !current.activeTaskId && fence) {
          try {
            this.dependencies.runtime.setActiveTask({
              missionId,
              taskId: dispatchEffect.taskId,
              fence,
              now: this.now(),
            });
          } catch (reconciliationError) {
            if (reconciliationError instanceof MissionRuntimeLeaseFenceError) return;
            console.error(`Mission controller completed dispatch could not be reconciled for ${missionId}:`, reconciliationError);
            throw reconciliationError;
          }
        }
        this.queueRetry(missionId);
        return;
      }
      // Close-out and preparation must be retried while the controller is
      // still on the same phase. Moving either through `replanning` would
      // dispatch a new worker (or skip preparation) and could turn an
      // uncertain/failed boundary into duplicate or unprepared work.
      // A callback that runs after the lease was released must not mutate the
      // runtime without a fresh fence; queueing a wake lets the next driver
      // acquire one before choosing the recovery transition.
      const preserveRecoveryPhase = latest.state === "orienting" || latest.state === "waiting_for_approval";
      if (fence && !preserveRecoveryPhase && phase !== "closeout" && phase !== "prepare" && latest.state !== "recovering") {
        try {
          this.dependencies.runtime.transition({
            missionId,
            from: latest.state,
            to: "recovering",
            cause: "controller_failure_recovery",
            actor: "controller",
            details: { phase, message: message.slice(0, 2_000), attempt },
            ...(fence ? { fence } : {}),
            now: this.now(),
          });
        } catch (transitionError) {
          if (transitionError instanceof MissionRuntimeLeaseFenceError) return;
          console.error(`Mission controller retry could not be staged for ${missionId}:`, transitionError);
          throw transitionError;
        }
      }
      this.queueRetry(missionId);
      return;
    }

    // Exhaustion is terminal for the controller. Try to close the mission
    // aggregate through its existing terminal-outcome service, but always
    // settle the fenced runtime even if close-out itself is unavailable.
    let status: Parameters<typeof terminalDispositionForMission>[0] = "blocked";
    if (phase === "closeout" && this.dependencies.getMissionStatus) {
      try {
        const authoritativeStatus = this.dependencies.getMissionStatus(missionId);
        if (authoritativeStatus) status = authoritativeStatus;
      } catch (statusError) {
        console.error(`Mission controller could not read authoritative mission status for ${missionId}:`, statusError);
        throw statusError;
      }
    }
    if (fence && phase !== "closeout" && this.dependencies.concludeTerminalOutcome) {
      try {
        await this.dependencies.concludeTerminalOutcome(missionId, {
          kind: "controller_exhausted",
          reason: `Mission controller ${phase} failed twice: ${message}`.slice(0, 2_000),
          preserveStatus: "blocked",
        });
      } catch (closeoutError) {
        console.error(`Mission controller exhaustion close-out failed for ${missionId}:`, closeoutError);
      }
    }
    try {
      if (fence) {
        this.settleTerminalRuntime(missionId, status, {
          kind: "controller_exhausted",
          reason: `Mission controller ${phase} failed twice: ${message}`.slice(0, 2_000),
          preserveStatus: phase === "closeout" ? status : "blocked",
        }, fence);
      } else {
        // No lease means no runtime mutation. The exhausted recovery row is
        // the durable health signal; a later driver/startup pass can claim a
        // fresh fence and settle the terminal disposition safely.
        console.error(`Mission controller exhaustion awaits a fresh lease for ${missionId}`);
      }
    } catch (settlementError) {
      if (!(settlementError instanceof MissionRuntimeLeaseFenceError)) {
        console.error(`Mission controller exhaustion could not settle runtime for ${missionId}:`, settlementError);
        throw settlementError;
      }
    }
  }

  /** Reclaim ownership before classifying an asynchronous post-lease fault. */
  private async handleReleasedLeaseFailure(missionId: string, error: unknown): Promise<void> {
    let fence: MissionRuntimeLeaseFence | null = null;
    try {
      const claimedAt = this.now();
      fence = this.dependencies.runtime.claimLease({
        missionId,
        ownerId: this.dependencies.ownerId,
        now: claimedAt,
        expiresAt: this.expiresAt(claimedAt),
      });
    } catch (claimError) {
      if (claimError instanceof MissionRuntimeLeaseFenceError) return;
      await this.handleControllerFailure(missionId, claimError, "drive");
      return;
    }
    if (!fence) {
      await this.handleControllerFailure(missionId, error, "drive");
      return;
    }
    try {
      await this.handleControllerFailure(missionId, error, "drive", fence);
    } finally {
      this.dependencies.runtime.releaseLease({ missionId, fence, now: this.now() });
    }
  }

  private queueRetry(missionId: string): void {
    if (this.cancelled.has(missionId)) return;
    if (this.activePromises.has(missionId)) {
      this.pendingWakes.add(missionId);
    } else {
      this.run(missionId);
    }
  }

  private async coordinateTerminalOutcome(
    missionId: string,
    input: MissionTerminalOutcomeInput,
    fence: MissionRuntimeLeaseFence,
  ): Promise<void> {
    const runtime = this.dependencies.runtime.get(missionId);
    const activeTaskId = runtime?.activeTaskId;
    if (activeTaskId) {
      await this.cancelTaskAndWait(activeTaskId);
    }

    const closed = await this.dependencies.concludeTerminalOutcome?.(missionId, input);
    const status = typeof (closed as { status?: unknown } | undefined)?.status === "string"
      ? (closed as { status: Parameters<typeof terminalDispositionForMission>[0] }).status
      : input.preserveStatus ?? "blocked";
    this.settleTerminalRuntime(missionId, status, input, fence);
  }

  private settleTerminalRuntime(
    missionId: string,
    status: Parameters<typeof terminalDispositionForMission>[0],
    input: MissionTerminalOutcomeInput,
    fence?: MissionRuntimeLeaseFence,
  ): void {
    const to = terminalDispositionForMission(status);
    const latest = this.dependencies.runtime.get(missionId);
    if (!latest) throw new MissionError(`Mission runtime missing for ${missionId}`, "finalization_integrity_error");
    if (isMissionRuntimeTerminal(latest)) {
      if (latest.state !== to) {
        throw new MissionError(
          `Terminal mission/runtime contradiction for ${missionId}`,
          "finalization_integrity_error",
        );
      }
      return;
    }
    if (!fence) {
      throw new MissionError(
        `Non-terminal runtime cannot be reconciled without a controller lease for ${missionId}`,
        "finalization_integrity_error",
      );
    }
    this.dependencies.runtime.transition({
      missionId,
      from: latest.state,
      to,
      cause: to === "completed" ? "guardian_passed" : `terminal_outcome:${input.kind}`,
      actor: "controller",
      details: { reason: input.reason },
      fence,
      now: this.now(),
    });
  }

  private expiresAt(now: string): string {
    return new Date(Date.parse(now) + this.leaseMs).toISOString();
  }

  private async cancelTaskAndWait(taskId: string): Promise<void> {
    if (this.dependencies.taskRunner.cancelAndWait) {
      await this.dependencies.taskRunner.cancelAndWait(taskId, "mission_terminal");
      return;
    }
    this.dependencies.taskRunner.cancel?.(taskId, "mission_terminal");
    await this.dependencies.taskRunner.waitFor(taskId);
  }
}

export function isMissionRuntimeTerminal(runtime: MissionRuntime): boolean {
  return ["blocked", "completed", "cancelled", "abandoned", "superseded"].includes(runtime.state);
}

/** Compose the production controller from the existing local repositories. */
export function createDefaultMissionControllerRunner(
  dependencies: DefaultMissionControllerRunnerDependencies,
): MissionControllerRunner {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const runtime = missionRuntimeRepository(dependencies.db);
  const missions = missionsRepository(dependencies.db);
  const projects = projectRepository(dependencies.db);
  const conversations = conversationsRepository(dependencies.db);
  const approvals = approvalsRepository(dependencies.db);
  const memory = memoryRepository(dependencies.db);
  const cortex = new CortexService({
    repo: intelligenceRepository(dependencies.db),
    getWorkspacePath: (projectId) => projects.getProjectById(projectId)?.workspacePath,
    now,
    memory: new AutomaticMemoryService(memory, now),
    skills: new AutomaticSkillService({
      repo: learnedSkillsRepository(dependencies.db),
      rootForProject: (projectId) => join(resolveMorrowHome(env), "projects", projectId, "skills"),
      now,
    }),
  });
  const missionService = new MissionService({
    repo: missions,
    getWorkspacePath: (projectId) => projects.getProjectById(projectId)?.workspacePath,
    completion: dependencies.completion ?? buildMissionCompletion({ env }),
    backupDir: join(resolveMorrowHome(env), "mission-checkpoints"),
    now,
    cortex,
    countCompletedTasks: (missionId) =>
      (dependencies.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE mission_id = ? AND status = 'completed'").get(missionId) as { n: number } | undefined)?.n ?? 0,

    runOptions: {
      // Browser gates render the mission's own service, so the policy is opened
      // exactly as far as loopback and no further. `isLoopbackUrl` in the
      // evidence runner rejects anything else before we get here.
      browser: () => playwrightController({
        headless: true,
        allowPrivateNetwork: true,
        allowedDomains: ["localhost", "127.0.0.1"],
        ...(resolvePlaywrightChannel(undefined, env) ? { browser: resolvePlaywrightChannel(undefined, env)! } : {}),
      }),
    },
  });
  const controller = new MissionController({
    runtime,
    deferTerminalOutcomes: true,
    loadSnapshot: (missionId) => {
      const mission = missionService.get(missionId);
      const guardianDependencies = missions.guardianDependencies(missionId);
      const priorRecoveries = runtime.listRecoveryDecisions(missionId);
      const latestRecovery = priorRecoveries.at(-1) ?? null;
      const activeTaskId = runtime.get(missionId)?.activeTaskId ?? null;
      const activeTask = activeTaskId
        ? guardianDependencies.tasks.find((task) => task.id === activeTaskId)
        : undefined;
      const missionEvents = missions.listEvents(missionId);
      let terminalOutcomeKind: TerminalEntryKind | undefined;
      let terminalOutcomeReason: string | undefined;
      let recovery: ControllerRecovery | null = latestRecovery ? {
        category: latestRecovery.category,
        diagnosis: latestRecovery.diagnosis,
        failedStrategyFingerprint: latestRecovery.failedStrategyFingerprint,
        nextStrategyFingerprint: latestRecovery.nextStrategyFingerprint,
        action: latestRecovery.action,
        retryCondition: latestRecovery.retryCondition,
        exhausted: latestRecovery.exhausted,
      } : null;
      if (mission.status === "cancelled" && missionEvents.some((event) => event.type === "mission.cancelled")) {
        terminalOutcomeKind = "user_cancel";
        terminalOutcomeReason = "Mission cancelled by user.";
      }
      if (mission.status !== "cancelled") {
        const latestLoop = [...missionEvents].reverse().find((event) => event.type === "mission.loop_detected");
        const loopKind = latestLoop?.data.terminalEntryKind;
        if (typeof loopKind === "string" && TERMINAL_ENTRY_KINDS.includes(loopKind as TerminalEntryKind)) {
          terminalOutcomeKind = loopKind as TerminalEntryKind;
          terminalOutcomeReason = latestLoop?.summary;
        }
      }
      if (activeTask && (activeTask.status === "failed" || activeTask.status === "interrupted")) {
        const terminal = dependencies.db.prepare(`SELECT payload_json AS payloadJson
          FROM task_events
          WHERE task_id=? AND type IN ('task.failed','task.interrupted')
          ORDER BY sequence DESC LIMIT 1`).get(activeTask.id) as { payloadJson: string } | undefined;
        const payload = terminal ? JSON.parse(terminal.payloadJson) as Record<string, unknown> : {};
        if (typeof payload.terminalEntryKind === "string" && TERMINAL_ENTRY_KINDS.includes(payload.terminalEntryKind as TerminalEntryKind)) {
          terminalOutcomeKind = payload.terminalEntryKind as TerminalEntryKind;
          terminalOutcomeReason = typeof payload.message === "string" ? payload.message : undefined;
        }
        const route = dependencies.db.prepare("SELECT provider_id AS providerId FROM task_routing WHERE task_id=?")
          .get(activeTask.id) as { providerId: string } | undefined;
        const allowProviderSwitch = mission.execution.providerId === null;
        const alternateProviders = allowProviderSwitch
          ? listProviderStatuses(env)
            .filter((provider) => provider.configured && provider.id !== route?.providerId && provider.id !== "mock")
            .length
          : 0;
        recovery = decideWorkerRecovery({
          taskId: activeTask.id,
          status: activeTask.status,
          reason: typeof payload.reason === "string" ? payload.reason : null,
          message: typeof payload.message === "string" ? payload.message : `Worker ended ${activeTask.status}.`,
          provider: payload.provider && typeof payload.provider === "object"
            ? payload.provider as ProviderFailureDetails
            : null,
          priorDecisions: priorRecoveries,
          alternateProviders,
          allowProviderSwitch,
          allowModelSwitch: mission.execution.model === null,
        });
      }
      return {
        missionStatus: mission.status,
        terminalOutcomeRecorded: missionEvents.some((event) => event.type === "mission.terminal_outcome_recorded"),
        ...(terminalOutcomeKind ? { terminalOutcomeKind } : {}),
        ...(terminalOutcomeReason ? { terminalOutcomeReason } : {}),
        tasks: guardianDependencies.tasks,
        approvals: guardianDependencies.approvals.map((approval) => ({ ...approval, autoResolvable: false })),
        guardianDecision: missionService.assessGuardian(missionId),
        recovery: recovery ? {
          category: recovery.category,
          diagnosis: recovery.diagnosis,
          failedStrategyFingerprint: recovery.failedStrategyFingerprint,
          nextStrategyFingerprint: recovery.nextStrategyFingerprint,
          action: recovery.action,
          retryCondition: recovery.retryCondition,
          exhausted: recovery.exhausted,
        } : null,
      };
    },
    prepareMission: async (missionId) => {
      // Generate the mission's success criteria before the first worker runs.
      // `generateCriteria` is deliberately resilient: with no configured model
      // it falls back to deterministic heuristic criteria, so planning never
      // hard-depends on a provider. Auto-approve missions move straight to
      // `running`; the rest wait for the human plan approval.
      // Exceptions are intentionally allowed to reach MissionControllerRunner,
      // which records a durable preparation failure and applies its bounded
      // retry/blocked policy. Returning `awaitingApproval: false` after an
      // exception would falsely report a successful plan and start execution.
      const mission = await missionService.generateCriteria(missionId, "");
      return { awaitingApproval: mission.status === "awaiting_criteria_approval" };
    },
    recordDispatchFailure: (missionId, message) => {
      missions.appendEvent(
        missionId,
        "mission.failure_recorded",
        `Could not start the work: ${message}`.slice(0, 1_000),
        { kind: "dispatch", message: message.slice(0, 2_000) },
        now(),
      );
    },
    dispatchWorker: ({ missionId, idempotencyKey }) => {
      const mission = missionService.get(missionId);
      const conversationId = mission.conversationId ?? `mission-controller-${missionId}`;
      if (!conversations.getConversation(conversationId)) {
        conversations.createConversation({
          id: conversationId,
          projectId: mission.projectId,
          title: `Mission: ${mission.objective.slice(0, 120)}`,
          createdAt: now(),
          updatedAt: now(),
        });
      }
      let providerId = mission.execution.providerId;
      let model = mission.execution.model;
      const latestRecovery = runtime.listRecoveryDecisions(missionId).at(-1) ?? null;
      if (latestRecovery?.action === "switch_provider" && mission.execution.providerId === null) {
        const failedRoute = dependencies.db.prepare(`SELECT routing.provider_id AS providerId
          FROM task_routing AS routing
          JOIN tasks AS task ON task.id=routing.task_id
          WHERE task.mission_id=?
          ORDER BY task.created_at DESC,task.id DESC LIMIT 1`).get(missionId) as { providerId: string } | undefined;
        const alternate = listProviderStatuses(env)
          .find((provider) => provider.configured && provider.id !== failedRoute?.providerId && provider.id !== "mock");
        if (alternate) {
          providerId = alternate.id;
          model = null;
        }
      } else if (latestRecovery?.action === "switch_model" && mission.execution.model === null) {
        model = null;
      }
      const result = dispatchAgentTask({ db: dependencies.db, runner: dependencies.taskRunner, env }, {
        conversationId,
        missionId,
        idempotencyKey,
        content: [
          `Continue the durable mission: ${mission.objective}`,
          "Use the persisted mission contract, requirements, evidence, and checkpoints as authoritative state.",
          "Return a candidate result to the Guardian; do not declare the mission complete yourself.",
        ].join("\n\n"),
        mode: "agent",
        autoApprove: mission.autoApprove,
        preset: mission.execution.preset,
        ...(providerId ? { providerId } : {}),
        ...(model ? { model } : {}),
        reasoning: mission.execution.reasoning,
      });
      return { taskId: result.task.id };
    },
    finalizeMission: (missionId) => missionService.finalize(missionId),
    validateMission: (missionId) => missionService.verifyAll(missionId),
    reviewMission: (missionId) => missionService.runReview(missionId),
    resolveApproval: (approvalId) => approvals.resolve(approvalId, {
      decision: "allow_once",
      note: "Applied an approval already authorized by mission policy.",
      resolvedAt: now(),
    }),
    now,
  });
  const controllerRunner = new MissionControllerRunner({
    runtime,
    controller,
    taskRunner: dependencies.taskRunner,
    concludeTerminalOutcome: (missionId, input) => missionService.concludeTerminalOutcome(missionId, input),
    getMissionStatus: (missionId) => missionService.get(missionId).status,
    ownerId: dependencies.ownerId ?? `mission-controller:${process.pid}:${randomUUID()}`,
    now,
    ...(dependencies.leaseMs === undefined ? {} : { leaseMs: dependencies.leaseMs }),
  });
  dependencies.taskRunner.onSettled?.((taskId) => {
    const task = dependencies.db.prepare("SELECT mission_id AS missionId FROM tasks WHERE id=?")
      .get(taskId) as { missionId: string | null } | undefined;
    if (task?.missionId) controllerRunner.wake(task.missionId);
  });
  return controllerRunner;
}
