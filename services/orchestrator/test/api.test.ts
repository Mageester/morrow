import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

describe("REST API and Task Runner Vertical Slice", () => {
  let db: any;
  let runner: TaskRunner;
  let app: any;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "morrow-api-test-"));
    dbPath = join(tempDir, "morrow.db");
    db = openDatabase(dbPath);
    runner = new TaskRunner(db);
    app = buildServer({ db, runner });
  });

  afterEach(() => {
    app.close();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns a truthful API root summary (terminal-first, no bundled UI)", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: "morrow-orchestrator",
      status: "healthy",
      health: "/api/health",
    });
  });

  it("includes context usage metadata in task aggregates without message content", async () => {
    const now = "2026-07-02T03:00:00.000Z";
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run("p1", 1, "Project", tempDir, now, now);
    db.prepare("INSERT INTO tasks(id,schema_version,project_id,type,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("task-ctx", 1, "p1", "agent_chat", "completed", now, now);
    db.prepare("INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)").run("c1", "p1", "Context", now, now);
    db.prepare("INSERT INTO context_summaries(id,project_id,conversation_id,task_id,method,content,source_start_index,source_end_index,source_message_count,source_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run("summary-1", "p1", "c1", "task-ctx", "deterministic", "secret should not be returned", 0, 1, 2, "hash", now);
    const insertEvent = db.prepare("INSERT INTO task_events(id,schema_version,task_id,sequence,type,payload_json,created_at) VALUES(?,?,?,?,?,?,?)");
    insertEvent.run("ev1", 1, "task-ctx", 1, "context.budget_calculated", JSON.stringify({
      provider: "mock",
      model: "mock-model",
      contextWindowTokens: 32768,
      contextWindowSource: "fallback",
      reservedTokens: 4096,
      maxInputTokens: 900,
    }), now);
    insertEvent.run("ev2", 1, "task-ctx", 2, "context.history_trimmed", JSON.stringify({
      inputTokensBefore: 1800,
      inputTokensAfter: 620,
      compactedGroups: 2,
      removedGroups: 1,
    }), now);
    insertEvent.run("ev3", 1, "task-ctx", 3, "context.estimate_used", JSON.stringify({
      method: "estimate",
      exact: false,
    }), now);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-ctx" });
    expect(res.statusCode).toBe(200);
    expect(res.json().context).toMatchObject({
      providerId: "mock",
      model: "mock-model",
      contextWindowTokens: 32768,
      contextWindowSource: "fallback",
      maxInputTokens: 900,
      inputTokensBefore: 1800,
      inputTokensAfter: 620,
      countingMethod: "estimate",
      exact: false,
      compactedGroups: 2,
      removedGroups: 1,
      lastSummary: { id: "summary-1", method: "deterministic", sourceMessageCount: 2 },
    });
    expect(JSON.stringify(res.json().context)).not.toContain("secret");
  });

  it("durably compacts a conversation locally without creating a model task", async () => {
    const now = "2026-07-13T12:00:00.000Z";
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run("p-compact", 1, "Project", tempDir, now, now);
    db.prepare("INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)").run("c-compact", "p-compact", "Context", now, now);
    const conversations = conversationsRepository(db);
    conversations.appendMessage({ id: "m1", conversationId: "c-compact", role: "user", content: "Goal: keep src/app.ts. api_key=do-not-store", createdAt: now, updatedAt: now });
    conversations.appendMessage({ id: "m2", conversationId: "c-compact", role: "assistant", content: "Decision: run pnpm test and preserve privacy.", createdAt: now, updatedAt: now });
    conversations.appendMessage({ id: "m3", conversationId: "c-compact", role: "user", content: "Continue with the current work.", createdAt: now, updatedAt: now });

    const previousMock = process.env.MOCK_PROVIDER;
    process.env.MOCK_PROVIDER = "true";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/conversations/c-compact/compact",
        payload: { projectId: "p-compact", preset: "balanced", providerId: "mock", model: "mock-model" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        compacted: true,
        summary: { method: "deterministic", sourceMessageCount: 2 },
        routing: { providerId: "mock", model: "mock-model" },
        context: { providerId: "mock", model: "mock-model" },
      });
      expect(db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 0 });
      const stored = db.prepare("SELECT method,content FROM context_summaries WHERE conversation_id=?").get("c-compact") as any;
      expect(stored.method).toBe("deterministic");
      expect(stored.content).toContain("src/app.ts");
      expect(stored.content).not.toContain("do-not-store");
    } finally {
      if (previousMock === undefined) delete process.env.MOCK_PROVIDER;
      else process.env.MOCK_PROVIDER = previousMock;
    }
  });

  it("refuses to compact a conversation through a different active project", async () => {
    const now = "2026-07-13T12:00:00.000Z";
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run("p-owner", 1, "Owner", tempDir, now, now);
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run("p-other", 1, "Other", tempDir, now, now);
    db.prepare("INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?)").run("c-owner", "p-owner", "Context", now, now);
    const conversations = conversationsRepository(db);
    conversations.appendMessage({ id: "owner-m1", conversationId: "c-owner", role: "user", content: "Keep this task scoped.", createdAt: now, updatedAt: now });
    conversations.appendMessage({ id: "owner-m2", conversationId: "c-owner", role: "assistant", content: "Scoped decision.", createdAt: now, updatedAt: now });

    const res = await app.inject({
      method: "POST",
      url: "/api/conversations/c-owner/compact",
      payload: { projectId: "p-other", preset: "balanced", providerId: "mock", model: "mock-model" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("CONVERSATION_PROJECT_MISMATCH");
    expect(db.prepare("SELECT COUNT(*) n FROM context_summaries WHERE conversation_id=?").get("c-owner")).toEqual({ n: 0 });
  });

  it("serves a JSON liveness probe at the root and advertises no web UI", async () => {
    // Morrow is terminal-first: the service exposes an API only, never a bundled
    // web dashboard, so "/" is always a JSON probe and health carries no UI URL.
    const rootRoute = await app.inject({ method: "GET", url: "/" });
    expect(rootRoute.statusCode).toBe(200);
    expect(rootRoute.json().name).toBe("morrow-orchestrator");
    expect(rootRoute.json().health).toBe("/api/health");

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().ok).toBe(true);
    expect(health.json()).not.toHaveProperty("ui");
    expect(health.json()).not.toHaveProperty("uiServed");
  });

  it("lists discoverable skills from MORROW_SKILLS_DIR (manifest and frontmatter formats)", async () => {
    const skillsDir = join(tempDir, "skills");
    // Old format: manifest.json + "# Heading"
    mkdirSync(join(skillsDir, "coding"), { recursive: true });
    const codingMd = "# Coding\n\nScoped implementation workflow.";
    writeFileSync(join(skillsDir, "coding", "SKILL.md"), codingMd);
    mkdirSync(join(skillsDir, "coding", "src"));
    writeFileSync(join(skillsDir, "coding", "src", "index.ts"), "export {};\n");
    writeFileSync(join(skillsDir, "coding", "permissions.json"), JSON.stringify({ tools: ["filesystem-write"] }));
    writeFileSync(join(skillsDir, "coding", "manifest.json"), JSON.stringify({
      id: "coding", name: "Coding", description: "Scoped implementation.", riskClass: "medium",
      requestedTools: ["filesystem-write"], entrypoint: "src/index.ts",
      checksum: createHash("sha256").update(codingMd).digest("hex"), publisher: "test",
    }));
    // New format: YAML frontmatter, no manifest
    mkdirSync(join(skillsDir, "debug-loop"), { recursive: true });
    writeFileSync(join(skillsDir, "debug-loop", "SKILL.md"), "---\nname: debug-loop\ndescription: Disciplined debugging methodology\nriskClass: low\npublisher: Axiom\n---\n\n# Debug Loop\n");

    const prev = process.env.MORROW_SKILLS_DIR;
    process.env.MORROW_SKILLS_DIR = skillsDir;
    const server = buildServer({ db, runner });
    try {
      const res = await server.inject({ method: "GET", url: "/api/skills" });
      expect(res.statusCode).toBe(200);
      const skills = res.json() as any[];
      expect(skills.length).toBe(2);
      const coding = skills.find((s) => s.id === "coding");
      expect(coding).toMatchObject({ name: "Coding", trustTier: "controlled", tools: ["filesystem-write"] });
      const debug = skills.find((s) => s.id === "debug-loop");
      // Frontmatter parsed: kebab name prettified, description + risk tier resolved.
      expect(debug).toMatchObject({ name: "Debug Loop", description: "Disciplined debugging methodology", trustTier: "core", category: "Debugging" });
    } finally {
      await server.close();
      if (prev === undefined) delete process.env.MORROW_SKILLS_DIR;
      else process.env.MORROW_SKILLS_DIR = prev;
    }
  });

  it("returns a structured 4xx (not a misleading 500) for a malformed JSON body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { "content-type": "application/json" },
      payload: "{bad json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeDefined();
    // The framework's client error must not be masked as INTERNAL_ERROR.
    expect(res.json().error.code).not.toBe("INTERNAL_ERROR");
  });

  it("returns 404 for missing resources", async () => {
    const res1 = await app.inject({ method: "GET", url: "/api/projects/unknown" });
    expect(res1.statusCode).toBe(404);
    expect(res1.json().error.code).toBe("NOT_FOUND");

    const res2 = await app.inject({ method: "GET", url: "/api/tasks/unknown" });
    expect(res2.statusCode).toBe(404);
  });

  it("canonicalizes workspace on project creation", async () => {
    const wsDir = join(tempDir, "ws");
    mkdirSync(wsDir);
    const createRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Test Project", workspacePath: wsDir + "/../ws" }
    });
    expect(createRes.statusCode).toBe(200);
    const p = createRes.json();
    expect(p.name).toBe("Test Project");
    expect(p.workspacePath).not.toContain("..");

    const listRes = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listRes.json()).toHaveLength(1);
  });

  it("creates Cortex specialist roles and exposes the named agent team for missions", async () => {
    const wsDir = join(tempDir, "mission-ws");
    mkdirSync(wsDir);
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Mission Project", workspacePath: wsDir },
    });
    const projectId = projectRes.json().id;

    const missionRes = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/missions`,
      payload: { objective: "Repair the package boundary" },
    });
    expect(missionRes.statusCode).toBe(201);
    const missionId = missionRes.json().id;

    const specialistsRes = await app.inject({ method: "GET", url: `/api/missions/${missionId}/specialists` });
    expect(specialistsRes.statusCode).toBe(200);
    const specialists = specialistsRes.json();
    expect(specialists.map((r: any) => r.id)).toEqual([
      "repository-mapper",
      "planner",
      "implementer",
      "test-engineer",
      "security-regression-reviewer",
      "final-reviewer",
    ]);
    expect(specialists.find((r: any) => r.id === "implementer")).toMatchObject({
      storesChainOfThought: false,
      status: "pending",
    });
    expect(specialists.find((r: any) => r.id === "implementer").allowedTools).toContain("propose_patch");

    const agentsRes = await app.inject({ method: "GET", url: `/api/projects/${projectId}/agents` });
    expect(agentsRes.statusCode).toBe(200);
    const agents = agentsRes.json();
    expect(agents.map((a: any) => a.name)).toEqual(expect.arrayContaining([
      "Cortex Repository Mapper",
      "Cortex Planner",
      "Cortex Implementer",
      "Cortex Test Engineer",
      "Cortex Security Reviewer",
      "Cortex Final Reviewer",
    ]));
    const implementer = agents.find((a: any) => a.name === "Cortex Implementer");
    expect(implementer.instructions).toContain("Allowed tools");

    const permsRes = await app.inject({ method: "GET", url: `/api/agents/${implementer.id}/tool-permissions` });
    expect(permsRes.statusCode).toBe(200);
    expect(permsRes.json().map((p: any) => p.toolName)).toContain("propose_patch");
  });

  it("returns structured error for invalid workspace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Test Project", workspacePath: join(tempDir, "does-not-exist") }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_WORKSPACE");
  });

  it("inspects workspace and streams events", async () => {
    const wsDir = join(tempDir, "ws");
    mkdirSync(wsDir);
    writeFileSync(join(wsDir, "test.txt"), "hello");

    const pRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Test", workspacePath: wsDir }
    });
    const projectId = pRes.json().id;

    const tRes = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks/inspect-workspace`
    });
    expect(tRes.statusCode).toBe(202);
    const taskId = tRes.json().taskId;

    await runner.waitFor(taskId);

    const aggRes = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
    const agg = aggRes.json();
    expect(agg.task.status).toBe("verified");
    expect(agg.evidence).toHaveLength(1);
    expect(agg.evidence[0].path).toBe("test.txt");

    const eRes = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/events?after=0` });
    const events = eRes.json();
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].type).toBe("task.verified");
  });

  it("prevents duplicate task execution", async () => {
    const wsDir = join(tempDir, "ws");
    mkdirSync(wsDir);
    const pRes = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Test", workspacePath: wsDir } });
    const projectId = pRes.json().id;

    // We can't really trigger duplicate execution easily since the route creates a NEW task each time, 
    // and runner.run() is synchronous in registering it. But we can test runner manually.
    const task = app.inject({ method: "POST", url: `/api/projects/${projectId}/tasks/inspect-workspace` });
    const task2 = app.inject({ method: "POST", url: `/api/projects/${projectId}/tasks/inspect-workspace` });
    
    const [res1, res2] = await Promise.all([task, task2]);
    // The fastify route creates a new task each time, so duplicate execution is prevented because
    // the POST handler calls runner.run(). If we test runner.run() directly, we can see the throw.
    
    const tRes = await app.inject({ method: "POST", url: `/api/projects/${projectId}/tasks/inspect-workspace` });
    const taskId = tRes.json().taskId;

    // Start a long-running task to simulate active processing
    const taskPromise = new Promise(resolve => setTimeout(resolve, 50));
    (runner as any).activeTasks.add("task-3");
    (runner as any).activePromises.set("task-3", taskPromise);
    expect(() => runner.run("task-3")).toThrow(/Duplicate/);
    (runner as any).activeTasks.delete("task-3");

    await runner.waitFor(taskId);
  });
});
