import type { ModelInfo, ModelStatus, ProviderId, ProviderStatus, RouteReasoningCapability, ModelRequestCapabilities } from "@morrow/contracts";
import type { ProviderModelDiscovery } from "../repositories/provider-model-discovery.js";
import type { ProviderProtocol } from "../provider/base.js";
import { BUILT_IN_MODELS, BUNDLED_MODEL_CATALOG_VERSION, UNKNOWN_REASONING } from "../provider/model-catalogs/index.js";
import { isVerifiedReasoningDeclaration } from "../provider/model-catalogs/common.js";
import {
  mergeRequestCapabilities,
  protocolRequestCapabilities,
  UNKNOWN_REQUEST_CAPABILITIES,
} from "./request-capabilities.js";
import { findDiscoveredModel } from "../provider/registry.js";
import { externalModelDeclaration } from "../provider/external-catalog/index.js";

export interface CanonicalModelTarget {
  providerId: ProviderId;
  modelId: string;
}

export type BundledModelInfo = ModelInfo;

export { BUILT_IN_MODELS, BUNDLED_MODEL_CATALOG_VERSION, UNKNOWN_REASONING };

let activeCatalogModels: ModelInfo[] = BUILT_IN_MODELS;

/**
 * Lookup indexes over the active catalog.
 *
 * A comprehensive external source contributes thousands of rows, and metadata
 * resolution runs on the request path, so identity lookup is a map read rather
 * than a linear scan. The maps are rebuilt whenever the catalog is installed;
 * there is exactly one place that can change what "active" means.
 */
let exactIndex = new Map<string, ModelInfo>();
let aliasIndex = new Map<string, ModelInfo>();
let providerIndex = new Map<string, ModelInfo[]>();

function catalogKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function foldedKey(providerId: string, modelId: string): string {
  return catalogKey(providerId, modelId.toLowerCase());
}

function reindexActiveCatalog(): void {
  exactIndex = new Map();
  aliasIndex = new Map();
  providerIndex = new Map();
  for (const model of activeCatalogModels) {
    exactIndex.set(catalogKey(model.providerId, model.id), model);
    const folded = foldedKey(model.providerId, model.id);
    if (!exactIndex.has(folded)) exactIndex.set(folded, model);
    for (const alias of model.aliases) {
      const key = catalogKey(model.providerId, alias);
      if (!aliasIndex.has(key)) aliasIndex.set(key, model);
      const foldedAlias = foldedKey(model.providerId, alias);
      if (!aliasIndex.has(foldedAlias)) aliasIndex.set(foldedAlias, model);
    }
    const forProvider = providerIndex.get(model.providerId);
    if (forProvider) forProvider.push(model); else providerIndex.set(model.providerId, [model]);
  }
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
reindexActiveCatalog();

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
  reindexActiveCatalog();
}

/**
 * Combine Morrow's bundled seed rows with an external catalog snapshot into the
 * flat compatibility catalog every legacy consumer reads.
 *
 * The per-field policy here MIRRORS the capability layer priorities in
 * `provider/capability-facts.ts` — bundled seed < external catalog < Morrow
 * verified correction — so the flat row and the exact-route resolver cannot
 * disagree about the same model. A conformance test asserts that agreement
 * rather than leaving it to inspection.
 *
 * The recurring rule is: the external row wins a field only where it actually
 * STATES that field. Silence from a database that covers thousands of models
 * is still silence, and must never retract something Morrow already knew.
 */
export function mergeModelCatalog(seed: ModelInfo[], remote: ModelInfo[]): ModelInfo[] {
  const merged = new Map<string, ModelInfo>();
  // Morrow's own alias graph decides identity. models.dev publishes both
  // `claude-haiku-4-5` and Morrow's dated `claude-haiku-4-5-20251001`, and
  // adding the shorter id as a SECOND anthropic model makes that selection
  // ambiguous — which the catalog validator rejects outright, taking startup
  // with it. Resolving the external id through the seed's aliases folds the two
  // into the one model they actually are.
  const aliasTargets = new Map<string, string>();
  for (const model of seed) {
    merged.set(catalogKey(model.providerId, model.canonicalId), model);
    for (const alias of model.aliases) aliasTargets.set(catalogKey(model.providerId, alias), model.canonicalId);
  }
  for (const model of remote) {
    const canonicalId = aliasTargets.get(catalogKey(model.providerId, model.canonicalId)) ?? model.canonicalId;
    const key = catalogKey(model.providerId, canonicalId);
    const bundled = merged.get(key);
    merged.set(key, bundled ? mergeCatalogRow(bundled, model) : model);
  }
  return [...merged.values()];
}

