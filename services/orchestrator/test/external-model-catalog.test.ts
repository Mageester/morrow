import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reasoningModesForRoute, type DiscoveredModel, type ModelInfo } from "@morrow/contracts";
import {
  IndexedExternalModelCatalog,
  installExternalModelCatalog,
  lookupExternalModel,
  normalizeModelsDevDocument,
} from "../src/provider/external-catalog/index.js";
import {
  buildExactProviderRoute,
  resolveProviderModelCapabilities,
  routeConfigCapabilityLayer,
} from "../src/provider/model-capabilities.js";
import { translateReasoning } from "../src/provider/reasoning.js";
import {
  BUILT_IN_MODELS,
  installModelCatalog,
  listModels,
  mergeModelCatalog,
  resolveModelMetadata,
  resolveModelRequestCapabilities,
  resolveReasoningCapability,
} from "../src/routing/models.js";
import { resolveModelBudget } from "../src/routing/model-budget.js";
import { externalCatalogFromSnapshot } from "../src/routing/model-catalog.js";
import {
  installProviderModelDiscoveries,
  invalidateProviderModelDiscoveries,
} from "../src/provider/registry.js";

/**
 * A models.dev-shaped document. Only the fields Morrow reads are populated, and
 * every test that cares about a field's ABSENCE simply omits it — that is the
 * behaviour under test as much as the presence of a value is.
 */
const MODELS_DEV_DOCUMENT = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    models: {
      "moonshotai/kimi-k3-thinking": {
        id: "moonshotai/kimi-k3-thinking",
        name: "Kimi K3 Thinking",
        family: "kimi",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 0.6, output: 2.5 },
        limit: { context: 262_144, output: 65_536 },
      },
      "qwen/qwen3.8-vl-max": {
        id: "qwen/qwen3.8-vl-max",
        name: "Qwen3.8 VL Max",
        attachment: true,
        reasoning: false,
        temperature: true,
        tool_call: true,
        structured_output: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 131_072, output: 32_768 },
      },
      "openai/gpt-5.6-terra": {
        id: "openai/gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        tool_call: true,
        structured_output: true,
        temperature: false,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 400_000, output: 128_000 },
      },
      "anthropic/claude-thinker-9": {
        id: "anthropic/claude-thinker-9",
        name: "Claude Thinker 9 (via OpenRouter)",
        reasoning: true,
        reasoning_options: [{ type: "budget_tokens", min: 1_024, max: 64_000 }],
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 200_000, output: 64_000 },
      },
      "vendor/toggler-1": {
        id: "vendor/toggler-1",
        name: "Toggler 1",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
        interleaved: { field: "reasoning_content" },
        tool_call: true,
        limit: { context: 65_536, output: 8_192 },
      },
      // A row shaped like the image/audio models that really appear upstream:
      // a zero context limit is "not token-limited", never "zero tokens".
      "vendor/painter-2": {
        id: "vendor/painter-2",
        name: "Painter 2",
        reasoning: false,
        limit: { context: 0, input: 0, output: 0 },
        modalities: { input: ["text"], output: ["image"] },
      },
      // `experimental` is a boolean on some providers and an object on others.
      // Neither may take the rest of the provider down with it.
      "vendor/oddball-3": {
        id: "vendor/oddball-3",
        name: "Oddball 3",
        experimental: { modes: { fast: { cost: { input: 1 } } } },
        reasoning: false,
        tool_call: true,
        limit: { context: 8_192, output: 4_096 },
      },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-sonnet-5": {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        attachment: true,
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
        temperature: true,
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 3, output: 15 },
        limit: { context: 1_000_000, output: 128_000 },
      },
      // Upstream publishes BOTH the undated id and Morrow's dated one. Morrow's
      // catalog declares the undated id as an alias, so treating this as a
      // second model makes that selection ambiguous.
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        attachment: true,
        reasoning: false,
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 200_000, output: 64_000 },
      },
    },
  },
  google: {
    id: "google",
    name: "Google",
    models: {
      "gemini-3.7-flash": {
        id: "gemini-3.7-flash",
        name: "Gemini 3.7 Flash",
        attachment: true,
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
        tool_call: true,
        modalities: { input: ["text", "image", "audio"], output: ["text"] },
        limit: { context: 1_048_576, output: 65_536 },
      },
    },
  },
  groq: {
    id: "groq",
    name: "Groq",
    models: {
      "llama-4.2-90b": {
        id: "llama-4.2-90b",
        name: "Llama 4.2 90B",
        reasoning: false,
        temperature: true,
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 131_072, output: 32_768 },
      },
    },
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    models: {
      "qwen3.5": {
        id: "qwen3.5",
        name: "Qwen 3.5",
        reasoning: false,
        tool_call: true,
        open_weights: true,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 262_144, output: 32_768 },
      },
    },
  },
  // A provider Morrow has no route for at all. It must be skipped without
  // discarding anything above it.
  "amazon-bedrock": { id: "amazon-bedrock", models: { "nova-9": { id: "nova-9", name: "Nova 9" } } },
  // A structurally broken provider document, for the same reason.
  broken: { models: "not an object" },
} as const;

