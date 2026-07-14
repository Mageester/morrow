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
 * Every number here is honestly labeled. A provider reports a TOTAL
 * prompt/input token count, and — separately, optionally — a cached-token
 * count. When the cached count is absent, Morrow knows the total but does
 * NOT know the fresh/cached split: `freshInputTokens` and `cachedInputTokens`
 * must both be `null` in that case, never "total treated as all-fresh." A
 * fabricated fresh/cached split is exactly as dishonest as a fabricated
 * zero, and neither is acceptable.
 */
export type UsageTokenConfidence = "exact" | "unavailable";
export type UsageTokenSource = "provider-reported" | "unavailable";
export type UsageCostSource = "provider-metered" | "morrow-estimated" | "unavailable";
/** Whether a response's fresh/cached breakdown of its total input is known
 * at all. "reported" means the provider sent an explicit cached-token count
 * for this response (whether or not that count is zero); "unavailable"
 * means it did not, and the split must not be guessed. */
export type CacheBreakdownStatus = "reported" | "unavailable";

export interface RequestUsage {
  providerId: string;
  modelId: string;
  /** Route/request identity, when the caller has one (e.g. the durable
   * provider-route fingerprint). Absent when the caller has no stable
   * per-request identity to attach (never fabricated). */
  routeFingerprint: string | null;

  /** Total prompt/input tokens (fresh + cached combined), as reported by the
   * provider. Known whenever the provider reports usage at all for this
   * response — independent of whether a cache breakdown was also given. */
  totalInputTokens: number | null;
  /** Input tokens NOT served from a provider cache. Null unless the provider
   * also reported a cached-token count for this response — never inferred
   * from totalInputTokens alone. */
  freshInputTokens: number | null;
  /** Input tokens served from a provider cache. Null unless reported. */
  cachedInputTokens: number | null;
  outputTokens: number | null;
  /** totalInputTokens + outputTokens, when both are known. Deliberately does
   * NOT require the fresh/cached split to be known — a wire total is knowable
   * even when its cache composition is not. */
  totalTokens: number | null;

  /** Whether THIS response's fresh/cached split is known. */
  cacheBreakdownStatus: CacheBreakdownStatus;

  tokenSource: UsageTokenSource;
  /** Confidence in totalInputTokens/outputTokens/totalTokens (the provider
   * either reported usage or did not). This is intentionally separate from
   * cacheBreakdownStatus: a response can have "exact" total/output token
   * counts while its fresh/cached split remains "unavailable" — the two
   * must never be conflated into one confidence value. */
  tokenConfidence: UsageTokenConfidence;

  /** Morrow never ingests real provider billing data today, so this is
   * always "morrow-estimated" (from the static pricing table, using total
   * input tokens and — only when known — the cached subtotal) or
   * "unavailable" — "provider-metered" is reserved for a future real
   * billing-API integration and must not be claimed until one exists. An
   * estimate computed without a known cache breakdown is still a valid
   * total-input-based estimate; it is simply not cache-adjusted, and must
   * never be presented as one. */
  costUsd: number | null;
  costSource: UsageCostSource;
}

export interface CumulativeUsage {
  /** Number of provider responses folded into this total. Each response is
   * counted exactly once by construction (accumulateUsage takes one
   * RequestUsage at a time and is never re-applied to the same response). */
  responseCount: number;
  /** Sum of every folded response's totalInputTokens. Always a complete,
   * exact sum — the fresh/cached split's incompleteness never affects this
   * field, since totalInputTokens does not depend on that split. */
  totalInputTokens: number;
  outputTokens: number;
  /** Sum of freshInputTokens across only the responses that reported a cache
   * breakdown. This is the COMPLETE, exact cumulative fresh total only when
   * `cacheBreakdownComplete` is true; otherwise it is a partial subtotal
   * (a lower bound) and must be presented as such, never as the whole. */
  knownFreshInputTokens: number;
  /** Sum of cachedInputTokens across only the responses that reported one.
   * Same completeness caveat as knownFreshInputTokens. */
  knownCachedInputTokens: number;
  /** True only when EVERY folded response reported a cache breakdown. False
   * as soon as a single response did not — from that point on,
   * knownFreshInputTokens/knownCachedInputTokens are partial subtotals, not
   * the true cumulative split, and must be displayed as "at least N", never
   * as an unqualified total. */
  cacheBreakdownComplete: boolean;
  /** Null until the first response with a known cost is folded in. */
  totalCostUsd: number | null;
}

export const EMPTY_CUMULATIVE_USAGE: CumulativeUsage = {
  responseCount: 0,
  totalInputTokens: 0,
  outputTokens: 0,
  knownFreshInputTokens: 0,
  knownCachedInputTokens: 0,
  cacheBreakdownComplete: true, // vacuously true; the first incomplete response flips it
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
      totalInputTokens: null,
      freshInputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cacheBreakdownStatus: "unavailable",
      tokenSource: "unavailable",
      tokenConfidence: "unavailable",
      costUsd: null,
      costSource: "unavailable",
    };
  }

  const totalInputTokens = input.usage.promptTokens;
  const outputTokens = input.usage.completionTokens;
  const totalTokens = totalInputTokens + outputTokens;
  const hasCacheBreakdown = input.usage.cachedPromptTokens !== undefined;
  const cachedInputTokens = hasCacheBreakdown ? input.usage.cachedPromptTokens! : null;
  // The fresh/cached split is only derivable when the provider told us the
  // cached portion; otherwise it stays null — never "assume all fresh."
  const freshInputTokens = hasCacheBreakdown ? Math.max(0, totalInputTokens - cachedInputTokens!) : null;

  const cost = calculateUsageCost(
    {
      inputTokens: totalInputTokens,
      outputTokens,
      ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
    },
    input.metadata ?? undefined,
  );

  return {
    providerId: input.providerId,
    modelId: input.modelId,
    routeFingerprint,
    totalInputTokens,
    freshInputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    cacheBreakdownStatus: hasCacheBreakdown ? "reported" : "unavailable",
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
  const thisResponseComplete = request.cacheBreakdownStatus === "reported";
  return {
    responseCount: base.responseCount + 1,
    totalInputTokens: base.totalInputTokens + (request.totalInputTokens ?? 0),
    outputTokens: base.outputTokens + (request.outputTokens ?? 0),
    knownFreshInputTokens: base.knownFreshInputTokens + (request.freshInputTokens ?? 0),
    knownCachedInputTokens: base.knownCachedInputTokens + (request.cachedInputTokens ?? 0),
    cacheBreakdownComplete: base.cacheBreakdownComplete && thisResponseComplete,
    totalCostUsd: request.costUsd === null
      ? base.totalCostUsd
      : (base.totalCostUsd ?? 0) + request.costUsd,
  };
}
