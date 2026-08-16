import type { ProviderProtocol } from "./base.js";
import type { DiscoveredModel, ModelInfo, ModelRequestCapabilities, ReasoningWire } from "@morrow/contracts";
import { reasoningModesForRoute } from "@morrow/contracts";
import { PROVIDER_MODEL_CATALOGS } from "./model-catalogs/index.js";
import { findDiscoveredModel } from "./registry.js";
import { providerRouteFingerprint } from "../routing/effective-context.js";

/** A fact source is deliberately narrower than a provider or model name. */
export type CapabilitySource =
  | "adapter-native"
  | "deployment"
  | "provider-reported"
  | "provider-catalog"
  | "route-config"
  | "fallback"
  | "unknown";

export type CapabilityAuthority = "adapter" | "deployment" | "provider" | "operator" | "fallback" | "unknown";
export type CapabilityConfidence = "verified" | "reported" | "configured" | "conservative" | "unknown";

export interface CapabilityFact<T> {
  readonly state: "known" | "unknown";
  readonly value: T | null;
  readonly source: CapabilitySource;
  readonly authority: CapabilityAuthority;
  readonly confidence: CapabilityConfidence;
  readonly fetchedAt: string | null;
}

export interface ExactProviderRoute {
  readonly providerId: string;
  readonly modelId: string;
  readonly protocol: ProviderProtocol;
  readonly endpointHost: string | null;
  readonly endpointIdentityHash: string | null;
  readonly routeFingerprint: string;
}

/**
 * Build the exact-route identity for one provider/model/endpoint triple.
 *
 * The route fingerprint is what binds provider-private continuation state (a
 * Gemini thought signature, a DeepSeek reasoning echo) to the endpoint that
 * issued it, so every caller must derive it the same way. Exposing one
 * constructor is what keeps the execution path and its tests from drifting
 * into two subtly different notions of "the same route".
 */
export function buildExactProviderRoute(input: {
  providerId: string;
  modelId: string;
  protocol: ProviderProtocol;
  endpointKind: "default" | "custom" | "injected";
  endpointHost: string | null;
  endpointIdentityHash?: string | null | undefined;
}): ExactProviderRoute {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    protocol: input.protocol,
    endpointHost: input.endpointHost,
    endpointIdentityHash: input.endpointIdentityHash ?? null,
    routeFingerprint: providerRouteFingerprint({
      providerId: input.providerId,
      model: input.modelId,
      protocol: input.protocol,
      endpointKind: input.endpointKind,
      endpointHost: input.endpointHost,
      endpointIdentityHash: input.endpointIdentityHash ?? null,
    }),
  };
}

export interface ReasoningEffortCapability {
  /** Provider-defined selector ID. It is never normalized to a core enum. */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** Provider-owned wire spelling, when the adapter needs one. */
  readonly wireValue?: string;
}

export interface ReasoningCapability {
  readonly mode: "none" | "fixed" | "selectable" | "budget" | "unknown";
  readonly efforts: readonly ReasoningEffortCapability[];
  readonly defaultId?: string;
  readonly supportsOff?: boolean;
  /** Adapter-owned wire dialect. `translateReasoning` dispatches on this, so a
   * provider whose spelling differs adds a dialect rather than a model check. */
  readonly wire?: ReasoningWire;
}

export type RequestCapabilityField =
  | "tools"
  | "toolChoice"
  | "temperature"
  | "streamUsage"
  | "responseFormat"
  | "maxOutputTokensField";

export interface RequestCapabilities {
  readonly tools: CapabilityFact<boolean>;
  readonly toolChoice: CapabilityFact<boolean>;
  readonly temperature: CapabilityFact<boolean>;
  readonly streamUsage: CapabilityFact<boolean>;
  readonly responseFormat: CapabilityFact<boolean>;
  readonly maxOutputTokensField: CapabilityFact<"max_tokens" | "max_completion_tokens" | "max_output_tokens">;
}

export interface ModelCapabilities {
  readonly displayName: CapabilityFact<string>;
  readonly contextWindow: CapabilityFact<number>;
  readonly maxOutputTokens: CapabilityFact<number>;
  readonly inputModalities: CapabilityFact<readonly string[]>;
  readonly outputModalities: CapabilityFact<readonly string[]>;
  readonly streaming: CapabilityFact<boolean>;
  readonly request: RequestCapabilities;
  readonly reasoning: CapabilityFact<ReasoningCapability>;
}

