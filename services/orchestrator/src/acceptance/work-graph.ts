import { WORKING_SET_DEFAULTS } from "../execution/conversation-working-set.js";

/** Semantic fields that must survive an oversized execution checkpoint. */
export const REQUIRED_RECOVERY_CAPSULE_CATEGORIES = [
  "objective",
  "requirements",
  "criteria",
  "decisions",
  "completedWork",
  "changedFiles",
  "unresolvedFailures",
  "recoveryAttempts",
  "approvals",
  "routing",
  "acceptanceCriteria",
  "nextPendingWork",
] as const;

export type RecoveryCapsuleCategory = (typeof REQUIRED_RECOVERY_CAPSULE_CATEGORIES)[number];

/** The fixed topology exercised by this gate. */
export const WORK_GRAPH_GAUNTLET_SPEC = {
  scenarioId: "work-graph-gauntlet-v1",
  parentTaskId: "mission-parent",
  objective: "Assemble a verified result from two parallel workers and an independent review.",
  maxConcurrency: 2,
  workers: [
    { key: "research", ownerId: "agent:research", ownerProfileHash: "profile:research", objective: "Research the source inputs." },
    { key: "build", ownerId: "agent:build", ownerProfileHash: "profile:build", objective: "Build the candidate result." },
  ],
  reviewer: {
    key: "quality",
    ownerId: "agent:quality",
    ownerProfileHash: "profile:quality",
    objective: "Review the workers' result independently.",
  },
} as const;

export type WorkGraphGauntletSpec = typeof WORK_GRAPH_GAUNTLET_SPEC;

export interface WorkGraphUnitObservation {
  id: string;
  key: string;
  kind: "worker" | "reviewer";
  position: number;
  ownerId: string;
  ownerProfileHash: string;
  dependsOn: string[];
}

export interface WorkGraphDecompositionObservation {
  graphId: string;
  parentTaskId: string;
  maxConcurrency: number;
  units: WorkGraphUnitObservation[];
  /** True when a replay was admitted as the same parent-owned graph. */
  duplicateSuppressed: boolean;
}

export interface ChildResultObservation {
  unitId: string;
  status: string;
  canonical: boolean;
  verified: boolean;
  evidenceDurable: boolean;
}

export interface ImmutableWorkGraphEvent {
  id: string;
  semanticKey: string;
}

export interface DelegationObservation {
  workerUnitIds: string[];
  reviewerUnitId: string;
  childIdsBeforeRestart: string[];
  childIdsAfterRestart: string[];
  maxActive: number;
  parallelWorkerCount: number;
  duplicateChildSpawns: number;
  duplicateEffects: number;
  childImports: number;
  duplicateImports: number;
  providerFailures: number;
  toolFailures: number;
  injectedRetries: number;
  workerTerminalVerified: boolean;
  childResults: ChildResultObservation[];
  /** Immutable effect/import/review identities used to derive duplicate counts. */
  childSpawnEvents: ImmutableWorkGraphEvent[];
  effectEvents: ImmutableWorkGraphEvent[];
  importEvents: ImmutableWorkGraphEvent[];
  reviewAttemptEvents: ImmutableWorkGraphEvent[];
  duplicateReviewAttempts: number;
}

export interface ControllerRecoveryObservation {
  abruptRestarted: boolean;
  recoveries: number;
  retryDisposition: "retryable" | "blocked" | "terminal" | string;
  activeWorkRecovered: boolean;
  duplicateChildSpawns: number;
  providerFailures: number;
  toolFailures: number;
  childIdsBeforeRestart: string[];
  childIdsAfterRestart: string[];
  recoveryAttemptEvents: ImmutableWorkGraphEvent[];
  restartReviewAttemptEvents: ImmutableWorkGraphEvent[];
  restartImportEvents: ImmutableWorkGraphEvent[];
  restartSynthesisEffectEvents: ImmutableWorkGraphEvent[];
  duplicateReviewAttempts: number;
  duplicateImports: number;
  duplicateSynthesisEffects: number;
}

export interface CheckpointCategoryObservation {
  name: string;
  preserved: boolean;
  compacted: boolean;
  digest?: string | null;
}

export interface CheckpointObservation {
  oversizedBytes: number;
  boundedBytes: number;
  maxBytes: number;
  rolloverCount: number;
  compacted: boolean;
  restartPreserved: boolean;
  categories: CheckpointCategoryObservation[];
}

export interface VerificationObservation {
  attemptedText: string;
  rejected: boolean;
  rejectionReason: string;
  terminalChildIds: string[];
  terminalVerifiedCanonicalChildIds: string[];
  reviewerIndependent: boolean;
  guardianAuthorized: boolean;
}

export interface ReviewObservation {
  reviewerUnitId: string;
  reviewerOwnerId: string;
  producingOwnerIds: string[];
  reviewerProfileHash: string;
  producingProfileHashes: string[];
  firstVerdict: "rejected" | "approved" | string;
  revisionCount: number;
  finalVerdict: "rejected" | "approved" | string;
  reviewerIndependent: boolean;
  reviewAttempts: number;
  reviewAttemptEvents: ImmutableWorkGraphEvent[];
}

export interface FanInObservation {
  orderedUnitIds: string[];
  requiredTerminalVerifiedCanonical: boolean;
  aggregateAttempts: number;
  aggregateRetryCount: number;
  duplicateSynthesisEffects: number;
  synthesisCount: number;
  duplicateImports: number;
  terminalState: string;
  canonicalAnswer: { content: string; source: string; durable: boolean; verified: boolean } | null;
  guardianAuthorized: boolean;
  aggregateAttemptEvents: ImmutableWorkGraphEvent[];
  importEvents: ImmutableWorkGraphEvent[];
  synthesisEffectEvents: ImmutableWorkGraphEvent[];
  canonicalEvidenceEvents: ImmutableWorkGraphEvent[];
}

export interface EfficiencyObservation {
  discoveryReads: number;
  repeatedDiscoveryReads: number;
  unchangedFailedCommandReruns: number;
  providerTurns: number;
  toolCalls: number;
  providerFailures: number;
  toolFailures: number;
  injectedRetries: number;
  tokenEstimate: number;
  workingSetChars: number;
}

/**
 * The current gate is intentionally honest about its seam. It proves the
 * report contract and failure attribution using a deterministic adapter; it
 * does not claim that the production controller, repository, API, or CLI is
 * wired to this scenario yet.
 */
export interface WorkGraphAcceptanceBoundary {
  kind: "injected-adapter";
  productionIntegrated: false;
  limitations: readonly string[];
}

export const WORK_GRAPH_ACCEPTANCE_BOUNDARY: WorkGraphAcceptanceBoundary = {
  kind: "injected-adapter",
  productionIntegrated: false,
  limitations: [
    "controller, checkpoint, delegation, verification, and fan-in observations are supplied by an injected deterministic adapter",
    "the gate does not prove production controller/repository/API/CLI integration or provider/model output quality",
    "SQLite integrity covers only the adapter-owned acceptance fixture database",
  ],
};

/** Explicit deterministic budgets for the injected failure campaign. */
export const WORK_GRAPH_GAUNTLET_BUDGETS = {
  providerFailures: 1,
  toolFailures: 1,
  injectedRetries: 2,
  maxProviderTurns: 16,
  maxToolCalls: 16,
  maxTokenEstimate: 8_000,
} as const;

