import type { ModelInfo } from "@morrow/contracts";
import { calculateUsageCost } from "./models.js";

/**
 * The canonical usage source of truth for one provider response and for the
 * running total across a task/session. This is deliberately separate from
 * ModelBudget (routing/model-budget.ts): ModelBudget owns capacity and
 * admission truth (how much a request is *allowed* to contain); this module
 * owns token and cost *accounting* truth (how much a request actually did,
 * or is known to, contain/cost). Neither may be derived from the other.
 *
 * Every number here is honestly labeled. A provider that does not report
 * cached-token or cost data produces `null` for that field, never a
 * fabricated zero — a cumulative total of "0 cached tokens" and "cached
 * tokens were never reported" are different facts and must never collapse
 * into the same value.
 */
export type UsageTokenConfidence = "exact" | "unavailable";
export type UsageTokenSource = "provider-reported" | "unavailable";
export type UsageCostSource = "provider-metered" | "morrow-estimated" | "unavailable";

export interface RequestUsage {
  providerId: string;
  modelId: string;
  /** Route/request identity, when the caller has one (e.g. the durable
   * provider-route fingerprint). Absent when the caller has no stable
   * per-request identity to attach (never fabricated). */
  routeFingerprint: string | null;

  /** Input tokens NOT served from a provider cache. Null when the provider
   * did not report usage at all for this response. */
  freshInputTokens: number | null;
  /** Input tokens served from a provider cache. Null when the provider does
   * not report a cached-token breakdown — never coerced to 0. */
  cachedInputTokens: number | null;
  outputTokens: number | null;
  /** freshInputTokens + cachedInputTokens + outputTokens, only when every
   * component is known; null otherwise (never a partial sum). */
  totalTokens: number | null;

  tokenSource: UsageTokenSource;
  tokenConfidence: UsageTokenConfidence;

  /** Morrow never ingests real provider billing data today, so this is
   * always "morrow-estimated" (from the static pricing table) or
   * "unavailable" — "provider-metered" is reserved for a future real
   * billing-API integration and must not be claimed until one exists. */
  costUsd: number | null;
  costSource: UsageCostSource;
}

export interface CumulativeUsage {
  /** Number of provider responses folded into this total. Each response is
   * counted exactly once by construction (accumulateUsage takes one
   * RequestUsage at a time and is never re-applied to the same response). */
  responseCount: number;
  freshInputTokens: number;
  /** Null until the first response with a known cached-token count is
   * folded in; a real sum of only the known values after that. Consumers
   * must not treat this as "no caching happened" when it is null — it means
   * "no response so far has told us." */
  cachedInputTokens: number | null;
  outputTokens: number;
  /** Null until the first response with a known cost is folded in. */
  totalCostUsd: number | null;
}

export const EMPTY_CUMULATIVE_USAGE: CumulativeUsage = {
  responseCount: 0,
  freshInputTokens: 0,
  cachedInputTokens: null,
  outputTokens: 0,
  totalCostUsd: null,
};

export interface ProviderReportedUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
}

/** Build the canonical per-response usage record. `usage` is the raw chunk
 * usage a provider adapter reported (or absent, if the provider never sent
 * one) — this is the single point where "did the provider tell us" is
 * decided; every other consumer reads the result, never the raw chunk. */
export function resolveRequestUsage(input: {
  providerId: string;
  modelId: string;
  routeFingerprint?: string | null;
  usage?: ProviderReportedUsage | null;
  metadata?: ModelInfo | null;
}): RequestUsage {
  const routeFingerprint = input.routeFingerprint ?? null;
  if (!input.usage) {
    return {
      providerId: input.providerId,
      modelId: input.modelId,
      routeFingerprint,
      freshInputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      totalTokens: null,
      tokenSource: "unavailable",
      tokenConfidence: "unavailable",
      costUsd: null,
      costSource: "unavailable",
    };
  }

  const cachedInputTokens = input.usage.cachedPromptTokens ?? null;
  const freshInputTokens = cachedInputTokens !== null
    ? Math.max(0, input.usage.promptTokens - cachedInputTokens)
    : input.usage.promptTokens;
  const outputTokens = input.usage.completionTokens;
  const totalTokens = input.usage.promptTokens + outputTokens;

  const cost = calculateUsageCost(
    {
      inputTokens: input.usage.promptTokens,
      outputTokens: input.usage.completionTokens,
      ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
    },
    input.metadata ?? undefined,
  );

  return {
    providerId: input.providerId,
    modelId: input.modelId,
    routeFingerprint,
    freshInputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    tokenSource: "provider-reported",
    tokenConfidence: "exact",
    costUsd: cost.known ? cost.usd : null,
    costSource: cost.known ? "morrow-estimated" : "unavailable",
  };
}

/** Fold exactly one request's usage into a running cumulative total. Pure
 * and order-dependent only in the sense that callers must invoke it once
 * per distinct provider response — never re-apply it to a response already
 * folded in, and never derive a cumulative total by re-summing persisted
 * context-window snapshots (those describe request *capacity*, not actual
 * usage). */
export function accumulateUsage(previous: CumulativeUsage | null, request: RequestUsage): CumulativeUsage {
  const base = previous ?? EMPTY_CUMULATIVE_USAGE;
  return {
    responseCount: base.responseCount + 1,
    freshInputTokens: base.freshInputTokens + (request.freshInputTokens ?? 0),
    cachedInputTokens: request.cachedInputTokens === null
      ? base.cachedInputTokens
      : (base.cachedInputTokens ?? 0) + request.cachedInputTokens,
    outputTokens: base.outputTokens + (request.outputTokens ?? 0),
    totalCostUsd: request.costUsd === null
      ? base.totalCostUsd
      : (base.totalCostUsd ?? 0) + request.costUsd,
  };
}
