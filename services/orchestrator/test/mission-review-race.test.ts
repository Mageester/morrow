import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { MissionService, type MissionServiceDeps } from "../src/mission/service.js";
import type { MissionReview } from "@morrow/contracts";

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

function revisionsRequiredJson(): string {
  return JSON.stringify({
    verdict: "revisions_required",
    criterionJudgments: [],
    regressionRisks: [], suspiciousChanges: [], missingVerification: [], concerns: ["fix it"],
    recommendedStatus: "partially_completed",
    summary: "Needs work",
  });
}

/** Flush enough microtask turns for any purely-synchronous-until-the-next-await
 *  continuation to run. Safe to over-call: once execution is actually blocked
 *  on an unresolved promise, extra turns are no-ops. */
async function flush(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
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
  let currentGate: { promise: Promise<{ text: string; usdCost?: number }> } | null = null;
  function armGate(promise: Promise<{ text: string; usdCost?: number }>) {
    currentGate = { promise };
  }

  const completion: MissionServiceDeps["completion"] = async (_messages, _opts) => {
    providerCalls += 1;
    const gate = currentGate;
    if (!gate) return { text: approvedJson(), provider: "test", model: "test-model" };
    const res = await gate.promise;
    return res.usdCost === undefined
      ? { text: res.text, provider: "test", model: "test-model" }
      : { text: res.text, provider: "test", model: "test-model", usdCost: res.usdCost };
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

  return { db, dbPath, repo, service, project, providerCallCount: () => providerCalls, armGate, prepareReviewableMission };
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
    // finalize() must reject: a review cycle is durably reserved (in flight).
    expect(() => service.finalize(m.id)).toThrow(/review cycle is in flight/i);
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

    const gate = deferred<{ text: string; usdCost?: number }>();
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
      result: repo.get(m.id)!.result,
      spentUsd: repo.get(m.id)!.budget.spentUsd,
      reviewCyclesUsed: repo.get(m.id)!.budget.reviewCyclesUsed,
    };
    // Now the stale provider result finally arrives, reporting a real cost.
    gate.resolve({ text: approvedJson(), usdCost: 0.42 });
    await expect(reviewPromise).rejects.toThrow(/terminal/i);

    // Nothing from the stale review was partially persisted — budget, review,
    // evidence, events, and result are all byte-for-byte unchanged, and the
    // reported provider cost never touched spentUsd.
    expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
    expect(repo.get(m.id)!.finalReview).toBe(before.finalReview);
    expect(repo.listEvidence(m.id)).toHaveLength(before.evidence);
    expect(repo.get(m.id)!.status).toBe("cancelled");
    expect(repo.get(m.id)!.result).toBe(before.result);
    expect(repo.get(m.id)!.budget.spentUsd).toBe(before.spentUsd);
    expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(before.reviewCyclesUsed);
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

// ════════════════════════════════════════════════════════════════════════════
// BLOCKER 1 — durable review-cycle ownership (migration 30 /
// mission_review_cycles). Finalize must never grade on an EARLIER cycle's
// verdict while a NEWER cycle is still in flight, at most one cycle may ever
// be reserved per mission, and the reservation is durable (survives restart),
// not an in-memory promise.
// ════════════════════════════════════════════════════════════════════════════
describe("BLOCKER 1 — durable review-cycle ownership", () => {
  it("cycle A applies (approved) while cycle B is in flight: finalize fails with zero completion writes, and cycle B's verdict — not A's — becomes current", async () => {
    const { service, repo, armGate } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "Cycle A then in-flight cycle B" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });

    // Cycle A resolves immediately (no gate armed) and applies "approved".
    const reviewA = await service.runReview(m.id);
    expect(reviewA.verdict).toBe("approved");
    expect(repo.get(m.id)!.finalReview?.verdict).toBe("approved");
    expect(repo.get(m.id)!.status).toBe("reviewing");
    expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(1);

    // Cycle B starts and is held at the provider barrier — durably reserved,
    // in flight, before any provider response exists.
    const gate = deferred<{ text: string }>();
    armGate(gate.promise);
    const cycleBPromise = service.runReview(m.id);
    await flush();
    expect(repo.get(m.id)!.status).toBe("reviewing");

    const before = {
      status: repo.get(m.id)!.status,
      result: repo.get(m.id)!.result,
      events: repo.listEvents(m.id).map((e) => e.type).join(","),
      finalReview: repo.get(m.id)!.finalReview,
    };
    // finalize() must NOT be able to use cycle A's already-persisted "approved"
    // verdict while cycle B is in flight — zero completion writes.
    expect(() => service.finalize(m.id)).toThrow(/review cycle is in flight/i);
    expect(repo.get(m.id)!.status).toBe(before.status);
    expect(repo.get(m.id)!.result).toBe(before.result);
    expect(repo.listEvents(m.id).map((e) => e.type).join(",")).toBe(before.events);
    expect(repo.get(m.id)!.finalReview).toEqual(before.finalReview); // still cycle A's verdict, untouched

    // Cycle B resolves with revisions_required.
    gate.resolve({ text: revisionsRequiredJson() });
    const reviewB = await cycleBPromise;
    expect(reviewB.verdict).toBe("revisions_required");

    // The persisted current review is now cycle B's — cycle A's stale
    // "approved" verdict is no longer exposed anywhere.
    expect(repo.get(m.id)!.finalReview?.verdict).toBe("revisions_required");
    expect(repo.get(m.id)!.finalReview?.id).toBe(reviewB.id);
    expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(2);

    // No successful completion based on cycle A is possible: finalize() now
    // grades from cycle B's verdict, never A's.
    const finalized = service.finalize(m.id);
    expect(finalized.status).not.toBe("completed");
    expect(finalized.result!.reviewVerdict).toBe("revisions_required");
  });

  it("two concurrent review starts race for the single reservation slot: exactly one reservation succeeds, only one provider call occurs, and the loser writes nothing", async () => {
    const { service, repo, armGate, providerCallCount } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "Concurrent reservation race" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });

    const gate = deferred<{ text: string }>();
    armGate(gate.promise);
    // Both calls are issued back-to-back with no await in between. Because
    // reservation is fully synchronous (better-sqlite3) and happens BEFORE the
    // first `await` in runReview(), the first call's reservation transaction
    // runs to completion before the second call's synchronous prologue ever
    // starts — there is no real interleaving to race, which is exactly what
    // makes this deterministic rather than timing-dependent.
    const p1 = service.runReview(m.id);
    const p2 = service.runReview(m.id);

    await expect(p2).rejects.toThrow(/review cycle.*(in flight|conflict)/i);
    // The loser never reached the provider.
    expect(providerCallCount()).toBe(1);
    // The loser wrote nothing: only the winner's reservation transition/event
    // pair exists (exactly one running→reviewing transition, exactly one
    // review_started event).
    expect(repo.listEvents(m.id).filter((e) => e.type === "mission.review_started")).toHaveLength(1);
    expect(repo.listEvents(m.id).filter((e) => e.type === "mission.status_changed" && (e.data as any).to === "reviewing")).toHaveLength(1);

    gate.resolve({ text: approvedJson() });
    const review = await p1;
    expect(review.verdict).toBe("approved");
    expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(1);
  });

  it("restart while a cycle is reserved preserves finalization blocking (durable, not an in-memory promise)", async () => {
    const { service, repo, dbPath, armGate } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "Restart preserves reservation" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });

    const gate = deferred<{ text: string }>();
    armGate(gate.promise);
    const reviewPromise = service.runReview(m.id);
    await flush();
    expect(repo.get(m.id)!.status).toBe("reviewing");

    // Simulate a full process restart: open a brand-new connection/repo/service
    // against the SAME database file, with no knowledge of the in-flight
    // promise above (a genuine restart would lose it entirely).
    const restartedDb = openDatabase(dbPath);
    try {
      const restartedRepo = missionsRepository(restartedDb);
      const restartedService = new MissionService({
        repo: restartedRepo,
        getWorkspacePath: () => undefined,
        backupDir: join(tmp("ek-restart-b-"), "backups"),
      });

      expect(restartedRepo.get(m.id)!.status).toBe("reviewing");
      expect(() => restartedService.finalize(m.id)).toThrow(/review cycle is in flight/i);
    } finally {
      restartedDb.close();
    }

    // Let the original in-flight review resolve so the deferred promise does
    // not leak into another test.
    gate.resolve({ text: approvedJson() });
    await reviewPromise;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MAJOR 2 — provider (and repair-provider) cost is applied atomically with an
