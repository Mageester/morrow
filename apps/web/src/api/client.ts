import type { AgentStateTransition, Project, Task, TaskEvent, TaskEvidence, PlanStep, ExecutionDisclosure, VerificationResult, Conversation, ConversationMessage, ProviderStatus, ModelStatus, PresetStatus, RoutingDecision, MemoryEntry, OAuthFinding, MemoryScope, Agent, AgentToolPermission, AgentSkillAccess, CreateAgentInput, UpdateAgentInput, UpsertToolPermissionInput, UpsertSkillAccessInput } from "@morrow/contracts";

export interface SendMessageOptions {
  preset?: string;
  providerId?: string;
  model?: string;
  useMemory?: boolean;
  agentId?: string;
  mode?: "agent" | "plan-only" | "inspect";
  autoApprove?: boolean;
}

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

// ── Typed response wrapper ──────────────────────────────────────────────────
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${url}`, init);
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error?.message || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const apiClient = {
  async listProjects(): Promise<Project[]> {
    return request("/api/projects");
  },

  async createProject(name: string, workspacePath: string): Promise<Project> {
    return request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, workspacePath }),
    });
  },

  async listProjectTasks(projectId: string): Promise<Task[]> {
    return request(`/api/projects/${projectId}/tasks`);
  },

  async startInspectWorkspace(projectId: string): Promise<{ taskId: string }> {
    return request(`/api/projects/${projectId}/tasks/inspect-workspace`, {
      method: "POST",
    });
  },

  async getTaskAggregate(taskId: string): Promise<{ task: Task; plan: PlanStep[]; events: TaskEvent[]; agentState?: AgentStateTransition; agentStates: AgentStateTransition[]; evidence: TaskEvidence[]; disclosure?: ExecutionDisclosure; verification?: VerificationResult; toolCalls?: any[]; routing?: RoutingDecision | null }> {
    return request(`/api/tasks/${taskId}`);
  },

  async getEventHistory(taskId: string, after?: number): Promise<TaskEvent[]> {
    const url = new URL(`${BASE_URL}/api/tasks/${taskId}/events`);
    if (after !== undefined) url.searchParams.set("after", after.toString());
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  subscribeToTaskEvents(taskId: string, lastEventId: number, onEvent: (event: TaskEvent) => void, onComplete: () => void): () => void {
    let eventSource: EventSource | null = null;
    let highestSequence = lastEventId;
    let isClosed = false;

    const connect = () => {
      if (isClosed) return;
      const url = `${BASE_URL}/api/tasks/${taskId}/events/stream?after=${highestSequence}`;
      eventSource = new EventSource(url);
      
      const handler = (e: MessageEvent) => {
        const event: TaskEvent = JSON.parse(e.data);
        if (event.sequence <= highestSequence) return;
        highestSequence = event.sequence;
        onEvent(event);
        if (["task.verified", "task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(event.type)) {
          isClosed = true;
          eventSource?.close();
          onComplete();
        }
      };

      const eventTypes = ["task.created", "plan.created", "step.started", "step.completed", "workspace.inspected", "evidence.persisted", "agent.state_changed", "verification.completed", "task.running", "task.verified", "task.completed", "task.failed", "task.cancelled", "task.interrupted"];
      eventTypes.forEach(type => {
        eventSource!.addEventListener(type, handler);
      });

      eventSource!.onmessage = handler;

      eventSource!.onerror = () => {
        eventSource?.close();
        if (!isClosed) {
          setTimeout(connect, 1000);
        }
      };
    };

    connect();

    return () => {
      isClosed = true;
      eventSource?.close();
    };
  },

  async listConversations(projectId: string): Promise<Conversation[]> {
    return request(`/api/projects/${projectId}/conversations`);
  },

  async createConversation(projectId: string, title?: string): Promise<Conversation> {
    return request(`/api/projects/${projectId}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title })
    });
  },

  async listMessages(conversationId: string): Promise<ConversationMessage[]> {
    return request(`/api/conversations/${conversationId}/messages`);
  },

  async sendMessage(conversationId: string, content: string, options: SendMessageOptions = {}): Promise<{ task: Task; userMessage: ConversationMessage; assistantMessage: ConversationMessage; routing: RoutingDecision; aggregateUrl: string; sseUrl: string }> {
    return request(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, ...options })
    });
  },

  async cancelTask(taskId: string): Promise<void> {
    return request(`/api/tasks/${taskId}/cancel`, { method: "POST" });
  },

  // Zero-setup chat: provisions (idempotently) a default project + scratch
  // workspace + conversation so the user can chat without creating a mission.
  async quickChat(): Promise<{ projectId: string; conversationId: string; workspacePath: string }> {
    return request("/api/quick-chat", { method: "POST" });
  },

  async getProviderStatus(): Promise<{ configured: boolean; provider: string; model: string }> {
    return request("/api/provider/status");
  },

  async listProviders(): Promise<ProviderStatus[]> {
    return request("/api/providers");
  },

  async listOAuthFindings(): Promise<OAuthFinding[]> {
    return request("/api/providers/oauth");
  },

  async listModels(): Promise<ModelStatus[]> {
    return request("/api/models");
  },

  async listPresets(): Promise<PresetStatus[]> {
    return request("/api/presets");
  },

  async testProvider(providerId: string): Promise<any> {
    return request(`/api/providers/${providerId}/test`, { method: "POST" });
  },

  /**
   * Save provider credentials from the app. The key is stored server-side and
   * applied to the running service immediately — no restart. The key is sent
   * once over the local loopback connection and never persisted in the browser.
   */
  async configureProvider(
    providerId: string,
    input: { apiKey?: string; baseUrl?: string; model?: string }
  ): Promise<{ ok: boolean; provider: string; written: string[]; cleared: string[]; securePermissions: boolean; shadowedByEnv: string[]; status: ProviderStatus | null }> {
    return request(`/api/providers/${providerId}/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  },

  async removeProviderCredentials(
    providerId: string
  ): Promise<{ ok: boolean; provider: string; removed: string[]; status: ProviderStatus | null }> {
    return request(`/api/providers/${providerId}/credentials`, { method: "DELETE" });
  },

  // ── System health ─────────────────────────────────────────────────────────
  async getHealth(): Promise<{ ok: boolean; service: string; apiVersion: number; mockProvider: boolean; time: string }> {
    return request("/api/health");
  },

  // ── Skills (adapter layer — connects to real APIs when available) ─────────
  async listSkills(): Promise<any[]> {
    // Try real endpoint first
    try {
      return await request("/api/skills");
    } catch {
      // Return empty — backend API is being built by Codex
      return [];
    }
  },

  async validateSkill(skillId: string): Promise<any> {
    return request(`/api/skills/${skillId}/validate`, { method: "POST" });
  },

  async runSkillDoctor(skillId: string): Promise<any> {
    return request(`/api/skills/${skillId}/doctor`, { method: "POST" });
  },

  // ── Memory ────────────────────────────────────────────────────────────────
  async listProjectMemory(projectId: string): Promise<MemoryEntry[]> {
    return request(`/api/projects/${projectId}/memory`);
  },

  async addMemory(projectId: string, scope: MemoryScope, content: string, conversationId?: string): Promise<MemoryEntry> {
    return request(`/api/projects/${projectId}/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, content, conversationId })
    });
  },

  async setMemoryEnabled(id: string, enabled: boolean): Promise<MemoryEntry> {
    return request(`/api/memory/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled })
    });
  },

  async deleteMemory(id: string): Promise<void> {
    return request(`/api/memory/${id}`, { method: "DELETE" });
  },

  // ── Onboarding ────────────────────────────────────────────────────────────
  async getOnboardingState(): Promise<{ onboarded: boolean; onboardingStep: string | null; useCase: string | null; name: string | null }> {
    return request("/api/onboarding");
  },

  async saveOnboardingState(data: { onboarded?: boolean; onboardingStep?: string | null; useCase?: string | null; name?: string | null }): Promise<{ success: boolean }> {
    return request("/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  },

  async resetOnboardingState(): Promise<{ success: boolean }> {
    return request("/api/onboarding/reset", { method: "POST" });
  },

  // ── Agents ────────────────────────────────────────────────────────────────
  async listProjectAgents(projectId: string): Promise<Agent[]> {
    return request(`/api/projects/${projectId}/agents`);
  },

  async createAgent(projectId: string, input: CreateAgentInput): Promise<Agent> {
    return request(`/api/projects/${projectId}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  },

  async updateAgent(agentId: string, projectId: string, input: UpdateAgentInput): Promise<Agent> {
    return request(`/api/agents/${agentId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, ...input }),
    });
  },

  async deleteAgent(agentId: string, projectId: string): Promise<void> {
    return request(`/api/agents/${agentId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
  },

  async listAgentToolPermissions(agentId: string): Promise<AgentToolPermission[]> {
    return request(`/api/agents/${agentId}/tool-permissions`);
  },

  async upsertToolPermission(agentId: string, input: UpsertToolPermissionInput): Promise<AgentToolPermission> {
    return request(`/api/agents/${agentId}/tool-permissions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  },

  async deleteToolPermission(agentId: string, toolName: string): Promise<void> {
    return request(`/api/agents/${agentId}/tool-permissions/${encodeURIComponent(toolName)}`, {
      method: "DELETE",
    });
  },

  async listAgentSkillAccess(agentId: string): Promise<AgentSkillAccess[]> {
    return request(`/api/agents/${agentId}/skill-access`);
  },

  async upsertSkillAccess(agentId: string, input: UpsertSkillAccessInput): Promise<AgentSkillAccess> {
    return request(`/api/agents/${agentId}/skill-access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  },

  async deleteSkillAccess(agentId: string, skillId: string): Promise<void> {
    return request(`/api/agents/${agentId}/skill-access/${encodeURIComponent(skillId)}`, {
      method: "DELETE",
    });
  }
};
