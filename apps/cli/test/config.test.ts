import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config/config.js";

describe("configuration precedence", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("uses user config over environment defaults without exposing secrets", () => {
    const home = mkdtempSync(join(tmpdir(), "morrow-cli-config-"));
    tempRoots.push(home);
    writeFileSync(join(home, "config.json"), JSON.stringify({ defaults: { preset: "coding" } }));

    const config = ConfigStore.load({ MORROW_HOME: home, MORROW_DEFAULT_PRESET: "fast" }, home);

    expect(config.get("defaults.preset")).toBe("coding");
    expect(config.flat()).toContainEqual({ key: "defaults.preset", value: "coding", source: "user" });
    expect(config.flat().map((entry) => entry.key)).not.toContain("OPENAI_API_KEY");
  });

  it("uses environment defaults when no config overrides them", () => {
    const home = mkdtempSync(join(tmpdir(), "morrow-cli-config-"));
    tempRoots.push(home);

    const config = ConfigStore.load({ MORROW_HOME: home, MORROW_DEFAULT_MODEL: "gpt-test" }, home);

    expect(config.get("defaults.model")).toBe("gpt-test");
  });
});
