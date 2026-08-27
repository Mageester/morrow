import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { redactSecrets } from "../provider/credentials.js";
import { agentsRepository } from "../repositories/agents.js";
import {
  createExecutionLeaseOwnerId,
  type ExecutionLeaseOwnerStatus,
} from "../repositories/execution-continuity.js";
import { taskRepository } from "../repositories/tasks.js";
import { taskStartClaimsRepository } from "../repositories/task-start-claims.js";
import {
  AgentTaskDispatchError,
  spawnAgentChatSubagent,
  type AgentTaskDispatcherDependencies,
} from "./task-dispatcher.js";
import {
  readAuthoritativeChildTask,
  WorkGraphOrchestrator,
  type ReadChild,
  type SpawnChildRequest,
  type SpawnChildResult,
  type Synthesize,
} from "./work-graph-orchestrator.js";
import { teammateProfileFingerprint } from "../tools/teammate-delegation.js";

/** The runner boundary needed to turn a deferred child into real work. */
export interface WorkGraphTaskRunOptions {
  recovered?: boolean;
}

export interface WorkGraphTaskRunner {
  run(taskId: string, options?: WorkGraphTaskRunOptions): unknown;
  /** Optional process-local duplicate guard (TaskRunner supplies this). */
  isActive?(taskId: string): boolean;
  /** Settlement observer used to terminalize the durable start fence. */
  onSettled?(listener: (taskId: string) => void): () => void;
}

export interface WorkGraphTaskAdapterDependencies {
  db: Database.Database;
  runner: WorkGraphTaskRunner;
  env?: NodeJS.ProcessEnv;
  createId?: () => string;
  now?: () => string;
  synthesize?: Synthesize;
  /** Stable identity for the durable child-start lease. */
  startClaimOwnerId?: string;
  startClaimLeaseMs?: number;
  startClaimCreateId?: () => string;
  /** Injectable for deterministic dead-owner takeover tests. */
  startClaimOwnerStatus?: (ownerId: string) => ExecutionLeaseOwnerStatus;
}

/** A deliberately narrow result: routing and provider details stay private. */
export interface WorkGraphChildDispatchResult {
  childTaskId: string;
  replayed: boolean;
}

export class WorkGraphTaskAdapterError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorkGraphTaskAdapterError";
  }
}

function clean(value: unknown): string {
  return redactSecrets(typeof value === "string" ? value : String(value ?? "")).trim();
}

function policyFingerprint(ownerId: string, ownerProfileHash: string): string {
  return `policy:${createHash("sha256")
    .update(JSON.stringify({ ownerId, ownerProfileHash }), "utf8")
    .digest("hex")}`;
}

function requestFingerprint(request: SpawnChildRequest, objective: string): string {
  return JSON.stringify({
    parentTaskId: request.parentTaskId,
    ownerId: request.ownerId,
    ownerProfileHash: request.ownerProfileHash,
    policyFingerprint: request.policyFingerprint,
    objective,
    role: request.role,
    dependencyIds: [...request.dependencyIds].sort(),
  });
}

function extractTaskId(result: SpawnChildResult): string {
  if (typeof result === "string") return clean(result);
  if (!result || typeof result !== "object") return "";
  const task = result.task;
  const taskId = task && typeof task === "object" ? task.id : undefined;
  return clean(result.childTaskId ?? result.taskId ?? result.id ?? taskId);
}

/**
 * Find a child created for a graph admission. The graph unit is part of this
 * query on purpose: a bare task idempotency key is not enough to prove that a
 * child belongs to this parent-owned graph.
 *
 * The overload returning a reader is convenient for WorkGraphOrchestrator;
 * the two-argument form is useful to recovery callers and tests.
 */
