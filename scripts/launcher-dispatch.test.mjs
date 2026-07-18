/**
 * Unit tests for the packaged launcher's command classifier.
 *
 * Run: node --test scripts/launcher-dispatch.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { canAdoptServicePid, classify, isMorrowHealth, needsService, LAUNCHER_LIFECYCLE } from "../installer/templates/dispatch.mjs";

test("bare invocation opens the interactive terminal shell", () => {
  assert.deepEqual(classify([]), { action: "interactive", command: undefined, args: [] });
});

test("lifecycle verbs are serviced by the launcher itself", () => {
  for (const command of ["start", "stop", "restart", "status", "uninstall"]) {
    assert.equal(classify([command]).action, "lifecycle", command);
    assert.ok(LAUNCHER_LIFECYCLE.has(command));
  }
});

test("doctor delegates to the canonical CLI without starting the service", () => {
  assert.equal(classify(["doctor"]).action, "cli-offline");
  assert.ok(!LAUNCHER_LIFECYCLE.has("doctor"));
  assert.ok(!needsService("cli-offline"));
});

test("open launches the browser UI", () => {
  assert.equal(classify(["open"]).action, "open");
});

test("product commands delegate to the bundled CLI with args intact", () => {
  for (const command of ["ask", "fix", "plan", "yolo", "mission", "new", "symbols", "processes", "worktrees", "integrate", "projects", "chat"]) {
    assert.equal(classify([command]).action, "cli", command);
  }
  const c = classify(["yolo", "fix", "the", "tests"]);
  assert.equal(c.command, "yolo");
  assert.deepEqual(c.args, ["fix", "the", "tests"]);
});

test("an implicit one-shot prompt delegates to the CLI", () => {
  assert.equal(classify(["Explain", "this", "repo"]).action, "cli");
});

test("help and version are answered as meta actions", () => {
  for (const flag of ["help", "--help", "-h", "version", "--version", "-v"]) {
    assert.equal(classify([flag]).action, "meta", flag);
  }
});

test("needsService covers the paths that talk to the orchestrator", () => {
  assert.ok(needsService("cli"));
  assert.ok(needsService("interactive"));
  assert.ok(needsService("open"));
  assert.ok(!needsService("lifecycle"));
  assert.ok(!needsService("meta"));
});

test("health validation rejects an unrelated server returning HTTP 200", () => {
  assert.equal(isMorrowHealth({ ok: true, service: "morrow-orchestrator", apiVersion: 1 }), true);
  assert.equal(isMorrowHealth({ ok: true, service: "other-service", apiVersion: 1 }), false);
  assert.equal(isMorrowHealth({ ok: true }), false);
  assert.equal(isMorrowHealth(null), false);
});

test("pid recovery requires both Morrow health identity and process ownership", () => {
  const health = { ok: true, service: "morrow-orchestrator", apiVersion: 1, ownerPid: 12345 };
  assert.equal(canAdoptServicePid(health, true), 12345);
  assert.equal(canAdoptServicePid(health, false), 0);
  assert.equal(canAdoptServicePid({ ...health, service: "other" }, true), 0);
});

test("launcher template honours a user MORROW_HOME override for data/service/CLI", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../installer/templates/morrow.mjs", import.meta.url), "utf8");
  // Beta.32 packaged-acceptance regression: the launcher pinned MORROW_HOME to
  // join(install, "data") for both the delegated CLI and the spawned service,
  // silently ignoring the documented user override (RELEASE.md).
  assert.ok(source.includes('const data = process.env.MORROW_HOME ? process.env.MORROW_HOME : join(install, "data")'));
  assert.ok(!source.includes('const data = join(install, "data")'));
});
