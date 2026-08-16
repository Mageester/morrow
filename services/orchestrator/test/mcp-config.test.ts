import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadMcpConfig, parseMcpServerConfig, expandEnvVars, type McpServerConfig } from "../src/mcp/config.js";
import { mcpTrustStore } from "../src/mcp/trust.js";

describe("expandEnvVars", () => {
  it("expands ${VAR} and $VAR in strings, arrays, and objects", () => {
    const env = { API_KEY: "secret-123", DB_NAME: "mydb" };
    expect(expandEnvVars("Bearer ${API_KEY}", env)).toBe("Bearer secret-123");
    expect(expandEnvVars("http://localhost/$DB_NAME", env)).toBe("http://localhost/mydb");
    expect(expandEnvVars(["--key", "${API_KEY}"], env)).toEqual(["--key", "secret-123"]);
    expect(expandEnvVars({ Authorization: "Bearer ${API_KEY}" }, env)).toEqual({ Authorization: "Bearer secret-123" });
  });

  it("leaves unknown variables untouched or empty", () => {
    expect(expandEnvVars("Bearer ${UNKNOWN_VAR}", {})).toBe("Bearer ");
  });
});

describe("loadMcpConfig", () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = join(tmpdir(), `morrow-mcp-test-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it("discovers and parses workspace and user mcp.json configs with correct precedence", () => {
    const userDir = join(tempDir, "user");
    const workspaceDir = join(tempDir, "workspace");
    mkdirSync(join(userDir, ".morrow"), { recursive: true });
    mkdirSync(join(workspaceDir, ".morrow"), { recursive: true });

    // User level config defines 'sqlite' and 'global_tool'
    writeFileSync(
      join(userDir, ".morrow", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          sqlite: {
            command: "uvx",
            args: ["mcp-server-sqlite", "--db-path", "/user/db.sqlite"],
          },
          global_tool: {
            url: "https://global.mcp.example/sse",
            transport: "sse",
          },
        },
      })
    );

    // Workspace level config overrides 'sqlite' and adds 'project_tool'
    writeFileSync(
      join(workspaceDir, ".morrow", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          sqlite: {
            command: "uvx",
            args: ["mcp-server-sqlite", "--db-path", "./local.db"],
          },
          project_tool: {
            command: "node",
            args: ["./tool.js"],
          },
        },
      })
    );

    const config = loadMcpConfig({
      workspaceRoot: workspaceDir,
      homeDir: userDir,
      db,
    });

    expect(Object.keys(config).sort()).toEqual(["global_tool", "project_tool", "sqlite"]);
    // Workspace overrides user config for 'sqlite'
    expect(config.sqlite?.args).toEqual(["mcp-server-sqlite", "--db-path", "./local.db"]);
    expect(config.global_tool?.transport).toBe("sse");
    expect(config.project_tool?.command).toBe("node");
  });
});

describe("mcpTrustStore extended", () => {
  let db: Database.Database;
  beforeEach(() => (db = openDatabase(":memory:")));
  afterEach(() => db.close());

  it("trusts and verifies stdio and sse server configurations", () => {
    const trust = mcpTrustStore(db);
    const stdioConfig: McpServerConfig = {
      command: "node",
      args: ["server.js"],
    };
    const sseConfig: McpServerConfig = {
      transport: "sse",
      url: "https://example.com/sse",
    };

    expect(trust.isServerTrusted("srv1", stdioConfig)).toBe(false);
    trust.trustServer("srv1", stdioConfig);
    expect(trust.isServerTrusted("srv1", stdioConfig)).toBe(true);

    // Modifying args breaks trust
    expect(trust.isServerTrusted("srv1", { ...stdioConfig, args: ["evil.js"] })).toBe(false);

    // SSE trust
    expect(trust.isServerTrusted("srv2", sseConfig)).toBe(false);
    trust.trustServer("srv2", sseConfig);
    expect(trust.isServerTrusted("srv2", sseConfig)).toBe(true);
    expect(trust.isServerTrusted("srv2", { ...sseConfig, url: "https://evil.com/sse" })).toBe(false);
  });
});
