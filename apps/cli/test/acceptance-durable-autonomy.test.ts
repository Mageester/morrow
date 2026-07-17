import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DURABLE_AUTONOMY_FAULTS,
  runDurableAutonomyScenarios,
} from "../src/acceptance/scenarios/durable-autonomy.js";
import { runAcceptance, type AcceptanceInvocation } from "../src/acceptance/runner.js";
import { createFoundationFixture } from "../src/acceptance/fixture.js";
import { runExtendedProductiveMission } from "../src/acceptance/scenarios/extended-run.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable autonomy packaged acceptance scenarios", () => {
  it("runs a productive extended workload with checkpoints, rollover, restart, and recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-extended-acceptance-"));
    roots.push(root);

    const result = await runExtendedProductiveMission({ root });

    expect(result.passed, result.message ?? "extended run failed").toBe(true);
    expect(result.workUnits).toBeGreaterThanOrEqual(96);
    expect(result.progressObservations).toBeGreaterThanOrEqual(result.workUnits);
    expect(result.checkpoints).toBeGreaterThanOrEqual(8);
    expect(result.contextSegments).toBeGreaterThanOrEqual(4);
    expect(result.contextBoundaryReasons).toContain("context_pressure");
    expect(result.recoveryCategories).toEqual(expect.arrayContaining(["provider_failure", "tool_failure"]));
    expect(result.databaseRestarts).toBeGreaterThanOrEqual(1);
    expect(result.processHealth).toBe("ok");
    expect(result.deadlineMs).toBeNull();
    expect(result.userContinuations).toBe(0);
    expect(result.terminalState).toBe("completed");
  });

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
    const invoke: AcceptanceInvocation = async (args, options) => {
      if (args[0] === "init") return { exitCode: 0, stdout: JSON.stringify({ id: "project-1" }), stderr: "" };
      if (args[0] === "ask") return { exitCode: 0, stdout: JSON.stringify({ status: "completed", task: { id: "task-1", status: "completed" }, evidence: [{ path: "evidence.txt" }] }), stderr: "" };
      if (args[0] === "yolo") {
        writeFileSync(join(options.cwd, "src", "cart.mjs"), "export function tax(subtotal, rate = 0.13) {\n  return Math.round(subtotal * rate * 100) / 100;\n}\n");
        writeFileSync(join(options.cwd, "src", "receipt.mjs"), "export function receiptLine(item) {\n  return `${item.name} x ${item.quantity}: $${(item.price * item.quantity).toFixed(2)}`;\n}\n");
        writeFileSync(join(options.cwd, "test", "cart.test.mjs"), [
          'import test from "node:test";',
          'import assert from "node:assert/strict";',
          'import { tax } from "../src/cart.mjs";',
          'import { receiptLine } from "../src/receipt.mjs";',
          "",
          'test("calculates tax", () => assert.equal(tax(20), 2.6));',
          'test("rounds tax to cents", () => assert.equal(tax(19.99), 2.6));',
          'test("prints a quantity-aware receipt line", () => {',
          '  assert.equal(receiptLine({ name: "Coffee", price: 3.5, quantity: 2 }), "Coffee x 2: $7.00");',
          "});",
          "",
        ].join("\n"));
        return { exitCode: 0, stdout: JSON.stringify({ status: "completed", task: { id: "task-write", status: "completed" } }), stderr: "" };
      }
      if (args[0] === "models" && args[1] === "list") return {
        exitCode: 0,
        stdout: JSON.stringify([{ model: { id: "test-model", providerId: "mock", contextWindow: null, maxOutputTokens: null, lifecycle: "current", metadataSource: "unknown" }, available: true }]),
        stderr: "",
      };
      if (args[0] === "models" && args[1] === "info") return {
        exitCode: 0,
        stdout: JSON.stringify({ model: { id: "test-model", providerId: "mock", contextWindow: null, maxOutputTokens: null, lifecycle: "current", metadataSource: "unknown" }, available: true }),
        stderr: "",
      };
      if (args[0] === "restart") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "audit" && args[2] === "task-write") return {
        exitCode: 0,
        stdout: JSON.stringify({
          task: { id: "task-write", status: "completed" },
          events: [{ type: "task.completed" }],
          toolCalls: [
            { toolName: "run_command", status: "failed", resultJson: "Malformed JSON arguments" },
            { toolName: "run_command", status: "failed", resultJson: "tests failed" },
            { toolName: "propose_patch", status: "completed" },
            { toolName: "run_command", status: "completed" },
            { toolName: "git_diff", status: "completed" },
          ],
        }),
        stderr: "",
      };
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
      browserSiteScenario: async () => ({
        scenarioId: "browser-company-site-v1",
        passed: true,
        message: null,
        taskId: "task-browser-site",
        taskStatus: "completed",
        toolCalls: 15,
        screenshots: [
          { label: "desktop", path: "desktop.png", sha256: "a".repeat(64), bytes: 100, viewport: { width: 1440, height: 900 }, vision: "attached" },
          { label: "tablet", path: "tablet.png", sha256: "b".repeat(64), bytes: 100, viewport: { width: 768, height: 1024 }, vision: "attached" },
          { label: "mobile", path: "mobile.png", sha256: "c".repeat(64), bytes: 100, viewport: { width: 390, height: 844 }, vision: "attached" },
        ],
        consoleHealthy: true,
        interactionProven: true,
        testsPassed: true,
        userInterventions: 0,
        wallClockMs: 100,
      }),
      cortexLearningScenario: async () => ({
        scenarioId: "cortex-learning-v1",
        passed: true,
        message: null,
        memoryCreatedAutomatically: true,
        memoryRetrievedInMissionB: true,
        skillCandidateAfterMissionA: true,
        skillActiveAfterMissionB: true,
        skillAppliedInMissionC: true,
        skillId: "validate-test",
        skillVersion: "1.0.0",
        validationRequirements: ["two_distinct_successful_missions", "checksum", "permission_policy"],
        permissions: { tools: ["command-exec"], filesystemScopes: ["workspace"], networkDomains: [], requiredSecrets: [] },
        userMemoryCommands: 0,
        userSkillCommands: 0,
      }),
    });

    expect(result.state.disposition).toBe("PASS");
    expect(result.state.product?.missionId).toBe("mission-acceptance-premature_completion");
    expect(result.state.checks).toMatchObject({
      product_persistence: { status: "passed" },
      premature_completion: { status: "passed" },
      abrupt_process_restart: { status: "passed" },
      stable_mission_identity: { status: "passed" },
      unique_operation_keys: { status: "passed" },
      write_capable_bug_fix: { status: "passed" },
      malformed_tool_recovery: { status: "passed" },
      command_failure_recovery: { status: "passed" },
      browser_company_site: { status: "passed" },
      browser_vision: { status: "passed" },
      automatic_memory: { status: "passed" },
      automatic_skills: { status: "passed" },
      model_truth: { status: "passed" },
      extended_productive_run: { status: "passed" },
    });
  });
});
