import { routePreset } from "../routing/router.js";
import { createProvider } from "../provider/registry.js";
import { openStreamWithFallback, type FallbackCandidate } from "../provider/fallback.js";
import { DEFAULT_PRESET_ID, isPresetId } from "../routing/presets.js";
import { listModelsForProvider } from "../routing/models.js";
import type { MissionCompletionFn } from "./service.js";
import { admitProviderRequest } from "../execution/context-budget.js";
import { resolveModelBudget } from "../routing/model-budget.js";
import type { ChatMessage } from "../provider/base.js";

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

  // A reasoning-capable model can spend most or all of a small output budget
  // on its own hidden chain-of-thought before ever writing the requested
  // answer, leaving nothing for the actual review JSON (observed directly
  // against a real provider: finish_reason "length" with empty content).
  // Review therefore gets a materially larger reserve than planning; both
  // remain a small fraction of the 32k safe-fallback ceiling, so this cannot
  // starve the input budget for any realistic mission context.
  const OUTPUT_BUDGET_TOKENS = { planning: 2_000, review: 6_000 } as const;

  const runOnce = async (
    messages: ChatMessage[],
    o: {
      purpose: "planning" | "review";
      temperature?: number;
      missionProviderId?: string | null;
      missionModel?: string | null;
      missionPreset?: string;
    },
    outputBudgetTokens: number,
    options: { forcePrimaryModel?: boolean } = {},
  ): Promise<{ text: string; provider: string; model: string; finishReason: string | null }> => {
    let resolvedProviderId = primary.providerId;
    let resolvedModel = primary.model;

    if (o.missionProviderId) {
      resolvedProviderId = o.missionProviderId;
      if (o.missionModel) resolvedModel = o.missionModel;
    } else if (o.missionPreset && o.missionPreset !== presetId) {
      const missionRoute = routePreset(o.missionPreset, env);
      if (missionRoute.ok) {
        resolvedProviderId = missionRoute.decision.providerId;
        resolvedModel = missionRoute.decision.model;
      }
    }

    let model = resolvedModel;
    if (o.purpose === "review" && !options.forcePrimaryModel) {
      const others = listModelsForProvider(resolvedProviderId).map((m) => m.id).filter((id) => id !== resolvedModel);
      if (others.length > 0) model = others[0]!;
    }
    const provider = createProvider(resolvedProviderId, env, model);
    const providerRoute = provider.route;
    if (!providerRoute) throw new Error("Provider route metadata is unavailable; refusing an unverified mission completion request.");
    const budget = resolveModelBudget({
      providerId: resolvedProviderId,
      selectedModel: model,
      endpoint: { kind: providerRoute.endpointKind, host: providerRoute.endpointHost, protocol: providerRoute.protocol, limitTokens: providerRoute.endpointLimitTokens, limitSource: providerRoute.endpointLimitSource },
      outputBudgetTokens,
    });
    const admission = admitProviderRequest({ providerId: resolvedProviderId, model, protocol: providerRoute.protocol, messages, tools: [], outputReserveTokens: outputBudgetTokens }, budget);
    if (!admission.ok) throw new Error(`Mission completion request requires ${admission.measurement.totalRequestTokens} tokens but the usable input budget is ${budget.usableInputTokens}; no provider call was made.`);
    const candidates: FallbackCandidate[] = [{ id: resolvedProviderId, provider }];
    const opened = await openStreamWithFallback(candidates, messages, {
      temperature: o.temperature ?? 0.1,
      maxOutputTokens: outputBudgetTokens,
      model,
      ...(o.purpose === "review" ? { responseFormat: "json_object" } : {}),
    });
    let text = "";
    let finishReason: string | null = null;
    for await (const chunk of opened.stream) {
      if (chunk.type === "text" && chunk.text) text += chunk.text;
      if (chunk.type === "done" && chunk.finishReason) finishReason = chunk.finishReason;
    }
    return { text, provider: resolvedProviderId, model, finishReason };
  };

  return async (messages, o) => {
    const baseBudget = OUTPUT_BUDGET_TOKENS[o.purpose];
    let first;
    try {
      first = await runOnce(messages, o, baseBudget);
    } catch (err) {
      // The independent-review model is `routing`'s first non-primary catalog
      // entry for this provider — a real one, but not necessarily one this
      // account can actually reach (e.g. gated on the current plan). When it
      // fails, retry on the model already proven to work rather than losing
      // review entirely. Purpose stays "review": switching it to "planning"
      // silently drops `responseFormat: "json_object"`, which is what makes
      // the provider return a parseable verdict in the first place, turning a
      // recovered review into an unparseable one.
      if (o.purpose === "review") {
        first = await runOnce(messages, o, baseBudget, { forcePrimaryModel: true });
      } else {
        throw err;
      }
    }
    // Bounded, deterministic escalation: exactly one retry, only for review,
    // only when the response was genuinely truncated with nothing usable —
    // never a general "just try again" retry storm.
    if (o.purpose === "review" && first.finishReason === "length" && !first.text.trim()) {
      const retried = await runOnce(messages, o, baseBudget * 2);
      return { ...retried };
    }
    return first;
  };
}
