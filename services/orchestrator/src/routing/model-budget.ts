import type { RouteReasoningCapability } from "@morrow/contracts";
import type { ContextLimitSource, ProviderProtocol } from "../provider/base.js";
import { resolveModelMetadata, resolveReasoningCapability } from "./models.js";
import {
  resolveEffectiveContext,
  type EffectiveContextEndpointInput,
  type RouteFallbackIdentity,
} from "./effective-context.js";

/**
 * The single canonical model-capability + usable-budget resolution.
 *
 * This supersedes computing "how much input can we send" in two places with
 * two different reserve formulas (a route/endpoint-aware ceiling in
 * effective-context.ts and a preset/tool-aware ceiling in context-budget.ts).
 * Every consumer that needs to know the model, its verified capacity, or the
 * usable input budget for a request — routing, compaction, admission, the
 * terminal's /context and /model views, and task reports — reads this one
 * shape so they can never disagree.
 */
export interface ModelBudget {
  providerId: string;
  selectedModelId: string;
  canonicalModelId: string;
  displayName: string;
  capabilities: { streaming: boolean; toolCalls: boolean; vision: boolean };
  /** What reasoning control this exact route exposes, with provenance. */
  reasoning: RouteReasoningCapability;

  protocol: ProviderProtocol;
  endpointKind: EffectiveContextEndpointInput["kind"];
  endpointHost: string | null;

  /** The verified-or-configured ceiling for this exact route (smallest of
   * advertised model capacity and any configured endpoint override), before
   * any reserve is subtracted. Null when unknown. */
  contextWindowTokens: number | null;
  /** The model/adapter-owned native capacity before route overrides. */
  nativeContextWindowTokens: number | null;
  nativeContextWindowSource: ContextLimitSource;
  /** Configured/provider-reported route ceiling before choosing the effective minimum. */
  routeLimitTokens: number | null;
  routeLimitSource: ContextLimitSource;
  /** Alias with explicit semantics for diagnostics and future schema consumers. */
  effectiveContextWindowTokens: number | null;
  contextWindowSource: ContextLimitSource;
  /** "verified" ONLY for built-in model metadata (routing/models.ts).
   * "reported" for genuinely provider-reported metadata ("provider-metadata").
   * "configured" for a user-supplied context-window override or a configured
   * endpoint limit ("endpoint-override").
   * "unverified" when no authoritative value exists at all ("unknown" / "fallback"). */
  contextWindowConfidence: "verified" | "reported" | "configured" | "unverified";

  endpointLimitTokens: number | null;
  endpointLimitSource: ContextLimitSource;

  outputReserveTokens: number;
  safetyMarginTokens: number;
  toolReserveTokens: number;
  framingReserveTokens: number;
  harnessReserveTokens: number;
  totalReserveTokens: number;

  /** contextWindowTokens - totalReserveTokens: the real provider-capacity
   * ceiling. Null when context window is unknown. */
  usableInputTokens: number | null;
  /** usableInputTokens, additionally capped by a local preset/dev context
   * budget (bytes) when one is configured. */
  compactionTargetTokens: number | null;
  currentModelVisibleTokens: number | null;
  remainingInputTokens: number | null;
  compactionThresholdTokens: number | null;
  compactionThresholdRatio: number;

  /**
   * Demarcates which unverified-route category the conservative fallback was
   * sourced from.
   */
  routeFallbackIdentity: RouteFallbackIdentity;
}

