import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { McpClient, type RawTransport, type McpTool } from "../src/mcp/client.js";
import { encodeMessage, createMessageDecoder } from "../src/mcp/framing.js";
import { mcpTrustStore } from "../src/mcp/trust.js";

describe("framing", () => {
  it("round-trips a JSON-RPC message and buffers split chunks", () => {
    const decoder = createMessageDecoder();
    const wire = encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
    // Feed it in two pieces across the newline boundary.
    expect(decoder.push(wire.slice(0, 5))).toEqual([]);
    expect(decoder.push(wire.slice(5))).toEqual([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  });

  it("skips blank and malformed lines without throwing", () => {
    const decoder = createMessageDecoder();
    expect(decoder.push("\n{bad json}\n" + encodeMessage({ ok: true }))).toEqual([{ ok: true }]);
  });
});

/** An in-process MCP server: responds to initialize / tools/list / tools/call. */
function fakeMcpServer(tools: McpTool[]): RawTransport {
  let onData: (chunk: string) => void = () => {};
  const decoder = createMessageDecoder();
  return {
    write(data: string) {
      for (const raw of decoder.push(data)) {
        const msg = raw as { id: number; method: string; params?: any };
        let result: unknown;
        if (msg.method === "initialize") result = { protocolVersion: "2024-11-05", serverInfo: { name: "fake", version: "1.0.0" } };
        else if (msg.method === "tools/list") result = { tools };
        else if (msg.method === "tools/call") result = { content: [{ type: "text", text: `called ${msg.params?.name}` }] };
        else result = {};
        const response = encodeMessage({ jsonrpc: "2.0", id: msg.id, result });
        queueMicrotask(() => onData(response));
      }
    },
    onData(handler) {
      onData = handler;
    },
    close() {},
  };
}

describe("McpClient", () => {
  const tools: McpTool[] = [
    { name: "search", description: "search the web" },
    { name: "delete_everything", description: "dangerous" },
  ];

  it("initializes, lists tools, and calls a tool over the fake stdio transport", async () => {
    const client = new McpClient(fakeMcpServer(tools));
    await client.initialize();
    const listed = await client.listTools();
    expect(listed.map((t) => t.name)).toEqual(["search", "delete_everything"]);
    const result = (await client.callTool("search", { q: "morrow" })) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toBe("called search");
    client.close();
  });

  it("filters tools through an allow-list and refuses disallowed calls", async () => {
    const client = new McpClient(fakeMcpServer(tools), { allowedTools: ["search"] });
    await client.initialize();
    expect((await client.listTools()).map((t) => t.name)).toEqual(["search"]);
    await expect(client.callTool("delete_everything", {})).rejects.toThrow(/not allowed/i);
    client.close();
  });

  it("rejects requests after close", async () => {
    const client = new McpClient(fakeMcpServer(tools));
    client.close();
    await expect(client.initialize()).rejects.toThrow(/closed/i);
  });
});

describe("mcpTrustStore", () => {
  let db: Database.Database;
  beforeEach(() => (db = openDatabase(":memory:")));
  afterEach(() => db.close());

  it("trusts an exact command+args fingerprint and invalidates on change", () => {
    const trust = mcpTrustStore(db);
    expect(trust.isTrusted("srv", "node", ["server.js"])).toBe(false);
    trust.trust("srv", "node", ["server.js"]);
    expect(trust.isTrusted("srv", "node", ["server.js"])).toBe(true);
    // A changed command or args is no longer trusted.
    expect(trust.isTrusted("srv", "node", ["evil.js"])).toBe(false);
    expect(trust.isTrusted("srv", "bash", ["server.js"])).toBe(false);
    expect(trust.revoke("srv")).toBe(true);
    expect(trust.isTrusted("srv", "node", ["server.js"])).toBe(false);
  });
});
