import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@morrow/contracts";
import {
  reasoningCapabilityFromSupportedParameters,
  requestCapabilitiesFromSupportedParameters,
} from "../src/routing/request-capabilities.js";
import { installModelCatalog, listModels, resolveModelRequestCapabilities } from "../src/routing/models.js";

function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    version: 1,
    id: "custom-model",
    providerModelId: "custom-model",
    canonicalId: "custom-model",
    aliases: [],
    providerId: "openai-compatible",
    label: "Custom model",
    family: null,
    generation: null,
    lifecycle: "custom",
    contextWindow: null,
    maxOutputTokens: null,
    pricing: null,
    tokenUsage: true,
    streamingUsage: true,
    capabilities: { streaming: true, toolCalls: true, vision: false },
    capabilitySource: "provider-reported",
    speedClass: "unknown",
    costClass: "unknown",
    privacy: "remote",
    builtIn: false,
    metadataSource: "provider-reported",
    confidence: "reported",
    ...overrides,
  };
}

describe("provider request capability contract", () => {
  it("normalizes supported_parameters into explicit wire-field support", () => {
    expect(requestCapabilitiesFromSupportedParameters([
      "tools",
      "tool_choice",
      "temperature",
      "stream_options",
      "response_format",
      "max_completion_tokens",
    ])).toEqual({
      tools: "supported",
      toolChoice: "supported",
      temperature: "supported",
      streamUsage: "supported",
      responseFormat: "supported",
      maxOutputTokens: "max_completion_tokens",
    });
  });

  it("treats a non-empty provider parameter list as authoritative for omitted optional fields", () => {
    expect(requestCapabilitiesFromSupportedParameters(["tools"])).toEqual({
      tools: "supported",
      toolChoice: "unsupported",
      temperature: "unsupported",
      streamUsage: "unsupported",
      responseFormat: "unsupported",
      maxOutputTokens: "unknown",
    });
  });

  it("only advertises tunable reasoning when the provider names a reasoning control", () => {
    // `supported_parameters` names request FIELDS, never their accepted values.
    // An effort field therefore proves the route is tunable and nothing more:
    // the levels stay empty rather than being filled with an invented
    // low/medium/high ladder a gateway may not accept, and the wire dialect
    // stays undeclared rather than being guessed from a generic field name.
    expect(reasoningCapabilityFromSupportedParameters(["reasoning_effort", "thinking"])).toEqual({
      control: "effort",
      efforts: [],
      budgets: [],
      source: "provider-metadata",
    });
    // Only an explicitly named disable field earns a claim that reasoning can
    // be turned off; "thinking" alone does not spell how to disable it.
    expect(reasoningCapabilityFromSupportedParameters(["reasoning_effort", "disable_thinking"])).toEqual({
      control: "effort",
      efforts: [],
      budgets: [],
      source: "provider-metadata",
      supportsOff: true,
    });
    expect(reasoningCapabilityFromSupportedParameters(["include_reasoning"])).toEqual({
      control: "fixed",
      efforts: [],
      budgets: [],
      source: "provider-metadata",
    });
  });

  it("does not let silent discovery erase a verified model contract", () => {
    const original = listModels();
    try {
      installModelCatalog([model({
        requestCapabilities: {
          tools: "supported",
          toolChoice: "supported",
          temperature: "supported",
          streamUsage: "supported",
          responseFormat: "supported",
          maxOutputTokens: "max_completion_tokens",
        },
      })]);
      const resolved = resolveModelRequestCapabilities("openai-compatible", "custom-model", "openai-chat");
      expect(resolved).toEqual({
        tools: "supported",
        toolChoice: "supported",
        temperature: "supported",
        streamUsage: "supported",
        responseFormat: "supported",
        maxOutputTokens: "max_completion_tokens",
      });
    } finally {
      installModelCatalog(original);
    }
  });

  it("keeps unknown models honest instead of claiming every optional argument is valid", () => {
    const resolved = resolveModelRequestCapabilities("openai-compatible", "never-seen-model", "openai-chat");
    expect(resolved).toEqual({
      tools: "unknown",
      toolChoice: "unknown",
      temperature: "unknown",
      streamUsage: "unknown",
      responseFormat: "unknown",
      maxOutputTokens: "unknown",
    });
  });
});
