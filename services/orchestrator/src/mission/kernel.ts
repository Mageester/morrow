import type { MissionRequirementNode, MissionStatus, ReopenCondition } from "@morrow/contracts";

/** The five explicit conditions under which a verified (frozen) node may reopen. */
export const REOPEN_CONDITIONS: readonly ReopenCondition[] = [
  "dependency_changed",
  "file_hash_changed",
  "later_verification_failed",
  "contract_changed",
  "explicit_invalidation",
];

/**
 * Select exactly ONE active requirement node. By the active-node invariant
 * there is at most one node with status `active`; this returns it, or null when
 * the mission is blocked, complete, or awaiting input. It is a selection helper
 * only — the real invariant is enforced transactionally in the service.
 */
export function selectActiveNode(nodes: MissionRequirementNode[]): MissionRequirementNode | null {
  return nodes.find((n) => n.status === "active") ?? null;
}

/**
 * A node is dependency-blocked when any of its declared dependencies is not yet
 * in a satisfied state (verified, waived, or invalidated). Blocked nodes must
 * not become active.
 */
export function isDependencyBlocked(node: MissionRequirementNode, allNodes: MissionRequirementNode[]): boolean {
  if (node.dependencies.length === 0) return false;
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  return node.dependencies.some((depId) => {
    const dep = byId.get(depId);
    // A missing dependency blocks advancement.
    if (!dep) return true;
    return dep.status !== "verified" && dep.status !== "waived" && dep.status !== "invalidated";
  });
}

/**
 * Derive the BOUNDED set of actions allowed next from the current node + mission
 * state. Slice 1 keeps this deterministic and declarative; it never returns an
 * unbounded "do anything" action.
 */
export function deriveAllowedActions(missionStatus: MissionStatus, activeNode: MissionRequirementNode | null): string[] {
  if (missionStatus === "draft" || missionStatus === "awaiting_criteria_approval") {
    return ["approve_requirements"];
  }
  if (activeNode === null) {
    return ["mark_complete", "request_clarification"];
  }
  switch (activeNode.status) {
    case "pending":
      return ["start_requirement", "verify_requirement", "reject_requirement"];
    case "active":
      return ["verify_requirement", "request_clarification", "reject_requirement", "complete_requirement"];
    case "blocked":
      return ["request_clarification"];
    case "failed":
      return ["retry_requirement", "request_clarification"];
    case "verified":
      return ["mark_complete"];
    case "waived":
      return ["mark_complete"];
    case "invalidated":
      return ["reopen_requirement", "request_clarification"];
    default:
      return ["request_clarification"];
  }
}

/**
 * Decide whether a verified (frozen) node may be reopened. Once a node is
 * verified it must NOT be silently reopened — only the five explicit, persisted
 * conditions allow it. Non-verified nodes are never frozen, so reopening is normal.
 *
 * The caller (the service) is responsible for durably recording the chosen
 * condition and a human-readable reason BEFORE relying on this result — a bare
 * boolean is never sufficient proof.
 */
export function canReopenNode(
  node: MissionRequirementNode,
  condition?: ReopenCondition,
): { allowed: boolean; reason: ReopenCondition | null } {
  if (node.status !== "verified") return { allowed: true, reason: null };
  if (condition && REOPEN_CONDITIONS.includes(condition)) return { allowed: true, reason: condition };
  return { allowed: false, reason: null };
}

/** The contract is frozen once any requirement node has been verified. */
export function computeFrozen(nodes: MissionRequirementNode[]): boolean {
  return nodes.some((n) => n.status === "verified");
}
