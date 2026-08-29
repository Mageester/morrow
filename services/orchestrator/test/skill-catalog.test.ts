import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { skillActivationsRepository } from "../src/repositories/skill-activations.js";
import { learnedSkillsRepository } from "../src/repositories/learned-skills.js";
import { projectRepository } from "../src/repositories/projects.js";
import { createSkillCatalog } from "../src/skills/catalog.js";

const NOW = "2026-08-28T00:00:00.000Z";
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(prefix = "morrow-skill-catalog-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function writeSkill(root: string, directoryName: string, options: {
  id?: string;
  name?: string;
  description?: string;
  publisher?: string;
  riskClass?: string;
  frontmatterOnly?: boolean;
  missingSkillMd?: boolean;
  malformedEntrypoint?: boolean;
  tamperChecksum?: boolean;
  missingChecksum?: boolean;
} = {}): string {
  const directory = join(root, directoryName);
  mkdirSync(directory, { recursive: true });
  const id = options.id ?? directoryName;
  const name = options.name ?? id;
  const description = options.description ?? `Description for ${id}.`;
  const markdown = options.frontmatterOnly
    ? `---\nname: ${name}\ndescription: ${description}\nriskClass: ${options.riskClass ?? "low"}\npublisher: ${options.publisher ?? "local"}\n---\n\n# ${name}\n\n${description}\n`
    : `# ${name}\n\n${description}\n`;
  if (!options.missingSkillMd) writeFileSync(join(directory, "SKILL.md"), markdown);
  if (!options.frontmatterOnly) {
    writeFileSync(join(directory, "permissions.json"), JSON.stringify({
      tools: ["filesystem-read"],
      filesystemScopes: ["workspace"],
      networkDomains: [],
      requiredSecrets: [],
    }));
    const checksum = createHash("sha256").update(markdown).digest("hex");
    const manifest = {
      id,
      name,
      description,
      publisher: options.publisher ?? "local",
      riskClass: options.riskClass ?? "low",
      requestedTools: ["filesystem-read"],
      requestedFilesystemScopes: ["workspace"],
      requestedNetworkDomains: [],
      requiredSecrets: [],
      ...(options.malformedEntrypoint ? { entrypoint: { nested: true } } : {}),
      ...(options.missingChecksum ? {} : { checksum: options.tamperChecksum ? "0".repeat(64) : checksum }),
    };
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  }
  return directory;
}

function db() {
  return openDatabase(":memory:");
}

describe("skill activation repository", () => {
  it("persists source-qualified activations and rejects a workspace record without a project", () => {
    const database = db();
    const activations = skillActivationsRepository(database);
    activations.set({ skillKey: "workspace:p1:lint", skillId: "lint", source: "workspace", projectId: "p1", enabled: true, updatedAt: NOW });
    expect(activations.get("workspace:p1:lint")?.enabled).toBe(true);
    expect(activations.list()).toEqual([expect.objectContaining({
      skillKey: "workspace:p1:lint",
      skillId: "lint",
      source: "workspace",
      projectId: "p1",
      enabled: true,
      updatedAt: NOW,
    })]);
    expect(() => activations.set({ skillKey: "workspace:p1:lint", skillId: "lint", source: "workspace", projectId: null, enabled: true, updatedAt: NOW })).toThrow();
    expect(activations.remove("workspace:p1:lint")).toBe(true);
    expect(activations.remove("workspace:p1:lint")).toBe(false);
    database.close();
  });
});