/**
 * Narrow seam for the deterministic gate. Production controller, checkpoint,
 * delegation, and verification implementations can be injected later without
 * making this acceptance module own route, CLI, or database wiring.
 */
export interface WorkGraphAcceptanceAdapter {
  reset(spec: WorkGraphGauntletSpec): Promise<void> | void;
  decompose(spec: WorkGraphGauntletSpec): Promise<WorkGraphDecompositionObservation> | WorkGraphDecompositionObservation;
  dispatch(input: { graphId: string }): Promise<DelegationObservation> | DelegationObservation;
  recoverAfterRestart(input: { graphId: string }): Promise<ControllerRecoveryObservation> | ControllerRecoveryObservation;
  checkpoint(input: { graphId: string; requiredCategories: readonly RecoveryCapsuleCategory[] }): Promise<CheckpointObservation> | CheckpointObservation;
  rejectPrematureCompletion(input: { graphId: string }): Promise<VerificationObservation> | VerificationObservation;
  reviewAndRevise(input: { graphId: string; reviewerUnitId: string }): Promise<ReviewObservation> | ReviewObservation;
  fanIn(input: { graphId: string }): Promise<FanInObservation> | FanInObservation;
  efficiency(input: { graphId: string }): Promise<EfficiencyObservation> | EfficiencyObservation;
  sqliteIntegrity(input: { graphId: string }): Promise<"ok" | "failed"> | "ok" | "failed";
}

export type WorkGraphAcceptancePhase =
  | "decomposition"
  | "controllerRecovery"
  | "checkpointFidelity"
  | "delegation"
  | "verification"
  | "fanIn"
  | "efficiency";

export interface WorkGraphPhaseReport {
  passed: boolean;
  counters: Record<string, number>;
  diagnostics: string[];
}

export interface WorkGraphAcceptanceCounters {
  decomposition: {
    requests: number;
    replayRequests: number;
    units: number;
    duplicateUnits: number;
  };
  controllerRecovery: {
    restarts: number;
    recoveries: number;
    providerFailures: number;
    toolFailures: number;
  };
  checkpoint: {
    oversizedBytes: number;
    boundedBytes: number;
    maxBytes: number;
    rollovers: number;
    compactedCategories: number;
    preservedCategories: number;
    workingSetChars: number;
  };
  delegation: {
    parallelWorkers: number;
    maxActive: number;
    childImports: number;
    providerFailures: number;
    toolFailures: number;
    injectedRetries: number;
  };
  verification: {
    prematureAttempts: number;
    rejectedPrematureCompletions: number;
    terminalVerifiedCanonicalChildren: number;
  };
  review: {
    attempts: number;
    rejections: number;
    approvals: number;
    revisions: number;
  };
  fanIn: {
    aggregateAttempts: number;
    aggregateRetries: number;
    synthesis: number;
    orderedUnits: number;
  };
  efficiency: EfficiencyObservation & { workingSetLimit: number };
  duplicates: {
    childSpawns: number;
    decompositionUnits: number;
    effects: number;
    imports: number;
    synthesis: number;
  };
}

export interface WorkGraphAcceptanceResult {
  scenarioId: "work-graph-gauntlet-v1";
  passed: boolean;
  message: string | null;
  graphId: string | null;
  parentTaskId: string;
  maxConcurrency: number;
  phases: Record<WorkGraphAcceptancePhase, WorkGraphPhaseReport>;
  failedPhases: WorkGraphAcceptancePhase[];
  diagnostics: string[];
  counters: WorkGraphAcceptanceCounters;
  fanInOrder: string[];
  terminalState: string | null;
  canonicalAnswer: FanInObservation["canonicalAnswer"];
  sqliteIntegrity: "ok" | "failed";
  /** Explicitly prevents an injected fixture run being reported as production proof. */
  boundary: WorkGraphAcceptanceBoundary;
  limitations: readonly string[];
}

const PHASES: readonly WorkGraphAcceptancePhase[] = [
  "decomposition",
  "controllerRecovery",
  "checkpointFidelity",
  "delegation",
  "verification",
  "fanIn",
  "efficiency",
];

function emptyPhase(): WorkGraphPhaseReport {
  return { passed: false, counters: {}, diagnostics: ["phase did not execute"] };
}

function phaseReport(counters: Record<string, number>, diagnostics: string[]): WorkGraphPhaseReport {
  return { passed: diagnostics.length === 0, counters, diagnostics };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function nonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function duplicateCount(values: readonly string[]): number {
  return Math.max(0, values.length - unique(values).length);
}

function exactIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && unique(actual).length === actual.length && sameIds(actual, expected);
}

function eventIds(events: readonly ImmutableWorkGraphEvent[]): string[] {
  return events.map((event) => event.id);
}

function eventKeys(events: readonly ImmutableWorkGraphEvent[]): string[] {
  return events.map((event) => event.semanticKey);
}

function eventLedgerDiagnostics(events: readonly ImmutableWorkGraphEvent[], label: string): string[] {
  const diagnostics: string[] = [];
  if (events.some((event) => !event.id.trim() || !event.semanticKey.trim())) diagnostics.push(`${label} has an event without immutable id or semantic key`);
  if (duplicateCount(eventIds(events)) > 0) diagnostics.push(`${label} contains duplicate event ids`);
  if (duplicateCount(eventKeys(events)) > 0) diagnostics.push(`${label} contains duplicate semantic keys`);
  return diagnostics;
}

function exactEventKeys(actual: readonly ImmutableWorkGraphEvent[], expected: readonly ImmutableWorkGraphEvent[]): boolean {
  return exactIds(eventKeys(actual), eventKeys(expected));
}

function numericDiagnostics(observation: Record<string, unknown>, label: string): string[] {
  const diagnostics: string[] = [];
  for (const [name, value] of Object.entries(observation)) {
    if (typeof value === "number" && !nonNegativeInteger(value)) {
      diagnostics.push(`${label} counter ${name} is not a non-negative integer`);
    }
  }
  return diagnostics;
}

function expectedManifest(spec: WorkGraphGauntletSpec): WorkGraphUnitObservation[] {
  const workers = spec.workers.map((worker, index) => ({
    id: `worker:${worker.key}`,
    key: worker.key,
    kind: "worker" as const,
    position: index + 1,
    ownerId: worker.ownerId,
    ownerProfileHash: worker.ownerProfileHash,
    dependsOn: [],
  }));
  return [...workers, {
    id: `reviewer:${spec.reviewer.key}`,
    key: spec.reviewer.key,
    kind: "reviewer" as const,
    position: workers.length + 1,
    ownerId: spec.reviewer.ownerId,
    ownerProfileHash: spec.reviewer.ownerProfileHash,
    dependsOn: workers.map((worker) => worker.id),
  }];
}

function matchesManifest(units: readonly WorkGraphUnitObservation[], expected: readonly WorkGraphUnitObservation[]): boolean {
  return units.length === expected.length && units.every((unit, index) => {
    const manifest = expected[index];
    if (!manifest) return false;
    return unit.id === manifest.id
      && unit.key === manifest.key
      && unit.kind === manifest.kind
      && unit.position === manifest.position
      && unit.ownerId === manifest.ownerId
      && unit.ownerProfileHash === manifest.ownerProfileHash
      && exactIds(unit.dependsOn, manifest.dependsOn);
  });
}

