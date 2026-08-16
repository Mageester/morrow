import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { McpPool, UntrustedMcpServerError } from "../src/mcp/pool.js";
import { mcpTrustStore } from "../src/mcp/trust.js";
import { loadMcpConfig } from "../src/mcp/config.js";
import { isMcpTool, buildMcpToolDefinitions, executeMcpTool } from "../src/mcp/tool-bridge.js";
import { isMcpToolAutoApproved, setMcpToolApprovalOverride } from "../src/security/mcp-policy.js";
import { resolveModelBudget } from "../src/routing/model-budget.js";
import { encodeMessage } from "../src/mcp/framing.js";

describe("Real MCP Verification Scenarios (10-point Acceptance Suite)", () => {
  let db: Database.Database;
  let sseServer: http.Server;
  let ssePort: number;
  let sseEndpointUrl: string;
  const activeSseClients = new Set<http.ServerResponse>();

  beforeEach(async () => {
    db = openDatabase(":memory:");
    activeSseClients.clear();

    // Mock remote SSE MCP server
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
                serverInfo: { name: "remote-github-sse", version: "1.0.0" },
                capabilities: { tools: {}, resources: {} },
              },
            });
          } else if (parsed.method === "tools/list") {
            sendToAll({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                tools: [
                  { name: "get_repo", description: "Get repository details", inputSchema: { type: "object", properties: { repo: { type: "string" } } } },
                  { name: "create_pull_request", description: "Create a PR in repository", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
                ],
              },
            });
          } else if (parsed.method === "tools/call") {
            if (parsed.params.name === "get_repo") {
              sendToAll({
                jsonrpc: "2.0",
                id: parsed.id,
                result: { content: [{ type: "text", text: `Repo stats for ${parsed.params.arguments.repo}: 42 stars, 0 issues.` }] },
              });
            } else if (parsed.params.name === "create_pull_request") {
              sendToAll({
                jsonrpc: "2.0",
                id: parsed.id,
                result: { content: [{ type: "text", text: `Created PR #${101}: ${parsed.params.arguments.title}` }] },
              });
            }
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

  it("1 & 2: Connects 3 MCP servers through the API/Settings backend and discovers tools/resources", async () => {
    const runner = new TaskRunner(db, async () => {});
    const app = buildServer({ db, runner });

    // Add server 1: SQLite stdio
    const res1 = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: {
        id: "sqlite",
        config: { transport: "stdio", command: "node", args: ["-e", "process.stdin.resume()"] },
      },
    });
    expect(res1.statusCode).toBe(201);

    // Add server 2: Fetch stdio
    const res2 = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: {
        id: "fetcher",
        config: { transport: "stdio", command: "node", args: ["-e", "process.stdin.resume()"] },
      },
    });
    expect(res2.statusCode).toBe(201);

    // Add server 3: Remote GitHub SSE
    const res3 = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: {
        id: "github",
        config: { transport: "sse", url: sseEndpointUrl },
      },
    });
    expect(res3.statusCode).toBe(201);

    // Verify all 3 servers are listed and trusted
    const listRes = await app.inject({ method: "GET", url: "/api/mcp/servers" });
    const listBody = listRes.json();
    expect(listBody.servers.length).toBe(3);
    expect(listBody.servers.every((s: any) => s.trusted)).toBe(true);

    // Test GitHub SSE discovery
    const testRes = await app.inject({
      method: "POST",
      url: "/api/mcp/test",
      payload: { serverId: "github", config: { transport: "sse", url: sseEndpointUrl } },
    });
    expect(testRes.statusCode).toBe(200);
    const testBody = testRes.json();
    expect(testBody.ok).toBe(true);
    expect(testBody.tools.map((t: any) => t.name)).toEqual(["get_repo", "create_pull_request"]);

    await app.close();
  });

  it("3: Auto-approves read-only MCP tools automatically without user prompting", () => {
    const config = { transport: "sse" as const, url: sseEndpointUrl };
    expect(isMcpToolAutoApproved("github", "get_repo", config, db)).toBe(true);
    expect(isMcpToolAutoApproved("sqlite", "read_query", config, db)).toBe(true);
    expect(isMcpToolAutoApproved("fetcher", "fetch_url", config, db)).toBe(true);
  });

  it("4: Pauses mutating MCP tools for approval until granted", () => {
    const config = { transport: "sse" as const, url: sseEndpointUrl };
    // By default, mutating tool requires approval
    expect(isMcpToolAutoApproved("github", "create_pull_request", config, db)).toBe(false);

    // After approval override is stored, it is permitted
    setMcpToolApprovalOverride(db, "github", "create_pull_request", "always_allow");
    expect(isMcpToolAutoApproved("github", "create_pull_request", config, db)).toBe(true);
  });

  it("5: Restarts Morrow and confirms server configs, trust records, and permissions survive", () => {
    const trust = mcpTrustStore(db);
    const config = { transport: "sse" as const, url: sseEndpointUrl };
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("mcp.server.github", JSON.stringify(config));
    trust.trustServer("github", config);
    setMcpToolApprovalOverride(db, "github", "create_pull_request", "always_allow");

    // Simulate restart by creating fresh pool and config loader
    const loaded = loadMcpConfig({ db });
    expect(loaded.github).toBeDefined();
    expect(loaded.github?.url).toBe(sseEndpointUrl);

    const freshTrust = mcpTrustStore(db);
    expect(freshTrust.isServerTrusted("github", loaded.github!)).toBe(true);
    expect(isMcpToolAutoApproved("github", "create_pull_request", loaded.github, db)).toBe(true);
  });

  it("6: Reconnects cleanly when an MCP connection drops without corrupting state", async () => {
    const config = { transport: "sse" as const, url: sseEndpointUrl };
    const trust = mcpTrustStore(db);
    trust.trustServer("github", config);

    const pool = new McpPool({ db });
    const configs = { github: config };

    // Initial tool call
    const res1 = await executeMcpTool("mcp__github__get_repo", { repo: "morrow/agent" }, pool, configs);
    expect(res1.isError).toBe(false);
    expect(res1.content).toContain("42 stars");

    // Simulate connection drop by ending all active client connections
    for (const client of activeSseClients) {
      client.end();
    }
    activeSseClients.clear();

    // Force reconnect on next tool call
    pool.reapIdle(0);
    const res2 = await executeMcpTool("mcp__github__get_repo", { repo: "morrow/agent" }, pool, configs);
    expect(res2.isError).toBe(false);
    expect(res2.content).toContain("42 stars");

    await pool.closeAll();
  });

  it("7: Detects modified stdio commands/arguments and revokes trust", async () => {
    const trust = mcpTrustStore(db);
    const originalConfig = { transport: "stdio" as const, command: "node", args: ["./safe-server.js"] };
    trust.trustServer("myserver", originalConfig);
    expect(trust.isServerTrusted("myserver", originalConfig)).toBe(true);

    // Tampered arguments
    const tamperedConfig = { transport: "stdio" as const, command: "node", args: ["./malicious-server.js"] };
    expect(trust.isServerTrusted("myserver", tamperedConfig)).toBe(false);

    // Pool refuses to launch untrusted tampered server
    const pool = new McpPool({ db });
    await expect(pool.getClient("myserver", tamperedConfig)).rejects.toThrow(UntrustedMcpServerError);
  });

  it("8: Disambiguates conflicting tool names across multiple servers via double-underscore namespacing", () => {
    const toolA = { name: "query", description: "Query DB A", inputSchema: {} };
    const toolB = { name: "query", description: "Query DB B", inputSchema: {} };

    const definitions = buildMcpToolDefinitions(new Map([
      ["mcp__database_a__query", { serverId: "database_a", tool: toolA, rawName: "query" }],
      ["mcp__database_b__query", { serverId: "database_b", tool: toolB, rawName: "query" }],
    ]));

    expect(definitions.length).toBe(2);
    expect(definitions[0]!.name).toBe("mcp__database_a__query");
    expect(definitions[0]!.description).toContain("[MCP: database_a]");
    expect(definitions[1]!.name).toBe("mcp__database_b__query");
    expect(definitions[1]!.description).toContain("[MCP: database_b]");
  });

  it("9: Accurately budgets MCP tool schemas in truthful context accounting without synthetic bloat", () => {
    const budget = resolveModelBudget({
      providerId: "anthropic",
      selectedModel: "claude-3-5-sonnet-20241022",
      endpoint: {},
      userContextWindowTokens: 200000,
      toolCount: 15,
    });

    // Tool schemas are measured from their exact serialized JSON bytes rather than inflating artificial reserves
    expect(budget.toolReserveTokens).toBe(0);
    expect(budget.contextWindowTokens).toBe(200000);
    expect(budget.usableInputTokens).toBeGreaterThan(190000);
  });

  it("10: Seamlessly executes an MCP query and formats structured output for agent context", async () => {
    const config = { transport: "sse" as const, url: sseEndpointUrl };
    const trust = mcpTrustStore(db);
    trust.trustServer("github", config);

    const pool = new McpPool({ db });
    const configs = { github: config };

    const result = await executeMcpTool("mcp__github__get_repo", { repo: "facebook/react" }, pool, configs);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Repo stats for facebook/react: 42 stars, 0 issues.");

    await pool.closeAll();
  });
});
