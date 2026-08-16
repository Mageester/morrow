import { describe, expect, it } from "vitest";
import { ReasoningConfigurationSchema, RouteReasoningCapabilitySchema } from "@morrow/contracts";
import {
  capabilityFact,
  registerProviderModelCapabilityResolver,
  resolveProviderModelCapabilities,
  resolveModelCapabilities,
  unknownModelCapabilities,
  type CapabilityLayer,
  type ExactProviderRoute,
} from "../src/provider/model-capabilities.js";

const route: ExactProviderRoute = {
  providerId: "openai-compatible",
  modelId: "gateway/new-model",
  protocol: "openai-chat",
  endpointHost: "models.example.test",
  endpointIdentityHash: "route-hash",
  routeFingerprint: "fingerprint",
};

describe("provider-owned exact model capabilities", () => {
  it("keeps unknown IDs executable without inventing optional support", () => {
    const resolved = unknownModelCapabilities(route);

    expect(resolved.route).toEqual(route);
    expect(resolved.contextWindow.state).toBe("unknown");
    expect(resolved.request.tools.state).toBe("unknown");
    expect(resolved.reasoning.state).toBe("unknown");
  });

  it("merges facts by authority without letting omission erase a stronger fact", () => {
    const layers: CapabilityLayer[] = [
      {
        source: "route-config",
        capabilities: {
          contextWindow: capabilityFact(32_768, "route-config", "operator", "configured"),
          request: { tools: capabilityFact(true, "route-config", "operator", "configured") },
        },
      },
      {
        source: "provider-catalog",
        capabilities: {
          contextWindow: capabilityFact(128_000, "provider-catalog", "provider", "reported"),
          reasoning: capabilityFact({
            mode: "selectable",
            efforts: [
              { id: "think-8k", label: "8k thinking", wireValue: "8192" },
              { id: "think-max", label: "Maximum thinking", wireValue: "max" },
            ],
          }, "provider-catalog", "provider", "reported"),
        },
      },
      {
        source: "provider-reported",
        capabilities: {
          contextWindow: capabilityFact(200_000, "provider-reported", "provider", "verified"),
          // An omitted request fact is not a negative assertion.
          request: {},
        },
      },
    ];

    const resolved = resolveModelCapabilities(route, layers);
    expect(resolved.contextWindow).toMatchObject({
      state: "known",
      value: 200_000,
      source: "provider-reported",
    });
    expect(resolved.request.tools).toMatchObject({
      state: "known",
      value: true,
      source: "route-config",
    });
    expect(resolved.reasoning.value?.efforts.map((effort) => effort.id)).toEqual(["think-8k", "think-max"]);
  });

  it("lets an operator's exact-route restriction beat generic catalog metadata", () => {
    // The catalog is keyed on a model NAME and describes the vendor's flagship
    // deployment. An operator pointing Morrow at a smaller self-hosted or
    // gateway deployment of that same name has stated a fact about THIS route.
    // If the generic catalog outranked it, Morrow would build requests for a
    // context window the configured endpoint does not have.
    const resolved = resolveModelCapabilities(route, [
      {
        source: "provider-catalog",
        capabilities: {
          contextWindow: capabilityFact(400_000, "provider-catalog", "provider", "reported"),
          request: { toolChoice: capabilityFact(true, "provider-catalog", "provider", "reported") },
        },
      },
      {
        source: "route-config",
        capabilities: {
          contextWindow: capabilityFact(8_192, "route-config", "operator", "configured"),
          request: { toolChoice: capabilityFact(false, "route-config", "operator", "configured") },
        },
      },
    ]);

    expect(resolved.contextWindow).toMatchObject({ state: "known", value: 8_192, source: "route-config" });
    expect(resolved.request.toolChoice).toMatchObject({ state: "known", value: false, source: "route-config" });
  });

  it("still lets the endpoint's own report and deployment truth outrank operator config", () => {
    const resolved = resolveModelCapabilities(route, [
      { source: "route-config", capabilities: { contextWindow: capabilityFact(8_192, "route-config", "operator", "configured") } },
      { source: "provider-reported", capabilities: { contextWindow: capabilityFact(65_536, "provider-reported", "provider", "verified") } },
    ]);
    expect(resolved.contextWindow).toMatchObject({ value: 65_536, source: "provider-reported" });
  });

  it("preserves provider-defined reasoning IDs instead of coercing them to a global enum", () => {
    const resolved = resolveModelCapabilities(route, [{
      source: "adapter-native",
      capabilities: {
        reasoning: capabilityFact({
          mode: "selectable",
          efforts: [{ id: "budget:32768", label: "32k budget", wireValue: "32768" }],
          defaultId: "budget:32768",
        }, "adapter-native", "adapter", "verified"),
      },
    }]);

    expect(resolved.reasoning.value?.efforts[0]).toEqual({
      id: "budget:32768",
      label: "32k budget",
      wireValue: "32768",
    });
    expect(resolved.reasoning.value?.defaultId).toBe("budget:32768");
  });

  it("accepts opaque reasoning selections at the shared contract boundary", () => {
    expect(ReasoningConfigurationSchema.parse({ mode: "effort", effort: "budget:32768" })).toEqual({
      mode: "effort",
      effort: "budget:32768",
    });
    expect(RouteReasoningCapabilitySchema.parse({
      control: "effort",
      efforts: ["budget:32768"],
      budgets: [],
      source: "provider-metadata",
    }).efforts).toEqual(["budget:32768"]);
  });

  it("uses provider-owned catalogs for enrichment without restricting unknown IDs", () => {
    const known = resolveProviderModelCapabilities({
      ...route,
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      protocol: "openai-chat",
    });
    expect(known.contextWindow).toMatchObject({ state: "known", value: 1_000_000, source: "provider-catalog" });

    const unknown = resolveProviderModelCapabilities(route);
    expect(unknown.contextWindow.state).toBe("unknown");
    expect(unknown.route.modelId).toBe(route.modelId);
  });

  it("lets an exact adapter resolver override catalog facts for the active route", () => {
    const dispose = registerProviderModelCapabilityResolver("openai-compatible", (activeRoute) => ({
      source: "adapter-native",
      capabilities: {
        contextWindow: capabilityFact(512_000, "adapter-native", "adapter", "verified"),
        displayName: capabilityFact(`${activeRoute.modelId} (native)`, "adapter-native", "adapter", "verified"),
      },
    }));
    try {
      const resolved = resolveProviderModelCapabilities(route);
      expect(resolved.contextWindow.value).toBe(512_000);
      expect(resolved.displayName.value).toBe("gateway/new-model (native)");
    } finally {
      dispose();
    }
  });
});
