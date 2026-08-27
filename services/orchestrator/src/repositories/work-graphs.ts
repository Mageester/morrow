import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import { redactSecrets, redactSecretsDeep } from "../provider/credentials.js";

export type WorkGraphBarrierState = "open" | "ready" | "claimed" | "completed";
export type WorkUnitTerminalDisposition = "succeeded" | "completed" | "verified" | "failed" | "blocked" | "cancelled" | "rejected";
export type WorkUnitStatus = "pending" | "ready" | "admitted" | "running" | WorkUnitTerminalDisposition;

const TERMINAL_STATUSES = new Set<WorkUnitTerminalDisposition>([
  "succeeded", "completed", "verified", "failed", "blocked", "cancelled", "rejected",
]);
const ACTIVE_STATUSES = new Set(["admitted", "running"]);

export interface WorkGraph {
  version: number;
  id: string;
  parentTaskId: string;
  maxConcurrency: number;
  activeCount: number;
  fanInState: WorkGraphBarrierState;
  resultCursor: number;
  aggregateClaimId: string | null;
  aggregateClaimOwner: string | null;
  aggregateClaimedAt: string | null;
  aggregateClaimLeaseExpiresAt: string | null;
  aggregateCompletedAt: string | null;
  aggregateResult: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkUnit {
  version: number;
  id: string;
  graphId: string;
  parentTaskId: string;
  position: number;
  idempotencyKey: string;
  ownerId: string;
  ownerProfileHash: string;
  policyFingerprint: string;
  objective: string;
  role: "work" | "review";
  required: boolean;
  status: WorkUnitStatus;
  terminalDisposition: WorkUnitTerminalDisposition | null;
  childTaskId: string | null;
  spawnClaimId: string | null;
  spawnClaimOwner: string | null;
  spawnClaimedAt: string | null;
  spawnClaimLeaseExpiresAt: string | null;
  admissionOwnerId: string | null;
  admissionId: string | null;
  admittedAt: string | null;
  startedAt: string | null;
  terminalAt: string | null;
  resultCursor: number;
  result: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkGraphInput {
  /** Optional stable graph identity; when omitted it is derived from parentTaskId. */
  id?: string;
  graphId?: string;
  parentTaskId: string;
  maxConcurrency: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateWorkUnitInput {
  id: string;
  graphId?: string;
  parentTaskId?: string;
  position: number;
  idempotencyKey: string;
  ownerId: string;
  ownerProfileHash?: string;
  policyFingerprint?: string;
  objective: string;
  role?: "work" | "review";
  required?: boolean;
  dependsOn?: readonly string[];
  dependencyIds?: readonly string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface FanInReadiness {
  graphId: string;
  state: WorkGraphBarrierState;
  ready: boolean;
  resultCursor: number;
  units: WorkUnit[];
  pendingUnitIds: string[];
}

export interface WorkGraphAggregateClaim {
  graphId: string;
  claimId: string;
  ownerId: string;
  claimedAt: string;
  resultCursor: number;
  units: WorkUnit[];
}

function nowOr(value: string | undefined): string {
  return value ?? new Date().toISOString();
}

function safeText(value: unknown): string {
  return redactSecrets(typeof value === "string" ? value : String(value ?? ""));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function encodeJson(value: unknown): string {
  const redacted = redactSecretsDeep(stableValue(value));
  return JSON.stringify(redacted) ?? "null";
}

function decodeJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Malformed persisted ${label}`);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Malformed persisted ${label}`);
  }
}

function mapGraph(row: Record<string, unknown>, barrier: Record<string, unknown>): WorkGraph {
  return {
    version: Number(row.schema_version),
    id: String(row.id),
    parentTaskId: String(row.parent_task_id),
    maxConcurrency: Number(row.max_concurrency),
    activeCount: Number(row.active_count),
    fanInState: String(barrier.state) as WorkGraphBarrierState,
    resultCursor: Number(barrier.result_cursor),
    aggregateClaimId: barrier.aggregate_claim_id ? String(barrier.aggregate_claim_id) : null,
    aggregateClaimOwner: barrier.aggregate_claim_owner ? String(barrier.aggregate_claim_owner) : null,
    aggregateClaimedAt: barrier.aggregate_claimed_at ? String(barrier.aggregate_claimed_at) : null,
    aggregateClaimLeaseExpiresAt: barrier.aggregate_claim_lease_expires_at ? String(barrier.aggregate_claim_lease_expires_at) : null,
    aggregateCompletedAt: barrier.aggregate_completed_at ? String(barrier.aggregate_completed_at) : null,
    aggregateResult: barrier.aggregate_result_json === null || barrier.aggregate_result_json === undefined ? null : decodeJson(barrier.aggregate_result_json, "aggregate result"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapUnit(row: Record<string, unknown>): WorkUnit {
  return {
    version: Number(row.schema_version),
    id: String(row.id),
    graphId: String(row.graph_id),
    parentTaskId: String(row.parent_task_id),
    position: Number(row.position),
    idempotencyKey: String(row.idempotency_key),
    ownerId: String(row.owner_id),
    ownerProfileHash: String(row.owner_profile_hash),
    policyFingerprint: String(row.policy_fingerprint),
    objective: safeText(row.objective),
    role: String(row.role ?? "work") as "work" | "review",
    required: Number(row.required) !== 0,
    status: String(row.status) as WorkUnitStatus,
    terminalDisposition: row.terminal_disposition ? String(row.terminal_disposition) as WorkUnitTerminalDisposition : null,
    childTaskId: row.child_task_id ? String(row.child_task_id) : null,
    spawnClaimId: row.spawn_claim_id ? String(row.spawn_claim_id) : null,
    spawnClaimOwner: row.spawn_claim_owner ? String(row.spawn_claim_owner) : null,
    spawnClaimedAt: row.spawn_claimed_at ? String(row.spawn_claimed_at) : null,
    spawnClaimLeaseExpiresAt: row.spawn_claim_lease_expires_at ? String(row.spawn_claim_lease_expires_at) : null,
    admissionOwnerId: row.admission_owner_id ? String(row.admission_owner_id) : null,
    admissionId: row.admission_id ? String(row.admission_id) : null,
    admittedAt: row.admitted_at ? String(row.admitted_at) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    terminalAt: row.terminal_at ? String(row.terminal_at) : null,
    resultCursor: Number(row.result_cursor),
    result: row.result_json === null || row.result_json === undefined ? null : decodeJson(row.result_json, "work graph result"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function isTerminal(status: string): status is WorkUnitTerminalDisposition {
  return TERMINAL_STATUSES.has(status as WorkUnitTerminalDisposition);
}

function uniqueDependencyIds(input: CreateWorkUnitInput): string[] {
  const values = [...(input.dependsOn ?? []), ...(input.dependencyIds ?? [])].map(String);
  return [...new Set(values)];
}

/**
 * Durable parent-owned work graph storage. This repository deliberately does
 * not create or transition child tasks; a child task remains authoritative in
 * `tasks`, while a unit stores only its ownership edge and execution/result
 * bookkeeping. Admission and aggregate claiming are conditional SQLite
 * writes so restart/retry callers cannot over-admit or synthesize twice.
 */
export function workGraphsRepository(db: Database.Database) {
  const graphRow = (graphId: string): Record<string, unknown> => {
    const row = db.prepare("SELECT * FROM work_graphs WHERE id=?").get(graphId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Work graph not found: ${graphId}`);
    return row;
  };

  const barrierRow = (graphId: string): Record<string, unknown> => {
    const row = db.prepare("SELECT * FROM work_graph_barriers WHERE graph_id=?").get(graphId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Work graph barrier not found: ${graphId}`);
    return row;
  };

  const graph = (graphId: string): WorkGraph => mapGraph(graphRow(graphId), barrierRow(graphId));

  const unitRow = (graphId: string, unitId: string): Record<string, unknown> => {
    const row = db.prepare("SELECT * FROM work_graph_units WHERE graph_id=? AND id=?").get(graphId, unitId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Work graph unit not found: ${unitId}`);
    return row;
  };

  const dependenciesFor = (unitId: string): string[] => (db.prepare(
    "SELECT depends_on_unit_id AS id FROM work_graph_dependencies WHERE work_unit_id=? ORDER BY depends_on_unit_id ASC",
  ).all(unitId) as Array<{ id: string }>).map((row) => String(row.id));

  const ensureDependency = (graphId: string, unitId: string, dependencyId: string): void => {
    const dependency = db.prepare("SELECT graph_id FROM work_graph_units WHERE id=?").get(dependencyId) as { graph_id?: string } | undefined;
    if (!dependency || dependency.graph_id !== graphId) {
      throw new Error(`Dependency ${dependencyId} does not belong to work graph ${graphId}`);
    }
    if (unitId === dependencyId) throw new Error("A work graph unit cannot depend on itself");
  };

  const refreshReadyInTransaction = (graphId: string, timestamp: string): void => {
    db.prepare(`
      UPDATE work_graph_units
      SET status='ready', updated_at=?
      WHERE graph_id=? AND status='pending'
        AND NOT EXISTS (
          SELECT 1
          FROM work_graph_dependencies d
          JOIN work_graph_units dependency ON dependency.id=d.depends_on_unit_id
          WHERE d.work_unit_id=work_graph_units.id
            AND dependency.status NOT IN ('succeeded','completed','verified','failed','blocked','cancelled','rejected')
        )
    `).run(timestamp, graphId);
  };

  const refreshBarrierInTransaction = (graphId: string, timestamp: string): void => {
    db.prepare(`
      UPDATE work_graph_barriers
      SET state='ready', updated_at=?
      WHERE graph_id=? AND state='open'
        AND EXISTS (SELECT 1 FROM work_graph_units WHERE graph_id=? AND required=1)
        AND NOT EXISTS (
          SELECT 1 FROM work_graph_units
          WHERE graph_id=? AND required=1
            AND status NOT IN ('succeeded','completed','verified','failed','blocked','cancelled','rejected')
        )
    `).run(timestamp, graphId, graphId, graphId);
  };

  const orderedUnits = (graphId: string, requiredOnly = false): WorkUnit[] => {
    const sql = requiredOnly
      ? "SELECT * FROM work_graph_units WHERE graph_id=? AND required=1 ORDER BY position ASC,id ASC"
      : "SELECT * FROM work_graph_units WHERE graph_id=? ORDER BY position ASC,id ASC";
    return (db.prepare(sql).all(graphId) as Array<Record<string, unknown>>).map(mapUnit);
  };

  const readyUnits = (graphId: string): WorkUnit[] => (db.prepare(
    "SELECT * FROM work_graph_units WHERE graph_id=? AND status='ready' ORDER BY position ASC,id ASC",
  ).all(graphId) as Array<Record<string, unknown>>).map(mapUnit);

  const createGraph = (input: CreateWorkGraphInput): WorkGraph => {
    const timestamp = nowOr(input.createdAt ?? input.updatedAt);
    const id = safeText(input.id ?? input.graphId ?? `work-graph:${input.parentTaskId}`);
    if (!id) throw new Error("Work graph id is required");
    if (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency < 1) {
      throw new Error("Work graph maxConcurrency must be a positive integer");
    }

    return db.transaction(() => {
      // INSERT OR IGNORE is the first statement so concurrent callers never
      // establish a stale read snapshot before the uniqueness CAS. The unique
      // graph id and unique parent edge cover both replay shapes.
      const inserted = db.prepare(`
        INSERT INTO work_graphs(id,schema_version,parent_task_id,max_concurrency,active_count,created_at,updated_at)
        VALUES(?,1,?,?,0,?,?)
        ON CONFLICT DO NOTHING
      `).run(id, input.parentTaskId, input.maxConcurrency, timestamp, input.updatedAt ?? timestamp);

      if (inserted.changes !== 1) {
        const byId = db.prepare("SELECT * FROM work_graphs WHERE id=?").get(id) as Record<string, unknown> | undefined;
        const byParent = db.prepare("SELECT * FROM work_graphs WHERE parent_task_id=?").get(input.parentTaskId) as Record<string, unknown> | undefined;
        const existing = byId ?? byParent;
        if (existing) {
          if (String(existing.parent_task_id) !== input.parentTaskId || Number(existing.max_concurrency) !== input.maxConcurrency) {
            throw new Error(`Work graph idempotency conflict for ${id}`);
          }
          return graph(String(existing.id));
        }
        throw new Error(`Work graph ${id} could not be admitted`);
      }

      db.prepare(`
        INSERT INTO work_graph_barriers(graph_id,state,result_cursor,aggregate_claim_id,aggregate_claim_owner,aggregate_claimed_at,aggregate_completed_at,created_at,updated_at)
        VALUES(?, 'open', 0, NULL, NULL, NULL, NULL, ?, ?)
      `).run(id, timestamp, input.updatedAt ?? timestamp);
      return graph(id);
    })();
  };

  const createUnitInTransaction = (
    input: CreateWorkUnitInput,
    timestamp: string,
    options: { deferDependencies?: boolean } = {},
  ): WorkUnit => {
    const graphId = input.graphId;
    if (!graphId) throw new Error("Work graph id is required for a work unit");
    const ownerProfileHash = safeText(input.ownerProfileHash ?? "");
    const policyFingerprint = safeText(input.policyFingerprint ?? "");
    const ownerId = safeText(input.ownerId);
    const objective = safeText(input.objective);
    const requestedParentTaskId = input.parentTaskId ?? null;
    const requestedDependencyIds = uniqueDependencyIds(input);
    const status: WorkUnitStatus = requestedDependencyIds.length === 0 ? "ready" : "pending";
    // Make the uniqueness decision with a write as the first mutating
    // statement. A deferred read followed by INSERT can become SQLITE_BUSY
    // on a concurrent retry after another connection commits; this conditional
    // insert lets SQLite serialize the idempotency CAS instead.
    const inserted = db.prepare(`
      INSERT INTO work_graph_units(
        id,schema_version,graph_id,parent_task_id,position,idempotency_key,owner_id,owner_profile_hash,policy_fingerprint,
        objective,role,required,status,terminal_disposition,child_task_id,admission_owner_id,admission_id,admitted_at,started_at,
        terminal_at,result_cursor,result_json,created_at,updated_at
      )
      SELECT @id,1,g.id,g.parent_task_id,@position,@idempotencyKey,@ownerId,@ownerProfileHash,@policyFingerprint,
        @objective,@role,@required,@status,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,@createdAt,@updatedAt
      FROM work_graphs g
      JOIN work_graph_barriers barrier ON barrier.graph_id=g.id
      WHERE g.id=@graphId
        AND (@parentTaskId IS NULL OR g.parent_task_id=@parentTaskId)
        AND g.max_concurrency>0 AND g.active_count<=g.max_concurrency
        AND barrier.state IN ('open','ready')
      ON CONFLICT DO NOTHING
    `).run({ id: input.id, position: input.position, idempotencyKey: input.idempotencyKey,
      ownerId, ownerProfileHash, policyFingerprint, objective, role: input.role ?? "work",
      required: input.required === false ? 0 : 1, status, createdAt: timestamp,
      updatedAt: input.updatedAt ?? timestamp, parentTaskId: requestedParentTaskId, graphId });

    if (inserted.changes !== 1) {
      const existing = db.prepare("SELECT * FROM work_graph_units WHERE graph_id=? AND idempotency_key=?")
        .get(graphId, input.idempotencyKey) as Record<string, unknown> | undefined;
      if (!existing) {
        const barrier = barrierRow(graphId);
        if (barrier.state === "claimed" || barrier.state === "completed") {
          throw new Error(`Cannot add work units after aggregate ${barrier.state}`);
        }
        throw new Error(`Work unit id ${input.id} conflicts with an existing unit`);
      }
      const parentTaskId = String(existing.parent_task_id);
      const same = isDeepStrictEqual(
        {
          parentTaskId: String(existing.parent_task_id), position: Number(existing.position),
          ownerId: String(existing.owner_id), ownerProfileHash: String(existing.owner_profile_hash),
          policyFingerprint: String(existing.policy_fingerprint), objective: String(existing.objective),
          role: String(existing.role ?? "work"),
          required: Number(existing.required) !== 0, dependencies: dependenciesFor(String(existing.id)).sort(),
        },
        {
          parentTaskId: requestedParentTaskId ?? parentTaskId, position: input.position, ownerId, ownerProfileHash,
          policyFingerprint, objective, required: input.required !== false, dependencies: [...requestedDependencyIds].sort(),
          role: input.role ?? "work",
        },
      );
      if (!same) throw new Error(`Work unit idempotency conflict for key ${input.idempotencyKey}`);
      return mapUnit(existing);
    }

    if (!options.deferDependencies) {
      for (const dependencyId of requestedDependencyIds) {
        ensureDependency(graphId, input.id, dependencyId);
        db.prepare("INSERT INTO work_graph_dependencies(work_unit_id,depends_on_unit_id,created_at) VALUES(?,?,?)")
          .run(input.id, dependencyId, timestamp);
      }
    }
    // Adding a unit after an already-complete decomposition reopens only the
    // barrier; it never changes existing unit or child-task truth.
    db.prepare("UPDATE work_graph_barriers SET state='open',updated_at=? WHERE graph_id=? AND state='ready'")
      .run(timestamp, graphId);
    return mapUnit(unitRow(graphId, input.id));
  };

  const createUnit = (input: CreateWorkUnitInput): WorkUnit => {
    const timestamp = nowOr(input.createdAt ?? input.updatedAt);
    return db.transaction(() => createUnitInTransaction(input, timestamp))();
  };

  const addDependencyInTransaction = (graphId: string, unitId: string, dependencyId: string, updatedAt: string): WorkUnit => {
    const dependent = unitRow(graphId, unitId);
    ensureDependency(graphId, unitId, dependencyId);
    const existingEdge = db.prepare(
      "SELECT 1 FROM work_graph_dependencies WHERE work_unit_id=? AND depends_on_unit_id=?",
    ).get(unitId, dependencyId);
    if (existingEdge) return mapUnit(dependent);
    if (ACTIVE_STATUSES.has(String(dependent.status)) || isTerminal(String(dependent.status))) {
      throw new Error(`Cannot add a dependency after work unit ${unitId} has started`);
    }
    const cycle = db.prepare(`
      WITH RECURSIVE reachable(id) AS (
        SELECT depends_on_unit_id FROM work_graph_dependencies WHERE work_unit_id=?
        UNION
        SELECT d.depends_on_unit_id
        FROM work_graph_dependencies d JOIN reachable r ON d.work_unit_id=r.id
      )
      SELECT 1 FROM reachable WHERE id=? LIMIT 1
    `).get(dependencyId, unitId);
    if (cycle) throw new Error(`Dependency cycle detected for ${unitId}`);
    db.prepare("INSERT INTO work_graph_dependencies(work_unit_id,depends_on_unit_id,created_at) VALUES(?,?,?)")
      .run(unitId, dependencyId, updatedAt);
    db.prepare("UPDATE work_graph_units SET status='pending',updated_at=? WHERE graph_id=? AND id=? AND status='ready'")
      .run(updatedAt, graphId, unitId);
    refreshReadyInTransaction(graphId, updatedAt);
    return mapUnit(unitRow(graphId, unitId));
  };

  const addDependency = (graphId: string, unitId: string, dependencyId: string, updatedAt = new Date().toISOString()): WorkUnit => db.transaction(
    () => addDependencyInTransaction(graphId, unitId, dependencyId, updatedAt),
  )();

  const admitInTransaction = (graphId: string, unitId: string, admissionOwnerId: string, updatedAt: string, admissionId?: string): WorkUnit | null => {
    // The graph-row update is the CAS. It is intentionally the first write in
    // this transaction: competing SQLite connections serialize on this row,
    // and only the writer that still observes active_count < max_concurrency
    // can reserve a slot.
    const reserved = db.prepare(`
      UPDATE work_graphs
      SET active_count=active_count+1,updated_at=?
      WHERE id=? AND active_count < max_concurrency
        AND EXISTS (
          SELECT 1 FROM work_graph_units unit
          WHERE unit.id=? AND unit.graph_id=? AND unit.status IN ('ready','pending')
            AND NOT EXISTS (
              SELECT 1
              FROM work_graph_dependencies dependency_edge
              JOIN work_graph_units dependency ON dependency.id=dependency_edge.depends_on_unit_id
              WHERE dependency_edge.work_unit_id=unit.id
                AND dependency.status NOT IN ('succeeded','completed','verified','failed','blocked','cancelled','rejected')
            )
      )
    `).run(updatedAt, graphId, unitId, graphId);
    if (reserved.changes !== 1) {
      const current = unitRow(graphId, unitId);
      const currentStatus = String(current.status);
      if (ACTIVE_STATUSES.has(currentStatus)) {
        if (current.admission_owner_id === admissionOwnerId || (admissionId && current.admission_id === admissionId)) return mapUnit(current);
        return null;
      }
      if (isTerminal(currentStatus)) return null;
      return null;
    }

    const id = admissionId ?? `admission-${randomUUID()}`;
    const started = db.prepare(`
      UPDATE work_graph_units
      SET status='admitted',admission_owner_id=?,admission_id=?,admitted_at=?,updated_at=?
      WHERE graph_id=? AND id=? AND status IN ('ready','pending')
        AND NOT EXISTS (
          SELECT 1
          FROM work_graph_dependencies dependency_edge
          JOIN work_graph_units dependency ON dependency.id=dependency_edge.depends_on_unit_id
          WHERE dependency_edge.work_unit_id=work_graph_units.id
            AND dependency.status NOT IN ('succeeded','completed','verified','failed','blocked','cancelled','rejected')
        )
    `).run(admissionOwnerId, id, updatedAt, updatedAt, graphId, unitId);
    if (started.changes !== 1) throw new Error(`Work graph admission lost unit ${unitId}`);
    return mapUnit(unitRow(graphId, unitId));
  };

  const admit = (graphId: string, unitId: string, admissionOwnerId: string, updatedAt = new Date().toISOString(), admissionId?: string): WorkUnit | null => db.transaction(
    () => admitInTransaction(graphId, unitId, safeText(admissionOwnerId), updatedAt, admissionId),
  )();

  const admitNext = (graphId: string, admissionOwnerId: string, updatedAt = new Date().toISOString()): WorkUnit | null => {
    const candidate = db.prepare(`
      SELECT unit.id
      FROM work_graph_units unit
      WHERE unit.graph_id=? AND unit.status IN ('ready','pending')
        AND NOT EXISTS (
          SELECT 1
          FROM work_graph_dependencies dependency_edge
          JOIN work_graph_units dependency ON dependency.id=dependency_edge.depends_on_unit_id
          WHERE dependency_edge.work_unit_id=unit.id
            AND dependency.status NOT IN ('succeeded','completed','verified','failed','blocked','cancelled','rejected')
        )
      ORDER BY unit.position ASC,unit.id ASC
      LIMIT 1
    `).get(graphId) as { id?: string } | undefined;
    // Perform the candidate read outside the CAS transaction. A competing
    // writer can make this candidate ineligible, but admitInTransaction then
    // returns null without risking a stale SQLite snapshot.
    return candidate?.id ? admit(graphId, candidate.id, safeText(admissionOwnerId), updatedAt) : null;
  };

  const markRunning = (graphId: string, unitId: string, updatedAt = new Date().toISOString()): WorkUnit => db.transaction(() => {
    const current = unitRow(graphId, unitId);
    if (current.status === "running") return mapUnit(current);
    if (current.status !== "admitted") throw new Error(`Work unit ${unitId} is not admitted`);
    db.prepare("UPDATE work_graph_units SET status='running',started_at=?,updated_at=? WHERE graph_id=? AND id=? AND status='admitted'")
      .run(updatedAt, updatedAt, graphId, unitId);
    return mapUnit(unitRow(graphId, unitId));
  })();

  const markTerminal = (
    graphId: string,
    unitId: string,
    disposition: WorkUnitTerminalDisposition,
    result?: unknown,
    updatedAt = new Date().toISOString(),
  ): WorkUnit => db.transaction(() => {
    if (!TERMINAL_STATUSES.has(disposition)) throw new Error(`Invalid terminal disposition: ${disposition}`);
    const current = unitRow(graphId, unitId);
    const currentStatus = String(current.status);
    if (isTerminal(currentStatus)) {
      if (currentStatus !== disposition) throw new Error(`Work unit ${unitId} already has terminal disposition ${currentStatus}`);
      if (result !== undefined) {
        const existingResult = current.result_json === null || current.result_json === undefined
          ? null
          : decodeJson(current.result_json, "work graph result");
        const requestedResult = stableValue(redactSecretsDeep(result));
        if (existingResult !== null && !isDeepStrictEqual(existingResult, requestedResult)) {
          throw new Error(`Work unit ${unitId} terminal result conflicts with its existing result`);
        }
        if (existingResult === null) {
          db.prepare("UPDATE work_graph_units SET result_json=?,updated_at=? WHERE graph_id=? AND id=? AND status=?")
            .run(encodeJson(result), updatedAt, graphId, unitId, currentStatus);
          return mapUnit(unitRow(graphId, unitId));
        }
      }
      return mapUnit(current);
    }
    if (!(["pending", "ready", "admitted", "running"] as string[]).includes(currentStatus)) {
      throw new Error(`Work unit ${unitId} cannot become terminal from ${currentStatus}`);
    }
    if (result === undefined) throw new Error(`Work unit ${unitId} terminal result is required`);
    const resultJson = encodeJson(result);
    const updated = db.prepare(`
      UPDATE work_graph_units
      SET status=?,terminal_disposition=?,terminal_at=?,result_json=COALESCE(?,result_json),updated_at=?
      WHERE graph_id=? AND id=? AND status=?
    `).run(disposition, disposition, updatedAt, resultJson, updatedAt, graphId, unitId, currentStatus);
    if (updated.changes !== 1) throw new Error(`Work unit ${unitId} changed during terminal transition`);
    if (ACTIVE_STATUSES.has(currentStatus)) {
      const released = db.prepare("UPDATE work_graphs SET active_count=active_count-1,updated_at=? WHERE id=? AND active_count>0")
        .run(updatedAt, graphId);
      if (released.changes !== 1) throw new Error(`Work graph admission count is inconsistent for ${graphId}`);
    }
    refreshReadyInTransaction(graphId, updatedAt);
    refreshBarrierInTransaction(graphId, updatedAt);
    return mapUnit(unitRow(graphId, unitId));
  })();

  const recordResult = (graphId: string, unitId: string, result: unknown, updatedAt = new Date().toISOString()): WorkUnit => db.transaction(() => {
    const current = unitRow(graphId, unitId);
    const currentStatus = String(current.status);
    if (!isTerminal(currentStatus)) throw new Error(`Work unit ${unitId} result requires a terminal disposition`);
    if (Number(current.result_cursor) > 0) {
      const existing = decodeJson(current.result_json, "work graph result");
      if (!isDeepStrictEqual(existing, stableValue(redactSecretsDeep(result)))) {
        throw new Error(`Work unit ${unitId} result cursor already advanced with a different result`);
      }
      return mapUnit(current);
    }
    const barrier = barrierRow(graphId);
    if (barrier.state === "claimed" || barrier.state === "completed") {
      throw new Error(`Work graph aggregate is already ${barrier.state}`);
    }
    const cursor = Number(barrier.result_cursor) + 1;
    const resultJson = encodeJson(result);
    const updated = db.prepare("UPDATE work_graph_units SET result_cursor=?,result_json=?,updated_at=? WHERE graph_id=? AND id=? AND result_cursor=0")
      .run(cursor, resultJson, updatedAt, graphId, unitId);
    if (updated.changes !== 1) throw new Error(`Work unit ${unitId} result cursor changed during transition`);
    db.prepare("UPDATE work_graph_barriers SET result_cursor=?,updated_at=? WHERE graph_id=?")
      .run(cursor, updatedAt, graphId);
    return mapUnit(unitRow(graphId, unitId));
  })();

  const fanInReady = (graphId: string): FanInReadiness => db.transaction(() => {
    const timestamp = new Date().toISOString();
    refreshBarrierInTransaction(graphId, timestamp);
    const barrier = barrierRow(graphId);
    const required = orderedUnits(graphId, true);
    const units = required.filter((unit) => isTerminal(unit.status));
    const pendingUnitIds = required.filter((unit) => !isTerminal(unit.status)).map((unit) => unit.id);
    return {
      graphId,
      state: String(barrier.state) as WorkGraphBarrierState,
      ready: barrier.state === "ready",
      resultCursor: Number(barrier.result_cursor),
      units,
      pendingUnitIds,
    };
  })();

  const claimAggregate = (
    graphId: string,
    ownerId: string,
    claimedAt = new Date().toISOString(),
    leaseMs = 60_000,
  ): WorkGraphAggregateClaim | null => db.transaction(() => {
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new Error("Aggregate claim lease must be a positive integer");
    const claimedTime = Date.parse(claimedAt);
    if (!Number.isFinite(claimedTime)) throw new Error("Aggregate claim timestamp must be an ISO date");
    const leaseExpiresAt = new Date(claimedTime + leaseMs).toISOString();
    refreshBarrierInTransaction(graphId, claimedAt);
    const claimId = `aggregate-${randomUUID()}`;
    const updated = db.prepare(`
      UPDATE work_graph_barriers
      SET state='claimed',aggregate_claim_id=?,aggregate_claim_owner=?,aggregate_claimed_at=?,aggregate_claim_lease_expires_at=?,updated_at=?
      WHERE graph_id=? AND (
        state='ready'
        OR (state='claimed' AND aggregate_claim_lease_expires_at IS NOT NULL AND aggregate_claim_lease_expires_at<=?)
      )
        AND NOT EXISTS (
          SELECT 1 FROM work_graph_units
          WHERE graph_id=? AND required=1
            AND status NOT IN ('succeeded','completed','verified','failed','blocked','cancelled','rejected')
        )
        AND NOT EXISTS (
          SELECT 1 FROM work_graph_units
          WHERE graph_id=? AND required=1 AND result_cursor<1
        )
    `).run(claimId, safeText(ownerId), claimedAt, leaseExpiresAt, claimedAt, graphId, claimedAt, graphId, graphId);
    if (updated.changes !== 1) return null;
    const barrier = barrierRow(graphId);
    return {
      graphId,
      claimId,
      ownerId: String(barrier.aggregate_claim_owner),
      claimedAt: String(barrier.aggregate_claimed_at),
      resultCursor: Number(barrier.result_cursor),
      units: orderedUnits(graphId, true),
    };
  })();

  const completeAggregate = (graphId: string, claimId: string, ownerId: string, completedAt = new Date().toISOString(), result?: unknown): WorkGraph | null => db.transaction(() => {
    const resultJson = result === undefined ? undefined : encodeJson(result);
    const updated = db.prepare(`
      UPDATE work_graph_barriers
      SET state='completed',aggregate_completed_at=?,aggregate_result_json=COALESCE(?,aggregate_result_json),updated_at=?
      WHERE graph_id=? AND state='claimed' AND aggregate_claim_id=? AND aggregate_claim_owner=?
        AND (aggregate_claim_lease_expires_at IS NULL OR aggregate_claim_lease_expires_at>?)
    `).run(completedAt, resultJson ?? null, completedAt, graphId, claimId, safeText(ownerId), completedAt);
    return updated.changes === 1 ? graph(graphId) : null;
  })();

  const claimSpawn = (graphId: string, unitId: string, ownerId: string, claimedAt = new Date().toISOString(), leaseMs = 60_000): WorkUnit | null => db.transaction(() => {
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new Error("Spawn claim lease must be a positive integer");
    const claimedTime = Date.parse(claimedAt);
    if (!Number.isFinite(claimedTime)) throw new Error("Spawn claim timestamp must be an ISO date");
    const current = unitRow(graphId, unitId);
    if (current.child_task_id) return mapUnit(current);
    if (!ACTIVE_STATUSES.has(String(current.status)) || !current.admission_id) return null;
    const claimId = `spawn-${randomUUID()}`;
    const expires = new Date(claimedTime + leaseMs).toISOString();
    const updated = db.prepare(`
      UPDATE work_graph_units
      SET spawn_claim_id=?,spawn_claim_owner=?,spawn_claimed_at=?,spawn_claim_lease_expires_at=?,updated_at=?
      WHERE graph_id=? AND id=? AND child_task_id IS NULL
        AND status IN ('admitted','running') AND admission_id IS NOT NULL
        AND (spawn_claim_id IS NULL OR spawn_claim_lease_expires_at IS NULL OR spawn_claim_lease_expires_at<=?)
    `).run(claimId, safeText(ownerId), claimedAt, expires, claimedAt, graphId, unitId, claimedAt);
    return updated.changes === 1 ? mapUnit(unitRow(graphId, unitId)) : null;
  })();

  const attachChild = (graphId: string, unitId: string, childTaskId: string, updatedAt = new Date().toISOString()): WorkUnit => db.transaction(() => {
    const parent = String(graphRow(graphId).parent_task_id);
    const child = db.prepare("SELECT parent_task_id FROM tasks WHERE id=?").get(childTaskId) as { parent_task_id?: string | null } | undefined;
    if (!child) throw new Error(`Child task not found: ${childTaskId}`);
    if (child.parent_task_id !== parent || childTaskId === parent) {
      throw new Error(`Child task ${childTaskId} is not owned by parent task ${parent}`);
    }
    const current = unitRow(graphId, unitId);
    if (current.child_task_id && current.child_task_id !== childTaskId) {
      throw new Error(`Work unit ${unitId} already owns child task ${current.child_task_id}`);
    }
    db.prepare("UPDATE work_graph_units SET child_task_id=?,spawn_claim_id=NULL,spawn_claim_owner=NULL,spawn_claimed_at=NULL,spawn_claim_lease_expires_at=NULL,updated_at=? WHERE graph_id=? AND id=? AND (child_task_id IS NULL OR child_task_id=?)")
      .run(childTaskId, updatedAt, graphId, unitId, childTaskId);
    return mapUnit(unitRow(graphId, unitId));
  })();

  const listReady = (graphId: string): WorkUnit[] => db.transaction(() => {
    const timestamp = new Date().toISOString();
    refreshReadyInTransaction(graphId, timestamp);
    return readyUnits(graphId);
  })();

  const listUnits = (graphId: string): WorkUnit[] => orderedUnits(graphId);
  const getUnit = (graphIdOrUnitId: string, maybeUnitId?: string): WorkUnit | undefined => {
    const row = maybeUnitId === undefined
      ? db.prepare("SELECT * FROM work_graph_units WHERE id=?").get(graphIdOrUnitId) as Record<string, unknown> | undefined
      : db.prepare("SELECT * FROM work_graph_units WHERE graph_id=? AND id=?").get(graphIdOrUnitId, maybeUnitId) as Record<string, unknown> | undefined;
    return row ? mapUnit(row) : undefined;
  };

  return {
    create: createGraph,
    createGraph,
    get(graphId: string): WorkGraph | undefined {
      const row = db.prepare("SELECT * FROM work_graphs WHERE id=?").get(graphId) as Record<string, unknown> | undefined;
      return row ? graph(graphId) : undefined;
    },
    getByParentTask(parentTaskId: string): WorkGraph | undefined {
      const row = db.prepare("SELECT id FROM work_graphs WHERE parent_task_id=?").get(parentTaskId) as { id?: string } | undefined;
      return row?.id ? graph(row.id) : undefined;
    },
    /**
     * Resolve the graph that owns a child task. `work_graph_units.child_task_id`
     * is uniquely indexed, so a settled child maps to at most one graph.
     */
    getByChildTask(childTaskId: string): WorkGraph | undefined {
      const row = db.prepare("SELECT graph_id FROM work_graph_units WHERE child_task_id=?")
        .get(childTaskId) as { graph_id?: string } | undefined;
      return row?.graph_id ? graph(row.graph_id) : undefined;
    },
    /**
     * Graphs whose fan-in has not completed, oldest first. Startup
     * reconciliation replays exactly these; a completed aggregate is durable
     * and must never be re-synthesized.
     */
    listUnsettled(): WorkGraph[] {
      return (db.prepare(`SELECT g.id FROM work_graphs AS g
        LEFT JOIN work_graph_barriers AS b ON b.graph_id=g.id
        WHERE COALESCE(b.state,'open') <> 'completed'
        ORDER BY g.created_at ASC, g.id ASC`).all() as Array<{ id: string }>)
        .map((row) => graph(row.id));
    },
    createUnit,
    createWorkUnit: createUnit,
    createUnits(graphId: string, inputs: readonly CreateWorkUnitInput[]): WorkUnit[] {
      const timestamp = new Date().toISOString();
      return db.transaction(() => {
        const normalized = inputs.map((input) => {
          if (input.graphId && input.graphId !== graphId) {
            throw new Error(`Work graph unit ${input.id} does not belong to ${graphId}`);
          }
          return { ...input, graphId };
        });
        // Insert every unit before attaching edges so decomposition may refer
        // to a later position without depending on input order. The second
        // pass is still inside this transaction, so no partial graph is ever
        // visible to a restart or competing reader.
        normalized.map((input) => createUnitInTransaction(input, timestamp, { deferDependencies: true }));
        for (const input of normalized) {
          for (const dependencyId of uniqueDependencyIds(input)) {
            addDependencyInTransaction(String(input.graphId), input.id, dependencyId, timestamp);
          }
        }
        return normalized.map((input) => mapUnit(unitRow(String(input.graphId), input.id)));
      })();
    },
    getUnit,
    listUnits,
    listReady,
    listDependencies(graphId: string, unitId: string): string[] {
      unitRow(graphId, unitId);
      return dependenciesFor(unitId);
    },
    addDependency,
    refreshReadiness(graphId: string, updatedAt = new Date().toISOString()): WorkUnit[] {
      return db.transaction(() => {
        refreshReadyInTransaction(graphId, updatedAt);
        return readyUnits(graphId);
      })();
    },
    admit,
    admitWorkUnit: admit,
    admitNext,
    markRunning,
    markTerminal,
    completeUnit: markTerminal,
    recordResult,
    markResultImported: recordResult,
    advanceResultCursor: recordResult,
    fanInReady,
    getFanInReadiness: fanInReady,
    claimAggregate,
    claimFanIn: claimAggregate,
    completeAggregate,
    claimSpawn,
    attachChild,
  };
}

/** Singular alias for callers that use repository naming by aggregate. */
export const workGraphRepository = workGraphsRepository;
