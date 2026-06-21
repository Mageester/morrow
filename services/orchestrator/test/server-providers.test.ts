import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import type { FastifyInstance } from "fastify";

describe("Provider / preset / memory API", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  const savedMock = process.env.MOCK_PROVIDER;

  beforeEach(async () => {
    delete process.env.MOCK_PROVIDER;
    db = openDatabase(":memory:");
    // No-op executor: we assert persisted routing without running the agent.
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    if (savedMock === undefined) delete process.env.MOCK_PROVIDER;
    else process.env.MOCK_PROVIDER = savedMock;
  });

  async function json(method: string, url: string, payload?: any) {
    const res = await app.inject({ method: method as any, url, ...(payload ? { payload } : {}) });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  }

  it("lists provider statuses without leaking secrets", async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-route-leak-test";
    try {
      const { status, body } = await json("GET", "/api/providers");
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(7);
      expect(JSON.stringify(body)).not.toContain("sk-route-leak-test");
      expect(body.find((p: any) => p.id === "openai").capabilities).toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  it("lists presets, models, capabilities, and honest OAuth findings", async () => {
    expect((await json("GET", "/api/presets")).body.length).toBe(7);
    const models = (await json("GET", "/api/models")).body;
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toHaveProperty("available");
    expect((await json("GET", "/api/providers/capabilities")).body.length).toBeGreaterThanOrEqual(7);
    const oauth = (await json("GET", "/api/providers/oauth")).body;
    expect(oauth.length).toBe(3);
    expect(oauth.every((f: any) => f.status === "unavailable")).toBe(true);
  });

  async function makeConversation() {
    const project = (await json("POST", "/api/projects", { name: "Test", workspacePath: process.cwd() })).body;
    const conv = (await json("POST", `/api/projects/${project.id}/conversations`, { title: "Chat" })).body;
    return { project, conv };
  }

  it("rejects an unavailable preset with a truthful reason", async () => {
    const { conv } = await makeConversation();
    const res = await json("POST", `/api/conversations/${conv.id}/messages`, { content: "hi", preset: "private-local" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PRESET_UNAVAILABLE");
  });

  it("routes to the mock provider and reports the decision", async () => {
    process.env.MOCK_PROVIDER = "true";
    const { conv } = await makeConversation();
    const send = await json("POST", `/api/conversations/${conv.id}/messages`, { content: "hi" });
    expect(send.status).toBe(202);
    expect(send.body.routing.providerId).toBe("mock");
    expect(send.body.assistantMessage.provider).toBe("mock");

    const agg = await json("GET", `/api/tasks/${send.body.task.id}`);
    expect(agg.body.routing.providerId).toBe("mock");
  });

  it("supports the full memory lifecycle with project isolation", async () => {
    const { project, conv } = await makeConversation();
    const created = await json("POST", `/api/projects/${project.id}/memory`, { scope: "conversation", content: "remember this", conversationId: conv.id });
    expect(created.status).toBe(201);
    const id = created.body.id;

    expect((await json("GET", `/api/projects/${project.id}/memory`)).body.length).toBe(1);
    expect((await json("GET", `/api/conversations/${conv.id}/memory`)).body.length).toBe(1);

    const disabled = await json("PATCH", `/api/memory/${id}`, { enabled: false });
    expect(disabled.body.enabled).toBe(false);
    expect((await json("GET", `/api/conversations/${conv.id}/memory`)).body.length).toBe(0);

    expect((await json("DELETE", `/api/memory/${id}`)).status).toBe(204);
    expect((await json("GET", `/api/projects/${project.id}/memory`)).body.length).toBe(0);
  });

  it("requires a conversationId for conversation-scoped memory", async () => {
    const { project } = await makeConversation();
    const res = await json("POST", `/api/projects/${project.id}/memory`, { scope: "conversation", content: "x" });
    expect(res.status).toBe(400);
  });
});
