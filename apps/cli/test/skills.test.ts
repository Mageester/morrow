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

  it("verifies the bundled local skills", () => {
    const bundled = discoverSkills(join(process.cwd(), "../../skills"));
    expect(bundled.map((skill) => skill.id)).toEqual(["coding", "diagnostics", "documentation", "git-inspection", "repository-inspection", "testing"]);
    expect(bundled.map((skill) => verifySkill(skill.directory).ok)).toEqual([true, true, true, true, true, true]);
  });

  it("surfaces verified bundled skills as namespaced slash commands that never collide with built-ins", () => {
    const commands = skillsAsSlashCommands(join(process.cwd(), "../../skills"));
    expect(commands.map((c) => c.name)).toEqual([
      "skill:coding",
      "skill:diagnostics",
      "skill:documentation",
      "skill:git-inspection",
      "skill:repository-inspection",
      "skill:testing",
    ]);
    expect(commands[0]).toMatchObject({ skillId: "coding" });
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
