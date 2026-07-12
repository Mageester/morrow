import type { MissionRequirementNode, MissionStatus } from "@morrow/contracts";

/** The five explicit conditions under which a verified (frozen) node may reopen. */
export type ReopenReason =
  | "dependency_changed"
  | "file_hash_changed"
  | "later_verification_failed"
  | "contract_changed"
  | "invalidated";

/**
 * Select exactly ONE active requirement node. The cursor must always point at a
 * single, concrete objective — never a vague "continue". Prefers an in-progress
 * node; otherwise the first approved-but-unfinished node in order.
 */
export function selectActiveNode(nodes: MissionRequirementNode[]): MissionRequirementNode | null {
  const ordered = [...nodes].sort((a, b) => a.order - b.order);
  const inProgress = ordered.find((n) => n.status === "in_progress");
  if (inProgress) return inProgress;
  return ordered.find((n) => n.approved && (n.status === "pending" || n.status === "rejected")) ?? null;
}

/**
 * Derive the BOUNDED set of actions allowed from the current node + mission
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
    case "in_progress":
      return ["verify_requirement", "request_clarification", "reject_requirement"];
    case "rejected":
      return ["verify_requirement", "raise_ambiguity"];
    default:
      return ["request_clarification"];
  }
}

/**
 * Decide whether a verified (frozen) node may be reopened. Once a node is
 * verified it must NOT be silently reopened — only the five explicit conditions
 * allow it. Non-verified nodes are never frozen, so reopening is normal.
 */
export function canReopenNode(
  node: MissionRequirementNode,
  evidence: {
    dependencyChanged?: boolean;
    fileHashChanged?: boolean;
    laterVerificationFailed?: boolean;
    contractChanged?: boolean;
    invalidationRecorded?: boolean;
  } = {},
): { allowed: boolean; reason: ReopenReason | null } {
  if (node.status !== "verified") return { allowed: true, reason: null };
  if (evidence.dependencyChanged) return { allowed: true, reason: "dependency_changed" };
  if (evidence.fileHashChanged) return { allowed: true, reason: "file_hash_changed" };
  if (evidence.laterVerificationFailed) return { allowed: true, reason: "later_verification_failed" };
  if (evidence.contractChanged) return { allowed: true, reason: "contract_changed" };
  if (evidence.invalidationRecorded) return { allowed: true, reason: "invalidated" };
  return { allowed: false, reason: null };
}

/** The contract is frozen once any requirement node has been verified. */
export function computeFrozen(nodes: MissionRequirementNode[]): boolean {
  return nodes.some((n) => n.status === "verified");
}
