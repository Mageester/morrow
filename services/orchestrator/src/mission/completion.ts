import { routePreset } from "../routing/router.js";
import { createProvider } from "../provider/registry.js";
import { openStreamWithFallback, type FallbackCandidate } from "../provider/fallback.js";
import { DEFAULT_PRESET_ID, isPresetId } from "../routing/presets.js";
import { listModelsForProvider } from "../routing/models.js";
import type { MissionCompletionFn } from "./service.js";

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
    const candidates: FallbackCandidate[] = [{ id: primary.providerId, provider }];
    const opened = await openStreamWithFallback(candidates, messages, {
      temperature: o.temperature ?? 0.1,
      maxOutputTokens: 2000,
      model,
    });
    let text = "";
    for await (const chunk of opened.stream) {
      if (chunk.type === "text" && chunk.text) text += chunk.text;
    }
    return { text, provider: primary.providerId, model };
  };
}
