import { WebMissionStreamEnvelopeSchema } from "@morrow/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createEventSourceLifecycle, type EventStreamStatus } from "./event-stream.js";
import { missionKeys } from "./query-keys.js";

const streamEventTypes = [
  "mission.updated",
  "attention.updated",
  "artifact.updated",
  "runtime.updated",
] as const;

export type MissionStreamStatus = EventStreamStatus;

const statusMessages: Record<MissionStreamStatus, string> = {
  connecting: "Connecting…",
  synchronized: "Live",
  reconnecting: "Reconnecting…",
  offline: "Offline — showing last saved state",
};

export function useMissionStream(missionId: string) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<MissionStreamStatus>(() =>
    navigator.onLine ? "connecting" : "offline",
  );

  useEffect(() => {
    let lastCursor = 0;
    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: missionKeys.detail(missionId) });
    };
    const lifecycle = createEventSourceLifecycle({
      url: () => `/api/web/missions/${encodeURIComponent(missionId)}/stream?after=${lastCursor}`,
      eventTypes: streamEventTypes,
      onStatus: setStatus,
      onEvent: (eventType, event) => {
        try {
          const parsed = WebMissionStreamEnvelopeSchema.safeParse(
            JSON.parse(String(event.data)),
          );
          if (
            !parsed.success ||
            parsed.data.missionId !== missionId ||
            parsed.data.eventType !== eventType ||
            parsed.data.cursor <= lastCursor
          ) return;

          if (parsed.data.cursor !== lastCursor + 1) invalidate();
          lastCursor = parsed.data.cursor;
          invalidate();
        } catch {
          // Malformed or private internal data never enters application state.
        }
      },
      // A backgrounded tab can silently stall an EventSource without ever
      // firing "error"; reconcile when it becomes visible again.
      onVisible: invalidate,
    });
    lifecycle.start();
    return () => lifecycle.stop();
  }, [missionId, queryClient]);

  return { status, statusMessage: statusMessages[status] } as const;
}
