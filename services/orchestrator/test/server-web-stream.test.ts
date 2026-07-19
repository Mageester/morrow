import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as http from "node:http";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { resolveResumeCursor, encodeSse } from "../src/web/mission-stream.js";
import { WebMissionStreamEnvelopeSchema, type MissionBudget } from "@morrow/contracts";

const BUDGET: MissionBudget = {
  maxUsd: null,
  maxAttempts: null,
  maxReviewCycles: 2,
  spentUsd: 0,
  attemptsUsed: 0,
  reviewCyclesUsed: 0,
};

/** Collect Server-Sent-Events from a live connection, keeping both the raw wire
 *  text (for exact framing assertions) and the parsed frames (id/event/data). */
function connect(baseUrl: string, path: string, headers: Record<string, string> = {}) {
  const frames: Array<{ id: number; event: string; data: any }> = [];
  let raw = "";
  let buffer = "";
  const req = http.get(baseUrl + path, { headers }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      raw += chunk;
      buffer += chunk;
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const lines = part.split("\n");
        const idLine = lines.find((l) => l.startsWith("id: "));
        const eventLine = lines.find((l) => l.startsWith("event: "));
        const dataLine = lines.find((l) => l.startsWith("data: "));
        if (idLine && eventLine && dataLine) {
          frames.push({ id: Number(idLine.slice(4)), event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
        }
      }
    });
  });
  req.on("error", () => { /* destroyed on purpose during teardown */ });
  return { req, frames, getRaw: () => raw, close: () => req.destroy() };
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return predicate();
}

