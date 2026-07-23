import { WebMissionStreamEnvelopeSchema } from "@morrow/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { missionKeys } from "./query-keys.js";

const streamEventTypes = [
  "mission.updated",
  "attention.updated",
  "artifact.updated",
  "runtime.updated",
] as const;

export type MissionStreamStatus =
  | "connecting"
  | "synchronized"
  | "reconnecting"
  | "offline";

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
    let stopped = false;
    let source: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;
    let lastCursor = 0;

    const clearReconnectTimer = () => {
      if (reconnectTimer === null) return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const closeSource = () => {
      const current = source;
      source = null;
      current?.close();
    };

    const setCurrentStatus = (next: MissionStreamStatus) => {
      if (!stopped) setStatus(next);
    };

    let connect: () => void;

    const scheduleReconnect = () => {
      closeSource();
      if (stopped) return;
      if (!navigator.onLine) {
        clearReconnectTimer();
        setCurrentStatus("offline");
        return;
      }

      setCurrentStatus("reconnecting");
      if (reconnectTimer !== null) return;
      const delay = Math.min(1_000 * 2 ** reconnectAttempt, 15_000);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    connect = () => {
      if (stopped || source || reconnectTimer !== null) return;
      if (!navigator.onLine) {
        setCurrentStatus("offline");
        return;
      }

      const activeSource = new EventSource(
        `/api/web/missions/${encodeURIComponent(missionId)}/stream?after=${lastCursor}`,
      );
      source = activeSource;

      activeSource.addEventListener("open", () => {
        if (stopped || source !== activeSource) return;
        reconnectAttempt = 0;
        setCurrentStatus("synchronized");
      });
      activeSource.addEventListener("error", () => {
        if (stopped || source !== activeSource) return;
        scheduleReconnect();
      });

      for (const eventType of streamEventTypes) {
        activeSource.addEventListener(eventType, (event) => {
          if (stopped || source !== activeSource) return;
          try {
            const parsed = WebMissionStreamEnvelopeSchema.safeParse(
              JSON.parse(String((event as MessageEvent).data)),
            );
            if (
              !parsed.success ||
              parsed.data.missionId !== missionId ||
              parsed.data.eventType !== eventType ||
              parsed.data.cursor <= lastCursor
            ) {
              return;
            }

            if (parsed.data.cursor !== lastCursor + 1) {
              void queryClient.invalidateQueries({
                queryKey: missionKeys.detail(missionId),
              });
            }
            lastCursor = parsed.data.cursor;
            void queryClient.invalidateQueries({
              queryKey: missionKeys.detail(missionId),
            });
          } catch {
            // Malformed or private internal data never enters application state.
          }
        });
      }
    };

    const handleOffline = () => {
      clearReconnectTimer();
      closeSource();
      setCurrentStatus("offline");
    };
    const handleOnline = () => {
      if (stopped || source || reconnectTimer !== null) return;
      setCurrentStatus("reconnecting");
      connect();
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    setCurrentStatus(navigator.onLine ? "connecting" : "offline");
    if (navigator.onLine) connect();

    return () => {
      stopped = true;
      clearReconnectTimer();
      closeSource();
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [missionId, queryClient]);

  return { status, statusMessage: statusMessages[status] } as const;
}
