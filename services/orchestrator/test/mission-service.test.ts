import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { MissionService, type MissionCompletionFn } from "../src/mission/service.js";
import type { ChatMessage } from "../src/provider/base.js";

const roots: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

function gitInit(dir: string) {
  spawnSync("git", ["init", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.co"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
}

function setup(opts: { completion?: MissionCompletionFn; autoApprove?: boolean } = {}) {
  const home = tmp("mission-home-");
  const workspace = tmp("mission-ws-");
  gitInit(workspace);
  const db = openDatabase(":memory:");
  const projects = projectRepository(db);
  const now = new Date().toISOString();
  const project = projects.createProject({ id: "p1", name: "proj", workspacePath: workspace, createdAt: now });
  const repo = missionsRepository(db);
  const service = new MissionService({
    repo,
    getWorkspacePath: (pid) => (pid === project.id ? workspace : undefined),
    completion: opts.completion,
    backupDir: join(home, "mission-checkpoints"),
  });
  return { db, service, repo, workspace, project };
}

describe("MissionService — creation and persistence", () => {
  it("creates a mission in draft and persists it across a fresh repo handle", () => {
    const { service, db } = setup();
    const m = service.create("p1", { objective: "Repair the game" });
    expect(m.status).toBe("draft");
    expect(m.objective).toBe("Repair the game");
    // Re-open a repository over the same DB — proves durable persistence.
    const repo2 = missionsRepository(db);
    const loaded = repo2.get(m.id)!;
    expect(loaded.objective).toBe("Repair the game");
    expect(loaded.status).toBe("draft");
    expect(repo2.listEvents(m.id).some((e) => e.type === "mission.created")).toBe(true);
    const roles = service.specialists(m.id);
    expect(roles.map((r) => r.id)).toEqual([
      "repository-mapper",
      "planner",
      "implementer",
      "test-engineer",
      "security-regression-reviewer",
      "final-reviewer",
    ]);
    expect(roles.every((r) => r.allowedTools.length > 0 && r.requiredInputs.length > 0 && r.completionCriteria.length > 0)).toBe(true);
    expect(roles.every((r) => r.storesChainOfThought === false)).toBe(true);
    expect(repo2.listEvents(m.id).some((e) => e.type === "mission.specialists_planned")).toBe(true);
  });
});

describe("MissionService — criteria", () => {
  it("falls back to heuristic criteria when no model is available and awaits approval", async () => {
    const { service } = setup();
    writeFileSync(join(setupWs(service), "package.json"), "{}");
    const m = service.create("p1", { objective: "Fix bugs" });
    const after = await service.generateCriteria(m.id, "package.json, src/index.js");
    expect(after.criteria.length).toBeGreaterThanOrEqual(3);
    expect(after.status).toBe("awaiting_criteria_approval");
    expect(after.criteria.every((c) => c.state === "proposed")).toBe(true);
  });

  it("uses model criteria and rewrites vague ones", async () => {
    const completion: MissionCompletionFn = async () => ({
      text: JSON.stringify([
        { description: "node --check public/game.js exits 0", verification: { kind: "command", command: "node --check public/game.js", expectExitCode: 0 } },
        { description: "make it better", verification: { kind: "manual" } },
      ]),
    });
    const { service } = setup({ completion });
    const m = service.create("p1", { objective: "Repair" });
    const after = await service.generateCriteria(m.id, "game");
    expect(after.criteria).toHaveLength(2);
    // The vague criterion is rewritten into something observable.
    expect(after.criteria[1]!.description).not.toMatch(/make it better/i);
  });

  it("drops brittle model-invented artifact checks from the criteria contract", async () => {
    const completion: MissionCompletionFn = async () => ({
      text: JSON.stringify([
        { description: "Regeneration completes", verification: { kind: "command", command: "npm run generate", expectExitCode: 0 } },
        { description: "Generated tax table has 5% for books", verification: { kind: "command", command: "node -e \"const d=require('./generated/taxTable.json'); process.exit(d.books===0.05?0:1);\"", expectExitCode: 0 } },
        { description: "Inline generated artifact check", verification: { kind: "command", command: "node -e \"const d=require('./generated/tax-table.json'); process.exit(d.book===0.05?0:1);\"", expectExitCode: 0 } },
      ]),
    });
    const { service, workspace } = setup({ completion });
    mkdirSync(join(workspace, "generated"));
    writeFileSync(join(workspace, "generated", "tax-table.json"), "{\"book\":0.13}\n");

    const m = service.create("p1", { objective: "Repair tax table" });
    const after = await service.generateCriteria(m.id, "package.json scripts: generate, test\ngenerated/tax-table.json");
    expect(after.criteria.map((c) => c.verification.command)).toEqual(["npm run generate"]);
  });

  it("auto-approves and starts running when autoApprove is set, persisting the contract", async () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Fix", autoApprove: true });
    const after = await service.generateCriteria(m.id, "");
    expect(after.status).toBe("running");
    expect(after.criteria.every((c) => c.state === "approved")).toBe(true);
  });

  it("rejects an invalid direct transition", async () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "Fix" });
    // draft -> reviewing is not allowed.
    expect(() => (service as any).transition(m.id, "reviewing")).toThrow(/Invalid mission transition/);
  });
});

