import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Agent } from "@morrow/contracts";
import { executionContinuityRepository } from "../repositories/execution-continuity.js";
import { agentsRepository } from "../repositories/agents.js";
import { taskRecordsRepository } from "../repositories/task-records.js";
import { taskRepository } from "../repositories/tasks.js";
import {
  workGraphsRepository,
  type CreateWorkUnitInput,
  type WorkGraph,
  type WorkUnit,
  type WorkUnitStatus,
  type WorkUnitTerminalDisposition,
} from "../repositories/work-graphs.js";
import { teammateProfileFingerprint } from "../tools/teammate-delegation.js";
import { redactSecrets, redactSecretsDeep } from "../provider/credentials.js";

/** The graph repository is deliberately the only durable orchestration state. */
export type WorkGraphRepository = ReturnType<typeof workGraphsRepository>;

export type WorkGraphUnitRole = "work" | "review";
export type ReviewVerdict = "approved" | "rejected" | "revisions_required";

export interface WorkGraphUnitDefinition {
  /** Stable human-readable key. It is also accepted in dependency references. */
  key?: string;
  /** Optional stable id. Missing ids are derived from graph id and key. */
  id?: string;
  /** Missing positions are assigned after canonical key ordering. */
  position?: number;
  /** Missing keys use id, then a deterministic position key. */
  idempotencyKey?: string;
  ownerId: string;
  /** The profile hash shown when this unit was admitted. */
  ownerProfileHash?: string;
  /** Alias accepted by callers that use profileHash terminology. */
  profileHash?: string;
  policyFingerprint?: string;
  objective: string;
  required?: boolean;
  dependsOn?: readonly string[];
  dependencyIds?: readonly string[];
  role?: WorkGraphUnitRole;
  /** A decomposition-time assertion. The durable profile is checked again at dispatch. */
  enabled?: boolean;
}

export interface ReviewerDefinition extends Omit<WorkGraphUnitDefinition, "role" | "dependsOn" | "dependencyIds" | "required"> {
  enabled?: boolean;
}

export interface WorkGraphDecompositionInput {
  parentTaskId: string;
  objective?: string;
  graphId?: string;
  maxConcurrency: number;
  units: readonly WorkGraphUnitDefinition[];
  /** One independent reviewer unit. Its dependencies are all required work units. */
  reviewer?: ReviewerDefinition;
  createdAt?: string;
}

export interface WorkGraphDecomposition {
  graph: WorkGraph;
  units: WorkUnit[];
}

export interface AgentProfileSnapshot {
  enabled: boolean;
  profileHash: string;
}

export interface SpawnChildRequest {
  graphId: string;
  parentTaskId: string;
  unitId: string;
  idempotencyKey: string;
  admissionId: string;
  ownerId: string;
  ownerProfileHash: string;
  policyFingerprint: string;
  objective: string;
  role: WorkGraphUnitRole;
  dependencyIds: string[];
}

export type SpawnChildResult =
  | string
  | { childTaskId?: string; taskId?: string; id?: string; task?: { id?: string } };

export type SpawnChild = (request: SpawnChildRequest) => SpawnChildResult | Promise<SpawnChildResult>;

export interface ChildCanonicalAnswer {
  content?: string | null;
  answer?: string | null;
  text?: string | null;
  taskId?: string | null;
  evidenceJson?: Record<string, unknown> | null;
  evidence?: Record<string, unknown> | null;
}

export interface ChildVerification {
  status?: string;
  passed?: boolean;
  completed?: boolean;
  exitCode?: number | null;
  evidenceRef?: string | null;
  final?: boolean;
  failure?: string | null;
}

export interface ChildEvidence {
  id?: string;
  evidenceRef?: string | null;
  path?: string | null;
  independentlyObserved?: boolean;
  durable?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ChildArtifact {
  id?: string;
  path?: string | null;
  contentHash?: string | null;
  hash?: string | null;
  evidenceRef?: string | null;
  independentlyObserved?: boolean;
  durable?: boolean;
}

/**
 * A read from the authoritative child boundary. This is intentionally richer
 * than a graph unit: the graph must never invent a canonical answer or copy a
 * caller-provided handoff over the child task's durable records.
 */
export interface ChildTaskSnapshot {
  id: string;
  parentTaskId: string | null;
  status: string;
  agentId?: string | null;
  ownerProfileHash?: string | null;
  policyFingerprint?: string | null;
  canonicalAnswer?: ChildCanonicalAnswer | string | null;
  /** Alias for integrations that call the canonical answer `answer`. */
  answer?: ChildCanonicalAnswer | string | null;
  canonicalFinalAnswer?: string | null;
  evidenceJson?: Record<string, unknown> | null;
  verification?: ChildVerification | null;
  verifications?: readonly ChildVerification[];
  evidence?: readonly (ChildEvidence | string)[];
  evidenceRecords?: readonly (ChildEvidence | string)[];
  artifacts?: readonly ChildArtifact[];
  artifactHashes?: readonly ChildArtifact[] | readonly string[];
  reviewVerdict?: ReviewVerdict | null;
  review?: { verdict?: ReviewVerdict | null } | null;
  failure?: string | null;
}

export type ReadChild = (childTaskId: string) => ChildTaskSnapshot | null | undefined | Promise<ChildTaskSnapshot | null | undefined>;

export interface SynthesisInput {
  graphId: string;
  parentTaskId: string;
  claimId: string;
  idempotencyKey: string;
  /** Required units, already ordered by `(position,id)`. */
  units: WorkUnit[];
}

export type Synthesize = (input: SynthesisInput) => unknown | Promise<unknown>;

export interface WorkGraphOrchestratorDependencies {
  /** Either repository or db may be supplied. A db is useful for production readers. */
  repository?: WorkGraphRepository;
  db?: Database.Database;
  spawnChild: SpawnChild;
  /** Durable lookup used after a crash between child creation and attachment. */
  findChildByAdmissionId?: (admissionId: string) => string | null | undefined | Promise<string | null | undefined>;
  readChild?: ReadChild;
  getAgentProfile?: (ownerId: string) => AgentProfileSnapshot | null | undefined;
  synthesize?: Synthesize;
  now?: () => string;
}

export interface ChildSettlement {
  state: "pending" | "imported" | "settled" | "rejected";
  unit: WorkUnit;
  childTaskId: string | null;
  reasons: string[];
}

export interface SynthesisOutcome {
  state: "pending" | "blocked" | "completed" | "claimed";
  graph: WorkGraph;
  result?: unknown;
  reasons: string[];
  units: WorkUnit[];
}

export class WorkGraphOrchestrationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorkGraphOrchestrationError";
  }
}

