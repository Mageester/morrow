import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as http from "node:http";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { taskRepository } from "../src/repositories/tasks.js";

type Frame = { id: number | null; event: string; data: Record<string, unknown> };

function connect(baseUrl: string, path: string) {
  const frames: Frame[] = [];
  let raw = "";
  let buffer = "";
  const req = http.get(baseUrl + path, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      raw += chunk;
      buffer += chunk;
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const lines = part.split("\n");
        const idLine = lines.find((line) => line.startsWith("id: "));
        const eventLine = lines.find((line) => line.startsWith("event: "));
        const dataLine = lines.find((line) => line.startsWith("data: "));
        if (eventLine && dataLine) {
          frames.push({
            id: idLine ? Number(idLine.slice(4)) : null,
            event: eventLine.slice(7),
            data: JSON.parse(dataLine.slice(6)) as Record<string, unknown>,
          });
        }
      }
    });
  });
  req.on("error", () => { /* closed by the test */ });
  return { req, frames, getRaw: () => raw, close: () => req.destroy() };
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

describe("chat task event stream", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof buildServer>;
  let tempDir: string;
  let baseUrl: string;
  let records: ReturnType<typeof taskRecordsRepository>;
  let taskId = 0;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "morrow-chat-stream-"));
    db = openDatabase(join(tempDir, "morrow.db"));
    const timestamp = "2026-07-22T12:00:00.000Z";
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run("project-1", 1, "Project", tempDir, timestamp, timestamp);
    records = taskRecordsRepository(db);
    app = buildServer({
      db,
      runner: new TaskRunner(db),
      sseIntervalMs: 10,
      chatStreamHeartbeatMs: 15,
      backgroundModelDiscovery: false,
      missionControllerRunner: { wake: () => {}, isActive: () => false },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedTask(status: "running" | "completed", events: Array<"task.running" | "assistant.turn_completed" | "task.completed">) {
    const id = `task-${++taskId}`;
    const timestamp = "2026-07-22T12:00:00.000Z";
    conversationsRepository(db).createConversation({ id: `conversation-${id}`, projectId: "project-1", title: "Chat", createdAt: timestamp, updatedAt: timestamp });
    taskRepository(db).createTask({ id, projectId: "project-1", kind: "agent_chat", status, createdAt: timestamp, updatedAt: timestamp });
    conversationsRepository(db).appendMessage({ id: `assistant-${id}`, conversationId: `conversation-${id}`, role: "assistant", content: status === "completed" ? "Final" : "", taskId: id, streamingState: status === "completed" ? "completed" : "streaming", provider: "mock", model: "mock-model", createdAt: timestamp, updatedAt: timestamp });
    for (const [index, type] of events.entries()) records.appendEvent({ id: `${id}-event-${index + 1}`, taskId: id, type, payload: {}, createdAt: timestamp });
    return { id, conversationId: `conversation-${id}` };
  }

  it("frames idle heartbeats without a durable cursor and cleans them up on close", async () => {
    const seeded = seedTask("running", ["task.running"]);
    const stream = connect(baseUrl, `/api/projects/project-1/conversations/${seeded.conversationId}/tasks/${seeded.id}/stream?after=0`);
    try {
      expect(await until(() => stream.frames.some((frame) => frame.event === "task.updated"))).toBe(true);
      expect(await until(() => stream.frames.some((frame) => frame.event === "stream.heartbeat"))).toBe(true);
      const heartbeat = stream.frames.find((frame) => frame.event === "stream.heartbeat")!;
      expect(heartbeat.id).toBeNull();
      expect(heartbeat.data).toMatchObject({ eventType: "stream.heartbeat", taskId: seeded.id, conversationId: seeded.conversationId });
      expect(stream.frames.filter((frame) => frame.id !== null).map((frame) => frame.id)).toEqual([1]);

      stream.close();
      const rawAfterClose = stream.getRaw().length;
      await new Promise((resolve) => setTimeout(resolve, 45));
      expect(stream.getRaw().length).toBe(rawAfterClose);
    } finally {
      stream.close();
    }
  });

  it("replays persisted events and terminal completion when the browser subscribes late", async () => {
    const seeded = seedTask("completed", ["task.running", "assistant.turn_completed", "task.completed"]);
    const stream = connect(baseUrl, `/api/projects/project-1/conversations/${seeded.conversationId}/tasks/${seeded.id}/stream?after=0`);
    try {
      expect(await until(() => stream.frames.length === 3)).toBe(true);
      expect(stream.frames.map((frame) => frame.id)).toEqual([1, 2, 3]);
      expect(stream.frames.at(-1)).toMatchObject({ id: 3, event: "task.terminal" });
      expect(await until(() => stream.req.destroyed || stream.req.closed)).toBe(true);
    } finally {
      stream.close();
    }
  });
});
