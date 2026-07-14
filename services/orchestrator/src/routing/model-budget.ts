import type { ContextLimitSource, ProviderProtocol } from "../provider/base.js";
import { resolveModelMetadata } from "./models.js";
import {
  resolveEffectiveContext,
  type EffectiveContextEndpointInput,
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

  protocol: ProviderProtocol;
  endpointKind: EffectiveContextEndpointInput["kind"];
  endpointHost: string | null;

  /** The verified-or-configured ceiling for this exact route (smallest of
   * advertised model capacity and any configured endpoint override), before
   * any reserve is subtracted. */
  contextWindowTokens: number;
  contextWindowSource: ContextLimitSource;
  /** "verified" when sourced from built-in model metadata or an endpoint's
   * verified limit; "configured" when a user supplied an override or
   * endpoint value we cannot independently verify; "unverified" when no
   * source exists and the internal safe fallback was used. */
  contextWindowConfidence: "verified" | "configured" | "unverified";

  endpointLimitTokens: number | null;
  endpointLimitSource: ContextLimitSource;

  outputReserveTokens: number;
  safetyMarginTokens: number;
  toolReserveTokens: number;
  framingReserveTokens: number;
  totalReserveTokens: number;

  /** contextWindowTokens - totalReserveTokens: the real provider-capacity
   * ceiling. This is THE number every consumer must use to decide whether a
   * complete wire request will be accepted — durable-checkpoint compaction,
   * live-fallback admission, and mission-completion requests all gate on
   * this, independent of any local preset/dev budget. */
  usableInputTokens: number;
  /** usableInputTokens, additionally capped by a local preset/dev context
   * budget (bytes) when one is configured. This is a *soft* efficiency
   * target for the first-pass deterministic history trim, never a provider
   * constraint — it must never be used to reject a request outright. */
  compactionTargetTokens: number;
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
}): ModelBudget {
  const metadata = resolveModelMetadata(input.providerId, input.selectedModel);
  // outputReserveTokens is 1 here (the minimum resolveEffectiveContext accepts):
  // this call only borrows its endpoint/model-capacity merge logic. The real,
  // complete reserve (output + safety margin + tools + framing) is computed
  // once below and is the only reserve figure any consumer of ModelBudget sees.
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
      : contextWindowSource === "fallback"
        ? "unverified"
        : contextWindowSource === "unknown"
          ? "unverified"
          : "verified";

  const outputReserveTokens = input.outputBudgetTokens ?? 2048;
  const safetyMarginTokens = input.safetyMarginTokens ?? Math.max(512, Math.ceil(contextWindowTokens * 0.02));
  const toolReserveTokens = (input.toolCount ?? 0) * 256;
  const framingReserveTokens = 512;
  const totalReserveTokens = outputReserveTokens + safetyMarginTokens + toolReserveTokens + framingReserveTokens;

  const usableInputTokens = Math.max(1, contextWindowTokens - totalReserveTokens);
  const presetBudget = input.presetContextBudgetBytes !== undefined
    ? Math.max(1, Math.floor(input.presetContextBudgetBytes / 4))
    : usableInputTokens;
  const compactionTargetTokens = Math.max(1, Math.min(presetBudget, usableInputTokens));

  return {
    providerId: input.providerId,
    selectedModelId: input.selectedModel,
    canonicalModelId: metadata.canonicalId,
    displayName: metadata.label,
    capabilities: { ...metadata.capabilities },
    protocol: input.endpoint.protocol,
    endpointKind: input.endpoint.kind,
    endpointHost: input.endpoint.host,
    contextWindowTokens,
    contextWindowSource,
    contextWindowConfidence,
    endpointLimitTokens: effective.configuredEndpointLimitTokens,
    endpointLimitSource: effective.endpointLimitSource,
    outputReserveTokens,
    safetyMarginTokens,
    toolReserveTokens,
    framingReserveTokens,
    totalReserveTokens,
    usableInputTokens,
    compactionTargetTokens,
  };
}
