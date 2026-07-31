import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";

/**
 * Task 11: the orchestrator serves the built web app at /app while every
 * existing API and the JSON root probe stay exactly as they were, and no
 * catch-all intercepts /api/*.
 */
describe("web app static serving at /app", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let webRoot: string;
  const INDEX_HTML =
    '<!doctype html><html><head><title>Morrow</title></head><body><div id="root"></div><script type="module" src="/app/assets/app.js"></script></body></html>';
  const APP_JS = 'export const ok = true;\n';

  beforeEach(async () => {
    db = openDatabase(":memory:");
    webRoot = mkdtempSync(join(tmpdir(), "morrow-webroot-"));
    mkdirSync(join(webRoot, "assets"), { recursive: true });
    writeFileSync(join(webRoot, "index.html"), INDEX_HTML);
    writeFileSync(join(webRoot, "assets", "app.js"), APP_JS);
    app = buildServer({
      db,
      runner: new TaskRunner(db),
      backgroundModelDiscovery: false,
      webRoot,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(webRoot, { recursive: true, force: true });
  });

  it("redirects /app to /app/", async () => {
    const res = await app.inject({ method: "GET", url: "/app" });
    expect([301, 302, 308]).toContain(res.statusCode);
    expect(res.headers.location).toBe("/app/");
  });

  it("serves the SPA index at /app/", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/app/",
      headers: { accept: "text/html" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('id="root"');
  });

  it("serves the SPA index for a deep client route", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/app/missions/example",
      headers: { accept: "text/html" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('id="root"');
  });

  it("serves a real hashed asset", async () => {
    const res = await app.inject({ method: "GET", url: "/app/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("export const ok");
  });

  it("returns a structured 404 (not HTML) for a missing asset", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/app/assets/nope.js",
      headers: { accept: "text/html" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("keeps /api/health as JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toBe("morrow-orchestrator");
  });

  it("keeps the root probe as JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: "morrow-orchestrator",
      status: "healthy",
      health: "/api/health",
    });
  });

  it("returns a structured 404 for an unknown /api route (no SPA interception)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/does-not-exist",
      headers: { accept: "text/html" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});

describe("web app serving stays inert without a web root", () => {
  it("does not serve /app when webRoot is absent (CLI-only)", async () => {
    const db = openDatabase(":memory:");
    const app = buildServer({
      db,
      runner: new TaskRunner(db),
      backgroundModelDiscovery: false,
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/app/",
        headers: { accept: "text/html" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
    } finally {
      await app.close();
      db.close();
    }
  });
});