function setupWs(service: MissionService): string {
  // helper to grab the workspace via the private dep for writing fixtures
  return (service as any).deps.getWorkspacePath("p1");
}

describe("MissionService — evidence-backed verification", () => {
  it("verifies a criterion only when the command evidence passes", async () => {
    const { service, workspace } = setup();
    writeFileSync(join(workspace, "ok.js"), "const a = 1;\n");
    writeFileSync(join(workspace, "bad.js"), "const = ;\n");
    const m = service.create("p1", { objective: "syntax", autoApprove: true });
    await service.generateCriteria(m.id, "");
    const good = service.addCriterion(m.id, "ok.js parses", { kind: "command", command: "node --check ok.js", expectExitCode: 0 });
    const bad = service.addCriterion(m.id, "bad.js parses", { kind: "command", command: "node --check bad.js", expectExitCode: 0 });

    const r1 = await service.verifyCriterion(m.id, good.id);
    expect(r1.evidence.status).toBe("passed");
    expect(r1.criterion.state).toBe("verified");
    expect(r1.evidence.exitCode).toBe(0);

    const r2 = await service.verifyCriterion(m.id, bad.id);
    expect(r2.evidence.status).toBe("failed");
    expect(r2.criterion.state).toBe("failed");
    expect(r2.criterion.failureReason).toBeTruthy();

    // Evidence is linked to its criterion and nothing else.
    const loaded = service.get(m.id);
    const goodC = loaded.criteria.find((c) => c.id === good.id)!;
    expect(goodC.evidenceIds).toContain(r1.evidence.id);
    expect(goodC.evidenceIds).not.toContain(r2.evidence.id);
  });

  it("marks an http criterion failed when status mismatches", async () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "serve", autoApprove: true });
    await service.generateCriteria(m.id, "");
    const c = service.addCriterion(m.id, "serves 200", { kind: "http", url: "http://127.0.0.1:59999/", expectStatus: 200 });
    // Nothing is listening → inconclusive, not a false pass.
    const r = await service.verifyCriterion(m.id, c.id);
    expect(r.evidence.status).toBe("inconclusive");
    expect(r.criterion.state).toBe("unverified");
  });
});

describe("MissionService — failure intelligence and loop detection", () => {
  it("escalates recovery strategy across repeated identical failures and never repeats forever", () => {
    const { service } = setup();
    const m = service.create("p1", { objective: "x", autoApprove: true });
    service.approveCriteria(m.id); // move to running (failures happen during execution)
    const op = "propose_patch public/game.js @@ -34,5 +34,5 @@";
    const s1 = service.recordFailure(m.id, op, "Hunk line count mismatch for public/game.js");
    expect(s1.failure.category).toBe("patch_context_mismatch");
    expect(s1.plan.strategy).toBe("reread-target");
    const s2 = service.recordFailure(m.id, "propose_patch public/game.js @@ -40,6 +40,6 @@", "Patch conflict expected at line 10");
    expect(s2.plan.strategy).toBe("reduce-patch-scope");
    const s3 = service.recordFailure(m.id, "propose_patch public/game.js @@ -9,5 +9,5 @@", "line count mismatch");
    expect(s3.plan.strategy).toBe("targeted-rewrite");
    const s4 = service.recordFailure(m.id, "propose_patch public/game.js @@ -1,5 +1,5 @@", "line count mismatch");
    expect(s4.plan.exhausted).toBe(true);
    // Same signature collapsed → loop detected and mission blocked.
    const loaded = service.get(m.id);
    expect(loaded.status).toBe("blocked");
    expect(loaded.failures.length).toBe(4);
    const events = (service as any).repo.listEvents(m.id).map((e: any) => e.type);
    expect(events).toContain("mission.loop_detected");
  });
});

