import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type Database from "better-sqlite3";

export interface McpServerPermissions {
  autoApprove?: string[];
  requireApproval?: string[];
}

export interface McpServerConfig {
  transport?: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
  allowedTools?: string[];
  permissions?: McpServerPermissions;
}

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

export function expandEnvVars(value: any, env: Record<string, string | undefined> = process.env): any {
  if (typeof value === "string") {
    return value.replace(/\$\{([a-zA-Z0-9_]+)\}|\$([a-zA-Z0-9_]+)/g, (_, braced, unbraced) => {
      const varName = braced || unbraced;
      return env[varName] ?? "";
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandEnvVars(item, env));
  }
  if (value && typeof value === "object") {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = expandEnvVars(v, env);
    }
    return result;
  }
  return value;
}

export function parseMcpConfigFile(filePath: string): Record<string, McpServerConfig> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as McpConfigFile;
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

export function parseMcpServerConfig(config: unknown): McpServerConfig | null {
  if (!config || typeof config !== "object") return null;
  const c = config as Record<string, any>;
  const transport = c.transport === "sse" ? "sse" : "stdio";
  return {
    transport,
    command: typeof c.command === "string" ? c.command : undefined,
    args: Array.isArray(c.args) ? c.args.map(String) : undefined,
    url: typeof c.url === "string" ? c.url : undefined,
    headers: c.headers && typeof c.headers === "object" ? c.headers : undefined,
    env: c.env && typeof c.env === "object" ? c.env : undefined,
    cwd: typeof c.cwd === "string" ? c.cwd : undefined,
    disabled: Boolean(c.disabled),
    allowedTools: Array.isArray(c.allowedTools) ? c.allowedTools.map(String) : undefined,
    permissions: c.permissions && typeof c.permissions === "object" ? c.permissions : undefined,
  };
}

export interface LoadMcpConfigOptions {
  workspaceRoot?: string;
  homeDir?: string;
  db?: Database.Database;
  processEnv?: Record<string, string | undefined>;
}

export function loadMcpConfig(opts: LoadMcpConfigOptions = {}): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = {};
  const env = opts.processEnv ?? process.env;

  // 1. Database-managed servers
  if (opts.db) {
    try {
      const rows = opts.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'mcp.server.%'").all() as Array<{ key: string; value: string }>;
      for (const row of rows) {
        const serverId = row.key.slice("mcp.server.".length);
        try {
          const parsed = JSON.parse(row.value);
          const serverConfig = parseMcpServerConfig(parsed);
          if (serverConfig) merged[serverId] = serverConfig;
        } catch {}
      }
    } catch {}
  }

  // 2. User-level ~/.morrow/mcp.json
  const userMcpPath = join(opts.homeDir ?? homedir(), ".morrow", "mcp.json");
  const userServers = parseMcpConfigFile(userMcpPath);
  for (const [id, srv] of Object.entries(userServers)) {
    const validated = parseMcpServerConfig(srv);
    if (validated) merged[id] = validated;
  }

  // 3. Workspace-level <workspace>/.morrow/mcp.json
  if (opts.workspaceRoot) {
    const wsMcpPath = join(opts.workspaceRoot, ".morrow", "mcp.json");
    const wsServers = parseMcpConfigFile(wsMcpPath);
    for (const [id, srv] of Object.entries(wsServers)) {
      const validated = parseMcpServerConfig(srv);
      if (validated) merged[id] = validated;
    }
  }

  // 4. Expand environment variables across configurations
  const finalConfigs: Record<string, McpServerConfig> = {};
  for (const [id, conf] of Object.entries(merged)) {
    if (conf.disabled) continue;
    finalConfigs[id] = expandEnvVars(conf, env);
  }

  return finalConfigs;
}
