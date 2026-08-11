import { AgentSchema, TeamSchema } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";

const TeamWithMembersSchema = z.object({
  team: TeamSchema,
  members: AgentSchema.array(),
});
export type TeamWithMembers = z.infer<typeof TeamWithMembersSchema>;

const DelegationSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  parentTaskId: z.string(),
  teamId: z.string(),
  agentId: z.string(),
  objective: z.string(),
  acceptanceCriteria: z.array(z.string()),
  contextSnapshotRef: z.string(),
  allowedTools: z.array(z.string()),
  allowedMemoryScopes: z.array(z.string()),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  budget: z.object({
    maxProviderCalls: z.number().nullable(),
    maxTokenBudget: z.number().nullable(),
    maxWallClockMs: z.number().nullable(),
  }),
  approvalRequired: z.boolean(),
  status: z.enum(["pending_approval", "approved", "rejected", "running", "completed", "failed", "cancelled"]),
  deadlineAt: z.string().nullable(),
  correlationId: z.string(),
  childTaskId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Delegation = z.infer<typeof DelegationSchema>;

const HandoffSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  delegationId: z.string(),
  taskId: z.string(),
  resultSummary: z.string(),
  acceptanceCriteriaStatus: z.array(z.object({ criterion: z.string(), met: z.boolean(), note: z.string().nullable() })),
  artifactRefs: z.array(z.object({ id: z.string(), path: z.string(), contentHash: z.string() })),
  verificationEvidence: z.string().nullable(),
  unresolvedRisks: z.array(z.string()),
  sourceAgentId: z.string(),
  targetAgentId: z.string().nullable(),
  createdAt: z.string(),
});
export type Handoff = z.infer<typeof HandoffSchema>;

export const teamQueries = {
  list(projectId: string) {
    return queryOptions({
      queryKey: ["teams", "list", projectId] as const,
      queryFn: () => api.get(`/api/projects/${encodeURIComponent(projectId)}/teams`, TeamSchema.array()),
      enabled: Boolean(projectId),
    });
  },
  detail(projectId: string, teamId: string) {
    return queryOptions({
      queryKey: ["teams", "detail", projectId, teamId] as const,
      queryFn: () =>
        api.get(
          `/api/projects/${encodeURIComponent(projectId)}/teams/${encodeURIComponent(teamId)}`,
          TeamWithMembersSchema,
        ),
      enabled: Boolean(projectId) && Boolean(teamId),
    });
  },
  delegationsForTask(taskId: string) {
    return queryOptions({
      queryKey: ["delegations", "byParentTask", taskId] as const,
      queryFn: () => api.get(`/api/tasks/${encodeURIComponent(taskId)}/delegations`, DelegationSchema.array()),
      enabled: Boolean(taskId),
    });
  },
  delegation(delegationId: string, parentTaskId: string) {
    return queryOptions({
      queryKey: ["delegations", "detail", delegationId, parentTaskId] as const,
      queryFn: () =>
        api.get(
          `/api/delegations/${encodeURIComponent(delegationId)}?parentTaskId=${encodeURIComponent(parentTaskId)}`,
          z.object({ delegation: DelegationSchema, handoff: HandoffSchema.nullable() }),
        ),
      enabled: Boolean(delegationId) && Boolean(parentTaskId),
    });
  },
};

export const teamApi = {
  createFromPreset(projectId: string, input: { preset: "research_and_verify"; name?: string }): Promise<TeamWithMembers> {
    return api.post(`/api/projects/${encodeURIComponent(projectId)}/teams`, input, TeamWithMembersSchema);
  },
  archive(projectId: string, teamId: string): Promise<z.infer<typeof TeamSchema>> {
    return api.post(`/api/projects/${encodeURIComponent(projectId)}/teams/${encodeURIComponent(teamId)}/archive`, {}, TeamSchema);
  },
  createDelegation(
    taskId: string,
    input: { teamId: string; agentId: string; objective: string; acceptanceCriteria?: string[] },
  ): Promise<Delegation> {
    return api.post(`/api/tasks/${encodeURIComponent(taskId)}/delegations`, input, DelegationSchema);
  },
  resolveDelegation(delegationId: string, parentTaskId: string, decision: "approve" | "reject"): Promise<Delegation> {
    return api.post(`/api/delegations/${encodeURIComponent(delegationId)}/resolve`, { parentTaskId, decision }, DelegationSchema);
  },
  cancelDelegation(delegationId: string, parentTaskId: string): Promise<Delegation> {
    return api.post(`/api/delegations/${encodeURIComponent(delegationId)}/cancel`, { parentTaskId }, DelegationSchema);
  },
  runReadmeSummarySample(projectId: string) {
    // Deliberately a light, UI-shaped schema (not the full Team/Delegation/
    // Handoff contracts) — this call only ever needs to render a short proof
    // summary, and staying loose here keeps the web client from breaking on
    // fields the orchestrator adds later.
    return api.post(
      `/api/projects/${encodeURIComponent(projectId)}/sample-tasks/readme-summary`,
      {},
      z.object({
        team: z.object({ id: z.string(), name: z.string() }).passthrough(),
        parentTask: z.object({ id: z.string(), status: z.string() }).passthrough(),
        delegation: z.object({ id: z.string(), status: z.string() }).passthrough(),
        handoff: z.object({
          id: z.string(),
          resultSummary: z.string(),
          acceptanceCriteriaStatus: z.array(z.object({ criterion: z.string(), met: z.boolean(), note: z.string().nullable().optional() })),
          verificationEvidence: z.string().nullable().optional(),
        }).passthrough(),
      }).passthrough(),
    );
  },
};
