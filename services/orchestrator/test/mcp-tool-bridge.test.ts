import { getEventListeners } from "node:events";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { McpPool } from "../src/mcp/pool.js";
import { mcpTrustStore } from "../src/mcp/trust.js";
import {
  buildMcpToolDefinitions,
  getReadMcpResourceToolDefinition,
  isMcpTool,
  executeMcpTool,
} from "../src/mcp/tool-bridge.js";
import type { McpServerConfig } from "../src/mcp/config.js";
import type { RawTransport, McpTool } from "../src/mcp/client.js";
import { encodeMessage, createMessageDecoder } from "../src/mcp/framing.js";

function fakeTransportFactory(tools: McpTool[] = []): () => RawTransport {
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
          else if (msg.method === "tools/call") {
            if (msg.params?.name === "fail_tool") {
              const errResp = encodeMessage({ jsonrpc: "2.0", id: msg.id, error: { message: "Simulated MCP tool crash" } });
              queueMicrotask(() => onData(errResp));
              return;
            }
            result = { content: [{ type: "text", text: `Tool result for ${msg.params?.name}: ${JSON.stringify(msg.params?.arguments)}` }] };
          } else if (msg.method === "resources/read") {
            result = { contents: [{ uri: msg.params?.uri, text: "Resource body text" }] };
          } else result = {};
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

describe("MCP Tool Bridge", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("identifies MCP tools and builds valid LLM ToolDefinitions", () => {
    expect(isMcpTool("mcp__github__create_issue")).toBe(true);
    expect(isMcpTool("read_mcp_resource")).toBe(true);
    expect(isMcpTool("read_file")).toBe(false);

    const resourceTool = getReadMcpResourceToolDefinition();
    expect(resourceTool.name).toBe("read_mcp_resource");
    expect(resourceTool.parameters.required).toContain("server");
    expect(resourceTool.parameters.required).toContain("uri");

    const toolsMap = new Map([
      [
        "mcp__sqlite__query",
        {
          serverId: "sqlite",
          rawName: "query",
          tool: {
            name: "query",
            description: "Run SQL query",
            inputSchema: {
              type: "object",
              properties: { sql: { type: "string" } },
              required: ["sql"],
            },
          },
        },
      ],
    ]);

    const defs = buildMcpToolDefinitions(toolsMap);
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe("mcp__sqlite__query");
    expect(defs[0]!.description).toContain("[MCP: sqlite]");
    expect((defs[0]!.parameters as any).properties.sql).toBeDefined();
  });

  it("executes namespaced MCP tools and returns formatted results", async () => {
    const trust = mcpTrustStore(db);
    const config: McpServerConfig = { command: "node", args: ["server.js"] };
    trust.trustServer("sqlite", config);

    const pool = new McpPool({
      db,
      transportFactory: () => fakeTransportFactory([{ name: "query" }])(),
    });

    const configs = { sqlite: config };

    const res = await executeMcpTool("mcp__sqlite__query", { sql: "SELECT 1;" }, pool, configs);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("Tool result for query");
    expect(res.content).toContain("SELECT 1;");
  });

  /**
   * The signal handed to every MCP tool call is the task's, built once in
   * `execution/agent.ts` and reused for the whole run. `{ once: true }` only
   * unregisters a listener that actually fires, and on the normal path the
   * abort never comes — so a listener per tool call stayed on that signal until
   * the task ended, each pinning its own rejection closure. A task that leans on
   * an MCP server accumulated one per call.
   */
  it("leaves no listener on the caller's abort signal after a tool call settles", async () => {
    const trust = mcpTrustStore(db);
    const config: McpServerConfig = { command: "node", args: ["server.js"] };
    trust.trustServer("sqlite", config);

    const pool = new McpPool({
      db,
      transportFactory: () => fakeTransportFactory([{ name: "query" }])(),
    });
    const configs = { sqlite: config };
    const taskSignal = new AbortController().signal;

    for (let call = 0; call < 5; call++) {
      const res = await executeMcpTool("mcp__sqlite__query", { sql: "SELECT 1;" }, pool, configs, taskSignal);
      expect(res.isError).toBeFalsy();
    }

    expect(getEventListeners(taskSignal, "abort")).toHaveLength(0);
  });

  it("executes read_mcp_resource and returns formatted resource contents", async () => {
    const trust = mcpTrustStore(db);
    const config: McpServerConfig = { command: "node", args: ["server.js"] };
    trust.trustServer("memo", config);

    const pool = new McpPool({
      db,
      transportFactory: () => fakeTransportFactory()(),
    });

    const configs = { memo: config };

    const res = await executeMcpTool(
      "read_mcp_resource",
      { server: "memo", uri: "memo://notes/sample" },
      pool,
      configs
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("Resource body text");
  });

  it("catches MCP tool errors cleanly without throwing unhandled exceptions", async () => {
    const trust = mcpTrustStore(db);
    const config: McpServerConfig = { command: "node", args: ["server.js"] };
    trust.trustServer("sqlite", config);

    const pool = new McpPool({
      db,
      transportFactory: () => fakeTransportFactory([{ name: "fail_tool" }])(),
    });

    const configs = { sqlite: config };

    const res = await executeMcpTool("mcp__sqlite__fail_tool", {}, pool, configs);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("MCP tool error");
    expect(res.content).toContain("Simulated MCP tool crash");
  });
});
