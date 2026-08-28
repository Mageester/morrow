import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySkillInstall,
  describeSource,
  discardSkillInstall,
  parseSkillSource,
  planSkillInstall,
  removeInstalledSkill,
  skillInstallRoot,
  type SkillInstallPreview,
} from "../src/skills/install.js";
import { readTarGz, TarError } from "../src/skills/tar.js";
import { verifySkillDirectory } from "../src/skills/registry.js";

const TAR_LIMITS = { maxFileBytes: 1 << 20, maxTotalBytes: 8 << 20, maxEntries: 500, maxInflatedBytes: 8 << 20 };

let home: string;
let workspace: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "morrow-skill-home-"));
  workspace = mkdtempSync(join(tmpdir(), "morrow-skill-src-"));
  env = { ...process.env, MORROW_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function writeSkill(directory: string, files: Record<string, string>): string {
  mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const target = join(directory, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return directory;
}

const BARE_SKILL_MD = "---\nname: Release Notes\ndescription: Draft release notes from a changelog.\n---\n\n# Release Notes\n\nSteps go here.\n";

function ready(preview: SkillInstallPreview) {
  if (preview.kind !== "ready") throw new Error(`expected a ready preview, got ${preview.kind}`);
  return preview;
}

/**
 * The tar reader is the trust boundary for anything downloaded, so it is
 * tested against archives built by the system `tar` rather than by the code
 * under test — a hand-rolled fixture would only ever prove the reader agrees
 * with itself about the format.
 */
describe("skill bundle tar reader", () => {
  function tarball(name: string, build: (root: string) => void): string {
    const staging = join(workspace, `stage-${name}`);
    mkdirSync(staging, { recursive: true });
    build(staging);
    const archive = join(workspace, `${name}.tar.gz`);
    execFileSync("tar", ["czf", archive, "-C", staging, "."]);
    return archive;
  }

  it("reads a plain bundle", () => {
    const archive = tarball("plain", (root) => writeSkill(join(root, "demo"), { "SKILL.md": BARE_SKILL_MD }));
    const entries = readTarGz(readFileSync(archive), TAR_LIMITS);
    expect(entries.map((entry) => entry.path)).toContain("./demo/SKILL.md");
  });

  it("refuses a symlink, which is the ordinary way out of an extraction directory", () => {
    const archive = tarball("symlink", (root) => {
      writeSkill(root, { "SKILL.md": BARE_SKILL_MD });
      execFileSync("ln", ["-s", "/etc/passwd", join(root, "leak.md")]);
    });
    expect(() => readTarGz(readFileSync(archive), TAR_LIMITS)).toThrow(TarError);
  });

  it("refuses an absolute path", () => {
    const archive = join(workspace, "absolute.tar.gz");
    execFileSync("tar", ["czf", archive, "-P", "/etc/hostname"]);
    expect(() => readTarGz(readFileSync(archive), TAR_LIMITS)).toThrow(/absolute path/);
  });

  it("refuses a parent-directory escape", () => {
    const archive = join(workspace, "escape.tar.gz");
    const staging = join(workspace, "escape-src");
    writeSkill(join(staging, "demo"), { "SKILL.md": BARE_SKILL_MD });
    execFileSync("tar", ["czf", archive, "-C", staging, "--transform", "s|^./demo|../escaped|", "."]);
    expect(() => readTarGz(readFileSync(archive), TAR_LIMITS)).toThrow(/parent-directory/);
  });

  /**
   * The per-member limits are read from tar headers, which only exist after
   * the whole stream is decompressed. A bomb has to be stopped during
   * inflation or not at all.
   */
  it("refuses a bundle that inflates past the ceiling, before parsing it", () => {
    const archive = join(workspace, "bomb.tar.gz");
    const staging = join(workspace, "bomb-src");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "big"), Buffer.alloc(4 * 1024 * 1024, 0));
    execFileSync("tar", ["czf", archive, "-C", staging, "."]);
    expect(readFileSync(archive).byteLength).toBeLessThan(64 * 1024);
    expect(() => readTarGz(readFileSync(archive), { ...TAR_LIMITS, maxInflatedBytes: 64 * 1024 })).toThrow(/expands to more than/);
  });
});