function diagnosticsForDecomposition(
  first: WorkGraphDecompositionObservation,
  replay: WorkGraphDecompositionObservation,
  spec: WorkGraphGauntletSpec,
): string[] {
  const diagnostics: string[] = [
    ...numericDiagnostics(first as unknown as Record<string, unknown>, "decomposition"),
    ...numericDiagnostics(replay as unknown as Record<string, unknown>, "decomposition replay"),
  ];
  const workers = first.units.filter((unit) => unit.kind === "worker");
  const reviewer = first.units.find((unit) => unit.kind === "reviewer");
  const replayIds = replay.units.map((unit) => unit.id);
  const firstIds = first.units.map((unit) => unit.id);
  const expected = expectedManifest(spec);
  const duplicateFirstIds = duplicateCount(firstIds);
  const duplicateReplayIds = duplicateCount(replayIds);
  if (!first.graphId || first.graphId !== replay.graphId) diagnostics.push("decomposition graph identity changed on replay");
  if (first.parentTaskId !== spec.parentTaskId || replay.parentTaskId !== spec.parentTaskId) diagnostics.push("decomposition is not parent-owned");
  if (first.maxConcurrency !== spec.maxConcurrency || replay.maxConcurrency !== spec.maxConcurrency) diagnostics.push(`maxConcurrency must remain ${spec.maxConcurrency}`);
  if (workers.length !== spec.workers.length || first.units.length !== spec.workers.length + 1) diagnostics.push(`expected exactly ${spec.workers.length} workers and one reviewer`);
  if (!reviewer) diagnostics.push("dependent reviewer unit is missing");
  if (reviewer && !workers.every((worker) => reviewer.dependsOn.includes(worker.id))) diagnostics.push("reviewer does not depend on both workers");
  if (duplicateFirstIds > 0 || duplicateReplayIds > 0) diagnostics.push(`decomposition contains ${Math.max(duplicateFirstIds, duplicateReplayIds)} duplicate work-unit identity/identities`);
  if (!sameIds(firstIds, replayIds)) diagnostics.push("decomposition replay changed work-unit identities or order");
  if (!replay.duplicateSuppressed) diagnostics.push("duplicate decomposition replay was not suppressed");
  if (!matchesManifest(first.units, expected) || !matchesManifest(replay.units, expected)) diagnostics.push("decomposition does not match the expected parent-owned manifest");
  if (first.units.some((unit) => !unit.id.trim() || !unit.key.trim() || !unit.ownerId.trim() || !unit.ownerProfileHash.trim())) {
    diagnostics.push("decomposition contains a work unit without stable identity or owner/profile attribution");
  }
  if (first.units.some((unit) => !nonNegativeInteger(unit.position) || unit.position < 1)) {
    diagnostics.push("decomposition contains an invalid work-unit position");
  }
  if (first.units.some((unit) => duplicateCount(unit.dependsOn) > 0 || unit.dependsOn.includes(unit.id))) {
    diagnostics.push("decomposition contains duplicate or self-referential dependencies");
  }
  if (reviewer && workers.some((worker) => worker.ownerId === reviewer.ownerId || worker.ownerProfileHash === reviewer.ownerProfileHash)) {
    diagnostics.push("reviewer owner/profile is not distinct from producing workers");
  }
  return diagnostics;
}

function diagnosticsForController(
  observation: ControllerRecoveryObservation,
  delegation: DelegationObservation | null,
): string[] {
  const diagnostics: string[] = [
    ...numericDiagnostics(observation as unknown as Record<string, unknown>, "controller recovery"),
    ...eventLedgerDiagnostics(observation.recoveryAttemptEvents, "recovery ledger"),
    ...eventLedgerDiagnostics(observation.restartReviewAttemptEvents, "restart review ledger"),
    ...eventLedgerDiagnostics(observation.restartImportEvents, "restart import ledger"),
    ...eventLedgerDiagnostics(observation.restartSynthesisEffectEvents, "restart synthesis ledger"),
  ];
  const duplicateBefore = duplicateCount(observation.childIdsBeforeRestart);
  const duplicateAfter = duplicateCount(observation.childIdsAfterRestart);
  const duplicateRecoveryAttempts = duplicateCount(eventIds(observation.recoveryAttemptEvents));
  const duplicateRestartReviews = duplicateCount(eventIds(observation.restartReviewAttemptEvents));
  const duplicateRestartImports = duplicateCount(eventIds(observation.restartImportEvents));
  const duplicateRestartSynthesis = duplicateCount(eventIds(observation.restartSynthesisEffectEvents));
  if (!observation.abruptRestarted) diagnostics.push("abrupt restart was not exercised");
  if (observation.recoveries < 1) diagnostics.push("controller recovery did not record a recovery attempt");
  if (observation.retryDisposition !== "retryable") diagnostics.push(`unexpected restart disposition: ${observation.retryDisposition}`);
  if (!observation.activeWorkRecovered) diagnostics.push("active work was not recovered after restart");
  if (observation.childIdsBeforeRestart.length === 0 || observation.childIdsAfterRestart.length === 0) diagnostics.push("restart recovery has no active child work to recover");
  if (!sameIds(observation.childIdsBeforeRestart, observation.childIdsAfterRestart)) diagnostics.push("restart changed child identities");
  if (duplicateBefore > 0 || duplicateAfter > 0) diagnostics.push(`restart duplicated ${Math.max(duplicateBefore, duplicateAfter)} child identity/identities`);
  if (duplicateRecoveryAttempts > 0) diagnostics.push(`restart contains ${duplicateRecoveryAttempts} duplicate recovery event(s)`);
  if (duplicateRestartReviews > 0) diagnostics.push(`restart duplicated ${duplicateRestartReviews} review event(s)`);
  if (duplicateRestartImports > 0) diagnostics.push(`restart duplicated ${duplicateRestartImports} import event(s)`);
  if (duplicateRestartSynthesis > 0) diagnostics.push(`restart duplicated ${duplicateRestartSynthesis} synthesis event(s)`);
  if (observation.duplicateChildSpawns !== 0) diagnostics.push(`restart duplicated ${observation.duplicateChildSpawns} child spawn(s)`);
  if (delegation && !sameIds(observation.childIdsAfterRestart, delegation.childIdsAfterRestart)) diagnostics.push("controller and delegation disagree on recovered child identities");
  if (delegation && !sameIds(observation.childIdsBeforeRestart, delegation.childIdsBeforeRestart)) diagnostics.push("controller and delegation disagree on pre-restart child identities");
  if (delegation && !exactEventKeys(observation.restartReviewAttemptEvents, delegation.reviewAttemptEvents)) diagnostics.push("restart review evidence cannot be reconciled to the original review ledger");
  if (delegation && !exactEventKeys(observation.restartImportEvents, delegation.importEvents)) diagnostics.push("restart import evidence cannot be reconciled to the original import ledger");
  if (observation.providerFailures < 1) diagnostics.push("provider failure was not forced or attributed");
  if (observation.toolFailures < 1) diagnostics.push("tool failure was not forced or attributed");
  if (observation.providerFailures !== WORK_GRAPH_GAUNTLET_BUDGETS.providerFailures || observation.toolFailures !== WORK_GRAPH_GAUNTLET_BUDGETS.toolFailures) {
    diagnostics.push("controller recovery provider/tool failures exceed or miss the forced failure budget");
  }
  if (observation.recoveryAttemptEvents.length < observation.recoveries) diagnostics.push("restart recovery attempts are not independently recorded");
  if (observation.restartReviewAttemptEvents.length < 2) diagnostics.push("restart did not replay both independent review attempts");
  if (observation.restartImportEvents.length < 1) diagnostics.push("restart did not replay imported child evidence");
  if (observation.restartSynthesisEffectEvents.length < 1) diagnostics.push("restart did not observe the synthesis effect ledger");
  if (observation.duplicateReviewAttempts !== 0) diagnostics.push(`restart duplicated ${observation.duplicateReviewAttempts} review attempt(s)`);
  if (observation.duplicateImports !== 0) diagnostics.push(`restart duplicated ${observation.duplicateImports} import(s)`);
  if (observation.duplicateSynthesisEffects !== 0) diagnostics.push(`restart duplicated ${observation.duplicateSynthesisEffects} synthesis effect(s)`);
  return diagnostics;
}