export function findChildByAdmissionId(db: Database.Database): (admissionId: string) => string | null;
export function findChildByAdmissionId(db: Database.Database, admissionId: string): string | null;
export function findChildByAdmissionId(
  db: Database.Database,
  admissionId?: string,
): ((admissionId: string) => string | null) | string | null {
  const lookup = (key: string): string | null => {
    const normalized = clean(key);
    if (!normalized) return null;
    const row = db.prepare(`
      SELECT child.id
      FROM work_graph_units AS unit
      JOIN tasks AS parent ON parent.id=unit.parent_task_id
      JOIN tasks AS child
        ON child.parent_task_id=parent.id
       AND child.project_id=parent.project_id
       AND child.idempotency_key=unit.admission_id
      WHERE unit.admission_id=?
      ORDER BY unit.created_at ASC, unit.id ASC, child.created_at ASC, child.id ASC
      LIMIT 1
    `).get(normalized) as { id?: unknown } | undefined;
    return typeof row?.id === "string" && row.id ? row.id : null;
  };
  return admissionId === undefined ? lookup : lookup(admissionId);
}

/** Production seam used by the adapter and exported for embedding hosts. */
export function authoritativeChildReader(db: Database.Database): ReadChild {
  return readAuthoritativeChildTask(db);
}

/**
 * Bridges a parent-owned work graph to the existing child-task dispatcher.
 * Graph code never receives provider routing or credential-bearing state: it
 * receives only the durable child task id and replay bit.
 */
export class WorkGraphTaskAdapter {
  readonly orchestrator: WorkGraphOrchestrator;
  readonly findChildByAdmissionId: (admissionId: string) => string | null;
  readonly readChild: ReadChild;

  private readonly db: Database.Database;
  private readonly runner: WorkGraphTaskRunner;
  private readonly dispatchDependencies: AgentTaskDispatcherDependencies;
  private readonly now: () => string;
  private readonly startClaimOwnerId: string;
  private readonly startClaimLeaseMs: number;
  private readonly startClaims: ReturnType<typeof taskStartClaimsRepository>;
  private readonly startedChildren = new Set<string>();
  private readonly unsubscribeSettled: (() => void) | undefined;
  private readonly inFlight = new Map<
    string,
    { fingerprint: string; promise: Promise<WorkGraphChildDispatchResult> }
  >();

  constructor(dependencies: WorkGraphTaskAdapterDependencies) {
    this.db = dependencies.db;
    this.runner = dependencies.runner;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.startClaimOwnerId = clean(dependencies.startClaimOwnerId ?? createExecutionLeaseOwnerId());
    if (!this.startClaimOwnerId) throw new WorkGraphTaskAdapterError("START_CLAIM_OWNER_REQUIRED", "A child-start claim owner is required");
    this.startClaimLeaseMs = dependencies.startClaimLeaseMs ?? 60_000;
    this.startClaims = taskStartClaimsRepository(dependencies.db, {
      ...(dependencies.startClaimCreateId !== undefined ? { createId: dependencies.startClaimCreateId } : {}),
      ...(dependencies.startClaimOwnerStatus !== undefined ? { ownerStatus: dependencies.startClaimOwnerStatus } : {}),
    });
    // The callback is commonly passed directly as a WorkGraph `spawnChild`
    // dependency by embedding hosts. Keep that use safe even when the method
    // is destructured from the adapter instance.
    this.dispatchChild = this.dispatchChild.bind(this);
    this.spawnChild = this.spawnChild.bind(this);
    this.dispatchDependencies = {
      db: dependencies.db,
      runner: dependencies.runner,
      ...(dependencies.env !== undefined ? { env: dependencies.env } : {}),
      ...(dependencies.createId !== undefined ? { createId: dependencies.createId } : {}),
    };
    this.findChildByAdmissionId = findChildByAdmissionId(dependencies.db);
    this.readChild = authoritativeChildReader(dependencies.db);
    // Settlement terminalizes the durable start fence. Without this a
    // long-lived child would keep an expired claim behind after finishing,
    // and a later owner could read a stale lease instead of the task's own
    // authoritative terminal status.
    this.unsubscribeSettled = dependencies.runner.onSettled?.((taskId) => {
      this.startedChildren.delete(taskId);
      this.startClaims.settle(taskId);
    });
    this.orchestrator = new WorkGraphOrchestrator({
      db: dependencies.db,
      spawnChild: (request) => this.dispatchChild(request),
      findChildByAdmissionId: this.findChildByAdmissionId,
      readChild: this.readChild,
      ...(dependencies.now !== undefined ? { now: dependencies.now } : {}),
      ...(dependencies.synthesize !== undefined ? { synthesize: dependencies.synthesize } : {}),
    });
  }