const TERMINAL_CHILD_STATUSES = new Set([
  "completed", "verified", "failed", "blocked", "cancelled", "rejected",
]);
const FAILURE_CHILD_STATUSES = new Set(["failed", "blocked", "cancelled", "rejected"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clean(value: unknown): string {
  return redactSecrets(typeof value === "string" ? value : String(value ?? "")).trim();
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

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)) ?? "null", "utf8").digest("hex");
}

function nowFrom(input: string | undefined, fallback: () => string): string {
  return input ?? fallback();
}

function isReviewUnit(unit: Pick<WorkUnit, "role">): boolean {
  return unit.role === "review";
}

function normalizeVerdict(value: unknown): ReviewVerdict | null {
  if (value === "approved" || value === "rejected" || value === "revisions_required") return value;
  return null;
}

type CanonicalAnswer = {
  content: string;
  evidenceJson: Record<string, unknown>;
  taskId?: string | null;
  invalidTaskId?: boolean;
  invalidEvidenceJson?: boolean;
};

function canonicalAnswerOf(snapshot: ChildTaskSnapshot): CanonicalAnswer | null {
  const source = snapshot.canonicalAnswer ?? snapshot.answer ?? snapshot.canonicalFinalAnswer;
  if (typeof source === "string") {
    const content = clean(source);
    return content ? { content, evidenceJson: {} } : null;
  }
  if (!isObject(source)) return null;
  const content = clean(source.content ?? source.answer ?? source.text);
  if (!content) return null;
  const evidenceValue = source.evidenceJson !== undefined ? source.evidenceJson : source.evidence;
  const invalidEvidenceJson = evidenceValue !== undefined && !isObject(evidenceValue);
  const taskId = source.taskId;
  if (taskId !== undefined && taskId !== null && typeof taskId !== "string") {
    return {
      content,
      evidenceJson: isObject(evidenceValue) ? redactSecretsDeep(evidenceValue) as Record<string, unknown> : {},
      invalidTaskId: true,
      ...(invalidEvidenceJson ? { invalidEvidenceJson: true } : {}),
    };
  }
  return {
    content,
    ...(taskId !== undefined ? { taskId } : {}),
    evidenceJson: isObject(evidenceValue) ? redactSecretsDeep(evidenceValue) as Record<string, unknown> : {},
    ...(invalidEvidenceJson ? { invalidEvidenceJson: true } : {}),
  };
}

function verificationOf(snapshot: ChildTaskSnapshot, evidenceJson: Record<string, unknown>): ChildVerification | null {
  const explicit = snapshot.verification ?? snapshot.verifications?.at(-1);
  if (explicit) return explicit;
  const embedded = evidenceJson.verification;
  return isObject(embedded) ? embedded as ChildVerification : null;
}

function verificationPassed(verification: ChildVerification | null): boolean {
  if (!verification || verification.passed === false || verification.completed === false) return false;
  if (verification.exitCode !== undefined && verification.exitCode !== 0) return false;
  if (verification.status !== undefined && !["passed", "verified"].includes(verification.status)) return false;
  return verification.passed === true || verification.status === "passed" || verification.status === "verified" || verification.exitCode === 0;
}

function evidenceOf(snapshot: ChildTaskSnapshot, evidenceJson: Record<string, unknown>): ChildEvidence[] {
  const explicit = snapshot.evidence ?? snapshot.evidenceRecords;
  if (explicit) return explicit.flatMap((item) => typeof item === "string" ? [{ id: item, evidenceRef: item }] : [{ ...item }]);
  const observations = evidenceJson.durableObservations ?? evidenceJson.readOnlyObservations ?? evidenceJson.evidence ?? evidenceJson.evidenceRefs;
  if (!Array.isArray(observations)) return [];
  return observations.flatMap((item) => typeof item === "string" ? [{ id: item, evidenceRef: item }] : isObject(item) ? [{
    ...(typeof item.id === "string" ? { id: item.id } : {}),
    ...(typeof item.evidenceRef === "string" ? { evidenceRef: item.evidenceRef } : {}),
    ...(typeof item.independentlyObserved === "boolean" ? { independentlyObserved: item.independentlyObserved } : {}),
    ...(typeof item.durable === "boolean" ? { durable: item.durable } : {}),
  }] : []);
}

function artifactFromUnknown(value: unknown): ChildArtifact | null {
  if (typeof value === "string") return { contentHash: value };
  if (!isObject(value)) return null;
  const contentHash = value.contentHash ?? value.hash ?? value.sha256;
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof contentHash === "string" ? { contentHash } : {}),
    ...(typeof value.evidenceRef === "string" ? { evidenceRef: value.evidenceRef } : {}),
    ...(typeof value.independentlyObserved === "boolean" ? { independentlyObserved: value.independentlyObserved } : {}),
    ...(typeof value.durable === "boolean" ? { durable: value.durable } : {}),
  };
}