export interface ModelCapabilityPatch {
  readonly displayName?: CapabilityFact<string>;
  readonly contextWindow?: CapabilityFact<number>;
  readonly maxOutputTokens?: CapabilityFact<number>;
  readonly inputModalities?: CapabilityFact<readonly string[]>;
  readonly outputModalities?: CapabilityFact<readonly string[]>;
  readonly streaming?: CapabilityFact<boolean>;
  readonly request?: Partial<RequestCapabilities>;
  readonly reasoning?: CapabilityFact<ReasoningCapability>;
}

export interface CapabilityLayer {
  /** Used for diagnostics and for the precedence check. */
  readonly source: CapabilitySource;
  readonly capabilities: ModelCapabilityPatch;
}

export type ProviderModelCapabilityResolver = (route: ExactProviderRoute) => CapabilityLayer | undefined;

const nativeResolvers = new Map<string, ProviderModelCapabilityResolver>();

/** Register exact adapter/deployment metadata without giving routing a model whitelist. */
export function registerProviderModelCapabilityResolver(providerId: string, resolver: ProviderModelCapabilityResolver): () => void {
  if (nativeResolvers.has(providerId)) throw new Error(`A model capability resolver is already registered for ${providerId}`);
  nativeResolvers.set(providerId, resolver);
  return () => {
    if (nativeResolvers.get(providerId) === resolver) nativeResolvers.delete(providerId);
  };
}

/**
 * Authority, weakest to strongest. The ordering follows how specific a source
 * is to the route actually being called:
 *
 * - `provider-catalog` is generic metadata keyed on a model NAME. It describes
 *   the vendor's flagship deployment, not necessarily the endpoint configured
 *   here, so it is the weakest real fact.
 * - `route-config` is an operator statement about THIS exact route. It must
 *   outrank the generic catalog, or a smaller self-hosted/gateway deployment
 *   of a well-known model name would be handed requests it cannot accept.
 * - `provider-reported`, `deployment`, and `adapter-native` are all facts about
 *   the exact endpoint or wire protocol, observed rather than configured, so
 *   they still outrank operator configuration.
 */
const SOURCE_PRIORITY: Record<CapabilitySource, number> = {
  unknown: 0,
  fallback: 10,
  "provider-catalog": 20,
  "route-config": 30,
  "provider-reported": 40,
  deployment: 50,
  "adapter-native": 60,
};

/** Project provider-declared modes onto the exact capability shape, dropping
 * absent optional fields so an "unset" field never becomes an explicit
 * `undefined` the merge would have to treat as a value. */
function effortCapabilities(reasoning: Parameters<typeof reasoningModesForRoute>[0]): ReasoningEffortCapability[] {
  return reasoningModesForRoute(reasoning).map((mode) => ({
    id: mode.id,
    label: mode.label,
    ...(mode.description === undefined ? {} : { description: mode.description }),
    ...(mode.wireValue === undefined ? {} : { wireValue: mode.wireValue }),
  }));
}

function detached<T>(value: T): T {
  return structuredClone(value);
}

export function capabilityFact<T>(
  value: T,
  source: CapabilitySource,
  authority: CapabilityAuthority,
  confidence: CapabilityConfidence,
  fetchedAt: string | null = null,
): CapabilityFact<T> {
  return Object.freeze({
    state: "known" as const,
    value: detached(value),
    source,
    authority,
    confidence,
    fetchedAt,
  });
}

export function unknownCapabilityFact<T>(
  source: CapabilitySource = "unknown",
  authority: CapabilityAuthority = "unknown",
  confidence: CapabilityConfidence = "unknown",
): CapabilityFact<T> {
  return Object.freeze({
    state: "unknown" as const,
    value: null,
    source,
    authority,
    confidence,
    fetchedAt: null,
  });
}

function unknownRequestCapabilities(): RequestCapabilities {
  return {
    tools: unknownCapabilityFact(),
    toolChoice: unknownCapabilityFact(),
    temperature: unknownCapabilityFact(),
    streamUsage: unknownCapabilityFact(),
    responseFormat: unknownCapabilityFact(),
    maxOutputTokensField: unknownCapabilityFact(),
  };
}

