import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { missionsRepository, type ContractRequirementNodeInput } from "../src/repositories/missions.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { MissionService } from "../src/mission/service.js";
import type { ReopenCondition } from "@morrow/contracts";

const roots: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

function setup(file?: string) {
  const home = tmp("ek-home-");
  const workspace = tmp("ek-ws-");
  const dbPath = file ?? join(tmp("ek-db-"), "m.db");
  const db = openDatabase(dbPath);
  const projects = projectRepository(db);
  const now = new Date().toISOString();
  const project = projects.createProject({ id: "p1", name: "proj", workspacePath: workspace, createdAt: now });
  const repo = missionsRepository(db);
  const service = new MissionService({
    repo,
    getWorkspacePath: (pid) => (pid === project.id ? workspace : undefined),
    backupDir: join(home, "mission-checkpoints"),
  });
  return { db, dbPath, service, repo, workspace, project };
}

function reload(dbPath: string) {
  const db = openDatabase(dbPath);
  const repo = missionsRepository(db);
  const service = new MissionService({ repo, getWorkspacePath: () => undefined, backupDir: tmp("ek-b-") });
  return { db, repo, service };
}

const FIVE_CONDITIONS: ReopenCondition[] = [
  "dependency_changed", "file_hash_changed", "later_verification_failed", "contract_changed", "explicit_invalidation",
];

describe("R1/R2 — contract on create preserves verbatim prompt + provenance", () => {
  it("builds a contract from the verbatim objective with authoritative provenance", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Repair the save game corruption bug" });
    const contract = service.getContract(m.id);
    expect(contract.sourcePrompt).toBe("Repair the save game corruption bug");
    expect(contract.objective).toBe("Repair the save game corruption bug");
    expect(contract.requirements).toHaveLength(1);
    const req = contract.requirements[0]!;
    expect(req.statement).toBe("Repair the save game corruption bug");
    expect(req.category).toBe("objective");
    expect(req.source).toBe("user");
    expect(req.confidence).toBe(1);
    expect(req.approved).toBe(true);
    expect(req.authoritative).toBe(true);
    expect(contract.frozen).toBe(false);
  });
});

describe("R4 — missing structured input yields an objective-only contract", () => {
  it("records unresolved detail and guesses nothing", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Make the CLI print a friendly banner" });
    const contract = service.getContract(m.id);
    expect(contract.expectedArtifacts).toEqual([]);
    expect(contract.acceptanceCriteria).toEqual([]);
    expect(contract.requirements).toHaveLength(1);
    expect(contract.requirements[0]!.category).toBe("objective");
    expect(contract.unresolvedAmbiguities.length).toBeGreaterThan(0);
    expect(contract.unresolvedAmbiguities.join(" ")).toMatch(/only the objective is authoritative/i);
  });

  it("structured contract populates detail and does not record unresolved detail", () => {
    const { service } = setup();
    const m = service.create("p1", {
      objective: "Add retry queue",
      contract: {
        expectedArtifacts: ["retry-queue.ts"],
        acceptanceCriteria: ["drains within 5s"],
        verificationCommands: ["pnpm test"],
        requiredGitResult: "clean-working-tree",
        prohibitions: ["no force-push"],
      },
    });
    const contract = service.getContract(m.id);
    expect(contract.expectedArtifacts).toEqual(["retry-queue.ts"]);
    expect(contract.acceptanceCriteria).toEqual(["drains within 5s"]);
    expect(contract.verificationCommands).toEqual(["pnpm test"]);
    expect(contract.requiredGitResult).toBe("clean-working-tree");
    expect(contract.unresolvedAmbiguities).toEqual([]);
    const cats = contract.requirements.map((r) => r.category).sort();
    expect(cats).toEqual(["acceptance_criterion", "expected_artifact", "objective", "prohibited_action"].sort());
  });
});

