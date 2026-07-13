import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { MissionService, type MissionServiceDeps } from "../src/mission/service.js";

// ════════════════════════════════════════════════════════════════════════════
// BLOCKER 4 — reviews must not mutate terminal missions, and finalize must
// never close a review-in-flight mission that lacks its persisted verdict.
//
// MAJOR — the review-cycle budget (maxReviewCycles) must be enforced, not
// merely recorded.
//
// These tests use a deterministic, test-controlled provider "barrier" promise
// instead of a real timer/race, so the concurrency scenarios are fully
// reproducible: the test explicitly controls exactly when the provider
// promise resolves relative to other synchronous service calls.
// ════════════════════════════════════════════════════════════════════════════

const roots: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

/** A promise the test can resolve/reject on demand from outside. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function approvedJson(): string {
  return JSON.stringify({
    verdict: "approved",
    criterionJudgments: [],
    regressionRisks: [], suspiciousChanges: [], missingVerification: [], concerns: [],
    recommendedStatus: "completed",
    summary: "Looks good",
  });
}

function setupWithBarrierProvider() {
  const home = tmp("ek-race-home-");
  const workspace = tmp("ek-race-ws-");
  const dbPath = join(tmp("ek-race-db-"), "m.db");
  const db = openDatabase(dbPath);
  const projects = projectRepository(db);
  const now = new Date().toISOString();
  const project = projects.createProject({ id: "p1", name: "proj", workspacePath: workspace, createdAt: now });
  const repo = missionsRepository(db);

  let providerCalls = 0;
  let currentGate: { promise: Promise<{ text: string }> } | null = null;
  function armGate(promise: Promise<{ text: string }>) {
    currentGate = { promise };
  }

  const completion: MissionServiceDeps["completion"] = async (_messages, _opts) => {
    providerCalls += 1;
    const gate = currentGate;
    if (!gate) return { text: approvedJson(), provider: "test", model: "test-model" };
    const res = await gate.promise;
    return { text: res.text, provider: "test", model: "test-model" };
  };

  const service = new MissionService({
    repo,
    getWorkspacePath: (pid) => (pid === project.id ? workspace : undefined),
    backupDir: join(home, "mission-checkpoints"),
    completion,
  });

  function prepareReviewableMission(objective: string) {
    const m = service.create("p1", { objective });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });
    return m;
  }

  return { db, repo, service, project, providerCallCount: () => providerCalls, armGate };
}

describe("BLOCKER 4 — review/finalize concurrency", () => {
  it("review begins and the mission becomes reviewing before the provider resolves", async () => {
    const { service, repo, armGate } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "Begins reviewing" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });

    const gate = deferred<{ text: string }>();
    armGate(gate.promise);
    const reviewPromise = service.runReview(m.id);
    // Let the microtask queue advance to the point where the provider has been
    // invoked and is awaiting the gate, without resolving it.
    await Promise.resolve();
    await Promise.resolve();

    expect(repo.get(m.id)!.status).toBe("reviewing");
    expect(repo.listEvents(m.id).some((e) => e.type === "mission.review_started")).toBe(true);
    expect(repo.get(m.id)!.finalReview).toBeNull();

    gate.resolve({ text: approvedJson() });
    await reviewPromise;
  });

  it("finalize attempted while a review is in flight is rejected with zero writes", async () => {
    const { service, repo, armGate } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "Finalize race" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });

    const gate = deferred<{ text: string }>();
    armGate(gate.promise);
    const reviewPromise = service.runReview(m.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(repo.get(m.id)!.status).toBe("reviewing");

    const before = {
      status: repo.get(m.id)!.status,
      result: repo.get(m.id)!.result,
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
      cursor: JSON.stringify(service.getCursor(m.id)),
    };
    // finalize() must reject: reviewing without a persisted finalReview.
    expect(() => service.finalize(m.id)).toThrow(/without a persisted final review/i);
    expect(repo.get(m.id)!.status).toBe(before.status);
    expect(repo.get(m.id)!.result).toBe(before.result);
    expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
    expect(JSON.stringify(service.getCursor(m.id))).toBe(before.cursor);

    // Let the in-flight review resolve cleanly afterward.
    gate.resolve({ text: approvedJson() });
    await reviewPromise;
    // Now that the verdict is persisted, finalize succeeds.
    const finalized = service.finalize(m.id);
    expect(finalized.status).toBe("completed");
  });

  it("the provider resolves after finalize rejection and the review still applies correctly", async () => {
    const { service, repo, armGate } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "Applies after race" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });
    const gate = deferred<{ text: string }>();
    armGate(gate.promise);
    const reviewPromise = service.runReview(m.id);
    await Promise.resolve();
    gate.resolve({ text: approvedJson() });
    const review = await reviewPromise;
    expect(review.verdict).toBe("approved");
    expect(repo.get(m.id)!.finalReview?.verdict).toBe("approved");
  });

  it("a review attempt against an already-terminal mission is rejected and writes nothing", async () => {
    const { service, repo } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "Terminal review rejected" });
    service.cancel(m.id);
    expect(repo.get(m.id)!.status).toBe("cancelled");
    const before = {
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
      finalReview: repo.get(m.id)!.finalReview,
    };
    await expect(service.runReview(m.id)).rejects.toThrow(/terminal/i);
    expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
    expect(repo.get(m.id)!.finalReview).toBe(before.finalReview);
  });

  it("a stale provider result arriving after the mission went terminal is rejected without partial persistence", async () => {
    const { service, repo, armGate } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "Stale provider result" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });

    const gate = deferred<{ text: string }>();
    armGate(gate.promise);
    const reviewPromise = service.runReview(m.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(repo.get(m.id)!.status).toBe("reviewing");

    // Simulate another operation racing the review and forcing the mission to
    // a terminal state directly at the persistence layer (e.g. a concurrent
    // cancel through another process) BEFORE the provider result arrives.
    repo.transaction(() => {
      repo.setStatus(m.id, "cancelled", new Date().toISOString());
      repo.appendEvent(m.id, "mission.cancelled", "Cancelled by a concurrent operation", {}, new Date().toISOString());
    });

    const before = {
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
      finalReview: repo.get(m.id)!.finalReview,
      evidence: repo.listEvidence(m.id).length,
    };
    // Now the stale provider result finally arrives.
    gate.resolve({ text: approvedJson() });
    await expect(reviewPromise).rejects.toThrow(/terminal/i);

    // Nothing from the stale review was partially persisted.
    expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
    expect(repo.get(m.id)!.finalReview).toBe(before.finalReview);
    expect(repo.listEvidence(m.id)).toHaveLength(before.evidence);
    expect(repo.get(m.id)!.status).toBe("cancelled");
  });

  it("a persisted finalReview and the terminal result's reviewVerdict never disagree", async () => {
    const { service, repo } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "Verdict agreement" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });
    const review = await service.runReview(m.id);
    const finalized = service.finalize(m.id);
    expect(repo.get(m.id)!.finalReview?.verdict).toBe(review.verdict);
    expect(finalized.result!.reviewVerdict).toBe(review.verdict);
  });
});

describe("MAJOR — review-cycle limit is enforced, not merely recorded", () => {
  it("rejects a third review once maxReviewCycles (2) is reached, with zero provider spend and zero extra writes", async () => {
    const { service, repo, providerCallCount } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "Cycle limit" });
    expect(repo.get(m.id)!.budget.maxReviewCycles).toBe(2);
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });

    await service.runReview(m.id);
    expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(1);
    expect(providerCallCount()).toBe(1);

    await service.runReview(m.id);
    expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(2);
    expect(providerCallCount()).toBe(2);

    const before = {
      reviewCycles: repo.get(m.id)!.budget.reviewCyclesUsed,
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
      evidence: repo.listEvidence(m.id).length,
    };
    await expect(service.runReview(m.id)).rejects.toThrow(/review-cycle budget/i);
    // The third attempt must never reach the provider.
    expect(providerCallCount()).toBe(2);
    expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(before.reviewCycles);
    expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
    expect(repo.listEvidence(m.id)).toHaveLength(before.evidence);
  });

  it("also rejects a direct setReview() application once the cycle budget is exhausted", async () => {
    const { service, repo } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "Direct apply cycle limit" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });
    await service.runReview(m.id);
    await service.runReview(m.id);
    expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(2);

    const thirdReview = {
      id: "review-manual-3", missionId: m.id, verdict: "approved" as const,
      criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [],
      concerns: [], recommendedStatus: "completed" as const, summary: "manual",
      reviewerProvider: "manual", reviewerModel: "manual", createdAt: new Date().toISOString(),
    };
    expect(() => service.setReview(thirdReview)).toThrow(/review-cycle budget/i);
    expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(2);
  });
});
