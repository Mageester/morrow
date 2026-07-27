import { ApprovalSchema, type ApprovalDecision } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";

export const approvalKeys = {
  all: ["approvals"] as const,
  pending(projectId: string) {
    return [...this.all, "pending", projectId] as const;
  },
};

export const approvalQueries = {
  pending(projectId: string) {
    return queryOptions({
      queryKey: approvalKeys.pending(projectId),
      queryFn: () => approvalApi.listPending(projectId),
    });
  },
};

export const approvalApi = {
  listPending(projectId: string) {
    return api.get(
      `/api/projects/${projectId}/approvals?status=pending`,
      z.array(ApprovalSchema),
    );
  },

  resolve(approvalId: string, input: { projectId: string; decision: ApprovalDecision }) {
    return api.post(`/api/approvals/${approvalId}/resolve`, input, ApprovalSchema);
  },
};
