import assert from "node:assert/strict";
import test from "node:test";
import {
  branchFreshnessFailures,
  classifyBranch,
  mergeBaseAgeDays,
  DEFAULT_MAX_MERGE_BASE_AGE_DAYS,
} from "./lib/branch-freshness.mjs";

const INTEGRATION = "main";

test("a branch that has absorbed recent integration history passes", () => {
  assert.deepEqual(
    branchFreshnessFailures({
      branch: "fix/thing",
      integrationBranch: INTEGRATION,
      mergeBaseIso: "2026-08-01T00:00:00Z",
      integrationTipIso: "2026-08-02T00:00:00Z",
      commitsBehind: 3,
    }),
    [],
  );
});

test("the real consumer-polish divergence would have failed this guard", () => {
  // Branched 2026-07-25, reconciled 2026-08-01: seven days, 70 commits of
  // integration history unabsorbed, and it produced two shipped defects.
  const failures = branchFreshnessFailures({
    branch: "morrow/consumer-polish",
    integrationBranch: INTEGRATION,
    mergeBaseIso: "2026-07-25T00:00:00Z",
    integrationTipIso: "2026-08-01T12:00:00Z",
    commitsBehind: 70,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /morrow\/consumer-polish/);
  assert.match(failures[0], /70 commit/);
  assert.match(failures[0], /7-day limit/);
});

test("staleness is measured against integration history, not wall-clock time", () => {
  // A quiet week on the integration branch must not fail every open pull
  // request: nothing has happened that the branch could be missing.
  assert.deepEqual(
    branchFreshnessFailures({
      branch: "fix/thing",
      integrationBranch: INTEGRATION,
      mergeBaseIso: "2026-06-01T00:00:00Z",
      integrationTipIso: "2026-06-01T00:00:00Z",
      commitsBehind: 0,
    }),
    [],
  );
});

test("the integration branch never fails against itself", () => {
  assert.deepEqual(
    branchFreshnessFailures({
      branch: INTEGRATION,
      integrationBranch: INTEGRATION,
      mergeBaseIso: "2026-01-01T00:00:00Z",
      integrationTipIso: "2026-08-01T00:00:00Z",
    }),
    [],
  );
});

test("the window is exactly the limit, not one day either side of it", () => {
  const at = (days) =>
    branchFreshnessFailures({
      branch: "fix/thing",
      integrationBranch: INTEGRATION,
      mergeBaseIso: "2026-08-01T00:00:00Z",
      integrationTipIso: new Date(Date.parse("2026-08-01T00:00:00Z") + days * 86_400_000).toISOString(),
    });
  assert.deepEqual(at(DEFAULT_MAX_MERGE_BASE_AGE_DAYS), []);
  assert.equal(at(DEFAULT_MAX_MERGE_BASE_AGE_DAYS + 0.01).length, 1);
});

test("a tighter limit can be enforced without changing the default", () => {
  const failures = branchFreshnessFailures({
    branch: "fix/thing",
    integrationBranch: INTEGRATION,
    mergeBaseIso: "2026-08-01T00:00:00Z",
    integrationTipIso: "2026-08-03T00:00:00Z",
    maxAgeDays: 1,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /1-day limit/);
});

test("a merge-base ahead of the tip reads as fresh, not as a negative age", () => {
  assert.equal(mergeBaseAgeDays({ mergeBaseIso: "2026-08-05T00:00:00Z", integrationTipIso: "2026-08-01T00:00:00Z" }), 0);
});

test("a non-timestamp is rejected rather than silently treated as epoch zero", () => {
  assert.throws(() => mergeBaseAgeDays({ mergeBaseIso: "not-a-date", integrationTipIso: "2026-08-01T00:00:00Z" }), TypeError);
  assert.throws(() => mergeBaseAgeDays({ mergeBaseIso: "2026-08-01T00:00:00Z", integrationTipIso: undefined }), TypeError);
});

test("the inventory separates merged, aging, and long-abandoned branches", () => {
  assert.equal(classifyBranch({ merged: true, ageDays: 400 }), "merged");
  assert.equal(classifyBranch({ merged: false, ageDays: 1 }), "active");
  assert.equal(classifyBranch({ merged: false, ageDays: 10 }), "aging");
  assert.equal(classifyBranch({ merged: false, ageDays: 90 }), "stale");
});
