import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validateSkillSpec, generateSkillFiles, installSkill, createAndInstallSkill, type SkillSpec } from "../src/skills/creator.js";
import { discoverSkills, verifySkill } from "../src/skills/registry.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function tmpRoot(): string {
  const root = mkdtempSync(join(process.cwd(), "skill-creator-"));
  roots.push(root);
  return root;
}

const validSpec: SkillSpec = {
  id: "release-notes",
  name: "Release Notes",
  description: "Draft release notes from the git log",
  instructions: "Summarize merged changes since the last tag into clear, user-facing release notes.",
  requestedTools: ["git-inspection", "filesystem-read"],
  riskClass: "low",
};

describe("validateSkillSpec", () => {
  it("accepts a well-formed spec", () => {
    expect(validateSkillSpec(validSpec)).toEqual([]);
  });
  it("rejects a bad id, unknown tool, short instructions, and inlined secrets", () => {
    const issues = validateSkillSpec({
      ...validSpec,
      id: "Bad ID",
      requestedTools: ["telepathy"],
      instructions: "too short",
      requiredSecrets: ["API_KEY=sk-secret"],
    });
    expect(issues.join(" ")).toMatch(/kebab-case/);
    expect(issues.join(" ")).toMatch(/unknown tool: telepathy/);
    expect(issues.join(" ")).toMatch(/at least 20 characters/);
    expect(issues.join(" ")).toMatch(/names, not values/);
  });
});

describe("generateSkillFiles", () => {
  it("produces a bundle whose manifest checksum matches the generated SKILL.md", () => {
    const { files, manifest } = generateSkillFiles(validSpec);
    expect(Object.keys(files).sort()).toEqual(["SKILL.md", "manifest.json", "permissions.json", "src/index.ts"]);
    // Stage to disk and verify exactly as discovery would.
    const root = tmpRoot();
    const dir = join(root, manifest.id);
    mkdirSync(join(dir, "src"), { recursive: true });
    for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);
    expect(verifySkill(dir)).toEqual({ ok: true, issues: [] });
    // permissions.json reflects requested tools.
    expect(JSON.parse(readFileSync(join(dir, "permissions.json"), "utf8")).tools).toEqual(["git-inspection", "filesystem-read"]);
  });
});

describe("installSkill", () => {
  it("installs a verified bundle so discovery and verification pass", () => {
    const root = tmpRoot();
    const res = installSkill(root, generateSkillFiles(validSpec));
    expect(res.installed).toBe(true);
    expect(discoverSkills(root).map((s) => s.id)).toEqual(["release-notes"]);
    expect(verifySkill(res.directory).ok).toBe(true);
  });

  it("refuses to overwrite an existing skill unless explicitly allowed", () => {
    const root = tmpRoot();
    expect(installSkill(root, generateSkillFiles(validSpec)).installed).toBe(true);
    const second = installSkill(root, generateSkillFiles(validSpec));
    expect(second.installed).toBe(false);
    expect(second.issues.join(" ")).toMatch(/already exists/);
    // Overwrite is allowed only when explicitly requested (curator path).
    expect(installSkill(root, generateSkillFiles(validSpec), { overwrite: true }).installed).toBe(true);
  });

  it("leaves no staging directory behind on success", () => {
    const root = tmpRoot();
    installSkill(root, generateSkillFiles(validSpec));
    const leftovers = discoverSkills(root); // discovery only returns complete skills
    expect(leftovers.map((s) => s.id)).toEqual(["release-notes"]);
    // No hidden .staging-* directory should remain.
    expect(readdirSync(root).some((n: string) => n.startsWith(".staging-"))).toBe(false);
  });
});

describe("createAndInstallSkill", () => {
  it("validates before installing and reports issues without writing", () => {
    const root = tmpRoot();
    const bad = createAndInstallSkill(root, { ...validSpec, id: "Bad ID" });
    expect(bad.installed).toBe(false);
    expect(bad.issues.join(" ")).toMatch(/kebab-case/);
    const ok = createAndInstallSkill(root, validSpec);
    expect(ok.installed).toBe(true);
  });
});
