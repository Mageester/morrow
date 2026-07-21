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
import { api } from "../api/client.js";

const RuntimeHealthSchema = z
  .object({
    ok: z.literal(true),
    service: z.literal("morrow-orchestrator"),
  })
  .passthrough();

const RUNTIME_HEALTH_TIMEOUT_MS = 5_000;

export type RuntimeConnectionStatus = "checking" | "online" | "offline";

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

  const refresh = useCallback(async () => {
    cancelActiveRequest();

    const id = ++nextRequestId.current;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      if (activeRequest.current?.id === id) {
        controller.abort();
      }
    }, RUNTIME_HEALTH_TIMEOUT_MS);
    activeRequest.current = { controller, id, timeoutId };
    setStatus("checking");

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

  useEffect(() => {
    void refresh();

    const handleOffline = () => {
      cancelActiveRequest();
      setStatus("offline");
    };
    const handleOnline = () => void refresh();
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      cancelActiveRequest();
    };
  }, [cancelActiveRequest, refresh]);

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