const SNAPSHOT = {
  metadataVersion: "models.dev:test-etag",
  fetchedAt: "2026-08-20T00:00:00.000Z",
};

function externalCatalog(document: unknown = MODELS_DEV_DOCUMENT): IndexedExternalModelCatalog {
  return new IndexedExternalModelCatalog({
    sourceId: "models.dev",
    version: SNAPSHOT.metadataVersion,
    fetchedAt: SNAPSHOT.fetchedAt,
    models: normalizeModelsDevDocument(document, SNAPSHOT),
  });
}

function route(input: {
  providerId: string;
  modelId: string;
  protocol?: "openai-chat" | "gemini-generate-content" | "anthropic-messages";
  endpointKind?: "default" | "custom";
  endpointHost?: string | null;
}) {
  return buildExactProviderRoute({
    providerId: input.providerId,
    modelId: input.modelId,
    protocol: input.protocol ?? "openai-chat",
    endpointKind: input.endpointKind ?? "default",
    endpointHost: input.endpointHost ?? null,
    endpointIdentityHash: null,
  });
}

function discovered(overrides: Partial<DiscoveredModel> & { providerModelId: string }): DiscoveredModel {
  return {
    displayName: overrides.providerModelId,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: { streaming: true, toolCalls: true, vision: false },
    metadataSource: "provider-reported",
    ...overrides,
  } as DiscoveredModel;
}

const bundledCatalog = listModels();

beforeEach(() => {
  invalidateProviderModelDiscoveries();
  installExternalModelCatalog(externalCatalog());
  installModelCatalog(mergeModelCatalog(BUILT_IN_MODELS, [...externalCatalog().models()]));
});

afterEach(() => {
  installExternalModelCatalog(null);
  installModelCatalog([...bundledCatalog]);
  invalidateProviderModelDiscoveries();
});

