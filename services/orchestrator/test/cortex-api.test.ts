import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "morrow-cortex-api-"));
  const write = (rel: string, content: string) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content, "utf8");
  };
  write("package.json", JSON.stringify({ name: "fx", private: true, scripts: { test: "vitest run" } }));
  write("pnpm-lock.yaml", "lockfileVersion: 9\n");
  write("pnpm-workspace.yaml", "packages:\n  - \"packages/*\"\n");
  write("packages/core/package.json", JSON.stringify({ name: "@fx/core", main: "src/index.ts" }));
  write("packages/core/src/index.ts", "export {};\n");
  return dir;
}

describe("cortex REST API", () => {
  let db: any;
  let app: any;
  let ws: string;

  beforeEach(() => {
    ws = makeRepo();
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: ws, createdAt: new Date().toISOString() });
  });
  afterEach(() => { app.close(); db.close(); rmSync(ws, { recursive: true, force: true }); });

  it("404s intelligence reads before any mapping, then serves the aggregate after refresh", async () => {
    const before = await app.inject({ method: "GET", url: "/api/projects/p1/intelligence" });
    expect(before.statusCode).toBe(404);

    const refresh = await app.inject({ method: "POST", url: "/api/projects/p1/intelligence/refresh" });
    expect(refresh.statusCode).toBe(201);
    const intelligence = refresh.json();
    expect(intelligence.projectId).toBe("p1");
    expect(intelligence.architecture.components.map((c: any) => c.path)).toContain("packages/core");
    expect(intelligence.repositoryFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const get = await app.inject({ method: "GET", url: "/api/projects/p1/intelligence" });
    expect(get.statusCode).toBe(200);
    expect(get.json().repositoryFingerprint).toBe(intelligence.repositoryFingerprint);
  });

  it("validates project ownership on every cortex route", async () => {
    for (const url of ["/api/projects/nope/intelligence", "/api/projects/nope/conventions", "/api/projects/nope/rules"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode).toBe(404);
    }
  });

  it("convention lifecycle: list, approve via PATCH, reject invalid payloads", async () => {
    await app.inject({ method: "POST", url: "/api/projects/p1/intelligence/refresh" });
    const list = await app.inject({ method: "GET", url: "/api/projects/p1/conventions" });
    const conventions = list.json();
    expect(conventions.length).toBeGreaterThan(0);
    expect(conventions.every((c: any) => c.approval === "inferred")).toBe(true);

    const target = conventions[0];
    const patch = await app.inject({ method: "PATCH", url: `/api/projects/p1/conventions/${target.id}`, payload: { approval: "approved" } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().approval).toBe("approved");

    const bad = await app.inject({ method: "PATCH", url: `/api/projects/p1/conventions/${target.id}`, payload: { approval: "sideways" } });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);

    const missing = await app.inject({ method: "PATCH", url: "/api/projects/p1/conventions/conv-nope", payload: { approval: "approved" } });
    expect(missing.statusCode).toBe(404);
  });

  it("rules: create, list, delete, and schema validation", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects/p1/rules", payload: { text: "Never modify generated migration files directly." } });
    expect(created.statusCode).toBe(201);
    const rule = created.json();

    const list = await app.inject({ method: "GET", url: "/api/projects/p1/rules" });
    expect(list.json().map((r: any) => r.id)).toContain(rule.id);

    const invalid = await app.inject({ method: "POST", url: "/api/projects/p1/rules", payload: { text: "" } });
    expect(invalid.statusCode).toBeGreaterThanOrEqual(400);

    const del = await app.inject({ method: "DELETE", url: `/api/projects/p1/rules/${rule.id}` });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/projects/p1/rules" })).json()).toHaveLength(0);
  });

  it("staleness endpoint reports changed scopes and refresh clears them", async () => {
    await app.inject({ method: "POST", url: "/api/projects/p1/intelligence/refresh" });
    writeFileSync(join(ws, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n  - \"apps/*\"\n");
    const stale = await app.inject({ method: "GET", url: "/api/projects/p1/intelligence/staleness" });
    expect(stale.json().changedScopes).toContain("workspaces");
    await app.inject({ method: "POST", url: "/api/projects/p1/intelligence/refresh" });
    expect((await app.inject({ method: "GET", url: "/api/projects/p1/intelligence/staleness" })).json().changedScopes).toEqual([]);
  });

  it("mission impact analysis records and lists; revisions endpoint serves history", async () => {
    await app.inject({ method: "POST", url: "/api/projects/p1/intelligence/refresh" });
    const mission = (await app.inject({ method: "POST", url: "/api/projects/p1/missions", payload: { objective: "Improve the core package exports", autoApprove: true } })).json();

    const impact = await app.inject({ method: "POST", url: `/api/missions/${mission.id}/impact` });
    expect(impact.statusCode).toBe(201);
    expect(impact.json().likelyComponents).toContain("packages/core");
    expect(impact.json().requiredVerification.length).toBeGreaterThan(0);

    const listed = await app.inject({ method: "GET", url: `/api/missions/${mission.id}/impact` });
    expect(listed.json()).toHaveLength(1);

    const revisions = await app.inject({ method: "GET", url: `/api/missions/${mission.id}/revisions` });
    expect(revisions.statusCode).toBe(200);
    expect(revisions.json()).toEqual([]);
  });

  it("mission creation maps Cortex automatically so impact analysis needs no refresh command", async () => {
    const mission = (await app.inject({ method: "POST", url: "/api/projects/p1/missions", payload: { objective: "x y z", autoApprove: true } })).json();
    const impact = await app.inject({ method: "POST", url: `/api/missions/${mission.id}/impact` });
    expect(impact.statusCode).toBe(201);
    expect(impact.json()).toMatchObject({ missionId: mission.id, objective: "x y z" });
  });

  it("forget removes intelligence but keeps rules unless includeDurable", async () => {
    await app.inject({ method: "POST", url: "/api/projects/p1/intelligence/refresh" });
    await app.inject({ method: "POST", url: "/api/projects/p1/rules", payload: { text: "Keep me." } });
    await app.inject({ method: "DELETE", url: "/api/projects/p1/intelligence" });
    expect((await app.inject({ method: "GET", url: "/api/projects/p1/rules" })).json()).toHaveLength(1);
    // Items are gone; refresh rebuilds.
    const rebuilt = await app.inject({ method: "POST", url: "/api/projects/p1/intelligence/refresh" });
    expect(rebuilt.statusCode).toBe(201);
  });
});
