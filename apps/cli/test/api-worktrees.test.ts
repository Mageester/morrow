import { afterEach, describe, expect, it, vi } from "vitest";
import { MorrowApi } from "../src/client/api.js";
import { SLASH_COMMANDS } from "../src/terminal/commands.js";

describe("MorrowApi worktrees", () => {
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

  it("hits the worktree routes with the right shapes", async () => {
    const calls = stubFetch({ ok: true });
    const api = new MorrowApi("http://127.0.0.1:9999");
    await api.createWorktree("p1", { name: "feature-x", taskId: "task-1", agentId: "agent-1", baseRef: "main" });
    await api.listWorktrees("p1", "active");
    await api.getWorktree("wt/one");
    await api.getWorktreeDiff("wt/one");
    await api.removeWorktree("wt/one", true);

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`)).toEqual([
      "POST /api/projects/p1/worktrees",
      "GET /api/projects/p1/worktrees?status=active",
      "GET /api/worktrees/wt%2Fone",
      "GET /api/worktrees/wt%2Fone/diff",
      "DELETE /api/worktrees/wt%2Fone?preserve=true",
    ]);
    expect(calls[0]!.body).toEqual({ name: "feature-x", taskId: "task-1", agentId: "agent-1", baseRef: "main" });
  });

  it("includes worktree ids when sending an agent message", async () => {
    const calls = stubFetch({ ok: true });
    const api = new MorrowApi("http://127.0.0.1:9999");
    await api.sendMessage("conv-1", "work here", { worktreeId: "wt-1" });

    expect(calls[0]!.body).toEqual({ content: "work here", worktreeId: "wt-1" });
  });

  it("registers /worktrees as a slash command", () => {
    expect(SLASH_COMMANDS.some((c) => c.name === "worktrees")).toBe(true);
  });
});
