import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";

describe("symbol index API", () => {
  let db: any;
  let app: any;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "morrow-symbol-api-"));
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function createProject() {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "math.ts"), "export function add(a: number, b: number) { return a + b; }\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "api-fixture", scripts: { test: "vitest" } }));
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Symbols", workspacePath: root } });
    expect(res.statusCode).toBe(200);
    return res.json().id as string;
  }

  it("rebuilds, refreshes, searches, resolves definitions, lists file symbols, and reports status", async () => {
    const projectId = await createProject();

    const rebuild = await app.inject({ method: "POST", url: `/api/projects/${projectId}/symbols/rebuild` });
    expect(rebuild.statusCode).toBe(200);
    expect(rebuild.json()).toMatchObject({ indexedFiles: 2, deletedFiles: 0 });

    const search = await app.inject({ method: "GET", url: `/api/projects/${projectId}/symbols/search?q=add&limit=5` });
    expect(search.statusCode).toBe(200);
    expect(search.json().symbols[0]).toMatchObject({ name: "add", filePath: "src/math.ts" });

    const definition = await app.inject({ method: "GET", url: `/api/projects/${projectId}/symbols/definition?name=add` });
    expect(definition.statusCode).toBe(200);
    expect(definition.json()).toMatchObject({ name: "add", kind: "function", startLine: 1 });

    const file = await app.inject({ method: "GET", url: `/api/projects/${projectId}/symbols/file?path=${encodeURIComponent("src/math.ts")}` });
    expect(file.statusCode).toBe(200);
    expect(file.json().symbols.map((symbol: any) => symbol.name)).toContain("add");

    writeFileSync(join(root, "src", "fresh.ts"), "export const fresh = 1;\n");
    const refresh = await app.inject({ method: "POST", url: `/api/projects/${projectId}/symbols/refresh` });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().indexedFiles).toBe(1);

    const status = await app.inject({ method: "GET", url: `/api/projects/${projectId}/symbols/status` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ projectId, fileCount: 3, symbolCount: expect.any(Number) });
  });

  it("returns structured errors for missing projects and missing definitions", async () => {
    expect((await app.inject({ method: "POST", url: "/api/projects/nope/symbols/rebuild" })).statusCode).toBe(404);
    const projectId = await createProject();
    await app.inject({ method: "POST", url: `/api/projects/${projectId}/symbols/rebuild` });
    const missing = await app.inject({ method: "GET", url: `/api/projects/${projectId}/symbols/definition?name=missing` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");
  });
});
