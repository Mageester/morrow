import type { FastifyInstance } from "fastify";
import type { MissionEvent, WebMissionStreamEnvelope } from "@morrow/contracts";
import { ApiError } from "../server.js";
import type { MissionsRepository } from "../repositories/missions.js";

/**
 * Everything the resumable mission event stream needs, injected so the route
 * performs no global lookups and stays trivially testable. Timers are injectable
 * so tests can drive polling and heartbeats deterministically without waiting on
 * wall-clock seconds.
 */
export interface WebMissionStreamDependencies {
  missions: MissionsRepository;
  /** Persisted-event poll cadence. Defaults to 100ms in production. */
  pollIntervalMs?: number;
  /** Idle heartbeat cadence. Defaults to 15s per the spec. */
  heartbeatIntervalMs?: number;
}

type WebStreamEventType = WebMissionStreamEnvelope["eventType"];

// Runtime/execution lifecycle transitions surface in the runtime pane. Matched
// against the raw mission-event type with its `mission.` prefix stripped, so an
// unrelated event that merely contains one of these words (e.g.
// `review_started`) is never miscategorised.
const RUNTIME_SUFFIXES = new Set<string>([
  "started",
  "status_changed",
  "completed",
  "cancelled",
  "recovery_applied",
  "rolled_back",
  "loop_detected",
  "failure_recorded",
]);

/**
 * Map a durable mission-event type onto one of the four web envelope event
 * types the client cache is keyed by. The mapping is intentionally coarse: the
 * browser reacts to the *category* of change and then re-reads the authoritative
 * snapshot, so it never depends on the full internal event vocabulary.
 */
export function classifyWebStreamEventType(rawType: string): WebStreamEventType {
  const suffix = rawType.startsWith("mission.") ? rawType.slice("mission.".length) : rawType;
  // Approval / decision events drive the attention pane.
  if (suffix.includes("approv")) return "attention.updated";
  // Evidence and durable artifacts (checkpoints) drive the artifact pane.
  if (suffix.includes("evidence") || suffix.includes("artifact") || suffix === "checkpoint_created") {
    return "artifact.updated";
  }
  if (RUNTIME_SUFFIXES.has(suffix)) return "runtime.updated";
  return "mission.updated";
}

/**
 * Resolve the resume point for a stream. A client may present a cursor via the
 * `after` query parameter and/or the `Last-Event-ID` reconnect header; the
 * stream resumes from the larger of the two so a stale query string can never
 * replay events the client already acknowledged on the socket. Any malformed
 * value is rejected as a structured 400 (INVALID_CURSOR) rather than being
 * silently coerced.
 */
export function resolveResumeCursor(queryAfter: unknown, lastEventId: unknown): number {
  const parse = (value: unknown): number => {
    if (value === undefined || value === null || value === "") return 0;
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new ApiError(400, "Invalid cursor", "INVALID_CURSOR");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new ApiError(400, "Invalid cursor", "INVALID_CURSOR");
    return parsed;
  };
  return Math.max(parse(queryAfter), parse(lastEventId));
}

/**
 * Frame a single envelope as one SSE message. The `id:` line carries the mission
 * event sequence so the browser's EventSource records it as Last-Event-ID for
 * reconnects; `event:` carries the coarse envelope type for client-side routing.
 */