function artifactsOf(snapshot: ChildTaskSnapshot, evidenceJson: Record<string, unknown>): ChildArtifact[] {
  const explicit = snapshot.artifacts ?? snapshot.artifactHashes;
  if (explicit) return explicit.flatMap((item) => artifactFromUnknown(item)).filter((item): item is ChildArtifact => item !== null);
  const completion = evidenceJson.completion;
  const values = isObject(completion) && Array.isArray(completion.durableArtifacts)
    ? completion.durableArtifacts
    : evidenceJson.artifactHashes ?? evidenceJson.artifacts;
  if (!Array.isArray(values)) return [];
  return values.flatMap((item) => artifactFromUnknown(item)).filter((item): item is ChildArtifact => item !== null);
}

function reviewVerdictOf(snapshot: ChildTaskSnapshot, evidenceJson: Record<string, unknown>): ReviewVerdict | null {
  const embeddedReview = isObject(evidenceJson.review) ? evidenceJson.review.verdict : undefined;
  return normalizeVerdict(snapshot.reviewVerdict ?? snapshot.review?.verdict ?? evidenceJson.reviewVerdict ?? embeddedReview);
}

function validateImportedChild(
  snapshot: ChildTaskSnapshot,
  reviewUnit: boolean,
): { canonical: { content: string; evidenceJson: Record<string, unknown> }; verification: ChildVerification; evidence: ChildEvidence[]; artifacts: ChildArtifact[]; verdict: ReviewVerdict | null; reasons: string[] } {
  const reasons: string[] = [];
  const canonical = canonicalAnswerOf(snapshot);
  if (!canonical) {
    reasons.push("canonical_answer_missing");
  }
  if (canonical?.invalidTaskId) reasons.push("canonical_answer_task_id_invalid");
  if (canonical?.invalidEvidenceJson) reasons.push("canonical_evidence_malformed");
  if (canonical?.taskId !== undefined && canonical.taskId !== null && canonical.taskId !== snapshot.id) reasons.push("canonical_answer_owner_mismatch");
  const evidenceJson = canonical?.evidenceJson ?? {};
  if (!clean(evidenceJson.sourceTurnKey) || !Number.isSafeInteger(evidenceJson.durableEventCursor) || Number(evidenceJson.durableEventCursor) < 1) reasons.push("canonical_cursor_invalid");
  if (evidenceJson.requirementsSatisfied !== true) reasons.push("canonical_requirements_unsatisfied");
  if (evidenceJson.status !== "completed" && evidenceJson.status !== "verified") reasons.push("canonical_status_invalid");
  const completion = isObject(evidenceJson.completion) ? evidenceJson.completion : null;
  if (completion?.complete === false) reasons.push("canonical_completion_incomplete");
  if (evidenceJson.requirementsSatisfied !== undefined && evidenceJson.requirementsSatisfied !== true) reasons.push("canonical_requirements_unsatisfied");
  if (evidenceJson.status !== undefined && evidenceJson.status !== "completed" && evidenceJson.status !== "verified") reasons.push("canonical_status_invalid");
  if (evidenceJson.unresolvedBlocker) reasons.push("canonical_unresolved_blocker");
  if (Array.isArray(evidenceJson.unresolvedFailures) && evidenceJson.unresolvedFailures.length > 0) reasons.push("canonical_unresolved_failure");

  const verification = verificationOf(snapshot, evidenceJson);
  if (!verification || !verificationPassed(verification)) reasons.push("verification_not_passed");
  const evidence = evidenceOf(snapshot, evidenceJson);
  if (evidence.length === 0) reasons.push("evidence_missing");
  else if (evidence.some((item) => item.independentlyObserved === false || item.durable === false || (!item.id && !item.evidenceRef && !item.path))) reasons.push("evidence_not_durable");

  const artifacts = artifactsOf(snapshot, evidenceJson);
  if (artifacts.length === 0) {
    reasons.push("artifact_hash_missing");
  } else {
    for (const artifact of artifacts) {
      // Hashes are deliberately checked as algorithm:value, while the value
      // alphabet remains permissive enough for providers that use base64url.
      if (!artifact.contentHash || !/^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9+/=_-]+$/.test(artifact.contentHash)) reasons.push("artifact_hash_invalid");
      if (artifact.independentlyObserved === false || artifact.durable === false) reasons.push("artifact_not_durable");
    }
  }

  const verdict = reviewVerdictOf(snapshot, evidenceJson);
  if (reviewUnit && verdict !== "approved") reasons.push("review_not_approved");
  // Keep one reason per class. This makes diagnostics deterministic and keeps
  // a malformed provider response from becoming an unbounded result payload.
  return {
    canonical: canonical ?? { content: "", evidenceJson },
    verification: verification ?? {},
    evidence,
    artifacts,
    verdict,
    reasons: [...new Set(reasons)],
  };
}

function childFailureDisposition(status: string): WorkUnitTerminalDisposition {
  if (status === "blocked") return "blocked";
  if (status === "cancelled") return "cancelled";
  if (status === "rejected") return "rejected";
  return "failed";
}

function childFailureResult(snapshot: ChildTaskSnapshot): Record<string, unknown> {
  return {
    childTaskId: snapshot.id,
    authoritativeChildStatus: snapshot.status,
    ...(snapshot.failure ? { failure: redactSecrets(snapshot.failure) } : {}),
  };
}

function extractChildTaskId(result: SpawnChildResult): string {
  if (typeof result === "string") return clean(result);
  if (isObject(result)) {
    const task = isObject(result.task) ? result.task.id : undefined;
    const id = result.childTaskId ?? result.taskId ?? result.id ?? task;
    return clean(id);
  }
  return "";
}

/**
 * Build the production child reader from the existing authoritative task
 * records. Routes can inject a narrower reader in tests or adapters, while
 * this default ensures the service never accepts model narration as proof.
 */
