import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const runFile = promisify(execFile);

describe("morrow executable", () => {
  it("launches on Windows-compatible absolute paths", async () => {
    const bin = resolve(process.cwd(), "bin", "morrow.mjs");
    const result = await runFile(process.execPath, [bin, "--version"]);
    expect(result.stdout.trim()).toBe("0.1.0-beta.30");
  });
});