describe("models.dev ingestion", () => {
  it("normalizes only providers Morrow can route to, and survives broken neighbours", () => {
    const models = normalizeModelsDevDocument(MODELS_DEV_DOCUMENT, SNAPSHOT);
    const providers = new Set(models.map((model) => model.providerId));
    expect(providers).toEqual(new Set(["openrouter", "anthropic", "gemini", "groq", "ollama"]));
    // The external catalog is metadata, never a route: a provider Morrow has no
    // adapter for contributes nothing rather than inventing one.
    expect(models.some((model) => model.id === "nova-9")).toBe(false);
    for (const model of models) {
      expect(model.metadataSource).toBe("remote-catalog");
      expect(model.capabilitySource).toBe("remote-catalog");
      expect(model.fetchedAt).toBe(SNAPSHOT.fetchedAt);
      expect(model.metadataVersion).toBe(SNAPSHOT.metadataVersion);
    }
  });

  it("returns nothing at all for a document it cannot understand", () => {
    expect(normalizeModelsDevDocument("not a document", SNAPSHOT)).toEqual([]);
    expect(normalizeModelsDevDocument({}, SNAPSHOT)).toEqual([]);
    expect(normalizeModelsDevDocument(null, SNAPSHOT)).toEqual([]);
  });

  it("never fabricates a reasoning level ladder from a bare reasoning flag", () => {
    const models = normalizeModelsDevDocument(MODELS_DEV_DOCUMENT, SNAPSHOT);
    const kimi = models.find((model) => model.id === "moonshotai/kimi-k3-thinking")!;
    // `reasoning: true` and nothing else. The model reasons; which depths it
    // accepts is genuinely unknown and stays that way.
    expect(kimi.reasoning).toMatchObject({ control: "unknown", efforts: [], source: "external-catalog" });
    expect(kimi.capabilities.reasoning).toBe(true);
    expect(reasoningModesForRoute(kimi.reasoning)).toEqual([]);

    // A row that DOES enumerate depths yields exactly those, in order.
    const terra = models.find((model) => model.id === "openai/gpt-5.6-terra")!;
    expect(terra.reasoning).toMatchObject({ control: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] });
    // ...and still declares no wire dialect: that belongs to the adapter.
    expect(terra.reasoning?.wire).toBeUndefined();

    const qwen = models.find((model) => model.id === "qwen/qwen3.8-vl-max")!;
    expect(qwen.reasoning).toMatchObject({ control: "none" });
    expect(qwen.capabilities.reasoning).toBe(false);
  });

  it("distinguishes every reasoning control the database expresses", () => {
    const models = normalizeModelsDevDocument(MODELS_DEV_DOCUMENT, SNAPSHOT);
    const by = (id: string) => models.find((model) => model.id === id)!.reasoning!;
    // A token-budget range is not an enumeration: any positive budget is in
    // contract, so no budget list is invented from min/max.
    expect(by("anthropic/claude-thinker-9")).toMatchObject({ control: "budget", efforts: [], budgets: [] });
    // A toggle says reasoning can be switched off; it does not say HOW, and on
    // an OpenAI-compatible route "omit the field" means "provider default",
    // not "off". Claiming supportsOff would turn a user's Off selection into a
    // request that quietly keeps reasoning on.
    expect(by("vendor/toggler-1")).toMatchObject({ control: "fixed" });
    expect(by("vendor/toggler-1").supportsOff).toBeUndefined();
    // Interleaved reasoning is ingested as a capability. The wire field that
    // carries it stays with the adapter.
    expect(by("vendor/toggler-1").interleaved).toBe(true);
    expect(by("openai/gpt-5.6-terra").interleaved).toBeUndefined();
  });

  it("reads structured output and temperature support where the database states them", () => {
    const models = normalizeModelsDevDocument(MODELS_DEV_DOCUMENT, SNAPSHOT);
    const terra = models.find((model) => model.id === "openai/gpt-5.6-terra")!;
    expect(terra.requestCapabilities).toMatchObject({ responseFormat: "supported", temperature: "unsupported" });
    // Silence stays silence — never "unsupported".
    const kimi = models.find((model) => model.id === "moonshotai/kimi-k3-thinking")!;
    expect(kimi.requestCapabilities).toMatchObject({ responseFormat: "unknown", toolChoice: "unknown", maxOutputTokens: "unknown" });
  });

  it("survives the row shapes real upstream data actually contains", () => {
    const models = normalizeModelsDevDocument(MODELS_DEV_DOCUMENT, SNAPSHOT);
    // A zero context limit means "not token-limited", not "zero tokens", and
    // must not take its provider's other 6 models down with it.
    const painter = models.find((model) => model.id === "vendor/painter-2")!;
    expect(painter.contextWindow).toBeNull();
    expect(painter.maxOutputTokens).toBeNull();
    // `experimental` is an object on some providers, a boolean on others.
    expect(models.find((model) => model.id === "vendor/oddball-3")?.contextWindow).toBe(8_192);
    expect(models.filter((model) => model.providerId === "openrouter")).toHaveLength(7);
  });

  it("reads vision out of input modalities rather than a model name", () => {
    const models = normalizeModelsDevDocument(MODELS_DEV_DOCUMENT, SNAPSHOT);
    expect(models.find((model) => model.id === "qwen/qwen3.8-vl-max")?.capabilities.vision).toBe(true);
    expect(models.find((model) => model.id === "moonshotai/kimi-k3-thinking")?.capabilities.vision).toBe(false);
  });

  it("keeps published pricing out of Morrow's authoritative cost maths", () => {
    const models = normalizeModelsDevDocument(MODELS_DEV_DOCUMENT, SNAPSHOT);
    expect(models.find((model) => model.id === "anthropic/claude-sonnet-5" || model.id === "claude-sonnet-5")?.pricing)
      .toMatchObject({ inputUsdPerMillion: 3, outputUsdPerMillion: 15, source: "provider-reported" });
  });
});

