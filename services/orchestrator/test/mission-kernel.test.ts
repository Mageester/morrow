import { describe, it, expect } from "vitest";
import {
  selectActiveNode,
  deriveAllowedActions,
  canReopenNode,
  computeFrozen,
} from "../src/mission/kernel.js";
import type { MissionRequirementNode } from "@morrow/contracts";

function node(over: Partial<MissionRequirementNode> = {}): MissionRequirementNode {
  return {
    version: 1,
    id: over.id ?? "req-1",
    missionId: "m1",
    order: over.order ?? 0,
    statement: over.statement ?? "do the thing",
    source: over.source ?? "user",
    confidence: over.confidence ?? 1,
    approved: over.approved ?? true,
    status: over.status ?? "pending",
    verifiedFileHash: over.verifiedFileHash ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("mission kernel — selectActiveNode", () => {
  it("prefers the in_progress node as the single active objective", () => {
    const nodes = [
      node({ id: "a", order: 0, status: "pending" }),
      node({ id: "b", order: 1, status: "in_progress" }),
      node({ id: "c", order: 2, status: "pending" }),
    ];
    expect(selectActiveNode(nodes)?.id).toBe("b");
  });

  it("falls back to the first approved unfinished node when none in progress", () => {
    const nodes = [
      node({ id: "a", order: 0, status: "verified" }),
      node({ id: "b", order: 1, status: "pending" }),
      node({ id: "c", order: 2, status: "pending" }),
    ];
    expect(selectActiveNode(nodes)?.id).toBe("b");
  });

  it("skips unapproved (model/derived) nodes until approved", () => {
    const nodes = [
      node({ id: "a", order: 0, source: "model", approved: false, status: "pending" }),
      node({ id: "b", order: 1, approved: true, status: "pending" }),
    ];
    expect(selectActiveNode(nodes)?.id).toBe("b");
  });

  it("returns null when nothing is actionable", () => {
    const nodes = [
      node({ id: "a", order: 0, status: "verified" }),
      node({ id: "b", order: 1, status: "waived" }),
    ];
    expect(selectActiveNode(nodes)).toBeNull();
  });
});

describe("mission kernel — deriveAllowedActions", () => {
  it("bounds actions to a finite set, never a bare continue", () => {
    const pending = node({ status: "pending" });
    const actions = deriveAllowedActions("running", pending);
    expect(actions).toEqual(expect.arrayContaining(["start_requirement", "verify_requirement", "reject_requirement"]));
    expect(actions).not.toContain("continue");
  });

  it("offers completion/closure when no active node", () => {
    expect(deriveAllowedActions("running", null)).toEqual(["mark_complete", "request_clarification"]);
  });

  it("limits action during draft to approving requirements", () => {
    expect(deriveAllowedActions("draft", null)).toEqual(["approve_requirements"]);
  });
});

describe("mission kernel — freeze / canReopenNode (I5)", () => {
  it("never reopens a verified node without an explicit reason", () => {
    const verified = node({ status: "verified", verifiedFileHash: "abc" });
    expect(canReopenNode(verified).allowed).toBe(false);
  });

  it("allows reopen only for the five explicit conditions", () => {
    const verified = node({ status: "verified", verifiedFileHash: "abc" });
    expect(canReopenNode(verified, { dependencyChanged: true }).reason).toBe("dependency_changed");
    expect(canReopenNode(verified, { fileHashChanged: true }).reason).toBe("file_hash_changed");
    expect(canReopenNode(verified, { laterVerificationFailed: true }).reason).toBe("later_verification_failed");
    expect(canReopenNode(verified, { contractChanged: true }).reason).toBe("contract_changed");
    expect(canReopenNode(verified, { invalidationRecorded: true }).reason).toBe("invalidated");
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
