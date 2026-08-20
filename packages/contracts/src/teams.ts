import { z } from "zod";
import type { MemoryScope, ReasoningConfiguration } from "./index.js";
import { MemoryScopeSchema as RealMemoryScopeSchema, ReasoningConfigurationSchema as RealReasoningConfigurationSchema } from "./index.js";

// index.ts re-exports this file via `export * from "./teams.js"`, so this
// module is a dependency of index.ts and is evaluated BEFORE any of
// index.ts's own top-level `const` schema definitions run. Importing
// MemoryScopeSchema/ReasoningConfigurationSchema as ordinary values would
// read them while still undefined. z.lazy() defers the actual reference
// until parse time, by which point the whole module graph has finished
// loading — the standard fix for this kind of same-package circular import.
// SchemaVersionSchema is trivial (always z.literal(1)) so it's just
// re-declared locally rather than routed through the same indirection.
const SchemaVersionSchema = z.literal(1);
const MemoryScopeSchema: z.ZodType<MemoryScope> = z.lazy(() => RealMemoryScopeSchema);
const ReasoningConfigurationSchema: z.ZodType<ReasoningConfiguration> = z.lazy(() => RealReasoningConfigurationSchema);

/**
 * Private assistant, agent teams, and delegation — first vertical slice.
 *
 * Design invariants:
 * - `PrivacyModeSchema` matches the shipped docs/privacy-model.md taxonomy
 *   exactly (Local only / Controlled cloud / Custom). Web/browser-tool access
 *   is deliberately NOT a fourth privacy mode — it is a per-agent tool
 *   permission (see AgentToolPermission in ./index.ts), so it composes with
 *   any privacy mode instead of forking a second taxonomy.
 * - A Team/Agent's effective policy is always the intersection of parent task
 *   authority, team policy, and the agent's own policy. Nothing here lets a
 *   child agent widen that intersection — budgets, scopes, and approval
 *   requirements are server-computed at delegation-creation time, never
 *   accepted from client or model output.
 * - `ephemeral` memory (request-only context) is intentionally NOT a
 *   MemoryScope value — it must never be persisted, so it has no row shape.
 */

// ── Privacy & approval posture ──────────────────────────────────────────────

export const PrivacyModeSchema = z.enum(["local_only", "controlled_cloud", "custom"]);
export type PrivacyMode = z.infer<typeof PrivacyModeSchema>;

/** Default stance for new approvals — distinct from ApprovalDecisionSchema, which resolves one specific pending approval. */
export const ApprovalPostureSchema = z.enum(["ask_always", "trust_reads", "trust_project"]);
export type ApprovalPosture = z.infer<typeof ApprovalPostureSchema>;

// ── Assistant profile (singleton, not project-scoped) ───────────────────────

export const CommsVerbositySchema = z.enum(["concise", "detailed"]);
export type CommsVerbosity = z.infer<typeof CommsVerbositySchema>;
export const CommsToneSchema = z.enum(["technical", "nontechnical"]);
export type CommsTone = z.infer<typeof CommsToneSchema>;

export const AssistantGoalSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(500),
  enabled: z.boolean(),
}).strict();
export type AssistantGoal = z.infer<typeof AssistantGoalSchema>;

