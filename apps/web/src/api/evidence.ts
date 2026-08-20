import { WebToolEvidenceSchema, type WebToolEvidence } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client.js";

export const evidenceKeys = {
  all: ["evidence"] as const,
  step(projectId: string, conversationId: string, taskId: string, toolCallId: string) {
    return [...this.all, projectId, conversationId, taskId, toolCallId] as const;
  },
};

export const evidenceQueries = {
  /**
   * One step's recorded output. Fetched only when a reader opens the row —
   * the transcript deliberately carries handles rather than output, so a
   * conversation with two hundred steps costs two hundred short rows, not two
   * hundred command logs.
   */
  step(projectId: string, conversationId: string, taskId: string, toolCallId: string) {
    return queryOptions<WebToolEvidence>({
      queryKey: evidenceKeys.step(projectId, conversationId, taskId, toolCallId),
      queryFn: () =>
        api.get(
          `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`
          + `/tasks/${encodeURIComponent(taskId)}/evidence/${encodeURIComponent(toolCallId)}`,
          WebToolEvidenceSchema,
        ),
      // A settled step's output never changes, and an open card should not
      // flicker when the transcript around it refetches.
      staleTime: 5 * 60_000,
    });
  },
};