describe("skill source parsing", () => {
  it("reads the forms a person actually types", () => {
    expect(parseSkillSource("owner/repo")).toEqual({ kind: "github", owner: "owner", repo: "repo", ref: "HEAD", subdir: null });
    expect(parseSkillSource("owner/repo@v1.2")).toMatchObject({ ref: "v1.2" });
    // A ref may contain slashes; the last "@" is still the split point.
    expect(parseSkillSource("owner/repo@release/2.0")).toMatchObject({ ref: "release/2.0" });
    expect(parseSkillSource("github:owner/repo/skills/pdf")).toMatchObject({ subdir: "skills/pdf" });
    // The URL in the address bar once you have navigated into a folder.
    expect(parseSkillSource("https://github.com/owner/repo/tree/dev/skills/pdf"))
      .toMatchObject({ ref: "dev", subdir: "skills/pdf" });
    expect(parseSkillSource("/tmp/bundle.tar.gz")).toMatchObject({ kind: "archive" });
    expect(parseSkillSource("./local/skill")).toMatchObject({ kind: "directory" });
  });

  /**
   * `owner/repo` has to mean GitHub, or the shorthand is unreachable — an
   * earlier version treated anything containing a separator as a path and
   * silently turned every GitHub install into a missing local directory.
   */
  it("keeps owner/repo as the GitHub shorthand and requires ./ for local paths", () => {
    expect(parseSkillSource("anthropics/skills")).toMatchObject({ kind: "github", owner: "anthropics" });
    expect(() => parseSkillSource("justaword")).toThrow(/owner\/repo/);
  });

  it("refuses sources it cannot vouch for", () => {
    expect(() => parseSkillSource("https://evil.example/owner/repo")).toThrow(/Only github.com/);
    expect(() => parseSkillSource("owner/repo@bad..ref")).toThrow(/not a valid git ref/);
    expect(() => parseSkillSource("../../etc/repo")).not.toThrow(); // an explicit local path is the caller's to name
  });

  it("describes a source the way it will be recorded", () => {
    expect(describeSource(parseSkillSource("owner/repo/skills/pdf@v1"))).toBe("github:owner/repo/skills/pdf@v1");
  });
});

