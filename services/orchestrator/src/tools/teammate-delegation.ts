import { createHash } from "node:crypto";
import type { Agent, AgentToolPermission, Task } from "@morrow/contracts";

/** The only model-authored delegation tool. Keep this name in one place so
 * exposure, execution, recovery, and approval checks cannot drift. */
export const ASK_TEAMMATE_TOOL_NAME = "ask_teammate" as const;

export interface TeammateSpawnResult {
  taskId: string;
  agentId: string;
  providerId: string | null;
  model: string | null;
}

export interface TeammateSpawnRequest {
  parentTaskId: string;
  toolCallId: string;
  agentId: string;
  objective: string;
  targetProfileHash?: string;
}

export type TeammateSpawner = (request: TeammateSpawnRequest) => TeammateSpawnResult;

/** Stable binding for every target field that can affect child authority. */
export function teammateProfileFingerprint(agent: Agent, permissions: AgentToolPermission[] = []): string {
  const canonical = {
    id: agent.id,
    projectId: agent.projectId,
    role: agent.role,
    instructions: agent.instructions,
    providerOverride: agent.providerOverride,
    modelOverride: agent.modelOverride,
    enabled: agent.enabled,
    teamId: agent.teamId,
    memoryReadScopes: [...agent.memoryReadScopes].sort(),
    memoryWriteScopes: [...agent.memoryWriteScopes].sort(),
    maxProviderCalls: agent.maxProviderCalls,
    maxTokenBudget: agent.maxTokenBudget,
    maxWallClockMs: agent.maxWallClockMs,
    maxChildTasks: agent.maxChildTasks,
    approvalRequired: agent.approvalRequired,
    permissions: permissions
      .map((permission) => ({ toolName: permission.toolName, effect: permission.effect, priority: permission.priority }))
      .sort((a, b) => `${a.priority}:${a.toolName}:${a.effect}`.localeCompare(`${b.priority}:${b.toolName}:${b.effect}`)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Return a stable key for one model call. It intentionally excludes the
 * target/objective: a replay with changed arguments must collide and be
 * rejected by the durable dispatch fingerprint instead of silently creating a
 * second child.
 */
export function teammateSpawnKey(parentTaskId: string, toolCallId: string): string {
  return `${parentTaskId}:${toolCallId}`;
}

/**
 * Process-local duplicate suppression for the narrow interval before a
 * caller can observe the durable child task. The durable dispatch path also
 * receives the same key, so restart/replay remains safe after this map is
 * gone. Failed spawns are not cached and may be retried after the failure is
 * surfaced to the parent.
 */
export class TeammateSpawnRegistry {
  private readonly completed = new Map<string, unknown>();

  run<T>(key: string, spawn: () => T): T {
    const previous = this.completed.get(key);
    if (previous !== undefined) return previous as T;
    const result = spawn();
    this.completed.set(key, result);
    return result;
  }

  clear(key: string): void {
    this.completed.delete(key);
  }

  size(): number {
    return this.completed.size;
  }
}

export type TeammateRefusalCode =
  | "AGENT_NOT_FOUND"
  | "AGENT_DISABLED"
  | "AGENT_CROSS_PROJECT"
  | "AGENT_SELF"
  | "AGENT_TEAM_TARGET"
  | "AGENT_PROFILE_CHANGED";

export class TeammateTargetError extends Error {
  constructor(
    public readonly code: TeammateRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "TeammateTargetError";
  }
}

/**
 * Resolve the target only from the server's durable agent profile. The model
 * never supplies a name, provider, model, team, or policy field. This helper
 * is intentionally pure so both the live tool and recovery path use the same
 * refusal rules.
 */
export function resolveStandaloneTeammateTarget(
  parent: Pick<Task, "projectId"> & { agentId?: string | null | undefined },
  target: Agent | undefined,
  requestedAgentId: string,
): Agent {
  if (!target) throw new TeammateTargetError("AGENT_NOT_FOUND", "Teammate not found in this project.");
  if (target.projectId !== parent.projectId) {
    throw new TeammateTargetError("AGENT_CROSS_PROJECT", "Teammate is not in this project.");
  }
  if (!target.enabled) throw new TeammateTargetError("AGENT_DISABLED", "Teammate is disabled.");
  if (parent.agentId && target.id === parent.agentId) {
    throw new TeammateTargetError("AGENT_SELF", "A teammate cannot ask itself for help.");
  }
  if (target.teamId) {
    throw new TeammateTargetError("AGENT_TEAM_TARGET", "Team members must be reached through the team delegation flow.");
  }
  // Keep this final check explicit: callers should pass the id they validated,
  // and no future profile lookup may accidentally substitute another row.
  if (target.id !== requestedAgentId) {
    throw new TeammateTargetError("AGENT_NOT_FOUND", "Teammate not found in this project.");
  }
  return target;
}