function diagnosticsForCheckpoint(observation: CheckpointObservation): string[] {
  const diagnostics: string[] = [
    ...numericDiagnostics(observation as unknown as Record<string, unknown>, "checkpoint"),
  ];
  if (!(observation.oversizedBytes > observation.maxBytes)) diagnostics.push("checkpoint was not oversized relative to its bound");
  if (!(observation.maxBytes > 0) || observation.boundedBytes < 0 || observation.boundedBytes > observation.maxBytes) diagnostics.push("checkpoint exceeded its byte bound");
  if (observation.rolloverCount < 2) diagnostics.push("multiple checkpoint/context rollovers were not observed");
  if (!observation.compacted) diagnostics.push("oversized checkpoint did not report compaction");
  if (!observation.restartPreserved) diagnostics.push("checkpoint reconstruction did not preserve restart fidelity");
  const categoryNames = observation.categories.map((category) => category.name);
  if (duplicateCount(categoryNames) > 0) diagnostics.push("checkpoint capsule contains duplicate category evidence");
  const categories = new Map(observation.categories.map((category) => [category.name, category]));
  for (const required of REQUIRED_RECOVERY_CAPSULE_CATEGORIES) {
    const category = categories.get(required);
    if (!category?.preserved) diagnostics.push(`checkpoint capsule lost required category: ${required}`);
    else if (category.compacted && (typeof category.digest !== "string" || !category.digest.trim())) diagnostics.push(`checkpoint compacted category has no loss-aware digest: ${required}`);
  }
  return diagnostics;
}

function diagnosticsForDelegation(
  observation: DelegationObservation,
  expectedWorkerIds: readonly string[],
  expectedReviewerId: string,
  maxConcurrency: number,
): string[] {
  const diagnostics: string[] = [
    ...numericDiagnostics(observation as unknown as Record<string, unknown>, "delegation"),
    ...eventLedgerDiagnostics(observation.childSpawnEvents, "child spawn ledger"),
    ...eventLedgerDiagnostics(observation.effectEvents, "effect ledger"),
    ...eventLedgerDiagnostics(observation.importEvents, "import ledger"),
    ...eventLedgerDiagnostics(observation.reviewAttemptEvents, "review ledger"),
  ];
  const duplicateBefore = duplicateCount(observation.childIdsBeforeRestart);
  const duplicateAfter = duplicateCount(observation.childIdsAfterRestart);
  const duplicateResults = duplicateCount(observation.childResults.map((child) => child.unitId));
  const duplicateSpawns = Math.max(duplicateCount(eventIds(observation.childSpawnEvents)), duplicateCount(eventKeys(observation.childSpawnEvents)));
  const duplicateEffects = Math.max(duplicateCount(eventIds(observation.effectEvents)), duplicateCount(eventKeys(observation.effectEvents)));
  const duplicateImports = Math.max(duplicateCount(eventIds(observation.importEvents)), duplicateCount(eventKeys(observation.importEvents)));
  const duplicateReviews = Math.max(duplicateCount(eventIds(observation.reviewAttemptEvents)), duplicateCount(eventKeys(observation.reviewAttemptEvents)));
  if (!exactIds(observation.workerUnitIds, expectedWorkerIds)) diagnostics.push("delegation did not admit the expected workers exactly once");
  if (observation.reviewerUnitId !== expectedReviewerId) diagnostics.push("delegation reviewer identity changed");
  if (observation.parallelWorkerCount !== expectedWorkerIds.length) diagnostics.push("workers were not dispatched in parallel");
  if (observation.maxActive > maxConcurrency) diagnostics.push(`delegation exceeded maxConcurrency ${maxConcurrency}`);
  if (observation.maxActive < observation.parallelWorkerCount) diagnostics.push("delegation active count is below parallel worker count");
  if (observation.childIdsBeforeRestart.length !== expectedWorkerIds.length || observation.childIdsAfterRestart.length !== expectedWorkerIds.length) {
    diagnostics.push("delegation did not retain exactly one child per worker");
  }
  if (!sameIds(observation.childIdsBeforeRestart, observation.childIdsAfterRestart)) diagnostics.push("delegation duplicated or changed child identities across restart");
  if (duplicateBefore > 0 || duplicateAfter > 0) diagnostics.push(`delegation contains ${Math.max(duplicateBefore, duplicateAfter)} duplicate child identity/identities`);
  if (duplicateSpawns > 0) diagnostics.push(`delegation contains ${duplicateSpawns} duplicate spawn event(s)`);
  if (duplicateEffects > 0) diagnostics.push(`delegation contains ${duplicateEffects} duplicate effect event(s)`);
  if (duplicateImports > 0) diagnostics.push(`delegation contains ${duplicateImports} duplicate import event(s)`);
  if (duplicateReviews > 0) diagnostics.push(`delegation contains ${duplicateReviews} duplicate review event(s)`);
  if (observation.duplicateChildSpawns !== 0) diagnostics.push(`delegation duplicated ${observation.duplicateChildSpawns} child spawn(s)`);
  if (observation.duplicateEffects !== 0) diagnostics.push(`delegation duplicated ${observation.duplicateEffects} child effect(s)`);
  if (observation.duplicateImports !== 0) diagnostics.push(`delegation duplicated ${observation.duplicateImports} child import(s)`);
  if (observation.childImports !== expectedWorkerIds.length) diagnostics.push("not every worker produced one imported terminal result");
  if (observation.childResults.length !== expectedWorkerIds.length || duplicateResults > 0 || !exactIds(observation.childResults.map((child) => child.unitId), expectedWorkerIds)) {
    diagnostics.push("delegation child results are not a unique, complete worker set");
  }
  if (!observation.workerTerminalVerified) diagnostics.push("worker terminal results are not canonically verified");
  for (const child of observation.childResults) {
    if (!expectedWorkerIds.includes(child.unitId)) diagnostics.push(`unexpected child result imported: ${child.unitId}`);
    if (!["succeeded", "completed", "verified"].includes(child.status)) diagnostics.push(`worker ${child.unitId} is not terminal-success: ${child.status}`);
    if (!child.canonical || !child.verified || !child.evidenceDurable) diagnostics.push(`worker ${child.unitId} lacks durable canonical verified evidence`);
  }
  if (observation.providerFailures < 1 || observation.toolFailures < 1) diagnostics.push("provider/tool failure injection was not attributed to delegation");
  if (observation.injectedRetries < 1) diagnostics.push("injected provider/tool failures were not retried");
  if (observation.providerFailures !== WORK_GRAPH_GAUNTLET_BUDGETS.providerFailures || observation.toolFailures !== WORK_GRAPH_GAUNTLET_BUDGETS.toolFailures) {
    diagnostics.push("delegation provider/tool failures exceed or miss the forced failure budget");
  }
  if (observation.injectedRetries !== observation.providerFailures + observation.toolFailures || observation.injectedRetries !== WORK_GRAPH_GAUNTLET_BUDGETS.injectedRetries) {
    diagnostics.push("delegation retries do not reconcile with provider/tool failures and retry budget");
  }
  if (observation.duplicateReviewAttempts !== 0) diagnostics.push(`delegation duplicated ${observation.duplicateReviewAttempts} review attempt(s)`);
  if (observation.childSpawnEvents.length !== expectedWorkerIds.length) diagnostics.push("delegation did not record one immutable spawn event per worker");
  if (observation.effectEvents.length !== expectedWorkerIds.length) diagnostics.push("delegation did not record one immutable effect event per worker");
  if (observation.importEvents.length !== expectedWorkerIds.length) diagnostics.push("delegation did not record one immutable import event per worker");
  if (observation.reviewAttemptEvents.length < 2) diagnostics.push("delegation did not record the independent review attempts");
  return diagnostics;
}

