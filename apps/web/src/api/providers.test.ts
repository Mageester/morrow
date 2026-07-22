import { afterEach, describe, expect, it, vi } from "vitest";
import { openRouterApi } from "./providers.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenRouter provider API", () => {
  it("sends a candidate key only to the configure endpoint and parses a secret-free response", async () => {
    const candidate = `synthetic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => Response.json({ ok: true, provider: "openrouter", status: null }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(openRouterApi.configure(candidate)).resolves.toMatchObject({ ok: true, provider: "openrouter" });

    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/api/providers/openrouter/configure");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ apiKey: candidate }));
  });

  it("uses no credential payload for test, refresh, or disconnect", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (path) => Response.json(
      String(path).endsWith("/credentials")
        ? { ok: true, provider: "openrouter", removed: true, status: null }
        : { id: "openrouter", ok: true, configured: true, status: 200, latencyMs: 12, checkedEndpoint: "openrouter.ai", detail: "Connected", errorKind: null, modelsSample: [], models: [] },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await openRouterApi.test();
    await openRouterApi.refresh();
    await openRouterApi.disconnect();

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/providers/openrouter/test",
      "/api/providers/openrouter/models/refresh",
      "/api/providers/openrouter/credentials",
    ]);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe("{}");
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe("{}");
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBeUndefined();
  });
});
