import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { McpServerConfig } from "./config.js";

/**
 * Trust records for MCP servers. An MCP server is an external process or remote endpoint,
 * so it is only auto-startable once the user has explicitly trusted it.
 * Trust binds to a fingerprint of the exact command + args (for stdio) or URL (for SSE) —
 * if either changes, the old trust no longer matches and the server must be re-approved.
 * Records live in the existing `settings` table under an `mcp.trust.<id>` key.
 */
export function mcpTrustStore(db: Database.Database) {
  const key = (serverId: string) => `mcp.trust.${serverId}`;

  const fingerprint = (command: string, args: string[] = []) =>
    createHash("sha256").update(JSON.stringify([command, args])).digest("hex");

  const fingerprintServer = (config: McpServerConfig) => {
    if (config.transport === "sse" || config.url) {
      return createHash("sha256").update(JSON.stringify(["sse", config.url ?? ""])).digest("hex");
    }
    return fingerprint(config.command ?? "", config.args ?? []);
  };

  return {
    fingerprint,
    fingerprintServer,
    trust(serverId: string, command: string, args: string[] = []): void {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key(serverId), fingerprint(command, args));
    },
    trustServer(serverId: string, config: McpServerConfig): void {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key(serverId), fingerprintServer(config));
    },
    isTrusted(serverId: string, command: string, args: string[] = []): boolean {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key(serverId)) as { value: string } | undefined;
      return row?.value === fingerprint(command, args);
    },
    isServerTrusted(serverId: string, config: McpServerConfig): boolean {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key(serverId)) as { value: string } | undefined;
      return row?.value === fingerprintServer(config);
    },
    revoke(serverId: string): boolean {
      return db.prepare("DELETE FROM settings WHERE key = ?").run(key(serverId)).changes > 0;
    },
  };
}
