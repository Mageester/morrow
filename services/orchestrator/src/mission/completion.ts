import { routePreset } from "../routing/router.js";
import { createProvider } from "../provider/registry.js";
import { openStreamWithFallback, type FallbackCandidate } from "../provider/fallback.js";
import { DEFAULT_PRESET_ID, isPresetId } from "../routing/presets.js";
import { listModelsForProvider } from "../routing/models.js";
import type { MissionCompletionFn } from "./service.js";
import { admitProviderRequest } from "../execution/context-budget.js";
import { resolveModelBudget } from "../routing/model-budget.js";

/**
 * Build a provider-independent completion function for mission planning and
 * review from the existing routing + provider abstraction. Returns undefined
 * when no provider is configured, so the mission gracefully falls back to
 * heuristic criteria and an `insufficient_evidence` review rather than crashing.
 *
 * Provider independence: the concrete provider is resolved through `routePreset`
 * exactly like normal agent execution, so OpenAI/Anthropic/DeepSeek/Gemini/
 * OpenRouter/local all work unchanged. For review it prefers a DIFFERENT model
 * on the resolved provider when one exists, strengthening independence; it is a
 * separate execution with isolated instructions in every case.
 */
export function buildMissionCompletion(opts: { presetId?: string; env?: NodeJS.ProcessEnv } = {}): MissionCompletionFn | undefined {
  const env = opts.env ?? process.env;
  const presetId = opts.presetId && isPresetId(opts.presetId) ? opts.presetId : DEFAULT_PRESET_ID;
  const route = routePreset(presetId, env);
  if (!route.ok) return undefined;
  const primary = route.decision;

  return async (messages, o) => {
    let model = primary.model;
    if (o.purpose === "review") {
      const others = listModelsForProvider(primary.providerId).map((m) => m.id).filter((id) => id !== primary.model);
      if (others.length > 0) model = others[0]!;
    }
    const provider = createProvider(primary.providerId, env, model);
    const providerRoute = provider.route;
    if (!providerRoute) throw new Error("Provider route metadata is unavailable; refusing an unverified mission completion request.");
    const budget = resolveModelBudget({
      providerId: primary.providerId,
      selectedModel: model,
      endpoint: { kind: providerRoute.endpointKind, host: providerRoute.endpointHost, protocol: providerRoute.protocol, limitTokens: providerRoute.endpointLimitTokens, limitSource: providerRoute.endpointLimitSource },
      outputBudgetTokens: 2_000,
    });
    const admission = admitProviderRequest({ providerId: primary.providerId, model, protocol: providerRoute.protocol, messages, tools: [], outputReserveTokens: 2_000 }, budget);
    if (!admission.ok) throw new Error(`Mission completion request requires ${admission.measurement.totalRequestTokens} tokens but the usable input budget is ${budget.usableInputTokens}; no provider call was made.`);
    const candidates: FallbackCandidate[] = [{ id: primary.providerId, provider }];
    const opened = await openStreamWithFallback(candidates, messages, {
      temperature: o.temperature ?? 0.1,
      maxOutputTokens: 2000,
      model,
      ...(o.purpose === "review" ? { responseFormat: "json_object" } : {}),
    });
    let text = "";
    for await (const chunk of opened.stream) {
      if (chunk.type === "text" && chunk.text) text += chunk.text;
    }
    return { text, provider: primary.providerId, model };
  };
}
