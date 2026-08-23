import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productVersion = JSON.parse(readFileSync(resolve(cliRoot, "../../package.json"), "utf8")).version as string;

describe("CLI launcher fast path", () => {
  it.each(["--version", "-v"])("prints the canonical version for %s without loading the command shell", (flag) => {
    const result = spawnSync(process.execPath, [resolve(cliRoot, "bin/morrow.mjs"), flag], {
      cwd: cliRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${productVersion}\n`);
  });
});
