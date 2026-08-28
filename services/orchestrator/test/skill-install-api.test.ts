import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { skillInstallRoot } from "../src/skills/install.js";
import { createSkillCatalog } from "../src/skills/catalog.js";

/**
 * The install endpoints are the one write path into the skill root, shared by
 * the CLI, the Skills page and the agent's own tool. What they have to
 * guarantee is the preview/apply contract: a preview changes nothing, and an
 * apply installs the previewed bundle rather than re-reading the source.
 */
describe("skill install API", () => {
  let db: any;
  let app: any;
  let home: string;
  let workspace: string;
  let previousHome: string | undefined;
  let previousSkillsRoot: string | undefined;

  const SKILL_MD = "---\nname: Release Notes\ndescription: Draft release notes from a changelog.\n---\n\n# Release Notes\n\nSteps.\n";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "morrow-install-home-"));
    workspace = mkdtempSync(join(tmpdir(), "morrow-install-src-"));
    // The endpoints resolve the skill root from the environment, the same way
    // every other surface does.
    previousHome = process.env.MORROW_HOME;
    previousSkillsRoot = process.env.MORROW_SKILLS_DIR;
    process.env.MORROW_HOME = home;
    process.env.MORROW_SKILLS_DIR = resolve(process.cwd(), "../../skills");
    db = openDatabase(join(home, "morrow.db"));
    app = buildServer({
      db,
      runner: new TaskRunner(db),
      skillCatalog: createSkillCatalog({ db, bundledRoot: process.env.MORROW_SKILLS_DIR ?? null, userRoot: skillInstallRoot(process.env) }),
    });
  });

  afterEach(() => {
    app.close();
    db.close();
    if (previousHome === undefined) delete process.env.MORROW_HOME;
    else process.env.MORROW_HOME = previousHome;
    if (previousSkillsRoot === undefined) delete process.env.MORROW_SKILLS_DIR;
    else process.env.MORROW_SKILLS_DIR = previousSkillsRoot;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  function writeSource(name: string, files: Record<string, string>): string {
    const directory = join(workspace, name);
    mkdirSync(directory, { recursive: true });
    for (const [file, contents] of Object.entries(files)) writeFileSync(join(directory, file), contents);
    return directory;
  }

  async function preview(body: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/api/skills/install/preview", payload: body });
  }

  it("previews without installing, then installs exactly what was previewed", async () => {
    const source = writeSource("release-notes", { "SKILL.md": SKILL_MD });

    const previewed = await preview({ source });
    expect(previewed.statusCode).toBe(200);
    const body = previewed.json();
    expect(body.kind).toBe("ready");
    expect(body.plan.id).toBe("release-notes");
    expect(body.plan.generatedMetadata).toContain("permissions.json");
    // Nothing has been installed yet.
    expect(existsSync(join(skillInstallRoot(process.env), "release-notes"))).toBe(false);

    // The source changing between preview and apply must not change what lands.
    writeFileSync(join(source, "SKILL.md"), "# Swapped\n\nDifferent instructions.\n");

    const installed = await app.inject({ method: "POST", url: "/api/skills/install", payload: { handle: body.handle } });
    expect(installed.statusCode).toBe(201);
    expect(installed.json()).toMatchObject({ key: "user:release-notes", id: "release-notes", enabled: false, loadable: false });
    expect(installed.json()).not.toHaveProperty("directory");
    expect(readFileSync(join(skillInstallRoot(process.env), "release-notes", "SKILL.md"), "utf8")).toBe(SKILL_MD);

    const listed = await app.inject({ method: "GET", url: "/api/skills" });
    expect(listed.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "user:release-notes", id: "release-notes", enabled: false, loadable: false }),
    ]));
    expect(listed.body).not.toContain("directory");

    const enabled = await app.inject({ method: "PATCH", url: "/api/skills/user%3Arelease-notes", payload: { enabled: true } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ key: "user:release-notes", enabled: true, loadable: true });
    expect(enabled.body).not.toContain("directory");
  });

  it("reports the skills in a source that holds several, rather than guessing", async () => {
    mkdirSync(join(workspace, "repo", "skills", "alpha"), { recursive: true });
    mkdirSync(join(workspace, "repo", "skills", "beta"), { recursive: true });
    writeFileSync(join(workspace, "repo", "skills", "alpha", "SKILL.md"), "---\nname: Alpha\ndescription: One.\n---\n\n# Alpha\n");
    writeFileSync(join(workspace, "repo", "skills", "beta", "SKILL.md"), "---\nname: Beta\ndescription: Two.\n---\n\n# Beta\n");

    const listed = await preview({ source: join(workspace, "repo") });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().kind).toBe("choices");
    expect(listed.json().candidates.map((candidate: any) => candidate.subdir).sort()).toEqual(["skills/alpha", "skills/beta"]);

    const chosen = await preview({ source: join(workspace, "repo"), subdir: "skills/beta" });
    expect(chosen.json().plan.id).toBe("beta");
  });

  it("turns a refusal into a 400 that says why", async () => {
    const tampered = writeSource("tampered", {
      "SKILL.md": "# Tampered\n\nAltered.\n",
      "manifest.json": JSON.stringify({ id: "tampered", name: "Tampered", version: "1.0.0", checksum: "0".repeat(64) }),
    });
    const refused = await preview({ source: tampered });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe("SKILL_INSTALL_REFUSED");
    expect(refused.json().error.message).toMatch(/checksum does not match/);

    const unknown = await preview({ source: "not a source" });
    expect(unknown.statusCode).toBe(400);
  });

  it("refuses an install handle it never issued", async () => {
    const forged = await app.inject({ method: "POST", url: "/api/skills/install", payload: { handle: "../../etc/passwd" } });
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error.message).toMatch(/Invalid install handle/);
  });

  it("discards a preview so abandoned staging does not accumulate", async () => {
    const source = writeSource("release-notes", { "SKILL.md": SKILL_MD });
    const handle = (await preview({ source })).json().handle;

    const discarded = await app.inject({ method: "POST", url: "/api/skills/install/discard", payload: { handle } });
    expect(discarded.statusCode).toBe(204);

    const applied = await app.inject({ method: "POST", url: "/api/skills/install", payload: { handle } });
    expect(applied.statusCode).toBe(400);
    expect(applied.json().error.message).toMatch(/expired or was already applied/);
  });

  it("removes an installed skill, but not one that ships with the product", async () => {
    const source = writeSource("release-notes", { "SKILL.md": SKILL_MD });
    const handle = (await preview({ source })).json().handle;
    await app.inject({ method: "POST", url: "/api/skills/install", payload: { handle } });

    const removed = await app.inject({ method: "DELETE", url: "/api/skills/user%3Arelease-notes" });
    expect(removed.statusCode).toBe(204);
    expect(existsSync(join(skillInstallRoot(process.env), "release-notes"))).toBe(false);

    const bundled = await app.inject({ method: "DELETE", url: "/api/skills/bundled%3Aaccessibility" });
    expect(bundled.statusCode).toBe(409);
    expect(bundled.json().error.message).toMatch(/Bundled skills cannot be removed/);
  });

  it("lists an installed skill through the existing registry once it lands", async () => {
    const source = writeSource("release-notes", { "SKILL.md": SKILL_MD });
    const handle = (await preview({ source })).json().handle;
    await app.inject({ method: "POST", url: "/api/skills/install", payload: { handle } });

    const listed = await app.inject({ method: "GET", url: "/api/skills" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().map((skill: any) => skill.id)).toContain("release-notes");
  });

  /** A `.tar.gz` on disk is the same path a download takes, minus the network. */
  it("installs from a local archive", async () => {
    const staging = join(workspace, "archive-src");
    mkdirSync(join(staging, "release-notes"), { recursive: true });
    writeFileSync(join(staging, "release-notes", "SKILL.md"), SKILL_MD);
    const archive = join(workspace, "bundle.tar.gz");
    execFileSync("tar", ["czf", archive, "-C", staging, "."]);

    const previewed = await preview({ source: archive });
    expect(previewed.statusCode).toBe(200);
    expect(previewed.json().plan.id).toBe("release-notes");

    const installed = await app.inject({ method: "POST", url: "/api/skills/install", payload: { handle: previewed.json().handle } });
    expect(installed.statusCode).toBe(201);
  });
});
