import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as http from "node:http";
import Fastify from "fastify";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { resolveResumeCursor, encodeSse, registerWebMissionStreamRoutes } from "../src/web/mission-stream.js";
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

  it("queries persisted mission events strictly after the supplied cursor", () => {
    seedMission();
    missions.appendEvent(MISSION_ID, "mission.created", "one");
    const second = missions.appendEvent(MISSION_ID, "mission.status_changed", "two");
    const third = missions.appendEvent(MISSION_ID, "mission.evidence_recorded", "three");

    expect(missions.listEventsAfter(MISSION_ID, second.sequence)).toEqual([third]);
    expect(missions.listEventsAfter(MISSION_ID, third.sequence)).toEqual([]);
  });

  it("forwards the last sent cursor to the bounded repository query", async () => {
    seedMission();
    missions.appendEvent(MISSION_ID, "mission.created", "one");
    missions.appendEvent(MISSION_ID, "mission.status_changed", "two");
    const third = missions.appendEvent(MISSION_ID, "mission.evidence_recorded", "three");
    const listEventsAfter = vi.fn(missions.listEventsAfter);
    const streamApp = Fastify({ logger: false });
    registerWebMissionStreamRoutes(streamApp, {
      missions: { ...missions, listEventsAfter },
      pollIntervalMs: 10,
      heartbeatIntervalMs: 100,
    });
    await streamApp.listen({ host: "127.0.0.1", port: 0 });
    const address = streamApp.server.address() as any;
    const stream = connect(`http://127.0.0.1:${address.port}`, `/api/web/missions/${MISSION_ID}/stream?after=2`);

    try {
      expect(await until(() => stream.frames.length === 1)).toBe(true);
      expect(stream.frames[0]!.id).toBe(third.sequence);
      expect(listEventsAfter).toHaveBeenCalledWith(MISSION_ID, 2);
      expect(await until(() => listEventsAfter.mock.calls.length >= 2)).toBe(true);
      expect(listEventsAfter).toHaveBeenCalledWith(MISSION_ID, third.sequence);
    } finally {
      stream.close();
      await streamApp.close();
    }
  });

  it("hijacks Fastify only after validation and before writing SSE headers", async () => {
    seedMission();
    missions.appendEvent(MISSION_ID, "mission.created", "one");
    const order: string[] = [];
    const streamApp = Fastify({ logger: false });
    streamApp.addHook("onRequest", (request, reply, done) => {
      const hijack = reply.hijack.bind(reply);
      reply.hijack = (() => {
        order.push("hijack");
        return hijack();
      }) as typeof reply.hijack;
      const writeHead = reply.raw.writeHead.bind(reply.raw);
      reply.raw.writeHead = ((...args: Parameters<typeof reply.raw.writeHead>) => {
        order.push("headers");
        return writeHead(...args);
      }) as typeof reply.raw.writeHead;
      done();
    });
    registerWebMissionStreamRoutes(streamApp, { missions, pollIntervalMs: 10, heartbeatIntervalMs: 100 });
    await streamApp.listen({ host: "127.0.0.1", port: 0 });
    const address = streamApp.server.address() as any;
    const stream = connect(`http://127.0.0.1:${address.port}`, `/api/web/missions/${MISSION_ID}/stream`);

    try {
      expect(await until(() => stream.frames.length === 1)).toBe(true);
      expect(order.slice(0, 2)).toEqual(["hijack", "headers"]);
    } finally {
      stream.close();
      await streamApp.close();
    }

    order.length = 0;
    const validationApp = Fastify({ logger: false });
    validationApp.addHook("onRequest", (request, reply, done) => {
      const hijack = reply.hijack.bind(reply);
      reply.hijack = (() => {
        order.push("hijack");
        return hijack();
      }) as typeof reply.hijack;
      done();
    });
    registerWebMissionStreamRoutes(validationApp, { missions });
    const invalid = await validationApp.inject({
      method: "GET",
      url: `/api/web/missions/${MISSION_ID}/stream?after=invalid`,
    });
    expect(invalid.statusCode).toBe(400);
    expect(order).toEqual([]);
    await validationApp.close();
  });

  it("stops polling when the raw response closes", async () => {
    seedMission();
    const listEventsAfter = vi.fn(missions.listEventsAfter);
    const streamApp = Fastify({ logger: false });
    let rawResponse: http.ServerResponse | undefined;
    streamApp.addHook("onRequest", (request, reply, done) => {
      rawResponse = reply.raw;
      done();
    });
    registerWebMissionStreamRoutes(streamApp, {
      missions: { ...missions, listEventsAfter },
      pollIntervalMs: 5,
      heartbeatIntervalMs: 100,
    });
    await streamApp.listen({ host: "127.0.0.1", port: 0 });
    const address = streamApp.server.address() as any;
    const stream = connect(`http://127.0.0.1:${address.port}`, `/api/web/missions/${MISSION_ID}/stream`);

    try {
      expect(await until(() => listEventsAfter.mock.calls.length >= 2)).toBe(true);
      rawResponse!.emit("close");
      const callsAfterClose = listEventsAfter.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(listEventsAfter).toHaveBeenCalledTimes(callsAfterClose);
    } finally {
      stream.close();
      await streamApp.close();
    }
  });

  it("stops and destroys the stream when the raw response emits an error", async () => {
    seedMission();
    const listEventsAfter = vi.fn(missions.listEventsAfter);
    const streamApp = Fastify({ logger: false });
    let rawResponse: http.ServerResponse | undefined;
    streamApp.addHook("onRequest", (request, reply, done) => {
      rawResponse = reply.raw;
      done();
    });
    registerWebMissionStreamRoutes(streamApp, {
      missions: { ...missions, listEventsAfter },
      pollIntervalMs: 5,
      heartbeatIntervalMs: 100,
    });
    await streamApp.listen({ host: "127.0.0.1", port: 0 });
    const address = streamApp.server.address() as any;
    const stream = connect(`http://127.0.0.1:${address.port}`, `/api/web/missions/${MISSION_ID}/stream`);

    try {
      expect(await until(() => listEventsAfter.mock.calls.length >= 2)).toBe(true);
      expect(() => rawResponse!.emit("error", new Error("synthetic response failure"))).not.toThrow();
      expect(await until(() => rawResponse!.destroyed)).toBe(true);
      const callsAfterError = listEventsAfter.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(listEventsAfter).toHaveBeenCalledTimes(callsAfterError);
    } finally {
      stream.close();
      await streamApp.close();
    }
  });

  it("contains repository exceptions from timer callbacks and destroys the stream", async () => {
    seedMission();
    const listEventsAfter = vi.fn()
      .mockReturnValueOnce([])
      .mockImplementation(() => { throw new Error("synthetic repository failure"); });
    const streamApp = Fastify({ logger: false });
    let rawResponse: http.ServerResponse | undefined;
    streamApp.addHook("onRequest", (request, reply, done) => {
      rawResponse = reply.raw;
      done();
    });
    registerWebMissionStreamRoutes(streamApp, {
      missions: { ...missions, listEventsAfter },
      pollIntervalMs: 5,
      heartbeatIntervalMs: 100,
    });
    await streamApp.listen({ host: "127.0.0.1", port: 0 });
    const address = streamApp.server.address() as any;
    const stream = connect(`http://127.0.0.1:${address.port}`, `/api/web/missions/${MISSION_ID}/stream`);

    try {
      expect(await until(() => listEventsAfter.mock.calls.length >= 2)).toBe(true);
      expect(await until(() => rawResponse!.destroyed)).toBe(true);
    } finally {
      stream.close();
      await streamApp.close();
    }
  });

  it("contains write exceptions and destroys the stream after headers", async () => {
    seedMission();
    missions.appendEvent(MISSION_ID, "mission.created", "one");
    const streamApp = Fastify({ logger: false });
    let rawResponse: http.ServerResponse | undefined;
    streamApp.addHook("onRequest", (request, reply, done) => {
      rawResponse = reply.raw;
      reply.raw.write = (() => { throw new Error("synthetic write failure"); }) as typeof reply.raw.write;
      done();
    });
    registerWebMissionStreamRoutes(streamApp, { missions, pollIntervalMs: 5, heartbeatIntervalMs: 100 });
    await streamApp.listen({ host: "127.0.0.1", port: 0 });
    const address = streamApp.server.address() as any;
    const stream = connect(`http://127.0.0.1:${address.port}`, `/api/web/missions/${MISSION_ID}/stream`);

    try {
      expect(await until(() => rawResponse?.destroyed === true)).toBe(true);
    } finally {
      stream.close();
      await streamApp.close();
    }
  });

  it("contains header write exceptions after hijacking and destroys the stream", async () => {
    seedMission();
    const streamApp = Fastify({ logger: false });
    let rawResponse: http.ServerResponse | undefined;
    streamApp.addHook("onRequest", (request, reply, done) => {
      rawResponse = reply.raw;
      reply.raw.writeHead = (() => { throw new Error("synthetic header failure"); }) as typeof reply.raw.writeHead;
      done();
    });
    registerWebMissionStreamRoutes(streamApp, { missions, pollIntervalMs: 5, heartbeatIntervalMs: 100 });
    await streamApp.listen({ host: "127.0.0.1", port: 0 });
    const address = streamApp.server.address() as any;
    const stream = connect(`http://127.0.0.1:${address.port}`, `/api/web/missions/${MISSION_ID}/stream`);

    try {
      expect(await until(() => rawResponse?.destroyed === true)).toBe(true);
    } finally {
      stream.close();
      await streamApp.close();
    }
  });

  it("pauses buffered event delivery on backpressure and resumes from the accepted cursor after drain", async () => {
    seedMission();
    const first = missions.appendEvent(MISSION_ID, "mission.created", "one");
    const second = missions.appendEvent(MISSION_ID, "mission.status_changed", "two");
    const listEventsAfter = vi.fn(missions.listEventsAfter);
    const streamApp = Fastify({ logger: false });
    let rawResponse: http.ServerResponse | undefined;
    let eventWrites = 0;
    streamApp.addHook("onRequest", (request, reply, done) => {
      rawResponse = reply.raw;
      const write = reply.raw.write.bind(reply.raw);
      reply.raw.write = ((chunk: any, ...args: any[]) => {
        const accepted = write(chunk, ...args);
        if (String(chunk).startsWith("id: ") && ++eventWrites === 1) return false;
        return accepted;
      }) as typeof reply.raw.write;
      done();
    });
    registerWebMissionStreamRoutes(streamApp, {
      missions: { ...missions, listEventsAfter },
      pollIntervalMs: 5,
      heartbeatIntervalMs: 100,
    });
    await streamApp.listen({ host: "127.0.0.1", port: 0 });
    const address = streamApp.server.address() as any;
    const stream = connect(`http://127.0.0.1:${address.port}`, `/api/web/missions/${MISSION_ID}/stream`);

    try {
      expect(await until(() => stream.frames.length >= 1)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(stream.frames.map((frame) => frame.id)).toEqual([first.sequence]);
      expect(rawResponse!.listenerCount("drain")).toBe(1);
      expect(listEventsAfter).toHaveBeenCalledTimes(1);

      rawResponse!.emit("drain");
      expect(await until(() => stream.frames.length === 2)).toBe(true);
      expect(stream.frames.map((frame) => frame.id)).toEqual([first.sequence, second.sequence]);
      expect(listEventsAfter).toHaveBeenCalledWith(MISSION_ID, first.sequence);
      expect(rawResponse!.listenerCount("drain")).toBe(0);
    } finally {
      stream.close();
      await streamApp.close();
    }
  });

  it("pauses heartbeats and polling on backpressure and resumes both after drain", async () => {
    seedMission();
    const listEventsAfter = vi.fn(missions.listEventsAfter);
    const streamApp = Fastify({ logger: false });
    let rawResponse: http.ServerResponse | undefined;
    let heartbeatWrites = 0;
    streamApp.addHook("onRequest", (request, reply, done) => {
      rawResponse = reply.raw;
      const write = reply.raw.write.bind(reply.raw);
      reply.raw.write = ((chunk: any, ...args: any[]) => {
        const accepted = write(chunk, ...args);
        if (String(chunk) === ": heartbeat\n\n" && ++heartbeatWrites === 1) return false;
        return accepted;
      }) as typeof reply.raw.write;
      done();
    });
    registerWebMissionStreamRoutes(streamApp, {
      missions: { ...missions, listEventsAfter },
      pollIntervalMs: 5,
      heartbeatIntervalMs: 10,
    });
    await streamApp.listen({ host: "127.0.0.1", port: 0 });
    const address = streamApp.server.address() as any;
    const stream = connect(`http://127.0.0.1:${address.port}`, `/api/web/missions/${MISSION_ID}/stream`);

    try {
      expect(await until(() => heartbeatWrites === 1)).toBe(true);
      const pollsAtBackpressure = listEventsAfter.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(heartbeatWrites).toBe(1);
      expect(listEventsAfter).toHaveBeenCalledTimes(pollsAtBackpressure);
      expect(rawResponse!.listenerCount("drain")).toBe(1);

      rawResponse!.emit("drain");
      expect(await until(() => heartbeatWrites >= 2)).toBe(true);
      expect(listEventsAfter.mock.calls.length).toBeGreaterThan(pollsAtBackpressure);
      expect(rawResponse!.listenerCount("drain")).toBe(0);
    } finally {
      stream.close();
      await streamApp.close();
    }
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
      payload: { eventId: e1.id },
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

  it("exposes only the event ID when a persisted summary contains credentials", async () => {
    seedMission();
    const secretSummary = "Authorization: Bearer test-only-secret fetch https://user:password@example.test/private";
    const event = missions.appendEvent(MISSION_ID, "mission.criterion_verified", secretSummary, {
      command: "curl -H 'Authorization: Bearer test-only-secret' https://user:password@example.test/private",
      provider: "private-provider",
      model: "private-model",
    });

    const stream = connect(baseUrl, `/api/web/missions/${MISSION_ID}/stream`);
    open.push(stream);

    expect(await until(() => stream.frames.length === 1)).toBe(true);
    const expectedEnvelope = {
      version: 1,
      cursor: event.sequence,
      missionId: MISSION_ID,
      eventType: "mission.updated",
      emittedAt: event.createdAt,
      payload: { eventId: event.id },
    };
    expect(stream.getRaw()).toContain(
      `id: ${event.sequence}\nevent: mission.updated\ndata: ${JSON.stringify(expectedEnvelope)}\n\n`,
    );
    expect(stream.frames[0]!.data).toEqual(expectedEnvelope);
    expect(stream.getRaw()).not.toContain("Authorization");
    expect(stream.getRaw()).not.toContain("Bearer");
    expect(stream.getRaw()).not.toContain("test-only-secret");
    expect(stream.getRaw()).not.toContain("https://user:password@example.test/private");
    expect(stream.getRaw()).not.toContain("mission.criterion_verified");
    expect(stream.getRaw()).not.toContain("private-provider");
    expect(stream.getRaw()).not.toContain("private-model");
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
