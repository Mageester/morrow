import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DURABLE_AUTONOMY_FAULTS,
  runDurableAutonomyScenarios,
} from "../src/acceptance/scenarios/durable-autonomy.js";
import { runAcceptance, type AcceptanceInvocation } from "../src/acceptance/runner.js";
import { createFoundationFixture } from "../src/acceptance/fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable autonomy packaged acceptance scenarios", () => {
  it("continues one durable mission through every deterministic fault", async () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-durable-acceptance-"));
    roots.push(root);

    const result = await runDurableAutonomyScenarios({ root });

    expect(result.scenarios.map((scenario) => scenario.fault)).toEqual(DURABLE_AUTONOMY_FAULTS);
    expect(result.scenarios).toHaveLength(5);
    for (const scenario of result.scenarios) {
      expect(scenario.passed, `${scenario.fault}: ${scenario.message ?? "failed"}`).toBe(true);
      expect(scenario.missionIds).toEqual([scenario.missionId]);
      expect(scenario.terminalState).toBe("completed");
      expect(new Set(scenario.operationKeys).size).toBe(scenario.operationKeys.length);
      expect(scenario.dispatchCount).toBeGreaterThan(0);
    }
  });

  it("records the fault-specific continuation evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-durable-acceptance-"));
    roots.push(root);

    const { scenarios } = await runDurableAutonomyScenarios({ root });
    const scenario = (fault: (typeof DURABLE_AUTONOMY_FAULTS)[number]) => scenarios.find((item) => item.fault === fault)!;

    expect(scenario("premature_completion").guardianRejections).toBeGreaterThan(0);
    expect(scenario("premature_completion").operationKinds).toContain("validate_criteria");
    expect(scenario("context_rollover").recoveryCategories).toContain("context_exhaustion");
    expect(scenario("context_rollover").dispatchCount).toBe(2);
    expect(scenario("provider_failure").recoveryCategories).toContain("provider_failure");
    expect(scenario("provider_failure").dispatchCount).toBe(2);
    expect(scenario("false_no_progress").waitTicks).toBeGreaterThanOrEqual(4);
    expect(scenario("false_no_progress").recoveryCategories).toEqual([]);
    expect(scenario("abrupt_process_restart").controllerOwners).toEqual(["controller-before", "controller-after"]);
    expect(scenario("abrupt_process_restart").dispatchCount).toBe(1);
  });

  it("registers durable-autonomy-v1 without weakening foundation checks", { timeout: 20_000 }, async () => {
    const acceptanceRoot = mkdtempSync(join(tmpdir(), "morrow-durable-runner-"));
    roots.push(acceptanceRoot);
    // Use a dedicated immutable Git source so concurrent repository-fixture
    // tests cannot transiently change the integrity fingerprint for this run.
    const source = createFoundationFixture(join(acceptanceRoot, "source"));
    const invoke: AcceptanceInvocation = async (args) => {
      if (args[0] === "init") return { exitCode: 0, stdout: JSON.stringify({ id: "project-1" }), stderr: "" };
      if (args[0] === "ask") return { exitCode: 0, stdout: JSON.stringify({ status: "completed", task: { id: "task-1", status: "completed" }, evidence: [{ path: "evidence.txt" }] }), stderr: "" };
      if (args[0] === "audit") return { exitCode: 0, stdout: JSON.stringify({ task: { id: "task-1", status: "completed" }, events: [{ type: "task.completed" }], evidence: [{ path: "evidence.txt" }] }), stderr: "" };
      if (args[0] === "stop") return { exitCode: 0, stdout: "", stderr: "" };
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };

    const result = await runAcceptance({
      acceptanceRoot,
      runId: "run-20260716-16000001",
      scenarioId: "durable-autonomy-v1",
      executable: "node",
      entrypoint: "compiled-morrow.mjs",
      packaged: true,
      version: "0.1.0-test",
      sourceCwd: source.path,
      port: 45131,
      invoke,
    });

    expect(result.state.disposition).toBe("PASS");
    expect(result.state.product?.missionId).toBe("mission-acceptance-premature_completion");
    expect(result.state.checks).toMatchObject({
      product_persistence: { status: "passed" },
      premature_completion: { status: "passed" },
      abrupt_process_restart: { status: "passed" },
      stable_mission_identity: { status: "passed" },
      unique_operation_keys: { status: "passed" },
    });
  });
});
