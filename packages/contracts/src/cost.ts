import { z } from "zod";

const safeNonNegativeInteger = (name: string) => z.number().int().nonnegative().refine(Number.isSafeInteger, {
  message: `${name} must be a safe integer`,
});

export const CostAccuracySchema = z.enum([
  "provider_billed",
  "exact_usage_pricing",
  "estimated",
  "unknown",
]);
export type CostAccuracy = z.infer<typeof CostAccuracySchema>;

export const MoneyAmountSchema = z.object({
  currency: z.literal("USD"),
  micros: safeNonNegativeInteger("micros"),
}).strict();
export type MoneyAmount = z.infer<typeof MoneyAmountSchema>;

export const PricingSnapshotSchema = z.object({
  inputMicrosPerMillion: safeNonNegativeInteger("inputMicrosPerMillion"),
  outputMicrosPerMillion: safeNonNegativeInteger("outputMicrosPerMillion"),
  cachedInputMicrosPerMillion: safeNonNegativeInteger("cachedInputMicrosPerMillion").nullable(),
  source: z.enum(["authoritative", "provider-reported"]),
  metadataVersion: z.string().nullable(),
  fetchedAt: z.string().datetime().nullable(),
}).strict();
export type PricingSnapshot = z.infer<typeof PricingSnapshotSchema>;

export const CostCalculationSchema = z.object({
  amount: MoneyAmountSchema.nullable(),
  accuracy: CostAccuracySchema,
}).strict();
export type CostCalculation = z.infer<typeof CostCalculationSchema>;

export interface CostUsageInput {
  /** Total prompt/input tokens, including any cached subset. */
  inputTokens: number | null;
  /** Provider-reported cached subset; null/omitted means the split is unknown. */
  cachedInputTokens?: number | null;
  outputTokens: number | null;
}

export const CostLineSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  requestId: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  inputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  amount: MoneyAmountSchema.nullable(),
  accuracy: CostAccuracySchema,
  pricing: PricingSnapshotSchema.nullable(),
  recordedAt: z.string().datetime(),
}).strict().refine(
  (line) => line.cachedInputTokens === null
    ? true
    : line.inputTokens !== null && line.cachedInputTokens <= line.inputTokens,
  { message: "cached input tokens must be a subset of total input tokens", path: ["cachedInputTokens"] },
);
export type CostLine = z.infer<typeof CostLineSchema>;

const TaskCostSummaryBaseSchema = z.object({
  taskId: z.string(),
  total: MoneyAmountSchema.nullable(),
  accuracy: CostAccuracySchema,
  requestCount: safeNonNegativeInteger("requestCount"),
  totalInputTokens: safeNonNegativeInteger("totalInputTokens"),
  knownFreshInputTokens: safeNonNegativeInteger("knownFreshInputTokens"),
  knownCachedInputTokens: safeNonNegativeInteger("knownCachedInputTokens"),
  outputTokens: safeNonNegativeInteger("outputTokens"),
  cacheBreakdownComplete: z.boolean(),
  lines: z.array(CostLineSchema),
}).strict();
export const TaskCostSummarySchema = TaskCostSummaryBaseSchema.superRefine((summary, context) => {
  const hasUnknownLine = summary.lines.some((line) => line.amount === null || line.accuracy === "unknown");
  if (hasUnknownLine) {
    if (summary.total !== null) {
      context.addIssue({ code: "custom", path: ["total"], message: "total must be null when any cost line is unknown" });
    }
    if (summary.accuracy !== "unknown") {
      context.addIssue({ code: "custom", path: ["accuracy"], message: "accuracy must be unknown when any cost line is unknown" });
    }
    return;
  }

  if (summary.lines.length > 0 && summary.total === null) {
    context.addIssue({ code: "custom", path: ["total"], message: "total is required when all cost lines are known" });
    return;
  }
  if (summary.total !== null) {
    const summedMicros = summary.lines.reduce((sum, line) => sum + BigInt(line.amount?.micros ?? 0), 0n);
    if (summedMicros !== BigInt(summary.total.micros)) {
      context.addIssue({ code: "custom", path: ["total"], message: "total must equal the sum of known cost lines" });
    }
  }
});
export type TaskCostSummary = z.infer<typeof TaskCostSummarySchema>;

