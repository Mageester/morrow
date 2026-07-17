import { z } from "zod";

/**
 * Morrow Cortex — the canonical project-intelligence model.
 *
 * One structured, persisted, queryable representation of what Morrow knows
 * about a repository, shared by persistence, orchestrator, API, and CLI.
 * Design invariants:
 * - Every item carries explicit sources and confidence; nothing is presented
 *   as certain without evidence.
 * - Freshness is first-class: items age from current → possibly_stale →
 *   stale/invalidated via scoped repository fingerprints, never silently.
 * - Inferred knowledge never outranks explicit user rules, and inferred
 *   conventions require approval to become durable truth.
 * - No chain-of-thought, no conversation blobs, no whole-repository dumps —
 *   conclusions, evidence references, and concise summaries only.
 */

// ── shared metadata ──────────────────────────────────────────────────────────

/** Where a conclusion came from: a repository file, a mission, or a user act. */
export const IntelligenceSourceSchema = z.object({
  kind: z.enum(["file", "mission", "user", "command"]),
  /** Repo-relative path, mission id, or command line, depending on kind. */
  reference: z.string().min(1).max(1024),
  /** Short note on what this source establishes. */
  note: z.string().max(500).optional(),
}).strict();
export type IntelligenceSource = z.infer<typeof IntelligenceSourceSchema>;

export const IntelligenceFreshnessSchema = z.enum(["current", "possibly_stale", "stale", "invalidated"]);
export type IntelligenceFreshness = z.infer<typeof IntelligenceFreshnessSchema>;

export const ConfidenceSchema = z.number().min(0).max(1);

// ── architecture map ─────────────────────────────────────────────────────────

export const ArchitectureComponentSchema = z.object({
  /** Repo-relative path of the component root (e.g. "apps/cli"). */
  path: z.string().min(1).max(1024),
  name: z.string().min(1).max(200),
  kind: z.enum(["application", "library", "service", "benchmark", "infrastructure", "docs", "unknown"]),
  /** Best-effort short description from manifest/readme, never invented. */
  description: z.string().max(500).nullable().default(null),
  entryPoints: z.array(z.string().max(1024)).default([]),
  dependsOn: z.array(z.string().max(200)).default([]),
}).strict();
export type ArchitectureComponent = z.infer<typeof ArchitectureComponentSchema>;

export const RepositoryCommandSchema = z.object({
  id: z.string(),
  /** e.g. "test", "build", "check", "e2e", "lint", "dev", "custom" */
  role: z.string().min(1).max(60),
  command: z.string().min(1).max(500),
  /** Where the command runs from ("." for repo root). */
  cwd: z.string().max(1024).default("."),
  sources: z.array(IntelligenceSourceSchema).default([]),
  confidence: ConfidenceSchema.default(0.5),
  /** Set when a mission actually ran it successfully. */
  lastVerifiedAt: z.string().datetime().nullable().default(null),
}).strict();
export type RepositoryCommand = z.infer<typeof RepositoryCommandSchema>;

export const ArchitectureBoundarySchema = z.object({
  description: z.string().min(1).max(500),
  sources: z.array(IntelligenceSourceSchema).default([]),
  confidence: ConfidenceSchema.default(0.5),
}).strict();

/**
 * Scoped fingerprints let staleness detection invalidate only the affected
 * area: a lockfile change should not invalidate boundary knowledge, and a
 * README edit should invalidate nothing.
 */
export const ArchitectureScopeFingerprintSchema = z.object({
  /** e.g. "workspaces", "manifests", "lockfiles", "build_config", "test_config", "entry_points" */
  scope: z.string().min(1).max(60),
  /** SHA-256 over the sorted relevant file paths + contents. */
  hash: z.string().min(8).max(128),
  files: z.array(z.string().max(1024)).default([]),
}).strict();
export type ArchitectureScopeFingerprint = z.infer<typeof ArchitectureScopeFingerprintSchema>;