describe("MissionService — checkpoints and safe rollback", () => {
  it("captures a checkpoint and rolls back only the captured files, preserving unrelated work", () => {
    const { service, workspace } = setup();
    writeFileSync(join(workspace, "game.js"), "ORIGINAL\n");
    writeFileSync(join(workspace, "unrelated.txt"), "USER WORK\n");
    const m = service.create("p1", { objective: "x", autoApprove: true });
    const ckpt = service.createCheckpoint(m.id, "before-edit", "risky change", ["game.js"]);
    expect(ckpt.rollbackAvailable).toBe(true);
    expect(ckpt.affectedFiles).toContain("game.js");

    // Mutate both files after the checkpoint.
    writeFileSync(join(workspace, "game.js"), "BROKEN EDIT\n");
    writeFileSync(join(workspace, "unrelated.txt"), "USER WORK EDITED\n");

    const res = service.rollback(m.id, ckpt.id);
    expect(res.ok).toBe(true);
    expect(res.restored).toContain("game.js");
    // game.js restored; unrelated user work is untouched by rollback.
    expect(readFileSync(join(workspace, "game.js"), "utf8")).toBe("ORIGINAL\n");
    expect(readFileSync(join(workspace, "unrelated.txt"), "utf8")).toBe("USER WORK EDITED\n");
  });

  it("recreates a file that existed at checkpoint but was deleted", () => {
    const { service, workspace } = setup();
    writeFileSync(join(workspace, "keep.js"), "KEEP\n");
    const m = service.create("p1", { objective: "x", autoApprove: true });
    const ckpt = service.createCheckpoint(m.id, "cp", "reason", ["keep.js"]);
    rmSync(join(workspace, "keep.js"));
    const res = service.rollback(m.id, ckpt.id);
    expect(res.ok).toBe(true);
    expect(existsSync(join(workspace, "keep.js"))).toBe(true);
  });
});

