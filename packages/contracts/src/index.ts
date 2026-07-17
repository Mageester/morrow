import { z } from "zod";
export const SchemaVersionSchema=z.literal(1);
export const ProviderIdSchema=z.enum(["deterministic-local","mock","openai","anthropic","gemini","openrouter","deepseek","openai-compatible","ollama"]);
export const TaskStatusSchema=z.enum(["queued","running","completed","verified","failed","cancelled","interrupted"]);
export const AgentExecutionStateSchema=z.enum(["idle","understanding","planning","waiting_for_approval","executing_tool","observing","proposing_changes","applying_changes","verifying","completed","failed","cancelled","interrupted"]);
export const ApprovalKindSchema=z.enum(["command","change_set"]);
export const ApprovalStatusSchema=z.enum(["pending","approved","denied","cancelled"]);
export const ApprovalDecisionSchema=z.enum(["allow_once","trust_project","deny"]);
export const PlanStepStatusSchema=z.enum(["pending","running","completed","failed","skipped"]);
export const ProjectSchema=z.object({version:SchemaVersionSchema,id:z.string(),name:z.string().min(1),workspacePath:z.string().min(1),createdAt:z.string().datetime()}).strict();
export const CreateProjectSchema=z.object({name:z.string().trim().min(1).max(120),workspacePath:z.string().min(1)});
export const PlanStepSchema=z.object({version:SchemaVersionSchema,id:z.string(),taskId:z.string(),position:z.number().int().positive(),title:z.string(),description:z.string(),status:PlanStepStatusSchema}).strict();
export const TaskSchema=z.object({version:SchemaVersionSchema,id:z.string(),projectId:z.string(),kind:z.enum(["inspect_workspace","agent_chat"]),status:TaskStatusSchema,parentTaskId:z.string().nullable().default(null),agentId:z.string().nullable().optional(),worktreeId:z.string().nullable().optional(),missionId:z.string().nullable().optional(),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict();
export const SpawnSubagentSchema=z.object({kind:z.enum(["inspect_workspace"]).default("inspect_workspace"),label:z.string().trim().max(120).optional()}).strict();
export type SpawnSubagentInput=z.infer<typeof SpawnSubagentSchema>;
export const CreateCheckpointSchema=z.object({name:z.string().trim().min(1).max(100),files:z.array(z.string().min(1).max(1024)).min(1).max(500).optional(),taskId:z.string().optional()}).strict();
export type CreateCheckpointInput=z.infer<typeof CreateCheckpointSchema>;
export const StartProcessSchema=z.object({command:z.string().trim().min(1).max(500),args:z.array(z.string().max(4096)).max(100).default([]),cwd:z.string().max(1024).optional(),taskId:z.string().optional(),agentId:z.string().optional(),mode:z.enum(["pipe","pty"]).default("pipe"),timeoutMs:z.number().int().positive().max(86400000).optional()}).strict();
export type StartProcessInput=z.infer<typeof StartProcessSchema>;
export const ProcessStatusSchema=z.enum(["running","exited","failed","cancelled","lost"]);
export const CreateWorktreeSchema=z.object({name:z.string().trim().min(1).max(81).optional(),taskId:z.string().optional(),agentId:z.string().optional(),baseRef:z.string().trim().min(1).max(200).optional()}).strict();
export type CreateWorktreeInput=z.infer<typeof CreateWorktreeSchema>;
export const CreateTaskSchema=z.object({projectId:z.string().min(1),kind:z.enum(["inspect_workspace","agent_chat"]),conversationId:z.string().optional(),preset:z.string().optional(),agentId:z.string().optional()});
export const TaskEventSchema=z.object({id:z.string(),taskId:z.string(),sequence:z.number().int().positive(),type:z.enum(["task.created","task.running","plan.created","step.started","step.completed","workspace.inspected","evidence.persisted","assistant.turn_started","assistant.turn_completed","agent.state_changed","approval.requested","approval.resolved","verification.completed","tool.started","tool.completed","tool.failed","tool.arguments_rejected","tool.strategy_switch","patch.recovery_feedback","task.verified","task.completed","task.failed","task.cancelled","task.interrupted","task.progress_warning","task.recovery_required","task.recovery_requeued","provider.fallback","provider.rate_limited","provider.usage","context.trimmed","context.budget_calculated","context.estimate_used","context.exact_count_used","context.compaction_started","context.compaction_completed","context.compaction_failed","context.history_trimmed","context.safety_fallback_applied","context.minimum_viable_context_exceeded","process.started","process.exited"]),createdAt:z.string(),payload:z.record(z.string(),z.unknown())});
export const AgentStateTransitionSchema=z.object({version:SchemaVersionSchema,id:z.string(),taskId:z.string(),sequence:z.number().int().positive(),state:AgentExecutionStateSchema,details:z.record(z.string(),z.unknown()),createdAt:z.string().datetime()}).strict();
export const ApprovalSchema=z.object({version:SchemaVersionSchema,id:z.string(),taskId:z.string(),projectId:z.string(),kind:ApprovalKindSchema,status:ApprovalStatusSchema,summary:z.string().min(1).max(240),details:z.record(z.string(),z.unknown()),decision:ApprovalDecisionSchema.nullable(),decisionNote:z.string().nullable(),createdAt:z.string().datetime(),resolvedAt:z.string().datetime().nullable()}).strict();
export const ResolveApprovalSchema=z.object({projectId:z.string().min(1),decision:ApprovalDecisionSchema,trustPattern:z.string().trim().min(1).max(240).optional(),note:z.string().trim().max(500).optional()}).strict().refine((value)=>value.decision!=="trust_project"||value.trustPattern!==undefined,{message:"trustPattern is required when trusting a command pattern",path:["trustPattern"]});
export const CommandTrustSchema=z.object({version:SchemaVersionSchema,projectId:z.string(),pattern:z.string().min(1).max(240),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict();
export const TaskEvidenceSchema=z.object({version:SchemaVersionSchema,id:z.string(),taskId:z.string(),type:z.literal("file"),path:z.string(),metadata:z.record(z.string(),z.unknown()),createdAt:z.string().datetime()}).strict();
export const ExecutionDisclosureSchema=z.object({version:SchemaVersionSchema,taskId:z.string(),executionMode:z.enum(["deterministic-local","agent-interactive"]),provider:ProviderIdSchema,networkAccess:z.enum(["disabled","enabled"]),filesystemAccess:z.enum(["read-only","workspace-write"]),shellExecution:z.boolean(),modelInvocation:z.boolean(),workspaceScope:z.string().min(1),estimatedCostUsd:z.string(),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict();
export const VerificationResultSchema=z.object({version:SchemaVersionSchema,taskId:z.string(),status:z.literal("verified"),summary:z.string(),details:z.record(z.string(),z.unknown()),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict();
export const StructuredApiErrorSchema=z.object({version:SchemaVersionSchema,error:z.object({code:z.string(),message:z.string()}).strict()}).strict();

export const ConversationSchema=z.object({version:SchemaVersionSchema,id:z.string(),projectId:z.string(),title:z.string(),archived:z.boolean().default(false),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict();
export const UpdateConversationSchema=z.object({title:z.string().trim().min(1).max(200).optional(),archived:z.boolean().optional()}).strict().refine((v)=>v.title!==undefined||v.archived!==undefined,{message:"Provide title or archived"});
export const ConversationMessageSchema=z.object({version:SchemaVersionSchema,id:z.string(),conversationId:z.string(),role:z.enum(["user","assistant"]),content:z.string(),taskId:z.string().nullable().optional(),streamingState:z.enum(["queued","streaming","completed","failed","cancelled","interrupted"]),provider:z.string().nullable().optional(),model:z.string().nullable().optional(),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict();

export type Project=z.infer<typeof ProjectSchema>;
export type Task=z.infer<typeof TaskSchema>;
export type TaskEvent=z.infer<typeof TaskEventSchema>;
export type PlanStep=z.infer<typeof PlanStepSchema>;
export type TaskEvidence=z.infer<typeof TaskEvidenceSchema>;
export type ExecutionDisclosure=z.infer<typeof ExecutionDisclosureSchema>;
export type VerificationResult=z.infer<typeof VerificationResultSchema>;
export type TaskStatus=z.infer<typeof TaskStatusSchema>;
export type AgentExecutionState=z.infer<typeof AgentExecutionStateSchema>;
export type AgentStateTransition=z.infer<typeof AgentStateTransitionSchema>;
export type ApprovalKind=z.infer<typeof ApprovalKindSchema>;
export type ApprovalStatus=z.infer<typeof ApprovalStatusSchema>;
export type ApprovalDecision=z.infer<typeof ApprovalDecisionSchema>;
export type Approval=z.infer<typeof ApprovalSchema>;
export type ResolveApprovalInput=z.infer<typeof ResolveApprovalSchema>;
export type CommandTrust=z.infer<typeof CommandTrustSchema>;
export type PlanStepStatus=z.infer<typeof PlanStepStatusSchema>;
export type StructuredApiError=z.infer<typeof StructuredApiErrorSchema>;
export type Conversation=z.infer<typeof ConversationSchema>;
export type ConversationMessage=z.infer<typeof ConversationMessageSchema>;

// ── Provider runtime, capability matrix, and model registry ──────────────────

export const ProviderKindSchema=z.enum(["api-key","local","oauth-disabled","mock"]);
export const ProviderCapabilitiesSchema=z.object({
  streaming:z.boolean(),
  toolCalls:z.boolean(),
  systemMessages:z.boolean(),
  vision:z.boolean(),
  customEndpoint:z.boolean(),
  local:z.boolean(),
}).strict();
export const ProviderAuthStatusSchema=z.enum(["configured","missing","not-applicable","unavailable"]);
export const ProviderAuthModeSchema=z.enum([
  "openai-api-key","codex-oauth","anthropic-api-key","anthropic-oauth","gemini-api-key",
  "openrouter-api-key","deepseek-api-key","opencode-zen","ollama","custom-compatible","mock","unknown",
]);
export const ProviderStatusSchema=z.object({
  version:SchemaVersionSchema,
  id:ProviderIdSchema,
  label:z.string(),
  kind:ProviderKindSchema,
  configured:z.boolean(),
  available:z.boolean(),
  endpointType:z.enum(["default","custom"]),
  endpointHost:z.string().nullable(),
  authStatus:ProviderAuthStatusSchema,
  authMode:ProviderAuthModeSchema.optional(),
  capabilities:ProviderCapabilitiesSchema,
  models:z.array(z.string()),
  defaultModel:z.string().nullable(),
  note:z.string().nullable(),
  setupHint:z.string().nullable(),
}).strict();

export const ModelSpeedClassSchema=z.enum(["fast","balanced","powerful","unknown"]);
export const ModelCostClassSchema=z.enum(["free","low","medium","high","unknown"]);
export const ModelPrivacyClassSchema=z.enum(["local","remote"]);
export const ModelCapabilitiesSchema=z.object({
  streaming:z.boolean(),
  toolCalls:z.boolean(),
  vision:z.boolean(),
}).strict();

// ── Reasoning / thinking control ─────────────────────────────────────────────
//
// A route's reasoning behaviour is NOT uniform across providers, so it is
// modelled explicitly rather than assumed. `ReasoningConfiguration` is the
// single normalized shape every surface uses; each provider adapter translates
// it into that provider's real request format (see the orchestrator's
// translateReasoning). `RouteReasoningCapability` describes what a specific
// route actually exposes, with explicit provenance — never a guess.
export const ReasoningEffortSchema=z.enum(["low","medium","high","xhigh","max"]);
/**
 * How a route exposes reasoning control:
 *   "none"   — the route has no reasoning controls (Not configurable);
 *   "effort" — discrete effort levels (low/medium/high);
 *   "budget" — a token budget for thinking (e.g. off/2k/8k/16k/max);
 *   "fixed"  — reasoning is on but fixed by the provider (Fixed by provider).
 */
export const ReasoningControlSchema=z.enum(["none","effort","budget","fixed"]);
/** Where a reasoning fact came from — parallels ContextLimitSource provenance. */
export const ReasoningSourceSchema=z.enum(["provider-metadata","capability-probe","registry","unknown"]);
export const RouteReasoningCapabilitySchema=z.object({
  control:ReasoningControlSchema,
  /** Supported effort levels — only meaningful when control === "effort". */
  efforts:z.array(ReasoningEffortSchema),
  /** Supported thinking-token budgets — only meaningful when control === "budget". */
  budgets:z.array(z.number().int().positive()),
  source:ReasoningSourceSchema,
}).strict();
/**
 * The normalized reasoning selection carried by a route. Every provider adapter
 * must accept this exact union; unsupported combinations are rejected before a
 * request is issued, never silently coerced.
 */
export const ReasoningConfigurationSchema=z.discriminatedUnion("mode",[
  z.object({mode:z.literal("auto")}).strict(),
  z.object({mode:z.literal("off")}).strict(),
  z.object({mode:z.literal("effort"),effort:ReasoningEffortSchema}).strict(),
  z.object({mode:z.literal("budget"),tokens:z.number().int().positive()}).strict(),
  z.object({mode:z.literal("provider-fixed")}).strict(),
]);

export const ModelPricingSchema=z.object({
  inputUsdPerMillion:z.number().nonnegative(),
  outputUsdPerMillion:z.number().nonnegative(),
  cachedInputUsdPerMillion:z.number().nonnegative().nullable().optional(),
  source:z.literal("authoritative"),
}).strict();
export const ModelInfoSchema=z.object({
  version:SchemaVersionSchema,
  id:z.string(),
  providerModelId:z.string().optional(),
  canonicalId:z.string(),
  aliases:z.array(z.string()),
  providerId:ProviderIdSchema,
  label:z.string(),
  family:z.string().nullable().optional(),
  generation:z.string().nullable().optional(),
  lifecycle:z.enum(["current","preview","legacy","deprecated","custom","unknown"]).optional(),
  contextWindow:z.number().int().positive().nullable(),
  maxOutputTokens:z.number().int().positive().nullable(),
  pricing:ModelPricingSchema.nullable(),
  tokenUsage:z.boolean(),
  streamingUsage:z.boolean(),
  capabilities:ModelCapabilitiesSchema,
  capabilitySource:z.enum(["provider-reported","remote-catalog","bundled-catalog","user-supplied","unknown"]).optional(),
  speedClass:ModelSpeedClassSchema,
  costClass:ModelCostClassSchema,
  privacy:ModelPrivacyClassSchema,
  builtIn:z.boolean(),
  metadataSource:z.enum(["provider-reported","remote-catalog","bundled-catalog","user-supplied","unknown"]).optional(),
  metadataVersion:z.string().optional(),
  fetchedAt:z.string().datetime().nullable().optional(),
  confidence:z.enum(["verified","reported","configured","unknown"]).optional(),
  /** What reasoning control this model exposes, with provenance. Optional so
   * existing construction sites and older cached rows stay valid; consumers
   * fall back to an explicit "unknown"/"none" capability when absent, never a
   * guessed one. */
  reasoning:RouteReasoningCapabilitySchema.optional(),
}).strict();
export const ModelStatusSchema=z.object({
  model:ModelInfoSchema,
  available:z.boolean(),
  availability:z.enum(["available","unavailable","unknown"]).optional(),
  availabilitySource:z.enum(["provider-reported","configured","catalog","unknown"]).optional(),
  availabilityReason:z.string().nullable().optional(),
  authMode:ProviderAuthModeSchema.optional(),
  fetchedAt:z.string().datetime().nullable().optional(),
}).strict();

/**
 * Confidence in an asserted context-window/budget number:
 * "verified" — genuinely provider- or built-in-registry-reported;
 * "configured" — a user- or endpoint-supplied override Morrow cannot
 * independently verify against the real provider; "unverified" — no
 * authoritative value at all (an internal safe fallback was used).
 * Mirrors services/orchestrator's ModelBudget.contextWindowConfidence —
 * this is a read-only view of that single canonical computation, never a
 * second, independently-derived source of truth.
 */
export const ModelBudgetConfidenceSchema=z.enum(["verified","configured","unverified"]);
export const ModelBudgetViewSchema=z.object({
  providerId:ProviderIdSchema,
  selectedModelId:z.string(),
  canonicalModelId:z.string(),
  displayName:z.string(),
  configured:z.boolean(),
  protocol:z.string(),
  endpointKind:z.enum(["default","custom","injected"]),
  endpointHost:z.string().nullable(),
  contextWindowTokens:z.number().int().nonnegative(),
  contextWindowConfidence:ModelBudgetConfidenceSchema,
  usableInputTokens:z.number().int().nonnegative(),
  outputReserveTokens:z.number().int().nonnegative(),
  totalReserveTokens:z.number().int().nonnegative(),
  capabilities:ModelCapabilitiesSchema,
  pricing:ModelPricingSchema.nullable(),
  /** Reasoning capability of this resolved route, with provenance. Optional so
   * older cached budget rows remain valid; the picker falls back to an explicit
   * "unknown" capability when absent. */
  reasoning:RouteReasoningCapabilitySchema.optional(),
}).strict();

// ── Presets and provider routing ─────────────────────────────────────────────

export const PresetIdSchema=z.enum(["best-quality","balanced","fast","cheap","coding","research","private-local"]);
export const ToolProfileSchema=z.enum(["read-only","none","agent"]);
export const AgentModeSchema=z.enum(["read-only","plan-only","agent"]);
export const PresetPrivacySchema=z.enum(["local-only","prefers-local","cloud"]);
// ReasoningEffortSchema is defined in the model section above (reasoning control).
export const PresetSchema=z.object({
  version:SchemaVersionSchema,
  id:PresetIdSchema,
  label:z.string(),
  description:z.string(),
  providerOrder:z.array(ProviderIdSchema).min(1),
  modelPreferences:z.record(z.string(),z.array(z.string())),
  temperature:z.number().min(0).max(2).nullable(),
  reasoningEffort:ReasoningEffortSchema.nullable(),
  toolProfile:ToolProfileSchema,
  contextBudgetBytes:z.number().int().positive(),
  outputBudgetTokens:z.number().int().positive().nullable(),
  timeoutMs:z.number().int().positive(),
  maxAttempts:z.number().int().positive(),
  maxToolIterations:z.number().int().positive(),
  privacy:PresetPrivacySchema,
  privacyDescription:z.string(),
  costDescription:z.string(),
  requiresLocal:z.boolean(),
}).strict();
export const PresetResolutionSchema=z.object({providerId:ProviderIdSchema,model:z.string()}).strict();
export const PresetStatusSchema=z.object({
  preset:PresetSchema,
  available:z.boolean(),
  unavailableReason:z.string().nullable(),
  resolved:PresetResolutionSchema.nullable(),
}).strict();

export const RoutingCandidateSchema=z.object({providerId:ProviderIdSchema,configured:z.boolean(),reason:z.string()}).strict();
export const RoutingDecisionSchema=z.object({
  version:SchemaVersionSchema,
  presetId:PresetIdSchema,
  providerId:ProviderIdSchema,
  model:z.string(),
  reason:z.string(),
  fallbackUsed:z.boolean(),
  overridden:z.boolean(),
  privacy:PresetPrivacySchema,
  candidates:z.array(RoutingCandidateSchema),
  mode:AgentModeSchema.optional(),
  toolProfile:ToolProfileSchema.optional(),
  autoApprove:z.boolean().optional(),
  // The reasoning selection attached to this route at send time. Frozen into
  // the durable decision record so retry/resume reuse exactly what was
  // requested, never re-reading "current session settings" (routing/model
  // overrides already behave this way — see execution/agent.ts).
  reasoning:ReasoningConfigurationSchema.optional(),
}).strict();

export const SendMessageSchema=z.object({
  content:z.string().trim().min(1).max(32000),
  preset:PresetIdSchema.optional(),
  providerId:ProviderIdSchema.optional(),
  model:z.string().min(1).max(200).optional(),
  // Normalized per-request reasoning override for the resolved route. Absent
  // means "use the preset/route default". The orchestrator validates this
  // against the route's real capability and rejects unsupported combinations.
  reasoning:ReasoningConfigurationSchema.optional(),
  mode:AgentModeSchema.optional(),
  useMemory:z.boolean().optional(),
  autoApprove:z.boolean().optional(),
  agentId:z.string().optional(),
  idempotencyKey:z.string().trim().min(1).max(200).optional(),
  worktreeId:z.string().optional(),
  // Links the resulting agent task to a mission so tool failures during
  // execution land in that mission's failure ledger.
  missionId:z.string().optional(),
}).strict();

// ── Memory foundation ────────────────────────────────────────────────────────

// Scopes are tiers of recall. project/user/conversation are the original
// working tiers; episodic (time-stamped events), procedural (how-to/workflow),
// and knowledge (durable facts) are project-wide recall tiers. Every tier except
// conversation applies to all conversations in the project.
export const MemoryScopeSchema=z.enum(["project","conversation","user","episodic","procedural","knowledge"]);
export const MemorySourceSchema=z.enum(["user","summary"]);
export const MemoryEntrySchema=z.object({
  version:SchemaVersionSchema,
  id:z.string(),
  projectId:z.string(),
  conversationId:z.string().nullable(),
  scope:MemoryScopeSchema,
  content:z.string().min(1),
  source:MemorySourceSchema,
  // Provenance: the task that produced this entry, when known. user-authored
  // entries have a null origin. Lets the user trace why a memory exists.
  originTaskId:z.string().nullable(),
  pinned:z.boolean(),
  enabled:z.boolean(),
  createdAt:z.string().datetime(),
  updatedAt:z.string().datetime(),
}).strict();
export const CreateMemoryEntrySchema=z.object({
  scope:MemoryScopeSchema,
  content:z.string().trim().min(1).max(4000),
  conversationId:z.string().optional(),
  pinned:z.boolean().optional(),
}).strict();
export const UpdateMemoryEntrySchema=z.object({
  projectId:z.string().min(1),
  enabled:z.boolean().optional(),
  pinned:z.boolean().optional(),
}).strict().refine((v)=>v.enabled!==undefined||v.pinned!==undefined,{message:"Provide enabled or pinned"});
export type UpdateMemoryEntryInput=z.infer<typeof UpdateMemoryEntrySchema>;

// ── Persistent Named Agents + Granular Permissions ─────────────────────────
// Each agent is a named entity with a role, optional instructions, optional
// provider/model override, tool allow/deny lists, and skill access controls.
// Agents are project-scoped so teams of agents can collaborate on one project.
export const AgentRoleSchema=z.enum(["assistant","code-reviewer","researcher","writer","architect","tester","devops","security","custom"]);
export const AgentSchema=z.object({
  version:SchemaVersionSchema,
  id:z.string(),
  projectId:z.string(),
  name:z.string().min(1).max(100),
  role:AgentRoleSchema,
  instructions:z.string().max(8000).nullable(),
  providerOverride:z.string().nullable(),
  modelOverride:z.string().nullable(),
  enabled:z.boolean(),
  createdAt:z.string().datetime(),
  updatedAt:z.string().datetime(),
}).strict();
export const CreateAgentSchema=z.object({
  name:z.string().trim().min(1).max(100),
  role:AgentRoleSchema.default("assistant"),
  instructions:z.string().max(8000).nullable().optional(),
  providerOverride:z.string().nullable().optional(),
  modelOverride:z.string().nullable().optional(),
}).strict();
export const UpdateAgentSchema=z.object({
  name:z.string().trim().min(1).max(100).optional(),
  role:AgentRoleSchema.optional(),
  instructions:z.string().max(8000).nullable().optional(),
  providerOverride:z.string().nullable().optional(),
  modelOverride:z.string().nullable().optional(),
  enabled:z.boolean().optional(),
}).strict();

// Per-agent tool permission: each entry allows or denies a specific tool.
export const ToolPermissionEffectSchema=z.enum(["allow","deny"]);
export const AgentToolPermissionSchema=z.object({
  version:SchemaVersionSchema,
  id:z.string(),
  agentId:z.string(),
  toolName:z.string().min(1).max(120),
  effect:ToolPermissionEffectSchema,
  priority:z.number().int().default(0),
  createdAt:z.string().datetime(),
}).strict();
export const UpsertToolPermissionSchema=z.object({
  toolName:z.string().trim().min(1).max(120),
  effect:ToolPermissionEffectSchema,
  priority:z.number().int().optional(),
}).strict();

// Per-agent skill access: which skills this agent is allowed to use.
export const AgentSkillAccessSchema=z.object({
  version:SchemaVersionSchema,
  id:z.string(),
  agentId:z.string(),
  skillId:z.string().min(1).max(120),
  allowed:z.boolean(),
  createdAt:z.string().datetime(),
}).strict();
export const UpsertSkillAccessSchema=z.object({
  skillId:z.string().trim().min(1).max(120),
  allowed:z.boolean(),
}).strict();

export type AgentRole=z.infer<typeof AgentRoleSchema>;
export type Agent=z.infer<typeof AgentSchema>;
export type CreateAgentInput=z.infer<typeof CreateAgentSchema>;
export type UpdateAgentInput=z.infer<typeof UpdateAgentSchema>;
export type ToolPermissionEffect=z.infer<typeof ToolPermissionEffectSchema>;
export type AgentToolPermission=z.infer<typeof AgentToolPermissionSchema>;
export type UpsertToolPermissionInput=z.infer<typeof UpsertToolPermissionSchema>;
export type AgentSkillAccess=z.infer<typeof AgentSkillAccessSchema>;
export type UpsertSkillAccessInput=z.infer<typeof UpsertSkillAccessSchema>;

// ── Full-text session & memory search ────────────────────────────────────────
// Project-scoped FTS over conversations, messages, tasks, and memory. Search is
// never cross-project; results carry a provenance kind and a highlighted snippet
// so the user can see why a hit matched.
export const SearchKindSchema=z.enum(["conversation","message","task","memory"]);
export const SearchHitSchema=z.object({
  kind:SearchKindSchema,
  refId:z.string(),
  projectId:z.string(),
  conversationId:z.string().nullable(),
  title:z.string(),
  snippet:z.string(),
  createdAt:z.string(),
  score:z.number(),
}).strict();
export const SearchResponseSchema=z.object({
  version:SchemaVersionSchema,
  query:z.string(),
  projectId:z.string(),
  total:z.number().int().nonnegative(),
  hits:z.array(SearchHitSchema),
}).strict();
export type SearchKind=z.infer<typeof SearchKindSchema>;
export type SearchHit=z.infer<typeof SearchHitSchema>;
export type SearchResponse=z.infer<typeof SearchResponseSchema>;

// ── Skill usage tracking ─────────────────────────────────────────────────────
// Per-project counters of how often each skill has been invoked, so the agent
// can prefer proven skills and the user can see what is actually used.
export const SkillUsageSchema=z.object({
  skillId:z.string(),
  projectId:z.string(),
  count:z.number().int().nonnegative(),
  lastUsedAt:z.string().nullable(),
}).strict();
export type SkillUsage=z.infer<typeof SkillUsageSchema>;

// ── Outbound messaging / notifications ───────────────────────────────────────
export const NotificationChannelSchema=z.enum(["webhook","telegram"]);
export const NotifyRequestSchema=z.object({
  text:z.string().trim().min(1).max(4000),
  subject:z.string().trim().max(200).optional(),
}).strict();
export const NotifyOutcomeSchema=z.object({
  channel:z.string(),
  ok:z.boolean(),
  detail:z.string(),
}).strict();
export const NotifyResultSchema=z.object({
  sent:z.number().int().nonnegative(),
  results:z.array(NotifyOutcomeSchema),
}).strict();
export type NotificationChannel=z.infer<typeof NotificationChannelSchema>;
export type NotifyRequest=z.infer<typeof NotifyRequestSchema>;
export type NotifyResult=z.infer<typeof NotifyResultSchema>;

// ── Scheduled jobs (cron) ────────────────────────────────────────────────────
// A schedule fires isolated task runs on a UTC cron expression. Scheduled work
// is project-scoped and uses the same task runner + containment as interactive
// work — nothing runs with elevated privileges because it is unattended.
export const ScheduleTaskKindSchema=z.enum(["inspect_workspace"]);
export const ScheduleSchema=z.object({
  version:SchemaVersionSchema,
  id:z.string(),
  projectId:z.string(),
  cron:z.string(),
  taskKind:ScheduleTaskKindSchema,
  enabled:z.boolean(),
  lastRunAt:z.string().nullable(),
  nextRunAt:z.string(),
  createdAt:z.string().datetime(),
}).strict();
export const CreateScheduleSchema=z.object({
  cron:z.string().trim().min(1).max(120),
  taskKind:ScheduleTaskKindSchema.default("inspect_workspace"),
}).strict();
export type Schedule=z.infer<typeof ScheduleSchema>;
export type ScheduleTaskKind=z.infer<typeof ScheduleTaskKindSchema>;

// ── Code diagnostics (LSP-style) ─────────────────────────────────────────────
// Normalized diagnostics from the project's own tools (tsc, eslint), plus a
// baseline comparison so a change can be proven not to regress error counts.
export const DiagnosticToolSchema=z.enum(["tsc","eslint"]);
export const DiagnosticSchema=z.object({
  file:z.string(),
  line:z.number().int().nonnegative(),
  column:z.number().int().nonnegative(),
  severity:z.enum(["error","warning"]),
  code:z.string(),
  message:z.string(),
}).strict();
export const DiagnosticsReportSchema=z.object({
  tool:DiagnosticToolSchema,
  count:z.number().int().nonnegative(),
  errorCount:z.number().int().nonnegative(),
  warningCount:z.number().int().nonnegative(),
  diagnostics:z.array(DiagnosticSchema),
}).strict();
export type DiagnosticTool=z.infer<typeof DiagnosticToolSchema>;
export type Diagnostic=z.infer<typeof DiagnosticSchema>;
export type DiagnosticsReport=z.infer<typeof DiagnosticsReportSchema>;

export type ProviderId=z.infer<typeof ProviderIdSchema>;
export type ProviderKind=z.infer<typeof ProviderKindSchema>;
export type ProviderAuthMode=z.infer<typeof ProviderAuthModeSchema>;
export type ProviderCapabilities=z.infer<typeof ProviderCapabilitiesSchema>;
export type ProviderStatus=z.infer<typeof ProviderStatusSchema>;
export type ModelInfo=z.infer<typeof ModelInfoSchema>;
export type ModelStatus=z.infer<typeof ModelStatusSchema>;
export type ModelBudgetConfidence=z.infer<typeof ModelBudgetConfidenceSchema>;
export type ModelBudgetView=z.infer<typeof ModelBudgetViewSchema>;
export type ModelCapabilities=z.infer<typeof ModelCapabilitiesSchema>;
export type ReasoningEffort=z.infer<typeof ReasoningEffortSchema>;
export type ReasoningControl=z.infer<typeof ReasoningControlSchema>;
export type ReasoningSource=z.infer<typeof ReasoningSourceSchema>;
export type RouteReasoningCapability=z.infer<typeof RouteReasoningCapabilitySchema>;
export type ReasoningConfiguration=z.infer<typeof ReasoningConfigurationSchema>;
export type PresetId=z.infer<typeof PresetIdSchema>;
export type Preset=z.infer<typeof PresetSchema>;
export type PresetStatus=z.infer<typeof PresetStatusSchema>;
export type ToolProfile=z.infer<typeof ToolProfileSchema>;
export type AgentMode=z.infer<typeof AgentModeSchema>;
export type RoutingDecision=z.infer<typeof RoutingDecisionSchema>;
export type RoutingCandidate=z.infer<typeof RoutingCandidateSchema>;
export type SendMessageInput=z.infer<typeof SendMessageSchema>;
export type MemoryEntry=z.infer<typeof MemoryEntrySchema>;
export type MemoryScope=z.infer<typeof MemoryScopeSchema>;

// ── Honest OAuth integration findings ────────────────────────────────────────
// Morrow only labels a flow "OAuth" when it is an officially supported, documented
// third-party integration. Where no such flow exists for this class of application,
// the entry is reported as unavailable with an honest explanation. No private
// authentication is reverse-engineered, and no session tokens are reused.
export const OAuthFindingSchema=z.object({
  id:z.string(),
  label:z.string(),
  status:z.enum(["available","unavailable"]),
  reason:z.string(),
  recommendation:z.string(),
  documentationUrl:z.string().nullable(),
}).strict();
export type OAuthFinding=z.infer<typeof OAuthFindingSchema>;
export type UpdateConversationInput=z.infer<typeof UpdateConversationSchema>;

// ── Tool catalog, permissions, audit, provider connectivity ──────────────────
// These describe the real, safe read-only capability surface exposed by the
// orchestrator. They are descriptive contracts the CLI and web render; the tool
// execution itself lives in the agent runtime behind the same containment layer.
export const ToolSideEffectSchema=z.enum(["read-only","write","execute","network"]);
export const ToolSpecSchema=z.object({
  name:z.string(),
  title:z.string(),
  description:z.string(),
  sideEffect:ToolSideEffectSchema,
  enabled:z.boolean(),
  parameters:z.record(z.string(),z.unknown()),
  constraints:z.array(z.string()),
}).strict();
export type ToolSpec=z.infer<typeof ToolSpecSchema>;

export const PermissionProfileSchema=z.object({
  version:SchemaVersionSchema,
  toolProfileOptions:z.array(ToolProfileSchema),
  defaultToolProfile:ToolProfileSchema,
  filesystemAccess:z.enum(["workspace-write","read-only","none"]),
  shellExecution:z.boolean(),
  networkAccess:z.enum(["provider-only","disabled","enabled"]),
  writeAccess:z.boolean(),
  deniedNamePatterns:z.array(z.string()),
  deniedPathRules:z.array(z.string()),
  limits:z.object({
    maxFileBytes:z.number().int().positive(),
    maxInspectResults:z.number().int().positive(),
    maxInspectDepth:z.number().int().positive(),
  }).strict(),
}).strict();
export type PermissionProfile=z.infer<typeof PermissionProfileSchema>;

export const AuditEntrySchema=z.object({
  taskId:z.string(),
  projectId:z.string(),
  kind:z.string(),
  status:TaskStatusSchema,
  provider:z.string().nullable(),
  model:z.string().nullable(),
  networkAccess:z.string().nullable(),
  toolCalls:z.number().int().nonnegative(),
  evidence:z.number().int().nonnegative(),
  createdAt:z.string(),
}).strict();
export type AuditEntry=z.infer<typeof AuditEntrySchema>;

export const DiscoveredModelSchema=z.object({
  providerModelId:z.string().min(1).max(300),
  displayName:z.string().min(1).max(500),
  contextWindow:z.number().int().positive().nullable(),
  maxOutputTokens:z.number().int().positive().nullable(),
  capabilities:z.object({
    streaming:z.boolean().nullable(),
    toolCalls:z.boolean().nullable(),
    vision:z.boolean().nullable(),
  }).strict(),
  metadataSource:z.literal("provider-reported"),
}).strict();
export type DiscoveredModel=z.infer<typeof DiscoveredModelSchema>;
export const ProviderTestResultSchema=z.object({
  id:ProviderIdSchema,
  ok:z.boolean(),
  configured:z.boolean(),
  status:z.number().int().nullable(),
  latencyMs:z.number().int().nonnegative().nullable(),
  checkedEndpoint:z.string().nullable(),
  detail:z.string(),
  errorKind:z.string().nullable(),
  modelsSample:z.array(z.string()),
  models:z.array(DiscoveredModelSchema),
}).strict();
export type ProviderTestResult=z.infer<typeof ProviderTestResultSchema>;

export const HealthSchema=z.object({
  ok:z.boolean(),
  service:z.literal("morrow-orchestrator"),
  apiVersion:z.number().int(),
  mockProvider:z.boolean(),
  // The CLI uses this only for a local service to recover an interrupted or
  // deleted pid file. It is intentionally not a credential or user identifier.
  ownerPid:z.number().int().positive().optional(),
  migrations:z.object({applied:z.number().int(),latest:z.number().int().nullable()}).strict(),
  time:z.string(),
}).strict();
export type Health=z.infer<typeof HealthSchema>;

// ── Verified Missions (Morrow Advantage, beta.20) ──────────────────────────
// A Mission is a first-class, durable, resumable unit of accountable work. It
// converts a free-text objective into measurable success criteria, executes
// under supervision, records every meaningful failure and recovery, verifies
// each criterion with concrete evidence, obtains an independent review, and
// grades itself honestly. All of it survives service restarts.

export const MissionStatusSchema=z.enum([
  "draft","awaiting_criteria_approval","running","reviewing",
  "completed","completed_with_reservations","partially_completed","blocked","failed","cancelled",
]);
export type MissionStatus=z.infer<typeof MissionStatusSchema>;

// Terminal states never transition further; used by the state machine + grading.
export const MISSION_TERMINAL_STATUSES:readonly MissionStatus[]=[
  "completed","completed_with_reservations","partially_completed","blocked","failed","cancelled",
];

export const MissionCriterionStateSchema=z.enum([
  "proposed","approved","in_progress","verified","failed","waived","unverified",
]);
export type MissionCriterionState=z.infer<typeof MissionCriterionStateSchema>;

// How a criterion is proven. `manual` requires a structured human/agent
// observation; every other kind produces evidence from a concrete action.
export const MissionVerificationKindSchema=z.enum([
  "command","test","build","typecheck","lint","runtime","http","browser","diff","review","manual","artifact",
]);
export type MissionVerificationKind=z.infer<typeof MissionVerificationKindSchema>;

export const MissionVerificationStrategySchema=z.object({
  kind:MissionVerificationKindSchema,
  // A shell command to run (command/test/build/typecheck/lint/runtime).
  command:z.string().max(2000).optional(),
  // Expected exit code for command-style strategies (default 0).
  expectExitCode:z.number().int().optional(),
  // For http: a URL to probe and the expected status.
  url:z.string().max(2000).optional(),
  expectStatus:z.number().int().optional(),
  // For diff: a path glob that changes are expected to stay within.
  pathScope:z.string().max(500).optional(),
  // Human-readable description of what evidence proves this criterion.
  describe:z.string().max(500).optional(),
}).strict();
export type MissionVerificationStrategy=z.infer<typeof MissionVerificationStrategySchema>;

export const MissionCriterionSchema=z.object({
  id:z.string(),
  missionId:z.string(),
  order:z.number().int().nonnegative(),
  description:z.string().min(1).max(1000),
  state:MissionCriterionStateSchema,
  verification:MissionVerificationStrategySchema,
  evidenceIds:z.array(z.string()).default([]),
  failureReason:z.string().max(2000).nullable().default(null),
  waiverReason:z.string().max(2000).nullable().default(null),
  createdAt:z.string().datetime(),
  updatedAt:z.string().datetime(),
}).strict();
export type MissionCriterion=z.infer<typeof MissionCriterionSchema>;

export const MissionEvidenceTypeSchema=z.enum([
  "command","test","build","typecheck","lint","runtime","http","browser","diff","review","manual","artifact",
]);
export type MissionEvidenceType=z.infer<typeof MissionEvidenceTypeSchema>;
export const MissionEvidenceStatusSchema=z.enum(["passed","failed","inconclusive"]);
export type MissionEvidenceStatus=z.infer<typeof MissionEvidenceStatusSchema>;
export const MissionEvidenceSchema=z.object({
  id:z.string(),
  missionId:z.string(),
  criterionIds:z.array(z.string()).default([]),
  type:MissionEvidenceTypeSchema,
  summary:z.string().min(1).max(1000),
  command:z.string().max(2000).nullable().default(null),
  exitCode:z.number().int().nullable().default(null),
  // Reference into the existing output store (never the full body inline).
  outputRef:z.string().max(500).nullable().default(null),
  artifactPath:z.string().max(1024).nullable().default(null),
  status:MissionEvidenceStatusSchema,
  recordedAt:z.string().datetime(),
}).strict();
export type MissionEvidence=z.infer<typeof MissionEvidenceSchema>;

export const MissionFailureCategorySchema=z.enum([
  "tool_error","patch_context_mismatch","test_failure","build_failure","provider_failure",
  "model_unavailable","rate_limit","network_failure","context_exhaustion",
  "invalid_tool_arguments","verification_failure","approval_required","repeated_strategy",
  "unknown_effect","process_interruption","permission_denied","timeout","invalid_output",
  "loop_detected","unknown",
]);
export type MissionFailureCategory=z.infer<typeof MissionFailureCategorySchema>;
export const MissionFailureSchema=z.object({
  id:z.string(),
  missionId:z.string(),
  taskId:z.string().nullable().default(null),
  agentId:z.string().nullable().default(null),
  operation:z.string().min(1).max(500),
  // A stable signature (category + normalized operation) used for loop detection.
  normalizedSignature:z.string().min(1).max(500),
  category:MissionFailureCategorySchema,
  message:z.string().max(2000),
  attempt:z.number().int().positive(),
  recoveryStrategy:z.string().max(500).nullable().default(null),
  recovered:z.boolean().default(false),
  createdAt:z.string().datetime(),
}).strict();
export type MissionFailure=z.infer<typeof MissionFailureSchema>;

export const MissionCheckpointSchema=z.object({
  id:z.string(),
  missionId:z.string(),
  label:z.string().min(1).max(200),
  reason:z.string().max(500),
  // Git commit sha when the workspace is a git repo; otherwise null (a
  // content-snapshot checkpoint is used and referenced by checkpointName).
  gitRef:z.string().max(200).nullable().default(null),
  checkpointName:z.string().max(200).nullable().default(null),
  affectedFiles:z.array(z.string()).default([]),
  rollbackAvailable:z.boolean().default(false),
  createdAt:z.string().datetime(),
}).strict();
export type MissionCheckpoint=z.infer<typeof MissionCheckpointSchema>;

export const MissionReviewVerdictSchema=z.enum([
  "approved","approved_with_risks","revisions_required","insufficient_evidence",
]);
export type MissionReviewVerdict=z.infer<typeof MissionReviewVerdictSchema>;
export const MissionReviewCriterionJudgmentSchema=z.object({
  criterionId:z.string(),
  judgment:z.enum(["satisfied","not_satisfied","unclear"]),
  note:z.string().max(1000).default(""),
}).strict();
export const MissionReviewSchema=z.object({
  id:z.string(),
  missionId:z.string(),
  verdict:MissionReviewVerdictSchema,
  // The reviewer is a SEPARATE execution; this records which provider/model ran it.
  reviewerProvider:z.string().max(100).nullable().default(null),
  reviewerModel:z.string().max(200).nullable().default(null),
  criterionJudgments:z.array(MissionReviewCriterionJudgmentSchema).default([]),
  regressionRisks:z.array(z.string().max(500)).default([]),
  suspiciousChanges:z.array(z.string().max(500)).default([]),
  missingVerification:z.array(z.string().max(500)).default([]),
  concerns:z.array(z.string().max(500)).default([]),
  recommendedStatus:MissionStatusSchema,
  summary:z.string().max(4000).default(""),
  createdAt:z.string().datetime(),
}).strict();
export type MissionReview=z.infer<typeof MissionReviewSchema>;

export const MissionBudgetSchema=z.object({
  maxUsd:z.number().nonnegative().nullable().default(null),
  maxAttempts:z.number().int().positive().nullable().default(null),
  maxReviewCycles:z.number().int().positive().default(2),
  spentUsd:z.number().nonnegative().default(0),
  attemptsUsed:z.number().int().nonnegative().default(0),
  reviewCyclesUsed:z.number().int().nonnegative().default(0),
}).strict();
export type MissionBudget=z.infer<typeof MissionBudgetSchema>;

export const MissionResultSchema=z.object({
  status:MissionStatusSchema,
  objective:z.string(),
  criteriaVerified:z.number().int().nonnegative(),
  criteriaFailed:z.number().int().nonnegative(),
  criteriaUnverified:z.number().int().nonnegative(),
  criteriaWaived:z.number().int().nonnegative(),
  criteriaTotal:z.number().int().nonnegative(),
  reviewVerdict:MissionReviewVerdictSchema.nullable().default(null),
  failuresTotal:z.number().int().nonnegative().default(0),
  failuresRecovered:z.number().int().nonnegative().default(0),
  humanInterventions:z.number().int().nonnegative().default(0),
  tasksCompleted:z.number().int().nonnegative().default(0),
  changedFiles:z.array(z.string()).default([]),
  unresolvedRisks:z.array(z.string().max(1000)).default([]),
  artifacts:z.array(z.string().max(500)).default([]),
  checkpointRefs:z.array(z.string()).default([]),
  spentUsd:z.number().nonnegative().nullable().default(null),
  elapsedMs:z.number().int().nonnegative().nullable().default(null),
  summary:z.string().max(8000).default(""),
}).strict();
export type MissionResult=z.infer<typeof MissionResultSchema>;

export const MissionSchema=z.object({
  version:SchemaVersionSchema,
  id:z.string(),
  projectId:z.string(),
  conversationId:z.string().nullable().default(null),
  objective:z.string().min(1).max(8000),
  status:MissionStatusSchema,
  autoApprove:z.boolean().default(false),
  criteria:z.array(MissionCriterionSchema).default([]),
  taskTreeRootId:z.string().nullable().default(null),
  budget:MissionBudgetSchema,
  checkpoints:z.array(MissionCheckpointSchema).default([]),
  evidence:z.array(MissionEvidenceSchema).default([]),
  failures:z.array(MissionFailureSchema).default([]),
  finalReview:MissionReviewSchema.nullable().default(null),
  result:MissionResultSchema.nullable().default(null),
  createdAt:z.string().datetime(),
  updatedAt:z.string().datetime(),
  startedAt:z.string().datetime().nullable().default(null),
  completedAt:z.string().datetime().nullable().default(null),
}).strict();
export type Mission=z.infer<typeof MissionSchema>;

// Append-only mission timeline; a durable, auditable record distinct from raw
// model reasoning (which is never stored).
export const MissionEventTypeSchema=z.enum([
  "mission.created","mission.criteria_generated","mission.criteria_approved","mission.started",
  "mission.checkpoint_created","mission.evidence_recorded","mission.criterion_verified","mission.criterion_failed",
  "mission.failure_recorded","mission.loop_detected","mission.recovery_applied","mission.rolled_back",
  "mission.review_started",  "mission.review_completed","mission.status_changed","mission.completed","mission.cancelled",
  "mission.plan_revised","mission.learnings_extracted","mission.impact_analyzed","mission.specialists_planned",
  "mission.contract_built","mission.requirement_reopened","mission.requirement_status_changed",
]);
export type MissionEventType=z.infer<typeof MissionEventTypeSchema>;
export const MissionEventSchema=z.object({
  id:z.string(),
  missionId:z.string(),
  sequence:z.number().int().positive(),
  type:MissionEventTypeSchema,
  summary:z.string().max(1000),
  data:z.record(z.string(),z.unknown()).default({}),
  createdAt:z.string().datetime(),
}).strict();
export type MissionEvent=z.infer<typeof MissionEventSchema>;

export const MissionSpecialistRoleSchema=z.object({
  id:z.enum(["repository-mapper","planner","implementer","test-engineer","security-regression-reviewer","final-reviewer"]),
  name:z.string().min(1).max(120),
  objective:z.string().min(1).max(1000),
  allowedTools:z.array(z.string().min(1).max(120)).min(1),
  requiredInputs:z.array(z.string().min(1).max(240)).min(1),
  structuredOutput:z.string().min(1).max(1000),
  budget:z.object({
    maxToolCalls:z.number().int().positive(),
    maxContextBytes:z.number().int().positive(),
    maxUsd:z.number().nonnegative().nullable().default(null),
  }).strict(),
  timeoutMs:z.number().int().positive(),
  missionId:z.string(),
  taskId:z.string().nullable().default(null),
  agentId:z.string().nullable().default(null),
  status:z.enum(["pending","running","completed","failed","skipped"]).default("pending"),
  completionCriteria:z.array(z.string().min(1).max(240)).min(1),
  storesChainOfThought:z.literal(false),
}).strict();
export type MissionSpecialistRole=z.infer<typeof MissionSpecialistRoleSchema>;

// ── Advanced Execution Kernel: Contract, Requirement Ledger, Cursor ──────────
// Slice 1 of the Advanced Execution Kernel adds durable, provenance-preserving
// structures that sit beside the existing mission state machine:
//   • MissionContract        — verbatim source prompt + unresolved ambiguities
//   • MissionRequirementNode — one structured, provenance-tagged requirement
//   • MissionCursor          — exactly one active requirement node per mission
//   • ProjectActiveMission   — the per-project active mission pointer
// These are strictly additive; the existing Mission schema is untouched.

// Where a requirement originated. User-stated requirements are authoritative;
// model/derived ones are NOT authoritative until the user approves them.
export const RequirementSourceSchema=z.enum(["user","model","derived"]);
export type RequirementSource=z.infer<typeof RequirementSourceSchema>;

// The kind of requirement a node represents. Drives how the cursor and the
// active-node invariant treat the node.
export const RequirementCategorySchema=z.enum([
  "objective","hard_requirement","prohibited_action","expected_artifact","acceptance_criterion",
]);
export type RequirementCategory=z.infer<typeof RequirementCategorySchema>;

// Lifecycle of a single requirement node. There is exactly one "active" node at
// a time during executable work; zero when blocked, complete, or awaiting input.
export const RequirementNodeStatusSchema=z.enum([
  "pending","active","blocked","failed","verified","waived","invalidated",
]);
export type RequirementNodeStatus=z.infer<typeof RequirementNodeStatusSchema>;

// The five explicit, persisted conditions under which a verified (frozen) node
// may reopen. Caller-supplied booleans are never sufficient proof — the reason
// and condition must be recorded durably on the node.
export const ReopenConditionSchema=z.enum([
  "dependency_changed","file_hash_changed","later_verification_failed","contract_changed","explicit_invalidation",
]);
export type ReopenCondition=z.infer<typeof ReopenConditionSchema>;

/** A single, auditable entry in the invalidation history of a requirement node.
 *  Each reopen of a verified (frozen) node appends one entry; history is never
 *  replaced or truncated. */
export const InvalidationEntrySchema=z.object({
  condition:ReopenConditionSchema,
  reason:z.string().min(1).max(2000),
  invalidatedAt:z.string().datetime(),
  evidenceRef:z.string().max(200).nullable().default(null),
}).strict();
export type InvalidationEntry=z.infer<typeof InvalidationEntrySchema>;

export const MissionRequirementNodeSchema=z.object({
  version:SchemaVersionSchema,
  id:z.string(),
  missionId:z.string(),
  order:z.number().int().nonnegative(),
  // Verbatim statement of this requirement as captured (never paraphrased away).
  statement:z.string().min(1).max(2000),
  // What kind of requirement this node is.
  category:RequirementCategorySchema,
  // Snippet of the source prompt that gave rise to this requirement, for audit.
  // MUST be a verbatim substring of the contract's sourcePrompt, or empty when
  // the requirement came from a structured input that never appeared in the raw
  // prompt. It never fabricates an "excerpt" that did not occur in sourcePrompt.
  sourcePromptExcerpt:z.string().max(2000).default(""),
  // Explicit structured-input locator/path when a requirement was derived from a
  // structured contract field rather than the raw prompt (e.g.
  // "contract.acceptanceCriteria[0]"). Preserves exactly which structured input
  // produced this node so provenance is auditable even when the value is not a
  // substring of the prompt. null when the node came straight from the prompt.
  sourceLocator:z.string().max(500).nullable().default(null),
  // Provenance: who asserted this requirement.
  source:RequirementSourceSchema,
  // Confidence the kernel has in this requirement (1 = stated by the user).
  confidence:z.number().min(0).max(1),
  // Authoritative only once the user approves (or it is user-stated).
  approved:z.boolean().default(false),
  // True when the user stated it directly OR approved it. model/derived start
  // false and stay false until an explicit approval.
  authoritative:z.boolean().default(false),
  status:RequirementNodeStatusSchema.default("pending"),
  // Node ids this requirement depends on; it cannot become active until they
  // are satisfied.
  dependencies:z.array(z.string()).default([]),
  // Evidence record ids that back this requirement (recorded at verification).
  evidenceRefs:z.array(z.string()).default([]),
  // Files touched while working this requirement.
  affectedFiles:z.array(z.string()).default([]),
  // Content hashes captured at verification time. Used to detect whether a
  // reopen of a verified (frozen) node is actually warranted.
  verifiedFileHashes:z.array(z.string().max(200)).default([]),
  // How many times execution was attempted against this requirement.
  attempts:z.number().int().nonnegative().default(0),
  // Last failure reason, if any.
  lastFailure:z.string().max(2000).nullable().default(null),
  // When the requirement reached a terminal (verified/waived) state.
  completedAt:z.string().datetime().nullable().default(null),
  // Durable, append-only audit trail of every verified-node reopen. Each entry
  // records the condition, a non-blank reason, a timestamp, and an optional
  // evidence reference. History is never replaced or truncated.
  invalidationHistory:z.array(InvalidationEntrySchema).default([]),
  createdAt:z.string().datetime(),
  updatedAt:z.string().datetime(),
}).strict();
export type MissionRequirementNode=z.infer<typeof MissionRequirementNodeSchema>;

export const MissionContractSchema=z.object({
  version:SchemaVersionSchema,
  missionId:z.string(),
  // Verbatim source prompt — never summarized away, never guessed.
  sourcePrompt:z.string().min(1).max(8000),
  // The explicit, authoritative objective captured verbatim from the user.
  objective:z.string().min(1).max(8000),
  // Concrete artifacts the mission is expected to produce.
  expectedArtifacts:z.array(z.string().max(1000)).default([]),
  // Measurable acceptance criteria the mission must satisfy.
  acceptanceCriteria:z.array(z.string().max(1000)).default([]),
  // Commands that establish whether the work holds (kept at contract level).
  verificationCommands:z.array(z.string().max(2000)).default([]),
  // Required resulting git state (e.g. "clean-working-tree", "at-least-one-commit").
  requiredGitResult:z.string().max(500).nullable().default(null),
  // Requirements extracted from the prompt (assembled from requirement nodes).
  requirements:z.array(MissionRequirementNodeSchema).default([]),
  // Ambiguities the kernel could not resolve from the prompt alone. Surfaced,
  // never silently resolved.
  unresolvedAmbiguities:z.array(z.string().max(1000)).default([]),
  // Contract-level freeze flag, recomputed from node states for fast checks.
  frozen:z.boolean().default(false),
  createdAt:z.string().datetime(),
  updatedAt:z.string().datetime(),
}).strict();
export type MissionContract=z.infer<typeof MissionContractSchema>;

export const MissionCursorSchema=z.object({
  version:SchemaVersionSchema,
  missionId:z.string(),
  // Exactly one active requirement node at a time. null = no active objective
  // (e.g. awaiting user input, or all requirements addressed).
  activeNodeId:z.string().nullable().default(null),
  // The verbatim statement of the active node, or null when none is active.
  activeObjective:z.string().nullable().default(null),
  // Bounded set of actions allowed next from the current node — never a bare
  // "continue".
  allowedNextActions:z.array(z.string().max(60)).default([]),
  // Why the cursor is blocked / cannot advance, when applicable.
  blockedReason:z.string().max(2000).nullable().default(null),
  // The last concrete action performed against the contract (for audit).
  lastCompletedAction:z.string().max(200).nullable().default(null),
  // Ids of verified (frozen) nodes — durable evidence of locked work.
  frozenNodeIds:z.array(z.string()).default([]),
  // Ids of invalidated nodes.
  invalidatedNodeIds:z.array(z.string()).default([]),
  updatedAt:z.string().datetime(),
}).strict();
export type MissionCursor=z.infer<typeof MissionCursorSchema>;

export const ProjectActiveMissionSchema=z.object({
  version:SchemaVersionSchema,
  projectId:z.string(),
  missionId:z.string(),
  updatedAt:z.string().datetime(),
}).strict();
export type ProjectActiveMission=z.infer<typeof ProjectActiveMissionSchema>;

// ── Mission API inputs ─────────────────────────────────────────────────────
// Optional structured contract supplied by the caller. When ABSENT, the kernel
// preserves only the objective as an authoritative objective node and explicitly
// records that detailed requirements remain unresolved — it never guesses
// artifacts, prohibitions, or acceptance criteria.
export const MissionContractInputSchema=z.object({
  objective:z.string().trim().min(1).max(8000).optional(),
  expectedArtifacts:z.array(z.string().trim().min(1).max(1000)).default([]),
  acceptanceCriteria:z.array(z.string().trim().min(1).max(1000)).default([]),
  verificationCommands:z.array(z.string().trim().min(1).max(2000)).default([]),
  // Required resulting git state (free text, e.g. "clean-working-tree").
  requiredGitResult:z.string().trim().max(500).nullable().default(null),
  prohibitions:z.array(z.string().trim().min(1).max(1000)).default([]),
}).strict();
export type MissionContractInput=z.infer<typeof MissionContractInputSchema>;

export const CreateMissionSchema=z.object({
  objective:z.string().trim().min(1).max(8000),
  conversationId:z.string().optional(),
  autoApprove:z.boolean().optional(),
  maxUsd:z.number().nonnegative().optional(),
  maxAttempts:z.number().int().positive().optional(),
  // Optional structured contract. When provided, its explicit values populate
  // the contract verbatim; when omitted, only the objective is authoritative.
  contract:MissionContractInputSchema.optional(),
}).strict();
export type CreateMissionInput=z.infer<typeof CreateMissionSchema>;

export const AddMissionCriterionSchema=z.object({
  description:z.string().trim().min(1).max(1000),
  verification:MissionVerificationStrategySchema.optional(),
}).strict();
export type AddMissionCriterionInput=z.infer<typeof AddMissionCriterionSchema>;

export const UpdateMissionCriterionSchema=z.object({
  description:z.string().trim().min(1).max(1000).optional(),
  state:MissionCriterionStateSchema.optional(),
  verification:MissionVerificationStrategySchema.optional(),
  waiverReason:z.string().trim().max(2000).optional(),
}).strict().refine(
  (v)=>v.description!==undefined||v.state!==undefined||v.verification!==undefined||v.waiverReason!==undefined,
  {message:"Provide at least one field to update"},
);
export type UpdateMissionCriterionInput=z.infer<typeof UpdateMissionCriterionSchema>;

export {
  MISSION_TRANSITIONS,
  isTerminalMissionStatus,
  canTransitionMission,
  assertMissionTransition,
  MissionTransitionError,
  gradeMission,
} from "./mission-state.js";

export * from "./cortex.js";

export * from "./mission-runtime.js";

export { isReasoningCompatible, normalizeReasoningForRoute } from "./reasoning.js";