export const ArchitectureMapSchema = z.object({
  languages: z.array(z.object({ language: z.string(), files: z.number().int().nonnegative() }).strict()).default([]),
  packageManagers: z.array(z.string().max(60)).default([]),
  /** Workspace globs / member lists from pnpm-workspace, cargo workspace, etc. */
  workspaces: z.array(z.string().max(200)).default([]),
  components: z.array(ArchitectureComponentSchema).default([]),
  commands: z.array(RepositoryCommandSchema).default([]),
  configFiles: z.array(z.string().max(1024)).default([]),
  docs: z.array(z.string().max(1024)).default([]),
  /** Generated or protected areas that must not be hand-edited. */
  generatedPaths: z.array(z.string().max(1024)).default([]),
  boundaries: z.array(ArchitectureBoundarySchema).default([]),
  scopeFingerprints: z.array(ArchitectureScopeFingerprintSchema).default([]),
  freshness: IntelligenceFreshnessSchema.default("current"),
  generatedAt: z.string().datetime(),
}).strict();
export type ArchitectureMap = z.infer<typeof ArchitectureMapSchema>;

// ── conventions and rules ────────────────────────────────────────────────────

export const ConventionApprovalSchema = z.enum(["inferred", "approved", "rejected"]);
export type ConventionApproval = z.infer<typeof ConventionApprovalSchema>;

export const RepositoryConventionSchema = z.object({
  id: z.string(),
  description: z.string().min(1).max(500),
  /** Repo-relative scope this applies to ("." = whole repo). */
  scope: z.string().max(1024).default("."),
  confidence: ConfidenceSchema,
  sources: z.array(IntelligenceSourceSchema).default([]),
  approval: ConventionApprovalSchema.default("inferred"),
  freshness: IntelligenceFreshnessSchema.default("current"),
  firstObservedAt: z.string().datetime(),
  lastConfirmedAt: z.string().datetime(),
}).strict();
export type RepositoryConvention = z.infer<typeof RepositoryConventionSchema>;

/** Explicit user rules outrank every inferred convention. */
export const ProjectRuleSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(500),
  scope: z.string().max(1024).default("."),
  active: z.boolean().default(true),
  createdAt: z.string().datetime(),
}).strict();
export type ProjectRule = z.infer<typeof ProjectRuleSchema>;

// ── decisions ────────────────────────────────────────────────────────────────

export const DecisionStatusSchema = z.enum(["proposed", "accepted", "superseded", "rejected", "obsolete"]);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

export const ArchitectureDecisionSchema = z.object({
  id: z.string(),
  /** Human-readable short key, e.g. "D-014". */
  label: z.string().min(1).max(20),
  statement: z.string().min(1).max(500),
  context: z.string().max(2000).default(""),
  alternatives: z.array(z.string().max(500)).default([]),
  consequences: z.array(z.string().max(500)).default([]),
  affectedComponents: z.array(z.string().max(200)).default([]),
  sources: z.array(IntelligenceSourceSchema).default([]),
  missionId: z.string().nullable().default(null),
  status: DecisionStatusSchema.default("accepted"),
  supersededBy: z.string().nullable().default(null),
  freshness: IntelligenceFreshnessSchema.default("current"),
  createdAt: z.string().datetime(),
}).strict();
export type ArchitectureDecision = z.infer<typeof ArchitectureDecisionSchema>;

// ── risks + relationships ────────────────────────────────────────────────────

export const ProjectRiskSchema = z.object({
  id: z.string(),
  description: z.string().min(1).max(500),
  area: z.string().max(1024).default("."),
  severity: z.enum(["low", "medium", "high"]).default("medium"),
  sources: z.array(IntelligenceSourceSchema).default([]),
  confidence: ConfidenceSchema,
  freshness: IntelligenceFreshnessSchema.default("current"),
  createdAt: z.string().datetime(),
}).strict();
export type ProjectRisk = z.infer<typeof ProjectRiskSchema>;

