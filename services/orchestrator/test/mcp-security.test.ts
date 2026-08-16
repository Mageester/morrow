import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { evaluateMcpToolPermission, setMcpToolApprovalOverride, isMcpToolAutoApproved } from "../src/security/mcp-policy.js";
import type { McpServerConfig } from "../src/mcp/config.js";

describe("evaluateMcpToolPermission", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("auto-approves read-only tools by default heuristics", () => {
    const config: McpServerConfig = { command: "node", args: ["server.js"] };
    expect(isMcpToolAutoApproved("sqlite", "read_query", config, db)).toBe(true);
    expect(isMcpToolAutoApproved("sqlite", "get_schema", config, db)).toBe(true);
    expect(isMcpToolAutoApproved("sqlite", "list_tables", config, db)).toBe(true);
    expect(isMcpToolAutoApproved("sqlite", "search_records", config, db)).toBe(true);
  });

  it("requires approval for mutating/action tools by default", () => {
    const config: McpServerConfig = { command: "node", args: ["server.js"] };
    expect(isMcpToolAutoApproved("sqlite", "write_query", config, db)).toBe(false);
    expect(isMcpToolAutoApproved("github", "create_issue", config, db)).toBe(false);
    expect(isMcpToolAutoApproved("github", "delete_branch", config, db)).toBe(false);
    expect(isMcpToolAutoApproved("github", "post_comment", config, db)).toBe(false);
  });

  it("respects explicit autoApprove and requireApproval config rules", () => {
    const config: McpServerConfig = {
      command: "node",
      args: ["server.js"],
      permissions: {
        autoApprove: ["write_query"],
        requireApproval: ["read_query"],
      },
    };
    expect(isMcpToolAutoApproved("sqlite", "write_query", config, db)).toBe(true);
    expect(isMcpToolAutoApproved("sqlite", "read_query", config, db)).toBe(false);
  });

  it("honors persistent user overrides in database settings", () => {
    const config: McpServerConfig = { command: "node", args: ["server.js"] };
    expect(isMcpToolAutoApproved("github", "create_issue", config, db)).toBe(false);

    setMcpToolApprovalOverride(db, "github", "create_issue", "always_allow");
    expect(isMcpToolAutoApproved("github", "create_issue", config, db)).toBe(true);

    setMcpToolApprovalOverride(db, "github", "create_issue", "require_approval");
    expect(isMcpToolAutoApproved("github", "create_issue", config, db)).toBe(false);
  });
});
