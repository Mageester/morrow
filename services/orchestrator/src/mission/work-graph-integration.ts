import type Database from "better-sqlite3";
import { redactSecrets } from "../provider/credentials.js";
import { createExecutionLeaseOwnerId } from "../repositories/execution-continuity.js";
import { taskRepository } from "../repositories/tasks.js";
import { workGraphsRepository, type WorkGraph, type WorkUnit } from "../repositories/work-graphs.js";
import {
  createWorkGraphTaskAdapter,
  type WorkGraphTaskAdapter,
  type WorkGraphTaskRunner,
} from "./work-graph-task-adapter.js";
import type { Synthesize } from "./work-graph-orchestrator.js";

/** Durable outcome of one reconciliation pass over a parent-owned graph. */
export interface WorkGraphReconciliation {
  graphId: string;
  parentTaskId: string;
  missionId: string | null;
  /** Fan-in state after the pass, read back from durable state. */
  fanInState: WorkGraph["fanInState"];
  synthesis: "pending" | "blocked" | "completed" | "claimed";
  /** True only when this pass is the one that durably completed synthesis. */
  synthesizedNow: boolean;
  reasons: string[];
  units: WorkUnit[];
}

export interface WorkGraphIntegrationDependencies {
  db: Database.Database;
  runner: WorkGraphTaskRunner;
  now?: () => string;
  /** Provider routing environment handed to the child dispatcher. */
  env?: NodeJS.ProcessEnv;
  /** Stable identity for durable start and synthesis claims. */
  ownerId?: string;
  /**
   * Controller integration seam. A graph transition is durable before this is
   * called, so a missed wake costs latency, never correctness: startup
   * reconciliation replays the same state.
   */
  wakeMission?: (missionId: string) => void;
  synthesize?: Synthesize;
  /** Diagnostics sink; defaults to console.error. */
  onError?: (error: unknown, context: { graphId?: string; childTaskId?: string }) => void;
}

function clean(value: unknown): string {
  return redactSecrets(typeof value === "string" ? value : String(value ?? "")).trim();
}

/**
 * The production seam between durable work graphs and the running
 * orchestrator: startup reconciliation, child settlement, restart/resume,
 * authoritative terminal import, and once-only fan-in synthesis.
 *
 * Every pass is driven from durable state alone. Nothing here holds work in
 * memory across a restart, so an interrupted process resumes by reading the
 * same rows rather than by replaying an in-process queue.
 */
export class WorkGraphIntegration {
  readonly adapter: WorkGraphTaskAdapter;
  private readonly db: Database.Database;
  private readonly graphs: ReturnType<typeof workGraphsRepository>;
  private readonly tasks: ReturnType<typeof taskRepository>;
  private readonly ownerId: string;
  private readonly wakeMission: ((missionId: string) => void) | undefined;
  private readonly onError: (error: unknown, context: { graphId?: string; childTaskId?: string }) => void;
  private readonly unsubscribeSettled: (() => void) | undefined;
  // One reconciliation per graph at a time. Durable claims already make
  // concurrent passes safe; serializing keeps them from doing redundant work
  // and from racing two dispatch scans of the same ready set.
  private readonly inFlight = new Map<string, Promise<WorkGraphReconciliation>>();
  private readonly detached = new Set<Promise<unknown>>();

  constructor(dependencies: WorkGraphIntegrationDependencies) {
    this.db = dependencies.db;
    this.graphs = workGraphsRepository(dependencies.db);
    this.tasks = taskRepository(dependencies.db);
    this.ownerId = clean(dependencies.ownerId) || createExecutionLeaseOwnerId();
    this.wakeMission = dependencies.wakeMission;
    this.onError = dependencies.onError
      ?? ((error, context) => console.error("Work graph reconciliation failed", context, error));
    this.adapter = createWorkGraphTaskAdapter({
      db: dependencies.db,
      runner: dependencies.runner,
      startClaimOwnerId: this.ownerId,
      ...(dependencies.env !== undefined ? { env: dependencies.env } : {}),
      ...(dependencies.now !== undefined ? { now: dependencies.now } : {}),
      ...(dependencies.synthesize !== undefined ? { synthesize: dependencies.synthesize } : {}),
    });
    // A child settles inside the runner's own callback. Reconciliation is
    // asynchronous, so it is tracked rather than awaited there; `settled()`
    // exposes that tracking to callers that need a quiescent point.
    this.unsubscribeSettled = dependencies.runner.onSettled?.((taskId) => {
      this.track(this.reconcileChild(taskId));
    });
  }

