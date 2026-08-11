export interface TokenPricing {
  /** Price for uncached input tokens, in USD per million tokens. */
  inputUsdPerMillion: number;
  /** Optional price for cached input tokens, in USD per million tokens. */
  cachedInputUsdPerMillion?: number;
  /** Price for output tokens, in USD per million tokens. */
  outputUsdPerMillion: number;
}

export interface BenchmarkRecord {
  harness: string;
  model?: string;
  taskId?: string;
  scenario?: string;
  benchmarkRun?: string;
  evidenceClass?: "deterministic-local" | "live-provider" | "black-box-deferred";
  outcome?: "success" | "partial" | "failure";
  failureReason?: string | null;
  reasoningMode?: string | null;
  passed: boolean;
  durationMs: number;
  timeToFirstTokenMs?: number | null;
  providerCompletionMs?: number | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  requestInputTokens?: number[];
  contextTokenSamples?: number[];
  contextGrowthTokens?: number | null;
  harnessOverheadTokens?: number | null;
  toolSchemaTokens?: number | null;
  protocolOverheadTokens?: number | null;
  providerContinuationTokens?: number | null;
  providerCalls?: number | null;
  toolCalls?: number | null;
  toolFailures?: number | null;
  fallbackEvents?: number | null;
  duplicateObservations?: number | null;
  contextCompactions?: number | null;
  recoveryAttempts?: number | null;
  interventions?: number | null;
  pricing?: TokenPricing | null;
  /** Prefer provider-metered cost when it is available. */
  measuredCostUsd?: number | null;
}

export type BenchmarkCostSource = "measured" | "estimated" | "mixed" | "unavailable";

export interface BenchmarkCost {
  amountUsd: number | null;
  source: Exclude<BenchmarkCostSource, "mixed">;
}

export interface HarnessSummary {
  harness: string;
  sampleSize: number;
  passRate: number | null;
  medianCostUsd: number | null;
  medianTimeMs: number | null;
  costSource: BenchmarkCostSource;
  costSamples: number;
  medianProviderCalls: number | null;
  medianToolCalls: number | null;
  medianDuplicateObservations: number | null;
  medianContextCompactions: number | null;
  medianRecoveryAttempts: number | null;
  medianInterventions: number | null;
}

/**
 * DeepSeek's published V4 Pro prices as of 2026-08-10. Keep benchmark input
 * records explicit about pricing so a rerun remains auditable if the provider
 * changes its price sheet.
 */
export const DEEPSEEK_V4_PRO_PRICING: TokenPricing = {
  inputUsdPerMillion: 0.435,
  cachedInputUsdPerMillion: 0.003625,
  outputUsdPerMillion: 0.87,
};

/** DeepSeek's published V4 Flash prices as of 2026-08-10. */
export const DEEPSEEK_V4_FLASH_PRICING: TokenPricing = {
  inputUsdPerMillion: 0.14,
  cachedInputUsdPerMillion: 0.0028,
  outputUsdPerMillion: 0.28,
};

const MILLION = 1_000_000;

export function estimateBenchmarkCost(record: BenchmarkRecord): BenchmarkCost {
  if (record.measuredCostUsd !== undefined && record.measuredCostUsd !== null) {
    return { amountUsd: record.measuredCostUsd, source: "measured" };
  }

  const inputTokens = record.inputTokens;
  const outputTokens = record.outputTokens;
  const pricing = record.pricing;
  if (inputTokens === undefined || inputTokens === null || outputTokens === undefined || outputTokens === null || !pricing) {
    return { amountUsd: null, source: "unavailable" };
  }

  const cachedInputTokens = Math.min(record.cachedInputTokens ?? 0, inputTokens);
  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const cachedPrice = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
  const amountUsd =
    (uncachedInputTokens * pricing.inputUsdPerMillion + cachedInputTokens * cachedPrice + outputTokens * pricing.outputUsdPerMillion) /
    MILLION;
  return { amountUsd, source: "estimated" };
}

