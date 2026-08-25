import { z } from "zod";
import { liveBus, type EphemeralEvent } from "./execution/live-bus.js";
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import {
  CreateProjectSchema,
  CreateTaskSchema,
  StructuredApiErrorSchema,
  SendMessageSchema,
  CreateConversationSchema,
  DeleteConversationSchema,
  ChatStreamEnvelopeSchema,
  WebTaskReasoningSchema,
  CreateMemoryEntrySchema,
  MemoryImportSchema,
  UpdateMemoryEntrySchema,
  MemoryScopeSchema,
  UpdateConversationSchema,
  ApprovalStatusSchema,
  ResolveApprovalSchema,
  ProviderIdSchema,
  CreateAgentSchema,
  UpdateAgentSchema,
  UpsertToolPermissionSchema,
  CreateTeammateTrustGrantSchema,
  UpsertSkillAccessSchema,
  CreateProjectRuleSchema,
  PatchConventionSchema,
  CreateTeamFromPresetSchema,
  CreateDelegationSchema,
  CreateRoutineSchema,
  UpdateRoutineSchema,
  CreateThreadHandoffSchema,
  InviteConversationParticipantSchema,
  ReorderConversationParticipantSchema,
  ConversationParticipantsSchema,
  ConversationParticipantSchema,
  DelegationAccessContextSchema,
  ResolveDelegationSchema,
  CreateHandoffSchema,
  UpdateAssistantProfileSchema,
  CreateAssistantGoalSchema,
  GlobalSearchResponseSchema,
  WebConversationSupportBundleSchema,
  CreateScheduleSchema,
  UpdateScheduleSchema,
  ScheduleRunSchema,
  ScheduleNotificationOptionsSchema,
  type PresetId,
  type ProviderId,
  type ProviderAuthMode,
  type ChatStreamEventType,
  type RoutingDecision,
  type Conversation,
  type ScheduleNotificationEvent,
} from "@morrow/contracts";
import { openDatabase } from "./database.js";
import { realpathSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectRepository } from "./repositories/projects.js";
import { agentsRepository, AgentInFlightError, SoleExplicitAllowRuleError } from "./repositories/agents.js";
import { teamsRepository } from "./repositories/teams.js";
import { delegationsRepository } from "./repositories/delegations.js";
import { handoffsRepository } from "./repositories/handoffs.js";
import { assistantProfileRepository } from "./repositories/assistant-profile.js";
import { taskRepository } from "./repositories/tasks.js";
import { taskRecordsRepository } from "./repositories/task-records.js";
import { conversationsRepository } from "./repositories/conversations.js";
import { conversationsParticipantsRepository } from "./repositories/conversation-participants.js";
import { conversationContextRefsRepository, ConversationContextRefError } from "./repositories/conversation-context-refs.js";
import { taskRoutingRepository } from "./repositories/task-routing.js";
import { memoryRepository, MemoryOwnershipError } from "./repositories/memory.js";
import { searchRepository } from "./repositories/search.js";
import { skillUsageRepository } from "./repositories/skill-usage.js";
import { learnedSkillsRepository } from "./repositories/learned-skills.js";
import { AutomaticMemoryService } from "./cortex/automatic-memory.js";
import { AutomaticSkillService } from "./cortex/automatic-skills.js";
import { verifySkillDirectory } from "./skills/registry.js";
import {
  applySkillInstall,
  discardSkillInstall,
  parseSkillSource,
  planSkillInstall,
  removeInstalledSkill,
  SkillInstallError,
} from "./skills/install.js";
import { schedulesRepository } from "./repositories/schedules.js";
import { assertValidCron, nextRun } from "./schedule/cron.js";
import { parseTscDiagnostics, parseEslintDiagnostics, summarizeDiagnostics } from "./workspace/diagnostics.js";
import { runProcessSafe } from "./tools/command-executor.js";
import { gitStatus } from "./tools/git.js";
import { loadAdaptersFromEnv, notifyAll, type MessageAdapter } from "./messaging/adapter.js";
import { SearchKindSchema, DiagnosticToolSchema, SpawnSubagentSchema, NotifyRequestSchema, CreateCheckpointSchema, StartProcessSchema, CreateWorktreeSchema } from "@morrow/contracts";
import { redactJsonText } from "./provider/credentials.js";
import { loadMcpConfig, parseMcpServerConfig, type McpServerConfig } from "./mcp/config.js";
import { McpPool } from "./mcp/pool.js";
import { mcpTrustStore } from "./mcp/trust.js";
import { setMcpToolApprovalOverride, isMcpToolAutoApproved } from "./security/mcp-policy.js";

export type DiagnosticsCommandResult = { stdout: string; stderr: string; exitCode: number | null };
export type DiagnosticsRunner = (tool: "tsc" | "eslint", cwd: string) => Promise<DiagnosticsCommandResult>;

const defaultDiagnosticsRunner: DiagnosticsRunner = async (tool, cwd) => {
  const args = tool === "tsc" ? ["tsc", "--noEmit", "--pretty", "false"] : ["eslint", ".", "-f", "json"];
  const result = await runProcessSafe("npx", args, cwd, process.env, { timeoutMs: 120000, maxOutputBytes: 4_000_000 });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
};

function contextUsageFromEvents(events: Array<{ type: string; payload: Record<string, unknown> }>, summary: { id: string; method: string; sourceMessageCount: number; createdAt: string } | undefined) {
  const budget = [...events].reverse().find((event) => event.type === "context.budget_calculated")?.payload;
  const trim = [...events].reverse().find((event) => event.type === "context.history_trimmed" || event.type === "context.trimmed")?.payload;
  const count = [...events].reverse().find((event) => event.type === "context.exact_count_used" || event.type === "context.estimate_used")?.payload;
  const lastContext = [...events].reverse().find((event) => event.type.startsWith("context."));
  if (!budget && !trim && !count && !summary) return null;
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
  const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
  const exact = bool(count?.exact) ?? bool(trim?.exact);
  const method = str(count?.method) ?? str(trim?.countingMethod);
  // "Canonical" fields are what every current agent execution path emits
  // (routing/model-budget.ts's ModelBudget). The remaining fallbacks only
  // exist to interpret event rows persisted before that unification and are
  // never exercised by newly emitted events.
  return {
    providerId: str(budget?.provider) ?? str(count?.provider) ?? "unknown",
    model: str(budget?.model) ?? str(count?.model) ?? "unknown",
    // No trailing `?? 0` here: a route whose window is genuinely unverified
    // (a live-discovered model with no advertised capacity, e.g.) must report
    // null, not a fabricated zero a naive `!= null` check would render as a
    // real number. Every CLI/web consumer of these fields already treats
    // "<= 0" the same as null (terminal/mission-control.ts's `tokens()`), so
    // this was always effectively meant to be unknown, not zero.
    contextWindowTokens: num(budget?.contextWindowTokens) ?? num(budget?.modelCapacityTokens),
    contextWindowSource: str(budget?.contextWindowSource) ?? str(budget?.modelCapacitySource) ?? "unknown",
    // Confidence in the window/reserve numbers below — "verified" (provider- or
    // registry-reported), "reported"/"configured" (a live or user-supplied
    // value Morrow cannot independently verify), "unverified" (no
    // authoritative value; an internal safe fallback was used). Mirrors
    // routing/model-budget.ts's ModelBudget.contextWindowConfidence exactly —
    // this is a read-only view, never a second computation of it.
    contextWindowConfidence: str(budget?.contextWindowConfidence) ?? "unverified",
    modelCapacityTokens: num(budget?.contextWindowTokens) ?? num(budget?.modelCapacityTokens),
    modelCapacitySource: str(budget?.contextWindowSource) ?? str(budget?.modelCapacitySource) ?? "unknown",
    endpointLimitTokens: num(budget?.endpointLimitTokens),
    endpointLimitSource: str(budget?.endpointLimitSource) ?? "unknown",
    effectiveRequestLimitTokens: num(budget?.contextWindowTokens) ?? num(budget?.effectiveRequestLimitTokens),
    effectiveLimitSource: str(budget?.contextWindowSource) ?? str(budget?.effectiveLimitSource) ?? "unknown",
    maxInputTokens: num(budget?.usableInputTokens) ?? num(budget?.maximumInputTokens) ?? num(budget?.maxInputTokens) ?? num(trim?.maxInputTokens),
    maximumInputTokens: num(budget?.usableInputTokens) ?? num(budget?.maximumInputTokens) ?? num(budget?.maxInputTokens),
    reservedTokens: num(budget?.totalReserveTokens) ?? num(budget?.outputReserveTokens) ?? num(budget?.reservedOutputTokens) ?? num(budget?.reservedTokens),
    outputReserveTokens: num(budget?.outputReserveTokens) ?? num(budget?.reservedOutputTokens),
    currentRequestTokens: num(budget?.currentRequestTokens) ?? num(trim?.inputTokensAfter) ?? num(count?.tokens),
    inputTokensBefore: num(trim?.inputTokensBefore) ?? num(count?.tokens),
    inputTokensAfter: num(trim?.inputTokensAfter) ?? num(trim?.finalTokens) ?? null,
    countingMethod: method,
    exact,
    compactedGroups: num(trim?.compactedGroups) ?? 0,
    removedGroups: num(trim?.removedGroups) ?? 0,
    lastOperation: lastContext?.type ?? null,
    warning: exact === false ? "estimated token count" : null,
    lastSummary: summary
      ? { id: summary.id, method: summary.method, sourceMessageCount: summary.sourceMessageCount, createdAt: summary.createdAt }
      : null,
    // ── Route-aware capacity diagnostics (routing/effective-context.ts) ──────
    // Native model window vs. the provider/route's own cap, and the effective
    // = min(native, route) value actually enforced, each with its own
    // provenance — never collapsed into one number before it reaches the UI.
    nativeContextWindowTokens: num(budget?.nativeContextWindowTokens),
    nativeContextWindowSource: str(budget?.nativeContextWindowSource),
    routeLimitTokens: num(budget?.routeLimitTokens),
    routeLimitSource: str(budget?.routeLimitSource),
    effectiveContextWindowTokens: num(budget?.effectiveContextWindowTokens) ?? num(budget?.contextWindowTokens),
    // Reserve breakdown: output generation, plus the harness's own system-
    // prompt/tool-schema overhead, sum to totalReserveTokens.
    harnessReserveTokens: num(budget?.harnessReserveTokens),
    totalReserveTokens: num(budget?.totalReserveTokens),
    currentModelVisibleTokens: num(budget?.currentModelVisibleTokens),
    remainingInputTokens: num(budget?.remainingInputTokens),
    compactionThresholdTokens: num(budget?.compactionThresholdTokens),
    compactionThresholdRatio: num(budget?.compactionThresholdRatio),
  };
}

/**
 * What reasoning Morrow actually applied on the most recent request for this
 * task, and whether the route accepted it.
 *
 * Sourced entirely from `provider.request_started` (which carries the exact
 * `translateReasoning()` output for the attempt that was made — see
 * execution/agent.ts) and `provider.reasoning_unavailable` (emitted when a
 * requested selection could not be translated for the exact serving route).
 * Never recomputed: the browser must see the same wire params the adapter
 * actually sent, not a client-side guess at what a provider's dialect means.
 */
function reasoningApplicationFromEvents(events: Array<{ type: string; payload: Record<string, unknown> }>) {
  const applied = [...events].reverse().find((event) => event.type === "provider.request_started")?.payload;
  const unavailable = [...events].reverse().find((event) => event.type === "provider.reasoning_unavailable")?.payload;
  if (!applied && !unavailable) return null;
  const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
  const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
  return {
    requested: applied?.reasoningRequested ?? unavailable?.requestedReasoning ?? null,
    applied: applied?.reasoningApplied ?? null,
    supported: bool(applied?.reasoningSupported),
    unsupportedReason: str(applied?.reasoningUnsupportedReason) ?? str(unavailable?.reason),
    // The exact request-body fragment the adapter sent for this reasoning
    // selection — e.g. `{ thinkingConfig: { thinkingLevel: "HIGH" } }` for
    // Gemini, or `{ reasoning_effort: "high" }` for an OpenAI-family route.
    // Empty object means "no explicit reasoning params sent" (Auto/none).
    wireParams: applied?.reasoningWireParams ?? null,
    control: str(applied?.reasoningControl),
    source: str(applied?.reasoningSource),
    wire: str(applied?.reasoningWire),
    supportsOff: bool(applied?.reasoningSupportsOff),
    fallbackToRouteDefault: unavailable !== undefined,
  };
}
import { approvalsRepository } from "./repositories/approvals.js";
import { recoverRunningTasks } from "./recovery.js";
import { TaskRunner } from "./runner.js";
import { changeSetsRepository } from "./repositories/change-sets.js";
import { checkpointsRepository } from "./repositories/checkpoints.js";
import { snapshotFiles, restoreSnapshot, isValidCheckpointName } from "./workspace/checkpoints.js";
import { missionsRepository } from "./repositories/missions.js";
import { missionRuntimeRepository } from "./repositories/mission-runtime.js";
import { providerModelDiscoveryRepository } from "./repositories/provider-model-discovery.js";
import { MissionService, MissionError } from "./mission/service.js";
import { ensureCortexSpecialistAgents } from "./mission/specialists.js";
import { buildMissionCompletion } from "./mission/completion.js";
import { intelligenceRepository } from "./repositories/intelligence.js";
import { CortexService, CortexError } from "./cortex/service.js";
import { analyzeChangeImpact } from "./cortex/impact.js";
import { CreateMissionSchema, AddMissionCriterionSchema, UpdateMissionCriterionSchema } from "@morrow/contracts";
import { processesRepository } from "./repositories/processes.js";
import { worktreesRepository } from "./repositories/worktrees.js";
import { WorktreeManager, WorktreeError } from "./workspace/worktrees.js";
import { integrationsRepository } from "./repositories/integrations.js";
import { contextSummariesRepository } from "./repositories/context-summaries.js";
import { createExecutionLeaseOwnerId, executionContinuityRepository, executionLeaseOwnerStatus } from "./repositories/execution-continuity.js";
import { symbolIndexRepository } from "./repositories/symbols.js";
import { IntegrationManager, IntegrationError } from "./workspace/integrations.js";
import { SymbolIndex } from "./workspace/symbol-index.js";
import { ProcessSupervisor, terminalCapabilities } from "./processes/supervisor.js";

import { ApprovalContinuationRegistry } from "./execution/continuation.js";
import { hashString, assertContainedRealPath } from "./tools/diff-applier.js";
import { canonicalCommandTrustKey, classifyCommand } from "./tools/command-policy.js";
import { resolveMorrowHome } from "./home.js";
import { unlinkSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createProvider, installProviderModelDiscoveries, listProviderStatuses, providerCapabilities } from "./provider/registry.js";
import type { ProviderRouteMetadata, ChatMessage } from "./provider/base.js";
import { globalRateGuard } from "./provider/rate-guard.js";
import { OAUTH_FINDINGS } from "./provider/oauth.js";
import { oauthStatuses, startAuthorization, exchangeCode, signOut, isOAuthProvider } from "./provider/oauth-flow.js";
import { BUILT_IN_MODELS, installModelCatalog, listModels, listConfiguredCustomModels, mergeModelCatalog, resolveModelMetadata, resolveModelStatuses } from "./routing/models.js";
import { ModelCatalog, externalCatalogFromSnapshot } from "./routing/model-catalog.js";
import { installExternalModelCatalog } from "./provider/external-catalog/index.js";
import { listPresets, getPreset, isPresetId, DEFAULT_PRESET_ID } from "./routing/presets.js";
import { routePreset, listPresetStatuses } from "./routing/router.js";
import { testProviderConnectivity } from "./provider/connectivity.js";
import { buildProviderCandidateEnv, configureProvider, providerCredentialIdentity, removeProviderCredentials, providerEnvMapping } from "./provider/secrets.js";
import { PairingStatusResponseSchema, RedeemPairingCodeSchema, RedeemPairingCodeResultSchema } from "@morrow/contracts";
import { normalizePairingCode, redeemPairingCode } from "./hosted/pairing-client.js";
import { resolveHostedApiUrl } from "./hosted/hosted-api-url.js";
import { writeHostedPairing } from "./hosted/pairing-store.js";
import type { EntitlementPoller } from "./hosted/entitlement-poller.js";
import { hostname } from "node:os";
import { TOOL_CATALOG, PERMISSION_PROFILE } from "./tools/catalog.js";
import { evaluateLocalRequest, parseTrustedOrigins } from "./security/local-guard.js";
import { countChatTokens, prepareContextForProvider, admitProviderRequest } from "./execution/context-budget.js";
import { boundCompletedToolArguments, buildProviderProjection } from "./execution/provider-projection.js";
import { resolveModelBudget } from "./routing/model-budget.js";
import { AgentTaskDispatchError, cleanupUnstartedChild, dispatchAgentTask, spawnAgentChatSubagent as dispatchAgentChatSubagent } from "./mission/task-dispatcher.js";
import { TeammateSpawnRegistry, teammateProfileFingerprint } from "./tools/teammate-delegation.js";
import { teammateTrustRepository } from "./repositories/teammate-trust.js";
import { createResearchAndVerifyTeam } from "./mission/research-and-verify-preset.js";
import { runReadmeSummarySample, ReadmeSummarySampleError } from "./mission/readme-summary-sample.js";
import { registerWebMissionRoutes } from "./web/mission-routes.js";
import { registerWebMissionStreamRoutes } from "./web/mission-stream.js";
import { projectConversationActivity } from "./web/activity-projection.js";
import { DEFAULT_CONVERSATION_TITLE, deriveConversationTitle, isDefaultConversationTitle } from "./web/conversation-title.js";
import { DEFAULT_TEAMMATE_NAME, projectRoster } from "./web/roster-projection.js";
import { projectToolEvidence } from "./web/tool-evidence.js";
import { projectThreadHandoffs } from "./web/handoff-projection.js";
import { projectRoutineProposal } from "./web/routine-proposal.js";
import { routinesRepository } from "./repositories/routines.js";
import { assertRoutineTarget, dispatchRoutineTask } from "./routines/dispatch.js";
import { registerWebAppRoutes } from "./web/static-app.js";
import { createNativeFolderPicker, FolderPickerUnavailableError, type FolderPicker } from "./system/folder-picker.js";

