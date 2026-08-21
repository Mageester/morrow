import { ThreadHandoffsSchema, type ThreadHandoffs } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";

const threadPath = (projectId: string, conversationId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/handoffs`;

export const handoffKeys = {
  all: ["handoffs"] as const,
  thread(projectId: string, conversationId: string) {
    return [...this.all, projectId, conversationId] as const;
  },
};

/**
 * Polled while a teammate is working. A handoff runs in its own thread, so
 * this projection is the only place its progress shows up in the thread that
 * asked for it.
 */
const HANDOFF_POLL_MS = 3_000;

export const handoffQueries = {
  thread(projectId: string, conversationId: string) {
    return queryOptions<ThreadHandoffs>({
      queryKey: handoffKeys.thread(projectId, conversationId),
      queryFn: () => api.get(threadPath(projectId, conversationId), ThreadHandoffsSchema),
      enabled: Boolean(projectId) && Boolean(conversationId),
      refetchInterval: (query) =>
        (query.state.data?.handoffs ?? []).some((handoff) => handoff.status === "running" || handoff.status === "queued")
          ? HANDOFF_POLL_MS
          : false,
    });
  },
};

const StartedHandoffSchema = z.object({
  version: z.literal(1),
  handoffTaskId: z.string(),
  agentId: z.string(),
  agentName: z.string(),
});

export const handoffApi = {
  start(
    projectId: string,
    conversationId: string,
    input: { parentTaskId: string; agentId: string; objective: string },
  ) {
    return api.post(threadPath(projectId, conversationId), input, StartedHandoffSchema);
  },
};
