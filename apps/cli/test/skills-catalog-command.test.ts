import type { SkillCatalogEntry } from "@morrow/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "../src/cli/context.js";
import { Output } from "../src/cli/output.js";
import { ConfigStore } from "../src/config/config.js";
import { skillsCommand } from "../src/commands/skills.js";

/**
 * `morrow skills` reports the running service's catalog, which is the same
 * authority the agent loads from. The point of these tests is that nothing on
 * this side can invent a different answer: not a leftover config key, not a
 * filesystem scan, not an ambiguous name resolved by guessing.
 */
describe("morrow skills against the runtime catalog", () => {
  const entry = (over: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry => ({
    key: "bundled:writing", id: "writing", name: "Writing", description: "Draft prose.",
    source: "bundled", enabled: true, validation: "healthy", issues: [], loadable: true,
    manifestDigest: "a".repeat(64), category: "writing", trustTier: "core",
    tools: [], permissions: [], dependencies: [], publisher: "morrow", ...over,
  });

  let home: string;
  let printed: string[];
  let config: ConfigStore;
  let api: {
    listSkills: ReturnType<typeof vi.fn>;
    getSkillStatus: ReturnType<typeof vi.fn>;
    setSkillEnabled: ReturnType<typeof vi.fn>;
    removeSkill: ReturnType<typeof vi.fn>;
  };

  function contextWith(flags: Record<string, unknown> = {}): Context {
    const context = new Context({
      out: new Output({ json: Boolean(flags.json), quiet: false, color: false }),
      config,
      paths: config.paths,
      flags: flags as never,
    });
    context.api = () => api as never;
    return context;
  }

  beforeEach(() => {
    printed = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { printed.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { printed.push(String(chunk)); return true; });
    home = mkdtempSync(join(tmpdir(), "morrow-skills-catalog-"));
    config = ConfigStore.load({ MORROW_HOME: home }, home);
    api = {
      listSkills: vi.fn(async () => [entry()]),
      getSkillStatus: vi.fn(async () => ({ healthy: true, entries: 1, loadable: 1, issues: [] })),
      setSkillEnabled: vi.fn(async (key: string, enabled: boolean, _projectId?: string) => entry({ key, enabled, loadable: enabled })),
      removeSkill: vi.fn(async () => undefined),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  const output = (): string => printed.join("");

  /**
   * A stale local key is exactly the disagreement this path removes: the CLI
   * used to say "enabled" for a skill the agent would never load.
   */
  it("shows the service's state even when local config says otherwise", async () => {
    config.set("skills.writing.enabled", "true", "user");
    api.listSkills.mockResolvedValue([entry({ enabled: false, loadable: false })]);

    expect(await skillsCommand(contextWith(), "list", [])).toBe(0);

    expect(output()).toContain("disabled");
    expect(output()).not.toMatch(/\benabled\b/);
  });

  it("reports validation state rather than presenting a broken skill as usable", async () => {
    api.listSkills.mockResolvedValue([
      entry({ key: "user:broken", id: "broken", enabled: false, loadable: false, validation: "invalid", issues: [{ code: "invalid_manifest", message: "manifest.json could not be parsed" }] }),
    ]);

    expect(await skillsCommand(contextWith(), "list", [])).toBe(0);
    expect(output()).toContain("invalid");
    expect(output()).toContain("false");
  });

  it("enables through the service and never writes an activation key locally", async () => {
    const ctx = contextWith();
    api.listSkills.mockResolvedValue([entry({ enabled: false, loadable: false })]);

    expect(await skillsCommand(ctx, "enable", ["writing"])).toBe(0);

    expect(api.setSkillEnabled).toHaveBeenCalledWith("bundled:writing", true, undefined);
    expect(config.get("skills.writing.enabled")).toBeUndefined();
    expect(output()).toContain("bundled:writing enabled");
  });

  it("disables through the service", async () => {
    expect(await skillsCommand(contextWith(), "disable", ["bundled:writing"])).toBe(0);
    expect(api.setSkillEnabled).toHaveBeenCalledWith("bundled:writing", false, undefined);
  });

  /** Two skills can declare one id. Picking one silently is the wrong answer. */
  it("refuses an ambiguous id instead of guessing a source", async () => {
    api.listSkills.mockResolvedValue([entry(), entry({ key: "user:writing", source: "user" })]);

    await expect(skillsCommand(contextWith(), "enable", ["writing"])).rejects.toThrow(/matches 2 skills/);
    expect(api.setSkillEnabled).not.toHaveBeenCalled();
  });

  it("resolves an exact catalog key past an ambiguous id", async () => {
    api.listSkills.mockResolvedValue([entry(), entry({ key: "user:writing", source: "user" })]);

    expect(await skillsCommand(contextWith(), "enable", ["user:writing"])).toBe(0);
    expect(api.setSkillEnabled).toHaveBeenCalledWith("user:writing", true, undefined);
  });

  it("names a skill the service does not have", async () => {
    api.listSkills.mockResolvedValue([]);
    await expect(skillsCommand(contextWith(), "inspect", ["ghost"])).rejects.toThrow(/No skill named "ghost"/);
  });

  /**
   * An empty catalog because a root could not be read is a failure. Reporting
   * it as "no skills" would hide a broken install behind a tidy message.
   */
  it("separates an unreadable root from an empty catalog", async () => {
    api.listSkills.mockResolvedValue([]);
    api.getSkillStatus.mockResolvedValue({ healthy: false, entries: 0, loadable: 0, issues: [{ code: "root_unavailable", message: "The user skill root could not be read" }] });

    expect(await skillsCommand(contextWith(), "list", [])).not.toBe(0);
    expect(output()).toContain("The user skill root could not be read");

    printed = [];
    api.getSkillStatus.mockResolvedValue({ healthy: true, entries: 0, loadable: 0, issues: [] });
    expect(await skillsCommand(contextWith(), "list", [])).toBe(0);
    expect(output()).toContain("No skills found.");
  });

  it("verifies against the catalog's own verdict", async () => {
    api.listSkills.mockResolvedValue([entry({ validation: "conflict", loadable: false, enabled: false, issues: [{ code: "id_conflict", message: 'Two skills declare the id "writing"' }] })]);

    expect(await skillsCommand(contextWith(), "verify", ["writing"])).not.toBe(0);
    expect(output()).toContain('Two skills declare the id "writing"');
  });

  /**
   * A workspace skill only exists inside a project scope. Reading the catalog
   * unscoped here while the interactive session reads it scoped meant one CLI
   * surface could offer a skill another could not even find.
   */
  it("reads the catalog in the active project's scope", async () => {
    const project = { id: "project-1", name: "Repo", workspacePath: process.cwd(), createdAt: "2026-08-28T00:00:00.000Z", version: 1 };
    (api as Record<string, unknown>).listProjects = vi.fn(async () => [project]);
    (api as Record<string, unknown>).getProject = vi.fn(async () => project);
    const ctx = contextWith({ project: "project-1" });

    expect(await skillsCommand(ctx, "list", [])).toBe(0);
    expect(api.listSkills).toHaveBeenCalledWith("project-1");
  });

  it("emits the catalog entry verbatim in JSON mode", async () => {
    expect(await skillsCommand(contextWith({ json: true }), "list", [])).toBe(0);
    expect(JSON.parse(output())).toEqual([entry()]);
  });
});
