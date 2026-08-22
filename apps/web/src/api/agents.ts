import { AgentSchema, AgentToolPermissionSchema, RosterSchema, TeammateTrustGrantSchema, TeammateTrustGrantsSchema, type CreateTeammateTrustGrantInput, type Agent, type AgentRole, type AgentToolPermission, type MemoryScope, type Roster, type UpsertToolPermissionInput } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client.js";

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

export const agentKeys = {
  all: ["agents"] as const,
  list(projectId: string) {
    return [...this.all, "list", projectId] as const;
  },
  roster(projectId: string) {
    return [...this.all, "roster", projectId] as const;
  },
};

/**
 * How often the rail asks the orchestrator what each teammate is doing.
 *
 * The roster is the only place a teammate working in another thread is
 * visible, so it cannot wait for a navigation to refresh. Three seconds is
 * fast enough to watch two agents progress side by side and slow enough that
 * a projection of a handful of indexed reads costs nothing noticeable.
 */
const ROSTER_POLL_MS = 3_000;

export const agentQueries = {
  list(projectId: string) {
    return queryOptions({
      queryKey: agentKeys.list(projectId),
      queryFn: () => api.get(`${projectPath(projectId)}/agents`, AgentSchema.array()),
      enabled: Boolean(projectId),
    });
  },
  detail(projectId: string, agentId: string) {
    return queryOptions({
      queryKey: [...agentKeys.list(projectId), agentId] as const,
      // The standalone agent route is not project-scoped. Reuse the
      // project-scoped projection so a guessed id cannot disclose another
      // project's policy before the UI checks ownership.
      queryFn: async () => {
        const agents = await api.get(`${projectPath(projectId)}/agents`, AgentSchema.array());
        const agent = agents.find((candidate) => candidate.id === agentId);
        if (!agent) throw new Error("Agent not found in this project");
        return agent;
      },
      enabled: Boolean(projectId) && Boolean(agentId),
    });
  },
  roster(projectId: string) {
    return queryOptions<Roster>({
      queryKey: agentKeys.roster(projectId),
      queryFn: () => api.get(`${projectPath(projectId)}/roster`, RosterSchema),
      enabled: Boolean(projectId),
      refetchInterval: ROSTER_POLL_MS,
      // Status is the whole point of this rail; a stale one is worse than a
      // brief spinner, so keep polling while the window is in the background
      // too — a run that finishes while the user is elsewhere should be
      // visible the moment they look back.
      refetchIntervalInBackground: true,
    });
  },
  toolPermissions(projectId: string, agentId: string) {
    return queryOptions({
      queryKey: [...agentKeys.list(projectId), agentId, "tool-permissions"] as const,
      queryFn: () => api.get(`/api/agents/${encodeURIComponent(agentId)}/tool-permissions?projectId=${encodeURIComponent(projectId)}`, AgentToolPermissionSchema.array()),
      enabled: Boolean(projectId) && Boolean(agentId),
    });
  },
};

export interface CreateTeammateInput {
  name: string;
  role: AgentRole;
  instructions?: string | null;
  providerOverride?: string | null;
  modelOverride?: string | null;
  memoryReadScopes?: MemoryScope[];
  memoryWriteScopes?: MemoryScope[];
}

export const agentApi = {
  create(projectId: string, input: CreateTeammateInput): Promise<Agent> {
    return api.post(`${projectPath(projectId)}/agents`, input, AgentSchema);
  },
  update(agentId: string, projectId: string, patch: Partial<CreateTeammateInput> & { enabled?: boolean }): Promise<Agent> {
    return api.put(`/api/agents/${encodeURIComponent(agentId)}`, { projectId, ...patch }, AgentSchema);
  },
  setToolPermission(agentId: string, projectId: string, input: UpsertToolPermissionInput): Promise<AgentToolPermission> {
    return api.put(`/api/agents/${encodeURIComponent(agentId)}/tool-permissions?projectId=${encodeURIComponent(projectId)}`, input, AgentToolPermissionSchema);
  },
  deleteToolPermission(agentId: string, projectId: string, toolName: string): Promise<null> {
    return api.delete(`/api/agents/${encodeURIComponent(agentId)}/tool-permissions/${encodeURIComponent(toolName)}?projectId=${encodeURIComponent(projectId)}`, AgentToolPermissionSchema.nullable().transform(() => null));
  },
};

export const teammateTrustKeys = {
  all: ["teammate-trust"] as const,
  list(projectId: string) {
    return [...this.all, projectId] as const;
  },
};

export const teammateTrustQueries = {
  list(projectId: string) {
    return queryOptions({
      queryKey: teammateTrustKeys.list(projectId),
      queryFn: () => api.get(`${projectPath(projectId)}/teammate-trust`, TeammateTrustGrantsSchema),
      enabled: Boolean(projectId),
    });
  },
};

/**
 * Standing permission for one teammate to hand work to another unprompted.
 *
 * The server resolves the target's profile fingerprint when granting, so the
 * client never supplies it — a grant always describes the teammate as it was
 * when the user agreed, and a later policy change re-prompts on its own.
 */
export const teammateTrustApi = {
  grant(projectId: string, input: CreateTeammateTrustGrantInput) {
    return api.post(`${projectPath(projectId)}/teammate-trust`, input, TeammateTrustGrantSchema);
  },
  revoke(projectId: string, grantId: string) {
    return api.delete(
      `${projectPath(projectId)}/teammate-trust/${encodeURIComponent(grantId)}`,
      TeammateTrustGrantSchema.nullable().transform(() => null),
    );
  },
};