export class ApiError extends Error {
  constructor(public statusCode: number, message: string, public code: string = "INTERNAL_ERROR") {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * An idempotency key lets a client safely retry a creation request (e.g. after a
 * dropped connection) without spawning a duplicate task. Accepted from the
 * `Idempotency-Key` header or an `idempotencyKey` body field. Bounded and
 * trimmed; anything empty or oversized is treated as absent.
 */
function readIdempotencyKey(request: { headers?: Record<string, unknown>; body?: unknown }): string | undefined {
  const header = request.headers?.["idempotency-key"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const body = request.body as { idempotencyKey?: unknown } | undefined;
  const fromBody = typeof body?.idempotencyKey === "string" ? body.idempotencyKey : undefined;
  const raw = (typeof fromHeader === "string" ? fromHeader : undefined) ?? fromBody;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : undefined;
}

function parseEventCursor(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new ApiError(400, "Invalid cursor", "INVALID_CURSOR");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new ApiError(400, "Invalid cursor", "INVALID_CURSOR");
  return cursor;
}

export type ServerDependencies = {
  db: Database.Database;
  runner: TaskRunner;
  /** Wake durable mission ownership after task or approval state changes. */
  missionControllerRunner?: {
    run?(missionId: string): void;
    wake(missionId: string): void;
    cancel?(missionId: string): void;
    waitFor?(missionId: string): Promise<void>;
    isActive?(missionId: string): boolean;
  };
  /** Injectable background-process supervisor (tests point its logs at a temp dir). */
  supervisor?: ProcessSupervisor;
  sseIntervalMs?: number;
  /** Idle heartbeat cadence for the web mission stream; injectable for tests. */
  webStreamHeartbeatMs?: number;
  modelCatalog?: ModelCatalog;
  /** Injectable account-model discovery transport for deterministic tests. */
  providerConnectivityTest?: typeof testProviderConnectivity;
  /** Defaults on outside tests; discovery failures never block server startup. */
  backgroundModelDiscovery?: boolean;
  /** Injectable so the diagnostics route is fast and deterministic in tests. */
  diagnosticsRunner?: DiagnosticsRunner;
  /** Injectable messaging adapters; defaults to env-configured ones. */
  messageAdapters?: MessageAdapter[];
  /**
   * Absolute path to the Morrow secrets file. When provided, the
   * provider-configuration endpoints can persist credentials and hot-apply them
   * to the running process. When absent, those endpoints report that in-app
   * configuration is unavailable (e.g. in tests) rather than failing obscurely.
   */
  secretsFile?: string;
  /**
   * Tracks this install's hosted-account pairing/entitlement state (Plans/
   * generic-sprouting-dragon.md Phase 4). When absent, /api/pairing/status
   * reports "unpaired" and /api/pairing/redeem is unavailable — matches how
   * `secretsFile` being absent degrades the provider-configuration routes.
   */
  entitlementPoller?: EntitlementPoller;
  /**
   * Absolute path to the built web bundle (the directory containing
   * `index.html`). When provided, the orchestrator serves the local Morrow web
   * application at `/app`. When absent, the service stays CLI-only and no `/app`
   * surface exists.
   */
  webRoot?: string;
  /** Local OS folder chooser used by the web project-registration flow. */
  folderPicker?: FolderPicker;
};

export function buildServer(deps: ServerDependencies): FastifyInstance {
  const app = Fastify({ logger: false });

  // Reject requests that aren't trustworthy local clients BEFORE any routing,
  // body parsing, or handler runs. This protects the loopback API from hostile
  // browser pages (CSRF), DNS rebinding, and forged Host/Origin headers without
  // requiring any token or manual setup for the CLI, web UI, or installer.
  const trustedOrigins = parseTrustedOrigins(process.env.MORROW_TRUSTED_ORIGINS);
  app.addHook("onRequest", async (request, reply) => {
    const decision = evaluateLocalRequest({
      host: request.headers.host,
      origin: request.headers.origin as string | undefined,
      trustedOrigins,
    });
    if (!decision.ok) {
      return reply.status(403).send({
        version: 1,
        error: { code: decision.code ?? "FORBIDDEN", message: decision.reason ?? "Request rejected." },
      });
    }
  });

  const projects = projectRepository(deps.db);
  const folderPicker = deps.folderPicker ?? createNativeFolderPicker();
  const agents = agentsRepository(deps.db);
  const teammateTrust = teammateTrustRepository(deps.db);
  const teams = teamsRepository(deps.db);
  const delegations = delegationsRepository(deps.db);
  const handoffs = handoffsRepository(deps.db);
  const assistantProfile = assistantProfileRepository(deps.db);
  const routines = routinesRepository(deps.db);
  const tasks = taskRepository(deps.db);
  const records = taskRecordsRepository(deps.db);
  const convs = conversationsRepository(deps.db);
  const routingRepo = taskRoutingRepository(deps.db);
  const memory = memoryRepository(deps.db);
  const search = searchRepository(deps.db);
  const skillUsage = skillUsageRepository(deps.db);
  const learnedSkills = learnedSkillsRepository(deps.db);
  const schedules = schedulesRepository(deps.db);
  const approvals = approvalsRepository(deps.db);
  const changeSets = changeSetsRepository(deps.db);
  const checkpoints = checkpointsRepository(deps.db);
  // Shared by the REST subagent path and model-authored ask_teammate calls so
  // one parent/tool-call pair cannot race into two in-process children.
  const teammateSpawnRegistry = new TeammateSpawnRegistry();

  /**
   * Delegation ids are opaque database identifiers, not authorization. The
   * parent task context is required on every detail/mutation route and is
   * re-checked against the team, agent, membership, and child task relations.
   */
  function requireDelegationContext(delegationId: string, parentTaskId: string) {
    const delegation = delegations.get(delegationId);
    if (!delegation) throw new ApiError(404, "Delegation not found", "NOT_FOUND");
    if (delegation.parentTaskId !== parentTaskId) {
      throw new ApiError(404, "Delegation not found for this parent task", "NOT_FOUND");
    }
    const parent = tasks.getTaskById(parentTaskId);
    if (!parent) throw new ApiError(404, "Parent task not found", "NOT_FOUND");
    const project = projects.getProjectById(parent.projectId);
    if (!project) throw new ApiError(404, "Parent project not found", "NOT_FOUND");
    const team = teams.get(delegation.teamId);
    const agent = agents.get(delegation.agentId);
    const isMember = teams.listMembers(delegation.teamId).some((member) => member.agentId === delegation.agentId);
    if (!team || team.projectId !== parent.projectId || !agent || agent.projectId !== parent.projectId || !isMember) {
      throw new ApiError(404, "Delegation objects are not in the parent project", "NOT_FOUND");
    }
    const child = delegation.childTaskId ? tasks.getTaskById(delegation.childTaskId) : undefined;
    if (delegation.childTaskId && (!child || child.projectId !== parent.projectId || child.parentTaskId !== parent.id || child.agentId !== delegation.agentId)) {
      throw new ApiError(409, "Delegation child task relation is invalid", "INTEGRITY_ERROR");
    }
    return { delegation, parent, project, team, agent, child };
  }
  const missions = missionsRepository(deps.db);
  const missionRuntime = missionRuntimeRepository(deps.db);
  const providerModelDiscovery = providerModelDiscoveryRepository(deps.db);
  installProviderModelDiscoveries(providerModelDiscovery.list());
  const providerConnectivityTest = deps.providerConnectivityTest ?? testProviderConnectivity;
  const discoveryExpiresAt = (fetchedAt: string, ok: boolean) => new Date(Date.parse(fetchedAt) + (ok ? 15 * 60_000 : 60_000)).toISOString();
  const refreshProviderModelDiscovery = async (providerId: ProviderId, knownAuthMode?: ProviderAuthMode) => {
    const envSnapshot = { ...process.env };
    const credentialIdentity = providerCredentialIdentity(providerId, envSnapshot);
    const result = await providerConnectivityTest(providerId, envSnapshot);
    if (providerId === "openrouter" && providerCredentialIdentity(providerId, process.env) !== credentialIdentity) {
      // A discarded refresh says nothing about whether a credential is stored —
      // one plainly is, it just changed mid-flight. `configured` stays true so
      // the UI does not flip to "not connected" during a routine key rotation.
      return { ...result, ok: false, configured: true, status: null, detail: "OpenRouter credential changed while refresh was in flight; result discarded.", errorKind: "cancelled", modelsSample: [], models: [] };
    }
    const authMode = knownAuthMode ?? listProviderStatuses().find((item) => item.id === providerId)?.authMode;
    if (authMode) {
      const fetchedAt = new Date().toISOString();
      providerModelDiscovery.upsert({
        providerId,
        authMode,
        status: result.ok ? "available" : "unavailable",
        models: result.models,
        errorKind: result.errorKind,
        fetchedAt,
        expiresAt: discoveryExpiresAt(fetchedAt, result.ok),
        lastSuccessAt: result.ok ? fetchedAt : null,
        credentialIdentity,
      });
      installProviderModelDiscoveries(providerModelDiscovery.list());
    }
    return result;
  };
  if (deps.backgroundModelDiscovery ?? process.env.NODE_ENV !== "test") {
    const configured = listProviderStatuses().filter((status) =>
      status.authMode && status.id !== "mock" && (status.configured || (status.id === "openrouter" && !!process.env.OPENROUTER_API_KEY))
      && !providerModelDiscovery.isFresh(status.id, status.authMode, new Date(), providerCredentialIdentity(status.id, process.env))
    );
    queueMicrotask(() => {
      void Promise.allSettled(configured.map((status) => refreshProviderModelDiscovery(status.id, status.authMode)));
    });
  }
  const modelCatalog = deps.modelCatalog ?? new ModelCatalog({
    cacheDir: join(resolveMorrowHome(process.env), "catalog"),
    // Default public metadata source. Provider discovery still solely decides
    // account availability; catalog rows supply capabilities only.
    remoteUrl: process.env.MORROW_MODEL_CATALOG_URL?.trim() || "https://models.dev/api.json",
    bundledModels: BUILT_IN_MODELS,
  });
  /**
   * One snapshot feeds both capability paths: the flat compatibility catalog
   * every legacy consumer reads, and the indexed external metadata source the
   * exact-route capability resolver consults. Installing them together is what
   * stops the UI and the request builder from resolving against different
   * vintages of the same data.
   */
  const applyModelCatalogSnapshot = (snapshot: ReturnType<ModelCatalog["current"]>) => {
    try {
      installModelCatalog(mergeModelCatalog(BUILT_IN_MODELS, snapshot.models));
      installExternalModelCatalog(externalCatalogFromSnapshot(snapshot));
    } catch (error) {
      // A third-party database can publish an identity Morrow's catalog graph
      // rejects. That is a reason to fall back to bundled metadata, never a
      // reason for the server not to start: public model metadata is an
      // enhancement, and a cached snapshot must not be able to brick a local
      // install. Both views retreat together — a state where the picker shows
      // bundled facts while the request builder uses external ones is worse
      // than one where neither does.
      installModelCatalog([...BUILT_IN_MODELS]);
      installExternalModelCatalog(null);
      console.error(`Model catalog snapshot rejected (${snapshot.catalogVersion}); using bundled metadata`, error);
    }
    return snapshot;
  };
  applyModelCatalogSnapshot(modelCatalog.current());
  // Catalog refresh is operator-triggered. Starting a Private Local session
  // must not make an outbound metadata request before any routing choice.
  const refreshModelCatalog = async () => applyModelCatalogSnapshot(await modelCatalog.refresh());
  const intelligenceRepo = intelligenceRepository(deps.db);
  const cortexService = new CortexService({
    repo: intelligenceRepo,
    getWorkspacePath: (projectId) => projects.getProjectById(projectId)?.workspacePath,
    memory: new AutomaticMemoryService(memory),
    skills: new AutomaticSkillService({
      repo: learnedSkills,
      rootForProject: (projectId) => join(resolveMorrowHome(process.env), "projects", projectId, "skills"),
    }),
  });
  const missionService = new MissionService({
    repo: missions,
    getWorkspacePath: (projectId) => projects.getProjectById(projectId)?.workspacePath,
    completion: buildMissionCompletion({ env: process.env }),
    backupDir: join(resolveMorrowHome(process.env), "mission-checkpoints"),
    cortex: cortexService,
  });
  const missionProjection = (missionId: string) => {
    const mission = missionService.get(missionId);
    const runtime = missionRuntime.get(missionId);
    if (!runtime) return { ...mission, runtime: null };
    const operations = missionRuntime.listOperations(missionId);
    const guardian = missionService.assessGuardian(missionId);
    const providerModelHistory = deps.db.prepare(`SELECT segment.provider_id AS providerId,segment.model,
        segment.sequence,segment.status,segment.boundary_reason AS boundaryReason
      FROM agent_execution_segments segment
      JOIN tasks task ON task.id=segment.task_id
      WHERE task.mission_id=? ORDER BY segment.started_at,segment.id`)
      .all(missionId);
    return {
      ...mission,
      runtime: {
        ...runtime,
        currentOperation: runtime.activeOperationId
          ? operations.find((operation) => operation.id === runtime.activeOperationId) ?? null
          : null,
        operations,
        transitions: missionRuntime.listTransitions(missionId),
        progress: missionRuntime.listProgress(missionId),
        recoveryDecisions: missionRuntime.listRecoveryDecisions(missionId),
        guardian,
        blocker: guardian.passed
          ? null
          : [...guardian.blocked, ...guardian.failed, ...guardian.missing].at(0)?.detail ?? null,
        providerModelHistory,
        evidenceCounts: {
          passed: mission.evidence.filter((item) => item.status === "passed").length,
          failed: mission.evidence.filter((item) => item.status === "failed").length,
          inconclusive: mission.evidence.filter((item) => item.status === "inconclusive").length,
        },
      },
    };
  };
  // Web app surface: honest mission projections for the browser client. Injected
  // with the same repositories/service the terminal API uses so there is a
  // single source of truth and zero behavior change to the existing routes.
  registerWebMissionRoutes(app, {
    db: deps.db,
    projects,
    missions,
    approvals,
    agents,
    missionRuntime,
    missionService,
    ...(deps.missionControllerRunner ? { missionControllerRunner: deps.missionControllerRunner } : {}),
    readIdempotencyKey,
  });
  // Resumable, ordered mission event stream (SSE) for the web client. Polls
  // persisted mission events so it is correct across restarts and never leaks
  // provider internals into the wire payload.
  registerWebMissionStreamRoutes(app, {
    missions,
    ...(deps.sseIntervalMs !== undefined ? { pollIntervalMs: deps.sseIntervalMs } : {}),
    ...(deps.webStreamHeartbeatMs !== undefined ? { heartbeatIntervalMs: deps.webStreamHeartbeatMs } : {}),
  });
  // Local web application surface. Serves the built bundle at /app with SPA
  // fallback when a web root is present, and otherwise installs only the JSON
  // not-found envelope so the service stays CLI-only. Never intercepts /api/*
  // or the JSON root probe.
  registerWebAppRoutes(app, {
    ...(deps.webRoot !== undefined ? { webRoot: deps.webRoot } : {}),
  });

  const processesRepo = processesRepository(deps.db);
  const supervisor = deps.supervisor ?? new ProcessSupervisor(processesRepo, join(resolveMorrowHome(process.env), "process-logs"));
  // A `running` row from a previous orchestrator run is unobservable — mark it
  // lost before serving any traffic so no stale row masquerades as live.
  supervisor.reconcileOnStartup();
  const worktreesRepo = worktreesRepository(deps.db);
  const worktreeManager = new WorktreeManager(worktreesRepo, join(resolveMorrowHome(process.env), "worktrees"));
  const integrationsRepo = integrationsRepository(deps.db);
  const contextSummariesRepo = contextSummariesRepository(deps.db);
  const executionContinuityRepo = executionContinuityRepository(deps.db);
  const symbolIndexRepo = symbolIndexRepository(deps.db);
  const symbolIndex = new SymbolIndex(symbolIndexRepo);
  const integrationManager = new IntegrationManager(
    integrationsRepo,
    worktreesRepo,
    (projectId) => projects.getProjectById(projectId)?.workspacePath
  );
  // Abandoned-worktree reconciliation: a row whose directory vanished is
  // marked (branch retained) before any traffic is served.
  worktreeManager.reconcile((projectId) => projects.getProjectById(projectId)?.workspacePath);
  supervisor.onExit((record) => {
    if (!record.taskId) return;
    try {
      records.appendEvent({
        id: crypto.randomUUID(),
        taskId: record.taskId,
        type: "process.exited",
        payload: { processId: record.id, status: record.status, exitCode: record.exitCode, detail: record.detail },
        createdAt: new Date().toISOString(),
      });
    } catch { /* the task may be gone; never break the supervisor */ }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      reply.status(400).send({
        version: 1,
        error: { code: "VALIDATION_ERROR", message: "Invalid request payload" }
      });
      return;
    }
    
    if (error instanceof ApiError) {
      reply.status(error.statusCode).send({
        version: 1,
        error: { code: error.code, message: error.message }
      });
      return;
    }

    // Framework-level client errors (malformed JSON body, payload too large,
    // unsupported media type, etc.) carry a 4xx statusCode and a stable FST_*
    // code. These are the caller's fault, not ours, so surface them as a
    // structured 4xx instead of masking them as a misleading 500.
    const frameworkStatus = (error as { statusCode?: number }).statusCode;
    if (typeof frameworkStatus === "number" && frameworkStatus >= 400 && frameworkStatus < 500) {
      reply.status(frameworkStatus).send({
        version: 1,
        error: { code: (error as { code?: string }).code ?? "BAD_REQUEST", message: "Invalid request" }
      });
      return;
    }

    reply.status(500).send({
      version: 1,
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" }
    });
  });

  // Liveness + schema probe. Used by the CLI to detect a running service and by
  // `morrow doctor` to report migration state. Exposes no secrets. Morrow is a
  // terminal-first product with no bundled web UI, so "/" is always this JSON
  // probe.
  app.get("/", async () => ({
    name: "morrow-orchestrator",
    status: "healthy",
    health: "/api/health",
  }));

  app.get("/api/health", async () => {
    const row = deps.db.prepare("SELECT MAX(id) AS latest, COUNT(*) AS applied FROM schema_migrations").get() as { latest: number | null; applied: number };
    return {
      ok: true,
      service: "morrow-orchestrator",
      apiVersion: 1,
      mockProvider: process.env.MOCK_PROVIDER === "true",
      ownerPid: process.pid,
      // Which install this service belongs to. A packaged launcher checks this
      // before adopting an already-healthy service on its port: without it,
      // "something answers /api/health" was the whole test, so a freshly
      // installed build would silently drive an unrelated orchestrator from
      // another install or worktree — and every check run against it would be
      // measuring the wrong code.
      serviceRoot: process.env.MORROW_HOME ?? null,
      serviceEntry: process.argv[1] ?? null,
      migrations: { applied: Number(row.applied), latest: row.latest },
      time: new Date().toISOString(),
    };
  });

  app.get("/api/capabilities/terminal", async () => ({ version: 1, ...terminalCapabilities() }));

  app.post("/api/projects", async (request, reply) => {
    const body = CreateProjectSchema.parse(request.body);
    
    if (!existsSync(body.workspacePath) || !lstatSync(body.workspacePath).isDirectory()) {
      throw new ApiError(400, "Workspace must exist and be a directory", "INVALID_WORKSPACE");
    }

    let canonicalPath;
    try {
      canonicalPath = realpathSync(body.workspacePath);
    } catch {
      throw new ApiError(400, "Invalid workspace path", "INVALID_WORKSPACE");
    }

    try {
      const project = projects.createProject({
        id: crypto.randomUUID(),
        name: body.name,
        workspacePath: canonicalPath,
        createdAt: new Date().toISOString()
      });
      return project;
    } catch (e: any) {
      if (e.message.includes("Traversal rejected") || e.message.includes("Symlink escape")) {
         throw new ApiError(400, "Invalid workspace path", "INVALID_WORKSPACE");
      }
      throw e;
    }
  });

  app.post("/api/projects/pick-folder", async () => {
    let selectedPath: string | null;
    try {
      selectedPath = await folderPicker();
    } catch (error) {
      if (error instanceof FolderPickerUnavailableError) {
        throw new ApiError(503, "Morrow could not open a native folder picker. Enter the folder path manually instead.", "FOLDER_PICKER_UNAVAILABLE");
      }
      throw error;
    }

    if (!selectedPath) return { path: null, name: null };
    if (!existsSync(selectedPath) || !lstatSync(selectedPath).isDirectory()) {
      throw new ApiError(400, "The selected workspace is not an accessible directory", "INVALID_WORKSPACE");
    }

    let canonicalPath: string;
    try {
      canonicalPath = realpathSync(selectedPath);
    } catch {
      throw new ApiError(400, "The selected workspace could not be opened", "INVALID_WORKSPACE");
    }

    return { path: canonicalPath, name: basename(canonicalPath) || "Project" };
  });

  app.get("/api/projects", async (request, reply) => {
    return projects.listProjects();
  });

  app.get("/api/projects/:projectId", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return project;
  });

  app.delete("/api/projects/:projectId", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    projects.deleteProject(projectId);
    return { ok: true, deletedId: projectId };
  });