function diagnosticsForVerification(
  observation: VerificationObservation,
  expectedWorkerIds: readonly string[],
): string[] {
  const diagnostics: string[] = [
    ...numericDiagnostics(observation as unknown as Record<string, unknown>, "verification"),
  ];
  const terminalIdsUnique = duplicateCount(observation.terminalChildIds) === 0;
  const canonicalIdsUnique = duplicateCount(observation.terminalVerifiedCanonicalChildIds) === 0;
  if (!observation.attemptedText.trim()) diagnostics.push("premature completion attempt is missing");
  if (!/\b(?:done|complete(?:d)?|finish(?:ed)?|all work)\b/i.test(observation.attemptedText)) diagnostics.push("premature completion attempt is not textual done/completion evidence");
  if (!observation.rejected) diagnostics.push("premature textual completion was accepted");
  if (!observation.rejectionReason.trim()) diagnostics.push("premature completion rejection has no reason");
  if (!terminalIdsUnique || !exactIds(observation.terminalChildIds, expectedWorkerIds)) diagnostics.push("verification did not observe exactly one terminal record for every worker");
  if (!canonicalIdsUnique || !exactIds(observation.terminalVerifiedCanonicalChildIds, expectedWorkerIds)) diagnostics.push("verification lacks exactly one terminal canonical evidence record for every worker");
  if (!observation.reviewerIndependent) diagnostics.push("verification reviewer is not independent");
  if (observation.guardianAuthorized) diagnostics.push("premature textual completion bypassed Guardian authorization");
  return diagnostics;
}

function diagnosticsForReview(
  observation: ReviewObservation,
  reviewer: WorkGraphUnitObservation | null,
  workers: readonly WorkGraphUnitObservation[],
): string[] {
  const diagnostics: string[] = [
    ...numericDiagnostics(observation as unknown as Record<string, unknown>, "review"),
    ...eventLedgerDiagnostics(observation.reviewAttemptEvents, "review ledger"),
  ];
  if (!reviewer || observation.reviewerUnitId !== reviewer.id) diagnostics.push("reviewer unit identity changed");
  if (observation.firstVerdict !== "rejected") diagnostics.push("reviewer rejection/revision path was not exercised");
  if (observation.revisionCount < 1) diagnostics.push("review rejection did not trigger a revision");
  if (observation.finalVerdict !== "approved") diagnostics.push("reviewer did not approve the revised result");
  if (observation.reviewAttempts < 2) diagnostics.push("review retry count did not include rejection and approval");
  if (observation.reviewAttemptEvents.length !== observation.reviewAttempts) diagnostics.push("review attempts do not match immutable review event identities");
  if (!observation.reviewerIndependent) diagnostics.push("reviewer is not independently attributed");
  if (observation.producingOwnerIds.length === 0 || observation.producingProfileHashes.length === 0) diagnostics.push("review is missing producing owner/profile attribution");
  if (duplicateCount(observation.producingOwnerIds) > 0 || duplicateCount(observation.producingProfileHashes) > 0) diagnostics.push("review producing owner/profile attribution is duplicated");
  if (reviewer && (observation.reviewerOwnerId !== reviewer.ownerId || observation.reviewerProfileHash !== reviewer.ownerProfileHash)) diagnostics.push("reviewer owner/profile does not match the manifest");
  if (!exactIds(observation.producingOwnerIds, workers.map((worker) => worker.ownerId)) || !exactIds(observation.producingProfileHashes, workers.map((worker) => worker.ownerProfileHash))) diagnostics.push("review producer owner/profile identities do not match the manifest");
  if (observation.producingOwnerIds.includes(observation.reviewerOwnerId)) diagnostics.push("reviewer owner matches a producing worker");
  if (observation.producingProfileHashes.includes(observation.reviewerProfileHash)) diagnostics.push("reviewer profile matches a producing worker");
  return diagnostics;
}

