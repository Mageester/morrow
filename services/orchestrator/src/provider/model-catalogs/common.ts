import type { ModelInfo, ProviderId, ReasoningMode, ReasoningWire, RouteReasoningCapability } from "@morrow/contracts";

export const BUNDLED_MODEL_CATALOG_VERSION = "2026-08-16";
/** Default recording date for entries with no out-of-band verification. */
export const BUNDLED_CATALOG_RELEASED_AT = "2026-07-16T00:00:00.000Z";
type Pricing = NonNullable<ModelInfo["pricing"]>;

export const freeLocal: Pricing = {
  inputUsdPerMillion: 0,
  outputUsdPerMillion: 0,
  cachedInputUsdPerMillion: 0,
  source: "authoritative",
};

export const price = (inputUsdPerMillion: number, outputUsdPerMillion: number, cachedInputUsdPerMillion?: number): Pricing => ({
  inputUsdPerMillion,
  outputUsdPerMillion,
  ...(cachedInputUsdPerMillion === undefined ? {} : { cachedInputUsdPerMillion }),
  source: "authoritative",
});

// Absence of metadata is its own fact, and it is not "the provider disabled
// reasoning". Encoding it as `none` made every route Morrow had not fetched
// metadata for claim reasoning was unsupported, and `translateReasoning`
// refused to apply a depth on that basis — a fresh install with no models.dev
// snapshot silently lost reasoning on every model outside the bundled catalog.
// `unknown` is carried by the same contract and every consumer already handles
// it: pickers fall back to Auto, and the translator returns the actionable
// "has not reported a reasoning capability" reason instead of a dead end.
export const UNKNOWN_REASONING: RouteReasoningCapability = { control: "unknown", efforts: [], budgets: [], source: "unknown" };

/**
 * Declare the reasoning modes one exact model offers.
 *
 * `modes` is the single declaration site: `efforts` is projected from it so a
 * catalog entry can never drift into offering an id it has no label or wire
 * spelling for. Every field a provider needs to reach its own wire format
 * lives on the mode, which is what keeps `translateReasoning` free of
 * per-model branching — it reads `wireValue`, never a model name.
 */
export function reasoning(input: {
  modes: readonly ReasoningMode[];
  wire?: ReasoningWire;
  supportsOff?: boolean;
  source?: RouteReasoningCapability["source"];
}): RouteReasoningCapability {
  const modes = input.modes.map((mode) => ({ ...mode }));
  return {
    control: "effort",
    efforts: modes.map((mode) => mode.id),
    modes,
    budgets: [],
    source: input.source ?? "provider-catalog",
    ...(input.supportsOff === undefined ? {} : { supportsOff: input.supportsOff }),
    ...(input.wire === undefined ? {} : { wire: input.wire }),
  };
}

const TITLE: Record<string, string> = {
  minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "xHigh", max: "Max",
};

/** Modes for a provider whose selector ids are sent verbatim on the wire. */
export function effortModes(levels: readonly string[]): ReasoningMode[] {
  return levels.map((id) => ({ id, label: TITLE[id] ?? id }));
}

/** OpenAI-family effort scalar: the selector id is the wire value. */
export function effort(levels: string[] = ["low", "medium", "high"]): RouteReasoningCapability {
  return reasoning({ modes: effortModes(levels), wire: "openai-reasoning-effort", source: "registry" });
}

/**
 * DeepSeek exposes four selectable depths over a wire field that accepts only
 * `high` and `max`, so the coarser spelling is declared per mode here rather
 * than recomputed from the id at translation time.
 */
export function deepSeekReasoning(): RouteReasoningCapability {
  return reasoning({
    modes: [
      { id: "low", label: "Low", wireValue: "high" },
      { id: "high", label: "High", wireValue: "high" },
      { id: "xhigh", label: "xHigh", wireValue: "max" },
      { id: "max", label: "Max", wireValue: "max" },
    ],
    wire: "deepseek-thinking",
    supportsOff: true,
    source: "provider-metadata",
  });
}

/**
 * Gemini selects thinking depth with `thinkingConfig.thinkingLevel`, and the
 * accepted set differs per model: `gemini-3.7-flash` rejects MINIMAL that its
 * 3.5 and 3.1-lite siblings accept (verified against the live v1beta API,
 * 2026-08-16). Each entry therefore declares its own level list.
 */
