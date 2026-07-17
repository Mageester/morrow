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
});
