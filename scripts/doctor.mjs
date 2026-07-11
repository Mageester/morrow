#!/usr/bin/env node
/**
 * Developer convenience wrapper for the canonical CLI doctor.
 * Packaged installs call that same command through installer/templates/morrow.mjs.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "apps", "cli", "bin", "morrow.mjs");
const result = spawnSync(process.execPath, [cli, "doctor", ...process.argv.slice(2)], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
