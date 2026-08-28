import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { ALLOWED_RAW_STATUS_CALLERS, taskStatusAuthorityFailures } from "./lib/task-status-authority.mjs";

test("flags a production file that writes task status directly", () => {
  const failures = taskStatusAuthorityFailures([
    { path: "services/orchestrator/src/schedule/ticker.ts", source: "const x = 1;\ntasks.updateTaskStatus(id, { status: 'failed' });\n" },
  ]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /ticker\.ts:2/);
  assert.match(failures[0], /transitionTask/);
});

test("allows the repository that owns the column and the documented sample", () => {
  const failures = taskStatusAuthorityFailures(ALLOWED_RAW_STATUS_CALLERS.map((path) => ({
    path,
    source: "tasks.updateTaskStatus(id, { status: 'completed' });\n",
  })));
  assert.deepEqual(failures, []);
});

test("normalizes Windows-style paths so the allowlist still applies", () => {
  const failures = taskStatusAuthorityFailures([
    { path: "services\\orchestrator\\src\\repositories\\tasks.ts", source: "x.updateTaskStatus(id, {});\n" },
  ]);
  assert.deepEqual(failures, []);
});

test("reports every call site in one file rather than only the first", () => {
  const failures = taskStatusAuthorityFailures([
    { path: "services/orchestrator/src/a.ts", source: "a.updateTaskStatus(1);\nnoop();\nb.updateTaskStatus(2);\n" },
  ]);
  assert.equal(failures.length, 2);
});

test("the repository itself passes the check", async () => {
  const files = execFileSync("bash", ["-c",
    "find services/orchestrator/src -type f -name '*.ts' ! -name '*.test.ts'",
  ]).toString().split("\n").filter(Boolean);
  const sources = await Promise.all(files.map(async (path) => ({ path, source: await readFile(path, "utf8") })));
  assert.deepEqual(taskStatusAuthorityFailures(sources), []);
});
