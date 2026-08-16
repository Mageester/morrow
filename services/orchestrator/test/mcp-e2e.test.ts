import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { McpPool } from "../src/mcp/pool.js";
import { mcpTrustStore } from "../src/mcp/trust.js";
import { executeMcpTool, isMcpTool } from "../src/mcp/tool-bridge.js";
import { encodeMessage } from "../src/mcp/framing.js";
import type { McpServerConfig } from "../src/mcp/config.js";

describe("MCP End-to-End Integration Suite", () => {
  let db: Database.Database;
  let sseServer: http.Server;
  let ssePort: number;
  let sseEndpointUrl: string;
  const activeSseClients = new Set<http.ServerResponse>();

  beforeEach(async () => {
    db = openDatabase(":memory:");
    activeSseClients.clear();

    // Spin up local HTTP/SSE mock server
    sseServer = http.createServer((req, res) => {
      if (req.url === "/sse" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        activeSseClients.add(res);
        req.on("close", () => activeSseClients.delete(res));
        res.write(`event: endpoint\ndata: http://127.0.0.1:${ssePort}/messages\n\n`);
      } else if (req.url === "/messages" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const parsed = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));

          const sendToAll = (msg: unknown) => {
            const raw = encodeMessage(msg);
            for (const client of activeSseClients) {
              client.write(`event: message\ndata: ${raw}\n\n`);
            }
          };

          if (parsed.method === "initialize") {
            sendToAll({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                protocolVersion: "2024-11-05",
                serverInfo: { name: "e2e-remote-mcp", version: "1.0.0" },
                capabilities: { tools: {}, resources: {} },
              },
            });
          } else if (parsed.method === "tools/list") {
            sendToAll({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                tools: [
                  {
                    name: "search_remote",
                    description: "Search remote knowledge base",
                    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
                  },
                  {
                    name: "create_record",
                    description: "Create record in remote knowledge base",
                    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
                  },
                ],
              },
            });
          } else if (parsed.method === "tools/call") {
            sendToAll({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                content: [{ type: "text", text: `Remote response for query: ${parsed.params.arguments.query}` }],
              },
            });
          } else if (parsed.method === "resources/list") {
            sendToAll({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                resources: [{ uri: "kb://docs/getting-started", name: "Getting Started Guide" }],
              },
            });
          } else if (parsed.method === "resources/read") {
            sendToAll({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                contents: [{ uri: parsed.params.uri, text: "Comprehensive guide to Morrow MCP" }],
              },
            });
          } else if (parsed.method === "ping") {
            sendToAll({ jsonrpc: "2.0", id: parsed.id, result: {} });
          }
        });
      }
    });

    await new Promise<void>((resolve) => {
      sseServer.listen(0, "127.0.0.1", () => {
        const addr = sseServer.address() as { port: number };
        ssePort = addr.port;
        sseEndpointUrl = `http://127.0.0.1:${ssePort}/sse`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    for (const client of activeSseClients) {
      client.end();
    }
    await new Promise<void>((resolve) => sseServer.close(() => resolve()));
    db.close();
  });

  it("orchestrates multi-transport discovery, tool execution, and resource reading", async () => {
    const sseConfig: McpServerConfig = {
      transport: "sse",
      url: sseEndpointUrl,
    };

    const trust = mcpTrustStore(db);
    trust.trustServer("remote_kb", sseConfig);

    const pool = new McpPool({ db });
    const configs: Record<string, McpServerConfig> = {
      remote_kb: sseConfig,
    };

    // 1. Tool discovery
    const toolsMap = await pool.listAllTools(configs);
    expect(toolsMap.has("mcp__remote_kb__search_remote")).toBe(true);
    expect(toolsMap.has("mcp__remote_kb__create_record")).toBe(true);

    const searchTool = toolsMap.get("mcp__remote_kb__search_remote")!;
    expect(searchTool.tool.description).toBe("Search remote knowledge base");

    // 2. Tool execution through bridge
    expect(isMcpTool("mcp__remote_kb__search_remote")).toBe(true);
    const execRes = await executeMcpTool("mcp__remote_kb__search_remote", { query: "local-first" }, pool, configs);
    expect(execRes.isError).toBe(false);
    expect(execRes.content).toBe("Remote response for query: local-first");

    // 3. Resource reading tool
    const resourceRes = await executeMcpTool(
      "read_mcp_resource",
      { server: "remote_kb", uri: "kb://docs/getting-started" },
      pool,
      configs
    );
    expect(resourceRes.isError).toBe(false);
    expect(resourceRes.content).toContain("Comprehensive guide to Morrow MCP");

    // 4. REST API server interaction
    const runner = new TaskRunner(db, async () => {});
    const app = buildServer({ db, runner });

    const listRes = await app.inject({ method: "GET", url: "/api/mcp/servers" });
    expect(listRes.statusCode).toBe(200);

    const testRes = await app.inject({
      method: "POST",
      url: "/api/mcp/test",
      payload: { serverId: "remote_kb", config: sseConfig },
    });
    expect(testRes.statusCode).toBe(200);
    const testBody = testRes.json();
    expect(testBody.ok).toBe(true);
    expect(testBody.tools.length).toBe(2);
    expect(testBody.resources.length).toBe(1);

    await app.close();
    await pool.closeAll();
  });
});
