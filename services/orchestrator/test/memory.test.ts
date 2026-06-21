import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { memoryRepository } from "../src/repositories/memory.js";

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
});
