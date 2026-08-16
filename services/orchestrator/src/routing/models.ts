import type { ModelInfo, ModelStatus, ProviderId, ProviderStatus, RouteReasoningCapability, ModelRequestCapabilities } from "@morrow/contracts";
import type { ProviderModelDiscovery } from "../repositories/provider-model-discovery.js";
import type { ProviderProtocol } from "../provider/base.js";
import { BUILT_IN_MODELS, BUNDLED_MODEL_CATALOG_VERSION, UNKNOWN_REASONING } from "../provider/model-catalogs/index.js";
import {
  mergeRequestCapabilities,
  protocolRequestCapabilities,
  UNKNOWN_REQUEST_CAPABILITIES,
} from "./request-capabilities.js";

export interface CanonicalModelTarget {
  providerId: ProviderId;
  modelId: string;
}

export type BundledModelInfo = ModelInfo;

export { BUILT_IN_MODELS, BUNDLED_MODEL_CATALOG_VERSION, UNKNOWN_REASONING };

let activeCatalogModels: ModelInfo[] = BUILT_IN_MODELS;

function catalogKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function hasCompleteIndependentMetadata(model: ModelInfo): boolean {
  return model.providerModelId !== undefined
    && model.contextWindow !== undefined
    && model.maxOutputTokens !== undefined
    && model.pricing !== undefined
    && model.capabilities !== undefined;
}

/**
 * Validate the canonical identity graph before it becomes an active catalog.
 * Targets are intentionally exact ids within the declaring provider. Alias
 * matching is only for user selections; it cannot make a malformed target
 * valid or silently cross provider boundaries.
 */
export function validateCanonicalModelCatalog(models: readonly ModelInfo[]): void {
  const exact = new Map<string, ModelInfo>();
  const selections = new Map<string, string>();

  for (const model of models) {
    const exactKey = catalogKey(model.providerId, model.id);
    if (exact.has(exactKey)) {
      throw new Error(`Duplicate model id for provider ${model.providerId}: ${model.id}`);
    }
    exact.set(exactKey, model);

    for (const selectionId of [model.id, ...model.aliases]) {
      const selectionKey = catalogKey(model.providerId, selectionId);
      const previous = selections.get(selectionKey);
      if (previous !== undefined && previous !== model.id) {
        throw new Error(`Ambiguous model alias for provider ${model.providerId}: ${selectionId}`);
      }
      selections.set(selectionKey, model.id);
    }

    const target = model.canonicalTarget;
    if (!target && !hasCompleteIndependentMetadata(model)) {
      throw new Error(`Model ${model.providerId}/${model.id} has incomplete independent metadata`);
    }
    if (target && target.providerId !== model.providerId) {
      throw new Error(`Canonical target for ${model.providerId}/${model.id} crosses provider to ${target.providerId}/${target.modelId}`);
    }
  }

  for (const model of models) {
    const target = model.canonicalTarget;
    if (target && !exact.has(catalogKey(target.providerId, target.modelId))) {
      throw new Error(`Canonical target for ${model.providerId}/${model.id} is missing: ${target.providerId}/${target.modelId}`);
    }

    const seen = new Set<string>();
    let current: ModelInfo = model;
    while (current.canonicalTarget) {
      const currentKey = catalogKey(current.providerId, current.id);
      if (seen.has(currentKey)) {
        throw new Error(`Canonical target cycle detected at ${current.providerId}/${current.id}`);
      }
      seen.add(currentKey);
      const next = exact.get(catalogKey(current.canonicalTarget.providerId, current.canonicalTarget.modelId));
      if (!next) {
        throw new Error(`Canonical target for ${current.providerId}/${current.id} is missing: ${current.canonicalTarget.providerId}/${current.canonicalTarget.modelId}`);
      }
      current = next;
    }
  }
}

validateCanonicalModelCatalog(BUILT_IN_MODELS);