export function summarizeBenchmarkRecords(records: readonly BenchmarkRecord[]): HarnessSummary[] {
  const grouped = new Map<string, BenchmarkRecord[]>();
  for (const record of records) {
    const group = grouped.get(record.harness) ?? [];
    group.push(record);
    grouped.set(record.harness, group);
  }

  return [...grouped.entries()].map(([harness, group]) => {
    const costs = group.map(estimateBenchmarkCost).filter((cost): cost is { amountUsd: number; source: "measured" | "estimated" } => cost.amountUsd !== null);
    const sources = new Set(costs.map((cost) => cost.source));
    const costSource: BenchmarkCostSource =
      costs.length === 0 ? "unavailable" : sources.size > 1 ? "mixed" : costs[0]!.source;
    return {
      harness,
      sampleSize: group.length,
      passRate: group.length === 0 ? null : group.filter((record) => record.passed).length / group.length,
      medianCostUsd: median(costs.map((cost) => cost.amountUsd)),
      medianTimeMs: median(group.map((record) => record.durationMs)),
      costSource,
      costSamples: costs.length,
      medianProviderCalls: medianCounter(group, "providerCalls"),
      medianToolCalls: medianCounter(group, "toolCalls"),
      medianDuplicateObservations: medianCounter(group, "duplicateObservations"),
      medianContextCompactions: medianCounter(group, "contextCompactions"),
      medianRecoveryAttempts: medianCounter(group, "recoveryAttempts"),
      medianInterventions: medianCounter(group, "interventions"),
    };
  });
}

export function parseBenchmarkRecords(input: unknown): BenchmarkRecord[] {
  const rawRecords = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.records)
      ? input.records
      : null;
  if (!rawRecords) throw new Error("benchmark input must be an array or an object with a records array");

  return rawRecords.map((value, index) => parseBenchmarkRecord(value, index));
}

export interface BenchmarkSvgOptions {
  title?: string;
  width?: number;
  height?: number;
}

