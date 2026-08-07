import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSustainedAutonomyAcceptance } from "../src/acceptance/sustained-autonomy.js";

let root: string;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("sustained autonomy through production paths", () => {
  it("completes a long mission with real rollovers, recovery, restart, and Guardian authorization", async () => {
    root = mkdtempSync(join(tmpdir(), "morrow-sustained-"));
    const result = await runSustainedAutonomyAcceptance({ root });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));

    expect(result.productiveWorkUnits).toBe(96);
    expect(result.progressObservationCount).toBeGreaterThan(0);
    expect(result.terminalState).toBe("completed");
    expect(result.guardianRejectionCount).toBeGreaterThan(0);
    expect(result.guardianAuthorizationCount).toBe(1);
    expect(result.leaseGenerationAfterRestart).toBeGreaterThan(result.leaseGenerationBeforeRestart);
    expect(result.contextRolloverCount).toBeGreaterThanOrEqual(3);
    expect(result.checkpointCount).toBeGreaterThan(0);
    expect(result.recoveryCount).toBeGreaterThanOrEqual(2);
    expect(result.databaseRestartCount).toBe(1);
    expect(result.duplicateCompletedOperations).toBe(0);
    expect(result.sqliteIntegrity).toBe("ok");
    expect(result.transitionActors).toEqual(expect.arrayContaining(["controller", "worker", "guardian"]));
    expect(result.passed, result.message ?? "sustained autonomy scenario failed").toBe(true);
  }, 180_000);

  it("stops paying for compaction the route does not need", async () => {
    // The same 96-unit workload, differing only in the route's real capacity.
    //
    // This is the long-task half of the context-window fix. Compaction is not
    // free: each one discards context the model already paid to gather, so the
    // work gets re-done — which is how a single task reached 276 compactions,
    // ~201 MB of checkpoints, and the same file read 31-92 times without
    // finishing. Morrow used to compact on a schedule set by a bundled
    // constant rather than by the route, so a large window bought nothing.
    //
    // Identical durable outcomes on both routes; only the overhead differs.
    root = mkdtempSync(join(tmpdir(), "morrow-sustained-wide-"));
    const result = await runSustainedAutonomyAcceptance({ root, endpointLimitTokens: 1_000_000 });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));

    expect(result.productiveWorkUnits).toBe(96);
    expect(result.terminalState).toBe("completed");
    expect(result.passed, result.message ?? "wide-window sustained autonomy scenario failed").toBe(true);

    // The point of the case: a workload that needed >=3 rollovers at 32k needs
    // none of them at 1M. If this ever climbs back above zero, some ceiling is
    // once again being applied independently of the route.
    expect(result.contextRolloverCount).toBe(0);

    // Durability is unchanged, not traded away for the efficiency: the mission
    // still checkpoints, still recovers, and still survives a real restart.
    expect(result.checkpointCount).toBeGreaterThan(0);
    expect(result.recoveryCount).toBeGreaterThanOrEqual(2);
    expect(result.databaseRestartCount).toBe(1);
    expect(result.guardianAuthorizationCount).toBe(1);
    expect(result.duplicateCompletedOperations).toBe(0);
    expect(result.sqliteIntegrity).toBe("ok");
  }, 180_000);
});
