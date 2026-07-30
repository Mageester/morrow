/**
 * Unit tests for the packaged launcher's command classifier.
 *
 * Run: node --test scripts/launcher-dispatch.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { canAdoptServicePid, classify, isMorrowHealth, needsService, serviceOwnership, LAUNCHER_LIFECYCLE } from "../installer/templates/dispatch.mjs";

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

// ── Service ownership ────────────────────────────────────────────────────────
//
// Every Morrow install and every dev worktree answers /api/health on the same
// fixed port. A launcher that adopted anything healthy would silently drive an
// unrelated orchestrator, so a freshly installed build — and any packaged proof
// run against it — would be exercising a different build entirely. Reproduced
// live: a dev orchestrator from C:\Morrow\worktrees\... held port 4317 and the
// packaged launcher adopted it without a word.

const OURS = { dataDir: "C:\Installs\Morrow\data", entry: "C:\Installs\Morrow\app\orchestrator\dist\src\index.js" };

test("service ownership accepts our own service by data root or entry", () => {
  assert.equal(serviceOwnership(
    { ok: true, service: "morrow-orchestrator", apiVersion: 1, serviceRoot: OURS.dataDir, serviceEntry: null },
    OURS,
  ), "ours");
  assert.equal(serviceOwnership(
    { ok: true, service: "morrow-orchestrator", apiVersion: 1, serviceRoot: null, serviceEntry: OURS.entry },
    OURS,
  ), "ours");
});

test("service ownership tolerates trailing separators and case", () => {
  assert.equal(serviceOwnership(
    { ok: true, service: "morrow-orchestrator", apiVersion: 1, serviceRoot: "c:\installs\morrow\data\\" },
    OURS,
  ), "ours");
});

test("service ownership rejects another install or a dev worktree on our port", () => {
  assert.equal(serviceOwnership(
    { ok: true, service: "morrow-orchestrator", apiVersion: 1, serviceRoot: "C:\Users\me\.morrow", serviceEntry: "C:\Morrow\worktrees\other\src\index.ts" },
    OURS,
  ), "foreign");
});

test("service ownership reports undecidable for a service that does not disclose its install", () => {
  assert.equal(serviceOwnership(
    { ok: true, service: "morrow-orchestrator", apiVersion: 1, ownerPid: 4242 },
    OURS,
  ), "undecidable");
});

test("service ownership still rejects a non-Morrow responder outright", () => {
  assert.equal(serviceOwnership({ ok: true, service: "other", apiVersion: 1 }, OURS), "not-morrow");
  assert.equal(serviceOwnership(null, OURS), "not-morrow");
});
