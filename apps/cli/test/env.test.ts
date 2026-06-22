import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecretsIntoEnv } from "../src/config/env.js";

describe("loadSecretsIntoEnv", () => {
  const tempRoots: string[] = [];
  const touchedKeys = new Set<string>();

  function secretsFile(body: string): string {
    const home = mkdtempSync(join(tmpdir(), "morrow-cli-env-"));
    tempRoots.push(home);
    const path = join(home, "secrets.env");
    writeFileSync(path, body);
    return path;
  }

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
    for (const key of touchedKeys) delete process.env[key];
    touchedKeys.clear();
  });

  it("applies saved secrets that are absent from the environment", () => {
    touchedKeys.add("DEEPSEEK_API_KEY");
    delete process.env.DEEPSEEK_API_KEY;
    const file = secretsFile("DEEPSEEK_API_KEY=sk-from-file\n");

    const { applied, shadowed } = loadSecretsIntoEnv({ secretsFile: file });

    expect(applied).toEqual(["DEEPSEEK_API_KEY"]);
    expect(shadowed).toEqual([]);
    expect(process.env.DEEPSEEK_API_KEY).toBe("sk-from-file");
  });

  it("reports a key as shadowed when the environment overrides it with a different value", () => {
    touchedKeys.add("DEEPSEEK_API_KEY");
    process.env.DEEPSEEK_API_KEY = "sk-from-shell";
    const file = secretsFile("DEEPSEEK_API_KEY=sk-from-file\n");

    const { applied, shadowed } = loadSecretsIntoEnv({ secretsFile: file });

    expect(applied).toEqual([]);
    expect(shadowed).toEqual(["DEEPSEEK_API_KEY"]);
    // The shell value is left untouched — precedence is preserved.
    expect(process.env.DEEPSEEK_API_KEY).toBe("sk-from-shell");
  });

  it("does not report a key as shadowed when the environment matches the saved value", () => {
    touchedKeys.add("DEEPSEEK_API_KEY");
    process.env.DEEPSEEK_API_KEY = "sk-same";
    const file = secretsFile("DEEPSEEK_API_KEY=sk-same\n");

    const { applied, shadowed } = loadSecretsIntoEnv({ secretsFile: file });

    expect(applied).toEqual([]);
    expect(shadowed).toEqual([]);
  });
});
