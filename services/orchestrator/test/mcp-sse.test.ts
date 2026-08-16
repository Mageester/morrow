import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createSseTransport } from "../src/mcp/sse-transport.js";
import { McpClient } from "../src/mcp/client.js";
import { encodeMessage } from "../src/mcp/framing.js";

describe("createSseTransport", () => {
  let server: Server;
  let serverPort: number;
  let sseResponse: ServerResponse | null = null;
  let receivedHeaders: Record<string, string | string[] | undefined> = {};
  let postBodies: any[] = [];

  beforeEach(async () => {
    postBodies = [];
    receivedHeaders = {};
    sseResponse = null;

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      receivedHeaders = req.headers;
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort}`);

      if (req.method === "GET" && url.pathname === "/sse") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        sseResponse = res;
        // Emit the endpoint event pointing to the message POST path
        res.write(`event: endpoint\ndata: /messages?session=test-123\n\n`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/messages") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const parsed = JSON.parse(body);
          postBodies.push(parsed);

          // Handle MCP JSON-RPC methods
          if (parsed.method === "initialize") {
            const resp = encodeMessage({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                protocolVersion: "2024-11-05",
                serverInfo: { name: "test-sse-server", version: "1.0.0" },
              },
            });
            sseResponse?.write(`event: message\ndata: ${resp}\n\n`);
          } else if (parsed.method === "tools/list") {
            const resp = encodeMessage({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                tools: [{ name: "remote_echo", description: "Echoes input" }],
              },
            });
            sseResponse?.write(`event: message\ndata: ${resp}\n\n`);
          } else if (parsed.method === "tools/call") {
            const resp = encodeMessage({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                content: [{ type: "text", text: `remote:${parsed.params?.arguments?.msg}` }],
              },
            });
            sseResponse?.write(`event: message\ndata: ${resp}\n\n`);
          } else if (parsed.method === "resources/list") {
            const resp = encodeMessage({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                resources: [{ uri: "memo://notes/1", name: "Memo Note 1" }],
              },
            });
            sseResponse?.write(`event: message\ndata: ${resp}\n\n`);
          } else if (parsed.method === "resources/read") {
            const resp = encodeMessage({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                contents: [{ uri: parsed.params?.uri, text: "Sample resource content" }],
              },
            });
            sseResponse?.write(`event: message\ndata: ${resp}\n\n`);
          }

          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        serverPort = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (sseResponse) {
      try { sseResponse.end(); } catch {}
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("connects to SSE endpoint, negotiates message path, and executes MCP tools", async () => {
    const transport = await createSseTransport(`http://127.0.0.1:${serverPort}/sse`, {
      headers: { Authorization: "Bearer test-token-xyz" },
    });

    const client = new McpClient(transport);
    await client.initialize();

    const tools = await client.listTools();
    expect(tools).toEqual([{ name: "remote_echo", description: "Echoes input" }]);

    const result = (await client.callTool("remote_echo", { msg: "hello-world" })) as any;
    expect(result.content[0].text).toBe("remote:hello-world");

    expect(receivedHeaders.authorization).toBe("Bearer test-token-xyz");

    client.close();
  });

  it("reads resources over SSE client", async () => {
    const transport = await createSseTransport(`http://127.0.0.1:${serverPort}/sse`);
    const client = new McpClient(transport);
    await client.initialize();

    const resources = await client.listResources();
    expect(resources).toEqual([{ uri: "memo://notes/1", name: "Memo Note 1" }]);

    const read = await client.readResource("memo://notes/1");
    expect(read.contents[0]!.text).toBe("Sample resource content");

    client.close();
  });
});
