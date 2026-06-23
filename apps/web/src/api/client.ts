import type { AgentStateTransition, Project, Task, TaskEvent, TaskEvidence, PlanStep, ExecutionDisclosure, VerificationResult, Conversation, ConversationMessage, ProviderStatus, ModelStatus, PresetStatus, RoutingDecision, MemoryEntry, OAuthFinding, MemoryScope, Agent, AgentToolPermission, AgentSkillAccess, CreateAgentInput, UpdateAgentInput, UpsertToolPermissionInput, UpsertSkillAccessInput } from "@morrow/contracts";

export interface SendMessageOptions {
  preset?: string;
  providerId?: string;
  model?: string;
  useMemory?: boolean;
}

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export const apiClient = {
  async listProjects(): Promise<Project[]> {
    const res = await fetch(`${BASE_URL}/api/projects`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async createProject(name: string, workspacePath: string): Promise<Project> {
    const res = await fetch(`${BASE_URL}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, workspacePath }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || "Failed to create project");
    }
    return res.json();
  },

  async listProjectTasks(projectId: string): Promise<Task[]> {
    const res = await fetch(`${BASE_URL}/api/projects/${projectId}/tasks`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async startInspectWorkspace(projectId: string): Promise<{ taskId: string }> {
    const res = await fetch(`${BASE_URL}/api/projects/${projectId}/tasks/inspect-workspace`, {
      method: "POST",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || "Failed to start inspection");
    }
    return res.json();
  },

  async getTaskAggregate(taskId: string): Promise<{ task: Task; plan: PlanStep[]; events: TaskEvent[]; agentState?: AgentStateTransition; agentStates: AgentStateTransition[]; evidence: TaskEvidence[]; disclosure?: ExecutionDisclosure; verification?: VerificationResult }> {
    const res = await fetch(`${BASE_URL}/api/tasks/${taskId}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
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
    const res = await fetch(`${BASE_URL}/api/projects/${projectId}/conversations`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async createConversation(projectId: string, title?: string): Promise<Conversation> {
    const res = await fetch(`${BASE_URL}/api/projects/${projectId}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title })
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async listMessages(conversationId: string): Promise<ConversationMessage[]> {
    const res = await fetch(`${BASE_URL}/api/conversations/${conversationId}/messages`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async sendMessage(conversationId: string, content: string, options: SendMessageOptions = {}): Promise<{ task: Task; userMessage: ConversationMessage; assistantMessage: ConversationMessage; routing: RoutingDecision; aggregateUrl: string; sseUrl: string }> {
    const res = await fetch(`${BASE_URL}/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, ...options })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || "Failed to send message");
    }
    return res.json();
  },

  async cancelTask(taskId: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/cancel`, {
      method: "POST"
    });
    if (!res.ok) throw new Error(await res.text());
  },

  async getProviderStatus(): Promise<{ configured: boolean; provider: string; model: string }> {
    const res = await fetch(`${BASE_URL}/api/provider/status`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async listProviders(): Promise<ProviderStatus[]> {
    const res = await fetch(`${BASE_URL}/api/providers`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async listOAuthFindings(): Promise<OAuthFinding[]> {
    const res = await fetch(`${BASE_URL}/api/providers/oauth`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async listModels(): Promise<ModelStatus[]> {
    const res = await fetch(`${BASE_URL}/api/models`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async listPresets(): Promise<PresetStatus[]> {
    const res = await fetch(`${BASE_URL}/api/presets`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async listProjectMemory(projectId: string): Promise<MemoryEntry[]> {
    const res = await fetch(`${BASE_URL}/api/projects/${projectId}/memory`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async addMemory(projectId: string, scope: MemoryScope, content: string, conversationId?: string): Promise<MemoryEntry> {
    const res = await fetch(`${BASE_URL}/api/projects/${projectId}/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, content, conversationId })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || "Failed to add memory");
    }
    return res.json();
  },

  async setMemoryEnabled(id: string, enabled: boolean): Promise<MemoryEntry> {
    const res = await fetch(`${BASE_URL}/api/memory/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled })
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async deleteMemory(id: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/memory/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());
  },

  async getOnboardingState(): Promise<{ onboarded: boolean; onboardingStep: string | null; useCase: string | null; name: string | null }> {
    const res = await fetch(`${BASE_URL}/api/onboarding`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async saveOnboardingState(data: { onboarded?: boolean; onboardingStep?: string | null; useCase?: string | null; name?: string | null }): Promise<{ success: boolean }> {
    const res = await fetch(`${BASE_URL}/api/onboarding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async resetOnboardingState(): Promise<{ success: boolean }> {
    const res = await fetch(`${BASE_URL}/api/onboarding/reset`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async testProvider(providerId: string): Promise<any> {
    const res = await fetch(`${BASE_URL}/api/providers/${providerId}/test`, {
      method: "POST"
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  // ── Agents ─────────────────────────────────────────────────────────────────

  async listProjectAgents(projectId: string): Promise<Agent[]> {
    const res = await fetch(`${BASE_URL}/api/projects/${projectId}/agents`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async createAgent(projectId: string, input: CreateAgentInput): Promise<Agent> {
    const res = await fetch(`${BASE_URL}/api/projects/${projectId}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async updateAgent(agentId: string, projectId: string, input: UpdateAgentInput): Promise<Agent> {
    const res = await fetch(`${BASE_URL}/api/agents/${agentId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, ...input }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async deleteAgent(agentId: string, projectId: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/agents/${agentId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    if (!res.ok) throw new Error(await res.text());
  },

  async listAgentToolPermissions(agentId: string): Promise<AgentToolPermission[]> {
    const res = await fetch(`${BASE_URL}/api/agents/${agentId}/tool-permissions`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async upsertToolPermission(agentId: string, input: UpsertToolPermissionInput): Promise<AgentToolPermission> {
    const res = await fetch(`${BASE_URL}/api/agents/${agentId}/tool-permissions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async deleteToolPermission(agentId: string, toolName: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/agents/${agentId}/tool-permissions/${encodeURIComponent(toolName)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(await res.text());
  },

  async listAgentSkillAccess(agentId: string): Promise<AgentSkillAccess[]> {
    const res = await fetch(`${BASE_URL}/api/agents/${agentId}/skill-access`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async upsertSkillAccess(agentId: string, input: UpsertSkillAccessInput): Promise<AgentSkillAccess> {
    const res = await fetch(`${BASE_URL}/api/agents/${agentId}/skill-access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async deleteSkillAccess(agentId: string, skillId: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/agents/${agentId}/skill-access/${encodeURIComponent(skillId)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(await res.text());
  }
};
