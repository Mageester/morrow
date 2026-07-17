import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { missionsRepository, type ContractRequirementNodeInput } from "../src/repositories/missions.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { MissionService } from "../src/mission/service.js";
import type { ReopenCondition, MissionReview } from "@morrow/contracts";

const roots: string[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }));
});

function setup(file?: string) {
  const home = tmp("ek-home-");
  const workspace = tmp("ek-ws-");
  const dbPath = file ?? join(tmp("ek-db-"), "m.db");
  const db = openDatabase(dbPath);
  databases.push(db);
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
  databases.push(db);
  const repo = missionsRepository(db);
  const service = new MissionService({ repo, getWorkspacePath: () => undefined, backupDir: tmp("ek-b-") });
  return { db, repo, service };
}

const FIVE_CONDITIONS: ReopenCondition[] = [
  "dependency_changed", "file_hash_changed", "later_verification_failed", "contract_changed", "explicit_invalidation",
];

// A well-formed, 64-char hex SHA-256 digest (not a real hash — just valid shape).
const GOOD_HASH = "sha256:" + "a".repeat(64);

// Record a real, durable, mission-scoped evidence row and return its id. The
// kernel requires verification/invalidation evidence to reference an existing
// evidence record belonging to the same mission (status "passed" for
// verification), so tests must create one rather than passing an arbitrary
// string like "ev-1".
function addEvidence(repo: ReturnType<typeof missionsRepository>, missionId: string, id: string, status: "passed" | "failed" | "inconclusive" = "passed"): string {
  repo.addEvidence({
    id, missionId, criterionIds: [], type: "command", summary: `evidence ${id}`,
    command: "true", exitCode: 0, outputRef: null, artifactPath: null, status,
  });
  return id;
}

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
    const ev = addEvidence(repo, m.id, "ev-persist");
    service.updateRequirementStatus(m.id, req.id, "active");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [ev] });
    service.advanceCursor(m.id);

    const r2 = reload(dbPath);
    const contract = r2.service.getContract(m.id);
    expect(contract.sourcePrompt).toBe("Persist me");
    expect(contract.requirements[0]!.verifiedFileHashes).toEqual([GOOD_HASH]);
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
    const evPre = addEvidence(repo, m.id, "ev-pre");
    service.updateRequirementStatus(m.id, pre.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [evPre] });
    const activated = service.updateRequirementStatus(m.id, "req-dep", "active");
    expect(activated.status).toBe("active");
  });
});

describe("R11/R12 — verified nodes need persisted invalidation evidence; all five conditions reopen", () => {
  it("rejects reopening a verified node without persisted evidence", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Freeze me" });
    const req = service.listRequirementNodes(m.id)[0]!;
    const ev = addEvidence(repo, m.id, "ev-freeze");
    service.updateRequirementStatus(m.id, req.id, "active");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [ev] });
    expect(() => service.updateRequirementStatus(m.id, req.id, "pending")).toThrow(/persisted invalidation evidence/i);
  });

  it("each of the five conditions reopens and records the reason", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Reopen me" });
    const req = service.listRequirementNodes(m.id)[0]!;
    for (const condition of FIVE_CONDITIONS) {
      service.updateRequirementStatus(m.id, req.id, "active");
      const evV = addEvidence(repo, m.id, `ev-v-${condition}`);
      service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [evV] });
      const reason = `Reopened because ${condition}`;
      const evR = addEvidence(repo, m.id, `ev-r-${condition}`, "failed");
      const reopened = service.updateRequirementStatus(m.id, req.id, "pending", {
        invalidationCondition: condition,
        invalidationReason: reason,
        invalidationEvidenceRef: evR,
      });
      expect(reopened.status).toBe("pending");
      expect(reopened.invalidationHistory.some((e) => e.condition === condition)).toBe(true);
      expect(reopened.invalidationHistory.some((e) => e.reason === reason)).toBe(true);
      expect(reopened.invalidationHistory.some((e) => e.evidenceRef === evR)).toBe(true);
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
    const evR13 = addEvidence(repo, m.id, "ev-r13");
    service.updateRequirementStatus(m.id, n1.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [evR13] });

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
    const evR16 = addEvidence(repo, m.id, "ev-r16");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [evR16] });
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
    const { service, repo } = setup();
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
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "All done" });
    service.approveCriteria(m.id);
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const evF4a = addEvidence(repo, m.id, "ev-f4a");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [evF4a] });
    const cursor = service.getCursor(m.id);
    expect(cursor.allowedNextActions).toContain("mark_complete");
  });

  it("terminal mission exposes no executable actions", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Terminal" });
    service.approveCriteria(m.id);
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const evF4b = addEvidence(repo, m.id, "ev-f4b");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [evF4b] });
    service.finalize(m.id);
    const cursor = service.getCursor(m.id);
    expect(cursor.allowedNextActions).toEqual([]);
  });

  it("finalize recomputes cursor with correct lastCompletedAction", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Finalize check" });
    service.approveCriteria(m.id);
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const evF4c = addEvidence(repo, m.id, "ev-f4c");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [evF4c] });
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
      .toThrow(/Invalid requirement transition/i);
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
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Evidence refs only" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const ev = addEvidence(repo, m.id, "ev-1");
    const v = service.updateRequirementStatus(m.id, req.id, "verified", { evidenceRefs: [ev] });
    expect(v.status).toBe("verified");
    expect(v.evidenceRefs).toEqual([ev]);
  });

  // BLOCKER 1 regression: a hash-shaped string alone must NEVER be trusted
  // proof of completion. This test used to be misleadingly named "file hash
  // only" while actually also supplying evidenceRefs — it is corrected here
  // to genuinely exercise hash-only verification and assert it is rejected.
  it("verification is REJECTED with a valid file hash only (no durable evidence reference)", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Hash only must be rejected" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    expect(() => service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH }))
      .toThrow(/requires at least one/i);
    // No fabrication: the node must remain unverified.
    const after = service.listRequirementNodes(m.id).find((n) => n.id === req.id)!;
    expect(after.status).toBe("active");
    expect(after.verifiedFileHashes).toEqual([]);
  });

  it("verification succeeds with durable evidence PLUS a valid file hash", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Evidence plus hash" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const ev = addEvidence(repo, m.id, "ev-fh");
    const v = service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [ev] });
    expect(v.status).toBe("verified");
    expect(v.verifiedFileHashes).toEqual([GOOD_HASH]);
    expect(v.evidenceRefs).toEqual([ev]);
  });

  it("fabricated hashes alone cannot produce a successful mission completion", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "No fabricated completion" });
    service.approveCriteria(m.id);
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    // A caller supplies a well-formed but entirely fabricated hash and no
    // durable evidence — this must be rejected outright.
    expect(() => service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH }))
      .toThrow(/requires at least one/i);
    // The node stays open, so finalize can never grade this mission complete.
    const finalized = service.finalize(m.id);
    expect(finalized.status).not.toBe("completed");
    expect(finalized.status).not.toBe("completed_with_reservations");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F7 — durable invalidation history
