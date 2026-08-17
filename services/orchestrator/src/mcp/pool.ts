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

interface CachedDiscovery {
  tools: McpTool[];
  cachedAt: number;
  configHash: string;
}

const GLOBAL_DISCOVERY_CACHE = new Map<string, CachedDiscovery>();
const DISCOVERY_CACHE_TTL_MS = 60_000; // 60 seconds
const DISCOVERY_FAILURE_CACHE_TTL_MS = 30_000; // 30 seconds for failed/offline servers

export function clearMcpDiscoveryCache(serverId?: string): void {
  if (serverId) GLOBAL_DISCOVERY_CACHE.delete(serverId);
  else GLOBAL_DISCOVERY_CACHE.clear();
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
    configs: Record<string, McpServerConfig>,
    opts: { timeoutMs?: number; bypassCache?: boolean } = {}
  ): Promise<Map<string, { serverId: string; tool: McpTool; rawName: string }>> {
    const toolMap = new Map<string, { serverId: string; tool: McpTool; rawName: string }>();
    const timeoutMs = opts.timeoutMs ?? 2500; // 2.5s maximum discovery timeout per server
    const now = Date.now();

    const trustedEntries = Object.entries(configs).filter(([serverId, config]) => {
      if (config.disabled) return false;
      return this.trust.isServerTrusted(serverId, config);
    });

    if (trustedEntries.length === 0) return toolMap;

    const entriesToDiscover: Array<[string, McpServerConfig, string]> = [];

    for (const [serverId, config] of trustedEntries) {
      const configHash = JSON.stringify(config);
      const cached = GLOBAL_DISCOVERY_CACHE.get(serverId);
      const ttl = cached && cached.tools.length > 0 ? DISCOVERY_CACHE_TTL_MS : DISCOVERY_FAILURE_CACHE_TTL_MS;
      if (!opts.bypassCache && cached && cached.configHash === configHash && (now - cached.cachedAt) < ttl) {
        for (const tool of cached.tools) {
          const namespacedName = `mcp__${serverId}__${tool.name}`;
          toolMap.set(namespacedName, {
            serverId,
            tool,
            rawName: tool.name,
          });
        }
      } else {
        entriesToDiscover.push([serverId, config, configHash]);
      }
    }

    if (entriesToDiscover.length === 0) return toolMap;

    const results = await Promise.allSettled(
      entriesToDiscover.map(async ([serverId, config, configHash]) => {
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`MCP tool discovery for "${serverId}" timed out after ${timeoutMs}ms`)), timeoutMs);
          if (typeof timer?.unref === "function") timer.unref();
        });

        const discoverPromise = (async () => {
          const client = await this.getClient(serverId, config);
          return await client.listTools();
        })();

        try {
          const tools = await Promise.race([discoverPromise, timeoutPromise]);
          GLOBAL_DISCOVERY_CACHE.set(serverId, { tools, cachedAt: Date.now(), configHash });
          return { serverId, tools };
        } catch (err) {
          GLOBAL_DISCOVERY_CACHE.set(serverId, { tools: [], cachedAt: Date.now(), configHash });
          throw err;
        } finally {
          if (timer) clearTimeout(timer);
        }
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { serverId, tools } = result.value;
        for (const tool of tools) {
          const namespacedName = `mcp__${serverId}__${tool.name}`;
          toolMap.set(namespacedName, {
            serverId,
            tool,
            rawName: tool.name,
          });
        }
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
      try {
        await client.ping();
      } catch {
        /* ping is an optional protocol method */
      }
      let tools: McpTool[] = [];
      try {
        tools = await client.listTools();
      } catch {
        /* tools list optional */
      }
      let resources: McpResource[] = [];
      try {
        resources = await client.listResources();
      } catch {
        /* resources list optional */
      }
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