describe("MissionService — independent review and honest grading", () => {
  it("runs the reviewer as a SEPARATE execution not fed implementer claims", async () => {
    const seen: ChatMessage[][] = [];
    const completion: MissionCompletionFn = async (messages, opts) => {
      seen.push(messages);
      if (opts.purpose === "review") {
        return { text: JSON.stringify({ verdict: "approved", criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [], concerns: [], recommendedStatus: "completed", summary: "ok" }), provider: "mock", model: "reviewer-1" };
      }
      return { text: "[]" };
    };
    const { service, workspace } = setup({ completion });
    writeFileSync(join(workspace, "a.js"), "const a=1;\n");
    const m = service.create("p1", { objective: "Repair" });
    const c = service.addCriterion(m.id, "a.js parses", { kind: "command", command: "node --check a.js", expectExitCode: 0 });
    service.approveCriteria(m.id);
    await service.verifyCriterion(m.id, c.id);
    const review = await service.runReview(m.id);
    // The reviewer prompt must contain the isolation framing and NOT the word "trust me" from an implementer.
    const reviewMessages = seen[seen.length - 1]!;
    expect(reviewMessages[0]!.content).toMatch(/INDEPENDENT reviewer/);
    expect(reviewMessages[0]!.content).toMatch(/must not assume it was done correctly/);
    expect(review.verdict).toBe("approved");
    expect(review.reviewerModel).toBe("reviewer-1");
  });

  it("reviewer rejection prevents completion; insufficient evidence can never be completed", async () => {
    const completion: MissionCompletionFn = async (_m, opts) =>
      opts.purpose === "review"
        ? { text: JSON.stringify({ verdict: "insufficient_evidence", recommendedStatus: "partially_completed", criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: ["no test evidence"], concerns: [], summary: "not proven" }) }
        : { text: "[]" };
    const { service, workspace } = setup({ completion });
    writeFileSync(join(workspace, "a.js"), "const a=1;\n");
    const m = service.create("p1", { objective: "Repair" });
    const c = service.addCriterion(m.id, "a.js parses", { kind: "command", command: "node --check a.js", expectExitCode: 0 });
    service.approveCriteria(m.id);
    await service.verifyCriterion(m.id, c.id); // verified
    await service.runReview(m.id);
    const final = service.finalize(m.id);
    expect(final.status).not.toBe("completed");
    expect(["partially_completed", "blocked"]).toContain(final.status);
    expect(final.result!.reviewVerdict).toBe("insufficient_evidence");
  });

  it("approved_with_risks yields completed_with_reservations and records unresolved risks", async () => {
    const completion: MissionCompletionFn = async (_m, opts) =>
      opts.purpose === "review"
        ? { text: JSON.stringify({ verdict: "approved_with_risks", recommendedStatus: "completed_with_reservations", criterionJudgments: [], regressionRisks: ["Only tested on Chromium"], suspiciousChanges: [], missingVerification: [], concerns: [], summary: "ok with a risk" }) }
        : { text: "[]" };
    const { service, workspace } = setup({ completion });
    writeFileSync(join(workspace, "a.js"), "const a=1;\n");
    const m = service.create("p1", { objective: "Repair" });
    const c = service.addCriterion(m.id, "a.js parses", { kind: "command", command: "node --check a.js", expectExitCode: 0 });
    service.approveCriteria(m.id);
    await service.verifyCriterion(m.id, c.id);
    await service.runReview(m.id);
    const final = service.finalize(m.id);
    expect(final.status).toBe("completed_with_reservations");
    expect(final.result!.unresolvedRisks).toContain("Only tested on Chromium");
  });

  it("does not surface no-op reviewer risk strings as unresolved risks", async () => {
    const completion: MissionCompletionFn = async (_m, opts) =>
      opts.purpose === "review"
        ? { text: JSON.stringify({ verdict: "approved", recommendedStatus: "completed", criterionJudgments: [], regressionRisks: ["None expected; tests cover this path."], suspiciousChanges: ["No suspicious changes found."], missingVerification: ["N/A"], concerns: ["No concerns identified."], summary: "ok" }) }
        : { text: "[]" };
    const { service, workspace } = setup({ completion });
    writeFileSync(join(workspace, "a.js"), "const a=1;\n");
    const m = service.create("p1", { objective: "Repair" });
    const c = service.addCriterion(m.id, "a.js parses", { kind: "command", command: "node --check a.js", expectExitCode: 0 });
    service.approveCriteria(m.id);
    await service.verifyCriterion(m.id, c.id);
    await service.runReview(m.id);
    const final = service.finalize(m.id);
    expect(final.status).toBe("completed");
    expect(final.result!.unresolvedRisks).toEqual([]);
  });

  it("verifies a review-kind criterion when the reviewer approves, reaching full completion", async () => {
    const completion: MissionCompletionFn = async (_m, opts) =>
      opts.purpose === "review" ? { text: JSON.stringify({ verdict: "approved", recommendedStatus: "completed", criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [], concerns: [], summary: "ok" }) } : { text: "[]" };
    const { service, workspace } = setup({ completion });
    writeFileSync(join(workspace, "a.js"), "const a=1;\n");
    const m = service.create("p1", { objective: "Repair" });
    const cmd = service.addCriterion(m.id, "a.js parses", { kind: "command", command: "node --check a.js", expectExitCode: 0 });
    const rev = service.addCriterion(m.id, "independent reviewer approves", { kind: "review" });
    service.approveCriteria(m.id);
    await service.verifyCriterion(m.id, cmd.id);
    await service.runReview(m.id);
    // The review criterion is now verified with the review as its evidence.
    const reviewCriterion = service.get(m.id).criteria.find((c) => c.id === rev.id)!;
    expect(reviewCriterion.state).toBe("verified");
    expect(reviewCriterion.evidenceIds.length).toBe(1);
    const final = service.finalize(m.id);
    expect(final.status).toBe("completed");
  });

  it("repairs unstructured reviewer output once before grading", async () => {
    let reviewCalls = 0;
    const completion: MissionCompletionFn = async (_m, opts) => {
      if (opts.purpose !== "review") return { text: "[]" };
      reviewCalls += 1;
      if (reviewCalls === 1) return { text: "Final ruling: APPROVED. The command evidence proves the criterion." };
      return {
        text: JSON.stringify({
          verdict: "approved",
          recommendedStatus: "completed",
          criterionJudgments: [{ index: 1, judgment: "satisfied", note: "Command evidence passed." }],
          regressionRisks: [],
          suspiciousChanges: [],
          missingVerification: [],
          concerns: [],
          summary: "Approved after structured repair.",
        }),
      };
    };
    const { service, workspace } = setup({ completion });
    writeFileSync(join(workspace, "a.js"), "const a=1;\n");
    const m = service.create("p1", { objective: "Repair" });
    const cmd = service.addCriterion(m.id, "a.js parses", { kind: "command", command: "node --check a.js", expectExitCode: 0 });
    const rev = service.addCriterion(m.id, "independent reviewer approves", { kind: "review" });
    service.approveCriteria(m.id);
    await service.verifyCriterion(m.id, cmd.id);
    const review = await service.runReview(m.id);
    expect(reviewCalls).toBe(2);
    expect(review.verdict).toBe("approved");
    expect(service.get(m.id).criteria.find((c) => c.id === rev.id)!.state).toBe("verified");
    const final = service.finalize(m.id);
    expect(final.status).toBe("completed");
  });

  it("refuses full completion when a criterion is unverified even if review approves", async () => {
    const completion: MissionCompletionFn = async (_m, opts) =>
      opts.purpose === "review" ? { text: JSON.stringify({ verdict: "approved", recommendedStatus: "completed", criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [], concerns: [], summary: "ok" }) } : { text: "[]" };
    const { service, workspace } = setup({ completion });
    writeFileSync(join(workspace, "a.js"), "const a=1;\n");
    const m = service.create("p1", { objective: "Repair" });
    const ok = service.addCriterion(m.id, "a.js parses", { kind: "command", command: "node --check a.js", expectExitCode: 0 });
    service.addCriterion(m.id, "manual thing never checked", { kind: "manual" });
    service.approveCriteria(m.id);
    await service.verifyCriterion(m.id, ok.id);
    await service.runReview(m.id);
    const final = service.finalize(m.id);
    expect(final.status).toBe("partially_completed");
  });
});

