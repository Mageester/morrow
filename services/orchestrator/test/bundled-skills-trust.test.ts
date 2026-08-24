import { describe, expect, it } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { verifySkillDirectory } from "../src/skills/registry.js";

const skillsRoot = resolve(fileURLToPath(new URL("../../../skills", import.meta.url)));
const directories = readdirSync(skillsRoot).filter((name) => !name.startsWith(".") && existsSync(join(skillsRoot, name, "SKILL.md")));

/**
 * The agent's own gate, not the CLI's. A bundled skill that fails here is one
 * `load_skill` will refuse at runtime, which reads to a user as "Morrow says it
 * has a skill and then won't use it". The two registries drifted once already:
 * the CLI demanded a manifest entrypoint the orchestrator has always treated as
 * optional, so instruction-only skills verified for the agent and were invisible
 * to `morrow skills list`. Pinning both ends keeps them honest.
 */
describe("bundled skills pass the agent's trust gate", () => {
  it("has skills to check", () => {
    expect(directories.length).toBeGreaterThan(0);
  });

  it.each(directories)("verifies %s", (name) => {
    const result = verifySkillDirectory(join(skillsRoot, name));
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