export function readAuthoritativeChildTask(db: Database.Database): ReadChild {
  const tasks = taskRepository(db);
  const records = taskRecordsRepository(db);
  const continuity = executionContinuityRepository(db);
  return (childTaskId) => {
    const task = tasks.getTaskById(childTaskId);
    if (!task) return null;
    const canonical = continuity.getCanonicalAnswer(childTaskId);
    const evidence = records.listEvidence(childTaskId).map((item) => ({
      id: item.id,
      path: item.path,
      independentlyObserved: true,
      durable: true,
      metadata: item.metadata,
    }));
    const artifacts = evidence.flatMap((item) => {
      const metadata = item.metadata ?? {};
      const rawHash = metadata.contentHash ?? metadata.sha256;
      if (typeof rawHash !== "string" || !rawHash.trim()) return [];
      const contentHash = rawHash.includes(":") ? rawHash : `sha256:${rawHash}`;
      return [{ path: item.path, contentHash, independentlyObserved: true, durable: true }];
    });
    const expected = db.prepare("SELECT expected_agent_profile_hash FROM tasks WHERE id=?").get(task.id) as { expected_agent_profile_hash?: string | null } | undefined;
    return {
      id: task.id,
      parentTaskId: task.parentTaskId,
      status: task.status,
      ...(task.agentId !== undefined ? { agentId: task.agentId } : {}),
      ...(expected?.expected_agent_profile_hash ? { ownerProfileHash: expected.expected_agent_profile_hash } : {}),
      ...(task.agentId && expected?.expected_agent_profile_hash ? { policyFingerprint: `policy:${digest({ ownerId: task.agentId, ownerProfileHash: expected.expected_agent_profile_hash })}` } : {}),
      canonicalAnswer: canonical
        ? { content: canonical.content, evidenceJson: canonical.evidenceJson, taskId: canonical.taskId }
        : null,
      ...(records.getVerification(childTaskId) ? { verification: records.getVerification(childTaskId)! } : {}),
      evidence,
      artifacts,
    };
  };
}

function authoritativeProfileReader(db: Database.Database): (ownerId: string) => AgentProfileSnapshot | null {
  const agents = agentsRepository(db);
  return (ownerId) => {
    const agent: Agent | undefined = agents.get(ownerId);
    if (!agent) return null;
    return {
      enabled: agent.enabled,
      profileHash: teammateProfileFingerprint(agent, agents.listToolPermissions(ownerId)),
    };
  };
}

export class WorkGraphOrchestrator {
  readonly repository: WorkGraphRepository;
  private readonly spawnChild: SpawnChild;
  private readonly readChild: ReadChild;
  private readonly getAgentProfile: ((ownerId: string) => AgentProfileSnapshot | null | undefined) | undefined;
  private readonly synthesizeFn: Synthesize;
  private readonly findChildByAdmissionId?: WorkGraphOrchestratorDependencies["findChildByAdmissionId"];
  private readonly now: () => string;
  private readonly spawnInflight = new Map<string, Promise<WorkUnit>>();