/** e.g. files commonly changed together, import boundary between packages. */
export const CodeRelationshipSchema = z.object({
  id: z.string(),
  kind: z.enum(["changed_together", "imports", "depends_on", "boundary"]),
  from: z.string().min(1).max(1024),
  to: z.string().min(1).max(1024),
  note: z.string().max(500).nullable().default(null),
  sources: z.array(IntelligenceSourceSchema).default([]),
  confidence: ConfidenceSchema,
  freshness: IntelligenceFreshnessSchema.default("current"),
  createdAt: z.string().datetime(),
}).strict();
export type CodeRelationship = z.infer<typeof CodeRelationshipSchema>;

// ── mission learnings ────────────────────────────────────────────────────────

export const MissionLearningTypeSchema = z.enum([
  "validation_command", "misleading_symptom", "failed_approach", "dependency",
  "fragile_test", "platform_behavior", "convention", "risk", "ownership",
  "recovery_strategy", "false_assumption",
]);
export type MissionLearningType = z.infer<typeof MissionLearningTypeSchema>;

export const MissionLearningSchema = z.object({
  id: z.string(),
  statement: z.string().min(1).max(500),
  type: MissionLearningTypeSchema,
  confidence: ConfidenceSchema,
  /** Evidence ids / failure ids / file refs backing the statement. */
  sources: z.array(IntelligenceSourceSchema).min(1),
  missionId: z.string(),
  scope: z.string().max(1024).default("."),
  /** Human-readable condition under which this stops being trustworthy. */
  stalenessCondition: z.string().max(500).nullable().default(null),
  affectsPlanning: z.boolean().default(true),
  freshness: IntelligenceFreshnessSchema.default("current"),
  createdAt: z.string().datetime(),
}).strict();
export type MissionLearning = z.infer<typeof MissionLearningSchema>;

// ── automatically learned skills ────────────────────────────────────────────

export const LearnedSkillStateSchema = z.enum(["candidate", "validating", "active", "rejected", "superseded", "rolled_back"]);
export const LearnedSkillProvenanceSchema = z.object({
  missionId: z.string().min(1),
  learningId: z.string().min(1),
  evidenceReferences: z.array(IntelligenceSourceSchema).min(1),
  observedAt: z.string().datetime(),
}).strict();
export type LearnedSkillProvenance = z.infer<typeof LearnedSkillProvenanceSchema>;
export const LearnedSkillPermissionsSchema = z.object({
  tools: z.array(z.string()).default([]),
  filesystemScopes: z.array(z.string()).default([]),
  networkDomains: z.array(z.string()).default([]),
  requiredSecrets: z.array(z.string()).default([]),
}).strict();
export const LearnedSkillSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  triggerConditions: z.array(z.string().min(1)).min(1),
  scope: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  permissions: LearnedSkillPermissionsSchema,
  validationRequirements: z.array(z.string().min(1)).min(1),
  provenance: z.array(LearnedSkillProvenanceSchema).min(1),
  state: LearnedSkillStateSchema,
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  confidence: ConfidenceSchema,
  lastVerifiedAt: z.string().datetime().nullable(),
  rollbackHistory: z.array(z.object({ version: z.string(), reason: z.string(), at: z.string().datetime() }).strict()),
  workflowFingerprint: z.string().min(16),
  directory: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type LearnedSkill = z.infer<typeof LearnedSkillSchema>;

// ── uncertainties ────────────────────────────────────────────────────────────

export const IntelligenceUncertaintySchema = z.object({
  id: z.string(),
  area: z.string().min(1).max(200),
  description: z.string().min(1).max(500),
  createdAt: z.string().datetime(),
}).strict();
export type IntelligenceUncertainty = z.infer<typeof IntelligenceUncertaintySchema>;

// ── the canonical aggregate ──────────────────────────────────────────────────

export const PROJECT_INTELLIGENCE_SCHEMA_VERSION = 1;

