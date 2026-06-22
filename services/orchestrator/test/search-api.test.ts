import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { conversationsRepository } from "../src/repositories/conversations.js";

describe("GET /api/projects/:projectId/search", () => {
  let db: any;
  let app: any;
  const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

  beforeEach(() => {
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db) });
    const projects = projectRepository(db);
    const convs = conversationsRepository(db);
    projects.createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts(0) });
    convs.createConversation({ id: "c1", projectId: "p1", title: "Refactor the database layer", createdAt: ts(1), updatedAt: ts(1) });
    convs.appendMessage({ id: "m1", conversationId: "c1", role: "user", content: "please add full text search", createdAt: ts(2), updatedAt: ts(2) });
  });

  afterEach(() => {
    app.close();
    db.close();
  });

  it("returns 404 for an unknown project", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/nope/search?q=search" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("returns ranked hits with snippets for a query", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/search?q=search" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.projectId).toBe("p1");
    expect(body.total).toBeGreaterThan(0);
    const message = body.hits.find((h: any) => h.kind === "message");
    expect(message.refId).toBe("m1");
    expect(message.snippet.toLowerCase()).toContain("search");
  });

  it("filters by kind query parameter", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/search?q=database&kind=conversation" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hits.every((h: any) => h.kind === "conversation")).toBe(true);
    expect(body.hits.some((h: any) => h.refId === "c1")).toBe(true);
  });

  it("returns an empty result for a blank query without error", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/search?q=" });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);
  });
});
