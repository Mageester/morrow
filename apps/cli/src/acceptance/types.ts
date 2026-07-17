export const ACCEPTANCE_DISPOSITIONS = ["PASS", "FAIL", "BLOCKED", "NOT RUN", "INCONCLUSIVE"] as const;
export type AcceptanceDisposition = (typeof ACCEPTANCE_DISPOSITIONS)[number];

export type AcceptanceLifecycle = "created" | "running" | "completed";
export type EvidenceStatus = "passed" | "failed" | "inconclusive" | "info";
export type AcceptanceScenarioId = "foundation-smoke-v1" | "durable-autonomy-v1";

export interface FixtureState {
  path: string;
  startingSha: string;
  startingStatus: string;
}

export interface ProductState {
  home: string;
  entrypoint: string;
  packaged: boolean;
  version: string;
  taskId: string | null;
  missionId?: string | null;
  exitCode: number | null;
}

export interface SourceFingerprint {
  commit: string | null;
  statusHash: string | null;
}

export interface PackageProvenanceState {
  packaged: boolean;
  sourceCommit: string | null;
  dirty: boolean | null;
  version: string | null;
  buildTimestamp: string | null;
  schemaCatalogVersion: number | null;
  manifestHash: string | null;
  matchesIntendedCommit: boolean | null;
}

export interface AcceptanceCheck {
  status: EvidenceStatus;
  summary: string;
  evidenceIds: string[];
}

export interface AcceptanceRunState {
  schemaVersion: 1;
  runId: string;
  scenarioId: AcceptanceScenarioId;
  lifecycle: AcceptanceLifecycle;
  disposition: AcceptanceDisposition;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  activeStep: string | null;
  completedSteps: string[];
  recoveryCount: number;
  fixture: FixtureState | null;
  product: ProductState | null;
  source: SourceFingerprint | null;
  provenance: PackageProvenanceState | null;
  checks: Record<string, AcceptanceCheck>;
  artifacts: string[];
  message: string | null;
}

export interface EvidenceEntry {
  schemaVersion: 1;
  id: string;
  runId: string;
  sequence: number;
  timestamp: string;
  step: string;
  kind: string;
  status: EvidenceStatus;
  summary: string;
  artifact?: string;
  details?: Record<string, unknown>;
}

export type NewEvidenceEntry = Omit<EvidenceEntry, "schemaVersion" | "id" | "runId" | "sequence" | "timestamp">;

export interface AcceptanceReport {
  schemaVersion: 1;
  runId: string;
  scenarioId: string;
  disposition: AcceptanceDisposition;
  startedAt: string;
  completedAt: string | null;
  product: {
    version: string;
    packaged: boolean;
    exitCode: number | null;
    taskId: string | null;
    missionId: string | null;
  } | null;
  fixture: { startingSha: string } | null;
  sourceUntouched: boolean | null;
  provenance: PackageProvenanceState | null;
  recoveryCount: number;
  checks: Record<string, AcceptanceCheck>;
  evidence: EvidenceEntry[];
  artifacts: string[];
  message: string | null;
}
