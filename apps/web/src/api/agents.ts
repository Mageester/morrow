import { AgentSchema, RosterSchema, type Agent, type AgentRole, type Roster } from "@morrow/contracts";
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
};

export interface CreateTeammateInput {
  name: string;
  role: AgentRole;
  instructions?: string | null;
  providerOverride?: string | null;
  modelOverride?: string | null;
}

export const agentApi = {
  create(projectId: string, input: CreateTeammateInput): Promise<Agent> {
    return api.post(`${projectPath(projectId)}/agents`, input, AgentSchema);
  },
  update(agentId: string, projectId: string, patch: Partial<CreateTeammateInput> & { enabled?: boolean }): Promise<Agent> {
    return api.put(`/api/agents/${encodeURIComponent(agentId)}`, { projectId, ...patch }, AgentSchema);
  },
};
