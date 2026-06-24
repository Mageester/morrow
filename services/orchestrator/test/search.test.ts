import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { memoryRepository } from "../src/repositories/memory.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { searchRepository, buildMatchQuery } from "../src/repositories/search.js";

describe("buildMatchQuery", () => {
  it("returns null for empty, whitespace, or operator-only input", () => {
    expect(buildMatchQuery("")).toBeNull();
    expect(buildMatchQuery("   ")).toBeNull();
    expect(buildMatchQuery('"*()^:-')).toBeNull();
  });

  it("lowercases and wraps tokens as quoted prefix terms, stripping FTS operators", () => {
    expect(buildMatchQuery("data*base")).toBe('"data"* "base"*');
    expect(buildMatchQuery("Hello WORLD")).toBe('"hello"* "world"*');
  });
});

describe("Search repository (FTS5)", () => {
  let db: Database.Database;
  let convs: ReturnType<typeof conversationsRepository>;
  let memory: ReturnType<typeof memoryRepository>;
  let search: ReturnType<typeof searchRepository>;
  const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

  beforeEach(() => {
    db = openDatabase(":memory:");
    const projects = projectRepository(db);
    convs = conversationsRepository(db);
    memory = memoryRepository(db);
    const tasks = taskRepository(db);
    search = searchRepository(db);

    projects.createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts(0) });
    projects.createProject({ id: "p2", name: "P2", workspacePath: process.cwd(), createdAt: ts(0) });

    convs.createConversation({ id: "c1", projectId: "p1", title: "Database migration plan", createdAt: ts(1), updatedAt: ts(1) });
    convs.createConversation({ id: "c2", projectId: "p2", title: "secret stuff", createdAt: ts(1), updatedAt: ts(1) });

    // m1: dense, short. m2: sparse, long. bm25 should rank m1 above m2 for "alpha".
    convs.appendMessage({ id: "m1", conversationId: "c1", role: "user", content: "alpha alpha alpha", createdAt: ts(2), updatedAt: ts(2) });
    convs.appendMessage({ id: "m2", conversationId: "c1", role: "assistant", content: "alpha " + "filler ".repeat(40), createdAt: ts(3), updatedAt: ts(3) });

    memory.create({ id: "mem1", projectId: "p1", scope: "project", content: "User prefers pnpm and turbo", source: "user", createdAt: ts(4) });
    tasks.createTask({ id: "t1", projectId: "p1", kind: "agent_chat", status: "completed", createdAt: ts(5) });
  });

  afterEach(() => db.close());

  it("returns a highlighted snippet for a matching message term", () => {
    const res = search.search("p1", "alpha");
    const hit = res.hits.find((h) => h.refId === "m1");
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("message");
    expect(hit!.snippet).toContain("[");
    expect(hit!.snippet.toLowerCase()).toContain("alpha");
  });

  it("ranks the denser, shorter match above the sparse, long one", () => {
    const res = search.search("p1", "alpha", { kinds: ["message"] });
    expect(res.hits.map((h) => h.refId)).toEqual(["m1", "m2"]);
  });

  it("scopes strictly to the requested project", () => {
    const inP1 = search.search("p1", "secret");
    expect(inP1.hits).toHaveLength(0);
    const inP2 = search.search("p2", "database");
    expect(inP2.hits).toHaveLength(0);
    const found = search.search("p2", "secret");
    expect(found.hits.map((h) => h.refId)).toEqual(["c2"]);
  });

  it("filters by kind", () => {
    expect(search.search("p1", "alpha", { kinds: ["memory"] }).hits).toHaveLength(0);
    const mem = search.search("p1", "pnpm", { kinds: ["memory"] });
    expect(mem.hits.map((h) => h.refId)).toEqual(["mem1"]);
  });

  it("matches conversation titles, memory content, and task kind", () => {
    expect(search.search("p1", "migration").hits.some((h) => h.kind === "conversation" && h.refId === "c1")).toBe(true);
    expect(search.search("p1", "turbo").hits.some((h) => h.kind === "memory" && h.refId === "mem1")).toBe(true);
    expect(search.search("p1", "agent_chat").hits.some((h) => h.kind === "task" && h.refId === "t1")).toBe(true);
  });

  it("returns no hits for an empty query without throwing", () => {
    const res = search.search("p1", "   ");
    expect(res.total).toBe(0);
    expect(res.hits).toHaveLength(0);
  });

  it("does not throw on FTS special characters", () => {
    expect(() => search.search("p1", 'da"ta*ba(se):^-')).not.toThrow();
  });

  it("filters by conversationId when provided", () => {
    const all = search.search("p1", "alpha", { conversationId: "c1" });
    expect(all.hits.map((h) => h.refId).sort()).toEqual(["m1", "m2"]);
    const none = search.search("p1", "alpha", { conversationId: "does-not-exist" });
    expect(none.hits).toHaveLength(0);
  });

  it("reflects content updates in the index", () => {
    convs.renameConversation("c1", "Kubernetes notes", ts(6));
    expect(search.search("p1", "migration").hits.some((h) => h.kind === "conversation")).toBe(false);
    expect(search.search("p1", "kubernetes").hits.some((h) => h.refId === "c1")).toBe(true);
  });

  it("removes messages from the index when their conversation is deleted", () => {
    db.prepare("DELETE FROM conversations WHERE id = ?").run("c1");
    expect(search.search("p1", "alpha").hits).toHaveLength(0);
    // Project-scoped memory (conversation_id NULL) is unaffected.
    expect(search.search("p1", "pnpm").hits.map((h) => h.refId)).toEqual(["mem1"]);
  });

  it("honors the limit option", () => {
    const res = search.search("p1", "alpha", { kinds: ["message"], limit: 1 });
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]!.refId).toBe("m1");
  });
});
