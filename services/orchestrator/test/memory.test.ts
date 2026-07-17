import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { memoryRepository } from "../src/repositories/memory.js";
import { taskRepository } from "../src/repositories/tasks.js";

describe("Memory repository", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
    const projects = projectRepository(db);
    const convs = conversationsRepository(db);
    const ts = new Date().toISOString();
    projects.createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts });
    projects.createProject({ id: "p2", name: "P2", workspacePath: process.cwd(), createdAt: ts });
    convs.createConversation({ id: "c1", projectId: "p1", title: "C1", createdAt: ts, updatedAt: ts });
    convs.createConversation({ id: "c2", projectId: "p1", title: "C2", createdAt: ts, updatedAt: ts });
  });
  afterEach(() => db.close());

  it("creates entries with explicit source and timestamp", () => {
    const mem = memoryRepository(db);
    const entry = mem.create({ id: "m1", projectId: "p1", scope: "project", content: "Uses pnpm", source: "user", createdAt: new Date().toISOString() });
    expect(entry.source).toBe("user");
    expect(entry.enabled).toBe(true);
    expect(entry.content).toBe("Uses pnpm");
  });

  it("isolates memory strictly by project", () => {
    const mem = memoryRepository(db);
    const ts = new Date().toISOString();
    mem.create({ id: "m1", projectId: "p1", scope: "project", content: "p1 note", source: "user", createdAt: ts });
    mem.create({ id: "m2", projectId: "p2", scope: "project", content: "p2 note", source: "user", createdAt: ts });
    expect(mem.listByProject("p1").map((e) => e.id)).toEqual(["m1"]);
    expect(mem.listByProject("p2").map((e) => e.id)).toEqual(["m2"]);
  });

  it("returns project/user scope plus only the matching conversation scope", () => {
    const mem = memoryRepository(db);
    const ts = new Date().toISOString();
    mem.create({ id: "proj", projectId: "p1", scope: "project", content: "project fact", source: "user", createdAt: ts });
    mem.create({ id: "user", projectId: "p1", scope: "user", content: "user pref", source: "user", createdAt: ts });
    mem.create({ id: "conv1", projectId: "p1", conversationId: "c1", scope: "conversation", content: "c1 only", source: "user", createdAt: ts });
    mem.create({ id: "conv2", projectId: "p1", conversationId: "c2", scope: "conversation", content: "c2 only", source: "user", createdAt: ts });

    const active = mem.listActiveForConversation("p1", "c1").map((e) => e.id);
    expect(active).toContain("proj");
    expect(active).toContain("user");
    expect(active).toContain("conv1");
    expect(active).not.toContain("conv2");
  });

  it("excludes disabled entries from the active set but keeps them listable", () => {
    const mem = memoryRepository(db);
    const ts = new Date().toISOString();
    mem.create({ id: "m1", projectId: "p1", scope: "project", content: "fact", source: "user", createdAt: ts });
    mem.setEnabled("m1", false, new Date().toISOString());
    expect(mem.listActiveForConversation("p1", "c1").map((e) => e.id)).not.toContain("m1");
    expect(mem.listByProject("p1").map((e) => e.id)).toContain("m1");
  });

  it("deletes entries", () => {
    const mem = memoryRepository(db);
    mem.create({ id: "m1", projectId: "p1", scope: "project", content: "fact", source: "user", createdAt: new Date().toISOString() });
    expect(mem.delete("m1")).toBe(true);
    expect(mem.get("m1")).toBeUndefined();
    expect(mem.delete("missing")).toBe(false);
  });

  it("returns pinned entries before unpinned ones regardless of creation order", () => {
    const mem = memoryRepository(db);
    mem.create({ id: "first", projectId: "p1", scope: "project", content: "older unpinned", source: "user", createdAt: "2026-01-01T00:00:00.000Z" });
    mem.create({ id: "second", projectId: "p1", scope: "project", content: "newer pinned", source: "user", pinned: true, createdAt: "2026-01-02T00:00:00.000Z" });
    expect(mem.listByProject("p1").map((e) => e.id)).toEqual(["second", "first"]);
    expect(mem.listActiveForConversation("p1", "c1").map((e) => e.id)).toEqual(["second", "first"]);
  });

  it("pins and unpins an existing entry", () => {
    const mem = memoryRepository(db);
    const e = mem.create({ id: "m1", projectId: "p1", scope: "project", content: "fact", source: "user", createdAt: new Date().toISOString() });
    expect(e.pinned).toBe(false);
    expect(mem.setPinned("m1", true, new Date().toISOString())!.pinned).toBe(true);
    expect(mem.setPinned("m1", false, new Date().toISOString())!.pinned).toBe(false);
  });

  it("stores task provenance and includes new project-wide tiers in the active set", () => {
    const mem = memoryRepository(db);
    const ts = new Date().toISOString();
    taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "agent_chat", status: "completed", createdAt: ts });
    const episodic = mem.create({ id: "ep", projectId: "p1", scope: "episodic", content: "deployed at 3pm", source: "summary", originTaskId: "t1", createdAt: ts });
    mem.create({ id: "proc", projectId: "p1", scope: "procedural", content: "how to release", source: "user", createdAt: ts });
    mem.create({ id: "know", projectId: "p1", scope: "knowledge", content: "api base url", source: "user", createdAt: ts });
    expect(episodic.originTaskId).toBe("t1");
    expect(episodic.scope).toBe("episodic");
    const active = mem.listActiveForConversation("p1", "c1").map((e) => e.id);
    expect(active).toEqual(expect.arrayContaining(["ep", "proc", "know"]));
  });

  it("persists the complete Cortex lifecycle metadata and ranks relevant active memory", () => {
    const mem = memoryRepository(db);
    const ts = "2026-01-02T00:00:00.000Z";
    mem.create({
      id: "cortex-pnpm-check",
      projectId: "p1",
      scope: "repository",
      type: "validation_expectation",
      content: "Use pnpm check before reporting repository work complete.",
      normalizedContent: "use pnpm check before reporting repository work complete",
      source: "cortex",
      evidenceReferences: [{ kind: "command", reference: "pnpm check", note: "mission evidence: exit 0" }],
      lifecycle: "active",
      lastVerifiedAt: ts,
      confidence: 0.91,
      successContribution: 2,
      failureContribution: 0,
      staleness: "current",
      sensitivity: "internal",
      expirationPolicy: "until_repository_changes",
      createdAt: ts,
    });
    mem.create({
      id: "expired",
      projectId: "p1",
      scope: "temporary_context",
      type: "environment_problem",
      content: "Old temporary outage",
      source: "cortex",
      lifecycle: "active",
      expiresAt: "2026-01-01T00:00:00.000Z",
      createdAt: ts,
    });

    const relevant = mem.retrieveRelevant("p1", "c1", "please run the pnpm repository checks", "2026-01-03T00:00:00.000Z");
    expect(relevant.map((entry) => entry.id)).toEqual(["cortex-pnpm-check"]);
    expect(relevant[0]).toMatchObject({
      scope: "repository",
      type: "validation_expectation",
      lifecycle: "active",
      confidence: 0.91,
      usageCount: 1,
      successContribution: 2,
      sensitivity: "internal",
      evidenceReferences: [{ kind: "command", reference: "pnpm check" }],
    });
  });
});
