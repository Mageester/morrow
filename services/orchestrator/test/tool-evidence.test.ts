import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { renderEvidenceBody } from "../src/web/tool-evidence.js";
import { WebToolEvidenceSchema } from "@morrow/contracts";

function ts() { return new Date().toISOString(); }

describe("renderEvidenceBody", () => {
  it("shows the human-readable field of a structured result rather than its envelope", () => {
    expect(renderEvidenceBody(JSON.stringify({ exitCode: 0, stdout: "42 passing\n1 pending", durationMs: 12 })))
      .toMatchObject({ bodyKind: "text", body: "42 passing\n1 pending", truncated: false });
  });

  it("falls back to formatted JSON when no field is the answer", () => {
    const rendered = renderEvidenceBody(JSON.stringify({ matches: [1, 2, 3] }));
    expect(rendered.bodyKind).toBe("json");
    expect(rendered.body).toContain("\"matches\"");
  });

  it("reports honestly that a long result was cut", () => {
    const rendered = renderEvidenceBody(JSON.stringify({ stdout: "x".repeat(80_000) }));
    expect(rendered.truncated).toBe(true);
    expect(rendered.body.length).toBeLessThan(80_000);
    expect(rendered.bytes).toBeGreaterThan(80_000);
  });

  it("distinguishes a step that recorded nothing from one that recorded an empty string", () => {
    expect(renderEvidenceBody(null)).toMatchObject({ bodyKind: "none", body: "", bytes: 0 });
    expect(renderEvidenceBody(JSON.stringify({ stdout: "" }))).toMatchObject({ bodyKind: "json" });
  });
});

describe("Step evidence endpoint", () => {
  let db: any;
  let app: any;
  let conversationId: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts() });
    const conversations = conversationsRepository(db);
    const conversation = conversations.createConversation({
      id: "c1", projectId: "p1", title: "Thread", createdAt: ts(), updatedAt: ts(),
    });
    conversationId = conversation.id;
    taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "agent_chat", status: "completed", createdAt: ts() });
    // The route resolves the task through the conversation, so the assistant
    // message that owns it has to exist exactly as a real run would leave it.
    conversations.appendMessage({
      id: "m1", conversationId, role: "assistant", content: "Ran the suite.", taskId: "t1",
      createdAt: ts(), updatedAt: ts(),
    });
    conversations.upsertToolCall({
      id: "call-1", messageId: "m1", taskId: "t1", toolName: "run_command",
      argsJson: JSON.stringify({ command: "pnpm test", secretToken: "sk-live-should-not-appear" }),
      resultJson: JSON.stringify({ exitCode: 1, stdout: "3 failing\n42 passing" }),
      status: "completed",
      createdAt: ts(), startedAt: "2026-08-20T10:00:00.000Z", completedAt: "2026-08-20T10:00:02.000Z",
    });
  });
  afterEach(() => { app.close(); db.close(); });

  const url = (taskId: string, callId: string) =>
    `/api/projects/p1/conversations/${conversationId}/tasks/${taskId}/evidence/${callId}`;

  it("returns the step's recorded output with the facts the row already showed", async () => {
    const res = await app.inject({ method: "GET", url: url("t1", "call-1") });
    expect(res.statusCode, res.body).toBe(200);
    const evidence = WebToolEvidenceSchema.parse(res.json());
    expect(evidence).toMatchObject({
      taskId: "t1",
      toolCallId: "call-1",
      toolName: "run_command",
      status: "completed",
      target: "pnpm test",
      exitCode: 1,
      durationMs: 2000,
      bodyKind: "text",
      truncated: false,
    });
    expect(evidence.body).toBe("3 failing\n42 passing");
  });

  it("never echoes the step's arguments beyond the one target field", async () => {
    const res = await app.inject({ method: "GET", url: url("t1", "call-1") });
    expect(res.body).not.toContain("sk-live-should-not-appear");
    expect(res.body).not.toContain("secretToken");
  });

  it("404s a step id that belongs to another task instead of serving it", async () => {
    taskRepository(db).createTask({ id: "t2", projectId: "p1", kind: "agent_chat", status: "completed", createdAt: ts() });
    conversationsRepository(db).appendMessage({
      id: "m2", conversationId, role: "assistant", content: "Other.", taskId: "t2",
      createdAt: ts(), updatedAt: ts(),
    });
    const res = await app.inject({ method: "GET", url: url("t2", "call-1") });
    expect(res.statusCode).toBe(404);
  });

  it("404s a task that is not part of this conversation", async () => {
    taskRepository(db).createTask({ id: "loose", projectId: "p1", kind: "agent_chat", status: "completed", createdAt: ts() });
    const res = await app.inject({ method: "GET", url: url("loose", "call-1") });
    expect(res.statusCode).toBe(404);
  });

  it("is never cached, because a running step's output changes under it", async () => {
    const res = await app.inject({ method: "GET", url: url("t1", "call-1") });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