describe("planning an install", () => {
  it("turns a bare SKILL.md folder into a verifiable skill and says what it invented", async () => {
    const source = writeSkill(join(workspace, "release-notes"), { "SKILL.md": BARE_SKILL_MD });
    const { plan, handle } = ready(await planSkillInstall(parseSkillSource(source), { env }));

    expect(plan.id).toBe("release-notes");
    expect(plan.name).toBe("Release Notes");
    // The empty permission set is Morrow's least-privilege default, not the
    // author's answer, and the plan has to be honest about which it is.
    expect(plan.permissions).toEqual({ tools: [], filesystemScopes: [], networkDomains: [], requiredSecrets: [] });
    expect(plan.generatedMetadata).toEqual(expect.arrayContaining(["manifest.json", "permissions.json"]));
    // An unvouched import is not "low risk" by default.
    expect(plan.riskClass).toBe("medium");

    discardSkillInstall(handle, { env });
  });

  /** Consent is worthless if the thing consented to is not the thing that lands. */
  it("installs nothing until the plan is applied", async () => {
    const source = writeSkill(join(workspace, "release-notes"), { "SKILL.md": BARE_SKILL_MD });
    const { plan, handle } = ready(await planSkillInstall(parseSkillSource(source), { env }));

    const target = join(skillInstallRoot(env), plan.id);
    expect(() => readFileSync(join(target, "SKILL.md"))).toThrow();

    const applied = applySkillInstall(handle, { env });
    expect(applied.directory).toBe(target);
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(BARE_SKILL_MD);
    expect(verifySkillDirectory(target).ok).toBe(true);
  });

  it("records where the skill came from, alongside it", async () => {
    const source = writeSkill(join(workspace, "release-notes"), { "SKILL.md": BARE_SKILL_MD });
    const { handle } = ready(await planSkillInstall(parseSkillSource(source), { env }));
    const applied = applySkillInstall(handle, { env });

    const manifest = JSON.parse(readFileSync(join(applied.directory, "manifest.json"), "utf8")) as Record<string, string>;
    expect(manifest.installedFrom).toBe(source);
    expect(manifest.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(manifest.checksum).toHaveLength(64);
  });

  /**
   * A checksum that disagrees with the file it covers is the only tamper
   * signal this format carries. Quietly recomputing it would erase exactly the
   * evidence it exists to preserve.
   */
  it("refuses a bundle whose manifest checksum does not match its SKILL.md", async () => {
    const source = writeSkill(join(workspace, "tampered"), {
      "SKILL.md": "# Tampered\n\nAltered after publication.\n",
      "manifest.json": JSON.stringify({ id: "tampered", name: "Tampered", version: "1.0.0", checksum: "0".repeat(64) }),
    });
    await expect(planSkillInstall(parseSkillSource(source), { env })).rejects.toThrow(/checksum does not match/);
  });

  it("refuses a bundle claiming a publisher reserved for skills Morrow grew itself", async () => {
    const source = writeSkill(join(workspace, "impostor"), {
      "SKILL.md": BARE_SKILL_MD,
      "manifest.json": JSON.stringify({ id: "impostor", name: "Impostor", version: "1.0.0", publisher: "morrow-cortex" }),
    });
    await expect(planSkillInstall(parseSkillSource(source), { env })).rejects.toThrow(/reserved publisher/);
  });

  it("surfaces the permissions an authored bundle asks for, and warns about the sharp ones", async () => {
    const source = writeSkill(join(workspace, "grabby"), {
      "SKILL.md": BARE_SKILL_MD,
      "manifest.json": JSON.stringify({ id: "grabby", name: "Grabby", version: "2.0.0", publisher: "Acme", riskClass: "high" }),
      "permissions.json": JSON.stringify({ tools: ["command-exec"], filesystemScopes: ["workspace"], networkDomains: ["acme.example"], requiredSecrets: ["ACME_TOKEN"] }),
    });
    const { plan, handle } = ready(await planSkillInstall(parseSkillSource(source), { env }));

    expect(plan.permissions.tools).toEqual(["command-exec"]);
    expect(plan.generatedMetadata).not.toContain("permissions.json");
    expect(plan.warnings.join(" ")).toMatch(/network access to acme.example/);
    expect(plan.warnings.join(" ")).toMatch(/ACME_TOKEN/);
    expect(plan.warnings.join(" ")).toMatch(/high risk/);
    discardSkillInstall(handle, { env });
  });

  it("offers the choice when a source holds several skills, at any depth", async () => {
    writeSkill(join(workspace, "repo", "skills", "alpha"), { "SKILL.md": "---\nname: Alpha\ndescription: First.\n---\n\n# Alpha\n" });
    writeSkill(join(workspace, "repo", "skills", "beta"), { "SKILL.md": "---\nname: Beta\ndescription: Second.\n---\n\n# Beta\n" });
    writeSkill(join(workspace, "repo", "template"), { "SKILL.md": "---\nname: Template\ndescription: Third.\n---\n\n# Template\n" });

    const preview = await planSkillInstall(parseSkillSource(join(workspace, "repo")), { env });
    if (preview.kind !== "choices") throw new Error("expected choices");
    expect(preview.candidates.map((candidate) => candidate.subdir).sort())
      .toEqual(["skills/alpha", "skills/beta", "template"]);

    const chosen = ready(await planSkillInstall(parseSkillSource(join(workspace, "repo")), { env, subdir: "skills/beta" }));
    expect(chosen.plan.id).toBe("beta");
    discardSkillInstall(chosen.handle, { env });
  });

  /** A skill owns its whole subtree; a nested SKILL.md is part of it, not a sibling. */
  it("does not offer a skill nested inside another skill", async () => {
    writeSkill(join(workspace, "repo", "outer"), { "SKILL.md": "---\nname: Outer\ndescription: One.\n---\n\n# Outer\n" });
    writeSkill(join(workspace, "repo", "outer", "examples"), { "SKILL.md": "---\nname: Example\ndescription: Two.\n---\n\n# Example\n" });
    writeSkill(join(workspace, "repo", "sibling"), { "SKILL.md": "---\nname: Sibling\ndescription: Three.\n---\n\n# Sibling\n" });

    const preview = await planSkillInstall(parseSkillSource(join(workspace, "repo")), { env });
    if (preview.kind !== "choices") throw new Error("expected choices");
    expect(preview.candidates.map((candidate) => candidate.subdir).sort()).toEqual(["outer", "sibling"]);
  });

  /**
   * Published skills write long descriptions as folded block scalars. Reading
   * only the first line captured the ">" itself and offered that to the user
   * as the summary of what they were about to install.
   */
  it("reads a folded frontmatter description rather than the fold marker", async () => {
    const source = writeSkill(join(workspace, "folded"), {
      "SKILL.md": "---\nname: Folded\ndescription: >\n  Draft release notes from a changelog,\n  wrapped across lines.\n---\n\n# Folded\n",
    });
    const { plan, handle } = ready(await planSkillInstall(parseSkillSource(source), { env }));
    expect(plan.description).toBe("Draft release notes from a changelog, wrapped across lines.");
    discardSkillInstall(handle, { env });
  });

  it("refuses a source with no skill in it", async () => {
    writeSkill(join(workspace, "empty"), { "README.md": "nothing here" });
    await expect(planSkillInstall(parseSkillSource(join(workspace, "empty")), { env })).rejects.toThrow(/no SKILL.md/);
  });

  it("refuses a symlink inside a source directory", async () => {
    const source = writeSkill(join(workspace, "linky"), { "SKILL.md": BARE_SKILL_MD });
    execFileSync("ln", ["-s", "/etc/passwd", join(source, "leak.md")]);
    await expect(planSkillInstall(parseSkillSource(source), { env })).rejects.toThrow(/symlink/);
  });
});

describe("applying and removing", () => {
  async function install(id: string, markdown = BARE_SKILL_MD): Promise<string> {
    const source = writeSkill(join(workspace, id), { "SKILL.md": markdown });
    const { handle } = ready(await planSkillInstall(parseSkillSource(source), { env }));
    return applySkillInstall(handle, { env }).directory;
  }

  it("refuses to replace an installed skill unless asked to", async () => {
    await install("release-notes");
    const source = join(workspace, "release-notes");
    await expect(planSkillInstall(parseSkillSource(source), { env })).rejects.toThrow(/already installed/);

    const replacement = ready(await planSkillInstall(parseSkillSource(source), { env, overwrite: true }));
    expect(replacement.plan.replaces).toBe("0.0.0");
    applySkillInstall(replacement.handle, { env });
  });

  it("keeps a replacement successful and manages the displaced backup when cleanup fails", async () => {
    const original = await install("release-notes", "---\nname: Release Notes\ndescription: Original release notes workflow.\n---\n\n# Original\n\nOriginal instructions.\n");
    const source = join(workspace, "release-notes");
    writeFileSync(join(source, "SKILL.md"), "---\nname: Release Notes\ndescription: Replacement release notes workflow.\n---\n\n# Replacement\n\nReplacement instructions.\n");
    const replacement = ready(await planSkillInstall(parseSkillSource(source), { env, overwrite: true }));
    const applied = applySkillInstall(replacement.handle, {
      env,
      cleanupDisplaced: () => { throw new Error("cleanup unavailable"); },
    });

    expect(applied.directory).toBe(original);
    expect(readFileSync(join(original, "SKILL.md"), "utf8")).toContain("Replacement instructions");
    expect(readdirSync(skillInstallRoot(env))).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.replaced-/)]));
    expect(existsSync(join(skillInstallRoot(env), ".backups", "release-notes"))).toBe(true);
  });

  it("spends a handle on use, so the same plan cannot be applied twice", async () => {
    const source = writeSkill(join(workspace, "once"), { "SKILL.md": BARE_SKILL_MD });
    const { handle } = ready(await planSkillInstall(parseSkillSource(source), { env }));
    applySkillInstall(handle, { env });
    expect(() => applySkillInstall(handle, { env })).toThrow(/expired or was already applied/);
  });

  it("refuses a handle it did not issue", () => {
    expect(() => applySkillInstall("../../etc", { env })).toThrow(/Invalid install handle/);
  });

  it("removes an installed skill", async () => {
    const directory = await install("release-notes");
    expect(removeInstalledSkill("release-notes", { env })).toMatchObject({ removed: true, directory });
    expect(() => removeInstalledSkill("release-notes", { env })).toThrow(/No installed skill/);
  });

  it("restores a user skill when activation removal fails", async () => {
    const directory = await install("release-notes");
    expect(() => removeInstalledSkill("release-notes", {
      env,
      onRemoved: () => { throw new Error("activation store unavailable"); },
    })).toThrow(/activation could not be cleared/);
    expect(existsSync(directory)).toBe(true);
    expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toBe(BARE_SKILL_MD);

    expect(removeInstalledSkill("release-notes", { env })).toMatchObject({ removed: true, directory });
  });

  /**
   * Bundled skills ship with the product and an upgrade puts them back, so a
   * remove that appeared to work would silently undo itself.
   */
  it("will not remove a skill it did not install", () => {
    expect(() => removeInstalledSkill("accessibility", { env })).toThrow(/Bundled skills cannot be removed/);
  });
});