describe("skill catalog", () => {
  it("projects healthy bundled and user skills with explicit source defaults and no directories", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    const userRoot = join(root, "user");
    mkdirSync(bundledRoot);
    mkdirSync(userRoot);
    writeSkill(bundledRoot, "calendar", { name: "Calendar", description: "Manage calendar work.", publisher: "Morrow" });
    writeSkill(userRoot, "notes", { name: "Notes", description: "Manage notes work." });
    const database = db();
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot, now: () => NOW });

    expect(catalog.list()).toEqual([
      expect.objectContaining({ key: "bundled:calendar", id: "calendar", source: "bundled", enabled: true, validation: "healthy", loadable: true }),
      expect.objectContaining({ key: "user:notes", id: "notes", source: "user", enabled: false, validation: "healthy", loadable: false }),
    ]);
    expect(catalog.list().every((entry) => !Object.prototype.hasOwnProperty.call(entry, "directory"))).toBe(true);
    expect(catalog.status()).toMatchObject({ healthy: true, entries: 2, loadable: 1, issues: [] });
    database.close();
  });

  it("keeps high-risk bundled skills healthy but disabled by default", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    mkdirSync(bundledRoot);
    writeSkill(bundledRoot, "high-risk", { riskClass: "high" });
    const database = db();
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot: null, now: () => NOW });

    expect(catalog.getByKey("bundled:high-risk")).toMatchObject({
      validation: "healthy",
      trustTier: "experimental",
      enabled: false,
      loadable: false,
    });
    database.close();
  });

  it("accepts frontmatter-only skills from the bundled root but keeps writable roots fail-closed", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    const userRoot = join(root, "user");
    mkdirSync(bundledRoot);
    mkdirSync(userRoot);
    writeSkill(bundledRoot, "plain", { frontmatterOnly: true, name: "Plain", publisher: "Axiom" });
    writeSkill(userRoot, "untrusted-plain", { frontmatterOnly: true, name: "Untrusted Plain", publisher: "Axiom" });
    const database = db();
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot, now: () => NOW });

    expect(catalog.getByKey("bundled:plain")).toMatchObject({ validation: "healthy", loadable: true, manifestDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(catalog.getByKey("user:untrusted-plain")).toMatchObject({ validation: "invalid", loadable: false });
    expect(catalog.getByKey("user:untrusted-plain")?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_manifest" })]));
    database.close();
  });

  it("retains missing and checksum-invalid skills as sanitized catalog entries", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    mkdirSync(bundledRoot);
    writeSkill(bundledRoot, "missing", { missingSkillMd: true });
    writeSkill(bundledRoot, "tampered", { tamperChecksum: true });
    const database = db();
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot: null, now: () => NOW });

    expect(catalog.getByKey("bundled:missing")).toMatchObject({ validation: "missing", loadable: false });
    expect(catalog.getByKey("bundled:missing")?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_skill_md" })]));
    expect(catalog.getByKey("bundled:tampered")).toMatchObject({ validation: "invalid", loadable: false });
    expect(catalog.getByKey("bundled:tampered")?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "checksum_mismatch" })]));
    expect(JSON.stringify(catalog.status())).not.toContain(root);
    database.close();
  });

  it("maps a manifest with no checksum to invalid_manifest rather than checksum_mismatch", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    mkdirSync(bundledRoot);
    writeSkill(bundledRoot, "missing-checksum", { missingChecksum: true });
    const database = db();
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot: null, now: () => NOW });

    const entry = catalog.getByKey("bundled:missing-checksum");
    expect(entry).toMatchObject({ validation: "invalid", loadable: false });
    expect(entry?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_manifest" })]));
    expect(entry?.issues.some((current) => current.code === "checksum_mismatch")).toBe(false);
    database.close();
  });

  it("catches verifier exceptions from malformed manifest fields as stable invalid issues", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    mkdirSync(bundledRoot);
    writeSkill(bundledRoot, "malformed", { malformedEntrypoint: true });
    const database = db();
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot: null, now: () => NOW });

    const entry = catalog.getByKey("bundled:malformed");
    expect(entry).toMatchObject({ validation: "invalid", loadable: false });
    expect(entry?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_manifest" })]));
    expect(JSON.stringify(entry)).not.toContain(root);
    database.close();
  });

  it("marks every duplicate declared id conflicting with deterministic unique keys", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    mkdirSync(bundledRoot);
    writeSkill(bundledRoot, "first", { id: "same-id" });
    writeSkill(bundledRoot, "second", { id: "same-id" });
    const database = db();
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot: null, now: () => NOW });

    const entries = catalog.list().filter((entry) => entry.id === "same-id");
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(2);
    expect(entries.every((entry) => entry.validation === "conflict" && !entry.loadable)).toBe(true);
    expect(entries.every((entry) => entry.issues.some((issue) => issue.code === "id_conflict"))).toBe(true);
    database.close();
  });

  it("keeps an invalid declared manifest ID inspectable without rewriting it into a healthy ID", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    mkdirSync(bundledRoot);
    writeSkill(bundledRoot, "declared-id-folder", { id: "../declared-id" });
    const database = db();
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot: null, now: () => NOW });

    const entry = catalog.list()[0];
    if (!entry) throw new Error("catalog did not expose the invalid declared ID");
    expect(entry).toMatchObject({ id: "../declared-id", key: "bundled:../declared-id", validation: "invalid", loadable: false });
    expect(entry.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_manifest" })]));
    database.close();
  });

  it("canonicalizes workspace scope, requires a project id, and keeps activations project-scoped", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    const userRoot = join(root, "user");
    const workspace = join(root, "workspace");
    mkdirSync(bundledRoot);
    mkdirSync(userRoot);
    mkdirSync(join(workspace, "skills"), { recursive: true });
    writeSkill(join(workspace, "skills"), "lint");
    const database = db();
    projectRepository(database).createProject({ id: "p1", name: "P1", workspacePath: workspace, createdAt: NOW });
    projectRepository(database).createProject({ id: "p2", name: "P2", workspacePath: workspace, createdAt: NOW });
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot, now: () => NOW });

    expect(() => catalog.list({ workspacePath: workspace })).toThrow();
    expect(() => catalog.list({ projectId: "p1", workspacePath: root })).toThrow();
    const scope = { projectId: "p1", workspacePath: join(workspace, ".") };
    expect(catalog.getByKey("workspace:p1:lint", scope)).toMatchObject({ enabled: false, loadable: false });
    catalog.setEnabled("workspace:p1:lint", true, scope);
    expect(catalog.getByKey("workspace:p1:lint", { projectId: "p1", workspacePath: workspace })).toMatchObject({ enabled: true, loadable: true });
    expect(catalog.getByKey("workspace:p2:lint", { projectId: "p2", workspacePath: workspace })).toMatchObject({ enabled: false, loadable: false });
    database.close();
  });

  it("keeps active learned records visible when their Cortex roots are missing or unreadable", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    const userRoot = join(root, "skills");
    const privateRoot = join(root, "projects", "p1", "skills");
    const missingDirectory = join(privateRoot, "missing-cortex");
    const blockedParent = join(privateRoot, "blocked");
    const blockedDirectory = join(blockedParent, "unreadable-cortex");
    mkdirSync(bundledRoot);
    mkdirSync(userRoot);
    mkdirSync(privateRoot, { recursive: true });
    writeFileSync(blockedParent, "not a directory");
    const database = db();
    projectRepository(database).createProject({ id: "p1", name: "P1", workspacePath: root, createdAt: NOW });
    const learned = learnedSkillsRepository(database);
    for (const [id, directory] of [["missing-cortex", missingDirectory], ["unreadable-cortex", blockedDirectory]] as const) {
      learned.create({
        id,
        projectId: "p1",
        version: "1.0.0",
        triggerConditions: ["run validation"],
        scope: "repository",
        steps: ["Run validation."],
        permissions: { tools: ["command-exec"], filesystemScopes: ["workspace"], networkDomains: [], requiredSecrets: [] },
        validationRequirements: ["two_distinct_successful_missions", "safe_routine_command", "checksum", "permission_policy"],
        provenance: [
          { missionId: "m1", learningId: "l1", evidenceReferences: [{ kind: "command", reference: "pnpm test" }], observedAt: NOW },
          { missionId: "m2", learningId: "l2", evidenceReferences: [{ kind: "command", reference: "pnpm test" }], observedAt: NOW },
        ],
        state: "active",
        successCount: 2,
        failureCount: 0,
        confidence: 0.9,
        lastVerifiedAt: NOW,
        rollbackHistory: [],
        workflowFingerprint: id.padEnd(64, "f"),
        directory,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot, now: () => NOW });

    for (const id of ["missing-cortex", "unreadable-cortex"]) {
      const entry = catalog.getByKey(`workspace:p1:${id}`, { projectId: "p1" });
      expect(entry).toMatchObject({ id, source: "workspace", enabled: false, loadable: false });
      expect(entry?.validation).not.toBe("healthy");
      expect(entry?.issues.length).toBeGreaterThan(0);
      expect(JSON.stringify(entry)).not.toContain(root);
    }
    expect(catalog.status({ projectId: "p1" }).healthy).toBe(false);
    database.close();
  });

  it("orders mixed sources and case-sensitive IDs by explicit bytewise identity", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    const userRoot = join(root, "user");
    const workspace = join(root, "workspace");
    mkdirSync(bundledRoot);
    mkdirSync(userRoot);
    mkdirSync(join(workspace, "skills"), { recursive: true });
    writeSkill(bundledRoot, "zeta", { id: "a" });
    writeSkill(bundledRoot, "alpha", { id: "A" });
    writeSkill(bundledRoot, "same-bundled", { id: "same" });
    writeSkill(userRoot, "same-user", { id: "same" });
    writeSkill(join(workspace, "skills"), "same-workspace", { id: "same" });
    const database = db();
    projectRepository(database).createProject({ id: "p1", name: "P1", workspacePath: workspace, createdAt: NOW });
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot, now: () => NOW });

    const entries = catalog.list({ projectId: "p1", workspacePath: workspace });
    expect(entries.slice(0, 2).map((entry) => entry.id)).toEqual(["A", "a"]);
    expect(entries.slice(2).map((entry) => entry.source)).toEqual(["bundled", "user", "workspace"]);
    expect(entries.slice(2).every((entry) => entry.id === "same" && entry.validation === "conflict" && !entry.loadable)).toBe(true);
    database.close();
  });

  it("marks every duplicate ID conflicting regardless of directory creation order", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    mkdirSync(bundledRoot);
    writeSkill(bundledRoot, "z-last-created", { id: "same-order" });
    writeSkill(bundledRoot, "a-first-created", { id: "same-order" });
    const database = db();
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot: null, now: () => NOW });

    const entries = catalog.list().filter((entry) => entry.id === "same-order");
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.validation === "conflict" && !entry.loadable)).toBe(true);
    expect(entries.every((entry) => entry.issues.some((current) => current.code === "id_conflict"))).toBe(true);
    database.close();
  });

  it("preserves project-private active Cortex skills discovered from learned records", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    const userRoot = join(root, "skills");
    const privateRoot = join(root, "projects", "p1", "skills");
    const learnedDirectory = join(privateRoot, "validate-lint");
    mkdirSync(bundledRoot);
    mkdirSync(userRoot);
    mkdirSync(learnedDirectory, { recursive: true });
    const markdown = "# Validate lint\n\nRun the repository validation workflow.\n";
    writeFileSync(join(learnedDirectory, "SKILL.md"), markdown);
    const permissions = { tools: ["command-exec"], filesystemScopes: ["workspace"], networkDomains: [], requiredSecrets: [] };
    writeFileSync(join(learnedDirectory, "permissions.json"), JSON.stringify(permissions));
    writeFileSync(join(learnedDirectory, "manifest.json"), JSON.stringify({
      id: "validate-lint", name: "Validate lint", version: "1.0.0", description: "Run the repository validation workflow.",
      publisher: "morrow-cortex", license: "UNLICENSED", checksum: createHash("sha256").update(markdown).digest("hex"),
      entrypoint: "src/index.ts", requestedTools: permissions.tools, requestedFilesystemScopes: permissions.filesystemScopes,
      requestedNetworkDomains: [], requiredSecrets: [], riskClass: "low",
    }));
    mkdirSync(join(learnedDirectory, "src"));
    writeFileSync(join(learnedDirectory, "src", "index.ts"), "export {};\n");
    writeFileSync(join(learnedDirectory, "lifecycle.json"), JSON.stringify({
      id: "validate-lint", projectId: "p1", version: "1.0.0", triggerConditions: ["pnpm lint"], scope: "repository",
      steps: ["Run pnpm lint."], permissions, validationRequirements: ["two_distinct_successful_missions", "safe_routine_command", "checksum", "permission_policy"],
      provenance: [
        { missionId: "m1", learningId: "l1", evidenceReferences: [{ kind: "command", reference: "pnpm lint" }], observedAt: NOW },
        { missionId: "m2", learningId: "l2", evidenceReferences: [{ kind: "command", reference: "pnpm lint" }], observedAt: NOW },
      ],
      state: "active", successCount: 2, failureCount: 0, confidence: 0.9, lastVerifiedAt: NOW, rollbackHistory: [],
      workflowFingerprint: "f".repeat(64), directory: learnedDirectory, createdAt: NOW, updatedAt: NOW,
    }));
    const database = db();
    database.prepare("INSERT INTO projects(id,schema_version,name,workspace_path,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("p1", 1, "Project 1", root, NOW, NOW);
    learnedSkillsRepository(database).create({
      id: "validate-lint", projectId: "p1", version: "1.0.0", triggerConditions: ["pnpm lint"], scope: "repository",
      steps: ["Run pnpm lint."], permissions, validationRequirements: ["two_distinct_successful_missions", "safe_routine_command", "checksum", "permission_policy"],
      provenance: [
        { missionId: "m1", learningId: "l1", evidenceReferences: [{ kind: "command", reference: "pnpm lint" }], observedAt: NOW },
        { missionId: "m2", learningId: "l2", evidenceReferences: [{ kind: "command", reference: "pnpm lint" }], observedAt: NOW },
      ],
      state: "active", successCount: 2, failureCount: 0, confidence: 0.9, lastVerifiedAt: NOW, rollbackHistory: [],
      workflowFingerprint: "f".repeat(64), directory: learnedDirectory, createdAt: NOW, updatedAt: NOW,
    });
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot, now: () => NOW });

    expect(catalog.getByKey("workspace:p1:validate-lint", { projectId: "p1" })).toMatchObject({ source: "workspace", validation: "healthy" });
    database.close();
  });

  it("keeps healthy entries visible when another configured root is unavailable", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    const unavailableUserRoot = join(root, "user-file");
    mkdirSync(bundledRoot);
    writeSkill(bundledRoot, "healthy");
    writeFileSync(unavailableUserRoot, "not a directory");
    const database = db();
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot: unavailableUserRoot, now: () => NOW });

    expect(catalog.getByKey("bundled:healthy")).toMatchObject({ validation: "healthy", loadable: true });
    expect(catalog.status()).toMatchObject({ healthy: false, entries: 1, loadable: 1 });
    expect(catalog.status().issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "root_unavailable" })]));
    expect(JSON.stringify(catalog.status())).not.toContain(root);
    expect(existsSync(unavailableUserRoot)).toBe(true);
    database.close();
  });

  /**
   * A fresh install has never had a user skill installed, so that directory
   * does not exist yet. That is the normal state, not a fault — reporting it
   * as one would make every new user's catalog read as broken.
   */
  it("does not call a never-used user root a fault", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    mkdirSync(bundledRoot);
    writeSkill(bundledRoot, "healthy");
    const database = db();
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot: join(root, "never-created"), now: () => NOW });

    expect(catalog.status()).toMatchObject({ healthy: true, entries: 1, loadable: 1, issues: [] });
    database.close();
  });

  /**
   * `existsSync` is false both for a missing path and for one whose parent
   * denies traversal. The first is a fresh install; the second is a broken
   * permission that must not hide behind an ordinary empty cabinet.
   */
  it("tells an unreadable user root apart from one that was never used", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    mkdirSync(bundledRoot);
    writeSkill(bundledRoot, "healthy");
    const locked = join(root, "locked");
    mkdirSync(locked);
    const userRoot = join(locked, "skills");
    mkdirSync(userRoot);
    chmodSync(locked, 0o000);
    const database = db();
    try {
      const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot, now: () => NOW });
      const status = catalog.status();
      expect(status.healthy).toBe(false);
      expect(status.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unreadable" })]));
      // The other root's healthy entry stays visible.
      expect(catalog.getByKey("bundled:healthy")).toMatchObject({ loadable: true });
    } finally {
      chmodSync(locked, 0o700);
      database.close();
    }
  });

  /** A bundled root that vanished means shipped skills are gone. */
  it("still reports a missing bundled root", () => {
    const root = tempDirectory();
    const database = db();
    const catalog = createSkillCatalog({ db: database, bundledRoot: join(root, "gone"), userRoot: null, now: () => NOW });

    expect(catalog.status().healthy).toBe(false);
    expect(catalog.status().issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "root_unavailable" })]));
    database.close();
  });

  it("persists bundled disablement and user enablement across a database reopen", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    const userRoot = join(root, "user");
    const databaseFile = join(root, "morrow.db");
    mkdirSync(bundledRoot);
    mkdirSync(userRoot);
    writeSkill(bundledRoot, "calendar");
    writeSkill(userRoot, "notes");
    const first = openDatabase(databaseFile);
    const firstCatalog = createSkillCatalog({ db: first, bundledRoot, userRoot, now: () => NOW });
    firstCatalog.setEnabled("bundled:calendar", false);
    firstCatalog.setEnabled("user:notes", true);
    first.close();

    const reopened = openDatabase(databaseFile);
    const secondCatalog = createSkillCatalog({ db: reopened, bundledRoot, userRoot, now: () => NOW });
    expect(secondCatalog.getByKey("bundled:calendar")).toMatchObject({ enabled: false, loadable: false });
    expect(secondCatalog.getByKey("user:notes")).toMatchObject({ enabled: true, loadable: true });
    reopened.close();
  });

  it("persists an explicit activation for a high-risk bundled skill", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    const databaseFile = join(root, "morrow.db");
    mkdirSync(bundledRoot);
    writeSkill(bundledRoot, "high-risk", { riskClass: "high" });
    const first = openDatabase(databaseFile);
    const firstCatalog = createSkillCatalog({ db: first, bundledRoot, userRoot: null, now: () => NOW });

    firstCatalog.setEnabled("bundled:high-risk", true);
    expect(firstCatalog.getByKey("bundled:high-risk")).toMatchObject({ enabled: true, loadable: true });
    first.close();

    const reopened = openDatabase(databaseFile);
    const secondCatalog = createSkillCatalog({ db: reopened, bundledRoot, userRoot: null, now: () => NOW });
    expect(secondCatalog.getByKey("bundled:high-risk")).toMatchObject({ enabled: true, loadable: true });
    reopened.close();
  });

  it("refuses to load disabled or invalid instructions and loads the exact healthy bytes", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    mkdirSync(bundledRoot);
    const directory = writeSkill(bundledRoot, "calendar");
    const database = db();
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot: null, now: () => NOW });

    expect(catalog.loadInstructions("bundled:calendar").instructions).toBe("# calendar\n\nDescription for calendar.\n");
    catalog.setEnabled("bundled:calendar", false);
    expect(() => catalog.loadInstructions("bundled:calendar")).toThrow();
    writeFileSync(join(directory, "SKILL.md"), "# altered\n");
    expect(() => catalog.loadInstructions("bundled:calendar")).toThrow();
    database.close();
  });

  it("refuses an enabled skill when its instruction digest changes", () => {
    const root = tempDirectory();
    const bundledRoot = join(root, "bundled");
    mkdirSync(bundledRoot);
    const directory = writeSkill(bundledRoot, "digest-check");
    const database = db();
    const catalog = createSkillCatalog({ db: database, bundledRoot, userRoot: null, now: () => NOW });

    expect(catalog.getByKey("bundled:digest-check")).toMatchObject({ enabled: true, loadable: true });
    writeFileSync(join(directory, "SKILL.md"), "# changed while enabled\n");
    expect(() => catalog.loadInstructions("bundled:digest-check")).toThrow();
    database.close();
  });
});