  get orchestrator(): WorkGraphTaskAdapter["orchestrator"] {
    return this.adapter.orchestrator;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => { this.detached.delete(tracked); });
    this.detached.add(tracked);
    void tracked.catch(() => { /* already reported through onError */ });
    return promise;
  }

  /** Await every reconciliation this integration currently has in flight. */
  async settled(): Promise<void> {
    while (this.detached.size > 0) {
      await Promise.allSettled([...this.detached]);
    }
  }

  /**
   * Replay every graph whose fan-in has not completed. Called once at startup:
   * a graph interrupted between spawn and attachment, between a child's
   * terminal write and its import, or between fan-in readiness and synthesis
   * is carried forward from durable state.
   */
  async reconcileStartup(): Promise<WorkGraphReconciliation[]> {
    const results: WorkGraphReconciliation[] = [];
    for (const graph of this.graphs.listUnsettled()) {
      try {
        results.push(await this.reconcileGraph(graph.id));
      } catch (error) {
        this.onError(error, { graphId: graph.id });
      }
    }
    return results;
  }

  /**
   * Reconcile the graph that owns a settled child. Returns null when the task
   * is not a graph child, which is the common case for ordinary subagents.
   */
  async reconcileChild(childTaskId: string): Promise<WorkGraphReconciliation | null> {
    const normalized = clean(childTaskId);
    if (!normalized) return null;
    let graph: WorkGraph | undefined;
    try {
      graph = this.graphs.getByChildTask(normalized);
    } catch (error) {
      this.onError(error, { childTaskId: normalized });
      return null;
    }
    if (!graph) return null;
    try {
      return await this.reconcileGraph(graph.id);
    } catch (error) {
      this.onError(error, { graphId: graph.id, childTaskId: normalized });
      return null;
    }
  }

  /** Resume, import, and (once ready) synthesize one graph. */
  reconcileGraph(graphId: string): Promise<WorkGraphReconciliation> {
    const normalized = clean(graphId);
    const previous = this.inFlight.get(normalized);
    // Chain onto an in-flight pass instead of joining it: a caller arriving
    // mid-pass must still observe state written after its own trigger.
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.reconcileGraphOnce(normalized));
    const guarded = next.finally(() => {
      if (this.inFlight.get(normalized) === guarded) this.inFlight.delete(normalized);
    });
    this.inFlight.set(normalized, guarded);
    return guarded;
  }

  private async reconcileGraphOnce(graphId: string): Promise<WorkGraphReconciliation> {
    const before = this.graphs.get(graphId);
    if (!before) throw new Error(`Work graph not found: ${graphId}`);
    const wasCompleted = before.fanInState === "completed";

    // Restart-safe: dispatches admitted-but-unspawned units, imports every
    // attached child's authoritative terminal result, and releases dependents.
    await this.orchestrator.resume(graphId);
    const outcome = await this.orchestrator.synthesize(graphId, { ownerId: this.ownerId });
    const after = this.graphs.get(graphId) ?? before;
    const synthesizedNow = !wasCompleted && after.fanInState === "completed";

    const parent = this.tasks.getTaskById(after.parentTaskId);
    const missionId = parent?.missionId ?? null;
    // The controller owns the mission-result flow. Waking it after a durable
    // graph transition lets it read the persisted aggregate; it is never told
    // the result directly.
    if (synthesizedNow && missionId && this.wakeMission) {
      try {
        this.wakeMission(missionId);
      } catch (error) {
        this.onError(error, { graphId });
      }
    }
    return {
      graphId,
      parentTaskId: after.parentTaskId,
      missionId,
      fanInState: after.fanInState,
      synthesis: outcome.state,
      synthesizedNow,
      reasons: outcome.reasons,
      units: this.graphs.listUnits(graphId),
    };
  }

  /** The durable aggregate for a parent task, or null before synthesis. */
  aggregateForParentTask(parentTaskId: string): unknown {
    const graph = this.graphs.getByParentTask(clean(parentTaskId));
    if (!graph || graph.fanInState !== "completed") return null;
    return graph.aggregateResult ?? null;
  }

  close(): void {
    this.unsubscribeSettled?.();
    this.adapter.close();
  }
}

export function createWorkGraphIntegration(
  dependencies: WorkGraphIntegrationDependencies,
): WorkGraphIntegration {
  return new WorkGraphIntegration(dependencies);
}
