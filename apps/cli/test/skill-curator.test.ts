import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { installSkill, generateSkillFiles, type SkillSpec } from "../src/skills/creator.js";
import { discoverSkills, verifySkill } from "../src/skills/registry.js";
import { findDuplicates, backupSkill, listBackups, rollbackSkill, archiveSkill, restoreArchived, listArchived } from "../src/skills/curator.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function tmpRoot(): string {
  const root = mkdtempSync(join(process.cwd(), "skill-curator-"));
  roots.push(root);
  return root;
}

function spec(id: string, instructions: string): SkillSpec {
  return { id, name: id, description: `desc ${id}`, instructions, requestedTools: ["filesystem-read"] };
}

/** Re-stamp the manifest checksum so a hand-edited SKILL.md still verifies. */
function reseal(dir: string): void {
  const md = readFileSync(join(dir, "SKILL.md"), "utf8");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  manifest.checksum = createHash("sha256").update(md).digest("hex");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

describe("findDuplicates", () => {
  it("flags a near-identical SKILL.md and ignores unrelated ones", () => {
    const root = tmpRoot();
    installSkill(root, generateSkillFiles(spec("alpha", "Summarize merged changes since the last release tag into notes.")));
    installSkill(root, generateSkillFiles(spec("beta", "Completely different purpose: render mermaid diagrams from yaml.")));
    const candidate = readFileSync(join(root, "alpha", "SKILL.md"), "utf8");
    const matches = findDuplicates(root, candidate, 0.8);
    expect(matches.map((m) => m.id)).toContain("alpha");
    expect(matches.map((m) => m.id)).not.toContain("beta");
  });
});

describe("backup / rollback", () => {
  it("backs up, then rolls back to restore the original SKILL.md and re-verifies", () => {
    const root = tmpRoot();
    installSkill(root, generateSkillFiles(spec("notes", "Original instructions describing the safe workflow in detail.")));
    const original = readFileSync(join(root, "notes", "SKILL.md"), "utf8");

    const stamp = backupSkill(root, "notes");
    expect(listBackups(root, "notes")).toContain(stamp);

    // Mutate the live skill (and reseal so it stays verifiable).
    writeFileSync(join(root, "notes", "SKILL.md"), original + "\n\n## Edited\nNew section.\n");
    reseal(join(root, "notes"));
    expect(readFileSync(join(root, "notes", "SKILL.md"), "utf8")).not.toBe(original);

    const result = rollbackSkill(root, "notes", stamp);
    expect(result.restored).toBe(true);
    expect(readFileSync(join(root, "notes", "SKILL.md"), "utf8")).toBe(original);
    expect(verifySkill(join(root, "notes")).ok).toBe(true);
  });

  it("refuses to roll back to a missing or unverifiable backup", () => {
    const root = tmpRoot();
    installSkill(root, generateSkillFiles(spec("notes", "Original instructions describing the safe workflow in detail.")));
    expect(rollbackSkill(root, "notes", "nope").restored).toBe(false);
  });
});

describe("archive / restore", () => {
  it("removes a skill from discovery, then restores it", () => {
    const root = tmpRoot();
    installSkill(root, generateSkillFiles(spec("temp", "A skill to archive then bring back when needed again.")));
    expect(discoverSkills(root).map((s) => s.id)).toEqual(["temp"]);

    archiveSkill(root, "temp");
    expect(discoverSkills(root).map((s) => s.id)).toEqual([]);
    expect(listArchived(root)).toEqual(["temp"]);

    expect(restoreArchived(root, "temp")).toBe(true);
    expect(discoverSkills(root).map((s) => s.id)).toEqual(["temp"]);
    expect(restoreArchived(root, "missing")).toBe(false);
  });
});

describe("improve (update) path", () => {
  it("backs up then overwrites, and the result still verifies and discovers", () => {
    const root = tmpRoot();
    installSkill(root, generateSkillFiles(spec("evolve", "First version of the instructions, long enough to validate.")));
    const stamp = backupSkill(root, "evolve");
    const updated = installSkill(root, generateSkillFiles(spec("evolve", "Second, improved version of the instructions with more detail.")), { overwrite: true });
    expect(updated.installed).toBe(true);
    expect(listBackups(root, "evolve")).toContain(stamp);
    expect(verifySkill(join(root, "evolve")).ok).toBe(true);
    expect(discoverSkills(root).map((s) => s.id)).toEqual(["evolve"]);
  });
});