function diagnosticsForFanIn(
  observation: FanInObservation,
  expectedOrder: readonly string[],
  review: ReviewObservation | null,
  delegation: DelegationObservation | null,
  recovery: ControllerRecoveryObservation | null,
): string[] {
  const diagnostics: string[] = [
    ...numericDiagnostics(observation as unknown as Record<string, unknown>, "fan-in"),
    ...eventLedgerDiagnostics(observation.aggregateAttemptEvents, "aggregate attempt ledger"),
    ...eventLedgerDiagnostics(observation.importEvents, "fan-in import ledger"),
    ...eventLedgerDiagnostics(observation.synthesisEffectEvents, "synthesis ledger"),
    ...eventLedgerDiagnostics(observation.canonicalEvidenceEvents, "canonical evidence ledger"),
  ];
  const duplicateAggregateAttempts = Math.max(duplicateCount(eventIds(observation.aggregateAttemptEvents)), duplicateCount(eventKeys(observation.aggregateAttemptEvents)));
  const duplicateImports = Math.max(duplicateCount(eventIds(observation.importEvents)), duplicateCount(eventKeys(observation.importEvents)));
  const duplicateSynthesisEffects = Math.max(duplicateCount(eventIds(observation.synthesisEffectEvents)), duplicateCount(eventKeys(observation.synthesisEffectEvents)));
  const duplicateCanonicalEvidence = Math.max(duplicateCount(eventIds(observation.canonicalEvidenceEvents)), duplicateCount(eventKeys(observation.canonicalEvidenceEvents)));
  if (!exactIds(observation.orderedUnitIds, expectedOrder)) diagnostics.push("fan-in order is not deterministic (position,id) or contains duplicate units");
  if (!observation.requiredTerminalVerifiedCanonical) diagnostics.push("fan-in accepted without required terminal canonical verified children");
  if (observation.aggregateAttempts < 2 || observation.aggregateRetryCount < 1) diagnostics.push("aggregate retry was not exercised");
  if (observation.duplicateSynthesisEffects !== 0) diagnostics.push(`fan-in duplicated ${observation.duplicateSynthesisEffects} synthesis effect(s)`);
  if (observation.duplicateImports !== 0) diagnostics.push(`fan-in duplicated ${observation.duplicateImports} import(s)`);
  if (duplicateAggregateAttempts > 0) diagnostics.push(`fan-in contains ${duplicateAggregateAttempts} duplicate aggregate attempt event(s)`);
  if (duplicateImports > 0) diagnostics.push(`fan-in contains ${duplicateImports} duplicate import event(s)`);
  if (duplicateSynthesisEffects > 0) diagnostics.push(`fan-in contains ${duplicateSynthesisEffects} duplicate synthesis event(s)`);
  if (duplicateCanonicalEvidence > 0) diagnostics.push(`fan-in contains ${duplicateCanonicalEvidence} duplicate canonical evidence event(s)`);
  if (observation.synthesisCount !== 1) diagnostics.push(`fan-in synthesized ${observation.synthesisCount} time(s), expected once`);
  if (observation.aggregateAttemptEvents.length !== observation.aggregateAttempts) diagnostics.push("fan-in aggregate attempts do not match immutable attempt identities");
  if (observation.importEvents.length !== observation.orderedUnitIds.filter((id) => id.startsWith("worker:")).length) diagnostics.push("fan-in imports do not cover each worker exactly once");
  if (delegation && !exactEventKeys(observation.importEvents, delegation.importEvents)) diagnostics.push("fan-in imports do not reconcile with the delegation import ledger");
  if (recovery && !exactEventKeys(observation.importEvents, recovery.restartImportEvents)) diagnostics.push("fan-in imports do not reconcile with the restart import ledger");
  if (recovery && !exactEventKeys(observation.synthesisEffectEvents, recovery.restartSynthesisEffectEvents)) diagnostics.push("fan-in synthesis does not reconcile with the restart synthesis ledger");
  if (observation.synthesisEffectEvents.length !== observation.synthesisCount) diagnostics.push("fan-in synthesis count does not match immutable synthesis effects");
  if (observation.canonicalEvidenceEvents.length < observation.orderedUnitIds.length) diagnostics.push("fan-in lacks canonical evidence for every ordered unit");
  if (review?.finalVerdict !== "approved") diagnostics.push("fan-in ran without an approved independent review");
  if (observation.terminalState !== "completed") diagnostics.push(`fan-in terminal state is ${observation.terminalState}, expected completed`);
  if (!observation.canonicalAnswer?.content.trim() || !observation.canonicalAnswer.source.trim() || !observation.canonicalAnswer.durable || !observation.canonicalAnswer.verified) diagnostics.push("fan-in did not produce a durable canonical verified answer with provenance");
  if (!observation.guardianAuthorized) diagnostics.push("fan-in completion was not Guardian-authorized");
  return diagnostics;
}

function diagnosticsForEfficiency(
  observation: EfficiencyObservation,
  delegation: DelegationObservation | null,
  recovery: ControllerRecoveryObservation | null,
): string[] {
  const diagnostics: string[] = [
    ...numericDiagnostics(observation as unknown as Record<string, unknown>, "efficiency"),
  ];
  if (!nonNegativeInteger(observation.discoveryReads) || !nonNegativeInteger(observation.repeatedDiscoveryReads)) diagnostics.push("discovery counters are invalid");
  if (observation.discoveryReads < 1) diagnostics.push("discovery activity was not measured");
  if (observation.repeatedDiscoveryReads !== 0) diagnostics.push(`repeated discovery detected: ${observation.repeatedDiscoveryReads} call(s)`);
  if (observation.unchangedFailedCommandReruns !== 0) diagnostics.push(`unchanged failed command rerun detected: ${observation.unchangedFailedCommandReruns}`);
  if (observation.repeatedDiscoveryReads > observation.discoveryReads) diagnostics.push("repeated discovery count exceeds discovery reads");
  if (observation.workingSetChars > WORKING_SET_DEFAULTS.maxChars) diagnostics.push(`working set ${observation.workingSetChars} exceeds ${WORKING_SET_DEFAULTS.maxChars} characters`);
  if (observation.providerTurns < 1 || observation.toolCalls < 1) diagnostics.push("provider/tool activity was not measured");
  if (observation.providerTurns > WORK_GRAPH_GAUNTLET_BUDGETS.maxProviderTurns) diagnostics.push(`provider turns exceed budget ${WORK_GRAPH_GAUNTLET_BUDGETS.maxProviderTurns}`);
  if (observation.toolCalls > WORK_GRAPH_GAUNTLET_BUDGETS.maxToolCalls) diagnostics.push(`tool calls exceed budget ${WORK_GRAPH_GAUNTLET_BUDGETS.maxToolCalls}`);
  if (observation.tokenEstimate > WORK_GRAPH_GAUNTLET_BUDGETS.maxTokenEstimate) diagnostics.push(`token estimate exceeds budget ${WORK_GRAPH_GAUNTLET_BUDGETS.maxTokenEstimate}`);
  if (observation.providerFailures !== WORK_GRAPH_GAUNTLET_BUDGETS.providerFailures || observation.toolFailures !== WORK_GRAPH_GAUNTLET_BUDGETS.toolFailures) {
    diagnostics.push("efficiency failure counters do not match the forced provider/tool failure budget");
  }
  if (observation.injectedRetries !== observation.providerFailures + observation.toolFailures || observation.injectedRetries !== WORK_GRAPH_GAUNTLET_BUDGETS.injectedRetries) {
    diagnostics.push("injected retries do not reconcile with provider/tool failures and retry budget");
  }
  if (delegation && (observation.providerFailures !== delegation.providerFailures || observation.toolFailures !== delegation.toolFailures || observation.injectedRetries !== delegation.injectedRetries)) {
    diagnostics.push("efficiency counters disagree with delegation failure/retry evidence");
  }
  if (recovery && (observation.providerFailures < recovery.providerFailures || observation.toolFailures < recovery.toolFailures)) {
    diagnostics.push("efficiency counters under-report controller recovery failures");
  }
  return diagnostics;
}