export function renderBenchmarkSvg(summaries: readonly HarnessSummary[], options: BenchmarkSvgOptions = {}): string {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const title = options.title ?? "Morrow harness economics";
  const subtitle = `${summaries.reduce((total, summary) => total + summary.sampleSize, 0)} measured tasks · personal benchmark artifact`;
  const colors = ["#f5b532", "#dc579a", "#78a0ed", "#4fc2ad", "#ed8262", "#b08ae8"];
  const chartTop = 166;
  const chartBottom = height - 118;
  const chartHeight = chartBottom - chartTop;
  const outerX = 58;
  const panelGap = 28;
  const panelWidth = (width - outerX * 2 - panelGap * 2) / 3;

  const metrics = [
    {
      title: "Pass rate",
      max: 1,
      value: (summary: HarnessSummary) => summary.passRate,
      format: (value: number) => `${(value * 100).toFixed(value * 100 % 1 === 0 ? 0 : 1)}%`,
      ticks: (max: number) => [0, 0.25, 0.5, 0.75, 1],
    },
    {
      title: "Median cost per task",
      max: Math.max(0.01, ...summaries.map((summary) => summary.medianCostUsd ?? 0)) * 1.2,
      value: (summary: HarnessSummary) => summary.medianCostUsd,
      format: (value: number) => `$${value.toFixed(value < 0.1 ? 3 : 2)}`,
      ticks: (max: number) => [0, max * 0.25, max * 0.5, max * 0.75, max],
    },
    {
      title: "Median time per task",
      max: Math.max(1, ...summaries.map((summary) => (summary.medianTimeMs ?? 0) / 1000)) * 1.2,
      value: (summary: HarnessSummary) => (summary.medianTimeMs === null ? null : summary.medianTimeMs / 1000),
      format: (value: number) => `${value.toFixed(value < 10 ? 1 : 0)}s`,
      ticks: (max: number) => [0, max * 0.25, max * 0.5, max * 0.75, max],
    },
  ] as const;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="benchmark-title benchmark-subtitle">`);
  parts.push(`<rect width="${width}" height="${height}" fill="#11110f"/>`);
  parts.push(`<style>text{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif} .axis{fill:#8d8980;font-size:14px} .title{fill:#f4f0e7;font-size:21px;font-weight:600} .value{fill:#f4f0e7;font-size:17px;font-weight:700} .harness{fill:#b7b1a7;font-size:14px} .meta{fill:#77736b;font-size:12px}</style>`);
  parts.push(`<text id="benchmark-title" x="${outerX}" y="54" fill="#f4f0e7" font-size="27" font-weight="700">${escapeXml(title)}</text>`);
  parts.push(`<text id="benchmark-subtitle" x="${outerX}" y="82" fill="#858078" font-size="14">${escapeXml(subtitle)}</text>`);

  metrics.forEach((metric, metricIndex) => {
    const panelX = outerX + metricIndex * (panelWidth + panelGap);
    const centerX = panelX + panelWidth / 2;
    parts.push(`<text class="title" x="${centerX}" y="124" text-anchor="middle">${metric.title}</text>`);
    const ticks = metric.ticks(metric.max);
    ticks.forEach((tick) => {
      const y = chartBottom - (tick / metric.max) * chartHeight;
      parts.push(`<line x1="${panelX}" y1="${y.toFixed(2)}" x2="${(panelX + panelWidth).toFixed(2)}" y2="${y.toFixed(2)}" stroke="#2b2926" stroke-width="1"/>`);
      parts.push(`<text class="axis" x="${panelX - 12}" y="${(y + 5).toFixed(2)}" text-anchor="end">${metricIndex === 0 ? `${Math.round(tick * 100)}%` : metricIndex === 1 ? `$${tick.toFixed(3)}` : `${tick.toFixed(tick < 10 ? 1 : 0)}s`}</text>`);
    });

    const barGap = Math.max(10, Math.min(30, panelWidth / Math.max(summaries.length * 3, 1)));
    const barWidth = Math.min(62, Math.max(30, (panelWidth - barGap * (summaries.length + 1)) / Math.max(summaries.length, 1)));
    const barsWidth = summaries.length * barWidth + Math.max(0, summaries.length - 1) * barGap;
    const barsStart = centerX - barsWidth / 2;
    summaries.forEach((summary, summaryIndex) => {
      const value = metric.value(summary);
      const x = barsStart + summaryIndex * (barWidth + barGap);
      const color = colors[summaryIndex % colors.length]!;
      if (value === null) {
        parts.push(`<text class="meta" x="${(x + barWidth / 2).toFixed(2)}" y="${(chartBottom - 18).toFixed(2)}" text-anchor="middle">n/a</text>`);
      } else {
        const barHeight = (value / metric.max) * chartHeight;
        const y = chartBottom - barHeight;
        parts.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${Math.max(1, barHeight).toFixed(2)}" rx="2" fill="${color}"/>`);
        parts.push(`<text class="value" x="${(x + barWidth / 2).toFixed(2)}" y="${Math.max(chartTop + 18, y - 12).toFixed(2)}" text-anchor="middle">${metric.format(value)}</text>`);
      }
      const labels = wrapHarness(summary.harness);
      labels.forEach((label, lineIndex) => {
        parts.push(`<text class="harness" x="${(x + barWidth / 2).toFixed(2)}" y="${(chartBottom + 28 + lineIndex * 17).toFixed(2)}" text-anchor="middle">${escapeXml(label)}</text>`);
      });
      parts.push(`<text class="meta" x="${(x + barWidth / 2).toFixed(2)}" y="${(chartBottom + 63).toFixed(2)}" text-anchor="middle">n=${summary.sampleSize}</text>`);
    });
  });

  parts.push(`<text x="${width - outerX}" y="${height - 28}" fill="#77736b" font-size="12" text-anchor="end">Source: supplied benchmark records · costs are measured or token-estimated</text>`);
  parts.push("</svg>");
  return parts.join("\n");
}

function parseBenchmarkRecord(value: unknown, index: number): BenchmarkRecord {
  if (!isRecord(value)) throw new Error(`record ${index + 1} must be an object`);
  if (typeof value.harness !== "string" || value.harness.trim() === "") throw new Error(`record ${index + 1} harness must be a non-empty string`);
  if (typeof value.passed !== "boolean") throw new Error(`record ${index + 1} passed must be a boolean`);
  const durationMs = readNumber(value.durationMs, `record ${index + 1} durationMs`);
  if (durationMs < 0) throw new Error("durationMs must be a non-negative number");
  const timeToFirstTokenMs = readOptionalNumber(value.timeToFirstTokenMs, `record ${index + 1} timeToFirstTokenMs`);
  const providerCompletionMs = readOptionalNumber(value.providerCompletionMs, `record ${index + 1} providerCompletionMs`);
  if ((timeToFirstTokenMs !== undefined && timeToFirstTokenMs !== null && timeToFirstTokenMs < 0)
    || (providerCompletionMs !== undefined && providerCompletionMs !== null && providerCompletionMs < 0)) {
    throw new Error(`record ${index + 1} latency values must be non-negative`);
  }
  const inputTokens = readOptionalInteger(value.inputTokens, `record ${index + 1} inputTokens`);
  const cachedInputTokens = readOptionalInteger(value.cachedInputTokens, `record ${index + 1} cachedInputTokens`);
  const outputTokens = readOptionalInteger(value.outputTokens, `record ${index + 1} outputTokens`);
  const reasoningTokens = readOptionalInteger(value.reasoningTokens, `record ${index + 1} reasoningTokens`);
  const contextGrowthTokens = readOptionalInteger(value.contextGrowthTokens, `record ${index + 1} contextGrowthTokens`);
  const harnessOverheadTokens = readOptionalInteger(value.harnessOverheadTokens, `record ${index + 1} harnessOverheadTokens`);
  const toolSchemaTokens = readOptionalInteger(value.toolSchemaTokens, `record ${index + 1} toolSchemaTokens`);
  const protocolOverheadTokens = readOptionalInteger(value.protocolOverheadTokens, `record ${index + 1} protocolOverheadTokens`);
  const providerContinuationTokens = readOptionalInteger(value.providerContinuationTokens, `record ${index + 1} providerContinuationTokens`);
  const requestInputTokens = readOptionalIntegerArray(value.requestInputTokens, `record ${index + 1} requestInputTokens`);
  const contextTokenSamples = readOptionalIntegerArray(value.contextTokenSamples, `record ${index + 1} contextTokenSamples`);
  const providerCalls = readOptionalInteger(value.providerCalls, `record ${index + 1} providerCalls`);
  const toolCalls = readOptionalInteger(value.toolCalls, `record ${index + 1} toolCalls`);
  const toolFailures = readOptionalInteger(value.toolFailures, `record ${index + 1} toolFailures`);
  const fallbackEvents = readOptionalInteger(value.fallbackEvents, `record ${index + 1} fallbackEvents`);
  const duplicateObservations = readOptionalInteger(value.duplicateObservations, `record ${index + 1} duplicateObservations`);
  const contextCompactions = readOptionalInteger(value.contextCompactions, `record ${index + 1} contextCompactions`);
  const recoveryAttempts = readOptionalInteger(value.recoveryAttempts, `record ${index + 1} recoveryAttempts`);
  const interventions = readOptionalInteger(value.interventions, `record ${index + 1} interventions`);
  if (cachedInputTokens !== null && cachedInputTokens !== undefined && inputTokens !== null && inputTokens !== undefined && cachedInputTokens > inputTokens) {
    throw new Error(`record ${index + 1} cachedInputTokens cannot exceed inputTokens`);
  }
  const measuredCostUsd = readOptionalNumber(value.measuredCostUsd, `record ${index + 1} measuredCostUsd`);
  if (measuredCostUsd !== null && measuredCostUsd !== undefined && measuredCostUsd < 0) throw new Error(`record ${index + 1} measuredCostUsd must be non-negative`);
  const pricing = value.pricing === undefined || value.pricing === null ? value.pricing : parsePricing(value.pricing, index);
  return {
    harness: value.harness.trim(),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
    ...(typeof value.scenario === "string" ? { scenario: value.scenario } : {}),
    ...(typeof value.benchmarkRun === "string" ? { benchmarkRun: value.benchmarkRun } : {}),
    ...(value.evidenceClass === "deterministic-local" || value.evidenceClass === "live-provider" || value.evidenceClass === "black-box-deferred" ? { evidenceClass: value.evidenceClass } : {}),
    ...(value.outcome === "success" || value.outcome === "partial" || value.outcome === "failure" ? { outcome: value.outcome } : {}),
    ...(typeof value.failureReason === "string" || value.failureReason === null ? { failureReason: value.failureReason } : {}),
    ...(typeof value.reasoningMode === "string" || value.reasoningMode === null ? { reasoningMode: value.reasoningMode } : {}),
    passed: value.passed,
    durationMs,
    ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
    ...(providerCompletionMs !== undefined ? { providerCompletionMs } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(requestInputTokens !== undefined ? { requestInputTokens } : {}),
    ...(contextTokenSamples !== undefined ? { contextTokenSamples } : {}),
    ...(contextGrowthTokens !== undefined ? { contextGrowthTokens } : {}),
    ...(harnessOverheadTokens !== undefined ? { harnessOverheadTokens } : {}),
    ...(toolSchemaTokens !== undefined ? { toolSchemaTokens } : {}),
    ...(protocolOverheadTokens !== undefined ? { protocolOverheadTokens } : {}),
    ...(providerContinuationTokens !== undefined ? { providerContinuationTokens } : {}),
    ...(providerCalls !== undefined ? { providerCalls } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(toolFailures !== undefined ? { toolFailures } : {}),
    ...(fallbackEvents !== undefined ? { fallbackEvents } : {}),
    ...(duplicateObservations !== undefined ? { duplicateObservations } : {}),
    ...(contextCompactions !== undefined ? { contextCompactions } : {}),
    ...(recoveryAttempts !== undefined ? { recoveryAttempts } : {}),
    ...(interventions !== undefined ? { interventions } : {}),
    ...(pricing !== undefined ? { pricing } : {}),
    ...(measuredCostUsd !== undefined ? { measuredCostUsd } : {}),
  };
}

function parsePricing(value: unknown, index: number): TokenPricing {
  if (!isRecord(value)) throw new Error(`record ${index + 1} pricing must be an object`);
  const inputUsdPerMillion = readNumber(value.inputUsdPerMillion, `record ${index + 1} inputUsdPerMillion`);
  const outputUsdPerMillion = readNumber(value.outputUsdPerMillion, `record ${index + 1} outputUsdPerMillion`);
  const cachedInputUsdPerMillion = readOptionalNumber(value.cachedInputUsdPerMillion, `record ${index + 1} cachedInputUsdPerMillion`);
  if (inputUsdPerMillion < 0 || outputUsdPerMillion < 0 || (cachedInputUsdPerMillion !== undefined && cachedInputUsdPerMillion !== null && cachedInputUsdPerMillion < 0)) {
    throw new Error(`record ${index + 1} pricing values must be non-negative`);
  }
  return {
    inputUsdPerMillion,
    outputUsdPerMillion,
    ...(cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion } : {}),
  };
}

function readNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function readOptionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return readNumber(value, name);
}

function readOptionalInteger(value: unknown, name: string): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function readOptionalIntegerArray(value: unknown, name: string): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0) throw new Error(`${name}[${index}] must be a non-negative integer`);
    return item;
  });
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function medianCounter(records: readonly BenchmarkRecord[], key: keyof Pick<BenchmarkRecord, "providerCalls" | "toolCalls" | "duplicateObservations" | "contextCompactions" | "recoveryAttempts" | "interventions">): number | null {
  return median(records
    .map((record) => record[key])
    .filter((value): value is number => typeof value === "number"));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wrapHarness(value: string): string[] {
  const words = value.trim().split(/\s+/);
  if (words.length <= 2) return words.length === 1 ? [words[0]!] : [words[0]!, words[1]!];
  const midpoint = Math.ceil(words.length / 2);
  return [words.slice(0, midpoint).join(" "), words.slice(midpoint).join(" ")];
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}
