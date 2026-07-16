import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
      disposition: "PASS", fixture: { startingSha: "b".repeat(40) },
      product: { packaged: true, taskId: "task-2", exitCode: 0 },
      checks: { product_persistence: { status: "passed" }, secrets_absent: { status: "passed" } },
    }));
    writeFileSync(join(root, "evidence.jsonl"), `${JSON.stringify({ step: "product-persistence", status: "passed" })}\n`);
    assert.throws(() => inspectAcceptanceArtifacts(root, ["canary-secret"]), /secret/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
