import type {
  Project,
  Agent,
  Task,
  TaskEvent,
  Conversation,
  ConversationMessage,
  ProviderStatus,
  ModelStatus,
  PresetStatus,
  RoutingDecision,
  MemoryEntry,
  MemoryScope,
  AgentMode,
  AgentStateTransition,
  Approval,
  ApprovalDecision,
  CommandTrust,
  OAuthFinding,
  ToolSpec,
  PermissionProfile,
  ProjectIntelligence,
  ArchitectureMap,
  RepositoryConvention,
  ArchitectureDecision,
  ProjectRule,
  ProjectRisk,
  MissionLearning,
  ChangeImpactAnalysis,
  PlanRevision,
  AuditEntry,
  ProviderTestResult,
  VerificationResult,
  Health,
  SearchResponse,
  SearchKind,
  Schedule,
  ScheduleTaskKind,
  Mission,
  MissionCriterion,
  MissionEvidence,
  MissionFailure,
  MissionCheckpoint,
  MissionReview,
  MissionEvent,
  MissionResult,
  MissionSpecialistRole,
  MissionVerificationStrategy,
  CreateMissionInput,
} from "@morrow/contracts";
import { CliError, EXIT } from "../cli/errors.js";

export interface SendMessageOptions {
  preset?: string;
  providerId?: string;
  model?: string;
  mode?: AgentMode;
  useMemory?: boolean;
  autoApprove?: boolean;
  worktreeId?: string;
  missionId?: string;
}

export interface SendMessageResult {
  task: Task;
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
  routing: RoutingDecision;
  aggregateUrl: string;
  sseUrl: string;
}

export interface TaskAggregate {
  task: Task;
  plan: Array<{ id: string; position: number; title: string; description: string; status: string }>;
  events: TaskEvent[];
  agentState?: AgentStateTransition;
  agentStates: AgentStateTransition[];
  approvals: Approval[];
  evidence: Array<{ id: string; path: string; metadata: Record<string, unknown>; createdAt: string }>;
  verification?: VerificationResult;
  integrations?: IntegrationAttempt[];
  context?: ContextUsageSummary | null;
  disclosure?: {
    provider: string;
    networkAccess: string;
    filesystemAccess: string;
    shellExecution: boolean;
    modelInvocation: boolean;
    workspaceScope: string;
    estimatedCostUsd: string;
  };
  toolCalls: Array<{ id: string; toolName: string; argsJson: string; resultJson?: string | null; status: string; errorType?: string | null; errorMessage?: string | null }>;
  routing: RoutingDecision | null;
}

export interface ContextUsageSummary {
  providerId: string;
  model: string;
  contextWindowTokens: number;
  contextWindowSource: "known-model" | "provider-metadata" | "user-config" | "fallback";
  maxInputTokens: number;
  reservedTokens: number;
  inputTokensBefore: number | null;
  inputTokensAfter: number | null;
  countingMethod: "exact" | "estimate" | null;
  exact: boolean | null;
  compactedGroups: number;
  removedGroups: number;
  lastOperation: string | null;
  warning: string | null;
  lastSummary?: {
    id: string;
    method: "deterministic" | "fallback" | "model-assisted";
    sourceMessageCount: number;
    createdAt: string;
  } | null;
}

export interface TaskTreeNode {
  task: Task;
  children: TaskTreeNode[];
}

export interface ProcessRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  agentId: string | null;
  command: string;
  args: string[];
  cwd: string;
  mode: "pipe" | "pty";
  pid: number | null;
  status: "running" | "exited" | "failed" | "cancelled" | "lost";
  exitCode: number | null;
  detail: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface WorktreeRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  agentId: string | null;
  branch: string;
  path: string;
  baseRef: string;
  status: "active" | "removed" | "abandoned";
  detail: string | null;
  createdAt: string;
  removedAt: string | null;
}

export interface WorktreeStatusReport extends WorktreeRecord {
  exists: boolean;
  dirty: boolean;
  dirtyFiles: string[];
  aheadCommits: Array<{ hash: string; subject: string }>;
}

