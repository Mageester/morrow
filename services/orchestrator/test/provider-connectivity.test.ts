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
});