describe("R3 — derived/model requirements are non-authoritative until approved", () => {
  it("blocks activation of an unapproved (model) node and allows it after approval", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Ship feature" });
    const objNode = service.listRequirementNodes(m.id)[0]!;
    const modelNode: ContractRequirementNodeInput = {
      id: "req-model", order: 1, statement: "Model-suggested hardening", category: "hard_requirement",
      sourcePromptExcerpt: "Ship feature", source: "model", confidence: 0.4, approved: false, authoritative: false,
    };
    repo.addRequirementNodes(m.id, [modelNode]);
    expect(service.listRequirementNodes(m.id).find((n) => n.id === "req-model")!.authoritative).toBe(false);

    expect(() => service.updateRequirementStatus(m.id, "req-model", "active")).toThrow(/not.*approved/i);

    service.approveRequirement(m.id, "req-model");
    const approved = service.listRequirementNodes(m.id).find((n) => n.id === "req-model")!;
    expect(approved.approved).toBe(true);
    expect(approved.authoritative).toBe(true);

    const activated = service.updateRequirementStatus(m.id, "req-model", "active");
    expect(activated.status).toBe("active");
    expect(service.getCursor(m.id).activeNodeId).toBe("req-model");
    // The previously active objective node was deactivated by the invariant.
    expect(service.listRequirementNodes(m.id).find((n) => n.id === objNode.id)!.status).toBe("pending");
  });
});

describe("R5 — contract, nodes, and cursor survive database reload", () => {
  it("reloads from a fresh connection to the same file", () => {
    const { dbPath, service, repo } = setup();
    const m = service.create("p1", { objective: "Persist me" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:deadbeef" });
    service.advanceCursor(m.id);

    const r2 = reload(dbPath);
    const contract = r2.service.getContract(m.id);
    expect(contract.sourcePrompt).toBe("Persist me");
    expect(contract.requirements[0]!.verifiedFileHashes).toEqual(["sha256:deadbeef"]);
    const cursor = r2.repo.getCursor(m.id)!;
    expect(cursor.frozenNodeIds).toContain(req.id);
    expect(cursor.missionId).toBe(m.id);
  });
});

describe("R6/R7 — per-mission cursors are independent", () => {
  it("two missions in one project retain separate cursors", () => {
    const { service } = setup();
    const a = service.create("p1", { objective: "Mission A" });
    const b = service.create("p1", { objective: "Mission B" });
    const reqA = service.listRequirementNodes(a.id)[0]!;
    service.updateRequirementStatus(a.id, reqA.id, "active");
    expect(service.getCursor(a.id).activeNodeId).toBe(reqA.id);
    expect(service.getCursor(b.id).activeNodeId).toBeNull();
  });

  it("switching active-mission pointer does not destroy either cursor", () => {
    const { service } = setup();
    const a = service.create("p1", { objective: "Mission A" });
    const b = service.create("p1", { objective: "Mission B" });
    service.setProjectActiveMission?.("p1", a.id);
    service.setProjectActiveMission?.("p1", b.id);
    expect(service.getProjectActiveMission("p1")?.missionId).toBe(b.id);
    expect(service.getCursor(a.id).missionId).toBe(a.id);
    expect(service.getCursor(b.id).missionId).toBe(b.id);
  });
});

describe("R8/R9 — at most one active node; cursor matches it", () => {
  it("activating a second node deactivates the first (DB never exposes two active)", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Two-step work" });
    const n1 = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, n1.id, "active");
    repo.addRequirementNodes(m.id, [{
      id: "req-2", order: 1, statement: "second step", category: "hard_requirement",
      sourcePromptExcerpt: "Two-step work", source: "user", confidence: 1, approved: true, authoritative: true,
    }]);
    service.updateRequirementStatus(m.id, "req-2", "active");

    const active = service.listRequirementNodes(m.id).filter((n) => n.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe("req-2");
    expect(service.listRequirementNodes(m.id).find((n) => n.id === n1.id)!.status).toBe("pending");

    const cursor = service.getCursor(m.id);
    expect(cursor.activeNodeId).toBe("req-2");
    expect(cursor.activeObjective).toBe("second step");
  });
});

describe("R10 — dependency-blocked nodes cannot become active", () => {
  it("blocks activation until the dependency is satisfied", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Build with prerequisite" });
    const pre = service.listRequirementNodes(m.id)[0]!; // objective, id pre
    repo.addRequirementNodes(m.id, [{
      id: "req-dep", order: 1, statement: "dependent step", category: "hard_requirement",
      sourcePromptExcerpt: "Build with prerequisite", source: "user", confidence: 1, approved: true, authoritative: true,
      dependencies: [pre.id],
    }]);
    expect(() => service.updateRequirementStatus(m.id, "req-dep", "active")).toThrow(/dependenc/i);
    service.updateRequirementStatus(m.id, pre.id, "verified");
    const activated = service.updateRequirementStatus(m.id, "req-dep", "active");
    expect(activated.status).toBe("active");
  });
});

