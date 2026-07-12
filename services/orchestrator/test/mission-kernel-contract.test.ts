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
    service.updateRequirementStatus(m.id, req.id, "active");
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
    service.updateRequirementStatus(m.id, pre.id, "active");
    service.updateRequirementStatus(m.id, pre.id, "verified", { fileHash: "sha256:abc" });
    const activated = service.updateRequirementStatus(m.id, "req-dep", "active");
    expect(activated.status).toBe("active");
  });
});

describe("R11/R12 — verified nodes need persisted invalidation evidence; all five conditions reopen", () => {
  it("rejects reopening a verified node without persisted evidence", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Freeze me" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:abc" });
    expect(() => service.updateRequirementStatus(m.id, req.id, "pending")).toThrow(/persisted invalidation evidence/i);
  });

  it("each of the five conditions reopens and records the reason", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Reopen me" });
    const req = service.listRequirementNodes(m.id)[0]!;
    for (const condition of FIVE_CONDITIONS) {
      service.updateRequirementStatus(m.id, req.id, "active");
      service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:abc" });
      const reason = `Reopened because ${condition}`;
      const reopened = service.updateRequirementStatus(m.id, req.id, "pending", {
        invalidationCondition: condition,
        invalidationReason: reason,
      });
      expect(reopened.status).toBe("pending");
      expect(reopened.invalidationHistory.some((e) => e.condition === condition)).toBe(true);
      expect(reopened.invalidationHistory.some((e) => e.reason === reason)).toBe(true);
      expect(reopened.verifiedFileHashes).toEqual([]);
      const ev = repo.listEvents(m.id).filter((e) => e.type === "mission.requirement_reopened").at(-1);
      expect(ev?.data.condition).toBe(condition);
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
    service.updateRequirementStatus(m.id, n1.id, "active");
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
    // Transition through the normal lifecycle: draft → running → finalized.
    service.approveCriteria(m.id);
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:deadbeef" });
    service.finalize(m.id);
    const cursor = service.getCursor(m.id);
    expect(cursor.activeNodeId).toBeNull();
    expect(cursor.frozenNodeIds).toContain(req.id);
    expect(cursor.allowedNextActions).toEqual([]);
    const repo2 = missionsRepository(db);
    expect(repo2.getCursor(m.id)?.frozenNodeIds).toContain(req.id);
    // Terminal event identity is preserved.
    expect(repo.listEvents(m.id).some((e) => e.type === "mission.completed")).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F1 — addRequirementNodes persists every supplied field
// ════════════════════════════════════════════════════════════════════════════
describe("F1 — addRequirementNodes persists every supplied field", () => {
  it("supplied evidenceRefs, affectedFiles, verifiedFileHashes, attempts, lastFailure, completedAt, invalidationHistory survive persistence", () => {
    const { service, repo, dbPath } = setup();
    const m = service.create("p1", { objective: "Full field test" });
    const fullNode: ContractRequirementNodeInput = {
      id: "req-full", order: 1, statement: "All fields", category: "hard_requirement",
      sourcePromptExcerpt: "All fields", source: "user", confidence: 0.9, approved: true, authoritative: true,
      dependencies: [], evidenceRefs: ["ev-1", "ev-2"], affectedFiles: ["src/a.ts", "src/b.ts"],
      verifiedFileHashes: ["sha256:aa"], attempts: 3, lastFailure: "timeout",
      completedAt: "2026-01-01T00:00:00.000Z",
      invalidationHistory: [{
        condition: "file_hash_changed", reason: "hash drifted",
        invalidatedAt: "2026-01-02T00:00:00.000Z", evidenceRef: "ev-3",
      }],
    };
    repo.addRequirementNodes(m.id, [fullNode]);
    // Reload from fresh connection.
    const r2 = reload(dbPath);
    const node = r2.repo.getRequirementNode("req-full")!;
    expect(node.evidenceRefs).toEqual(["ev-1", "ev-2"]);
    expect(node.affectedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(node.verifiedFileHashes).toEqual(["sha256:aa"]);
    expect(node.attempts).toBe(3);
    expect(node.lastFailure).toBe("timeout");
    expect(node.completedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(node.invalidationHistory).toHaveLength(1);
    expect(node.invalidationHistory[0]!.condition).toBe("file_hash_changed");
    expect(node.invalidationHistory[0]!.reason).toBe("hash drifted");
    expect(node.invalidationHistory[0]!.evidenceRef).toBe("ev-3");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F2 — setProjectActiveMission ownership validation
// ════════════════════════════════════════════════════════════════════════════
describe("F2 — setProjectActiveMission rejects nonexistent and cross-project missions", () => {
  it("rejects a nonexistent mission", () => {
    const { service } = setup();
    expect(() => service.setProjectActiveMission("p1", "mission-nonexistent"))
      .toThrow(/not found/i);
  });

  it("rejects a mission belonging to a different project", () => {
    const { service, db } = setup();
    const workspace2 = tmp("ek-ws2-");
    // Create a second project in the same DB.
    const projects2 = projectRepository(db);
    projects2.createProject({ id: "p2", name: "proj2", workspacePath: workspace2, createdAt: new Date().toISOString() });
    const repo2 = missionsRepository(db);
    const svc2 = new MissionService({
      repo: repo2, getWorkspacePath: (pid) => (pid === "p2" ? workspace2 : undefined),
      backupDir: tmp("ek-ck2-"),
    });
    const m2 = svc2.create("p2", { objective: "Mission in project 2" });

    // Attempt to point project p1 at a mission belonging to p2 — must fail.
    expect(() => service.setProjectActiveMission("p1", m2.id))
      .toThrow(/belongs to project/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F3 — at-most-one active node DB partial unique index
// ════════════════════════════════════════════════════════════════════════════
describe("F3 — DB-level at-most-one active node index", () => {
  it("direct DB insertion of two active nodes for the same mission fails", () => {
    const { db, service } = setup();
    const m = service.create("p1", { objective: "DB index test" });
    // The first node is already active from creation flow... it's not, it's pending.
    // Insert two rows directly via SQL with status = 'active'.
    expect(() => {
      db.prepare("INSERT INTO mission_requirement_nodes (id, mission_id, ordering, statement, category, source, confidence, approved, authoritative, status, dependencies_json, evidence_refs_json, affected_files_json, verified_file_hashes_json, attempts, last_failure_json, completed_at, invalidation_history_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '[]', '[]', '[]', '[]', 0, NULL, NULL, '[]', ?, ?)").run("r1", m.id, 0, "a", "objective", "user", 1, 1, 1, new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO mission_requirement_nodes (id, mission_id, ordering, statement, category, source, confidence, approved, authoritative, status, dependencies_json, evidence_refs_json, affected_files_json, verified_file_hashes_json, attempts, last_failure_json, completed_at, invalidation_history_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '[]', '[]', '[]', '[]', 0, NULL, NULL, '[]', ?, ?)").run("r2", m.id, 1, "b", "objective", "user", 1, 1, 1, new Date().toISOString(), new Date().toISOString());
    }).toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F4 — truthful cursor state
// ════════════════════════════════════════════════════════════════════════════
describe("F4 — cursor truthfulness", () => {
  it("running mission with pending authoritative work does not expose mark_complete", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Two requirements" });
    repo.addRequirementNodes(m.id, [{
      id: "req-2", order: 1, statement: "Second step", category: "hard_requirement",
      sourcePromptExcerpt: "Second", source: "user", confidence: 1, approved: true, authoritative: true,
    }]);
    service.approveCriteria(m.id); // draft → running
    const cursor = service.getCursor(m.id);
    expect(cursor.allowedNextActions).not.toContain("mark_complete");
    expect(cursor.allowedNextActions).toContain("request_clarification");
  });

  it("running mission with failed authoritative work does not expose mark_complete", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Fail mission" });
    service.approveCriteria(m.id);
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    service.updateRequirementStatus(m.id, req.id, "failed", { failureReason: "broke" });
    const cursor = service.getCursor(m.id);
    expect(cursor.allowedNextActions).not.toContain("mark_complete");
    expect(cursor.allowedNextActions).toContain("request_clarification");
  });

  it("fully satisfied mission exposes mark_complete", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "All done" });
    service.approveCriteria(m.id);
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:abc" });
    const cursor = service.getCursor(m.id);
    expect(cursor.allowedNextActions).toContain("mark_complete");
  });

  it("terminal mission exposes no executable actions", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Terminal" });
    service.approveCriteria(m.id);
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:abc" });
    service.finalize(m.id);
    const cursor = service.getCursor(m.id);
    expect(cursor.allowedNextActions).toEqual([]);
  });

  it("finalize recomputes cursor with correct lastCompletedAction", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Finalize check" });
    service.approveCriteria(m.id);
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:abc" });
    service.finalize(m.id);
    const cursor = service.getCursor(m.id);
    expect(cursor.lastCompletedAction).toBe("finalize");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F5 — valid status transitions
// ════════════════════════════════════════════════════════════════════════════
describe("F5 — valid status transitions", () => {
  it("blocks pending → verified directly", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Block test" });
    const req = service.listRequirementNodes(m.id)[0]!;
    expect(req.status).toBe("pending");
    expect(() => service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:abc" }))
      .toThrow(/must be active/i);
  });

  it("verification requires at least one file hash or evidence ref", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Evidence test" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    expect(() => service.updateRequirementStatus(m.id, req.id, "verified", {}))
      .toThrow(/requires at least one/i);
  });

  it("verification succeeds with evidence refs only (no file hash)", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Evidence refs only" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const v = service.updateRequirementStatus(m.id, req.id, "verified", { evidenceRefs: ["ev-1"] });
    expect(v.status).toBe("verified");
    expect(v.evidenceRefs).toEqual(["ev-1"]);
  });

  it("verification succeeds with file hash only (no evidence refs)", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "File hash only" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const v = service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:abc" });
    expect(v.status).toBe("verified");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F7 — durable invalidation history
// ════════════════════════════════════════════════════════════════════════════
describe("F7 — durable invalidation history", () => {
  it("rejects reopening with blank invalidation reason", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Blank reason" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:abc" });
    expect(() => service.updateRequirementStatus(m.id, req.id, "pending", {
      invalidationCondition: "file_hash_changed",
      invalidationReason: "   ",
    })).toThrow(/non-blank invalidation reason/i);
  });

  it("history accumulates across multiple reopen cycles", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Accumulate" });
    const req = service.listRequirementNodes(m.id)[0]!;
    // First verify.
    service.updateRequirementStatus(m.id, req.id, "active");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:a" });
    // First reopen.
    service.updateRequirementStatus(m.id, req.id, "pending", {
      invalidationCondition: "file_hash_changed",
      invalidationReason: "First reopen",
    });
    // Second verify.
    service.updateRequirementStatus(m.id, req.id, "active");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:b" });
    // Second reopen.
    service.updateRequirementStatus(m.id, req.id, "pending", {
      invalidationCondition: "contract_changed",
      invalidationReason: "Second reopen",
    });
    const node = service.listRequirementNodes(m.id).find((n) => n.id === req.id)!;
    expect(node.invalidationHistory).toHaveLength(2);
    expect(node.invalidationHistory[0]!.condition).toBe("file_hash_changed");
    expect(node.invalidationHistory[0]!.reason).toBe("First reopen");
    expect(node.invalidationHistory[1]!.condition).toBe("contract_changed");
    expect(node.invalidationHistory[1]!.reason).toBe("Second reopen");
  });

  it("invalidation history timestamps persist after reload", () => {
    const { service, dbPath } = setup();
    const m = service.create("p1", { objective: "Timestamp persist" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:x" });
    service.updateRequirementStatus(m.id, req.id, "pending", {
      invalidationCondition: "later_verification_failed",
      invalidationReason: "Test reason",
      invalidationEvidenceRef: "ev-ref-1",
    });
    const r2 = reload(dbPath);
    const node = r2.repo.getRequirementNode(req.id)!;
    expect(node.invalidationHistory).toHaveLength(1);
    expect(node.invalidationHistory[0]!.condition).toBe("later_verification_failed");
    expect(node.invalidationHistory[0]!.reason).toBe("Test reason");
    expect(node.invalidationHistory[0]!.invalidatedAt).toBeTruthy();
    expect(node.invalidationHistory[0]!.evidenceRef).toBe("ev-ref-1");
  });

  it("reopen emits auditable event with evidence ref", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Event audit" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:y" });
    service.updateRequirementStatus(m.id, req.id, "pending", {
      invalidationCondition: "explicit_invalidation",
      invalidationReason: "Human override",
      invalidationEvidenceRef: "ev-99",
    });
    const ev = repo.listEvents(m.id).filter((e) => e.type === "mission.requirement_reopened").at(-1)!;
    expect(ev.data.condition).toBe("explicit_invalidation");
    expect(ev.data.reason).toBe("Human override");
    expect(ev.data.evidenceRef).toBe("ev-99");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F8 — accurate provenance for structured sub-nodes
// ════════════════════════════════════════════════════════════════════════════
describe("F8 — accurate provenance for structured sub-nodes", () => {
  it("each structured node gets its own statement as sourcePromptExcerpt, not the full objective", () => {
    const { service } = setup();
    const m = service.create("p1", {
      objective: "Build a retry queue",
      contract: {
        expectedArtifacts: ["retry-queue.ts"],
        acceptanceCriteria: ["drains within 5s"],
        verificationCommands: [],
        requiredGitResult: null,
        prohibitions: ["no force-push"],
      },
    });
    const nodes = service.listRequirementNodes(m.id);
    const artifactNode = nodes.find((n) => n.category === "expected_artifact")!;
    const criterionNode = nodes.find((n) => n.category === "acceptance_criterion")!;
    const prohibitionNode = nodes.find((n) => n.category === "prohibited_action")!;
    const objectiveNode = nodes.find((n) => n.category === "objective")!;

    // Objective node: excerpt matches the objective.
    expect(objectiveNode.sourcePromptExcerpt).toBe("Build a retry queue");
    // Structured sub-nodes: excerpt is the specific statement, not the objective.
    expect(artifactNode.sourcePromptExcerpt).toBe("retry-queue.ts");
    expect(criterionNode.sourcePromptExcerpt).toBe("drains within 5s");
    expect(prohibitionNode.sourcePromptExcerpt).toBe("no force-push");
  });
});