export function encodeSse(envelope: WebMissionStreamEnvelope): string {
  return `id: ${envelope.cursor}\nevent: ${envelope.eventType}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/**
 * Build the web envelope for a persisted mission event. The payload deliberately
 * carries only an opaque event identity: summaries and event data can contain
 * commands, credential-bearing URLs, or provider internals and must not cross
 * the browser boundary.
 */
function toEnvelope(missionId: string, event: MissionEvent): WebMissionStreamEnvelope {
  return {
    version: 1,
    cursor: event.sequence,
    missionId,
    eventType: classifyWebStreamEventType(event.type),
    emittedAt: event.createdAt,
    payload: { eventId: event.id },
  };
}

/**
 * Register the resumable, ordered mission event stream:
 *   GET /api/web/missions/:missionId/stream?after=<cursor>
 *
 * The stream polls PERSISTED mission events (never an in-memory-only bus) after
 * the last sent cursor, so it is correct across process restarts and delivers a
 * complete backlog on connect. It closes all timers when the socket closes and
 * emits an idle heartbeat comment so proxies keep the connection alive.
 */
export function registerWebMissionStreamRoutes(app: FastifyInstance, deps: WebMissionStreamDependencies): void {
  const pollIntervalMs = deps.pollIntervalMs ?? 100;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 15_000;

  app.get("/api/web/missions/:missionId/stream", async (request, reply) => {
    const { missionId } = request.params as { missionId: string };
    const afterQuery = (request.query as { after?: unknown }).after;
    const lastEventId = request.headers["last-event-id"];

    // Resolve the cursor (may throw a structured 400) and confirm the mission
    // exists BEFORE any stream headers are written, so a bad request surfaces as
    // a normal JSON error response rather than a half-open event stream.
    const startCursor = resolveResumeCursor(afterQuery, lastEventId);
    if (!deps.missions.get(missionId)) throw new ApiError(404, "Mission not found", "NOT_FOUND");

    reply.hijack();
    let closed = false;
    let lastSent = startCursor;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let waitingForDrain = false;
    let drainHandler: (() => void) | undefined;

    const clearTimers = () => {
      if (pollTimer) clearTimeout(pollTimer);
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      pollTimer = undefined;
      heartbeatTimer = undefined;
    };

    const stop = (destroyResponse = false) => {
      if (closed) return;
      closed = true;
      clearTimers();
      if (drainHandler) {
        reply.raw.off("drain", drainHandler);
        drainHandler = undefined;
      }
      if (destroyResponse && !reply.raw.destroyed) {
        try {
          reply.raw.destroy();
        } catch {
          if (!reply.raw.writableEnded) {
            try { reply.raw.end(); } catch { /* socket is already unusable */ }
          }
        }
      }
    };

    request.raw.on("close", stop);
    reply.raw.on("close", stop);
    reply.raw.on("error", () => stop(true));

    try {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
    } catch {
      stop(true);
      return;
    }

    const resumeAfterDrain = () => {
      drainHandler = undefined;
      if (closed) return;
      waitingForDrain = false;
      scheduleHeartbeat();
      poll();
    };

    const waitForDrain = () => {
      if (closed || waitingForDrain) return;
      waitingForDrain = true;
      clearTimers();
      drainHandler = resumeAfterDrain;
      reply.raw.once("drain", drainHandler);
    };

    const scheduleHeartbeat = () => {
      if (closed || waitingForDrain || heartbeatTimer) return;
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = undefined;
        if (closed || waitingForDrain) return;
        try {
          if (!reply.raw.write(": heartbeat\n\n")) {
            waitForDrain();
            return;
          }
          scheduleHeartbeat();
        } catch {
          stop(true);
        }
      }, heartbeatIntervalMs);
    };

    const schedulePoll = () => {
      if (closed || waitingForDrain || pollTimer) return;
      pollTimer = setTimeout(() => {
        pollTimer = undefined;
        poll();
      }, pollIntervalMs);
    };

    const poll = () => {
      if (closed || waitingForDrain) return;
      try {
        const pending = deps.missions.listEventsAfter(missionId, lastSent);
        if (pending.length > 0) {
          for (const event of pending) {
            const accepted = reply.raw.write(encodeSse(toEnvelope(missionId, event)));
            // Node accepts the chunk into its output buffer even when `write`
            // returns false. Advance only after a non-throwing write, then wait
            // for drain before querying or writing the next event.
            lastSent = event.sequence;
            if (!accepted) {
              waitForDrain();
              return;
            }
          }
          // Real traffic resets the idle clock: a heartbeat is only for silence.
          if (heartbeatTimer) {
            clearTimeout(heartbeatTimer);
            heartbeatTimer = undefined;
          }
          scheduleHeartbeat();
        }
        schedulePoll();
      } catch {
        stop(true);
      }
    };

    scheduleHeartbeat();
    poll();
  });
}