// ACCEPTED review, never for a stale/rejected one, and never twice.
// ════════════════════════════════════════════════════════════════════════════
describe("MAJOR 2 — review-cycle cost accounting is atomic with acceptance", () => {
  it("an accepted result records its provider cost exactly once", async () => {
    const { service, repo, armGate } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "Cost recorded once" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });

    const gate = deferred<{ text: string; usdCost?: number }>();
    armGate(gate.promise);
    const reviewPromise = service.runReview(m.id);
    await flush();
    gate.resolve({ text: approvedJson(), usdCost: 0.5 });
    const review = await reviewPromise;
    expect(review.verdict).toBe("approved");
    expect(repo.get(m.id)!.budget.spentUsd).toBe(0.5);
  });

  it("a duplicate provider result for an already-applied cycle cannot double-charge", async () => {
    const { service, repo, db } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "No double charge" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });

    const review = await service.runReview(m.id);
    expect(repo.get(m.id)!.budget.spentUsd).toBe(0);
    const spentAfterFirst = repo.get(m.id)!.budget.spentUsd;
    expect(repo.getReservedReviewCycle(m.id)).toBeUndefined(); // the cycle already resolved to 'applied'

    // Recover the id of the cycle that was just successfully applied (durably
    // referenced by the mission's current_review_cycle_id pointer), to
    // simulate a duplicate/late provider callback firing again for that EXACT
    // already-resolved cycle.
    const appliedCycleId = (db.prepare("SELECT current_review_cycle_id AS id FROM missions WHERE id = ?").get(m.id) as { id: string }).id;
    expect(appliedCycleId).toBeTruthy();
    expect(repo.getReviewCycle(appliedCycleId)!.status).toBe("applied");

    expect(() => (service as any).applyReview(m.id, { ...review, id: "dup-review-id" }, { reviewCycleId: appliedCycleId, usdCost: 9.99 }))
      .toThrow(/stale/i);
    expect(repo.get(m.id)!.budget.spentUsd).toBe(spentAfterFirst);
    expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(1);
    expect(repo.get(m.id)!.finalReview?.id).toBe(review.id); // still the original review, not "dup-review-id"
  });

  it("a rejected repair-provider result records no cost even though both calls reported one", async () => {
    const home = tmp("ek-repair-home-");
    const workspace = tmp("ek-repair-ws-");
    const dbPath = join(tmp("ek-repair-db-"), "m.db");
    const db = openDatabase(dbPath);
    const projects = projectRepository(db);
    const now = new Date().toISOString();
    const project = projects.createProject({ id: "p1", name: "proj", workspacePath: workspace, createdAt: now });
    const repo = missionsRepository(db);

    const repairGate = deferred<{ text: string; usdCost?: number }>();
    let calls = 0;
    const completion: MissionServiceDeps["completion"] = async () => {
      calls += 1;
      if (calls === 1) {
        // Unparseable text triggers the repair round-trip.
        return { text: "not valid json at all", provider: "test", model: "test-model", usdCost: 0.11 };
      }
      const res = await repairGate.promise;
      return res.usdCost === undefined
        ? { text: res.text, provider: "test", model: "test-model" }
        : { text: res.text, provider: "test", model: "test-model", usdCost: res.usdCost };
    };
    const service = new MissionService({
      repo, getWorkspacePath: (pid) => (pid === project.id ? workspace : undefined),
      backupDir: join(home, "mission-checkpoints"), completion,
    });

    const m = service.create("p1", { objective: "Repair result rejected" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });

    const reviewPromise = service.runReview(m.id);
    // Let the primary (unparseable) call resolve and the repair call dispatch
    // and start awaiting its own gate.
    await flush();
    expect(calls).toBe(2);

    // Force the mission terminal while the repair call is still in flight.
    repo.transaction(() => {
      repo.setStatus(m.id, "cancelled", new Date().toISOString());
      repo.appendEvent(m.id, "mission.cancelled", "Cancelled mid-repair", {}, new Date().toISOString());
    });

    repairGate.resolve({ text: approvedJson(), usdCost: 0.22 });
    await expect(reviewPromise).rejects.toThrow(/terminal/i);

    // Neither the primary (0.11) nor the repair (0.22) cost was ever recorded.
    expect(repo.get(m.id)!.budget.spentUsd).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MAJOR 6 — current-review selection uses durable application order (the
// review-cycle sequence), never a caller-controlled/backdated timestamp.
// ════════════════════════════════════════════════════════════════════════════
describe("MAJOR 6 — current review selection is order-of-application, not timestamp", () => {
  it("applying review B after review A exposes B as current even when B's createdAt is EARLIER than A's", () => {
    const { service, repo } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "Backdated review B" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });

    const reviewA: MissionReview = {
      id: "review-a", missionId: m.id, verdict: "approved",
      criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [],
      concerns: [], recommendedStatus: "completed", summary: "A",
      reviewerProvider: "test", reviewerModel: "test", createdAt: "2026-01-01T12:00:00.000Z",
    };
    service.setReview(reviewA);
    expect(repo.get(m.id)!.finalReview?.id).toBe("review-a");

    // Review B is applied AFTER A but carries an EARLIER (backdated) createdAt.
    const reviewB: MissionReview = {
      id: "review-b", missionId: m.id, verdict: "revisions_required",
      criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [],
      concerns: ["backdated but authoritative"], recommendedStatus: "partially_completed", summary: "B",
      reviewerProvider: "test", reviewerModel: "test", createdAt: "2020-01-01T00:00:00.000Z",
    };
    service.setReview(reviewB);

    // Hydration must expose B, not A, despite A having the later createdAt.
    expect(repo.get(m.id)!.finalReview?.id).toBe("review-b");
    expect(repo.get(m.id)!.finalReview?.verdict).toBe("revisions_required");

    // Finalization must grade using B.
    const finalized = service.finalize(m.id);
    expect(finalized.result!.reviewVerdict).toBe("revisions_required");
    expect(finalized.status).not.toBe("completed");
  });

  it("tied/duplicate timestamps remain deterministic (the later-applied cycle always wins)", () => {
    const { service, repo } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "Tied timestamps" });
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });

    const tiedAt = "2026-03-01T00:00:00.000Z";
    const reviewA: MissionReview = {
      id: "review-tied-a", missionId: m.id, verdict: "approved",
      criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [],
      concerns: [], recommendedStatus: "completed", summary: "A",
      reviewerProvider: "test", reviewerModel: "test", createdAt: tiedAt,
    };
    service.setReview(reviewA);
    const reviewB: MissionReview = {
      id: "review-tied-b", missionId: m.id, verdict: "approved_with_risks",
      criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [],
      concerns: [], recommendedStatus: "completed_with_reservations", summary: "B",
      reviewerProvider: "test", reviewerModel: "test", createdAt: tiedAt,
    };
    service.setReview(reviewB);

    expect(repo.get(m.id)!.finalReview?.id).toBe("review-tied-b");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MAJOR 7 — budgetExhausted() reports true exactly at the review-cycle
// boundary, in agreement with actual review admission.
// ════════════════════════════════════════════════════════════════════════════
describe("MAJOR 7 — budgetExhausted boundary agrees with review-cycle admission", () => {
  it("is false below the review-cycle cap and true exactly at/above it", async () => {
    const { service, repo } = setupWithBarrierProvider();
    const m = service.create("p1", { objective: "Budget boundary" });
    expect(repo.get(m.id)!.budget.maxReviewCycles).toBe(2);
    service.approveCriteria(m.id);
    service.addCriterion(m.id, "Independent reviewer approves the change", { kind: "review", describe: "x" });

    expect(service.budgetExhausted(m.id)).toBe(false); // reviewCyclesUsed 0 < 2

    await service.runReview(m.id);
    expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(1);
    expect(service.budgetExhausted(m.id)).toBe(false); // 1 < 2

    await service.runReview(m.id);
    expect(repo.get(m.id)!.budget.reviewCyclesUsed).toBe(2);
    expect(service.budgetExhausted(m.id)).toBe(true); // 2 >= 2 — exact boundary

    // Agrees with actual review admission: a further reservation is rejected too.
    await expect(service.runReview(m.id)).rejects.toThrow(/review-cycle budget/i);
  });
});
