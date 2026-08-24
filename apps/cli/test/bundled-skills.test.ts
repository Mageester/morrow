import { describe, expect, it } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { discoverSkills, verifySkill } from "../src/skills/registry.js";

const skillsRoot = resolve(fileURLToPath(new URL("../../../skills", import.meta.url)));

/**
 * Every bundled skill must be discoverable AND verifiable. Both halves matter:
 * a skill with no manifest is silently skipped by discovery rather than
 * reported, and a skill whose SKILL.md drifted from its recorded checksum is
 * discovered but can never be enabled or offered as a slash command. Either
 * way the author sees a directory that looks installed and an agent that
 * cannot use it, with nothing anywhere saying why.
 */
describe("bundled skills", () => {
  const directories = readdirSync(skillsRoot).filter((name) => !name.startsWith(".") && existsSync(join(skillsRoot, name, "SKILL.md")));

  it("ships at least one skill", () => {
    expect(directories.length).toBeGreaterThan(0);
  });

  it("discovers every directory that has a SKILL.md", () => {
    const discovered = new Set(discoverSkills(skillsRoot).map((skill) => skill.id));
    const undiscovered = directories.filter((name) => !discovered.has(name));
    expect(undiscovered, `not discovered (missing or invalid manifest.json/permissions.json): ${undiscovered.join(", ")}`).toEqual([]);
  });

  it.each(readdirSync(skillsRoot).filter((name) => !name.startsWith(".") && existsSync(join(skillsRoot, name, "SKILL.md"))))(
    "verifies %s",
    (name) => {
      const result = verifySkill(join(skillsRoot, name));
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );
});