  // Dedicated status endpoint (rather than adding these fields to the project
  // list/get responses) so the browser only pays for a git spawn + realpath
  // check when a surface actually needs to show workspace health, not on every
  // project list fetch.
  app.get("/api/projects/:projectId/status", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");

    let canonicalPath = project.workspacePath;
    let accessible = false;
    try {
      canonicalPath = realpathSync(project.workspacePath);
      accessible = lstatSync(canonicalPath).isDirectory();
    } catch {
      accessible = false;
    }

    let gitDetected = false;
    let branch: string | null = null;
    if (accessible) {
      try {
        const status = await gitStatus(canonicalPath, { timeoutMs: 2000 });
        const branchLine = status.lines.find((line) => line.startsWith("## "));
        if (branchLine) {
          gitDetected = true;
          const match = /^## (?:No commits yet on )?([^.\s]+)/.exec(branchLine);
          branch = match?.[1] && match[1] !== "HEAD" ? match[1] : null;
        }
      } catch {
        gitDetected = false;
      }
    }

    return {
      id: project.id,
      name: project.name,
      workspacePath: canonicalPath,
      accessible,
      gitDetected,
      branch,
    };
  });

  // ── Agents ─────────────────────────────────────────────────────────────────

  app.get("/api/projects/:projectId/agents", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return agents.listByProject(projectId);
  });

  // The teammate roster the left rail renders: every named agent plus the
  // built-in default teammate, each with live status derived from task and
  // approval state. Read-only and safe to poll.
  app.get("/api/projects/:projectId/roster", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return projectRoster({
      db: deps.db,
      projectId,
      defaultTeammateName: assistantProfile.get().assistantName?.trim() || DEFAULT_TEAMMATE_NAME,
    });
  });

  app.post("/api/projects/:projectId/agents", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = CreateAgentSchema.parse(request.body);
    if (body.teamId) {
      const team = teams.get(body.teamId);
      if (!team || team.projectId !== projectId) {
        throw new ApiError(400, "Agent team must belong to the same project", "TEAM_PROJECT_MISMATCH");
      }
    }
    const agent = agents.create({ id: crypto.randomUUID(), projectId, ...body, role: body.role ?? "assistant" });
    reply.status(201);
    return agent;
  });

  app.get("/api/agents/:agentId", async (request) => {
    const { agentId } = request.params as { agentId: string };
    const agent = agents.get(agentId);
    if (!agent) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    return agent;
  });

  app.put("/api/agents/:agentId", async (request) => {
    const { agentId } = request.params as { agentId: string };
    const agent = agents.get(agentId);
    if (!agent) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    // Read projectId from body to authorize the update.
    const body = z.object({ projectId: z.string().min(1), ...UpdateAgentSchema.shape }).parse(request.body);
    if (body.teamId) {
      const team = teams.get(body.teamId);
      if (!team || team.projectId !== body.projectId) {
        throw new ApiError(400, "Agent team must belong to the same project", "TEAM_PROJECT_MISMATCH");
      }
    }
    const updated = agents.update(agentId, body.projectId, body);
    if (!updated) throw new ApiError(404, "Agent not found in project", "NOT_FOUND");
    return updated;
  });

  app.delete("/api/agents/:agentId", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const body = z.object({ projectId: z.string().min(1) }).parse(request.body);
    const agent = agents.get(agentId);
    if (!agent || agent.projectId !== body.projectId) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    // A group conversation's agent_id is the immutable conductor binding.
    // Deleting the agent would leave a dangling task owner (or force an active
    // tombstone row that falsely looks runnable), so preserve the truthful
    // binding by refusing deletion until its conversations are retired.
    const conductorBinding = deps.db.prepare(
      "SELECT id FROM conversations WHERE project_id=? AND agent_id=? AND mode='group' LIMIT 1",
    ).get(body.projectId, agentId) as { id?: string } | undefined;
    if (conductorBinding) {
      throw new ApiError(409, "This teammate is the immutable conductor of a conversation and cannot be deleted", "AGENT_CONVERSATION_CONDUCTOR");
    }
    try {
      if (!agents.delete(agentId, body.projectId)) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    } catch (error) {
      if (error instanceof AgentInFlightError) throw new ApiError(409, error.message, error.code);
      throw error;
    }
    reply.status(204).send();
  });
  // ── Agent Tool Permissions ─────────────────────────────────────────────────

  const scopedToolPermissionAgent = (request: { params: unknown; query: unknown }) => {
    const { agentId } = request.params as { agentId: string };
    const { projectId } = z.object({ projectId: z.string().min(1) }).parse(request.query);
    const agent = agents.get(agentId);
    if (!agent || agent.projectId !== projectId) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    return agent;
  };

  // ── Teammate trust grants ──────────────────────────────────────────────────
  //
  // The durable record of "yes, these two may work together without asking me
  // each time". Granting resolves the target's current profile fingerprint
  // server-side and stores it, so a grant always describes the teammate the
  // user was actually looking at; a later profile change re-prompts instead of
  // riding the old decision.

  app.get("/api/projects/:projectId/teammate-trust", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return { version: 1 as const, projectId, grants: teammateTrust.listForProject(projectId) };
  });

  app.post("/api/projects/:projectId/teammate-trust", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = CreateTeammateTrustGrantSchema.parse(request.body);
    const target = agents.get(body.targetAgentId);
    if (!target || target.projectId !== projectId) throw new ApiError(404, "Teammate not found", "NOT_FOUND");
    if (!target.enabled) throw new ApiError(409, "A disabled teammate cannot be trusted", "AGENT_DISABLED");
    if (target.teamId) throw new ApiError(409, "Team teammates coordinate through the team delegation flow", "TEAM_AGENT_REQUIRES_DELEGATION");
    if (body.callerAgentId !== null) {
      const caller = agents.get(body.callerAgentId);
      if (!caller || caller.projectId !== projectId) throw new ApiError(404, "Teammate not found", "NOT_FOUND");
      if (caller.id === target.id) throw new ApiError(409, "A teammate cannot be trusted to ask itself", "SELF_DELEGATION");
    }
    reply.status(201);
    return teammateTrust.grant({
      id: crypto.randomUUID(),
      projectId,
      callerAgentId: body.callerAgentId,
      targetAgentId: target.id,
      targetProfileHash: teammateProfileFingerprint(target, agents.listToolPermissions(target.id)),
      maxDepth: body.maxDepth,
      maxChildren: body.maxChildren,
      createdAt: new Date().toISOString(),
    });
  });

  app.delete("/api/projects/:projectId/teammate-trust/:grantId", async (request, reply) => {
    const { projectId, grantId } = request.params as { projectId: string; grantId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    if (!teammateTrust.revoke(projectId, grantId, new Date().toISOString())) {
      throw new ApiError(404, "Trust grant not found", "NOT_FOUND");
    }
    reply.status(204).send();
  });

  app.get("/api/agents/:agentId/tool-permissions", async (request) => {
    return agents.listToolPermissions(scopedToolPermissionAgent(request).id);
  });

  app.put("/api/agents/:agentId/tool-permissions", async (request, reply) => {
    const agent = scopedToolPermissionAgent(request);
    const body = UpsertToolPermissionSchema.parse(request.body);
    reply.status(200);
    return agents.upsertToolPermission(agent.id, body);
  });

  app.delete("/api/agents/:agentId/tool-permissions/:toolName", async (request, reply) => {
    const { agentId, toolName } = request.params as { agentId: string; toolName: string };
    const agent = scopedToolPermissionAgent(request);
    const { confirmDefault } = z.object({ confirmDefault: z.string().optional() }).parse(request.query);
    try {
      const deleted = agents.deleteToolPermission(agent.id, toolName, { permitDefaultRestore: confirmDefault === "true" });
      if (!deleted) throw new ApiError(404, "Tool permission not found", "NOT_FOUND");
    } catch (error) {
      if (error instanceof SoleExplicitAllowRuleError) {
        throw new ApiError(409, error.message, error.code);
      }
      throw error;
    }
    reply.status(204).send();
  });

  // ── Agent Skill Access ─────────────────────────────────────────────────────

  app.get("/api/agents/:agentId/skill-access", async (request) => {
    return agents.listSkillAccess(scopedToolPermissionAgent(request).id);
  });

  app.put("/api/agents/:agentId/skill-access", async (request, reply) => {
    const agent = scopedToolPermissionAgent(request);
    const body = UpsertSkillAccessSchema.parse(request.body);
    reply.status(200);
    return agents.upsertSkillAccess(agent.id, body);
  });

  app.delete("/api/agents/:agentId/skill-access/:skillId", async (request, reply) => {
    const { skillId } = request.params as { skillId: string };
    const agent = scopedToolPermissionAgent(request);
    if (!agents.deleteSkillAccess(agent.id, skillId)) throw new ApiError(404, "Skill access not found", "NOT_FOUND");
    reply.status(204).send();
  });

  // ── Teams ────────────────────────────────────────────────────────────────
  // Only one preset is offered in this slice: "research_and_verify" — a
  // Researcher (read-only, bounded sources) and a Verifier (inspects the
  // Researcher's output, writes only approved artifacts). Instantiating a
  // team means materializing this preset's two agents with their policy,
  // not free-form team authoring.

  app.post("/api/projects/:projectId/teams", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = CreateTeamFromPresetSchema.parse(request.body);
    const { team, researcher, verifier } = createResearchAndVerifyTeam(deps.db, projectId, body.name);
    reply.status(201);
    return { team, members: [researcher, verifier] };
  });

  app.get("/api/projects/:projectId/teams", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return teams.listByProject(projectId);
  });

  app.get("/api/projects/:projectId/teams/:teamId", async (request) => {
    const { projectId, teamId } = request.params as { projectId: string; teamId: string };
    const team = teams.get(teamId);
    if (!team || team.projectId !== projectId) throw new ApiError(404, "Team not found", "NOT_FOUND");
    const members = teams.listMembers(teamId).map((m) => agents.get(m.agentId)).filter(Boolean);
    return { team, members };
  });

  app.post("/api/projects/:projectId/teams/:teamId/archive", async (request) => {
    const { projectId, teamId } = request.params as { projectId: string; teamId: string };
    const team = teams.get(teamId);
    if (!team || team.projectId !== projectId) throw new ApiError(404, "Team not found", "NOT_FOUND");
    return teams.setStatus(teamId, "archived", new Date().toISOString());
  });

  // ── Delegation & handoff ─────────────────────────────────────────────────
  // Every field that could widen authority (status, budget, allowedTools,
  // allowedMemoryScopes, approvalRequired) is computed here from the
  // team/agent policy — CreateDelegationSchema has no such fields, so a
  // client cannot submit them even by accident.

  app.post("/api/tasks/:taskId/delegations", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const parent = tasks.getTaskById(taskId);
    if (!parent) throw new ApiError(404, "Task not found", "NOT_FOUND");
    const body = CreateDelegationSchema.parse(request.body);

    const team = teams.get(body.teamId);
    if (!team || team.projectId !== parent.projectId) throw new ApiError(404, "Team not found in this project", "NOT_FOUND");
    if (team.status !== "active") {
      throw new ApiError(409, `Team is ${team.status}; activate it before delegating work`, "TEAM_NOT_ACTIVE");
    }
    const agent = agents.get(body.agentId);
    const isMember = teams.listMembers(body.teamId).some((m) => m.agentId === body.agentId);
    if (!agent || agent.projectId !== parent.projectId || !isMember) {
      throw new ApiError(404, "Agent not found on this team", "NOT_FOUND");
    }
    if (!agent.enabled) {
      throw new ApiError(409, "Agent is disabled", "AGENT_DISABLED");
    }

    // Effective policy = intersection of team defaults and the agent's own
    // ceiling — never wider than either. Numeric budgets take the tighter
    // (non-null) bound; a null on either side means "no ceiling from that
    // side", not "unlimited" (the other side's bound still applies).
    const tighter = (a: number | null, b: number | null) =>
      a === null ? b : b === null ? a : Math.min(a, b);
    // Reads and writes are intersected separately. "none" shares nothing;
    // "read" shares read access only — team memory never becomes writable
    // through delegation, whatever the member's standing write scopes say.
    const withoutTeam = <T>(scopes: readonly T[]): T[] => scopes.filter((s) => s !== "team");
    const allowedMemoryScopes = team.sharedMemoryPolicy === "none"
      ? withoutTeam(agent.memoryReadScopes)
      : [...agent.memoryReadScopes];
    const allowedWriteMemoryScopes = team.sharedMemoryPolicy === "none" || team.sharedMemoryPolicy === "read"
      ? withoutTeam(agent.memoryWriteScopes)
      : [...agent.memoryWriteScopes];
    const allowedTools = agents.listToolPermissions(agent.id).filter((p) => p.effect === "allow").map((p) => p.toolName);

    const now = new Date().toISOString();
    const delegation = delegations.create({
      id: crypto.randomUUID(),
      parentTaskId: parent.id,
      teamId: team.id,
      agentId: agent.id,
      objective: body.objective,
      acceptanceCriteria: body.acceptanceCriteria,
      contextSnapshotRef: `task:${parent.id}`,
      allowedTools,
      allowedMemoryScopes,
      allowedWriteMemoryScopes,
      providerId: agent.providerOverride ?? null,
      model: agent.modelOverride ?? null,
      budget: {
        maxProviderCalls: tighter(agent.maxProviderCalls, team.defaultMaxProviderCalls),
        maxTokenBudget: tighter(agent.maxTokenBudget, team.defaultMaxTokenBudget),
        maxWallClockMs: tighter(agent.maxWallClockMs, team.defaultMaxWallClockMs),
      },
      approvalRequired: agent.approvalRequired || team.defaultApprovalRequired,
      deadlineAt: body.deadlineAt ?? null,
      correlationId: crypto.randomUUID(),
      createdAt: now,
    });
    reply.status(201);
    return delegation;
  });

  app.get("/api/tasks/:taskId/delegations", async (request) => {
    const { taskId } = request.params as { taskId: string };
    if (!tasks.getTaskById(taskId)) throw new ApiError(404, "Task not found", "NOT_FOUND");
    return delegations.listByParentTask(taskId);
  });

  app.get("/api/delegations/:delegationId", async (request) => {
    const { delegationId } = request.params as { delegationId: string };
    const { parentTaskId } = DelegationAccessContextSchema.parse(request.query);
    const { delegation } = requireDelegationContext(delegationId, parentTaskId);
    return { delegation, handoff: handoffs.getByDelegation(delegationId) ?? null };
  });

  app.post("/api/delegations/:delegationId/resolve", async (request, reply) => {
    const { delegationId } = request.params as { delegationId: string };
    const body = ResolveDelegationSchema.parse(request.body);
    const { delegation, parent, team } = requireDelegationContext(delegationId, body.parentTaskId);
    // Idempotency guard: a replayed/duplicate resolve (e.g. after a crash and
    // restart retrying the same request) must never spawn a second child or
    // silently re-resolve an already-decided delegation.
    if (delegation.status !== "pending_approval") {
      throw new ApiError(409, `Delegation is already ${delegation.status}`, "ALREADY_RESOLVED");
    }
    const now = new Date().toISOString();

    if (body.decision === "reject") {
      return delegations.reject(delegationId, now);
    }
    // The team's defaultConcurrencyLimit is a real invariant: starts beyond
    // the limit are refused with a named rule rather than silently
    // interleaving members whose ownership was never proven concurrent-safe.
    const concurrencyLimit = Math.max(1, team.defaultConcurrencyLimit ?? 1);
    const runningRow = deps.db.prepare(
      "SELECT COUNT(*) AS n FROM delegations WHERE team_id=? AND status='running'",
    ).get(delegation.teamId) as { n: number };
    if (runningRow.n >= concurrencyLimit) {
      throw new ApiError(409, `Team already has ${runningRow.n} running delegation${runningRow.n === 1 ? "" : "s"}; cancel one before starting another`, "TEAM_CONCURRENCY_LIMIT");
    }
    // Persist the running delegation before starting the child. This closes the
    // race where execution could observe an unscoped team agent between spawn
    // and approval, and makes restart/recovery resolve the same policy row.
    // The approve-time target fingerprint binds the child the same way
    // ask_teammate binds its spawns: a profile that changes after the user
    // approves is cancelled at execution start instead of silently running.
    const approvedFor = agents.get(delegation.agentId);
    const targetProfileHash = approvedFor
      ? teammateProfileFingerprint(approvedFor, agents.listToolPermissions(approvedFor.id))
      : undefined;
    // A failure between "child spawned (deferred)" and "delegation marked
    // running" must not strand an orphaned bundle: remove the unstarted child
    // and its shell conversation before surfacing the error. The delegation
    // idempotency key makes a crash-retry land on the same child instead of
    // forking a second one.
    let spawned: ReturnType<typeof spawnAgentChatSubagent> | undefined;
    try {
      spawned = spawnAgentChatSubagent(parent, delegation.agentId, delegation.objective, {
        deferRun: true,
        delegationId,
        ...(targetProfileHash ? { targetProfileHash } : {}),
      });
      const started = delegations.approveAndStart(delegationId, spawned.task.id, now);
      if (!started || started.status !== "running" || started.childTaskId !== spawned.task.id) {
        throw new ApiError(409, "Delegation could not be started", "START_CONFLICT");
      }
    } catch (error) {
      if (spawned && !spawned.replayed) {
        const shell = deps.db.prepare(
          "SELECT conversation_id FROM conversation_messages WHERE task_id=? ORDER BY rowid ASC LIMIT 1",
        ).get(spawned.task.id) as { conversation_id?: string } | undefined;
        if (shell?.conversation_id) {
          cleanupUnstartedChild(deps.db, parent.projectId, spawned.task.id, shell.conversation_id);
        }
      }
      throw error;
    }
    deps.runner.run(spawned.task.id);
    return delegations.get(delegationId);
  });

  // Parent cancellation propagates to the actual child task, not just the
  // delegation row — the child stops or parks safely and both sides leave
  // an inspectable final state.
  app.post("/api/delegations/:delegationId/cancel", async (request) => {
    const { delegationId } = request.params as { delegationId: string };
    const { parentTaskId } = DelegationAccessContextSchema.parse(request.body);
    const { delegation } = requireDelegationContext(delegationId, parentTaskId);
    if (delegation.childTaskId) {
      deps.runner.cancel(delegation.childTaskId);
    }
    return delegations.cancel(delegationId, new Date().toISOString());
  });

  // A handoff is durable proof, never a model's prose alone: the caller must
  // supply acceptanceCriteriaStatus/artifactRefs/verificationEvidence as real
  // fields, which the parent then inspects — not chat text saying "done".
  app.post("/api/delegations/:delegationId/handoff", async (request, reply) => {
    const { delegationId } = request.params as { delegationId: string };
    const body = CreateHandoffSchema.parse(request.body);
    const { delegation, parent, child } = requireDelegationContext(delegationId, body.parentTaskId);
    if (delegation.status !== "running") {
      throw new ApiError(409, `Delegation is ${delegation.status}; a handoff can only be recorded while running`, "CONFLICT");
    }
    if (!child) throw new ApiError(409, "Delegation has no running child task", "INTEGRITY_ERROR");

    const statusesByCriterion = new Map(body.acceptanceCriteriaStatus.map((status) => [status.criterion, status]));
    const criteriaComplete = delegation.acceptanceCriteria.length === body.acceptanceCriteriaStatus.length
      && statusesByCriterion.size === body.acceptanceCriteriaStatus.length
      && delegation.acceptanceCriteria.every((criterion) => statusesByCriterion.get(criterion)?.met === true);
    if (!criteriaComplete) {
      throw new ApiError(400, "Handoff acceptance criteria do not match the delegation", "HANDOFF_PROOF_INVALID");
    }

    if (!body.verificationEvidence?.trim() || body.artifactRefs.length === 0) {
      throw new ApiError(400, "Handoff requires verification evidence and at least one artifact", "HANDOFF_PROOF_INVALID");
    }
    const evidence = records.listEvidence(child.id);
    const artifactProof = body.artifactRefs.every((artifact) => evidence.some((entry) =>
      entry.path === artifact.path && entry.metadata.contentHash === artifact.contentHash));
    if (!artifactProof) {
      throw new ApiError(400, "Handoff artifacts do not match durable child-task evidence", "HANDOFF_PROOF_INVALID");
    }

    if (body.targetAgentId) {
      const target = agents.get(body.targetAgentId);
      const targetMember = teams.listMembers(delegation.teamId).some((member) => member.agentId === body.targetAgentId);
      if (!target || target.projectId !== parent.projectId || target.teamId !== delegation.teamId || !target.enabled || !targetMember) {
        throw new ApiError(404, "Handoff target agent is not a valid member of this team", "TARGET_AGENT_INVALID");
      }
    }

    const now = new Date().toISOString();
    const handoff = deps.db.transaction(() => {
      const created = handoffs.create({
        id: crypto.randomUUID(),
        delegationId,
        taskId: delegation.childTaskId!,
        resultSummary: body.resultSummary,
        acceptanceCriteriaStatus: body.acceptanceCriteriaStatus.map((c) => ({ ...c, note: c.note ?? null })),
        artifactRefs: body.artifactRefs,
        verificationEvidence: body.verificationEvidence ?? null,
        unresolvedRisks: body.unresolvedRisks,
        sourceAgentId: delegation.agentId,
        targetAgentId: body.targetAgentId ?? null,
        createdAt: now,
      });
      const completed = delegations.complete(delegationId, now);
      if (!completed || completed.status !== "completed") throw new ApiError(409, "Delegation completion could not be committed", "COMMIT_CONFLICT");
      return created;
    })();
    reply.status(201);
    return handoff;
  });

  // ── Assistant profile ────────────────────────────────────────────────────
  // Single local, cross-project profile (see docs/decisions/0012). Goals are
  // user-authored, direct writes; a model-suggested fact never lands here —
  // it becomes a candidate memory_entries row requiring explicit approval.

  app.get("/api/assistant-profile", async () => assistantProfile.get());

  app.patch("/api/assistant-profile", async (request) => {
    const body = UpdateAssistantProfileSchema.parse(request.body);
    return assistantProfile.update(body, new Date().toISOString());
  });

  app.post("/api/assistant-profile/goals", async (request, reply) => {
    const body = CreateAssistantGoalSchema.parse(request.body);
    const updated = assistantProfile.addGoal({ id: crypto.randomUUID(), text: body.text, enabled: body.enabled }, new Date().toISOString());
    reply.status(201);
    return updated;
  });

  app.patch("/api/assistant-profile/goals/:goalId", async (request) => {
    const { goalId } = request.params as { goalId: string };
    const body = z.object({ enabled: z.boolean() }).parse(request.body);
    return assistantProfile.setGoalEnabled(goalId, body.enabled, new Date().toISOString());
  });

  app.delete("/api/assistant-profile/goals/:goalId", async (request) => {
    const { goalId } = request.params as { goalId: string };
    return assistantProfile.removeGoal(goalId, new Date().toISOString());
  });

  // The onboarding "run a safe deterministic sample task" step — the whole
  // Researcher -> Verifier -> handoff loop, local and no-network. See
  // mission/readme-summary-sample.ts for what it actually proves.
  app.post("/api/projects/:projectId/sample-tasks/readme-summary", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    try {
      const result = runReadmeSummarySample({ db: deps.db, projectId, workspacePath: project.workspacePath });
      reply.status(201);
      return result;
    } catch (error) {
      if (error instanceof ReadmeSummarySampleError) {
        throw new ApiError(422, error.message, error.code);
      }
      throw error;
    }
  });

  app.post("/api/projects/:projectId/tasks/inspect-workspace", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");

    const idempotencyKey = readIdempotencyKey(request);
    const links = (id: string) => ({
      taskId: id,
      projectId,
      aggregateUrl: `/api/tasks/${id}`,
      eventHistoryUrl: `/api/tasks/${id}/events`,
      sseUrl: `/api/tasks/${id}/events/stream`,
    });

    // Idempotent replay: a repeated request with the same key returns the
    // original task (200) instead of starting a second inspection.
    if (idempotencyKey) {
      const existing = tasks.findByIdempotencyKey(projectId, idempotencyKey);
      if (existing) {
        reply.status(200);
        return { ...links(existing.id), status: existing.status, replayed: true };
      }
    }

    const task = tasks.createTask({
      id: crypto.randomUUID(),
      projectId,
      kind: "inspect_workspace",
      status: "queued",
      ...(idempotencyKey ? { idempotencyKey } : {}),
      createdAt: new Date().toISOString(),
    });

    deps.runner.run(task.id);
    reply.status(202);
    return { ...links(task.id), status: task.status };
  });

  app.get("/api/projects/:projectId/tasks", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    return tasks.listTasksByProject(projectId);
  });

  app.get("/api/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");
    const agg = records.getAggregate(taskId);
    const toolCalls = convs.listToolCallsForTask(taskId).map((call) => ({
      ...call,
      argsJson: redactJsonText(call.argsJson) ?? "{}",
      resultJson: call.resultJson === null || call.resultJson === undefined ? call.resultJson : redactJsonText(call.resultJson) ?? "null",
    }));
    const routing = routingRepo.get(taskId)?.decision ?? null;
    const latestSummary = contextSummariesRepo.latestForTask(taskId);
    const context = contextUsageFromEvents(agg.events, latestSummary);
    const reasoningApplication = reasoningApplicationFromEvents(agg.events);
    return { ...agg, toolCalls, approvals: approvals.listByTask(taskId), integrations: integrationsRepo.listByTask(taskId), context, routing, reasoningApplication };
  });

  app.get("/api/tasks/:taskId/events", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const { after } = request.query as { after?: string };
    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");

    if (after === undefined) return records.listEvents(taskId);
    return records.listEventsAfter(taskId, parseEventCursor(after));
  });

  app.get("/api/tasks/:taskId/events/stream", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    
    const lastEventIdHeader = request.headers["last-event-id"] as string | undefined;
    const afterQuery = (request.query as any).after as string | undefined;
    
    let afterSeq = 0;
    const cursorRaw = lastEventIdHeader ?? afterQuery;
    
    if (cursorRaw !== undefined) {
      afterSeq = parseEventCursor(cursorRaw);
    }

    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    let isClosed = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeLive: (() => void) | undefined;

    const detach = () => {
      unsubscribeLive?.();
      unsubscribeLive = undefined;
    };

    request.raw.on("close", () => {
      isClosed = true;
      if (timeoutId) clearTimeout(timeoutId);
      detach();
    });

    const sendEvent = (event: any) => {
      reply.raw.write(`id: ${event.sequence}\n`);
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Ephemeral frames deliberately carry no `id`, so they never advance the
    // client's resume cursor: there is nothing stored to resume from. They
    // exist so a model's reasoning can be watched as it happens without being
    // written to task_events. See execution/live-bus.ts.
    unsubscribeLive = liveBus.subscribe(taskId, (event: EphemeralEvent) => {
      if (isClosed) return;
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify({ type: event.type, payload: event.payload, ephemeral: true })}\n\n`);
    });

    const pollEvents = async () => {
      if (isClosed) return;
      
      const newEvents = records.listEventsAfter(taskId, afterSeq);
      
      for (const e of newEvents) {
        sendEvent(e);
        afterSeq = e.sequence;
        if (["task.verified", "task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(e.type)) {
          reply.raw.end();
          return;
        }
      }

      const currentTask = tasks.getTaskById(taskId);
      if (currentTask && ["verified", "completed", "failed", "cancelled", "interrupted"].includes(currentTask.status) && newEvents.length === 0) {
        reply.raw.end();
        return;
      }

      timeoutId = setTimeout(pollEvents, deps.sseIntervalMs ?? 100);
    };

    pollEvents();
  });

  // Zero-setup chat: provision (once) a default project backed by a
  // server-managed scratch workspace plus a conversation, so the user can start
  // chatting -- and the agent can use tools and skills -- without creating a
  // mission. Idempotent: reuses the existing Quick Chat project/conversation.
  app.post("/api/quick-chat", async () => {
    const scratch = join(resolveMorrowHome(process.env), "scratch");
    mkdirSync(scratch, { recursive: true });
    // realpathSync can transiently fail on a just-created dir on Windows; the
    // raw path is a safe fallback so first use never 500s.
    let workspacePath = scratch;
    try { workspacePath = realpathSync(scratch); } catch {}
    let project = projects.listProjects().find((p) => p.name === "Quick Chat");
    if (!project) {
      project = projects.createProject({
        id: crypto.randomUUID(),
        name: "Quick Chat",
        workspacePath,
        createdAt: new Date().toISOString(),
      });
    }
    let conversation = convs.listConversationsByProject(project.id)[0];
    if (!conversation) {
      conversation = convs.createConversation({
        id: crypto.randomUUID(),
        projectId: project.id,
        title: "Chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return { projectId: project.id, conversationId: conversation.id, workspacePath };
  });

  app.get("/api/projects/:projectId/conversations", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const { includeArchived } = request.query as { includeArchived?: string };
    return convs.listConversationsByProject(projectId, includeArchived === "true" || includeArchived === "1");
  });

  app.get("/api/conversations/:conversationId", async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const conversation = convs.getConversation(conversationId);
    if (!conversation) throw new ApiError(404, "Conversation not found", "NOT_FOUND");
    return conversation;
  });

  app.patch("/api/conversations/:conversationId", async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const conversation = convs.getConversation(conversationId);
    if (!conversation) throw new ApiError(404, "Conversation not found", "NOT_FOUND");
    const body = UpdateConversationSchema.parse(request.body);
    const now = new Date().toISOString();
    let updated = conversation;
    if (body.title !== undefined) updated = convs.renameConversation(conversationId, body.title.trim(), now) ?? updated;
    if (body.archived !== undefined) updated = convs.setArchived(conversationId, body.archived, now) ?? updated;
    if (body.mode !== undefined) {
      if (body.mode === "group" && conversation.agentId) {
        const conductor = agents.get(conversation.agentId);
        if (conductor?.teamId) {
          throw new ApiError(409, "Team agents must be started through the delegation API", "TEAM_AGENT_REQUIRES_DELEGATION");
        }
        if (conductor) conversationParticipants.ensureConductor(conversationId, conversation.projectId, conductor, now);
      }
      updated = convs.setMode(conversationId, body.mode, now) ?? updated;
    }
    return updated;
  });

  app.post("/api/projects/:projectId/conversations", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    
    const body = CreateConversationSchema.parse(request.body ?? {});
    const title = body?.title?.trim() || DEFAULT_CONVERSATION_TITLE;
    // A thread belongs to one teammate for its whole life. Validate the
    // binding here, once, so no later dispatch has to re-establish that the
    // agent is real, enabled, and owned by this project.
    if (body.agentId) {
      const agent = agents.get(body.agentId);
      if (!agent || agent.projectId !== projectId) throw new ApiError(404, "Agent not found in this project", "NOT_FOUND");
      if (!agent.enabled) throw new ApiError(409, "Agent is disabled", "AGENT_DISABLED");
      if (body.mode === "group" && agent.teamId) {
        throw new ApiError(409, "Team agents must be started through the delegation API", "TEAM_AGENT_REQUIRES_DELEGATION");
      }
    }

    const conversation = convs.createConversation({
      id: crypto.randomUUID(),
      projectId,
      title,
      agentId: body.agentId ?? null,
      mode: body.mode ?? "single",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    reply.status(201);
    return conversation;
  });

  const ownedConversation = (projectId: string, conversationId: string) => {
    const conversation = convs.getConversation(conversationId);
    if (!conversation || conversation.projectId !== projectId) {
      throw new ApiError(404, "Conversation not found in project", "NOT_FOUND");
    }
    return conversation;
  };

  const ownedConversationTask = (projectId: string, conversationId: string, taskId: string) => {
    ownedConversation(projectId, conversationId);
    const task = tasks.getTaskById(taskId);
    const assistant = deps.db.prepare(
      "SELECT id FROM conversation_messages WHERE conversation_id=? AND task_id=? AND role='assistant' LIMIT 1"
    ).get(conversationId, taskId);
    if (!task || task.projectId !== projectId || !assistant) {
      throw new ApiError(404, "Conversation task not found in project", "NOT_FOUND");
    }
    return task;
  };

  const conversationParticipants = conversationsParticipantsRepository(deps.db);
  const conversationContextRefs = conversationContextRefsRepository(deps.db);
  const projectConversationParticipants = (projectId: string, conversationId: string, includeRemoved = true) => {
    const conversation = ownedConversation(projectId, conversationId);
    if (conversation.mode !== "group") {
      throw new ApiError(409, "Participants are available only for group conversations", "GROUP_MODE_REQUIRED");
    }
    const participants = conversationParticipants.list(conversationId, includeRemoved);
    if (conversation.agentId && !participants.some((participant) => participant.agentId === conversation.agentId && participant.role === "conductor")) {
      const conductor = agents.get(conversation.agentId);
      if (conductor) participants.unshift(conversationParticipants.ensureConductor(conversationId, projectId, conductor, conversation.createdAt));
    } else if (!conversation.agentId && !participants.some((participant) => participant.role === "conductor")) {
      participants.unshift(conversationParticipants.defaultConductor(conversationId));
    }
    participants.sort((left, right) => left.position - right.position || left.joinedAt.localeCompare(right.joinedAt) || left.id.localeCompare(right.id));
    return ConversationParticipantsSchema.parse({
      version: 1,
      projectId,
      conversationId,
      conductorAgentId: conversation.agentId,
      participants,
    });
  };

  const ensureGroupConductor = (conversation: Conversation, now: string) => {
    if (conversation.agentId) {
      const conductor = agents.get(conversation.agentId);
      if (conductor?.teamId) {
        throw new ApiError(409, "Team agents must be started through the delegation API", "TEAM_AGENT_REQUIRES_DELEGATION");
      }
      if (conductor) conversationParticipants.ensureConductor(conversation.id, conversation.projectId, conductor, now);
    }
  };

  const webRouting = (decision: RoutingDecision | null | undefined) => decision
    ? {
        version: decision.version,
        presetId: decision.presetId,
        providerId: decision.providerId,
        model: decision.model,
        fallbackUsed: decision.fallbackUsed,
        overridden: decision.overridden,
        mode: decision.mode ?? null,
        autoApprove: decision.autoApprove ?? null,
        privacyMode: decision.privacyMode ?? null,
      }
    : null;

  const webMessages = (conversationId: string) => convs.listMessages(conversationId).map((message) => {
    const task = message.taskId ? tasks.getTaskById(message.taskId) : undefined;
    const routing = message.taskId ? webRouting(routingRepo.get(message.taskId)?.decision) : null;
    const toolActivity = message.taskId
      ? convs.listToolCallsForMessage(message.id).map((tool) => ({
          id: tool.id,
          toolName: tool.toolName,
          status: tool.status,
          startedAt: tool.startedAt ?? null,
          completedAt: tool.completedAt ?? null,
        }))
      : [];
    return {
      ...message,
      taskStatus: task?.status ?? null,
      routing,
      toolActivity,
    };
  });

  app.get("/api/projects/:projectId/conversations/:conversationId", async (request) => {
    const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
    return ownedConversation(projectId, conversationId);
  });

  app.get("/api/projects/:projectId/conversations/:conversationId/messages", async (request) => {
    const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
    ownedConversation(projectId, conversationId);
    return webMessages(conversationId);
  });

  // Group participant management is a projection/mutation over the same
  // conversation row that owns the conductor. Participant rows retain the
  // identity snapshot and policy fingerprint from invitation time; dispatch
  // still resolves current agent policy from agents/tasks and never trusts a
  // browser-provided snapshot.
  app.get("/api/projects/:projectId/conversations/:conversationId/participants", async (request) => {
    const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
    const { includeRemoved } = request.query as { includeRemoved?: string };
    return projectConversationParticipants(projectId, conversationId, includeRemoved === "true" || includeRemoved === "1");
  });

  app.post("/api/projects/:projectId/conversations/:conversationId/participants", async (request, reply) => {
    const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
    const conversation = ownedConversation(projectId, conversationId);
    if (conversation.mode !== "group") throw new ApiError(409, "Participants are available only for group conversations", "GROUP_MODE_REQUIRED");
    const body = InviteConversationParticipantSchema.parse(request.body);
    if (body.agentId === conversation.agentId) throw new ApiError(409, "The conductor is already part of this conversation", "CONDUCTOR_ALREADY_PARTICIPANT");
    const agent = agents.get(body.agentId);
    if (!agent || agent.projectId !== projectId) throw new ApiError(404, "Agent not found in this project", "NOT_FOUND");
    if (!agent.enabled) throw new ApiError(409, "Agent is disabled", "AGENT_DISABLED");
    if (agent.teamId) {
      throw new ApiError(409, "Team agents must be started through the delegation API", "TEAM_AGENT_REQUIRES_DELEGATION");
    }
    const now = new Date().toISOString();
    const outcome = conversationParticipants.invite({ conversationId, projectId, agent, now });
    if (outcome.outcome === "already_active") throw new ApiError(409, "This teammate is already a participant", "PARTICIPANT_ALREADY_ACTIVE");
    if (outcome.outcome === "conductor") throw new ApiError(409, "The conductor cannot be invited as a participant", "CONDUCTOR_ALREADY_PARTICIPANT");
    if (outcome.outcome === "team_agent") throw new ApiError(409, "Team agents must be started through the delegation API", "TEAM_AGENT_REQUIRES_DELEGATION");
    if (outcome.outcome === "not_found") throw new ApiError(404, "Participant could not be created", "NOT_FOUND");
    reply.status(outcome.outcome === "reactivated" ? 200 : 201);
    return outcome.participant;
  });

  app.patch("/api/projects/:projectId/conversations/:conversationId/participants/:agentId", async (request) => {
    const { projectId, conversationId, agentId } = request.params as { projectId: string; conversationId: string; agentId: string };
    const conversation = ownedConversation(projectId, conversationId);
    if (conversation.mode !== "group") throw new ApiError(409, "Participants are available only for group conversations", "GROUP_MODE_REQUIRED");
    const body = ReorderConversationParticipantSchema.parse(request.body);
    if (agentId === conversation.agentId) throw new ApiError(409, "The conductor stays first", "CONDUCTOR_CANNOT_MOVE");
    const updated = conversationParticipants.reorder(conversationId, agentId, body.position, new Date().toISOString());
    if (!updated) throw new ApiError(404, "Participant not found in this conversation", "NOT_FOUND");
    return updated;
  });

  app.delete("/api/projects/:projectId/conversations/:conversationId/participants/:agentId", async (request) => {
    const { projectId, conversationId, agentId } = request.params as { projectId: string; conversationId: string; agentId: string };
    const conversation = ownedConversation(projectId, conversationId);
    if (conversation.mode !== "group") throw new ApiError(409, "Participants are available only for group conversations", "GROUP_MODE_REQUIRED");
    if (agentId === conversation.agentId) throw new ApiError(409, "The conductor cannot be removed from its conversation", "CONDUCTOR_CANNOT_BE_REMOVED");
    const outcome = conversationParticipants.remove(conversationId, agentId, new Date().toISOString());
    if (outcome.outcome === "not_found") throw new ApiError(404, "Participant not found in this conversation", "NOT_FOUND");
    if (outcome.outcome === "conductor") throw new ApiError(409, "The conductor cannot be removed from its conversation", "CONDUCTOR_CANNOT_BE_REMOVED");
    if (outcome.outcome === "team_agent") throw new ApiError(409, "Team agents must be started through the delegation API", "TEAM_AGENT_REQUIRES_DELEGATION");
    return outcome.participant;
  });

  app.get("/api/projects/:projectId/conversations/:conversationId/tasks/:taskId/reasoning", async (request, reply) => {
    const { projectId, conversationId, taskId } = request.params as { projectId: string; conversationId: string; taskId: string };
    ownedConversationTask(projectId, conversationId, taskId);
    reply.header("cache-control", "no-store");
    return WebTaskReasoningSchema.parse({
      version: 1,
      taskId,
      providerSupplied: true,
      entries: executionContinuityRepo.listProviderReasoning(taskId),
    });
  });

  app.get("/api/projects/:projectId/conversations/:conversationId/activity", async (request) => {
    const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
    ownedConversation(projectId, conversationId);
    const taskRows = deps.db.prepare(
      `SELECT DISTINCT message.task_id AS taskId, message.created_at AS createdAt, message.id AS messageId
         FROM conversation_messages message
        WHERE message.conversation_id = ? AND message.task_id IS NOT NULL
        ORDER BY message.created_at ASC, message.id ASC`,
    ).all(conversationId) as Array<{ taskId: string; createdAt: string; messageId: string }>;
    return projectConversationActivity({
      projectId,
      conversationId,
      tasks: taskRows.map((row) => ({
        taskId: row.taskId,
        events: records.listEvents(row.taskId),
      })),
    });
  });

  app.get("/api/projects/:projectId/conversations/:conversationId/support-bundle", async (request) => {
    const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
    ownedConversation(projectId, conversationId);
    const taskRows = deps.db.prepare(
      `SELECT DISTINCT message.task_id AS taskId
         FROM conversation_messages message
        WHERE message.conversation_id = ? AND message.task_id IS NOT NULL
        ORDER BY message.created_at ASC, message.id ASC`,
    ).all(conversationId) as Array<{ taskId: string }>;
    const activity = projectConversationActivity({
      projectId,
      conversationId,
      tasks: taskRows.map((row) => ({ taskId: row.taskId, events: records.listEvents(row.taskId) })),
    });
    const tasks = taskRows.map(({ taskId }) => {
      const aggregate = records.getAggregate(taskId);
      const routing = routingRepo.get(taskId)?.decision ?? null;
      const disclosure = aggregate.disclosure;
      return {
        taskId,
        status: aggregate.task.status,
        createdAt: aggregate.task.createdAt,
        updatedAt: aggregate.task.updatedAt,
        eventCount: aggregate.events.length,
        evidenceCount: aggregate.evidence.length,
        providerId: routing?.providerId ?? disclosure?.provider ?? null,
        model: routing?.model ?? null,
        privacyMode: routing?.privacyMode ?? null,
        fallbackUsed: routing?.fallbackUsed ?? false,
        verificationStatus: aggregate.verification?.status === "verified" ? "verified" as const : null,
        disclosure: disclosure ? {
          provider: disclosure.provider,
          networkAccess: disclosure.networkAccess,
          filesystemAccess: disclosure.filesystemAccess,
          shellExecution: disclosure.shellExecution,
          modelInvocation: disclosure.modelInvocation,
        } : null,
      };
    });
    return WebConversationSupportBundleSchema.parse({
      version: 1,
      projectId,
      conversationId,
      generatedAt: new Date().toISOString(),
      tasks,
      entries: activity.entries,
      privacyNotice: "This bundle contains redacted activity summaries and execution facts. It excludes raw task events, tool arguments and results, prompts, secrets, and private model reasoning.",
    });
  });

  /**
   * One step's recorded output, behind the transcript row that ran it.
   * Scoped to the conversation on purpose: an evidence id from another task is
   * a scope violation, not an empty result, and 404s as one.
   */
  app.get("/api/projects/:projectId/conversations/:conversationId/tasks/:taskId/evidence/:toolCallId", async (request, reply) => {
    const { projectId, conversationId, taskId, toolCallId } = request.params as {
      projectId: string; conversationId: string; taskId: string; toolCallId: string;
    };
    ownedConversationTask(projectId, conversationId, taskId);
    const evidence = projectToolEvidence({ db: deps.db, taskId, toolCallId });
    if (!evidence) throw new ApiError(404, "Evidence not found for this step", "NOT_FOUND");
    reply.header("cache-control", "no-store");
    return evidence;
  });

  /**
   * The handoffs visible in this thread: work started here and given to
   * another teammate. Read-only projection over the child tasks themselves,
   * safe to poll while a handoff is in flight.
   */
  app.get("/api/projects/:projectId/conversations/:conversationId/handoffs", async (request) => {
    const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
    ownedConversation(projectId, conversationId);
    return projectThreadHandoffs({ db: deps.db, projectId, conversationId });
  });

  /**
   * Hand a piece of this thread's work to another teammate.
   *
   * The child runs as a real delegated task through the same path the
   * subagent API uses, so it gets provider routing, agent-state events, and —
   * critically — its OWN policy: `buildAgentExecutionPolicy` computes its
   * tools, memory scopes and budget from that agent's durable row, not from
   * this thread's. Nothing in the request can widen that; the only thing the
   * caller supplies is the objective.
   *
   * An agent on a team is deliberately refused here. Team members carry a
   * team-level policy that only the delegation API intersects correctly, and
   * routing them through this simpler path would run them under a policy that
   * skipped their team's ceiling.
   */
  app.post("/api/projects/:projectId/conversations/:conversationId/handoffs", async (request, reply) => {
    const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
    const conversation = ownedConversation(projectId, conversationId);
    const body = CreateThreadHandoffSchema.parse(request.body);
    const parent = ownedConversationTask(projectId, conversationId, body.parentTaskId);

    try {
      conversationContextRefs.validateSourceRefs(projectId, parent.id, body.contextRefs);
    } catch (error) {
      if (error instanceof ConversationContextRefError) throw new ApiError(404, error.message, error.code);
      throw error;
    }

    const agent = agents.get(body.agentId);
    if (!agent || agent.projectId !== projectId) throw new ApiError(404, "Agent not found in this project", "NOT_FOUND");
    if (!agent.enabled) throw new ApiError(409, "Agent is disabled", "AGENT_DISABLED");
    if (conversation.mode === "group" && agent.id !== conversation.agentId) {
      const participant = conversationParticipants.get(conversation.id, agent.id);
      if (!participant || participant.status !== "active" || participant.role !== "participant") {
        throw new ApiError(409, "Invite this teammate to the shared thread before handing off work", "AGENT_NOT_PARTICIPANT");
      }
    }
    if (agent.teamId) {
      throw new ApiError(409, "Team agents must be started through the delegation API", "TEAM_AGENT_REQUIRES_DELEGATION");
    }

    const result = spawnAgentChatSubagent(parent, agent.id, body.objective, {
      ...(body.contextRefs.length > 0 ? { contextRefs: body.contextRefs } : {}),
    });
    reply.status(202);
    return {
      version: 1,
      handoffTaskId: result.task.id,
      agentId: agent.id,
      agentName: agent.name,
    };
  });

  // ── Record mode & routines ───────────────────────────────────────────────
  // "Watch me do this once." A recording is an explicit, opt-in span of one
  // thread; nothing about how the teammate works changes while it is open. The
  // proposal at the end is read back from what actually happened, and creating
  // a routine from it is a separate, explicit act.

  const recordingState = (projectId: string, conversationId: string) => {
    const recording = routines.latestForConversation(conversationId);
    return {
      version: 1 as const,
      recording: recording ?? null,
      proposal: recording && recording.routineId === null
        ? projectRoutineProposal({ db: deps.db, projectId, conversationId, recording })
        : null,
    };
  };

  app.get("/api/projects/:projectId/conversations/:conversationId/recording", async (request) => {
    const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
    ownedConversation(projectId, conversationId);
    return recordingState(projectId, conversationId);
  });

  app.post("/api/projects/:projectId/conversations/:conversationId/recording", async (request, reply) => {
    const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
    const conversation = ownedConversation(projectId, conversationId);
    if (routines.openForConversation(conversationId)) {
      throw new ApiError(409, "This thread is already being recorded", "ALREADY_RECORDING");
    }
    routines.startRecording({
      id: crypto.randomUUID(),
      projectId,
      conversationId,
      agentId: conversation.agentId,
      startedAt: new Date().toISOString(),
    });
    reply.status(201);
    return recordingState(projectId, conversationId);
  });

  app.delete("/api/projects/:projectId/conversations/:conversationId/recording", async (request) => {
    const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
    ownedConversation(projectId, conversationId);
    const open = routines.openForConversation(conversationId);
    if (!open) throw new ApiError(409, "This thread is not being recorded", "NOT_RECORDING");
    routines.stopRecording(open.id, new Date().toISOString());
    return recordingState(projectId, conversationId);
  });

  app.get("/api/projects/:projectId/routines", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return routines.listByProject(projectId);
  });

  app.post("/api/projects/:projectId/routines", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = CreateRoutineSchema.parse(request.body);
    if (body.agentId) {
      const agent = agents.get(body.agentId);
      if (!agent || agent.projectId !== projectId) throw new ApiError(404, "Agent not found in this project", "NOT_FOUND");
    }
    if (body.sourceConversationId) ownedConversation(projectId, body.sourceConversationId);

    const routine = routines.create({
      id: crypto.randomUUID(),
      projectId,
      now: new Date().toISOString(),
      ...body,
      agentId: body.agentId ?? null,
    });
    // Link the recording this came from, so a routine's provenance stays
    // inspectable rather than becoming a free-floating saved prompt.
    if (body.sourceConversationId) {
      const recording = routines.latestForConversation(body.sourceConversationId);
      if (recording) routines.attachRoutine(recording.id, routine.id);
    }
    reply.status(201);
    return routine;
  });

  const updateRoutine = (projectId: string, routineId: string, body: unknown) => {
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const updated = routines.update(
      routineId,
      projectId,
      UpdateRoutineSchema.parse(body),
      new Date().toISOString(),
    );
    if (!updated) throw new ApiError(404, "Routine not found", "NOT_FOUND");
    return updated;
  };

  app.patch("/api/projects/:projectId/routines/:routineId", async (request) => {
    const { projectId, routineId } = request.params as { projectId: string; routineId: string };
    return updateRoutine(projectId, routineId, request.body);
  });

  // Keep the mutation shape aligned with the existing delete/run endpoints for
  // clients that address a routine by id and carry project ownership in JSON.
  app.patch("/api/routines/:routineId", async (request) => {
    const { routineId } = request.params as { routineId: string };
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body.projectId !== "string") {
      throw new ApiError(400, "projectId is required", "VALIDATION_ERROR");
    }
    const { projectId, ...input } = body;
    return updateRoutine(projectId, routineId, input);
  });

  app.delete("/api/routines/:routineId", async (request, reply) => {
    const { routineId } = request.params as { routineId: string };
    const body = z.object({ projectId: z.string().min(1) }).parse(request.body);
    if (!routines.delete(routineId, body.projectId)) throw new ApiError(404, "Routine not found", "NOT_FOUND");
    reply.status(204).send();
  });

  /**
   * Run a routine: a fresh thread for the teammate that learned it, opened
   * with the routine written out as an ordinary instruction.
   *
   * Deliberately NOT a replay of the recorded tool calls. The steps are given
   * as context for how this was done before, and the teammate re-decides each
   * one against the workspace as it is now — replaying captured writes and
   * commands against a workspace that has moved on is a different feature with
   * a different risk profile, and Morrow does not claim to do it.
   */
  app.post("/api/routines/:routineId/run", async (request, reply) => {
    const { routineId } = request.params as { routineId: string };
    const routine = routines.get(routineId);
    if (!routine) throw new ApiError(404, "Routine not found", "NOT_FOUND");
    try {
      const result = dispatchRoutineTask(
        { db: deps.db, runner: deps.runner, env: process.env },
        routine,
      );
      routines.recordRun(routineId, new Date().toISOString());
      reply.status(202);
      return {
        version: 1,
        routineId,
        conversationId: result.conversationId,
        taskId: result.task.id,
        projectId: routine.projectId,
      };
    } catch (error) {
      if (error instanceof AgentTaskDispatchError) throw new ApiError(error.statusCode, error.message, error.code);
      throw error;
    }
  });

  app.patch("/api/projects/:projectId/conversations/:conversationId", async (request) => {
    const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
    let updated = ownedConversation(projectId, conversationId);
    const body = UpdateConversationSchema.parse(request.body);
    const updatedAt = new Date().toISOString();
    if (body.title !== undefined) updated = convs.renameConversation(conversationId, body.title, updatedAt) ?? updated;
    if (body.archived !== undefined) updated = convs.setArchived(conversationId, body.archived, updatedAt) ?? updated;
    if (body.mode !== undefined) {
      if (body.mode === "group") ensureGroupConductor(updated, updatedAt);
      updated = convs.setMode(conversationId, body.mode, updatedAt) ?? updated;
    }
    return updated;
  });

  app.delete("/api/projects/:projectId/conversations/:conversationId", async (request) => {
    const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
    DeleteConversationSchema.parse(request.body ?? {});
    const result = convs.deleteConversation(conversationId, projectId);
    if (result.outcome === "project_mismatch") {
      throw new ApiError(404, "Conversation not found in project", "NOT_FOUND");
    }
    if (result.outcome === "active_task") {
      throw new ApiError(
        409,
        "Stop the active response before deleting this conversation.",
        "CONVERSATION_TASK_ACTIVE",
      );
    }
    return { version: 1, conversationId, deleted: result.outcome === "deleted" };
  });

  app.post("/api/projects/:projectId/conversations/:conversationId/messages", async (request, reply) => {
    const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
    const conversation = ownedConversation(projectId, conversationId);
    const body = SendMessageSchema.parse(request.body);
    // Name the conversation from its opening message, once, and only while the
    // title is still the untouched default. A failure here must never block
    // the message it was named after.
    if (isDefaultConversationTitle(conversation.title)) {
      const derived = deriveConversationTitle(body.content);
      if (derived) {
        try {
          convs.renameConversation(conversationId, derived, new Date().toISOString());
        } catch (error) {
          request.log.warn({ err: error }, "Conversation auto-title failed");
        }
      }
    }
    const idempotencyKey = readIdempotencyKey(request);
    try {
      const result = dispatchAgentTask({ db: deps.db, runner: deps.runner, env: process.env }, {
        conversationId,
        ...body,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      reply.status(result.replayed ? 200 : 202);
      return {
        ...result,
        routing: webRouting(result.routing),
        aggregateUrl: `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
        sseUrl: `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/tasks/${encodeURIComponent(result.task.id)}/stream`,
      };
    } catch (error) {
      if (error instanceof AgentTaskDispatchError) {
        throw new ApiError(error.statusCode, error.message, error.code);
      }
      throw error;
    }
  });

  app.post("/api/projects/:projectId/conversations/:conversationId/tasks/:taskId/cancel", async (request, reply) => {
    const { projectId, conversationId, taskId } = request.params as { projectId: string; conversationId: string; taskId: string };
    const task = ownedConversationTask(projectId, conversationId, taskId);
    if (task.status === "cancelled") {
      return { version: 1, taskId, status: task.status, outcome: "already_cancelled" };
    }
    if (["completed", "verified", "failed", "interrupted"].includes(task.status)) {
      throw new ApiError(409, `Task is ${task.status}; cancellation was not applied.`, "TASK_NOT_ACTIVE");
    }
    deps.runner.cancel(taskId);
    const updated = tasks.getTaskById(taskId);
    reply.status(202);
    return { version: 1, taskId, status: updated?.status ?? "cancelled", outcome: "cancelled" };
  });

  app.post("/api/projects/:projectId/conversations/:conversationId/tasks/:taskId/retry", async (request, reply) => {
    const { projectId, conversationId, taskId } = request.params as { projectId: string; conversationId: string; taskId: string };
    const task = ownedConversationTask(projectId, conversationId, taskId);
    if (task.status !== "failed" && task.status !== "interrupted") {
      throw new ApiError(409, "Only failed or interrupted responses can be retried", "TASK_NOT_RETRYABLE");
    }
    const afterCursor = records.latestEvent(taskId)?.sequence ?? 0;
    records.retryTask(taskId);
    deps.runner.run(taskId);
    reply.status(202);
    return { version: 1, taskId, status: "queued", outcome: "retried", afterCursor };
  });

  app.post("/api/projects/:projectId/conversations/:conversationId/tasks/:taskId/resume", async (request, reply) => {
    const { projectId, conversationId, taskId } = request.params as { projectId: string; conversationId: string; taskId: string };
    const task = ownedConversationTask(projectId, conversationId, taskId);
    if (task.status !== "interrupted") {
      throw new ApiError(409, "Only interrupted responses can be resumed", "TASK_NOT_RESUMABLE");
    }
    const budgetEvents = records.listEventsByType(taskId, "context.budget_calculated");
    const rejectedBudget = [...budgetEvents].reverse().find((event) => event.payload.admitted === false);
    const compactedAfterRejection = rejectedBudget
      ? records.listEventsAfter(taskId, rejectedBudget.sequence).some((event) => event.type === "context.compaction_completed")
      : true;
    if (!compactedAfterRejection) {
      throw new ApiError(
        409,
        "The saved provider request still exceeds its verified route limit. Compact this task before continuing; no provider request was made.",
        "CONTEXT_PREFLIGHT_REJECTED",
      );
    }
    const afterCursor = records.latestEvent(taskId)?.sequence ?? 0;
    records.resumeInterruptedTask(taskId, {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      payload: { reason: "user_continue" },
    });
    deps.runner.run(taskId);
    reply.status(202);
    return { version: 1, taskId, status: "queued", outcome: "resumed", afterCursor };
  });

  app.get("/api/projects/:projectId/conversations/:conversationId/tasks/:taskId/stream", async (request, reply) => {
    const { projectId, conversationId, taskId } = request.params as { projectId: string; conversationId: string; taskId: string };
    const queryAfter = (request.query as { after?: string }).after;
    const headerCursor = request.headers["last-event-id"];
    const after = Math.max(
      queryAfter === undefined ? 0 : parseEventCursor(queryAfter),
      headerCursor === undefined ? 0 : parseEventCursor(String(headerCursor)),
    );
    ownedConversationTask(projectId, conversationId, taskId);

    const terminalTypes = new Set(["task.verified", "task.completed", "task.failed", "task.cancelled", "task.interrupted"]);
    const classify = (type: string): ChatStreamEventType => {
      if (terminalTypes.has(type)) return "task.terminal";
      if (type === "evidence.persisted" || type.startsWith("assistant.")) return "message.updated";
      if (type.startsWith("tool.")) return "tool.updated";
      return "task.updated";
    };

    reply.hijack();
    let closed = false;
    let cursor = after;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (destroy = false) => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (destroy && !reply.raw.destroyed) reply.raw.destroy();
    };
    request.raw.on("close", () => stop());
    reply.raw.on("close", () => stop());
    reply.raw.on("error", () => stop(true));
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const poll = () => {
      if (closed) return;
      try {
        const pending = records.listEventsAfter(taskId, cursor);
        for (const event of pending) {
          const envelope = ChatStreamEnvelopeSchema.parse({
            version: 1,
            cursor: event.sequence,
            taskId,
            conversationId,
            eventType: classify(event.type),
            emittedAt: event.createdAt,
            payload: { eventId: event.id },
          });
          reply.raw.write(`id: ${envelope.cursor}\nevent: ${envelope.eventType}\ndata: ${JSON.stringify(envelope)}\n\n`);
          cursor = envelope.cursor;
          if (envelope.eventType === "task.terminal") {
            reply.raw.end();
            stop();
            return;
          }
        }
        const task = tasks.getTaskById(taskId);
        if (task && ["verified", "completed", "failed", "cancelled", "interrupted"].includes(task.status)) {
          reply.raw.end();
          stop();
          return;
        }
        timer = setTimeout(poll, deps.sseIntervalMs ?? 100);
      } catch {
        stop(true);
      }
    };
    poll();
  });

  app.get("/api/conversations/:conversationId/messages", async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const conversation = convs.getConversation(conversationId);
    if (!conversation) throw new ApiError(404, "Conversation not found", "NOT_FOUND");
    return convs.listMessages(conversationId);
  });

  app.post("/api/conversations/:conversationId/compact", async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    const conversation = convs.getConversation(conversationId);
    if (!conversation) throw new ApiError(404, "Conversation not found", "NOT_FOUND");
    const body = z.object({
      projectId: z.string().min(1),
      preset: z.string().optional(),
      providerId: ProviderIdSchema.optional(),
      model: z.string().min(1).max(200).optional(),
    }).strict().parse(request.body ?? {});
    if (conversation.projectId !== body.projectId) {
      throw new ApiError(403, "Conversation belongs to a different project and cannot be compacted here.", "CONVERSATION_PROJECT_MISMATCH");
    }
    const presetId: PresetId = body.preset && isPresetId(body.preset) ? body.preset : DEFAULT_PRESET_ID;
    const routed = routePreset(presetId, process.env, body.providerId ? { providerId: body.providerId, ...(body.model ? { model: body.model } : {}) } : undefined);
    if (!routed.ok) throw new ApiError(400, routed.reason, "PRESET_UNAVAILABLE");
    const decision = body.model && !body.providerId ? { ...routed.decision, model: body.model, overridden: true } : routed.decision;
    const preset = getPreset(presetId)!;
    const outputReserveTokens = preset.outputBudgetTokens ?? 2048;
    let route: ProviderRouteMetadata;
    if (decision.providerId === "mock") {
      route = { providerId: "mock", protocol: "mock", endpointKind: "injected", endpointHost: null, endpointLimitTokens: 131_072, endpointLimitSource: "provider-metadata" };
    } else {
      route = createProvider(decision.providerId, process.env, decision.model).route ?? {
        providerId: decision.providerId, protocol: "openai-chat", endpointKind: "injected", endpointHost: null,
        endpointLimitTokens: null, endpointLimitSource: "unknown",
      };
    }
    const resolution = resolveModelBudget({
      providerId: decision.providerId,
      selectedModel: decision.model,
      endpoint: { kind: route.endpointKind, host: route.endpointHost, protocol: route.protocol, limitTokens: route.endpointLimitTokens, limitSource: route.endpointLimitSource },
      outputBudgetTokens: outputReserveTokens,
    });
    const messages: ChatMessage[] = convs.listMessages(conversationId).map((message) => ({ role: message.role, content: message.content }));
    if (messages.length < 2) throw new ApiError(409, "Not enough conversation history to compact", "CONTEXT_NOT_COMPACTABLE");
    const original = countChatTokens(messages, { providerId: decision.providerId, model: decision.model });
    const prepared = prepareContextForProvider(messages, {
      providerId: decision.providerId, model: decision.model,
      maxInputTokens: Math.max(1, original.tokens - 1), compact: true, recentRawGroups: 1,
    });
    if (!prepared.ok || !prepared.summary) throw new ApiError(409, "Conversation history could not be compacted safely", "CONTEXT_NOT_COMPACTABLE");
    const admission = admitProviderRequest({
      providerId: decision.providerId, model: decision.model, protocol: route.protocol,
      messages: prepared.messages, tools: [], outputReserveTokens,
    }, resolution);
    if (!admission.ok) throw new ApiError(409, "Compacted context still exceeds the effective request limit", "CONTEXT_PREFLIGHT_REJECTED");
    const summary = contextSummariesRepo.record({
      id: crypto.randomUUID(), projectId: conversation.projectId, conversationId, taskId: null,
      method: prepared.summary.method, content: prepared.summary.content,
      sourceStartIndex: prepared.summary.sourceStartIndex, sourceEndIndex: prepared.summary.sourceEndIndex,
      sourceMessageCount: prepared.summary.sourceMessageCount, createdAt: new Date().toISOString(),
    });
    return {
      compacted: true,
      summary: { id: summary.id, method: summary.method, sourceMessageCount: summary.sourceMessageCount, createdAt: summary.createdAt },
      routing: decision,
      context: {
        providerId: decision.providerId, model: decision.model,
        modelCapacityTokens: resolution.contextWindowTokens, modelCapacitySource: resolution.contextWindowSource,
        endpointLimitTokens: resolution.endpointLimitTokens, endpointLimitSource: resolution.endpointLimitSource,
        effectiveRequestLimitTokens: resolution.contextWindowTokens, effectiveLimitSource: resolution.contextWindowSource,
        outputReserveTokens: resolution.outputReserveTokens, maximumInputTokens: resolution.usableInputTokens,
        usableInputTokens: resolution.usableInputTokens,
        currentRequestTokens: admission.measurement.inputTokens, countingMethod: admission.measurement.method, exact: admission.measurement.exact,
      },
    };
  });

  app.post("/api/conversations/:conversationId/messages", async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const body = SendMessageSchema.parse(request.body);
    const idempotencyKey = readIdempotencyKey(request);
    try {
      const result = dispatchAgentTask({ db: deps.db, runner: deps.runner, env: process.env }, {
        conversationId,
        ...body,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      reply.status(result.replayed ? 200 : 202);
      if (result.replayed) return result;
      const { replayed: _replayed, ...response } = result;
      return response;
    } catch (error) {
      if (error instanceof AgentTaskDispatchError) {
        throw new ApiError(error.statusCode, error.message, error.code);
      }
      throw error;
    }
  });

  // Shared by the direct /subagents route and by delegation approval: spawns
  // a real delegated child through dispatchAgentTask (provider routing,
  // conversation linkage, agent-state events) instead of the bare
  // createTask+runner.run shortcut. The child gets a fresh, minimal
  // conversation — never the parent's chat history — so it only receives
  // the approved input projection (the objective/label).
  function spawnAgentChatSubagent(
    parent: { id: string; projectId: string; agentId?: string | null | undefined },
    agentId: string,
    label: string | undefined,
    options: { deferRun?: boolean; delegationId?: string; toolCallId?: string; modelInitiated?: boolean; targetProfileHash?: string; contextRefs?: Array<{ kind: "artifact" | "evidence"; id: string }> } = {},
  ) {
    try {
      return dispatchAgentChatSubagent(
        { db: deps.db, runner: deps.runner, env: process.env },
        parent,
        agentId,
        label,
        { ...options, registry: teammateSpawnRegistry },
      );
    } catch (error) {
      if (error instanceof AgentTaskDispatchError) {
        throw new ApiError(error.statusCode, error.message, error.code);
      }
      throw error;
    }
  }

  // The task runner is constructed before the Fastify app, so install the
  // server-owned target resolver once this closure has all repository access.
  // Direct REST subagent calls and ask_teammate now share the exact same child
  // dispatch boundary and process-local duplicate registry.
  deps.runner.setTeammateSpawner?.(({ parentTaskId, toolCallId, agentId, objective, targetProfileHash }) => {
    const parent = tasks.getTaskById(parentTaskId);
    if (!parent) throw new Error("Parent task is no longer available");
    const result = spawnAgentChatSubagent(parent, agentId, objective, {
      toolCallId,
      modelInitiated: true,
      ...(targetProfileHash ? { targetProfileHash } : {}),
    });
    return {
      taskId: result.task.id,
      agentId,
      providerId: result.routing?.providerId ?? null,
      model: result.routing?.model ?? null,
    };
  });

  // Subagent delegation: a subagent is a child task with its own scope, linked
  // to its parent via parent_task_id. This builds the task graph.
  //
  // kind:"inspect_workspace" keeps its exact original code path (bare
  // createTask + runner.run) — untouched, regression-guarded by the existing
  // subagents.test.ts suite.
  //
  // kind:"agent_chat" is a real delegated child — see spawnAgentChatSubagent.
  app.post("/api/tasks/:taskId/subagents", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const parent = tasks.getTaskById(taskId);
    if (!parent) throw new ApiError(404, "Task not found", "NOT_FOUND");
    const body = SpawnSubagentSchema.parse(request.body ?? {});

    if (body.kind === "agent_chat") {
      if (!body.agentId) {
        throw new ApiError(400, "agentId is required for kind:\"agent_chat\"", "AGENT_ID_REQUIRED");
      }
      const result = spawnAgentChatSubagent(parent, body.agentId, body.label);
      reply.status(202);
      return { parentTaskId: parent.id, taskId: result.task.id, aggregateUrl: `/api/tasks/${result.task.id}` };
    }

    const child = tasks.createTask({
      id: crypto.randomUUID(),
      projectId: parent.projectId,
      kind: body.kind,
      status: "queued",
      parentTaskId: parent.id,
      createdAt: new Date().toISOString(),
    });
    deps.runner.run(child.id);
    reply.status(202);
    return { parentTaskId: parent.id, taskId: child.id, aggregateUrl: `/api/tasks/${child.id}` };
  });

  app.get("/api/tasks/:taskId/tree", async (request) => {
    const { taskId } = request.params as { taskId: string };
    const root = tasks.getTaskById(taskId);
    if (!root) throw new ApiError(404, "Task not found", "NOT_FOUND");
    type Node = { task: typeof root; children: Node[] };
    const build = (node: NonNullable<typeof root>): Node => ({
      task: node,
      children: tasks.listChildren(node.id).map(build),
    });
    return build(root);
  });

  app.post("/api/tasks/:taskId/cancel", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");
    if (task.status === "cancelled") {
      reply.status(200);
      return { taskId, status: task.status, outcome: "already_cancelled" };
    }
    if (task.status === "completed" || task.status === "verified" || task.status === "failed") {
      throw new ApiError(409, `Task is already ${task.status}; cancellation was not applied.`, "TASK_ALREADY_TERMINAL");
    }
    if (task.status === "interrupted") {
      throw new ApiError(409, "Task is interrupted and can be resumed or retried; cancellation was not applied.", "TASK_NOT_ACTIVE");
    }

    deps.runner.cancel(taskId);
    const updated = tasks.getTaskById(taskId);
    reply.status(202);
    return { taskId, status: updated?.status ?? task.status, outcome: "cancelled" };
  });

  app.post("/api/tasks/:taskId/compact", async (request) => {
    const { taskId } = request.params as { taskId: string };
    const body = z.object({
      projectId: z.string().min(1),
      preset: z.string().optional(),
      providerId: ProviderIdSchema.optional(),
      model: z.string().min(1).max(200).optional(),
    }).strict().parse(request.body ?? {});
    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");
    if (task.projectId !== body.projectId) {
      throw new ApiError(403, "Task belongs to a different project and cannot be compacted here.", "TASK_PROJECT_MISMATCH");
    }
    if (task.kind !== "agent_chat") throw new ApiError(409, "Only agent chat tasks can be compacted", "TASK_NOT_COMPACTABLE");
    if (task.status !== "running" && task.status !== "interrupted") {
      throw new ApiError(409, `Task is ${task.status} and cannot be compacted`, "TASK_NOT_COMPACTABLE");
    }

    const assistant = deps.db.prepare(`SELECT id,conversation_id AS conversationId
      FROM conversation_messages WHERE task_id=? AND role='assistant'
      ORDER BY created_at DESC,id DESC LIMIT 1`).get(taskId) as { id: string; conversationId: string } | undefined;
    if (!assistant) throw new ApiError(409, "Task has no durable conversation state to compact", "CONTEXT_NOT_COMPACTABLE");
    const conversation = convs.getConversation(assistant.conversationId);
    if (!conversation || conversation.projectId !== task.projectId) {
      throw new ApiError(409, "Task conversation ownership is inconsistent", "TASK_CONVERSATION_MISMATCH");
    }

    const presetId: PresetId = body.preset && isPresetId(body.preset) ? body.preset : DEFAULT_PRESET_ID;
    const routed = routePreset(presetId, process.env, body.providerId ? { providerId: body.providerId, ...(body.model ? { model: body.model } : {}) } : undefined);
    if (!routed.ok) throw new ApiError(400, routed.reason, "PRESET_UNAVAILABLE");
    const decision = body.model && !body.providerId ? { ...routed.decision, model: body.model, overridden: true } : routed.decision;
    const preset = getPreset(presetId)!;
    const outputReserveTokens = preset.outputBudgetTokens ?? 2048;
    let route: ProviderRouteMetadata;
    if (decision.providerId === "mock") {
      route = { providerId: "mock", protocol: "mock", endpointKind: "injected", endpointHost: null, endpointLimitTokens: 131_072, endpointLimitSource: "provider-metadata" };
    } else {
      route = createProvider(decision.providerId, process.env, decision.model).route ?? {
        providerId: decision.providerId, protocol: "openai-chat", endpointKind: "injected", endpointHost: null,
        endpointLimitTokens: null, endpointLimitSource: "unknown",
      };
    }
    const resolution = resolveModelBudget({
      providerId: decision.providerId,
      selectedModel: decision.model,
      endpoint: { kind: route.endpointKind, host: route.endpointHost, protocol: route.protocol, limitTokens: route.endpointLimitTokens, limitSource: route.endpointLimitSource },
      outputBudgetTokens: outputReserveTokens,
    });

    const durableMessages = convs.listMessages(assistant.conversationId);
    const assistantIndex = durableMessages.findIndex((message) => message.id === assistant.id);
    if (assistantIndex < 0) throw new ApiError(409, "Task conversation state is incomplete", "CONTEXT_NOT_COMPACTABLE");
    const prefixMessages: ChatMessage[] = durableMessages.slice(0, assistantIndex).map((message) => ({ role: message.role, content: message.content }));
    const turns = executionContinuityRepo.listProviderTurns(taskId).map((turn) => ({
      turnKey: turn.turnKey,
      assistantText: turn.assistantText,
      toolCalls: turn.toolCalls.flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const call = raw as { id?: unknown; name?: unknown; arguments?: unknown };
        return typeof call.id === "string" && typeof call.name === "string" && typeof call.arguments === "string"
          ? [{ id: call.id, name: call.name, arguments: redactJsonText(call.arguments) ?? call.arguments }]
          : [];
      }),
    }));
    // Legacy rows may have the complete result but no persisted model-facing
    // projection. Repair that seam before building the compacted request so a
    // restart/manual compaction cannot re-inject an oversized raw result.
    convs.materializeToolContextForTask(taskId);
    const toolResults = convs.listToolCallsForTask(taskId).flatMap((call) =>
      typeof (call.contextResultJson ?? call.resultJson) === "string"
        ? [{ id: call.id, toolName: call.toolName, result: redactJsonText(call.contextResultJson ?? call.resultJson!) ?? call.contextResultJson ?? call.resultJson! }]
        : [],
    );
    const messages = buildProviderProjection({
      prefixMessages,
      turns,
      toolResults,
      normalizeToolArguments: boundCompletedToolArguments,
    });
    if (messages.length < 2) throw new ApiError(409, "Not enough task history to compact", "CONTEXT_NOT_COMPACTABLE");
    const original = countChatTokens(messages, { providerId: decision.providerId, model: decision.model });
    const prepared = prepareContextForProvider(messages, {
      providerId: decision.providerId, model: decision.model,
      maxInputTokens: Math.max(1, original.tokens - 1), compact: true, recentRawGroups: 1,
    });
    if (!prepared.ok || !prepared.summary) throw new ApiError(409, "Task history could not be compacted safely", "CONTEXT_NOT_COMPACTABLE");
    const admission = admitProviderRequest({
      providerId: decision.providerId, model: decision.model, protocol: route.protocol,
      messages: prepared.messages, tools: [], outputReserveTokens,
    }, resolution);
    if (!admission.ok) throw new ApiError(409, "Compacted context still exceeds the effective request limit", "CONTEXT_PREFLIGHT_REJECTED");
    const createdAt = new Date().toISOString();
    const summary = contextSummariesRepo.record({
      id: crypto.randomUUID(), projectId: task.projectId, conversationId: assistant.conversationId, taskId,
      method: prepared.summary.method, content: prepared.summary.content,
      sourceStartIndex: prepared.summary.sourceStartIndex, sourceEndIndex: prepared.summary.sourceEndIndex,
      sourceMessageCount: prepared.summary.sourceMessageCount, createdAt,
    });
    records.appendEvent({
      id: crypto.randomUUID(), taskId, type: "context.compaction_completed",
      payload: { summaryId: summary.id, method: summary.method, sourceMessageCount: summary.sourceMessageCount, manual: true },
      createdAt,
    });
    return {
      compacted: true,
      taskId,
      summary: { id: summary.id, method: summary.method, sourceMessageCount: summary.sourceMessageCount, createdAt: summary.createdAt },
      routing: decision,
      context: {
        providerId: decision.providerId, model: decision.model,
        modelCapacityTokens: resolution.contextWindowTokens, modelCapacitySource: resolution.contextWindowSource,
        endpointLimitTokens: resolution.endpointLimitTokens, endpointLimitSource: resolution.endpointLimitSource,
        effectiveRequestLimitTokens: resolution.contextWindowTokens, effectiveLimitSource: resolution.contextWindowSource,
        outputReserveTokens: resolution.outputReserveTokens, maximumInputTokens: resolution.usableInputTokens,
        usableInputTokens: resolution.usableInputTokens,
        currentRequestTokens: admission.measurement.inputTokens, countingMethod: admission.measurement.method, exact: admission.measurement.exact,
      },
    };
  });

  app.post("/api/tasks/:taskId/resume", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const body = z.object({ projectId: z.string().min(1) }).parse(request.body ?? {});
    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");
    if (task.projectId !== body.projectId) {
      throw new ApiError(403, "Task belongs to a different project and cannot be resumed here.", "TASK_PROJECT_MISMATCH");
    }
    if (task.status !== "interrupted") throw new ApiError(409, "Only interrupted tasks can be resumed", "TASK_NOT_RESUMABLE");
    if (task.kind === "agent_chat") {
      const budgetEvents = records.listEventsByType(taskId, "context.budget_calculated");
      const rejectedBudget = [...budgetEvents].reverse().find((event) => event.payload.admitted === false);
      const compactedAfterRejection = rejectedBudget
        ? records.listEventsAfter(taskId, rejectedBudget.sequence).some((event) => event.type === "context.compaction_completed")
        : true;
      if (!compactedAfterRejection) {
        throw new ApiError(
          409,
          "The saved provider request still exceeds its verified route limit. Compact this task before continuing; no provider request was made.",
          "CONTEXT_PREFLIGHT_REJECTED",
        );
      }
      records.resumeInterruptedTask(taskId, { id: crypto.randomUUID(), createdAt: new Date().toISOString(), payload: { reason: "user_continue" } });
    } else {
      records.retryTask(taskId);
    }
    deps.runner.run(taskId);
    reply.status(202);
    return records.getAggregate(taskId).task;
  });

  app.post("/api/tasks/:taskId/retry", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");
    if (task.status !== "failed" && task.status !== "interrupted") {
      throw new ApiError(409, "Only failed or interrupted tasks can be retried", "TASK_NOT_RETRYABLE");
    }
    records.retryTask(taskId);
    deps.runner.run(taskId);
    reply.status(202);
    return records.getAggregate(taskId).task;
  });

  app.get("/api/tasks/:taskId/diff", async (request) => {
    const { taskId } = request.params as { taskId: string };
    const csList = changeSets.listByTask(taskId);
    // Select the most recent applicable change set (listByTask is created-ASC).
    const applied = [...csList].reverse().find(c => c.state === "applied" || c.state === "undone");
    if (!applied) {
      return { diff: null };
    }
    return {
      id: applied.id,
      state: applied.state,
      diff: applied.diff,
      diffHash: applied.diffHash,
      files: Object.keys(applied.originalHashes),
      undoResult: applied.undoResult,
    };
  });

  app.post("/api/tasks/:taskId/undo", async (request) => {
    const { taskId } = request.params as { taskId: string };
    const csList = changeSets.listByTask(taskId);
    // Undo the most recent applied change set (listByTask is created-ASC).
    const applied = [...csList].reverse().find(c => c.state === "applied");
    if (!applied) throw new ApiError(404, "No applied change set found for this task", "NOT_FOUND");

    const project = projects.getProjectById(applied.projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");

    // 1. Verify containment (incl. symlink escape), existence, and that the
    //    file still matches the hash we wrote — refuse if manually edited since.
    const containedPaths: Record<string, string> = {};
    for (const file of Object.keys(applied.originalHashes)) {
      if (file === "/dev/null") continue;
      let fullPath: string;
      try {
        fullPath = assertContainedRealPath(project.workspacePath, file);
      } catch (e: any) {
        throw new ApiError(403, `Path containment violation: ${file}`, "FORBIDDEN");
      }
      containedPaths[file] = fullPath;

      if (!existsSync(fullPath)) {
        throw new ApiError(409, `File has been deleted since application: ${file}`, "CONFLICT");
      }
      const currentContent = readFileSync(fullPath, "utf8");
      const currentHash = hashString(currentContent);
      if (currentHash !== applied.postApplyHashes?.[file]) {
        throw new ApiError(409, `Unsafe undo: file has manual modifications: ${file}`, "CONFLICT");
      }
    }

    // 2. Perform rollback from trusted backups only (no git reset/clean/checkout).
    const backupsDir = join(resolveMorrowHome(process.env), "backups");
    const restoredFiles: string[] = [];

    for (const file of Object.keys(applied.originalHashes)) {
      const originalHash = applied.originalHashes[file];
      const fullPath = file === "/dev/null" ? "" : (containedPaths[file] ?? assertContainedRealPath(project.workspacePath, file));

      if (originalHash === "") {
        // File was created by the change set: removing it restores the original
        // (absent) state.
        if (fullPath && existsSync(fullPath)) {
          unlinkSync(fullPath);
          restoredFiles.push(file);
        }
      } else {
        const backupFile = join(backupsDir, `${originalHash}.bak`);
        if (!existsSync(backupFile)) {
          throw new ApiError(500, `Backup file not found for ${file}`, "INTERNAL_ERROR");
        }
        const originalContent = readFileSync(backupFile, "utf8");
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, originalContent, "utf8");
        restoredFiles.push(file);
      }
    }

    // 3. Persist the undo result
    const undoResult = {
      undoneAt: new Date().toISOString(),
      restoredFiles
    };
    changeSets.updateUndone(applied.id, undoResult);

    return {
      status: "success",
      restoredFiles
    };
  });

  // ── Named workspace checkpoints ──────────────────────────────────────────
  // Snapshot a set of workspace files under a project-unique name; restore
  // rewrites them to the captured state (auto-snapshotting the current state
  // first so a restore is itself reversible).

  const checkpointSummary = (cp: ReturnType<typeof checkpoints.getByName> & object) => ({
    id: cp.id,
    name: cp.name,
    taskId: cp.taskId,
    fileCount: Object.keys(cp.files).length,
    files: Object.keys(cp.files),
    createdAt: cp.createdAt,
  });

  app.post("/api/projects/:projectId/checkpoints", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");

    const parsed = CreateCheckpointSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, "Invalid checkpoint request", "VALIDATION_ERROR");
    const { name, files, taskId } = parsed.data;
    if (!isValidCheckpointName(name)) {
      throw new ApiError(400, "Checkpoint names may use letters, digits, dot, dash, underscore, and slash (max 100 chars)", "VALIDATION_ERROR");
    }
    if (checkpoints.getByName(projectId, name)) {
      throw new ApiError(409, `A checkpoint named "${name}" already exists in this project`, "CONFLICT");
    }
    if (taskId && !tasks.getTaskById(taskId)) throw new ApiError(404, "Task not found", "NOT_FOUND");

    // Default file set: everything Morrow's change sets have ever touched in
    // this project — the surface a user most plausibly wants to protect.
    let fileList = files ?? [];
    if (fileList.length === 0) {
      const touched = new Set<string>();
      for (const cs of changeSets.listByProject(projectId)) {
        for (const f of Object.keys(cs.originalHashes)) if (f !== "/dev/null") touched.add(f);
      }
      fileList = [...touched];
    }
    if (fileList.length === 0) {
      throw new ApiError(400, "Nothing to checkpoint: no Morrow-modified files exist yet; pass an explicit files list", "VALIDATION_ERROR");
    }
    if (fileList.length > 500) throw new ApiError(400, "A checkpoint may cover at most 500 files", "VALIDATION_ERROR");

    const backupsDir = join(resolveMorrowHome(process.env), "backups");
    let snapshot;
    try {
      snapshot = snapshotFiles(project.workspacePath, backupsDir, fileList);
    } catch (e: any) {
      throw new ApiError(403, `Path containment violation: ${e?.message ?? e}`, "FORBIDDEN");
    }
    const created = checkpoints.create({ id: crypto.randomUUID(), projectId, name, taskId: taskId ?? null, files: snapshot.files });
    reply.status(201);
    return { ...checkpointSummary(created), skipped: snapshot.skipped };
  });

  app.get("/api/projects/:projectId/checkpoints", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return checkpoints.listByProject(projectId).map(checkpointSummary);
  });

  app.post("/api/projects/:projectId/checkpoints/:name/restore", async (request) => {
    const { projectId, name } = request.params as { projectId: string; name: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const checkpoint = checkpoints.getByName(projectId, name);
    if (!checkpoint) throw new ApiError(404, `No checkpoint named "${name}" in this project`, "NOT_FOUND");

    const backupsDir = join(resolveMorrowHome(process.env), "backups");

    // Reversibility: capture the current state of the same file set first.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safetyName = `auto/pre-restore-${name}-${stamp}`.slice(0, 100);
    let safety;
    try {
      safety = snapshotFiles(project.workspacePath, backupsDir, Object.keys(checkpoint.files));
    } catch (e: any) {
      throw new ApiError(403, `Path containment violation: ${e?.message ?? e}`, "FORBIDDEN");
    }
    if (safety.skipped.length > 0) {
      throw new ApiError(409, `Cannot restore safely: current state of ${safety.skipped.map((s) => s.path).join(", ")} could not be captured`, "CONFLICT");
    }
    const safetyCheckpoint = checkpoints.getByName(projectId, safetyName)
      ? null
      : checkpoints.create({ id: crypto.randomUUID(), projectId, name: safetyName, taskId: null, files: safety.files });

    let restored;
    try {
      restored = restoreSnapshot(project.workspacePath, backupsDir, checkpoint.files);
    } catch (e: any) {
      throw new ApiError(409, `Restore failed: ${e?.message ?? e}`, "CONFLICT");
    }
    return {
      status: "success",
      name: checkpoint.name,
      restoredFiles: restored.restoredFiles,
      deletedFiles: restored.deletedFiles,
      safetyCheckpoint: safetyCheckpoint?.name ?? null,
    };
  });

  app.delete("/api/projects/:projectId/checkpoints/:name", async (request) => {
    const { projectId, name } = request.params as { projectId: string; name: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    if (!checkpoints.remove(projectId, name)) throw new ApiError(404, `No checkpoint named "${name}" in this project`, "NOT_FOUND");
    return { status: "deleted", name };
  });

  // ── Verified Missions ────────────────────────────────────────────────────
  // A mission converts an objective into measurable, evidence-backed criteria,
  // executes under supervision, records failures/recovery, checkpoints risky
  // changes, obtains an independent review, and grades itself honestly. All
  // state is durable so a restart reconstructs the mission from persistence.
  const requireMission = (missionId: string) => {
    const m = missions.get(missionId);
    if (!m) throw new ApiError(404, "Mission not found", "NOT_FOUND");
    return m;
  };
  const runMission = <T>(fn: () => T): T => {
    try { return fn(); }
    catch (e) {
      if (e instanceof MissionError) {
        const status = e.code === "not_found" ? 404 : e.code === "no_workspace" ? 409 : 400;
        throw new ApiError(status, e.message, e.code.toUpperCase());
      }
      throw e;
    }
  };

  app.post("/api/projects/:projectId/missions", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const parsed = CreateMissionSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, "Invalid mission request", "VALIDATION_ERROR");
    let mission!: ReturnType<typeof missionService.create>;
    deps.db.transaction(() => {
      mission = missionService.create(projectId, parsed.data);
      missionRuntime.create({ missionId: mission.id, now: mission.createdAt });
    })();
    ensureCortexSpecialistAgents(projectId, agents);
    reply.status(201);
    return missionProjection(mission.id);
  });

  app.get("/api/projects/:projectId/missions", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return missionService.listByProject(projectId).map((mission) => missionProjection(mission.id));
  });

  app.get("/api/missions/:missionId", async (request) => {
    const missionId = (request.params as { missionId: string }).missionId;
    requireMission(missionId);
    return missionProjection(missionId);
  });

  app.get("/api/missions/:missionId/criteria", async (request) => requireMission((request.params as { missionId: string }).missionId).criteria);
  app.get("/api/missions/:missionId/evidence", async (request) => requireMission((request.params as { missionId: string }).missionId).evidence);
  app.get("/api/missions/:missionId/failures", async (request) => requireMission((request.params as { missionId: string }).missionId).failures);
  app.get("/api/missions/:missionId/checkpoints", async (request) => requireMission((request.params as { missionId: string }).missionId).checkpoints);
  app.get("/api/missions/:missionId/result", async (request) => {
    const m = requireMission((request.params as { missionId: string }).missionId);
    return { status: m.status, result: m.result, finalReview: m.finalReview, runtime: missionProjection(m.id).runtime };
  });

  app.post("/api/missions/:missionId/start", async (request, reply) => {
    const { missionId } = request.params as { missionId: string };
    const mission = requireMission(missionId);
    if (mission.status !== "running" && mission.status !== "reviewing") {
      throw new ApiError(409, `Mission must be approved before start; current status is ${mission.status}`, "MISSION_NOT_STARTABLE");
    }
    if (!missionRuntime.get(missionId)) missionRuntime.create({ missionId, now: new Date().toISOString() });
    if (!deps.missionControllerRunner?.run || !deps.missionControllerRunner.isActive) {
      throw new ApiError(503, "Durable mission controller is unavailable", "MISSION_CONTROLLER_UNAVAILABLE");
    }
    if (!deps.missionControllerRunner.isActive(missionId)) deps.missionControllerRunner.run(missionId);
    reply.status(202);
    return missionProjection(missionId);
  });
  app.get("/api/missions/:missionId/events", async (request) => {
    requireMission((request.params as { missionId: string }).missionId);
    return missions.listEvents((request.params as { missionId: string }).missionId);
  });
  app.get("/api/missions/:missionId/specialists", async (request) => {
    const { missionId } = request.params as { missionId: string };
    requireMission(missionId);
    return runMission(() => missionService.specialists(missionId));
  });

  // Generate/regenerate criteria from the objective.
  app.post("/api/missions/:missionId/criteria/generate", async (request) => {
    const { missionId } = request.params as { missionId: string };
    requireMission(missionId);
    const body = (request.body ?? {}) as { repoSummary?: string };
    return runMission(() => missionService.generateCriteria(missionId, body.repoSummary ?? ""));
  });

  app.post("/api/missions/:missionId/criteria", async (request, reply) => {
    const { missionId } = request.params as { missionId: string };
    requireMission(missionId);
    const parsed = AddMissionCriterionSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, "Invalid criterion", "VALIDATION_ERROR");
    reply.status(201);
    return runMission(() => missionService.addCriterion(missionId, parsed.data.description, parsed.data.verification));
  });

  app.patch("/api/missions/:missionId/criteria/:criterionId", async (request) => {
    const { missionId, criterionId } = request.params as { missionId: string; criterionId: string };
    requireMission(missionId);
    const parsed = UpdateMissionCriterionSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, "Invalid criterion update", "VALIDATION_ERROR");
    return runMission(() => missionService.updateCriterion(missionId, criterionId, parsed.data));
  });

  app.delete("/api/missions/:missionId/criteria/:criterionId", async (request) => {
    const { missionId, criterionId } = request.params as { missionId: string; criterionId: string };
    requireMission(missionId);
    const removed = runMission(() => missionService.removeCriterion(missionId, criterionId));
    if (!removed) throw new ApiError(404, "Criterion not found", "NOT_FOUND");
    return { status: "deleted", criterionId };
  });

  app.post("/api/missions/:missionId/criteria/:criterionId/verify", async (request) => {
    const { missionId, criterionId } = request.params as { missionId: string; criterionId: string };
    requireMission(missionId);
    return runMission(() => missionService.verifyCriterion(missionId, criterionId));
  });

  app.post("/api/missions/:missionId/approve", async (request) => {
    const { missionId } = request.params as { missionId: string };
    requireMission(missionId);
    return runMission(() => missionService.approveCriteria(missionId));
  });

  app.post("/api/missions/:missionId/verify", async (request) => {
    const { missionId } = request.params as { missionId: string };
    requireMission(missionId);
    return runMission(() => missionService.verifyAll(missionId));
  });

  app.post("/api/missions/:missionId/review", async (request) => {
    const { missionId } = request.params as { missionId: string };
    requireMission(missionId);
    return runMission(() => missionService.runReview(missionId));
  });

  app.post("/api/missions/:missionId/finalize", async (request) => {
    const { missionId } = request.params as { missionId: string };
    requireMission(missionId);
    const body = (request.body ?? {}) as { humanInterventions?: number; tasksCompleted?: number };
    const finalized = runMission(() => missionService.finalize(missionId, body));
    const continuity = executionContinuityRepository(deps.db);
    const ownerTask = deps.db.prepare("SELECT id FROM tasks WHERE mission_id=? AND type='agent_chat' ORDER BY created_at DESC,id DESC LIMIT 1").get(missionId) as { id: string } | undefined;
    if (ownerTask) {
      const canonical = continuity.getCanonicalAnswer(ownerTask.id);
      if (!canonical) throw new ApiError(409, "Mission completion is missing its canonical provider answer", "MISSION_CANONICAL_ANSWER_REQUIRED");
      continuity.updateCanonicalAnswerEvidence(ownerTask.id, {
        ...canonical.evidenceJson,
        status: finalized.status,
        criteria: finalized.criteria.map((criterion) => ({ id: criterion.id, state: criterion.state })),
        reviewVerdict: finalized.finalReview?.verdict ?? null,
        completedAt: finalized.completedAt,
      });
    }
    return finalized;
  });

  app.post("/api/missions/:missionId/checkpoints", async (request, reply) => {
    const { missionId } = request.params as { missionId: string };
    requireMission(missionId);
    const body = (request.body ?? {}) as { label?: string; reason?: string; files?: string[] };
    if (!body.label) throw new ApiError(400, "A checkpoint label is required", "VALIDATION_ERROR");
    reply.status(201);
    return runMission(() => missionService.createCheckpoint(missionId, body.label!, body.reason ?? "manual checkpoint", body.files));
  });

  app.get("/api/missions/:missionId/checkpoints/:checkpointId/diff", async (request) => {
    const { missionId, checkpointId } = request.params as { missionId: string; checkpointId: string };
    requireMission(missionId);
    return runMission(() => ({ changes: missionService.checkpointDiff(missionId, checkpointId) }));
  });

  app.post("/api/missions/:missionId/rollback", async (request) => {
    const { missionId } = request.params as { missionId: string };
    requireMission(missionId);
    const body = (request.body ?? {}) as { checkpointId?: string };
    if (!body.checkpointId) throw new ApiError(400, "checkpointId is required", "VALIDATION_ERROR");
    return runMission(() => missionService.rollback(missionId, body.checkpointId!));
  });

  app.post("/api/missions/:missionId/cancel", async (request) => {
    const { missionId } = request.params as { missionId: string };
    requireMission(missionId);
    deps.missionControllerRunner?.cancel?.(missionId);
    const cancelled = runMission(() => missionService.cancel(missionId));
    if (deps.missionControllerRunner?.waitFor) {
      deps.missionControllerRunner.wake(missionId);
      await deps.missionControllerRunner.waitFor?.(missionId);
    } else {
      deps.missionControllerRunner?.wake(missionId);
      const runtime = missionRuntime.get(missionId);
      if (runtime && !["blocked", "completed", "cancelled", "abandoned", "superseded"].includes(runtime.state)) {
        missionRuntime.transition({
          missionId,
          from: runtime.state,
          to: "cancelled",
          cause: "user_cancelled",
          actor: "user",
          details: {},
          now: new Date().toISOString(),
        });
      }
    }
    return { ...cancelled, runtime: missionProjection(missionId).runtime };
  });

  app.post("/api/missions/:missionId/resume", async (request) => {
    const { missionId } = request.params as { missionId: string };
    requireMission(missionId);
    const resumed = runMission(() => missionService.resume(missionId));
    deps.missionControllerRunner?.wake(missionId);
    return { ...resumed, runtime: missionProjection(missionId).runtime };
  });

  // ── Morrow Cortex: persistent project intelligence ─────────────────────────
  // Structured, evidence-backed repository knowledge with scoped staleness.
  // Facts come from deterministic analysis; stale knowledge is labelled, never
  // presented as certain; user rules outrank inferred conventions.
  const requireProjectForCortex = (projectId: string) => {
    const p = projects.getProjectById(projectId);
    if (!p) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return p;
  };
  const runCortex = <T>(fn: () => T): T => {
    try { return fn(); }
    catch (e) {
      if (e instanceof CortexError) {
        const status = e.code === "not_found" ? 404 : e.code === "no_workspace" || e.code === "conflict" ? 409 : e.code === "limit" ? 429 : 400;
        throw new ApiError(status, e.message, e.code.toUpperCase());
      }
      throw e;
    }
  };

  app.get("/api/projects/:projectId/intelligence", async (request) => {
    const { projectId } = request.params as { projectId: string };
    requireProjectForCortex(projectId);
    return runCortex(() => cortexService.get(projectId));
  });

  app.post("/api/projects/:projectId/intelligence/refresh", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    requireProjectForCortex(projectId);
    reply.status(201);
    return runCortex(() => cortexService.refresh(projectId));
  });

  app.get("/api/projects/:projectId/intelligence/staleness", async (request) => {
    const { projectId } = request.params as { projectId: string };
    requireProjectForCortex(projectId);
    return runCortex(() => cortexService.detectStaleness(projectId));
  });

  app.delete("/api/projects/:projectId/intelligence", async (request) => {
    const { projectId } = request.params as { projectId: string };
    requireProjectForCortex(projectId);
    const { includeDurable } = (request.query ?? {}) as { includeDurable?: string };
    runCortex(() => cortexService.forget(projectId, { includeDurable: includeDurable === "true" }));
    return { forgotten: true };
  });

  app.get("/api/projects/:projectId/architecture", async (request) => {
    const { projectId } = request.params as { projectId: string };
    requireProjectForCortex(projectId);
    return runCortex(() => cortexService.get(projectId).architecture);
  });

  app.get("/api/projects/:projectId/conventions", async (request) => {
    const { projectId } = request.params as { projectId: string };
    requireProjectForCortex(projectId);
    return runCortex(() => cortexService.get(projectId).conventions);
  });

  app.patch("/api/projects/:projectId/conventions/:conventionId", async (request) => {
    const { projectId, conventionId } = request.params as { projectId: string; conventionId: string };
    requireProjectForCortex(projectId);
    const body = PatchConventionSchema.parse(request.body);
    return runCortex(() => body.approval === "approved"
      ? cortexService.approveConvention(projectId, conventionId)
      : cortexService.rejectConvention(projectId, conventionId));
  });

  app.get("/api/projects/:projectId/decisions", async (request) => {
    const { projectId } = request.params as { projectId: string };
    requireProjectForCortex(projectId);
    return runCortex(() => cortexService.get(projectId).decisions);
  });

  app.get("/api/projects/:projectId/learnings", async (request) => {
    const { projectId } = request.params as { projectId: string };
    requireProjectForCortex(projectId);
    return runCortex(() => cortexService.get(projectId).missionLearnings);
  });

  app.get("/api/projects/:projectId/risks", async (request) => {
    const { projectId } = request.params as { projectId: string };
    requireProjectForCortex(projectId);
    return runCortex(() => cortexService.get(projectId).risks);
  });

  app.get("/api/projects/:projectId/rules", async (request) => {
    const { projectId } = request.params as { projectId: string };
    requireProjectForCortex(projectId);
    return intelligenceRepo.listRules(projectId);
  });

  app.post("/api/projects/:projectId/rules", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    requireProjectForCortex(projectId);
    const body = CreateProjectRuleSchema.parse(request.body);
    reply.status(201);
    return runCortex(() => cortexService.addRule(projectId, body));
  });

  app.delete("/api/projects/:projectId/rules/:ruleId", async (request) => {
    const { projectId, ruleId } = request.params as { projectId: string; ruleId: string };
    requireProjectForCortex(projectId);
    runCortex(() => cortexService.removeRule(projectId, ruleId));
    return { deleted: true };
  });

  // Change-impact analysis: computed from persisted intelligence + the
  // mission's prior failures, then recorded on the mission for auditability.
  app.post("/api/missions/:missionId/impact", async (request, reply) => {
    const { missionId } = request.params as { missionId: string };
    const mission = requireMission(missionId);
    return runCortex(() => {
      if (!cortexService.has(mission.projectId)) {
        throw new CortexError("No project intelligence yet — refresh Cortex before running impact analysis", "not_found");
      }
      const analysis = analyzeChangeImpact({
        missionId,
        objective: mission.objective,
        intelligence: cortexService.get(mission.projectId),
        priorFailures: mission.failures,
      });
      cortexService.recordImpactAnalysis(analysis);
      missions.appendEvent(missionId, "mission.impact_analyzed", `Impact: ${analysis.likelyComponents.length} component(s), ${analysis.requiredVerification.length} verification step(s)`, { components: analysis.likelyComponents.length }, new Date().toISOString());
      reply.status(201);
      return analysis;
    });
  });

  app.get("/api/missions/:missionId/impact", async (request) => {
    const { missionId } = request.params as { missionId: string };
    requireMission(missionId);
    return cortexService.listImpactAnalyses(missionId);
  });

  app.get("/api/missions/:missionId/revisions", async (request) => {
    const { missionId } = request.params as { missionId: string };
    requireMission(missionId);
    return cortexService.listPlanRevisions(missionId);
  });

  // ── Background process registry ──────────────────────────────────────────
  // Start, observe, and terminate long-running commands owned by the
  // orchestrator. Rows never claim liveness across a restart (reconciled to
  // `lost` at startup), and output is captured bounded per stream.

  app.post("/api/projects/:projectId/processes", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = StartProcessSchema.parse(request.body ?? {});
    if (body.taskId) {
      const task = tasks.getTaskById(body.taskId);
      if (!task || task.projectId !== projectId) throw new ApiError(404, "Task not found in this project", "NOT_FOUND");
    }
    if (body.agentId) {
      const agent = agents.get(body.agentId);
      if (!agent || agent.projectId !== projectId) throw new ApiError(404, "Agent not found in this project", "NOT_FOUND");
    }

    // The categorical deny list applies even to explicit user requests —
    // shells, privilege escalation, and destructive commands stay blocked.
    const policy = classifyCommand(body.command, body.args);
    if (policy.risk === "denied") {
      throw new ApiError(403, `Command refused by policy: ${policy.reason}`, "FORBIDDEN");
    }

    // cwd is workspace-relative and containment-checked; default is the root.
    let cwd: string;
    try {
      cwd = body.cwd ? assertContainedRealPath(project.workspacePath, body.cwd) : realpathSync(project.workspacePath);
    } catch (e: any) {
      throw new ApiError(403, `Path containment violation: ${e?.message ?? e}`, "FORBIDDEN");
    }

    let record;
    try {
      record = await supervisor.start({
        projectId,
        taskId: body.taskId ?? null,
        agentId: body.agentId ?? null,
        command: body.command,
        args: body.args,
        cwd,
        mode: body.mode,
        ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
      });
    } catch (e: any) {
      throw new ApiError(400, e?.message ?? "Failed to start process", "PROCESS_START_FAILED");
    }
    if (record.taskId) {
      records.appendEvent({
        id: crypto.randomUUID(),
        taskId: record.taskId,
        type: "process.started",
        payload: { processId: record.id, command: record.command, args: record.args, pid: record.pid },
        createdAt: new Date().toISOString(),
      });
    }
    reply.status(201);
    return record;
  });

  app.get("/api/projects/:projectId/processes", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const { status } = request.query as { status?: string };
    if (status && !["running", "exited", "failed", "cancelled", "lost"].includes(status)) {
      throw new ApiError(400, "Invalid process status filter", "VALIDATION_ERROR");
    }
    // Endpoints are attached here rather than stored on the row: they are
    // derived from captured output, so recomputing keeps them correct for a
    // server that announces its address late (a slow first compile) without a
    // migration or a second write path that could disagree with the log.
    return processesRepo
      .listByProject(projectId, status as any)
      .map((record) => ({ ...record, endpoints: supervisor.endpoints(record.id) }));
  });

  app.get("/api/processes/:processId", async (request) => {
    const { processId } = request.params as { processId: string };
    const record = processesRepo.get(processId);
    if (!record) throw new ApiError(404, "Process not found", "NOT_FOUND");
    return { ...record, endpoints: supervisor.endpoints(processId) };
  });

  app.get("/api/processes/:processId/output", async (request) => {
    const { processId } = request.params as { processId: string };
    if (!processesRepo.get(processId)) throw new ApiError(404, "Process not found", "NOT_FOUND");
    const q = request.query as { stream?: string; offset?: string; limit?: string };
    const stream = q.stream === "stderr" ? "stderr" : "stdout";
    const offset = q.offset ? Number(q.offset) : 0;
    const limit = q.limit ? Math.min(Number(q.limit), 1024 * 1024) : 64 * 1024;
    if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(limit) || limit <= 0) {
      throw new ApiError(400, "offset and limit must be non-negative numbers", "VALIDATION_ERROR");
    }
    return { processId, stream, ...supervisor.readOutput(processId, stream, offset, limit) };
  });

  app.post("/api/processes/:processId/terminate", async (request, reply) => {
    const { processId } = request.params as { processId: string };
    const { force } = (request.body ?? {}) as { force?: boolean };
    const result = await supervisor.terminate(processId, { force: force === true });
    if (result.ok) {
      reply.status(202);
      return { status: "terminating", processId, forced: force === true };
    }
    if (result.reason === "not_found") throw new ApiError(404, "Process not found", "NOT_FOUND");
    if (result.reason?.startsWith("not_running")) {
      throw new ApiError(409, `Process is not running (${result.reason.split(":")[1]})`, "PROCESS_NOT_RUNNING");
    }
    throw new ApiError(409, "Process is not controlled by this orchestrator instance (marked from a previous run); terminate it manually if it is still alive", "PROCESS_NOT_OWNED");
  });

  // ── Git worktrees ─────────────────────────────────────────────────────────
  // Isolated checkouts on deterministic morrow/<name> branches. Removal never
  // deletes the branch, and dirty trees are preserved-by-commit or refused.

  const worktreeApiError = (e: unknown): never => {
    if (e instanceof WorktreeError) {
      if (e.code === "not_found") throw new ApiError(404, e.message, "NOT_FOUND");
      if (e.code === "conflict") throw new ApiError(409, e.message, "CONFLICT");
      if (e.code === "dirty") throw new ApiError(409, e.message, "WORKTREE_DIRTY");
      if (e.code === "not_a_repo" || e.code === "invalid_name") throw new ApiError(400, e.message, "VALIDATION_ERROR");
      throw new ApiError(500, e.message, "GIT_FAILED");
    }
    throw e;
  };

  app.post("/api/projects/:projectId/worktrees", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = CreateWorktreeSchema.parse(request.body ?? {});
    if (body.taskId) {
      const task = tasks.getTaskById(body.taskId);
      if (!task || task.projectId !== projectId) throw new ApiError(404, "Task not found in this project", "NOT_FOUND");
    }
    if (body.agentId) {
      const agent = agents.get(body.agentId);
      if (!agent || agent.projectId !== projectId) throw new ApiError(404, "Agent not found in this project", "NOT_FOUND");
    }
    try {
      const record = worktreeManager.create({
        projectId,
        workspacePath: project.workspacePath,
        ...(body.name ? { name: body.name } : {}),
        taskId: body.taskId ?? null,
        agentId: body.agentId ?? null,
        ...(body.baseRef ? { baseRef: body.baseRef } : {}),
      });
      reply.status(201);
      return record;
    } catch (e) {
      return worktreeApiError(e);
    }
  });

  app.get("/api/projects/:projectId/worktrees", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const { status } = request.query as { status?: string };
    if (status && !["active", "removed", "abandoned"].includes(status)) {
      throw new ApiError(400, "Invalid worktree status filter", "VALIDATION_ERROR");
    }
    return worktreesRepo.listByProject(projectId, status as any);
  });

  app.get("/api/worktrees/:worktreeId", async (request) => {
    const { worktreeId } = request.params as { worktreeId: string };
    try {
      const report = worktreeManager.status(worktreeId);
      return { ...report.record, exists: report.exists, dirty: report.dirty, dirtyFiles: report.dirtyFiles, aheadCommits: report.aheadCommits };
    } catch (e) {
      return worktreeApiError(e);
    }
  });

  app.get("/api/worktrees/:worktreeId/diff", async (request) => {
    const { worktreeId } = request.params as { worktreeId: string };
    try {
      return { worktreeId, ...worktreeManager.diff(worktreeId) };
    } catch (e) {
      return worktreeApiError(e);
    }
  });

  app.delete("/api/worktrees/:worktreeId", async (request) => {
    const { worktreeId } = request.params as { worktreeId: string };
    const { preserve } = request.query as { preserve?: string };
    try {
      const result = worktreeManager.remove(worktreeId, { preserve: preserve === "true" });
      return { status: "removed", worktree: result.record, preservedCommit: result.preservedCommit };
    } catch (e) {
      return worktreeApiError(e);
    }
  });

  // ── Git integrations ──────────────────────────────────────────────────────
  // Check runs in a temporary local clone; apply is explicit and refuses dirty
  // or moved targets. Failed/conflicted checks never delete source worktrees.

  const integrationApiError = (e: unknown): never => {
    if (e instanceof IntegrationError) {
      if (e.code === "not_found") throw new ApiError(404, e.message, "NOT_FOUND");
      if (e.code === "conflict") throw new ApiError(409, e.message, "CONFLICT");
      if (e.code === "validation") throw new ApiError(400, e.message, "VALIDATION_ERROR");
      throw new ApiError(500, e.message, "GIT_FAILED");
    }
    throw e;
  };

  app.post("/api/worktrees/:worktreeId/integrations/check", async (request, reply) => {
    const { worktreeId } = request.params as { worktreeId: string };
    const body = z.object({ targetBranch: z.string().trim().min(1).max(200).optional() }).strict().parse(request.body ?? {});
    try {
      const attempt = integrationManager.check(worktreeId, body.targetBranch ? { targetBranch: body.targetBranch } : {});
      reply.status(201);
      return attempt;
    } catch (e) {
      return integrationApiError(e);
    }
  });

  app.get("/api/projects/:projectId/integrations", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const { status } = request.query as { status?: string };
    if (status && !["pending", "clean", "conflicted", "applied", "failed", "cancelled"].includes(status)) {
      throw new ApiError(400, "Invalid integration status filter", "VALIDATION_ERROR");
    }
    return integrationsRepo.listByProject(projectId, status as any);
  });

  app.get("/api/integrations/:integrationId", async (request) => {
    const { integrationId } = request.params as { integrationId: string };
    const attempt = integrationsRepo.get(integrationId);
    if (!attempt) throw new ApiError(404, "Integration attempt not found", "NOT_FOUND");
    return attempt;
  });

  app.post("/api/integrations/:integrationId/apply", async (request) => {
    const { integrationId } = request.params as { integrationId: string };
    try {
      return integrationManager.apply(integrationId);
    } catch (e) {
      return integrationApiError(e);
    }
  });

  app.post("/api/integrations/:integrationId/cancel", async (request) => {
    const { integrationId } = request.params as { integrationId: string };
    try {
      return integrationManager.cancel(integrationId);
    } catch (e) {
      return integrationApiError(e);
    }
  });

  app.get("/api/projects/:projectId/approvals", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const { status } = request.query as { status?: string };
    if (status) {
      const parsed = ApprovalStatusSchema.safeParse(status);
      if (!parsed.success) throw new ApiError(400, "Invalid approval status", "VALIDATION_ERROR");
      return approvals.listByProject(projectId, parsed.data);
    }
    return approvals.listByProject(projectId);
  });

  app.get("/api/approvals/:approvalId", async (request) => {
    const { approvalId } = request.params as { approvalId: string };
    const approval = approvals.get(approvalId);
    if (!approval) throw new ApiError(404, "Approval not found", "NOT_FOUND");
    return approval;
  });

  app.post("/api/approvals/:approvalId/resolve", async (request) => {
    const { approvalId } = request.params as { approvalId: string };
    const body = ResolveApprovalSchema.parse(request.body);
    const approval = approvals.get(approvalId);
    if (!approval || approval.projectId !== body.projectId) throw new ApiError(404, "Approval not found in project", "NOT_FOUND");

    // ask_teammate is an individual model-authored delegation, never a
    // project-wide capability. Reject trust_project before touching the row so
    // an approval replay or a forged trust pattern cannot bypass the one-shot
    // boundary.
    if (approval.details.tool === "ask_teammate" && body.decision === "trust_project") {
      throw new ApiError(400, "Teammate requests accept only a one-shot approval", "ASK_TEAMMATE_ONE_SHOT_ONLY");
    }

    // Derive the trust binding server-side from the persisted approval — never
    // from a client-supplied pattern — and validate it BEFORE mutating state.
    let trustKey: string | undefined;
    if (body.decision === "trust_project") {
      const d = approval.details as { executable?: unknown; args?: unknown; cwd?: unknown };
      if (approval.kind !== "command" || typeof d.executable !== "string") {
        throw new ApiError(400, "Only command approvals can be trusted", "INVALID_TRUST");
      }
      trustKey = canonicalCommandTrustKey(d.executable, Array.isArray(d.args) ? (d.args as string[]) : [], typeof d.cwd === "string" ? d.cwd : "");
    }

    const resolved = approvals.resolve(approvalId, { decision: body.decision, ...(body.note ? { note: body.note } : {}), resolvedAt: new Date().toISOString() });
    if (!resolved) throw new ApiError(409, "Approval is no longer pending", "APPROVAL_ALREADY_RESOLVED");
    if (trustKey) {
      approvals.grantCommandTrust({ projectId: approval.projectId, pattern: trustKey, createdAt: resolved.resolvedAt! });
    }
    records.appendEvent({
      id: crypto.randomUUID(),
      taskId: approval.taskId,
      type: "approval.resolved",
      payload: { approvalId, decision: body.decision },
      createdAt: resolved.resolvedAt!,
    });

    const t = tasks.getTaskById(approval.taskId);
    const runnerIsActive = deps.runner.isActive(approval.taskId);
    // Direct executor callers (including recovery tests and embedding hosts)
    // may not be registered with TaskRunner, but a live execution lease still
    // proves that an in-process waiter can consume the approval wake-up.
    const runningSegment = executionContinuityRepo.getRunningSegment(approval.taskId);
    const executorLeaseLive = runningSegment ? executionLeaseOwnerStatus(runningSegment.ownerId) === "alive" : false;
    if (t && (t.status === "interrupted" || ((t.status === "running" || t.status === "queued") && !runnerIsActive && !executorLeaseLive))) {
      // Resume work left without an in-process waiter by a restart. Queue it
      // before re-dispatch so the executor's normal durable continuation path
      // can consume the resolved approval safely.
      deps.db.prepare("UPDATE tasks SET status='queued', updated_at=? WHERE id=?").run(new Date().toISOString(), approval.taskId);
      const runningSegment = executionContinuityRepo.getRunningSegment(approval.taskId);
      const checkpoint = executionContinuityRepo.latestCheckpoint(approval.taskId);
      const leaseStatus = executionLeaseOwnerStatus(runningSegment?.ownerId ?? null);
      const resume = runningSegment && checkpoint && leaseStatus === "dead"
        ? (() => {
          const ownerId = createExecutionLeaseOwnerId();
          const leaseExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
          const claim = executionContinuityRepo.claimResumableSegment({
            taskId: approval.taskId,
            ownerId,
            expectedOwnerId: runningSegment.ownerId,
            expectedGeneration: runningSegment.generation,
            takeoverReason: "owner_dead",
            now: new Date().toISOString(),
            leaseExpiresAt,
          });
          return claim ? {
            resumeCheckpoint: true as const,
            checkpointCursor: claim.checkpointCursor,
            executionLease: { segmentId: claim.segment.id, ownerId, generation: claim.segment.generation },
          } : undefined;
        })()
        : undefined;
      deps.runner.run(approval.taskId, { recovered: true, ...(resume ?? {}) });
    } else if (t && (t.status === "running" || t.status === "queued")) {
      // Wake the live, in-process task.
      ApprovalContinuationRegistry.resolveApproval(approvalId, body.decision);
    } else {
      // Task already ended (failed/cancelled/completed). The decision is
      // recorded, but a dead task is never revived; drop any latched wakeup.
      ApprovalContinuationRegistry.clear(approvalId);
    }
    if (t?.missionId) deps.missionControllerRunner?.wake(t.missionId);

    return resolved;
  });

  app.get("/api/projects/:projectId/command-trusts", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return approvals.listCommandTrusts(projectId);
  });

  app.delete("/api/projects/:projectId/command-trusts", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = z.object({ pattern: z.string().trim().min(1).max(240) }).parse(request.body);
    if (!approvals.revokeCommandTrust(projectId, body.pattern)) throw new ApiError(404, "Command trust not found", "NOT_FOUND");
    reply.status(204).send();
  });

  // Backward-compatible summary of the active default provider (no secrets).
  app.get("/api/provider/status", async () => {
    if (process.env.MOCK_PROVIDER === "true") {
      return { configured: true, provider: "mock", model: "mock-model" };
    }
    const routed = routePreset(DEFAULT_PRESET_ID, process.env);
    if (routed.ok) {
      return { configured: true, provider: routed.decision.providerId, model: routed.decision.model };
    }
    const anyConfigured = listProviderStatuses().find((s) => s.configured);
    if (anyConfigured) {
      return { configured: true, provider: anyConfigured.id, model: anyConfigured.defaultModel ?? "" };
    }
    return { configured: false, provider: "none", model: "" };
  });

  // Full provider status list (configured/available, capabilities, endpoint host).
  app.get("/api/providers", async () => listProviderStatuses());

  // Live rate-limit guard state: which providers are cooling down and for how long.
  app.get("/api/providers/rate-limits", async () => globalRateGuard.snapshot());

  // Capability matrix for the UI.
  app.get("/api/providers/capabilities", async () =>
    listProviderStatuses().map((s) => ({
      id: s.id,
      label: s.label,
      kind: s.kind,
      configured: s.configured,
      capabilities: s.capabilities,
    }))
  );

  // Honest OAuth integration findings (static, informational).
  app.get("/api/providers/oauth", async () => OAUTH_FINDINGS);

  // Live subscription-OAuth connection status (connected/expired/disconnected),
  // never includes any token material.
  app.get("/api/providers/oauth/status", async () => oauthStatuses(process.env));

  // Begin a subscription sign-in: returns the authorization URL the user opens
  // in their browser. The PKCE verifier is held server-side until exchange.
  app.post("/api/providers/:providerId/oauth/start", async (request) => {
    const { providerId } = request.params as { providerId: string };
    if (!isOAuthProvider(providerId)) {
      throw new ApiError(400, `Provider "${providerId}" does not support subscription OAuth.`, "OAUTH_UNSUPPORTED");
    }
    return startAuthorization(providerId);
  });

  // Complete sign-in: the user pastes the authorization code (or full redirect
  // URL) returned by the provider. Tokens are exchanged and stored locally.
  app.post("/api/providers/:providerId/oauth/exchange", async (request) => {
    const { providerId } = request.params as { providerId: string };
    if (!isOAuthProvider(providerId)) {
      throw new ApiError(400, `Provider "${providerId}" does not support subscription OAuth.`, "OAUTH_UNSUPPORTED");
    }
    const body = z.object({ code: z.string().min(1).max(8192) }).strict().parse((request.body ?? {}) as unknown);
    let result;
    try {
      result = await exchangeCode(providerId, body.code, process.env);
    } catch (e: any) {
      throw new ApiError(400, e?.message || "Failed to complete sign-in.", "OAUTH_EXCHANGE_FAILED");
    }
    const authMode = listProviderStatuses().find((item) => item.id === providerId)?.authMode;
    void refreshProviderModelDiscovery(providerId as ProviderId, authMode);
    return result;
  });

  // Sign out: remove stored tokens for a provider.
  app.post("/api/providers/:providerId/oauth/signout", async (request) => {
    const { providerId } = request.params as { providerId: string };
    if (!isOAuthProvider(providerId)) {
      throw new ApiError(400, `Provider "${providerId}" does not support subscription OAuth.`, "OAUTH_UNSUPPORTED");
    }
    signOut(providerId, process.env);
    return { ok: true, provider: providerId };
  });

  // Bounded, server-side connectivity test for a single provider. The request is
  // made with credentials from the server environment; the response never
  // contains the key or any header value — only the host and a normalized result.
  app.post("/api/providers/:providerId/test", async (request) => {
    const { providerId } = request.params as { providerId: string };
    const parsed = ProviderIdSchema.safeParse(providerId);
    if (!parsed.success) throw new ApiError(400, `Unknown provider: ${providerId}`, "INVALID_PROVIDER");
    return refreshProviderModelDiscovery(parsed.data);
  });

  // Explicit account-catalogue refresh; unlike startup refresh this bypasses
  // the TTL because it is a user-directed verification action.
  app.post("/api/providers/:providerId/models/refresh", async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const parsed = ProviderIdSchema.safeParse(providerId);
    if (!parsed.success) throw new ApiError(400, `Unknown provider: ${providerId}`, "INVALID_PROVIDER");
    const result = await refreshProviderModelDiscovery(parsed.data);
    if (result.errorKind === "cancelled") reply.code(409);
    return result;
  });

  // Save provider credentials from the app (no PowerShell / env vars / restart).
  // The key is written to the server-side secrets file AND hot-applied to the
  // running process so it takes effect immediately. The response never echoes
  // the secret — only the refreshed, non-secret provider status.
  app.post("/api/providers/:providerId/configure", async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const parsed = ProviderIdSchema.safeParse(providerId);
    if (!parsed.success) throw new ApiError(400, `Unknown provider: ${providerId}`, "INVALID_PROVIDER");
    const id = parsed.data;
    const mapping = providerEnvMapping(id);
    if (!mapping) {
      throw new ApiError(400, `Provider "${id}" cannot be configured in-app.`, "PROVIDER_NOT_CONFIGURABLE");
    }
    if (!deps.secretsFile) {
      throw new ApiError(503, "In-app provider configuration is unavailable on this server.", "SECRETS_UNAVAILABLE");
    }
    // Reject control characters (newlines especially): persisted values land in a
    // line-oriented KEY=VALUE secrets file, so a smuggled newline could inject an
    // unrelated env var. The secrets module enforces this too; refining here turns
    // it into a clean 400 instead of a 500.
    const noControlChars = (label: string) =>
      z.string().refine((v) => !/[\x00-\x1f\x7f]/.test(v), { message: `${label} must not contain control characters` });
    const body = z
      .object({
        apiKey: noControlChars("apiKey").max(8192).optional(),
        baseUrl: z.string().max(2048).optional(),
        model: noControlChars("model").max(256).optional(),
        endpointContextLimit: z.union([z.number().int().positive(), z.literal("")]).optional(),
      })
      .strict()
      .parse((request.body ?? {}) as unknown);
    if (body.apiKey === undefined && body.baseUrl === undefined && body.model === undefined && body.endpointContextLimit === undefined) {
      throw new ApiError(400, "Nothing to configure (provide apiKey, baseUrl, model, or endpointContextLimit).", "EMPTY_CONFIGURE");
    }
    // OpenRouter's own pinned-endpoint rejection must win over the generic
    // "this provider has no baseUrlEnv" check below — OpenRouter has no
    // baseUrlEnv precisely because its endpoint is pinned, so the generic
    // check would otherwise always fire first and the more specific, more
    // informative OpenRouter message would be unreachable.
    if (id === "openrouter" && body.baseUrl !== undefined) {
      throw new ApiError(400, "OpenRouter uses a pinned official endpoint and does not accept baseUrl overrides.", "OPENROUTER_ENDPOINT_PINNED");
    }
    if (body.baseUrl !== undefined && !mapping.baseUrlEnv) {
      throw new ApiError(400, `Provider "${id}" does not support a custom endpoint.`, "CUSTOM_ENDPOINT_UNSUPPORTED");
    }
    if (body.baseUrl !== undefined && body.baseUrl.trim() !== "") {
      try {
        const u = new URL(body.baseUrl.trim());
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
      } catch {
        throw new ApiError(400, "baseUrl must be a valid http(s) URL.", "INVALID_BASE_URL");
      }
    }
    let validatedResult: Awaited<ReturnType<typeof testProviderConnectivity>> | null = null;
    let validatedCredentialIdentity: string | null = null;

    /*
     * Verify a candidate credential against the provider BEFORE persisting it.
     *
     * This used to run for OpenRouter alone, which meant OpenRouter was the
     * only provider where a mistyped key was rejected instead of silently
     * overwriting a working one, and the only provider whose models were known
     * straight after setup. Every other provider — including all 22 catalog
     * providers — saved whatever it was given and reported "connected".
     *
     * Two providers are exempt because there is nothing to verify: `mock` is an
     * in-memory test double, and `deterministic-local` performs no inference.
     */
    const providerLabel = listProviderStatuses().find((item) => item.id === id)?.label ?? id;
    const isLocalProvider = providerCapabilities(id)?.local ?? false;
    // Only a change to the credential or the endpoint is worth verifying.
    // A request that just sets a default model or a context limit touches
    // nothing a provider could reject, and demanding a live check for it would
    // make those settings impossible to save on a provider that is not yet
    // connected — or while the network happens to be down.
    const touchesCredential = body.apiKey !== undefined || body.baseUrl !== undefined;
    const candidateEnv = touchesCredential ? buildProviderCandidateEnv(id, body, process.env) : process.env;
    // Ask the credential layer directly rather than going through provider
    // status: status gates `configured` on stored model discovery matching the
    // credential, which is false for a brand-new candidate key and would skip
    // the very verification this exists to perform.
    const candidateHasKey = mapping?.apiKeyEnv ? !!candidateEnv[mapping.apiKeyEnv]?.trim() : false;
    const candidateHasUrl = mapping?.baseUrlEnv ? !!candidateEnv[mapping.baseUrlEnv]?.trim() : false;
    const verifiable =
      id !== "mock" &&
      id !== "deterministic-local" &&
      touchesCredential &&
      (candidateHasKey || candidateHasUrl);

    if (verifiable) {
      const previousCredentialIdentity = providerCredentialIdentity(id, process.env);
      validatedCredentialIdentity = providerCredentialIdentity(id, candidateEnv);
      validatedResult = await providerConnectivityTest(id, candidateEnv);
      if (providerCredentialIdentity(id, process.env) !== previousCredentialIdentity) {
        throw new ApiError(409, `${providerLabel} configuration changed while validation was in flight. Retry with the current settings.`, "PROVIDER_CONFIGURATION_CONFLICT");
      }
      if (!validatedResult.ok) {
        // A local server is opt-in by URL and is routinely configured before it
        // is started, so "nothing is listening yet" must not block saving the
        // address. Any other failure — and every failure for a hosted provider
        // — preserves the previous credential rather than replacing a working
        // one with a broken one.
        const localNotRunningYet =
          isLocalProvider && (validatedResult.errorKind === "network" || validatedResult.errorKind === "timeout");
        if (!localNotRunningYet) {
          const statusCode = validatedResult.errorKind === "auth" ? 401 : validatedResult.errorKind === "rate_limit" ? 429 : 502;
          throw new ApiError(statusCode, `${providerLabel} validation failed (${validatedResult.errorKind ?? "provider"}). The previous credential was preserved.`, "PROVIDER_VALIDATION_FAILED");
        }
        validatedResult = null; // Nothing verified, so nothing to record.
      }
    }

    const result = configureProvider(deps.secretsFile, id, body, process.env);

    // Record what the credential can actually reach, so a provider is useful
    // the moment it is configured instead of after a separate refresh.
    if (validatedResult) {
      const fetchedAt = new Date().toISOString();
      const authMode = listProviderStatuses().find((item) => item.id === id)?.authMode;
      if (authMode) {
        providerModelDiscovery.upsert({
          providerId: id,
          authMode,
          status: "available",
          models: validatedResult.models,
          errorKind: null,
          fetchedAt,
          expiresAt: discoveryExpiresAt(fetchedAt, true),
          lastSuccessAt: fetchedAt,
          credentialIdentity: validatedCredentialIdentity,
        });
        installProviderModelDiscoveries(providerModelDiscovery.list());
      }
    }
    const status = listProviderStatuses().find((s) => s.id === id) ?? null;
    reply.send({
      ok: true,
      provider: id,
      written: result.written,
      cleared: result.cleared,
      securePermissions: result.securePermissions,
      credentialProtection: result.credentialProtection,
      shadowedByEnv: result.shadowedByEnv,
      /*
       * Whether saving this credential actually proved it works.
       *
       * `true`  — the provider authenticated it.
       * `false` — the endpoint answered but serves its model list without
       *           authentication (OpenCode Zen does), so a wrong key is
       *           indistinguishable from a right one here and would only fail
       *           on the first real request. The client must say so rather than
       *           report a plain "connected".
       * `null`  — nothing was verified (a local server that is not running
       *           yet, or a request that changed no credential).
       */
      credentialVerified: validatedResult ? validatedResult.credentialVerified ?? null : null,
      status,
    });
  });

  // Remove all stored credentials for a provider (file + running process).
  app.delete("/api/providers/:providerId/credentials", async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const parsed = ProviderIdSchema.safeParse(providerId);
    if (!parsed.success) throw new ApiError(400, `Unknown provider: ${providerId}`, "INVALID_PROVIDER");
    const id = parsed.data;
    if (!providerEnvMapping(id)) {
      throw new ApiError(400, `Provider "${id}" has no stored credentials.`, "PROVIDER_NOT_CONFIGURABLE");
    }
    if (!deps.secretsFile) {
      throw new ApiError(503, "In-app provider configuration is unavailable on this server.", "SECRETS_UNAVAILABLE");
    }
    const { removed } = removeProviderCredentials(deps.secretsFile, id, process.env);
    const status = listProviderStatuses().find((s) => s.id === id) ?? null;
    reply.send({ ok: true, provider: id, removed, status });
  });

  // Read-only snapshot of this install's hosted-account pairing (Plans/
  // generic-sprouting-dragon.md Phase 4). Never contacts hosted-api directly —
  // reports whatever the background EntitlementPoller last observed. A missing
  // poller (e.g. tests) degrades to a plain "unpaired" snapshot rather than an
  // error, matching how secretsFile-absent degrades the provider routes above.
  app.get("/api/pairing/status", async () => {
    const snapshot = deps.entitlementPoller?.getSnapshot() ?? {
      status: "unpaired" as const,
      accountId: null,
      planId: null,
      checkedAt: null,
      lastError: null,
    };
    return PairingStatusResponseSchema.parse({ version: 1, ...snapshot });
  });

  // Redeem a one-time pairing code (shown on the hosted dashboard) against
  // hosted-api. Outbound only — never accepts an inbound connection from the
  // dashboard, so the loopback-only local-guard above is untouched.
  app.post("/api/pairing/redeem", async (request, reply) => {
    if (!deps.secretsFile) {
      throw new ApiError(503, "Pairing is unavailable on this server.", "SECRETS_UNAVAILABLE");
    }
    const hostedApiUrl = resolveHostedApiUrl(process.env);
    const body = RedeemPairingCodeSchema.parse(request.body ?? {});
    const result = await redeemPairingCode(
      { hostedApiUrl },
      { code: normalizePairingCode(body.code), deviceLabel: body.deviceLabel?.trim() || hostname() },
    );
    if (!result.ok) {
      const statusCode = result.status === 404 ? 404 : result.status >= 400 && result.status < 500 ? result.status : 502;
      throw new ApiError(statusCode, result.message, result.code);
    }
    writeHostedPairing(deps.secretsFile, {
      deviceToken: result.deviceToken,
      accountId: result.accountId,
      pairedAgentId: result.pairedAgentId,
    });
    void deps.entitlementPoller?.checkNow();
    reply.send(RedeemPairingCodeResultSchema.parse({ version: 1, paired: true, accountId: result.accountId }));
  });

  // Safe read-only tool catalog and the enforced permission profile.
  app.get("/api/tools", async () => TOOL_CATALOG);
  app.get("/api/permissions", async () => PERMISSION_PROFILE);

  // Audit: a truthful record of executed tasks with their disclosure, tool-call
  // count, and evidence count. Detailed per-run audit reuses GET /api/tasks/:id.
  app.get("/api/audit", async (request) => {
    const { projectId, limit } = request.query as { projectId?: string; limit?: string };
    const max = Math.min(Math.max(parseInt(limit ?? "50", 10) || 50, 1), 500);
    const where = projectId ? "WHERE t.project_id = ?" : "";
    const rows = deps.db
      .prepare(
        `SELECT t.id AS task_id, t.project_id, t.type AS kind, t.status, t.created_at,
                d.provider, d.network_access,
                (SELECT COUNT(*) FROM message_tool_calls mtc WHERE mtc.task_id = t.id) AS tool_calls,
                (SELECT COUNT(*) FROM task_evidence te WHERE te.task_id = t.id) AS evidence
         FROM tasks t LEFT JOIN execution_disclosures d ON d.task_id = t.id
         ${where} ORDER BY t.created_at DESC, t.id DESC LIMIT ?`
      )
      .all(...(projectId ? [projectId, max] : [max])) as any[];
    return rows.map((r) => {
      const routing = routingRepo.get(r.task_id)?.decision ?? null;
      return {
        taskId: r.task_id,
        projectId: r.project_id,
        kind: r.kind,
        status: r.status,
        provider: r.provider ?? routing?.providerId ?? null,
        model: routing?.model ?? null,
        networkAccess: r.network_access ?? null,
        toolCalls: Number(r.tool_calls),
        evidence: Number(r.evidence),
        createdAt: r.created_at,
      };
    });
  });

  // Built-in model registry with availability derived from configured providers.
  app.get("/api/models", async () => {
    const statuses = listProviderStatuses();
    return resolveModelStatuses(statuses, providerModelDiscovery.list());
  });

  // Explicit refresh makes public catalog egress visible to the operator. It
  // is deliberately not a startup side effect so local-only mode stays local.
  app.post("/api/models/refresh", async () => {
    try {
      const snapshot = await refreshModelCatalog();
      return { ...snapshot, refreshed: true };
    } catch {
      throw new ApiError(502, "Model catalog refresh failed; cached metadata remains active.", "MODEL_CATALOG_REFRESH_FAILED");
    }
  });

  /**
   * The canonical per-model budget view — every number here comes from the
   * single resolveModelBudget() computation (routing/model-budget.ts), the
   * same function every agent execution path uses. This exists so the CLI's
   * model picker/detail panel can show real usable-input/reserve/confidence
   * numbers for a model it hasn't sent a request with yet, without ever
   * re-deriving that math itself. Providers that are not configured resolve
   * against a null/"unknown" endpoint route (never a live credential lookup,
   * and never a thrown error) so an unconfigured provider can't crash this.
   */
  app.get("/api/models/budgets", async () => {
    const budgetStatuses = listProviderStatuses();
    const configuredIds = new Set(budgetStatuses.filter((s) => s.configured).map((s) => s.id));
    const budgetModels = [...listModels(), ...listConfiguredCustomModels(budgetStatuses)];
    return budgetModels.map((model): unknown => {
      const configured = configuredIds.has(model.providerId);
      let route: ProviderRouteMetadata;
      try {
        route = configured
          ? createProvider(model.providerId, process.env, model.id).route ?? {
              providerId: model.providerId, protocol: "openai-chat", endpointKind: "injected", endpointHost: null,
              endpointLimitTokens: null, endpointLimitSource: "unknown",
            }
          : {
              providerId: model.providerId, protocol: "openai-chat", endpointKind: "injected", endpointHost: null,
              endpointLimitTokens: null, endpointLimitSource: "unknown",
            };
      } catch {
        route = {
          providerId: model.providerId, protocol: "openai-chat", endpointKind: "injected", endpointHost: null,
          endpointLimitTokens: null, endpointLimitSource: "unknown",
        };
      }
      const budget = resolveModelBudget({
        providerId: model.providerId,
        selectedModel: model.id,
        endpoint: { kind: route.endpointKind, host: route.endpointHost, protocol: route.protocol, limitTokens: route.endpointLimitTokens, limitSource: route.endpointLimitSource },
      });
      const metadata = resolveModelMetadata(model.providerId, model.id);
      return {
        providerId: budget.providerId,
        selectedModelId: budget.selectedModelId,
        canonicalModelId: budget.canonicalModelId,
        displayName: budget.displayName,
        configured,
        protocol: budget.protocol,
        endpointKind: budget.endpointKind,
        endpointHost: budget.endpointHost,
        contextWindowTokens: budget.contextWindowTokens,
        // Route-aware capacity diagnostics, straight from the same
        // resolveModelBudget() call above — never re-derived here. See
        // routing/effective-context.ts for how native/route/effective relate.
        nativeContextWindowTokens: budget.nativeContextWindowTokens,
        nativeContextWindowSource: budget.nativeContextWindowSource,
        routeLimitTokens: budget.routeLimitTokens,
        routeLimitSource: budget.routeLimitSource,
        effectiveContextWindowTokens: budget.effectiveContextWindowTokens,
        contextWindowConfidence: configured ? budget.contextWindowConfidence : "unverified",
        usableInputTokens: budget.usableInputTokens,
        outputReserveTokens: budget.outputReserveTokens,
        totalReserveTokens: budget.totalReserveTokens,
        harnessReserveTokens: budget.harnessReserveTokens,
        compactionThresholdTokens: budget.compactionThresholdTokens,
        compactionThresholdRatio: budget.compactionThresholdRatio,
        capabilities: budget.capabilities,
        pricing: metadata.pricing,
        reasoning: budget.reasoning,
        // Provenance of the descriptive capability flags themselves (vision,
        // tool calls, …) — distinct from contextWindowConfidence, which is
        // specifically about the size numbers.
        capabilitySource: metadata.capabilitySource ?? "unknown",
      };
    });
  });

  // Presets with live availability + resolved provider/model. In mock mode every
  // preset resolves to the mock provider so the UI reflects what will actually run.
  app.get("/api/presets", async () => {
    if (process.env.MOCK_PROVIDER === "true") {
      return listPresets().map((preset) => ({ preset, available: true, unavailableReason: null, resolved: { providerId: "mock", model: "mock-model" } }));
    }
    return listPresetStatuses();
  });

  // ── Memory ──────────────────────────────────────────────────────────────────

  app.get("/api/memory/settings", async () => {
    const row = deps.db.prepare("SELECT value FROM settings WHERE key = ?").get("memory.autoCapture") as { value?: string } | undefined;
    return { autoCapture: row?.value !== "false" };
  });

  app.patch("/api/memory/settings", async (request) => {
    const body = z.object({ autoCapture: z.boolean() }).strict().parse(request.body);
    deps.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)")
      .run("memory.autoCapture", String(body.autoCapture));
    return body;
  });

  app.get("/api/search", async (request) => {
    const q = z
      .object({
        q: z.string().max(500).optional().default(""),
        kind: z.union([SearchKindSchema, z.array(SearchKindSchema)]).optional(),
        limit: z.coerce.number().int().positive().max(100).optional().default(25),
      })
      .parse(request.query);
    const kinds = q.kind === undefined ? undefined : Array.isArray(q.kind) ? q.kind : [q.kind];
    const hits = projects
      .listProjects()
      .flatMap((project) => search.search(project.id, q.q, { ...(kinds ? { kinds } : {}), limit: q.limit }).hits)
      .sort((left, right) => left.score - right.score || right.createdAt.localeCompare(left.createdAt))
      .slice(0, q.limit);
    return GlobalSearchResponseSchema.parse({ version: 1, query: q.q, total: hits.length, hits });
  });

  app.get("/api/projects/:projectId/search", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const q = z
      .object({
        q: z.string().max(500).optional().default(""),
        kind: z.union([SearchKindSchema, z.array(SearchKindSchema)]).optional(),
        conversationId: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
      })
      .parse(request.query);
    const kinds = q.kind === undefined ? undefined : Array.isArray(q.kind) ? q.kind : [q.kind];
    return search.search(projectId, q.q, {
      ...(kinds ? { kinds } : {}),
      ...(q.conversationId ? { conversationId: q.conversationId } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
  });

  app.post("/api/projects/:projectId/symbols/rebuild", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return symbolIndex.rebuildProject(projectId, project.workspacePath);
  });

  app.post("/api/projects/:projectId/symbols/refresh", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return symbolIndex.refreshProject(projectId, project.workspacePath);
  });

  app.get("/api/projects/:projectId/symbols/status", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return symbolIndexRepo.status(projectId);
  });

  app.get("/api/projects/:projectId/symbols/search", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const query = z.object({ q: z.string().max(200).optional().default(""), limit: z.coerce.number().int().positive().max(200).optional() }).parse(request.query);
    return { version: 1, query: query.q, projectId, symbols: symbolIndexRepo.search(projectId, query.q, query.limit === undefined ? {} : { limit: query.limit }) };
  });

  app.get("/api/projects/:projectId/symbols/definition", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const query = z.object({ name: z.string().trim().min(1).max(200) }).parse(request.query);
    const symbol = symbolIndexRepo.findDefinition(projectId, query.name);
    if (!symbol) throw new ApiError(404, "Symbol not found", "NOT_FOUND");
    return symbol;
  });

  app.get("/api/projects/:projectId/symbols/file", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const query = z.object({ path: z.string().trim().min(1).max(1024) }).parse(request.query);
    return { version: 1, projectId, filePath: query.path, symbols: symbolIndexRepo.listFileSymbols(projectId, query.path) };
  });

  const messageAdapters = deps.messageAdapters ?? loadAdaptersFromEnv(process.env);
  app.post("/api/notify", async (request) => {
    const body = NotifyRequestSchema.parse(request.body);
    const results = await notifyAll(messageAdapters, { text: body.text, ...(body.subject ? { subject: body.subject } : {}) });
    return { sent: results.filter((r) => r.ok).length, results };
  });

  const diagnosticsRunner = deps.diagnosticsRunner ?? defaultDiagnosticsRunner;
  app.get("/api/projects/:projectId/diagnostics", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const { tool } = z.object({ tool: DiagnosticToolSchema.default("tsc") }).parse(request.query);
    const result = await diagnosticsRunner(tool, project.workspacePath);
    const text = tool === "tsc" ? `${result.stdout}\n${result.stderr}` : result.stdout;
    const diagnostics = tool === "tsc" ? parseTscDiagnostics(text) : parseEslintDiagnostics(result.stdout);
    return summarizeDiagnostics(tool, diagnostics);
  });

  app.get("/api/projects/:projectId/schedules", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return schedules.listByProject(projectId);
  });

  app.get("/api/projects/:projectId/schedule-notification-options", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    // Adapter ids and channels are safe metadata only. URLs, bot tokens, and
    // any other credentials remain server-side and never cross this boundary.
    return ScheduleNotificationOptionsSchema.parse({
      version: 1,
      projectId,
      adapters: messageAdapters.map((adapter) => ({ id: adapter.id, channel: adapter.channel })),
    });
  });

  const validateScheduleNotification = (projectId: string, notification: { adapterId: string | null; events: readonly string[] }) => {
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    if (notification.adapterId !== null && !messageAdapters.some((adapter) => adapter.id === notification.adapterId)) {
      throw new ApiError(400, "Notification adapter is not configured", "INVALID_NOTIFICATION_ADAPTER");
    }
  };

  const defaultScheduleNotification = {
    events: ["completed", "failed", "blocked"] as ScheduleNotificationEvent[],
    adapterId: null,
  };

  /** Resolve a routine schedule's durable target at create/edit time. */
  const scheduleTarget = (projectId: string, taskKind: "inspect_workspace" | "routine", routineId: string | null | undefined, enabled = true) => {
    if (taskKind !== "routine") {
      if (routineId) throw new ApiError(400, "routineId is only valid for routine schedules", "INVALID_SCHEDULE_TARGET");
      return { routineId: null, agentId: null };
    }
    if (!routineId) throw new ApiError(400, "routineId is required for routine schedules", "ROUTINE_REQUIRED");
    const routine = routines.get(routineId);
    if (!routine || routine.projectId !== projectId) throw new ApiError(404, "Routine not found in this project", "NOT_FOUND");
    // Pausing a schedule must remain possible even when its teammate was
    // disabled; re-enabling and firing still re-evaluate the target.
    if (enabled) {
      try {
        assertRoutineTarget(deps.db, routine, { requireAgent: true });
      } catch (error) {
        if (error instanceof AgentTaskDispatchError) throw new ApiError(error.statusCode, error.message, error.code);
        throw error;
      }
    }
    return { routineId: routine.id, agentId: routine.agentId };
  };

  const createSchedule = (projectId: string, bodyInput: unknown) => {
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = CreateScheduleSchema.parse(bodyInput);
    try {
      assertValidCron(body.cron);
    } catch (error) {
      throw new ApiError(400, `Invalid cron expression: ${(error as Error).message}`, "VALIDATION_ERROR");
    }
    // A newly-created binding must be valid even if the user starts it
    // paused; resuming later should not hide a bad target behind that pause.
    const target = scheduleTarget(projectId, body.taskKind, body.routineId ?? null, true);
    if (body.taskKind !== "routine" && body.notification !== undefined) {
      throw new ApiError(400, "Notification preferences are only supported for routine schedules", "NOTIFICATION_UNSUPPORTED_FOR_TASK_KIND");
    }
    const notification = body.notification === undefined
      ? defaultScheduleNotification
      : {
        events: body.notification.events ?? defaultScheduleNotification.events,
        adapterId: body.notification.adapterId ?? null,
      };
    validateScheduleNotification(projectId, notification);
    const now = new Date().toISOString();
    return schedules.create({
      id: crypto.randomUUID(),
      projectId,
      cron: body.cron,
      taskKind: body.taskKind,
      ...target,
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      notification,
      nextRunAt: nextRun(body.cron, new Date()).toISOString(),
      createdAt: now,
      updatedAt: now,
    });
  };

  app.post("/api/projects/:projectId/schedules", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const created = createSchedule(projectId, request.body);
    reply.status(201);
    return created;
  });

  const updateSchedule = (projectId: string, scheduleId: string, bodyInput: unknown) => {
    const current = schedules.get(scheduleId);
    if (!current || current.projectId !== projectId) throw new ApiError(404, "Schedule not found", "NOT_FOUND");
    const body = UpdateScheduleSchema.parse(bodyInput);
    const taskKind = body.taskKind ?? current.taskKind;
    const routineId = body.routineId !== undefined ? body.routineId : taskKind === "routine" ? current.routineId : null;
    const enabled = body.enabled ?? current.enabled;
    const target = scheduleTarget(projectId, taskKind, routineId, enabled);
    if (taskKind !== "routine" && body.notification !== undefined) {
      throw new ApiError(400, "Notification preferences are only supported for routine schedules", "NOTIFICATION_UNSUPPORTED_FOR_TASK_KIND");
    }
    // A routine -> inspect transition cannot carry the routine-only policy.
    // Clear an omitted policy as part of the effective update so a stale
    // adapter selection can never fan out if this schedule later changes back.
    const notification = taskKind !== "routine"
      ? defaultScheduleNotification
      : {
        events: body.notification?.events ?? current.notification.events,
        adapterId: body.notification?.adapterId !== undefined ? body.notification.adapterId : current.notification.adapterId,
      };
    validateScheduleNotification(projectId, notification);
    const cron = body.cron ?? current.cron;
    try {
      assertValidCron(cron);
    } catch (error) {
      throw new ApiError(400, `Invalid cron expression: ${(error as Error).message}`, "VALIDATION_ERROR");
    }
    const now = new Date().toISOString();
    return schedules.update({
      id: scheduleId,
      projectId,
      cron,
      taskKind,
      ...target,
      enabled,
      notification,
      // A changed cron starts from the next future boundary. Pause/resume
      // without changing cron preserves the pending occurrence so resume is
      // deterministic and does not silently drop work.
      nextRunAt: body.cron !== undefined ? nextRun(cron, new Date()).toISOString() : current.nextRunAt,
      updatedAt: now,
    })!;
  };

  app.patch("/api/projects/:projectId/schedules/:scheduleId", async (request) => {
    const { projectId, scheduleId } = request.params as { projectId: string; scheduleId: string };
    return updateSchedule(projectId, scheduleId, request.body);
  });

  // A body-carried project id keeps this alias compatible with the existing
  // id-addressed schedule routes while retaining project ownership checks.
  app.patch("/api/schedules/:scheduleId", async (request) => {
    const { scheduleId } = request.params as { scheduleId: string };
    const body = z.object({ projectId: z.string().min(1) }).passthrough().parse(request.body);
    const schedule = schedules.get(scheduleId);
    if (!schedule) throw new ApiError(404, "Schedule not found", "NOT_FOUND");
    const input = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "projectId"));
    return updateSchedule(body.projectId, scheduleId, input);
  });

  const setSchedulePaused = (scheduleId: string, enabled: boolean, projectId: string) => {
    const schedule = schedules.get(scheduleId);
    if (!schedule || schedule.projectId !== projectId) throw new ApiError(404, "Schedule not found", "NOT_FOUND");
    return schedules.setEnabled(scheduleId, enabled)!;
  };

  app.post("/api/schedules/:scheduleId/pause", async (request) => {
    const { scheduleId } = request.params as { scheduleId: string };
    const body = z.object({ projectId: z.string().min(1) }).strict().parse(request.body);
    return setSchedulePaused(scheduleId, false, body.projectId);
  });
  app.post("/api/schedules/:scheduleId/resume", async (request) => {
    const { scheduleId } = request.params as { scheduleId: string };
    const body = z.object({ projectId: z.string().min(1) }).strict().parse(request.body);
    const schedule = schedules.get(scheduleId);
    if (!schedule || schedule.projectId !== body.projectId) throw new ApiError(404, "Schedule not found", "NOT_FOUND");
    // Revalidate routine targets when a paused schedule becomes active.
    if (schedule.taskKind === "routine") scheduleTarget(schedule.projectId, schedule.taskKind, schedule.routineId, true);
    return setSchedulePaused(scheduleId, true, body.projectId);
  });

  app.delete("/api/schedules/:scheduleId", async (request, reply) => {
    const { scheduleId } = request.params as { scheduleId: string };
    const schedule = schedules.get(scheduleId);
    if (!schedule) throw new ApiError(404, "Schedule not found", "NOT_FOUND");
    const body = z.object({ projectId: z.string().min(1) }).strict().parse(request.body);
    if (body.projectId !== schedule.projectId) throw new ApiError(404, "Schedule not found", "NOT_FOUND");
    schedules.delete(scheduleId);
    reply.status(204).send();
  });

  const listScheduleRuns = (scheduleId: string, projectId?: string) => {
    const schedule = schedules.get(scheduleId);
    if (schedule && projectId && schedule.projectId !== projectId) throw new ApiError(404, "Schedule not found", "NOT_FOUND");
    const runs = schedules.listRuns(scheduleId);
    if (projectId && runs.some((run) => run.projectId !== projectId)) throw new ApiError(404, "Schedule not found", "NOT_FOUND");
    return runs.map((run) => ScheduleRunSchema.parse(run));
  };

  app.get("/api/schedules/:scheduleId/runs", async (request) => {
    const { scheduleId } = request.params as { scheduleId: string };
    const { projectId } = z.object({ projectId: z.string().min(1) }).strict().parse(request.query);
    return listScheduleRuns(scheduleId, projectId);
  });
  app.get("/api/projects/:projectId/schedules/:scheduleId/runs", async (request) => {
    const { projectId, scheduleId } = request.params as { projectId: string; scheduleId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return listScheduleRuns(scheduleId, projectId);
  });
  app.get("/api/projects/:projectId/schedule-runs", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const query = z.object({ limit: z.coerce.number().int().positive().max(500).optional() }).parse(request.query);
    return schedules.listRunsByProject(projectId, query.limit);
  });

  app.post("/api/schedules/:scheduleId/run", async (request, reply) => {
    const { scheduleId } = request.params as { scheduleId: string };
    const schedule = schedules.get(scheduleId);
    if (!schedule) throw new ApiError(404, "Schedule not found", "NOT_FOUND");
    const requestBody = z.object({ projectId: z.string().min(1) }).strict().parse(request.body);
    if (requestBody.projectId !== schedule.projectId) throw new ApiError(404, "Schedule not found", "NOT_FOUND");
    if (schedule.taskKind === "routine") {
      const routine = schedule.routineId ? routines.get(schedule.routineId) : undefined;
      if (!routine || routine.projectId !== schedule.projectId) throw new ApiError(409, "Scheduled routine no longer exists in this project", "ROUTINE_MISSING");
      if (routine.agentId !== schedule.agentId) throw new ApiError(409, "Scheduled routine teammate binding changed", "AGENT_BINDING_CHANGED");
      try {
        assertRoutineTarget(deps.db, routine, { requireAgent: true });
      } catch (error) {
        if (error instanceof AgentTaskDispatchError) throw new ApiError(error.statusCode, error.message, error.code);
        throw error;
      }
      const now = new Date().toISOString();
      const run = schedules.createManualRun({ schedule, occurrenceAt: now, now });
      try {
        const result = dispatchRoutineTask(
          { db: deps.db, runner: deps.runner, env: process.env },
          routine,
          { requireAgent: true, idempotencyKey: `schedule:${schedule.id}:manual:${run.id}` },
        );
        schedules.markDispatched(run.id, result.task.id, now);
        reply.status(202);
        return { version: 1, scheduleId, runId: run.id, taskId: result.task.id, conversationId: result.conversationId, projectId: schedule.projectId, aggregateUrl: `/api/tasks/${result.task.id}` };
      } catch (error) {
        const code = error instanceof AgentTaskDispatchError ? error.code : "SCHEDULE_DISPATCH_FAILED";
        schedules.markBlocked(run.id, code, error, now);
        if (error instanceof AgentTaskDispatchError) throw new ApiError(error.statusCode, error.message, error.code);
        throw error;
      }
    }
    const taskId = crypto.randomUUID();
    tasks.createTask({ id: taskId, projectId: schedule.projectId, kind: schedule.taskKind, status: "queued", createdAt: new Date().toISOString() });
    deps.runner.run(taskId);
    reply.status(202);
    return { scheduleId, taskId, aggregateUrl: `/api/tasks/${taskId}` };
  });

  // List installed/discoverable skills for the Skills Control Center. Reads the
  // same directories the agent's find_skill/load_skill tools scan (the bundled
  // MORROW_SKILLS_DIR plus MORROW_HOME/skills), parsing each skill's manifest
  // and SKILL.md. No project context needed; this is the global skill registry.
  app.get("/api/skills", async () => {
    const dirs: string[] = [];
    if (process.env.MORROW_SKILLS_DIR) dirs.push(process.env.MORROW_SKILLS_DIR);
    const home = resolveMorrowHome(process.env);
    if (home) dirs.push(join(home, "skills"));
    const riskToTier: Record<string, string> = { low: "core", medium: "controlled", high: "experimental" };
    const categorize = (id: string): string => {
      if (/test/.test(id)) return "Testing";
      if (/review|audit|security|secret|dependency|adversarial/.test(id)) return "Security & Review";
      if (/git/.test(id)) return "Git";
      if (/doc/.test(id)) return "Documentation";
      if (/data|database/.test(id)) return "Data";
      if (/refactor|migration|performance|architecture/.test(id)) return "Refactoring";
      if (/debug|diagnostic|error|bug/.test(id)) return "Debugging";
      if (/file|shell|config|template|input/.test(id)) return "Files & Ops";
      if (/web-search|api|integration/.test(id)) return "Research & API";
      return "Development";
    };
    // Skills use one of two metadata formats: a manifest.json, or YAML
    // frontmatter at the top of SKILL.md. Support both.
    const parseFrontmatter = (md: string): Record<string, string> => {
      const fm: Record<string, string> = {};
      if (!md.startsWith("---")) return fm;
      const end = md.indexOf("\n---", 3);
      if (end === -1) return fm;
      for (const line of md.slice(3, end).split("\n")) {
        const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
        const key = m?.[1];
        if (key) fm[key] = (m?.[2] ?? "").trim().replace(/^["']|["']$/g, "");
      }
      return fm;
    };
    const pretty = (s: string): string =>
      /\s/.test(s) ? s : s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        const sdir = join(dir, entry);
        const mdPath = join(sdir, "SKILL.md");
        if (seen.has(entry)) continue;
        if (!existsSync(mdPath) || !lstatSync(sdir).isDirectory()) continue;
        const manifestPath = join(sdir, "manifest.json");
        if (!existsSync(manifestPath) && (!process.env.MORROW_SKILLS_DIR || resolve(dir) !== resolve(process.env.MORROW_SKILLS_DIR))) continue;
        if (existsSync(manifestPath) && !verifySkillDirectory(sdir).ok) continue;
        seen.add(entry);
        let manifest: any = {};
        try { manifest = JSON.parse(readFileSync(join(sdir, "manifest.json"), "utf8")); } catch {}
        const md = readFileSync(mdPath, "utf8");
        const fm = parseFrontmatter(md);
        const body = md.startsWith("---") && md.indexOf("\n---", 3) !== -1 ? md.slice(md.indexOf("\n---", 3) + 4) : md;
        const lines = body.split("\n").filter((l) => l.trim());
        const mdName = (lines[0] ?? "").replace(/^#\s*/, "").trim();
        const mdDesc = (lines.slice(1).find((l) => l.trim() && !l.startsWith("#")) ?? "").trim();
        const riskClass: string = manifest.riskClass || fm.riskClass || "";
        // Bundled high-risk red-team skills are intentionally not executable
        // through the default catalog. Keep their source available for an
        // explicit security-review workflow, but do not present them as
        // ordinary installed capabilities beside trusted skills.
        if (riskClass === "high") continue;
        out.push({
          id: manifest.id || fm.name || entry,
          name: pretty(manifest.name || fm.name || mdName || entry),
          description: manifest.description || fm.description || mdDesc || "",
          category: manifest.category || fm.category || categorize(entry),
          trustTier: riskToTier[riskClass] || "controlled",
          enabled: true,
          validation: "healthy",
          tools: Array.isArray(manifest.requestedTools) ? manifest.requestedTools : [],
          permissions: Array.isArray(manifest.requestedFilesystemScopes) ? manifest.requestedFilesystemScopes : [],
          dependencies: [],
          source: manifest.publisher || fm.publisher || "bundled",
        });
      }
    }
    (out as any[]).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return out;
  });

  /**
   * Installing a skill, in two steps.
   *
   * A skill is instructions the agent will follow, so an install grants a
   * capability rather than copying a file, and the split below is what lets a
   * person see what they are agreeing to. `preview` fetches, normalizes and
   * stages the bundle and reports what it found — provenance, requested
   * permissions, and which metadata Morrow had to invent because the author
   * shipped none. `install` promotes that exact staging directory. There is no
   * second fetch in between, so what was shown is what lands.
   *
   * Every surface — CLI, the Skills page, and the agent's own tool — goes
   * through here, so there is one registry and one answer.
   */
  const skillInstallFailure = (error: unknown): never => {
    if (error instanceof SkillInstallError) {
      const detail = error.issues.length ? `${error.message}: ${error.issues.join("; ")}` : error.message;
      throw new ApiError(400, detail, "SKILL_INSTALL_REFUSED");
    }
    throw error;
  };

  app.post("/api/skills/install/preview", async (request) => {
    const body = z.object({
      source: z.string().trim().min(1).max(2048),
      subdir: z.string().trim().max(512).nullish(),
      overwrite: z.boolean().optional(),
    }).strict().parse((request.body ?? {}) as unknown);
    try {
      return await planSkillInstall(parseSkillSource(body.source), {
        subdir: body.subdir ?? null,
        overwrite: body.overwrite ?? false,
      });
    } catch (error) {
      return skillInstallFailure(error);
    }
  });

  app.post("/api/skills/install", async (request, reply) => {
    const body = z.object({ handle: z.string().trim().min(1).max(128) }).strict().parse((request.body ?? {}) as unknown);
    try {
      const installed = applySkillInstall(body.handle);
      reply.status(201);
      // Installing never enables: the skill is on disk and inert until someone
      // turns it on, which is a separate and deliberate act.
      return { ...installed, enabled: false };
    } catch (error) {
      return skillInstallFailure(error);
    }
  });

  /** Abandon a preview without installing it, so staging does not accumulate. */
  app.post("/api/skills/install/discard", async (request, reply) => {
    const body = z.object({ handle: z.string().trim().min(1).max(128) }).strict().parse((request.body ?? {}) as unknown);
    discardSkillInstall(body.handle);
    reply.status(204);
    return null;
  });

  app.delete("/api/skills/:skillId", async (request, reply) => {
    const { skillId } = request.params as { skillId: string };
    try {
      removeInstalledSkill(skillId);
      reply.status(204);
      return null;
    } catch (error) {
      return skillInstallFailure(error);
    }
  });

  app.get("/api/projects/:projectId/skills/usage", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return skillUsage.listByProject(projectId);
  });

  app.get("/api/projects/:projectId/skills/learned", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return learnedSkills.listByProject(projectId);
  });

  app.post("/api/projects/:projectId/skills/:skillId/use", async (request, reply) => {
    const { projectId, skillId } = request.params as { projectId: string; skillId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(skillId)) throw new ApiError(400, "Invalid skill id", "VALIDATION_ERROR");
    reply.status(200);
    return skillUsage.recordUse(projectId, skillId, new Date().toISOString());
  });

  app.get("/api/projects/:projectId/memory", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const { scope } = request.query as { scope?: string };
    if (scope) {
      const parsedScope = MemoryScopeSchema.safeParse(scope);
      if (!parsedScope.success) throw new ApiError(400, "Invalid scope", "VALIDATION_ERROR");
      if (parsedScope.data === "user_global") return memory.listAllUserGlobal();
      return memory.listByScope(projectId, parsedScope.data);
    }
    const visible = new Map(memory.listByProject(projectId).map((entry) => [entry.id, entry]));
    for (const entry of memory.listAllUserGlobal()) visible.set(entry.id, entry);
    return [...visible.values()];
  });

  // Local, explicit, versioned export/import — never leaves the machine on
  // its own; the caller (CLI/web) writes/reads the JSON file locally.
  app.get("/api/projects/:projectId/memory/export", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return memory.exportEntries(projectId);
  });

  app.post("/api/projects/:projectId/memory/import", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = MemoryImportSchema.parse(request.body);
    const imported = memory.importEntries(projectId, body.entries);
    reply.status(201);
    return { version: 1, importedCount: imported.length, skippedCount: body.entries.length - imported.length };
  });

  app.post("/api/projects/:projectId/memory", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = CreateMemoryEntrySchema.parse(request.body);
    if (body.scope === "agent" || body.scope === "team") {
      throw new ApiError(400, "Private teammate memory must be created by its assigned execution actor", "MEMORY_OWNER_REQUIRED");
    }
    if (body.scope === "conversation") {
      if (!body.conversationId) throw new ApiError(400, "conversationId is required for conversation-scoped memory", "VALIDATION_ERROR");
      const conv = convs.getConversation(body.conversationId);
      if (!conv || conv.projectId !== projectId) throw new ApiError(404, "Conversation not found in project", "NOT_FOUND");
    }
    const entry = memory.create({
      id: crypto.randomUUID(),
      projectId,
      conversationId: body.conversationId ?? null,
      scope: body.scope,
      content: body.content,
      source: "user",
      actor: { kind: "user" },
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      createdAt: new Date().toISOString(),
    });
    reply.status(201);
    return entry;
  });

  app.get("/api/conversations/:conversationId/memory", async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    const conversation = convs.getConversation(conversationId);
    if (!conversation) throw new ApiError(404, "Conversation not found", "NOT_FOUND");
    return memory.listActiveForConversation(conversation.projectId, conversationId);
  });

  app.patch("/api/memory/:id", async (request) => {
    const { id } = request.params as { id: string };
    const existing = memory.get(id);
    if (!existing) throw new ApiError(404, "Memory entry not found", "NOT_FOUND");
    const body = UpdateMemoryEntrySchema.parse(request.body);
    if (existing.projectId !== body.projectId) throw new ApiError(404, "Memory entry not found", "NOT_FOUND");
    const now = new Date().toISOString();
    try {
      let updated = existing;
      if (body.content !== undefined) updated = memory.updateContent(id, body.content, now)!;
      if (body.enabled !== undefined) updated = memory.setEnabled(id, body.enabled, now)!;
      if (body.pinned !== undefined) updated = memory.setPinned(id, body.pinned, now)!;
      return updated;
    } catch (error) {
      if (error instanceof MemoryOwnershipError) throw new ApiError(409, error.message, error.code);
      throw error;
    }
  });

  app.post("/api/memory/:id/reassign", async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({ projectId: z.string().min(1), ownerAgentId: z.string().min(1) }).parse(request.body);
    const existing = memory.get(id);
    if (!existing || existing.projectId !== body.projectId) throw new ApiError(404, "Memory entry not found", "NOT_FOUND");
    const owner = agents.get(body.ownerAgentId);
    if (!owner || owner.projectId !== body.projectId) throw new ApiError(404, "Owner teammate not found in project", "NOT_FOUND");
    try {
      const updated = memory.reassignOwner(id, { kind: "agent", agentId: owner.id, teamId: owner.teamId }, new Date().toISOString());
      if (!updated) throw new ApiError(404, "Memory entry not found", "NOT_FOUND");
      return updated;
    } catch (error) {
      if (error instanceof MemoryOwnershipError) throw new ApiError(409, error.message, error.code);
      throw error;
    }
  });

  app.delete("/api/memory/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ projectId: z.string().min(1) }).parse(request.body);
    const existing = memory.get(id);
    if (!existing) throw new ApiError(404, "Memory entry not found", "NOT_FOUND");
    if (existing.projectId !== body.projectId) throw new ApiError(404, "Memory entry not found", "NOT_FOUND");
    const removed = memory.delete(id);
    if (!removed) throw new ApiError(404, "Memory entry not found", "NOT_FOUND");
    reply.status(204).send();
  });

  app.get("/api/onboarding", async () => {
    try {
      const rows = deps.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
      const state: Record<string, string> = {};
      for (const r of rows) {
        state[r.key] = r.value;
      }
      return {
        onboarded: state["user.onboarded"] === "true",
        onboardingStep: state["user.onboardingStep"] || null,
        useCase: state["user.useCase"] || null,
        name: state["user.name"] || null,
      };
    } catch {
      return { onboarded: false, onboardingStep: null, useCase: null, name: null };
    }
  });

  app.post("/api/onboarding", async (request) => {
    const body = z.object({
      onboarded: z.boolean().optional(),
      onboardingStep: z.string().nullable().optional(),
      useCase: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
    }).parse(request.body);

    deps.db.transaction(() => {
      const upsert = deps.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
      if (body.onboarded !== undefined) {
        upsert.run("user.onboarded", String(body.onboarded));
      }
      if (body.onboardingStep !== undefined) {
        upsert.run("user.onboardingStep", body.onboardingStep ?? "");
      }
      if (body.useCase !== undefined) {
        upsert.run("user.useCase", body.useCase ?? "");
      }
      if (body.name !== undefined) {
        upsert.run("user.name", body.name ?? "");
      }
    })();
    return { success: true };
  });

  app.post("/api/onboarding/reset", async () => {
    deps.db.prepare("DELETE FROM settings").run();
    return { success: true };
  });

  // --- MCP (Model Context Protocol) API Routes ---

  app.get("/api/mcp/servers", async (request) => {
    const query = request.query as { projectId?: string } | undefined;
    let workspaceRoot: string | undefined;
    if (query?.projectId) {
      const project = projects.getProjectById(query.projectId);
      if (project) workspaceRoot = project.workspacePath;
    }
    const configs = loadMcpConfig({ workspaceRoot, db: deps.db });
    const trust = mcpTrustStore(deps.db);
    const servers = Object.entries(configs).map(([id, config]) => ({
      id,
      config,
      trusted: trust.isServerTrusted(id, config),
    }));
    return { servers };
  });

  app.post("/api/mcp/servers", async (request, reply) => {
    const body = request.body as { id?: string; config?: unknown } | undefined;
    if (!body?.id || typeof body.id !== "string") {
      throw new ApiError(400, "Missing required string field: id", "BAD_REQUEST");
    }
    const validated = parseMcpServerConfig(body.config);
    if (!validated) {
      throw new ApiError(400, "Invalid MCP server config payload", "BAD_REQUEST");
    }
    const key = `mcp.server.${body.id}`;
    deps.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(validated));
    const trust = mcpTrustStore(deps.db);
    trust.trustServer(body.id, validated);
    reply.status(201);
    return { ok: true, id: body.id, config: validated };
  });

  app.delete("/api/mcp/servers/:serverId", async (request) => {
    const { serverId } = request.params as { serverId: string };
    const key = `mcp.server.${serverId}`;
    deps.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    const trust = mcpTrustStore(deps.db);
    trust.revoke(serverId);
    return { ok: true, id: serverId };
  });

  app.post("/api/mcp/trust/:serverId", async (request) => {
    const { serverId } = request.params as { serverId: string };
    const body = request.body as { config?: unknown } | undefined;
    let config: McpServerConfig | null = null;
    if (body?.config) {
      config = parseMcpServerConfig(body.config);
    } else {
      const all = loadMcpConfig({ db: deps.db });
      config = all[serverId] ?? null;
    }
    if (!config) {
      throw new ApiError(404, `MCP server config for "${serverId}" not found`, "NOT_FOUND");
    }
    const trust = mcpTrustStore(deps.db);
    trust.trustServer(serverId, config);
    return { ok: true, trusted: true };
  });

  app.post("/api/mcp/test", async (request) => {
    const body = request.body as { serverId?: string; config?: unknown } | undefined;
    const serverId = body?.serverId || "test_server";
    const config = parseMcpServerConfig(body?.config);
    if (!config) {
      throw new ApiError(400, "Invalid MCP server config for testing", "BAD_REQUEST");
    }
    const pool = new McpPool({ db: deps.db });
    return pool.testServer(serverId, config);
  });

  app.get("/api/mcp/tools", async (request) => {
    const query = request.query as { projectId?: string } | undefined;
    let workspaceRoot: string | undefined;
    if (query?.projectId) {
      const project = projects.getProjectById(query.projectId);
      if (project) workspaceRoot = project.workspacePath;
    }
    const configs = loadMcpConfig({ workspaceRoot, db: deps.db });
    const pool = new McpPool({ db: deps.db });
    const toolsMap = await pool.listAllTools(configs);
    const toolsList = Array.from(toolsMap.entries()).map(([namespacedName, item]) => ({
      namespacedName,
      serverId: item.serverId,
      rawName: item.rawName,
      description: item.tool.description,
      inputSchema: item.tool.inputSchema,
      autoApprove: isMcpToolAutoApproved(item.serverId, item.rawName, configs[item.serverId], deps.db),
    }));
    return { tools: toolsList };
  });

  app.put("/api/mcp/permissions/:serverId/:toolName", async (request) => {
    const { serverId, toolName } = request.params as { serverId: string; toolName: string };
    const body = request.body as { policy?: "always_allow" | "require_approval" | "deny" } | undefined;
    if (!body?.policy || !["always_allow", "require_approval", "deny"].includes(body.policy)) {
      throw new ApiError(400, "Invalid policy (must be 'always_allow', 'require_approval', or 'deny')", "BAD_REQUEST");
    }
    setMcpToolApprovalOverride(deps.db, serverId, toolName, body.policy);
    return { ok: true, serverId, toolName, policy: body.policy };
  });

  return app;
}