  /** Factory-style alias for callers that do not use `new`. */
  static create(dependencies: WorkGraphTaskAdapterDependencies): WorkGraphTaskAdapter {
    return new WorkGraphTaskAdapter(dependencies);
  }

  /**
   * Dispatch one graph child. Calls with the same admission id coalesce in
   * process, while SQLite idempotency makes the same operation safe after a
   * restart. The admission id—not the human unit key—is the task idempotency
   * key, so a retry can only replay the exact child bundle.
   */
  dispatchChild(request: SpawnChildRequest): Promise<WorkGraphChildDispatchResult> {
    const admissionId = clean(request.admissionId);
    if (!admissionId) {
      return Promise.reject(new WorkGraphTaskAdapterError("ADMISSION_ID_REQUIRED", "A work graph child admission id is required"));
    }
    const objective = clean(request.objective);
    if (!objective) {
      return Promise.reject(new WorkGraphTaskAdapterError("OBJECTIVE_REQUIRED", "A work graph child objective is required"));
    }
    const fingerprint = requestFingerprint(request, objective);
    const previous = this.inFlight.get(admissionId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return Promise.reject(new WorkGraphTaskAdapterError("IDEMPOTENCY_CONFLICT", "Admission id was reused for a different child"));
      }
      return previous.promise;
    }