export interface IntegrationAttempt {
  id: string;
  projectId: string;
  taskId: string | null;
  agentId: string | null;
  worktreeId: string;
  sourceBranch: string;
  targetBranch: string;
  sourceCommit: string;
  targetCommit: string;
  status: "pending" | "clean" | "conflicted" | "applied" | "failed" | "cancelled";
  conflictedFiles: string[];
  errorDetail: string | null;
  appliedCommit: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
  cancelledAt: string | null;
}

export interface CheckpointSummary {
  id: string;
  name: string;
  taskId: string | null;
  fileCount: number;
  files: string[];
  createdAt: string;
}

export interface SymbolRecord {
  id: string;
  projectId: string;
  filePath: string;
  language: string;
  fileFingerprint: string;
  name: string;
  fqName: string;
  kind: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  parentName: string | null;
  exported: boolean;
  indexedAt: string;
  indexerVersion: string;
  parserVersion: string;
}

export interface SymbolIndexResult {
  indexedFiles: number;
  changedFiles: number;
  skippedFiles: number;
  deletedFiles: number;
  symbolCount: number;
  diagnostics: Array<{ filePath: string; line: number; column: number; code: string; message: string }>;
}

export interface SymbolIndexStatus {
  projectId: string;
  fileCount: number;
  symbolCount: number;
  diagnosticCount: number;
  latestIndexedAt: string | null;
  indexerVersion: string | null;
  parserVersion: string | null;
}

function statusToExit(status: number): number {
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 400 || status === 422) return EXIT.USAGE;
  return EXIT.ERROR;
}

export class MorrowApi {
  constructor(public readonly baseUrl: string) {}