function mergeCatalogRow(bundled: ModelInfo, external: ModelInfo): ModelInfo {
  const statesModalities = (external.inputModalities?.length ?? 0) > 0 || (external.outputModalities?.length ?? 0) > 0;
  const statesTools = external.requestCapabilities !== undefined && external.requestCapabilities.tools !== "unknown";
  const statesVision = statesModalities || external.capabilities.vision === true;
  const statesReasoning = external.reasoning !== undefined && external.reasoning.source !== "unknown";
  // A Morrow-verified reasoning declaration carries the wire dialect and the
  // level set probed against the live API. No generic database has either, so
  // it outranks the external row rather than being replaced by it.
  const reasoning = isVerifiedReasoningDeclaration(bundled)
    ? bundled.reasoning
    : statesReasoning
      ? external.reasoning
      : bundled.reasoning;
  return {
    ...bundled,
    ...external,
    // Identity stays Morrow's: an external row reached through an alias must
    // not rename the model it was folded into.
    id: bundled.id,
    providerModelId: bundled.providerModelId,
    canonicalId: bundled.canonicalId,
    aliases: [...new Set([...bundled.aliases, ...external.aliases])],
    // Alias→canonical identity is Morrow's own graph; an external row has no
    // notion of it and must not break a declared redirect.
    ...(bundled.canonicalTarget ? { canonicalTarget: bundled.canonicalTarget } : {}),
    contextWindow: external.contextWindow ?? bundled.contextWindow,
    maxOutputTokens: external.maxOutputTokens ?? bundled.maxOutputTokens,
    ...(statesModalities
      ? {}
      : {
          ...(bundled.inputModalities ? { inputModalities: bundled.inputModalities } : {}),
          ...(bundled.outputModalities ? { outputModalities: bundled.outputModalities } : {}),
        }),
    // An authoritative price is a provider billing fact; a published aggregate
    // must not overwrite it, but it is better than nothing where none exists.
    pricing: bundled.pricing?.source === "authoritative" ? bundled.pricing : external.pricing ?? bundled.pricing,
    // Usage/streaming behaviour describes the adapter and the deployment, not
    // the model, so the bundled provider contract keeps it.
    tokenUsage: bundled.tokenUsage,
    streamingUsage: bundled.streamingUsage,
    privacy: bundled.privacy,
    speedClass: external.speedClass === "unknown" ? bundled.speedClass : external.speedClass,
    costClass: external.costClass === "unknown" ? bundled.costClass : external.costClass,
    capabilities: {
      streaming: bundled.capabilities.streaming,
      toolCalls: statesTools ? external.capabilities.toolCalls : bundled.capabilities.toolCalls,
      vision: statesVision ? external.capabilities.vision : bundled.capabilities.vision,
      ...(external.capabilities.reasoning === undefined || external.capabilities.reasoning === null
        ? (bundled.capabilities.reasoning === undefined ? {} : { reasoning: bundled.capabilities.reasoning })
        : { reasoning: external.capabilities.reasoning }),
    },
    ...(bundled.requestCapabilities || external.requestCapabilities
      ? { requestCapabilities: mergeRequestCapabilities(bundled.requestCapabilities ?? UNKNOWN_REQUEST_CAPABILITIES, statedRequestCapabilities(external.requestCapabilities)) }
      : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

/**
 * Reduce a request-capability profile to the fields it actually states.
 *
 * "unknown" from a catalogue that never claimed to enumerate a route's
 * accepted arguments is silence, not a retraction — dropping it lets the
 * protocol baseline (which the adapter owns) stand. A provider that DID
 * enumerate its parameters reports "unsupported" for the ones it omits, so
 * this never softens a real negative.
 */
export function statedRequestCapabilities(profile: ModelRequestCapabilities | undefined): Partial<ModelRequestCapabilities> {
  if (!profile) return {};
  return Object.fromEntries(
    Object.entries(profile).filter(([, value]) => value !== "unknown"),
  ) as Partial<ModelRequestCapabilities>;
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

/**
 * The catalog row for one provider/model pair.
 *
 * The installed external database is consulted after the flat catalog, not
 * instead of it: its rows already flow into the flat catalog for every model id
 * it publishes verbatim, and this fallback covers the case the flat catalog
 * cannot represent — a gateway id whose metadata lives under the underlying
 * vendor. That lookup applies the same gateway restriction the capability layer
 * does, so neither path claims the vendor's wire contract for the gateway.
 */
function catalogDeclaration(providerId: string, selectedId: string): ModelInfo | undefined {
  return exactIndex.get(catalogKey(providerId, selectedId))
    ?? aliasIndex.get(catalogKey(providerId, selectedId))
    ?? externalModelDeclaration(providerId, selectedId);
}

function resolveSelectedDeclaration(providerId: string, selectedId: string): { model: ModelInfo; selectedId: string } | undefined {
  const discovered = findDiscoveredModel(providerId, selectedId);
  if (discovered) {
    // Discovery LAYERS OVER the catalog; it does not replace it.
    //
    // A model listing that omits a field is silent, not authoritative: most
    // provider listings report nothing but ids (verified 2026-08-16 —
    // DeepSeek, NVIDIA NIM, TokenRouter and OpenCode Zen all return only
    // id/object/owned_by). Treating that silence as "unknown" would let a
    // successful discovery call erase a capacity the provider catalog knows,
    // which is a strictly worse answer than not discovering at all.
    //
    // Where discovery does report a value it wins outright, field by field.
    const base = catalogDeclaration(providerId, selectedId)
      ?? unknownModel(providerId as ProviderId, discovered.providerModelId);
    const contextWindow = discovered.contextWindow ?? base.contextWindow;
    const maxOutputTokens = discovered.maxOutputTokens ?? base.maxOutputTokens;
    const reportedAnyCapacity = discovered.contextWindow !== null || discovered.maxOutputTokens !== null;
    const synthesized: ModelInfo = {
      ...base,
      id: selectedId,
      providerModelId: discovered.providerModelId,
      label: discovered.displayName || base.label,
      author: discovered.author ?? base.author ?? null,
      inputModalities: discovered.inputModalities ?? base.inputModalities ?? [],
      outputModalities: discovered.outputModalities ?? base.outputModalities ?? [],
      pricing: discovered.pricing ?? base.pricing ?? null,
      costType: discovered.costType ?? base.costType ?? "unknown",
      contextWindow,
      maxOutputTokens,
      capabilities: {
        streaming: discovered.capabilities.streaming ?? base.capabilities.streaming,
        toolCalls: discovered.capabilities.toolCalls ?? base.capabilities.toolCalls,
        vision: discovered.capabilities.vision ?? base.capabilities.vision,
        reasoning: discovered.capabilities.reasoning ?? base.capabilities.reasoning ?? null,
      },
      ...(discovered.requestCapabilities ? { requestCapabilities: discovered.requestCapabilities } : {}),
      ...(discovered.reasoning ? { reasoning: discovered.reasoning } : {}),
      lifecycle: base.builtIn ? base.lifecycle : "custom",
      // Provenance follows the field that actually decided the capacity, so a
      // catalog number is never relabelled as provider-reported.
      metadataSource: discovered.contextWindow !== null ? "provider-reported" : base.metadataSource,
      fetchedAt: discovered.fetchedAt ?? base.fetchedAt ?? null,
      confidence: discovered.contextWindow !== null
        ? "reported"
        : reportedAnyCapacity && base.contextWindow === null
          ? "reported"
          : base.contextWindow !== null
            ? base.confidence
            : "unknown",
    };
    return { model: synthesized, selectedId };
  }

  const exact = exactIndex.get(catalogKey(providerId, selectedId));
  if (exact) return { model: exact, selectedId };
  const alias = aliasIndex.get(catalogKey(providerId, selectedId));
  if (alias) return { model: alias, selectedId };

  // Model ids are case-insensitive identities but case-sensitive payloads. A
  // user who types DEEPSEEK-V4-FLASH-FREE means the same model as the catalog's
  // lowercase entry, and must get its context window, pricing, and reasoning
  // contract — otherwise the route silently falls back to the conservative
  // 32k ceiling and compacts constantly. The caller still sends the id exactly
  // as supplied; only metadata lookup is case-insensitive.
  const insensitive = exactIndex.get(foldedKey(providerId, selectedId))
    ?? aliasIndex.get(foldedKey(providerId, selectedId))
    ?? externalModelDeclaration(providerId, selectedId);
  return insensitive ? { model: insensitive, selectedId } : undefined;
}

function resolveCanonicalDeclaration(model: ModelInfo): ModelInfo {
  let current = model;
  const seen = new Set<string>();
  while (current.canonicalTarget) {
    const key = catalogKey(current.providerId, current.id);
    if (seen.has(key)) throw new Error(`Canonical target cycle detected at ${current.providerId}/${current.id}`);
    seen.add(key);
    const next = exactIndex.get(catalogKey(current.canonicalTarget.providerId, current.canonicalTarget.modelId));
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
  return mergeRequestCapabilities(derived, statedRequestCapabilities(metadata.requestCapabilities));
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
  return [...(providerIndex.get(providerId) ?? [])];
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
