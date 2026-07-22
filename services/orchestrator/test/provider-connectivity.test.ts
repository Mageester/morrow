import { afterEach, describe, expect, it, vi } from "vitest";
import { testProviderConnectivity } from "../src/provider/connectivity.js";

describe("provider connectivity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not read a provider response above the body limit", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(4 * 1024 * 1024 + 1) }),
      body: { cancel },
    }));

    const result = await testProviderConnectivity("openai", { OPENAI_API_KEY: "test-key" });

    expect(result).toMatchObject({ ok: true, configured: true, modelsSample: [] });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns normalized provider-reported metadata without truncating to the display sample", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      models: Array.from({ length: 8 }, (_, index) => ({
        name: `models/gemini-live-${index}`,
        displayName: `Gemini Live ${index}`,
        inputTokenLimit: 1_000_000 + index,
        outputTokenLimit: 65_536,
        supportedGenerationMethods: ["generateContent"],
      })),
    }), { status: 200 })));

    const result = await testProviderConnectivity("gemini", { GEMINI_API_KEY: "test-key" });

    expect(result.modelsSample).toHaveLength(5);
    expect(result.models).toHaveLength(8);
    expect(result.models[0]).toMatchObject({
      providerModelId: "gemini-live-0",
      displayName: "Gemini Live 0",
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
      metadataSource: "provider-reported",
    });
  });

  it("normalizes the rich OpenRouter model catalogue and deduplicates invalid records", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init: RequestInit) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/models/user");
      expect(init.headers).toMatchObject({ Authorization: "Bearer openrouter-test-value" });
      return new Response(JSON.stringify({ data: [
        {
          id: "anthropic/claude-sonnet-4",
          name: "Anthropic: Claude Sonnet 4",
          context_length: 200_000,
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          supported_parameters: ["tools", "tool_choice", "reasoning"],
          pricing: { prompt: "0.000003", completion: "0.000015" },
          top_provider: { max_completion_tokens: 64_000 },
          expiration_date: null,
        },
        { id: "anthropic/claude-sonnet-4", name: "duplicate" },
        { id: "free/model", name: "Free Model", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: [], pricing: { prompt: "0", completion: "0" } },
        { id: "", name: "malformed" },
        null,
      ] }), { status: 200 });
    }));

    const result = await testProviderConnectivity("openrouter", { OPENROUTER_API_KEY: "openrouter-test-value" });

    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({
      providerModelId: "anthropic/claude-sonnet-4",
      displayName: "Anthropic: Claude Sonnet 4",
      author: "anthropic",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      capabilities: { streaming: true, toolCalls: true, vision: true, reasoning: true },
      pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15, source: "provider-reported" },
      costType: "paid",
      availability: "available",
      metadataSource: "provider-reported",
    });
    expect(result.models[0]?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.models[1]).toMatchObject({ providerModelId: "free/model", costType: "free" });
  });

  it("uses OpenRouter's authenticated user catalogue so an invalid key cannot pass via the public catalogue", async () => {
    const fetchMock = vi.fn(async (url: string) => url === "https://openrouter.ai/api/v1/models/user"
      ? new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 })
      : new Response(JSON.stringify({ data: [{ id: "public/model" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testProviderConnectivity("openrouter", { OPENROUTER_API_KEY: "invalid-candidate" });

    expect(result).toMatchObject({ ok: false, configured: false, status: 401, errorKind: "auth" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/models/user");
  });

  it("rejects a 200 OpenRouter response that is not an authenticated user-catalogue schema", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [{ id: "public/model" }] }), { status: 200 })));
    const result = await testProviderConnectivity("openrouter", { OPENROUTER_API_KEY: "candidate" });
    expect(result).toMatchObject({ ok: false, configured: false, errorKind: "provider" });
  });

  it("classifies non-token OpenRouter charges and incomplete pricing conservatively", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: "vendor/request-paid", pricing: { prompt: "0", completion: "0", request: "0.01" } },
      { id: "vendor/image-paid", pricing: { prompt: "0", completion: "0", image: "0.001" } },
      { id: "vendor/incomplete", pricing: { prompt: "0" } },
      { id: "vendor/unknown-component", pricing: { prompt: "0", completion: "0", future_billable_dimension: "0" } },
      { id: "vendor/all-zero", pricing: { prompt: "0", completion: "0", request: "0", image: "0", web_search: "0", internal_reasoning: "0", input_cache_read: "0", input_cache_write: "0" } },
    ] }), { status: 200 })));

    const result = await testProviderConnectivity("openrouter", { OPENROUTER_API_KEY: "candidate" });
    const costs = Object.fromEntries(result.models.map((model) => [model.providerModelId, model.costType]));
    expect(costs).toMatchObject({
      "vendor/request-paid": "paid",
      "vendor/image-paid": "paid",
      "vendor/incomplete": "unknown",
      "vendor/unknown-component": "unknown",
      "vendor/all-zero": "free",
    });
  });

  it.each([
    [401, "auth"],
    [402, "provider"],
    [429, "rate_limit"],
    [502, "provider"],
    [503, "provider"],
  ] as const)("classifies OpenRouter HTTP %i without exposing the credential", async (status, errorKind) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { message: "rejected openrouter-secret-value" },
    }), { status })));

    const result = await testProviderConnectivity("openrouter", { OPENROUTER_API_KEY: "openrouter-secret-value" });

    expect(result).toMatchObject({ ok: false, configured: false, status, errorKind });
    expect(JSON.stringify(result)).not.toContain("openrouter-secret-value");
  });

  it("redacts the OpenRouter credential from network failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket failed for openrouter-secret-value"); }));
    const result = await testProviderConnectivity("openrouter", { OPENROUTER_API_KEY: "openrouter-secret-value" });
    expect(result.errorKind).toBe("network");
    expect(JSON.stringify(result)).not.toContain("openrouter-secret-value");
  });
});