export function geminiThinking(levels: readonly string[]): RouteReasoningCapability {
  return reasoning({
    modes: effortModes(levels),
    wire: "gemini-thinking-level",
    source: "provider-catalog",
  });
}

export function fixedReasoning(): RouteReasoningCapability {
  return { control: "fixed", efforts: [], budgets: [], source: "registry" };
}

export function noReasoning(): RouteReasoningCapability {
  return { control: "none", efforts: [], budgets: [], source: "registry" };
}

/**
 * The model reasons, but which selectable depths it accepts has not been
 * verified on a live route.
 *
 * Distinct from {@link noReasoning}, which asserts the model has no reasoning
 * control at all. Claiming "none" for an unverified reasoning model would hide
 * a real control; claiming a level list would invent one. Unknown keeps the
 * picker on Auto and lets the provider's own default stand.
 */
export function unverifiedReasoning(): RouteReasoningCapability {
  return { control: "unknown", efforts: [], budgets: [], source: "unknown" };
}

/**
 * Whether a bundled entry's reasoning declaration is a Morrow-verified
 * compatibility correction rather than generic seed metadata.
 *
 * The bundled catalog declares a reasoning control ONLY where Morrow verified
 * one against the live provider, and it is the only source that knows Morrow's
 * wire dialect for it — a comprehensive external database describes models, not
 * one harness's translation layer. Those declarations therefore outrank
 * external metadata, while every other bundled fact stays seed data the
 * external catalog is free to supersede.
 *
 * `noReasoning()` is the default every entry gets for saying nothing, so it is
 * deliberately NOT a correction: silence must not outrank a database that
 * actually knows.
 */
export function isVerifiedReasoningDeclaration(model: ModelInfo): boolean {
  const reasoning = model.reasoning;
  return reasoning !== undefined
    && reasoning.source !== "unknown"
    && reasoning.control !== "unknown"
    && reasoning.control !== "none";
}

export function model(
  providerId: ProviderId,
  id: string,
  label: string,
  opts: {
    aliases?: string[];
    canonicalTarget?: { providerId: ProviderId; modelId: string };
    contextWindow?: number | null;
    maxOutputTokens?: number | null;
    pricing?: Pricing | null;
    tokenUsage?: boolean;
    streamingUsage?: boolean;
    streaming?: boolean;
    toolCalls?: boolean;
    vision?: boolean;
    speed?: ModelInfo["speedClass"];
    cost?: ModelInfo["costClass"];
    privacy?: ModelInfo["privacy"];
    reasoning?: RouteReasoningCapability;
    family?: string | null;
    generation?: string | null;
    lifecycle?: ModelInfo["lifecycle"];
    metadataSource?: ModelInfo["metadataSource"];
    confidence?: ModelInfo["confidence"];
    /** When this entry's facts were last checked against the live provider.
     * Defaults to the catalog release date; entries verified out of band carry
     * their own, so freshness reported downstream is the real one. */
    verifiedAt?: string;
  } = {},
): ModelInfo {
  return {
    version: 1,
    id,
    providerModelId: id,
    canonicalId: id,
    ...(opts.canonicalTarget ? { canonicalTarget: opts.canonicalTarget } : {}),
    aliases: opts.aliases ?? [],
    providerId,
    label,
    family: opts.family ?? null,
    generation: opts.generation ?? null,
    lifecycle: opts.lifecycle ?? "current",
    contextWindow: opts.contextWindow ?? null,
    maxOutputTokens: opts.maxOutputTokens ?? null,
    pricing: opts.pricing ?? null,
    tokenUsage: opts.tokenUsage ?? true,
    streamingUsage: opts.streamingUsage ?? true,
    capabilities: {
      streaming: opts.streaming ?? true,
      toolCalls: opts.toolCalls ?? true,
      vision: opts.vision ?? false,
    },
    speedClass: opts.speed ?? "unknown",
    costClass: opts.cost ?? "unknown",
    privacy: opts.privacy ?? "remote",
    builtIn: true,
    capabilitySource: opts.metadataSource === "remote-catalog" ? "remote-catalog" : "bundled-catalog",
    metadataSource: opts.metadataSource ?? "bundled-catalog",
    metadataVersion: BUNDLED_MODEL_CATALOG_VERSION,
    fetchedAt: opts.verifiedAt ?? BUNDLED_CATALOG_RELEASED_AT,
    confidence: opts.confidence ?? "verified",
    reasoning: opts.reasoning ?? noReasoning(),
  };
}
