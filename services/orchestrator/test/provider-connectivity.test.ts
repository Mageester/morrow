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
      headers: new Headers({ "content-length": "65537" }),
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
});