  constructor(dependencies: WorkGraphOrchestratorDependencies) {
    this.repository = dependencies.repository ?? (dependencies.db ? workGraphsRepository(dependencies.db) : (() => {
      throw new WorkGraphOrchestrationError("REPOSITORY_REQUIRED", "A work graph repository or database is required");
    })());
    this.spawnChild = dependencies.spawnChild;
    this.findChildByAdmissionId = dependencies.findChildByAdmissionId ?? (dependencies.db ? async (admissionId) => {
      const row = dependencies.db!.prepare("SELECT parent_task_id FROM work_graph_units WHERE admission_id=?").get(admissionId) as { parent_task_id?: string } | undefined;
      const parent = taskRepository(dependencies.db!).getTaskById(row?.parent_task_id ?? "");
      if (!parent) return null;
      return taskRepository(dependencies.db!).findByIdempotencyKey(parent.projectId, admissionId)?.id ?? null;
    } : undefined);
    if (dependencies.readChild) this.readChild = dependencies.readChild;
    else if (dependencies.db) this.readChild = readAuthoritativeChildTask(dependencies.db);
    else throw new WorkGraphOrchestrationError("CHILD_READER_REQUIRED", "An authoritative child reader is required");
    this.getAgentProfile = dependencies.getAgentProfile ?? (dependencies.db ? authoritativeProfileReader(dependencies.db) : undefined);
    this.synthesizeFn = dependencies.synthesize ?? ((input) => ({
      graphId: input.graphId,
      parentTaskId: input.parentTaskId,
      units: input.units.map((unit) => ({ id: unit.id, position: unit.position, result: unit.result })),
    }));
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  /** Functional alias for callers that prefer a factory-style service. */
  static create(dependencies: WorkGraphOrchestratorDependencies): WorkGraphOrchestrator {
    return new WorkGraphOrchestrator(dependencies);
  }

  private profileFor(ownerId: string, expectedHash: string, requireEnabled = true): AgentProfileSnapshot | null {
    // A caller that supplies a profile reader is asking this boundary to bind
    // execution to the authoritative roster. A missing row must not silently
    // degrade into trusting the hash supplied in the decomposition request.
    if (!this.getAgentProfile) return null;
    const profile = this.getAgentProfile?.(ownerId);
    if (!profile) throw new WorkGraphOrchestrationError("OWNER_NOT_FOUND", `Work graph owner ${ownerId} was not found`);
    if (requireEnabled && !profile.enabled) {
      throw new WorkGraphOrchestrationError("OWNER_DISABLED", `Work graph owner ${ownerId} is disabled`);
    }
    if (expectedHash && profile.profileHash !== expectedHash) {
      throw new WorkGraphOrchestrationError("OWNER_PROFILE_CHANGED", `Work graph owner ${ownerId} profile changed`);
    }
    return profile;
  }

  private normalizeDefinitions(input: WorkGraphDecompositionInput, graphId: string): CreateWorkUnitInput[] {
    if (!clean(input.parentTaskId)) throw new WorkGraphOrchestrationError("PARENT_REQUIRED", "A parent task id is required");
    if (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency < 1) throw new WorkGraphOrchestrationError("CONCURRENCY_INVALID", "maxConcurrency must be a positive integer");
    if (input.units.length === 0) throw new WorkGraphOrchestrationError("UNITS_REQUIRED", "At least one work unit is required");

    type Draft = { source: WorkGraphUnitDefinition; key: string; sourceIndex: number; position: number | null; role: WorkGraphUnitRole };
    const drafts: Draft[] = input.units.map((source, sourceIndex) => {
      const key = clean(source.key ?? source.id ?? source.idempotencyKey ?? `position:${source.position ?? sourceIndex}`);
      if (!key) throw new WorkGraphOrchestrationError("UNIT_KEY_REQUIRED", "Every work unit needs a stable key");
      if (source.position !== undefined && (!Number.isInteger(source.position) || source.position < 0)) throw new WorkGraphOrchestrationError("POSITION_INVALID", `Work unit ${key} position must be a non-negative integer`);
      const role = source.role ?? "work";
      if (source.enabled === false) throw new WorkGraphOrchestrationError("OWNER_DISABLED", `Work graph owner ${source.ownerId} is disabled`);
      if (!clean(source.objective)) throw new WorkGraphOrchestrationError("OBJECTIVE_REQUIRED", `Work unit ${key} requires an objective`);
      return { source, key, sourceIndex, position: source.position ?? null, role };
    });
    drafts.sort((left, right) => {
      const leftPosition = left.position ?? Number.MAX_SAFE_INTEGER;
      const rightPosition = right.position ?? Number.MAX_SAFE_INTEGER;
      return leftPosition - rightPosition || left.key.localeCompare(right.key) || left.sourceIndex - right.sourceIndex;
    });

    const keys = new Set<string>();
    const ids = new Set<string>();
    const idempotencyKeys = new Set<string>();
    const keyToId = new Map<string, string>();
    const normalized: CreateWorkUnitInput[] = [];
    for (const [index, draft] of drafts.entries()) {
      const source = draft.source;
      if (keys.has(draft.key)) throw new WorkGraphOrchestrationError("DUPLICATE_UNIT", `Duplicate work unit key ${draft.key}`);
      keys.add(draft.key);
      const requestedId = clean(source.id);
      const id = draft.role === "review"
        ? (requestedId ? (requestedId.startsWith("review:") ? requestedId : `review:${requestedId}`) : `review:${draft.key}`)
        : (requestedId || `unit:${draft.key}`);
      const requestedKey = clean(source.idempotencyKey);
      const idempotencyKey = draft.role === "review"
        ? (requestedKey ? (requestedKey.startsWith("review:") ? requestedKey : `review:${requestedKey}`) : `review:${draft.key}`)
        : (requestedKey || `unit:${draft.key}`);
      if (!id || ids.has(id)) throw new WorkGraphOrchestrationError("DUPLICATE_UNIT", `Duplicate work unit id ${id || draft.key}`);
      if (!idempotencyKey || idempotencyKeys.has(idempotencyKey)) throw new WorkGraphOrchestrationError("DUPLICATE_UNIT", `Duplicate work unit idempotency key ${idempotencyKey || draft.key}`);
      ids.add(id);
      idempotencyKeys.add(idempotencyKey);
      keyToId.set(draft.key, id);
      const ownerId = clean(source.ownerId);
      const ownerProfileHash = clean(source.ownerProfileHash ?? source.profileHash);
      if (!ownerId || !ownerProfileHash) throw new WorkGraphOrchestrationError("OWNER_IDENTITY_REQUIRED", `Work unit ${draft.key} requires owner and profile identity`);
      const policyFingerprint = clean(source.policyFingerprint) || `policy:${digest({ ownerId, ownerProfileHash })}`;
      const derivedPolicyFingerprint = `policy:${digest({ ownerId, ownerProfileHash })}`;
      if (clean(source.policyFingerprint) && policyFingerprint !== derivedPolicyFingerprint) {
        throw new WorkGraphOrchestrationError("POLICY_MISMATCH", `Work unit ${draft.key} policy fingerprint does not match owner profile`);
      }
      normalized.push({
        id,
        graphId,
        parentTaskId: input.parentTaskId,
        position: draft.position ?? index,
        idempotencyKey,
        ownerId,
        ownerProfileHash,
        policyFingerprint,
        objective: clean(source.objective),
        role: draft.role,
        required: source.required !== false,
        dependsOn: [],
      });
    }

    for (const [index, draft] of drafts.entries()) {
      const source = draft.source;
      const dependencyNames = [...(source.dependsOn ?? []), ...(source.dependencyIds ?? [])].map(clean);
      const dependencyIds = [...new Set(dependencyNames.map((name) => keyToId.get(name) ?? name))];
      if (dependencyIds.includes(normalized[index]!.id)) throw new WorkGraphOrchestrationError("DEPENDENCY_CYCLE", `Work unit ${draft.key} cannot depend on itself`);
      normalized[index] = { ...normalized[index]!, dependsOn: dependencyIds };
    }
    return normalized;
  }

  private addReviewer(input: WorkGraphDecompositionInput, graphId: string, definitions: CreateWorkUnitInput[]): void {
    if (!input.reviewer) return;
    const reviewer = input.reviewer;
    const key = clean(reviewer.key ?? reviewer.id ?? reviewer.idempotencyKey ?? "review");
    const ownerId = clean(reviewer.ownerId);
    const requestedHash = clean(reviewer.ownerProfileHash ?? reviewer.profileHash);
    const profile = this.profileFor(ownerId, requestedHash, true);
    const ownerProfileHash = profile?.profileHash ?? requestedHash;
    if (!ownerId || !ownerProfileHash) throw new WorkGraphOrchestrationError("OWNER_IDENTITY_REQUIRED", "Reviewer requires owner and profile identity");
    if (reviewer.enabled === false) throw new WorkGraphOrchestrationError("OWNER_DISABLED", `Reviewer ${ownerId} is disabled`);
    if (definitions.some((unit) => unit.ownerId === ownerId || unit.ownerProfileHash === ownerProfileHash)) {
      throw new WorkGraphOrchestrationError("REVIEWER_NOT_INDEPENDENT", "Reviewer owner and profile must both differ from every producing unit");
    }
    const reviewerId = clean(reviewer.id) || `review:${key}`;
    const reviewerKey = `review:${key}`;
    if (definitions.some((unit) => unit.id === reviewerId || unit.idempotencyKey === reviewerKey)) throw new WorkGraphOrchestrationError("DUPLICATE_UNIT", `Duplicate reviewer key ${key}`);
    const policyFingerprint = clean(reviewer.policyFingerprint) || `policy:${digest({ ownerId, ownerProfileHash })}`;
    const derivedPolicyFingerprint = `policy:${digest({ ownerId, ownerProfileHash })}`;
    if (clean(reviewer.policyFingerprint) && policyFingerprint !== derivedPolicyFingerprint) {
      throw new WorkGraphOrchestrationError("POLICY_MISMATCH", "Reviewer policy fingerprint does not match owner profile");
    }
    definitions.push({
      id: reviewerId,
      graphId,
      parentTaskId: input.parentTaskId,
      position: Math.max(...definitions.map((unit) => unit.position), -1) + 1,
      idempotencyKey: reviewerKey,
      ownerId,
      ownerProfileHash,
      policyFingerprint,
      objective: clean(reviewer.objective) || `Review the ${clean(input.objective) || "completed work"} independently`,
      role: "review",
      required: true,
      dependsOn: definitions.filter((unit) => unit.required !== false).map((unit) => unit.id),
    });
  }

  /** Deterministically create or replay a parent-owned graph decomposition. */
  decompose(input: WorkGraphDecompositionInput): WorkGraphDecomposition {
    const parentTaskId = clean(input.parentTaskId);
    const graphId = clean(input.graphId) || `work-graph:${parentTaskId}`;
    const definitions = this.normalizeDefinitions({ ...input, parentTaskId }, graphId);
    this.addReviewer({ ...input, parentTaskId }, graphId, definitions);
    const graph = this.repository.createGraph({ id: graphId, parentTaskId, maxConcurrency: input.maxConcurrency, ...(input.createdAt ? { createdAt: input.createdAt, updatedAt: input.createdAt } : {}) });
    const units = this.repository.createUnits(graph.id, definitions);
    return { graph: this.repository.get(graph.id) ?? graph, units: this.repository.listUnits(graph.id) };
  }

  /** Alias used by controller adapters that call decomposition `create`. */
  create(input: WorkGraphDecompositionInput): WorkGraphDecomposition {
    return this.decompose(input);
  }

  private async spawnAdmittedOnce(graph: WorkGraph, unit: WorkUnit, dispatcherId = "work-graph-dispatcher"): Promise<WorkUnit> {
    if (unit.childTaskId) {
      if (unit.status === "admitted") return this.repository.markRunning(graph.id, unit.id, this.now());
      return unit;
    }
    this.validateAdmission(unit);
    const claimed = this.repository.claimSpawn(graph.id, unit.id, dispatcherId, this.now(), 60_000);
    if (!claimed) return this.repository.getUnit(graph.id, unit.id) ?? unit;
    if (claimed.childTaskId) return claimed.status === "admitted" ? this.repository.markRunning(graph.id, claimed.id, this.now()) : claimed;
    const admissionId = claimed.admissionId ?? `admission:${graph.id}:${unit.id}`;
    if (!this.findChildByAdmissionId && this.getAgentProfile) {
      throw new WorkGraphOrchestrationError("CHILD_LOOKUP_REQUIRED", "Production child spawning requires durable admission lookup");
    }
    if (this.findChildByAdmissionId) {
      const existing = clean(await this.findChildByAdmissionId(admissionId));
      if (existing) {
        const attached = this.repository.attachChild(graph.id, unit.id, existing, this.now());
        return attached.status === "admitted" ? this.repository.markRunning(graph.id, attached.id, this.now()) : attached;
      }
    }
    const child = extractChildTaskId(await this.spawnChild({
      graphId: graph.id,
      parentTaskId: graph.parentTaskId,
      unitId: unit.id,
      idempotencyKey: admissionId,
      admissionId,
      ownerId: unit.ownerId,
      ownerProfileHash: unit.ownerProfileHash,
      policyFingerprint: unit.policyFingerprint,
      objective: unit.objective,
      role: isReviewUnit(claimed) ? "review" : "work",
      dependencyIds: this.repository.listDependencies(graph.id, unit.id),
    }));
    if (!child) throw new WorkGraphOrchestrationError("CHILD_ID_REQUIRED", `Child spawn for work unit ${unit.id} returned no task id`);
    const attached = this.repository.attachChild(graph.id, unit.id, child, this.now());
    return attached.status === "admitted" ? this.repository.markRunning(graph.id, attached.id, this.now()) : attached;
  }

  private validateAdmission(unit: Pick<WorkUnit, "ownerId" | "ownerProfileHash" | "policyFingerprint">): void {
    if (!clean(unit.ownerId) || !clean(unit.ownerProfileHash) || !clean(unit.policyFingerprint)) {
      throw new WorkGraphOrchestrationError("OWNER_IDENTITY_REQUIRED", "Work graph admission requires owner, profile, and policy identity");
    }
    this.profileFor(unit.ownerId, unit.ownerProfileHash, true);
  }

  private async spawnAdmitted(graph: WorkGraph, unit: WorkUnit, dispatcherId = "work-graph-dispatcher"): Promise<WorkUnit> {
    if (unit.childTaskId) {
      if (unit.status === "admitted") return this.repository.markRunning(graph.id, unit.id, this.now());
      return unit;
    }
    const key = `${graph.id}:${unit.id}`;
    const existing = this.spawnInflight.get(key);
    if (existing) return existing;
    const operation = this.spawnAdmittedOnce(graph, unit, dispatcherId);
    this.spawnInflight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.spawnInflight.get(key) === operation) this.spawnInflight.delete(key);
    }
  }

  private async recoverUnattached(graph: WorkGraph, dispatcherId = "work-graph-dispatcher"): Promise<WorkUnit[]> {
    const recovered: WorkUnit[] = [];
    const active = this.repository.listUnits(graph.id).filter((unit) =>
      (unit.status === "admitted" || unit.status === "running") && !unit.childTaskId,
    );
    for (const unit of active) recovered.push(await this.spawnAdmitted(graph, unit, dispatcherId));
    return recovered;
  }

  /**
   * Dispatch ready units in deterministic order. Admission is a repository
   * CAS; spawn happens only after a slot is durably reserved, and retries use
   * the same admission/idempotency key. An exception leaves the admitted unit
   * recoverable and is intentionally surfaced to the caller.
   */
  async dispatchReady(graphId: string, options: { dispatcherId?: string; maxUnits?: number } = {}): Promise<WorkUnit[]> {
    const graph = this.repository.get(graphId);
    if (!graph) throw new WorkGraphOrchestrationError("GRAPH_NOT_FOUND", `Work graph not found: ${graphId}`);
    const dispatched = await this.recoverUnattached(graph, options.dispatcherId);
    const maxUnits = options.maxUnits === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(options.maxUnits));
    const dispatcherId = clean(options.dispatcherId) || "work-graph-dispatcher";
    if (dispatched.length >= maxUnits) return dispatched.slice(0, maxUnits);
    for (const candidate of this.repository.listReady(graphId)) {
      if (dispatched.length >= maxUnits) break;
      // Validate the live owner before the repository CAS reserves a slot. A
      // missing/disabled/changed profile is retryable, but must not strand an
      // active-count reservation that has no child to recover.
      this.validateAdmission(candidate);
      const admissionId = `admission:${graphId}:${candidate.id}`;
      const admitted = this.repository.admit(graphId, candidate.id, dispatcherId, this.now(), admissionId);
      if (!admitted) continue;
      dispatched.push(await this.spawnAdmitted(graph, admitted));
    }
    return dispatched;
  }

  private unitFor(graphId: string, unitOrChildId: string): WorkUnit {
    const direct = this.repository.getUnit(graphId, unitOrChildId);
    if (direct) return direct;
    const child = this.repository.listUnits(graphId).find((unit) => unit.childTaskId === unitOrChildId);
    if (child) return child;
    throw new WorkGraphOrchestrationError("UNIT_NOT_FOUND", `Work graph unit not found: ${unitOrChildId}`);
  }

  /** Import exactly one authoritative child settlement into its unit. */
  async settleChild(graphId: string, unitOrChildId: string): Promise<ChildSettlement> {
    const current = this.unitFor(graphId, unitOrChildId);
    if (!current.childTaskId) return { state: "pending", unit: current, childTaskId: null, reasons: ["child_not_attached"] };
    if (current.resultCursor > 0 && (current.status === "verified" || current.status === "failed" || current.status === "blocked" || current.status === "cancelled" || current.status === "rejected")) {
      return { state: current.status === "rejected" ? "rejected" : current.status === "verified" ? "imported" : "settled", unit: current, childTaskId: current.childTaskId, reasons: [] };
    }
    const snapshot = await this.readChild(current.childTaskId);
    if (!snapshot) return { state: "pending", unit: current, childTaskId: current.childTaskId, reasons: ["child_not_found"] };
    if (snapshot.id !== current.childTaskId || snapshot.parentTaskId !== current.parentTaskId) {
      throw new WorkGraphOrchestrationError("CHILD_OWNERSHIP_INVALID", `Child ${current.childTaskId} is not owned by parent task ${current.parentTaskId}`);
    }
    const status = clean(snapshot.status).toLowerCase();
    if (!TERMINAL_CHILD_STATUSES.has(status)) return { state: "pending", unit: current, childTaskId: current.childTaskId, reasons: ["child_not_terminal"] };
    if (snapshot.agentId !== undefined && snapshot.agentId !== null && clean(snapshot.agentId) !== current.ownerId) {
      const reasons = ["child_owner_mismatch"];
      const rejected = this.repository.markTerminal(graphId, current.id, "rejected", {
        childTaskId: snapshot.id,
        authoritativeChildStatus: status,
        importRejected: true,
        reasons,
      }, this.now());
      return { state: "rejected", unit: rejected, childTaskId: current.childTaskId, reasons };
    }
    if (!clean(snapshot.agentId)
      || !clean(snapshot.ownerProfileHash)
      || !clean(snapshot.policyFingerprint)
      || clean(snapshot.agentId) !== current.ownerId
      || clean(snapshot.ownerProfileHash) !== current.ownerProfileHash
      || clean(snapshot.policyFingerprint) !== current.policyFingerprint) {
      const reasons = ["child_identity_mismatch"];
      const rejected = this.repository.markTerminal(graphId, current.id, "rejected", {
        childTaskId: snapshot.id, authoritativeChildStatus: status, importRejected: true, reasons,
      }, this.now());
      return { state: "rejected", unit: rejected, childTaskId: current.childTaskId, reasons };
    }
    if (FAILURE_CHILD_STATUSES.has(status)) {
      const disposition = childFailureDisposition(status);
      const result = childFailureResult(snapshot);
      const terminal = this.repository.markTerminal(graphId, current.id, disposition, result, this.now());
      // A failed child is authoritative terminal state, but is not a verified
      // result import. Leaving its result cursor at zero prevents it from
      // satisfying the aggregate barrier while the terminal disposition still
      // blocks synthesis deterministically.
      return { state: disposition === "rejected" ? "rejected" : "settled", unit: terminal, childTaskId: current.childTaskId, reasons: ["child_terminal_failure"] };
    }

    const validated = validateImportedChild(snapshot, isReviewUnit(current));
    if (validated.reasons.length > 0) {
      const result = {
        childTaskId: snapshot.id,
        authoritativeChildStatus: status,
        importRejected: true,
        reasons: validated.reasons,
      };
      const rejected = this.repository.markTerminal(graphId, current.id, "rejected", result, this.now());
      // Rejection is a durable terminal disposition, not a child-result
      // import. The missing cursor is intentional and makes the distinction
      // visible to fan-in callers and recovery.
      return { state: "rejected", unit: rejected, childTaskId: current.childTaskId, reasons: validated.reasons };
    }

    const result = redactSecretsDeep({
      childTaskId: snapshot.id,
      canonicalAnswer: validated.canonical,
      verification: validated.verification,
      evidence: validated.evidence,
      artifacts: validated.artifacts,
      ...(validated.verdict ? { reviewVerdict: validated.verdict } : {}),
    });
    const terminal = this.repository.markTerminal(graphId, current.id, "verified", result, this.now());
    const imported = this.repository.recordResult(graphId, current.id, result, this.now());
    return { state: "imported", unit: imported ?? terminal, childTaskId: current.childTaskId, reasons: [] };
  }

  /** Settle attached children in deterministic `(position,id)` order. */
  async settleChildren(graphId: string): Promise<ChildSettlement[]> {
    const units = this.repository.listUnits(graphId).filter((unit) => unit.childTaskId);
    const settlements: ChildSettlement[] = [];
    for (const unit of units) settlements.push(await this.settleChild(graphId, unit.id));
    return settlements;
  }

  /**
   * Restart-safe bounded reconciliation. It repeatedly settles attached
   * children and dispatches newly released dependencies, but never loops on a
   * graph that made no durable state change.
   */
  async resume(graphId: string): Promise<WorkGraphDecomposition> {
    const graph = this.repository.get(graphId);
    if (!graph) throw new WorkGraphOrchestrationError("GRAPH_NOT_FOUND", `Work graph not found: ${graphId}`);
    const maxPasses = Math.max(2, this.repository.listUnits(graphId).length * 2 + 2);
    for (let pass = 0; pass < maxPasses; pass++) {
      const before = JSON.stringify(this.repository.listUnits(graphId).map((unit) => [unit.id, unit.status, unit.childTaskId, unit.resultCursor]));
      await this.dispatchReady(graphId);
      await this.settleChildren(graphId);
      await this.dispatchReady(graphId);
      const after = JSON.stringify(this.repository.listUnits(graphId).map((unit) => [unit.id, unit.status, unit.childTaskId, unit.resultCursor]));
      if (before === after) break;
    }
    return { graph: this.repository.get(graphId)!, units: this.repository.listUnits(graphId) };
  }

  /** Alias used by restart/recovery adapters. */
  run(graphId: string): Promise<WorkGraphDecomposition> {
    return this.resume(graphId);
  }

  /** Claim and synthesize the ordered, verified fan-in exactly once. */
  async synthesize(graphId: string, options: { ownerId?: string; leaseMs?: number } = {}): Promise<SynthesisOutcome> {
    const graph = this.repository.get(graphId);
    if (!graph) throw new WorkGraphOrchestrationError("GRAPH_NOT_FOUND", `Work graph not found: ${graphId}`);
    const units = this.repository.listUnits(graphId);
    const required = units.filter((unit) => unit.required).sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    const reasons: string[] = [];
    const pending = required.filter((unit) => !["succeeded", "completed", "verified", "failed", "blocked", "cancelled", "rejected"].includes(unit.status) || unit.resultCursor < 1);
    if (pending.length > 0) reasons.push("required_units_pending");
    const failed = required.filter((unit) => ["failed", "blocked", "cancelled", "rejected"].includes(unit.status));
    if (failed.length > 0) reasons.push("required_unit_failed");
    const reviewers = required.filter((unit) => isReviewUnit(unit));
    const rejectedReviews = reviewers.filter((unit) => unit.status === "rejected" || (isObject(unit.result) && unit.result.reviewVerdict !== "approved"));
    if (rejectedReviews.length > 0) reasons.push("review_rejected");
    const incompleteReviews = reviewers.filter((unit) => unit.status !== "verified" || !isObject(unit.result) || unit.result.reviewVerdict !== "approved");
    if (incompleteReviews.length > 0 && rejectedReviews.length === 0) reasons.push("review_not_approved");

    if (reasons.length > 0) {
      const state = reasons.includes("required_unit_failed") || reasons.includes("review_rejected") ? "blocked" : "pending";
      return { state, graph: this.repository.get(graphId)!, result: undefined, reasons: [...new Set(reasons)], units: required };
    }
    if (graph.fanInState === "completed") return { state: "completed", graph, result: graph.aggregateResult, reasons: [], units: required };

    const claim = this.repository.claimAggregate(graphId, clean(options.ownerId) || "work-graph-synthesizer", this.now(), options.leaseMs ?? 60_000);
    if (!claim) {
      const current = this.repository.get(graphId)!;
      return { state: current.fanInState === "completed" ? "completed" : "claimed", graph: current, reasons: ["aggregate_claim_unavailable"], units: required };
    }
    const orderedUnits = claim.units.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    // Core fan-in is deterministic and side-effect free. Integrations can
    // consume the persisted aggregate after completion; invoking an external
    // callback here would be unsafe across a crash between callback and commit.
    const result = {
      graphId,
      parentTaskId: graph.parentTaskId,
      units: orderedUnits.map((unit) => ({ id: unit.id, position: unit.position, result: unit.result })),
    };
    const completed = this.repository.completeAggregate(graphId, claim.claimId, claim.ownerId, this.now(), result);
    if (!completed) throw new WorkGraphOrchestrationError("SYNTHESIS_CLAIM_LOST", `Synthesis claim for graph ${graphId} was lost before completion`);
    return { state: "completed", graph: completed, result, reasons: [], units: orderedUnits };
  }
}

/** Factory alias for dependency-injected callers. */
export function workGraphOrchestrator(dependencies: WorkGraphOrchestratorDependencies): WorkGraphOrchestrator {
  return new WorkGraphOrchestrator(dependencies);
}