    const promise = this.dispatchChildOnce(request, admissionId, objective);
    this.inFlight.set(admissionId, { fingerprint, promise });
    void promise.then(
      () => {
        if (this.inFlight.get(admissionId)?.promise === promise) this.inFlight.delete(admissionId);
      },
      () => {
        if (this.inFlight.get(admissionId)?.promise === promise) this.inFlight.delete(admissionId);
      },
    );
    return promise;
  }

  /** Alias matching the SpawnChild terminology used by the graph service. */
  spawnChild(request: SpawnChildRequest): Promise<WorkGraphChildDispatchResult> {
    return this.dispatchChild(request);
  }

  private async dispatchChildOnce(
    request: SpawnChildRequest,
    admissionId: string,
    objective: string,
  ): Promise<WorkGraphChildDispatchResult> {
    const parent = taskRepository(this.db).getTaskById(clean(request.parentTaskId));
    if (!parent) throw new WorkGraphTaskAdapterError("PARENT_NOT_FOUND", "Work graph parent task was not found");

    const agent = agentsRepository(this.db).get(clean(request.ownerId));
    if (!agent || agent.projectId !== parent.projectId) {
      throw new AgentTaskDispatchError(404, "Agent not found in this project", "NOT_FOUND");
    }
    if (!agent.enabled) {
      throw new AgentTaskDispatchError(409, "Agent is disabled", "AGENT_DISABLED");
    }

    const currentProfileHash = teammateProfileFingerprint(agent, agentsRepository(this.db).listToolPermissions(agent.id));
    if (currentProfileHash !== clean(request.ownerProfileHash)) {
      throw new AgentTaskDispatchError(409, "Teammate profile changed; admit the work again", "AGENT_PROFILE_CHANGED");
    }
    if (clean(request.policyFingerprint) !== policyFingerprint(agent.id, currentProfileHash)) {
      throw new WorkGraphTaskAdapterError("POLICY_MISMATCH", "Work graph child policy does not match the target profile");
    }

    // Team members are intentionally not sent through this standalone child
    // path. Existing delegation approval remains the only authority that can
    // start them; this adapter never impersonates ask_teammate.
    if (agent.teamId) {
      throw new AgentTaskDispatchError(
        409,
        "Team agents must be started through the delegation API",
        "TEAM_AGENT_REQUIRES_DELEGATION",
      );
    }

    const result = spawnAgentChatSubagent(
      this.dispatchDependencies,
      parent,
      agent.id,
      objective,
      {
        // The child must be fully committed before the runner sees it.
        deferRun: true,
        // Admission ids are the durable retry key; request.idempotencyKey is
        // the graph unit key and is intentionally not used for task replay.
        idempotencyKey: admissionId,
        // This is a controller-owned graph dispatch, never a model-authored
        // ask_teammate call. Leaving this explicit protects that policy if the
        // dispatcher gains a different default in the future.
        modelInitiated: false,
        targetProfileHash: currentProfileHash,
      },
    );
    const childTaskId = extractTaskId(result);
    if (!childTaskId) throw new WorkGraphTaskAdapterError("CHILD_ID_REQUIRED", "Child dispatch returned no task id");

    const child = taskRepository(this.db).getTaskById(childTaskId);
    if (!child || child.parentTaskId !== parent.id || child.agentId !== agent.id) {
      throw new WorkGraphTaskAdapterError("CHILD_OWNERSHIP_INVALID", "Dispatched child is not owned by the graph parent and target");
    }
    await this.startAuthoritativeChild(childTaskId, parent.id, child.status, result.replayed === true);
    return { childTaskId, replayed: result.replayed === true };
  }

  private async startAuthoritativeChild(
    childTaskId: string,
    parentTaskId: string,
    status: string,
    replayed: boolean,
  ): Promise<void> {
    if (this.startedChildren.has(childTaskId)) return;
    if (this.runner.isActive?.(childTaskId)) {
      this.startedChildren.add(childTaskId);
      return;
    }
    // Deferred dispatch creates a queued task. An interrupted task may be
    // reclaimed after a restart; running tasks are left to the normal
    // recovery owner rather than risking duplicate execution here.
    if (status !== "queued" && status !== "interrupted") return;
    // The claim re-reads the child's parent binding and startable status in
    // the same transaction that grants the lease, so two processes replaying
    // the same admission cannot both reach the runner.
    const claim = this.startClaims.claim({
      taskId: childTaskId,
      ownerId: this.startClaimOwnerId,
      now: this.now(),
      leaseMs: this.startClaimLeaseMs,
      expectedParentTaskId: parentTaskId,
    });
    // Another adapter owns the durable start lease. Returning the same child
    // id is still a successful replay, but this process must not call runner.
    if (!claim.acquired) return;
    try {
      if (replayed || status === "interrupted") {
        await this.runner.run(childTaskId, { recovered: true });
      } else {
        await this.runner.run(childTaskId);
      }
    } catch (error) {
      // A start that never happened must not keep the fence: release it so a
      // recovering owner can take the child over immediately.
      this.startClaims.settle(childTaskId);
      throw error;
    }
    this.startedChildren.add(childTaskId);
  }

  /** Detach the settlement observer. Embedding hosts own adapter lifetime. */
  close(): void {
    this.unsubscribeSettled?.();
  }
}

export function createWorkGraphTaskAdapter(dependencies: WorkGraphTaskAdapterDependencies): WorkGraphTaskAdapter {
  return new WorkGraphTaskAdapter(dependencies);
}

/** Functional alias used by embedding hosts. */
export const workGraphTaskAdapter = createWorkGraphTaskAdapter;

/** Reader alias with the name used by older mission integrations. */
export const readAuthoritativeWorkGraphChild = authoritativeChildReader;
