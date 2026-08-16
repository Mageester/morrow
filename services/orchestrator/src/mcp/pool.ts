import type Database from "better-sqlite3";
import { McpClient, type McpTool, type McpResource, type McpResourceContent, type RawTransport } from "./client.js";
import { spawnStdioTransport } from "./stdio-transport.js";
import { createSseTransport } from "./sse-transport.js";
import { mcpTrustStore } from "./trust.js";
import type { McpServerConfig } from "./config.js";

export class UntrustedMcpServerError extends Error {
  constructor(public readonly serverId: string, message?: string) {
    super(message ?? `MCP server "${serverId}" has not been trusted yet. Please approve the server configuration first.`);
    this.name = "UntrustedMcpServerError";
  }
}

export interface McpPoolOptions {
  db: Database.Database;
  transportFactory?: (serverId: string, config: McpServerConfig) => RawTransport | Promise<RawTransport>;
  idleTimeoutMs?: number;
}

interface PooledClient {
  client: McpClient;
  lastUsedAt: number;
  config: McpServerConfig;
}

export class McpPool {
  private readonly clients = new Map<string, PooledClient>();
  private readonly connecting = new Map<string, Promise<McpClient>>();
  private readonly trust: ReturnType<typeof mcpTrustStore>;
  private readonly idleTimeoutMs: number;

  constructor(private readonly opts: McpPoolOptions) {
    this.trust = mcpTrustStore(opts.db);
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 15 * 60 * 1000; // 15 mins default
  }

  get activeCount(): number {
    return this.clients.size;
  }

  async getClient(serverId: string, config: McpServerConfig): Promise<McpClient> {
    const existing = this.clients.get(serverId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.client;
    }

    if (this.connecting.has(serverId)) {
      return this.connecting.get(serverId)!;
    }

    const connectPromise = (async () => {
      // Check trust before connecting
      if (!this.trust.isServerTrusted(serverId, config)) {
        throw new UntrustedMcpServerError(serverId);
      }

      let transport: RawTransport;
      if (this.opts.transportFactory) {
        transport = await this.opts.transportFactory(serverId, config);
      } else if (config.transport === "sse" || config.url) {
        if (!config.url) throw new Error(`MCP SSE server "${serverId}" is missing url`);
        transport = await createSseTransport(config.url, {
          headers: config.headers,
        });
      } else {
        if (!config.command) throw new Error(`MCP stdio server "${serverId}" is missing command`);
        const spawned = spawnStdioTransport(config.command, config.args ?? [], {
          cwd: config.cwd,
          env: config.env as any,
        });
        transport = spawned.transport;
      }

      const client = new McpClient(transport, {
        allowedTools: config.allowedTools,
      });

      await client.initialize();

      this.clients.set(serverId, {
        client,
        lastUsedAt: Date.now(),
        config,
      });

      return client;
    })().finally(() => {
      this.connecting.delete(serverId);
    });

    this.connecting.set(serverId, connectPromise);
    return connectPromise;
  }

  async listAllTools(
    configs: Record<string, McpServerConfig>
  ): Promise<Map<string, { serverId: string; tool: McpTool; rawName: string }>> {
    const toolMap = new Map<string, { serverId: string; tool: McpTool; rawName: string }>();

    for (const [serverId, config] of Object.entries(configs)) {
      if (config.disabled) continue;
      // If server is not yet trusted, skip tool discovery until user trusts it
      if (!this.trust.isServerTrusted(serverId, config)) continue;

      try {
        const client = await this.getClient(serverId, config);
        const tools = await client.listTools();
        for (const tool of tools) {
          const namespacedName = `mcp__${serverId}__${tool.name}`;
          toolMap.set(namespacedName, {
            serverId,
            tool,
            rawName: tool.name,
          });
        }
      } catch {
        // Skip unavailable servers without breaking overall catalog
      }
    }

    return toolMap;
  }

  async callNamespacedTool(
    namespacedName: string,
    args: unknown,
    configs: Record<string, McpServerConfig>
  ): Promise<unknown> {
    const match = namespacedName.match(/^mcp__([a-zA-Z0-9_-]+)__(.+)$/);
    if (!match) {
      throw new Error(`Invalid MCP namespaced tool name: ${namespacedName}`);
    }

    const [, serverId, rawToolName] = match;
    const config = configs[serverId!];
    if (!config) {
      throw new Error(`MCP server "${serverId}" is not configured`);
    }

    let client: McpClient;
    try {
      client = await this.getClient(serverId!, config);
    } catch (err: any) {
      if (err instanceof UntrustedMcpServerError) throw err;
      // If cached client errored, remove and retry once
      this.clients.delete(serverId!);
      client = await this.getClient(serverId!, config);
    }

    try {
      return await client.callTool(rawToolName!, args);
    } catch (err: any) {
      // If connection closed or pipe broken, try reconnecting once
      if (err.message && /closed|broken|disconnected|socket/i.test(err.message)) {
        this.clients.delete(serverId!);
        const retryClient = await this.getClient(serverId!, config);
        return await retryClient.callTool(rawToolName!, args);
      }
      throw err;
    }
  }

  async readResource(
    serverId: string,
    uri: string,
    configs: Record<string, McpServerConfig>
  ): Promise<{ contents: McpResourceContent[] }> {
    const config = configs[serverId];
    if (!config) {
      throw new Error(`MCP server "${serverId}" is not configured`);
    }
    const client = await this.getClient(serverId, config);
    return client.readResource(uri);
  }

  async testServer(
    serverId: string,
    config: McpServerConfig
  ): Promise<{ ok: boolean; tools: McpTool[]; resources: McpResource[]; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      let transport: RawTransport;
      if (this.opts.transportFactory) {
        transport = await this.opts.transportFactory(serverId, config);
      } else if (config.transport === "sse" || config.url) {
        if (!config.url) throw new Error("Missing SSE URL");
        transport = await createSseTransport(config.url, { headers: config.headers });
      } else {
        if (!config.command) throw new Error("Missing command");
        const spawned = spawnStdioTransport(config.command, config.args ?? [], {
          cwd: config.cwd,
          env: config.env as any,
        });
        transport = spawned.transport;
      }

      const client = new McpClient(transport, { allowedTools: config.allowedTools });
      await client.initialize();
      await client.ping();
      const tools = await client.listTools();
      const resources = await client.listResources();
      const latencyMs = Date.now() - start;
      client.close();

      return { ok: true, tools, resources, latencyMs };
    } catch (err: any) {
      return {
        ok: false,
        tools: [],
        resources: [],
        latencyMs: Date.now() - start,
        error: err?.message ?? String(err),
      };
    }
  }

  reapIdle(maxIdleMs = this.idleTimeoutMs): void {
    const now = Date.now();
    for (const [serverId, pooled] of this.clients.entries()) {
      if (now - pooled.lastUsedAt >= maxIdleMs) {
        pooled.client.close();
        this.clients.delete(serverId);
      }
    }
  }

  async closeAll(): Promise<void> {
    for (const pooled of this.clients.values()) {
      try {
        pooled.client.close();
      } catch {}
    }
    this.clients.clear();
  }
}
