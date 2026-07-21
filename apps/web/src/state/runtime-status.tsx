import { z } from "zod";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "../api/client.js";

const RuntimeHealthSchema = z
  .object({
    ok: z.literal(true),
    service: z.string().min(1),
  })
  .passthrough();

export type RuntimeConnectionStatus = "checking" | "online" | "offline";

interface RuntimeStatusContextValue {
  refresh: () => Promise<void>;
  status: RuntimeConnectionStatus;
}

const RuntimeStatusContext = createContext<RuntimeStatusContextValue | null>(
  null,
);

export function RuntimeStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<RuntimeConnectionStatus>("checking");

  const refresh = useCallback(async () => {
    setStatus("checking");
    try {
      await api.get("/api/health", RuntimeHealthSchema);
      setStatus("online");
    } catch {
      setStatus("offline");
    }
  }, []);

  useEffect(() => {
    void refresh();

    const handleOffline = () => setStatus("offline");
    const handleOnline = () => void refresh();
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [refresh]);

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
