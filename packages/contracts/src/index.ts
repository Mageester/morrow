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
export const TaskSchema=z.object({version:SchemaVersionSchema,id:z.string(),projectId:z.string(),kind:z.enum(["inspect_workspace","agent_chat"]),status:TaskStatusSchema,parentTaskId:z.string().nullable().default(null),agentId:z.string().nullable().optional(),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict();
export const SpawnSubagentSchema=z.object({kind:z.enum(["inspect_workspace"]).default("inspect_workspace"),label:z.string().trim().max(120).optional()}).strict();
export type SpawnSubagentInput=z.infer<typeof SpawnSubagentSchema>;
export const CreateTaskSchema=z.object({projectId:z.string().min(1),kind:z.enum(["inspect_workspace","agent_chat"]),conversationId:z.string().optional(),preset:z.string().optional(),agentId:z.string().optional()});
export const TaskEventSchema=z.object({id:z.string(),taskId:z.string(),sequence:z.number().int().positive(),type:z.enum(["task.created","task.running","plan.created","step.started","step.completed","workspace.inspected","evidence.persisted","agent.state_changed","approval.requested","approval.resolved","verification.completed","tool.started","tool.completed","tool.failed","task.verified","task.completed","task.failed","task.cancelled","task.interrupted","task.recovery_required","provider.fallback"]),createdAt:z.string(),payload:z.record(z.string(),z.unknown())});
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
export const ModelInfoSchema=z.object({
  version:SchemaVersionSchema,
  id:z.string(),
  providerId:ProviderIdSchema,
  label:z.string(),
  contextWindow:z.number().int().positive().nullable(),
  capabilities:ModelCapabilitiesSchema,
  speedClass:ModelSpeedClassSchema,
  costClass:ModelCostClassSchema,
  privacy:ModelPrivacyClassSchema,
  builtIn:z.boolean(),
}).strict();
export const ModelStatusSchema=z.object({
  model:ModelInfoSchema,
  available:z.boolean(),
}).strict();

// ── Presets and provider routing ─────────────────────────────────────────────

export const PresetIdSchema=z.enum(["best-quality","balanced","fast","cheap","coding","research","private-local"]);
export const ToolProfileSchema=z.enum(["read-only","none","agent"]);
export const AgentModeSchema=z.enum(["read-only","plan-only","agent"]);
export const PresetPrivacySchema=z.enum(["local-only","prefers-local","cloud"]);
export const ReasoningEffortSchema=z.enum(["low","medium","high"]);
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
}).strict();

export const SendMessageSchema=z.object({
  content:z.string().trim().min(1).max(32000),
  preset:PresetIdSchema.optional(),
  providerId:ProviderIdSchema.optional(),
  model:z.string().min(1).max(200).optional(),
  mode:AgentModeSchema.optional(),
  useMemory:z.boolean().optional(),
  autoApprove:z.boolean().optional(),
  agentId:z.string().optional(),
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
export type ProviderCapabilities=z.infer<typeof ProviderCapabilitiesSchema>;
export type ProviderStatus=z.infer<typeof ProviderStatusSchema>;
export type ModelInfo=z.infer<typeof ModelInfoSchema>;
export type ModelStatus=z.infer<typeof ModelStatusSchema>;
export type ModelCapabilities=z.infer<typeof ModelCapabilitiesSchema>;
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
  filesystemAccess:z.enum(["read-only","none"]),
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
}).strict();
export type ProviderTestResult=z.infer<typeof ProviderTestResultSchema>;

export const HealthSchema=z.object({
  ok:z.boolean(),
  service:z.literal("morrow-orchestrator"),
  apiVersion:z.number().int(),
  mockProvider:z.boolean(),
  migrations:z.object({applied:z.number().int(),latest:z.number().int().nullable()}).strict(),
  time:z.string(),
}).strict();
export type Health=z.infer<typeof HealthSchema>;