export function resolveModelBudget(input: {
  providerId: string;
  selectedModel: string;
  endpoint: EffectiveContextEndpointInput;
  presetContextBudgetBytes?: number;
  outputBudgetTokens?: number;
  toolCount?: number;
  userContextWindowTokens?: number | null;
  safetyMarginTokens?: number;
  fallbackLimitTokens?: number;
  currentModelVisibleTokens?: number;
  compactionThresholdRatio?: number;
}): ModelBudget {
  const metadata = resolveModelMetadata(input.providerId, input.selectedModel);
  const effective = resolveEffectiveContext({
    providerId: input.providerId,
    selectedModel: input.selectedModel,
    endpoint: input.endpoint,
    outputReserveTokens: 1,
    ...(input.fallbackLimitTokens !== undefined ? { fallbackLimitTokens: input.fallbackLimitTokens } : {}),
  });

  const contextWindowTokens = input.userContextWindowTokens ?? effective.effectiveRequestLimitTokens;
  const contextWindowSource: ContextLimitSource = input.userContextWindowTokens
    ? "endpoint-override"
    : effective.effectiveLimitSource;
  const contextWindowConfidence: ModelBudget["contextWindowConfidence"] =
    input.userContextWindowTokens
      ? "configured"
      : contextWindowSource === "fallback" || contextWindowSource === "unknown"
        ? "unverified"
        : contextWindowSource === "endpoint-override"
          ? "configured"
          : metadata.confidence === "reported" || contextWindowSource === "provider-metadata"
            ? "reported"
            : "verified";

  const outputReserveTokens = input.outputBudgetTokens ?? 2048;
  const safetyMarginTokens = input.safetyMarginTokens ?? (contextWindowTokens !== null ? Math.max(512, Math.ceil(contextWindowTokens * 0.02)) : 512);
  const toolReserveTokens = 0;
  const framingReserveTokens = 512;
  const harnessReserveTokens = safetyMarginTokens + toolReserveTokens + framingReserveTokens;
  const totalReserveTokens = outputReserveTokens + safetyMarginTokens + toolReserveTokens + framingReserveTokens;

  const usableInputTokens = contextWindowTokens !== null ? Math.max(1, contextWindowTokens - totalReserveTokens) : null;
  const presetBudget = input.presetContextBudgetBytes !== undefined
    ? Math.max(1, Math.floor(input.presetContextBudgetBytes / 4))
    : (usableInputTokens ?? null);
  const compactionTargetTokens = usableInputTokens !== null
    ? (presetBudget !== null ? Math.max(1, Math.min(presetBudget, usableInputTokens)) : usableInputTokens)
    : presetBudget;
  const compactionThresholdRatio = input.compactionThresholdRatio ?? 0.8;
  if (!(compactionThresholdRatio > 0 && compactionThresholdRatio <= 1)) {
    throw new Error("Compaction threshold ratio must be in (0, 1]");
  }
  const currentModelVisibleTokens = input.currentModelVisibleTokens ?? null;
  const remainingInputTokens = currentModelVisibleTokens === null || usableInputTokens === null
    ? null
    : Math.max(0, usableInputTokens - currentModelVisibleTokens);
  const compactionThresholdTokens = usableInputTokens !== null
    ? Math.max(1, Math.floor(usableInputTokens * compactionThresholdRatio))
    : null;

  return {
    providerId: input.providerId,
    selectedModelId: input.selectedModel,
    canonicalModelId: metadata.canonicalId,
    displayName: metadata.label,
    capabilities: { ...metadata.capabilities },
    reasoning: resolveReasoningCapability(input.providerId, input.selectedModel),
    protocol: input.endpoint.protocol,
    endpointKind: input.endpoint.kind,
    endpointHost: input.endpoint.host,
    contextWindowTokens,
    nativeContextWindowTokens: effective.advertisedModelCapacityTokens,
    nativeContextWindowSource: effective.advertisedModelCapacitySource,
    routeLimitTokens: effective.configuredEndpointLimitTokens,
    routeLimitSource: effective.endpointLimitSource,
    effectiveContextWindowTokens: contextWindowTokens,
    contextWindowSource,
    contextWindowConfidence,
    endpointLimitTokens: effective.configuredEndpointLimitTokens,
    endpointLimitSource: effective.endpointLimitSource,
    outputReserveTokens,
    safetyMarginTokens,
    toolReserveTokens,
    framingReserveTokens,
    harnessReserveTokens,
    totalReserveTokens,
    usableInputTokens,
    compactionTargetTokens,
    currentModelVisibleTokens,
    remainingInputTokens,
    compactionThresholdTokens,
    compactionThresholdRatio,
    routeFallbackIdentity: effective.routeFallbackIdentity,
  };
}

/** Attach the measured model-visible request total without re-resolving the
 * route. This keeps native capacity, route limits, and their provenance
 * stable while the exact envelope measurement supplies current pressure. */
export function withCurrentModelVisibleTokens(
  budget: ModelBudget,
  currentModelVisibleTokens: number | null,
  compactionThresholdRatio = budget.compactionThresholdRatio,
): ModelBudget {
  if (!(compactionThresholdRatio > 0 && compactionThresholdRatio <= 1)) {
    throw new Error("Compaction threshold ratio must be in (0, 1]");
  }
  return {
    ...budget,
    currentModelVisibleTokens,
    remainingInputTokens: currentModelVisibleTokens === null || budget.usableInputTokens === null
      ? null
      : Math.max(0, budget.usableInputTokens - currentModelVisibleTokens),
    compactionThresholdRatio,
    compactionThresholdTokens: budget.usableInputTokens !== null
      ? Math.floor(budget.usableInputTokens * compactionThresholdRatio)
      : null,
  };
}
