import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CHECK_PREAMBLE, type EvalTask } from "./tasks.js";

export interface VerificationResult {
  passed: boolean;
  detail: string;
}

/**
 * Run a task's hidden ground-truth check against a finished workspace.
 *
 * The check never exists inside the workspace the agent worked in. The
 * workspace is copied somewhere else first and the check is written into the
 * copy, so no agent can read it, satisfy it by name, edit it, or delete it —
 * and a task that "passes" by rewriting its own tests cannot happen here.
 *
 * `node_modules` and `.git` are excluded from the copy: the tasks forbid
 * dependencies, and copying a checkout the agent may have created only slows
 * verification down.
 */
export function verifyTask(task: EvalTask, workspace: string): VerificationResult {
  const dir = mkdtempSync(join(tmpdir(), `verify-${task.id}-`));
  try {
    cpSync(workspace, dir, {
      recursive: true,
      filter: (source) => !source.includes(`${"/"}node_modules`) && !source.includes(`${"/"}.git${"/"}`) && !source.endsWith("/.git"),
    });
    writeFileSync(join(dir, "__check.mjs"), CHECK_PREAMBLE + task.check);
    const result = spawnSync(process.execPath, ["__check.mjs"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30_000,
      // TZ is pinned to a non-UTC zone deliberately. `date-utc-drift` asks for
      // a formatter that does not depend on local time, and on a UTC machine
      // the broken fixture would pass by coincidence. Pinning makes the task
      // discriminate identically on every machine.
      env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: "", TZ: "America/New_York" },
    });
    if (result.error) return { passed: false, detail: `check could not run: ${result.error.message}` };
    if (result.status === 0) return { passed: true, detail: "" };
    const stderr = (result.stderr ?? "").trim().split("\n").slice(-4).join(" | ");
    return { passed: false, detail: stderr || `check exited ${result.status}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