function unknownCapabilities(): ModelCapabilities {
  return {
    displayName: unknownCapabilityFact(),
    contextWindow: unknownCapabilityFact(),
    maxOutputTokens: unknownCapabilityFact(),
    inputModalities: unknownCapabilityFact(),
    outputModalities: unknownCapabilityFact(),
    streaming: unknownCapabilityFact(),
    request: unknownRequestCapabilities(),
    reasoning: unknownCapabilityFact(),
  };
}

function factFromModelField<T>(
  value: T | null | undefined,
  source: CapabilitySource,
  authority: CapabilityAuthority,
  confidence: CapabilityConfidence,
  fetchedAt: string | null = null,
): CapabilityFact<T> {
  return value === null || value === undefined
    ? unknownCapabilityFact(source, authority, confidence)
    : capabilityFact(value, source, authority, confidence, fetchedAt);
}

function requestFact(
  value: "supported" | "unsupported" | "unknown" | undefined,
  source: CapabilitySource,
  authority: CapabilityAuthority,
  confidence: CapabilityConfidence,
): CapabilityFact<boolean> {
  if (value === "supported") return capabilityFact(true, source, authority, confidence);
  if (value === "unsupported") return capabilityFact(false, source, authority, confidence);
  return unknownCapabilityFact(source, authority, confidence);
}

function requestMaxOutputFact(
  value: ModelRequestCapabilities["maxOutputTokens" ] | undefined,
  source: CapabilitySource,
  authority: CapabilityAuthority,
  confidence: CapabilityConfidence,
): CapabilityFact<"max_tokens" | "max_completion_tokens" | "max_output_tokens"> {
  return value === undefined || value === "unknown"
    ? unknownCapabilityFact(source, authority, confidence)
    : capabilityFact(value, source, authority, confidence);
}

/** Convert the compatibility catalog view into a provider-owned capability layer. */
export function capabilityLayerFromModelInfo(
  model: ModelInfo,
  source: CapabilitySource = "provider-catalog",
  authority: CapabilityAuthority = "provider",
  confidence: CapabilityConfidence = "reported",
): CapabilityLayer {
  const request = model.requestCapabilities;
  const reasoning = model.reasoning;
  // The catalog owns both the selectable ids and the wire spelling each one
  // sends. Deriving a spelling from the id here would put one provider's
  // protocol quirk into the resolver every other provider also flows through.
  const reasoningEfforts = effortCapabilities(reasoning);
  // Catalog entries carry the day their facts were recorded. Keeping it on the
  // fact is what lets a consumer tell a freshly-published capability from one
  // that has been asserted unchanged for two releases.
  const fetchedAt = model.fetchedAt ?? null;
  return {
    source,
    capabilities: {
      displayName: capabilityFact(model.label, source, authority, confidence, fetchedAt),
      contextWindow: factFromModelField(model.contextWindow, source, authority, confidence, fetchedAt),
      maxOutputTokens: factFromModelField(model.maxOutputTokens, source, authority, confidence, fetchedAt),
      inputModalities: factFromModelField(model.inputModalities, source, authority, confidence, fetchedAt),
      outputModalities: factFromModelField(model.outputModalities, source, authority, confidence, fetchedAt),
      streaming: capabilityFact(model.capabilities.streaming, source, authority, confidence, fetchedAt),
      request: {
        tools: requestFact(request?.tools, source, authority, confidence),
        toolChoice: requestFact(request?.toolChoice, source, authority, confidence),
        temperature: requestFact(request?.temperature, source, authority, confidence),
        streamUsage: requestFact(request?.streamUsage, source, authority, confidence),
        responseFormat: requestFact(request?.responseFormat, source, authority, confidence),
        maxOutputTokensField: requestMaxOutputFact(request?.maxOutputTokens, source, authority, confidence),
      },
      reasoning: reasoning && reasoning.source !== "unknown" && reasoning.control !== "unknown"
        ? capabilityFact({
            mode: reasoning.control === "effort" ? "selectable" : reasoning.control,
            efforts: reasoningEfforts,
            ...(reasoningEfforts[0] ? { defaultId: reasoningEfforts[0].id } : {}),
            ...(reasoning.supportsOff === undefined ? {} : { supportsOff: reasoning.supportsOff }),
            ...(reasoning.wire ? { wire: reasoning.wire } : {}),
          }, source, authority, confidence, fetchedAt)
        : unknownCapabilityFact(source, authority, confidence),
    },
  };
}

