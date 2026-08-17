import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";
import { taskQueryKey } from "./task-keys.js";

/**
 * The full route-aware capability/status snapshot for one task: exact
 * provider/model, real context-window arithmetic with provenance, and the
 * reasoning selection Morrow actually sent on the wire.
 *
 * Every field here is a read-only view of a single orchestrator computation
 * (routing/model-budget.ts's ModelBudget, and the exact translateReasoning()
 * output for the request that was made) — nothing is recomputed or guessed in
 * the browser. `.loose()` throughout: this endpoint carries far more than
 * this view needs, and a field this view doesn't yet know about must never
 * fail the whole fetch — the context meter that already depends on this same
 * endpoint would break too.
 */
const ContextSnapshotSchema = z
  .object({
    providerId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    contextWindowTokens: z.number().nullable().optional(),
    currentRequestTokens: z.number().nullable().optional(),
    maxInputTokens: z.number().nullable().optional(),
    exact: z.boolean().nullable().optional(),
    countingMethod: z.string().nullable().optional(),
    contextWindowSource: z.string().nullable().optional(),
    // "verified" | "reported" | "configured" | "unverified" — see
    // routing/model-budget.ts's ModelBudget.contextWindowConfidence.
    contextWindowConfidence: z.string().nullable().optional(),
    outputReserveTokens: z.number().nullable().optional(),
    reservedTokens: z.number().nullable().optional(),
    // Route-aware capacity diagnostics (routing/effective-context.ts).
    nativeContextWindowTokens: z.number().nullable().optional(),
    nativeContextWindowSource: z.string().nullable().optional(),
    routeLimitTokens: z.number().nullable().optional(),
    routeLimitSource: z.string().nullable().optional(),
    effectiveContextWindowTokens: z.number().nullable().optional(),
    harnessReserveTokens: z.number().nullable().optional(),
    totalReserveTokens: z.number().nullable().optional(),
    currentModelVisibleTokens: z.number().nullable().optional(),
    remainingInputTokens: z.number().nullable().optional(),
    compactionThresholdTokens: z.number().nullable().optional(),
    compactionThresholdRatio: z.number().nullable().optional(),
  })
  .loose();

const ReasoningApplicationSchema = z
  .object({
    // The reasoning selection frozen onto the routing decision at send time.
    requested: z.record(z.string(), z.unknown()).nullable().optional(),
    // What Morrow actually sent for the winning candidate — falls back to the
    // route default (often equal to `requested`, but not always: an
    // unsupported selection or a protocol continuity constraint can differ).
    applied: z.record(z.string(), z.unknown()).nullable().optional(),
    supported: z.boolean().nullable().optional(),
    unsupportedReason: z.string().nullable().optional(),
    // The literal request-body fragment translateReasoning() produced for
    // this exact provider/model, e.g. `{ thinkingConfig: { thinkingLevel:
    // "HIGH" } }`. An empty object is a real, honest answer: "no explicit
    // reasoning parameter was sent".
    wireParams: z.record(z.string(), z.unknown()).nullable().optional(),
    control: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    wire: z.string().nullable().optional(),
    supportsOff: z.boolean().nullable().optional(),
    fallbackToRouteDefault: z.boolean().optional(),
  })
  .loose();

const RoutingSnapshotSchema = z
  .object({
    providerId: z.string().optional(),
    model: z.string().optional(),
    presetId: z.string().optional(),
    fallbackUsed: z.boolean().optional(),
    overridden: z.boolean().optional(),
    reasoning: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .loose();

const TaskCapabilitySchema = z
  .object({
    context: ContextSnapshotSchema.nullable(),
    routing: RoutingSnapshotSchema.nullable(),
    reasoningApplication: ReasoningApplicationSchema.nullable(),
  })
  .loose();

export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;
export type ReasoningApplication = z.infer<typeof ReasoningApplicationSchema>;
export type RoutingSnapshot = z.infer<typeof RoutingSnapshotSchema>;
export type TaskCapability = z.infer<typeof TaskCapabilitySchema>;

export const taskCapabilityQueries = {
  forTask(taskId: string) {
    return queryOptions({
      queryKey: [...taskQueryKey(taskId), "capability"] as const,
      queryFn: () => api.get(`/api/tasks/${encodeURIComponent(taskId)}`, TaskCapabilitySchema),
      // A finished turn's snapshot never changes — but this key can resolve
      // before the turn finishes (the inspector mounts as soon as a task
      // exists, well before routing/context/reasoning events land). Without
      // an explicit invalidation, staleTime alone would pin that empty
      // snapshot in the cache for a full minute regardless of what the
      // orchestrator has since recorded. chat-stream.ts invalidates every
      // query under this task's key prefix on each lifecycle transition —
      // in particular on task.terminal — so completion always replaces it.
      staleTime: 60_000,
    });
  },
};
