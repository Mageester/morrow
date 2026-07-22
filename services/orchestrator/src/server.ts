import { z } from "zod";
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
  CreateMemoryEntrySchema,
  UpdateMemoryEntrySchema,
  UpdateConversationSchema,
  ApprovalStatusSchema,
  ResolveApprovalSchema,
  ProviderIdSchema,
  CreateAgentSchema,
  UpdateAgentSchema,
  UpsertToolPermissionSchema,
  UpsertSkillAccessSchema,
  CreateProjectRuleSchema,
  PatchConventionSchema,
  type PresetId,
  type ProviderId,
  type ProviderAuthMode,
  type ChatStreamEventType,
  type RoutingDecision,
} from "@morrow/contracts";
import { openDatabase } from "./database.js";
import { realpathSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectRepository } from "./repositories/projects.js";
import { agentsRepository } from "./repositories/agents.js";
import { taskRepository } from "./repositories/tasks.js";
import { taskRecordsRepository } from "./repositories/task-records.js";
import { conversationsRepository } from "./repositories/conversations.js";
import { taskRoutingRepository } from "./repositories/task-routing.js";
import { memoryRepository } from "./repositories/memory.js";
import { searchRepository } from "./repositories/search.js";
import { skillUsageRepository } from "./repositories/skill-usage.js";
import { learnedSkillsRepository } from "./repositories/learned-skills.js";
import { AutomaticMemoryService } from "./cortex/automatic-memory.js";
import { AutomaticSkillService } from "./cortex/automatic-skills.js";
import { verifySkillDirectory } from "./skills/registry.js";
import { schedulesRepository } from "./repositories/schedules.js";
import { assertValidCron, nextRun } from "./schedule/cron.js";
import { parseTscDiagnostics, parseEslintDiagnostics, summarizeDiagnostics } from "./workspace/diagnostics.js";
import { runProcessSafe } from "./tools/command-executor.js";
import { loadAdaptersFromEnv, notifyAll, type MessageAdapter } from "./messaging/adapter.js";
import { SearchKindSchema, CreateScheduleSchema, DiagnosticToolSchema, SpawnSubagentSchema, NotifyRequestSchema, CreateCheckpointSchema, StartProcessSchema, CreateWorktreeSchema } from "@morrow/contracts";

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
    contextWindowTokens: num(budget?.contextWindowTokens) ?? num(budget?.modelCapacityTokens) ?? 0,
    contextWindowSource: str(budget?.contextWindowSource) ?? str(budget?.modelCapacitySource) ?? "unknown",
    modelCapacityTokens: num(budget?.contextWindowTokens) ?? num(budget?.modelCapacityTokens),
    modelCapacitySource: str(budget?.contextWindowSource) ?? str(budget?.modelCapacitySource) ?? "unknown",
    endpointLimitTokens: num(budget?.endpointLimitTokens),
    endpointLimitSource: str(budget?.endpointLimitSource) ?? "unknown",
    effectiveRequestLimitTokens: num(budget?.contextWindowTokens) ?? num(budget?.effectiveRequestLimitTokens),
    effectiveLimitSource: str(budget?.contextWindowSource) ?? str(budget?.effectiveLimitSource) ?? "unknown",
    maxInputTokens: num(budget?.usableInputTokens) ?? num(budget?.maximumInputTokens) ?? num(budget?.maxInputTokens) ?? num(trim?.maxInputTokens) ?? 0,
    maximumInputTokens: num(budget?.usableInputTokens) ?? num(budget?.maximumInputTokens) ?? num(budget?.maxInputTokens) ?? 0,
    reservedTokens: num(budget?.totalReserveTokens) ?? num(budget?.outputReserveTokens) ?? num(budget?.reservedOutputTokens) ?? num(budget?.reservedTokens) ?? 0,
    outputReserveTokens: num(budget?.outputReserveTokens) ?? num(budget?.reservedOutputTokens) ?? 0,
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
import { executionContinuityRepository } from "./repositories/execution-continuity.js";
import { symbolIndexRepository } from "./repositories/symbols.js";
import { IntegrationManager, IntegrationError } from "./workspace/integrations.js";
import { SymbolIndex } from "./workspace/symbol-index.js";
import { ProcessSupervisor } from "./processes/supervisor.js";

