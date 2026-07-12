import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { MissionService } from "../src/mission/service.js";

const roots: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

function setup() {
  const home = tmp("ek-home-");
  const workspace = tmp("ek-ws-");
  const db = openDatabase(":memory:");
  const projects = projectRepository(db);
  const now = new Date().toISOString();
  const project = projects.createProject({ id: "p1", name: "proj", workspacePath: workspace, createdAt: now });
  const repo = missionsRepository(db);
  const service = new MissionService({
    repo,
    getWorkspacePath: (pid) => (pid === project.id ? workspace : undefined),
    backupDir: join(home, "mission-checkpoints"),
  });
  return { db, service, repo, workspace, project };
}

describe("Advanced Execution Kernel — contract on create", () => {
  it("builds a contract from the verbatim objective and persists provenance", () => {
    const { service, repo } = setup();
    const m = service.create("p1", { objective: "Repair the save game corruption bug" });
    const contract = service.getContract(m.id);
    expect(contract.sourcePrompt).toBe("Repair the save game corruption bug");
    expect(contract.requirements).toHaveLength(1);
    const req = contract.requirements[0]!;
    expect(req.statement).toBe("Repair the save game corruption bug");
    expect(req.source).toBe("user");
    expect(req.confidence).toBe(1);
    expect(req.approved).toBe(true);
    expect(contract.frozen).toBe(false);
    expect(repo.listEvents(m.id).some((e) => e.type === "mission.contract_built")).toBe(true);
  });

  it("sets the per-project active mission pointer on create", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Do X" });
    const active = service.getProjectActiveMission("p1");
    expect(active?.missionId).toBe(m.id);
  });

  it("repoints the active mission when a newer mission is created for the project", () => {
    const { service } = setup();
    const first = service.create("p1", { objective: "First" });
    const second = service.create("p1", { objective: "Second" });
    expect(service.getProjectActiveMission("p1")?.missionId).toBe(second.id);
    expect(service.getProjectActiveMission("p1")?.missionId).not.toBe(first.id);
  });
});

describe("Advanced Execution Kernel — cursor", () => {
  it("seeds exactly one active requirement node and a bounded action set", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Fix crash" });
    const cursor = service.getCursor(m.id);
    expect(cursor.activeNodeId).toBe(service.listRequirementNodes(m.id)[0]!.id);
    expect(cursor.allowedActions.length).toBeGreaterThan(0);
    expect(cursor.allowedActions).not.toContain("continue");
  });

  it("preserves the cursor after finalize (terminal recovery can see where it left off)", () => {
    const { service, db } = setup();
    const m = service.create("p1", { objective: "Fix crash" });
    // Mark the requirement verified, then complete.
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:deadbeef" });
    service.finalize(m.id);
    // The cursor is preserved (never cleared), and with the sole requirement
    // verified there is no longer an active node to work — honest state.
    const cursor = service.getCursor(m.id);
    expect(cursor.activeNodeId).toBeNull();
    expect(cursor.reason).toMatch(/All requirements addressed/);
    // A fresh repository handle over the same DB still sees the cursor —
    // proves the cursor is durable, not just in-memory.
    const repo2 = missionsRepository(db);
    expect(repo2.getCursor(m.id)?.activeNodeId).toBeNull();
    expect(repo2.getCursor(m.id)?.reason).toMatch(/All requirements addressed/);
  });
});

describe("Advanced Execution Kernel — verified-node freeze (I5)", () => {
  it("rejects silently reopening a verified node", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Fix crash" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:abc" });
    expect(service.getContract(m.id).frozen).toBe(true);
    expect(() => service.updateRequirementStatus(m.id, req.id, "pending")).toThrow(/frozen/i);
  });

  it("allows reopening a verified node when a file-hash change is recorded", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Fix crash" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:abc" });
    const reopened = service.updateRequirementStatus(m.id, req.id, "pending", { fileHashChanged: true });
    expect(reopened.status).toBe("pending");
    expect(reopened.verifiedFileHash).toBeNull();
    expect(service.getContract(m.id).frozen).toBe(false);
  });

  it("records the verification file hash and clears it on non-verified transitions", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Fix crash" });
    const req = service.listRequirementNodes(m.id)[0]!;
    service.updateRequirementStatus(m.id, req.id, "in_progress");
    service.updateRequirementStatus(m.id, req.id, "verified", { fileHash: "sha256:hash" });
    expect(service.listRequirementNodes(m.id)[0]!.verifiedFileHash).toBe("sha256:hash");
    service.updateRequirementStatus(m.id, req.id, "pending", { invalidationRecorded: true });
    expect(service.listRequirementNodes(m.id)[0]!.verifiedFileHash).toBeNull();
  });
});