describe("an unbundled OpenRouter model gets real capabilities", () => {
  const kimi = route({ providerId: "openrouter", modelId: "moonshotai/kimi-k3-thinking", endpointHost: "openrouter.ai" });

  it("resolves context, output, tools, modalities and reasoning support from external metadata", () => {
    // Morrow's bundled OpenRouter catalog has never heard of this model.
    expect(BUILT_IN_MODELS.some((model) => model.providerId === "openrouter" && model.id === "moonshotai/kimi-k3-thinking")).toBe(false);

    const resolved = resolveProviderModelCapabilities(kimi);
    expect(resolved.contextWindow).toMatchObject({ value: 262_144, source: "external-catalog", authority: "external" });
    expect(resolved.maxOutputTokens.value).toBe(65_536);
    expect(resolved.request.tools.value).toBe(true);
    expect(resolved.request.temperature.value).toBe(true);
    expect(resolved.vision.value).toBe(false);
    expect(resolved.reasoning.value).toMatchObject({ mode: "unknown", supported: true, efforts: [] });
    // Stale-but-usable: the fact says when it was fetched.
    expect(resolved.contextWindow.fetchedAt).toBe(SNAPSHOT.fetchedAt);
  });

  it("stays selectable and budgets correctly through the flat routing path too", () => {
    const budget = resolveModelBudget({
      providerId: "openrouter",
      selectedModel: "moonshotai/kimi-k3-thinking",
      endpoint: { kind: "default", host: "openrouter.ai", protocol: "openai-chat", limitTokens: null, limitSource: "unknown" },
    });
    expect(budget.effectiveContextWindowTokens).toBe(262_144);
    expect(budget.capabilities.vision).toBe(false);
    expect(budget.capabilities.toolCalls).toBe(true);
    expect(budget.usableInputTokens).toBeGreaterThan(200_000);
  });

  it("exposes vision from input modalities for a model that has it", () => {
    const resolved = resolveProviderModelCapabilities(route({ providerId: "openrouter", modelId: "qwen/qwen3.8-vl-max" }));
    expect(resolved.vision.value).toBe(true);
    expect(resolved.inputModalities.value).toEqual(["text", "image"]);
    expect(resolveModelMetadata("openrouter", "qwen/qwen3.8-vl-max").capabilities.vision).toBe(true);
  });

  it("offers the exact reasoning depths the database enumerated, and no others", () => {
    const capability = resolveProviderModelCapabilities(route({ providerId: "openrouter", modelId: "openai/gpt-5.6-terra" })).reasoning.value!;
    expect(capability.mode).toBe("selectable");
    expect(capability.efforts.map((effort) => effort.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // The gateway's own adapter decides the spelling; the database never did.
    expect(translateReasoning({ mode: "effort", effort: "xhigh" }, "openai-chat", capability))
      .toEqual({ ok: true, params: { reasoning_effort: "xhigh" } });
    // A depth nobody advertised is refused before the wire.
    expect(translateReasoning({ mode: "effort", effort: "minimal" }, "openai-chat", capability).ok).toBe(false);
  });
});

describe("gateway ids resolve to the underlying model without borrowing its wire format", () => {
  it("finds an underlying vendor model when the gateway itself is not listed", () => {
    // `tokenrouter` publishes nothing to models.dev in this snapshot, but the
    // id names Anthropic's model, which the database does describe.
    const match = lookupExternalModel("tokenrouter", "anthropic/claude-sonnet-5");
    expect(match).toMatchObject({ kind: "gateway-underlying", sourceProviderId: "anthropic" });

    const resolved = resolveProviderModelCapabilities(
      route({ providerId: "tokenrouter", modelId: "anthropic/claude-sonnet-5", endpointHost: "api.tokenrouter.com" }),
    );
    expect(resolved.contextWindow.value).toBe(1_000_000);
    expect(resolved.vision.value).toBe(true);
    expect(resolved.request.tools.value).toBe(true);
  });

  it("never carries a vendor's protocol facts across the gateway hop", () => {
    const gateway = resolveProviderModelCapabilities(
      route({ providerId: "tokenrouter", modelId: "anthropic/claude-sonnet-5" }),
    );
    // Anthropic's own row says the model reasons at three selectable depths.
    // Those depths are a MODEL fact and cross the hop; the dialect they would
    // be spelled in on Anthropic's own API does not, nor does an off switch,
    // nor any claim about the gateway's sampling or response-format support.
    expect(gateway.reasoning.value).toMatchObject({ mode: "selectable", supported: true });
    expect(gateway.reasoning.value?.efforts.map((effort) => effort.id)).toEqual(["low", "medium", "high"]);
    expect(gateway.reasoning.value?.wire).toBeUndefined();
    expect(gateway.reasoning.value?.supportsOff).toBeUndefined();
    expect(gateway.reasoning.value?.interleaved).toBeUndefined();
    // The gateway's adapter therefore decides the spelling, from its own
    // protocol — never from the fact that the model is Anthropic's.
    expect(translateReasoning({ mode: "effort", effort: "high" }, "openai-chat", gateway.reasoning.value!))
      .toEqual({ ok: true, params: { reasoning_effort: "high" } });
    expect(gateway.request.temperature.state).toBe("unknown");
    expect(gateway.request.responseFormat.state).toBe("unknown");
    expect(gateway.request.maxOutputTokensField.state).toBe("unknown");
    // The flat routing view agrees, so the request builder cannot disagree.
    expect(resolveModelMetadata("tokenrouter", "anthropic/claude-sonnet-5").reasoning?.wire).toBeUndefined();
  });

  it("folds an external id that Morrow declares as an alias, instead of duplicating the model", () => {
    // Regression against real models.dev data: it publishes BOTH
    // `claude-haiku-4-5` and `claude-haiku-4-5-20251001`, and Morrow's catalog
    // declares the former as an alias of the latter. Adding it as a second
    // anthropic model makes that selection ambiguous, which the catalog
    // validator rejects — taking startup with it.
    const external = normalizeModelsDevDocument(MODELS_DEV_DOCUMENT, SNAPSHOT);
    const merged = mergeModelCatalog([...BUILT_IN_MODELS], external);
    const haiku = merged.filter((model) => model.providerId === "anthropic" && model.id.startsWith("claude-haiku-4-5"));
    expect(haiku).toHaveLength(1);
    expect(haiku[0]?.id).toBe("claude-haiku-4-5-20251001");
    expect(haiku[0]?.aliases).toContain("claude-haiku-4-5");
    expect(() => installModelCatalog(merged)).not.toThrow();
    // Both spellings still resolve, and to the same model.
    expect(resolveModelMetadata("anthropic", "claude-haiku-4-5").canonicalId)
      .toBe(resolveModelMetadata("anthropic", "claude-haiku-4-5-20251001").canonicalId);
  });

  it("matches a model whose id differs only in punctuation", () => {
    // Vendors publish `claude-…-4-5`; gateways publish `claude-…-4.5`. That is
    // one identifier spelled two ways, not two models.
    const match = lookupExternalModel("tokenrouter", "anthropic/claude-sonnet.5");
    expect(match).toMatchObject({ kind: "gateway-underlying", sourceProviderId: "anthropic" });
    expect(match?.model.id).toBe("claude-sonnet-5");
  });

  it("refuses a punctuation match that lands on more than one model", () => {
    const ambiguous = externalCatalog({
      groq: {
        id: "groq",
        models: {
          "model-1-5": { id: "model-1-5", name: "Dashed", limit: { context: 8_192 } },
          "model.1.5": { id: "model.1.5", name: "Dotted", limit: { context: 131_072 } },
        },
      },
    });
    expect(ambiguous.lookup("groq", "model_1_5")).toBeUndefined();
    // The exact spellings still resolve, each to itself.
    expect(ambiguous.lookup("groq", "model-1-5")?.model.contextWindow).toBe(8_192);
    expect(ambiguous.lookup("groq", "model.1.5")?.model.contextWindow).toBe(131_072);
  });

  it("resolves a gateway routing/billing variant as the same model", () => {
    expect(lookupExternalModel("openrouter", "qwen/qwen3.8-vl-max:free")).toMatchObject({ kind: "alias" });
    expect(resolveProviderModelCapabilities(route({ providerId: "openrouter", modelId: "qwen/qwen3.8-vl-max:free" })).contextWindow.value)
      .toBe(131_072);
    // An Ollama tag names a genuinely different model and must NOT be folded
    // into its family.
    expect(lookupExternalModel("ollama", "qwen3.5:32b")).toBeUndefined();
  });

  it("refuses an ambiguous bare id rather than borrowing somebody else's facts", () => {
    const ambiguous = externalCatalog({
      groq: { id: "groq", models: { "shared-name": { id: "shared-name", name: "A", limit: { context: 8_192 } } } },
      cerebras: { id: "cerebras", models: { "shared-name": { id: "shared-name", name: "B", limit: { context: 131_072 } } } },
    });
    installExternalModelCatalog(ambiguous);
    expect(ambiguous.lookup("openrouter", "unknown-vendor/shared-name")).toBeUndefined();
  });
});

describe("stronger sources still win, weaker ones still fill gaps", () => {
  it("lets live OpenRouter route metadata override the external database", () => {
    installProviderModelDiscoveries([{
      providerId: "openrouter",
      authMode: "openrouter-api-key",
      models: [discovered({
        providerModelId: "moonshotai/kimi-k3-thinking",
        displayName: "Kimi K3 Thinking (live)",
        contextWindow: 131_072,
        fetchedAt: "2026-08-22T00:00:00.000Z",
      })],
      status: "available",
      errorKind: null,
      fetchedAt: "2026-08-22T00:00:00.000Z",
    }]);
    const resolved = resolveProviderModelCapabilities(route({ providerId: "openrouter", modelId: "moonshotai/kimi-k3-thinking" }));
    expect(resolved.contextWindow).toMatchObject({ value: 131_072, source: "provider-reported" });
    // Fields the live route was silent about still come from the database.
    expect(resolved.maxOutputTokens).toMatchObject({ value: 65_536, source: "external-catalog" });
  });

  it("lets exact route configuration override any generic catalog fact", () => {
    const operator = routeConfigCapabilityLayer({ contextWindowTokens: 32_768 })!;
    const resolved = resolveProviderModelCapabilities(
      route({ providerId: "openrouter", modelId: "moonshotai/kimi-k3-thinking" }),
      [operator],
    );
    expect(resolved.contextWindow).toMatchObject({ value: 32_768, source: "route-config", authority: "operator" });
  });

  it("honours a local deployment's real window over the canonical model size", () => {
    // models.dev says this Qwen build is a 262k model. The operator runs it at
    // 32k, and that is what the request must respect.
    expect(resolveModelMetadata("ollama", "qwen3.5").contextWindow).toBe(262_144);
    const budget = resolveModelBudget({
      providerId: "ollama",
      selectedModel: "qwen3.5",
      endpoint: { kind: "custom", host: "127.0.0.1:11434", protocol: "openai-chat", limitTokens: 32_768, limitSource: "endpoint-override" },
    });
    expect(budget.nativeContextWindowTokens).toBe(262_144);
    expect(budget.effectiveContextWindowTokens).toBe(32_768);
    expect(budget.contextWindowConfidence).toBe("configured");
  });

  it("keeps a Morrow-verified reasoning quirk above a comprehensive generic row", () => {
    // The database knows Gemini 3.7 Flash reasons but not which thinkingLevel
    // values it accepts; Morrow probed the live API and knows MINIMAL is
    // rejected. The measured answer must survive the merge.
    const capability = resolveProviderModelCapabilities(
      route({ providerId: "gemini", modelId: "gemini-3.7-flash", protocol: "gemini-generate-content" }),
    ).reasoning.value!;
    expect(capability.efforts.map((effort) => effort.id)).toEqual(["low", "medium", "high"]);
    expect(capability.wire).toBe("gemini-thinking-level");
    expect(translateReasoning({ mode: "effort", effort: "minimal" }, "gemini-generate-content", capability).ok).toBe(false);
    // ...and the flat routing view says exactly the same thing.
    expect(reasoningModesForRoute(resolveReasoningCapability("gemini", "gemini-3.7-flash")).map((mode) => mode.id))
      .toEqual(["low", "medium", "high"]);
    // The context capacity, which Morrow's catalog deliberately does NOT
    // restate, is happily taken from the database.
    expect(resolveModelMetadata("gemini", "gemini-3.7-flash").contextWindow).toBe(1_048_576);
  });

  it("does not regress DeepSeek, whose reasoning contract no database carries", () => {
    const capability = resolveProviderModelCapabilities(
      route({ providerId: "deepseek", modelId: "deepseek-v4-pro", endpointHost: "api.deepseek.com" }),
    ).reasoning.value!;
    expect(capability.efforts.map((effort) => effort.id)).toEqual(["low", "high", "xhigh", "max"]);
    expect(capability.supportsOff).toBe(true);
    expect(translateReasoning({ mode: "effort", effort: "low" }, "openai-chat", capability))
      .toEqual({ ok: true, params: { reasoning_effort: "high", thinking: { type: "enabled" } } });
    expect(resolveModelMetadata("deepseek", "deepseek-v4-pro").contextWindow).toBe(1_000_000);
    expect(resolveModelMetadata("deepseek", "deepseek-v4-pro").pricing?.source).toBe("authoritative");
  });

  it("keeps a bundled authoritative price when the database publishes an aggregate", () => {
    const merged = mergeModelCatalog(
      [resolveModelMetadata("anthropic", "claude-sonnet-5")],
      normalizeModelsDevDocument(MODELS_DEV_DOCUMENT, SNAPSHOT).filter((model) => model.providerId === "anthropic"),
    );
    expect(merged[0]?.pricing?.source).toBe("authoritative");
    expect(merged[0]?.pricing?.inputUsdPerMillion).toBe(3);
    // Reasoning declared by Morrow (fixed) is not downgraded by the row's
    // generic "it reasons" boolean.
    expect(merged[0]?.reasoning?.control).toBe("fixed");
  });
});

describe("no external metadata at all", () => {
  beforeEach(() => {
    installExternalModelCatalog(null);
    installModelCatalog([...bundledCatalog]);
  });

  it("keeps every bundled route working when the database is unreachable", () => {
    expect(lookupExternalModel("openrouter", "moonshotai/kimi-k3-thinking")).toBeUndefined();
    expect(resolveModelMetadata("deepseek", "deepseek-v4-pro").contextWindow).toBe(1_000_000);
    expect(reasoningModesForRoute(resolveReasoningCapability("deepseek", "deepseek-v4-pro")).map((mode) => mode.id))
      .toEqual(["low", "high", "xhigh", "max"]);
    expect(resolveModelMetadata("openai", "gpt-5.6-sol").contextWindow).toBe(1_050_000);
    expect(resolveModelMetadata("anthropic", "claude-sonnet-5").contextWindow).toBe(1_000_000);
  });

  it("leaves a model nobody has catalogued executable, with unknown facts", () => {
    const resolved = resolveProviderModelCapabilities(route({
      providerId: "openrouter",
      modelId: "moonshotai/kimi-k3-thinking",
      endpointHost: "openrouter.ai",
    }));
    expect(resolved.contextWindow.state).toBe("unknown");
    expect(resolved.reasoning.state).toBe("unknown");
    expect(resolved.vision.state).toBe("unknown");
    // Unknown is not a rejection: the exact id survives resolution untouched.
    expect(resolved.route.modelId).toBe("moonshotai/kimi-k3-thinking");
    const budget = resolveModelBudget({
      providerId: "openrouter",
      selectedModel: "moonshotai/kimi-k3-thinking",
      endpoint: { kind: "default", host: "openrouter.ai", protocol: "openai-chat", limitTokens: null, limitSource: "unknown" },
    });
    expect(budget.selectedModelId).toBe("moonshotai/kimi-k3-thinking");
    expect(budget.usableInputTokens).toBeNull();
  });
});

describe("one resolved truth feeds every consumer", () => {
  const matrix = [
    { providerId: "deepseek", modelId: "deepseek-v4-pro", protocol: "openai-chat" },
    { providerId: "openai", modelId: "gpt-5.6-sol", protocol: "openai-chat" },
    { providerId: "anthropic", modelId: "claude-sonnet-5", protocol: "anthropic-messages" },
    { providerId: "gemini", modelId: "gemini-3.7-flash", protocol: "gemini-generate-content" },
    { providerId: "openrouter", modelId: "moonshotai/kimi-k3-thinking", protocol: "openai-chat" },
    { providerId: "openrouter", modelId: "qwen/qwen3.8-vl-max", protocol: "openai-chat" },
    { providerId: "groq", modelId: "llama-4.2-90b", protocol: "openai-chat" },
    { providerId: "openai-compatible", modelId: "my-org/private-finetune-v7", protocol: "openai-chat" },
  ] as const;

  it("resolves the same context, vision, tools and reasoning through the flat and exact paths", () => {
    for (const entry of matrix) {
      const exact = resolveProviderModelCapabilities(route({ providerId: entry.providerId, modelId: entry.modelId, protocol: entry.protocol }));
      const flat = resolveModelMetadata(entry.providerId, entry.modelId);
      const budget = resolveModelBudget({
        providerId: entry.providerId,
        selectedModel: entry.modelId,
        endpoint: { kind: "default", host: null, protocol: entry.protocol, limitTokens: null, limitSource: "unknown" },
      });
      const label = `${entry.providerId}/${entry.modelId}`;

      expect(exact.contextWindow.value, label).toBe(flat.contextWindow);
      expect(budget.nativeContextWindowTokens, label).toBe(flat.contextWindow);
      expect(exact.maxOutputTokens.value, label).toBe(flat.maxOutputTokens);
      // Vision: unknown on one side means "no claim", which the flat view can
      // only render as false. A KNOWN fact must agree exactly.
      if (exact.vision.state === "known") expect(exact.vision.value, label).toBe(flat.capabilities.vision);
      if (exact.request.tools.state === "known") {
        expect(exact.request.tools.value, label).toBe(flat.capabilities.toolCalls);
        // The request builder must reach the same conclusion, or a route would
        // be handed tools the resolver said it cannot take (or denied tools it
        // can).
        expect(resolveModelRequestCapabilities(entry.providerId, entry.modelId, entry.protocol).tools, label)
          .toBe(exact.request.tools.value ? "supported" : "unsupported");
      }
      expect(
        exact.reasoning.value?.efforts.map((effort) => effort.id) ?? [],
        label,
      ).toEqual(reasoningModesForRoute(resolveReasoningCapability(entry.providerId, entry.modelId)).map((mode) => mode.id));
    }
  });

  it("keeps request translation with the adapter rather than the model name", () => {
    // The same normalized selection reaches three different wire forms purely
    // from the route's declared dialect — no model id is consulted anywhere.
    const gemini = resolveProviderModelCapabilities(route({ providerId: "gemini", modelId: "gemini-3.7-flash", protocol: "gemini-generate-content" })).reasoning.value!;
    const deepseek = resolveProviderModelCapabilities(route({ providerId: "deepseek", modelId: "deepseek-v4-pro" })).reasoning.value!;
    const openai = resolveProviderModelCapabilities(route({ providerId: "openai", modelId: "gpt-5.6-sol" })).reasoning.value!;
    expect(translateReasoning({ mode: "effort", effort: "high" }, "gemini-generate-content", gemini))
      .toEqual({ ok: true, params: { thinkingConfig: { thinkingLevel: "high" } } });
    expect(translateReasoning({ mode: "effort", effort: "high" }, "openai-chat", deepseek))
      .toEqual({ ok: true, params: { reasoning_effort: "high", thinking: { type: "enabled" } } });
    expect(translateReasoning({ mode: "effort", effort: "high" }, "openai-chat", openai))
      .toEqual({ ok: true, params: { reasoning_effort: "high" } });
  });
});

describe("the external catalog is metadata, never routing permission", () => {
  it("keeps a model the database has never heard of fully usable", () => {
    const resolved = resolveProviderModelCapabilities(route({
      providerId: "openai-compatible",
      modelId: "my-org/private-finetune-v7",
      endpointKind: "custom",
      endpointHost: "llm.internal",
    }));
    expect(resolved.contextWindow.state).toBe("unknown");
    expect(resolved.reasoning.state).toBe("unknown");
    expect(resolved.route.modelId).toBe("my-org/private-finetune-v7");
    expect(resolveModelRequestCapabilities("openai-compatible", "my-org/private-finetune-v7", "openai-chat")).toEqual({
      tools: "unknown",
      toolChoice: "unknown",
      temperature: "unknown",
      streamUsage: "unknown",
      responseFormat: "unknown",
      maxOutputTokens: "unknown",
    });
  });

  it("does not let a database row claim a request field it never described", () => {
    // models.dev says nothing about tool_choice, stream_options or which
    // output-token field a route names. Those stay with the protocol baseline
    // the adapter owns, and never collapse to "unknown" because a broad
    // catalogue was silent.
    const resolved = resolveModelRequestCapabilities("groq", "llama-4.2-90b", "openai-chat");
    expect(resolved).toMatchObject({
      tools: "supported",
      temperature: "supported",
      toolChoice: "supported",
      streamUsage: "supported",
      maxOutputTokens: "max_tokens",
    });
  });
});

describe("a comprehensive snapshot stays workable", () => {
  it("installs and resolves out of a snapshot with thousands of rows", () => {
    const many: ModelInfo[] = [];
    const template = normalizeModelsDevDocument(MODELS_DEV_DOCUMENT, SNAPSHOT)[0]!;
    for (let index = 0; index < 5_000; index++) {
      many.push({ ...template, id: `bulk-${index}`, providerModelId: `bulk-${index}`, canonicalId: `bulk-${index}` });
    }
    installModelCatalog(mergeModelCatalog(BUILT_IN_MODELS, many));
    expect(listModels().length).toBeGreaterThan(5_000);
    expect(resolveModelMetadata("openrouter", "bulk-4999").contextWindow).toBe(template.contextWindow);
    // Bundled routes are untouched by the volume.
    expect(resolveModelMetadata("deepseek", "deepseek-v4-pro").contextWindow).toBe(1_000_000);
  });

  it("never promotes Morrow's own bundled seed rows into the external layer", () => {
    // A bundled snapshot means "no external metadata retrieved". Re-entering
    // seed rows as external metadata would float them above the corrections
    // they are supposed to sit beneath.
    expect(externalCatalogFromSnapshot({
      source: "bundled",
      catalogVersion: "bundled",
      generatedAt: SNAPSHOT.fetchedAt,
      models: [...BUILT_IN_MODELS],
    })).toBeNull();
    expect(externalCatalogFromSnapshot({
      source: "remote-cache",
      catalogVersion: SNAPSHOT.metadataVersion,
      generatedAt: SNAPSHOT.fetchedAt,
      models: normalizeModelsDevDocument(MODELS_DEV_DOCUMENT, SNAPSHOT),
    })?.lookup("openrouter", "moonshotai/kimi-k3-thinking")).toMatchObject({ kind: "exact" });
  });
});