  private async req<T>(method: string, path: string, body?: unknown, init?: { timeoutMs?: number }): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = init?.timeoutMs ? setTimeout(() => controller.abort(), init.timeoutMs) : undefined;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        signal: controller.signal,
        ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
    } catch (e: any) {
      throw new CliError(`Cannot reach the Morrow service at ${displayUrl(this.baseUrl)}.`, {
        code: "SERVICE_UNREACHABLE",
        exitCode: EXIT.SERVICE_UNAVAILABLE,
        hint: "Start it with `morrow serve` (or it will auto-start for most commands).",
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const json = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const message = (json as any)?.error?.message ?? text ?? `HTTP ${res.status}`;
      const code = (json as any)?.error?.code ?? "HTTP_ERROR";
      throw new CliError(message, { code, exitCode: statusToExit(res.status) });
    }
    return json as T;
  }

  // ── Liveness ────────────────────────────────────────────────────────────────
  async health(timeoutMs = 1500): Promise<Health> {
    return this.req<Health>("GET", "/api/health", undefined, { timeoutMs });
  }
  async ping(timeoutMs = 800): Promise<boolean> {
    try {
      await this.health(timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  // ── Projects ──────────────────────────────────────────────────────────────
  listProjects() { return this.req<Project[]>("GET", "/api/projects"); }
  getProject(id: string) { return this.req<Project>("GET", `/api/projects/${id}`); }
  listAgents(projectId: string) { return this.req<Agent[]>("GET", `/api/projects/${projectId}/agents`); }
  createProject(name: string, workspacePath: string) {
    return this.req<Project>("POST", "/api/projects", { name, workspacePath });
  }
  quickChat() {
    return this.req<{ projectId: string; conversationId: string; workspacePath: string }>("POST", "/api/quick-chat");
  }
  startInspectWorkspace(projectId: string) {
    return this.req<{ taskId: string; sseUrl: string }>("POST", `/api/projects/${projectId}/tasks/inspect-workspace`);
  }
  listTasks(projectId: string) { return this.req<Task[]>("GET", `/api/projects/${projectId}/tasks`); }

  // ── Tasks ─────────────────────────────────────────────────────────────────
  getTask(taskId: string) { return this.req<TaskAggregate>("GET", `/api/tasks/${taskId}`); }
  getTaskTree(taskId: string) { return this.req<TaskTreeNode>("GET", `/api/tasks/${taskId}/tree`); }
  cancelTask(taskId: string) { return this.req<void>("POST", `/api/tasks/${taskId}/cancel`); }
  resumeTask(taskId: string) { return this.req<Task>("POST", `/api/tasks/${taskId}/resume`); }
  retryTask(taskId: string) { return this.req<Task>("POST", `/api/tasks/${taskId}/retry`); }
  getTaskDiff(taskId: string) { return this.req<{ id: string; state: string; diff: string | null; diffHash: string; files: string[]; undoResult: any }>("GET", `/api/tasks/${taskId}/diff`); }
  undoTask(taskId: string) { return this.req<{ status: string; restoredFiles: string[] }>("POST", `/api/tasks/${taskId}/undo`); }

  // ── Background processes ──────────────────────────────────────────────────
  startProcess(projectId: string, input: { command: string; args?: string[]; cwd?: string; taskId?: string; agentId?: string; mode?: "pipe" | "pty"; timeoutMs?: number }) {
    return this.req<ProcessRecord>("POST", `/api/projects/${projectId}/processes`, input);
  }
  listProcesses(projectId: string, status?: ProcessRecord["status"]) {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.req<ProcessRecord[]>("GET", `/api/projects/${projectId}/processes${suffix}`);
  }
  getProcess(id: string) {
    return this.req<ProcessRecord>("GET", `/api/processes/${encodeURIComponent(id)}`);
  }
  getProcessOutput(id: string, opts: { stream?: "stdout" | "stderr"; offset?: number; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (opts.stream) params.set("stream", opts.stream);
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return this.req<{ processId: string; stream: string; data: string; nextOffset: number; eof: boolean; truncated: boolean }>(
      "GET",
      `/api/processes/${encodeURIComponent(id)}/output${qs ? `?${qs}` : ""}`
    );
  }
  terminateProcess(id: string, force = false) {
    return this.req<{ status: string; processId: string; forced: boolean }>("POST", `/api/processes/${encodeURIComponent(id)}/terminate`, { force });
  }

  // ── Git worktrees ─────────────────────────────────────────────────────────
  createWorktree(projectId: string, input: { name?: string; taskId?: string; agentId?: string; baseRef?: string }) {
    return this.req<WorktreeRecord>("POST", `/api/projects/${projectId}/worktrees`, input);
  }
  listWorktrees(projectId: string, status?: WorktreeRecord["status"]) {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.req<WorktreeRecord[]>("GET", `/api/projects/${projectId}/worktrees${suffix}`);
  }
  getWorktree(id: string) {
    return this.req<WorktreeStatusReport>("GET", `/api/worktrees/${encodeURIComponent(id)}`);
  }
  getWorktreeDiff(id: string) {
    return this.req<{ worktreeId: string; diff: string; truncated: boolean }>("GET", `/api/worktrees/${encodeURIComponent(id)}/diff`);
  }
  removeWorktree(id: string, preserve = false) {
    return this.req<{ status: string; worktree: WorktreeRecord; preservedCommit: string | null }>(
      "DELETE",
      `/api/worktrees/${encodeURIComponent(id)}${preserve ? "?preserve=true" : ""}`
    );
  }

  // ── Git integrations ─────────────────────────────────────────────────────
  checkIntegration(worktreeId: string, input: { targetBranch?: string } = {}) {
    return this.req<IntegrationAttempt>("POST", `/api/worktrees/${encodeURIComponent(worktreeId)}/integrations/check`, input);
  }
  listIntegrations(projectId: string, status?: IntegrationAttempt["status"]) {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.req<IntegrationAttempt[]>("GET", `/api/projects/${projectId}/integrations${suffix}`);
  }
  getIntegration(id: string) {
    return this.req<IntegrationAttempt>("GET", `/api/integrations/${encodeURIComponent(id)}`);
  }
  applyIntegration(id: string) {
    return this.req<IntegrationAttempt>("POST", `/api/integrations/${encodeURIComponent(id)}/apply`);
  }
  cancelIntegration(id: string) {
    return this.req<IntegrationAttempt>("POST", `/api/integrations/${encodeURIComponent(id)}/cancel`);
  }

  // ── Verified Missions ─────────────────────────────────────────────────────
  createMission(projectId: string, input: CreateMissionInput) {
    return this.req<Mission>("POST", `/api/projects/${projectId}/missions`, input);
  }
  listMissions(projectId: string) {
    return this.req<Mission[]>("GET", `/api/projects/${projectId}/missions`);
  }
  getMission(missionId: string) {
    return this.req<Mission>("GET", `/api/missions/${missionId}`);
  }
  getMissionEvents(missionId: string) {
    return this.req<MissionEvent[]>("GET", `/api/missions/${missionId}/events`);
  }
  getMissionSpecialists(missionId: string) {
    return this.req<MissionSpecialistRole[]>("GET", `/api/missions/${missionId}/specialists`);
  }
  getMissionResult(missionId: string) {
    return this.req<{ status: string; result: MissionResult | null; finalReview: MissionReview | null }>("GET", `/api/missions/${missionId}/result`);
  }
  generateMissionCriteria(missionId: string, repoSummary: string) {
    return this.req<Mission>("POST", `/api/missions/${missionId}/criteria/generate`, { repoSummary });
  }
  addMissionCriterion(missionId: string, description: string, verification?: MissionVerificationStrategy) {
    return this.req<MissionCriterion>("POST", `/api/missions/${missionId}/criteria`, { description, ...(verification ? { verification } : {}) });
  }
  updateMissionCriterion(missionId: string, criterionId: string, patch: { description?: string; state?: MissionCriterion["state"]; verification?: MissionVerificationStrategy; waiverReason?: string }) {
    return this.req<MissionCriterion>("PATCH", `/api/missions/${missionId}/criteria/${criterionId}`, patch);
  }
  removeMissionCriterion(missionId: string, criterionId: string) {
    return this.req<{ status: string; criterionId: string }>("DELETE", `/api/missions/${missionId}/criteria/${criterionId}`);
  }
  verifyMissionCriterion(missionId: string, criterionId: string) {
    return this.req<{ criterion: MissionCriterion; evidence: MissionEvidence }>("POST", `/api/missions/${missionId}/criteria/${criterionId}/verify`);
  }
  approveMission(missionId: string) {
    return this.req<Mission>("POST", `/api/missions/${missionId}/approve`);
  }
  verifyMission(missionId: string) {
    return this.req<Mission>("POST", `/api/missions/${missionId}/verify`);
  }
  reviewMission(missionId: string) {
    return this.req<MissionReview>("POST", `/api/missions/${missionId}/review`);
  }
  finalizeMission(missionId: string, body: { humanInterventions?: number; tasksCompleted?: number } = {}) {
    return this.req<Mission>("POST", `/api/missions/${missionId}/finalize`, body);
  }
  createMissionCheckpoint(missionId: string, label: string, reason: string, files?: string[]) {
    return this.req<MissionCheckpoint>("POST", `/api/missions/${missionId}/checkpoints`, { label, reason, ...(files ? { files } : {}) });
  }
  missionCheckpointDiff(missionId: string, checkpointId: string) {
    return this.req<{ changes: string[] }>("GET", `/api/missions/${missionId}/checkpoints/${checkpointId}/diff`);
  }
  rollbackMission(missionId: string, checkpointId: string) {
    return this.req<{ ok: boolean; restored: string[]; removed: string[]; missing: string[] }>("POST", `/api/missions/${missionId}/rollback`, { checkpointId });
  }
  cancelMission(missionId: string) {
    return this.req<Mission>("POST", `/api/missions/${missionId}/cancel`);
  }

  // ── Morrow Cortex ──────────────────────────────────────────────────────────
  getIntelligence(projectId: string) {
    return this.req<ProjectIntelligence>("GET", `/api/projects/${projectId}/intelligence`);
  }
  refreshIntelligence(projectId: string) {
    return this.req<ProjectIntelligence>("POST", `/api/projects/${projectId}/intelligence/refresh`);
  }
  intelligenceStaleness(projectId: string) {
    return this.req<{ changedScopes: string[]; itemsMarked: number; architectureStale: boolean }>("GET", `/api/projects/${projectId}/intelligence/staleness`);
  }
  forgetIntelligence(projectId: string, includeDurable = false) {
    return this.req<{ forgotten: boolean }>("DELETE", `/api/projects/${projectId}/intelligence${includeDurable ? "?includeDurable=true" : ""}`);
  }
  getArchitecture(projectId: string) {
    return this.req<ArchitectureMap>("GET", `/api/projects/${projectId}/architecture`);
  }
  listConventions(projectId: string) {
    return this.req<RepositoryConvention[]>("GET", `/api/projects/${projectId}/conventions`);
  }
  patchConvention(projectId: string, conventionId: string, approval: "approved" | "rejected") {
    return this.req<RepositoryConvention>("PATCH", `/api/projects/${projectId}/conventions/${conventionId}`, { approval });
  }
  listDecisions(projectId: string) {
    return this.req<ArchitectureDecision[]>("GET", `/api/projects/${projectId}/decisions`);
  }
  listLearnings(projectId: string) {
    return this.req<MissionLearning[]>("GET", `/api/projects/${projectId}/learnings`);
  }
  listRisks(projectId: string) {
    return this.req<ProjectRisk[]>("GET", `/api/projects/${projectId}/risks`);
  }
  listRules(projectId: string) {
    return this.req<ProjectRule[]>("GET", `/api/projects/${projectId}/rules`);
  }
  addRule(projectId: string, text: string, scope?: string) {
    return this.req<ProjectRule>("POST", `/api/projects/${projectId}/rules`, { text, ...(scope ? { scope } : {}) });
  }
  deleteRule(projectId: string, ruleId: string) {
    return this.req<{ deleted: boolean }>("DELETE", `/api/projects/${projectId}/rules/${ruleId}`);
  }
  analyzeMissionImpact(missionId: string) {
    return this.req<ChangeImpactAnalysis>("POST", `/api/missions/${missionId}/impact`);
  }
  listMissionImpact(missionId: string) {
    return this.req<ChangeImpactAnalysis[]>("GET", `/api/missions/${missionId}/impact`);
  }
  listMissionRevisions(missionId: string) {
    return this.req<PlanRevision[]>("GET", `/api/missions/${missionId}/revisions`);
  }
  resumeMission(missionId: string) {
    return this.req<Mission>("POST", `/api/missions/${missionId}/resume`);
  }

  // ── Named workspace checkpoints ───────────────────────────────────────────
  createCheckpoint(projectId: string, input: { name: string; files?: string[]; taskId?: string }) {
    return this.req<CheckpointSummary & { skipped: Array<{ path: string; reason: string }> }>("POST", `/api/projects/${projectId}/checkpoints`, input);
  }
  listCheckpoints(projectId: string) {
    return this.req<CheckpointSummary[]>("GET", `/api/projects/${projectId}/checkpoints`);
  }
  restoreCheckpoint(projectId: string, name: string) {
    return this.req<{ status: string; name: string; restoredFiles: string[]; deletedFiles: string[]; safetyCheckpoint: string | null }>(
      "POST",
      `/api/projects/${projectId}/checkpoints/${encodeURIComponent(name)}/restore`
    );
  }
  deleteCheckpoint(projectId: string, name: string) {
    return this.req<{ status: string; name: string }>("DELETE", `/api/projects/${projectId}/checkpoints/${encodeURIComponent(name)}`);
  }

  // ── Approvals and project-scoped command trust ────────────────────────────
  listApprovals(projectId: string, status?: "pending" | "approved" | "denied" | "cancelled") {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.req<Approval[]>("GET", `/api/projects/${projectId}/approvals${suffix}`);
  }
  getApproval(id: string) {
    return this.req<Approval>("GET", `/api/approvals/${id}`);
  }
  resolveApproval(id: string, input: { projectId: string; decision: ApprovalDecision; trustPattern?: string; note?: string }) {
    return this.req<Approval>("POST", `/api/approvals/${id}/resolve`, input);
  }
  listCommandTrusts(projectId: string) { return this.req<CommandTrust[]>("GET", `/api/projects/${projectId}/command-trusts`); }
  revokeCommandTrust(projectId: string, pattern: string) {
    return this.req<void>("DELETE", `/api/projects/${projectId}/command-trusts`, { pattern });
  }

  // ── Conversations ───────────────────────────────────────────────────────────
  listConversations(projectId: string, includeArchived = false) {
    return this.req<Conversation[]>("GET", `/api/projects/${projectId}/conversations${includeArchived ? "?includeArchived=true" : ""}`);
  }
  getConversation(id: string) { return this.req<Conversation>("GET", `/api/conversations/${id}`); }
  createConversation(projectId: string, title?: string) {
    return this.req<Conversation>("POST", `/api/projects/${projectId}/conversations`, { title });
  }
  updateConversation(id: string, patch: { title?: string; archived?: boolean }) {
    return this.req<Conversation>("PATCH", `/api/conversations/${id}`, patch);
  }
  listMessages(conversationId: string) {
    return this.req<ConversationMessage[]>("GET", `/api/conversations/${conversationId}/messages`);
  }
  sendMessage(conversationId: string, content: string, options: SendMessageOptions = {}) {
    return this.req<SendMessageResult>("POST", `/api/conversations/${conversationId}/messages`, { content, ...options });
  }

  // ── Providers / models / presets ────────────────────────────────────────────
  providerStatus() { return this.req<{ configured: boolean; provider: string; model: string }>("GET", "/api/provider/status"); }
  listProviders() { return this.req<ProviderStatus[]>("GET", "/api/providers"); }
  listOAuth() { return this.req<OAuthFinding[]>("GET", "/api/providers/oauth"); }
  testProvider(id: string) { return this.req<ProviderTestResult>("POST", `/api/providers/${id}/test`, undefined, { timeoutMs: 15000 }); }
  configureProvider(id: string, input: { apiKey?: string; baseUrl?: string; model?: string }) {
    return this.req<{ ok: boolean; provider: string; written: string[]; cleared: string[]; securePermissions: boolean; shadowedByEnv: string[]; status: ProviderStatus | null }>(
      "POST", `/api/providers/${id}/configure`, input
    );
  }
  removeProviderCredentials(id: string) {
    return this.req<{ ok: boolean; provider: string; removed: string[]; status: ProviderStatus | null }>(
      "DELETE", `/api/providers/${id}/credentials`
    );
  }
  listModels() { return this.req<ModelStatus[]>("GET", "/api/models"); }
  listPresets() { return this.req<PresetStatus[]>("GET", "/api/presets"); }

  // ── Tools / permissions / audit ─────────────────────────────────────────────
  listTools() { return this.req<ToolSpec[]>("GET", "/api/tools"); }
  permissions() { return this.req<PermissionProfile>("GET", "/api/permissions"); }
  audit(projectId?: string, limit?: number) {
    const qs = new URLSearchParams();
    if (projectId) qs.set("projectId", projectId);
    if (limit) qs.set("limit", String(limit));
    const suffix = qs.toString() ? `?${qs}` : "";
    return this.req<AuditEntry[]>("GET", `/api/audit${suffix}`);
  }

  // ── Memory ──────────────────────────────────────────────────────────────────
  listProjectMemory(projectId: string) { return this.req<MemoryEntry[]>("GET", `/api/projects/${projectId}/memory`); }
  addMemory(projectId: string, scope: MemoryScope, content: string, conversationId?: string, pinned?: boolean) {
    return this.req<MemoryEntry>("POST", `/api/projects/${projectId}/memory`, { scope, content, conversationId, ...(pinned ? { pinned: true } : {}) });
  }
  setMemoryEnabled(projectId: string, id: string, enabled: boolean) {
    return this.req<MemoryEntry>("PATCH", `/api/memory/${id}`, { projectId, enabled });
  }
  setMemoryPinned(projectId: string, id: string, pinned: boolean) {
    return this.req<MemoryEntry>("PATCH", `/api/memory/${id}`, { projectId, pinned });
  }
  deleteMemory(projectId: string, id: string) {
    return this.req<void>("DELETE", `/api/memory/${id}`, { projectId });
  }

  // ── Search ────────────────────────────────────────────────────────────────────
  search(projectId: string, query: string, opts: { kinds?: SearchKind[]; conversationId?: string; limit?: number } = {}) {
    const qs = new URLSearchParams();
    qs.set("q", query);
    for (const k of opts.kinds ?? []) qs.append("kind", k);
    if (opts.conversationId) qs.set("conversationId", opts.conversationId);
    if (opts.limit) qs.set("limit", String(opts.limit));
    return this.req<SearchResponse>("GET", `/api/projects/${projectId}/search?${qs}`);
  }
  rebuildSymbols(projectId: string) {
    return this.req<SymbolIndexResult>("POST", `/api/projects/${projectId}/symbols/rebuild`);
  }
  refreshSymbols(projectId: string) {
    return this.req<SymbolIndexResult>("POST", `/api/projects/${projectId}/symbols/refresh`);
  }
  symbolStatus(projectId: string) {
    return this.req<SymbolIndexStatus>("GET", `/api/projects/${projectId}/symbols/status`);
  }
  searchSymbols(projectId: string, query: string, opts: { limit?: number } = {}) {
    const qs = new URLSearchParams();
    qs.set("q", query);
    if (opts.limit) qs.set("limit", String(opts.limit));
    return this.req<{ version: 1; query: string; projectId: string; symbols: SymbolRecord[] }>("GET", `/api/projects/${projectId}/symbols/search?${qs}`);
  }
  symbolDefinition(projectId: string, name: string) {
    const qs = new URLSearchParams({ name });
    return this.req<SymbolRecord>("GET", `/api/projects/${projectId}/symbols/definition?${qs}`);
  }
  fileSymbols(projectId: string, path: string) {
    const qs = new URLSearchParams({ path });
    return this.req<{ version: 1; projectId: string; filePath: string; symbols: SymbolRecord[] }>("GET", `/api/projects/${projectId}/symbols/file?${qs}`);
  }
  recordSkillUse(projectId: string, skillId: string) {
    return this.req<{ skillId: string; count: number }>("POST", `/api/projects/${projectId}/skills/${encodeURIComponent(skillId)}/use`);
  }

  // ── Schedules ─────────────────────────────────────────────────────────────────
  listSchedules(projectId: string) { return this.req<Schedule[]>("GET", `/api/projects/${projectId}/schedules`); }
  createSchedule(projectId: string, cron: string, taskKind: ScheduleTaskKind = "inspect_workspace") {
    return this.req<Schedule>("POST", `/api/projects/${projectId}/schedules`, { cron, taskKind });
  }
  deleteSchedule(scheduleId: string) { return this.req<void>("DELETE", `/api/schedules/${scheduleId}`); }
  runSchedule(scheduleId: string) { return this.req<{ scheduleId: string; taskId: string }>("POST", `/api/schedules/${scheduleId}/run`); }

  // ── Onboarding State ────────────────────────────────────────────────────────
  getOnboardingState() {
    return this.req<{ onboarded: boolean; onboardingStep: string | null; useCase: string | null; name: string | null }>("GET", "/api/onboarding");
  }
  saveOnboardingState(data: { onboarded?: boolean; onboardingStep?: string | null; useCase?: string | null; name?: string | null }) {
    return this.req<{ success: boolean }>("POST", "/api/onboarding", data);
  }
  resetOnboardingState() {
    return this.req<{ success: boolean }>("POST", "/api/onboarding/reset");
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function displayUrl(input: string): string {
  try {
    const url = new URL(input);
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return input;
  }
}
