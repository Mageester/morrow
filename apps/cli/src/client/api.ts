import type {
  Project,
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
  AuditEntry,
  ProviderTestResult,
  Health,
} from "@morrow/contracts";
import { CliError, EXIT } from "../cli/errors.js";

export interface SendMessageOptions {
  preset?: string;
  providerId?: string;
  model?: string;
  mode?: AgentMode;
  useMemory?: boolean;
  autoApprove?: boolean;
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
  createProject(name: string, workspacePath: string) {
    return this.req<Project>("POST", "/api/projects", { name, workspacePath });
  }
  startInspectWorkspace(projectId: string) {
    return this.req<{ taskId: string; sseUrl: string }>("POST", `/api/projects/${projectId}/tasks/inspect-workspace`);
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────
  getTask(taskId: string) { return this.req<TaskAggregate>("GET", `/api/tasks/${taskId}`); }
  cancelTask(taskId: string) { return this.req<void>("POST", `/api/tasks/${taskId}/cancel`); }
  getTaskDiff(taskId: string) { return this.req<{ id: string; state: string; diff: string | null; diffHash: string; files: string[]; undoResult: any }>("GET", `/api/tasks/${taskId}/diff`); }
  undoTask(taskId: string) { return this.req<{ status: string; restoredFiles: string[] }>("POST", `/api/tasks/${taskId}/undo`); }

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
  addMemory(projectId: string, scope: MemoryScope, content: string, conversationId?: string) {
    return this.req<MemoryEntry>("POST", `/api/projects/${projectId}/memory`, { scope, content, conversationId });
  }
  setMemoryEnabled(projectId: string, id: string, enabled: boolean) {
    return this.req<MemoryEntry>("PATCH", `/api/memory/${id}`, { projectId, enabled });
  }
  deleteMemory(projectId: string, id: string) {
    return this.req<void>("DELETE", `/api/memory/${id}`, { projectId });
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
