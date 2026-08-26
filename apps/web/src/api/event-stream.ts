export type EventStreamStatus =
  | "connecting"
  | "synchronized"
  | "reconnecting"
  | "offline";

export interface EventSourceLifecycle {
  start(): void;
  pause(): void;
  stop(): void;
}

export type EventSourceLifecycleEvent =
  | { type: "open" }
  | { type: "reconnect" }
  | { type: "offline" }
  | { type: "online" }
  | { type: "visible" }
  | { type: "event"; eventType: string; event: MessageEvent; lifecycle: EventSourceLifecycle };

export interface EventSourceLifecycleOptions {
  url: () => string;
  eventTypes: readonly string[];
  onStatus: (status: EventStreamStatus) => void;
  onLifecycle: (event: EventSourceLifecycleEvent) => void;
}

/** Shared browser mechanics; cursor validation and query reconciliation stay with each stream. */
export function createEventSourceLifecycle(
  options: EventSourceLifecycleOptions,
): EventSourceLifecycle {
  let started = false;
  let paused = false;
  let stopped = false;
  let source: EventSource | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;

  const publishStatus = (status: EventStreamStatus) => { if (!stopped) options.onStatus(status); };
  const publishLifecycle = (event: EventSourceLifecycleEvent) => { if (!stopped) options.onLifecycle(event); };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const closeSource = () => { const current = source; source = null; current?.close(); };
  const publishOffline = () => {
    clearReconnectTimer();
    publishStatus("offline");
    publishLifecycle({ type: "offline" });
  };

  let lifecycle: EventSourceLifecycle;

  const connect = () => {
    if (stopped || paused || !started || source || reconnectTimer !== null) return;
    if (!navigator.onLine) return publishStatus("offline");

    const activeSource = new EventSource(options.url());
    source = activeSource;

    activeSource.addEventListener("open", () => {
      if (stopped || paused || source !== activeSource) return;
      reconnectAttempt = 0;
      publishStatus("synchronized");
      publishLifecycle({ type: "open" });
    });
    activeSource.addEventListener("error", () => {
      if (stopped || paused || source !== activeSource) return;
      scheduleReconnect();
    });

    for (const eventType of options.eventTypes) {
      activeSource.addEventListener(eventType, (event) => {
        if (stopped || paused || source !== activeSource) return;
        publishLifecycle({ type: "event", eventType, event: event as MessageEvent, lifecycle });
      });
    }
  };

  const scheduleReconnect = () => {
    closeSource();
    if (stopped || paused) return;
    if (!navigator.onLine) return publishOffline();

    publishStatus("reconnecting");
    publishLifecycle({ type: "reconnect" });
    if (reconnectTimer !== null) return;
    const delay = Math.min(1_000 * 2 ** reconnectAttempt, 15_000);
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const handleOffline = () => {
    closeSource();
    publishOffline();
  };

  const handleOnline = () => {
    if (stopped || source || reconnectTimer !== null) return;
    publishStatus("reconnecting");
    publishLifecycle({ type: "online" });
    connect();
  };

  const handleVisibility = () => {
    if (!stopped && document.visibilityState === "visible") publishLifecycle({ type: "visible" });
  };

  lifecycle = {
    start() {
      if (started || stopped) return;
      started = true;
      window.addEventListener("offline", handleOffline);
      window.addEventListener("online", handleOnline);
      document.addEventListener("visibilitychange", handleVisibility);
      publishStatus(navigator.onLine ? "connecting" : "offline");
      if (navigator.onLine) connect();
    },
    pause() {
      paused = true;
      clearReconnectTimer();
      closeSource();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      paused = true;
      clearReconnectTimer();
      closeSource();
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
    },
  };

  return lifecycle;
}
