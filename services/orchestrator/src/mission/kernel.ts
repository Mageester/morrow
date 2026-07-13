import type { MissionRequirementNode, MissionStatus, ReopenCondition, RequirementNodeStatus } from "@morrow/contracts";
import { MISSION_TERMINAL_STATUSES } from "@morrow/contracts";

/** The five explicit conditions under which a verified (frozen) node may reopen. */
export const REOPEN_CONDITIONS: readonly ReopenCondition[] = [
  "dependency_changed",
  "file_hash_changed",
  "later_verification_failed",
  "contract_changed",
  "explicit_invalidation",
];

/**
 * The single, authoritative RequirementNodeStatus transition table. Every
 * requirement-status mutation is validated against this table BEFORE any
 * special-case branch runs, so no handler can invent an illegal transition.
 *
 * Key invariants encoded here:
 *  • pending → verified is forbidden (a node must be `active` before it can be
 *    verified).
 *  • A `verified` node may ONLY move to `pending` or `invalidated`, and never
 *    directly to `active`. This forces a reopened node into a deliberate
 *    non-active state first, and the service additionally requires a valid
 *    invalidation condition, non-blank reason, timestamp, and durable evidence
 *    before either of those verified→X transitions is allowed.
 *  • Reopened work (`invalidated`) must pass back through the normal lifecycle
 *    (it may go to `pending`/`active`), so it is never silently re-verified.
 */
export const REQUIREMENT_STATUS_TRANSITIONS: Record<RequirementNodeStatus, readonly RequirementNodeStatus[]> = {
  pending: ["active", "blocked", "failed", "waived", "invalidated"],
  active: ["verified", "failed", "blocked", "pending", "waived", "invalidated"],
  blocked: ["pending", "active", "failed", "waived", "invalidated"],
  failed: ["active", "pending", "blocked", "waived", "invalidated"],
  // A frozen (verified) node can only leave verified through invalidation, and
  // only into a non-active state. Never verified → active.
  verified: ["pending", "invalidated"],
  waived: ["pending", "invalidated"],
  invalidated: ["pending", "active", "blocked", "failed", "waived"],
};

/** Raised when a requirement-status transition is not permitted by the table. */
export class RequirementTransitionError extends Error {
  constructor(
    public readonly from: RequirementNodeStatus,
    public readonly to: RequirementNodeStatus,
  ) {
    super(`Invalid requirement transition: ${from} -> ${to}`);
    this.name = "RequirementTransitionError";
  }
}

/** True when `from → to` is an explicitly permitted requirement transition. */
export function canTransitionRequirement(from: RequirementNodeStatus, to: RequirementNodeStatus): boolean {
  if (from === to) return true;
  return REQUIREMENT_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Assert a requirement transition is permitted; throws RequirementTransitionError. */
export function assertRequirementTransition(from: RequirementNodeStatus, to: RequirementNodeStatus): void {
  if (!canTransitionRequirement(from, to)) throw new RequirementTransitionError(from, to);
}

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

/** True when every authoritative requirement node is in a satisfied terminal
 *  state (verified or waived). Non-authoritative (unapproved model/derived)
 *  nodes are intentionally excluded from this check. */
export function allAuthoritativeSatisfied(nodes: MissionRequirementNode[]): boolean {
  const authoritative = nodes.filter((n) => n.authoritative);
  if (authoritative.length === 0) return true;
  return authoritative.every((n) => n.status === "verified" || n.status === "waived");
}

/**
 * Derive the BOUNDED set of actions allowed next from the full requirement
 * ledger + mission state. Slice 1 keeps this deterministic and declarative;
 * it never returns an unbounded "do anything" action.
 *
 * Terminal missions expose no executable actions.
 */
export function deriveAllowedActions(
  missionStatus: MissionStatus,
  activeNode: MissionRequirementNode | null,
  allNodes: MissionRequirementNode[],
): string[] {
  if (MISSION_TERMINAL_STATUSES.includes(missionStatus)) {
    return [];
  }
  if (missionStatus === "draft" || missionStatus === "awaiting_criteria_approval") {
    return ["approve_requirements"];
  }
  if (activeNode === null) {
    const hasFailed = allNodes.some((n) => n.authoritative && n.status === "failed");
    const hasBlocked = allNodes.some((n) => n.authoritative && n.status === "blocked");
    if (hasFailed) return ["request_clarification"];
    if (hasBlocked) return ["request_clarification"];
    if (allAuthoritativeSatisfied(allNodes)) {
      return ["mark_complete", "request_clarification"];
    }
    return ["request_clarification"];
  }
  switch (activeNode.status) {
    case "pending":
      return ["start_requirement", "request_clarification"];
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

/** Expected hex-digest lengths for each accepted content-hash algorithm. */
const FILE_HASH_DIGEST_LENGTHS: Record<string, number> = {
  md5: 32,
  sha1: 40,
  sha256: 64,
  sha512: 128,
  blake3: 64,
  blake2b: 128,
};

/**
 * A file hash used as verification evidence must be a validated, non-blank,
 * structured representation: `<algorithm>:<hexdigest>` where the algorithm is
 * known and the digest is the correct hex length for that algorithm. This
 * rejects blank strings, whitespace, unprefixed junk, and truncated/garbage
 * digests such as "sha256:abc" or "sha256:xyz", so an arbitrary string can
 * never masquerade as a real content hash proving completion.
 */
export function isValidFileHash(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const match = /^([a-z0-9]+):([0-9a-fA-F]+)$/.exec(trimmed);
  if (!match) return false;
  const algorithm = match[1]!.toLowerCase();
  const digest = match[2]!;
  const expected = FILE_HASH_DIGEST_LENGTHS[algorithm];
  if (expected === undefined) return false;
  return digest.length === expected;
}
