import type { ProviderProtocol } from "./base.js";
import { capabilityLayerFromDiscoveredModel, resolveModelCapabilities, type CapabilityLayer, type ExactProviderRoute, type ResolvedModelCapabilities } from "./capability-facts.js";
import { catalogCapabilityLayers } from "./model-catalogs/capability-layers.js";
import { findDiscoveredModel } from "./registry.js";
import { providerRouteFingerprint } from "../routing/effective-context.js";

/**
 * Exact-route capability resolution.
 *
 * The fact algebra itself lives in `capability-facts.ts`; the catalog layers in
 * `model-catalogs/capability-layers.ts`. This module owns the one thing that
 * needs a route: binding those layers to a specific provider + model +
 * endpoint, and letting an adapter contribute what only it can know.
 */

export type {
  CapabilityAuthority,
  CapabilityConfidence,
  CapabilityFact,
  CapabilityLayer,
  CapabilitySource,
  ExactProviderRoute,
  ModelCapabilities,
  ModelCapabilityPatch,
  ReasoningCapability,
  ReasoningEffortCapability,
  RequestCapabilities,
  RequestCapabilityField,
  ResolvedModelCapabilities,
} from "./capability-facts.js";
export {
  capabilityFact,
  capabilityLayerFromDiscoveredModel,
  capabilityLayerFromModelInfo,
  reasoningCapabilityFromDeclaration,
  requestCapability,
  resolveCapabilityLayers,
  resolveModelCapabilities,
  retagCapabilityFact,
  routeConfigCapabilityLayer,
  SOURCE_PRIORITY,
  unknownCapabilityFact,
  unknownModelCapabilities,
  visionFromInputModalities,
} from "./capability-facts.js";
export { catalogCapabilityLayers, findBundledModel } from "./model-catalogs/capability-layers.js";

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
 * Resolve one exact route from adapter-owned metadata plus catalog metadata
 * (bundled seed, Morrow corrections, external database) and dynamic runtime
 * discovery. Unknown model IDs remain valid inputs and return unknown facts.
 */
export function resolveProviderModelCapabilities(
  route: ExactProviderRoute,
  layers: readonly CapabilityLayer[] = [],
): ResolvedModelCapabilities {
  const resolver = nativeResolvers.get(route.providerId);
  const native = resolver?.(route);
  const discovered = findDiscoveredModel(route.providerId, route.modelId);
  const discoveredLayer = discovered ? capabilityLayerFromDiscoveredModel(discovered) : undefined;
  return resolveModelCapabilities(route, [
    ...catalogCapabilityLayers(route.providerId, route.modelId),
    ...(discoveredLayer ? [discoveredLayer] : []),
    ...layers,
    ...(native ? [native] : []),
  ]);
}