const MICROS_PER_USD = 1_000_000;
const TOKENS_PER_MILLION = 1_000_000n;

/**
 * Convert a decimal USD-per-million rate into the fixed-point rate used by
 * PricingSnapshot. The conversion is performed once at the metadata boundary;
 * request totals never multiply or add floating-point currency values.
 */
export function normalizeUsdPerMillionToMicros(rate: number): number {
  if (!Number.isFinite(rate) || rate < 0) {
    throw new RangeError("pricing rate must be a finite non-negative number");
  }
  const micros = Math.round(rate * MICROS_PER_USD);
  if (!Number.isSafeInteger(micros)) {
    throw new RangeError("pricing rate cannot be normalized to a safe integer micro-rate");
  }
  return micros;
}

function assertSafeNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a safe non-negative integer`);
  }
}

function assertSafeMicroRate(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a safe integer micro-rate`);
  }
}

function unknownCost(): CostCalculation {
  return { amount: null, accuracy: "unknown" };
}

/**
 * Calculate one provider response's usage cost using integer micro-USD rates.
 * Positive fractional micro-USD values are rounded half-up once, after all
 * token components have been summed as a BigInt rational numerator.
 */
export function calculateUsageCostMicros(
  usage: CostUsageInput | null | undefined,
  pricingSnapshot: PricingSnapshot | null | undefined,
): CostCalculation {
  if (!usage || usage.inputTokens === null || usage.outputTokens === null) return unknownCost();
  if (!pricingSnapshot || pricingSnapshot.source !== "authoritative") return unknownCost();

  assertSafeNonNegativeInteger(usage.inputTokens, "input tokens");
  assertSafeNonNegativeInteger(usage.outputTokens, "output tokens");
  assertSafeMicroRate(pricingSnapshot.inputMicrosPerMillion, "input rate");
  assertSafeMicroRate(pricingSnapshot.outputMicrosPerMillion, "output rate");
  if (pricingSnapshot.cachedInputMicrosPerMillion !== null) {
    assertSafeMicroRate(pricingSnapshot.cachedInputMicrosPerMillion, "cached input rate");
  }

  const cachedInputTokens = usage.cachedInputTokens ?? null;
  if (cachedInputTokens !== null) {
    assertSafeNonNegativeInteger(cachedInputTokens, "cached input tokens");
    if (cachedInputTokens > usage.inputTokens) {
      throw new RangeError("cached input tokens must be a subset of total input tokens");
    }
  }

  const hasDiscountedCacheRate = pricingSnapshot.cachedInputMicrosPerMillion !== null
    && pricingSnapshot.cachedInputMicrosPerMillion !== pricingSnapshot.inputMicrosPerMillion;
  const hasCacheBreakdown = cachedInputTokens !== null;
  if (hasDiscountedCacheRate && !hasCacheBreakdown) return unknownCost();

  const cachedInputMicrosPerMillion = pricingSnapshot.cachedInputMicrosPerMillion
    ?? pricingSnapshot.inputMicrosPerMillion;
  const uncachedInputTokens = hasCacheBreakdown ? usage.inputTokens - cachedInputTokens : usage.inputTokens;
  const inputMicros = BigInt(uncachedInputTokens) * BigInt(pricingSnapshot.inputMicrosPerMillion);
  const cachedMicros = hasCacheBreakdown
    ? BigInt(cachedInputTokens) * BigInt(cachedInputMicrosPerMillion)
    : 0n;
  const outputMicros = BigInt(usage.outputTokens) * BigInt(pricingSnapshot.outputMicrosPerMillion);
  const numerator = inputMicros + cachedMicros + outputMicros;
  const microsBigInt = (numerator + TOKENS_PER_MILLION / 2n) / TOKENS_PER_MILLION;
  if (microsBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("calculated cost exceeds a safe integer micro-USD amount");
  }

  return {
    amount: { currency: "USD", micros: Number(microsBigInt) },
    accuracy: "exact_usage_pricing",
  };
}
