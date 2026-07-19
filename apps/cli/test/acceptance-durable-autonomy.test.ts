import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DURABLE_AUTONOMY_FAULTS,
  runDurableAutonomyScenarios,
} from "../src/acceptance/scenarios/durable-autonomy.js";
import { runAcceptance, type AcceptanceInvocation } from "../src/acceptance/runner.js";
import { createFoundationFixture } from "../src/acceptance/fixture.js";
import { runSustainedAutonomyAcceptance } from "@morrow/orchestrator";

const roots: string[] = [];

// Agent file-write side effects (MORROW_HOME/backups) must land in an
// isolated home, never the real user home.
let prevHome: string | undefined;
beforeEach(() => {
  prevHome = process.env.MORROW_HOME;
  const home = mkdtempSync(join(tmpdir(), "morrow-acceptance-home-"));
  roots.push(home);
  process.env.MORROW_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.MORROW_HOME; else process.env.MORROW_HOME = prevHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable autonomy packaged acceptance scenarios", () => {
  it("drives the real controller/runner/Guardian stack through a sustained productive mission", async () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-sustained-acceptance-"));
    roots.push(root);

    const result = await runSustainedAutonomyAcceptance({ root });

    expect(result.passed, result.message ?? "sustained autonomy scenario failed").toBe(true);
    expect(result.productiveWorkUnits).toBeGreaterThanOrEqual(96);
    expect(result.progressObservationCount).toBeGreaterThan(0);
    expect(result.contextRolloverCount).toBeGreaterThanOrEqual(3);
    expect(result.checkpointCount).toBeGreaterThan(0);
    expect(result.recoveryCount).toBeGreaterThanOrEqual(2);
    expect(result.databaseRestartCount).toBe(1);
    expect(result.leaseGenerationAfterRestart).toBeGreaterThan(result.leaseGenerationBeforeRestart);
    expect(result.duplicateCompletedOperations).toBe(0);
    expect(result.guardianRejectionCount).toBeGreaterThan(0);
    expect(result.guardianAuthorizationCount).toBe(1);
    expect(result.sqliteIntegrity).toBe("ok");
    expect(result.deadlineMs).toBeNull();
    expect(result.userContinuations).toBe(0);
    expect(result.terminalState).toBe("completed");
  }, 60_000);

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

  it("registers durable-autonomy-v1 without weakening foundation checks", { timeout: 90_000 }, async () => {
    const acceptanceRoot = mkdtempSync(join(tmpdir(), "morrow-durable-runner-"));
    roots.push(acceptanceRoot);
    // Use a dedicated immutable Git source so concurrent repository-fixture
    // tests cannot transiently change the integrity fingerprint for this run.
    const source = createFoundationFixture(join(acceptanceRoot, "source"));
    const invoke: AcceptanceInvocation = async (args, options) => {
      if (args[0] === "provenance") return {
        exitCode: 0,
        stdout: JSON.stringify({
          packaged: true,
          provenance: {
            schemaVersion: 1, version: "0.1.0-test", sourceCommit: source.startingSha, dirty: false,
            buildTimestamp: "2026-07-16T00:00:00.000Z", schemaCatalogVersion: 1, manifestHash: "e".repeat(64),
          },
        }),
        stderr: "",
      };
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
      browserSiteScenario: async ({ root }) => {
        mkdirSync(root, { recursive: true });
        const screenshots = [
          { label: "company-site-desktop", viewport: { width: 1440, height: 900 } },
          { label: "company-site-tablet", viewport: { width: 768, height: 1024 } },
          { label: "company-site-mobile", viewport: { width: 390, height: 844 } },
        ].map((item) => {
          const path = join(root, `${item.label}.png`);
          const content = Buffer.from("89504e470d0a1a0a", "hex");
          writeFileSync(path, content);
          return { ...item, path, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length, vision: "attached" };
        });
        return {
          scenarioId: "browser-company-site-v1",
          passed: true,
          message: null,
          taskId: "task-browser-site",
          taskStatus: "completed",
          toolCalls: 15,
          screenshots,
          consoleHealthy: true,
          interactionProven: true,
          testsPassed: true,
          userInterventions: 0,
          wallClockMs: 100,
        };
      },
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
      package_provenance: { status: "passed" },
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
      sustained_autonomy_production_run: { status: "passed" },
      sustained_autonomy_work_units: { status: "passed" },
      sustained_autonomy_rollovers: { status: "passed" },
      sustained_autonomy_recoveries: { status: "passed" },
      sustained_autonomy_restart: { status: "passed" },
      sustained_autonomy_no_duplicates: { status: "passed" },
      sustained_autonomy_guardian: { status: "passed" },
      sustained_autonomy_terminal: { status: "passed" },
      sustained_autonomy_no_deadline: { status: "passed" },
      sustained_autonomy_integrity: { status: "passed" },
    });
  });
});
