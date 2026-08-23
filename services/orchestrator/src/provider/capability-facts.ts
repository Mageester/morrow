import type { DiscoveredModel, ModelInfo, ModelRequestCapabilities, ReasoningWire, RouteReasoningCapability } from "@morrow/contracts";
import { reasoningModesForRoute } from "@morrow/contracts";
import type { ProviderProtocol } from "./base.js";

/**
 * The capability fact algebra.
 *
 * This module is deliberately pure: it knows how to describe one capability,
 * where that description came from, and how two descriptions of the same field
 * combine. It knows nothing about which catalogs exist, how routes are
 * identified, or how a request is built — those live in
 * `model-capabilities.ts` and the provider adapters respectively, which is what
 * keeps the merge rules free of per-provider branching.
 */

/** A fact source is deliberately narrower than a provider or model name. */
export type CapabilitySource =
  | "adapter-native"
  | "deployment"
  | "provider-reported"
  | "route-config"
  | "provider-correction"
  | "external-catalog"
  | "provider-catalog"
  | "fallback"
  | "unknown";

export type CapabilityAuthority = "adapter" | "deployment" | "provider" | "operator" | "external" | "fallback" | "unknown";
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

export interface ReasoningEffortCapability {
  /** Provider-defined selector ID. It is never normalized to a core enum. */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** Provider-owned wire spelling, when the adapter needs one. */
  readonly wireValue?: string;
}

/**
 * What reasoning control one exact route exposes.
 *
 * The six states a caller has to be able to tell apart are all representable:
 *
 *  1. no reasoning ................ `mode: "none"`, `supported: false`
 *  2. fixed reasoning ............. `mode: "fixed"`, `supported: true`
 *  3. reasons, controls unknown ... `mode: "unknown"`, `supported: true`
 *  4. selectable effort ........... `mode: "selectable"` + a non-empty `efforts`
 *  5. token budget ................ `mode: "budget"`
 *  6. on/off toggle ............... any active mode plus `supportsOff: true`
 *
 * State 3 is the one an external metadata source usually lands on: it knows
 * the model reasons but not which depths this route accepts. Collapsing it
 * onto "fixed" would claim the depth cannot be tuned; collapsing it onto a
 * low/medium/high ladder would invent values the route may reject.
 */
export interface ReasoningCapability {
  readonly mode: "none" | "fixed" | "selectable" | "budget" | "unknown";
  readonly efforts: readonly ReasoningEffortCapability[];
  readonly defaultId?: string;
  /** Whether the model reasons at all, when that is known independently of
   * how (or whether) the depth can be controlled. */
  readonly supported?: boolean;
  readonly supportsOff?: boolean;
  /** Whether reasoning is interleaved with ordinary output on this route. */
  readonly interleaved?: boolean;
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
  /** Image/video input support. Derived from input modalities when a source
   * reports those instead of a separate flag — never guessed from a name. */
  readonly vision: CapabilityFact<boolean>;
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
  readonly vision?: CapabilityFact<boolean>;
  readonly streaming?: CapabilityFact<boolean>;
  readonly request?: Partial<RequestCapabilities>;
  readonly reasoning?: CapabilityFact<ReasoningCapability>;
}

export interface CapabilityLayer {
  /** Used for diagnostics and for the precedence check. */
  readonly source: CapabilitySource;
  readonly capabilities: ModelCapabilityPatch;
}

/**
 * Authority, weakest to strongest. The ordering follows how specific a source
 * is to the route actually being called:
 *
 * - `provider-catalog` is Morrow's own bundled seed metadata keyed on a model
 *   NAME. It exists so an offline start still knows something, and it covers a
 *   few dozen models rather than the field, so it is the weakest real fact.
 * - `external-catalog` is a comprehensive third-party model database
 *   (models.dev). It is still keyed on a model name and still describes the
 *   vendor's canonical deployment, but it is far broader and refreshed
 *   independently of a Morrow release, so it supersedes the bundled seed.
 * - `provider-correction` is a Morrow-verified compatibility fact that no
 *   generic database carries — a reasoning wire dialect, a level set probed
 *   against the live API. It must outrank the external catalog or a
 *   comprehensive-but-generic row would erase a quirk Morrow measured.
 * - `route-config` is an operator statement about THIS exact route. It must
 *   outrank any catalog, or a smaller self-hosted/gateway deployment of a
 *   well-known model name would be handed requests it cannot accept.
 * - `provider-reported`, `deployment`, and `adapter-native` are all facts about
 *   the exact endpoint or wire protocol, observed rather than configured, so
 *   they still outrank operator configuration.
 */
