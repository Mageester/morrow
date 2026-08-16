import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { McpPool, UntrustedMcpServerError } from "../src/mcp/pool.js";
import { mcpTrustStore } from "../src/mcp/trust.js";
import type { McpServerConfig } from "../src/mcp/config.js";
import type { RawTransport, McpTool } from "../src/mcp/client.js";
import { encodeMessage, createMessageDecoder } from "../src/mcp/framing.js";

function fakeTransportFactory(tools: McpTool[] = [{ name: "test_tool", description: "test desc" }]): () => RawTransport {
  return () => {
    let onData: (chunk: string) => void = () => {};
    const decoder = createMessageDecoder();
    return {
      write(data: string) {
        for (const raw of decoder.push(data)) {
          const msg = raw as { id: number; method: string; params?: any };
          let result: unknown;
          if (msg.method === "initialize") result = { protocolVersion: "2024-11-05", serverInfo: { name: "fake", version: "1.0.0" } };
          else if (msg.method === "ping") result = {};
          else if (msg.method === "tools/list") result = { tools };
          else if (msg.method === "tools/call") result = { content: [{ type: "text", text: `result:${msg.params?.name}` }] };
          else if (msg.method === "resources/list") result = { resources: [] };
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
  };
}

describe("McpPool", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("throws UntrustedMcpServerError when server is not trusted", async () => {
    const pool = new McpPool({ db });
    const config: McpServerConfig = {
      command: "node",
      args: ["untrusted.js"],
    };

    await expect(pool.getClient("untrusted_srv", config)).rejects.toThrow(UntrustedMcpServerError);
  });

  it("initializes trusted server, pools connection, and maps namespaced tools", async () => {
    const trust = mcpTrustStore(db);
    const config: McpServerConfig = {
      command: "node",
      args: ["server.js"],
    };
    trust.trustServer("mysrv", config);

    const fakeFactory = fakeTransportFactory([
      { name: "read_items", description: "Reads items" },
      { name: "write_items", description: "Writes items" },
    ]);

    const pool = new McpPool({
      db,
      transportFactory: (_id, _cfg) => fakeFactory(),
    });

    const client1 = await pool.getClient("mysrv", config);
    const client2 = await pool.getClient("mysrv", config);
    expect(client1).toBe(client2); // Pooled singleton

    const toolsMap = await pool.listAllTools({ mysrv: config });
    expect(toolsMap.has("mcp__mysrv__read_items")).toBe(true);
    expect(toolsMap.has("mcp__mysrv__write_items")).toBe(true);

    const result = await pool.callNamespacedTool("mcp__mysrv__read_items", { foo: "bar" }, { mysrv: config }) as any;
    expect(result.content[0].text).toBe("result:read_items");

    await pool.closeAll();
  });

  it("reaps idle clients after timeout", async () => {
    const trust = mcpTrustStore(db);
    const config: McpServerConfig = { command: "node", args: ["server.js"] };
    trust.trustServer("mysrv", config);

    const fakeFactory = fakeTransportFactory();
    const pool = new McpPool({
      db,
      transportFactory: () => fakeFactory(),
    });

    await pool.getClient("mysrv", config);
    expect(pool.activeCount).toBe(1);

    // Reap with 0ms idle time
    pool.reapIdle(-1);
    expect(pool.activeCount).toBe(0);
  });

  it("tests server connectivity and measures latency", async () => {
    const config: McpServerConfig = { command: "node", args: ["server.js"] };
    const fakeFactory = fakeTransportFactory([{ name: "echo" }]);
    const pool = new McpPool({
      db,
      transportFactory: () => fakeFactory(),
    });

    const testRes = await pool.testServer("mysrv", config);
    expect(testRes.ok).toBe(true);
    expect(testRes.tools).toHaveLength(1);
    expect(testRes.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
