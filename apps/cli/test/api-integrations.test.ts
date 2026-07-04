import { afterEach, describe, expect, it, vi } from "vitest";
import { MorrowApi } from "../src/client/api.js";

describe("MorrowApi integrations", () => {
  afterEach(() => vi.restoreAllMocks());

  function stubFetch(payload: unknown) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: any) => {
        calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
        return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );
    return calls;
  }

  it("hits the integration routes with the right shapes", async () => {
    const calls = stubFetch({ ok: true });
    const api = new MorrowApi("http://127.0.0.1:9999");
    await api.checkIntegration("wt-1", { targetBranch: "main" });
    await api.listIntegrations("p1", "clean");
    await api.getIntegration("int-1");
    await api.applyIntegration("int-1");
    await api.cancelIntegration("int-1");

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`)).toEqual([
      "POST /api/worktrees/wt-1/integrations/check",
      "GET /api/projects/p1/integrations?status=clean",
      "GET /api/integrations/int-1",
      "POST /api/integrations/int-1/apply",
      "POST /api/integrations/int-1/cancel",
    ]);
    expect(calls[0]!.body).toEqual({ targetBranch: "main" });
  });
});