export const SOURCE_PRIORITY: Record<CapabilitySource, number> = {
  unknown: 0,
  fallback: 10,
  "provider-catalog": 20,
  "external-catalog": 25,
  "provider-correction": 28,
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

/** Restate a fact under a different source without re-deriving its value. Used
 * where one catalog row contributes at two authorities (generic seed facts and
 * Morrow-verified corrections), so both halves stay one declaration. */
export function retagCapabilityFact<T>(
  fact: CapabilityFact<T>,
  source: CapabilitySource,
  authority: CapabilityAuthority = fact.authority,
  confidence: CapabilityConfidence = fact.confidence,
): CapabilityFact<T> {
  return Object.freeze({ ...fact, value: detached(fact.value), source, authority, confidence });
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
    vision: unknownCapabilityFact(),
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
  value: ModelRequestCapabilities["maxOutputTokens"] | undefined,
  source: CapabilitySource,
  authority: CapabilityAuthority,
  confidence: CapabilityConfidence,
): CapabilityFact<"max_tokens" | "max_completion_tokens" | "max_output_tokens"> {
  return value === undefined || value === "unknown"
    ? unknownCapabilityFact(source, authority, confidence)
    : capabilityFact(value, source, authority, confidence);
}

/**
 * Whether a modality list implies image/video input.
 *
 * This is a read of the same fact in a different vocabulary, not an inference:
 * a source that lists `image` among its input modalities has stated vision
 * support. An empty or absent list states nothing and yields undefined.
 */
export function visionFromInputModalities(modalities: readonly string[] | null | undefined): boolean | undefined {
  if (!modalities || modalities.length === 0) return undefined;
  return modalities.some((modality) => {
    const normalized = modality.trim().toLowerCase();
    return normalized === "image" || normalized === "video";
  });
}

/**
 * Project a catalog-style reasoning declaration onto the exact capability
 * shape, keeping "the model reasons" separate from "here is how to control it".
 *
 * `reasons` is the independent boolean some sources carry (models.dev's
 * `reasoning`, a provider listing's capability flag). When a source knows only
 * that, the result is state 3 above — reasoning supported, controls unknown —
 * which is exactly what stops a picker from offering levels nobody verified.
 */
export function reasoningCapabilityFromDeclaration(
  declared: RouteReasoningCapability | undefined,
  reasons: boolean | null | undefined,
): ReasoningCapability | undefined {
  if (declared && declared.source !== "unknown" && declared.control !== "unknown") {
    const efforts = effortCapabilities(declared);
    return {
      mode: declared.control === "effort" ? "selectable" : declared.control,
      efforts,
      ...(efforts[0] ? { defaultId: efforts[0].id } : {}),
      supported: declared.control !== "none",
      ...(declared.supportsOff === undefined ? {} : { supportsOff: declared.supportsOff }),
      ...(declared.interleaved === undefined ? {} : { interleaved: declared.interleaved }),
      ...(declared.wire ? { wire: declared.wire } : {}),
    };
  }
  // A declaration that names a control but no depths still says the model
  // reasons; so does a bare boolean. Neither may invent a level list.
  if (declared && declared.source !== "unknown" && declared.control === "unknown") {
    return {
      mode: "unknown",
      efforts: [],
      supported: true,
      ...(declared.supportsOff === undefined ? {} : { supportsOff: declared.supportsOff }),
      ...(declared.interleaved === undefined ? {} : { interleaved: declared.interleaved }),
    };
  }
  if (reasons === true) return { mode: "unknown", efforts: [], supported: true };
  if (reasons === false) return { mode: "none", efforts: [], supported: false };
  return undefined;
}

/** Convert the compatibility catalog view into a capability layer. */
export function capabilityLayerFromModelInfo(
  model: ModelInfo,
  source: CapabilitySource = "provider-catalog",
  authority: CapabilityAuthority = "provider",
  confidence: CapabilityConfidence = "reported",
): CapabilityLayer {
  const request = model.requestCapabilities;
  // The catalog owns both the selectable ids and the wire spelling each one
  // sends. Deriving a spelling from the id here would put one provider's
  // protocol quirk into the resolver every other provider also flows through.
  const reasoning = reasoningCapabilityFromDeclaration(model.reasoning, model.capabilities.reasoning);
  // Catalog entries carry the day their facts were recorded. Keeping it on the
  // fact is what lets a consumer tell a freshly-published capability from one
  // that has been asserted unchanged for two releases.
  const fetchedAt = model.fetchedAt ?? null;
  const vision = model.capabilities.vision === true
    ? true
    : visionFromInputModalities(model.inputModalities) ?? model.capabilities.vision;
  // A catalog row that names tool calling has stated the request field is
  // usable, so both vocabularies agree instead of disagreeing per consumer.
  const tools = request?.tools ?? (model.capabilities.toolCalls ? "supported" : undefined);
  return {
    source,
    capabilities: {
      displayName: capabilityFact(model.label, source, authority, confidence, fetchedAt),
      contextWindow: factFromModelField(model.contextWindow, source, authority, confidence, fetchedAt),
      maxOutputTokens: factFromModelField(model.maxOutputTokens, source, authority, confidence, fetchedAt),
      inputModalities: factFromModelField(model.inputModalities, source, authority, confidence, fetchedAt),
      outputModalities: factFromModelField(model.outputModalities, source, authority, confidence, fetchedAt),
      vision: factFromModelField(vision, source, authority, confidence, fetchedAt),
      streaming: capabilityFact(model.capabilities.streaming, source, authority, confidence, fetchedAt),
      request: {
        tools: requestFact(tools, source, authority, confidence),
        toolChoice: requestFact(request?.toolChoice, source, authority, confidence),
        temperature: requestFact(request?.temperature, source, authority, confidence),
        streamUsage: requestFact(request?.streamUsage, source, authority, confidence),
        responseFormat: requestFact(request?.responseFormat, source, authority, confidence),
        maxOutputTokensField: requestMaxOutputFact(request?.maxOutputTokens, source, authority, confidence),
      },
      reasoning: reasoning
        ? capabilityFact(reasoning, source, authority, confidence, fetchedAt)
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
  const fetchedAt = model.fetchedAt ?? null;
  const vision = model.capabilities.vision ?? visionFromInputModalities(model.inputModalities);
  return {
    source,
    capabilities: {
      displayName: capabilityFact(model.displayName, source, authority, confidence, fetchedAt),
      contextWindow: factFromModelField(model.contextWindow, source, authority, confidence, fetchedAt),
      maxOutputTokens: factFromModelField(model.maxOutputTokens, source, authority, confidence, fetchedAt),
      inputModalities: factFromModelField(model.inputModalities, source, authority, confidence, fetchedAt),
      outputModalities: factFromModelField(model.outputModalities, source, authority, confidence, fetchedAt),
      vision: factFromModelField(vision, source, authority, confidence, fetchedAt),
      streaming: capabilityFact(model.capabilities.streaming ?? true, source, authority, confidence, fetchedAt),
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
          supported: model.reasoning.control !== "none",
          ...(model.reasoning.supportsOff !== undefined ? { supportsOff: model.reasoning.supportsOff } : {}),
          ...(model.reasoning.wire ? { wire: model.reasoning.wire } : {}),
        }, source, authority, confidence, fetchedAt),
      } : model.capabilities.reasoning === null || model.capabilities.reasoning === undefined ? {} : {
        reasoning: capabilityFact(
          model.capabilities.reasoning
            ? { mode: "unknown" as const, efforts: [], supported: true }
            : { mode: "none" as const, efforts: [], supported: false },
          source, authority, confidence, fetchedAt,
        ),
      }),
    },
  };
}

