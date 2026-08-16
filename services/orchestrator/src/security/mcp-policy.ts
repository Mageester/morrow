import type Database from "better-sqlite3";
import type { McpServerConfig } from "../mcp/config.js";

const READ_ONLY_VERBS = /^(get|list|read|search|describe|fetch|view|inspect|show|check|find|count|select)/i;
const MUTATING_VERBS = /^(create|write|delete|update|remove|post|put|patch|execute|run|send|modify|drop|alter|insert)/i;

export function isMcpToolAutoApproved(
  serverId: string,
  rawToolName: string,
  config?: McpServerConfig,
  db?: Database.Database
): boolean {
  // 1. Check user override in database
  if (db) {
    const key = `mcp.approval.${serverId}.${rawToolName}`;
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      if (row?.value === "always_allow" || row?.value === "allow") return true;
      if (row?.value === "require_approval" || row?.value === "deny") return false;
    } catch {}
  }

  // 2. Check explicit server config rules
  if (config?.permissions?.autoApprove?.includes(rawToolName)) return true;
  if (config?.permissions?.requireApproval?.includes(rawToolName)) return false;

  // 3. Heuristic based on tool name verbs
  if (READ_ONLY_VERBS.test(rawToolName)) return true;
  if (MUTATING_VERBS.test(rawToolName)) return false;

  // Default: if unrecognized verb, safe default is require approval
  return false;
}

export function setMcpToolApprovalOverride(
  db: Database.Database,
  serverId: string,
  rawToolName: string,
  policy: "always_allow" | "require_approval" | "deny"
): void {
  const key = `mcp.approval.${serverId}.${rawToolName}`;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, policy);
}

export function evaluateMcpToolPermission(
  serverId: string,
  rawToolName: string,
  config?: McpServerConfig,
  db?: Database.Database
): { autoApprove: boolean; riskLevel: "low" | "medium" | "high" } {
  const autoApprove = isMcpToolAutoApproved(serverId, rawToolName, config, db);
  const isMutating = MUTATING_VERBS.test(rawToolName);
  const riskLevel = isMutating ? "high" : autoApprove ? "low" : "medium";
  return { autoApprove, riskLevel };
}