describe("R11/R12 — verified nodes need persisted invalidation evidence; all five conditions reopen", () => {
  it("rejects reopening a verified node without persisted evidence", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Freeze me" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:abc" });
    expect(() => service.updateRequirementStatus(m.id, req.id, "pending")).toThrow(/persisted invalidation evidence/i);
  });

  it("each of the five conditions reopens and records the reason", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Reopen me" });
    const req = service.listRequirementNodes(m.id)[0]!;
    for (const condition of FIVE_CONDITIONS) {
      service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:abc" });
      const reason = `Reopened because ${condition}`;
      const reopened = service.updateRequirementStatus(m.id, req.id, "pending", {
        invalidationCondition: condition,
        invalidationReason: reason,
      });
      expect(reopened.status).toBe("pending");
      expect(reopened.invalidationConditions).toContain(condition);
      expect(reopened.invalidationReason).toBe(reason);
      expect(reopened.verifiedFileHashes).toEqual([]);
      const ev = repo.listEvents(m.id).filter((e) => e.type === "mission.requirement_reopened").at(-1);
      expect(ev?.data.condition).toBe(condition);
      // Re-verify for the next iteration.
      service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:abc" });
    }
  });
});

describe("R13 — frozen and invalidated node ids survive restart", () => {
  it("cursor preserves frozen and invalidated node sets after reload", () => {
    const { dbPath, service, repo } = setup();
    const m = service.create("p1", { objective: "Track states" });
    const n1 = service.listRequirementNodes(m.id)[0]!;
    repo.addRequirementNodes(m.id, [{
      id: "req-inv", order: 1, statement: "later dropped", category: "hard_requirement",
      sourcePromptExcerpt: "Track states", source: "user", confidence: 1, approved: true, authoritative: true,
      status: "invalidated",
    }]);
    service.advanceCursor(m.id);
    service.updateRequirementStatus(m.id, n1.id, "verified", { fileHash: "sha256:xyz" });

    const r2 = reload(dbPath);
    const cursor = r2.repo.getCursor(m.id)!;
    expect(cursor.frozenNodeIds).toContain(n1.id);
    expect(cursor.invalidatedNodeIds).toContain("req-inv");
  });
});

describe("R14 — legacy (pre-kernel) missions still hydrate", () => {
  it("a mission row without a contract/cursor loads and getContract reports not_found", () => {
    const { db, service, repo } = setup();
    db.prepare(
      `INSERT INTO missions (id, schema_version, project_id, objective, status, auto_approve, task_tree_root_id, budget_json, result_json, created_at, updated_at, started_at, completed_at)
       VALUES (?,1,?,?, 'draft', 0, NULL, ?, NULL, ?, ?, NULL, NULL)`,
    ).run("legacy-m1", "p1", "Old objective", JSON.stringify({ maxReviewCycles: 2, spentUsd: 0, attemptsUsed: 0, reviewCyclesUsed: 0 }), new Date().toISOString(), new Date().toISOString());
    const legacy = repo.get("legacy-m1")!;
    expect(legacy.objective).toBe("Old objective");
    expect(legacy.status).toBe("draft");
    expect(() => service.getContract("legacy-m1")).toThrow(/not found/i);
  });
});

describe("R15 — existing tasks.mission_id links still work", () => {
  it("a task linked to a mission resolves its missionId", () => {
    const { db, service } = setup();
    const m = service.create("p1", { objective: "Linked task" });
    const tasks = taskRepository(db);
    const task = tasks.createTask({
      id: "task-1", projectId: "p1", kind: "inspect_workspace", status: "queued",
      missionId: m.id, createdAt: new Date().toISOString(),
    });
    expect(task.missionId).toBe(m.id);
  });
});

describe("R13/R16 — cursor persists after finalize (audit + event identity)", () => {
  it("preserves the cursor after completion for resume history", () => {
    const { service, db, repo } = setup();
    const m = service.create("p1", { objective: "Fix crash" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:deadbeef" });
    service.finalize(m.id);
    const cursor = service.getCursor(m.id);
    expect(cursor.activeNodeId).toBeNull();
    expect(cursor.frozenNodeIds).toContain(req.id);
    const repo2 = missionsRepository(db);
    expect(repo2.getCursor(m.id)?.frozenNodeIds).toContain(req.id);
    // Terminal event identity is preserved.
    expect(repo.listEvents(m.id).some((e) => e.type === "mission.completed")).toBe(true);
  });
});
