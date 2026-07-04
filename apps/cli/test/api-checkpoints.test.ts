import { afterEach, describe, expect, it, vi } from "vitest";
import { MorrowApi } from "../src/client/api.js";
import { SLASH_COMMANDS } from "../src/terminal/commands.js";

describe("MorrowApi checkpoints", () => {
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

  it("creates, lists, restores, and deletes against the project-scoped routes", async () => {
    const calls = stubFetch({ ok: true });
    const api = new MorrowApi("http://127.0.0.1:9999");
    await api.createCheckpoint("p1", { name: "before-x", files: ["a.ts"] });
    await api.listCheckpoints("p1");
    await api.restoreCheckpoint("p1", "before-x");
    await api.deleteCheckpoint("p1", "before-x");

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /api/projects/p1/checkpoints",
      "GET /api/projects/p1/checkpoints",
      "POST /api/projects/p1/checkpoints/before-x/restore",
      "DELETE /api/projects/p1/checkpoints/before-x",
    ]);
    expect(calls[0]!.body).toEqual({ name: "before-x", files: ["a.ts"] });
  });

  it("URL-encodes checkpoint names containing slashes (auto/pre-restore-…)", async () => {
    const calls = stubFetch({ ok: true });
    const api = new MorrowApi("http://127.0.0.1:9999");
    await api.restoreCheckpoint("p1", "auto/pre-restore-x-2026");
    expect(calls[0]!.url).toContain("/checkpoints/auto%2Fpre-restore-x-2026/restore");
  });

  it("is registered as a slash command", () => {
    expect(SLASH_COMMANDS.some((c) => c.name === "checkpoint")).toBe(true);
  });
});