export const AssistantProfileSchema = z.object({
  version: SchemaVersionSchema,
  // Single local row. Not project-scoped: this is deliberately the one
  // cross-project "who is this user" entity (see docs/decisions/0012).
  id: z.literal("default"),
  displayName: z.string().max(120).nullable(),
  assistantName: z.string().max(60).nullable(),
  commsVerbosity: CommsVerbositySchema.default("concise"),
  commsTone: CommsToneSchema.default("nontechnical"),
  timezone: z.string().min(1).max(80).nullable(),
  locale: z.string().min(1).max(35).nullable(),
  defaultProviderId: z.string().nullable(),
  defaultModel: z.string().nullable(),
  defaultReasoning: ReasoningConfigurationSchema.default({ mode: "auto" }),
  defaultPrivacyMode: PrivacyModeSchema.default("local_only"),
  defaultApprovalPosture: ApprovalPostureSchema.default("ask_always"),
  goals: z.array(AssistantGoalSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type AssistantProfile = z.infer<typeof AssistantProfileSchema>;

export const UpdateAssistantProfileSchema = z.object({
  displayName: z.string().trim().max(120).nullable().optional(),
  assistantName: z.string().trim().max(60).nullable().optional(),
  commsVerbosity: CommsVerbositySchema.optional(),
  commsTone: CommsToneSchema.optional(),
  timezone: z.string().trim().max(80).nullable().optional(),
  locale: z.string().trim().max(35).nullable().optional(),
  defaultProviderId: z.string().nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  defaultReasoning: ReasoningConfigurationSchema.optional(),
  defaultPrivacyMode: PrivacyModeSchema.optional(),
  defaultApprovalPosture: ApprovalPostureSchema.optional(),
}).strict();
export type UpdateAssistantProfileInput = z.infer<typeof UpdateAssistantProfileSchema>;

export const CreateAssistantGoalSchema = z.object({
  text: z.string().trim().min(1).max(500),
  enabled: z.boolean().default(true),
}).strict();
export type CreateAssistantGoalInput = z.infer<typeof CreateAssistantGoalSchema>;

// ── Teams ────────────────────────────────────────────────────────────────

export const TeamStatusSchema = z.enum(["draft", "active", "paused", "archived"]);
export type TeamStatus = z.infer<typeof TeamStatusSchema>;
export const SharedMemoryPolicySchema = z.enum(["none", "read", "read_write"]);
export type SharedMemoryPolicy = z.infer<typeof SharedMemoryPolicySchema>;
export const TeamArtifactPolicySchema = z.enum(["workspace_write", "verified_only"]);
export type TeamArtifactPolicy = z.infer<typeof TeamArtifactPolicySchema>;

export const TeamSchema = z.object({
  version: SchemaVersionSchema,
  id: z.string(),
  projectId: z.string(),
  name: z.string().min(1).max(120),
  purpose: z.string().max(2000).nullable(),
  status: TeamStatusSchema,
  sharedMemoryPolicy: SharedMemoryPolicySchema,
  defaultMaxProviderCalls: z.number().int().positive().nullable(),
  defaultMaxTokenBudget: z.number().int().positive().nullable(),
  defaultMaxWallClockMs: z.number().int().positive().nullable(),
  // Sequential-only in this slice; concurrency stays fixed at 1 until
  // ownership and cancellation are proven (see plan risk notes).
  defaultConcurrencyLimit: z.number().int().positive().default(1),
  defaultApprovalRequired: z.boolean(),
  artifactPolicy: TeamArtifactPolicySchema,
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type Team = z.infer<typeof TeamSchema>;

export const TeamMemberSchema = z.object({
  version: SchemaVersionSchema,
  teamId: z.string(),
  agentId: z.string(),
  position: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
}).strict();
export type TeamMember = z.infer<typeof TeamMemberSchema>;

/** The only team preset available in this slice. Creating a team means instantiating this. */
export const TeamPresetIdSchema = z.enum(["research_and_verify"]);
export type TeamPresetId = z.infer<typeof TeamPresetIdSchema>;

export const CreateTeamFromPresetSchema = z.object({
  preset: TeamPresetIdSchema,
  name: z.string().trim().min(1).max(120).optional(),
}).strict();
export type CreateTeamFromPresetInput = z.infer<typeof CreateTeamFromPresetSchema>;

// ── Delegation & handoff ────────────────────────────────────────────────────

/**
 * The only model-authored input for an in-process teammate request. Provider,
 * model, policy, budgets, and approval posture are deliberately absent: the
 * orchestrator resolves those from the target's durable agent profile.
 */
export const AskTeammateSchema = z.object({
  agentId: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(2000),
}).strict();
export type AskTeammateInput = z.infer<typeof AskTeammateSchema>;

export const DelegationStatusSchema = z.enum([
  "pending_approval", "approved", "rejected", "running", "completed", "failed", "cancelled",
]);
export type DelegationStatus = z.infer<typeof DelegationStatusSchema>;

export const DelegationBudgetSchema = z.object({
  maxProviderCalls: z.number().int().positive().nullable(),
  maxTokenBudget: z.number().int().positive().nullable(),
  maxWallClockMs: z.number().int().positive().nullable(),
}).strict();
export type DelegationBudget = z.infer<typeof DelegationBudgetSchema>;

export const DelegationSchema = z.object({
  version: SchemaVersionSchema,
  id: z.string(),
  parentTaskId: z.string(),
  teamId: z.string(),
  agentId: z.string(),
  objective: z.string().min(1).max(2000),
  acceptanceCriteria: z.array(z.string().min(1).max(500)).default([]),
  contextSnapshotRef: z.string().min(1).max(1024),
  allowedTools: z.array(z.string().min(1).max(120)).default([]),
  allowedMemoryScopes: z.array(MemoryScopeSchema).default([]),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  budget: DelegationBudgetSchema,
  approvalRequired: z.boolean(),
  status: DelegationStatusSchema,
  deadlineAt: z.string().datetime().nullable(),
  correlationId: z.string(),
  // Set once the child task is actually spawned (after approval).
  childTaskId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type Delegation = z.infer<typeof DelegationSchema>;

// Client input is intentionally narrow: status, budget, allowedTools,
// allowedMemoryScopes, providerId/model, and approvalRequired are all
// server-computed from the team/agent policy intersection, never accepted
// from the caller.
export const CreateDelegationSchema = z.object({
  teamId: z.string().min(1),
  agentId: z.string().min(1),
  objective: z.string().trim().min(1).max(2000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  deadlineAt: z.string().datetime().nullable().optional(),
}).strict();
export type CreateDelegationInput = z.infer<typeof CreateDelegationSchema>;

// Delegation identifiers are not sufficient authorization context. Every read
// or mutation of a delegation must carry the durable parent task identity so
// the server can re-check project and object ownership before acting.
export const DelegationAccessContextSchema = z.object({
  parentTaskId: z.string().min(1),
}).strict();
export type DelegationAccessContext = z.infer<typeof DelegationAccessContextSchema>;

export const ResolveDelegationSchema = DelegationAccessContextSchema.extend({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500).optional(),
}).strict();
export type ResolveDelegationInput = z.infer<typeof ResolveDelegationSchema>;

export const AcceptanceCriterionStatusSchema = z.object({
  criterion: z.string().min(1).max(500),
  met: z.boolean(),
  note: z.string().max(500).nullable().default(null),
}).strict();
export type AcceptanceCriterionStatus = z.infer<typeof AcceptanceCriterionStatusSchema>;

export const HandoffArtifactRefSchema = z.object({
  id: z.string(),
  path: z.string().min(1).max(1024),
  contentHash: z.string().min(1).max(128),
}).strict();
export type HandoffArtifactRef = z.infer<typeof HandoffArtifactRefSchema>;

// A model's prose saying "done" is never a handoff on its own — the parent
// must inspect these durable fields (acceptanceCriteriaStatus, artifactRefs,
// verificationEvidence), not just resultSummary text.
export const HandoffSchema = z.object({
  version: SchemaVersionSchema,
  id: z.string(),
  delegationId: z.string(),
  taskId: z.string(),
  resultSummary: z.string().min(1).max(4000),
  acceptanceCriteriaStatus: z.array(AcceptanceCriterionStatusSchema).default([]),
  artifactRefs: z.array(HandoffArtifactRefSchema).default([]),
  verificationEvidence: z.string().max(4000).nullable(),
  unresolvedRisks: z.array(z.string().max(500)).default([]),
  sourceAgentId: z.string(),
  targetAgentId: z.string().nullable(),
  createdAt: z.string().datetime(),
}).strict();
export type Handoff = z.infer<typeof HandoffSchema>;

export const CreateHandoffSchema = DelegationAccessContextSchema.extend({
  resultSummary: z.string().trim().min(1).max(4000),
  acceptanceCriteriaStatus: z.array(AcceptanceCriterionStatusSchema.omit({ note: true }).extend({ note: z.string().max(500).nullable().optional() })).max(20).default([]),
  artifactRefs: z.array(HandoffArtifactRefSchema).max(20).default([]),
  verificationEvidence: z.string().trim().max(4000).nullable().optional(),
  unresolvedRisks: z.array(z.string().trim().max(500)).max(20).default([]),
  targetAgentId: z.string().nullable().optional(),
}).strict();
export type CreateHandoffInput = z.infer<typeof CreateHandoffSchema>;
