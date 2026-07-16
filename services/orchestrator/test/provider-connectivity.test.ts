import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProviderModels, testProviderConnectivity } from "../src/provider/connectivity.js";

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

  it("discovers Codex OAuth model IDs from the account-specific endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }] }), { status: 200 })));
    const home = mkdtempSync(join(tmpdir(), "morrow-oauth-test-"));
    try {
      writeFileSync(join(home, "oauth.json"), JSON.stringify({ openai: { accessToken: "test-token", obtainedAt: Date.now() } }));
      const models = await discoverProviderModels("openai", { MORROW_HOME: home });
      expect(models).toEqual([
        expect.objectContaining({ providerId: "openai", authMode: "codex-oauth", providerModelId: "gpt-5.6-sol" }),
        expect.objectContaining({ providerId: "openai", authMode: "codex-oauth", providerModelId: "gpt-5.6-terra" }),
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