/**
 * An operator statement about one exact route.
 *
 * A configured endpoint ceiling is not a claim about the model — it is a claim
 * about the deployment this route reaches, which is why it outranks every
 * catalog and why nothing here touches fields the operator did not set.
 */
export function routeConfigCapabilityLayer(input: {
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
}): CapabilityLayer | undefined {
  const patch: { contextWindow?: CapabilityFact<number>; maxOutputTokens?: CapabilityFact<number> } = {};
  if (typeof input.contextWindowTokens === "number" && Number.isSafeInteger(input.contextWindowTokens) && input.contextWindowTokens > 0) {
    patch.contextWindow = capabilityFact(input.contextWindowTokens, "route-config", "operator", "configured");
  }
  if (typeof input.maxOutputTokens === "number" && Number.isSafeInteger(input.maxOutputTokens) && input.maxOutputTokens > 0) {
    patch.maxOutputTokens = capabilityFact(input.maxOutputTokens, "route-config", "operator", "configured");
  }
  return Object.keys(patch).length === 0 ? undefined : { source: "route-config", capabilities: patch };
}

export interface ResolvedModelCapabilities {
  readonly route: ExactProviderRoute;
  readonly capabilities: ModelCapabilities;
  readonly displayName: CapabilityFact<string>;
  readonly contextWindow: CapabilityFact<number>;
  readonly maxOutputTokens: CapabilityFact<number>;
  readonly inputModalities: CapabilityFact<readonly string[]>;
  readonly outputModalities: CapabilityFact<readonly string[]>;
  readonly vision: CapabilityFact<boolean>;
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
 * Merge capability layers field by field. An omitted or unknown
 * lower-confidence field never erases a known fact.
 */
export function resolveCapabilityLayers(layers: readonly CapabilityLayer[]): ModelCapabilities {
  const ordered = [...layers].sort((left, right) => SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source]);
  let current = unknownCapabilities();
  for (const layer of ordered) {
    const patch = layer.capabilities;
    if (patch.displayName !== undefined) current = { ...current, displayName: mergeFact(current.displayName, patch.displayName, layer.source) };
    if (patch.contextWindow !== undefined) current = { ...current, contextWindow: mergeFact(current.contextWindow, patch.contextWindow, layer.source) };
    if (patch.maxOutputTokens !== undefined) current = { ...current, maxOutputTokens: mergeFact(current.maxOutputTokens, patch.maxOutputTokens, layer.source) };
    if (patch.inputModalities !== undefined) current = { ...current, inputModalities: mergeFact(current.inputModalities, patch.inputModalities, layer.source) };
    if (patch.outputModalities !== undefined) current = { ...current, outputModalities: mergeFact(current.outputModalities, patch.outputModalities, layer.source) };
    if (patch.vision !== undefined) current = { ...current, vision: mergeFact(current.vision, patch.vision, layer.source) };
    if (patch.streaming !== undefined) current = { ...current, streaming: mergeFact(current.streaming, patch.streaming, layer.source) };
    if (patch.reasoning !== undefined) current = { ...current, reasoning: mergeFact(current.reasoning, patch.reasoning, layer.source) };
    if (patch.request !== undefined) current = { ...current, request: mergeRequest(current.request, patch.request, layer.source) };
  }
  return current;
}

/**
 * Resolve one exact provider/model route. Each field is merged independently;
 * an omitted or unknown lower-confidence field never erases a known fact.
 */
export function resolveModelCapabilities(
  route: ExactProviderRoute,
  layers: readonly CapabilityLayer[],
): ResolvedModelCapabilities {
  const current = resolveCapabilityLayers(layers);
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
