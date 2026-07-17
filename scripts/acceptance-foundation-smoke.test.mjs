import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSmokeEnvironment, inspectAcceptanceArtifacts } from "./acceptance-foundation-smoke.mjs";

test("packaged smoke environment excludes provider credentials", () => {
  const env = buildSmokeEnvironment({
    Path: "C:\\Windows", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp",
    USERPROFILE: "C:\\Users\\person", OPENAI_API_KEY: "sk-secret", ANTHROPIC_API_KEY: "secret",
  }, "canary-secret");
  assert.equal(env.Path, "C:\\Windows");
  assert.equal(env.MORROW_ACCEPTANCE_TEST_SECRET, "canary-secret");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("acceptance artifact inspection requires a PASS with product and fixture proof", () => {
  const root = mkdtempSync(join(tmpdir(), "morrow-acceptance-artifact-test-"));
  try {
    mkdirSync(join(root, "artifacts"), { recursive: true });
    writeFileSync(join(root, "report.json"), JSON.stringify({
      scenarioId: "foundation-smoke-v1",
      disposition: "PASS",
      fixture: { startingSha: "a".repeat(40) },
      product: { packaged: true, taskId: "task-1", exitCode: 0 },
      checks: { product_persistence: { status: "passed" }, secrets_absent: { status: "passed" } },
    }));
    writeFileSync(join(root, "report.md"), "# PASS\n");
    writeFileSync(join(root, "evidence.jsonl"), `${JSON.stringify({ step: "product-persistence", status: "passed" })}\n`);
    const result = inspectAcceptanceArtifacts(root, ["canary-secret"]);
    assert.equal(result.runId, root.split(/[\\/]/).pop());
    assert.equal(result.disposition, "PASS");
    assert.equal(result.startingSha, "a".repeat(40));
    assert.equal(result.taskId, "task-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptance artifact inspection rejects non-pass and leaked secret evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "morrow-acceptance-artifact-test-"));
  try {
    writeFileSync(join(root, "report.json"), JSON.stringify({ disposition: "FAIL" }));
    writeFileSync(join(root, "report.md"), "canary-secret\n");
    writeFileSync(join(root, "evidence.jsonl"), "");
    assert.throws(() => inspectAcceptanceArtifacts(root, ["canary-secret"]), /PASS/);
    writeFileSync(join(root, "report.json"), JSON.stringify({
      scenarioId: "foundation-smoke-v1", disposition: "PASS", fixture: { startingSha: "b".repeat(40) },
      product: { packaged: true, taskId: "task-2", exitCode: 0 },
      checks: { product_persistence: { status: "passed" }, secrets_absent: { status: "passed" } },
    }));
    writeFileSync(join(root, "evidence.jsonl"), `${JSON.stringify({ step: "product-persistence", status: "passed" })}\n`);
    assert.throws(() => inspectAcceptanceArtifacts(root, ["canary-secret"]), /secret/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable acceptance inspection requires all fault and ledger proofs", () => {
  const root = mkdtempSync(join(tmpdir(), "morrow-acceptance-artifact-test-"));
  try {
    mkdirSync(join(root, "artifacts"), { recursive: true });
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const pngSha256 = createHash("sha256").update(png).digest("hex");
    const screenshots = ["desktop", "tablet", "mobile"].map((label) => {
      const artifact = `artifacts/company-site-${label}.png`;
      writeFileSync(join(root, artifact), png);
      return { label, artifact, sha256: pngSha256 };
    });
    const passed = Object.fromEntries([
      "product_persistence", "secrets_absent", "premature_completion", "context_rollover",
      "provider_failure", "false_no_progress", "abrupt_process_restart", "stable_mission_identity",
      "unique_operation_keys", "terminal_completion",
      "extended_productive_run",
      "write_capable_bug_fix",
      "malformed_tool_recovery",
      "command_failure_recovery",
      "diff_inspected",
      "browser_company_site",
      "browser_vision",
      "frontend_visual_validation",
      "automatic_memory",
      "automatic_skills",
      "model_truth",
    ].map((key) => [key, { status: "passed" }]));
    writeFileSync(join(root, "report.json"), JSON.stringify({
      scenarioId: "durable-autonomy-v1", disposition: "PASS", fixture: { startingSha: "c".repeat(40) },
      product: { packaged: true, taskId: "task-3", missionId: "mission-3", exitCode: 0 }, checks: passed,
      evidence: [{ kind: "packaged-browser-vision", details: { screenshots } }],
    }));
    writeFileSync(join(root, "report.md"), "# PASS\n");
    writeFileSync(join(root, "evidence.jsonl"), `${JSON.stringify({ step: "product-persistence", status: "passed" })}\n`);
    assert.equal(inspectAcceptanceArtifacts(root, [], "durable-autonomy-v1").missionId, "mission-3");
    const report = JSON.parse(readFileSync(join(root, "report.json"), "utf8"));
    report.checks.context_rollover.status = "failed";
    writeFileSync(join(root, "report.json"), JSON.stringify(report));
    assert.throws(() => inspectAcceptanceArtifacts(root, [], "durable-autonomy-v1"), /context_rollover/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
