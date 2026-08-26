export type EventStreamStatus =
  | "connecting"
  | "synchronized"
  | "reconnecting"
  | "offline";

export interface EventSourceLifecycle {
  /** Start listening to browser lifecycle events and open the first source. */
  start(): void;
  /** Close the current source without permanently stopping the lifecycle. */
  close(): void;
  /** Stop all sources, timers, and browser listeners. */
  stop(): void;
}

export interface EventSourceLifecycleOptions {
  url: () => string;
  eventTypes: readonly string[];
  onStatus: (status: EventStreamStatus) => void;
  /** Return false while a caller-owned terminal/reconciliation phase is active. */
  canConnect?: () => boolean;
  onOpen?: () => void;
  onReconnect?: () => void;
  onEvent?: (type: string, event: MessageEvent, lifecycle: EventSourceLifecycle) => void;
  onOffline?: () => void;
  /** Return false when an already-finished stream should ignore reconnects. */
  shouldHandleOnline?: () => boolean;
  onOnline?: () => void;
  onVisible?: () => void;
}

/**
 * Shared EventSource lifecycle for the mission and chat streams.
 *
 * Cursor validation, query reconciliation, and terminal completion stay with
 * each stream because those are different contracts. This boundary only owns
 * the identical browser mechanics: one source at a time, capped backoff,
 * online/offline transitions, visibility notifications, and cleanup.
 */
export function createEventSourceLifecycle(
  options: EventSourceLifecycleOptions,
): EventSourceLifecycle {
  let started = false;
  let stopped = false;
  let source: EventSource | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;

  const canConnect = () => options.canConnect?.() ?? true;

  const publishStatus = (status: EventStreamStatus) => {
    if (!stopped) options.onStatus(status);
  };

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

  let lifecycle: EventSourceLifecycle;

  const connect = () => {
    if (stopped || !started || source || reconnectTimer !== null || !canConnect()) return;
    if (!navigator.onLine) {
      publishStatus("offline");
      return;
    }

    const activeSource = new EventSource(options.url());
    source = activeSource;

    activeSource.addEventListener("open", () => {
      if (stopped || source !== activeSource || !canConnect()) return;
      reconnectAttempt = 0;
      publishStatus("synchronized");
      options.onOpen?.();
    });
    activeSource.addEventListener("error", () => {
      if (stopped || source !== activeSource || !canConnect()) return;
      scheduleReconnect();
    });

    for (const eventType of options.eventTypes) {
      activeSource.addEventListener(eventType, (event) => {
        if (stopped || source !== activeSource || !canConnect()) return;
        options.onEvent?.(eventType, event as MessageEvent, lifecycle);
      });
    }
  };

  const scheduleReconnect = () => {
    closeSource();
    if (stopped || !canConnect()) return;
    options.onReconnect?.();
    if (!navigator.onLine) {
      clearReconnectTimer();
      publishStatus("offline");
      return;
    }

    publishStatus("reconnecting");
    if (reconnectTimer !== null) return;
    const delay = Math.min(1_000 * 2 ** reconnectAttempt, 15_000);
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const handleOffline = () => {
    clearReconnectTimer();
    closeSource();
    publishStatus("offline");
    options.onOffline?.();
  };

  const handleOnline = () => {
    if (
      stopped ||
      source ||
      reconnectTimer !== null ||
      options.shouldHandleOnline?.() === false
    ) return;
    publishStatus("reconnecting");
    options.onOnline?.();
    if (canConnect()) connect();
  };

  const handleVisibility = () => {
    if (!stopped && document.visibilityState === "visible") options.onVisible?.();
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
    close: closeSource,
    stop() {
      if (stopped) return;
      stopped = true;
      clearReconnectTimer();
      closeSource();
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
    },
  };

  return lifecycle;
}
