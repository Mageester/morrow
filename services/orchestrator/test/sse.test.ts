import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as http from "node:http";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";

describe("SSE Streaming", () => {
  let db: any;
  let runner: TaskRunner;
  let app: any;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "morrow-sse-test-"));
    const dbPath = join(tempDir, "morrow.db");
    db = openDatabase(dbPath);
    runner = new TaskRunner(db);
    app = buildServer({ db, runner, sseIntervalMs: 10 });
  });

  afterEach(async () => {
    await app?.close();
    db?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns 400 for invalid cursor", async () => {
    const pRes = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Test", workspacePath: tempDir } });
    const projectId = pRes.json().id;
    const tRes = await app.inject({ method: "POST", url: `/api/projects/${projectId}/tasks/inspect-workspace` });
    const taskId = tRes.json().taskId;

    const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/events/stream?after=abc` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_CURSOR");

    const res2 = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/events/stream`, headers: { "last-event-id": "xyz" } });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().error.code).toBe("INVALID_CURSOR");

    const res3 = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/events?after=1oops` });
    expect(res3.statusCode).toBe(400);
    expect(res3.json().error.code).toBe("INVALID_CURSOR");
    const res4 = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/events/stream?after=-1` });
    expect(res4.statusCode).toBe(400);
    expect(res4.json().error.code).toBe("INVALID_CURSOR");
    await runner.waitFor(taskId);
  });

  it("handles SSE streaming correctly including reconnect and terminal close", async () => {
    const pRes = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Test", workspacePath: tempDir } });
    const projectId = pRes.json().id;
    
    let releaseGate: () => void;
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    const { executeInspectWorkspaceTask } = await import("../src/execution/inspect-workspace.js");
    const gatedRunner = new TaskRunner(db, async (deps) => {
      await gate;
      await executeInspectWorkspaceTask(deps);
    });
    
    await app.close();
    app = buildServer({ db, runner: gatedRunner, sseIntervalMs: 10 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const tRes = await fetch(`${baseUrl}/api/projects/${projectId}/tasks/inspect-workspace`, { method: "POST" });
    const { taskId } = await tRes.json();

    const streamedEvents: any[] = [];
    const streamPromise = new Promise<void>((resolve, reject) => {
      http.get(`${baseUrl}/api/tasks/${taskId}/events/stream`, (res: any) => {
        let buffer = '';
        res.on('data', (chunk: any) => {
          buffer += chunk.toString();
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';
          for (const part of parts) {
            const lines = part.split('\n');
            const idLine = lines.find((l: string) => l.startsWith('id: '));
            const eventLine = lines.find((l: string) => l.startsWith('event: '));
            const dataLine = lines.find((l: string) => l.startsWith('data: '));
            if (idLine && eventLine && dataLine) {
              streamedEvents.push({
                id: parseInt(idLine.substring(4)),
                event: eventLine.substring(7),
                data: JSON.parse(dataLine.substring(6))
              });
            }
          }
        });
        res.on('end', () => resolve());
        res.on('error', reject);
      }).on('error', reject);
    });

    // Poll until the replayed task.created event lands instead of assuming a
    // fixed wall-clock delay: under parallel test load on a busy host the first
    // SSE chunk can take well over 50ms to arrive, which made this assertion
    // flaky. The event is guaranteed to be replayed from sequence 0, so wait for
    // it deterministically with a generous ceiling.
    const deadline = Date.now() + 5000;
    while (streamedEvents.length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(streamedEvents.length).toBeGreaterThan(0);
    expect(streamedEvents[0].event).toBe("task.created");

    const lastEventId = streamedEvents[streamedEvents.length - 1].id;
    
    const reconnectedEvents: any[] = [];
    const reconnectPromise = new Promise<void>((resolve, reject) => {
      http.get(`${baseUrl}/api/tasks/${taskId}/events/stream`, { headers: { "last-event-id": lastEventId.toString() } }, (res: any) => {
        let buffer = '';
        res.on('data', (chunk: any) => {
          buffer += chunk.toString();
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';
          for (const part of parts) {
            const lines = part.split('\n');
            const idLine = lines.find((l: string) => l.startsWith('id: '));
            if (idLine) {
              reconnectedEvents.push(parseInt(idLine.substring(4)));
            }
          }
        });
        res.on('end', () => resolve());
        res.on('error', reject);
      }).on('error', reject);
    });

    releaseGate!();
    await gatedRunner.waitFor(taskId);
    await streamPromise;
    await reconnectPromise;

    expect(reconnectedEvents.every(id => id > lastEventId)).toBe(true);
    for (let i = 1; i < reconnectedEvents.length; i++) {
      expect(reconnectedEvents[i]).toBeGreaterThan(reconnectedEvents[i-1]);
    }
  });

  it("streams ordered resumable browser signals without raw task payloads", async () => {
    const now = new Date().toISOString();
    projectRepository(db).createProject({ id: "chat-project", name: "Chat", workspacePath: tempDir, createdAt: now });
    conversationsRepository(db).createConversation({ id: "chat-conversation", projectId: "chat-project", title: "Chat", createdAt: now, updatedAt: now });
    taskRepository(db).createTask({ id: "chat-task", projectId: "chat-project", kind: "agent_chat", status: "queued", createdAt: now });
    conversationsRepository(db).appendMessage({
      id: "assistant", conversationId: "chat-conversation", role: "assistant", content: "canonical",
      taskId: "chat-task", streamingState: "queued", createdAt: now, updatedAt: now,
    });
    const records = taskRecordsRepository(db);
    const first = records.appendEvent({
      id: "private-1", taskId: "chat-task", type: "evidence.persisted",
      payload: { deltaText: "secret token-shaped text", artifact: "raw private artifact" }, createdAt: now,
    });
    records.transitionTask("chat-task", "running", { id: "private-2", payload: { private: "do not expose" }, createdAt: now });
    const terminal = records.transitionTask("chat-task", "completed", { id: "private-3", payload: { secret: "never" }, createdAt: now });

    const all = await app.inject({
      method: "GET",
      url: "/api/projects/chat-project/conversations/chat-conversation/tasks/chat-task/stream?after=0",
    });
    expect(all.statusCode).toBe(200);
    expect(all.headers["content-type"]).toContain("text/event-stream");
    expect(all.body).toContain(`id: ${first.sequence}`);
    expect(all.body).toContain("event: message.updated");
    expect(all.body).toContain("event: task.terminal");
    expect(all.body).not.toContain("secret token-shaped text");
    expect(all.body).not.toContain("raw private artifact");
    expect(all.body).not.toContain("do not expose");
    expect(all.body).not.toContain('"secret":"never"');

    const resumed = await app.inject({
      method: "GET",
      url: `/api/projects/chat-project/conversations/chat-conversation/tasks/chat-task/stream?after=${first.sequence}`,
    });
    const ids = [...resumed.body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id > first.sequence)).toBe(true);
    expect(ids.at(-1)).toBe(taskRecordsRepository(db).listEvents("chat-task").at(-1)?.sequence);

    const foreign = await app.inject({
      method: "GET",
      url: "/api/projects/chat-project/conversations/missing/tasks/chat-task/stream",
    });
    expect(foreign.statusCode).toBe(404);
    expect(terminal.status).toBe("completed");
  });
});
