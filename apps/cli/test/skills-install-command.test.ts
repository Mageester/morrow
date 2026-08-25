import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "../src/cli/context.js";
import { ConfigStore } from "../src/config/config.js";
import { Output } from "../src/cli/output.js";
import { skillsCommand } from "../src/commands/skills.js";
import type { SkillInstallPlan, SkillInstallPreview } from "../src/client/api.js";
import * as common from "../src/commands/common.js";

/**
 * The command owns one thing: consent. The fetching, normalizing, verifying
 * and staging all happen in the service, so what is worth pinning here is that
 * a person is shown what they are agreeing to, that declining installs
 * nothing, and that a non-interactive run cannot install by default.
 */
describe("morrow skills install", () => {
  let home: string;
  let ctx: Context;
  let api: {
    previewSkillInstall: ReturnType<typeof vi.fn>;
    applySkillInstall: ReturnType<typeof vi.fn>;
    discardSkillInstall: ReturnType<typeof vi.fn>;
    removeSkill: ReturnType<typeof vi.fn>;
  };
  let printed: string[];

  const PLAN: SkillInstallPlan = {
    id: "release-notes",
    name: "Release Notes",
    version: "1.0.0",
    description: "Draft release notes from a changelog.",
    publisher: "github:acme",
    riskClass: "medium",
    source: "github:acme/skills@main",
    checksum: "a".repeat(64),
    permissions: { tools: ["command-exec"], filesystemScopes: ["workspace"], networkDomains: [], requiredSecrets: [] },
    files: [{ path: "SKILL.md", bytes: 120 }],
    generatedMetadata: ["permissions.json"],
    replaces: null,
    warnings: ["Installed from the moving ref \"main\"; pin a tag or commit for a reproducible install"],
  };

  const readyPreview: SkillInstallPreview = { kind: "ready", plan: PLAN, handle: "handle-1" };

  function contextWith(flags: Record<string, unknown>): Context {
    const config = ConfigStore.load({ MORROW_HOME: home }, home);
    const context = new Context({
      out: new Output({ json: Boolean(flags.json), quiet: false, color: false }),
      config,
      paths: config.paths,
      flags: flags as any,
    });
    context.api = () => api as any;
    return context;
  }

  beforeEach(() => {
    printed = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => { printed.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => { printed.push(String(chunk)); return true; });
    home = mkdtempSync(join(tmpdir(), "morrow-install-cli-"));
    api = {
      previewSkillInstall: vi.fn(async () => readyPreview),
      applySkillInstall: vi.fn(async () => ({ id: "release-notes", directory: join(home, "skills", "release-notes"), enabled: false })),
      discardSkillInstall: vi.fn(async () => undefined),
      removeSkill: vi.fn(async () => undefined),
    };
    ctx = contextWith({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  const output = (): string => printed.join("");

  it("shows the provenance, permissions and invented metadata before installing", async () => {
    vi.spyOn(common, "isInteractive").mockReturnValue(true);
    const confirm = vi.spyOn(common, "confirm").mockResolvedValue(true);

    expect(await skillsCommand(ctx, "install", ["acme/skills"])).toBe(0);

    const shown = output();
    expect(shown).toContain("github:acme/skills@main");
    expect(shown).toContain("command-exec");
    // The reader has to know the permission file was Morrow's, not the author's.
    expect(shown).toMatch(/generated permissions.json/i);
    expect(shown).toContain("moving ref");
    expect(confirm).toHaveBeenCalled();
    expect(api.applySkillInstall).toHaveBeenCalledWith("handle-1");
  });

  it("installs nothing when the answer is no, and releases the staged bundle", async () => {
    vi.spyOn(common, "isInteractive").mockReturnValue(true);
    vi.spyOn(common, "confirm").mockResolvedValue(false);

    expect(await skillsCommand(ctx, "install", ["acme/skills"])).toBe(0);
    expect(api.applySkillInstall).not.toHaveBeenCalled();
    expect(api.discardSkillInstall).toHaveBeenCalledWith("handle-1");
  });

  /**
   * A script has no one to ask, and a skill is instructions the agent will
   * follow — so silence is refusal rather than assent.
   */
  it("refuses to install unattended unless --yes was given", async () => {
    vi.spyOn(common, "isInteractive").mockReturnValue(false);
    await expect(skillsCommand(ctx, "install", ["acme/skills"])).rejects.toThrow(/without confirmation/);
    expect(api.applySkillInstall).not.toHaveBeenCalled();

    const yes = contextWith({ yes: true });
    expect(await skillsCommand(yes, "install", ["acme/skills"])).toBe(0);
    expect(api.applySkillInstall).toHaveBeenCalledWith("handle-1");
  });

  it("says the skill is installed but not yet enabled", async () => {
    const yes = contextWith({ yes: true });
    await skillsCommand(yes, "install", ["acme/skills"]);
    expect(output()).toMatch(/morrow skills enable release-notes/);
  });

  it("lists the skills in a source that holds several instead of picking one", async () => {
    api.previewSkillInstall.mockResolvedValue({
      kind: "choices",
      source: "github:acme/skills@HEAD",
      candidates: [
        { subdir: "skills/alpha", id: "alpha", name: "Alpha", description: "One." },
        { subdir: "skills/beta", id: "beta", name: "Beta", description: "Two." },
      ],
    } satisfies SkillInstallPreview);

    expect(await skillsCommand(ctx, "install", ["acme/skills"])).toBe(0);
    expect(output()).toContain("skills/alpha");
    expect(output()).toContain("skills/beta");
    expect(api.applySkillInstall).not.toHaveBeenCalled();
  });

  it("passes --subdir and --overwrite through to the service", async () => {
    const flagged = contextWith({ yes: true, subdir: "skills/beta", overwrite: true });
    await skillsCommand(flagged, "install", ["acme/skills"]);
    expect(api.previewSkillInstall).toHaveBeenCalledWith("acme/skills", { subdir: "skills/beta", overwrite: true });
  });

  /**
   * "./thing" means "next to me". The service has its own working directory,
   * so a relative path sent as typed would resolve somewhere else entirely.
   */
  it("resolves a relative local path against the caller's directory, not the service's", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "morrow-install-cwd-"));
    vi.spyOn(process, "cwd").mockReturnValue(workdir);
    const yes = contextWith({ yes: true });

    await skillsCommand(yes, "install", ["./my-skill"]);

    expect(api.previewSkillInstall).toHaveBeenCalledWith(join(workdir, "my-skill"), expect.anything());
    rmSync(workdir, { recursive: true, force: true });
  });

  it("explains itself when no source is given", async () => {
    await expect(skillsCommand(ctx, "install", [])).rejects.toThrow(/Usage: morrow skills install/);
  });

  it("removes an installed skill by id", async () => {
    expect(await skillsCommand(ctx, "remove", ["release-notes"])).toBe(0);
    expect(api.removeSkill).toHaveBeenCalledWith("release-notes");
    await expect(skillsCommand(ctx, "remove", [])).rejects.toThrow(/Usage: morrow skills remove/);
  });
});