import { ApprovalContinuationRegistry } from "./execution/continuation.js";
import { hashString, assertContainedRealPath } from "./tools/diff-applier.js";
import { canonicalCommandTrustKey, classifyCommand } from "./tools/command-policy.js";
import { resolveMorrowHome } from "./home.js";
import { unlinkSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createProvider, installProviderModelDiscoveries, listProviderStatuses } from "./provider/registry.js";
import type { ProviderRouteMetadata, ChatMessage } from "./provider/base.js";
import { globalRateGuard } from "./provider/rate-guard.js";
import { OAUTH_FINDINGS } from "./provider/oauth.js";
import { oauthStatuses, startAuthorization, exchangeCode, signOut, isOAuthProvider } from "./provider/oauth-flow.js";
import { BUILT_IN_MODELS, installModelCatalog, listModels, listConfiguredCustomModels, resolveModelStatuses } from "./routing/models.js";
import { ModelCatalog } from "./routing/model-catalog.js";
import { listPresets, getPreset, isPresetId, DEFAULT_PRESET_ID } from "./routing/presets.js";
import { routePreset, listPresetStatuses } from "./routing/router.js";
import { testProviderConnectivity } from "./provider/connectivity.js";
import { buildProviderCandidateEnv, configureProvider, providerCredentialIdentity, removeProviderCredentials, providerEnvMapping } from "./provider/secrets.js";
import { TOOL_CATALOG, PERMISSION_PROFILE } from "./tools/catalog.js";
import { evaluateLocalRequest, parseTrustedOrigins } from "./security/local-guard.js";
import { countChatTokens, prepareContextForProvider, admitProviderRequest } from "./execution/context-budget.js";
import { buildProviderProjection } from "./execution/provider-projection.js";
import { resolveModelBudget } from "./routing/model-budget.js";
import { AgentTaskDispatchError, dispatchAgentTask } from "./mission/task-dispatcher.js";
import { registerWebMissionRoutes } from "./web/mission-routes.js";
import { registerWebMissionStreamRoutes } from "./web/mission-stream.js";
import { registerWebAppRoutes } from "./web/static-app.js";

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
   * Absolute path to the built web bundle (the directory containing
   * `index.html`). When provided, the orchestrator serves the local Morrow web
   * application at `/app`. When absent, the service stays CLI-only and no `/app`
   * surface exists.
   */
  webRoot?: string;
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
  const agents = agentsRepository(deps.db);
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
      return { ...result, ok: false, configured: false, status: null, detail: "OpenRouter credential changed while refresh was in flight; result discarded.", errorKind: "cancelled", modelsSample: [], models: [] };
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
    remoteUrl: process.env.MORROW_MODEL_CATALOG_URL?.trim() || null,
    bundledModels: BUILT_IN_MODELS,
  });
  installModelCatalog(modelCatalog.current().models);
  void modelCatalog.refresh().then((snapshot) => installModelCatalog(snapshot.models)).catch(() => undefined);
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
      migrations: { applied: Number(row.applied), latest: row.latest },
      time: new Date().toISOString(),
    };
  });

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

  app.get("/api/projects", async (request, reply) => {
    return projects.listProjects();
  });

  app.get("/api/projects/:projectId", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return project;
  });

  // ── Agents ─────────────────────────────────────────────────────────────────

  app.get("/api/projects/:projectId/agents", async (request) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return agents.listByProject(projectId);
  });

  app.post("/api/projects/:projectId/agents", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = CreateAgentSchema.parse(request.body);
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
    const updated = agents.update(agentId, body.projectId, body);
    if (!updated) throw new ApiError(404, "Agent not found in project", "NOT_FOUND");
    return updated;
  });

  app.delete("/api/agents/:agentId", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const body = z.object({ projectId: z.string().min(1) }).parse(request.body);
    if (!agents.delete(agentId, body.projectId)) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    reply.status(204).send();
  });

  // ── Agent Tool Permissions ─────────────────────────────────────────────────

  app.get("/api/agents/:agentId/tool-permissions", async (request) => {
    const { agentId } = request.params as { agentId: string };
    if (!agents.get(agentId)) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    return agents.listToolPermissions(agentId);
  });

  app.put("/api/agents/:agentId/tool-permissions", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    if (!agents.get(agentId)) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    const body = UpsertToolPermissionSchema.parse(request.body);
    reply.status(200);
    return agents.upsertToolPermission(agentId, body);
  });

  app.delete("/api/agents/:agentId/tool-permissions/:toolName", async (request, reply) => {
    const { agentId, toolName } = request.params as { agentId: string; toolName: string };
    if (!agents.get(agentId)) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    if (!agents.deleteToolPermission(agentId, toolName)) throw new ApiError(404, "Tool permission not found", "NOT_FOUND");
    reply.status(204).send();
  });

  // ── Agent Skill Access ─────────────────────────────────────────────────────

  app.get("/api/agents/:agentId/skill-access", async (request) => {
    const { agentId } = request.params as { agentId: string };
    if (!agents.get(agentId)) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    return agents.listSkillAccess(agentId);
  });

  app.put("/api/agents/:agentId/skill-access", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    if (!agents.get(agentId)) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    const body = UpsertSkillAccessSchema.parse(request.body);
    reply.status(200);
    return agents.upsertSkillAccess(agentId, body);
  });

  app.delete("/api/agents/:agentId/skill-access/:skillId", async (request, reply) => {
    const { agentId, skillId } = request.params as { agentId: string; skillId: string };
    if (!agents.get(agentId)) throw new ApiError(404, "Agent not found", "NOT_FOUND");
    if (!agents.deleteSkillAccess(agentId, skillId)) throw new ApiError(404, "Skill access not found", "NOT_FOUND");
    reply.status(204).send();
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
    const toolCalls = convs.listToolCallsForTask(taskId);
    const routing = routingRepo.get(taskId)?.decision ?? null;
    const latestSummary = contextSummariesRepo.latestForTask(taskId);
    const context = contextUsageFromEvents(agg.events, latestSummary);
    return { ...agg, toolCalls, approvals: approvals.listByTask(taskId), integrations: integrationsRepo.listByTask(taskId), context, routing };
  });

  app.get("/api/tasks/:taskId/events", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const { after } = request.query as { after?: string };
    const task = tasks.getTaskById(taskId);
    if (!task) throw new ApiError(404, "Task not found", "NOT_FOUND");
    
    let events = records.listEvents(taskId);
    if (after) {
      const cursor = parseEventCursor(after);
      events = events.filter(e => e.sequence > cursor);
    }
    return events;
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

    request.raw.on("close", () => {
      isClosed = true;
      if (timeoutId) clearTimeout(timeoutId);
    });

    const sendEvent = (event: any) => {
      reply.raw.write(`id: ${event.sequence}\n`);
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const pollEvents = async () => {
      if (isClosed) return;
      
      const allEvents = records.listEvents(taskId);
      const newEvents = allEvents.filter(e => e.sequence > afterSeq);
      
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
    return updated;
  });

  app.post("/api/projects/:projectId/conversations", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    
    const body = CreateConversationSchema.parse(request.body ?? {});
    const title = body?.title?.trim() || "New Conversation";
    
    const conversation = convs.createConversation({
      id: crypto.randomUUID(),
      projectId,
      title,
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

  app.patch("/api/projects/:projectId/conversations/:conversationId", async (request) => {
    const { projectId, conversationId } = request.params as { projectId: string; conversationId: string };
    let updated = ownedConversation(projectId, conversationId);
    const body = UpdateConversationSchema.parse(request.body);
    const updatedAt = new Date().toISOString();
    if (body.title !== undefined) updated = convs.renameConversation(conversationId, body.title, updatedAt) ?? updated;
    if (body.archived !== undefined) updated = convs.setArchived(conversationId, body.archived, updatedAt) ?? updated;
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
    ownedConversation(projectId, conversationId);
    const body = SendMessageSchema.parse(request.body);
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
    records.retryTask(taskId);
    deps.runner.run(taskId);
    reply.status(202);
    return { version: 1, taskId, status: "queued", outcome: "retried" };
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
        const pending = records.listEvents(taskId, cursor);
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

  // Subagent delegation: a subagent is a child task with its own scope, linked
  // to its parent via parent_task_id. This builds the task graph.
  app.post("/api/tasks/:taskId/subagents", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const parent = tasks.getTaskById(taskId);
    if (!parent) throw new ApiError(404, "Task not found", "NOT_FOUND");
    const body = SpawnSubagentSchema.parse(request.body ?? {});
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
          ? [{ id: call.id, name: call.name, arguments: call.arguments }]
          : [];
      }),
    }));
    const toolResults = convs.listToolCallsForTask(taskId).flatMap((call) =>
      typeof call.resultJson === "string" ? [{ id: call.id, toolName: call.toolName, result: call.resultJson }] : [],
    );
    const messages = buildProviderProjection({ prefixMessages, turns, toolResults });
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
      const events = records.listEvents(taskId);
      const rejectedBudget = [...events].reverse().find((event) => event.type === "context.budget_calculated" && event.payload.admitted === false);
      const compactedAfterRejection = rejectedBudget
        ? events.some((event) => event.sequence > rejectedBudget.sequence && event.type === "context.compaction_completed")
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
    return processesRepo.listByProject(projectId, status as any);
  });

  app.get("/api/processes/:processId", async (request) => {
    const { processId } = request.params as { processId: string };
    const record = processesRepo.get(processId);
    if (!record) throw new ApiError(404, "Process not found", "NOT_FOUND");
    return record;
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
    if (t && t.status === "interrupted") {
      // Resume a task that a restart interrupted while it awaited this approval.
      deps.db.prepare("UPDATE tasks SET status='queued', updated_at=? WHERE id=?").run(new Date().toISOString(), approval.taskId);
      deps.runner.run(approval.taskId);
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
    try {
      return await exchangeCode(providerId, body.code, process.env);
    } catch (e: any) {
      throw new ApiError(400, e?.message || "Failed to complete sign-in.", "OAUTH_EXCHANGE_FAILED");
    }
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
    if (!providerEnvMapping(id)) {
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
    if (body.baseUrl !== undefined && body.baseUrl.trim() !== "") {
      try {
        const u = new URL(body.baseUrl.trim());
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
      } catch {
        throw new ApiError(400, "baseUrl must be a valid http(s) URL.", "INVALID_BASE_URL");
      }
    }
    if (id === "openrouter" && body.baseUrl !== undefined) {
      throw new ApiError(400, "OpenRouter uses a pinned official endpoint and does not accept baseUrl overrides.", "OPENROUTER_ENDPOINT_PINNED");
    }
    let validatedResult: Awaited<ReturnType<typeof testProviderConnectivity>> | null = null;
    let validatedCredentialIdentity: string | null = null;
    if (id === "openrouter") {
      const previousCredentialIdentity = providerCredentialIdentity(id, process.env);
      const candidateEnv = buildProviderCandidateEnv(id, body, process.env);
      validatedCredentialIdentity = providerCredentialIdentity(id, candidateEnv);
      validatedResult = await providerConnectivityTest(id, candidateEnv);
      if (providerCredentialIdentity(id, process.env) !== previousCredentialIdentity) {
        throw new ApiError(409, "OpenRouter configuration changed while validation was in flight. Retry with the current settings.", "PROVIDER_CONFIGURATION_CONFLICT");
      }
      if (!validatedResult.ok) {
        const statusCode = validatedResult.errorKind === "auth" ? 401 : validatedResult.errorKind === "rate_limit" ? 429 : 502;
        throw new ApiError(statusCode, `OpenRouter validation failed (${validatedResult.errorKind ?? "provider"}). The previous credential was preserved.`, "PROVIDER_VALIDATION_FAILED");
      }
    }
    const result = configureProvider(deps.secretsFile, id, body, process.env);
    if (validatedResult) {
      const fetchedAt = new Date().toISOString();
      providerModelDiscovery.upsert({ providerId: id, authMode: "openrouter-api-key", status: "available", models: validatedResult.models, errorKind: null, fetchedAt, expiresAt: discoveryExpiresAt(fetchedAt, true), lastSuccessAt: fetchedAt, credentialIdentity: validatedCredentialIdentity });
      installProviderModelDiscoveries(providerModelDiscovery.list());
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
        contextWindowConfidence: budget.contextWindowConfidence,
        usableInputTokens: budget.usableInputTokens,
        outputReserveTokens: budget.outputReserveTokens,
        totalReserveTokens: budget.totalReserveTokens,
        capabilities: budget.capabilities,
        pricing: model.pricing,
        reasoning: budget.reasoning,
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

  app.post("/api/projects/:projectId/schedules", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = CreateScheduleSchema.parse(request.body);
    try {
      assertValidCron(body.cron);
    } catch (error) {
      throw new ApiError(400, `Invalid cron expression: ${(error as Error).message}`, "VALIDATION_ERROR");
    }
    const created = schedules.create({
      id: crypto.randomUUID(),
      projectId,
      cron: body.cron,
      taskKind: body.taskKind,
      nextRunAt: nextRun(body.cron, new Date()).toISOString(),
      createdAt: new Date().toISOString(),
    });
    reply.status(201);
    return created;
  });

  app.delete("/api/schedules/:scheduleId", async (request, reply) => {
    const { scheduleId } = request.params as { scheduleId: string };
    if (!schedules.get(scheduleId)) throw new ApiError(404, "Schedule not found", "NOT_FOUND");
    schedules.delete(scheduleId);
    reply.status(204).send();
  });

  app.post("/api/schedules/:scheduleId/run", async (request, reply) => {
    const { scheduleId } = request.params as { scheduleId: string };
    const schedule = schedules.get(scheduleId);
    if (!schedule) throw new ApiError(404, "Schedule not found", "NOT_FOUND");
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
    return memory.listByProject(projectId);
  });

  app.post("/api/projects/:projectId/memory", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const body = CreateMemoryEntrySchema.parse(request.body);
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
    let updated = existing;
    if (body.enabled !== undefined) updated = memory.setEnabled(id, body.enabled, now)!;
    if (body.pinned !== undefined) updated = memory.setPinned(id, body.pinned, now)!;
    return updated;
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

  return app;
}