// ════════════════════════════════════════════════════════════════════════════
describe("F7 — durable invalidation history", () => {
  it("rejects reopening with blank invalidation reason", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Blank reason" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const evBr = addEvidence(repo, m.id, "ev-br");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [evBr] });
    expect(() => service.updateRequirementStatus(m.id, req.id, "pending", {
      invalidationCondition: "file_hash_changed",
      invalidationReason: "   ",
    })).toThrow(/non-blank invalidation reason/i);
  });

  it("history accumulates across multiple reopen cycles", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Accumulate" });
    const req = service.listRequirementNodes(m.id)[0]!;
    // First verify.
    service.updateRequirementStatus(m.id, req.id, "active");
    const ev1 = addEvidence(repo, m.id, "ev-1");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [ev1] });
    // First reopen.
    const re1 = addEvidence(repo, m.id, "ev-r1", "failed");
    service.updateRequirementStatus(m.id, req.id, "pending", {
      invalidationCondition: "file_hash_changed",
      invalidationReason: "First reopen",
      invalidationEvidenceRef: re1,
    });
    // Second verify.
    service.updateRequirementStatus(m.id, req.id, "active");
    const ev2 = addEvidence(repo, m.id, "ev-2");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [ev2] });
    // Second reopen.
    const re2 = addEvidence(repo, m.id, "ev-r2", "failed");
    service.updateRequirementStatus(m.id, req.id, "pending", {
      invalidationCondition: "contract_changed",
      invalidationReason: "Second reopen",
      invalidationEvidenceRef: re2,
    });
    const node = service.listRequirementNodes(m.id).find((n) => n.id === req.id)!;
    expect(node.invalidationHistory).toHaveLength(2);
    expect(node.invalidationHistory[0]!.condition).toBe("file_hash_changed");
    expect(node.invalidationHistory[0]!.reason).toBe("First reopen");
    expect(node.invalidationHistory[1]!.condition).toBe("contract_changed");
    expect(node.invalidationHistory[1]!.reason).toBe("Second reopen");
  });

  it("invalidation history timestamps persist after reload", () => {
    const { service, dbPath, repo } = setup();
    const m = service.create("p1", { objective: "Timestamp persist" });
    const req = service.listRequirementNodes(m.id)[0]!;
    const evV = addEvidence(repo, m.id, "ev-v");
    service.updateRequirementStatus(m.id, req.id, "active");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [evV] });
    const evR = addEvidence(repo, m.id, "ev-ref-1", "failed");
    service.updateRequirementStatus(m.id, req.id, "pending", {
      invalidationCondition: "later_verification_failed",
      invalidationReason: "Test reason",
      invalidationEvidenceRef: evR,
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
    const evV = addEvidence(repo, m.id, "ev-v");
    service.updateRequirementStatus(m.id, req.id, "active");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [evV] });
    const evR = addEvidence(repo, m.id, "ev-99", "failed");
    service.updateRequirementStatus(m.id, req.id, "pending", {
      invalidationCondition: "explicit_invalidation",
      invalidationReason: "Human override",
      invalidationEvidenceRef: evR,
    });
    const ev = repo.listEvents(m.id).filter((e) => e.type === "mission.requirement_reopened").at(-1)!;
    expect(ev.data.condition).toBe("explicit_invalidation");
    expect(ev.data.reason).toBe("Human override");
    expect(ev.data.evidenceRef).toBe("ev-99");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F6 — ledger-gated finalization (completion cannot be declared while an
//      authoritative requirement remains open)
// ════════════════════════════════════════════════════════════════════════════
describe("F6 — ledger-gated finalization", () => {
  function approvedReview(missionId: string): MissionReview {
    // approved_with_risks grades as completed_with_reservations even when no
    // criterion has been explicitly verified, which isolates the ledger gate.
    return {
      id: `review-${missionId}`, missionId, verdict: "approved_with_risks",
      criterionJudgments: [], regressionRisks: [], suspiciousChanges: [],
      missingVerification: [], concerns: [], recommendedStatus: "completed",
      summary: "approved with risks", reviewerProvider: "test", reviewerModel: "test",
      createdAt: new Date().toISOString(),
    };
  }

  it("downgrades a 'completed' grade to partially_completed when an authoritative requirement is still pending", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Ledger gate" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "Independent reviewer verdict" });
    // An explicit authoritative requirement that is left unsatisfied.
    repo.addRequirementNodes(m.id, [{
      id: "req-open", order: 1, statement: "Deliver the report", category: "hard_requirement",
      sourcePromptExcerpt: "Ledger gate", source: "user", confidence: 1, approved: true, authoritative: true,
    }]);
    service.setReview(approvedReview(m.id)); // verifies the objective node, NOT req-open
    const finalized = service.finalize(m.id);
    expect(finalized.status).toBe("partially_completed");
    const completed = repo.listEvents(m.id).find((e) => e.type === "mission.completed")!;
    expect(completed.data.ledgerGated).toBe(true);
    expect(completed.data.authoritativeSatisfied).toBe(false);
  });

  it("allows completion when every authoritative requirement is satisfied", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Ledger ok" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "Independent reviewer verdict" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const ev = addEvidence(repo, m.id, "ev-gate");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [ev] });
    service.setReview(approvedReview(m.id)); // verifies the objective node too
    const finalized = service.finalize(m.id);
    expect(finalized.status).toBe("completed_with_reservations");
    const completed = repo.listEvents(m.id).find((e) => e.type === "mission.completed")!;
    expect(completed.data.ledgerGated).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F9 — atomic creation & atomic status transitions (no partial persistence)
// ════════════════════════════════════════════════════════════════════════════
describe("F9 — atomic creation & transitions (fault injection)", () => {
  it("cursor write throws during create → no mission/contract/nodes/events/pointer/cursor survives", () => {
    const { dbPath, service, repo } = setup();
    // Capture the would-be mission id, then fault-inject the cursor write to
    // fail inside the creation transaction.
    let createdId: string | undefined;
    const origCreate = repo.create.bind(repo);
    repo.create = ((input: Parameters<typeof repo.create>[0], now?: string) => { createdId = input.id; return origCreate(input, now); }) as typeof repo.create;
    repo.upsertCursor = () => { throw new Error("injected cursor failure"); };
    expect(() => service.create("p1", { objective: "Atomic create" })).toThrow(/injected cursor failure/);
    // Reopen from the same file: the entire transaction must have rolled back.
    const r2 = reload(dbPath);
    expect(r2.repo.get(createdId!)).toBeUndefined();
    expect(r2.repo.getCursor(createdId!)).toBeUndefined();
  });

  it("event append throws during mission transition → status and event both roll back", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Atomic transition" });
    repo.appendEvent = () => { throw new Error("injected event failure"); };
    expect(() => service.approveCriteria(m.id)).toThrow(/injected event failure/);
    // Neither the status change nor the event may survive.
    expect(repo.get(m.id)!.status).toBe("draft");
    expect(repo.listEvents(m.id).some((e) => e.type === "mission.status_changed")).toBe(false);
  });

  it("event/freeze/cursor write throws during requirement verify → node stays pending, no event", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Atomic req" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const ev = addEvidence(repo, m.id, "ev-atomic");
    repo.appendEvent = () => { throw new Error("injected event failure"); };
    expect(() => service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [ev] }))
      .toThrow(/injected event failure/);
    const after = service.listRequirementNodes(m.id).find((n) => n.id === req.id)!;
    expect(after.status).toBe("active"); // verification rolled back
    expect(after.verifiedFileHashes).toEqual([]);
    expect(after.completedAt).toBeNull();
    expect(repo.listEvents(m.id).some((e) => e.type === "mission.requirement_status_changed" && e.data.to === "verified")).toBe(false);
  });

  it("reopen failure preserves the verified node and its complete prior history", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Atomic reopen" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const evV = addEvidence(repo, m.id, "ev-rv");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [evV] });
    // Fault-inject the history append so the reopen transaction aborts.
    repo.appendInvalidationEntry = () => { throw new Error("injected reopen failure"); };
    const evR = addEvidence(repo, m.id, "ev-rr", "failed");
    expect(() => service.updateRequirementStatus(m.id, req.id, "pending", {
      invalidationCondition: "file_hash_changed", invalidationReason: "drift", invalidationEvidenceRef: evR,
    })).toThrow(/injected reopen failure/);
    const after = service.listRequirementNodes(m.id).find((n) => n.id === req.id)!;
    expect(after.status).toBe("verified"); // reopen rolled back
    expect(after.invalidationHistory).toHaveLength(0);
    expect(repo.listEvents(m.id).some((e) => e.type === "mission.requirement_reopened")).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F10 — durable, mission-scoped verification evidence (no arbitrary strings)
// ════════════════════════════════════════════════════════════════════════════
describe("F10 — durable verification evidence", () => {
  it("rejects a blank/whitespace evidence reference", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Blank evidence" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    expect(() => service.updateRequirementStatus(m.id, req.id, "verified", { evidenceRefs: ["  "] }))
      .toThrow(/blank/i);
  });

  it("rejects a reference to nonexistent evidence", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Ghost evidence" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    expect(() => service.updateRequirementStatus(m.id, req.id, "verified", { evidenceRefs: ["ev-does-not-exist"] }))
      .toThrow(/does not exist/i);
  });

  it("rejects a reference to evidence belonging to a different mission", () => {
    const { service, repo } = setup();
    const mA = service.create("p1", { objective: "Mission A evidence" });
    const mB = service.create("p1", { objective: "Mission B evidence" });
    const cross = addEvidence(repo, mA.id, "ev-cross");
    const reqB = service.listRequirementNodes(mB.id)[0]!;
    service.updateRequirementStatus(mB.id, reqB.id, "active");
    expect(() => service.updateRequirementStatus(mB.id, reqB.id, "verified", { evidenceRefs: [cross] }))
      .toThrow(/different mission/i);
  });

  it("rejects a malformed file hash", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Bad hash" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const ev = addEvidence(repo, m.id, "ev-badhash");
    expect(() => service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:xyz", evidenceRefs: [ev] }))
      .toThrow(/malformed/i);
  });

  it("rejects evidence that is not in a passed state", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Failed evidence" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const failed = addEvidence(repo, m.id, "ev-failed", "failed");
    expect(() => service.updateRequirementStatus(m.id, req.id, "verified", { evidenceRefs: [failed] }))
      .toThrow(/not acceptable/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F8 — accurate provenance for structured sub-nodes
// ════════════════════════════════════════════════════════════════════════════
describe("F8 — accurate provenance for structured sub-nodes", () => {
  it("structured values absent from the prompt expose empty excerpt + structured locator", () => {
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

    // Raw-prompt objective value: excerpt is an exact substring of the prompt,
    // and there is no structured locator.
    expect(objectiveNode.sourcePromptExcerpt).toBe("Build a retry queue");
    expect(objectiveNode.sourceLocator).toBeNull();

    // Structured-only values that do NOT occur in the raw prompt: the excerpt is
    // empty (never fabricated to equal the statement), and provenance is carried
    // by the structured locator instead.
    expect(artifactNode.sourcePromptExcerpt).toBe("");
    expect(artifactNode.sourceLocator).toBe("contract.expectedArtifacts[0]");
    expect(criterionNode.sourcePromptExcerpt).toBe("");
    expect(criterionNode.sourceLocator).toBe("contract.acceptanceCriteria[0]");
    expect(prohibitionNode.sourcePromptExcerpt).toBe("");
    expect(prohibitionNode.sourceLocator).toBe("contract.prohibitions[0]");
  });

  it("conflicting contract.objective records the structured locator, not the raw prompt", () => {
    const { service } = setup();
    const m = service.create("p1", {
      objective: "Ship the thing",
      contract: {
        objective: "Implement the retry queue module",
        expectedArtifacts: [],
        acceptanceCriteria: [],
        verificationCommands: [],
        requiredGitResult: null,
        prohibitions: [],
      },
    });
    const contract = service.getContract(m.id);
    const objectiveNode = service.listRequirementNodes(m.id).find((n) => n.category === "objective")!;
    // The conflict rule: the structured objective value is the node statement,
    // but because it does NOT occur verbatim in the raw source prompt the
    // excerpt is EMPTY and the exact structured path is the locator. Raw-prompt
    // text is never smuggled into the excerpt.
    expect(contract.objective).toBe("Implement the retry queue module");
    expect(objectiveNode.statement).toBe("Implement the retry queue module");
    expect(objectiveNode.sourcePromptExcerpt).toBe("");
    expect(objectiveNode.sourceLocator).toBe("contract.objective");
  });

  it("a structured value that genuinely occurs in the prompt is excerpted", () => {
    const { service } = setup();
    const m = service.create("p1", {
      objective: "Add retry-queue.ts and meet the drains within 5s requirement",
      contract: {
        expectedArtifacts: ["retry-queue.ts"],
        acceptanceCriteria: ["drains within 5s"],
        verificationCommands: [],
        requiredGitResult: null,
        prohibitions: [],
      },
    });
    const nodes = service.listRequirementNodes(m.id);
    const artifactNode = nodes.find((n) => n.category === "expected_artifact")!;
    const criterionNode = nodes.find((n) => n.category === "acceptance_criterion")!;
    // These values DO appear verbatim in the source prompt, so they are excerpted
    // AND the locator is null (the prompt is the authority, not the structured path).
    expect(artifactNode.sourcePromptExcerpt).toBe("retry-queue.ts");
    expect(artifactNode.sourceLocator).toBeNull();
    expect(criterionNode.sourcePromptExcerpt).toBe("drains within 5s");
    expect(criterionNode.sourceLocator).toBeNull();
  });

  it("duplicate structured values receive distinct locators", () => {
    const { service } = setup();
    const m = service.create("p1", {
      objective: "Make two reports",
      contract: {
        expectedArtifacts: ["report.ts", "report.ts"],
        acceptanceCriteria: [],
        verificationCommands: [],
        requiredGitResult: null,
        prohibitions: [],
      },
    });
    const artifacts = service.listRequirementNodes(m.id).filter((n) => n.category === "expected_artifact");
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]!.sourceLocator).toBe("contract.expectedArtifacts[0]");
    expect(artifacts[1]!.sourceLocator).toBe("contract.expectedArtifacts[1]");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F11 — review application is ONE atomic service transaction (invariant 2)
// ════════════════════════════════════════════════════════════════════════════
describe("F11 — review application is one atomic transaction", () => {
  function approvedReview(missionId: string): MissionReview {
    return {
      id: `review-${missionId}-${Math.random().toString(36).slice(2)}`, missionId, verdict: "approved",
      criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [],
      concerns: [], recommendedStatus: "completed", summary: "approved", reviewerProvider: "test", reviewerModel: "test",
      createdAt: new Date().toISOString(),
    };
  }

  function prepareReviewable(repo: ReturnType<typeof missionsRepository>, service: MissionService) {
    const m = service.create("p1", { objective: "Reviewable mission" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "Independent reviewer verdict" });
    return m;
  }

  // After any single failure inside the applyReview transaction, NOTHING about
  // the review may survive: review row, budget increment, evidence, criterion
  // verification, objective-node verification, the completed event, freeze, and
  // cursor must all roll back together.
  function expectReviewRolledBack(repo: ReturnType<typeof missionsRepository>, service: MissionService, m: { id: string }, faultMethod: keyof ReturnType<typeof missionsRepository>): void {
    const objective = service.listRequirementNodes(m.id)[0]!;
    const before = {
      status: objective.status,
      reviewCycles: repo.get(m.id)!.budget.reviewCyclesUsed,
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
      cursor: JSON.stringify(service.getCursor(m.id)),
    };
    const orig = (repo as any)[faultMethod];
    (repo as any)[faultMethod] = () => { throw new Error(`injected ${String(faultMethod)} failure`); };
    try {
      expect(() => service.setReview(approvedReview(m.id))).toThrow(/injected.*failure/);
      // Whole application rolled back:
      expect(repo.get(m.id)!.finalReview).toBeNull();
      expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(before.reviewCycles);
      expect(repo.listEvidence(m.id)).toHaveLength(0);
      const obj = service.listRequirementNodes(m.id).find((n) => n.id === objective.id)!;
      expect(obj.status).toBe(before.status); // objective node never verified
      expect(obj.verifiedFileHashes).toEqual([]);
      expect(obj.evidenceRefs).toEqual([]);
      expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
      expect(JSON.stringify(service.getCursor(m.id))).toBe(before.cursor);
    } finally {
      // MINOR — restore the monkeypatch via try/finally so a failed assertion
      // above can never leak a broken repo method into a later test.
      (repo as any)[faultMethod] = orig;
    }
  }

  // MINOR — event fault injection targets the EXACT event type rather than
  // faulting every appendEvent call indiscriminately, so a LATE-stage failure
  // (the final "mission.review_completed" event, appended after evidence,
  // criteria, and the objective node have already been written to the
  // transaction) is proven to roll back too — not just whichever event
  // happens to be appended first. The injected error/stage is asserted
  // exactly, and the monkeypatch is restored via try/finally regardless of
  // assertion outcome.
  function expectReviewEventRolledBack(repo: ReturnType<typeof missionsRepository>, service: MissionService, m: { id: string }, eventType: string): void {
    const objective = service.listRequirementNodes(m.id)[0]!;
    const before = {
      status: objective.status,
      reviewCycles: repo.get(m.id)!.budget.reviewCyclesUsed,
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
      evidence: repo.listEvidence(m.id).length,
      cursor: JSON.stringify(service.getCursor(m.id)),
    };
    const origAppendEvent = repo.appendEvent.bind(repo);
    repo.appendEvent = ((missionId: string, type: Parameters<typeof repo.appendEvent>[1], summary: string, data?: Record<string, unknown>, now?: string) => {
      if (type === eventType) throw new Error(`injected ${eventType} failure`);
      return origAppendEvent(missionId, type, summary, data, now);
    }) as typeof repo.appendEvent;
    try {
      expect(() => service.setReview(approvedReview(m.id))).toThrow(new RegExp(`injected ${eventType.replace(/\./g, "\\.")} failure`));
      expect(repo.get(m.id)!.finalReview).toBeNull();
      expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(before.reviewCycles);
      expect(repo.listEvidence(m.id)).toHaveLength(before.evidence);
      const obj = service.listRequirementNodes(m.id).find((n) => n.id === objective.id)!;
      expect(obj.status).toBe(before.status);
      expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
      expect(JSON.stringify(service.getCursor(m.id))).toBe(before.cursor);
    } finally {
      repo.appendEvent = origAppendEvent;
    }
  }

  it("review persistence failure rolls back the whole application", () => {
    const { service, repo } = setup();
    const m = prepareReviewable(repo, service);
    expectReviewRolledBack(repo, service, m, "setReview");
  });

  it("budget persistence failure rolls back the whole application", () => {
    const { service, repo } = setup();
    const m = prepareReviewable(repo, service);
    expectReviewRolledBack(repo, service, m, "updateBudget");
  });

  it("evidence persistence failure rolls back the whole application", () => {
    const { service, repo } = setup();
    const m = prepareReviewable(repo, service);
    expectReviewRolledBack(repo, service, m, "addEvidence");
  });

  it("criterion persistence failure rolls back the whole application", () => {
    const { service, repo } = setup();
    const m = prepareReviewable(repo, service);
    expectReviewRolledBack(repo, service, m, "updateCriterion");
  });

  it("requirement-node persistence failure rolls back the whole application", () => {
    const { service, repo } = setup();
    const m = prepareReviewable(repo, service);
    expectReviewRolledBack(repo, service, m, "updateRequirementNode");
  });

  it("event persistence failure rolls back the whole application", () => {
    const { service, repo } = setup();
    const m = prepareReviewable(repo, service);
    expectReviewRolledBack(repo, service, m, "appendEvent");
  });

  it("contract-freeze persistence failure rolls back the whole application", () => {
    const { service, repo } = setup();
    const m = prepareReviewable(repo, service);
    expectReviewRolledBack(repo, service, m, "setContractFrozen");
  });

  it("cursor persistence failure rolls back the whole application", () => {
    const { service, repo } = setup();
    const m = prepareReviewable(repo, service);
    expectReviewRolledBack(repo, service, m, "upsertCursor");
  });

  it("a non-approval does not auto-verify the objective node or unrelated requirements", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Revisions required" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });
    const review: MissionReview = { ...approvedReview(m.id), verdict: "revisions_required" };
    service.setReview(review);
    // Review-kind criterion is failed (honest), objective node is untouched.
    const reviewKind = repo.get(m.id)!.criteria.find((c) => c.verification.kind === "review")!;
    expect(reviewKind.state).toBe("failed");
    const objective = service.listRequirementNodes(m.id)[0]!;
    expect(objective.status).toBe("pending");
    // revisions_required is still backed by durable, mission-scoped evidence
    // recording the reviewer's rejection — never only a prose event.
    const evidence = repo.listEvidence(m.id).find((e) => e.type === "review")!;
    expect(evidence).toBeDefined();
    expect(evidence.status).toBe("failed");
    expect(evidence.missionId).toBe(m.id);
  });

  it("insufficient_evidence creates inconclusive durable evidence and leaves the ledger untouched", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Insufficient evidence" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });
    const review: MissionReview = { ...approvedReview(m.id), verdict: "insufficient_evidence" };
    service.setReview(review);
    const evidence = repo.listEvidence(m.id).find((e) => e.type === "review")!;
    expect(evidence).toBeDefined();
    expect(evidence.status).toBe("inconclusive");
    expect(evidence.missionId).toBe(m.id);
    // insufficient_evidence does not positively fail the reviewer criterion —
    // it simply proves nothing — and never touches the objective node.
    const reviewKind = repo.get(m.id)!.criteria.find((c) => c.verification.kind === "review")!;
    expect(reviewKind.state).not.toBe("verified");
    const objective = service.listRequirementNodes(m.id)[0]!;
    expect(objective.status).toBe("pending");
    expect(repo.get(m.id)!.finalReview?.verdict).toBe("insufficient_evidence");
  });

  it("insufficient_evidence: evidence persistence failure rolls back the whole application", () => {
    const { service, repo } = setup();
    const m = prepareReviewable(repo, service);
    const objective = service.listRequirementNodes(m.id)[0]!;
    const before = {
      status: objective.status,
      reviewCycles: repo.get(m.id)!.budget.reviewCyclesUsed,
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
    };
    repo.addEvidence = () => { throw new Error("injected addEvidence failure"); };
    const review: MissionReview = { ...approvedReview(m.id), verdict: "insufficient_evidence" };
    expect(() => service.setReview(review)).toThrow(/injected addEvidence failure/);
    expect(repo.get(m.id)!.finalReview).toBeNull();
    expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(before.reviewCycles);
    expect(repo.listEvidence(m.id)).toHaveLength(0);
    const obj = service.listRequirementNodes(m.id).find((n) => n.id === objective.id)!;
    expect(obj.status).toBe(before.status);
    expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
  });

  it("approved_with_risks: evidence persistence failure rolls back the whole application", () => {
    const { service, repo } = setup();
    const m = prepareReviewable(repo, service);
    const review: MissionReview = { ...approvedReview(m.id), verdict: "approved_with_risks" };
    const objective = service.listRequirementNodes(m.id)[0]!;
    const before = {
      status: objective.status,
      reviewCycles: repo.get(m.id)!.budget.reviewCyclesUsed,
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
      cursor: JSON.stringify(service.getCursor(m.id)),
    };
    repo.addEvidence = () => { throw new Error("injected addEvidence failure"); };
    expect(() => service.setReview(review)).toThrow(/injected addEvidence failure/);
    expect(repo.get(m.id)!.finalReview).toBeNull();
    expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(before.reviewCycles);
    expect(repo.listEvidence(m.id)).toHaveLength(0);
    const obj = service.listRequirementNodes(m.id).find((n) => n.id === objective.id)!;
    expect(obj.status).toBe(before.status);
    expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
    expect(JSON.stringify(service.getCursor(m.id))).toBe(before.cursor);
  });

  it("approved_with_risks approves and verifies the objective node with passed evidence", () => {
    const { service, repo } = setup();
    const m = prepareReviewable(repo, service);
    const review: MissionReview = { ...approvedReview(m.id), verdict: "approved_with_risks" };
    service.setReview(review);
    const evidence = repo.listEvidence(m.id).find((e) => e.type === "review")!;
    expect(evidence.status).toBe("passed");
    const objective = service.listRequirementNodes(m.id)[0]!;
    expect(objective.status).toBe("verified");
    expect(objective.evidenceRefs).toContain(evidence.id);
  });

  // MINOR — a LATE failure (the final event in the approving branch) must
  // roll back the whole review application exactly as an early failure does.
  it("a LATE mission.review_completed event failure rolls back the whole application", () => {
    const { service, repo } = setup();
    const m = prepareReviewable(repo, service);
    expectReviewEventRolledBack(repo, service, m, "mission.review_completed");
  });

  it("an early mission.evidence_recorded event failure rolls back the whole application", () => {
    const { service, repo } = setup();
    const m = prepareReviewable(repo, service);
    expectReviewEventRolledBack(repo, service, m, "mission.evidence_recorded");
  });

  it("a mission.criterion_verified event failure rolls back the whole application", () => {
    const { service, repo } = setup();
    const m = prepareReviewable(repo, service);
    expectReviewEventRolledBack(repo, service, m, "mission.criterion_verified");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MINOR — review START is atomic (running → reviewing, status_changed, and
// review_started all commit or roll back together, BEFORE any provider call)
// ════════════════════════════════════════════════════════════════════════════
describe("MINOR — review start is atomic", () => {
  it("mission.review_started failure during review start rolls back the transition entirely", async () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Review start rollback" });
    service.approveCriteria(m.id);
    expect(repo.get(m.id)!.status).toBe("running");
    const before = {
      status: repo.get(m.id)!.status,
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
    };
    const origAppendEvent = repo.appendEvent.bind(repo);
    repo.appendEvent = ((missionId: string, type: Parameters<typeof repo.appendEvent>[1], summary: string, data?: Record<string, unknown>, now?: string) => {
      if (type === "mission.review_started") throw new Error("injected mission.review_started failure");
      return origAppendEvent(missionId, type, summary, data, now);
    }) as typeof repo.appendEvent;
    try {
      // runReview() is async but the transition happens synchronously before
      // any `await`, so the injected failure surfaces as a rejected promise.
      await expect(service.runReview(m.id)).rejects.toThrow(/injected mission\.review_started failure/);
      expect(repo.get(m.id)!.status).toBe(before.status); // still "running", never "reviewing"
      expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events); // no status_changed either
    } finally {
      repo.appendEvent = origAppendEvent;
    }
  });

  it("mission.status_changed failure during review start rolls back the transition (and review_started never persists)", async () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Review start status rollback" });
    service.approveCriteria(m.id);
    const before = {
      status: repo.get(m.id)!.status,
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
    };
    const origAppendEvent = repo.appendEvent.bind(repo);
    repo.appendEvent = ((missionId: string, type: Parameters<typeof repo.appendEvent>[1], summary: string, data?: Record<string, unknown>, now?: string) => {
      if (type === "mission.status_changed") throw new Error("injected mission.status_changed failure");
      return origAppendEvent(missionId, type, summary, data, now);
    }) as typeof repo.appendEvent;
    try {
      await expect(service.runReview(m.id)).rejects.toThrow(/injected mission\.status_changed failure/);
      expect(repo.get(m.id)!.status).toBe(before.status);
      expect(repo.listEvents(m.id).some((e) => e.type === "mission.review_started")).toBe(false);
      expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
    } finally {
      repo.appendEvent = origAppendEvent;
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F12 — finalization is fully atomic (result + status + events + cursor)
// ════════════════════════════════════════════════════════════════════════════
describe("F12 — finalization is fully atomic and internally consistent", () => {
  function approvedReview(missionId: string): MissionReview {
    return {
      id: `review-${missionId}-${Math.random().toString(36).slice(2)}`, missionId, verdict: "approved",
      criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [],
      concerns: [], recommendedStatus: "completed", summary: "approved", reviewerProvider: "test", reviewerModel: "test",
      createdAt: new Date().toISOString(),
    };
  }

  function verifyObjective(repo: ReturnType<typeof missionsRepository>, service: MissionService, m: { id: string }): void {
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const ev = addEvidence(repo, m.id, `ev-fin-${m.id}`);
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [ev] });
  }

  it("successful completed finalization commits result, status, events, and cursor together", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Complete me" });
    service.approveCriteria(m.id);
    verifyObjective(repo, service, m);
    // A concrete criterion the independent review approves so the grade is full.
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });
    service.setReview(approvedReview(m.id));
    const finalized = service.finalize(m.id);
    expect(finalized.status).toBe("completed");
    expect(repo.get(m.id)!.status).toBe("completed"); // persisted status agrees
    const result = repo.get(m.id)!.result!;
    expect(result.status).toBe("completed"); // result matches persisted status
    const statusEvent = repo.listEvents(m.id).filter((e) => e.type === "mission.status_changed").at(-1)!;
    expect(statusEvent.data.to).toBe("completed"); // status event target agrees
    const completed = repo.listEvents(m.id).find((e) => e.type === "mission.completed")!;
    expect(completed.data.status).toBe("completed"); // completed-event status agrees
    const cursor = service.getCursor(m.id);
    expect(cursor.allowedNextActions).toEqual([]); // terminal cursor, same final status
    expect(cursor.lastCompletedAction).toBe("finalize");
  });

  it("ledger-gated finalization records partially_completed consistently", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Gated" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });
    repo.addRequirementNodes(m.id, [{
      id: "req-open", order: 1, statement: "Deliver the report", category: "hard_requirement",
      sourcePromptExcerpt: "Gated", source: "user", confidence: 1, approved: true, authoritative: true,
    }]);
    service.setReview({
      id: `review-${m.id}`, missionId: m.id, verdict: "approved_with_risks",
      criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [],
      concerns: [], recommendedStatus: "completed", summary: "approved with risks",
      reviewerProvider: "test", reviewerModel: "test", createdAt: new Date().toISOString(),
    });
    const finalized = service.finalize(m.id);
    expect(finalized.status).toBe("partially_completed");
    expect(repo.get(m.id)!.result!.status).toBe("partially_completed");
    expect(repo.listEvents(m.id).find((e) => e.type === "mission.completed")!.data.status).toBe("partially_completed");
    expect(service.getCursor(m.id).allowedNextActions).toEqual([]);
  });

  function expectFinalizeRolledBack(repo: ReturnType<typeof missionsRepository>, service: MissionService, m: { id: string }, faultMethod: keyof ReturnType<typeof missionsRepository>): void {
    const before = {
      status: repo.get(m.id)!.status,
      result: repo.get(m.id)!.result,
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
      cursor: JSON.stringify(service.getCursor(m.id)),
    };
    const orig = (repo as any)[faultMethod];
    (repo as any)[faultMethod] = () => { throw new Error(`injected ${String(faultMethod)} failure`); };
    try {
      expect(() => service.finalize(m.id)).toThrow(/injected.*failure/);
      // Nothing partial persists:
      const after = repo.get(m.id)!;
      expect(after.status).toBe(before.status);
      expect(after.result).toBe(before.result);
      expect(after.completedAt).toBeNull();
      expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
      expect(JSON.stringify(service.getCursor(m.id))).toBe(before.cursor);
    } finally {
      (repo as any)[faultMethod] = orig;
    }
  }

  // finalize() appends two distinct event types (mission.status_changed,
  // mission.completed). Faulting them by matching the actual `type` argument
  // proves rollback at each named stage separately, instead of one ambiguous
  // "event failure" that only ever hits whichever event is appended first.
  // The monkeypatch is restored via try/finally regardless of assertion outcome.
  function expectFinalizeEventRolledBack(repo: ReturnType<typeof missionsRepository>, service: MissionService, m: { id: string }, eventType: string): void {
    const before = {
      status: repo.get(m.id)!.status,
      result: repo.get(m.id)!.result,
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
      cursor: JSON.stringify(service.getCursor(m.id)),
    };
    const origAppendEvent = repo.appendEvent.bind(repo);
    repo.appendEvent = ((missionId: string, type: Parameters<typeof repo.appendEvent>[1], summary: string, data?: Record<string, unknown>, now?: string) => {
      if (type === eventType) throw new Error(`injected ${eventType} failure`);
      return origAppendEvent(missionId, type, summary, data, now);
    }) as typeof repo.appendEvent;
    try {
      expect(() => service.finalize(m.id)).toThrow(new RegExp(`injected ${eventType.replace(/\./g, "\\.")} failure`));
      const after = repo.get(m.id)!;
      expect(after.status).toBe(before.status);
      expect(after.result).toBe(before.result);
      expect(after.completedAt).toBeNull();
      expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
      expect(JSON.stringify(service.getCursor(m.id))).toBe(before.cursor);
    } finally {
      repo.appendEvent = origAppendEvent;
    }
  }

  it("status event (mission.status_changed) failure rolls back the entire finalization", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Fin status event" });
    service.approveCriteria(m.id);
    verifyObjective(repo, service, m);
    expectFinalizeEventRolledBack(repo, service, m, "mission.status_changed");
  });

  it("completed event (mission.completed) failure rolls back the entire finalization", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Fin completed event" });
    service.approveCriteria(m.id);
    verifyObjective(repo, service, m);
    expectFinalizeEventRolledBack(repo, service, m, "mission.completed");
  });

  it("status persistence failure rolls back the entire finalization", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Fin status" });
    service.approveCriteria(m.id);
    verifyObjective(repo, service, m);
    expectFinalizeRolledBack(repo, service, m, "setStatus");
  });

  it("result failure rolls back the entire finalization", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Fin result" });
    service.approveCriteria(m.id);
    verifyObjective(repo, service, m);
    expectFinalizeRolledBack(repo, service, m, "setResult");
  });

  it("cursor failure rolls back the entire finalization", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Fin cursor" });
    service.approveCriteria(m.id);
    verifyObjective(repo, service, m);
    expectFinalizeRolledBack(repo, service, m, "upsertCursor");
  });

  it("finalize on an already-terminal mission is an idempotent no-op", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Already terminal" });
    service.cancel(m.id);
    const before = {
      status: repo.get(m.id)!.status,
      result: repo.get(m.id)!.result,
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
      cursor: JSON.stringify(service.getCursor(m.id)),
    };
    expect(before.status).toBe("cancelled");
    const finalized = service.finalize(m.id);
    // No new result, no new completed/status_changed event, no cursor churn —
    // finalize() must never overwrite an already-terminal mission's truth.
    expect(finalized.status).toBe("cancelled");
    expect(repo.get(m.id)!.status).toBe(before.status);
    expect(repo.get(m.id)!.result).toBe(before.result);
    expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
    expect(repo.listEvents(m.id).some((e) => e.type === "mission.completed")).toBe(false);
    expect(JSON.stringify(service.getCursor(m.id))).toBe(before.cursor);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOCKER 2 — invalid-state finalization must never commit contradictory state
// ════════════════════════════════════════════════════════════════════════════
describe("BLOCKER 2 — finalization lifecycle is centrally enforced", () => {
  function snapshot(repo: ReturnType<typeof missionsRepository>, service: MissionService, missionId: string) {
    return {
      status: repo.get(missionId)!.status,
      result: repo.get(missionId)!.result,
      completedAt: repo.get(missionId)!.completedAt,
      events: repo.listEvents(missionId).map((e) => e.type).join(","),
      cursor: JSON.stringify(service.getCursor(missionId)),
    };
  }

  it("draft finalization throws and writes nothing", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Draft finalize" });
    expect(repo.get(m.id)!.status).toBe("draft");
    const before = snapshot(repo, service, m.id);
    expect(() => service.finalize(m.id)).toThrow(/cannot be finalized from draft/i);
    expect(snapshot(repo, service, m.id)).toEqual(before);
  });

  it("awaiting-criteria-approval finalization throws and writes nothing", async () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Awaiting approval finalize" });
    await service.generateCriteria(m.id, "no test runner here");
    expect(repo.get(m.id)!.status).toBe("awaiting_criteria_approval");
    const before = snapshot(repo, service, m.id);
    expect(() => service.finalize(m.id)).toThrow(/awaiting criteria approval/i);
    expect(snapshot(repo, service, m.id)).toEqual(before);
  });

  it("reviewing without a persisted finalReview throws and writes nothing", () => {
    const { service, repo, db } = setup();
    const m = service.create("p1", { objective: "Reviewing without verdict" });
    service.approveCriteria(m.id);
    // Directly move the mission into "reviewing" (as runReview() would) WITHOUT
    // ever applying a review verdict — simulates a review-in-flight crash
    // before applyReview() persisted anything.
    db.prepare("UPDATE missions SET status = 'reviewing', updated_at = ? WHERE id = ?").run(new Date().toISOString(), m.id);
    expect(repo.get(m.id)!.status).toBe("reviewing");
    expect(repo.get(m.id)!.finalReview).toBeNull();
    const before = snapshot(repo, service, m.id);
    expect(() => service.finalize(m.id)).toThrow(/without a persisted final review/i);
    expect(snapshot(repo, service, m.id)).toEqual(before);
  });

  it("valid reviewed finalization succeeds and every persisted component agrees", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Valid finalize" });
    service.approveCriteria(m.id);
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const ev = addEvidence(repo, m.id, "ev-valid-fin");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [ev] });
    const finalized = service.finalize(m.id);
    expect(finalized.status).not.toBe("draft");
    expect(repo.get(m.id)!.status).toBe(finalized.status);
    expect(repo.get(m.id)!.result!.status).toBe(finalized.status);
    expect(repo.get(m.id)!.completedAt).not.toBeNull();
    const completed = repo.listEvents(m.id).find((e) => e.type === "mission.completed")!;
    expect(completed.data.status).toBe(finalized.status);
  });

  it("repeated healthy finalization is idempotent with no duplicate mission.completed event", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Repeat finalize" });
    service.approveCriteria(m.id);
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const ev = addEvidence(repo, m.id, "ev-repeat-fin");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [ev] });
    const first = service.finalize(m.id);
    const second = service.finalize(m.id);
    const third = service.finalize(m.id);
    expect(second.status).toBe(first.status);
    expect(third.status).toBe(first.status);
    const completedEvents = repo.listEvents(m.id).filter((e) => e.type === "mission.completed");
    expect(completedEvents).toHaveLength(1);
  });

  it("every finalization failure point rolls back the full result/status/event/cursor tuple", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Full rollback" });
    service.approveCriteria(m.id);
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const ev = addEvidence(repo, m.id, "ev-rollback-fin");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [ev] });
    const before = snapshot(repo, service, m.id);
    repo.setResult = () => { throw new Error("injected setResult failure"); };
    expect(() => service.finalize(m.id)).toThrow(/injected setResult failure/);
    expect(snapshot(repo, service, m.id)).toEqual(before);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MAJOR — legacy / partial terminal finalization reconciliation
