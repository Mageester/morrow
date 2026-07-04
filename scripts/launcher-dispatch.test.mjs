/**
 * Unit tests for the packaged launcher's command classifier.
 *
 * Run: node --test scripts/launcher-dispatch.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { classify, needsService, LAUNCHER_LIFECYCLE } from "../installer/templates/dispatch.mjs";

test("bare invocation opens the interactive terminal shell", () => {
  assert.deepEqual(classify([]), { action: "interactive", command: undefined, args: [] });
});

test("lifecycle verbs are serviced by the launcher itself", () => {
  for (const command of ["start", "stop", "restart", "status", "doctor", "uninstall"]) {
    assert.equal(classify([command]).action, "lifecycle", command);
    assert.ok(LAUNCHER_LIFECYCLE.has(command));
  }
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