export function installModelCatalog(models: ModelInfo[]): void {
  const normalizedModels = models.map((model) => model.reasoning
    ? model
    : { ...model, reasoning: UNKNOWN_REASONING });
  validateCanonicalModelCatalog(normalizedModels);
  const seen = new Set<string>();
  activeCatalogModels = normalizedModels.filter((model) => {
    const key = catalogKey(model.providerId, model.canonicalId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Remote catalog rows override same-route bundled seed rows. Seed rows remain
 * available for offline startup and for provider routes that catalog does not
 * cover, but never replace verified remote metadata.
 */
export function mergeModelCatalog(seed: ModelInfo[], remote: ModelInfo[]): ModelInfo[] {
  const merged = new Map<string, ModelInfo>();
  for (const model of seed) merged.set(catalogKey(model.providerId, model.canonicalId), model);
  for (const model of remote) {
    const key = catalogKey(model.providerId, model.canonicalId);
    const bundled = merged.get(key);
    if (!bundled) {
      merged.set(key, model);
      continue;
    }

    // Remote catalogues commonly omit pricing and normalized reasoning even
    // when the bundled provider contract knows them. Preserve those facts when
    // the remote row is silent or explicitly marks its reasoning as unknown;
    // remote context/capability metadata still wins when it is present.
    const remoteReasoning = model.reasoning;
    const reasoning = remoteReasoning && remoteReasoning.source !== "unknown"
      ? remoteReasoning
      : bundled.reasoning;
    merged.set(key, {
      ...bundled,
      ...model,
      pricing: model.pricing ?? bundled.pricing,
      contextWindow: model.contextWindow ?? bundled.contextWindow,
      maxOutputTokens: model.maxOutputTokens ?? bundled.maxOutputTokens,
      ...(reasoning ? { reasoning } : {}),
      ...(bundled.requestCapabilities || model.requestCapabilities
        ? { requestCapabilities: mergeRequestCapabilities(bundled.requestCapabilities ?? UNKNOWN_REQUEST_CAPABILITIES, model.requestCapabilities) }
        : {}),
    });
  }
  return [...merged.values()];
}

export function unknownModel(providerId: string, id: string): ModelInfo {
  return {
    version: 1,
    id,
    providerModelId: id,
    canonicalId: id,
    aliases: [],
    providerId: providerId as ProviderId,
    label: id,
    family: null,
    generation: null,
    lifecycle: "unknown",
    contextWindow: null,
    maxOutputTokens: null,
    pricing: null,
    tokenUsage: false,
    streamingUsage: false,
    capabilities: { streaming: false, toolCalls: false, vision: false },
    capabilitySource: "unknown",
    speedClass: "unknown",
    costClass: "unknown",
    privacy: providerId === "ollama" ? "local" : "remote",
    builtIn: false,
    metadataSource: "unknown",
    metadataVersion: BUNDLED_MODEL_CATALOG_VERSION,
    fetchedAt: null,
    confidence: "unknown",
    // A model the registry has never heard of: its reasoning surface is
    // genuinely unknown, never assumed to match a family default.
    reasoning: UNKNOWN_REASONING,
  };
}

export function listModels(): ModelInfo[] {
  return activeCatalogModels;
}

function resolveSelectedDeclaration(providerId: string, selectedId: string): { model: ModelInfo; selectedId: string } | undefined {
  const exact = activeCatalogModels.find((model) => model.providerId === providerId && model.id === selectedId);
  if (exact) return { model: exact, selectedId };
  const alias = activeCatalogModels.find((model) => model.providerId === providerId && model.aliases.includes(selectedId));
  if (alias) return { model: alias, selectedId };

  // Model ids are case-insensitive identities but case-sensitive payloads. A
  // user who types DEEPSEEK-V4-FLASH-FREE means the same model as the catalog's
  // lowercase entry, and must get its context window, pricing, and reasoning
  // contract — otherwise the route silently falls back to the conservative
  // 32k ceiling and compacts constantly. The caller still sends the id exactly
  // as supplied; only metadata lookup is case-insensitive.
  const folded = selectedId.toLowerCase();
  const insensitive = activeCatalogModels.find((model) =>
    model.providerId === providerId
    && (model.id.toLowerCase() === folded || model.aliases.some((entry) => entry.toLowerCase() === folded)));
  return insensitive ? { model: insensitive, selectedId } : undefined;
}

function resolveCanonicalDeclaration(model: ModelInfo): ModelInfo {
  let current = model;
  const seen = new Set<string>();
  while (current.canonicalTarget) {
    const key = catalogKey(current.providerId, current.id);
    if (seen.has(key)) throw new Error(`Canonical target cycle detected at ${current.providerId}/${current.id}`);
    seen.add(key);
    const next = activeCatalogModels.find((candidate) => candidate.providerId === current.canonicalTarget!.providerId && candidate.id === current.canonicalTarget!.modelId);
    if (!next) throw new Error(`Canonical target for ${current.providerId}/${current.id} is missing: ${current.canonicalTarget.providerId}/${current.canonicalTarget.modelId}`);
    current = next;
  }
  return current;
}

export function resolveCanonicalModelMetadata(providerId: string, selectedId: string): { selected: ModelInfo; canonical: ModelInfo } {
  const normalized = selectedId.trim();
  const declaration = resolveSelectedDeclaration(providerId, normalized)?.model;
  if (!declaration) {
    const unknown = unknownModel(providerId, normalized);
    return { selected: unknown, canonical: unknown };
  }

  const canonical = resolveCanonicalDeclaration(declaration);
  const selected = declaration.id === normalized && declaration.canonicalId === canonical.id
    ? declaration
    : { ...declaration, id: normalized, providerModelId: normalized, canonicalId: canonical.id };
  return { selected, canonical };
}

/**
 * The reasoning capability for a route, resolved through the metadata
 * precedence (provider metadata → probe → registry → unknown). Today only the
 * registry and the unknown fallback are populated; higher-priority sources slot
 * in here without any caller change.
 */
export function resolveReasoningCapability(providerId: string, id: string): RouteReasoningCapability {
  return resolveModelMetadata(providerId, id).reasoning ?? UNKNOWN_REASONING;
}

/** Resolve optional request fields for one exact model/protocol route. */
export function resolveModelRequestCapabilities(
  providerId: string,
  id: string,
  protocol: ProviderProtocol,
): ModelRequestCapabilities {
  const metadata = resolveModelMetadata(providerId, id);
  const knownMetadata = metadata.capabilitySource !== "unknown" && metadata.metadataSource !== "unknown";
  const baseline = knownMetadata ? protocolRequestCapabilities(protocol) : UNKNOWN_REQUEST_CAPABILITIES;
  const derived = metadata.capabilities.toolCalls === true
    ? { ...baseline, tools: "supported" as const }
    : metadata.capabilities.toolCalls === false && knownMetadata
      ? { ...baseline, tools: "unsupported" as const }
      : baseline;
  return mergeRequestCapabilities(derived, metadata.requestCapabilities);
}

export function resolveModelMetadata(providerId: string, id: string): ModelInfo {
  const { selected, canonical } = resolveCanonicalModelMetadata(providerId, id);
  if (selected === canonical) return selected;

  return {
    ...canonical,
    id: selected.id,
    providerModelId: selected.providerModelId,
    canonicalId: canonical.id,
    aliases: selected.aliases,
    label: selected.label,
    lifecycle: selected.lifecycle,
    reasoning: selected.reasoning ?? canonical.reasoning,
  };
}

export function getModel(id: string): ModelInfo | undefined {
  return activeCatalogModels.find((m) => m.id === id || m.aliases.includes(id));
}

export function listModelsForProvider(providerId: ProviderId): ModelInfo[] {
  return activeCatalogModels.filter((m) => m.providerId === providerId);
}

/**
 * Synthesized entries for configured "bring your own model" providers (today:
 * openai-compatible) that have zero built-in registry rows because their
 * model space cannot be known in advance. Without this, a correctly
 * configured openai-compatible endpoint never appears in `/api/models` or the
 * `/model` picker — the registry has nothing to return for it at all, unlike
 * providers with real registry entries where "not configured" still lists the
 * model as unavailable. Providers that already have registry entries are
 * untouched; a provider with no configured default model yields nothing.
 */
export function listConfiguredCustomModels(providers: ProviderStatus[]): ModelInfo[] {
  return providers
    .filter((p) => p.configured && p.defaultModel && !listModelsForProvider(p.id).some((model) => model.id === p.defaultModel || model.aliases.includes(p.defaultModel!)))
    .map((p) => unknownModel(p.id, p.defaultModel!));
}

/**
 * Merge the bundled catalog with the current authentication surface's durable
 * provider discovery. Credentials prove configuration only; only a successful
 * provider model-list response proves account availability.
 */
export function resolveModelStatuses(
  providers: ProviderStatus[],
  discoveries: ProviderModelDiscovery[],
): ModelStatus[] {
  const all = [...listModels(), ...listConfiguredCustomModels(providers)];
  const output: ModelStatus[] = [];
  for (const provider of providers) {
    const authMode = provider.authMode ?? "unknown";
    const discovery = discoveries.find((item) => item.providerId === provider.id && item.authMode === authMode);
    const providerModels = all.filter((model) => model.providerId === provider.id);
    const discovered = discovery?.models ?? [];

    for (const item of discovered) {
      const known = providerModels.find((model) => model.id === item.providerModelId || model.aliases.includes(item.providerModelId));
      if (known) continue;
      providerModels.push({
        ...unknownModel(provider.id, item.providerModelId),
        label: item.displayName,
        author: item.author ?? null,
        inputModalities: item.inputModalities ?? [],
        outputModalities: item.outputModalities ?? [],
        pricing: item.pricing ?? null,
        costType: item.costType ?? "unknown",
        contextWindow: item.contextWindow,
        maxOutputTokens: item.maxOutputTokens,
        ...(item.requestCapabilities ? { requestCapabilities: item.requestCapabilities } : {}),
        lifecycle: "custom",
        metadataSource: "provider-reported",
        fetchedAt: discovery?.fetchedAt ?? null,
        confidence: "reported",
      });
    }

    for (const model of providerModels) {
      const report = discovered.find((item) => item.providerModelId === model.id || model.aliases.includes(item.providerModelId));
      const metadata = resolveModelMetadata(model.providerId, model.id);
      const reportedReasoning = report?.reasoning && report.reasoning.source !== "unknown"
        ? report.reasoning
        : metadata.reasoning;
      const resolved = report ? {
        ...metadata,
        providerModelId: report.providerModelId,
        label: report.displayName,
        author: report.author ?? metadata.author ?? null,
        inputModalities: report.inputModalities ?? metadata.inputModalities ?? [],
        outputModalities: report.outputModalities ?? metadata.outputModalities ?? [],
        pricing: report.pricing ?? metadata.pricing,
        costType: report.costType ?? metadata.costType ?? "unknown",
        contextWindow: report.contextWindow ?? metadata.contextWindow,
        maxOutputTokens: report.maxOutputTokens ?? metadata.maxOutputTokens,
        metadataSource: "provider-reported" as const,
        fetchedAt: discovery?.fetchedAt ?? metadata.fetchedAt,
        confidence: report.contextWindow !== null || report.maxOutputTokens !== null ? "reported" as const : metadata.confidence,
        capabilities: {
          streaming: report.capabilities.streaming ?? metadata.capabilities.streaming,
          toolCalls: report.capabilities.toolCalls ?? metadata.capabilities.toolCalls,
          vision: report.capabilities.vision ?? metadata.capabilities.vision,
          reasoning: report.capabilities.reasoning ?? metadata.capabilities.reasoning ?? null,
        },
        ...(metadata.requestCapabilities || report.requestCapabilities
          ? { requestCapabilities: mergeRequestCapabilities(metadata.requestCapabilities ?? UNKNOWN_REQUEST_CAPABILITIES, report.requestCapabilities) }
          : {}),
        ...(reportedReasoning ? { reasoning: reportedReasoning } : {}),
        capabilitySource: Object.values(report.capabilities).some((value) => value !== null)
          ? "provider-reported" as const
          : metadata.capabilitySource,
      } : metadata;
      const availability = !provider.configured
        ? "unavailable" as const
        : discovery?.status === "available" && report
          ? report.availability ?? "available"
          : discovery?.status === "available"
            ? "unavailable" as const
          : discovery?.status === "unavailable"
            ? "unavailable" as const
            : "unknown" as const;
      output.push({
        model: resolved,
        available: availability === "available",
        availability,
        availabilitySource: report ? "provider-reported" : provider.configured ? "unknown" : "configured",
        availabilityReason: availability === "available"
          ? null
          : !provider.configured
            ? "Provider authentication is not configured."
            : discovery?.status === "available"
              ? "The selected model is no longer returned by the provider catalogue."
              : discovery?.status === "unavailable"
              ? `Last provider discovery failed${discovery.errorKind ? ` (${discovery.errorKind})` : ""}.`
              : "Account model availability has not been discovered yet.",
        authMode,
        fetchedAt: discovery?.fetchedAt ?? null,
      });
    }
  }
  return output;
}

export interface UsageForCost {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type UsageCost =
  | { known: true; usd: number; label: string }
  | { known: false; label: "unknown" };

export function calculateUsageCost(usage: UsageForCost, metadata: ModelInfo | undefined | null): UsageCost {
  const pricing = metadata?.pricing;
  if (!pricing || pricing.source !== "authoritative") return { known: false, label: "unknown" };
  const cached = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  const cachedRate = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
  const usd =
    (uncachedInput / 1_000_000) * pricing.inputUsdPerMillion +
    (cached / 1_000_000) * cachedRate +
    (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
  return { known: true, usd, label: `$${usd.toFixed(4)}` };
}
