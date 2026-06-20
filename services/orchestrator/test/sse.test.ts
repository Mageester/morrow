import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  afterEach(() => {
    app.close();
    db.close();
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
  });

  it("handles SSE streaming correctly including reconnect and terminal close", async () => {
    const pRes = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Test", workspacePath: tempDir } });
    const projectId = pRes.json().id;
    
    let releaseGate: () => void;
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    const gatedRunner = new TaskRunner(db, async () => { await gate; });
    
    // We override runner in the app for this specific test, so we recreate app
    await app.close();
    app = buildServer({ db, runner: gatedRunner, sseIntervalMs: 10 });

    const tRes = await app.inject({ method: "POST", url: `/api/projects/${projectId}/tasks/inspect-workspace` });
    const taskId = tRes.json().taskId;

    // Task is queued, we can listen
    let streamedEvents: any[] = [];
    app.inject({ method: "GET", url: `/api/tasks/${taskId}/events/stream` }).then((res: any) => {
      // Parsing the SSE raw body
      const chunks = res.body.split("\n\n").filter(Boolean);
      for (const chunk of chunks) {
        const lines = chunk.split("\n");
        const idLine = lines.find((l: string) => l.startsWith("id: "));
        const eventLine = lines.find((l: string) => l.startsWith("event: "));
        const dataLine = lines.find((l: string) => l.startsWith("data: "));
        if (idLine && eventLine && dataLine) {
          streamedEvents.push({
            id: parseInt(idLine.substring(4)),
            event: eventLine.substring(7),
            data: JSON.parse(dataLine.substring(6))
          });
        }
      }
    });

    // Wait for the stream to grab at least task.created
    await new Promise(r => setTimeout(r, 50));
    expect(streamedEvents.length).toBeGreaterThan(0);
    expect(streamedEvents[0].event).toBe("task.created");

    // Test reconnect using Last-Event-ID
    const lastEventId = streamedEvents[streamedEvents.length - 1].id;
    let reconnectedEvents: any[] = [];
    const reconnectPromise = app.inject({ method: "GET", url: `/api/tasks/${taskId}/events/stream`, headers: { "last-event-id": lastEventId.toString() } }).then((res: any) => {
      const chunks = res.body.split("\n\n").filter(Boolean);
      for (const chunk of chunks) {
        const lines = chunk.split("\n");
        const idLine = lines.find((l: string) => l.startsWith("id: "));
        if (idLine) {
          reconnectedEvents.push(parseInt(idLine.substring(4)));
        }
      }
    });

    // Release gate, which triggers terminal state
    releaseGate!();
    await gatedRunner.waitFor(taskId);
    await reconnectPromise;

    // Check no duplicates and ordered delivery
    expect(reconnectedEvents.every(id => id > lastEventId)).toBe(true);
    for (let i = 1; i < reconnectedEvents.length; i++) {
      expect(reconnectedEvents[i]).toBeGreaterThan(reconnectedEvents[i-1]);
    }
  });
});
