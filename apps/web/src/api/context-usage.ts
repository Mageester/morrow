import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";
import { taskQueryKey } from "./task-keys.js";

/**
 * How much of the route's context window the last turn actually consumed.
 *
 * Only the fields the meter needs are modelled, and every one of them is
 * nullable on purpose. The orchestrator is deliberate about not inventing
 * token counts (services/orchestrator/src/routing/usage-snapshot.ts): a
 * provider that reports no usage yields null, not zero. A ring that renders
 * an unreported count as 0% is a lie in the most reassuring possible
 * direction, so the meter has to be able to tell "nothing used yet" apart
 * from "nobody told us".
 */
const ContextUsageSchema = z
  .object({
    contextWindowTokens: z.number().nullable().optional(),
    currentRequestTokens: z.number().nullable().optional(),
    maxInputTokens: z.number().nullable().optional(),
    exact: z.boolean().nullable().optional(),
    countingMethod: z.string().nullable().optional(),
    contextWindowSource: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    providerId: z.string().nullable().optional(),
  })
  .loose();

const TaskDetailSchema = z.object({ context: ContextUsageSchema.nullable() }).loose();

export type ContextUsage = z.infer<typeof ContextUsageSchema>;

export const contextUsageQueries = {
  forTask(taskId: string) {
    return queryOptions({
      queryKey: [...taskQueryKey(taskId), "context"] as const,
      queryFn: async () => (await api.get(`/api/tasks/${encodeURIComponent(taskId)}`, TaskDetailSchema)).context,
      // A finished turn's usage never changes — but an in-flight one does, and
      // this key can resolve before the turn finishes (mounted the moment the
      // task exists). staleTime alone would then cache that empty snapshot
      // for a full minute; chat-stream.ts invalidates this task's queries on
      // every lifecycle transition so a real answer replaces it as soon as
      // the orchestrator has one, not on a timer.
      staleTime: 60_000,
    });
  },
};
