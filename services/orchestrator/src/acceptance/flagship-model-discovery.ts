import type { DiscoveredModel, ProviderId } from "@morrow/contracts";

/**
 * Choosing which model a flagship canary runs against.
 *
 * Some routes have a dependable default model; a gateway does not. Its
 * available ids vary per account, so `getProviderDefaultModel` returns nothing
 * and the live suite skipped those providers entirely — which is why OpenCode
 * Zen, one of the two declared gate providers, has never contributed a single
 * run to the evidence log.
 *
 * Selection is separated from the network call on purpose. Everything that
 * decides *which* model is a pure function over a discovered catalogue, so it
 * is covered by ordinary tests; the only part needing credentials is fetching
 * that catalogue.
 */

/** Why a candidate was rejected, kept so a failed selection can explain itself
 * instead of reporting an unhelpful "no model found". */
export interface RejectedCandidate {
  providerModelId: string;
  reason: string;
}

export type FlagshipModelSelection =
  | { ok: true; providerModelId: string; contextWindow: number | null; costType: DiscoveredModel["costType"]; reason: string }
  | { ok: false; reason: string; rejected: RejectedCandidate[] };

/** Free first, then unknown cost, then paid. The gate is meant to be runnable
 * without spending money; a paid route is a deliberate fallback, not a default. */
const COST_RANK: Record<NonNullable<DiscoveredModel["costType"]>, number> = { free: 0, unknown: 1, paid: 2 };

/**
 * Ids that cannot build an application regardless of what the catalogue says
 * about them. Matched as substrings against a lowercased id.
 *
 * This is a capability filter, not a quality opinion: an embedding or
 * transcription endpoint accepts a chat request shape and then fails in a way
 * that would be recorded as a model failure, contaminating the very evidence
 * the gate exists to produce.
 */
const NON_AGENTIC_ID_MARKERS = [
  "embed", "embedding", "rerank", "moderation", "whisper", "tts", "audio",
  "transcribe", "speech", "image", "vision-only", "dall-e", "stable-diffusion",
  "guard", "safety",
];

export function isNonAgenticModelId(providerModelId: string): boolean {
  const id = providerModelId.toLowerCase();
  return NON_AGENTIC_ID_MARKERS.some((marker) => id.includes(marker));
}

/**
 * Pick the model a flagship canary should use, from what the account can
 * actually reach.
 *
 * The workflow requires tool calls — it builds and runs an app — so a model
 * that reports `toolCalls: false` is excluded outright. A `null` capability is
 * *unknown*, not false: many endpoints simply do not report it, and excluding
 * those would empty most catalogues. An unknown is admitted and the run itself
 * becomes the evidence.
 */
export function selectFlagshipModel(models: readonly DiscoveredModel[]): FlagshipModelSelection {
  const rejected: RejectedCandidate[] = [];
  const eligible: DiscoveredModel[] = [];

  for (const model of models) {
    if (model.availability === "unavailable") {
      rejected.push({ providerModelId: model.providerModelId, reason: "provider reports it as unavailable" });
      continue;
    }
    if (model.capabilities.toolCalls === false) {
      rejected.push({ providerModelId: model.providerModelId, reason: "does not support tool calls" });
      continue;
    }
    if (isNonAgenticModelId(model.providerModelId)) {
      rejected.push({ providerModelId: model.providerModelId, reason: "not an agentic chat model" });
      continue;
    }
    eligible.push(model);
  }

  if (eligible.length === 0) {
    return {
      ok: false,
      reason: models.length === 0
        ? "the provider returned no models"
        : `none of the ${models.length} discovered model(s) can carry a flagship run`,
      rejected,
    };
  }

  // Cheapest class first; within a class, the largest verified window, because
  // a build task's failure mode is running out of context. `providerModelId`
  // breaks ties so the same catalogue always yields the same choice — a gate
  // whose model silently varies between runs is not measuring one thing.
  const [best] = [...eligible].sort((a, b) => {
    const cost = COST_RANK[a.costType ?? "unknown"] - COST_RANK[b.costType ?? "unknown"];
    if (cost !== 0) return cost;
    const window = (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
    if (window !== 0) return window;
    return a.providerModelId.localeCompare(b.providerModelId);
  });

  return {
    ok: true,
    providerModelId: best!.providerModelId,
    contextWindow: best!.contextWindow,
    costType: best!.costType,
    reason: `${best!.costType ?? "unknown"}-cost, ${best!.contextWindow === null ? "unreported" : `${best!.contextWindow}-token`} window, chosen from ${eligible.length} eligible of ${models.length} discovered`,
  };
}

export interface ResolvedFlagshipModel {
  providerId: ProviderId;
  model: string;
  /** How this id was arrived at, for the run log and console output. */
  source: "configured-default" | "live-discovery";
  detail: string;
}

/**
 * Resolve the model for one provider: its configured default when it has a
 * dependable one, otherwise whatever live discovery can find.
 *
 * `discover` is injected so this is testable without a network. It receives
 * only a provider id — no credential passes through this module, and nothing
 * here logs one.
 */
export async function resolveFlagshipModel(input: {
  providerId: ProviderId;
  configuredDefault: string | null;
  requiresLiveModelDiscovery: boolean;
  discover: (providerId: ProviderId) => Promise<{ ok: boolean; detail: string; models: readonly DiscoveredModel[] }>;
}): Promise<{ ok: true; resolved: ResolvedFlagshipModel } | { ok: false; reason: string }> {
  if (!input.requiresLiveModelDiscovery && input.configuredDefault) {
    return {
      ok: true,
      resolved: {
        providerId: input.providerId,
        model: input.configuredDefault,
        source: "configured-default",
        detail: "provider exposes a dependable default model",
      },
    };
  }

  const discovery = await input.discover(input.providerId);
  if (!discovery.ok) {
    // An explicitly configured id is still worth trying when discovery is down
    // — the endpoint being unlistable does not mean it is unusable.
    if (input.configuredDefault) {
      return {
        ok: true,
        resolved: {
          providerId: input.providerId,
          model: input.configuredDefault,
          source: "configured-default",
          detail: `live discovery unavailable (${discovery.detail}); using the configured model`,
        },
      };
    }
    return { ok: false, reason: `live model discovery failed: ${discovery.detail}` };
  }

  const selection = selectFlagshipModel(discovery.models);
  if (!selection.ok) {
    return { ok: false, reason: selection.reason };
  }
  return {
    ok: true,
    resolved: {
      providerId: input.providerId,
      model: selection.providerModelId,
      source: "live-discovery",
      detail: selection.reason,
    },
  };
}
