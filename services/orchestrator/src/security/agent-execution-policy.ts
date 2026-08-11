import type {
  Agent,
  AgentToolPermission,
  Delegation,
  MemoryScope,
} from "@morrow/contracts";
import { canAgentAccessMemoryScope } from "./agent-memory-policy.js";

export interface AgentExecutionPolicy {
  agentId: string;
  source: "standalone" | "delegation";
  /** A non-null set is a strict allow-list. */
  allowedTools: ReadonlySet<string> | null;
  deniedTools: ReadonlySet<string>;
  /** A non-null set is a strict memory read scope allow-list. */
  readScopes: ReadonlySet<MemoryScope>;
  writeScopes: ReadonlySet<MemoryScope>;
  approvalRequired: boolean;
  budget: Delegation["budget"];
  canUseTool(toolName: string): boolean;
  canReadMemory(scope: MemoryScope): boolean;
  canWriteMemory(scope: MemoryScope): boolean;
}

function effectivePermissions(permissions: AgentToolPermission[]): Map<string, AgentToolPermission> {
  const effective = new Map<string, AgentToolPermission>();
  for (const permission of permissions) {
    const previous = effective.get(permission.toolName);
    if (!previous
      || permission.priority > previous.priority
      || (permission.priority === previous.priority && permission.effect === "deny" && previous.effect !== "deny")) {
      effective.set(permission.toolName, permission);
    }
  }
  return effective;
}

/**
 * Build the execution-time policy from durable agent and delegation rows.
 * Nothing in this function is derived from provider output or conversation
 * content. A delegation's already-intersected policy is narrower than the
 * agent's standing policy and therefore wins for the child task.
 */
export function buildAgentExecutionPolicy(
  agent: Agent,
  permissions: AgentToolPermission[],
  delegation?: Pick<Delegation, "allowedTools" | "allowedMemoryScopes" | "approvalRequired" | "budget">,
): AgentExecutionPolicy {
  const effective = effectivePermissions(permissions);
  const deniedTools = new Set(
    [...effective.values()].filter((permission) => permission.effect === "deny").map((permission) => permission.toolName),
  );
  const allowedPermissionTools = new Set(
    [...effective.values()].filter((permission) => permission.effect === "allow").map((permission) => permission.toolName),
  );
  const hasAllowPermissions = allowedPermissionTools.size > 0;
  const allowedTools = delegation
    ? new Set(delegation.allowedTools)
    : hasAllowPermissions
      ? allowedPermissionTools
      : null;
  const readScopes = new Set(delegation?.allowedMemoryScopes ?? agent.memoryReadScopes);
  const writeScopes = new Set(delegation?.allowedMemoryScopes ?? agent.memoryWriteScopes);
  const policyAgent = delegation
    ? { ...agent, memoryReadScopes: [...readScopes], memoryWriteScopes: [...writeScopes] }
    : agent;

  return {
    agentId: agent.id,
    source: delegation ? "delegation" : "standalone",
    allowedTools,
    deniedTools,
    readScopes,
    writeScopes,
    approvalRequired: delegation?.approvalRequired ?? agent.approvalRequired,
    budget: delegation?.budget ?? {
      maxProviderCalls: agent.maxProviderCalls,
      maxTokenBudget: agent.maxTokenBudget,
      maxWallClockMs: agent.maxWallClockMs,
    },
    canUseTool(toolName: string): boolean {
      return !deniedTools.has(toolName) && (allowedTools === null || allowedTools.has(toolName));
    },
    canReadMemory(scope: MemoryScope): boolean {
      return canAgentAccessMemoryScope(policyAgent, scope, "read");
    },
    canWriteMemory(scope: MemoryScope): boolean {
      return canAgentAccessMemoryScope(policyAgent, scope, "write");
    },
  };
}
