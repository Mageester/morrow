import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverSkills, verifySkill, skillsAsSlashCommands } from "../src/skills/registry.js";
import { SLASH_COMMANDS } from "../src/terminal/commands.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("local skills registry", () => {
  it("discovers only complete local skill packages", () => {
    const root = mkdtempSync(join(process.cwd(), "skill-test-")); roots.push(root);
    const skill = join(root, "testing"); mkdirSync(join(skill, "src"), { recursive: true }); mkdirSync(join(skill, "test"));
    writeFileSync(join(skill, "SKILL.md"), "# Testing\n");
    writeFileSync(join(skill, "permissions.json"), JSON.stringify({ tools: ["filesystem-read"], filesystemScopes: ["workspace"], networkDomains: [], requiredSecrets: [] }));
    writeFileSync(join(skill, "manifest.json"), JSON.stringify({ id: "testing", name: "Testing", version: "1.0.0", description: "Test", publisher: "Morrow", license: "Proprietary", checksum: "", entrypoint: "src/index.ts", supportedPlatforms: ["win32"], requestedTools: ["filesystem-read"], requestedFilesystemScopes: ["workspace"], requestedNetworkDomains: [], requiredSecrets: [], riskClass: "low" }));
    expect(discoverSkills(root).map((skill) => skill.id)).toEqual(["testing"]);
    expect(verifySkill(skill).ok).toBe(false);
  });

  // The built-in skills must ship and verify. The directory is user-writable
  // (the skill creator installs here), so we assert the built-ins as a subset
  // rather than an exact list that any created skill would break.
  const BUILT_IN_SKILLS = ["coding", "diagnostics", "documentation", "git-inspection", "repository-inspection", "testing"];

  it("verifies the bundled local skills", () => {
    const bundled = discoverSkills(join(process.cwd(), "../../skills"));
    const ids = bundled.map((skill) => skill.id);
    for (const known of BUILT_IN_SKILLS) {
      expect(ids).toContain(known);
      const skill = bundled.find((s) => s.id === known)!;
      expect(verifySkill(skill.directory).ok).toBe(true);
    }
  });

  it("surfaces verified bundled skills as namespaced slash commands that never collide with built-ins", () => {
    const commands = skillsAsSlashCommands(join(process.cwd(), "../../skills"));
    const names = commands.map((c) => c.name);
    for (const known of BUILT_IN_SKILLS) expect(names).toContain(`skill:${known}`);
    expect(commands.find((c) => c.name === "skill:coding")).toMatchObject({ skillId: "coding" });
    const builtinNames = new Set(SLASH_COMMANDS.map((c) => c.name));
    expect(commands.some((c) => builtinNames.has(c.name))).toBe(false);
  });

  it("omits tampered (unverified) skills from slash commands", () => {
    const root = mkdtempSync(join(process.cwd(), "skill-slash-")); roots.push(root);
    const skill = join(root, "tampered"); mkdirSync(join(skill, "src"), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "# Tampered\n");
    writeFileSync(join(skill, "permissions.json"), JSON.stringify({ tools: [] }));
    // checksum left empty → verifySkill fails → excluded from slash commands.
    writeFileSync(join(skill, "manifest.json"), JSON.stringify({ id: "tampered", name: "Tampered", version: "1.0.0", description: "x", publisher: "Morrow", license: "Proprietary", checksum: "", entrypoint: "src/index.ts", supportedPlatforms: ["win32"], requestedTools: [], requestedFilesystemScopes: [], requestedNetworkDomains: [], requiredSecrets: [], riskClass: "low" }));
    expect(skillsAsSlashCommands(root)).toEqual([]);
  });
});
