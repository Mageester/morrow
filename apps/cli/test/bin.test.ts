import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { MORROW_VERSION } from "../src/service/update.js";

const runFile = promisify(execFile);

describe("morrow executable", () => {
  it(
    "launches on Windows-compatible absolute paths",
    async () => {
      const bin = resolve(process.cwd(), "bin", "morrow.mjs");
      const result = await runFile(process.execPath, [bin, "--version"]);
      // Compared against the constant rather than a literal: a hardcoded
      // version turns every release bump into two unrelated red tests, which
      // is exactly what happened on beta.35. scripts/validate-repository.mjs
      // is what actually holds MORROW_VERSION and package.json in sync.
      expect(result.stdout.trim()).toBe(MORROW_VERSION);
    },
    // Spawns a real node.exe child process — the 5s default is too tight
    // under full-monorepo parallel test load (package-release.mjs's pnpm test
    // step runs all 14 packages' suites concurrently).
    20000,
  );
});
