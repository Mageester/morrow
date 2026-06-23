import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer, type DiagnosticsRunner } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";

describe("GET /api/projects/:id/diagnostics", () => {
  let db: any;
  let app: any;
  const fakeRunner: DiagnosticsRunner = async (tool, _cwd) => {
    if (tool === "tsc") {
      return { stdout: "src/foo.ts(3,1): error TS2304: Cannot find name 'z'.\nFound 1 error.", stderr: "", exitCode: 1 };
    }
    return { stdout: JSON.stringify([{ filePath: "/x/a.ts", messages: [{ line: 1, column: 1, severity: 1, ruleId: "semi", message: "Missing semicolon" }] }]), stderr: "", exitCode: 1 };
  };

  beforeEach(() => {
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}), diagnosticsRunner: fakeRunner });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: new Date().toISOString() });
  });
  afterEach(() => {
    app.close();
    db.close();
  });

  it("returns a structured tsc report by default", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/diagnostics" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tool: "tsc", count: 1, errorCount: 1, warningCount: 0 });
    expect(res.json().diagnostics[0]).toMatchObject({ file: "src/foo.ts", code: "TS2304", severity: "error" });
  });

  it("supports the eslint tool via query param", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/diagnostics?tool=eslint" });
    expect(res.json()).toMatchObject({ tool: "eslint", count: 1, errorCount: 0, warningCount: 1 });
  });

  it("404s on an unknown project and 400s on an unknown tool", async () => {
    expect((await app.inject({ method: "GET", url: "/api/projects/nope/diagnostics" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/projects/p1/diagnostics?tool=flow" })).statusCode).toBe(400);
  });
});