function blankCounters(): WorkGraphAcceptanceCounters {
  return {
    decomposition: { requests: 0, replayRequests: 0, units: 0, duplicateUnits: 0 },
    controllerRecovery: { restarts: 0, recoveries: 0, providerFailures: 0, toolFailures: 0 },
    checkpoint: { oversizedBytes: 0, boundedBytes: 0, maxBytes: 0, rollovers: 0, compactedCategories: 0, preservedCategories: 0, workingSetChars: 0 },
    delegation: { parallelWorkers: 0, maxActive: 0, childImports: 0, providerFailures: 0, toolFailures: 0, injectedRetries: 0 },
    verification: { prematureAttempts: 0, rejectedPrematureCompletions: 0, terminalVerifiedCanonicalChildren: 0 },
    review: { attempts: 0, rejections: 0, approvals: 0, revisions: 0 },
    fanIn: { aggregateAttempts: 0, aggregateRetries: 0, synthesis: 0, orderedUnits: 0 },
    efficiency: {
      discoveryReads: 0,
      repeatedDiscoveryReads: 0,
      unchangedFailedCommandReruns: 0,
      providerTurns: 0,
      toolCalls: 0,
      providerFailures: 0,
      toolFailures: 0,
      injectedRetries: 0,
      tokenEstimate: 0,
      workingSetChars: 0,
      workingSetLimit: WORKING_SET_DEFAULTS.maxChars,
    },
    duplicates: { childSpawns: 0, decompositionUnits: 0, effects: 0, imports: 0, synthesis: 0 },
  };
}

/**
 * Run the deterministic work-graph gauntlet through injected boundaries.
 * Every phase keeps its own counters and diagnostics so a failed acceptance
 * run identifies the owning reliability contract; this is not production
 * integration evidence until a production adapter is supplied.
 */