// ════════════════════════════════════════════════════════════════════════════
describe("MAJOR — legacy/partial terminal finalization", () => {
  function approvedReview(missionId: string): MissionReview {
    return {
      id: `review-${missionId}-${Math.random().toString(36).slice(2)}`, missionId, verdict: "approved",
      criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [],
      concerns: [], recommendedStatus: "completed", summary: "approved", reviewerProvider: "test", reviewerModel: "test",
      createdAt: new Date().toISOString(),
    };
  }

  /** Drives a mission all the way to a genuine "completed" grade (not the
   *  degenerate zero-criteria "blocked" grade), so the full completion-tuple
   *  reconciliation logic (rather than the cancelled/failed/blocked
   *  short-circuit) is actually exercised. */
  function completeMission(service: MissionService, repo: ReturnType<typeof missionsRepository>, objective: string) {
    const m = service.create("p1", { objective });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const ev = addEvidence(repo, m.id, `ev-complete-${m.id}`);
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [ev] });
    service.setReview(approvedReview(m.id));
    return m;
  }

  it("a fully consistent completed tuple is a true idempotent no-op", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Consistent tuple" });
    service.approveCriteria(m.id);
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "active");
    const ev = addEvidence(repo, m.id, "ev-consistent");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [ev] });
    service.finalize(m.id);
    const before = {
      status: repo.get(m.id)!.status,
      result: repo.get(m.id)!.result,
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
      cursor: JSON.stringify(service.getCursor(m.id)),
    };
    const again = service.finalize(m.id);
    expect(again.status).toBe(before.status);
    expect(repo.get(m.id)!.result).toEqual(before.result);
    expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
    expect(JSON.stringify(service.getCursor(m.id))).toBe(before.cursor);
  });

  it("reconciles a crash-boundary tuple missing its mission.completed event", () => {
    const { service, repo, db } = setup();
    const m = completeMission(service, repo, "Missing completed event");
    const finalized = service.finalize(m.id);
    expect(finalized.status).toBe("completed");
    // Simulate a crash immediately after finalize by deleting only the
    // mission.completed event, leaving status/result/completedAt intact.
    db.prepare("DELETE FROM mission_events WHERE mission_id = ? AND type = 'mission.completed'").run(m.id);
    expect(repo.listEvents(m.id).some((e) => e.type === "mission.completed")).toBe(false);
    const reconciled = service.finalize(m.id);
    expect(reconciled.status).toBe(finalized.status);
    const events = repo.listEvents(m.id).filter((e) => e.type === "mission.completed");
    expect(events).toHaveLength(1);
    expect(events[0]!.data.reconciled).toBe(true);
  });

  // MAJOR 5 — a missing MissionResult on a terminal mission can never be
  // safely rebuilt (changedFiles, elapsed time, task/intervention counts,
  // spend, and review verdict are all historical facts that are not durably
  // recoverable), so this must now raise finalization_integrity_error and
  // write nothing, rather than fabricating a replacement result.
  it("a missing result row raises a finalization integrity error and writes nothing (never fabricates history)", () => {
    const { service, repo, db } = setup();
    const m = completeMission(service, repo, "Missing result");
    const finalized = service.finalize(m.id);
    expect(finalized.status).toBe("completed");
    db.prepare("UPDATE missions SET result_json = NULL WHERE id = ?").run(m.id);
    expect(repo.get(m.id)!.result).toBeNull();
    const before = {
      status: repo.get(m.id)!.status,
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
      cursor: JSON.stringify(service.getCursor(m.id)),
    };
    expect(() => service.finalize(m.id)).toThrow(/finalization integrity error/i);
    expect(repo.get(m.id)!.result).toBeNull(); // still no result — never fabricated
    expect(repo.get(m.id)!.status).toBe(before.status);
    expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
    expect(JSON.stringify(service.getCursor(m.id))).toBe(before.cursor);
  });

  it("throws an integrity error rather than silently overwriting a contradictory result", () => {
    const { service, repo, db } = setup();
    const m = completeMission(service, repo, "Contradictory tuple");
    service.finalize(m.id);
    // Corrupt the persisted result to disagree with the persisted status.
    const corrupted = { ...repo.get(m.id)!.result!, status: "failed" as const };
    db.prepare("UPDATE missions SET result_json = ? WHERE id = ?").run(JSON.stringify(corrupted), m.id);
    expect(() => service.finalize(m.id)).toThrow(/finalization integrity error/i);
  });

  it("cancelled missions retain their intentional semantics and are never converted to success", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Cancel semantics" });
    service.cancel(m.id);
    expect(repo.get(m.id)!.status).toBe("cancelled");
    const before = {
      result: repo.get(m.id)!.result,
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
    };
    const finalized = service.finalize(m.id);
    expect(finalized.status).toBe("cancelled");
    expect(repo.get(m.id)!.result).toBe(before.result); // still no result — untouched
    expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
    expect(repo.listEvents(m.id).some((e) => e.type === "mission.completed")).toBe(false);
  });

  it("blocked missions retain their intentional semantics and are never converted to success", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Blocked semantics" });
    repo.setStatus(m.id, "running", new Date().toISOString());
    repo.setStatus(m.id, "blocked", new Date().toISOString());
    expect(repo.get(m.id)!.status).toBe("blocked");
    const finalized = service.finalize(m.id);
    expect(finalized.status).toBe("blocked");
    expect(repo.get(m.id)!.result).toBeNull();
    expect(repo.listEvents(m.id).some((e) => e.type === "mission.completed")).toBe(false);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // MAJOR 4 — the terminal tuple must validate agreement across EVERY durable
  // component, not just result.status. Each row below corrupts exactly ONE
  // component of an otherwise fully-consistent completed tuple and proves
  // finalize() throws finalization_integrity_error with zero further writes.
  // ══════════════════════════════════════════════════════════════════════════
  describe("MAJOR 4 — terminal tuple corruption matrix", () => {
    function snapshot(repo: ReturnType<typeof missionsRepository>, service: MissionService, missionId: string) {
      return {
        status: repo.get(missionId)!.status,
        result: repo.get(missionId)!.result,
        events: repo.listEvents(missionId).map((e) => e.type + JSON.stringify(e.data)).join("||"),
        cursor: JSON.stringify(service.getCursor(missionId)),
      };
    }

    function freshCompletedMission() {
      const { service, repo, db } = setup();
      const m = completeMission(service, repo, "Corruption matrix");
      service.finalize(m.id);
      return { service, repo, db, m };
    }

    it("finalReview verdict disagreeing with result.reviewVerdict → integrity error", () => {
      const { service, repo, db, m } = freshCompletedMission();
      const corrupted = { ...repo.get(m.id)!.result!, reviewVerdict: "revisions_required" as const };
      db.prepare("UPDATE missions SET result_json = ? WHERE id = ?").run(JSON.stringify(corrupted), m.id);
      const before = snapshot(repo, service, m.id);
      expect(() => service.finalize(m.id)).toThrow(/finalization integrity error/i);
      expect(snapshot(repo, service, m.id)).toEqual(before);
    });

    it("missing mission.status_changed event with NO prior status history → integrity error (not reconstructable)", () => {
      const { service, repo, db, m } = freshCompletedMission();
      db.prepare("DELETE FROM mission_events WHERE mission_id = ? AND type = 'mission.status_changed'").run(m.id);
      expect(repo.listEvents(m.id).some((e) => e.type === "mission.status_changed")).toBe(false);
      const before = snapshot(repo, service, m.id);
      expect(() => service.finalize(m.id)).toThrow(/finalization integrity error/i);
      expect(snapshot(repo, service, m.id)).toEqual(before);
    });

    it("missing mission.status_changed event WITH prior status history → reconciled from the last recorded transition", () => {
      const { service, repo, db, m } = freshCompletedMission();
      const statusChanged = repo.listEvents(m.id).filter((e) => e.type === "mission.status_changed");
      // Delete only the LATEST status_changed (the one that transitioned into
      // the terminal status); an earlier one (draft→running or similar)
      // remains, so the prior state IS durably reconstructable.
      const latest = statusChanged.at(-1)!;
      db.prepare("DELETE FROM mission_events WHERE id = ?").run(latest.id);
      expect(repo.listEvents(m.id).some((e) => e.type === "mission.status_changed" && (e.data as any).to === "completed")).toBe(false);
      const reconciled = service.finalize(m.id);
      expect(reconciled.status).toBe("completed");
      const rebuilt = repo.listEvents(m.id).filter((e) => e.type === "mission.status_changed" && (e.data as any).to === "completed");
      expect(rebuilt).toHaveLength(1);
      expect((rebuilt[0]!.data as any).reconciled).toBe(true);
    });

    it("duplicate mission.status_changed events targeting the terminal status → integrity error", () => {
      const { service, repo, db, m } = freshCompletedMission();
      const latest = repo.listEvents(m.id).filter((e) => e.type === "mission.status_changed").at(-1)!;
      db.prepare(
        "INSERT INTO mission_events (id, mission_id, sequence, type, summary, data_json, created_at) VALUES (?,?,?,?,?,?,?)",
      ).run(`${m.id}-dup-sc`, m.id, 9999, "mission.status_changed", "Duplicate", JSON.stringify(latest.data), new Date().toISOString());
      const before = snapshot(repo, service, m.id);
      expect(() => service.finalize(m.id)).toThrow(/finalization integrity error/i);
      expect(snapshot(repo, service, m.id)).toEqual(before);
    });

    it("duplicate mission.completed events → integrity error", () => {
      const { service, repo, db, m } = freshCompletedMission();
      const completed = repo.listEvents(m.id).find((e) => e.type === "mission.completed")!;
      db.prepare(
        "INSERT INTO mission_events (id, mission_id, sequence, type, summary, data_json, created_at) VALUES (?,?,?,?,?,?,?)",
      ).run(`${m.id}-dup-comp`, m.id, 9998, "mission.completed", "Duplicate", JSON.stringify(completed.data), new Date().toISOString());
      const before = snapshot(repo, service, m.id);
      expect(() => service.finalize(m.id)).toThrow(/finalization integrity error/i);
      expect(snapshot(repo, service, m.id)).toEqual(before);
    });

    it("mission.completed event status mismatch → integrity error", () => {
      const { service, repo, db, m } = freshCompletedMission();
      db.prepare("UPDATE mission_events SET data_json = ? WHERE mission_id = ? AND type = 'mission.completed'")
        .run(JSON.stringify({ status: "partially_completed" }), m.id);
      const before = snapshot(repo, service, m.id);
      expect(() => service.finalize(m.id)).toThrow(/finalization integrity error/i);
      expect(snapshot(repo, service, m.id)).toEqual(before);
    });

    it("missing MissionResult → integrity error (covered again here as part of the full matrix)", () => {
      const { service, repo, db, m } = freshCompletedMission();
      db.prepare("UPDATE missions SET result_json = NULL WHERE id = ?").run(m.id);
      const before = snapshot(repo, service, m.id);
      expect(() => service.finalize(m.id)).toThrow(/finalization integrity error/i);
      expect(snapshot(repo, service, m.id)).toEqual(before);
    });

    it("a fully consistent tuple with no corruption remains a true idempotent no-op (control case)", () => {
      const { service, repo, m } = freshCompletedMission();
      const before = snapshot(repo, service, m.id);
      const again = service.finalize(m.id);
      expect(again.status).toBe("completed");
      expect(snapshot(repo, service, m.id)).toEqual(before);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F13 — complete fault-injection matrix (invariant 4)
// ════════════════════════════════════════════════════════════════════════════
describe("F13 — fault-injection matrix", () => {
  const FAULTS: Array<keyof ReturnType<typeof missionsRepository>> = ["appendEvent", "setContractFrozen", "upsertCursor"];

  // Each requirement transition, when any of (event | freeze | cursor)
  // persistence fails, must roll back entirely: the node returns to its prior
  // status, no new event appears, the contract freeze is unchanged, and the
  // cursor is byte-for-byte unchanged.
  type TransitionCase = {
    name: string;
    prepare?: (repo: ReturnType<typeof missionsRepository>, service: MissionService, m: { id: string }, reqId: string) => void;
    act?: (service: MissionService, m: { id: string }, reqId: string) => void;
  };

  const CASES: TransitionCase[] = [
    {
      name: "activation",
      act: (service, m, reqId) => service.updateRequirementStatus(m.id, reqId, "active"),
    },
    {
      name: "verification",
      prepare: (repo, service, m, reqId) => {
        service.updateRequirementStatus(m.id, reqId, "active");
        const ev = addEvidence(repo, m.id, `ev-v-${m.id}-${reqId}`);
        (service as any)._lastEv = ev;
      },
      act: (service, m, reqId) => {
        const ev = (service as any)._lastEv as string;
        service.updateRequirementStatus(m.id, reqId, "verified", { fileHash: GOOD_HASH, evidenceRefs: [ev] });
      },
    },
    {
      name: "failure",
      prepare: (repo, service, m, reqId) => service.updateRequirementStatus(m.id, reqId, "active"),
      act: (service, m, reqId) => service.updateRequirementStatus(m.id, reqId, "failed", { failureReason: "broke" }),
    },
    {
      name: "waiver",
      prepare: (repo, service, m, reqId) => service.updateRequirementStatus(m.id, reqId, "active"),
      act: (service, m, reqId) => service.updateRequirementStatus(m.id, reqId, "waived"),
    },
    {
      name: "invalidation",
      prepare: (repo, service, m, reqId) => service.updateRequirementStatus(m.id, reqId, "active"),
      act: (service, m, reqId) => service.updateRequirementStatus(m.id, reqId, "invalidated"),
    },
    {
      name: "verified-node reopening",
      prepare: (repo, service, m, reqId) => {
        // Verify, reopen once (history entry 1), verify again → verified w/ 1 entry.
        service.updateRequirementStatus(m.id, reqId, "active");
        const evV = addEvidence(repo, m.id, `ev-vr-${m.id}-${reqId}`);
        service.updateRequirementStatus(m.id, reqId, "verified", { fileHash: GOOD_HASH, evidenceRefs: [evV] });
        const evR = addEvidence(repo, m.id, `ev-rr-${m.id}-${reqId}`, "failed");
        service.updateRequirementStatus(m.id, reqId, "pending", {
          invalidationCondition: "file_hash_changed", invalidationReason: "first reopen", invalidationEvidenceRef: evR,
        });
        service.updateRequirementStatus(m.id, reqId, "active");
        const evV2 = addEvidence(repo, m.id, `ev-vr2-${m.id}-${reqId}`);
        service.updateRequirementStatus(m.id, reqId, "verified", { fileHash: GOOD_HASH, evidenceRefs: [evV2] });
      },
    },
  ];

  // The verified-node reopening case needs its own act (fresh invalidation ref).
  function reopenAct(repo: ReturnType<typeof missionsRepository>, service: MissionService, m: { id: string }, reqId: string): void {
    const evR = addEvidence(repo, m.id, `ev-r3-${m.id}-${reqId}`, "failed");
    service.updateRequirementStatus(m.id, reqId, "pending", {
      invalidationCondition: "contract_changed", invalidationReason: "later reopen", invalidationEvidenceRef: evR,
    });
  }

  for (const fault of FAULTS) {
    for (const c of CASES) {
      it(`requirement ${c.name}: ${String(fault)} failure rolls back to prior state`, () => {
        const { service, repo } = setup();
        const m = service.create("p1", { objective: `Transition ${c.name}` });
        const req = service.listRequirementNodes(m.id)[0]!;
        c.prepare?.(repo, service, m, req.id);
        const before = {
          status: service.listRequirementNodes(m.id).find((n) => n.id === req.id)!.status,
          historyLen: service.listRequirementNodes(m.id).find((n) => n.id === req.id)!.invalidationHistory.length,
          frozen: service.getContract(m.id).frozen,
          cursor: JSON.stringify(service.getCursor(m.id)),
          events: repo.listEvents(m.id).map((e) => e.type + JSON.stringify(e.data)).join("||"),
        };
        const orig = (repo as any)[fault];
        (repo as any)[fault] = () => { throw new Error(`injected ${String(fault)} failure`); };
        const act = c.name === "verified-node reopening"
          ? () => reopenAct(repo, service, m, req.id)
          : () => c.act!(service, m, req.id);
        expect(() => act()).toThrow(/injected.*failure/);
        const afterNode = service.listRequirementNodes(m.id).find((n) => n.id === req.id)!;
        expect(afterNode.status).toBe(before.status);
        expect(afterNode.invalidationHistory.length).toBe(before.historyLen);
        expect(service.getContract(m.id).frozen).toBe(before.frozen);
        expect(JSON.stringify(service.getCursor(m.id))).toBe(before.cursor);
        expect(repo.listEvents(m.id).map((e) => e.type + JSON.stringify(e.data)).join("||")).toBe(before.events);
        (repo as any)[fault] = orig;
      });
    }
  }

  it("reopen with prior history: failure preserves node, history, events, freeze, cursor", () => {
    const { service, repo, dbPath } = setup();
    const m = service.create("p1", { objective: "Reopen history rollback" });
    const req = service.listRequirementNodes(m.id)[0]!;
    // First verify.
    service.updateRequirementStatus(m.id, req.id, "active");
    const evV = addEvidence(repo, m.id, "ev-hv");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [evV] });
    // Reopen once → one persisted history entry.
    const evR1 = addEvidence(repo, m.id, "ev-hr1", "failed");
    service.updateRequirementStatus(m.id, req.id, "pending", {
      invalidationCondition: "file_hash_changed", invalidationReason: "first reopen", invalidationEvidenceRef: evR1,
    });
    // Re-verify so the node is verified again with an intact single history entry.
    service.updateRequirementStatus(m.id, req.id, "active");
    const evV2 = addEvidence(repo, m.id, "ev-hv2");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: GOOD_HASH, evidenceRefs: [evV2] });

    const before = {
      status: "verified",
      history: JSON.stringify(service.listRequirementNodes(m.id).find((n) => n.id === req.id)!.invalidationHistory),
      frozen: service.getContract(m.id).frozen,
      cursor: JSON.stringify(service.getCursor(m.id)),
      reopenEvents: repo.listEvents(m.id).filter((e) => e.type === "mission.requirement_reopened").length,
    };

    // Inject a failure during a LATER reopen.
    repo.appendInvalidationEntry = (() => { throw new Error("injected reopen failure"); }) as typeof repo.appendInvalidationEntry;
    const evR2 = addEvidence(repo, m.id, "ev-hr2", "failed");
    expect(() => service.updateRequirementStatus(m.id, req.id, "pending", {
      invalidationCondition: "contract_changed", invalidationReason: "later reopen", invalidationEvidenceRef: evR2,
    })).toThrow(/injected reopen failure/);

    const after = service.listRequirementNodes(m.id).find((n) => n.id === req.id)!;
    expect(after.status).toBe("verified"); // node remains verified
    expect(JSON.stringify(after.invalidationHistory)).toBe(before.history); // prior entry exactly intact
    expect(after.invalidationHistory).toHaveLength(1); // no new entry
    expect(service.getContract(m.id).frozen).toBe(before.frozen);
    expect(JSON.stringify(service.getCursor(m.id))).toBe(before.cursor);
    expect(repo.listEvents(m.id).filter((e) => e.type === "mission.requirement_reopened").length).toBe(before.reopenEvents); // no new reopen event

    // Persisted state is identical after a fresh reload.
    const r2 = reload(dbPath);
    const persisted = r2.repo.getRequirementNode(req.id)!;
    expect(persisted.status).toBe("verified");
    expect(JSON.stringify(persisted.invalidationHistory)).toBe(before.history);
  });

  // ── Creation failure matrix ───────────────────────────────────────────────
  function expectCreationRolledBack(dbPath: string, service: MissionService, repo: ReturnType<typeof missionsRepository>, faultMethod: keyof ReturnType<typeof missionsRepository>): void {
    let createdId: string | undefined;
    const origCreate = repo.create.bind(repo);
    repo.create = ((input: Parameters<typeof repo.create>[0], now?: string) => { createdId = input.id; return origCreate(input, now); }) as typeof repo.create;
    if (faultMethod === "create") {
      repo.create = ((input: Parameters<typeof repo.create>[0]) => { createdId = input.id; throw new Error("injected create failure"); }) as typeof repo.create;
    } else {
      (repo as any)[faultMethod] = () => { throw new Error(`injected ${String(faultMethod)} failure`); };
    }
    expect(() => service.create("p1", { objective: "Atomic create matrix" })).toThrow();
    const r2 = reload(dbPath);
    // No mission, contract, contract/creation/cursor/specialist events, active
    // pointer, or cursor survives.
    expect(r2.repo.listByProject("p1")).toHaveLength(0);
    expect(r2.repo.getProjectActiveMission("p1")).toBeUndefined();
    if (createdId) {
      const id = createdId;
      expect(r2.repo.get(id)).toBeUndefined();
      expect(() => r2.service.getContract(id)).toThrow(/not found/i);
      expect(r2.repo.listRequirementNodes(id)).toHaveLength(0);
      expect(r2.repo.listEvents(id)).toHaveLength(0);
      expect(r2.repo.getCursor(id)).toBeUndefined();
    }
  }

  it("creation failure (mission row) rolls back everything", () => {
    const { dbPath, service, repo } = setup();
    expectCreationRolledBack(dbPath, service, repo, "create");
  });
  it("creation failure (contract) rolls back everything", () => {
    const { dbPath, service, repo } = setup();
    expectCreationRolledBack(dbPath, service, repo, "createContract");
  });
  it("creation failure (requirement nodes) rolls back everything", () => {
    const { dbPath, service, repo } = setup();
    expectCreationRolledBack(dbPath, service, repo, "addRequirementNodes");
  });
  it("creation failure (active pointer) rolls back everything", () => {
    const { dbPath, service, repo } = setup();
    expectCreationRolledBack(dbPath, service, repo, "setProjectActiveMission");
  });
  it("creation failure (cursor) rolls back everything", () => {
    const { dbPath, service, repo } = setup();
    expectCreationRolledBack(dbPath, service, repo, "upsertCursor");
  });

  // Mission creation appends three distinct event types (mission.created,
  // mission.contract_built, mission.specialists_planned). Rather than a
  // fragile call-count hack, each is faulted by matching the actual `type`
  // argument passed to appendEvent, so each test genuinely proves rollback at
  // the named stage — not merely "whichever appendEvent call happens first."
  function expectCreationEventRolledBack(dbPath: string, service: MissionService, repo: ReturnType<typeof missionsRepository>, eventType: string): void {
    let createdId: string | undefined;
    const origCreate = repo.create.bind(repo);
    repo.create = ((input: Parameters<typeof repo.create>[0], now?: string) => { createdId = input.id; return origCreate(input, now); }) as typeof repo.create;
    const origAppendEvent = repo.appendEvent.bind(repo);
    repo.appendEvent = ((missionId: string, type: Parameters<typeof repo.appendEvent>[1], summary: string, data?: Record<string, unknown>, now?: string) => {
      if (type === eventType) throw new Error(`injected ${eventType} failure`);
      return origAppendEvent(missionId, type, summary, data, now);
    }) as typeof repo.appendEvent;
    expect(() => service.create("p1", { objective: `Atomic create ${eventType}` })).toThrow(new RegExp(`injected ${eventType.replace(/\./g, "\\.")} failure`));
    const r2 = reload(dbPath);
    expect(r2.repo.listByProject("p1")).toHaveLength(0);
    expect(r2.repo.getProjectActiveMission("p1")).toBeUndefined();
    if (createdId) {
      const id = createdId;
      expect(r2.repo.get(id)).toBeUndefined();
      expect(() => r2.service.getContract(id)).toThrow(/not found/i);
      expect(r2.repo.listRequirementNodes(id)).toHaveLength(0);
      expect(r2.repo.listEvents(id)).toHaveLength(0);
      expect(r2.repo.getCursor(id)).toBeUndefined();
    }
  }

  it("creation failure (mission.created event) rolls back everything", () => {
    const { dbPath, service, repo } = setup();
    expectCreationEventRolledBack(dbPath, service, repo, "mission.created");
  });
  it("creation failure (mission.contract_built event) rolls back everything", () => {
    const { dbPath, service, repo } = setup();
    expectCreationEventRolledBack(dbPath, service, repo, "mission.contract_built");
  });
  it("creation failure (mission.specialists_planned event) rolls back everything", () => {
    const { dbPath, service, repo } = setup();
    expectCreationEventRolledBack(dbPath, service, repo, "mission.specialists_planned");
  });
});