describe("MissionService — restart and resume", () => {
  it("reconstructs the full mission from persistence with a brand-new service instance", async () => {
    const home = tmp("mission-home-");
    const workspace = tmp("mission-ws-");
    gitInit(workspace);
    writeFileSync(join(workspace, "a.js"), "const a=1;\n");
    const db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "p", workspacePath: workspace, createdAt: new Date().toISOString() });
    const backupDir = join(home, "cp");

    const svc1 = new MissionService({ repo: missionsRepository(db), getWorkspacePath: () => workspace, backupDir });
    const m = svc1.create("p1", { objective: "Repair", autoApprove: true });
    await svc1.generateCriteria(m.id, "");
    const c = svc1.addCriterion(m.id, "a.js parses", { kind: "command", command: "node --check a.js", expectExitCode: 0 });
    svc1.createCheckpoint(m.id, "cp", "reason", ["a.js"]);
    await svc1.verifyCriterion(m.id, c.id);
    svc1.recordFailure(m.id, "some op", "tool error enoent");

    // Simulate a restart: a completely new service over the same DB + backup dir.
    const svc2 = new MissionService({ repo: missionsRepository(db), getWorkspacePath: () => workspace, backupDir });
    const resumed = svc2.resume(m.id);
    expect(resumed.objective).toBe("Repair");
    expect(resumed.criteria.some((x) => x.state === "verified")).toBe(true);
    expect(resumed.checkpoints.length).toBe(1);
    expect(resumed.failures.length).toBe(1);
    // Rollback still works after "restart" because snapshots are on disk.
    writeFileSync(join(workspace, "a.js"), "MUTATED\n");
    const res = svc2.rollback(m.id, resumed.checkpoints[0]!.id);
    expect(res.ok).toBe(true);
    expect(readFileSync(join(workspace, "a.js"), "utf8")).toBe("const a=1;\n");
  });
});
