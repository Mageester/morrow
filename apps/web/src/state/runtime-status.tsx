import { z } from "zod";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.js";

const RuntimeHealthSchema = z
  .object({
    ok: z.literal(true),
    service: z.literal("morrow-orchestrator"),
  })
  .passthrough();

const RUNTIME_HEALTH_TIMEOUT_MS = 5_000;

/**
 * How often to re-check health while the runtime is not answering.
 *
 * The provider used to check exactly once on mount, and its only other triggers
 * were the browser's `online`/`offline` events — which fire for network
 * interface changes, not for a local service starting up. So the ordinary
 * development sequence broke it: Vite is ready in under 200ms, the orchestrator
 * needs seconds to compile and resume missions, and every request in between is
 * refused. The page then said "Runtime offline" forever, and a manual refresh
 * was the only way out.
 */
const RUNTIME_HEALTH_RETRY_MS = 2_000;

/**
 * Heartbeat while online, so a runtime that dies is noticed on its own rather
 * than the page continuing to claim everything is fine.
 */
const RUNTIME_HEALTH_HEARTBEAT_MS = 15_000;

export type RuntimeConnectionStatus =
  | "checking"
  | "online"
  | "offline"
  | "reconnecting";

interface RuntimeStatusContextValue {
  refresh: () => Promise<void>;
  status: RuntimeConnectionStatus;
}

const RuntimeStatusContext = createContext<RuntimeStatusContextValue | null>(
  null,
);

interface ActiveHealthRequest {
  controller: AbortController;
  id: number;
  timeoutId: number;
}

export function RuntimeStatusProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RuntimeConnectionStatus>("checking");
  const activeRequest = useRef<ActiveHealthRequest | null>(null);
  const nextRequestId = useRef(0);

  const cancelActiveRequest = useCallback(() => {
    const request = activeRequest.current;
    if (!request) return;

    activeRequest.current = null;
    window.clearTimeout(request.timeoutId);
    request.controller.abort();
  }, []);

  const check = useCallback(async (pendingStatus: "checking" | "reconnecting") => {
    cancelActiveRequest();

    const id = ++nextRequestId.current;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      if (activeRequest.current?.id === id) {
        controller.abort();
      }
    }, RUNTIME_HEALTH_TIMEOUT_MS);
    activeRequest.current = { controller, id, timeoutId };
    setStatus(pendingStatus);

    try {
      await api.get("/api/health", RuntimeHealthSchema, {
        signal: controller.signal,
      });
      if (activeRequest.current?.id === id) {
        setStatus("online");
      }
    } catch {
      if (activeRequest.current?.id === id) {
        setStatus("offline");
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (activeRequest.current?.id === id) {
        activeRequest.current = null;
      }
    }
  }, [cancelActiveRequest]);

  const refresh = useCallback(() => check("checking"), [check]);

  useEffect(() => {
    void refresh();

    const handleOffline = () => {
      cancelActiveRequest();
      setStatus("offline");
    };
    const handleOnline = () => void check("reconnecting");
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      cancelActiveRequest();
    };
  }, [cancelActiveRequest, check, refresh]);

  // Keep checking. A runtime that was not up yet has to be able to come up, and
  // one that dies has to be able to be noticed, without the page being reloaded.
  useEffect(() => {
    if (status === "checking" || status === "reconnecting") return undefined;
    const delay = status === "online" ? RUNTIME_HEALTH_HEARTBEAT_MS : RUNTIME_HEALTH_RETRY_MS;
    const timer = window.setTimeout(() => {
      void check(status === "online" ? "checking" : "reconnecting");
    }, delay);
    return () => window.clearTimeout(timer);
  }, [check, status]);

  // Everything the page tried to load while the runtime was down failed, and
  // the query client is configured not to retry. Without this, coming back
  // online updated the indicator and nothing else: the panels stayed empty
  // until a manual refresh, which is exactly what "why do I have to refresh to
  // see what it's doing" was.
  // Only on RECOVERY, never on the first successful check. A normal startup is
  // `checking -> online`, and invalidating there would refetch everything the
  // page had only just requested.
  const previousStatus = useRef<RuntimeConnectionStatus>("checking");
  useEffect(() => {
    const recovered = status === "online"
      && (previousStatus.current === "offline" || previousStatus.current === "reconnecting");
    if (recovered) void queryClient.invalidateQueries();
    previousStatus.current = status;
  }, [queryClient, status]);

  const value = useMemo(() => ({ refresh, status }), [refresh, status]);

  return (
    <RuntimeStatusContext.Provider value={value}>
      {children}
    </RuntimeStatusContext.Provider>
  );
}

export function useRuntimeStatus(): RuntimeStatusContextValue {
  const value = useContext(RuntimeStatusContext);
  if (!value) {
    throw new Error(
      "useRuntimeStatus must be used inside RuntimeStatusProvider.",
    );
  }
  return value;
}
