import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { intelligenceRepository } from "../src/repositories/intelligence.js";
import { CortexService, CortexError } from "../src/cortex/service.js";
import { generateArchitectureMap } from "../src/cortex/mapper.js";
import { computeScopeFingerprints, computeRepositoryFingerprint, diffScopes } from "../src/cortex/fingerprint.js";
import { ProjectIntelligenceSchema, MAX_PLAN_REVISIONS } from "@morrow/contracts";

/** Build a small realistic monorepo fixture on disk. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "morrow-cortex-"));
  const write = (rel: string, content: string) => {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  };
  write("package.json", JSON.stringify({
    name: "fixture-root", private: true,
    scripts: { test: "vitest run", build: "tsc -b", check: "tsc --noEmit" },
  }));
  write("pnpm-workspace.yaml", "packages:\n  - \"apps/*\"\n  - \"packages/*\"\n");
  write("pnpm-lock.yaml", "lockfileVersion: 9\n");
  write("tsconfig.base.json", JSON.stringify({ compilerOptions: { strict: true } }));
  write("README.md", "# Fixture\n");
  write("apps/cli/package.json", JSON.stringify({
    name: "@fixture/cli", description: "Fixture CLI", bin: { fx: "./dist/main.js" },
    scripts: { test: "vitest run" }, dependencies: { "@fixture/core": "workspace:*" },
  }));
  write("apps/cli/src/main.ts", "export {};\n");
  write("packages/core/package.json", JSON.stringify({
    name: "@fixture/core", description: "Core library", main: "src/index.ts",
  }));
  write("packages/core/src/index.ts", "export const core = 1;\n");
  write("packages/core/src/internal.ts", "export const internal = 1;\n");
  write("packages/core/src/generated/schema.ts", "export const generated = true;\n");
  return dir;
}

describe("cortex fingerprinting", () => {
  let ws: string;
  beforeEach(() => { ws = makeRepo(); });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it("computes deterministic scoped fingerprints", () => {
    const a = computeScopeFingerprints(ws);
    const b = computeScopeFingerprints(ws);
    expect(a).toEqual(b);
    expect(a.find((s) => s.scope === "manifests")!.files).toContain("package.json");
    expect(a.find((s) => s.scope === "workspaces")!.files).toContain("pnpm-workspace.yaml");
  });

  it("an unrelated non-entry source change alters no scope", () => {
    const before = computeScopeFingerprints(ws);
    writeFileSync(join(ws, "packages/core/src/internal.ts"), "export const internal = 2;\n");
    expect(diffScopes(before, computeScopeFingerprints(ws))).toEqual([]);
  });

  it("an entry point source change alters only the entry_points scope", () => {
    const before = computeScopeFingerprints(ws);
    writeFileSync(join(ws, "packages/core/src/index.ts"), "export { internal } from './internal.js';\n");
    expect(diffScopes(before, computeScopeFingerprints(ws))).toEqual(["entry_points"]);
  });

  it("a manifest change alters exactly the manifests scope", () => {
    const before = computeScopeFingerprints(ws);
    writeFileSync(join(ws, "packages/core/package.json"), JSON.stringify({ name: "@fixture/core", version: "2.0.0" }));
    expect(diffScopes(before, computeScopeFingerprints(ws))).toEqual(["manifests"]);
  });

  it("the repository fingerprint changes when any scope changes", () => {
    const before = computeRepositoryFingerprint(computeScopeFingerprints(ws));
    writeFileSync(join(ws, "pnpm-lock.yaml"), "lockfileVersion: 10\n");
    expect(computeRepositoryFingerprint(computeScopeFingerprints(ws))).not.toBe(before);
  });
});

describe("cortex architecture mapper", () => {
  let ws: string;
  beforeEach(() => { ws = makeRepo(); });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it("maps components, commands, workspaces, and languages from repository evidence", () => {
    const { architecture } = generateArchitectureMap(ws);
    expect(architecture.packageManagers).toContain("pnpm");
    expect(architecture.workspaces).toEqual(expect.arrayContaining(["apps/*", "packages/*"]));
    const cli = architecture.components.find((c) => c.path === "apps/cli")!;
    expect(cli.kind).toBe("application");
    expect(cli.name).toBe("@fixture/cli");
    expect(cli.dependsOn).toContain("@fixture/core");
    const core = architecture.components.find((c) => c.path === "packages/core")!;
    expect(core.kind).toBe("library");
    expect(core.entryPoints).toContain("packages/core/src/index.ts");
    expect(architecture.languages[0]!.language).toBe("TypeScript");
    const test = architecture.commands.find((c) => c.role === "test" && c.cwd === ".")!;
    expect(test.command).toBe("pnpm run test");
    expect(test.sources[0]!.kind).toBe("file");
    expect(architecture.generatedPaths).toContain("packages/core/src/generated");
  });

  it("infers conventions with sources and marks them inferred, never approved", () => {
    const { conventions } = generateArchitectureMap(ws);
    expect(conventions.length).toBeGreaterThanOrEqual(2);
    for (const c of conventions) {
      expect(c.approval).toBe("inferred");
      expect(c.sources.length).toBeGreaterThan(0);
      expect(c.confidence).toBeGreaterThan(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
    expect(conventions.some((c) => /pnpm/.test(c.description))).toBe(true);
    expect(conventions.some((c) => /strict/.test(c.description))).toBe(true);
  });

  it("states uncertainty for an empty repository instead of inventing facts", () => {
    const empty = mkdtempSync(join(tmpdir(), "morrow-cortex-empty-"));
    try {
      const { architecture, uncertainties } = generateArchitectureMap(empty);
      expect(architecture.components).toEqual([]);
      expect(uncertainties.some((u) => u.area === "commands")).toBe(true);
      expect(uncertainties.some((u) => u.area === "languages")).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("cortex service", () => {
  let db: any;
  let ws: string;
  let service: CortexService;

  beforeEach(() => {
    ws = makeRepo();
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: ws, createdAt: new Date().toISOString() });
    service = new CortexService({
      repo: intelligenceRepository(db),
      getWorkspacePath: (pid) => (pid === "p1" ? ws : undefined),
    });
  });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  it("build produces a schema-valid canonical aggregate that persists", () => {
    const intelligence = service.build("p1");
    const parsed = ProjectIntelligenceSchema.parse(intelligence);
    expect(parsed.projectId).toBe("p1");
    expect(parsed.architecture.components.length).toBe(2);
    expect(parsed.conventions.length).toBeGreaterThan(0);
    expect(parsed.commands.length).toBeGreaterThan(0);
    // A fresh service instance over the same db reads the same aggregate.
    const again = new CortexService({ repo: intelligenceRepository(db), getWorkspacePath: () => ws }).get("p1");
    expect(again.repositoryFingerprint).toBe(intelligence.repositoryFingerprint);
    expect(again.conventions.map((c) => c.description).sort()).toEqual(intelligence.conventions.map((c) => c.description).sort());
  });

  it("get without build fails loudly instead of returning invented emptiness", () => {
    expect(() => service.get("p1")).toThrow(CortexError);
  });

  it("unrelated file changes do not invalidate anything", () => {
    service.build("p1");
    writeFileSync(join(ws, "packages/core/src/internal.ts"), "export const internal = 3;\n");
    const result = service.detectStaleness("p1");
    expect(result.changedScopes).toEqual([]);
    expect(result.itemsMarked).toBe(0);
    expect(result.architectureStale).toBe(false);
  });

  it("architecture-critical changes mark affected knowledge possibly_stale; refresh restores current", () => {
    service.build("p1");
    writeFileSync(join(ws, "pnpm-workspace.yaml"), "packages:\n  - \"apps/*\"\n  - \"packages/*\"\n  - \"services/*\"\n");
    const result = service.detectStaleness("p1");
    expect(result.changedScopes).toContain("workspaces");
    expect(result.architectureStale).toBe(true);
    expect(service.get("p1").architecture.freshness).toBe("possibly_stale");

    const refreshed = service.refresh("p1");
    expect(refreshed.architecture.freshness).toBe("current");
    expect(refreshed.architecture.workspaces).toContain("services/*");
    expect(service.detectStaleness("p1").changedScopes).toEqual([]);
  });

  it("entry point source changes mark architecture possibly_stale without invalidating unrelated source edits", () => {
    service.build("p1");
    writeFileSync(join(ws, "packages/core/src/internal.ts"), "export const internal = 3;\n");
    expect(service.detectStaleness("p1").changedScopes).toEqual([]);

    writeFileSync(join(ws, "packages/core/src/index.ts"), "export { internal } from './internal.js';\n");
    const result = service.detectStaleness("p1");
    expect(result.changedScopes).toEqual(["entry_points"]);
    expect(result.architectureStale).toBe(true);
    expect(service.get("p1").architecture.freshness).toBe("possibly_stale");
  });

  it("convention approval survives a refresh; inferred conventions stay inferred", () => {
    const built = service.build("p1");
    const target = built.conventions.find((c) => /pnpm/.test(c.description))!;
    service.approveConvention("p1", target.id);
    const refreshed = service.refresh("p1");
    const after = refreshed.conventions.find((c) => c.description === target.description)!;
    expect(after.approval).toBe("approved");
    expect(after.id).toBe(target.id);
    expect(refreshed.conventions.filter((c) => c.approval === "inferred").length).toBeGreaterThan(0);
  });

  it("rejecting a convention persists", () => {
    const built = service.build("p1");
    const target = built.conventions[0]!;
    service.rejectConvention("p1", target.id);
    expect(service.get("p1").conventions.find((c) => c.id === target.id)!.approval).toBe("rejected");
  });

  it("user rules are durable and separate from inferred knowledge", () => {
    service.build("p1");
    const rule = service.addRule("p1", { text: "Never modify generated migration files directly." });
    service.refresh("p1");
    const rules = service.get("p1").userRules;
    expect(rules.map((r) => r.id)).toContain(rule.id);
    service.removeRule("p1", rule.id);
    expect(service.get("p1").userRules).toHaveLength(0);
  });

  it("decision ledger: record, list, supersede", () => {
    service.build("p1");
    const first = service.recordDecision("p1", {
      statement: "Use one canonical Mission contract in packages/contracts.",
      context: "CLI, API, persistence risked diverging.",
      consequences: ["All mission state changes pass through shared schemas."],
      missionId: "mission-x",
    });
    expect(first.label).toBe("D-001");
    const second = service.recordDecision("p1", {
      statement: "Mission contracts move to a dedicated package.",
      supersedes: first.id,
    });
    const decisions = service.get("p1").decisions;
    const old = decisions.find((d) => d.id === first.id)!;
    expect(old.status).toBe("superseded");
    expect(old.supersededBy).toBe(second.id);
    expect(decisions.find((d) => d.id === second.id)!.status).toBe("accepted");
    // Decisions survive refresh.
    service.refresh("p1");
    expect(service.get("p1").decisions).toHaveLength(2);
  });

  it("rejects learnings without evidence", () => {
    service.build("p1");
    expect(() => service.addLearnings("p1", [{
      id: "l1", statement: "x", type: "dependency", confidence: 0.5, sources: [],
      missionId: "m1", scope: ".", stalenessCondition: null, affectsPlanning: true,
      freshness: "current", createdAt: new Date().toISOString(),
    }])).toThrow(/evidence/);
  });

  it("stores evidence-backed learnings durably across refresh", () => {
    service.build("p1");
    service.addLearnings("p1", [{
      id: "l1", statement: "pnpm run test validates the core package.", type: "validation_command",
      confidence: 0.8, sources: [{ kind: "mission", reference: "mission-1", note: "exit 0" }],
      missionId: "mission-1", scope: "packages/core", stalenessCondition: "test script changes",
      affectsPlanning: true, freshness: "current", createdAt: new Date().toISOString(),
    }]);
    service.refresh("p1");
    expect(service.get("p1").missionLearnings).toHaveLength(1);
  });

  it("plan revisions are persisted, ordered, and bounded", () => {
    db.prepare("INSERT INTO missions(id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at) VALUES('mission-1',1,'p1','o','running',1,'{}',datetime('now'),datetime('now'))").run();
    for (let i = 0; i < MAX_PLAN_REVISIONS; i++) {
      service.recordPlanRevision("mission-1", { trigger: "test_contradiction", triggerDetail: `evidence ${i}` });
    }
    const revisions = service.listPlanRevisions("mission-1");
    expect(revisions.map((r) => r.revision)).toEqual([1, 2, 3, 4, 5]);
    expect(() => service.recordPlanRevision("mission-1", { trigger: "test_contradiction" })).toThrow(/limit/);
  });
});