export const ProjectIntelligenceSchema = z.object({
  projectId: z.string(),
  /** Whole-repository fingerprint (architecture-critical files). */
  repositoryFingerprint: z.string().min(8).max(128),
  architecture: ArchitectureMapSchema,
  conventions: z.array(RepositoryConventionSchema).default([]),
  commands: z.array(RepositoryCommandSchema).default([]),
  decisions: z.array(ArchitectureDecisionSchema).default([]),
  risks: z.array(ProjectRiskSchema).default([]),
  relationships: z.array(CodeRelationshipSchema).default([]),
  missionLearnings: z.array(MissionLearningSchema).default([]),
  userRules: z.array(ProjectRuleSchema).default([]),
  uncertainties: z.array(IntelligenceUncertaintySchema).default([]),
  generatedAt: z.string().datetime(),
  refreshedAt: z.string().datetime(),
  schemaVersion: z.number().int().positive(),
}).strict();
export type ProjectIntelligence = z.infer<typeof ProjectIntelligenceSchema>;

// ── impact analysis ──────────────────────────────────────────────────────────

export const ChangeImpactAnalysisSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  objective: z.string().min(1).max(2000),
  likelyFiles: z.array(z.string().max(1024)).default([]),
  likelyComponents: z.array(z.string().max(200)).default([]),
  interfacesAtRisk: z.array(z.string().max(500)).default([]),
  testsLikelyAffected: z.array(z.string().max(1024)).default([]),
  relevantDecisions: z.array(z.string().max(200)).default([]),
  relevantFailures: z.array(z.string().max(500)).default([]),
  relevantRules: z.array(z.string().max(500)).default([]),
  possibleRegressions: z.array(z.string().max(500)).default([]),
  requiredVerification: z.array(z.string().max(500)).default([]),
  /** Explicit statement of what the analysis is unsure about. */
  uncertainty: z.array(z.string().max(500)).default([]),
  createdAt: z.string().datetime(),
}).strict();
export type ChangeImpactAnalysis = z.infer<typeof ChangeImpactAnalysisSchema>;

// ── adaptive planning ────────────────────────────────────────────────────────

export const PlanRevisionTriggerSchema = z.enum([
  "test_contradiction", "missing_expectation", "repeated_tool_failure",
  "review_revisions", "repository_changed", "boundary_discovered",
  "budget_constraint", "user_intervention",
]);
export type PlanRevisionTrigger = z.infer<typeof PlanRevisionTriggerSchema>;

export const PlanRevisionSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  revision: z.number().int().positive(),
  trigger: PlanRevisionTriggerSchema,
  triggerDetail: z.string().max(1000).default(""),
  invalidatedAssumption: z.string().max(500).nullable().default(null),
  tasksRemoved: z.array(z.string().max(500)).default([]),
  tasksAdded: z.array(z.string().max(500)).default([]),
  dependenciesChanged: z.array(z.string().max(500)).default([]),
  verificationChanges: z.array(z.string().max(500)).default([]),
  budgetImpact: z.string().max(500).nullable().default(null),
  createdAt: z.string().datetime(),
}).strict();
export type PlanRevision = z.infer<typeof PlanRevisionSchema>;

/** Bounded replanning: missions may never revise the plan more than this. */
export const MAX_PLAN_REVISIONS = 5;

// ── API inputs ───────────────────────────────────────────────────────────────

export const CreateProjectRuleSchema = z.object({
  text: z.string().trim().min(1).max(500),
  scope: z.string().max(1024).optional(),
}).strict();
export type CreateProjectRuleInput = z.infer<typeof CreateProjectRuleSchema>;

export const PatchConventionSchema = z.object({
  approval: z.enum(["approved", "rejected"]),
}).strict();
export type PatchConventionInput = z.infer<typeof PatchConventionSchema>;

export const RefreshIntelligenceSchema = z.object({
  /** Restrict the refresh to specific scopes; omit for a full refresh. */
  scopes: z.array(z.string().max(60)).optional(),
}).strict();
export type RefreshIntelligenceInput = z.infer<typeof RefreshIntelligenceSchema>;