/** Convert a dynamically discovered provider model into a provider-reported capability layer. */
export function capabilityLayerFromDiscoveredModel(
  model: DiscoveredModel,
  source: CapabilitySource = "provider-reported",
  authority: CapabilityAuthority = "provider",
  confidence: CapabilityConfidence = "reported",
): CapabilityLayer {
  return {
    source,
    capabilities: {
      displayName: capabilityFact(model.displayName, source, authority, confidence, model.fetchedAt ?? null),
      contextWindow: factFromModelField(model.contextWindow, source, authority, confidence, model.fetchedAt ?? null),
      maxOutputTokens: factFromModelField(model.maxOutputTokens, source, authority, confidence, model.fetchedAt ?? null),
      inputModalities: factFromModelField(model.inputModalities, source, authority, confidence, model.fetchedAt ?? null),
      outputModalities: factFromModelField(model.outputModalities, source, authority, confidence, model.fetchedAt ?? null),
      streaming: capabilityFact(model.capabilities.streaming ?? true, source, authority, confidence, model.fetchedAt ?? null),
      ...(model.requestCapabilities ? {
        request: {
          tools: requestFact(model.requestCapabilities.tools, source, authority, confidence),
          toolChoice: requestFact(model.requestCapabilities.toolChoice, source, authority, confidence),
          temperature: requestFact(model.requestCapabilities.temperature, source, authority, confidence),
          streamUsage: requestFact(model.requestCapabilities.streamUsage, source, authority, confidence),
          responseFormat: requestFact(model.requestCapabilities.responseFormat, source, authority, confidence),
          maxOutputTokensField: requestMaxOutputFact(model.requestCapabilities.maxOutputTokens, source, authority, confidence),
        },
      } : {}),
      ...(model.reasoning ? {
        reasoning: capabilityFact({
          mode: model.reasoning.control === "effort" ? "selectable" : model.reasoning.control,
          efforts: effortCapabilities(model.reasoning),
          ...(model.reasoning.supportsOff !== undefined ? { supportsOff: model.reasoning.supportsOff } : {}),
          ...(model.reasoning.wire ? { wire: model.reasoning.wire } : {}),
        }, source, authority, confidence, model.fetchedAt ?? null),
      } : {}),
    },
  };
}

function catalogModel(providerId: string, modelId: string): ModelInfo | undefined {
  return PROVIDER_MODEL_CATALOGS[providerId]?.find((model) =>
    model.id === modelId || model.aliases.includes(modelId) || model.id.toLowerCase() === modelId.toLowerCase(),
  );
}

/**
 * Resolve one exact route from adapter-owned metadata plus advisory catalog
 * metadata and dynamic runtime discovery. Unknown model IDs remain valid inputs
 * and return unknown facts.
 */
export function resolveProviderModelCapabilities(
  route: ExactProviderRoute,
  layers: readonly CapabilityLayer[] = [],
): ResolvedModelCapabilities {
  const resolver = nativeResolvers.get(route.providerId);
  const native = resolver?.(route);
  const catalog = catalogModel(route.providerId, route.modelId);
  const discovered = findDiscoveredModel(route.providerId, route.modelId);
  const discoveredLayer = discovered ? capabilityLayerFromDiscoveredModel(discovered) : undefined;
  return resolveModelCapabilities(route, [
    ...(catalog ? [capabilityLayerFromModelInfo(catalog)] : []),
    ...(discoveredLayer ? [discoveredLayer] : []),
    ...layers,
    ...(native ? [native] : []),
  ]);
}

