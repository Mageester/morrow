import { describe, it, expect, vi, afterEach } from "vitest";
import { MorrowApi } from "../src/client/api.js";
import { SLASH_COMMANDS } from "../src/terminal/commands.js";

describe("MorrowApi.search", () => {
  afterEach(() => vi.restoreAllMocks());

  function stubFetch(payload: unknown) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );
    return calls;
  }

  it("builds a project-scoped query string with kinds, conversation, and limit", async () => {
    const body = { version: 1, query: "db", projectId: "p1", total: 0, hits: [] };
    const calls = stubFetch(body);
    const api = new MorrowApi("http://127.0.0.1:9999");
    const res = await api.search("p1", "db", { kinds: ["message", "memory"], conversationId: "c1", limit: 10 });
    expect(res.projectId).toBe("p1");
    const url = new URL(calls[0]!);
    expect(url.pathname).toBe("/api/projects/p1/search");
    expect(url.searchParams.get("q")).toBe("db");
    expect(url.searchParams.getAll("kind")).toEqual(["message", "memory"]);
    expect(url.searchParams.get("conversationId")).toBe("c1");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("encodes special characters in the query safely", async () => {
    const calls = stubFetch({ version: 1, query: "", projectId: "p1", total: 0, hits: [] });
    const api = new MorrowApi("http://127.0.0.1:9999");
    await api.search("p1", 'a b&c=d');
    const url = new URL(calls[0]!);
    expect(url.searchParams.get("q")).toBe("a b&c=d");
  });
});

describe("slash command registry", () => {
  it("registers /search so help and completion stay in sync", () => {
    const search = SLASH_COMMANDS.find((c) => c.name === "search");
    expect(search).toBeDefined();
    expect(search!.arg).toBe("<query>");
  });
});