describe("Web mission event stream", () => {
  let db: any;
  let app: any;
  let tempDir: string;
  let baseUrl: string;
  let missions: ReturnType<typeof missionsRepository>;
  const open: Array<{ close: () => void }> = [];

  const PROJECT_ID = "p1";
  const MISSION_ID = "mission-1";

  function seedMission(id = MISSION_ID) {
    missions.create({ id, projectId: PROJECT_ID, objective: "Stream objective", budget: BUDGET });
    return id;
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "morrow-web-stream-"));
    db = openDatabase(join(tempDir, "morrow.db"));
    const now = "2026-07-19T00:00:00.000Z";
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run(PROJECT_ID, 1, "Personal", tempDir, now, now);
    missions = missionsRepository(db);
    app = buildServer({
      db,
      runner: new TaskRunner(db),
      missionControllerRunner: { run: vi.fn(), wake: vi.fn(), cancel: vi.fn(), isActive: vi.fn(() => false) },
      sseIntervalMs: 10,
      webStreamHeartbeatMs: 20,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as any;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await app.close();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolveResumeCursor takes the larger of after and Last-Event-ID and rejects garbage", () => {
    expect(resolveResumeCursor(undefined, undefined)).toBe(0);
    expect(resolveResumeCursor("5", undefined)).toBe(5);
    expect(resolveResumeCursor("2", "7")).toBe(7);
    expect(resolveResumeCursor("9", "3")).toBe(9);
    expect(() => resolveResumeCursor("abc", undefined)).toThrow();
    expect(() => resolveResumeCursor("-1", undefined)).toThrow();
  });

  it("encodeSse frames the envelope exactly as id/event/data", () => {
    const envelope = {
      version: 1 as const,
      cursor: 3,
      missionId: MISSION_ID,
      eventType: "mission.updated" as const,
      emittedAt: "2026-07-19T12:00:03.000Z",
      payload: { eventId: "mission-1-ev-3" },
    };
    expect(encodeSse(envelope)).toBe(
      `id: 3\nevent: mission.updated\ndata: ${JSON.stringify(envelope)}\n\n`,
    );
  });

  it("streams persisted events in order, framed exactly, and picks up events appended after open", async () => {
    seedMission();
    const e1 = missions.appendEvent(MISSION_ID, "mission.created", "Mission created");
    const e2 = missions.appendEvent(MISSION_ID, "mission.status_changed", "Status: draft → running", { from: "draft", to: "running" });

    const stream = connect(baseUrl, `/api/web/missions/${MISSION_ID}/stream`);
    open.push(stream);

    expect(await until(() => stream.frames.length >= 2)).toBe(true);

    // Live update: append AFTER the stream opened; the poll loop must deliver it.
    const e3 = missions.appendEvent(MISSION_ID, "mission.evidence_recorded", "Evidence recorded", { status: "passed" });
    expect(await until(() => stream.frames.length >= 3)).toBe(true);

    const ids = stream.frames.map((f) => f.id);
    expect(ids).toEqual([e1.sequence, e2.sequence, e3.sequence]);
    // strictly increasing, no duplicates
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);

    // event-type mapping
    expect(stream.frames.map((f) => f.event)).toEqual([
      "mission.updated",
      "runtime.updated",
      "artifact.updated",
    ]);

    // exact wire frame for the first event
    const firstEnvelope = {
      version: 1,
      cursor: e1.sequence,
      missionId: MISSION_ID,
      eventType: "mission.updated",
      emittedAt: e1.createdAt,
      payload: { eventId: e1.id, eventType: "mission.created", summary: "Mission created" },
    };
    expect(stream.getRaw()).toContain(
      `id: ${e1.sequence}\nevent: mission.updated\ndata: ${JSON.stringify(firstEnvelope)}\n\n`,
    );

    // every frame parses under the contract schema
    for (const frame of stream.frames) {
      const parsed = WebMissionStreamEnvelopeSchema.parse(frame.data);
      expect(parsed.cursor).toBe(frame.id);
      expect(parsed.missionId).toBe(MISSION_ID);
    }
  });

  it("resumes from a cursor: reconnect from cursor 2 starts at cursor 3", async () => {
    seedMission();
    missions.appendEvent(MISSION_ID, "mission.created", "one");
    missions.appendEvent(MISSION_ID, "mission.status_changed", "two");
    missions.appendEvent(MISSION_ID, "mission.evidence_recorded", "three");

    const stream = connect(baseUrl, `/api/web/missions/${MISSION_ID}/stream?after=2`);
    open.push(stream);

    expect(await until(() => stream.frames.length >= 1)).toBe(true);
    expect(stream.frames[0]!.id).toBe(3);
    expect(stream.frames.every((f) => f.id > 2)).toBe(true);
  });

  it("rejects an invalid cursor with a structured 400 (before stream headers)", async () => {
    seedMission();
    const res = await app.inject({ method: "GET", url: `/api/web/missions/${MISSION_ID}/stream?after=abc` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_CURSOR");

    const res2 = await app.inject({
      method: "GET",
      url: `/api/web/missions/${MISSION_ID}/stream`,
      headers: { "last-event-id": "xyz" },
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().error.code).toBe("INVALID_CURSOR");
  });

  it("returns 404 for an unknown mission before stream headers are sent", async () => {
    const res = await app.inject({ method: "GET", url: `/api/web/missions/nope/stream` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(res.headers["content-type"]).not.toContain("text/event-stream");
  });

  it("emits heartbeat comments without mutating the cursor", async () => {
    seedMission();
    missions.appendEvent(MISSION_ID, "mission.created", "one");
    const e2 = missions.appendEvent(MISSION_ID, "mission.status_changed", "two");

    const stream = connect(baseUrl, `/api/web/missions/${MISSION_ID}/stream`);
    open.push(stream);

    expect(await until(() => stream.frames.length >= 2)).toBe(true);
    // Wait for at least one idle heartbeat comment to be written.
    expect(await until(() => stream.getRaw().includes(": heartbeat\n\n"))).toBe(true);
    const framesAfterHeartbeat = stream.frames.length;
    expect(framesAfterHeartbeat).toBe(2);

    // A heartbeat must not have advanced or duplicated the cursor: the next real
    // event is delivered contiguously at e2.sequence + 1.
    const e3 = missions.appendEvent(MISSION_ID, "mission.evidence_recorded", "three");
    expect(await until(() => stream.frames.length >= 3)).toBe(true);
    expect(stream.frames[2]!.id).toBe(e2.sequence + 1);
    expect(e3.sequence).toBe(e2.sequence + 1);
    // no duplicate ids across the whole stream
    const ids = stream.frames.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