export interface ResolvedModelCapabilities {
  readonly route: ExactProviderRoute;
  readonly capabilities: ModelCapabilities;
  readonly displayName: CapabilityFact<string>;
  readonly contextWindow: CapabilityFact<number>;
  readonly maxOutputTokens: CapabilityFact<number>;
  readonly inputModalities: CapabilityFact<readonly string[]>;
  readonly outputModalities: CapabilityFact<readonly string[]>;
  readonly streaming: CapabilityFact<boolean>;
  readonly request: RequestCapabilities;
  readonly reasoning: CapabilityFact<ReasoningCapability>;
}

function mergeFact<T>(
  current: CapabilityFact<T>,
  candidate: CapabilityFact<T>,
  layerSource: CapabilitySource,
): CapabilityFact<T> {
  if (candidate.state === "unknown") return current;
  if (candidate.source !== layerSource) {
    throw new Error(`Capability source mismatch: layer=${layerSource}, fact=${candidate.source}`);
  }
  if (current.state === "unknown" || SOURCE_PRIORITY[candidate.source] >= SOURCE_PRIORITY[current.source]) {
    return Object.freeze({
      ...candidate,
      value: detached(candidate.value),
    });
  }
  return current;
}

function mergeRequest(
  current: RequestCapabilities,
  patch: Partial<RequestCapabilities>,
  source: CapabilitySource,
): RequestCapabilities {
  return {
    tools: patch.tools === undefined ? current.tools : mergeFact(current.tools, patch.tools, source),
    toolChoice: patch.toolChoice === undefined ? current.toolChoice : mergeFact(current.toolChoice, patch.toolChoice, source),
    temperature: patch.temperature === undefined ? current.temperature : mergeFact(current.temperature, patch.temperature, source),
    streamUsage: patch.streamUsage === undefined ? current.streamUsage : mergeFact(current.streamUsage, patch.streamUsage, source),
    responseFormat: patch.responseFormat === undefined ? current.responseFormat : mergeFact(current.responseFormat, patch.responseFormat, source),
    maxOutputTokensField: patch.maxOutputTokensField === undefined
      ? current.maxOutputTokensField
      : mergeFact(current.maxOutputTokensField, patch.maxOutputTokensField, source),
  };
}

/**
 * Resolve one exact provider/model route. Each field is merged independently;
 * an omitted or unknown lower-confidence field never erases a known fact.
 */
export function resolveModelCapabilities(
  route: ExactProviderRoute,
  layers: readonly CapabilityLayer[],
): ResolvedModelCapabilities {
  const ordered = [...layers].sort((left, right) => SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source]);
  let current = unknownCapabilities();
  for (const layer of ordered) {
    const patch = layer.capabilities;
    if (patch.displayName !== undefined) current = { ...current, displayName: mergeFact(current.displayName, patch.displayName, layer.source) };
    if (patch.contextWindow !== undefined) current = { ...current, contextWindow: mergeFact(current.contextWindow, patch.contextWindow, layer.source) };
    if (patch.maxOutputTokens !== undefined) current = { ...current, maxOutputTokens: mergeFact(current.maxOutputTokens, patch.maxOutputTokens, layer.source) };
    if (patch.inputModalities !== undefined) current = { ...current, inputModalities: mergeFact(current.inputModalities, patch.inputModalities, layer.source) };
    if (patch.outputModalities !== undefined) current = { ...current, outputModalities: mergeFact(current.outputModalities, patch.outputModalities, layer.source) };
    if (patch.streaming !== undefined) current = { ...current, streaming: mergeFact(current.streaming, patch.streaming, layer.source) };
    if (patch.reasoning !== undefined) current = { ...current, reasoning: mergeFact(current.reasoning, patch.reasoning, layer.source) };
    if (patch.request !== undefined) current = { ...current, request: mergeRequest(current.request, patch.request, layer.source) };
  }
  return Object.freeze({ route, capabilities: current, ...current });
}

export function unknownModelCapabilities(route: ExactProviderRoute): ResolvedModelCapabilities {
  const capabilities = unknownCapabilities();
  return Object.freeze({ route, capabilities, ...capabilities });
}

/** Keep field names explicit at adapter call sites instead of stringly-typed spreads. */
export function requestCapability(
  capabilities: RequestCapabilities,
  field: RequestCapabilityField,
): CapabilityFact<boolean | "max_tokens" | "max_completion_tokens" | "max_output_tokens"> {
  return capabilities[field];
}