export async function runWorkGraphAcceptance(input: {
  adapter: WorkGraphAcceptanceAdapter;
  spec?: WorkGraphGauntletSpec;
}): Promise<WorkGraphAcceptanceResult> {
  const spec = input.spec ?? WORK_GRAPH_GAUNTLET_SPEC;
  const phases = Object.fromEntries(PHASES.map((phase) => [phase, emptyPhase()])) as Record<WorkGraphAcceptancePhase, WorkGraphPhaseReport>;
  const counters = blankCounters();
  const diagnostics: string[] = [];
  let graphId: string | null = null;
  let delegation: DelegationObservation | null = null;
  let recoveryObservation: ControllerRecoveryObservation | null = null;
  let review: ReviewObservation | null = null;
  let fanIn: FanInObservation | null = null;
  let sqliteIntegrity: "ok" | "failed" = "failed";
  let resetDiagnostics: string[] = [];

  try {
    await input.adapter.reset(spec);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    resetDiagnostics = [`fixture reset failed: ${message}`];
    diagnostics.push(...resetDiagnostics);
  }

  let first: WorkGraphDecompositionObservation | null = null;
  let replay: WorkGraphDecompositionObservation | null = null;
  let decompositionRequests = 0;
  try {
    decompositionRequests += 1;
    first = await input.adapter.decompose(spec);
    graphId = first.graphId || null;
    decompositionRequests += 1;
    replay = await input.adapter.decompose(spec);
    const decompositionDiagnostics = diagnosticsForDecomposition(first, replay, spec);
    const firstIds = first.units.map((unit) => unit.id);
    const replayIds = replay.units.map((unit) => unit.id);
    counters.decomposition = {
      requests: decompositionRequests,
      replayRequests: Math.max(0, decompositionRequests - 1),
      units: first.units.length,
      duplicateUnits: Math.max(duplicateCount(firstIds), duplicateCount(replayIds)),
    };
    counters.duplicates.decompositionUnits = counters.decomposition.duplicateUnits;
    phases.decomposition = phaseReport({ ...counters.decomposition }, [...resetDiagnostics, ...decompositionDiagnostics]);
    diagnostics.push(...decompositionDiagnostics);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const decompositionDiagnostics = [...resetDiagnostics, `decomposition failed after ${decompositionRequests} request(s): ${message}`];
    phases.decomposition = phaseReport({ requests: decompositionRequests, replayRequests: Math.max(0, decompositionRequests - 1) }, decompositionDiagnostics);
    diagnostics.push(...phases.decomposition.diagnostics);
  }

  const workerIds = first?.units.filter((unit) => unit.kind === "worker").map((unit) => unit.id) ?? [];
  const reviewerId = first?.units.find((unit) => unit.kind === "reviewer")?.id ?? "";
  const expectedOrder = first?.units.slice().sort((left, right) => left.position - right.position || left.id.localeCompare(right.id)).map((unit) => unit.id) ?? [];

  if (graphId) {
    try {
      delegation = await input.adapter.dispatch({ graphId });
      counters.delegation = {
        parallelWorkers: delegation.parallelWorkerCount,
        maxActive: delegation.maxActive,
        childImports: delegation.childImports,
        providerFailures: delegation.providerFailures,
        toolFailures: delegation.toolFailures,
        injectedRetries: delegation.injectedRetries,
      };
      const observedDuplicateChildSpawns = Math.max(
        delegation.duplicateChildSpawns,
        duplicateCount(delegation.childIdsBeforeRestart),
        duplicateCount(delegation.childIdsAfterRestart),
      );
      counters.duplicates.childSpawns = observedDuplicateChildSpawns;
      counters.duplicates.effects = Math.max(delegation.duplicateEffects, duplicateCount(eventIds(delegation.effectEvents)), duplicateCount(eventKeys(delegation.effectEvents)));
      counters.duplicates.imports = Math.max(delegation.duplicateImports, duplicateCount(eventIds(delegation.importEvents)), duplicateCount(eventKeys(delegation.importEvents)));
      const delegationDiagnostics = diagnosticsForDelegation(delegation, workerIds, reviewerId, spec.maxConcurrency);
      phases.delegation = phaseReport({ ...counters.delegation, duplicateChildSpawns: observedDuplicateChildSpawns, duplicateEffects: delegation.duplicateEffects, duplicateImports: delegation.duplicateImports }, delegationDiagnostics);
      diagnostics.push(...delegationDiagnostics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      phases.delegation = phaseReport({}, [`delegation failed: ${message}`]);
      diagnostics.push(...phases.delegation.diagnostics);
    }

    try {
      const recovery = await input.adapter.recoverAfterRestart({ graphId });
      recoveryObservation = recovery;
      counters.controllerRecovery = {
        restarts: 1,
        recoveries: recovery.recoveries,
        providerFailures: recovery.providerFailures,
        toolFailures: recovery.toolFailures,
      };
      const recoveryDiagnostics = diagnosticsForController(recovery, delegation);
      const observedDuplicateChildSpawns = Math.max(
        recovery.duplicateChildSpawns,
        duplicateCount(recovery.childIdsBeforeRestart),
        duplicateCount(recovery.childIdsAfterRestart),
      );
      phases.controllerRecovery = phaseReport({ ...counters.controllerRecovery, duplicateChildSpawns: observedDuplicateChildSpawns }, recoveryDiagnostics);
      diagnostics.push(...recoveryDiagnostics);
      counters.duplicates.childSpawns = Math.max(counters.duplicates.childSpawns, observedDuplicateChildSpawns);
      counters.duplicates.imports = Math.max(counters.duplicates.imports, recovery.duplicateImports, duplicateCount(eventIds(recovery.restartImportEvents)), duplicateCount(eventKeys(recovery.restartImportEvents)));
      counters.duplicates.synthesis = Math.max(counters.duplicates.synthesis, recovery.duplicateSynthesisEffects, duplicateCount(eventIds(recovery.restartSynthesisEffectEvents)), duplicateCount(eventKeys(recovery.restartSynthesisEffectEvents)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      phases.controllerRecovery = phaseReport({}, [`controller recovery failed: ${message}`]);
      diagnostics.push(...phases.controllerRecovery.diagnostics);
    }

    try {
      const checkpoint = await input.adapter.checkpoint({ graphId, requiredCategories: REQUIRED_RECOVERY_CAPSULE_CATEGORIES });
      const categories = new Map(checkpoint.categories.map((category) => [category.name, category]));
      counters.checkpoint = {
        oversizedBytes: checkpoint.oversizedBytes,
        boundedBytes: checkpoint.boundedBytes,
        maxBytes: checkpoint.maxBytes,
        rollovers: checkpoint.rolloverCount,
        compactedCategories: checkpoint.categories.filter((category) => category.compacted).length,
        preservedCategories: REQUIRED_RECOVERY_CAPSULE_CATEGORIES.filter((name) => categories.get(name)?.preserved).length,
        workingSetChars: counters.efficiency.workingSetChars,
      };
      const checkpointDiagnostics = diagnosticsForCheckpoint(checkpoint);
      phases.checkpointFidelity = phaseReport({ ...counters.checkpoint }, checkpointDiagnostics);
      diagnostics.push(...checkpointDiagnostics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      phases.checkpointFidelity = phaseReport({}, [`checkpoint fidelity failed: ${message}`]);
      diagnostics.push(...phases.checkpointFidelity.diagnostics);
    }

    try {
      const verification = await input.adapter.rejectPrematureCompletion({ graphId });
      counters.verification = {
        prematureAttempts: 1,
        rejectedPrematureCompletions: verification.rejected ? 1 : 0,
        terminalVerifiedCanonicalChildren: verification.terminalVerifiedCanonicalChildIds.length,
      };
      const verificationDiagnostics = diagnosticsForVerification(verification, workerIds);
      phases.verification = phaseReport({ ...counters.verification }, verificationDiagnostics);
      diagnostics.push(...verificationDiagnostics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      phases.verification = phaseReport({}, [`verification failed: ${message}`]);
      diagnostics.push(...phases.verification.diagnostics);
    }

    try {
      review = await input.adapter.reviewAndRevise({ graphId, reviewerUnitId: reviewerId });
      counters.review = {
        attempts: review.reviewAttempts,
        rejections: review.firstVerdict === "rejected" ? 1 : 0,
        approvals: review.finalVerdict === "approved" ? 1 : 0,
        revisions: review.revisionCount,
      };
      const reviewer = first?.units.find((unit) => unit.kind === "reviewer") ?? null;
      const workers = first?.units.filter((unit) => unit.kind === "worker") ?? [];
      const reviewDiagnostics = diagnosticsForReview(review, reviewer, workers);
      phases.delegation = phaseReport({ ...phases.delegation.counters, reviewAttempts: review.reviewAttempts, reviewerRejections: review.firstVerdict === "rejected" ? 1 : 0, reviewerApprovals: review.finalVerdict === "approved" ? 1 : 0 }, [...phases.delegation.diagnostics, ...reviewDiagnostics]);
      if (reviewDiagnostics.length > 0) diagnostics.push(...reviewDiagnostics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reviewDiagnostics = [`review failed: ${message}`];
      phases.delegation = phaseReport(phases.delegation.counters, [...phases.delegation.diagnostics, ...reviewDiagnostics]);
      diagnostics.push(...reviewDiagnostics);
    }

    try {
      fanIn = await input.adapter.fanIn({ graphId });
      counters.fanIn = {
        aggregateAttempts: fanIn.aggregateAttempts,
        aggregateRetries: fanIn.aggregateRetryCount,
        synthesis: fanIn.synthesisCount,
        orderedUnits: fanIn.orderedUnitIds.length,
      };
      counters.duplicates.synthesis = Math.max(fanIn.duplicateSynthesisEffects, duplicateCount(eventIds(fanIn.synthesisEffectEvents)), duplicateCount(eventKeys(fanIn.synthesisEffectEvents)));
      counters.duplicates.imports = Math.max(counters.duplicates.imports, fanIn.duplicateImports, duplicateCount(eventIds(fanIn.importEvents)), duplicateCount(eventKeys(fanIn.importEvents)));
      const fanInDiagnostics = diagnosticsForFanIn(fanIn, expectedOrder, review, delegation, recoveryObservation);
      phases.fanIn = phaseReport({ ...counters.fanIn, duplicateSynthesisEffects: fanIn.duplicateSynthesisEffects, duplicateImports: fanIn.duplicateImports }, fanInDiagnostics);
      diagnostics.push(...fanInDiagnostics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      phases.fanIn = phaseReport({}, [`fan-in failed: ${message}`]);
      diagnostics.push(...phases.fanIn.diagnostics);
    }

    try {
      const efficiency = await input.adapter.efficiency({ graphId });
      counters.efficiency = { ...efficiency, workingSetLimit: WORKING_SET_DEFAULTS.maxChars };
      counters.checkpoint.workingSetChars = efficiency.workingSetChars;
      phases.checkpointFidelity.counters.workingSetChars = efficiency.workingSetChars;
      const efficiencyDiagnostics = diagnosticsForEfficiency(efficiency, delegation, recoveryObservation);
      phases.efficiency = phaseReport({ ...counters.efficiency }, efficiencyDiagnostics);
      diagnostics.push(...efficiencyDiagnostics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      phases.efficiency = phaseReport({}, [`efficiency measurement failed: ${message}`]);
      diagnostics.push(...phases.efficiency.diagnostics);
    }

    try {
      sqliteIntegrity = await input.adapter.sqliteIntegrity({ graphId });
      if (sqliteIntegrity !== "ok") diagnostics.push("SQLite integrity check failed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sqliteIntegrity = "failed";
      diagnostics.push(`SQLite integrity check failed: ${message}`);
    }
  } else {
    for (const phase of PHASES.slice(1)) phases[phase] = phaseReport({}, ["phase skipped because decomposition produced no graph"]);
  }

  const failedPhases = PHASES.filter((phase) => !phases[phase].passed);
  const passed = failedPhases.length === 0 && sqliteIntegrity === "ok" && Boolean(fanIn?.canonicalAnswer);
  return {
    scenarioId: "work-graph-gauntlet-v1",
    passed,
    message: passed ? null : `Failed phases: ${failedPhases.join(", ")}${sqliteIntegrity !== "ok" ? "; sqliteIntegrity=failed" : ""}. ${diagnostics.join(" ")}`,
    graphId,
    parentTaskId: spec.parentTaskId,
    maxConcurrency: spec.maxConcurrency,
    phases,
    failedPhases,
    diagnostics,
    counters,
    fanInOrder: fanIn?.orderedUnitIds ?? [],
    terminalState: fanIn?.terminalState ?? null,
    canonicalAnswer: fanIn?.canonicalAnswer ?? null,
    sqliteIntegrity,
    boundary: WORK_GRAPH_ACCEPTANCE_BOUNDARY,
    limitations: WORK_GRAPH_ACCEPTANCE_BOUNDARY.limitations,
  };
}

/** Alias used by callers that name the scenario by its gauntlet role. */
export const runWorkGraphGauntlet = runWorkGraphAcceptance;
