import { describe, it, expect } from "vitest";
import {
  selectActiveNode,
  deriveAllowedActions,
  canReopenNode,
  computeFrozen,
  isDependencyBlocked,
} from "../src/mission/kernel.js";
import type { MissionRequirementNode } from "@morrow/contracts";

function node(over: Partial<MissionRequirementNode> = {}): MissionRequirementNode {
  return {
    version: 1,
    id: over.id ?? "req-1",
    missionId: "m1",
    order: over.order ?? 0,
    statement: over.statement ?? "do the thing",
    category: over.category ?? "objective",
    sourcePromptExcerpt: over.sourcePromptExcerpt ?? "do the thing",
    source: over.source ?? "user",
    confidence: over.confidence ?? 1,
    approved: over.approved ?? true,
    authoritative: over.authoritative ?? true,
    status: over.status ?? "pending",
    dependencies: over.dependencies ?? [],
    evidenceRefs: over.evidenceRefs ?? [],
    affectedFiles: over.affectedFiles ?? [],
    verifiedFileHashes: over.verifiedFileHashes ?? [],
    attempts: over.attempts ?? 0,
    lastFailure: over.lastFailure ?? null,
    completedAt: over.completedAt ?? null,
    invalidationHistory: over.invalidationHistory ?? [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("mission kernel — selectActiveNode (R4)", () => {
  it("returns the single active node", () => {
    const nodes = [
      node({ id: "a", order: 0, status: "pending" }),
      node({ id: "b", order: 1, status: "active" }),
      node({ id: "c", order: 2, status: "pending" }),
    ];
    expect(selectActiveNode(nodes)?.id).toBe("b");
  });

  it("returns null when nothing is active (blocked / complete / awaiting input)", () => {
    const nodes = [
      node({ id: "a", status: "verified" }),
      node({ id: "b", status: "waived" }),
    ];
    expect(selectActiveNode(nodes)).toBeNull();
  });
});

describe("mission kernel — deriveAllowedActions (R3 cursor)", () => {
  it("bounds actions to a finite set, never a bare continue", () => {
    const pending = node({ status: "pending", id: "req-1" });
    const actions = deriveAllowedActions("running", pending, [pending]);
    expect(actions).toEqual(expect.arrayContaining(["start_requirement", "request_clarification"]));
    expect(actions).not.toContain("continue");
  });

  it("offers completion when no active node and all authoritative satisfied", () => {
    const v = node({ id: "v", status: "verified", authoritative: true });
    expect(deriveAllowedActions("running", null, [v])).toEqual(["mark_complete", "request_clarification"]);
  });

  it("denies mark_complete when authoritative nodes remain pending", () => {
    const p = node({ id: "p", status: "pending", authoritative: true });
    expect(deriveAllowedActions("running", null, [p])).toEqual(["request_clarification"]);
  });

  it("denies mark_complete when authoritative nodes are failed", () => {
    const f = node({ id: "f", status: "failed", authoritative: true });
    expect(deriveAllowedActions("running", null, [f])).toEqual(["request_clarification"]);
  });

  it("limits action during draft to approving requirements", () => {
    expect(deriveAllowedActions("draft", null, [])).toEqual(["approve_requirements"]);
  });

  it("returns no actions for terminal mission statuses", () => {
    expect(deriveAllowedActions("completed", null, [])).toEqual([]);
    expect(deriveAllowedActions("failed", null, [])).toEqual([]);
    expect(deriveAllowedActions("cancelled", null, [])).toEqual([]);
  });

  it("blocks a node stuck on dependencies to clarification only", () => {
    const blocked = node({ status: "blocked" });
    expect(deriveAllowedActions("running", blocked, [blocked])).toEqual(["request_clarification"]);
  });

  it("offers start_requirement for pending (not verify_requirement)", () => {
    const pending = node({ status: "pending" });
    const actions = deriveAllowedActions("running", pending, [pending]);
    expect(actions).toContain("start_requirement");
    expect(actions).not.toContain("verify_requirement");
  });
});

describe("mission kernel — isDependencyBlocked (R10)", () => {
  it("marks a node blocked when its dependency is not satisfied", () => {
    const dep = node({ id: "dep", status: "pending" });
    const dependent = node({ id: "x", dependencies: ["dep"] });
    const all = [dep, dependent];
    expect(isDependencyBlocked(dependent, all)).toBe(true);
  });

  it("allows advancement once the dependency is verified", () => {
    const dep = node({ id: "dep", status: "verified" });
    const dependent = node({ id: "x", dependencies: ["dep"] });
    expect(isDependencyBlocked(dependent, [dep, dependent])).toBe(false);
  });

  it("treats a missing dependency as blocking", () => {
    expect(isDependencyBlocked(node({ id: "x", dependencies: ["ghost"] }), [node({ id: "x" })])).toBe(true);
  });
});

describe("mission kernel — freeze / canReopenNode (R5, R11, R12)", () => {
  it("never reopens a verified node without an explicit condition", () => {
    const verified = node({ status: "verified", verifiedFileHashes: ["abc"] });
    expect(canReopenNode(verified).allowed).toBe(false);
    expect(canReopenNode(verified, undefined).allowed).toBe(false);
  });

  it("allows reopen only for the five explicit conditions", () => {
    const verified = node({ status: "verified", verifiedFileHashes: ["abc"] });
    expect(canReopenNode(verified, "dependency_changed").reason).toBe("dependency_changed");
    expect(canReopenNode(verified, "file_hash_changed").reason).toBe("file_hash_changed");
    expect(canReopenNode(verified, "later_verification_failed").reason).toBe("later_verification_failed");
    expect(canReopenNode(verified, "contract_changed").reason).toBe("contract_changed");
    expect(canReopenNode(verified, "explicit_invalidation").reason).toBe("explicit_invalidation");
  });

  it("treats non-verified nodes as never frozen", () => {
    const pending = node({ status: "pending" });
    expect(canReopenNode(pending).allowed).toBe(true);
    expect(canReopenNode(pending).reason).toBeNull();
  });

  it("computeFrozen is true once any node is verified", () => {
    expect(computeFrozen([node({ status: "pending" })])).toBe(false);
    expect(computeFrozen([node({ status: "pending" }), node({ status: "verified" })])).toBe(true);
  });
});
